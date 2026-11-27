// 操作可否の共通判定（brw-enforcement 2.3）の契約テスト。selftest.mjs から呼ばれる。
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyCommand, classifyMcpCall } from "../scripts/operation-policy.mjs";
import { contextFor, decisionSignature, evaluate, evaluateAll } from "../scripts/operation-decision.mjs";
import { gitOut, mkRepoWithRemote, mkWorktree } from "./support/git-fixture.mjs";

const CONFIG = { workBranches: ["dev/*"], protectedBranches: ["main"], baseBranch: "develop" };

export const runDecisionChecks = async (eq) => {
  const saved = { GH_REPO: process.env.GH_REPO, GH_HOST: process.env.GH_HOST };
  delete process.env.GH_REPO;
  delete process.env.GH_HOST;
  const r = mkRepoWithRemote({ branch: "dev/foo", config: CONFIG });
  const d = r.dir;
  gitOut(d, "branch", "dev/other");
  gitOut(d, "branch", "other/z");
  gitOut(d, "branch", "develop");
  gitOut(d, "remote", "set-url", "origin", "https://github.com/acme/app.git");
  gitOut(d, "remote", "set-url", "--push", "origin", r.remote);
  // 判定の入口。コマンドを分類し、宣言と作業の禁止を照合して 1 件目の操作の判定を返す
  // origin は操作の起点。PR 作成の規則（適合・確認省略）は BRW 自身の公開の起点（brw-publish）で確かめ、既定（エージェント）の拒否は別に確かめる
  const ev = (cmd, restrictions = {}, cwd = d, origin = "brw-publish") => {
    const op = classifyCommand(cmd, cwd).operations[0];
    return evaluate(op, { ...contextFor(op, restrictions), origin });
  };
  const all = (cmd, restrictions = {}, cwd = d) => evaluateAll(classifyCommand(cmd, cwd), restrictions);
  const sig = (x) => [x.verdict, x.compliance, x.approval, x.code];
  const on = (branch, fn) => { gitOut(d, "checkout", "-q", branch); try { return fn(); } finally { gitOut(d, "checkout", "-q", "dev/foo"); } };

  // ---- 1.2 作成・再開は BRW の手順を経る ----
  eq("enforcement/1.2 ブランチの作成は拒否し、BRW の手順を示す", ["git switch -c dev/n", "git checkout -b dev/n", "git branch dev/n", "git worktree add ../w -b dev/n"].map((x) => [ev(x).verdict, ev(x).code, /brw\.mjs.? create/.test(ev(x).alternative)]), Array(4).fill(["deny", "branch-create", true]));
  eq("enforcement/1.2 開発ブランチ・宣言外ブランチの再開は拒否し、brw resume を示す", ["git switch dev/other", "git checkout dev/other", "git worktree add ../x dev/other", "git switch other/z"].map((x) => [ev(x).verdict, ev(x).code, /brw\.mjs.? resume/.test(ev(x).alternative)]), Array(4).fill(["deny", "branch-resume", true]));
  eq("enforcement/1.2 名前の変更と gh pr checkout も作成として拒否する", [ev("git branch -m dev/new").code, ev("gh pr checkout 5 -b dev/pr5").code], ["branch-create", "branch-create"]);
  eq("enforcement/1.2 保護対象・恒常的な分岐元への切り替えは適合（通常のホスト承認に委ねる）", ["git switch main", "git switch develop"].map((x) => sig(ev(x))), Array(2).fill(["pass", "compliant", "normal", "branch-resume-protected"]));

  // ---- 1.3 直接の変更 ----
  eq("enforcement/1.3 開発ブランチへの commit は適合（登録済みの宣言なら確認を省略できる）", sig(ev("git commit -m x")), ["eligibleForApproval", "compliant", "skip", "commit-development"]);
  eq("enforcement/1.3 保護・分岐元・宣言外への commit は拒否", ["main", "develop", "other/z"].map((b) => on(b, () => sig(ev("git commit -m x")))), ["main", "develop", "other/z"].map(() => ["deny", "violation", "notApplicable", "direct-update"]));
  eq("enforcement/1.3 保護・分岐元・宣言外への push は拒否", ["git push origin main", "git push origin develop", "git push origin other/z", "git push origin dev/foo:main", "git push origin dev/foo dev/foo:develop"].map((x) => [ev(x).verdict, ev(x).code]), Array(5).fill(["deny", "direct-update"]));
  eq("enforcement/1.3 拒否理由に対象のブランチ名と分類を含める", (() => { const x = ev("git push origin main"); return [x.targets, x.facts.branchClass, /main/.test(x.reason)]; })(), [["main"], { main: "protected" }, true]);
  eq("enforcement/1.3 命名規則に合わない開発指定は宣言外として拒否", (() => { const nr = mkRepoWithRemote({ branch: "dev/Bad1", config: { ...CONFIG, namePattern: "^dev/[a-z]+$" } }); const o = classifyCommand("git commit -m x", nr.dir).operations[0]; const x = evaluate(o, contextFor(o)); nr.cleanup(); return [x.verdict, x.facts.branchClass]; })(), ["deny", { "dev/Bad1": "undeclared" }]);

  // ---- 1.4 確定できない操作 ----
  eq("enforcement/1.4 対象を確定できない変更は拒否し、判定できなかった理由を示す", ["git push --all", "git push origin $B", "git rebase main dev/other"].map((x) => { const v = ev(x); return [v.verdict, v.compliance, v.code, v.reasons.length > 0 && /確定|判定/.test(v.reason)]; }), Array(3).fill(["deny", "unresolved", "unresolved", true]));
  eq("enforcement/1.4 解釈できないコマンドと detached HEAD の commit も拒否", [ev("git frobnicate").code, on("dev/foo", () => { gitOut(d, "checkout", "-q", "--detach"); const x = ev("git commit -m x"); gitOut(d, "checkout", "-q", "dev/foo"); return x.code; })], ["unresolved", "unresolved"]);
  eq("enforcement/1.4 宣言が不正・導入設定だけで宣言なしのリポジトリは変更を保留する", (() => {
    const bad = mkRepoWithRemote({ branch: "dev/foo", config: CONFIG });
    writeFileSync(join(bad.dir, ".branch-release-workflow.json"), "{ 不正");
    const so = mkRepoWithRemote({ branch: "dev/foo" });
    mkdirSync(join(so.dir, ".claude"), { recursive: true });
    writeFileSync(join(so.dir, ".claude/settings.json"), JSON.stringify({ enabledPlugins: { "branch-release-workflow@x": true } }));
    const run = (dir) => { const o = classifyCommand("git push origin dev/foo", dir).operations[0]; return evaluate(o, contextFor(o)); };
    const out = [run(bad.dir), run(so.dir)].map((x) => [x.verdict, x.code]);
    bad.cleanup(); so.cleanup();
    return out;
  })(), [["deny", "declaration-invalid"], ["deny", "declaration-missing"]]);

  // ---- 1.5 未導入 ----
  eq("enforcement/1.5 未導入のリポジトリとリポジトリ外は通す", (() => {
    const un = mkRepoWithRemote({ branch: "main" });
    const run = (cmd, dir) => { const o = classifyCommand(cmd, dir).operations[0]; return sig(evaluate(o, contextFor(o))); };
    const out = [run("git push origin main", un.dir), run("git commit -m x", un.dir), run("git switch -c x", un.dir), run("git push origin main", tmpdir())];
    un.cleanup();
    return out;
  })(), Array(4).fill(["pass", "notApplicable", "notApplicable", "not-managed"]));
  eq("enforcement/1.5 照会は常に通す", ["git status", "git log", "git branch", "gh pr view 3"].map((x) => sig(ev(x))), Array(4).fill(["pass", "notApplicable", "notApplicable", "query"]));

  // ---- 2.1 確認省略（適合判定とは別） ----
  eq("enforcement/2.1 登録済み宣言で開発ブランチへの通常 push は確認省略の対象", sig(ev("git push origin dev/foo")), ["eligibleForApproval", "compliant", "skip", "push-development"]);
  eq("enforcement/2.1 送り先を省いた push・-u 付きも同じ", ["git push", "git push -u origin", "git push origin HEAD"].map((x) => sig(ev(x))), Array(3).fill(["eligibleForApproval", "compliant", "skip", "push-development"]));
  eq("enforcement/2.1 未登録・編集中の宣言では適合でも確認を省略しない（通常のホスト承認）", (() => {
    const ur = mkRepoWithRemote({ branch: "dev/foo", config: CONFIG, register: false });
    const ed = mkRepoWithRemote({ branch: "dev/foo", config: CONFIG });
    writeFileSync(join(ed.dir, ".branch-release-workflow.json"), JSON.stringify({ ...CONFIG, autoApprove: { push: true } }));
    const run = (dir) => { const o = classifyCommand("git push origin dev/foo", dir).operations[0]; const x = evaluate(o, contextFor(o)); return [...sig(x), x.approvalWhy]; };
    const out = [run(ur.dir), run(ed.dir)];
    ur.cleanup(); ed.cleanup();
    return out;
  })(), Array(2).fill(["pass", "compliant", "normal", "push-development", "unregistered"]));
  eq("enforcement/2.1 宣言が autoApprove.push を false にすると確認省略しない", (() => {
    const op = mkRepoWithRemote({ branch: "dev/foo", config: { ...CONFIG, autoApprove: { push: false } } });
    const o = classifyCommand("git push origin dev/foo", op.dir).operations[0]; const x = evaluate(o, contextFor(o));
    op.cleanup();
    return [...sig(x), x.approvalWhy];
  })(), ["pass", "compliant", "normal", "push-development", "opt-out"]);
  eq("enforcement/2.1 compound は全体の対象を検証できるときだけ確認を省略する", [
    all("git push origin dev/foo && git push origin dev/other").verdict, all("git push origin dev/foo && git commit -m x").verdict,
    all("git push origin dev/foo && git push -f origin dev/other").verdict, all("git push origin dev/foo && git push origin main").verdict,
    all("git status").verdict,
  ], ["eligibleForApproval", "eligibleForApproval", "pass", "deny", "pass"]);

  // ---- 2.9・2.10 開発ブランチの通常の commit の確認省略（タスク 15.3） ----
  const commitOf = (cmd, dir = d) => { const o = classifyCommand(cmd, dir).operations[0]; return evaluate(o, contextFor(o)); };
  const cfgRepo = (autoApprove, opts = {}) => mkRepoWithRemote({ branch: "dev/foo", config: autoApprove === undefined ? CONFIG : { ...CONFIG, autoApprove }, ...opts });
  eq("enforcement/2.9 登録済みで通常の commit は確認を省略できる", sig(commitOf("git commit -m x")), ["eligibleForApproval", "compliant", "skip", "commit-development"]);
  eq("enforcement/2.9 commit 単体の全体判定も確認を省略できる", all("git commit -m x").verdict, "eligibleForApproval");
  eq("enforcement/2.9 autoApprove.commit が明示の true でも確認を省略できる", (() => { const r = cfgRepo({ commit: true }); const x = commitOf("git commit -m x", r.dir); r.cleanup(); return sig(x); })(), ["eligibleForApproval", "compliant", "skip", "commit-development"]);
  eq("enforcement/2.9 未登録の宣言の commit は適合でも確認を省略しない", (() => { const r = cfgRepo(undefined, { register: false }); const x = commitOf("git commit -m x", r.dir); r.cleanup(); return [...sig(x), x.approvalWhy]; })(), ["pass", "compliant", "normal", "commit-development", "unregistered"]);
  eq("enforcement/2.9 編集中の宣言の commit は確認を省略しない", (() => { const r = cfgRepo(undefined); writeFileSync(join(r.dir, ".branch-release-workflow.json"), JSON.stringify({ ...CONFIG, autoApprove: { commit: true } })); const x = commitOf("git commit -m x", r.dir); r.cleanup(); return [...sig(x), x.approvalWhy]; })(), ["pass", "compliant", "normal", "commit-development", "unregistered"]);
  eq("enforcement/2.9 登録済みで autoApprove.commit=false の commit は確認を省略しない", (() => { const r = cfgRepo({ commit: false }); const x = commitOf("git commit -m x", r.dir); r.cleanup(); return [...sig(x), x.approvalWhy]; })(), ["pass", "compliant", "normal", "commit-development", "opt-out"]);
  eq("enforcement/2.10 通常でない commit は確認を省略しない（--amend・--no-verify・設定の上書き・環境変数の前置・展開を含むメッセージ）", ["git commit --amend -m x", "git commit --no-verify -m x", "git -c user.name=x commit -m x", "FOO=bar git commit -m x", "git commit -m \"$VAR\""].map((x) => { const v = commitOf(x); return [...sig(v).slice(0, 3), v.approvalWhy]; }), Array(5).fill(["pass", "compliant", "normal", "not-normal"]));
  eq("enforcement/2.10 commit 以外の経路（rebase）は確認を省略しない", (() => { const v = commitOf("git rebase main"); return [...sig(v).slice(0, 3), v.approvalWhy]; })(), ["pass", "compliant", "normal", "not-commit-path"]);
  eq("enforcement/2.9 保護・分岐元・宣言外への commit は登録済みでも拒否のまま", ["main", "develop", "other/z"].map((b) => on(b, () => sig(commitOf("git commit -m x")))), ["main", "develop", "other/z"].map(() => ["deny", "violation", "notApplicable", "direct-update"]));

  // ---- 2.6 作業で記録された禁止 ----
  eq("enforcement/2.6 作業で push を禁止した場合は適合でも拒否（禁止は既定の動作より優先）", (() => { const x = ev("git push origin dev/foo", { noPush: true }); return [...sig(x), x.approvalWhy]; })(), ["deny", "compliant", "prohibited", "push-development", "work-restriction"]);
  eq("enforcement/2.6 push の禁止は PR 作成の判定に影響しない", sig(ev("gh pr create --head dev/foo --base main --title t --body b", { noPush: true })).slice(0, 3), ["pass", "compliant", "normal"]);
  eq("enforcement/2.6 PR 作成の禁止は push に影響せず、PR 作成を拒否する", [sig(ev("git push origin dev/foo", { noPr: true })), sig(ev("gh pr create --head dev/foo --base main --title t --body b", { noPr: true }))], [["eligibleForApproval", "compliant", "skip", "push-development"], ["deny", "compliant", "prohibited", "pr-create-protected"]]);
  eq("enforcement/2.6 登録済み宣言の autoApprove.pullRequest=false は PR 作成の確認省略を外す", (() => {
    const op = mkRepoWithRemote({ branch: "dev/foo", config: { ...CONFIG, autoApprove: { pullRequest: false } } });
    gitOut(op.dir, "remote", "set-url", "origin", "https://github.com/acme/app.git");
    const o = classifyCommand("gh pr create --head dev/foo --base main -t t -b b", op.dir).operations[0]; const x = evaluate(o, { ...contextFor(o), origin: "brw-publish" });
    op.cleanup();
    return [...sig(x), x.approvalWhy];
  })(), ["pass", "compliant", "normal", "pr-create-protected", "opt-out"]);
  eq("enforcement/2.6 制限が何も無ければ従来どおり", all("git push origin dev/foo", {}).verdict, "eligibleForApproval");

  // ---- 2.8 確認省略の対象外 ----
  eq("enforcement/2.8 開発ブランチへの強制 push は適合だが確認を省略しない", ["git push -f origin dev/foo", "git push origin +dev/foo", "git push --force-with-lease origin dev/foo"].map((x) => [...sig(ev(x)).slice(0, 3), ev(x).approvalWhy]), Array(3).fill(["pass", "compliant", "normal", "force"]));
  eq("enforcement/2.8 開発ブランチの削除は適合だが確認を省略しない", ["git push origin :dev/other", "git push --delete origin dev/other"].map((x) => [...sig(ev(x)).slice(0, 3), ev(x).approvalWhy]), Array(2).fill(["pass", "compliant", "normal", "delete"]));
  eq("enforcement/2.8 保護対象の削除・強制、タグの push は拒否", ["git push origin :main", "git push -f origin main", "git push --tags", "git push origin refs/tags/v1"].map((x) => ev(x).verdict), Array(4).fill("deny"));
  gitOut(d, "tag", "v1");
  eq("enforcement/2.8 タグの push は宣言済みの開発ブランチではないため拒否", [ev("git push origin v1").code, ev("git push origin v1").verdict], ["direct-update", "deny"]);

  // ---- 3.1 開発ブランチ間のローカルマージ ----
  eq("enforcement/3.1 開発ブランチ同士のローカルマージは PR なしで確認も省略できる", ["git merge dev/other", "git merge origin/dev/foo"].map((x) => { gitOut(d, "update-ref", "refs/remotes/origin/dev/foo", "dev/foo"); return sig(ev(x)); }), Array(2).fill(["eligibleForApproval", "compliant", "skip", "merge-development"]));
  eq("enforcement/3.1 未登録の宣言ではマージの確認を省略しない", (() => {
    const ur = mkRepoWithRemote({ branch: "dev/foo", config: CONFIG, register: false });
    gitOut(ur.dir, "branch", "dev/other");
    const o = classifyCommand("git merge dev/other", ur.dir).operations[0]; const x = evaluate(o, contextFor(o));
    ur.cleanup();
    return [...sig(x), x.approvalWhy];
  })(), ["pass", "compliant", "normal", "merge-development", "unregistered"]);
  eq("enforcement/3.1 merge --abort は開発ブランチなら適合", sig(ev("git merge --abort")).slice(0, 2), ["pass", "compliant"]);

  // ---- 3.2 開発ブランチ以外へのマージ ----
  eq("enforcement/3.2 保護・分岐元・宣言外へのローカルマージは拒否する", ["main", "develop", "other/z"].map((b) => on(b, () => { const x = ev("git merge dev/other"); return [x.verdict, x.code]; })), Array(3).fill(["deny", "merge-non-development"]));
  eq("enforcement/3.2 開発ブランチへの取り込み元が開発ブランチでなければ拒否する", ["git merge main", "git merge other/z", "git merge dev/other main"].map((x) => [ev(x).verdict, ev(x).code]), Array(3).fill(["deny", "merge-non-development"]));
  eq("enforcement/3.2 GitHub 側のマージと自動マージ予約を拒否する", ["gh pr merge 5", "gh pr merge 5 --squash", "gh pr merge 5 --auto", "gh api -X PUT repos/acme/app/pulls/5/merge", "gh api repos/acme/app/merges -f base=main -f head=dev/foo", "gh api graphql -f query='mutation { mergePullRequest(input:{pullRequestId:\"X\"}) { clientMutationId } }'"].map((x) => [ev(x).verdict, ev(x).code]), [["deny", "github-merge"], ["deny", "github-merge"], ["deny", "github-merge"], ["deny", "github-merge"], ["deny", "github-merge"], ["deny", "github-merge"]]);
  eq("enforcement/3.2 自動マージ予約の拒否理由は予約を示す", ev("gh pr merge 5 --auto").code, "github-merge");
  eq("enforcement/3.2 MCP のマージも拒否する", (() => {
    const out = ["merge_pull_request"].map((t) => { const op = classifyMcpCall(`mcp__github__${t}`, { owner: "acme", repo: "app", pullNumber: 5 }, d).operations[0]; return evaluate(op, contextFor(op)); });
    return out.map((x) => [x.verdict, x.code]);
  })(), [["deny", "github-merge"]]);
  eq("enforcement/3.2 GitHub マージの拒否は対象が確定できなくても同じ理由にする", [ev("gh pr merge").verdict, ev("gh pr merge $N").verdict], ["deny", "deny"]);

  // ---- sync-base-branch 1.1 取り込みの fast-forward 指定・リベースの実効値と由来 ----
  {
    const mo = (cmd) => classifyCommand(cmd, d).operations[0];
    const view = (cmd) => { const o = mo(cmd); return [o.ff, o.rebase, o.basis.ff, o.basis.rebase, o.basis.configKeys, o.unresolved.length]; };
    const setCfg = (k, v) => gitOut(d, "config", k, v);
    const unsetCfg = (k) => { try { gitOut(d, "config", "--unset", k); } catch { /* 未設定 */ } };
    eq("sync-base-branch/1.1 引数だけの指定（最後の指定を採る）", [
      view("git pull --ff-only origin main"), view("git pull --no-ff origin main"), view("git pull --ff-only --no-ff origin main"), view("git pull --no-ff --ff origin main"),
      view("git pull --rebase origin main"), view("git pull -r origin main"), view("git pull --rebase --no-rebase origin main"), view("git pull --no-rebase -r origin main"), view("git pull --rebase=false origin main"),
      view("git merge --ff-only origin/main"), view("git merge --no-ff origin/main"),
    ], [
      ["only", false, "arg", "default", [], 0], ["never", false, "arg", "default", [], 0], ["never", false, "arg", "default", [], 0], ["allow", false, "arg", "default", [], 0],
      ["allow", true, "default", "arg", [], 0], ["allow", true, "default", "arg", [], 0], ["allow", false, "default", "arg", [], 0], ["allow", true, "default", "arg", [], 0], ["allow", false, "default", "arg", [], 0],
      ["only", false, "arg", "default", [], 0], ["never", false, "arg", "default", [], 0],
    ]);
    eq("sync-base-branch/1.1 指定が無ければ既定", [view("git pull origin main"), view("git merge origin/main")], [["allow", false, "default", "default", [], 0], ["allow", false, "default", "default", [], 0]]);
    setCfg("pull.ff", "only");
    setCfg("pull.rebase", "true");
    const cfgOnly = [view("git pull origin main"), view("git merge origin/main")];
    // 引数が設定より優先される
    const both = [view("git pull --no-ff --no-rebase origin main"), view("git pull --ff origin main")];
    unsetCfg("pull.ff"); unsetCfg("pull.rebase");
    eq("sync-base-branch/1.1 設定だけの指定（pull.ff・pull.rebase）", cfgOnly, [["only", true, "config", "config", ["pull.ff", "pull.rebase"], 0], ["allow", false, "default", "default", [], 0]]);
    eq("sync-base-branch/1.1 引数と設定の両方がある場合は引数が優先", both, [["never", false, "arg", "arg", [], 0], ["allow", true, "arg", "config", ["pull.rebase"], 0]]);
    setCfg("merge.ff", "false");
    const mergeCfg = [view("git merge origin/main"), view("git pull origin main")];
    setCfg("pull.ff", "only");
    const pullPrior = view("git pull origin main");
    unsetCfg("pull.ff"); unsetCfg("merge.ff");
    eq("sync-base-branch/1.1 merge.ff は merge と pull の両方に効き、pull.ff が優先される", [mergeCfg, pullPrior], [[["never", false, "config", "default", ["merge.ff"], 0], ["never", false, "config", "default", ["merge.ff"], 0]], ["only", false, "config", "default", ["pull.ff"], 0]]);
    setCfg("branch.dev/foo.rebase", "true");
    const branchRb = view("git pull origin main");
    unsetCfg("branch.dev/foo.rebase");
    eq("sync-base-branch/1.1 branch.<名前>.rebase を読む", branchRb, [ "allow", true, "default", "config", ["branch.dev/foo.rebase"], 0]);
    setCfg("pull.rebase", "false");
    const rbFalse = view("git pull origin main");
    setCfg("pull.rebase", "bogus");
    const rbBad = view("git pull origin main");
    unsetCfg("pull.rebase");
    eq("sync-base-branch/1.1 pull.rebase=false はリベースにしない、読めない値は確定不能", [rbFalse, rbBad], [["allow", false, "default", "config", ["pull.rebase"], 0], ["allow", false, "default", "default", [], 1]]);
    eq("sync-base-branch/2.4 リベースを伴う pull の mode", [mo("git pull --rebase origin main").mode, mo("git pull origin main").mode], ["pull-rebase", "pull"]);
    eq("sync-base-branch/1.5 -c による設定の上書きと展開を含む引数は確定不能", ["git -c pull.rebase=true pull origin main", "git -c merge.ff=false merge origin/main", "git pull --ff-only $R main"].map((x) => mo(x).unresolved.length > 0), [true, true, true]);
    eq("sync-base-branch/1.4 pull の <元>:<先> の取り込み元に印を付ける", [mo("git pull origin main:other").sources.map((x) => x.refspecDst === true), mo("git pull origin main").sources.map((x) => x.refspecDst === true), mo("git pull origin refs/heads/main:main").sources[0].branch], [[true], [false], "main"]);
  }

  // ---- sync-base-branch 1.2 fast-forward になるかの確認（読み取りのみ） ----
  {
    const fr = mkRepoWithRemote({ branch: "dev/foo", config: CONFIG });
    const w = fr.dir;
    const ff = (cmd) => classifyCommand(cmd, w).operations[0].fastForwardable;
    // dev/foo だけ先に進んでいる（先端は origin/main の祖先ではない）→ false
    gitOut(w, "commit", "-q", "--allow-empty", "-m", "dev の先行");
    const aheadOnly = ff("git merge origin/main");
    gitOut(w, "reset", "-q", "--hard", "HEAD~1");
    // origin/main だけ先に進める → dev/foo の先端は origin/main の祖先
    gitOut(w, "checkout", "-q", "main");
    gitOut(w, "commit", "-q", "--allow-empty", "-m", "main の更新");
    gitOut(w, "update-ref", "refs/remotes/origin/main", "main");
    gitOut(w, "checkout", "-q", "dev/foo");
    const forwardable = ff("git merge origin/main");
    // dev/foo にも独自のコミットを足す → 分岐
    gitOut(w, "commit", "-q", "--allow-empty", "-m", "dev の更新");
    const before = gitOut(w, "for-each-ref", "--format=%(refname) %(objectname)");
    const diverged = ff("git merge origin/main");
    const pullFf = ff("git pull origin main");
    const pullFfOnly = ff("git pull --ff-only origin main");
    const ctl = ff("git merge --abort");
    const unknownRev = ff("git merge nonexistent-xyz");
    const multi = ff("git merge origin/main dev/foo");
    const after = gitOut(w, "for-each-ref", "--format=%(refname) %(objectname)");
    fr.cleanup();
    eq("sync-base-branch/1.2 merge で先端が取り込み元の祖先なら true（先に進めるだけ）", [aheadOnly, forwardable], [false, true]);
    eq("sync-base-branch/1.2 履歴が分岐していれば false", diverged, false);
    eq("sync-base-branch/1.2 pull・取り込み元なし・解決できない・複数の取り込み元は確認不能（null）", [pullFf, pullFfOnly, ctl, unknownRev, multi], [null, null, null, null, null]);
    eq("sync-base-branch/1.2 判定でリポジトリの参照が変わらない（読み取りのみ）", after, before);
  }

  // ---- sync-base-branch 1.3 fetch の同名更新を取り込み操作として取り出す ----
  {
    const fr = mkRepoWithRemote({ branch: "dev/foo", config: CONFIG });
    const w = fr.dir;
    const op = (cmd) => classifyCommand(cmd, w).operations[0];
    const shape = (cmd) => { const o = op(cmd); return [o.kind, o.via, o.mode, o.ff, o.rebase, o.branch, o.sources?.map((s) => [s.name, s.branch, s.remote]), o.unresolved.length]; };
    const fetchUpd = ["main", [["origin/main", "main", "origin"]], 0];
    const want = ["merge", "fetch", "fetch-update", "only", false, ...fetchUpd];
    eq("sync-base-branch/1.3 fetch の同名更新は取り込み操作（refs/heads/ の有無を同一視）", [shape("git fetch origin main:main"), shape("git fetch origin refs/heads/main:refs/heads/main"), shape("git fetch origin refs/heads/main:main")], [want, want, want]);
    eq("sync-base-branch/1.3 追跡ブランチだけを更新する fetch は照会のまま", ["git fetch origin", "git fetch origin main", "git fetch origin main:refs/remotes/origin/main"].map((x) => op(x).kind), Array(3).fill("query"));
    const kinds = (cmds) => cmds.map((x) => { const o = op(x); return [o.kind, o.unresolved.length > 0]; });
    eq("sync-base-branch/1.3 登録外のリモート・強制・別名・複数更新・フラグ付きは従来の分類（確定不能）", kinds([
      "git fetch . dev/foo:main", "git fetch https://example.com/x.git main:main", "git fetch origin +main:main", "git fetch origin main:other", "git fetch origin refs/heads/main:other",
      "git fetch --force origin main:main", "git fetch -f origin main:main", "git fetch origin --update-head-ok main:main", "git fetch -u origin main:main", "git fetch --refmap= origin main:main",
      "git fetch origin main:main dev/foo:dev/foo", "git fetch origin main:main $X",
    ]), Array(12).fill(["unparseable", true]));
    // 追跡ブランチ更新と同名更新の同居は、ローカルを更新する refspec が 1 つなので取り込み操作
    eq("sync-base-branch/1.3 追跡ブランチ更新が同居しても更新先が 1 つなら取り込み操作", shape("git fetch origin main:main main:refs/remotes/origin/main")[0], "merge");
    fr.cleanup();
  }

  // ---- sync-base-branch 2.1 基底・保護ブランチの更新（形 A） ----
  {
    const mk = (register) => {
      const fr = mkRepoWithRemote({ branch: "dev/foo", config: CONFIG, register });
      const w = fr.dir;
      gitOut(w, "branch", "develop");
      gitOut(w, "update-ref", "refs/remotes/origin/main", "main");
      gitOut(w, "update-ref", "refs/remotes/origin/develop", "develop");
      gitOut(w, "update-ref", "refs/remotes/origin/dev/bar", "dev/foo");
      gitOut(w, "remote", "add", "upstream", "/tmp/brw-upstream-dummy");
      gitOut(w, "update-ref", "refs/remotes/upstream/main", "main");
      gitOut(w, "branch", "dev/bar");
      gitOut(w, "checkout", "-q", "main");
      return { w, cleanup: fr.cleanup };
    };
    const judge = (w, cmd) => { const o = classifyCommand(cmd, w).operations[0]; const x = evaluate(o, contextFor(o)); return [x.verdict, x.approval, x.code, x.approvalWhy]; };
    const A = mk(true);
    const okReg = ["eligibleForApproval", "skip", "sync-base-fast-forward", null];
    eq("sync-base-branch/2.1 登録済みの宣言: main の fast-forward 更新（pull --ff-only・merge --ff-only・fetch 同名）は確認省略の対象", ["git pull --ff-only origin main", "git merge --ff-only origin/main", "git fetch origin main:main", "git fetch origin refs/heads/main:refs/heads/main"].map((c) => judge(A.w, c)), Array(4).fill(okReg));
    gitOut(A.w, "checkout", "-q", "develop");
    eq("sync-base-branch/2.1 基底ブランチ（develop）の更新も形 A", [judge(A.w, "git pull --ff-only origin develop"), judge(A.w, "git merge --ff-only origin/develop")], Array(2).fill(okReg));
    gitOut(A.w, "checkout", "-q", "main");
    eq("sync-base-branch/2.1 --ff-only の無い pull・merge は sync-ff-only-required で拒否", ["git pull origin main", "git merge origin/main", "git pull --ff origin main"].map((c) => judge(A.w, c).slice(0, 3)), Array(3).fill(["deny", "notApplicable", "sync-ff-only-required"]));
    eq("sync-base-branch/2.1 --no-ff・--squash・リベースは sync-not-fast-forward で拒否", ["git pull --no-ff origin main", "git merge --no-ff origin/main", "git merge --squash origin/main", "git pull --rebase origin main", "git pull --ff-only --rebase origin main", "git pull -r --ff-only origin main"].map((c) => judge(A.w, c).slice(0, 3)), Array(6).fill(["deny", "notApplicable", "sync-not-fast-forward"]));
    eq("sync-base-branch/2.1 拒否の理由に再実行の案内（--ff-only）が含まれる", (() => { const o = classifyCommand("git pull origin main", A.w).operations[0]; const x = evaluate(o, contextFor(o)); return [/--ff-only/.test(x.reason), x.compliance]; })(), [true, "violation"]);
    eq("sync-base-branch/2.1 取り込み元が origin の同名でないものは従来どおり merge-non-development で拒否", ["git pull --ff-only origin develop", "git merge --ff-only dev/bar", "git merge --ff-only origin/develop", "git pull --ff-only origin main:develop", "git pull --ff-only origin main develop", "git merge --ff-only origin/main origin/develop", "git merge --abort", "git pull --ff-only upstream main", "git merge --ff-only upstream/main", "git fetch upstream main:main", "git pull --ff-only origin main other"].map((c) => judge(A.w, c).slice(0, 3)), Array(11).fill(["deny", "notApplicable", "merge-non-development"]));
    eq("sync-base-branch/2.1 保護・基底以外へ向かう fetch の同名更新（開発ブランチ・宣言外）は merge-non-development で拒否", (() => {
      gitOut(A.w, "branch", "other/z"); gitOut(A.w, "update-ref", "refs/remotes/origin/other/z", "main");
      return ["git fetch origin dev/bar:dev/bar", "git fetch origin other/z:other/z"].map((c) => { const x = judge(A.w, c); const o = classifyCommand(c, A.w).operations[0]; const d2 = evaluate(o, contextFor(o)); return [...x.slice(0, 3), /fetch|更新/.test(d2.reason)]; });
    })(), Array(2).fill(["deny", "notApplicable", "merge-non-development", true]));
    // 実行前に分岐と確認できた merge（main が origin/main に対して先行・分岐している）
    gitOut(A.w, "commit", "-q", "--allow-empty", "-m", "main の独自コミット");
    gitOut(A.w, "update-ref", "refs/remotes/origin/main", "dev/foo");
    gitOut(A.w, "checkout", "-q", "-B", "tmp", "dev/foo"); gitOut(A.w, "commit", "-q", "--allow-empty", "-m", "origin 側の更新"); gitOut(A.w, "update-ref", "refs/remotes/origin/main", "tmp"); gitOut(A.w, "checkout", "-q", "main");
    eq("sync-base-branch/2.1 分岐が確認できた merge は --ff-only でも sync-not-fast-forward で拒否", [judge(A.w, "git merge --ff-only origin/main").slice(0, 3), judge(A.w, "git merge origin/main").slice(0, 3)], Array(2).fill(["deny", "notApplicable", "sync-not-fast-forward"]));
    eq("sync-base-branch/2.1 pull・fetch は取得前のため分岐を確認できず許可（git が止める）", [judge(A.w, "git pull --ff-only origin main")[2], judge(A.w, "git fetch origin main:main")[2]], ["sync-base-fast-forward", "sync-base-fast-forward"]);
    A.cleanup();
    const U = mk(false);
    eq("sync-base-branch/2.1 未登録の宣言では許可しても通常の承認（確認を省略しない）", ["git pull --ff-only origin main", "git merge --ff-only origin/main", "git fetch origin main:main"].map((c) => judge(U.w, c)), Array(3).fill(["pass", "normal", "sync-base-fast-forward", "unregistered"]));
    eq("sync-base-branch/2.1 未登録でも拒否は変わらない", [judge(U.w, "git pull origin main")[2], judge(U.w, "git pull --rebase origin main")[2]], ["sync-ff-only-required", "sync-not-fast-forward"]);
    U.cleanup();
    const S = mk(true);
    gitOut(S.w, "config", "pull.ff", "only");
    const cfgOk = judge(S.w, "git pull origin main")[2];
    gitOut(S.w, "config", "--unset", "pull.ff"); gitOut(S.w, "config", "pull.rebase", "true");
    const cfgRb = judge(S.w, "git pull --ff-only origin main")[2];
    gitOut(S.w, "config", "--unset", "pull.rebase");
    eq("sync-base-branch/2.1 pull.ff=only の設定は --ff-only と同等、pull.rebase=true は拒否", [cfgOk, cfgRb], ["sync-base-fast-forward", "sync-not-fast-forward"]);
    S.cleanup();
  }

  // ---- sync-base-branch 2.2 開発ブランチへの基底の取り込み（形 B） ----
  {
    const fr = mkRepoWithRemote({ branch: "dev/foo", config: CONFIG, register: true });
    const w = fr.dir;
    gitOut(w, "update-ref", "refs/remotes/origin/main", "main");
    gitOut(w, "branch", "other/z"); gitOut(w, "update-ref", "refs/remotes/origin/other/z", "main");
    gitOut(w, "update-ref", "refs/remotes/origin/dev/bar", "dev/foo");
    gitOut(w, "branch", "dev/bar");
    gitOut(w, "remote", "add", "upstream", "/tmp/brw-upstream-dummy");
    gitOut(w, "update-ref", "refs/remotes/upstream/main", "main");
    const judge = (cmd, dir = w) => { const o = classifyCommand(cmd, dir).operations[0]; const x = evaluate(o, contextFor(o)); return [x.verdict, x.approval, x.code, x.approvalWhy]; };
    const okReg = ["eligibleForApproval", "skip", "sync-base-merge", null];
    eq("sync-base-branch/2.2 dev/foo 上の origin の基底の取り込み（merge・pull）は登録済みなら確認省略の対象", ["git merge origin/main", "git pull origin main", "git pull origin refs/heads/main", "git merge --no-ff origin/main", "git merge --ff-only origin/main", "git merge --squash origin/main", "git merge origin/main origin/dev/bar", "git merge dev/bar origin/main"].map((c) => judge(c)), Array(8).fill(okReg));
    eq("sync-base-branch/2.2 リベースを伴う取り込み（引数・設定由来・branch.<名前>.rebase）は sync-rebase で拒否", (() => {
      const args = ["git pull --rebase origin main", "git pull -r origin main", "git pull --rebase --ff-only origin main"].map((c) => judge(c).slice(0, 3));
      const viaCfg = [["pull.rebase", "true"], ["branch.dev/foo.rebase", "true"]].map(([k, v]) => { gitOut(w, "config", k, v); const r = judge("git pull origin main").slice(0, 3); gitOut(w, "config", "--unset", k); return r; });
      return [...args, ...viaCfg];
    })(), Array(5).fill(["deny", "notApplicable", "sync-rebase"]));
    eq("sync-base-branch/2.2 リベースでない設定（pull.rebase=false）は許可", (() => { gitOut(w, "config", "pull.rebase", "false"); const r = judge("git pull origin main")[2]; gitOut(w, "config", "--unset", "pull.rebase"); return r; })(), "sync-base-merge");
    eq("sync-base-branch/2.2 開発ブランチ同士だけならリベースでも従来の判定のまま", judge("git pull --rebase origin dev/bar")[2], "merge-development");
    eq("sync-base-branch/2.2 手元の別ブランチ・宣言外のブランチ・origin 以外のリモート・origin の宣言外は merge-non-development", ["git merge main", "git merge other/z", "git merge origin/other/z", "git pull origin other/z", "git merge upstream/main", "git pull upstream main", "git merge origin/main main", "git merge origin/main origin/other/z", "git pull origin main other/z"].map((c) => judge(c).slice(0, 3)), Array(9).fill(["deny", "notApplicable", "merge-non-development"]));
    eq("sync-base-branch/2.2 <元>:<先> の取り込み元は形 B に当たらない", ["git pull origin main:dev/foo", "git pull origin main:other", "git pull origin main:main"].map((c) => judge(c).slice(0, 3)), Array(3).fill(["deny", "notApplicable", "merge-non-development"]));
    eq("sync-base-branch/2.2 fetch による更新は形 A 以外を拒否のまま（形 B に紛れない）", ["git fetch origin dev/bar:dev/bar", "git fetch origin dev/foo:dev/foo"].map((c) => judge(c).slice(0, 3)), Array(2).fill(["deny", "notApplicable", "merge-non-development"]));
    eq("sync-base-branch/2.2 取り込み元の指定が無い操作（--abort）は確認を省略しない", judge("git merge --abort").slice(0, 4), ["pass", "normal", "merge-development", "no-source"]);
    eq("sync-base-branch/2.2 取り込み先が宣言外のブランチなら基底の取り込みも merge-non-development", (() => {
      gitOut(w, "checkout", "-q", "other/z");
      const r = ["git merge origin/main", "git pull origin main"].map((c) => judge(c).slice(0, 3));
      gitOut(w, "checkout", "-q", "dev/foo");
      return r;
    })(), Array(2).fill(["deny", "notApplicable", "merge-non-development"]));
    eq("sync-base-branch/2.2 同じ入力は同じ判定", [judge("git merge origin/main"), judge("git pull --rebase origin main")], [judge("git merge origin/main"), judge("git pull --rebase origin main")]);
    fr.cleanup();
    const ur = mkRepoWithRemote({ branch: "dev/foo", config: CONFIG, register: false });
    gitOut(ur.dir, "update-ref", "refs/remotes/origin/main", "main");
    eq("sync-base-branch/2.2 未登録の宣言では許可しても通常の承認、リベースの拒否は変わらない", [judge("git merge origin/main", ur.dir), judge("git pull origin main", ur.dir), judge("git pull --rebase origin main", ur.dir).slice(0, 3)], [["pass", "normal", "sync-base-merge", "unregistered"], ["pass", "normal", "sync-base-merge", "unregistered"], ["deny", "notApplicable", "sync-rebase"]]);
    ur.cleanup();
  }

  // ---- sync-base-branch 2.3 拒否の案内と判定の根拠 ----
  {
    const fr = mkRepoWithRemote({ branch: "dev/foo", config: CONFIG, register: true });
    const w = fr.dir;
    gitOut(w, "update-ref", "refs/remotes/origin/main", "main");
    gitOut(w, "update-ref", "refs/remotes/origin/dev/bar", "dev/foo");
    gitOut(w, "branch", "dev/bar");
    const full = (cmd) => { const o = classifyCommand(cmd, w).operations[0]; return evaluate(o, contextFor(o)); };
    const cfgSet = (k, v) => gitOut(w, "config", k, v);
    const cfgUnset = (k) => gitOut(w, "config", "--unset", k);
    const altOk = (x) => [/git -C <[^>]+> pull --ff-only origin main/.test(x.alternative ?? ""), /PR/.test(x.alternative ?? ""), /merge/.test(x.alternative ?? "")];
    const altBase = (x) => [/git -C <[^>]+> pull --ff-only origin <基底>/.test(x.alternative ?? ""), /PR/.test(x.alternative ?? ""), /merge/.test(x.alternative ?? "")];
    // 基底の更新（形 A）が設定由来のリベースで拒否される: 設定のキーと値・分類・別の作業ツリーの案内・facts
    gitOut(w, "checkout", "-q", "main");
    cfgSet("pull.rebase", "true");
    const a1 = full("git pull --ff-only origin main"), a2 = full("git pull --ff-only origin main");
    cfgUnset("pull.rebase");
    eq("sync-base-branch/2.3 設定由来のリベースの拒否に設定のキーと値・分類が含まれる", [a1.code, /pull\.rebase=true/.test(a1.reason), /保護ブランチ/.test(a1.reason), /origin\/main|origin main/.test(a1.reason)], ["sync-not-fast-forward", true, true, true]);
    eq("sync-base-branch/2.3 拒否の案内に別の作業ツリーでの pull --ff-only・PR・brw merge が含まれる", altOk(a1), [true, true, true]);
    eq("sync-base-branch/2.3 facts に実効値と由来を載せる", [a1.facts.ff, a1.facts.rebase, a1.facts.basis.rebase, a1.facts.basis.configKeys], ["only", true, "config", ["pull.rebase"]]);
    eq("sync-base-branch/2.3 同じ入力を 2 回判定すると識別子・理由・案内・根拠が一致", [decisionSignature(a1), a1.reason, a1.alternative, a1.facts], [decisionSignature(a2), a2.reason, a2.alternative, a2.facts]);
    // 引数由来・設定の ff
    const b = full("git pull --rebase origin main");
    eq("sync-base-branch/2.3 引数由来の判定は由来が arg で、設定のキーは理由に含めない", [b.facts.basis.rebase, b.facts.basis.configKeys, /pull\.rebase=/.test(b.reason)], ["arg", [], false]);
    cfgSet("merge.ff", "false");
    const c = full("git merge origin/main");
    cfgUnset("merge.ff");
    eq("sync-base-branch/2.3 merge.ff=false 由来の拒否に設定のキーと値が含まれ ff の実効値が facts に載る", [c.code, /merge\.ff=false/.test(c.reason), c.facts.ff, c.facts.basis.ff, c.facts.basis.configKeys], ["sync-not-fast-forward", true, "never", "config", ["merge.ff"]]);
    const d = full("git pull origin main");
    eq("sync-base-branch/2.3 --ff-only が無い拒否も分類・案内を含み、既定の由来は default", [d.code, /保護ブランチ/.test(d.reason), altOk(d), d.facts.basis.ff], ["sync-ff-only-required", true, [true, true, true], "default"]);
    // 開発ブランチ上のリベース（形 B）
    gitOut(w, "checkout", "-q", "dev/foo");
    cfgSet("pull.rebase", "true");
    const e = full("git pull origin main");
    cfgUnset("pull.rebase");
    eq("sync-base-branch/2.3 開発ブランチへの取り込みのリベース拒否にも設定のキーと値・案内・facts が載る", [e.code, /pull\.rebase=true/.test(e.reason), altOk(e), e.facts.rebase, e.facts.basis.rebase], ["sync-rebase", true, [true, true, true], true, "config"]);
    eq("sync-base-branch/2.3 形 B の拒否の理由に取り込み先・取り込み元の分類が含まれる", [/開発ブランチ/.test(e.reason), /保護ブランチ/.test(e.reason)], [true, true]);
    // fetch は形 A 以外を更新を許さない旨で拒否し、案内を付ける
    const f = ["git fetch origin dev/bar:dev/bar", "git fetch origin dev/foo:dev/foo"].map((cmd) => full(cmd));
    eq("sync-base-branch/2.3 fetch の形 A 以外は merge-non-development で更新を許さない旨と案内を返す", f.map((x) => [x.verdict, x.code, /更新は許可されません/.test(x.reason), /開発ブランチ/.test(x.reason), altBase(x)]), Array(2).fill(["deny", "merge-non-development", true, true, [true, true, true]]));
    // 取り込み元の分類
    eq("sync-base-branch/2.3 取り込み元の分類を理由に含める（宣言外の取り込み元）", (() => { gitOut(w, "update-ref", "refs/remotes/origin/other/q", "main"); const x = full("git merge origin/dev/bar origin/other/q"); return [x.code, /宣言外/.test(x.reason)]; })(), ["merge-non-development", true]);
    eq("sync-base-branch/2.3 許可の識別子は変わらない（開発ブランチ上の基底の取り込み）", decisionSignature(full("git merge origin/main")), "merge|eligibleForApproval|compliant|skip|sync-base-merge");
    fr.cleanup();
  }

  // ---- sync-base-branch 4.1 監査での穴埋め（判定の単体テスト） ----
  {
    const mk = (register = true) => {
      const fr = mkRepoWithRemote({ branch: "dev/foo", config: CONFIG, register });
      const w = fr.dir;
      gitOut(w, "branch", "develop");
      gitOut(w, "update-ref", "refs/remotes/origin/main", "main");
      gitOut(w, "update-ref", "refs/remotes/origin/develop", "develop");
      return { w, cleanup: fr.cleanup };
    };
    const R = mk(true);
    const w = R.w;
    const judge = (cmd) => { const o = classifyCommand(cmd, w).operations[0]; const x = evaluate(o, contextFor(o)); return [x.verdict, x.approval, x.code, x.approvalWhy]; };
    const cfgRun = (k, v, cmds, branch) => {
      if (branch) gitOut(w, "checkout", "-q", branch);
      gitOut(w, "config", k, v);
      try { return cmds.map((c) => judge(c)); } finally { gitOut(w, "config", "--unset", k); if (branch) gitOut(w, "checkout", "-q", "dev/foo"); }
    };
    const deny = (code) => ["deny", "notApplicable", code, null];
    // 作業ブランチの作業ツリーからの fetch の同名更新（要件 1.2 の本来の使い方）
    eq("sync-base-branch/4.1 作業ブランチ上から基底・保護ブランチへの fetch の同名更新は確認省略の対象（1.2）", ["git fetch origin main:main", "git fetch origin develop:develop", "git fetch origin main:main main:refs/remotes/origin/main"].map((c) => judge(c)), Array(3).fill(["eligibleForApproval", "skip", "sync-base-fast-forward", null]));
    // fetch の従来分類（強制・別名・登録外・フラグ）は確定不能で拒否のまま。追跡ブランチだけの更新は照会のまま
    eq("sync-base-branch/4.1 fetch の強制・フラグ・別名・登録外のリモート・. ・URL は従来どおり unresolved で拒否（1.5・6.4）", ["git fetch --force origin main:main", "git fetch -f origin main:main", "git fetch --update-head-ok origin main:main", "git fetch -u origin main:main", "git fetch --refmap= origin main:main", "git fetch origin +main:main", "git fetch . dev/foo:main", "git fetch https://example.com/x.git main:main", "git fetch upstream main:main", "git fetch origin main:other"].map((c) => judge(c)), Array(10).fill(deny("unresolved")));
    eq("sync-base-branch/4.1 追跡ブランチだけを更新する fetch は照会のまま通る（6.3）", ["git fetch origin", "git fetch origin main:refs/remotes/origin/main"].map((c) => judge(c).slice(0, 3)), Array(2).fill(["pass", "notApplicable", "query"]));
    eq("sync-base-branch/4.1 -c による設定の上書き・展開を含む引数は確定不能で拒否（1.5）", ["git -c pull.rebase=true pull --ff-only origin main", "git -c merge.ff=false merge origin/main", "git pull --ff-only $R main"].map((c) => judge(c)), Array(3).fill(deny("unresolved")));
    // 設定と引数の組み合わせ（形 A は main 上で判定する）
    eq("sync-base-branch/4.1 pull.ff=only の設定があっても --no-ff の引数が優先され拒否（1.4・1.5）", cfgRun("pull.ff", "only", ["git pull --no-ff origin main", "git pull origin main"], "main"), [deny("sync-not-fast-forward"), ["eligibleForApproval", "skip", "sync-base-fast-forward", null]]);
    eq("sync-base-branch/4.1 merge.ff=only は merge・pull とも --ff-only 相当、merge.ff=false でも引数の --ff-only が優先（1.4）", [cfgRun("merge.ff", "only", ["git merge origin/main", "git pull origin main"], "main"), cfgRun("merge.ff", "false", ["git merge --ff-only origin/main", "git pull --ff-only origin main"], "main")], [Array(2).fill(["eligibleForApproval", "skip", "sync-base-fast-forward", null]), Array(2).fill(["eligibleForApproval", "skip", "sync-base-fast-forward", null])]);
    eq("sync-base-branch/4.1 形 A でも branch.<名前>.rebase=true は拒否、pull.rebase=false は許可（1.5）", [cfgRun("branch.main.rebase", "true", ["git pull --ff-only origin main"], "main"), cfgRun("pull.rebase", "false", ["git pull --ff-only origin main"], "main")], [[deny("sync-not-fast-forward")], [["eligibleForApproval", "skip", "sync-base-fast-forward", null]]]);
    eq("sync-base-branch/4.1 形 B: merge.ff=false・--ff 指定でも許可、branch.<名前>.rebase=true の pull は sync-rebase（2.2・2.4）", [cfgRun("merge.ff", "false", ["git merge origin/main"]), judge("git merge --ff origin/main"), cfgRun("branch.dev/foo.rebase", "true", ["git pull origin main"])], [[["eligibleForApproval", "skip", "sync-base-merge", null]], ["eligibleForApproval", "skip", "sync-base-merge", null], [deny("sync-rebase")]]);
    // <元>:<先> の取り込み元（refspecDst）は形 A・B のどちらにも当たらない
    gitOut(w, "checkout", "-q", "main");
    eq("sync-base-branch/4.1 git pull origin main:main 系（refspecDst）は形 A にも当たらず拒否（1.5・6.4）", ["git pull --ff-only origin main:main", "git pull --ff-only origin main:dev/foo", "git pull --ff-only origin refs/heads/main:refs/heads/main"].map((c) => judge(c)), Array(3).fill(deny("merge-non-development")));
    // detached HEAD: 取り込み先を確定できない pull・merge は拒否、fetch の同名更新は取り込み先がブランチ指定なので許可
    gitOut(w, "checkout", "-q", "--detach");
    eq("sync-base-branch/4.1 detached HEAD の pull・merge は取り込み先を確定できず拒否（1.6）", ["git pull --ff-only origin main", "git merge --ff-only origin/main", "git merge origin/main"].map((c) => judge(c)), Array(3).fill(deny("unresolved")));
    eq("sync-base-branch/4.1 detached HEAD でも fetch の同名更新は許可される（更新先は fetch が示すブランチ）", judge("git fetch origin main:main"), ["eligibleForApproval", "skip", "sync-base-fast-forward", null]);
    gitOut(w, "checkout", "-q", "dev/foo");
    R.cleanup();
    // 編集中の宣言（登録済みだが作業ツリーが HEAD と不一致）: 確認を省略せず通常の承認。判定の可否は登録の有無に依らない
    const E = mk(true);
    const we = E.w;
    writeFileSync(join(we, ".branch-release-workflow.json"), JSON.stringify({ ...CONFIG, autoApprove: { push: true } }));
    const judgeE = (cmd) => { const o = classifyCommand(cmd, we).operations[0]; const x = evaluate(o, contextFor(o)); return [x.verdict, x.approval, x.code, x.approvalWhy]; };
    eq("sync-base-branch/4.1 編集中の宣言: 形 B（merge・pull）と --abort は通常の承認（確認を省略しない）", [judgeE("git merge origin/main"), judgeE("git pull origin main"), judgeE("git merge --abort")], [["pass", "normal", "sync-base-merge", "unregistered"], ["pass", "normal", "sync-base-merge", "unregistered"], ["pass", "normal", "merge-development", "no-source"]]);
    eq("sync-base-branch/4.1 編集中の宣言: 形 A（pull・merge・fetch）も通常の承認で、拒否は変わらない", (() => {
      const ok = ["git fetch origin main:main"].map((c) => judgeE(c));
      gitOut(we, "checkout", "-q", "main");
      const onMain = ["git pull --ff-only origin main", "git merge --ff-only origin/main"].map((c) => judgeE(c));
      const rej = ["git pull origin main", "git pull --rebase origin main"].map((c) => judgeE(c).slice(0, 3));
      gitOut(we, "checkout", "-q", "--", ".");
      return [ok, onMain, rej];
    })(), [[["pass", "normal", "sync-base-fast-forward", "unregistered"]], Array(2).fill(["pass", "normal", "sync-base-fast-forward", "unregistered"]), [["deny", "notApplicable", "sync-ff-only-required"], ["deny", "notApplicable", "sync-not-fast-forward"]]]);
    E.cleanup();
    // 取り込み元の指定が無い操作は、形 A の基底ブランチ上でも確認を省略しない（拒否）
    const N = mk(true);
    gitOut(N.w, "checkout", "-q", "main");
    const jn = (cmd) => { const o = classifyCommand(cmd, N.w).operations[0]; const x = evaluate(o, contextFor(o)); return [x.verdict, x.approval, x.code]; };
    eq("sync-base-branch/4.1 取り込み元の指定が無い操作（--abort・--continue）は基底ブランチ上でも確認を省略せず拒否", [jn("git merge --abort"), jn("git merge --continue")], Array(2).fill(["deny", "notApplicable", "merge-non-development"]));
    N.cleanup();
    // 2.4 <元>:<先> の形の pull は、取り込み元・取り込み先の分類や登録の有無にかかわらず拒否（3.4・6.2）
    for (const reg of [true, false]) {
      const Q = mk(reg);
      const jq = (cmd) => { const o = classifyCommand(cmd, Q.w).operations[0]; const x = evaluate(o, contextFor(o)); return [x.verdict, x.approval, x.code, x.approvalWhy]; };
      const dn = ["deny", "notApplicable", "merge-non-development", null];
      eq(`sync-base-branch/2.4 開発ブランチ上の <元>:<先> の pull は常に拒否、<元> のみの pull は従来どおり（登録${reg ? "済み" : "なし"}）`,
        [["git pull origin dev/bar:main", "git pull origin dev/bar:dev/baz", "git pull origin main:main", "git pull origin main:dev/foo"].map(jq), jq("git pull origin dev/bar")[2], jq("git pull origin main")[2]],
        [Array(4).fill(dn), "merge-development", "sync-base-merge"]);
      gitOut(Q.w, "checkout", "-q", "main");
      eq(`sync-base-branch/2.4 基底上の git pull --ff-only origin main:main も拒否し、理由と案内を持つ（登録${reg ? "済み" : "なし"}）`,
        (() => { const o = classifyCommand("git pull --ff-only origin main:main", Q.w).operations[0]; const x = evaluate(o, contextFor(o)); return [jq("git pull --ff-only origin main:main"), jq("git pull --ff-only origin main")[2], /手元のブランチを書き換える pull は許可しません/.test(x.reason), /git pull origin <ブランチ>/.test(x.alternative) && /pull --ff-only origin/.test(x.alternative)]; })(),
        [dn, "sync-base-fast-forward", true, true]);
      Q.cleanup();
    }
  }

  // ---- sync-base-branch 4.3実際の git の挙動（使い捨てのリポジトリで git を実行して確かめる） ----
  {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const ALLOW = ["eligibleForApproval", "skip", "sync-base-fast-forward", null];
    const judgeAt = (cmd, cwd) => { const x = evaluateAll(classifyCommand(cmd, cwd), {}); return [x.verdict, x.approval, x.code, x.approvalWhy]; };
    // git を実行して [終了コード, 実行後の main の先端] を返す（失敗しても例外にしない）
    const run = (cwd, repo, ...args) => {
      let code = 0;
      try { gitOut(cwd, ...args); } catch (e) { code = e.status ?? -1; }
      return [code, gitOut(repo, "rev-parse", "main")];
    };
    // 別の clone からリモートの main を 1 commit 進める
    const advanceRemote = (remote, tmps) => {
      const c = mkdtempSync(join(tmpdir(), "brw-cl-"));
      tmps.push(c);
      gitOut(c, "clone", "-q", remote, ".");
      gitOut(c, "commit", "-q", "--allow-empty", "-m", "リモートの更新");
      gitOut(c, "push", "-q", "origin", "main");
      return gitOut(c, "rev-parse", "HEAD");
    };
    const tmps = [];

    // 1. 履歴が分岐したとき、3 つの更新はいずれも git に止められ、手元の main は変わらない
    const A = mkRepoWithRemote({ branch: "main", config: CONFIG });
    advanceRemote(A.remote, tmps);
    gitOut(A.dir, "commit", "-q", "--allow-empty", "-m", "手元の更新");
    const localTip = gitOut(A.dir, "rev-parse", "main");
    gitOut(A.dir, "fetch", "-q", "origin");
    const pullDiv = run(A.dir, A.dir, "pull", "--ff-only", "origin", "main");
    const mergeDiv = run(A.dir, A.dir, "merge", "--ff-only", "origin/main");
    const wtA = mkWorktree(A.dir, "dev/foo");
    const fetchDiv = run(wtA, A.dir, "fetch", "origin", "main:main");
    eq("sync-base-branch/4.3 分岐: pull --ff-only・merge --ff-only・fetch main:main は git が止め（終了コード非 0）、手元の main の先端は変わらない（1.2・1.3・1.4）", [pullDiv, mergeDiv, fetchDiv].map(([c, tip]) => [c !== 0, tip === localTip]), Array(3).fill([true, true]));
    // pull・fetch は取得前なので分岐を確かめず許可する。merge は origin/main が手元にあるため、分岐を見て拒否できる
    eq("sync-base-branch/4.3 分岐: pull・fetch の判定は取得前のため分岐を確かめず許可のまま（sync-ff-unverified の記述どおり）。手元に origin/main がある merge --ff-only は判定が拒否する（1.3・1.4）", [judgeAt("git pull --ff-only origin main", A.dir), judgeAt("git fetch origin main:main", wtA), judgeAt("git merge --ff-only origin/main", A.dir)], [ALLOW, ALLOW, ["deny", "notApplicable", "sync-not-fast-forward", null]]);
    eq("sync-base-branch/4.3 分岐していても --ff-only の無い pull は判定が拒否する（1.3）", judgeAt("git pull origin main", A.dir).slice(0, 3), ["deny", "notApplicable", "sync-ff-only-required"]);

    // 2. main を別の作業ツリーで確認中: fetch main:main は git に止められ、確認中の作業ツリーでの pull --ff-only は許可され main が進む
    const B = mkRepoWithRemote({ branch: "main", config: CONFIG });
    const wtB = mkWorktree(B.dir, "dev/foo");
    const remoteTip = advanceRemote(B.remote, tmps);
    const before = gitOut(B.dir, "rev-parse", "main");
    const fetchBusy = run(wtB, B.dir, "fetch", "origin", "main:main");
    eq("sync-base-branch/4.3 main を別の作業ツリーで確認中だと、作業ブランチの作業ツリーからの fetch main:main は git が止め、main は変わらない（1.2）", [fetchBusy[0] !== 0, fetchBusy[1] === before, before !== remoteTip], [true, true, true]);
    eq("sync-base-branch/4.3 その fetch も判定は許可（案内する代替の git -C <作業ツリー> pull --ff-only も同じ許可）（1.2・1.3）", [judgeAt("git fetch origin main:main", wtB), judgeAt(`git -C ${B.dir} pull --ff-only origin main`, wtB)], [ALLOW, ALLOW]);
    const pullBusy = run(wtB, B.dir, "-C", B.dir, "pull", "--ff-only", "origin", "main");
    eq("sync-base-branch/4.3 git -C <main を確認中の作業ツリー> pull --ff-only は実行でき、main が最新に fast-forward される（1.2）", [pullBusy[0], pullBusy[1] === remoteTip], [0, true]);

    // 3. 先に進めるだけ（ローカル main がリモートの祖先）: fetch main:main・pull --ff-only とも成功し、判定の許可と一致する
    const C = mkRepoWithRemote({ branch: "dev/foo", config: CONFIG });
    const tipC1 = advanceRemote(C.remote, tmps);
    const fetchOk = run(C.dir, C.dir, "fetch", "origin", "main:main");
    const D = mkRepoWithRemote({ branch: "main", config: CONFIG });
    const tipD = advanceRemote(D.remote, tmps);
    const pullOk = run(D.dir, D.dir, "pull", "--ff-only", "origin", "main");
    eq("sync-base-branch/4.3 先に進めるだけなら fetch main:main（main を確認していない作業ブランチから）・pull --ff-only（main 上）は成功して最新になる（1.2・1.3）", [fetchOk, pullOk], [[0, tipC1], [0, tipD]]);
    eq("sync-base-branch/4.3 成功する先に進めるだけの更新は判定でも許可で、分岐のときと判定が同じ（1.2・1.3）", [judgeAt("git fetch origin main:main", C.dir), judgeAt("git pull --ff-only origin main", D.dir)], [ALLOW, ALLOW]);

    for (const x of [A, B, C, D]) x.cleanup();
    for (const t of tmps) rmSync(t, { recursive: true, force: true });
  }

  // ---- 3.3 保護対象への PR は作成まで ----
  const pr = (head, base, extra = "") => ev(`gh pr create --head ${head} --base ${base} --title t --body b ${extra}`);
  eq("enforcement/3.3 開発ブランチから保護対象・恒常的な分岐元への PR 作成は適合・確認省略の対象", [pr("dev/foo", "main"), pr("dev/foo", "develop")].map((x) => sig(x)), Array(2).fill(["eligibleForApproval", "compliant", "skip", "pr-create-protected"]));
  eq("enforcement/3.3 gh pr create は head を push しうるため、push の禁止・push の確認省略の無効があると確認を省略しない", (() => {
    const x = pr("dev/foo", "main"); const y = ev("gh pr create --head dev/foo --base main -t t -b b", { noPush: true });
    const op = mkRepoWithRemote({ branch: "dev/foo", config: { ...CONFIG, autoApprove: { push: false } } });
    gitOut(op.dir, "remote", "set-url", "origin", "https://github.com/acme/app.git");
    const o = classifyCommand("gh pr create --head dev/foo --base main -t t -b b", op.dir).operations[0]; const z = evaluate(o, { ...contextFor(o), origin: "brw-publish" });
    op.cleanup();
    return [x.verdict, y.verdict, y.approvalWhy, z.verdict, z.approvalWhy];
  })(), ["eligibleForApproval", "pass", "work-restriction-push", "pass", "opt-out-push"]);
  // brw-pr-handoff 1.1・1.7・6.3: 起点が既定（エージェント）の直接の PR 作成は、規則に適合しても拒否して brw pr を案内する
  eq("brw-pr-handoff/1.1 エージェント起点の gh pr create・REST・MCP は、適合する作成も pr-create-use-brw で拒否し、brw pr を案内する", (() => {
    const agent = (cmd) => ev(cmd, {}, d, "agent");
    const gh = agent("gh pr create --head dev/foo --base main --title t --body b");
    const rest = agent("gh api repos/acme/app/pulls -f title=t -f head=dev/foo -f base=main");
    const mcp = (() => { const op = classifyMcpCall("mcp__github__create_pull_request", { owner: "acme", repo: "app", title: "t", head: "dev/foo", base: "main" }, d).operations[0]; return evaluate(op, { ...contextFor(op), origin: "agent" }); })();
    return [gh, rest, mcp].map((x) => [x.verdict, x.code, /brw\.mjs.? pr-template/.test(x.alternative) && /brw\.mjs.? pr[`\s]/.test(x.alternative)]);
  })(), Array(3).fill(["deny", "pr-create-use-brw", true]));
  eq("brw-pr-handoff/1.1 起点を渡さない判定（既定）も拒否側になる（渡し忘れが安全側）", sig(evaluateAll(classifyCommand("gh pr create --head dev/foo --base main --title t --body b", d))).slice(0, 2).concat(evaluateAll(classifyCommand("gh pr create --head dev/foo --base main --title t --body b", d)).code), ["deny", "compliant", "pr-create-use-brw"]);
  eq("brw-pr-handoff/1.1 不適合の PR 作成の拒否の理由と案内は従来のまま（brw pr に置き換えない）", (() => { const x = ev("gh pr create --head dev/foo --base dev/other --title t --body b", {}, d, "agent"); return [x.verdict, x.code]; })(), ["deny", "pr-create-development"]);
  eq("brw-pr-handoff/1.7 内部の公開の起点（brw-publish）は従来の判定を使い、確認省略の対象になる", (() => { const x = ev("gh pr create --head dev/foo --base main --title t --body b", {}, d, "brw-publish"); return sig(x); })(), ["eligibleForApproval", "compliant", "skip", "pr-create-protected"]);
  eq("enforcement/3.3 REST の PR 作成（push を伴わない）は確認省略の対象", (() => { const x = ev("gh api repos/acme/app/pulls -f title=t -f head=dev/foo -f base=main"); return sig(x); })(), ["eligibleForApproval", "compliant", "skip", "pr-create-protected"]);
  eq("enforcement/3.3 MCP の PR 作成も同じ判定", (() => { const op = classifyMcpCall("mcp__github__create_pull_request", { owner: "acme", repo: "app", title: "t", head: "dev/foo", base: "main" }, d).operations[0]; return sig(evaluate(op, { ...contextFor(op), origin: "brw-publish" })); })(), ["eligibleForApproval", "compliant", "skip", "pr-create-protected"]);
  eq("enforcement/3.3 開発ブランチ間の PR 作成は拒否し、ローカルマージを案内する", (() => { const x = pr("dev/foo", "dev/other"); return [x.verdict, x.code, /brw\.mjs.? merge/.test(x.alternative)]; })(), ["deny", "pr-create-development", true]);
  eq("enforcement/3.3 宣言外への PR 作成は拒否する", [pr("dev/foo", "other/z"), pr("dev/foo", "feature/q")].map((x) => [x.verdict, x.code]), Array(2).fill(["deny", "pr-create-undeclared"]));
  eq("enforcement/3.3 取り込み元が開発ブランチでない PR 作成は拒否する", [pr("main", "develop"), pr("other/z", "main"), pr("develop", "main")].map((x) => [x.verdict, x.code]), Array(3).fill(["deny", "pr-create-head"]));
  eq("enforcement/3.3 別のリポジトリ・fork の head・対象を確定できない PR 作成は拒否する", ["gh pr create --head dev/foo --base main -R other/repo -t t -b b", "gh pr create --head fork:dev/foo --base main -t t -b b", "gh pr create --head dev/foo -t t -b b", "gh api graphql -f query='mutation { createPullRequest(input:{repositoryId:\"R\", headRefName:\"dev/foo\", baseRefName:\"main\", title:\"t\"}) { pullRequest { url } } }'"].map((x) => ev(x).verdict), Array(4).fill("deny"));
  eq("enforcement/3.3 PR の拒否にも作成可否と承認の別が付く", (() => { const x = pr("dev/foo", "dev/other"); return [x.compliance, x.approval]; })(), ["violation", "notApplicable"]);

  // ---- 対応外の書き込み ----
  eq("enforcement/1.4 ブランチの先を直接動かしうる書き込みは拒否する", ["gh api repos/acme/app/git/refs/heads/main -X PATCH -f sha=abc", "gh api repos/acme/app/contents/a.txt -X PUT -f message=m -f content=Yg== -f branch=main", "gh api repos/acme/app/pulls/5/update-branch -X PUT"].map((x) => [ev(x).verdict, ev(x).code]), Array(3).fill(["deny", "unsupported-ref-write"]));
  eq("enforcement/1.4 ブランチの先を動かさない対応外の書き込みは強制範囲外として通常のホスト承認に委ねる", ["gh pr comment 5 -b x", "gh pr ready 5", "gh api repos/acme/app/issues -f title=x"].map((x) => sig(ev(x))), Array(3).fill(["pass", "outOfScope", "normal", "unsupported-write"]));
  eq("enforcement/1.4 対応外の書き込みも未導入のリポジトリでは通す", (() => { const o = classifyCommand("gh pr comment 5 -b x", tmpdir()).operations[0]; return sig(evaluate(o, contextFor(o))); })(), ["pass", "notApplicable", "notApplicable", "not-managed"]);

  // ---- ホスト間の比較 ----
  eq("enforcement/1.1 同じ操作の判定は呼び出し元のホストに依らず同じ判定理由になる", (() => {
    const cmds = ["git push origin dev/foo", "git push origin main", "git switch -c dev/n", "git merge dev/other", "gh pr merge 5", "git push --all"];
    return cmds.map((cmd) => {
      const op = classifyCommand(cmd, d).operations[0];
      const a = evaluate(op, { ...contextFor(op), host: "claude" });
      const b = evaluate(op, { ...contextFor(op), host: "codex" });
      return JSON.stringify(a) === JSON.stringify(b) && decisionSignature(a) === decisionSignature(b) && decisionSignature(a).length > 0;
    });
  })(), Array(6).fill(true));
  eq("enforcement/1.1 判定の識別子は種類・判定・適合・承認・理由コードを含む", decisionSignature(ev("git push origin dev/foo")), "push|eligibleForApproval|compliant|skip|push-development");

  r.cleanup();
  for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
};
