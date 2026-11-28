// 分岐元の取り込み（syncBase）・差の数（countDiff）・作成先の決定（resolveTarget）の単体試験（brw-pr-handoff 7.2）。selftest.mjs から呼ばれる。
// 一時リポジトリと bare remote を実際の git で作る。HOME と Git の全域設定は隔離し、終わったら元に戻す。
// 状態の期待値は tests/base-sync-git.mjs（5.1）の観測に合わせる。
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 未実装の間は関数が無いため、各項目は失敗として記録される（RED の確認用）
const mod = await import("../scripts/base-sync.mjs").catch(() => ({}));
const syncBase = (...args) => (mod.syncBase ? mod.syncBase(...args) : { ok: false, code: "未実装", message: "未実装" });
const countDiff = (...args) => (mod.countDiff ? mod.countDiff(...args) : "未実装");
const resolveTarget = (...args) => (mod.resolveTarget ? mod.resolveTarget(...args) : { ok: false, message: "未実装" });

// 試験用の Git 設定の引数（commit の名前・メールは毎回渡す）
const GIT_BASE = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];
const git = (cwd, ...args) => execFileSync("git", [...GIT_BASE, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const gitOk = (cwd, ...args) => spawnSync("git", [...GIT_BASE, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).status === 0;
/** ファイルの内容を返す。無ければ null（取り込み前の状態を失敗として記録するため、例外にしない）。 */
const readOrNull = (path) => (existsSync(path) ? readFileSync(path, "utf8") : null);
const commitFile = (cwd, name, text, message = name) => {
  writeFileSync(join(cwd, name), `${text}\n`);
  git(cwd, "add", name);
  git(cwd, "commit", "-q", "-m", message);
};

// process.env を一時的に隔離する（syncBase・countDiff・remoteNameOf は既定の環境で git を呼ぶ）
const ISOLATED = ["HOME", "XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT"];
const withIsolatedEnv = (home, fn) => {
  const saved = Object.fromEntries(ISOLATED.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" });
  try {
    return fn();
  } finally {
    for (const k of ISOLATED) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
};

/**
 * 一時の作業場所を作る。main（init）と develop（main の先に d1）を、指定したすべての bare remote へ push 済みにする。
 * other は別の clone（別の環境）で、最初のリモートから clone する。
 */
const scenario = (remoteNames = ["origin"]) => {
  const root = mkdtempSync(join(tmpdir(), "brw-basesync-7-"));
  const home = join(root, "home");
  mkdirSync(home);
  const remotes = Object.fromEntries(remoteNames.map((n) => [n, join(root, `${n}.git`)]));
  for (const p of Object.values(remotes)) git(root, "init", "-q", "--bare", "-b", "main", p);
  const w = join(root, "w");
  mkdirSync(w);
  git(w, "init", "-q", "-b", "main");
  for (const [n, p] of Object.entries(remotes)) git(w, "remote", "add", n, p);
  commitFile(w, "init.txt", "init");
  git(w, "checkout", "-q", "-b", "develop");
  commitFile(w, "d1.txt", "d1");
  for (const n of remoteNames) git(w, "push", "-q", n, "main", "develop");
  const other = join(root, "other");
  git(root, "clone", "-q", "-b", "develop", remotes[remoteNames[0]], other);
  return { root, home, w, other, remotes, cleanup: () => rmSync(root, { recursive: true, force: true }) };
};

/** 作業を home の隔離環境で行う。 */
const inScenario = (remoteNames, fn) => {
  const s = scenario(remoteNames);
  try {
    return withIsolatedEnv(s.home, () => fn(s));
  } finally {
    s.cleanup();
  }
};

export const runBaseSyncChecks = async (eq) => {
  // ---- syncBase: 5.1 の各状態 ----

  // 1. 最新: 取り込みは不要で、updated は false。差は main に対して 1
  inScenario(["origin"], (s) => {
    const r = syncBase(s.w, "develop", "main");
    eq("brw-pr-handoff/7.2 1 分岐元が最新なら ok・updated false（取り込みは不要）", r, { ok: true, updated: false });
    eq("brw-pr-handoff/7.2 1 最新の状態で保護ブランチとの差は 1", countDiff(s.w, "main", "develop"), 1);
  });

  // 2. リモートが先行: fast-forward で取り込み、updated は true。取り込み後は差が 2
  inScenario(["origin"], (s) => {
    commitFile(s.other, "d2.txt", "d2");
    git(s.other, "push", "-q", "origin", "develop");
    const r = syncBase(s.w, "develop", "main");
    eq("brw-pr-handoff/7.2 2 リモートが先行なら取り込んで ok・updated true", r, { ok: true, updated: true });
    eq("brw-pr-handoff/7.2 2 取り込み後に新しい commit の内容がローカルにある", readOrNull(join(s.w, "d2.txt"))?.trim() ?? null, "d2");
    eq("brw-pr-handoff/7.2 2 取り込み後の保護ブランチとの差は 2", countDiff(s.w, "main", "develop"), 2);
  });

  // 3. ローカルが先行（未 push の commit）: ahead で止め、HEAD を動かさない
  inScenario(["origin"], (s) => {
    commitFile(s.w, "local.txt", "local1");
    const before = git(s.w, "rev-parse", "HEAD");
    const r = syncBase(s.w, "develop", "main");
    eq("brw-pr-handoff/7.2 3 ローカルが先行なら ahead で止める（リモートへ未 push）", [r.ok, r.code], [false, "ahead"]);
    eq("brw-pr-handoff/7.2 3 先行のときは HEAD を動かさない", git(s.w, "rev-parse", "HEAD"), before);
  });

  // 4. 分岐（両方に commit）: diverged で止め、HEAD を動かさない
  inScenario(["origin"], (s) => {
    commitFile(s.w, "local.txt", "local1");
    commitFile(s.other, "d3.txt", "d3");
    git(s.other, "push", "-q", "origin", "develop");
    const before = git(s.w, "rev-parse", "HEAD");
    const r = syncBase(s.w, "develop", "main");
    eq("brw-pr-handoff/7.2 4 先行と遅れの両方があれば diverged で止める", [r.ok, r.code], [false, "diverged"]);
    eq("brw-pr-handoff/7.2 4 分岐のときは HEAD を動かさない", git(s.w, "rev-parse", "HEAD"), before);
  });

  // 5. 保護ブランチと差なし（develop を main と同じ commit にして push）: ok・updated false・差 0
  inScenario(["origin"], (s) => {
    git(s.w, "checkout", "-q", "main");
    git(s.w, "branch", "-f", "develop", "main");
    git(s.w, "checkout", "-q", "develop");
    git(s.w, "push", "-q", "-f", "origin", "develop");
    const r = syncBase(s.w, "develop", "main");
    eq("brw-pr-handoff/7.2 5 保護ブランチと差がなければ ok・updated false", r, { ok: true, updated: false });
    eq("brw-pr-handoff/7.2 5 保護ブランチとの差は 0（取り込む差が無い）", countDiff(s.w, "main", "develop"), 0);
  });

  // 6. 未コミットの変更が取り込む対象と衝突: ff-failed（または diverged ではない）。未コミットの内容は残る
  inScenario(["origin"], (s) => {
    commitFile(s.w, "f.txt", "v0", "f.txt を追加");
    git(s.w, "push", "-q", "origin", "develop");
    git(s.other, "pull", "-q", "origin", "develop");
    commitFile(s.other, "f.txt", "remote", "f.txt を変更");
    git(s.other, "push", "-q", "origin", "develop");
    writeFileSync(join(s.w, "f.txt"), "local-uncommitted\n");
    const r = syncBase(s.w, "develop", "main");
    eq("brw-pr-handoff/7.2 6 未コミットの変更と衝突すると ff-failed で止める", [r.ok, r.code], [false, "ff-failed"]);
    eq("brw-pr-handoff/7.2 6 衝突で止めても未コミットの内容は残る", readOrNull(join(s.w, "f.txt")), "local-uncommitted\n");
  });

  // 7. 未追跡ファイルだけがあり、取り込む対象と衝突しない: 取り込めて、未追跡の内容も残る
  inScenario(["origin"], (s) => {
    commitFile(s.other, "d2.txt", "d2");
    git(s.other, "push", "-q", "origin", "develop");
    writeFileSync(join(s.w, "scratch.txt"), "mine\n");
    const r = syncBase(s.w, "develop", "main");
    eq("brw-pr-handoff/7.2 7 未追跡ファイルだけなら取り込めて ok・updated true", r, { ok: true, updated: true });
    eq("brw-pr-handoff/7.2 7 取り込み後も未追跡ファイルの内容が残る", readOrNull(join(s.w, "scratch.txt")), "mine\n");
  });

  // 8. 取得失敗（存在しないリモートを push 先にしている）: fetch-failed で止める
  inScenario(["origin"], (s) => {
    git(s.w, "config", "branch.develop.pushRemote", "missing");
    const r = syncBase(s.w, "develop", "main");
    eq("brw-pr-handoff/7.2 8 取得に失敗したら fetch-failed で止める", [r.ok, r.code], [false, "fetch-failed"]);
  });

  // 9. pushRemote が origin 以外（up）: up の遅れを取り込み、origin の古い状態に引きずられない
  inScenario(["origin", "up"], (s) => {
    git(s.other, "remote", "add", "up", s.remotes.up);
    commitFile(s.other, "d2.txt", "d2");
    git(s.other, "push", "-q", "up", "develop");
    git(s.w, "config", "branch.develop.pushRemote", "up");
    const r = syncBase(s.w, "develop", "main");
    eq("brw-pr-handoff/7.2 9 pushRemote が up なら up の遅れを取り込んで updated true", r, { ok: true, updated: true });
    eq("brw-pr-handoff/7.2 9 pushRemote が up のとき、保護ブランチとの差を up の基準で数える", countDiff(s.w, "main", "develop"), 2);
  });

  // 10. 現在のブランチが分岐元でない: 取り込み先のブランチへ merge しないよう、ff-failed で止める
  inScenario(["origin"], (s) => {
    commitFile(s.other, "d2.txt", "d2");
    git(s.other, "push", "-q", "origin", "develop");
    git(s.w, "checkout", "-q", "main");
    const before = git(s.w, "rev-parse", "HEAD");
    const r = syncBase(s.w, "develop", "main");
    eq("brw-pr-handoff/7.2 10 現在のブランチが分岐元でなければ ff-failed で止める", [r.ok, r.code], [false, "ff-failed"]);
    eq("brw-pr-handoff/7.2 10 分岐元でないブランチを動かさない", git(s.w, "rev-parse", "HEAD"), before);
  });

  // 11. 不正なブランチ名（- で始まる）は git に渡さず止める
  inScenario(["origin"], (s) => {
    const r = syncBase(s.w, "-x", "main");
    eq("brw-pr-handoff/7.2 11 - で始まるブランチ名は拒否し、git を呼ばない", [r.ok], [false]);
  });

  // 13. 分岐元が追跡対象外（remote.origin.fetch が main だけ）でも、リモートの先行に追従する（明示した refspec で取得する）
  inScenario(["origin"], (s) => {
    git(s.w, "config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main");
    commitFile(s.other, "d2.txt", "d2");
    git(s.other, "push", "-q", "origin", "develop");
    const r = syncBase(s.w, "develop", "main");
    eq("brw-pr-handoff/7.2 13 追跡が main だけでも、リモートの先行に追従して updated true", r, { ok: true, updated: true });
    eq("brw-pr-handoff/7.2 13 追跡が main だけでも、取り込み後の保護ブランチとの差は最新の 2", countDiff(s.w, "main", "develop"), 2);
  });

  // 14. 追跡の範囲を絞ったリポジトリで、分岐元の遅れを数える（古い追跡参照で 0 と誤判定しない）
  inScenario(["origin"], (s) => {
    git(s.w, "config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main");
    commitFile(s.other, "d2.txt", "d2");
    git(s.other, "push", "-q", "origin", "develop");
    eq("brw-pr-handoff/7.2 14 追跡が絞られていても、取得前の差は古い参照でなく最新の値で数えられる（取得は syncBase が行う）", syncBase(s.w, "develop", "main").updated, true);
  });

  // 15. リモート名と同名のローカルブランチ（origin）があっても、リモートの参照を正しく使う
  inScenario(["origin"], (s) => {
    git(s.w, "branch", "origin", "main");
    commitFile(s.other, "d2.txt", "d2");
    git(s.other, "push", "-q", "origin", "develop");
    const r = syncBase(s.w, "develop", "main");
    eq("brw-pr-handoff/7.2 15 同名のローカルブランチがあっても、リモートの先行を取り込んで updated true", r, { ok: true, updated: true });
    eq("brw-pr-handoff/7.2 15 同名のローカルブランチがあっても、保護ブランチとの差は 2", countDiff(s.w, "main", "develop"), 2);
  });

  // ---- countDiff ----

  // 12. 取得していない・存在しないブランチは、0 ではなく -1（失敗）を返す
  inScenario(["origin"], (s) => {
    eq("brw-pr-handoff/7.2 12 差の数が求められなければ 0 ではなく -1 を返す", countDiff(s.w, "nosuch", "develop"), -1);
    eq("brw-pr-handoff/7.2 12 不正なブランチ名でも -1 を返す", countDiff(s.w, "-x", "develop"), -1);
  });

  // ---- resolveTarget ----
  const CONFIG = { workBranches: ["dev/*"], protectedBranches: ["main"], baseBranch: "develop" };
  eq("brw-pr-handoff/7.2 r1 --target が無く、保護ブランチが 1 つならそれを使う", resolveTarget(CONFIG, undefined), { ok: true, target: "main" });
  eq("brw-pr-handoff/7.2 r2 --target で保護ブランチを指定すればそれを使う", resolveTarget(CONFIG, "main"), { ok: true, target: "main" });
  eq("brw-pr-handoff/7.2 r3 --target が保護ブランチでなければ止める", resolveTarget(CONFIG, "develop").ok, false);
  eq("brw-pr-handoff/7.2 r4 --target が開発ブランチなら止める", resolveTarget(CONFIG, "dev/foo").ok, false);
  eq("brw-pr-handoff/7.2 r5 --target が - で始まれば止める", resolveTarget(CONFIG, "-x").ok, false);
  const TWO = { workBranches: ["dev/*"], protectedBranches: ["main", "release"], baseBranch: "develop" };
  const many = resolveTarget(TWO, undefined);
  eq("brw-pr-handoff/7.2 r6 保護ブランチが複数で --target が無ければ止め、--target を促す", [many.ok, typeof many.message === "string" && many.message.includes("--target")], [false, true]);
  eq("brw-pr-handoff/7.2 r7 複数のときも --target で指定すれば使える", resolveTarget(TWO, "release"), { ok: true, target: "release" });
  const NONE = { workBranches: ["dev/*"], protectedBranches: [], baseBranch: "develop" };
  eq("brw-pr-handoff/7.2 r8 保護ブランチが宣言されていなければ止める", resolveTarget(NONE, undefined).ok, false);
  const GLOB = { workBranches: ["dev/*"], protectedBranches: ["release/*"], baseBranch: "develop" };
  eq("brw-pr-handoff/7.2 r9 保護ブランチがパターンだけなら、--target が無いと決められず止める", resolveTarget(GLOB, undefined).ok, false);
  eq("brw-pr-handoff/7.2 r10 パターンに当たる保護ブランチは --target で指定できる", resolveTarget(GLOB, "release/1"), { ok: true, target: "release/1" });
  const WITH_PATTERN = { workBranches: ["dev/*"], protectedBranches: ["main", "release/*"], baseBranch: "develop" };
  eq("brw-pr-handoff/7.2 r11 保護ブランチの宣言がパターンを含めて複数なら、--target が無ければ止める", resolveTarget(WITH_PATTERN, undefined).ok, false);
  eq("brw-pr-handoff/7.2 r12 パターンだけの宣言は、--target が無ければ止める", resolveTarget(GLOB, undefined).ok, false);
  eq("brw-pr-handoff/7.2 r13 宣言が固定名 1 つ（main）だけなら、それを自動選択する", resolveTarget({ workBranches: ["dev/*"], protectedBranches: ["main"], baseBranch: "develop" }, undefined), { ok: true, target: "main" });
  const STAGING = { workBranches: ["dev/*"], protectedBranches: ["main", "staging"], baseBranch: "develop" };
  eq("brw-pr-handoff/7.2 r14 固定名が複数なら、--target が無ければ止める", resolveTarget(STAGING, undefined).ok, false);
  eq("brw-pr-handoff/7.2 r15 パターンに一致する固定名は --target で採用する（既存の挙動）", resolveTarget(WITH_PATTERN, "release/1"), { ok: true, target: "release/1" });
};
