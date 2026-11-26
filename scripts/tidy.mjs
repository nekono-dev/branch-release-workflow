#!/usr/bin/env node
// 作業外の変更の別コミット化（brw-pr-handoff）。`brw pr` の push の前に、未コミットの変更を作業のコミットとは別の 1 つのコミットにする。
// 状態の全項目（未追跡のディレクトリは個々のファイル、改名は旧名と新名、ステージ済みを含む）を調べ、秘密らしい名前に当たるものがあれば何も commit しない。
// .gitignore の対象は git status に現れないので含まれない。フックは回避しない（失敗は failed）。外部依存なし。
import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { basename, join } from "node:path";

export const TIDY_SUBJECT = "chore: 作業外の変更（ボーイスカウト）";
/** 秘密情報らしいファイル名（ベース名で判定）。当たれば別コミットを作らず止める */
export const SECRET_PATTERNS = [/^\.env(\..*)?$/i, /\.pem$/i, /\.key$/i, /^id_(rsa|dsa|ecdsa|ed25519)/i, /credentials/i, /secret/i, /\.p12$/i, /\.pfx$/i];

const git = (cwd, args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return { ok: !r.error && r.status === 0, out: r.stdout ?? "", err: r.stderr ?? "" };
};

/** 作業ツリーの全項目を読む。読めなければ null。conflict は未解決の競合の有無 */
function readStatus(worktree) {
  const r = git(worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (!r.ok) return null;
  const t = r.out.split("\0");
  const files = [];
  const stagedNew = [];
  let conflict = false;
  for (let i = 0; i < t.length; i++) {
    const e = t[i];
    if (e.length < 4) continue;
    const xy = e.slice(0, 2);
    files.push(e.slice(3));
    if (xy[0] === "A") stagedNew.push(e.slice(3));
    if (/[RC]/.test(xy)) files.push(t[++i]); // 改名・複製は次の要素が旧名
    if (xy.includes("U") || xy === "AA" || xy === "DD") conflict = true;
  }
  // `git add -f` で強制的にステージされた .gitignore の対象は、status に現れる。別コミットには含めない（ステージからは外す）
  let ignoredStaged = [];
  if (stagedNew.length > 0) {
    const c = spawnSync("git", ["check-ignore", "-z", "--no-index", "--stdin"], { cwd: worktree, input: stagedNew.join("\0"), encoding: "utf8" });
    ignoredStaged = (c.stdout ?? "").split("\0").filter(Boolean);
  }
  return { files: [...new Set(files.filter(Boolean))].filter((f) => !ignoredStaged.includes(f)), conflict, ignoredStaged };
}

const secretsOf = (files) => files.filter((f) => SECRET_PATTERNS.some((re) => re.test(basename(f))));

/** コミットせずに、別コミットになる予定のファイルと、秘密らしい名前のファイルを返す（brw pr-template が使う）。読めなければ null */
export function previewTidy(worktree) {
  const s = readStatus(worktree);
  return s ? { files: s.files, secretLike: secretsOf(s.files) } : null;
}

/**
 * 未コミットの変更を 1 つの別コミットにする。
 * @returns {{kind:"none"}|{kind:"committed",files:string[],oid:string}|{kind:"blocked",secretLike:string[]}|{kind:"failed",message:string}}
 */
export function tidyChanges(worktree) {
  const s = readStatus(worktree);
  if (!s) return { kind: "failed", message: "作業ツリーの状態を読めませんでした。" };
  if (s.files.length === 0) return { kind: "none" };
  const secretLike = secretsOf(s.files);
  if (secretLike.length > 0) return { kind: "blocked", secretLike };
  if (s.conflict) return { kind: "failed", message: "解決していない競合があるため、別コミットを作れません。" };
  // ステージ済みの改名の旧名は、作業ツリーにもインデックスにも無く pathspec が一致しない（新名のステージで一緒に記録される）。残りだけを明示して追加する
  const tracked = new Set(git(worktree, ["ls-files", "-z"]).out.split("\0"));
  const present = (f) => { try { lstatSync(join(worktree, f)); return true; } catch { return false; } };
  // 強制追加された ignore 対象はステージから外す（ファイルは残す）。外さないと git commit に含まれる
  for (const f of s.ignoredStaged) git(worktree, ["rm", "--cached", "-q", "--", `:(literal)${f}`]);
  const spec = s.files.filter((f) => present(f) || tracked.has(f)).map((f) => `:(literal)${f}`);
  const add = git(worktree, ["add", "--all", "--", ...spec]);
  if (!add.ok) return { kind: "failed", message: `変更をステージできませんでした: ${add.err.trim().split("\n")[0]}` };
  const commit = git(worktree, ["commit", "-m", TIDY_SUBJECT, "-m", s.files.map((f) => `- ${f}`).join("\n")]);
  if (!commit.ok) return { kind: "failed", message: `別コミットを作れませんでした: ${(commit.err || commit.out).trim().split("\n")[0]}` };
  const oid = git(worktree, ["rev-parse", "HEAD"]).out.trim();
  return { kind: "committed", files: s.files, oid };
}
