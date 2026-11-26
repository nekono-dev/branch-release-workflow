#!/usr/bin/env bash
# PoC: エージェントが Bash で別ディレクトリ（worktree 相当）へ cd して作業した後、Stop フックの入力 cwd がどこになるか
set -eu
T=$(mktemp -d); LOG="$T/stop.jsonl"
git init -q "$T/main"; cd "$T/main"; git config user.email a@a; git config user.name a
echo a > a; git add .; git commit -qm init
git worktree add -q "$T/main/.claude/worktrees/x" -b dev/x
mkdir -p .claude
cat > "$T/hook.mjs" <<H
import { appendFileSync } from "node:fs";
let t=""; for await (const c of process.stdin) t+=c; const ev=JSON.parse(t);
appendFileSync("$LOG", JSON.stringify({cwd:ev.cwd, stop_hook_active:ev.stop_hook_active})+"\n");
H
echo "{\"hooks\":{\"Stop\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"node $T/hook.mjs\"}]}]}}" > .claude/settings.json
echo "起動ディレクトリ: $T/main"
timeout 170 claude -p --setting-sources project --permission-mode acceptEdits "Bash で .claude/worktrees/x に cd し、その中で new.txt を作ってください（cd と作成は 1 回の Bash でも別々でもよい）。終わったら終了してください。" < /dev/null 2>&1 | tail -3
echo "--- Stop の cwd"; cat "$LOG"
