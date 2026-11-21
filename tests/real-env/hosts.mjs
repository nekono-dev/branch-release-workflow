// 8.3: 一時クローンへ両ホストのフックを導入し、信頼済み・未信頼を切り替えて検査する。
// 使い方: BRW_REAL_ENV=1 node tests/real-env/hosts.mjs
// 実際の ~/.codex・~/.claude は読み書きしない（HOME・CODEX_HOME は一時の場所）。
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BRW_ROOT, WORK_DIR, readState, requireRealEnv, run } from "./common.mjs";
import { checkClaudeHooks } from "../../scripts/hook-install.mjs";
import { diagnoseHooks } from "../../scripts/hook-diagnose.mjs";

requireRealEnv("hosts.mjs");
const state = readState();
if (!state) { console.error("先に prepare.mjs を実行してください（状態ファイルがありません）"); process.exit(1); }
const clone = state.cloneDir;

// 一時の HOME・CODEX_HOME（利用者の実際の設定を汚さない）
const home = join(WORK_DIR, "home");
const codexHome = join(WORK_DIR, "codex-home");
mkdirSync(home, { recursive: true });
mkdirSync(codexHome, { recursive: true });
const childEnv = { PATH: process.env.PATH, LANG: process.env.LANG ?? "C.UTF-8", HOME: home, CODEX_HOME: codexHome };

console.log("== ローカルのホストコマンド ==");
for (const [name, cmd] of [["claude", "claude"], ["codex", "codex"]]) {
  const v = run(cmd, ["--version"], { env: { ...childEnv, HOME: process.env.HOME } });
  console.log(`  ${name}: ${v.code === 0 ? v.out.trim() : `見つかりません（${v.error?.code ?? `exit ${v.code}`}）`}`);
}

console.log("\n== (a) Codex のプロジェクトフック導入（一時 HOME・CODEX_HOME）==");
const inst = run("node", [join(BRW_ROOT, "scripts/install-codex.mjs"), "--skills-dir", join(home, ".agents/skills"), "--repo", clone], { env: childEnv });
console.log(inst.out.trim().split("\n").map((l) => `  ${l}`).join("\n"));
if (inst.code !== 0) { console.error(inst.err); process.exit(1); }
// 再実行しても変更なし（冪等）で、未信頼のまま残ることを確認する
const again = run("node", [join(BRW_ROOT, "scripts/install-codex.mjs"), "--skills-dir", join(home, ".agents/skills"), "--repo", clone], { env: childEnv });
console.log(`  再実行: ${again.out.split("\n").find((l) => l.startsWith("Codex hooks")) ?? again.err.trim()}`);
const installed = /Codex hooks: (\w+)/.exec(inst.out)?.[1];
if (!["untrusted", "registered"].includes(installed ?? "")) { console.error("導入の結果が想定と違います"); process.exit(1); }

const summary = (routes, host) => {
  const rows = routes.filter((r) => r.host === host && r.environment === "local");
  const by = {};
  for (const r of rows) (by[r.status] ??= []).push(r.event);
  return Object.entries(by).map(([s, ev]) => `${s}: ${ev.join(", ")}`).join(" / ");
};

console.log("\n== (b) Codex の信頼状態の切り替え（診断に codexTrust を渡す）==");
console.log("  注: 実際の信頼承認は Codex の /hooks で利用者が行う操作で自動化できません。ここでは診断への入力値で状態を切り替えます。");
const results = {};
for (const trust of ["untrusted", "trusted", "unknown"]) {
  const d = diagnoseHooks({ pluginRoot: BRW_ROOT, codexRepoDir: clone, host: "codex", codexTrust: trust });
  results[trust] = d.routes.filter((r) => r.environment === "local");
  console.log(`  codexTrust=${trust}: ${summary(d.routes, "codex")}`);
}
const ok = results.untrusted.every((r) => r.status === "untrusted") && results.trusted.every((r) => r.status === "active");
console.log(`  判定: untrusted → 全イベント untrusted、trusted → 全イベント active（実ランチャーの応答を確認）: ${ok ? "一致" : "不一致"}`);
const sample = results.unknown[0];
console.log(`  unknown の例: ${sample.event} = ${sample.status}${sample.reasonCode ? ` [${sample.reasonCode}]` : ""}`);

console.log("\n== (c) Claude のフック登録と稼働診断 ==");
const reg = checkClaudeHooks(BRW_ROOT);
console.log(`  checkClaudeHooks: ${reg.status}（不足: ${reg.missing.length ? reg.missing.join(", ") : "なし"}）`);
const dc = diagnoseHooks({ pluginRoot: BRW_ROOT, codexRepoDir: clone, host: "claude" });
console.log(`  diagnoseHooks(claude, local): ${summary(dc.routes, "claude")}`);
console.log(`  クラウド経路: ${[...new Set(dc.routes.filter((r) => r.environment === "cloud").map((r) => r.status))].join(",")}（管理対象フックが前提）`);
console.log(`  限界の表示: ${dc.limits.length} 件`);
if (reg.status !== "registered" || !ok) process.exit(1);
console.log("\nhosts.mjs: 完了");
