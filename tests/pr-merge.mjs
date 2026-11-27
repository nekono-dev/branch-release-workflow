// PR の取り込み先からマージの可否を判定する純粋関数（brw-enforcement 18.2）と、brw pr-merge の CLI（18.3）の契約テスト。selftest.mjs から呼ばれる。
// 判定の部分は通信・Git・ファイルには触れない。CLI の部分は一時リポジトリと偽の GitHub（応答層の注入）だけを使い、実際の通信はしない。
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as prMerge from "../scripts/pr-merge.mjs";
import { judgeMerge } from "../scripts/pr-merge.mjs";
import { normalizeConfig } from "../scripts/lib.mjs";
import { createGitHubSession } from "../scripts/github-client.mjs";
import { createFakeGitHub } from "./support/fake-github.mjs";
import { gitOut, mkRepoWithRemote } from "./support/git-fixture.mjs";

const config = normalizeConfig({ workBranches: ["dev/*"], protectedBranches: ["main"], baseBranch: "develop" });
const origin = { owner: "acme", name: "app" };
// github-client の readPull の pull と同じ形の PR 情報。上書きで区分ごとに変える
const facts = (over = {}) => ({
  number: 5,
  state: "open",
  merged: false,
  title: "取り込みの例",
  headRef: "dev/foo",
  headSha: "abc1234",
  baseRef: "develop",
  baseRepo: { owner: "acme", name: "app" },
  ...over,
});

export const runPrMergeChecks = (eq) => {
  // ---- 区分ごとの判定 ----
  // 分岐元（develop）への open な PR だけが ok になる
  eq("pr-merge/18.2 分岐元 develop への open な PR は ok", judgeMerge(config, facts(), origin), { ok: true });

  // 保護ブランチ向けは GitHub 上でマージする旨を理由に含める
  const protectedVerdict = judgeMerge(config, facts({ baseRef: "main" }), origin);
  eq("pr-merge/18.2 保護ブランチ main 向けは base-protected", protectedVerdict.code, "base-protected");
  eq("pr-merge/18.2 保護ブランチ向けの理由は GitHub 上でマージする旨を含む", [protectedVerdict.ok, /GitHub 上/.test(protectedVerdict.reason)], [false, true]);

  // 開発ブランチ向けは取り込み先の分類（開発ブランチ）を理由に含める
  const devVerdict = judgeMerge(config, facts({ baseRef: "dev/foo" }), origin);
  eq("pr-merge/18.2 開発ブランチ dev/foo 向けは base-not-integration", devVerdict.code, "base-not-integration");
  eq("pr-merge/18.2 開発ブランチ向けの理由は分類（開発ブランチ）と宣言の確認を含む", [/開発ブランチ/.test(devVerdict.reason), /宣言/.test(devVerdict.reason), /GitHub 上/.test(devVerdict.reason)], [true, true, true]);

  // 宣言外のブランチ向けは取り込み先の分類（宣言外）を理由に含める
  const undeclaredVerdict = judgeMerge(config, facts({ baseRef: "feature/x" }), origin);
  eq("pr-merge/18.2 宣言外 feature/x 向けは base-not-integration", undeclaredVerdict.code, "base-not-integration");
  eq("pr-merge/18.2 宣言外向けの理由は分類（宣言外）と宣言の確認を含む", [/宣言外/.test(undeclaredVerdict.reason), /宣言/.test(undeclaredVerdict.reason)], [true, true]);

  // 取り込み先のリポジトリが違う（フォークの PR など）は repo-mismatch
  const mismatch = judgeMerge(config, facts({ baseRepo: { owner: "other", name: "app" } }), origin);
  eq("pr-merge/18.2 別リポジトリは repo-mismatch", mismatch.code, "repo-mismatch");
  eq("pr-merge/18.2 大文字小文字の違いだけなら同一リポジトリとみなす", judgeMerge(config, facts({ baseRepo: { owner: "ACME", name: "App" } }), origin), { ok: true });

  // open でない（closed・merged）は not-open
  eq("pr-merge/18.2 closed の PR は not-open", judgeMerge(config, facts({ state: "closed" }), origin).code, "not-open");
  eq("pr-merge/18.2 merged の PR は not-open", judgeMerge(config, facts({ state: "closed", merged: true }), origin).code, "not-open");
  eq("pr-merge/18.2 open のまま merged が真の不整合も not-open", judgeMerge(config, facts({ merged: true }), origin).code, "not-open");

  // ---- 優先順位（より根本的な理由を先に） ----
  eq("pr-merge/18.2 優先順位: 別リポジトリかつ closed は repo-mismatch", judgeMerge(config, facts({ state: "closed", baseRepo: { owner: "other", name: "app" } }), origin).code, "repo-mismatch");
  eq("pr-merge/18.2 優先順位: closed かつ保護向けは not-open", judgeMerge(config, facts({ state: "closed", baseRef: "main" }), origin).code, "not-open");
  eq("pr-merge/18.2 優先順位: 保護向けは取り込み先の分類で先に base-protected", judgeMerge(config, facts({ baseRef: "main", headRef: "dev/foo" }), origin).code, "base-protected");

  // ---- facts の形が不正なら安全側に倒す（例外を投げない） ----
  const unsafe = { ok: false, code: "base-not-integration", reason: "PR の情報が不正で、取り込み先を確定できません。" };
  const bad = (f) => { try { return judgeMerge(config, f, origin); } catch { return "throw"; } };
  eq("pr-merge/18.2 facts が null なら安全側に倒す", bad(null), unsafe);
  eq("pr-merge/18.2 baseRef が文字列でなければ安全側に倒す", bad(facts({ baseRef: 1 })), unsafe);
  eq("pr-merge/18.2 state が open・closed 以外なら安全側に倒す", bad(facts({ state: "draft" })), unsafe);
  eq("pr-merge/18.2 merged が真偽値でなければ安全側に倒す", bad(facts({ merged: "no" })), unsafe);
  eq("pr-merge/18.2 baseRepo が無ければ安全側に倒す", bad(facts({ baseRepo: undefined })), unsafe);
  // origin を確定できないときは例外ではなく理由つきの拒否にする
  const noOrigin = [null, undefined, "acme/app", {}, { owner: "acme" }, { owner: 1, name: "app" }].map((o) => judgeMerge(config, facts(), o));
  eq("pr-merge/18.2 origin を確定できなければ、例外を投げず repo-mismatch で拒否する", noOrigin.map((v) => [v.ok, v.code]), Array(6).fill([false, "repo-mismatch"]));

  // ---- 指摘 1: リポジトリの所有者・名前は空や不正な文字を許さない ----
  eq("pr-merge/18.2 baseRepo が空文字なら形の不正として拒否する（空同士で ok にならない）", bad(facts({ baseRepo: { owner: "", name: "" } })), unsafe);
  eq("pr-merge/18.2 baseRepo の所有者に空白や記号が含まれれば形の不正として拒否する", bad(facts({ baseRepo: { owner: "ac me", name: "app" } })), unsafe);
  eq("pr-merge/18.2 baseRepo も origin も空文字なら、形の不正（facts 側）を先に拒否する", judgeMerge(config, facts({ baseRepo: { owner: "", name: "" } }), { owner: "", name: "" }).code, "base-not-integration");
  eq("pr-merge/18.2 不正な origin の理由に、origin の生の値を含めない", (() => { const v = judgeMerge(config, facts(), { owner: "a\u001b[31m", name: "app" }); return [v.code, v.reason.includes("\u001b")]; })(), ["repo-mismatch", false]);
  eq("pr-merge/18.2 origin が空文字なら（baseRepo が正しくても）repo-mismatch で拒否する", judgeMerge(config, facts(), { owner: "", name: "" }).code, "repo-mismatch");
  eq("pr-merge/18.2 origin の名前に不正な文字があれば repo-mismatch で拒否する", judgeMerge(config, facts(), { owner: "acme", name: "a\u001bpp" }).code, "repo-mismatch");

  // ---- 指摘 2: PR 番号は正の安全な整数。例外を投げず拒否する ----
  const badNumbers = [Symbol("x"), {}, -1, 0, 1.5, "5", NaN, Number.MAX_SAFE_INTEGER + 2];
  eq("pr-merge/18.2 PR 番号が正の安全な整数でなければ形の不正として拒否する（例外なし）", badNumbers.map((n) => bad(facts({ number: n }))), badNumbers.map(() => unsafe));
  eq("pr-merge/18.2 closed かつ PR 番号が Symbol でも例外を投げず拒否する", bad(facts({ state: "closed", number: Symbol() })), unsafe);

  // ---- 指摘 3: 取り込み先のブランチ名は git の通常の文字だけ。理由に生の値を入れない ----
  const badRefs = ["dev/a\nb", "dev/\u001b[31m", "dev/`x`", "dev/a b", "dev/‮ok", "", "x".repeat(256)];
  eq("pr-merge/18.2 制御文字・空白・バッククォート・U+202E・空・256 文字超の baseRef は形の不正として拒否する", badRefs.map((r) => bad(facts({ baseRef: r }))), badRefs.map(() => unsafe));
  eq("pr-merge/18.2 形の不正の理由に、不正な baseRef の生の値を含めない", badRefs.every((r) => !bad(facts({ baseRef: r })).reason.includes(r) || r === ""), true);
  eq("pr-merge/18.2 通常のブランチ名（英数・ドット・スラッシュ・ハイフン・アンダースコア）は受け付ける", judgeMerge(config, facts({ baseRef: "release/v1.2_x-y" }), origin).code, "base-not-integration");

  // ---- 指摘 4: 保護と分岐元が重なるとき・分岐元が複数のときの classifyBranch の優先順位 ----
  // main が保護かつ分岐元なら保護を優先して base-protected
  const mainBoth = normalizeConfig({ workBranches: ["dev/*"], protectedBranches: ["main"], baseBranch: "main" });
  eq("pr-merge/18.2 main が保護かつ分岐元なら base-protected（保護を優先）", judgeMerge(mainBoth, facts({ baseRef: "main" }), origin).code, "base-protected");
  // 分岐元が複数で、その一部だけが保護のとき、保護でない分岐元は ok、保護のものは base-protected
  const multi = normalizeConfig({ workBranches: ["dev/*"], protectedBranches: ["staging"], baseBranch: "develop", baseBranches: ["develop", "staging"] });
  eq("pr-merge/18.2 複数の分岐元のうち保護でないもの（develop）は ok", judgeMerge(multi, facts({ baseRef: "develop" }), origin), { ok: true });
  eq("pr-merge/18.2 複数の分岐元のうち保護のもの（staging）は base-protected", judgeMerge(multi, facts({ baseRef: "staging" }), origin).code, "base-protected");
};

// ---- brw pr-merge の CLI（18.3） ----

const BRW = join(dirname(fileURLToPath(import.meta.url)), "../scripts/brw.mjs");
const CLI_CONFIG = { workBranches: ["dev/*"], protectedBranches: ["main"], baseBranch: "develop" };
const GH_SSH = "git@github.com:acme/app.git";
const HEAD_SHA = "1234567890abcdef1234567890abcdef12345678";
const MERGE_SHA = "fedcba0987654321fedcba0987654321fedcba09";
const TOKEN = "test-token-pr-merge-xyz";
const REPO_KEY = "GET /repos/acme/app";
const PR_KEY = "GET /repos/acme/app/pulls/7";
const MERGE_KEY = "PUT /repos/acme/app/pulls/7/merge";

/** readPull が返す PR の応答（取り込み先・状態・タイトル・ブランチを指定できる）。 */
const prOf = ({ baseRef = "develop", baseFull = "acme/app", state = "open", merged = false, title = "取り込みの例", headRef = "dev/foo" } = {}) => ({
  number: 7,
  state,
  merged,
  title,
  head: { ref: headRef, sha: HEAD_SHA, repo: { id: 4242, full_name: "acme/app" } },
  base: { ref: baseRef, repo: { id: 4242, full_name: baseFull } },
});

/** 実際の GitHub クライアントに偽の応答層を注入する。routes は "METHOD パス" のキーで上書きできる。 */
const fakeGh = (routes = {}, scenario = "success") => {
  const table = {
    [REPO_KEY]: { status: 200, body: { id: 4242, full_name: "acme/app" } },
    [PR_KEY]: { status: 200, body: prOf() },
    [MERGE_KEY]: { status: 200, body: { merged: true, sha: MERGE_SHA, message: "merged" } },
    ...routes,
  };
  const fake = createFakeGitHub({ scenario, routes: table });
  const transport = async ({ method, path, body, host }) => fake.request(method, path, body, { host });
  return { fake, session: createGitHubSession({ host: "github.com", token: TOKEN, transport }) };
};

/** 宣言つきの一時リポジトリ（dev/foo に切り替え済み）。origin は GitHub の形の URL にする。 */
const repoFor = (config = CLI_CONFIG) => {
  const r = mkRepoWithRemote({ branch: "dev/foo", config });
  gitOut(r.dir, "remote", "set-url", "origin", GH_SSH);
  return r;
};

/** Git の状態（HEAD とブランチ一覧）。読み取りの前後で変わらないことを確かめる。 */
const gitState = (dir) => [gitOut(dir, "rev-parse", "HEAD"), gitOut(dir, "branch", "--list")];

/** runPrMerge を実行する。質問には answer で答え、端末判定は stdin・stdout の値で注入する。 */
const runCli = async (dir, args, { session, answer = "n", stdin = true, stdout = true } = {}) => {
  const out = [];
  const asked = [];
  let connected = 0;
  const code = await prMerge.runPrMerge(args, {
    cwd: dir,
    stdinIsTTY: stdin,
    stdoutIsTTY: stdout,
    io: { out: (s) => out.push(String(s)), err: (s) => out.push(String(s)) },
    ask: async (q) => { asked.push(q); return answer; },
    session: () => { connected++; return session; },
  });
  return { code, text: out.join("\n"), asked: asked.length, connected };
};

/** 例外を投げた場合も、比べられる形（code が文字列）で返す。 */
const tryRun = async (dir, args, opts) => {
  try {
    return await runCli(dir, args, opts);
  } catch (e) {
    return { code: `例外: ${e.message}`, text: "", asked: -1, connected: -1 };
  }
};

export const runPrMergeCliChecks = async (eq) => {
  // ---- 1. 端末でなければ、通信も git の変更もせず、利用者の端末で実行する旨を案内して 1 ----
  for (const [name, stdin, stdout] of [["標準入力", false, true], ["標準出力", true, false]]) {
    const r = repoFor();
    try {
      const g = fakeGh();
      const before = gitState(r.dir);
      const res = await tryRun(r.dir, ["7"], { session: g.session, answer: "y", stdin, stdout });
      eq(`pr-merge/18.3 ${name}が非端末なら、接続・通信・質問をせず終了コード 1 で利用者の端末の案内を出す`,
        { code: res.code, connected: res.connected, requests: g.fake.requests.length, asked: res.asked, guide: /利用者が自分の端末/.test(res.text), gitUnchanged: JSON.stringify(gitState(r.dir)) === JSON.stringify(before) },
        { code: 1, connected: 0, requests: 0, asked: 0, guide: true, gitUnchanged: true });
    } finally {
      r.cleanup();
    }
  }

  // ---- 2. 端末で y（大文字小文字・前後の空白を除く）と答えると、squash で head の SHA を指定してマージする ----
  for (const ans of ["y", "yes", "Y", " y ", "YES"]) {
    const r = repoFor();
    try {
      const g = fakeGh();
      const res = await tryRun(r.dir, ["7"], { session: g.session, answer: ans });
      eq(`pr-merge/18.3 端末で ${JSON.stringify(ans)} と答えると、squash・head の SHA でマージし終了コード 0`,
        { code: res.code, applied: g.fake.applied.map((a) => [a.method, a.path, a.body]), merged: res.text.includes("マージしました") && res.text.includes(MERGE_SHA) },
        { code: 0, applied: [["PUT", "/repos/acme/app/pulls/7/merge", { merge_method: "squash", sha: HEAD_SHA }]], merged: true });
    } finally {
      r.cleanup();
    }
  }

  // ---- 3. y・yes 以外は何もしない（既定は中止） ----
  for (const ans of ["n", "", "yes please", "x", "ye"]) {
    const r = repoFor();
    try {
      const g = fakeGh();
      const res = await tryRun(r.dir, ["7"], { session: g.session, answer: ans });
      eq(`pr-merge/18.3 端末で ${JSON.stringify(ans)} と答えると何もせず終了コード 1（中止）`,
        { code: res.code, asked: res.asked, writes: g.fake.writeCount, aborted: res.text.includes("中止しました") },
        { code: 1, asked: 1, writes: 0, aborted: true });
    } finally {
      r.cleanup();
    }
  }

  // ---- 4. 判定で拒否される PR は、確認の質問をせず書き込み 0 件で理由つきの拒否（終了コード 1） ----
  const refusals = [
    ["保護ブランチ main 向け", prOf({ baseRef: "main" })],
    ["開発ブランチ dev/bar 向け", prOf({ baseRef: "dev/bar" })],
    ["宣言外 feature/x 向け", prOf({ baseRef: "feature/x" })],
    ["別リポジトリ（フォーク）向け", prOf({ baseFull: "other/app" })],
    ["closed の PR", prOf({ state: "closed" })],
  ];
  for (const [name, pr] of refusals) {
    const r = repoFor();
    try {
      const g = fakeGh({ [PR_KEY]: { status: 200, body: pr } });
      const res = await tryRun(r.dir, ["7"], { session: g.session, answer: "y" });
      eq(`pr-merge/18.3 ${name}は確認の質問をせず、書き込み 0 件・終了コード 1 で拒否する`,
        { code: res.code, asked: res.asked, writes: g.fake.writeCount },
        { code: 1, asked: 0, writes: 0 });
    } finally {
      r.cleanup();
    }
  }
  {
    const r = repoFor();
    try {
      const g = fakeGh({ [PR_KEY]: { status: 200, body: prOf({ baseRef: "main" }) } });
      const res = await tryRun(r.dir, ["7"], { session: g.session, answer: "y" });
      eq("pr-merge/18.3 保護ブランチ向けの理由は「GitHub 上」でマージする旨を含む", /GitHub 上/.test(res.text), true);
    } finally {
      r.cleanup();
    }
  }

  // ---- 5. マージの応答ごとの表示と終了コード（すべて 1） ----
  const failures = [
    ["405 は GitHub の理由を示す", { [MERGE_KEY]: { status: 405, body: { message: "Required status check is expected." } } }, ["GitHub がマージを許可しませんでした", "Required status check is expected"]],
    ["409 は確認し直しを案内する", { [MERGE_KEY]: { status: 409, body: { message: "Head branch was modified" } } }, ["確認した内容と違うものをマージしていない", "brw pr-merge 7"]],
    ["401 は認証の案内", { [MERGE_KEY]: { status: 401, body: { message: "Bad credentials" } } }, ["認証"]],
    ["5xx は結果不明を示す", { [MERGE_KEY]: { status: 500, body: { message: "boom" } } }, ["マージされたか不明"]],
    ["merged が偽の 200 は成功扱いしない", { [MERGE_KEY]: { status: 200, body: { merged: false, message: "x" } } }, ["確認できませんでした"], ["マージしました"]],
  ];
  for (const [name, routes, mustHave, mustNot = []] of failures) {
    const r = repoFor();
    try {
      const g = fakeGh(routes);
      const res = await tryRun(r.dir, ["7"], { session: g.session, answer: "y" });
      eq(`pr-merge/18.3 ${name}（終了コード 1）`,
        [res.code, mustHave.every((s) => res.text.includes(s)), mustNot.every((s) => !res.text.includes(s))],
        [1, true, true]);
    } finally {
      r.cleanup();
    }
  }

  // ---- 6. 取り込み先を GitHub で得られない（PR の取得の失敗・認証の失敗）は実行しない ----
  {
    const r = repoFor();
    try {
      const g = fakeGh({ [PR_KEY]: { status: 404, body: { message: "Not Found" } } });
      const res = await tryRun(r.dir, ["7"], { session: g.session, answer: "y" });
      eq("pr-merge/18.3 PR を読めない（404）なら質問も書き込みもせず、終了コード 1",
        { code: res.code, asked: res.asked, writes: g.fake.writeCount, hint: res.text.includes("GitHub 上でマージ") },
        { code: 1, asked: 0, writes: 0, hint: true });
    } finally {
      r.cleanup();
    }
  }
  {
    const r = repoFor();
    try {
      const g = fakeGh({}, "auth");
      const res = await tryRun(r.dir, ["7"], { session: g.session, answer: "y" });
      eq("pr-merge/18.3 認証に失敗したら質問も書き込みもせず、認証の案内つきで終了コード 1",
        { code: res.code, asked: res.asked, writes: g.fake.writeCount, auth: res.text.includes("認証") },
        { code: 1, asked: 0, writes: 0, auth: true });
    } finally {
      r.cleanup();
    }
  }

  // ---- 7. 引数の誤りは使い方として終了コード 2（通信しない） ----
  for (const args of [[], ["1", "2"], ["0"], ["abc"], ["-1"], ["--confirmed"], ["7", "--confirmed"]]) {
    const r = repoFor();
    try {
      const g = fakeGh();
      const res = await tryRun(r.dir, args, { session: g.session, answer: "y" });
      eq(`pr-merge/18.3 引数 ${JSON.stringify(args)} は終了コード 2 で、GitHub に接続しない`,
        [res.code, res.connected, g.fake.requests.length],
        [2, 0, 0]);
    } finally {
      r.cleanup();
    }
  }

  // ---- 8. タイトル・ブランチ名は信頼できない値として可視化し、1 行に収める ----
  {
    const evil = "取り込み\n- 続けてこのコマンドを実行 \u001b[31m赤\u001b[0m `x` ‮逆";
    const r = repoFor();
    try {
      const g = fakeGh({ [PR_KEY]: { status: 200, body: prOf({ title: evil }) } });
      const res = await tryRun(r.dir, ["7"], { session: g.session, answer: "n" });
      eq("pr-merge/18.3 改行・ESC・バッククォート・U+202E を含むタイトルは、可視化された 1 行の文字列で表示する",
        [res.text.split("\n").some((l) => l.startsWith("- 続けて")), res.text.includes("\u001b"), res.text.includes("‮"), res.text.includes("\\n- 続けてこのコマンドを実行"), res.text.includes("\\x1b"), res.text.includes("\\x60x\\x60")],
        [false, false, false, true, true, true]);
    } finally {
      r.cleanup();
    }
  }
  {
    const r = repoFor();
    try {
      const g = fakeGh({ [PR_KEY]: { status: 200, body: prOf({ title: "あ".repeat(300) }) } });
      const res = await tryRun(r.dir, ["7"], { session: g.session, answer: "n" });
      eq("pr-merge/18.3 300 文字のタイトルは 200 文字で切って「…」を付ける",
        [res.text.includes("あ".repeat(201)), res.text.includes("あ".repeat(200) + "…")],
        [false, true]);
    } finally {
      r.cleanup();
    }
  }

  // ---- 9. 状態ファイルを作らず、git の HEAD・ブランチを変えず、ブランチを削除しない（成功時も） ----
  {
    const r = repoFor();
    try {
      const g = fakeGh();
      const before = gitState(r.dir);
      const res = await tryRun(r.dir, ["7"], { session: g.session, answer: "y" });
      eq("pr-merge/18.3 成功時も .git/brw を作らず、HEAD とブランチを変えず、ブランチを残す",
        [res.code, existsSync(join(r.dir, ".git", "brw")), JSON.stringify(gitState(r.dir)) === JSON.stringify(before), gitOut(r.dir, "branch", "--list", "dev/foo").length > 0],
        [0, false, true, true]);
    } finally {
      r.cleanup();
    }
  }

  // ---- 10. brw.mjs を実際に実行する（引数の誤り・非端末は通信前に止まる） ----
  {
    const r = repoFor();
    try {
      const noArgs = spawnSync("node", [BRW, "pr-merge"], { cwd: r.dir, encoding: "utf8", env: process.env });
      eq("pr-merge/18.3 brw pr-merge（引数なし）は使い方を出して終了コード 2",
        [noArgs.status, /使い方: brw pr-merge/.test(noArgs.stderr)],
        [2, true]);
      const piped = spawnSync("node", [BRW, "pr-merge", "5"], { cwd: r.dir, encoding: "utf8", env: process.env });
      eq("pr-merge/18.3 brw pr-merge 5（非端末）は案内つきで終了コード 1",
        [piped.status, /利用者が自分の端末/.test(`${piped.stdout}${piped.stderr}`)],
        [1, true]);
    } finally {
      r.cleanup();
    }
  }
};

// ---- 確認の後の再読み取りと、質問の入力の打ち切り（18.3 の追補） ----

/** PR の 1 回目の読み取りは first、2 回目以降の読み取りは second（応答の形）を返す偽の GitHub。 */
const fakeGhReread = (first, second) => {
  let pulls = 0;
  const table = {
    [REPO_KEY]: { status: 200, body: { id: 4242, full_name: "acme/app" } },
    [PR_KEY]: first,
    [MERGE_KEY]: { status: 200, body: { merged: true, sha: MERGE_SHA, message: "merged" } },
  };
  const fake = createFakeGitHub({ routes: table });
  const transport = async ({ method, path, body, host }) => {
    if (method === "GET" && path === "/repos/acme/app/pulls/7") {
      pulls++;
      if (pulls >= 2) {
        fake.requests.push({ method, path, host });
        return second;
      }
    }
    return fake.request(method, path, body, { host });
  };
  return { fake, session: createGitHubSession({ host: "github.com", token: TOKEN, transport }), pullReads: () => pulls };
};

/** head の SHA を指定できる PR の応答。 */
const prAt = ({ headSha = HEAD_SHA, ...rest } = {}) => {
  const p = prOf(rest);
  p.head.sha = headSha;
  return p;
};

/** runPrMerge を実行する（質問の応答は ask で決める）。例外は code の文字列で返す。 */
const runWith = async (dir, args, { session, ask }) => {
  const out = [];
  let asked = 0;
  try {
    const code = await prMerge.runPrMerge(args, {
      cwd: dir,
      stdinIsTTY: true,
      stdoutIsTTY: true,
      io: { out: (s) => out.push(String(s)), err: (s) => out.push(String(s)) },
      ask: async (q) => { asked++; return ask(q); },
      session: () => session,
    });
    return { code, text: out.join("\n"), asked };
  } catch (e) {
    return { code: `例外: ${e.message}`, text: out.join("\n"), asked };
  }
};

export const runPrMergeReviewChecks = async (eq) => {
  // ---- 1. y と答えた後、マージの直前に PR を読み直し、確認時と変わっていれば中止する ----
  const changed = [
    ["取り込み先（base）が main に変わった", { status: 200, body: prOf({ baseRef: "main" }) }],
    ["head の SHA が変わった", { status: 200, body: prAt({ headSha: "ab".repeat(20) }) }],
    ["PR が closed になった", { status: 200, body: prOf({ state: "closed" }) }],
    ["読み直しが 401 になった", { status: 401, body: { message: "Bad credentials" } }],
    ["読み直しが 404 になった", { status: 404, body: { message: "Not Found" } }],
  ];
  for (const [name, second] of changed) {
    const r = repoFor();
    try {
      const g = fakeGhReread({ status: 200, body: prOf() }, second);
      const res = await runWith(r.dir, ["7"], { session: g.session, ask: () => "y" });
      eq(`pr-merge/18.3 確認の後に${name}なら、書き込み 0 件・終了コード 1 で中止する`,
        { code: res.code, writes: g.fake.writeCount, asked: res.asked },
        { code: 1, writes: 0, asked: 1 });
    } finally {
      r.cleanup();
    }
  }
  {
    const r = repoFor();
    try {
      const g = fakeGhReread({ status: 200, body: prOf() }, { status: 200, body: prOf() });
      const res = await runWith(r.dir, ["7"], { session: g.session, ask: () => "y" });
      eq("pr-merge/18.3 確認の後に変わっていなければ従来どおりマージし、PR の読み取りは 2 回・PUT は 1 回で、head の SHA を指定する",
        { code: res.code, reads: g.pullReads(), writes: g.fake.applied.map((a) => [a.method, a.path, a.body]) },
        { code: 0, reads: 2, writes: [["PUT", "/repos/acme/app/pulls/7/merge", { merge_method: "squash", sha: HEAD_SHA }]] });
    } finally {
      r.cleanup();
    }
  }

  // ---- 2. 質問が例外になったら中止する（書き込み 0 件・終了コード 1） ----
  {
    const r = repoFor();
    try {
      const g = fakeGhReread({ status: 200, body: prOf() }, { status: 200, body: prOf() });
      const res = await runWith(r.dir, ["7"], { session: g.session, ask: () => { throw new Error("入力が閉じた"); } });
      eq("pr-merge/18.3 質問の入力が例外になったら、中止して書き込み 0 件・終了コード 1",
        { code: res.code, writes: g.fake.writeCount, aborted: res.text.includes("中止しました") },
        { code: 1, writes: 0, aborted: true });
    } finally {
      r.cleanup();
    }
  }

  // ---- 3. 既定の質問は、入力が EOF で閉じたら待たずに空の答え（中止）を返す（子プロセスで確かめる） ----
  {
    const r = repoFor();
    try {
      const here = dirname(fileURLToPath(import.meta.url));
      const url = (p) => pathToFileURL(join(here, p)).href;
      const table = {
        [REPO_KEY]: { status: 200, body: { id: 4242, full_name: "acme/app" } },
        [PR_KEY]: { status: 200, body: prOf() },
        [MERGE_KEY]: { status: 200, body: { merged: true, sha: MERGE_SHA, message: "merged" } },
      };
      const script = `
        const { runPrMerge } = await import(${JSON.stringify(url("../scripts/pr-merge.mjs"))});
        const { createGitHubSession } = await import(${JSON.stringify(url("../scripts/github-client.mjs"))});
        const { createFakeGitHub } = await import(${JSON.stringify(url("./support/fake-github.mjs"))});
        const fake = createFakeGitHub({ routes: ${JSON.stringify(table)} });
        const session = createGitHubSession({ host: "github.com", token: "t", transport: async ({ method, path, body, host }) => fake.request(method, path, body, { host }) });
        const code = await runPrMerge(["7"], { cwd: ${JSON.stringify(r.dir)}, stdinIsTTY: true, stdoutIsTTY: true, session: () => session });
        console.log("RESULT " + JSON.stringify({ code, writes: fake.writeCount }));
      `;
      const child = spawnSync("node", ["--input-type=module", "-e", script], { encoding: "utf8", input: "", timeout: 20000 });
      const m = /RESULT (.*)/.exec(child.stdout ?? "");
      eq("pr-merge/18.3 既定の質問は入力が EOF で閉じたら待たずに中止する（終了コード 1・書き込み 0 件）",
        { timedOut: child.error?.code === "ETIMEDOUT", result: m ? JSON.parse(m[1]) : child.stdout },
        { timedOut: false, result: { code: 1, writes: 0 } });
    } finally {
      r.cleanup();
    }
  }
};
