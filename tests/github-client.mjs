// GitHub クライアントの土台（brw-enforcement 3.1）の契約テスト。偽の応答層だけを使い、実際の通信・認証はしない。
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitHubSession, ghEnv, ghTransport, parseGhInclude, pickHeaders } from "../scripts/github-client.mjs";
import { createFakeGitHub } from "./support/fake-github.mjs";

const TOKEN = "ghp_SECRETSECRETSECRET1234567890";
const T = { host: "github.com", owner: "acme", name: "app" };
const REPO = { "GET /repos/acme/app": { status: 200, body: { id: 42, full_name: "Acme/App" } } };
const PRS = { "POST /repos/acme/app/pulls": { status: 201, body: { number: 5 } } };
// 偽の応答層を通信層として差し込む
const viaFake = (fake) => async ({ method, path, body, host }) => fake.request(method, path, body, { host });

export const runGithubClientChecks = async (eq) => {
  // ---- 対象の照合 ----
  const f1 = createFakeGitHub({ routes: { ...REPO, ...PRS } });
  const s1 = createGitHubSession({ host: "github.com", token: TOKEN, transport: viaFake(f1) });
  const c1 = await s1.confirmTarget(T);
  eq("client/3.1 応答の名前（大文字小文字を除く）と ID で対象を確定し、呼び出し先のホストを検証できる", [c1.ok, c1.target, f1.requests.map((q) => `${q.host} ${q.method} ${q.path}`)], [true, { host: "github.com", owner: "acme", name: "app", repositoryId: 42 }, ["github.com GET /repos/acme/app"]]);
  const w1 = await s1.request({ ...T, repositoryId: 42 }, "POST", "/repos/acme/app/pulls", { title: "t", head: "dev/a", base: "main" });
  eq("client/3.1 照合済みの対象への PR 作成は送られ、結果に呼び出し先を持つ", [w1.ok, w1.status, w1.calledTo, f1.writeCount, f1.applied.length], [true, 201, { host: "github.com", method: "POST", path: "/repos/acme/app/pulls" }, 1, 1]);

  const f2 = createFakeGitHub({ routes: { ...REPO, ...PRS } });
  const s2 = createGitHubSession({ host: "github.com", token: TOKEN, transport: viaFake(f2) });
  const r2 = await s2.request(T, "POST", "/repos/acme/app/pulls", { title: "t" });
  eq("client/3.1 ID を照合する前の書き込みは通信せずに拒否する", [r2.ok, r2.kind, f2.requests.length], [false, "refused", 0]);
  const m2 = await s2.confirmTarget({ ...T, repositoryId: 99 });
  const r2b = await s2.request({ ...T, repositoryId: 99 }, "POST", "/repos/acme/app/pulls", { title: "t" });
  eq("client/3.1 保存済みの ID と応答の ID が違えば target-mismatch で、その後も書き込みに進まない", [m2.ok, m2.kind, r2b.kind, f2.writeCount], [false, "target-mismatch", "refused", 0]);

  const f3 = createFakeGitHub({ routes: { "GET /repos/acme/app": { status: 200, body: { id: 42, full_name: "other/renamed" } } } });
  const s3 = createGitHubSession({ host: "github.com", transport: viaFake(f3) });
  const m3 = await s3.confirmTarget(T);
  eq("client/3.1 応答の full_name が要求と違う（移管・改名・別リポジトリ）なら確定しない", [m3.ok, m3.kind], [false, "target-mismatch"]);
  const f3b = createFakeGitHub({ routes: { "GET /repos/acme/app": { status: 200, body: { full_name: "acme/app" } } } });
  const m3b = await createGitHubSession({ host: "github.com", transport: viaFake(f3b) }).confirmTarget(T);
  eq("client/3.1 応答にリポジトリ ID がなければ確定しない（不明な入力）", [m3b.ok, m3b.kind], [false, "unknown-input"]);

  // ---- ホストの固定 ----
  const f4 = createFakeGitHub({ routes: { ...REPO, ...PRS } });
  const s4 = createGitHubSession({ host: "github.com", token: TOKEN, transport: viaFake(f4) });
  const h1 = await s4.confirmTarget({ ...T, host: "ghe.example.com" });
  const h2 = await s4.request({ ...T, host: "ghe.example.com" }, "GET", "/repos/acme/app");
  eq("client/3.1 固定したホストと別のホストの対象は通信せずに拒否する", [h1.kind, h2.kind, f4.requests.length], ["target-mismatch", "target-mismatch", 0]);
  eq("client/3.1 api.github.com は github.com と同じホストとして扱う", (await s4.confirmTarget({ ...T, host: "API.GitHub.com" })).ok, true);
  eq("client/3.1 ホストの形が不正なら作成できない", (() => { try { createGitHubSession({ host: "evil.com/x?" }); return "作成できた"; } catch { return "例外"; } })(), "例外");
  eq("client/3.1 作成後はホストを変更できない", (() => { try { s4.host = "x"; } catch { /* 厳格モードの例外 */ } return s4.host; })(), "github.com");

  // ---- パス・対象の検査 ----
  const f5 = createFakeGitHub({ routes: { ...REPO, ...PRS, "GET /repos/acme/other": { status: 200, body: {} }, "GET /repos/acme/app/pulls?state=open": { status: 200, body: [] } } });
  const s5 = createGitHubSession({ host: "github.com", token: TOKEN, transport: viaFake(f5) });
  await s5.confirmTarget(T);
  const before = f5.requests.length;
  const bads = [
    await s5.request(T, "GET", "/repos/acme/other"),
    await s5.request(T, "GET", "/repos/acme/app/../other"),
    await s5.request(T, "GET", "/repos/acme/application"),
    await s5.request(T, "GET", "https://evil.example.com/repos/acme/app"),
    await s5.request(T, "GET", "/repos/acme/app/x y"),
    await s5.request(T, "GET", "/graphql"),
    await s5.request({ ...T, owner: "a/b" }, "GET", "/repos/a/b/app"),
    await s5.request(null, "GET", "/repos/acme/app"),
    await s5.request(T, "GET", "/repos/acme/app", { x: 1 }),
  ];
  eq("client/3.1 対象の外・相対パス・URL・空白・対象なしの要求は通信せずに拒否する", [bads.map((b) => b.ok), bads.map((b) => b.kind), f5.requests.length - before], [Array(9).fill(false), ["target-mismatch", "refused", "target-mismatch", "refused", "refused", "target-mismatch", "refused", "refused", "refused"], 0]);
  const q = await s5.request(T, "GET", "/repos/acme/app/pulls?state=open");
  eq("client/3.1 照合した対象の配下の読み取り（クエリ付き）は送る", [q.ok, q.status], [true, 200]);
  const wr = [
    await s5.request(T, "PUT", "/repos/acme/app/pulls/1/merge", { merge_method: "squash" }),
    await s5.request(T, "POST", "/repos/acme/app/pulls/1/merge", {}),
    await s5.request(T, "PATCH", "/repos/acme/app/git/refs/heads/main", { sha: "x" }),
    await s5.request(T, "DELETE", "/repos/acme/app/rulesets/1", {}),
    await s5.request(T, "POST", "/graphql", { query: "mutation{mergePullRequest}" }),
    await s5.request(T, "POST", "/repos/acme/app/pulls", undefined),
  ];
  eq("client/3.1 マージ・ref 更新・削除など公開していない書き込み経路と本文なしは通信せずに拒否する", [wr.map((x) => x.kind), f5.writeCount], [["refused", "refused", "refused", "refused", "target-mismatch", "refused"], 0]);
  const u = await s5.request(null, "GET", "/user");
  eq("client/3.1 対象なしで許すのは認証確認の GET /user だけ", [u.kind ?? "ok", f5.requests.at(-1).path], ["unknown-input", "/user"]);

  // ---- 結果の区別 ----
  const fa = createFakeGitHub({ scenario: "auth" });
  const sa = createGitHubSession({ host: "github.com", token: TOKEN, transport: viaFake(fa) });
  const ra = await sa.confirmTarget(T);
  const ca = await sa.checkAuth();
  eq("client/3.1 認証の失敗（401）は auth", [ra.kind, ra.status, ca.kind], ["auth", 401, "auth"]);
  const fp = createFakeGitHub({ scenario: "permission", routes: { ...REPO, ...PRS } });
  const sp = createGitHubSession({ host: "github.com", token: TOKEN, transport: viaFake(fp) });
  await sp.confirmTarget(T);
  const rp = await sp.request(T, "POST", "/repos/acme/app/pulls", { title: "t" });
  eq("client/3.1 権限不足（403）は permission で、書き込みは適用されない", [rp.kind, rp.status, fp.applied.length], ["permission", 403, 0]);
  const fn = createFakeGitHub({ routes: {} });
  const rn = await createGitHubSession({ host: "github.com", transport: viaFake(fn) }).confirmTarget(T);
  eq("client/3.1 対象や入力が受け付けられない（404）は unknown-input", [rn.kind, rn.status], ["unknown-input", 404]);
  const f5xx = createFakeGitHub({ routes: { "GET /repos/acme/app": { status: 502, body: { message: "Bad Gateway" } } } });
  eq("client/3.1 サーバーエラー（5xx）は server", (await createGitHubSession({ host: "github.com", transport: viaFake(f5xx) }).confirmTarget(T)).kind, "server");
  const fl = createFakeGitHub({ scenario: "lost", routes: { ...REPO, ...PRS } });
  const sl = createGitHubSession({ host: "github.com", token: TOKEN, transport: viaFake(fl) });
  await sl.confirmTarget(T);
  const rl = await sl.request(T, "POST", "/repos/acme/app/pulls", { title: "t" });
  eq("client/3.1 応答が届かない書き込みは network で、結果が不明（outcomeUnknown）と示す", [rl.kind, rl.outcomeUnknown, rl.code, fl.applied.length], ["network", true, "ECONNRESET", 1]);
  const rr = await createGitHubSession({ host: "github.com", transport: async () => { throw Object.assign(new Error("接続できない"), { code: "ENOTFOUND" }); } }).confirmTarget(T);
  eq("client/3.1 読み取りの通信エラーは network で outcomeUnknown を付けない", [rr.kind, rr.outcomeUnknown], ["network", false]);
  const rj = await createGitHubSession({ host: "github.com", transport: async () => ({ body: {} }) }).confirmTarget(T);
  eq("client/3.1 状態を持たない応答は server として扱う", rj.kind, "server");

  // ---- 資格情報を出さない ----
  const leak = createGitHubSession({ host: "github.com", token: TOKEN, transport: async () => { throw new Error(`failed with token ${TOKEN}`); } });
  const lr = await leak.confirmTarget(T);
  const lm = createGitHubSession({ host: "github.com", token: TOKEN, transport: async () => ({ status: 401, body: { message: `bad ${TOKEN}` } }) });
  const lr2 = await lm.checkAuth();
  const dump = JSON.stringify([c1, w1, ra, rp, rl, lr, lr2, f1.requests, fl.requests, Object.keys(s1)]) + String(s1) + JSON.stringify(s1);
  eq("client/3.1 資格情報は結果・エラー・記録・セッションの表示に含まれない", [dump.includes(TOKEN), dump.includes("SECRETSECRET"), lr.reason, lr2.reason], [false, false, "failed with token ***", "bad ***"]);

  {
  // ---- 書き込みの応答が不確かな場合・状態の分類・パスの検査（3.1 のレビューの申し送り） ----
  for (const st of [500, 502, 504]) {
    const fw = createFakeGitHub({ routes: { ...REPO, "POST /repos/acme/app/pulls": { status: st, body: { message: "gateway" } } } });
    const sw = createGitHubSession({ host: "github.com", token: TOKEN, transport: viaFake(fw) });
    await sw.confirmTarget(T);
    const rw5 = await sw.request(T, "POST", "/repos/acme/app/pulls", { title: "t" });
    eq(`client/3.2 書き込みの ${st} は server で、作成済みかもしれない（outcomeUnknown）と示す`, [rw5.kind, rw5.status, rw5.outcomeUnknown], ["server", st, true]);
  }
  const fr5 = createFakeGitHub({ routes: { "GET /repos/acme/app": { status: 502, body: {} } } });
  const rr5 = await createGitHubSession({ host: "github.com", transport: viaFake(fr5) }).confirmTarget(T);
  eq("client/3.2 読み取りの 5xx には outcomeUnknown を付けない", rr5.outcomeUnknown ?? false, false);
  const cls = {};
  for (const st of [429, 408, 301, 307, 400, 404, 409, 422]) {
    const fc = createFakeGitHub({ routes: { "GET /repos/acme/app": { status: st, body: {} } } });
    cls[st] = (await createGitHubSession({ host: "github.com", transport: viaFake(fc) }).confirmTarget(T)).kind;
  }
  eq("client/3.2 429・408 は入力の問題ではないので server、3xx（移動の可能性）は target-mismatch、400・404・409・422 は unknown-input", cls, { 429: "server", 408: "server", 301: "target-mismatch", 307: "target-mismatch", 400: "unknown-input", 404: "unknown-input", 409: "unknown-input", 422: "unknown-input" });
  const wst = {};
  for (const st of [429, 408, 301, 422]) {
    const fc = createFakeGitHub({ routes: { ...REPO, "POST /repos/acme/app/pulls": { status: st, body: {} } } });
    const sc = createGitHubSession({ host: "github.com", transport: viaFake(fc) });
    await sc.confirmTarget(T);
    const rc = await sc.request(T, "POST", "/repos/acme/app/pulls", { title: "t" });
    wst[st] = [rc.kind, rc.outcomeUnknown ?? false];
  }
  eq("client/3.2 書き込みの 408 は結果不明、429・3xx・422 は適用されていない扱い", wst, { 429: ["server", false], 408: ["server", true], 301: ["target-mismatch", false], 422: ["unknown-input", false] });
  const f6 = createFakeGitHub({ routes: { ...REPO } });
  const s6 = createGitHubSession({ host: "github.com", transport: viaFake(f6) });
  await s6.confirmTarget(T);
  const n6 = f6.requests.length;
  const odd = [
    await s6.request(T, "GET", "/repos/acme/app/pulls/%2e%2e"),
    await s6.request(T, "GET", "/repos/acme/app/%2f"),
    await s6.request(T, "GET", "/repos/acme/app/%2E%2E/other"),
    await s6.request(T, "GET", "/repos/acme/app/{owner}"),
    await s6.request(T, "GET", "/repos/acme/app/pulls?head={repo}"),
  ];
  eq("client/3.2 パスの % エンコードと {} の置換記号は通信せずに拒否する", [odd.map((x) => x.kind), f6.requests.length - n6], [Array(5).fill("refused"), 0]);

  // ---- PR の検索・取得・作成 ----
  const OID = "a".repeat(40);
  const OID2 = "b".repeat(40);
  const repoOf = (id, full) => ({ id, full_name: full });
  const mk = (o = {}) => ({
    number: 7, state: "open", html_url: "https://github.com/acme/app/pull/7",
    head: { ref: "dev/a", sha: OID, repo: repoOf(42, "Acme/App"), ...(o.head ?? {}) },
    base: { ref: "main", repo: repoOf(42, "acme/app"), ...(o.base ?? {}) },
    ...Object.fromEntries(Object.entries(o).filter(([k]) => !["head", "base"].includes(k))),
  });
  const EXP = { headRef: "dev/a", baseRef: "main", headOid: OID };
  const FIND = "GET /repos/acme/app/pulls?state=open&head=acme:dev/a&base=main&per_page=100";
  const mkSession = async (routes, scenario) => {
    const fake = createFakeGitHub({ scenario, routes: { ...REPO, ...routes } });
    const s = createGitHubSession({ host: "github.com", token: TOKEN, transport: viaFake(fake) });
    await s.confirmTarget(T);
    return { fake, s, n: fake.requests.length };
  };
  const sent = (c) => c.fake.requests.slice(c.n).map((q) => `${q.method} ${q.path}`);

  const e0 = await mkSession({ [FIND]: { status: 200, body: [] } });
  const fe0 = await e0.s.findOpenPull(T, EXP);
  eq("client/3.2 一致するオープン PR がなければ pull: null で成功し、同じ head・base の絞り込みで読み取りだけを送る", [fe0.ok, fe0.pull, sent(e0), e0.fake.writeCount], [true, null, [FIND.replace("GET ", "GET ")], 0]);
  const e1 = await mkSession({ [FIND]: { status: 200, body: [mk()] } });
  const fe1 = await e1.s.findOpenPull(T, EXP);
  eq("client/3.2 head・base のリポジトリと ref・OID・URL が一致するオープン PR を返す", [fe1.ok, fe1.pull], [true, { number: 7, url: "https://github.com/acme/app/pull/7", state: "open", headOid: OID, headRef: "dev/a", baseRef: "main" }]);
  const variants = {
    "OID が違う": mk({ head: { sha: OID2 } }),
    "head の ref が違う": mk({ head: { ref: "dev/other" } }),
    "head が別リポジトリ（フォーク）": mk({ head: { repo: repoOf(99, "evil/app") } }),
    "head のリポジトリが消えている": mk({ head: { repo: null } }),
    "base の ref が違う": mk({ base: { ref: "release" } }),
    "base のリポジトリ ID が違う": mk({ base: { repo: repoOf(43, "acme/app") } }),
    "状態が open ではない": mk({ state: "closed" }),
    "URL のホストが違う": mk({ html_url: "https://evil.example.com/acme/app/pull/7" }),
    "URL のリポジトリが違う": mk({ html_url: "https://github.com/acme/other/pull/7" }),
    "URL の番号が違う": mk({ html_url: "https://github.com/acme/app/pull/8" }),
    "番号がない": mk({ number: undefined }),
  };
  const outs = {};
  for (const [label, pr] of Object.entries(variants)) {
    const c = await mkSession({ [FIND]: { status: 200, body: [pr] } });
    const r = await c.s.findOpenPull(T, EXP);
    outs[label] = [r.ok, r.kind, Array.isArray(r.differences) && r.differences.length > 0];
  }
  eq("client/3.2 一致しない PR は成功扱いせず target-mismatch と差異を返す", outs, Object.fromEntries(Object.keys(variants).map((k) => [k, [false, "target-mismatch", true]])));
  const e2 = await mkSession({ [FIND]: { status: 200, body: [mk(), mk({ number: 8, html_url: "https://github.com/acme/app/pull/8" })] } });
  const fe2 = await e2.s.findOpenPull(T, EXP);
  eq("client/3.2 一致する PR が複数あれば一意に確定できず成功扱いしない", [fe2.ok, fe2.kind, fe2.ambiguous], [false, "target-mismatch", true]);
  const e3 = await mkSession({ [FIND]: { status: 200, body: { message: "x" } } });
  eq("client/3.2 検索の応答が一覧でなければ unknown-input", (await e3.s.findOpenPull(T, EXP)).kind, "unknown-input");
  const e4 = await mkSession({ [FIND]: { status: 403, body: { message: "no" } } });
  const fe4 = await e4.s.findOpenPull(T, EXP);
  eq("client/3.2 検索の権限不足は permission のまま返す", [fe4.ok, fe4.kind], [false, "permission"]);
  const e5 = createFakeGitHub({ routes: { [FIND]: { status: 200, body: [] } } });
  const s5b = createGitHubSession({ host: "github.com", transport: viaFake(e5) });
  const g0 = await s5b.findOpenPull(T, EXP);
  const e6 = await mkSession({ [FIND]: { status: 200, body: [] } });
  const bad6 = [
    await e6.s.findOpenPull(T, { ...EXP, headRef: "a b" }),
    await e6.s.findOpenPull(T, { ...EXP, baseRef: "../x" }),
    await e6.s.findOpenPull(T, { ...EXP, baseRef: "a&state=all" }),
    await e6.s.findOpenPull(T, { ...EXP, headOid: "xyz" }),
    await e6.s.findOpenPull(T, { baseRef: "main", headRef: "dev/a" }),
    await e6.s.findOpenPull(T, { ...EXP, headRepository: { owner: "a/b", name: "x" } }),
    await e6.s.findOpenPull(null, EXP),
  ];
  eq("client/3.2 照合前の対象・不正な ref や OID は通信せずに拒否する", [g0.kind, e5.requests.length, bad6.map((x) => x.kind), sent(e6)], ["refused", 0, Array(7).fill("refused"), []]);

  const GET7 = "GET /repos/acme/app/pulls/7";
  const g1 = await mkSession({ [GET7]: { status: 200, body: mk() } });
  const gr1 = await g1.s.getPull(T, 7, EXP);
  eq("client/3.2 PR の取得は番号・head・base・OID・URL を検証して返す", [gr1.ok, gr1.pull.number, gr1.pull.url, sent(g1)], [true, 7, "https://github.com/acme/app/pull/7", [GET7]]);
  const g2 = await mkSession({ [GET7]: { status: 200, body: mk({ number: 8, html_url: "https://github.com/acme/app/pull/8" }) } });
  const g3 = await mkSession({ [GET7]: { status: 200, body: mk({ head: { sha: OID2 } }) } });
  const g4 = await mkSession({ [GET7]: { status: 404, body: {} } });
  const g5 = await mkSession({});
  const gb = [await g2.s.getPull(T, 7, EXP), await g3.s.getPull(T, 7, EXP), await g4.s.getPull(T, 7, EXP), await g5.s.getPull(T, 0, EXP), await g5.s.getPull(T, "7/merge", EXP)];
  eq("client/3.2 取得した PR の番号や OID が違えば成功扱いせず、404 は unknown-input、不正な番号は通信しない", [gb.map((x) => x.ok), gb.map((x) => x.kind), sent(g5)], [Array(5).fill(false), ["target-mismatch", "target-mismatch", "unknown-input", "refused", "refused"], []]);

  const INPUT = { title: "変更の公開", body: "説明", headRef: "dev/a", baseRef: "main", headOid: OID };
  const POST = "POST /repos/acme/app/pulls";
  const c1 = await mkSession({ [POST]: { status: 201, body: mk() } });
  const cr1 = await c1.s.createPull(T, INPUT);
  eq("client/3.2 確定済みの対象へ head・base・タイトルだけを送って PR を作成し、応答を検証して返す", [cr1.ok, cr1.created, cr1.pull?.url, c1.fake.applied.map((a) => a.body), sent(c1)], [true, true, "https://github.com/acme/app/pull/7", [{ title: "変更の公開", body: "説明", head: "dev/a", base: "main" }], [POST]]);
  const cs = createFakeGitHub({ routes: { ...REPO, [POST]: { status: 201, body: mk() } } });
  const ss = createGitHubSession({ host: "github.com", transport: viaFake(cs) });
  const cr0 = await ss.createPull(T, INPUT);
  const cx = await mkSession({ [POST]: { status: 201, body: mk() } });
  const crb = [
    await cx.s.createPull(T, { ...INPUT, title: "" }),
    await cx.s.createPull(T, { ...INPUT, headRef: "x y" }),
    await cx.s.createPull(T, { ...INPUT, headOid: "short" }),
    await cx.s.createPull(T, { ...INPUT, headRepository: { owner: "evil", name: "app" } }),
    await cx.s.createPull({ ...T, repositoryId: 99 }, INPUT),
  ];
  eq("client/3.2 照合前の対象・別リポジトリの head・不正な入力・ID の食い違いは通信せずに拒否する", [cr0.kind, cs.requests.length, crb.map((x) => x.kind), sent(cx), cx.fake.writeCount], ["refused", 0, ["refused", "refused", "refused", "refused", "target-mismatch"], [], 0]);
  const cm = await mkSession({ [POST]: { status: 201, body: mk({ head: { sha: OID2 } }) } });
  const crm = await cm.s.createPull(T, INPUT);
  eq("client/3.2 作成後に食い違いが分かれば作成済みの URL と差異を返し、成功扱いにしない", [crm.ok, crm.kind, crm.created, crm.createdUrl, crm.differences.length > 0, crm.reconcile ?? false], [false, "target-mismatch", true, "https://github.com/acme/app/pull/7", true, false]);
  const cj = await mkSession({ [POST]: { status: 201, body: "<html>" } });
  const crj = await cj.s.createPull(T, INPUT);
  eq("client/3.2 作成の応答が読めなければ結果不明として再取得での照合を求める", [crj.ok, crj.outcomeUnknown, crj.reconcile], [false, true, true]);
  const cc = {};
  for (const st of [409, 422, 502, 504, 408, 403, 401, 429]) {
    const c = await mkSession({ [POST]: { status: st, body: { message: "x" } } });
    const r = await c.s.createPull(T, INPUT);
    cc[st] = [r.ok, r.kind, r.reconcile ?? false];
  }
  eq("client/3.2 競合（409・422）と結果不明（5xx・408）は再取得で照合する印を付け、権限・認証・429 は付けない", cc, { 409: [false, "unknown-input", true], 422: [false, "unknown-input", true], 502: [false, "server", true], 504: [false, "server", true], 408: [false, "server", true], 403: [false, "permission", false], 401: [false, "auth", false], 429: [false, "server", false] });
  const cl = await mkSession({ [POST]: { status: 201, body: mk() } }, "lost");
  const crl = await cl.s.createPull(T, INPUT);
  eq("client/3.2 応答が届かなかった作成は network・結果不明で、再取得での照合を求める", [crl.ok, crl.kind, crl.outcomeUnknown, crl.reconcile, cl.fake.applied.length], [false, "network", true, true, 1]);
  const names = Object.keys(c1.s).concat(Object.getOwnPropertyNames(c1.s));
  const mergeLike = [await c1.s.request(T, "PUT", "/repos/acme/app/pulls/7/merge", { merge_method: "squash" }), await c1.s.request(T, "PATCH", "/repos/acme/app/pulls/7", { state: "closed" }), await c1.s.request(T, "POST", "/repos/acme/app/pulls/7/requested_reviewers", {}), await c1.s.request(T, "POST", "/repos/acme/app/pulls/7/merge", {})];
  const uniq = [...new Set(names)];
  eq("client/18.1 公開関数のうち merge を含むのは mergePull だけで、公開の request はマージ・自動マージ・PR の更新や終了を拒否する", [uniq.filter((k) => /merge/i.test(k)), uniq.filter((k) => /delete|close|update|patch|ref/i.test(k)), mergeLike.map((x) => x.kind), c1.fake.writeCount], [["mergePull"], [], Array(4).fill("refused"), 1]);
  const dumpPr = JSON.stringify([fe1, gr1, cr1, crm, crj, crl, c1.fake.requests]);
  eq("client/3.2 PR の結果と記録に資格情報は含まれない", dumpPr.includes("SECRETSECRET"), false);

  // ---- PR の読み取りと限定したマージ（18.1） ----
  const PATH7 = "/repos/acme/app/pulls/7";
  const GET7b = `GET ${PATH7}`;
  const MERGE7 = `PUT ${PATH7}/merge`;
  const SHA = "c".repeat(40);
  // 応答の PR 本体。top は PR 直下、head・base は各々の項目を上書きする
  const pb = (top = {}, head = {}, base = {}) => ({
    number: 7, state: "open", merged: false, title: "変更の公開",
    head: { ref: "dev/a", sha: OID, repo: repoOf(42, "acme/app"), ...head },
    base: { ref: "main", repo: repoOf(42, "acme/app"), ...base },
    ...top,
  });
  const rp1 = await mkSession({ [GET7b]: { status: 200, body: pb() } });
  const rr1 = await rp1.s.readPull(T, 7);
  eq("client/18.1 readPull は期待を渡さずに状態・取り込み先・head の SHA・タイトルを読み、取り込み先のリポジトリを返す", [rr1.ok, rr1.pull, sent(rp1), rp1.fake.writeCount], [true, { number: 7, state: "open", merged: false, title: "変更の公開", headRef: "dev/a", headSha: OID, baseRef: "main", baseRepo: { owner: "acme", name: "app" } }, [GET7b], 0]);
  const rp2 = await mkSession({ [GET7b]: { status: 200, body: pb({ merged: true, state: "closed" }, {}, { repo: repoOf(99, "other/fork") }) } });
  const rr2 = await rp2.s.readPull(T, 7);
  eq("client/18.1 readPull は取り込み先が対象と違っても事実をそのまま返す（判定は pr-merge）", [rr2.ok, rr2.pull?.baseRepo, rr2.pull?.merged, rr2.pull?.state], [true, { owner: "other", name: "fork" }, true, "closed"]);
  const rbad = [
    await mkSession({ [GET7b]: { status: 200, body: "<html>" } }),
    await mkSession({ [GET7b]: { status: 200, body: pb({ number: "7" }) } }),
    await mkSession({ [GET7b]: { status: 200, body: pb({ number: 8, html_url: "https://github.com/acme/app/pull/8" }) } }),
    await mkSession({ [GET7b]: { status: 200, body: pb({ state: "draft" }) } }),
    await mkSession({ [GET7b]: { status: 200, body: pb({ merged: undefined }) } }),
    await mkSession({ [GET7b]: { status: 200, body: pb({ title: undefined }) } }),
    await mkSession({ [GET7b]: { status: 200, body: pb({}, { sha: "xyz" }) } }),
    await mkSession({ [GET7b]: { status: 200, body: pb({}, { ref: undefined }) } }),
    await mkSession({ [GET7b]: { status: 200, body: pb({}, {}, { ref: 5 }) } }),
    await mkSession({ [GET7b]: { status: 200, body: pb({}, {}, { repo: undefined }) } }),
  ];
  const rbadOut = [];
  for (const c of rbad) rbadOut.push((await c.s.readPull(T, 7)).kind);
  eq("client/18.1 readPull は応答の形が不正なら unknown-input、番号が違えば target-mismatch で、成功扱いにしない", rbadOut, ["unknown-input", "unknown-input", "target-mismatch", "unknown-input", "unknown-input", "unknown-input", "unknown-input", "unknown-input", "unknown-input", "unknown-input"]);
  const rq = await mkSession({ [GET7b]: { status: 200, body: pb() } });
  const unconfirmed = createGitHubSession({ host: "github.com", transport: viaFake(rq.fake) });
  const rref = [
    await unconfirmed.readPull(T, 7),
    await rq.s.readPull(T, 0),
    await rq.s.readPull(T, "7/merge"),
    await rq.s.readPull({ ...T, host: "ghe.example.com" }, 7),
  ];
  eq("client/18.1 readPull は照合前の対象・不正な番号・別ホストを通信せずに拒否する", [rref.map((x) => x.kind), sent(rq)], [["refused", "refused", "refused", "target-mismatch"], []]);
  eq("client/18.1 readPull の結果に資格情報は含まれない", JSON.stringify([rr1, rr2]).includes("SECRETSECRET"), false);

  const m1 = await mkSession({ [MERGE7]: { status: 200, body: { merged: true, sha: SHA, message: "Pull Request successfully merged" } } });
  const mr1 = await m1.s.mergePull(T, { number: 7, sha: OID });
  eq("client/18.1 mergePull は PUT …/merge だけを送り、本文は squash と sha に固定する", [mr1.ok, mr1.status, mr1.merged, mr1.sha, mr1.message, mr1.calledTo, m1.fake.applied.map((a) => a.body), sent(m1)], [true, 200, true, SHA, "Pull Request successfully merged", { host: "github.com", method: "PUT", path: "/repos/acme/app/pulls/7/merge" }, [{ merge_method: "squash", sha: OID }], [MERGE7]]);
  // 余分なキーは送る前に拒否する（merge_method の値・継承・プロトタイプ汚染の形を含む）
  const inherited = Object.assign(Object.create({ merge_method: "merge" }), { number: 7, sha: OID });
  const extraKeys = [
    { number: 7, sha: OID, merge_method: "merge" },
    { number: 7, sha: OID, merge_method: "rebase" },
    { number: 7, sha: OID, merge_method: "squash" },
    { number: 7, sha: OID, commit_title: "x" },
    { number: 7, sha: OID, commit_message: "x" },
    JSON.parse(`{"__proto__": {"merge_method": "merge"}, "number": 7, "sha": "${OID}"}`),
    inherited,
  ];
  const mx = await mkSession({ [MERGE7]: { status: 200, body: { merged: true, sha: SHA } } });
  const mxKinds = [];
  for (const x of extraKeys) mxKinds.push((await mx.s.mergePull(T, x)).kind);
  eq("client/18.1 mergePull は number と sha 以外のキー（継承・__proto__ を含む）を渡すと送る前に refused で、書き込みは増えない", [mxKinds, mx.fake.writeCount, mx.fake.applied.length, sent(mx)], [Array(extraKeys.length).fill("refused"), 0, 0, []]);
  const pubMerge = await m1.s.request(T, "PUT", `${PATH7}/merge`, { merge_method: "squash", sha: OID });
  eq("client/18.1 公開の request は sha を付けても PUT …/merge を拒否し、通信しない", [pubMerge.kind, m1.fake.writeCount], ["refused", 1]);

  const mz = async (route) => {
    const c = await mkSession({ [MERGE7]: route });
    const r = await c.s.mergePull(T, { number: 7, sha: OID });
    return r;
  };
  const m405 = await mz({ status: 405, body: { message: "Pull Request is not mergeable" } });
  eq("client/18.1 mergePull の 405 はマージできない（not-mergeable）として理由を保つ", [m405.ok, m405.kind, m405.status, m405.reason, m405.outcomeUnknown ?? false], [false, "not-mergeable", 405, "Pull Request is not mergeable", false]);
  const m409 = await mz({ status: 409, body: { message: "Head branch was modified." } });
  eq("client/18.1 mergePull の 409 は head の SHA の食い違いとして理由を保ち、結果不明とはしない", [m409.ok, m409.kind, m409.status, m409.reason, m409.outcomeUnknown ?? false], [false, "unknown-input", 409, "Head branch was modified.", false]);
  const m401 = await mz({ status: 401, body: { message: "Bad credentials" } });
  eq("client/18.1 mergePull の認証の失敗（401）は auth", [m401.ok, m401.kind, m401.status], [false, "auth", 401]);
  const m502 = await mz({ status: 502, body: { message: "Bad Gateway" } });
  eq("client/18.1 mergePull の 5xx は server で、マージ済みかもしれない（outcomeUnknown）と示す", [m502.kind, m502.outcomeUnknown], ["server", true]);
  const ml = createFakeGitHub({ scenario: "lost", routes: { ...REPO, [MERGE7]: { status: 200, body: { merged: true, sha: SHA } } } });
  const sl2 = createGitHubSession({ host: "github.com", token: TOKEN, transport: viaFake(ml) });
  await sl2.confirmTarget(T);
  const mlost = await sl2.mergePull(T, { number: 7, sha: OID });
  eq("client/18.1 mergePull の応答喪失は network で結果不明（outcomeUnknown）と示し、成功扱いにしない", [mlost.ok, mlost.kind, mlost.outcomeUnknown, ml.applied.length], [false, "network", true, 1]);

  const mbad = [
    { label: "sha が無い", t: T, n: 7, s: undefined },
    { label: "sha が短い", t: T, n: 7, s: "abc" },
    { label: "sha が 16 進でない", t: T, n: 7, s: "z".repeat(40) },
    { label: "sha が文字列でない", t: T, n: 7, s: 123 },
    { label: "番号が 0", t: T, n: 0, s: OID },
    { label: "番号が文字列", t: T, n: "7", s: OID },
    { label: "番号に merge を含む", t: T, n: "7/merge", s: OID },
    { label: "対象が未照合", t: { ...T, name: "other" }, n: 7, s: OID },
    { label: "別ホスト", t: { ...T, host: "ghe.example.com" }, n: 7, s: OID },
    { label: "ID が照合済みと違う", t: { ...T, repositoryId: 99 }, n: 7, s: OID },
  ];
  const mbadOut = {};
  for (const x of mbad) {
    const c = await mkSession({ [MERGE7]: { status: 200, body: { merged: true, sha: SHA } } });
    const r = x.t.name === "other" ? await createGitHubSession({ host: "github.com", transport: viaFake(c.fake) }).mergePull(x.t, { number: x.n, sha: x.s }) : await c.s.mergePull(x.t, { number: x.n, sha: x.s });
    mbadOut[x.label] = [r.ok, r.kind, c.fake.writeCount];
  }
  const shaNull = await (await mkSession({})).s.mergePull(T, null);
  eq("client/18.1 mergePull は sha が無い・不正・番号が不正・対象が未照合・別ホスト・ID の食い違いを送る前に拒否し、書き込みを増やさない", mbadOut, Object.fromEntries(mbad.map((x) => [x.label, [false, x.label === "別ホスト" || x.label === "ID が照合済みと違う" ? "target-mismatch" : "refused", 0]])));
  eq("client/18.1 mergePull は引数が null でも通信せずに拒否する", [shaNull.ok, shaNull.kind], [false, "refused"]);
  const dumpMerge = JSON.stringify([rr1, rr2, mr1, m405, m409, mlost]);
  eq("client/18.1 readPull・mergePull の結果に資格情報は含まれない", dumpMerge.includes("SECRETSECRET"), false);

  }

  // ---- gh への受け渡し ----
  const base = { PATH: "/bin", GH_TOKEN: "other", GITHUB_TOKEN: "other", GH_ENTERPRISE_TOKEN: "other", GH_REPO: "x/y", GH_HOST: "evil.example.com", HOME: "/h" };
  const e1 = ghEnv("github.com", TOKEN, base);
  const e2 = ghEnv("ghe.example.com", TOKEN, base);
  const e3 = ghEnv("github.com", undefined, base);
  eq("client/3.1 gh の環境はホストと資格情報を固定し、手元の GH_TOKEN・GH_REPO・GH_HOST を引き継がない", [
    [e1.GH_HOST, e1.GH_TOKEN, e1.GITHUB_TOKEN, e1.GH_ENTERPRISE_TOKEN, e1.GH_REPO, e1.HOME],
    [e2.GH_HOST, e2.GH_ENTERPRISE_TOKEN, e2.GH_TOKEN],
    [e3.GH_HOST, e3.GH_TOKEN, e3.GITHUB_TOKEN],
  ], [["github.com", TOKEN, undefined, undefined, undefined, "/h"], ["ghe.example.com", TOKEN, undefined], ["github.com", undefined, undefined]]);
  eq("client/3.1 応答ヘッダーは許可リスト（x-oauth-scopes）だけを残す", pickHeaders("HTTP/2.0 200 OK\r\nX-OAuth-Scopes: repo, workflow\r\nSet-Cookie: a=b\r\n\r\n{}"), { "x-oauth-scopes": "repo, workflow" });
  const scopesFake = createGitHubSession({ host: "github.com", token: TOKEN, transport: viaFake(createFakeGitHub({ routes: { "GET /user": { status: 200, body: { login: "u" }, headers: { "x-oauth-scopes": "public_repo" } } } })) });
  const sc = await scopesFake.checkAuth();
  eq("client/3.1 認証確認はスコープのヘッダーを載せ、ヘッダーがなければ null にする", [sc.scopes, JSON.stringify(sc).includes(TOKEN)], [["public_repo"], false]);
  eq("client/3.1 gh api の出力から状態と本文を取り出す", [
    parseGhInclude('HTTP/2.0 201 Created\r\nContent-Type: application/json\r\n\r\n{"number":3}\n'),
    parseGhInclude("HTTP/2.0 204 No Content\r\nX: y\r\n\r\n"),
    parseGhInclude("gh: not logged in"),
  ], [{ status: 201, body: { number: 3 } }, { status: 204, body: undefined }, null]);

  // 偽の gh 実行ファイルで、引数にトークンを含めず環境変数で渡すこと、本文を標準入力で渡すことを確かめる
  const dir = mkdtempSync(join(tmpdir(), "brw-gh-"));
  try {
    const log = join(dir, "log.json");
    const fakeGh = join(dir, "gh");
    writeFileSync(fakeGh, `#!/usr/bin/env node
const fs = require("node:fs");
let input = "";
process.stdin.on("data", (d) => { input += d; });
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), host: process.env.GH_HOST, token: process.env.GH_TOKEN, other: process.env.GITHUB_TOKEN, input }));
  if (process.argv.includes("/repos/acme/app/pulls")) { process.stdout.write('HTTP/2.0 403 Forbidden\\r\\n\\r\\n{"message":"Resource not accessible"}'); process.exit(1); }
  process.stdout.write('HTTP/2.0 200 OK\\r\\n\\r\\n{"id":42,"full_name":"acme/app"}');
});
`);
    chmodSync(fakeGh, 0o755);
    const real = createGitHubSession({ host: "github.com", token: TOKEN, transport: ghTransport({ ghPath: fakeGh, baseEnv: { PATH: process.env.PATH, GITHUB_TOKEN: "ambient" } }) });
    const rc = await real.confirmTarget(T);
    const seen = JSON.parse(readFileSync(log, "utf8"));
    eq("client/3.1 gh api には資格情報を引数でなく環境変数で渡し、手元の別トークンは渡さない", [rc.ok, rc.target.repositoryId, seen.args.join(" ").includes(TOKEN), seen.host, seen.token === TOKEN, seen.other], [true, 42, false, "github.com", true, undefined]);
    const rw = await real.request(T, "POST", "/repos/acme/app/pulls", { title: "t" });
    const seenW = JSON.parse(readFileSync(log, "utf8"));
    eq("client/3.1 gh の非 2xx 応答も状態から区別し、本文は標準入力で渡す", [rw.kind, rw.status, JSON.parse(seenW.input).title], ["permission", 403, "t"]);
    const none = createGitHubSession({ host: "github.com", token: TOKEN, transport: ghTransport({ ghPath: join(dir, "missing") }) });
    const rm = await none.checkAuth();
    eq("client/3.1 gh を実行できない場合は network として返す", [rm.kind, JSON.stringify(rm).includes(TOKEN)], ["network", false]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
