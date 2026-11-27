// 続きの再開の実機観測の判定部分（brw-pr-handoff 9.6 の後半）の単体試験。selftest.mjs から呼ばれる。
// 実機（claude・codex）は呼ばない。tests/real-env/resume-observe.mjs の純粋関数（stream-json の解析と判定）だけを確かめる。
import { judge, parseStreamJson, preToolUseCheck } from "./real-env/resume-observe.mjs";

const line = (o) => JSON.stringify(o);
const SESSION = "sess-9-6";
const BRANCH = "dev/obs-resume";

const sample = [
  line({ type: "system", subtype: "init", session_id: SESSION }),
  line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "node brw.mjs pr" } }] } }),
  line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "PR を作成しました" }] } }),
  line({ type: "result", result: "公開しました" }),
  line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "node brw.mjs resume dev/obs-resume" } }] } }),
  line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "worktree を作りました" }] }] } }),
  line({ type: "result", result: "resume dev/obs-resume" }),
  "{ 解析できない",
].join("\n");

export const runResumeObserveChecks = (eq) => {
  const pre = { event: "PreToolUse", session_id: SESSION, cwd: "/w", command: "node brw.mjs pr --title x", keys: ["cwd", "session_id", "tool_input"] };
  const ups = { event: "UserPromptSubmit", session_id: SESSION, cwd: "/w", command: null, keys: [] };
  eq("9.8 PreToolUse の確認: 入力に session_id・cwd があり、Claude のセッションと UserPromptSubmit の session_id が同じ", preToolUseCheck([pre, ups], SESSION), { count: 1, hasFields: true, sessionIsClaudeSession: true, sameAsUserPromptSubmit: true });
  eq("9.8 PreToolUse の確認: session_id が違えば、同じとは言わない", preToolUseCheck([{ ...pre, session_id: "other" }, ups], SESSION).sameAsUserPromptSubmit, false);
  eq("9.8 PreToolUse の確認: brw pr の呼び出しが無ければ件数 0 で、どれも真にならない", preToolUseCheck([ups], SESSION), { count: 0, hasFields: false, sessionIsClaudeSession: false, sameAsUserPromptSubmit: false });
  const p = parseStreamJson(sample);
  eq("9.6 観測の解析: セッション ID を取り出す", p.sessionId, SESSION);
  eq("9.6 観測の解析: Bash の呼び出しとその結果を、順に対応づけて取り出す", p.bash.map((b) => [b.command, b.output]), [["node brw.mjs pr", "PR を作成しました"], ["node brw.mjs resume dev/obs-resume", "worktree を作りました"]]);
  eq("9.6 観測の解析: 各ターンの結果を順に取り出し、解析できない行を数える", [p.results, p.unparsed], [["公開しました", "resume dev/obs-resume"], 1]);

  const UPS = (sid) => ({ event: "UserPromptSubmit", session_id: sid, cwd: "/w", out: "{}", exit: 0 });
  const CTX = `[branch-release-workflow] 作業ブランチ ${BRANCH} の作業場所は削除済みです。node '/x/brw.mjs' resume ${BRANCH} で再開できます。新しい作業なら無視してかまいません。`;
  const base = { sessionId: SESSION, recordSession: SESSION, hookLog: [UPS(SESSION), UPS(SESSION)], ctx2: CTX, answer2: "あり", commands2: [`node '/x/brw.mjs' resume ${BRANCH}`], branchesBefore: ["main", BRANCH], branchesAfter: ["main", BRANCH], worktreeBranches: ["main", BRANCH], branch: BRANCH, inside: false };
  const verdicts = (o) => judge({ ...base, ...o }).map((x) => x.verdict);
  const detailOf = (o, name) => judge({ ...base, ...o }).find((x) => x.name === name).detail;
  eq("9.8 判定: 想定どおりなら 4 項目とも一致（(b) は案内の返却と、答えの「あり」）", verdicts({}), ["一致", "一致", "一致", "一致"]);
  eq("9.8 判定: 記録のセッションが空なら (a) は不一致（成功と記録しない）", verdicts({ recordSession: null })[0], "不一致");
  eq("9.8 判定: 記録が読めなければ (a) は未観測", verdicts({ recordSession: undefined })[0], "未観測");
  eq("9.8 判定: ターン 2 の UserPromptSubmit が動いていなければ (b) は不一致", verdicts({ hookLog: [UPS(SESSION)] })[1], "不一致");
  eq("9.8 判定: BRW が案内を返していなければ (b) は不一致（到達の前提が無い）", verdicts({ ctx2: null })[1], "不一致");
  eq("9.8 判定: 案内は返したが、答えが「あり」でなければ (b) は不一致（モデルへの到達は確認できない）", verdicts({ answer2: "なし" })[1], "不一致");
  eq("9.8 判定: (c) は、答えに案内の文言がある回だけ案内によるとみてよい", detailOf({}, "c").includes("案内によるとみてよい"), true);
  eq("9.8 判定: (c) は、答えに案内の文言が無ければ案内によるとは確認できないと書く", detailOf({ answer2: "なし" }, "c").includes("案内によるとは確認できない"), true);
  eq("9.8 判定: resume を実行していなければ (c) は不一致", verdicts({ commands2: ["git status"] })[2], "不一致");
  eq("9.8 判定: resume を実行しても作業場所が作り直されていなければ (c) は不一致", verdicts({ worktreeBranches: ["main"] })[2], "不一致");
  eq("9.8 判定: 新しい作業ブランチを作っていれば (d) は不一致", verdicts({ branchesAfter: ["main", BRANCH, "dev/new"] })[3], "不一致");
  eq("9.8 判定: 作業場所の中で開始し、削除後に UserPromptSubmit が動かないのは想定どおり（(b) 一致）", verdicts({ inside: true, hookLog: [UPS(SESSION)], ctx2: null, commands2: [] })[1], "一致");
  eq("9.8 判定: 作業場所の中で開始し、削除後に UserPromptSubmit が動き案内も返したら、想定と異なる（(b) 不一致）", verdicts({ inside: true })[1], "不一致");
  eq("9.8 判定: 作業場所の中で開始し、削除後に動いたが案内を返さなかったら、(b) は不一致", verdicts({ inside: true, ctx2: null })[1], "不一致");
  eq("9.8 判定: 作業場所の中で resume を試みても作り直されなければ (c) は未観測（シェルが使えない）", verdicts({ inside: true, hookLog: [UPS(SESSION)], ctx2: null, commands2: [`node '/x/brw.mjs' resume ${BRANCH}`], worktreeBranches: ["main"] })[2], "未観測");
};
