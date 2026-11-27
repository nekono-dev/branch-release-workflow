// 完了公開の PR 再利用・作成（brw-enforcement 4.5）:
// 遠隔の対象ブランチと取り込み先を確認し、保護対象への公開だけ計画内の PR を作成する（同じ head・base の PR があれば再利用する）。
// 開発間（publication が push）は push の完了で公開を終え、GitHub へは通信しない。
// 順序: (1) 副作用の前の確認（計画・宣言・push 先・遠隔の OID、読み取りのみ）→ (2) GitHub の読み取り（対象の照合・既存 PR の検索・draft の確認）
//       → (3) 状態ロック内で計画・制限・判定を取り直し、操作の開始（started.pr）を記録 → (4) PR の作成 → (5) 応答の照合。
// 応答喪失（reconcile）・再試行では、既存 PR を取り直して head・base・OID・URL を照合する。
// GitHub への書き込みは createGitHubSession の createPull だけを使う。読み取りは検索・取得・対象の照合だけ。
// 同じ worktree の公開は .run.lock で直列化する。状態ロックは GitHub の通信中には保持しない。
// PR の本文・資格情報は記録しない（記録するのは outcome・code・https の PR URL だけ）。
// 外部依存なし（Node 標準ライブラリのみ）。
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { classifyBranch, loadConfig } from "./lib.mjs";
import { classifyCommand } from "./operation-policy.mjs";
import { evaluateAll } from "./operation-decision.mjs";
import {
  acquire, failC, fail, idError, load, now, pushPreflight, readWork, recordResult, remoteOidOf, restrictionsOf, safeUrl, SAFE_BRANCH, stateFileOf, update, verifyPlan,
} from "./publish.mjs";

const CODE = /^[a-z][a-z0-9-]{0,39}$/;
const TITLE_MAX = 256;
const BODY_MAX = 65536;

// 利用者へ返す文言。資格情報・URL・GitHub の応答の本文は含めない
const PR_MESSAGES = {
  "work-restriction": "この作業では PR 作成が禁止されているため、PR を作成していません。",
  "normal-approval": "PR 作成には通常の承認が必要なため、作成していません。利用者の確認を経て個別に実行してください。",
  "pr-denied": "共通判定が PR 作成を拒否したため、作成していません。",
  "remote-unreadable": "遠隔の状態を読めないため、PR を作成していません。通信を確認して再実行してください。",
  "remote-mismatch": "遠隔の対象ブランチが準備時の commit と一致しません。先に push を完了してから再実行してください。",
  "integration-missing": "取り込み先のブランチが遠隔にありません。取り込み先を確認してください。",
  "pr-draft": "同じ head・base の既存 PR が draft のため、完了として扱いません。GitHub で Ready for review にしてから再実行してください。",
  "pr-ambiguous": "同じ head・base の PR が複数あり、一意に確定できません。GitHub で確認してください。",
  "base-conflict": "同じ head の既存 PR が別の取り込み先を指しているため、PR を作成しません。取り込み先を確認してください。",
  "pr-unconfirmed": "PR の状態を確定できませんでした。再実行すると GitHub を照合して結果を確定します。",
  "pr-mismatch": "作成された PR が準備時の内容と一致しません。作成された PR を GitHub で確認してください（完了とは記録していません）。",
  "plan-pr-missing": "計画に PR の作成が含まれていないため、作成していません。公開の計画をし直してください。",
  "pr-title-required": "PR のタイトルを指定してください（作成前に利用者へ求めてください）。",
  "remote-unreadable-push": "遠隔の状態を読めないため、公開を完了にしません。通信を確認して再実行してください。",
};

const NOTICE_PUSH = "開発ブランチへの取り込みは push で完了しています。PR は作成しません。";
const noticePr = (base) => `GitHub 上で PR を開き、取り込み先 ${base} へ squash マージしてください。BRW は GitHub のマージを行いません。`;

const msgOf = (code) => PR_MESSAGES[code] ?? (code.startsWith("pr-") ? `GitHub が PR の操作を受け付けませんでした（${code.slice(3)}）。` : "PR を作成できませんでした。");
const shellQuote = (s) => `'${s.replace(/'/g, "'\\''")}'`;
const eqi = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
const validTitle = (t) => typeof t === "string" && t.trim() !== "" && t.trim().length <= TITLE_MAX && !/[\r\n\u0000]/.test(t);
/** GitHub クライアントの失敗（kind）を、記録する判別の code にする。 */
const codeOfFailure = (f) => (f?.kind ? `pr-${f.kind}` : "pr-unconfirmed");

/** 作業の push の結果（results.push）。無ければ null。 */
const pushOf = (cwd, workId) => {
  const r = readWork(cwd, workId);
  return r.ok ? r.work.results?.push ?? null : null;
};

/** 操作の結果を返す。failed だけ ok:false（error に判別の code と文言）。push の結果は常に添える。 */
function outcomeReturn(cwd, workId, outcome, code, extra = {}) {
  const push = pushOf(cwd, workId);
  if (outcome === "failed") return { ok: false, outcome, error: { kind: "conflict", code, message: msgOf(code) }, push, ...extra };
  return { ok: true, outcome, code, push, ...extra };
}

/** 操作の結果を記録してから返す（記録は状態ロックを取る recordResult で行う）。 */
function finishPr(cwd, workId, { outcome, code, lockWaitMs, extra }) {
  const rec = recordResult(cwd, workId, "pr", { outcome, code: code ?? null }, { lockWaitMs });
  if (!rec.ok) return rec;
  return outcomeReturn(cwd, workId, outcome, code, extra);
}

/** 判定の結果（禁止・通常確認待ち・拒否）を、記録する操作別の結果（outcome・code）に写す。 */
const stopOf = (d) => {
  if (d.kind === "prohibited") return ["prohibited", "work-restriction"];
  if (d.kind === "needsApproval") return ["needsApproval", "normal-approval"];
  return ["failed", d.code];
};

/** 作業の PR の結果を、状態ロック内で書く（URL は https の正規化済みのものだけ残す）。 */
function setPrResult(w, outcome, code, url, base) {
  w.results = w.results && typeof w.results === "object" ? w.results : {};
  const r = { outcome, code: code ?? null };
  const u = url ? safeUrl(url) : null;
  if (u) r.url = u;
  // 公開記録: 成功した PR の取り込み先（片付けが PR の事実として使う）
  if (outcome === "success" && typeof base === "string" && SAFE_BRANCH.test(base)) r.base = base;
  w.results.pr = r;
}

/** 作業を公開済みにする。公開済みになった作業は現在の作業から外し、セッションの関連付けも外す。 */
function completeWork(state, w, workId) {
  w.status = "published";
  delete w.sessionId;
  w.updatedAt = now();
  if (state.current === workId) state.current = null;
}

/**
 * 判定（共通判定 evaluateAll）を実際の作成引数で取り直す。push と同じく、禁止を最初に見る。
 * 作成引数（--base・--head・--title）で gh pr create として判定するため、タイトルも判定の入力に含める。
 */
function decidePr(cwd, w, { base, branch, title, repository }, confirmed) {
  const restrictions = restrictionsOf(w);
  if (restrictions.noPr) return { kind: "prohibited" };
  const cmd = `gh pr create --repo ${repository.owner}/${repository.name} --base ${base} --head ${branch} --title ${shellQuote(title)}`;
  const d = evaluateAll(classifyCommand(cmd, cwd), restrictions, { origin: "brw-publish" });
  if (d.approval === "prohibited") return { kind: "prohibited" };
  if (d.verdict === "deny" || d.compliance !== "compliant") return { kind: "denied", code: CODE.test(d.code) ? d.code : "pr-denied" };
  if (d.verdict === "eligibleForApproval") return { kind: "proceed", execution: "auto" };
  if (confirmed) return { kind: "proceed", execution: "confirmed" };
  return { kind: "needsApproval" };
}

/** 確認省略で作成するときは、計画に同じ PR（取り込み先・head・対象リポジトリ）が含まれていなければならない。 */
const plannedPr = (plan, base, branch, repoId) => (plan.writes ?? []).some((x) => x.operation === "pr" && x.base === base && x.head === branch && x.repositoryId === repoId);

/**
 * 同じ head（対象リポジトリの同じブランチ）の開いている PR を、取り込み先を絞らずに読む（読み取りのみ）。
 * 成功時は head の一致する PR（同じリポジトリのもの）の一覧を返す。
 */
async function listHeads(session, target, branch) {
  const r = await session.request(target, "GET", `/repos/${target.owner}/${target.name}/pulls?state=open&head=${target.owner}:${branch}&per_page=100`);
  if (!r.ok) return { ok: false, failure: r };
  if (!Array.isArray(r.body)) return { ok: false, failure: { kind: "unknown-input" } };
  const repoName = `${target.owner}/${target.name}`;
  return { ok: true, heads: r.body.filter((p) => p?.head?.ref === branch && eqi(p.head?.repo?.full_name, repoName)) };
}

/**
 * GitHub の読み取りで既存 PR の状態を決める（読み取りのみ。CLI の準備・計画でも同じ判定を使う）。
 * 結果: none（無い）・reuse（同じ head・base・OID・URL で、draft ではない）・blocked（成功扱いにできない理由の code）。
 * 同じ head で別の取り込み先の PR があれば base-conflict、draft は再利用しない（pr-draft）。
 */
export async function existingPr(session, target, { branch, base, head }) {
  const listed = await listHeads(session, target, branch);
  if (!listed.ok) return { state: "blocked", code: codeOfFailure(listed.failure) };
  const { heads } = listed;
  if (heads.some((p) => p.base?.ref !== base)) return { state: "blocked", code: "base-conflict" };
  if (heads.length === 0) return { state: "none" };
  if (heads.length > 1) return { state: "blocked", code: "pr-ambiguous" };
  const [raw] = heads;
  if (typeof raw.draft !== "boolean") return { state: "blocked", code: "pr-unconfirmed" };
  if (raw.draft) return { state: "blocked", code: "pr-draft" };
  // 同じ head・base・OID・URL を、クライアントの照合（findOpenPull）で確かめる
  const found = await session.findOpenPull(target, { headRef: branch, baseRef: base, headOid: head });
  if (!found.ok) return { state: "blocked", code: codeOfFailure(found) };
  if (!found.pull || found.pull.number !== raw.number) return { state: "blocked", code: "pr-unconfirmed" };
  return { state: "reuse", pull: found.pull };
}

/** 失敗の結果（kind・判別の code・利用者への文言）を作る。 */
const failure = (kind, code, extra = {}) => ({ ok: false, kind, code, message: msgOf(code), ...extra });
/** 入力の誤りの結果。 */
const invalid = (code, message) => ({ ok: false, kind: "invalidInput", code, message });

/**
 * 同じ取り込み元・取り込み先のオープンな PR を、作業の記録（作業 ID・状態・計画・ロック）に依存せず、探索・再利用・作成・照合する（brw-pr-handoff 7.1）。
 * 順序: 対象の照合 → 既存 PR の探索（同じ head・base が 1 件なら再利用）→ beforeCreate（作成の直前の確認）→ 作成 → 作成後の照合。
 * 応答喪失（reconcile）では既存 PR を取り直して照合し、一致すれば二重に作らず reconciled として返す。
 * GitHub への書き込みは session.createPull だけ。
 * @param {object} session createGitHubSession の結果
 * @param {{id: number, owner: string, name: string}} target 対象リポジトリ
 * @param {{branch: string, base: string, headOid: string, title?: string, body?: string, beforeCreate?: () => (null | object)}} input
 *   branch: 取り込み元のブランチ名（head）。base: 取り込み先のブランチ名。headOid: 取り込み元の commit（OID）。
 *   title: 新規作成のときに必須（再利用では不要）。
 *   beforeCreate: 既存 PR が無く作成が必要なときだけ、作成の直前に呼ぶ。null を返せば続行し、結果オブジェクトを返せば作成せずにそれを返す。
 * @returns 成功 {ok:true, reused, created, reconciled, pull}。
 *   失敗 {ok:false, kind, code, message, ...}。kind は "failed"（GitHub の失敗・食い違い・複数候補。code を持つ）・"invalidInput"（入力の誤り）、
 *   または beforeCreate が返した "prohibited"・"needsApproval" など。作成後の食い違いは createdUrl と differences を添える。
 */
export async function createOrReusePr(session, target, input = {}) {
  const { branch, base, headOid, title, body, beforeCreate } = input;
  if (!session || typeof session.confirmTarget !== "function" || typeof session.request !== "function" || typeof session.findOpenPull !== "function" || typeof session.createPull !== "function")
    return invalid("session-invalid", "GitHub のクライアントを指定してください。");
  if (body !== undefined && (typeof body !== "string" || body.length > BODY_MAX)) return invalid("body-invalid", "PR の本文は文字列（64 KiB 以内）で指定してください。");
  if (title !== undefined && !validTitle(title)) return invalid("title-invalid", "PR のタイトルは 1 行の空でない文字列（256 文字以内）で指定してください。");

  // (a) 対象の照合（読み取りのみ）
  const t = { host: session.host, owner: target.owner, name: target.name, repositoryId: target.id };
  const confirmedTarget = await session.confirmTarget(t);
  if (!confirmedTarget.ok) return failure("failed", codeOfFailure(confirmedTarget));

  // (b) 既存 PR の探索: 同じ head・base が 1 件なら再利用して完了（書き込みは無い）
  const ex = await existingPr(session, t, { branch, base, head: headOid });
  if (ex.state === "blocked") return failure("failed", ex.code);
  if (ex.state === "reuse") return { ok: true, reused: true, created: false, reconciled: false, pull: ex.pull };

  // (c) 作成の直前の確認（呼び出し側の判定・記録）。止めるなら作成せず、その結果を返す
  if (beforeCreate) {
    const stop = await beforeCreate();
    if (stop) return stop;
  }
  if (title === undefined) return invalid("pr-title-required", PR_MESSAGES["pr-title-required"]);

  // (d) 作成（書き込みは createPull だけ）。本文は指定があるときだけ送る
  const made = await session.createPull(t, {
    title: title.trim(),
    ...(body !== undefined ? { body } : {}),
    headRef: branch,
    baseRef: base,
    headOid,
  });

  // (e) 応答の照合
  if (made.ok) return { ok: true, reused: false, created: true, reconciled: false, pull: made.pull };
  if (made.created) {
    // 作成後に食い違い: 作成済みの URL と差異を報告するが、成功とは扱わない
    return { ...failure("failed", "pr-mismatch"), createdUrl: made.createdUrl ?? null, differences: made.differences ?? [] };
  }
  if (made.reconcile) {
    // 応答喪失・競合: 既存 PR を取り直して照合する（二重に作らない）
    const re = await existingPr(session, t, { branch, base, head: headOid });
    if (re.state === "reuse") return { ok: true, reused: false, created: false, reconciled: true, pull: re.pull };
    return failure("failed", re.state === "blocked" ? re.code : "pr-unconfirmed");
  }
  return failure("failed", codeOfFailure(made));
}

/**
 * 保護対象への公開で PR を作成するか、既存の PR を再利用して完了する。
 * @param {{planId: string, repository: {id: number, owner: string, name: string}, session?: object, confirmed?: boolean, title?: string, body?: string, lockWaitMs?: number}} opts
 *   session は createGitHubSession の結果（PR の公開でだけ使う）。開発間の公開では不要。
 *   confirmed は、利用者が通常の承認を与えたときだけ true。
 *   title は作成時に必須（既存 PR の再利用では不要）。無ければ pr-title-required で止め、書き込まない。
 * @returns 完了（success）・禁止・通常確認待ちは outcome で返す。拒否・失敗は ok:false（error に code と文言）。
 *   push の結果（results.push）は、PR だけ失敗した場合も常に添える。
 */
export async function runPublishPr(cwd, workId, opts = {}) {
  const { planId, repository, confirmed = false, title, body, lockWaitMs } = opts;
  const bad = idError(workId);
  if (bad) return bad;
  if (typeof confirmed !== "boolean") return failC("invalidInput", "confirmed-invalid", "通常確認の有無は真偽値で指定してください。");
  if (!repository || typeof repository !== "object" || !Number.isSafeInteger(repository.id) || repository.id <= 0 || !/^[A-Za-z0-9_.-]{1,100}$/.test(repository.owner ?? "") || !/^[A-Za-z0-9_.-]{1,100}$/.test(repository.name ?? ""))
    return failC("invalidInput", "repository-invalid", "対象リポジトリの ID（正の整数）・所有者・名前を指定してください。");
  if (title !== undefined && !validTitle(title)) return failC("invalidInput", "title-invalid", "PR のタイトルは 1 行の空でない文字列（256 文字以内）で指定してください。");
  if (body !== undefined && (typeof body !== "string" || body.length > BODY_MAX)) return failC("invalidInput", "body-invalid", "PR の本文は文字列（64 KiB 以内）で指定してください。");
  const file = stateFileOf(cwd);
  if (!file) return fail("invalidInput", "Git リポジトリの中で実行してください。");
  mkdirSync(dirname(file), { recursive: true });
  // 同じ worktree の公開を 1 つずつにする（push と同じ .run.lock）
  const runLock = `${file}.run.lock`;
  if (!acquire(runLock, lockWaitMs ?? 3000)) return failC("conflict", "publish-busy", "この worktree で別の公開が実行中です。終わってからやり直してください。");
  try {
    return await prLocked(cwd, file, workId, { planId, repository, session: opts.session, confirmed, title, body, lockWaitMs });
  } finally {
    rmSync(runLock, { force: true });
  }
}

async function prLocked(cwd, file, workId, o) {
  const { planId, repository, session, confirmed, title, body, lockWaitMs } = o;

  // (1) 副作用の前の確認（読み取りのみ）
  const loaded = load(file);
  if (loaded.error) return fail("conflict", loaded.error);
  const v = verifyPlan(cwd, loaded.state, workId, planId);
  if (!v.ok) return v;
  const pre = pushPreflight(cwd, v.g, v.w, repository);
  if (!pre.ok) return pre;
  const { head, branch, root } = v.g;
  const { ref: base, kind } = v.w.ready.integration;
  const publication = v.w.ready.publication;
  const remote = pre.remote;

  // 遠隔の対象ブランチが準備時の OID であることを確かめる（push 済み・手動 push 済みのどちらも、この読み取りで判断する）
  const remoteHead = remoteOidOf(cwd, remote, branch);

  // 開発間: push の完了で公開を終える。GitHub へは通信しない
  if (publication === "push") {
    if (remoteHead.error) return failC("conflict", "remote-unreadable", PR_MESSAGES["remote-unreadable-push"]);
    if (remoteHead.oid !== head) return failC("conflict", "remote-mismatch", PR_MESSAGES["remote-mismatch"]);
    const done = update(cwd, (state) => {
      const v2 = verifyPlan(cwd, state, workId, planId);
      if (!v2.ok) return v2;
      completeWork(state, v2.w, workId);
      return { ok: true, work: v2.w };
    }, { lockWaitMs });
    if (!done.ok) return done;
    return { ok: true, outcome: "success", publication, base, repository: { owner: repository.owner, name: repository.name }, pr: null, push: done.work.results?.push ?? null, notice: NOTICE_PUSH };
  }

  // 保護対象への公開: 取り込み先の分類・遠隔の状態を確かめてから GitHub へ進む
  if (!SAFE_BRANCH.test(base) || !SAFE_BRANCH.test(branch)) return failC("invalidInput", "name-unsafe", "ブランチ名を安全に確認できないため、PR を扱いません。");
  const loadedCfg = loadConfig(root);
  if (loadedCfg.error || !loadedCfg.config) return failC("conflict", "declaration-invalid", loadedCfg.error ?? "宣言ファイルがありません。規則を確認できないため PR を扱いません。");
  if (classifyBranch(loadedCfg.config, base) !== kind) return failC("conflict", "integration-changed", "取り込み先の分類が準備時と一致しません。公開の準備をし直してください。");
  if (remoteHead.error) return finishPr(cwd, workId, { outcome: "failed", code: "remote-unreadable", lockWaitMs });
  if (remoteHead.oid !== head) return failC("conflict", "remote-mismatch", PR_MESSAGES["remote-mismatch"]);
  const baseRemote = remoteOidOf(cwd, remote, base);
  if (baseRemote.error) return finishPr(cwd, workId, { outcome: "failed", code: "remote-unreadable", lockWaitMs });
  if (baseRemote.oid === null) return failC("conflict", "integration-missing", PR_MESSAGES["integration-missing"]);

  // (2)〜(5) GitHub の照合・既存 PR の再利用・作成・照合は createOrReusePr が行う。
  // 作成の直前に、禁止・タイトル・判定・操作の開始の記録を確かめる（既存 PR の再利用では呼ばない）
  const titleText = title === undefined ? undefined : title.trim();
  const gate = () => {
    if (restrictionsOf(v.w).noPr) return { ok: false, kind: "prohibited", code: "work-restriction" };
    if (title === undefined) return invalid("pr-title-required", PR_MESSAGES["pr-title-required"]);
    const d = decidePr(cwd, v.w, { base, branch, title: titleText, repository }, confirmed);
    if (d.kind !== "proceed") {
      const [outcome, code] = stopOf(d);
      return { ok: false, kind: outcome, code };
    }
    // (3) 状態ロック内で計画・制限・判定を取り直し、操作の開始を記録する（開始後は取り消せない）
    const started = update(cwd, (state) => {
      const v2 = verifyPlan(cwd, state, workId, planId);
      if (!v2.ok) return v2;
      const pre2 = pushPreflight(cwd, v2.g, v2.w, repository);
      if (!pre2.ok) return pre2;
      const d2 = decidePr(cwd, v2.w, { base, branch, title: titleText, repository }, confirmed);
      if (d2.kind !== "proceed") {
        const [outcome, code] = stopOf(d2);
        setPrResult(v2.w, outcome, code, null);
        v2.w.updatedAt = now();
        return { ok: true, stop: { outcome, code } };
      }
      if (d2.execution === "auto" && !plannedPr(v2.plan, base, branch, repository.id))
        return failC("conflict", "plan-pr-missing", PR_MESSAGES["plan-pr-missing"]);
      const prior = v2.w.started && typeof v2.w.started === "object" ? v2.w.started : {};
      v2.w.started = { ...prior, pr: { at: now(), headOid: head, base, execution: d2.execution } };
      v2.w.updatedAt = now();
      return { ok: true, proceed: d2 };
    }, { lockWaitMs });
    if (!started.ok) return { ok: false, kind: "raw", error: started.error };
    // 状態ロック内で止めた結果は、そこで記録済み
    if (started.stop) return { ok: false, kind: "recorded", outcome: started.stop.outcome, code: started.stop.code };
    return null;
  };

  const made = await createOrReusePr(session, repository, { branch, base, headOid: head, title: titleText, body, beforeCreate: gate });
  if (!made.ok) {
    if (made.kind === "raw") return { ok: false, error: made.error };
    if (made.kind === "recorded") return outcomeReturn(cwd, workId, made.outcome, made.code);
    if (made.kind === "invalidInput") return failC(made.kind, made.code, made.message);
    return finishPr(cwd, workId, {
      outcome: made.kind,
      code: made.code,
      lockWaitMs,
      extra: "differences" in made ? { createdUrl: made.createdUrl, differences: made.differences } : undefined,
    });
  }
  const code = made.reused ? "reused" : made.reconciled ? "reconciled" : null;
  return completePr(cwd, workId, { pull: made.pull, created: made.created, reconciled: made.reconciled, code, base, repository, lockWaitMs });
}

/** PR が成立した（作成・再利用・照合）ことを記録し、作業を公開済みにする。 */
function completePr(cwd, workId, { pull, created, reconciled, code, base, repository, lockWaitMs }) {
  const rec = update(cwd, (state) => {
    const w = state.works[workId];
    if (!w) return fail("invalidInput", `作業 ${workId} はこの worktree に記録がありません。`);
    if (w.status !== "ready" && w.status !== "pushed") return failC("conflict", "work-status", `作業の状態が ${w.status} のため、PR の結果を記録できません。`);
    setPrResult(w, "success", code, pull.url, base);
    completeWork(state, w, workId);
    return { ok: true, work: w };
  }, { lockWaitMs });
  if (!rec.ok) return rec;
  return {
    ok: true,
    outcome: "success",
    publication: "pr",
    base,
    repository: { owner: repository.owner, name: repository.name },
    pr: { number: pull.number, url: pull.url, created, reused: code === "reused", reconciled },
    push: rec.work.results?.push ?? null,
    notice: noticePr(base),
  };
}
