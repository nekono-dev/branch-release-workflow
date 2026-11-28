// brw-branch-gate 8.1: 実機の記録（フックの PreToolUse の並びと Bash の結果）から、配置の確認の成否を判定する純粋な関数。
// 実機・ネットワークを使わない。placement-e2e.mjs が使い、placement-judge-selftest.mjs が壊した記録で NG になることを確かめる。
import { sep } from "node:path";

/** dir の中（dir 自身を含む）のパスか */
const isInside = (p, dir) => typeof p === "string" && (p === dir || p.startsWith(dir + sep));
const isPre = (e, tool) => e?.event === "PreToolUse" && e?.input?.tool_name === tool;
const cmdOf = (e) => String(e?.input?.tool_input?.command ?? "");
const cwdOf = (e) => e?.input?.cwd ?? e?.cwd;

/**
 * (2) EnterWorktree の name 指定のあと、案内どおりに brw create で作った worktree へ Bash の cd で移れたかを判定する。
 * records: フックの PreToolUse の記録（時系列）。results: モデルの Bash の結果（{tool, text}）。
 * 移れた根拠は次のどちらか。(a) cd のあとの Bash の作業場所（cwd の記録）が worktree。(b) cd と pwd を 1 つにした Bash の結果が worktree のパスで、その command に cd と pwd がある。
 * 任意の Bash の結果が worktree のパスと一致しても、cd の記録が無ければ成功にしない。
 */
export function judgeEnterWorktreeMove(records, results, wt, name) {
  const ewIdx = records.findIndex((e) => isPre(e, "EnterWorktree") && e.input.tool_input?.name === name);
  // 名前は引用符で囲まれることがある（create 'bar' や create "bar"）
  const createIdx = records.findIndex((e, i) => i > ewIdx && isPre(e, "Bash")
    && /\bbrw\b/.test(cmdOf(e))
    && new RegExp(`\\bcreate\\s+['"]?${name}['"]?(?=\\s|$)`).test(cmdOf(e)));
  const cdIdx = records.findIndex((e, i) => i > createIdx && createIdx >= 0 && isPre(e, "Bash")
    && /\bcd\s/.test(cmdOf(e)) && cmdOf(e).includes(wt));
  const cd = cdIdx >= 0 ? records[cdIdx] : null;
  const arrivedByCwd = cdIdx >= 0 && records.some((e, i) => i > cdIdx && isPre(e, "Bash") && cwdOf(e) === wt);
  const arrivedByPwd = cd !== null && /\bpwd\b/.test(cmdOf(cd))
    && results.some((r) => r.tool === "Bash" && r.text.trim() === wt);
  const ok = ewIdx >= 0 && createIdx > ewIdx && cdIdx > createIdx && (arrivedByCwd || arrivedByPwd);
  return { ok, ewIdx, createIdx, cdIdx, arrivedByCwd, arrivedByPwd };
}

/**
 * (3) worktree で始めたセッションが、worktree を消したあとのフックの入力を判定する。
 * 1) 作業場所が wt のセッションで `worktree remove` を実行した記録がある。
 * 2) そのあとの Bash の入力の作業場所が、消えた作業場所（wt のまま・wt が存在しない）か、復帰したシェルの場所（wt の外）である。
 *    wt がまだ存在するのに入力の作業場所が wt の中のままなら、消えた作業場所のあとの入力とは認めない。
 * 3) フックが受け取った CLAUDE_PROJECT_DIR（実機で記録した値）が wt を指す。
 * 本体の導出（mainOfStart の結果）はこの判定では見ない。導出は公開の入口で観測できないため、placement-e2e.mjs は別に未確認と記録する。
 */
export function judgeRemovedWorktreeSession(records, wt, projectDir, wtExists) {
  const removeIdx = records.findIndex((e) => isPre(e, "Bash") && cmdOf(e).includes("worktree remove") && cwdOf(e) === wt);
  const afterGone = removeIdx >= 0 && records.some((e, i) => i > removeIdx && isPre(e, "Bash") && (
    !isInside(cwdOf(e), wt) || (cwdOf(e) === wt && !wtExists)));
  const envOk = projectDir === wt;
  return { ok: removeIdx >= 0 && afterGone && envOk, removeIdx, afterGone, envOk };
}
