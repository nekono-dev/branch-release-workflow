#!/usr/bin/env node
// 14.2: 標準入出力が端末として渡されないこと（エージェントの Bash・シェル）と、疑似端末（script）経由では端末に見えること（確認の限界）を、実ホストで観測する。
// 使い方: BRW_REAL_ENV=1 node tests/real-env/tty-observe.mjs [--host claude|codex|both] [--dry-run]
//   ホストごとに 1 回だけ実際に呼び出す。呼び出し回数は stop-observe.mjs と同じ共有カウンタ（events/calls.json）で数え、上限に達したら止まる。
//   --dry-run は呼び出しも作業場所の作成もせず、計画だけを表示する。
//   BRW（scripts/）には依存しない。記録用のスクリプト（node の 1 ファイル）だけを使う。結果は標準出力に出し、リポジトリには残さない。
//   想定と異なる結果は「不一致」と書き、成功扱いにしない。記録が無いときは「未観測」と書く。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WORK_DIR, requireRealEnv } from "./common.mjs";
import { cleanupCodexHome, prepareCodexHome } from "./stop-observe.mjs";

// stop-observe.mjs と同じ共有の呼び出し回数（上限は既存の基盤の決まり）
const LIMITS = { claude: 12, codex: 14 };
const COUNTER = join(WORK_DIR, "events", "calls.json");
const OUT_ROOT = join(WORK_DIR, "tty-observe");
const TIMEOUT_MS = 240000;
const USAGE = "使い方: BRW_REAL_ENV=1 node tests/real-env/tty-observe.mjs [--host claude|codex|both] [--dry-run]";

const binOf = (host) => (host === "claude" ? "claude" : "codex");

/** 引数を読む。未知の引数・未知のホストは error を返す（終了コード 2 は呼び出し側で決める）。 */
export function parseArgs(argv) {
  const out = { host: "both", dryRun: false, help: false, error: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--host") {
      const v = argv[++i];
      if (!["claude", "codex", "both"].includes(v)) return { ...out, error: `--host は claude・codex・both のいずれかです（指定: ${v ?? "なし"}）` };
      out.host = v;
    } else return { ...out, error: `未知の引数です: ${a}` };
  }
  return out;
}

/**
 * 記録用スクリプト（Node の ESM）。引数のモード（direct・pty）と、標準入力・標準出力の isTTY の値（"undefined"・"false"・"true"）を
 * LOG に 1 行追記する。本文や環境変数は記録しない。
 */
export function probeScriptOf(logFile) {
  return [
    'import { appendFileSync } from "node:fs";',
    `const LOG = ${JSON.stringify(logFile)};`,
    'const MODE = process.argv[2] ?? "unknown";',
    'appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), mode: MODE, stdin: String(process.stdin.isTTY), stdout: String(process.stdout.isTTY) }) + "\\n");',
    "",
  ].join("\n");
}

// 記録用スクリプト（probeScriptOf）が書く値の範囲。これ以外は正規の記録ではない。
const TTY_MODES = ["direct", "pty"];
const TTY_OBSERVED = ["undefined", "false", "true"];

/**
 * 理由文に載せる値の説明。値を String() やテンプレート文字列で文字列化しない（toString が使えないオブジェクトは例外になるため）。
 * null は "null"、配列は "array"、文字列・数値・真偽値は JSON.stringify を長さ 40 字までに切る（失敗時は安全な既定の文言）、それ以外は typeof の名前。
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

/**
 * 1 行の記録の形式を確かめる。正規の記録なら null、不正なら理由を返す。
 * 必須: at（空でない文字列）、mode（direct・pty）、stdin・stdout（undefined・false・true の文字列）。未知の追加項目は許可する。
 * 日時の書式は厳密に見ない（at は空でない文字列であればよい）。
 */
export function invalidTtyRecord(rec) {
  if (rec === null || typeof rec !== "object" || Array.isArray(rec)) return "記録がオブジェクトではない";
  if (typeof rec.at !== "string" || rec.at === "") return "at が空でない文字列ではない";
  if (!TTY_MODES.includes(rec.mode)) return `mode が direct・pty のいずれでもない（${describeValue(rec.mode)}）`;
  for (const k of ["stdin", "stdout"]) {
    if (!TTY_OBSERVED.includes(rec[k])) return `${k} が undefined・false・true のいずれでもない（${describeValue(rec[k])}）`;
  }
  return null;
}

/**
 * 記録（JSON Lines）を読む。構文エラーの行と、形式の不正な行は entries に入れず、件数（broken）として返す（空行は数えない）。
 * 判定には、ここで検証した entries と broken を一緒に渡す。
 */
export function parseTtyLogDetailed(text) {
  const entries = [];
  let broken = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { broken += 1; continue; }
    if (invalidTtyRecord(rec) !== null) { broken += 1; continue; }
    entries.push(rec);
  }
  return { entries, broken };
}

/** 記録の行だけを読む（判定には使わない。判定は parseTtyLogDetailed の件数を judgeTty に渡す）。 */
export const parseTtyLog = (text) => parseTtyLogDetailed(text).entries;

const match = (detail) => ({ state: "一致", detail });
const mismatch = (detail) => ({ state: "不一致", detail });
const unobserved = (detail) => ({ state: "未観測", detail });
const notTty = (v) => v === "undefined" || v === "false";
const isTty = (v) => v === "true";
const valuesOf = (e) => `標準入力=${e.stdin}、標準出力=${e.stdout}`;

/**
 * 記録から 2 つの項目を判定し、ホストの実行結果（終了コード・タイムアウト）を加える。
 *   direct: 直接の実行（パイプ等）の記録は、すべて標準入力・標準出力がどちらも端末でない（undefined または false）
 *   pty: script 経由の実行の記録は、すべて標準入力・標準出力がどちらも端末（true）
 *   host: ホストが終了コード 0 で、タイムアウトしていないこと（そうでなければ記録が揃っていても一致にしない）
 * 同じモードの記録は 1 件ずつ判定する（最初の記録だけで決めない）。端末の有無が記録の間で食い違えば、どれかが想定外なので不一致になる。
 *   broken: 構文エラー・形式の不正な記録の行の件数。1 件でもあれば一致にしない（正規の行に想定外の値があれば、従来どおり不一致を優先する）
 * verdict: 1 件でも想定外なら「不一致」。記録が無い・ホストが失敗・タイムアウト・解析できない行があれば「未観測」。それ以外（すべて想定どおりかつホストが正常終了かつ解析できない行が無い）だけ「一致」。
 */
export function judgeTty(entries, host = { exitCode: 0, timedOut: false, broken: 0 }) {
  const directs = entries.filter((e) => e.mode === "direct");
  const ptys = entries.filter((e) => e.mode === "pty");
  let a;
  if (directs.length === 0) a = unobserved("直接の実行の記録が無い");
  else {
    const bad = directs.find((e) => !(notTty(e.stdin) && notTty(e.stdout)));
    a = bad
      ? mismatch(`直接の実行で端末として渡された（${valuesOf(bad)}、記録 ${directs.length} 件中）`)
      : match(`${valuesOf(directs[0])}（記録 ${directs.length} 件、どちらも端末でない）`);
  }
  let b;
  if (ptys.length === 0) b = unobserved("疑似端末（script）経由の実行の記録が無い");
  else {
    const bad = ptys.find((e) => !(isTty(e.stdin) && isTty(e.stdout)));
    b = bad
      ? mismatch(`疑似端末経由でも端末に見えなかった（${valuesOf(bad)}、記録 ${ptys.length} 件中）`)
      : match(`${valuesOf(ptys[0])}（記録 ${ptys.length} 件、どちらも端末に見える）`);
  }
  let h;
  if (host.timedOut) h = unobserved("ホストの実行がタイムアウトしたため、記録が揃っていても一致としない");
  else if (host.exitCode !== 0) h = unobserved(`ホストの終了コード ${host.exitCode} のため、記録が揃っていても一致としない`);
  else h = match("ホストは終了コード 0 で正常終了し、タイムアウトしなかった");
  const broken = host.broken ?? 0;
  const rec = broken > 0 ? unobserved(`記録の解析できない行（構文エラー・形式の不正）が ${broken} 件あるため、一致としない`) : match("記録の行はすべて解析でき、形式も正しかった");
  const states = [a.state, b.state, h.state, rec.state];
  const verdict = states.includes("不一致") ? "不一致" : states.includes("未観測") ? "未観測" : "一致";
  return { direct: a, pty: b, host: h, record: rec, verdict };
}

/** 終了コード: 総合が「一致」のときだけ 0。 */
export const exitCodeOf = (judged) => (judged.verdict === "一致" ? 0 : 1);

/**
 * ホストの起動環境。Codex は利用者の ~/.codex を書き換えないよう、一時の CODEX_HOME を指す
 * （stop-observe.mjs の prepareCodexHome。認証は利用者の auth.json の一時のコピー。実行の後は cleanupCodexHome で消す）。Claude は環境を変えない。
 */
export function launchEnvOf(host, { base, dir, userHome }) {
  if (host !== "codex") return process.env;
  const { home } = prepareCodexHome(base, dir, userHome);
  return { ...process.env, CODEX_HOME: home };
}

/** 既存の README「観測結果」に追記できる、ホスト・版・日時つきの Markdown を作る。 */
export function formatReport({ host, version, at, judged, entries, exitCode, timedOut }) {
  return [
    `### 14.2 標準入出力の端末判定: ${host}（${version ?? "版不明"}・${at}）`,
    "",
    `記録の件数: ${entries}、終了コード: ${exitCode}${timedOut ? "（タイムアウト）" : ""}`,
    "",
    "| 項目 | 判定 | 観測の内容 |",
    "|---|---|---|",
    `| 直接の実行（Bash・パイプ）で標準入出力が端末として渡されない | ${judged.direct.state} | ${judged.direct.detail} |`,
    `| script 経由の実行で標準入出力が端末に見える（確認の限界） | ${judged.pty.state} | ${judged.pty.detail} |`,
    `| ホストの実行（終了コードとタイムアウト） | ${judged.host.state} | ${judged.host.detail} |`,
    `| 記録の解析（構文エラー・形式の不正な行の有無） | ${judged.record.state} | ${judged.record.detail} |`,
    "",
    `総合: ${judged.verdict}`,
  ].join("\n");
}

/** 呼び出しの計画（ホストを呼ばない）。 */
export function planOf(host) {
  return {
    host,
    calls: 1,
    items: [
      { id: "T1", title: "直接の実行で標準入出力が端末として渡されない", expect: "記録の direct の標準入力・標準出力が undefined または false" },
      { id: "T2", title: "script 経由の実行で標準入出力が端末に見える（確認の限界）", expect: "記録の pty の標準入力・標準出力が true" },
    ],
  };
}

/** 記録用スクリプトを 2 回実行させる指示（Claude・Codex で同じ文面）。 */
export const promptOf = (probe) => [
  "次の 2 つのコマンドを、この順に 1 回ずつ Bash で実行してください。コマンドを書き換えたり、別の方法で代用したりしないでください。",
  "git の操作やファイルの編集はしないでください。",
  `1. \`node "${probe}" direct\``,
  `2. \`script -qc 'node "${probe}" pty' /dev/null\``,
  "3. 終わったら、結果を一言だけ答えて終了する。",
].join("\n");

/** ホストの呼び出し（コマンド名と引数）。信頼のバイパス・CODEX_HOME は使わない（フックを使わない）。 */
export function hostCommand(host, { dir, probe }) {
  const prompt = promptOf(probe);
  if (host === "claude") {
    return { bin: "claude", args: ["-p", prompt, "--setting-sources", "project", "--permission-mode", "acceptEdits", "--allowedTools", "Bash", "--max-turns", "6", "--no-session-persistence"] };
  }
  return {
    bin: "codex",
    args: ["exec", "-C", dir, "-s", "workspace-write", "--skip-git-repo-check", "-c", 'model_reasoning_effort="low"', prompt],
  };
}

/** 作業場所を作る（リポジトリには作らない）。記録用スクリプトを置き、記録ファイルの場所を返す。 */
export function setupDir(dir) {
  mkdirSync(dir, { recursive: true });
  const log = join(dir, "tty.jsonl");
  const probe = join(dir, "probe.mjs");
  writeFileSync(probe, probeScriptOf(log));
  return { dir, probe, log };
}

/** 呼び出し 1 回分を数える。上限に達していれば false。 */
function takeCall(host) {
  const c = existsSync(COUNTER) ? JSON.parse(readFileSync(COUNTER, "utf8")) : { claude: 0, codex: 0 };
  if ((c[host] ?? 0) >= LIMITS[host]) return false;
  c[host] = (c[host] ?? 0) + 1;
  mkdirSync(join(WORK_DIR, "events"), { recursive: true });
  writeFileSync(COUNTER, JSON.stringify(c));
  return true;
}

const readCounter = () => (existsSync(COUNTER) ? JSON.parse(readFileSync(COUNTER, "utf8")) : { claude: 0, codex: 0 });

function versionOf(host) {
  const r = spawnSync(binOf(host), ["--version"], { encoding: "utf8", timeout: 30000 });
  if (r.error || r.status !== 0) return "版不明";
  return (r.stdout ?? "").trim().split("\n")[0] || "版不明";
}

/** 1 ホストの観測。1 回だけ呼び出し、記録を判定する。 */
function observeHost(host) {
  if (!takeCall(host)) {
    return { host, ok: false, text: `${host} の呼び出し回数が上限（${LIMITS[host]}）に達したため、呼び出しませんでした。` };
  }
  const version = versionOf(host);
  mkdirSync(OUT_ROOT, { recursive: true });
  const base = mkdtempSync(join(OUT_ROOT, `${host}-`));
  const fx = setupDir(base);
  const { bin, args } = hostCommand(host, { dir: fx.dir, probe: fx.probe });
  const env = launchEnvOf(host, { base, dir: fx.dir });
  let r;
  try {
    r = spawnSync(bin, args, { cwd: fx.dir, env, input: "", encoding: "utf8", timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  } finally {
    // 認証のコピーを残さない（Codex の一時の CODEX_HOME を実行の後に消す）
    if (host === "codex") cleanupCodexHome(env.CODEX_HOME);
  }
  writeFileSync(join(base, "host.out"), r.stdout ?? "");
  writeFileSync(join(base, "host.err"), r.stderr ?? "");
  const parsed = existsSync(fx.log) ? parseTtyLogDetailed(readFileSync(fx.log, "utf8")) : { entries: [], broken: 0 };
  const timedOut = r.error?.code === "ETIMEDOUT";
  const judged = judgeTty(parsed.entries, { exitCode: r.status ?? -1, timedOut, broken: parsed.broken });
  const text = formatReport({ host, version, at: new Date().toISOString(), judged, entries: parsed.entries.length, exitCode: r.status ?? -1, timedOut });
  return { host, ok: judged.verdict === "一致", text, dir: base };
}

function main() {
  requireRealEnv("tty-observe.mjs");
  const args = parseArgs(process.argv.slice(2));
  if (args.error) { console.error(args.error); console.error(USAGE); process.exit(2); }
  if (args.help) { console.log(USAGE); process.exit(0); }
  const hosts = args.host === "both" ? ["claude", "codex"] : [args.host];
  if (args.dryRun) {
    console.log("== 14.2 標準入出力の端末判定の計画（ホストは呼びません） ==");
    for (const h of hosts) {
      const p = planOf(h);
      console.log(`${h}: ${p.calls} 回の呼び出し（${binOf(h)}）`);
      for (const it of p.items) console.log(`  - ${it.id} ${it.title}: 想定 ${it.expect}`);
    }
    process.exit(0);
  }
  let allOk = true;
  for (const h of hosts) {
    const r = observeHost(h);
    console.log(`\n${r.text}`);
    if (r.dir) console.log(`生の出力: ${r.dir}`);
    if (!r.ok) allOk = false;
  }
  const c = readCounter();
  console.log(`\n呼び出し回数: claude ${c.claude ?? 0}/${LIMITS.claude}、codex ${c.codex ?? 0}/${LIMITS.codex}`);
  process.exit(allOk ? 0 : 1); // r.ok は総合が「一致」のときだけ真（exitCodeOf と同じ規則）
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
