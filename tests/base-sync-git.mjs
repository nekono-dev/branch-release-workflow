// 分岐元の取り込みと差の判定を、実際の git で再現する試験（brw-pr-handoff 5.1）。selftest.mjs から呼ばれる（単独実行も可）。
// .kiro/specs/brw-pr-handoff/poc/base-sync.sh の観測を、各状態ごとに独立した一時リポジトリで固定する。
// 観測は `fetch` → 先行・遅れの数 → `merge --ff-only` → 取り込み後の遅れ → 保護ブランチとの差 の順。
// BRW 本体（scripts/）には依存せず、git コマンドを直接呼ぶ。HOME と Git の全域設定は隔離する（integration-enforcement.mjs の ISO と同じ流儀）。
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// 利用者の Git 設定・HOME に左右されない環境。fixture の初期化を含むすべての git の子プロセスに使う
const isoEnv = (home) => ({
  PATH: process.env.PATH,
  LANG: "C.UTF-8",
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
});

// 名前とメールは毎回渡す（commit のための設定に依存しない）
const GIT_BASE = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];

/** git を実行し、標準出力を前後の空白なしで返す。失敗は例外。 */
const git = (env, cwd, ...args) => execFileSync("git", [...GIT_BASE, ...args], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** git を実行し、成功（終了コード 0）なら true。失敗は例外にしない。 */
const gitOk = (env, cwd, ...args) => spawnSync("git", [...GIT_BASE, ...args], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).status === 0;

/** git config の値を返す。未設定なら null。 */
const configOf = (env, cwd, key) => {
  const r = spawnSync("git", [...GIT_BASE, "config", "--get", key], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return r.status === 0 ? r.stdout.trim() : null;
};

/** 範囲の commit 数を数える（rev-list --count）。 */
const count = (env, cwd, range) => Number(git(env, cwd, "rev-list", "--count", range));

/** ファイルを書いて commit する。 */
const commitFile = (env, cwd, name, message) => {
  writeFileSync(join(cwd, name), `${message}\n`);
  git(env, cwd, "add", name);
  git(env, cwd, "commit", "-q", "-m", message);
};

/**
 * 分岐元の push 先のリモート名を求める（design.md の remoteNameOf と同じ順序）。
 * branch.<分岐元>.pushRemote → remote.pushDefault → branch.<分岐元>.remote → origin。origin を固定にしない根拠の確認に使う。
 */
const remoteOf = (env, cwd, branch) => configOf(env, cwd, `branch.${branch}.pushRemote`) ?? configOf(env, cwd, "remote.pushDefault") ?? configOf(env, cwd, `branch.${branch}.remote`) ?? "origin";

/**
 * 一時の作業場所を作る。main（init）と develop（main の先に d1）を、指定したすべての bare remote へ push 済みにする。
 * other は別の clone（別環境）で、最初のリモートから clone する。other の origin は、その最初のリモート。
 * 戻り値の cleanup で一時ディレクトリを消す。
 */
const scenario = (remoteNames = ["origin"]) => {
  const root = mkdtempSync(join(tmpdir(), "brw-basesync-"));
  const home = join(root, "home");
  mkdirSync(home);
  const env = isoEnv(home);
  const remotes = Object.fromEntries(remoteNames.map((n) => [n, join(root, `${n}.git`)]));
  for (const p of Object.values(remotes)) git(env, root, "init", "-q", "--bare", "-b", "main", p);

  const w = join(root, "w");
  mkdirSync(w);
  git(env, w, "init", "-q", "-b", "main");
  for (const [n, p] of Object.entries(remotes)) git(env, w, "remote", "add", n, p);
  commitFile(env, w, "init.txt", "init");
  git(env, w, "checkout", "-q", "-b", "develop");
  commitFile(env, w, "d1.txt", "d1");
  for (const n of remoteNames) git(env, w, "push", "-q", n, "main", "develop");

  const other = join(root, "other");
  git(env, root, "clone", "-q", "-b", "develop", remotes[remoteNames[0]], other);

  return { root, home, env, w, other, remotes, cleanup: () => rmSync(root, { recursive: true, force: true }) };
};

/**
 * 観測: 分岐元を、指定したリモートから fetch し、先行・遅れを数えてから ff-only で取り込み、
 * 取り込み後の遅れと保護ブランチとの差を数える（poc/base-sync.sh の sync と同じ順序）。
 */
const observe = (env, w, remote) => {
  git(env, w, "fetch", "-q", remote, "develop", "main");
  const ahead = count(env, w, `${remote}/develop..develop`);
  const behind = count(env, w, `develop..${remote}/develop`);
  const ff = gitOk(env, w, "merge", "--ff-only", `${remote}/develop`) ? "ok" : "ng";
  const behindAfter = count(env, w, `develop..${remote}/develop`);
  const mainDiff = count(env, w, `${remote}/main..develop`);
  // 結果は [取り込み, 先行, 遅れ, 取り込み後の遅れ, 保護ブランチとの差] の配列で比べる
  return [ff, ahead, behind, behindAfter, mainDiff];
};

/** 既定の観測先のリモート名（origin）。 */
const ORIGIN = "origin";

export const runBaseSyncGitChecks = async (eq) => {
  // 1. 分岐元が最新で main と差あり: ff は成功（変更なし）、先行 0・遅れ 0、main との差は 1（d1）
  {
    const s = scenario();
    try {
      eq("brw-pr-handoff/5.1 1 分岐元が最新: ff は成功し先行 0・遅れ 0・main との差 1", observe(s.env, s.w, ORIGIN), ["ok", 0, 0, 0, 1]);
    } finally { s.cleanup(); }
  }

  // 2. リモートが先行（別の clone が push）: fetch 後に ff-only が成功して取り込まれ、取り込み後の遅れは 0
  {
    const s = scenario();
    try {
      commitFile(s.env, s.other, "d2.txt", "d2");
      git(s.env, s.other, "push", "-q", "origin", "develop");
      eq("brw-pr-handoff/5.1 2 リモートが先行: 取り込み前の遅れは 1、ff-only が成功し、取り込み後の遅れは 0", observe(s.env, s.w, ORIGIN), ["ok", 0, 1, 0, 2]);
    } finally { s.cleanup(); }
  }

  // 3. ローカルが先行（未 push の commit）: ff-only は成功してしまう（「すでに最新」）。先行は rev-list で別に 1 と数えられる
  {
    const s = scenario();
    try {
      commitFile(s.env, s.w, "local.txt", "local1");
      eq("brw-pr-handoff/5.1 3 ローカルが先行: ff-only は成功（すでに最新）し、先行は rev-list で 1、遅れは 0", observe(s.env, s.w, ORIGIN), ["ok", 1, 0, 0, 2]);
    } finally { s.cleanup(); }
  }

  // 4. 分岐（両方に commit）: ff-only は失敗し、先行・遅れともに 1 以上
  {
    const s = scenario();
    try {
      commitFile(s.env, s.w, "local.txt", "local1");
      commitFile(s.env, s.other, "d3.txt", "d3");
      git(s.env, s.other, "push", "-q", "origin", "develop");
      eq("brw-pr-handoff/5.1 4 分岐: ff-only は失敗し、先行 1・遅れ 1 を数えられる", observe(s.env, s.w, ORIGIN), ["ng", 1, 1, 1, 2]);
    } finally { s.cleanup(); }
  }

  // 5. 保護ブランチ main と差なし（develop を main と同じ commit にする）: 差は 0
  {
    const s = scenario();
    try {
      git(s.env, s.w, "checkout", "-q", "main");
      git(s.env, s.w, "branch", "-f", "develop", "main");
      git(s.env, s.w, "checkout", "-q", "develop");
      git(s.env, s.w, "push", "-q", "-f", "origin", "develop");
      eq("brw-pr-handoff/5.1 5 main と差なし: ff は成功し、先行・遅れ・main との差がすべて 0", observe(s.env, s.w, ORIGIN), ["ok", 0, 0, 0, 0]);
    } finally { s.cleanup(); }
  }

  // 6a. 未コミットの変更が未追跡ファイルだけ: 取り込む対象と衝突しないので ff は成功
  {
    const s = scenario();
    try {
      commitFile(s.env, s.other, "d2.txt", "d2");
      git(s.env, s.other, "push", "-q", "origin", "develop");
      writeFileSync(join(s.w, "scratch.txt"), "未追跡\n");
      eq("brw-pr-handoff/5.1 6a 未追跡ファイルだけ: ff は成功する", observe(s.env, s.w, ORIGIN), ["ok", 0, 1, 0, 2]);
      // 取り込み後も未追跡ファイルは残り、内容は元と一致する（衝突ケースの内容保持の確認と同じ形）
      eq("brw-pr-handoff/5.1 6a 取り込み後も未追跡の scratch.txt が残り、内容が元と一致する", readFileSync(join(s.w, "scratch.txt"), "utf8"), "未追跡\n");
    } finally { s.cleanup(); }
  }

  // 6b. 取り込む対象と同じ追跡ファイルを変更している: ff は衝突して失敗する（何も壊さない）
  {
    const s = scenario();
    try {
      commitFile(s.env, s.other, "d1.txt", "d1 remote change");
      git(s.env, s.other, "push", "-q", "origin", "develop");
      writeFileSync(join(s.w, "d1.txt"), "未コミットの変更\n");
      eq("brw-pr-handoff/5.1 6b 取り込む対象と同じ追跡ファイルを変更: ff は失敗する", observe(s.env, s.w, ORIGIN), ["ng", 0, 1, 1, 1]);
      eq("brw-pr-handoff/5.1 6b 失敗しても、未コミットの変更の内容は残る", readFileSync(join(s.w, "d1.txt"), "utf8"), "未コミットの変更\n");
    } finally { s.cleanup(); }
  }

  // 7. 分岐元の push 先のリモートが origin 以外（up）のとき、そのリモート名で fetch・比較すると、origin 固定と違う結果になり、同じ結果も得られる
  for (const key of ["branch.develop.pushRemote", "remote.pushDefault"]) {
    const s = scenario(["origin", "up"]);
    try {
      // 別の clone は up に push する。origin は古いまま
      git(s.env, s.w, "config", key, "up");
      git(s.env, s.other, "remote", "set-url", "origin", s.remotes.up);
      commitFile(s.env, s.other, "d2.txt", "d2");
      git(s.env, s.other, "push", "-q", "origin", "develop");
      // origin 固定だと、古い origin/develop しか見ず遅れを見逃す（origin 固定にしない根拠）。up を使う前に観測する
      eq(`brw-pr-handoff/5.1 7 ${key} のとき origin 固定だと遅れを見逃す（根拠の観測）`, observe(s.env, s.w, ORIGIN), ["ok", 0, 0, 0, 1]);
      const remote = remoteOf(s.env, s.w, "develop");
      eq(`brw-pr-handoff/5.1 7 ${key} が up のとき、解決されたリモート名は up`, remote, "up");
      eq(`brw-pr-handoff/5.1 7 ${key} が up のとき、up で fetch・比較すると、リモートが先行の結果と同じ`, observe(s.env, s.w, remote), ["ok", 0, 1, 0, 2]);
    } finally { s.cleanup(); }
  }

  // 7 の対照: 設定が無いときの push 先の解決は origin
  {
    const s = scenario(["origin", "up"]);
    try {
      eq("brw-pr-handoff/5.1 7 push 先の設定が無いときは origin に解決する", remoteOf(s.env, s.w, "develop"), "origin");
    } finally { s.cleanup(); }
  }

  // 8. 再実行できる: 同じ状態を 2 回作って同じ結果になり、試験の後に一時ディレクトリが残らない
  {
    const run = () => {
      const s = scenario();
      try {
        commitFile(s.env, s.other, "d2.txt", "d2");
        git(s.env, s.other, "push", "-q", "origin", "develop");
        return { result: observe(s.env, s.w, ORIGIN), root: s.root };
      } finally { s.cleanup(); }
    };
    const first = run();
    const second = run();
    eq("brw-pr-handoff/5.1 8 同じ状態の再実行で結果が一致する", first.result, second.result);
    eq("brw-pr-handoff/5.1 8 試験の後に一時ディレクトリが残らない", [existsSync(first.root), existsSync(second.root)], [false, false]);
  }
};

// 単独で実行したとき（node tests/base-sync-git.mjs）の結果表示と終了コード
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
if (isMain) {
  let failed = 0;
  const eq = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n     got : ${JSON.stringify(got)}\n     want: ${JSON.stringify(want)}`}`);
  };
  await runBaseSyncGitChecks(eq);
  console.log(failed ? `\n${failed} 件失敗` : "\nすべて成功");
  process.exit(failed ? 1 : 0);
}
