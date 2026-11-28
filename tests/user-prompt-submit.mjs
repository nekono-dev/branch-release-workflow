// UserPromptSubmit の案内・PostToolUse の再開の関連付け・登録と診断（brw-pr-handoff 9.4）の試験。selftest.mjs から呼ばれる。
// 実際の scripts/agent-hooks.mjs を子プロセスでも動かし、一時リポジトリ・bare remote・worktree は実際の git で作る。
// 偽の gh・ssh を PATH の先頭に置き、呼ばれた回数が 0 であることで通信をしないことも確かめる。
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitOut, mkRepoWithRemote, mkWorktree } from "./support/git-fixture.mjs";
import { hookInput } from "./support/hook-fixtures.mjs";
import { readRecords, writeRecord } from "../scripts/resume-record.mjs";
import * as rr from "../scripts/resume-record.mjs";

// 読み込めないときは各関数を失敗として数え、試験の項目が RED として残るようにする
const agent = await import("../scripts/agent-hooks.mjs").catch(() => ({}));
const handleHook = agent.handleHook ?? (() => ({ missing: "未実装" }));
const harmlessText = agent.harmlessText ?? (() => "未実装");
const HOST_EVENTS = agent.HOST_EVENTS ?? {};
const hookInstall = await import("../scripts/hook-install.mjs").catch(() => ({}));
const hookDiagnose = await import("../scripts/hook-diagnose.mjs").catch(() => ({}));

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const AGENT = join(root, "scripts", "agent-hooks.mjs");
const BRW = join(root, "scripts", "brw.mjs");
const CONFIG = { workBranches: ["dev/*"], protectedBranches: ["main"], baseBranch: "develop" };
const SESSION = "s-9-4";
const OTHER = "s-other";
const PR_URL = "https://github.com/acme/app/pull/1";
const HOUR = 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const RESUME_FILE = (dir) => join(dir, ".git", "brw", "resume.json");

/** 本体を用意する。branch を遠隔へ push する（pushed）。worktree なら作業場所を作り、そこのブランチを push する。 */
const fixture = ({ branch = "dev/a", pushed = true, worktree = false, config = CONFIG } = {}) => {
  const r = mkRepoWithRemote({ branch: "main", config });
  let wt = null;
  if (worktree) wt = mkWorktree(r.dir, branch);
  else gitOut(r.dir, "branch", branch);
  if (pushed) gitOut(r.dir, "push", "-q", "origin", branch);
  return { ...r, branch, wt };
};

/** 再開の記録を 1 件書く（既定は dev/a・同じセッション・今の時刻・PR あり）。 */
const record = (dir, over = {}) => {
  const r = writeRecord(dir, { branch: "dev/a", prUrl: PR_URL, repository: "acme/app", sessionId: SESSION, at: iso(Date.now()), ...over });
  if (!r.ok) throw new Error(`記録の準備に失敗: ${r.message}`);
  return r;
};

/** UserPromptSubmit の入力（prompt を足す）。 */
const upsOf = (host, cwd, { sessionId = SESSION, omit = [] } = {}) => {
  const ev = hookInput(host, "UserPromptSubmit", { cwd, sessionId, omit });
  delete ev.tool_name;
  delete ev.tool_input;
  delete ev.tool_response;
  ev.prompt = "続きを直してください";
  for (const k of omit) delete ev[k];
  return ev;
};

/** 子プロセスで scripts/agent-hooks.mjs を実行する（標準入力の JSON、追加の環境変数、既定で外す環境変数）。 */
const runCli = (host, event, input, { env = {}, drop = [], pathPrefix = null } = {}) => {
  const e = { ...process.env, ...env };
  for (const k of drop) delete e[k];
  if (pathPrefix) e.PATH = `${pathPrefix}:${e.PATH}`;
  const text = typeof input === "string" ? input : JSON.stringify(input);
  const r = spawnSync(process.execPath, [AGENT, host, event], { input: text, encoding: "utf8", env: e, timeout: 60000 });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
};

/** 偽の gh・ssh を置き、呼ばれたら記録する。戻り値は PATH の先頭に足すディレクトリと、呼び出しの記録ファイル。 */
const fakeNetworkTools = () => {
  const bin = mkdtempSync(join(tmpdir(), "brw-94-bin-"));
  const log = join(bin, "calls.log");
  for (const name of ["gh", "ssh"]) {
    const p = join(bin, name);
    writeFileSync(p, `#!/bin/sh\necho "${name} $*" >> "${log}"\nexit 1\n`);
    chmodSync(p, 0o755);
  }
  return { bin, log, calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length : 0) };
};

/** 副作用の確認に使う状態（作業場所・参照・再開の記録・遠隔の参照）。 */
const snapshot = (dir) => ({
  worktrees: gitOut(dir, "worktree", "list", "--porcelain"),
  refs: gitOut(dir, "for-each-ref", "--format=%(refname) %(objectname)"),
  record: existsSync(RESUME_FILE(dir)) ? readFileSync(RESUME_FILE(dir), "utf8") : null,
});

/** 案内の応答から文脈を取り出す（無ければ null）。 */
const contextOf = (out) => {
  if (out.trim() === "") return null;
  const j = JSON.parse(out);
  return j?.hookSpecificOutput?.hookEventName === "UserPromptSubmit" ? j.hookSpecificOutput.additionalContext : undefined;
};

/** 制御文字・書式文字・行区切りを含まないか（案内の文面）。 */
const hasUnsafe = (s) => /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}\p{Cs}]/u.test(s);

const withEnv = (vars, fn) => {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
};

export const runUserPromptSubmitChecks = async (eq) => {
  // ---- 見つかる場合: 両ホストで、文脈を 1 件返す（500 文字以内・ブランチ名・2 つの使い分け） ----
  for (const host of ["claude", "codex"]) {
    const t = fixture();
    record(t.dir);
    const res = runCli(host, "UserPromptSubmit", upsOf(host, t.dir), { drop: ["CLAUDE_PROJECT_DIR"] });
    const ctx = contextOf(res.out);
    eq(`brw-pr-handoff/9.4 ${host}: 記録が見つかるとき、UserPromptSubmit の文脈を返し、終了コード 0 にする`, [res.code, typeof ctx === "string"], [0, true]);
    eq(`brw-pr-handoff/9.4 ${host}: 文脈は 500 文字以内で、ブランチ名・続きの再開（resume）・新しい作業（create）を含む`, [typeof ctx === "string" && ctx.length <= 500, typeof ctx === "string" && ctx.includes("dev/a") && ctx.includes("resume dev/a") && ctx.includes("create") && ctx.includes("削除済み")], [true, true]);
    eq(`brw-pr-handoff/9.4 ${host}: 文脈に制御文字・書式文字を含まない`, typeof ctx === "string" && !hasUnsafe(ctx), true);
    t.cleanup();
  }

  // ---- 同じ入力を handleHook で直接呼んでも、形（hookSpecificOutput）が同じ ----
  {
    const t = fixture();
    record(t.dir);
    const r = handleHook("codex", "UserPromptSubmit", upsOf("codex", t.dir));
    eq("brw-pr-handoff/9.4 handleHook: 見つかるときは hookSpecificOutput.hookEventName が UserPromptSubmit の応答を返す", [r?.hookSpecificOutput?.hookEventName, typeof r?.hookSpecificOutput?.additionalContext], ["UserPromptSubmit", "string"]);
    t.cleanup();
  }

  // ---- 見つからない各場合（7.6）: 何も出力せず終了コード 0 ----
  const quiet = [
    ["記録が無い", () => { const t = fixture(); return { t, input: upsOf("claude", t.dir) }; }],
    ["別のセッションの記録", () => { const t = fixture(); record(t.dir, { sessionId: OTHER }); return { t, input: upsOf("claude", t.dir) }; }],
    ["記録の sessionId が空（付いていない）", () => { const t = fixture(); record(t.dir, { sessionId: null }); return { t, input: upsOf("claude", t.dir) }; }],
    ["入力に session_id が無い", () => { const t = fixture(); record(t.dir); return { t, input: upsOf("claude", t.dir, { omit: ["session_id"] }) }; }],
    ["入力の session_id が空", () => { const t = fixture(); record(t.dir); return { t, input: upsOf("claude", t.dir, { sessionId: "" }) }; }],
    ["24 時間を超えた記録", () => { const t = fixture(); record(t.dir, { at: iso(Date.now() - 25 * HOUR) }); return { t, input: upsOf("claude", t.dir) }; }],
    ["作業場所が既にある", () => { const t = fixture({ worktree: true }); record(t.dir); return { t, input: upsOf("claude", t.dir) }; }],
    ["遠隔に無い", () => { const t = fixture({ pushed: false }); record(t.dir); return { t, input: upsOf("claude", t.dir) }; }],
    ["宣言が無い", () => { const t = fixture({ config: null }); record(t.dir); return { t, input: upsOf("claude", t.dir) }; }],
    ["宣言が読めない", () => { const t = fixture(); record(t.dir); writeFileSync(join(t.dir, ".branch-release-workflow.json"), "{ 壊れた"); return { t, input: upsOf("claude", t.dir) }; }],
    ["開発ブランチでない", () => { const t = fixture({ branch: "feature/x" }); record(t.dir, { branch: "feature/x" }); return { t, input: upsOf("claude", t.dir) }; }],
    ["Git の外（cwd がリポジトリでない）", () => { const t = fixture(); record(t.dir); const plain = mkdtempSync(join(tmpdir(), "brw-94-plain-")); return { t, input: upsOf("claude", plain), extra: () => rmSync(plain, { recursive: true, force: true }) }; }],
    ["入力が JSON でない", () => { const t = fixture(); record(t.dir); return { t, input: "{ not json" }; }],
  ];
  for (const [label, make] of quiet) {
    const { t, input, extra } = make();
    const res = runCli("claude", "UserPromptSubmit", input, { drop: ["CLAUDE_PROJECT_DIR"] });
    eq(`brw-pr-handoff/9.4 見つからない（${label}）は何も出力せず、終了コード 0 にする`, [res.code, res.out], [0, ""]);
    extra?.();
    t.cleanup();
  }
  // 見つからない場合の応答は handleHook でも null（例外にしない）
  {
    const t = fixture();
    const r = handleHook("claude", "UserPromptSubmit", upsOf("claude", t.dir));
    eq("brw-pr-handoff/9.4 handleHook: 記録が無いときは応答を返さない（null）", r, null);
    t.cleanup();
  }
  // 例外になりうる入力でも、フックを失敗させない
  {
    const r = handleHook("claude", "UserPromptSubmit", { cwd: 42, session_id: null });
    eq("brw-pr-handoff/9.4 handleHook: 型の違う入力でも例外にせず、応答を返さない", r, null);
  }

  // ---- CLAUDE_PROJECT_DIR から本体を導く（cwd が Git の外のとき） ----
  {
    const t = fixture();
    record(t.dir);
    const plain = mkdtempSync(join(tmpdir(), "brw-94-home-"));
    const wtLike = join(t.dir, ".claude", "worktrees", "x");
    const found = runCli("claude", "UserPromptSubmit", upsOf("claude", plain), { env: { CLAUDE_PROJECT_DIR: wtLike } });
    eq("brw-pr-handoff/9.4 cwd が Git の外でも、CLAUDE_PROJECT_DIR が <本体>/.claude/worktrees/<別名> なら本体の記録で案内する", [found.code, contextOf(found.out) !== null && contextOf(found.out) !== undefined], [0, true]);
    const notWt = runCli("claude", "UserPromptSubmit", upsOf("claude", plain), { env: { CLAUDE_PROJECT_DIR: t.dir } });
    eq("brw-pr-handoff/9.4 CLAUDE_PROJECT_DIR が worktrees の形でなければ、Git の外からは案内しない", [notWt.code, notWt.out], [0, ""]);
    rmSync(plain, { recursive: true, force: true });
    t.cleanup();
  }

  // ---- 副作用なし（7.5）: 作業場所・参照・再開の記録が変わらず、gh・ssh は呼ばれない ----
  for (const [label, prep] of [
    ["見つかる場合", (t) => record(t.dir)],
    ["見つからない場合（記録の無い）", () => {}],
  ]) {
    const t = fixture();
    prep(t);
    const before = snapshot(t.dir);
    const net = fakeNetworkTools();
    const res = runCli("claude", "UserPromptSubmit", upsOf("claude", t.dir), { drop: ["CLAUDE_PROJECT_DIR"], pathPrefix: net.bin });
    const after = snapshot(t.dir);
    eq(`brw-pr-handoff/9.4 副作用なし（${label}）: 作業場所・参照・再開の記録が不変で、gh・ssh を呼ばない`, [res.code, JSON.stringify(after) === JSON.stringify(before), net.calls()], [0, true, 0]);
    rmSync(net.bin, { recursive: true, force: true });
    t.cleanup();
  }

  // ---- 文字列の無害化（出力に使う関数の単体） ----
  eq("brw-pr-handoff/9.4 無害化: 制御文字・書式文字・行区切りを除き、空白を 1 つにする", harmlessText("dev/a\u202E\u200B\n\u0007b\u2028c"), "dev/a b c");
  eq("brw-pr-handoff/9.4 無害化: 前後の空白を除く", harmlessText("  dev/a \t "), "dev/a");

  // ---- 登録（Claude のプラグイン・Codex の登録・ホストごとのイベント） ----
  {
    const hooks = JSON.parse(readFileSync(join(root, "hooks", "hooks.json"), "utf8"));
    const cmd = hooks.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command;
    eq("brw-pr-handoff/9.4 hooks/hooks.json に UserPromptSubmit を agent-hooks.mjs の claude として登録する", cmd, 'node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-hooks.mjs" claude UserPromptSubmit');
    eq("brw-pr-handoff/9.4 HOST_EVENTS に両ホストの UserPromptSubmit を含める", [HOST_EVENTS.claude?.includes("UserPromptSubmit"), HOST_EVENTS.codex?.includes("UserPromptSubmit")], [true, true]);
    const codexEvents = (hookInstall.CODEX_HOOKS ?? []).map((h) => h.event);
    eq("brw-pr-handoff/9.4 Codex の導入の登録に UserPromptSubmit を含める", codexEvents.includes("UserPromptSubmit"), true);
    const check = hookInstall.checkClaudeHooks?.(root);
    eq("brw-pr-handoff/9.4 同梱の hooks/hooks.json は、導入の検査で UserPromptSubmit の欠落を報告しない", check?.missing?.filter((m) => m.startsWith("UserPromptSubmit")) ?? ["未実装"], []);
    // UserPromptSubmit を外したプラグインでは、欠落として報告する（Claude の導入の検査が登録を見ていることの確認）
    const plugin = mkdtempSync(join(tmpdir(), "brw-94-plugin-"));
    mkdirSync(join(plugin, "hooks"), { recursive: true });
    const withoutUps = JSON.parse(readFileSync(join(root, "hooks", "hooks.json"), "utf8"));
    delete withoutUps.hooks.UserPromptSubmit;
    writeFileSync(join(plugin, "hooks", "hooks.json"), JSON.stringify(withoutUps));
    const lacking = hookInstall.checkClaudeHooks?.(plugin);
    eq("brw-pr-handoff/9.4 UserPromptSubmit の登録が無い hooks/hooks.json は、導入の検査で欠落と報告する", lacking?.missing?.includes("UserPromptSubmit") ?? false, true);
    rmSync(plugin, { recursive: true, force: true });
    const diag = hookDiagnose.diagnoseHooks?.({ pluginRoot: root, host: "claude" });
    const route = diag?.routes?.find((x) => x.host === "claude" && x.environment === "local" && x.event === "UserPromptSubmit");
    eq("brw-pr-handoff/9.4 診断: Claude の UserPromptSubmit は、登録と応答（何も出さない）が確認でき、稼働と表示する", [route?.status ?? null, route?.reasonCode ?? null], ["active", null]);
  }

  // ---- PostToolUse（信頼済みの brw pr の成功）で、出力の案内の行のブランチの記録にだけセッションを付ける（9.2・9.4） ----
  const ago = (ms) => iso(Date.now() - ms);
  const claudeOk = (stdout) => ({ stdout, stderr: "", interrupted: false });
  // pr-flow の片付けの出力（finishUp の形）。案内の行のブランチ・形（実行形 / 手動の案内）を指定できる
  const finishOut = (main, { branch = "dev/a", manual = false } = {}) => {
    const resume = manual
      ? `  続きの再開: brw resume \`${branch}\`（BRW の実行方法は利用している環境に従う）`
      : `  続きの再開: node '${main}/scripts/brw.mjs' resume ${branch}`;
    return [
      "作業外の変更を別コミットにしました（36 件）。",
      "PR を作成しました: https://github.com/acme/app/pull/7",
      "取り込み先: main",
      "GitHub 上で PR を開き、main へ squash マージしてください。BRW は GitHub のマージを行いません。",
      `片付けました: \`${branch}\`（worktree: \`${main}/wt\`）`,
      "この PR の続きの作業（検証のやり直し・レビューの指摘への対応など）は、新しい作業ではなく、公開済みの作業ブランチから作業場所を作り直して再開します:",
      resume,
      `新しい作業は、本体で brw create <名前> を実行してください（本体: \`${main}\`）。`,
      `注意: 作業場所の中でセッションを開始していた場合は、続く操作の前に cd '${main}' を実行してください。本体でセッションを開始していた場合は、ホストが本体へ戻すため追加の操作は不要です。`,
      "注意: 作業場所が消えたため、ツールが「終了コード 1」と表示することがありますが、PR の作成と片付けは完了しています。",
    ].join("\n");
  };
  // 分岐元からの brw pr の出力（記録を作らず、案内の行が無い）
  const baseOut = "PR を作成しました: https://github.com/acme/app/pull/7\n取り込み先: main\nGitHub 上で PR を開き、main へ squash マージしてください。BRW は GitHub のマージを行いません。";
  // 記録のブランチごとのセッション（無ければ undefined）
  const sessionsOf = (t) => Object.fromEntries(readRecords(t.dir).map((e) => [e.branch, e.sessionId]).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  const prEvent = (t, { command = `node ${BRW} pr --title 件名`, response, sessionId = SESSION, host = "claude", cwd = t.dir } = {}) => {
    const ev = hookInput(host, "PostToolUse", { cwd, command, sessionId });
    ev.tool_response = response ?? (host === "claude" ? claudeOk(finishOut(t.dir)) : finishOut(t.dir));
    return handleHook(host, "PostToolUse", ev);
  };
  {
    const t = fixture();
    record(t.dir, { sessionId: null, at: ago(10 * 1000) });
    prEvent(t);
    eq("brw-pr-handoff/9.4 成功した brw pr（案内の行あり）は、案内の行のブランチ（dev/a）の直近の記録に付ける", sessionsOf(t), { "dev/a": SESSION });
    t.cleanup();
  }
  {
    const t = fixture();
    record(t.dir, { sessionId: null, at: ago(60 * 1000), branch: "dev/a" });
    record(t.dir, { sessionId: null, at: ago(10 * 1000), branch: "dev/b" });
    prEvent(t);
    eq("brw-pr-handoff/9.4 別ブランチの新しい記録があっても、案内の行のブランチ（dev/a）の記録だけに付ける（Claude）", sessionsOf(t), { "dev/a": SESSION, "dev/b": null });
    t.cleanup();
  }
  {
    const t = fixture();
    record(t.dir, { sessionId: null, at: ago(60 * 1000), branch: "dev/a" });
    record(t.dir, { sessionId: null, at: ago(10 * 1000), branch: "dev/b" });
    prEvent(t, { host: "codex" });
    eq("brw-pr-handoff/9.4 別ブランチの新しい記録があっても、案内の行のブランチの記録だけに付ける（Codex の文字列）", sessionsOf(t), { "dev/a": SESSION, "dev/b": null });
    t.cleanup();
  }
  {
    const t = fixture();
    record(t.dir, { sessionId: null, at: ago(60 * 1000), branch: "dev/a" });
    record(t.dir, { sessionId: null, at: ago(10 * 1000), branch: "dev/b" });
    prEvent(t, { response: claudeOk(finishOut(t.dir, { manual: true })) });
    eq("brw-pr-handoff/9.4 手動の案内の形（brw resume の行）でも、対象ブランチの記録だけに付ける", sessionsOf(t), { "dev/a": SESSION, "dev/b": null });
    t.cleanup();
  }
  {
    const t = fixture();
    record(t.dir, { sessionId: null, at: ago(10 * 1000), branch: "dev/b" });
    prEvent(t);
    eq("brw-pr-handoff/9.4 案内の行のブランチの記録が無ければ、別ブランチの新しい記録には付けない", sessionsOf(t), { "dev/b": null });
    t.cleanup();
  }
  {
    const t = fixture();
    record(t.dir, { sessionId: null, at: ago(10 * 1000), branch: "dev/a" });
    prEvent(t, { response: claudeOk(baseOut) });
    eq("brw-pr-handoff/9.4 分岐元からの brw pr（記録を作らず、案内の行が無い）では、直近の記録にも付けない（Claude）", sessionsOf(t), { "dev/a": null });
    t.cleanup();
  }
  {
    const t = fixture();
    record(t.dir, { sessionId: null, at: ago(10 * 1000), branch: "dev/a" });
    prEvent(t, { host: "codex", response: baseOut });
    eq("brw-pr-handoff/9.4 分岐元からの brw pr（案内の行が無い）では、直近の記録にも付けない（Codex）", sessionsOf(t), { "dev/a": null });
    t.cleanup();
  }
  {
    const t = fixture();
    record(t.dir, { sessionId: null, at: ago(10 * 1000), branch: "dev/a" });
    prEvent(t, { response: claudeOk(`${finishOut(t.dir)}\nエラー: 後片付けに失敗しました`) });
    eq("brw-pr-handoff/9.4 エラーの行を含む出力は、案内の行があっても付けない", sessionsOf(t), { "dev/a": null });
    t.cleanup();
  }
  {
    const t = fixture();
    record(t.dir, { sessionId: null, at: ago(10 * 1000), branch: "dev/a" });
    prEvent(t, { response: claudeOk(`  続きの再開: node '${t.dir}/scripts/brw.mjs' resume`) });
    eq("brw-pr-handoff/9.4 案内の行からブランチ名を取り出せなければ、付けない", sessionsOf(t), { "dev/a": null });
    t.cleanup();
  }
  {
    const t = fixture();
    record(t.dir, { sessionId: null, at: ago(10 * 1000), branch: "dev/a" });
    prEvent(t, { response: { exit_code: 1, stdout: finishOut(t.dir), stderr: "エラー", interrupted: false } });
    eq("brw-pr-handoff/9.4 brw pr が失敗（終了コード 1）したときは付けない", sessionsOf(t), { "dev/a": null });
    t.cleanup();
  }
  {
    const t = fixture();
    record(t.dir, { sessionId: null, at: ago(10 * 1000), branch: "dev/a" });
    prEvent(t, { command: `node ${BRW} status`, response: claudeOk(finishOut(t.dir)) });
    eq("brw-pr-handoff/9.4 brw pr 以外の brw コマンドでは付けない", sessionsOf(t), { "dev/a": null });
    t.cleanup();
  }
  {
    const t = fixture();
    record(t.dir, { sessionId: null, at: ago(10 * 1000), branch: "dev/a" });
    prEvent(t, { command: `node /tmp/brw-94-not-brw/brw.mjs pr --title 件名`, response: claudeOk(finishOut(t.dir)) });
    eq("brw-pr-handoff/9.4 信頼できない実行ファイル（BRW の実体でない）の pr では付けない", sessionsOf(t), { "dev/a": null });
    t.cleanup();
  }
  {
    const t = fixture();
    record(t.dir, { sessionId: null, at: ago(10 * 1000), branch: "dev/a" });
    prEvent(t, { sessionId: "" });
    eq("brw-pr-handoff/9.4 session_id が無い入力では付けない", sessionsOf(t), { "dev/a": null });
    t.cleanup();
  }
  {
    const t = fixture();
    record(t.dir, { sessionId: null, at: ago(3 * 60 * 1000), branch: "dev/a" });
    prEvent(t);
    eq("brw-pr-handoff/9.4 2 分を超えた記録には付けない", sessionsOf(t), { "dev/a": null });
    t.cleanup();
  }
  {
    const t = fixture();
    record(t.dir, { sessionId: null, at: ago(10 * 1000), branch: "dev/a" });
    prEvent(t, { host: "codex", response: finishOut(t.dir, { manual: true }) });
    eq("brw-pr-handoff/9.4 Codex: 片付けの実出力（手動の案内の形）から付ける", sessionsOf(t), { "dev/a": SESSION });
    t.cleanup();
  }
  {
    // 作業場所（worktree）を削除した後の入力（Claude）: 作業場所は本体の .claude/worktrees/ の下にあり、CLAUDE_PROJECT_DIR も同じ場所を指す。その本体で付く
    const t = fixture({ branch: "dev/zz", pushed: false });
    const wt = join(t.dir, ".claude", "worktrees", "x");
    mkdirSync(join(t.dir, ".claude", "worktrees"), { recursive: true });
    gitOut(t.dir, "worktree", "add", "-q", "-b", "dev/a", wt);
    record(t.dir, { sessionId: null, at: ago(10 * 1000), branch: "dev/a" });
    gitOut(t.dir, "worktree", "remove", "--force", wt);
    withEnv({ CLAUDE_PROJECT_DIR: wt }, () => prEvent(t, { cwd: wt, response: claudeOk(finishOut(t.dir)) }));
    eq("brw-pr-handoff/9.4 Claude: cwd が削除済みの作業場所（本体の .claude/worktrees/ の下）なら、CLAUDE_PROJECT_DIR の本体の記録に付ける", sessionsOf(t), { "dev/a": SESSION });
    t.cleanup();
  }
  {
    // 実行先（cd 先）が別リポジトリ B の削除済みの作業場所なら、CLAUDE_PROJECT_DIR が A の作業場所の形でも、A の記録にも B の記録にも付けない（実行先が導いた本体の配下にない）
    for (const host of ["claude", "codex"]) {
      const a = fixture();
      record(a.dir, { sessionId: null, at: ago(10 * 1000), branch: "dev/a" });
      const b = fixture({ worktree: true });
      record(b.dir, { sessionId: null, at: ago(10 * 1000), branch: "dev/a" });
      gitOut(b.dir, "worktree", "remove", "--force", b.wt);
      const out = finishOut(b.dir);
      const command = `cd ${b.wt} && node ${BRW} pr --title 件名`;
      withEnv({ CLAUDE_PROJECT_DIR: join(a.dir, ".claude", "worktrees", "x") }, () => prEvent(a, { host, cwd: a.dir, command, response: host === "claude" ? claudeOk(out) : out }));
      eq(`brw-pr-handoff/9.4 ${host}: cd 先が別リポジトリの削除済みの作業場所なら、CLAUDE_PROJECT_DIR が A を指していても、A の記録に付けない`, [sessionsOf(a), sessionsOf(b)], [{ "dev/a": null }, { "dev/a": null }]);
      a.cleanup();
      b.cleanup();
    }
  }
  {
    // 案内の行が 2 種類のブランチを指す（偽の行と正規の行が共存）ときは、どちらの記録にも付けない
    for (const host of ["claude", "codex"]) {
      const t = fixture();
      record(t.dir, { sessionId: null, at: ago(10 * 1000), branch: "dev/a" });
      record(t.dir, { sessionId: null, at: ago(10 * 1000), branch: "dev/b" });
      const out = `${finishOut(t.dir, { branch: "dev/a" })}\n  続きの再開: node '${t.dir}/scripts/brw.mjs' resume dev/b`;
      prEvent(t, { host, response: host === "claude" ? claudeOk(out) : out });
      eq(`brw-pr-handoff/9.4 ${host}: 案内の行が 2 種類のブランチを指すときは、どちらの記録にも付けない`, sessionsOf(t), { "dev/a": null, "dev/b": null });
      t.cleanup();
    }
  }
  {
    // 同じブランチを指す案内の行が重複するだけなら、従来どおり付ける
    const t = fixture();
    record(t.dir, { sessionId: null, at: ago(10 * 1000), branch: "dev/a" });
    prEvent(t, { response: claudeOk(`${finishOut(t.dir)}\n  続きの再開: node '${t.dir}/scripts/brw.mjs' resume dev/a`) });
    eq("brw-pr-handoff/9.4 同じブランチを指す案内の行が重複するだけなら、そのブランチの記録に付ける", sessionsOf(t), { "dev/a": SESSION });
    t.cleanup();
  }
  {
    // cwd が削除済みで本体を決められないとき（CLAUDE_PROJECT_DIR も無い）は付けない。Codex は cwd が本体のまま届くため通常は起きない（限界）
    const t = fixture({ worktree: true });
    record(t.dir, { sessionId: null, at: ago(10 * 1000), branch: "dev/a" });
    gitOut(t.dir, "worktree", "remove", "--force", t.wt);
    withEnv({ CLAUDE_PROJECT_DIR: undefined }, () => prEvent(t, { host: "codex", cwd: t.wt, response: finishOut(t.dir) }));
    eq("brw-pr-handoff/9.4 Codex: cwd が削除済みで本体を決められないときは、案内の cd の行があっても付けない", sessionsOf(t), { "dev/a": null });
    t.cleanup();
  }
  {
    // 出力の cd の行が別リポジトリ B を指し、B に同じブランチの直近の空の記録があっても、B の記録には付けない（出力は信頼できない入力）
    for (const host of ["claude", "codex"]) {
      const a = fixture({ worktree: true });
      record(a.dir, { sessionId: null, at: ago(10 * 1000), branch: "dev/a" });
      gitOut(a.dir, "worktree", "remove", "--force", a.wt);
      const b = fixture();
      record(b.dir, { sessionId: null, at: ago(5 * 1000), branch: "dev/a" });
      const out = finishOut(b.dir);
      withEnv({ CLAUDE_PROJECT_DIR: undefined }, () => prEvent(a, { host, cwd: a.wt, response: host === "claude" ? claudeOk(out) : out }));
      eq(`brw-pr-handoff/9.4 ${host}: cwd が削除済みで、出力の cd が別リポジトリ（B）を指しても、B の記録にも元の記録にも付けない`, [sessionsOf(b), sessionsOf(a)], [{ "dev/a": null }, { "dev/a": null }]);
      a.cleanup();
      b.cleanup();
    }
  }
  {
    // 存在する Git の外のディレクトリで実行した信頼済みの brw pr は、CLAUDE_PROJECT_DIR が A の作業場所の形でも、A の記録に付けない（実行先が本体の配下にない）
    for (const host of ["claude", "codex"]) {
      const a = fixture();
      record(a.dir, { sessionId: null, at: ago(10 * 1000), branch: "dev/a" });
      const plain = mkdtempSync(join(tmpdir(), "brw-94-plain-"));
      const out = finishOut(a.dir);
      withEnv({ CLAUDE_PROJECT_DIR: join(a.dir, ".claude", "worktrees", "x") }, () => prEvent(a, { host, cwd: plain, response: host === "claude" ? claudeOk(out) : out }));
      eq(`brw-pr-handoff/9.4 ${host}: 存在する Git の外の実行先の brw pr は、CLAUDE_PROJECT_DIR が A を指していても、A の記録に付けない`, sessionsOf(a), { "dev/a": null });
      rmSync(plain, { recursive: true, force: true });
      a.cleanup();
    }
  }
  {
    // 見出し（続きの再開:）だけで本文が空の行が共存するときは、正規の行があっても付けない
    for (const host of ["claude", "codex"]) {
      const t = fixture();
      record(t.dir, { sessionId: null, at: ago(10 * 1000), branch: "dev/a" });
      const out = `${finishOut(t.dir)}\n  続きの再開:`;
      prEvent(t, { host, response: host === "claude" ? claudeOk(out) : out });
      eq(`brw-pr-handoff/9.4 ${host}: 本文が空の「続きの再開:」の行が共存するときは、付けない`, sessionsOf(t), { "dev/a": null });
      t.cleanup();
    }
  }
  {
    // 手動の案内の形の行に、生成した文言の後ろに余計な本文が付いた行が正規の行と共存するときは、付けない（行全体の一致で判定する）
    for (const host of ["claude", "codex"]) {
      const t = fixture();
      record(t.dir, { sessionId: null, at: ago(10 * 1000), branch: "dev/a" });
      const out = `${finishOut(t.dir, { manual: true })}\n  続きの再開: brw resume \`dev/a\` 不正な本文`;
      prEvent(t, { host, response: host === "claude" ? claudeOk(out) : out });
      eq(`brw-pr-handoff/9.4 ${host}: 手動の形の行の末尾に余計な本文が付いた行が共存するときは、付けない`, sessionsOf(t), { "dev/a": null });
      t.cleanup();
    }
  }
  {
    // 実行形の行に余計な本文が付いた行が正規の行と共存するときは、付けない（行全体の一致で判定する）
    for (const host of ["claude", "codex"]) {
      const t = fixture();
      record(t.dir, { sessionId: null, at: ago(10 * 1000), branch: "dev/a" });
      const out = `${finishOut(t.dir)}\n  続きの再開: node '${t.dir}/scripts/brw.mjs' resume dev/a と余計な文字`;
      prEvent(t, { host, response: host === "claude" ? claudeOk(out) : out });
      eq(`brw-pr-handoff/9.4 ${host}: 実行形の行の末尾に余計な本文が付いた行が共存するときは、付けない`, sessionsOf(t), { "dev/a": null });
      t.cleanup();
    }
  }
  // ---- セッションの手がかり（9.7）: 実行前（PreToolUse）に、信頼済みの brw pr のメモを書く（両ホスト）。応答は従来と同じ ----
  const hintAt = (t) => (rr.readSessionHint ? rr.readSessionHint(t.dir, t.wt, new Date()) : null);
  for (const host of ["claude", "codex"]) {
    const t = fixture({ worktree: true });
    const ev = hookInput(host, "PreToolUse", { cwd: t.wt, command: `node ${BRW} pr --title 件名`, sessionId: SESSION });
    handleHook(host, "PreToolUse", ev);
    eq(`brw-pr-handoff/9.7 ${host}: 信頼済みの brw pr の PreToolUse は、作業場所のメモ（セッション・作業場所）を書く`, hintAt(t), SESSION);
    t.cleanup();
  }
  {
    const t = fixture({ worktree: true });
    const ev = hookInput("claude", "PreToolUse", { cwd: t.wt, command: `cd ${t.wt} && node ${BRW} pr --title 件名`, sessionId: SESSION });
    const before = JSON.stringify(handleHook("claude", "PreToolUse", ev));
    const after = JSON.stringify(agent.responseOf("claude", "PreToolUse", agent.decideHook("claude", "PreToolUse", ev)));
    eq("brw-pr-handoff/9.7 PreToolUse の応答（許可・拒否）は、メモを書いても従来の判定と同じ", [before === after, hintAt(t)], [true, SESSION]);
    t.cleanup();
  }
  const noHintCases = [
    ["別のコマンド（brw status）", (t) => ({ cwd: t.wt, command: `node ${BRW} status`, sessionId: SESSION })],
    ["session_id が無い", (t) => ({ cwd: t.wt, command: `node ${BRW} pr --title 件名`, sessionId: "" })],
    ["信頼できない実行ファイル", (t) => ({ cwd: t.wt, command: `node /tmp/brw-94-untrusted/brw.mjs pr --title 件名`, sessionId: SESSION })],
  ];
  for (const [label, make] of noHintCases) {
    const t = fixture({ worktree: true });
    handleHook("claude", "PreToolUse", hookInput("claude", "PreToolUse", make(t)));
    eq(`brw-pr-handoff/9.7 PreToolUse（${label}）は、メモを書かない`, hintAt(t), null);
    t.cleanup();
  }
};
