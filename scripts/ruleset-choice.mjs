// Ruleset の対象範囲と導入の選択の再利用（brw-enforcement 5.1）。
// 対象（ホスト・所有者・リポジトリ名・恒常的な分岐元の集合）ごとに「導入する／見送る」の選択を保存し、
// 同じ対象では次回以降の導入で選択を引き継ぐ。対象が変わった・リポジトリ ID が食い違う・記録が壊れている場合は
// 「選択待ち」として返し、勝手に導入も見送りもしない。
// 適用済みの Ruleset ID は選択とは別の欄に記録し、適用後の確認が済んだかどうかも区別する。
// 見送りは GitHub の認証なしで記録できる。資格情報・トークンは受け取らず、保存もしない。
// GitHub へは通信しない（呼び出し側が GitHub で確認したリポジトリ ID を受け取って記録する）。
// 保存先は Git の共通ディレクトリ配下 brw/ruleset-choice.json。更新はロックを取り、同じ場所の一時ファイルから置き換える。
// 外部依存なし（Node 標準ライブラリと lib.mjs の git 呼び出しのみ）。
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { git } from "./lib.mjs";

const FILE_VERSION = 1;
const LOCK_STALE_MS = 60_000;
const HOST_RE = /^[a-z0-9][a-z0-9.-]{0,252}$/;
const NAME_RE = /^[a-z0-9_.-]{1,100}$/;
const REF_SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

const fail = (kind, message) => ({ ok: false, error: { kind, message } });
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const isPositiveInt = (v) => Number.isSafeInteger(v) && v > 0;
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const keyOf = (t) => `${t.host}/${t.owner}/${t.repository}`;

/**
 * 恒常的な分岐元の集合（整列・重複なし）。normalizeConfig 済みの宣言を受け取る。
 * 一時的な brwBase は含まれない（permanentBases にだけ入る）。
 */
export function refsOf(config) {
  return [...new Set(config.permanentBases ?? [config.baseBranch])].sort();
}

/** 対象を検証して正規化する。名前は大文字小文字を区別しない（小文字に揃える）。不正なら null と理由。 */
function normalizeTarget(input) {
  if (!input || typeof input !== "object") return { error: "対象の指定が正しくありません。" };
  const host = typeof input.host === "string" ? input.host.toLowerCase() : "";
  const owner = typeof input.owner === "string" ? input.owner.toLowerCase() : "";
  const repository = typeof input.repository === "string" ? input.repository.toLowerCase() : "";
  if (!HOST_RE.test(host)) return { error: "ホストの指定が正しくありません。" };
  if (!NAME_RE.test(owner) || !NAME_RE.test(repository)) return { error: "所有者またはリポジトリ名の指定が正しくありません。" };
  if (!Array.isArray(input.refs) || input.refs.length === 0) return { error: "分岐元の集合が空です。" };
  const refs = [...new Set(input.refs)];
  for (const r of refs) {
    if (typeof r !== "string" || r.length > 200 || !r.split("/").every((seg) => REF_SEGMENT_RE.test(seg))) {
      return { error: `分岐元名の指定が正しくありません: ${String(r).slice(0, 80)}` };
    }
  }
  const repositoryId = input.repositoryId ?? null;
  if (repositoryId !== null && !isPositiveInt(repositoryId)) return { error: "リポジトリ ID の指定が正しくありません。" };
  return { target: { host, owner, repository, refs: refs.sort(), repositoryId } };
}

/** 保存先。Git の外なら null。同じリポジトリの全 worktree は同じファイルを使う。 */
export function choiceFileOf(cwd) {
  const common = git(cwd, "rev-parse", "--git-common-dir");
  if (!common) return null;
  let real;
  try { real = realpathSync(resolve(cwd, common)); } catch { return null; }
  return join(real, "brw", "ruleset-choice.json");
}

/** 文字列だけの配列か。 */
const isStrings = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");
/** 記録の形を厳格に検査する。想定外の形は壊れた扱い（選択待ち・書き込み不可）。 */
const choiceShapeOk = (c) => !!c && typeof c === "object"
  && isStrings(c.refs) && typeof c.enabled === "boolean"
  && (c.repositoryId === null || isPositiveInt(c.repositoryId));
const appliedShapeOk = (a) => !!a && typeof a === "object"
  && isStrings(a.refs) && isPositiveInt(a.repositoryId) && isPositiveInt(a.rulesetId) && typeof a.verified === "boolean";
const shapeOk = (s) => {
  if (s?.version !== FILE_VERSION || typeof s.repos !== "object" || s.repos === null || Array.isArray(s.repos)) return false;
  return Object.values(s.repos).every((e) => !!e && typeof e === "object"
    && choiceShapeOk(e.choice) && Array.isArray(e.applied) && e.applied.every(appliedShapeOk));
};

/** 記録を読む。ファイルが無ければ空。読めない・形が違う場合は error。 */
function readState(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return { state: { version: FILE_VERSION, repos: {} } };
    return { error: `導入の選択を読めません: ${e.code ?? e.message}` };
  }
  try {
    const s = JSON.parse(text);
    if (!shapeOk(s)) throw new Error("形式が違います");
    return { state: s };
  } catch (e) {
    return { error: `導入の選択の記録が壊れています（${e.message}）。選択待ちとして扱います。記録を確認してください: ${file}` };
  }
}

/** 一時ファイルへ書いてから置き換える。 */
function save(file, state) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(state, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** 持ち主のいない古いロックか（60 秒超かつプロセスが生きていない）。 */
const isStaleLock = (lock) => {
  try {
    const pid = Number(readFileSync(lock, "utf8"));
    const alive = (() => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } })();
    return Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS && !(pid > 0 && alive);
  } catch {
    return false;
  }
};

/** ロックを取る。期限内に取れなければ false。 */
function acquire(lock, waitMs) {
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== "EEXIST") return false;
    }
    if (isStaleLock(lock)) rmSync(lock, { force: true });
    if (Date.now() >= until) return false;
    sleep(20);
  }
}

/**
 * 記録をロックの中で読み、fn(state) で更新する。fn が ok:false を返したら保存しない。
 * 壊れた記録には書かない（適用済み ID を失わないため）。
 */
function update(cwd, fn, { lockWaitMs = 3000 } = {}) {
  const file = choiceFileOf(cwd);
  if (!file) return fail("invalidInput", "Git リポジトリの中で実行してください。");
  mkdirSync(dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  if (!acquire(lock, lockWaitMs)) return fail("conflict", "別の処理が導入の選択を更新中です。少し待ってからやり直してください。");
  try {
    const { state, error } = readState(file);
    if (error) return fail("conflict", error);
    const out = fn(state);
    if (out.ok) save(file, state);
    return out;
  } catch (e) {
    return fail("conflict", `導入の選択を保存できません: ${e.code ?? e.message}`);
  } finally {
    rmSync(lock, { force: true });
  }
}

/**
 * 導入の選択を保存する。enabled は導入するかどうか（false は見送り）。
 * 保存するのは対象と選択だけ。資格情報らしい値などの追加項目は受け取らない。
 */
export function recordChoice(cwd, input, { lockWaitMs } = {}) {
  const n = normalizeTarget(input);
  if (n.error) return fail("invalidInput", n.error);
  if (typeof input.enabled !== "boolean") return fail("invalidInput", "導入するかどうか（true/false）を指定してください。");
  const { target } = n;
  return update(cwd, (state) => {
    const key = keyOf(target);
    const entry = state.repos[key] ?? { host: target.host, owner: target.owner, repository: target.repository, applied: [] };
    entry.choice = { refs: target.refs, enabled: input.enabled, repositoryId: target.repositoryId, recordedAt: new Date().toISOString() };
    state.repos[key] = entry;
    return { ok: true, choice: entry.choice };
  }, { lockWaitMs });
}

/**
 * 適用済みの Ruleset ID を記録する。選択とは別の欄に置く（選択の内容は変えない）。
 * 導入を選んだ同じ対象・リポジトリ ID に限る。同じ ID の二重記録は増やさない。
 */
export function recordApplied(cwd, input, { lockWaitMs } = {}) {
  const n = normalizeTarget(input);
  if (n.error) return fail("invalidInput", n.error);
  const { target } = n;
  if (!isPositiveInt(target.repositoryId)) return fail("invalidInput", "適用済みの記録にはリポジトリ ID が必要です。");
  if (!isPositiveInt(input.rulesetId)) return fail("invalidInput", "Ruleset ID の指定が正しくありません。");
  return update(cwd, (state) => {
    const entry = state.repos[keyOf(target)];
    if (!entry || !entry.choice.enabled || !sameList(entry.choice.refs, target.refs)) {
      return fail("conflict", "導入を選んだ対象と一致しないため、適用済みの ID を記録できません。");
    }
    if (entry.choice.repositoryId !== null && entry.choice.repositoryId !== target.repositoryId) {
      return fail("conflict", "保存済みのリポジトリ ID と一致しないため、適用済みの ID を記録できません。");
    }
    if (!entry.applied.some((a) => a.rulesetId === input.rulesetId && a.repositoryId === target.repositoryId)) {
      entry.applied.push({ refs: target.refs, repositoryId: target.repositoryId, rulesetId: input.rulesetId, verified: false, recordedAt: new Date().toISOString() });
    }
    return { ok: true };
  }, { lockWaitMs });
}

/** 記録した適用済み ID の適用後確認が済んだことを記録する。 */
export function markVerified(cwd, input, { lockWaitMs } = {}) {
  const n = normalizeTarget(input);
  if (n.error) return fail("invalidInput", n.error);
  const { target } = n;
  return update(cwd, (state) => {
    const entry = state.repos[keyOf(target)];
    const rec = entry?.applied.find((a) => a.rulesetId === input.rulesetId && a.repositoryId === target.repositoryId);
    if (!rec) return fail("invalidInput", "記録にない Ruleset ID は確認済みにできません。");
    rec.verified = true;
    rec.verifiedAt = new Date().toISOString();
    return { ok: true };
  }, { lockWaitMs });
}

/**
 * 対象の選択を読む。
 * - { status: "selected" }: 導入を選んだ同じ対象。appliedRulesetIds に同じ分岐元の適用済み ID を返す。
 * - { status: "skipped" }: 見送りを選んだ同じ対象。GitHub の認証は不要。
 * - { status: "pending", reason, knownRulesetIds }: 選択が無い（unset: true。既定は導入しない）・対象が変わった・ID が食い違う・記録が壊れている。
 *   knownRulesetIds は同じリポジトリで過去に記録した適用済み ID（変更後の対象へ報告するため）。
 */
export function resolveChoice(cwd, input) {
  const n = normalizeTarget(input);
  if (n.error) return fail("invalidInput", n.error);
  const { target } = n;
  const file = choiceFileOf(cwd);
  if (!file) return { ok: true, status: "pending", reason: "Git リポジトリの中で実行してください。", knownRulesetIds: [] };
  try {
    const { state, error } = readState(file);
    if (error) return { ok: true, status: "pending", reason: error, knownRulesetIds: [] };
    const entry = state.repos[keyOf(target)];
    // 適用済み ID は、保存済みのリポジトリ ID（無ければ対象の ID）と一致する記録だけを返す。旧 ID の取り違えを防ぐ
    const idOf = entry ? (entry.choice.repositoryId ?? target.repositoryId) : null;
    const sameRepoApplied = (a) => idOf !== null && a.repositoryId === idOf;
    const known = entry ? [...new Set(entry.applied.filter(sameRepoApplied).map((a) => a.rulesetId))].sort((a, b) => a - b) : [];
    // unset: 記録がまったく無い（既定の「導入しない」として扱える）。対象変更・ID 食い違い・破損は unset にしない
    if (!entry) return { ok: true, status: "pending", unset: true, reason: "導入の選択が未設定です。", knownRulesetIds: known };
    if (!sameList(entry.choice.refs, target.refs)) {
      return { ok: true, status: "pending", reason: "対象の分岐元が保存済みの選択と異なります。選択を取り直してください。", knownRulesetIds: known };
    }
    if (target.repositoryId !== null && entry.choice.repositoryId !== null && entry.choice.repositoryId !== target.repositoryId) {
      return { ok: true, status: "pending", reason: "リポジトリ ID が保存済みの選択と一致しません。再確認してください。", knownRulesetIds: known };
    }
    if (!entry.choice.enabled) return { ok: true, status: "skipped" };
    const appliedRulesetIds = [...new Set(entry.applied.filter((a) => sameRepoApplied(a) && sameList(a.refs, target.refs)).map((a) => a.rulesetId))].sort((a, b) => a - b);
    return { ok: true, status: "selected", repositoryId: idOf, appliedRulesetIds };
  } catch (e) {
    // 想定外の例外も選択待ちとして返す（導入の判断を誤らないため）
    return { ok: true, status: "pending", reason: `導入の選択を判定できません（${e.message}）。`, knownRulesetIds: [] };
  }
}
