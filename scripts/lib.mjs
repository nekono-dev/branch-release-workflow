// 共通処理: 宣言ファイルの読み込み・検証、ブランチ判定、workflow の走査。
// 外部依存なし（Node 標準ライブラリのみ）。
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const CONFIG_REL = ".branch-release-workflow.json";
export const LEGACY_CONFIG_REL = ".claude/branch-release-workflow.json";
// 新規導入はエージェント非依存のパス。既存の Claude 導入も引き続き利用できる。
export const configRel = (root) => existsSync(join(root, CONFIG_REL)) ? CONFIG_REL
  : existsSync(join(root, LEGACY_CONFIG_REL)) ? LEGACY_CONFIG_REL : CONFIG_REL;
export const SETTINGS_REL = ".claude/settings.json";
export const PLUGIN_NAME = "branch-release-workflow";

export function git(cwd, ...args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

export function repoRoot(cwd) {
  return git(cwd, "rev-parse", "--show-toplevel");
}

// リポジトリの .claude/settings.json がこのプラグインを有効にしているか。有効にしていれば導入済みのリポジトリとみなす
export function enabledInRepo(root) {
  const path = join(root, SETTINGS_REL);
  if (!existsSync(path)) return false;
  try {
    const plugins = JSON.parse(readFileSync(path, "utf8")).enabledPlugins ?? {};
    return Object.entries(plugins).some(([id, on]) => on && id.split("@")[0] === PLUGIN_NAME);
  } catch {
    return false;
  }
}

// 宣言ファイルが現在の commit に含まれているか。含まれていなければ、CI やほかの clone からは宣言が見えない
export const configCommitted = (root) => git(root, "cat-file", "-e", `HEAD:${configRel(root)}`) !== null;

// 宣言ファイルが現在の commit と同じ内容か（登録済みで、作業ツリーで書き換えていない）。
// 確認を省く判断は、登録された宣言だけに基づかせる（作業中に書き換えた宣言で自分に許可を与えないため）
export const configMatchesHead = (root) => configCommitted(root) && git(root, "diff", "--quiet", "HEAD", "--", configRel(root)) !== null;

// glob（* は "/" を除く任意文字列、** は "/" を含む任意文字列）を正規表現へ変換する
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export const matchesAny = (globs, branch) => globs.some((g) => globToRegExp(g).test(branch));

// 宣言ファイルを読み込む。無ければ { config: null }、不正なら { error } を返す
export function loadConfig(root) {
  const rel = configRel(root);
  const path = join(root, rel);
  const legacy = rel === LEGACY_CONFIG_REL;
  if (!existsSync(path)) return { config: null, path, legacy };
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return { error: `${rel} の JSON が不正です: ${e.message}`, path, legacy };
  }
  const errors = validateConfig(raw);
  if (errors.length) return { error: `${rel} が不正です:\n- ${errors.join("\n- ")}`, path, legacy };
  return { config: normalizeConfig(raw), path, legacy };
}

const PROVIDERS = ["none", "url-template", "cloudflare-previews"];

export function validateConfig(c) {
  const errs = [];
  const strArr = (k) => {
    if (!Array.isArray(c[k]) || c[k].some((s) => typeof s !== "string" || !s)) errs.push(`${k} は文字列の配列にしてください`);
  };
  if (typeof c !== "object" || c === null || Array.isArray(c)) return ["ルートはオブジェクトにしてください"];
  strArr("workBranches");
  strArr("protectedBranches");
  if (Array.isArray(c.workBranches) && c.workBranches.length === 0) errs.push("workBranches は1つ以上必要です");
  if (c.baseBranch !== undefined && typeof c.baseBranch !== "string") errs.push("baseBranch は文字列にしてください");
  // 恒常的な分岐元の固定名（パターンは書けない）
  if (c.baseBranches !== undefined && (!Array.isArray(c.baseBranches) || c.baseBranches.some((s) => typeof s !== "string" || !s || /[*?[\]]/.test(s))))
    errs.push("baseBranches は固定のブランチ名（パターン不可）の文字列の配列にしてください");
  if (c.namePattern !== undefined) {
    try {
      new RegExp(c.namePattern);
    } catch {
      errs.push("namePattern が正規表現として不正です");
    }
  }
  if (c.maxNameLength !== undefined && !Number.isInteger(c.maxNameLength)) errs.push("maxNameLength は整数にしてください");
  if (c.autoApprove !== undefined) {
    const a = c.autoApprove;
    if (typeof a !== "object" || a === null || Array.isArray(a)) errs.push("autoApprove はオブジェクトにしてください（push・pullRequest）");
    else for (const [k, v] of Object.entries(a)) {
      if (!["push", "pullRequest"].includes(k)) errs.push(`autoApprove.${k} は未知のキーです（push・pullRequest）`);
      else if (typeof v !== "boolean") errs.push(`autoApprove.${k} は true / false にしてください`);
    }
  }
  if (c.preview !== undefined) {
    const p = c.preview;
    const provider = p.provider ?? (p.urlTemplate ? "url-template" : "none");
    if (!PROVIDERS.includes(provider)) errs.push(`preview.provider は ${PROVIDERS.join(" / ")} のいずれかにしてください`);
    if (provider !== "none" && typeof p.urlTemplate !== "string") errs.push("preview.urlTemplate が必要です（{alias} を含める）");
    if (typeof p.urlTemplate === "string" && !p.urlTemplate.includes("{alias}")) errs.push("preview.urlTemplate には {alias} を含めてください");
    if (p.aliasStripPrefix !== undefined && typeof p.aliasStripPrefix !== "string") errs.push("preview.aliasStripPrefix は文字列にしてください");
    const targets = c.deploy?.targets && typeof c.deploy.targets === "object" ? Object.keys(c.deploy.targets) : null;
    if (p.target !== undefined && (typeof p.target !== "string" || !targets?.includes(p.target)))
      errs.push(`preview.target は deploy.targets の名前（${targets?.join(" / ") || "deploy が無い"}）にしてください`);
    if (p.target === undefined && targets && provider === "cloudflare-previews") errs.push("deploy.targets があるときは preview.target（プレビューを作る配備先）が必要です");
  }
  if (c.deploy !== undefined) errs.push(...validateDeploy(c.deploy));
  return errs;
}

// ---- 配備先（deploy） ------------------------------------------------------

export const DEFAULT_BRW_SOURCE = { repository: "https://github.com/nekono-dev/branch-release-workflow.git", ref: "main" };
const DEPLOY_PROVIDERS = ["cloudflare-workers"];

function validateDeploy(dp) {
  const errs = [];
  if (typeof dp !== "object" || dp === null || Array.isArray(dp)) return ["deploy はオブジェクトにしてください"];
  const str = (v) => typeof v === "string" && v.length > 0;
  if (!DEPLOY_PROVIDERS.includes(dp.provider)) errs.push(`deploy.provider は ${DEPLOY_PROVIDERS.join(" / ")} にしてください`);
  if (!str(dp.template)) errs.push("deploy.template（wrangler 設定のテンプレートのパス）が必要です");
  for (const k of ["output", "renderHook"]) if (dp[k] !== undefined && !str(dp[k])) errs.push(`deploy.${k} は空でない文字列にしてください`);
  if (dp.brwSource !== undefined) {
    const s = dp.brwSource;
    if (typeof s !== "object" || s === null) errs.push("deploy.brwSource はオブジェクトにしてください（repository・ref）");
    else {
      if (s.repository !== undefined && !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git$/.test(s.repository)) errs.push("deploy.brwSource.repository は https://github.com/<owner>/<repo>.git の形にしてください");
      if (s.ref !== undefined && !(str(s.ref) && (/^[0-9a-f]{40}$/.test(s.ref) || validBranchName(s.ref)))) errs.push("deploy.brwSource.ref はブランチ名か 40 桁のコミットにしてください");
    }
  }
  const t = dp.targets;
  if (typeof t !== "object" || t === null || Array.isArray(t) || !Object.keys(t).length) errs.push("deploy.targets に配備先を1つ以上書いてください");
  else
    for (const [name, v] of Object.entries(t)) {
      const at = `deploy.targets.${name}`;
      if (!/^[a-z][a-z0-9-]*$/.test(name)) errs.push(`${at}: 配備先の名前は英小文字・数字・ハイフンにしてください`);
      if (typeof v !== "object" || v === null) { errs.push(`${at} はオブジェクトにしてください`); continue; }
      if (!Array.isArray(v.branches) || !v.branches.length || v.branches.some((b) => !str(b))) errs.push(`${at}.branches は1つ以上の文字列の配列にしてください`);
      if (v.worker !== undefined && !str(v.worker)) errs.push(`${at}.worker は空でない文字列にしてください`);
      if (v.customDomain !== undefined && !(str(v.customDomain) && !/:\/\/|\//.test(v.customDomain))) errs.push(`${at}.customDomain はホスト名だけを書いてください（https:// や / を含めない）`);
    }
  return errs;
}

// git check-ref-format --branch 相当の簡易判定（git を呼ばずに検証するため）
const validBranchName = (b) => !/(^[-/.]|\.\.|[\s~^:?*[\\]|@\{|\/\/|[/.]$|\.lock$)/.test(b);

export function normalizeConfig(c) {
  const preview = c.preview
    ? { provider: c.preview.provider ?? (c.preview.urlTemplate ? "url-template" : "none"), ...c.preview }
    : { provider: "none" };
  const deploy = c.deploy
    ? { output: "wrangler.jsonc", ...c.deploy, brwSource: { ...DEFAULT_BRW_SOURCE, ...(c.deploy.brwSource ?? {}) } }
    : undefined;
  const n = { baseBranch: "develop", maxNameLength: 54, ...c, preview, ...(deploy ? { deploy } : {}) };
  // 恒常的な分岐元は baseBranch と固定名の baseBranches だけ（一時的な brwBase は含めない）
  return { ...n, permanentBases: [...new Set([n.baseBranch, ...(c.baseBranches ?? [])])] };
}

// 登録済みの宣言で、項目ごとの確認省略の既定値を決める。未指定は有効、明示的な false は維持する。
// 未登録・編集中の宣言（registered が偽）は確認を省略しない
export const autoApproveOf = (config, registered) => {
  const a = config.autoApprove ?? {};
  return { push: registered === true && a.push !== false, pullRequest: registered === true && a.pullRequest !== false };
};

// 作業ブランチの切り出し元。create が記録した brwBase を優先し、無ければ宣言の baseBranch（公開と片付けで共用）
export const branchBase = (cwd, config, branch) => git(cwd, "config", `branch.${branch}.brwBase`) || config.baseBranch;

// ---- JSONC --------------------------------------------------------------

// JSONC（コメント・末尾カンマ入りの JSON）を読む。文字列の中身は変えない
export function parseJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i < 0) throw new Error("コメントが閉じていません");
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

// ---- 変数（${NAME}）の解決 ---------------------------------------------------

const VAR_RE = /\$\{([A-Z_][A-Z0-9_]*)\}/g;
export const varNames = (s) => typeof s === "string" ? [...s.matchAll(VAR_RE)].map((m) => m[1]) : [];

// 宣言で変数を使える値（配備先の worker・customDomain、preview.urlTemplate）に出てくる変数名
export function configVarNames(config) {
  const vals = [config.preview?.urlTemplate];
  for (const t of Object.values(config.deploy?.targets ?? {})) vals.push(t.worker, t.customDomain);
  return [...new Set(vals.flatMap(varNames))];
}

// 変数の値を探す。環境変数（空は未設定とみなす）→ GitHub Variables（gh api）→ 無ければ null。
// gh の結果は 1 回の実行の中で覚えておく。BRW_NO_GH=1 なら gh を使わない（テスト用）
const ghCache = new Map();
export function lookupVar(name, cwd) {
  if (process.env[name]) return process.env[name];
  if (process.env.BRW_NO_GH === "1") return null;
  if (!ghCache.has(name)) {
    // gh variable get は新しい gh にしか無いため、古い gh でも使える REST API で読む（{owner}/{repo} は gh が cwd のリポジトリで置き換える）
    const r = spawnSync("gh", ["api", `repos/{owner}/{repo}/actions/variables/${name}`, "--jq", ".value"], { cwd, encoding: "utf8", timeout: 15000 });
    ghCache.set(name, r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null);
  }
  return ghCache.get(name);
}

// 文字列の ${NAME} を解決する。戻り値: { value（未解決の変数は残す）, missing: 未解決の変数名[] }
export function resolveVars(s, cwd) {
  const missing = [];
  const value = s.replace(VAR_RE, (all, name) => {
    const v = lookupVar(name, cwd);
    if (v === null) missing.push(name);
    return v ?? all;
  });
  return { value, missing: [...new Set(missing)] };
}

// ---- プレビューの配信方式 ----------------------------------------------------

// URL 雛形のホスト名（:// の後から最初の / まで）
export const urlHost = (tpl) => (tpl.split("://")[1] ?? tpl).split("/")[0];
// URL 雛形のホスト名が .workers.dev で終われば workers.dev 配信、それ以外は独自ドメイン配信（変数は解決せずに判定する）
export const deliveryOf = (tpl) => (typeof tpl === "string" && urlHost(tpl).endsWith(".workers.dev") ? "workers-dev" : "custom-domain");

// 'refs/heads/' を除いた短いブランチ名にする
export const shortRef = (r) => r.replace(/^refs\/heads\//, "").replace(/^\+/, "");

export function currentBranch(cwd) {
  const b = git(cwd, "branch", "--show-current");
  return b || null; // detached HEAD は null
}

// ブランチの判定。戻り値: { decision: "allow"|"deny"|"ask", reason }
export function judgeBranch(config, branch) {
  if (!branch) return { decision: "ask", reason: "ブランチを特定できません（detached HEAD など）。" };
  if (matchesAny(config.protectedBranches ?? [], branch))
    return { decision: "deny", reason: `'${branch}' は保護ブランチです。作業ブランチ（${config.workBranches.join(", ")}）で作業してください。` };
  if (matchesAny(config.workBranches, branch)) return { decision: "allow", reason: `'${branch}' は作業ブランチです。` };
  return { decision: "deny", reason: `'${branch}' は宣言（workBranches: ${config.workBranches.join(", ")}）に無いブランチです。作業ブランチへ切り替えてください。` };
}

// ブランチの分類。戻り値: "protected" | "base" | "development" | "undeclared"
// 保護対象を最優先し、次に恒常的な分岐元。開発ブランチは workBranches に一致し命名規則を満たすものだけ
export function classifyBranch(config, branch) {
  if (!branch) return "undeclared";
  if (matchesAny(config.protectedBranches ?? [], branch)) return "protected";
  if ((config.permanentBases ?? [config.baseBranch]).includes(branch)) return "base";
  if (matchesAny(config.workBranches, branch) && !checkName(config, branch)) return "development";
  return "undeclared";
}

// ブランチ名 → alias（DNS ラベルになるため "/" を "-" に置き換える）
export const aliasOf = (branch) => branch.replace(/\//g, "-");

// ブランチ名 → プレビュー名。宣言の preview.aliasStripPrefix（例: "dev/"）があれば、その接頭辞を除いてから alias にする
export const previewAliasOf = (config, branch) => {
  const prefix = config.preview?.aliasStripPrefix ?? "";
  return aliasOf(prefix && branch.startsWith(prefix) ? branch.slice(prefix.length) : branch);
};

// worktree の一覧（git worktree list --porcelain）。先頭が本体の作業ツリー。戻り値: { path, branch|null }[]
export function worktrees(cwd) {
  const out = [];
  for (const block of (git(cwd, "worktree", "list", "--porcelain") ?? "").split(/\n\n+/)) {
    const path = block.match(/^worktree (.+)$/m)?.[1];
    if (path) out.push({ path, branch: block.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? null });
  }
  return out;
}

// 作業ブランチ名（dev/XXXX の XXXX 部分）が命名規則に合うか
export function checkName(config, branch) {
  if (config.namePattern && !new RegExp(config.namePattern).test(branch)) return `'${branch}' は namePattern（${config.namePattern}）に合いません。`;
  if (branch.length > config.maxNameLength) return `'${branch}' は ${config.maxNameLength} 文字を超えています（${branch.length}文字）。`;
  return null;
}

// ---- workflow 走査 -------------------------------------------------------

// on.push.branches を簡易的に取り出す（flow / block 形式に対応。YAML 完全対応ではない）
export function parsePushBranches(text) {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+#.*$/, "").replace(/^#.*$/, ""));
  const indentOf = (l) => l.match(/^ */)[0].length;
  const unq = (s) => s.trim().replace(/^["']|["']$/g, "");
  const flow = (s) => s.replace(/^\[|\]$/g, "").split(",").map(unq).filter(Boolean);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^(on|"on"|'on'):\s*(.*)$/.test(lines[i])) continue;
    const inline = lines[i].replace(/^[^:]+:\s*/, "").trim();
    if (inline.startsWith("[") || /^\w+$/.test(inline)) {
      if (inline === "push" || inline.replace(/[\[\]\s]/g, "").split(",").includes("push")) out.push({ any: true });
      return out;
    }
    // on: 配下の push: を探す
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === "") continue;
      if (indentOf(lines[j]) === 0) break;
      const m = lines[j].match(/^(\s+)push:\s*(.*)$/);
      if (!m) continue;
      const pushIndent = m[1].length;
      let hasTags = false;
      for (let k = j + 1; k < lines.length && (lines[k].trim() === "" || indentOf(lines[k]) > pushIndent); k++)
        if (/^\s+tags(-ignore)?:/.test(lines[k])) hasTags = true;
      for (let k = j + 1; k < lines.length; k++) {
        if (lines[k].trim() === "") continue;
        if (indentOf(lines[k]) <= pushIndent) break;
        const bm = lines[k].match(/^\s+branches:\s*(.*)$/);
        if (!bm) continue;
        const bIndent = indentOf(lines[k]);
        out.length = 0;
        if (bm[1].trim().startsWith("[")) out.push(...flow(bm[1]).map((b) => ({ glob: b })));
        else
          for (let n = k + 1; n < lines.length; n++) {
            if (lines[n].trim() === "") continue;
            const lm = lines[n].match(/^(\s+)-\s*(.+)$/);
            if (!lm || lm[1].length < bIndent) break;
            out.push({ glob: unq(lm[2]) });
          }
        return out;
      }
      if (hasTags) return out; // tags のみの指定はブランチ push ではない
      out.push({ any: true });
      return out; // branches 指定なし = 全ブランチ
    }
    return out;
  }
  return out;
}

export function scanWorkflows(root) {
  const dir = join(root, ".github/workflows");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => {
      const text = readFileSync(join(dir, f), "utf8");
      return { file: `.github/workflows/${f}`, text, push: parsePushBranches(text) };
    });
}

// 宣言の workBranches / protectedBranches に含まれないのに push で CI が走るブランチ指定を返す
export function undeclaredCiBranches(config, workflows) {
  const declared = [...config.workBranches, ...(config.protectedBranches ?? [])];
  const findings = [];
  for (const w of workflows)
    for (const p of w.push) {
      if (p.any) findings.push({ file: w.file, glob: "(全ブランチ)" });
      else if (!declared.includes(p.glob) && !declared.some((d) => globToRegExp(p.glob).test(d.replace(/\*+/g, "x"))))
        findings.push({ file: w.file, glob: p.glob });
    }
  return findings;
}
