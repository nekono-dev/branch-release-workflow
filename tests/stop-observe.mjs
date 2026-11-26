// 実環境の Stop 観測（brw-enforcement 14.1）の引数・記録フック・判定・整形を、実ホストを呼ばずに確かめる。
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatReport, hostCommand, judgeStops, parseArgs, parseStopLog, planOf, prepareCodexHome, setupRepos,
} from "./real-env/stop-observe.mjs";

const script = join(dirname(fileURLToPath(import.meta.url)), "real-env/stop-observe.mjs");
const noRealEnv = { ...process.env };
delete noRealEnv.BRW_REAL_ENV;

export const runStopObserveChecks = async (eq) => {
  // ---- 引数 ----
  eq("stop-observe/14.1 引数の既定は両ホストで実行・実行は本番", parseArgs([]), { host: "both", dryRun: false, help: false, error: null });
  eq("stop-observe/14.1 --host claude と --dry-run を読む", parseArgs(["--host", "claude", "--dry-run"]), { host: "claude", dryRun: true, help: false, error: null });
  eq("stop-observe/14.1 未知のホストは使い方の誤り", parseArgs(["--host", "gemini"]).error !== null, true);
  eq("stop-observe/14.1 未知の引数は使い方の誤り", parseArgs(["--bogus"]).error !== null, true);
  eq("stop-observe/14.1 --help は説明を出す指定", parseArgs(["--help"]).help, true);

  // ---- 一時リポジトリ（作業の記録が無い・worktree へ移る形） ----
  const base = mkdtempSync(join(tmpdir(), "brw-stopobs-t-"));
  try {
    const fx = setupRepos(join(base, "claude"), "claude");
    const fxCodex = setupRepos(join(base, "codex"), "codex");
    eq("stop-observe/14.1 本体と worktree の作業ツリーは初期状態で clean", [
      execFileSync("git", ["status", "--porcelain"], { cwd: fx.main, encoding: "utf8" }),
      execFileSync("git", ["status", "--porcelain"], { cwd: fx.worktree, encoding: "utf8" }),
    ], ["", ""]);
    eq("stop-observe/14.1 作業の記録（.git/brw）を作らない", [existsSync(join(fx.main, ".git", "brw")), existsSync(join(fx.worktree, ".git"))], [false, true]);
    // PoC（poc/claude-stop-cwd.sh）と同じく、worktree は本体の .claude/worktrees の下に置く。
    // 作業ディレクトリが本体の外へ出ると Claude の Bash は cd を引き継がないため、この配置が前提になる。
    eq("stop-observe/14.1 worktree は本体の .claude/worktrees の下に置く（PoC と同じ配置）", fx.worktree, join(fx.main, ".claude", "worktrees", "wt"));
    eq("stop-observe/14.1 フックの登録は本体の追跡対象外（info/exclude）で、本体は clean のまま", [
      spawnSync("git", ["check-ignore", "-q", ".claude/settings.json"], { cwd: fx.main }).status,
      spawnSync("git", ["check-ignore", "-q", ".codex/hooks.json"], { cwd: fxCodex.main }).status,
    ], [0, 0]);

    // ---- 記録フック（ホストを呼ばず、同じ入力で直接実行する） ----
    const logFile = fx.log;
    const hookPath = fx.hook;
    const fire = (cwd, active) => spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify({ session_id: "s1", hook_event_name: "Stop", cwd, stop_hook_active: active }), encoding: "utf8",
    });
    writeFileSync(join(fx.worktree, "new.txt"), "hi\n");
    const first = fire(fx.worktree, false);
    eq("stop-observe/14.1 記録フックは未コミットの変更で 1 回目を block する", JSON.parse(first.stdout).decision, "block");
    const second = fire(fx.worktree, true);
    eq("stop-observe/14.1 記録フックは stop_hook_active:true では block しない（応答なし）", second.stdout, "");
    const clean = fire(fx.main, false);
    // 全 worktree を走査する: Stop の cwd が clean な本体でも、別の worktree に未コミットの変更があれば block する（Codex は cwd が本体のまま）
    eq("stop-observe/14.1 記録フックは cwd が clean な本体でも、別の worktree の未コミットで block する", [JSON.parse(clean.stdout).decision, JSON.parse(readFileSync(logFile, "utf8").trim().split("\n").pop()).dirtyCwd], ["block", false]);
    rmSync(join(fx.worktree, "new.txt"));
    eq("stop-observe/14.1 記録フックはすべての worktree が clean なら block しない", fire(fx.main, false).stdout, "");
    writeFileSync(join(fx.worktree, "new.txt"), "hi\n");
    const entries = parseStopLog(readFileSync(logFile, "utf8"));
    eq("stop-observe/14.1 記録は cwd・stop_hook_active・dirty・block を持ち、本文を残さない", [entries.length, entries[0].cwd, entries[0].stop_hook_active, entries[0].dirty, entries[0].block, "last_assistant_message" in entries[0]], [4, fx.worktree, false, true, true, false]);

    // ---- 判定 ----
    const W = fx.worktree;
    const ok2 = [{ stop_hook_active: false, block: true, cwd: W }, { stop_hook_active: true, block: false, cwd: W }];
    const j1 = judgeStops(ok2, { worktree: W });
    eq("stop-observe/14.1 block の後に再入で通れば一致。cwd の追従は情報として記録する", [j1.verdict, j1.blockThenPass.state, j1.cwdFollowsWorktree.state], ["一致", "一致", "情報"]);
    eq("stop-observe/14.1 記録が無ければ成功にせず未観測", judgeStops([], { worktree: W }).verdict, "未観測");
    eq("stop-observe/14.1 1 回目が block されなければ不一致（成功にしない）", judgeStops([{ stop_hook_active: false, block: false, cwd: W }, { stop_hook_active: true, block: false, cwd: W }], { worktree: W }).blockThenPass.state, "不一致");
    eq("stop-observe/14.1 2 回目が無ければ再入の確認は未観測", judgeStops([{ stop_hook_active: false, block: true, cwd: W }], { worktree: W }).blockThenPass.state, "未観測");
    eq("stop-observe/14.1 再入でまた block されたら不一致", judgeStops([{ stop_hook_active: false, block: true, cwd: W }, { stop_hook_active: true, block: true, cwd: W }], { worktree: W }).blockThenPass.state, "不一致");
    const main = fx.main;
    const j2 = judgeStops(ok2.map((e) => ({ ...e, cwd: main })), { worktree: W });
    eq("stop-observe/14.1 cwd が本体のままでも、block と再入が観測できれば一致（追従しない旨を情報に書く）", [j2.cwdFollowsWorktree.detail.includes("worktree ではなかった"), j2.verdict], [true, "一致"]);
    const link = join(base, "wt-link");
    symlinkSync(W, link);
    eq("stop-observe/14.1 cwd の比較は実パスで行う（シンボリックリンク経由でも一致）", judgeStops(ok2.map((e) => ({ ...e, cwd: link })), { worktree: realpathSync(W) }).cwdFollowsWorktree.detail.includes("追従した"), true);

    // ---- 整形（既存 README の観測結果に追記できる形） ----
    const report = formatReport({
      host: "claude", version: "2.1.329 (Claude Code)", at: "2026-11-26T10:00:00Z", judged: j1, entries: ok2.length, exitCode: 0, timedOut: false,
    });
    eq("stop-observe/14.1 報告はホスト・版・日時を見出しに持つ", [report.includes("claude"), report.includes("2.1.329 (Claude Code)"), report.includes("2026-11-26T10:00:00Z")], [true, true, true]);
    eq("stop-observe/14.1 報告は判定の語（一致・不一致・未観測）だけで結果を示す", report.includes("| 一致 |") && !report.includes("成功"), true);
    const failReport = formatReport({
      host: "codex", version: "codex-cli 0.172.0", at: "2026-11-26T10:00:00Z", judged: judgeStops([{ stop_hook_active: false, block: false, cwd: main }], { worktree: W }), entries: 1, exitCode: 0, timedOut: false,
    });
    eq("stop-observe/14.1 想定と違う結果は不一致と書き、成功と書かない", failReport.includes("不一致") && !failReport.includes("一致（想定どおり）"), true);
    const unobs = formatReport({ host: "codex", version: "codex-cli 0.172.0", at: "t", judged: judgeStops([], { worktree: W }), entries: 0, exitCode: 124, timedOut: true });
    eq("stop-observe/14.1 タイムアウトで記録が無いときは未観測と書く", unobs.includes("未観測") && unobs.includes("タイムアウト"), true);

    // ---- 呼び出しの形 ----
    const cc = hostCommand("claude", { main: fx.main, worktree: W });
    eq("stop-observe/14.1 Claude は project の設定だけを読み、バイパス指定を付けない", [cc.bin, cc.args.includes("--setting-sources"), cc.args[cc.args.indexOf("--setting-sources") + 1], cc.args.includes("--dangerously-bypass-hook-trust")], ["claude", true, "project", false]);
    const cx = hostCommand("codex", { main: fx.main, worktree: W });
    // 一時の CODEX_HOME: プロジェクトの信頼を config.toml に書き、認証は読み取り用のリンクで見せる（利用者の ~/.codex は書き換えない）
    {
      const fakeUser = mkdtempSync(join(tmpdir(), "brw-user-codex-"));
      writeFileSync(join(fakeUser, "auth.json"), "{}");
      const base2 = mkdtempSync(join(tmpdir(), "brw-codexhome-"));
      const ch = prepareCodexHome(base2, "/tmp/proj", fakeUser);
      eq("stop-observe/14.1 一時の CODEX_HOME はプロジェクトの信頼を書き、認証へのリンクを持つ", [readFileSync(join(ch.home, "config.toml"), "utf8"), realpathSync(ch.link) === realpathSync(join(fakeUser, "auth.json"))], ['[projects."/tmp/proj"]\ntrust_level = "trusted"\n', true]);
      const empty = mkdtempSync(join(tmpdir(), "brw-user-codex-"));
      eq("stop-observe/14.1 認証ファイルが無ければリンクを作らない", prepareCodexHome(mkdtempSync(join(tmpdir(), "brw-codexhome-")), "/tmp/proj", empty).link, null);
      eq("stop-observe/14.1 Codex の起動に -c のプロジェクト信頼は使わない", hostCommand("codex", { main: fx.main, worktree: W }).args.some((a) => String(a).includes("trust_level")), false);
      for (const d of [fakeUser, base2, empty]) rmSync(d, { recursive: true, force: true });
    }
    eq("stop-observe/14.1 Codex はフックの信頼のバイパスを 1 回の呼び出しに 1 つだけ付ける", [cx.bin, cx.args.filter((a) => a === "--dangerously-bypass-hook-trust").length], ["codex", 1]);
    eq("stop-observe/14.1 Codex は本体の作業ディレクトリで開始する", cx.args[cx.args.indexOf("-C") + 1], fx.main);
    eq("stop-observe/14.1 プロンプトは worktree への移動を指示する", [cc.args.some((a) => a.includes(W)), cx.args.some((a) => a.includes(W))], [true, true]);

    // ---- 計画（ホストを呼ばない） ----
    const plan = planOf("claude", { main: fx.main, worktree: W });
    eq("stop-observe/14.1 計画は 1 回の呼び出しと 2 つの判定項目を示す", [plan.calls, plan.items.length], [1, 2]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }

  // ---- 実行の入口（BRW_REAL_ENV が無ければ何もせず終了コード 0） ----
  const none = spawnSync(process.execPath, [script, "--host", "claude"], { encoding: "utf8", env: noRealEnv });
  eq("stop-observe/14.1 BRW_REAL_ENV が無いと説明を出して終了コード 0", [none.status, none.stdout.includes("BRW_REAL_ENV=1")], [0, true]);

  // --dry-run はホストを呼ばず、作業場所も作らない
  const dir = mkdtempSync(join(tmpdir(), "brw-stopobs-env-"));
  try {
    const dry = spawnSync(process.execPath, [script, "--dry-run"], { encoding: "utf8", env: { ...process.env, BRW_REAL_ENV: "1", BRW_REAL_ENV_DIR: dir } });
    eq("stop-observe/14.1 --dry-run は計画を出し、呼び出し回数も作業場所も作らない", [dry.status, dry.stdout.includes("claude"), dry.stdout.includes("codex"), existsSync(join(dir, "events")), existsSync(join(dir, "stop-observe"))], [0, true, true, false, false]);
    const bad = spawnSync(process.execPath, [script, "--host", "x"], { encoding: "utf8", env: { ...process.env, BRW_REAL_ENV: "1", BRW_REAL_ENV_DIR: dir } });
    eq("stop-observe/14.1 引数の誤りは終了コード 2", bad.status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
