// CLI のブランチ操作の契約テスト（brw-enforcement 7.1）。selftest.mjs から呼ばれる。
// 一時リポジトリと bare remote で create・resume・merge・finish を実行する。GitHub には接続しない。
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installCodexHooks } from "../scripts/hook-install.mjs";
import { diagnoseHooks } from "../scripts/hook-diagnose.mjs";
import { realpathSync } from "node:fs";
import { gitOut, mkRepoWithRemote, mkWorktree } from "./support/git-fixture.mjs";

const BRW = join(dirname(fileURLToPath(import.meta.url)), "../scripts/brw.mjs");
// 開発ブランチ dev/*、保護 main、分岐元 develop
const CFG = { workBranches: ["dev/*"], protectedBranches: ["main"], baseBranch: "develop", namePattern: "^dev/[a-z0-9]+(-[a-z0-9]+)*$", preview: { provider: "none" } };
// 開発の名前のまま恒常的な分岐元に指定したブランチ
const CFG_LEGACY = { ...CFG, baseBranches: ["dev/legacy"] };
// マージ commit の作成に必要な作者情報（利用者の Git 設定に左右されないため）
const ID = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

const brw = (cwd, args, env = {}) => spawnSync("node", [BRW, ...args], { cwd, encoding: "utf8", env: { ...process.env, ...ID, ...env } });
const head = (cwd) => gitOut(cwd, "rev-parse", "HEAD");
// 第 2 親（マージの取り込み元）。マージ commit でなければ空文字
const secondParent = (cwd) => spawnSync("git", ["rev-parse", "--verify", "--quiet", "HEAD^2"], { cwd, encoding: "utf8" }).stdout.trim();
const hasRef = (cwd, ref) => spawnSync("git", ["show-ref", "--verify", "--quiet", ref], { cwd }).status === 0;
const remoteRefs = (remote) => gitOut(remote, "for-each-ref", "--format=%(refname) %(objectname)");
const commitFile = (cwd, file, text) => {
  writeFileSync(join(cwd, file), text);
  gitOut(cwd, "add", file);
  gitOut(cwd, "commit", "-q", "-m", `add ${file}`);
};
// 分岐元 develop を持つリポジトリ。develop は遠隔へ push 済み、作業は develop 上から始まる
const mkTeam = (cfg = CFG) => {
  const r = mkRepoWithRemote({ branch: "main", config: cfg });
  gitOut(r.dir, "checkout", "-q", "-b", "develop");
  gitOut(r.dir, "push", "-q", "origin", "develop");
  return r;
};
// gh の呼び出しを記録するだけの偽の gh を PATH の先頭に置く。呼ばれれば記録ファイルが残る
const fakeGh = () => {
  const dir = mkdtempSync(join(tmpdir(), "brw-fakegh-"));
  const log = join(dir, "calls.log");
  writeFileSync(join(dir, "gh"), `#!/bin/sh\necho "$@" >> '${log}'\nexit 0\n`);
  chmodSync(join(dir, "gh"), 0o755);
  return { dir, log, env: { PATH: `${dir}:${process.env.PATH}` } };
};
// 切り出し元へ取り込んだ状態を作る（ローカルのマージと push）
const landed = (t, branch) => {
  gitOut(t.dir, "merge", "-q", "--no-ff", "-m", `取り込み ${branch}`, branch);
  gitOut(t.dir, "push", "-q", "origin", "develop");
};

export const runBranchOpsChecks = async (eq) => {
  // ---- create: 共通判定（classifyBranch）で作れるブランチを決める ----
  {
    const t = mkTeam();
    eq("branch-ops/7.1 既存の create は開発ブランチを作る", [brw(t.dir, ["create", "fresh", "--branch-only"]).status, hasRef(t.dir, "refs/heads/dev/fresh")], [0, true]);
    t.cleanup();
    const l = mkTeam(CFG_LEGACY);
    const r = brw(l.dir, ["create", "legacy", "--branch-only"]);
    eq("branch-ops/7.1 恒常的な分岐元に指定された dev/ 名は作業ブランチとして作らない", [r.status, hasRef(l.dir, "refs/heads/dev/legacy")], [1, false]);
    l.cleanup();
  }

  // ---- worktree ごとの Codex フック登録（8.4: Codex は worktree で親の .codex を読まない）----
  {
    const launcher = realpathSync(join(dirname(BRW), "agent-hooks.mjs"));
    const codexHome = mkdtempSync(join(tmpdir(), "brw-codexhome-"));
    const env = { CODEX_HOME: codexHome };
    const t = mkTeam();
    try {
      // 親に登録が無いときは何もしない
      const plain = brw(t.dir, ["create", "plain"], env);
      eq("branch-ops/8.4 親に Codex の登録が無ければ、create は worktree に .codex/ を作らない", [plain.status, existsSync(join(t.dir, ".claude/worktrees/dev-plain/.codex"))], [0, false]);
      installCodexHooks({ repoDir: t.dir, launcherPath: launcher });
      const made = brw(t.dir, ["create", "hooked"], env);
      const wt = join(t.dir, ".claude/worktrees/dev-hooked");
      const wtd = (trust) => diagnoseHooks({ pluginRoot: dirname(dirname(BRW)), codexRepoDir: wt, host: "codex", codexTrust: trust, env: {} }).routes.filter((x) => x.environment === "local").map((x) => x.status);
      eq("branch-ops/8.4 親に登録があれば create は worktree の .codex/ を有効化して案内する（hooks.json は作らない。診断は信頼済みで active・未信頼で untrusted）",
        [made.status, existsSync(join(wt, ".codex")), existsSync(join(wt, ".codex/hooks.json")), /有効にしました/.test(made.stdout), wtd("trusted"), wtd("untrusted")], [0, true, false, true, Array(4).fill("active"), Array(4).fill("untrusted")]);
      gitOut(t.dir, "branch", "dev/loc2", "develop");
      const res = brw(t.dir, ["resume", "dev/loc2"], env);
      eq("branch-ops/8.4 resume が作る worktree も有効化される", [res.status, existsSync(join(t.dir, ".claude/worktrees/dev-loc2/.codex"))], [0, true]);
    } finally {
      t.cleanup();
      rmSync(codexHome, { recursive: true, force: true });
    }
  }

  // ---- resume: ローカルにだけあるブランチから worktree を作る ----
  {
    const t = mkTeam();
    gitOut(t.dir, "branch", "dev/loc", "develop");
    const r = brw(t.dir, ["resume", "dev/loc"]);
    const wt = join(t.dir, ".claude/worktrees/dev-loc");
    eq("branch-ops/7.1 リモートに無いローカルの開発ブランチから worktree を作れる", [r.status, existsSync(wt) && gitOut(wt, "branch", "--show-current")], [0, "dev/loc"]);
    t.cleanup();
  }
  {
    // リモートと分岐したローカルのブランチは、worktree を作らずに止める
    const t = mkTeam();
    gitOut(t.dir, "checkout", "-q", "-b", "dev/div", "develop");
    gitOut(t.dir, "commit", "-q", "--allow-empty", "-m", "remote-side");
    gitOut(t.dir, "push", "-q", "origin", "dev/div");
    gitOut(t.dir, "reset", "-q", "--hard", "HEAD~1");
    gitOut(t.dir, "commit", "-q", "--allow-empty", "-m", "local-side");
    gitOut(t.dir, "checkout", "-q", "develop");
    const r = brw(t.dir, ["resume", "dev/div"]);
    eq("branch-ops/7.1 リモートと分岐したローカルのブランチは worktree を作らず止める", [r.status, existsSync(join(t.dir, ".claude/worktrees/dev-div"))], [1, false]);
    t.cleanup();
  }
  {
    // 本体の作業ツリーで使用中のブランチは worktree を二重に作らない
    const t = mkTeam();
    gitOut(t.dir, "checkout", "-q", "-b", "dev/cur", "develop");
    const r = brw(t.dir, ["resume", "dev/cur"]);
    eq("branch-ops/7.1 本体の作業ツリーで使用中のブランチは resume で止める", [r.status, existsSync(join(t.dir, ".claude/worktrees/dev-cur"))], [1, false]);
    t.cleanup();
  }
  {
    // 遠隔にだけある恒常的な分岐元の名前は、resume で worktree にしない
    const t = mkTeam(CFG_LEGACY);
    gitOut(t.dir, "branch", "dev/legacy", "develop");
    gitOut(t.dir, "push", "-q", "origin", "dev/legacy");
    gitOut(t.dir, "branch", "-D", "dev/legacy"); // 遠隔にだけ残す
    const r = brw(t.dir, ["resume", "dev/legacy"]);
    eq("branch-ops/7.1 恒常的な分岐元の名前は resume で作業ブランチにしない", [r.status, existsSync(join(t.dir, ".claude/worktrees/dev-legacy"))], [1, false]);
    t.cleanup();
  }
  {
    const t = mkTeam();
    eq("branch-ops/7.1 保護・分岐元・宣言外の名前は resume で拒否する", ["main", "develop", "other/x"].map((b) => brw(t.dir, ["resume", b]).status), [1, 1, 1]);
    t.cleanup();
  }

  // ---- merge: 開発ブランチ同士のローカル取り込み（PR も GitHub 通信もなし） ----
  // 分岐元から dev/a と dev/b を作り、それぞれ別のファイルを commit しておく
  const mm = () => {
    const t = mkTeam();
    const a = mkWorktree(t.dir, "dev/a");
    const b = mkWorktree(t.dir, "dev/b");
    commitFile(a, "a.txt", "a");
    commitFile(b, "b.txt", "b");
    return { ...t, a, b };
  };
  {
    const m = mm();
    const before = remoteRefs(m.remote);
    const bOid = gitOut(m.dir, "rev-parse", "refs/heads/dev/b");
    const r = brw(m.a, ["merge", "dev/b"]);
    eq("branch-ops/7.1 開発ブランチ同士を取り込める", [r.status, existsSync(join(m.a, "b.txt"))], [0, true]);
    eq("branch-ops/7.1 取り込みは確定した元コミットを親に持つマージ commit になる", secondParent(m.a), bOid);
    eq("branch-ops/7.1 取り込みで遠隔の ref は変わらない", remoteRefs(m.remote), before);
    m.cleanup();
  }
  {
    // 開発間の取り込みで gh（GitHub）を呼ばない＝PR は作られない
    const m = mm();
    const gh = fakeGh();
    const r = brw(m.a, ["merge", "dev/b"], gh.env);
    eq("branch-ops/7.1 開発間の取り込みは PR を作らず gh も呼ばない", [r.status, existsSync(gh.log)], [0, false]);
    rmSync(gh.dir, { recursive: true, force: true });
    m.cleanup();
  }
  {
    // 競合は報告して中断状態にし、自動解決しない
    const m = mm();
    const d = mkWorktree(m.dir, "dev/d");
    const e = mkWorktree(m.dir, "dev/e");
    commitFile(d, "x.txt", "d-side");
    commitFile(e, "x.txt", "e-side");
    const r = brw(d, ["merge", "dev/e"]);
    const inProgress = spawnSync("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: d }).status === 0;
    eq("branch-ops/7.1 競合は競合ファイルを示して中断状態にし、自動解決しない", [r.status !== 0, inProgress, readFileSync(join(d, "x.txt"), "utf8").includes("<<<<<<<"), `${r.stdout}${r.stderr}`.includes("x.txt")], [true, true, true, true]);
    spawnSync("git", ["merge", "--abort"], { cwd: d }); // 競合が無くても後始末は失敗させない
    m.cleanup();
  }
  {
    // 保護・分岐元・宣言外・未解決・作業中の変更がある場合は、どの組み合わせも HEAD を動かさない
    const m = mm();
    const other = mkWorktree(m.dir, "feature/z");
    const det = mkWorktree(m.dir, "dev/det");
    gitOut(det, "checkout", "-q", "--detach");
    gitOut(m.dir, "branch", "other/x", "develop");
    const cases = [
      ["取り込み先が分岐元（develop 上の本体）", m.dir, ["merge", "dev/b"]],
      ["取り込み先が保護ブランチ（main）", m.dir, ["merge", "dev/b"], () => gitOut(m.dir, "checkout", "-q", "main"), () => gitOut(m.dir, "checkout", "-q", "develop")],
      ["取り込み先が宣言外のブランチ", other, ["merge", "dev/b"]],
      ["取り込み先が detached HEAD", det, ["merge", "dev/b"]],
      ["取り込み元が保護ブランチ", m.a, ["merge", "main"]],
      ["取り込み元が分岐元", m.a, ["merge", "develop"]],
      ["取り込み元が宣言外", m.a, ["merge", "other/x"]],
      ["取り込み元が存在しない", m.a, ["merge", "dev/none"]],
      ["取り込み元が取り込み先と同じ", m.a, ["merge", "dev/a"]],
      ["取り込み元が引数にない", m.a, ["merge"]],
    ];
    const results = cases.map(([, cwd, args, pre, post]) => {
      pre?.();
      const h = head(cwd);
      const r = brw(cwd, args);
      const same = head(cwd) === h;
      post?.();
      return [r.status !== 0, same];
    });
    eq("branch-ops/7.1 保護・分岐元・宣言外・存在しない・detached の取り込みは拒否し、HEAD を動かさない", results, cases.map(() => [true, true]));
    // 未コミットの変更がある作業ツリーへは取り込まない
    writeFileSync(join(m.a, "dirty.txt"), "x");
    const h = head(m.a);
    const dirty = brw(m.a, ["merge", "dev/b"]);
    eq("branch-ops/7.1 未コミットの変更がある作業ツリーには取り込まない", [dirty.status, head(m.a) === h], [1, true]);
    m.cleanup();
  }

  // ---- finish: 片付けの条件（遠隔の状態が不明、未 push の commit は残す） ----
  {
    const t = mkTeam();
    const w = mkWorktree(t.dir, "dev/fa");
    commitFile(w, "fa.txt", "fa");
    gitOut(w, "push", "-q", "origin", "dev/fa");
    landed(t, "dev/fa");
    gitOut(t.dir, "remote", "set-url", "origin", join(t.dir, "no-such-remote.git"));
    const r = brw(w, ["finish"]);
    eq("branch-ops/7.1 遠隔の状態を確認できないときは worktree を残す", [r.status, existsSync(w)], [1, true]);
    t.cleanup();
  }
  {
    // 取り込み後に積んだ、遠隔へ未 push の commit がある worktree は残す
    const t = mkTeam();
    const w = mkWorktree(t.dir, "dev/fb");
    commitFile(w, "fb.txt", "fb");
    gitOut(w, "push", "-q", "origin", "dev/fb");
    landed(t, "dev/fb");
    commitFile(w, "fb2.txt", "fb2");
    const r = brw(w, ["finish"]);
    eq("branch-ops/7.1 取り込み後に積んだ未 push の commit があれば残す", [r.status, existsSync(w)], [1, true]);
    t.cleanup();
  }
  {
    // squash マージ後に遠隔のブランチが削除された（GitHub の既定動作）ものは、旧版どおり片付ける
    const t = mkTeam();
    const w = mkWorktree(t.dir, "dev/sq");
    commitFile(w, "sq.txt", "squash-body");
    gitOut(w, "push", "-q", "origin", "dev/sq");
    // squash 相当: 同じ内容を別のメッセージの commit で入れる（元の commit と OID を一致させない）
    writeFileSync(join(t.dir, "sq.txt"), "squash-body");
    gitOut(t.dir, "add", "sq.txt");
    gitOut(t.dir, "commit", "-q", "-m", "squash sq.txt");
    gitOut(t.dir, "push", "-q", "origin", "develop");
    gitOut(t.dir, "push", "-q", "origin", "--delete", "dev/sq");
    const r = brw(w, ["finish"]);
    eq("branch-ops/7.1 squash 取り込み後に遠隔のブランチが削除されていれば片付ける", [r.status, existsSync(w)], [0, false]);
    t.cleanup();
  }
  {
    // squash 取り込み後、遠隔に無いまま手元にだけ commit を積んだものは残す
    const t = mkTeam();
    const w = mkWorktree(t.dir, "dev/sq2");
    commitFile(w, "sq2.txt", "squash-body");
    gitOut(w, "push", "-q", "origin", "dev/sq2");
    // squash 相当: 同じ内容を別のメッセージの commit で入れる（元の commit と OID を一致させない）
    writeFileSync(join(t.dir, "sq2.txt"), "squash-body");
    gitOut(t.dir, "add", "sq2.txt");
    gitOut(t.dir, "commit", "-q", "-m", "squash sq2.txt");
    gitOut(t.dir, "push", "-q", "origin", "develop");
    gitOut(t.dir, "push", "-q", "origin", "--delete", "dev/sq2");
    commitFile(w, "sq2-extra.txt", "local-only");
    const r = brw(w, ["finish"]);
    eq("branch-ops/7.1 squash 取り込み後に手元だけで積んだ commit があれば残す", [r.status, existsSync(w)], [1, true]);
    t.cleanup();
  }
  {
    // 遠隔に無く、内容も切り出し元に取り込まれていないブランチは残す（切り出し元には別の内容が入っている）
    const t = mkTeam();
    const w = mkWorktree(t.dir, "dev/fc");
    commitFile(w, "fc.txt", "branch-body");
    commitFile(t.dir, "fc.txt", "other-body");
    gitOut(t.dir, "push", "-q", "origin", "develop");
    const r = brw(w, ["finish"]);
    eq("branch-ops/7.1 遠隔に無く内容も切り出し元に取り込まれていないブランチは残す", [r.status, existsSync(w)], [1, true]);
    t.cleanup();
  }
  {
    // 遠隔に無くても、commit が切り出し元に取り込まれていれば片付ける
    const t = mkTeam();
    const w = mkWorktree(t.dir, "dev/fd");
    commitFile(w, "fd.txt", "fd");
    landed(t, "dev/fd");
    const r = brw(w, ["finish"]);
    eq("branch-ops/7.1 遠隔に無くても commit が取り込まれていれば片付ける", [r.status, existsSync(w)], [0, false]);
    t.cleanup();
  }
};
