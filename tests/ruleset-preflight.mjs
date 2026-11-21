// Ruleset 導入の事前検査（brw-enforcement 5.2）の契約テスト。偽の応答層だけを使い、実際の通信・認証はしない。
// 事前検査は読み取りだけを行う。どの場合も書き込み要求が 0 件であることを確認する。
import { createGitHubSession } from "../scripts/github-client.mjs";
import { PREFLIGHT_CHECKS, runRulesetPreflight } from "../scripts/ruleset-preflight.mjs";
import { createFakeGitHub } from "./support/fake-github.mjs";

const TOKEN = "ghp_PREFLIGHTSECRET1234567890";
const T = { host: "github.com", owner: "acme", name: "app" };
const REPO_BODY = { id: 42, full_name: "Acme/App", private: false, visibility: "public", allow_squash_merge: true, default_branch: "main", permissions: { admin: true, push: true, pull: true } };
const LIST = "GET /repos/acme/app/rulesets?includes_parents=true&per_page=100&page=1";
const RULES = "GET /repos/acme/app/rules/branches/main?per_page=100&page=1";
const DETAIL = (id) => `GET /repos/acme/app/rulesets/${id}?includes_parents=true`;
const ok = (body) => ({ status: 200, body });
const item = (id, extra = {}) => ({ id, name: `r${id}`, target: "branch", enforcement: "active", source_type: "Repository", source: "acme/app", ...extra });
const detail = (id, bypass = [], extra = {}) => ({ ...item(id), conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } }, rules: [{ type: "pull_request", parameters: { allowed_merge_methods: ["squash"] } }], bypass_actors: bypass, ...extra });
const effective = (id, methods) => ({ type: "pull_request", ruleset_id: id, ruleset_source_type: "Repository", ruleset_source: "acme/app", parameters: { allowed_merge_methods: methods } });

/** 既定の応答一式。引数で個別に差し替える。 */
const BRANCHES = "GET /repos/acme/app/branches?per_page=100&page=1";
/** scopes: 文字列なら x-oauth-scopes を返す（classic・OAuth）。null ならヘッダーなし（fine-grained・App）。 */
const routesOf = ({ repo = REPO_BODY, list = [], rules = [], details = {}, listStatus, repoStatus, rulesStatus, scopes = "repo", branches = [{ name: "main" }], branchStatus } = {}) => ({
  "GET /user": { status: 200, body: { login: "admin-user" }, headers: scopes === null ? {} : { "x-oauth-scopes": scopes } },
  [BRANCHES]: branchStatus ? { status: branchStatus, body: { message: "err" } } : ok(branches),
  "GET /repos/acme/app": repoStatus ? { status: repoStatus, body: { message: "err" } } : ok(repo),
  [LIST]: listStatus ? { status: listStatus, body: { message: "Forbidden" } } : ok(list),
  [RULES]: rulesStatus ? { status: rulesStatus, body: { message: "err" } } : ok(rules),
  ...Object.fromEntries(Object.entries(details).map(([id, body]) => [DETAIL(id), ok(body)])),
});

const viaFake = (fake) => async ({ method, path, body, host }) => fake.request(method, path, body, { host });
const run = async (routes, opts = {}) => {
  const { scenario = "success", branch = "main", authKind, knownRulesetIds, target = T } = opts;
  const fake = createFakeGitHub({ routes, scenario });
  const session = createGitHubSession({ host: "github.com", token: TOKEN, transport: viaFake(fake) });
  const r = await runRulesetPreflight(session, target, branch, { authKind, knownRulesetIds });
  return { r, fake };
};
const statusOf = (r, id) => r.checks.find((c) => c.id === id)?.status;
const allGet = (fake) => fake.requests.every((q) => q.method === "GET");

export const runRulesetPreflightChecks = async (eq) => {
  // ---- 全項目が通る場合（管理権限・公開・squash 有効・既存ルールなし） ----
  {
    const { r, fake } = await run(routesOf(), { authKind: "classic" });
    eq("preflight/5.2 管理権限があり公開・squash 有効なら全項目が ok で、導入に進める", [r.verdict, r.writeAllowed, r.checks.map((c) => c.status), r.checks.map((c) => c.id), r.target.repositoryId, fake.writeCount], ["ready", true, PREFLIGHT_CHECKS.map(() => "ok"), PREFLIGHT_CHECKS, 42, 0]);
  }
  {
    const { r, fake } = await run(routesOf(), { authKind: "classic" });
    eq("preflight/5.2 読み取りだけを行い、結果に資格情報を含めない", [allGet(fake), JSON.stringify(r).includes(TOKEN), typeof r.session, r.session?.host], [true, false, "object", "github.com"]);
  }

  // ---- 導入権限（認証状態と書き込み権限を分ける） ----
  {
    const { r, fake } = await run(routesOf({ scopes: null }), { authKind: "fine-grained" });
    eq("preflight/5.2 fine-grained で既存 Ruleset がなければ権限の証拠がなく確認不能（書き込みなし）", [r.verdict, statusOf(r, "permission"), fake.writeCount], ["unknown", "unknown", 0]);
  }
  {
    const { r, fake } = await run(routesOf({ scopes: null, list: [item(7)], details: { 7: detail(7, []) } }), { authKind: "fine-grained" });
    eq("preflight/5.2 fine-grained でも既存 Ruleset のバイパス情報が返れば権限を確認できる", [r.verdict, statusOf(r, "permission"), fake.writeCount], ["ready", "ok", 0]);
  }
  {
    const { r, fake } = await run(routesOf({ scopes: null, list: [item(7)], details: { 7: { ...detail(7), bypass_actors: undefined } } }), { authKind: "fine-grained" });
    eq("preflight/5.2 バイパス情報が返らない既存 Ruleset は権限の証拠にせず確認不能", [r.verdict, statusOf(r, "permission"), fake.writeCount], ["unknown", "unknown", 0]);
  }
  {
    const { r, fake } = await run(routesOf({ repo: { ...REPO_BODY, permissions: { admin: false, push: true, pull: true } } }), { authKind: "classic" });
    eq("preflight/5.2 管理権限がない（admin: false）と不足で、導入は止まり書き込みはゼロ", [r.verdict, r.writeAllowed, statusOf(r, "permission"), fake.writeCount], ["blocked", false, "ng", 0]);
  }
  {
    const { r, fake } = await run(routesOf({ repo: { ...REPO_BODY, permissions: undefined } }), { authKind: "classic" });
    eq("preflight/5.2 権限情報が応答にない場合は確認不能", [r.verdict, statusOf(r, "permission"), fake.writeCount], ["unknown", "unknown", 0]);
  }
  {
    // 管理ロールがあっても、トークンが Ruleset を読めない（権限不足）なら書き込みを行わない
    const { r, fake } = await run(routesOf({ listStatus: 403 }), { authKind: "classic" });
    eq("preflight/5.2 管理ロールがあっても Ruleset 一覧が読めなければ確認不能で、書き込みはゼロ", [r.verdict, statusOf(r, "rulesetAccess"), fake.writeCount], ["unknown", "unknown", 0]);
  }
  {
    const { r, fake } = await run(routesOf({ scopes: null, listStatus: 403 }), { authKind: "fine-grained" });
    eq("preflight/5.2 fine-grained で一覧も読めなければ権限と一覧の両方が確認不能", [r.verdict, statusOf(r, "permission"), statusOf(r, "rulesetAccess"), fake.writeCount], ["unknown", "unknown", "unknown", 0]);
  }

  // ---- 認証・対象 ----
  {
    const { r, fake } = await run(routesOf(), { scenario: "auth" });
    eq("preflight/5.2 認証が通らなければ以降は読まず、全項目を確認不能にする（書き込みはゼロ）", [r.verdict, statusOf(r, "auth"), r.checks.slice(1).every((c) => c.status === "unknown"), fake.requests.map((q) => q.path), fake.writeCount], ["unknown", "unknown", true, ["/user"], 0]);
  }
  {
    const { r, fake } = await run(routesOf({ repo: { ...REPO_BODY, full_name: "acme/other" } }), { authKind: "classic" });
    eq("preflight/5.2 応答のリポジトリが対象と異なれば対象を ng にし、権限の読み取りに進まない", [r.verdict, statusOf(r, "target"), statusOf(r, "permission"), fake.requests.some((q) => q.path.includes("/rulesets")), fake.writeCount], ["blocked", "ng", "unknown", false, 0]);
  }
  {
    const { r, fake } = await run(routesOf({ repoStatus: 500 }), { authKind: "classic" });
    eq("preflight/5.2 リポジトリ情報を取得できなければ対象は確認不能（書き込みはゼロ）", [r.verdict, statusOf(r, "target"), fake.writeCount], ["unknown", "unknown", 0]);
  }

  // ---- プランと squash 設定 ----
  {
    const { r, fake } = await run(routesOf({ repo: { ...REPO_BODY, visibility: "private", private: true }, list: [] }), { authKind: "classic" });
    eq("preflight/5.2 非公開で既存 Ruleset の根拠がなければプランを確認できず確認不能", [r.verdict, statusOf(r, "plan"), fake.writeCount], ["unknown", "unknown", 0]);
  }
  {
    const { r, fake } = await run(routesOf({ repo: { ...REPO_BODY, visibility: "private", private: true }, list: [item(7)], details: { 7: detail(7, []) } }), { authKind: "classic" });
    eq("preflight/5.2 非公開でも既存 Ruleset が読めればプランの根拠になる", [r.verdict, statusOf(r, "plan"), fake.writeCount], ["ready", "ok", 0]);
  }
  {
    const { r, fake } = await run(routesOf({ repo: { ...REPO_BODY, allow_squash_merge: false } }), { authKind: "classic" });
    eq("preflight/5.2 squash が無効なら ng で、リポジトリ設定は変えない（書き込みはゼロ）", [r.verdict, statusOf(r, "squash"), fake.writeCount], ["blocked", "ng", 0]);
  }
  {
    const { r, fake } = await run(routesOf({ repo: { ...REPO_BODY, allow_squash_merge: undefined } }), { authKind: "classic" });
    eq("preflight/5.2 squash 設定が応答にない場合は確認不能", [r.verdict, statusOf(r, "squash"), fake.writeCount], ["unknown", "unknown", 0]);
  }

  // ---- 分岐元と既存のルール ----
  {
    const { r, fake } = await run(routesOf(), { authKind: "classic", branch: "feature+x" });
    eq("preflight/5.2 Ruleset の対象にできない分岐元名は ng で、実効ルールを読みに行かない", [r.verdict, statusOf(r, "branchRef"), statusOf(r, "existingRules"), fake.requests.some((q) => q.path.includes("/rules/")), fake.writeCount], ["blocked", "ng", "unknown", false, 0]);
  }
  {
    const { r, fake } = await run(routesOf({ rules: [effective(9, ["merge"])], details: { 9: detail(9, []) } }), { authKind: "classic" });
    eq("preflight/5.2 squash を許可しない既存のプルリクエスト必須ルールは競合として ng", [r.verdict, statusOf(r, "existingRules"), fake.writeCount], ["blocked", "ng", 0]);
  }
  {
    const { r, fake } = await run(routesOf({ list: [item(7)], rules: [effective(7, ["squash"])], details: { 7: detail(7, []) } }), { authKind: "classic", knownRulesetIds: [7] });
    eq("preflight/5.2 squash 限定の既存ルールは再利用候補として返し、導入に進める", [r.verdict, statusOf(r, "existingRules"), r.existing.reusable, r.existing.squashOnly, r.existing.brwRecorded, fake.writeCount], ["ready", "ok", [7], true, [7], 0]);
  }
  {
    const { r, fake } = await run(routesOf({ list: [item(7)], rules: [effective(7, ["squash"])], details: { 7: { ...detail(7), bypass_actors: undefined } } }), { authKind: "classic" });
    eq("preflight/5.2 バイパス情報のない既存ルールは根拠にできず確認不能", [r.verdict, statusOf(r, "existingRules"), r.existing.reusable, fake.writeCount], ["unknown", "unknown", [], 0]);
  }
  {
    const { r, fake } = await run(routesOf({ list: [item(7)], rules: [effective(7, ["squash"])], details: { 7: detail(7, [{ actor_id: 1 }]) } }), { authKind: "classic" });
    eq("preflight/5.2 バイパスのある既存ルールは再利用候補に含めない", [r.verdict, r.existing.reusable, fake.writeCount], ["ready", [], 0]);
  }
  {
    const { r, fake } = await run(routesOf({ rules: [{ type: "pull_request", ruleset_id: 9, parameters: null }], details: { 9: detail(9, []) } }), { authKind: "classic" });
    eq("preflight/5.2 許可マージ方式を読めないプルリクエスト必須ルールは確認不能", [r.verdict, statusOf(r, "existingRules"), fake.writeCount], ["unknown", "unknown", 0]);
  }
  {
    const { r, fake } = await run(routesOf({ rulesStatus: 500 }), { authKind: "classic" });
    eq("preflight/5.2 実効ルールを読めない場合は分岐元と既存ルールを確認不能にする（書き込みはゼロ）", [r.verdict, statusOf(r, "branchRef"), statusOf(r, "existingRules"), fake.writeCount], ["unknown", "unknown", "unknown", 0]);
  }
  {
    const { r, fake } = await run(routesOf({ rules: [effective(9, ["merge"])], details: {} }), { authKind: "classic" });
    eq("preflight/5.2 既存ルールの詳細が読めなければ確認不能（競合の ng が優先される）", [r.verdict, statusOf(r, "existingRules"), fake.writeCount], ["blocked", "ng", 0]);
  }

  // ---- トークン種別とスコープ（ヘッダーで判定し、自己申告に頼らない） ----
  {
    const { r, fake } = await run(routesOf({ scopes: "public_repo" }), { authKind: "classic" });
    eq("preflight/5.2 classic で admin が true でも repo スコープがなければ ready にならず、書き込みはゼロ", [r.verdict, r.writeAllowed, statusOf(r, "permission"), fake.writeCount], ["blocked", false, "ng", 0]);
  }
  {
    const { r, fake } = await run(routesOf({ scopes: "" }), { authKind: "classic" });
    eq("preflight/5.2 classic でスコープが空なら ng で、書き込みはゼロ", [r.verdict, r.writeAllowed, statusOf(r, "permission"), fake.writeCount], ["blocked", false, "ng", 0]);
  }
  {
    const { r, fake } = await run(routesOf({ scopes: "repo, workflow" }), {});
    eq("preflight/5.2 申告なしでもヘッダーの repo スコープがあれば classic として導入に進める", [r.verdict, statusOf(r, "permission"), fake.writeCount], ["ready", "ok", 0]);
  }
  {
    // classic と申告したがヘッダーがない（fine-grained と同じ証拠が要る）。既存 Ruleset がなければ確認不能
    const { r, fake } = await run(routesOf({ scopes: null }), { authKind: "classic" });
    eq("preflight/5.2 classic と申告してもスコープのヘッダーがなければ厳しい側で確認し、証拠がなければ確認不能", [r.verdict, r.writeAllowed, statusOf(r, "permission"), fake.writeCount], ["unknown", false, "unknown", 0]);
  }
  {
    // fine-grained と申告したがヘッダーで repo スコープが返る（食い違い）。厳しい側で、既存 Ruleset の証拠がなければ確認不能
    const { r, fake } = await run(routesOf({ scopes: "repo" }), { authKind: "fine-grained" });
    eq("preflight/5.2 fine-grained と申告してもヘッダーと食い違えば厳しい側で確認し、証拠がなければ確認不能", [r.verdict, r.writeAllowed, statusOf(r, "permission"), fake.writeCount], ["unknown", false, "unknown", 0]);
  }
  {
    // 既存 Ruleset が Repository 所有のものを優先して証拠に使う
    const { r, fake } = await run(routesOf({ scopes: null, list: [item(8, { source_type: "Organization", source: "acme" }), item(7)], details: { 7: detail(7, []) } }), { authKind: "fine-grained" });
    eq("preflight/5.2 fine-grained の権限の証拠は所有元が Repository の Ruleset を優先する", [r.verdict, statusOf(r, "permission"), fake.requests.some((q) => q.path === DETAIL(8)), fake.writeCount], ["ready", "ok", false, 0]);
  }

  // ---- 分岐元の存在 ----
  {
    const { r, fake } = await run(routesOf({ branches: [{ name: "develop" }] }), { authKind: "classic" });
    eq("preflight/5.2 分岐元が存在しなければ branchRef を ng にし、書き込みはゼロ", [r.verdict, statusOf(r, "branchRef"), fake.writeCount], ["blocked", "ng", 0]);
  }
  {
    const { r, fake } = await run(routesOf({ branchStatus: 500 }), { authKind: "classic" });
    eq("preflight/5.2 分岐元の一覧を読めなければ branchRef は確認不能", [r.verdict, statusOf(r, "branchRef"), fake.writeCount], ["unknown", "unknown", 0]);
  }
};
