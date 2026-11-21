// Ruleset の再利用と追加（brw-enforcement 5.3）の契約テスト。偽の応答層だけを使い、実際の通信・認証はしない。
// 書き込みは POST /rulesets の 1 経路だけに限り、充足している場合・事前検査が通らない場合は書き込み 0 件であることを確かめる。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkRepoWithRemote } from "./support/git-fixture.mjs";
import { createGitHubSession } from "../scripts/github-client.mjs";
import { applyRuleset, rulesetBodyOf, RULESET_NAME } from "../scripts/ruleset-apply.mjs";
import { choiceFileOf, recordChoice, resolveChoice } from "../scripts/ruleset-choice.mjs";
import { createFakeGitHub } from "./support/fake-github.mjs";

const TOKEN = "ghp_APPLYSECRET1234567890ABCDEF";
const T = { host: "github.com", owner: "acme", name: "app" };
const REFS = ["develop", "release"];
const REPO_BODY = { id: 42, full_name: "Acme/App", private: false, visibility: "public", allow_squash_merge: true, default_branch: "main", permissions: { admin: true, push: true, pull: true } };
const LIST = "GET /repos/acme/app/rulesets?includes_parents=true&per_page=100&page=1";
const BRANCHES = "GET /repos/acme/app/branches?per_page=100&page=1";
const POST = "POST /repos/acme/app/rulesets";
const RULES = (ref) => `GET /repos/acme/app/rules/branches/${ref}?per_page=100&page=1`;
const DETAIL = (id) => `GET /repos/acme/app/rulesets/${id}?includes_parents=true`;
const ok = (body, headers) => ({ status: 200, body, ...(headers ? { headers } : {}) });
const item = (id, extra = {}) => ({ id, name: `r${id}`, target: "branch", enforcement: "active", source_type: "Repository", source: "acme/app", ...extra });
/** 既存の BRW 形式の Ruleset（squash 限定・バイパスなし）の詳細 */
const detail = (id, { include = ["refs/heads/develop"], methods = ["squash"], bypass = [], name = `r${id}` } = {}) => ({ ...item(id, { name }), conditions: { ref_name: { include, exclude: [] } }, rules: [{ type: "pull_request", parameters: { allowed_merge_methods: methods } }], bypass_actors: bypass });
const effective = (id, methods) => ({ type: "pull_request", ruleset_id: id, ruleset_source_type: "Repository", ruleset_source: "acme/app", parameters: { allowed_merge_methods: methods } });

/** 応答を組み立てる。rules は分岐元ごとの実効ルール、details は Ruleset ID ごとの詳細、list は一覧。 */
const routesOf = ({ repo = REPO_BODY, list = [], rules = {}, details = {}, scopes = "repo" } = {}) => {
  const r = {
    "GET /user": { status: 200, body: { login: "admin-user" }, headers: { "x-oauth-scopes": scopes } },
    [BRANCHES]: ok([{ name: "main" }, ...REFS.map((n) => ({ name: n }))]),
    "GET /repos/acme/app": ok(repo),
    [LIST]: ok(list),
    [POST]: { status: 201, body: {} },
  };
  for (const ref of REFS) r[RULES(ref)] = ok(rules[ref] ?? []);
  for (const [id, body] of Object.entries(details)) r[DETAIL(id)] = ok(body);
  return r;
};

/**
 * 偽の応答層を GitHub クライアントの通信層に変換する。
 * 書き込みが適用された（fake.applied が増えた）場合は、作成された Ruleset を一覧と詳細へ反映する。
 * 応答が届かない場合（lost・5xx）も、適用されていれば反映する。echo は送った本文から作成内容を作る。
 */
let nextId = 100;
const transportFor = (fake, routes, { echo = (b) => b, status = 201 } = {}) => async ({ method, path, body, host }) => {
  const before = fake.applied.length;
  let created = null;
  const make = () => {
    if (!created) created = { ...echo(body), id: nextId++, source_type: "Repository", source: "acme/app" };
    return created;
  };
  try {
    const r = await fake.request(method, path, body, { host });
    if (method === "POST" && r.status === 201) return { ...r, status, body: make() };
    return r;
  } finally {
    if (fake.applied.length > before) {
      const rs = make();
      routes[LIST] = ok([...routes[LIST].body, item(rs.id, { name: rs.name })]);
      routes[DETAIL(rs.id)] = ok({ ...rs, bypass_actors: rs.bypass_actors });
    }
  }
};

const CONFIG_TARGET = { host: "github.com", owner: "acme", repository: "app", refs: REFS };
/** 導入の選択を用意する。repositoryId を省くと未確定の選択になる。 */
const choose = (dir, extra = {}) => recordChoice(dir, { ...CONFIG_TARGET, enabled: true, ...extra });
const writesOf = (fake) => fake.requests.filter((q) => q.method !== "GET" && q.method !== "HEAD");
const fileJson = (dir) => JSON.parse(readFileSync(choiceFileOf(dir), "utf8"));

/** 1 回の適用を実行する。戻り値に fake と routes を添える。 */
const run = async (dir, { routes, scenario = "success", echo, status, input = {}, lockWaitMs = 50 } = {}) => {
  const rt = routes ?? routesOf();
  const fake = createFakeGitHub({ routes: rt, scenario });
  const session = createGitHubSession({ host: "github.com", token: TOKEN, transport: transportFor(fake, rt, { echo, status }) });
  const result = await applyRuleset(dir, { session, target: T, refs: REFS, authKind: "classic", ...input }, { lockWaitMs });
  return { result, fake, routes: rt };
};

export const runRulesetApplyChecks = async (eq) => {
  const r = mkRepoWithRemote({ branch: "dev/foo" });
  try {
    const d = r.dir;

    // ---- 導入の選択に従う（見送り・未選択では GitHub へ一切通信しない） ----
    {
      recordChoice(d, { ...CONFIG_TARGET, enabled: false });
      const { result, fake } = await run(d);
      eq("apply/5.3 見送りの選択では GitHub へ通信せず、適用しない", [result.status, result.ok, fake.requests.length], ["skipped", false, 0]);
    }
    {
      const dd = mkRepoWithRemote({ branch: "dev/foo" });
      try {
        const { result, fake } = await run(dd.dir);
        eq("apply/5.3 選択が未設定なら選択待ちとして返し、通信しない", [result.status, result.ok, fake.requests.length], ["pending", false, 0]);
      } finally { dd.cleanup(); }
    }

    // ---- 充足している場合は再利用（書き込みゼロ） ----
    choose(d);
    {
      const routes = routesOf({
        list: [item(7)],
        rules: { develop: [effective(7, ["squash"])], release: [effective(7, ["squash"])] },
        details: { 7: detail(7, { include: ["refs/heads/develop", "refs/heads/release"] }) },
      });
      const { result, fake } = await run(d, { routes });
      eq("apply/5.3 既存の squash 限定ルールで全分岐元が充足していれば再利用し、書き込みはゼロ", [result.status, result.ok, result.reusedRulesetIds, writesOf(fake).length], ["reused", true, { develop: [7], release: [7] }, 0]);
    }

    // ---- 一部だけ不足 → 不足の分岐元だけを完全な ref 指定で追加 ----
    {
      const dd = mkRepoWithRemote({ branch: "dev/foo" });
      try {
        recordChoice(dd.dir, { ...CONFIG_TARGET, enabled: true, repositoryId: 42 });
        const routes = routesOf({
          list: [item(7)],
          rules: { develop: [effective(7, ["squash"])] },
          details: { 7: detail(7, { include: ["refs/heads/develop"] }) },
        });
        const { result, fake } = await run(dd.dir, { routes });
        const w = writesOf(fake);
        eq("apply/5.3 充足している分岐元を除き、不足分（release）だけに Ruleset を追加する", [result.status, result.ok, result.includedRefs, w.length, w[0]?.path], ["applied", true, ["refs/heads/release"], 1, "/repos/acme/app/rulesets"]);
        const body = w[0]?.body;
        eq("apply/5.3 追加する本文は完全な ref・PR 必須・squash 限定・バイパスなし・有効", [body?.target, body?.enforcement, body?.bypass_actors, body?.conditions, body?.rules, body?.name], ["branch", "active", [], { ref_name: { include: ["refs/heads/release"], exclude: [] } }, [{ type: "pull_request", parameters: { allowed_merge_methods: ["squash"], dismiss_stale_reviews_on_push: false, require_code_owner_review: false, require_last_push_approval: false, required_approving_review_count: 0, required_review_thread_resolution: false } }], RULESET_NAME]);
        const rec = resolveChoice(dd.dir, { ...CONFIG_TARGET, repositoryId: 42 });
        eq("apply/5.3 作成した ID は選択と別に記録し、選択は変えない", [result.rulesetId, rec.status, rec.appliedRulesetIds, fileJson(dd.dir).repos["github.com/acme/app"].choice.enabled], [result.rulesetId, "selected", [result.rulesetId], true]);
      } finally { dd.cleanup(); }
    }

    // ---- 全分岐元が不足 → 不足の全 ref を 1 件の Ruleset に入れる ----
    {
      const dd = mkRepoWithRemote({ branch: "dev/foo" });
      try {
        choose(dd.dir);
        const { result, fake } = await run(dd.dir);
        const w = writesOf(fake);
        eq("apply/5.3 不足が全分岐元なら、完全な ref を並べた 1 件だけを追加する", [result.status, w.length, w[0]?.body?.conditions?.ref_name?.include], ["applied", 1, ["refs/heads/develop", "refs/heads/release"]]);
        eq("apply/5.3 追加の応答は作成した ID と本文を検証して記録する（記録済みとして返す）", [result.recorded, typeof result.rulesetId], [true, "number"]);
      } finally { dd.cleanup(); }
    }

    // ---- 事前検査が通らなければ書き込まない ----
    {
      const dd = mkRepoWithRemote({ branch: "dev/foo" });
      try {
        choose(dd.dir);
        const { result, fake } = await run(dd.dir, { routes: routesOf({ repo: { ...REPO_BODY, permissions: { admin: false, push: true, pull: true } } }) });
        eq("apply/5.3 管理権限がなければ blocked で、書き込みはゼロ・記録もしない", [result.status, result.ok, writesOf(fake).length, fileJson(dd.dir).repos["github.com/acme/app"].applied], ["blocked", false, 0, []]);
      } finally { dd.cleanup(); }
    }
    {
      const dd = mkRepoWithRemote({ branch: "dev/foo" });
      try {
        choose(dd.dir);
        const routes = routesOf({ rules: { develop: [effective(9, ["merge"])], release: [] }, details: { 9: detail(9, { include: ["refs/heads/develop"], methods: ["merge"] }) }, list: [item(9)] });
        const { result, fake } = await run(dd.dir, { routes });
        eq("apply/5.3 squash を許可しない既存のプルリクエスト必須ルールとの競合は書き込まない", [result.status, writesOf(fake).length], ["blocked", 0]);
      } finally { dd.cleanup(); }
    }

    // ---- 応答が届かない・複数候補（再取得して判断し、追加の書き込みを保留する） ----
    {
      const dd = mkRepoWithRemote({ branch: "dev/foo" });
      try {
        choose(dd.dir);
        // 5xx は適用された可能性がある。送った本文と同じ Ruleset が一覧に現れれば、それを記録し、再送しない
        const { result, fake } = await run(dd.dir, { routes: routesOf(), status: 500 });
        eq("apply/5.3 応答が 5xx で消えても、再取得で同条件の Ruleset を確認したら記録し、再送しない", [result.status, result.reconciled === true, result.recorded, writesOf(fake).length], ["applied", true, true, 1]);
      } finally { dd.cleanup(); }
    }
    {
      const dd = mkRepoWithRemote({ branch: "dev/foo" });
      try {
        choose(dd.dir);
        const { result, fake } = await run(dd.dir, { routes: routesOf(), scenario: "lost" });
        eq("apply/5.3 応答が途中で切れた場合も再取得で照合し、再送せず記録する", [result.status, writesOf(fake).length, result.recorded], ["applied", 1, true]);
      } finally { dd.cleanup(); }
    }
    {
      const dd = mkRepoWithRemote({ branch: "dev/foo" });
      try {
        choose(dd.dir);
        const routes = routesOf();
        // 応答喪失の間に別の端末が同条件の Ruleset を追加していた場合は候補が複数になる
        const fake = createFakeGitHub({ routes, scenario: "success" });
        const base = transportFor(fake, routes, { status: 500 });
        const session = createGitHubSession({ host: "github.com", token: TOKEN, transport: async (req) => {
          const res = await base(req);
          if (req.method === "POST") {
            const other = { ...detail(300, { include: ["refs/heads/develop", "refs/heads/release"] }), name: RULESET_NAME };
            routes[LIST] = ok([...routes[LIST].body, item(300, { name: RULESET_NAME })]);
            routes[DETAIL(300)] = ok(other);
          }
          return res;
        } });
        const result = await applyRuleset(dd.dir, { session, target: T, refs: REFS, authKind: "classic" }, { lockWaitMs: 50 });
        const before = fileJson(dd.dir).repos["github.com/acme/app"].applied;
        eq("apply/5.3 同条件の Ruleset が複数あれば候補を示して保留し、新たな ID は記録しない", [result.status, result.candidateIds?.length, writesOf(fake).length, before.length], ["conflict", 2, 1, 0]);
      } finally { dd.cleanup(); }
    }
    {
      const dd = mkRepoWithRemote({ branch: "dev/foo" });
      try {
        choose(dd.dir);
        // 応答が 503 で、再取得しても同条件の Ruleset がなければ確認不能として返す（自動で再送しない）
        const fake = createFakeGitHub({ routes: routesOf(), scenario: "success" });
        const session = createGitHubSession({ host: "github.com", token: TOKEN, transport: async (req) => {
          const res = await fake.request(req.method, req.path, req.body, { host: req.host });
          return req.method === "POST" ? { ...res, body: { message: "bad" }, status: 503 } : res;
        } });
        const result = await applyRuleset(dd.dir, { session, target: T, refs: REFS, authKind: "classic" }, { lockWaitMs: 50 });
        eq("apply/5.3 応答が消えて一覧にも無ければ unknown で返し、再送しない", [result.status, result.ok, writesOf(fake).length], ["unknown", false, 1]);
      } finally { dd.cleanup(); }
    }

    // ---- 拒否・権限不足は記録せず、理由を返す ----
    {
      const dd = mkRepoWithRemote({ branch: "dev/foo" });
      try {
        choose(dd.dir);
        const { result, fake } = await run(dd.dir, { scenario: "permission" });
        eq("apply/5.3 書き込みが 403 で拒否されたら rejected を返し、記録しない（送った 1 件は拒否された）", [result.status, result.ok, result.kind, result.httpStatus, writesOf(fake).length, fileJson(dd.dir).repos["github.com/acme/app"].applied], ["rejected", false, "permission", 403, 1, []]);
      } finally { dd.cleanup(); }
    }

    // ---- 作成後の検査 ----
    {
      const dd = mkRepoWithRemote({ branch: "dev/foo" });
      try {
        choose(dd.dir);
        const { result, fake } = await run(dd.dir, { echo: (b) => ({ ...b, rules: [{ type: "pull_request", parameters: { ...b.rules[0].parameters, allowed_merge_methods: ["merge", "squash"] } }] }) });
        eq("apply/5.3 作成された Ruleset の許可マージ方式が squash 限定でなければ mismatch とし、作成済み ID を記録する", [result.status, result.ok, typeof result.rulesetId, result.differences?.length > 0, writesOf(fake).length], ["mismatch", false, "number", true, 1]);
      } finally { dd.cleanup(); }
    }

    // ---- 選択のリポジトリ ID と GitHub の応答が食い違えば書き込まない ----
    {
      const dd = mkRepoWithRemote({ branch: "dev/foo" });
      try {
        recordChoice(dd.dir, { ...CONFIG_TARGET, enabled: true, repositoryId: 999 });
        const { result, fake } = await run(dd.dir);
        eq("apply/5.3 保存済みのリポジトリ ID と GitHub の応答が違えば選択待ちとし、書き込みはゼロ", [result.status, writesOf(fake).length], ["pending", 0]);
      } finally { dd.cleanup(); }
    }

    // ---- ローカルの適用を直列化する ----
    {
      const dd = mkRepoWithRemote({ branch: "dev/foo" });
      try {
        choose(dd.dir);
        const lock = `${choiceFileOf(dd.dir)}.apply.lock`;
        mkdirSync(dirname(lock), { recursive: true });
        writeFileSync(lock, String(process.pid));
        const { result, fake } = await run(dd.dir, { lockWaitMs: 50 });
        eq("apply/5.3 別の適用が進行中（ロック保持）なら conflict で待ち、書き込みはゼロ", [result.status, writesOf(fake).length, existsSync(lock)], ["conflict", 0, true]);
        rmSync(lock, { force: true });
      } finally { dd.cleanup(); }
    }
    {
      const dd = mkRepoWithRemote({ branch: "dev/foo" });
      try {
        choose(dd.dir);
        await run(dd.dir);
        eq("apply/5.3 適用後はロックを必ず解放する", existsSync(`${choiceFileOf(dd.dir)}.apply.lock`), false);
      } finally { dd.cleanup(); }
    }

    // ---- 資格情報・書き込みの経路 ----
    {
      const dd = mkRepoWithRemote({ branch: "dev/foo" });
      try {
        choose(dd.dir);
        const { result, fake } = await run(dd.dir);
        const stored = readFileSync(choiceFileOf(dd.dir), "utf8");
        const writePaths = writesOf(fake).map((q) => `${q.method} ${q.path}`);
        eq("apply/5.3 資格情報を結果にも記録にも含めず、書き込みは Ruleset の追加 1 経路だけ", [JSON.stringify(result).includes(TOKEN), stored.includes(TOKEN), writePaths], [false, false, ["POST /repos/acme/app/rulesets"]]);
        eq("apply/5.3 結果に GitHub の接続（session）を含めない", "session" in result, false);
      } finally { dd.cleanup(); }
    }

    // ---- 再利用と判定される条件の境界（reusable と rulesetIds を取り違えないことを確かめる） ----
    const COVERED_RELEASE = { list: [item(7), item(8)], details: { 8: detail(8, { include: ["refs/heads/release"] }) }, rules: { release: [effective(8, ["squash"])] } };
    {
      // (a) PR 必須はあるが squash 限定でない（squash と rebase）。競合はしないので、その分岐元だけ 1 件追加する
      const dd = mkRepoWithRemote({ branch: "dev/foo" });
      try {
        choose(dd.dir);
        const routes = routesOf({ list: [item(7), item(8)], details: { 7: detail(7, { include: ["refs/heads/develop"], methods: ["squash", "rebase"] }), 8: COVERED_RELEASE.details[8] }, rules: { develop: [effective(7, ["squash", "rebase"])], release: COVERED_RELEASE.rules.release } });
        const { result, fake } = await run(dd.dir, { routes });
        const w = writesOf(fake);
        eq("apply/5.3 squash 限定でない既存 PR 必須ルール（squash と rebase）は再利用せず、該当分岐元だけ 1 件追加する", [result.status, result.includedRefs, w.length, w[0]?.body?.conditions?.ref_name?.include], ["applied", ["refs/heads/develop"], 1, ["refs/heads/develop"]]);
      } finally { dd.cleanup(); }
    }
    {
      // (b) squash 限定だがバイパスがある既存 Ruleset は再利用せず、該当分岐元だけ追加する
      const dd = mkRepoWithRemote({ branch: "dev/foo" });
      try {
        choose(dd.dir);
        const routes = routesOf({ list: [item(7), item(8)], details: { 7: detail(7, { include: ["refs/heads/develop"], bypass: [{ actor_id: 1 }] }), 8: COVERED_RELEASE.details[8] }, rules: { develop: [effective(7, ["squash"])], release: COVERED_RELEASE.rules.release } });
        const { result, fake } = await run(dd.dir, { routes });
        const w = writesOf(fake);
        eq("apply/5.3 squash 限定でもバイパスのある既存 Ruleset は再利用せず、該当分岐元だけ 1 件追加する", [result.status, result.includedRefs, w.length, result.reusedRulesetIds], ["applied", ["refs/heads/develop"], 1, { release: [8] }]);
      } finally { dd.cleanup(); }
    }
    {
      // (c) 既存 Ruleset の詳細がバイパス情報なしで返る場合は事前検査が unknown。書き込みはせず、記録も増やさない
      const dd = mkRepoWithRemote({ branch: "dev/foo" });
      try {
        choose(dd.dir);
        const routes = routesOf({ list: [item(7)], details: { 7: { ...detail(7, { include: ["refs/heads/develop"] }), bypass_actors: undefined } }, rules: { develop: [effective(7, ["squash"])] } });
        const { result, fake } = await run(dd.dir, { routes });
        eq("apply/5.3 バイパス情報が返らない既存 Ruleset があれば事前検査は unknown で、書き込み 0 件・記録は空", [result.status, result.ok, writesOf(fake).length, fileJson(dd.dir).repos["github.com/acme/app"].applied], ["unknown", false, 0, []]);
      } finally { dd.cleanup(); }
    }

    // ---- ロック: 持ち主のいない古いロックは引き継ぎ、例外時も解放する ----
    {
      const dd = mkRepoWithRemote({ branch: "dev/foo" });
      try {
        choose(dd.dir);
        const lock = `${choiceFileOf(dd.dir)}.apply.lock`;
        // 終了済みの子プロセスの pid は生きていない
        const dead = spawnSync(process.execPath, ["-e", ""]).pid;
        writeFileSync(lock, String(dead));
        const old = new Date(Date.now() - 120_000);
        utimesSync(lock, old, old);
        const { result, fake } = await run(dd.dir, { lockWaitMs: 500 });
        eq("apply/5.3 60 秒超で持ち主（pid）のいないロックは引き継ぎ、適用を進めて解放する", [result.status, writesOf(fake).length, existsSync(lock)], ["applied", 1, false]);
      } finally { dd.cleanup(); }
    }
    {
      const dd = mkRepoWithRemote({ branch: "dev/foo" });
      try {
        choose(dd.dir);
        const lock = `${choiceFileOf(dd.dir)}.apply.lock`;
        // 古くても持ち主（生きている pid）がいるロックは奪わない
        writeFileSync(lock, String(process.pid));
        const old = new Date(Date.now() - 120_000);
        utimesSync(lock, old, old);
        const { result, fake } = await run(dd.dir, { lockWaitMs: 50 });
        eq("apply/5.3 古くても持ち主の生きているロックは奪わず conflict、書き込みはゼロ", [result.status, writesOf(fake).length, existsSync(lock)], ["conflict", 0, true]);
        rmSync(lock, { force: true });
      } finally { dd.cleanup(); }
    }
    {
      // 事前検査の途中で例外が出ても、ロックを解放して unknown を返す
      const dd = mkRepoWithRemote({ branch: "dev/foo" });
      try {
        choose(dd.dir);
        const lock = `${choiceFileOf(dd.dir)}.apply.lock`;
        let writes = 0;
        const session = {
          host: "github.com",
          checkAuth: async () => { throw new Error("想定外の失敗"); },
          listRulesets: async () => { throw new Error("想定外の失敗"); },
          createRuleset: async () => { writes++; return { ok: false }; },
        };
        const result = await applyRuleset(dd.dir, { session, target: T, refs: REFS, authKind: "classic" }, { lockWaitMs: 50 });
        eq("apply/5.3 途中で例外が出てもロックを解放し、unknown を返して書き込みはしない", [result.status, result.ok, existsSync(lock), writes], ["unknown", false, false, 0]);
      } finally { dd.cleanup(); }
    }

    // ---- 入力の検査 ----
    {
      const { result, fake } = await run(d, { input: { refs: [] } });
      eq("apply/5.3 分岐元が空の入力は invalidInput で、通信しない", [result.status, fake.requests.length], ["invalidInput", 0]);
    }
  } finally {
    r.cleanup();
  }
};
