// ゲート（brw-branch-gate）の契約試験。selftest.mjs から呼ばれる。後続のタスクも、この関数に試験を追記する。
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gatherFacts, guidance, planGate, shellQuote } from "../scripts/branch-gate.mjs";
import { classifyCommand } from "../scripts/operation-policy.mjs";
import { normalizeConfig } from "../scripts/lib.mjs";

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

  await runPlanGateChecks(eq);
};

// ---- 置き換えの計画（planGate）・引用（shellQuote）・git の状態（gatherFacts）の試験 ----
const BRW = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "brw.mjs");
const ROOT = mkdtempSync(join(tmpdir(), "brw-gate-plan-"));
// 操作の作業ディレクトリが本体と違う場合（サブディレクトリ）の試験用
const SUB = join(ROOT, "sub");
mkdirSync(SUB);
const CONFIG = normalizeConfig({ workBranches: ["dev/*"], protectedBranches: ["main"], baseBranch: "develop", namePattern: "^dev/[a-z0-9-]+$" });
// 試験の期待値は、実装とは別に書いた引用で作る（引用の実装の誤りを見逃さないため）
const q = (s) => `'${s.replace(/'/g, "'\\''")}'`;
const wtOf = (root, branch) => join(root, ".claude", "worktrees", branch.replace(/\//g, "-"));
const factsOf = (over = {}) => ({
  mainRoot: ROOT,
  cwd: ROOT,
  currentBranch: "develop",
  mainBranch: "develop",
  worktreeOf: () => null,
  trackedChanges: 0,
  untrackedChanges: 0,
  branchExists: () => ({ local: false, origin: false }),
  declaredAt: () => true,
  ...over,
});
// 1 つのコマンドを分類し、その作成の操作を計画にかける（実際の分類結果を使う）
const planOf = (command, { host = "claude", facts = factsOf(), hasLeadingCd = false, cwd = ROOT } = {}) => {
  const op = classifyCommand(command, cwd).operations.find((o) => o.kind === "create");
  return planGate({ host, command, toolInput: { command }, op, config: CONFIG, facts, hasLeadingCd, unresolved: op.unresolved });
};
// シェルを実行し、cd と node（brw の CLI）の引数を記録する関数に差し替えてから実行する。出力は cd・node の記録と printf の文面
const SHADOW = "cd(){ printf '[CD]%s[/CD]' \"$1\"; }; node(){ printf '[NODE]'; for a in \"$@\"; do printf '[%s]' \"$a\"; done; printf '[/NODE]'; }; ";
const runShadowed = (command) => execFileSync("bash", ["-c", SHADOW + command], { encoding: "utf8" });

const runPlanGateChecks = async (eq) => {
  // ---- 置き換え（rewrite） ----
  const wt = wtOf(ROOT, "dev/foo");
  const plain = planOf("git switch -c dev/foo");
  eq("brw-branch-gate/1.1 適格な switch -c は rewrite になる", plain.verdict, "rewrite");
  eq("brw-branch-gate/1.1 rewrite のコマンドは「本体へ移動 → brw create → worktree へ移動 → 案内」の形", plain.command.startsWith(
    `cd ${q(ROOT)} && node ${q(BRW)} create 'dev/foo' && cd ${q(wt)} && printf '%s\\n' `,
  ), true);
  const shown = runShadowed(plain.command);
  eq("brw-branch-gate/1.2 シェルで解釈すると、本体・brw の引数・worktree の順に実行される", shown.startsWith(
    `[CD]${ROOT}[/CD][NODE][${BRW}][create][dev/foo][/NODE][CD]${wt}[/CD][branch-release-workflow] `,
  ), true);
  eq("brw-branch-gate/1.3 案内の文面に置き換えと作業場所が書かれる", [
    shown.includes("BRW 案内: 置き換え"), shown.includes(`作業場所: ${wt}`), shown.endsWith("\n"),
  ], [true, true, true]);
  eq("brw-branch-gate/2.1 rewrite の reason は 1 行の結論、notice は本文の行", [plain.reason.includes("\n"), plain.notice.length >= 1], [false, true]);

  const special = join(ROOT, "a b'c");
  // cd の先は操作の作業ディレクトリ（ここでは本体と同じ）。仕様の更新で、引用の試験でも作業ディレクトリを合わせる
  const specialPlan = planOf("git switch -c dev/foo", { facts: factsOf({ mainRoot: special, cwd: special }) });
  eq("brw-branch-gate/1.1 空白・単引用符を含む本体のパスも、シェルに解釈させると元のパスに戻る", runShadowed(specialPlan.command).startsWith(
    `[CD]${special}[/CD][NODE][${BRW}][create][dev/foo][/NODE][CD]${wtOf(special, "dev/foo")}[/CD]`,
  ), true);

  eq("brw-branch-gate/1.1 開始点が origin/分岐元 の switch -c も rewrite になる", planOf("git switch -c dev/foo origin/develop").verdict, "rewrite");
  eq("brw-branch-gate/1.1 開始点が分岐元（ローカル）の switch -c も rewrite になる", planOf("git switch -c dev/foo develop").verdict, "rewrite");
  eq("brw-branch-gate/1.1 worktree add -b で配置先の一致するパスは rewrite になる", planOf(`git worktree add -b dev/foo ${q(wt)} develop`).verdict, "rewrite");
  eq("brw-branch-gate/1.1 cd で始まる単独の git 操作は rewrite になる", planOf(`cd ${q(ROOT)} && git switch -c dev/foo`, { hasLeadingCd: true }).verdict, "rewrite");
  eq("brw-branch-gate/1.9 未追跡だけなら rewrite になり、残る件数を案内する", (() => {
    const p = planOf("git switch -c dev/foo", { facts: factsOf({ untrackedChanges: 3 }) });
    return [p.verdict, p.notice.some((l) => l.includes("未追跡のファイル 3 件"))];
  })(), ["rewrite", true]);

  const branchOnly = planOf("git branch dev/foo");
  eq("brw-branch-gate/1.2 git branch は --branch-only の作成になり、作業場所を移さない", [
    branchOnly.verdict, branchOnly.command.startsWith(`( cd ${q(ROOT)} && node ${q(BRW)} create 'dev/foo' --branch-only && printf `), branchOnly.command.endsWith(" )"), branchOnly.command.includes(".claude/worktrees/dev-foo"),
  ], ["rewrite", true, true, false]);
  eq("brw-branch-gate/1.2 --branch-only の実行では作業場所が移らない", runShadowed(branchOnly.command).startsWith(
    `[CD]${ROOT}[/CD][NODE][${BRW}][create][dev/foo][--branch-only][/NODE][branch-release-workflow] `,
  ), true);

  // ---- 指摘の修正の試験（実際のシェルで動きを確かめる） ----
  // 開始点の同一性: 案内の本文に、最新の origin/<分岐元> から作る旨を書く
  eq("brw-branch-gate/1.1 置き換えの案内は、brw create が選ぶ開始点を実際の規則どおりに書く", shown.includes("分岐元は、brw create が選ぶ開始点（取得できた最新の origin/develop の先端。取得できないときは、手元に残っている origin/develop、無ければ手元の develop）から作ります。"), true);
  eq("brw-branch-gate/1.1 置き換えの案内に規則の各語句（先端・手元に残っている・手元の分岐元名）が含まれる", ["origin/develop の先端", "手元に残っている origin/develop", "無ければ手元の develop"].map((phrase) => shown.includes(phrase)), [true, true, true]);
  // branchOnly はサブシェルで実行し、作業ディレクトリを変えない（操作の作業ディレクトリ SUB から、起点 ROOT で実行しても ROOT のまま）
  const realRun = (command, start) => execFileSync("bash", ["-c", `node(){ printf '[NODE %s]' "$PWD"; }; ${command}; printf '[AFTER %s]' "$PWD"`], { cwd: start, encoding: "utf8" });
  const subBranchOnly = planOf("git branch dev/foo", { facts: factsOf({ cwd: SUB }) });
  eq("brw-branch-gate/1.2 branchOnly は cd 付きのサブシェルで実行され、実行後の作業ディレクトリが元のまま", (() => {
    const out = realRun(subBranchOnly.command, ROOT);
    return [out.includes(`[NODE ${SUB}]`), out.endsWith(`[AFTER ${ROOT}]`)];
  })(), [true, true]);
  // Codex 向けの拒否の案内: branchOnly は作業場所を移さないため、案内を実行しても作業ディレクトリが変わらない形（サブシェル）にする
  const codexBranchOnly = planOf("git branch dev/foo", { host: "codex", facts: factsOf({ cwd: SUB }) });
  eq("brw-branch-gate/1.5 Codex の branchOnly 拒否の次のコマンドは、サブシェルで囲まれた形", codexBranchOnly.reason.includes(`次のコマンド: ( cd ${q(SUB)} && node ${q(BRW)} create 'dev/foo' --branch-only )`), true);
  eq("brw-branch-gate/1.5 Codex の branchOnly 拒否の案内を実行しても、作業ディレクトリは元のまま", (() => {
    const cmd = codexBranchOnly.reason.split("\n")[2].replace(/^次のコマンド: /, "");
    const out = realRun(cmd, ROOT);
    return [out.includes(`[NODE ${SUB}]`), out.endsWith(`[AFTER ${ROOT}]`)];
  })(), [true, true]);
  // Codex 向けの作業場所を移す形（branchOnly 以外）は、従来どおり cd で移る形のまま
  const codexSwitch = planOf("git switch -c dev/foo", { host: "codex" });
  eq("brw-branch-gate/1.5 Codex の branchOnly 以外の拒否は、従来どおり cd で作業場所を移す形", codexSwitch.reason.includes(`次のコマンド: cd ${q(ROOT)} && node ${q(BRW)} create 'dev/foo' && cd ${q(wt)}`), true);
  // 置き換えのコマンドは本体ではなく操作の作業ディレクトリで始まる
  const subPlan = planOf("git switch -c dev/foo", { facts: factsOf({ cwd: SUB }) });
  eq("brw-branch-gate/1.1 置き換えのコマンドは操作の作業ディレクトリ（本体ではない）で始まる", subPlan.command.startsWith(`cd ${q(SUB)} && node ${q(BRW)} create 'dev/foo' && cd ${q(wt)} && printf `), true);
  eq("brw-branch-gate/1.1 操作の作業ディレクトリで始まる置き換えは、シェルで SUB に移動してから brw を呼ぶ", runShadowed(subPlan.command).startsWith(
    `[CD]${SUB}[/CD][NODE][${BRW}][create][dev/foo][/NODE][CD]${wt}[/CD]`,
  ), true);
  // branchOnly は追跡済みの変更があっても作業ツリーに触れないので置き換える
  eq("brw-branch-gate/1.8 git branch は追跡済みの変更があっても置き換える（拒否しない）", planOf("git branch dev/foo", { facts: factsOf({ trackedChanges: 2 }) }).verdict, "rewrite");
  // 追跡済みの変更の拒否の案内は、操作の作業ディレクトリでの --carry の形
  const dirtySub = planOf("git switch -c dev/foo", { facts: factsOf({ cwd: SUB, trackedChanges: 2 }) });
  eq("brw-branch-gate/1.8 追跡済みの変更の拒否の案内は、同じ作業ディレクトリでの --carry を示す", dirtySub.reason.includes(`${q(SUB)} && node ${q(BRW)} create 'dev/foo' --carry`), true);

  // ---- 拒否（deny）: 理由と次のコマンドを含む ----
  const denyCases = [
    ["規則外の名前（接頭辞は補わない）", "git switch -c foo", {}, "gate-name-invalid"],
    ["開始点が分岐元以外", "git switch -c dev/foo some-other", { facts: factsOf({ branchExists: (n) => ({ local: n === "some-other", origin: false }) }) }, "gate-start-unsupported"],
    ["開始点なしで現在のブランチが分岐元以外", "git switch -c dev/foo", { facts: factsOf({ currentBranch: "dev/x" }) }, "gate-start-unsupported"],
    ["配置先の外の worktree", "git worktree add -b dev/foo /elsewhere/dev-foo develop", {}, "gate-outside-placement"],
    ["他の操作と組み合わされた複合コマンド", "git switch -c dev/foo && git push", {}, "gate-compound"],
    ["記号を含むコマンド", "git switch -c dev/foo; echo x", {}, "gate-compound"],
    ["追跡済みの未コミットの変更がある", "git switch -c dev/foo", { facts: factsOf({ trackedChanges: 2 }) }, "gate-dirty"],
    ["既に存在するブランチ（再開は別の手順）", "git switch -c dev/foo", { facts: factsOf({ branchExists: () => ({ local: true, origin: false }) }) }, "gate-action-unsupported"],
    ["名前変更は置き換えない", "git branch -m dev/a dev/b", {}, "gate-action-unsupported"],
    ["強制作成（-C）は置き換えない", "git switch -C dev/foo", {}, "gate-action-unsupported"],
    ["孤立ブランチ（--orphan）は置き換えない", "git switch --orphan dev/foo", {}, "gate-action-unsupported"],
    ["強制更新（branch -f）は置き換えない", "git branch -f dev/foo", {}, "gate-action-unsupported"],
    ["追跡の指定は置き換えない", "git switch -c dev/foo --track origin/develop", {}, "gate-action-unsupported"],
    ["host が codex では書き換えない", "git switch -c dev/foo", { host: "codex" }, "gate-host-no-rewrite"],
  ];
  for (const [label, command, opts, code] of denyCases) {
    const p = planOf(command, opts);
    eq(`brw-branch-gate/1.4〜1.8 ${label} は ${code} の拒否で、次のコマンドを含む`, [p.verdict, p.code, p.reason?.includes("次のコマンド: ")], ["deny", code, true]);
  }
  eq("brw-branch-gate/5.1 変数展開を含む作成先は、確定できないため拒否する", planOf('git switch -c "$X"').verdict, "deny");
  eq("brw-branch-gate/1.8 追跡済みの変更の拒否は 2 つの選択肢を案内する", (() => {
    const p = planOf("git switch -c dev/foo", { facts: factsOf({ trackedChanges: 2 }) });
    return [p.reason.includes(`create 'dev/foo' --carry`), p.reason.includes("1) "), p.reason.includes("2) ")];
  })(), [true, true, true]);
  eq("brw-branch-gate/1.5 codex の拒否は、同じ置き換えの次のコマンドを示す", planOf("git switch -c dev/foo", { host: "codex" }).reason.includes(`node ${q(BRW)} create 'dev/foo' && cd ${q(wt)}`), true);

  // ---- 引用の往復（シェルに解釈させると元の値に戻る） ----
  const samples = ["plain", "a b", "it's", "$HOME `x` \"y\"", "a\\b", "line1\nline2", "日本語 ö", "--weird", ""];
  const back = execFileSync("bash", ["-c", `printf '%s\\0' ${samples.map(shellQuote).join(" ")}`], { encoding: "utf8" }).split("\0").slice(0, -1);
  eq("brw-branch-gate/1.1 shellQuote の値はシェルで元の値に戻る", back, samples);

  // ---- git の状態（gatherFacts）: 一時リポジトリで実際の値を確かめる ----
  const repo = mkdtempSync(join(tmpdir(), "brw-gate-facts-"));
  const g = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-C", repo, ...a], { stdio: "ignore" });
  execFileSync("git", ["init", "-q", "-b", "develop", repo], { stdio: "ignore" });
  g("commit", "-q", "--allow-empty", "-m", "初期");
  execFileSync("bash", ["-c", `printf 'a\\n' > ${q(join(repo, "a.txt"))}`]);
  g("add", "a.txt");
  g("commit", "-q", "-m", "a");
  execFileSync("bash", ["-c", `printf 'b\\n' >> ${q(join(repo, "a.txt"))}; printf 'u\\n' > ${q(join(repo, "u.txt"))}`]);
  const f = gatherFacts(repo);
  eq("brw-branch-gate/5.1 gatherFacts は本体・現在のブランチ・変更の件数を実際の値で返す", [
    f.mainRoot, f.currentBranch, f.trackedChanges, f.untrackedChanges, f.branchExists("develop").local, f.branchExists("develop").origin,
  ], [repo, "develop", 1, 1, true, false]);
  eq("brw-branch-gate/5.1 git の状態を読めないときは facts を作らない（確定できない）", gatherFacts(ROOT), null);

  // 連携 worktree から操作するとき、置き換えは連携 worktree を作業ディレクトリにする（本体の状態は本体の値）
  const linked = join(mkdtempSync(join(tmpdir(), "brw-gate-linked-")), "wt");
  execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", "dev/linked", linked], { stdio: "ignore" });
  const fl = gatherFacts(linked);
  const linkedPlan = planGate({ host: "claude", command: "git switch -c dev/foo develop", toolInput: {}, op: classifyCommand("git switch -c dev/foo develop", linked).operations.find((o) => o.kind === "create"), config: CONFIG, facts: fl, hasLeadingCd: false, unresolved: [] });
  eq("brw-branch-gate/5.1 連携 worktree の facts は、作業ディレクトリに連携 worktree・本体に本体を持つ", [fl.cwd === linked, fl.mainRoot === repo], [true, true]);
  eq("brw-branch-gate/3.1 gatherFacts は本体のブランチと、ブランチを使用中の worktree（本体を除く）を返す", [fl.mainBranch, fl.worktreeOf("dev/linked") === linked, fl.worktreeOf("develop"), fl.worktreeOf("dev/none")], ["develop", true, null, null]);
  eq("brw-branch-gate/3.4 detached HEAD への移動は作成の操作として分類されない", [
    classifyCommand("git switch --detach HEAD", repo).operations.some((o) => o.kind === "create"),
    classifyCommand("git checkout --detach HEAD", repo).operations.some((o) => o.kind === "create"),
  ], [false, false]);
  eq("brw-branch-gate/1.1 連携 worktree から操作するときの置き換えは、その worktree で brw create を実行する", String(linkedPlan.command).startsWith(`cd ${q(linked)} && node ${q(BRW)} create 'dev/foo' && cd ${q(join(repo, ".claude", "worktrees", "dev-foo"))} && printf `), true);

  // ---- 既存の開発ブランチの再開（brw resume への置き換え） ----
  const resumeOp = (branch, over = {}) => ({ kind: "create", action: "resume", via: "switch", branch, start: null, branchOnly: false, cwd: ROOT, unresolved: [], ...over });
  const resumePlan = (command, op, { host = "claude", facts = factsOf({ branchExists: () => ({ local: true, origin: false }) }) } = {}) =>
    planGate({ host, command, toolInput: { command }, op, config: CONFIG, facts, hasLeadingCd: false, unresolved: op.unresolved });
  const rwt = wtOf(ROOT, "dev/bar");
  const rp = resumePlan("git switch dev/bar", resumeOp("dev/bar"));
  eq("brw-branch-gate/3.1 既存の開発ブランチへの切り替えは brw resume への置き換えになる", [rp.verdict, rp.command.startsWith(
    `cd ${q(ROOT)} && node ${q(BRW)} resume 'dev/bar' && cd ${q(rwt)} && printf '%s\\n' `)], ["rewrite", true]);
  eq("brw-branch-gate/3.1 置き換えの実行は、本体・brw resume の引数・worktree の順になる", runShadowed(rp.command).startsWith(
    `[CD]${ROOT}[/CD][NODE][${BRW}][resume][dev/bar][/NODE][CD]${rwt}[/CD][branch-release-workflow] `), true);
  eq("brw-branch-gate/3.1 リモートにだけあるブランチの切り替えも再開になる", resumePlan("git switch dev/bar", { ...resumeOp("dev/bar"), action: "create" }, { facts: factsOf({ branchExists: () => ({ local: false, origin: true }) }) }).verdict, "rewrite");
  eq("brw-branch-gate/3.1 checkout の切り替えも再開になる", resumePlan("git checkout dev/bar", resumeOp("dev/bar", { via: "checkout" })).verdict, "rewrite");
  const used = resumePlan("git switch dev/bar", resumeOp("dev/bar"), { facts: factsOf({ branchExists: () => ({ local: true, origin: false }), worktreeOf: () => "/elsewhere/dev-bar" }) });
  eq("brw-branch-gate/3.1 既にそのブランチの worktree があるときは、その場所へ移る", [used.verdict, used.worktree], ["rewrite", "/elsewhere/dev-bar"]);
  eq("brw-branch-gate/3.1 置き換えの案内は固定の書式で、作業場所と未コミットの変更の残り先を含む", (() => {
    const d = resumePlan("git switch dev/bar", resumeOp("dev/bar"), { facts: factsOf({ branchExists: () => ({ local: true, origin: false }), trackedChanges: 2, untrackedChanges: 1 }) });
    const text = runShadowed(d.command);
    return [text.includes("BRW 案内: 置き換え"), text.includes(`作業場所: ${rwt}`), text.includes("追跡済み 2 件・未追跡 1 件"), CALLER_WORDS.test(text)];
  })(), [true, true, true, false]);
  eq("brw-branch-gate/1.5 worktree add <配置先> <既存ブランチ> は配置先が再開先と一致するときだけ置き換える", [
    resumePlan(`git worktree add ${rwt} dev/bar`, resumeOp("dev/bar", { via: "worktree", path: rwt })).verdict,
    resumePlan("git worktree add /elsewhere/x dev/bar", resumeOp("dev/bar", { via: "worktree", path: "/elsewhere/x" })).code,
  ], ["rewrite", "gate-outside-placement"]);
  eq("brw-branch-gate/3.2 保護・分岐元への切り替えは置き換えず、通常の承認に任せる（ブランチを作らない）", [
    resumePlan("git switch main", resumeOp("main")).verdict,
    resumePlan("git switch develop", resumeOp("develop")).verdict,
    resumePlan("git switch main", resumeOp("main")).code,
  ], ["pass", "pass", "gate-resume-protected"]);
  eq("brw-branch-gate/3.3 存在を確認できない保護・分岐元ブランチへの切り替えも通さず止める", [
    resumePlan("git switch main", resumeOp("main"), { facts: factsOf({ branchExists: () => ({ local: false, origin: false }) }) }).code,
    resumePlan("git switch main", resumeOp("main"), { facts: factsOf({ branchExists: () => ({ local: false, origin: true }) }) }).verdict,
  ], ["gate-unresolved", "pass"]);
  eq("brw-branch-gate/3.1 宣言の開発ブランチでない切り替え先は、再開に置き換えず拒否する", (() => {
    const d = resumePlan("git switch feature/x", resumeOp("feature/x"));
    return [d.verdict, d.code, d.reason.includes("次のコマンド: ")];
  })(), ["deny", "gate-name-invalid", true]);
  eq("brw-branch-gate/3.3 切り替え先が既存のブランチと確認できないときは止める", [
    resumePlan("git switch dev/bar", resumeOp("dev/bar"), { facts: factsOf({ branchExists: () => ({ local: false, origin: false }) }) }).code,
    resumePlan("git switch dev/bar", resumeOp("dev/bar", { unresolved: ["切り替え先 'dev/bar' が既存のブランチと確認できません。"] })).code,
  ], ["gate-unresolved", "gate-unresolved"]);
  eq("brw-branch-gate/3.1 本体で使用中のブランチは再開に置き換えず拒否する", resumePlan("git switch dev/bar", resumeOp("dev/bar"), { facts: factsOf({ branchExists: () => ({ local: true, origin: false }), mainBranch: "dev/bar" }) }).code, "gate-action-unsupported");
  eq("brw-branch-gate/1.6 codex では書き換えず、再開と作業場所の移動を次のコマンドとして示す拒否にする", (() => {
    const d = resumePlan("git switch dev/bar", resumeOp("dev/bar"), { host: "codex" });
    return [d.verdict, d.code, d.reason.includes(`node ${q(BRW)} resume 'dev/bar' && cd ${q(rwt)}`)];
  })(), ["deny", "gate-host-no-rewrite", true]);
  eq("brw-branch-gate/3.2 codex でも保護ブランチへの切り替えは通常の承認に任せる", resumePlan("git switch main", resumeOp("main"), { host: "codex" }).verdict, "pass");
  eq("brw-branch-gate/3.1 記号を含む切り替え先と、他のコマンドとの組み合わせは置き換えない", [
    resumePlan("git switch dev/bar", resumeOp("dev/$x")).code,
    planGate({ host: "claude", command: "git switch dev/bar && git push", toolInput: {}, op: resumeOp("dev/bar"), config: CONFIG, facts: factsOf({ branchExists: () => ({ local: true, origin: false }) }), hasLeadingCd: false, unresolved: [] }).code,
  ], ["gate-name-invalid", "gate-compound"]);

};
