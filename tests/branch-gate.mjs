// ゲート（brw-branch-gate）の契約試験。selftest.mjs から呼ばれる。後続のタスクも、この関数に試験を追記する。
import { guidance } from "../scripts/branch-gate.mjs";

const BASE = {
  outcome: "置き換え",
  conclusion: "ブランチ作成を BRW の作成に置き換えました",
  commands: ["cd '/repo' && node 'brw.mjs' create 'dev/foo'"],
  workdir: "/repo/.claude/worktrees/dev-foo",
  notes: "作業場所を新しい worktree に移しました。\n続けて、この worktree で作業してください。",
};

// 特定の呼び出し側の語。案内の文面に入ってはならない
const CALLER_WORDS = /cc-sdd|kiro|\.kiro/i;

export const runBranchGateChecks = async (eq) => {
  const text = guidance(BASE);
  const lines = text.split("\n");

  // ---- 書式の各行 ----
  eq("brw-branch-gate/4.2 案内は結論・見出し・次のコマンド・作業場所の行を決まった順で持つ", [
    lines[0], lines[1], lines[2], lines[3],
  ], [
    "[branch-release-workflow] ブランチ作成を BRW の作成に置き換えました",
    "BRW 案内: 置き換え",
    "次のコマンド: cd '/repo' && node 'brw.mjs' create 'dev/foo'",
    "作業場所: /repo/.claude/worktrees/dev-foo",
  ]);
  eq("brw-branch-gate/4.3 見出しの後の本文に、理由と次の手順の文章が続く", lines.slice(4), [
    "作業場所を新しい worktree に移しました。",
    "続けて、この worktree で作業してください。",
  ]);
  eq("brw-branch-gate/4.1 拒否の案内は種別の行が「拒否」になる", guidance({ ...BASE, outcome: "拒否", workdir: null }).split("\n")[1], "BRW 案内: 拒否");

  // ---- 作業場所 ----
  eq("brw-branch-gate/4.2 作業場所が無いときは「-」を書く", guidance({ ...BASE, workdir: null }).split("\n")[3], "作業場所: -");
  eq("brw-branch-gate/4.2 作業場所が空文字でも「-」を書く", guidance({ ...BASE, workdir: "" }).split("\n")[3], "作業場所: -");

  // ---- 2 手の案内 ----
  eq("brw-branch-gate/2.5 2 手の案内は「1) …」「2) …」の順で 1 行に並ぶ", guidance({
    ...BASE,
    outcome: "拒否",
    commands: ["brw create 'my-task'", "EnterWorktree の path に /repo/.claude/worktrees/my-task を指定する"],
    workdir: null,
  }).split("\n")[2], "次のコマンド: 1) brw create 'my-task' 2) EnterWorktree の path に /repo/.claude/worktrees/my-task を指定する");
  eq("brw-branch-gate/4.1 コマンドが 0 件や 3 件以上のときは組み立てずに止める", [
    (() => { try { guidance({ ...BASE, commands: [] }); return "no-throw"; } catch { return "throw"; } })(),
    (() => { try { guidance({ ...BASE, commands: ["a", "b", "c"] }); return "no-throw"; } catch { return "throw"; } })(),
  ], ["throw", "throw"]);

  eq("brw-branch-gate/4.3 本文（理由と次の手順）が空の案内は組み立てない", (() => { try { guidance({ ...BASE, notes: "  " }); return "no-throw"; } catch { return "throw"; } })(), "throw");

  // ---- 同じ入力は同じ文面 ----
  eq("brw-branch-gate/4.5 同じ入力には毎回同じ文面を返す", [guidance(BASE) === guidance({ ...BASE }), guidance(BASE) === text], [true, true]);

  // ---- 特定の呼び出し側の語を含まない ----
  const kinds = [
    BASE,
    { ...BASE, outcome: "拒否", workdir: null },
    { ...BASE, outcome: "拒否", commands: ["brw create 'x'", "EnterWorktree で入る"], workdir: null },
  ];
  eq("brw-branch-gate/4.4 どの種別の案内にも特定の呼び出し側の語を含まない", kinds.map((k) => CALLER_WORDS.test(guidance(k))), [false, false, false]);

  // ---- 資格情報らしい値は伏せる ----
  const secret = guidance({
    ...BASE,
    conclusion: "https://user:topsecret@example.com/x を使う",
    notes: "token は ghp_abcdefgh12345678 です。\n次の行",
  });
  eq("brw-branch-gate/4.1 資格情報らしい値を伏せ、改行を保つ", [
    secret.includes("topsecret"), secret.includes("ghp_abcdefgh12345678"),
    secret.includes("https://***@example.com/x"), secret.includes("***"),
    secret.split("\n").length,
  ], [false, false, true, true, 6]);

  // ---- 次のコマンドと作業場所は、空白や長さを変えずに出す（そのまま実行できること） ----
  const spaced = "cd '/repo  name' && node 'brw.mjs' create 'dev/foo'";
  eq("brw-branch-gate/4.1 引用符内の連続空白を保ったコマンドを出す", guidance({ ...BASE, commands: [spaced] }).split("\n")[2], `次のコマンド: ${spaced}`);
  const long = `echo '${"x".repeat(600)}'`;
  eq("brw-branch-gate/4.1 500 文字を超えるコマンドを切らずに出す", guidance({ ...BASE, commands: [long] }).split("\n")[2], `次のコマンド: ${long}`);
  eq("brw-branch-gate/4.2 作業場所の連続空白を保つ", guidance({ ...BASE, workdir: "/repo/a  b" }).split("\n")[3], "作業場所: /repo/a  b");

  // ---- 空・空白だけのコマンドは組み立てない（件数の検査と同じ扱い） ----
  eq("brw-branch-gate/4.1 空・空白だけのコマンドは例外にする", [
    (() => { try { guidance({ ...BASE, commands: [""] }); return "no-throw"; } catch { return "throw"; } })(),
    (() => { try { guidance({ ...BASE, commands: ["  "] }); return "no-throw"; } catch { return "throw"; } })(),
  ], ["throw", "throw"]);

  // ---- コマンドの資格情報らしい値は伏せ、空白は保つ ----
  const cmdSecret = guidance({
    ...BASE,
    commands: ["git clone 'https://user:topsecret@example.com/a  b.git' && echo ghp_abcdefgh12345678"],
  }).split("\n")[2];
  eq("brw-branch-gate/4.1 コマンドの資格情報らしい値を伏せ、空白は保つ", [
    cmdSecret.includes("topsecret"), cmdSecret.includes("ghp_abcdefgh12345678"),
    cmdSecret.includes("https://***@example.com/a  b.git"), cmdSecret.includes("***"),
  ], [false, false, true, true]);

  // ---- 改行を含むコマンド・作業場所は組み立てない（固定書式の 1 行の契約を守る） ----
  const throws = (fn) => { try { fn(); return "no-throw"; } catch { return "throw"; } };
  eq("brw-branch-gate/4.2 コマンドの要素に改行（\\n・\\r）を含むと例外にする", [
    throws(() => guidance({ ...BASE, commands: ["cd '/repo' &&\nnode 'brw.mjs' create 'dev/foo'"] })),
    throws(() => guidance({ ...BASE, commands: ["brw create 'x'\r"] })),
    throws(() => guidance({ ...BASE, outcome: "拒否", commands: ["brw create 'x'", "EnterWorktree\nで入る"], workdir: null })),
  ], ["throw", "throw", "throw"]);
  eq("brw-branch-gate/4.2 作業場所に改行（\\n・\\r）を含むと例外にする", [
    throws(() => guidance({ ...BASE, workdir: "/repo/a\nb" })),
    throws(() => guidance({ ...BASE, workdir: "/repo/a\rb" })),
  ], ["throw", "throw"]);
};
