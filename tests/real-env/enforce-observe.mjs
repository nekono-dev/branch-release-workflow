#!/usr/bin/env node
// 19.2: 追加した規則（確認の省略・保護ブランチの拒否・Stop の block・brw pr-merge の端末限定）を、実環境で観測する。
// 使い方:
//   BRW_REAL_ENV=1 node tests/real-env/enforce-observe.mjs --stage hosts --host claude|codex [--dry-run]
//   BRW_REAL_ENV=1 node tests/real-env/enforce-observe.mjs --stage merge [--dry-run]
//
// 段階 hosts（実ホスト。GitHub へは書き込まない）: 1 シナリオ 1 回ずつ、ホストを最大 4 回呼ぶ。
//   origin は GitHub 形式の URL だが、試験用 ssh でローカルの bare リポジトリへ向ける。gh は偽物（呼ばれたら失敗する）。
//   フックは hook-logger.mjs を挟み、記録（hook-log/<host>.jsonl）と作業場所の Git の状態から判定する。
// 段階 merge（実 GitHub。使い捨てブランチ 3 本と PR 2 件だけに書き込む）: brw pr-merge の端末限定・保護の拒否・squash を観測する。
//   main・既存のブランチ・既存の PR・Ruleset・リポジトリ設定には書き込まない。後片付けは cleanup.mjs（記録されたものだけ）。
//
// 判定の規則: 記録の不正（欠け・型の誤り・解析できない行）は「記録不正」とし、一致にしない。想定と違う結果は「不一致」、
// 記録や観測が無いものは「未観測」と書く。成功扱いにしない。
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BRW_ROOT, SLUG, WORK_DIR, ghApi, ghJson, readState, requireRealEnv, run } from "./common.mjs";
import { cleanupCodexHome, prepareCodexHome } from "./stop-observe.mjs";
import { installCodexHooks } from "../../scripts/hook-install.mjs";
import { hookInput } from "../support/hook-fixtures.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const LOGGER = resolve(HERE, "hook-logger.mjs");
const PREPARE = resolve(HERE, "prepare.mjs");
const BRW_CLI = join(BRW_ROOT, "scripts/brw.mjs");
const AGENT_HOOKS = join(BRW_ROOT, "scripts/agent-hooks.mjs");
const EVENTS = join(WORK_DIR, "events");
const COUNTER = join(EVENTS, "calls.json");
const RUN_ROOT = join(WORK_DIR, "enforce-observe");
const HOSTS = ["claude", "codex"];
const CALLS_PER_HOST = 4;
// 上限は既存の基盤の決まり（host-events・stop-observe と共有の呼び出し回数）
const LIMITS = { claude: 12, codex: 14 };
const HOST_TIMEOUT_MS = 240000;
const PROMPT_WAIT_MS = 60000;
const MERGE_PROMPT = "マージしますか [y/N] ";
const DECLARATION = {
  workBranches: ["dev/*"],
  protectedBranches: ["main"],
  namePattern: "^dev/[a-z0-9]+(-[a-z0-9]+)*$",
  maxNameLength: 54,
  autoApprove: { push: true, pullRequest: true },
  preview: { provider: "none" },
};
const USAGE = "使い方: BRW_REAL_ENV=1 node tests/real-env/enforce-observe.mjs --stage hosts --host claude|codex [--dry-run]\n      BRW_REAL_ENV=1 node tests/real-env/enforce-observe.mjs --stage merge [--dry-run]";

// ---- 引数 ----

/** 引数を読む。未知の引数・段階・ホストは error を返す（終了コード 2 は呼び出し側で決める）。 */
export function parseArgs(argv) {
  const out = { stage: null, host: null, dryRun: false, help: false, error: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--stage") {
      const v = argv[++i];
      if (!["hosts", "merge"].includes(v)) return { ...out, error: `--stage は hosts・merge のいずれかです（指定: ${v ?? "なし"}）` };
      out.stage = v;
    } else if (a === "--host") {
      const v = argv[++i];
      if (!HOSTS.includes(v)) return { ...out, error: `--host は claude・codex のいずれかです（指定: ${v ?? "なし"}）` };
      out.host = v;
    } else return { ...out, error: `未知の引数です: ${a}` };
  }
  if (out.help) return out;
  if (out.stage === null) return { ...out, error: "--stage hosts または --stage merge を指定してください" };
  if (out.stage === "hosts" && out.host === null) return { ...out, error: "--stage hosts には --host claude または codex が必要です" };
  if (out.stage === "merge" && out.host !== null) return { ...out, error: "--host は --stage hosts でだけ使います" };
  return out;
}

// ---- 値の説明・記録の形式 ----

/**
 * 理由文に載せる値の説明。値を String() やテンプレート文字列で文字列化しない（toString が例外を投げる値があるため）。
 * null は "null"、配列は "array"、文字列・数値・真偽値は JSON.stringify を長さ 40 字までに切る、それ以外は typeof の名前。
 */
export function describeValue(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    try {
      const s = JSON.stringify(v);
      return s.length > 40 ? `${s.slice(0, 40)}…` : s;
    } catch {
      return "表示できない値";
    }
  }
  return typeof v;
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** 応答（stdout）を JSON のオブジェクトとして読む。空・解釈できない・オブジェクトでない場合は null。 */
const responseObjectOf = (rec) => {
  if (typeof rec?.stdout !== "string" || rec.stdout.trim() === "") return null;
  try {
    const v = JSON.parse(rec.stdout);
    return isPlainObject(v) ? v : null;
  } catch {
    return null;
  }
};

/**
 * フックの記録 1 行の形式を確かめる。正規の記録なら null、不正なら理由を返す。
 * 必須: 時刻 ts（日時の文字列）、host（想定のホスト。指定があれば一致も見る）、event（空でない文字列）、
 * input（オブジェクト）、stdout（文字列。空なら応答なし、空でなければ JSON のオブジェクト）、exit（整数）。
 */
export function invalidHookRecord(rec, host) {
  if (!isPlainObject(rec)) return "記録がオブジェクトではない";
  if (typeof rec.ts !== "string" || Number.isNaN(Date.parse(rec.ts))) return `時刻 ts が日時の文字列ではない（${describeValue(rec.ts)}）`;
  if (!HOSTS.includes(rec.host)) return `host が claude・codex のいずれでもない（${describeValue(rec.host)}）`;
  if (host !== undefined && rec.host !== host) return `host が想定と違う（${describeValue(rec.host)}）`;
  if (typeof rec.event !== "string" || rec.event === "") return `event が空でない文字列ではない（${describeValue(rec.event)}）`;
  if (!isPlainObject(rec.input)) return `入力 input がオブジェクトではない（${describeValue(rec.input)}）`;
  if (typeof rec.stdout !== "string") return `応答 stdout が文字列ではない（${describeValue(rec.stdout)}）`;
  if (rec.stdout.trim() !== "" && responseObjectOf(rec) === null) return "応答 stdout が JSON のオブジェクトとして解釈できない";
  if (!Number.isInteger(rec.exit)) return `終了コード exit が整数ではない（${describeValue(rec.exit)}）`;
  return null;
}

/**
 * フックの記録（JSON Lines）を読む。構文エラーの行と形式の不正な行は entries に入れず、件数（broken）として返す（空行は数えない）。
 */
export function parseHookLogDetailed(text, host) {
  const entries = [];
  let broken = 0;
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { broken += 1; continue; }
    if (invalidHookRecord(rec, host) !== null) { broken += 1; continue; }
    entries.push(rec);
  }
  return { entries, broken };
}

// ---- ホストの判定（H1・H2・H3・H3w） ----

// 根拠にするのは、git add と git commit が「同じ Bash 呼び出し（同じ command）」に && でつながっている記録だけ。
// 別々の呼び出しや単独の git commit は根拠にしない（分けて実行された commit を一致と誤認しないため）。
const ADD_AND_COMMIT = /\bgit\s+add\b[^]*?&&[^]*?\bgit\s+commit\b/;
const cmdOf = (e) => (typeof e.input.tool_input?.command === "string" ? e.input.tool_input.command : "");
const addAndCommitOf = (e) => ADD_AND_COMMIT.test(cmdOf(e));
// 応答の判定の根拠は、終了コードが 0 の記録だけ（非 0 は応答として扱わない）
const decisionOf = (e) => {
  if (e.exit !== 0) return null;
  const r = responseObjectOf(e);
  const h = r?.hookSpecificOutput;
  if (typeof h?.permissionDecision === "string") return h.permissionDecision;
  if (typeof h?.decision?.behavior === "string") return h.decision.behavior;
  return null;
};
const blockReasonOf = (e) => {
  if (e.exit !== 0) return null;
  const r = responseObjectOf(e);
  if (r?.decision !== "block") return null;
  return typeof r.reason === "string" ? r.reason : "";
};
// 応答なしとして通ったか: 終了コード 0 で、stdout が空（空白のみを含む）
const silentOf = (e) => e.exit === 0 && e.stdout.trim() === "";
const isReentry = (e) => e.input.stop_hook_active === true;

/** シナリオごとの確認項目。entries は検証済み。 */
function itemsOf(scenario, { host, entries, facts }) {
  const pre = entries.filter((e) => e.event === "PreToolUse" && addAndCommitOf(e));
  if (scenario.kind === "commit-allowed") {
    const perm = entries.filter((e) => e.event === "PermissionRequest" && addAndCommitOf(e));
    let hook;
    if (host === "claude") {
      if (pre.length === 0) hook = { name: "hook", state: "未観測", detail: "PreToolUse の記録が無い" };
      else {
        const ds = pre.map(decisionOf);
        hook = ds.every((d) => d === "allow")
          ? { name: "hook", state: "一致", detail: "PreToolUse が allow を返した" }
          : { name: "hook", state: "不一致", detail: `PreToolUse の応答が allow ではなかった（${ds.map((d) => d ?? "応答なし").join(",")}）` };
      }
    } else if (pre.some((e) => decisionOf(e) === "deny")) {
      hook = { name: "hook", state: "不一致", detail: "PreToolUse が deny を返した" };
    } else if (perm.length === 0) {
      hook = { name: "hook", state: "未観測", detail: "PermissionRequest 未観測（PreToolUse は応答なし）" };
    } else {
      const ds = perm.map(decisionOf);
      hook = ds.every((d) => d === "allow")
        ? { name: "hook", state: "一致", detail: "PermissionRequest が allow を返した" }
        : { name: "hook", state: "不一致", detail: `PermissionRequest の応答が allow ではなかった（${ds.map((d) => d ?? "応答なし").join(",")}）` };
    }
    let commit;
    if (facts.headChanged && facts.commitHasFile) commit = { name: "commit", state: "一致", detail: "commit が作られ、note.txt が含まれた" };
    else if (facts.headChanged) commit = { name: "commit", state: "不一致", detail: "commit は作られたが note.txt が含まれない" };
    else if (hook.state === "未観測") commit = { name: "commit", state: "未観測", detail: "commit は作られなかった（サンドボックス内で実行できたかは未確認）" };
    else commit = { name: "commit", state: "不一致", detail: "commit が作られなかった" };
    return [hook, commit];
  }
  if (scenario.kind === "protected-denied") {
    const denies = pre.filter((e) => decisionOf(e) === "deny");
    const allows = pre.filter((e) => decisionOf(e) === "allow");
    let deny;
    if (allows.length > 0) deny = { name: "deny", state: "不一致", detail: "保護ブランチの commit に allow が返った" };
    else if (denies.length > 0) deny = { name: "deny", state: "一致", detail: "保護ブランチの commit に deny が返った" };
    else deny = { name: "deny", state: "未観測", detail: "PreToolUse の deny が記録されていない" };
    const head = facts.headChanged
      ? { name: "head", state: "不一致", detail: "HEAD が変わった（commit が作られた）" }
      : { name: "head", state: "一致", detail: "HEAD は変わらなかった" };
    return [deny, head];
  }
  // stop-blocked: Stop の block と、再入（stop_hook_active:true）の通過
  const stops = entries.filter((e) => e.event === "Stop");
  const first = stops.find((e) => !isReentry(e));
  let block;
  if (!first) block = { name: "stop", state: "未観測", detail: "Stop の記録が無い" };
  else {
    const reason = blockReasonOf(first);
    if (reason === null) block = { name: "stop", state: "不一致", detail: "1 回目の Stop が block されなかった" };
    else if (!reason.includes("未コミット")) block = { name: "stop", state: "不一致", detail: "block の理由に未コミットの案内が無い" };
    else if (facts.expectPath && !reason.includes(facts.expectPath)) block = { name: "stop", state: "不一致", detail: `block の理由に ${facts.expectPath} が無い` };
    else block = { name: "stop", state: "一致", detail: `1 回目の Stop が block され、理由に未コミットと ${facts.expectPath ?? "対象"} を含んだ` };
  }
  const reentries = stops.filter(isReentry);
  let again;
  if (reentries.length === 0) again = { name: "reentry", state: "未観測", detail: "再入（stop_hook_active:true）の Stop が記録されていない" };
  else if (reentries.some((e) => blockReasonOf(e) !== null)) again = { name: "reentry", state: "不一致", detail: "再入（stop_hook_active:true）の Stop でまた block された" };
  else if (reentries.every(silentOf)) again = { name: "reentry", state: "一致", detail: "再入（stop_hook_active:true）の Stop は終了コード 0・応答なしで通った" };
  else again = { name: "reentry", state: "不一致", detail: "再入（stop_hook_active:true）の Stop の応答が空でない、または終了コードが 0 でない" };
  return [block, again];
}

const VERDICT_ORDER = ["記録不正", "不一致", "未観測", "一致"];

/**
 * 1 シナリオの判定。observed: { host, entries（未検証でもよい）, broken（解析できなかった行数）, exitCode, timedOut, facts }。
 * 記録の形式が不正な行が 1 件でもあれば「記録不正」。ホストが 0 以外・タイムアウトなら「未観測」（一致にしない）。
 */
export function judgeHostScenario(scenario, observed = {}) {
  const host = observed.host;
  const raw = Array.isArray(observed.entries) ? observed.entries : [];
  const invalid = raw.filter((r) => invalidHookRecord(r, host) !== null);
  const entries = raw.filter((r) => invalidHookRecord(r, host) === null);
  const broken = (Number.isInteger(observed.broken) ? observed.broken : 0) + invalid.length;
  const items = itemsOf(scenario, { host, entries, facts: observed.facts ?? {} });
  if (observed.timedOut) items.push({ name: "host", state: "未観測", detail: "ホストの実行がタイムアウトした" });
  else if (observed.exitCode !== 0) items.push({ name: "host", state: "未観測", detail: `ホストの終了コード ${describeValue(observed.exitCode)}` });
  else items.push({ name: "host", state: "一致", detail: "ホストは終了コード 0 で正常終了した" });
  let verdict;
  if (broken > 0) verdict = "記録不正";
  else if (items.some((i) => i.state === "不一致")) verdict = "不一致";
  else if (items.some((i) => i.state === "未観測")) verdict = "未観測";
  else verdict = "一致";
  return { id: scenario.id, verdict, items, broken };
}

// ---- 段階 merge の観測（M1〜M4） ----

const MERGE_IDS = ["M1", "M2", "M3n", "M3y", "M4a", "M4b"];
const isState = (v) => ["open", "merged", "closed"].includes(v);
const isCount = (v) => Number.isInteger(v) && v >= 0;
const isSha = (v) => v === null || (typeof v === "string" && /^[0-9a-f]{40}$/.test(v));
const isStr = (v) => typeof v === "string";
const isBool = (v) => typeof v === "boolean";
const isNullOrStr = (v) => v === null || isStr(v);
const isFullSha = (v) => typeof v === "string" && /^[0-9a-f]{40}$/.test(v);
// 疑似端末で出した観測の根拠（表示・プロンプト・送った入力）
const PTY_FACTS = { prNumber: isCount, title: isStr, headRef: isStr, baseRef: isStr, headSha: isFullSha, promptSeen: isBool, sentInput: isNullOrStr };
const FACT_RULES = {
  M1: { prStateAfter: isState, refsChanged: isCount },
  M2: { prStateAfter: isState, refsChanged: isCount, promptSeen: isBool, sentInput: isNullOrStr },
  M3n: { ...PTY_FACTS, prStateAfter: isState, refsChanged: isCount },
  M3y: { ...PTY_FACTS, prStateAfter: isState, mergeCommitSha: isSha, baseHeadSha: isSha, parentCount: (v) => v === null || isCount(v), headBranchExists: isBool },
  M4a: { decision: isStr },
  M4b: { decision: isStr },
};

/** 1 件の観測の形式を確かめる。正規なら null、不正なら理由を返す。 */
export function invalidMergeObservation(o) {
  if (!isPlainObject(o)) return "観測がオブジェクトではない";
  if (!MERGE_IDS.includes(o.id)) return `観測 ID が想定外（${describeValue(o.id)}）`;
  if (typeof o.at !== "string" || Number.isNaN(Date.parse(o.at))) return `at が日時の文字列ではない（${o.id}）`;
  if (typeof o.command !== "string" || o.command === "") return `command が空でない文字列ではない（${o.id}）`;
  if (!Number.isInteger(o.exitCode)) return `exitCode が整数ではない（${o.id}、${describeValue(o.exitCode)}）`;
  if (typeof o.output !== "string") return `output が文字列ではない（${o.id}）`;
  if (!isPlainObject(o.facts)) return `facts がオブジェクトではない（${o.id}）`;
  for (const [k, ok] of Object.entries(FACT_RULES[o.id])) {
    if (!ok(o.facts[k])) return `facts.${k} の形式が不正（${o.id}、${describeValue(o.facts[k])}）`;
  }
  return null;
}

/** 文字列の中に、部分文字列が指定の順序（重なりなし）で現れるか。 */
const inOrder = (s, parts) => {
  let at = -1;
  for (const p of parts) {
    const i = s.indexOf(p);
    if (i < 0 || i < at) return false;
    at = i;
  }
  return true;
};
/** brw pr-merge が確認の前に出す表示（scripts/pr-merge.mjs の文言）。facts の値と一致するかを見る。 */
const headerParts = (o) => [
  `PR #${o.facts.prNumber} をマージします。`,
  `タイトル: \`${o.facts.title}\``,
  `取り込み: \`${o.facts.headRef}\` → \`${o.facts.baseRef}\``,
  `head の SHA: ${o.facts.headSha.slice(0, 12)}`,
];

// 各観測の条件（満たさなければ不一致。どの条件が外れたかを書く）
const MERGE_CHECKS = {
  M1: (o) => [
    [o.exitCode === 1, "終了コード 1"],
    [o.output.includes("利用者が自分の端末"), "利用者が自分の端末で実行する案内"],
    [!o.output.includes(MERGE_PROMPT), "質問（マージしますか）が出ていない"],
    [o.facts.prStateAfter === "open", "PR は open のまま"],
    [o.facts.refsChanged === 0, "refs の書き込みなし"],
  ],
  M2: (o) => [
    [o.exitCode === 1, "終了コード 1"],
    [o.output.includes("保護ブランチ"), "保護ブランチの案内"],
    [o.output.includes("GitHub 上"), "GitHub 上でマージする案内"],
    [!o.output.includes(MERGE_PROMPT), "質問（マージしますか）が出ていない"],
    [o.facts.promptSeen === false && o.facts.sentInput === null, "入力を送っていない（質問の前に拒否）"],
    [o.facts.prStateAfter === "open", "PR は open のまま"],
    [o.facts.refsChanged === 0, "refs の書き込みなし"],
  ],
  M3n: (o) => [
    [o.exitCode === 1, "終了コード 1（中止）"],
    [inOrder(o.output, [...headerParts(o), MERGE_PROMPT, "中止しました。マージしていません。"]), "表示・プロンプト・中止の順に出ている"],
    [o.facts.promptSeen === true, "プロンプトが出ていた"],
    [o.facts.sentInput === "n", "送った入力が n"],
    [!o.output.includes("マージしました"), "マージの文言が無い"],
    [o.facts.prStateAfter === "open", "PR は open のまま"],
    [o.facts.refsChanged === 0, "refs の書き込みなし"],
  ],
  M3y: (o) => [
    [o.exitCode === 0, "終了コード 0"],
    [inOrder(o.output, [...headerParts(o), MERGE_PROMPT, "マージしました。"]), "表示・プロンプト・マージ完了の順に出ている"],
    [o.facts.promptSeen === true, "プロンプトが出ていた"],
    [o.facts.sentInput === "y", "送った入力が y"],
    [o.facts.prStateAfter === "merged", "PR が merged"],
    [o.facts.mergeCommitSha !== null && o.facts.mergeCommitSha === o.facts.baseHeadSha, "マージ commit が分岐元の先頭と一致"],
    [o.facts.parentCount === 1, "squash（親が 1 つ）"],
    [o.facts.headBranchExists === true, "head ブランチが残っている"],
  ],
  M4a: (o) => [
    [o.facts.decision === "deny", "agent-hooks が deny"],
    [o.exitCode === 0, "フックの終了コード 0"],
    [o.output.includes("brw pr-merge"), "案内に brw pr-merge"],
  ],
  M4b: (o) => [
    [o.facts.decision === "deny", "agent-hooks が deny"],
    [o.exitCode === 0, "フックの終了コード 0"],
  ],
};

/**
 * GitHub・端末の観測（M1〜M4）から判定する。entries は未検証でもよい（形式の不正は記録不正）。
 * 必須の 6 件（M1・M2・M3n・M3y・M4a・M4b）がそろい、すべて条件を満たしたときだけ「一致」。
 */
export function judgeMergeObservations(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const reasons = [];
  const seen = new Set();
  for (const o of list) {
    const why = invalidMergeObservation(o);
    if (why !== null) { reasons.push(why); continue; }
    if (seen.has(o.id)) reasons.push(`観測 ${o.id} が 2 件ある`);
    seen.add(o.id);
  }
  const items = MERGE_IDS.map((id) => {
    const o = list.find((x) => isPlainObject(x) && x.id === id && invalidMergeObservation(x) === null);
    if (!o) return { id, state: "未観測", detail: "観測の記録が無い" };
    const failed = MERGE_CHECKS[id](o).filter(([ok]) => !ok).map(([, label]) => label);
    return failed.length === 0
      ? { id, state: "一致", detail: "すべての条件を満たした" }
      : { id, state: "不一致", detail: `満たさなかった条件: ${failed.join("、")}` };
  });
  let verdict;
  if (reasons.length > 0) verdict = "記録不正";
  else if (items.some((i) => i.state === "不一致")) verdict = "不一致";
  else if (items.some((i) => i.state === "未観測")) verdict = "未観測";
  else verdict = "一致";
  return { verdict, items, reasons };
}

// ---- 計画・整形 ----

const SCENARIOS = [
  { id: "H1", kind: "commit-allowed", title: "開発ブランチの git commit は確認省略（allow）で実行される", ws: "dev", expect: "Claude: PreToolUse が allow、commit が作られる。Codex: PermissionRequest が allow（届かなければ未観測と記録）" },
  { id: "H2", kind: "protected-denied", title: "保護ブランチ main の git commit は拒否（deny）され、HEAD は変わらない", ws: "main", expect: "PreToolUse が deny、HEAD 不変" },
  { id: "H3", kind: "stop-blocked", title: "未コミットのまま終わる依頼は Stop で block され、再入は通る", ws: "dev-stop", expect: "1 回目の Stop が block（理由に未コミットと new.txt）、再入（stop_hook_active:true）は応答なし" },
  { id: "H3w", kind: "stop-blocked", title: "worktree に残した未コミットも Stop で block される", ws: "worktree", expect: "本体の作業ディレクトリでも、別の worktree の new.txt で block" },
];
const MERGE_OBSERVATIONS = [
  { id: "M1", title: "非端末の brw pr-merge は拒否され、PR は open のまま、書き込みなし", expect: "終了コード 1、利用者の端末の案内、refs 不変" },
  { id: "M2", title: "保護扱いの取り込み先への pr-merge は質問前に拒否", expect: "終了コード 1、GitHub 上でのマージの案内、PR は open" },
  { id: "M3n", title: "分岐元向けの pr-merge で n を答えると中止", expect: "終了コード 1、PR は open" },
  { id: "M3y", title: "分岐元向けの pr-merge で y を答えると squash でマージ", expect: "終了コード 0、PR は merged、マージ commit が分岐元の先頭、親は 1 つ、head は残る" },
  { id: "M4a", title: "エージェントの Bash での brw pr-merge は PreToolUse で deny", expect: "deny、案内に brw pr-merge" },
  { id: "M4b", title: "エージェントの gh pr merge は PreToolUse で deny", expect: "deny" },
];

/** ホストの計画（呼び出しはしない）。1 ホストあたり最大 4 回。 */
export function planHosts(host) {
  return { host, bin: host === "claude" ? "claude" : "codex", calls: SCENARIOS.length, scenarios: SCENARIOS.map(({ id, title, kind, expect }) => ({ id, title, kind, expect })) };
}

/** merge の計画（GitHub を呼ばない）。ブランチ名は検証用の形。 */
export function planMerge(epoch = Math.floor(Date.now() / 1000)) {
  return {
    branches: [`verify/brw-base-${epoch}`, `verify/brw-prot-${epoch}`, `dev/verify-merge-${epoch}`],
    observations: MERGE_OBSERVATIONS,
  };
}

/** 呼び出し 1 回の指示文（シナリオごと）。 */
export function promptFor(id, { worktree } = {}) {
  if (id === "H1" || id === "H2") return '次の Bash コマンドを 1 つの Bash 呼び出しとして、そのまま実行してください（分割しないでください）。\n`git add note.txt && git commit -m "記録"`\n他のことはせず、結果を一言だけ答えて終了してください。';
  if (id === "H3") return "new.txt を作ってください（`echo hi > new.txt` を使う）。commit はしないでください。終わったら、結果を一言だけ答えて終了してください。";
  return `worktree ${worktree} に new.txt を作ってください（\`echo hi > ${worktree}/new.txt\` を使う）。commit はしないでください。終わったら、結果を一言だけ答えて終了してください。`;
}

/** ホストの呼び出し（コマンド名と引数）。Claude は project の設定だけ、Codex は一時の CODEX_HOME とフックの信頼の省略を使う。 */
export function hostCommand(host, { cwd, prompt } = {}) {
  if (host === "claude") {
    return {
      bin: "claude",
      args: ["-p", prompt, "--model", "haiku", "--max-turns", "8", "--setting-sources", "project", "--output-format", "stream-json", "--verbose", "--include-hook-events", "--allowedTools", "Bash", "--no-session-persistence"],
    };
  }
  return {
    bin: "codex",
    args: ["exec", "--json", "--skip-git-repo-check", "-C", cwd, "-s", "workspace-write", "-c", 'model_reasoning_effort="low"', "--dangerously-bypass-hook-trust", prompt],
  };
}

const WORST = (verdicts) => VERDICT_ORDER.find((v) => verdicts.includes(v)) ?? "未観測";
const itemText = (items) => items.map((i) => `${i.name}: ${i.state}（${i.detail}）`).join("; ");

/** ホストの報告（Markdown）。results は judgeHostScenario の戻り値の配列。 */
export function formatHostReport({ host, version, at, results, calls, exitCode }) {
  const titles = Object.fromEntries(SCENARIOS.map((s) => [s.id, s.title]));
  const verdict = WORST(results.map((r) => r.verdict));
  return [
    `### 19.2 追加した規則の実環境の確認: ${host}（${version ?? "版不明"}・${at}）`,
    "",
    `呼び出し: ${calls ?? results.length} 回、終了コード（最後の呼び出し）: ${exitCode ?? "なし"}`,
    "",
    "| シナリオ | 判定 | 観測の内容 |",
    "|---|---|---|",
    ...results.map((r) => `| ${r.id} ${titles[r.id] ?? ""} | ${r.verdict} | ${itemText(r.items)} |`),
    "",
    `総合: ${verdict}`,
  ].join("\n");
}

/** merge の報告（Markdown）。judged は judgeMergeObservations の戻り値。 */
export function formatMergeReport({ at, judged, version }) {
  const titles = Object.fromEntries(MERGE_OBSERVATIONS.map((o) => [o.id, o.title]));
  return [
    `### 19.2 追加した規則の実環境の確認: merge（${version ?? "gh・brw"}・${at}）`,
    "",
    "| 観測 | 判定 | 観測の内容 |",
    "|---|---|---|",
    ...judged.items.map((i) => `| ${i.id} ${titles[i.id] ?? ""} | ${i.state} | ${i.detail} |`),
    "",
    `総合: ${judged.verdict}`,
  ].join("\n");
}

// ---- 実行（ここから下は実環境でだけ動く） ----

/** 共有の呼び出し回数を 1 つ数える。上限に達していれば false。 */
function takeCall(host) {
  const c = existsSync(COUNTER) ? JSON.parse(readFileSync(COUNTER, "utf8")) : { claude: 0, codex: 0 };
  if ((c[host] ?? 0) >= LIMITS[host]) return false;
  c[host] = (c[host] ?? 0) + 1;
  mkdirSync(EVENTS, { recursive: true });
  writeFileSync(COUNTER, JSON.stringify(c));
  return true;
}

const readCounter = () => (existsSync(COUNTER) ? JSON.parse(readFileSync(COUNTER, "utf8")) : { claude: 0, codex: 0 });
const versionOf = (host) => {
  const r = spawnSync(host, ["--version"], { encoding: "utf8", timeout: 30000 });
  if (r.error || r.status !== 0) return "版不明";
  return (r.stdout ?? "").trim().split("\n")[0] || "版不明";
};
const lines = (f) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter((l) => l.trim() !== "") : []);

/** 作業場所（hosts）。偽の gh・試験用 ssh・bare リポジトリ・シナリオ用の clone を作る。 */
function setupHostRun(runDir, host) {
  const fakebin = join(runDir, "fakebin");
  const bare = join(runDir, "bare.git");
  const sshLog = join(runDir, "fake-ssh.log");
  const logDir = join(runDir, "hook-log");
  const origin = `git@github.com:${SLUG}.git`;
  mkdirSync(fakebin, { recursive: true });
  writeFileSync(join(fakebin, "gh"), `#!/bin/sh\necho "$(date -u +%FT%TZ) gh $*" >> ${JSON.stringify(join(runDir, "fake-gh.log"))}\necho "fake gh: 実際の gh は呼ばれていません" >&2\nexit 9\n`);
  writeFileSync(join(fakebin, "fakessh"), `#!/bin/sh\n# 試験用 ssh: GitHub ではなくローカルの bare リポジトリへ接続する（実 GitHub には届かない）\necho "$(date -u +%FT%TZ) fakessh $*" >> ${JSON.stringify(sshLog)}\nfor last; do :; done\ncase "$last" in\n  git-receive-pack*) exec git-receive-pack ${JSON.stringify(bare)} ;;\n  git-upload-pack*) exec git-upload-pack ${JSON.stringify(bare)} ;;\nesac\nexit 1\n`);
  chmodSync(join(fakebin, "gh"), 0o755);
  chmodSync(join(fakebin, "fakessh"), 0o755);
  const env = { ...process.env, GIT_SSH_COMMAND: join(fakebin, "fakessh"), GIT_TERMINAL_PROMPT: "0" };
  const git = (cwd, ...a) => {
    const r = spawnSync("git", ["-c", "user.name=brw-verify", "-c", "user.email=brw-verify@example.invalid", "-c", "commit.gpgsign=false", ...a], { cwd, encoding: "utf8", env });
    if (r.status !== 0) throw new Error(`git ${a.join(" ")}（${cwd}）: ${(r.stderr ?? "").trim()}`);
    return (r.stdout ?? "").trim();
  };
  if (!existsSync(bare)) git(runDir, "init", "-q", "--bare", "-b", "main", bare);
  // 種のリポジトリ: 宣言を main に置き、このホストの開発ブランチを 1 つ作る
  const seed = join(runDir, "seed");
  mkdirSync(seed, { recursive: true });
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, ".branch-release-workflow.json"), `${JSON.stringify(DECLARATION, null, 2)}\n`);
  writeFileSync(join(seed, "README.txt"), "19.2 の実環境の確認\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "init");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-q", "origin", "main");
  git(seed, "checkout", "-q", "-b", `dev/verify-${host}`);
  writeFileSync(join(seed, "change.txt"), `${host}\n`);
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "dev change");
  git(seed, "push", "-q", "origin", `dev/verify-${host}`);
  const clone = (name, branch) => {
    const dir = join(runDir, name);
    git(runDir, "clone", "-q", bare, dir);
    git(dir, "remote", "set-url", "origin", origin);
    git(dir, "config", "core.sshCommand", join(fakebin, "fakessh"));
    if (branch) git(dir, "checkout", "-q", branch);
    appendFileSync(join(dir, ".git", "info", "exclude"), ".claude/\n.codex/\n");
    return dir;
  };
  const ws = {
    main: clone("ws-main", null),
    dev: clone("ws-dev", `dev/verify-${host}`),
    "dev-stop": clone("ws-dev-stop", `dev/verify-${host}`),
  };
  // H3w: 本体（main）に worktree を作り、その中に dev ブランチを置く
  const wt = join(ws.main, ".claude", "worktrees", "wt");
  mkdirSync(join(ws.main, ".claude", "worktrees"), { recursive: true });
  git(ws.main, "worktree", "add", "-q", "-b", `dev/verify-${host}-wt`, wt, `origin/dev/verify-${host}`);
  // H1・H2 は未追跡の note.txt を置く（commit の対象）
  writeFileSync(join(ws.dev, "note.txt"), "記録用\n");
  writeFileSync(join(ws.main, "note.txt"), "記録用\n");
  // フックの登録（Claude は project の設定、Codex は installCodexHooks）
  for (const dir of [ws.main, ws.dev, ws["dev-stop"]]) {
    if (host === "claude") {
      mkdirSync(join(dir, ".claude"), { recursive: true });
      const h = (ev) => [{ type: "command", command: `node "${LOGGER}" claude ${ev}` }];
      const settings = { hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: h("PreToolUse") }, { matcher: "mcp__.*", hooks: h("PreToolUse") }],
        PostToolUse: [{ matcher: "Bash", hooks: h("PostToolUse") }],
        Stop: [{ hooks: h("Stop") }],
      } };
      writeFileSync(join(dir, ".claude", "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
    } else {
      const r = installCodexHooks({ repoDir: dir, launcherPath: LOGGER });
      if (!["registered", "untrusted"].includes(r.status)) throw new Error(`Codex フックの登録に失敗: ${r.status} ${r.reasonCode}`);
    }
  }
  return {
    fakebin, logDir, env, wt,
    dirOf: { H1: ws.dev, H2: ws.main, H3: ws["dev-stop"], H3w: ws.main },
    headOf: (dir) => git(dir, "rev-parse", "HEAD"),
    commitFiles: (dir, sha) => git(dir, "show", "--name-only", "--format=", sha).split("\n").filter(Boolean),
  };
}

/** 1 ホストの観測（hosts 段階）。 */
function stageHosts(host) {
  const at = new Date().toISOString();
  const runDir = join(RUN_ROOT, `hosts-${host}-${Date.now()}`);
  mkdirSync(runDir, { recursive: true });
  const fx = setupHostRun(runDir, host);
  const logFile = join(fx.logDir, `${host}.jsonl`);
  const results = [];
  let lastExit = null;
  for (const sc of SCENARIOS) {
    if (!takeCall(host)) {
      results.push({ id: sc.id, verdict: "未観測", items: [{ name: "call", state: "未観測", detail: `${host} の呼び出し回数が上限（${LIMITS[host]}）に達したため、呼び出していない` }], broken: 0 });
      continue;
    }
    const cwd = fx.dirOf[sc.id];
    const before = lines(logFile).length;
    const headBefore = fx.headOf(cwd);
    const base = join(runDir, `call-${sc.id}`);
    mkdirSync(base, { recursive: true });
    let env = { ...process.env, PATH: `${fx.fakebin}:${process.env.PATH}`, GIT_SSH_COMMAND: join(fx.fakebin, "fakessh"), BRW_REAL_ENV: "1", BRW_HOOK_LOG_DIR: fx.logDir };
    const prompt = promptFor(sc.id, { worktree: fx.wt });
    const { bin, args } = hostCommand(host, { cwd, prompt });
    if (host === "codex") env = { ...env, CODEX_HOME: prepareCodexHome(base, cwd).home };
    let r;
    try {
      r = spawnSync(bin, args, { cwd, env, input: "", encoding: "utf8", timeout: HOST_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
    } finally {
      if (host === "codex") cleanupCodexHome(env.CODEX_HOME);
    }
    writeFileSync(join(base, "host.out"), r.stdout ?? "");
    writeFileSync(join(base, "host.err"), r.stderr ?? "");
    lastExit = r.status ?? -1;
    const text = lines(logFile).slice(before).join("\n");
    const parsed = parseHookLogDetailed(text, host);
    const headAfter = fx.headOf(cwd);
    const facts = { headChanged: headAfter !== headBefore, commitHasFile: headAfter !== headBefore && fx.commitFiles(cwd, headAfter).includes("note.txt"), expectPath: sc.kind === "stop-blocked" ? "new.txt" : undefined };
    const judged = judgeHostScenario(sc, { host, entries: parsed.entries, broken: parsed.broken, exitCode: r.status ?? -1, timedOut: r.error?.code === "ETIMEDOUT", facts });
    results.push(judged);
  }
  const verdicts = results.map((r) => r.verdict);
  const report = formatHostReport({ host, version: versionOf(host), at, results, calls: results.length, exitCode: lastExit });
  return { report, ok: verdicts.every((v) => v === "一致"), runDir };
}

/** merge 段階で使う、GitHub の ref の commit（無ければ null）。 */
const refSha = (name) => {
  const r = ghApi([`repos/${SLUG}/git/ref/heads/${name}`, "--jq", ".object.sha"]);
  return r.code === 0 && r.out.trim() ? r.out.trim() : null;
};
const prFacts = (n) => {
  const p = ghJson(`repos/${SLUG}/pulls/${n}`);
  if (!p.ok) return "unknown";
  return p.data.merged ? "merged" : p.data.state;
};
const changedRefs = (before, names) => names.filter((b) => refSha(b) !== before[b]).length;
const snapshotRefs = (names) => Object.fromEntries(names.map((b) => [b, refSha(b)]));

/** 疑似端末（script）で brw pr-merge を実行する。プロンプトが出たら answer を送る。60 秒で打ち切る。 */
function ptyRun(cmd, { cwd, env, answer }) {
  return new Promise((done) => {
    const p = spawn("script", ["-qec", cmd, "/dev/null"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let sent = false;
    const kill = setTimeout(() => p.kill("SIGKILL"), PROMPT_WAIT_MS);
    const onData = (d) => {
      out += d;
      if (answer !== undefined && !sent && out.includes(MERGE_PROMPT)) {
        sent = true;
        p.stdin.write(`${answer}\n`);
      }
    };
    p.stdout.on("data", onData);
    p.stderr.on("data", onData);
    p.on("close", (code) => {
      clearTimeout(kill);
      // sent: 実際に答えを送ったか（プロンプトが出なければ送らない）
      done({ code: code ?? -1, output: out.slice(0, 4000), promptSeen: out.includes(MERGE_PROMPT), sentInput: sent ? answer : null });
    });
  });
}

/** 1 件の観測を記録ファイルへ追記する。 */
const recordObs = (file, o) => appendFileSync(file, `${JSON.stringify(o)}\n`);

/** merge 段階（実 GitHub）。使い捨てブランチ 3 本と PR 2 件だけに書き込む。 */
async function stageMerge() {
  const st = readState();
  if (!st) throw new Error("先に tests/real-env/prepare.mjs を実行してください（状態ファイルが必要です）");
  const epoch = Math.floor(Date.now() / 1000);
  const plan = planMerge(epoch);
  const [base, prot, head] = plan.branches;
  const at = new Date().toISOString();
  const dir = join(RUN_ROOT, `merge-${epoch}`);
  mkdirSync(dir, { recursive: true });
  const obsFile = join(dir, "observations.jsonl");
  const record = (kind, value) => {
    const r = run(process.execPath, [PREPARE, "--record", `${kind}=${value}`]);
    if (r.code !== 0) throw new Error(`状態の記録に失敗しました（${kind}）: ${r.err.trim()}`);
  };
  // ① 使い捨てブランチ（main の現在の commit から。head は分岐元の上に 1 commit）
  const mainSha = refSha("main");
  if (!mainSha) throw new Error("main の commit を読めません");
  for (const b of [base, prot]) {
    const c = ghApi(["-X", "POST", `repos/${SLUG}/git/refs`, "-f", `ref=refs/heads/${b}`, "-f", `sha=${mainSha}`]);
    if (c.code !== 0) throw new Error(`ブランチ ${b} を作れません: ${c.err.trim().split("\n")[0]}`);
    record("branch", b);
  }
  const baseSha = refSha(base);
  const h = ghApi(["-X", "POST", `repos/${SLUG}/git/refs`, "-f", `ref=refs/heads/${head}`, "-f", `sha=${baseSha}`]);
  if (h.code !== 0) throw new Error(`ブランチ ${head} を作れません: ${h.err.trim().split("\n")[0]}`);
  record("branch", head);
  const content = Buffer.from(`19.2 の実環境の確認（merge）\n${epoch}\n`).toString("base64");
  const put = ghApi(["-X", "PUT", `repos/${SLUG}/contents/verify/brw-merge-${epoch}.txt`, "-f", `message=19.2 の検証用 commit\n\nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`, "-f", `content=${content}`, "-f", `branch=${head}`]);
  if (put.code !== 0) throw new Error(`head に commit を作れません: ${put.err.trim().split("\n")[0]}`);
  // ② PR 2 件（PR-1: head → 分岐元、PR-2: head → 保護扱い）
  const body = "19.2 の実環境の確認用（自動作成）。確認の後に閉じます。\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)";
  const pr = (b) => {
    const r = ghJson(`repos/${SLUG}/pulls`, ["-X", "POST", "-f", `title=19.2 の検証 (${epoch})`, "-f", `head=${head}`, "-f", `base=${b}`, "-f", `body=${body}`]);
    if (!r.ok) throw new Error(`PR を作れません（base=${b}）: ${r.err}`);
    record("pr", r.data.number);
    return r.data.number;
  };
  const pr1 = pr(base);
  const pr2 = pr(prot);
  // ③ 一時クローン（origin は実際の GitHub。宣言は未 commit・未追跡のまま置く）
  const clone = join(dir, "clone");
  const cl = run("git", ["clone", "--quiet", "--branch", head, `https://github.com/${SLUG}.git`, clone], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (cl.code !== 0) throw new Error(`クローンに失敗しました: ${cl.err.trim().split("\n")[0]}`);
  writeFileSync(join(clone, ".branch-release-workflow.json"), `${JSON.stringify({ ...DECLARATION, protectedBranches: ["main", prot], baseBranch: base, baseBranches: [base] }, null, 2)}\n`);
  const names = [base, prot, head];
  const cmdOf = (n) => `node "${BRW_CLI}" pr-merge ${n}`;

  // ④ 観測
  // M1: 非端末（子プロセス）。GH_TOKEN を無効な値にし、通信していないことを確かめる
  const b1 = snapshotRefs(names);
  const r1 = spawnSync(process.execPath, [BRW_CLI, "pr-merge", String(pr1)], { cwd: clone, env: { ...process.env, GH_TOKEN: "invalid-for-observation" }, input: "", encoding: "utf8", timeout: HOST_TIMEOUT_MS });
  const o1 = { id: "M1", at: new Date().toISOString(), command: `${cmdOf(pr1)}（非端末）`, exitCode: r1.status ?? -1, output: `${r1.stdout ?? ""}${r1.stderr ?? ""}`.slice(0, 4000), facts: { prStateAfter: prFacts(pr1), refsChanged: changedRefs(b1, names) } };
  recordObs(obsFile, o1);
  // M2: 保護扱いの取り込み先。疑似端末、入力は用意しない（質問される前に拒否される）
  const b2 = snapshotRefs(names);
  const r2 = await ptyRun(cmdOf(pr2), { cwd: clone, env: process.env });
  recordObs(obsFile, { id: "M2", at: new Date().toISOString(), command: `${cmdOf(pr2)}（疑似端末・入力なし）`, exitCode: r2.code, output: r2.output, facts: { prStateAfter: prFacts(pr2), refsChanged: changedRefs(b2, names), promptSeen: r2.promptSeen, sentInput: r2.sentInput } });
  // 表示の根拠（M3n・M3y の判定で使う）。head の SHA は実行の前に読む
  const headSha = refSha(head) ?? "";
  const pty = (n) => ({ prNumber: n, title: `19.2 の検証 (${epoch})`, headRef: head, baseRef: base, headSha });
  // M3n: 分岐元向け。n で中止
  const b3 = snapshotRefs(names);
  const r3 = await ptyRun(cmdOf(pr1), { cwd: clone, env: process.env, answer: "n" });
  recordObs(obsFile, { id: "M3n", at: new Date().toISOString(), command: `${cmdOf(pr1)}（疑似端末・n）`, exitCode: r3.code, output: r3.output, facts: { ...pty(pr1), promptSeen: r3.promptSeen, sentInput: r3.sentInput, prStateAfter: prFacts(pr1), refsChanged: changedRefs(b3, names) } });
  // M3y: y で squash マージ
  const r4 = await ptyRun(cmdOf(pr1), { cwd: clone, env: process.env, answer: "y" });
  const after = ghJson(`repos/${SLUG}/pulls/${pr1}`);
  const mergeSha = after.ok ? after.data.merge_commit_sha ?? null : null;
  const baseNow = refSha(base);
  const commit = mergeSha ? ghJson(`repos/${SLUG}/commits/${mergeSha}`) : { ok: false };
  recordObs(obsFile, { id: "M3y", at: new Date().toISOString(), command: `${cmdOf(pr1)}（疑似端末・y）`, exitCode: r4.code, output: r4.output, facts: {
    ...pty(pr1), promptSeen: r4.promptSeen, sentInput: r4.sentInput,
    prStateAfter: prFacts(pr1), mergeCommitSha: mergeSha, baseHeadSha: baseNow, parentCount: commit.ok ? commit.data.parents.length : null, headBranchExists: refSha(head) !== null,
  } });
  // M4a・M4b: エージェントのフック経路（PreToolUse に実際の入力の形を渡す）
  const hookDecision = (command) => {
    const r = spawnSync(process.execPath, [AGENT_HOOKS, "claude", "PreToolUse"], { input: JSON.stringify(hookInput("claude", "PreToolUse", { cwd: clone, command })), encoding: "utf8", env: process.env, timeout: 60000 });
    let decision = "none";
    try { decision = JSON.parse(r.stdout ?? "")?.hookSpecificOutput?.permissionDecision ?? "none"; } catch { /* 応答なし */ }
    return { exitCode: r.status ?? -1, output: r.stdout ?? "", decision };
  };
  const h4a = hookDecision(cmdOf(pr2));
  recordObs(obsFile, { id: "M4a", at: new Date().toISOString(), command: `PreToolUse: ${cmdOf(pr2)}`, exitCode: h4a.exitCode, output: h4a.output, facts: { decision: h4a.decision } });
  const h4b = hookDecision(`gh pr merge ${pr2} --squash`);
  recordObs(obsFile, { id: "M4b", at: new Date().toISOString(), command: `PreToolUse: gh pr merge ${pr2}`, exitCode: h4b.exitCode, output: h4b.output, facts: { decision: h4b.decision } });

  const entries = lines(obsFile).map((l) => JSON.parse(l));
  const judged = judgeMergeObservations(entries);
  const report = formatMergeReport({ at, judged });
  return { report, ok: judged.verdict === "一致", dir, pr1, pr2 };
}

function main() {
  requireRealEnv("enforce-observe.mjs");
  const args = parseArgs(process.argv.slice(2));
  if (args.error) { console.error(args.error); console.error(USAGE); process.exit(2); }
  if (args.help) { console.log(USAGE); process.exit(0); }
  if (args.dryRun) {
    if (args.stage === "hosts") {
      const p = planHosts(args.host);
      console.log(`== 19.2 追加した規則の実環境の確認の計画: ${args.host}（ホストは呼びません） ==`);
      console.log(`呼び出し: ${p.calls} 回（${p.bin}）。上限 ${LIMITS[args.host]} 回（共有カウンタ）`);
      for (const s of p.scenarios) console.log(`  - ${s.id} ${s.title}: 想定 ${s.expect}`);
    } else {
      const p = planMerge();
      console.log("== 19.2 追加した規則の実環境の確認の計画（GitHub へ書き込みません） ==");
      console.log("作る使い捨てブランチ（名前の形）:");
      for (const b of p.branches) console.log(`  - ${b}`);
      console.log("作る PR: 2 件（head → 分岐元、head → 保護扱い）。書き込むのは使い捨てのものだけ。");
      for (const o of p.observations) console.log(`  - ${o.id} ${o.title}: 想定 ${o.expect}`);
    }
    process.exit(0);
  }
  if (args.stage === "hosts") {
    const r = stageHosts(args.host);
    console.log(`\n${r.report}`);
    console.log(`\n生の出力: ${r.runDir}`);
    const c = readCounter();
    console.log(`呼び出し回数: claude ${c.claude ?? 0}/${LIMITS.claude}、codex ${c.codex ?? 0}/${LIMITS.codex}`);
    process.exit(r.ok ? 0 : 1);
  }
  stageMerge().then((r) => {
    console.log(`\n${r.report}`);
    console.log(`\n生の出力: ${r.dir}（PR: #${r.pr1}, #${r.pr2}。後片付けは tests/real-env/cleanup.mjs）`);
    process.exit(r.ok ? 0 : 1);
  }, (e) => {
    console.error(`merge 段階を中止しました: ${e.message}`);
    process.exit(1);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
