#!/usr/bin/env node
// PoC（brw-pr-handoff 要件 7）: Claude Code の同じセッションで、worktree を削除した「後」の 2 回目の入力の UserPromptSubmit が、
// どの cwd・session_id で呼ばれるか。複数ターンの stream-json 入力を使う。使い捨ての一時リポジトリだけを使う。
// 使い方: node user-prompt-submit-after-remove.mjs main|worktree   （セッションを本体で開始するか、worktree の中で開始するか）
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const where = process.argv[2];
if (!["main", "worktree"].includes(where)) { console.error("使い方: node user-prompt-submit-after-remove.mjs main|worktree"); process.exit(2); }
const base = mkdtempSync(join(tmpdir(), `ups-rm-${where}-`));
const main = join(base, "main");
const wt = join(main, ".claude", "worktrees", "wt");
const log = join(base, "hook.jsonl");
const g = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
mkdirSync(main, { recursive: true });
g(main, "init", "-q", "-b", "main");
g(main, "-c", "user.email=a@a", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "init");
g(main, "worktree", "add", "-q", "-b", "dev/probe", wt);
const hook = join(base, "hook.mjs");
writeFileSync(hook, `import { appendFileSync, existsSync } from "node:fs";
let t = ""; for await (const c of process.stdin) t += c;
let i = {}; try { i = JSON.parse(t); } catch {}
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ at: new Date().toISOString(), event: i.hook_event_name, cwd: i.cwd, cwdExists: existsSync(i.cwd ?? "/nonexistent"), session_id: i.session_id, project: process.env.CLAUDE_PROJECT_DIR ?? null, projectExists: existsSync(process.env.CLAUDE_PROJECT_DIR ?? "/nonexistent"), prompt: String(i.prompt ?? "").slice(0, 40) }) + "\\n");
`);
const settings = JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: `node ${hook}` }] }] } });
for (const d of [main, wt]) { mkdirSync(join(d, ".claude"), { recursive: true }); writeFileSync(join(d, ".claude", "settings.json"), settings); }
const start = where === "main" ? main : wt;
const turn = (text) => JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";
const t1 = `次を、この順に別々の Bash 呼び出しとして実行してください。1) cd ${wt} && pwd  2) git -C ${main} worktree remove --force ${wt} && echo removed  3) pwd  4) echo ok`;
const t2 = "追加の依頼です。現在の作業ディレクトリを pwd で確認して、1 行で答えてください。";
const p = spawn("claude", ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--model", "haiku", "--max-turns", "10", "--setting-sources", "project", "--allowedTools", "Bash", "--no-session-persistence"], { cwd: start, stdio: ["pipe", "pipe", "pipe"] });
let out = "", resultCount = 0;
p.stdout.on("data", (d) => {
  out += d;
  for (const line of String(d).split("\n")) { if (line.includes('"type":"result"')) { resultCount++; if (resultCount === 1) p.stdin.write(turn(t2)); else p.stdin.end(); } }
});
p.stdin.write(turn(t1));
const timer = setTimeout(() => p.kill("SIGKILL"), 240000);
p.on("close", () => {
  clearTimeout(timer);
  const entries = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const answers = [...out.matchAll(/"result":"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].slice(0, 160));
  console.log(JSON.stringify({ where, results: resultCount, worktreeExistsAfter: existsSync(wt), hookEntries: entries, answers }, null, 2));
  console.log(`作業場所: ${base}`);
});
