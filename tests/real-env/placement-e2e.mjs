// brw-branch-gate 8.1: 実機で、`.worktree/` への作成・再開・旧置き場の拒否・警告を通しで確かめる。
// 使い方: BRW_REAL_ENV=1 node tests/real-env/placement-e2e.mjs [--keep]
// 使い捨てのリポジトリ（origin は一時の bare）で、実際の `claude -p`（--setting-sources project）と実際の codex を呼ぶ。
// 利用者の ~/.claude・~/.codex は読み書きしない。権限モードを迂回する指定（bypassPermissions など）は使わない。GitHub へは書き込まない。
// 各項目を OK/NG で表示し、最後に 1 行の JSON を出す。NG があれば終了コード 1。
//
// 確かめる 6 項目（タスク 8.1 の (1)〜(6)）:
//   (1) 素の `git switch -c dev/foo` が BRW に置き換えられ、次の Bash の作業場所が <本体>/.worktree/dev-foo になる
//   (2) EnterWorktree の name 指定が拒否され、案内に従って brw create で作った worktree へ Bash の cd で移れる
//   (3) .worktree/<別名> で開始したセッションが worktree を消したあとも、フックが CLAUDE_PROJECT_DIR（worktree）を受け取る。
//       導出そのもの（mainOfStart の戻り値）は公開の入口で観測できないため実機では観測せず、同じ入力の形の単体試験（tests/user-prompt-submit.mjs）で確かめる（NOTE として出す）
//   (4) 実際の Codex で、.worktree/<別名> から本体の .codex/hooks.json が読まれる（placement-codex.mjs を子として実行）
//   (5) brw resume が旧置き場（<本体>/.claude/worktrees/<別名>）の使用中ブランチを拒否し、移動手順を案内する
//   (6) .worktree/ が無視されていない導入先で、brw create が成功後に警告を出す
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BRW_ROOT, requireRealEnv } from "./common.mjs";
import { judgeEnterWorktreeMove, judgeRemovedWorktreeSession } from "./placement-judge.mjs";

requireRealEnv("placement-e2e.mjs");

const HERE = dirname(fileURLToPath(import.meta.url));
const KEEP = process.argv.includes("--keep");
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "brw-placement-e2e-")));
const LOGGER = join(HERE, "hook-logger.mjs");
const BRW_CLI = join(BRW_ROOT, "scripts/brw.mjs");
const HOOK_LOG_DIR = join(tmp, "hook-log");
const HOOK_LOG = join(HOOK_LOG_DIR, "claude.jsonl");

// 導入先の宣言（.branch-release-workflow.json）。作業ブランチ dev/*、保護 main
const CONFIG = {
  workBranches: ["dev/*"],
  protectedBranches: ["main"],
  baseBranch: "main",
  namePattern: "^dev/[a-z0-9]+(-[a-z0-9]+)*$",
  maxNameLength: 54,
  autoApprove: { push: true, pullRequest: true },
  preview: { provider: "none" },
};

// 実 BRW のフック（agent-hooks.mjs）を、観測用のラッパー（hook-logger.mjs）経由で登録する。
// 呼ばれるたびに、ホストが渡した CLAUDE_PROJECT_DIR の値を project-dir.txt へ 1 行ずつ残す（値は hook-logger が記録しないため）。
const hook = (ev) => [{
  type: "command",
  command: `sh -c 'mkdir -p "$BRW_HOOK_LOG_DIR"; printf "%s\\n" "$CLAUDE_PROJECT_DIR" >> "$BRW_HOOK_LOG_DIR/project-dir.txt"; exec node "${LOGGER}" claude ${ev}'`,
}];
const SETTINGS = {
  hooks: {
    PreToolUse: [{ matcher: "Bash|EnterWorktree", hooks: hook("PreToolUse") }],
    PostToolUse: [{ matcher: "Bash", hooks: hook("PostToolUse") }],
    UserPromptSubmit: [{ hooks: hook("UserPromptSubmit") }],
  },
};

const git = (cwd, ...args) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
const gitOk = (cwd, ...args) => {
  const r = git(cwd, ...args);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} が失敗しました: ${r.stderr}`);
  return r.stdout.trim();
};

/** 使い捨てのリポジトリを作る（origin は一時の bare）。ignore が真なら .gitignore に /.worktree/ を入れる */
function makeRepo(name, { ignore }) {
  const origin = join(tmp, `${name}-origin.git`);
  const repo = join(tmp, name);
  gitOk(tmp, "init", "-q", "--bare", "-b", "main", origin);
  mkdirSync(repo);
  gitOk(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, ".branch-release-workflow.json"), `${JSON.stringify(CONFIG, null, 2)}\n`);
  writeFileSync(join(repo, ".gitignore"), `${ignore ? "/.worktree/\n" : ""}/.claude/worktrees/\n`);
  mkdirSync(join(repo, ".claude"));
  writeFileSync(join(repo, ".claude/settings.json"), `${JSON.stringify(SETTINGS, null, 2)}\n`);
  writeFileSync(join(repo, "a.txt"), "a\n");
  gitOk(repo, "add", ".gitignore", "a.txt", ".branch-release-workflow.json", ".claude/settings.json");
  gitOk(repo, "commit", "-q", "-m", "init");
  gitOk(repo, "remote", "add", "origin", origin);
  gitOk(repo, "push", "-q", "-u", "origin", "main");
  return realpathSync(repo);
}

/** worktree の一覧（git worktree list の絶対パス） */
const worktreePaths = (repo) => gitOk(repo, "worktree", "list", "--porcelain")
  .split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice("worktree ".length));

/** 実際の claude -p を 1 回実行し、ツールの呼び出しと結果を取り出す。利用者の設定は読まない（--setting-sources project）。 */
function runClaude(cwd, prompt, maxTurns) {
  const r = spawnSync("claude", ["-p", prompt, "--max-turns", String(maxTurns), "--output-format", "stream-json", "--verbose",
    "--setting-sources", "project", "--allowedTools", "EnterWorktree,Bash"], {
    cwd, encoding: "utf8", timeout: 300000, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, BRW_HOOK_LOG_DIR: HOOK_LOG_DIR },
  });
  const uses = new Map();
  const results = [];
  for (const line of (r.stdout ?? "").split("\n")) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const content = o.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b.type === "tool_use") uses.set(b.id, { name: b.name, input: b.input });
      if (b.type === "tool_result") {
        const text = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
        results.push({ tool: uses.get(b.tool_use_id)?.name, isError: b.is_error === true, text });
      }
    }
  }
  return { status: r.status, results };
}

/** フックの記録（claude.jsonl）を読む。解析できない行は無視する */
function hookEntries() {
  if (!existsSync(HOOK_LOG)) return [];
  const out = [];
  for (const line of readFileSync(HOOK_LOG, "utf8").split("\n")) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* 解析できない行は除く */ }
  }
  return out;
}
/** フックが最後に受け取った CLAUDE_PROJECT_DIR の値（project-dir.txt の最後の行）。無ければ null */
function lastProjectDir() {
  const f = join(HOOK_LOG_DIR, "project-dir.txt");
  if (!existsSync(f)) return null;
  const lines = readFileSync(f, "utf8").split("\n").filter((l) => l !== "");
  return lines.length ? lines[lines.length - 1] : null;
}
const since = (mark) => hookEntries().slice(mark);
const mark = () => hookEntries().length;
const isPre = (e, tool) => e?.event === "PreToolUse" && e?.input?.tool_name === tool;
const bashCmd = (e) => String(e?.input?.tool_input?.command ?? "");
const cwdOf = (e) => e?.input?.cwd ?? e?.cwd;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok });
  console.log(`${ok ? "OK" : "NG"}  ${name}${ok ? "" : `\n    ${detail}`}`);
};
const brief = (s) => String(s ?? "").slice(0, 400);

try {
  // ---- (1)(2)(3) 同じリポジトリ R1 で続けて確かめる ----
  const R1 = makeRepo("r1", { ignore: true });
  const WT_FOO = join(R1, ".worktree", "dev-foo");
  const WT_BAR = join(R1, ".worktree", "dev-bar");

  // (1) 素の git switch -c dev/foo が置き換えられ、次の Bash の作業場所が .worktree/dev-foo になる
  let m = mark();
  const s1 = runClaude(R1, "Bash ツールで次のコマンドをそのまま 1 回だけ実行してください: git switch -c dev/foo\nその後、別の Bash ツールで pwd を実行し、pwd の出力だけを答えてください。", 8);
  const e1 = since(m);
  const sw = e1.find((e) => isPre(e, "Bash") && /git switch -c dev\/foo/.test(bashCmd(e)));
  const pw1 = e1.find((e) => isPre(e, "Bash") && bashCmd(e).trim() === "pwd");
  check("(1) 素の git switch -c dev/foo が BRW に置き換えられ、次の Bash の作業場所が <本体>/.worktree/dev-foo になる",
    sw?.stdout?.includes('"updatedInput"') && worktreePaths(R1).includes(WT_FOO) && cwdOf(pw1) === WT_FOO,
    `exit=${s1.status} フック(switch)=${brief(sw?.stdout)} worktree=${worktreePaths(R1).join(",")} pwd の作業場所=${cwdOf(pw1)}`);

  // (2) EnterWorktree の name 指定が拒否され、案内に従って brw create の worktree へ cd で移れる
  m = mark();
  const s2 = runClaude(R1, "EnterWorktree ツールを name に bar を指定して 1 回だけ呼んでください。拒否されたら、その結果に書かれた案内に従って brw create で worktree を作り、その worktree のパスへ Bash ツールの cd で移動してください（EnterWorktree の再試行はしないでください）。移動先で pwd を実行し、pwd の出力だけを答えてください。", 12);
  const e2 = since(m);
  const ew2 = e2.find((e) => isPre(e, "EnterWorktree"));
  // 判定: name=bar の EnterWorktree・brw create・cd の順に記録があり、移った先が worktree（cd のあとの作業場所、または cd と pwd の結果）。
  // 任意の Bash の結果が worktree のパスと一致するだけでは成功にしない（placement-judge.mjs）
  const j2 = judgeEnterWorktreeMove(e2, s2.results, WT_BAR, "bar");
  check("(2) EnterWorktree の name 指定が拒否され、案内に従って brw create で作った worktree へ Bash の cd で移れる",
    /"permissionDecision":\s*"deny"/.test(ew2?.stdout ?? "") && worktreePaths(R1).includes(WT_BAR) && j2.ok,
    `exit=${s2.status} EnterWorktree のフック=${brief(ew2?.stdout)} worktree=${worktreePaths(R1).join(",")} 判定=${JSON.stringify(j2)}\n    フックの記録（ツール・コマンド・作業場所）=${JSON.stringify(e2.filter((e) => e.event === "PreToolUse").map((e) => [e.input?.tool_name, e.input?.tool_input?.command ?? e.input?.tool_input?.path ?? e.input?.tool_input?.name, cwdOf(e)]))}\n    モデルの結果=${brief(JSON.stringify(s2.results.map((r) => [r.tool, r.isError, r.text])))}`);

  // (3) .worktree/dev-foo で開始したセッションが、その worktree を消したあとも、フックが CLAUDE_PROJECT_DIR（worktree のパス）を受け取る。
  // 実機の観測（試行で確認）: 消えた作業場所の次の Bash は、復帰したシェルの場所（cwd）で記録され、CLAUDE_PROJECT_DIR は worktree のまま渡る。
  // これは mainOfStart の入力（作業場所が消え、CLAUDE_PROJECT_DIR から本体を導く経路）の実機の前提にあたる。
  m = mark();
  // 注意: 消えた作業場所では、Bash が「作業ディレクトリがない」と失敗することがある。その場合は同じ echo after を 1 回だけ再実行する（場所は復帰したシェルの場所になる）
  const s3 = runClaude(WT_FOO, `Bash ツールで次を 1 回実行してください: git -C ${R1} worktree remove --force ${WT_FOO}\nその後、Bash ツールで echo after を 1 回実行してください。作業ディレクトリがないと失敗したら、echo after をもう 1 回だけ実行してください。結果だけ答えてください。`, 8);
  const e3 = since(m);
  const pd3 = lastProjectDir();
  const j3 = judgeRemovedWorktreeSession(e3, WT_FOO, pd3, existsSync(WT_FOO));
  check("(3) .worktree/<別名> で開始したセッションが worktree を消したあとも、フックが CLAUDE_PROJECT_DIR（worktree）を受け取り、消えた作業場所（または復帰したシェルの場所）の入力を受ける",
    j3.ok,
    `exit=${s3.status} 判定=${JSON.stringify(j3)} CLAUDE_PROJECT_DIR(最後の値)=${pd3} worktree の存在=${existsSync(WT_FOO)} フックの記録（ツール・コマンド・作業場所）=${JSON.stringify(e3.filter((e) => e.event === "PreToolUse").map((e) => [e.input?.tool_name, bashCmd(e) || e.input?.tool_input?.name, cwdOf(e)]))}`);
  // 導出そのもの（mainOfStart が消えた作業場所と CLAUDE_PROJECT_DIR から本体を導く結果）は、公開の入口の応答に出ないため、実機では観測しない。
  // 実機で確かめたのは上の入力の形（消えた作業場所の cwd と、worktree を指す CLAUDE_PROJECT_DIR）。同じ形の入力での導出は、
  // tests/user-prompt-submit.mjs（brw-pr-handoff/7.4・9.4。PostToolUse・UserPromptSubmit の公開の入口を通す単体試験）が確かめる。
  console.log("NOTE (3) 本体の導出そのもの（mainOfStart の戻り値）は実機では観測せず、上の実機の入力の形を使う単体試験（tests/user-prompt-submit.mjs の 7.4・9.4）で確かめる");

  // ---- (4) 実際の Codex（placement-codex.mjs を子として実行する。hooks/list で読まれたフックを見る） ----
  const r4 = spawnSync(process.execPath, [join(HERE, "placement-codex.mjs")], { encoding: "utf8", env: process.env, timeout: 300000 });
  check("(4) 実際の Codex で、.worktree/<別名> から本体の .codex/hooks.json が読まれる（placement-codex.mjs）",
    r4.status === 0 && /"script":"placement-codex","ok":true/.test(r4.stdout ?? ""),
    `exit=${r4.status} 出力末尾=${brief((r4.stdout ?? "").slice(-600) + (r4.stderr ?? "").slice(-200))}`);

  // ---- (5) brw resume が旧置き場の使用中ブランチを拒否し、移動手順を案内する ----
  const OLD = join(R1, ".claude", "worktrees", "dev-old");
  gitOk(R1, "worktree", "add", "-q", OLD, "-b", "dev/old");
  const r5 = spawnSync(process.execPath, [BRW_CLI, "resume", "dev/old"], { cwd: R1, encoding: "utf8", env: process.env });
  const out5 = `${r5.stdout ?? ""}${r5.stderr ?? ""}`;
  check("(5) brw resume が旧置き場の使用中ブランチを拒否し、移動手順を案内する",
    r5.status !== 0 && out5.includes("旧置き場") && out5.includes("git worktree move"),
    `exit=${r5.status} 出力=${brief(out5)}`);

  // ---- (6) .worktree/ が無視されていない導入先で、brw create が成功後に警告を出す ----
  const R6 = makeRepo("r6", { ignore: false });
  const r6 = spawnSync(process.execPath, [BRW_CLI, "create", "foo"], { cwd: R6, encoding: "utf8", env: process.env });
  const out6 = `${r6.stdout ?? ""}${r6.stderr ?? ""}`;
  check("(6) .worktree/ が無視されていない導入先で、brw create が成功後に警告を出す",
    r6.status === 0 && out6.includes("無視されていません"),
    `exit=${r6.status} 出力=${brief(out6)}`);
} catch (error) {
  check("実行中の例外", false, String(error?.stack ?? error));
} finally {
  if (KEEP) console.log(`一時ディレクトリを残しました: ${tmp}`);
  else rmSync(tmp, { recursive: true, force: true });
}

const ok = checks.length > 0 && checks.every((c) => c.ok);
console.log(JSON.stringify({ script: "placement-e2e", ok, checks }));
process.exit(ok ? 0 : 1);
