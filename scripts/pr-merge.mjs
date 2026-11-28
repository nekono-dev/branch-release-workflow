// brw pr-merge（brw-enforcement 18.2・18.3）。PR の取り込み先からマージの可否を判定する純粋関数（judgeMerge）と、
// 利用者の端末で確認してから squash でマージする CLI（runPrMerge）を持つ。
// judgeMerge は通信・Git・ファイルに触れない。runPrMerge は読み取りと、利用者が y と答えた後の 1 回のマージだけを行う（状態ファイル・ブランチの削除はしない）。
import { createInterface } from "node:readline/promises";
import { classifyBranch, git, loadConfig, repoRoot } from "./lib.mjs";
import { defaultSession } from "./publish-cli.mjs";
import { githubRepoOf, unknownDestinationText } from "./remote-url.mjs";

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

// ---- 利用者の端末での実行（18.3） ----

const USAGE = "使い方: brw pr-merge <PR 番号>";
const PR_NUMBER_RE = /^[1-9]\d*$/;
const TITLE_MAX = 200;
// 表示する値の不可視文字（制御・書式・分離・未割当・代理対）。1 行に収めるため可視化する
const INVISIBLE_G = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}\p{Cs}]/gu;
const escapeInvisible = (c) => {
  if (c === "\n") return "\\n";
  if (c === "\r") return "\\r";
  if (c === "\t") return "\\t";
  const cp = c.codePointAt(0);
  if (cp <= 0xff) return `\\x${cp.toString(16).padStart(2, "0")}`;
  if (cp <= 0xffff) return `\\u${cp.toString(16).padStart(4, "0")}`;
  return `\\u{${cp.toString(16)}}`;
};
// GitHub 由来の信頼できない値（タイトル・ブランチ名・応答の理由）を、バッククォートで囲んだ 1 行の文字列にする。max 文字を超える分は切る。
// バックスラッシュは先に二重にし、後から足す \n・\x60 などと実際の文字を区別する
const visible = (value, max = Infinity) => {
  const chars = Array.from(String(value));
  const cut = chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
  return "`" + cut.replace(/\\/g, "\\\\").replace(INVISIBLE_G, escapeInvisible).replace(/`/g, "\\x60") + "`";
};

// 失敗の種類ごとの理由（publish-cli.mjs の FAILURE_TEXT と同じ文言）
const FAILURE_TEXT = {
  auth: "GitHub の認証を確認できません（gh auth status で確認してください）",
  permission: "GitHub の権限が不足しています",
  "unknown-input": "GitHub の応答を確認できませんでした",
  network: "GitHub に接続できません。通信を確認して再実行してください",
  server: "GitHub の一時的な障害の可能性があります。再実行してください",
  "target-mismatch": "GitHub の対象リポジトリの照合が一致しません",
  refused: "GitHub への要求が拒否されました",
};
const failureText = (kind) => FAILURE_TEXT[kind] ?? "GitHub の応答を確認できませんでした";

const consoleIo = { out: (s) => console.log(s), err: (s) => console.error(s) };
const fail = (io, msg) => {
  io.err(`エラー: ${msg}`);
  return 1;
};

/**
 * 確認の質問（利用者の端末でだけ使う）。テストは ask を注入する。
 * 入力が閉じた（Ctrl-D など）ときは空の答えを返して中止につなげる。待ち続けない。
 */
const defaultAsk = (question) =>
  new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let done = false;
    const finish = (answer) => {
      if (done) return;
      done = true;
      rl.close();
      resolve(answer);
    };
    rl.on("close", () => finish(""));
    rl.question(question).then(finish, () => finish(""));
  });

/** 引数は PR 番号 1 つだけ。形が違えば null。 */
const numberOf = (args) => {
  if (!Array.isArray(args) || args.length !== 1 || typeof args[0] !== "string" || !PR_NUMBER_RE.test(args[0])) return null;
  const n = Number(args[0]);
  return Number.isSafeInteger(n) ? n : null;
};

/**
 * `brw pr-merge <PR 番号>` を実行する。終了コードを返す（0 マージ済み / 1 実行せず・失敗 / 2 使い方の誤り）。
 * deps は試験用: cwd・io・stdinIsTTY・stdoutIsTTY・ask・session（GitHub 接続を作る関数）を差し替えられる。
 * 端末判定は process の標準入出力（テストは deps で注入）だけで行い、環境変数・引数では迂回できない。
 */
export async function runPrMerge(args = [], deps = {}) {
  const d = {
    cwd: deps.cwd ?? process.cwd(),
    io: deps.io ?? consoleIo,
    stdinIsTTY: deps.stdinIsTTY ?? (process.stdin.isTTY === true),
    stdoutIsTTY: deps.stdoutIsTTY ?? (process.stdout.isTTY === true),
    ask: deps.ask ?? defaultAsk,
    session: deps.session ?? defaultSession,
  };
  const number = numberOf(args);
  if (number === null) {
    d.io.err(USAGE);
    return 2;
  }

  // ① 利用者の端末でなければ、通信も git の変更もせずに案内する
  if (!d.stdinIsTTY || !d.stdoutIsTTY) {
    d.io.err(
      `brw pr-merge は利用者が自分の端末で実行する必要があります（エージェントからは実行できません）。` +
        `Claude Code の画面から \`!\` で実行しても端末として扱われないことがあるため、別の端末で \`brw pr-merge ${number}\` を実行してください。`,
    );
    return 1;
  }

  // ② 宣言と origin の GitHub リポジトリを読む（宣言が無い・不正、GitHub 以外の origin は実行しない）
  const root = repoRoot(d.cwd);
  if (!root) return fail(d.io, "git リポジトリ内で実行してください。");
  const loaded = loadConfig(root);
  if (loaded.error || !loaded.config) {
    return fail(d.io, loaded.error ?? "宣言ファイルがありません。取り込み先の規則を確認できないため、マージしません。");
  }
  const config = loaded.config;
  const originUrl = git(root, "remote", "get-url", "--push", "origin");
  const origin = githubRepoOf(originUrl);
  if (!origin) return fail(d.io, unknownDestinationText("origin", originUrl));

  // 資格情報は表示・記録しない（defaultSession の仕組み）
  let session;
  try {
    session = d.session();
  } catch (e) {
    return fail(d.io, `GitHub に接続できません（${e?.message ?? "原因不明"}）。`);
  }

  // ③ 対象リポジトリを照合し、PR を読む（取り込み先を得られないときは実行しない）
  const confirmed = await session.confirmTarget({ host: session.host, owner: origin.owner, name: origin.name });
  if (!confirmed.ok) {
    return fail(d.io, `対象のリポジトリを GitHub で確認できませんでした（${failureText(confirmed.kind)}）。マージしていません。認証を確かめるか、GitHub 上でマージしてください。`);
  }
  const target = { host: session.host, owner: origin.owner, name: origin.name, repositoryId: confirmed.target.repositoryId };
  const read = await session.readPull(target, number);
  if (!read.ok) {
    return fail(d.io, `PR #${number} を GitHub から読めませんでした（${failureText(read.kind)}）。マージしていません。認証を確かめるか、GitHub 上でマージしてください。`);
  }
  const pull = read.pull;

  // ④ 取り込み先の判定（恒常的な分岐元の、開いている PR だけ進める）
  const verdict = judgeMerge(config, pull, origin);
  if (!verdict.ok) return fail(d.io, verdict.reason);

  // ⑤ 内容を表示し、利用者の y を待つ（既定は中止）。タイトル・ブランチ名は可視化して表示する
  d.io.out(`PR #${pull.number} をマージします。`);
  d.io.out(`タイトル: ${visible(pull.title, TITLE_MAX)}`);
  d.io.out(`取り込み: ${visible(pull.headRef)} → ${visible(pull.baseRef)}`);
  d.io.out(`head の SHA: ${pull.headSha.slice(0, 12)}`);
  // 質問の入力が例外になったときも中止として扱う
  let answer = "";
  try {
    answer = String(await d.ask("マージしますか [y/N] ")).trim().toLowerCase();
  } catch {
    answer = "";
  }
  if (answer !== "y" && answer !== "yes") {
    d.io.out("中止しました。マージしていません。");
    return 1;
  }

  // ⑥ 確認の後（マージの直前）に PR を読み直し、表示した内容と同じかを確かめる。
  // 読み直しは確認から merge までの間の変更（base の差し替え・head の更新・閉じた PR など）を止めるためのもの
  const again = await session.readPull(target, number);
  if (!again.ok) return fail(d.io, `確認の後に PR を読み直せなかったため、マージしていません（${failureText(again.kind)}）。`);
  const now = again.pull;
  const unchanged =
    now.number === pull.number &&
    now.state === pull.state &&
    now.merged === pull.merged &&
    now.headSha === pull.headSha &&
    now.baseRef === pull.baseRef &&
    now.baseRepo.owner === pull.baseRepo.owner &&
    now.baseRepo.name === pull.baseRepo.name;
  if (!unchanged || judgeMerge(config, now, origin).ok !== true) {
    return fail(d.io, "確認した後に PR が変更されたため、マージしていません。もう一度実行して内容を確認し直してください。");
  }

  // ⑦ 読み直しで確認した head の SHA を指定してマージする（食い違えば GitHub が 409 を返し、マージしない）
  const merged = await session.mergePull(target, { number: now.number, sha: now.headSha });

  // ⑧ 結果の表示
  if (merged.ok && merged.merged === true) {
    d.io.out(`マージしました。マージの commit: ${typeof merged.sha === "string" ? visible(merged.sha, 64) : "（応答に SHA なし）"}`);
    return 0;
  }
  if (merged.ok) {
    return fail(d.io, `GitHub はマージ済みと確認できませんでした（応答に merged が真の表示がない）。GitHub 上で PR #${number} の状態を確認してください。`);
  }
  if (merged.status === 409) {
    return fail(d.io, `PR が更新されたため、確認した内容と違うものをマージしていない。もう一度 \`brw pr-merge ${number}\` を実行して内容を確認し直してください。`);
  }
  if (merged.kind === "not-mergeable") {
    return fail(d.io, `GitHub がマージを許可しませんでした: ${visible(merged.reason, TITLE_MAX)}。必須チェック・レビュー・競合などを GitHub 上で確認してください。`);
  }
  if (merged.outcomeUnknown === true) {
    return fail(d.io, "マージされたか不明です（GitHub からの応答を受け取れませんでした）。GitHub 上で PR の状態を確認してから再実行してください。");
  }
  return fail(d.io, `マージできませんでした（${failureText(merged.kind)}）。`);
}
