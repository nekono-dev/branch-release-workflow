// 実環境の追加した規則の観測（brw-enforcement 19.2）の引数・記録の検証・判定・計画・整形を、実ホストと GitHub を呼ばずに確かめる。
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  describeValue, formatHostReport, formatMergeReport, hostCommand, invalidHookRecord, invalidMergeObservation, judgeHostScenario, judgeMergeObservations,
  parseArgs, parseHookLogDetailed, planHosts, planMerge,
} from "./real-env/enforce-observe.mjs";

const script = join(dirname(fileURLToPath(import.meta.url)), "real-env/enforce-observe.mjs");
const noRealEnv = { ...process.env };
delete noRealEnv.BRW_REAL_ENV;

const AT = "2026-11-27T10:00:00.000Z";
const COMMIT_CMD = 'git add note.txt && git commit -m "記録"';
const MERGE_PROMPT = "マージしますか [y/N] ";
// フックの記録 1 行（hook-logger.mjs が書く形）
const rec = (host, event, input, stdout = "", exit = 0) => ({ ts: AT, host, event, pid: 1, cwd: "/w", env: {}, input, stdout, stderr: "", exit });
const bashIn = (command) => ({ tool_name: "Bash", tool_input: { command } });
const stopIn = (active) => ({ hook_event_name: "Stop", stop_hook_active: active });
const ALLOW = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } });
const DENY = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } });
const PR_ALLOW = JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
const PR_DENY = JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny" } } });
const BLOCK_NEW = JSON.stringify({ decision: "block", reason: "未コミットの変更があります: new.txt" });
const ok = { exitCode: 0, timedOut: false };

// 正規の判定入力（H1 の Claude が一致するとき）
const h1Claude = (over = {}) => ({
  host: "claude",
  entries: [rec("claude", "PreToolUse", bashIn(COMMIT_CMD), ALLOW)],
  broken: 0,
  ...ok,
  facts: { headChanged: true, commitHasFile: true },
  ...over,
});

// 整った観測（M1〜M4）。改変して不一致・記録不正を作る
const SHA_BASE = "a".repeat(40);
const HEAD_SHA = "c".repeat(40);
const HEAD_REF = "dev/verify-merge-1700000000";
const BASE_REF = "verify/brw-base-1700000000";
const PROT_REF = "verify/brw-prot-1700000000";
const PR_TITLE = "19.2 の検証 (1700000000)";
// brw pr-merge が確認の前に出す表示（scripts/pr-merge.mjs の出力と同じ文言）
const header = (n) => `PR #${n} をマージします。\nタイトル: \`${PR_TITLE}\`\n取り込み: \`${HEAD_REF}\` → \`${BASE_REF}\`\nhead の SHA: ${HEAD_SHA.slice(0, 12)}\n`;
const ptyFacts = (n, extra) => ({ prNumber: n, title: PR_TITLE, headRef: HEAD_REF, baseRef: BASE_REF, headSha: HEAD_SHA, promptSeen: true, sentInput: null, ...extra });
const goodMerge = () => [
  { id: "M1", at: AT, command: "brw pr-merge 1（非端末）", exitCode: 1, output: "brw pr-merge は利用者が自分の端末で実行する必要があります（エージェントからは実行できません）。", facts: { prStateAfter: "open", refsChanged: 0 } },
  { id: "M2", at: AT, command: "brw pr-merge 2（疑似端末・入力なし）", exitCode: 1, output: `取り込み先 '${PROT_REF}' は保護ブランチです。保護ブランチ向けの PR は BRW ではマージせず、GitHub 上でマージしてください。`, facts: { prStateAfter: "open", refsChanged: 0, promptSeen: false, sentInput: null } },
  { id: "M3n", at: AT, command: "brw pr-merge 1（疑似端末・n）", exitCode: 1, output: `${header(1)}${MERGE_PROMPT}n\n中止しました。マージしていません。\n`, facts: { ...ptyFacts(1, { sentInput: "n" }), prStateAfter: "open", refsChanged: 0 } },
  { id: "M3y", at: AT, command: "brw pr-merge 1（疑似端末・y）", exitCode: 0, output: `${header(1)}${MERGE_PROMPT}y\nマージしました。マージの commit: ${SHA_BASE}\n`, facts: { ...ptyFacts(1, { sentInput: "y" }), prStateAfter: "merged", mergeCommitSha: SHA_BASE, baseHeadSha: SHA_BASE, parentCount: 1, headBranchExists: true } },
  { id: "M4a", at: AT, command: "scripts/agent-hooks.mjs（brw pr-merge）", exitCode: 0, output: `{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"brw pr-merge は利用者が自分の端末で実行するコマンドです"}}`, facts: { decision: "deny" } },
  { id: "M4b", at: AT, command: "scripts/agent-hooks.mjs（gh pr merge）", exitCode: 0, output: `{"hookSpecificOutput":{"permissionDecision":"deny"}}`, facts: { decision: "deny" } },
];
const withObs = (id, patch) => goodMerge().map((o) => (o.id === id ? { ...o, ...patch, facts: { ...o.facts, ...(patch.facts ?? {}) } } : o));
const mergeOf = (id, patch) => judgeMergeObservations(withObs(id, patch)).verdict;
// 判定の項目は、ホストの判定が name、GitHub の観測が id を持つ
const itemOf = (judged, id) => judged.items.find((i) => (i.id ?? i.name) === id);

export const runEnforceObserveChecks = async (eq) => {
  // ---- 引数 ----
  eq("enforce-observe/19.2 hosts 段階は --host と --dry-run を読む", parseArgs(["--stage", "hosts", "--host", "claude", "--dry-run"]), { stage: "hosts", host: "claude", dryRun: true, help: false, error: null });
  eq("enforce-observe/19.2 merge 段階は --host を取らず、既定で実行は本番", parseArgs(["--stage", "merge"]), { stage: "merge", host: null, dryRun: false, help: false, error: null });
  eq("enforce-observe/19.2 --stage が無ければ使い方の誤り", parseArgs([]).error !== null, true);
  eq("enforce-observe/19.2 未知の段階は使い方の誤り", parseArgs(["--stage", "bogus"]).error !== null, true);
  eq("enforce-observe/19.2 hosts 段階で --host が無ければ使い方の誤り", parseArgs(["--stage", "hosts"]).error !== null, true);
  eq("enforce-observe/19.2 未知のホストは使い方の誤り", parseArgs(["--stage", "hosts", "--host", "gemini"]).error !== null, true);
  eq("enforce-observe/19.2 merge 段階に --host を付けたら使い方の誤り", parseArgs(["--stage", "merge", "--host", "claude"]).error !== null, true);
  eq("enforce-observe/19.2 未知の引数は使い方の誤り", parseArgs(["--bogus"]).error !== null, true);

  // ---- 値の説明（例外にならない） ----
  eq("enforce-observe/19.2 describeValue は null・配列・真偽値を説明する", [describeValue(null), describeValue([1]), describeValue(true)], ["null", "array", "true"]);
  eq("enforce-observe/19.2 describeValue は toString が例外を投げるオブジェクトでも例外にしない", describeValue({ toString() { throw new Error("x"); } }), "object");
  eq("enforce-observe/19.2 describeValue は長い文字列を 40 字で切る", describeValue("あ".repeat(60)).length <= 41, true);

  // ---- 記録の形式 ----
  eq("enforce-observe/19.2 正規の記録は形式の不正なし", invalidHookRecord(rec("claude", "PreToolUse", bashIn("x"), ALLOW), "claude"), null);
  eq("enforce-observe/19.2 応答が空（確認の応答なし）の記録は正規", invalidHookRecord(rec("codex", "PreToolUse", bashIn("x"), ""), "codex"), null);
  eq("enforce-observe/19.2 応答が空白のみの記録は応答なしとして正規", invalidHookRecord(rec("claude", "Stop", stopIn(true), " \n"), "claude"), null);
  const base = rec("claude", "Stop", stopIn(false), BLOCK_NEW);
  eq("enforce-observe/19.2 時刻が無い記録は不正", invalidHookRecord({ ...base, ts: undefined }, "claude") !== null, true);
  eq("enforce-observe/19.2 別のホストの記録は不正（取り違え）", invalidHookRecord(base, "codex") !== null, true);
  eq("enforce-observe/19.2 イベント名が空の記録は不正", invalidHookRecord({ ...base, event: "" }, "claude") !== null, true);
  eq("enforce-observe/19.2 入力が文字列（解釈できない入力）の記録は不正", invalidHookRecord({ ...base, input: "raw" }, "claude") !== null, true);
  eq("enforce-observe/19.2 応答が JSON として解釈できない記録は不正", invalidHookRecord({ ...base, stdout: "{broken" }, "claude") !== null, true);
  eq("enforce-observe/19.2 終了コードが整数でない記録は不正", invalidHookRecord({ ...base, exit: "0" }, "claude") !== null, true);
  eq("enforce-observe/19.2 記録の検証は値の文字列化で例外にならない", typeof invalidHookRecord({ ...base, ts: { toString() { throw new Error("x"); } } }, "claude"), "string");
  const text = [JSON.stringify(rec("claude", "Stop", stopIn(false), BLOCK_NEW)), "{broken", "", JSON.stringify({ ...base, exit: "1" })].join("\n");
  const parsed = parseHookLogDetailed(text, "claude");
  eq("enforce-observe/19.2 解析できない行と不正な行は件数として数え、空行は数えない", [parsed.entries.length, parsed.broken], [1, 2]);

  // ---- H1（確認の省略と commit）。根拠は git add と git commit を同じ Bash 呼び出しに含む記録だけ ----
  eq("enforce-observe/19.2 H1 Claude: allow の応答と commit があれば一致", judgeHostScenario({ id: "H1", kind: "commit-allowed" }, h1Claude()).verdict, "一致");
  eq("enforce-observe/19.2 H1 Claude: 応答が無い（allow でない）は不一致", judgeHostScenario({ id: "H1", kind: "commit-allowed" }, h1Claude({ entries: [rec("claude", "PreToolUse", bashIn(COMMIT_CMD), "")] })).verdict, "不一致");
  eq("enforce-observe/19.2 H1: commit に note.txt が無いのは不一致", judgeHostScenario({ id: "H1", kind: "commit-allowed" }, h1Claude({ facts: { headChanged: true, commitHasFile: false } })).verdict, "不一致");
  eq("enforce-observe/19.2 H1: git add と git commit を別々の呼び出しに分けた記録は根拠にせず、未観測（一致にしない）", judgeHostScenario({ id: "H1", kind: "commit-allowed" }, h1Claude({ entries: [rec("claude", "PreToolUse", bashIn("git add note.txt"), ALLOW), rec("claude", "PreToolUse", bashIn('git commit -m "記録"'), ALLOW)] })).verdict, "未観測");
  eq("enforce-observe/19.2 H1: 単独の git commit の記録は根拠にせず、一致にしない", judgeHostScenario({ id: "H1", kind: "commit-allowed" }, h1Claude({ entries: [rec("claude", "PreToolUse", bashIn('git commit -m "記録"'), ALLOW)] })).verdict !== "一致", true);
  eq("enforce-observe/19.2 H1 Claude: 終了コードが 0 でない allow の記録は一致にしない", judgeHostScenario({ id: "H1", kind: "commit-allowed" }, h1Claude({ entries: [rec("claude", "PreToolUse", bashIn(COMMIT_CMD), ALLOW, 1)] })).verdict !== "一致", true);
  eq("enforce-observe/19.2 H1 Claude: allow 以外の JSON 応答（ask）は一致にしない", judgeHostScenario({ id: "H1", kind: "commit-allowed" }, h1Claude({ entries: [rec("claude", "PreToolUse", bashIn(COMMIT_CMD), JSON.stringify({ hookSpecificOutput: { permissionDecision: "ask" } }))] })).verdict, "不一致");
  const codexNoPerm = { host: "codex", entries: [rec("codex", "PreToolUse", bashIn(COMMIT_CMD), "")], broken: 0, ...ok, facts: { headChanged: false, commitHasFile: false } };
  const j1 = judgeHostScenario({ id: "H1", kind: "commit-allowed" }, codexNoPerm);
  eq("enforce-observe/19.2 H1 Codex: PermissionRequest が届かず commit も無ければ未観測（PermissionRequest 未観測と書く）", [j1.verdict, itemOf(j1, "hook").detail.includes("PermissionRequest 未観測")], ["未観測", true]);
  eq("enforce-observe/19.2 H1 Codex: PermissionRequest が allow で commit があれば一致", judgeHostScenario({ id: "H1", kind: "commit-allowed" }, { ...codexNoPerm, entries: [rec("codex", "PermissionRequest", bashIn(COMMIT_CMD), PR_ALLOW)], facts: { headChanged: true, commitHasFile: true } }).verdict, "一致");
  eq("enforce-observe/19.2 H1 Codex: PermissionRequest の deny は不一致", judgeHostScenario({ id: "H1", kind: "commit-allowed" }, { ...codexNoPerm, entries: [rec("codex", "PermissionRequest", bashIn(COMMIT_CMD), PR_DENY)], facts: { headChanged: true, commitHasFile: true } }).verdict, "不一致");
  eq("enforce-observe/19.2 H1: 記録に不正な行が 1 件でもあれば記録不正（一致にしない）", judgeHostScenario({ id: "H1", kind: "commit-allowed" }, h1Claude({ broken: 1 })).verdict, "記録不正");
  eq("enforce-observe/19.2 H1: ホストの終了コードが 0 以外なら一致にしない", judgeHostScenario({ id: "H1", kind: "commit-allowed" }, h1Claude({ exitCode: 1 })).verdict !== "一致", true);
  eq("enforce-observe/19.2 H1: タイムアウトなら一致にしない", judgeHostScenario({ id: "H1", kind: "commit-allowed" }, h1Claude({ timedOut: true })).verdict !== "一致", true);
  eq("enforce-observe/19.2 H1: 記録が無ければ未観測", judgeHostScenario({ id: "H1", kind: "commit-allowed" }, h1Claude({ entries: [] })).verdict, "未観測");

  // ---- H2（保護ブランチの拒否） ----
  const h2 = (entries, headChanged) => ({ host: "claude", entries, broken: 0, ...ok, facts: { headChanged } });
  eq("enforce-observe/19.2 H2: deny があり HEAD が変わらなければ一致", judgeHostScenario({ id: "H2", kind: "protected-denied" }, h2([rec("claude", "PreToolUse", bashIn(COMMIT_CMD), DENY)], false)).verdict, "一致");
  eq("enforce-observe/19.2 H2: HEAD が変わったら不一致", judgeHostScenario({ id: "H2", kind: "protected-denied" }, h2([rec("claude", "PreToolUse", bashIn(COMMIT_CMD), DENY)], true)).verdict, "不一致");
  eq("enforce-observe/19.2 H2: allow になっていたら不一致", judgeHostScenario({ id: "H2", kind: "protected-denied" }, h2([rec("claude", "PreToolUse", bashIn(COMMIT_CMD), ALLOW)], false)).verdict, "不一致");
  eq("enforce-observe/19.2 H2: deny の記録が無ければ未観測（HEAD は変わらない）", judgeHostScenario({ id: "H2", kind: "protected-denied" }, h2([], false)).verdict, "未観測");
  eq("enforce-observe/19.2 H2: 終了コードが 0 でない deny は根拠にせず一致にしない", judgeHostScenario({ id: "H2", kind: "protected-denied" }, h2([rec("claude", "PreToolUse", bashIn(COMMIT_CMD), DENY, 2)], false)).verdict !== "一致", true);
  eq("enforce-observe/19.2 H2: git add と git commit を別々の呼び出しに分けた deny は根拠にせず未観測", judgeHostScenario({ id: "H2", kind: "protected-denied" }, h2([rec("claude", "PreToolUse", bashIn('git commit -m "x"'), DENY)], false)).verdict, "未観測");

  // ---- H3・H3w（Stop の block と再入） ----
  const stopObs = (entries, extra = {}) => ({ host: "claude", entries, broken: 0, ...ok, facts: { expectPath: "new.txt" }, ...extra });
  const first = rec("claude", "Stop", stopIn(false), BLOCK_NEW);
  const again = rec("claude", "Stop", stopIn(true), "");
  eq("enforce-observe/19.2 H3: 1 回目が未コミットとパスを含めて block され、再入は通れば一致", judgeHostScenario({ id: "H3", kind: "stop-blocked" }, stopObs([first, again])).verdict, "一致");
  eq("enforce-observe/19.2 H3: block の理由にパスが無ければ不一致", judgeHostScenario({ id: "H3", kind: "stop-blocked" }, stopObs([rec("claude", "Stop", stopIn(false), JSON.stringify({ decision: "block", reason: "未コミット" })), again])).verdict, "不一致");
  eq("enforce-observe/19.2 H3: 1 回目が block されなければ不一致", judgeHostScenario({ id: "H3", kind: "stop-blocked" }, stopObs([rec("claude", "Stop", stopIn(false), ""), again])).verdict, "不一致");
  eq("enforce-observe/19.2 H3: 1 回目の終了コードが 0 でない block は一致にしない", judgeHostScenario({ id: "H3", kind: "stop-blocked" }, stopObs([rec("claude", "Stop", stopIn(false), BLOCK_NEW, 2), again])).verdict !== "一致", true);
  eq("enforce-observe/19.2 H3: 1 回目が block 以外の JSON（approve）なら不一致", judgeHostScenario({ id: "H3", kind: "stop-blocked" }, stopObs([rec("claude", "Stop", stopIn(false), JSON.stringify({ decision: "approve", reason: "未コミット new.txt" })), again])).verdict, "不一致");
  eq("enforce-observe/19.2 H3: 再入でまた block されたら不一致", judgeHostScenario({ id: "H3", kind: "stop-blocked" }, stopObs([first, rec("claude", "Stop", stopIn(true), BLOCK_NEW)])).verdict, "不一致");
  eq("enforce-observe/19.2 H3: 再入が block 以外の JSON 応答（approve）なら一致にしない", judgeHostScenario({ id: "H3", kind: "stop-blocked" }, stopObs([first, rec("claude", "Stop", stopIn(true), JSON.stringify({ decision: "approve" }))])).verdict, "不一致");
  eq("enforce-observe/19.2 H3: 再入が終了コード非 0（応答が空）なら一致にしない", judgeHostScenario({ id: "H3", kind: "stop-blocked" }, stopObs([first, rec("claude", "Stop", stopIn(true), "", 1)])).verdict !== "一致", true);
  eq("enforce-observe/19.2 H3: 再入が空白のみの stdout・終了コード 0 なら応答なしとして一致", judgeHostScenario({ id: "H3", kind: "stop-blocked" }, stopObs([first, rec("claude", "Stop", stopIn(true), " \n")])).verdict, "一致");
  eq("enforce-observe/19.2 H3: 再入の記録が無ければ未観測", judgeHostScenario({ id: "H3", kind: "stop-blocked" }, stopObs([first])).verdict, "未観測");
  eq("enforce-observe/19.2 H3w: 記録が不正なら記録不正", judgeHostScenario({ id: "H3w", kind: "stop-blocked" }, stopObs([first, again], { broken: 1 })).verdict, "記録不正");
  eq("enforce-observe/19.2 判定は解析できない行を一致の根拠にしない（記録不正）", judgeHostScenario({ id: "H3", kind: "stop-blocked" }, stopObs([first, again, { bogus: 1 }])).verdict, "記録不正");

  // ---- GitHub・端末の観測（M1〜M4）。表示・プロンプト・入力・順序・終了コード・PR の状態を確かめる ----
  eq("enforce-observe/19.2 M1〜M4 が整っていれば一致", judgeMergeObservations(goodMerge()).verdict, "一致");
  eq("enforce-observe/19.2 M3y が無ければ未観測", judgeMergeObservations(goodMerge().filter((o) => o.id !== "M3y")).verdict, "未観測");
  eq("enforce-observe/19.2 M1 で PR が閉じていたら不一致", mergeOf("M1", { facts: { prStateAfter: "merged" } }), "不一致");
  eq("enforce-observe/19.2 M1 で refs が変わっていたら不一致（brw が書き込んだ）", mergeOf("M1", { facts: { refsChanged: 1 } }), "不一致");
  eq("enforce-observe/19.2 M1: 「利用者が自分の端末」が無ければ不一致", mergeOf("M1", { output: "拒否しました" }), "不一致");
  eq("enforce-observe/19.2 M1: 質問（マージしますか）が出ていれば不一致（非端末で質問しない）", mergeOf("M1", { output: `利用者が自分の端末で ${MERGE_PROMPT}` }), "不一致");
  eq("enforce-observe/19.2 M2 の案内に GitHub 上が無ければ不一致", mergeOf("M2", { output: "保護ブランチです。" }), "不一致");
  eq("enforce-observe/19.2 M2: 「保護ブランチ」が無ければ不一致", mergeOf("M2", { output: "GitHub 上でマージしてください。" }), "不一致");
  eq("enforce-observe/19.2 M2: 質問（マージしますか）が出ていれば不一致（質問の前に拒否されるはず）", mergeOf("M2", { output: `${MERGE_PROMPT}\n保護ブランチです。GitHub 上でマージしてください。`, facts: { promptSeen: true } }), "不一致");
  eq("enforce-observe/19.2 M3n: 表示・プロンプト・入力 n・中止の順で揃い、終了コード 1 なら一致（既定の正しい形）", judgeMergeObservations(goodMerge()).items.find((i) => i.id === "M3n").state, "一致");
  eq("enforce-observe/19.2 M3n: プロンプトが無い（プロンプト前のエラー）は不一致", mergeOf("M3n", { output: `${header(1)}中止しました。マージしていません。\n`, facts: { promptSeen: false } }), "不一致");
  eq("enforce-observe/19.2 M3n: 表示（PR の番号と見出し）が無ければ不一致", mergeOf("M3n", { output: `${MERGE_PROMPT}n\n中止しました。マージしていません。\n` }), "不一致");
  eq("enforce-observe/19.2 M3n: 表示の head の SHA が一致しなければ不一致", mergeOf("M3n", { output: header(1).replace(HEAD_SHA.slice(0, 12), "d".repeat(12)) + `${MERGE_PROMPT}n\n中止しました。マージしていません。\n` }), "不一致");
  eq("enforce-observe/19.2 M3n: 送った入力が n でなければ不一致", mergeOf("M3n", { facts: { sentInput: "y" } }), "不一致");
  eq("enforce-observe/19.2 M3n: 中止の文言が無ければ不一致", mergeOf("M3n", { output: `${header(1)}${MERGE_PROMPT}n\n` }), "不一致");
  eq("enforce-observe/19.2 M3n: 中止の文言がプロンプトより前にあれば（順序違い）不一致", mergeOf("M3n", { output: `${header(1)}中止しました。マージしていません。\n${MERGE_PROMPT}n\n` }), "不一致");
  eq("enforce-observe/19.2 M3n: 終了コードが 0 なら不一致", mergeOf("M3n", { exitCode: 0 }), "不一致");
  eq("enforce-observe/19.2 M3n: PR が merged なら不一致", mergeOf("M3n", { facts: { prStateAfter: "merged" } }), "不一致");
  eq("enforce-observe/19.2 M3y の squash 親が 2 つなら不一致", mergeOf("M3y", { facts: { parentCount: 2 } }), "不一致");
  eq("enforce-observe/19.2 M3y のマージ commit が分岐元の先頭と違えば不一致", mergeOf("M3y", { facts: { baseHeadSha: "b".repeat(40) } }), "不一致");
  eq("enforce-observe/19.2 M3y で head ブランチが消えていたら不一致（消さない契約）", mergeOf("M3y", { facts: { headBranchExists: false } }), "不一致");
  eq("enforce-observe/19.2 M3y: 送った入力が y でなければ不一致", mergeOf("M3y", { facts: { sentInput: "n" } }), "不一致");
  eq("enforce-observe/19.2 M3y: 「マージしました」が無ければ不一致", mergeOf("M3y", { output: `${header(1)}${MERGE_PROMPT}y\n` }), "不一致");
  eq("enforce-observe/19.2 M3y: プロンプトが無ければ不一致", mergeOf("M3y", { facts: { promptSeen: false } }), "不一致");
  eq("enforce-observe/19.2 M3y: 表示の取り込み（head → base）が違えば不一致", mergeOf("M3y", { output: header(1).replace(`→ \`${BASE_REF}\``, `→ \`${PROT_REF}\``) + `${MERGE_PROMPT}y\nマージしました。\n` }), "不一致");
  eq("enforce-observe/19.2 M4a が allow なら不一致", mergeOf("M4a", { facts: { decision: "allow" } }), "不一致");
  eq("enforce-observe/19.2 M4 のフックが終了コード 0 でなければ一致にしない", judgeMergeObservations(withObs("M4b", { exitCode: 2 })).verdict !== "一致", true);
  eq("enforce-observe/19.2 観測の exitCode が文字列なら記録不正", mergeOf("M1", { exitCode: "1" }), "記録不正");
  eq("enforce-observe/19.2 pty の観測に headSha が無い（形式の不正）は記録不正", mergeOf("M3n", { facts: { headSha: undefined } }), "記録不正");
  eq("enforce-observe/19.2 知らない観測 ID は記録不正", judgeMergeObservations([...goodMerge(), { ...goodMerge()[0], id: "M9" }]).verdict, "記録不正");
  eq("enforce-observe/19.2 同じ観測 ID が 2 件あれば記録不正", judgeMergeObservations([...goodMerge(), goodMerge()[0]]).verdict, "記録不正");
  eq("enforce-observe/19.2 観測の形式（facts が無い）の不正", invalidMergeObservation({ ...goodMerge()[0], facts: null }) !== null, true);
  eq("enforce-observe/19.2 観測の形式（M3y の parentCount が無い）の不正", invalidMergeObservation(withObs("M3y", { facts: { parentCount: undefined } })[3]) !== null, true);
  eq("enforce-observe/19.2 M3n の失敗理由（項目）に、外れた条件の名前を書く", itemOf(judgeMergeObservations(withObs("M3n", { output: "中止" })), "M3n").detail.includes("プロンプト"), true);

  // ---- 計画と整形（呼び出し・書き込みなし） ----
  const p = planHosts("claude");
  eq("enforce-observe/19.2 hosts の計画は 1 ホストあたり最大 4 回の呼び出しで、シナリオは H1・H2・H3・H3w", [p.calls, p.scenarios.map((s) => s.id)], [4, ["H1", "H2", "H3", "H3w"]]);
  eq("enforce-observe/19.2 claude の呼び出しは project の設定だけを読み、Bash を許可する", hostCommand("claude", { cwd: "/d", prompt: "p" }).args.includes("project") && hostCommand("claude", { cwd: "/d", prompt: "p" }).args.includes("Bash"), true);
  const mp = planMerge(1700000000);
  eq("enforce-observe/19.2 merge の計画は使い捨てブランチ 3 本と観測 6 件を示す", [mp.branches.length, mp.observations.length], [3, 6]);
  eq("enforce-observe/19.2 merge の計画のブランチ名は検証用の形", mp.branches.every((b) => /^(verify\/brw-base-|verify\/brw-prot-|dev\/verify-merge-)\d+$/.test(b)), true);
  const hostMd = formatHostReport({ host: "claude", version: "1.0.0", at: AT, results: [judgeHostScenario({ id: "H1", kind: "commit-allowed" }, h1Claude())], calls: 1, exitCode: 0 });
  eq("enforce-observe/19.2 ホストの報告は Markdown で、ホスト・版・日時を含む", [hostMd.includes("claude"), hostMd.includes("1.0.0"), hostMd.includes(AT), hostMd.startsWith("###")], [true, true, true, true]);
  const mergeMd = formatMergeReport({ at: AT, judged: judgeMergeObservations(goodMerge()) });
  eq("enforce-observe/19.2 merge の報告は総合の欄を含む", mergeMd.includes("総合: 一致"), true);

  // ---- 入口（実ホストも GitHub も呼ばない） ----
  const dir = mkdtempSync(join(tmpdir(), "brw-enfobs-t-"));
  try {
    const work = join(dir, "work");
    const env = { ...noRealEnv, BRW_REAL_ENV: "1", BRW_REAL_ENV_DIR: work };
    const dry = spawnSync(process.execPath, [script, "--stage", "hosts", "--host", "claude", "--dry-run"], { env, encoding: "utf8" });
    eq("enforce-observe/19.2 --dry-run は終了コード 0 で、作業場所も呼び出しの記録も作らない", [dry.status, existsSync(work), dry.stdout.includes("呼び出し")], [0, false, true]);
    const dryMerge = spawnSync(process.execPath, [script, "--stage", "merge", "--dry-run"], { env, encoding: "utf8" });
    eq("enforce-observe/19.2 merge の --dry-run も GitHub へ書き込まず、作業場所を作らない", [dryMerge.status, existsSync(work)], [0, false]);
    const off = spawnSync(process.execPath, [script, "--stage", "hosts", "--host", "claude"], { env: noRealEnv, encoding: "utf8" });
    eq("enforce-observe/19.2 BRW_REAL_ENV が無ければ何もせず終了コード 0", [off.status, existsSync(work), off.stdout.includes("BRW_REAL_ENV=1")], [0, false, true]);
    const bad = spawnSync(process.execPath, [script, "--stage", "bogus"], { env, encoding: "utf8" });
    eq("enforce-observe/19.2 引数の誤りは終了コード 2", bad.status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
