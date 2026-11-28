// Git 操作と完了公開の統合・回帰テスト（brw-enforcement 8.1）。selftest.mjs から呼ばれる（単独実行も可）。
// 実際の scripts/brw.mjs と scripts/agent-hooks.mjs を子プロセスとして spawn し、次の要素で端から端まで確かめる:
//   - 一時リポジトリと bare remote（origin は GitHub の形の URL。ssh の試験用スクリプトで bare remote へ送る）
//   - 偽の gh（tests/support/gh-shim.mjs を PATH の先頭に置く）。GitHub へは通信しない
//   - 書き込み件数: 偽 gh の要求ログ（GET・HEAD 以外）と、ssh の受け取り（git-receive-pack）の呼び出し回数
// 利用者の ~/.claude・~/.codex・~/.gitconfig には触れない（子プロセスの HOME と Git の設定を一時の場所へ向ける）。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as publish from "../scripts/publish.mjs";
import { gitOut, mkRepoWithRemote } from "./support/git-fixture.mjs";
import { hookInput } from "./support/hook-fixtures.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const BRW = join(here, "../scripts/brw.mjs");
const HOOKS = join(here, "../scripts/agent-hooks.mjs");
const SHIM = join(here, "support/gh-shim.mjs");
const GH_SSH = "git@github.com:acme/app.git";
const REPO_KEY = "GET /repos/acme/app";
// 既存 PR の照合は、head だけで絞る一覧と、head・base で絞る一覧の 2 つを読む（publish-pr の existingPr と findOpenPull）
const LIST = "GET /repos/acme/app/pulls?state=open&head=acme:dev/foo&per_page=100";
const FILTERED = "GET /repos/acme/app/pulls?state=open&head=acme:dev/foo&base=main&per_page=100";
const DONE = "依頼の完了条件を満たした";
const VERIFY = "npm test が成功";
const TITLE = "統合テストの PR";
const CONFIG = { workBranches: ["dev/*"], protectedBranches: ["main"], baseBranch: "develop" };
// 試験用 ssh。受け取り（git-receive-pack）と取得の呼び出しを 1 行ずつ記録し、対象の GitHub パスを bare remote へ置き換える
const FAKE_SSH = `#!/bin/sh
printf '%s\\n' "$2" >> "$BRW_TEST_SSHLOG"
cmd=$(printf '%s' "$2" | sed "s#acme/app.git#$BRW_TEST_BARE#")
exec sh -c "$cmd"
`;

/** 応答の PR（head の OID は指定の値）。publish-pr の照合（OID・base・head・リポジトリ）を通る形。 */
const PR = (sha, over = {}) => ({
  number: 7,
  html_url: "https://github.com/acme/app/pull/7",
  state: "open",
  draft: false,
  base: { ref: "main", repo: { id: 4242, full_name: "acme/app" } },
  head: { ref: "dev/foo", sha, repo: { id: 4242, full_name: "acme/app" } },
  ...over,
});

/** 既定の経路（リポジトリの確認と既存 PR なし）。必要な経路は routes で足す。 */
const baseRoutes = (routes = {}) => ({
  [REPO_KEY]: { status: 200, body: { id: 4242, full_name: "acme/app" } },
  [LIST]: { status: 200, body: [] },
  [FILTERED]: { status: 200, body: [] },
  ...routes,
});

/** 偽 gh の要求ログを読む（無ければ空）。 */
const linesOf = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []);
const ghLogOf = (repo) => linesOf(repo.ghLog).map((l) => JSON.parse(l));
/** GitHub への書き込み（GET・HEAD 以外）の件数。拒否された要求も数える。 */
const writesOf = (repo) => ghLogOf(repo).filter((e) => e.method && !["GET", "HEAD"].includes(e.method)).length;
/** 作成された PR の件数（POST /pulls が実際に適用された回数）。 */
const prAppliedOf = (repo) => ghLogOf(repo).filter((e) => e.method === "POST" && e.path.startsWith("/repos/acme/app/pulls") && e.applied).length;
const prPostsOf = (repo) => ghLogOf(repo).filter((e) => e.method === "POST" && e.path.startsWith("/repos/acme/app/pulls")).length;
const unexpectedOf = (repo) => ghLogOf(repo).filter((e) => e.unexpected).length;
/** 遠隔への受け取り（push）の試行回数。拒否された試行も数える。 */
const pushesOf = (repo) => linesOf(repo.sshLog).filter((l) => l.includes("git-receive-pack")).length;

export const runIntegrationPublishChecks = async (eq) => {
  const sandbox = mkdtempSync(join(tmpdir(), "brw-int-"));
  const bin = join(sandbox, "bin");
  const home = join(sandbox, "home");
  mkdirSync(bin);
  mkdirSync(home);
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nexec node "${SHIM}" "$@"\n`, { mode: 0o755 });
  const sshPath = join(sandbox, "fake-ssh.sh");
  writeFileSync(sshPath, FAKE_SSH, { mode: 0o755 });
  const repos = [];
  let seq = 0;

  /** 偽 gh の設定ファイルを作り、そのパスを返す。 */
  const ghCfg = ({ scenario = "success", routes = {} } = {}) => {
    const p = join(sandbox, `gh-${++seq}.json`);
    writeFileSync(p, JSON.stringify({ scenario, routes: baseRoutes(routes) }));
    return p;
  };
  const defaultGh = ghCfg();

  /** 子プロセスの環境。PATH の先頭に偽 gh、ssh は試験用、HOME と Git の設定は一時の場所。 */
  const envOf = (repo, gh) => ({
    ...process.env,
    HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    PATH: `${bin}:${process.env.PATH}`,
    GH_TOKEN: "test-token-int",
    BRW_NO_GH: "1",
    GIT_SSH_COMMAND: sshPath,
    GIT_SSH_VARIANT: "simple",
    BRW_TEST_BARE: repo.remote,
    BRW_TEST_SSHLOG: repo.sshLog,
    BRW_GH_SHIM_CONFIG: gh ?? repo.gh,
    BRW_GH_SHIM_LOG: repo.ghLog,
  });
  /** brw.mjs を実際に spawn する。 */
  const brw = (repo, args, { gh, stdin } = {}) => spawnSync("node", [BRW, ...args], { cwd: repo.dir, encoding: "utf8", env: envOf(repo, gh), input: stdin });
  /** git を実行する（origin の push は ssh の試験用スクリプトを通る）。失敗は例外。 */
  const git = (repo, cwd, ...args) => {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: envOf(repo) });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} が失敗: ${r.stderr}`);
    return r.stdout.trim();
  };
  /** 遠隔（bare）の ref の OID。無ければ null。 */
  const remoteRef = (repo, branch) => {
    const r = spawnSync("git", ["rev-parse", "--verify", "-q", `refs/heads/${branch}`], { cwd: repo.remote, encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : null;
  };
  /** 利用者（または別の作業者）が直接 bare remote へ push する。BRW の外側の操作として扱う。 */
  const otherPush = (repo, branch, fn) => {
    const tmp = mkdtempSync(join(sandbox, "other-"));
    gitOut(sandbox, "clone", "-q", "-b", branch, repo.remote, tmp);
    fn(tmp);
    gitOut(tmp, "push", "-q", "origin", branch);
    return gitOut(tmp, "rev-parse", "HEAD");
  };

  /**
   * 宣言つきの一時リポジトリを作る。origin は GitHub の形の URL にし、既定では dev/foo にいる。
   * develop: true なら develop（baseBranch）を作って push し、そこから branch を切る。
   * recorded: 取り込み先（branch.<名前>.brwBase）。既定は保護ブランチ main（PR を伴う）。
   */
  const newRepo = ({ branch = "dev/foo", config = CONFIG, configPath, develop = false, recorded = "main" } = {}) => {
    const r = mkRepoWithRemote({ branch: develop ? "develop" : "main", config, ...(configPath ? { configPath } : {}) });
    if (develop) gitOut(r.dir, "push", "-q", "origin", "develop");
    if (branch !== (develop ? "develop" : "main")) gitOut(r.dir, "checkout", "-q", "-b", branch);
    gitOut(r.dir, "remote", "set-url", "origin", GH_SSH);
    if (recorded) gitOut(r.dir, "config", `branch.${branch}.brwBase`, recorded);
    const repo = { dir: r.dir, remote: r.remote, cleanup: r.cleanup, sshLog: join(sandbox, `ssh-${++seq}.log`), ghLog: join(sandbox, `gh-log-${seq}.log`), gh: defaultGh };
    repos.push(repo);
    return repo;
  };
  /** 作業を開始して作業 ID を返す（brw work start の標準出力）。 */
  const startWork = (repo, gh) => brw(repo, ["work", "start"], { gh }).stdout.trim();
  /** 準備・計画をして計画 ID を返す。準備か計画が失敗したら各検査が失敗として数える。 */
  const readyAndPlan = (repo, id, { gh, extra = [] } = {}) => {
    const rd = brw(repo, ["work", "ready", "--work", id, "--completion", DONE, "--verification", VERIFY, ...extra], { gh });
    if (rd.status !== 0) return { ready: rd, plan: null, planId: undefined };
    const pl = brw(repo, ["work", "plan", "--work", id], { gh });
    return { ready: rd, plan: pl, planId: pl.stdout.match(/計画 ID: (p-[0-9a-f]+)/)?.[1] };
  };
  const workOf = (repo, id) => publish.readWork(repo.dir, id).work ?? {};
  const commitFile = (repo, name, text) => {
    writeFileSync(join(repo.dir, name), text);
    git(repo, repo.dir, "add", name);
    git(repo, repo.dir, "commit", "-q", "-m", `変更 ${name}`);
    return git(repo, repo.dir, "rev-parse", "HEAD");
  };
  const headOf = (repo) => git(repo, repo.dir, "rev-parse", "HEAD");
  const publishWith = (repo, args, { gh, stdin } = {}) => brw(repo, ["publish", ...args], { gh, stdin });

  try {
    // ================================================================
    // 1. ブランチ操作・片付け・プレビュー・旧宣言（既存の CLI の回帰）
    // ================================================================
    const dev = newRepo({ branch: "develop", develop: true, recorded: null });
    const created = brw(dev, ["create", "int-one"]);
    const wt1 = join(dev.dir, ".worktree/dev-int-one");
    eq("integration/8.1 create は命名規則に従い作業ブランチと worktree を作る", [created.status, existsSync(wt1)], [0, true]);
    writeFileSync(join(wt1, "one.txt"), "1");
    git(dev, wt1, "add", "one.txt");
    git(dev, wt1, "commit", "-q", "-m", "one");
    git(dev, wt1, "push", "-q", "origin", "dev/int-one");
    eq("integration/8.1 作業ブランチの push は遠隔に反映される", remoteRef(dev, "dev/int-one") === git(dev, wt1, "rev-parse", "HEAD"), true);
    // 作業ブランチを一度外し、遠隔から再開する（resume）
    git(dev, dev.dir, "worktree", "remove", "--force", wt1);
    git(dev, dev.dir, "branch", "-D", "dev/int-one");
    // resume は 6.5 まで旧置き場に作るため、resume の結果の確認は旧置き場のパスを使う（create の配置先は .worktree/）
    const resumed = brw(dev, ["resume", "dev/int-one"]);
    const resumedWt = join(dev.dir, ".claude/worktrees/dev-int-one");
    eq("integration/8.1 resume は遠隔の commit を持つ worktree を作り直す", [resumed.status, existsSync(resumedWt), git(dev, resumedWt, "log", "-1", "--format=%s")], [0, true, "one"]);
    const created2 = brw(dev, ["create", "int-two"]);
    const wt2 = join(dev.dir, ".worktree/dev-int-two");
    writeFileSync(join(wt2, "two.txt"), "2");
    git(dev, wt2, "add", "two.txt");
    git(dev, wt2, "commit", "-q", "-m", "two");
    // 取り込み先は現在の worktree のブランチ（dev/int-two）。開発ブランチ同士の取り込みは GitHub に触れない
    const merged = brw({ ...dev, dir: wt2 }, ["merge", "dev/int-one"]);
    eq("integration/8.1 merge は開発ブランチ同士をローカルで取り込み、PR を作らない", [created2.status, merged.status, existsSync(join(wt2, "one.txt")), writesOf(dev)], [0, 0, true, 0]);
    // 取り込み先（develop）へ取り込んだ後、片付け（finish）を行う
    git(dev, dev.dir, "merge", "--no-ff", "-q", "-m", "取り込み", "dev/int-one");
    git(dev, dev.dir, "push", "-q", "origin", "develop");
    const finished = brw(dev, ["finish", "dev/int-one"]);
    eq("integration/8.1 切り出し元へ取り込み済みの作業は finish で片付く", [finished.status, existsSync(wt1)], [0, false]);
    eq("integration/8.1 開発ブランチ作業で GitHub への書き込みは発生しない", writesOf(dev), 0);

    // 旧パスだけの宣言（既存の導入先）も読み込み、検査が通る
    const legacy = newRepo({ branch: "dev/legacy", configPath: ".claude/branch-release-workflow.json" });
    eq("integration/8.1 旧パスの宣言だけのリポジトリで整合検査が通る", brw(legacy, ["check", "--branches-only"]).status, 0);
    // プレビュー（url-template）と配備の雛形が既存どおり出力される
    const preview = newRepo({ branch: "dev/foo", config: { ...CONFIG, preview: { provider: "url-template", urlTemplate: "https://{alias}.example.com" } } });
    const url = brw(preview, ["url", "dev/foo"]);
    eq("integration/8.1 プレビュー URL を既存の provider で表示する", [url.status, url.stdout.includes("example.com")], [0, true]);
    // url-template には workflow の雛形が無いため、既存どおり雛形を出さず理由を示す（終了コード 1）
    const gw = brw(preview, ["gen-workflow", "preview"]);
    eq("integration/8.1 雛形の無い provider では gen-workflow は理由を示して終了コード 1", [gw.status, gw.stderr.includes("workflow 雛形がありません")], [1, true]);

    // ================================================================
    // 2. 調査のみ・中断・別作業・準備前の呼び出し（PR は作られず、作業は保たれる）
    // ================================================================
    const inv = newRepo({ branch: "dev/foo" });
    const id1 = startWork(inv, defaultGh);
    eq("integration/8.1 work start は作業 ID を 1 つだけ出力する", /^w-[a-z0-9]+-[0-9a-f]{8}$/.test(id1), true);
    // 準備前の plan と publish は拒否される（PR も push も行わない）
    const planEarly = brw(inv, ["work", "plan", "--work", id1]);
    const pubEarly = publishWith(inv, ["--work", id1, "--plan", "p-0000000000", "--title", TITLE]);
    eq("integration/8.1 準備前の plan は拒否される", [planEarly.status, planEarly.stderr.includes("準備済みの記録がありません")], [1, true]);
    eq("integration/8.1 準備前の publish は拒否される", [pubEarly.status, pubEarly.stderr.includes("準備済みの記録がありません")], [1, true]);
    eq("integration/8.1 準備前の呼び出しで GitHub への書き込みは 0 件、遠隔への push も 0 回", [writesOf(inv), pushesOf(inv)], [0, 0]);
    // 未コミットの作業は残り、commit しても push されない
    writeFileSync(join(inv.dir, "wip.txt"), "途中");
    eq("integration/8.1 未コミットの作業は残る", readFileSync(join(inv.dir, "wip.txt"), "utf8"), "途中");
    const headBefore = commitFile(inv, "keep.txt", "保持");
    eq("integration/8.1 commit した作業はローカルに残り、遠隔には ref が無い", [git(inv, inv.dir, "log", "-1", "--format=%s"), remoteRef(inv, "dev/foo")], ["変更 keep.txt", null]);
    // 中断: 理由を残して止める。以後の plan は拒否され、書き込みは発生しない
    const paused = brw(inv, ["pause", "--work", id1, "--reason", "途中で止める"]);
    eq("integration/8.1 pause は作業を中断し、理由を記録する", [paused.status, workOf(inv, id1).pausedReason], [0, "途中で止める"]);
    const planPaused = brw(inv, ["work", "plan", "--work", id1]);
    eq("integration/8.1 中断中の作業は計画できない", planPaused.status, 1);
    // 同じセッション・同じ HEAD で別の作業を始めても、前の作業の状態を引き継がない
    const id2 = startWork(inv, defaultGh);
    eq("integration/8.1 別の作業は別の作業 ID を持ち、中断した作業の状態を保つ", [id2 !== id1, workOf(inv, id1).pausedReason, workOf(inv, id2).status], [true, "途中で止める", "inProgress"]);
    const restricted = brw(inv, ["work", "restrict", "--work", id2, "--no-push"]);
    const id3 = startWork(inv, defaultGh);
    const r3 = workOf(inv, id3).restrictions ?? {};
    eq("integration/8.1 前の作業の禁止は次の作業へ引き継がれない", [restricted.status, workOf(inv, id2).restrictions?.noPush, !!r3.noPush, !!r3.noPr], [0, true, false, false]);
    eq("integration/8.1 調査・中断・別作業の間も GitHub への書き込みと push は 0 件", [writesOf(inv), pushesOf(inv), remoteRef(inv, "dev/foo")], [0, 0, null]);
    eq("integration/8.1 作業ツリーと未コミットの変更は残ったまま", [existsSync(join(inv.dir, "wip.txt")), git(inv, inv.dir, "rev-parse", "HEAD") === headBefore], [true, true]);

    // ================================================================
    // 3. 遠隔の変更・禁止と通常確認待ち・push 後の PR 失敗と再試行
    // ================================================================
    // 3a. 遠隔 ref が別の OID へ進んでいる（期待の OID と違う）。push は拒否され、遠隔の変更は上書きしない
    const ahead = newRepo({ branch: "dev/foo", recorded: "dev/integ" });
    commitFile(ahead, "base.txt", "基点");
    git(ahead, ahead.dir, "push", "-q", "origin", "dev/foo");
    const ahead0 = headOf(ahead);
    const idA = startWork(ahead, defaultGh);
    const headA = commitFile(ahead, "a.txt", "a");
    const otherA = otherPush(ahead, "dev/foo", (tmp) => { writeFileSync(join(tmp, "x.txt"), "他"); gitOut(tmp, "add", "x.txt"); gitOut(tmp, "commit", "-q", "-m", "他者の変更"); });
    eq("integration/8.1 別の作業者が ref を進めた状態を作れる（自分の commit と別 OID）", [otherA !== headA, otherA !== ahead0], [true, true]);
    const planA = readyAndPlan(ahead, idA);
    eq("integration/8.1 準備と計画は通る（push のみ計画に入る）", [planA.ready.status, planA.plan?.status, typeof planA.planId], [0, 0, "string"]);
    // 準備の前に行った基点の push は数えない（この公開で増えた試行だけを見る）
    const pushesA0 = pushesOf(ahead);
    const pubA = publishWith(ahead, ["--work", idA, "--plan", planA.planId]);
    eq("integration/8.1 遠隔が別の OID のとき push は拒否され、遠隔の ref を書き換えない", [pubA.status, remoteRef(ahead, "dev/foo") === otherA], [1, true]);
    eq("integration/8.1 遠隔の食い違いでは push を 1 回だけ試み、PR は作らない", [pushesOf(ahead) - pushesA0, prPostsOf(ahead), writesOf(ahead)], [1, 0, 0]);

    // 3b. 禁止（noPush）: 計画から push が外れ、実行しても遠隔へ送らない
    const np = newRepo({ branch: "dev/foo", recorded: "dev/integ" });
    const idN = startWork(np, defaultGh);
    commitFile(np, "n.txt", "n");
    const restrictN = brw(np, ["work", "restrict", "--work", idN, "--no-push"]);
    const planN = readyAndPlan(np, idN);
    const pubN = planN.planId ? publishWith(np, ["--work", idN, "--plan", planN.planId]) : { status: -1, stderr: "" };
    eq("integration/8.1 push 禁止の作業は計画に push を含めず、公開は拒否される", [restrictN.status, planN.plan?.stdout.includes("実行しない: push（禁止されている）"), pubN.status, workOf(np, idN).results?.push?.outcome], [0, true, 1, "prohibited"]);
    eq("integration/8.1 push 禁止の作業で遠隔への push も GitHub への書き込みも 0 件", [pushesOf(np), writesOf(np), remoteRef(np, "dev/foo")], [0, 0, null]);

    // 3c. 禁止（noPr）: 保護対象への取り込みで push は行うが、PR は作らない
    const nr = newRepo({ branch: "dev/foo", recorded: "main" });
    const idR = startWork(nr, defaultGh);
    const headR = commitFile(nr, "r.txt", "r");
    brw(nr, ["work", "restrict", "--work", idR, "--no-pr"]);
    const planR = readyAndPlan(nr, idR);
    const pubR = planR.planId ? publishWith(nr, ["--work", idR, "--plan", planR.planId, "--title", TITLE]) : { status: -1, stderr: "" };
    eq("integration/8.1 PR 禁止は計画で PR を外し、push は 1 回だけ成功する", [planR.plan?.stdout.includes("実行しない: PR 作成（禁止されている）"), pushesOf(nr), remoteRef(nr, "dev/foo") === headR], [true, 1, true]);
    eq("integration/8.1 PR 禁止の作業で PR の書き込みは 0 件、終了コードは 1（作業は公開済みにならない）", [pubR.status, prPostsOf(nr), workOf(nr, idR).status], [1, 0, "pushed"]);

    // 3d. 通常確認待ち（autoApprove.push: false）: 通常の push は実行せず、エージェントの --confirmed も受け付けない
    const ask = newRepo({ branch: "dev/foo", recorded: "dev/integ", config: { ...CONFIG, autoApprove: { push: false } } });
    const idP = startWork(ask, defaultGh);
    commitFile(ask, "p.txt", "p");
    const planP = readyAndPlan(ask, idP);
    const pubP = planP.planId ? publishWith(ask, ["--work", idP, "--plan", planP.planId]) : { status: -1, stderr: "" };
    eq("integration/8.1 通常確認待ちの push は実行されず、利用者の確認を求める", [pubP.status, pubP.stderr.includes("利用者が自分の端末で"), pushesOf(ask), remoteRef(ask, "dev/foo")], [1, true, 0, null]);
    const forced = planP.planId ? publishWith(ask, ["--work", idP, "--plan", planP.planId, "--confirmed"]) : { status: -1, stderr: "" };
    eq("integration/8.1 非対話の --confirmed は push せず終了コード 1（本番の既定の TTY 判定）", [forced.status, pushesOf(ask), writesOf(ask), remoteRef(ask, "dev/foo")], [1, 0, 0, null]);

    // 3e. push 成功後の PR 失敗（403）→ 同じ作業 ID と計画で再試行。PR は 1 件だけ作られる
    const retry = newRepo({ branch: "dev/foo", recorded: "main" });
    const idT = startWork(retry, defaultGh);
    const headT = commitFile(retry, "t.txt", "t");
    const planT = readyAndPlan(retry, idT);
    const denied = ghCfg({ scenario: "permission" });
    const pubT1 = publishWith(retry, ["--work", idT, "--plan", planT.planId, "--title", TITLE], { gh: denied });
    eq("integration/8.1 push 成功後に PR が 403 で失敗したら、終了コード 1 で途中結果（push 成功）を残す", [pubT1.status, pushesOf(retry), remoteRef(retry, "dev/foo") === headT, workOf(retry, idT).results?.push?.outcome, workOf(retry, idT).status], [1, 1, true, "success", "pushed"]);
    eq("integration/8.1 PR の作成は 1 回試みられ、適用されない（403）", [prPostsOf(retry), prAppliedOf(retry)], [1, 0]);
    const okGh = ghCfg({ scenario: "success", routes: { "POST /repos/acme/app/pulls": { status: 201, body: PR(headT) } } });
    const pubT2 = publishWith(retry, ["--work", idT, "--plan", planT.planId, "--title", TITLE], { gh: okGh });
    eq("integration/8.1 同じ作業 ID で再試行すると、push は繰り返さず PR を 1 件作る", [pubT2.status, pushesOf(retry), prPostsOf(retry), prAppliedOf(retry)], [0, 1, 2, 1]);
    eq("integration/8.1 再試行の結果は PR の URL と取り込み先を示す", [pubT2.stdout.includes("https://github.com/acme/app/pull/7"), workOf(retry, idT).status], [true, "published"]);

    // 3f. 応答喪失（PR は作られたが応答が届かない）→ 再試行で既存の PR を再利用し、重複しない
    const lostRepo = newRepo({ branch: "dev/foo", recorded: "main" });
    const idL = startWork(lostRepo, defaultGh);
    const headL = commitFile(lostRepo, "l.txt", "l");
    const planL = readyAndPlan(lostRepo, idL);
    const lost = ghCfg({ scenario: "lost", routes: { "POST /repos/acme/app/pulls": { status: 201, body: PR(headL) } } });
    const pubL1 = publishWith(lostRepo, ["--work", idL, "--plan", planL.planId, "--title", TITLE], { gh: lost });
    eq("integration/8.1 応答喪失の PR は失敗として返り、作業は公開済みにならない", [pubL1.status, prPostsOf(lostRepo), workOf(lostRepo, idL).status], [1, 1, "pushed"]);
    const reuse = ghCfg({ scenario: "success", routes: { [LIST]: { status: 200, body: [PR(headL)] }, [FILTERED]: { status: 200, body: [PR(headL)] } } });
    const pubL2 = publishWith(lostRepo, ["--work", idL, "--plan", planL.planId, "--title", TITLE], { gh: reuse });
    eq("integration/8.1 再試行は既存の PR を再利用し、新しい PR を作らない（POST は 1 回のまま）", [pubL2.status, prPostsOf(lostRepo), pushesOf(lostRepo), pubL2.stdout.includes("既存の PR を再利用")], [0, 1, 1, true]);

    // 3g. push 成功後に遠隔 ref が別の OID へ進んだ状態での再試行（PR を作らない）
    const drift = newRepo({ branch: "dev/foo", recorded: "main" });
    const idD = startWork(drift, defaultGh);
    const headD = commitFile(drift, "d.txt", "d");
    const planD = readyAndPlan(drift, idD);
    publishWith(drift, ["--work", idD, "--plan", planD.planId, "--title", TITLE], { gh: ghCfg({ scenario: "permission" }) });
    const otherD = otherPush(drift, "dev/foo", (tmp) => { writeFileSync(join(tmp, "e.txt"), "他"); gitOut(tmp, "add", "e.txt"); gitOut(tmp, "commit", "-q", "-m", "他者の追記"); });
    const postsBefore = prPostsOf(drift);
    const pubD = publishWith(drift, ["--work", idD, "--plan", planD.planId, "--title", TITLE], { gh: ghCfg({ scenario: "success", routes: { "POST /repos/acme/app/pulls": { status: 201, body: PR(headD) } } }) });
    eq("integration/8.1 遠隔が進んだ状態の再試行は失敗し、遠隔の ref を上書きせず PR も作らない", [pubD.status, remoteRef(drift, "dev/foo") === otherD, prPostsOf(drift) - postsBefore], [1, true, 0]);

    // ================================================================
    // 4. フックと CLI の端から端（Claude・Codex の合成イベント）
    // ================================================================
    const hook = (repo, host, event, o = {}) => spawnSync("node", [HOOKS, host, event], {
      cwd: repo.dir,
      encoding: "utf8",
      env: envOf(repo),
      input: JSON.stringify(hookInput(host, event, { cwd: repo.dir, ...o })),
    });
    // 応答の形: PreToolUse は hookSpecificOutput.permissionDecision、PermissionRequest は decision.behavior
    const preDecision = (r) => JSON.parse(r.stdout || "{}").hookSpecificOutput?.permissionDecision ?? null;
    const claudeDecision = preDecision;
    const codexDecision = (r) => JSON.parse(r.stdout || "{}").hookSpecificOutput?.decision?.behavior ?? null;
    const hookRepo = newRepo({ branch: "dev/foo", recorded: "main" });
    const mainRepo = newRepo({ branch: "main", recorded: null });

    // 保護ブランチへの直接の commit・push は拒否される（各ホストの応答の形）
    eq("integration/8.1 Claude: 保護ブランチへの commit は deny", claudeDecision(hook(mainRepo, "claude", "PreToolUse", { command: "git commit -m x" })), "deny");
    eq("integration/8.1 Codex: 保護ブランチへの commit は deny（PreToolUse）", preDecision(hook(mainRepo, "codex", "PreToolUse", { command: "git commit -m x" })), "deny");
    eq("integration/8.1 Claude: 保護ブランチの HEAD への push は deny", claudeDecision(hook(hookRepo, "claude", "PreToolUse", { command: "git push origin HEAD:main" })), "deny");
    eq("integration/8.1 Codex: 保護ブランチの ref への push は deny（PreToolUse）", preDecision(hook(hookRepo, "codex", "PreToolUse", { command: "git push origin dev/foo:refs/heads/main" })), "deny");
    // 開発ブランチへの通常 push は確認省略（allow）。Codex は PermissionRequest で allow を返す
    eq("integration/8.1 Claude: 開発ブランチへの通常 push は allow（確認省略）", claudeDecision(hook(hookRepo, "claude", "PreToolUse", { command: "git push -u origin dev/foo" })), "allow");
    eq("integration/8.1 Codex: 開発ブランチへの通常 push は PermissionRequest で allow", codexDecision(hook(hookRepo, "codex", "PermissionRequest", { command: "git push -u origin dev/foo" })), "allow");
    // GitHub のマージと自動マージ予約は拒否される（gh・gh api・MCP）
    eq("integration/8.1 Claude: gh pr merge は deny", claudeDecision(hook(hookRepo, "claude", "PreToolUse", { command: "gh pr merge 7 --squash" })), "deny");
    eq("integration/8.1 Claude: gh pr merge --auto（自動マージ予約）は deny", claudeDecision(hook(hookRepo, "claude", "PreToolUse", { command: "gh pr merge 7 --auto --squash" })), "deny");
    eq("integration/8.1 Codex: gh api による merge は deny（PreToolUse）", preDecision(hook(hookRepo, "codex", "PreToolUse", { command: "gh api repos/acme/app/pulls/7/merge -X PUT" })), "deny");
    eq("integration/8.1 Claude: MCP の PR マージは deny", claudeDecision(hook(hookRepo, "claude", "PreToolUse", { tool: "mcp__github__merge_pull_request", toolInput: { owner: "acme", repo: "app", pullNumber: 7 } })), "deny");
    eq("integration/8.1 Codex: MCP の PR マージは deny（PreToolUse）", preDecision(hook(hookRepo, "codex", "PreToolUse", { tool: "mcp__github__merge_pull_request", toolInput: { owner: "acme", repo: "app", pullNumber: 7 } })), "deny");
    eq("integration/8.1 フックは GitHub へ通信せず、書き込みも 0 件", [writesOf(hookRepo), unexpectedOf(hookRepo)], [0, 0]);
  } finally {
    for (const r of repos) r.cleanup();
    rmSync(sandbox, { recursive: true, force: true });
  }
};

// 単独実行（node tests/integration-publish.mjs）。selftest.mjs と同じく失敗があれば終了コード 1
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
if (isMain) {
  let failed = 0;
  const eq = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n     got : ${JSON.stringify(got)}\n     want: ${JSON.stringify(want)}`}`);
  };
  await runIntegrationPublishChecks(eq);
  console.log(failed ? `\n${failed} 件失敗` : "\nすべて成功");
  process.exit(failed ? 1 : 0);
}
