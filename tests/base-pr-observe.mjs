// 分岐元からの PR の実環境の観測（brw-pr-handoff 5.2・8.2）の引数・記録の検証・判定・計画・整形を、GitHub と実ホストを呼ばずに確かめる。
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  a2Message, claudeArgs, declarationFor, formatEvidence, formatObservationReport, invalidApiObservation, invalidHostObservation, judgeApiObservations,
  judgeHostObservations, parseArgs, parseClaudeStream, parseHookRuns, parseStatus, brwPrOutput, planApi, planHost, promptB1,
  createdPrNumber, prNumbersForHead, toOpenPrs,
} from "./real-env/base-pr-observe.mjs";

const script = join(dirname(fileURLToPath(import.meta.url)), "real-env/base-pr-observe.mjs");
const noRealEnv = { ...process.env };
delete noRealEnv.BRW_REAL_ENV;

const AT = "2026-11-27T10:00:00.000Z";
const SHA1 = "a".repeat(40);
const SHA2 = "b".repeat(40);
const BASE = "verify/brw-bpr-base-1";
const PROT = "verify/brw-bpr-prot-1";
const URL9 = "https://github.com/nekono-dev/branch-release-workflow/pull/9";

// ---- 観測の見本（A） ----
const a1 = (over = {}) => ({
  id: "A1", at: AT, command: "gh api -i -X POST repos/x/pulls", exitCode: 0, output: "HTTP/2.0 201 Created",
  facts: { status: 201, requestedHead: BASE, requestedBase: PROT, prNumber: 7, prBaseRef: PROT, prHeadRef: BASE, prState: "open", ...over },
});
const a2 = (over = {}) => ({
  id: "A2", at: AT, command: "gh api -i -X POST repos/x/pulls（同じ commit）", exitCode: 1, output: "No commits between verify/brw-bpr-prot-1 and verify/brw-bpr-same-1 (HTTP 422)",
  facts: { status: 422, message: "No commits between verify/brw-bpr-prot-1 and verify/brw-bpr-same-1", prCreated: false, ...over },
});

// ---- 観測の見本（B） ----
const hostFacts = (over = {}) => ({
  openPrs: [{ number: 9, state: "open", baseRef: PROT, headRef: BASE }],
  refBefore: SHA1, refAfter: SHA1, cloneHeadBefore: SHA2, cloneHeadAfter: SHA2, cloneBranch: BASE,
  brwDirExists: false, requestedHead: BASE, requestedBase: PROT, hostExitCode: 0, timedOut: false, ...over,
});
const b1 = (over = {}, factOver = {}) => ({
  id: "B1", at: AT, command: "claude -p（brw pr）", exitCode: 0,
  output: `PR を作成しました: ${URL9}\n取り込み先: ${PROT}`,
  facts: hostFacts({ hookRuns: { prTemplate: true, pr: true, directGhPrCreate: false, invalidLines: 0 }, ...factOver }), ...over,
});
const b2 = (over = {}, factOver = {}) => ({
  id: "B2", at: AT, command: "node brw.mjs pr --title 分岐元からの PR の確認", exitCode: 0,
  output: `PR を再利用しました: ${URL9}\n取り込み先: ${PROT}`, facts: hostFacts(factOver), ...over,
});
const b3 = (over = {}, factOver = {}) => ({
  id: "B3", at: AT, command: "node brw.mjs pr --title x（承認が必要な宣言）", exitCode: 1,
  output: "PR 作成には通常の承認が必要です。承認はエージェントが代行できません。\n  brw pr --title 'x' --body-file 'b' --target 'p' --confirmed",
  facts: hostFacts({ openPrs: [], ...factOver }), ...over,
});
const b3c = (over = {}, factOver = {}) => ({
  id: "B3c", at: AT, command: "node brw.mjs pr --title x --confirmed（非端末）", exitCode: 1,
  output: "--confirmed は、利用者が自分の端末で実行したときだけ有効です。エージェントは付けないでください。",
  facts: hostFacts({ openPrs: [], ...factOver }), ...over,
});
const hostAll = () => [b1(), b2(), b3(), b3c()];

// 判定の結果の項目を id で引く
const stateOf = (judged, id) => judged.items.find((i) => i.id === id)?.state;

export const runBasePrObserveChecks = async (eq) => {
  // ---- 実形式の回帰（gh api -i の出力はヘッダーが CRLF。実 GitHub の 422 で観測した形） ----
  const real422 = { out: 'HTTP/2.0 422 Unprocessable Entity\r\nContent-Type: application/json; charset=utf-8\r\nX-Github-Request-Id: x\r\n\r\n{"message":"Validation Failed","errors":[{"resource":"PullRequest","code":"custom","message":"No commits between a and b"}],"status":"422"}', err: "gh: Validation Failed (HTTP 422)\n" };
  eq("base-pr-observe/5.2 CRLF 区切りの 422 の本文から message と errors[].message を読む", a2Message(real422), "Validation Failed / No commits between a and b");
  eq("base-pr-observe/5.2 本文が読めなければ標準エラーと出力の先頭を返す", a2Message({ out: "HTTP/2.0 500\r\n\r\nnot json", err: "boom" }).includes("boom"), true);
  // ---- 引数 ----
  eq("base-pr-observe/5.2 api 段階は --dry-run を読む", parseArgs(["--stage", "api", "--dry-run"]), { stage: "api", dryRun: true, help: false, error: null });
  eq("base-pr-observe/8.2 host 段階は引数を取らずに実行できる", parseArgs(["--stage", "host"]), { stage: "host", dryRun: false, help: false, error: null });
  eq("base-pr-observe 段階が無ければ使い方の誤り", parseArgs([]).error !== null, true);
  eq("base-pr-observe 未知の段階は使い方の誤り", parseArgs(["--stage", "merge"]).error !== null, true);
  eq("base-pr-observe 未知の引数は使い方の誤り", parseArgs(["--bogus"]).error !== null, true);

  // ---- 計画・名前（クリーンアップの許可の形に合う） ----
  const pa = planApi(1700000000);
  eq("base-pr-observe 5.2 の使い捨てブランチ名は verify/brw-bpr-*", pa.branches.map((b) => b.replace(/-\d+$/, "")), ["verify/brw-bpr-base", "verify/brw-bpr-prot", "verify/brw-bpr-same"]);
  eq("base-pr-observe 作ったブランチ名は cleanup.mjs の削除対象の形", pa.branches.every((b) => /^(verify\/|dev\/verify-merge-\d+$)/.test(b)), true);
  const ph = planHost(1700000000);
  eq("base-pr-observe 8.2 の分岐元・保護ブランチ名は verify/brw-bpr-*", [ph.base.startsWith("verify/brw-bpr-base-"), ph.prot.startsWith("verify/brw-bpr-prot-")], [true, true]);
  eq("base-pr-observe 8.2 の観測は 4 件（B1・B2・B3・B3c）", ph.observations.map((o) => o.id), ["B3", "B3c", "B1", "B2"]);
  eq("base-pr-observe 8.2 の claude 呼び出しは 1 回", ph.claudeCalls, 1);
  const args = claudeArgs("テスト");
  eq("base-pr-observe claude は Haiku・max-turns 10・project の設定だけ", [args.includes("haiku"), args[args.indexOf("--max-turns") + 1], args[args.indexOf("--setting-sources") + 1], args.includes("--no-session-persistence")], [true, "10", "project", true]);
  eq("base-pr-observe B1 の指示は pr-template と pr を名指しする", [promptB1("/x/scripts/brw.mjs").includes("brw.mjs\" pr-template") || promptB1("/x/scripts/brw.mjs").includes("pr-template"), promptB1("/x/scripts/brw.mjs").includes("pr --title")], [true, true]);

  // 宣言: 登録済み（autoApprove 未指定）と承認が必要（pullRequest: false）
  const reg = declarationFor({ base: BASE, prot: PROT });
  eq("base-pr-observe 宣言は保護役を含み分岐元を基底にする", [reg.protectedBranches, reg.baseBranch, reg.baseBranches, reg.workBranches], [["main", PROT], BASE, [BASE], ["dev/*"]]);
  eq("base-pr-observe 登録済みの宣言は autoApprove を書かない", "autoApprove" in reg, false);
  eq("base-pr-observe 承認が必要な宣言は pullRequest を false にする", declarationFor({ base: BASE, prot: PROT }, { approvalRequired: true }).autoApprove, { pullRequest: false });

  // 出力の解析
  eq("base-pr-observe HTTP 状態（成功の -i 出力）を読む", parseStatus("HTTP/2.0 201 Created\n\n{}"), 201);
  eq("base-pr-observe HTTP 状態（エラーの括弧書き）を読む", parseStatus("gh: No commits (HTTP 422)"), 422);
  eq("base-pr-observe HTTP 状態が無ければ null", parseStatus("何もない"), null);
  const stream = [
    { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "node /x/scripts/brw.mjs pr --title a" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: `PR を作成しました: ${URL9}`, is_error: false }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "node /x/scripts/brw.mjs pr-template" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "雛形", is_error: false }] } },
  ].map((o) => JSON.stringify(o)).join("\n");
  const parsed = parseClaudeStream(stream);
  eq("base-pr-observe stream-json の tool_result を対応づける", parsed.results.map((r) => [r.command.includes("pr-template") ? "tpl" : "pr", r.isError]), [["pr", false], ["tpl", false]]);
  eq("base-pr-observe stream-json の解析できない行を数える", parseClaudeStream(`${stream}\n{bad`).invalidLines, 1);
  eq("base-pr-observe brw pr の結果（pr-template を除く）を取る", brwPrOutput(parsed.results), `PR を作成しました: ${URL9}`);
  eq("base-pr-observe brw pr の結果が無ければ null", brwPrOutput([]), null);

  // フックの記録（実際に実行されたか・直接の gh pr create）
  const hookLine = (event, command, stdout = "") => JSON.stringify({ event, input: { tool_name: "Bash", tool_input: { command } }, stdout, exit: 0 });
  const denyOut = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } });
  const okRuns = parseHookRuns([
    hookLine("PreToolUse", "node /x/scripts/brw.mjs pr-template"),
    hookLine("PostToolUse", "node /x/scripts/brw.mjs pr-template"),
    hookLine("PreToolUse", "node /x/scripts/brw.mjs pr --title a"),
    hookLine("PostToolUse", "node /x/scripts/brw.mjs pr --title a"),
  ].join("\n"));
  eq("base-pr-observe フックの記録: 実行後の記録がある brw pr-template と brw pr を認める", [okRuns.prTemplate, okRuns.pr, okRuns.directGhPrCreate, okRuns.invalidLines], [true, true, false, 0]);
  const onlyPre = parseHookRuns(hookLine("PreToolUse", "node /x/scripts/brw.mjs pr --title a"));
  eq("base-pr-observe 事前の記録だけでは brw pr の実行とみなさない", onlyPre.pr, false);
  const prNotPrTemplate = parseHookRuns(hookLine("PostToolUse", "node /x/scripts/brw.mjs pr-template"));
  eq("base-pr-observe pr-template は brw pr の実行とみなさない", prNotPrTemplate.pr, false);
  eq("base-pr-observe 直接の gh pr create（許可された記録）を検出する", parseHookRuns(hookLine("PreToolUse", "gh pr create --base main --head x", "")).directGhPrCreate, true);
  eq("base-pr-observe 直接の gh pr create が拒否されていれば検出しない", parseHookRuns(hookLine("PreToolUse", "gh pr create --base main --head x", denyOut)).directGhPrCreate, false);
  eq("base-pr-observe フックの記録の解析できない行を数える", parseHookRuns(`${hookLine("PostToolUse", "node /x/scripts/brw.mjs pr --title a")}\n{bad`).invalidLines, 1);
  eq("base-pr-observe フックの記録が空なら何も実行されていない", parseHookRuns("").pr, false);

  // ---- 5.2（API）の判定 ----
  eq("base-pr-observe 5.2 A1・A2 がそろい条件を満たせば一致", judgeApiObservations([a1(), a2()]).verdict, "一致");
  eq("base-pr-observe 5.2 A2 が無ければ未観測", judgeApiObservations([a1()]).verdict, "未観測");
  eq("base-pr-observe 5.2 A1 が 422 なら不一致", judgeApiObservations([a1({ status: 422 }), a2()]).verdict, "不一致");
  eq("base-pr-observe 5.2 A1 の読み戻しが無ければ（読み取り失敗）未観測", stateOf(judgeApiObservations([a1({ prState: null }), a2()]), "A1"), "未観測");
  eq("base-pr-observe 5.2 A1 の head が要求と違えば不一致", stateOf(judgeApiObservations([a1({ prHeadRef: PROT }), a2()]), "A1"), "不一致");
  eq("base-pr-observe 5.2 A2 が作成されてしまえば不一致", stateOf(judgeApiObservations([a1(), a2({ status: 201, prCreated: true })]), "A2"), "不一致");
  eq("base-pr-observe 5.2 A2 の理由が No commits でなければ不一致", stateOf(judgeApiObservations([a1(), a2({ message: "Validation Failed" })]), "A2"), "不一致");
  eq("base-pr-observe 5.2 A2 の読み取れない理由は未観測", stateOf(judgeApiObservations([a1(), a2({ message: null })]), "A2"), "未観測");
  eq("base-pr-observe 5.2 status が文字列なら記録不正", judgeApiObservations([a1({ status: "201" }), a2()]).verdict, "記録不正");
  const missingFact = a1();
  delete missingFact.facts.prNumber;
  eq("base-pr-observe 5.2 facts の欠けは記録不正", judgeApiObservations([missingFact, a2()]).verdict, "記録不正");
  eq("base-pr-observe 5.2 観測 ID が想定外なら記録不正", judgeApiObservations([{ ...a1(), id: "A9" }, a2()]).verdict, "記録不正");
  eq("base-pr-observe 5.2 観測が null なら記録不正", judgeApiObservations([null, a2()]).verdict, "記録不正");
  eq("base-pr-observe 5.2 exitCode が整数でなければ記録不正", invalidApiObservation({ ...a1(), exitCode: "0" }) !== null, true);
  eq("base-pr-observe 5.2 同じ ID が 2 件あれば記録不正", judgeApiObservations([a1(), a1(), a2()]).verdict, "記録不正");
  eq("base-pr-observe 5.2 観測が無ければ（配列でない）未観測", judgeApiObservations(null).verdict, "未観測");
  eq("base-pr-observe 5.2 不正な観測が 1 件でもあれば一致にしない", judgeApiObservations([a1(), a2(), { id: "A1" }]).verdict !== "一致", true);

  // ---- 8.2（host）の判定 ----
  eq("base-pr-observe 8.2 すべて満たせば一致", judgeHostObservations(hostAll()).verdict, "一致");
  eq("base-pr-observe 8.2 B1 が無ければ未観測", judgeHostObservations([b2(), b3(), b3c()]).verdict, "未観測");
  eq("base-pr-observe 8.2 host の終了コードが 0 以外なら B1 は未観測（不一致にしない）", stateOf(judgeHostObservations([b1({}, { hostExitCode: 1 }), b2(), b3(), b3c()]), "B1"), "未観測");
  eq("base-pr-observe 8.2 host のタイムアウトは未観測", stateOf(judgeHostObservations([b1({}, { timedOut: true }), b2(), b3(), b3c()]), "B1"), "未観測");
  eq("base-pr-observe 8.2 brw pr-template が記録に無ければ不一致", stateOf(judgeHostObservations([b1({}, { hookRuns: { prTemplate: false, pr: true, directGhPrCreate: false, invalidLines: 0 } }), b2(), b3(), b3c()]), "B1"), "不一致");
  eq("base-pr-observe 8.2 直接の gh pr create が使われたら不一致", stateOf(judgeHostObservations([b1({}, { hookRuns: { prTemplate: true, pr: true, directGhPrCreate: true, invalidLines: 0 } }), b2(), b3(), b3c()]), "B1"), "不一致");
  eq("base-pr-observe 8.2 出力の書式が違えば不一致", stateOf(judgeHostObservations([b1({ output: "PR を作りました: " + URL9 }), b2(), b3(), b3c()]), "B1"), "不一致");
  eq("base-pr-observe 8.2 分岐元の GitHub 上の先頭が変われば不一致", stateOf(judgeHostObservations([b1({}, { refAfter: SHA2 }), b2(), b3(), b3c()]), "B1"), "不一致");
  eq("base-pr-observe 8.2 クローンの HEAD が変われば不一致", stateOf(judgeHostObservations([b1({}, { cloneHeadAfter: SHA1 }), b2(), b3(), b3c()]), "B1"), "不一致");
  eq("base-pr-observe 8.2 .git/brw があれば不一致", stateOf(judgeHostObservations([b1({}, { brwDirExists: true }), b2(), b3(), b3c()]), "B1"), "不一致");
  eq("base-pr-observe 8.2 PR が 2 件以上なら不一致", stateOf(judgeHostObservations([b1({}, { openPrs: [{ number: 9, state: "open", baseRef: PROT, headRef: BASE }, { number: 10, state: "open", baseRef: PROT, headRef: BASE }] }), b2(), b3(), b3c()]), "B1"), "不一致");
  eq("base-pr-observe 8.2 PR の読み取り失敗は未観測", stateOf(judgeHostObservations([b1({}, { openPrs: null }), b2(), b3(), b3c()]), "B1"), "未観測");
  eq("base-pr-observe 8.2 B2 が再利用と言わなければ不一致", stateOf(judgeHostObservations([b1(), b2({ output: `PR を作成しました: ${URL9}` }), b3(), b3c()]), "B2"), "不一致");
  eq("base-pr-observe 8.2 B2 で PR が見つからなければ不一致", stateOf(judgeHostObservations([b1(), b2({}, { openPrs: [] }), b3(), b3c()]), "B2"), "不一致");
  eq("base-pr-observe 8.2 B3 が成功終了なら不一致", stateOf(judgeHostObservations([b1(), b2(), b3({ exitCode: 0 }), b3c()]), "B3"), "不一致");
  eq("base-pr-observe 8.2 B3 で PR が作られていれば不一致", stateOf(judgeHostObservations([b1(), b2(), b3({}, { openPrs: [{ number: 3, state: "open", baseRef: PROT, headRef: BASE }] }), b3c()]), "B3"), "不一致");
  eq("base-pr-observe 8.2 B3c の案内が無ければ不一致", stateOf(judgeHostObservations([b1(), b2(), b3(), b3c({ output: "別の文" })]), "B3c"), "不一致");
  eq("base-pr-observe 8.2 フックの記録に解析できない行があれば記録不正", judgeHostObservations([b1({}, { hookRuns: { prTemplate: true, pr: true, directGhPrCreate: false, invalidLines: 2 } }), b2(), b3(), b3c()]).verdict, "記録不正");
  eq("base-pr-observe 8.2 hookRuns が無ければ記録不正", judgeHostObservations([b1({}, { hookRuns: undefined }), b2(), b3(), b3c()]).verdict, "記録不正");
  eq("base-pr-observe 8.2 refBefore が 40 桁の 16 進でなければ記録不正", judgeHostObservations([b1({}, { refBefore: "xyz" }), b2(), b3(), b3c()]).verdict, "記録不正");
  eq("base-pr-observe 8.2 PR の番号が無い行は記録不正", judgeHostObservations([b1(), b2(), b3({}, { openPrs: [{ state: "open", baseRef: PROT, headRef: BASE }] }), b3c()]).verdict, "記録不正");

  // ---- 報告・要点 ----
  const judged = judgeHostObservations(hostAll());
  const report = formatObservationReport({ stage: "host", at: AT, judged, version: "claude 1.0" });
  eq("base-pr-observe 報告にホスト・版・日時と総合が出る", [report.includes("claude 1.0"), report.includes(AT), report.includes("総合: 一致")], [true, true, true]);
  const long = { ...a1(), output: "x".repeat(500) };
  const ev = formatEvidence([long]);
  eq("base-pr-observe 要点は出力の先頭 300 字まで", ev.includes("x".repeat(300)) && !ev.includes("x".repeat(301)), true);
  eq("base-pr-observe 要点はコマンドと終了コードを出す", [ev.includes(long.command), ev.includes("終了コード 0")], [true, true]);

  // ---- 実行の入口（BRW_REAL_ENV 無し・--dry-run は作業場所を作らない） ----
  const off = spawnSync(process.execPath, [script, "--stage", "api"], { encoding: "utf8", env: noRealEnv });
  eq("base-pr-observe BRW_REAL_ENV が無ければ説明を出して終了コード 0", [off.status, off.stdout.includes("BRW_REAL_ENV=1")], [0, true]);
  const dir = mkdtempSync(join(tmpdir(), "brw-bpr-observe-test-"));
  try {
    const target = join(dir, "work");
    const dryEnv = { ...process.env, BRW_REAL_ENV: "1", BRW_REAL_ENV_DIR: target };
    const d1 = spawnSync(process.execPath, [script, "--stage", "api", "--dry-run"], { encoding: "utf8", env: dryEnv });
    const d2 = spawnSync(process.execPath, [script, "--stage", "host", "--dry-run"], { encoding: "utf8", env: dryEnv });
    eq("base-pr-observe --dry-run（api）は終了コード 0 で計画を出す", [d1.status, d1.stdout.includes("A1"), d1.stdout.includes("A2")], [0, true, true]);
    eq("base-pr-observe --dry-run（host）は claude を 1 回と観測の名を出す", [d2.status, d2.stdout.includes("B1"), d2.stdout.includes("1 回")], [0, true, true]);
    eq("base-pr-observe --dry-run は作業場所も呼び出しの記録も作らない", existsSync(target), false);
    const bad = spawnSync(process.execPath, [script, "--stage", "bogus"], { encoding: "utf8", env: dryEnv });
    eq("base-pr-observe 引数の誤りは終了コード 2", bad.status, 2);
    eq("base-pr-observe 引数の誤りでも作業場所を作らない", existsSync(target), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // ---- PR の番号の読み取り（作成の応答・一覧）。読めないものを空として扱わない ----
  eq("base-pr-observe 201 の応答から PR の番号を読む", createdPrNumber(201, { number: 7 }), 7);
  eq("base-pr-observe 201 でも番号が無ければ null（記録の対象を探す）", createdPrNumber(201, {}), null);
  eq("base-pr-observe 応答の本文が無ければ null", createdPrNumber(201, null), null);
  eq("base-pr-observe 201 以外の応答は番号を読まない", createdPrNumber(422, { number: 7 }), null);
  const heads = [
    { number: 3, state: "open", head: { ref: "verify/h" }, base: { ref: "verify/p" } },
    { number: 4, state: "closed", head: { ref: "verify/h" }, base: { ref: "verify/p" } },
    { number: 9, state: "open", head: { ref: "other" }, base: { ref: "verify/p" } },
  ];
  eq("base-pr-observe head で探した PR の番号（状態によらず）を取る", prNumbersForHead(heads, "verify/h"), [3, 4]);
  eq("base-pr-observe 一覧が配列でなければ null（空として扱わない）", prNumbersForHead(null, "verify/h"), null);
  eq("base-pr-observe 一覧の項目の番号が無ければ null", prNumbersForHead([{ head: { ref: "verify/h" } }], "verify/h"), null);
  eq("base-pr-observe 読み取りの失敗は null", toOpenPrs({ ok: false }, "verify/p"), null);
  eq("base-pr-observe 一覧の形が違えば null", toOpenPrs({ ok: true, data: { message: "x" } }, "verify/p"), null);
  eq("base-pr-observe 読めて 0 件は空の配列（null と区別）", toOpenPrs({ ok: true, data: [] }, "verify/p"), []);
  eq("base-pr-observe 読めた PR の一覧を整える", toOpenPrs({ ok: true, data: [{ number: 1, state: "open", base: { ref: "p" }, head: { ref: "h" } }] }, "p"), [{ number: 1, state: "open", baseRef: "p", headRef: "h" }]);
  eq("base-pr-observe 一覧の読み取り失敗は B3 を未観測にする（一致にしない）", stateOf(judgeHostObservations([b1(), b2(), b3({}, { openPrs: null }), b3c()]), "B3"), "未観測");
  eq("base-pr-observe 一覧の読み取り失敗は B2 を未観測にする", stateOf(judgeHostObservations([b1(), b2({}, { openPrs: null }), b3(), b3c()]), "B2"), "未観測");
  eq("base-pr-observe 一覧の読み取り失敗のとき全体は一致にならない", judgeHostObservations([b1({}, { openPrs: null }), b2(), b3(), b3c()]).verdict !== "一致", true);
};
