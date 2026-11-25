#!/usr/bin/env node
// 作業ブランチの片付け（brw finish と、brw-pr-handoff の PR 作成後の自動片付けで共有する部品）。
// 安全確認（finishBlocker）と削除（removeBranch）を置く。brw.mjs を import しない（brw.mjs がこのファイルを使う）。外部依存なし。
import { execFileSync, spawnSync } from "node:child_process";
import { classifyBranch, git, matchesAny } from "./lib.mjs";
import { remoteNameOf } from "./publish.mjs";

// 作業ブランチが片付けてよい状態か。切り出し元へ取り込まれた、または保護ブランチへの PR がある、のどれかを満たすと done。
// 取り込みは commit の祖先関係のほか、squash merge を見込んで「ブランチで変えたファイルが切り出し元で同じ内容」でも判定する
// 取り込み先の ref（origin の追跡ブランチがあればそれ、無ければローカル）
const targetOf = (repo, base) => (git(repo, "show-ref", "--verify", "--quiet", `refs/remotes/origin/${base}`) !== null ? `origin/${base}` : base);

// 遠隔の同名ブランチの状態。present（存在し、追跡ブランチを更新済み）・absent（存在しない）・unknown（確かめられない）
function remoteState(cwd, branch, remote = "origin") {
  const r = spawnSync("git", ["ls-remote", "--exit-code", "--heads", remote, `refs/heads/${branch}`], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (r.status === 2) return { state: "absent" };
  if (r.status !== 0) return { state: "unknown", why: "リモートへの照会が失敗しました" };
  if (git(cwd, "fetch", remote, branch, "--quiet") === null) return { state: "unknown", why: "リモートからの取得が失敗しました" };
  return { state: "present" };
}

function landedState(repo, config, branch, base) {
  git(repo, "fetch", "origin", base, "--quiet");
  const target = targetOf(repo, base);
  if (git(repo, "merge-base", "--is-ancestor", `refs/heads/${branch}`, target) !== null) return { done: true, how: `${target} に取り込まれています` };
  const mb = git(repo, "merge-base", `refs/heads/${branch}`, target);
  const files = mb ? (git(repo, "diff", "--name-only", mb, `refs/heads/${branch}`) ?? "").split("\n").filter(Boolean) : [];
  if (mb && files.length && git(repo, "diff", "--quiet", `refs/heads/${branch}`, target, "--", ...files) !== null)
    return { done: true, how: `変更が ${target} に取り込まれています（squash merge など）` };
  const gh = spawnSync("gh", ["pr", "list", "--head", branch, "--state", "all", "--json", "baseRefName,state,url", "--limit", "20"], { cwd: repo, encoding: "utf8" });
  if (gh.status === 0) {
    let prs = [];
    try {
      prs = JSON.parse(gh.stdout);
    } catch {}
    const merged = prs.find((p) => p.state === "MERGED" && p.baseRefName === base);
    if (merged) return { done: true, how: `${base} への PR がマージされています（${merged.url}）` };
    const toProtected = prs.find((p) => p.state !== "CLOSED" && matchesAny(config.protectedBranches ?? [], p.baseRefName));
    if (toProtected) return { done: true, how: `保護ブランチ ${toProtected.baseRefName} への PR があります（${toProtected.url}）` };
  }
  return { done: false, how: `${base} にまだ取り込まれておらず、保護ブランチへの PR も見つかりません${gh.status === 0 ? "" : "（gh が使えないため PR は確認していません）"}` };
}

// 片付けの可否を確かめる。片付けられないときは理由を返す
export function finishBlocker(main, others, config, branch, base) {
  if (classifyBranch(config, branch) !== "development") return `'${branch}' は作業ブランチではありません。`;
  if (git(main.path, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`) === null) return `ローカルに ${branch} がありません。`;
  const wt = others.find((w) => w.branch === branch);
  if (wt && git(wt.path, "status", "--porcelain") !== "") return `worktree ${wt.path} に commit していない変更があります。`;
  if (main.branch === branch) return `本体の作業ツリーが ${branch} を使っています。`;
  const landed = landedState(main.path, config, branch, base);
  if (!landed.done) return landed.how;
  // 取り込み後に積んだ commit が手元にしか無ければ消さない。遠隔の状態を確かめられないときも残す
  // 遠隔の確認は、push 先のリモート名（branch.<ブランチ>.pushRemote など）で行う（origin 固定にしない）
  const remote = remoteNameOf(main.path, branch);
  const rs = remoteState(main.path, branch, remote);
  if (rs.state === "unknown") return `遠隔（origin）の状態を確認できないため残します（${rs.why}）。`;
  // 遠隔に無いのは、squash マージ後にリモートのブランチが削除された場合にも起きる。取り込みの判定（landed）は上で満たしているので片付けてよい
  if (rs.state === "absent") return null;
  const ahead = git(main.path, "rev-list", "--count", `refs/remotes/${remote}/${branch}..refs/heads/${branch}`);
  if (ahead !== "0") return `${branch} に push していない commit があります（${ahead ?? "不明"} 件）。`;
  return null;
}

export function removeBranch(main, others, branch) {
  const wt = others.find((w) => w.branch === branch);
  // 変更が無いことは確かめてある。submodule を含む worktree は --force が無いと消せないため付ける
  if (wt) execFileSync("git", ["worktree", "remove", "--force", wt.path], { cwd: main.path, stdio: "inherit" });
  execFileSync("git", ["branch", "-D", branch], { cwd: main.path, stdio: "inherit" });
  git(main.path, "update-ref", "-d", `refs/brw/carry/${branch}`); // --carry の復旧用の参照（無ければ何もしない）
  return wt;
}

