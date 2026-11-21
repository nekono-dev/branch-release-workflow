// Ruleset 導入の事前検査（brw-enforcement 5.2）。
// 認証状態と対象リポジトリへの書き込み権限（導入権限）を分けて確認し、対象の分岐元・プラン・squash 設定・既存のルールを読み取りだけで検査する。
// 設定の追加・変更は行わない（書き込み要求は一切送らない）。不足・不明は項目ごとに理由と再試行の対応を付けて返す。
// 返す session は 5.3 の適用に引き継ぐ。資格情報・トークンは結果にもエラーにも含めない。
// 5.3（追加）と 5.4（実効検査）は別の関数として使えるよう、検査ごとに export している。
// 外部依存なし（Node 標準ライブラリのみ）。ruleset-choice.mjs（5.1）とは別のモジュール。

/** 検査の項目。すべて ok のときだけ導入に進める。 */
export const PREFLIGHT_CHECKS = ["auth", "target", "permission", "rulesetAccess", "plan", "squash", "branchRef", "existingRules"];
/** 認証方式の種別。呼び出し側が判明している場合だけ渡す。未知の値は厳しい側（fine-grained と同じ扱い）に倒す。 */
const AUTH_KINDS = ["classic", "oauth", "fine-grained", "app"];
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** 項目の結果を作る。ok 以外には再試行に必要な対応（remedy）を付ける。 */
const item = (id, status, reason, remedy, extra = {}) => ({ id, status, reason, ...(status === "ok" ? {} : { remedy }), ...extra });

/**
 * 認証が通るかを読み取りで確認する。トークンの値は返さない。
 * scopes は応答の x-oauth-scopes（classic・OAuth だけが返す）。ヘッダーがなければ null。
 * 認証方式はこのヘッダーで判定する（呼び出し側の申告は使わない）。
 */
export const checkAuthentication = async (session) => {
  const r = await session.checkAuth();
  if (r.ok) return item("auth", "ok", r.scopes === null ? "認証が通った（スコープのヘッダーなし）" : `認証が通った（スコープ: ${r.scopes.join(", ") || "なし"}）`, null, { login: r.login ?? null, scopes: r.scopes ?? null });
  return item("auth", "unknown", `認証を確認できない（${r.kind}）: ${r.reason}`, "gh auth login で対象ホストにログインし直してから再試行する");
};

/**
 * 対象リポジトリをリポジトリ ID で照合し、リポジトリ設定を読む。
 * 照合の食い違いは ng、取得できないものは確認不能。戻り値の repositoryId と settings は後続の検査に使う。
 */
export const checkTargetAccess = async (session, target) => {
  const c = await session.confirmTarget(target);
  if (!c.ok) {
    const status = c.kind === "target-mismatch" ? "ng" : "unknown";
    return { check: item("target", status, `対象リポジトリを確認できない（${c.kind}）: ${c.reason}`, "リポジトリのホスト・所有者・名前と、読み取り権限を確認して再試行する"), repositoryId: null, settings: null };
  }
  const s = await session.getRepositorySettings(target);
  if (!s.ok) return { check: item("target", "unknown", `リポジトリ設定を読めない（${s.kind}）: ${s.reason}`, "読み取り権限を確認して再試行する"), repositoryId: c.target.repositoryId, settings: null };
  return { check: item("target", "ok", "対象リポジトリを GitHub の応答で照合した"), repositoryId: c.target.repositoryId, settings: s.settings };
};

/**
 * 導入権限を確認する。管理権限（permissions.admin）が必要で、認証方式ごとに確実な証拠を求める。
 * - classic・OAuth（x-oauth-scopes あり）: admin が true かつ repo スコープがあれば ok。repo がなければ ng。
 * - fine-grained・App（ヘッダーなし）: 既存 Ruleset のバイパス情報が返ることを証拠にする（返らなければ確認不能）。
 * 認証方式は tokenScopes（checkAuthentication の scopes）で判定する。authKind の申告がヘッダーと食い違う、
 * または判定できない場合は、厳しい側（fine-grained と同じ証拠）に倒す。
 * rulesets は listRulesets の戻り値をそのまま渡す。
 */
export const checkWriteAuthority = async (session, target, { settings, rulesets, authKind, tokenScopes } = {}) => {
  const scopesKnown = Array.isArray(tokenScopes);
  const claimed = AUTH_KINDS.includes(authKind) ? authKind : null;
  const claimsClassic = claimed === "classic" || claimed === "oauth";
  // 申告があるのにヘッダーの有無と合わない、または申告がなくヘッダーも判定材料がない場合は厳しい側
  const mismatch = claimed !== null && claimsClassic !== scopesKnown;
  const basis = mismatch
    ? "（認証方式の申告がトークンのヘッダーと食い違うため、厳しい側で確認）"
    : !scopesKnown ? "（スコープのヘッダーがないため、fine-grained・App と同じ証拠で確認）" : "";
  const remedyAdmin = "対象リポジトリの管理権限を持つアカウントまたはトークンで導入する";
  if (!settings) return item("permission", "unknown", "リポジトリ設定を読めないため権限を確認できない", "対象の読み取りを解消してから再試行する");
  if (!isObj(settings.permissions)) return item("permission", "unknown", "応答に権限情報がない", "読み取り権限と GitHub の応答を確認して再試行する");
  const admin = settings.permissions.admin;
  if (admin === false) return item("permission", "ng", "対象リポジトリの管理権限がない（admin: false）", remedyAdmin);
  if (admin !== true) return item("permission", "unknown", "管理権限の有無が応答にない", "読み取り権限と GitHub の応答を確認して再試行する");
  if (scopesKnown && !mismatch) {
    // Ruleset の設定に必要なスコープは repo（public_repo など部分的なものでは足りない）
    if (!tokenScopes.includes("repo")) return item("permission", "ng", `repo スコープがない（現在: ${tokenScopes.join(", ") || "なし"}）`, "repo スコープを持つトークンで導入する");
    return item("permission", "ok", "管理権限と repo スコープを確認", null, { authKind: "classic" });
  }
  // fine-grained・App・種別不明は、管理権限に加えて Ruleset のバイパス情報が返ることを確かめる
  if (!rulesets?.ok) return item("permission", "unknown", `Ruleset 一覧を読めないため書き込み権限の証拠を得られない${basis}`, "Ruleset の読み取り権限を持つトークンで再試行する");
  // 所有元が対象リポジトリの Ruleset を優先して証拠に使う
  const first = rulesets.rulesets.find((x) => x.sourceType === "Repository") ?? rulesets.rulesets[0];
  if (!first) return item("permission", "unknown", `既存の Ruleset がなく、このトークンで Ruleset を変更できる証拠がない${basis}`, "既存の Ruleset を用意するか、管理権限を持つ classic・OAuth 認証で導入する");
  const d = await session.getRuleset(target, first.id);
  if (!d.ok) return item("permission", "unknown", `既存 Ruleset の詳細を読めない（${d.kind}）${basis}`, "Ruleset の読み取り権限を確認して再試行する");
  if (d.ruleset.bypassInfo === "present") return item("permission", "ok", `管理権限と、既存 Ruleset のバイパス情報の取得で書き込み権限を確認${basis}`, null, { authKind: "fine-grained" });
  return item("permission", "unknown", `既存 Ruleset のバイパス情報が返らず、書き込み権限を確認できない${basis}`, "管理権限を持つトークンで再試行する");
};

/**
 * 分岐元が対象リポジトリに存在するかを、ブランチ一覧（全ページ）の読み取りで確認する。
 * 一覧が読めない・途中で失敗する・上限を超える場合は確認不能。
 */
export const checkBranchExists = async (session, target, branch) => {
  const names = [];
  const cap = 50;
  for (let page = 1; page <= cap; page++) {
    const r = await session.request(target, "GET", `/repos/${target.owner}/${target.name}/branches?per_page=100&page=${page}`);
    if (!r.ok) return item("branchRef", "unknown", `分岐元の一覧を読めない（${r.kind}）: ${r.reason}`, "読み取り権限を確認して再試行する");
    if (!Array.isArray(r.body)) return item("branchRef", "unknown", "分岐元の一覧の応答が一覧ではない", "GitHub の応答を確認して再試行する");
    for (const b of r.body) {
      if (typeof b?.name !== "string") return item("branchRef", "unknown", "分岐元の一覧に名前のない項目がある", "GitHub の応答を確認して再試行する");
      names.push(b.name);
    }
    if (r.body.length < 100) return names.includes(branch)
      ? item("branchRef", "ok", "分岐元が存在し、実効ルールを読めた")
      : item("branchRef", "ng", `分岐元 ${branch} が対象リポジトリに存在しない`, "宣言の分岐元名を確認し、ブランチを作成してから再試行する");
  }
  return item("branchRef", "unknown", "分岐元の一覧のページ数が上限を超え、存在を確認できない", "分岐元の一覧を確認して再試行する");
};

/** Ruleset の一覧を読めるかを確認する（全ページ・親ルール込み）。一覧そのものは呼び出し側が使えるよう返す。 */
export const checkRulesetAccess = (rulesets) => {
  if (rulesets?.ok) return item("rulesetAccess", "ok", `Ruleset 一覧を読めた（${rulesets.rulesets.length} 件）`);
  return item("rulesetAccess", "unknown", `Ruleset 一覧を読めない（${rulesets?.kind ?? "不明"}）: ${rulesets?.reason ?? ""}`, "Ruleset の読み取り権限と、対象のプランを確認して再試行する");
};

/**
 * 対象の Ruleset 利用可否（プラン）と squash 設定を検査する。
 * GitHub.com の公開リポジトリは公開向けの提供を根拠にする。非公開は既存 Ruleset が読めることを根拠にする。
 * どちらもなければプランを確認できないため確認不能にする。squash が無効なら設定変更はせず ng にする。
 */
export const checkRulesetAvailability = (session, settings, rulesets) => {
  if (!settings) return [
    item("plan", "unknown", "リポジトリ設定を読めないため Ruleset の利用可否を確認できない", "対象の読み取りを解消してから再試行する"),
    item("squash", "unknown", "リポジトリ設定を読めないため squash 設定を確認できない", "対象の読み取りを解消してから再試行する"),
  ];
  const isPublic = settings.visibility === "public" || settings.private === false;
  const isPrivate = settings.visibility === "private" || settings.private === true;
  let plan;
  if (isPublic && session.host === "github.com") {
    plan = item("plan", "ok", "GitHub.com の公開リポジトリとして Ruleset を利用できる");
  } else if (rulesets?.ok && rulesets.rulesets.length > 0) {
    plan = item("plan", "ok", "既存の Ruleset が読めるため、この対象で Ruleset を利用できると判断");
  } else {
    const why = isPrivate ? "非公開リポジトリで既存の Ruleset もなく" : "公開範囲を確認できず、既存の Ruleset もなく";
    plan = item("plan", "unknown", `${why}、プランによる Ruleset の利用可否を確認できない`, "リポジトリまたは組織のプラン（Ruleset 対応）を管理画面で確認し、再試行する");
  }
  let squash;
  if (settings.allowSquashMerge === true) squash = item("squash", "ok", "squash マージがリポジトリで有効");
  else if (settings.allowSquashMerge === false) squash = item("squash", "ng", "squash マージがリポジトリで無効", "リポジトリ設定で squash マージを有効にする（BRW は設定を変更しない）");
  else squash = item("squash", "unknown", "squash 設定が応答にない", "リポジトリ設定を読める権限で再試行する");
  return [plan, squash];
};

/**
 * 対象の分岐元の実効ルールを読み、既存のルールとの整合を検査する。
 * - 分岐元名が Ruleset の対象にできない形は branchRef を ng にする。読めない場合は unknown。
 * - プルリクエスト必須ルールが squash を許可しない場合は競合として ng。
 * - 適用対象の既存 Ruleset のバイパス情報が返らない場合は根拠にできないため unknown。
 * 再利用できる既存ルール（squash 限定・バイパスなし）と、BRW が記録した ID との一致も返す（5.3 が使う）。
 */
export const inspectExistingRules = async (session, target, branch, { knownRulesetIds = [] } = {}) => {
  const eff = await session.getBranchRules(target, branch);
  if (!eff.ok) {
    const branchRef = eff.kind === "refused"
      ? item("branchRef", "ng", `分岐元名を Ruleset の対象にできない（${eff.reason}）`, "宣言の分岐元名を確認する（英数字・._- と / のみの名前に限る）")
      : item("branchRef", "unknown", `分岐元の実効ルールを読めない（${eff.kind}）: ${eff.reason}`, "読み取り権限を確認して再試行する");
    return { branchRef, existingRules: item("existingRules", "unknown", "分岐元の実効ルールを読めないため既存のルールを確認できない", "上の分岐元の確認を解消してから再試行する"), existing: null };
  }
  // 分岐元名の形と実効ルールは読めた。存在は一覧で確かめ、結果を分岐元の判定とする
  const branchRef = await checkBranchExists(session, target, branch);
  const rules = eff.rules;
  const ids = [...new Set(rules.map((x) => x.rulesetId))];
  const prRules = rules.filter((x) => x.type === "pull_request");

  // 適用対象の既存 Ruleset のバイパス情報を読む。読めない・返らないものは根拠にしない
  const bypassEmpty = new Map();
  const bypassUnknown = [];
  for (const id of ids) {
    const d = await session.getRuleset(target, id);
    if (!d.ok || d.ruleset.bypassActors === null) { bypassUnknown.push(id); continue; }
    bypassEmpty.set(id, d.ruleset.bypassActors.length === 0);
  }

  const unreadablePr = prRules.some((x) => !isObj(x.parameters) || !Array.isArray(x.parameters.allowed_merge_methods));
  const conflict = prRules.some((x) => Array.isArray(x.parameters?.allowed_merge_methods) && !x.parameters.allowed_merge_methods.includes("squash"));
  const squashOnly = (x) => Array.isArray(x.parameters?.allowed_merge_methods) && x.parameters.allowed_merge_methods.length === 1 && x.parameters.allowed_merge_methods[0] === "squash";
  const reusable = ids.filter((id) => bypassEmpty.get(id) === true && rules.some((x) => x.rulesetId === id && x.type === "pull_request" && squashOnly(x)));
  const brwRecorded = ids.filter((id) => knownRulesetIds.includes(id));
  const existing = {
    rulesetIds: ids,
    pullRequestRequired: prRules.length > 0,
    squashOnly: prRules.some(squashOnly),
    reusable,
    brwRecorded,
    bypassUnknown,
  };

  let existingRules;
  if (conflict) {
    existingRules = item("existingRules", "ng", "squash を許可しないプルリクエスト必須ルールが既にあり、squash 限定の条件と競合する", "競合する既存ルールの管理者と相談する（BRW は既存のルールを変更しない）");
  } else if (unreadablePr) {
    existingRules = item("existingRules", "unknown", "プルリクエスト必須ルールの許可マージ方式を読めない", "GitHub の応答を確認して再試行する");
  } else if (bypassUnknown.length) {
    existingRules = item("existingRules", "unknown", `バイパス情報を確認できない既存 Ruleset（${bypassUnknown.join(", ")}）があり、適合の根拠にできない`, "Ruleset の詳細を読める権限で再試行する");
  } else {
    const note = reusable.length ? `再利用できる既存ルールあり（${reusable.join(", ")}）` : "再利用できる既存ルールはなし";
    existingRules = item("existingRules", "ok", `既存ルールと競合しない。${note}`);
  }
  return { branchRef, existingRules, existing };
};

/** 判定の集約。ng が一つでもあれば blocked、確認不能があれば unknown、すべて ok なら ready。 */
const verdictOf = (checks) => (checks.some((c) => c.status === "ng") ? "blocked" : checks.some((c) => c.status === "unknown") ? "unknown" : "ready");

/**
 * 導入前の事前検査を順に行う。前段の認証・対象の確認が通らなければ以降は読まず、未検査の項目を確認不能として返す。
 * 戻り値の writeAllowed が true のときだけ 5.3 の適用に進める。書き込みは行わない。
 * @param {object} session createGitHubSession で作った照合前の session（資格情報は渡さない）
 * @param {{owner: string, name: string}} target 対象リポジトリ
 * @param {string} branch 恒常的な分岐元の名前（refs/ を含まない）
 * @param {{authKind?: string, knownRulesetIds?: number[]}} [opt]
 */
export const runRulesetPreflight = async (session, target, branch, { authKind, knownRulesetIds = [] } = {}) => {
  const by = {};
  const auth = await checkAuthentication(session);
  by.auth = auth;
  const tokenScopes = auth.scopes;
  let stop = auth.status !== "ok";
  let repositoryId = null;
  let settings = null;
  let existing = null;
  if (!stop) {
    const t = await checkTargetAccess(session, target);
    by.target = t.check;
    repositoryId = t.repositoryId;
    settings = t.settings;
    stop = t.check.status !== "ok";
  }
  if (!stop) {
    const rulesets = await session.listRulesets(target);
    by.rulesetAccess = checkRulesetAccess(rulesets);
    by.permission = await checkWriteAuthority(session, target, { settings, rulesets, authKind, tokenScopes });
    [by.plan, by.squash] = checkRulesetAvailability(session, settings, rulesets);
    const ex = await inspectExistingRules(session, target, branch, { knownRulesetIds });
    by.branchRef = ex.branchRef;
    by.existingRules = ex.existingRules;
    existing = ex.existing;
  }
  const checks = PREFLIGHT_CHECKS.map((id) => by[id] ?? item(id, "unknown", "前段の確認が通らないため未検査", "前段の確認を解消してから再試行する"));
  const verdict = verdictOf(checks);
  return {
    verdict,
    writeAllowed: verdict === "ready",
    session,
    target: { host: session.host, owner: target?.owner ?? null, name: target?.name ?? null, repositoryId },
    branch,
    checks,
    existing,
  };
};
