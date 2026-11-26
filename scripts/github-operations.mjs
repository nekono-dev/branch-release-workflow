// GitHub への書き込み経路の識別（タスク 2.2）: `gh` コマンドと MCP ツールの入力から、
// 対象のホスト・リポジトリと操作（PR 作成・マージ・自動マージ予約・その他の書き込み）を取り出す。
// 可否の判断（許可・拒否）はここでは行わない（2.3）。フックとの接続も行わない（6.x）。
// 外部依存なし（Node 標準ライブラリのみ）。operation-policy.mjs から呼ばれる。
//
// 各関数は操作の配列 [{ kind, unresolved, fields }] を返す。operation-policy.mjs が makeOp で共通の形にする。
//   kind: pr-create | github-merge | auto-merge | unsupported-write | create | query | unparseable
//     pr-create          PR の作成。head / base を持つ
//     github-merge       GitHub 側でのマージ（`gh pr merge`・マージ API・マージ変異）。ローカルの merge とは別
//     auto-merge         自動マージの予約
//     unsupported-write  GitHub を変更する既知の操作のうち、BRW が対応しない書き込み（area に分野を示す）。
//                        refWrite が真のものは、ブランチやタグの先を直接動かしうる
//     unparseable        変更かどうかも確定できない（未知のサブコマンド・ツールなど）
//   unresolved: 対象（ホスト・リポジトリ・head・base など）を確定できなかった理由。空なら確定済み
import { canonicalSshHost } from "./remote-url.mjs";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { git } from "./lib.mjs";

export const GH_TARGET_ENV = /^(GH_REPO|GH_HOST)=/;
export const isGh = (v) => v === "gh" || v.endsWith("/gh");

const last = (a) => (a && a.length ? a[a.length - 1] : undefined);
const normHost = (h) => {
  const x = String(h).toLowerCase();
  return x === "api.github.com" || x === "www.github.com" ? "github.com" : x;
};
const NAME = /^[A-Za-z0-9_.-]+$/;
const okPart = (p) => NAME.test(p) && p !== "." && p !== "..";
const stripGit = (s) => s.replace(/\.git$/, "");
const sameRepo = (a, b) => a && b && a.host === b.host && a.owner.toLowerCase() === b.owner.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase();

// ---- リポジトリの指定 ---------------------------------------------------------

/**
 * リポジトリの指定を解釈する。URL・scp 形式・`OWNER/REPO`・`HOST/OWNER/REPO`（bare が真のときだけ後二者）。
 * 戻り値: { host, owner, name, explicitHost } か null
 */
export function parseRepoSpec(spec, defaultHost, bare) {
  const s = String(spec).trim();
  // ssh・scp 形式のホストは、SSH の別名が github.com に解決できるとき github.com として扱う（remote-url.mjs。通信なし）
  let m = /^(https?|ssh|git):\/\/(?:([^@/]+)@)?([^/:]+)(?::(\d+))?\/([^/]+)\/([^/?#]+?)(?:\.git)?(?:[/?#].*)?$/.exec(s);
  if (m && okPart(m[5]) && okPart(m[6])) return { host: normHost(m[1] === "ssh" ? canonicalSshHost(m[3], m[2], m[4]) : m[3]), owner: m[5], name: m[6], explicitHost: true };
  m = /^([^@/\s]+)@([^:/\s]+):([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(s);
  if (m && okPart(m[3]) && okPart(m[4])) return { host: normHost(canonicalSshHost(m[2], m[1])), owner: m[3], name: m[4], explicitHost: true };
  if (!bare) return null;
  const p = s.split("/");
  if (p.length === 2 && p.every(okPart)) return { host: defaultHost, owner: p[0], name: stripGit(p[1]), explicitHost: false };
  if (p.length === 3 && p.every(okPart)) return { host: normHost(p[0]), owner: p[1], name: stripGit(p[2]), explicitHost: true };
  return null;
}

// 作業ディレクトリのリポジトリの remote から、GitHub 形式のリポジトリを集める
function remoteRepos(dir) {
  if (!dir) return [];
  const names = (git(dir, "remote") ?? "").split("\n").filter(Boolean);
  const out = [];
  for (const n of names) {
    const url = git(dir, "remote", "get-url", n);
    const r = url ? parseRepoSpec(url, "github.com", false) : null;
    const resolved = git(dir, "config", "--get", `remote.${n}.gh-resolved`);
    if (r) out.push({ name: n, repo: r, resolved });
  }
  return out;
}

// 環境変数（コマンド先頭の代入・フックのプロセス）から GH_REPO・GH_HOST を得る
const envOf = (assigns = []) => {
  const e = { GH_REPO: process.env.GH_REPO, GH_HOST: process.env.GH_HOST };
  for (const a of assigns) {
    const i = a.indexOf("=");
    const k = a.slice(0, i);
    if (k === "GH_REPO" || k === "GH_HOST") e[k] = a.slice(i + 1);
  }
  return e;
};

/**
 * 対象のリポジトリを確定する。優先順は gh と同じ: 明示のフラグ、環境変数 GH_REPO、作業ディレクトリの remote。
 * 戻り値: { repository, source, unresolved[] }。repository は { host, owner, name } か null
 */
export function resolveRepo({ dir, flagRepo, hostFlag, assigns, tainted }) {
  const env = envOf(assigns);
  const defHost = normHost(hostFlag ?? env.GH_HOST ?? "github.com");
  const unresolved = [];
  let repository = null;
  let source = null;
  let explicitHost = false;
  const fromSpec = (spec, src, label) => {
    const p = parseRepoSpec(spec, defHost, true);
    if (!p) { unresolved.push(`${label} '${spec}' を GitHub のリポジトリとして解釈できません。`); return; }
    repository = { host: p.host, owner: p.owner, name: p.name };
    source = src;
    explicitHost = p.explicitHost;
  };
  if (flagRepo !== undefined) fromSpec(flagRepo, "flag", "--repo の指定");
  else if (env.GH_REPO) fromSpec(env.GH_REPO, "env", "環境変数 GH_REPO");
  else {
    const rs = remoteRepos(dir);
    const base = rs.find((r) => r.resolved === "base");
    const named = rs.find((r) => r.resolved && r.resolved !== "base" && parseRepoSpec(r.resolved, defHost, true));
    const distinct = [];
    for (const r of rs) if (!distinct.some((d) => sameRepo(d, r.repo))) distinct.push(r.repo);
    if (base) { repository = base.repo; source = "remote"; }
    else if (named) { const p = parseRepoSpec(named.resolved, defHost, true); repository = { host: p.host, owner: p.owner, name: p.name }; source = "remote"; }
    else if (distinct.length === 1) { repository = distinct[0]; source = "remote"; explicitHost = true; }
    else if (distinct.length === 0) unresolved.push("対象のリポジトリが指定されておらず、作業ディレクトリに GitHub を指す remote もないため確定できません。");
    else unresolved.push("作業ディレクトリに GitHub を指す remote が複数あり、gh の対象リポジトリを確定できません（-R で指定してください）。");
  }
  if (tainted && !(source === "flag" && explicitHost)) {
    unresolved.push("同じコマンド列で GH_REPO・GH_HOST などを設定しており、対象のホスト・リポジトリを確定できません。");
  }
  if (repository) repository = { host: repository.host, owner: repository.owner, name: repository.name };
  return { repository, source, unresolved };
}

// 対象が作業ディレクトリのリポジトリの remote のどれかと一致するか。true | false | null（比較できない）
export function matchesCwd(dir, repository, ignoreHost = false) {
  if (!repository) return null;
  const rs = remoteRepos(dir).map((r) => r.repo);
  if (!rs.length) return null;
  return rs.some((r) => (ignoreHost || r.host === repository.host) && r.owner.toLowerCase() === repository.owner.toLowerCase() && r.name.toLowerCase() === repository.name.toLowerCase());
}

const currentBranch = (dir) => (dir ? git(dir, "branch", "--show-current") || null : null);

// ---- オプションの解釈 ---------------------------------------------------------
// spec: { values: { "--base": "base", "-B": "base" }, bools: { "--draft": "draft", "-d": "draft" } }
// 戻り値: { opts: { 名前: [値…] }, pos, problems }
function parseFlags(args, spec) {
  const opts = {};
  const pos = [];
  const problems = [];
  const put = (k, v) => { (opts[k] ??= []).push(v); };
  let rest = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (rest) { pos.push(a); continue; }
    if (a === "--") { rest = true; continue; }
    if (a === "-h" || a === "--help") { put("help", true); continue; }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq < 0 ? a : a.slice(0, eq);
      if (spec.values[name]) {
        if (eq >= 0) put(spec.values[name], a.slice(eq + 1));
        else if (i + 1 < args.length) put(spec.values[name], args[++i]);
        else problems.push(`${name} の値がありません。`);
      } else if (spec.bools[name]) put(spec.bools[name], eq < 0 ? true : a.slice(eq + 1) !== "false");
      else problems.push(`未対応のオプション ${name} です。`);
    } else if (a.startsWith("-") && a !== "-") {
      const short = a.slice(0, 2);
      if (spec.values[short]) {
        if (a.length > 2) put(spec.values[short], a.slice(2).replace(/^=/, ""));
        else if (i + 1 < args.length) put(spec.values[short], args[++i]);
        else problems.push(`${short} の値がありません。`);
      } else if ([...a.slice(1)].every((ch) => spec.bools[`-${ch}`])) for (const ch of a.slice(1)) put(spec.bools[`-${ch}`], true);
      else problems.push(`未対応のオプション ${a} です。`);
    } else pos.push(a);
  }
  return { opts, pos, problems };
}

const REPO_SPEC = { values: { "--repo": "repo", "-R": "repo" }, bools: {} };
const PR_CREATE = {
  values: { "--assignee": "x", "-a": "x", "--base": "base", "-B": "base", "--body": "x", "-b": "x", "--body-file": "x", "-F": "x", "--head": "head", "-H": "head", "--label": "x", "-l": "x", "--milestone": "x", "-m": "x", "--project": "x", "-p": "x", "--recover": "x", "--repo": "repo", "-R": "repo", "--reviewer": "x", "-r": "x", "--template": "x", "-T": "x", "--title": "x", "-t": "x" },
  bools: { "--draft": "draft", "-d": "draft", "--dry-run": "dryRun", "--fill": "x", "-f": "x", "--fill-first": "x", "--fill-verbose": "x", "--no-maintainer-edit": "x", "--web": "x", "-w": "x", "--editor": "x", "-e": "x" },
};
const PR_MERGE = {
  values: { "--author-email": "x", "-A": "x", "--body": "x", "-b": "x", "--body-file": "x", "-F": "x", "--match-head-commit": "x", "--repo": "repo", "-R": "repo", "--subject": "x", "-t": "x" },
  bools: { "--admin": "admin", "--auto": "auto", "--delete-branch": "x", "-d": "x", "--disable-auto": "disableAuto", "--merge": "merge", "-m": "merge", "--rebase": "rebase", "-r": "rebase", "--squash": "squash", "-s": "squash" },
};
const PR_CHECKOUT = {
  values: { "--branch": "branch", "-b": "branch", "--repo": "repo", "-R": "repo" },
  bools: { "--detach": "detach", "--force": "x", "-f": "x", "--recurse-submodules": "x" },
};
const API = {
  values: { "--field": "field", "-F": "field", "--raw-field": "raw", "-f": "raw", "--header": "x", "-H": "x", "--hostname": "host", "--input": "input", "--jq": "x", "-q": "x", "--method": "method", "-X": "method", "--preview": "x", "-p": "x", "--template": "x", "-t": "x", "--cache": "x" },
  bools: { "--include": "x", "-i": "x", "--paginate": "x", "--silent": "x", "--slurp": "x", "--verbose": "x" },
};

const dynIn = (words) => words.some((w) => w.dyn || w.glob);

// ---- gh の分類 ----------------------------------------------------------------
const PR_READ = new Set(["view", "list", "status", "checks", "diff"]);
const PR_REFWRITE = new Set(["update-branch"]);
// グループごとの照会（読み取り）サブコマンド。ここに無い動詞は書き込みとして扱う
const GROUP_READ = {
  issue: ["view", "list", "status"], repo: ["view", "list", "clone", "credits"], release: ["list", "view", "download", "verify", "verify-asset"],
  run: ["list", "view", "watch", "download"], workflow: ["list", "view"], auth: ["status", "token"], config: ["get", "list"], alias: ["list"],
  label: ["list"], ruleset: ["list", "view", "check"], secret: ["list"], variable: ["list", "get"], cache: ["list"], gist: ["list", "view"],
  project: ["list", "view", "field-list", "item-list"], codespace: ["list", "view", "logs", "ports"], org: ["list"], "ssh-key": ["list"], "gpg-key": ["list"],
  extension: ["list", "search", "browse"], attestation: ["verify", "download", "inspect", "trusted-root"], agent: ["list", "view"], copilot: [],
};
const TOP_READ = new Set(["browse", "completion", "help", "search", "status", "version", "accessibility", "--version", "-v"]);
const GROUP_REFWRITE = { repo: ["sync", "delete", "rename", "edit", "archive"], release: ["create", "delete", "edit", "upload", "delete-asset"] };
// 以降の gh の対象解決や挙動を変える設定変更
const TAINTING = { config: ["set"], alias: ["set", "delete", "import"], repo: ["set-default"] };

/**
 * gh コマンドの引数（`gh` の次の語から）を解釈する。
 * c: { dir, assigns, tainted, markDirty, markTainted }
 */
export function ghOperations(words, c) {
  const a = words.map((w) => w.v);
  const dyn = dynIn(words);
  const unresolvedDyn = dyn ? ["gh の引数に展開・ワイルドカードが含まれ、対象を確定できません。"] : [];
  const q = (name) => [{ kind: "query", unresolved: [], fields: { subcommand: name, surface: "gh" } }];
  if (!a.length) return q("gh");
  const group = a[0];
  if (words[0].dyn) return [{ kind: "unparseable", unresolved: ["gh のサブコマンドが展開で決まり、確定できません。"], fields: { surface: "gh" } }];
  if (group === "-h" || group === "--help") return q("gh --help");
  if (TOP_READ.has(group)) return q(`gh ${group}`);
  if (group === "api") return ghApi(a.slice(1), words.slice(1), c);
  if (group === "pr") return ghPr(a.slice(1), words.slice(1), c, unresolvedDyn);
  if (GROUP_READ[group] === undefined && group !== "pr") {
    return [{ kind: "unparseable", unresolved: [`未対応の gh サブコマンド '${group}'（エイリアス・拡張を含む）で、変更かどうか確定できません。`], fields: { surface: "gh", via: `gh ${group}` } }];
  }
  const verb = a.slice(1).find((x) => !x.startsWith("-")) ?? "";
  if (words[1] && words[1].dyn) return [{ kind: "unparseable", unresolved: ["gh のサブコマンドが展開で決まり、確定できません。"], fields: { surface: "gh", via: `gh ${group}` } }];
  if (GROUP_READ[group].includes(verb) || a.slice(1).some((x) => x === "-h" || x === "--help")) return q(`gh ${group} ${verb}`);
  if (TAINTING[group]?.includes(verb)) c.markTainted();
  const { opts } = parseFlags(a.slice(1), { values: { ...REPO_SPEC.values }, bools: new Proxy({}, { get: () => true }) });
  const rr = resolveRepo({ dir: c.dir, flagRepo: last(opts.repo), assigns: c.assigns, tainted: c.tainted });
  return [{
    kind: "unsupported-write", unresolved: unresolvedDyn,
    fields: { surface: "gh", via: `gh ${group} ${verb}`.trim(), area: group, action: verb, refWrite: !!GROUP_REFWRITE[group]?.includes(verb), repository: rr.repository, repositorySource: rr.source, repoMatchesCwd: matchesCwd(c.dir, rr.repository) },
  }];
}

function ghPr(a, words, c, unresolvedDyn) {
  const verb = a.find((x) => !x.startsWith("-")) ?? "";
  const surface = "gh";
  if (!verb) return [{ kind: "unparseable", unresolved: ["gh pr のサブコマンドがありません。", ...unresolvedDyn], fields: { surface } }];
  const vi = a.indexOf(verb);
  if (words[vi].dyn) return [{ kind: "unparseable", unresolved: ["gh pr のサブコマンドが展開で決まり、確定できません。"], fields: { surface } }];
  const args = a.slice(vi + 1);
  const via = `gh pr ${verb}`;
  if (PR_READ.has(verb) || a.includes("-h") || a.includes("--help")) return [{ kind: "query", unresolved: [], fields: { subcommand: via, surface } }];
  const common = (rr) => ({ surface, via, repository: rr.repository, repositorySource: rr.source, repoMatchesCwd: matchesCwd(c.dir, rr.repository) });
  if (verb === "create") {
    const { opts, pos, problems } = parseFlags(args, PR_CREATE);
    const unresolved = [...unresolvedDyn, ...problems];
    if (pos.length) unresolved.push("gh pr create に位置引数があり、解釈できません。");
    const rr = resolveRepo({ dir: c.dir, flagRepo: last(opts.repo), assigns: c.assigns, tainted: c.tainted });
    unresolved.push(...rr.unresolved);
    let head = null;
    const spec = last(opts.head);
    if (spec !== undefined) {
      const i = spec.indexOf(":");
      head = i >= 0 ? { owner: spec.slice(0, i) || null, branch: spec.slice(i + 1) } : { owner: null, branch: spec };
      if (!head.branch) { unresolved.push("--head のブランチ名が空です。"); head = null; }
    } else {
      const b = currentBranch(c.dir);
      if (b) head = { owner: null, branch: b };
      else unresolved.push("--head がなく、現在のブランチも確定できない（detached HEAD など）ため、head を確定できません。");
    }
    let base = last(opts.base) ?? null;
    if (base === null && head && c.dir) base = git(c.dir, "config", "--get", `branch.${head.branch}.gh-merge-base`) || null;
    if (base === null) unresolved.push("--base がなく、取り込み先（base）を確定できません。");
    return [{ kind: "pr-create", unresolved, fields: { ...common(rr), head, base, dryRun: !!last(opts.dryRun), mayPush: true } }];
  }
  if (verb === "merge") {
    const { opts, pos, problems } = parseFlags(args, PR_MERGE);
    const unresolved = [...unresolvedDyn, ...problems];
    if (pos.length > 1) unresolved.push("gh pr merge の位置引数が複数あり、対象の PR を確定できません。");
    const sel = pos[0] ?? null;
    let rr = resolveRepo({ dir: c.dir, flagRepo: last(opts.repo), assigns: c.assigns, tainted: c.tainted });
    const um = sel && /^(?:https?):\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(sel);
    if (um) {
      const fromUrl = { host: normHost(um[1]), owner: um[2], name: um[3] };
      if (rr.repository && !sameRepo(rr.repository, fromUrl) && rr.source === "flag") unresolved.push("--repo と PR の URL が別のリポジトリを指しています。");
      rr = { repository: fromUrl, source: "url", unresolved: [] };
    }
    unresolved.push(...rr.unresolved);
    const method = last(opts.squash) ? "squash" : last(opts.rebase) ? "rebase" : last(opts.merge) ? "merge" : null;
    const pr = { number: um ? Number(um[4]) : sel && /^\d+$/.test(sel) ? Number(sel) : null, selector: sel };
    if (last(opts.disableAuto)) return [{ kind: "unsupported-write", unresolved, fields: { ...common(rr), area: "pr", action: "disable-auto-merge", refWrite: false, pr } }];
    return [{ kind: last(opts.auto) ? "auto-merge" : "github-merge", unresolved, fields: { ...common(rr), pr, method, admin: !!last(opts.admin), branch: sel === null ? currentBranch(c.dir) : null } }];
  }
  if (verb === "checkout") {
    // PR の head をローカルのブランチとして取得して切り替える（ローカルのブランチ作成・再開にあたる）
    const { opts, problems } = parseFlags(args, PR_CHECKOUT);
    c.markDirty();
    const branch = last(opts.branch) ?? null;
    if (last(opts.detach)) return [{ kind: "query", unresolved: [...unresolvedDyn, ...problems], fields: { subcommand: via, surface, detached: true } }];
    const unresolved = [...unresolvedDyn, ...problems];
    if (branch === null) unresolved.push("gh pr checkout は PR の head 名のブランチを作成・切り替えるため、ブランチ名を確定できません（-b で指定してください）。");
    return [{ kind: "create", unresolved, fields: { surface, via, action: "create", branch } }];
  }
  const { opts } = parseFlags(args, { values: { ...REPO_SPEC.values }, bools: new Proxy({}, { get: () => true }) });
  const rr = resolveRepo({ dir: c.dir, flagRepo: last(opts.repo), assigns: c.assigns, tainted: c.tainted });
  const known = ["ready", "edit", "close", "reopen", "comment", "review", "lock", "unlock", "update-branch", "revert"];
  if (!known.includes(verb)) return [{ kind: "unparseable", unresolved: [`未対応の gh pr サブコマンド '${verb}' で、変更かどうか確定できません。`, ...unresolvedDyn], fields: common(rr) }];
  return [{ kind: "unsupported-write", unresolved: unresolvedDyn, fields: { ...common(rr), area: "pr", action: verb, refWrite: PR_REFWRITE.has(verb) } }];
}

// ---- gh api -------------------------------------------------------------------
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const REF_MUTATIONS = new Set(["createRef", "updateRef", "updateRefs", "deleteRef", "createCommitOnBranch", "updatePullRequestBranch", "createBranch", "createTag"]);

// 変異（mutation）のルートのフィールド名を取り出す。解釈できなければ null
function mutationRoots(text) {
  const roots = [];
  const re = /\bmutation\b[^{]*\{/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    let depth = 1;
    let i = re.lastIndex;
    let ok = false;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '"') {
        if (text.startsWith('"""', i)) { const e = text.indexOf('"""', i + 3); if (e < 0) return null; i = e + 3; continue; }
        i++;
        while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
        i++;
        continue;
      }
      if (ch === "#") { while (i < text.length && text[i] !== "\n") i++; continue; }
      if (ch === "{" || ch === "(") depth++;
      else if (ch === "}" || ch === ")") { depth--; if (depth === 0) { ok = true; i++; break; } }
      else if (depth === 1 && /[A-Za-z_.]/.test(ch)) {
        let j = i;
        while (j < text.length && /[A-Za-z0-9_.]/.test(text[j])) j++;
        let id = text.slice(i, j);
        let k = j;
        while (/\s/.test(text[k] ?? "")) k++;
        if (text[k] === ":" && !id.startsWith(".")) {
          k++;
          while (/\s/.test(text[k] ?? "")) k++;
          let e = k;
          while (e < text.length && /[A-Za-z0-9_]/.test(text[e])) e++;
          id = text.slice(k, e);
          j = e;
        }
        roots.push(id);
        i = j;
        continue;
      }
      i++;
    }
    if (!ok) return null;
    re.lastIndex = i;
  }
  return roots;
}

function ghApi(a, words, c) {
  const { opts, pos, problems } = parseFlags(a, API);
  const unresolved = [...problems];
  if (dynIn(words)) unresolved.push("gh api の引数に展開・ワイルドカードが含まれ、対象と操作を確定できません。");
  const surface = "gh";
  if (opts.help) return [{ kind: "query", unresolved: [], fields: { subcommand: "gh api", surface } }];
  if (pos.length !== 1) return [{ kind: "unsupported-write", unresolved: [...unresolved, "gh api のエンドポイントを 1 つに確定できません。"], fields: { surface, via: "gh api", area: "api", action: "unknown", refWrite: true, repository: null } }];
  // フィールド（-f/-F/--field/--raw-field）
  const fields = {};
  const fileFields = new Set();
  const addField = (kv, typed) => {
    const i = kv.indexOf("=");
    if (i <= 0) { unresolved.push(`フィールド '${kv}' が key=value の形ではありません。`); return; }
    const k = kv.slice(0, i);
    const v = kv.slice(i + 1);
    fields[k] = v;
    if (typed && v.startsWith("@")) fileFields.add(k);
  };
  for (const kv of opts.field ?? []) addField(kv, true);
  for (const kv of opts.raw ?? []) addField(kv, false);
  const hasInput = (opts.input ?? []).length > 0;
  const methodRaw = last(opts.method);
  const method = methodRaw === undefined ? (hasInput || Object.keys(fields).length ? "POST" : "GET") : methodRaw.toUpperCase();
  const known = method === "GET" || method === "HEAD" || WRITE_METHODS.has(method);
  if (!known) unresolved.push(`HTTP メソッド '${methodRaw}' を解釈できません。`);
  const hostFlag = last(opts.host);

  // エンドポイントの正規化
  let ep = pos[0];
  let urlHost = null;
  const um = /^https?:\/\/([^/]+)(\/.*)?$/.exec(ep);
  if (um) { urlHost = normHost(um[1]); ep = (um[2] ?? "/").replace(/^\/api\/v3(?=\/)/, ""); }
  ep = ep.split("?")[0];
  const needsPlaceholder = /\{(owner|repo|branch)\}|:(owner|repo|branch)(?=\/|$)/.test(ep);
  const rrAmbient = needsPlaceholder ? resolveRepo({ dir: c.dir, hostFlag, assigns: c.assigns, tainted: c.tainted }) : null;
  const branchNow = needsPlaceholder ? currentBranch(c.dir) : null;
  const segs = ep.split("/").filter(Boolean).map((s) => {
    if (s === "{owner}" || s === ":owner") { if (!rrAmbient.repository) { unresolved.push(...rrAmbient.unresolved); return s; } return rrAmbient.repository.owner; }
    if (s === "{repo}" || s === ":repo") { if (!rrAmbient.repository) return s; return rrAmbient.repository.name; }
    if (s === "{branch}" || s === ":branch") { if (!branchNow) { unresolved.push("{branch} を現在のブランチから確定できません。"); return s; } return branchNow; }
    try { return decodeURIComponent(s); } catch { return s; }
  });
  const host = normHost(urlHost ?? hostFlag ?? envOf(c.assigns).GH_HOST ?? rrAmbient?.repository?.host ?? "github.com");
  const base = { surface, via: "gh api", host };
  let repository = null;
  let rest = [];
  if (segs[0] === "repos" && segs.length >= 3 && okPart(segs[1]) && okPart(segs[2])) {
    repository = { host, owner: segs[1], name: segs[2] };
    rest = segs.slice(3);
  } else if (segs[0] === "repos" && segs.length >= 3) unresolved.push("エンドポイントのリポジトリ名を確定できません。");
  const repoFields = { repository, repositorySource: repository ? (needsPlaceholder ? "placeholder" : "path") : null, repoMatchesCwd: matchesCwd(c.dir, repository) };
  if (c.tainted && repository && !urlHost && !hostFlag && !needsPlaceholder) unresolved.push("同じコマンド列で GH_HOST を設定しており、対象のホストを確定できません。");

  // GraphQL
  if (segs[0] === "graphql" && segs.length === 1) return ghGraphql({ fields, fileFields, opts, method, unresolved, base, c });

  if (known && (method === "GET" || method === "HEAD")) return [{ kind: "query", unresolved: [], fields: { subcommand: `gh api ${method}`, surface } }];

  // REST の書き込み
  const need = (name, val) => { if (typeof val !== "string" || val === "") unresolved.push(`必須入力 ${name} がありません。`); };
  const w = (kind, extra) => [{ kind, unresolved, fields: { ...base, ...repoFields, method, ...extra } }];
  const unsupported = (area, action, refWrite, extra = {}) => w("unsupported-write", { area, action, refWrite, ...extra });
  if (!repository) {
    if (segs[0] === "repos") return unsupported("repo", "unknown", true);
    return unsupported(segs[0] ?? "api", method.toLowerCase(), segs[0] === "repositories" || !segs.length, {});
  }
  const r0 = rest[0];
  if (r0 === "pulls" && rest.length === 1 && method === "POST") {
    const spec = fields.head;
    let head = null;
    need("head", spec);
    if (typeof spec === "string" && spec) {
      const i = spec.indexOf(":");
      head = i >= 0 ? { owner: spec.slice(0, i) || null, branch: spec.slice(i + 1) } : { owner: null, branch: spec };
      if (!head.branch) { unresolved.push("head のブランチ名が空です。"); head = null; }
    }
    need("base", fields.base);
    if (typeof fields.title !== "string" && typeof fields.issue !== "string") unresolved.push("必須入力 title（または issue）がありません。");
    for (const k of ["head", "base"]) if (fileFields.has(k)) unresolved.push(`${k} がファイルから読まれ、値を確定できません。`);
    return w("pr-create", { head, base: typeof fields.base === "string" && fields.base ? fields.base : null, dryRun: false, mayPush: false });
  }
  if (r0 === "pulls" && /^\d+$/.test(rest[1] ?? "") && rest[2] === "merge" && method === "PUT") {
    return w("github-merge", { pr: { number: Number(rest[1]), selector: rest[1] }, method: typeof fields.merge_method === "string" ? fields.merge_method : null, admin: false, branch: null });
  }
  if (r0 === "merges" && rest.length === 1 && method === "POST") {
    need("base", fields.base);
    need("head", fields.head);
    return w("github-merge", { pr: null, branchMerge: true, base: fields.base ?? null, head: fields.head ?? null, method: null, admin: false, branch: null });
  }
  if (r0 === "pulls") {
    const action = rest[2] ?? (rest.length === 2 ? "edit" : "create");
    return unsupported("pr", action, rest[2] === "update-branch");
  }
  if (r0 === "git" && (rest[1] === "refs" || rest[1] === "tags")) {
    const refPath = rest.slice(2).join("/");
    const ref = refPath || (typeof fields.ref === "string" ? fields.ref : null);
    return unsupported("ref", method.toLowerCase(), true, { branch: ref ? ref.replace(/^(refs\/)?heads\//, "") : null, ref });
  }
  if (r0 === "contents" || r0 === "branches" || r0 === "releases") {
    return unsupported(r0, method.toLowerCase(), true, { branch: typeof fields.branch === "string" ? fields.branch : r0 === "branches" ? rest[1] ?? null : null });
  }
  return unsupported(r0 ?? "repo", method.toLowerCase(), false);
}

function readJsonFile(c, path) {
  if (!c.dir || path === "-") return null;
  try {
    const p = resolve(c.dir, path);
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
  } catch { return null; }
}

function ghGraphql({ fields, fileFields, opts, method, unresolved, base, c }) {
  let text = typeof fields.query === "string" ? fields.query : null;
  let vars = {};
  const opaque = (why) => [{ kind: "unsupported-write", unresolved: [...unresolved, why], fields: { ...base, method, area: "graphql", action: "opaque", refWrite: true, repository: null } }];
  const inputPath = last(opts.input);
  if (inputPath !== undefined) {
    const j = readJsonFile(c, inputPath);
    if (!j || typeof j.query !== "string") return opaque("--input の内容を確認できず、GraphQL の操作を確定できません。");
    text = j.query;
    vars = typeof j.variables === "object" && j.variables ? j.variables : {};
  }
  for (const [k, v] of Object.entries(fields)) if (k !== "query") vars[k] = v;
  if (fileFields.has("query")) {
    try {
      const p = resolve(c.dir ?? "/", fields.query.slice(1));
      text = readFileSync(p, "utf8");
    } catch { return opaque("クエリのファイルを読めず、GraphQL の操作を確定できません。"); }
  }
  if (text === null) return opaque("GraphQL のクエリを確認できません。");
  if (!/\bmutation\b/i.test(text)) return [{ kind: "query", unresolved: [], fields: { subcommand: "gh api graphql", surface: "gh" } }];
  const roots = mutationRoots(text);
  if (roots === null || roots.length === 0) return opaque("GraphQL の変異を解釈できません。");
  const lookup = (name) => {
    const lit = new RegExp(`\\b${name}\\s*:\\s*(?:"([^"]*)"|\\$(\\w+))`).exec(text);
    if (lit && lit[1] !== undefined) return lit[1];
    if (lit && lit[2] !== undefined && typeof vars[lit[2]] === "string") return vars[lit[2]];
    const input = vars.input;
    if (input && typeof input === "object" && typeof input[name] === "string") return input[name];
    if (typeof vars[`input[${name}]`] === "string") return vars[`input[${name}]`];
    return null;
  };
  const ops = [];
  const repoWhy = "GraphQL はノード ID（repositoryId・pullRequestId）で対象を指し、ホスト・リポジトリ名を確定できません。";
  const common = { ...base, method, repository: null, repositorySource: null, repoMatchesCwd: null };
  for (const root of [...new Set(roots)]) {
    if (root === "createPullRequest") {
      const hd = lookup("headRefName");
      const bs = lookup("baseRefName");
      const un = [...unresolved, repoWhy];
      if (!hd) un.push("必須入力 headRefName を確定できません。");
      if (!bs) un.push("必須入力 baseRefName を確定できません。");
      ops.push({ kind: "pr-create", unresolved: un, fields: { ...common, head: hd ? { owner: null, branch: hd } : null, base: bs, dryRun: false, mayPush: false } });
    } else if (root === "mergePullRequest" || root === "mergeBranch") {
      ops.push({ kind: "github-merge", unresolved: [...unresolved, repoWhy], fields: { ...common, pr: null, method: lookup("mergeMethod"), admin: false, branch: null, mutation: root } });
    } else if (root === "enablePullRequestAutoMerge") {
      ops.push({ kind: "auto-merge", unresolved: [...unresolved, repoWhy], fields: { ...common, pr: null, method: lookup("mergeMethod"), admin: false, branch: null, mutation: root } });
    } else {
      ops.push({ kind: "unsupported-write", unresolved: [...unresolved], fields: { ...common, area: "graphql", action: root, refWrite: REF_MUTATIONS.has(root), mutation: root } });
    }
  }
  return ops;
}

// ---- curl・wget など（GitHub の API を直接呼ぶ経路）---------------------------
const HTTP_LONG_WRITE = /^(--data|--data-raw|--data-binary|--data-urlencode|--data-ascii|--form|--form-string|--upload-file|--json|--post-data|--post-file|--body-data|--body-file)(=|$)/;
const HTTP_LONG_METHOD = /^(--request|--method)(=|$)/;
// 値を取る短いオプション（連結形の走査をここで止める。-X・-d・-F・-T は別に扱う）
const HTTP_VALUE_SHORT = new Set("HoOuAebcmwxEKrCyYzDpQ".split(""));
const isReadMethod = (m) => /^(GET|HEAD)$/i.test(m);
/**
 * 引数列を走査し、書き込みになる指定があるかを返す。
 * 長いオプション（--request=PUT・--request PUT・--data=x）と、短いオプションの連結形
 * （-XPUT・-sXPUT・-d{}・-sd{}）を扱う。メソッドが GET・HEAD のときだけ書き込みから除外する。
 */
function hasHttpWrite(a) {
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    if (HTTP_LONG_METHOD.test(x)) {
      const eq = x.indexOf("=");
      const m = eq >= 0 ? x.slice(eq + 1) : a[i + 1] ?? "";
      if (!isReadMethod(m)) return true;
    } else if (x.startsWith("--")) {
      if (HTTP_LONG_WRITE.test(x)) return true;
    } else if (/^-[A-Za-z]/.test(x)) {
      for (let k = 1; k < x.length; k++) {
        const ch = x[k];
        if (ch === "X") {
          const m = x.slice(k + 1) || a[i + 1] || "";
          if (!isReadMethod(m)) return true;
          break;
        }
        if (ch === "d" || ch === "F" || ch === "T") return true;
        if (HTTP_VALUE_SHORT.has(ch)) break;
      }
    }
  }
  return false;
}
/**
 * curl・wget が GitHub を書き込みで呼ぶ形か。戻り値: 操作の配列か null（対象外）
 */
export function httpClientOperations(name, words) {
  const a = words.map((w) => w.v);
  const writes = hasHttpWrite(a);
  const toGithub = a.some((x) => /github/i.test(x)) || words.some((w) => w.dyn);
  if (!writes || !toGithub) return null;
  return [{ kind: "unsupported-write", unresolved: [], fields: { surface: "http", via: name, area: "http", action: "write", refWrite: true, repository: null } }];
}

// ---- MCP ----------------------------------------------------------------------
const MCP_READ = /^(get|list|search|find|read|fetch|describe|check)_|_(read|get|list|search)$|^git_(status|diff|diff_unstaged|diff_staged|log|show|branch)$/;
const MCP_WRITE = /(^|_)(create|update|delete|merge|push|add|remove|fork|enable|disable|assign|request|dismiss|submit|write|run|rerun|cancel|close|reopen|lock|unlock|transfer|set|mark|approve|edit|upload|trigger|resolve|unresolve|reply|commit|checkout|reset|rebase|apply|stage|revert|cherry|pull|branch|tag|sync|rename|publish|star|unstar|subscribe|label|comment|review)(_|$)/;
const MCP_REFWRITE = /^(create_branch|push_files|create_or_update_file|delete_file|git_commit|git_checkout|git_create_branch|git_reset|git_push|update_pull_request_branch)$/;
// GitHub を操作する既知の MCP ツール名（サーバー名に依らず GitHub 向けとみなす）
const GITHUB_TOOLS = new Set(["create_pull_request", "merge_pull_request", "update_pull_request", "update_pull_request_branch", "create_branch", "push_files", "create_or_update_file", "delete_file", "enable_pull_request_auto_merge", "enable_auto_merge", "fork_repository", "create_repository", "pull_request_review_write"]);
const isGitServer = (s) => /git/i.test(s) || /(^|[-_.])gh([-_.]|$)/i.test(s);

/**
 * MCP ツールの呼び出しを解釈する。
 * 戻り値: { scope, server, tool, operations }。scope は
 *   not-mcp      MCP ツールではない（対象外）
 *   github       GitHub・Git 系の MCP（既知の書き込みは識別し、未対応の書き込みは unsupported-write で返す）
 *   other-mcp    GitHub・Git と判断できない MCP（識別できない。導入検査で強制範囲外として扱う）
 */
export function mcpOperations(toolName, toolInput, dir) {
  const bare = typeof toolName === "string" ? toolName : "";
  const m = /^mcp__(.+?)__(.+)$/.exec(bare);
  const server = m ? m[1] : null;
  const tool = m ? m[2] : bare;
  if (!m && !GITHUB_TOOLS.has(bare)) return { scope: "not-mcp", server: null, tool: bare, operations: [] };
  const scope = GITHUB_TOOLS.has(tool) || (server !== null && isGitServer(server)) ? "github" : "other-mcp";
  if (scope === "other-mcp") return { scope, server, tool, operations: [] };
  const input = toolInput && typeof toolInput === "object" && !Array.isArray(toolInput) ? toolInput : null;
  const unresolved = [];
  if (!input) unresolved.push("MCP ツールの入力がオブジェクトではなく、対象を確定できません。");
  const get = (k) => (input && typeof input[k] === "string" && input[k] !== "" ? input[k] : null);
  const need = (k) => { if (input && get(k) === null) unresolved.push(`必須入力 ${k} がありません。`); return get(k); };
  const base = { surface: "mcp", via: bare, server, tool };
  // リポジトリ: owner と repo、または repo が OWNER/REPO
  let repository = null;
  const owner = get("owner");
  const repoName = get("repo") ?? get("repository");
  if (owner && repoName && okPart(owner) && okPart(repoName)) repository = { host: null, owner, name: repoName };
  else if (!owner && repoName && /^[^/]+\/[^/]+$/.test(repoName)) { const [o, n] = repoName.split("/"); repository = { host: null, owner: o, name: n }; }
  const needRepo = () => { if (input && !repository) unresolved.push("対象のリポジトリ（owner・repo）を入力から確定できません。"); };
  const repoFields = () => ({ repository, repositorySource: repository ? "input" : null, hostFromTool: false, repoMatchesCwd: matchesCwd(dir, repository, true) });
  const out = (kind, fields, un = unresolved) => ({ scope, server, tool, operations: [{ kind, unresolved: un, fields: { ...base, ...repoFields(), ...fields } }] });

  if (tool === "create_pull_request") {
    needRepo();
    const spec = need("head");
    let head = null;
    if (spec) {
      const i = spec.indexOf(":");
      head = i >= 0 ? { owner: spec.slice(0, i) || null, branch: spec.slice(i + 1) } : { owner: null, branch: spec };
      if (!head.branch) { unresolved.push("head のブランチ名が空です。"); head = null; }
    }
    const bs = need("base");
    need("title");
    return out("pr-create", { head, base: bs, dryRun: false, mayPush: false });
  }
  if (tool === "merge_pull_request" || (/(^|_)merge(_|$)/.test(tool) && !/auto.?merge/.test(tool) && /pull|pr/.test(tool))) {
    needRepo();
    const n = input && (typeof input.pullNumber === "number" || /^\d+$/.test(String(input.pullNumber ?? ""))) ? Number(input.pullNumber) : null;
    if (input && n === null) unresolved.push("必須入力 pullNumber がありません。");
    return out("github-merge", { pr: { number: n, selector: n === null ? null : String(n) }, method: get("merge_method"), admin: false, branch: null });
  }
  if (/auto.?merge/.test(tool) && !/disable/.test(tool)) {
    needRepo();
    const n = input && (typeof input.pullNumber === "number" || /^\d+$/.test(String(input.pullNumber ?? ""))) ? Number(input.pullNumber) : null;
    if (input && n === null) unresolved.push("必須入力 pullNumber がありません。");
    return out("auto-merge", { pr: { number: n, selector: n === null ? null : String(n) }, method: get("merge_method"), admin: false, branch: null });
  }
  if (MCP_REFWRITE.test(tool)) {
    const branch = tool === "create_branch" ? get("branch") : tool === "update_pull_request_branch" ? null : get("branch");
    if (tool !== "update_pull_request_branch" && input && branch === null) unresolved.push("必須入力 branch がありません。");
    needRepo();
    return out("unsupported-write", { area: tool.replace(/^git_/, ""), action: tool, refWrite: true, branch });
  }
  if (MCP_READ.test(tool)) return { scope, server, tool, operations: [{ kind: "query", unresolved: [], fields: { ...base, subcommand: tool } }] };
  if (MCP_WRITE.test(tool)) {
    needRepo();
    return out("unsupported-write", { area: tool, action: tool, refWrite: false });
  }
  return { scope, server, tool, operations: [{ kind: "unparseable", unresolved: [`GitHub・Git 系 MCP ツール '${tool}' の変更可否を確定できません。`], fields: { ...base } }] };
}
