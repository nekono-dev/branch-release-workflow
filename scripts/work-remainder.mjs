// 作業ブランチの残りの検出（brw-enforcement 16.1）。
// リポジトリの全 worktree のうち開発ブランチのものについて、未コミットの変更と未 push の commit を Git の読み取りだけで数える。
// 作業の記録（状態ファイル）・ブランチの作られ方・cwd が指す場所には依存しない。ネットワークを使わず、状態は変更しない。
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import { classifyBranch, loadConfig } from "./lib.mjs";
import { SECRET_PATTERNS } from "./tidy.mjs";

// 対象にする worktree の上限（git worktree list の先頭から数える。本体を含む）
const MAX_WORKTREES = 20;

// 読み取り専用の git を実行する。失敗したら null を返す。
// --no-optional-locks で、状態表示のためのインデックス更新やロックを取らない（副作用を最小にする）。
// 出力は加工しない（先頭の空白は porcelain 形式の一部のため）。
const gitRaw = (cwd, args) => {
  try {
    return execFileSync("git", ["--no-optional-locks", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
};

// git のバージョンが 2.36 以降か（worktree list の -z が使えるか）
const gitSupportsZ = (cwd) => {
  const m = gitRaw(cwd, ["version"])?.match(/git version (\d+)\.(\d+)/);
  return !!m && (Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 36));
};

// worktree list の 1 件分の属性を作る（branchRef は "refs/heads/<名前>" の形）
const worktreeOf = (path, branchRef, flags) => ({
  path,
  branch: branchRef && branchRef.startsWith("refs/heads/") ? branchRef.slice("refs/heads/".length) : null,
  bare: flags.bare,
  prunable: flags.prunable,
});

// git worktree list --porcelain を解析する。先頭が本体。失敗したら null
// -z（2.36 以降）では NUL 区切りで読むため、改行を含むパスも正しく扱える。古い git は従来の改行区切りで読む
const worktreeList = (cwd) => {
  if (gitSupportsZ(cwd)) {
    const out = gitRaw(cwd, ["worktree", "list", "--porcelain", "-z"]);
    if (out === null) return null;
    const list = [];
    let path = null;
    let branchRef = null;
    let flags = { bare: false, prunable: false };
    // 1 件分を確定する。path が無い（最初の worktree より前）なら捨てる
    const close = () => {
      if (path !== null) list.push(worktreeOf(path, branchRef, flags));
      path = null;
      branchRef = null;
      flags = { bare: false, prunable: false };
    };
    for (const tok of out.split("\0")) {
      // 空の要素は件の区切り（porcelain の空行に当たる）
      if (tok === "") {
        close();
        continue;
      }
      const sp = tok.indexOf(" ");
      const key = sp < 0 ? tok : tok.slice(0, sp);
      const val = sp < 0 ? "" : tok.slice(sp + 1);
      if (key === "worktree") {
        close();
        path = val;
      } else if (key === "branch") {
        branchRef = val;
      } else if (key === "bare") {
        flags.bare = true;
      } else if (key === "prunable") {
        flags.prunable = true;
      }
    }
    close();
    return list;
  }
  const out = gitRaw(cwd, ["worktree", "list", "--porcelain"]);
  if (out === null) return null;
  return out.split(/\n\n+/).filter((block) => block.trim() !== "").map((block) => worktreeOf(
    block.match(/^worktree (.+)$/m)?.[1] ?? null,
    block.match(/^branch (.+)$/m)?.[1] ?? null,
    { bare: /^bare$/m.test(block), prunable: /^prunable/m.test(block) },
  )).filter((w) => w.path !== null);
};

// 未コミットの変更のパス（追跡ファイルの変更・削除・新規の未追跡ファイルを含み、ignore されたものは含まない）。失敗したら null
const dirtyPaths = (path) => {
  // -z で、引用されない生のパスを受け取る。改名・コピーは次の要素が元のパスなので読み飛ばす
  const out = gitRaw(path, ["status", "--porcelain", "-z", "--untracked-files=normal"]);
  if (out === null) return null;
  const items = out.split("\0").filter((s) => s !== "");
  const paths = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    paths.push(item.slice(3));
    // 改名・コピーは索引側（X）でも作業ツリー側（Y）でも、次のレコードが元のパス
    if ("RC".includes(item[0]) || "RC".includes(item[1])) i++;
  }
  return paths.sort();
};

// unborn（コミットが無い）か。HEAD が解決できず、HEAD の指す先が refs/heads/ のブランチのとき。
// それ以外の失敗（HEAD が壊れている等）は unborn とみなさない
const isUnborn = (path) => {
  if (gitRaw(path, ["rev-parse", "--verify", "--quiet", "HEAD"]) !== null) return false;
  const ref = gitRaw(path, ["symbolic-ref", "-q", "HEAD"]);
  return ref !== null && ref.trim().startsWith("refs/heads/");
};

// 未 push の commit の数（要件 2.9）。リモートの同名のブランチに無く、恒常的な分岐元にも無い commit を数える。
// 除外する参照は、各リモートの「同名のブランチ」と「恒常的な分岐元」の追跡ブランチ（refs/remotes/<r>/<名前>）。
// ローカルの分岐元（refs/heads/）は使わない（push 前のローカルの commit を push 済みと見なさないため）。
// 除外する参照が 1 つも無ければ全 commit を数える（リモートが無い・分岐元の追跡ブランチが無い場合）。
// コミットの無い（unborn）ブランチは 0 とする。失敗したら null
const unpushedCount = (path, branch, bases) => {
  if (isUnborn(path)) return 0;
  const remotes = gitRaw(path, ["remote"]);
  const refsOut = gitRaw(path, ["for-each-ref", "--format=%(refname)", "refs/remotes"]);
  if (remotes === null || refsOut === null) return null;
  const have = new Set(refsOut.split("\n").filter((s) => s !== ""));
  const excluded = [];
  for (const r of remotes.split("\n").map((s) => s.trim()).filter((s) => s !== "")) {
    for (const name of [branch, ...bases]) {
      const ref = `refs/remotes/${r}/${name}`;
      if (have.has(ref) && !excluded.includes(ref)) excluded.push(ref);
    }
  }
  const args = excluded.length > 0 ? ["rev-list", "--count", "HEAD", "--not", ...excluded] : ["rev-list", "--count", "HEAD"];
  const out = gitRaw(path, args);
  if (out === null) return null;
  const n = Number(out.trim());
  return Number.isInteger(n) && n >= 0 ? n : null;
};

// 畳まれた未追跡ディレクトリ（"dir/"）の中のファイルを全件列挙する。pathspec は文字どおりに扱う（角かっこ・* を含む名前のため）。
// ignore されたものは含めない。失敗したら null
const filesIn = (path, dir) => {
  const out = gitRaw(path, ["--literal-pathspecs", "ls-files", "--others", "--exclude-standard", "-z", "--", dir]);
  if (out === null) return null;
  return out.split("\0").filter((s) => s !== "");
};

const isSecretLike = (p) => SECRET_PATTERNS.some((re) => re.test(basename(p)));

// 秘密らしい名前のファイル。畳まれたディレクトリの中は、中のファイルの相対パスで判定する。失敗したら null
const secretLikeOf = (path, dirty) => {
  const found = [];
  for (const p of dirty) {
    if (!p.endsWith("/")) {
      if (isSecretLike(p)) found.push(p);
      continue;
    }
    const files = filesIn(path, p);
    if (files === null) return null;
    found.push(...files.filter(isSecretLike));
  }
  return [...new Set(found)].sort();
};

// 一覧から本体（先頭の worktree）のパスを取る。本体が bare・一覧が無いときは null
const mainPathOf = (list) => (list && list.length > 0 && !list[0].bare && list[0].path ? list[0].path : null);

/**
 * 本体（先頭の worktree）の実パス。-z の一覧から取るため、改行・引用符・空白を含むパスも正しく返す。判定できなければ null。
 */
export function mainWorktreeOf(cwd) {
  try {
    return mainPathOf(worktreeList(cwd));
  } catch {
    return null;
  }
}

/**
 * 宣言の autoApprove.push が明示的に false か（16.3）。本体の宣言から読む。宣言が無い・読めないときは false（未指定とは区別しない: 既定の確認省略の扱いを変えない）。
 */
export function declaredNoPushOf(cwd) {
  try {
    const main = mainWorktreeOf(cwd);
    if (!main) return false;
    return loadConfig(main).config?.autoApprove?.push === false;
  } catch {
    return false;
  }
}

/**
 * 全 worktree のうち開発ブランチの残りを返す。
 * 戻り値: {branch, path, dirty, dirtyCount, unpushed, secretLike}[]
 * 残りが無い・対象外・判定不能（宣言の読み込み失敗、git の失敗を含む）は空の配列（案内しない側に倒す）。
 */
export function remaindersOf(cwd) {
  try {
    const list = worktreeList(cwd);
    const main = mainPathOf(list);
    if (main === null) return [];
    // 宣言は本体（先頭の worktree）から読む。cwd が指す worktree の内容に依存しないため
    const { config } = loadConfig(main);
    if (!config) return [];
    // 恒常的な分岐元（固定名。宣言から解決済み）。未 push の数の基準に使う
    const bases = config.permanentBases ?? [config.baseBranch];

    const out = [];
    for (const wt of list.slice(0, MAX_WORKTREES)) {
      // detached HEAD・prunable（ディレクトリが無い）・bare は対象外
      if (wt.bare || wt.prunable || !wt.branch || !existsSync(wt.path)) continue;
      // 保護ブランチ・恒常的な分岐元・宣言外・命名規則に合わないものは対象外
      if (classifyBranch(config, wt.branch) !== "development") continue;

      const dirty = dirtyPaths(wt.path);
      const unpushed = unpushedCount(wt.path, wt.branch, bases);
      // どれかが判定できなければ、この worktree は案内しない
      if (dirty === null || unpushed === null) continue;
      if (dirty.length === 0 && unpushed === 0) continue;
      const secretLike = secretLikeOf(wt.path, dirty);
      if (secretLike === null) continue;

      out.push({ branch: wt.branch, path: wt.path, dirty, dirtyCount: dirty.length, unpushed, secretLike });
    }
    return out;
  } catch {
    // 想定外の失敗は、残りが無いものとして扱う（案内しない側に倒す）
    return [];
  }
}

// 案内文の上限（16.2）。超えた分は「ほか N 件」と書く
const GUIDE_WORKTREE_LIMIT = 5;
const GUIDE_PATH_LIMIT = 10;
// 案内に書く名前の長さの上限（コードポイント数）
const GUIDE_VALUE_MAX = 200;

// 可視化する文字: 制御文字（C0・DEL・C1）、改行類、書式制御文字（双方向・ゼロ幅・BOM など）、行・段落の区切り、私用領域、未割り当て、代理対。
// Unicode の文字種で判定する（通常の日本語・空白 U+0020・NBSP などは残す）
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

// 値を 1 行のデータに直した本体（囲みなし）。200 文字で切り、バックスラッシュ（先に）・可視化対象・バッククォートの順に直す。
// 後で足す \n・\x60 などと、実際の文字を区別するため、バックスラッシュは先に二重にする
const escapeValue = (value) => {
  const chars = Array.from(String(value));
  const cut = chars.length > GUIDE_VALUE_MAX ? `${chars.slice(0, GUIDE_VALUE_MAX).join("")}…` : chars.join("");
  return cut.replace(/\\/g, "\\\\").replace(INVISIBLE_G, escapeInvisible).replace(/`/g, "\\x60");
};

// 信頼できない値（ファイル名・ブランチ名・パス）を、案内の中で 1 行のデータとして示す（バッククォートで囲む）
const visible = (value) => "`" + escapeValue(value) + "`";

// cd の行に出せるパスか。無害化で値が変わらないものだけ（visible の比較と一致させ、判定の食い違いを作らない）
const plainPath = (p) => escapeValue(p) === p;

// POSIX シェルの単一引用（' は '\'' にする）。cd の手順で使う
const shellQuote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;

// 名前の一覧を上限で切る。超えた分は「ほか N 件」を付ける（total は件数の総数）。各値は visible で示す
const listWithMore = (names, total, limit) => {
  const shown = names.slice(0, limit).map(visible).join(", ");
  const rest = total - Math.min(names.length, limit);
  return rest > 0 ? `${shown} ほか ${rest} 件` : shown;
};

// cwd が worktree のルートと完全に一致するか（末尾のスラッシュは除いて比べる）。
// サブディレクトリは一致とみなさない: 表示するパスはルート基準のため、そこから git add すると誤ったパスを指すため
const isRoot = (cwd, path) => resolve(cwd) === resolve(path);

/**
 * 残りの案内文を作る（brw-enforcement 16.2）。純粋関数（Git・ファイルに触れない）。
 * remainders は remaindersOf の戻り値、policy は {noPush, cwd?}。
 * 残りごとに真偽の noPush（16.3）があればそれを優先し、無ければ policy.noPush に従う（worktree ごとに push 禁止が違う場合のため）。
 * noPush（作業の制限・確認省略の無効による push 禁止）のときは未 push を理由にせず、未 push だけの残りは外す。
 * 名前・パスは可視化して値として示し、cd の手順はシェルで安全に引用する。残りが無ければ null、あれば案内文を返す。
 */
export function remainderGuidance(remainders, policy = {}) {
  const defaultNoPush = policy?.noPush === true;
  // 残りごとの push 禁止。残りの noPush が真偽なら優先し、無ければ policy.noPush
  const noPushOf = (r) => (typeof r?.noPush === "boolean" ? r.noPush : defaultNoPush);
  const cwd = typeof policy?.cwd === "string" && policy.cwd !== "" ? policy.cwd : null;
  const all = Array.isArray(remainders) ? remainders : [];
  const items = all.filter((r) => !(noPushOf(r) && r.dirtyCount === 0));
  if (items.length === 0) return null;

  const hasDirty = items.some((r) => r.dirtyCount > 0);
  // push 禁止の worktree の未 push は案内に出さない
  const hasUnpushed = items.some((r) => !noPushOf(r) && r.unpushed > 0);
  const anyPush = items.some((r) => !noPushOf(r));
  const anyNoPush = items.some((r) => noPushOf(r));
  const head = hasDirty && hasUnpushed
    ? "未コミットの変更または未 push の commit が残っている開発ブランチがあります。"
    : hasDirty
      ? "未コミットの変更が残っている開発ブランチがあります。"
      : "未 push の commit が残っている開発ブランチがあります。";

  const shown = items.slice(0, GUIDE_WORKTREE_LIMIT);
  const lines = [head];
  if (anyPush && anyNoPush) lines.push("次の worktree の残りを、この作業で生じた変更なら commit・push してください。ただし「push はしない」とある worktree は commit までにとどめてください。");
  else lines.push(anyNoPush ? "次の worktree の変更を commit までにとどめてください。" : "次の worktree の残りを、この作業で生じた変更なら commit・push してください。");
  shown.forEach((r, i) => {
    const np = noPushOf(r);
    lines.push("");
    lines.push(`${i + 1}. ブランチ ${visible(r.branch)}（${visible(r.path)}）`);
    // 作業ディレクトリと別の worktree なら、そこへ移ってから行う。制御文字を含むパスは cd にせず、手動で移る案内にする
    // cd の行は、無害化で値が変わらないパス（制御文字・バッククォートを含まず 200 文字以内）だけに出す。それ以外は可視化した値で手動の案内にする
    if (cwd === null || !isRoot(cwd, r.path)) {
      if (plainPath(r.path)) lines.push(`   - cd ${shellQuote(r.path)} で移ってから行う`);
      else lines.push(`   - このパスは制御文字・バッククォート・長さのため案内に直接書けず、cd の手順は出しません。${visible(r.path)} へ手動で移ってください`);
    }
    if (r.dirtyCount > 0) lines.push(`   - 未コミットの変更 ${r.dirtyCount} 件: ${listWithMore(r.dirty, r.dirtyCount, GUIDE_PATH_LIMIT)}`);
    if (!np && r.unpushed > 0) lines.push(`   - 未 push の commit ${r.unpushed} 件`);
    if (r.secretLike.length > 0) lines.push(`   - 秘密情報らしい名前のファイル（${listWithMore(r.secretLike, r.secretLike.length, GUIDE_PATH_LIMIT)}）は commit に含めない`);
    // 次の操作。add は変更したパスだけにする
    const steps = [];
    if (r.dirtyCount > 0) steps.push("git add <変更したパス>", "git commit");
    if (!np && (r.dirtyCount > 0 || r.unpushed > 0)) steps.push("git push");
    if (steps.length > 0) lines.push(`   - 次の操作: ${steps.join(" → ")}${np ? "（push はしない）" : "（brw を使う場合も同じ手順）"}`);
  });
  const more = items.length - shown.length;
  if (more > 0) lines.push("", `ほか ${more} 件の worktree にも残りがあります。`);

  lines.push("");
  // commit の前に、ステージ済みの無関係な変更や秘密らしいファイルを外す（既にステージされた変更が混ざるのを防ぐ）
  // 秘密らしいファイルの注意は、残りの種類によらず含める（未 push だけの案内・noPush の案内も同じ）
  lines.push("秘密情報を含みうるファイル（.env・鍵・credentials など）は commit に含めないでください。");
  if (hasDirty) lines.push("commit する前に `git status`・`git diff --cached` でステージ内容を確認し、この作業と無関係な変更や秘密らしいファイルが含まれていれば `git restore --staged <パス>` で外してください。");
  if (anyPush) lines.push("この作業で生じた変更なら commit・push する。この作業によるものでなければ、その旨を報告して終了してよい（別のセッションが作業中の worktree の可能性があるため）。");
  if (anyNoPush) {
    lines.push(anyPush
      ? "「push はしない」とある worktree の変更は commit までにとどめ、未 push であることを報告してください。"
      : "この作業で生じた変更なら commit までにとどめ、未 push であることを報告して終了してください。この作業によるものでなければ、その旨を報告して終了してよい（別のセッションが作業中の worktree の可能性があるため）。");
  }
  if (anyPush) lines.push("push できないとき（認証・保護・ネットワークなど）は、その理由を利用者へ報告してから終了してください。");
  lines.push("失敗したときは、成功した処理・未完了の処理・失敗理由を報告して終了してください。");
  return lines.join("\n");
}
