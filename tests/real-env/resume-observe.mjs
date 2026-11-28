// 続きの再開の実機観測（brw-pr-handoff 9.6 の後半）。BRW_REAL_ENV=1 のときだけ実行する（通常の selftest には含めない）。
// 使い捨ての一時ディレクトリ（一時リポジトリ・bare remote・偽の gh・偽の ssh）だけを使い、GitHub には接続も書き込みもしない。
// Claude Code は一時のプロジェクト（.claude/settings.json）と --setting-sources project で動かす（~/.claude の設定は読み書きしない）。
// Codex は ~/.codex/auth.json を一時 CODEX_HOME にコピーして観測する（利用者のファイルは読み取りのみ）。
// 使い方: BRW_REAL_ENV=1 node tests/real-env/resume-observe.mjs --stage claude-main|claude-inside|codex
// 純粋な部分（stream-json の解析・判定）は、この実行ファイルを import して tests/resume-observe.mjs が単体で試す。
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireRealEnv, WORK_DIR } from "./common.mjs";
import { installCodexHooks } from "../../scripts/hook-install.mjs";

const BRW_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BRW = join(BRW_ROOT, "scripts", "brw.mjs");
const AGENT = join(BRW_ROOT, "scripts", "agent-hooks.mjs");
const CONFIG = { workBranches: ["dev/*"], protectedBranches: ["main"], baseBranch: "develop" };
const GH_SSH = "git@github.com:acme/app.git";
const BRANCH = "dev/obs-resume";
const ALIAS = "dev-obs-resume";
const PR_TITLE = "続きの再開の観測";
const BODY = "## 概要\n続きの再開の観測の本文\n";
const MAX_ATTEMPTS = 3;
const TURN_TIMEOUT_MS = 420000;

// ---------- 純粋な部分（単体試験から呼ぶ） ----------

/** claude -p の stream-json を解析する。セッション ID・Bash の呼び出し（コマンドと結果）・各ターンの結果・解析できない行の数。 */
export function parseStreamJson(text) {
  const sessions = [];
  const bash = [];
  const pending = new Map();
  const results = [];
  let unparsed = 0;
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    let j;
    try { j = JSON.parse(line); } catch { unparsed++; continue; }
    if (j.type === "system" && j.subtype === "init" && typeof j.session_id === "string") sessions.push(j.session_id);
    if (j.type === "assistant") {
      for (const c of j.message?.content ?? []) {
        if (c.type === "tool_use" && c.name === "Bash") {
          const call = { id: c.id ?? null, command: String(c.input?.command ?? ""), output: null, isError: null };
          bash.push(call);
          pending.set(c.id, call);
        }
      }
    }
    if (j.type === "user") {
      for (const c of j.message?.content ?? []) {
        if (c.type === "tool_result" && pending.has(c.tool_use_id)) {
          const content = typeof c.content === "string" ? c.content : (c.content ?? []).map((x) => x.text ?? "").join("\n");
          pending.get(c.tool_use_id).output = content;
          pending.get(c.tool_use_id).isError = c.is_error ?? null;
        }
      }
    }
    if (j.type === "result") results.push(String(j.result ?? ""));
  }
  return { sessionId: sessions[0] ?? null, bash, results, unparsed };
}

/** codex exec --json のイベント列から thread ID・コマンド実行・最終回答を取り出す。 */
export function parseCodexJson(text) {
  const commands = [];
  const results = [];
  const events = [];
  const sessionIds = [];
  let turns = 0;
  let unparsed = 0;
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { unparsed++; continue; }
    events.push(e.type ?? "unknown");
    if (e.type === "thread.started" && typeof e.thread_id === "string") sessionIds.push(e.thread_id);
    const item = e.item;
    if (e.type === "item.completed" && item?.type === "command_execution") {
      commands.push({ id: item.id ?? null, command: String(item.command ?? ""), output: String(item.aggregated_output ?? ""), exitCode: item.exit_code ?? null });
    }
    if (e.type === "item.completed" && item?.type === "agent_message") results.push(String(item.text ?? ""));
    if (e.type === "turn.completed") turns++;
  }
  return { sessionId: sessionIds[0] ?? null, resumedSessionId: sessionIds[1] ?? null, sessionIds, commands, results, turns, events: [...new Set(events)], unparsed };
}

/** Hook input と Codex/Claude の tool call ID を使い、resume コマンドそのものの前後状態だけを組にする。 */
export function resumeEvidenceOf(call, hookLog, branch, host) {
  if (!call || !call.id || !isStandaloneResumeCommand(call.command, branch)) return null;
  const pre = hookLog.find((e) => e.event === "PreToolUse" && e.tool_use_id === call.id && e.command === call.command);
  const post = hookLog.find((e) => e.event === "PostToolUse" && e.tool_use_id === call.id && e.command === call.command);
  const status = host === "codex"
    ? call.exitCode === 0 ? "success" : call.exitCode === null || call.exitCode === undefined ? null : "failed"
    : call.isError === false ? "success" : call.isError === true ? "failed" : null;
  return {
    toolUseId: call.id,
    standalone: true,
    status,
    worktreeBranchesBefore: pre?.worktreeBranches ?? null,
    worktreeBranchesAfter: post?.worktreeBranches ?? null,
  };
}

/** 複合コマンド内の別操作をresumeの効果と誤認しないよう、単独のnode brw.mjs resumeだけを受け付ける。 */
export function isStandaloneResumeCommand(command, branch) {
  const text = String(command ?? "").trim();
  const shell = /^\/bin\/bash -lc "([\s\S]*)"$/.exec(text);
  const body = (shell?.[1] ?? text).trim();
  const quotedBranch = String(branch ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^node '\\S*\\/brw\\.mjs'\\s+resume\\s+${quotedBranch}$`).test(body);
}

/**
 * 観測の判定。項目ごとに「一致（想定どおり）」「不一致」「未観測」のどれかを返す。想定と異なる結果は一致にしない。
 * inside=true は作業場所の中でセッションを開始した場合（削除後にフックが動かない既知の限界を確かめる）。
 */
export function judge({ sessionId, resumedSessionId, recordSession, hookLog, answer2, commands2, resumeEvidence, branchesBefore, branchesAfter, branch, inside, ctx2, preToolUse }) {
  const item = (name, verdict, detail) => ({ name, verdict, detail });
  const out = [];
  // (a) 片付け後の記録に、セッションが付いたか（実行前のメモからの関連付け）
  if (recordSession === undefined) out.push(item("a", "未観測", "再開の記録を読めない"));
  else if (sessionId && recordSession === sessionId) out.push(item("a", "一致", "片付け後の記録に、そのセッションの ID が付いた"));
  else out.push(item("a", "不一致", `記録のセッション: ${recordSession ?? "空"}（期待: ${sessionId ?? "不明"}）`));
  // (b) ターン 2 の UserPromptSubmit で BRW が案内（brw resume を含む additionalContext）を返したか（ラッパーの記録）。
  //     モデルへの到達は、答えが案内の文言（「新しい作業なら無視してかまいません」）の有無を「あり」と答えたことで確かめる
  const ups = hookLog.filter((e) => e.event === "UserPromptSubmit");
  const fired = ups.length >= 2 && ups[0].session_id === sessionId && ups[1].session_id === resumedSessionId;
  const returned = typeof ctx2 === "string" && ctx2.includes(`resume ${branch}`);
  const answerSaysPresent = typeof answer2 === "string" && /^\s*あり/.test(answer2);
  if (inside) {
    if (!fired) out.push(item("b", "一致", "想定どおり（既知の限界）: 削除後に UserPromptSubmit は動かず、案内は届かない"));
    else out.push(item("b", "不一致", returned ? "想定と異なる: 削除後に UserPromptSubmit が動き、BRW が案内を返した" : "想定と異なる: 削除後に UserPromptSubmit が動いたが、BRW は案内を返さなかった"));
  } else if (!fired) out.push(item("b", "不一致", "ターン 2 で UserPromptSubmit が動いていない"));
  else if (!returned) out.push(item("b", "不一致", "ターン 2 で UserPromptSubmit は動いたが、BRW は案内（brw resume を含む文脈）を返さなかった"));
  else if (answerSaysPresent) out.push(item("b", "一致", "BRW が案内を返し（記録）、モデルが案内の文言の有無に「あり」と答えた"));
  else out.push(item("b", "不一致", "BRW は案内を返したが、モデルの答えが案内の文言を示さなかった（モデルへの到達を確認できない）"));
  // (c) 対象resume tool callのPre/Post観測と成功終了を同じtool_use_idで確認する。
  const ranResume = commands2.some((c) => /brw\.mjs'?\s+resume\s/.test(c) && c.includes(branch));
  const before = resumeEvidence?.worktreeBranchesBefore;
  const after = resumeEvidence?.worktreeBranchesAfter;
  const hasEvidence = Boolean(resumeEvidence?.toolUseId && resumeEvidence.standalone && Array.isArray(before) && Array.isArray(after));
  const absentBefore = hasEvidence && !before.includes(branch);
  const createdByCall = hasEvidence && absentBefore && after.includes(branch);
  const bOk = out[1].verdict === "一致";
  if (!ranResume) out.push(item("c", inside ? "未観測" : "不一致", inside ? "作業場所削除後のシェルでは resume を確認できない" : "brw resume を実行していない"));
  else if (resumeEvidence?.status === "failed") out.push(item("c", "不一致", "brw resume の終了結果が失敗だった"));
  else if (resumeEvidence?.status !== "success" || !hasEvidence) out.push(item("c", "未観測", "単独resume tool callの成功終了または同一tool callのPre/Post worktree状態を確認できない"));
  else if (createdByCall) out.push(item("c", inside ? "不一致" : "一致", inside ? "想定外に、成功したresume tool callが対象worktreeを作成した" : bOk ? "同一resume tool callの前には対象worktreeが無く、成功終了後に作成された。答えにも案内の文言がある" : "同一resume tool callの前には対象worktreeが無く、成功終了後に作成された。案内によるとは確認できない"));
  else out.push(item("c", "不一致", absentBefore ? "resume tool callは成功したが、そのPostToolUse後に対象worktreeが無い" : "resume tool callのPreToolUse時点で対象worktreeがあり、新規作成を確認できない"));
  // (d) 新しい作業ブランチを作っていないか
  const created2 = branchesAfter.filter((x) => !branchesBefore.includes(x));
  out.push(created2.length === 0 ? item("d", "一致", "新しいブランチを作っていない") : item("d", "不一致", `新しい作業ブランチを作った: ${created2.join(", ")}`));
  // (e) PreToolUse の session/thread ID と cwd が実行・UserPromptSubmit と一致したか。
  if (!preToolUse || !preToolUse.observed) out.push(item("e", "未観測", "両ターンのthread ID・UserPromptSubmit・PreToolUseの対応をそろえて確認できない"));
  else if (preToolUse.hasFields && preToolUse.sameThreadAcrossTurns && preToolUse.firstUpsMatchesSession && preToolUse.secondUpsMatchesResumedSession && preToolUse.preMatchesSession && preToolUse.cwdMatchesExpected) out.push(item("e", "一致", "両ターンのthread ID、各UserPromptSubmit、PreToolUseのsession IDが一致し、PreToolUseのcwdも対象worktreeと一致した"));
  else out.push(item("e", "不一致", "PreToolUse の session/thread ID または cwd が不足・不一致"));
  return out;
}

// ---------- 実行（BRW_REAL_ENV=1 のときだけ） ----------

const g = (cwd, ...a) => execFileSync("git", ["-c", "user.name=obs", "-c", "user.email=obs@example.com", ...a], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const branchesOf = (main) => g(main, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").filter(Boolean);
const worktreeBranchesOf = (main) => g(main, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("branch refs/heads/")).map((l) => l.slice("branch refs/heads/".length));

// 偽の gh（GitHub へは通信しない）。PR は状態ファイルに持ち、head の SHA は bare remote の現在の先端を返す
const GH_SHIM = `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const C = JSON.parse(readFileSync(process.env.OBS_GH_CONFIG, "utf8"));
const args = process.argv.slice(2);
if (args[0] === "auth" && args[1] === "token") { process.stdout.write("obs-token\\n"); process.exit(0); }
if (args[0] !== "api") { appendFileSync(C.log, JSON.stringify({ unexpected: args.slice(0, 3).join(" ") }) + "\\n"); process.exit(2); }
const valueOf = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const method = (valueOf("--method") ?? "GET").toUpperCase();
const path = args.find((a) => a.startsWith("/")) ?? "/";
const body = args.includes("--input") ? readFileSync(0, "utf8") : undefined;
const parsed = body ? JSON.parse(body) : undefined;
const url = new URL(path, "https://api.github.com");
const state = existsSync(C.state) ? JSON.parse(readFileSync(C.state, "utf8")) : { prs: [] };
const repo = { id: 4242, full_name: "acme/app" };
const headSha = (b) => execFileSync("git", ["--git-dir", C.bare, "rev-parse", "--verify", "-q", "refs/heads/" + b], { encoding: "utf8" }).trim();
const prJson = (p) => ({ number: p.number, html_url: p.url, state: "open", draft: false, base: { ref: p.base, repo }, head: { ref: p.head, sha: headSha(p.head), repo } });
let status = 404, resp = { message: "Not Found" }, applied = false;
if (method === "GET" && url.pathname === "/repos/acme/app") { status = 200; resp = repo; }
else if (method === "GET" && url.pathname === "/repos/acme/app/pulls") {
  const head = (url.searchParams.get("head") ?? "").replace(/^acme:/, "");
  const base = url.searchParams.get("base");
  status = 200; resp = state.prs.filter((p) => p.head === head && (!base || p.base === base)).map(prJson);
} else if (method === "POST" && url.pathname === "/repos/acme/app/pulls") {
  const n = state.prs.length + 7;
  const p = { number: n, url: "https://github.com/acme/app/pull/" + n, head: parsed.head, base: parsed.base, title: parsed.title };
  state.prs.push(p); writeFileSync(C.state, JSON.stringify(state));
  status = 201; resp = prJson(p); applied = true;
}
appendFileSync(C.log, JSON.stringify({ method, path: url.pathname + url.search, applied }) + "\\n");
process.stdout.write("HTTP/2.0 " + status + " " + (status < 300 ? "OK" : "Error") + "\\r\\ncontent-type: application/json\\r\\n\\r\\n" + JSON.stringify(resp));
`;
// 偽の ssh（bare remote へ向ける。受け取り・取得の呼び出しを記録する）
const WRAPPER = `import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
let t = ""; for await (const c of process.stdin) t += c;
let i = {}; try { i = JSON.parse(t); } catch {}
const r = spawnSync("node", [process.env.BRW_OBS_AGENT, "claude", "UserPromptSubmit"], { input: t, encoding: "utf8", env: process.env });
const out = r.stdout ?? "";
appendFileSync(process.env.BRW_OBS_HOOK_LOG, JSON.stringify({ at: new Date().toISOString(), event: "UserPromptSubmit", session_id: i.session_id ?? null, cwd: i.cwd ?? null, prompt40: String(i.prompt ?? "").slice(0, 40), out, exit: r.status }) + "\\n");
process.stdout.write(out);
process.exitCode = r.status ?? 0;
`;
const FAKE_SSH = `#!/bin/sh
printf '%s\\n' "$2" >> "$BRW_OBS_SSHLOG"
cmd=$(printf '%s' "$2" | sed "s#acme/app.git#$BRW_OBS_BARE#")
exec sh -c "$cmd"
`;
// 観測用のフック（UserPromptSubmit の入力を記録する。実際のフックの前に動かす）
const LOGGER = `import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
let t = ""; for await (const c of process.stdin) t += c;
let i = {}; try { i = JSON.parse(t); } catch {}
const tr = i.tool_response === undefined ? null : (typeof i.tool_response === "string" ? { kind: "string", head: i.tool_response.slice(0, 60) } : { kind: "object", keys: Object.keys(i.tool_response), exit_code: i.tool_response.exit_code ?? null, interrupted: i.tool_response.interrupted ?? null });
const command = typeof i.tool_input?.command === "string" ? i.tool_input.command : null;
const worktreeBranches = (() => { try { return execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: i.cwd, encoding: "utf8" }).split("\\n").filter((l) => l.startsWith("branch refs/heads/")).map((l) => l.slice("branch refs/heads/".length)); } catch { return null; } })();
appendFileSync(process.env.BRW_OBS_HOOK_LOG, JSON.stringify({ at: new Date().toISOString(), event: i.hook_event_name, session_id: i.session_id ?? null, tool_use_id: i.tool_use_id ?? i.toolUseId ?? null, cwd: i.cwd ?? null, command, worktreeBranches, tool_response: tr, keys: Object.keys(i).sort() }) + "\\n");
`;

// Codex 用の観測ラッパー: BRW 本体の応答をそのまま返し、入力と追加文脈だけを一時ログへ記録する。
const CODEX_WRAPPER = `import { appendFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
let t = ""; for await (const c of process.stdin) t += c;
let i = {}; try { i = JSON.parse(t); } catch {}
const event = process.argv[3];
const r = spawnSync("node", [process.env.BRW_OBS_AGENT, "codex", event], { input: t, encoding: "utf8", env: process.env });
const out = r.stdout ?? "";
const command = typeof i.tool_input?.command === "string" ? i.tool_input.command : null;
const worktreeBranches = (() => { try { return execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: i.cwd, encoding: "utf8" }).split("\\n").filter((l) => l.startsWith("branch refs/heads/")).map((l) => l.slice("branch refs/heads/".length)); } catch { return null; } })();
appendFileSync(process.env.BRW_OBS_HOOK_LOG, JSON.stringify({ at: new Date().toISOString(), event, session_id: i.session_id ?? null, tool_use_id: i.tool_use_id ?? i.toolUseId ?? null, cwd: i.cwd ?? null, command, worktreeBranches, keys: Object.keys(i).sort(), out, exit: r.status }) + "\\n");
process.stdout.write(out);
if (r.stderr) process.stderr.write(r.stderr);
process.exitCode = r.status ?? 0;
`;

/** 一時の環境を作る（リポジトリ・bare remote・worktree・宣言・本文・偽の gh・偽の ssh・フック）。 */
function setupSandbox(stage) {
  const base = mkdtempSync(join(tmpdir(), "brw-obs-96b-"));
  const bin = join(base, "bin");
  mkdirSync(bin);
  const bare = join(base, "remote.git");
  const main = join(base, "main");
  const wt = join(main, ".claude", "worktrees", ALIAS);
  const files = { sshLog: join(base, "ssh.log"), ghLog: join(base, "gh.log"), state: join(base, "prs.json"), hookLog: join(base, "hook.jsonl") };
  writeFileSync(files.sshLog, "");
  writeFileSync(files.ghLog, "");
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nexec node "${join(base, "gh-shim.mjs")}" "$@"\n`, { mode: 0o755 });
  writeFileSync(join(base, "gh-shim.mjs"), GH_SHIM);
  writeFileSync(join(base, "fake-ssh.sh"), FAKE_SSH, { mode: 0o755 });
  writeFileSync(join(base, "hook-logger.mjs"), LOGGER);
  writeFileSync(join(base, "hook-wrapper-ups.mjs"), WRAPPER);
  writeFileSync(join(base, "hook-wrapper-codex.mjs"), CODEX_WRAPPER);
  const ghConfig = join(base, "gh-config.json");
  writeFileSync(ghConfig, JSON.stringify({ log: files.ghLog, state: files.state, bare }));
  g(base, "init", "--bare", "-q", "-b", "main", bare);
  mkdirSync(main);
  g(main, "init", "-q", "-b", "main");
  mkdirSync(join(main, ".claude"), { recursive: true });
  writeFileSync(join(main, ".claude", "branch-release-workflow.json"), JSON.stringify(CONFIG));
  writeFileSync(join(main, "README.md"), "# 観測用\n");
  g(main, "add", "-A");
  g(main, "commit", "-q", "-m", "初期");
  mkdirSync(join(main, ".git", "info"), { recursive: true });
  writeFileSync(join(main, ".git", "info", "exclude"), ".claude/\n", { flag: "a" });
  g(main, "remote", "add", "origin", bare);
  g(main, "push", "-q", "origin", "main");
  g(main, "remote", "set-url", "origin", GH_SSH);
  // 開発ブランチの作業場所（commit 済み）。切り出し元は main（brwBase）
  g(main, "worktree", "add", "-q", "-b", BRANCH, wt, "main");
  g(wt, "config", `branch.${BRANCH}.brwBase`, "main");
  writeFileSync(join(wt, "obs.txt"), "観測用の変更\n");
  g(wt, "add", "obs.txt");
  g(wt, "commit", "-q", "-m", "観測用の変更");
  // 本文（brw pr-template が作る場所に、記入済みの本文を置く）
  const bodyDir = join(main, ".claude", "worktrees", ".brw");
  mkdirSync(bodyDir, { recursive: true });
  writeFileSync(join(bodyDir, `${ALIAS}.md`), BODY);
  // フック（settings.json。hooks/hooks.json と同じ登録に、観測用の記録を前置する）
  const hook = (event) => ({ type: "command", command: `node "${AGENT}" claude ${event}` });
  const settings = {
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `node "${join(base, "hook-logger.mjs")}"` }, hook("PreToolUse")] }, { matcher: "EnterWorktree", hooks: [hook("PreToolUse")] }, { matcher: "mcp__.*", hooks: [hook("PreToolUse")] }],
      PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `node "${join(base, "hook-logger.mjs")}"` }, hook("PostToolUse")] }],
      Stop: [{ hooks: [hook("Stop")] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: `node "${join(base, "hook-wrapper-ups.mjs")}"` }] }],
    },
  };
  const settingsText = JSON.stringify(settings);
  mkdirSync(join(main, ".claude"), { recursive: true });
  writeFileSync(join(main, ".claude", "settings.json"), settingsText);
  if (stage === "claude-inside") {
    mkdirSync(join(wt, ".claude"), { recursive: true });
    writeFileSync(join(wt, ".claude", "settings.json"), settingsText);
  }
  if (stage === "codex") {
    const installed = installCodexHooks({ repoDir: main, launcherPath: join(base, "hook-wrapper-codex.mjs") });
    if (!['registered', 'untrusted'].includes(installed.status)) throw new Error(`Codex フックの登録に失敗: ${installed.status} ${installed.reasonCode ?? ""}`);
  }
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: process.env.HOME,
    LANG: process.env.LANG ?? "C.UTF-8",
    GIT_SSH_COMMAND: join(base, "fake-ssh.sh"),
    GIT_SSH_VARIANT: "simple",
    GIT_TERMINAL_PROMPT: "0",
    GH_TOKEN: "obs-token",
    OBS_GH_CONFIG: ghConfig,
    BRW_OBS_SSHLOG: files.sshLog,
    BRW_OBS_BARE: bare,
    BRW_OBS_HOOK_LOG: files.hookLog,
    BRW_OBS_AGENT: AGENT,
  };
  return { base, main, wt, bare, files, env, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

/** 認証を保持した CODEX_HOME の一時コピーを作る。利用者側は読み取りのみで、値は表示・記録しない。 */
function prepareCodexHome(base, main) {
  const home = join(base, "codex-home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  writeFileSync(join(home, "config.toml"), `[projects."${main}"]\ntrust_level = "trusted"\n`);
  const source = join(homedir(), ".codex", "auth.json");
  if (!existsSync(source)) return { home, authenticated: false };
  const auth = join(home, "auth.json");
  copyFileSync(source, auth);
  chmodSync(auth, 0o600);
  return { home, authenticated: true };
}

function runCodex(cwd, env, turns, mainDir) {
  const common = ["--json", "--skip-git-repo-check", "-C", cwd, "-s", "workspace-write", "--add-dir", join(mainDir, ".git"), "-c", 'model_reasoning_effort="low"', "--dangerously-bypass-hook-trust"];
  const first = spawnSync("codex", ["exec", ...common, turns[0]], { cwd, env, encoding: "utf8", timeout: TURN_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  const parsedFirst = parseCodexJson(first.stdout ?? "");
  if (!parsedFirst.sessionId || first.status !== 0 || turns.length < 2) {
    return { out: first.stdout ?? "", err: (first.stderr ?? "").slice(0, 500), code: first.status ?? -1, turnsDone: parsedFirst.results.length, sessionId: parsedFirst.sessionId, timeout: first.error?.code === "ETIMEDOUT" };
  }
  // resume は cwd と実行ポリシーを保存済みスレッドから引き継ぐ。resume 専用 CLI に存在する引数だけを渡す。
  const second = spawnSync("codex", ["exec", "resume", parsedFirst.sessionId, "--json", "--dangerously-bypass-hook-trust", turns[1]], { cwd, env, encoding: "utf8", timeout: TURN_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  const parsedSecond = parseCodexJson(second.stdout ?? "");
  return {
    out: `${first.stdout ?? ""}\n${second.stdout ?? ""}`,
    err: `${first.stderr ?? ""}\n${second.stderr ?? ""}`.slice(0, 500),
    code: second.status ?? -1,
    turnsDone: parsedFirst.turns + parsedSecond.turns,
    sessionId: parsedFirst.sessionId,
    resumedSessionId: parsedSecond.sessionId,
    answer2: parsedSecond.results.at(-1),
    commands2: parsedSecond.commands,
    timeout: first.error?.code === "ETIMEDOUT" || second.error?.code === "ETIMEDOUT",
  };
}

/** claude -p を複数ターンの stream-json で動かす（同じセッション）。ターンごとに結果を待つ。 */
function runClaude(cwd, env, turns) {
  return new Promise((resolveRun) => {
    const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--model", "haiku", "--max-turns", "14", "--setting-sources", "project", "--allowedTools", "Bash", "--no-session-persistence"];
    const p = spawn("claude", args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let buf = "";
    let errOut = "";
    let done = 0;
    const send = (text) => p.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`);
    p.stdout.on("data", (d) => {
      out += d;
      buf += d;
      let k;
      while ((k = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, k);
        buf = buf.slice(k + 1);
        if (line.includes('"type":"result"')) {
          done++;
          if (done < turns.length) send(turns[done]);
          else p.stdin.end();
        }
      }
    });
    p.stderr.on("data", (d) => { errOut += d; });
    send(turns[0]);
    const timer = setTimeout(() => p.kill("SIGKILL"), TURN_TIMEOUT_MS * turns.length);
    p.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ out, err: errOut.slice(0, 500), code, turnsDone: done });
    });
  });
}

/** PreToolUse（brw pr の呼び出し）の入力に session_id・cwd・tool_input.command があり、session_id が UserPromptSubmit と同じか。 */
export function preToolUseCheck(hookLog, sessionId, resumedSessionId, expectedCwd) {
  const pre = hookLog.filter((e) => e.event === "PreToolUse" && typeof e.command === "string" && e.command.includes("pr --title"));
  const ups = hookLog.filter((e) => e.event === "UserPromptSubmit");
  const firstUps = ups[0];
  const secondUps = ups[1];
  const idsAvailable = Boolean(sessionId && resumedSessionId && firstUps?.session_id && secondUps?.session_id);
  return {
    count: pre.length,
    upsCount: ups.length,
    observed: pre.length > 0 && ups.length >= 2 && idsAvailable,
    hasFields: pre.length > 0 && pre.every((e) => e.session_id && e.cwd && e.command && Array.isArray(e.keys) && ["session_id", "cwd"].every((k) => e.keys.includes(k))),
    sameThreadAcrossTurns: Boolean(sessionId && resumedSessionId && sessionId === resumedSessionId),
    firstUpsMatchesSession: Boolean(firstUps && firstUps.session_id === sessionId),
    secondUpsMatchesResumedSession: Boolean(secondUps && secondUps.session_id === resumedSessionId),
    preMatchesSession: pre.length > 0 && pre.every((e) => e.session_id === sessionId),
    cwdMatchesExpected: pre.length > 0 && typeof expectedCwd === "string" && pre.every((e) => e.cwd === expectedCwd),
  };
}

/** 1 回の観測（環境を作り、2 ターン動かし、項目を判定する）。終わったら一時の環境を消す。 */
async function observeOnce(stage) {
  const s = setupSandbox(stage);
  const host = stage === "codex" ? "codex" : "claude";
  const variantCd = stage === "claude-main-cdback";
  try {
    const start = stage === "claude-inside" ? s.wt : s.main;
    const branchesBefore = branchesOf(s.main);
    const prCmd = `node '${BRW}' pr --title "${PR_TITLE}" --completion "依頼を完了した" --verification "確認済み"`;
    const turn1 = variantCd
      ? `次の作業を実行してください。作業場所（${s.wt}）は commit 済みです。次のコマンドを 1 回だけ実行してください: cd '${s.wt}' && ${prCmd} ; cd '${s.main}'。gh や git push を直接使わないでください。最後に、実行結果の要点を 1 行で報告してください。`
      : `次の作業を、この順に実行してください。作業場所（${s.wt}）は commit 済みです。作業場所の中で次のコマンドを 1 回だけ実行してください: ${prCmd}。gh や git push を直接使わないでください。最後に、実行結果の要点を 1 行で報告してください。`;
    const turn2 = `検証が通らなかったので、同じ PR の続きを直してください。作業を始める前に、このセッションに追加された文脈（フックからの案内）に「新しい作業なら無視してかまいません」という文が含まれるかを、「あり」か「なし」の 1 語で答えてください。新しい作業ブランチは作らないでください。`;
    let codexHome;
    let env = s.env;
    if (host === "codex") {
      codexHome = prepareCodexHome(s.base, s.main);
      if (!codexHome.authenticated) {
        return { stage, host, skipped: "~/.codex/auth.json が無いため Codex の認証を用意できない", items: ["a", "b", "c", "d", "e"].map((name) => ({ name, verdict: "未観測", detail: "認証が無いため Codex を呼び出していない" })), writes: { prCreated: 0, receivePacks: 0 }, hookFires: [] };
      }
      env = { ...s.env, CODEX_HOME: codexHome.home };
    }
    const run = host === "codex" ? runCodex(start, env, [turn1, turn2], s.main) : await runClaude(start, env, [turn1, turn2]);
    const parsed = host === "codex" ? parseCodexJson(run.out) : parseStreamJson(run.out);
    const records = existsSync(join(s.main, ".git", "brw", "resume.json")) ? JSON.parse(readFileSync(join(s.main, ".git", "brw", "resume.json"), "utf8")).entries : null;
    const recordSession = records ? (records.find((e) => e.branch === BRANCH)?.sessionId ?? null) : undefined;
    const hookLog = existsSync(s.files.hookLog) ? readFileSync(s.files.hookLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    const sessionId = host === "codex" ? run.sessionId : parsed.sessionId;
    const resumedSessionId = host === "codex" ? run.resumedSessionId : parsed.sessionId;
    const upsOfSession = hookLog.filter((e) => e.event === "UserPromptSubmit").slice(0, 2);
    const ctx2 = (() => {
      try {
        return JSON.parse(upsOfSession[1]?.out || "{}").hookSpecificOutput?.additionalContext ?? null;
      } catch {
        return null;
      }
    })();
    const calls2 = run.commands2 ?? parsed.commands ?? parsed.bash ?? [];
    const resumeCall = calls2.find((c) => /brw\.mjs'?\s+resume\s/.test(c.command) && c.command.includes(BRANCH));
    const resumeEvidence = resumeEvidenceOf(resumeCall, hookLog, BRANCH, host);
    const expectedPreCwd = stage === "claude-main-cdback" ? s.main : s.wt;
    const preToolUse = preToolUseCheck(hookLog, sessionId, resumedSessionId, expectedPreCwd);
    const judged = judge({
      sessionId,
      resumedSessionId,
      recordSession,
      hookLog,
      ctx2,
      answer2: run.answer2 ?? parsed.results[1] ?? undefined,
      commands2: run.commands2?.map((b) => b.command) ?? (parsed.commands ?? parsed.bash ?? []).map((b) => b.command),
      resumeEvidence,
      branchesBefore,
      branchesAfter: branchesOf(s.main),
      branch: BRANCH,
      inside: stage === "claude-inside",
      preToolUse,
    });
    const pushes = existsSync(s.files.sshLog) ? readFileSync(s.files.sshLog, "utf8").split("\n").filter((l) => l.includes("git-receive-pack")).length : 0;
    const posts = existsSync(s.files.ghLog) ? readFileSync(s.files.ghLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.method === "POST" && e.applied).length : 0;
    return {
      stage,
      [host]: { exit: run.code, timeout: run.timeout ?? false, turnsDone: run.turnsDone, stderr: run.err, sessionId, resumedSessionId, results: parsed.results.map((r) => r.slice(0, 300)), unparsed: parsed.unparsed, events: parsed.events ?? undefined },
      hookFires: hookLog.map((e) => e.event),
      hookLog,
      ups: upsOfSession.map((e) => ({ cwd: e.cwd, prompt40: e.prompt40, exit: e.exit, returned: Boolean(e.out && e.out.trim()), ctxHead: (() => { try { return (JSON.parse(e.out || "{}")?.hookSpecificOutput?.additionalContext ?? "").slice(0, 60); } catch { return ""; } })() })),
      ctx2,
      preToolUse,
      bashCalls: (parsed.commands ?? parsed.bash ?? []).map((b) => ({ command: b.command.slice(0, 600), isError: b.isError ?? b.exitCode !== 0, output: (b.output ?? "").slice(0, 160) })),
      writes: { prCreated: posts, receivePacks: pushes },
      items: judged,
    };
  } finally {
    s.cleanup();
  }
}

async function main() {
  requireRealEnv("resume-observe.mjs");
  const i = process.argv.indexOf("--stage");
  const stage = i >= 0 ? process.argv[i + 1] : null;
  if (!["claude-main", "claude-inside", "claude-main-cdback", "codex"].includes(stage)) { console.error("使い方: --stage claude-main|claude-inside|claude-main-cdback|codex"); process.exit(2); }
  const host = stage === "codex" ? "codex" : "claude";
  const v = spawnSync(host, ["--version"], { encoding: "utf8" });
  const version = v.status === 0 ? (v.stdout ?? "").trim() : `${host} not available`;
  const attempts = [];
  const maxAttempts = host === "codex" ? 1 : MAX_ATTEMPTS;
  for (let n = 1; n <= maxAttempts; n++) {
    const r = await observeOnce(stage);
    attempts.push(r);
    console.log(JSON.stringify({ attempt: n, items: r.items.map((x) => [x.name, x.verdict]), host, exit: r[host]?.exit ?? null, hookFires: r.hookFires.length }));
    // 3 回すべて記録する（実行ごとの揺れを残すため。全項目が一致した時点で止める）
    const done = r.items.every((x) => x.verdict === "一致");
    if (done) break;
  }
  mkdirSync(WORK_DIR, { recursive: true });
  const file = join(WORK_DIR, `observe-96b-${stage}.json`);
  writeFileSync(file, JSON.stringify({ version, attempts }, null, 2));
  console.log(`結果の記録: ${file}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
