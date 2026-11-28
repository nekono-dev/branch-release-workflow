// 8.4: 実際の Claude Code・Codex のフックイベント到達を検証する（再実行用）。
// 使い方: BRW_REAL_ENV=1 node tests/real-env/host-events.mjs [--host claude|codex|both] [--scenario <ID>[,<ID>…]] [--dry-run] [--reset-counter] [--diagnose-only]
//   既定は --host both で全シナリオを順に実行する。--dry-run はホストを呼ばず、計画（シナリオ・呼び出し回数）だけを表示する。
// 実ホストの呼び出し回数には上限がある（Claude 12 回・Codex 8 回。カウンタは events/calls.json。--reset-counter で戻す）。
// 利用者の ~/.claude・~/.codex の設定ファイルは書き換えない（HOME・CODEX_HOME は変えない。認証は各 CLI が読む）。
// フックは tests/real-env/hook-logger.mjs を挟み、各イベントの入出力を /tmp/brw-real-env/hook-log/<host>.jsonl に記録する。
// 実 GitHub には書き込まない（origin は GitHub 形式の ssh URL だが、試験用 ssh でローカルの bare へ向ける。gh は偽物）。
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BRW_ROOT, WORK_DIR, readState, requireRealEnv, run } from "./common.mjs";
import { installCodexHooks } from "../../scripts/hook-install.mjs";
import { diagnoseHooks } from "../../scripts/hook-diagnose.mjs";
import * as publish from "../../scripts/publish.mjs";

requireRealEnv("host-events.mjs");

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const HOST = opt("--host", "both");
const DRY = flag("--dry-run");
const ONLY = opt("--scenario", null)?.split(",") ?? null;
if (!["claude", "codex", "both"].includes(HOST)) { console.error("--host は claude|codex|both"); process.exit(2); }

const EV = join(WORK_DIR, "events");
const LOG_DIR = join(WORK_DIR, "hook-log");
const OUT_DIR = join(EV, "out");
const BARE = join(EV, "bare.git");
const FAKEBIN = join(EV, "fakebin");
const LOGGER = realpathSync(join(BRW_ROOT, "tests/real-env/hook-logger.mjs"));
const BRW_CLI = realpathSync(join(BRW_ROOT, "scripts/brw.mjs"));
const COUNTER = join(EV, "calls.json");
// 上限（目安は Claude 12・Codex 8）。Codex は設定値の誤りでモデルに届かない呼び出しが 1 回あったため 14 回まで許す（worktree の再検証 4 回を含む）
const LIMITS = { claude: 12, codex: 14 };
const GH_SLUG = "nekono-dev/branch-release-workflow";
const ORIGIN = `git@github.com:${GH_SLUG}.git`;
const VERIFY_BRANCH = readState()?.branch ?? "verify/brw-base-1795253198";
const REPO_ID = { id: 4242, owner: "nekono-dev", name: "branch-release-workflow" };

const counter = () => (existsSync(COUNTER) ? JSON.parse(readFileSync(COUNTER, "utf8")) : { claude: 0, codex: 0 });
if (flag("--reset-counter")) { mkdirSync(EV, { recursive: true }); writeFileSync(COUNTER, JSON.stringify({ claude: 0, codex: 0 })); console.log("呼び出し回数を 0 に戻しました"); }

// ---- 作業場所 ----
const dirOf = (host, kind) => join(EV, `ws-${host}`, kind);
const branchOf = (host) => `dev/verify-${host}`;
const sh = (cwd, cmd, args, env) => run(cmd, args, { cwd, env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0" } });
const git = (cwd, ...a) => { const r = sh(cwd, "git", a, { GIT_SSH_COMMAND: join(FAKEBIN, "fakessh") }); if (r.code !== 0) throw new Error(`git ${a.join(" ")} (${cwd}): ${r.err.trim()}`); return r.out.trim(); };
const declaration = { workBranches: ["dev/*"], protectedBranches: ["main"], baseBranch: VERIFY_BRANCH, baseBranches: [VERIFY_BRANCH], namePattern: "^dev/[a-z0-9]+(-[a-z0-9]+)*$", maxNameLength: 54, autoApprove: { push: true, pullRequest: true }, preview: { provider: "none" } };

function writeFakes() {
  mkdirSync(FAKEBIN, { recursive: true });
  writeFileSync(join(FAKEBIN, "gh"), `#!/bin/sh\necho "$(date -u +%FT%TZ) gh $*" >> ${EV}/fake-gh.log\necho "fake gh: 実際の gh は呼ばれていません" >&2\nexit 9\n`);
  writeFileSync(join(FAKEBIN, "fakessh"), `#!/bin/sh\n# 試験用 ssh: GitHub ではなくローカルの bare リポジトリへ接続する（実 GitHub には届かない）\necho "$(date -u +%FT%TZ) fakessh $*" >> ${EV}/fake-ssh.log\nfor last; do :; done\ncase "$last" in\n  git-receive-pack*) exec git-receive-pack ${BARE} ;;\n  git-upload-pack*) exec git-upload-pack ${BARE} ;;\nesac\nexit 1\n`);
  chmodSync(join(FAKEBIN, "gh"), 0o755);
  chmodSync(join(FAKEBIN, "fakessh"), 0o755);
}

/** 作業場所を作る（冪等）。main 用・dev 用・フック未導入用（Claude のみ）。 */
function setupWorkspaces(host) {
  mkdirSync(EV, { recursive: true });
  writeFakes();
  if (!existsSync(BARE)) git(EV, "init", "-q", "--bare", "-b", "main", BARE);
  const root = join(EV, `ws-${host}`);
  mkdirSync(root, { recursive: true });
  const main = dirOf(host, "main");
  if (!existsSync(main)) {
    if (sh(EV, "git", ["--git-dir", BARE, "rev-parse", "--verify", "-q", "refs/heads/main"]).code === 0) {
      // 別ホストが先に main を作っていれば、それを複製する（履歴を揃える）
      git(root, "clone", "-q", BARE, main);
      git(main, "config", "user.name", "brw-verify"); git(main, "config", "user.email", "brw-verify@example.invalid");
      git(main, "remote", "set-url", "origin", ORIGIN);
    } else {
      mkdirSync(main, { recursive: true });
      git(main, "init", "-q", "-b", "main");
      git(main, "config", "user.name", "brw-verify"); git(main, "config", "user.email", "brw-verify@example.invalid");
      writeFileSync(join(main, ".branch-release-workflow.json"), `${JSON.stringify(declaration, null, 2)}\n`);
      writeFileSync(join(main, "README.txt"), "8.4 host events\n");
      git(main, "add", "-A"); git(main, "commit", "-q", "-m", "init");
      git(main, "remote", "add", "origin", ORIGIN);
      git(main, "push", "-q", "origin", "main");
    }
  }
  const dev = dirOf(host, "dev");
  if (!existsSync(dev)) {
    git(root, "clone", "-q", BARE, dev);
    git(dev, "config", "user.name", "brw-verify"); git(dev, "config", "user.email", "brw-verify@example.invalid");
    git(dev, "remote", "set-url", "origin", ORIGIN);
    git(dev, "checkout", "-q", "-b", branchOf(host));
    writeFileSync(join(dev, "change.txt"), `${host}\n`);
    git(dev, "add", "-A"); git(dev, "commit", "-q", "-m", "dev change");
  }
  for (const d of [main, dev]) {
    git(d, "config", "core.sshCommand", join(FAKEBIN, "fakessh"));
    appendFileSync(join(d, ".git/info/exclude"), ".claude/\n.codex/\n");
  }
  if (host === "claude") {
    // フック未導入の作業場所（main の複製）
    const nohook = dirOf(host, "nohook");
    if (!existsSync(nohook)) {
      git(root, "clone", "-q", BARE, nohook);
      git(nohook, "config", "user.name", "brw-verify"); git(nohook, "config", "user.email", "brw-verify@example.invalid");
      git(nohook, "remote", "set-url", "origin", ORIGIN);
    }
  }
  const claudeSettings = { hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `node "${LOGGER}" claude PreToolUse` }] }, { matcher: "mcp__.*", hooks: [{ type: "command", command: `node "${LOGGER}" claude PreToolUse` }] }],
    PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `node "${LOGGER}" claude PostToolUse` }] }],
    Stop: [{ hooks: [{ type: "command", command: `node "${LOGGER}" claude Stop` }] }],
  } };
  for (const d of [main, dev]) {
    if (host === "claude") { mkdirSync(join(d, ".claude"), { recursive: true }); writeFileSync(join(d, ".claude/settings.json"), `${JSON.stringify(claudeSettings, null, 2)}\n`); }
    if (host === "codex") {
      // 登録は install-codex.mjs --repo と同じ installCodexHooks。ランチャーだけ記録用ラッパーにする（同じ引数の形 <host> <イベント>）
      // 毎回作り直す（記録用ラッパーは BRW 自身の定義と見なされないため、再登録すると重複するのを避ける）
      rmSync(join(d, ".codex/hooks.json"), { force: true });
      const r = installCodexHooks({ repoDir: d, launcherPath: LOGGER });
      if (!["registered", "untrusted"].includes(r.status)) throw new Error(`Codex フックの登録に失敗: ${r.status} ${r.reasonCode}`);
    }
  }
}

// ---- 実行補助 ----
const hostEnv = () => ({ ...process.env, PATH: `${FAKEBIN}:${process.env.PATH}`, GIT_SSH_COMMAND: join(FAKEBIN, "fakessh"), BRW_REAL_ENV: "1", BRW_HOOK_LOG_DIR: LOG_DIR });
const logLines = (host) => { const f = join(LOG_DIR, `${host}.jsonl`); return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []; };
const sessionLog = (host, since) => logLines(host).slice(since);
const readJsonl = (text) => text.split("\n").filter((l) => l.startsWith("{")).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const bareRefs = () => sh(EV, "git", ["--git-dir", BARE, "for-each-ref", "--format=%(refname)"]).out.trim().split("\n").filter(Boolean);
const lines = (f) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : []);
const ghCalls = () => lines(join(EV, "fake-gh.log"));

/** ホストを 1 回呼ぶ。上限を超えたら止める。 */
function callHost(host, name, args, cwd, input) {
  const c = counter();
  if (c[host] >= LIMITS[host]) { console.error(`${host} の呼び出し回数が上限（${LIMITS[host]}）に達しました。--reset-counter で戻せます`); process.exit(3); }
  c[host] += 1;
  writeFileSync(COUNTER, JSON.stringify(c));
  mkdirSync(OUT_DIR, { recursive: true });
  const bin = host === "claude" ? "claude" : "codex";
  const r = spawnSync(bin, args, { cwd, env: hostEnv(), input: input ?? "", encoding: "utf8", timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  writeFileSync(join(OUT_DIR, `${name}.out`), r.stdout ?? "");
  writeFileSync(join(OUT_DIR, `${name}.err`), r.stderr ?? "");
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "", timedOut: r.error?.code === "ETIMEDOUT" };
}

const claudeArgs = (prompt, { allow, resume, plugin, persist, maxTurns = 4 } = {}) => [
  "-p", prompt, "--model", "haiku", "--max-turns", String(maxTurns), "--setting-sources", "project",
  "--output-format", "stream-json", "--verbose", "--include-hook-events",
  ...(allow ? ["--allowedTools", allow] : []), ...(resume ? ["--resume", resume] : persist ? [] : ["--no-session-persistence"]),
  ...(plugin ? ["--plugin-dir", plugin] : []),
];
/** Claude の stream-json から、Bash 呼び出しと結果・セッション ID・フックイベントを取り出す。 */
function parseClaude(out) {
  const evs = readJsonl(out);
  const tools = new Map();
  const res = [];
  let sessionId = null; let final = "";
  for (const e of evs) {
    sessionId ??= e.session_id ?? null;
    const content = e.message?.content;
    if (e.type === "assistant" && Array.isArray(content)) for (const b of content) if (b.type === "tool_use") tools.set(b.id, { name: b.name, command: b.input?.command });
    if (e.type === "user" && Array.isArray(content)) for (const b of content) if (b.type === "tool_result") {
      const t = tools.get(b.tool_use_id);
      res.push({ command: t?.command, isError: b.is_error === true, text: (typeof b.content === "string" ? b.content : JSON.stringify(b.content)).slice(0, 300) });
    }
    if (e.type === "result") final = String(e.result ?? "").slice(0, 200);
  }
  const hooks = evs.filter((e) => e.type === "system" && /hook/.test(e.subtype ?? "")).map((e) => ({ sub: e.subtype, name: e.hook_name ?? e.hook_event, event: e.hook_event, exit: e.exit_code, outcome: e.outcome, output: String(e.stdout ?? e.output ?? "").slice(0, 300) }));
  return { sessionId, results: res, hooks, final };
}
// addDir: Codex の workspace-write では .git が書き込み禁止で、brw の状態ファイル（.git/brw/work）を書けない。
//   状態の保存先だけを --add-dir で書き込み可にする（サンドボックスは無効にしない）。
// 承認が要る操作（サンドボックス外の権限の要求）で PermissionRequest フックが呼ばれる。approval_policy の untrusted は 0.167 では使えない
const codexArgs = (prompt, { resume, projectTrust, cd, noHookTrust, addDir } = {}) => [
  "exec", ...(resume ? ["resume", resume] : []), "--json", "--skip-git-repo-check",
  "-c", 'model_reasoning_effort="low"', "-c", 'approvals_reviewer="user"',
  ...(projectTrust ? ["-c", `projects."${projectTrust}".trust_level="trusted"`] : []),
  ...(noHookTrust ? ["--dangerously-bypass-hook-trust"] : []),
  ...(addDir ? ["--add-dir", addDir] : []),
  ...(cd ? ["-C", cd] : []), prompt,
];
function parseCodex(out) {
  const evs = readJsonl(out);
  const cmds = []; let threadId = null; let final = "";
  for (const e of evs) {
    if (e.type === "thread.started") threadId = e.thread_id;
    const it = e.item;
    if (e.type === "item.completed" && it?.type === "command_execution") cmds.push({ command: it.command, status: it.status, exit: it.exit_code, text: String(it.aggregated_output ?? "").slice(0, 300) });
    if (e.type === "item.completed" && it?.type === "agent_message") final = `${final} ${String(it.text ?? "").slice(0, 120)}`.trim();
  }
  return { threadId, cmds, final, eventTypes: [...new Set(evs.map((e) => e.type))] };
}


/** Codex が cwd で実際に読み込むフック（app-server の hooks/list。モデルを呼ばない）。[{sourcePath, trustStatus, command}] */
async function listLoadedHooks(cwds) {
  const { spawn } = await import("node:child_process");
  const args = ["app-server", ...cwds.flatMap((c) => ["-c", `projects."${c}".trust_level="trusted"`])];
  const p = spawn("codex", args, { stdio: ["pipe", "pipe", "ignore"], env: hostEnv() });
  let buf = ""; const waiting = new Map();
  p.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(l); if (m.id !== undefined && waiting.has(m.id)) waiting.get(m.id)(m); } catch { /* 無視 */ } } });
  const rpc = (id, method, params) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error(`${method} がタイムアウト`)), 30000); waiting.set(id, (m) => { clearTimeout(t); res(m); }); p.stdin.write(`${JSON.stringify({ id, method, params })}\n`); });
  try {
    await rpc(1, "initialize", { clientInfo: { name: "brw-host-events", version: "0" } });
    p.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    const r = await rpc(2, "hooks/list", { cwds });
    return Object.fromEntries((r.result?.data ?? []).map((e) => [e.cwd, e.hooks.map((h) => ({ sourcePath: h.sourcePath, trustStatus: h.trustStatus, command: h.command }))]));
  } finally { p.kill(); }
}

// ---- シナリオ ----
const WORKSPACE_FLAG = {};
const results = [];
const record = (r) => { results.push(r); console.log(`\n[${r.ok ? "OK" : r.knownIssue ? "既知の不一致" : "NG"}] ${r.host} / ${r.id}: ${r.title}`); if (!r.ok && r.knownIssue) console.log(`    既知の不一致: ${r.knownIssue}`); for (const l of r.notes) console.log(`    ${l}`); };
const ev = (log, event) => log.filter((l) => l.event === event);
const brief = (l) => `${l.event}${l.input?.tool_name ? `(${String(l.input.tool_input?.command ?? l.input.tool_name).slice(0, 60)})` : ""} -> exit ${l.exit}, 応答 ${l.stdout ? l.stdout.slice(0, 160) : "なし"}`;
const respOf = (l) => { try { return l.stdout ? JSON.parse(l.stdout) : null; } catch { return null; } };
const decisionOf = (l) => { const r = respOf(l); return r?.hookSpecificOutput?.permissionDecision ?? r?.hookSpecificOutput?.decision?.behavior ?? r?.decision ?? "none"; };
const headOf = (d) => git(d, "rev-parse", "HEAD");
/** brw の状態ディレクトリ（.git/brw/work）。Codex のサンドボックスへ書き込み可で渡すため、先に作っておく。 */
const stateDirOf = (dir) => { const f = publish.stateFileOf(dir); const d = f.slice(0, f.lastIndexOf("/")); mkdirSync(d, { recursive: true }); return d; };
const workState = (dir) => { const f = publish.stateFileOf(dir); const { state } = publish.load(f); return state; };

const ESC = "サンドボックスの制限で失敗したコマンドは、権限の昇格（サンドボックス外での実行の承認）を要求して再実行してください。";
const prompt1 = (cmds, extra = "") => `次の Bash コマンドを 1 つずつ、そのまま実行してください。途中で失敗・拒否されても、残りのコマンドも必ず実行してください。他のことはせず、各コマンドの結果（成功か拒否か失敗か）だけ短く答えてください。\n${extra}\n${cmds.map((c, i) => `${i + 1}. ${c}`).join("\n")}`;
const gitCmds = (host) => ({ push: `git push origin ${branchOf(host)}`, tag: "git tag v-verify" });

const SCENARIOS = {
  claude: [
    { id: "C1", title: "保護ブランチ main 上の git commit の拒否（PreToolUse deny）", run() {
      const d = dirOf("claude", "main"); const before = headOf(d); const since = logLines("claude").length;
      const c = callHost("claude", "C1", claudeArgs(prompt1(["git commit --allow-empty -m x"])), d);
      const log = sessionLog("claude", since); const p = parseClaude(c.out);
      const pre = ev(log, "PreToolUse");
      const ok = pre.some((l) => decisionOf(l) === "deny") && headOf(d) === before;
      return { ok, notes: [...log.map(brief), `ホスト結果: ${JSON.stringify(p.results)}`, `HEAD 不変: ${headOf(d) === before}`], diag: { event: "PreToolUse", expect: "deny" } };
    } },
    { id: "C2", title: "開発ブランチへの通常 push の確認省略（allow）と参照を動かす操作の確認（ask）", run() {
      const d = dirOf("claude", "dev"); const since = logLines("claude").length; const g = gitCmds("claude");
      const c = callHost("claude", "C2", claudeArgs(prompt1([g.push, g.tag])), d);
      const log = sessionLog("claude", since); const p = parseClaude(c.out);
      const pre = ev(log, "PreToolUse");
      const pushAllowed = pre.some((l) => /git push/.test(l.input?.tool_input?.command ?? "") && decisionOf(l) === "allow");
      const pushed = bareRefs().includes(`refs/heads/${branchOf("claude")}`);
      const tagLog = pre.find((l) => /git tag/.test(l.input?.tool_input?.command ?? ""));
      return { ok: pushAllowed && pushed, notes: [...log.map(brief), `ホスト結果: ${JSON.stringify(p.results)}`, `bare に push 済み: ${pushed}`, `git tag の判定: ${tagLog ? decisionOf(tagLog) : "イベントなし"}`] };
    } },
    { id: "C3", title: "gh pr merge・--auto の拒否、gh pr create の扱い（偽 gh は呼ばれない）", run() {
      const d = dirOf("claude", "dev"); const since = logLines("claude").length; const g0 = ghCalls().length;
      const c = callHost("claude", "C3", claudeArgs(prompt1(["gh pr merge 1 --squash", "gh pr merge 1 --auto --squash", `gh pr create --base main --head ${branchOf("claude")} --title t --body b`]), { maxTurns: 5 }), d);
      const log = sessionLog("claude", since); const p = parseClaude(c.out);
      const pre = ev(log, "PreToolUse");
      const dec = (re) => { const l = pre.find((x) => re.test(x.input?.tool_input?.command ?? "")); return l ? decisionOf(l) : "イベントなし"; };
      const merge = dec(/pr merge 1 --squash/); const auto = dec(/--auto/); const create = dec(/pr create/);
      const g = ghCalls().slice(g0);
      return { ok: merge === "deny" && auto === "deny" && !g.some((x) => /pr merge/.test(x)), notes: [...log.map(brief), `判定 merge=${merge} auto=${auto} pr create=${create}`, `偽 gh の呼び出し: ${g.length ? g.join(" | ") : "なし"}`, `ホスト結果: ${JSON.stringify(p.results)}`] };
    } },
    { id: "C4", title: "brw work start 後の PostToolUse による作業 ID の関連付け", run() {
      const d = dirOf("claude", "dev"); const since = logLines("claude").length;
      const c = callHost("claude", "C4", claudeArgs(prompt1([`node ${BRW_CLI} work start`]), { allow: "Bash(node:*)", persist: true }), d);
      const log = sessionLog("claude", since); const p = parseClaude(c.out);
      const post = ev(log, "PostToolUse"); const st = workState(d); const w = st.works?.[st.current];
      const sid = post[0]?.input?.session_id;
      WORKSPACE_FLAG.claudeWork = w?.workId;
      return { ok: !!w?.sessionId && w.sessionId === sid, notes: [...log.map(brief), `tool_response の形: ${post[0] ? JSON.stringify(post[0].input.tool_response).slice(0, 240) : "なし"}`, `PostToolUse の session_id=${sid ?? "なし"} / 状態の sessionId=${w?.sessionId ?? "なし"} / 作業 ${w?.workId}`] };
    } },
    { id: "C5", title: "ready 状態の作業を残して終了したときの Stop の案内（block・継続）", run() {
      const d = dirOf("claude", "dev"); const st = workState(d); const w = st.works[st.current];
      if (!w?.sessionId) return { ok: false, notes: ["C4 の関連付けがありません（先に C4）"] };
      const r = w.status === "ready" ? { ok: true } : publish.markReady(d, w.workId, { completion: "検証", verification: { passed: true, summary: "検証" }, repository: REPO_ID });
      if (!r.ok) return { ok: false, notes: [`markReady に失敗: ${r.error?.code ?? JSON.stringify(r.error)}`] };
      const since = logLines("claude").length;
      const c = callHost("claude", "C5", claudeArgs("作業は終わりました。ひとこと「完了」と答えてください。", { resume: w.sessionId, maxTurns: 4 }), d);
      const log = sessionLog("claude", since); const p = parseClaude(c.out);
      const stops = ev(log, "Stop");
      const blocked = stops.some((l) => decisionOf(l) === "block");
      const after = stops.filter((l) => l.input?.stop_hook_active === true);
      return { ok: blocked, notes: [...log.map(brief), `block 応答の理由: ${(stops.find((l) => decisionOf(l) === "block") && respOf(stops.find((l) => decisionOf(l) === "block")).reason?.slice(0, 120)) ?? "なし"}`, `Stop の回数 ${stops.length}（stop_hook_active=true は ${after.length} 回）`, `ホストの最終応答: ${p.final}`, `フックイベント: ${JSON.stringify(p.hooks).slice(0, 300)}`] };
    } },
    { id: "C6", title: "作業の禁止（restrict --no-push）後の push の拒否と、Stop が案内しないこと", run() {
      const d = dirOf("claude", "dev"); const st = workState(d); const w = st.works[st.current];
      const rr = publish.setRestrictions(d, w.workId, { noPush: true });
      if (!rr.ok) return { ok: false, notes: [`setRestrictions に失敗: ${rr.error?.message}`] };
      const since = logLines("claude").length;
      const c = callHost("claude", "C6", claudeArgs(prompt1([gitCmds("claude").push])), d);
      const log = sessionLog("claude", since); const p = parseClaude(c.out);
      const push = ev(log, "PreToolUse").find((l) => /git push/.test(l.input?.tool_input?.command ?? ""));
      const stops = ev(log, "Stop");
      return { ok: !!push && decisionOf(push) === "deny" && stops.every((l) => decisionOf(l) === "none"), notes: [...log.map(brief), `ホスト結果: ${JSON.stringify(p.results)}`] };
    } },
    { id: "C7", title: "フック未導入の作業場所では main への commit がそのまま通る（診断の not-installed と一致）", run() {
      const d = dirOf("claude", "nohook"); const before = headOf(d); const since = logLines("claude").length;
      const c = callHost("claude", "C7", claudeArgs(prompt1(["git commit --allow-empty -m x"]), { allow: "Bash(git:*)" }), d);
      const log = sessionLog("claude", since); const p = parseClaude(c.out);
      return { ok: log.length === 0 && headOf(d) !== before, notes: [`フックイベント数 ${log.length}（0 が期待）`, `HEAD が進んだ: ${headOf(d) !== before}`, `ホスト結果: ${JSON.stringify(p.results)}`], diag: { notInstalled: true } };
    } },
    { id: "C8", title: "プラグインとして読み込んだ実体の hooks/hooks.json（${CLAUDE_PLUGIN_ROOT} の展開）で main の commit を拒否", run() {
      const d = dirOf("claude", "nohook"); const before = headOf(d);
      const c = callHost("claude", "C8", claudeArgs(prompt1(["git commit --allow-empty -m y"]), { allow: "Bash(git:*)", plugin: BRW_ROOT }), d);
      const p = parseClaude(c.out);
      const denied = p.results.some((r) => /branch-release-workflow|拒否|deny|blocked/i.test(r.text) && r.isError);
      const hookInfo = p.hooks.filter((h) => /PreToolUse/.test(h.event ?? h.name ?? ""));
      return { ok: headOf(d) === before && denied, notes: [`HEAD 不変: ${headOf(d) === before}`, `ホスト結果: ${JSON.stringify(p.results)}`, `フックイベント: ${JSON.stringify(hookInfo).slice(0, 500)}`] };
    } },
  ],
  codex: [
    { id: "X1", title: "フック未承認（プロジェクトは信頼・フックはハッシュ未承認）では main の commit にフックが届かない", run() {
      const d = dirOf("codex", "main"); const before = headOf(d); const since = logLines("codex").length;
      const c = callHost("codex", "X1", codexArgs(prompt1(["git commit --allow-empty -m x"]), { projectTrust: d, cd: d }), d);
      const log = sessionLog("codex", since); const p = parseCodex(c.out);
      return { ok: log.length === 0, notes: [`フックイベント数 ${log.length}（0 が期待: 未承認フックは読み込まれない）`, `HEAD が進んだ: ${headOf(d) !== before}`, `Codex の実行: ${JSON.stringify(p.cmds)}`, `事象の種類: ${p.eventTypes.join(",")}`, `stderr: ${c.err.slice(0, 300).replace(/\n/g, " ")}`], diag: { trust: "untrusted" } };
    } },
    { id: "X2", title: "フックを信頼した状態で main の commit を拒否（PreToolUse deny）", run() {
      const d = dirOf("codex", "main"); const before = headOf(d); const since = logLines("codex").length;
      const c = callHost("codex", "X2", codexArgs(prompt1(["git commit --allow-empty -m x"]), { projectTrust: d, noHookTrust: true, cd: d }), d);
      const log = sessionLog("codex", since); const p = parseCodex(c.out);
      return { ok: ev(log, "PreToolUse").some((l) => decisionOf(l) === "deny") && headOf(d) === before, notes: [...log.map(brief), `Codex の実行: ${JSON.stringify(p.cmds)}`, `HEAD 不変: ${headOf(d) === before}`], diag: { trust: "trusted", event: "PreToolUse", expect: "deny" } };
    } },
    { id: "X3", title: "push の確認省略（PermissionRequest allow）・参照を動かす操作・gh pr merge/--auto の拒否", run() {
      const d = dirOf("codex", "dev"); const since = logLines("codex").length; const g0 = ghCalls().length; const g = gitCmds("codex");
      const c = callHost("codex", "X3", codexArgs(prompt1(["git commit --allow-empty -m x", g.push, g.tag, "gh pr merge 1 --squash", "gh pr merge 1 --auto --squash", `gh pr create --base main --head ${branchOf("codex")} --title t --body b`], ESC), { projectTrust: d, noHookTrust: true, cd: d }), d);
      const log = sessionLog("codex", since); const p = parseCodex(c.out);
      const dec = (event, re) => { const l = ev(log, event).find((x) => re.test(x.input?.tool_input?.command ?? "")); return l ? decisionOf(l) : "イベントなし"; };
      const pushed = bareRefs().includes(`refs/heads/${branchOf("codex")}`);
      const gc = ghCalls().slice(g0);
      const mergeDenied = dec("PreToolUse", /pr merge 1 --squash/) === "deny" && dec("PreToolUse", /--auto/) === "deny";
      return { ok: mergeDenied && !gc.some((x) => /pr merge/.test(x)) && dec("PermissionRequest", /git push/) === "allow" && pushed, notes: [...log.map(brief), `push: Pre=${dec("PreToolUse", /git push/)} Perm=${dec("PermissionRequest", /git push/)} / bare 反映 ${pushed}`, `tag: Pre=${dec("PreToolUse", /git tag/)} Perm=${dec("PermissionRequest", /git tag/)}`, `merge Pre=${dec("PreToolUse", /pr merge 1 --squash/)} auto Pre=${dec("PreToolUse", /--auto/)} / pr create Pre=${dec("PreToolUse", /pr create/)} Perm=${dec("PermissionRequest", /pr create/)}`, `偽 gh の呼び出し: ${gc.length ? gc.join(" | ") : "なし"}`, `Codex の実行: ${JSON.stringify(p.cmds)}`] };
    } },
    { id: "X4", title: "brw work start 後の PostToolUse による作業 ID の関連付け", run() {
      const d = dirOf("codex", "dev"); const since = logLines("codex").length;
      const c = callHost("codex", "X4", codexArgs(prompt1([`node ${BRW_CLI} work start`]), { projectTrust: d, noHookTrust: true, cd: d, addDir: stateDirOf(d) }), d);
      const log = sessionLog("codex", since); const p = parseCodex(c.out);
      const post = ev(log, "PostToolUse"); const st = workState(d); const w = st.works?.[st.current];
      const sid = post[0]?.input?.session_id;
      return { ok: !!w?.sessionId && w.sessionId === sid, notes: [...log.map(brief), `tool_response の形: ${post[0] ? JSON.stringify(post[0].input.tool_response).slice(0, 240) : "なし"}`, `PostToolUse の session_id=${sid ?? "なし"} / 状態の sessionId=${w?.sessionId ?? "なし"} / thread_id=${p.threadId}`, `Codex の実行: ${JSON.stringify(p.cmds)}`] };
    } },
    { id: "X5", title: "ready 状態の作業を残して終了したときの Stop の案内（Codex の応答契約）", run() {
      const d = dirOf("codex", "dev"); const st = workState(d); const w = st.works[st.current];
      if (!w?.sessionId) return { ok: false, notes: ["X4 の関連付けがありません（先に X4）"] };
      const r = w.status === "ready" ? { ok: true } : publish.markReady(d, w.workId, { completion: "検証", verification: { passed: true, summary: "検証" }, repository: REPO_ID });
      if (!r.ok) return { ok: false, notes: [`markReady に失敗: ${r.error?.code ?? JSON.stringify(r.error)}`] };
      const since = logLines("codex").length;
      const c = callHost("codex", "X5", codexArgs("作業は終わりました。ひとこと「完了」と答えてください。", { resume: w.sessionId, projectTrust: d, noHookTrust: true }), d);
      const log = sessionLog("codex", since); const p = parseCodex(c.out);
      const stops = ev(log, "Stop");
      const blocked = stops.some((l) => decisionOf(l) === "block");
      return { ok: blocked, notes: [...log.map(brief), `Stop の回数 ${stops.length}（stop_hook_active=true は ${stops.filter((l) => l.input?.stop_hook_active === true).length} 回）`, `Stop の入力の項目: ${stops[0] ? Object.keys(stops[0].input).join(",") : "なし"}`, `Codex の実行: ${JSON.stringify(p.cmds)} / 最終: ${p.final}`, `事象の種類: ${p.eventTypes.join(",")}`] };
    } },
    { id: "X6", title: "linked worktree: brw create が .codex/ を有効化した worktree では親の登録が届き noPush の push と gh pr merge が拒否される／.codex/ の無い worktree はフック 0 件で診断も not-installed", async run() {
      // 親チェックアウト（実ランチャーで登録）から、実際の brw create で worktree を作る。Codex は worktree で親の .codex を読まない（0.167 実機）
      const team = join(EV, "ws-codex", "team"); const real = realpathSync(join(BRW_ROOT, "scripts/agent-hooks.mjs"));
      if (!existsSync(team)) {
        git(join(EV, "ws-codex"), "clone", "-q", BARE, team);
        git(team, "config", "user.name", "brw-verify"); git(team, "config", "user.email", "brw-verify@example.invalid");
        git(team, "remote", "set-url", "origin", ORIGIN); git(team, "config", "core.sshCommand", join(FAKEBIN, "fakessh"));
        git(team, "branch", VERIFY_BRANCH, "main");
        appendFileSync(join(team, ".git/info/exclude"), ".claude/\n.codex/\n.worktree/\n");
        installCodexHooks({ repoDir: team, launcherPath: real });
      }
      const wa = join(team, ".worktree/dev-x6a"); const wb = join(EV, "ws-codex", "wt-unregistered");
      mkdirSync(join(EV, "codex-home-empty"), { recursive: true });
      let created = "";
      if (!existsSync(wa)) { const r = sh(team, "node", [BRW_CLI, "create", "x6a"], { GIT_SSH_COMMAND: join(FAKEBIN, "fakessh"), CODEX_HOME: join(EV, "codex-home-empty") }); created = r.out + r.err; if (r.code !== 0) return { ok: false, notes: [`brw create に失敗: ${created.slice(0, 300)}`] }; }
      if (!existsSync(wb)) git(team, "worktree", "add", "-q", "-b", "dev/x6b", wb);
      const registered = existsSync(join(wa, ".codex")) && !existsSync(join(wa, ".codex/hooks.json"));
      const loaded = await listLoadedHooks([wa, wb]);
      const srcOf = (d) => [...new Set((loaded[d] ?? []).map((h) => `${h.sourcePath.replace(EV, "")}(${h.trustStatus})`))].join(",") || "なし";
      const wtd = (dir, trust) => diagnoseHooks({ pluginRoot: BRW_ROOT, codexRepoDir: dir, host: "codex", codexTrust: trust }).routes.filter((r) => r.environment === "local").map((r) => `${r.status}${r.reasonCode ? `[${r.reasonCode}]` : ""}`);
      const dA = wtd(wa, "trusted"); const dAu = wtd(wa, "untrusted"); const dB = wtd(wb, "trusted");
      const diagOk = dA.every((x) => x === "active") && dAu.every((x) => x.startsWith("untrusted")) && dB.every((x) => x === "not-installed[worktree-not-registered]");
      // 観測のため、親チェックアウトの登録のランチャーを記録用ラッパーに置き換える（入出力を素通しする。診断は置き換え前に済ませてある）
      const f = join(team, ".codex/hooks.json"); writeFileSync(f, readFileSync(f, "utf8").split(real).join(LOGGER));
      const id = publish.startWork(wa, {}).work.workId;
      const rr = publish.setRestrictions(wa, id, { noPush: true });
      if (!rr.ok) return { ok: false, notes: [`setRestrictions に失敗: ${rr.error?.message}`] };
      const since = logLines("codex").length;
      const c1 = callHost("codex", "X6a", codexArgs(prompt1(["git push origin dev/x6a", "gh pr merge 1 --squash"]), { projectTrust: wa, noHookTrust: true, cd: wa }), wa);
      const logA = sessionLog("codex", since); const pA = parseCodex(c1.out);
      const dec = (log, re) => { const l = ev(log, "PreToolUse").find((x) => re.test(x.input?.tool_input?.command ?? "")); return l ? decisionOf(l) : "イベントなし"; };
      const refsA = bareRefs();
      const g0 = ghCalls().length; const since2 = logLines("codex").length;
      const c2 = callHost("codex", "X6b", codexArgs(prompt1(["gh pr merge 1 --squash"]), { projectTrust: wb, noHookTrust: true, cd: wb }), wb);
      const logB = sessionLog("codex", since2); const pB = parseCodex(c2.out);
      const ghB = ghCalls().slice(g0);
      const okA = registered && dec(logA, /git push/) === "deny" && dec(logA, /pr merge/) === "deny" && !refsA.includes("refs/heads/dev/x6a");
      const okB = logB.length === 0 && ghB.some((x) => /pr merge/.test(x));
      return { ok: okA && okB && diagOk, notes: [`brw create の出力: ${created.replace(/\n/g, " ").slice(0, 240)}`, `worktree: .codex/ あり・hooks.json なし = ${registered}`, `Codex が読み込むフック（hooks/list）: 有効化した worktree=${srcOf(wa)} / .codex/ の無い worktree=${srcOf(wb)}`, `診断 登録済み worktree 信頼済み=${[...new Set(dA)]} 未信頼=${[...new Set(dAu)]} / 未登録 worktree=${[...new Set(dB)]}`, `登録済み worktree: push=${dec(logA, /git push/)} merge=${dec(logA, /pr merge/)} bare に未反映=${!refsA.includes("refs/heads/dev/x6a")}（Codex の実行 ${JSON.stringify(pA.cmds)}）`, `未登録 worktree: フックイベント ${logB.length} 件、偽 gh の pr merge 呼び出し ${ghB.length} 件（フックが届かないため実行された）（${JSON.stringify(pB.cmds).slice(0, 200)}）`] };
    } },
    { id: "X7", title: "作業の禁止（restrict --no-push）後の push の拒否と、Stop が案内しないこと（親チェックアウト）", run() {
      const d = dirOf("codex", "dev"); const st = workState(d); const w = st.works[st.current];
      const rr = publish.setRestrictions(d, w.workId, { noPush: true });
      if (!rr.ok) return { ok: false, notes: [`setRestrictions に失敗: ${rr.error?.message}`] };
      const since = logLines("codex").length;
      const c = callHost("codex", "X7", codexArgs(prompt1([gitCmds("codex").push]), { projectTrust: d, noHookTrust: true, cd: d }), d);
      const log = sessionLog("codex", since); const p = parseCodex(c.out);
      const push = ev(log, "PreToolUse").find((l) => /git push/.test(l.input?.tool_input?.command ?? ""));
      const stops = ev(log, "Stop");
      return { ok: !!push && decisionOf(push) === "deny" && stops.every((l) => decisionOf(l) === "none"), notes: [...log.map(brief), `Codex の実行: ${JSON.stringify(p.cmds)}`] };
    } },
  ],
};

// ---- 計画表示 ----
const hosts = HOST === "both" ? ["claude", "codex"] : [HOST];
const todo = hosts.flatMap((h) => SCENARIOS[h].filter((s) => !ONLY || ONLY.includes(s.id)).map((s) => ({ host: h, ...s })));
console.log(`== 8.4 実イベント検証の計画 ==`);
console.log(`作業場所: ${EV}（記録: ${LOG_DIR}、ホストの生出力: ${OUT_DIR}）`);
console.log(`呼び出し済み: claude ${counter().claude}/${LIMITS.claude}、codex ${counter().codex}/${LIMITS.codex}`);
for (const h of hosts) console.log(`  ${h}: ${todo.filter((t) => t.host === h).map((t) => t.id).join(", ")}（${todo.filter((t) => t.host === h).length} 回の呼び出し）`);
for (const t of todo) console.log(`  - ${t.host}/${t.id}: ${t.title}`);
if (DRY) { console.log("--dry-run のためホストは呼びません。"); process.exit(0); }

// ---- 実行 ----
if (!flag("--diagnose-only")) {
  for (const h of hosts) setupWorkspaces(h);
  for (const t of todo) {
    let r;
    try { r = await t.run(); } catch (e) { r = { ok: false, notes: [`例外: ${e.message}`] }; }
    record({ host: t.host, id: t.id, title: t.title, ...r });
    if (r.diag) t.diag = r.diag;
  }
}

// ---- 診断との突き合わせ ----
console.log("\n== 診断（hook-diagnose）との突き合わせ ==");
const summarize = (routes, h) => Object.fromEntries(routes.filter((r) => r.host === h && r.environment === "local").map((r) => [r.event, r.status]));
const diagMatch = [];
if (hosts.includes("claude") && existsSync(dirOf("claude", "main"))) {
  const d = diagnoseHooks({ pluginRoot: BRW_ROOT, codexRepoDir: dirOf("codex", "dev"), host: "claude" });
  const s = summarize(d.routes, "claude");
  console.log(`  claude（プラグイン BRW_ROOT）: ${JSON.stringify(s)}`);
  diagMatch.push(["claude 診断(プラグイン経路)", Object.values(s).every((v) => v === "active")]);
  // フック未導入の診断: hooks/hooks.json の無いプラグインルートで検査する
  const empty = join(EV, "empty-plugin"); mkdirSync(empty, { recursive: true });
  const dn = diagnoseHooks({ pluginRoot: empty, codexRepoDir: dirOf("codex", "dev"), host: "claude" });
  const sn = summarize(dn.routes, "claude");
  console.log(`  claude（フック無しのプラグインルート）: ${JSON.stringify(sn)}`);
  diagMatch.push(["claude 未導入の診断", Object.values(sn).every((v) => v === "not-installed")]);
}
if (hosts.includes("codex") && existsSync(dirOf("codex", "dev"))) {
  // 診断は「実際のランチャー」の登録と照合する。観測用の hooks.json はランチャーを記録用ラッパーに替えているため、
  // 実ランチャーで登録した診断用の作業場所（ラッパーは入出力を素通しするだけ）で、同じ信頼状態を渡して診断する
  const diagDir = join(EV, "ws-codex", "diag");
  if (!existsSync(diagDir)) { mkdirSync(diagDir, { recursive: true }); git(diagDir, "init", "-q", "-b", "main"); }
  const inst = installCodexHooks({ repoDir: diagDir, launcherPath: realpathSync(join(BRW_ROOT, "scripts/agent-hooks.mjs")) });
  console.log(`  診断用の登録（実ランチャー）: ${inst.status}`);
  for (const trust of ["untrusted", "trusted"]) {
    const d = diagnoseHooks({ pluginRoot: BRW_ROOT, codexRepoDir: diagDir, host: "codex", codexTrust: trust });
    const s = summarize(d.routes, "codex");
    console.log(`  codex（codexTrust=${trust}）: ${JSON.stringify(s)}`);
    diagMatch.push([`codex codexTrust=${trust}`, Object.values(s).every((v) => v === (trust === "trusted" ? "active" : "untrusted"))]);
  }
  const dn = diagnoseHooks({ pluginRoot: BRW_ROOT, codexRepoDir: join(EV, "ws-codex", "wt-empty"), host: "codex", codexTrust: "unknown" });
  console.log(`  codex（.codex の無い場所）: ${JSON.stringify(summarize(dn.routes, "codex"))}`);
}
for (const [n, ok] of diagMatch) console.log(`  [${ok ? "一致" : "不一致"}] ${n}`);

console.log("\n== 結果 ==");
for (const r of results) console.log(`  [${r.ok ? "OK" : r.knownIssue ? "既知の不一致" : "NG"}] ${r.host}/${r.id}`);
const c = counter();
console.log(`呼び出し回数: claude ${c.claude}/${LIMITS.claude}、codex ${c.codex}/${LIMITS.codex}`);
writeFileSync(join(EV, "report.json"), JSON.stringify({ at: new Date().toISOString(), results, diagMatch }, null, 2));
process.exit(results.every((r) => r.ok || r.knownIssue) && diagMatch.every(([, ok]) => ok) ? 0 : 1);
