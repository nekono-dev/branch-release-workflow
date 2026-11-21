// GitHub クライアントの Ruleset 照会・追加（brw-enforcement 3.3）の契約テスト。偽の応答層だけを使い、実際の通信・認証はしない。
import { createGitHubSession } from "../scripts/github-client.mjs";
import { createFakeGitHub } from "./support/fake-github.mjs";

const TOKEN = "ghp_SECRETSECRETSECRET1234567890";
const T = { host: "github.com", owner: "acme", name: "app" };
const REPO_BODY = { id: 42, full_name: "Acme/App", private: false, visibility: "public", allow_squash_merge: true, default_branch: "main", permissions: { admin: true, push: true, pull: true } };
const REPO = { "GET /repos/acme/app": { status: 200, body: REPO_BODY } };
const viaFake = (fake) => async ({ method, path, body, host }) => fake.request(method, path, body, { host });
const LIST = "GET /repos/acme/app/rulesets?includes_parents=true&per_page=100";
const item = (id, extra = {}) => ({ id, name: `r${id}`, target: "branch", enforcement: "active", source_type: "Repository", source: "acme/app", ...extra });
const detail = (id, extra = {}) => ({ ...item(id), conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } }, rules: [{ type: "pull_request", parameters: { allowed_merge_methods: ["squash"] } }], bypass_actors: [], ...extra });
const newSession = async (routes, scenario) => {
  const fake = createFakeGitHub({ routes: { ...REPO, ...routes }, scenario });
  const s = createGitHubSession({ host: "github.com", token: TOKEN, transport: viaFake(fake) });
  await s.confirmTarget(T);
  fake.requests.length = 0;
  return { fake, s };
};
const BODY = { name: "brw-main", target: "branch", enforcement: "active", bypass_actors: [], conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } }, rules: [{ type: "pull_request", parameters: { allowed_merge_methods: ["squash"], dismiss_stale_reviews_on_push: false, require_code_owner_review: false, require_last_push_approval: false, required_approving_review_count: 0, required_review_thread_resolution: false } }] };
const POST = "POST /repos/acme/app/rulesets";

export const runGithubRulesetChecks = async (eq) => {
  // ---- リポジトリ設定 ----
  {
    const { fake, s } = await newSession({});
    const r = await s.getRepositorySettings(T);
    eq("client/3.3 リポジトリ設定（squash 可否・公開範囲・権限情報）を返し、ID を照合する", [r.ok, r.settings, fake.requests.map((q) => q.path)], [true, { repositoryId: 42, fullName: "Acme/App", visibility: "public", private: false, allowSquashMerge: true, defaultBranch: "main", permissions: { admin: true, push: true, pull: true } }, ["/repos/acme/app"]]);
  }
  {
    const { s } = await newSession({ "GET /repos/acme/app": { status: 200, body: { id: 42, full_name: "acme/app" } } });
    const r = await s.getRepositorySettings(T);
    eq("client/3.3 squash 設定や権限情報が応答にない場合は null（確認不能）として返す", [r.ok, r.settings.allowSquashMerge, r.settings.permissions, r.settings.visibility], [true, null, null, null]);
  }
  {
    const routes = { ...REPO };
    const fake = createFakeGitHub({ routes });
    const s = createGitHubSession({ host: "github.com", token: TOKEN, transport: viaFake(fake) });
    await s.confirmTarget(T);
    routes["GET /repos/acme/app"] = { status: 200, body: { ...REPO_BODY, id: 43 } };
    const r = await s.getRepositorySettings(T);
    eq("client/3.3 リポジトリ ID が確定済みと異なる応答は target-mismatch", [r.ok, r.kind], [false, "target-mismatch"]);
  }
  {
    const f = createFakeGitHub({ routes: REPO });
    const s = createGitHubSession({ host: "github.com", token: TOKEN, transport: viaFake(f) });
    const r = await s.getRepositorySettings(T);
    const r2 = await s.listRulesets(T);
    eq("client/3.3 照合前の対象は照会せず通信しない", [r.kind, r2.kind, f.requests.length], ["refused", "refused", 0]);
  }

  // ---- 一覧（親ルール込み・ページング） ----
  {
    const page1 = Array.from({ length: 100 }, (_, i) => item(i + 1));
    const { fake, s } = await newSession({
      [`${LIST}&page=1`]: { status: 200, body: page1 },
      [`${LIST}&page=2`]: { status: 200, body: [item(101, { source_type: "Organization", source: "acme" })] },
    });
    const r = await s.listRulesets(T);
    eq("client/3.3 Ruleset 一覧は親ルールを含めて全ページを取得する", [r.ok, r.rulesets.length, r.rulesets[100], fake.requests.map((q) => q.path)], [true, 101, { id: 101, name: "r101", target: "branch", enforcement: "active", sourceType: "Organization", source: "acme" }, [`/repos/acme/app/rulesets?includes_parents=true&per_page=100&page=1`, `/repos/acme/app/rulesets?includes_parents=true&per_page=100&page=2`]]);
  }
  {
    const { s } = await newSession({ [`${LIST}&page=1`]: { status: 200, body: [] } });
    const r = await s.listRulesets(T);
    eq("client/3.3 空の一覧は ok で空配列（取得不能と区別する）", [r.ok, r.rulesets], [true, []]);
  }
  {
    const { s } = await newSession({ [`${LIST}&page=1`]: { status: 403, body: { message: "Forbidden" } } });
    const r = await s.listRulesets(T);
    eq("client/3.3 一覧を取得できない場合は空にせず失敗として返す", [r.ok, r.kind, r.rulesets], [false, "permission", undefined]);
  }
  {
    const page1 = Array.from({ length: 100 }, (_, i) => item(i + 1));
    const { s } = await newSession({ [`${LIST}&page=1`]: { status: 200, body: page1 }, [`${LIST}&page=2`]: { status: 502, body: { message: "Bad Gateway" } } });
    const r = await s.listRulesets(T);
    eq("client/3.3 途中のページの失敗は一部だけを成功として返さない", [r.ok, r.kind, r.rulesets], [false, "server", undefined]);
  }
  {
    const { s } = await newSession({ [`${LIST}&page=1`]: { status: 200, body: { rulesets: [] } } });
    const r1 = await s.listRulesets(T);
    const { s: s2 } = await newSession({ [`${LIST}&page=1`]: { status: 200, body: [item(1), item(1)] } });
    const r2 = await s2.listRulesets(T);
    const { s: s3 } = await newSession({ [`${LIST}&page=1`]: { status: 200, body: [{ name: "x" }] } });
    const r3 = await s3.listRulesets(T);
    eq("client/3.3 一覧でない応答・ID の重複・ID のない項目は不明な入力として返す", [r1.kind, r2.kind, r3.kind], ["unknown-input", "unknown-input", "unknown-input"]);
  }
  {
    const looped = Array.from({ length: 100 }, (_, i) => item(i + 1));
    const routes = {};
    for (let p = 1; p <= 60; p++) routes[`${LIST}&page=${p}`] = { status: 200, body: looped.map((x) => ({ ...x, id: x.id + (p - 1) * 100 })) };
    const { s } = await newSession(routes);
    const r = await s.listRulesets(T);
    eq("client/3.3 ページ数が上限を超える場合は全件を確認できないとして失敗する", [r.ok, r.kind], [false, "unknown-input"]);
  }

  // ---- 詳細 ----
  {
    const { fake, s } = await newSession({ "GET /repos/acme/app/rulesets/7?includes_parents=true": { status: 200, body: detail(7) } });
    const r = await s.getRuleset(T, 7);
    eq("client/3.3 Ruleset 詳細は条件・ルール・バイパス情報を返す", [r.ok, r.ruleset.id, r.ruleset.conditions, r.ruleset.rules.length, r.ruleset.bypassActors, r.ruleset.bypassInfo, fake.requests[0].path], [true, 7, { ref_name: { include: ["refs/heads/main"], exclude: [] } }, 1, [], "present", "/repos/acme/app/rulesets/7?includes_parents=true"]);
  }
  {
    const d = detail(7);
    delete d.bypass_actors;
    const { s } = await newSession({ "GET /repos/acme/app/rulesets/7?includes_parents=true": { status: 200, body: d } });
    const r = await s.getRuleset(T, 7);
    eq("client/3.3 バイパス情報がない詳細は確認不能（bypassActors null）として返す", [r.ok, r.ruleset.bypassActors, r.ruleset.bypassInfo], [true, null, "missing"]);
  }
  {
    const { s } = await newSession({ "GET /repos/acme/app/rulesets/7?includes_parents=true": { status: 200, body: detail(8) } });
    const r = await s.getRuleset(T, 7);
    const bad = [await s.getRuleset(T, 0), await s.getRuleset(T, "7"), await s.getRuleset(T, 1.5), await s.getRuleset(T, -1)];
    eq("client/3.3 要求と異なる ID の応答は target-mismatch、不正な ID は通信せず拒否する", [r.kind, bad.map((b) => b.kind)], ["target-mismatch", Array(4).fill("refused")]);
  }

  // ---- 対象 ref の実効ルール ----
  const RB = "GET /repos/acme/app/rules/branches";
  {
    const rules = [{ type: "pull_request", ruleset_source_type: "Repository", ruleset_source: "acme/app", ruleset_id: 7, parameters: { allowed_merge_methods: ["squash"] } }, { type: "deletion", ruleset_source_type: "Organization", ruleset_source: "acme", ruleset_id: 9 }];
    const { fake, s } = await newSession({ [`${RB}/dev%2Ffoo?per_page=100&page=1`]: { status: 200, body: rules } });
    const r = await s.getBranchRules(T, "dev/foo");
    eq("client/3.3 実効ルールは ref 名の / を %2F にして取得し、親ルール由来も返す", [r.ok, r.rules.map((x) => [x.type, x.rulesetId, x.sourceType]), fake.requests.map((q) => q.path)], [true, [["pull_request", 7, "Repository"], ["deletion", 9, "Organization"]], ["/repos/acme/app/rules/branches/dev%2Ffoo?per_page=100&page=1"]]);
  }
  {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ type: "deletion", ruleset_source_type: "Repository", ruleset_source: "acme/app", ruleset_id: i + 1 }));
    const { s } = await newSession({
      [`${RB}/main?per_page=100&page=1`]: { status: 200, body: page1 },
      [`${RB}/main?per_page=100&page=2`]: { status: 200, body: [{ type: "update", ruleset_source_type: "Repository", ruleset_source: "acme/app", ruleset_id: 5 }] },
    });
    const r = await s.getBranchRules(T, "main");
    eq("client/3.3 実効ルールもページングで全件取得する", [r.ok, r.rules.length], [true, 101]);
  }
  {
    const { s } = await newSession({ [`${RB}/main?per_page=100&page=1`]: { status: 200, body: [] } });
    const r = await s.getBranchRules(T, "main");
    const { s: s2 } = await newSession({});
    const r2 = await s2.getBranchRules(T, "main");
    eq("client/3.3 実効ルールが空（ok・空配列）と取得不能（失敗）を区別する", [r.ok, r.rules, r2.ok, r2.kind], [true, [], false, "unknown-input"]);
  }
  {
    const { fake, s } = await newSession({});
    const refs = ["../x", "a/../b", "%2e%2e", "a%2Fb", "dev/%2e%2e/main", ".", "a/./b", "a//b", "/main", "main/", "a b", "main?x=1", "a#b", "refs/heads/main", "", "x\\y", "-x", "a.lock", ".hidden", "a/.b", "{owner}", 5, null];
    const results = [];
    for (const ref of refs) results.push(await s.getBranchRules(T, ref));
    eq("client/3.3 ref 名に %・相対指定・空の区間・クエリ等があれば通信せずに拒否する", [results.map((x) => x.kind), fake.requests.length], [Array(refs.length).fill("refused"), 0]);
  }
  {
    const { s } = await newSession({ [`${RB}/main?per_page=100&page=1`]: { status: 200, body: [{ type: "deletion" }] } });
    const r = await s.getBranchRules(T, "main");
    eq("client/3.3 ルールの出所（ruleset_id）がない応答は不明な入力として返す", [r.ok, r.kind], [false, "unknown-input"]);
  }
  {
    const { s } = await newSession({});
    const viaRequest = [
      await s.request(T, "GET", "/repos/acme/app/rules/branches/dev%2Ffoo"),
      await s.request(T, "GET", "/repos/acme/app/rules/branches/%2e%2e"),
    ];
    eq("client/3.3 公開された request では % を含むパスを引き続き拒否する（狭い許可は専用関数のみ）", viaRequest.map((x) => x.kind), ["refused", "refused"]);
  }

  // ---- 追加 ----
  {
    const created = { ...detail(11), name: "brw-main" };
    const { fake, s } = await newSession({ [POST]: { status: 201, body: created } });
    const r = await s.createRuleset({ ...T, repositoryId: 42 }, BODY);
    eq("client/3.3 確定済みの対象に Ruleset を追加し、返却 ID と内容を検証して返す", [r.ok, r.created, r.ruleset.id, r.ruleset.name, fake.writeCount, fake.requests[0].path, fake.requests[0].body], [true, true, 11, "brw-main", 1, "/repos/acme/app/rulesets", BODY]);
  }
  {
    const f = createFakeGitHub({ routes: { ...REPO, [POST]: { status: 201, body: detail(11, { name: "brw-main" }) } } });
    const s = createGitHubSession({ host: "github.com", token: TOKEN, transport: viaFake(f) });
    const r = await s.createRuleset(T, BODY);
    eq("client/3.3 ID 照合前の追加は通信せずに拒否する", [r.kind, f.requests.length], ["refused", 0]);
  }
  {
    const { fake, s } = await newSession({ [POST]: { status: 201, body: detail(11, { name: "brw-main" }) } });
    const mk = (f) => f(structuredClone(BODY));
    const bads = [
      mk((b) => { b.bypass_actors = [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }]; return b; }),
      mk((b) => { delete b.bypass_actors; return b; }),
      mk((b) => { b.enforcement = "disabled"; return b; }),
      mk((b) => { b.enforcement = "evaluate"; return b; }),
      mk((b) => { b.target = "push"; return b; }),
      mk((b) => { b.conditions.ref_name.include = ["~ALL"]; return b; }),
      mk((b) => { b.conditions.ref_name.include = ["refs/heads/*"]; return b; }),
      mk((b) => { b.conditions.ref_name.include = ["~DEFAULT_BRANCH"]; return b; }),
      mk((b) => { b.conditions.ref_name.include = []; return b; }),
      mk((b) => { b.conditions.ref_name.include = ["main"]; return b; }),
      mk((b) => { b.conditions.ref_name.include = ["refs/heads/a/../b"]; return b; }),
      mk((b) => { b.conditions.ref_name.exclude = ["refs/heads/x"]; return b; }),
      mk((b) => { b.conditions.repository_name = { include: ["~ALL"] }; return b; }),
      mk((b) => { b.rules = []; return b; }),
      mk((b) => { b.rules = [{ type: "Pull Request" }]; return b; }),
      mk((b) => { b.name = ""; return b; }),
      mk((b) => { b.extra = 1; return b; }),
      [], null, "x", undefined,
    ];
    const rs = [];
    for (const b of bads) rs.push(await s.createRuleset(T, b));
    eq("client/3.3 バイパスあり・無効・全ブランチ・ワイルドカード・未知の項目などの本文は通信せずに拒否する", [rs.map((x) => x.kind), fake.requests.length], [Array(bads.length).fill("refused"), 0]);
  }
  {
    const { s } = await newSession({ [POST]: { status: 201, body: {} } });
    const r = await s.createRuleset(T, BODY);
    eq("client/3.3 返却 ID がない成功応答は結果不明として再取得での照合を促す", [r.ok, r.outcomeUnknown, r.reconcile], [false, true, true]);
  }
  {
    const { s } = await newSession({ [POST]: { status: 201, body: detail(11, { name: "brw-main", bypass_actors: [{ actor_id: 1, actor_type: "OrganizationAdmin", bypass_mode: "always" }] }) } });
    const r = await s.createRuleset(T, BODY);
    const { s: s2 } = await newSession({ [POST]: { status: 201, body: detail(11, { name: "brw-main", conditions: { ref_name: { include: ["~ALL"], exclude: [] } } }) } });
    const r2 = await s2.createRuleset(T, BODY);
    const { s: s3 } = await newSession({ [POST]: { status: 201, body: detail(11, { name: "brw-main", source: "other/repo" }) } });
    const r3 = await s3.createRuleset(T, BODY);
    eq("client/3.3 作成後の応答が要求と食い違う（バイパス・対象・所有元）場合は作成済みの ID と差異を返す", [[r.ok, r.kind, r.created, r.createdId, r.differences.length > 0], [r2.kind, r2.createdId], [r3.kind, r3.createdId]], [[false, "target-mismatch", true, 11, true], ["target-mismatch", 11], ["target-mismatch", 11]]);
  }
  {
    const { fake, s } = await newSession({ [POST]: { status: 201, body: detail(11, { name: "brw-main" }) } }, "lost");
    const r = await s.createRuleset(T, BODY);
    eq("client/3.3 追加の応答喪失は適用済みかもしれないため outcomeUnknown と再取得の印を付ける", [r.ok, r.kind, r.outcomeUnknown, r.reconcile, fake.applied.length, JSON.stringify(r).includes(TOKEN)], [false, "network", true, true, 1, false]);
  }
  {
    const { s } = await newSession({ [POST]: { status: 502, body: { message: "Bad Gateway" } } });
    const r = await s.createRuleset(T, BODY);
    const { s: s2 } = await newSession({ [POST]: { status: 422, body: { message: "Name must be unique" } } });
    const r2 = await s2.createRuleset(T, BODY);
    const { s: s3 } = await newSession({}, "permission");
    const r3 = await s3.createRuleset(T, BODY);
    eq("client/3.3 追加の 5xx は結果不明、422 は競合として再取得を促し、権限不足は印を付けない", [[r.kind, r.outcomeUnknown, r.reconcile], [r2.kind, r2.reconcile], [r3.kind, r3.reconcile, r3.outcomeUnknown]], [["server", true, true], ["unknown-input", true], ["permission", false, undefined]]);
  }
  {
    const { s } = await newSession({ [POST]: { status: 201, body: detail(11, { name: "brw-main" }) } });
    const direct = await s.request(T, "POST", "/repos/acme/app/rulesets", BODY);
    eq("client/3.3 公開された request からの Ruleset 追加は拒否し、専用関数だけが追加できる", [direct.ok, direct.kind], [false, "refused"]);
  }
};
