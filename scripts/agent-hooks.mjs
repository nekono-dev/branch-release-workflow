#!/usr/bin/env node
// Claude Code と Codex のフック応答（brw-enforcement 6.1）: ホストの入力を操作判定へ渡し、ホストの応答の形に変換する。
// 操作の分類は operation-policy.mjs、可否は operation-decision.mjs が決める。ここはホストの入出力の形と、確認省略の条件だけを扱う。
// 6.2（PostToolUse・Stop）と 6.3（フックの登録）には踏み込まない。外部依存なし（Node 標準ライブラリと内部モジュールのみ）。
//
// 内部の判定 verdict と、ホストへの応答:
//   deny   拒否。PreToolUse（両ホスト）と PermissionRequest（Codex）で拒否を返す。
//   ask    確認を求める。Claude の PreToolUse だけが ask を返す（Codex は返さず、ホストの承認に任せる）。
//   allow  確認を省略する。Claude の PreToolUse と、Codex の PermissionRequest だけが返す。Codex の PreToolUse は返さない。
//   pass   応答を返さない（ホストの通常の承認に任せる）。
// 確認省略は、単独の操作で、判定が適合かつ確認省略の対象のときに限る。信頼済み BRW の publish は計画の書き込みに限る。
//
// 実行ファイルとしても使える: `node scripts/agent-hooks.mjs <claude|codex> <イベント名>` が標準入力の JSON を読み、応答を標準出力へ書く。
import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "./lib.mjs";
import { classifyCommand, classifyMcpCall } from "./operation-policy.mjs";
import { evaluateAll } from "./operation-decision.mjs";
import { checkPlan, githubRepoOf, load, restrictionsOf, stateFileOf } from "./publish.mjs";

const PREFIX = "[branch-release-workflow] ";
/** ホストごとに扱うイベント。PostToolUse・Stop は 6.2 で扱う。 */
export const HOST_EVENTS = { claude: ["PreToolUse"], codex: ["PreToolUse", "PermissionRequest"] };
const BRW_CLI = join(dirname(fileURLToPath(import.meta.url)), "brw.mjs");
// 信頼済み BRW の CLI の実体（シンボリックリンクを解決した絶対パス）。読めなければ信頼できる呼び出しは無い
const BRW_CLI_REAL = (() => { try { return realpathSync(BRW_CLI); } catch { return null; } })();
const TOOLS_RE = /\b(git|gh)\b/;
const PASS = { verdict: "pass", reason: "", code: "" };
const PUBLISH_OPTS = ["--work", "--plan", "--title", "--body-file"];
const REF_LIST_FLAGS = ["-l", "--list", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at"];
const SHELL_CHARS = new Set([";", "&", "|", "(", ")", "<", ">", "`", "$", "\\", "\n", "\r", "*", "?", "[", "]", "{", "}", "~", "#"]);

/**
 * シェルの語に分ける。引用符の中の空白と記号は語の一部にする。展開・区切り・リダイレクトなど解釈しきれない記号があれば null。
 * 確認省略は、この分け方で語を確定できる単純なコマンドに限る（分類の対象とは別に、形の確認として使う）。
 */
export function scanWords(text) {
  const words = [];
  let cur = null;
  let q = null;
  for (const c of text) {
    if (q === "'") {
      if (c === "'") q = null;
      else cur += c;
      continue;
    }
    if (q === '"') {
      if (c === '"') q = null;
      else if (c === "$" || c === "`" || c === "\\") return null;
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      cur ??= "";
      continue;
    }
    if (c === " " || c === "\t") {
      if (cur !== null) {
        words.push(cur);
        cur = null;
      }
      continue;
    }
    if (SHELL_CHARS.has(c)) return null;
    cur = (cur ?? "") + c;
  }
  if (q) return null;
  if (cur !== null) words.push(cur);
  return words;
}

/** 先頭の `cd <dir> && ` を外す。ok が偽なら形が解釈できない。 */
function stripCd(command) {
  const m = /^\s*cd\s+(\S+)\s+&&\s+/.exec(command);
  if (!m) return { ok: true, dir: null, rest: command.trim() };
  const w = scanWords(m[1]);
  if (!w || w.length !== 1) return { ok: false, dir: null, rest: null };
  return { ok: true, dir: w[0], rest: command.slice(m[0].length).trim() };
}

/** 理由や応答に出す文字列。URL の資格情報・トークン様の値を伏せ、長さを制限する。 */
export function sanitize(text) {
  return String(text ?? "")
    .replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@]+@/g, "$1***@")
    .replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{8,}/g, "***")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

// ---- 信頼済み BRW の公開（publish） ----

const isTrustedCli = (path) => {
  if (!BRW_CLI_REAL) return false;
  try { return realpathSync(path) === BRW_CLI_REAL; } catch { return false; }
};

/** 件名の形（publish-pr.mjs の検査と同じ条件）。 */
const validTitle = (t) => typeof t === "string" && t.trim() !== "" && t.trim().length <= 256 && !/[\r\n\u0000]/.test(t);

/**
 * 本文ファイルを、作業ディレクトリ配下の通常ファイルに限って認める。
 * 絶対パス・`..`・配下の外を指すシンボリックリンク（realpath で確認）・デバイスやディレクトリは認めない。
 */
const bodyFileOk = (dir, f) => {
  if (f === "" || isAbsolute(f) || f.split(/[\\/]/).includes("..")) return false;
  try {
    const root = realpathSync(dir);
    const real = realpathSync(resolve(dir, f));
    return real.startsWith(root + sep) && statSync(real).isFile();
  } catch {
    return false;
  }
};

/**
 * 送り先のリモートが信頼できるか。origin の取得先と、origin と対象リモートの送信先の全件が、同じ GitHub リポジトリを指すこと。
 * git は送信先（pushurl）が複数あればすべてへ送るため、--all で全件を読み、1 件でも不一致・解釈不能・0 件なら信頼しない。
 * 読み取りのみ。確認省略しない側に倒す。
 */
const trustedRemote = (cwd, name) => {
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) return false;
  const fetchOrigin = githubRepoOf(git(cwd, "remote", "get-url", "origin"));
  if (!fetchOrigin) return false;
  const allPushUrls = (remote) => {
    const out = git(cwd, "remote", "get-url", "--push", "--all", remote);
    return out ? out.split("\n").map((u) => u.trim()).filter(Boolean) : [];
  };
  const targets = [...allPushUrls("origin"), ...allPushUrls(name)].map((u) => githubRepoOf(u));
  if (targets.length === 0 || targets.some((t) => t === null)) return false;
  const same = (x, y) => x.owner.toLowerCase() === y.owner.toLowerCase() && x.name.toLowerCase() === y.name.toLowerCase();
  return targets.every((t) => same(t, fetchOrigin));
};

/** 計画の書き込み 1 件の形が正しく、head と一致するか。 */
const validWrite = (headOid) => (w) => {
  if (w?.operation === "push") {
    return typeof w.remote === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(w.remote)
      && typeof w.ref === "string" && /^refs\/heads\/[A-Za-z0-9._/-]+$/.test(w.ref)
      && typeof w.oid === "string" && /^[0-9a-f]{40,64}$/.test(w.oid) && w.oid === headOid;
  }
  if (w?.operation === "pr") {
    return typeof w.base === "string" && typeof w.head === "string" && Number.isSafeInteger(w.repositoryId) && w.repositoryId > 0;
  }
  return false;
};

/**
 * コマンドが信頼済み BRW の publish の呼び出しか。
 * 戻り値: null（publish ではない）| { bad: true }（publish だが形が不正）| { bad: false, dir, workId, planId, title, bodyFile }
 */
function publishCall(command, cwd) {
  const cd = stripCd(command);
  if (!cd.ok) return null;
  const w = scanWords(cd.rest);
  if (!w || w[0] !== "node" || w[2] !== "publish") return null;
  const dir = cd.dir === null ? cwd : cwd === null ? null : resolve(cwd, cd.dir);
  if (dir === null || w[1] === undefined) return null;
  if (!isTrustedCli(resolve(dir, w[1]))) return null;
  const opts = {};
  for (let i = 3; i < w.length; i += 2) {
    const k = w[i];
    const v = w[i + 1];
    if (!PUBLISH_OPTS.includes(k) || v === undefined || opts[k] !== undefined) return { bad: true };
    opts[k] = v;
  }
  if (opts["--work"] === undefined || opts["--plan"] === undefined) return { bad: true };
  return { bad: false, dir, workId: opts["--work"], planId: opts["--plan"], title: opts["--title"], bodyFile: opts["--body-file"] };
}

/**
 * 信頼済み BRW の publish を判定する。計画を読み直し（読み取りのみ）、計画の全書き込みが確認省略の対象で、
 * 引数が計画と合うときだけ確認を省略する。計画が失効・形が不正・引数が足りない場合は応答を返さない。
 */
function decidePublish(p) {
  if (p.bad) return PASS;
  const r = checkPlan(p.dir, p.workId, p.planId);
  if (!r.ok || !r.plan) return PASS;
  const writes = r.plan.writes;
  if (!Array.isArray(writes) || writes.length === 0) return PASS;
  if (!writes.every(validWrite(r.plan.headOid))) return PASS;
  // 新規の PR は件名が要る。件名が無い・不正なら作成前に止まるので、確認は省略しない
  if (writes.some((w) => w.operation === "pr") && !validTitle(p.title)) return PASS;
  if (p.bodyFile !== undefined && !bodyFileOk(p.dir, p.bodyFile)) return PASS;
  const kinds = writes.map((w) => (w.operation === "push" ? "push" : "PR 作成")).join("・");
  return { verdict: "allow", reason: `信頼済み BRW の公開計画（${r.plan.planId}）に従う ${kinds} です。計画の書き込みだけを行います。`, code: "publish-plan" };
}

// ---- 参照を動かす操作（2.3 申し送り (c)） ----

/** git の 1 操作が、ブランチ・タグ・HEAD の参照を動かしうるか（照会は含めない）。 */
function refMovingGit(sub, args) {
  const has = (...names) => args.some((a) => names.includes(a));
  const positional = args.filter((a) => !a.startsWith("-"));
  switch (sub) {
    case "update-ref":
    case "reset":
      return true;
    case "symbolic-ref":
      return has("-d", "--delete") || positional.length >= 2;
    case "tag":
      if (has("-l", "--list")) return false;
      return has("-d", "--delete", "-a", "--annotate", "-s", "-u", "-f", "--force", "-m", "-F", "--sign") || positional.length > 0;
    case "branch":
      return has("-d", "-D", "--delete", "-m", "-M", "--move", "-c", "-C", "--copy", "-f", "--force", "-u", "--set-upstream-to", "--unset-upstream")
        || (positional.length > 0 && !has(...REF_LIST_FLAGS));
    default:
      return false;
  }
}

/** コマンドに参照を動かす git 操作が含まれるか。解釈できない区切りは空白で分けて見る。 */
function refMovingIn(command) {
  for (const seg of command.split(/&&|\|\||;|\||\n/)) {
    const w = scanWords(seg.trim()) ?? seg.trim().split(/\s+/);
    const gi = w.indexOf("git");
    if (gi < 0) continue;
    let i = gi + 1;
    while (i < w.length && w[i].startsWith("-")) i += w[i] === "-C" || w[i] === "-c" ? 2 : 1;
    if (w[i] !== undefined && refMovingGit(w[i], w.slice(i + 1))) return true;
  }
  return false;
}

// ---- 単独の操作であることの確認 ----

/**
 * 確認省略してよい形か。単独の git・gh の操作（先頭の cd を除く）で、語に分けられ、他の操作・認識外の記号を含まない。
 */
function plainOperation(command, cls) {
  if (cls.operations.length !== 1) return false;
  const cd = stripCd(command);
  if (!cd.ok) return false;
  const w = scanWords(cd.rest);
  return !!w && (w[0] === "git" || w[0] === "gh");
}

/** 作業の禁止。現在の作業（状態の current）の記録を使う。状態が読めなければ禁止ありとして扱う（安全側）。 */
function restrictionsFor(cwd) {
  if (!cwd) return {};
  const file = stateFileOf(cwd);
  if (!file) return {};
  const { state, error } = load(file);
  if (error) return { noPush: true, noPr: true };
  const w = state.works?.[state.current];
  return w ? restrictionsOf(w) : {};
}

const decisionOf = (d) => ({ verdict: "deny", reason: [d.reason, d.alternative].filter(Boolean).join(" "), code: d.code });

/** Bash の入力を判定する。 */
function judgeBash(command, cwd) {
  const pub = publishCall(command, cwd);
  if (pub) return decidePublish(pub);
  const cls = classifyCommand(command, cwd);
  const d = evaluateAll(cls, restrictionsFor(cwd));
  if (d.verdict === "deny") return decisionOf(d);
  if (cls.operations.some((o) => o.repoState === "managed") && refMovingIn(command))
    return { verdict: "ask", reason: "ブランチや参照を直接動かす操作のため、利用者の確認を求めます。BRW の手順（brw create・brw resume など）を優先してください。", code: "ref-moving" };
  // 送り先（別のリモートを含む）が信頼できない push は、確認省略しない（通常の承認に任せる）
  const pushesTrusted = cls.operations.every((o) => o.kind !== "push" || trustedRemote(o.cwd, o.remote));
  if (d.verdict === "eligibleForApproval" && plainOperation(command, cls) && pushesTrusted)
    return { verdict: "allow", reason: `${d.reason}`, code: d.code };
  return PASS;
}

/** ホストの入力（オブジェクトまたは JSON 文字列）を判定する。判定できない入力は PASS（確認省略しない）。 */
export function decideHook(host, event, input) {
  try {
    if (!HOST_EVENTS[host]?.includes(event) || (event !== "PreToolUse" && event !== "PermissionRequest")) return PASS;
    let ev = input;
    if (typeof input === "string") {
      try { ev = JSON.parse(input); } catch { return PASS; }
    }
    if (!ev || typeof ev !== "object" || Array.isArray(ev)) return PASS;
    const tool = ev.tool_name;
    const ti = ev.tool_input;
    const cwd = typeof ev.cwd === "string" && ev.cwd !== "" ? ev.cwd : null;
    if (tool === "Bash") {
      if (!ti || typeof ti.command !== "string") return PASS;
      // 作業ディレクトリが不明でも、git・gh を含まないコマンドは対象外
      if (cwd === null && !TOOLS_RE.test(ti.command)) return PASS;
      return judgeBash(ti.command, cwd);
    }
    if (typeof tool === "string" && tool.startsWith("mcp__")) {
      // MCP の書き込みは拒否だけを返す。確認省略は、公開計画を経た Bash の publish に限る
      const d = evaluateAll(classifyMcpCall(tool, ti ?? {}, cwd), restrictionsFor(cwd));
      return d.verdict === "deny" ? decisionOf(d) : PASS;
    }
    return PASS;
  } catch {
    // 判定の途中で例外が起きたら、Git・GitHub の操作だけは止める（安全側）
    return TOOLS_RE.test(typeof input === "string" ? input : JSON.stringify(input ?? "")) ? { verdict: "deny", reason: "フックの判定で内部エラーが起きたため、操作を止めます。", code: "internal-error" } : PASS;
  }
}

/**
 * 判定をホストの応答の形にする。応答を返さないときは null。
 * PermissionRequest の応答は decision.behavior（allow・deny）。PreToolUse は permissionDecision（deny・Claude は allow・ask）。
 */
export function responseOf(host, event, d) {
  if (!d || d.verdict === "pass") return null;
  const reason = PREFIX + sanitize(d.reason);
  if (event === "PermissionRequest") {
    if (d.verdict === "deny") return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: reason } } };
    if (d.verdict === "allow") return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } };
    return null;
  }
  if (d.verdict === "deny") return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
  if (host === "claude" && (d.verdict === "allow" || d.verdict === "ask")) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: d.verdict, permissionDecisionReason: reason } };
  return null;
}

/** ホストのイベントを処理し、応答（オブジェクトまたは null）を返す。 */
export function handleHook(host, event, input) {
  return responseOf(host, event, decideHook(host, event, input));
}

/** 標準入力の文字列を処理し、標準出力へ書く文字列を返す（応答が無ければ空文字）。 */
export function runHook(host, event, text) {
  const r = handleHook(host, event, text);
  return r ? JSON.stringify(r) : "";
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
if (isMain) {
  let text = "";
  for await (const c of process.stdin) text += c;
  const out = runHook(process.argv[2], process.argv[3], text);
  if (out) process.stdout.write(out);
}
