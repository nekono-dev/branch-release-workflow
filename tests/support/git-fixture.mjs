// 一時 Git リポジトリと bare remote（作業ツリーを持たない受け取り専用リポジトリ）を作る補助。
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 利用者の Git 設定に左右されないよう、名前とメールを毎回渡す
const base = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false"];

/** git を実行し、標準出力を前後の空白なしで返す。 */
export const gitOut = (cwd, ...args) => execFileSync("git", [...base, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/**
 * 一時リポジトリと bare remote を作り、main を push 済みにする。
 * @param {{branch?: string, config?: object|null, configPath?: string, register?: boolean}} [opt]
 *   config は宣言。register=false なら commit せず作業ツリーに置くだけにする。
 * @returns {{dir: string, remote: string, cleanup: () => void}}
 */
// リポジトリごとに、追加した worktree の置き場所を覚えておく（cleanup でまとめて消すため）
const extraDirs = new Map();

export const mkRepoWithRemote = ({ branch = "main", config = null, configPath = ".branch-release-workflow.json", register = true } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "brw-fx-"));
  const remote = join(root, "remote.git");
  const dir = join(root, "work");
  mkdirSync(dir);
  gitOut(root, "init", "-q", "--bare", "-b", "main", remote);
  gitOut(dir, "init", "-q", "-b", "main");
  gitOut(dir, "commit", "-q", "--allow-empty", "-m", "初期");
  if (config) {
    const file = join(dir, configPath);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify(config));
    if (register) {
      gitOut(dir, "add", configPath);
      gitOut(dir, "commit", "-q", "-m", "宣言");
    }
  }
  gitOut(dir, "remote", "add", "origin", remote);
  gitOut(dir, "push", "-q", "origin", "main");
  if (branch !== "main") gitOut(dir, "checkout", "-q", "-b", branch);
  const cleanup = () => {
    // 追加 worktree を先に外し、置き場所を消してから本体を消す
    for (const p of extraDirs.get(dir) ?? []) {
      try { gitOut(dir, "worktree", "remove", "--force", p); } catch { /* すでに無ければ無視 */ }
      rmSync(p, { recursive: true, force: true });
    }
    extraDirs.delete(dir);
    rmSync(root, { recursive: true, force: true });
  };
  return { dir, remote, cleanup };
};

/** 追加の worktree（同じリポジトリの別作業ディレクトリ）を新規ブランチで作り、そのパスを返す。後始末は元リポジトリの cleanup() が行う。 */
export const mkWorktree = (dir, branch) => {
  const path = mkdtempSync(join(tmpdir(), "brw-wt-"));
  rmSync(path, { recursive: true });
  gitOut(dir, "worktree", "add", "-q", "-b", branch, path);
  extraDirs.set(dir, [...(extraDirs.get(dir) ?? []), path]);
  return path;
};
