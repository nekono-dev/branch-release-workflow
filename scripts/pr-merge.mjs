// PR のマージ可否の判定（brw-enforcement 18.2）。取り込み先が恒常的な分岐元のときだけ進める純粋関数。
// 通信・Git・ファイルには触れない。マージの実行（brw pr-merge）は 18.3 で別に作る。
import { classifyBranch } from "./lib.mjs";

// 取り込み先の分類の名前（利用者の端末に表示する理由で使う）
const CLASS_LABEL = { development: "開発ブランチ", undeclared: "宣言外のブランチ" };

// GitHub の所有者・リポジトリ名として使う文字だけを有効とする（空・空白・制御文字は無効）
const NAME_RE = /^[A-Za-z0-9_.-]+$/;
const validName = (s) => typeof s === "string" && NAME_RE.test(s);
// git のブランチ名として通常の文字だけを有効とする（長さは 1〜255）。理由に入る値なので、制御文字・空白・バッククォートなどは通さない
const REF_RE = /^[A-Za-z0-9._/-]+$/;
const validRef = (s) => typeof s === "string" && s.length >= 1 && s.length <= 255 && REF_RE.test(s);
// PR 番号は正の安全な整数
const validNumber = (n) => Number.isSafeInteger(n) && n > 0;

// 大文字小文字を区別せずにリポジトリの所有者・名前を比べる（形を確かめた後にだけ使う）
const sameRepo = (a, b) => a.owner.toLowerCase() === b.owner.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase();

// PR の情報の形を確かめる。形が不正なら取り込み先を確定できないので false。
// 理由に埋め込む値（番号・ブランチ名・リポジトリ名）は、ここで有効と確かめたものだけになる
const wellFormed = (facts) =>
  facts !== null &&
  typeof facts === "object" &&
  validNumber(facts.number) &&
  (facts.state === "open" || facts.state === "closed") &&
  typeof facts.merged === "boolean" &&
  validRef(facts.baseRef) &&
  facts.baseRepo !== null &&
  typeof facts.baseRepo === "object" &&
  validName(facts.baseRepo.owner) &&
  validName(facts.baseRepo.name);

// 判定の順序は、より根本的な理由を先にする: 形の不正 → origin の不明 → リポジトリの違い → 開いていない → 保護 → 分岐元以外
// config は lib.mjs の normalizeConfig で正規化済みの宣言。origin は {owner, name}（origin の GitHub リポジトリ）
export function judgeMerge(config, facts, origin) {
  if (!wellFormed(facts)) {
    return { ok: false, code: "base-not-integration", reason: "PR の情報が不正で、取り込み先を確定できません。" };
  }
  // origin が不正なら、生の値を理由に入れずに repo-mismatch で拒否する
  if (origin === null || typeof origin !== "object" || !validName(origin.owner) || !validName(origin.name)) {
    return { ok: false, code: "repo-mismatch", reason: "origin の GitHub リポジトリを確定できないため、マージしません。GitHub 上で確認してください。" };
  }
  if (!sameRepo(facts.baseRepo, origin)) {
    return {
      ok: false,
      code: "repo-mismatch",
      reason: `取り込み先のリポジトリ（${facts.baseRepo.owner}/${facts.baseRepo.name}）が origin（${origin.owner}/${origin.name}）と違います（フォークの PR など）。brw ではマージしません。GitHub 上で確認してください。`,
    };
  }
  if (facts.state !== "open" || facts.merged === true) {
    return { ok: false, code: "not-open", reason: `PR #${facts.number} は開いていない（マージ済みまたは閉じている）ため、マージしません。` };
  }
  const kind = classifyBranch(config, facts.baseRef);
  if (kind === "base") return { ok: true };
  if (kind === "protected") {
    return {
      ok: false,
      code: "base-protected",
      reason: `取り込み先 '${facts.baseRef}' は保護ブランチです。保護ブランチ向けの PR は BRW ではマージせず、GitHub 上でマージしてください。`,
    };
  }
  const label = CLASS_LABEL[kind] ?? "宣言外のブランチ";
  return {
    ok: false,
    code: "base-not-integration",
    reason: `取り込み先 '${facts.baseRef}' は${label}で、恒常的な分岐元ではありません。BRW ではマージしません。取り込み先が正しいか、GitHub 上でマージするか、宣言を確認してください。`,
  };
}
