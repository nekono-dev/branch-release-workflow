// 利用者向けの指示文面（brw-enforcement 17.1）が文書にあることを確かめる単体試験。selftest.mjs から呼ばれる。
// 語句が別の箇所に残っているだけでは通さないように、節・項目の中で文として成立しているかを確かめる。
// 変異版（指示を反転・削除した合成の文書）でも同じ確認が失敗することを試す。
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateConfig } from "../scripts/lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

// BRW は呼び出し側のスキル・文書の置き場を知らない前提なので、これらの語を文書に出さない
const FORBIDDEN = [/\bspec\b/i, /kiro/i, /cc-sdd/i, /\.kiro/];

const PROCEDURE = "## 作業の区切りと終了前の確認";
const RULES = "## 守ること";
const AUTO = "## 作業ブランチ運用の操作の確認の省略（`autoApprove`）";

// 見出し行（完全一致）から、次の「## 」見出しまでの本文
const sectionOf = (text, heading) => {
  const lines = text.split("\n");
  const i = lines.findIndex((l) => l === heading);
  if (i < 0) return "";
  const out = [];
  for (let k = i + 1; k < lines.length && !/^## /.test(lines[k]); k++) out.push(lines[k]);
  return out.join("\n");
};

// マーカーを含む 1 項目（その行から、次の項目・空行・見出しまで）
const itemOf = (section, marker) => {
  const lines = section.split("\n");
  const i = lines.findIndex((l) => l.includes(marker));
  if (i < 0) return "";
  const out = [lines[i]];
  for (let k = i + 1; k < lines.length && !/^(- |\d+\. |\s*$|#)/.test(lines[k]); k++) out.push(lines[k]);
  return out.join("\n");
};

// 手順の文が成立しているかを確かめる。成立しない項目の名前の一覧を返す（空なら成立）
export const procedureGaps = (text) => {
  const gaps = [];
  const need = (name, ok) => { if (!ok) gaps.push(name); };

  // 守ること: 恒常的な分岐元の扱い
  const rules = sectionOf(text, RULES);
  need("守ること: 恒常的な分岐元（baseBranch・baseBranches）を対象に含める", rules.includes("恒常的な分岐元（`baseBranch`・`baseBranches`）"));

  const sec = sectionOf(text, PROCEDURE);
  need("区切り: 節がある", sec !== "");
  need("区切り: 保護・恒常的な分岐元・宣言外では区切りの commit・push を行わないと同じ文で言う", sec.includes("保護ブランチ・恒常的な分岐元・宣言に無いブランチでは区切りの commit・push を行わない"));
  need("区切り: 区切りごとに作業ブランチへ commit と push を行う", /区切りごとに.*commit と push を行う/s.test(sec));
  need("区切り: 区切りの 1 つ目（まとまった成果物）", /まとまった成果物.*作成が完了したとき/s.test(sec));
  need("区切り: 区切りの 2 つ目（1 つの作業単位）", /1 つの作業単位が完了したとき/.test(sec));

  // 手順 1: 変更したパスだけ・git add -A を使わない・秘密情報を含めない（同じ項目の中で）
  const step1 = itemOf(sec, "変更したパスだけ");
  need("手順 1: 変更したパスだけを git add <パス> でステージする", /変更したパスだけを `git add <パス>` でステージする。/.test(step1));
  need("手順 1: `git add -A` は使わない（同じ文）", /`git add -A` は使わない。/.test(step1));
  need("手順 1: 秘密情報らしいファイルを含めない（同じ文）", /秘密情報らしいファイル.*を含めない。/.test(step1));

  // 手順 2・3
  const step2 = itemOf(sec, "ステージ内容");
  need("手順 2: git status と git diff --cached で確かめ、無関係な変更は外す", /git diff --cached.*git restore --staged/s.test(step2));
  const step3 = itemOf(sec, "`git commit` し");
  need("手順 3: git commit し、続けて git push する", /`git commit` し、続けて `git push` する/.test(step3));

  // push を禁じられたとき（項目の中で commit までにとどめ、未 push を報告する）
  const push = itemOf(sec, "**push を禁じられたとき**");
  need("push 禁止: 項目がある", push !== "");
  need("push 禁止: 「commit までにとどめ」と「未 push であることを報告」が同じ項目内", /commit までにとどめ.*未 push であることを報告する/s.test(push));

  // 失敗したとき（成功した処理・未完了の処理・失敗の理由の 3 つが同じ項目内）
  const fail = itemOf(sec, "**失敗したとき**");
  need("失敗: 項目がある", fail !== "");
  need("失敗: 成功した処理を報告（同じ項目内）", fail.includes("成功した処理"));
  need("失敗: 未完了の処理を報告（同じ項目内）", fail.includes("未完了の処理"));
  need("失敗: 失敗の理由を報告（同じ項目内）", fail.includes("失敗の理由"));
  need("失敗: 変更が手元にあることを示して終了（同じ項目内）", /変更が手元にあることを示して終了する/.test(fail));

  // 引き継ぎ
  const resume = itemOf(sec, "**別の環境・エージェントへ引き継ぐとき**");
  need("引き継ぎ: brw resume <ブランチ> で再開する（同じ項目内）", /`brw resume <ブランチ>` で再開する/.test(resume));

  // 終了前の確認（brw guard --finish・[block]・案内に従う・[allow]）
  const guard = itemOf(sec, "**終了前の確認**");
  need("終了前: 応答を終える前に brw guard --finish を実行する（同じ項目内）", /応答を終える前に `brw guard --finish` を実行する/.test(guard));
  need("終了前: [block] なら表示された案内に従う（同じ項目内）", /`\[block\]` なら、表示された案内に従って/.test(guard));
  need("終了前: [allow] なら終了してよい（同じ項目内）", /`\[allow\]` なら終了してよい/.test(guard));
  need("終了前: フックが使えない環境では必須（同じ項目内）", /フックが使えない環境.*必須/s.test(guard));
  return gaps;
};

// config.md の autoApprove の節が、push: false を push の禁止として文で言っているか
export const configGaps = (text) => {
  const gaps = [];
  const need = (name, ok) => { if (!ok) gaps.push(name); };
  const sec = sectionOf(text, AUTO);
  need("config: autoApprove の節がある", sec !== "");
  need("config: 確認を求める例に push: false を使わない", !sec.includes('{ "push": false }'));
  need("config: 確認を求める例に pullRequest: false を使う", sec.includes('{ "pullRequest": false }'));
  need("config: push: false は push の確認省略を無効にし、フックの通常の承認に任せると文で言う", /`autoApprove\.push: false` は、push の確認省略を無効にする設定である。push はフックの通常の承認に任せる。/.test(sec));
  need("config: push: false は区切りの push の指示と未 push の案内で push の禁止として扱い、commit までにとどめて未 push を報告すると同じ文で言う", /push の禁止として扱い、commit までにとどめて未 push を報告する/.test(sec));
  need("config: 誤読を招く「確認して push できる」「確認を省かない」の言い回しを残さない", !sec.includes("確認して push できる") && !sec.includes("push の確認を省かない"));
  need("config: 確認を省く形は単独の push・gh pr create など、または cd・git add（範囲つき）・通常の commit・push だけの && 連結（gh pr create は連結に含めない）", sec.includes("確認を省く形（先頭の任意の `cd <dir>` に続く単独の `git push`・`gh pr create` などの操作、または先頭の任意の `cd <dir>`、`git add`（`-A`・`-u`・`--all`・`-N`・`-v` とパスだけ）、通常の commit、`git push` の区間だけを `&&` で連ねたもの。`gh pr create` は `&&` の連結に含めない）以外の形"));
  need("config: 連結の除外に git add -f を例示し、旧い「git push・gh pr create と cd だけ」の文を残さない", sec.includes("`git add -f`") && !sec.includes("`git push`・`gh pr create` と `cd <dir>` を `&&` で連ねた以外の形"));
  need("config: commit は既定で有効、明示的な false だけが無効", /`commit`.*既定は有効、明示的な `false` だけが無効/.test(sec));
  return gaps;
};

// 18.6: 取り込み先ごとの PR のマージ手順（SKILL.md の「4. 変更作業の完了と公開」・守ること）が文として成立しているか。
// 必要な指示は 1 つの項目の中で成立していること、反対の指示（許可があればエージェントがマージしてよい、など）を含まないことを確かめる。
const MERGE_CONTRADICTIONS = [
  "エージェントが `brw pr-merge` を実行してよい",
  "エージェントが `brw pr-merge` を実行できる",
  "エージェントがマージしてよい",
  "許可を得ればエージェントがマージ",
  "利用者の許可を得てマージ",
  "利用者の許可を得れば `gh pr merge`",
  "`!` で実行してよい",
  "保護ブランチ向けも `brw pr-merge` でマージする",
  "切り出し元・保護ブランチへのマージは利用者の許可を得る",
  "マージ（`gh pr merge` など）は対象外で、常に確認を求める",
];
const contradictionsIn = (text) => MERGE_CONTRADICTIONS.filter((p) => text.includes(p));

// 見出し（完全一致）から、次の「## 」または「### 」見出しまでの本文（小節だけを切り出す）
const subsectionOf = (text, heading) => {
  const lines = text.split("\n");
  const i = lines.findIndex((l) => l === heading);
  if (i < 0) return "";
  const out = [];
  for (let k = i + 1; k < lines.length && !/^#{2,3} /.test(lines[k]); k++) out.push(lines[k]);
  return out.join("\n");
};

export const prMergeGaps = (text) => {
  const gaps = [];
  const need = (name, ok) => { if (!ok) gaps.push(name); };
  const rules = sectionOf(text, RULES);
  need("守ること: 切り出し元・保護ブランチへのマージはエージェントが行わないと同じ文で言う", rules.includes("切り出し元・保護ブランチへのマージはエージェントが行わない。"));
  need("守ること: 利用者の許可があってもエージェントは実行できないと言う", rules.includes("利用者の許可があってもエージェントは実行できない。"));
  need("守ること: 旧い「マージは利用者の許可を得る」を残さない", !text.includes("切り出し元・保護ブランチへのマージは利用者の許可を得る"));
  need("守ること: マージの文に反対の指示を含まない", contradictionsIn(rules).length === 0);

  const sec = sectionOf(text, "## 4. 変更作業の完了と公開（push・PR）");
  need("PR のマージ: 旧い「利用者が GitHub 上で PR を squash マージする」を残さない", !sec.includes("利用者が GitHub 上で PR を squash マージする"));
  need("PR のマージ: 手順 4 は取り込み先ごとの手順へ従わせる形", /^4\. 利用者が PR をマージする。取り込み先ごとの手順は下の「PR のマージ（取り込み先ごと）」に従う。/m.test(sec));
  need("PR のマージ: 4 章全体に反対の指示を含まない", contradictionsIn(sec).length === 0);

  const branch = itemOf(sec, "**分岐元向けの PR");
  need("分岐元: 項目がある", branch !== "");
  need("分岐元: 利用者が自分の端末で brw pr-merge <PR 番号> を実行する（同じ項目内）", branch.includes("利用者が自分の端末で `brw pr-merge <PR 番号>` を実行する"));
  need("分岐元: 対話端末が必要（同じ項目内）", branch.includes("対話端末が必要"));
  need("分岐元: 確認した SHA を指定して squash マージされる（同じ項目内）", branch.includes("確認した SHA を指定して squash マージされる"));
  need("分岐元: `!` は端末判定を満たさない可能性があるため別の端末で実行する（同じ項目内）", /`!` での実行は端末判定を満たさない可能性があるため、別の端末で実行する。/.test(branch));
  need("分岐元: 反対の指示を含まない（同じ項目内）", contradictionsIn(branch).length === 0);

  const prot = itemOf(sec, "**保護ブランチ（`protectedBranches`）向けの PR**");
  need("保護: 項目がある", prot !== "");
  need("保護: brw pr-merge は拒否する（同じ項目内）", prot.includes("`brw pr-merge` は拒否する"));
  need("保護: GitHub 上で条件を満たす利用者がマージする（同じ項目内）", prot.includes("利用者が GitHub 上でマージする"));
  need("保護: 反対の指示を含まない（同じ項目内）", contradictionsIn(prot).length === 0);

  const rej = itemOf(sec, "**開発ブランチ向け・宣言外のブランチ向け");
  need("拒否: 開発・宣言外・別リポジトリ・開いていない PR は brw pr-merge が拒否する（同じ項目内）", /別リポジトリ（フォーク）向け・開いていない PR.*`brw pr-merge` が拒否する/s.test(rej));

  const agent = itemOf(sec, "**エージェント**");
  need("エージェント: gh pr merge・API・MCP・自動マージ予約・brw pr-merge 実行をしない（同じ項目内）", /`gh pr merge`・GitHub の API・MCP によるマージ、自動マージの予約、`brw pr-merge` の実行をしない/.test(agent));
  need("エージェント: 利用者に別の端末での実行を依頼する（同じ項目内）", agent.includes("利用者に別の端末での実行を依頼する"));
  need("エージェント: 反対の指示を含まない（同じ項目内）", contradictionsIn(agent).length === 0);

  const tok = itemOf(sec, "**トークン**");
  need("トークン（SKILL）: 利用者のものに限る（同じ項目内）", tok.includes("利用者のものに限る"));
  need("トークン（SKILL）: エージェントの環境にマージ権限のあるトークンを渡さない（同じ項目内）", tok.includes("エージェントの環境にマージ権限のあるトークンを渡さない"));
  return gaps;
};

// 18.6: 導入の資料（setup.md）の「### PR のマージ（利用者の端末）」の節だけを対象に、項目ごとの成立を確かめる
export const setupMergeGaps = (text) => {
  const gaps = [];
  const need = (name, ok) => { if (!ok) gaps.push(name); };
  const sec = subsectionOf(text, "### PR のマージ（利用者の端末）");
  need("setup: PR のマージの小節がある", sec !== "");
  need("setup: 小節に反対の指示を含まない", contradictionsIn(sec).length === 0);

  const branch = itemOf(sec, "**分岐元向けの PR**");
  need("setup 分岐元: 利用者が自分の端末で brw pr-merge <PR 番号> を実行する（同じ項目内）", branch.includes("利用者が自分の端末で `brw pr-merge <PR 番号>` を実行する"));
  need("setup 分岐元: 対話端末が必要（同じ項目内）", branch.includes("対話端末が必要"));
  need("setup 分岐元: `!` は端末判定を満たさないため別の端末で実行する（同じ項目内）", /`!` での実行は端末判定を満たさない可能性があるため、別の端末で実行する。/.test(branch));

  const prot = itemOf(sec, "**保護ブランチ向けの PR**");
  need("setup 保護: brw pr-merge は拒否する（同じ項目内）", prot.includes("`brw pr-merge` は拒否する"));
  need("setup 保護: GitHub 上でマージする（同じ項目内）", prot.includes("GitHub 上でマージする"));

  const tok = itemOf(sec, "**トークン**");
  need("setup トークン: GH_TOKEN・GITHUB_TOKEN・gh auth login の保存済みログインを挙げる（同じ項目内）", tok.includes("`GH_TOKEN`・`GITHUB_TOKEN`・`gh auth login` の保存済みログイン"));
  need("setup トークン: 利用者のものに限る（同じ項目内）", tok.includes("利用者のものに限る"));
  need("setup トークン: エージェントの環境にマージ権限のあるトークンを渡さない（同じ項目内）", tok.includes("エージェントの環境にマージ権限のあるトークンを渡さない"));

  const bypass = itemOf(sec, "**迂回の限界**");
  need("setup 迂回: 端末判定は協調的な誤用の防止で、疑似端末などによる迂回を防ぐ強制ではない（同じ項目内）", bypass.includes("協調的な誤用の防止") && bypass.includes("迂回を防ぐ強制ではない"));
  need("setup 迂回: 迂回を許さない保証は GitHub 側のマージ権限と Ruleset が与える（同じ項目内）", bypass.includes("GitHub 側のマージ権限と Ruleset が与える"));

  const cond = itemOf(sec, "**マージ条件**");
  need("setup 条件: 必須チェック・レビューは GitHub 側が決め、満たさないと 405 で拒否する（同じ項目内）", cond.includes("GitHub が 405 で拒否し"));

  const state = itemOf(sec, "**状態**");
  need("setup 状態: 状態ファイルを作らず、ブランチを削除しない（片付けは brw finish）（同じ項目内）", state.includes("状態ファイル") && state.includes("ブランチを削除しない") && state.includes("`brw finish`"));
  return gaps;
};

// config.md: autoApprove の節で、エージェントのマージが確認ではなく拒否であることを確かめる
export const configMergeGaps = (text) => {
  const gaps = [];
  const need = (name, ok) => { if (!ok) gaps.push(name); };
  const sec = sectionOf(text, AUTO);
  need("config: エージェントのマージ（gh pr merge・API・MCP・自動マージ予約）は常に拒否される（確認ではなく拒否）と同じ文で言う", sec.includes("エージェントによる `gh pr merge`・GitHub の API・MCP のマージ・自動マージの予約は常に拒否される（確認ではなく拒否）。"));
  need("config: 分岐元向けは利用者が brw pr-merge を実行すると同じ文で言う", sec.includes("分岐元向けは利用者が自分の端末で `brw pr-merge` を実行する。"));
  need("config: brw pr-merge も autoApprove の対象外で、利用者が自分の端末で実行すると同じ文で言う", sec.includes("`brw pr-merge` も `autoApprove` の対象外で、利用者が自分の端末で実行する。"));
  need("config: brw pr-merge を autoApprove の対象（確認を省く）と言わない", !sec.includes("`brw pr-merge` も `autoApprove` の対象で、確認を省く"));
  need("config: マージの文で「Codex の brw guard には影響しない」を残さない（マージの拒否とは別の判定）", !sec.includes("`brw guard` には影響しない"));
  need("config: 旧い「常に確認を求める」を残さない", !text.includes("マージ（`gh pr merge` など）は対象外で、常に確認を求める"));
  need("config: マージの文に反対の指示を含まない", contradictionsIn(sec).length === 0);
  return gaps;
};

// 8.3: 分岐元から保護ブランチへの PR の手順（SKILL.md の 4 章の項目）と、受け付けられない組の手作業の手順が文として成立しているか。
// 必要な文は同じ項目の中で成立していること、反対の指示（別コミット・分岐元での作成・片付け）を含まないことを確かめる。
const BASE_PR_SECTION = "## 4. 変更作業の完了と公開（push・PR）";
const BASE_PR_ITEM = "**分岐元から保護ブランチへの PR**";
const BASE_PR_MANUAL = "**`brw pr` で作れない組の手作業**";
const BASE_PR_CONTRADICTIONS = [
  "分岐元で `brw create`",
  "別コミットを作る",
  "分岐元のブランチを片付ける",
  "直接の `gh pr create` で作る",
];
const contradictsIn = (text) => BASE_PR_CONTRADICTIONS.filter((p) => text.includes(p));
// 4 章全体に出してはいけない分岐元の誤った指示（分岐元で作業を始める・分岐元を片付ける）
const SECTION_CONTRADICTIONS = ["分岐元で `brw create`", "分岐元で別コミットを作る", "分岐元のブランチを片付ける", "分岐元を片付ける"];
// マーカーを含む 1 文（句点「。」で区切る）。無ければ空文字
const sentenceOf = (text, marker) => text.split("。").find((s) => s.includes(marker)) ?? "";

export const basePrGaps = (text) => {
  const gaps = [];
  const need = (name, ok) => { if (!ok) gaps.push(name); };
  const sec = sectionOf(text, BASE_PR_SECTION);
  need("分岐元PR: 4 章の節がある", sec !== "");

  const item = itemOf(sec, BASE_PR_ITEM);
  need("分岐元PR: 項目がある", item !== "");
  need("分岐元PR: 分岐元のチェックアウトで次の順に行うと同じ項目で言う", item.includes("分岐元のチェックアウトで次の順に行う"));
  need("分岐元PR: brw pr-template で本文の雛形と記入指示を得る（同じ項目内）", item.includes("`brw pr-template`"));
  need("分岐元PR: 比較は fetch の後に git log・git diff --stat で確かめる（同じ項目内）", item.includes("git fetch") && item.includes("`git log`") && item.includes("`git diff --stat`"));
  need("分岐元PR: brw pr --title で作る（同じ項目内）", item.includes("`brw pr --title \"<タイトル>\"`"));
  need("分岐元PR: 取り込み → 作成 → 報告の 3 段だけ（同じ項目内）", item.includes("3 段（取り込み → 作成 → 報告）だけ"));
  need("分岐元PR: 作業の記録・別コミット・push・片付けは行わない（同じ項目内）", item.includes("作業の記録・別コミット・push・片付けは行わない"));
  need("分岐元PR: 分岐元のブランチと作業場所は残る（同じ項目内）", item.includes("分岐元のブランチと作業場所は残る"));
  need("分岐元PR: 未コミットの変更は PR に含まれず件数が表示される（同じ項目内）", item.includes("未コミットの変更は PR に含まれず") && item.includes("件数が表示される"));
  need("分岐元PR: 止まる場合（未 push・分岐・差なし・本文・作成先）を挙げる（同じ項目内）", ["未 push", "分岐", "差がない", "本文", "`--target <保護ブランチ>`"].every((w) => item.includes(w)));
  need("分岐元PR: 承認が必要なとき --confirmed の全文を利用者が自分の端末で実行する（同じ項目内）", item.includes("`--confirmed`") && item.includes("利用者が自分の端末で"));
  need("分岐元PR: 作成した PR のマージは brw pr-merge か GitHub 上（同じ項目内）", item.includes("`brw pr-merge`") && item.includes("GitHub 上"));
  need("分岐元PR: 反対の指示を含まない（同じ項目内）", contradictsIn(item).length === 0);

  // 場合ごとに、その場合の「1 文」の中で成立していることを確かめる（別の場合の語を同じ文に混ぜても通さない）
  const manual = itemOf(sec, BASE_PR_MANUAL);
  need("手作業: 項目がある", manual !== "");
  const dev = sentenceOf(manual, "開発ブランチ間");
  need("手作業 開発間: PR を使わず brw merge <取り込み元> を示す（同じ文内）", dev.includes("PR を使わず") && dev.includes("`brw merge <取り込み元>`"));
  need("手作業 開発間: 作成画面の URL を出さない（同じ文内）", dev !== "" && !dev.includes("compare/"));
  const same = sentenceOf(manual, "取り込み元と取り込み先が同じ");
  need("手作業 同名: 取り込みは不要と示す（同じ文内）", same.includes("取り込みは不要"));
  need("手作業 同名: 作成画面の URL も brw merge も示さない（同じ文内）", same !== "" && !same.includes("compare/") && !same.includes("brw merge"));
  const other = sentenceOf(manual, "宣言外のブランチ");
  need("手作業 その他: 宣言外・保護が取り込み元・分岐元→分岐元/開発を挙げる（同じ文内）", ["宣言外のブランチ", "保護ブランチを取り込み元", "分岐元→分岐元/開発"].every((w) => other.includes(w)));
  need("手作業 その他: GitHub 上で PR を作成し、拒否の案内に出る作成画面の URL を開く（同じ文内）", other.includes("拒否") && other.includes("GitHub 上で PR を作成") && other.includes("作成画面の URL") && other.includes("`https://github.com/<owner>/<repo>/compare/<base>...<head>?expand=1`"));
  const web = sentenceOf(manual, "Web 画面");
  need("手作業 Web: URL が出ないときは Web 画面（Pull requests → New pull request）で取り込み先と取り込み元を選ぶ（同じ文内）", web.includes("URL が出ない") && web.includes("Pull requests → New pull request") && web.includes("取り込み先と取り込み元を選んで"));
  const main = sentenceOf(manual, "`main` が唯一の分岐元");
  need("手作業 main: GitHub 上で作成するか宣言を見直す（同じ文内）", main.includes("GitHub 上で作成するか宣言を見直す"));
  need("手作業: 反対の指示を含まない（同じ項目内）", contradictsIn(manual).length === 0);
  return gaps;
};

// 8.3: 4 章の冒頭の分岐（開発ブランチ向けの手順と、分岐元の専用の手順）と、開発ブランチ向けの項目の適用範囲、4 章全体の矛盾
export const scopeGaps = (text) => {
  const gaps = [];
  const need = (name, ok) => { if (!ok) gaps.push(name); };
  const sec = sectionOf(text, BASE_PR_SECTION);
  const intro = sec.split("\n1. ")[0];
  need("4章冒頭: 開発ブランチ向けの手順と、分岐元の専用の手順の分岐を 1 文で言う", intro.includes("この章の 1〜4 の手順と下の各項目は開発ブランチでの作業向け。分岐元から保護ブランチへの PR は、下の専用の項目（分岐元から保護ブランチへの PR）の手順を使う（作業ブランチは作らず、別コミット・push・片付けは行わない）。"));
  const unc = itemOf(sec, "**未コミットの変更の扱い**");
  need("適用範囲: 未コミットの項目に（開発ブランチの場合）を付ける", unc.includes("**未コミットの変更の扱い**（開発ブランチの場合）"));
  const clean = itemOf(sec, "**片付け**");
  need("適用範囲: 片付けの項目に（開発ブランチの場合）を付ける", clean.includes("**片付け**（開発ブランチの場合）"));
  need("4章全体: 分岐元の誤った指示（分岐元で作業を始める・別コミット・片付け）を含まない", SECTION_CONTRADICTIONS.every((p) => !sec.includes(p)));
  return gaps;
};

// 8.3: 資料（setup.md の小節・config.md の一文）が分岐元からの PR の手順を指すか
export const basePrRefGaps = (setupText, configText) => {
  const gaps = [];
  const need = (name, ok) => { if (!ok) gaps.push(name); };
  const sec = subsectionOf(setupText, "### 分岐元から保護ブランチへの PR（分岐元のチェックアウト）");
  need("資料 setup: 分岐元からの PR の小節がある", sec !== "");
  need("資料 setup: 分岐元のチェックアウトで brw pr-template と brw pr を実行すると同じ小節で言う", sec.includes("分岐元のチェックアウト") && sec.includes("`brw pr-template`") && sec.includes("`brw pr`"));
  need("資料 setup: 取り込み → 作成 → 報告の 3 段で、作業の記録・別コミット・片付けは行わないと同じ小節で言う", sec.includes("3 段") && sec.includes("別コミット") && sec.includes("片付け"));
  need("資料 setup: 詳しい手順は SKILL.md の 4 章を指す", sec.includes("SKILL.md の 4 章"));
  const cfg = sectionOf(configText, AUTO);
  need("資料 config: 分岐元（baseBranch）から保護ブランチへの PR は brw pr で作ると文で言う", configText.includes("分岐元（`baseBranch`）から保護ブランチへの PR は、`brw pr` で作る。"));
  need("資料 config: push: false のとき、この PR も通常の承認に回ると同じ文で言う", /push: false`.*この PR も通常の承認に回る/s.test(cfg));
  return gaps;
};

// 9.5: 公開後の続きの作業の再開（SKILL.md の 3 章・4 章、references/setup.md の小節）が文として成立しているか。
// 必須の文ごとに、マーカーを含む 1 文が必要な語句をすべて含み、否定の語（ない・なく・ず）が「その文で許可した語句」以外に残らないことを確かめる。
// 許可リスト（allowed）は最小限にし、各語句が正規の文で否定として必要な理由を下にコメントで示す。
const RESUME_REVERSALS = ["残らない", "別のセッションでも", "すべての PR", "見ないが", "閉じた PR も再利用", "必ず書かれ", "無条件に"];
const NEG_TOKENS = ["ない", "なく", "ず"];
// 許可した語句を取り除いた後に、否定の語が残るか
const negsLeft = (x, allowed) => {
  let t = x;
  for (const a of allowed) t = t.split(a).join("");
  return NEG_TOKENS.filter((n) => t.includes(n));
};
export const resumeGaps = (skill, setup) => {
  const gaps = [];
  const need = (name, ok) => { if (!ok) gaps.push(name); };
  const s3 = sectionOf(skill, "## 3. 片付けと再開");
  const s4 = sectionOf(skill, "## 4. 変更作業の完了と公開（push・PR）");
  const sub = subsectionOf(setup, "### 公開後の続きの作業（再開）");
  need("続き 3章: 節がある", s3 !== "");
  need("続き 資料: 小節がある", sub !== "");
  // 必須の文 1 件（マーカーで文を選ぶ。語句の欠落と、否定の混入を検出する）
  // 許可した否定は、その文に必ず含まれること（肯定へ反転したら失敗する）。許可外の否定は含まないこと
  const sent = (where, text, label, marker, required, allowed = []) => {
    const x = sentenceOf(text, marker);
    const ok = x !== "" && required.every((w) => x.includes(w)) && allowed.every((w) => x.includes(w)) && negsLeft(x, allowed).length === 0;
    need(`続き ${where}: ${label}（同じ文内。否定は許可したものだけ）`, ok);
  };

  // 3 章: 続きの作業は同じブランチで再開する（「作らず」は、新しいブランチを作らないという正規の否定）
  sent("3章", s3, "新しい作業ブランチを作らず brw resume <ブランチ> で同じブランチを再開する", "同じブランチを再開する", ["新しい作業ブランチを作らず", "`brw resume <ブランチ>`"], ["作らず"]);
  sent("3章", s3, "新しい機能のときだけ brw create", "新しい機能のときだけ", ["`brw create`"]);
  sent("3章", s3, "片付け後の出力に再開のコマンドと新しい作業のコマンドが出る", "続きの再開のコマンド", ["`brw resume <ブランチ>`", "`brw create <名前>`"]);

  // 再開の記録と失敗時: 記録は書けたときに残る。失敗時は警告だけで、記録が無い（または古い）と、案内や先頭に並ばないことがある（断定しない）
  sent("3章", s3, "再開の記録は本体に書けたときに残る", "書けたときに残る", ["本体に書けたときに残る"]);
  sent("3章", s3, "書き込みに失敗したときは警告だけを出し、片付けは完了する", "書き込みに失敗したとき", ["警告だけを出し", "片付けは完了する"]);
  // 許可: 「ならない」「並ばない」は、「ことがある」の前提で可能性を言う正規の否定（断定の「ない」ではない）
  sent("3章", s3, "この記録が無い（または古い）と、フックの案内の対象にならないことがあり、一覧でも公開の記録つきの先頭に並ばないことがある", "この記録が無い", ["この記録が無い", "または古い", "フックの案内の対象にならないことがあり", "一覧でも公開の記録つきの先頭に並ばないことがある"], ["ならない", "並ばない"]);
  sent("3章", s3, "そのときも brw resume <ブランチ> で再開できる", "そのときも", ["`brw resume <ブランチ>`", "再開できる"]);

  // 一覧: 取得済みの origin の追跡ブランチから最大 20 件を出す（最新でなければ先に git fetch）
  sent("3章", s3, "一覧は取得済みの origin の追跡ブランチから作業場所が無い開発ブランチを最大 20 件出す（最新でなければ先に git fetch）", "最大 20 件", ["取得済みの `origin` の追跡ブランチから", "作業場所が無い", "最大 20 件", "最新でなければ先に `git fetch`"]);
  sent("3章", s3, "公開の記録があるものを先頭に新しい順に置き、記録の無いものは後ろに名前順で並べる", "公開の記録があるものを先頭", ["公開の記録があるものを先頭に新しい順に置き", "後ろに名前順で並べる"]);
  sent("3章", s3, "20 件を超えるときは brw resume <ブランチ> で直接指定する", "20 件を超える", ["`brw resume <ブランチ>`", "直接指定する"]);

  // フックの案内: 同じセッションで公開して片付けた記録・24 時間以内・作業場所が無くリモートにある・新しい作業なら無視
  sent("3章", s3, "フックの案内は同じセッションの次の入力で、同じセッション・24 時間以内・作業場所が無くリモートにあるものに限る", "文脈として渡す", ["同じセッションの次の入力", "`brw resume <ブランチ>`", "同じセッションで公開して片付けた記録", "24 時間以内", "作業場所が無くリモートにある"]);
  sent("3章", s3, "新しい作業なら案内は無視してよい", "無視してよい", ["新しい作業なら"]);
  // 許可: 「動かない」は、削除後にフックが動かないという事実の否定
  sent("3章", s3, "作業場所の中で開始した場合は一覧と手順書で再開する", "フックが動かない", ["一覧", "手順書", "再開する"], ["動かない"]);

  // 続きの公開（3 章）: 「でない」は draft でないという条件、「できない」は照合できないという条件の正規の否定
  sent("3章", s3, "同じ head のオープンな PR が 1 件あり、取り込み先が同じで、draft でないとき、既存の PR が再利用される", "既存の PR が再利用される", ["`brw pr`", "同じ head のオープンな PR が 1 件あり", "取り込み先が同じで", "draft でないとき", "既存の PR が再利用される"], ["でない"]);
  sent("3章", s3, "取り込み先が違う・複数ある・draft・照合できないときは止まり、理由が表示される", "取り込み先が違う", ["止まり", "理由が表示される"], ["できない"]);
  // 許可: 「再利用されず」は、閉じた PR を再利用しないという正規の否定
  sent("3章", s3, "閉じた PR は再利用されず、新しく作られうる", "閉じた PR", ["再利用されず", "新しく作られうる"], ["再利用されず"]);
  sent("3章", s3, "作業ディレクトリが戻ったら cd <本体> で本体へ移ってから続ける", "`cd <本体>`", ["本体へ移ってから続ける"]);

  // 4 章（片付け後の続き）: 3 章と同じ必須語句の組（1 件・取り込み先が同じ・draft でない）と、止まり、閉じた PR
  sent("4章", s4, "片付け後の続きは新しい作業ブランチを作らず brw resume で再開し、続きを brw pr で公開すると、そのブランチを head とするオープンな PR が 1 件あり、取り込み先が同じで、draft でないとき既存の PR が再利用される", "**片付け後の続き**", ["新しい作業ブランチを作らず", "`brw resume <ブランチ>`", "`brw pr`", "head とするオープンな PR が 1 件あり", "取り込み先が同じで", "draft でないとき", "既存の PR が再利用される"], ["作らず", "でない"]);
  sent("4章", s4, "取り込み先が違う・複数ある・draft・照合できないときは止まり、理由を表示する", "取り込み先が違う・複数ある", ["止まり", "理由を表示する"], ["できない"]);
  sent("4章", s4, "閉じた PR は再利用されず、新しく作られうる", "閉じた PR", ["再利用されず", "新しく作られうる"], ["再利用されず"]);

  // 資料（setup.md の小節）
  sent("資料", sub, "新しい作業ブランチを作らず brw resume <ブランチ> で再開する", "新しい作業ブランチを作らず", ["`brw resume <ブランチ>`"], ["作らず"]);
  sent("資料", sub, "brw resume（引数なし）で再開できる作業ブランチを一覧する", "一覧を出す", ["（引数なし）"]);
  sent("資料", sub, "書き込みに失敗したときは警告だけが出て片付けは完了する", "書けなかったとき", ["警告だけが出て", "片付けは完了する"]);
  sent("資料", sub, "再開の記録は本体に書けたときに残る", "書けたときに残る", ["本体に書けたときに残る"]);
  sent("資料", sub, "この記録が無い（または古い）と、フックの案内の対象にならないことがあり、一覧でも公開の記録つきの先頭に並ばないことがある", "この記録が無い", ["または古い", "フックの案内の対象にならないことがあり", "一覧でも公開の記録つきの先頭に並ばないことがある"], ["ならない", "並ばない"]);
  sent("資料", sub, "そのときも brw resume <ブランチ> で再開できる", "そのときも", ["`brw resume <ブランチ>`", "再開できる"]);
  sent("資料", sub, "フックの案内は同じセッションで公開して片付けた記録のうち、24 時間以内で、作業場所が無くリモートにあるものに限る", "文脈として渡す", ["同じセッションで公開して片付けた記録", "24 時間以内", "作業場所が無くリモートにある"]);
  // 許可: 「動かない」は、上と同じ事実の否定
  sent("資料", sub, "作業場所の中で開始した場合は、brw resume（引数なし）の一覧と手順書で再開する", "フックが動かない", ["（引数なし）", "一覧", "手順書", "再開する"], ["動かない"]);
  sent("資料", sub, "新しい作業なら無視してよい", "無視してよい", ["新しい作業なら"]);
  sent("資料", sub, "同じ head のオープンな PR が 1 件あり、取り込み先が同じで、draft でないとき既存の PR が再利用される（brw pr）", "既存の PR が再利用される", ["`brw pr`", "同じ head のオープンな PR が 1 件あり", "取り込み先が同じで", "draft でないとき", "既存の PR が再利用される"], ["でない"]);
  sent("資料", sub, "取り込み先が違う・複数ある・draft・照合できないときは止まり、理由が表示される", "取り込み先が違う", ["止まり", "理由が表示される"], ["できない"]);
  sent("資料", sub, "閉じた PR は再利用されず、新しく作られうる", "閉じた PR", ["再利用されず", "新しく作られうる"], ["再利用されず"]);

  // 条件の反転を示す語を、節の中に含まない
  for (const [where, text] of [["3 章", s3], ["4 章", s4], ["資料の小節", sub]]) {
    const hits = RESUME_REVERSALS.filter((w) => text.includes(w));
    need(`続き ${where}: 条件を反転・否定する語（${hits.join("・") || "なし"}）を含まない`, hits.length === 0);
  }
  return gaps;
};

// 9.5: 評価ケース continues-after-pr-cleanup の構成と、制約・判定の文
export const continueCaseGaps = (dir, readFile, fixtureText) => {
  const gaps = [];
  const need = (name, ok) => { if (!ok) gaps.push(name); };
  const files = ["case.yaml", "prompt.md", "place-files.sh"];
  need("評価 続き: 構成ファイルがそろう", files.every((f) => existsSync(join(dir, f))));
  need("評価 続き: graders が 1 つ以上ある", existsSync(join(dir, "graders")) && readdirSync(join(dir, "graders")).length >= 1);
  if (!existsSync(join(dir, "case.yaml"))) return gaps;
  const yaml = readFile(join(dir, "case.yaml"));
  need("評価 続き: name が名前と一致する", yaml.includes("name: continues-after-pr-cleanup"));
  need("評価 続き: 評価環境の制約（ローカルの bare・GitHub に接続しない）を明記する", yaml.includes("評価環境") && yaml.includes("ローカルの bare") && yaml.includes("GitHub に接続しない"));
  need("評価 続き: 実際の評価は未実行である旨を明記する", yaml.includes("未実行"));
  if (existsSync(join(dir, "place-files.sh"))) {
    const ps = readFile(join(dir, "place-files.sh"));
    need("評価 続き: 共通の fixture の published-cleaned バリアントを使う", ps.includes("published-cleaned") && fixtureText.includes("published-cleaned)"));
  }
  if (existsSync(join(dir, "prompt.md"))) {
    need("評価 続き: 依頼は公開後の検証の失敗の続き", readFile(join(dir, "prompt.md")).includes("検証が通らなかった"));
  }
  return gaps;
};

// 変異版: 対象の語句を置き換えた合成の文書を作る（語句が無ければ null）
const mutate = (text, from, to) => (text.includes(from) ? text.replace(from, to) : null);

const docFiles = () => {
  const out = ["SKILL.md"];
  for (const dir of ["references", "assets"]) {
    for (const f of readdirSync(join(root, dir))) if (statSync(join(root, dir, f)).isFile()) out.push(join(dir, f));
  }
  return out;
};

export const runInstructionChecks = (eq) => {
  const skill = read("SKILL.md");
  const config = read("references/config.md");
  const example = JSON.parse(read("assets/config.example.json"));

  // ---- 節・項目ごとの文の成立（実際の文書） ----
  eq("instructions/17.1 SKILL.md の手順の文が節・項目の中で成立している", procedureGaps(skill), []);
  eq("instructions/17.1 config.md の push: false の扱いが例と文の両方で成立している", configGaps(config), []);

  // ---- 変異版: 反転・削除した文書を同じ確認が検出する（確認そのものの試験） ----
  const mutants = [
    ["git add -A を使う（反転）", "`git add -A` は使わない。", "`git add -A` を使う。"],
    ["push 禁止の commit までにとどめを削除", "commit までにとどめ、未 push であることを報告する。", "未 push であることを報告する。"],
    ["[block] の案内の従う指示を削除", "`[block]` なら、表示された案内に従って", "`[block]` なら、そのまま"],
    ["失敗の未完了の処理を削除", "成功した処理、未完了の処理、失敗の理由を報告し", "成功した処理と失敗の理由を報告し"],
    ["秘密情報の除外を削除", "秘密情報らしいファイル（`.env`・`*.pem`・`*credentials*` など）を含めない。", ""],
    ["恒常的な分岐元の区切りの禁止を削除", "保護ブランチ・恒常的な分岐元・宣言に無いブランチでは区切りの commit・push を行わない", "保護ブランチでは区切りの commit・push を行わない"],
  ];
  for (const [name, from, to] of mutants) {
    const m = mutate(skill, from, to);
    eq(`instructions/17.1 変異版「${name}」を検出する`, m !== null && procedureGaps(m).length > 0, true);
  }
  const cfgMutants = [
    ["push: false の確認省略の無効を有効へ反転", "`autoApprove.push: false` は、push の確認省略を無効にする設定である。", "`autoApprove.push: false` は、push の確認省略を有効にする設定である。"],
    ["push: false の未 push の報告を削除", "commit までにとどめて未 push を報告する（未コミット", "commit までにとどめる（未コミット"],
    ["連結の git add の範囲を削除（-A のみ）", "`git add`（`-A`・`-u`・`--all`・`-N`・`-v` とパスだけ）", "`git add`（`-A` のみ）"],
  ];
  for (const [name, from, to] of cfgMutants) {
    const m = mutate(config, from, to);
    eq(`instructions/17.1 config 変異版「${name}」を検出する`, m !== null && configGaps(m).length > 0, true);
  }

  // ---- 18.6: 取り込み先ごとの PR のマージ（文の成立・矛盾・変異版） ----
  const setup = read("references/setup.md");
  eq("instructions/18.6 SKILL.md の PR のマージの手順が取り込み先ごとに成立している", prMergeGaps(skill), []);
  eq("instructions/18.6 setup.md の PR のマージの小節が成立している", setupMergeGaps(setup), []);
  eq("instructions/18.6 config.md のエージェントのマージの扱いが成立している", configMergeGaps(config), []);

  const mergeMutants = [
    ["分岐元の「別の端末で実行する」を削除", skill, "可能性があるため、別の端末で実行する。", "可能性がある。", prMergeGaps],
    ["保護ブランチ向けを GitHub 上から brw pr-merge へ反転", skill, "利用者が GitHub 上でマージする。", "利用者が `brw pr-merge` でマージする。", prMergeGaps],
    ["SKILL のトークンの「利用者のものに限る」を削除", skill, "は利用者のものに限る。", "は誰のものでもよい。", prMergeGaps],
    ["SKILL 分岐元の項目に「エージェントが brw pr-merge を実行してよい」を追加（矛盾）", skill, "別の端末で実行する。", "別の端末で実行する。エージェントが `brw pr-merge` を実行してよい。", prMergeGaps],
    ["SKILL 保護の項目に「保護ブランチ向けも brw pr-merge でマージする」を追加（矛盾）", skill, "利用者が GitHub 上でマージする。", "利用者が GitHub 上でマージする。保護ブランチ向けも `brw pr-merge` でマージする。", prMergeGaps],
    ["SKILL 守ることを旧い「マージは利用者の許可を得る」へ戻す", skill, "切り出し元・保護ブランチへのマージはエージェントが行わない。", "切り出し元・保護ブランチへのマージは利用者の許可を得る。", prMergeGaps],
    ["setup の分岐元の「`!` での実行」の注意を削除", setup, "Claude Code の `!` での実行は端末判定を満たさない可能性があるため、別の端末で実行する。", "別の端末で実行する。", setupMergeGaps],
    ["setup のトークンの「利用者のものに限る」を削除", setup, "は利用者のものに限る。", "は誰のものでもよい。", setupMergeGaps],
    ["setup の迂回の限界（強制ではない）を反転", setup, "迂回を防ぐ強制ではない。", "迂回を防ぐ強制である。", setupMergeGaps],
    ["setup の状態ファイルの禁止を削除", setup, "状態ファイルや作業の記録を作らず、", "", setupMergeGaps],
    ["setup の分岐元の項目に「`!` で実行してよい」を追加（矛盾）", setup, "別の端末で実行する。", "別の端末で実行する。`!` で実行してよい。", setupMergeGaps],
  ];
  for (const [name, doc, from, to, gapsOf] of mergeMutants) {
    const m = mutate(doc, from, to);
    eq(`instructions/18.6 変異版「${name}」を検出する`, m !== null && gapsOf(m).length > 0, true);
  }
  // 項目を小節の外（### PR のマージの次の見出しの後ろ）へ移した合成文書
  const branchLine = setup.split("\n").find((l) => l.startsWith("- **分岐元向けの PR**"));
  const moved = branchLine
    ? setup.replace(branchLine + "\n", "").replace("## 4. Ruleset とフックを導入する（brw setup）", "## 4. Ruleset とフックを導入する（brw setup）\n\n" + branchLine)
    : null;
  eq("instructions/18.6 変異版「分岐元の項目を小節の外へ移す」を検出する", moved !== null && setupMergeGaps(moved).length > 0, true);
  const cfgMergeMutants = [
    ["config のエージェントのマージを許可制へ反転", config, "常に拒否される（確認ではなく拒否）。", "利用者の許可を得れば実行できる（確認を求める）。"],
    ["config に「利用者の許可を得ればエージェントがマージできる」を追加（矛盾）", config, "分岐元向けは利用者が自分の端末で `brw pr-merge` を実行する。", "分岐元向けは利用者が自分の端末で `brw pr-merge` を実行する。利用者の許可を得ればエージェントがマージできる。"],
  ];
  for (const [name, doc, from, to] of cfgMergeMutants) {
    const m = mutate(doc, from, to);
    eq(`instructions/18.6 config 変異版「${name}」を検出する`, m !== null && configMergeGaps(m).length > 0, true);
  }
  // brw pr-merge の対象外の一文: 削除・反転した合成文書を configMergeGaps に渡し、ギャップが報告されることを確かめる
  const excludeSentence = "`brw pr-merge` も `autoApprove` の対象外で、利用者が自分の端末で実行する。";
  const excludeMutants = [
    ["brw pr-merge の対象外の一文を削除", excludeSentence, ""],
    ["brw pr-merge を autoApprove の対象（確認を省く）へ反転", excludeSentence, "`brw pr-merge` も `autoApprove` の対象で、確認を省く。"],
  ];
  for (const [name, from, to] of excludeMutants) {
    const m = mutate(config, from, to);
    eq(`instructions/18.6 config 変異版「${name}」を configMergeGaps が検出する`, m !== null && configMergeGaps(m).length > 0, true);
  }
  eq("instructions/18.6 config 変異版「Codex の brw guard の一文を戻す」を configMergeGaps が検出する", configMergeGaps(config.replace("分岐元向けは利用者が自分の端末で `brw pr-merge` を実行する。", "分岐元向けは利用者が自分の端末で `brw pr-merge` を実行する。Codex の `brw guard` には影響しない。")).length > 0, true);

  // ---- 旧い文面・例の残存 ----
  eq("instructions/17.1 旧い「許可を求めずに行ってよい」の文面を残さない", skill.includes("作業ブランチへの commit と push は、許可を求めずに行ってよい"), false);
  for (const f of docFiles()) {
    eq(`instructions/17.1 ${f} に「push: false」の確認を求める例を残さない`, read(f).includes('{ "push": false }'), false);
  }

  // ---- config.md: commit の項目・確認省略の範囲 ----
  const autoSec = sectionOf(config, AUTO);
  eq("instructions/17.1 config.md の commit の確認省略は --amend・--no-verify を対象外と書く", autoSec.includes("`--amend`") && autoSec.includes("`--no-verify`"), true);
  eq("instructions/17.1 config.md の例に commit を含める", config.includes(`{ "push": true, "pullRequest": true, "commit": true }`), true);

  // ---- assets/config.example.json ----
  eq("instructions/17.1 config.example.json の autoApprove に commit: true", example.autoApprove?.commit, true);
  eq("instructions/17.1 config.example.json は宣言の検証を通る", validateConfig(example), []);

  // ---- 禁止語: 呼び出し側の置き場を示す語を文書に出さない ----
  for (const f of docFiles()) {
    const text = read(f);
    const hit = FORBIDDEN.find((re) => re.test(text));
    eq(`instructions/17.1 ${f} に呼び出し側の置き場を示す語がない`, hit ? hit.source : null, null);
  }

  // ---- 評価ケース: commits-and-pushes-at-boundary の構成 ----
  const caseDir = join(root, "evals/commits-and-pushes-at-boundary");
  const caseFiles = ["case.yaml", "prompt.md", "place-files.sh"];
  eq("instructions/17.1 評価ケースの構成ファイルがそろう", caseFiles.every((f) => existsSync(join(caseDir, f))), true);
  eq("instructions/17.1 評価ケースの graders が 1 つ以上ある", existsSync(join(caseDir, "graders")) && readdirSync(join(caseDir, "graders")).length >= 1, true);
  if (existsSync(join(caseDir, "case.yaml"))) {
    const yaml = readFileSync(join(caseDir, "case.yaml"), "utf8");
    eq("instructions/17.1 評価ケースの name が名前と一致する", yaml.includes("name: commits-and-pushes-at-boundary"), true);
  }

  // ---- 8.3: 分岐元から保護ブランチへの PR（実際の文書・変異版・資料・評価ケース） ----
  const setupDoc = read("references/setup.md");
  const skillGaps = (t) => [...basePrGaps(t), ...scopeGaps(t)];
  eq("instructions/8.3 SKILL.md の分岐元からの PR・手作業・4 章の適用範囲が成立している", skillGaps(skill), []);
  eq("instructions/8.3 setup.md・config.md の分岐元からの PR の資料が成立している", basePrRefGaps(setupDoc, config), []);
  const basePrMutants = [
    ["3 段（取り込み → 作成 → 報告）を 2 段へ反転", skill, "3 段（取り込み → 作成 → 報告）だけ", "2 段（作成 → 報告）だけ"],
    ["作業の記録・別コミット・push・片付けは行わないを削除", skill, "作業の記録・別コミット・push・片付けは行わない", "作業の記録と push は行う"],
    ["分岐元のブランチと作業場所は残るを削除", skill, "分岐元のブランチと作業場所は残る", "分岐元のブランチは片付ける"],
    ["分岐元のチェックアウトの指定を削除（分岐元での作成を許す）", skill, "分岐元のチェックアウトで次の順に行う", "分岐元で `brw create` を実行し、次の順に行う"],
    ["分岐元の項目に「別コミットを作る」を追加（矛盾）", skill, "未コミットの変更は PR に含まれず", "別コミットを作る。未コミットの変更は PR に含まれず"],
    ["作成画面の URL を削除", skill, "`https://github.com/<owner>/<repo>/compare/<base>...<head>?expand=1`", "Web 画面"],
    ["開発ブランチ間の取り込みを brw pr へ反転", skill, "開発ブランチ間の取り込みは PR を使わず `brw merge <取り込み元>`", "開発ブランチ間の取り込みは `brw pr` で作る"],
    ["資料 setup の 3 段の注記を削除", setupDoc, "3 段（取り込み → 作成 → 報告）だけを行い、", ""],
    ["否定の反転: 作業の記録・別コミット・push・片付けは行わない → 行う", skill, "作業の記録・別コミット・push・片付けは行わないので", "作業の記録・別コミット・push・片付けは行うので"],
    ["適用範囲の削除: 4 章冒頭の開発ブランチ向けの限定", skill, "この章の 1〜4 の手順と下の各項目は開発ブランチでの作業向け。", ""],
    ["分岐元の項目に brw create を促す文を追加（矛盾）", skill, "分岐元のチェックアウトで次の順に行う。", "分岐元のチェックアウトで次の順に行う。分岐元で `brw create` を実行してから作業する。"],
    ["開発間の文に作成画面の URL を混ぜる", skill, "開発ブランチ間の取り込みは PR を使わず `brw merge <取り込み元>` を使う", "開発ブランチ間の取り込みは PR を使わず `brw merge <取り込み元>` を使い、作成画面の URL（`https://github.com/<owner>/<repo>/compare/<base>...<head>?expand=1`）も出る"],
    ["同名の場合分けの「取り込みは不要」を反転", skill, "取り込みは不要で、", "取り込みが必要で、"],
    ["未コミットの項目の（開発ブランチの場合）を削除", skill, "**未コミットの変更の扱い**（開発ブランチの場合）", "**未コミットの変更の扱い**"],
    ["片付けの（開発ブランチの場合）を削除", skill, "**片付け**（開発ブランチの場合）", "**片付け**"],
    ["Web 画面の取り込み先・取り込み元の選択を削除", skill, "取り込み先と取り込み元を選んで作成する", "作成する"],
  ];
  for (const [name, doc, from, to] of basePrMutants) {
    const m = mutate(doc, from, to);
    const gapsOf = doc === setupDoc
      ? (t) => basePrRefGaps(t, config)
      : skillGaps;
    eq(`instructions/8.3 変異版「${name}」を検出する`, m !== null && gapsOf(m).length > 0, true);
  }
  // 禁止語: 追加した手順の文に呼び出し側の置き場を示す語を出さない
  const basePrText = [sectionOf(skill, BASE_PR_SECTION)].join("\n");
  eq("instructions/8.3 追加した手順に呼び出し側の置き場を示す語がない", FORBIDDEN.find((re) => re.test(basePrText))?.source ?? null, null);

  // 評価ケース opens-pr-from-base（opens-pr-and-cleans-up と同じ構成）
  const prCaseDir = join(root, "evals/opens-pr-from-base");
  eq("instructions/8.3 評価ケース opens-pr-from-base の構成ファイルがそろう", ["case.yaml", "prompt.md", "place-files.sh"].every((f) => existsSync(join(prCaseDir, f))), true);
  eq("instructions/8.3 評価ケース opens-pr-from-base の graders が 1 つ以上ある", existsSync(join(prCaseDir, "graders")) && readdirSync(join(prCaseDir, "graders")).length >= 1, true);
  if (existsSync(join(prCaseDir, "case.yaml"))) {
    eq("instructions/8.3 評価ケースの name が名前と一致する", readFileSync(join(prCaseDir, "case.yaml"), "utf8").includes("name: opens-pr-from-base"), true);
  }
  if (existsSync(join(prCaseDir, "place-files.sh"))) {
    eq("instructions/8.3 評価ケースの fixture バリアントが共通の fixture にある", readFileSync(join(prCaseDir, "place-files.sh"), "utf8").includes("base-ahead") && read("evals/_fixture/setup-repo.sh").includes("base-ahead)"), true);
  }
  // 評価の実行環境の制約（origin がローカルの bare で GitHub に接続しない）を case.yaml に明記する
  if (existsSync(join(prCaseDir, "case.yaml"))) {
    const caseYaml = readFileSync(join(prCaseDir, "case.yaml"), "utf8");
    eq("instructions/8.3 評価ケースに GitHub 接続の制約（ローカルの bare・評価環境）を明記する", caseYaml.includes("評価環境") && caseYaml.includes("ローカルの bare") && caseYaml.includes("GitHub"), true);
  }
  // 本文の判定は、分岐元が本体のこの fixture でも案内されたパスを使うことを見る（作業ツリーの外かどうかは判定しない）
  const grader01 = join(prCaseDir, "graders/01-check.md");
  if (existsSync(grader01)) {
    const g = readFileSync(grader01, "utf8");
    eq("instructions/8.3 評価ケース graders/01 は brw pr-template が出力したパスの本文を使うことを判定する", g.includes("brw pr-template が出力したパス") && !g.includes("作業ツリーの中に置いていない"), true);
  }

  // ---- 9.5: 公開後の続きの作業の再開（手順書・資料・評価ケース） ----
  const setupText = read("references/setup.md");
  eq("instructions/9.5 SKILL.md の 3 章・4 章と setup.md の小節に、公開後の続きの再開の文が成立している", resumeGaps(skill, setupText), []);
  const resumeMutants = [
    ["3 章: 新しい作業ブランチを作らず → 作るへ反転（同じブランチを新しく作る）", skill, "同じブランチを再開する", "同じブランチを新しく作る"],
    ["3 章: 記録が残る → 残らずへ反転", skill, "本体に書けたときに残る。", "本体に書けたときに残らず。"],
    ["3 章: 記録の条件（書けたとき）を無条件へ（必ず残る）", skill, "本体に書けたときに残る。", "本体に必ず残る。"],
    ["3 章: 警告だけを出し → 出さずへ反転", skill, "警告だけを出し、片付けは完了する。", "警告だけを出さず、片付けは完了する。"],
    ["3 章: 一覧の取得済みの追跡ブランチから → 取得していない追跡ブランチへ反転", skill, "取得済みの `origin` の追跡ブランチから", "取得していない `origin` の追跡ブランチから"],
    ["3 章: 一覧の最大 20 件 → 全件へ反転", skill, "作業場所が無い開発ブランチを最大 20 件出す", "作業場所が無い開発ブランチを全件出す"],
    ["3 章: 20 件を超えるときの直接指定を削除", skill, "20 件を超えるときは `brw resume <ブランチ>` で直接指定する。", "20 件を超えても全件出す。"],
    ["3 章: 案内の条件「同じセッション」→「別のセッションでも」へ反転", skill, "同じセッションの次の入力では", "別のセッションでも次の入力では"],
    ["3 章: 案内の 24 時間以内の限定を削除", skill, "記録から 24 時間以内で、作業場所が無くリモートにあるものに限る", ""],
    ["3 章: 新しい作業なら案内は無視してよい、を削除", skill, "新しい作業なら無視してよい。", ""],
    ["3 章: 失敗時の「ことがある」→ 断定「対象にならず」へ反転", skill, "フックの案内の対象にならないことがあり", "フックの案内の対象にならず"],
    ["3 章: 失敗時の「並ばないことがある」→ 断定「並ぶ」へ反転", skill, "一覧でも公開の記録つきの先頭に並ばないことがある", "一覧でも公開の記録つきの先頭に並ぶ"],
    ["3 章: 失敗時の「（または古い）」の条件を削除", skill, "この記録が無い（または古い）と", "この記録が無いと"],
    ["3 章: 失敗時もの再開の文を断定「再開できない」へ反転", skill, "そのときも `brw resume <ブランチ>` で再開できる", "そのときは再開できない"],
    ["3 章: オープンな PR → すべての PR へ反転", skill, "同じ head のオープンな PR が 1 件あり、", "すべての PR があり、"],
    ["3 章: 既存の PR が再利用される → 再利用されずへ反転", skill, "既存の PR が再利用される。", "既存の PR が再利用されず。"],
    ["3 章: 取り込み先が同じで → 違っても、へ反転", skill, "取り込み先が同じで、draft でないとき", "取り込み先が違っても、draft でないとき"],
    ["3 章: 照合できないときは止まり → 照合できたときへ反転", skill, "照合できないときは止まり", "照合できたときは止まり"],
    ["3 章: 閉じた PR は再利用されず → も再利用されるへ反転", skill, "閉じた PR は再利用されず、新しく作られうる。", "閉じた PR も再利用される。"],
    ["3 章: cd <本体> で本体へ移る指示を反転", skill, "`cd <本体>` で本体へ移ってから続ける", "そのまま続ける"],
    ["4 章: 1 件 → 複数ありへ反転", skill, "head とするオープンな PR が 1 件あり", "head とするオープンな PR が複数あり"],
    ["4 章: 取り込み先が同じで → 違っても、へ反転", skill, "head とするオープンな PR が 1 件あり、取り込み先が同じで、", "head とするオープンな PR が 1 件あり、取り込み先が違っても、"],
    ["4 章: draft でないとき → draft でも、へ反転", skill, "head とするオープンな PR が 1 件あり、取り込み先が同じで、draft でないとき", "head とするオープンな PR が 1 件あり、取り込み先が同じで、draft でも"],
    ["4 章: 照合できないときは止まり → 照合できたときへ反転", skill, "照合できないときは止まり、理由を表示する。", "照合できたときは止まり、理由を表示する。"],
    ["4 章: 閉じた PR は再利用されず → も再利用されるへ反転", skill, "理由を表示する。閉じた PR は再利用されず", "理由を表示する。閉じた PR も再利用され"],
    ["資料: 記録が残る → 残らずへ反転", setupText, "本体に書けたときに残る。", "本体に書けたときに残らず。"],
    ["資料: 案内の同じセッションを別のセッションへ反転", setupText, "同じセッションで公開して片付けた記録", "別のセッションで公開して片付けた記録"],
    ["資料: 閉じた PR は再利用されず → も再利用されるへ反転", setupText, "閉じた PR は再利用されず、", "閉じた PR も再利用され、"],
    ["資料: brw resume の一覧（引数なし）を削除", setupText, "（引数なし）で、", "で、"],
    ["資料: 取り込み先が同じで → 違っても、へ反転", setupText, "取り込み先が同じで、draft でないとき", "取り込み先が違っても、draft でないとき"],
    ["資料: 失敗時の「ことがある」→ 断定「対象にならず」へ反転", setupText, "フックの案内の対象にならないことがあり", "フックの案内の対象にならず"],
    ["資料: 失敗時の「並ばないことがある」→ 断定「並ぶ」へ反転", setupText, "一覧でも公開の記録つきの先頭に並ばないことがある", "一覧でも公開の記録つきの先頭に並ぶ"],
  ];
  for (const [name, doc, from, to] of resumeMutants) {
    const m = mutate(doc, from, to);
    const gapsOf = doc === setupText ? (t) => resumeGaps(skill, t) : (t) => resumeGaps(t, setupText);
    eq(`instructions/9.5 変異版「${name}」を検出する`, m !== null && gapsOf(m).length > 0, true);
  }
  const fixtureText = read("evals/_fixture/setup-repo.sh");
  eq("instructions/9.5 評価ケース continues-after-pr-cleanup の構成・制約・判定の文が成立している", continueCaseGaps(join(root, "evals/continues-after-pr-cleanup"), (p) => readFileSync(p, "utf8"), fixtureText), []);
  eq("instructions/9.5 評価ケース continues-after-pr-cleanup の graders は、新しいブランチを作らず brw resume を使う判定を含む", (() => {
    const dir = join(root, "evals/continues-after-pr-cleanup/graders");
    if (!existsSync(dir)) return false;
    return readdirSync(dir).some((f) => readFileSync(join(dir, f), "utf8").includes("brw.mjs resume"))
      && readdirSync(dir).some((f) => readFileSync(join(dir, f), "utf8").includes("新しい作業ブランチを作らず"));
  })(), true);
  {
    const dir = join(root, "evals/continues-after-pr-cleanup");
    const forbidden = existsSync(dir) ? readdirSync(dir, { recursive: true }).filter((f) => statSync(join(dir, f)).isFile()).map((f) => [f, FORBIDDEN.find((re) => re.test(readFileSync(join(dir, f), "utf8")))]) : [];
    eq("instructions/9.5 評価ケース continues-after-pr-cleanup のファイルに呼び出し側の置き場を示す語がない", forbidden.filter(([, hit]) => hit).map(([f]) => f), []);
  }
};
