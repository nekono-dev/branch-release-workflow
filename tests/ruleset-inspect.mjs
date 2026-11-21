// 実効ルールと通常作業の権限の検査（brw-enforcement 5.4）の契約テスト。偽の応答層だけを使い、実際の通信・認証はしない。
// 検査は読み取りだけを行う。どの場合も書き込み要求が 0 件であることを確認する。
// 記録済みの Ruleset ID は効いているルールの証拠にしない。分岐元ごとに実効ルールを読み直すことを確かめる。
import { readFileSync } from "node:fs";
import { createGitHubSession } from "../scripts/github-client.mjs";
import { choiceFileOf, recordApplied, recordChoice } from "../scripts/ruleset-choice.mjs";
import { inspectRulesets } from "../scripts/ruleset-inspect.mjs";
import { createFakeGitHub } from "./support/fake-github.mjs";
import { mkRepoWithRemote } from "./support/git-fixture.mjs";

const TOKEN = "ghp_INSPECTSECRET1234567890ABCDEF";
const WORK_TOKEN = "ghp_WORKSECRET0987654321ZYXWVU";
const T = { host: "github.com", owner: "acme", name: "app" };
const REFS = ["develop", "main"];
const REPO_BODY = { id: 42, full_name: "Acme/App", private: false, visibility: "public", allow_squash_merge: true, default_branch: "main", permissions: { admin: true, push: true, pull: true } };
const RULES = (ref) => `GET /repos/acme/app/rules/branches/${ref}?per_page=100&page=1`;
const DETAIL = (id) => `GET /repos/acme/app/rulesets/${id}?includes_parents=true`;
const ok = (body) => ({ status: 200, body });
const item = (id, extra = {}) => ({ id, name: `r${id}`, target: "branch", enforcement: "active", source_type: "Repository", source: "acme/app", ...extra });
/**
 * BRW 形の既存 Ruleset の詳細。bypass は bypass_actors の値、noBypass は応答から項目を省く（確認不能）。
 * rules を渡すと PR ルール以外の内容にも差し替えられる。
 */
const detail = (id, { include = ["refs/heads/develop", "refs/heads/main"], exclude = [], methods = ["squash"], bypass = [], noBypass = false, enforcement = "active", target = "branch", rules } = {}) => ({
  ...item(id, { enforcement, target }),
  conditions: { ref_name: { include, exclude } },
  rules: rules ?? [{ type: "pull_request", parameters: { allowed_merge_methods: methods } }],
  ...(noBypass ? {} : { bypass_actors: bypass }),
});
const effective = (id, methods) => ({ type: "pull_request", ruleset_id: id, ruleset_source_type: "Repository", ruleset_source: "acme/app", parameters: { allowed_merge_methods: methods } });
const viaFake = (fake) => async ({ method, path, body, host }) => fake.request(method, path, body, { host });
const st = (xs) => xs.map((x) => x.status);

/**
 * 管理者の認証で読む応答一式。rules は分岐元ごとの実効ルール（省略時は ID 7 の squash 限定）。
 * overrides は経路ごとの差し替え（"METHOD path" のキー）。
 */
const adminRoutes = ({ repo = REPO_BODY, rules = {}, details = { 7: detail(7) }, overrides = {} } = {}) => {
  const r = { "GET /repos/acme/app": ok(repo) };
  for (const ref of REFS) r[RULES(ref)] = ok(rules[ref] ?? [effective(7, ["squash"])]);
  for (const [id, body] of Object.entries(details)) r[DETAIL(id)] = ok(body);
  return { ...r, ...overrides };
};

/** 作業経路の gh（開発端末の gh CLI）。作業用の認証で別の偽の応答層を作り、主体と権限を読ませる。 */
const workRoute = ({ login = "dev-user", admin = false, push = true, name = "gh（開発端末）", declaredActor } = {}) => {
  const fake = createFakeGitHub({
    routes: {
      "GET /user": { status: 200, body: { login }, headers: { "x-oauth-scopes": "repo" } },
      "GET /repos/acme/app": ok({ ...REPO_BODY, permissions: { admin, push, pull: true } }),
    },
  });
  const session = createGitHubSession({ host: "github.com", token: WORK_TOKEN, transport: viaFake(fake) });
  return { fake, route: { name, transport: "gh", session, ...(declaredActor !== undefined ? { declaredActor } : {}) } };
};

/** 管理された SSH・MCP の証跡（管理設定で固定された主体・権限・参照先）。 */
const managedRoute = ({ name = "SSH デプロイキー", transport = "ssh", actor = "deploy-bot", fixed = true, evidence = "管理設定 deploy.json#ssh", permissions = { admin: false, push: true } } = {}) => ({
  name,
  transport,
  managed: { actor, fixed, evidence, permissions },
});

const runInspect = async (rt, { refs = REFS, afterApply, routes = [], cwd } = {}) => {
  const fake = createFakeGitHub({ routes: rt });
  const session = createGitHubSession({ host: "github.com", token: TOKEN, transport: viaFake(fake) });
  const r = await inspectRulesets(session, T, refs, { routes, afterApply, cwd });
  return { r, fake };
};
const allGet = (fake) => fake.requests.every((q) => q.method === "GET");

export const runRulesetInspectChecks = async (eq) => {
  // ---- 適用済み（実効ルールと作業経路の両方が確認できる） ----
  {
    const work = workRoute({ push: true, admin: false });
    const { r, fake } = await runInspect(adminRoutes(), { routes: [work.route] });
    eq("inspect/5.4 全分岐元に PR 必須・squash 限定・バイパスなしの実効ルールがあり、作業経路も迂回できなければ適用済み", [r.status, st(r.checks), st(r.refs), r.refs.map((x) => x.proofRulesetIds), st(r.routes), r.verified, fake.writeCount, work.fake.writeCount], ["enforced", ["ok", "ok"], ["ok", "ok"], [[7], [7]], ["ok"], null, 0, 0]);
  }
  {
    const work = workRoute({ push: true });
    const { fake } = await runInspect(adminRoutes(), { routes: [work.route] });
    eq("inspect/5.4 読み取りだけを行う（管理者の経路も作業経路も GET のみ）", [allGet(fake), allGet(work.fake)], [true, true]);
  }

  // ---- 分岐元ごとの検査（記録があっても全分岐元を覆うとみなさない） ----
  {
    const work = workRoute();
    const { r, fake } = await runInspect(adminRoutes({ rules: { develop: [] } }), { routes: [work.route] });
    eq("inspect/5.4 一つの分岐元に実効ルールがなければ設定のずれとし、他の分岐元が ok でも全体は適用済みにしない", [r.status, r.refs.map((x) => [x.ref, x.status]), fake.writeCount], ["drift", [["develop", "drift"], ["main", "ok"]], 0]);
  }
  {
    const work = workRoute();
    const { r } = await runInspect(adminRoutes({ rules: { develop: [] } }), { routes: [work.route], afterApply: true });
    eq("inspect/5.4 適用後の検査で分岐元の実効ルールが欠けていれば、適用後の確認失敗にする", [r.status, r.refs.map((x) => x.status)], ["verify-failed", ["verify-failed", "ok"]]);
  }

  // ---- 設定のずれ（squash・他のルールとの整合・バイパス） ----
  {
    const work = workRoute();
    const { r } = await runInspect(adminRoutes({ repo: { ...REPO_BODY, allow_squash_merge: false } }), { routes: [work.route] });
    eq("inspect/5.4 squash が無効なリポジトリは日常検査で設定のずれ（設定は変えない）", [r.status, st(r.checks)], ["drift", ["ok", "drift"]]);
  }
  {
    const work = workRoute();
    const { r } = await runInspect(adminRoutes({ repo: { ...REPO_BODY, allow_squash_merge: false } }), { routes: [work.route], afterApply: true });
    eq("inspect/5.4 適用後に squash が無効なら、適用後の確認失敗にする", [r.status, st(r.checks)], ["verify-failed", ["ok", "verify-failed"]]);
  }
  {
    const work = workRoute();
    const { r, fake } = await runInspect(adminRoutes({ rules: { develop: [effective(7, ["merge"])], main: [effective(7, ["merge"])] } }), { routes: [work.route] });
    eq("inspect/5.4 squash を許可しない PR 必須ルールは他のルールとの競合として設定のずれ", [r.status, st(r.refs), fake.writeCount], ["drift", ["drift", "drift"], 0]);
  }
  {
    // squash と merge を両方許すルールは squash 限定ではない（squash 限定の判定が効いていることを確かめる）
    const work = workRoute();
    const both = adminRoutes({ rules: { develop: [effective(7, ["squash", "merge"])], main: [effective(7, ["squash", "merge"])] }, details: { 7: detail(7, { methods: ["squash", "merge"] }) } });
    const { r } = await runInspect(both, { routes: [work.route] });
    eq("inspect/5.4 squash と merge を両方許すルールは squash 限定とみなさず、設定のずれ", [r.status, st(r.refs)], ["drift", ["drift", "drift"]]);
  }
  {
    const work = workRoute();
    const { r } = await runInspect(adminRoutes({ details: { 7: detail(7, { bypass: [{ actor_id: 1, actor_type: "RepositoryRole" }] }) } }), { routes: [work.route] });
    eq("inspect/5.4 バイパスを許す squash ルールは適合の根拠にせず、設定のずれ", [r.status, st(r.refs)], ["drift", ["drift", "drift"]]);
  }
  {
    const work = workRoute();
    const { r } = await runInspect(adminRoutes({ details: { 7: detail(7, { noBypass: true }) } }), { routes: [work.route] });
    eq("inspect/5.4 バイパス情報が返らないルールは根拠にせず、確認できないので日常検査でも適用後の確認失敗", [r.status, st(r.refs)], ["verify-failed", ["verify-failed", "verify-failed"]]);
  }
  {
    const work = workRoute();
    const { r } = await runInspect(adminRoutes({ overrides: { [RULES("develop")]: { status: 500, body: { message: "err" } } } }), { routes: [work.route] });
    eq("inspect/5.4 実効ルールの読み取りに失敗した分岐元は確認失敗にする", [r.status, st(r.refs)], ["verify-failed", ["verify-failed", "ok"]]);
  }
  {
    const work = workRoute();
    const { r } = await runInspect(adminRoutes({ details: {} }), { routes: [work.route], afterApply: true });
    eq("inspect/5.4 適用後に Ruleset の詳細を読めなければ確認失敗", [r.status, st(r.refs)], ["verify-failed", ["verify-failed", "verify-failed"]]);
  }
  {
    // 別のリポジトリとして応答した場合は設定のずれ。分岐元の実効ルールは読みに行かない
    const work = workRoute();
    const { r, fake } = await runInspect(adminRoutes({ repo: { ...REPO_BODY, full_name: "acme/other" } }), { routes: [work.route] });
    eq("inspect/5.4 応答のリポジトリが対象と異なれば設定のずれ、実効ルールは読まない", [r.status, st(r.checks), st(r.refs), fake.requests.some((q) => q.path.includes("/rules/"))], ["drift", ["drift", "verify-failed"], ["verify-failed", "verify-failed"], false]);
  }
  {
    const work = workRoute();
    const { r } = await runInspect(adminRoutes(), { refs: ["feature+x", "main"], routes: [work.route] });
    eq("inspect/5.4 Ruleset の対象にできない分岐元名は設定のずれとして返し、通信しない", [r.status, st(r.refs)], ["drift", ["drift", "ok"]]);
  }

  // ---- 適合の根拠になる Ruleset 詳細（有効化・対象の種類・分岐元の一致） ----
  {
    const work = workRoute();
    for (const [label, d] of [["evaluate", detail(7, { enforcement: "evaluate" })], ["disabled", detail(7, { enforcement: "disabled" })]]) {
      const { r } = await runInspect(adminRoutes({ details: { 7: d } }), { routes: [work.route] });
      eq(`inspect/5.4 有効化されていない（${label}）Ruleset は適合の根拠にせず、設定のずれ`, [r.status, st(r.refs)], ["drift", ["drift", "drift"]]);
    }
  }
  {
    const work = workRoute();
    const { r } = await runInspect(adminRoutes({ details: { 7: detail(7, { enforcement: "evaluate" }) } }), { routes: [work.route], afterApply: true });
    eq("inspect/5.4 適用後に有効化されていなければ、適用後の確認失敗にする", [r.status, st(r.refs)], ["verify-failed", ["verify-failed", "verify-failed"]]);
  }
  {
    const work = workRoute();
    const { r } = await runInspect(adminRoutes({ details: { 7: detail(7, { target: "tag" }) } }), { routes: [work.route] });
    eq("inspect/5.4 対象が分岐元ではない（tag）Ruleset は根拠にせず、設定のずれ", [r.status, st(r.refs)], ["drift", ["drift", "drift"]]);
  }
  {
    const work = workRoute();
    const { r } = await runInspect(adminRoutes({ details: { 7: detail(7, { include: ["refs/heads/other"] }) } }), { routes: [work.route] });
    eq("inspect/5.4 include が当該分岐元を含まない Ruleset は根拠にせず、設定のずれ", [r.status, st(r.refs)], ["drift", ["drift", "drift"]]);
  }
  {
    const work = workRoute();
    const { r } = await runInspect(adminRoutes({ details: { 7: detail(7, { exclude: ["refs/heads/develop"] }) } }), { routes: [work.route] });
    eq("inspect/5.4 exclude に当該分岐元が含まれる Ruleset は根拠にしない（develop は設定のずれ、main は適合）", [r.status, st(r.refs)], ["drift", ["drift", "ok"]]);
  }
  {
    const work = workRoute();
    const { r } = await runInspect(adminRoutes({ details: { 7: detail(7, { include: ["~ALL"] }) } }), { routes: [work.route] });
    eq("inspect/5.4 include の ~ALL は全分岐元を対象とみなし、適合の根拠になる", [r.status, st(r.refs), r.refs.map((x) => x.proofRulesetIds)], ["enforced", ["ok", "ok"], [[7], [7]]]);
  }
  {
    const work = workRoute();
    const { r } = await runInspect(adminRoutes({ details: { 7: detail(7, { include: ["~DEFAULT_BRANCH"] }) } }), { routes: [work.route] });
    eq("inspect/5.4 ~DEFAULT_BRANCH は既定の分岐元（main）に対してだけ適合の根拠になる", [r.status, st(r.refs)], ["drift", ["drift", "ok"]]);
  }

  // ---- 作業経路の主体と権限 ----
  {
    const work = workRoute({ admin: true, push: true });
    const { r } = await runInspect(adminRoutes(), { routes: [work.route] });
    eq("inspect/5.4 作業経路の主体が Ruleset を変更できる権限を持つなら、迂回可能として設定のずれ", [r.status, st(r.routes), r.routes[0].permissions], ["drift", ["drift"], { admin: true, push: true }]);
  }
  {
    const work = workRoute({ declaredActor: "dev-user" });
    const { r } = await runInspect(adminRoutes(), { routes: [work.route] });
    eq("inspect/5.4 自己申告の主体と実際の主体が一致すれば、その主体の権限で判定する", [r.status, st(r.routes), r.routes[0].actor], ["enforced", ["ok"], "dev-user"]);
  }
  {
    const work = workRoute({ declaredActor: "someone-else" });
    const { r } = await runInspect(adminRoutes(), { routes: [work.route] });
    eq("inspect/5.4 自己申告の主体と実際の主体が違えば、確認不能", [r.status, st(r.routes)], ["unverifiable", ["unverifiable"]]);
  }
  {
    const { r } = await runInspect(adminRoutes(), { routes: [{ name: "gh（自己申告のみ）", transport: "gh", declaredActor: "dev-user" }] });
    eq("inspect/5.4 gh の経路で作業用の認証を照合していなければ（自己申告だけでは）確認不能", [r.status, st(r.routes)], ["unverifiable", ["unverifiable"]]);
  }
  {
    const { r } = await runInspect(adminRoutes(), { routes: [managedRoute({ permissions: { admin: true, push: true } })] });
    eq("inspect/5.4 管理された SSH の主体が Ruleset を変更できるなら、迂回可能として設定のずれ", [r.status, st(r.routes)], ["drift", ["drift"]]);
  }
  {
    const { r } = await runInspect(adminRoutes(), { routes: [managedRoute({ permissions: { admin: false, push: true } })] });
    eq("inspect/5.4 管理された SSH の主体が変更権限を持たず、バイパスもなければ適用済み", [r.status, st(r.routes)], ["enforced", ["ok"]]);
  }
  {
    const { r } = await runInspect(adminRoutes(), { routes: [{ name: "SSH（申告のみ）", transport: "ssh", declaredActor: "deploy-bot" }] });
    eq("inspect/5.4 管理された証跡のない SSH は自己申告だけでは確認不能", [r.status, st(r.routes)], ["unverifiable", ["unverifiable"]]);
  }
  {
    const { r } = await runInspect(adminRoutes(), { routes: [managedRoute({ fixed: false })] });
    eq("inspect/5.4 作業主体が管理設定で固定されていなければ確認不能", [r.status, st(r.routes)], ["unverifiable", ["unverifiable"]]);
  }
  {
    const route = { name: "MCP（権限の記載なし）", transport: "mcp", managed: { actor: "mcp-bot", fixed: true, evidence: "管理設定 mcp.json" } };
    const { r } = await runInspect(adminRoutes(), { routes: [route] });
    eq("inspect/5.4 権限の証跡がない MCP は確認不能", [r.status, st(r.routes)], ["unverifiable", ["unverifiable"]]);
  }
  {
    // 作業経路のどれかで迂回の可否が分からなければ、迂回不可とは表示しない（バイパス情報の欠落）
    const work = workRoute();
    const { r } = await runInspect(adminRoutes({ details: { 7: detail(7), 8: detail(8, { noBypass: true, rules: [{ type: "required_status_checks", parameters: {} }] }) }, rules: { develop: [effective(7, ["squash"]), { type: "required_status_checks", ruleset_id: 8, parameters: {} }], main: [effective(7, ["squash"])] } }), { routes: [work.route] });
    eq("inspect/5.4 効いているルールのバイパス情報が欠けると、作業経路は確認不能（ルール自体は適用済み）", [r.status, st(r.refs), st(r.routes)], ["unverifiable", ["ok", "ok"], ["unverifiable"]]);
  }
  {
    const work = workRoute();
    const { r } = await runInspect(adminRoutes({ details: { 7: detail(7), 8: detail(8, { bypass: [{ actor_id: 5, actor_type: "Team" }], rules: [{ type: "required_status_checks", parameters: {} }] }) }, rules: { develop: [effective(7, ["squash"]), { type: "required_status_checks", ruleset_id: 8, parameters: {} }], main: [effective(7, ["squash"])] } }), { routes: [work.route] });
    eq("inspect/5.4 効いている別のルールにバイパス対象があると、作業経路の迂回を照合できず確認不能", [r.status, st(r.routes)], ["unverifiable", ["unverifiable"]]);
  }
  {
    const { r } = await runInspect(adminRoutes(), { routes: [] });
    eq("inspect/5.4 作業経路が一つも指定されなければ、経路の確認は不能（ルールだけでは適用済みにしない）", [r.status, st(r.refs), r.routes], ["unverifiable", ["ok", "ok"], []]);
  }
  {
    const { r } = await runInspect(adminRoutes(), { routes: [{ name: "未知", transport: "http", managed: { actor: "x", fixed: true, evidence: "e", permissions: { admin: false, push: false } } }] });
    eq("inspect/5.4 種類の分からない作業経路は確認不能", [r.status, st(r.routes)], ["unverifiable", ["unverifiable"]]);
  }

  // ---- 適用後の確認と記録（記録の更新は全分岐元が確認できたときだけ） ----
  {
    const r0 = mkRepoWithRemote({ branch: "main" });
    const base = { host: "github.com", owner: "acme", repository: "app", refs: REFS };
    recordChoice(r0.dir, { ...base, enabled: true, repositoryId: 42 });
    recordApplied(r0.dir, { ...base, repositoryId: 42, rulesetId: 7 });
    const work = workRoute();
    const { r } = await runInspect(adminRoutes(), { routes: [work.route], afterApply: true, cwd: r0.dir });
    const rec = JSON.parse(readFileSync(choiceFileOf(r0.dir), "utf8"));
    const applied = Object.values(rec.repos)[0].applied[0];
    eq("inspect/5.4 適用後に全分岐元が確認できたら、記録の ID を確認済みにする", [r.status, r.verified?.results.map((x) => [x.rulesetId, x.ok]), applied.verified], ["enforced", [[7, true]], true]);
    r0.cleanup();
  }
  {
    const r0 = mkRepoWithRemote({ branch: "main" });
    const base = { host: "github.com", owner: "acme", repository: "app", refs: REFS };
    recordChoice(r0.dir, { ...base, enabled: true, repositoryId: 42 });
    recordApplied(r0.dir, { ...base, repositoryId: 42, rulesetId: 7 });
    const { r } = await runInspect(adminRoutes({ rules: { develop: [] } }), { routes: [], afterApply: true, cwd: r0.dir });
    const rec = JSON.parse(readFileSync(choiceFileOf(r0.dir), "utf8"));
    eq("inspect/5.4 一部の分岐元しか確認できなければ記録を確認済みにしない", [r.verified, Object.values(rec.repos)[0].applied[0].verified], [null, false]);
    r0.cleanup();
  }
  {
    // 記録にない ID は確認済みにできず、その旨を結果に返す
    const r0 = mkRepoWithRemote({ branch: "main" });
    const base = { host: "github.com", owner: "acme", repository: "app", refs: REFS };
    recordChoice(r0.dir, { ...base, enabled: true, repositoryId: 42 });
    const work = workRoute();
    const { r } = await runInspect(adminRoutes(), { routes: [work.route], afterApply: true, cwd: r0.dir });
    eq("inspect/5.4 記録のない Ruleset ID は確認済みにできないと結果に返す", [r.verified?.results.map((x) => x.ok), typeof r.verified?.results[0]?.reason], [[false], "string"]);
    r0.cleanup();
  }

  // ---- 入力と秘密情報 ----
  {
    const { r, fake } = await runInspect(adminRoutes(), { refs: [] });
    eq("inspect/5.4 分岐元が空の入力は invalidInput とし、通信しない", [r.status, fake.requests.length], ["invalidInput", 0]);
  }
  {
    const work = workRoute({ declaredActor: "dev-user" });
    const { r } = await runInspect(adminRoutes(), { routes: [work.route] });
    const dump = JSON.stringify(r);
    eq("inspect/5.4 結果に資格情報（管理者・作業用）と session を含めない", [dump.includes(TOKEN), dump.includes(WORK_TOKEN), "session" in r], [false, false, false]);
  }
};
