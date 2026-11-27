// 分岐元（develop）からの PR の統合試験（brw-pr-handoff 8.1）。selftest.mjs から呼ばれる（単独実行も可）。
// 実際の scripts/brw.mjs と scripts/agent-hooks.mjs を子プロセスとして spawn し、次の要素で端から端まで確かめる:
//   - 一時リポジトリと bare remote（origin は GitHub の形の URL。試験用 ssh が bare remote へ向ける）
//   - 偽の gh（tests/support/gh-shim.mjs を PATH の先頭に置く）。GitHub へは通信しない
//   - 書き込みの件数: 偽 gh の要求ログ（GET・HEAD 以外）と、ssh の受け取り（git-receive-pack）の呼び出し回数
//   - 各 brw pr の前後の全体の状態（snapshotOf）: HEAD・commit 数・ローカルの全ブランチ・遠隔の全 ref・状態ファイル・worktree の登録
// 試験の実行中は HOME と Git の設定を一時の場所へ隔離する（fixture と otherPush の Git 操作も同じ環境を継承する）。終了時に元へ戻す。
// 一時ディレクトリ（brw-fx-*・brw-int-bpr-*）は実行の前後で増えないことを確かめる。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitOut, mkRepoWithRemote } from "./support/git-fixture.mjs";
import { hookInput } from "./support/hook-fixtures.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const BRW = join(here, "../scripts/brw.mjs");
const HOOKS = join(here, "../scripts/agent-hooks.mjs");
const SHIM = join(here, "support/gh-shim.mjs");
const GH_SSH = "git@github.com:acme/app.git";
const REPO_KEY = "GET /repos/acme/app";
// 既存 PR の照合は、head だけで絞る一覧と、head・base で絞る一覧の 2 つを読む（base-pr と同じ経路）
const LIST = "GET /repos/acme/app/pulls?state=open&head=acme:develop&per_page=100";
const FILTERED = "GET /repos/acme/app/pulls?state=open&head=acme:develop&base=main&per_page=100";
const POST = "POST /repos/acme/app/pulls";
const PR_URL = "https://github.com/acme/app/pull/7";
const TITLE = "分岐元からの PR の統合試験";
const BODY = "## 概要\n分岐元からの PR の統合試験の本文\n";
const CONFIG = { workBranches: ["dev/*"], protectedBranches: ["main"], baseBranch: "develop" };
const HOOK_PREFIX = "[branch-release-workflow] ";
// 片付けが行われていないこと: [作業の記録（状態ファイル）が無い, worktree が対象のパスとブランチで登録されている, 作業場所のディレクトリがある]
const KEPT = [false, true, true];
// 試験の実行中に隔離する環境変数（実行の後で元へ戻す）
const ISO_KEYS = ["HOME", "XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT"];
// 試験用 ssh。受け取り（git-receive-pack）と取得の呼び出しを 1 行ずつ記録し、対象の GitHub パスを bare remote へ置き換える
const FAKE_SSH = `#!/bin/sh
printf '%s\\n' "$2" >> "$BRW_TEST_SSHLOG"
cmd=$(printf '%s' "$2" | sed "s#acme/app.git#$BRW_TEST_BARE#")
exec sh -c "$cmd"
`;

/** 応答の PR（head の OID は指定の値）。publish-pr の照合（OID・base・head・リポジトリ）を通る形。 */
const PR = (sha) => ({
  number: 7,
  html_url: PR_URL,
  state: "open",
  draft: false,
  base: { ref: "main", repo: { id: 4242, full_name: "acme/app" } },
  head: { ref: "develop", sha, repo: { id: 4242, full_name: "acme/app" } },
});
const ok = (body) => ({ status: 200, body });
const created = (body) => ({ status: 201, body });

/** 既定の経路（リポジトリの確認と既存 PR なし）。 */
const baseRoutes = () => ({
  [REPO_KEY]: ok({ id: 4242, full_name: "acme/app" }),
  [LIST]: ok([]),
  [FILTERED]: ok([]),
});

const linesOf = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []);
const ghLogOf = (r) => linesOf(r.ghLog).map((l) => JSON.parse(l));
/** GitHub への書き込み（GET・HEAD 以外）の件数。拒否された要求も数える。 */
const writesOf = (r) => ghLogOf(r).filter((e) => e.method && !["GET", "HEAD"].includes(e.method)).length;
/** PR の作成の要求（試行）と、実際に適用されたもの。 */
const postsOf = (r) => ghLogOf(r).filter((e) => e.method === "POST" && e.path === "/repos/acme/app/pulls");
const appliedPostsOf = (r) => postsOf(r).filter((e) => e.applied);
/** 遠隔への受け取り（push）の試行回数。取得（git-upload-pack）は数えない。 */
const pushesOf = (r) => linesOf(r.sshLog).filter((l) => l.includes("git-receive-pack")).length;
const sshCountOf = (r) => linesOf(r.sshLog).length;
/** 一時ディレクトリの残り（試験が作る brw-fx-*・brw-int-bpr-*）の数。tmpdir() と /tmp の両方を数える。 */
const tmpLeftovers = () => [tmpdir(), "/tmp"].map((d) => readdirSync(d).filter((n) => n.startsWith("brw-fx-") || n.startsWith("brw-int-bpr-")).length);

export const runIntegrationBasePrChecks = async (eq) => {
  const tmpBefore = tmpLeftovers();
  const sandbox = mkdtempSync(join(tmpdir(), "brw-int-bpr-"));
  const bin = join(sandbox, "bin");
  const home = join(sandbox, "home");
  mkdirSync(bin);
  mkdirSync(home);
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nexec node "${SHIM}" "$@"\n`, { mode: 0o755 });
  const sshPath = join(sandbox, "fake-ssh.sh");
  writeFileSync(sshPath, FAKE_SSH, { mode: 0o755 });
  const repos = [];
  let seq = 0;

  // 試験の実行中の Git 操作（fixture と otherPush を含む）は、利用者の HOME と Git の設定を読まない
  const savedEnv = Object.fromEntries(ISO_KEYS.map((k) => [k, process.env[k]]));
  Object.assign(process.env, {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  });

  /** 偽 gh の設定ファイルを作り、そのパスを返す。routes は既定の経路に足す（同じキーは置き換える）。 */
  const ghCfg = (routes = {}) => {
    const p = join(sandbox, `gh-${++seq}.json`);
    writeFileSync(p, JSON.stringify({ scenario: "success", routes: { ...baseRoutes(), ...routes } }));
    return p;
  };

  /** 子プロセスの環境。PATH の先頭に偽 gh、ssh は試験用、HOME と Git の設定は一時の場所。 */
  const envOf = (r, gh) => ({
    ...process.env,
    HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    PATH: `${bin}:${process.env.PATH}`,
    GH_TOKEN: "test-token-int-base-pr",
    BRW_NO_GH: "1",
    GIT_SSH_COMMAND: sshPath,
    GIT_SSH_VARIANT: "simple",
    GIT_TERMINAL_PROMPT: "0",
    BRW_TEST_BARE: r.remote,
    BRW_TEST_SSHLOG: r.sshLog,
    BRW_GH_SHIM_CONFIG: gh ?? r.gh,
    BRW_GH_SHIM_LOG: r.ghLog,
  });
  /** brw.mjs を実際に spawn する。stdin は既定で端末ではないパイプ。 */
  const brw = (r, args, { gh, stdin } = {}) => spawnSync("node", [BRW, ...args], { cwd: r.dir, encoding: "utf8", env: envOf(r, gh), input: stdin });
  /** 利用者の端末とは別の作業者として、bare remote へ push する（BRW の外側の操作）。 */
  const otherPush = (r, branch, fn) => {
    const tmp = mkdtempSync(join(sandbox, "other-"));
    gitOut(sandbox, "clone", "-q", "-b", branch, r.remote, tmp);
    fn(tmp);
    gitOut(tmp, "push", "-q", "origin", branch);
    return gitOut(tmp, "rev-parse", "HEAD");
  };
  /** 遠隔（bare）の ref の OID。無ければ null。 */
  const remoteRef = (r, branch) => {
    const res = spawnSync("git", ["rev-parse", "--verify", "-q", `refs/heads/${branch}`], { cwd: r.remote, encoding: "utf8" });
    return res.status === 0 ? res.stdout.trim() : null;
  };
  /**
   * 作業の全体の状態。各 brw pr の前後で比べる。
   * HEAD・commit 数・ローカルの全ブランチ（refs/heads）・遠隔（bare）の全 ref・受け取りの呼び出し数・状態ファイル・worktree の登録（パスとブランチ）。
   */
  const snapshotOf = (r) => ({
    head: gitOut(r.dir, "rev-parse", "HEAD"),
    commits: gitOut(r.dir, "rev-list", "--count", "HEAD"),
    localRefs: gitOut(r.dir, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"),
    remoteRefs: gitOut(r.remote, "for-each-ref", "--format=%(refname) %(objectname)"),
    receivePacks: pushesOf(r),
    stateFile: existsSync(join(r.dir, ".git", "brw")),
    worktrees: gitOut(r.dir, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ") || l.startsWith("branch ")).join("\n"),
  });
  /** 片付けが行われていないこと: 作業の記録が無い・対象のパスとブランチで worktree が登録されたまま・ディレクトリが残る。 */
  const keptOf = (r, branch) => {
    const registered = gitOut(r.dir, "worktree", "list", "--porcelain").split("\n\n").some((b) => {
      const lines = b.split("\n");
      return lines.includes(`worktree ${r.dir}`) && lines.includes(`branch refs/heads/${branch}`);
    });
    return [existsSync(join(r.dir, ".git", "brw")), registered, existsSync(r.dir)];
  };

  /**
   * 分岐元（develop）の一時リポジトリを作る。main と develop を origin（bare）へ push 済みにし、
   * develop をチェックアウトした状態で返す。withDiff=false なら develop は main と同じ commit（差なし）。
   * `.git/info/exclude` に .claude/ を足し、本文置き場（.claude/worktrees/.brw/）を未コミットの件数に含めない。
   */
  const newBase = ({ config = CONFIG, withDiff = true } = {}) => {
    const fx = mkRepoWithRemote({ branch: "main", config });
    const r = { dir: fx.dir, remote: fx.remote, cleanup: fx.cleanup, sshLog: join(sandbox, `ssh-${++seq}.log`), ghLog: join(sandbox, `gh-log-${seq}.log`), gh: null };
    repos.push(r);
    mkdirSync(join(r.dir, ".git", "info"), { recursive: true });
    writeFileSync(join(r.dir, ".git", "info", "exclude"), ".claude/\n", { flag: "a" });
    gitOut(r.dir, "checkout", "-q", "-b", "develop");
    if (withDiff) {
      writeFileSync(join(r.dir, "d1.txt"), "分岐元の差\n");
      gitOut(r.dir, "add", "d1.txt");
      gitOut(r.dir, "commit", "-q", "-m", "分岐元の差");
    }
    gitOut(r.dir, "push", "-q", "origin", "develop");
    gitOut(r.dir, "remote", "set-url", "origin", GH_SSH);
    r.gh = ghCfg();
    // 以降の子プロセスの取得・push は試験用 ssh を通る。試験の対象の操作だけを数えるため、ここまでの記録を空にする
    writeFileSync(r.sshLog, "");
    writeFileSync(r.ghLog, "");
    return r;
  };
  /** 本文の雛形を用意し、記入済みの内容に置き換える（brw pr-template の既定の置き場）。 */
  const prepareBody = (r) => {
    const t = brw(r, ["pr-template"]);
    if (t.status !== 0) throw new Error(`brw pr-template が失敗: ${t.stderr}`);
    writeFileSync(join(r.dir, ".claude", "worktrees", ".brw", "develop.md"), BODY);
  };
  /** 作成の要求の本文（POST の body）のうち、適用された分だけ。 */
  const appliedBodiesOf = (r) => appliedPostsOf(r).map((e) => e.body);
  /** 直接の PR 作成の拒否の応答（PreToolUse）。 */
  const hook = (r, command) => spawnSync("node", [HOOKS, "claude", "PreToolUse"], {
    cwd: r.dir,
    encoding: "utf8",
    env: envOf(r),
    input: JSON.stringify(hookInput("claude", "PreToolUse", { cwd: r.dir, command })),
  });

  try {
    // ================================================================
    // 1. 分岐元が最新: PR を作成し、URL を報告して終了コード 0。未コミットの件数を表示する
    // ================================================================
    {
      const r = newBase();
      prepareBody(r);
      writeFileSync(join(r.dir, "notes.txt"), "未コミットの作業\n");
      const before = snapshotOf(r);
      const oid = remoteRef(r, "develop");
      const res = brw(r, ["pr", "--title", TITLE], { gh: ghCfg({ [POST]: created(PR(oid)) }) });
      eq("integration/8.1 分岐元が最新: PR を作成し、URL を報告して終了コード 0 にする", [res.status, res.stdout.includes(`PR を作成しました: ${PR_URL}`), res.stdout.includes("取り込み先: main")], [0, true, true]);
      eq("integration/8.1 分岐元が最新: 作成の要求は 1 件で、head=develop・base=main・タイトル・本文が一致する", [postsOf(r).length, appliedBodiesOf(r)], [1, [{ title: TITLE, body: BODY, head: "develop", base: "main" }]]);
      eq("integration/8.1 分岐元が最新: 実行の前後で全体の状態が同じ（別コミットなし・遠隔の全 ref 不変・push 0 件・状態ファイルなし・worktree の登録不変）", snapshotOf(r), before);
      eq("integration/8.1 分岐元が最新: 片付けが行われず（作業の記録なし・ブランチと作業場所が残る）、GitHub への書き込みは作成の 1 件だけ", [keptOf(r, "develop"), writesOf(r)], [KEPT, 1]);
      eq("integration/8.1 分岐元が最新: 未コミットの変更が残り、件数が表示される", [res.stdout.includes("未コミットの変更が 1 件あり、PR には含まれません（commit はしません）。"), gitOut(r.dir, "status", "--porcelain"), readFileSync(join(r.dir, "notes.txt"), "utf8")], [true, "?? notes.txt", "未コミットの作業\n"]);
      r.cleanup();
    }

    // ================================================================
    // 2. リモートが先行: 取り込んで（ff-only）から PR を作る。ローカルの分岐元がリモートの先頭に進む
    // ================================================================
    {
      const r = newBase();
      prepareBody(r);
      const otherHead = otherPush(r, "develop", (tmp) => {
        writeFileSync(join(tmp, "e.txt"), "他者の追記\n");
        gitOut(tmp, "add", "e.txt");
        gitOut(tmp, "commit", "-q", "-m", "他者の追記");
      });
      const before = snapshotOf(r);
      const res = brw(r, ["pr", "--title", TITLE], { gh: ghCfg({ [POST]: created(PR(otherHead)) }) });
      eq("integration/8.1 リモート先行: 分岐元を取り込み、PR を作成して終了コード 0 にする", [res.status, res.stdout.includes("分岐元 develop をリモートの origin/develop に合わせました。"), res.stdout.includes(`PR を作成しました: ${PR_URL}`)], [0, true, true]);
      const after = snapshotOf(r);
      // 取り込みで進むのは develop の ref と HEAD・commit 数だけ。それ以外（他のブランチ・遠隔の全 ref・状態ファイル・worktree の登録・push）は変わらない
      const withoutDevelop = (s) => ({ ...s, head: null, commits: null, localRefs: s.localRefs.split("\n").filter((l) => !l.startsWith("refs/heads/develop ")).join("\n") });
      eq("integration/8.1 リモート先行: 取り込み以外は不変（遠隔の全 ref・状態ファイル・worktree の登録・push 0 件・develop 以外のブランチ）", withoutDevelop(after), withoutDevelop(before));
      eq("integration/8.1 リモート先行: HEAD は遠隔の先頭に進み、取り込んだ commit は他者のまま（別コミットなし）", [after.head === otherHead, gitOut(r.dir, "log", "-1", "--format=%s"), after.commits === String(Number(before.commits) + 1), after.localRefs.includes(`refs/heads/develop ${otherHead}`)], [true, "他者の追記", true, true]);
      eq("integration/8.1 リモート先行: 作成の要求は head=develop の 1 件、遠隔の ref は変わらず、push は 0 件", [appliedBodiesOf(r), remoteRef(r, "develop") === otherHead, pushesOf(r)], [[{ title: TITLE, body: BODY, head: "develop", base: "main" }], true, 0]);
      eq("integration/8.1 リモート先行: 片付けが行われず（作業の記録なし・ブランチと作業場所が残る）", keptOf(r, "develop"), KEPT);
      r.cleanup();
    }

    // ================================================================
    // 3. ローカルが先行（未 push の commit）: 止まる。書き込み 0・HEAD 不変・案内に未 push
    // ================================================================
    {
      const r = newBase();
      prepareBody(r);
      writeFileSync(join(r.dir, "local.txt"), "未 push の変更\n");
      gitOut(r.dir, "add", "local.txt");
      gitOut(r.dir, "commit", "-q", "-m", "未 push の変更");
      const before = snapshotOf(r);
      const res = brw(r, ["pr", "--title", TITLE], { gh: ghCfg({ [POST]: created(PR(before.head)) }) });
      eq("integration/8.1 ローカル先行: 終了コード 1 で止まり、止まった段階と案内（未 push）を示す", [res.status, res.stderr.includes("（止まった段階: sync。"), res.stderr.includes("未 push")], [1, true, true]);
      eq("integration/8.1 ローカル先行: 書き込み 0 件、実行の前後で全体の状態が同じ（HEAD・commit 数・遠隔の全 ref・push 0 件）", [writesOf(r), snapshotOf(r)], [0, before]);
      eq("integration/8.1 ローカル先行: PR を作らず、片付けも行われない（作業の記録なし・ブランチと作業場所が残る）", [postsOf(r).length, keptOf(r, "develop")], [0, KEPT]);
      r.cleanup();
    }

    // ================================================================
    // 4. 分岐: 止まる。書き込み 0・HEAD 不変・分岐は自動で取り込まないと案内する
    // ================================================================
    {
      const r = newBase();
      prepareBody(r);
      writeFileSync(join(r.dir, "local.txt"), "ローカルの変更\n");
      gitOut(r.dir, "add", "local.txt");
      gitOut(r.dir, "commit", "-q", "-m", "ローカルの変更");
      otherPush(r, "develop", (tmp) => {
        writeFileSync(join(tmp, "remote.txt"), "リモートの変更\n");
        gitOut(tmp, "add", "remote.txt");
        gitOut(tmp, "commit", "-q", "-m", "リモートの変更");
      });
      const before = snapshotOf(r);
      const res = brw(r, ["pr", "--title", TITLE], { gh: ghCfg({ [POST]: created(PR(before.head)) }) });
      eq("integration/8.1 分岐: 終了コード 1 で止まり、止まった段階 sync と分岐の案内を示す", [res.status, res.stderr.includes("（止まった段階: sync。"), res.stderr.includes("分岐は自動で取り込みません")], [1, true, true]);
      eq("integration/8.1 分岐: 書き込み 0 件、実行の前後で全体の状態が同じ（HEAD・commit 数・遠隔の全 ref・push 0 件）", [writesOf(r), snapshotOf(r)], [0, before]);
      eq("integration/8.1 分岐: PR を作らず、片付けも行われない（作業の記録なし・ブランチと作業場所が残る）", [postsOf(r).length, keptOf(r, "develop")], [0, KEPT]);
      r.cleanup();
    }

    // ================================================================
    // 5. 差なし（分岐元が保護ブランチと同じ）: 止まる。PR を作らない
    // ================================================================
    {
      const r = newBase({ withDiff: false });
      prepareBody(r);
      const before = snapshotOf(r);
      const res = brw(r, ["pr", "--title", TITLE], { gh: ghCfg({ [POST]: created(PR(before.head)) }) });
      eq("integration/8.1 差なし: 終了コード 1 で止まり、取り込む差が無いと示す", [res.status, res.stderr.includes("（止まった段階: diff。"), res.stderr.includes("取り込む差がありません")], [1, true, true]);
      eq("integration/8.1 差なし: PR を作らず、書き込み 0 件、実行の前後で全体の状態が同じ", [postsOf(r).length, writesOf(r), snapshotOf(r)], [0, 0, before]);
      eq("integration/8.1 差なし: 片付けが行われない（作業の記録なし・ブランチと作業場所が残る）", keptOf(r, "develop"), KEPT);
      r.cleanup();
    }

    // ================================================================
    // 6. 既存の PR の再利用: 同じ head・base のオープンな PR があれば作成せず URL を報告。再実行で重複しない
    // ================================================================
    {
      // 6a. 既存の PR が見つかる場合は、作成せず再利用する
      const r = newBase();
      prepareBody(r);
      const oid = remoteRef(r, "develop");
      const before = snapshotOf(r);
      const res = brw(r, ["pr", "--title", TITLE], { gh: ghCfg({ [LIST]: ok([PR(oid)]), [FILTERED]: ok([PR(oid)]) }) });
      eq("integration/8.1 既存の PR: 作成せず、既存の URL を報告して終了コード 0 にする", [res.status, res.stdout.includes(`PR を再利用しました: ${PR_URL}`)], [0, true]);
      eq("integration/8.1 既存の PR: PR の作成の要求が 0 件で、書き込みも 0 件", [postsOf(r).length, writesOf(r)], [0, 0]);
      eq("integration/8.1 既存の PR: 実行の前後で全体の状態が同じ（別コミット・push・状態ファイルなし・worktree の登録不変）", snapshotOf(r), before);
      eq("integration/8.1 既存の PR: 片付けが行われない（作業の記録なし・ブランチと作業場所が残る）", keptOf(r, "develop"), KEPT);
      r.cleanup();
    }
    {
      // 6b. 再実行: 1 回目で PR を作り、2 回目は既存の PR を見つけて再利用する（作成の要求は増えない）
      const r = newBase();
      prepareBody(r);
      const oid = remoteRef(r, "develop");
      const before = snapshotOf(r);
      const first = brw(r, ["pr", "--title", TITLE], { gh: ghCfg({ [POST]: created(PR(oid)) }) });
      const afterFirst = snapshotOf(r);
      const second = brw(r, ["pr", "--title", TITLE], { gh: ghCfg({ [LIST]: ok([PR(oid)]), [FILTERED]: ok([PR(oid)]), [POST]: created(PR(oid)) }) });
      eq("integration/8.1 再実行: 1 回目は作成、2 回目は再利用して、どちらも終了コード 0", [first.status, first.stdout.includes(`PR を作成しました: ${PR_URL}`), second.status, second.stdout.includes(`PR を再利用しました: ${PR_URL}`)], [0, true, 0, true]);
      eq("integration/8.1 再実行: PR の作成の要求は 1 回だけで、適用も 1 件（重複しない）", [postsOf(r).length, appliedPostsOf(r).length], [1, 1]);
      eq("integration/8.1 再実行: 1 回目の前後で全体の状態が同じ（別コミット・push・状態ファイルなし・worktree の登録不変）", afterFirst, before);
      eq("integration/8.1 再実行: 2 回目の前後でも全体の状態が同じ（別コミット・push・状態ファイルなし・worktree の登録不変）", snapshotOf(r), before);
      eq("integration/8.1 再実行: 片付けが行われない（作業の記録なし・ブランチと作業場所が残る）", keptOf(r, "develop"), KEPT);
      r.cleanup();
    }

    // ================================================================
    // 7. 承認が必要な宣言（autoApprove.pullRequest が false）: PR を作らず、利用者の端末で実行する全文を案内する
    // ================================================================
    {
      const r = newBase({ config: { ...CONFIG, autoApprove: { pullRequest: false } } });
      prepareBody(r);
      const before = snapshotOf(r);
      const res = brw(r, ["pr", "--title", TITLE], { gh: ghCfg({ [POST]: created(PR(before.head)) }) });
      eq("integration/8.1 承認が必要: PR を作らず、終了コード 1 で、--confirmed つきの全文を案内する", [res.status, res.stderr.includes("PR 作成には通常の承認が必要です"), res.stderr.includes(`brw pr --title '${TITLE}'`), res.stderr.includes("--confirmed")], [1, true, true, true]);
      eq("integration/8.1 承認が必要: PR の作成の要求が 0 件、書き込み 0 件、実行の前後で全体の状態が同じ", [postsOf(r).length, writesOf(r), snapshotOf(r)], [0, 0, before]);
      writeFileSync(r.sshLog, "");
      writeFileSync(r.ghLog, "");
      const beforeConfirmed = snapshotOf(r);
      // --confirmed は標準入力が端末のときだけ受け付ける。試験の標準入力は端末ではないので、何もせず拒否する（通信 0）
      const conf = brw(r, ["pr", "--title", TITLE, "--confirmed"], { gh: ghCfg({ [POST]: created(PR(before.head)) }) });
      eq("integration/8.1 承認が必要: --confirmed は端末でなければ拒否し、終了コード 1・通信 0・書き込み 0 にする", [conf.status, conf.stderr.includes("利用者が自分の端末で実行したときだけ有効です"), sshCountOf(r), ghLogOf(r).length, writesOf(r)], [1, true, 0, 0, 0]);
      eq("integration/8.1 承認が必要: --confirmed の拒否の前後で全体の状態が同じ", snapshotOf(r), beforeConfirmed);
      r.cleanup();
    }

    // ================================================================
    // 8. 分岐元以外での brw pr: 理由と手順を示して止まる（書き込み 0・通信 0）
    // ================================================================
    {
      // 8a. 保護ブランチ（main）: 分岐元のチェックアウトを案内する
      const r = newBase();
      gitOut(r.dir, "checkout", "-q", "main");
      const before = snapshotOf(r);
      const res = brw(r, ["pr", "--title", TITLE]);
      eq("integration/8.1 保護ブランチ: 終了コード 1 で、分岐元（develop）のチェックアウトを案内する", [res.status, res.stderr.includes("保護ブランチのため、ここでは PR を作りません"), res.stderr.includes("分岐元（develop）のチェックアウトで brw pr を実行してください。")], [1, true, true]);
      eq("integration/8.1 保護ブランチ: 書き込み 0・通信 0・実行の前後で全体の状態が同じ", [writesOf(r), sshCountOf(r), snapshotOf(r)], [0, 0, before]);
      r.cleanup();
    }
    {
      // 8b. 宣言外のブランチ: 開発ブランチではないと示して止まる
      const r = newBase();
      gitOut(r.dir, "checkout", "-q", "-b", "feature/x");
      const before = snapshotOf(r);
      const res = brw(r, ["pr", "--title", TITLE]);
      eq("integration/8.1 宣言外: 終了コード 1 で、宣言に無いブランチで PR を作らないと示す", [res.status, res.stderr.includes("宣言（workBranches・baseBranch など）に無いブランチ"), res.stderr.includes("brw create")], [1, true, true]);
      eq("integration/8.1 宣言外: 書き込み 0・通信 0・実行の前後で全体の状態が同じ", [writesOf(r), sshCountOf(r), snapshotOf(r)], [0, 0, before]);
      r.cleanup();
    }
    {
      // 8c. detached HEAD: 作業ブランチを確定できないと示して止まる
      const r = newBase();
      gitOut(r.dir, "checkout", "-q", "--detach");
      const before = snapshotOf(r);
      const res = brw(r, ["pr", "--title", TITLE]);
      eq("integration/8.1 detached HEAD: 終了コード 1 で、作業ブランチを確定できないと示す", [res.status, res.stderr.includes("detached HEAD のため、作業ブランチを確定できず")], [1, true]);
      eq("integration/8.1 detached HEAD: 書き込み 0・通信 0・実行の前後で全体の状態が同じ", [writesOf(r), sshCountOf(r), snapshotOf(r)], [0, 0, before]);
      r.cleanup();
    }
    {
      // 8d. main が唯一の分岐元かつ保護ブランチの宣言: 分岐元の案内ではなく、宣言の見直しを案内する
      const r = newBase({ config: { ...CONFIG, baseBranch: "main" } });
      gitOut(r.dir, "checkout", "-q", "main");
      const before = snapshotOf(r);
      const res = brw(r, ["pr", "--title", TITLE]);
      eq("integration/8.1 分岐元が保護ブランチだけの宣言: 終了コード 1 で、宣言を見直す案内を示す", [res.status, res.stderr.includes("宣言（baseBranch・baseBranches・protectedBranches）を見直してください。"), res.stderr.includes("のチェックアウトで brw pr を実行してください")], [1, true, false]);
      eq("integration/8.1 分岐元が保護ブランチだけの宣言: 書き込み 0・通信 0・実行の前後で全体の状態が同じ", [writesOf(r), sshCountOf(r), snapshotOf(r)], [0, 0, before]);
      r.cleanup();
    }

    // ================================================================
    // 9. 直接の gh pr create のフック（PreToolUse）: 作れる組は brw pr、作れない組は作成画面の URL を示す
    // ================================================================
    {
      const dev = newBase();
      gitOut(dev.dir, "checkout", "-q", "-b", "dev/foo");
      const devB = newBase({ config: { ...CONFIG, baseBranches: ["release"] } });
      const mainR = newBase();
      gitOut(mainR.dir, "checkout", "-q", "main");
      const beforeDev = snapshotOf(dev);
      const beforeDevB = snapshotOf(devB);
      const beforeMain = snapshotOf(mainR);
      // 作れる組（brw pr の手順を示し、URL は示さない）・作れない組（URL を示し、brw pr は示さない）・開発ブランチ間（brw merge を示す）
      const cases = [
        { name: "開発→保護", repo: dev, base: "main", head: "dev/foo", url: null, pr: true, merge: false },
        { name: "開発→分岐元", repo: dev, base: "develop", head: "dev/foo", url: null, pr: true, merge: false },
        { name: "分岐元→保護", repo: devB, base: "main", head: "develop", url: null, pr: true, merge: false },
        { name: "開発間", repo: dev, base: "dev/bar", head: "dev/foo", url: null, pr: false, merge: true },
        { name: "宣言外", repo: dev, base: "feature/x", head: "dev/foo", url: "https://github.com/acme/app/compare/feature/x...dev/foo?expand=1", pr: false, merge: false },
        { name: "保護→分岐元", repo: mainR, base: "develop", head: "main", url: "https://github.com/acme/app/compare/develop...main?expand=1", pr: false, merge: false },
        { name: "分岐元→分岐元", repo: devB, base: "release", head: "develop", url: "https://github.com/acme/app/compare/release...develop?expand=1", pr: false, merge: false },
      ];
      for (const c of cases) {
        const res = hook(c.repo, `gh pr create --base ${c.base} --head ${c.head} --title t --body b`);
        const d = JSON.parse(res.stdout || "{}").hookSpecificOutput ?? {};
        const reason = String(d.permissionDecisionReason ?? "").replace(HOOK_PREFIX, "");
        const url = reason.match(/https:\/\/\S+/)?.[0] ?? null;
        const shownPr = /brw(\.mjs)?['"`]?\s+pr(\s|$|`)/.test(reason);
        eq(`integration/8.1 フック（${c.name}）: 拒否し、案内に作れる手順（brw pr）・作成画面の URL・brw merge を正しく示す`, [d.permissionDecision, shownPr, url, reason.includes("brw merge")], ["deny", c.pr, c.url, c.merge]);
        eq(`integration/8.1 フック（${c.name}）: reason と alternative の連結が 500 文字に収まる`, reason.length <= 500, true);
      }
      eq("integration/8.1 フックは GitHub へ通信せず、書き込みも 0 件で、実行の前後で全体の状態が同じ", [writesOf(dev), writesOf(devB), writesOf(mainR), sshCountOf(dev), snapshotOf(dev), snapshotOf(devB), snapshotOf(mainR)], [0, 0, 0, 0, beforeDev, beforeDevB, beforeMain]);
      dev.cleanup();
      devB.cleanup();
      mainR.cleanup();
    }
  } finally {
    for (const r of repos) r.cleanup();
    rmSync(sandbox, { recursive: true, force: true });
    for (const k of ISO_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  }
  // 後始末: 実行の前後で、この試験が作る一時ディレクトリの数が増えていない（mkRepoWithRemote の残りも含む）
  eq("integration/8.1 後始末: 実行の前後で brw-fx-* と brw-int-bpr-* の数が増えない（tmpdir と /tmp）", tmpLeftovers(), tmpBefore);
};

// 単独実行（node tests/integration-base-pr.mjs）。selftest.mjs と同じく失敗があれば終了コード 1
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
if (isMain) {
  let failed = 0;
  const eq = (name, got, want) => {
    const same = JSON.stringify(got) === JSON.stringify(want);
    if (!same) failed++;
    console.log(`${same ? "ok  " : "FAIL"} ${name}${same ? "" : `\n     got : ${JSON.stringify(got)}\n     want: ${JSON.stringify(want)}`}`);
  };
  await runIntegrationBasePrChecks(eq);
  console.log(failed ? `\n${failed} 件失敗` : "\nすべて成功");
  process.exit(failed ? 1 : 0);
}
