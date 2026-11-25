// 完了公開の PR 再利用・作成（brw-enforcement 4.5）の契約テスト。selftest.mjs から呼ばれる。
// push は 4.4 の runPush で実際に行い、遠隔は bare remote（GIT_SSH_COMMAND の試験用スクリプトで差し替え）を使う。
// GitHub の応答は実際の createGitHubSession に fake-github.mjs を transport として注入して返す。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as publish from "../scripts/publish.mjs";
import { createGitHubSession } from "../scripts/github-client.mjs";
import { createFakeGitHub } from "./support/fake-github.mjs";
import { gitOut, mkRepoWithRemote } from "./support/git-fixture.mjs";

const CONFIG = { workBranches: ["dev/*"], protectedBranches: ["main"], baseBranch: "develop" };
const GH_SSH = "git@github.com:acme/app.git";
const REPO = { id: 4242, owner: "acme", name: "app" };
const HOST = "github.com";
const TOKEN = "test-token-xyz";
const DONE = "依頼の完了条件を満たした";
const VERIFIED = { passed: true, summary: "npm test が成功" };
const PULL = (over = {}) => ({ ok: true, pull: null, ...over });

// 試験用 ssh 代わり。対象の GitHub パスを BRW_TEST_BARE（bare remote）へ置き換えて実行する（publish-push と同じ方式）
const FAKE_SSH = `#!/bin/sh
cmd=$(printf '%s' "$2" | sed "s#acme/app.git#$BRW_TEST_BARE#")
exec sh -c "$cmd"
`;

// fake-github の経路キー（クエリまで一致させる）
const REPO_KEY = "GET /repos/acme/app";
const LIST = "GET /repos/acme/app/pulls?state=open&head=acme:dev/foo&per_page=100";
const FILTERED = "GET /repos/acme/app/pulls?state=open&head=acme:dev/foo&base=main&per_page=100";
const POST = "POST /repos/acme/app/pulls";

// 未実装の間は publish-pr.mjs が無いため、各項目は「未実装」として失敗する（RED の確認用）
const UNKNOWN = { kind: "未実装", code: "未実装", message: "未実装" };
const prMod = await import("../scripts/publish-pr.mjs").catch(() => ({}));
const runPublishPr = (...args) => (prMod.runPublishPr ? prMod.runPublishPr(...args) : Promise.resolve({ ok: false, error: UNKNOWN }));

/** 宣言つきの一時リポジトリを作り、push 先を GitHub の形の URL にして開発ブランチで作業を始める。 */
const setup = ({ recorded = "main", config = CONFIG } = {}) => {
  const r = mkRepoWithRemote({ branch: "dev/foo", config });
  gitOut(r.dir, "remote", "set-url", "origin", GH_SSH);
  if (recorded) gitOut(r.dir, "config", "branch.dev/foo.brwBase", recorded);
  process.env.BRW_TEST_BARE = r.remote;
  return r;
};

/** 準備・計画・（既定では）push まで済ませた作業を用意して fn を呼ぶ。後始末もする。 */
const scenario = async (opts, fn) => {
  const { push = true, ...repoOpts } = opts;
  const r = setup(repoOpts);
  try {
    const id = publish.startWork(r.dir, { sessionId: "s1" }).work.workId;
    const ready = publish.markReady(r.dir, id, { completion: DONE, verification: VERIFIED, repository: REPO });
    if (!ready.ok) throw new Error(`準備に失敗: ${ready.error?.code}`);
    const planned = publish.issuePlan(r.dir, id, { repository: REPO, existing: PULL() });
    if (!planned.ok) throw new Error(`計画に失敗: ${planned.error?.code}`);
    if (push) {
      const p = publish.runPush(r.dir, id, { planId: planned.plan.planId, repository: REPO });
      if (!p.ok) throw new Error(`push に失敗: ${p.error?.code}`);
    }
    const head = gitOut(r.dir, "rev-parse", "HEAD");
    return await fn({ dir: r.dir, id, remote: r.remote, head, planId: planned.plan.planId });
  } finally {
    r.cleanup();
  }
};

/** 計画をし直す（禁止の追加などの後で、計画の版を取り直すため）。 */
const replan = (dir, id) => publish.issuePlan(dir, id, { repository: REPO, existing: PULL() });

/** 応答の PR（head の OID は指定の値）。 */
const PR = (head, over = {}) => ({
  number: 7,
  html_url: "https://github.com/acme/app/pull/7",
  state: "open",
  draft: false,
  base: { ref: "main", repo: { id: 4242, full_name: "acme/app" } },
  head: { ref: "dev/foo", sha: head, repo: { id: 4242, full_name: "acme/app" } },
  ...over,
});

/**
 * 実際の GitHub クライアントに、偽の応答層を transport として注入する。
 * mutate は書き込みが適用された直後に呼ばれ、応答喪失の後の再取得の応答を差し替えるために使う。
 */
const github = ({ scenario: sc = "success", routes = {}, mutate } = {}) => {
  const table = {
    [REPO_KEY]: { status: 200, body: { id: 4242, full_name: "acme/app" } },
    [LIST]: { status: 200, body: [] },
    [FILTERED]: { status: 200, body: [] },
    ...routes,
  };
  const fake = createFakeGitHub({ scenario: sc, routes: table });
  const transport = async ({ method, path, body, host }) => {
    const before = fake.applied.length;
    try {
      return await fake.request(method, path, body, { host });
    } finally {
      if (mutate && fake.applied.length > before) mutate(table);
    }
  };
  const session = createGitHubSession({ host: HOST, token: TOKEN, transport });
  return { session, fake };
};

const stateText = (d) => readFileSync(publish.stateFileOf(d), "utf8");
const workOf = (d, id) => publish.readWork(d, id).work;

export const runPublishPrChecks = async (eq) => {
  // 試験用 ssh を環境変数に設定する（終了時に元へ戻す）
  const sshDir = mkdtempSync(join(tmpdir(), "brw-ssh-pr-"));
  const sshPath = join(sshDir, "fake-ssh.sh");
  writeFileSync(sshPath, FAKE_SSH, { mode: 0o755 });
  const saved = { cmd: process.env.GIT_SSH_COMMAND, variant: process.env.GIT_SSH_VARIANT, bare: process.env.BRW_TEST_BARE };
  process.env.GIT_SSH_COMMAND = sshPath;
  process.env.GIT_SSH_VARIANT = "simple";

  try {
    // ---- 開発間の取り込み: push で完了し、GitHub へは一切通信しない ----
    await scenario({ recorded: "dev/parent" }, async ({ dir, id, planId }) => {
      const x = await runPublishPr(dir, id, { planId, repository: REPO });
      eq("enforcement/4.5 開発間の取り込みは push で完了し、PR を扱わない（publication は push）", [x.ok, x.outcome, x.publication, x.pr], [true, "success", "push", null]);
      eq("enforcement/4.5 開発間の完了で作業の状態を published にし、PR の結果を残さない", [workOf(dir, id).status, workOf(dir, id).results.pr ?? null], ["published", null]);
    });
    await scenario({ recorded: "dev/parent", push: false }, async ({ dir, id }) => {
      const x = await runPublishPr(dir, id, { planId: publish.readWork(dir, id).work.plan.planId, repository: REPO });
      eq("enforcement/4.5 遠隔に準備時の OID が無ければ、開発間でも完了せず remote-mismatch で止める", [x.ok, x.error?.code], [false, "remote-mismatch"]);
      eq("enforcement/4.5 止めた場合は作業を published にしない", workOf(dir, id).status, "ready");
    });

    // ---- 保護対象への PR 新規作成: 作成の引数は実際の値、成功で published ----
    await scenario({}, async ({ dir, id, head, planId }) => {
      const gh = github({ routes: { [POST]: { status: 201, body: PR(head) } } });
      const x = await runPublishPr(dir, id, { planId, repository: REPO, session: gh.session, title: "変更の要約", body: "本文" });
      eq("enforcement/4.5 保護対象への PR を作成し、対象 URL・base・push の結果を返す", [x.ok, x.outcome, x.pr?.number, x.pr?.url, x.pr?.created, x.base, x.push?.outcome], [true, "success", 7, "https://github.com/acme/app/pull/7", true, "main", "success"]);
      eq("enforcement/4.5 GitHub への書き込みは PR の作成 1 件だけで、head・base・タイトル・本文は実際の値", [gh.fake.writeCount, gh.fake.applied[0]?.body], [1, { title: "変更の要約", body: "本文", head: "dev/foo", base: "main" }]);
      eq("enforcement/4.5 成功を結果に記録し、作業の状態を published にする", [{ outcome: workOf(dir, id).results.pr.outcome, code: workOf(dir, id).results.pr.code, url: workOf(dir, id).results.pr.url }, workOf(dir, id).status], [{ outcome: "success", code: null, url: "https://github.com/acme/app/pull/7" }, "published"]);
      eq("brw-pr-handoff/4.7 PR の成功時に、PR の URL と取り込み先を公開記録として保存する（push の記録も残る）", [workOf(dir, id).results.pr.url, workOf(dir, id).results.pr.base, workOf(dir, id).results.push.remote, typeof workOf(dir, id).results.push.oid], ["https://github.com/acme/app/pull/7", "main", "origin", "string"]);
      eq("enforcement/4.5 状態ファイルに資格情報を残さない", stateText(dir).includes(TOKEN), false);
    });

    // ---- タイトルが無い PR 作成は、書き込みの前に止める（利用者にタイトルを求める） ----
    await scenario({}, async ({ dir, id, planId }) => {
      const gh = github();
      const x = await runPublishPr(dir, id, { planId, repository: REPO, session: gh.session });
      eq("enforcement/4.5 タイトルが無い PR 作成は pr-title-required で止め、書き込まない", [x.ok, x.error?.code, gh.fake.writeCount, workOf(dir, id).status], [false, "pr-title-required", 0, "pushed"]);
    });

    // ---- 既存 PR の再利用: 同じ head・base・OID・ready なら成功扱い、書き込みはしない ----
    await scenario({}, async ({ dir, id, head, planId }) => {
      const gh = github({ routes: { [LIST]: { status: 200, body: [PR(head)] }, [FILTERED]: { status: 200, body: [PR(head)] } } });
      const x = await runPublishPr(dir, id, { planId, repository: REPO, session: gh.session, title: "変更" });
      eq("enforcement/4.5 同じ head・base の既存 PR は再利用し、作成しない", [x.ok, x.outcome, x.pr?.created, x.pr?.url, gh.fake.writeCount], [true, "success", false, "https://github.com/acme/app/pull/7", 0]);
      eq("enforcement/4.5 再利用の成功は reused として記録する", [workOf(dir, id).results.pr?.code, workOf(dir, id).status], ["reused", "published"]);
    });

    // ---- 既存 PR が draft: 成功扱いにせず、書き込みもしない ----
    await scenario({}, async ({ dir, id, head, planId }) => {
      const gh = github({ routes: { [LIST]: { status: 200, body: [PR(head, { draft: true })] }, [FILTERED]: { status: 200, body: [PR(head, { draft: true })] } } });
      const x = await runPublishPr(dir, id, { planId, repository: REPO, session: gh.session, title: "変更" });
      eq("enforcement/4.5 draft の既存 PR は再利用せず pr-draft で止める", [x.ok, x.error?.code, gh.fake.writeCount, workOf(dir, id).status], [false, "pr-draft", 0, "pushed"]);
    });

    // ---- 同じ head で別の取り込み先の既存 PR: 成功扱いにせず base-conflict、作成もしない ----
    await scenario({}, async ({ dir, id, head, planId }) => {
      const other = PR(head, { base: { ref: "develop", repo: { id: 4242, full_name: "acme/app" } } });
      const gh = github({ routes: { [LIST]: { status: 200, body: [other] } } });
      const x = await runPublishPr(dir, id, { planId, repository: REPO, session: gh.session, title: "変更" });
      eq("enforcement/4.5 別の base の既存 PR があれば base-conflict で止め、作成しない", [x.ok, x.error?.code, gh.fake.writeCount], [false, "base-conflict", 0]);
    });

    // ---- PR 作成の禁止: 再計画後に禁止を確認し、作成せず prohibited を記録する（push の結果は残す） ----
    await scenario({}, async ({ dir, id }) => {
      publish.setRestrictions(dir, id, { noPr: true });
      const y = replan(dir, id);
      const gh = github();
      const x = await runPublishPr(dir, id, { planId: y.plan.planId, repository: REPO, session: gh.session, title: "変更" });
      eq("enforcement/4.5 PR 作成が禁止されていれば作成せず、prohibited を返す", [x.ok, x.outcome, x.code, gh.fake.writeCount], [true, "prohibited", "work-restriction", 0]);
      eq("enforcement/4.5 禁止による省略を記録し、push の成功は残す・作業は公開済みにしない", [workOf(dir, id).results.pr, workOf(dir, id).results.push?.outcome, workOf(dir, id).status], [{ outcome: "prohibited", code: "work-restriction" }, "success", "pushed"]);
    });

    // ---- 通常確認待ち: 確認省略が無効なら作成せず needsApproval、確認後の個別の実行で作成する ----
    await scenario({ config: { ...CONFIG, autoApprove: { pullRequest: false } } }, async ({ dir, id, head, planId }) => {
      const gh = github({ routes: { [POST]: { status: 201, body: PR(head) } } });
      const x = await runPublishPr(dir, id, { planId, repository: REPO, session: gh.session, title: "変更" });
      eq("enforcement/4.5 確認省略が無効なら作成せず needsApproval を返す", [x.ok, x.outcome, x.code, gh.fake.writeCount], [true, "needsApproval", "normal-approval", 0]);
      const y = await runPublishPr(dir, id, { planId, repository: REPO, session: gh.session, title: "変更", confirmed: true });
      eq("enforcement/4.5 通常確認を経た個別の実行で作成し、execution を confirmed として記録する", [y.ok, y.outcome, gh.fake.writeCount, workOf(dir, id).started?.pr?.execution], [true, "success", 1, "confirmed"]);
    });

    // ---- 応答喪失: 作成は適用済みで、再取得で一致を確認して URL を返す（二重に作らない） ----
    await scenario({}, async ({ dir, id, head, planId }) => {
      const gh = github({
        scenario: "lost",
        routes: { [POST]: { status: 201, body: PR(head) } },
        mutate: (t) => { t[LIST] = { status: 200, body: [PR(head)] }; t[FILTERED] = { status: 200, body: [PR(head)] }; },
      });
      const x = await runPublishPr(dir, id, { planId, repository: REPO, session: gh.session, title: "変更" });
      eq("enforcement/4.5 応答喪失後に再取得で一致を確かめ、作成済みの PR の URL を返す", [x.ok, x.outcome, x.pr?.reconciled, x.pr?.url, gh.fake.writeCount], [true, "success", true, "https://github.com/acme/app/pull/7", 1]);
      eq("enforcement/4.5 照合で確定した成功も published として記録する", [workOf(dir, id).results.pr?.outcome, workOf(dir, id).status], ["success", "published"]);
    });
    await scenario({}, async ({ dir, id, planId }) => {
      const gh = github({ scenario: "lost", routes: { [POST]: { status: 201, body: {} } } });
      const x = await runPublishPr(dir, id, { planId, repository: REPO, session: gh.session, title: "変更" });
      eq("enforcement/4.5 応答喪失後も PR が見つからなければ pr-unconfirmed で失敗とし、完了としない", [x.ok, x.error?.code, workOf(dir, id).results.pr?.code, workOf(dir, id).status], [false, "pr-unconfirmed", "pr-unconfirmed", "pushed"]);
    });

    // ---- 作成後の食い違い: 作成済みの URL と差異を報告し、完了とは記録しない ----
    await scenario({}, async ({ dir, id, planId }) => {
      const gh = github({ routes: { [POST]: { status: 201, body: PR("0".repeat(40)) } } });
      const x = await runPublishPr(dir, id, { planId, repository: REPO, session: gh.session, title: "変更" });
      eq("enforcement/4.5 作成された PR が準備時の内容と違えば pr-mismatch と作成済みの URL を返す", [x.ok, x.error?.code, x.createdUrl], [false, "pr-mismatch", "https://github.com/acme/app/pull/7"]);
      eq("enforcement/4.5 食い違いは完了として記録せず、作業も published にしない", [workOf(dir, id).results.pr?.outcome, workOf(dir, id).status], ["failed", "pushed"]);
    });

    // ---- PR だけ失敗: push の成功は途中結果として残る ----
    await scenario({}, async ({ dir, id, planId }) => {
      const gh = github({ scenario: "permission" });
      const x = await runPublishPr(dir, id, { planId, repository: REPO, session: gh.session, title: "変更" });
      eq("enforcement/4.5 push 成功後に PR だけ失敗したら pr-permission を返し、push の結果を残す", [x.ok, x.error?.code, x.push?.outcome, workOf(dir, id).results.push?.outcome], [false, "pr-permission", "success", "success"]);
      eq("enforcement/4.5 PR の失敗を記録し、作業は pushed のまま", [workOf(dir, id).results.pr?.code, workOf(dir, id).status], ["pr-permission", "pushed"]);
    });

    // ---- 割り込み（状態ロック内の再検証）: GitHub の読み取りの後に中断されたら作成しない ----
    await scenario({}, async ({ dir, id, planId }) => {
      const gh = github();
      let fired = false;
      const session = { ...gh.session, request: async (...a) => {
        if (!fired) { fired = true; publish.pauseWork(dir, id, "割り込み"); }
        return gh.session.request(...a);
      } };
      const x = await runPublishPr(dir, id, { planId, repository: REPO, session, title: "変更" });
      eq("enforcement/4.5 読み取り後に中断されたら、再検証で止め work-paused を返す", [x.ok, x.error?.code], [false, "work-paused"]);
      eq("enforcement/4.5 中断で止めた場合は作成せず、操作の開始も記録しない", [gh.fake.writeCount, workOf(dir, id).started?.pr ?? null], [0, null]);
    });
    // 割り込み（禁止の追加）: 読み取り後に PR 作成が禁止されたら、計画を失効させて作成しない
    await scenario({}, async ({ dir, id, planId }) => {
      const gh = github();
      let fired = false;
      const session = { ...gh.session, request: async (...a) => {
        if (!fired) { fired = true; publish.setRestrictions(dir, id, { noPr: true }); }
        return gh.session.request(...a);
      } };
      const x = await runPublishPr(dir, id, { planId, repository: REPO, session, title: "変更" });
      eq("enforcement/4.5 読み取り後に禁止が追加されたら、再検証で restrictions-changed を返す", [x.ok, x.error?.code], [false, "restrictions-changed"]);
      eq("enforcement/4.5 禁止で止めた場合は作成せず、操作の開始も記録しない", [gh.fake.writeCount, workOf(dir, id).started?.pr ?? null], [0, null]);
    });

    // ---- 同じ worktree の公開は直列化する ----
    await scenario({}, async ({ dir, id, planId }) => {
      const lock = `${publish.stateFileOf(dir)}.run.lock`;
      writeFileSync(lock, String(process.pid));
      const gh = github();
      const busy = await runPublishPr(dir, id, { planId, repository: REPO, session: gh.session, title: "変更", lockWaitMs: 50 });
      rmSync(lock, { force: true });
      eq("enforcement/4.5 同じ worktree で別の公開が実行中なら publish-busy で止め、書き込まない", [busy.error?.code, gh.fake.writeCount], ["publish-busy", 0]);
    });

    // ---- 入力の検査: 確認の有無は真偽値、対象は正の整数の ID ----
    await scenario({}, async ({ dir, id, planId }) => {
      const gh = github();
      const x = await runPublishPr(dir, id, { planId, repository: REPO, session: gh.session, title: "変更", confirmed: "yes" });
      eq("enforcement/4.5 確認の有無が真偽値でなければ invalidInput で拒否し、書き込まない", [x.error?.kind, gh.fake.writeCount], ["invalidInput", 0]);
    });

    // ---- 遠隔の対象 ref が準備時の OID でなければ、PR を作らない（push 未完了） ----
    await scenario({ push: false }, async ({ dir, id, planId }) => {
      const gh = github();
      const x = await runPublishPr(dir, id, { planId, repository: REPO, session: gh.session, title: "変更" });
      eq("enforcement/4.5 遠隔が準備時の OID でなければ remote-mismatch で止め、PR を作らない", [x.ok, x.error?.code, gh.fake.writeCount], [false, "remote-mismatch", 0]);
    });

    // ---- noPush の作業を手動で push 済みの場合: gh pr create は push を伴いうるため自動では承認されず、通常確認待ちで止める（書き込まない） ----
    await scenario({ push: false }, async ({ dir, id }) => {
      publish.setRestrictions(dir, id, { noPush: true });
      const y = replan(dir, id);
      gitOut(dir, "push", "-q", "origin", "HEAD:refs/heads/dev/foo");
      const gh = github();
      const x = await runPublishPr(dir, id, { planId: y.plan.planId, repository: REPO, session: gh.session, title: "変更" });
      eq("enforcement/4.5 noPush の作業では PR 作成を自動承認せず、通常確認待ちで止め、書き込まない", [x.ok, x.outcome, x.code, gh.fake.writeCount], [true, "needsApproval", "normal-approval", 0]);
    });
  } finally {
    for (const [k, v] of [["GIT_SSH_COMMAND", saved.cmd], ["GIT_SSH_VARIANT", saved.variant], ["BRW_TEST_BARE", saved.bare]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(sshDir, { recursive: true, force: true });
  }
};
