// 未コミットの変更を移す処理（brw-branch-gate の carryChanges）の試験。selftest.mjs から呼ばれる。実際の一時リポジトリで確かめる。
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { carryChanges, carryRefOf } from "../scripts/carry.mjs";

const BRW = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "brw.mjs");
const brw = (cwd, ...a) => spawnSync("node", [BRW, ...a], { cwd, encoding: "utf8" });

const git = (cwd, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-C", cwd, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const tryGit = (cwd, ...a) => { try { return git(cwd, ...a); } catch (e) { return `ERR:${e.stderr ?? e.message}`; } };

// 変更・削除・実行権限・バイナリ・ステージ済みと未ステージの混在・新規追加・未追跡を持つ元の作業ツリーと、同じ開始点の新しい worktree を作る
function setup() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "brw-carry-")));
  const src = join(dir, "src");
  mkdirSync(src);
  execFileSync("git", ["init", "-q", "-b", "develop", src], { stdio: "ignore" });
  const w = (p, c, mode) => { writeFileSync(join(src, p), c); if (mode) chmodSync(join(src, p), mode); };
  w("mod.txt", "m1\n");
  w("del.txt", "d1\n");
  w("exec.sh", "#!/bin/sh\necho x\n", 0o755);
  w("both.txt", "b1\n");
  w("bin.dat", Buffer.from([0, 1, 2, 3, 255]));
  w("st.txt", "s1\n");
  git(src, "add", "-A");
  git(src, "commit", "-q", "-m", "base");
  const head = git(src, "rev-parse", "HEAD").trim();
  const wt = join(dir, "wt");
  git(src, "worktree", "add", "-q", "-b", "dev/carry", wt, head);
  return { dir, src, wt, head, w };
}
const dirty = ({ src, w }) => {
  w("mod.txt", "m2\n");
  rmSync(join(src, "del.txt"));
  chmodSync(join(src, "exec.sh"), 0o644);
  w("bin.dat", Buffer.from([9, 8, 7, 0, 255]));
  w("both.txt", "b2\n");
  git(src, "add", "both.txt"); // ステージ済み
  w("both.txt", "b3\n"); // さらに未ステージの変更
  w("new.txt", "n1\n");
  git(src, "add", "new.txt"); // 新規追加（ステージ済み）
  w("st.txt", "s2\n");
  git(src, "add", "st.txt"); // ステージ済みの内容が HEAD と違い、
  w("st.txt", "s1\n"); // 未ステージの編集で作業ファイルは HEAD と同じに戻っている
  w("untracked.txt", "u1\n");
};
const snapshot = (src) => ({ status: git(src, "status", "--porcelain=v1"), mod: readFileSync(join(src, "mod.txt"), "utf8"), stashList: git(src, "stash", "list") });

export const runCarryChecks = async (eq) => {
  // ---- 正常: 変更・削除・実行権限・バイナリ・混在・新規追加が移り、元から該当の変更だけが消える ----
  const t = setup();
  dirty(t);
  const r = carryChanges({ source: t.src, worktree: t.wt, startOid: t.head, branch: "dev/carry" });
  eq("brw-branch-gate/1.10 変更が移り、結果は carried で、移したファイルの一覧を返す", [r.kind, [...r.files].sort()], ["carried", ["bin.dat", "both.txt", "del.txt", "exec.sh", "mod.txt", "new.txt", "st.txt"]]);
  const wtState = (p) => (existsSync(join(t.wt, p)) ? readFileSync(join(t.wt, p)) : null);
  eq("brw-branch-gate/1.10 新しい worktree の内容が元の変更と一致する（変更・削除・混在・新規）", [
    String(wtState("mod.txt")), wtState("del.txt"), String(wtState("both.txt")), String(wtState("new.txt")), [...wtState("bin.dat")],
  ], ["m2\n", null, "b3\n", "n1\n", [9, 8, 7, 0, 255]]);
  eq("brw-branch-gate/1.10 ステージ済みの内容が HEAD と違い作業ファイルが HEAD と同じパスも、ステージ済みの内容ごと移る", [
    String(wtState("st.txt")), git(t.wt, "show", ":st.txt"), git(t.src, "show", ":st.txt") === "s1\n",
  ], ["s1\n", "s2\n", true]);
  eq("brw-branch-gate/1.10 実行権限の剥奪も移る", execFileSync("git", ["-C", t.wt, "diff", "--raw", "--", "exec.sh"], { encoding: "utf8" }).includes("100755 100644"), true);
  eq("brw-branch-gate/1.10 元の作業ツリーからは、移した変更だけが消える（未追跡のファイルは残る）", git(t.src, "status", "--porcelain=v1").trim(), "?? untracked.txt");
  eq("brw-branch-gate/1.13 未追跡のファイルは移さず、一覧に返す", [existsSync(join(t.wt, "untracked.txt")), r.skipped], [false, ["untracked.txt"]]);
  eq("brw-branch-gate/1.12 復旧用の参照が移した内容を指し、共有の退避の置き場は増えない", [
    r.recoveryRef, carryRefOf("dev/carry"), tryGit(t.src, "rev-parse", "--verify", "--quiet", r.recoveryRef).startsWith("ERR"), git(t.src, "stash", "list"),
  ], ["refs/brw/carry/dev/carry", "refs/brw/carry/dev/carry", false, ""]);
  eq("brw-branch-gate/1.12 復旧用の参照から、移した内容を再び取り出せる", (() => {
    const back = join(t.dir, "back");
    git(t.src, "worktree", "add", "-q", "--detach", back, t.head);
    git(back, "stash", "apply", r.recoveryRef);
    return String(readFileSync(join(back, "mod.txt")));
  })(), "m2\n");

  // ---- 移す変更が無い ----
  const clean = setup();
  clean.w("untracked.txt", "u\n");
  const none = carryChanges({ source: clean.src, worktree: clean.wt, startOid: clean.head, branch: "dev/carry" });
  eq("brw-branch-gate/1.10 追跡済みの変更が無いときは none で、未追跡の一覧だけを返す", [none.kind, none.skipped], ["none", ["untracked.txt"]]);
  eq("brw-branch-gate/1.12 変更が無いときは復旧用の参照を作らない", tryGit(clean.src, "rev-parse", "--verify", "--quiet", carryRefOf("dev/carry")).startsWith("ERR"), true);

  // ---- 呼び出し側が別に扱ったファイルは、移さなかった一覧から除く ----
  eq("brw-branch-gate/1.13 exclude に挙げたパスは、移さなかった一覧に含めない", carryChanges({ source: clean.src, worktree: clean.wt, startOid: clean.head, branch: "dev/carry", exclude: ["untracked.txt"] }).skipped, []);

  // ---- 未追跡の一覧から除くのは配置先（.worktree/）の配下だけ。旧置き場（.claude/worktrees/）の配下は除かない ----
  const place = setup();
  dirty(place);
  mkdirSync(join(place.src, ".worktree", "keep"), { recursive: true });
  writeFileSync(join(place.src, ".worktree", "keep", "x.txt"), "x\n");
  mkdirSync(join(place.src, ".claude", "worktrees", "legacy"), { recursive: true });
  writeFileSync(join(place.src, ".claude", "worktrees", "legacy", "y.txt"), "y\n");
  const pr = carryChanges({ source: place.src, worktree: place.wt, startOid: place.head, branch: "dev/carry" });
  eq("brw-branch-gate/7.8 配置先（.worktree/）の配下の未追跡のファイルは、移さなかった一覧と件数に含まれない", [pr.kind, pr.skipped.filter((p) => p.startsWith(".worktree/"))], ["carried", []]);
  eq("brw-branch-gate/7.8 旧置き場（.claude/worktrees/）の配下の未追跡のファイルは、除外の対象でなく一覧に含まれる", [...pr.skipped].sort(), [".claude/worktrees/legacy/y.txt", "untracked.txt"]);

  // ---- 失敗: 開始点が元の HEAD と異なる → 元を変えない ----
  const off = setup();
  dirty(off);
  const before = snapshot(off.src);
  git(off.src, "stash", "list");
  const other = git(off.src, "commit-tree", "-m", "別のコミット", `${off.head}^{tree}`, "-p", off.head).trim();
  const offResult = carryChanges({ source: off.src, worktree: off.wt, startOid: other, branch: "dev/carry" });
  eq("brw-branch-gate/1.11 開始点が元の HEAD と異なるときは移さず failed で、元は変わらない", [offResult.kind, snapshot(off.src)], ["failed", before]);
  eq("brw-branch-gate/1.11 失敗のとき復旧用の参照も作らない", tryGit(off.src, "rev-parse", "--verify", "--quiet", carryRefOf("dev/carry")).startsWith("ERR"), true);

  // ---- 失敗: 新しい worktree の HEAD が開始点と異なる ----
  const drift = setup();
  dirty(drift);
  writeFileSync(join(drift.wt, "extra.txt"), "x\n");
  git(drift.wt, "add", "extra.txt");
  git(drift.wt, "commit", "-q", "-m", "ずれた");
  const driftBefore = snapshot(drift.src);
  eq("brw-branch-gate/1.11 新しい worktree の HEAD が開始点と異なるときは failed で、元は変わらない", [carryChanges({ source: drift.src, worktree: drift.wt, startOid: drift.head, branch: "dev/carry" }).kind, snapshot(drift.src)], ["failed", driftBefore]);

  // ---- 失敗: 適用の競合 → 元を変えない ----
  const conflict = setup();
  dirty(conflict);
  writeFileSync(join(conflict.wt, "mod.txt"), "競合する未コミットの内容\n"); // 新しい worktree に先にある変更と衝突する
  const cBefore = snapshot(conflict.src);
  const cr = carryChanges({ source: conflict.src, worktree: conflict.wt, startOid: conflict.head, branch: "dev/carry" });
  eq("brw-branch-gate/1.11 適用が失敗したときは failed で、元の作業ツリーは変わらず、復旧用の参照も作らない", [cr.kind, snapshot(conflict.src), tryGit(conflict.src, "rev-parse", "--verify", "--quiet", carryRefOf("dev/carry")).startsWith("ERR")], ["failed", cBefore, true]);

  // ---- 取り除きの前に元が変わった → 違うパスは残し、一覧と復旧用の参照を返す ----
  const race = setup();
  dirty(race);
  const rr = carryChanges({ source: race.src, worktree: race.wt, startOid: race.head, branch: "dev/carry", hooks: { beforeRemove: () => writeFileSync(join(race.src, "mod.txt"), "別のセッションの編集\n") } });
  eq("brw-branch-gate/1.12 取り除きの前に変わったパスは取り除かず、取り除いたものと残したものの一覧を返す", [rr.kind, rr.kept, [...rr.removed].sort()], ["keptBoth", ["mod.txt"], ["bin.dat", "both.txt", "del.txt", "exec.sh", "new.txt", "st.txt"]]);
  eq("brw-branch-gate/1.12 残したパスの内容（別の編集）は元のまま失われず、復旧用の参照も残る", [readFileSync(join(race.src, "mod.txt"), "utf8"), rr.recoveryRef, tryGit(race.src, "rev-parse", "--verify", "--quiet", rr.recoveryRef).startsWith("ERR")], ["別のセッションの編集\n", "refs/brw/carry/dev/carry", false]);

  // ---- 取り除きの前にインデックスだけが変わった（作業ファイルは移した内容と同じ） → そのパスは取り除かず、内容を失わない ----
  const idx = setup();
  dirty(idx);
  const ir = carryChanges({ source: idx.src, worktree: idx.wt, startOid: idx.head, branch: "dev/carry", hooks: { beforeRemove: () => {
    writeFileSync(join(idx.src, "st.txt"), "別のセッションがステージした内容\n");
    git(idx.src, "add", "st.txt");
    writeFileSync(join(idx.src, "st.txt"), "s1\n");
  } } });
  eq("brw-branch-gate/1.12 インデックスだけが変わったパスは取り除かず、そのステージ済みの内容を失わない", [ir.kind, ir.kept, git(idx.src, "show", ":st.txt")], ["keptBoth", ["st.txt"], "別のセッションがステージした内容\n"]);

  // ---- 復旧用の参照が既にあるときは、それを失わないよう止まる ----
  const dup = setup();
  dirty(dup);
  git(dup.src, "update-ref", carryRefOf("dev/carry"), dup.head);
  const dupBefore = snapshot(dup.src);
  eq("brw-branch-gate/1.12 復旧用の参照が既にあるときは failed で、元は変わらない", [carryChanges({ source: dup.src, worktree: dup.wt, startOid: dup.head, branch: "dev/carry" }).kind, snapshot(dup.src)], ["failed", dupBefore]);

  // ---- 解決していない競合・サブモジュール ----
  const unmerged = setup();
  git(unmerged.src, "checkout", "-q", "-b", "side");
  unmerged.w("mod.txt", "side\n");
  git(unmerged.src, "commit", "-qam", "side");
  git(unmerged.src, "checkout", "-q", "develop");
  unmerged.w("mod.txt", "develop\n");
  git(unmerged.src, "commit", "-qam", "develop");
  tryGit(unmerged.src, "merge", "side");
  const um = carryChanges({ source: unmerged.src, worktree: unmerged.wt, startOid: git(unmerged.src, "rev-parse", "HEAD").trim(), branch: "dev/carry2" });
  eq("brw-branch-gate/1.11 解決していない競合があるときは failed で、元は変わらない", [um.kind, git(unmerged.src, "ls-files", "-u").trim() !== ""], ["failed", true]);

  // ---- brw create --carry（実際の CLI） ----
  const mk = (withDecl) => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), "brw-carry-cli-")));
    execFileSync("git", ["init", "-q", "-b", "develop", d], { stdio: "ignore" });
    const decl = JSON.stringify({ workBranches: ["dev/*"], protectedBranches: ["main"], baseBranch: "develop" });
    writeFileSync(join(d, ".branch-release-workflow.json"), decl);
    writeFileSync(join(d, "a.txt"), "a\n");
    git(d, "add", withDecl ? "." : "a.txt");
    git(d, "commit", "-q", "-m", "i");
    return d;
  };
  const c1 = mk(true);
  writeFileSync(join(c1, "a.txt"), "a2\n");
  writeFileSync(join(c1, "u.txt"), "u\n");
  const r1 = brw(c1, "create", "foo", "--carry");
  const wt1 = join(c1, ".worktree", "dev-foo");
  eq("brw-branch-gate/1.10 brw create --carry は変更を新しい worktree へ移し、元から取り除く", [r1.status, readFileSync(join(wt1, "a.txt"), "utf8"), git(c1, "status", "--porcelain").includes("a.txt")], [0, "a2\n", false]);
  eq("brw-branch-gate/1.13 --carry は移さなかった未追跡のファイルを表示し、配置先（.worktree/）の配下は含めない", [r1.stdout.includes("u.txt"), r1.stdout.includes("- .worktree/"), r1.stdout.includes("git stash apply refs/brw/carry/dev/foo")], [true, false, true]);
  // 連携 worktree から実行しても、配置先は本体の .worktree/（入れ子にしない）
  writeFileSync(join(wt1, "a.txt"), "a3\n");
  const r2 = brw(wt1, "create", "bar", "--carry");
  eq("brw-branch-gate/1.1 連携 worktree から実行しても配置先は本体の配下で、入れ子にしない", [r2.status, existsSync(join(c1, ".worktree", "dev-bar")), existsSync(join(wt1, ".worktree"))], [0, true, false]);
  eq("brw-branch-gate/1.10 --carry を付けない brw create は従来どおり変更を移さない", (() => {
    writeFileSync(join(c1, "a.txt"), "keep\n");
    const r = brw(c1, "create", "plain");
    return [r.status, readFileSync(join(c1, "a.txt"), "utf8"), readFileSync(join(c1, ".worktree", "dev-plain", "a.txt"), "utf8")];
  })(), [0, "keep\n", "a\n"]);
  eq("brw-branch-gate/1.11 --carry と --branch-only の併用は終了コード 2", brw(c1, "create", "x", "--carry", "--branch-only").status, 2);
  // 失敗の巻き戻し: 宣言ファイルが分岐元に未登録で、開始点が元の HEAD と異なる（--carry が失敗する）
  const c2 = mk(false);
  git(c2, "checkout", "-q", "-b", "side");
  writeFileSync(join(c2, "a.txt"), "side\n");
  git(c2, "commit", "-qam", "side");
  writeFileSync(join(c2, "a.txt"), "dirty\n");
  const r3 = brw(c2, "create", "foo", "--carry");
  eq("brw-branch-gate/1.11 --carry の失敗は worktree とブランチを残さず、宣言ファイルを元の場所に戻し、元の変更を保つ", [
    r3.status !== 0, existsSync(join(c2, ".worktree", "dev-foo")), tryGit(c2, "rev-parse", "--verify", "--quiet", "refs/heads/dev/foo").startsWith("ERR"),
    existsSync(join(c2, ".branch-release-workflow.json")), readFileSync(join(c2, "a.txt"), "utf8"), r3.stderr.includes("元の作業ツリーは変更していません"),
  ], [true, false, true, true, "dirty\n", true]);
  eq("brw-branch-gate/5.2 失敗のあと、同じ名前でもう一度作れる（作りかけが残っていない）", (() => {
    git(c2, "checkout", "-q", "-f", "develop");
    const r = brw(c2, "create", "foo");
    return [r.status, existsSync(join(c2, ".worktree", "dev-foo", ".branch-release-workflow.json"))];
  })(), [0, true]);


  // 配置先が worktree として登録されている（ディレクトリは消えている）ときは、何も消さずに止まる
  const c3 = mk(true);
  git(c3, "worktree", "add", "-q", "-b", "other", join(c3, ".worktree", "dev-foo"));
  rmSync(join(c3, ".worktree", "dev-foo"), { recursive: true });
  const r4 = brw(c3, "create", "foo");
  eq("brw-branch-gate/5.2 配置先が登録済みの worktree のときは、止まり、既存の登録とブランチを消さない", [
    r4.status !== 0, git(c3, "worktree", "list", "--porcelain").includes("dev-foo"), tryGit(c3, "rev-parse", "--verify", "--quiet", "refs/heads/other").startsWith("ERR"),
  ], [true, true, false]);

};
