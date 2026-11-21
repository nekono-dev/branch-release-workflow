// 完了公開の作業状態（brw-enforcement 4.1）と公開準備の確定（4.2）・公開計画の発行と検証（4.3）・push の実行と照合（4.4）:
// 作業 ID の発行、同一 worktree の別作業の区別、中断と明示再開、操作別の結果と作業の禁止の保存、
// 完了申告と取り込み先の確定（markReady）、許可された書き込みだけの計画（issuePlan・checkPlan）、
// 計画どおりの push（runPush）を扱う。PR の作成・再利用（4.5、publish-pr.mjs）・フック接続（6.x）には踏み込まない。
// GitHub の API へは通信しない（計画の発行は読み取りと状態の記録だけ。push と遠隔 ref の読み取りは git の通信で行う）。
// 既存 PR の検索結果と対象リポジトリ ID は、呼び出し側が GitHub クライアントで確認済みの値を受け取る。
// 外部依存なし（Node 標準ライブラリのみ）。
//
// 状態は worktree ごとに 1 つのファイルへ保存する（Git の共通ディレクトリ配下 brw/work/<worktree の識別子>.json）。
// 更新はロックを取り、同じ場所の一時ファイルへ書いてから置き換える（読む側が書きかけを見ない）。
// 同時に更新された・壊れている・読めない場合は安全側に倒す（新しい作業は始めず、禁止は維持されたものとして扱う）。
// PR 本文・資格情報は保存しない。保存するのは決まった項目だけで、自由文は秘密らしい値を伏せて長さを制限する。
import { randomBytes, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { classifyBranch, configMatchesHead, currentBranch, git, loadConfig, repoRoot } from "./lib.mjs";
import { classifyCommand } from "./operation-policy.mjs";
import { evaluateAll } from "./operation-decision.mjs";

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

export const fail = (kind, message) => ({ ok: false, error: { kind, message } });

/**
 * 記録してよい URL を `origin + pathname` に正規化して返す。https 以外、認証情報・クエリ・フラグメント付き、長すぎるものは null。
 * 秘密情報が URL から状態ファイルへ入らないようにする。
 */
export function safeUrl(text) {
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
export function load(file) {
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
export function acquire(lockFile, waitMs) {
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
export function update(cwd, fn, { lockWaitMs = 3000, allowCorrupt = false } = {}) {
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

export const now = () => new Date().toISOString();
const pauseRecord = (w, reason) => { w.pausedReason = redact(reason); w.updatedAt = now(); };
export const idError = (id) => (typeof id === "string" && WORK_ID.test(id) ? null : fail("invalidInput", "作業 ID の形式が正しくありません。"));
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
export const failC = (kind, code, message) => ({ ok: false, error: { kind, code, message } });

// GitHub のリポジトリを指す push 先の URL（https・ssh・scp 形式）。認証情報付きの URL は読まない（宛先不明）
const GITHUB_REPO = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;
const NAME_PART = /^[A-Za-z0-9_.-]{1,100}$/;

/** リモートの URL から GitHub の所有者・リポジトリ名を読む。読めなければ null（宛先不明として扱う）。 */
export function githubRepoOf(url) {
  const m = typeof url === "string" ? url.trim().match(GITHUB_REPO) : null;
  return m ? { owner: m[1], name: m[2] } : null;
}

/** 作業ブランチの push 先リモート名（pushRemote → remote.pushDefault → 追跡先 → origin の順）。 */
export const remoteNameOf = (cwd, branch) => git(cwd, "config", `branch.${branch}.pushRemote`) || git(cwd, "config", "remote.pushDefault") || git(cwd, "config", `branch.${branch}.remote`) || "origin";

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
    const remote = remoteNameOf(cwd, branch);
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

// ---- 公開計画（4.3） ----

// 名前を安全に扱えるかの検査。シェルに渡す前の確認で、先頭に "-"（オプションとして解釈される）は認めない
export const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const SAFE_REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** 版の比べ方。計画を保存するときと検証するときに同じ入力から同じ値になる。 */
const digestOf = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

/**
 * 計画の前提となる版（宣言・禁止・準備の記録・push 先）を現在の状態から求める。
 * 値は要約（ハッシュ）だけで、URL・資格情報・PR 本文は計画にも状態にも残さない。
 */
function versionsOf(cwd, root, w) {
  const { config, error } = loadConfig(root);
  return {
    declaration: error || !config ? null : digestOf({ config, registered: configMatchesHead(root) }),
    restrictions: digestOf(restrictionsOf(w)),
    ready: digestOf(w.ready ?? null),
    destination: digestOf(git(cwd, "remote", "get-url", "--push", remoteNameOf(cwd, w.branch)) ?? null),
  };
}

/**
 * 計画の前提（作業の状態・worktree・ブランチ・HEAD・作業ツリー）を照合する。読み取りのみ。
 * 問題があれば失敗の結果、なければ確認した値（ok・branch・head・root）を返す。
 */
function workGitState(cwd, state, w) {
  if (w.worktreeId !== state.worktreeId) return failC("conflict", "work-worktree-mismatch", "作業の記録と worktree が一致しません。");
  if (w.status !== "ready" && w.status !== "pushed") return failC("conflict", "work-status", `作業の状態が ${w.status} のため、計画は扱えません。`);
  if (w.pausedReason) return failC("conflict", "work-paused", "中断中の作業は計画できません。`brw work resume` で再開してください。");
  if (!w.ready) return failC("conflict", "work-not-ready", "準備済みの記録がありません。先に公開の準備を確定してください。");
  const branch = currentBranch(cwd);
  if (branch !== w.branch) return failC("conflict", "work-branch-mismatch", `作業のブランチ ${w.branch} と現在のブランチ（${branch ?? "なし"}）が一致しません。`);
  const head = git(cwd, "rev-parse", "--verify", "HEAD");
  if (!head || head !== w.ready.headOid) return failC("conflict", "head-changed", "準備時の commit と現在の HEAD が一致しません。公開の準備をし直してください。");
  const dirty = git(cwd, "status", "--porcelain");
  if (dirty === null) return failC("conflict", "git-state-unknown", "作業ツリーの状態を確認できません。");
  if (dirty !== "") return failC("conflict", "uncommitted", "未コミットの変更があるため、計画は扱えません。");
  const root = repoRoot(cwd);
  if (!root) return failC("invalidInput", "declaration-invalid", "Git リポジトリの外です。");
  return { ok: true, branch, head, root };
}

/**
 * 公開計画を発行する。準備済み（または push 成功後の途中）の作業について、許可された書き込みだけを計画として保存する。
 * 照合: 作業 ID・worktree・状態・ブランチ・HEAD（準備時の head OID）・未コミットの有無・対象リポジトリ ID・push 先の GitHub 対象・
 *       登録済みの宣言・取り込み先の分類と公開方法。
 * 既存 PR は呼び出し側が findOpenPull の結果として渡す（existing）。保護対象への公開で必須。
 *   同じ head・base の PR があれば再利用として PR は計画しない。head・base が違えば成功扱いせず止める。
 * push と PR は共通判定（evaluateAll）で個別に判定し、確認省略の対象だけを writes に入れる。
 *   禁止・通常確認待ち・既に成功した push は writes に入れず、excluded で理由を返す（計画に残さない）。
 *   PR は push が計画されている（または成功済み）場合にだけ計画する。push が禁止・未確認なら PR も計画しない。
 * 通信も遠隔の書き換えもしない（ローカルの Git 照会と状態の記録だけ）。
 * @param {{id: number, owner: string, name: string}} repository 呼び出し側が確定した対象リポジトリ
 * @param {object} [existing] findOpenPull の結果（{ok, pull}）
 * @returns {{ok: true, plan: object, excluded: object[], reuse: object|null} | {ok: false, error: object}}
 */
export function issuePlan(cwd, workId, { repository, existing, lockWaitMs } = {}) {
  const bad = idError(workId);
  if (bad) return bad;
  if (!repository || typeof repository !== "object" || !Number.isSafeInteger(repository.id) || repository.id <= 0 || !NAME_PART.test(repository.owner ?? "") || !NAME_PART.test(repository.name ?? ""))
    return failC("invalidInput", "repository-invalid", "対象リポジトリの ID（正の整数）・所有者・名前を指定してください。");
  return update(cwd, (state) => {
    const w = state.works[workId];
    if (!w) return fail("invalidInput", `作業 ${workId} はこの worktree に記録がありません。`);
    const g = workGitState(cwd, state, w);
    if (!g.ok) return g;
    const loaded = loadConfig(g.root);
    if (loaded.error || !loaded.config) return failC("conflict", "declaration-invalid", loaded.error ?? "宣言ファイルがありません。規則を確認できないため計画しません。");
    const config = loaded.config;
    const ready = w.ready;
    if (ready.repositoryId !== repository.id) return failC("invalidInput", "destination-mismatch", "準備時の対象リポジトリ ID と一致しません。");

    // push 先: GitHub の同じリポジトリを指していることを確認する（読み取りのみ）
    const remote = remoteNameOf(cwd, g.branch);
    const dest = githubRepoOf(git(cwd, "remote", "get-url", "--push", remote));
    if (!dest || !SAFE_REMOTE_NAME.test(remote)) return failC("invalidInput", "destination-unknown", `push 先のリモート（${remote}）を GitHub のリポジトリとして確定できません。`);
    if (dest.owner.toLowerCase() !== repository.owner.toLowerCase() || dest.name.toLowerCase() !== repository.name.toLowerCase())
      return failC("invalidInput", "destination-mismatch", "push 先のリモートが指定の対象リポジトリと一致しません。");

    // 分類: 準備時の取り込み先・公開方法が、現在の宣言と食い違っていないこと
    const base = ready.integration.ref;
    if (classifyBranch(config, g.branch) !== "development") return failC("conflict", "branch-not-development", `'${g.branch}' は開発ブランチではないため、計画できません。`);
    const kind = classifyBranch(config, base);
    const publication = kind === "development" ? "push" : "pr";
    if (kind !== ready.integration.kind || publication !== ready.publication) return failC("conflict", "integration-changed", "準備時の取り込み先の分類が現在の宣言と一致しません。公開の準備をし直してください。");
    if (!SAFE_BRANCH.test(g.branch) || !SAFE_BRANCH.test(base)) return failC("invalidInput", "name-unsafe", "ブランチ名を安全に確認できないため、計画しません。");

    // 既存 PR: 保護対象への公開では必須。同じ head・base なら再利用（PR は計画しない）、食い違えば止める
    let reuse = null;
    if (publication === "pr") {
      if (existing?.ok !== true) return failC("conflict", "pr-unconfirmed", "既存 PR の検索が確定できないため、PR の計画は立てません。");
      if (existing.pull) {
        if (typeof existing.pull.headOid !== "string" || existing.pull.headOid.toLowerCase() !== g.head.toLowerCase())
          return failC("conflict", "pr-head-differs", "既存 PR の head が準備時の commit と一致しません。再確認してください。");
        if (existing.pull.baseRef !== base) return failC("conflict", "base-conflict", `既存 PR の取り込み先（${existing.pull.baseRef}）が準備時の取り込み先（${base}）と一致しません。`);
        reuse = { number: Number.isSafeInteger(existing.pull.number) ? existing.pull.number : null, url: safeUrl(existing.pull.url) };
      }
    }

    // 判定: push と PR を個別に判定する。確認省略の対象だけを writes に入れる
    const restrictions = restrictionsOf(w);
    const writes = [];
    const excluded = [];
    let pushAvailable = false;
    if (w.results?.push?.outcome === "success") {
      // 既に成功した push は再度の書き込みに入れない（同じ OID の確認は 4.4 が行う）
      excluded.push({ operation: "push", code: "already-pushed", approval: "notApplicable" });
      pushAvailable = true;
    } else {
      const d = evaluateAll(classifyCommand(`git push ${remote} ${g.branch}`, cwd), restrictions);
      if (d.verdict === "eligibleForApproval") {
        writes.push({ operation: "push", remote, ref: ready.pushRef, oid: g.head });
        pushAvailable = true;
      } else excluded.push({ operation: "push", code: d.code, approval: d.approval });
    }
    if (publication === "pr" && reuse === null) {
      if (!pushAvailable) excluded.push({ operation: "pr", code: "push-not-planned", approval: "notApplicable" });
      else {
        const d = evaluateAll(classifyCommand(`gh pr create --repo ${repository.owner}/${repository.name} --base ${base} --head ${g.branch} --title brw`, cwd), restrictions);
        if (d.verdict === "eligibleForApproval") writes.push({ operation: "pr", base, head: g.branch, repositoryId: repository.id });
        else excluded.push({ operation: "pr", code: d.code, approval: d.approval });
      }
    }

    const at = now();
    const plan = {
      planId: `p-${randomBytes(8).toString("hex")}`,
      issuedAt: at,
      headOid: g.head,
      repositoryId: repository.id,
      versions: versionsOf(cwd, g.root, w),
      writes,
    };
    w.plan = plan;
    w.updatedAt = at;
    return { ok: true, plan, excluded, reuse };
  }, { lockWaitMs });
}

/**
 * 発行済みの計画が今も有効かを確認する（読み取りのみ）。副作用の前に呼ぶ（実行は 4.4・4.5）。
 * 作業の状態・HEAD・作業ツリー・宣言・禁止・準備の記録・push 先のいずれかが計画の発行時と変わっていれば失効とし、書き込みを止める。
 * 別の計画 ID や、再発行された後の古い計画 ID も失効扱い（plan-not-found）になる。
 */
export function checkPlan(cwd, workId, planId) {
  const bad = idError(workId);
  if (bad) return bad;
  const file = stateFileOf(cwd);
  if (!file) return fail("invalidInput", "Git リポジトリの中で実行してください。");
  const { state, error } = load(file);
  if (error) return fail("conflict", error);
  const v = verifyPlan(cwd, state, workId, planId);
  return v.ok ? { ok: true, plan: v.plan } : v;
}

/**
 * 読み込み済みの状態に対して計画の有効性を確認する（読み取りのみ）。checkPlan と runPush が共通で使う。
 * 成功時は作業（w）・Git 上の確認値（g: branch・head・root）・計画（plan）を返す。
 */
export function verifyPlan(cwd, state, workId, planId) {
  const w = state.works[workId];
  if (!w) return fail("invalidInput", `作業 ${workId} はこの worktree に記録がありません。`);
  if (!w.plan || typeof planId !== "string" || w.plan.planId !== planId)
    return failC("conflict", "plan-not-found", "この作業の有効な計画ではありません。公開の計画をし直してください。");
  const g = workGitState(cwd, state, w);
  if (!g.ok) return g;
  const current = versionsOf(cwd, g.root, w);
  const stored = w.plan.versions ?? {};
  for (const k of ["declaration", "restrictions", "ready", "destination"]) {
    if (current[k] !== stored[k]) return failC("conflict", `${k}-changed`, `計画の発行後に${({ declaration: "宣言", restrictions: "作業の禁止", ready: "公開の準備", destination: "push 先" })[k]}が変わったため、計画は失効しました。計画をし直してください。`);
  }
  return { ok: true, w, g, plan: w.plan };
}

// ---- push の実行と照合（4.4） ----

// 操作の結果を記録・返す際の文言。資格情報・URL・git の出力そのものは含めない
const PUSH_MESSAGES = {
  "work-restriction": "この作業では push が禁止されているため、push していません。",
  "normal-approval": "push には通常の承認が必要なため、push していません。利用者の確認を経て個別に実行してください。",
  "push-denied": "共通判定が push を拒否したため、push していません。",
  "remote-unreadable": "遠隔の状態を読めないため、push していません。通信を確認して再実行してください。",
  "push-rejected": "遠隔に別の commit があり push が拒否されました（non-fast-forward）。取り込みの状況を確認してください。",
  "remote-rejected": "遠隔（フックやルールセット）が push を拒否しました。遠隔側の設定を確認してください。",
  "push-failed": "push に失敗しました。",
  "remote-mismatch": "push の後、遠隔の ref が準備時の OID と一致しません。",
  "already-published": "同じ OID が遠隔に公開済みのため、push せず成功扱いにしました。",
};

/** git の子プロセスに渡す環境変数。資格情報の対話入力で止まらないようにし、git の出力言語を固定して拒否の判定文字列を安定させる。 */
const pushEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" });

/**
 * 遠隔の対象ブランチの OID を読む（読み取りのみ）。通信できなければ error、ref が無ければ oid: null。
 * 資格情報や URL は読まず返さない（リモート名だけで照会する）。
 */
export function remoteOidOf(cwd, remote, branch) {
  const r = spawnSync("git", ["ls-remote", remote, `refs/heads/${branch}`], { cwd, encoding: "utf8", env: pushEnv(), stdio: ["ignore", "pipe", "ignore"], timeout: 120_000 });
  if (r.error || r.status !== 0) return { error: true, oid: null };
  const hit = String(r.stdout ?? "").split("\n").map((l) => l.trim().split(/\s+/)).find((p) => p[1] === `refs/heads/${branch}`);
  return { error: false, oid: hit ? hit[0].toLowerCase() : null };
}

/**
 * push の前の確認（読み取りのみ）。対象リポジトリ・push 先の GitHub リポジトリ・登録済み宣言・開発ブランチの分類を見る。
 * 成功時は push に使うリモート名を返す。
 */
export function pushPreflight(cwd, g, w, repository) {
  const remote = remoteNameOf(cwd, g.branch);
  if (!SAFE_REMOTE_NAME.test(remote) || !SAFE_BRANCH.test(g.branch))
    return failC("invalidInput", "name-unsafe", "リモート名またはブランチ名を安全に確認できないため、push しません。");
  if (w.ready.repositoryId !== repository.id) return failC("invalidInput", "destination-mismatch", "準備時の対象リポジトリ ID と一致しません。");
  // push 先は Git が実際に使う URL（insteadOf の展開後）で確認する
  const dest = githubRepoOf(git(cwd, "remote", "get-url", "--push", remote));
  if (!dest) return failC("invalidInput", "destination-unknown", `push 先のリモート（${remote}）を GitHub のリポジトリとして確定できません。`);
  if (dest.owner.toLowerCase() !== repository.owner.toLowerCase() || dest.name.toLowerCase() !== repository.name.toLowerCase())
    return failC("invalidInput", "destination-mismatch", "push 先のリモートが指定の対象リポジトリと一致しません。");
  const loaded = loadConfig(g.root);
  if (loaded.error || !loaded.config) return failC("conflict", "declaration-invalid", loaded.error ?? "宣言ファイルがありません。規則を確認できないため push しません。");
  if (classifyBranch(loaded.config, g.branch) !== "development") return failC("conflict", "branch-not-development", `'${g.branch}' は開発ブランチではないため、push しません。`);
  return { ok: true, remote };
}

/**
 * push の可否を判定する（読み取りのみ）。
 * 禁止（作業の制限）・判定の拒否・通常確認待ち・実行（確認省略による自動 / 通常確認を経た個別）のどれかを返す。
 * push は固定の形（<OID>:refs/heads/<ブランチ>）のコマンドとして共通判定に渡し、実行するものと同じ内容を判定する。
 */
function decidePush(cwd, w, g, remote, confirmed) {
  const restrictions = restrictionsOf(w);
  if (restrictions.noPush) return { kind: "prohibited" };
  const d = evaluateAll(classifyCommand(`git push ${remote} ${g.head}:refs/heads/${g.branch}`, cwd), restrictions);
  if (d.approval === "prohibited") return { kind: "prohibited" };
  if (d.verdict === "deny" || d.compliance !== "compliant") return { kind: "denied", code: CODE.test(d.code) ? d.code : "push-denied" };
  if (d.verdict === "eligibleForApproval") return { kind: "proceed", execution: "auto" };
  if (confirmed) return { kind: "proceed", execution: "confirmed" };
  return { kind: "needsApproval" };
}

/** 確認省略で push するときは、計画にその push（リモート・ref・OID）が含まれていなければならない。計画に無い書き込みは行わない。 */
const plannedPush = (plan, g, w, remote) => (plan.writes ?? []).some((x) => x.operation === "push" && x.remote === remote && x.ref === w.ready.pushRef && x.oid === g.head);

/** 判定の結果を、記録する操作別の結果（outcome・code）に写す。 */
const outcomeOf = (d) => {
  if (d.kind === "prohibited") return { outcome: "prohibited", code: "work-restriction" };
  if (d.kind === "needsApproval") return { outcome: "needsApproval", code: "normal-approval" };
  return { outcome: "failed", code: d.code };
};

/** 呼び出し側へ返す結果。failed だけ ok:false（error に判別の code と文言）。 */
function pushResult(outcome, code) {
  if (outcome === "failed") return { ok: false, outcome, error: { kind: "conflict", code, message: PUSH_MESSAGES[code] ?? "push を行えませんでした。" } };
  return { ok: true, outcome, code };
}

/** 操作の結果を記録してから返す（記録は状態ロックを取る recordResult で行う）。記録に失敗したら、その失敗を返す。 */
function finish(cwd, workId, { outcome, code, lockWaitMs }) {
  const rec = recordResult(cwd, workId, "push", { outcome, code }, { lockWaitMs });
  if (!rec.ok) return rec;
  return pushResult(outcome, code);
}

/** 成功（遠隔の ref が準備時の OID を指す）を記録し、作業を pushed にする。記録できなかった場合は recorded: false で知らせる。 */
function finishSuccess(cwd, workId, { execution, oid, lockWaitMs }) {
  const code = execution === "auto" ? null : execution;
  // 結果の記録と「準備済み → pushed」の遷移を 1 回の状態ロックで行い、片方だけ残らないようにする
  const rec = update(cwd, (state) => {
    const w = state.works[workId];
    if (!w) return fail("invalidInput", `作業 ${workId} はこの worktree に記録がありません。`);
    w.results = w.results && typeof w.results === "object" ? w.results : {};
    w.results.push = { outcome: "success", code };
    if (w.status === "ready") w.status = "pushed";
    w.updatedAt = now();
    return { ok: true, work: w };
  }, { lockWaitMs });
  return { ok: true, outcome: "success", execution, oid, recorded: rec.ok };
}

/**
 * 計画どおりに push を行い、遠隔の ref が準備時の OID になったことを読み取りで確かめる。
 * 順序: (1) 計画・対象・宣言の確認（副作用なし） → (2) 判定と遠隔の現在の OID（既に同じ OID なら push せず成功扱い）
 *       → (3) 状態ロック内で計画・制限・判定を取り直し、操作の開始を記録 → (4) 通常 push（OID を明示）→ (5) 遠隔の ref を読んで照合。
 * 同じ worktree の公開は runPush の外側のロックで直列化する。通信中は状態ロックを保持しない。
 * 強制 push・削除・ref の glob は使わない（refspec は <OID>:refs/heads/<ブランチ> の 1 つだけ）。
 * @param {{planId: string, repository: {id: number, owner: string, name: string}, confirmed?: boolean, lockWaitMs?: number}} opts
 *   confirmed は、利用者が通常の承認を与えたときだけ true（判定が通常確認待ちの push を個別に実行する）。
 * @returns 成功・禁止による省略・通常確認待ち・失敗を outcome で返す。計画・対象の不一致など副作用の前の拒否は ok:false（記録しない）。
 */
export function runPush(cwd, workId, { planId, repository, confirmed = false, lockWaitMs } = {}) {
  const bad = idError(workId);
  if (bad) return bad;
  if (typeof confirmed !== "boolean") return failC("invalidInput", "confirmed-invalid", "通常確認の有無は真偽値で指定してください。");
  if (!repository || typeof repository !== "object" || !Number.isSafeInteger(repository.id) || repository.id <= 0 || !NAME_PART.test(repository.owner ?? "") || !NAME_PART.test(repository.name ?? ""))
    return failC("invalidInput", "repository-invalid", "対象リポジトリの ID（正の整数）・所有者・名前を指定してください。");
  const file = stateFileOf(cwd);
  if (!file) return fail("invalidInput", "Git リポジトリの中で実行してください。");
  mkdirSync(dirname(file), { recursive: true });
  // 同じ worktree の公開を 1 つずつにする。状態ロックは短く保ち、push の通信中もこのロックだけは保持する
  const runLock = `${file}.run.lock`;
  if (!acquire(runLock, lockWaitMs ?? 3000)) return failC("conflict", "publish-busy", "この worktree で別の公開が実行中です。終わってからやり直してください。");
  try {
    return pushLocked(cwd, file, workId, { planId, repository, confirmed, lockWaitMs });
  } finally {
    rmSync(runLock, { force: true });
  }
}

function pushLocked(cwd, file, workId, { planId, repository, confirmed, lockWaitMs }) {
  // (1)(2) 副作用の前の確認（読み取りのみ）
  const loaded = load(file);
  if (loaded.error) return fail("conflict", loaded.error);
  const v = verifyPlan(cwd, loaded.state, workId, planId);
  if (!v.ok) return v;
  const pre = pushPreflight(cwd, v.g, v.w, repository);
  if (!pre.ok) return pre;
  const d = decidePush(cwd, v.w, v.g, pre.remote, confirmed);
  if (d.kind === "denied") return finish(cwd, workId, { ...outcomeOf(d), lockWaitMs });

  const { head, branch } = v.g;
  const before = remoteOidOf(cwd, pre.remote, branch);
  // 既に同じ OID が遠隔にあれば push は要らない（禁止の作業でも、PR 側の処理は進めてよい）
  if (!before.error && before.oid === head) return finishSuccess(cwd, workId, { execution: "already-published", oid: head, lockWaitMs });
  if (d.kind === "prohibited") return finish(cwd, workId, { ...outcomeOf(d), lockWaitMs });
  if (d.kind === "needsApproval") return finish(cwd, workId, { ...outcomeOf(d), lockWaitMs });
  if (before.error) return finish(cwd, workId, { outcome: "failed", code: "remote-unreadable", lockWaitMs });
  if (d.execution === "auto" && !plannedPush(v.plan, v.g, v.w, pre.remote))
    return failC("conflict", "plan-push-missing", "計画に push が含まれていないため、push していません。公開の計画をし直してください。");

  // (3) 操作の開始を状態ロック内で記録する。直前に計画・制限・判定を取り直し、変わっていれば実行しない（開始後は取り消せない）
  const started = update(cwd, (state) => {
    const v2 = verifyPlan(cwd, state, workId, planId);
    if (!v2.ok) return v2;
    const pre2 = pushPreflight(cwd, v2.g, v2.w, repository);
    if (!pre2.ok) return pre2;
    const d2 = decidePush(cwd, v2.w, v2.g, pre2.remote, confirmed);
    if (d2.kind !== "proceed") {
      const stop = outcomeOf(d2);
      v2.w.results = v2.w.results && typeof v2.w.results === "object" ? v2.w.results : {};
      v2.w.results.push = { outcome: stop.outcome, code: stop.code };
      v2.w.updatedAt = now();
      return { ok: true, stop };
    }
    if (d2.execution === "auto" && !plannedPush(v2.plan, v2.g, v2.w, pre2.remote))
      return failC("conflict", "plan-push-missing", "計画に push が含まれていないため、push していません。公開の計画をし直してください。");
    const prior = v2.w.started && typeof v2.w.started === "object" ? v2.w.started : {};
    v2.w.started = { ...prior, push: { at: now(), oid: v2.g.head, execution: d2.execution } };
    v2.w.updatedAt = now();
    return { ok: true, proceed: d2, remote: pre2.remote, head: v2.g.head };
  }, { lockWaitMs });
  if (!started.ok) return started;
  if (started.stop) return pushResult(started.stop.outcome, started.stop.code);

  // (4) 通常の push。OID は状態ロック内で確認した値（started.head）を使い、refspec は 1 つだけ（強制・削除・glob は使わない）。
  // タグ・サブモジュールは対象外にして、この push の範囲を明示の ref に限る
  const pushHead = started.head;
  const p = spawnSync("git", ["push", "--no-follow-tags", "--no-recurse-submodules", started.remote, `${pushHead}:refs/heads/${branch}`], { cwd, encoding: "utf8", env: pushEnv(), stdio: ["ignore", "ignore", "pipe"], timeout: 600_000 });

  // (5) 遠隔の ref を読んで照合する（応答が無くても、遠隔が同じ OID なら成功として扱う）
  const after = remoteOidOf(cwd, started.remote, branch);
  if (!after.error && after.oid === pushHead) return finishSuccess(cwd, workId, { execution: started.proceed.execution, oid: pushHead, lockWaitMs });
  // 分岐（non-fast-forward・fetch first）と、遠隔のフック・ルールセットによる拒否を区別する
  const text = String(p.stderr ?? "");
  const code = after.error ? "remote-unreadable"
    : p.status === 0 ? "remote-mismatch"
      : /non-fast-forward|fetch first/.test(text) ? "push-rejected"
        : /remote rejected|hook declined|pre-receive|update hook/.test(text) ? "remote-rejected"
          : "push-failed";
  return finish(cwd, workId, { outcome: "failed", code, lockWaitMs });
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
export function restrictionsOf(work) {
  const r = work?.restrictions;
  if (!r || typeof r !== "object" || Array.isArray(r) || typeof r.noPush !== "boolean" || typeof r.noPr !== "boolean") return { noPush: true, noPr: true };
  return { noPush: r.noPush, noPr: r.noPr };
}
