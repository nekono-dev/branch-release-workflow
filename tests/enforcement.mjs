// 操作の分類と対象の確定（brw-enforcement 2.1）の契約テスト。selftest.mjs から呼ばれる。
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyCommand } from "../scripts/operation-policy.mjs";
import { gitOut, mkRepoWithRemote, mkWorktree } from "./support/git-fixture.mjs";

const CONFIG = { workBranches: ["dev/*"], protectedBranches: ["main"], baseBranch: "develop" };

export const runEnforcementChecks = async (eq) => {
  const r = mkRepoWithRemote({ branch: "dev/foo", config: CONFIG });
  const d = r.dir;
  gitOut(d, "branch", "dev/other");
  gitOut(d, "push", "-q", "origin", "dev/foo");
  gitOut(d, "tag", "v1");
  // 追跡設定（push -u 相当）
  gitOut(d, "config", "branch.dev/foo.remote", "origin");
  gitOut(d, "config", "branch.dev/foo.merge", "refs/heads/dev/foo");
  const c = (cmd, cwd = d) => classifyCommand(cmd, cwd);
  const first = (cmd, cwd = d) => c(cmd, cwd).operations[0];
  const refs = (cmd) => first(cmd).refs?.map((x) => `${x.refKind}:${x.dst}`);

  // ---- push の対象 ----
  eq("enforcement/1.1 push の送り先を remote と ref で確定する", [first("git push origin dev/foo").kind, first("git push origin dev/foo").remote, refs("git push origin dev/foo"), first("git push origin dev/foo").normal], ["push", "origin", ["branch:dev/foo"], true]);
  eq("enforcement/1.1 送り先を省いた push は現在のブランチと追跡設定から確定する", [refs("git push"), first("git push").remote, refs("git push -u origin")], [["branch:dev/foo"], "origin", ["branch:dev/foo"]]);
  eq("enforcement/1.1 HEAD:ref と src:dst は受け側の名前で確定する", [refs("git push origin HEAD"), refs("git push origin dev/foo:main"), refs("git push origin HEAD:refs/heads/dev/x")], [["branch:dev/foo"], ["branch:main"], ["branch:dev/x"]]);
  eq("enforcement/1.1 git -C と cd で作業ディレクトリを切り替える", [refs(`git -C ${d} push origin main`), refs(`cd ${d} && git push`), first("git push", tmpdir()).repoState], [["branch:main"], ["branch:dev/foo"], "outside"]);
  eq("enforcement/1.1 引用符つきの ref とリダイレクトを正しく扱う", [refs(`git push origin "dev/foo" 2>&1`), refs(`git push 'origin' 'main'`)], [["branch:dev/foo"], ["branch:main"]]);
  eq("enforcement/1.1 別の remote も照合する", [(() => { gitOut(d, "remote", "add", "other", r.remote); return first("git push other main").remote; })(), first("git push nowhere main").unresolved.length > 0, first("git push https://example.com/x.git main").unresolved.length > 0], ["other", true, true]);
  gitOut(d, "remote", "remove", "other");
  eq("enforcement/2.8 強制・削除・タグ・一括は通常 push と区別する", [
    first("git push -f origin dev/foo").flags.force, first("git push --force-with-lease origin dev/foo").flags.force, first("git push origin +dev/foo").flags.force,
    first("git push origin :dev/foo").flags.delete, first("git push --delete origin dev/foo").flags.delete,
    first("git push --tags").flags.tags, first("git push origin v1").flags.tags, first("git push origin refs/tags/v1").flags.tags,
    first("git push --all").flags.bulk, first("git push --mirror").flags.bulk,
  ], [true, true, true, true, true, true, true, true, true, true]);
  eq("enforcement/2.8 強制・削除・タグ・一括は normal にならない", ["git push -f origin dev/foo", "git push --delete origin dev/foo", "git push --tags", "git push --all"].map((x) => first(x).normal), [false, false, false, false]);
  eq("enforcement/1.4 一括 push は更新先を確定できない", first("git push --all").unresolved.length > 0, true);
  eq("enforcement/1.4 未対応のオプションと任意コマンドの実行は確定できない", [first("git push --receive-pack=evil origin dev/foo").unresolved.length > 0, first("git push --bogus origin dev/foo").unresolved.length > 0], [true, true]);
  // 追跡設定
  gitOut(d, "config", "branch.dev/foo.merge", "refs/heads/main");
  eq("enforcement/1.4 追跡先の名前が違うと省略した push は確定できない", first("git push").unresolved.length > 0, true);
  gitOut(d, "config", "branch.dev/foo.merge", "refs/heads/dev/foo");
  gitOut(d, "config", "remote.origin.push", "refs/heads/dev/foo:refs/heads/main");
  eq("enforcement/1.4 remote.<名前>.push の対応は送り先として反映する", refs("git push"), ["branch:main"]);
  gitOut(d, "config", "--unset", "remote.origin.push");
  gitOut(d, "config", "push.default", "matching");
  eq("enforcement/1.4 push.default が matching だと確定できない", first("git push").unresolved.length > 0, true);
  gitOut(d, "config", "--unset", "push.default");
  eq("enforcement/1.4 展開・グロブを含む送り先は確定できない", [first("git push origin $B").unresolved.length > 0, first("git push origin dev/*").unresolved.length > 0, first("git push origin dev/*:dev/*").unresolved.length > 0], [true, true, true]);
  gitOut(d, "checkout", "-q", "--detach");
  eq("enforcement/1.4 detached HEAD の push・commit は確定できない", [first("git push origin HEAD").unresolved.length > 0, first("git commit -m x").unresolved.length > 0], [true, true]);
  gitOut(d, "checkout", "-q", "dev/foo");

  // ---- commit ----
  eq("enforcement/1.1 commit は現在のブランチを対象にする", [first("git commit -m x").kind, first("git commit -m x").branch, first(`git -C ${d} commit -am x`).branch, first("git commit -m x").unresolved], ["commit", "dev/foo", "dev/foo", []]);
  eq("enforcement/1.1 commit を生む rebase・cherry-pick・revert・am も commit として分類する", ["git rebase main", "git cherry-pick abc", "git revert HEAD", "git am p.patch"].map((x) => first(x).kind), ["commit", "commit", "commit", "commit"]);
  eq("enforcement/1.4 rebase で別のブランチへ移る形は確定できない", first("git rebase main dev/other").unresolved.length > 0, true);
  eq("enforcement/1.1 --dry-run の commit は照会として扱う", first("git commit --dry-run").kind, "query");
  eq("enforcement/1.1 ワークツリーごとに現在のブランチを使う", (() => { const wt = mkWorktree(d, "dev/wt"); return [first("git commit -m x", wt).branch, first(`git -C ${wt} commit -m x`, d).branch]; })(), ["dev/wt", "dev/wt"]);
  eq("enforcement/1.1 コミットメッセージの $(...) と heredoc は操作に見せない", c("git commit -m \"$(cat <<'EOF'\nfix: git push origin main\nEOF\n)\"").operations.map((o) => o.kind), ["commit"]);

  // ---- 作成・再開 ----
  eq("enforcement/1.2 ブランチの作成を分類する", ["git switch -c dev/n", "git checkout -b dev/n", "git branch dev/n", "git switch --create dev/n main", "git checkout --orphan dev/n"].map((x) => [first(x).kind, first(x).action, first(x).branch]), Array(5).fill(["create", "create", "dev/n"]));
  eq("enforcement/1.2 既存ブランチへの切り替えは再開として分類する", ["git switch dev/other", "git checkout dev/other"].map((x) => [first(x).kind, first(x).action, first(x).branch]), Array(2).fill(["create", "resume", "dev/other"]));
  eq("enforcement/1.2 worktree の追加を分類する", [first("git worktree add ../w -b dev/n").branch, first("git worktree add ../w -b dev/n").action, first("git worktree add ../x dev/other").action, first("git worktree add ../x dev/other").branch], ["dev/n", "create", "resume", "dev/other"]);
  eq("enforcement/1.2 ブランチ名の変更とコピーも作成として扱う", [first("git branch -m dev/new").action, first("git branch -m dev/old dev/new").branch], ["rename", "dev/new"]);
  eq("enforcement/1.1 ファイルの復元や一覧は作成・再開ではなく照会", ["git checkout -- a.txt", "git checkout dev/other -- a.txt", "git branch", "git branch -a", "git branch --list 'dev/*'", "git branch -d dev/other", "git branch --contains HEAD", "git worktree list"].map((x) => first(x).kind), Array(8).fill("query"));
  eq("enforcement/1.4 展開を含むブランチ名は確定できない", [first("git switch -c $N").unresolved.length > 0, first("git checkout $N").unresolved.length > 0], [true, true]);

  // ---- マージ ----
  const m = first("git merge dev/other");
  eq("enforcement/1.1 merge は元 ref と checkout 先を確定する", [m.kind, m.branch, m.sources[0].branch, m.sources[0].oid === gitOut(d, "rev-parse", "dev/other"), m.unresolved], ["merge", "dev/foo", "dev/other", true, []]);
  eq("enforcement/1.1 リモート追跡ブランチと pull の取り込み元", [first("git merge origin/dev/foo").sources[0].remote, first("git merge origin/dev/foo").sources[0].branch, first("git pull origin main").kind, first("git pull origin main").sources[0].branch, first("git pull").sources[0].branch], ["origin", "dev/foo", "merge", "main", "dev/foo"]);
  eq("enforcement/1.4 存在しない・ブランチでない元は確定できない", [first("git merge nothing").unresolved.length > 0, first("git merge HEAD~0").unresolved.length > 0], [true, true]);
  eq("enforcement/1.1 merge --abort は元を要求しない", [first("git merge --abort").kind, first("git merge --abort").unresolved], ["merge", []]);

  // ---- 複合・判定不能 ----
  const cmp = c("git switch -c dev/n && git push origin dev/n");
  eq("enforcement/2.8 複合コマンドは compound とし、各操作を分類する", [cmp.compound, cmp.operations.map((o) => o.kind)], [true, ["create", "push"]]);
  eq("enforcement/1.4 現在のブランチを変えた後の操作は対象を確定できない", [cmp.operations[1].unresolved.length > 0, c("git switch dev/other && git commit -m x").operations[1].unresolved.length > 0], [true, true]);
  eq("enforcement/1.4 ブランチを変えない複合は確定できる", [c("git add -A && git commit -m x && git push origin dev/foo").operations.map((o) => o.unresolved.length), c("git add -A && git commit -m x && git push origin dev/foo").compound], [[0, 0, 0], true]);
  eq("enforcement/2.8 push と別の変更が並ぶ場合の compound。照会だけの並びは compound にしない", [c("git status && git log && git diff").compound, c("git commit -m x").compound], [false, false]);
  eq("enforcement/1.4 ; || | & で区切られた操作も取り出す", [c("git push origin main; git status").operations.map((o) => o.kind), c("false || git push origin main").operations.map((o) => o.kind), c("git push origin main | tail -1").operations.map((o) => o.kind), c("(cd /tmp; true) && git push origin main").operations.length], [["push", "query"], ["push"], ["push"], 1]);
  eq("enforcement/1.4 サブシェル・コマンド置換・bash -c・eval の中の git も見る", [c("$(git push origin main)").operations.length, c("echo `git push origin main`").operations.length, c(`bash -c 'git push origin main'`).operations.map((o) => o.kind), c(`eval "git push origin main"`).operations.map((o) => o.kind), c("(git push origin main)").operations.length], [1, 1, ["push"], ["push"], 1]);
  eq("enforcement/1.4 env・command・timeout 経由の git も見る", ["env FOO=1 git push origin main", "command git push origin main", "timeout 5 git push origin main", "sudo git push origin main"].map((x) => first(x)?.kind), ["push", "push", "push", "push"]);
  eq("enforcement/1.4 xargs・find -exec 経由の git は確定できない", [first("echo main | xargs git push origin").unresolved.length > 0, first("find . -exec git push origin main ;").unresolved.length > 0], [true, true]);
  eq("enforcement/1.4 GIT_DIR・--git-dir・-c remote.* で対象が変わる形は確定できない", [first("GIT_DIR=/x git push origin main").unresolved.length > 0, first("git --git-dir=/x push origin main").unresolved.length > 0, first("git -c remote.origin.pushurl=/x push origin main").unresolved.length > 0, c("export GIT_WORK_TREE=/x; git push origin main").operations[0].unresolved.length > 0], [true, true, true, true]);
  eq("enforcement/1.4 エイリアス・未知のサブコマンドは判定不能な操作として識別する", (() => { gitOut(d, "config", "alias.pp", "push origin main"); const a = first("git pp"); const u = first("git frobnicate"); gitOut(d, "config", "--unset", "alias.pp"); return [a.kind, a.unresolved.length > 0, u.kind, u.unresolved.length > 0]; })(), ["unparseable", true, "unparseable", true]);
  eq("enforcement/1.4 cd の先が展開・存在しない場合は作業ディレクトリを確定できない", [first("cd $X && git push origin main").unresolved.length > 0, first("cd /nonexistent-brw-dir && git push origin main").unresolved.length > 0, first(`git worktree add ../w2 -b dev/z && cd ../w2 && git push origin main`, d) !== undefined && c(`git worktree add ../w2 -b dev/z && cd ../w2 && git push origin main`).operations[1].unresolved.length > 0], [true, true, true]);
  eq("enforcement/1.4 未解釈の複雑な構文（未閉じの引用符）は判定不能", c(`git push origin "main`).operations.some((o) => o.unresolved.length > 0), true);

  // ---- 通過（要件 1.5・照会） ----
  eq("enforcement/1.1 正常な照会は判定に回さず通す", [c("git status").passes, c("git log --oneline | head -5").passes, c("git diff HEAD~1 && git branch -a").passes, c("git fetch origin").passes, c("ls -la && node --version").passes], [true, true, true, true, true]);
  eq("enforcement/1.1 git 以外のコマンドは操作にならない", [c("echo git push origin main").operations.length, c("npm run build").operations.length, c("grep git file").operations.length], [0, 0, 0]);
  eq("enforcement/1.5 未導入のリポジトリは変更操作も通す", (() => {
    const plain = mkRepoWithRemote({ branch: "main" });
    const out = [c("git push origin main", plain.dir).passes, c("git commit -m x", plain.dir).passes, c("git switch -c any", plain.dir).passes, c("git push --force origin main", plain.dir).passes, c("git push origin main", plain.dir).operations[0].repoState];
    plain.cleanup();
    return out;
  })(), [true, true, true, true, "unmanaged"]);
  eq("enforcement/1.5 リポジトリ外のディレクトリも通す", [c("git push origin main", tmpdir()).passes, c("git status", tmpdir()).passes], [true, true]);
  eq("enforcement/1.1 導入済みのリポジトリの変更操作は判定に回す", [c("git push origin dev/foo").passes, c("git push origin dev/foo").needsJudgment.length, c("git push origin dev/foo").operations[0].repoState, c("git status").needsJudgment.length], [false, 1, "managed", 0]);
  eq("enforcement/1.4 対象を確定できない変更は undetermined に入る", [c("git push --all").undetermined.length, c("git push origin dev/foo").undetermined.length], [1, 0]);
  eq("enforcement/1.4 作業ディレクトリ不明の変更は通さない", [c("cd $X && git push origin main").passes, c("cd $X && git status").passes], [false, true]);
  eq("enforcement/1.1 宣言が壊れている・導入設定だけのリポジトリは通さない", (() => {
    const bad = mkRepoWithRemote({ branch: "main" });
    writeFileSync(join(bad.dir, ".branch-release-workflow.json"), "{oops");
    const setup = mkRepoWithRemote({ branch: "main" });
    mkdirSync(join(setup.dir, ".claude"));
    writeFileSync(join(setup.dir, ".claude/settings.json"), JSON.stringify({ enabledPlugins: { "branch-release-workflow@x": true } }));
    const out = [c("git push origin main", bad.dir).operations[0].repoState, c("git push origin main", bad.dir).passes, c("git push origin main", setup.dir).operations[0].repoState, c("git push origin main", setup.dir).passes];
    bad.cleanup(); setup.cleanup();
    return out;
  })(), ["invalid", false, "setup-only", false]);
  eq("enforcement/1.1 旧パスだけの宣言のリポジトリも導入済みとして扱う", (() => {
    const legacy = mkRepoWithRemote({ branch: "dev/foo", config: CONFIG, configPath: ".claude/branch-release-workflow.json" });
    const out = c("git push origin dev/foo", legacy.dir).operations[0].repoState;
    legacy.cleanup();
    return out;
  })(), "managed");

  // ---- 差し戻し（ラウンド 1）の回帰テスト ----
  const kinds = (cmd) => c(cmd).operations.map((o) => o.kind);
  const unres = (cmd, i) => (c(cmd).operations[i]?.unresolved.length ?? 0) > 0;
  writeFileSync(join(d, "scr.sh"), "git push origin main\n");
  writeFileSync(join(d, "safe.sh"), "echo hello\n");
  writeFileSync(join(d, "somefile.txt"), "x\n");
  eq("enforcement/1.4 関数定義の本文の git も取り出す", ["function f { git push origin main; }; f", "function f() { git push origin main; }; f", "f() { git push origin main; }; f"].map((x) => [kinds(x), c(x).passes]), Array(3).fill([["push"], false]));
  eq("enforcement/1.4 bash -c・eval・$()・バッククォートの中の切り替えは後続の操作に引き継ぐ", [
    "bash -c 'git switch main' && git commit -m x", "eval 'git switch main'; git commit -m x", "echo $(git switch main) && git commit -m x",
    "echo `git switch main`; git commit -m x", "bash -c 'git switch main'; git push origin HEAD",
  ].map((x) => unres(x, x.includes("$(") || x.includes("`") ? 1 : 1)), Array(5).fill(true));
  eq("enforcement/1.4 eval の中の cd は後続の作業ディレクトリに反映する", [c("eval 'cd /tmp'; git push origin main").operations[0].repoState, unres("eval 'cd /nonexistent-brw-dir'; git push origin main", 0), unres("bash -c 'export GIT_DIR=/x'; git push origin main", 0)], ["outside", true, true]);
  eq("enforcement/1.2 checkout -t・--track・switch --track は追跡ブランチの作成", ["git checkout -t origin/main", "git checkout --track origin/main", "git switch --track origin/main"].map((x) => [first(x).kind, first(x).action, first(x).branch]), Array(3).fill(["create", "create", "main"]));
  eq("enforcement/1.2 branch --track・-t は新しい名前を作成対象にする", ["git branch --track dev/q origin/main", "git branch -t dev/q origin/main"].map((x) => [first(x).action, first(x).branch]), Array(2).fill(["create", "dev/q"]));
  eq("enforcement/1.1 ファイルの復元は照会として扱う", ["git checkout somefile.txt", "git checkout -f somefile.txt", "git checkout dev/other somefile.txt"].map((x) => first(x).kind), Array(3).fill("query"));
  eq("enforcement/1.4 ブランチでもファイルでもない checkout 先は理由つきで確定できない", [first("git checkout -f no-such-name").kind, first("git checkout -f no-such-name").unresolved.length > 0], ["create", true]);
  eq("enforcement/1.4 シェルへ渡る標準入力・スクリプトの git は確定できない", [
    "echo 'git push origin main' | bash", "bash <<< 'git push origin main'", "bash scr.sh", "source scr.sh", ". scr.sh", "bash missing.sh", "cat scr.sh | bash", "bash < scr.sh",
  ].map((x) => c(x).passes), Array(8).fill(false));
  eq("enforcement/1.1 git を含まない内容のシェル実行は通す", [c("bash safe.sh").passes, c("echo hello | bash").passes], [true, true]);
  eq("enforcement/2.8 --prune は削除、--follow-tags はタグとして区別する", [first("git push --prune origin dev/foo").flags.delete, first("git push --prune origin dev/foo").normal, first("git push --follow-tags origin dev/foo").flags.tags, first("git push --follow-tags origin dev/foo").normal], [true, false, true, false]);
  eq("enforcement/1.4 fetch・pull でローカルのブランチを更新する形は通常の照会にしない", ["git fetch origin main:main", "git fetch . dev/foo:main", "git fetch origin +dev/foo:dev/other", "git pull . main"].map((x) => c(x).passes), Array(4).fill(false));
  eq("enforcement/1.1 リモート追跡ブランチだけを更新する fetch は照会", ["git fetch origin", "git fetch origin main", "git fetch origin main:refs/remotes/origin/main"].map((x) => c(x).passes), Array(3).fill(true));
  {
    // 引数なしの fetch は remote.<名前>.fetch の設定に従うため、設定がローカルのブランチを指す場合は通さない
    const fx = mkRepoWithRemote({ branch: "dev/foo", config: CONFIG });
    const viaCfg = () => ["git fetch", "git fetch origin"].map((x) => c(x, fx.dir).passes);
    const before = viaCfg();
    gitOut(fx.dir, "config", "--add", "remote.origin.fetch", "+refs/heads/*:refs/heads/*");
    const after = viaCfg();
    fx.cleanup();
    eq("enforcement/1.4 remote.<名前>.fetch がローカルのブランチを指す設定では引数なしの fetch を通さない", [before, after], [[true, true], [false, false]]);
  }
  eq("enforcement/1.4 -c core.worktree など対象を変えうる設定は確定できない", [unres("git -c core.worktree=/x push origin main", 0), unres("git -c core.hooksPath=/x commit -m x", 0)], [true, true]);

  r.cleanup();
};
