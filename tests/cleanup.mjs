// 片付け（cleanup）の試験。selftest.mjs から呼ばれる。実際の一時リポジトリ（本体・worktree・bare の origin）で確かめる。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cleanupAfterPr, finishBlocker } from "../scripts/cleanup.mjs";
import { bodyPathOf } from "../scripts/pr-template.mjs";
import { startWork, stateFileOf } from "../scripts/publish.mjs";
import { normalizeConfig, worktrees } from "../scripts/lib.mjs";

const BRW = join(dirname(new URL(import.meta.url).pathname), "..", "scripts", "brw.mjs");
const CONFIG = normalizeConfig({ workBranches: ["dev/*"], protectedBranches: ["main"], baseBranch: "develop" });
const g = (cwd, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-C", cwd, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// 本体（develop）・push 済みの作業ブランチ dev/foo の worktree・bare の origin・作業状態（公開済み）を用意する
// legacy: true なら旧置き場（<本体>/.claude/worktrees/）に worktree を作る。既定は配置先（<本体>/.worktree/）
function setup({ legacy = false } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "brw-cleanup-")));
  const origin = join(dir, "origin.git");
  const main = join(dir, "main");
  execFileSync("git", ["init", "-q", "--bare", origin], { stdio: "ignore" });
  execFileSync("git", ["init", "-q", "-b", "develop", main], { stdio: "ignore" });
  g(main, "remote", "add", "origin", origin);
  writeFileSync(join(main, ".branch-release-workflow.json"), JSON.stringify({ workBranches: ["dev/*"], protectedBranches: ["main"], baseBranch: "develop" }));
  writeFileSync(join(main, "a.txt"), "a\n");
  g(main, "add", "-A");
  g(main, "commit", "-q", "-m", "init");
  g(main, "push", "-q", "origin", "develop");
  const wt = legacy ? join(main, ".claude", "worktrees", "dev-foo") : join(main, ".worktree", "dev-foo");
  g(main, "worktree", "add", "-q", "-b", "dev/foo", wt);
  writeFileSync(join(wt, "f.txt"), "f\n");
  g(wt, "add", "f.txt");
  g(wt, "commit", "-q", "-m", "work");
  g(wt, "push", "-q", "origin", "dev/foo");
  const oid = g(wt, "rev-parse", "HEAD").trim();
  const started = startWork(wt, {});
  const workId = started.work?.id ?? Object.keys(JSON.parse(readFileSync(stateFileOf(wt), "utf8")).works)[0];
  const body = bodyPathOf(main, "dev/foo");
  mkdirSync(dirname(body), { recursive: true });
  writeFileSync(body, "本文\n");
  const known = { url: "https://github.com/acme/app/pull/1", base: "develop", oid, remote: "origin" };
  const info = () => { const [m, ...others] = worktrees(main); return { main: m, others }; };
  return { dir, main, wt, oid, workId, body, known, state: stateFileOf(wt), info };
}
const run = (t, over = {}) => { const { main, others } = t.info(); return cleanupAfterPr({ main, others, config: CONFIG, branch: "dev/foo", workId: t.workId, known: t.known, ...over }); };
const exists = (t) => ({ wt: existsSync(t.wt), branch: (() => { try { g(t.main, "rev-parse", "--verify", "--quiet", "refs/heads/dev/foo"); return true; } catch { return false; } })(), state: existsSync(t.state), body: existsSync(t.body) });

export const runCleanupChecks = async (eq) => {
  // 安全なとき: 削除される
  const ok = setup();
  const r = run(ok);
  eq("brw-pr-handoff/4.1 安全が確認できたとき、worktree・ローカルブランチ・本文ファイル・作業状態を削除する", [r.kind, exists(ok), r.stateRemoved], ["cleaned", { wt: false, branch: false, state: false, body: false }, true]);
  eq("brw-pr-handoff/4.2 片付けが完了したとき、その作業の作業状態の記録も削除される", existsSync(ok.state), false);
  eq("brw-pr-handoff/4.3 片付けでリモートのブランチは削除しない", g(ok.main, "ls-remote", "origin", "refs/heads/dev/foo").trim().length > 0, true);
  eq("brw-pr-handoff/4.8 片付けの結果に、本体のパスと片付けた worktree を含める（案内に使う）", [r.main, r.worktree], [ok.main, ok.wt]);

  // 確認できないとき: 何も消さない
  const keptCases = [
    ["公開した後に追加のコミットがある（先端が違う）", (t) => { writeFileSync(join(t.wt, "g.txt"), "g\n"); g(t.wt, "add", "g.txt"); g(t.wt, "commit", "-q", "-m", "後から"); }, {}],
    ["遠隔に同名のブランチが無い", (t) => g(t.main, "push", "-q", "origin", "--delete", "dev/foo"), {}],
    ["遠隔の先端が公開した OID と違う", (t) => { const other = g(t.main, "commit-tree", "-m", "別", "-p", t.oid, `${t.oid}^{tree}`).trim(); g(t.main, "push", "-q", "-f", "origin", `${other}:refs/heads/dev/foo`); }, {}],
    ["未コミットの変更がある", (t) => writeFileSync(join(t.wt, "f.txt"), "変更\n"), {}],
    ["記録された push 先のリモートが別のものになっている", () => {}, { known: (t) => ({ ...t.known, remote: "elsewhere" }) }],
    ["公開記録が無い", () => {}, { known: () => null }],
    ["公開記録の OID が欠けている", () => {}, { known: (t) => ({ ...t.known, oid: undefined }) }],
  ];
  for (const [label, mutate, over] of keptCases) {
    const t = setup();
    mutate(t);
    const res = run(t, over.known ? { known: over.known(t) } : {});
    eq(`brw-pr-handoff/4.3 ${label} ときは片付けず、理由を返し、何も削除しない`, [res.kind, typeof res.reason === "string" && res.reason.length > 0, exists(t)], ["kept", true, { wt: true, branch: true, state: true, body: true }]);
  }

  // 別のリモート名でも、記録されたリモート名で確認する
  const alt = setup();
  const altOrigin = join(alt.dir, "alt.git");
  execFileSync("git", ["init", "-q", "--bare", altOrigin], { stdio: "ignore" });
  g(alt.main, "remote", "add", "upstream", altOrigin);
  g(alt.wt, "push", "-q", "upstream", "dev/foo");
  g(alt.main, "push", "-q", "origin", "--delete", "dev/foo");
  eq("brw-pr-handoff/4.4 origin 以外の push 先でも、記録されたリモート名で確認して片付ける", [run(alt, { known: { ...alt.known, remote: "upstream" } }).kind, exists(alt).wt], ["cleaned", false]);

  // 他の記録が残るときは状態ファイルを残す
  const multi = setup();
  const second = JSON.parse(readFileSync(multi.state, "utf8"));
  second.works["w-other-00000000"] = { ...second.works[multi.workId], status: "published" };
  writeFileSync(multi.state, JSON.stringify(second));
  const mr = run(multi);
  const after = JSON.parse(readFileSync(multi.state, "utf8"));
  eq("brw-pr-handoff/4.10 他の記録が残るときは、この作業の記録だけを取り除き、状態ファイルは残す", [mr.kind, existsSync(multi.state), Object.keys(after.works)], ["cleaned", true, ["w-other-00000000"]]);

  // ブランチの削除に失敗したとき: brw finish で回復できる
  const rec = setup();
  mkdirSync(join(rec.main, ".git", "refs", "heads", "dev"), { recursive: true });
  writeFileSync(join(rec.main, ".git", "refs", "heads", "dev", "foo.lock"), "");
  const rr = run(rec);
  eq("brw-pr-handoff/4.11 ブランチの削除に失敗したときは、片付けを止め、brw finish での回復を案内し、状態は残す", [rr.kind, rr.reason.includes("brw finish dev/foo"), existsSync(rec.state), existsSync(rec.wt)], ["kept", true, true, false]);
  eq("brw-pr-handoff/4.11 削除前に状態ファイルの場所をブランチの設定に残す", g(rec.main, "config", "branch.dev/foo.brwState").trim(), rec.state);
  execFileSync("rm", ["-f", join(rec.main, ".git", "refs", "heads", "dev", "foo.lock")]);
  g(rec.main, "merge", "-q", "--no-ff", "-m", "取り込み", "dev/foo"); // 手動の finish は、取り込み済みの作業ブランチだけを片付ける
  g(rec.main, "push", "-q", "origin", "develop");
  const fin = execFileSync("node", [BRW, "finish", "dev/foo", "--base", "develop"], { cwd: rec.main, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).toString();
  eq("brw-pr-handoff/4.11 手動の brw finish で回復でき、作業状態も取り除かれる", [existsSync(rec.state), exists(rec).branch, fin.includes("作業状態の記録も取り除きました")], [false, false, true]);

  // 回復用の記録を書けないときは、削除の前に止まる（ブランチの設定ファイルが書けない状況を作る）
  const noCfg = setup();
  writeFileSync(join(noCfg.main, ".git", "config.lock"), "");
  const nr = run(noCfg);
  execFileSync("rm", ["-f", join(noCfg.main, ".git", "config.lock")]);
  eq("brw-pr-handoff/4.11 回復用の記録を書けないときは、何も削除せずに止まる", [nr.kind, exists(noCfg)], ["kept", { wt: true, branch: true, state: true, body: true }]);
  // 本文ファイルの削除に失敗しても、状態の削除に進み、手順を返す（例外にしない）
  const stuck = setup();
  execFileSync("rm", ["-f", stuck.body]);
  mkdirSync(join(stuck.body, "dir"), { recursive: true }); // ファイルのはずの場所がディレクトリ（force でも rmSync が失敗する）
  const sr = run(stuck);
  eq("brw-pr-handoff/4.10 本文ファイルを削除できなくても例外にせず、状態の記録は取り除き、手順を返す", [sr.kind, sr.stateRemoved, sr.stateNote?.includes("本文ファイル")], ["cleaned", true, true]);

  // 手動の brw finish の従来の挙動: 未 push・未コミットは残す
  const manual = setup();
  writeFileSync(join(manual.wt, "dirty.txt"), "d\n");
  let blocked = "";
  try { execFileSync("node", [BRW, "finish", "dev/foo", "--base", "develop"], { cwd: manual.main, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { blocked = String(e.stderr); }
  eq("brw-pr-handoff/4.5 手動の brw finish は従来どおり、未コミットのある worktree を残す", [blocked.includes("commit していない変更"), exists(manual).wt], [true, true]);

  // 旧置き場（<本体>/.claude/worktrees/）の worktree を持つブランチは、取り込み済みでも片付けない（要件 7.6）
  const hasBranch = (cwd, b) => { try { g(cwd, "rev-parse", "--verify", "--quiet", `refs/heads/${b}`); return true; } catch { return false; } };
  const lg = setup({ legacy: true });
  g(lg.main, "merge", "-q", "--no-ff", "-m", "取り込み", "dev/foo");
  g(lg.main, "push", "-q", "origin", "develop");
  const lgInfo = lg.info();
  const lwhy = finishBlocker(lgInfo.main, lgInfo.others, CONFIG, "dev/foo", "develop");
  eq("brw-branch-gate/7.6 旧置き場の worktree を持つブランチは、取り込み済みでも片付けず、旧パス・新しい配置先・ブランチも消さないことを理由に含める", [typeof lwhy === "string", lwhy?.includes(lg.wt), lwhy?.includes(join(lg.main, ".worktree", "dev-foo")), lwhy?.includes("ブランチも消しません")], [true, true, true, true]);
  let lcode = 0;
  try { execFileSync("node", [BRW, "finish", "dev/foo", "--base", "develop"], { cwd: lg.main, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { lcode = e.status; }
  eq("brw-branch-gate/7.6 brw finish は旧置き場の worktree を持つブランチを終了コード 1 で止め、worktree もブランチも残す", [lcode, exists(lg).wt, exists(lg).branch], [1, true, true]);

  // finish --merged: 旧置き場のブランチは「残します」の行になり、.worktree/ の取り込み済みブランチは従来どおり片付く（要件 7.7）
  const addWork = (t, branch, rel) => {
    const p = join(t.main, rel);
    g(t.main, "worktree", "add", "-q", "-b", branch, p);
    writeFileSync(join(p, "w.txt"), `${branch}\n`);
    g(p, "add", "w.txt");
    g(p, "commit", "-q", "-m", branch);
    g(p, "push", "-q", "origin", branch);
    return p;
  };
  const mg = setup();
  const mgLegacyWt = addWork(mg, "dev/legacy", join(".claude", "worktrees", "dev-legacy"));
  g(mg.main, "merge", "-q", "--no-ff", "-m", "取り込み", "dev/foo");
  g(mg.main, "merge", "-q", "--no-ff", "-m", "取り込み", "dev/legacy");
  g(mg.main, "push", "-q", "origin", "develop");
  const mout = execFileSync("node", [BRW, "finish", "--merged", "--base", "develop"], { cwd: mg.main, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).toString();
  eq("brw-branch-gate/7.7 finish --merged は旧置き場のブランチを「残します」の行にし、.worktree/ の取り込み済みブランチは従来どおり片付ける", [mout.includes("残します: dev/legacy — "), mout.includes("片付けました: dev/foo"), existsSync(mgLegacyWt), hasBranch(mg.main, "dev/legacy"), exists(mg).wt, hasBranch(mg.main, "dev/foo")], [true, true, true, true, false, false]);

  // 配置先（.worktree）がシンボリックリンクのとき、worktree の所属を判定できないため片付けない（要件 5.1）
  const sy = setup();
  const elsewhere = join(sy.dir, "elsewhere");
  mkdirSync(elsewhere);
  g(sy.main, "worktree", "move", sy.wt, join(elsewhere, "dev-foo"));
  rmSync(join(sy.main, ".worktree"), { recursive: true, force: true });
  symlinkSync(elsewhere, join(sy.main, ".worktree"));
  sy.wt = join(elsewhere, "dev-foo");
  const syInfo = sy.info();
  const swhy = finishBlocker(syInfo.main, syInfo.others, CONFIG, "dev/foo", "develop");
  eq("brw-branch-gate/5.1 配置先がシンボリックリンクのときは所属を判定できないとして片付けず、理由を返す（worktree もブランチも消さない）", [typeof swhy === "string" && swhy.includes("判定できない"), swhy?.includes(".claude/worktrees") ?? true, exists(sy).wt, exists(sy).branch], [true, false, true, true]);

  // 本文置き場（.worktree/.brw）がリンクで旧置き場（.claude/worktrees/.brw）を指すとき、旧置き場の本文は消さない（要件 3.12）。片付け自体は行う
  const lk = setup();
  const legacyBodyDir = join(lk.main, ".claude", "worktrees", ".brw");
  mkdirSync(legacyBodyDir, { recursive: true });
  writeFileSync(join(legacyBodyDir, "dev-foo.md"), "旧置き場の本文\n");
  rmSync(join(lk.main, ".worktree", ".brw"), { recursive: true, force: true });
  symlinkSync(legacyBodyDir, join(lk.main, ".worktree", ".brw"));
  const lkRes = run(lk);
  eq("brw-pr-handoff/3.12 本文置き場がリンクで旧置き場を指すとき、旧置き場の本文を消さず、片付けは行う", [lkRes.kind, existsSync(join(legacyBodyDir, "dev-foo.md"))], ["cleaned", true]);
};
