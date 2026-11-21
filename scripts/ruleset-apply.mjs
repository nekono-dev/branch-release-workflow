// Ruleset の再利用と追加（brw-enforcement 5.3）。
// 導入を選んだ対象について、各分岐元に既存の有効なルールがあれば再利用する（書き込みゼロ）。
// 不足している分岐元だけを対象に、完全な ref 指定・PR 必須・squash 限定・バイパスなし・有効の Ruleset を 1 件追加する。
// 既存の Ruleset は更新・削除しない。事前検査（5.2 の runRulesetPreflight）が通らなければ書き込まない。
// 適用はローカルのロック（publish.mjs の acquire と同じ方式）で直列化する。作成した ID は ruleset-choice の recordApplied で記録する。
// 応答が届かない・409/422・作成結果の食い違いでは一覧と詳細を再取得して照合し、同条件の候補が複数なら保留する（再送しない）。
// 資格情報は結果にも記録にも含めない。GitHub への書き込みは createGitHubSession の createRuleset だけを使う。
// 外部依存なし（Node 標準ライブラリと同じ scripts の既存モジュールのみ）。
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { acquire } from "./publish.mjs";
import { choiceFileOf, recordApplied, recordChoice, resolveChoice } from "./ruleset-choice.mjs";
import { runRulesetPreflight } from "./ruleset-preflight.mjs";

/** BRW が作る Ruleset の名前。同条件の候補を識別するために使う（名前だけでは識別しない）。 */
export const RULESET_NAME = "brw-pr-squash";

/** 追加する pull_request ルールの指定。PR 必須と squash 限定だけを課し、既存のレビュー・チェックは別のルールに任せる。 */
const PR_PARAMETERS = {
  allowed_merge_methods: ["squash"],
  dismiss_stale_reviews_on_push: false,
  require_code_owner_review: false,
  require_last_push_approval: false,
  required_approving_review_count: 0,
  required_review_thread_resolution: false,
};

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/** 追加する Ruleset の本文。include は完全な refs/heads/<名前> に限る（検証は createRuleset 側でも行う）。 */
export const rulesetBodyOf = (refs) => ({
  name: RULESET_NAME,
  target: "branch",
  enforcement: "active",
  bypass_actors: [],
  conditions: { ref_name: { include: [...refs].sort().map((r) => `refs/heads/${r}`), exclude: [] } },
  rules: [{ type: "pull_request", parameters: structuredClone(PR_PARAMETERS) }],
});

/** rules が「PR 必須かつ許可マージ方式が squash だけ」の 1 件だけか。 */
const squashOnlyPr = (rules) => Array.isArray(rules)
  && rules.length === 1
  && rules[0]?.type === "pull_request"
  && isObj(rules[0].parameters)
  && Array.isArray(rules[0].parameters.allowed_merge_methods)
  && rules[0].parameters.allowed_merge_methods.length === 1
  && rules[0].parameters.allowed_merge_methods[0] === "squash";

/**
 * 応答の Ruleset（parseRuleset の形）が、追加を要求した内容どおりか。差異の説明を返す（空なら一致）。
 * 対象・有効化・所有元・バイパスなし・適用 ref の完全一致・squash 限定を確かめる。
 */
const shapeDifferences = (rs, refs, target) => {
  const d = [];
  if (rs.target !== "branch") d.push("target が branch ではない");
  if (rs.enforcement !== "active") d.push("enforcement が active ではない");
  if (rs.sourceType !== "Repository" || !same(rs.source ?? "", `${target.owner}/${target.name}`)) d.push("所有元が対象リポジトリではない");
  if (!Array.isArray(rs.bypassActors) || rs.bypassActors.length) d.push("バイパスが空ではない、または確認できない");
  const want = [...refs].sort().map((r) => `refs/heads/${r}`);
  const inc = rs.conditions?.ref_name?.include;
  if (!(Array.isArray(inc) && JSON.stringify([...inc].sort()) === JSON.stringify(want))) d.push("適用する ref が要求と異なる");
  const ex = rs.conditions?.ref_name?.exclude;
  if (Array.isArray(ex) && ex.length) d.push("除外する ref がある");
  if (!squashOnlyPr(rs.rules)) d.push("PR 必須かつ squash 限定のルールになっていない");
  return d;
};

/** 結果を組み立てる。ok は追加または再利用が確定したときだけ true。 */
const out = (status, extra = {}) => ({ ok: status === "applied" || status === "reused", status, ...extra });
/** 事前検査の項目を、結果に出せる形に絞る（session などの接続情報は含めない）。 */
const summarize = (checks) => checks.map(({ id, status, reason, remedy }) => ({ id, status, reason, ...(remedy ? { remedy } : {}) }));

/** 入力を検査する。通らなければ理由。 */
const validateInput = (input) => {
  const { session, target, refs, authKind } = input ?? {};
  if (!session || typeof session.createRuleset !== "function" || typeof session.listRulesets !== "function") return { error: "GitHub の接続（session）が指定されていません。" };
  if (!target || typeof target.host !== "string" || typeof target.owner !== "string" || typeof target.name !== "string") return { error: "対象（host・owner・name）の指定が正しくありません。" };
  if (!Array.isArray(refs) || refs.length === 0 || !refs.every((x) => typeof x === "string")) return { error: "分岐元の指定が正しくありません。" };
  return { session, target: { host: target.host, owner: target.owner, name: target.name }, refs: [...new Set(refs)].sort(), authKind };
};

/** 選択の読み取り結果を、適用の結果へ写す（選択待ち・見送りは書き込まない）。 */
const fromChoice = (c) => c.status === "skipped"
  ? out("skipped", { reason: "見送りの選択のため Ruleset は適用しない（GitHub の認証は不要）" })
  : out("pending", { reason: c.reason, knownRulesetIds: c.knownRulesetIds ?? [] });

/** 作成（または照合で確認）した Ruleset の ID を選択とは別に記録する。記録の失敗は適用の成否に影響させない（ID は結果に返す）。 */
const recordCreated = (cwd, base, repositoryId, rulesetId, differences, includedRefs, extra = {}) => {
  const rec = recordApplied(cwd, { ...base, repositoryId, rulesetId });
  const info = { rulesetId, recorded: rec.ok, ...(rec.ok ? {} : { recordError: rec.error.message }), includedRefs: includedRefs.map((r) => `refs/heads/${r}`), ...extra };
  if (differences.length) return out("mismatch", { ...info, differences, remedy: "作成された Ruleset が要求と一致しない。GitHub 上で ID を確認し、管理者が扱いを決める（BRW は既存の Ruleset を更新・削除しない）" });
  return out("applied", info);
};

/**
 * 応答が不確かな追加を、一覧と詳細の再取得で照合する。再送はしない。
 * 同条件（名前・対象・本文の一致）の候補が 1 件なら、それを作成済みとして記録する。複数なら保留する。
 */
const reconcile = async (cwd, session, target, base, repositoryId, refs, failure) => {
  const list = await session.listRulesets(target);
  if (!list.ok) return out("unknown", { reason: `応答を確かめるための Ruleset 一覧を読めない（${list.kind}）。追加は保留する`, remedy: "読み取り権限を確認し、GitHub 上の Ruleset を見てから再実行する" });
  const cands = list.rulesets.filter((x) => x.name === RULESET_NAME && x.target === "branch" && x.enforcement === "active" && x.sourceType === "Repository" && same(x.source ?? "", `${target.owner}/${target.name}`));
  const matched = [];
  for (const c of cands) {
    const d = await session.getRuleset(target, c.id);
    if (!d.ok) return out("unknown", { reason: `候補 ${c.id} の詳細を読めない（${d.kind}）。追加は保留する`, candidateIds: cands.map((x) => x.id), remedy: "Ruleset の読み取り権限を確認して再実行する" });
    if (shapeDifferences(d.ruleset, refs, target).length === 0) matched.push(d.ruleset.id);
  }
  if (matched.length === 1) return recordCreated(cwd, base, repositoryId, matched[0], [], refs, { reconciled: true });
  if (matched.length > 1) return out("conflict", { candidateIds: matched, reason: "同じ条件の Ruleset が複数ある。どれを残すかを管理者が決めてから記録する（追加の書き込みは保留）" });
  if (failure.status === 409 || failure.status === 422) return out("rejected", { kind: failure.kind, httpStatus: failure.status, reason: failure.reason });
  return out("unknown", { reason: "応答が届かず、再取得で同じ条件の Ruleset は見つからなかった。追加は保留し、GitHub 上の状態を確かめてから再実行する", candidateIds: [] });
};

/** ロックの中で行う本体。 */
const applyLocked = async (cwd, session, target, refs, authKind, base) => {
  // ロックの中で選択を読み直す（別の適用が記録を変えていないことを確かめる）
  const sel = resolveChoice(cwd, base);
  if (!sel.ok) return out("invalidInput", { reason: sel.error.message });
  if (sel.status !== "selected") return fromChoice(sel);

  // 分岐元ごとに事前検査する（読み取りのみ）。1 つでも通らなければ書き込まない
  const reusedRulesetIds = {};
  const missing = [];
  let repositoryId = null;
  for (const ref of refs) {
    const p = await runRulesetPreflight(session, target, ref, { authKind, knownRulesetIds: sel.appliedRulesetIds });
    if (!p.writeAllowed) {
      const status = p.verdict === "blocked" ? "blocked" : "unknown";
      return out(status, { branch: ref, reason: "事前検査が通らないため Ruleset を変更しない", checks: summarize(p.checks.filter((c) => c.status !== "ok")) });
    }
    if (repositoryId !== null && repositoryId !== p.target.repositoryId) return out("conflict", { reason: "分岐元ごとに GitHub のリポジトリ ID が一致しない" });
    repositoryId = p.target.repositoryId;
    if (p.existing.reusable.length) reusedRulesetIds[ref] = p.existing.reusable;
    else missing.push(ref);
  }

  // 確認した GitHub のリポジトリ ID を選択に結び付け、保存済みの ID と食い違えば選択待ちにする
  const withId = resolveChoice(cwd, { ...base, repositoryId });
  if (!withId.ok) return out("invalidInput", { reason: withId.error.message });
  if (withId.status !== "selected") return fromChoice(withId);
  const saved = recordChoice(cwd, { ...base, repositoryId, enabled: true });
  if (!saved.ok) return out("conflict", { reason: saved.error.message });

  if (missing.length === 0) return out("reused", { repositoryId, reusedRulesetIds });

  // 不足分だけを追加する。送信で例外が出た場合は通信していない（本文の不備など）
  let r;
  try {
    r = await session.createRuleset(target, rulesetBodyOf(missing));
  } catch (e) {
    return out("rejected", { reason: `Ruleset の本文を送れない（${e.name ?? "例外"}）` });
  }
  if (r.created && r.ruleset) return recordCreated(cwd, base, repositoryId, r.ruleset.id, shapeDifferences(r.ruleset, missing, target), missing, { reusedRulesetIds });
  // 食い違いで作成された（client が作成済み ID を返す）。作成済みとして記録し、保留の結果にする
  if (r.created) return recordCreated(cwd, base, repositoryId, r.createdId, r.differences ?? ["作成結果が要求と一致しない"], missing, { reusedRulesetIds });
  if (!r.reconcile) return out("rejected", { kind: r.kind, httpStatus: r.status, reason: r.reason });
  return reconcile(cwd, session, target, base, repositoryId, missing, r);
};

/**
 * 導入を選んだ対象の Ruleset を再利用または追加する。
 * @param {string} cwd 対象リポジトリ（Git の中）
 * @param {{session: object, target: {host: string, owner: string, name: string}, refs: string[], authKind?: string}} input
 *   session は createGitHubSession で作ったもの（資格情報は呼び出し側で固定する）。refs は恒常的な分岐元（refs/heads/ を含まない）。
 * @param {{lockWaitMs?: number}} [opt]
 * @returns {Promise<object>} status は applied・reused・skipped・pending・blocked・unknown・conflict・rejected・mismatch・invalidInput のいずれか。
 */
export async function applyRuleset(cwd, input = {}, { lockWaitMs = 3000 } = {}) {
  const v = validateInput(input);
  if (v.error) return out("invalidInput", { reason: v.error });
  const { session, target, refs, authKind } = v;
  const base = { host: target.host, owner: target.owner, repository: target.name, refs };

  // GitHub へ通信する前に、選択が導入を選んだ同じ対象かを確かめる（見送り・未選択は通信しない）
  const pre = resolveChoice(cwd, base);
  if (!pre.ok) return out("invalidInput", { reason: pre.error.message });
  if (pre.status !== "selected") return fromChoice(pre);

  const file = choiceFileOf(cwd);
  if (!file) return out("invalidInput", { reason: "Git リポジトリの中で実行してください。" });
  mkdirSync(dirname(file), { recursive: true });
  const lock = `${file}.apply.lock`;
  if (!acquire(lock, lockWaitMs)) return out("conflict", { reason: "別の処理が Ruleset を適用中です。少し待ってからやり直してください。" });
  try {
    return await applyLocked(cwd, session, target, refs, authKind, base);
  } catch (e) {
    // 想定外の例外は適用の途中かもしれないため、確認不能として返す（資格情報を含みうる文言は出さない）
    return out("unknown", { reason: `適用の途中で想定外の例外（${e.code ?? e.name ?? "不明"}）。GitHub 上の Ruleset を再取得して確認してください。` });
  } finally {
    rmSync(lock, { force: true });
  }
}
