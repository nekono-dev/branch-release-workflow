// 実環境の標準入出力の端末判定（brw-enforcement 14.2）の引数・記録用スクリプト・判定・整形・計画を、実ホストを呼ばずに確かめる。
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  exitCodeOf, formatReport, hostCommand, judgeTty, launchEnvOf, parseArgs, parseTtyLog, parseTtyLogDetailed, planOf, probeScriptOf, promptOf, setupDir,
} from "./real-env/tty-observe.mjs";
import { cleanupCodexHome } from "./real-env/stop-observe.mjs";

const script = join(dirname(fileURLToPath(import.meta.url)), "real-env/tty-observe.mjs");
const noRealEnv = { ...process.env };
delete noRealEnv.BRW_REAL_ENV;

export const runTtyObserveChecks = async (eq) => {
  // ---- 引数 ----
  eq("tty-observe/14.2 引数の既定は両ホストで実行・実行は本番", parseArgs([]), { host: "both", dryRun: false, help: false, error: null });
  eq("tty-observe/14.2 --host codex と --dry-run を読む", parseArgs(["--host", "codex", "--dry-run"]), { host: "codex", dryRun: true, help: false, error: null });
  eq("tty-observe/14.2 未知のホストは使い方の誤り", parseArgs(["--host", "gemini"]).error !== null, true);
  eq("tty-observe/14.2 未知の引数は使い方の誤り", parseArgs(["--bogus"]).error !== null, true);

  // ---- 記録用スクリプトと作業場所（ホストを呼ばない） ----
  const base = mkdtempSync(join(tmpdir(), "brw-ttyobs-t-"));
  try {
    const fx = setupDir(join(base, "w"));
    eq("tty-observe/14.2 作業場所に記録用スクリプトと記録ファイルの場所を作る（記録ファイル自体は作らない）", [existsSync(fx.probe), existsSync(fx.log)], [true, false]);
    // 記録用スクリプトを直接実行して、端末でない実行（パイプ）の値を記録する
    const direct = spawnSync(process.execPath, [fx.probe, "direct"], { input: "", encoding: "utf8" });
    eq("tty-observe/14.2 記録用スクリプトは終了コード 0 で、モードと両方の isTTY を 1 行記録する", [direct.status, parseTtyLog(readFileSync(fx.log, "utf8")).map((e) => [e.mode, e.stdin, e.stdout])], [0, [["direct", "undefined", "undefined"]]]);
    const pty = spawnSync(process.execPath, [fx.probe, "pty"], { input: "", encoding: "utf8" });
    const logged = parseTtyLog(readFileSync(fx.log, "utf8"));
    eq("tty-observe/14.2 記録は本文（標準入出力の内容）を残さない", [pty.status, logged.length, Object.keys(logged[0]).sort()], [0, 2, ["at", "mode", "stdin", "stdout"]]);

    // ---- 記録の解析・判定 ----
    // 正規の記録（at・mode・stdin・stdout が必須）に、構文エラーの行を 1 つ足す
    const brokenText = `${JSON.stringify({ at: "2026-11-26T10:00:00.000Z", mode: "direct", stdin: "undefined", stdout: "undefined" })}\n{broken\n\n`;
    eq("tty-observe/14.2 壊れた行は記録から外し、件数として数える（空行は数えない）", [parseTtyLogDetailed(brokenText).entries.length, parseTtyLogDetailed(brokenText).broken], [1, 1]);
    const good = [{ at: "2026-11-26T10:00:00.000Z", mode: "direct", stdin: "undefined", stdout: "false" }, { at: "2026-11-26T10:00:01.000Z", mode: "pty", stdin: "true", stdout: "true" }];
    const j1 = judgeTty(good);
    eq("tty-observe/14.2 直接の実行が端末でなく、疑似端末では両方端末なら一致", [j1.verdict, j1.direct.state, j1.pty.state], ["一致", "一致", "一致"]);
    eq("tty-observe/14.2 直接の実行で標準入力が端末なら不一致（成功にしない）", judgeTty([{ mode: "direct", stdin: "true", stdout: "undefined" }, { mode: "pty", stdin: "true", stdout: "true" }]).verdict, "不一致");
    eq("tty-observe/14.2 直接の実行で標準出力が端末なら不一致", judgeTty([{ mode: "direct", stdin: "false", stdout: "true" }, { mode: "pty", stdin: "true", stdout: "true" }]).direct.state, "不一致");
    eq("tty-observe/14.2 疑似端末で端末に見えなければ不一致（確認の前提が崩れた）", judgeTty([{ mode: "direct", stdin: "false", stdout: "false" }, { mode: "pty", stdin: "false", stdout: "true" }]).pty.state, "不一致");
    eq("tty-observe/14.2 記録が無ければ成功にせず未観測", judgeTty([]).verdict, "未観測");
    eq("tty-observe/14.2 疑似端末の記録だけが無いときは未観測（直接の実行だけでは一致と言わない）", judgeTty([good[0]]).verdict, "未観測");
    eq("tty-observe/14.2 不一致は未観測より優先する", judgeTty([{ mode: "direct", stdin: "true", stdout: "true" }]).verdict, "不一致");

    // ---- 記録の形式の検証（構文エラーと形式の不正な行は、正常な行と混ざっても一致にしない。例外を出さない） ----
    // 行の配列を記録の文字列にして、解析・判定まで通す。例外が出たら threw に入れて、期待値の比較で必ず失敗させる。
    const viaLog = (lines, host = { exitCode: 0, timedOut: false }) => {
      try {
        const p = parseTtyLogDetailed(`${lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n")}\n`);
        const j = judgeTty(p.entries, { ...host, broken: p.broken });
        formatReport({ host: "claude", version: "v", at: "t", judged: j, entries: p.entries.length, exitCode: 0, timedOut: false });
        return { broken: p.broken, verdict: j.verdict, exit: exitCodeOf(j) };
      } catch (e) {
        return { threw: String(e) };
      }
    };
    const D = { at: "2026-11-26T10:00:00.000Z", mode: "direct", stdin: "undefined", stdout: "undefined" };
    const P = { at: "2026-11-26T10:00:01.000Z", mode: "pty", stdin: "true", stdout: "true" };
    const without = (o, k) => { const r = { ...o }; delete r[k]; return r; };
    const expectBroken = (label, rec) => eq(`tty-observe/14.2 形式の不正な行（${label}）は正常な 2 行と混ざっても未観測（例外なし・終了コード 1）`, viaLog([D, P, rec]), { broken: 1, verdict: "未観測", exit: 1 });
    expectBroken("{}", {});
    expectBroken("null", null);
    expectBroken("配列", []);
    expectBroken("数値", 5);
    expectBroken("文字列", "x");
    expectBroken("真偽値", true);
    expectBroken("未知のモード", { ...D, mode: "other" });
    expectBroken("at の欠落", without(D, "at"));
    expectBroken("mode の欠落", without(D, "mode"));
    expectBroken("stdin の欠落", without(D, "stdin"));
    expectBroken("stdout の欠落", without(D, "stdout"));
    expectBroken("stdin が真偽値", { ...P, stdin: true });
    expectBroken("stdout が \"1\"", { ...P, stdout: "1" });
    expectBroken("stdin が null", { ...D, stdin: null });
    expectBroken("at が空文字", { ...P, at: "" });
    expectBroken("at が数値", { ...P, at: 5 });
    expectBroken("構文エラー", "{broken");
    // 文字列化で例外になる値・長い値を項目に入れても、例外なく未観測（終了コード 1）になること。
    // 10000 文字の at は空でない文字列として正規に受けるため、例外が出ないことだけを確かめる。
    const LONG = "a".repeat(10000);
    const HOSTILE = [
      ["toString と valueOf が null のオブジェクト", { toString: null, valueOf: null }],
      ["toString が文字列のオブジェクト", { toString: "x" }],
      ["配列", [1, 2]],
      ["ネストしたオブジェクト", { nested: { deep: [1, { x: 1 }] } }],
      ["10000 文字の文字列", LONG],
    ];
    for (const k of ["at", "mode", "stdin", "stdout"]) {
      for (const [label, v] of HOSTILE) {
        const r = viaLog([D, P, { ...P, [k]: v }]);
        if (k === "at" && typeof v === "string") {
          eq(`tty-observe/14.2 at に${label}を入れても例外を出さない（at は空でない文字列として受ける）`, "threw" in r, false);
          continue;
        }
        eq(`tty-observe/14.2 ${k} に${label}を入れても例外なく未観測（終了コード 1）`, r, { broken: 1, verdict: "未観測", exit: 1 });
      }
    }
    eq("tty-observe/14.2 形式の不正な行が複数あれば、その件数を数え、一致にしない", viaLog([D, P, "{broken", {}, null]), { broken: 3, verdict: "未観測", exit: 1 });
    eq("tty-observe/14.2 正規の行に想定外の観測値があれば、形式の不正な行があっても不一致を優先する", viaLog([{ ...D, stdin: "true" }, P, "{broken"]), { broken: 1, verdict: "不一致", exit: 1 });
    eq("tty-observe/14.2 正規の記録の重複は、同じ期待値なら一致のまま", viaLog([D, D, P, P]), { broken: 0, verdict: "一致", exit: 0 });
    eq("tty-observe/14.2 想定外の正規の行を含む重複は不一致（最初の行だけで決めない）", viaLog([D, { ...D, stdout: "true" }, P]).verdict, "不一致");
    eq("tty-observe/14.2 未知の追加項目と空行は許可する（形式の不正としない）", viaLog([{ ...D, extra: "x" }, "", P, "   "]), { broken: 0, verdict: "一致", exit: 0 });
    eq("tty-observe/14.2 形式の不正な行の件数は報告の解析の項目に書く", formatReport({ host: "claude", version: "v", at: "t", judged: judgeTty([D, P], { exitCode: 0, timedOut: false, broken: 1 }), entries: 2, exitCode: 0, timedOut: false }).includes("形式の不正"), true);

    // ---- 同じモードの全記録を判定する（最初の記録だけで決めない） ----
    const okHost = { exitCode: 0, timedOut: false };
    eq("tty-observe/14.2 後続の direct が端末に見えれば不一致（最初の記録だけで一致にしない）", judgeTty([good[0], { mode: "direct", stdin: "true", stdout: "false" }, good[1]], okHost).verdict, "不一致");
    eq("tty-observe/14.2 後続の pty が端末に見えなければ不一致（最初の記録だけで一致にしない）", judgeTty([good[0], good[1], { mode: "pty", stdin: "false", stdout: "true" }], okHost).verdict, "不一致");
    eq("tty-observe/14.2 同じモードの記録が端末の有無で食い違えば不一致", judgeTty([good[0], { mode: "direct", stdin: "true", stdout: "undefined" }, good[1]], okHost).verdict, "不一致");
    eq("tty-observe/14.2 同じモードの記録が揃って想定どおりなら、複数あっても一致", judgeTty([good[0], { ...good[0], at: "x" }, good[1], good[1]], okHost).verdict, "一致");

    // ---- ホストの終了コード・タイムアウト（記録が揃っていても一致にしない） ----
    const j3 = judgeTty(good, { exitCode: 1, timedOut: false });
    eq("tty-observe/14.2 ホストが非ゼロ終了なら、記録が揃っても未観測にし理由に終了コードを書く", [j3.verdict, j3.host.state, j3.host.detail.includes("終了コード 1")], ["未観測", "未観測", true]);
    const j4 = judgeTty(good, { exitCode: -1, timedOut: true });
    eq("tty-observe/14.2 ホストがタイムアウトなら、記録が揃っても未観測にし理由にタイムアウトを書く", [j4.verdict, j4.host.detail.includes("タイムアウト")], ["未観測", true]);
    eq("tty-observe/14.2 ホストの失敗と不一致が同時なら不一致を優先する", judgeTty([{ mode: "direct", stdin: "true", stdout: "true" }, good[1]], { exitCode: 1, timedOut: false }).verdict, "不一致");
    eq("tty-observe/14.2 想定どおりでもホストが正常終了していなければ一致と書かない（報告の総合も未観測）", formatReport({ host: "claude", version: "v", at: "t", judged: j3, entries: 2, exitCode: 1, timedOut: false }).includes("総合: 未観測"), true);
    eq("tty-observe/14.2 終了コードは総合が一致のときだけ 0", [exitCodeOf(judgeTty(good, okHost)), exitCodeOf(j3), exitCodeOf(judgeTty([], okHost))], [0, 1, 1]);

    // ---- 壊れた記録の行（正常な記録が揃っていても一致にしない） ----
    const twoGoodAndBroken = `${JSON.stringify(good[0])}\n${JSON.stringify(good[1])}\n{broken\n`;
    const tb = parseTtyLogDetailed(twoGoodAndBroken);
    const jb = judgeTty(tb.entries, { ...okHost, broken: tb.broken });
    eq("tty-observe/14.2 正常な 2 記録と壊れた行 1 件では一致にせず、未観測と理由に件数を書く", [tb.entries.length, tb.broken, jb.verdict, jb.record.detail.includes("1 件")], [2, 1, "未観測", true]);
    eq("tty-observe/14.2 壊れた行があれば終了コードは 0 にならない", exitCodeOf(jb), 1);
    eq("tty-observe/14.2 壊れた行が無ければ従来どおり一致", judgeTty(parseTtyLogDetailed(`${JSON.stringify(good[0])}\n${JSON.stringify(good[1])}\n`).entries, { ...okHost, broken: 0 }).verdict, "一致");
    eq("tty-observe/14.2 壊れた行は、想定外の記録（不一致）より優先しない", judgeTty([{ mode: "direct", stdin: "true", stdout: "true" }, good[1]], { ...okHost, broken: 1 }).verdict, "不一致");
    eq("tty-observe/14.2 報告に記録の解析（壊れた行の有無）の項目を載せる", formatReport({ host: "claude", version: "v", at: "t", judged: jb, entries: 2, exitCode: 0, timedOut: false }).includes("記録の解析"), true);

    // ---- 整形（既存 README の観測結果に追記できる形） ----
    const report = formatReport({ host: "claude", version: "2.1.329 (Claude Code)", at: "2026-11-26T10:00:00Z", judged: j1, entries: 2, exitCode: 0, timedOut: false });
    eq("tty-observe/14.2 報告はホスト・版・日時を見出しに持ち、判定の語で結果を示す", [report.includes("claude"), report.includes("2.1.329 (Claude Code)"), report.includes("2026-11-26T10:00:00Z"), report.includes("| 一致 |"), report.includes("総合: 一致")], [true, true, true, true, true]);
    const failReport = formatReport({ host: "codex", version: "codex-cli 0.172.0", at: "t", judged: judgeTty([]), entries: 0, exitCode: 124, timedOut: true });
    eq("tty-observe/14.2 記録が無く終了がタイムアウトなら未観測と書き、成功と書かない", failReport.includes("未観測") && failReport.includes("タイムアウト") && !failReport.includes("成功"), true);

    // ---- 呼び出しの形（Codex は信頼のバイパスと CODEX_HOME を使わない） ----
    const cc = hostCommand("claude", { dir: fx.dir, probe: fx.probe });
    eq("tty-observe/14.2 Claude は指定どおりの -p の形で、Bash だけを許可する", [cc.bin, cc.args[0], cc.args[1].startsWith("次の"), cc.args.slice(2)], ["claude", "-p", true, ["--setting-sources", "project", "--permission-mode", "acceptEdits", "--allowedTools", "Bash", "--max-turns", "6", "--no-session-persistence"]]);
    const cx = hostCommand("codex", { dir: fx.dir, probe: fx.probe });
    eq("tty-observe/14.2 Codex は指定どおりの exec の形で、信頼のバイパスを付けない", [cx.bin, cx.args.slice(0, 8), cx.args[8].startsWith("次の"), cx.args.includes("--dangerously-bypass-hook-trust")], ["codex", ["exec", "-C", fx.dir, "-s", "workspace-write", "--skip-git-repo-check", "-c", 'model_reasoning_effort="low"'], true, false]);
    eq("tty-observe/14.2 両ホストの指示は 2 つの記録コマンド（直接と script 経由）を同じ node の形で示す", [promptOf(fx.probe).includes(`node "${fx.probe}" direct`), promptOf(fx.probe).includes(`script -qc 'node "${fx.probe}" pty' /dev/null`)], [true, true]);
    eq("tty-observe/14.2 記録用スクリプトの中身は BRW（scripts/）に依存しない", probeScriptOf(fx.log).includes("scripts/"), false);

    // ---- 計画（ホストを呼ばない） ----
    // ---- Codex の起動環境（利用者の ~/.codex を指さない一時の CODEX_HOME。ホストは呼ばない） ----
    {
      const fakeUser = mkdtempSync(join(tmpdir(), "brw-ttyobs-user-"));
      writeFileSync(join(fakeUser, "auth.json"), "{}");
      const work = join(base, "codexenv");
      const env = launchEnvOf("codex", { base: work, dir: join(work, "main"), userHome: fakeUser });
      const userCodex = join(homedir(), ".codex");
      eq("tty-observe/14.2 Codex の起動環境の CODEX_HOME は作業場所の中の一時ディレクトリを指す", [env.CODEX_HOME.startsWith(work), existsSync(join(env.CODEX_HOME, "config.toml"))], [true, true]);
      eq("tty-observe/14.2 Codex の起動環境の CODEX_HOME は利用者の ~/.codex を指さない", env.CODEX_HOME !== userCodex && !env.CODEX_HOME.startsWith(userCodex), true);
      eq("tty-observe/14.2 Claude の起動環境は CODEX_HOME を上書きしない（既存の環境をそのまま使う）", launchEnvOf("claude", { base: work, dir: join(work, "main"), userHome: fakeUser }).CODEX_HOME === process.env.CODEX_HOME, true);
      cleanupCodexHome(env.CODEX_HOME);
      eq("tty-observe/14.2 後始末で Codex の一時の CODEX_HOME（認証のコピーを含む）を消す", existsSync(env.CODEX_HOME), false);
      rmSync(fakeUser, { recursive: true, force: true });
    }

    const plan = planOf("codex");
    eq("tty-observe/14.2 計画は 1 回の呼び出しと 2 つの判定項目を示す", [plan.calls, plan.items.length], [1, 2]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }

  // ---- 実行の入口（BRW_REAL_ENV が無ければ何もせず終了コード 0） ----
  const none = spawnSync(process.execPath, [script, "--host", "claude"], { encoding: "utf8", env: noRealEnv });
  eq("tty-observe/14.2 BRW_REAL_ENV が無いと説明を出して終了コード 0", [none.status, none.stdout.includes("BRW_REAL_ENV=1")], [0, true]);

  // --dry-run はホストを呼ばず、作業場所・呼び出し回数も作らない
  const dir = mkdtempSync(join(tmpdir(), "brw-ttyobs-env-"));
  try {
    const dry = spawnSync(process.execPath, [script, "--dry-run"], { encoding: "utf8", env: { ...process.env, BRW_REAL_ENV: "1", BRW_REAL_ENV_DIR: dir } });
    eq("tty-observe/14.2 --dry-run は計画を出し、呼び出し回数も作業場所も作らない", [dry.status, dry.stdout.includes("claude"), dry.stdout.includes("codex"), existsSync(join(dir, "events")), existsSync(join(dir, "tty-observe"))], [0, true, true, false, false]);
    const bad = spawnSync(process.execPath, [script, "--host", "x"], { encoding: "utf8", env: { ...process.env, BRW_REAL_ENV: "1", BRW_REAL_ENV_DIR: dir } });
    eq("tty-observe/14.2 引数の誤りは終了コード 2", bad.status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
