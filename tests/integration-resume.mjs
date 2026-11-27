// 続きの再開の統合試験（brw-pr-handoff 9.6 の前半）。selftest.mjs から呼ばれる。
// 実際の scripts/brw.mjs と scripts/agent-hooks.mjs を子プロセスとして spawn し、次の流れを端から端まで確かめる:
//   片付けつきの brw pr（偽の gh で PR 作成）→ 再開の記録 → PostToolUse の関連付け → UserPromptSubmit の案内（副作用なし）
//   → brw resume（作業場所の作り直し）→ 続きの commit と brw pr（既存の PR を再利用・重複なし）→ 再度の記録と案内
//   → Codex 形式（文字列の出力・cwd は本体）の関連付けと案内。
// 一時リポジトリ・bare remote・偽の gh・試験用 ssh を使い、GitHub と実際のホストには触れない。
// 試験の実行中は HOME と Git の設定を一時の場所へ隔離し、一時ディレクトリ（brw-fx-*・brw-int-*）が増えないことを確かめる。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bodyPathOf } from "../scripts/pr-template.mjs";
import { gitOut, mkRepoWithRemote } from "./support/git-fixture.mjs";
import { hookInput } from "./support/hook-fixtures.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const BRW = join(here, "../scripts/brw.mjs");
const HOOKS = join(here, "../scripts/agent-hooks.mjs");
const SHIM = join(here, "support/gh-shim.mjs");
const GH_SSH = "git@github.com:acme/app.git";
const REPO_KEY = "GET /repos/acme/app";
const POST = "POST /repos/acme/app/pulls";
const LIST = (b) => `GET /repos/acme/app/pulls?state=open&head=acme:${b}&per_page=100`;
const FILTERED = (b) => `GET /repos/acme/app/pulls?state=open&head=acme:${b}&base=main&per_page=100`;
const CONFIG = { workBranches: ["dev/*"], protectedBranches: ["main"], baseBranch: "develop" };
const TITLE = "続きの再開の統合試験";
const DONE = "依頼の完了条件を満たした";
const VERIFY = "npm test が成功";
const BODY = "## 概要\n続きの再開の統合試験の本文\n";
const S1 = "claude-int-s1";
const S2 = "claude-int-other";
const SC = "codex-int-s1";
const ISO_KEYS = ["HOME", "XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT"];
const FAKE_SSH = `#!/bin/sh
printf '%s\\n' "$2" >> "$BRW_TEST_SSHLOG"
cmd=$(printf '%s' "$2" | sed "s#acme/app.git#$BRW_TEST_BARE#")
exec sh -c "$cmd"
`;

const prOf = (branch, sha, number) => ({
  number,
  html_url: `https://github.com/acme/app/pull/${number}`,
  state: "open",
  draft: false,
  base: { ref: "main", repo: { id: 4242, full_name: "acme/app" } },
  head: { ref: branch, sha, repo: { id: 4242, full_name: "acme/app" } },
});
const ok = (body) => ({ status: 200, body });
const created = (body) => ({ status: 201, body });
const linesOf = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []);
const ghLogOf = (r) => linesOf(r.ghLog).map((l) => JSON.parse(l));
const postsOf = (r) => ghLogOf(r).filter((e) => e.method === "POST");
const sshLogOf = (r) => linesOf(r.sshLog);
const tmpLeftovers = () => [tmpdir(), "/tmp"].map((d) => readdirSync(d).filter((n) => n.startsWith("brw-fx-") || n.startsWith("brw-int-")).length);

export const runIntegrationResumeChecks = async (eq) => {
  const tmpBefore = tmpLeftovers();
  const sandbox = mkdtempSync(join(tmpdir(), "brw-int-resume-"));
  const bin = join(sandbox, "bin");
  const home = join(sandbox, "home");
  const sshPath = join(sandbox, "fake-ssh.sh");
  try {
    mkdirSync(bin);
    mkdirSync(home);
    writeFileSync(join(bin, "gh"), `#!/bin/sh\nexec node "${SHIM}" "$@"\n`, { mode: 0o755 });
    writeFileSync(sshPath, FAKE_SSH, { mode: 0o755 });
  } catch (e) {
    rmSync(sandbox, { recursive: true, force: true }); // 準備の途中で失敗しても一時ディレクトリを残さない
    throw e;
  }
  let seq = 0;
  // 作成した fixture（一時リポジトリ・bare remote）。正常・例外のどちらでも最後に消す
  const repos = [];

  const savedEnv = Object.fromEntries(ISO_KEYS.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" });

  // 偽の gh の設定（経路の応答）を一時ファイルに置く
  const ghCfg = (routes) => {
    const p = join(sandbox, `gh-${++seq}.json`);
    writeFileSync(p, JSON.stringify({ scenario: "success", routes: { [REPO_KEY]: ok({ id: 4242, full_name: "acme/app" }), ...routes } }));
    return p;
  };
  const envOf = (r, gh) => {
    const e = {
      ...process.env,
      HOME: home,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      PATH: `${bin}:${process.env.PATH}`,
      GH_TOKEN: "test-token-int-resume",
      BRW_NO_GH: "1",
      GIT_SSH_COMMAND: sshPath,
      GIT_SSH_VARIANT: "simple",
      GIT_TERMINAL_PROMPT: "0",
      BRW_TEST_BARE: r.remote,
      BRW_TEST_SSHLOG: r.sshLog,
      BRW_GH_SHIM_CONFIG: gh ?? r.gh,
      BRW_GH_SHIM_LOG: r.ghLog,
    };
    delete e.CLAUDE_PROJECT_DIR;
    return e;
  };
  const brwIn = (cwd, r, args, gh) => spawnSync("node", [BRW, ...args], { cwd, encoding: "utf8", env: envOf(r, gh) });
  const hookRun = (r, host, event, ev) => {
    const res = spawnSync("node", [HOOKS, host, event], { cwd: r.dir, encoding: "utf8", env: envOf(r), input: JSON.stringify(ev) });
    return { status: res.status, out: res.stdout ?? "" };
  };
  const remoteRef = (r, branch) => {
    const res = spawnSync("git", ["rev-parse", "--verify", "-q", `refs/heads/${branch}`], { cwd: r.remote, encoding: "utf8" });
    return res.status === 0 ? res.stdout.trim() : null;
  };
  const localRef = (r, branch) => {
    const res = spawnSync("git", ["rev-parse", "--verify", "-q", `refs/heads/${branch}`], { cwd: r.dir, encoding: "utf8" });
    return res.status === 0 ? res.stdout.trim() : null;
  };
  const recordFile = (r) => join(r.dir, ".git", "brw", "resume.json");
  const recordsOf = (r) => (existsSync(recordFile(r)) ? JSON.parse(readFileSync(recordFile(r), "utf8")).entries : null);
  const sessionsOf = (r) => Object.fromEntries((recordsOf(r) ?? []).map((e) => [e.branch, e.sessionId]).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  /** 副作用の確認に使う状態（作業場所・参照・再開の記録・遠隔の参照・GitHub と ssh の呼び出し件数）。 */
  const stateOf = (r) => ({
    worktrees: gitOut(r.dir, "worktree", "list", "--porcelain"),
    refs: gitOut(r.dir, "for-each-ref", "--format=%(refname) %(objectname)"),
    remote: gitOut(r.remote, "for-each-ref", "--format=%(refname) %(objectname)"),
    record: existsSync(recordFile(r)) ? readFileSync(recordFile(r), "utf8") : null,
    ghCalls: ghLogOf(r).length,
    sshCalls: sshLogOf(r).length,
  });

  /** 分岐元 main の一時リポジトリ（origin は GitHub の形。通信は試験用 ssh と偽 gh だけ）。 */
  const newRepo = () => {
    const fx = mkRepoWithRemote({ branch: "main", config: CONFIG });
    repos.push(fx); // 登録を最優先にする（以降の初期化が例外になっても finally で消える）
    const r = { dir: fx.dir, remote: fx.remote, cleanup: fx.cleanup, sshLog: join(sandbox, `ssh-${++seq}.log`), ghLog: join(sandbox, `gh-log-${seq}.log`), gh: null };
    mkdirSync(join(r.dir, ".git", "info"), { recursive: true });
    writeFileSync(join(r.dir, ".git", "info", "exclude"), ".claude/\n", { flag: "a" });
    gitOut(r.dir, "remote", "set-url", "origin", GH_SSH);
    r.gh = ghCfg({});
    writeFileSync(r.sshLog, "");
    writeFileSync(r.ghLog, "");
    return r;
  };
  /** 開発ブランチの作業場所を作り、1 commit する（brw create 相当。brwBase を設定する）。 */
  const startDev = (r, branch) => {
    const wt = join(sandbox, `wt-${++seq}`);
    gitOut(r.dir, "worktree", "add", "-q", "-b", branch, wt);
    gitOut(wt, "config", `branch.${branch}.brwBase`, "main");
    writeFileSync(join(wt, "f.txt"), `${branch} の作業\n`);
    gitOut(wt, "add", "f.txt");
    gitOut(wt, "commit", "-q", "-m", `作業 ${branch}`);
    return { wt, oid: gitOut(wt, "rev-parse", "HEAD") };
  };
  const writeBody = (r, branch) => {
    const p = bodyPathOf(r.dir, branch);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, BODY);
  };
  /** brw pr（片付けつき）を作業場所で実行する。existing が真なら既存の PR を返す経路、偽なら作成の経路。 */
  const prIn = (r, wt, branch, oid, { number, existing, target = [] }) => {
    const routes = {
      [LIST(branch)]: ok(existing ? [prOf(branch, oid, number)] : []),
      [FILTERED(branch)]: ok(existing ? [prOf(branch, oid, number)] : []),
      [POST]: created(prOf(branch, oid, number)),
    };
    return brwIn(wt, r, ["pr", "--title", TITLE, "--completion", DONE, "--verification", VERIFY, ...target], ghCfg(routes));
  };
  const cleanupOfBranch = (r, branch) => localRef(r, branch) === null;

  try {
    const r = newRepo();
    // 1. 片付けつきの brw pr: PR を作成し、作業場所とローカルのブランチが消え、再開の記録が残り、案内が出る
    const foo = startDev(r, "dev/foo");
    writeBody(r, "dev/foo");
    const wtFoo = foo.wt;
    const before1 = stateOf(r);
    const pr1 = prIn(r, wtFoo, "dev/foo", foo.oid, { number: 7, existing: false });
    eq("integration/9.6 片付けつきの brw pr は、PR を作成して終了コード 0 にする", [pr1.status, pr1.stdout.includes("PR を作成しました: https://github.com/acme/app/pull/7"), pr1.stdout.includes("片付けました: `dev/foo`")], [0, true, true]);
    eq("integration/9.6 片付け後、作業場所とローカルのブランチが消え、遠隔のブランチは残る", [existsSync(wtFoo), localRef(r, "dev/foo"), remoteRef(r, "dev/foo") === foo.oid], [false, null, true]);
    const rec1 = recordsOf(r);
    eq("integration/9.6 再開の記録（<共通ディレクトリ>/brw/resume.json）に、ブランチ・PR の URL・時刻が残り、セッションは空", [rec1?.length, rec1?.[0]?.branch, rec1?.[0]?.prUrl, rec1?.[0]?.sessionId, rec1?.[0]?.base, /\.\d{3}Z$/.test(rec1?.[0]?.at ?? "")], [1, "dev/foo", "https://github.com/acme/app/pull/7", null, "main", true]);
    eq("integration/9.6 出力の案内: 続きの再開（brw resume <ブランチ>）・新しい作業（brw create）・本体への cd を示す", [pr1.stdout.includes("続きの再開:"), pr1.stdout.includes("resume dev/foo"), pr1.stdout.includes("brw create"), pr1.stdout.includes(`cd '${r.dir}'`)], [true, true, true, true]);
    eq("integration/9.6 片付けつきの作成は、GitHub への作成の要求が 1 件だけ", postsOf(r).length, 1);

    // 2. PostToolUse（claude 形式・cwd は削除後の本体）: 記録にセッションが付く。別ブランチの記録・別のセッションでは付かない
    const extraRec = writeRecord_(r, "dev/other", null);
    const post = (host, { cwd, command, response, sessionId }) => {
      const ev = hookInput(host, "PostToolUse", { cwd, command, sessionId });
      ev.tool_response = response;
      return hookRun(r, host, "PostToolUse", ev);
    };
    post("claude", { cwd: r.dir, command: `node ${BRW} pr --title ${TITLE}`, response: { stdout: pr1.stdout, stderr: pr1.stderr, interrupted: false }, sessionId: S1 });
    eq("integration/9.6 PostToolUse（claude）: 直近の brw pr の成功で、案内の行のブランチ（dev/foo）の記録にセッションが付き、別ブランチの記録（dev/other）は変わらない", sessionsOf(r), { "dev/foo": S1, "dev/other": null });
    void extraRec;

    // 3. UserPromptSubmit（同じセッション・cwd は本体）: 案内の文脈が返る。別のセッション・24 時間超では出ない。副作用なし
    const ups = (sessionId, cwd = r.dir) => {
      const ev = hookInput("claude", "UserPromptSubmit", { cwd, sessionId });
      delete ev.tool_name;
      delete ev.tool_input;
      ev.prompt = "続きを直してください";
      return hookRun(r, "claude", "UserPromptSubmit", ev);
    };
    const st3 = stateOf(r);
    const u1 = ups(S1);
    const ctx1 = JSON.parse(u1.out || "{}")?.hookSpecificOutput?.additionalContext ?? "";
    eq("integration/9.6 UserPromptSubmit（同じセッション・cwd は本体）: 案内の文脈が返り、resume・create・無視してよい（無視してかまいません）を含む", [ctx1.includes("resume dev/foo"), ctx1.includes("brw"), ctx1.includes("create"), ctx1.includes("無視してかまいません"), ctx1.length <= 500], [true, true, true, true, true]);
    eq("integration/9.6 UserPromptSubmit の前後で、作業場所・参照・再開の記録・遠隔・GitHub と ssh の呼び出しが変わらない", stateOf(r), st3);
    eq("integration/9.6 別のセッションの入力には何も出ない", ups(S2).out, "");
    // 24 時間超の記録は案内の対象にならない（記録の時刻を書き換えて確かめ、元へ戻す）
    const recBefore = readFileSync(recordFile(r), "utf8");
    const aged = JSON.parse(recBefore);
    aged.entries = aged.entries.map((e) => (e.branch === "dev/foo" ? { ...e, at: new Date(Date.now() - 25 * 3600 * 1000).toISOString() } : e));
    writeFileSync(recordFile(r), JSON.stringify(aged));
    eq("integration/9.6 記録が 24 時間を超えたときは、案内が出ない", ups(S1).out, "");
    writeFileSync(recordFile(r), recBefore);

    // 4. brw resume <ブランチ>（本体から）: 作業場所が作り直され、リモートの先端と同じ commit で、追跡設定つき。一覧は出なくなる
    const listBefore = brwIn(r.dir, r, ["resume"]).stdout;
    eq("integration/9.6 brw resume（引数なし）の一覧に、作業場所の無い dev/foo が出る", listBefore.includes("`dev/foo`"), true);
    const res4 = brwIn(r.dir, r, ["resume", "dev/foo"]);
    const wtRe = gitOut(r.dir, "worktree", "list", "--porcelain").split("\n\n").map((b) => b.split("\n")).find((l) => l.includes("branch refs/heads/dev/foo"))?.find((l) => l.startsWith("worktree "))?.slice("worktree ".length) ?? null;
    eq("integration/9.6 brw resume <ブランチ>: 作業場所が作り直され、HEAD はリモートの先端と同じ commit で、追跡ブランチを持つ", [res4.status, wtRe !== null, wtRe ? gitOut(wtRe, "rev-parse", "HEAD") : null, wtRe ? gitOut(wtRe, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}") : null], [0, true, foo.oid, "origin/dev/foo"]);
    eq("integration/9.6 brw resume の後、一覧に dev/foo は出ない（作業場所がある）", brwIn(r.dir, r, ["resume"]).stdout.includes("`dev/foo`"), false);
    // 作業場所が既にある間は、案内は出ない（副作用なし）
    const st4 = stateOf(r);
    eq("integration/9.6 作業場所が既にあるときは、案内が出ない（副作用なし）", [ups(S1).out, stateOf(r)], ["", st4]);

    // 5. 続きの commit と brw pr: 既存の PR を再利用し、PR は増えず（POST なし）、リモートが進み、記録は 1 件のまま置き換わる
    writeFileSync(join(wtRe, "f.txt"), "続きの修正\n");
    gitOut(wtRe, "add", "f.txt");
    gitOut(wtRe, "commit", "-q", "-m", "続きの修正");
    const oid5 = gitOut(wtRe, "rev-parse", "HEAD");
    const postsBefore5 = postsOf(r).length;
    writeBody(r, "dev/foo");
    // 再開後の既定の brw pr: 切り出し元（base）は記録から戻っており、既存の PR を再利用する（POST は増えない）
    writeBody(r, "dev/foo");
    const pr5 = prIn(r, wtRe, "dev/foo", oid5, { number: 7, existing: true });
    eq("integration/9.6 続きの brw pr（既定のまま）: 既存の PR を再利用し（POST が増えない）、終了コード 0 にする", [pr5.status, postsOf(r).length - postsBefore5, pr5.stdout.includes("既存の PR を再利用") && pr5.stdout.includes("https://github.com/acme/app/pull/7")], [0, 0, true]);
    eq("integration/9.6 続きの brw pr: リモートのブランチが続きの commit に進み、dev/foo の記録は 1 件のまま置き換わる（別ブランチの記録は残る）", [remoteRef(r, "dev/foo") === oid5, (recordsOf(r) ?? []).filter((e) => e.branch === "dev/foo").length, sessionsOf(r)], [true, 1, { "dev/foo": null, "dev/other": null }]);
    eq("integration/9.6 続きの brw pr の後、作業場所とローカルのブランチが消える", [existsSync(wtRe), localRef(r, "dev/foo")], [false, null]);
    // 片付けの後にセッションを付け直し、案内が再び出る
    post("claude", { cwd: r.dir, command: `node ${BRW} pr --title ${TITLE}`, response: { stdout: pr5.stdout, stderr: pr5.stderr, interrupted: false }, sessionId: S1 });
    const u5 = JSON.parse(ups(S1).out || "{}")?.hookSpecificOutput?.additionalContext ?? "";
    eq("integration/9.6 再開後の 2 回目の片付けでも、セッションを付け直すと案内が再び出る", [u5.includes("resume dev/foo"), u5.length <= 500], [true, true]);

    // 6. Codex 形式（tool_response は文字列・cwd は本体のまま）: 別ブランチ（dev/bar）の関連付けと案内
    const bar = startDev(r, "dev/bar");
    writeBody(r, "dev/bar");
    const pr6 = prIn(r, bar.wt, "dev/bar", bar.oid, { number: 8, existing: false });
    eq("integration/9.6 2 つ目の開発ブランチ（dev/bar）の片付けつき brw pr が成功する", [pr6.status, pr6.stdout.includes("片付けました: `dev/bar`")], [0, true]);
    post("codex", { cwd: r.dir, command: `node ${BRW} pr --title ${TITLE}`, response: pr6.stdout, sessionId: SC });
    eq("integration/9.6 PostToolUse（Codex・文字列の出力）: dev/bar の記録に付き、dev/foo の記録（S1）は変わらない", sessionsOf(r), { "dev/bar": SC, "dev/foo": S1, "dev/other": null });
    const cx = hookRun(r, "codex", "UserPromptSubmit", (() => { const ev = hookInput("codex", "UserPromptSubmit", { cwd: r.dir, sessionId: SC }); ev.prompt = "続き"; return ev; })());
    const ctxC = JSON.parse(cx.out || "{}")?.hookSpecificOutput?.additionalContext ?? "";
    eq("integration/9.6 UserPromptSubmit（Codex・cwd は本体）: 案内の文脈が返り、dev/bar の resume を指す（500 文字以内）", [ctxC.includes("resume dev/bar"), ctxC.length <= 500], [true, true]);

    // 9.7: PostToolUse が届かない（Claude の Exit code 1 相当）でも、実行前の PreToolUse のメモで記録に sessionId が付き、案内が出る
    const hint = startDev(r, "dev/hint");
    writeBody(r, "dev/hint");
    const SH = "claude-int-hint";
    hookRun(r, "claude", "PreToolUse", hookInput("claude", "PreToolUse", { cwd: hint.wt, command: `node ${BRW} pr --title ${TITLE}`, sessionId: SH }));
    const pr7 = prIn(r, hint.wt, "dev/hint", hint.oid, { number: 9, existing: false });
    eq("integration/9.7 PostToolUse を送らなくても、片付けつきの brw pr は完了する（終了コード 0・片付けの表示）", [pr7.status, pr7.stdout.includes("片付けました: `dev/hint`")], [0, true]);
    eq("integration/9.7 実行前のメモから、片付けの記録に sessionId が付く（PostToolUse は無し）", sessionsOf(r)["dev/hint"] ?? null, SH);
    const u7 = JSON.parse(ups(SH).out || "{}")?.hookSpecificOutput?.additionalContext ?? "";
    eq("integration/9.7 PreToolUse → brw pr（片付け）→ UserPromptSubmit で、案内（resume dev/hint・create）が出る", [u7.includes("resume dev/hint"), u7.includes("create"), u7.length <= 500], [true, true, true]);
    eq("integration/9.7 実行前のメモは、再開の記録の内容を増やさない（記録は、これまでの 4 ブランチ＋今回の 1 件だけ）", (recordsOf(r) ?? []).map((e) => e.branch).sort(), ["dev/bar", "dev/foo", "dev/hint", "dev/other"]);
    // 9.7 回帰: メモと再開の記録の置き場が FIFO でも、brw pr（片付け）は止まらず完了する（タイムアウトつき）
    const fifo = startDev(r, "dev/fifo");
    writeBody(r, "dev/fifo");
    mkdirSync(join(r.dir, ".git", "brw"), { recursive: true });
    const fifoPaths = ["session-hint.json", "resume.json"].map((f) => join(r.dir, ".git", "brw", f));
    for (const pth of fifoPaths) {
      rmSync(pth, { force: true });
      spawnSync("mkfifo", [pth]);
    }
    hookRun(r, "claude", "PreToolUse", hookInput("claude", "PreToolUse", { cwd: fifo.wt, command: `node ${BRW} pr --title ${TITLE}`, sessionId: "claude-int-fifo" }));
    const fres = spawnSync("node", [BRW, "pr", "--title", TITLE, "--completion", DONE, "--verification", VERIFY], {
      cwd: fifo.wt,
      encoding: "utf8",
      env: envOf(r, ghCfg({ [LIST("dev/fifo")]: ok([]), [FILTERED("dev/fifo")]: ok([]), [POST]: created(prOf("dev/fifo", fifo.oid, 10)) })),
      timeout: 60000,
    });
    eq("integration/9.7 回帰: メモと再開の記録の置き場が FIFO でも、brw pr（片付け）は止まらず完了する（終了コード 0・片付けの表示・タイムアウトしない）", [fres.status, fres.signal, fres.stdout.includes("片付けました")], [0, null, true]);
    for (const pth of fifoPaths) rmSync(pth, { force: true });
  } finally {
    for (const x of repos) {
      try { x.cleanup(); } catch { /* 後始末の失敗は試験の結果を変えない */ }
    }
    for (const k of ISO_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    rmSync(sandbox, { recursive: true, force: true });
  }
  // 7. 一時ディレクトリが増えない（この試験の sandbox と fixture を消した後で数える）
  eq("integration/9.6 試験の前後で、brw-fx-*・brw-int-* の一時ディレクトリが増えない", tmpLeftovers().map((n, i) => n - tmpBefore[i]).every((d) => d <= 0), true);
};

// 記録を直接書く（別ブランチの未関連付けの記録を用意する。試験の対象は関連付けの範囲）
function writeRecord_(r, branch, sessionId) {
  const file = join(r.dir, ".git", "brw", "resume.json");
  mkdirSync(dirname(file), { recursive: true });
  const cur = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).entries : [];
  const entry = { branch, prUrl: "https://github.com/acme/app/pull/99", repository: "acme/app", sessionId, at: new Date().toISOString() };
  writeFileSync(file, JSON.stringify({ version: 1, entries: [entry, ...cur.filter((e) => e.branch !== branch)] }));
  return entry;
}
