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
  // commit の通常形（15.2・要件 2.14）。flags は commit だけが持つ
  const cflags = (cmd) => first(cmd)?.flags;
  const normalOf = (cmd) => cflags(cmd)?.normal;
  eq("enforcement/2.14 通常形の commit は normal になる", [
    "git commit -m x", "git commit -m \"fix: x\"", "git commit -am 'fix: x'", "git commit -s -m x", "git commit -mx", "git commit -mn",
    "git commit --message=x", "git commit -m 'literal $X'", "git commit -m \"$(cat <<'EOF'\nfix: x\nEOF\n)\"",
    "git commit -F - <<'EOF'\nfix\nEOF\n",
  ].map(normalOf), [true, true, true, true, true, true, true, true, true, true]);
  eq("enforcement/2.14 クォートした heredoc の本文は展開されず、通常形として判定する", [c("git commit -m \"$(cat <<'EOF'\n$(git push origin main) $X\nEOF\n)\"").operations.map((o) => o.kind), normalOf("git commit -m \"$(cat <<'EOF'\n$(git push origin main) $X\nEOF\n)\"")], [["commit"], true]);
  eq("enforcement/2.14 --amend・--no-verify・-n（束ねた形を含む）を印として持つ", [
    cflags("git commit --amend -m x")?.amend, cflags("git commit -m x")?.amend,
    cflags("git commit --no-verify -m x")?.noVerify, cflags("git commit -n -m x")?.noVerify, cflags("git commit -nm x")?.noVerify, cflags("git commit -an -m x")?.noVerify,
    cflags("git commit -mn")?.noVerify, cflags("git commit -m x")?.noVerify,
  ], [true, false, true, true, true, true, false, false]);
  eq("enforcement/2.14 除外形は normal にならない（amend・noVerify）", ["git commit --amend -m x", "git commit --no-verify -m x", "git commit -n -m x", "git commit -nm x"].map(normalOf), [false, false, false, false]);
  eq("enforcement/2.14 設定の上書き（-c・--config-env）と環境変数の前置は印を持ち normal にならない", [
    cflags("git -c user.name=x commit -m x")?.configOverride, cflags("git --config-env=user.name=X commit -m x")?.configOverride, cflags("git commit -m x")?.configOverride,
    cflags("FOO=bar git commit -m x")?.envAssign, cflags("env FOO=bar git commit -m x")?.envAssign, cflags("git commit -m x")?.envAssign,
    ...["git -c user.name=x commit -m x", "git --config-env=user.name=X commit -m x", "FOO=bar git commit -m x", "env FOO=bar git commit -m x"].map(normalOf),
  ], [true, true, false, true, true, false, false, false, false, false]);
  eq("enforcement/2.14 メッセージに展開を含むものは normal にならない", [
    "git commit -m \"$VAR\"", "git commit -m \"$(date)\"", "git commit -m \"`date`\"", "git commit -m \"x$(date)\"", "git commit -m $X",
    "git commit -m \"$((1+1))\"", "git commit -m \"$(cat <<EOF\nfix\nEOF\n)\"", "git commit -m \"$(cat <<'EOF'\nfix\nEOF\n)\" -m \"$(date)\"",
    "git commit -m *", "git commit -F msg.txt", "git commit -F - <<EOF\nfix $HOME\nEOF\n", "echo fix | git commit -F -", "git commit -m x $(date)",
    "git commit -t tpl -m x", "git commit --bogus -m x", "git commit -m",
  ].map(normalOf), Array(16).fill(false));
  // レビュー指摘の穴（置換の語分割・リダイレクト・1 語の複数展開・fd 指定・前方一致）
  eq("enforcement/2.14 引用されていない置換・一部だけの引用・前後に文字がある置換は normal にならない", [
    "git commit -m $(cat <<'EOF'\nx --amend\nEOF\n)", "git commit -m x$(cat <<'EOF'\nx\nEOF\n)", "git commit -m \"$(cat <<'EOF'\nx\nEOF\n)\"suffix", "git commit -m \"pre $(cat <<'EOF'\nx\nEOF\n)\"",
  ].map(normalOf), [false, false, false, false]);
  eq("enforcement/2.14 commit のリダイレクトは -F - の引用 heredoc 1 つ以外は normal にならない", [
    "git commit -m x <<EOF\n$(git push origin main)\nEOF\n", "git commit -m x >$(date)", "git commit -F - 3<<'EOF'\nx\nEOF\n", "git commit -m \"$(cat <<'EOF'\nx\nEOF\n)\" 2>&1", "git commit -m x <<'EOF'\nx\nEOF\n",
  ].map(normalOf), [false, false, false, false, false]);
  eq("enforcement/2.14 1 語に複数の展開や余分な文字が混ざる -m は normal にならない", [
    "git commit -m \"$(cat <<'EOF'\nx\nEOF\n)$((1+$(date)))\"", "git commit -m \"$(cat <<'EOF'\nx\nEOF\n)$(date)\"", "git commit -m \"$(cat <<'EOF'\nx\nEOF\n)\" -m \"$MSG\"", "git commit -m \"$MSG\" -m \"$(cat <<'EOF'\nx\nEOF\n)\"",
  ].map(normalOf), [false, false, false, false]);
  eq("enforcement/2.14 展開付きの --message= と $'...'、前方一致の未知オプションは normal にならない", [
    "git commit --message=$(cat <<'EOF'\nx\nEOF\n)", "git commit --message=\"$(cat <<'EOF'\nx\nEOF\n)\"", "git commit -m $'x --amend'", "git commit -m x --no-v", "git commit --am -m x", "git commit -m x --amendx",
  ].map(normalOf), [false, false, false, false, false, false]);
  eq("enforcement/2.14 複数の commit は各操作ごとに判定し、引用 heredoc の複数の -m は通常形として判定する", [c("git commit -m a && git commit --amend -m b").operations.map((o) => o.flags?.normal), c("git commit -m \"$(cat <<'EOF'\nx\nEOF\n)\" -m \"$(cat <<'EOF'\ny\nEOF\n)\"").operations.map((o) => o.flags?.normal), normalOf("git commit -anm x")], [[true, false], [true], false]);
  eq("enforcement/2.14 git -C と -c の組み合わせは設定の上書きとして判定する", [cflags(`git -C ${d} -c k=v commit -m x`)?.configOverride, normalOf(`git -C ${d} -c k=v commit -m x`)], [true, false]);
  // 設定の上書き: -c は値が同じ語に結合した形（-cKEY=VAL）でも configOverride とし、通常にしない
  eq("enforcement/2.14 -c の結合形（-cKEY=VAL）と --config-env の結合形は設定の上書きとして判定する", [
    cflags("git -cuser.name=x commit -m x")?.configOverride, normalOf("git -cuser.name=x commit -m x"),
    cflags("git --config-env=user.name=X commit -m x")?.configOverride, normalOf("git --config-env=user.name=X commit -m x"),
    cflags("git -c user.name=x commit -m x")?.configOverride, normalOf("git -c user.name=x commit -m x"),
  ], [true, false, true, false, true, false]);
  // wrapper（env・nice など）経由の commit は通常にしない。command だけ引数を変えないので通常のまま
  eq("enforcement/2.14 wrapper（env・nice・timeout など）経由の commit は通常にしない", [
    "env -i git commit -m x", "nice git commit -m x", "timeout 5 git commit -m x", "sudo git commit -m x", "exec git commit -m x",
    "time git commit -m x", "command -p git commit -m x", "env -u$VAR git commit -m x",
  ].map(normalOf), Array(8).fill(false));
  eq("enforcement/2.14 command だけの wrapper は引数を変えないので通常のまま", [normalOf("command git commit -m x")], [true]);
  // env の作業ディレクトリ・分割文字列の変更（結合形を含む）は対象を確定できない（unparseable）
  eq("enforcement/2.14 env の --chdir・-C・-S（結合形を含む）は対象を確定できない", [
    "env --chdir=/tmp git commit -m x", "env -C/tmp git commit -m x", "env -C /tmp git commit -m x", "env --split-string=git commit -m x", "env -S'git commit -m x'",
  ].map((cmd) => first(cmd)?.kind), Array(5).fill("unparseable"));
  // 回帰: env の後ろの git が持つ -C は env の作業ディレクトリ変更ではない。従来どおり対象を解決する（HEAD と同じ種類・対象）
  eq("enforcement/3 env の後ろの git の -C は解決する（env 自身の -C と区別する）", [
    first("env git -C . push origin HEAD")?.kind, first("env git -C . merge topic")?.kind, first("env git -C . rebase main")?.kind, first("env git -C . commit -m x")?.kind,
    first("env git -C . commit -m x")?.branch,
  ], ["push", "merge", "commit", "commit", "dev/foo"]);
  // heredoc は宣言したコマンド（<< を持つ項目）に結び付ける。後ろの commit の -F - は、自分の heredoc が無ければ通常にしない
  eq("enforcement/2.14 heredoc は宣言したコマンドに結び付き、後ろの commit の -F - を通常にしない", [
    normalOf("cat <<'EOF'; git commit -F -\nx\nEOF\n"), normalOf("git commit -F - ; cat <<'EOF'\nx\nEOF\n"),
    normalOf("cat <<'EOF' | git commit -F -\nx\nEOF\n"), normalOf("git commit -F - <<'EOF'\nx\nEOF\n"), normalOf("git commit -m x ; cat <<'EOF'\nx\nEOF\n"),
    // 展開されるヒアドキュメントをシェルへ渡す commit は通常にしない。区切りをクォートしたものは本文が展開されないので通常のまま
    normalOf("cat <<EOF | sh\ngit commit -m x\nEOF\n"), normalOf("cat <<'EOF' | sh\ngit commit -m x\nEOF\n"),
  ], [false, false, false, true, true, false, true]);
  // env の長いオプションの省略形（--chd・--c・--s など）も、env 自身の作業ディレクトリ変更・環境変更として対象を確定できない
  eq("enforcement/4 env の長いオプションの省略形は対象を確定できない（push・merge を含む）", [
    "env --chd=/tmp git push origin main", "env --chd /tmp git push origin main", "env --c=/tmp git merge topic", "env --s=x git push origin main",
    "env --unset=HOME git push origin main", "env --chdir=/tmp git merge topic",
  ].map((cmd) => first(cmd)?.kind), Array(6).fill("unparseable"));
  // 先頭オプションの値（-C）に引用なしのチルダ展開があれば通常にしない。対象の解決は従来どおり（HOME を repo に向けて確かめる）
  {
    const savedHome = process.env.HOME;
    process.env.HOME = d;
    try {
      eq("enforcement/2.14 -C の引用なしのチルダ展開は通常にしない（引用された形は通常のまま）", [
        normalOf("git -C ~ commit -m x"), normalOf("git -C ~/. commit -m x"), normalOf(`git -C '${d}' commit -m x`), normalOf(`git -C ${d} commit -m x`),
      ], [false, false, true, true]);
    } finally {
      if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    }
  }
  // 再レビュー指摘: 位置引数のワイルドカード（--の後を含む）、置換の中の副作用（リダイレクト・余分な引数・連結）
  eq("enforcement/2.14 位置引数のワイルドカード（--の後を含む）は normal にならない", [
    "git commit -m x *", "git commit -m x -- *", "git commit -m x -- $X", "git commit -m x -*",
  ].map(normalOf), [false, false, false, false]);
  eq("enforcement/2.14 置換の中の cat に余分なリダイレクト・引数・連結があれば normal にならない", [
    "git commit -m \"$(cat <<'EOF' > /tmp/sideeffect\nx\nEOF\n)\"", "git commit -m \"$(cat <<'EOF' 2>/dev/null\nx\nEOF\n)\"", "git commit -m \"$(cat 3<<'EOF'\nx\nEOF\n)\"",
    "git commit -m \"$(cat <<'EOF' extra\nx\nEOF\n)\"", "git commit -m \"$(cat <<'EOF' && rm x\nx\nEOF\n)\"", "git commit -m \"$(cat <<'EOF'\nx\nEOF\n; rm x)\"",
    "git commit -m \"$(cat <<'EOF' & \nx\nEOF\n)\"", "git commit -m \"$(cat <<'EOF' ; rm x\nx\nEOF\n)\"",
  ].map(normalOf), [false, false, false, false, false, false, false, false]);
  eq("enforcement/2.14 展開を含むメッセージと未対応の -F は messageNormal で区別する",[cflags("git commit -m \"$VAR\"")?.messageNormal, cflags("git commit -F - <<EOF\nfix $HOME\nEOF\n")?.messageNormal, cflags("git commit -m \"$(cat <<'EOF'\nfix\nEOF\n)\"")?.messageNormal], [false, false, true]);
  // 許可リスト式（15.2 の作り直し）: 通常形と証明できたものだけ normal にする。正例・負例を表で並べる
  const normalTable = (label, cmds, expected) => eq(label, cmds.map(normalOf), cmds.map(() => expected));
  normalTable("enforcement/2.14 許可リスト: 通常にすべき実用形（メッセージの出所が静的）", [
    "git commit -m \"msg\"", "git commit -m 'msg'", "git commit -m \"line1\\nline2\"", "git commit -m \"a\nb\"",
    "git commit -m \"$(cat <<'EOF'\nfix: x\n本文\nEOF\n)\"", "git commit -m \"a\" -m 'b'",
    "git commit -m \"$(cat <<'EOF'\na\nEOF\n)\" -m \"$(cat <<'EOF'\nb\nEOF\n)\"",
    "git commit -F - <<'EOF'\n本文\nEOF\n", "git commit -a -s -q -v -m x", "git commit --allow-empty -m x",
    "git commit --author=\"Name <a@example.com>\" -m x", "git commit --date=2020-01-01T00:00:00 -m x",
    "git commit -m \"msg\" -- path/to/file", "git commit -m msg -- '/abs/path'", "git commit -m \"~\"", "git commit -m '$HOME'",
    "git commit -m \"\\$X\"", "git commit -m \\~", "git commit -m hello", "git commit -m x --gpg-sign=KEY",
  ], true);
  normalTable("enforcement/2.14 許可リスト: 通常にしてはならない形（メッセージが無い・出所が別・対話・展開）", [
    "git commit", "git commit -- -m hello", "git commit -C HEAD", "git commit -c HEAD", "git commit --reuse-message=HEAD",
    "git commit --reedit-message HEAD", "git commit --fixup HEAD", "git commit --squash HEAD", "git commit -m ok --fixup HEAD",
    "git commit -t tpl -m x", "git commit --template=tpl -m x", "git commit -e -m ok", "git commit --edit -m ok",
    "git commit -e -m \"$(cat <<'EOF'\nfix\nEOF\n)\"",
    "git commit -m ~", "git commit --author ~ -m x", "git commit -m x -- ~/file", "git commit -m x -- ~",
    "git commit -m $\"hello\"", "git commit -m $'x'", "git commit -m \"a\"'b'", "git commit -m hello!world", "git commit -m \"hello!world\"",
    "git commit -m hello\\ world", "git commit -nm x", "git commit -anm x", "git commit --amend -m x", "git commit --no-verify -m x",
    "git commit --no-v -m x", "git commit --am -m x", "git -cuser.name=x commit -m ok", "git -c user.name=x commit -m ok",
    "git commit -m x -S$KEY", "git commit -m x --author=~", "git commit -m \"$(cat <<'EOF'\nx\nEOF\n)\" --author ~", "git commit -F msg.txt",
  ], false);

  // ---- 作成・再開 ----
  eq("enforcement/1.2 ブランチの作成を分類する", ["git switch -c dev/n", "git checkout -b dev/n", "git branch dev/n", "git switch --create dev/n main", "git checkout --orphan dev/n"].map((x) => [first(x).kind, first(x).action, first(x).branch]), Array(5).fill(["create", "create", "dev/n"]));
  // 開始点（start）と「切り替えない作成」（branchOnly）を分類に持たせる。判定の挙動は変えない
  const startCases = [
    ["git switch -c dev/n origin/develop", "origin/develop", false],
    ["git switch -c dev/n", null, false],
    ["git switch --create=dev/n main", "main", false],
    ["git switch -c dev/n --track origin/develop", "origin/develop", false],
    ["git checkout -b dev/n develop", "develop", false],
    ["git checkout -b dev/n", null, false],
    ["git branch dev/n", null, true],
    ["git branch dev/n develop", "develop", true],
    ["git worktree add ../w -b dev/n", null, false],
    ["git worktree add ../w -b dev/n develop", "develop", false],
    ["git switch dev/other", null, false],
    // 作成フラグより前に開始点がある形（レビュー指摘 1）
    ["git switch main -c dev/n", "main", false],
    ["git checkout main -b dev/n", "main", false],
    ["git switch main --create=dev/n", "main", false],
    ["git switch --conflict merge -c dev/n", null, false],
    ["git switch -c dev/n --conflict merge", null, false],
    // 追跡ブランチの作成では、明示された追跡元を開始点にする（レビュー指摘 2）
    ["git switch --track origin/main", "origin/main", false],
    ["git checkout --track origin/main", "origin/main", false],
    ["git checkout -t origin/main", "origin/main", false],
  ];
  eq("enforcement/1.1 作成の開始点と切り替えない作成を分類に持たせる", startCases.map(([x]) => [first(x).start, first(x).branchOnly]), startCases.map(([, s, b]) => [s, b]));
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
