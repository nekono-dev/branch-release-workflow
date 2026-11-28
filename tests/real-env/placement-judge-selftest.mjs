// brw-branch-gate 8.1: 実機の記録の判定（placement-judge.mjs）の自己検証。
// 使い方: node tests/real-env/placement-judge-selftest.mjs
// 実機・ネットワークを使わず、BRW_REAL_ENV も要らない。良い記録は OK（真）、壊した記録は NG（偽）になることを確かめる。
// 期待と食い違う判定があれば終了コード 1。
import { judgeEnterWorktreeMove, judgeRemovedWorktreeSession } from "./placement-judge.mjs";

const R = "/r";
const WT = "/r/.worktree/dev-bar";
const HOME = "/home/ubuntu";

// フックの記録（hook-logger.mjs の形: event と input.tool_name・input.tool_input・input.cwd）
const pre = (tool, toolInput, cwd) => ({ event: "PreToolUse", input: { tool_name: tool, tool_input: toolInput, cwd } });
const bash = (command, cwd) => pre("Bash", { command }, cwd);
const enter = (name) => pre("EnterWorktree", { name }, R);

const cases = [];
const expect = (name, actual, want, detail = "") => cases.push({ name, actual, want, detail });

// ---- (2) EnterWorktree の拒否のあと、brw create と cd で移れたか ----
const moveGood = [enter("bar"), bash("node brw.mjs create bar", R), bash(`cd ${WT}`, R), bash("pwd", WT)];
expect("(2) 良い記録: name・brw create・cd・次の Bash の作業場所が worktree", judgeEnterWorktreeMove(moveGood, [], WT, "bar").ok, true);

expect("(2) 壊した記録: EnterWorktree の name が bar でない", judgeEnterWorktreeMove([enter("foo"), ...moveGood.slice(1)], [], WT, "bar").ok, false);

const moveNoCd = [enter("bar"), bash("node brw.mjs create bar", R), bash("pwd", WT)];
expect("(2) 壊した記録: cd の記録が無い（作業場所だけ worktree）", judgeEnterWorktreeMove(moveNoCd, [], WT, "bar").ok, false);

const moveNoCreate = [enter("bar"), bash(`cd ${WT}`, R), bash("pwd", WT)];
expect("(2) 壊した記録: brw create の記録が無い", judgeEnterWorktreeMove(moveNoCreate, [], WT, "bar").ok, false);

// 任意の Bash の結果が worktree のパスと一致しても、cd で移った根拠が無ければ成功にしない
expect("(2) 壊した記録: cd が無く、pwd の結果だけが worktree のパス",
  judgeEnterWorktreeMove([enter("bar"), bash("node brw.mjs create bar", R), bash("pwd", R)], [{ tool: "Bash", text: WT }], WT, "bar").ok, false);

// cd のあと、移った先を確かめる記録（cwd が worktree の Bash、または cd と pwd を 1 つにした結果）が無い
expect("(2) 壊した記録: cd のあとの作業場所が本体のまま",
  judgeEnterWorktreeMove([enter("bar"), bash("node brw.mjs create bar", R), bash(`cd ${WT}`, R), bash("pwd", R)], [], WT, "bar").ok, false);

expect("(2) 壊した記録: brw 以外の create（git create bar 相当）",
  judgeEnterWorktreeMove([enter("bar"), bash("echo create bar", R), bash(`cd ${WT}`, R), bash("pwd", WT)], [], WT, "bar").ok, false);
expect("(2) 壊した記録: cd ではなく ls で worktree を参照しただけ",
  judgeEnterWorktreeMove([enter("bar"), bash("node brw.mjs create bar", R), bash(`ls ${WT}`, R), bash("pwd", WT)], [], WT, "bar").ok, false);
// 実機では、名前を引用符で囲んだ形（create 'bar'）で brw create が呼ばれた
expect("(2) 良い記録: brw create の名前が引用符で囲まれている（実機の記録の形）",
  judgeEnterWorktreeMove([enter("bar"), bash(`cd '${R}' && node brw.mjs create 'bar'`, R), bash(`cd ${WT} && pwd`, R)], [{ tool: "Bash", text: `${WT}\n` }], WT, "bar").ok, true);

expect("(2) 良い記録: cd と pwd を 1 つにし、その結果が worktree のパス",
  judgeEnterWorktreeMove([enter("bar"), bash("node brw.mjs create bar", R), bash(`cd ${WT} && pwd`, R)], [{ tool: "Bash", text: `${WT}\n` }], WT, "bar").ok, true);

// ---- (3) 作業場所が消えたあとのフックの入力と CLAUDE_PROJECT_DIR ----
const removeGood = [bash(`git -C ${R} worktree remove --force ${WT}`, WT), bash("echo after", HOME)];
expect("(3) 良い記録: worktree を消したあとの入力は worktree の外（復帰したシェルの場所）、CLAUDE_PROJECT_DIR が worktree",
  judgeRemovedWorktreeSession(removeGood, WT, WT, false).ok, true);

// 実機の別の形: 消えた作業場所（worktree のパスのまま・存在しない）で入力が記録された
const removeGoneCwd = [bash(`git -C ${R} worktree remove --force ${WT}`, WT), bash("echo after", WT)];
expect("(3) 良い記録: 消したあとの入力の作業場所が、存在しなくなった worktree のパス",
  judgeRemovedWorktreeSession(removeGoneCwd, WT, WT, false).ok, true);

expect("(3) 壊した記録: CLAUDE_PROJECT_DIR が別のパス", judgeRemovedWorktreeSession(removeGood, WT, R, false).ok, false);

expect("(3) 壊した記録: worktree がまだ存在するのに、入力の作業場所が worktree の中のまま",
  judgeRemovedWorktreeSession(removeGoneCwd, WT, WT, true).ok, false);

expect("(3) 壊した記録: 消す操作の記録が無い（worktree で始まっていない）",
  judgeRemovedWorktreeSession([bash("echo after", HOME)], WT, WT, false).ok, false);

let bad = 0;
for (const c of cases) {
  const ok = c.actual === c.want;
  if (!ok) bad += 1;
  console.log(`${ok ? "OK" : "NG"}  ${c.name}${ok ? "" : `（期待 ${c.want}・実際 ${c.actual}）`}`);
}
const ok = bad === 0;
console.log(JSON.stringify({ script: "placement-judge-selftest", ok, cases: cases.length, failed: bad }));
process.exit(ok ? 0 : 1);
