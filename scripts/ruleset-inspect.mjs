// 実効ルールと通常作業の権限の検査（brw-enforcement 5.4）。
// 適用後の確認と日常の読み取り検査に使う。対象・PR 必須・squash 限定・他のルールとの整合を、分岐元ごとに GitHub から読み直して判定する。
// 作業経路（gh の認証、管理された SSH・MCP）ごとに、実際の主体と Ruleset を変更・迂回できる権限を照合する。
// 記録済みの Ruleset ID は証拠にしない（記録にあるだけでは有効とみなさない）。
// 書き込みは行わない（読み取りだけ）。適用後に全分岐元が確認できたときだけ、ruleset-choice の markVerified で記録を確認済みにする。
// 不明な主体・バイパス情報の欠落は安全側に倒し、確認不能（unverifiable）として返す。資格情報・session は結果に含めない。
// 外部依存なし（Node 標準ライブラリと同じ scripts の既存モジュールのみ）。
import { markVerified } from "./ruleset-choice.mjs";

/** 結果の総合判定。適用済み（enforced、適用済みを示す）・設定のずれ・適用後の確認失敗・作業経路の確認不能のいずれか。 */
export const INSPECT_STATUSES = ["enforced", "drift", "verify-failed", "unverifiable"];

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const GATE_KINDS = ["gh", "ssh", "mcp"];

/** 項目を作る。ok 以外には対応（remedy）を付ける。 */
const item = (id, status, reason, remedy) => ({ id, status, reason, ...(status === "ok" ? {} : { remedy }) });

/** 入力を検査する。通らなければ理由。 */
const validate = (session, target, refs, opts) => {
  if (!session || typeof session.confirmTarget !== "function" || typeof session.getRepositorySettings !== "function" || typeof session.getBranchRules !== "function" || typeof session.getRuleset !== "function") {
    return { error: "GitHub の接続（session）が指定されていません。" };
  }
  if (!target || typeof target.host !== "string" || typeof target.owner !== "string" || typeof target.name !== "string") return { error: "対象（host・owner・name）の指定が正しくありません。" };
  if (!Array.isArray(refs) || refs.length === 0 || !refs.every((x) => typeof x === "string" && x.length > 0)) return { error: "分岐元の指定が正しくありません。" };
  const routes = opts.routes ?? [];
  if (!Array.isArray(routes)) return { error: "作業経路の指定は配列に限ります。" };
  if (opts.afterApply !== undefined && typeof opts.afterApply !== "boolean") return { error: "afterApply は真偽値で指定してください。" };
  if (opts.cwd !== undefined && typeof opts.cwd !== "string") return { error: "cwd は文字列で指定してください。" };
  return { routes, afterApply: opts.afterApply === true, cwd: opts.cwd ?? null, refs: [...new Set(refs)].sort() };
};

/**
 * 読み取り失敗を項目の状態にする。対象の不一致は「設定のずれ」（適用後は適用後の確認失敗）、それ以外は確認失敗。
 * @param {"drift"|"verify-failed"} mismatch 不一致のときの状態
 */
const failStatus = (r, mismatch) => (r.kind === "target-mismatch" ? mismatch : "verify-failed");

/** Ruleset の詳細を一度だけ読む（同じ ID を複数の分岐元で使うため）。 */
const readDetail = async (session, target, id, cache) => {
  if (!cache.has(id)) cache.set(id, await session.getRuleset(target, id));
  return cache.get(id);
};

/** 指定の一覧が分岐元を含むか（完全一致、~ALL、既定の分岐元なら ~DEFAULT_BRANCH）。 */
const matchesRef = (list, ref, defaultBranch) => Array.isArray(list)
  && (list.includes(`refs/heads/${ref}`) || list.includes("~ALL") || (ref === defaultBranch && list.includes("~DEFAULT_BRANCH")));

/** PR 必須ルールのうち、許可マージ方式が squash だけのものか。 */
const squashOnly = (x) => Array.isArray(x.parameters?.allowed_merge_methods)
  && x.parameters.allowed_merge_methods.length === 1
  && x.parameters.allowed_merge_methods[0] === "squash";

/**
 * 一つの分岐元の実効ルールを読み直して判定する。
 * ok は「バイパスなしの squash 限定の PR 必須ルール（対象の分岐元を含む、有効）」が実効ルールに効いていることの確認。
 * bypass は全分岐元の効いているルールのバイパス情報の集計（作業経路の判定に使う）。
 */
const inspectRef = async (session, target, ref, { settings, mismatch, cache, bypass }) => {
  const out = (status, reason, rulesetIds = [], proofRulesetIds = []) => ({ ref, status, reason, rulesetIds, proofRulesetIds });
  const eff = await session.getBranchRules(target, ref);
  if (!eff.ok) {
    if (eff.kind === "refused") return out(mismatch, `分岐元名を Ruleset の対象にできない（${eff.reason}）`);
    return out("verify-failed", `実効ルールを読めない（${eff.kind}）: ${eff.reason}`);
  }
  const rules = eff.rules;
  const rulesetIds = [...new Set(rules.map((x) => x.rulesetId))].sort((a, b) => a - b);
  const prRules = rules.filter((x) => x.type === "pull_request");
  if (prRules.some((x) => !isObj(x.parameters) || !Array.isArray(x.parameters.allowed_merge_methods))) return out("verify-failed", "プルリクエスト必須ルールの許可マージ方式を読めない", rulesetIds);
  if (prRules.length === 0) return out(mismatch, "プルリクエスト必須のルールがない", rulesetIds);
  const conflict = [...new Set(prRules.filter((x) => !x.parameters.allowed_merge_methods.includes("squash")).map((x) => x.rulesetId))];
  if (conflict.length) return out(mismatch, `squash を許可しないプルリクエスト必須ルールと競合（Ruleset ${conflict.join(", ")}）`, rulesetIds);

  // 効いている全ルールの詳細を読み、バイパス情報を集計する（欠落は確認不能として扱う）
  for (const id of rulesetIds) {
    const d = await readDetail(session, target, id, cache);
    if (!d.ok) return out("verify-failed", `Ruleset ${id} の詳細を読めない（${d.kind}）`, rulesetIds);
    if (d.ruleset.bypassActors === null) bypass.unknown = true;
    else if (d.ruleset.bypassActors.length) bypass.nonEmpty = true;
  }

  // squash 限定のルールを、バイパスなし・有効・対象の分岐元を含むものに限って適合の根拠にする
  const candidates = [...new Set(prRules.filter(squashOnly).map((x) => x.rulesetId))].sort((a, b) => a - b);
  if (candidates.length === 0) return out(mismatch, "squash 限定のプルリクエスト必須ルールがない", rulesetIds);
  const proofs = [];
  const notes = [];
  for (const id of candidates) {
    const d = cache.get(id).ruleset;
    if (d.bypassActors === null) return out("verify-failed", `Ruleset ${id} のバイパス情報が取得できず、適合の根拠にできない`, rulesetIds);
    if (d.bypassActors.length) { notes.push(`Ruleset ${id} はバイパスを許す`); continue; }
    if (d.enforcement !== "active") { notes.push(`Ruleset ${id} は有効化されていない`); continue; }
    if (d.target !== "branch") { notes.push(`Ruleset ${id} は分岐元が対象ではない`); continue; }
    if (!matchesRef(d.conditions?.ref_name?.include, ref, settings.defaultBranch) || matchesRef(d.conditions?.ref_name?.exclude, ref, settings.defaultBranch)) {
      notes.push(`Ruleset ${id} は分岐元 ${ref} を対象にしていない`);
      continue;
    }
    proofs.push(id);
  }
  if (proofs.length === 0) return out(mismatch, `バイパスなしの squash 限定ルールで適合を確認できない（${notes.join("、")}）`, rulesetIds);
  return out("ok", `PR 必須・squash 限定を実効ルール（Ruleset ${proofs.join(", ")}）で確認`, rulesetIds, proofs);
};

/** 作業経路の権限を文字列の真偽値に限って読む。読めなければ null。 */
const permissionsOf = (p) => (isObj(p) && typeof p.admin === "boolean" && typeof p.push === "boolean" ? { admin: p.admin, push: p.push } : null);

/**
 * 一つの作業経路の主体と権限を照合する。
 * - gh: 作業用の認証（route.session）で主体と権限を読む。自己申告の主体があれば実際の主体と一致する必要がある。
 * - ssh・mcp: 管理設定で固定された主体・権限の証跡（managed）が必要。自己申告だけでは確認不能。
 * 変更権限（Ruleset を変えられる）があれば迂回可能として設定のずれ。バイパス情報が欠けたり対象が分からない場合は確認不能。
 */
const judgeRoute = async (route, target, bypass, index) => {
  const r = isObj(route) ? route : {};
  const name = typeof r.name === "string" && r.name ? r.name : `作業経路 ${index + 1}`;
  const transport = r.transport;
  const result = (status, reason, actor = null, permissions = null, remedy) => ({ name, transport: typeof transport === "string" ? transport : null, status, reason, actor, permissions, ...(status === "ok" ? {} : { remedy }) });
  const remedyAuth = "管理設定で作業主体と権限を固定し、その証跡を渡して再検査する";
  if (!GATE_KINDS.includes(transport)) return result("unverifiable", "作業経路の種類（gh・ssh・mcp）が分からない", null, null, "作業経路の種類を指定して再検査する");

  let actor = null;
  let permissions = null;
  if (transport === "gh") {
    const s = r.session;
    if (!s || typeof s.checkAuth !== "function" || typeof s.confirmTarget !== "function" || typeof s.getRepositorySettings !== "function") {
      return result("unverifiable", "gh の作業用の認証を照合していない（自己申告だけでは主体を確認できない）", null, null, "作業用の認証で作った GitHub の接続を渡して再検査する");
    }
    const a = await s.checkAuth();
    if (!a.ok) return result("unverifiable", `作業用の認証を確認できない（${a.kind}）`, null, null, "作業用の認証を確認して再検査する");
    actor = typeof a.login === "string" ? a.login : null;
    if (actor === null) return result("unverifiable", "作業主体（ログイン名）を取得できない", null, null, "作業用の認証で応答のログイン名を読める権限を確認する");
    if (typeof r.declaredActor === "string" && r.declaredActor.toLowerCase() !== actor.toLowerCase()) {
      return result("unverifiable", "自己申告の主体と実際の主体が一致しない", actor, null, "作業経路の主体の申告を直すか、実際の作業用の認証を確認する");
    }
    const c = await s.confirmTarget(target);
    if (!c.ok) return result("unverifiable", `作業用の認証で対象を照合できない（${c.kind}）`, actor, null, "作業用の認証で対象リポジトリを読める権限を確認する");
    const st = await s.getRepositorySettings(target);
    if (!st.ok) return result("unverifiable", `作業用の認証でリポジトリの権限を読めない（${st.kind}）`, actor, null, "作業用の認証で権限を読める権限を確認する");
    permissions = permissionsOf(st.settings.permissions);
  } else {
    const m = r.managed;
    if (!isObj(m)) return result("unverifiable", "管理された証跡がない（自己申告だけでは主体と権限を確認できない）", null, null, remedyAuth);
    if (m.fixed !== true) return result("unverifiable", "作業主体が管理設定で固定されていない", null, null, remedyAuth);
    if (typeof m.actor !== "string" || m.actor === "") return result("unverifiable", "作業主体が分からない", null, null, remedyAuth);
    if (typeof m.evidence !== "string" || m.evidence === "") return result("unverifiable", "管理された証跡の参照がない", m.actor, null, remedyAuth);
    actor = m.actor;
    permissions = permissionsOf(m.permissions);
  }

  if (permissions === null) return result("unverifiable", "作業主体の権限（管理・push）を確認できない", actor, null, "作業主体の権限を読める認証・証跡で再検査する");
  if (permissions.admin) return result("drift", "作業主体が Ruleset を変更できる（管理権限がある）ため、保護を迂回できる", actor, permissions, "作業経路の認証から管理権限を外す（BRW は権限を変更しない）");
  if (bypass.unknown) return result("unverifiable", "効いているルールのバイパス情報を確認できず、迂回の可否を判定できない", actor, permissions, "Ruleset の詳細を読める権限で再検査する");
  if (bypass.nonEmpty) return result("unverifiable", "バイパスを許すルールがあり、作業主体がその対象に含まれるかを照合できない", actor, permissions, "バイパス対象の一覧と作業主体を照合できる情報で再検査する");
  return result("ok", `直接 push は Ruleset の PR 必須で拒否される（push 権限: ${permissions.push ? "あり" : "なし"}）`, actor, permissions);
};

/** 総合判定。設定のずれ（confirmed）を最優先し、次に確認失敗、最後に作業経路の確認不能。 */
const verdictOf = (rulesetStatuses, routeStatuses, routeCount) => {
  if (rulesetStatuses.includes("drift") || routeStatuses.includes("drift")) return "drift";
  if (rulesetStatuses.includes("verify-failed")) return "verify-failed";
  if (routeCount === 0 || routeStatuses.includes("unverifiable")) return "unverifiable";
  return "enforced";
};

/**
 * 導入した対象の実効ルールと作業経路の権限を検査する（読み取りのみ）。
 * @param {object} session 管理者の認証で作った GitHub の接続（createGitHubSession の結果。資格情報は呼び出し側で固定する）
 * @param {{host: string, owner: string, name: string}} target 対象リポジトリ
 * @param {string[]} refs 恒常的な分岐元（refs/heads/ を含まない）。分岐元ごとに実効ルールを読む
 * @param {object} [opt]
 * @param {Array<object>} [opt.routes] 作業経路。各項目は { name, transport: "gh"|"ssh"|"mcp", session?, declaredActor?, managed? }。
 *   gh は作業用の認証で作った session を渡すと、実際の主体と権限を読む。ssh・mcp は管理設定の証跡 managed
 *   （{ actor, fixed: true, evidence, permissions: {admin, push} }）が必要。declaredActor は自己申告で、単独では根拠にしない。
 * @param {boolean} [opt.afterApply] 適用の直後の検査か。true のとき、設定の不一致も「適用後の確認失敗」として返す。
 * @param {string} [opt.cwd] 対象リポジトリ（Git の中）。適用後に全分岐元が確認できたとき、記録を確認済みにするため使う。
 * @returns {Promise<object>} status は enforced・drift・verify-failed・unverifiable・invalidInput のいずれか。
 */
export const inspectRulesets = async (session, target, refs, opts = {}) => {
  const v = validate(session, target, refs, opts);
  if (v.error) return { status: "invalidInput", reason: v.error, afterApply: false, target: null, checks: [], refs: [], routes: [], verified: null };
  const { routes, afterApply, cwd } = v;
  const mismatch = afterApply ? "verify-failed" : "drift";
  const checks = [];
  const bypass = { unknown: false, nonEmpty: false };
  const cache = new Map();
  let repositoryId = null;
  let settings = null;

  // 1. 対象の照合とリポジトリ設定（squash の有効・無効）
  const c = await session.confirmTarget(target);
  if (c.ok) {
    repositoryId = c.target.repositoryId;
    const s = await session.getRepositorySettings(target);
    if (s.ok) {
      settings = s.settings;
      checks.push(item("target", "ok", "対象リポジトリを GitHub の応答で照合した"));
    } else {
      checks.push(item("target", failStatus(s, mismatch), `リポジトリ設定を読めない（${s.kind}）: ${s.reason}`, "読み取り権限を確認して再検査する"));
    }
  } else {
    checks.push(item("target", failStatus(c, mismatch), `対象リポジトリを確認できない（${c.kind}）: ${c.reason}`, "リポジトリのホスト・所有者・名前と読み取り権限を確認して再検査する"));
  }
  if (settings) {
    if (settings.allowSquashMerge === true) checks.push(item("squash", "ok", "squash マージがリポジトリで有効"));
    else if (settings.allowSquashMerge === false) checks.push(item("squash", mismatch, "squash マージがリポジトリで無効", "リポジトリ設定で squash マージを有効にする（BRW は設定を変えない）"));
    else checks.push(item("squash", "verify-failed", "squash 設定が応答にない", "リポジトリ設定を読める権限で再検査する"));
  } else {
    checks.push(item("squash", "verify-failed", "リポジトリ設定を読めないため squash を確認できない", "対象の確認を解消してから再検査する"));
    bypass.unknown = true;
  }

  // 2. 分岐元ごとの実効ルール（対象を確認できなければ読まない）
  const refResults = [];
  for (const ref of v.refs) {
    if (!settings) {
      refResults.push({ ref, status: "verify-failed", reason: "対象を確認できないため実効ルールを読まない", rulesetIds: [], proofRulesetIds: [] });
      continue;
    }
    refResults.push(await inspectRef(session, target, ref, { settings, mismatch, cache, bypass }));
  }

  // 3. 作業経路ごとの主体と権限
  const routeResults = [];
  for (let i = 0; i < routes.length; i++) routeResults.push(await judgeRoute(routes[i], target, bypass, i));

  const rulesetStatuses = [...checks.map((x) => x.status), ...refResults.map((x) => x.status)];
  const status = verdictOf(rulesetStatuses, routeResults.map((x) => x.status), routes.length);
  const rulesetOk = rulesetStatuses.every((x) => x === "ok");
  const proofIds = [...new Set(refResults.flatMap((x) => x.proofRulesetIds))].sort((a, b) => a - b);

  // 4. 適用後に全分岐元が確認できたら、記録の ID を確認済みにする（記録がない ID は記録されないと返す）
  let verified = null;
  if (afterApply && rulesetOk && repositoryId !== null) {
    if (cwd === null) verified = { rulesetIds: proofIds, results: [], reason: "cwd がないため記録を更新しない" };
    else {
      verified = {
        rulesetIds: proofIds,
        results: proofIds.map((id) => {
          const m = markVerified(cwd, { host: target.host, owner: target.owner, repository: target.name, refs: v.refs, repositoryId, rulesetId: id });
          return m.ok ? { rulesetId: id, ok: true } : { rulesetId: id, ok: false, reason: m.error.message };
        }),
      };
    }
  }

  const reasons = {
    enforced: "適用済み（PR 必須・squash 限定・バイパスなしを全分岐元で確認し、作業経路も迂回できない）",
    drift: "設定のずれがある（宣言と実効設定が一致しない項目、または迂回可能な作業経路がある）",
    "verify-failed": afterApply ? "適用後の確認に失敗した項目がある（設定を読み直して再検査する）" : "確認に失敗した項目がある（読み取りや根拠が不足）",
    unverifiable: routes.length === 0 ? "作業経路が指定されず、迂回できないことを確認できない" : "作業経路の主体または権限を確認できず、迂回不可とは表示できない",
  };
  return {
    status,
    reason: reasons[status],
    afterApply,
    target: { host: target.host, owner: target.owner, name: target.name, repositoryId },
    checks: checks.map(({ id, status: s, reason, remedy }) => ({ id, status: s, reason, ...(remedy ? { remedy } : {}) })),
    refs: refResults,
    routes: routeResults,
    verified,
  };
};
