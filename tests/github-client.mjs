// GitHub クライアントの土台（brw-enforcement 3.1）の契約テスト。偽の応答層だけを使い、実際の通信・認証はしない。
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitHubSession, ghEnv, ghTransport, parseGhInclude } from "../scripts/github-client.mjs";
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
