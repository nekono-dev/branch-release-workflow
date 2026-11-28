// brw-pr-handoff 10.3: 実機で、本文置き場への記入から PR 作成・片付けまでを通しで確かめる。BRW_REAL_ENV=1 のときだけ動く。
// 使い方: BRW_REAL_ENV=1 node tests/real-env/body-placement-e2e.mjs
//
// 確かめること（判定は body-placement-judge.mjs の純粋関数）:
//   (0)(1) 本体で開始し、Bash の cd で作業場所（.worktree/dev-body）へ移って `brw pr-template` を実行し、その出力の
//          本文のパス（<本体>/.worktree/.brw/dev-body.md）へ Write で本文を書く（claude -p の実際の呼び出し）
//   (2)    `brw pr --body-file <そのパス>` が PR を作る（偽の GitHub が受けた本文は記入済み）
//   (3)    片付けで本文ファイルと作業場所が消える
//   (4)    旧置き場（<本体>/.claude/worktrees/.brw/）の本文を --body-file に渡すと拒否され、mv の案内が出る（brw.mjs の CLI。claude は使わない）
//
// 一時の環境（一時リポジトリ・bare remote・偽の gh・偽の ssh・brw と gh の PATH の shim）だけを使う。GitHub には接続も書き込みもしない。
// 利用者の ~/.claude は読み書きしない（--setting-sources project）。権限モードの迂回はしない（--permission-mode acceptEdits）。
// Claude の応答は確率的なので、全項目が一致するまで最大 3 回まで試す（試行の回数を記録する）。
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireRealEnv } from "./common.mjs";
import { judgeBodyFlow, judgeLegacyRefusal, toolCallsOf } from "./body-placement-judge.mjs";

requireRealEnv("body-placement-e2e.mjs");

const BRW_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BRW_CLI = join(BRW_ROOT, "scripts", "brw.mjs");
const AGENT = join(BRW_ROOT, "scripts", "agent-hooks.mjs");
const BRANCH = "dev/body";
const ALIAS = "dev-body";
const PR_TITLE = "本文置き場の実機の確認";
const GH_SSH = "git@github.com:acme/app.git";
const MAX_ATTEMPTS = 3;
const TURN_TIMEOUT_MS = 420000;
// 宣言（導入先の .branch-release-workflow.json）。作業ブランチ dev/*、保護 main。登録済みなので確認は省かれる
const CONFIG = {
  workBranches: ["dev/*"],
  protectedBranches: ["main"],
  baseBranch: "main",
  namePattern: "^dev/[a-z0-9]+(-[a-z0-9]+)*$",
  maxNameLength: 54,
  autoApprove: { push: true, pullRequest: true },
  preview: { provider: "none" },
};

const g = (cwd, ...a) => execFileSync("git", ["-c", "user.name=obs", "-c", "user.email=obs@example.com", ...a], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// 偽の gh（GitHub へは通信しない）。PR は状態ファイルに持ち、作成（POST）の本文をログへ残す。head の SHA は bare remote の先端
const GH_SHIM = `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const C = JSON.parse(readFileSync(process.env.OBS_GH_CONFIG, "utf8"));
const args = process.argv.slice(2);
if (args[0] === "auth" && args[1] === "token") { process.stdout.write("obs-token\\n"); process.exit(0); }
if (args[0] !== "api") { appendFileSync(C.log, JSON.stringify({ unexpected: args.slice(0, 3).join(" ") }) + "\\n"); process.exit(2); }
const valueOf = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const method = (valueOf("--method") ?? "GET").toUpperCase();
const path = args.find((a) => a.startsWith("/")) ?? "/";
const body = args.includes("--input") ? readFileSync(0, "utf8") : undefined;
const parsed = body ? JSON.parse(body) : undefined;
const url = new URL(path, "https://api.github.com");
const state = existsSync(C.state) ? JSON.parse(readFileSync(C.state, "utf8")) : { prs: [] };
const repo = { id: 4242, full_name: "acme/app" };
const headSha = (b) => execFileSync("git", ["--git-dir", C.bare, "rev-parse", "--verify", "-q", "refs/heads/" + b], { encoding: "utf8" }).trim();
const prJson = (p) => ({ number: p.number, html_url: p.url, state: "open", draft: false, base: { ref: p.base, repo }, head: { ref: p.head, sha: headSha(p.head), repo } });
let status = 404, resp = { message: "Not Found" }, applied = false;
if (method === "GET" && url.pathname === "/repos/acme/app") { status = 200; resp = repo; }
else if (method === "GET" && url.pathname === "/repos/acme/app/pulls") {
  const head = (url.searchParams.get("head") ?? "").replace(/^acme:/, "");
  const base = url.searchParams.get("base");
  status = 200; resp = state.prs.filter((p) => p.head === head && (!base || p.base === base)).map(prJson);
} else if (method === "POST" && url.pathname === "/repos/acme/app/pulls") {
  const n = state.prs.length + 7;
  const p = { number: n, url: "https://github.com/acme/app/pull/" + n, head: parsed.head, base: parsed.base, title: parsed.title };
  state.prs.push(p); writeFileSync(C.state, JSON.stringify(state));
  status = 201; resp = prJson(p); applied = true;
}
appendFileSync(C.log, JSON.stringify({ method, path: url.pathname + url.search, applied, body: method === "POST" ? (parsed?.body ?? null) : null }) + "\\n");
process.stdout.write("HTTP/2.0 " + status + " " + (status < 300 ? "OK" : "Error") + "\\r\\ncontent-type: application/json\\r\\n\\r\\n" + JSON.stringify(resp));
`;
// 偽の ssh（bare remote へ向ける）
const FAKE_SSH = `#!/bin/sh
printf '%s\\n' "$2" >> "$BRW_OBS_SSHLOG"
cmd=$(printf '%s' "$2" | sed "s#acme/app.git#$BRW_OBS_BARE#")
exec sh -c "$cmd"
`;

/** 一時の環境を作る。本体（宣言・フックの設定・.worktree/ の無視）、bare remote、dev/body の作業場所（commit 済み）、shim。 */
function setupSandbox() {
  const base = mkdtempSync(join(tmpdir(), "brw-body-103-"));
  const bin = join(base, "bin");
  mkdirSync(bin);
  const bare = join(base, "remote.git");
  const mainRaw = join(base, "main");
  mkdirSync(mainRaw);
  const main = realpathSync(mainRaw);
  const wt = join(main, ".worktree", ALIAS);
  const files = { sshLog: join(base, "ssh.log"), ghLog: join(base, "gh.log"), state: join(base, "prs.json") };
  writeFileSync(files.sshLog, "");
  writeFileSync(files.ghLog, "");
  writeFileSync(join(base, "gh-shim.mjs"), GH_SHIM);
  writeFileSync(join(base, "fake-ssh.sh"), FAKE_SSH, { mode: 0o755 });
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nexec node "${join(base, "gh-shim.mjs")}" "$@"\n`, { mode: 0o755 });
  // `brw` は PATH 上のコマンドとして呼ばれる（実際の導入ではプラグインが用意する）。ここでは本リポジトリの brw.mjs へ向ける
  writeFileSync(join(bin, "brw"), `#!/bin/sh\nexec node "${BRW_CLI}" "$@"\n`, { mode: 0o755 });
  const ghConfig = join(base, "gh-config.json");
  writeFileSync(ghConfig, JSON.stringify({ log: files.ghLog, state: files.state, bare }));

  g(base, "init", "--bare", "-q", "-b", "main", bare);
  g(main, "init", "-q", "-b", "main");
  writeFileSync(join(main, ".branch-release-workflow.json"), `${JSON.stringify(CONFIG, null, 2)}\n`);
  writeFileSync(join(main, ".gitignore"), "/.worktree/\n/.claude/worktrees/\n");
  // フック（導入先と同じ登録。agent-hooks.mjs を直接呼ぶ）
  const hook = (event) => [{ type: "command", command: `node "${AGENT}" claude ${event}` }];
  mkdirSync(join(main, ".claude"));
  writeFileSync(join(main, ".claude", "settings.json"), `${JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: hook("PreToolUse") }],
      PostToolUse: [{ matcher: "Bash", hooks: hook("PostToolUse") }],
    },
  }, null, 2)}\n`);
  writeFileSync(join(main, "README.md"), "# 本文置き場の観測\n");
  g(main, "add", ".branch-release-workflow.json", "README.md");
  g(main, "commit", "-q", "-m", "初期");
  g(main, "remote", "add", "origin", bare);
  g(main, "push", "-q", "origin", "main");
  g(main, "remote", "set-url", "origin", GH_SSH);
  // 開発ブランチの作業場所（commit 済み）。切り出し元は main
  g(main, "worktree", "add", "-q", "-b", BRANCH, wt, "main");
  g(wt, "config", `branch.${BRANCH}.brwBase`, "main");
  writeFileSync(join(wt, "obs.txt"), "本文置き場の観測用の変更\n");
  g(wt, "add", "obs.txt");
  g(wt, "commit", "-q", "-m", "本文置き場の観測用の変更");

  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: process.env.HOME,
    LANG: process.env.LANG ?? "C.UTF-8",
    GIT_SSH_COMMAND: join(base, "fake-ssh.sh"),
    GIT_SSH_VARIANT: "simple",
    GIT_TERMINAL_PROMPT: "0",
    GH_TOKEN: "obs-token",
    OBS_GH_CONFIG: ghConfig,
    BRW_OBS_SSHLOG: files.sshLog,
    BRW_OBS_BARE: bare,
  };
  const bodyPath = join(main, ".worktree", ".brw", `${ALIAS}.md`);
  const legacyDir = join(main, ".claude", "worktrees", ".brw");
  return { base, main, wt, bare, files, env, bodyPath, legacyDir, legacyPath: join(legacyDir, `${ALIAS}.md`), cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

const ghPosts = (s) => readFileSync(s.files.ghLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.method === "POST");

/** 旧置き場の本文を --body-file に渡す（brw.mjs の CLI。claude は使わない）。拒否の判定に使う。 */
function legacyCheck() {
  const s = setupSandbox();
  try {
    mkdirSync(s.legacyDir, { recursive: true });
    writeFileSync(s.legacyPath, "## 概要\n旧置き場の本文（観測用）\n");
    const before = ghPosts(s).filter((p) => p.applied).length;
    const r = spawnSync("node", [BRW_CLI, "pr", "--title", PR_TITLE, "--completion", "依頼を完了した", "--verification", "確認済み", "--body-file", s.legacyPath], { cwd: s.wt, encoding: "utf8", env: s.env });
    const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    const judged = judgeLegacyRefusal({
      exit: r.status,
      output,
      legacyPath: s.legacyPath,
      legacyDir: s.legacyDir,
      newPath: s.bodyPath,
      legacyExistsAfter: existsSync(s.legacyPath),
      newExistsAfter: existsSync(s.bodyPath),
      postsDelta: ghPosts(s).filter((p) => p.applied).length - before,
    });
    return { ...judged, output: output.slice(0, 400) };
  } finally {
    s.cleanup();
  }
}

/** 実際の claude -p を 1 回動かし、判定する。環境は 1 回ごとに作り直す。 */
function flowAttempt() {
  const s = setupSandbox();
  try {
    const prompt = [
      "次の作業を、この順に実行してください。作業ブランチ dev/body の作業場所は " + s.wt + " です（commit 済み）。gh や git push を直接使わないでください。",
      `1. Bash ツールで次を 1 回実行してください: cd '${s.wt}' && brw pr-template`,
      "2. その出力に示された記入指示に従って、PR の本文を Write ツールで書いてください。本文の保存先は出力に示されたパスです。見出しは残し、説明の文は実際の文章に置き換え、先頭の「未記入」の印の行は削除してください。",
      `3. 本文を書き終えたら、Bash ツールで次を 1 回実行してください（<本文のパス> は出力に示されたパス）: cd '${s.wt}' && brw pr --title '${PR_TITLE}' --completion '依頼を完了した' --verification '確認済み' --body-file <本文のパス>`,
      "最後に、brw pr の出力の要点を 1 行で報告してください。",
    ].join("\n");
    const r = spawnSync("claude", ["-p", prompt, "--model", "haiku", "--max-turns", "12", "--output-format", "stream-json", "--verbose",
      "--setting-sources", "project", "--permission-mode", "acceptEdits", "--allowedTools", "Bash,Write", "--no-session-persistence"], {
      cwd: s.main, encoding: "utf8", env: s.env, timeout: TURN_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024,
    });
    const { calls, unparsed } = toolCallsOf(r.stdout ?? "");
    const j = judgeBodyFlow({
      calls,
      bodyPath: s.bodyPath,
      worktree: s.wt,
      legacyDir: s.legacyDir,
      posts: ghPosts(s).map((p) => ({ applied: p.applied, body: p.body ?? "" })),
      bodyExistsAfter: existsSync(s.bodyPath),
      worktreeExistsAfter: existsSync(s.wt),
    });
    return { exit: r.status, timeout: r.error?.code === "ETIMEDOUT", unparsed, calls: calls.length, ...j };
  } finally {
    s.cleanup();
  }
}

function main() {
  const v = spawnSync("claude", ["--version"], { encoding: "utf8" });
  const claudeVersion = v.status === 0 ? (v.stdout ?? "").trim() : "claude not available";
  const checks = [];
  const report = (name, ok, detail = "") => {
    checks.push({ name, ok });
    console.log(`${ok ? "OK" : "NG"}  ${name}${ok ? "" : `\n    ${detail}`}`);
  };

  // (4) 旧置き場の拒否（brw.mjs の CLI。claude は使わない）
  const legacy = legacyCheck();
  for (const i of legacy.items) report(`(${i.id}) 旧置き場の本文の拒否: ${i.detail}`, i.ok, `出力の先頭=${legacy.output}`);

  // (0)〜(3) claude -p の通し（最大 MAX_ATTEMPTS 回。全項目が一致した時点で止める）
  const attempts = [];
  for (let n = 1; n <= MAX_ATTEMPTS; n++) {
    const a = flowAttempt();
    attempts.push({ n, ok: a.ok, exit: a.exit, timeout: a.timeout, toolCalls: a.calls, unparsed: a.unparsed, items: a.items.map((i) => [i.id, i.ok]) });
    console.log(JSON.stringify({ attempt: n, ok: a.ok, exit: a.exit, items: attempts.at(-1).items }));
    if (a.ok) {
      for (const i of a.items) report(`(${i.id}) ${i.detail}`, i.ok);
      break;
    }
    if (n === MAX_ATTEMPTS) for (const i of a.items) report(`(${i.id}) ${i.detail}`, i.ok, `試行 ${n} 回で一致せず`);
  }

  const ok = checks.length > 0 && checks.every((c) => c.ok);
  console.log(JSON.stringify({ script: "body-placement-e2e", ok, claudeVersion, attempts, legacy: { ok: legacy.ok }, checks }));
  process.exit(ok ? 0 : 1);
}

try {
  main();
} catch (error) {
  console.log(`NG  実行中の例外\n    ${String(error?.stack ?? error)}`);
  process.exit(1);
}
