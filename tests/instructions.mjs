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
};
