// 統合・回帰の試験（brw-enforcement 19.1）。selftest.mjs から呼ばれる（単独実行も可）。
// 実際の scripts/brw.mjs と scripts/agent-hooks.mjs を子プロセスとして spawn し、次の 5 つを独立した試験として確かめる:
//   1. リモートからの再開（要件 2.15）
//   2. 終了時の検出 → 区切り → 再開の通し（Stop と brw guard --finish）
//   3. 保護ブランチ・分岐元・宣言外では案内も確認省略も適用されない（要件 2.18）
//   4. 確認省略の条件（要件 2.14）
//   5. 保護ブランチ向け PR の案内（要件 3.9）
// 一時リポジトリ・bare remote・偽の gh（tests/support/gh-shim.mjs）だけを使い、GitHub と通信しない。
// 利用者の ~/.claude・~/.codex・~/.gitconfig には触れない。fixture の初期化を含むすべての Git の子プロセスは、
// 一時の HOME・XDG_CONFIG_HOME と、Git の全域設定を無効にした環境（ISO）で動かす。
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bodyPathOf } from "../scripts/pr-template.mjs";
import { hookInput } from "./support/hook-fixtures.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const BRW = join(here, "../scripts/brw.mjs");
const HOOKS = join(here, "../scripts/agent-hooks.mjs");
const SHIM = join(here, "support/gh-shim.mjs");
const GH_SSH = "git@github.com:acme/app.git";
const CONFIG_FILE = ".branch-release-workflow.json";
const REPO_KEY = "GET /repos/acme/app";
// 既存 PR の照合（publish-pr の existingPr と findOpenPull）の一覧。PR は無い前提
const LIST = "GET /repos/acme/app/pulls?state=open&head=acme:dev/foo&per_page=100";
const FILTERED = "GET /repos/acme/app/pulls?state=open&head=acme:dev/foo&base=main&per_page=100";
const CREATE_PR = "POST /repos/acme/app/pulls";
const DONE = "依頼の完了条件を満たした";
const VERIFY = "npm test が成功";
const TITLE = "変更の要約";
const CONFIG = { workBranches: ["dev/*"], protectedBranches: ["main"], baseBranch: "develop" };
const FIN_ALLOW = "[allow] 未コミットの変更も未 push の commit も残っていません。";
const BLOCK = "[block] ";
// 試験用 ssh。受け取り（git-receive-pack）の呼び出しを記録し、GitHub のパスを bare remote へ置き換える
const FAKE_SSH = `#!/bin/sh
printf '%s\\n' "$2" >> "$BRW_TEST_SSHLOG"
cmd=$(printf '%s' "$2" | sed "s#acme/app.git#$BRW_TEST_BARE#")
exec sh -c "$cmd"
`;
// 危険なコマンド（確認省略の対象外であること）。--amend・add -f・push --force
const DANGER = ["git commit --amend -m x", "git add -f a.txt && git commit -m \"x\"", "git push --force origin dev/foo"];
const ADD_COMMIT = "git add a.txt && git commit -m \"x\"";
const ADD_COMMIT_PUSH = "git add a.txt && git commit -m \"x\" && git push origin dev/foo";

/** 偽 gh が返す PR（head の OID は指定の値）。publish-pr の照合（OID・base・head・リポジトリ）を通る形。 */
const PR = (sha) => ({
  number: 7,
  html_url: "https://github.com/acme/app/pull/7",
  state: "open",
  draft: false,
  base: { ref: "main", repo: { id: 4242, full_name: "acme/app" } },
  head: { ref: "dev/foo", sha, repo: { id: 4242, full_name: "acme/app" } },
});

/** 偽 gh の要求ログを 1 行 1 件で読む（無ければ空）。 */
const logOf = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

export const runIntegrationEnforcementChecks = async (eq) => {
  const sandbox = mkdtempSync(join(tmpdir(), "brw-enf-int-"));
  const bin = join(sandbox, "bin");
  const home = join(sandbox, "home");
  const xdg = join(sandbox, "xdg");
  mkdirSync(bin);
  mkdirSync(home);
  mkdirSync(xdg);
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nexec node "${SHIM}" "$@"\n`, { mode: 0o755 });
  const sshPath = join(sandbox, "fake-ssh.sh");
  writeFileSync(sshPath, FAKE_SSH, { mode: 0o755 });
  // 隔離した環境: 利用者の Git 設定・HOME・XDG の影響を受けない（fixture の初期化も含む）
  const ISO = { PATH: process.env.PATH, LANG: "C.UTF-8", HOME: home, XDG_CONFIG_HOME: xdg, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
  let seq = 0;

  /** 偽 gh の設定ファイルを作り、そのパスを返す。既定はリポジトリの確認と PR なし。 */
  const ghCfg = (routes = {}) => {
    const p = join(sandbox, `gh-${++seq}.json`);
    writeFileSync(p, JSON.stringify({ scenario: "success", routes: { [REPO_KEY]: { status: 200, body: { id: 4242, full_name: "acme/app" } }, [LIST]: { status: 200, body: [] }, [FILTERED]: { status: 200, body: [] }, ...routes } }));
    return p;
  };

  /** 隔離した環境で Git を実行する（fixture の初期化用。失敗は例外）。 */
  const fx = (dir, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", ...args], { cwd: dir, env: ISO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  /**
   * 宣言つきの一時リポジトリを作る。本体（main）に宣言を置き、develop（恒常的な分岐元）を遠隔に作る。
   * origin は GitHub の形の URL にし、試験用 ssh で bare remote へ送る。
   * config: 宣言の内容。register が偽なら宣言を commit しない（未登録）。
   */
  const newRepo = ({ config = CONFIG, register = true } = {}) => {
    const root = mkdtempSync(join(sandbox, "repo-"));
    const remote = join(root, "remote.git");
    const dir = join(root, "work");
    mkdirSync(dir);
    fx(root, "init", "-q", "--bare", "-b", "main", remote);
    fx(dir, "init", "-q", "-b", "main");
    fx(dir, "commit", "-q", "--allow-empty", "-m", "初期");
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify(config));
    if (register) {
      fx(dir, "add", CONFIG_FILE);
      fx(dir, "commit", "-q", "-m", "宣言");
    }
    fx(dir, "remote", "add", "origin", remote);
    fx(dir, "push", "-q", "origin", "main");
    fx(dir, "push", "-q", "origin", "main:refs/heads/develop");
    fx(dir, "remote", "set-url", "origin", GH_SSH);
    const n = ++seq;
    return {
      dir,
      remote,
      gh: ghCfg(),
      ghLog: join(sandbox, `gh-log-${n}.log`),
      env: {
        ...ISO,
        PATH: `${bin}:${ISO.PATH}`,
        GH_TOKEN: "test-token-enf",
        BRW_NO_GH: "1",
        GIT_SSH_COMMAND: sshPath,
        GIT_SSH_VARIANT: "simple",
        BRW_TEST_BARE: remote,
        BRW_TEST_SSHLOG: join(sandbox, `ssh-${n}.log`),
        BRW_GH_SHIM_LOG: join(sandbox, `gh-log-${n}.log`),
        BRW_GH_SHIM_CONFIG: "",
      },
    };
  };

  /** brw.mjs を実際に spawn する。gh を指定すると、その偽 gh の設定を使う。 */
  const brw = (repo, dir, args, { gh } = {}) => spawnSync("node", [BRW, ...args], { cwd: dir, encoding: "utf8", env: { ...repo.env, BRW_GH_SHIM_CONFIG: gh ?? repo.gh } });
  /** git を実行する（push は試験用 ssh を通る）。失敗は例外。 */
  const git = (repo, dir, ...args) => {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8", env: repo.env });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} が失敗: ${r.stderr}`);
    return r.stdout.trim();
  };
  /** 遠隔（bare）の ref の OID。無ければ null。 */
  const remoteRef = (repo, branch) => {
    const r = spawnSync("git", ["rev-parse", "--verify", "-q", `refs/heads/${branch}`], { cwd: repo.remote, encoding: "utf8", env: ISO });
    return r.status === 0 ? r.stdout.trim() : null;
  };
  /** 指定の ref が存在するか（ローカル）。 */
  const localRefExists = (repo, ref) => spawnSync("git", ["rev-parse", "--verify", "-q", `refs/heads/${ref}`], { cwd: repo.dir, encoding: "utf8", env: ISO }).status === 0;
  /** GitHub への書き込み（GET・HEAD 以外）の件数。 */
  const writesOf = (repo) => logOf(repo.ghLog).filter((e) => e.method && !["GET", "HEAD"].includes(e.method)).length;

  /** 作業ブランチ dev/foo を brw create で作り、その worktree のパスを返す。 */
  const createFoo = (repo) => {
    const c = brw(repo, repo.dir, ["create", "foo"]);
    if (c.status !== 0) throw new Error(`brw create が失敗: ${c.stderr}`);
    return join(repo.dir, ".claude/worktrees/dev-foo");
  };
  /** 既存のブランチ（または新しいブランチ）を別の worktree で開き、そのパスを返す。 */
  const worktreeOf = (repo, { branch, newBranch } = {}) => {
    const p = mkdtempSync(join(sandbox, "wt-"));
    rmSync(p, { recursive: true, force: true });
    const args = newBranch ? ["worktree", "add", "-q", "-b", newBranch, p] : ["worktree", "add", "-q", p, branch];
    git(repo, repo.dir, ...args);
    return p;
  };
  /** ファイルを書く。 */
  const writeFile = (dir, name, text) => writeFileSync(join(dir, name), text);
  /** 変更を commit する（push はしない）。text を省いたときは既存のファイルを使う。 */
  const commitOnly = (repo, dir, name, text) => {
    if (text !== undefined) writeFile(dir, name, text);
    git(repo, dir, "add", name);
    git(repo, dir, "commit", "-q", "-m", `変更 ${name}`);
  };
  /** 変更を commit して、現在のブランチを遠隔へ push する（区切り）。 */
  const commitAndPush = (repo, dir, name, text) => {
    commitOnly(repo, dir, name, text);
    git(repo, dir, "push", "-q", "-u", "origin", "HEAD");
  };

  // フックの起動の失敗（非 0 の終了・標準エラー出力・JSON として読めない出力）を集める。最後に 0 件を確かめる
  const hookFaults = [];
  /** フックを実際に spawn する。応答（JSON）は body、起動の状態は status・stderr・json で返す。 */
  const hookRun = (repo, dir, host, event, { command, stopActive } = {}) => {
    const ev = hookInput(host, event, { cwd: dir, command });
    if (event === "Stop") ev.stop_hook_active = stopActive === true;
    const r = spawnSync("node", [HOOKS, host, event], { cwd: dir, encoding: "utf8", env: repo.env, input: JSON.stringify(ev) });
    const t = (r.stdout ?? "").trim();
    let body = null;
    let json = true;
    if (t !== "") {
      try {
        body = JSON.parse(t);
      } catch {
        json = false;
      }
    }
    const stderr = r.stderr ?? "";
    if (r.status !== 0 || stderr !== "" || !json) hookFaults.push({ host, event, status: r.status, stderr, stdout: t });
    return { status: r.status, stderr, json, body };
  };
  const hookOut = (repo, dir, host, event, opts) => hookRun(repo, dir, host, event, opts).body;
  const stopOf = (repo, host, dir, stopActive = false) => hookOut(repo, dir, host, "Stop", { stopActive });
  /** Claude の PreToolUse と Codex の PreToolUse の応答（permissionDecision）。 */
  const preOf = (repo, host, dir, command) => hookOut(repo, dir, host, "PreToolUse", { command })?.hookSpecificOutput?.permissionDecision ?? null;
  const preReasonOf = (repo, host, dir, command) => hookOut(repo, dir, host, "PreToolUse", { command })?.hookSpecificOutput?.permissionDecisionReason ?? "";
  /** Codex の PermissionRequest の応答（decision.behavior）。 */
  const permOf = (repo, dir, command) => hookOut(repo, dir, "codex", "PermissionRequest", { command })?.hookSpecificOutput?.decision?.behavior ?? null;
  const block = (r) => r?.decision === "block" && typeof r.reason === "string";
  /**
   * 1 つのコマンドについて、フックの 3 経路（Claude の PreToolUse、Codex の PreToolUse・PermissionRequest）の
   * 終了状態・標準エラー・JSON の読めた否か・応答を並べて返す。確認省略の判定を完全一致で比べるために使う。
   */
  const decisionsOf = (repo, dir, command) => {
    const runs = [hookRun(repo, dir, "claude", "PreToolUse", { command }), hookRun(repo, dir, "codex", "PreToolUse", { command }), hookRun(repo, dir, "codex", "PermissionRequest", { command })];
    return {
      exit: runs.map((x) => x.status),
      stderr: runs.map((x) => x.stderr),
      json: runs.map((x) => x.json),
      claude: runs[0].body?.hookSpecificOutput?.permissionDecision ?? null,
      codexPre: runs[1].body?.hookSpecificOutput?.permissionDecision ?? null,
      codexPerm: runs[2].body?.hookSpecificOutput?.decision?.behavior ?? null,
    };
  };

  /** brw guard --finish の結果（標準出力・終了コード）。 */
  const guardOf = (repo, dir) => {
    const g = spawnSync("node", [BRW, "guard", "--finish"], { cwd: dir, encoding: "utf8", env: repo.env });
    return { status: g.status, out: g.stdout };
  };

  try {
    // ================================================================
    // 1. リモートからの再開（要件 2.15）
    // ================================================================
    {
      const r = newRepo();
      const wt = createFoo(r);
      commitAndPush(r, wt, "a.txt", "a");
      commitAndPush(r, wt, "b.txt", "b");
      // 区切り（直前に push した状態）の commit と履歴を覚える
      const savedHead = git(r, wt, "rev-parse", "HEAD");
      const savedLog = git(r, wt, "log", "--format=%s", "HEAD");
      // 最後の区切りの後に、commit したが未 push の変更（d.txt）と、未コミットの変更（c.txt）を作る
      commitOnly(r, wt, "d.txt", "未 push の commit");
      const unpushedHead = git(r, wt, "rev-parse", "HEAD");
      writeFile(wt, "c.txt", "未 push の変更");
      git(r, r.dir, "worktree", "remove", "--force", wt);
      git(r, r.dir, "branch", "-D", "dev/foo");
      eq("integration/19.1 再開の前に、手元の worktree とローカルブランチが無いことを確かめる", [existsSync(wt), localRefExists(r, "dev/foo")], [false, false]);
      const res = brw(r, r.dir, ["resume", "dev/foo"]);
      eq("integration/19.1 リモートのブランチから resume で worktree を作り直し、直前の区切りの commit が揃う", [res.status, existsSync(wt), git(r, wt, "rev-parse", "HEAD") === savedHead, git(r, wt, "log", "--format=%s", "HEAD") === savedLog], [0, true, true, true]);
      eq("integration/19.1 直前の区切りまでのファイルの内容が揃う", [readFileSync(join(wt, "a.txt"), "utf8"), readFileSync(join(wt, "b.txt"), "utf8")], ["a", "b"]);
      eq("integration/19.1 最後の区切りの後に commit したが未 push の変更は再開後に含まれず、その commit も HEAD に残らない", [existsSync(join(wt, "d.txt")), git(r, wt, "log", "--format=%s", "HEAD").includes("変更 d.txt"), git(r, wt, "rev-parse", "HEAD") !== unpushedHead], [false, false, true]);
      eq("integration/19.1 最後の区切りの後の未コミットの変更（c.txt）も再開後には無い", existsSync(join(wt, "c.txt")), false);
      eq("integration/19.1 再開は遠隔の dev/foo を変えない（直前の区切りを指したまま）", remoteRef(r, "dev/foo") === savedHead, true);
    }

    // ================================================================
    // 2. 終了時の検出 → 区切り → 再開の通し（Stop と brw guard --finish）
    // ================================================================
    {
      const r = newRepo();
      const wt = createFoo(r);
      commitAndPush(r, wt, "a.txt", "a");
      eq("integration/19.1 区切りで push 済みで clean なら、Claude・Codex の Stop は block せず、guard --finish は [allow] で終了コード 0", [stopOf(r, "claude", wt), stopOf(r, "codex", wt), guardOf(r, wt)], [null, null, { status: 0, out: `${FIN_ALLOW}\n` }]);
      writeFile(wt, "b.txt", "b");
      const cl = stopOf(r, "claude", wt);
      const cx = stopOf(r, "codex", wt);
      eq("integration/19.1 未コミットの変更があると、Claude・Codex の Stop が同じ文面で block する", [block(cl), block(cx), cl?.reason === cx?.reason, cl?.reason.includes("未コミットの変更")], [true, true, true, true]);
      eq("integration/19.1 stop_hook_active が真の再入では、残りがあっても止めて終了させる（block しない）", stopOf(r, "claude", wt, true), null);
      const g1 = guardOf(r, wt);
      eq("integration/19.1 guard --finish は未コミットの変更で [block] と終了コード 1 を返す", [g1.status, g1.out.startsWith(BLOCK), g1.out.includes(wt), g1.out.includes("git commit")], [1, true, true, true]);
      // 本体（main・clean）から Stop を呼んでも、別の worktree の残りで block される
      const fromMain = stopOf(r, "codex", r.dir);
      eq("integration/19.1 Stop の cwd が clean な本体（main）でも、別の worktree の残りで block し、案内に worktree のパスを含む", [block(fromMain), fromMain?.reason.includes(wt)], [true, true]);
      commitOnly(r, wt, "b.txt");
      const unpushed = stopOf(r, "claude", wt);
      const g2 = guardOf(r, wt);
      eq("integration/19.1 commit したが未 push の残りも、Stop と guard --finish で止める", [block(unpushed), unpushed?.reason.includes("未 push の commit"), g2.status, g2.out.includes("未 push の commit")], [true, true, 1, true]);
      git(r, wt, "push", "-q", "-u", "origin", "HEAD");
      eq("integration/19.1 commit・push のあとは Claude・Codex の Stop が block せず、guard --finish は [allow] で終了コード 0", [stopOf(r, "claude", wt), stopOf(r, "codex", wt), stopOf(r, "codex", r.dir), guardOf(r, wt)], [null, null, null, { status: 0, out: `${FIN_ALLOW}\n` }]);
      eq("integration/19.1 通しの途中で GitHub への書き込みは 0 件、遠隔の dev/foo は最後の push と一致する", [writesOf(r), remoteRef(r, "dev/foo") === git(r, wt, "rev-parse", "HEAD")], [0, true]);
    }

    // ================================================================
    // 3. 保護ブランチ・分岐元・宣言外では案内も確認省略も適用されない（要件 2.18）
    // ================================================================
    {
      const r = newRepo();
      const wt = createFoo(r);
      commitAndPush(r, wt, "f.txt", "f");
      // 本体（main）に、未 push の commit と未コミットの変更
      commitOnly(r, r.dir, "mc.txt", "local main");
      writeFile(r.dir, "m.txt", "m");
      // 分岐元（develop）の worktree に、未 push の commit と未コミットの変更
      const dev = worktreeOf(r, { branch: "develop" });
      commitOnly(r, dev, "dl.txt", "local");
      writeFile(dev, "d.txt", "d");
      // 宣言外（feature/x）の worktree に、未 push の commit と未コミットの変更
      const feat = worktreeOf(r, { newBranch: "feature/x" });
      commitOnly(r, feat, "x.txt", "x");
      writeFile(feat, "y.txt", "y");
      const mainBefore = remoteRef(r, "main");
      const developBefore = remoteRef(r, "develop");
      eq("integration/19.1 前提: 3 つの場所にそれぞれ未コミットの変更がある", [git(r, r.dir, "status", "--porcelain") !== "", git(r, dev, "status", "--porcelain") !== "", git(r, feat, "status", "--porcelain") !== ""], [true, true, true]);
      // 前提: どの遠隔の ref にも無い commit がある（未 push の実在の確認）。feature/x は main の HEAD（mc.txt の commit を含む）から切ったため 2 件
      eq("integration/19.1 前提: 3 つの場所にそれぞれ、どの遠隔の ref にも無い commit（未 push）がある（feature/x は main 由来の 1 件を含むため 2 件）", [r.dir, dev, feat].map((d) => Number(git(r, d, "rev-list", "--count", "HEAD", "--not", "--remotes"))), [1, 1, 2]);
      eq("integration/19.1 保護ブランチ・分岐元・宣言外に残りがあっても、どの cwd からも Stop は block しない", [r.dir, dev, feat].map((d) => [stopOf(r, "claude", d), stopOf(r, "codex", d)]), [[null, null], [null, null], [null, null]]);
      eq("integration/19.1 保護ブランチ・分岐元・宣言外に残りがあっても、guard --finish は [allow] で終了コード 0", [r.dir, dev, feat].map((d) => guardOf(r, d)), [{ status: 0, out: `${FIN_ALLOW}\n` }, { status: 0, out: `${FIN_ALLOW}\n` }, { status: 0, out: `${FIN_ALLOW}\n` }]);
      const denyCommit = [r.dir, dev, feat].map((d) => [preOf(r, "claude", d, "git commit -m x"), preOf(r, "codex", d, "git commit -m x")]);
      eq("integration/19.1 保護ブランチ・分岐元・宣言外への git commit は、Claude・Codex の PreToolUse が従来どおり deny", denyCommit, [["deny", "deny"], ["deny", "deny"], ["deny", "deny"]]);
      const denyPush = [
        [r.dir, "git push origin main"],
        [dev, "git push origin develop"],
        [feat, "git push -u origin feature/x"],
      ].map(([d, c]) => [preOf(r, "claude", d, c), preOf(r, "codex", d, c)]);
      eq("integration/19.1 保護ブランチ・分岐元・宣言外への git push は、Claude・Codex の PreToolUse が従来どおり deny", denyPush, [["deny", "deny"], ["deny", "deny"], ["deny", "deny"]]);
      eq("integration/19.1 保護ブランチ・分岐元・宣言外への push は確認省略にならず、Codex の PermissionRequest も deny", [permOf(r, r.dir, "git push origin main"), permOf(r, dev, "git push origin develop"), permOf(r, feat, "git push -u origin feature/x")], ["deny", "deny", "deny"]);
      eq("integration/19.1 拒否の試行で遠隔の保護・分岐元の ref を変えず、宣言外の ref も作らず、GitHub への書き込みも 0 件", [remoteRef(r, "main") === mainBefore, remoteRef(r, "develop") === developBefore, remoteRef(r, "feature/x"), writesOf(r)], [true, true, null, 0]);
      // 複合（add と commit・push の連結）: 保護・分岐元・宣言外の cwd で確認省略にならず、実際の応答を完全一致で固定する
      const compound = [[r.dir, "main"], [dev, "develop"], [feat, "feature/x"]].map(([d, b]) => [`git add a.txt && git commit -m "x"`, `git add a.txt && git commit -m "x" && git push origin ${b}`, `git add a.txt && git push origin ${b}`].map((c) => decisionsOf(r, d, c)));
      // 観察値: 3 つの cwd・3 つのコマンドとも、3 経路すべて deny（終了コード 0・標準エラー無し・JSON 正常）
      const DENY = { exit: [0, 0, 0], stderr: ["", "", ""], json: [true, true, true], claude: "deny", codexPre: "deny", codexPerm: "deny" };
      eq("integration/19.1 保護ブランチ・分岐元・宣言外の cwd では、add・commit・push の連結も確認省略（allow）にならず、3 経路とも deny（Claude・Codex の全経路の応答を固定）", compound, [[DENY, DENY, DENY], [DENY, DENY, DENY], [DENY, DENY, DENY]]);
    }

    // ================================================================
    // 4. 確認省略（要件 2.14）
    // ================================================================
    // 登録済み・確認省略の対象: Claude の PreToolUse と Codex の PermissionRequest が allow。Codex の PreToolUse は返さない
    const ALLOW = { exit: [0, 0, 0], stderr: ["", "", ""], json: [true, true, true], claude: "allow", codexPre: null, codexPerm: "allow" };
    // 確認省略の対象外: 応答を返さない（null）。危険なコマンドの観察値は下の試験で固定する
    const NO_SKIP = { exit: [0, 0, 0], stderr: ["", "", ""], json: [true, true, true], claude: null, codexPre: null, codexPerm: null };
    {
      const r = newRepo();
      const wt = createFoo(r);
      eq("integration/19.1 登録済みの宣言では、add・commit の連結を Claude の PreToolUse が allow し、Codex の PermissionRequest も allow する（Codex の PreToolUse は返さない）", [decisionsOf(r, wt, ADD_COMMIT), decisionsOf(r, wt, ADD_COMMIT_PUSH)], [ALLOW, ALLOW]);
      eq("integration/19.1 登録済みの宣言でも、--amend・add -f・push --force の形は allow にならない（Claude・Codex とも、フックは正常終了）", DANGER.map((c) => decisionsOf(r, wt, c)), [null, null, null].map(() => ({ ...NO_SKIP })));
    }
    {
      // 未登録: 宣言を commit せず、worktree に置くだけ
      const r = newRepo({ register: false });
      const wt = createFoo(r);
      writeFile(wt, CONFIG_FILE, JSON.stringify(CONFIG));
      eq("integration/19.1 宣言が未登録（commit されていない）なら、add・commit の確認を省略しない", decisionsOf(r, wt, ADD_COMMIT), NO_SKIP);
      eq("integration/19.1 宣言が未登録なら、--amend・add -f・push --force も確認を省略しない", DANGER.map((c) => decisionsOf(r, wt, c)), DANGER.map(() => NO_SKIP));
    }
    {
      // 編集中: 登録済みの宣言を変更して commit していない
      const r = newRepo();
      const wt = createFoo(r);
      writeFile(wt, CONFIG_FILE, JSON.stringify({ ...CONFIG, autoApprove: { push: true } }));
      eq("integration/19.1 宣言を編集中（未 commit の変更がある）なら、add・commit の確認を省略しない", decisionsOf(r, wt, ADD_COMMIT), NO_SKIP);
      eq("integration/19.1 宣言を編集中なら、--amend・add -f・push --force も確認を省略しない", DANGER.map((c) => decisionsOf(r, wt, c)), DANGER.map(() => NO_SKIP));
    }
    {
      // 宣言で autoApprove.commit: false: commit の確認省略は無効
      const r = newRepo({ config: { ...CONFIG, autoApprove: { commit: false } } });
      const wt = createFoo(r);
      eq("integration/19.1 宣言の autoApprove.commit: false では、add・commit の確認を省略しない", decisionsOf(r, wt, ADD_COMMIT), NO_SKIP);
      eq("integration/19.1 宣言の autoApprove.commit: false では、--amend・add -f・push --force も確認を省略しない", DANGER.map((c) => decisionsOf(r, wt, c)), DANGER.map(() => NO_SKIP));
    }
    {
      // 試験の終わりに、フックの起動が一度も失敗していないことを確かめる（非 0・標準エラー・不正な JSON）
      eq("integration/19.1 フックの起動は一度も失敗しなかった（終了コード 0・標準エラー無し・JSON として読める）", hookFaults, []);
    }

    // ================================================================
    // 5. 保護ブランチ向け PR の案内（要件 3.9）
    // ================================================================
    {
      const r = newRepo();
      const wt = createFoo(r);
      // 取り込み先を保護ブランチ（main）にする（作業ブランチの記録）
      git(r, wt, "config", "branch.dev/foo.brwBase", "main");
      commitOnly(r, wt, "f.txt", "f");
      const head = git(r, wt, "rev-parse", "HEAD");
      const bodyPath = bodyPathOf(r.dir, "dev/foo");
      const tpl = brw(r, wt, ["pr-template"]);
      eq("integration/19.1 brw pr-template は本文の雛形を置く（終了コード 0）", [tpl.status, existsSync(bodyPath)], [0, true]);
      writeFileSync(bodyPath, "## 概要\n\n書き終えた本文\n");
      // マージ経路の拒否は、brw pr で worktree を片付ける前（cwd が存在するうち）に確かめる
      eq("integration/19.1 PR のマージ経路（gh pr merge）は Claude・Codex とも deny し、案内に brw pr-merge を含む", [preOf(r, "claude", wt, "gh pr merge 7 --squash"), preOf(r, "codex", wt, "gh pr merge 7 --squash"), preReasonOf(r, "claude", wt, "gh pr merge 7 --squash").includes("brw pr-merge")], ["deny", "deny", true]);
      const gh = ghCfg({ [CREATE_PR]: { status: 201, body: PR(head) } });
      const pr = brw(r, wt, ["pr", "--title", TITLE, "--completion", DONE, "--verification", VERIFY], { gh });
      const lines = pr.stdout.split("\n");
      // 従来の成功時の案内（publish-cli の出力と同じ文・同じ順）。URL・取り込み先・squash の案内を行として完全一致で比べる
      eq("integration/19.1 brw pr の成功時の案内は従来どおり（URL・取り込み先 main・GitHub 上での squash の案内を、既存の文面どおりの行で出す）", [pr.status, lines.filter((l) => l.startsWith("PR を作成しました: ") || l.startsWith("取り込み先: ") || l.startsWith("GitHub 上で PR を開き、")), pr.stderr], [0, ["PR を作成しました: https://github.com/acme/app/pull/7", "取り込み先: main", "GitHub 上で PR を開き、main へ squash マージしてください。BRW は GitHub のマージを行いません。"], ""]);
      const posts = logOf(r.ghLog).filter((e) => e.method === "POST" && e.path === "/repos/acme/app/pulls");
      eq("integration/19.1 brw pr は dev/foo から main への PR を 1 件作る（取り込み先・head・タイトルが一致）", [posts.length, posts[0]?.applied, posts[0]?.body?.base, posts[0]?.body?.head, posts[0]?.body?.title], [1, true, "main", "dev/foo", TITLE]);
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
};

// 単独実行（node tests/integration-enforcement.mjs）。selftest.mjs と同じく失敗があれば終了コード 1
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
if (isMain) {
  let failed = 0;
  const eq = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n     got : ${JSON.stringify(got)}\n     want: ${JSON.stringify(want)}`}`);
  };
  await runIntegrationEnforcementChecks(eq);
  console.log(failed ? `\n${failed} 件失敗` : "\nすべて成功");
  process.exit(failed ? 1 : 0);
}
