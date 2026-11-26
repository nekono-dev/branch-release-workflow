#!/usr/bin/env node
// フックの登録と導入状態の検査（brw-enforcement 6.3）。
// Claude は同梱の hooks/hooks.json を検査する（登録はプラグインの更新で行う）。Codex はプロジェクトの .codex/hooks.json へ、
// 既存の定義を保ったままマージする。絶対パスのランチャーを埋め込み、同じ登録の再実行は変更なしで終える。
// 信頼（Codex が定義を実行する承認）は製品の確認に任せる。ここでは「信頼待ち」を報告し、承認を代行しない。
// 結果の reasonCode（機械判別用）と managedHooksRequired（管理対象フックが前提の実行環境か）は 6.4 の診断へ渡す。
// 外部依存なし（Node 標準ライブラリのみ）。
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** Codex で登録するイベントと matcher。Stop は matcher を持たない。 */
export const CODEX_HOOKS = [
  { event: "PreToolUse", matcher: "Bash" },
  { event: "PreToolUse", matcher: "mcp__.*" },
  { event: "PermissionRequest", matcher: "Bash" },
  { event: "PermissionRequest", matcher: "mcp__.*" },
  { event: "PostToolUse", matcher: "Bash" },
  { event: "Stop", matcher: null },
];

/** Claude プラグインの hooks/hooks.json に必要な登録（プラグインのイベントを agent-hooks.mjs へ渡す）。 */
const CLAUDE_HOOKS = [
  { event: "PreToolUse", matcher: "Bash" },
  { event: "PreToolUse", matcher: "EnterWorktree" },
  { event: "PreToolUse", matcher: "mcp__.*" },
  { event: "PostToolUse", matcher: "Bash" },
  { event: "Stop", matcher: null },
];

// 自分の定義: コマンド全体が `node '<絶対パス>/scripts/agent-hooks.mjs' codex <イベント>` の形に一致するものだけ。
// 前後に別の語があるもの（利用者の類似コマンド）は自分の定義とみなさない。
const MANAGED_RE = /^node '(\/(?:[^']|'\\'')*\/scripts\/agent-hooks\.mjs)' codex (PreToolUse|PermissionRequest|PostToolUse|Stop)$/;
// 旧 brw.mjs hook の定義（`node <パス>/brw.mjs hook` の全体一致）
const LEGACY_RE = /^node (?:'(?:[^']|'\\'')*\/brw\.mjs'|"[^"]*\/brw\.mjs"|[^\s'"]*\/brw\.mjs) hook$/;
const CLAUDE_CMD_RE = (event) => new RegExp(`^node "\\$\\{CLAUDE_PLUGIN_ROOT\\}/scripts/agent-hooks\\.mjs" claude ${event}$`);
const CLAUDE_LEGACY_RE = /^node "[^"]*brw\.mjs" hook$/;

/** シェルの 1 語として埋め込む（空白・引用符を含む絶対パスに備える）。 */
const shQuote = (s) => `'${s.replace(/'/g, "'\\''")}'`;

/** Codex の 1 件のコマンド。 */
export const codexCommand = (launcherPath, event) => `node ${shQuote(launcherPath)} codex ${event}`;

/** 自分の定義のイベント名。自分の定義でなければ null。 */
const managedEvent = (command) => {
  const m = MANAGED_RE.exec(command);
  return m ? m[2] : null;
};

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const groupMatcher = (g) => (g?.matcher === undefined ? null : g.matcher);
const commandsOf = (g) => (Array.isArray(g?.hooks) ? g.hooks.map((h) => h?.command).filter((c) => typeof c === "string") : []);

/**
 * 既存の hooks.json の形を確かめる。想定と違えば理由を返す（例外にしない）。
 * 想定: 最上位はオブジェクト・hooks はオブジェクト・各イベントは配列・各定義はオブジェクトで matcher は無い・文字列・null のどれか・hooks は配列・その要素はオブジェクト。
 */
function shapeError(doc) {
  if (!isObj(doc)) return "設定の形が想定と違います";
  if (doc.hooks !== undefined && !isObj(doc.hooks)) return "hooks の形が想定と違います";
  for (const [event, gs] of Object.entries(doc.hooks ?? {})) {
    if (!Array.isArray(gs)) return `${event} の形が想定と違います`;
    for (const g of gs) {
      const matcherOk = g !== null && typeof g === "object" && (g.matcher === undefined || g.matcher === null || typeof g.matcher === "string");
      if (!matcherOk || !Array.isArray(g.hooks)) return `${event} の定義の形が想定と違います`;
      for (const h of g.hooks) {
        if (!isObj(h) || (h.command !== undefined && typeof h.command !== "string")) return `${event} の定義の形が想定と違います`;
      }
    }
  }
  return null;
}

/** Git コマンドを実行し、出力の 1 行目を返す。失敗・Git の外なら null。 */
const gitLine = (dir, ...args) => {
  try {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
};

/**
 * 登録元を特定する。linked worktree では親チェックアウトを登録元にする（Codex は親のディレクトリのフックを読むため）。
 * 親は共通ディレクトリが `<本体>/.git` の形のときだけ決められる。bare・separate-git-dir・サブモジュールは決められず、source は null。
 * 戻り値: { source（登録元のディレクトリ、決められなければ null）, linked, git, worktree（この作業ディレクトリ）, reasonCode（決められないときだけ） }
 */
export function registrationSourceOf(dir) {
  const top = gitLine(dir, "rev-parse", "--show-toplevel");
  if (!top) return { source: realpathSync(dir), linked: false, git: false };
  const common = gitLine(dir, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const gitDir = gitLine(dir, "rev-parse", "--path-format=absolute", "--git-dir");
  const worktree = realpathSync(top);
  const linked = !!common && !!gitDir && realpathSync(common) !== realpathSync(gitDir);
  if (!linked) return { source: worktree, linked: false, git: true, worktree };
  if (basename(realpathSync(common)) !== ".git") return { source: null, linked: true, git: true, worktree, reasonCode: "unknown-common-dir" };
  return { source: dirname(realpathSync(common)), linked: true, git: true, worktree };
}

/**
 * linked worktree で Codex に親チェックアウトの .codex/hooks.json を読ませるための有効化（Codex 0.167 を 8.4 で実機確認）。
 * Codex は linked worktree で、親チェックアウトの `.codex/hooks.json` を読む。ただし worktree 自身に `.codex/` ディレクトリがあるときだけで
 * （空でもよい）、worktree 側の hooks.json の中身は読まれない。無ければ親が登録済みでもフックは 1 件も届かない。
 * 空のディレクトリは git clean などで消えるため、説明の置き場所となる印のファイルも置き、共通の info/exclude で未追跡の表示から外す。
 * 失敗しても導入は止めない（戻り値 false）。
 */
export function activateWorktree(worktree) {
  try {
    const dir = join(worktree, ".codex");
    if (lstatOrNull(dir) && !lstatOrNull(dir).isDirectory()) return false;
    mkdirSync(dir, { recursive: true });
    const mark = join(dir, ".brw-worktree");
    if (!existsSync(mark)) writeFileSync(mark, "Codex は linked worktree に .codex/ があるときだけ、親チェックアウトの .codex/hooks.json を読みます。この印は BRW が置きました。\n");
    const rel = gitLine(worktree, "rev-parse", "--git-path", "info/exclude");
    if (rel) {
      const file = resolve(worktree, rel);
      const cur = existsSync(file) ? readFileSync(file, "utf8") : "";
      if (!cur.split("\n").some((l) => l.trim() === ".codex/" || l.trim() === "/.codex/")) {
        mkdirSync(dirname(file), { recursive: true });
        appendFileSync(file, `${cur === "" || cur.endsWith("\n") ? "" : "\n"}.codex/\n`);
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** 設定の文字列で [features] の hooks（旧キー codex_hooks）が偽か。 */
export const hooksDisabled = (text) => {
  let section = "";
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim();
    const sec = /^\[([^\]]+)\]$/.exec(line);
    if (sec) { section = sec[1].trim(); continue; }
    if (section === "features" && /^(hooks|codex_hooks)\s*=\s*false\b/.test(line)) return true;
  }
  return false;
};

/** 自分の定義（agent-hooks.mjs の codex 呼び出し）を含むか。 */
export const hasManaged = (doc) => isObj(doc?.hooks) && Object.values(doc.hooks).some((gs) => Array.isArray(gs) && gs.some((g) => commandsOf(g).some((c) => managedEvent(c) !== null)));

/**
 * 現在の hooks.json の内容に、必要な登録をマージする（純粋な変換。ファイルは読み書きしない）。
 * 戻り値: { doc（マージ後）, changes（追加・置換）, conflicts（同じ matcher の別定義・旧フック）, blocked（書き換えてはならない理由。無ければ null）, reasonCode }
 */
export function mergeCodexHooks(current, launcherPath) {
  const none = (blocked, reasonCode, conflicts = []) => ({ doc: current, changes: [], conflicts, blocked, reasonCode });
  const shape = shapeError(current);
  if (shape) return none(shape, "shape-mismatch");
  const hooks = current.hooks ?? {};
  // 旧 brw.mjs hook が残っていれば二重判定になるため、書き換えず報告する
  const legacy = [];
  for (const [event, gs] of Object.entries(hooks)) {
    for (const g of gs) for (const c of commandsOf(g)) if (LEGACY_RE.test(c)) legacy.push({ event, matcher: groupMatcher(g), kind: "legacy-brw-hook", command: c });
  }
  if (legacy.length) return none("旧 brw.mjs hook が登録されています。先に削除してから再実行してください。", "legacy-brw-hook", legacy);

  const doc = structuredClone(current);
  doc.hooks ??= {};
  const changes = [];
  const conflicts = [];
  for (const want of CODEX_HOOKS) {
    const cmd = codexCommand(launcherPath, want.event);
    doc.hooks[want.event] ??= [];
    const list = doc.hooks[want.event];
    let found = false;
    for (const g of list) {
      if (groupMatcher(g) !== want.matcher) continue;
      for (const h of g.hooks) {
        if (typeof h.command !== "string" || managedEvent(h.command) !== want.event) continue;
        found = true;
        if (h.command !== cmd) {
          // 古い絶対パスの自分の定義は、同じ場所で置き換える（重複させない）
          h.command = cmd;
          changes.push({ action: "update", event: want.event, matcher: want.matcher });
        }
      }
    }
    if (found) continue;
    const others = list.filter((g) => groupMatcher(g) === want.matcher).flatMap(commandsOf);
    if (others.length) conflicts.push({ event: want.event, matcher: want.matcher, kind: "shared-matcher", existing: others });
    const group = want.matcher === null ? {} : { matcher: want.matcher };
    list.push({ ...group, hooks: [{ type: "command", command: cmd }] });
    changes.push({ action: "add", event: want.event, matcher: want.matcher });
  }
  return { doc, changes, conflicts, blocked: null, reasonCode: null };
}

const lstatOrNull = (p) => {
  try { return lstatSync(p); } catch { return null; }
};

/**
 * 一時ファイルに書いてから置換する（途中で壊れた内容を残さない）。既存ファイルのモードは引き継ぐ。
 * 失敗したら一時ファイルを消す。
 */
const writeAtomic = (file, text, mode) => {
  const tmp = join(dirname(file), `.hooks.json.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, text, { mode: mode ?? 0o666, flag: "wx" });
    if (mode !== null) chmodSync(tmp, mode);
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
};

/**
 * Codex のフック導入。結果オブジェクト:
 *   status: registered（登録済み・変更なし）| untrusted（今回登録・変更した。Codex の承認まで読み込まれない）| unsupported（実行環境・設定で使えない）| conflict（書き換えず報告）
 *   trust: unknown（登録済みだが信頼は未確認。6.4 で診断）| review-required（承認が必要）| null
 *   reasonCode: 理由の機械判別用（registered・untrusted は null）。unsupported は command-hooks-unavailable・hooks-disabled、
 *               conflict は duplicate-worktree・unreadable-json・not-a-file・symlink・shape-mismatch・legacy-brw-hook・unknown-common-dir
 *   managedHooksRequired: 管理対象フック（Global MCP など）が前提の実行環境か（コマンドフックが使えない場合のみ true）
 * 導入先は linked worktree では親チェックアウト（Codex は親の hooks.json を読む）。worktree には `.codex/` の有効化（activateWorktree）も行う。worktree 側に同じ定義があると二重になるため衝突にする。
 * opts.commandHooks: false なら、コマンドフックを使えない実行環境として扱う。opts.featuresText: 設定ファイルの文字列（[features] の判定に使う）。
 */
export function installCodexHooks({ repoDir, launcherPath, commandHooks = true, featuresText = "" }) {
  const src = registrationSourceOf(repoDir);
  const file = src.source === null ? null : join(src.source, ".codex", "hooks.json");
  const base = { host: "codex", source: src.source, linked: src.linked, file, managedHooksRequired: false };
  const result = (status, trust, reasonCode, extra = {}) => ({ ...base, status, trust, reasonCode, reason: null, changes: [], conflicts: [], ...extra });
  const refuse = (reasonCode, reason, extra = {}) => ({ ...result("conflict", null, reasonCode, extra), reason });

  if (!commandHooks) return { ...result("unsupported", null, "command-hooks-unavailable"), managedHooksRequired: true, reason: "コマンドフックを使えない実行環境です。" };
  if (hooksDisabled(featuresText)) return { ...result("unsupported", null, "hooks-disabled"), reason: "設定の [features] で hooks が無効です。" };
  if (src.source === null) return refuse("unknown-common-dir", "共通の Git ディレクトリ名が .git ではないため（bare・separate-git-dir・サブモジュールの可能性）、登録元を決められません。登録元の .codex/hooks.json を手で確認してください。");

  // シンボリックリンクは rename で実体との対応が崩れるため、書き換えず報告する
  if (lstatOrNull(join(src.source, ".codex"))?.isSymbolicLink()) return refuse("symlink", ".codex がシンボリックリンクのため書き換えません。");
  const fst = lstatOrNull(file);
  if (fst?.isSymbolicLink()) return refuse("symlink", ".codex/hooks.json がシンボリックリンクのため書き換えません。");
  if (fst && !fst.isFile()) return refuse("not-a-file", ".codex/hooks.json が通常のファイルではないため書き換えません。");

  // 作業ディレクトリ側に同じ定義があれば、親からの継承と二重になる
  const ownFile = src.linked ? join(src.worktree, ".codex", "hooks.json") : null;
  if (ownFile && existsSync(ownFile)) {
    let own = null;
    try { own = JSON.parse(readFileSync(ownFile, "utf8")); } catch { own = null; }
    if (hasManaged(own)) return refuse("duplicate-worktree", "作業ディレクトリの .codex/hooks.json に同じ定義があり、親からの継承と二重になります。", { conflicts: [{ kind: "duplicate-worktree", file: ownFile }] });
  }

  let current = {};
  let mode = null;
  if (fst) {
    try { current = JSON.parse(readFileSync(file, "utf8")); } catch { return refuse("unreadable-json", "既存の .codex/hooks.json を JSON として読めないため、書き換えません。"); }
    mode = statSync(file).mode & 0o777;
  }
  let m;
  try {
    m = mergeCodexHooks(current, launcherPath);
  } catch {
    return refuse("shape-mismatch", "既存の .codex/hooks.json の形が想定と違うため、書き換えません。");
  }
  if (m.blocked) return refuse(m.reasonCode, m.blocked, { conflicts: m.conflicts });
  if (m.changes.length === 0) return result("registered", "unknown", null, { conflicts: m.conflicts, ...(src.linked ? { worktreeActivated: activateWorktree(src.worktree) } : {}) });

  mkdirSync(dirname(file), { recursive: true });
  writeAtomic(file, `${JSON.stringify(m.doc, null, 2)}\n`, mode);
  return result("untrusted", "review-required", null, { changes: m.changes, conflicts: m.conflicts, ...(src.linked ? { worktreeActivated: activateWorktree(src.worktree) } : {}) });
}

/**
 * Claude プラグインの登録を検査する（hooks/hooks.json）。結果: status（registered・missing・conflict）、missing（不足の登録）、reasonCode。
 * 旧 brw.mjs hook が残るときは二重判定になるため conflict。
 */
export function checkClaudeHooks(pluginRoot) {
  const file = join(pluginRoot, "hooks", "hooks.json");
  const label = (h) => `${h.event}${h.matcher ? `(${h.matcher})` : ""}`;
  const base = { host: "claude", trust: "plugin", managedHooksRequired: false };
  if (!existsSync(file)) return { ...base, status: "missing", missing: CLAUDE_HOOKS.map(label), reasonCode: "not-installed" };
  let doc;
  try { doc = JSON.parse(readFileSync(file, "utf8")); } catch { return { ...base, status: "conflict", missing: [], reasonCode: "unreadable-json" }; }
  const all = [];
  for (const [event, gs] of Object.entries(isObj(doc?.hooks) ? doc.hooks : {})) {
    for (const g of Array.isArray(gs) ? gs : []) for (const c of commandsOf(g)) all.push({ event, matcher: groupMatcher(g), command: c });
  }
  if (all.some((x) => CLAUDE_LEGACY_RE.test(x.command))) return { ...base, status: "conflict", missing: [], reasonCode: "legacy-brw-hook" };
  const missing = CLAUDE_HOOKS.filter((h) => !all.some((x) => x.event === h.event && x.matcher === h.matcher && CLAUDE_CMD_RE(h.event).test(x.command))).map(label);
  return { ...base, status: missing.length ? "missing" : "registered", missing, reasonCode: missing.length ? "missing-registration" : null };
}

/**
 * 親チェックアウトに BRW の Codex 登録があるとき、新しい linked worktree でそれが読まれるよう有効化する（brw create・brw resume が呼ぶ）。
 * 登録とその信頼（/hooks の承認）は親チェックアウトの hooks.json に結び付き、worktree ごとの承認は要らない。
 * 親に登録が無い・親を決められなければ何もしない（status: "skipped"）。結果: { status: "activated" | "skipped" | "failed", parent }
 */
export function installWorktreeHooks({ parentDir, worktreeDir }) {
  let doc = null;
  try { doc = JSON.parse(readFileSync(join(parentDir, ".codex", "hooks.json"), "utf8")); } catch { doc = null; }
  if (!hasManaged(doc)) return { status: "skipped", parent: parentDir, reason: "親チェックアウトに BRW の Codex 登録がありません。" };
  return { status: activateWorktree(worktreeDir) ? "activated" : "failed", parent: parentDir };
}
