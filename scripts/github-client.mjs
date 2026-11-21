// GitHub クライアントの土台（brw-enforcement 3.1）。
// 対象のホスト・リポジトリ ID を GitHub の応答で照合し、設定用の認証を導入処理の間だけ固定する。
// 認証の失敗・権限不足・不明な入力・通信エラーを区別し、資格情報（トークン）は結果にもエラーにも出さない。
// PR・Ruleset の個別操作は 3.2・3.3 が、この土台の `request` の上に実装する。
// 外部依存なし（Node 標準ライブラリのみ）。
import { spawn } from "node:child_process";

/** 結果の種類。ok 以外は理由の区別に使う。 */
export const FAILURE_KINDS = ["auth", "permission", "unknown-input", "network", "server", "target-mismatch", "refused"];

const NAME = /^[A-Za-z0-9_.-]+$/;
const HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/;
const okPart = (p) => typeof p === "string" && NAME.test(p) && p !== "." && p !== "..";
const normHost = (h) => {
  const x = String(h ?? "").trim().toLowerCase();
  return x === "api.github.com" || x === "www.github.com" ? "github.com" : x;
};
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/** 書き込みを許す経路。マージ・自動マージ・ref 更新など、これ以外の書き込みはクライアントが拒否する。 */
const WRITE_ROUTES = [
  { method: "POST", re: /^\/repos\/[^/?]+\/[^/?]+\/pulls$/ },
  { method: "POST", re: /^\/repos\/[^/?]+\/[^/?]+\/rulesets$/ },
];
const READ_METHODS = ["GET", "HEAD"];
// 認証確認だけは対象リポジトリに紐づかない読み取りを許す
const TARGETLESS_READS = ["/user"];

const refuse = (kind, reason, called) => ({ ok: false, kind, reason, ...(called ? { calledTo: called } : {}) });

/** パスの形を検査する。通らなければ理由の文字列、通れば null。 */
const badPath = (path) => {
  if (typeof path !== "string" || !path.startsWith("/")) return "パスが / で始まっていない";
  if (/[\u0000-\u001f\u007f\s\\#]/.test(path)) return "パスに使えない文字が含まれる";
  if (path.includes("://") || path.startsWith("//")) return "パスに URL が含まれる";
  const [p] = path.split("?");
  if (p.split("/").some((s) => s === ".." || s === ".")) return "パスに相対指定が含まれる";
  if (p.includes("//")) return "パスに空の区間が含まれる";
  return null;
};

/** target の形（host・owner・name）を検査する。 */
const badTarget = (t) => {
  if (!t || typeof t !== "object") return "対象が指定されていない";
  if (!HOST.test(normHost(t.host))) return "対象のホストが不正";
  if (!okPart(t.owner) || !okPart(t.name)) return "対象の所有者またはリポジトリ名が不正";
  if (t.repositoryId !== undefined && t.repositoryId !== null && !(Number.isInteger(t.repositoryId) && t.repositoryId > 0)) return "対象のリポジトリ ID が不正";
  return null;
};

/** 失敗文言から資格情報を取り除く。 */
const redactWith = (token) => (text) => {
  let s = String(text ?? "");
  if (token) s = s.split(token).join("***");
  // 形式から分かるトークンも念のため伏せる
  return s.replace(/\b(gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,})\b/g, "***");
};

/** HTTP の状態を結果の種類へ分ける。 */
const classify = (status) => {
  if (status >= 200 && status < 300) return null;
  if (status === 401) return "auth";
  if (status === 403) return "permission";
  if (status >= 500) return "server";
  return "unknown-input"; // 400・404・409・422 など。入力・対象・状態が GitHub に受け付けられなかった
};

/**
 * gh の子プロセスに渡す環境を作る。ホストと資格情報を明示し、手元の環境変数による差し替えを防ぐ。
 * 資格情報は引数ではなく環境変数で渡す（プロセス一覧に出さない）。
 */
export const ghEnv = (host, token, base = process.env) => {
  const env = { ...base };
  for (const k of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_REPO", "GH_HOST"]) delete env[k];
  env.GH_HOST = host;
  env.GH_PROMPT_DISABLED = "1";
  if (token) env[host === "github.com" ? "GH_TOKEN" : "GH_ENTERPRISE_TOKEN"] = token;
  return env;
};

/** `gh api --include` の出力から状態と本文を取り出す。 */
export const parseGhInclude = (text) => {
  const m = /^HTTP\/[\d.]+\s+(\d{3})/.exec(text);
  if (!m) return null;
  const split = text.search(/\r?\n\r?\n/);
  const raw = split < 0 ? "" : text.slice(split).trim();
  let body = raw;
  if (raw) { try { body = JSON.parse(raw); } catch { body = raw; } }
  return { status: Number(m[1]), body: raw ? body : undefined };
};

/** 既定の通信層。`gh api` を呼ぶ。テストでは偽の層を渡す。 */
export const ghTransport = ({ ghPath = "gh", timeoutMs = 30000, baseEnv } = {}) => ({ method, path, body, host, credential }) => new Promise((resolve, reject) => {
  const args = ["api", "--include", "--method", method, "--hostname", host, "-H", "Accept: application/vnd.github+json", path];
  if (body !== undefined) args.push("--input", "-");
  const child = spawn(ghPath, args, { env: ghEnv(host, credential, baseEnv), stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  let err = "";
  let done = false;
  const finish = (fn, v) => { if (!done) { done = true; clearTimeout(timer); fn(v); } };
  const timer = setTimeout(() => { child.kill("SIGKILL"); finish(reject, Object.assign(new Error("gh の応答が時間内に届かない"), { code: "ETIMEDOUT" })); }, timeoutMs);
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });
  child.on("error", (e) => finish(reject, Object.assign(new Error(`gh を実行できない: ${e.code ?? e.message}`), { code: e.code ?? "ESPAWN" })));
  child.on("close", () => {
    const parsed = parseGhInclude(out);
    if (parsed) finish(resolve, parsed);
    else finish(reject, Object.assign(new Error(`gh の応答を解釈できない: ${err.trim().split("\n")[0] ?? ""}`), { code: "EGHPARSE" }));
  });
  child.stdin.on("error", () => {});
  child.stdin.end(body !== undefined ? JSON.stringify(body) : undefined);
});

/**
 * 導入処理ごとに 1 つ作る。ホストと資格情報はここで固定し、以後は変えられない。
 * @param {{host: string, token?: string, transport?: (req: {method: string, path: string, body?: any, host: string, credential?: string}) => Promise<{status: number, body?: any}>}} opt
 *   token を省くと `gh` の保存済みログイン（そのホスト用）を使う。手元の GH_TOKEN 等の環境変数は常に無視する。
 * @returns {{host: string, request: Function, confirmTarget: Function, checkAuth: Function}}
 */
export const createGitHubSession = ({ host, token, transport = ghTransport() } = {}) => {
  const pinnedHost = normHost(host);
  if (!HOST.test(pinnedHost)) throw new Error(`GitHub のホストが不正です: ${redactWith(token)(host)}`);
  const redact = redactWith(token);
  /** 照合済みの対象。key は host/owner/name（小文字）、値はリポジトリ ID */
  const confirmed = new Map();
  const keyOf = (t) => `${normHost(t.host)}/${t.owner.toLowerCase()}/${t.name.toLowerCase()}`;

  const send = async (method, path, body, called) => {
    let res;
    try {
      res = await transport({ method, path, body, host: pinnedHost, credential: token });
    } catch (e) {
      const write = !READ_METHODS.includes(method);
      return { ok: false, kind: "network", reason: redact(e?.message ?? "通信に失敗した"), code: e?.code, calledTo: called, outcomeUnknown: write };
    }
    if (!res || !Number.isInteger(res.status)) return { ok: false, kind: "server", reason: "応答の形式が不正", calledTo: called, outcomeUnknown: !READ_METHODS.includes(method) };
    const kind = classify(res.status);
    if (kind) return { ok: false, kind, status: res.status, reason: redact(res.body?.message ?? `HTTP ${res.status}`), calledTo: called };
    return { ok: true, status: res.status, body: res.body, calledTo: called };
  };

  const session = {
    host: pinnedHost,

    /** 認証が通るかを読み取りだけで確認する（トークンの値は返さない）。 */
    async checkAuth() {
      const r = await send("GET", "/user", undefined, { host: pinnedHost, method: "GET", path: "/user" });
      return r.ok ? { ok: true, status: r.status, login: typeof r.body?.login === "string" ? r.body.login : null, calledTo: r.calledTo } : r;
    },

    /**
     * 対象リポジトリのホスト・所有者・名前を GitHub の応答で照合し、リポジトリ ID を確定する。
     * 別のホスト・食い違う名前・ID の変化は target-mismatch として返し、書き込みには進ませない。
     */
    async confirmTarget(target) {
      const bad = badTarget(target);
      if (bad) return refuse("refused", bad);
      if (normHost(target.host) !== pinnedHost) return refuse("target-mismatch", `対象のホスト ${normHost(target.host)} が固定済みのホスト ${pinnedHost} と異なる`);
      const path = `/repos/${target.owner}/${target.name}`;
      const r = await send("GET", path, undefined, { host: pinnedHost, method: "GET", path });
      if (!r.ok) return r;
      const b = r.body;
      if (!b || !Number.isInteger(b.id) || b.id <= 0 || typeof b.full_name !== "string") return { ...refuse("unknown-input", "リポジトリ情報の応答にリポジトリ ID または名前がない", r.calledTo) };
      if (!same(b.full_name, `${target.owner}/${target.name}`)) return refuse("target-mismatch", `応答のリポジトリ ${b.full_name} が要求した ${target.owner}/${target.name} と異なる`, r.calledTo);
      if (target.repositoryId && target.repositoryId !== b.id) return refuse("target-mismatch", `応答のリポジトリ ID ${b.id} が保存済みの ID ${target.repositoryId} と異なる`, r.calledTo);
      const prev = confirmed.get(keyOf(target));
      if (prev !== undefined && prev !== b.id) return refuse("target-mismatch", "同じ導入処理の中でリポジトリ ID が変わった", r.calledTo);
      confirmed.set(keyOf(target), b.id);
      return { ok: true, status: r.status, target: { host: pinnedHost, owner: target.owner, name: target.name, repositoryId: b.id }, body: b, calledTo: r.calledTo };
    },

    /**
     * 対象リポジトリの配下だけに要求を送る。読み取りは対象の形と一致すれば送る。
     * 書き込みは、照合済み（confirmTarget 済み）で ID が一致する対象への許可済みの経路に限る。
     * 送る前に拒否した場合は通信しない（calledTo を持たない）。
     */
    async request(target, method, path, body) {
      const m = String(method ?? "").toUpperCase();
      const badP = badPath(path);
      if (badP) return refuse("refused", badP);
      const [pathOnly] = path.split("?");
      const write = !READ_METHODS.includes(m);
      if (target === null || target === undefined) {
        if (m === "GET" && TARGETLESS_READS.includes(pathOnly)) return send(m, path, undefined, { host: pinnedHost, method: m, path });
        return refuse("refused", "対象を指定しない要求は認証確認だけに限る");
      }
      const bad = badTarget(target);
      if (bad) return refuse("refused", bad);
      if (normHost(target.host) !== pinnedHost) return refuse("target-mismatch", `対象のホスト ${normHost(target.host)} が固定済みのホスト ${pinnedHost} と異なる`);
      const prefix = `/repos/${target.owner}/${target.name}`;
      const inScope = pathOnly.length >= prefix.length && same(pathOnly.slice(0, prefix.length), prefix) && (pathOnly.length === prefix.length || pathOnly[prefix.length] === "/");
      if (!inScope) return refuse("target-mismatch", "パスが対象リポジトリの配下ではない");
      if (!READ_METHODS.includes(m) && !write) return refuse("refused", "未対応のメソッド");
      if (write) {
        if (!WRITE_ROUTES.some((r) => r.method === m && r.re.test(pathOnly))) return refuse("refused", "この書き込み経路は公開していない");
        const id = confirmed.get(keyOf(target));
        if (id === undefined) return refuse("refused", "対象のリポジトリ ID を照合する前は書き込めない");
        if (target.repositoryId && target.repositoryId !== id) return refuse("target-mismatch", "対象のリポジトリ ID が照合済みの ID と異なる");
        if (body === undefined || body === null || typeof body !== "object" || Array.isArray(body)) return refuse("refused", "書き込みの本文は JSON オブジェクトに限る");
      } else if (body !== undefined) {
        return refuse("refused", "読み取りに本文は付けられない");
      }
      return send(m, path, write ? body : undefined, { host: pinnedHost, method: m, path });
    },
  };
  return Object.freeze(session);
};
