// 作業ブランチの残りの検出（brw-enforcement 16.1）の単体試験。selftest.mjs から呼ばれる。
// 実際の一時リポジトリ・worktree で確かめる。作業の記録（状態ファイル）は作らない。
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { remaindersOf } from "../scripts/work-remainder.mjs";
import { gitOut, mkRepoWithRemote, mkWorktree } from "./support/git-fixture.mjs";

const CONFIG = { workBranches: ["dev/*"], protectedBranches: ["main"], baseBranch: "develop" };

// 比較しやすいように、パスを除いた形へ直す
const summary = (rs) => rs.map(({ branch, dirty, dirtyCount, unpushed, secretLike }) => ({ branch, dirty, dirtyCount, unpushed, secretLike }));
const write = (dir, name, text = "x\n") => writeFileSync(join(dir, name), text);
const commit = (dir, msg) => gitOut(dir, "commit", "--allow-empty", "-q", "-m", msg);

// BRW の導入先に近い形: 恒常的な分岐元（develop）がリモートにある。未 push の数は、これを基準に数える
const mkBrwRepo = (opts) => {
  const r = mkRepoWithRemote(opts);
  gitOut(r.dir, "push", "-q", "origin", "main:refs/heads/develop");
  return r;
};

// 開発ブランチ 1 本の fixture を作り、setup でコミットや push をしてから、そのブランチの未 push の数を返す（残りが無ければ 0）
const unpushedFor = (branch, setup) => {
  const f = mkBrwRepo({ branch: "main", config: CONFIG });
  try {
    const wt = mkWorktree(f.dir, branch);
    setup(wt, f);
    return remaindersOf(f.dir).find((r) => r.branch === branch)?.unpushed ?? 0;
  } finally {
    f.cleanup();
  }
};

export const runWorkRemainderChecks = async (eq) => {
  // ---- 変更・削除・新規・ignore・秘密らしい名前・未 push（追跡ブランチあり） ----
  const a = mkBrwRepo({ branch: "dev/foo", config: CONFIG });
  try {
    const d = a.dir;
    write(d, "a.txt", "a\n");
    write(d, ".gitignore", "ignored.log\n");
    gitOut(d, "add", "-A");
    gitOut(d, "commit", "-q", "-m", "a");
    gitOut(d, "push", "-q", "-u", "origin", "dev/foo");
    eq("work-remainder/16.1 push 済みで clean なら残りは空", remaindersOf(d), []);
    eq("work-remainder/16.1 作業の記録（.git/brw）を作らない", existsSync(join(d, ".git", "brw")), false);

    write(d, "a.txt", "a2\n");
    eq("work-remainder/16.1 追跡ファイルの変更は dirty に入り、push 済みなら未 push は 0", summary(remaindersOf(d)), [
      { branch: "dev/foo", dirty: ["a.txt"], dirtyCount: 1, unpushed: 0, secretLike: [] },
    ]);
    gitOut(d, "checkout", "--", "a.txt");

    rmSync(join(d, "a.txt"));
    eq("work-remainder/16.1 削除されたファイルも dirty に入る", summary(remaindersOf(d)), [
      { branch: "dev/foo", dirty: ["a.txt"], dirtyCount: 1, unpushed: 0, secretLike: [] },
    ]);
    gitOut(d, "checkout", "--", "a.txt");

    write(d, "new.txt");
    eq("work-remainder/16.1 新規の未追跡ファイルは dirty に入る", summary(remaindersOf(d)), [
      { branch: "dev/foo", dirty: ["new.txt"], dirtyCount: 1, unpushed: 0, secretLike: [] },
    ]);
    rmSync(join(d, "new.txt"));

    write(d, "ignored.log");
    eq("work-remainder/16.1 ignore されたファイルは数えない", remaindersOf(d), []);
    rmSync(join(d, "ignored.log"));

    for (const name of [".env", "id_rsa", "secret.txt", "normal.txt"]) write(d, name);
    eq("work-remainder/16.1 秘密らしい名前は secretLike に別に集める（通常の名前は含めない）", summary(remaindersOf(d)), [
      { branch: "dev/foo", dirty: [".env", "id_rsa", "normal.txt", "secret.txt"], dirtyCount: 4, unpushed: 0, secretLike: [".env", "id_rsa", "secret.txt"] },
    ]);
    for (const name of [".env", "id_rsa", "secret.txt", "normal.txt"]) rmSync(join(d, name));

    write(d, "b.txt");
    gitOut(d, "add", "b.txt");
    gitOut(d, "commit", "-q", "-m", "b");
    eq("work-remainder/16.1 追跡ブランチがあり commit だけ未 push なら未 push の数を数える", summary(remaindersOf(d)), [
      { branch: "dev/foo", dirty: [], dirtyCount: 0, unpushed: 1, secretLike: [] },
    ]);
    gitOut(d, "push", "-q", "origin", "dev/foo");
    eq("work-remainder/16.1 push し直して clean になれば残りは空", remaindersOf(d), []);
  } finally {
    a.cleanup();
  }

  // ---- 追跡ブランチの無い新規ブランチ（初回 push 前） ----
  const b = mkBrwRepo({ branch: "dev/foo", config: CONFIG });
  try {
    write(b.dir, "c.txt");
    gitOut(b.dir, "add", "c.txt");
    gitOut(b.dir, "commit", "-q", "-m", "c");
    eq("work-remainder/16.1 追跡ブランチの無い新規ブランチでも未 push の commit を数える", summary(remaindersOf(b.dir)), [
      { branch: "dev/foo", dirty: [], dirtyCount: 0, unpushed: 1, secretLike: [] },
    ]);
  } finally {
    b.cleanup();
  }

  // ---- 畳まれた新規ディレクトリの中の秘密らしい名前（--untracked-files=normal は "dir/" の 1 行になる） ----
  const s = mkBrwRepo({ branch: "dev/foo", config: CONFIG });
  try {
    const d = s.dir;
    // ignore 対象は .git/info/exclude で指定する（作業ツリーの .gitignore を変えない）
    appendFileSync(join(d, ".git", "info", "exclude"), "build/\nmix/ignored.env\n");

    mkdirSync(join(d, "sub"));
    write(d, "sub/credentials.json");
    eq("work-remainder/16.1 新規ディレクトリ内の credentials.json を secretLike に入れる（dirty は畳んだ 1 件のまま）", summary(remaindersOf(d)), [
      { branch: "dev/foo", dirty: ["sub/"], dirtyCount: 1, unpushed: 0, secretLike: ["sub/credentials.json"] },
    ]);
    rmSync(join(d, "sub"), { recursive: true, force: true });

    mkdirSync(join(d, "x/y/z"), { recursive: true });
    write(d, "x/y/z/.env");
    write(d, "x/y/z/normal.txt");
    eq("work-remainder/16.1 深い階層の .env を相対パスで secretLike に入れ、通常のファイルは入れない", summary(remaindersOf(d)), [
      { branch: "dev/foo", dirty: ["x/"], dirtyCount: 1, unpushed: 0, secretLike: ["x/y/z/.env"] },
    ]);
    rmSync(join(d, "x"), { recursive: true, force: true });

    mkdirSync(join(d, "n"));
    write(d, "n/a.txt");
    write(d, "n/b.txt");
    eq("work-remainder/16.1 通常のファイルだけのディレクトリは secretLike が空", summary(remaindersOf(d)), [
      { branch: "dev/foo", dirty: ["n/"], dirtyCount: 1, unpushed: 0, secretLike: [] },
    ]);
    rmSync(join(d, "n"), { recursive: true, force: true });

    mkdirSync(join(d, "build"));
    write(d, "build/credentials.json");
    eq("work-remainder/16.1 ignore されたディレクトリは dirty にも secretLike にも入らない", remaindersOf(d), []);
    rmSync(join(d, "build"), { recursive: true, force: true });

    mkdirSync(join(d, "mix"));
    write(d, "mix/ignored.env");
    write(d, "mix/normal.txt");
    eq("work-remainder/16.1 ignore されたファイルは畳んだディレクトリの中でも secretLike に入れない", summary(remaindersOf(d)), [
      { branch: "dev/foo", dirty: ["mix/"], dirtyCount: 1, unpushed: 0, secretLike: [] },
    ]);
  } finally {
    s.cleanup();
  }

  // ---- リモートが 1 つも無いリポジトリ: 全 commit が未 push として数えられる（例外を設けない） ----
  const nr = mkdtempSync(join(tmpdir(), "brw-wr-noremote-"));
  try {
    gitOut(nr, "init", "-q", "-b", "main");
    gitOut(nr, "commit", "-q", "--allow-empty", "-m", "初期");
    writeFileSync(join(nr, ".branch-release-workflow.json"), JSON.stringify(CONFIG));
    gitOut(nr, "add", ".branch-release-workflow.json");
    gitOut(nr, "commit", "-q", "-m", "宣言");
    gitOut(nr, "checkout", "-q", "-b", "dev/foo");
    write(nr, "b.txt");
    gitOut(nr, "add", "b.txt");
    gitOut(nr, "commit", "-q", "-m", "b");
    const commits = Number(gitOut(nr, "rev-list", "--count", "HEAD"));
    eq("work-remainder/16.1 リモートが無ければ commit 済みは全件が未 push（unpushed は commit 数）", summary(remaindersOf(nr)), [
      { branch: "dev/foo", dirty: [], dirtyCount: 0, unpushed: commits, secretLike: [] },
    ]);
    write(nr, "dirty.txt");
    eq("work-remainder/16.1 リモートが無くても未コミットの変更は検出する（未 push の数も併記）", summary(remaindersOf(nr)), [
      { branch: "dev/foo", dirty: ["dirty.txt"], dirtyCount: 1, unpushed: commits, secretLike: [] },
    ]);
  } finally {
    rmSync(nr, { recursive: true, force: true });
  }

  // ---- 対象外: 保護 main・分岐元 develop・宣言外・detached HEAD・prunable（残りを作っても含めない） ----
  const c = mkBrwRepo({ branch: "main", config: CONFIG });
  try {
    write(c.dir, "m.txt");
    const base = mkWorktree(c.dir, "develop");
    write(base, "x.txt");
    const undeclared = mkWorktree(c.dir, "feature/x");
    write(undeclared, "x.txt");
    const detached = mkWorktree(c.dir, "dev/det");
    gitOut(detached, "checkout", "-q", "--detach");
    write(detached, "x.txt");
    const gone = mkWorktree(c.dir, "dev/gone");
    write(gone, "x.txt");
    rmSync(gone, { recursive: true, force: true });
    eq("work-remainder/16.1 保護・分岐元・宣言外・detached・prunable の worktree は対象外", remaindersOf(c.dir), []);

    // clean な本体（保護ブランチ）から、別の worktree の開発ブランチの残りを検出する（Codex の Stop の cwd が本体のままの形）
    rmSync(join(c.dir, "m.txt"));
    const dev = mkWorktree(c.dir, "dev/foo");
    write(dev, "work.txt");
    const devReal = realpathSync(dev);
    const fromMain = remaindersOf(c.dir);
    eq("work-remainder/16.1 clean な本体から別 worktree の開発ブランチの未コミットを検出する", summary(fromMain), [
      { branch: "dev/foo", dirty: ["work.txt"], dirtyCount: 1, unpushed: 0, secretLike: [] },
    ]);
    eq("work-remainder/16.1 検出した worktree のパスは開発ブランチの worktree を指す", fromMain.map((r) => realpathSync(r.path)), [devReal]);
    eq("work-remainder/16.1 cwd が別の worktree でも全 worktree を走査する", summary(remaindersOf(dev)), summary(fromMain));
    gitOut(dev, "add", "-A");
    gitOut(dev, "commit", "-q", "-m", "work");
    eq("work-remainder/16.1 commit だけ済んだ未 push は dirty 0・unpushed 1", summary(remaindersOf(c.dir)), [
      { branch: "dev/foo", dirty: [], dirtyCount: 0, unpushed: 1, secretLike: [] },
    ]);
    gitOut(dev, "push", "-q", "-u", "origin", "dev/foo");
    eq("work-remainder/16.1 push 済みで clean なら残りは空", remaindersOf(c.dir), []);
  } finally {
    c.cleanup();
  }

  // ---- 未導入のリポジトリ・宣言が不正なリポジトリは空 ----
  const e = mkBrwRepo({ branch: "dev/foo", config: null });
  try {
    write(e.dir, "x.txt");
    eq("work-remainder/16.1 未導入のリポジトリは空（案内しない）", remaindersOf(e.dir), []);
  } finally {
    e.cleanup();
  }
  const f = mkBrwRepo({ branch: "dev/foo", config: CONFIG });
  try {
    write(f.dir, "x.txt");
    writeFileSync(join(f.dir, ".branch-release-workflow.json"), "{ 壊れた JSON");
    eq("work-remainder/16.1 宣言が不正なら空（判定できないときは案内しない）", remaindersOf(f.dir), []);
  } finally {
    f.cleanup();
  }

  // ---- 上限 20 件: 先頭 20 件（本体を含む）だけを見る ----
  const g = mkBrwRepo({ branch: "main", config: CONFIG });
  try {
    const paths = [];
    for (let i = 1; i <= 20; i++) paths.push(mkWorktree(g.dir, `dev/w${i}`));
    for (const p of paths) write(p, "x.txt");
    eq("work-remainder/16.1 worktree は先頭 20 件（本体を含む）までを対象にする", remaindersOf(g.dir).length, 19);
  } finally {
    g.cleanup();
  }

  // ---- 畳まれたディレクトリ名を文字どおりに扱い、件数で打ち切らない ----
  const l = mkBrwRepo({ branch: "dev/foo", config: CONFIG });
  try {
    const d = l.dir;
    mkdirSync(join(d, "[abc]"));
    write(d, "[abc]/credentials.json");
    eq("work-remainder/16.1 角かっこを含むディレクトリ名を文字どおりに扱い、中の credentials.json を検出する", summary(remaindersOf(d)), [
      { branch: "dev/foo", dirty: ["[abc]/"], dirtyCount: 1, unpushed: 0, secretLike: ["[abc]/credentials.json"] },
    ]);
    rmSync(join(d, "[abc]"), { recursive: true, force: true });

    mkdirSync(join(d, "a*b"));
    write(d, "a*b/.env");
    eq("work-remainder/16.1 * を含むディレクトリ名を文字どおりに扱い、中の .env を検出する", summary(remaindersOf(d)), [
      { branch: "dev/foo", dirty: ["a*b/"], dirtyCount: 1, unpushed: 0, secretLike: ["a*b/.env"] },
    ]);
    rmSync(join(d, "a*b"), { recursive: true, force: true });

    mkdirSync(join(d, "big"));
    for (let i = 0; i < 2100; i++) write(d, `big/f${String(i).padStart(4, "0")}.txt`);
    // 列挙は名前順のため、最後に来るように zzz/ の下に置く
    mkdirSync(join(d, "big/zzz"));
    write(d, "big/zzz/.env");
    eq("work-remainder/16.1 2000 件を超える中身の最後の .env も検出する（件数で打ち切らない）", summary(remaindersOf(d)), [
      { branch: "dev/foo", dirty: ["big/"], dirtyCount: 1, unpushed: 0, secretLike: ["big/zzz/.env"] },
    ]);
  } finally {
    l.cleanup();
  }

  // ---- worktree のパスに空白・日本語・引用符・改行を含む場合（worktree list -z で解析する） ----
  const p = mkBrwRepo({ branch: "main", config: CONFIG });
  const extraPaths = [];
  const bases = [];
  try {
    const base = mkdtempSync(join(tmpdir(), "brw-wr-path-"));
    bases.push(base);
    const addWt = (branch, path) => {
      gitOut(p.dir, "worktree", "add", "-q", "-b", branch, path);
      extraPaths.push(path);
      return path;
    };
    const sp = addWt("dev/sp", join(base, 'a b 日本 "q"'));
    const nl = addWt("dev/nl", join(base, "x\ny"));
    write(sp, "s.txt");
    write(nl, "n.txt");
    eq("work-remainder/16.1 空白・日本語・引用符・改行を含む worktree のパスを正しく解析する", remaindersOf(p.dir).map((r) => [r.branch, realpathSync(r.path)]).sort(), [
      ["dev/nl", realpathSync(nl)],
      ["dev/sp", realpathSync(sp)],
    ]);
  } finally {
    for (const q of extraPaths) {
      try { gitOut(p.dir, "worktree", "remove", "--force", q); } catch { /* 無ければ無視 */ }
      rmSync(q, { recursive: true, force: true });
    }
    for (const b of bases) rmSync(b, { recursive: true, force: true });
    p.cleanup();
  }

  // ---- unborn ブランチ（コミットが無い）: 未コミットの変更は検出し、未 push は 0 とする ----
  const u = mkBrwRepo({ branch: "main", config: CONFIG });
  try {
    const wt = mkWorktree(u.dir, "dev/tmp");
    gitOut(wt, "checkout", "-q", "--orphan", "dev/u");
    write(wt, "u.txt");
    eq("work-remainder/16.1 コミットの無い開発ブランチ（unborn）でも未コミットの変更を検出し、未 push は 0", summary(remaindersOf(u.dir)), [
      { branch: "dev/u", dirty: [".branch-release-workflow.json", "u.txt"], dirtyCount: 2, unpushed: 0, secretLike: [] },
    ]);
  } finally {
    u.cleanup();
  }

  // ---- 未 push の定義（要件 2.9）: 同名のリモートブランチ・恒常的な分岐元にない commit を数える ----
  eq("work-remainder/16.1 分岐元に無い新しいブランチは、分岐元との差の全 commit を数える", unpushedFor("dev/n", (wt) => {
    commit(wt, "n1");
    commit(wt, "n2");
  }), 2);
  eq("work-remainder/16.1 分岐元（リモートの develop）と同じ commit だけなら 0", unpushedFor("dev/x", () => {}), 0);
  eq("work-remainder/16.1 分岐元にある commit は数えず、その後の commit だけ数える", unpushedFor("dev/y", (wt) => {
    commit(wt, "y1");
    gitOut(wt, "push", "-q", "origin", "HEAD:refs/heads/develop");
    commit(wt, "y2");
  }), 1);
  eq("work-remainder/16.1 同名のリモートブランチに無く、別名のリモートブランチにだけある commit は未 push と数える（0 にしない）", unpushedFor("dev/a", (wt) => {
    commit(wt, "a1");
    gitOut(wt, "push", "-q", "origin", "HEAD:refs/heads/dev/b");
  }), 1);
  eq("work-remainder/16.1 同名のリモートブランチと同一なら 0", unpushedFor("dev/c", (wt) => {
    commit(wt, "c1");
    gitOut(wt, "push", "-q", "-u", "origin", "dev/c");
  }), 0);
  eq("work-remainder/16.1 同名のリモートブランチが先行（ローカルが遅れている）なら 0", unpushedFor("dev/d", (wt) => {
    commit(wt, "d1");
    commit(wt, "d2");
    gitOut(wt, "push", "-q", "origin", "HEAD:refs/heads/dev/d");
    gitOut(wt, "reset", "-q", "--hard", "HEAD~1");
  }), 0);
  eq("work-remainder/16.1 同名のリモートブランチが遅れているなら、その後の差の数を数える", unpushedFor("dev/e", (wt) => {
    commit(wt, "e1");
    gitOut(wt, "push", "-q", "origin", "HEAD:refs/heads/dev/e");
    commit(wt, "e2");
    commit(wt, "e3");
  }), 2);
  eq("work-remainder/16.1 ローカルの develop は除外に使わない（push 前の commit を分岐元の一部と見なさない）", unpushedFor("dev/l", (wt) => {
    commit(wt, "l1");
    gitOut(wt, "branch", "-f", "develop", "HEAD");
  }), 1);

  // 複数のリモート: 片方にだけ同名のブランチがあれば、そのリモートの参照で除外する
  const m = mkBrwRepo({ branch: "main", config: CONFIG });
  const up2Base = mkdtempSync(join(tmpdir(), "brw-wr-up2-"));
  try {
    const up2 = join(up2Base, "up2.git");
    gitOut(m.dir, "init", "-q", "--bare", "-b", "main", up2);
    gitOut(m.dir, "remote", "add", "up2", up2);
    const wt = mkWorktree(m.dir, "dev/m");
    commit(wt, "m1");
    gitOut(wt, "push", "-q", "up2", "HEAD:refs/heads/dev/m");
    commit(wt, "m2");
    eq("work-remainder/16.1 複数のリモートのうち片方にだけ同名がある場合は、そのリモートの参照で除外する", remaindersOf(m.dir).find((r) => r.branch === "dev/m")?.unpushed, 1);
  } finally {
    m.cleanup();
    rmSync(up2Base, { recursive: true, force: true });
  }

  // 分岐元の追跡ブランチが無い（リモートに develop が無い）: 除外に使える参照が無いので全 commit
  const nd = mkRepoWithRemote({ branch: "main", config: CONFIG });
  try {
    const wt = mkWorktree(nd.dir, "dev/q");
    commit(wt, "q1");
    const all = Number(gitOut(wt, "rev-list", "--count", "HEAD"));
    eq("work-remainder/16.1 分岐元の追跡ブランチが無ければ、全 commit を未 push と数える", remaindersOf(nd.dir).find((r) => r.branch === "dev/q")?.unpushed, all);
  } finally {
    nd.cleanup();
  }

  // ---- 変更の X・Y 側の改名（R・C）の次のレコードは元のパスとして読み飛ばす ----
  const rn = mkBrwRepo({ branch: "dev/foo", config: CONFIG });
  try {
    const d = rn.dir;
    write(d, "c.txt");
    gitOut(d, "add", "c.txt");
    gitOut(d, "commit", "-q", "-m", "c");
    gitOut(d, "push", "-q", "-u", "origin", "dev/foo");
    // worktree 側（Y 側）の改名: 旧パスの削除と、新パスの intent-to-add で " R" になる
    rmSync(join(d, "c.txt"));
    write(d, "d.txt");
    gitOut(d, "add", "-N", "d.txt");
    eq("work-remainder/16.1 worktree 側（Y=R）の改名では、元のパスを別の変更として数えない", summary(remaindersOf(d)), [
      { branch: "dev/foo", dirty: ["d.txt"], dirtyCount: 1, unpushed: 0, secretLike: [] },
    ]);
  } finally {
    rn.cleanup();
  }
  const rn2 = mkBrwRepo({ branch: "dev/foo", config: CONFIG });
  try {
    const d = rn2.dir;
    write(d, "c.txt");
    gitOut(d, "add", "c.txt");
    gitOut(d, "commit", "-q", "-m", "c");
    gitOut(d, "push", "-q", "-u", "origin", "dev/foo");
    // 索引側（X=R）の改名に、作業ツリーの変更が重なる（RM）
    gitOut(d, "mv", "c.txt", "e.txt");
    write(d, "e.txt", "changed\n");
    eq("work-remainder/16.1 索引側の改名（X=R、RM）でも、元のパスを別の変更として数えない", summary(remaindersOf(d)), [
      { branch: "dev/foo", dirty: ["e.txt"], dirtyCount: 1, unpushed: 0, secretLike: [] },
    ]);
  } finally {
    rn2.cleanup();
  }
};
