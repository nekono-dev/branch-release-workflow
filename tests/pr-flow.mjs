// `brw pr`（pr-flow）の統合試験。selftest.mjs から呼ばれる。偽の GitHub 接続と、実際の一時リポジトリ（本体・worktree・bare の遠隔）で確かめる。
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitHubSession } from "../scripts/github-client.mjs";
import { runPr } from "../scripts/pr-flow.mjs";
import { bodyPathOf, UNFILLED_MARK } from "../scripts/pr-template.mjs";
import * as publish from "../scripts/publish.mjs";
import { createFakeGitHub } from "./support/fake-github.mjs";
import { gitOut, mkRepoWithRemote, mkWorktree } from "./support/git-fixture.mjs";

const CONFIG = { workBranches: ["dev/*"], protectedBranches: ["main"], baseBranch: "develop" };
const GH_SSH = "git@github.com:acme/app.git";
const FAKE_SSH = `#!/bin/sh
cmd=$(printf '%s' "$2" | sed "s#acme/app.git#$BRW_TEST_BARE#")
exec sh -c "$cmd"
`;
const DONE = "依頼の完了条件を満たした";
const VERIFY = "npm test が成功";
const ARGS = ["--title", "変更の要約", "--completion", DONE, "--verification", VERIFY];

const PR = (head) => ({
  number: 7, html_url: "https://github.com/acme/app/pull/7", state: "open", draft: false,
  base: { ref: "main", repo: { id: 4242, full_name: "acme/app" } },
  head: { ref: "dev/foo", sha: head, repo: { id: 4242, full_name: "acme/app" } },
});

// repo（本体は main）と、push 済みの作業ブランチ dev/foo の worktree を作る。PR の応答の head は、その時点の worktree の HEAD になる
function setup({ config = CONFIG, body = "## 概要\n\n書き終えた本文\n", mutate } = {}) {
  const r = mkRepoWithRemote({ branch: "main", config });
  gitOut(r.dir, "remote", "set-url", "origin", GH_SSH);
  process.env.BRW_TEST_BARE = r.remote;
  const wt = mkWorktree(r.dir, "dev/foo");
  gitOut(wt, "config", "branch.dev/foo.brwBase", "main");
  writeFileSync(join(wt, "f.txt"), "f\n");
  gitOut(wt, "add", "f.txt");
  gitOut(wt, "commit", "-q", "-m", "作業");
  const bodyPath = bodyPathOf(r.dir, "dev/foo");
  if (body !== null) { require_mkdir(bodyPath); writeFileSync(bodyPath, body); }
  const routes = {
    "GET /repos/acme/app": { status: 200, body: { id: 4242, full_name: "acme/app" } },
    "GET /repos/acme/app/pulls?state=open&head=acme:dev/foo&per_page=100": { status: 200, body: [] },
    "GET /repos/acme/app/pulls?state=open&head=acme:dev/foo&base=main&per_page=100": { status: 200, body: [] },
    // 応答の head は、書き込みの時点の worktree の HEAD（別コミットが加わった後の値）にする
    "POST /repos/acme/app/pulls": { status: 201, get body() { return PR(gitOut(wt, "rev-parse", "HEAD")); } },
  };
  const fake = createFakeGitHub({ routes });
  const transport = async ({ method, path, body: b, host }) => {
    const before = fake.applied.length;
    try { return await fake.request(method, path, b, { host }); } finally { if (mutate && fake.applied.length > before) mutate({ wt, dir: r.dir }); }
  };
  const session = createGitHubSession({ host: "github.com", token: "test-token-flow", transport });
  return { ...r, wt, bodyPath, fake, session };
}
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
function require_mkdir(p) { mkdirSync(dirname(p), { recursive: true }); }

// 分岐元 develop の試験（brw-pr-handoff 7.4）。main の先に develop（d1）を作り、origin へ push 済みにする。本体は develop のチェックアウト。
const BASE_BODY = "分岐元からの本文\n";
const BASE_PR = (head) => ({
  number: 7, html_url: "https://github.com/acme/app/pull/7", state: "open", draft: false,
  base: { ref: "main", repo: { id: 4242, full_name: "acme/app" } },
  head: { ref: "develop", sha: head, repo: { id: 4242, full_name: "acme/app" } },
});
function setupBase() {
  const r = mkRepoWithRemote({ branch: "main", config: CONFIG });
  gitOut(r.dir, "remote", "set-url", "origin", GH_SSH);
  process.env.BRW_TEST_BARE = r.remote;
  gitOut(r.dir, "checkout", "-q", "-b", "develop");
  writeFileSync(join(r.dir, "d1.txt"), "d1\n");
  gitOut(r.dir, "add", "d1.txt");
  gitOut(r.dir, "commit", "-q", "-m", "d1");
  gitOut(r.dir, "push", "-q", "origin", "develop");
  const bodyPath = bodyPathOf(r.dir, "develop");
  require_mkdir(bodyPath);
  writeFileSync(bodyPath, BASE_BODY);
  const routes = {
    "GET /repos/acme/app": { status: 200, body: { id: 4242, full_name: "acme/app" } },
    "GET /repos/acme/app/pulls?state=open&head=acme:develop&per_page=100": { status: 200, body: [] },
    "GET /repos/acme/app/pulls?state=open&head=acme:develop&base=main&per_page=100": { status: 200, body: [] },
    "POST /repos/acme/app/pulls": { status: 201, get body() { return BASE_PR(gitOut(r.dir, "rev-parse", "HEAD")); } },
  };
  const fake = createFakeGitHub({ routes });
  const transport = async ({ method, path, body: b, host }) => fake.request(method, path, b, { host });
  const session = createGitHubSession({ host: "github.com", token: "test-token-flow-base", transport });
  return { ...r, bodyPath, fake, session };
}

const run = async (t, args, extra = {}) => {
  const out = [];
  const err = [];
  const code = await runPr(args, { cwd: extra.cwd ?? t.wt, session: () => t.session, stdinIsTTY: extra.tty === true, io: { out: (s) => out.push(s), err: (s) => err.push(s) } });
  return { code, out: out.join("\n"), err: err.join("\n") };
};
const branchExists = (t) => { try { gitOut(t.dir, "rev-parse", "--verify", "--quiet", "refs/heads/dev/foo"); return true; } catch { return false; } };
const remoteHas = (t) => gitOut(t.dir, "ls-remote", "origin", "refs/heads/dev/foo").length > 0;

export const runPrFlowChecks = async (eq) => {
  const sshDir = mkdtempSync(join(tmpdir(), "brw-ssh-flow-"));
  const sshPath = join(sshDir, "fake-ssh.sh");
  writeFileSync(sshPath, FAKE_SSH, { mode: 0o755 });
  const saved = { cmd: process.env.GIT_SSH_COMMAND, variant: process.env.GIT_SSH_VARIANT, bare: process.env.BRW_TEST_BARE };
  process.env.GIT_SSH_COMMAND = sshPath;
  process.env.GIT_SSH_VARIANT = "simple";
  try {
    // ---- 一連の流れ: 別コミット → 準備 → 計画 → 公開 → 片付け ----
    {
      const t = setup();
      writeFileSync(join(t.wt, "extra.txt"), "作業外\n"); // 未コミットの変更 → 別コミットになる
      const x = await run(t, ARGS);
      eq("brw-pr-handoff/1.2 brw pr は、別コミット・準備・計画・公開・片付けを 1 回で通す", [x.code, t.fake.writeCount, existsSync(t.wt), branchExists(t), remoteHas(t), existsSync(t.bodyPath)], [0, 1, false, false, true, false]);
      eq("brw-pr-handoff/2.1 未コミットの変更は、PR の前に別コミットとして遠隔のブランチに含まれる", gitOut(t.dir, "log", "-3", "--format=%s", "origin/dev/foo").split("\n")[0], "chore: 作業外の変更（ボーイスカウト）");
      eq("brw-pr-handoff/4.8 片付けの後に、本体のパスと次の brw create を案内する", [x.out.includes(t.dir), x.out.includes("brw create"), x.out.includes("片付けました")], [true, true, true]);
      eq("brw-pr-handoff/4.10 片付けの後に、作業状態のファイルが残らない", existsSync(publish.stateFileOf(t.dir)) ? Object.keys(JSON.parse(readFileSync(publish.stateFileOf(t.dir), "utf8")).works).length : 0, 0);
      t.cleanup();
    }

    // ---- 本文が無い・未記入: 副作用の前に止まる ----
    {
      const none = setup({ body: null });
      const x = await run(none, ARGS);
      eq("brw-pr-handoff/3.8 本文ファイルが無いときは、brw pr-template を案内して止まり、push も PR もしない", [x.code, x.err.includes("brw pr-template"), remoteHas(none), none.fake.writeCount, existsSync(none.wt)], [1, true, false, 0, true]);
      none.cleanup();
      const unfilled = setup({ body: `${UNFILLED_MARK} -->\n## 概要\n` });
      const y = await run(unfilled, ARGS);
      eq("brw-pr-handoff/3.8 未記入の印が残る本文は、副作用の前に止まる", [y.code, y.err.includes("未記入"), remoteHas(unfilled), unfilled.fake.writeCount], [1, true, false, 0]);
      unfilled.cleanup();
    }

    // ---- 承認待ちで止まり、利用者の端末での再実行で続きから進む ----
    {
      const t = setup({ config: { ...CONFIG, autoApprove: { push: true, pullRequest: false } } });
      const x = await run(t, ARGS);
      eq("brw-pr-handoff/1.4 PR の通常の承認が必要なときは、利用者の端末で実行する brw pr の全文を案内して止まり、削除しない", [x.code, x.err.includes("--confirmed"), x.err.includes("brw pr "), t.fake.writeCount, existsSync(t.wt), branchExists(t)], [1, true, true, 0, true, true]);
      const y = await run(t, ARGS, { tty: true });
      eq("brw-pr-handoff/1.4 --confirmed を付けず TTY でも承認は得られない（承認待ちのまま）", [y.code, t.fake.writeCount], [1, 0]);
      const z = await run(t, [...ARGS, "--confirmed"], { tty: true });
      eq("brw-pr-handoff/1.4 利用者の端末での再実行（--confirmed）は、済んだ push を飛ばして PR を作り、片付けまで進む", [z.code, t.fake.writeCount, existsSync(t.wt), branchExists(t)], [0, 1, false, false]);
      t.cleanup();
    }

    // ---- 片付けが無効: 何も削除せず、手動の手順を案内する ----
    {
      const t = setup({ config: { ...CONFIG, afterPublish: { cleanup: false } } });
      const x = await run(t, ARGS);
      eq("brw-pr-handoff/5.5 片付けが無効のときは PR を作るが何も削除せず、手動の片付けを案内する", [x.code, t.fake.writeCount, existsSync(t.wt), branchExists(t), x.out.includes("brw finish dev/foo")], [0, 1, true, true, true]);
      t.cleanup();
    }

    // ---- 開発ブランチへの取り込み（push だけで完了）は片付けない ----
    {
      const t = setup();
      const x = await run(t, ["--target", "dev/other", "--completion", DONE, "--verification", VERIFY]);
      eq("brw-pr-handoff/1.5 開発ブランチへの取り込み（push で完了）は PR を作らず、片付けず、brw merge を案内する", [x.code, t.fake.writeCount, existsSync(t.wt), branchExists(t), x.out.includes("brw merge")], [0, 0, true, true, true]);
      t.cleanup();
    }

    // ---- PR 作成後に片付けが止まり、再実行で続きから片付く ----
    {
      const t = setup({ mutate: ({ wt }) => writeFileSync(join(wt, "late.txt"), "PR 作成後の変更\n") });
      const x = await run(t, ARGS);
      eq("brw-pr-handoff/4.6 PR 作成後に未コミットの変更が現れたときは、片付けず理由を示し、PR は作成済みのまま", [x.code, t.fake.writeCount, existsSync(t.wt), x.out.includes("片付けは行いませんでした")], [1, 1, true, true]);
      rmSync(join(t.wt, "late.txt"));
      const y = await run(t, []);
      eq("brw-pr-handoff/4.9 変更を取り除いて brw pr を再実行すると、PR を重複して作らず、片付けだけが行われる", [y.code, t.fake.writeCount, existsSync(t.wt), branchExists(t)], [0, 1, false, false]);
      t.cleanup();
    }


    // ---- push だけで完了した作業は、PR の片付け待ちとして扱わない ----
    {
      const t = setup();
      await run(t, ["--target", "dev/other", "--completion", DONE, "--verification", VERIFY]);
      const y = await run(t, ["--target", "dev/other", "--completion", DONE, "--verification", VERIFY]);
      eq("brw-pr-handoff/1.5 push だけで完了した作業は、再実行しても「PR 作成済み」「片付け待ち」として扱わず、新しい作業として進む", [y.code, y.out.includes("PR は作成済み"), existsSync(t.wt), branchExists(t)], [0, false, true, true]);
      t.cleanup();
    }

    // ---- 準備後に HEAD が変わった再実行は、前回の検証（未通過を含む）を引き継ぐ ----
    {
      const t = setup({ config: { ...CONFIG, autoApprove: { push: true, pullRequest: false } } });
      await run(t, ["--title", "変更の要約", "--completion", DONE, "--verification", "テストが成功した"]);
      writeFileSync(join(t.wt, "more.txt"), "追加\n"); // 承認待ちで止まった後に、変更が加わる（別コミットで HEAD が変わる）
      await run(t, ["--title", "変更の要約"]);
      const work = Object.values(JSON.parse(readFileSync(publish.stateFileOf(t.wt), "utf8")).works)[0];
      eq("brw-pr-handoff/6.4 HEAD が変わった後の再準備でも、前回の完了申告・検証の要約を引き継ぐ", [work.ready.completion, work.ready.verification.summary, work.ready.verification.passed], [DONE, "テストが成功した", true]);
      const f = setup();
      const fx = await run(f, ["--title", "t", "--completion", DONE, "--verification", "失敗した", "--failed"]);
      eq("brw-pr-handoff/6.4 検証が未通過（--failed）のときは、公開の準備で止まり、push も PR もしない", [fx.code, fx.err.includes("検証が成功していない"), remoteHas(f), f.fake.writeCount], [1, true, false, 0]);
      f.cleanup();
      t.cleanup();
    }

    // ---- 事前確認 ----
    {
      const t = setup();
      const x = await run(t, ARGS, { cwd: t.dir });
      eq("brw-pr-handoff/1.3 開発ブランチでない場所（本体の main）では、PR を作らず理由を示して止まる", [x.code, x.err.includes("開発ブランチではない"), t.fake.writeCount], [1, true, 0]);
      const y = await run(t, ["--bogus"]);
      eq("brw-pr-handoff/1.2 不明なオプションは使い方の誤り（終了コード 2）", y.code, 2);
      t.cleanup();
    }

    // ---- 分岐元のチェックアウトからの brw pr は、分岐元からの PR（7.3 の調整役）へ渡す（7.4） ----
    {
      const b = setupBase();
      const x = await run(b, ["--title", "分岐元からの PR"], { cwd: b.dir });
      const sent = b.fake.applied[0]?.body;
      eq("brw-pr-handoff/7.4 分岐元のチェックアウトの brw pr は分岐元からの PR へ渡り、PR を作って終了コード 0 にする", [x.code, x.out.includes("PR を作成しました"), b.fake.writeCount], [0, true, 1]);
      eq("brw-pr-handoff/7.4 分岐元からの PR の引数は head（分岐元）・base（保護ブランチ）・本文の実際の値", [sent?.head, sent?.base, sent?.body], ["develop", "main", BASE_BODY]);
      eq("brw-pr-handoff/7.4 分岐元からの PR は作業の記録を作らず、分岐元のブランチが残る", [existsSync(publish.stateFileOf(b.dir)), gitOut(b.dir, "branch", "--show-current")], [false, "develop"]);
      b.cleanup();
    }

    // ---- 分岐元でも開発ブランチでもない場所は、理由と手順を示して止まる（書き込み 0） ----
    {
      const p = setupBase();
      gitOut(p.dir, "checkout", "-q", "main");
      const x = await run(p, ["--title", "t"], { cwd: p.dir });
      eq("brw-pr-handoff/1.4 保護ブランチの上では、保護ブランチの理由と分岐元での実行の手順を示して止まり、書き込みは 0", [x.code, x.err.includes("保護ブランチ"), x.err.includes("分岐元"), x.err.includes("開発ブランチではないため"), p.fake.writeCount], [1, true, true, true, 0]);
      p.cleanup();
    }
    {
      const p = setupBase();
      gitOut(p.dir, "checkout", "-q", "-b", "feature/x");
      const x = await run(p, ["--title", "t"], { cwd: p.dir });
      eq("brw-pr-handoff/1.4 宣言の範囲外のブランチでは、宣言の確認と brw create を示して止まり、書き込みは 0", [x.code, x.err.includes("宣言"), x.err.includes("brw create"), p.fake.writeCount], [1, true, true, 0]);
      p.cleanup();
    }
    {
      const p = setupBase();
      gitOut(p.dir, "checkout", "-q", "--detach");
      const x = await run(p, ["--title", "t"], { cwd: p.dir });
      eq("brw-pr-handoff/1.4 detached HEAD では、ブランチを確定できない理由と手順を示して止まり、書き込みは 0", [x.code, x.err.includes("detached HEAD"), x.err.includes("ブランチ"), p.fake.writeCount], [1, true, true, 0]);
      p.cleanup();
    }
  } finally {
    for (const [k, v] of [["GIT_SSH_COMMAND", saved.cmd], ["GIT_SSH_VARIANT", saved.variant], ["BRW_TEST_BARE", saved.bare]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(sshDir, { recursive: true, force: true });
  }
};
