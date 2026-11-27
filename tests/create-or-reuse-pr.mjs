// PR の再利用・作成を作業の記録なしで行う createOrReusePr の単体試験（brw-pr-handoff 7.1）。selftest.mjs から呼ばれる。
// 偽の GitHub 応答（fake-github.mjs）を createGitHubSession の transport に注入し、実際のクライアントの照合を通す。
// 作業の記録・状態ファイル・push は使わない（関数が記録に依存しないことを、直接呼び出しで確かめる）。
import { createGitHubSession } from "../scripts/github-client.mjs";
import { createFakeGitHub } from "./support/fake-github.mjs";

const TARGET = { id: 4242, owner: "acme", name: "app" };
const HOST = "github.com";
const TOKEN = "test-token-xyz";
const HEAD_OID = "a".repeat(40);
const REPO_KEY = "GET /repos/acme/app";
// 取り込み元の一覧（既存 PR の探索）と、取り込み元・取り込み先で絞った照合（findOpenPull）の経路
const LIST = "GET /repos/acme/app/pulls?state=open&head=acme:dev/foo&per_page=100";
const FILTERED = "GET /repos/acme/app/pulls?state=open&head=acme:dev/foo&base=main&per_page=100";
const POST = "POST /repos/acme/app/pulls";

// 応答の PR（head の OID・取り込み先は指定できる）
const PR = (over = {}) => ({
  number: 7,
  html_url: "https://github.com/acme/app/pull/7",
  state: "open",
  draft: false,
  base: { ref: "main", repo: { id: 4242, full_name: "acme/app" } },
  head: { ref: "dev/foo", sha: HEAD_OID, repo: { id: 4242, full_name: "acme/app" } },
  ...over,
});

/** 偽の応答層を注入した GitHub クライアントを作る。mutate は書き込みの適用後に経路の応答を差し替える。 */
const github = ({ scenario = "success", routes = {}, mutate } = {}) => {
  const table = {
    [REPO_KEY]: { status: 200, body: { id: 4242, full_name: "acme/app" } },
    [LIST]: { status: 200, body: [] },
    [FILTERED]: { status: 200, body: [] },
    ...routes,
  };
  const fake = createFakeGitHub({ scenario, routes: table });
  const transport = async ({ method, path, body, host }) => {
    const before = fake.applied.length;
    try {
      return await fake.request(method, path, body, { host });
    } finally {
      if (mutate && fake.applied.length > before) mutate(table);
    }
  };
  return { session: createGitHubSession({ host: HOST, token: TOKEN, transport }), fake };
};

// 未実装の間は関数が無いため、各項目は失敗として記録される（RED の確認用）
const prMod = await import("../scripts/publish-pr.mjs").catch(() => ({}));
const createOrReusePr = (...args) => (prMod.createOrReusePr ? prMod.createOrReusePr(...args) : Promise.resolve({ ok: false, kind: "未実装", code: "未実装" }));

const INPUT = { branch: "dev/foo", base: "main", headOid: HEAD_OID, title: "変更の要約", body: "本文" };

export const runCreateOrReusePrChecks = async (eq) => {
  // 1. 既存 PR が無い: 作成し、head・base・タイトル・本文は実際の値で 1 件だけ書き込む
  {
    const gh = github({ routes: { [POST]: { status: 201, body: PR() } } });
    const x = await createOrReusePr(gh.session, TARGET, INPUT);
    eq("brw-pr-handoff/7.1 1 既存 PR が無ければ作成し、created のみ true", [x.ok, x.created, x.reused, x.reconciled, x.pull?.number], [true, true, false, false, 7]);
    eq("brw-pr-handoff/7.1 1 書き込みは作成の 1 件で、引数は head・base・タイトル・本文の実際の値", [gh.fake.writeCount, gh.fake.applied[0]?.body], [1, { title: "変更の要約", body: "本文", head: "dev/foo", base: "main" }]);
  }

  // 2. 同じ取り込み元・取り込み先の開いた PR がある: 再利用し、書き込みは無い
  {
    const gh = github({ routes: { [LIST]: { status: 200, body: [PR()] }, [FILTERED]: { status: 200, body: [PR()] } } });
    const x = await createOrReusePr(gh.session, TARGET, INPUT);
    eq("brw-pr-handoff/7.1 2 既存の同じ PR を再利用し、書き込みを行わない", [x.ok, x.reused, x.created, x.pull?.url, gh.fake.writeCount], [true, true, false, "https://github.com/acme/app/pull/7", 0]);
  }

  // 3. 同じ head で別の取り込み先の PR がある: base-conflict で止め、作成しない
  {
    const gh = github({ routes: { [LIST]: { status: 200, body: [PR({ base: { ref: "develop", repo: { id: 4242, full_name: "acme/app" } } })] } } });
    const x = await createOrReusePr(gh.session, TARGET, INPUT);
    eq("brw-pr-handoff/7.1 3 同じ head で別の取り込み先の PR があれば base-conflict で止め、作成しない", [x.ok, x.kind, x.code, gh.fake.writeCount], [false, "failed", "base-conflict", 0]);
  }

  // 4. 既存 PR が draft: 完了として扱わず pr-draft で止め、作成しない
  {
    const gh = github({ routes: { [LIST]: { status: 200, body: [PR({ draft: true })] } } });
    const x = await createOrReusePr(gh.session, TARGET, INPUT);
    eq("brw-pr-handoff/7.1 4 既存 PR が draft なら pr-draft で止め、作成しない", [x.ok, x.kind, x.code, gh.fake.writeCount], [false, "failed", "pr-draft", 0]);
  }

  // 5. 同じ head・base の PR が複数: pr-ambiguous で止め、作成しない
  {
    const gh = github({ routes: { [LIST]: { status: 200, body: [PR(), PR({ number: 8, html_url: "https://github.com/acme/app/pull/8" })] } } });
    const x = await createOrReusePr(gh.session, TARGET, INPUT);
    eq("brw-pr-handoff/7.1 5 同じ head・base の PR が複数なら pr-ambiguous で止め、作成しない", [x.ok, x.kind, x.code, gh.fake.writeCount], [false, "failed", "pr-ambiguous", 0]);
  }

  // 6. 作成後の食い違い: 作成済みの URL と差異を返し、成功にしない
  {
    const gh = github({ routes: { [POST]: { status: 201, body: PR({ base: { ref: "develop", repo: { id: 4242, full_name: "acme/app" } } }) } } });
    const x = await createOrReusePr(gh.session, TARGET, INPUT);
    eq("brw-pr-handoff/7.1 6 作成後に食い違えば pr-mismatch で止め、作成済みの URL を返す", [x.ok, x.kind, x.code, x.createdUrl, Array.isArray(x.differences) && x.differences.length > 0], [false, "failed", "pr-mismatch", "https://github.com/acme/app/pull/7", true]);
  }

  // 7. 応答喪失: 作成は適用済みで、再取得の照合で一致を確かめ、二重に作らない
  {
    const gh = github({
      scenario: "lost",
      routes: { [POST]: { status: 201, body: PR() } },
      mutate: (t) => { t[LIST] = { status: 200, body: [PR()] }; t[FILTERED] = { status: 200, body: [PR()] }; },
    });
    const x = await createOrReusePr(gh.session, TARGET, INPUT);
    eq("brw-pr-handoff/7.1 7 応答喪失後は再取得で一致を確かめ、reconciled として返す（二重に作らない）", [x.ok, x.reconciled, x.created, x.pull?.number, gh.fake.writeCount], [true, true, false, 7, 1]);
  }

  // 8. 応答喪失で再取得しても見つからない: pr-unconfirmed で止める
  {
    const gh = github({ scenario: "lost", routes: { [POST]: { status: 201, body: {} } } });
    const x = await createOrReusePr(gh.session, TARGET, INPUT);
    eq("brw-pr-handoff/7.1 8 応答喪失後も PR が見つからなければ pr-unconfirmed で止める", [x.ok, x.kind, x.code], [false, "failed", "pr-unconfirmed"]);
  }

  // 9. 作成の直前の確認（beforeCreate）が止めたら、作成しない。結果の種類はそのまま返す
  {
    const gh = github({ routes: { [POST]: { status: 201, body: PR() } } });
    const x = await createOrReusePr(gh.session, TARGET, { ...INPUT, beforeCreate: () => ({ ok: false, kind: "needsApproval", code: "normal-approval" }) });
    eq("brw-pr-handoff/7.1 9 作成の直前の確認が止めたら作成せず、その結果を返す", [x.ok, x.kind, x.code, gh.fake.writeCount], [false, "needsApproval", "normal-approval", 0]);
  }

  // 10. 既存 PR があるときは、作成の直前の確認を呼ばない（再利用は確認なしで完了する）
  {
    let called = 0;
    const gh = github({ routes: { [LIST]: { status: 200, body: [PR()] }, [FILTERED]: { status: 200, body: [PR()] } } });
    const x = await createOrReusePr(gh.session, TARGET, { ...INPUT, beforeCreate: () => { called += 1; return null; } });
    eq("brw-pr-handoff/7.1 10 既存 PR の再利用では作成の直前の確認を呼ばない", [x.ok, x.reused, called], [true, true, 0]);
  }

  // 11. タイトルが無い（新規作成が必要）: pr-title-required で止め、書き込まない
  {
    const gh = github();
    const x = await createOrReusePr(gh.session, TARGET, { ...INPUT, title: undefined });
    eq("brw-pr-handoff/7.1 11 タイトルが無いまま作成が必要なら pr-title-required で止め、書き込まない", [x.ok, x.kind, x.code, gh.fake.writeCount], [false, "invalidInput", "pr-title-required", 0]);
  }

  // 12. GitHub の対象の照合に失敗（認証の失敗）: 既存 PR の探索も作成もしない
  {
    const gh = github({ scenario: "auth" });
    const x = await createOrReusePr(gh.session, TARGET, INPUT);
    eq("brw-pr-handoff/7.1 12 対象の照合に失敗したら止め、作成しない", [x.ok, x.kind, gh.fake.writeCount], [false, "failed", 0]);
  }

  // 13. session が無い: 通信せず invalidInput で止める
  {
    const x = await createOrReusePr(undefined, TARGET, INPUT);
    eq("brw-pr-handoff/7.1 13 GitHub のクライアントが無ければ session-invalid で止める", [x.ok, x.kind, x.code], [false, "invalidInput", "session-invalid"]);
  }
};
