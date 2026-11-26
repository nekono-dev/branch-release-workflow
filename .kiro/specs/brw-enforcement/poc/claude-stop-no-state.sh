#!/usr/bin/env bash
# PoC: BRW の状態ファイルが無い一時リポジトリで、Claude Code の Stop フックが応答の終了を 1 回止められ、
# 2 回目は stop_hook_active=true で通ること（未コミットの変更を理由に止める想定の再現）。ログは /tmp に残る。
set -eu
T=$(mktemp -d); LOG="$T/stop.jsonl"
git init -q "$T/r"; cd "$T/r"; git config user.email a@a; git config user.name a
echo a > a; git add .; git commit -qm init
mkdir -p .claude
cat > "$T/hook.mjs" <<H
import { appendFileSync } from "node:fs"; import { execFileSync } from "node:child_process";
let t=""; for await (const c of process.stdin) t+=c; const ev=JSON.parse(t);
const dirty=execFileSync("git",["status","--porcelain","--untracked-files=normal"],{cwd:ev.cwd}).toString().trim();
const block = !ev.stop_hook_active && dirty!=="";
appendFileSync("$LOG", JSON.stringify({stop_hook_active:ev.stop_hook_active, dirty:dirty!=="", block, keys:Object.keys(ev)})+"\n");
if (block) process.stdout.write(JSON.stringify({decision:"block", reason:"未コミットの変更があります。commit はせず、未コミットであることだけを報告して終了してください。"}));
H
cat > .claude/settings.json <<S
{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"node $T/hook.mjs"}]}]}}
S
echo "claude: $(claude --version 2>&1 | head -1)"
timeout 170 claude -p --setting-sources project --permission-mode acceptEdits "new.txt というファイルを作り、中身を hi にしてください。git の操作はしないでください。" 2>&1 | tail -4
echo "--- Stop フックのログ"; cat "$LOG"
