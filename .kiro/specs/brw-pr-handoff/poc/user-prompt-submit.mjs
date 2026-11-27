#!/usr/bin/env node
// PoC（brw-pr-handoff 要件 7、設計の確認）: UserPromptSubmit の additionalContext がモデルへ届くか、入力に何が含まれるか、
// 作業場所（worktree）の削除後に同じセッションのフックがどうなるか。Claude Code と Codex を各 1〜2 回呼ぶ。
// 使い方: node user-prompt-submit.mjs claude|codex   （使い捨ての一時リポジトリだけを使う。利用者の ~/.claude・~/.codex は変更しない。
//   Codex は一時の CODEX_HOME に認証のコピーを置き、実行後に消す）
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const host = process.argv[2];
if (!["claude", "codex"].includes(host)) { console.error("使い方: node user-prompt-submit.mjs claude|codex"); process.exit(2); }
const base = mkdtempSync(join(tmpdir(), `ups-${host}-`));
const main = join(base, "main");
const log = join(base, "hook.jsonl");
const TOKEN = "UPS-TOKEN-7f3a91";
const g = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
mkdirSync(main, { recursive: true });
g(main, "init", "-q", "-b", "main");
g(main, "-c", "user.email=a@a", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "init");

// 記録つきの UserPromptSubmit フック: 入力を記録し、additionalContext を返す
const hook = join(base, "hook.mjs");
writeFileSync(hook, `import { appendFileSync } from "node:fs";
let t = ""; for await (const c of process.stdin) t += c;
let i = {}; try { i = JSON.parse(t); } catch {}
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ at: new Date().toISOString(), keys: Object.keys(i).sort(), event: i.hook_event_name, cwd: i.cwd, session_id: i.session_id, prompt: String(i.prompt ?? "").slice(0, 60), env: { CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR ?? null }, pwd: process.cwd() }) + "\\n");
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "フックからの連絡: 合言葉は ${TOKEN} です。聞かれたらこれをそのまま答えてください。" } }));
`);
let env = { ...process.env }, bin, args;
const prompt1 = "フックから受け取った「合言葉」を、1 行だけで答えてください。分からなければ「なし」と答えてください。";
if (host === "claude") {
  mkdirSync(join(main, ".claude"), { recursive: true });
  writeFileSync(join(main, ".claude", "settings.json"), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: `node ${hook}` }] }] } }));
  bin = "claude";
  args = ["-p", prompt1, "--model", "haiku", "--max-turns", "3", "--setting-sources", "project", "--no-session-persistence"];
} else {
  const codexHome = join(base, "codex-home");
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  writeFileSync(join(codexHome, "config.toml"), `[projects."${main}"]\ntrust_level = "trusted"\n`);
  const src = join(homedir(), ".codex", "auth.json");
  if (existsSync(src)) { copyFileSync(src, join(codexHome, "auth.json")); chmodSync(join(codexHome, "auth.json"), 0o600); }
  mkdirSync(join(main, ".codex"), { recursive: true });
  writeFileSync(join(main, ".codex", "hooks.json"), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: `node ${hook}` }] }] } }));
  env = { ...env, CODEX_HOME: codexHome };
  bin = "codex";
  args = ["exec", "--json", "--skip-git-repo-check", "-C", main, "-s", "workspace-write", "-c", 'model_reasoning_effort="low"', "--dangerously-bypass-hook-trust", prompt1];
}
const r = spawnSync(bin, args, { cwd: main, env, encoding: "utf8", timeout: 240000, maxBuffer: 32 * 1024 * 1024, input: "" });
const out = `${r.stdout ?? ""}`;
const entries = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
console.log(JSON.stringify({ host, version: spawnSync(bin, ["--version"], { encoding: "utf8" }).stdout.trim(), exit: r.status, hookEntries: entries.length, reachedModel: out.includes(TOKEN), hook: entries[0] ?? null }, null, 2));
if (host === "codex") rmSync(join(base, "codex-home"), { recursive: true, force: true });
console.log(`作業場所: ${base}（確認後に削除）`);
