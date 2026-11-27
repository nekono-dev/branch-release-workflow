// 作業ブランチの残りの検出（brw-enforcement 16.1）。
// リポジトリの全 worktree のうち開発ブランチのものについて、未コミットの変更と未 push の commit を Git の読み取りだけで数える。
// 作業の記録（状態ファイル）・ブランチの作られ方・cwd が指す場所には依存しない。ネットワークを使わず、状態は変更しない。
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
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

/**
 * 全 worktree のうち開発ブランチの残りを返す。
 * 戻り値: {branch, path, dirty, dirtyCount, unpushed, secretLike}[]
 * 残りが無い・対象外・判定不能（宣言の読み込み失敗、git の失敗を含む）は空の配列（案内しない側に倒す）。
 */
export function remaindersOf(cwd) {
  try {
    const list = worktreeList(cwd);
    if (!list || list.length === 0 || list[0].bare) return [];
    // 宣言は本体（先頭の worktree）から読む。cwd が指す worktree の内容に依存しないため
    const { config } = loadConfig(list[0].path);
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
