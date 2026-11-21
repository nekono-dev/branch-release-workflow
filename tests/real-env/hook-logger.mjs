#!/usr/bin/env node
// 8.4: ホストのフックイベントを記録する薄いラッパー。
// 使い方: node hook-logger.mjs <claude|codex> <イベント名>
// 標準入力（ホストが渡すイベントの JSON）と、scripts/agent-hooks.mjs の標準出力・終了コードを、日時付きで
// ${BRW_HOOK_LOG_DIR:-/tmp/brw-real-env/hook-log}/<host>.jsonl へ追記し、BRW の応答をそのままホストへ返す。
// 資格情報（トークン様の文字列・URL の認証部）は記録前に伏せる。BRW_REAL_ENV=1 のときだけ動く（無ければ何もせず 0 で終了）。
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.BRW_REAL_ENV !== "1" && !process.env.BRW_HOOK_LOG_DIR) process.exit(0);

const [host, event] = process.argv.slice(2);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const logDir = process.env.BRW_HOOK_LOG_DIR ?? "/tmp/brw-real-env/hook-log";

// 資格情報を伏せる（ghp_・github_pat_・URL の user:pass@ ・Bearer）
const redact = (s) => String(s ?? "")
  .replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@]+@/g, "$1***@")
  .replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{8,}/g, "***")
  .replace(/(Bearer\s+)[A-Za-z0-9._-]{12,}/gi, "$1***");

// gh pr create / edit の本文（--body・-b・--body-file・-F）は内容を記録しない。値だけを伏せ、他の引数は残す
const VALUE = String.raw`(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s;&|]+)`;
const BODY_OPT = new RegExp(String.raw`(^|\s)(--body-file|--body|-b|-F)(?:=|\s+)${VALUE}`, "g");
const redactPrBody = (cmd) => (typeof cmd === "string" && /\bgh\s+pr\s+(?:create|edit)\b/.test(cmd) ? cmd.replace(BODY_OPT, (_m, pre, opt) => `${pre}${opt} ***`) : cmd);

let text = "";
try { text = readFileSync(0, "utf8"); } catch { /* 入力なし */ }

const r = spawnSync(process.execPath, [join(root, "scripts/agent-hooks.mjs"), host, event], { input: text, encoding: "utf8", env: process.env });
const out = r.stdout ?? "";
const code = r.status ?? 1;

let input = text;
try { input = JSON.parse(text); } catch { /* 解釈できない入力は文字列のまま記録する */ }
if (input?.tool_input && typeof input.tool_input === "object") input = { ...input, tool_input: { ...input.tool_input, command: redactPrBody(input.tool_input.command) } };
const entry = {
  ts: new Date().toISOString(),
  host,
  event,
  pid: process.pid,
  cwd: process.cwd(),
  // フック子プロセスの環境にホストが入れる変数の有無（値は記録しない。パスのみ判定に使う）
  env: { CLAUDE_PLUGIN_ROOT: process.env.CLAUDE_PLUGIN_ROOT !== undefined, CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR !== undefined },
  input,
  stdout: out,
  stderr: r.stderr ?? "",
  exit: code,
};
try {
  mkdirSync(logDir, { recursive: true });
  appendFileSync(join(logDir, `${host}.jsonl`), `${redact(JSON.stringify(entry))}\n`);
} catch { /* 記録に失敗してもホストの処理は止めない */ }

if (out) process.stdout.write(out);
if (r.stderr) process.stderr.write(r.stderr);
process.exit(code);
