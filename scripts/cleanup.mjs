#!/usr/bin/env node
// 作業ブランチの片付け（brw finish と、brw-pr-handoff の PR 作成後の自動片付けで共有する部品）。
// 安全確認（finishBlocker）と削除（removeBranch）を置く。brw.mjs を import しない（brw.mjs がこのファイルを使う）。外部依存なし。
import { execFileSync, spawnSync } from "node:child_process";
import { classifyBranch, git, matchesAny } from "./lib.mjs";
import { bodyPathOf } from "./pr-template.mjs";
import { bodyRootOf, legacyFinishGuidance, placementZone } from "./placement.mjs";
import { removeWorkRecordAt, remoteNameOf, stateFileOf } from "./publish.mjs";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

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
  // 旧置き場の worktree と、所属を判定できない worktree は、取り込み済みでも片付けない。他の検査より先に確かめる（要件 7.6・5.1）
  const own = others.find((w) => w.branch === branch);
  if (own) {
    const zone = placementZone(main.path, own.path);
    if (zone === "legacy") {
      const g = legacyFinishGuidance(main.path, branch, own.path);
      return `${g.reason}\n  次のどちらかで進めてください:\n  ${g.next.join("\n  ")}`;
    }
    if (zone === "unknown") return `作業ブランチ ${branch} の worktree の所属を判定できないため片付けません（配置先やその親のディレクトリがシンボリックリンクなど）。worktree もブランチも消しません。`;
  }
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


const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** 手動の `brw finish` の成功後に、片付けを自動側が始めていた作業の状態を同じ手順で削除する（branch.<ブランチ>.brwState・brwWork の記録がある場合だけ）。 */
export function recordedState(mainPath, branch) {
  const file = git(mainPath, "config", `branch.${branch}.brwState`);
  const workId = git(mainPath, "config", `branch.${branch}.brwWork`);
  return file && workId ? { file, workId } : null;
}

/**
 * PR 作成後の自動片付け。作成した PR の事実（known）と作業状態の公開記録を使い、安全を確かめてから worktree・ローカルブランチ・本文ファイルを削除し、
 * 最後に作業状態の記録を取り除く。確認できない・遠隔に無い・先端が違うときは何も消さず kept を返す。削除後は子プロセスを実行しない。
 * @param {{main: {path: string, branch: string|null}, others: {path: string, branch: string|null}[], config: object, branch: string, workId: string,
 *   known: {url: string, base: string, oid: string, remote: string}|null}} opts
 * @returns {{kind: "cleaned", branch: string, worktree: string, main: string, stateRemoved: boolean, stateNote: string|null}
 *   | {kind: "kept", branch: string, reason: string}}
 */
export function cleanupAfterPr({ main, others, config, branch, workId, known }) {
  const keep = (reason) => ({ kind: "kept", branch, reason });
  if (!known || typeof known.oid !== "string" || !/^[0-9a-f]{40,64}$/.test(known.oid) || !REMOTE_NAME.test(known.remote ?? "") || !known.url || !known.base)
    return keep("公開記録（push 先のリモート・公開した OID・PR の URL・取り込み先）を確認できないため、片付けません。");
  if (classifyBranch(config, branch) !== "development") return keep(`'${branch}' は開発ブランチではないため、片付けません。`);
  const wt = others.find((w) => w.branch === branch) ?? null;
  if (!wt) return keep("作業ブランチの worktree が見つからないため、片付けません。");
  if (main.branch === branch) return keep(`本体の作業ツリーが ${branch} を使っているため、片付けません。`);
  // (a) ローカルの先端が、公開した OID と同じ（公開後に追加のコミットが無い）
  const tip = git(main.path, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
  if (tip === null) return keep(`ローカルに ${branch} が無いため、片付けません。`);
  if (tip !== known.oid) return keep(`公開した後に ${branch} へ新しいコミットがあるため、片付けません（公開 ${known.oid.slice(0, 12)}・現在 ${tip.slice(0, 12)}）。`);
  // (b) 記録された push 先のリモートに、同じ OID のブランチがある（存在しない・照会できない・違うときは片付けない）
  const ls = spawnSync("git", ["ls-remote", "--heads", known.remote, `refs/heads/${branch}`], { cwd: main.path, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (ls.status !== 0) return keep(`リモート ${known.remote} の状態を確認できないため、片付けません。`);
  const remoteOid = (ls.stdout.split("\n")[0] ?? "").split("\t")[0];
  if (remoteOid === "") return keep(`リモート ${known.remote} に ${branch} が無いため、片付けません。`);
  if (remoteOid !== known.oid) return keep(`リモート ${known.remote} の ${branch} の先端が公開した OID と違うため、片付けません。`);
  // (c) worktree に未コミットの変更が無い
  const status = git(wt.path, "status", "--porcelain");
  if (status === null) return keep("worktree の状態を確認できないため、片付けません。");
  if (status !== "") return keep(`worktree ${wt.path} に commit していない変更があるため、片付けません。`);

  // 削除の前に、状態ファイルと本文ファイルの場所を求め、状態の場所を残す（途中で止まっても brw finish で回復できる）
  const stateFile = stateFileOf(wt.path);
  const bodyFile = bodyPathOf(main.path, branch);
  // 本文置き場が想定の場所（実体）でないときは、本文ファイルを消さない（リンク先の旧置き場の本文を消さないため）
  const bodyRoot = bodyRootOf(main.path);
  if (stateFile) {
    // 回復用の記録を書けないまま削除を始めると、途中で止まったとき brw finish が状態を取り除けない。書けなければ削除前に止める
    const wrote = git(main.path, "config", `branch.${branch}.brwState`, stateFile) !== null && git(main.path, "config", `branch.${branch}.brwWork`, workId) !== null;
    if (!wrote) return keep("回復用の記録（作業状態の場所）を書けなかったため、片付けません。");
  }
  try {
    removeBranch(main, others, branch);
  } catch (error) {
    // 削除後の確認は、子プロセスではなくファイルの有無で行う（git の子プロセスは本体のパスを cwd に明示したものだけ）
    const gone = !existsSync(wt.path);
    return keep(`${gone ? "worktree は削除しましたが、" : ""}ブランチの削除に失敗しました（${String(error.message).split("\n")[0]}）。本体（${main.path}）で brw finish ${branch} を実行して片付けてください。`);
  }
  // 以降は子プロセスを実行しない（worktree が消えた後の作業ディレクトリを引き継ぐ子プロセスは失敗する。research.md #6）
  const notes = [];
  try {
    if (bodyRoot === null) {
      if (existsSync(bodyFile)) notes.push(`本文置き場が想定の場所（${join(main.path, ".worktree", ".brw")}）の実体ではないため、本文ファイル ${bodyFile} は消しません。手で確認してください。`);
    } else rmSync(bodyFile, { force: true });
  } catch (error) {
    notes.push(`片付けは済みましたが、本文ファイル ${bodyFile} を削除できませんでした（${error.code ?? error.message}）。手で削除してください。`);
  }
  let stateRemoved = false;
  if (stateFile) {
    let r;
    try { r = removeWorkRecordAt(stateFile, workId); } catch (error) { r = { ok: false, error: { message: error.code ?? error.message } }; }
    if (r.ok) stateRemoved = true;
    else notes.push(`片付けは済みましたが、作業状態の記録を取り除けませんでした（${r.error.message}）。状態ファイル ${stateFile} から作業 ${workId} の記録を削除してください。`);
  }
  return { kind: "cleaned", branch, worktree: wt.path, main: main.path, stateRemoved, stateNote: notes.length > 0 ? notes.join("\n") : null };
}
