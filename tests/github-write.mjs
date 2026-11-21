// GitHub への書き込み経路（gh と MCP）の識別（brw-enforcement 2.2）の契約テスト。selftest.mjs から呼ばれる。
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyCommand, classifyMcpCall } from "../scripts/operation-policy.mjs";
import { gitOut, mkRepoWithRemote } from "./support/git-fixture.mjs";
import { hookInput } from "./support/hook-fixtures.mjs";

const CONFIG = { workBranches: ["dev/*"], protectedBranches: ["main"], baseBranch: "develop" };

export const runGithubWriteChecks = async (eq) => {
  // 手元の環境変数に結果を左右されないようにする
  const saved = { GH_REPO: process.env.GH_REPO, GH_HOST: process.env.GH_HOST };
  delete process.env.GH_REPO;
  delete process.env.GH_HOST;
  const r = mkRepoWithRemote({ branch: "dev/foo", config: CONFIG });
  const d = r.dir;
  gitOut(d, "remote", "set-url", "origin", "https://github.com/acme/app.git");
  writeFileSync(join(d, "scr.sh"), "gh pr merge 1 -R a/b\n");
  const c = (cmd, cwd = d) => classifyCommand(cmd, cwd);
  const first = (cmd, cwd = d) => c(cmd, cwd).operations[0];
  const kinds = (cmd) => c(cmd).operations.map((o) => o.kind);
  const repoOf = (o) => o.repository && `${o.repository.host}/${o.repository.owner}/${o.repository.name}`;
  const bad = (o) => o.unresolved.length > 0;

  // ---- gh pr create ----
  const pc = first("gh pr create --head dev/foo --base main --title t --body b");
  eq("enforcement/2.6 gh pr create は head・base・対象リポジトリを確定する", [pc.kind, pc.head, pc.base, repoOf(pc), pc.repositorySource, pc.repoMatchesCwd, pc.unresolved], ["pr-create", { owner: null, branch: "dev/foo" }, "main", "github.com/acme/app", "remote", true, []]);
  eq("enforcement/2.6 短いオプションと -R で別のリポジトリを指せる", (() => { const o = first("gh pr create -H dev/foo -B main -R other/repo -t t"); return [o.head.branch, o.base, repoOf(o), o.repositorySource, o.repoMatchesCwd]; })(), ["dev/foo", "main", "github.com/other/repo", "flag", false]);
  eq("enforcement/2.6 --head を省くと現在のブランチ、owner:branch は head の持ち主を分ける", [first("gh pr create --base main -t t").head, first("gh pr create --base main --head fork:dev/x -t t").head], [{ owner: null, branch: "dev/foo" }, { owner: "fork", branch: "dev/x" }]);
  eq("enforcement/1.4 base を確定できない gh pr create は対象不明として返す", [bad(first("gh pr create --head dev/foo --title t")), first("gh pr create --head dev/foo --title t").base], [true, null]);
  gitOut(d, "config", "branch.dev/foo.gh-merge-base", "main");
  eq("enforcement/2.6 branch.<名前>.gh-merge-base は base として使う", [first("gh pr create --head dev/foo -t t").base, bad(first("gh pr create --head dev/foo -t t"))], ["main", false]);
  gitOut(d, "config", "--unset", "branch.dev/foo.gh-merge-base");
  eq("enforcement/2.6 --dry-run も PR 作成として扱い、push の可能性を示す", [first("gh pr create --dry-run --base main -t t").kind, first("gh pr create --dry-run --base main -t t").dryRun, first("gh pr create --base main -t t").mayPush], ["pr-create", true, true]);
  eq("enforcement/1.4 未対応のオプション・位置引数・展開を含む gh pr create は確定できない", [bad(first("gh pr create --bogus --base main --head x")), bad(first("gh pr create stray --base main --head x")), bad(first("gh pr create --base $B --head x"))], [true, true, true]);
  gitOut(d, "checkout", "-q", "--detach");
  eq("enforcement/1.4 detached HEAD で --head を省いた gh pr create は head を確定できない", [bad(first("gh pr create --base main -t t")), first("gh pr create --base main -t t").head], [true, null]);
  gitOut(d, "checkout", "-q", "dev/foo");

  // ---- gh pr merge ----
  const pm = first("gh pr merge 5 --squash");
  eq("enforcement/3.2 gh pr merge は GitHub マージとして識別する", [pm.kind, pm.pr, pm.method, repoOf(pm), pm.unresolved], ["github-merge", { number: 5, selector: "5" }, "squash", "github.com/acme/app", []]);
  eq("enforcement/3.2 gh pr merge --auto は自動マージ予約として区別する", ["gh pr merge 5 --auto", "gh pr merge --auto --squash 5", "gh pr merge --squash --auto", "gh pr merge 5 --auto=true"].map((x) => first(x).kind), Array(4).fill("auto-merge"));
  eq("enforcement/3.2 PR の URL から対象リポジトリと番号を取る", (() => { const o = first("gh pr merge https://github.com/x/y/pull/9 -m"); return [o.kind, repoOf(o), o.pr.number, o.repositorySource, o.method]; })(), ["github-merge", "github.com/x/y", 9, "url", "merge"]);
  eq("enforcement/3.2 --disable-auto は予約の解除で、未対応の書き込みとして返す", [first("gh pr merge 5 --disable-auto").kind, first("gh pr merge 5 --disable-auto").action], ["unsupported-write", "disable-auto-merge"]);
  eq("enforcement/3.2 マージの対象 PR が複数・未対応のオプションなら確定できない", [bad(first("gh pr merge 5 6")), bad(first("gh pr merge 5 --bogus"))], [true, true]);

  // ---- gh api（REST）----
  const ap = first("gh api repos/acme/app/pulls -f title=t -f head=dev/foo -f base=main");
  eq("enforcement/2.6 gh api の POST pulls は PR 作成として head・base を取る", [ap.kind, ap.head, ap.base, repoOf(ap), ap.unresolved], ["pr-create", { owner: null, branch: "dev/foo" }, "main", "github.com/acme/app", []]);
  eq("enforcement/2.6 -X と -f の形のいろいろ", ["gh api -X POST repos/acme/app/pulls -F head=dev/foo -F base=main -F title=t", "gh api --method POST /repos/acme/app/pulls --raw-field head=dev/foo --field base=main -f title=t", "gh api --method=post repos/acme/app/pulls -f head=dev/foo -f base=main -f title=t", "gh api -XPOST repos/acme/app/pulls -f head=dev/foo -f base=main -f title=t"].map((x) => [first(x).kind, first(x).base]), Array(4).fill(["pr-create", "main"]));
  eq("enforcement/1.4 head・base・title が欠けた PR 作成 API は確定できない", ["gh api repos/acme/app/pulls -f title=t -f head=dev/foo", "gh api repos/acme/app/pulls -f title=t -f base=main", "gh api repos/acme/app/pulls -f head=dev/foo -f base=main"].map((x) => [first(x).kind, bad(first(x))]), Array(3).fill(["pr-create", true]));
  eq("enforcement/3.2 PUT pulls/N/merge と POST merges は GitHub マージ", ["gh api --method PUT repos/acme/app/pulls/5/merge", "gh api -XPUT repos/acme/app/pulls/5/merge -f merge_method=squash", "gh api --method=PUT repos/acme/app/pulls/5/merge --input body.json"].map((x) => first(x).kind), Array(3).fill("github-merge"));
  eq("enforcement/3.2 ブランチのマージ API も GitHub マージ", [first("gh api repos/acme/app/merges -f base=main -f head=dev/foo").kind, first("gh api repos/acme/app/merges -f base=main -f head=dev/foo").branchMerge, bad(first("gh api repos/acme/app/merges -f base=main"))], ["github-merge", true, true]);
  eq("enforcement/1.1 GET と、フィールド付きでも -X GET の gh api は照会", ["gh api repos/acme/app/pulls", "gh api repos/acme/app/pulls -X GET -f state=open", "gh api --method GET repos/acme/app/pulls/5/merge", "gh api user"].map((x) => c(x).passes), Array(4).fill(true));
  eq("enforcement/2.6 {owner}・{repo}・:owner は作業ディレクトリのリポジトリで補う", (() => { const o = first("gh api repos/{owner}/{repo}/pulls/5/merge -X PUT"); const p = first("gh api repos/:owner/:repo/pulls -f head=dev/foo -f base=main -f title=t"); return [o.kind, repoOf(o), o.repositorySource, p.kind, repoOf(p)]; })(), ["github-merge", "github.com/acme/app", "placeholder", "pr-create", "github.com/acme/app"]);
  eq("enforcement/2.6 URL 形式のエンドポイントはホストとリポジトリを URL から取る", (() => { const o = first("gh api https://ghe.example.com/api/v3/repos/a/b/pulls/3/merge -X PUT"); return [o.kind, repoOf(o)]; })(), ["github-merge", "ghe.example.com/a/b"]);
  eq("enforcement/1.4 プレースホルダーを補えないとき（リモートなし）は確定できない", (() => { const nr = mkRepoWithRemote({ branch: "dev/foo", config: CONFIG }); const o = first("gh api repos/{owner}/{repo}/pulls/5/merge -X PUT", nr.dir); nr.cleanup(); return [o.kind, bad(o)]; })(), ["unsupported-write", true]);
  eq("enforcement/2.6 refs・contents など直接の書き込みは refWrite 付きの未対応書き込み", [
    first("gh api repos/acme/app/git/refs/heads/main -X PATCH -f sha=abc -F force=true"), first("gh api repos/acme/app/git/refs -f ref=refs/heads/dev/x -f sha=abc"),
    first("gh api repos/acme/app/contents/a.txt -X PUT -f message=m -f content=Yg== -f branch=main"), first("gh api repos/acme/app/git/refs/heads/dev/x -X DELETE"),
    first("gh api repos/acme/app/pulls/5/update-branch -X PUT"), first("gh api repos/acme/app/branches/main/protection -X DELETE"),
  ].map((o) => [o.kind, o.refWrite, o.branch ?? null]), [["unsupported-write", true, "main"], ["unsupported-write", true, "dev/x"], ["unsupported-write", true, "main"], ["unsupported-write", true, "dev/x"], ["unsupported-write", true, null], ["unsupported-write", true, "main"]]);
  eq("enforcement/1.4 その他の書き込み API は未対応の書き込みとして返す", ["gh api repos/acme/app/issues -f title=x", "gh api repos/acme/app/pulls/5 -X PATCH -f base=main", "gh api repos/acme/app/rulesets -X POST --input r.json", "gh api user/starred/a/b -X PUT", "gh api repos/acme/app/dispatches -F event_type=x"].map((x) => [first(x).kind, c(x).passes]), Array(5).fill(["unsupported-write", false]));
  eq("enforcement/1.4 引数が展開で決まる・エンドポイントが無い gh api は変更として扱う", [first("gh api repos/acme/app/pulls/$N/merge -X PUT"), first("gh api -X PUT"), first("gh api $EP -X POST")].map((o) => [o.kind !== "query", bad(o)]), Array(3).fill([true, true]));
  eq("enforcement/1.4 解釈できない HTTP メソッドは書き込みとして扱う", [first("gh api repos/acme/app/pulls -X BREW").kind, bad(first("gh api repos/acme/app/pulls -X BREW"))], ["unsupported-write", true]);

  // ---- gh api graphql ----
  const gq = (q, ...more) => first(`gh api graphql ${more.join(" ")} -f query='${q}'`);
  eq("enforcement/3.2 GraphQL の mergePullRequest・enablePullRequestAutoMerge を区別する", [
    gq('mutation { mergePullRequest(input:{pullRequestId:"X"}) { clientMutationId } }').kind,
    gq('mutation { enablePullRequestAutoMerge(input:{pullRequestId:"X", mergeMethod: SQUASH}) { clientMutationId } }').kind,
    gq('mutation M($id:ID!) { alias: mergePullRequest(input:{pullRequestId:$id}) { clientMutationId } }').kind,
  ], ["github-merge", "auto-merge", "github-merge"]);
  eq("enforcement/1.4 GraphQL の対象はノード ID のためホスト・リポジトリを確定できない", [bad(gq('mutation { mergePullRequest(input:{pullRequestId:"X"}) { clientMutationId } }')), gq('mutation { mergePullRequest(input:{pullRequestId:"X"}) { clientMutationId } }').repository], [true, null]);
  eq("enforcement/2.6 GraphQL の createPullRequest は head・base を取る（対象リポジトリは確定できない）", (() => {
    const o = gq('mutation { createPullRequest(input:{repositoryId:"R", headRefName:"dev/foo", baseRefName:"main", title:"t"}) { pullRequest { url } } }');
    const v = first("gh api graphql -F headRefName=dev/foo -F baseRefName=main -f query='mutation($headRefName:String!,$baseRefName:String!){ createPullRequest(input:{repositoryId:\"R\", headRefName:$headRefName, baseRefName:$baseRefName, title:\"t\"}) { pullRequest { url } } }'");
    return [o.kind, o.head, o.base, bad(o), v.head, v.base];
  })(), ["pr-create", { owner: null, branch: "dev/foo" }, "main", true, { owner: null, branch: "dev/foo" }, "main"]);
  eq("enforcement/1.4 head・base が確定できない GraphQL の createPullRequest は対象不明", (() => { const o = gq('mutation($h:String!){ createPullRequest(input:{repositoryId:"R", headRefName:$h, baseRefName:"main", title:"t"}) { pullRequest { url } } }'); return [o.kind, o.head, o.unresolved.some((x) => x.includes("headRefName"))]; })(), ["pr-create", null, true]);
  eq("enforcement/2.6 知らない変異・ブランチを動かす変異は未対応の書き込み", [gq("mutation { addStar(input:{starrableId:\"X\"}) { clientMutationId } }"), gq("mutation { updateRef(input:{refId:\"X\", oid:\"abc\"}) { clientMutationId } }"), gq("mutation { createCommitOnBranch(input:{}) { clientMutationId } }")].map((o) => [o.kind, o.refWrite]), [["unsupported-write", false], ["unsupported-write", true], ["unsupported-write", true]]);
  eq("enforcement/1.1 変異を含まない GraphQL は照会", [c("gh api graphql -f query='query { viewer { login } }'").passes, c("gh api graphql -f query='{ repository(owner:\"a\", name:\"b\") { id } }'").passes], [true, true]);
  eq("enforcement/3.2 1 つのクエリの複数の変異をすべて返す", c("gh api graphql -f query='mutation { a: mergePullRequest(input:{pullRequestId:\"X\"}) { clientMutationId } b: enablePullRequestAutoMerge(input:{pullRequestId:\"X\"}) { clientMutationId } }'").operations.map((o) => o.kind), ["github-merge", "auto-merge"]);
  writeFileSync(join(d, "q.graphql"), "mutation { mergePullRequest(input:{pullRequestId:\"X\"}) { clientMutationId } }");
  writeFileSync(join(d, "in.json"), JSON.stringify({ query: "mutation { enablePullRequestAutoMerge(input:{pullRequestId:\"X\"}) { clientMutationId } }" }));
  writeFileSync(join(d, "ro.graphql"), "query { viewer { login } }");
  eq("enforcement/3.2 -F query=@ファイルと --input のクエリも読んで識別する", [first("gh api graphql -F query=@q.graphql").kind, first("gh api graphql --input in.json").kind, c("gh api graphql -F query=@ro.graphql").passes], ["github-merge", "auto-merge", true]);
  eq("enforcement/1.4 読めないクエリ・標準入力・クエリ無しの GraphQL は確定できない", ["gh api graphql -F query=@nothing.graphql", "gh api graphql --input -", "gh api graphql --input nothing.json", "gh api graphql -f foo=bar"].map((x) => [first(x).kind, bad(first(x)), c(x).passes]), Array(4).fill(["unsupported-write", true, false]));

  // ---- その他の gh ----
  eq("enforcement/1.1 gh の照会は通す", ["gh pr view 5", "gh pr list", "gh pr status", "gh pr checks 5", "gh pr diff 5", "gh issue list", "gh repo view", "gh run list", "gh auth status", "gh --version", "gh search repos x", "gh pr merge --help", "gh browse"].map((x) => c(x).passes), Array(13).fill(true));
  eq("enforcement/2.6 gh pr ready・edit・close・comment などは未対応の書き込み", ["gh pr ready 5", "gh pr edit 5 --base main", "gh pr close 5", "gh pr comment 5 -b x", "gh pr review 5 --approve", "gh pr update-branch 5"].map((x) => [first(x).kind, first(x).action, c(x).passes]), [["unsupported-write", "ready", false], ["unsupported-write", "edit", false], ["unsupported-write", "close", false], ["unsupported-write", "comment", false], ["unsupported-write", "review", false], ["unsupported-write", "update-branch", false]]);
  eq("enforcement/2.6 gh pr update-branch はブランチを動かす書き込み", [first("gh pr update-branch 5").refWrite, first("gh pr ready 5").refWrite], [true, false]);
  eq("enforcement/2.6 gh issue create・repo sync・release create・workflow run などは未対応の書き込み", ["gh issue create -t x", "gh repo sync", "gh release create v1", "gh workflow run x.yml", "gh repo delete a/b --yes", "gh label create x", "gh secret set X"].map((x) => [first(x).kind, first(x).area]), [["unsupported-write", "issue"], ["unsupported-write", "repo"], ["unsupported-write", "release"], ["unsupported-write", "workflow"], ["unsupported-write", "repo"], ["unsupported-write", "label"], ["unsupported-write", "secret"]]);
  eq("enforcement/2.6 repo sync・release create はブランチやタグを動かしうる", [first("gh repo sync").refWrite, first("gh release create v1").refWrite, first("gh issue create -t x").refWrite], [true, true, false]);
  eq("enforcement/1.4 未知の gh サブコマンド（エイリアス・拡張）は確定できない", [first("gh frobnicate x").kind, bad(first("gh frobnicate x")), first("gh $X pr").kind, first("gh pr frob").kind], ["unparseable", true, "unparseable", "unparseable"]);
  eq("enforcement/1.2 gh pr checkout はローカルのブランチ作成として扱い、後続の対象を確定できなくする", (() => { const o = first("gh pr checkout 5 -b dev/x"); const n = first("gh pr checkout 5"); const f = c("gh pr checkout 5 -b dev/x && git push origin HEAD"); return [o.kind, o.branch, bad(o), bad(n), bad(f.operations[1]), c("gh pr checkout 5 --detach").passes]; })(), ["create", "dev/x", false, true, true, true]);

  // ---- 対象リポジトリの確定 ----
  eq("enforcement/1.4 GitHub を指す remote が無い・複数あるときは -R なしの gh を確定できない", (() => {
    const nr = mkRepoWithRemote({ branch: "dev/foo", config: CONFIG });
    const none = first("gh pr merge 5", nr.dir);
    gitOut(nr.dir, "remote", "set-url", "origin", "https://github.com/acme/app.git");
    gitOut(nr.dir, "remote", "add", "up", "git@github.com:upstream/app.git");
    const two = first("gh pr merge 5", nr.dir);
    const explicit = first("gh pr merge 5 -R acme/app", nr.dir);
    gitOut(nr.dir, "config", "remote.up.gh-resolved", "base");
    const resolved = first("gh pr merge 5", nr.dir);
    nr.cleanup();
    return [bad(none), bad(two), bad(explicit), repoOf(resolved), bad(resolved)];
  })(), [true, true, false, "github.com/upstream/app", false]);
  eq("enforcement/1.1 ssh 形式・ssh:// 形式の remote も GitHub として読む", (() => {
    const out = [];
    for (const url of ["git@github.com:acme/app.git", "ssh://git@github.com/acme/app.git", "https://user@github.com/acme/app"]) { gitOut(d, "remote", "set-url", "origin", url); out.push(repoOf(first("gh pr merge 5"))); }
    gitOut(d, "remote", "set-url", "origin", "https://github.com/acme/app.git");
    return out;
  })(), Array(3).fill("github.com/acme/app"));
  eq("enforcement/2.6 GH_REPO・GH_HOST と -R・--hostname でホストとリポジトリを確定する", [
    (() => { const o = first("GH_REPO=a/b gh pr merge 1"); return [repoOf(o), o.repositorySource]; })(),
    repoOf(first("GH_HOST=ghe.example.com GH_REPO=a/b gh pr merge 1")),
    repoOf(first("gh pr merge 1 -R ghe.example.com/a/b")), repoOf(first("GH_HOST=ghe.example.com gh pr merge 1 -R a/b")), repoOf(first("gh pr merge 1 -R https://ghe.example.com/a/b.git")),
    repoOf(first("gh api repos/a/b/pulls/1/merge -X PUT --hostname ghe.example.com")), repoOf(first("GH_REPO=a/b gh pr merge 1 -R c/d")),
  ], [["github.com/a/b", "env"], "ghe.example.com/a/b", "ghe.example.com/a/b", "ghe.example.com/a/b", "ghe.example.com/a/b", "ghe.example.com/a/b", "github.com/c/d"]);
  eq("enforcement/1.4 不正なリポジトリ指定は確定できない", [bad(first("gh pr merge 1 -R not-a-repo")), bad(first("gh pr merge 1 -R a/b/c/d")), bad(first("gh pr merge 1 -R $R"))], [true, true, true]);
  eq("enforcement/1.4 同じコマンド列で GH_REPO・GH_HOST を設定すると確定できない", ["export GH_REPO=a/b && gh pr merge 1", "GH_HOST=ghe.example.com; gh pr merge 1 -R a/b", "bash -c 'export GH_REPO=a/b'; gh pr merge 1"].map((x) => bad(c(x).operations.find((o) => o.kind === "github-merge"))), [true, true, true]);
  eq("enforcement/2.6 -R でホストまで明示すれば設定の影響を受けない", bad(c("export GH_HOST=x; gh pr merge 1 -R ghe.example.com/a/b").operations.find((o) => o.kind === "github-merge")), false);
  process.env.GH_REPO = "env/repo";
  eq("enforcement/2.6 フックのプロセスの GH_REPO も対象に使う", [repoOf(first("gh pr merge 1")), repoOf(first("gh pr merge 1 -R x/y"))], ["github.com/env/repo", "github.com/x/y"]);
  delete process.env.GH_REPO;

  // ---- 実行経路 ----
  eq("enforcement/1.4 env・sudo・bash -c・eval・$() 経由の gh も見る", ["env GH_REPO=a/b gh pr merge 1", "sudo gh pr merge 1 -R a/b", "bash -c 'gh pr merge 1'", "eval 'gh pr merge 1'", "echo $(gh pr merge 1)", "(gh pr merge 1)", "timeout 5 gh pr merge 1", "command gh pr merge 1"].map((x) => kinds(x).includes("github-merge") || kinds(x).includes("unparseable")), Array(8).fill(true));
  eq("enforcement/1.4 env 経由の GH_REPO は対象に反映する", repoOf(first("env GH_REPO=a/b gh pr merge 1")), "github.com/a/b");
  eq("enforcement/1.4 xargs・find 経由・スクリプト・パイプ経由の gh は確定できない", [
    first("echo 1 | xargs gh pr merge").kind, c("echo 'gh pr merge 1' | bash").passes, c("bash scr.sh").passes, c("source scr.sh").passes, c("bash scr.sh").operations[0]?.kind,
  ], ["unparseable", false, false, false, "unparseable"]);
  eq("enforcement/1.1 複合コマンドでは各 gh 操作を取り出す", [c("gh pr create --head dev/foo --base main -t t && gh pr merge --auto").compound, kinds("gh pr create --head dev/foo --base main -t t && gh pr merge --auto")], [true, ["pr-create", "auto-merge"]]);
  eq("enforcement/1.4 関数の中・パスつきの gh も取り出す", [kinds("f() { gh pr merge 1; }; f"), kinds("/usr/bin/gh pr merge 1"), kinds("FOO=1 gh pr merge 1")], [["github-merge"], ["github-merge"], ["github-merge"]]);
  eq("enforcement/1.1 gh を含まない文字列・コメントや引数の gh は操作にしない", [c("echo gh pr merge 1").passes, c("grep -r 'gh pr merge' .").passes, c("git commit -m 'gh pr merge 1'").operations.map((o) => o.kind)], [true, true, ["commit"]]);
  eq("enforcement/1.4 curl・wget で GitHub を書き込みで呼ぶ形は未対応の書き込みにする", [
    c("curl -X PUT https://api.github.com/repos/a/b/pulls/1/merge").passes, c("curl -XPOST -d '{}' https://api.github.com/repos/a/b/pulls").passes, c("curl --data x https://api.github.com/graphql").passes,
    c("curl https://api.github.com/repos/a/b/pulls").passes, c("curl -X GET https://api.github.com/user").passes, c("curl -X POST https://example.com/x").passes,
  ], [false, false, false, true, true, true]);
  eq("enforcement/1.4 curl の連結形（-XPUT・-XPOST・-sXPUT・-d{}）も書き込みとして扱い、-XGET は通す", [
    c("curl -XPUT https://api.github.com/repos/o/r/pulls/1/merge").passes, c("curl -XPOST https://api.github.com/repos/o/r/pulls").passes,
    c("curl -sXPUT https://api.github.com/repos/o/r/pulls/1/merge").passes, c("curl -d{} https://api.github.com/graphql").passes,
    c("curl -XGET https://api.github.com/user").passes, c("curl -sXHEAD https://api.github.com/user").passes, c("curl -sS https://api.github.com/user").passes,
    c("curl -XPUT https://example.com/x").passes,
  ], [false, false, false, false, true, true, true, true]);
  eq("enforcement/1.5 リポジトリ外・未導入のリポジトリでは gh の書き込みも通す", (() => {
    const un = mkRepoWithRemote({ branch: "main" });
    const out = [c("gh pr merge 5 -R a/b", tmpdir()).passes, c("gh pr merge 5 -R a/b", un.dir).passes, first("gh pr merge 5 -R a/b", un.dir).repoState];
    un.cleanup();
    return out;
  })(), [true, true, "unmanaged"]);
  eq("enforcement/1.1 導入済みのリポジトリでは gh の書き込みを判定に回し、対象不明は undetermined に入る", [c("gh pr merge 5 -R a/b").needsJudgment.length, c("gh pr merge 5 -R a/b").undetermined.length, c("gh pr merge 5 -R not-a-repo").undetermined.length, c("gh pr merge 5 -R a/b").operations[0].repoState], [1, 0, 1, "managed"]);

  // ---- MCP ----
  const m = (tool, input, cwd = d) => classifyMcpCall(tool, input, cwd);
  const mo = (tool, input) => m(tool, input).operations[0];
  const cp = mo("mcp__github__create_pull_request", { owner: "acme", repo: "app", title: "t", head: "dev/foo", base: "main", body: "b" });
  eq("enforcement/2.6 MCP の create_pull_request は head・base・リポジトリを確定する", [cp.kind, cp.head, cp.base, repoOf({ repository: cp.repository && { ...cp.repository, host: "h" } }), cp.hostFromTool, cp.repoMatchesCwd, cp.unresolved], ["pr-create", { owner: null, branch: "dev/foo" }, "main", "h/acme/app", false, true, []]);
  eq("enforcement/1.4 MCP の必須入力が欠ける・入力がオブジェクトでないと対象不明", [
    mo("mcp__github__create_pull_request", { owner: "acme", repo: "app", title: "t", head: "dev/foo" }), mo("mcp__github__create_pull_request", { owner: "acme", title: "t", head: "dev/foo", base: "main" }),
    mo("mcp__github__create_pull_request", { owner: "acme", repo: "app", head: "dev/foo", base: "main" }), mo("mcp__github__create_pull_request", null), mo("mcp__github__create_pull_request", "x"),
    mo("mcp__github__merge_pull_request", { owner: "acme", repo: "app" }),
  ].map(bad), Array(6).fill(true));
  eq("enforcement/2.6 head の owner:branch と別リポジトリを識別する", (() => { const o = mo("mcp__github__create_pull_request", { owner: "up", repo: "app", title: "t", head: "me:dev/x", base: "main" }); return [o.head, o.repository.owner, o.repoMatchesCwd]; })(), [{ owner: "me", branch: "dev/x" }, "up", false]);
  eq("enforcement/3.2 MCP のマージと自動マージ予約を区別する", [
    mo("mcp__github__merge_pull_request", { owner: "acme", repo: "app", pullNumber: 5, merge_method: "squash" }), mo("mcp__github__enable_pull_request_auto_merge", { owner: "acme", repo: "app", pullNumber: 5 }),
    mo("mcp__gh__enable_auto_merge", { owner: "acme", repo: "app", pullNumber: 5 }),
  ].map((o) => [o.kind, o.pr.number]), [["github-merge", 5], ["auto-merge", 5], ["auto-merge", 5]]);
  eq("enforcement/2.6 MCP の直接のブランチ・ファイル書き込みは refWrite 付きの未対応書き込み", [
    mo("mcp__github__create_branch", { owner: "acme", repo: "app", branch: "dev/x", from_branch: "main" }), mo("mcp__github__push_files", { owner: "acme", repo: "app", branch: "main", files: [], message: "m" }),
    mo("mcp__github__create_or_update_file", { owner: "acme", repo: "app", path: "a", content: "x", message: "m", branch: "main" }), mo("mcp__github__delete_file", { owner: "acme", repo: "app", path: "a", message: "m", branch: "dev/x" }),
    mo("mcp__github__update_pull_request_branch", { owner: "acme", repo: "app", pullNumber: 5 }),
  ].map((o) => [o.kind, o.refWrite, o.branch ?? null, bad(o)]), [["unsupported-write", true, "dev/x", false], ["unsupported-write", true, "main", false], ["unsupported-write", true, "main", false], ["unsupported-write", true, "dev/x", false], ["unsupported-write", true, null, false]]);
  eq("enforcement/1.4 ブランチを指定しない直接書き込みは対象不明", [bad(mo("mcp__github__push_files", { owner: "acme", repo: "app", files: [], message: "m" })), bad(mo("mcp__github__create_branch", { owner: "acme", repo: "app" }))], [true, true]);
  eq("enforcement/2.6 その他の MCP 書き込み（PR 更新・Issue・fork）は未対応の書き込み", ["update_pull_request", "issue_write", "add_issue_comment", "fork_repository", "create_repository", "pull_request_review_write", "delete_workflow_run"].map((t) => [mo(`mcp__github__${t}`, { owner: "acme", repo: "app" }).kind, m(`mcp__github__${t}`, { owner: "acme", repo: "app" }).passes]), Array(7).fill(["unsupported-write", false]));
  eq("enforcement/1.1 MCP の読み取りツールは通す", ["get_file_contents", "list_pull_requests", "search_code", "pull_request_read", "get_commit", "list_branches", "issue_read"].map((t) => m(`mcp__github__${t}`, { owner: "acme", repo: "app" }).passes), Array(7).fill(true));
  eq("enforcement/1.4 GitHub 系で変更かどうか判断できない MCP ツールは確定できない", [mo("mcp__github__frobnicate", { owner: "acme", repo: "app" }).kind, bad(mo("mcp__github__frobnicate", {})), m("mcp__github__frobnicate", {}).passes], ["unparseable", true, false]);
  eq("enforcement/1.1 MCP の scope: GitHub・Git 系・その他・MCP 以外を区別する", [m("mcp__github__merge_pull_request", {}).scope, m("mcp__gitlab__create_merge_request", { project_id: "1" }).scope, m("mcp__git__git_commit", { repo_path: "/x", message: "m" }).scope, m("mcp__slack__post_message", {}).scope, m("Bash", { command: "ls" }).scope, m("Edit", {}).scope], ["github", "github", "github", "other-mcp", "not-mcp", "not-mcp"]);
  eq("enforcement/1.4 Git 系 MCP のローカル操作も書き込みとして返す", [mo("mcp__git__git_commit", { repo_path: "/x", message: "m" }), mo("mcp__git__git_checkout", { repo_path: "/x", branch_name: "b" }), mo("mcp__git__git_add", { repo_path: "/x", files: [] })].map((o) => o.kind), Array(3).fill("unsupported-write"));
  eq("enforcement/1.1 GitHub と判断できない MCP（other-mcp）は識別できない旨を scope で返し、操作は持たない", [m("mcp__slack__post_message", {}).operations, m("mcp__slack__post_message", {}).passes], [[], true]);
  eq("enforcement/1.5 リポジトリ外・未導入のリポジトリでは MCP の書き込みも通す", (() => { const un = mkRepoWithRemote({ branch: "main" }); const out = [m("mcp__github__merge_pull_request", { owner: "a", repo: "b", pullNumber: 1 }, tmpdir()).passes, m("mcp__github__merge_pull_request", { owner: "a", repo: "b", pullNumber: 1 }, un.dir).passes]; un.cleanup(); return out; })(), [true, true]);
  eq("enforcement/1.1 導入済みのリポジトリでは MCP の書き込みを判定に回し、対象不明は undetermined に入る", [m("mcp__github__merge_pull_request", { owner: "a", repo: "b", pullNumber: 1 }).needsJudgment.length, m("mcp__github__merge_pull_request", { owner: "a", repo: "b", pullNumber: 1 }).undetermined.length, m("mcp__github__merge_pull_request", {}).undetermined.length], [1, 0, 1]);

  // ---- 両ホストのフック入力から ----
  eq("enforcement/6.1 Claude・Codex の Bash フック入力の gh も同じ結果になる", ["claude", "codex"].map((h) => { const ev = hookInput(h, "PreToolUse", { cwd: d, command: "gh pr merge 5 --auto" }); const x = classifyCommand(ev.tool_input.command, ev.cwd); return [x.operations[0].kind, x.passes]; }), [["auto-merge", false], ["auto-merge", false]]);
  eq("enforcement/6.1 Claude・Codex の MCP フック入力も同じ結果になる", ["claude", "codex"].map((h) => { const ev = hookInput(h, "PreToolUse", { cwd: d, tool: "mcp__github__create_pull_request", toolInput: { owner: "acme", repo: "app", title: "t", head: "dev/foo", base: "main" } }); const x = classifyMcpCall(ev.tool_name, ev.tool_input, ev.cwd); return [x.operations[0].kind, x.operations[0].base, x.passes]; }), [["pr-create", "main", false], ["pr-create", "main", false]]);

  r.cleanup();
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
};
