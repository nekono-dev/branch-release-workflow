// 完了公開の作業状態（brw-enforcement 4.1）と公開準備の確定（4.2）: 作業 ID の発行、同一 worktree の別作業の区別、
// 中断と明示再開、操作別の結果と作業の禁止の保存、完了申告と取り込み先の確定（markReady）を扱う。
// 公開計画（4.3）、push の実行（4.4）、PR の作成（4.5）、フック接続（6.x）には踏み込まない。
// GitHub へは通信しない。既存 PR の検索結果と対象リポジトリ ID は、呼び出し側が GitHub クライアントで確認済みの値を受け取る。
// 外部依存なし（Node 標準ライブラリのみ）。
//
// 状態は worktree ごとに 1 つのファイルへ保存する（Git の共通ディレクトリ配下 brw/work/<worktree の識別子>.json）。
// 更新はロックを取り、同じ場所の一時ファイルへ書いてから置き換える（読む側が書きかけを見ない）。
// 同時に更新された・壊れている・読めない場合は安全側に倒す（新しい作業は始めず、禁止は維持されたものとして扱う）。
// PR 本文・資格情報は保存しない。保存するのは決まった項目だけで、自由文は秘密らしい値を伏せて長さを制限する。
import { randomBytes, createHash } from "node:crypto";
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { classifyBranch, currentBranch, git, loadConfig, repoRoot } from "./lib.mjs";

/** 作業の状態。準備済み以降の遷移は 4.2〜4.5 が使う。 */
export const WORK_STATUSES = ["inProgress", "ready", "pushed", "published"];
/** 状態の遷移（元 → 先）。公開済みからは戻らない。 */
const TRANSITIONS = {
  inProgress: ["ready"],
  ready: ["inProgress", "pushed", "published"],
  pushed: ["published"],
  published: [],
};
/** 操作別の結果。成功・対象外・明示禁止による省略・通常確認待ち・失敗。 */
export const RESULT_OUTCOMES = ["success", "notApplicable", "prohibited", "needsApproval", "failed"];
export const RESULT_OPERATIONS = ["push", "pr"];

const STATE_VERSION = 1;
const WORK_ID = /^w-[a-z0-9]+-[0-9a-f]{8}$/;
const SESSION_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const CODE = /^[a-z][a-z0-9-]{0,39}$/;
const TEXT_MAX = 200;
const LOCK_STALE_MS = 60_000;

const fail = (kind, message) => ({ ok: false, error: { kind, message } });

/**
 * 記録してよい URL を `origin + pathname` に正規化して返す。https 以外、認証情報・クエリ・フラグメント付き、長すぎるものは null。
 * 秘密情報が URL から状態ファイルへ入らないようにする。
 */
function safeUrl(text) {
  if (typeof text !== "string" || text.length > 500 || /[\s"'<>]/.test(text) || /[?#]/.test(text)) return null;
  let u;
  try { u = new URL(text); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || !u.host) return null;
  return u.origin + u.pathname;
}

/** 資格情報らしい文字列を伏せ、長さを制限する。自由文を状態へ保存する前に必ず通す。 */
const redact = (text) => String(text)
  .replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{8,}/g, "***")
  .replace(/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 ***")
  .replace(/(token|password|passwd|secret|authorization)\s*[=:]\s*\S+/gi, "$1=***")
  .replace(/(:\/\/)[^\s/@]+@/g, "$1***@")
  .replace(/\s+/g, " ").trim().slice(0, TEXT_MAX);

// ---- 保存場所 ----

/** 状態ファイルの場所。Git のリポジトリの外なら null。同じ worktree（作業ディレクトリ）は同じファイルになる。 */
export function stateFileOf(cwd) {
  const top = repoRoot(cwd);
  const common = git(cwd, "rev-parse", "--git-common-dir");
  if (!top || !common) return null;
  let real;
  try { real = realpathSync(top); } catch { return null; }
  const id = createHash("sha256").update(real).digest("hex").slice(0, 16);
  return join(resolve(cwd, common), "brw", "work", `${id}.json`);
}

const worktreeIdOf = (file) => file.slice(file.lastIndexOf("/") + 1, -".json".length);

/** 状態を読む。ファイルが無ければ空の状態、壊れていれば error。 */
function load(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return { state: { version: STATE_VERSION, worktreeId: worktreeIdOf(file), current: null, works: {} } };
    return { error: `作業状態を読めません: ${e.code ?? e.message}` };
  }
  try {
    const s = JSON.parse(text);
    if (s?.version !== STATE_VERSION || typeof s.works !== "object" || s.works === null || Array.isArray(s.works)) throw new Error("形式が違います");
    return { state: { ...s, current: typeof s.current === "string" ? s.current : null } };
  } catch (e) {
    return { error: `作業状態が壊れています（${e.message}）。作業の禁止は維持されたものとして扱います。状態ファイルを確認してください: ${file}` };
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

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

/** 60 秒を超え、持ち主のプロセスもいないロックか。 */
const isStale = (file) => {
  const pid = Number(readFileSync(file, "utf8"));
  return Date.now() - statSync(file).mtimeMs > LOCK_STALE_MS && !(pid > 0 && alive(pid));
};

/** ロックを取る。取れなければ待ち、期限内に取れなければ null。持ち主がいなくなった古いロックは外す。 */
function acquire(lockFile, waitMs) {
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = openSync(lockFile, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== "EEXIST") return null;
    }
    try {
      if (isStale(lockFile)) {
        // 確認と削除の間に別の待機側が新しいロックを取っても消さないよう、一意の名前へ移してから改めて確認する
        const moved = `${lockFile}.stale.${process.pid}.${randomBytes(4).toString("hex")}`;
        renameSync(lockFile, moved);
        if (isStale(moved)) rmSync(moved, { force: true });
        else {
          // 移したのは新しく取られたロックだった。元の名前へ戻す（戻せなければ相手が取り直した後なので触れない）
          try { linkSync(moved, lockFile); } catch { /* 既に別のロックがある */ }
          rmSync(moved, { force: true });
        }
      }
    } catch { /* 読めなければ次の周回で再試行 */ }
    if (Date.now() >= until) return null;
    sleep(20);
  }
}

/**
 * 状態をロックの中で読み、`fn(state)` で更新する。`fn` が結果（ok:false なら保存しない）を返す。
 * 壊れた状態には書かない（上書きして禁止を失わないため）。
 */
function update(cwd, fn, { lockWaitMs = 3000, allowCorrupt = false } = {}) {
  const file = stateFileOf(cwd);
  if (!file) return fail("invalidInput", "Git リポジトリの中で実行してください。");
  mkdirSync(dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  if (!acquire(lock, lockWaitMs)) return fail("conflict", "別の処理が作業状態を更新中です。少し待ってからやり直してください。");
  try {
    const { state, error } = load(file);
    if (error && !allowCorrupt) return fail("conflict", error);
    const out = fn(state);
    if (out.ok) save(file, state);
    return out;
  } catch (e) {
    return fail("conflict", `作業状態を保存できません: ${e.code ?? e.message}`);
  } finally {
    rmSync(lock, { force: true });
  }
}

const now = () => new Date().toISOString();
const pauseRecord = (w, reason) => { w.pausedReason = redact(reason); w.updatedAt = now(); };
const idError = (id) => (typeof id === "string" && WORK_ID.test(id) ? null : fail("invalidInput", "作業 ID の形式が正しくありません。"));
const sessionError = (s) => (s === undefined || (typeof s === "string" && SESSION_ID.test(s)) ? null : fail("invalidInput", "セッション ID の形式が正しくありません。"));

/** 現在の作業が別の作業なら、その作業を中断として記録する（公開済みは対象外）。 */
function interruptCurrent(state, nextId, reason) {
  const cur = state.works[state.current];
  if (cur && state.current !== nextId && cur.status !== "published" && !cur.pausedReason) pauseRecord(cur, reason);
}

// ---- 公開 API ----
// いずれも { ok: true, ... } か { ok: false, error: { kind, message } } を返す。kind は invalidInput（入力が不正）か conflict（状態が合わない・衝突）。

/** 新しい変更作業を始め、作業 ID を発行する。同じセッション・HEAD でも別の ID になり、以前の作業の状態は引き継がない。 */
export function startWork(cwd, { sessionId, lockWaitMs } = {}) {
  const bad = sessionError(sessionId);
  if (bad) return bad;
  const branch = currentBranch(cwd);
  if (!branch) return fail("invalidInput", "現在のブランチを確定できないため（detached HEAD など）、作業を始めません。");
  return update(cwd, (state) => {
    let workId;
    do workId = `w-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`; while (state.works[workId]);
    interruptCurrent(state, workId, "別の作業を始めたため中断");
    const t = now();
    const work = { workId, worktreeId: state.worktreeId, branch, status: "inProgress", restrictions: { noPush: false, noPr: false }, results: {}, createdAt: t, updatedAt: t };
    if (sessionId) work.sessionId = sessionId;
    state.works[workId] = work;
    state.current = workId;
    return { ok: true, work };
  }, { lockWaitMs });
}

/** 作業の次の副作用を保留する。理由は必須。 */
export function pauseWork(cwd, workId, reason, { lockWaitMs } = {}) {
  const bad = idError(workId);
  if (bad) return bad;
  if (typeof reason !== "string" || !redact(reason)) return fail("invalidInput", "中断の理由を指定してください。");
  return update(cwd, (state) => {
    const w = state.works[workId];
    if (!w) return fail("invalidInput", `作業 ${workId} はこの worktree に記録がありません。`);
    if (w.status === "published") return fail("conflict", "公開済みの作業は中断できません。");
    pauseRecord(w, reason);
    if (state.current === workId) state.current = null;
    return { ok: true, work: w };
  }, { lockWaitMs });
}

/**
 * 作業 ID を明示して再開する。同じ worktree・ブランチの作業だけ再開でき、会話や HEAD からの推測はしない。
 * 準備済みの記録があり、その後に HEAD が進んでいたら準備済みを取り消す（検証と公開対象を取り直させる）。
 */
export function resumeWork(cwd, workId, { sessionId, lockWaitMs } = {}) {
  const bad = idError(workId) ?? sessionError(sessionId);
  if (bad) return bad;
  return update(cwd, (state) => {
    const w = state.works[workId];
    if (!w) return fail("invalidInput", `作業 ${workId} はこの worktree に記録がありません。`);
    if (w.status === "published") return fail("conflict", "公開済みの作業は再開できません。");
    const branch = currentBranch(cwd);
    if (branch !== w.branch) return fail("conflict", `作業 ${workId} のブランチは ${w.branch} ですが、現在は ${branch ?? "ブランチなし"} です。作業のブランチに戻ってから再開してください。`);
    interruptCurrent(state, workId, "別の作業を再開したため中断");
    if (w.ready && w.ready.headOid !== git(cwd, "rev-parse", "HEAD")) {
      delete w.ready;
      w.status = "inProgress";
      // 古い公開の成功記録を残すと、4.2 以降が公開済みと誤認する
      if (w.results && typeof w.results === "object") for (const op of RESULT_OPERATIONS) delete w.results[op];
    }
    delete w.pausedReason;
    if (sessionId) w.sessionId = sessionId;
    w.updatedAt = now();
    state.current = workId;
    return { ok: true, work: w };
  }, { lockWaitMs });
}

/** 作業の禁止（push・PR 作成）を追加する。外すことはできない（追加指示は厳しくする方向だけ）。 */
export function setRestrictions(cwd, workId, restrictions, { lockWaitMs } = {}) {
  const bad = idError(workId);
  if (bad) return bad;
  const keys = Object.keys(restrictions ?? {});
  if (keys.some((k) => (k !== "noPush" && k !== "noPr") || typeof restrictions[k] !== "boolean")) return fail("invalidInput", "禁止は noPush・noPr（真偽値）で指定してください。");
  return update(cwd, (state) => {
    const w = state.works[workId];
    if (!w) return fail("invalidInput", `作業 ${workId} はこの worktree に記録がありません。`);
    w.restrictions = restrictionsOf(w);
    for (const k of keys) if (restrictions[k]) w.restrictions[k] = true;
    w.updatedAt = now();
    return { ok: true, work: w };
  }, { lockWaitMs });
}

/** 操作別の結果を記録する。保存するのは outcome・code・https の url だけで、PR 本文や詳細な文面は保存しない。 */
export function recordResult(cwd, workId, operation, result, { lockWaitMs } = {}) {
  const bad = idError(workId);
  if (bad) return bad;
  if (!RESULT_OPERATIONS.includes(operation)) return fail("invalidInput", `操作は ${RESULT_OPERATIONS.join("・")} のいずれかで指定してください。`);
  if (!RESULT_OUTCOMES.includes(result?.outcome)) return fail("invalidInput", `結果は ${RESULT_OUTCOMES.join("・")} のいずれかで指定してください。`);
  if (result.code != null && !(typeof result.code === "string" && CODE.test(result.code))) return fail("invalidInput", "理由の識別子の形式が正しくありません。");
  const url = result.url != null ? safeUrl(result.url) : null;
  if (result.url != null && !url) return fail("invalidInput", "URL は認証情報・クエリ・フラグメントを含まない https のものだけ記録できます。");
  return update(cwd, (state) => {
    const w = state.works[workId];
    if (!w) return fail("invalidInput", `作業 ${workId} はこの worktree に記録がありません。`);
    const rec = { outcome: result.outcome, code: result.code ?? null };
    if (url) rec.url = url;
    w.results[operation] = rec;
    w.updatedAt = now();
    return { ok: true, work: w };
  }, { lockWaitMs });
}

/** 状態（inProgress・ready・pushed・published）を決まった遷移だけで進める。公開済みになった作業は現在の作業から外れる。 */
export function setStatus(cwd, workId, status, { lockWaitMs } = {}) {
  const bad = idError(workId);
  if (bad) return bad;
  if (!WORK_STATUSES.includes(status)) return fail("invalidInput", `状態は ${WORK_STATUSES.join("・")} のいずれかで指定してください。`);
  return update(cwd, (state) => {
    const w = state.works[workId];
    if (!w) return fail("invalidInput", `作業 ${workId} はこの worktree に記録がありません。`);
    if (!TRANSITIONS[w.status].includes(status)) return fail("conflict", `作業の状態を ${w.status} から ${status} へは変更できません。`);
    w.status = status;
    w.updatedAt = now();
    if (status === "published" && state.current === workId) state.current = null;
    return { ok: true, work: w };
  }, { lockWaitMs });
}

// ---- 完了申告と公開準備（4.2） ----

/** 判別用の code を持つ失敗の結果。kind は invalidInput（入力・宛先の不備）か conflict（状態・Git の状態との食い違い）。 */
const failC = (kind, code, message) => ({ ok: false, error: { kind, code, message } });

// GitHub のリポジトリを指す push 先の URL（https・ssh・scp 形式）。認証情報付きの URL は読まない（宛先不明）
const GITHUB_REPO = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;
const NAME_PART = /^[A-Za-z0-9_.-]{1,100}$/;

/** リモートの URL から GitHub の所有者・リポジトリ名を読む。読めなければ null（宛先不明として扱う）。 */
export function githubRepoOf(url) {
  const m = typeof url === "string" ? url.trim().match(GITHUB_REPO) : null;
  return m ? { owner: m[1], name: m[2] } : null;
}

/** 完了申告・検証・対象リポジトリの入力を検査する。Git の状態は見ない（作業の状態とともに後で確認する）。 */
function readyInputError(input) {
  if (typeof input?.completion !== "string" || !redact(input.completion)) return failC("invalidInput", "completion-missing", "完了申告（依頼の完了条件を満たした旨）を文字列で指定してください。");
  const v = input.verification;
  if (!v || typeof v !== "object" || typeof v.passed !== "boolean" || typeof v.summary !== "string" || !redact(v.summary)) return failC("invalidInput", "verification-missing", "検証の結果（passed と要約）を指定してください。");
  if (v.passed !== true) return failC("conflict", "verification-failed", "検証が成功していないため、公開の準備はしません。");
  const r = input.repository;
  if (!r || typeof r !== "object" || !Number.isSafeInteger(r.id) || r.id <= 0 || !NAME_PART.test(r.owner ?? "") || !NAME_PART.test(r.name ?? ""))
    return failC("invalidInput", "repository-invalid", "対象リポジトリの ID（正の整数）・所有者・名前を指定してください。");
  if (input.target !== undefined && typeof input.target !== "string") return failC("invalidInput", "integration-invalid", "取り込み先は文字列のブランチ名で指定してください。");
  return null;
}

/**
 * 完了申告と取り込み先から、公開の準備を確定する（状態を ready にし、準備の記録を書く）。
 * 確定するもの: 作業 ID・worktree・開発ブランチ・head OID（HEAD が作業ブランチの先端と一致）・push 先（GitHub のリポジトリと refs/heads/<ブランチ>）・取り込み先・完了申告・検証の要約・禁止の固定。
 * 取り込み先は、呼び出し側の明示指定（target）→ 記録済みの brwBase → 宣言の baseBranch の順に決め、既存 PR（existing: findOpenPull の結果）の取り込み先と食い違えば明示指定を求めて止める。
 * 取り込み先が開発ブランチなら publication は push（PR は作らない）、保護対象・分岐元なら pr（PR を伴う公開）。
 * 未コミットの変更、検証の失敗、宛先・取り込み先が確定できない場合は準備済みにしない。PR 本文・資格情報は受け取らず記録しない。
 * @param {{completion: string, verification: {passed: boolean, summary: string}, repository: {id: number, owner: string, name: string}, target?: string, existing?: object}} input
 */
export function markReady(cwd, workId, input = {}, { lockWaitMs } = {}) {
  const bad = idError(workId);
  if (bad) return bad;
  const inputBad = readyInputError(input);
  if (inputBad) return inputBad;
  return update(cwd, (state) => {
    const w = state.works[workId];
    if (!w) return fail("invalidInput", `作業 ${workId} はこの worktree に記録がありません。`);
    if (w.worktreeId !== state.worktreeId) return failC("conflict", "work-worktree-mismatch", "作業の記録と worktree が一致しません。");
    if (w.status !== "inProgress") return failC("conflict", "work-status", `作業の状態が ${w.status} のため、公開の準備はできません。`);
    if (w.pausedReason) return failC("conflict", "work-paused", "中断中の作業は準備できません。`brw work resume` で再開してください。");

    const branch = currentBranch(cwd);
    if (branch !== w.branch) return failC("conflict", "work-branch-mismatch", `作業のブランチ ${w.branch} と現在のブランチ（${branch ?? "なし"}）が一致しません。`);
    const root = repoRoot(cwd);
    const loaded = root ? loadConfig(root) : { config: null, error: "Git リポジトリの外です。" };
    if (loaded.error || !loaded.config) return failC("conflict", "declaration-invalid", loaded.error ?? "宣言ファイルがありません。規則を確認できないため準備しません。");
    const config = loaded.config;
    const cls = classifyBranch(config, branch);
    if (cls !== "development") return failC("conflict", "branch-not-development", `'${branch}' は開発ブランチではない（${cls}）ため、公開の準備はできません。`);

    // 公開する内容は、コミット済みで作業ブランチの先端と一致している HEAD に限る
    const dirty = git(cwd, "status", "--porcelain");
    if (dirty === null) return failC("conflict", "git-state-unknown", "作業ツリーの状態を確認できません。");
    if (dirty !== "") return failC("conflict", "uncommitted", "未コミットの変更があるため、公開の準備はしません。commit してから再実行してください。");
    const head = git(cwd, "rev-parse", "--verify", "HEAD");
    if (!head || git(cwd, "rev-parse", "--verify", `refs/heads/${branch}`) !== head) return failC("conflict", "head-unknown", "HEAD のコミットを作業ブランチと照合できません。");

    // push 先: push 用のリモート（無ければ既定のリモート）の URL が、指定の GitHub リポジトリを指していることを確認する
    const remote = git(cwd, "config", `branch.${branch}.pushRemote`) || git(cwd, "config", "remote.pushDefault") || git(cwd, "config", `branch.${branch}.remote`) || "origin";
    const repo = githubRepoOf(git(cwd, "remote", "get-url", "--push", remote));
    if (!repo) return failC("invalidInput", "destination-unknown", `push 先のリモート（${remote}）を GitHub のリポジトリとして確定できません。`);
    const want = input.repository;
    if (repo.owner.toLowerCase() !== want.owner.toLowerCase() || repo.name.toLowerCase() !== want.name.toLowerCase())
      return failC("invalidInput", "destination-mismatch", "push 先のリモートが指定の対象リポジトリと一致しません。");

    // 既存 PR の検索結果（findOpenPull）。確定できないなら取り込み先を決められないため止める
    const ex = input.existing;
    if (ex !== undefined && ex?.ok !== true) return failC("conflict", "pr-unconfirmed", "既存 PR の検索が確定できないため、取り込み先を決められません。");
    const pullBase = ex?.pull ? ex.pull.baseRef : null;
    if (ex?.pull && typeof pullBase !== "string") return failC("conflict", "pr-unconfirmed", "既存 PR の取り込み先を読み取れないため、取り込み先を決められません。");

    // 取り込み先: 明示指定 → 記録済みの brwBase → 宣言の既定値。記録・既定値と既存 PR が食い違えば明示指定を求める
    const recorded = git(cwd, "config", `branch.${branch}.brwBase`) || null;
    let ref;
    let source;
    if (input.target !== undefined) { ref = input.target; source = "explicit"; }
    else if (recorded) { ref = recorded; source = "recorded"; }
    else { ref = config.baseBranch; source = "declared"; }
    if (git(cwd, "check-ref-format", "--branch", ref) === null) return failC("invalidInput", "integration-invalid", `取り込み先の名前 ${ref} が正しくありません。`);
    if (ref === branch) return failC("invalidInput", "integration-self", "作業のブランチ自身は取り込み先にできません。");
    const kind = classifyBranch(config, ref);
    if (kind === "undeclared") return failC("invalidInput", "integration-undeclared", `取り込み先 '${ref}' は宣言に無いブランチです。取り込み先を明示指定してください。`);
    if (source !== "explicit" && pullBase != null && pullBase !== ref)
      return failC("conflict", "base-conflict", `既存 PR の取り込み先（${pullBase}）と${source === "recorded" ? "記録済みの分岐元" : "宣言の既定値"}（${ref}）が食い違います。取り込み先を明示指定してください。`);

    const at = now();
    w.ready = {
      headOid: head,
      repositoryId: want.id,
      pushRef: `refs/heads/${branch}`,
      integration: { repositoryId: want.id, ref, kind, source },
      publication: kind === "development" ? "push" : "pr",
      completion: redact(input.completion),
      verification: { passed: true, summary: redact(input.verification.summary) },
      restrictions: restrictionsOf(w),
      readyAt: at,
    };
    w.status = "ready";
    w.updatedAt = at;
    return { ok: true, work: w, ready: w.ready };
  }, { lockWaitMs });
}

/** 作業 1 件を読む。 */
export function readWork(cwd, workId) {
  const bad = idError(workId);
  if (bad) return bad;
  const file = stateFileOf(cwd);
  if (!file) return fail("invalidInput", "Git リポジトリの中で実行してください。");
  const { state, error } = load(file);
  if (error) return fail("conflict", error);
  const work = state.works[workId];
  return work ? { ok: true, work } : fail("invalidInput", `作業 ${workId} はこの worktree に記録がありません。`);
}

/** この worktree で進行中（中断されていない）の作業。無ければ work: null。 */
export function currentWork(cwd) {
  const file = stateFileOf(cwd);
  if (!file) return fail("invalidInput", "Git リポジトリの中で実行してください。");
  const { state, error } = load(file);
  if (error) return fail("conflict", error);
  const w = state.works[state.current];
  return { ok: true, work: w && !w.pausedReason && w.status !== "published" ? w : null };
}

/**
 * 共通判定（operation-decision.mjs）の `context.restrictions` に渡す形で禁止を返す。
 * 状態を読めない・作業が見つからない場合は、禁止が付いているものとして扱う（安全側）。
 */
export function getRestrictions(cwd, workId) {
  const r = readWork(cwd, workId);
  if (!r.ok) return { noPush: true, noPr: true };
  return restrictionsOf(r.work);
}

/** 作業の禁止を取り出す。項目が無い・形が違う場合は禁止ありとして扱う（安全側）。 */
function restrictionsOf(work) {
  const r = work?.restrictions;
  if (!r || typeof r !== "object" || Array.isArray(r) || typeof r.noPush !== "boolean" || typeof r.noPr !== "boolean") return { noPush: true, noPr: true };
  return { noPush: r.noPush, noPr: r.noPr };
}
