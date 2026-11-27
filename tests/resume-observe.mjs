// 続きの再開の実機観測の判定部分（brw-pr-handoff 9.6 の後半）の単体試験。selftest.mjs から呼ばれる。
// 実機（claude・codex）は呼ばない。tests/real-env/resume-observe.mjs の純粋関数（stream-json の解析と判定）だけを確かめる。
import { judge, parseStreamJson } from "./real-env/resume-observe.mjs";

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
  const p = parseStreamJson(sample);
  eq("9.6 観測の解析: セッション ID を取り出す", p.sessionId, SESSION);
  eq("9.6 観測の解析: Bash の呼び出しとその結果を、順に対応づけて取り出す", p.bash.map((b) => [b.command, b.output]), [["node brw.mjs pr", "PR を作成しました"], ["node brw.mjs resume dev/obs-resume", "worktree を作りました"]]);
  eq("9.6 観測の解析: 各ターンの結果を順に取り出し、解析できない行を数える", [p.results, p.unparsed], [["公開しました", "resume dev/obs-resume"], 1]);

  const base = { sessionId: SESSION, recordSession: SESSION, hookLog: [{ event: "UserPromptSubmit", session_id: SESSION }, { event: "UserPromptSubmit", session_id: SESSION }], answer2: `なし。node brw.mjs resume ${BRANCH} で再開します`, commands2: [`node '/x/brw.mjs' resume ${BRANCH}`], branchesBefore: ["main", BRANCH], branchesAfter: ["main", BRANCH], worktreeBranches: ["main", BRANCH], branch: BRANCH, inside: false };
  const verdicts = (o) => judge({ ...base, ...o }).map((x) => x.verdict);
  eq("9.6 判定: すべて想定どおりなら、4 項目とも一致", verdicts({}), ["一致", "一致", "一致", "一致"]);
  eq("9.6 判定: 記録のセッションが空なら (a) は不一致（成功と記録しない）", verdicts({ recordSession: null })[0], "不一致");
  eq("9.6 判定: 記録が読めなければ (a) は未観測", verdicts({ recordSession: undefined })[0], "未観測");
  eq("9.6 判定: フックが動いても答えに案内の再開コマンドが無ければ (b) は不一致", verdicts({ answer2: "なし" })[1], "不一致");
  eq("9.6 判定: UserPromptSubmit が動いていなければ (b) は不一致", verdicts({ hookLog: [{ event: "UserPromptSubmit", session_id: SESSION }] })[1], "不一致");
  eq("9.6 判定: resume を実行しても作業場所が作り直されていなければ (c) は不一致", verdicts({ worktreeBranches: ["main"] })[2], "不一致");
  eq("9.6 判定: resume を実行していなければ (c) は不一致", verdicts({ commands2: ["git status"] })[2], "不一致");
  eq("9.6 判定: 新しい作業ブランチを作っていれば (d) は不一致", verdicts({ branchesAfter: ["main", BRANCH, "dev/new"] })[3], "不一致");
  eq("9.6 判定: 同じセッションの記録が無いのに答えに再開コマンドが出ても、(b) は不一致（案内の前提が無く、前のターンの出力に由来しうる）", verdicts({ recordSession: null })[1], "不一致");
  eq("9.6 判定: 作業場所の中で開始し、削除後にフックが動かないのは想定どおり（既知の限界）として (b) は一致", verdicts({ inside: true, hookLog: [{ event: "UserPromptSubmit", session_id: SESSION }], commands2: [] })[1], "一致");
  eq("9.6 判定: 作業場所の中で開始し、フックが動いてしまった場合は (b) は不一致（想定と異なる）", verdicts({ inside: true, hookLog: [{ event: "UserPromptSubmit", session_id: SESSION }, { event: "UserPromptSubmit", session_id: SESSION }] })[1], "不一致");
  eq("9.6 判定: 作業場所の中で resume を試みても作業場所が作り直されなければ (c) は未観測（シェルが使えない）", verdicts({ inside: true, hookLog: [{ event: "UserPromptSubmit", session_id: SESSION }], commands2: [`node '/x/brw.mjs' resume ${BRANCH}`], worktreeBranches: ["main"] })[2], "未観測");
  eq("9.6 判定: 作業場所の中で案内が届かないときは (c) を未観測（判定の対象外）", verdicts({ inside: true, hookLog: [{ event: "UserPromptSubmit", session_id: SESSION }], commands2: [] })[2], "未観測");
};
