// brw-branch-gate 5.1: 配置先 `<本体>/.worktree/<別名>` に対する Claude Code の挙動を、実際の `claude -p` で観察する。
// 使い方: BRW_REAL_ENV=1 node tests/real-env/placement-claude.mjs [--keep]
// 利用者の設定・認証は書き換えない（使い捨てのリポジトリと、そのプロジェクトの設定だけを使う。`--setting-sources project`）。
// 権限モードを迂回する指定（bypassPermissions など）は使わない。
//
// 観察する前提（design.md「2026-11-28」、poc/design_01.md）:
//   (1) `.worktree/` の下への EnterWorktree は、フックが許可（allow）を返しても承認の確認で止まる。
//   (2) `.worktree/<別名>` で開始したセッションでは、フックの cwd と CLAUDE_PROJECT_DIR がどちらも worktree 自身になる。
//   (3) 承認なしで入れる旧置き場の worktree への EnterWorktree の後は、cwd が worktree、CLAUDE_PROJECT_DIR が本体のままになる。
// 食い違いがあれば終了コード 1（Claude Code の版が上がって挙動が変わったときの検知）。
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireRealEnv } from "./common.mjs";

requireRealEnv("placement-claude.mjs");

const KEEP = process.argv.includes("--keep");
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "brw-placement-claude-")));
const log = join(tmp, "hook.log");
const repo = join(tmp, "r");

// フックの記録用スクリプト。環境変数 POC_MODE=allow のとき、EnterWorktree に許可（allow）を返す
writeFileSync(join(tmp, "hook.mjs"), `import { appendFileSync, readFileSync } from "node:fs";
const ev = process.argv[2];
let input = {};
try { input = JSON.parse(readFileSync(0, "utf8")); } catch {}
appendFileSync(process.env.POC_LOG, JSON.stringify({ ev, tag: process.env.POC_TAG, cwd: input.cwd, tool: input.tool_name, ti: input.tool_input, CPD: process.env.CLAUDE_PROJECT_DIR }) + "\\n");
if (ev === "PreToolUse" && input.tool_name === "EnterWorktree" && process.env.POC_MODE === "allow")
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "poc allow" } }));
`);
const hook = (ev) => ({ hooks: [{ type: "command", command: `node ${join(tmp, "hook.mjs")} ${ev}` }] });
writeFileSync(join(tmp, "settings.json"), JSON.stringify({
  hooks: {
    SessionStart: [hook("SessionStart")],
    UserPromptSubmit: [hook("UserPromptSubmit")],
    PreToolUse: [{ matcher: "EnterWorktree|Bash", ...hook("PreToolUse") }],
    Stop: [hook("Stop")],
  },
}));

const git = (cwd, ...args) => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} が失敗しました: ${r.stderr}`);
  return r.stdout.trim();
};
mkdirSync(repo);
git(repo, "init", "-q", "-b", "main");
mkdirSync(join(repo, ".claude"));
copyFileSync(join(tmp, "settings.json"), join(repo, ".claude/settings.json"));
writeFileSync(join(repo, ".gitignore"), "/.worktree/\n/.claude/worktrees/\n");
writeFileSync(join(repo, "a.txt"), "a\n");
git(repo, "add", ".gitignore", "a.txt", ".claude/settings.json");
git(repo, "commit", "-q", "-m", "init");
const wtNew = join(repo, ".worktree/dev-x");
const wtOld = join(repo, ".claude/worktrees/dev-y");
git(repo, "worktree", "add", "-q", wtNew, "-b", "dev/x");
git(repo, "worktree", "add", "-q", wtOld, "-b", "dev/y");

/** 実際の claude -p を 1 回実行し、ツールの呼び出しと結果を取り出す。 */
function runClaude(cwd, tag, mode, prompt) {
  const r = spawnSync("claude", ["-p", prompt, "--max-turns", "8", "--output-format", "stream-json", "--verbose",
    "--setting-sources", "project", "--allowedTools", "EnterWorktree,Bash,ToolSearch"], {
    cwd, encoding: "utf8", timeout: 240000, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, POC_TAG: tag, POC_MODE: mode, POC_LOG: log },
  });
  const tools = new Map();
  const results = [];
  for (const line of (r.stdout ?? "").split("\n")) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const c = o.message?.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b.type === "tool_use") tools.set(b.id, { name: b.name, input: b.input });
      if (b.type === "tool_result") {
        const text = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
        results.push({ tool: tools.get(b.tool_use_id)?.name, input: tools.get(b.tool_use_id)?.input, isError: b.is_error === true, text });
      }
    }
  }
  return { status: r.status, results };
}
const hookLines = (tag) => (readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((d) => d.tag === tag));
const enter = (path) => `EnterWorktree ツールを path に ${path} を指定して呼び、続けて Bash で pwd を実行し、その結果だけを答えてください。`;

const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok, detail }); console.log(`${ok ? "OK" : "NG"}  ${name}${ok ? "" : `\n    ${detail}`}`); };

try {
  writeFileSync(log, "");
  // (1) `.worktree/` の下への EnterWorktree（フックは allow を返す）
  const s1 = runClaude(repo, "S1", "allow", enter(wtNew));
  const e1 = s1.results.find((x) => x.tool === "EnterWorktree");
  const h1 = hookLines("S1").find((d) => d.ev === "PreToolUse" && d.tool === "EnterWorktree");
  check("(1) .worktree/ への EnterWorktree は、フックが allow を返しても承認の確認で止まる",
    h1?.ti?.path === wtNew && e1?.input?.path === wtNew && e1?.isError === true && /Enter the worktree at/.test(e1.text),
    `フックの EnterWorktree 記録=${Boolean(h1)} 結果=${JSON.stringify(e1)?.slice(0, 300)}`);

  // (3) 承認なしで入れる旧置き場への EnterWorktree の後の cwd と CLAUDE_PROJECT_DIR
  const s3 = runClaude(repo, "S3", "none", enter(wtOld));
  const e3 = s3.results.find((x) => x.tool === "EnterWorktree");
  const bash3 = hookLines("S3").find((d) => d.ev === "PreToolUse" && d.tool === "Bash");
  check("(3) 旧置き場へ EnterWorktree した後、cwd は worktree、CLAUDE_PROJECT_DIR は本体のまま",
    e3?.input?.path === wtOld && e3?.isError === false && /Entered worktree/.test(e3.text) && bash3?.cwd === wtOld && bash3?.CPD === repo,
    `EnterWorktree=${JSON.stringify(e3)?.slice(0, 200)} Bash のフック=${JSON.stringify(bash3)}`);

  // (2) `.worktree/<別名>` で開始したセッション
  const s2 = runClaude(wtNew, "S2", "none", "Bash で pwd を実行し、その結果だけを答えてください。");
  const h2 = hookLines("S2");
  const start = h2.find((d) => d.ev === "SessionStart");
  const pre = h2.find((d) => d.ev === "PreToolUse" && d.tool === "Bash");
  check("(2) .worktree/<別名> で開始したセッションでフックが届き、cwd と CLAUDE_PROJECT_DIR が worktree 自身になる",
    start?.cwd === wtNew && start?.CPD === wtNew && pre?.cwd === wtNew && pre?.CPD === wtNew && s2.status === 0,
    `SessionStart=${JSON.stringify(start)} PreToolUse(Bash)=${JSON.stringify(pre)} exit=${s2.status}`);
} finally {
  if (KEEP) console.log(`一時ディレクトリを残しました: ${tmp}`);
  else rmSync(tmp, { recursive: true, force: true });
}

console.log(JSON.stringify({ script: "placement-claude", ok: checks.every((c) => c.ok), checks: checks.map(({ name, ok }) => ({ name, ok })) }));
process.exit(checks.every((c) => c.ok) ? 0 : 1);
