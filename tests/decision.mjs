// 操作可否の共通判定（brw-enforcement 2.3）の契約テスト。selftest.mjs から呼ばれる。
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyCommand, classifyMcpCall } from "../scripts/operation-policy.mjs";
import { contextFor, decisionSignature, evaluate, evaluateAll } from "../scripts/operation-decision.mjs";
import { gitOut, mkRepoWithRemote } from "./support/git-fixture.mjs";

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
  eq("enforcement/1.3 開発ブランチへの commit は適合", sig(ev("git commit -m x")), ["pass", "compliant", "notApplicable", "commit-development"]);
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
  ], ["eligibleForApproval", "pass", "pass", "deny", "pass"]);

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
  eq("enforcement/3.2 開発ブランチへの取り込み元が開発ブランチでなければ拒否する", ["git merge main", "git merge other/z", "git pull origin main"].map((x) => [ev(x).verdict, ev(x).code]), Array(3).fill(["deny", "merge-non-development"]));
  eq("enforcement/3.2 GitHub 側のマージと自動マージ予約を拒否する", ["gh pr merge 5", "gh pr merge 5 --squash", "gh pr merge 5 --auto", "gh api -X PUT repos/acme/app/pulls/5/merge", "gh api repos/acme/app/merges -f base=main -f head=dev/foo", "gh api graphql -f query='mutation { mergePullRequest(input:{pullRequestId:\"X\"}) { clientMutationId } }'"].map((x) => [ev(x).verdict, ev(x).code]), [["deny", "github-merge"], ["deny", "github-merge"], ["deny", "github-merge"], ["deny", "github-merge"], ["deny", "github-merge"], ["deny", "github-merge"]]);
  eq("enforcement/3.2 自動マージ予約の拒否理由は予約を示す", ev("gh pr merge 5 --auto").code, "github-merge");
  eq("enforcement/3.2 MCP のマージも拒否する", (() => {
    const out = ["merge_pull_request"].map((t) => { const op = classifyMcpCall(`mcp__github__${t}`, { owner: "acme", repo: "app", pullNumber: 5 }, d).operations[0]; return evaluate(op, contextFor(op)); });
    return out.map((x) => [x.verdict, x.code]);
  })(), [["deny", "github-merge"]]);
  eq("enforcement/3.2 GitHub マージの拒否は対象が確定できなくても同じ理由にする", [ev("gh pr merge").verdict, ev("gh pr merge $N").verdict], ["deny", "deny"]);

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
