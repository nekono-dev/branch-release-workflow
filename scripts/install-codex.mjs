#!/usr/bin/env node
// Git clone を Codex の skill 探索先へリンクする。既存の別の導入先は上書きしない。
// --repo <導入先リポジトリ> を付けると、そのリポジトリの .codex/hooks.json へ BRW のフックを登録する（既存の定義は保持）。
import { lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installCodexHooks } from "./hook-install.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "使い方: node scripts/install-codex.mjs [--skills-dir <探索先>] [--repo <導入先リポジトリ>]";
const args = process.argv.slice(2);
const opts = {};
for (let i = 0; i < args.length; i += 2) {
  if (!["--skills-dir", "--repo"].includes(args[i]) || args[i + 1] === undefined || opts[args[i]] !== undefined) {
    console.error(USAGE);
    process.exit(2);
  }
  opts[args[i]] = args[i + 1];
}

const skills = resolve(opts["--skills-dir"] ?? join(homedir(), ".agents/skills"));
mkdirSync(skills, { recursive: true });
const target = join(skills, "branch-release-workflow");
let existing;
try { existing = lstatSync(target); } catch (error) { if (error.code !== "ENOENT") throw error; }
if (existing) {
  if (!existing.isSymbolicLink() || resolve(skills, readlinkSync(target)) !== root) {
    console.error(`既存の導入先を保持しました: ${target}。削除または移行してから再実行してください。`);
    process.exit(1);
  }
} else symlinkSync(root, target, "dir");
console.log(`Codex skill: ${target} -> ${root}`);

if (opts["--repo"] !== undefined) {
  try {
    // 利用者の Codex 設定は読み取りだけ行い（[features] の hooks 判定）、書き換えない
    const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
    let featuresText = "";
    try { featuresText = readFileSync(join(codexHome, "config.toml"), "utf8"); } catch { /* 設定が無ければ無効化はされていない */ }
    const launcherPath = realpathSync(join(root, "scripts/agent-hooks.mjs"));
    const r = installCodexHooks({ repoDir: resolve(opts["--repo"]), launcherPath, featuresText });
    if (r.status === "conflict") {
      console.error(`フックを登録しませんでした [${r.reasonCode}]: ${r.reason}${r.file ? `（${r.file}）` : ""}`);
      for (const c of r.conflicts) console.error(`  衝突: ${JSON.stringify(c)}`);
      process.exit(1);
    }
    if (r.status === "unsupported") {
      console.log(`Codex hooks: unsupported [${r.reasonCode}]: ${r.reason}${r.managedHooksRequired ? "（管理対象フックが前提の実行環境です）" : ""}`);
      process.exit(0);
    }
    console.log(`Codex hooks: ${r.status}（信頼: ${r.trust ?? "-"}）${r.file}`);
    for (const c of r.conflicts) console.log(`  同じ matcher の既存定義（残しています）: ${JSON.stringify(c)}`);
    if (r.status === "untrusted") console.log("Codex で /hooks を開き、BRW のフックを確認して信頼してください。信頼するまで読み込まれません。");
  } catch (error) {
    console.error(`フックを登録できませんでした: ${error.message}`);
    process.exit(1);
  }
}
