#!/usr/bin/env node
// 判定ロジックと各サブコマンドの自己テスト。一時 git リポジトリで実行する。 使い方: node tests/selftest.mjs
// テスト名の「<spec名>/AC-n」は、仕様書の受け入れ条件との対応を表す。
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { judgeCommand } from "../scripts/brw.mjs";
import { globToRegExp, loadConfig, parsePushBranches, undeclaredCiBranches, validateConfig } from "../scripts/lib.mjs";
import { getProvider, previewUrl } from "../scripts/providers/index.mjs";
import * as cloudflare from "../scripts/providers/cloudflare-previews.mjs";

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
eq("preview/AC-6 実行指定なしはコマンドを表示するだけ", cl.status === 0 && cl.stdout.includes("wrangler preview delete --name dev-foo") && cl.stdout.includes("表示のみ"), true);

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

console.log(failed ? `\n${failed} 件失敗` : "\nすべて成功");
process.exit(failed ? 1 : 0);
