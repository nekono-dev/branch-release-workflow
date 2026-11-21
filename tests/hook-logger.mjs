// 実環境検証用 hook-logger の記録で、gh pr create/edit の本文の値が伏せられることを確かめる（実ホスト・実 GitHub は使わない）。
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const logger = join(dirname(fileURLToPath(import.meta.url)), "real-env/hook-logger.mjs");

export const runHookLoggerChecks = async (eq) => {
  const logged = (command) => {
    const dir = mkdtempSync(join(tmpdir(), "brw-hlog-"));
    spawnSync(process.execPath, [logger, "claude", "PreToolUse"], {
      input: JSON.stringify({ session_id: "s", cwd: dir, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }),
      encoding: "utf8",
      env: { ...process.env, BRW_HOOK_LOG_DIR: dir },
    });
    return JSON.parse(readFileSync(join(dir, "claude.jsonl"), "utf8").trim().split("\n").pop()).input.tool_input.command;
  };
  const SECRET = "社内の秘密の本文";
  const cases = [
    [`gh pr create --base develop --title "t" --body "${SECRET} a; b \\" c"`, `gh pr create --base develop --title "t" --body ***`],
    [`gh pr create -B develop -t t -b '${SECRET}'`, `gh pr create -B develop -t t -b ***`],
    [`gh pr edit 3 --body=${SECRET}`, `gh pr edit 3 --body ***`],
    [`gh pr create --base develop --body-file /tmp/${SECRET}.md --draft`, `gh pr create --base develop --body-file *** --draft`],
    [`git push -u origin dev/x && gh pr create --base develop -b "${SECRET}"`, `git push -u origin dev/x && gh pr create --base develop -b ***`],
  ];
  for (const [cmd, want] of cases) eq(`hook-logger/8.4 PR の本文の値は記録に残らない: ${cmd.slice(0, 40)}`, logged(cmd), want);
  eq("hook-logger/8.4 gh pr 以外のコマンドは変えない", logged(`git commit -m "-b x --body y"`), `git commit -m "-b x --body y"`);
};
