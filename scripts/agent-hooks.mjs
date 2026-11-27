#!/usr/bin/env node
// Claude Code と Codex のフック応答（brw-enforcement 6.1）: ホストの入力を操作判定へ渡し、ホストの応答の形に変換する。
// 操作の分類は operation-policy.mjs、可否は operation-decision.mjs が決める。ここはホストの入出力の形と、確認省略の条件だけを扱う。
// 6.2（PostToolUse・Stop）では、作業 ID の関連付けと終了時の案内を扱う。6.3（フックの登録）には踏み込まない。外部依存なし（Node 標準ライブラリと内部モジュールのみ）。
//
// 内部の判定 verdict と、ホストへの応答:
//   deny   拒否。PreToolUse（両ホスト）と PermissionRequest（Codex）で拒否を返す。
//   ask    確認を求める。Claude の PreToolUse だけが ask を返す（Codex は返さず、ホストの承認に任せる）。
//   allow  確認を省略する。Claude の PreToolUse と、Codex の PermissionRequest だけが返す。Codex の PreToolUse は返さない。
//   pass   応答を返さない（ホストの通常の承認に任せる）。
// 確認省略は、単独の操作で、判定が適合かつ確認省略の対象のときに限る。信頼済み BRW の publish は計画の書き込みに限る。
// PostToolUse は応答を返さず、成功した信頼済みの `brw work start|resume` の作業 ID をセッションに関連付ける（書き込みはここだけ）。
// Stop は読み取りだけで、準備済みで未公開の作業があるときに、同じ作業 ID での再試行か中断を block の応答で案内する。
//
// 実行ファイルとしても使える: `node scripts/agent-hooks.mjs <claude|codex> <イベント名>` が標準入力の JSON を読み、応答を標準出力へ書く。
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { BRW_RUN } from "./brw-cmd.mjs";
import { gatherFacts, guidance, judgeEnterWorktree, planGate, shellQuote } from "./branch-gate.mjs";
import { autoApproveOf, configMatchesHead, git, loadConfig, redactSecrets, repoRoot, sanitize } from "./lib.mjs";
import { classifyCommand, classifyMcpCall, lex } from "./operation-policy.mjs";
import { evaluateAll } from "./operation-decision.mjs";
import { attachSession, checkPlan, githubRepoOf, load, restrictionsOf, stateFileOf } from "./publish.mjs";
import { declaredNoPushOf, remainderGuidance, remaindersOf } from "./work-remainder.mjs";

const PREFIX = "[branch-release-workflow] ";
/** ホストごとに扱うイベント。PostToolUse（関連付け）と Stop（案内）は 6.2 で扱う。 */
export const HOST_EVENTS = { claude: ["PreToolUse", "PostToolUse", "Stop"], codex: ["PreToolUse", "PostToolUse", "PermissionRequest", "Stop"] };
const BRW_CLI = join(dirname(fileURLToPath(import.meta.url)), "brw.mjs");
// 信頼済み BRW の CLI の実体（シンボリックリンクを解決した絶対パス）。読めなければ信頼できる呼び出しは無い
const BRW_CLI_REAL = (() => { try { return realpathSync(BRW_CLI); } catch { return null; } })();
const TOOLS_RE = /\b(git|gh)\b/;
const PASS = { verdict: "pass", reason: "", code: "" };
const PUBLISH_OPTS = ["--work", "--plan", "--title", "--body-file"];
// ---- 信頼済み BRW の pr-merge の検出（エージェントの実行を実行前に拒否する） ----
// 字句解析（lex）の語・連結・コマンド置換・heredoc を追い、ラッパー（env・timeout・sudo など）と node のオプションを読み飛ばして、
// 実行ファイルが信頼済みの BRW で次の語が pr-merge のものを探す。入れ子（bash -c・eval・$(…)・heredoc）は深さ上限まで再帰する。
const PM_MAX_DEPTH = 4;
const PM_KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "!", "{", "}"]);
const PM_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const PM_SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);
const PM_WRAPPERS = new Set(["env", "command", "exec", "nice", "time", "nohup", "timeout", "sudo", "stdbuf", "ionice", "setsid", "xargs"]);
// 次の語を値として取るオプション（値の語を読み飛ばす）。env の -C と -S は個別に扱う
const PM_VALUE_OPTS = {
  env: ["-u", "--unset"],
  exec: ["-a"],
  nice: ["-n", "--adjustment"],
  timeout: ["-s", "--signal", "-k", "--kill-after"],
  sudo: ["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-T", "-U"],
  stdbuf: ["-i", "-o", "-e"],
  ionice: ["-c", "-n", "-p", "-P", "-u"],
  xargs: ["-I", "-n", "-P", "-L", "-d", "-s", "-a", "-E"],
  time: ["-f", "-o"],
};
// node の値を取るオプション（次の語を読み飛ばす）。-e・-p（コードを直接実行）は実行ファイルではないため対象外
const NODE_VALUE_OPTS = ["-r", "--require", "--import", "--loader", "--experimental-loader", "--conditions", "-C", "--input-type", "--env-file"];
const NODE_CODE_OPTS = ["-e", "--eval", "-p", "--print"];
// エージェントが brw pr-merge を実行しようとしたときの拒否（利用者の端末で実行するコマンドのため）。実行する形は末尾に置く
export function prMergeReason(run = BRW_RUN) {
  return `brw pr-merge は利用者が自分の端末で実行するコマンドです。エージェントは実行できません。分岐元向けの PR のマージは、利用者に別の端末で brw pr-merge <番号> の実行を依頼してください（保護ブランチ向けは GitHub 上でマージ）。（実行する形: ${run} pr-merge <番号>）`;
}
const PR_MERGE_REASON = prMergeReason();
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

// sanitize は scripts/lib.mjs に置く（branch-gate.mjs と共有し、循環 import を避ける）。ここからも従来どおり参照できる。
export { sanitize };

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
  if (f === "" || f.includes("\0") || f.split(/[\\/]/).includes("..")) return false;
  try {
    // 絶対パスは、本体の worktree 置き場（.claude/worktrees/.brw/）の配下だけ。相対パスは作業ディレクトリの配下
    let root;
    if (isAbsolute(f)) {
      const main = (git(dir, "worktree", "list", "--porcelain") ?? "").match(/^worktree (.+)$/m)?.[1];
      if (!main) return false;
      root = realpathSync(join(main, ".claude", "worktrees", ".brw"));
    } else root = realpathSync(dir);
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

const PR_VALUED = ["--title", "--body-file", "--completion", "--verification", "--target", "--work"];

/**
 * コマンドが信頼済み BRW の `pr` の呼び出しか（`node <brw.mjs の実体> pr` と、既知のオプション・値だけ。--confirmed は含めない）。
 * 戻り値: null（pr ではない・信頼できない）| { bad: true } | { bad: false, dir, bodyFile }
 */
function prCall(command, cwd) {
  const cd = stripCd(command);
  if (!cd.ok) return null;
  const w = scanWords(cd.rest);
  if (!w || w[0] !== "node" || w[2] !== "pr") return null;
  const dir = cd.dir === null ? cwd : cwd === null ? null : resolve(cwd, cd.dir);
  if (dir === null || w[1] === undefined) return null;
  if (!isTrustedCli(resolve(dir, w[1]))) return null;
  const opts = {};
  for (let i = 3; i < w.length; i++) {
    const k = w[i];
    if (k === "--failed") { if (opts[k] !== undefined) return { bad: true }; opts[k] = true; continue; }
    const v = w[i + 1];
    // 値は次の語。`--` で始まる語は値にしない（CLI の引数の検査と同じ）
    if (!PR_VALUED.includes(k) || v === undefined || v.startsWith("--") || opts[k] !== undefined) return { bad: true };
    opts[k] = v;
    i++;
  }
  return { bad: false, dir, bodyFile: opts["--body-file"] };
}

/**
 * コマンドが信頼済み BRW の pr-merge を実行する形を含むか（引数の有無・内容を問わない）。
 * 引用符の内側の区切り（; や &&）は区切りにしない。コマンド置換・バッククォート・heredoc の中身は、同じ作業ディレクトリで再帰して見る。
 */
function prMergeCall(command, cwd) {
  return prMergeIn(command, cwd ?? null, 0);
}

/** 1 つのスクリプトを、コマンドごとに見る。cd は後続のコマンドの作業ディレクトリに反映する（括弧の中は括弧の後で戻す）。 */
function prMergeIn(script, dir, depth) {
  // 深すぎる入れ子は解釈しない。pr-merge の語を含むなら、実行されうるとみなして止める
  if (depth > PM_MAX_DEPTH) return /pr-merge/.test(script);
  const { items, broken } = lex(script);
  // 構文として閉じていない形はシェルが実行しない
  if (broken) return false;
  let cur = dir;
  const stack = [];
  for (let n = 0; n < items.length; n++) {
    const it = items[n];
    if (it.type === "open") { stack.push(cur); continue; }
    if (it.type === "close") { if (stack.length) cur = stack.pop(); continue; }
    for (const sub of it.subs) if (prMergeIn(sub, cur, depth + 1)) return true;
    const ws = it.words.filter((w) => !w.redir);
    // heredoc の本文は、シェルへ渡る場合（そのコマンドがシェル、またはパイプの先がシェル）だけコマンドとして見る
    if (it.heredoc && pmFeedsShell(items, n, ws)) {
      if (prMergeIn(it.heredoc, cur, depth + 1)) return true;
    } else if (it.heredoc && it.heredocQuoted.includes(false)) {
      // 引用符なしの本文は、受け取るコマンドが何であっても $(…) とバッククォートが実行される
      for (const s of pmHeredocSubs(it.heredoc)) if (prMergeIn(s, cur, depth + 1)) return true;
    }
    const j = pmCommandStart(ws);
    if (j >= 0 && !ws[j].dyn && ws[j].v === "cd") { cur = pmCdTarget(ws.slice(j + 1), cur); continue; }
    if (pmRun(ws, cur, depth)) return true;
  }
  return false;
}

/**
 * 引用符なし heredoc の本文から、コマンド置換（$(…) とバッククォート）の中身を取り出す。本文全体は解析しない（文字列として読むだけ）。
 * $(…) は括弧の入れ子を数えて閉じを探し、中身の入れ子は中身を再帰して見るときに取り出される。\ で始まる字は読み飛ばす。
 */
function pmHeredocSubs(body) {
  const out = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "\\") { i++; continue; }
    if (c === "$" && body[i + 1] === "(") {
      let d = 1;
      let j = i + 2;
      for (; j < body.length && d > 0; j++) {
        if (body[j] === "\\") { j++; continue; }
        if (body[j] === "(") d++;
        else if (body[j] === ")") d--;
      }
      // 閉じが無ければ、残りを中身とみなす（解釈できない形は通さないように、中身を再帰して見る）
      out.push(d === 0 ? body.slice(i + 2, j - 1) : body.slice(i + 2));
      i = j - 1;
      continue;
    }
    if (c === "`") {
      const j = body.indexOf("`", i + 1);
      if (j < 0) break;
      out.push(body.slice(i + 1, j));
      i = j;
    }
  }
  return out;
}

/**
 * heredoc を持つコマンド（items[n]・語 ws）の入力がシェルに渡るか。
 * 自身がシェル（bash <<EOF・sh -s <<EOF）、または後続のパイプの先がシェル（cat <<EOF | bash）なら真。
 * operation-policy.mjs の classifyScript と同じ条件（シェル・eval・xargs・source・.）。
 */
function pmFeedsShell(items, n, ws) {
  const consumer = (w) => w !== undefined && !w.dyn && ["eval", "xargs", "source", "."].concat([...PM_SHELLS]).includes(basename(w.v));
  const j = pmCommandStart(ws);
  if (j >= 0 && consumer(ws[j])) return true;
  for (let k = n; items[k]?.type === "cmd" && items[k].sep === "|" && items[k + 1]?.type === "cmd"; k++) {
    const ws2 = items[k + 1].words.filter((w) => !w.redir);
    const s = pmCommandStart(ws2);
    if (s >= 0 && consumer(ws2[s])) return true;
  }
  return false;
}

/** 予約語と代入（FOO=値）を読み飛ばした、コマンド名の位置。無ければ -1。代入は値が展開でも代入として読む。 */
function pmCommandStart(ws) {
  let j = 0;
  while (j < ws.length && ((!ws[j].dyn && PM_KEYWORDS.has(ws[j].v)) || PM_ASSIGN.test(ws[j].v))) j++;
  return j < ws.length ? j : -1;
}

/** cd の引数から、移動先の作業ディレクトリを得る。解釈できなければ null（以降の相対パスは信頼できない扱い）。 */
function pmCdTarget(args, dir) {
  if (args.length === 0) return process.env.HOME ?? null;
  if (args.length !== 1 || args[0].dyn || args[0].glob || args[0].v.startsWith("-")) return null;
  return pmJoinDir(dir, args[0].v);
}

/** 作業ディレクトリに相対パスを足す。基準が不明（null）なら絶対パス以外は解決できない。 */
function pmJoinDir(dir, p) {
  if (isAbsolute(p)) return resolve(p);
  return dir === null ? null : resolve(dir, p);
}

/** 1 つのコマンド（予約語・代入を除いた語）を見る。信頼済みの pr-merge なら true。 */
function pmRun(ws, dir, depth) {
  let i = pmCommandStart(ws);
  if (i < 0) return false;
  while (i < ws.length) {
    const w = ws[i];
    if (w.dyn) return false; // コマンド名が展開で決まる形は確かめられない
    const name = basename(w.v);
    if (PM_WRAPPERS.has(name)) {
      const r = pmWrapper(name, ws, i + 1, dir, depth);
      if (r.hit) return true;
      if (r.at < 0) return false;
      i = r.at;
      dir = r.dir;
      continue;
    }
    if (PM_SHELLS.has(name)) return pmShellScript(ws, i, dir, depth);
    if (name === "eval") {
      const args = ws.slice(i + 1);
      if (args.some((x) => x.dyn)) return false;
      return prMergeIn(args.map((x) => x.v).join(" "), dir, depth + 1);
    }
    if (name === "node") return pmNode(ws, i, dir);
    return false;
  }
  return false;
}

/**
 * シェルの -c のスクリプトを再帰して見る。-c は最初のスクリプト名（- で始まらない位置引数）より前のオプションに限る。
 * それより後の -c は、そのスクリプトの引数（bash script.sh -c … は -c を読まない）。ファイルや標準入力の内容は読まない。
 */
function pmShellScript(ws, i, dir, depth) {
  let k = i + 1;
  while (k < ws.length) {
    const x = ws[k];
    if (x.dyn) return false;
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(x.v)) {
      const s = ws[k + 1];
      return s !== undefined && !s.dyn && prMergeIn(s.v, dir, depth + 1);
    }
    // 値を取るシェルのオプション（-o pipefail・+o・--rcfile ファイル など）は値を読み飛ばす
    if (["-o", "+o", "--rcfile", "--init-file"].includes(x.v)) { k += 2; continue; }
    if (x.v.startsWith("-") || x.v.startsWith("+")) { k++; continue; }
    return false;
  }
  return false;
}

/** node の実行。オプションを読み飛ばして最初の語を実行ファイルとし、その次の語が pr-merge で、実行ファイルが信頼済みの BRW なら true。 */
function pmNode(ws, i, dir) {
  let k = i + 1;
  while (k < ws.length) {
    const x = ws[k];
    if (x.dyn) return false;
    if (NODE_CODE_OPTS.includes(x.v) || /^--(eval|print)=/.test(x.v)) return false;
    if (NODE_VALUE_OPTS.includes(x.v)) { k += 2; continue; }
    if (x.v.startsWith("-") && x.v !== "-") { k++; continue; }
    break;
  }
  const s = ws[k];
  if (!s || s.dyn || ws[k + 1] === undefined || ws[k + 1].dyn || ws[k + 1].v !== "pr-merge") return false;
  const abs = pmJoinDir(dir, s.v);
  return abs !== null && isTrustedCli(abs);
}

/**
 * ラッパー（env・timeout・sudo など）の後ろを読み飛ばし、実際に実行されるコマンドの位置を得る。
 * 戻り値: { hit: 真なら信頼済みの pr-merge を見つけた, at: 次のコマンドの位置（-1 は無し）, dir: 作業ディレクトリ（env -C で変わる） }
 */
function pmWrapper(name, ws, i, dir, depth) {
  const vals = PM_VALUE_OPTS[name] ?? [];
  let duration = name === "timeout"; // timeout の最初の位置の語は時間
  let k = i;
  while (k < ws.length) {
    const x = ws[k];
    if (x.dyn) return { hit: false, at: -1, dir };
    const v = x.v;
    if (name === "env") {
      // env -S（文字列を分割して実行）は、その文字列をスクリプトとして見る
      const sm = /^-S(.+)$/.exec(v) ?? /^--split-string=(.*)$/.exec(v);
      if (sm) return { hit: prMergeIn(sm[1], dir, depth + 1), at: -1, dir };
      if (v === "-S" || v === "--split-string") {
        const t = ws[k + 1];
        if (t === undefined || t.dyn) return { hit: false, at: -1, dir };
        return { hit: prMergeIn(t.v, dir, depth + 1), at: -1, dir };
      }
      // env -C（作業ディレクトリを変える）は、後続の実行の作業ディレクトリになる
      const cm = /^-C(.+)$/.exec(v) ?? /^--chdir=(.*)$/.exec(v);
      if (cm || v === "-C" || v === "--chdir") {
        const t = cm ? undefined : ws[k + 1];
        if (!cm && (t === undefined || t.dyn)) return { hit: false, at: -1, dir: null };
        dir = pmJoinDir(dir, cm ? cm[1] : t.v);
        k += cm ? 1 : 2;
        continue;
      }
    }
    if (PM_ASSIGN.test(v)) { k++; continue; }
    if (vals.includes(v)) { k += 2; continue; }
    if (v.startsWith("-") && v !== "-") { k++; continue; }
    if (duration) { duration = false; k++; continue; }
    return { hit: false, at: k, dir };
  }
  return { hit: false, at: -1, dir };
}

/**
 * 信頼済みの `brw pr` の確認を省略するか。宣言（登録済み）が push と PR 作成の確認省略をともに有効にしているときだけ。
 * 承認の要否・禁止は `brw pr` の内部の公開（計画・状態）が改めて判定するため、ここではホストの確認を省くだけ。それ以外は応答を返さない。
 */
function decidePrCall(p) {
  if (p.bad) return PASS;
  if (p.bodyFile !== undefined && !bodyFileOk(p.dir, p.bodyFile)) return PASS;
  const root = repoRoot(p.dir);
  if (!root) return PASS;
  const { config, error } = loadConfig(root);
  if (error || !config) return PASS;
  const auto = autoApproveOf(config, configMatchesHead(root));
  if (!auto.push || !auto.pullRequest) return PASS;
  return { verdict: "allow", reason: "信頼済み BRW の brw pr です。公開の承認の要否と禁止は、brw pr の内部で改めて判定されます。", code: "pr-flow" };
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

// git add で確認省略してよいオプション（強制・対話・パッチのオプションは含めない）
const ADD_PLAIN_OPTS = new Set(["-A", "-u", "--all", "-N", "-v"]);
// 確認省略してよい commit の -m に入る、クォートした heredoc の置換（15.2 の通常形と同じ形）
const HEREDOC_SUB = /^cat <<'([A-Za-z_][A-Za-z0-9_]*)'\n[\s\S]*\n\1\n$/;

/** git add の語が、限定したオプションと（`--` の後の）パスだけか。展開・glob・チルダ・リダイレクトは含まない。 */
function plainAddArgs(words) {
  if (words.length === 0) return false;
  let afterDashDash = false;
  for (const x of words) {
    if (x.dyn || x.glob || x.tilde || x.redir || x.v === "") return false;
    if (afterDashDash) {
      if (x.v.startsWith(":")) return false; // pathspec の特殊記法は通常形としない
      continue;
    }
    if (x.v === "--") { afterDashDash = true; continue; }
    if (x.v.startsWith("-")) {
      if (!ADD_PLAIN_OPTS.has(x.v)) return false;
      continue;
    }
    if (x.v.startsWith(":")) return false;
  }
  return true;
}

/**
 * 複合（&& で連結した git add・commit・push）が確認省略してよい形か（brw-enforcement 15.4）。
 * 先頭の任意の `cd <dir>`、続く git add（限定した引数）・git commit（通常形）・git push の区間だけを、`&&` で連結したものに限る。
 * 字句解析の項目で構造を確かめるので、引用の中の `&&` は区切りとして扱わない。操作の数と種類が区間と一致しなければ確認省略しない（展開の中の操作を見逃さないため）。
 */
function plainCompound(command, cls) {
  const { items, broken } = lex(command);
  if (broken || items.length === 0) return false;
  const kinds = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.type !== "cmd" || it.heredoc) return false;
    // 最後の区間の後ろは終わり（;）だけ。途中の区切りは && のみ
    if (i === items.length - 1 ? it.sep !== ";" : it.sep !== "&&") return false;
    const w = it.words;
    if (w.length === 0 || w.some((x) => x.redir) || w[0].dyn) return false;
    if (w[0].v === "cd") {
      // cd は先頭の 1 つだけ。引数は展開・glob なしの 1 語
      if (i !== 0 || w.length !== 2 || it.subs.length || w[1].dyn || w[1].glob || w[1].v === "") return false;
      continue;
    }
    if (w[0].v !== "git" || w.length < 2 || w[1].dyn) return false;
    const sub = w[1].v;
    const args = w.slice(2);
    if (sub === "add") {
      if (it.subs.length || !plainAddArgs(args)) return false;
      kinds.push("query");
    } else if (sub === "commit") {
      if (!it.subs.every((s) => HEREDOC_SUB.test(s)) || args.some((x) => x.glob || x.tilde)) return false;
      kinds.push("commit");
    } else if (sub === "push") {
      if (it.subs.length || args.some((x) => x.dyn || x.glob || x.tilde)) return false;
      kinds.push("push");
    } else return false;
  }
  // 区間ごとの操作と一致し、変更操作（commit・push）を含み、commit は通常形と認めたものだけ
  const ops = cls.operations;
  if (kinds.length === 0 || ops.length !== kinds.length || !kinds.some((k) => k !== "query")) return false;
  if (!kinds.every((k, i) => ops[i].kind === k)) return false;
  return ops.every((o) => o.kind !== "commit" || o.flags?.normal === true);
}

/**
 * 確認省略してよい形か。次のいずれか。
 *  - 単独の git・gh の操作（先頭の cd を除く）で、語に分けられ、他の操作・認識外の記号を含まない
 *  - git add・commit・push の区間だけの && 連結（plainCompound）
 */
function plainOperation(command, cls) {
  if (cls.operations.length !== 1) return plainCompound(command, cls);
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

/**
 * 作成・再開（kind: create）の拒否を、ゲートの計画で置き換え（rewrite）か、案内の書式の拒否にする。
 * 作成の拒否でなければ null。置き換えに使う書式付きの拒否は guided: true（複数行の書式を保って応答する）。
 * @param {object} cls classifyCommand の結果
 * @param {object} d evaluateAll の拒否の判定
 */
function gateJudge(cls, d, command, cwd, host, toolInput) {
  if (d.kind !== "create") return null;
  // 拒否の原因になった作成の操作を特定する
  const op = cls.operations.filter((o) => o.kind === "create").find((o) => evaluateAll({ operations: [o] }, {}).verdict === "deny");
  if (!op) return null;
  const opCwd = op.cwd ?? cwd;
  if (d.code === "branch-create" || d.code === "branch-resume") {
    const config = op.root ? loadConfig(op.root).config : null;
    if (config) {
      const facts = opCwd ? gatherFacts(opCwd) : null;
      const plan = planGate({ host, command, toolInput, op, config, facts, hasLeadingCd: stripCd(command).dir !== null, unresolved: op.unresolved ?? [] });
      if (plan.verdict === "rewrite") return { verdict: "rewrite", command: plan.command, reason: plan.reason, code: "gate-rewrite", toolInput };
      if (plan.verdict === "deny") return { verdict: "deny", reason: plan.reason, code: plan.code, guided: true };
      return PASS; // 保護・分岐元への切り替えなど、通常の承認に任せる
    }
  }
  // 対象を確定できない拒否など。既存の理由に、共通の案内の見出しと次のコマンドの行を付ける
  const reason = [d.reason, d.alternative].filter(Boolean).join(" ");
  return {
    verdict: "deny",
    code: d.code,
    guided: true,
    reason: guidance({
      outcome: "拒否",
      conclusion: "ブランチ・worktree の作成や切り替えを確定できないため、操作を止めます",
      commands: [`node ${shellQuote(BRW_CLI)} create <名前>`],
      workdir: null,
      notes: `${reason}\n作成は ${BRW_RUN} create <名前>、既存の開発ブランチの再開は ${BRW_RUN} resume <ブランチ> を実行してください。`,
    }),
  };
}

/** Bash の入力を判定する。 */
function judgeBash(command, cwd, host = "claude", toolInput = {}) {
  const pub = publishCall(command, cwd);
  if (pub) return decidePublish(pub);
  const prc = prCall(command, cwd);
  if (prc) return decidePrCall(prc);
  // 信頼済み BRW の pr-merge は利用者の端末でだけ実行する。エージェントの実行は分類の前に拒否する
  if (prMergeCall(command, cwd)) return { verdict: "deny", reason: PR_MERGE_REASON, code: "pr-merge-by-agent" };
  const cls = classifyCommand(command, cwd);
  const d = evaluateAll(cls, restrictionsFor(cwd));
  if (d.verdict === "deny") return gateJudge(cls, d, command, cwd, host, toolInput) ?? decisionOf(d);
  if (cls.operations.some((o) => o.repoState === "managed") && refMovingIn(command))
    return { verdict: "ask", reason: `ブランチや参照を直接動かす操作のため、利用者の確認を求めます。BRW の手順（${BRW_RUN} create・${BRW_RUN} resume など）を優先してください。`, code: "ref-moving" };
  // 送り先（別のリモートを含む）が信頼できない push は、確認省略しない（通常の承認に任せる）
  const pushesTrusted = cls.operations.every((o) => o.kind !== "push" || trustedRemote(o.cwd, o.remote));
  if (d.verdict === "eligibleForApproval" && plainOperation(command, cls) && pushesTrusted)
    return { verdict: "allow", reason: `${d.reason}`, code: d.code };
  return PASS;
}

/**
 * コマンドを共通の操作判定にかけ、拒否なら判定（verdict・code・reason）と、含まれる操作の種類（kinds）を返す。拒否でなければ null。
 * 手順書の経路（brw guard）が、フックと同じ拒否を再利用するために使う。kinds で作成・PR 作成かを判断できる。
 */
export function denyOfCommand(command, cwd) {
  const cls = classifyCommand(command, cwd);
  const d = evaluateAll(cls, restrictionsFor(cwd));
  if (d.verdict !== "deny") return null;
  // 手順書の経路（Codex）は入力を書き換えられないため、作成・再開は案内つきの拒否（次のコマンドを含む）にする
  const g = gateJudge(cls, d, command, cwd, "codex", {});
  if (g?.verdict === "pass") return null;
  return { ...(g?.verdict === "deny" ? g : decisionOf(d)), kinds: cls.operations.map((o) => o.kind) };
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
      return judgeBash(ti.command, cwd, host, ti);
    }
    if (tool === "EnterWorktree") {
      const r = judgeEnterWorktree(ti, cwd);
      return r.verdict === "deny" ? { verdict: "deny", reason: r.reason, code: r.code, guided: true } : PASS;
    }
    if (typeof tool === "string" && tool.startsWith("mcp__")) {
      // MCP の書き込みは拒否だけを返す。確認省略は、公開計画を経た Bash の publish に限る
      const d = evaluateAll(classifyMcpCall(tool, ti ?? {}, cwd), restrictionsFor(cwd));
      return d.verdict === "deny" ? decisionOf(d) : PASS;
    }
    return PASS;
  } catch {
    // 判定の途中で例外が起きたら、Git・GitHub の操作だけは止める（安全側）
    const raw = typeof input === "string" ? input : JSON.stringify(input ?? "");
    if (/"EnterWorktree"/.test(raw)) return { verdict: "deny", reason: "フックの判定で内部エラーが起きたため、操作を止めます。", code: "internal-error" };
    return TOOLS_RE.test(raw) ? { verdict: "deny", reason: "フックの判定で内部エラーが起きたため、操作を止めます。", code: "internal-error" } : PASS;
  }
}

/**
 * 判定をホストの応答の形にする。応答を返さないときは null。
 * PermissionRequest の応答は decision.behavior（allow・deny）。PreToolUse は permissionDecision（deny・Claude は allow・ask）。
 */
export function responseOf(host, event, d) {
  if (!d || d.verdict === "pass") return null;
  // 案内の書式（複数行）は、行を保つ（資格情報らしい値だけを伏せる）。それ以外は 1 行にする
  const reason = d.guided === true ? redactSecrets(d.reason) : PREFIX + sanitize(d.reason);
  if (d.verdict === "rewrite") {
    // 置き換えは Claude Code の PreToolUse だけ（入力を書き換えて許可する）。書き換え後は BRW 自身の CLI の呼び出しだけで、確認は求めない
    if (host !== "claude" || event !== "PreToolUse" || typeof d.command !== "string") return null;
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: reason, updatedInput: { ...(d.toolInput ?? {}), command: d.command } } };
  }
  if (event === "PermissionRequest") {
    if (d.verdict === "deny") return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: reason } } };
    if (d.verdict === "allow") return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } };
    return null;
  }
  if (d.verdict === "deny") return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
  if (host === "claude" && (d.verdict === "allow" || d.verdict === "ask")) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: d.verdict, permissionDecisionReason: reason } };
  return null;
}

// ---- 作業 ID の関連付け（PostToolUse）と終了時の案内（Stop）（6.2） ----

const WORK_ID_ONE = /^w-[a-z0-9]+-[0-9a-f]{8}$/;
const WORK_ID_IN_TEXT = /w-[a-z0-9]+-[0-9a-f]{8}/g;
const SESSION_RE = /^[A-Za-z0-9._:-]{1,200}$/;

/** 入力をオブジェクトにする。オブジェクトでなければ null。 */
const eventOf = (input) => {
  let ev = input;
  if (typeof input === "string") {
    try { ev = JSON.parse(input); } catch { return null; }
  }
  return ev && typeof ev === "object" && !Array.isArray(ev) ? ev : null;
};
const cwdOf = (ev) => (typeof ev.cwd === "string" && ev.cwd !== "" ? ev.cwd : null);
const sessionOf = (ev) => (typeof ev.session_id === "string" && SESSION_RE.test(ev.session_id) ? ev.session_id : null);

/**
 * 信頼済み BRW の作業コマンドか。`node <brw.mjs の実体> work start` と `node <brw.mjs の実体> work resume --work <id>` の形だけ認める。
 * 戻り値: null（作業コマンドではない・信頼できない）| { dir, kind: "start"|"resume", workId? }
 */
function workCallOf(command, cwd) {
  const cd = stripCd(command);
  if (!cd.ok) return null;
  const w = scanWords(cd.rest);
  if (!w || w[0] !== "node" || w[2] !== "work") return null;
  const dir = cd.dir === null ? cwd : resolve(cwd, cd.dir);
  if (w[1] === undefined || !isTrustedCli(resolve(dir, w[1]))) return null;
  if (w.length === 4 && w[3] === "start") return { dir, kind: "start" };
  if (w.length === 6 && w[3] === "resume" && w[4] === "--work" && WORK_ID_ONE.test(w[5])) return { dir, kind: "resume", workId: w[5] };
  return null;
}

/**
 * 成功した実行の出力文字列。成功と確認できなければ null（安全側）。実機（8.4）で確認した入力の形に合わせる。
 *   Claude  オブジェクト `{stdout, stderr, interrupted, isImage, noOutputExpected}`。exit_code は届かない
 *           （PostToolUse は成功した呼び出しだけに届き、失敗は別のイベント）。このため exit_code が無いときは interrupted:false を成功の根拠にする。
 *   Codex   終了コードを含まない出力の文字列（失敗した呼び出しにも届く）。失敗の出力を成功と取り違えないよう、
 *           「注意:」の行を除いて作業 ID だけの 1 行になる出力に限る（brw work start|resume は作業 ID を 1 つだけ出す）。
 * exit_code が届いたときは 0 だけを成功とする。
 */
const successOutput = (tr) => {
  if (typeof tr === "string") {
    const ls = tr.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !/^注意:/.test(l));
    return ls.length === 1 && WORK_ID_ONE.test(ls[0]) ? ls[0] : null;
  }
  if (!tr || typeof tr !== "object" || Array.isArray(tr) || tr.interrupted === true) return null;
  if (tr.exit_code !== undefined ? tr.exit_code !== 0 : tr.interrupted !== false) return null;
  return [tr.stdout, tr.output].filter((s) => typeof s === "string").join("\n");
};

/**
 * PostToolUse: 成功した `brw work start|resume` の作業 ID を、ホストのセッションに関連付ける。
 * 出力は作業 ID の探索にだけ使い、採用は状態ファイルで決める（現在の作業で、中断中でなく、公開済みでないこと）。
 * 条件を満たさない・判定できない場合は何も書かない。応答は返さない。
 */
function recordWorkStart(input) {
  try {
    const ev = eventOf(input);
    if (!ev || ev.tool_name !== "Bash" || typeof ev.tool_input?.command !== "string") return;
    const cwd = cwdOf(ev);
    const session = sessionOf(ev);
    if (!cwd || !session) return;
    const call = workCallOf(ev.tool_input.command, cwd);
    if (!call) return;
    const out = successOutput(ev.tool_response);
    if (out === null) return;
    const ids = [...new Set(out.match(WORK_ID_IN_TEXT) ?? [])];
    const file = stateFileOf(call.dir);
    if (!file) return;
    const { state, error } = load(file);
    if (error) return;
    const cur = state.current;
    if (typeof cur !== "string" || !ids.includes(cur)) return;
    if (call.workId !== undefined && call.workId !== cur) return;
    const w = state.works[cur];
    if (!w || w.pausedReason || w.status === "published") return;
    if (call.kind === "start" && w.status !== "inProgress") return;
    // 開始の関連付けは、別のセッションが関連付け済みの作業を上書きしない（再開は明示の再開として置き換える）
    attachSession(call.dir, cur, session, { onlyIfUnset: call.kind === "start" });
  } catch {
    // 関連付けに失敗しても、ホストの処理は止めない（記録されないだけ）
  }
}

/**
 * 作業が終了時の案内の対象か。準備済み（ready）で push が残る作業、または push 済みで PR が残る作業。
 * 明示禁止で残りの操作が無い作業、中断済み、公開済みは対象外。準備の後に HEAD が変わった作業は "stale"。
 */
function pendingOf(w, head) {
  if (!w || typeof w !== "object" || w.status === "published" || w.pausedReason) return null;
  const r = restrictionsOf(w);
  const publication = w.ready?.publication;
  if (w.status === "ready") {
    if (r.noPush) return null;
    return w.ready?.headOid === head ? "ready" : "stale";
  }
  if (w.status === "pushed") {
    if (publication === "pr" && r.noPr) return null;
    return "pushed";
  }
  return null;
}

/**
 * 公開の案内（16.3 で残りの案内と分けた既存の処理）の本文。セッションに結び付いた、準備済みで未公開の作業だけを案内する。
 * セッション ID・状態ファイル・HEAD が無い・読めないときは null。この案内の中だけで止まり、残りの案内には影響させない。読み取りだけを行い、状態を書き換えない。
 */
function publishGuidance(ev) {
  try {
    const cwd = cwdOf(ev);
    const session = sessionOf(ev);
    if (!cwd || !session) return null;
    const file = stateFileOf(cwd);
    if (!file) return null;
    const { state, error } = load(file);
    if (error) return null;
    const head = git(cwd, "rev-parse", "--verify", "HEAD");
    if (!head) return null;
    const lines = [];
    for (const w of Object.values(state.works)) {
      if (!w || w.sessionId !== session) continue;
      const kind = pendingOf(w, head);
      if (kind === null) continue;
      const id = w.workId;
      if (kind === "stale") lines.push(`- 作業 ${id}: 準備の後に HEAD が変わりました。\`${BRW_RUN} work resume --work ${id}\` で再開して準備をやり直すか、\`${BRW_RUN} pause --work ${id} --reason "<理由>"\` で中断してください。`);
      else lines.push(`- 作業 ${id}: 公開を続けるには、\`${BRW_RUN} work plan --work ${id}\` で計画 ID を取得し、\`${BRW_RUN} publish --work ${id} --plan <計画 ID>\` を実行してください。中断するなら \`${BRW_RUN} pause --work ${id} --reason "<理由>"\` を実行してください。`);
    }
    if (lines.length === 0) return null;
    return `準備済みで公開が終わっていない作業があります。次のいずれかを行ってから終了してください。\n${lines.join("\n")}`;
  } catch {
    return null;
  }
}

/**
 * 残りの案内（16.3）の本文。リポジトリの全 worktree の Git の状態だけで評価する（セッション・状態ファイル・HEAD に依存しない）。
 * cwd は案内の cd の手順にだけ使う。各 worktree の push 禁止は、その worktree の作業の制限（restrictionsFor）か、
 * 宣言の autoApprove.push が明示的に false のとき真（未登録の既定の false とは区別する）。読み取りだけを行い、判定できなければ null。
 */
function remainderGuidanceOf(ev) {
  const cwd = cwdOf(ev);
  if (!cwd) return null;
  return remainderGuidanceForCwd(cwd);
}

/**
 * 残りの案内の本文（16.4 で Stop と brw guard --finish が共用する）。cwd は cd の手順の基準にだけ使う。
 * 残りが無い・判定できないときは null（案内しない側に倒す）。読み取りだけを行う。
 */
export function remainderGuidanceForCwd(cwd) {
  try {
    const remainders = remaindersOf(cwd);
    if (remainders.length === 0) return null;
    // 宣言は本体（先頭の worktree）から読む（remaindersOf と同じ読み方。実パスは -z の一覧から取る）
    const declaredNoPush = declaredNoPushOf(cwd);
    const items = remainders.map((r) => ({ ...r, noPush: declaredNoPush || restrictionsFor(r.path).noPush === true }));
    return remainderGuidance(items, { noPush: false, cwd });
  } catch {
    return null;
  }
}

/**
 * Stop: 公開の案内（準備済みで未公開の作業）と残りの案内（作業ブランチの未コミット・未 push）を、1 つの block にまとめる。
 * 公開の案内を先に並べる。読み取りだけを行い、状態を書き換えない。
 * stop_hook_active が真なら、どちらも案内せず終了させる（案内の繰り返しによる無限ループを防ぐ）。両方とも無ければ案内しない。
 */
function stopGuidance(input) {
  try {
    const ev = eventOf(input);
    if (!ev || ev.stop_hook_active === true) return null;
    const parts = [publishGuidance(ev), remainderGuidanceOf(ev)].filter((p) => typeof p === "string" && p !== "");
    if (parts.length === 0) return null;
    return { decision: "block", reason: `${PREFIX}${parts.join("\n\n")}` };
  } catch {
    return null;
  }
}

/** ホストのイベントを処理し、応答（オブジェクトまたは null）を返す。 */
export function handleHook(host, event, input) {
  if (!HOST_EVENTS[host]?.includes(event)) return null;
  // PostToolUse は関連付けだけを行い、応答は返さない。Stop は Claude・Codex とも block の形で案内する
  if (event === "PostToolUse") {
    recordWorkStart(input);
    return null;
  }
  if (event === "Stop") return stopGuidance(input);
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
