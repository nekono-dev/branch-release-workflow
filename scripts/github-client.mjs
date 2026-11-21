// GitHub クライアントの土台（brw-enforcement 3.1）。
// 対象のホスト・リポジトリ ID を GitHub の応答で照合し、設定用の認証を導入処理の間だけ固定する。
// 認証の失敗・権限不足・不明な入力・通信エラーを区別し、資格情報（トークン）は結果にもエラーにも出さない。
// PR の検索・取得・作成（3.2）はこの土台の `request` の上に実装する。Ruleset の照会（3.3）は別タスクで足す。
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
  // %2e%2e や %2f は gh や GitHub 側で別の経路に解釈されうるため、パス部分では受け付けない
  if (p.includes("%")) return "パスに % エンコードが含まれる";
  // gh api は {owner} などを手元の情報で置き換えるため、置換記号を含む指定は送らない
  if (/[{}]/.test(path)) return "パスに置換記号 {} が含まれる";
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

const REF = /^[A-Za-z0-9._/-]+$/;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
/** ブランチ名として安全な形か。クエリや本文にそのまま入れても意味が変わらない文字だけを許す。 */
const okRef = (r) => typeof r === "string" && r.length <= 200 && REF.test(r) && !r.startsWith("/") && !r.startsWith("-") && !r.endsWith("/") && !r.endsWith(".lock") && !r.includes("//") && !r.includes("..");
const okNumber = (n) => Number.isSafeInteger(n) && n > 0;

/** 期待する PR の指定（head・base の ref と head の OID、必要なら head のリポジトリ）を検査する。 */
const badExpect = (e, requireOid = true) => {
  if (!e || typeof e !== "object") return "期待する PR の指定がない";
  if (!okRef(e.headRef)) return "head の ref が不正";
  if (!okRef(e.baseRef)) return "base の ref が不正";
  if (requireOid && !(typeof e.headOid === "string" && OID.test(e.headOid))) return "head の OID が不正";
  const h = e.headRepository;
  if (h !== undefined && h !== null) {
    if (typeof h !== "object" || !okPart(h.owner) || !okPart(h.name)) return "head のリポジトリが不正";
    if (h.repositoryId !== undefined && h.repositoryId !== null && !(Number.isInteger(h.repositoryId) && h.repositoryId > 0)) return "head のリポジトリ ID が不正";
  }
  return null;
};

/**
 * 応答の PR が期待と一致するかを検証する。差異の項目名を返す（空なら一致）。
 * base は確定済みの対象（ID と名前）、head は指定のリポジトリ（省略時は対象と同じ）と ref・OID、URL は固定したホストの PR ページ。
 */
const pullDifferences = (pr, exp, ctx, number) => {
  const d = [];
  if (!pr || typeof pr !== "object" || Array.isArray(pr)) return ["PR の応答が形式不正"];
  if (!okNumber(pr.number)) d.push("PR 番号がない");
  else if (number !== undefined && pr.number !== number) d.push("PR 番号が要求と異なる");
  if (pr.state !== "open") d.push("PR がオープンではない");
  const url = okNumber(pr.number) ? `https://${ctx.host}/${ctx.owner}/${ctx.name}/pull/${pr.number}` : null;
  if (!url || typeof pr.html_url !== "string" || pr.html_url.toLowerCase() !== url.toLowerCase()) d.push("PR の URL が対象リポジトリの PR ページと異なる");
  if (pr.base?.ref !== exp.baseRef) d.push("base の ref が異なる");
  if (!(pr.base?.repo && pr.base.repo.id === ctx.id && same(pr.base.repo.full_name ?? "", `${ctx.owner}/${ctx.name}`))) d.push("base のリポジトリが対象と異なる");
  if (pr.head?.ref !== exp.headRef) d.push("head の ref が異なる");
  const hr = ctx.headRepo;
  const prHead = pr.head?.repo;
  if (!(prHead && same(prHead.full_name ?? "", `${hr.owner}/${hr.name}`) && (hr.repositoryId === undefined || prHead.id === hr.repositoryId))) d.push("head のリポジトリが異なる");
  if (!(typeof pr.head?.sha === "string" && pr.head.sha.toLowerCase() === exp.headOid.toLowerCase())) d.push("head の OID が異なる");
  return d;
};

const summarize = (pr) => ({ number: pr.number, url: pr.html_url, state: pr.state, headOid: pr.head.sha, headRef: pr.head.ref, baseRef: pr.base.ref });

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
  if (status >= 500 || status === 429 || status === 408) return "server"; // 入力の問題ではなく、時間をおけば変わりうる
  if (status >= 300 && status < 400) return "target-mismatch"; // 移転・改名などで対象が別の場所を指している可能性
  return "unknown-input"; // 400・404・409・422 など。入力・対象・状態が GitHub に受け付けられなかった
};

/** 書き込みの応答が不確かで、GitHub 側では適用済みかもしれない状態か。 */
const writeMayHaveApplied = (status) => status >= 500 || status === 408;

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
    if (kind) return { ok: false, kind, status: res.status, reason: redact(res.body?.message ?? `HTTP ${res.status}`), calledTo: called, ...(!READ_METHODS.includes(method) && writeMayHaveApplied(res.status) ? { outcomeUnknown: true } : {}) };
    return { ok: true, status: res.status, body: res.body, calledTo: called };
  };

  let request;
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
    request: (...a) => request(...a),
  };
  request = async (target, method, path, body) => {
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
  };

  /** PR の操作に必要な、照合済みの対象と head のリポジトリを確定する。通信はしない。 */
  const prContext = (target, exp) => {
    const bad = badTarget(target) ?? badExpect(exp);
    if (bad) return { fail: refuse("refused", bad) };
    if (normHost(target.host) !== pinnedHost) return { fail: refuse("target-mismatch", `対象のホスト ${normHost(target.host)} が固定済みのホストと異なる`) };
    const id = confirmed.get(keyOf(target));
    if (id === undefined) return { fail: refuse("refused", "対象のリポジトリ ID を照合する前は PR を扱えない") };
    if (target.repositoryId && target.repositoryId !== id) return { fail: refuse("target-mismatch", "対象のリポジトリ ID が照合済みの ID と異なる") };
    const h = exp.headRepository;
    const sameRepo = !h || (same(h.owner, target.owner) && same(h.name, target.name));
    if (sameRepo && h && h.repositoryId !== undefined && h.repositoryId !== null && h.repositoryId !== id) return { fail: refuse("target-mismatch", "head のリポジトリ ID が対象と異なる") };
    const headRepo = sameRepo ? { owner: target.owner, name: target.name, repositoryId: id } : { owner: h.owner, name: h.name, repositoryId: h.repositoryId ?? undefined };
    return { ctx: { host: pinnedHost, owner: target.owner, name: target.name, id, headRepo }, sameRepo };
  };
  const mismatch = (reason, differences, extra = {}) => ({ ok: false, kind: "target-mismatch", reason, differences, ...extra });

  /**
   * 同じ head・base（リポジトリと ref）のオープン PR を探す。見つかった PR は OID と URL まで検証する。
   * 成功: `{ok:true, pull}`（pull は一致する 1 件、なければ null）。
   * 一致しない PR が混ざる・一致が複数ある場合は成功扱いにせず target-mismatch を返す。
   */
  session.findOpenPull = async (target, exp) => {
    const { ctx, fail } = prContext(target, exp);
    if (fail) return fail;
    const r = await request(target, "GET", `/repos/${target.owner}/${target.name}/pulls?state=open&head=${ctx.headRepo.owner}:${exp.headRef}&base=${exp.baseRef}&per_page=100`);
    if (!r.ok) return r;
    if (!Array.isArray(r.body)) return refuse("unknown-input", "PR 一覧の応答が一覧ではない", r.calledTo);
    for (const pr of r.body) {
      const d = pullDifferences(pr, exp, ctx);
      if (d.length) return mismatch("検索で返った PR が期待と一致しない", d, { calledTo: r.calledTo, ...(okNumber(pr?.number) ? { pull: { number: pr.number } } : {}) });
    }
    if (r.body.length > 1) return mismatch("一致する PR が複数あり一意に確定できない", ["一致する PR が複数ある"], { ambiguous: true, calledTo: r.calledTo });
    return { ok: true, status: r.status, pull: r.body.length ? summarize(r.body[0]) : null, calledTo: r.calledTo };
  };

  /** 番号で PR を取得し、head・base・OID・URL を期待と照合する。 */
  session.getPull = async (target, number, exp) => {
    if (!okNumber(number)) return refuse("refused", "PR 番号が不正");
    const { ctx, fail } = prContext(target, exp);
    if (fail) return fail;
    const r = await request(target, "GET", `/repos/${target.owner}/${target.name}/pulls/${number}`);
    if (!r.ok) return r;
    const d = pullDifferences(r.body, exp, ctx, number);
    if (d.length) return mismatch("取得した PR が期待と一致しない", d, { calledTo: r.calledTo });
    return { ok: true, status: r.status, pull: summarize(r.body), calledTo: r.calledTo };
  };

  /**
   * 照合済みの対象に PR を作成し、応答を検証する。head は対象と同じリポジトリに限る。
   * 競合（409・422）や結果不明（応答喪失・5xx・408・読めない応答）は `reconcile: true` を付け、
   * 呼び出し側が findOpenPull で再取得して照合できるようにする。作成後の食い違いは作成済みの URL と差異を返す。
   */
  session.createPull = async (target, input) => {
    const { ctx, fail, sameRepo } = prContext(target, input);
    if (fail) return fail;
    if (!sameRepo) return refuse("refused", "head は対象と同じリポジトリに限る");
    if (typeof input.title !== "string" || input.title.trim() === "") return refuse("refused", "PR のタイトルが空");
    if (input.body !== undefined && typeof input.body !== "string") return refuse("refused", "PR の本文が文字列ではない");
    const payload = { title: input.title, ...(input.body !== undefined ? { body: input.body } : {}), head: input.headRef, base: input.baseRef };
    const r = await request(target, "POST", `/repos/${target.owner}/${target.name}/pulls`, payload);
    if (!r.ok) return { ...r, reconcile: r.outcomeUnknown === true || r.status === 409 || r.status === 422 };
    if (!okNumber(r.body?.number)) return { ok: false, kind: "server", reason: "作成の応答を読み取れない", status: r.status, outcomeUnknown: true, reconcile: true, calledTo: r.calledTo };
    const d = pullDifferences(r.body, input, ctx);
    if (!d.length) return { ok: true, status: r.status, created: true, pull: summarize(r.body), calledTo: r.calledTo };
    return mismatch("作成された PR が期待と一致しない", d, { created: true, createdUrl: typeof r.body.html_url === "string" ? r.body.html_url : undefined, createdNumber: r.body.number, reconcile: false, calledTo: r.calledTo });
  };
  return Object.freeze(session);
};
