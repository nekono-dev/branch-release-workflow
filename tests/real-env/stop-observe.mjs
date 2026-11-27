#!/usr/bin/env node
// 14.1: 応答の終了（Stop）の block と再入（stop_hook_active）、worktree へ移った後の作業ディレクトリを、実ホストで観測する。
// 使い方: BRW_REAL_ENV=1 node tests/real-env/stop-observe.mjs [--host claude|codex|both] [--dry-run]
//   ホストごとに 1 回だけ実際に呼び出す。呼び出し回数は host-events.mjs と同じ共有カウンタ（events/calls.json）で数え、上限に達したら止まる。
//   --dry-run は呼び出しも作業場所の作成もせず、計画だけを表示する。
//   BRW（scripts/）には依存しない。記録用の Stop フックだけを使う。結果は標準出力に出し、リポジトリには残さない。
//   想定と異なる結果は「不一致」と書き、成功扱いにしない。記録が無いときは「未観測」と書く。
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WORK_DIR, requireRealEnv } from "./common.mjs";

// host-events.mjs と同じ共有の呼び出し回数（上限は既存の基盤の決まり）
const LIMITS = { claude: 12, codex: 14 };
const COUNTER = join(WORK_DIR, "events", "calls.json");
const OUT_ROOT = join(WORK_DIR, "stop-observe");
const TIMEOUT_MS = 240000;
const REASON = "未コミットの変更があります。commit はせず、未コミットであることだけを報告して終了してください。";
const GIT = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];
const USAGE = "使い方: BRW_REAL_ENV=1 node tests/real-env/stop-observe.mjs [--host claude|codex|both] [--dry-run]";

const git = (cwd, ...a) => execFileSync("git", [...GIT, ...a], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
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
 * 記録用の Stop フックの本体（Node の ESM）。入力と判定を LOG に 1 行ずつ追記し、
 * 未コミットの変更があり stop_hook_active が偽のときだけ block を返す。本文（last_assistant_message 等）は記録しない。
 */
export function hookScriptOf(logFile, host) {
  return [
    'import { appendFileSync } from "node:fs";',
    'import { execFileSync } from "node:child_process";',
    `const LOG = ${JSON.stringify(logFile)};`,
    `const HOST = ${JSON.stringify(host)};`,
    'let text = "";',
    "for await (const c of process.stdin) text += c;",
    "const ev = JSON.parse(text);",
    "let dirty = false;",
    "let dirtyCwd = false;",
    "let scanned = 0;",
    "let note = null;",
    "const statusOf = (dir) => execFileSync(\"git\", [\"status\", \"--porcelain\", \"--untracked-files=normal\"], { cwd: dir, encoding: \"utf8\" }).trim() !== \"\";",
    "try {",
    "  dirtyCwd = statusOf(ev.cwd);",
    '  const paths = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: ev.cwd, encoding: "utf8" }).split("\\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9));',
    "  scanned = paths.length;",
    "  dirty = paths.some(statusOf);",
    "} catch {",
    '  note = "git-status-failed";',
    "}",
    "const active = ev.stop_hook_active === true;",
    "const block = !active && dirty;",
    'appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), host: HOST, event: ev.hook_event_name ?? null, session_id: ev.session_id ?? null, cwd: ev.cwd ?? null, stop_hook_active: active, dirty, dirtyCwd, scanned, block, note }) + "\\n");',
    `if (block) process.stdout.write(JSON.stringify({ decision: "block", reason: ${JSON.stringify(REASON)} }));`,
    "",
  ].join("\n");
}

// 記録用フック（hookScriptOf）が書く値の範囲。生成側の契約に合わせる。
const STOP_HOSTS = ["claude", "codex"];
const STOP_NOTES = [null, "git-status-failed"];

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
 * 判定に使う stop_hook_active・block は必須の真偽値。cwd・event・session_id は文字列または null（キーは必須）。
 * dirty・dirtyCwd は真偽値、scanned は 0 以上の整数、note は null または "git-status-failed"、host は claude・codex。
 * 未知の追加項目と日時の書式は厳密に見ない。
 */
export function invalidStopRecord(rec) {
  if (rec === null || typeof rec !== "object" || Array.isArray(rec)) return "記録がオブジェクトではない";
  if (typeof rec.at !== "string" || rec.at === "") return "at が空でない文字列ではない";
  if (!STOP_HOSTS.includes(rec.host)) return `host が claude・codex のいずれでもない（${describeValue(rec.host)}）`;
  for (const k of ["event", "session_id", "cwd"]) {
    if (!(rec[k] === null || typeof rec[k] === "string")) return `${k} が文字列または null ではない（${describeValue(rec[k])}）`;
  }
  for (const k of ["stop_hook_active", "dirty", "dirtyCwd", "block"]) {
    if (typeof rec[k] !== "boolean") return `${k} が真偽値ではない（${describeValue(rec[k])}）`;
  }
  if (!(Number.isInteger(rec.scanned) && rec.scanned >= 0)) return `scanned が 0 以上の整数ではない（${describeValue(rec.scanned)}）`;
  if (!STOP_NOTES.includes(rec.note)) return `note が null・git-status-failed のいずれでもない（${describeValue(rec.note)}）`;
  return null;
}

/**
 * 記録（JSON Lines）を読む。構文エラーの行と、形式の不正な行は entries に入れず、件数（broken）として返す（空行は数えない）。
 * 判定には、ここで検証した entries と broken を一緒に渡す。
 */
export function parseStopLogDetailed(text) {
  const entries = [];
  let broken = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { broken += 1; continue; }
    if (invalidStopRecord(rec) !== null) { broken += 1; continue; }
    entries.push(rec);
  }
  return { entries, broken };
}

/** 記録の行だけを読む（判定には使わない。判定は parseStopLogDetailed の件数を judgeStops に渡す）。 */
export const parseStopLog = (text) => parseStopLogDetailed(text).entries;

const match = (detail) => ({ state: "一致", detail });
const mismatch = (detail) => ({ state: "不一致", detail });
const unobserved = (detail) => ({ state: "未観測", detail });

/**
 * 記録から 2 つの項目を判定する。
 *   blockThenPass: 1 回目の Stop が block され、stop_hook_active:true の再入は block されずに通る
 *   cwdFollowsWorktree: すべての Stop の作業ディレクトリが worktree（実パス）と一致する
 * verdict は、どちらも一致なら「一致」、どれかが不一致なら「不一致」、それ以外（記録不足）は「未観測」。
 */
export function judgeStops(entries, { worktree, broken = 0 } = {}) {
  if (entries.length === 0) {
    return { blockThenPass: unobserved("Stop の記録が無い"), cwdFollowsWorktree: unobserved("Stop の記録が無い"), record: recordOf(broken), verdict: "未観測" };
  }
  const first = entries[0];
  let a;
  if (!(first.stop_hook_active === false && first.block === true)) {
    a = mismatch(`1 回目の Stop が block されなかった（stop_hook_active=${first.stop_hook_active}, block=${first.block}, dirty=${first.dirty}）`);
  } else {
    const again = entries.slice(1).find((e) => e.stop_hook_active === true);
    if (!again) a = unobserved("再入（stop_hook_active:true）の Stop が記録されていない");
    else if (again.block === true) a = mismatch("再入（stop_hook_active:true）の Stop でまた block された");
    else a = match("1 回目は block され、再入（stop_hook_active:true）は block されずに通った");
  }
  // Stop の cwd が worktree に追従するかは情報として記録する。検出は全 worktree の走査で行うため、追従しなくても合否に含めない。
  const W = real(worktree);
  const wrong = entries.find((e) => typeof e.cwd !== "string" || real(e.cwd) !== W);
  const b = wrong
    ? { state: "情報", detail: `Stop の作業ディレクトリは worktree ではなかった（${wrong.cwd ?? "なし"}）。全 worktree の走査で検出する` }
    : { state: "情報", detail: "Stop の作業ディレクトリは worktree に追従した" };
  const record = recordOf(broken);
  // 解析できない行が 1 件でもあれば、記録が揃っていても一致にしない（不一致は優先する）
  const verdict = a.state === "不一致" ? "不一致" : record.state === "未観測" ? "未観測" : a.state;
  return { blockThenPass: a, cwdFollowsWorktree: b, record, verdict };
}

/** 記録の解析の項目: 構文エラー・形式の不正な行が無いことを確かめる。 */
const recordOf = (broken) => (broken > 0 ? unobserved(`記録の解析できない行（構文エラー・形式の不正）が ${broken} 件あるため、一致としない`) : match("記録の行はすべて解析でき、形式も正しかった"));

/** 既存の README「観測結果の要約」に追記できる、ホスト・版・日時つきの Markdown を作る。 */
export function formatReport({ host, version, at, judged, entries, exitCode, timedOut }) {
  return [
    `### 14.1 Stop の観測: ${host}（${version ?? "版不明"}・${at}）`,
    "",
    `記録の件数: ${entries}、終了コード: ${exitCode}${timedOut ? "（タイムアウト）" : ""}`,
    "",
    "| 項目 | 判定 | 観測の内容 |",
    "|---|---|---|",
    `| 全 worktree の走査で未コミットを検出して 1 回止め、再入（stop_hook_active:true）で通る | ${judged.blockThenPass.state} | ${judged.blockThenPass.detail} |`,
    `| worktree へ移った後の Stop の作業ディレクトリ（情報） | ${judged.cwdFollowsWorktree.state} | ${judged.cwdFollowsWorktree.detail} |`,
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
      { id: "S1a", title: "全 worktree の走査で未コミットを検出して 1 回止め、再入（stop_hook_active:true）で通る", expect: "1 回目の Stop は（Stop の cwd にかかわらず）いずれかの worktree の未コミットの変更で block、2 回目は stop_hook_active:true で block されない" },
      { id: "S1b", title: "worktree へ移った後の Stop の作業ディレクトリ（情報）", expect: "worktree に追従するか、起動時の本体のままかを記録する（合否に含めない）" },
    ],
  };
}

/** worktree へ移って新規ファイルを作る依頼（Claude・Codex で同じ文面）。 */
export const promptOf = (worktree) => [
  "次の作業をしてください。git の操作（add・commit を含む）はしないでください。",
  `1. 別の Bash 呼び出しで \`cd ${worktree}\` を実行する。`,
  "2. その後の Bash 呼び出しで `echo hi > new.txt` を実行する。",
  "3. 終わったら、結果を一言だけ答えて終了する。",
].join("\n");

/** ホストの呼び出し（コマンド名と引数）。Claude は project の設定だけ、Codex はこの 1 回だけフックの信頼を省く。 */
export function hostCommand(host, { main, worktree }) {
  const prompt = promptOf(worktree);
  if (host === "claude") {
    return { bin: "claude", args: ["-p", prompt, "--setting-sources", "project", "--permission-mode", "acceptEdits", "--allowedTools", "Bash", "--max-turns", "8", "--no-session-persistence"] };
  }
  return {
    bin: "codex",
    args: [
      "exec", "-C", main, "-s", "workspace-write", "--skip-git-repo-check",
      "-c", 'model_reasoning_effort="low"',
      "--dangerously-bypass-hook-trust",
      prompt,
    ],
  };
}

/**
 * Codex 用の一時の CODEX_HOME を作る。プロジェクト（本体）の信頼を config.toml に書き、認証ファイルは
 * 利用者の ~/.codex/auth.json を一時の場所へ「コピー」する（リンクにしない。Codex が書き込んでも利用者のファイルは変わらない）。
 * コピーの権限は 0600、一時の CODEX_HOME は 0700。利用者の ~/.codex は書き換えない。
 * auth.json が無ければ auth は null（呼び出し側が未観測として扱う）。実行の後は cleanupCodexHome で必ず消す。
 */
export function prepareCodexHome(base, main, userHome = join(homedir(), ".codex")) {
  const home = join(base, "codex-home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  writeFileSync(join(home, "config.toml"), `[projects."${main}"]\ntrust_level = "trusted"\n`);
  const source = join(userHome, "auth.json");
  let auth = null;
  if (existsSync(source)) {
    auth = join(home, "auth.json");
    copyFileSync(source, auth);
    chmodSync(auth, 0o600);
  }
  return { home, auth };
}

/** 一時の CODEX_HOME を消す（認証のコピーを残さない）。null・存在しないパスでもよい。 */
export function cleanupCodexHome(home) {
  if (home) rmSync(home, { recursive: true, force: true });
}

/**
 * 作業場所を作る（作業の記録・状態ファイルは作らない）。
 * 本体には記録用フックの登録を置くが、追跡せず info/exclude で除外する（本体の作業ツリーを clean に保つ）。
 * worktree は PoC と同じく本体の .claude/worktrees/wt に作る。戻り値: { main, worktree, hook, log }
 */
export function setupRepos(base, host) {
  const main = join(base, "main");
  const worktree = join(main, ".claude", "worktrees", "wt");
  const hook = join(base, `hook-${host}.mjs`);
  const log = join(base, `stop-${host}.jsonl`);
  const registration = host === "claude" ? join(".claude", "settings.json") : join(".codex", "hooks.json");
  mkdirSync(main, { recursive: true });
  git(main, "init", "-q", "-b", "main");
  writeFileSync(hook, hookScriptOf(log, host));
  writeFileSync(join(main, "a.txt"), "a\n");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "初期");
  writeFileSync(join(main, ".git", "info", "exclude"), "/.claude/\n/.codex/\n", { flag: "a" });
  mkdirSync(dirname(join(main, registration)), { recursive: true });
  writeFileSync(join(main, registration), `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: `node ${hook}` }] }] } }, null, 2)}\n`);
  git(main, "worktree", "add", "-q", "-b", "dev/stop-observe", worktree);
  return { main, worktree, hook, log };
}

const readCounter = () => (existsSync(COUNTER) ? JSON.parse(readFileSync(COUNTER, "utf8")) : { claude: 0, codex: 0 });

/** 呼び出し 1 回分を数える。上限に達していれば false。 */
function takeCall(host) {
  const c = readCounter();
  if ((c[host] ?? 0) >= LIMITS[host]) return false;
  c[host] = (c[host] ?? 0) + 1;
  mkdirSync(dirname(COUNTER), { recursive: true });
  writeFileSync(COUNTER, JSON.stringify(c));
  return true;
}

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
  const fx = setupRepos(base, host);
  const { bin, args } = hostCommand(host, { main: fx.main, worktree: fx.worktree });
  const env = host === "codex" ? { ...process.env, CODEX_HOME: prepareCodexHome(base, fx.main).home } : process.env;
  let r;
  try {
    r = spawnSync(bin, args, { cwd: fx.main, env, input: "", encoding: "utf8", timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  } finally {
    // 認証のコピーを残さない（Codex の一時の CODEX_HOME を実行の後に消す）
    if (host === "codex") cleanupCodexHome(env.CODEX_HOME);
  }
  writeFileSync(join(base, "host.out"), r.stdout ?? "");
  writeFileSync(join(base, "host.err"), r.stderr ?? "");
  const parsed = existsSync(fx.log) ? parseStopLogDetailed(readFileSync(fx.log, "utf8")) : { entries: [], broken: 0 };
  const judged = judgeStops(parsed.entries, { worktree: fx.worktree, broken: parsed.broken });
  const timedOut = r.error?.code === "ETIMEDOUT";
  const text = formatReport({ host, version, at: new Date().toISOString(), judged, entries: parsed.entries.length, exitCode: r.status ?? -1, timedOut });
  return { host, ok: judged.verdict === "一致", text, dir: base };
}

function main() {
  requireRealEnv("stop-observe.mjs");
  const args = parseArgs(process.argv.slice(2));
  if (args.error) { console.error(args.error); console.error(USAGE); process.exit(2); }
  if (args.help) { console.log(USAGE); process.exit(0); }
  const hosts = args.host === "both" ? ["claude", "codex"] : [args.host];
  if (args.dryRun) {
    console.log("== 14.1 Stop の観測の計画（ホストは呼びません） ==");
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
  process.exit(allOk ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
