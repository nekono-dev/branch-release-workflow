#!/usr/bin/env node
// 判定ロジックと各サブコマンドの自己テスト。一時 git リポジトリで実行する。 使い方: node tests/selftest.mjs
// テスト名に含まれる「<機能名>/AC-n」は、導入時の受け入れ条件を識別するための履歴上のラベル。
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { autoApprovable, judgeCommand } from "../scripts/brw.mjs";
import { deliveryOf, globToRegExp, loadConfig, normalizeConfig, parsePushBranches, resolveVars, undeclaredCiBranches, validateConfig } from "../scripts/lib.mjs";
import * as deployCf from "../scripts/deploy/cloudflare-workers.mjs";
import { getProvider, previewUrl } from "../scripts/providers/index.mjs";
import * as cloudflare from "../scripts/providers/cloudflare-previews.mjs";
import { runSupportChecks } from "./support/selftest-support.mjs";
import { runEnforcementChecks } from "./enforcement.mjs";
import { runDecisionChecks } from "./decision.mjs";
import { runGithubWriteChecks } from "./github-write.mjs";
import { runGithubClientChecks } from "./github-client.mjs";
import { runGithubRulesetChecks } from "./github-ruleset.mjs";
import { runWorkStateChecks } from "./work-state.mjs";
import { runReadyChecks } from "./ready.mjs";
import { runPublishPlanChecks } from "./publish-plan.mjs";
import { runPublishPushChecks } from "./publish-push.mjs";
import { runPublishPrChecks } from "./publish-pr.mjs";
import { runRulesetChoiceChecks } from "./ruleset-choice.mjs";
import { runRulesetPreflightChecks } from "./ruleset-preflight.mjs";
import { runRulesetApplyChecks } from "./ruleset-apply.mjs";
import { runRulesetInspectChecks } from "./ruleset-inspect.mjs";
import { runAgentHookChecks } from "./agent-hooks.mjs";
import { runAgentHookSessionChecks } from "./agent-hooks-session.mjs";
import { runHookInstallChecks } from "./hook-install.mjs";
import { runHookDiagnoseChecks } from "./hook-diagnose.mjs";
import { runBranchOpsChecks } from "./branch-ops.mjs";
import { runPublishCliChecks } from "./publish-cli.mjs";
import { runSetupCliChecks } from "./setup-cli.mjs";
import { runIntegrationPublishChecks } from "./integration-publish.mjs";

// gh で GitHub Variables を読まない（結果を手元の環境に左右させない）。子プロセスにも引き継ぐ
process.env.BRW_NO_GH = "1";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const brw = join(root, "scripts/brw.mjs");
let failed = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n     got : ${JSON.stringify(got)}\n     want: ${JSON.stringify(want)}`}`);
};

const g = (cwd, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, stdio: "ignore" });
// 宣言は commit して登録する。register: false なら作業ツリーに置くだけにする
const mkRepo = (branch, config, { register = true, settings } = {}) => {
  const d = mkdtempSync(join(tmpdir(), "brw-"));
  g(d, "init", "-q", "-b", "main");
  g(d, "commit", "-q", "--allow-empty", "-m", "i");
  if (config || settings) mkdirSync(join(d, ".claude"));
  if (settings) writeFileSync(join(d, ".claude/settings.json"), JSON.stringify(settings));
  if (config) {
    writeFileSync(join(d, ".claude/branch-release-workflow.json"), JSON.stringify(config));
    if (register) {
      g(d, "add", ".claude/branch-release-workflow.json");
      g(d, "commit", "-q", "-m", "宣言");
    }
  }
  if (branch !== "main") g(d, "checkout", "-q", "-b", branch);
  return d;
};
const run = (cwd, ...args) => spawnSync("node", [brw, ...args], { cwd, encoding: "utf8" });
const cfg = { workBranches: ["dev/*"], protectedBranches: ["main", "develop"], namePattern: "^dev/[a-z0-9]+(-[a-z0-9]+)*$", preview: { provider: "url-template", urlTemplate: "https://{alias}.example.com" } };
const d = (cmd, repo) => judgeCommand(cmd, repo).decision;

const onMain = mkRepo("main", cfg);
const onDev = mkRepo("dev/foo", cfg);
const onOther = mkRepo("feature/x", cfg);
const noCfg = mkRepo("main", null);
const badCfg = mkRepo("dev/foo", { workBranches: "x" });

// 共通宣言・旧パス互換・Codex の CLI 判定と導入を実際の一時リポジトリで検証する。
const shared = mkRepo("dev/foo", null);
writeFileSync(join(shared, ".branch-release-workflow.json"), JSON.stringify(cfg));
g(shared, "add", ".branch-release-workflow.json");
g(shared, "commit", "-q", "-m", "shared");
eq("branch-guard/AC-12 共通宣言を読み込める", loadConfig(shared).config.workBranches, cfg.workBranches);
eq("branch-guard/AC-12 共通宣言を登録後に check が成功する", run(shared, "check").status, 0);
mkdirSync(join(shared, ".claude"));
writeFileSync(join(shared, ".claude/branch-release-workflow.json"), "invalid JSON");
eq("branch-guard/AC-12 ルート宣言を旧パスより優先する", loadConfig(shared).config.workBranches, cfg.workBranches);
eq("branch-guard/AC-12 旧パスの宣言を後方互換で読める", loadConfig(onDev).config.workBranches, cfg.workBranches);
eq("branch-guard/AC-13 Codex guard は作業ブランチを許可", run(shared, "guard", "git push origin dev/foo").status, 0);
eq("branch-guard/AC-13 Codex guard は保護ブランチへの送り先を拒否", run(shared, "guard", "git push origin HEAD:main").status, 1);
eq("branch-guard/AC-13 Codex guard は不明な操作を確認扱いで停止", run(shared, "guard", "git push --all").status, 1);
const newSetup = mkRepo("develop", null);
writeFileSync(join(newSetup, ".branch-release-workflow.json"), JSON.stringify(cfg));
eq("branch-guard/AC-12 未登録の共通宣言で worktree を作成できる", run(newSetup, "create", "shared-setup").status, 0);
eq("branch-guard/AC-12 共通宣言は新規 worktree へ移される", existsSync(join(newSetup, ".claude/worktrees/dev-shared-setup/.branch-release-workflow.json")), true);
const skillsDir = mkdtempSync(join(tmpdir(), "brw-skills-"));
const install = () => spawnSync("node", [join(root, "scripts/install-codex.mjs"), "--skills-dir", skillsDir], { encoding: "utf8" });
eq("branch-guard/AC-13 Codex skill をリンクできる", install().status, 0);
eq("branch-guard/AC-13 Codex skill の再導入は成功する", install().status, 0);
eq("branch-guard/AC-13 リンクから本体を読める", readFileSync(join(skillsDir, "branch-release-workflow/SKILL.md"), "utf8"), readFileSync(join(root, "SKILL.md"), "utf8"));
const linkedCli = join(skillsDir, "branch-release-workflow/scripts/brw.mjs");
const linkedGuard = spawnSync("node", [linkedCli, "guard", "git push origin HEAD:main"], { cwd: shared, encoding: "utf8" });
eq("branch-guard/AC-13 リンク経由の CLI が保護ブランチへの push を拒否する", linkedGuard.status, 1);
eq("branch-guard/AC-13 リンク経由の CLI が判定結果を表示する", linkedGuard.stdout.includes("[deny]"), true);
rmSync(join(skillsDir, "branch-release-workflow"));
mkdirSync(join(skillsDir, "branch-release-workflow"));
writeFileSync(join(skillsDir, "branch-release-workflow/keep"), "keep");
eq("branch-guard/AC-13 Codex の既存の別の導入先を上書きしない", install().status, 1);
eq("branch-guard/AC-13 既存の内容を維持する", readFileSync(join(skillsDir, "branch-release-workflow/keep"), "utf8"), "keep");

// ---- branch-guard ----
eq("branch-guard/AC-1 作業ブランチが空の宣言は不正", validateConfig({ workBranches: [], protectedBranches: [] }).length, 1);
eq("branch-guard/AC-1 不正な宣言ファイルは読み込みでエラー", typeof loadConfig(badCfg).error, "string");
eq("branch-guard/AC-1 正常な宣言は検証を通る", validateConfig(cfg), []);
eq("branch-guard/AC-2 保護ブランチの commit は deny", d("git commit -m x", onMain), "deny");
eq("branch-guard/AC-2 作業ブランチの commit は allow", d("git commit -m x", onDev), "allow");
eq("branch-guard/AC-2 宣言外ブランチの commit は deny", d("git commit -m x", onOther), "deny");
eq("branch-guard/AC-3 宣言ファイルが無ければ判定しない", d("git commit -m x", noCfg), "allow");
const enabledNoCfg = mkRepo("main", null, { settings: { enabledPlugins: { "branch-release-workflow@nekono-dev": true } } });
eq("branch-guard/AC-10 プラグインを有効にしたリポジトリで宣言が無ければ deny", d("git commit -m x", enabledNoCfg), "deny");
eq("branch-guard/AC-10 無効にしていれば判定しない", d("git commit -m x", mkRepo("main", null, { settings: { enabledPlugins: { "branch-release-workflow@nekono-dev": false } } })), "allow");
eq("branch-guard/AC-3 宣言が不正なら ask", d("git push", badCfg), "ask");
eq("branch-guard/AC-3 --all は ask", d("git push --all origin", onDev), "ask");
eq("branch-guard/AC-4 HEAD:main への push は deny", d("git push origin HEAD:main", onDev), "deny");
eq("branch-guard/AC-4 refs/heads/main への push は deny", d("git push origin dev/foo:refs/heads/main", onDev), "deny");
eq("branch-guard/AC-4 作業ブランチの push は allow", d("git push -u origin dev/foo", onDev), "allow");
eq("branch-guard/AC-4 引数なし push は現在のブランチで判定", d("git push", onMain), "deny");
eq("branch-guard/AC-4 タグの push は allow", d("git push origin refs/tags/v1", onMain), "allow");
eq("branch-guard/AC-4 git -C を判定", d(`git -C ${onMain} commit -m x`, onDev), "deny");
eq("branch-guard/AC-4 cd && git を判定", d(`cd ${onMain} && git commit -m x`, onDev), "deny");
eq("branch-guard/AC-4 連結コマンドの2つ目も判定", d("git status && git push origin main", onDev), "deny");
eq("branch-guard/AC-4 git 以外は allow", d("echo git commit", onMain), "allow");
eq("branch-guard/AC-4 リダイレクトは送り先と見なさない", [d("git push origin dev/foo 2>&1", onDev), d("git push 2>/dev/null", onDev), d("git push -u origin dev/foo > log.txt", onDev)], ["allow", "allow", "allow"]);
eq("branch-guard/AC-4 リダイレクトがあっても保護ブランチへの push は deny", d("git push origin main 2>&1", onDev), "deny");

const created = mkRepo("develop", cfg);
const bad = run(created, "create", "Bad_Name", "--branch-only");
eq("branch-guard/AC-5 命名規則違反は終了コード 1", bad.status, 1);
eq("branch-guard/AC-5 命名規則違反はブランチを作らない", spawnSync("git", ["branch", "--list", "dev/*"], { cwd: created, encoding: "utf8" }).stdout.trim(), "");
eq("branch-guard/AC-5 規則に合う名前は作成される", run(created, "create", "good-name", "--branch-only").status, 0);

// 導入: 未登録の宣言は新しい worktree へ移り、そこで commit すると登録される
const setup = mkRepo("develop", cfg, { register: false });
eq("branch-guard/AC-11 未登録の宣言は整合検査でエラー", run(setup, "check").status, 1);
const setupWt = join(setup, ".claude/worktrees/dev-setup");
eq("branch-guard/AC-11 作業ブランチを作ると未登録の宣言が worktree へ移る", [run(setup, "create", "setup").status, existsSync(join(setupWt, ".claude/branch-release-workflow.json")), existsSync(join(setup, ".claude/branch-release-workflow.json"))], [0, true, false]);
g(setupWt, "add", ".claude/branch-release-workflow.json");
g(setupWt, "commit", "-q", "-m", "宣言");
eq("branch-guard/AC-11 commit した宣言は整合検査を通る", run(setupWt, "check").status, 0);

// push 後の片付けと再開。一時の bare リポジトリを origin にする
const remote = mkdtempSync(join(tmpdir(), "brw-remote-"));
g(remote, "init", "-q", "--bare");
const fin = mkRepo("develop", cfg);
g(fin, "remote", "add", "origin", remote);
g(fin, "push", "-q", "origin", "develop");
const hasBranch = (b) => spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${b}`], { cwd: fin }).status === 0;
// 切り出し元（origin/develop）へ取り込む。squash なら変更だけを 1 commit で入れる
const land = (branch, { squash = false } = {}) => {
  const tmp = mkdtempSync(join(tmpdir(), "brw-land-"));
  g(tmp, "clone", "-q", "-b", "develop", remote, ".");
  g(tmp, "fetch", "-q", "origin", branch);
  if (squash) {
    g(tmp, "merge", "-q", "--squash", `origin/${branch}`);
    g(tmp, "commit", "-q", "-m", "squash");
  } else g(tmp, "merge", "-q", "--no-ff", "-m", "merge", `origin/${branch}`);
  g(tmp, "push", "-q", "origin", "develop");
};
run(fin, "create", "fin-work");
const finWt = join(fin, ".claude/worktrees/dev-fin-work");
writeFileSync(join(finWt, "a.txt"), "a");
g(finWt, "add", "a.txt");
g(finWt, "commit", "-q", "-m", "w");
g(finWt, "push", "-q", "origin", "dev/fin-work");
eq("branch-guard/AC-8 push しただけ（切り出し元へ未取り込み）なら片付けず終了コード 1", run(finWt, "finish").status, 1);
eq("branch-guard/AC-8 片付けなかった worktree は残る", existsSync(finWt), true);
land("dev/fin-work");
writeFileSync(join(finWt, "dirty.txt"), "x");
eq("branch-guard/AC-8 commit していない変更があれば片付けない", run(finWt, "finish").status, 1);
rmSync(join(finWt, "dirty.txt"));
eq("branch-guard/AC-8 切り出し元へ取り込まれていれば worktree の中から片付けられる", run(finWt, "finish").status, 0);
eq("branch-guard/AC-8 worktree とローカルブランチが消える", [existsSync(finWt), hasBranch("dev/fin-work")], [false, false]);
eq("branch-guard/AC-8 作業ブランチでなければ片付けない", run(fin, "finish", "develop").status, 1);
run(fin, "create", "fin-squash");
const sqWt = join(fin, ".claude/worktrees/dev-fin-squash");
writeFileSync(join(sqWt, "b.txt"), "b");
g(sqWt, "add", "b.txt");
g(sqWt, "commit", "-q", "-m", "b1");
writeFileSync(join(sqWt, "b.txt"), "bb");
g(sqWt, "commit", "-q", "-am", "b2");
g(sqWt, "push", "-q", "origin", "dev/fin-squash");
land("dev/fin-squash", { squash: true });
run(fin, "create", "fin-open");
const openWt = join(fin, ".claude/worktrees/dev-fin-open");
g(openWt, "commit", "-q", "--allow-empty", "-m", "o");
g(openWt, "push", "-q", "origin", "dev/fin-open");
const swept = run(fin, "finish", "--merged");
eq("branch-guard/AC-8 --merged は squash merge で取り込まれたブランチを片付け、未取り込みのブランチは残す", [swept.status, existsSync(sqWt), existsSync(openWt)], [0, false, true]);
// submodule を含む worktree も片付けられる
const sub = mkRepo("main", null);
g(fin, "pull", "-q", "--no-rebase", "origin", "develop"); // land で進んだ origin/develop に追いつく
g(fin, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "sub");
g(fin, "commit", "-q", "-m", "sub");
g(fin, "push", "-q", "origin", "develop");
run(fin, "create", "fin-sub");
const subWt = join(fin, ".claude/worktrees/dev-fin-sub");
g(subWt, "-c", "protocol.file.allow=always", "submodule", "update", "-q", "--init");
g(subWt, "push", "-q", "origin", "dev/fin-sub");
land("dev/fin-sub");
eq("branch-guard/AC-8 submodule を含む worktree も片付けられる", [run(subWt, "finish").status, existsSync(subWt)], [0, false]);
eq("branch-guard/AC-9 リモートのブランチから worktree を作り直せる", run(fin, "resume", "dev/fin-work").status, 0);
eq("branch-guard/AC-9 作り直した worktree はリモートの commit を持ち、追跡先がリモートになる", [
  spawnSync("git", ["log", "-1", "--format=%s"], { cwd: finWt, encoding: "utf8" }).stdout.trim(),
  spawnSync("git", ["rev-parse", "--abbrev-ref", "@{u}"], { cwd: finWt, encoding: "utf8" }).stdout.trim(),
], ["w", "origin/dev/fin-work"]);
// 別の環境から push された更新は、残っている worktree へ取り込んでから使う
const other = mkdtempSync(join(tmpdir(), "brw-other-"));
g(other, "clone", "-q", "-b", "dev/fin-work", remote, ".");
g(other, "commit", "-q", "--allow-empty", "-m", "from-other");
g(other, "push", "-q", "origin", "dev/fin-work");
eq("branch-guard/AC-9 worktree が残っていれば、リモートの更新を取り込んで使う", [
  run(fin, "resume", "dev/fin-work").status,
  spawnSync("git", ["log", "-1", "--format=%s"], { cwd: finWt, encoding: "utf8" }).stdout.trim(),
], [0, "from-other"]);

// ---- 作業ブランチ運用の操作の確認を省く（autoApprove） ----
const autoCfg = { ...cfg, workBranches: ["develop", "dev/*"], protectedBranches: ["main"], baseBranch: "develop", autoApprove: { push: true, pullRequest: true } };
const auto = mkRepo("develop", autoCfg);
const aa = (cmd, repo = auto) => autoApprovable(cmd, repo);
eq("branch-guard/AC-14 作業ブランチへの push は確認を省く", [aa("git push origin develop"), aa("git push -u origin develop"), aa("git push"), aa("git push origin develop 2>&1 | tail -3"), aa(`cd ${auto} && git push -q origin dev/x`)], [true, true, true, true, true]);
eq("branch-guard/AC-14 保護ブランチ・宣言外への push は省かない", [aa("git push origin main"), aa("git push origin HEAD:main"), aa("git push origin feature/x")], [false, false, false]);
eq("branch-guard/AC-14 強制・削除・タグ・全ブランチは省かない", [aa("git push -f origin develop"), aa("git push --force-with-lease origin develop"), aa("git push origin +develop"), aa("git push origin :develop"), aa("git push --delete origin develop"), aa("git push --tags origin"), aa("git push --all origin"), aa("git push --no-verify origin develop")], [false, false, false, false, false, false, false, false]);
eq("branch-guard/AC-14 push 以外を含むコマンドは省かない", [aa("git push origin develop && rm -rf x"), aa("git push origin develop; echo x"), aa("git push origin develop || true"), aa("git push origin develop | sh"), aa("git push origin develop > out.txt"), aa("git push origin $(echo develop)"), aa("git push origin develop | tail -3 | sh"), aa("GIT_SSH_COMMAND=x git push origin develop"), aa("git -c core.sshCommand=x push origin develop"), aa("git push origin develop &")], [false, false, false, false, false, false, false, false, false, false]);
eq("branch-guard/AC-14 宣言で有効にしていなければ省かない", aa("git push origin develop", mkRepo("develop", { ...autoCfg, autoApprove: { push: false, pullRequest: true } })), false);
const autoDirty = mkRepo("develop", { ...autoCfg, autoApprove: { push: false, pullRequest: true } });
writeFileSync(join(autoDirty, ".claude/branch-release-workflow.json"), JSON.stringify(autoCfg));
eq("branch-guard/AC-14 作業ツリーで書き換えた宣言では省かない", aa("git push origin develop", autoDirty), false);
const autoMap = mkRepo("develop", autoCfg);
g(autoMap, "config", "remote.origin.push", "refs/heads/develop:refs/heads/main");
eq("branch-guard/AC-14 remote.<名前>.push で送り先を変えていれば省かない", aa("git push origin develop", autoMap), false);
const autoUp = mkRepo("develop", autoCfg);
g(autoUp, "config", "branch.develop.merge", "refs/heads/main");
g(autoUp, "config", "push.default", "upstream");
eq("branch-guard/AC-14 送り先を省き、追跡先が別名なら省かない", [aa("git push", autoUp), aa("git push origin develop", autoUp)], [false, true]);
eq("branch-guard/AC-14 autoApprove の値が真偽値でない・未知のキーなら不正", [validateConfig({ ...autoCfg, autoApprove: { push: "yes" } }).length, validateConfig({ ...autoCfg, autoApprove: { merge: true } }).length, validateConfig({ ...autoCfg, autoApprove: true }).length], [1, 1, 1]);
const onDevAuto = mkRepo("dev/feat", autoCfg);
const ap = (cmd, repo = onDevAuto) => autoApprovable(cmd, repo);
eq("branch-guard/AC-15 作業ブランチから切り出し元への PR の作成は確認を省く", [
  ap('gh pr create --base develop --title "t" --body "a; b | c && d"'),
  ap("gh pr create -B develop -H dev/feat -t 'x' -b 'y' --draft"),
  ap("gh pr create --base=develop --fill"),
  ap('git push -u origin dev/feat && gh pr create --base develop --title "t" --body "b"'),
], [true, true, true, true]);
eq("branch-guard/AC-15 切り出し元以外・取り込み先の省略・保護ブランチからの PR は省かない", [
  ap('gh pr create --base main --title "t" --body "b"'),
  ap('gh pr create --title "t" --body "b"'),
  ap('gh pr create --base develop --title "t" --body "b"', mkRepo("main", autoCfg)),
  ap('gh pr create --base develop --head other:dev/feat --title "t"'),
], [false, false, false, false]);
eq("branch-guard/AC-15 他のリポジトリ・ブラウザ・展開・別のコマンドを伴う PR は省かない", [
  ap('gh pr create -R x/y --base develop --title "t"'),
  ap("gh pr create --base develop --web"),
  ap('gh pr create --base develop --title "t" --body "$(cat f)"'),
  ap('gh pr create --base develop --title "t"; rm -rf x'),
  ap("gh pr merge 1"),
], [false, false, false, false, false]);
eq("branch-guard/AC-15 pullRequest を有効にしていなければ省かない", ap('gh pr create --base develop --title "t"', mkRepo("dev/feat", { ...autoCfg, autoApprove: { push: true } })), false);
const hookOut = (cmd, repo) => spawnSync("node", [brw, "hook"], { cwd: repo, input: JSON.stringify({ tool_name: "Bash", tool_input: { command: cmd }, cwd: repo }), encoding: "utf8" }).stdout;
eq("branch-guard/AC-14 フックは省けるとき allow を返し、それ以外の許可では何も返さない", [JSON.parse(hookOut("git push origin develop", auto)).hookSpecificOutput.permissionDecision, hookOut("git commit -m x", auto), hookOut("git push origin develop && ls", auto)], ["allow", "", ""]);

const t0 = Date.now();
for (let i = 0; i < 16; i++) judgeCommand("git commit -m x", onDev);
eq("branch-guard/AC-6 判定 16 件が 10 秒以内", Date.now() - t0 <= 10_000, true);

const imports = [];
for (const dir of ["scripts", "scripts/providers"])
  for (const f of readdirSync(join(root, dir)).filter((f) => f.endsWith(".mjs")))
    for (const m of readFileSync(join(root, dir, f), "utf8").matchAll(/from "([^"]+)"/g)) imports.push(m[1]);
eq("branch-guard/AC-7 import は標準モジュールと相対パスのみ", imports.filter((m) => !m.startsWith("node:") && !m.startsWith(".")), []);

// ---- preview ----
eq("preview/AC-1 斜線をハイフンにした alias のURLを算出", previewUrl({ preview: cfg.preview }, "dev/foo-bar"), "https://dev-foo-bar.example.com");
eq("preview/AC-2 provider none ではURLが無い", previewUrl({ preview: { provider: "none" } }, "dev/foo"), null);
eq("preview/AC-2 provider none では後始末が無い", getProvider({ preview: { provider: "none" } }).cleanup({}, "dev/foo"), null);

const wf = [{ file: "w", push: [{ glob: "release/**" }, { glob: "dev/**" }, { glob: "main" }] }];
eq("preview/AC-3 宣言外の push 対象を警告", undeclaredCiBranches(cfg, wf), [{ file: "w", glob: "release/**" }]);
eq("workflow: flow 形式", parsePushBranches('on:\n  push:\n    branches: ["dev/**", main]\n'), [{ glob: "dev/**" }, { glob: "main" }]);
eq("workflow: block 形式", parsePushBranches("on:\n  push:\n    branches:\n      - 'dev/**'\n      - develop # コメント\n  pull_request:\n"), [{ glob: "dev/**" }, { glob: "develop" }]);
eq("workflow: 全 push", parsePushBranches("on: [push, pull_request]\n"), [{ any: true }]);
eq("workflow: tags のみはブランチ対象外", parsePushBranches("on:\n  push:\n    tags: ['v*']\n"), []);
eq("workflow: push 空指定は全ブランチ", parsePushBranches("on:\n  push:\n  pull_request:\n"), [{ any: true }]);
eq("glob: dev/* は dev/a/b に合わない", globToRegExp("dev/*").test("dev/a/b"), false);
eq("glob: dev/** は dev/a/b に合う", globToRegExp("dev/**").test("dev/a/b"), true);

const cf = mkdtempSync(join(tmpdir(), "brw-cf-"));
writeFileSync(join(cf, "wrangler.jsonc"), '{ "name": "x" }');
eq("preview/AC-4 有効化設定が無ければ誤りを報告", cloudflare.check(cf, { preview: {} }).some((f) => f.level === "error" && f.message.includes("previews_enabled")), true);

const withWf = mkRepo("dev/foo", { ...cfg, preview: { provider: "cloudflare-previews", urlTemplate: "https://{alias}.example.com" } });
mkdirSync(join(withWf, ".github/workflows"), { recursive: true });
writeFileSync(join(withWf, ".github/workflows/preview.yaml"), "name: keep\n");
eq("preview/AC-5 既存の workflow は上書きせず終了コード 1", run(withWf, "gen-workflow", "--write").status, 1);
eq("preview/AC-5 既存の workflow の内容は変わらない", readFileSync(join(withWf, ".github/workflows/preview.yaml"), "utf8"), "name: keep\n");
eq("preview/AC-3 ブランチのみの整合検査は生成前の provider 設定を検査しない", run(withWf, "check", "--branches-only").status, 0);
eq("preview/AC-3 全体の整合検査は provider の誤りを検出する", run(withWf, "check").status, 1);
const stripCfg = { ...cfg, preview: { ...cfg.preview, provider: "cloudflare-previews", aliasStripPrefix: "dev/" } };
eq("preview/AC-9 接頭辞を除いた alias のURLを算出", previewUrl(stripCfg, "dev/foo-bar"), "https://foo-bar.example.com");
eq("preview/AC-9 後始末の名前も接頭辞を除く", getProvider(stripCfg).cleanup(stripCfg, "dev/foo-bar").args.at(-1), "foo-bar");
eq("preview/AC-9 接頭辞が文字列でなければ不正", validateConfig({ ...cfg, preview: { ...cfg.preview, aliasStripPrefix: 1 } }).length, 1);
const cl = run(withWf, "cleanup", "dev/foo");
eq("preview/AC-6 実行指定なしはコマンドを表示するだけ", cl.status === 0 && cl.stdout.includes("wrangler preview delete -y --name dev-foo") && cl.stdout.includes("表示のみ"), true);

// ---- preview: workers.dev 関連キー ----
const withDomain = `{
  // 名前
  "name": "x",
  "routes": [{ "pattern": "a.example.com", "custom_domain": true, "enabled": true, }],
  "workers_dev": true, // 旧設定
  "preview_urls": true,
  "previews": { "workers_dev": true },
}
`;
const noDomain = '{\n  "name": "x",\n  "routes": [{ "pattern": "a", "custom_domain": true, "enabled": false }],\n  "workers_dev": false\n}\n';
const wcDir = mkdtempSync(join(tmpdir(), "brw-wc-"));
const wcFile = join(wcDir, "wrangler.jsonc");
writeFileSync(wcFile, withDomain);
const wcShow = run(wcDir, "wrangler-config");
eq("preview/AC-7 書き込み指定なしはファイルを変えない", readFileSync(wcFile, "utf8"), withDomain);
eq("preview/AC-7 書き込み指定なしは変更後を標準出力へ出す", wcShow.stdout.includes('"preview_urls": false'), true);
run(wcDir, "wrangler-config", "--write");
eq("preview/AC-7 有効な独自ドメインがあれば両キーを false にし他は変えない", readFileSync(wcFile, "utf8"), withDomain.replace('"workers_dev": true,', '"workers_dev": false,').replace('"preview_urls": true,', '"preview_urls": false,'));
eq("preview/AC-7 入れ子の previews 内のキーは変えない", readFileSync(wcFile, "utf8").includes('"previews": { "workers_dev": true }'), true);
writeFileSync(wcFile, noDomain);
run(wcDir, "wrangler-config", "--write");
const wcOut = cloudflare.parseJsonc(readFileSync(wcFile, "utf8"));
eq("preview/AC-7 有効な独自ドメインがなければ両方 true", [wcOut.workers_dev, wcOut.preview_urls], [true, true]);
writeFileSync(wcFile, '{ "name": "x" }');
run(wcDir, "wrangler-config", "--write");
const wcAdded = cloudflare.parseJsonc(readFileSync(wcFile, "utf8"));
eq("preview/AC-7 キーがなければ追加される", [wcAdded.name, wcAdded.workers_dev, wcAdded.preview_urls], ["x", true, true]);
const wcDirty = (text) => { const w = mkdtempSync(join(tmpdir(), "brw-wc-")); writeFileSync(join(w, "wrangler.jsonc"), text); return cloudflare.check(w, { preview: {} }).filter((f) => f.level === "warn" && /workers_dev|preview_urls/.test(f.message)).length; };
eq("preview/AC-8 有効な独自ドメインがあり workers_dev: true は警告", wcDirty(withDomain) >= 2, true);
eq("preview/AC-8 無効な独自ドメインのみで workers_dev: false は警告", wcDirty(noDomain), 1);
writeFileSync(wcFile, '{ "routes": [{ "pattern": "a", "custom_domain": true }] }');
run(wcDir, "wrangler-config", "--write");
const wcFalse = cloudflare.parseJsonc(readFileSync(wcFile, "utf8"));
eq("preview/AC-7 有効な独自ドメインでキーがなければ false で追加される", [wcFalse.workers_dev, wcFalse.preview_urls], [false, false]);
eq("preview/AC-8 有効な独自ドメインがありキーなしは警告しない", wcDirty('{ "routes": [{ "pattern": "a", "custom_domain": true }] }'), 0);


// ---- preview: 配信方式とプレビュー先 ----
eq("preview/AC-10 workers.dev のホスト名は workers.dev 配信", deliveryOf("https://{alias}-app.acct.workers.dev"), "workers-dev");
eq("preview/AC-10 独自ドメインは独自ドメイン配信", deliveryOf("https://{alias}.example.com"), "custom-domain");
eq("preview/AC-10 変数だけのホスト名は独自ドメイン配信", deliveryOf("https://{alias}.${SITE_HOST}"), "custom-domain");
process.env.SITE_HOST = "example.com";
eq("preview/AC-13 URL 雛形の変数を環境変数で解決", previewUrl({ preview: { provider: "url-template", urlTemplate: "https://{alias}.${SITE_HOST}" } }, "dev/foo"), "https://dev-foo.example.com");
delete process.env.SITE_HOST;

const tpl = `{
  // テンプレート
  "name": "app",
  "main": "index.js",
  "routes": [
    { "pattern": "PLACEHOLDER", "custom_domain": true },
    { "pattern": "ogp.example.com/*", "zone_name": "example.com" },
  ],
  "vars": { "A": "1" },
}
`;
const dcfg = (over = {}, prevOver = {}) => ({
  ...cfg,
  protectedBranches: ["main", "develop", "release/**"],
  aliasStripPrefix: undefined,
  deploy: {
    provider: "cloudflare-workers",
    template: "config/wrangler.template.jsonc",
    targets: {
      production: { branches: ["release/**"], worker: "app", customDomain: "${SITE_HOST}" },
      develop: { branches: ["develop"], worker: "app-develop", customDomain: "develop.${SITE_HOST}" },
    },
    ...over,
  },
  preview: { provider: "cloudflare-previews", target: "develop", urlTemplate: "https://{alias}.develop.${SITE_HOST}", aliasStripPrefix: "dev/", ...prevOver },
});
const mkDeployRepo = (config, files = {}) => {
  const r = mkRepo("dev/foo", config);
  mkdirSync(join(r, "config"), { recursive: true });
  writeFileSync(join(r, "config/wrangler.template.jsonc"), tpl);
  for (const [f, t] of Object.entries(files)) {
    mkdirSync(dirname(join(r, f)), { recursive: true });
    writeFileSync(join(r, f), t);
  }
  return r;
};
const errsOf = (c) => validateConfig(c).join("\n");
const noTarget = dcfg(); delete noTarget.preview.target;
eq("preview/AC-11 配備先があるのにプレビュー先が無いと誤り", /preview\.target/.test(errsOf(noTarget)), true);
eq("preview/AC-11 宣言に無い配備先を指すと誤り", /preview\.target/.test(errsOf(dcfg({}, { target: "nope" }))), true);
eq("preview/AC-11 正しい宣言は誤りなし", validateConfig(dcfg()), []);
const clRepo = mkDeployRepo(dcfg());
const clOut = run(clRepo, "cleanup", "dev/foo-bar");
eq("preview/AC-11 後始末にプレビュー先の Worker 名が含まれる", clOut.stdout.includes("wrangler preview delete -y --worker-name app-develop --name foo-bar"), true);
const clVar = mkDeployRepo(dcfg({ targets: { develop: { branches: ["develop"], worker: "${WORKER_X}" } } }));
eq("preview/AC-11 Worker 名の変数が未解決なら後始末は終了コード 1", run(clVar, "cleanup", "dev/foo").status, 1);

const chk = (config) => cloudflare.check(mkDeployRepo(config), normalizeConfig(config));
const wdCfg = dcfg({ targets: { develop: { branches: ["develop"], worker: "app-develop" } } }, { urlTemplate: "https://{alias}-other.acct.workers.dev" });
eq("preview/AC-12 workers.dev 配信で Worker 名が食い違うと警告", chk(wdCfg).some((f) => f.level === "warn" && f.message.includes("{alias}-app-develop.")), true);
const cdNoDomain = dcfg({ targets: { develop: { branches: ["develop"], worker: "app-develop" } } });
eq("preview/AC-12 独自ドメイン配信でプレビュー先に独自ドメインが無いと誤り", chk(cdNoDomain).some((f) => f.level === "error" && f.message.includes("customDomain")), true);
const longCfg = { ...dcfg({ targets: { develop: { branches: ["develop"], worker: "a-very-long-worker-name-for-testing" } } }, { urlTemplate: "https://{alias}-a-very-long-worker-name-for-testing.acct.workers.dev" }), maxNameLength: 54 };
eq("preview/AC-12 alias と Worker 名で 63 文字を超えうると警告", chk(longCfg).some((f) => f.level === "warn" && f.message.includes("63")), true);
eq("preview/AC-12 整合する宣言では URL の警告が出ない", chk(dcfg()).filter((f) => /urlTemplate|63|customDomain/.test(f.message)), []);

const wdRoot = mkdtempSync(join(tmpdir(), "brw-wd-"));
writeFileSync(join(wdRoot, "wrangler.jsonc"), '{ "name": "x", "workers_dev": true, "preview_urls": false }');
eq("preview/AC-4 workers.dev 配信で preview_urls が true でなければ誤り", cloudflare.check(wdRoot, { preview: { urlTemplate: "https://{alias}-x.a.workers.dev" } }).some((f) => f.level === "error" && f.message.includes("preview_urls")), true);
const wdApplied = cloudflare.parseJsonc(cloudflare.applyWorkersDev('{ "routes": [{ "pattern": "a", "custom_domain": true }] }', "workers-dev").text);
eq("preview/AC-7 workers.dev 配信では独自ドメインがあっても preview_urls は true", [wdApplied.workers_dev, wdApplied.preview_urls], [false, true]);

// ---- deploy ----
eq("deploy/AC-1 配備先が無いと誤り", /targets/.test(errsOf(dcfg({ targets: {} }))), true);
eq("deploy/AC-1 ブランチが無い配備先は誤り", /branches/.test(errsOf(dcfg({ targets: { develop: { worker: "x" } } }))), true);
eq("deploy/AC-1 不明な provider は誤り", /deploy\.provider/.test(errsOf(dcfg({ provider: "x" }))), true);
eq("deploy/AC-1 不正な取得元は誤り", /brwSource/.test(errsOf(dcfg({ brwSource: { repository: "git@github.com:a/b.git" } }))), true);
process.env.BRW_T_HOST = "h.example";
eq("deploy/AC-2 環境変数があれば置き換わる", resolveVars("x.${BRW_T_HOST}", root), { value: "x.h.example", missing: [] });
delete process.env.BRW_T_HOST;
eq("deploy/AC-2 環境変数も GitHub Variables も無ければ未解決", resolveVars("x.${BRW_T_HOST}", root), { value: "x.${BRW_T_HOST}", missing: ["BRW_T_HOST"] });

const rRepo = mkDeployRepo(dcfg());
const renderOf = (repo, target, env = { SITE_HOST: "example.com" }) => {
  const r = spawnSync("node", [brw, "render-wrangler", "--target", target], { cwd: repo, encoding: "utf8", env: { ...process.env, ...env } });
  return r.status === 0 ? cloudflare.parseJsonc(r.stdout) : r;
};
const prod = renderOf(rRepo, "production");
eq("deploy/AC-3 Worker 名が宣言の値になる", prod.name, "app");
eq("deploy/AC-3 独自ドメインの route がある", prod.routes.find((x) => x.custom_domain), { pattern: "example.com", custom_domain: true });
eq("deploy/AC-3 独自ドメインのある配備先は workers_dev / preview_urls が false", [prod.workers_dev, prod.preview_urls], [false, false]);
const dev = renderOf(rRepo, "develop");
eq("deploy/AC-4 独自ドメイン配信のプレビュー先は previews_enabled が付く", dev.routes.find((x) => x.custom_domain), { pattern: "develop.example.com", custom_domain: true, previews_enabled: true });
eq("deploy/AC-4 プレビュー先には previews が置かれる", typeof dev.previews, "object");
eq("deploy/AC-5 独自ドメインでない route は残る", dev.routes.some((x) => x.pattern === "ogp.example.com/*"), true);
eq("deploy/AC-5 テンプレートの独自ドメインの route は置き換わる", dev.routes.some((x) => x.pattern === "PLACEHOLDER"), false);
const wdRepo = mkDeployRepo(dcfg({ targets: { production: { branches: ["main"], worker: "app", customDomain: "example.com" }, develop: { branches: ["develop"], worker: "app-develop" } } }, { urlTemplate: "https://{alias}-app-develop.acct.workers.dev" }));
const wdDev = renderOf(wdRepo, "develop");
eq("deploy/AC-4 workers.dev 配信のプレビュー先は preview_urls が true、previews が置かれる", [wdDev.workers_dev, wdDev.preview_urls, typeof wdDev.previews, wdDev.routes?.some((x) => x.custom_domain) ?? false], [true, true, "object", false]);
const missRun = spawnSync("node", [brw, "render-wrangler", "--target", "production", "--write"], { cwd: rRepo, encoding: "utf8", env: { ...process.env, SITE_HOST: "" } });
eq("deploy/AC-6 未解決の変数があると終了コード 1 で生成先を書かない", [missRun.status, existsSync(join(rRepo, "wrangler.jsonc"))], [1, false]);
const hookRepo = mkDeployRepo(dcfg({ renderHook: 'printf "%s %s" "$BRW_TARGET" "$BRW_OUTPUT" > hook.out; exit 3' }));
const hookRun = spawnSync("node", [brw, "render-wrangler", "--target", "develop", "--write"], { cwd: hookRepo, encoding: "utf8", env: { ...process.env, SITE_HOST: "example.com" } });
eq("deploy/AC-7 renderHook が失敗すると非ゼロで終わる", hookRun.status, 3);
eq("deploy/AC-7 renderHook に配備先名と生成先が渡る", readFileSync(join(hookRepo, "hook.out"), "utf8"), `develop ${join(hookRepo, "wrangler.jsonc")}`);

const wfText = run(rRepo, "gen-workflow", "deploy").stdout;
eq("deploy/AC-8 全配備先のブランチが push の対象", wfText.includes("branches: ['release/**', 'develop']"), true);
eq("deploy/AC-9 取得元の clone が含まれる", wfText.includes("fetch -q --depth 1 'https://github.com/nekono-dev/branch-release-workflow.git' 'main'"), true);
eq("deploy/AC-9 宣言で参照する変数を渡す", wfText.includes("SITE_HOST: ${{ vars.SITE_HOST }}"), true);
const pwText = run(rRepo, "gen-workflow", "preview").stdout;
eq("preview/AC-11 プレビュー雛形にプレビュー先の生成手順が含まれる", pwText.includes('BRW_TARGET_NAME: develop') && pwText.includes("SITE_HOST: ${{ vars.SITE_HOST }}"), true);
mkdirSync(join(rRepo, ".github/workflows"), { recursive: true });
writeFileSync(join(rRepo, ".github/workflows/deploy.yaml"), "name: keep\n");
eq("deploy/AC-8 既存の deploy.yaml は上書きしない", [run(rRepo, "gen-workflow", "deploy", "--write").status, readFileSync(join(rRepo, ".github/workflows/deploy.yaml"), "utf8")], [1, "name: keep\n"]);

const ckCfg = dcfg({ targets: { develop: { branches: ["staging"], worker: "app-develop", customDomain: "develop.${SITE_HOST}" } } });
const ckRepo = mkDeployRepo(ckCfg, { "wrangler.jsonc": "{}" });
g(ckRepo, "add", "-f", "wrangler.jsonc");
g(ckRepo, "commit", "-q", "-m", "生成物");
const ck = deployCf.check(ckRepo, normalizeConfig(ckCfg));
eq("deploy/AC-10 保護ブランチに無い配備先のブランチを警告", ck.some((f) => f.level === "warn" && f.message.includes("'staging'")), true);
eq("deploy/AC-10 git に登録された生成先を警告", ck.some((f) => f.level === "warn" && f.message.includes("登録")), true);

// ---- 宣言の互換読み込みとブランチ分類（brw-enforcement 1.1） ----
import * as lib from "../scripts/lib.mjs";
{
  const base = { workBranches: ["dev/*", "release/*"], protectedBranches: ["main"], baseBranch: "develop" };
  const cls = (c, b) => (lib.classifyBranch ? lib.classifyBranch(lib.normalizeConfig(c), b) : "未実装");
  // 要件 1.1, 1.3: ルート宣言を優先し、旧パスだけでも既存の書式で読む
  const both = mkRepo("dev/foo", base);
  writeFileSync(join(both, ".branch-release-workflow.json"), JSON.stringify({ ...base, baseBranch: "root-base" }));
  eq("enforcement/6.3 ルート宣言と旧宣言が両方あればルートを優先する", [lib.loadConfig(both).config.baseBranch, lib.loadConfig(both).legacy], ["root-base", false]);
  const legacyOnly = mkRepo("dev/foo", base);
  eq("enforcement/6.3 旧パスだけの宣言も既存の書式で読み込む", [lib.loadConfig(legacyOnly).config.baseBranch, lib.loadConfig(legacyOnly).legacy], ["develop", true]);
  // 要件 2.1, 6.3: 恒常的な分岐元は baseBranch と固定名の baseBranches から解決する
  eq("enforcement/1.3 恒常的な分岐元は baseBranch と baseBranches の重複なしの和", lib.normalizeConfig({ ...base, baseBranches: ["staging", "develop"] }).permanentBases, ["develop", "staging"]);
  eq("enforcement/1.3 baseBranches にパターンや空文字は書けない", [validateConfig({ ...base, baseBranches: ["rel/*"] }).length, validateConfig({ ...base, baseBranches: [""] }).length, validateConfig({ ...base, baseBranches: "x" }).length, validateConfig({ ...base, baseBranches: ["staging"] }).length], [1, 1, 1, 0]);
  // 要件 1.3, 2.1: 保護対象を開発指定より優先し、分岐元は開発から除く
  const dup = { ...base, workBranches: ["dev/*", "main", "develop", "staging", "feature/x"], baseBranches: ["staging"] };
  eq("enforcement/1.3 保護指定は開発指定より優先する", cls(dup, "main"), "protected");
  eq("enforcement/1.3 恒常的な分岐元は開発指定と重複しても開発ではない", [cls(dup, "develop"), cls(dup, "staging")], ["base", "base"]);
  eq("enforcement/1.3 開発ブランチ・宣言外の分類", [cls(dup, "feature/x"), cls(dup, "dev/a"), cls(dup, "other/z"), cls(dup, null)], ["development", "development", "undeclared", "undeclared"]);
  eq("enforcement/1.3 命名規則に合わない開発指定は宣言外扱い", cls({ ...base, namePattern: "^dev/[a-z]+$" }, "dev/A1"), "undeclared");
  eq("enforcement/1.3 一時的な brwBase は分岐元の集合に入らない", lib.normalizeConfig(base).permanentBases, ["develop"]);
  // 要件 4.1, 6.4: 個別の分岐元は公開と片付けで共用する
  const br = mkRepo("dev/foo", base);
  eq("enforcement/6.4 個別の分岐元が無ければ宣言の baseBranch", lib.branchBase ? lib.branchBase(br, lib.normalizeConfig(base), "dev/foo") : "未実装", "develop");
  g(br, "config", "branch.dev/foo.brwBase", "dev/parent");
  eq("enforcement/6.4 記録済みの brwBase を優先する", lib.branchBase ? lib.branchBase(br, lib.normalizeConfig(base), "dev/foo") : "未実装", "dev/parent");
  // 要件 2.1, 2.6: 登録済み宣言で項目ごとの既定値、明示 false は維持
  const aa = (a, reg) => (lib.autoApproveOf ? lib.autoApproveOf(lib.normalizeConfig(a === undefined ? base : { ...base, autoApprove: a }), reg) : "未実装");
  eq("enforcement/2.1 登録済み宣言で未指定の項目は既定で有効", [aa(undefined, true), aa({}, true), aa({ push: true }, true)], [{ push: true, pullRequest: true }, { push: true, pullRequest: true }, { push: true, pullRequest: true }]);
  eq("enforcement/2.6 明示的な false は維持し、他の項目だけ既定を適用", [aa({ push: false }, true), aa({ pullRequest: false }, true)], [{ push: false, pullRequest: true }, { push: true, pullRequest: false }]);
  eq("enforcement/2.1 未登録・編集中の宣言は既定を適用しない", aa({ push: true }, false), { push: false, pullRequest: false });
}

// ---- テスト補助の動作確認（brw-enforcement 1.2） ----
await runSupportChecks(eq);

// ---- 操作の分類と対象の確定（brw-enforcement 2.1） ----
await runEnforcementChecks(eq);
await runGithubWriteChecks(eq);

// ---- 操作可否の共通判定（brw-enforcement 2.3） ----
await runDecisionChecks(eq);

// ---- GitHub クライアントの土台（brw-enforcement 3.1） ----
await runGithubClientChecks(eq);
await runGithubRulesetChecks(eq);

// ---- 作業 ID と中断・再開の記録（brw-enforcement 4.1） ----
await runWorkStateChecks(eq);

// ---- 完了申告と公開準備の確定（brw-enforcement 4.2） ----
await runReadyChecks(eq);

// ---- 公開計画の発行と検証（brw-enforcement 4.3） ----
await runPublishPlanChecks(eq);

// ---- 公開の push 実行と照合（brw-enforcement 4.4） ----
await runPublishPushChecks(eq);

// ---- 完了公開の PR 再利用・作成（brw-enforcement 4.5） ----
await runPublishPrChecks(eq);

// ---- Ruleset の対象範囲と導入の選択の再利用（brw-enforcement 5.1） ----
await runRulesetChoiceChecks(eq);

// ---- Ruleset 導入の事前検査（brw-enforcement 5.2） ----
await runRulesetPreflightChecks(eq);

// ---- Ruleset の再利用と追加（brw-enforcement 5.3） ----
await runRulesetApplyChecks(eq);

// ---- 実効ルールと通常作業の権限の検査（brw-enforcement 5.4） ----
await runRulesetInspectChecks(eq);

// ---- フックの応答と公開計画の照合（brw-enforcement 6.1） ----
await runAgentHookChecks(eq);

// ---- 作業 ID の関連付けと終了時の案内（brw-enforcement 6.2） ----
await runAgentHookSessionChecks(eq);

// ---- フックの登録と導入状態（brw-enforcement 6.3） ----
await runHookInstallChecks(eq);

// ---- フックの稼働と対応経路の診断（brw-enforcement 6.4） ----
await runHookDiagnoseChecks(eq);

// ---- CLI のブランチ操作と共通判定、開発間のローカル取り込み、片付け条件（brw-enforcement 7.1） ----
await runBranchOpsChecks(eq);

// ---- 完了公開の CLI（brw-enforcement 7.2） ----
await runPublishCliChecks(eq);

// ---- 導入・移行と状態検査の CLI（brw-enforcement 7.3） ----
await runSetupCliChecks(eq);

// ---- Git 操作と完了公開の統合・回帰（brw-enforcement 8.1） ----
await runIntegrationPublishChecks(eq);

console.log(failed ? `\n${failed} 件失敗` : "\nすべて成功");
process.exit(failed ? 1 : 0);
