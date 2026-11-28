// 続きの再開の実機観測の判定部分（brw-pr-handoff 9.6 の後半）の単体試験。selftest.mjs から呼ばれる。
// 実機（claude・codex）は呼ばない。tests/real-env/resume-observe.mjs の純粋関数（stream-json の解析と判定）だけを確かめる。
import { judge, parseCodexJson, parseStreamJson, preToolUseCheck, resumeEvidenceOf } from "./real-env/resume-observe.mjs";

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
  const pre = { event: "PreToolUse", session_id: SESSION, cwd: "/w", command: "node brw.mjs pr --title x", tool_use_id: "pr-1", keys: ["cwd", "session_id", "tool_input"] };
  const ups1 = { event: "UserPromptSubmit", session_id: SESSION, cwd: "/w", command: null, keys: [] };
  const ups2 = { ...ups1 };
  const preCheck = preToolUseCheck([ups1, pre, ups2], SESSION, SESSION, "/w");
  eq("9.8 PreToolUse の確認: Claude の両ターンとPreToolUseのID/cwdが一致", [preCheck.observed, preCheck.hasFields, preCheck.sameThreadAcrossTurns, preCheck.firstUpsMatchesSession, preCheck.secondUpsMatchesResumedSession, preCheck.preMatchesSession, preCheck.cwdMatchesExpected], [true, true, true, true, true, true, true]);
  eq("9.8 PreToolUse の確認: session_idが異なる", preToolUseCheck([ups1, { ...pre, session_id: "other" }, ups2], SESSION, SESSION, "/w").preMatchesSession, false);
  eq("9.8 PreToolUse の確認: 対象PreToolUseが無い場合は未観測", preToolUseCheck([ups1, ups2], SESSION, SESSION, "/w").observed, false);

  const codexPre = { ...pre, session_id: "thread-a", cwd: "/worktree" };
  const codexUps1 = { ...ups1, session_id: "thread-a", cwd: "/main" };
  const codexUps2 = { ...ups2, session_id: "thread-a", cwd: "/main" };
  const codexCheck = preToolUseCheck([codexUps1, codexPre, codexUps2], "thread-a", "thread-a", "/worktree");
  eq("9.9 Codex: 初回/再開thread、両UPS、PreToolUseを別々に照合（UPSとPre cwdは異なり得る）", [codexCheck.observed, codexCheck.sameThreadAcrossTurns, codexCheck.firstUpsMatchesSession, codexCheck.secondUpsMatchesResumedSession, codexCheck.preMatchesSession, codexCheck.cwdMatchesExpected], [true, true, true, true, true, true]);
  const changedResumeThread = preToolUseCheck([codexUps1, codexPre, { ...codexUps2, session_id: "thread-b" }], "thread-a", "thread-b", "/worktree");
  eq("9.9 Codex: 再開時にthread IDが変われば不一致", [changedResumeThread.observed, changedResumeThread.sameThreadAcrossTurns, changedResumeThread.secondUpsMatchesResumedSession], [true, false, true]);
  eq("9.9 Codex: thread ID不一致を最終判定の不一致へ反映", judge({ sessionId: "thread-a", resumedSessionId: "thread-b", hookLog: [codexUps1, { ...codexUps2, session_id: "thread-b" }], commands2: [], branchesBefore: [], branchesAfter: [], branch: BRANCH, preToolUse: changedResumeThread }).at(-1).verdict, "不一致");
  const wrongSecondUps = preToolUseCheck([codexUps1, codexPre, { ...codexUps2, session_id: "wrong" }], "thread-a", "thread-b", "/worktree");
  eq("9.9 Codex: 2件目のUPS ID不一致は検出する", wrongSecondUps.secondUpsMatchesResumedSession, false);
  const wrongCwd = preToolUseCheck([codexUps1, { ...codexPre, cwd: "/other" }, codexUps2], "thread-a", "thread-a", "/worktree");
  eq("9.9 Codex: PreToolUse cwd不一致は検出する", wrongCwd.cwdMatchesExpected, false);

  const p = parseStreamJson(sample);
  eq("9.6 観測の解析: セッション ID を取り出す", p.sessionId, SESSION);
  eq("9.6 観測の解析: Bash 呼び出しと結果を対応づける", p.bash.map((b) => [b.command, b.output]), [["node brw.mjs pr", "PR を作成しました"], ["node brw.mjs resume dev/obs-resume", "worktree を作りました"]]);
  eq("9.6 観測の解析: ターン結果と不正行数を取り出す", [p.results, p.unparsed], [["公開しました", "resume dev/obs-resume"], 1]);

  const codex = parseCodexJson([
    line({ type: "thread.started", thread_id: "thread-first" }),
    line({ type: "item.completed", item: { id: "pr-tool", type: "command_execution", command: "node brw.mjs pr --title x", aggregated_output: "PR を作成しました", exit_code: 0 } }),
    line({ type: "thread.started", thread_id: "thread-resumed" }),
    line({ type: "turn.completed" }),
    line({ type: "item.completed", item: { type: "agent_message", text: "公開しました" } }),
    "not-json",
  ].join("\n"));
  eq("Codex JSONL解析: 初回・再開両方のthread IDを保持し、初回IDを上書きしない", [codex.sessionId, codex.resumedSessionId, codex.sessionIds], ["thread-first", "thread-resumed", ["thread-first", "thread-resumed"]]);
  eq("Codex JSONL解析: command item ID・回答・完了ターン・不正行を抽出", [codex.commands[0].id, codex.commands[0].exitCode, codex.results, codex.turns, codex.unparsed], ["pr-tool", 0, ["公開しました"], 1, 1]);

  const UPS = (sid, cwd = "/w") => ({ event: "UserPromptSubmit", session_id: sid, cwd, out: "{}", exit: 0 });
  const CTX = `[branch-release-workflow] 作業ブランチ ${BRANCH} の作業場所は削除済みです。node '/x/brw.mjs' resume ${BRANCH} で再開できます。新しい作業なら無視してかまいません。`;
  const PRE = { event: "PreToolUse", session_id: SESSION, cwd: "/w", command: `node '/x/brw.mjs' pr --title x`, tool_use_id: "pr-1", keys: ["session_id", "cwd", "tool_input"] };
  const resumeCall = { id: "resume-1", command: `node '/x/brw.mjs' resume ${BRANCH}`, exitCode: 0 };
  const resumePre = { event: "PreToolUse", session_id: SESSION, cwd: "/w", command: resumeCall.command, tool_use_id: "resume-1", worktreeBranches: ["main"] };
  const resumePost = { event: "PostToolUse", session_id: SESSION, cwd: "/w", command: resumeCall.command, tool_use_id: "resume-1", worktreeBranches: ["main", BRANCH] };
  const baseHookLog = [UPS(SESSION), PRE, resumePre, resumePost, UPS(SESSION)];
  const evidence = resumeEvidenceOf(resumeCall, baseHookLog, BRANCH, "codex");
  const preToolUse = preToolUseCheck(baseHookLog, SESSION, SESSION, "/w");
  const base = { sessionId: SESSION, resumedSessionId: SESSION, recordSession: SESSION, hookLog: baseHookLog, ctx2: CTX, answer2: "あり", commands2: [resumeCall.command], resumeEvidence: evidence, branchesBefore: ["main", BRANCH], branchesAfter: ["main", BRANCH], preToolUse, branch: BRANCH, inside: false };
  const results = (o) => judge({ ...base, ...o });
  const verdicts = (o) => results(o).map((x) => x.verdict);
  eq("9.8 判定: 成功した単独resume callのPre/Postで新規worktreeを確認し、全項目一致", verdicts({}), ["一致", "一致", "一致", "一致", "一致"]);
  eq("9.8 判定: 記録セッション不一致", verdicts({ recordSession: null })[0], "不一致");
  eq("9.8 判定: 記録を読めない", verdicts({ recordSession: undefined })[0], "未観測");
  eq("9.8 判定: UPSイベント不足", verdicts({ hookLog: [UPS(SESSION)] })[1], "不一致");
  eq("9.8 判定: 案内無し", verdicts({ ctx2: null })[1], "不一致");
  eq("9.8 判定: 案内返却をモデルが示さない", verdicts({ answer2: "なし" })[1], "不一致");
  eq("9.8 判定: resumeのtool call成功を確認", results({})[2].detail.includes("成功終了後に作成された"), true);
  eq("9.8 回帰: resumeが失敗し既存worktreeがあればcは不一致", verdicts({ resumeEvidence: { ...evidence, status: "failed", worktreeBranchesBefore: ["main", BRANCH], worktreeBranchesAfter: ["main", BRANCH] } })[2], "不一致");
  eq("9.8 回帰: resume前から対象worktreeがあればcは不一致", verdicts({ resumeEvidence: { ...evidence, worktreeBranchesBefore: ["main", BRANCH], worktreeBranchesAfter: ["main", BRANCH] } })[2], "不一致");
  eq("9.8 回帰: exit成功でもresume call直後にworktreeが無ければ不一致", verdicts({ resumeEvidence: { ...evidence, worktreeBranchesAfter: ["main"] } })[2], "不一致");
  eq("9.8 回帰: tool_use_idが無いPre/Postは未観測", verdicts({ resumeEvidence: resumeEvidenceOf({ ...resumeCall, id: null }, baseHookLog, BRANCH, "codex") })[2], "未観測");
  eq("9.8 回帰: turn中の別操作でworktreeが後から作られてもresume成功にしない", verdicts({ resumeEvidence: resumeEvidenceOf(resumeCall, [...baseHookLog.map((e) => e.tool_use_id === "resume-1" && e.event === "PostToolUse" ? { ...e, worktreeBranches: ["main"] } : e), { event: "PostToolUse", tool_use_id: "other", command: "git worktree add", worktreeBranches: ["main", BRANCH] }], BRANCH, "codex") })[2], "不一致");
  eq("9.8 回帰: 複合コマンドのworktree作成をresumeの効果にしない", verdicts({ commands2: [`${resumeCall.command} && git worktree add`], resumeEvidence: resumeEvidenceOf({ ...resumeCall, command: `${resumeCall.command} && git worktree add` }, baseHookLog, BRANCH, "codex") })[2], "未観測");
  eq("9.8 判定: 新しいbranchを作った", verdicts({ branchesAfter: ["main", BRANCH, "dev/new"] })[3], "不一致");
  eq("9.8 判定: insideでUPS後にhookが無い", verdicts({ inside: true, hookLog: [UPS(SESSION)], ctx2: null, commands2: [], resumeEvidence: null })[1], "一致");
  eq("9.8 判定: insideで削除後hookが動けば不一致", verdicts({ inside: true })[1], "不一致");
  eq("9.8 判定: insideでresume証拠なしなら未観測", verdicts({ inside: true, resumeEvidence: null })[2], "未観測");
  eq("9.9 判定: PreToolUse ID不一致は最終合否で失敗", [verdicts({ preToolUse: { ...preToolUse, preMatchesSession: false } })[4], verdicts({ preToolUse: { ...preToolUse, preMatchesSession: false } }).every((v) => v === "一致")], ["不一致", false]);
  eq("9.9 判定: PreToolUse cwd不一致は最終合否で失敗", [verdicts({ preToolUse: { ...preToolUse, cwdMatchesExpected: false } })[4], verdicts({ preToolUse: { ...preToolUse, cwdMatchesExpected: false } }).every((v) => v === "一致")], ["不一致", false]);
  const badUpsLog = [UPS(SESSION), PRE, { ...UPS(SESSION), session_id: "thread-b" }];
  const badUpsCheck = preToolUseCheck(badUpsLog, SESSION, "thread-b", "/w");
  eq("9.9 判定: 2件目UPSと再開IDの対応不一致は最終合否で失敗", [verdicts({ resumedSessionId: "thread-b", hookLog: badUpsLog, preToolUse: badUpsCheck })[4], verdicts({ resumedSessionId: "thread-b", hookLog: badUpsLog, preToolUse: badUpsCheck }).every((v) => v === "一致")], ["不一致", false]);
};
