// 再開の記録（brw-pr-handoff 9.2）。公開して片付けた作業ブランチの続きを後から再開できるように、案内用の記録を読み書きする。
// 記録は <git 共通ディレクトリ>/brw/resume.json に置く（作業の記録 brw/work とは別。片付けの判定には使わない）。
// 記録の中身は後で案内文としてモデルへ渡るため、信頼できない入力として厳密に検証する。
// 検証に通らない項目の記録は読まず（捨て）、書き込みも拒否する。読めない記録は空として扱い、案内しない側に倒す。
// 書けなくても呼び出し側の結果は変えない（例外を投げず ok:false を返す）。外部依存なし。通信はしない。
// readRecords と resumableFor は読み取りだけで、記録も作業場所も変えない。
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { classifyBranch, git, loadConfig } from "./lib.mjs";
import { acquire, remoteNameOf } from "./publish.mjs";
import { mainWorktreeOf, worktreeList } from "./work-remainder.mjs";

const VERSION = 1;
// 記録の上限（先頭が最新）
export const MAX_RECORDS = 10;
// 記録ファイルの上限。これを超えるファイルは読まない
const MAX_FILE_BYTES = 256 * 1024;
// 続きの作業を案内する期間（書かれた時刻から）
const RESUME_WINDOW_MS = 24 * 60 * 60 * 1000;
// sessionId を後から付けてよい期間（書かれた時刻から）
const ATTACH_WINDOW_MS = 2 * 60 * 1000;
const LOCK_WAIT_MS = 3000;

// 値の長さの上限
const MAX_BRANCH = 255;
const MAX_URL = 2048;
const MAX_REPO = 200;
const MAX_SESSION = 200;

// 表示や案内文を乱す文字（制御・書式・空白・私用・未割り当て・代理）。\p 指定で書くため、ソースに生の文字は入らない
const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}\p{Co}\p{Cn}\p{Cs}]/u;
// ブランチ名として安全でない形（git check-ref-format の主な規則）
// 許可する文字（Unicode の文字・数字・. _ / -）だけ。シェルで特別な意味を持つ文字は、案内文に入ってもコピーして実行されないよう含めない
const BRANCH_CHARS = /^[\p{L}\p{N}._/-]+$/u;
// ブランチ名の git の規則（許可した文字の中での禁止形）: 先頭の - や .、..、.lock で終わる部分、// 、@{、末尾の / や .、/. 、@ だけ
const BRANCH_BAD = /^[\/.-]|[\/.]$|\.\.|\.lock(\/|$)|\/\/|@\{|\/\.|^@$/;
// リポジトリ名の形（owner/name。英数字と _ . - のみ）
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// UTC の ISO 8601（秒を含み、末尾は Z。ミリ秒は 0〜3 桁）
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

const isSafeBranch = (b) => typeof b === "string" && b.length > 0 && b.length <= MAX_BRANCH && BRANCH_CHARS.test(b) && !BRANCH_BAD.test(b) && !UNSAFE_CHARS.test(b);

// prUrl: null、または https の URL（資格情報なし・空白や制御文字・バッククォートなし・長さ上限つき）
const isSafeUrl = (u) => {
  if (u === null) return true;
  if (typeof u !== "string" || u.length === 0 || u.length > MAX_URL || UNSAFE_CHARS.test(u) || u.includes("`")) return false;
  try {
    const parsed = new URL(u);
    return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "";
  } catch {
    return false;
  }
};

const isSafeRepo = (r) => r === null || (typeof r === "string" && r.length <= MAX_REPO && REPO_RE.test(r));
const isSafeSession = (s) => s === null || (typeof s === "string" && s.length > 0 && s.length <= MAX_SESSION && !UNSAFE_CHARS.test(s));

// 日時を ms に直す。UTC の形でない、または暦日や時刻が補正される（2026-02-30 など）ものは NaN
const timeOf = (s) => {
  if (typeof s !== "string") return NaN;
  const m = ISO_RE.exec(s);
  if (!m) return NaN;
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return NaN;
  const canonical = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${(m[7] ?? "").padEnd(3, "0")}Z`;
  return new Date(ms).toISOString() === canonical ? ms : NaN;
};

// 記録 1 件を検証して正規化する。不正なら null。空文字・空白だけの sessionId は「無し」（null）として扱う
const normalizeEntry = (e) => {
  if (e === null || typeof e !== "object" || Array.isArray(e)) return null;
  const sessionId = typeof e.sessionId === "string" && e.sessionId.trim() === "" ? null : e.sessionId;
  const c = { branch: e.branch, prUrl: e.prUrl, repository: e.repository, sessionId, at: e.at };
  if (!isSafeBranch(c.branch) || !isSafeUrl(c.prUrl) || !isSafeRepo(c.repository) || !isSafeSession(c.sessionId) || !Number.isFinite(timeOf(c.at))) return null;
  return c;
};

const fail = (message) => ({ ok: false, message });

// 共通ディレクトリの brw と、その中の記録ファイルの場所。Git の外なら null
const pathsOf = (cwd) => {
  const common = git(cwd, "rev-parse", "--git-common-dir");
  if (!common) return null;
  const dir = join(resolve(cwd, common), "brw");
  return { dir, file: join(dir, "resume.json") };
};

// brw ディレクトリの状態。通常のディレクトリだけを使う（シンボリックリンク・ファイルは使わない）
const dirState = (dir) => {
  let st;
  try {
    st = lstatSync(dir);
  } catch (e) {
    return e.code === "ENOENT" ? "missing" : "unsafe";
  }
  return st.isDirectory() ? "ok" : "unsafe";
};

// 記録ファイルを読む。無い（missing）・読めない／形が違う／通常のファイルでない／大きすぎる（bad）・読めた（ok）を区別する
const readState = (dir, file) => {
  const d = dirState(dir);
  if (d === "missing") return { kind: "missing" };
  if (d !== "ok") return { kind: "bad" };
  let st;
  try {
    st = lstatSync(file);
  } catch (e) {
    return e.code === "ENOENT" ? { kind: "missing" } : { kind: "bad" };
  }
  if (!st.isFile() || st.size > MAX_FILE_BYTES) return { kind: "bad" };
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw) || raw.version !== VERSION || !Array.isArray(raw.entries)) return { kind: "bad" };
    return { kind: "ok", entries: raw.entries };
  } catch {
    return { kind: "bad" };
  }
};

// 一時ファイルへ書いてから置き換える。置き換え先が通常のファイル以外（リンク・ディレクトリ）なら書かない
const saveAtomic = (file, text) => {
  let st = null;
  try {
    st = lstatSync(file);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  if (st && !st.isFile()) throw new Error("記録ファイルが通常のファイルではないため、書きません");
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
};

// ロックを取って fn を実行する。取れなければ null。ロックのパスが通常のファイル以外なら取らない。取れたロックは必ず外す
const locked = (file, waitMs, fn) => {
  const lock = `${file}.lock`;
  let st = null;
  try {
    st = lstatSync(lock);
  } catch (e) {
    if (e.code !== "ENOENT") return null;
  }
  if (st && !st.isFile()) return null;
  if (!acquire(lock, waitMs)) return null;
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
};

// 記録の書き出し内容（version と entries の形）
const textOf = (entries) => `${JSON.stringify({ version: VERSION, entries }, null, 2)}\n`;

// 作業ブランチの追跡ブランチ（refs/remotes/<リモート>/<ブランチ>）があるか。ネットワークを使わない
const trackingExists = (main, branch) => {
  const remote = remoteNameOf(main, branch);
  return spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/remotes/${remote}/${branch}`], { cwd: main, stdio: "ignore" }).status === 0;
};

/**
 * 記録を読む。読めない・形が不正・version が違う・大きすぎる場合は空配列（案内しない側）。
 * 値の検証に通らない記録は捨てる。先頭が最新。
 * @returns {Array<{branch: string, prUrl: string|null, repository: string|null, sessionId: string|null, at: string}>}
 */
export function readRecords(main) {
  try {
    const p = pathsOf(main);
    if (!p) return [];
    const state = readState(p.dir, p.file);
    return state.kind === "ok" ? state.entries.map(normalizeEntry).filter(Boolean).slice(0, MAX_RECORDS) : [];
  } catch {
    return [];
  }
}

/**
 * 記録を 1 件書く。同じ branch の記録は置き換え、先頭が最新、最大 10 件。
 * 不正な入力・Git の外・保存先がリンクなど・ロックが取れない・書けないときは例外を投げず ok:false を返し、何も書かない。
 * @returns {{ok: true} | {ok: false, message: string}}
 */
export function writeRecord(main, entry, { lockWaitMs = LOCK_WAIT_MS } = {}) {
  try {
    const e = normalizeEntry(entry);
    if (!e) return fail("再開の記録の内容が不正です（作業ブランチ名・時刻・各項目の形と値の範囲を確かめてください）。");
    const p = pathsOf(main);
    if (!p) return fail("再開の記録の場所を決められません（Git のリポジトリの中で実行してください）。");
    const d = dirState(p.dir);
    if (d === "unsafe") return fail("再開の記録の保存先（brw）が通常のディレクトリではないため、書きません。");
    if (d === "missing") mkdirSync(p.dir, { mode: 0o700 });
    const written = locked(p.file, lockWaitMs, () => {
      const state = readState(p.dir, p.file);
      // 壊れた記録は読めないものとして、新しい記録で置き換える
      const base = state.kind === "ok" ? state.entries.map(normalizeEntry).filter(Boolean) : [];
      const next = [e, ...base.filter((x) => x.branch !== e.branch)].slice(0, MAX_RECORDS);
      saveAtomic(p.file, textOf(next));
      return true;
    });
    return written ? { ok: true } : fail("再開の記録を今は書けませんでした（ロック、またはファイルの状態を確かめてから、やり直してください）。");
  } catch (err) {
    return fail(`再開の記録を保存できません: ${err.code ?? err.message}`);
  }
}

/**
 * 続きの作業を案内できる記録の 1 件を返す。無ければ null。読み取りだけで、記録も作業場所も通信も変えない。
 * 条件: 同じセッション・書かれて 24 時間以内（未来は除く）・その作業ブランチの作業場所が無い・追跡ブランチがある・宣言が読めて開発ブランチ。
 * cwd は本体でも作業場所でもよい。Git の外や、読めない場合は null。
 */
export function resumableFor(cwd, sessionId, now) {
  try {
    if (typeof sessionId !== "string" || sessionId === "") return null;
    const nowMs = now instanceof Date ? now.getTime() : NaN;
    if (!Number.isFinite(nowMs)) return null;
    const main = mainWorktreeOf(cwd);
    if (!main) return null;
    const records = readRecords(main);
    if (records.length === 0) return null;
    const loaded = loadConfig(main);
    if (!loaded.config) return null;
    const list = worktreeList(cwd);
    if (!list) return null;
    // 作業場所（worktree）が今あるブランチ
    const checkedOut = new Set(list.map((w) => w.branch).filter(Boolean));
    // 記録は先頭が最新。条件を満たす最初の 1 件を返す
    for (const e of records) {
      if (e.sessionId === null || e.sessionId !== sessionId) continue;
      const diff = nowMs - timeOf(e.at);
      if (diff < 0 || diff > RESUME_WINDOW_MS) continue;
      if (checkedOut.has(e.branch)) continue;
      if (classifyBranch(loaded.config, e.branch) !== "development") continue;
      if (!trackingExists(main, e.branch)) continue;
      return e;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 直近 2 分以内に書かれ sessionId が null の記録のうち最新の 1 件に、sessionId を付けて保存する。
 * 対象が無ければ何も書かず {ok:true, attached:false}。保存するときは検証に通った記録だけを残す。
 * @returns {{ok: true, attached: boolean} | {ok: false, message: string}}
 */
export function attachSession(main, sessionId, now, { lockWaitMs = LOCK_WAIT_MS } = {}) {
  try {
    if (!isSafeSession(sessionId) || sessionId === null) return fail("セッションの識別子が不正です。");
    const nowMs = now instanceof Date ? now.getTime() : NaN;
    if (!Number.isFinite(nowMs)) return fail("現在時刻が不正です。");
    const p = pathsOf(main);
    if (!p) return fail("再開の記録の場所を決められません（Git のリポジトリの中で実行してください）。");
    const d = dirState(p.dir);
    if (d === "unsafe") return fail("再開の記録の保存先（brw）が通常のディレクトリではないため、書きません。");
    if (d === "missing") return { ok: true, attached: false };
    const outcome = locked(p.file, lockWaitMs, () => {
      const state = readState(p.dir, p.file);
      if (state.kind !== "ok") return { attached: false };
      const list = state.entries.map(normalizeEntry).filter(Boolean);
      let target = -1;
      let targetMs = -Infinity;
      list.forEach((e, i) => {
        if (e.sessionId !== null) return;
        const at = timeOf(e.at);
        const diff = nowMs - at;
        if (diff < 0 || diff > ATTACH_WINDOW_MS) return;
        // 同じ時刻なら先頭（より新しく書かれたもの）を選ぶ
        if (at > targetMs) {
          target = i;
          targetMs = at;
        }
      });
      if (target < 0) return { attached: false };
      const next = list.slice();
      next[target] = { ...list[target], sessionId };
      saveAtomic(p.file, textOf(next));
      return { attached: true };
    });
    return outcome ? { ok: true, attached: outcome.attached } : fail("再開の記録を今は付けられませんでした（ロック、またはファイルの状態を確かめてからやり直してください）。");
  } catch (err) {
    return fail(`再開の記録を保存できません: ${err.code ?? err.message}`);
  }
}
