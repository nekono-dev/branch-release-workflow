// 操作判定（タスク 2.1・2.2）: シェルの文字列と MCP ツールの入力から、Git と GitHub の操作を取り出し、操作の種類と変更対象を確定する。
// 可否の判断（許可・拒否）はここでは行わない（2.3）。フックとの接続も行わない（6.x）。
// GitHub の書き込み経路（gh・MCP）の識別は github-operations.mjs にあり、ここから呼ぶ。
// 外部依存なし（Node 標準ライブラリのみ）。lib.mjs より上位、フック変換より下位のモジュール。
//
// 戻り値 classifyCommand(command, cwd):
//   operations   取り出した操作。kind は次のとおり
//                  Git: create | commit | push | merge | query | unparseable
//                  GitHub（gh・MCP）: pr-create | github-merge | auto-merge | unsupported-write（kind の意味は github-operations.mjs）
//   compound     照会以外の操作が 2 つ以上あるか
//   needsJudgment 共通判定（2.3）に回す操作（導入済み・不明なリポジトリの、照会以外）
//   undetermined needsJudgment のうち、対象を確定できなかった操作（理由は op.unresolved）
//   passes       needsJudgment が空（通常の照会・未導入のリポジトリ・リポジトリ外）
// classifyMcpCall(toolName, toolInput, cwd) は MCP ツールの呼び出しを同じ形（加えて scope・server・tool）で返す。
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { GH_TARGET_ENV, ghOperations, httpClientOperations, isGh, mcpOperations } from "./github-operations.mjs";
import { enabledInRepo, git, loadConfig, repoRoot } from "./lib.mjs";

const HOME = () => process.env.HOME ?? "/";
const MAX_DEPTH = 4;

// ---- 字句解析 ---------------------------------------------------------------
// 戻り値: 項目の配列。{ type: "open" | "close" } か
//   { type: "cmd", words: [{ v, dyn, glob, redir }], subs: string[], sep, heredoc? }
// dyn: 値が展開（$VAR・$(...)・`...`）で決まる。glob: 引用符なしの * ? [ {。redir: リダイレクトの一部。

// 閉じ括弧までの本文を返す（引用符と入れ子を考慮）。戻り値: { body, end } か、閉じていなければ null
function balanced(s, start, open, close) {
  let depth = 1;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") i++;
    else if (c === "'") {
      const j = s.indexOf("'", i + 1);
      if (j < 0) return null;
      i = j;
    } else if (c === '"') {
      for (i++; i < s.length && s[i] !== '"'; i++) if (s[i] === "\\") i++;
    } else if (c === open) depth++;
    else if (c === close && --depth === 0) return { body: s.slice(start, i), end: i };
  }
  return null;
}

export function lex(s) {
  const items = [];
  let words = [];
  let subs = [];
  let cur = null; // 作りかけの語
  let pendingHeredocs = []; // 行末で本文を読む heredoc の区切り
  let cmdHeredoc = "";
  let nextIsRedirTarget = false;
  let broken = false;
  const flush = () => {
    if (cur === null) return;
    if (nextIsRedirTarget) { cur.redir = true; nextIsRedirTarget = false; }
    words.push(cur);
    cur = null;
  };
  const word = () => (cur ??= { v: "", dyn: false, glob: false, redir: false });
  const endCmd = (sep) => {
    flush();
    if (words.length || subs.length) items.push({ type: "cmd", words, subs, sep, heredoc: cmdHeredoc });
    words = []; subs = []; cmdHeredoc = "";
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") {
      if (s[i + 1] === "\n") { i++; continue; }
      word().v += s[++i] ?? "";
    } else if (c === "'") {
      const j = s.indexOf("'", i + 1);
      if (j < 0) { broken = true; break; }
      word().v += s.slice(i + 1, j);
      i = j;
    } else if (c === '"') {
      const w = word();
      let j = i + 1;
      for (; j < s.length && s[j] !== '"'; j++) {
        const d = s[j];
        if (d === "\\") {
          const n = s[j + 1];
          if (n === "\n") { j++; continue; }
          if (n === '"' || n === "\\" || n === "$" || n === "`") w.v += n; else w.v += d + (n ?? "");
          j++;
        } else if (d === "$" && s[j + 1] === "(") {
          const arith = s[j + 2] === "(";
          const b = balanced(s, j + 2, "(", ")");
          if (!b) { broken = true; j = s.length; break; }
          if (!arith) subs.push(b.body);
          w.dyn = true;
          j = b.end;
        } else if (d === "`") {
          const k = s.indexOf("`", j + 1);
          if (k < 0) { broken = true; j = s.length; break; }
          subs.push(s.slice(j + 1, k));
          w.dyn = true;
          j = k;
        } else if (d === "$" && /[A-Za-z_{0-9@*#?!$-]/.test(s[j + 1] ?? "")) {
          if (s[j + 1] === "{") { const b = balanced(s, j + 2, "{", "}"); j = b ? b.end : s.length; } else { while (/[A-Za-z_0-9]/.test(s[j + 1] ?? "")) j++; if (!/[A-Za-z_0-9]/.test(s[j] ?? "")) j++; }
          w.dyn = true;
          w.v += "$";
        } else w.v += d;
      }
      if (j >= s.length) { broken = true; break; }
      i = j;
    } else if (c === "$") {
      const n = s[i + 1];
      if (n === "(") {
        const arith = s[i + 2] === "(";
        const b = balanced(s, i + 2, "(", ")");
        if (!b) { broken = true; break; }
        if (!arith) subs.push(b.body);
        word().dyn = true;
        i = b.end;
      } else if (n === "{") {
        const b = balanced(s, i + 2, "{", "}");
        if (!b) { broken = true; break; }
        word().dyn = true;
        i = b.end;
      } else if (n === "'") {
        const j = s.indexOf("'", i + 2);
        if (j < 0) { broken = true; break; }
        const w = word(); w.v += s.slice(i + 2, j); w.dyn = true;
        i = j;
      } else if (/[A-Za-z_0-9@*#?!$-]/.test(n ?? "")) {
        const w = word(); w.dyn = true; w.v += "$";
        i++;
        while (/[A-Za-z_0-9]/.test(s[i + 1] ?? "") && /[A-Za-z_]/.test(n)) i++;
      } else word().v += "$";
    } else if (c === "`") {
      const k = s.indexOf("`", i + 1);
      if (k < 0) { broken = true; break; }
      subs.push(s.slice(i + 1, k));
      word().dyn = true;
      i = k;
    } else if (c === " " || c === "\t") flush();
    else if (c === "\n") {
      endCmd("\n");
      // 行末に来たので、待たせていた heredoc の本文を読む
      for (const h of pendingHeredocs) {
        let body = "";
        let pos = i + 1;
        let found = false;
        while (pos <= s.length) {
          let eol = s.indexOf("\n", pos);
          if (eol < 0) eol = s.length;
          const line = s.slice(pos, eol);
          pos = eol + 1;
          if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) { found = true; break; }
          body += line + "\n";
        }
        if (!found) broken = true;
        const last = items[items.length - 1];
        if (last?.type === "cmd") last.heredoc += body;
        i = Math.min(pos - 1, s.length);
      }
      pendingHeredocs = [];
    } else if (c === "#" && cur === null) {
      while (i < s.length && s[i] !== "\n") i++;
      i--;
    } else if (c === ";") endCmd(";");
    else if (c === "&") {
      if (s[i + 1] === "&") { endCmd("&&"); i++; }
      else if (s[i + 1] === ">" || (cur !== null && /^\d*>$/.test(cur.v))) { const w = word(); w.v += "&"; w.redir = true; }
      else endCmd("&");
    } else if (c === "|") {
      if (s[i + 1] === "|") { endCmd("||"); i++; } else { if (s[i + 1] === "&") i++; endCmd("|"); }
    } else if (c === "(") {
      if (cur === null) { endCmd(";"); items.push({ type: "open" }); } else word().v += c;
    } else if (c === ")") {
      endCmd(";");
      items.push({ type: "close" });
    } else if (c === "<" || c === ">") {
      if (s[i + 1] === "(" && cur === null) {
        const b = balanced(s, i + 2, "(", ")");
        if (!b) { broken = true; break; }
        subs.push(b.body);
        word().dyn = true;
        i = b.end;
        continue;
      }
      if (cur !== null && !/^\d+$/.test(cur.v)) flush();
      const w = word();
      w.redir = true;
      w.v += c;
      if (c === "<" && s[i + 1] === "<" && s[i + 2] !== "<") {
        let k = i + 2;
        const strip = s[k] === "-";
        if (strip) k++;
        while (s[k] === " " || s[k] === "\t") k++;
        let delim = "";
        const q = s[k] === "'" || s[k] === '"' ? s[k] : null;
        if (q) { const e = s.indexOf(q, k + 1); if (e < 0) { broken = true; break; } delim = s.slice(k + 1, e); k = e + 1; }
        else { while (k < s.length && !/[\s;&|()<>]/.test(s[k])) delim += s[k++]; }
        pendingHeredocs.push({ delim, strip });
        cmdHeredoc = cmdHeredoc || "";
        w.v += "<";
        i = k - 1;
        flush();
        continue;
      }
      while (s[i + 1] === c || (c === ">" && s[i + 1] === "|")) w.v += s[++i];
      if (s[i + 1] === "&" && c === ">") { w.v += "&"; i++; while (/\d|-/.test(s[i + 1] ?? "")) w.v += s[++i]; flush(); continue; }
      flush();
      nextIsRedirTarget = true;
    } else {
      const w = word();
      if (c === "*" || c === "?" || c === "[" || c === "{") w.glob = true;
      if (c === "~" && w.v === "" && !w.dyn) {
        if (s[i + 1] === undefined || s[i + 1] === "/" || /\s/.test(s[i + 1])) { w.v += HOME(); continue; }
        w.dyn = true;
      }
      w.v += c;
    }
  }
  if (broken) return { items: [], broken: true };
  endCmd(";");
  return { items, broken: false };
}

// ---- 共通の補助 -------------------------------------------------------------

const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
// 対象のリポジトリ・設定を書き換えうる環境変数
const GIT_TARGET_ENV = /^(GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR|GIT_NAMESPACE|GIT_CONFIG[A-Z_]*|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_EXEC_PATH)=/;
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);
const WRAPPERS = new Set(["command", "exec", "time", "nohup", "env", "nice", "timeout", "sudo", "stdbuf", "ionice", "setsid"]);
const EXECUTORS = new Set(["xargs", "find", "parallel", "watch", "flock", "chroot", "su", "runuser", "script"]);
const KEYWORDS = new Set(["if", "then", "else", "elif", "while", "until", "do", "!", "{", "}", "time"]);
const SKIP_STARTS = new Set(["for", "case", "select", "fi", "done", "esac", "in"]);
const FILE_READ_LIMIT = 1 << 20;
const isGit = (v) => v === "git" || v.endsWith("/git");
// 変更操作を示す語（コマンド名が展開で決まる場合に、git の変更とみなす目印）
const MUTATING_WORDS = new Set(["push", "commit", "merge", "pull", "switch", "checkout", "branch", "rebase", "worktree", "cherry-pick", "api", "pr"]);
// git・gh を含むスクリプトの手がかり
const TOOLS_RE = /\b(git|gh)\b/;

const READ_ONLY = new Set([
  "status", "log", "diff", "show", "blame", "grep", "ls-files", "ls-tree", "ls-remote", "rev-parse", "rev-list", "describe", "shortlog", "cat-file",
  "for-each-ref", "show-ref", "name-rev", "merge-base", "fetch", "add", "rm", "mv", "restore", "stash", "clean", "apply", "format-patch", "archive",
  "bisect", "reflog", "gc", "prune", "fsck", "version", "help", "init", "clone", "submodule", "lfs", "tag", "notes", "sparse-checkout", "maintenance",
  "count-objects", "whatchanged", "var", "check-ignore", "check-ref-format", "show-branch", "cherry", "range-diff", "diff-tree", "diff-files", "diff-index",
  "hash-object", "write-tree", "mktree", "read-tree", "commit-tree", "reset", "update-ref", "symbolic-ref", "replace", "checkout-index", "update-index",
  "verify-commit", "verify-tag", "mergetool", "difftool", "gui", "citool", "instaweb", "remote", "config", "worktree", "branch", "switch", "checkout", "stripspace", "interpret-trailers", "column", "get-tar-commit-id", "pack-refs", "repack", "unpack-file", "rerere", "bugreport", "credential",
]);
// 現在のブランチ名や設定を変える操作（同じコマンドの後続の操作は、事前の状態で判定できない）
const dirtyAfterConfig = (sub, args) => {
  if (sub === "config") return !args.some((a) => /^(--get(-all|-regexp|-urlmatch|-color(bool)?)?|-l|--list|--show-origin|--show-scope|--name-only|--type=.*|--default=.*)$/.test(a));
  if (sub === "remote") return args[0] !== undefined && !["-v", "--verbose", "show", "get-url"].includes(args[0]);
  return ["symbolic-ref", "update-ref"].includes(sub) && args.length > 1;
};

// パスを解決する。dir が不明なら null
const resolvePath = (dir, p) => (dir === null ? null : resolve(dir, p));
// 作業ディレクトリが使えるか。戻り値: 存在する絶対パス、使えなければ null
const usableDir = (dir) => (dir !== null && existsSync(dir) ? dir : null);

const remoteList = (cwd) => (git(cwd, "remote") ?? "").split("\n").filter(Boolean);
const refExists = (cwd, ref) => git(cwd, "show-ref", "--verify", "--quiet", ref) !== null;
const localBranchExists = (cwd, name) => refExists(cwd, `refs/heads/${name}`);
const oidOf = (cwd, ref) => git(cwd, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
const currentBranchOf = (cwd) => git(cwd, "branch", "--show-current") || null;
const cfg = (cwd, key) => git(cwd, "config", "--get", key);
// from が to の祖先か（読み取りのみ）。終了コード 0 → true、1 → false、それ以外（失敗）→ null
function isAncestor(cwd, from, to) {
  const r = spawnSync("git", ["merge-base", "--is-ancestor", from, to], { cwd, stdio: "ignore" });
  if (r.error || r.status === null) return null;
  return r.status === 0 ? true : r.status === 1 ? false : null;
}
const cfgAll = (cwd, key) => (git(cwd, "config", "--get-all", key) ?? "").split("\n").filter(Boolean);

// 値を取るオプションを飛ばして、位置引数だけを集める。valueOpts は値を取るオプション名
function positionals(args, valueOpts = []) {
  const out = [];
  let rest = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (rest) out.push(a);
    else if (a === "--") rest = true;
    else if (valueOpts.includes(a)) i++;
    else if (!a.startsWith("-") || a === "-") out.push(a);
  }
  return out;
}
const hasFlag = (args, ...names) => args.some((a) => names.includes(a) || names.some((n) => n.startsWith("--") && a.startsWith(`${n}=`)));
const unsafeWord = (w) => w.dyn || w.glob; // 値が実行時まで決まらない語

// ---- リポジトリの状態 -------------------------------------------------------
// repoState: outside（リポジトリ外）| unmanaged（未導入）| managed（宣言あり）| setup-only（導入設定だけで宣言なし）| invalid（宣言が不正）| unknown（作業ディレクトリ不明）
function repoInfo(dir) {
  if (usableDir(dir) === null) return { root: null, repoState: "unknown" };
  const root = repoRoot(dir);
  if (!root) return { root: null, repoState: "outside" };
  const { config, error } = loadConfig(root);
  if (error) return { root, repoState: "invalid" };
  if (config) return { root, repoState: "managed" };
  return { root, repoState: enabledInRepo(root) ? "setup-only" : "unmanaged" };
}

// ---- 各操作の解釈 -----------------------------------------------------------

// push の refspec 1 つを解釈する。戻り値: { ref } か { reason }
function parseRefspec(cwd, spec, { forceAll, deleteAll }) {
  let force = forceAll;
  let s = spec;
  if (s.startsWith("+")) { force = true; s = s.slice(1); }
  if (s.includes("*")) return { reason: `refspec '${spec}' にワイルドカードが含まれ、更新先を確定できません。` };
  let src;
  let dst;
  let del = deleteAll;
  if (s.includes(":")) {
    const k = s.indexOf(":");
    src = s.slice(0, k);
    dst = s.slice(k + 1);
    if (src === "") del = true;
  } else { src = s; dst = null; }
  if (dst === null || dst === "") dst = del ? s.replace(/^:/, "") : src;
  if (!del && src === "HEAD" && (dst === "HEAD" || dst === null)) {
    const b = currentBranchOf(cwd);
    if (!b) return { reason: "detached HEAD のため push 先のブランチを確定できません。" };
    dst = b;
  }
  if (dst === "" || dst === "HEAD") return { reason: `refspec '${spec}' の更新先を確定できません。` };
  let refKind;
  let name = dst;
  if (dst.startsWith("refs/heads/")) { refKind = "branch"; name = dst.slice("refs/heads/".length); }
  else if (dst.startsWith("refs/tags/")) { refKind = "tag"; name = dst.slice("refs/tags/".length); }
  else if (dst.startsWith("refs/")) refKind = "other";
  else if (del) refKind = refExists(cwd, `refs/tags/${dst}`) && !localBranchExists(cwd, dst) ? "tag" : "branch";
  else if (src === "HEAD" || localBranchExists(cwd, src)) refKind = "branch";
  else if (refExists(cwd, `refs/tags/${src}`)) refKind = "tag";
  else return { reason: `'${src}' が既存のブランチやタグではなく、更新先を確定できません。` };
  if (refKind === "other") return { reason: `ブランチでもタグでもない ref '${dst}' への push は更新先を確定できません。`, ref: { src, dst: name, ref: dst, refKind, force, delete: del } };
  return { ref: { src: src || null, dst: name, ref: refKind === "tag" ? `refs/tags/${name}` : `refs/heads/${name}`, refKind, force, delete: del } };
}

const PUSH_VALUE_OPTS = ["--repo", "-o", "--push-option", "--receive-pack", "--exec", "--signed"];
const PUSH_SAFE_FLAGS = new Set(["-u", "--set-upstream", "-q", "--quiet", "-v", "--verbose", "--porcelain", "--progress", "--no-progress", "--no-verify", "--verify", "--thin", "--no-thin", "--atomic", "--no-atomic", "--follow-tags", "--no-follow-tags", "--no-signed", "--ipv4", "-4", "--ipv6", "-6", "--no-recurse-submodules", "--no-force-with-lease", "--no-force-if-includes", "--prune", "-n", "--dry-run"]);

function pushOp(args, cwd, add) {
  const flags = { force: false, delete: false, tags: false, bulk: false };
  const refs = [];
  const pos = [];
  let repoOpt = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { pos.push(...args.slice(i + 1)); break; }
    if (!a.startsWith("-") || a === "-") { pos.push(a); continue; }
    const [name, val] = a.startsWith("--") && a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, null];
    if (name === "--receive-pack" || name === "--exec") add("--receive-pack / --exec は任意のコマンドを実行しうるため、更新先を確定できません。");
    else if (name === "--repo") repoOpt = val ?? args[++i];
    else if (PUSH_VALUE_OPTS.includes(name)) { if (val === null) i++; }
    else if (name === "--force" || name === "-f" || name === "--force-with-lease" || name === "--force-if-includes") flags.force = true;
    else if (name === "--delete" || name === "-d") flags.delete = true;
    else if (name === "--tags" || name === "--follow-tags") flags.tags = true;
    else if (name === "--prune") flags.delete = true;
    else if (name === "--all" || name === "--mirror" || name === "--branches") { flags.bulk = true; add(`${name} は更新先のブランチを確定できません。`); }
    else if (name === "--recurse-submodules") { /* 値付きは対象外の安全なオプション */ }
    else if (/^-[a-zA-Z]{2,}$/.test(a) && [...a.slice(1)].every((ch) => "ufqvn".includes(ch))) { if (a.includes("f")) flags.force = true; }
    else if (!PUSH_SAFE_FLAGS.has(name)) add(`未対応の push オプション '${a}' があり、更新先を確定できません。`);
  }
  const dryRun = hasFlag(args, "-n", "--dry-run");
  // remote の特定
  const remotes = remoteList(cwd);
  const branch = currentBranchOf(cwd);
  let remote = null;
  let specs;
  if (repoOpt !== null) { remote = repoOpt; specs = pos; }
  else if (pos.length > 0) { remote = pos[0]; specs = pos.slice(1); }
  else {
    remote = (branch && cfg(cwd, `branch.${branch}.pushRemote`)) || cfg(cwd, "remote.pushDefault") || (branch && cfg(cwd, `branch.${branch}.remote`)) || "origin";
    specs = [];
  }
  let remoteUrl = null;
  if (!remotes.includes(remote)) {
    add(`push 先 '${remote}' は登録済みの remote ではなく（URL の直接指定など）、更新先を照合できません。`);
    remote = null;
  } else remoteUrl = git(cwd, "remote", "get-url", "--push", remote);
  // 送り先を省いた場合は、remote の push 設定 → push.default の順に決める
  let viaConfig = false;
  if (specs.length === 0 && !flags.bulk && !(flags.tags && !flags.delete)) {
    const conf = remote ? cfgAll(cwd, `remote.${remote}.push`) : [];
    if (conf.length) { specs = conf; viaConfig = true; }
    else {
      const mode = cfg(cwd, "push.default") ?? "simple";
      if (!branch) add("detached HEAD のため push 先のブランチを確定できません。");
      else if (["simple", "current"].includes(mode)) {
        const merge = cfg(cwd, `branch.${branch}.merge`);
        const trackRemote = cfg(cwd, `branch.${branch}.remote`);
        if (mode === "simple" && merge && trackRemote === remote && merge !== `refs/heads/${branch}`) add(`'${branch}' の追跡先 ${merge} と名前が異なり、送り先を確定できません。`);
        else specs = [`refs/heads/${branch}:refs/heads/${branch}`];
      } else if (mode === "upstream" || mode === "tracking") {
        const merge = cfg(cwd, `branch.${branch}.merge`);
        if (merge) specs = [`refs/heads/${branch}:${merge}`]; else add(`'${branch}' に追跡先が無く、送り先を確定できません。`);
      } else add(`push.default=${mode} では送り先のブランチを確定できません。`);
    }
  }
  for (const spec of specs) {
    const r = parseRefspec(cwd, spec, { forceAll: flags.force, deleteAll: flags.delete });
    if (r.reason) add(r.reason);
    if (r.ref) {
      refs.push(r.ref);
      if (r.ref.force) flags.force = true;
      if (r.ref.delete) flags.delete = true;
      if (r.ref.refKind === "tag") flags.tags = true;
    }
  }
  return { remote, remoteUrl, refs, flags, dryRun, viaConfig };
}

const MERGE_VALUE_OPTS = ["-m", "-F", "-s", "-X", "--into-name", "--strategy", "--strategy-option", "--file", "--message", "--cleanup"];
const PULL_VALUE_OPTS = ["-s", "-X", "--strategy", "--strategy-option", "-j", "--jobs", "--depth", "--deepen", "--shallow-since", "--shallow-exclude", "-o", "--upload-pack", "--negotiation-tip", "-S", "--gpg-sign", "--log", "-m", "-F", "--cleanup", "--into-name"];

// マージ元 1 つを解釈する
function mergeSource(cwd, name, remotes) {
  if (localBranchExists(cwd, name)) return { name, branch: name, remote: null, oid: oidOf(cwd, `refs/heads/${name}`) };
  const remote = remotes.filter((r) => name.startsWith(`${r}/`) && refExists(cwd, `refs/remotes/${name}`)).sort((a, b) => b.length - a.length)[0];
  if (remote) return { name, branch: name.slice(remote.length + 1), remote, oid: oidOf(cwd, `refs/remotes/${name}`) };
  const oid = oidOf(cwd, name);
  return { name, branch: null, remote: null, oid, reason: oid ? `'${name}' はブランチと確認できません（コミット指定）。` : `'${name}' を解決できません。` };
}

// git の真偽値の設定値を読む。真偽でなければ undefined
function parseBool(v) {
  const x = String(v).trim().toLowerCase();
  if (["true", "yes", "on", "1"].includes(x)) return true;
  if (["false", "no", "off", "0", ""].includes(x)) return false;
  return undefined;
}

// pull・merge の fast-forward 指定とリベースの実効値、その由来を取り出す。
// 引数（--ff-only・--ff・--no-ff、-r・--rebase[=値]・--no-rebase）は最後の指定を採り、無ければ設定を読む。
// 設定の値が読めないときは add で確定不能の理由を足す
function mergeFacts(sub, a, dir, branch, valueOpts, add) {
  let ffArg = null;
  let rebaseArg = null;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    if (x === "--") break;
    if (valueOpts.includes(x)) { i++; continue; }
    if (x === "--ff-only") ffArg = "only";
    else if (x === "--ff") ffArg = "allow";
    else if (x === "--no-ff") ffArg = "never";
    else if (sub === "pull") {
      if (x === "-r") rebaseArg = true;
      else if (x === "--rebase") rebaseArg = true;
      else if (x.startsWith("--rebase=")) {
        const v = x.slice("--rebase=".length);
        const b = parseBool(v);
        rebaseArg = b !== undefined ? b : ["merges", "interactive", "m", "i"].includes(v) ? true : (add(`--rebase=${v} の値を読めず、リベースになるか確定できません。`), true);
      } else if (x === "--no-rebase") rebaseArg = false;
    }
  }
  const configKeys = [];
  const basis = { ff: "default", rebase: "default", configKeys };
  let ff = "allow";
  if (ffArg !== null) { ff = ffArg; basis.ff = "arg"; }
  else {
    const keys = sub === "pull" ? ["pull.ff", "merge.ff"] : ["merge.ff"];
    for (const key of keys) {
      const v = cfg(dir, key);
      if (v === null) continue;
      const l = v.trim().toLowerCase();
      const b = parseBool(v);
      if (l === "only") ff = "only";
      else if (b === false) ff = "never";
      else if (b === true) ff = "allow";
      else { add(`設定 ${key}=${v} の値を読めず、fast-forward の指定を確定できません。`); continue; }
      basis.ff = "config";
      configKeys.push(key);
      break;
    }
  }
  let rebase = false;
  if (sub === "pull") {
    if (rebaseArg !== null) { rebase = rebaseArg; basis.rebase = "arg"; }
    else {
      const keys = [...(branch ? [`branch.${branch}.rebase`] : []), "pull.rebase"];
      for (const key of keys) {
        const v = cfg(dir, key);
        if (v === null) continue;
        const b = parseBool(v);
        if (b !== undefined) rebase = b;
        else if (["merges", "interactive", "m", "i"].includes(v.trim().toLowerCase())) rebase = true;
        else { add(`設定 ${key}=${v} の値を読めず、リベースになるか確定できません。`); continue; }
        basis.rebase = "config";
        configKeys.push(key);
        break;
      }
    }
  }
  return { ff, rebase, basis };
}

const SWITCH_VALUE = ["-c", "-C", "--create", "--force-create", "--orphan", "--conflict"];
const BRANCH_LIST_FLAGS = ["-l", "--list", "-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "--show-current", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--format", "--sort", "-i", "--ignore-case", "--column", "--no-column"];

// 現在のブランチを変える・作る操作の解釈。戻り値: { op fields } か null（照会）。
// start: 作成時の開始点（無ければ null）。branchOnly: `git branch <名前>` の形（切り替えない作成）
function createOp(sub, args, cwd, add) {
  const out = { action: "create", via: sub, branch: null, start: null, branchOnly: false };
  if (sub === "switch" || sub === "checkout") {
    const createFlag = ["-c", "-C", "--create", "--force-create", "-b", "-B", "--orphan"];
    const idx = args.findIndex((a) => createFlag.includes(a) || /^--(create|force-create|orphan)=/.test(a));
    if (sub === "checkout" && args.includes("--")) return null; // ファイルの復元
    if (sub === "checkout" && hasFlag(args, "-p", "--patch", "--ours", "--theirs")) return null;
    if (idx >= 0) {
      const a = args[idx];
      out.branch = a.includes("=") ? a.slice(a.indexOf("=") + 1) : args[idx + 1];
      out.action = "create";
      // 作成フラグとその値（`-c <名前>` の形の名前）を除いた位置引数の先頭が開始点。前後どちらに置かれても拾う
      const rest = a.includes("=") ? args.filter((_, i) => i !== idx) : args.filter((_, i) => i !== idx && i !== idx + 1);
      out.start = positionals(rest, SWITCH_VALUE)[0] ?? null;
      if (!out.branch) add("作成するブランチ名を確定できません。");
      return out;
    }
    if (sub === "switch" && hasFlag(args, "-d", "--detach")) return { detach: true };
    const pos = positionals(args, SWITCH_VALUE);
    if (pos.length === 0) return sub === "checkout" ? null : (add("切り替え先のブランチを確定できません。"), out);
    let target = pos[0];
    if (target === "-") {
      target = git(cwd, "rev-parse", "--abbrev-ref", "@{-1}");
      if (!target) { add("直前のブランチを確定できません。"); return out; }
    }
    if (sub === "checkout" && hasFlag(args, "--detach")) return { detach: true };
    // checkout <相手> <パス...> は、相手がコミット・ブランチならそこからのファイル復元（ブランチは切り替わらない）
    const isPath = (p) => existsSync(resolve(cwd, p)) || (git(cwd, "ls-files", "--", p) ?? "") !== "";
    if (sub === "checkout" && pos.length > 1) {
      if (oidOf(cwd, target) !== null || pos.every(isPath)) return null;
      add(`checkout の引数 '${pos.join(" ")}' がブランチ・コミット・ファイルのどれか確認できません。`);
      return out;
    }
    // --track / -t は、リモート追跡ブランチから同名のローカルブランチを作る
    if (hasFlag(args, "-t", "--track")) {
      const rem = remoteList(cwd).filter((r) => target.startsWith(`${r}/`) && refExists(cwd, `refs/remotes/${target}`)).sort((a, b) => b.length - a.length)[0];
      // 開始点は明示された追跡元（target）をそのまま入れる
      if (rem) { out.action = "create"; out.branch = target.slice(rem.length + 1); out.start = target; return out; }
      add(`--track の追跡元 '${target}' がリモート追跡ブランチと確認できません。`);
      out.branch = target;
      return out;
    }
    if (localBranchExists(cwd, target)) { out.action = "resume"; out.branch = target; return out; }
    // リモートにだけあるブランチの切り替えは、追跡ブランチの作成になる
    const remotes = remoteList(cwd).filter((r) => refExists(cwd, `refs/remotes/${r}/${target}`));
    if (remotes.length === 1 && sub === "switch") { out.action = "create"; out.branch = target; return out; }
    if (remotes.length === 1 && sub === "checkout") { out.action = "create"; out.branch = target; return out; }
    if (sub === "switch") { add(`切り替え先 '${target}' が既存のブランチと確認できません。`); out.branch = target; return out; }
    // checkout の相手がブランチでなければ、コミットへの切り替え・ファイルの復元のどちらかと確認できたときだけ通す
    if (oidOf(cwd, target) !== null) return { detach: true };
    if (isPath(target)) return null;
    add(`checkout の引数 '${target}' がブランチ・コミット・ファイルのどれか確認できません。`);
    return out;
  }
  if (sub === "branch") {
    if (hasFlag(args, "-d", "-D", "--delete")) return null;
    if (hasFlag(args, "-u", "--set-upstream-to", "--unset-upstream", "--edit-description")) return { configChange: true };
    const rename = hasFlag(args, "-m", "-M", "--move");
    const copy = hasFlag(args, "-c", "-C", "--copy");
    if (!rename && !copy && args.some((a) => BRANCH_LIST_FLAGS.includes(a) || BRANCH_LIST_FLAGS.some((f) => f.startsWith("--") && a.startsWith(`${f}=`)))) return null;
    const pos = positionals(args, ["--abbrev", "--color"]);
    if (pos.length === 0) {
      if (rename || copy) { out.action = rename ? "rename" : "copy"; out.branch = currentBranchOf(cwd); if (!out.branch) add("現在のブランチを確定できません。"); return { ...out, renameCurrent: true }; }
      return null;
    }
    out.branch = rename || copy ? pos[1] ?? pos[0] : pos[0];
    out.action = rename ? "rename" : copy ? "copy" : "create";
    if (out.action === "create") { out.start = pos[1] ?? null; out.branchOnly = true; }
    return out;
  }
  if (sub === "worktree") {
    if (args[0] !== "add") return null;
    const a = args.slice(1);
    const bIdx = a.findIndex((x) => x === "-b" || x === "-B");
    const pos = positionals(a, ["-b", "-B", "--reason"]);
    const path = pos[0];
    if (!path) { add("worktree の作成先を確定できません。"); return out; }
    out.path = resolvePath(cwd, path);
    if (bIdx >= 0) { out.branch = a[bIdx + 1]; out.action = "create"; out.start = pos[1] ?? null; }
    else if (hasFlag(a, "--detach")) return { detach: true, path: out.path };
    else if (pos[1]) {
      if (localBranchExists(cwd, pos[1])) { out.branch = pos[1]; out.action = "resume"; }
      else { out.branch = null; out.action = "create"; add(`'${pos[1]}' が既存のブランチと確認できません。`); }
    } else { out.branch = basename(path); out.action = "create"; }
    out.via = "worktree";
    return out;
  }
  return null;
}

// ---- コマンド全体の分類 ------------------------------------------------------

// 入れ子のスクリプト（bash -c・eval・$(...)・heredoc など）を分類する。
// 内側で変わったブランチの状態（dirty）と環境変数の汚染は、外側の後続の操作へ必ず引き継ぐ。
// withCwd が真（eval・source のように同じシェルで動くもの）のときだけ、cd の結果も外側へ戻す。
function classifyNested(script, ctx, depth, ops, withCwd = false) {
  const inner = { ...ctx };
  classifyScript(script, inner, depth + 1, ops);
  ctx.dirty = ctx.dirty || inner.dirty;
  ctx.envTainted = ctx.envTainted || inner.envTainted;
  ctx.ghTainted = ctx.ghTainted || inner.ghTainted;
  if (withCwd) ctx.cwd = inner.cwd;
}

// 作業ディレクトリ基準でファイルを読む。読めなければ null
function readScriptFile(ctx, word) {
  if (word.dyn || word.glob || ctx.cwd === null) return null;
  try {
    const text = readFileSync(resolve(ctx.cwd, word.v), "utf8");
    return text.length > FILE_READ_LIMIT ? null : text;
  } catch { return null; }
}

function classifyScript(script, ctx, depth, ops) {
  const { items, broken } = lex(script);
  if (broken) {
    ops.push(makeOp("unparseable", ctx.cwd, ["コマンドを解釈できません（引用符・括弧・heredoc が閉じていません）。"], { note: script.slice(0, 80) }));
    return;
  }
  const stack = [];
  for (let n = 0; n < items.length; n++) {
    const it = items[n];
    if (it.type === "open") { stack.push(ctx.cwd); continue; }
    if (it.type === "close") { if (stack.length) ctx.cwd = stack.pop(); continue; }
    // コマンド置換の中身
    for (const sub of it.subs) {
      if (depth >= MAX_DEPTH) { ops.push(makeOp("unparseable", ctx.cwd, ["コマンド置換の入れ子が深く、解釈できません。"], {})); continue; }
      classifyNested(sub, ctx, depth, ops);
    }
    let words = it.words.filter((w) => !w.redir);
    while (words.length && !words[0].dyn && KEYWORDS.has(words[0].v)) words = words.slice(1);
    // `function NAME { 本文` は定義部分（function と名前）だけを外し、`{` 以降の本文を分類する
    if (words.length && !words[0].dyn && words[0].v === "function") {
      words = words.slice(2);
      while (words.length && !words[0].dyn && KEYWORDS.has(words[0].v)) words = words.slice(1);
    }
    if (!words.length) continue;
    if (!words[0].dyn && SKIP_STARTS.has(words[0].v)) continue;
    // heredoc の本文は、シェルへ渡される場合だけコマンドとして見る
    const pipeline = [it];
    for (let k = n; items[k]?.type === "cmd" && items[k].sep === "|" && items[k + 1]?.type === "cmd"; k++) pipeline.push(items[k + 1]);
    const firstWordOf = (x) => x.words.filter((w) => !w.redir).find((w) => !ASSIGN.test(w.v))?.v ?? "";
    if (it.heredoc && pipeline.some((x) => SHELLS.has(firstWordOf(x)) || ["eval", "xargs", "source", "."].includes(firstWordOf(x)))) {
      if (depth >= MAX_DEPTH) ops.push(makeOp("unparseable", ctx.cwd, ["heredoc の入れ子が深く、解釈できません。"], {}));
      else classifyNested(it.heredoc, ctx, depth, ops);
    }
    const inPipe = n > 0 && items[n - 1].type === "cmd" && items[n - 1].sep === "|";
    // シェルへ渡る入力の手がかり: here-string・標準入力のファイル・パイプの前段
    const info = { inPipe, hereString: null, stdinFile: null, feeders: [] };
    for (let q = 0; q < it.words.length; q++) {
      const w = it.words[q];
      if (w.redir && /^\d*<<<$/.test(w.v)) info.hereString = it.words[q + 1] ?? { v: "", dyn: true };
      else if (w.redir && /^0?<$/.test(w.v)) info.stdinFile = it.words[q + 1] ?? { v: "", dyn: true };
    }
    for (let k = n - 1; items[k]?.type === "cmd" && items[k].sep === "|"; k--) info.feeders.push(items[k]);
    handleCommand(words, ctx, depth, ops, info);
  }
}

function handleCommand(words, ctx, depth, ops, info) {
  const inPipe = info.inPipe;
  // 先頭の環境変数代入
  let k = 0;
  const assigns = [];
  while (k < words.length && !words[k].dyn && ASSIGN.test(words[k].v)) assigns.push(words[k++].v);
  if (assigns.some((a) => GIT_TARGET_ENV.test(a)) && k === words.length) ctx.envTainted = true;
  if (assigns.some((a) => GH_TARGET_ENV.test(a)) && k === words.length) ctx.ghTainted = true;
  const rest = words.slice(k);
  if (!rest.length) return;
  const head = rest[0];
  const envTarget = assigns.some((a) => GIT_TARGET_ENV.test(a));
  if (head.dyn) {
    if (rest.slice(1).some((w) => MUTATING_WORDS.has(w.v))) ops.push(makeOp("unparseable", ctx.cwd, ["コマンド名が展開で決まり、git の変更操作かどうか確定できません。"], {}));
    return;
  }
  const name = head.v;
  if (name === "cd" || name === "pushd") {
    if (inPipe) return;
    const args = rest.slice(1).filter((w) => !["-L", "-P", "--", "-e", "-@"].includes(w.v));
    if (args.length === 0) ctx.cwd = HOME();
    else if (args.length > 1 || unsafeWord(args[0]) || args[0].v === "-") ctx.cwd = null;
    else ctx.cwd = resolvePath(ctx.cwd, args[0].v);
    return;
  }
  if (name === "popd") { ctx.cwd = null; return; }
  if (["export", "declare", "typeset", "readonly", "set", "unset"].includes(name)) {
    if (rest.slice(1).some((w) => GIT_TARGET_ENV.test(w.v) || /^(GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR)$/.test(w.v))) ctx.envTainted = true;
    if (rest.slice(1).some((w) => GH_TARGET_ENV.test(w.v) || /^(GH_REPO|GH_HOST)$/.test(w.v))) ctx.ghTainted = true;
    return;
  }
  if (isGit(name)) {
    ops.push(gitOp(rest.slice(1), ctx, assigns, envTarget));
    return;
  }
  if (isGh(name)) {
    pushGh(rest.slice(1), ctx, assigns, ops);
    return;
  }
  if (["curl", "wget"].includes(basename(name))) {
    const h = httpClientOperations(basename(name), rest.slice(1));
    if (h) for (const o of h) ops.push(finishOp(o, ctx.cwd));
    return;
  }
  const unparse = (why) => ops.push(makeOp("unparseable", ctx.cwd, [why], {}));
  const gitLike = (text) => TOOLS_RE.test(text);
  if (SHELLS.has(name)) {
    const cIdx = rest.findIndex((w, i) => i > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w.v));
    if (cIdx > 0 && rest[cIdx + 1]) {
      const script = rest[cIdx + 1];
      if (script.dyn || depth >= MAX_DEPTH) { if (TOOLS_RE.test(script.v) || script.dyn) unparse("シェルに渡すスクリプトが展開で決まり、解釈できません。"); return; }
      classifyNested(script.v, ctx, depth, ops);
      return;
    }
    // -c が無い: スクリプトファイル・標準入力（here-string・ファイル・パイプ）から読む
    const args = rest.slice(1);
    const stdinMode = args.some((w) => w.v === "-s" || w.v === "-");
    const scriptWord = stdinMode ? null : args.find((w) => !w.v.startsWith("-"));
    if (scriptWord) {
      const text = readScriptFile(ctx, scriptWord);
      if (text === null) unparse(`シェルスクリプト '${scriptWord.v}' の内容を確認できません。`);
      else if (gitLike(text)) unparse(`シェルスクリプト '${scriptWord.v}' が git を含み、実行内容を確定できません。`);
      return;
    }
    if (info.hereString) {
      if (info.hereString.dyn || depth >= MAX_DEPTH) unparse("here-string がシェルへ渡り、内容を確定できません。");
      else classifyNested(info.hereString.v, ctx, depth, ops);
    } else if (info.stdinFile) {
      const text = readScriptFile(ctx, info.stdinFile);
      if (text === null) unparse("標準入力のファイルの内容を確認できません。");
      else if (gitLike(text)) unparse("標準入力のスクリプトが git を含み、実行内容を確定できません。");
    } else if (inPipe) {
      // 前段が静的な echo・printf で git を含まないときだけ通す
      const plain = info.feeders.every((f) => {
        const ws = f.words.filter((w) => !w.redir);
        return ["echo", "printf"].includes(ws[0]?.v) && !f.subs.length && ws.every((w) => !w.dyn && !gitLike(w.v));
      });
      if (!plain) unparse("パイプでシェルへ渡る入力の内容を確定できません。");
    }
    return;
  }
  if (name === "source" || name === ".") {
    const file = rest[1];
    if (!file) return;
    const text = readScriptFile(ctx, file);
    if (text === null) unparse(`source するファイル '${file.v}' の内容を確認できません。`);
    else if (gitLike(text)) unparse(`source するファイル '${file.v}' が git を含み、実行内容を確定できません。`);
    return;
  }
  if (name === "eval") {
    if (rest.slice(1).some((w) => w.dyn) || depth >= MAX_DEPTH) { if (rest.slice(1).some((w) => w.dyn || TOOLS_RE.test(w.v))) unparse("eval の引数が展開で決まり、解釈できません。"); return; }
    classifyNested(rest.slice(1).map((w) => w.v).join(" "), ctx, depth, ops, true);
    return;
  }
  if (WRAPPERS.has(name)) {
    const gi = rest.findIndex((w, i) => i > 0 && (isGit(w.v) || isGh(w.v)));
    if (gi < 0) return;
    const viaGh = isGh(rest[gi].v);
    const between = rest.slice(1, gi);
    if (name === "env" && between.some((w) => ["-C", "--chdir", "-S", "--split-string"].includes(w.v))) {
      ops.push(makeOp("unparseable", ctx.cwd, ["env が作業ディレクトリを変えるため、対象を確定できません。"], {}));
      return;
    }
    if (between.some((w) => !(w.v.startsWith("-") || /^\d+(\.\d+)?[smhd]?$/.test(w.v) || ASSIGN.test(w.v)))) {
      ops.push(makeOp("unparseable", ctx.cwd, [`'${name}' 経由の ${viaGh ? "gh" : "git"} で、実行内容を確定できません。`], {}));
      return;
    }
    const extra = between.filter((w) => ASSIGN.test(w.v)).map((w) => w.v);
    if (viaGh) {
      pushGh(rest.slice(gi + 1), ctx, [...assigns, ...extra], ops);
      return;
    }
    ops.push(gitOp(rest.slice(gi + 1), ctx, [...assigns, ...extra], envTarget || extra.some((a) => GIT_TARGET_ENV.test(a))));
    return;
  }
  if (EXECUTORS.has(name) && rest.some((w, i) => i > 0 && (isGit(w.v) || isGh(w.v)))) {
    ops.push(makeOp("unparseable", ctx.cwd, [`'${name}' 経由の git・gh は、対象を確定できません。`], {}));
  }
}

// gh の操作を取り出して追加する
function pushGh(args, ctx, assigns, ops) {
  const c = { dir: ctx.cwd, assigns, tainted: !!ctx.ghTainted, markDirty: () => { ctx.dirty = true; }, markTainted: () => { ctx.ghTainted = true; } };
  for (const o of ghOperations(args, c)) ops.push(finishOp(o, ctx.cwd));
}

// github-operations.mjs の結果を操作オブジェクトにする。作業ディレクトリが使えない書き込みは対象を確定できない
function finishOp(o, dir) {
  const un = [...o.unresolved];
  if (o.kind !== "query" && usableDir(dir) === null) un.push(dir === null ? "作業ディレクトリを確定できません（cd や -C の先が展開・直前のディレクトリなど）。" : `作業ディレクトリ ${dir} が存在せず、対象を確定できません。`);
  return makeOp(o.kind, dir, un, o.fields);
}

// 操作オブジェクトを作る。unresolved は対象を確定できなかった理由
function makeOp(kind, dir, unresolved, fields) {
  const info = repoInfo(dir);
  return { kind, cwd: usableDir(dir), root: info.root, repoState: info.repoState, unresolved, ...fields };
}

function gitOp(args, ctx, assigns, envTarget) {
  const unresolved = [];
  const add = (r) => unresolved.push(r);
  let dir = ctx.cwd;
  let i = 0;
  if (envTarget) add("GIT_DIR・GIT_WORK_TREE などの環境変数で対象のリポジトリが変わりうるため、対象を確定できません。");
  if (ctx.envTainted) add("同じコマンドで GIT_DIR・GIT_WORK_TREE などを設定しており、対象を確定できません。");
  while (i < args.length && args[i].v.startsWith("-")) {
    const w = args[i];
    const v = w.v;
    if (v === "-C") {
      const next = args[i + 1];
      dir = next && !unsafeWord(next) ? resolvePath(dir, next.v) : null;
      i += 2;
    } else if (v === "-c") {
      const kv = args[i + 1]?.v ?? "";
      if (/^(remote|url|push|pull|fetch|branch|alias|core|include|init|checkout|receive|uploadpack|credential|http|protocol|safe|submodule|merge|rebase|worktree|filter|diff|hooks|extensions)[.=]|^include/i.test(kv) || args[i + 1]?.dyn) add(`-c ${kv.split("=")[0]} は送り先や挙動を変えうるため、対象を確定できません。`);
      i += 2;
    } else if (/^--(git-dir|work-tree|namespace|exec-path|super-prefix|config-env|attr-source)(=|$)/.test(v)) {
      add(`${v.split("=")[0]} が指定され、対象のリポジトリを確定できません。`);
      i += v.includes("=") ? 1 : 2;
    } else i++;
  }
  const subWord = args[i];
  const rest = args.slice(i + 1);
  if (!subWord) return makeOp("query", dir, unresolved, { subcommand: "" });
  if (subWord.dyn) return makeOp("unparseable", dir, [...unresolved, "git のサブコマンドが展開で決まり、確定できません。"], {});
  const sub = subWord.v;
  const a = rest.map((w) => w.v);
  const dynArgs = rest.some(unsafeWord);
  if (usableDir(dir) === null) {
    // 作業ディレクトリが不明か存在しない。照会以外は対象を確定できない
    const kind = kindOfUnknown(sub);
    return makeOp(kind, dir, [...unresolved, dir === null ? "作業ディレクトリを確定できません（cd や -C の先が展開・直前のディレクトリなど）。" : `作業ディレクトリ ${dir} が存在せず、対象を確定できません。`], { subcommand: sub });
  }
  const dirty = ctx.dirty;
  const needState = () => { if (dirty) add("同じコマンドの前の操作で現在のブランチや設定が変わるため、事前の状態では対象を確定できません。"); };
  let op;
  if (sub === "push") {
    needState();
    if (dynArgs) add("push の引数に展開・ワイルドカードが含まれ、更新先を確定できません。");
    const p = dynArgs ? { remote: null, remoteUrl: null, refs: [], flags: { force: false, delete: false, tags: false, bulk: false }, dryRun: false } : pushOp(a, dir, add);
    op = makeOp("push", dir, unresolved, { ...p, normal: false });
    op.normal = unresolved.length === 0 && !p.flags.force && !p.flags.delete && !p.flags.tags && !p.flags.bulk;
  } else if (sub === "commit" || ["rebase", "cherry-pick", "revert", "am"].includes(sub)) {
    if (sub === "commit" && hasFlag(a, "--dry-run")) return makeOp("query", dir, unresolved, { subcommand: sub });
    needState();
    const branch = currentBranchOf(dir);
    if (!branch) add("detached HEAD のため commit 先のブランチを確定できません。");
    if (sub === "rebase" && !hasFlag(a, "--abort", "--continue", "--skip", "--quit", "--edit-todo") && positionals(a, ["--onto", "-s", "--strategy", "-X", "--strategy-option", "-x", "--exec", "-C", "--whitespace"]).length > 1) add("rebase で別のブランチへ切り替わるため、対象を確定できません。");
    if (sub !== "commit" && dynArgs) add(`${sub} の引数に展開が含まれ、対象を確定できません。`);
    op = makeOp("commit", dir, unresolved, { branch, via: sub });
  } else if (sub === "merge" || sub === "pull") {
    needState();
    if (dynArgs) add(`${sub} の引数に展開・ワイルドカードが含まれ、取り込み元を確定できません。`);
    const branch = currentBranchOf(dir);
    if (!branch) add("detached HEAD のため取り込み先のブランチを確定できません。");
    const remotes = remoteList(dir);
    const sources = [];
    let mode = sub;
    const facts = mergeFacts(sub, a, dir, branch, sub === "merge" ? MERGE_VALUE_OPTS : PULL_VALUE_OPTS, add);
    if (sub === "merge") {
      if (hasFlag(a, "--abort", "--continue", "--quit")) mode = "control";
      else {
        if (hasFlag(a, "--squash")) mode = "squash";
        const pos = positionals(a, MERGE_VALUE_OPTS);
        if (!dynArgs) for (const name of pos) {
          const s = mergeSource(dir, name, remotes);
          if (s.reason) add(s.reason);
          sources.push({ name: s.name, branch: s.branch, remote: s.remote, oid: s.oid });
        }
        if (!dynArgs && pos.length === 0 && !hasFlag(a, "--abort")) {
          const m = branch && cfg(dir, `branch.${branch}.merge`);
          const rm = branch && cfg(dir, `branch.${branch}.remote`);
          if (m && rm) sources.push({ name: `${rm}/${m.replace(/^refs\/heads\//, "")}`, branch: m.replace(/^refs\/heads\//, ""), remote: rm, oid: null });
          else add("取り込み元が指定されておらず、追跡先も無いため確定できません。");
        }
      }
    } else if (!dynArgs) {
      const pos = positionals(a, PULL_VALUE_OPTS);
      if (facts.rebase) mode = "pull-rebase";
      const remote = pos[0] ?? (branch && cfg(dir, `branch.${branch}.remote`)) ?? "origin";
      if (pos[0] !== undefined && !remotes.includes(pos[0])) add(`pull 元 '${pos[0]}' は登録済みの remote ではありません。`);
      const specs = pos.slice(1);
      if (specs.length) for (const sp of specs) {
        const b = sp.replace(/^\+/, "").split(":")[0].replace(/^refs\/heads\//, "");
        // <元>:<先> の形は手元の別のブランチを更新しうるため、印を付ける
        sources.push({ name: `${remote}/${b}`, branch: b, remote, oid: null, ...(sp.includes(":") ? { refspecDst: true } : {}) });
      }
      else {
        const m = branch && cfg(dir, `branch.${branch}.merge`);
        if (m) sources.push({ name: `${remote}/${m.replace(/^refs\/heads\//, "")}`, branch: m.replace(/^refs\/heads\//, ""), remote, oid: null });
        else add("pull 元のブランチが指定されておらず、追跡先も無いため確定できません。");
      }
    }
    // merge で取り込み元が 1 つかつ ID が確定しているときだけ、先端が取り込み元の祖先かを読み取りで確かめる。それ以外（pull など）は確認不能（null）
    let fastForwardable = null;
    if (sub === "merge" && mode !== "control" && sources.length === 1 && sources[0].oid) {
      const tip = oidOf(dir, "HEAD");
      if (tip) fastForwardable = isAncestor(dir, tip, sources[0].oid);
    }
    op = makeOp("merge", dir, unresolved, { branch, sources, via: sub, mode, ff: facts.ff, rebase: facts.rebase, basis: facts.basis, fastForwardable });
  } else if (["switch", "checkout", "branch", "worktree"].includes(sub)) {
    if (dynArgs) add(`${sub} の引数に展開・ワイルドカードが含まれ、対象を確定できません。`);
    const c = dynArgs ? { action: "create", via: sub, branch: null, start: null, branchOnly: false } : createOp(sub, a, dir, add);
    if (c === null) op = makeOp("query", dir, unresolved, { subcommand: sub });
    else if (c.detach || c.configChange) {
      if (c.configChange || c.detach) ctx.dirty = true;
      op = makeOp("query", dir, unresolved, { subcommand: sub, ...(c.detach ? { detached: true } : {}) });
    } else {
      if (sub === "switch" || sub === "checkout" || c.renameCurrent || c.action === "rename") ctx.dirty = true;
      op = makeOp("create", dir, unresolved, c);
    }
    return op;
  } else if (sub === "fetch") {
    // fetch はローカルのブランチの先頭も動かせる（main:main など）。動かしうる形は照会として通さない
    const local = (dst) => { const d = dst.replace(/^\+/, ""); return d !== "" && (d.startsWith("refs/heads/") || !d.startsWith("refs/")); };
    if (dynArgs) add("fetch の引数に展開・ワイルドカードが含まれ、更新先を確定できません。");
    if (hasFlag(a, "--refmap")) add("fetch の --refmap で更新先が変わりうるため、確定できません。");
    const pos = positionals(a, ["--depth", "--deepen", "--shallow-since", "--shallow-exclude", "-j", "--jobs", "-o", "--server-option", "--upload-pack", "--negotiation-tip", "--filter", "--refmap", "--recurse-submodules"]);
    const specs = pos.slice(1).filter((x) => x.includes(":"));
    if (specs.some((x) => local(x.slice(x.indexOf(":") + 1)))) add("fetch の更新先がローカルのブランチになりえます（remote 追跡ブランチ以外）。");
    // refspec を省いた fetch は remote.<名前>.fetch の設定に従う
    if (pos.length <= 1) {
      const lines = (git(dir, "config", "--get-regexp", "^remote\\..*\\.fetch$") ?? "").split("\n");
      // 各行は「remote.<名前>.fetch <値>」。値の「:」以降（送り先）がローカルのブランチかを見る
      const dsts = lines.map((l) => l.slice(l.indexOf(" ") + 1)).filter((v) => v.includes(":")).map((v) => v.slice(v.indexOf(":") + 1));
      if (dsts.some(local)) add("remote.<名前>.fetch の設定がローカルのブランチを更新しうるため、確定できません。");
    }
    op = unresolved.length ? makeOp("unparseable", dir, unresolved, { subcommand: sub }) : makeOp("query", dir, unresolved, { subcommand: sub });
  } else if (READ_ONLY.has(sub)) {
    if (dirtyAfterConfig(sub, a)) ctx.dirty = true;
    op = makeOp("query", dir, unresolved, { subcommand: sub });
  } else if (cfg(dir, `alias.${sub}`) !== null) {
    op = makeOp("unparseable", dir, [...unresolved, `'${sub}' は git のエイリアスで、実行内容を確定できません。`], { subcommand: sub });
  } else {
    op = makeOp("unparseable", dir, [...unresolved, `未対応の git サブコマンド '${sub}' で、対象を確定できません。`], { subcommand: sub });
  }
  return op;
}

// 作業ディレクトリが使えないときの種類（対象は確定できない）
function kindOfUnknown(sub) {
  if (sub === "push") return "push";
  if (sub === "commit" || ["rebase", "cherry-pick", "revert", "am"].includes(sub)) return "commit";
  if (sub === "merge" || sub === "pull") return "merge";
  if (["switch", "checkout", "worktree"].includes(sub)) return sub === "worktree" ? "query" : "create";
  if (READ_ONLY.has(sub)) return "query";
  return "unparseable";
}

export function classifyCommand(command, cwd) {
  const operations = [];
  if (typeof command !== "string" || typeof cwd !== "string") {
    operations.push(makeOp("unparseable", null, ["コマンドまたは作業ディレクトリが文字列ではなく、解釈できません。"], {}));
  } else classifyScript(command, { cwd: resolve(cwd), dirty: false, envTainted: false, ghTainted: false }, 0, operations);
  return summarize(operations);
}

/**
 * MCP ツールの呼び出しを分類する（GitHub・Git 系の MCP の書き込みを識別する）。
 * scope: github（GitHub・Git 系）| other-mcp（識別できない MCP）| not-mcp（MCP 以外）。
 * other-mcp の操作は空で passes は真になる。導入検査（6.4）は scope から強制範囲外を報告できる。
 */
export function classifyMcpCall(toolName, toolInput, cwd) {
  const dir = typeof cwd === "string" ? resolve(cwd) : null;
  const r = mcpOperations(toolName, toolInput, dir);
  const operations = r.operations.map((o) => finishOp(o, dir));
  return { surface: "mcp", scope: r.scope, server: r.server, tool: r.tool, ...summarize(operations) };
}

function summarize(operations) {
  const changing = operations.filter((o) => o.kind !== "query");
  const needsJudgment = operations.filter((o) => o.kind !== "query" && !["outside", "unmanaged"].includes(o.repoState));
  const undetermined = needsJudgment.filter((o) => o.unresolved.length > 0);
  return { operations, compound: changing.length > 1, needsJudgment, undetermined, passes: needsJudgment.length === 0 };
}
