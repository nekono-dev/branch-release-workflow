#!/usr/bin/env node
// 5.2・8.2: 分岐元からの PR（brw-pr-handoff）を、実 GitHub と実機の Claude Code で観測する。
// 使い方:
//   BRW_REAL_ENV=1 node tests/real-env/base-pr-observe.mjs --stage api [--dry-run]
//   BRW_REAL_ENV=1 node tests/real-env/base-pr-observe.mjs --stage host [--dry-run]
//
// 段階 api（5.2・GitHub の API）: 使い捨てブランチ 3 本（分岐元役・保護役・差なしの確認用）と、作れた PR だけに書き込む。
//   A1: head を分岐元役、base を保護役とする PR が API で 201 で作れる（読み戻しで base・head・open を確かめる）。
//   A2: 差が無い（同じ commit）組では PR を作れない（422・No commits between）。
// 段階 host（8.2・実機の Claude Code）: 実 GitHub のクローンで、分岐元のチェックアウトから brw pr を実行する。
//   分岐元役のブランチに宣言を contents API で commit する（登録済みにして確認省略を効かせる）。main には書かない。
//   順序: B3（承認が必要な宣言・PR が無い段階で確かめる）→ B3c（--confirmed を非端末で付けた拒否）→ B1（claude -p・Haiku が
//   pr-template と pr を実行）→ B2（同じ brw pr の再実行で PR が再利用される）。PR を作るのは B1 の 1 件だけ。
//   既存 PR の再利用は作成の判定より前に行われるため、B3 は B1 より前に行う必要がある。
//
// 書き込みは使い捨てブランチと PR だけ（main・既存のブランチ・既存の PR・Ruleset・設定には書かない）。
// 後片付けは tests/real-env/cleanup.mjs（記録されたものだけ削除）。
// 判定の規則: 記録の不正（欠け・型の誤り・解析できない行・想定外の ID・重複）は「記録不正」とし、一致にしない。
// 読み取りの失敗（null）・ホストの終了コード非 0・タイムアウトは「未観測」。書式・状態の想定との違いは「不一致」。
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BRW_ROOT, OWNER, SLUG, WORK_DIR, ghApi, ghJson, readState, requireRealEnv, run } from "./common.mjs";
import { bodyPathOf } from "../../scripts/pr-template.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PREPARE = resolve(HERE, "prepare.mjs");
const LOGGER = resolve(HERE, "hook-logger.mjs");
const BRW_CLI = join(BRW_ROOT, "scripts/brw.mjs");
const RUN_ROOT = join(WORK_DIR, "base-pr-observe");
const EVENTS = join(WORK_DIR, "events");
const COUNTER = join(EVENTS, "calls.json");
// 実 Claude の呼び出しの上限（共有カウンタ。host-events・enforce-observe と同じ events/calls.json）
const CLAUDE_LIMIT = 3;
const HOST_TIMEOUT_MS = 300000;
const BRW_TIMEOUT_MS = 180000;
const STAGES = ["api", "host"];
const PR_TITLE = "分岐元からの PR の確認";
const PR_BODY = "brw-pr-handoff の実環境の確認（自動作成）。確認の後に閉じます。\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)";
const CO_AUTHOR = "Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>";
const API_IDS = ["A1", "A2"];
const HOST_IDS = ["B1", "B2", "B3", "B3c"];
const TRIM = 4000;

const USAGE = [
  "使い方:",
  "  BRW_REAL_ENV=1 node tests/real-env/base-pr-observe.mjs --stage api [--dry-run]",
  "  BRW_REAL_ENV=1 node tests/real-env/base-pr-observe.mjs --stage host [--dry-run]",
].join("\n");

// ---- 引数 ----

/** 引数を読む。--stage は api・host のどちらか。 */
export function parseArgs(argv) {
  const out = { stage: null, dryRun: false, help: false, error: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--stage") {
      const v = argv[++i];
      if (!STAGES.includes(v)) return { ...out, error: `--stage は api・host のいずれかです（指定: ${v ?? "なし"}）` };
      out.stage = v;
    } else return { ...out, error: `未知の引数です: ${a}` };
  }
  if (out.help) return out;
  if (out.stage === null) return { ...out, error: "--stage api または --stage host を指定してください" };
  return out;
}

// ---- 値の検証（記録の形式） ----

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isInt = (v) => Number.isInteger(v);
const isStr = (v) => typeof v === "string" && v !== "";
const isBool = (v) => typeof v === "boolean";
const isSha = (v) => typeof v === "string" && /^[0-9a-f]{40}$/.test(v);
const nullable = (f) => (v) => v === null || f(v);
const describe = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "string" ? JSON.stringify(v).slice(0, 40) : typeof v);
const isPrItem = (p) => isPlainObject(p) && isInt(p.number) && p.number >= 1 && isStr(p.state) && isStr(p.baseRef) && isStr(p.headRef);
const isPrList = (v) => Array.isArray(v) && v.every(isPrItem);

const API_RULES = {
  A1: {
    status: nullable(isInt), requestedHead: isStr, requestedBase: isStr,
    prNumber: nullable((v) => isInt(v) && v >= 1), prBaseRef: nullable(isStr), prHeadRef: nullable(isStr), prState: nullable(isStr),
  },
  A2: { status: nullable(isInt), message: nullable(isStr), prCreated: isBool },
};
const HOOK_RUNS_OK = (v) => isPlainObject(v) && nullable(isBool)(v.prTemplate) && nullable(isBool)(v.pr) && nullable(isBool)(v.directGhPrCreate) && isInt(v.invalidLines) && v.invalidLines >= 0;
const HOST_RULES_COMMON = {
  openPrs: nullable(isPrList), refBefore: nullable(isSha), refAfter: nullable(isSha),
  cloneHeadBefore: nullable(isSha), cloneHeadAfter: nullable(isSha), cloneBranch: nullable(isStr), brwDirExists: nullable(isBool),
  requestedHead: isStr, requestedBase: isStr, hostExitCode: nullable(isInt), timedOut: isBool,
};
const HOST_RULES = {
  B1: { ...HOST_RULES_COMMON, hookRuns: HOOK_RUNS_OK },
  B2: HOST_RULES_COMMON,
  B3: HOST_RULES_COMMON,
  B3c: HOST_RULES_COMMON,
};

/** 1 件の観測の形式を確かめる。正規なら null、不正なら理由を返す。 */
function invalidObservation(o, rules) {
  if (!isPlainObject(o)) return "観測がオブジェクトではない";
  if (!Object.keys(rules).includes(o.id)) return `観測 ID が想定外（${describe(o.id)}）`;
  if (typeof o.at !== "string" || Number.isNaN(Date.parse(o.at))) return `at が日時の文字列ではない（${o.id}）`;
  if (typeof o.command !== "string" || o.command === "") return `command が空でない文字列ではない（${o.id}）`;
  if (!isInt(o.exitCode)) return `exitCode が整数ではない（${o.id}、${describe(o.exitCode)}）`;
  if (typeof o.output !== "string") return `output が文字列ではない（${o.id}）`;
  if (!isPlainObject(o.facts)) return `facts がオブジェクトではない（${o.id}）`;
  for (const [k, ok] of Object.entries(rules[o.id])) {
    if (!ok(o.facts[k])) return `facts.${k} の形式が不正（${o.id}、${describe(o.facts[k])}）`;
  }
  return null;
}

/** API 段階の 1 件の形式。 */
export function invalidApiObservation(o) {
  return invalidObservation(o, API_RULES);
}

/** host 段階の 1 件の形式。B1 では、フックの記録に解析できない行があれば記録不正とする。 */
export function invalidHostObservation(o) {
  const why = invalidObservation(o, HOST_RULES);
  if (why !== null) return why;
  if (o.id === "B1" && o.facts.hookRuns.invalidLines > 0) return `フックの記録に解析できない行が ${o.facts.hookRuns.invalidLines} 件ある（B1）`;
  return null;
}

// ---- 判定 ----

/**
 * 観測の判定の共通部分。checks は [ok, 条件名] の配列（ok は true・false、読み取り失敗は null）。
 * 不一致（false）が 1 つでもあれば不一致、無ければ読み取り失敗（null）を未観測、すべて真なら一致。
 * unobservedWhy は、実行そのものが失敗していて判定できない理由（返れば未観測）。
 */
function judgeEntries(entries, ids, { invalid, checks, unobservedWhy }) {
  const list = Array.isArray(entries) ? entries : [];
  const reasons = [];
  const seen = new Set();
  for (const o of list) {
    const why = invalid(o);
    if (why !== null) { reasons.push(why); continue; }
    if (seen.has(o.id)) reasons.push(`観測 ${o.id} が 2 件ある`);
    seen.add(o.id);
  }
  const items = ids.map((id) => {
    const o = list.find((x) => isPlainObject(x) && x.id === id && invalid(x) === null);
    if (!o) return { id, state: "未観測", detail: "観測の記録が無い" };
    const run = unobservedWhy?.(o);
    if (run) return { id, state: "未観測", detail: run };
    const cs = checks(o);
    // checks の各要素は [条件名, 真偽値]（真偽値が null は読み取り失敗）
    const failed = cs.filter(([, ok]) => ok === false).map(([label]) => label);
    if (failed.length > 0) return { id, state: "不一致", detail: `満たさなかった条件: ${failed.join("、")}` };
    const unread = cs.filter(([, ok]) => ok === null).map(([label]) => label);
    if (unread.length > 0) return { id, state: "未観測", detail: `読み取れなかった条件: ${unread.join("、")}` };
    return { id, state: "一致", detail: "すべての条件を満たした" };
  });
  let verdict;
  if (reasons.length > 0) verdict = "記録不正";
  else if (items.some((i) => i.state === "不一致")) verdict = "不一致";
  else if (items.some((i) => i.state === "未観測")) verdict = "未観測";
  else verdict = "一致";
  return { verdict, items, reasons };
}

/** 真偽の値を条件にする。読み取り値が null なら読み取り失敗（null）。 */
const tri = (value, pred) => (value === null || value === undefined ? null : pred(value));

/** 5.2（API）の判定。A1・A2 がそろい、すべての条件を満たしたときだけ一致。 */
export function judgeApiObservations(entries) {
  return judgeEntries(entries, API_IDS, {
    invalid: invalidApiObservation,
    checks: (o) => {
      const f = o.facts;
      if (o.id === "A1") {
        return [
          ["HTTP 201 で作成された", tri(f.status, (s) => s === 201)],
          ["PR の番号を得た", f.prNumber === null ? null : true],
          ["base が保護役を指す", tri(f.prBaseRef, (v) => v === f.requestedBase)],
          ["head が分岐元役を指す", tri(f.prHeadRef, (v) => v === f.requestedHead)],
          ["state が open", tri(f.prState, (v) => v === "open")],
        ];
      }
      return [
        ["HTTP 422 で拒否された", tri(f.status, (s) => s === 422)],
        ["理由が「差が無い」の旨（No commits between）", tri(f.message, (m) => /No commits between/i.test(m))],
        ["PR は作られていない", !f.prCreated],
      ];
    },
  });
}

/** 8.2（host）の判定。B1 は PR の作成、B2 は再利用、B3・B3c は PR を作らずに止まること。 */
export function judgeHostObservations(entries) {
  return judgeEntries(entries, HOST_IDS, {
    invalid: invalidHostObservation,
    unobservedWhy: (o) => {
      if (o.facts.timedOut) return "タイムアウト（未観測）";
      if (o.id === "B1" && o.facts.hostExitCode === null) return "host の終了コードを読めない（未観測）";
      if (o.id === "B1" && o.facts.hostExitCode !== 0) return `host の終了コードが ${o.facts.hostExitCode}（0 以外は未観測）`;
      return null;
    },
    checks: (o) => {
      const f = o.facts;
      const mine = f.openPrs === null ? null : f.openPrs.filter((p) => p.headRef === f.requestedHead && p.baseRef === f.requestedBase);
      const refSame = tri(f.refBefore, () => (f.refAfter === null ? null : f.refBefore === f.refAfter));
      const headSame = f.cloneHeadBefore === null || f.cloneHeadAfter === null ? null : f.cloneHeadBefore === f.cloneHeadAfter;
      const noBrwDir = tri(f.brwDirExists, (v) => v === false);
      const common = [
        ["分岐元の GitHub 上の先頭が変わらない", refSame],
        ["クローンの HEAD が変わらない（別コミット・分岐なし）", headSame],
        ["クローンのブランチが分岐元のまま", tri(f.cloneBranch, (v) => v === f.requestedHead)],
        [".git/brw（作業の状態）が無い", noBrwDir],
      ];
      if (o.id === "B1") {
        const h = o.facts.hookRuns;
        const pr = mine !== null && f.openPrs.length === 1 && mine.length === 1 ? mine[0] : null;
        return [
          ["出力に作成の旨と PR の URL がある", mine === null ? null : o.output.includes("PR を作成しました: ") && pr !== null && o.output.includes(`/pull/${pr.number}`)],
          ["PR が 1 件だけで、open・base・head が要求どおり", mine === null ? null : pr !== null && pr.state === "open"],
          ["brw pr-template が実際に実行された（フックの記録）", tri(h.prTemplate, (v) => v === true)],
          ["brw pr が実際に実行された（フックの記録）", tri(h.pr, (v) => v === true)],
          ["直接の gh pr create が使われていない（フックの記録）", tri(h.directGhPrCreate, (v) => v === false)],
          ...common,
        ];
      }
      if (o.id === "B2") {
        const pr = mine !== null && f.openPrs.length === 1 && mine.length === 1 ? mine[0] : null;
        return [
          ["出力に再利用の旨と PR の URL がある", mine === null ? null : o.output.includes("PR を再利用しました: ") && pr !== null && o.output.includes(`/pull/${pr.number}`)],
          ["PR が増えず 1 件のまま", f.openPrs === null ? null : f.openPrs.length === 1 && mine?.length === 1],
          ["終了コードが 0", o.exitCode === 0],
          ...common,
        ];
      }
      if (o.id === "B3") {
        return [
          ["終了コードが 1（承認の案内で止まる）", o.exitCode === 1],
          ["承認が必要な旨と --confirmed の案内が出た", o.output.includes("PR 作成には通常の承認が必要です") && o.output.includes("--confirmed")],
          ["PR が作られていない", f.openPrs === null ? null : f.openPrs.length === 0],
          ...common,
        ];
      }
      return [
        ["終了コードが 1（非端末の --confirmed で拒否）", o.exitCode === 1],
        ["--confirmed は端末でだけ有効と案内された", o.output.includes("--confirmed は、利用者が自分の端末で実行したときだけ有効です")],
        ["PR が作られていない", f.openPrs === null ? null : f.openPrs.length === 0],
        ...common,
      ];
    },
  });
}

// ---- 出力・フックの記録・stream-json の解析（純粋関数） ----

/** 作成の応答（201）の本文から PR の番号を読む。読めなければ null。 */
export function createdPrNumber(status, body) {
  return status === 201 && isPlainObject(body) && isInt(body.number) && body.number >= 1 ? body.number : null;
}

/**
 * PR の一覧（head で探したもの）から、head が指定のブランチの PR の番号を取る。
 * 一覧が配列でない・番号が読めない項目がある場合は null（空として扱わない）。
 */
export function prNumbersForHead(list, head) {
  if (!Array.isArray(list)) return null;
  for (const p of list) {
    if (!isPlainObject(p) || !isInt(p.number) || p.number < 1 || typeof p.head?.ref !== "string") return null;
  }
  return list.filter((p) => p.head.ref === head).map((p) => p.number);
}

/** 読み取りの結果（{ok, data}）を、オープンな PR の一覧（番号・状態・base・head）に整える。読み取り失敗・形の違いは null。 */
export function toOpenPrs(res) {
  if (!res || res.ok !== true || !Array.isArray(res.data)) return null;
  return res.data.map((p) => ({ number: p?.number, state: p?.state, baseRef: p?.base?.ref, headRef: p?.head?.ref }));
}

/** gh api -i の出力から HTTP の状態コードを読む。無ければ null。 */
export function parseStatus(text) {
  const s = String(text ?? "");
  const m = /^HTTP\/[\d.]+\s+(\d{3})\b/m.exec(s) ?? /\(HTTP (\d{3})\)/.exec(s);
  return m ? Number(m[1]) : null;
}

/** claude -p の stream-json から、Bash の呼び出しと結果を対応づけて取り出す。解析できない行は数える。 */
export function parseClaudeStream(text) {
  const results = [];
  const tools = new Map();
  let invalidLines = 0;
  for (const line of String(text ?? "").split("\n")) {
    if (line.trim() === "") continue;
    let e;
    try { e = JSON.parse(line); } catch { invalidLines++; continue; }
    const content = e?.message?.content;
    if (e?.type === "assistant" && Array.isArray(content)) {
      for (const b of content) if (b?.type === "tool_use") tools.set(b.id, String(b.input?.command ?? ""));
    }
    if (e?.type === "user" && Array.isArray(content)) {
      for (const b of content) {
        if (b?.type !== "tool_result" || !tools.has(b.tool_use_id)) continue;
        results.push({
          command: tools.get(b.tool_use_id),
          text: typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? ""),
          isError: b.is_error === true,
        });
      }
    }
  }
  return { results, invalidLines };
}

/** 最後の brw pr（pr-template を除く）の結果の本文。無ければ null。 */
export function brwPrOutput(results) {
  const r = [...(results ?? [])].reverse().find((x) => /brw(?:\.mjs)?["']?\s+pr(?=\s|$)/.test(x.command ?? ""));
  return r ? r.text : null;
}

/** フックの記録（hook-logger.mjs の 1 行 JSON）から、Bash が実際に実行されたかを読む。 */
export function parseHookRuns(text) {
  const runs = { prTemplate: false, pr: false, directGhPrCreate: false };
  let invalidLines = 0;
  const denied = (stdout) => {
    try { return JSON.parse(stdout)?.hookSpecificOutput?.permissionDecision === "deny"; } catch { return false; }
  };
  for (const line of String(text ?? "").split("\n")) {
    if (line.trim() === "") continue;
    let e;
    try { e = JSON.parse(line); } catch { invalidLines++; continue; }
    const cmd = e?.input?.tool_input?.command;
    if (e?.input?.tool_name !== "Bash" || typeof cmd !== "string") continue;
    // 実行後（PostToolUse）の記録があるものだけを「実行された」とみなす
    const executed = e.event === "PostToolUse";
    if (executed && /brw\.mjs["']?\s+pr-template(?=\s|$)/.test(cmd)) runs.prTemplate = true;
    if (executed && /brw\.mjs["']?\s+pr(?=\s|$)/.test(cmd)) runs.pr = true;
    if (/\bgh\s+pr\s+create\b/.test(cmd) && (executed || !denied(e.stdout ?? ""))) runs.directGhPrCreate = true;
  }
  return { ...runs, invalidLines };
}

/** 宣言の内容。登録済み（autoApprove 未指定）か、承認が必要（pullRequest: false）かを選ぶ。 */
export function declarationFor({ base, prot }, { approvalRequired = false } = {}) {
  return {
    workBranches: ["dev/*"],
    protectedBranches: ["main", prot],
    baseBranch: base,
    baseBranches: [base],
    namePattern: "^dev/[a-z0-9]+(-[a-z0-9]+)*$",
    maxNameLength: 54,
    ...(approvalRequired ? { autoApprove: { pullRequest: false } } : {}),
    preview: { provider: "none" },
  };
}

/** claude -p の引数（Haiku・1 回・project の設定だけ・Bash のみ許可）。 */
export function claudeArgs(prompt) {
  return [
    "-p", prompt, "--model", "haiku", "--max-turns", "10", "--setting-sources", "project",
    "--output-format", "stream-json", "--verbose", "--include-hook-events", "--allowedTools", "Bash", "--no-session-persistence",
  ];
}

/** B1 の指示文。pr-template と pr の実行、本文の記入だけを頼む。 */
export function promptB1(brwCli, prot) {
  return [
    "次の手順を、この順序で実行してください。他のことはしないでください。",
    `1. \`node ${brwCli} pr-template\` を実行してください。表示された本文ファイルの場所と記入指示に従い、本文を書いてください（記入内容は、この確認の事実を短く書くだけで十分です。先頭の「未記入」の印の行は削除してください。書き込みは Bash で行ってください）。`,
    `2. \`node ${brwCli} pr --title "${PR_TITLE}"${prot ? ` --target ${prot}` : ""}\` を実行してください。`,
    "最後に、PR の URL か、止まった理由を一言で答えてください。",
  ].join("\n");
}

// ---- 計画 ----

const API_OBSERVATIONS = [
  { id: "A1", title: "分岐元役を head、保護役を base とする PR が API で作れる", expect: "HTTP 201、読み戻しで base・head が一致し state が open" },
  { id: "A2", title: "差が無い（同じ commit）組では PR を作れない", expect: "HTTP 422、理由に「No commits between」、PR は作られない" },
];
const HOST_OBSERVATIONS = [
  { id: "B3", title: "承認が必要な宣言では、非端末の brw pr は --confirmed の案内を出して止まる（PR は作らない）", expect: "終了コード 1、承認の案内、PR 0 件、refs・HEAD 不変" },
  { id: "B3c", title: "非端末で --confirmed を付けた brw pr は拒否される（通信なし）", expect: "終了コード 1、端末でだけ有効の案内、PR 0 件" },
  { id: "B1", title: "宣言が登録済みなら、claude が pr-template と pr を実行して PR が 1 件作られる（確認省略）", expect: "出力に作成の旨と URL、PR 1 件（open・base 保護役・head 分岐元役）、refs・HEAD・.git/brw 不変、フックの記録で両コマンドの実行、gh pr create なし" },
  { id: "B2", title: "同じ brw pr の再実行で PR が再利用され、重複しない", expect: "終了コード 0、再利用の旨と同じ URL、PR は 1 件のまま" },
];

/** API 段階の計画（GitHub を呼ばない）。ブランチ名は検証用の形。 */
export function planApi(epoch = Math.floor(Date.now() / 1000)) {
  return {
    branches: [`verify/brw-bpr-base-${epoch}`, `verify/brw-bpr-prot-${epoch}`, `verify/brw-bpr-same-${epoch}`],
    observations: API_OBSERVATIONS,
  };
}

/** host 段階の計画（ホストを呼ばない）。observations は実行の順序。 */
export function planHost(epoch = Math.floor(Date.now() / 1000)) {
  return {
    base: `verify/brw-bpr-base-${epoch}`,
    prot: `verify/brw-bpr-prot-${epoch}`,
    claudeCalls: 1,
    observations: HOST_OBSERVATIONS,
  };
}

// ---- 報告 ----

/** 判定の報告（Markdown）。judged は judge の戻り値。 */
export function formatObservationReport({ stage, at, judged, version }) {
  const title = stage === "api" ? "5.2 GitHub の API" : "8.2 実機の Claude Code";
  const titles = Object.fromEntries([...API_OBSERVATIONS, ...HOST_OBSERVATIONS].map((o) => [o.id, o.title]));
  const lines = [
    `### brw-pr-handoff の実環境の確認: ${title}（${version ?? "版不明"}・${at}）`,
    "",
    "| 観測 | 判定 | 観測の内容 |",
    "|---|---|---|",
    ...judged.items.map((i) => `| ${i.id} ${titles[i.id] ?? ""} | ${i.state} | ${i.detail} |`),
  ];
  if (judged.reasons.length > 0) lines.push("", `記録の不正: ${judged.reasons.join("; ")}`);
  lines.push("", `総合: ${judged.verdict}`);
  return lines.join("\n");
}

/** 観測の要点（コマンド・終了コード・出力の先頭 300 字・読み戻した状態）。cleanup で消える生の出力の代わりに示す。 */
export function formatEvidence(observations) {
  return (Array.isArray(observations) ? observations : []).filter(isPlainObject).map((o) => {
    const head = String(o.output ?? "").replace(/\s+/g, " ").slice(0, 300);
    const f = isPlainObject(o.facts) ? o.facts : {};
    const readback = JSON.stringify(f.openPrs !== undefined ? { openPrs: f.openPrs } : { prNumber: f.prNumber, prBaseRef: f.prBaseRef, prHeadRef: f.prHeadRef, prState: f.prState, status: f.status });
    return [
      `- ${o.id}: \`${String(o.command ?? "")}\``,
      `  - 終了コード ${o.exitCode}`,
      `  - 出力の先頭: ${head}`,
      `  - 読み戻し: ${readback}`,
    ].join("\n");
  }).join("\n");
}

// ---- 実行（実 GitHub・実ホスト。BRW_REAL_ENV=1 のときだけ） ----

const recordFn = (kind, value) => {
  const r = run(process.execPath, [PREPARE, "--record", `${kind}=${value}`]);
  if (r.code !== 0) throw new Error(`状態の記録に失敗しました（${kind}）: ${r.err.trim()}`);
};
const refSha = (name) => {
  const r = ghApi([`repos/${SLUG}/git/ref/heads/${name}`, "--jq", ".object.sha"]);
  return r.code === 0 && /^[0-9a-f]{40}$/.test(r.out.trim()) ? r.out.trim() : null;
};
const createBranch = (name, sha) => {
  const c = ghApi(["-X", "POST", `repos/${SLUG}/git/refs`, "-f", `ref=refs/heads/${name}`, "-f", `sha=${sha}`]);
  if (c.code !== 0) throw new Error(`ブランチ ${name} を作れません: ${c.err.trim().split("\n")[0]}`);
  recordFn("branch", name);
};
/** 分岐元役のブランチにファイルを 1 commit で置く（branch= を必ず指定。main には書かない）。既にあるファイルは sha を付けて置き換える。 */
const putFile = (branch, path, text) => {
  const cur = ghApi([`repos/${SLUG}/contents/${path}?ref=${encodeURIComponent(branch)}`, "--jq", ".sha"]);
  const sha = cur.code === 0 && /^[0-9a-f]{40}$/.test(cur.out.trim()) ? cur.out.trim() : null;
  const put = ghApi([
    "-X", "PUT", `repos/${SLUG}/contents/${path}`,
    "-f", `message=brw-pr-handoff の検証用 commit\n\n${CO_AUTHOR}`, "-f", `content=${Buffer.from(text).toString("base64")}`, "-f", `branch=${branch}`,
    ...(sha ? ["-f", `sha=${sha}`] : []),
  ]);
  if (put.code !== 0) throw new Error(`${branch} に commit を作れません: ${put.err.trim().split("\n")[0]}`);
};
/** 保護役を base とするオープンな PR の一覧。読み取りの失敗は null（空として扱わない）。 */
const openPrsOf = (prot) => toOpenPrs(ghJson(`repos/${SLUG}/pulls?state=open&base=${encodeURIComponent(prot)}&per_page=100`));
/**
 * 作成の応答から PR の番号を得て、作成の直後に記録する。201 なのに番号が読めないときは、head で PR を探して記録する。
 * 探しても見つからない・探す問い合わせが失敗したときは例外で止める（PR が作られた可能性があり、後始末の対象に入っていない）。
 */
const recordCreatedPrs = (head, status, body, code) => {
  const num = createdPrNumber(status, body);
  if (num !== null) { recordFn("pr", num); return num; }
  const mayHaveCreated = status === 201 || (status === null && code === 0);
  if (!mayHaveCreated) return null;
  const r = ghJson(`repos/${SLUG}/pulls?head=${encodeURIComponent(`${OWNER}:${head}`)}&state=all&per_page=100`);
  const nums = r.ok ? prNumbersForHead(r.data, head) : null;
  if (nums === null) throw new Error(`PR が作成された可能性があるが番号を読めず、head=${head} の PR を探す問い合わせも失敗した。PR は後始末の対象に入っていない（GitHub で手で確認して閉じること）`);
  if (nums.length === 0) throw new Error(`PR が作成された可能性があるが番号を読めず、head=${head} の PR も見つからない。PR は後始末の対象に入っていない（GitHub で手で確認すること）`);
  nums.forEach((n) => recordFn("pr", n));
  return nums[0];
};
const ghVersion = () => {
  const r = run("gh", ["--version"]);
  return r.code === 0 ? (r.out.split("\n")[0] || "版不明") : "版不明";
};
const claudeVersion = () => {
  const r = run("claude", ["--version"]);
  return r.code === 0 ? (r.out.trim().split("\n")[0] || "版不明") : "版不明";
};
const trimOut = (s) => String(s ?? "").slice(0, TRIM);

/** API 段階（5.2）。使い捨てブランチ 3 本と、作れた PR だけに書き込む。 */
function stageApi() {
  const st = readState();
  if (!st) throw new Error("先に tests/real-env/prepare.mjs を実行してください（状態ファイルが必要です）");
  const epoch = Math.floor(Date.now() / 1000);
  const [base, prot, same] = planApi(epoch).branches;
  const at = new Date().toISOString();
  const dir = join(RUN_ROOT, `api-${epoch}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const mainSha = refSha("main");
  if (!mainSha) throw new Error("main の commit を読めません");
  createBranch(base, mainSha);
  createBranch(prot, mainSha);
  putFile(base, `verify/brw-bpr-${epoch}.txt`, `brw-pr-handoff 5.2 の実環境の確認\n${epoch}\n`);

  const obs = [];
  const post = (path, fields) => ghApi(["-i", "-X", "POST", path, ...fields.flatMap(([k, v]) => ["-f", `${k}=${v}`])]);
  // gh api -i の出力は「ステータス行・ヘッダー（CRLF）・空行・本文」。空行（CRLF または LF の 2 連続）の後の JSON を読む
  const prBody = (text) => {
    const m = /\r?\n\r?\n/.exec(text);
    if (!m) return null;
    try { return JSON.parse(text.slice(m.index + m[0].length)); } catch { return null; }
  };

  // A1: head = 分岐元役、base = 保護役
  const a1 = post(`repos/${SLUG}/pulls`, [["title", `5.2 の検証 (${epoch})`], ["head", base], ["base", prot], ["body", PR_BODY]]);
  const a1Body = prBody(a1.out);
  const a1Status = parseStatus(a1.out) ?? parseStatus(a1.err);
  const a1Num = recordCreatedPrs(base, a1Status, a1Body, a1.code);
  const a1Read = a1Num === null ? null : ghJson(`repos/${SLUG}/pulls/${a1Num}`);
  obs.push({
    id: "A1", at: new Date().toISOString(), command: `gh api -i -X POST repos/${SLUG}/pulls（head=${base}・base=${prot}）`,
    exitCode: a1.code, output: trimOut(a1.out + a1.err),
    facts: {
      status: a1Status, requestedHead: base, requestedBase: prot, prNumber: a1Num,
      prBaseRef: a1Read?.ok ? a1Read.data.base?.ref ?? null : null,
      prHeadRef: a1Read?.ok ? a1Read.data.head?.ref ?? null : null,
      prState: a1Read?.ok ? a1Read.data.state ?? null : null,
    },
  });

  // A2: 差が無い組（分岐元役と保護役と同じ commit）
  createBranch(same, mainSha);
  const a2 = post(`repos/${SLUG}/pulls`, [["title", `5.2 の差なしの確認 (${epoch})`], ["head", same], ["base", prot], ["body", PR_BODY]]);
  const a2Status = parseStatus(a2.out) ?? parseStatus(a2.err);
  const a2Created = a2Status === 201;
  recordCreatedPrs(same, a2Status, prBody(a2.out), a2.code);
  obs.push({
    id: "A2", at: new Date().toISOString(), command: `gh api -i -X POST repos/${SLUG}/pulls（head=${same}・base=${prot}、同じ commit）`,
    exitCode: a2.code, output: trimOut(a2.out + a2.err),
    facts: { status: a2Status, message: a2Message(a2), prCreated: a2Created },
  });

  writeFileSync(join(dir, "observations.jsonl"), obs.map((o) => JSON.stringify(o)).join("\n") + "\n");
  const judged = judgeApiObservations(obs);
  return { report: formatObservationReport({ stage: "api", at, judged, version: ghVersion() }), evidence: formatEvidence(obs), ok: judged.verdict === "一致", dir };
}

/** 422 の応答の本文（JSON）の message と errors[].message を連結して返す。読めなければ標準エラーと出力の先頭を返す。 */
export function a2Message(r) {
  const m = /\r?\n\r?\n/.exec(r.out ?? "");
  if (m) {
    try {
      const b = JSON.parse(r.out.slice(m.index + m[0].length));
      const parts = [b.message, ...(Array.isArray(b.errors) ? b.errors.map((e) => e?.message) : [])].filter((x) => typeof x === "string");
      if (parts.length) return trimOut(parts.join(" / "));
    } catch { /* 読めなければ下へ */ }
  }
  const t = `${r.err ?? ""}${r.out ?? ""}`.trim();
  return t ? trimOut(t) : null;
}

/** host 段階（8.2）。実 GitHub のクローンで、B3・B3c・B1（claude）・B2 の順に観測する。 */
function stageHost() {
  const st = readState();
  if (!st) throw new Error("先に tests/real-env/prepare.mjs を実行してください（状態ファイルが必要です）");
  const epoch = Math.floor(Date.now() / 1000);
  const plan = planHost(epoch);
  const { base, prot } = plan;
  const at = new Date().toISOString();
  const dir = join(RUN_ROOT, `host-${epoch}`);
  const clone = join(dir, "clone");
  const hookDir = join(dir, "hook-log");
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  // 使い捨てブランチ 2 本（分岐元役・保護役）。保護役は main と同じ commit、分岐元役は宣言の commit を 1 つ先に持つ
  const mainSha = refSha("main");
  if (!mainSha) throw new Error("main の commit を読めません");
  createBranch(base, mainSha);
  createBranch(prot, mainSha);
  putFile(base, ".branch-release-workflow.json", `${JSON.stringify(declarationFor({ base, prot }), null, 2)}\n`);

  // 実 GitHub のクローン（公開リポジトリなので資格情報なしで取得）。分岐元役のチェックアウト
  const cl = run("git", ["clone", "--quiet", "--branch", base, `https://github.com/${SLUG}.git`, clone], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (cl.code !== 0) throw new Error(`クローンに失敗しました: ${cl.err.trim().split("\n")[0]}`);
  appendFileSync(join(clone, ".git/info/exclude"), ".claude/\n");
  mkdirSync(join(clone, ".claude"), { recursive: true });
  const hookCmd = (ev) => ({ type: "command", command: `node "${LOGGER}" claude ${ev}` });
  writeFileSync(join(clone, ".claude/settings.json"), `${JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [hookCmd("PreToolUse")] }],
      PostToolUse: [{ matcher: "Bash", hooks: [hookCmd("PostToolUse")] }],
    },
  }, null, 2)}\n`);
  const hostEnv = { ...process.env, BRW_REAL_ENV: "1", BRW_HOOK_LOG_DIR: hookDir, GIT_TERMINAL_PROMPT: "0" };

  // 観測の前後の状態（読み取りのみ）
  const snap = () => {
    const h = run("git", ["rev-parse", "HEAD"], { cwd: clone });
    const b = run("git", ["branch", "--show-current"], { cwd: clone });
    let brwDir = null;
    try { statSync(join(clone, ".git", "brw")); brwDir = true; } catch (e) { brwDir = e?.code === "ENOENT" ? false : null; }
    return {
      ref: refSha(base),
      head: h.code === 0 && /^[0-9a-f]{40}$/.test(h.out.trim()) ? h.out.trim() : null,
      branch: b.code === 0 && b.out.trim() !== "" ? b.out.trim() : null,
      brwDir,
      openPrs: openPrsOf(prot),
    };
  };
  const facts = (before, after, extra) => ({
    openPrs: after.openPrs, refBefore: before.ref, refAfter: after.ref,
    cloneHeadBefore: before.head, cloneHeadAfter: after.head, cloneBranch: after.branch, brwDirExists: after.brwDir,
    requestedHead: base, requestedBase: prot, timedOut: false, hostExitCode: null, ...extra,
  });
  // 分岐元役を head とする PR（全状態）を記録する。読み取りに失敗したら中止する（後始末の対象を確かめられないため）
  const recordHeadPrs = () => {
    const r = ghJson(`repos/${SLUG}/pulls?head=${encodeURIComponent(`${OWNER}:${base}`)}&state=all&per_page=100`);
    const nums = r.ok ? prNumbersForHead(r.data, base) : null;
    if (nums === null) throw new Error(`head=${base} の PR を読めない。後始末の対象を確かめられないため中止する`);
    nums.forEach((n) => recordFn("pr", n));
  };
  const observed = [];
  // brw pr を直接（非端末で）実行し、前後の状態を読む
  const direct = (id, args, command) => {
    const before = snap();
    const started = new Date().toISOString();
    const r = spawnSync(process.execPath, [BRW_CLI, "pr", ...args], { cwd: clone, env: hostEnv, input: "", encoding: "utf8", timeout: BRW_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
    recordHeadPrs();
    const after = snap();
    observed.push({ id, at: started, command, exitCode: r.status ?? -1, output: trimOut(`${r.stdout ?? ""}${r.stderr ?? ""}`), facts: facts(before, after, { timedOut: r.error?.code === "ETIMEDOUT" }) });
  };

  // B3: 承認が必要な宣言（編集中のため未登録扱い）。PR が無い段階で確かめる。本文は仮の記入済みの本文を置く。
  const bodyPath = bodyPathOf(clone, base);
  mkdirSync(dirname(bodyPath), { recursive: true });
  writeFileSync(bodyPath, "分岐元からの PR の確認（承認の確認用）。\n", { mode: 0o600 });
  writeFileSync(join(clone, ".branch-release-workflow.json"), `${JSON.stringify(declarationFor({ base, prot }, { approvalRequired: true }), null, 2)}\n`);
  direct("B3", ["--title", PR_TITLE, "--target", prot], "node brw.mjs pr --title …（承認が必要な宣言・非端末）");
  // B3c: 非端末で --confirmed を付けた拒否（通信なし）
  direct("B3c", ["--title", PR_TITLE, "--target", prot, "--confirmed"], "node brw.mjs pr --title … --confirmed（非端末）");
  // 宣言と本文を元に戻す（B1 は登録済みの宣言・未記入の雛形から始める）
  run("git", ["checkout", "--", ".branch-release-workflow.json"], { cwd: clone });
  rmSync(bodyPath, { force: true });

  // B1: claude -p（Haiku・1 回）が pr-template と pr を実行する
  const counterNow = existsSync(COUNTER) ? JSON.parse(readFileSync(COUNTER, "utf8")) : { claude: 0, codex: 0 };
  if ((counterNow.claude ?? 0) >= CLAUDE_LIMIT) throw new Error(`claude の呼び出し回数が上限（${CLAUDE_LIMIT}）に達しました`);
  mkdirSync(EVENTS, { recursive: true });
  writeFileSync(COUNTER, JSON.stringify({ ...counterNow, claude: (counterNow.claude ?? 0) + 1 }));
  mkdirSync(hookDir, { recursive: true });
  const beforeB1 = snap();
  const startedB1 = new Date().toISOString();
  const c = spawnSync("claude", claudeArgs(promptB1(BRW_CLI, prot)), { cwd: clone, env: hostEnv, input: "", encoding: "utf8", timeout: HOST_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  recordHeadPrs();
  writeFileSync(join(dir, "b1.stdout.jsonl"), c.stdout ?? "");
  writeFileSync(join(dir, "b1.stderr.txt"), c.stderr ?? "");
  const parsed = parseClaudeStream(c.stdout ?? "");
  const hookFile = join(hookDir, "claude.jsonl");
  const hookRuns = existsSync(hookFile)
    ? parseHookRuns(readFileSync(hookFile, "utf8"))
    : { prTemplate: null, pr: null, directGhPrCreate: null, invalidLines: 0 };
  const afterB1 = snap();
  observed.push({
    id: "B1", at: startedB1, command: "claude -p（Haiku・brw pr-template → brw pr、確認省略の宣言）",
    exitCode: c.status ?? -1, output: trimOut(brwPrOutput(parsed.results) ?? ""),
    facts: facts(beforeB1, afterB1, { hostExitCode: c.status, timedOut: c.error?.code === "ETIMEDOUT", hookRuns }),
  });

  // B2: 同じ brw pr の再実行（PR は再利用される）
  direct("B2", ["--title", PR_TITLE, "--target", prot], "node brw.mjs pr --title …（再実行）");

  writeFileSync(join(dir, "observations.jsonl"), observed.map((o) => JSON.stringify(o)).join("\n") + "\n");
  const judged = judgeHostObservations(observed);
  return {
    report: formatObservationReport({ stage: "host", at, judged, version: `claude ${claudeVersion()}` }),
    evidence: formatEvidence(observed), ok: judged.verdict === "一致", dir,
  };
}

function main() {
  requireRealEnv("base-pr-observe.mjs");
  const args = parseArgs(process.argv.slice(2));
  if (args.error) { console.error(args.error); console.error(USAGE); process.exit(2); }
  if (args.help) { console.log(USAGE); process.exit(0); }
  if (args.dryRun) {
    if (args.stage === "api") {
      const p = planApi();
      console.log("== brw-pr-handoff 5.2 の実環境の確認の計画（GitHub へ書き込みません） ==");
      console.log("作る使い捨てブランチ（名前の形）: 分岐元役・保護役・差なしの確認用の 3 本（main の commit から）");
      console.log("作る commit: 分岐元役のブランチに 1 件（main には書かない）");
      console.log("作る PR: 最大 2 件（A1 の 1 件。A2 は作られない想定）");
      for (const o of p.observations) console.log(`  - ${o.id} ${o.title}: 想定 ${o.expect}`);
    } else {
      const p = planHost();
      console.log("== brw-pr-handoff 8.2 の実環境の確認の計画（ホストと GitHub の書き込みは行いません） ==");
      console.log(`claude の呼び出し: ${p.claudeCalls} 回（Haiku・--max-turns 10）。上限 ${CLAUDE_LIMIT} 回（共有カウンタ）`);
      console.log("作る使い捨てブランチ: 分岐元役・保護役の 2 本。分岐元役に宣言の commit 1 件（main には書かない）");
      console.log("作る PR: 1 件（B1 の確認省略の PR）。B3・B3c・B2 は PR を作らない想定");
      console.log("順序: B3 → B3c → B1 → B2（B3 は PR が無い段階で行う）");
      for (const o of p.observations) console.log(`  - ${o.id} ${o.title}: 想定 ${o.expect}`);
    }
    process.exit(0);
  }
  try {
    const r = args.stage === "api" ? stageApi() : stageHost();
    console.log(`\n${r.report}`);
    console.log(`\n観測の要点（生の出力は ${r.dir}。cleanup.mjs で消えます）:`);
    console.log(r.evidence);
    console.log("\n後片付けは tests/real-env/cleanup.mjs（記録されたものだけ削除）。");
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`段階 ${args.stage} を中止しました: ${e.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
