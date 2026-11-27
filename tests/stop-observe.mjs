// 実環境の Stop 観測（brw-enforcement 14.1）の引数・記録フック・判定・整形を、実ホストを呼ばずに確かめる。
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanupCodexHome, formatReport, hostCommand, judgeStops, parseArgs, parseStopLog, parseStopLogDetailed, planOf, prepareCodexHome, setupRepos,
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
    // 正規の記録（hookScriptOf が書く行と同じ項目・型）。判定の試験用データはこれに揃える
    const canon = (o = {}) => ({ at: "2026-11-26T10:00:00.000Z", host: "claude", event: "Stop", session_id: "s1", cwd: W, stop_hook_active: false, dirty: true, dirtyCwd: true, scanned: 2, block: true, note: null, ...o });
    const again = (o = {}) => canon({ stop_hook_active: true, block: false, ...o });
    const ok2 = [canon(), again()];
    const j1 = judgeStops(ok2, { worktree: W });
    eq("stop-observe/14.1 block の後に再入で通れば一致。cwd の追従は情報として記録する", [j1.verdict, j1.blockThenPass.state, j1.cwdFollowsWorktree.state], ["一致", "一致", "情報"]);
    eq("stop-observe/14.1 記録が無ければ成功にせず未観測", judgeStops([], { worktree: W }).verdict, "未観測");
    const brokenStop = `${JSON.stringify(canon())}\n${JSON.stringify(again())}\n{broken\n`;
    const bs = parseStopLogDetailed(brokenStop);
    eq("stop-observe/14.1 壊れた行は記録から外して件数に数える", [bs.entries.length, bs.broken], [2, 1]);
    eq("stop-observe/14.1 正常な 2 記録と壊れた行 1 件では一致にせず、未観測にする", judgeStops(bs.entries, { worktree: W, broken: bs.broken }).verdict, "未観測");
    eq("stop-observe/14.1 壊れた行が無ければ同じ記録は一致（比較の対照）", judgeStops(bs.entries, { worktree: W, broken: 0 }).verdict, "一致");
    eq("stop-observe/14.1 報告に記録の解析（壊れた行の有無）の項目を載せる", formatReport({ host: "claude", version: "v", at: "t", judged: judgeStops(bs.entries, { worktree: W, broken: bs.broken }), entries: 2, exitCode: 0, timedOut: false }).includes("記録の解析"), true);
    eq("stop-observe/14.1 1 回目が block されなければ不一致（成功にしない）", judgeStops([canon({ block: false }), again()], { worktree: W }).blockThenPass.state, "不一致");
    eq("stop-observe/14.1 2 回目が無ければ再入の確認は未観測", judgeStops([canon()], { worktree: W }).blockThenPass.state, "未観測");
    eq("stop-observe/14.1 再入でまた block されたら不一致", judgeStops([canon(), again({ block: true })], { worktree: W }).blockThenPass.state, "不一致");

    // ---- 記録の形式の検証（行単位。形式の不正な行は解析できない行として数え、正常な行と混ざっても一致にしない。例外を出さない） ----
    // 行の配列を記録の文字列にして、解析・判定まで通す。例外が出たら threw に入れて、期待値の比較で必ず失敗させる。
    const viaStop = (lines) => {
      try {
        const p = parseStopLogDetailed(`${lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n")}\n`);
        const j = judgeStops(p.entries, { worktree: W, broken: p.broken });
        formatReport({ host: "claude", version: "v", at: "t", judged: j, entries: p.entries.length, exitCode: 0, timedOut: false });
        return { broken: p.broken, verdict: j.verdict, exit: j.verdict === "一致" ? 0 : 1 };
      } catch (e) {
        return { threw: String(e) };
      }
    };
    const without = (o, k) => { const r = { ...o }; delete r[k]; return r; };
    const expectBroken = (label, rec) => eq(`stop-observe/14.1 形式の不正な行（${label}）は正常な 2 行と混ざっても未観測（例外なし・終了コード 1）`, viaStop([canon(), again(), rec]), { broken: 1, verdict: "未観測", exit: 1 });
    expectBroken("{}", {});
    expectBroken("null", null);
    expectBroken("配列", []);
    expectBroken("数値", 5);
    expectBroken("真偽値", true);
    expectBroken("構文エラー", "{broken");
    for (const k of Object.keys(canon())) expectBroken(`${k} の欠落`, without(canon(), k));
    expectBroken("host が未知の値", canon({ host: "gemini" }));
    expectBroken("dirty が文字列", canon({ dirty: "true" }));
    expectBroken("dirtyCwd が数値", canon({ dirtyCwd: 1 }));
    expectBroken("scanned が負", canon({ scanned: -1 }));
    expectBroken("scanned が小数", canon({ scanned: 1.5 }));
    expectBroken("scanned が文字列", canon({ scanned: "2" }));
    expectBroken("note が未知の値", canon({ note: "other" }));
    expectBroken("event が数値", canon({ event: 5 }));
    expectBroken("session_id が数値", canon({ session_id: 5 }));
    expectBroken("cwd が数値", canon({ cwd: 5 }));
    expectBroken("at が空文字", canon({ at: "" }));
    expectBroken("stop_hook_active が文字列", canon({ stop_hook_active: "false" }));
    // 再入行の block の欠落・型違いは、成功扱いにせず未観測にする（回帰）
    eq("stop-observe/14.1 再入行の block が欠けていれば一致にせず未観測（回帰）", viaStop([canon(), without(again(), "block")]), { broken: 1, verdict: "未観測", exit: 1 });
    eq("stop-observe/14.1 再入行の block が文字列なら一致にせず未観測（回帰）", viaStop([canon(), again({ block: "false" })]), { broken: 1, verdict: "未観測", exit: 1 });
    eq("stop-observe/14.1 再入行の stop_hook_active が文字列なら一致にしない", viaStop([canon(), again({ stop_hook_active: "true" })]).verdict !== "一致", true);
    eq("stop-observe/14.1 最初の行の block が文字列なら一致にしない", viaStop([canon({ block: "true" }), again()]).verdict !== "一致", true);
    // 文字列化で例外になる値・長い値を各項目に入れても、例外なく未観測（終了コード 1）になること。
    // 文字列を受ける項目（at・event・session_id・cwd）の長い文字列は正規に受けるため、例外が出ないことだけを確かめる。
    const LONG = "a".repeat(10000);
    const HOSTILE = [
      ["toString と valueOf が null のオブジェクト", { toString: null, valueOf: null }],
      ["toString が文字列のオブジェクト", { toString: "x" }],
      ["配列", [1, 2]],
      ["ネストしたオブジェクト", { nested: { deep: [1, { x: 1 }] } }],
      ["10000 文字の文字列", LONG],
    ];
    const STRING_OK = ["at", "event", "session_id", "cwd"];
    for (const k of Object.keys(canon())) {
      for (const [label, v] of HOSTILE) {
        const r = viaStop([canon(), again(), { ...canon(), [k]: v }]);
        if (STRING_OK.includes(k) && typeof v === "string") {
          eq(`stop-observe/14.1 ${k} に${label}を入れても例外を出さない（文字列を受ける項目）`, "threw" in r, false);
          continue;
        }
        eq(`stop-observe/14.1 ${k} に${label}を入れても例外なく未観測（終了コード 1）`, r, { broken: 1, verdict: "未観測", exit: 1 });
      }
    }
    eq("stop-observe/14.1 形式の不正な行が複数ある混在は、件数を数えて一致にしない", viaStop([canon(), again(), "{broken", {}, null]), { broken: 3, verdict: "未観測", exit: 1 });
    eq("stop-observe/14.1 cwd が null の正規の行は形式の不正としない（情報の扱い）", viaStop([canon({ cwd: null }), again({ cwd: null })]), { broken: 0, verdict: "一致", exit: 0 });
    eq("stop-observe/14.1 未知の追加項目と空行は許可する（形式の不正としない）", viaStop([{ ...canon(), extra: "x" }, "", again(), "   "]), { broken: 0, verdict: "一致", exit: 0 });
    eq("stop-observe/14.1 形式の不正な行の件数は報告の解析の項目に書く", formatReport({ host: "claude", version: "v", at: "t", judged: judgeStops([canon(), again()], { worktree: W, broken: 1 }), entries: 2, exitCode: 0, timedOut: false }).includes("形式の不正"), true);
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
      host: "codex", version: "codex-cli 0.172.0", at: "2026-11-26T10:00:00Z", judged: judgeStops([canon({ block: false, cwd: main })], { worktree: W }), entries: 1, exitCode: 0, timedOut: false,
    });
    eq("stop-observe/14.1 想定と違う結果は不一致と書き、成功と書かない", failReport.includes("不一致") && !failReport.includes("一致（想定どおり）"), true);
    const unobs = formatReport({ host: "codex", version: "codex-cli 0.172.0", at: "t", judged: judgeStops([], { worktree: W }), entries: 0, exitCode: 124, timedOut: true });
    eq("stop-observe/14.1 タイムアウトで記録が無いときは未観測と書く", unobs.includes("未観測") && unobs.includes("タイムアウト"), true);

    // ---- 呼び出しの形 ----
    const cc = hostCommand("claude", { main: fx.main, worktree: W });
    eq("stop-observe/14.1 Claude は project の設定だけを読み、バイパス指定を付けない", [cc.bin, cc.args.includes("--setting-sources"), cc.args[cc.args.indexOf("--setting-sources") + 1], cc.args.includes("--dangerously-bypass-hook-trust")], ["claude", true, "project", false]);
    const cx = hostCommand("codex", { main: fx.main, worktree: W });
    // 一時の CODEX_HOME: プロジェクトの信頼を config.toml に書き、認証は利用者の auth.json の一時のコピーで見せる（利用者の ~/.codex は書き換えない）
    {
      // 認証は利用者の auth.json のコピーにする（リンクにしない）。偽の userHome で、利用者のファイルが変わらないことを確かめる
      const fakeUser = mkdtempSync(join(tmpdir(), "brw-user-codex-"));
      const userAuth = join(fakeUser, "auth.json");
      writeFileSync(userAuth, '{"token":"利用者の値"}');
      const hashOf = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
      const userHash = hashOf(userAuth);
      const base2 = mkdtempSync(join(tmpdir(), "brw-codexhome-"));
      const ch = prepareCodexHome(base2, "/tmp/proj", fakeUser);
      eq("stop-observe/14.1 一時の CODEX_HOME はプロジェクトの信頼を書く", readFileSync(join(ch.home, "config.toml"), "utf8"), '[projects."/tmp/proj"]\ntrust_level = "trusted"\n');
      eq("stop-observe/14.1 認証は利用者の auth.json のコピーで、リンクではない（コピーは 0600、一時の CODEX_HOME は 0700）", [lstatSync(ch.auth).isSymbolicLink(), readFileSync(ch.auth, "utf8"), (statSync(ch.auth).mode & 0o777).toString(8), (statSync(ch.home).mode & 0o777).toString(8)], [false, '{"token":"利用者の値"}', "600", "700"]);
      // 一時のコピーへの書き込み（トークン更新の模擬）が、利用者の auth.json に及ばないこと
      writeFileSync(ch.auth, '{"token":"更新後"}');
      eq("stop-observe/14.1 一時のコピーへ書いても利用者の auth.json は変わらない（ハッシュが同じ）", hashOf(userAuth), userHash);
      cleanupCodexHome(ch.home);
      eq("stop-observe/14.1 後始末で一時の CODEX_HOME（auth.json のコピーを含む）を消し、利用者の auth.json は残って変わらない", [existsSync(ch.home), existsSync(ch.auth), hashOf(userAuth) === userHash], [false, false, true]);
      const base3 = mkdtempSync(join(tmpdir(), "brw-codexhome-"));
      const empty = mkdtempSync(join(tmpdir(), "brw-user-codex-"));
      const none = prepareCodexHome(base3, "/tmp/proj", empty);
      eq("stop-observe/14.1 認証ファイルが無ければコピーを作らない", none.auth, null);
      eq("stop-observe/14.1 Codex の起動に -c のプロジェクト信頼は使わない", hostCommand("codex", { main: fx.main, worktree: W }).args.some((a) => String(a).includes("trust_level")), false);
      for (const d of [fakeUser, base2, base3, empty]) rmSync(d, { recursive: true, force: true });
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
