// brw-pr-handoff 10.3: 本文置き場の実機の判定（tests/real-env/body-placement-judge.mjs）の単体試験。selftest.mjs から呼ばれる。
// 実機（claude・brw）は呼ばない。良い記録が通り、壊した記録（期待と違う並び・パス・結果）が落ちることを確かめる。
import { bodyMatches, judgeBodyFlow, judgeLegacyRefusal, prBodyFileOf, prTemplateAfterCd, shellSegments, toolCallsOf } from "./real-env/body-placement-judge.mjs";

const WT = "/h/main/.worktree/dev-body";
const BODY = "/h/main/.worktree/.brw/dev-body.md";
const LEGACY_DIR = "/h/main/.claude/worktrees/.brw";
const LEGACY = `${LEGACY_DIR}/dev-body.md`;
const NEW = BODY;
const GOOD_BODY = "## 概要\n本文置き場の確認\n\n## 変更内容\n変更\n";

// stream-json の 1 行（assistant の tool_use / user の tool_result）
const use = (id, name, input) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
const res = (id, content, isError = false) => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] } });

const goodText = [
  use("1", "Bash", { command: `cd '${WT}' && brw pr-template` }),
  res("1", `本文を次に書いてください: ${BODY}\n- brw pr --body-file ${BODY}`),
  use("2", "Write", { file_path: BODY, content: GOOD_BODY }),
  res("2", "ok"),
  use("3", "Bash", { command: `cd '${WT}' && brw pr --title 'x' --completion 'y' --verification 'z' --body-file ${BODY}` }),
  res("3", "PR を作成しました: https://github.com/acme/app/pull/7"),
].join("\n");
const goodPosts = [{ applied: true, body: GOOD_BODY }];

const flow = (text, over = {}) => judgeBodyFlow({
  calls: toolCallsOf(text).calls, bodyPath: BODY, worktree: WT, legacyDir: LEGACY_DIR,
  posts: goodPosts, bodyExistsAfter: false, worktreeExistsAfter: false, ...over,
});
const ids = (r) => r.items.filter((i) => !i.ok).map((i) => i.id);

const GOOD_LEGACY = { exit: 1, output: `本文ファイル ${LEGACY} は旧置き場（${LEGACY_DIR}）にあり…\n次の手順で移してください。\nmkdir -p '/h/main/.worktree/.brw'\nmv '${LEGACY}' '${NEW}'\n`, legacyPath: LEGACY, legacyDir: LEGACY_DIR, newPath: NEW, legacyExistsAfter: true, newExistsAfter: false, postsDelta: 0 };
const legacy = (over = {}) => judgeLegacyRefusal({ ...GOOD_LEGACY, ...over });

export const runBodyPlacementJudgeChecks = (eq) => {
  // ---- 本文の流れ（(0)〜(3)） ----
  eq("body-placement/10.3 良い記録: 全項目が通る", flow(goodText).ok, true);
  eq("body-placement/10.3 良い記録: 項目の数が 9（0・1a・1b・1c・2a・2b・2c・3a・3b）", flow(goodText).items.length, 9);

  eq("body-placement/10.3 壊した記録: pr-template の出力が本文のパスを示さない",
    ids(flow(goodText.replace(BODY, "/other/x.md").replace(new RegExp(BODY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "/other/x.md"))).includes("1a"), true);

  eq("body-placement/10.3 壊した記録: pr-template が作業場所を指定しない（本体のまま）",
    ids(flow(goodText.replace(`cd '${WT}' && brw pr-template`, "brw pr-template"))).includes("0"), true);

  eq("body-placement/10.3 壊した記録: Write が別のパス（作業場所の中）へ書いた",
    ids(flow(goodText.replace(`"file_path":"${BODY}"`, `"file_path":"${WT}/x.md"`).replace(`"file_path": "${BODY}"`, `"file_path": "${WT}/x.md"`))).includes("1b"), true);

  eq("body-placement/10.3 壊した記録: Write が旧置き場へ書いた",
    ids(flow(`${goodText}\n${use("9", "Write", { file_path: LEGACY, content: "x" })}\n${res("9", "ok")}`, { calls: toolCallsOf(`${goodText}\n${use("9", "Write", { file_path: LEGACY, content: "x" })}`).calls })).includes("1c"), true);

  // 実機の観測: 片付けで作業場所が消えた brw pr は、Bash の表示が Exit code 1（isError）でも、出力の文言は作成の成功
  eq("body-placement/10.3 良い記録: brw pr が Exit code 1 の表示でも、出力が PR を作成した（片付けで作業場所が消えた）",
    flow(goodText.replace("PR を作成しました", "Exit code 1\\nPR を作成しました")).items.find((i) => i.id === "2a").ok,
    true);
  eq("body-placement/10.3 壊した記録: brw pr の出力が作成ではなく失敗",
    ids(flow(goodText.replace("PR を作成しました", "エラー"))).includes("2a"), true);

  eq("body-placement/10.3 壊した記録: brw pr が本文のパスを指定しなかった",
    ids(flow(goodText.replace(`--verification 'z' --body-file ${BODY}`, "--verification 'z'"))).includes("2a"), true);

  eq("body-placement/10.3 壊した記録: PR 作成の要求が 0 件", ids(flow(goodText, { posts: [] })).includes("2b"), true);
  eq("body-placement/10.3 壊した記録: PR 作成の要求が 2 件", ids(flow(goodText, { posts: [{ applied: true, body: GOOD_BODY }, { applied: true, body: GOOD_BODY }] })).includes("2b"), true);
  eq("body-placement/10.3 壊した記録: PR の本文に未記入の印が残っている",
    ids(flow(goodText, { posts: [{ applied: true, body: `<!-- brw:unfilled\n${GOOD_BODY}` }] })).includes("2b"), true);
  eq("body-placement/10.3 壊した記録: PR の本文に見出しが無い", ids(flow(goodText, { posts: [{ applied: true, body: "本文だけ" }] })).includes("2b"), true);

  eq("body-placement/10.3 壊した記録: 片付けのあとも本文が残る", ids(flow(goodText, { bodyExistsAfter: true })).includes("3a"), true);
  eq("body-placement/10.3 壊した記録: 片付けのあとも作業場所が残る", ids(flow(goodText, { worktreeExistsAfter: true })).includes("3b"), true);

  eq("body-placement/10.3 壊した記録: 結果が無い（解析できない・途中で止まった）", flow("").ok, false);

  // (0) cd は引数として解析する。作業場所が別のコマンドの引数に出るだけでは通さない
  eq("body-placement/10.3 壊した記録: cd が無く、echo の引数に作業場所が出るだけ（cd を使わない）",
    ids(flow(goodText.replace(`cd '${WT}' && brw pr-template`, `echo '${WT}'; brw pr-template`))).includes("0"), true);
  eq("body-placement/10.3 壊した記録: cd で移ったあとの pr-template が無い（cd のみ）",
    ids(flow(goodText.replace(`cd '${WT}' && brw pr-template`, `cd '${WT}'`))).includes("0"), true);

  // (2a) --body-file の値として本文のパスが存在する（echo の引数では通さない）
  eq("body-placement/10.3 壊した記録: 本文のパスが echo の引数にあるだけで、brw pr の --body-file ではない",
    ids(flow(goodText.replace(`cd '${WT}' && brw pr --title 'x' --completion 'y' --verification 'z' --body-file ${BODY}`,
      `echo ${BODY}; brw pr --title 'x' --completion 'y' --verification 'z'`))).includes("2a"), true);
  eq("body-placement/10.3 良い記録: --body-file の値が引用符で囲まれていても通る",
    ids(flow(goodText.replace(`--verification 'z' --body-file ${BODY}`, `--verification 'z' --body-file '${BODY}'`))).includes("2a"), false);

  // (2c) Write した本文の内容が PR 本文に入っている（無関係な本文は NG）
  eq("body-placement/10.3 壊した記録: PR 本文が Write した内容と無関係",
    ids(flow(goodText, { posts: [{ applied: true, body: "## 無関係\n別の文章だけ\n" }] })).includes("2c"), true);
  eq("body-placement/10.3 壊した記録: PR 本文の一部の行だけ入っていて、他の本文の行が無い",
    ids(flow(goodText, { posts: [{ applied: true, body: "## 概要\n本文置き場の確認\n" }] })).includes("2c"), true);
  eq("body-placement/10.3 良い記録: Write した内容の行が PR 本文に入っている（2c）",
    ids(flow(goodText, { posts: [{ applied: true, body: "## 概要\n本文置き場の確認\n\n## 変更内容\n変更\n" }] })).includes("2c"), false);

  // 解析の単体
  eq("body-placement/10.3 解析: 引用符で囲んだ作業場所の cd は 1 つの語になる",
    shellSegments(`cd '/a b/c' && brw pr-template`), [["cd", "/a b/c"], ["brw", "pr-template"]]);
  eq("body-placement/10.3 解析: 閉じていない引用符は解析できない（null）", shellSegments(`cd 'x && y`), null);
  eq("body-placement/10.3 解析: prTemplateAfterCd は echo 経由を通さない", prTemplateAfterCd(`echo /w; brw pr-template`, "/w"), false);
  eq("body-placement/10.3 解析: prBodyFileOf は引用符を外して値を返す", prBodyFileOf(`brw pr --body-file '/x y.md'`), "/x y.md");
  eq("body-placement/10.3 解析: bodyMatches は照合できる行が無いと偽", bodyMatches("## 見出しだけ\n", "## 見出しだけ\n"), false);

  // ---- 旧置き場の拒否（(4)） ----
  eq("body-placement/10.3 旧置き場: 拒否の良い記録は全項目が通る", legacy().ok, true);
  eq("body-placement/10.3 旧置き場: 終了コード 0（受け付けた）", ids(legacy({ exit: 0 })).includes("4a"), true);
  eq("body-placement/10.3 旧置き場: パスは出るが mv の手順が無い（案内として不十分）",
    ids(legacy({ output: `旧置き場（${LEGACY_DIR}）の ${LEGACY} は使えません。${NEW} へ移してください` })).includes("4c"), true);
  eq("body-placement/10.3 旧置き場: mv の案内が無い", ids(legacy({ output: "旧置き場です" })).includes("4c"), true);
  eq("body-placement/10.3 旧置き場: 旧置き場の案内が無い", ids(legacy({ output: "mv 'a' 'b'" })).includes("4b"), true);
  eq("body-placement/10.3 旧置き場: 自動で移された", ids(legacy({ legacyExistsAfter: false })).includes("4d"), true);
  eq("body-placement/10.3 旧置き場: PR が作られた", ids(legacy({ postsDelta: 1 })).includes("4e"), true);

  // ---- 記録の解析 ----
  const parsed = toolCallsOf(`${goodText}\nnot json\n`);
  eq("body-placement/10.3 解析: 呼び出しの数と解析できない行の数", [parsed.calls.length, parsed.unparsed], [3, 1]);
  eq("body-placement/10.3 解析: tool_result が結び付く", parsed.calls[0].result.includes("本文を次に書いて"), true);
  eq("body-placement/10.3 解析: 結果の無い呼び出しは未観測（null）", toolCallsOf(use("z", "Bash", { command: "x" })).calls[0].result, null);
};
