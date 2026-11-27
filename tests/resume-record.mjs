// 再開の記録の書き読み（writeRecord・readRecords・resumableFor・attachSession）の単体試験（brw-pr-handoff 9.2）。selftest.mjs から呼ばれる。
// 一時リポジトリ・bare remote・worktree を実際の git で作る。HOME と Git の全域設定は隔離し、終わったら元に戻す。
// 記録は本体の <git 共通ディレクトリ>/brw/resume.json に置かれる。作業の記録（brw/work）には触れないことも確かめる。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitOut, mkRepoWithRemote, mkWorktree } from "./support/git-fixture.mjs";

// 読み込めないときは各関数を失敗として扱い、試験の項目が RED として記録されるようにする
const mod = await import("../scripts/resume-record.mjs").catch(() => ({}));
const NOT_IMPL = { ok: false, message: "未実装" };
const writeRecord = (...a) => (mod.writeRecord ? mod.writeRecord(...a) : NOT_IMPL);
const readRecords = (...a) => (mod.readRecords ? mod.readRecords(...a) : []);
const resumableFor = (...a) => (mod.resumableFor ? mod.resumableFor(...a) : null);
const attachSession = (...a) => (mod.attachSession ? mod.attachSession(...a) : NOT_IMPL);
const writeHint = (...a) => (mod.writeSessionHint ? mod.writeSessionHint(...a) : NOT_IMPL);
const readHint = (...a) => (mod.readSessionHint ? mod.readSessionHint(...a) : null);

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// 試験の現在時刻を固定する（すべての時刻はここからの差で作る）
const NOW = new Date("2026-11-27T12:00:00Z");

// 宣言（作業ブランチは dev/*、保護は main、分岐元は develop）
const CONFIG = { workBranches: ["dev/*"], protectedBranches: ["main"], baseBranch: "develop" };
// 保護ブランチに rel/* を含み、rel/* も作業ブランチとして宣言する（保護が優先されることの確認用）
const CONFIG_PROTECTED = { workBranches: ["dev/*", "rel/*"], protectedBranches: ["main", "rel/*"], baseBranch: "develop" };

// 試験用の Git 設定の引数は fixture 側で渡す。環境変数は次の値に隔離する
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

// 一時リポジトリ（本体）を作って fn に渡す。config を null にすると宣言を置かない
const inRepo = (fn, { config = CONFIG } = {}) => {
  const home = mkdtempSync(join(tmpdir(), "brw-resume-home-"));
  const r = mkRepoWithRemote({ branch: "main", config });
  try {
    return withIsolatedEnv(home, () => fn(r.dir));
  } finally {
    r.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
};

// 記録の 1 件（ago は現在から何ミリ秒前か。負なら未来）
const entryOf = (branch, { ago = MIN, sessionId = null, prUrl = null, repository = null, base = null } = {}) => ({
  branch,
  prUrl,
  repository,
  sessionId,
  base,
  at: new Date(NOW.getTime() - ago).toISOString(),
});

const fileOf = (dir) => join(dir, ".git", "brw", "resume.json");
const readOrNull = (path) => (existsSync(path) ? readFileSync(path, "utf8") : null);
// 無ければ null（未実装のときも試験を続けて記録するため、存在しないファイルを例外にしない）
const modeOf = (path) => (existsSync(path) ? statSync(path).mode & 0o777 : null);
const listOf = (path) => (existsSync(path) ? readdirSync(path).sort() : null);
// 記録の内容を直接書く（破損・形違いの試験用）
const writeRaw = (dir, text) => {
  mkdirSync(join(dir, ".git", "brw"), { recursive: true });
  writeFileSync(fileOf(dir), text);
};
// 作業ブランチの状態を作る。worktree なら作業場所も作り、tracking なら追跡ブランチを作る。記録があれば書く
const prepare = (dir, branch, { worktree = false, tracking = true, record = null } = {}) => {
  let wt = null;
  if (branch !== "main") {
    if (worktree) wt = mkWorktree(dir, branch);
    else gitOut(dir, "branch", branch);
  }
  if (tracking) gitOut(dir, "update-ref", `refs/remotes/origin/${branch}`, gitOut(dir, "rev-parse", "HEAD"));
  // 書けなかった場合は見つけない側の結果になり、その項目が失敗として記録される
  if (record) writeRecord(dir, record);
  return wt;
};
// 副作用の確認用: 記録の内容・ref・worktree の一覧・FETCH_HEAD の有無
const snapshot = (dir) => ({
  file: readOrNull(fileOf(dir)),
  refs: gitOut(dir, "for-each-ref", "--format=%(refname) %(objectname)"),
  worktrees: gitOut(dir, "worktree", "list", "--porcelain"),
  fetchHead: existsSync(join(dir, ".git", "FETCH_HEAD")),
});
// 戻り値の branch だけを比べやすくする（見つからない場合は null）
const branchOf = (r) => (r ? r.branch : null);
// Git の外のディレクトリ（一時ディレクトリは Git の外）
const nonGitDir = () => mkdtempSync(join(tmpdir(), "brw-resume-nongit-"));

export const runResumeRecordChecks = async (eq) => {
  // ---- writeRecord: 書き込みの往復・上限・置き換え・先頭が最新 ----

  inRepo((dir) => {
    eq("brw-pr-handoff/9.2 writeRecord は成功すると ok:true を返す", writeRecord(dir, entryOf("dev/a")), { ok: true });
    eq("brw-pr-handoff/9.2 書いた記録を readRecords で同じ形に読める", readRecords(dir), [entryOf("dev/a")]);
    eq("brw-pr-handoff/9.2 記録ファイルのパーミッションは 0600", modeOf(fileOf(dir)), 0o600);
    eq("brw-pr-handoff/9.2 書き込み後にロックや一時ファイルが残らない", listOf(join(dir, ".git", "brw")), ["resume.json"]);
    eq("brw-pr-handoff/9.2 記録の書き込みで作業ツリーも作業の記録（brw/work）も変わらない", [gitOut(dir, "status", "--porcelain"), existsSync(join(dir, ".git", "brw", "work"))], ["", false]);
  });

  inRepo((dir) => {
    for (let i = 0; i < 12; i++) writeRecord(dir, entryOf(`dev/b${i}`));
    const list = readRecords(dir);
    eq("brw-pr-handoff/9.2 記録は最大 10 件", list.length, 10);
    eq("brw-pr-handoff/9.2 先頭が最後に書いた最新の記録", list[0]?.branch, "dev/b11");
    eq("brw-pr-handoff/9.2 上限を超えた古い記録から捨てる（最も古い残りは dev/b2）", list[9]?.branch, "dev/b2");
  });

  inRepo((dir) => {
    writeRecord(dir, entryOf("dev/a", { prUrl: "https://example.invalid/pull/1" }));
    writeRecord(dir, entryOf("dev/b"));
    writeRecord(dir, entryOf("dev/a", { ago: 0, prUrl: "https://example.invalid/pull/2" }));
    const list = readRecords(dir);
    eq("brw-pr-handoff/9.2 同じ branch は置き換え、件数は増えない", list.length, 2);
    eq("brw-pr-handoff/9.2 置き換えた記録は先頭へ来て、内容は新しい方になる", [list[0]?.branch, list[0]?.prUrl], ["dev/a", "https://example.invalid/pull/2"]);
    eq("brw-pr-handoff/9.2 置き換えで残った他の branch は後ろに残る", list[1]?.branch, "dev/b");
  });

  inRepo((dir) => {
    const bad = [
      null,
      "dev/a",
      { ...entryOf("dev/a"), branch: "" },
      { ...entryOf("dev/a"), branch: 5 },
      { ...entryOf("dev/a"), branch: "-x" },
      { ...entryOf("dev/a"), branch: "dev/a..b" },
      { ...entryOf("dev/a"), branch: "dev/ a" },
      { ...entryOf("dev/a"), branch: "dev/a\u0001" },
      { ...entryOf("dev/a"), branch: "dev/a.lock" },
      { ...entryOf("dev/a"), branch: "dev/" },
      { ...entryOf("dev/a"), at: "yesterday" },
      { ...entryOf("dev/a"), at: 12345 },
      { ...entryOf("dev/a"), prUrl: 5 },
      { ...entryOf("dev/a"), repository: {} },
      { ...entryOf("dev/a"), sessionId: 3 },
    ];
    eq("brw-pr-handoff/9.2 不正な入力は例外を投げず ok:false（message つき）を返す", bad.map((e) => {
      const r = writeRecord(dir, e);
      return r && r.ok === false && typeof r.message === "string";
    }), bad.map(() => true));
    eq("brw-pr-handoff/9.2 不正な入力では記録ファイルを作らない", existsSync(fileOf(dir)), false);
  });

  inRepo((dir) => {
    writeRecord(dir, entryOf("dev/keep"));
    const before = readOrNull(fileOf(dir));
    writeRecord(dir, { ...entryOf("dev/bad"), sessionId: 3 });
    eq("brw-pr-handoff/9.2 不正な入力で既存の記録を変えない", readOrNull(fileOf(dir)), before);
  });

  eq("brw-pr-handoff/9.2 Git の外でも writeRecord は例外を投げず ok:false", (() => {
    const d = nonGitDir();
    try {
      const r = writeRecord(d, entryOf("dev/a"));
      return r && r.ok === false;
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  })(), true);

  inRepo((dir) => {
    // ロックを他の処理が保持している状態を作る（自分の pid で、古くない）
    mkdirSync(join(dir, ".git", "brw"), { recursive: true });
    writeFileSync(`${fileOf(dir)}.lock`, String(process.pid));
    const r = writeRecord(dir, entryOf("dev/a"), { lockWaitMs: 30 });
    eq("brw-pr-handoff/9.2 ロックが取れないときは ok:false（待ってから失敗）", r && r.ok === false, true);
    eq("brw-pr-handoff/9.2 ロックが取れなかった書き込みは記録を作らない", existsSync(fileOf(dir)), false);
    rmSync(`${fileOf(dir)}.lock`, { force: true });
    eq("brw-pr-handoff/9.2 ロックを外せば同じ書き込みが成功する（ロックが原因だったことの確認）", writeRecord(dir, entryOf("dev/a")), { ok: true });
  });

  // ---- readRecords: 読めない・形が不正・version 違いは空配列 ----

  inRepo((dir) => {
    eq("brw-pr-handoff/9.2 記録ファイルが無いときは空配列", readRecords(dir), []);
    writeRaw(dir, "{broken");
    eq("brw-pr-handoff/9.2 壊れた JSON は空配列", readRecords(dir), []);
    writeRaw(dir, JSON.stringify([entryOf("dev/a")]));
    eq("brw-pr-handoff/9.2 配列の最上位は形が不正なので空配列", readRecords(dir), []);
    writeRaw(dir, JSON.stringify({ version: 1, entries: "x" }));
    eq("brw-pr-handoff/9.2 entries が配列でなければ空配列", readRecords(dir), []);
    writeRaw(dir, JSON.stringify({ version: 1 }));
    eq("brw-pr-handoff/9.2 entries が無ければ空配列", readRecords(dir), []);
    writeRaw(dir, JSON.stringify({ version: 2, entries: [entryOf("dev/a")] }));
    eq("brw-pr-handoff/9.2 version が 1 以外なら空配列", readRecords(dir), []);
    writeRaw(dir, JSON.stringify({ version: 1, entries: [entryOf("dev/a"), { branch: "-x" }, null, "x", { ...entryOf("dev/c"), at: "nope" }, entryOf("dev/d")] }));
    eq("brw-pr-handoff/9.2 個々の形が不正な記録だけ捨て、正しいものは残す", readRecords(dir).map((e) => e.branch), ["dev/a", "dev/d"]);
  });

  // ---- resumableFor: 見つかる場合と、見つからない各場合 ----

  inRepo((dir) => {
    prepare(dir, "dev/foo", { record: entryOf("dev/foo", { ago: HOUR, sessionId: "s1" }) });
    const before = snapshot(dir);
    eq("brw-pr-handoff/9.2 resumableFor は同じセッション・24 時間以内・作業場所なし・追跡あり・開発ブランチを見つける", branchOf(resumableFor(dir, "s1", NOW)), "dev/foo");
    eq("brw-pr-handoff/9.2 resumableFor は副作用を持たない（記録・ref・worktree・FETCH_HEAD が変わらない）", snapshot(dir), before);
    eq("brw-pr-handoff/9.2 見つかった記録は書いた内容そのもの", resumableFor(dir, "s1", NOW), entryOf("dev/foo", { ago: HOUR, sessionId: "s1" }));
  });

  inRepo((dir) => {
    prepare(dir, "dev/foo", { record: entryOf("dev/foo", { ago: HOUR, sessionId: "s1" }) });
    const other = mkWorktree(dir, "dev/other");
    eq("brw-pr-handoff/9.2 作業場所（別の worktree）から呼んでも本体の記録を見つける", branchOf(resumableFor(other, "s1", NOW)), "dev/foo");
  });

  inRepo((dir) => {
    prepare(dir, "dev/foo", { record: entryOf("dev/foo", { ago: HOUR, sessionId: "s1" }) });
    eq("brw-pr-handoff/9.2 別のセッションの記録は見つけない", resumableFor(dir, "s2", NOW), null);
  });

  inRepo((dir) => {
    prepare(dir, "dev/foo", { record: entryOf("dev/foo", { ago: HOUR, sessionId: null }) });
    eq("brw-pr-handoff/9.2 sessionId が null の記録は、どのセッションにも見つけない", resumableFor(dir, "s1", NOW), null);
  });

  inRepo((dir) => {
    prepare(dir, "dev/foo", { record: entryOf("dev/foo", { ago: HOUR, sessionId: "s1" }) });
    eq("brw-pr-handoff/9.2 呼び出し側の sessionId が null なら見つけない", resumableFor(dir, null, NOW), null);
    eq("brw-pr-handoff/9.2 呼び出し側の sessionId が空文字なら見つけない", resumableFor(dir, "", NOW), null);
  });

  inRepo((dir) => {
    prepare(dir, "dev/foo", { record: entryOf("dev/foo", { ago: 23 * HOUR + 59 * MIN, sessionId: "s1" }) });
    eq("brw-pr-handoff/9.2 24 時間以内（23 時間 59 分前）は見つける", branchOf(resumableFor(dir, "s1", NOW)), "dev/foo");
  });

  inRepo((dir) => {
    prepare(dir, "dev/foo", { record: entryOf("dev/foo", { ago: DAY + MIN, sessionId: "s1" }) });
    eq("brw-pr-handoff/9.2 24 時間を超えた古い記録は見つけない", resumableFor(dir, "s1", NOW), null);
  });

  inRepo((dir) => {
    prepare(dir, "dev/foo", { record: entryOf("dev/foo", { ago: -MIN, sessionId: "s1" }) });
    eq("brw-pr-handoff/9.2 未来の時刻の記録は見つけない", resumableFor(dir, "s1", NOW), null);
  });

  inRepo((dir) => {
    prepare(dir, "dev/foo", { worktree: true, record: entryOf("dev/foo", { ago: HOUR, sessionId: "s1" }) });
    eq("brw-pr-handoff/9.2 作業場所がある作業ブランチは見つけない", resumableFor(dir, "s1", NOW), null);
  });

  inRepo((dir) => {
    prepare(dir, "dev/foo", { tracking: false, record: entryOf("dev/foo", { ago: HOUR, sessionId: "s1" }) });
    eq("brw-pr-handoff/9.2 追跡ブランチ（refs/remotes）が無ければ見つけない", resumableFor(dir, "s1", NOW), null);
  });

  inRepo((dir) => {
    prepare(dir, "dev/foo", { record: entryOf("dev/foo", { ago: HOUR, sessionId: "s1" }) });
    eq("brw-pr-handoff/9.2 宣言が無ければ見つけない", resumableFor(dir, "s1", NOW), null);
  }, { config: null });

  inRepo((dir) => {
    prepare(dir, "dev/foo", { record: entryOf("dev/foo", { ago: HOUR, sessionId: "s1" }) });
    writeFileSync(join(dir, ".branch-release-workflow.json"), "{broken");
    eq("brw-pr-handoff/9.2 宣言が不正（JSON が壊れている）なら見つけない", resumableFor(dir, "s1", NOW), null);
  });

  inRepo((dir) => {
    prepare(dir, "rel/1", { record: entryOf("rel/1", { ago: HOUR, sessionId: "s1" }) });
    eq("brw-pr-handoff/9.2 保護ブランチは見つけない", resumableFor(dir, "s1", NOW), null);
  }, { config: CONFIG_PROTECTED });

  inRepo((dir) => {
    prepare(dir, "develop", { record: entryOf("develop", { ago: HOUR, sessionId: "s1" }) });
    eq("brw-pr-handoff/9.2 分岐元（develop）は見つけない", resumableFor(dir, "s1", NOW), null);
  });

  inRepo((dir) => {
    prepare(dir, "feature/x", { record: entryOf("feature/x", { ago: HOUR, sessionId: "s1" }) });
    eq("brw-pr-handoff/9.2 宣言の外のブランチは見つけない", resumableFor(dir, "s1", NOW), null);
  });

  inRepo((dir) => {
    prepare(dir, "main", { record: entryOf("main", { ago: HOUR, sessionId: "s1" }) });
    eq("brw-pr-handoff/9.2 保護ブランチ（main）の記録は見つけない", resumableFor(dir, "s1", NOW), null);
  });

  inRepo((dir) => {
    prepare(dir, "dev/a", { record: entryOf("dev/a", { ago: HOUR, sessionId: "s2" }) });
    prepare(dir, "dev/b", { record: entryOf("dev/b", { ago: 2 * HOUR, sessionId: "s1" }) });
    eq("brw-pr-handoff/9.2 先頭が別のセッションでも、同じセッションの次の記録を見つける", branchOf(resumableFor(dir, "s1", NOW)), "dev/b");
  });

  inRepo((dir) => {
    // 先に古い記録（dev/b）を書き、後から新しい記録（dev/a）を書いて先頭にする（先頭と時刻の新しさを一致させる）
    prepare(dir, "dev/b", { record: entryOf("dev/b", { ago: 2 * HOUR, sessionId: "s1" }) });
    prepare(dir, "dev/a", { record: entryOf("dev/a", { ago: HOUR, sessionId: "s1" }) });
    eq("brw-pr-handoff/9.2 条件を満たす記録が複数あるときは最新（先頭）の 1 件", branchOf(resumableFor(dir, "s1", NOW)), "dev/a");
  });

  inRepo((dir) => {
    writeRaw(dir, "{broken");
    eq("brw-pr-handoff/9.2 記録が壊れていれば見つけない（例外を投げない）", resumableFor(dir, "s1", NOW), null);
  });

  eq("brw-pr-handoff/9.2 Git の外から呼んでも null（例外を投げない）", (() => {
    const d = nonGitDir();
    try {
      return resumableFor(d, "s1", NOW);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  })(), null);

  // ---- attachSession: 直近 2 分以内・sessionId が null の記録のうち最新の 1 件だけ ----

  inRepo((dir) => {
    writeRecord(dir, entryOf("dev/old", { ago: 5 * MIN, sessionId: "sx" }));
    writeRecord(dir, entryOf("dev/a", { ago: 30 * 1000 }));
    eq("brw-pr-handoff/9.2 attachSession は 2 分以内の sessionId が null の最新の 1 件に付け、attached:true を返す", attachSession(dir, "s1", NOW), { ok: true, attached: true });
    const list = readRecords(dir);
    eq("brw-pr-handoff/9.2 付けた記録だけが変わり、ほかの記録（sessionId 付きの古い記録）は変わらない", list.map((e) => [e.branch, e.sessionId]), [["dev/a", "s1"], ["dev/old", "sx"]]);
    eq("brw-pr-handoff/9.2 付けた記録の他の項目（時刻・ブランチ）は変わらない", list[0], { ...entryOf("dev/a", { ago: 30 * 1000 }), sessionId: "s1" });
  });

  // ---- attachSession の branch 指定: そのブランチの記録だけを対象にする（9.4）。指定なしの動作は上の試験のまま ----
  inRepo((dir) => {
    writeRecord(dir, entryOf("dev/b", { ago: 10 * 1000 }));
    writeRecord(dir, entryOf("dev/a", { ago: 60 * 1000 }));
    eq("brw-pr-handoff/9.4 branch を指定すると、新しい別ブランチの記録ではなく、そのブランチの記録に付ける", [attachSession(dir, "s1", NOW, { branch: "dev/a" }), readRecords(dir).map((e) => [e.branch, e.sessionId])], [{ ok: true, attached: true }, [["dev/a", "s1"], ["dev/b", null]]]);
  });
  inRepo((dir) => {
    writeRecord(dir, entryOf("dev/b", { ago: 10 * 1000 }));
    const before = readOrNull(fileOf(dir));
    eq("brw-pr-handoff/9.4 branch に対応する記録が無ければ、別ブランチの新しい記録には付けず attached:false", attachSession(dir, "s1", NOW, { branch: "dev/zz" }), { ok: true, attached: false });
    eq("brw-pr-handoff/9.4 branch 指定で対象が無いときは記録の内容を変えない", readOrNull(fileOf(dir)), before);
  });
  inRepo((dir) => {
    writeRecord(dir, entryOf("dev/a", { ago: 3 * MIN }));
    eq("brw-pr-handoff/9.4 branch 指定でも 2 分を超えた記録には付けない", attachSession(dir, "s1", NOW, { branch: "dev/a" }), { ok: true, attached: false });
  });
  inRepo((dir) => {
    writeRecord(dir, entryOf("dev/a", { ago: 10 * 1000, sessionId: "sx" }));
    eq("brw-pr-handoff/9.4 branch 指定でも sessionId が既にある記録は対象外", attachSession(dir, "s1", NOW, { branch: "dev/a" }), { ok: true, attached: false });
  });

  inRepo((dir) => {
    writeRecord(dir, entryOf("dev/a", { ago: 3 * MIN }));
    const before = readOrNull(fileOf(dir));
    eq("brw-pr-handoff/9.2 2 分を超えた記録には付けず、attached:false（書かない）", attachSession(dir, "s1", NOW), { ok: true, attached: false });
    eq("brw-pr-handoff/9.2 対象が無いときは記録の内容を変えない", readOrNull(fileOf(dir)), before);
  });

  inRepo((dir) => {
    writeRecord(dir, entryOf("dev/a", { ago: 2 * MIN }));
    eq("brw-pr-handoff/9.2 ちょうど 2 分前の記録は対象（2 分以内）", attachSession(dir, "s1", NOW), { ok: true, attached: true });
  });

  inRepo((dir) => {
    writeRecord(dir, entryOf("dev/a", { ago: MIN, sessionId: "sx" }));
    const before = readOrNull(fileOf(dir));
    eq("brw-pr-handoff/9.2 sessionId が既にある記録は対象外（attached:false）", attachSession(dir, "s1", NOW), { ok: true, attached: false });
    eq("brw-pr-handoff/9.2 sessionId が既にある記録は変えない", readOrNull(fileOf(dir)), before);
  });

  inRepo((dir) => {
    writeRecord(dir, entryOf("dev/old", { ago: 50 * 1000 }));
    writeRecord(dir, entryOf("dev/new", { ago: 10 * 1000 }));
    eq("brw-pr-handoff/9.2 対象が複数あれば最新（先頭）の 1 件だけに付ける", attachSession(dir, "s1", NOW), { ok: true, attached: true });
    eq("brw-pr-handoff/9.2 最新の 1 件だけに付き、ほかの対象は null のまま", readRecords(dir).map((e) => [e.branch, e.sessionId]), [["dev/new", "s1"], ["dev/old", null]]);
  });

  inRepo((dir) => {
    writeRecord(dir, entryOf("dev/old", { ago: 50 * 1000 }));
    writeRecord(dir, entryOf("dev/new", { ago: 10 * 1000, sessionId: "sx" }));
    eq("brw-pr-handoff/9.2 先頭が sessionId 付きなら、その次の空の記録に付ける", attachSession(dir, "s1", NOW), { ok: true, attached: true });
    eq("brw-pr-handoff/9.2 sessionId 付きの先頭は変えず、空の記録に付く", readRecords(dir).map((e) => [e.branch, e.sessionId]), [["dev/new", "sx"], ["dev/old", "s1"]]);
  });

  inRepo((dir) => {
    writeRecord(dir, entryOf("dev/a", { ago: -MIN }));
    eq("brw-pr-handoff/9.2 未来の時刻の記録には付けない", attachSession(dir, "s1", NOW), { ok: true, attached: false });
  });

  inRepo((dir) => {
    eq("brw-pr-handoff/9.2 記録が無ければ何も作らず attached:false", attachSession(dir, "s1", NOW), { ok: true, attached: false });
    eq("brw-pr-handoff/9.2 記録が無いときは記録ファイルを作らない", existsSync(fileOf(dir)), false);
  });

  inRepo((dir) => {
    writeRecord(dir, entryOf("dev/a", { ago: 10 * 1000 }));
    const before = readOrNull(fileOf(dir));
    eq("brw-pr-handoff/9.2 sessionId が空文字なら ok:false", attachSession(dir, "", NOW).ok, false);
    eq("brw-pr-handoff/9.2 sessionId が null なら ok:false", attachSession(dir, null, NOW).ok, false);
    eq("brw-pr-handoff/9.2 sessionId が文字列でなければ ok:false", attachSession(dir, 7, NOW).ok, false);
    eq("brw-pr-handoff/9.2 不正な sessionId では記録を変えない", readOrNull(fileOf(dir)), before);
  });

  inRepo((dir) => {
    writeRecord(dir, entryOf("dev/a", { ago: 10 * 1000 }));
    mkdirSync(join(dir, ".git", "brw"), { recursive: true });
    writeFileSync(`${fileOf(dir)}.lock`, String(process.pid));
    const before = readOrNull(fileOf(dir));
    const r = attachSession(dir, "s1", NOW, { lockWaitMs: 30 });
    eq("brw-pr-handoff/9.2 ロックが取れないときは ok:false", r && r.ok === false, true);
    eq("brw-pr-handoff/9.2 ロックが取れないときは記録を変えない", readOrNull(fileOf(dir)), before);
    rmSync(`${fileOf(dir)}.lock`, { force: true });
  });

  inRepo((dir) => {
    writeRaw(dir, "{broken");
    eq("brw-pr-handoff/9.2 記録が壊れていれば対象が無いので attached:false（壊れた内容は変えない）", attachSession(dir, "s1", NOW), { ok: true, attached: false });
    eq("brw-pr-handoff/9.2 壊れた記録ファイルには触れない", readOrNull(fileOf(dir)), "{broken");
  });

  eq("brw-pr-handoff/9.2 Git の外では attachSession は ok:false（例外を投げない）", (() => {
    const d = nonGitDir();
    try {
      const r = attachSession(d, "s1", NOW);
      return r && r.ok === false;
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  })(), true);
};

// ---- 記録の厳密な検証（レビュー指摘への対応。案内文に入る内容を信頼できない入力として扱う） ----
export const runResumeRecordStrictChecks = async (eq) => {
  const ok = (r) => r && r.ok === true;
  const bad = (r) => r && r.ok === false;

  // sessionId: 空・空白だけは null に正規化する（空でない文字列だけが sessionId）
  inRepo((dir) => {
    eq("brw-pr-handoff/9.2 sessionId が空文字の記録は null として保存される", ok(writeRecord(dir, entryOf("dev/a", { sessionId: "" }))) && readRecords(dir)[0]?.sessionId, null);
    eq("brw-pr-handoff/9.2 sessionId が空白だけの記録も null として保存される", ok(writeRecord(dir, entryOf("dev/b", { sessionId: "   " }))) && readRecords(dir)[0]?.sessionId, null);
  });
  inRepo((dir) => {
    writeRaw(dir, JSON.stringify({ version: 1, entries: [{ ...entryOf("dev/a"), sessionId: "" }] }));
    eq("brw-pr-handoff/9.2 既存の sessionId が空文字の記録は読むときに null になり、attachSession の対象になる", attachSession(dir, "s1", NOW), { ok: true, attached: true });
    eq("brw-pr-handoff/9.2 空の sessionId に付けた結果は s1 になる", readRecords(dir)[0]?.sessionId, "s1");
  });

  // 文字列の検証: 書き込みは不正な値を拒否し、何も書かない
  const badValues = [
    ["prUrl が http", { prUrl: "http://example.invalid/pull/1" }],
    ["prUrl が空白を含む", { prUrl: "https://example.invalid/pull/1 x" }],
    ["prUrl がバッククォートを含む", { prUrl: "https://example.invalid/`x`" }],
    ["prUrl が改行を含む", { prUrl: "https://example.invalid/pull/1\n" }],
    ["prUrl が URL でない", { prUrl: "not a url" }],
    ["prUrl が javascript:", { prUrl: "javascript:alert(1)" }],
    ["prUrl に資格情報がある", { prUrl: "https://u:p@example.invalid/pull/1" }],
    ["prUrl が 2048 文字を超える", { prUrl: `https://example.invalid/${"a".repeat(2048)}` }],
    ["prUrl が空文字", { prUrl: "" }],
    ["repository が 1 要素", { repository: "abc" }],
    ["repository が 3 要素", { repository: "a/b/c" }],
    ["repository に空白", { repository: "a b/c" }],
    ["repository にバッククォート", { repository: "a/b`" }],
    ["repository が 200 文字を超える", { repository: `${"x".repeat(200)}/y` }],
    ["sessionId に空白", { sessionId: "s 1" }],
    ["sessionId に制御文字", { sessionId: "s\u0001" }],
    ["sessionId に書式文字（RLO）", { sessionId: "s\u202e" }],
    ["sessionId が 200 文字を超える", { sessionId: "x".repeat(201) }],
    ["branch が 255 文字を超える", { branch: `dev/${"a".repeat(252)}` }],
    ["branch に書式文字（RLO）", { branch: "dev/\u202ea" }],
    ["branch に行区切り", { branch: "dev/a\u2028b" }],
    ["branch に $( ）（コマンド置換）", { branch: "dev/$(id)" }],
    ["branch にバッククォート", { branch: "dev/`id`" }],
    ["branch に ;", { branch: "dev/a;b" }],
    ["branch に &", { branch: "dev/a&b" }],
    ["branch に |", { branch: "dev/a|b" }],
    ["branch に空白", { branch: "dev/a b" }],
    ["branch に一重引用符", { branch: "dev/a'b" }],
    ["branch に二重引用符", { branch: 'dev/a"b' }],
    ["branch に <", { branch: "dev/a<b" }],
    ["branch に >", { branch: "dev/a>b" }],
    ["branch に *", { branch: "dev/a*b" }],
    ["branch に ?", { branch: "dev/a?b" }],
    ["branch に !", { branch: "dev/a!b" }],
    ["branch に #", { branch: "dev/a#b" }],
    ["branch に \\", { branch: "dev/a\\b" }],
    ["branch に { }", { branch: "dev/a{b}" }],
    ["branch に [ ]", { branch: "dev/a[b]" }],
    ["branch に ~", { branch: "dev/a~b" }],
    ["branch に ^", { branch: "dev/a^b" }],
    ["branch に :", { branch: "dev/a:b" }],
    ["branch に $", { branch: "dev/a$b" }],
    ["branch の先頭が -", { branch: "-dev/a" }],
    ["branch の先頭が .", { branch: ".dev/a" }],
  ];
  for (const [label, over] of badValues) {
    inRepo((dir) => {
      const r = writeRecord(dir, { ...entryOf("dev/ok"), ...over });
      eq(`brw-pr-handoff/9.2 書き込みで不正な値（${label}）は ok:false・何も書かない`, [bad(r), existsSync(fileOf(dir))], [true, false]);
    });
  }

  // 読み込み: 不正な項目の記録は捨て、正しいものだけ残す（readRecords・resumableFor・attachSession）
  inRepo((dir) => {
    const valid = entryOf("dev/good", { sessionId: "s1", ago: HOUR });
    writeRaw(dir, JSON.stringify({ version: 1, entries: [
      { ...entryOf("dev/bad1"), prUrl: "http://example.invalid/x" },
      { ...entryOf("dev/bad2"), repository: "a b/c" },
      { ...entryOf("dev/bad3"), sessionId: "s\u202e" },
      { ...entryOf("dev/bad4"), at: "2026-02-30T00:00:00Z" },
      { ...entryOf("dev/bad5"), branch: "dev/\u200bx" },
      valid,
    ] }));
    eq("brw-pr-handoff/9.2 読み込みで不正な項目の記録は捨て、正しい記録だけ残す", readRecords(dir), [valid]);
  });
  inRepo((dir) => {
    prepare(dir, "dev/good", {});
    prepare(dir, "dev/bad", {});
    writeRaw(dir, JSON.stringify({ version: 1, entries: [
      { ...entryOf("dev/bad", { sessionId: "s1", ago: HOUR }), prUrl: "http://example.invalid/x" },
      entryOf("dev/good", { sessionId: "s1", ago: 2 * HOUR }),
    ] }));
    eq("brw-pr-handoff/9.2 resumableFor は不正な先頭の記録を飛ばして正しい記録を見つける", branchOf(resumableFor(dir, "s1", NOW)), "dev/good");
  });
  inRepo((dir) => {
    writeRaw(dir, JSON.stringify({ version: 1, entries: [
      { ...entryOf("dev/bad", { ago: 10 * 1000 }), prUrl: "http://example.invalid/x" },
    ] }));
    const before = readOrNull(fileOf(dir));
    eq("brw-pr-handoff/9.2 attachSession は不正な記録を対象にしない（attached:false・書かない）", attachSession(dir, "s1", NOW), { ok: true, attached: false });
    eq("brw-pr-handoff/9.2 不正な記録だけのときは記録を変えない", readOrNull(fileOf(dir)), before);
  });
  inRepo((dir) => {
    writeRaw(dir, JSON.stringify({ version: 1, entries: [
      { ...entryOf("dev/bad", { ago: 5 * 1000 }), repository: "a b/c" },
      entryOf("dev/good", { ago: 10 * 1000 }),
    ] }));
    eq("brw-pr-handoff/9.2 attachSession は正しい記録に付け、不正な記録は書き戻さない", [attachSession(dir, "s1", NOW), readRecords(dir).map((e) => e.branch)], [{ ok: true, attached: true }, ["dev/good"]]);
    eq("brw-pr-handoff/9.2 書き戻した記録ファイルに不正な項目が残らない", JSON.parse(readOrNull(fileOf(dir))).entries.map((e) => e.branch), ["dev/good"]);
  });

  // 時刻: UTC の ISO 形式のみ。暦日として補正されるものは拒否する
  const goodAt = ["2028-02-29T00:00:00Z", "2026-11-27T12:00:00Z", "2026-11-27T12:00:00.5Z", "2026-11-27T12:00:00.123Z"];
  const badAt = ["2026-02-29T00:00:00Z", "2026-04-31T00:00:00Z", "2026-11-27T25:00:00Z", "2026-11-27T12:60:00Z", "2026-11-27T12:00:60Z", "2026-11-27T24:00:00Z", "2026-11-27T12:00:00+09:00", "2026-11-27T12:00:00.1234Z", "2026-11-27 12:00:00Z", "2026-11-27T12:00Z"];
  inRepo((dir) => {
    eq("brw-pr-handoff/9.2 有効な UTC の時刻（うるう日 2028-02-29・ミリ秒 0〜3 桁）は書ける", goodAt.map((at) => ok(writeRecord(dir, { ...entryOf("dev/a"), at }))), goodAt.map(() => true));
  });
  inRepo((dir) => {
    eq("brw-pr-handoff/9.2 暦日が補正される・範囲外・オフセット表記の時刻は書き込みで拒否する", badAt.map((at) => bad(writeRecord(dir, { ...entryOf("dev/a"), at }))), badAt.map(() => true));
    eq("brw-pr-handoff/9.2 拒否された時刻では記録ファイルを作らない", existsSync(fileOf(dir)), false);
  });
  inRepo((dir) => {
    writeRaw(dir, JSON.stringify({ version: 1, entries: badAt.map((at) => ({ ...entryOf("dev/a"), at })) }));
    eq("brw-pr-handoff/9.2 読み込みでも補正される時刻の記録は捨てる", readRecords(dir), []);
  });
  inRepo((dir) => {
    eq("brw-pr-handoff/9.2 ちょうど 24 時間前の記録は見つける（境界）", branchOf(prepareAndFind(dir, DAY)), "dev/foo");
  });
  inRepo((dir) => {
    eq("brw-pr-handoff/9.2 24 時間と 1 ミリ秒前の記録は見つけない（境界）", branchOf(prepareAndFind(dir, DAY + 1)), null);
  });
  inRepo((dir) => {
    writeRecord(dir, entryOf("dev/a", { ago: 2 * MIN }));
    eq("brw-pr-handoff/9.2 ちょうど 2 分前は attachSession の対象（境界）", attachSession(dir, "s1", NOW), { ok: true, attached: true });
  });
  inRepo((dir) => {
    writeRecord(dir, entryOf("dev/a", { ago: 2 * MIN + 1 }));
    eq("brw-pr-handoff/9.2 2 分と 1 ミリ秒前は attachSession の対象外（境界）", attachSession(dir, "s1", NOW), { ok: true, attached: false });
  });

  // ファイルの扱い: シンボリックリンク・ディレクトリ・巨大なファイルは読まず、書かない
  inRepo((dir) => {
    const outside = mkdtempSync(join(tmpdir(), "brw-resume-outside-"));
    try {
      mkdirSync(join(dir, ".git"), { recursive: true });
      symlinkSync(outside, join(dir, ".git", "brw"));
      eq("brw-pr-handoff/9.2 brw がシンボリックリンクなら書かない（ok:false）", bad(writeRecord(dir, entryOf("dev/a"))), true);
      eq("brw-pr-handoff/9.2 brw がシンボリックリンクなら共通ディレクトリの外へ書かない", readdirSync(outside), []);
      eq("brw-pr-handoff/9.2 brw がシンボリックリンクなら読まない（空配列）", readRecords(dir), []);
      eq("brw-pr-handoff/9.2 brw がシンボリックリンクなら attachSession も書かない（ok:false）", bad(attachSession(dir, "s1", NOW)), true);
      eq("brw-pr-handoff/9.2 brw がシンボリックリンクでも外の場所は変わらない", readdirSync(outside), []);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
  inRepo((dir) => {
    const outside = mkdtempSync(join(tmpdir(), "brw-resume-outside-"));
    const target = join(outside, "target.json");
    try {
      mkdirSync(join(dir, ".git", "brw"), { recursive: true });
      writeFileSync(target, "keep");
      symlinkSync(target, fileOf(dir));
      eq("brw-pr-handoff/9.2 resume.json がシンボリックリンクなら読まない（空配列）", readRecords(dir), []);
      eq("brw-pr-handoff/9.2 resume.json がシンボリックリンクなら書かない（ok:false）", bad(writeRecord(dir, entryOf("dev/a"))), true);
      eq("brw-pr-handoff/9.2 resume.json がシンボリックリンクでもリンク先の内容は変わらない", readFileSync(target, "utf8"), "keep");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
  inRepo((dir) => {
    const outside = mkdtempSync(join(tmpdir(), "brw-resume-outside-"));
    const target = join(outside, "lockme");
    try {
      mkdirSync(join(dir, ".git", "brw"), { recursive: true });
      writeFileSync(target, "keep");
      symlinkSync(target, `${fileOf(dir)}.lock`);
      eq("brw-pr-handoff/9.2 ロックがシンボリックリンクなら書かない（ok:false）", bad(writeRecord(dir, entryOf("dev/a"))), true);
      eq("brw-pr-handoff/9.2 ロックのリンク先は変わらない", readFileSync(target, "utf8"), "keep");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
  inRepo((dir) => {
    mkdirSync(fileOf(dir), { recursive: true });
    eq("brw-pr-handoff/9.2 resume.json がディレクトリなら読まず、書かない（ok:false）", [readRecords(dir), bad(writeRecord(dir, entryOf("dev/a")))], [[], true]);
  });
  inRepo((dir) => {
    const big = JSON.stringify({ version: 1, entries: [{ ...entryOf("dev/a"), repository: `${"x".repeat(300 * 1024)}/y` }] });
    writeRaw(dir, big);
    eq("brw-pr-handoff/9.2 256 KiB を超える記録ファイルは読まない（空配列）", readRecords(dir), []);
  });
  // ブランチ名: 許可リスト（Unicode の文字・数字・. _ / -）だけを通す。読み込みでも不正な記録は捨てる
  const unsafeBranches = ["dev/$(id)", "dev/`id`", "dev/a;b", "dev/a&b", "dev/a|b", "dev/a b", "dev/a'b", 'dev/a"b', "dev/a<b", "dev/a>b", "dev/a*b", "dev/a?b", "dev/a!b", "dev/a#b", "dev/a\\b", "dev/a{b}", "dev/a[b]", "dev/a~b", "dev/a^b", "dev/a:b", "dev/a$b"];
  const safeBranches = ["dev/日本語", "dev/feature_1.2-x"];
  inRepo((dir) => {
    eq("brw-pr-handoff/9.2 許可された名前（Unicode の文字・数字・. _ / -）は書ける", safeBranches.map((b) => ok(writeRecord(dir, entryOf(b)))), safeBranches.map(() => true));
    eq("brw-pr-handoff/9.2 許可された名前は読み込みでも残る", readRecords(dir).map((e) => e.branch), ["dev/feature_1.2-x", "dev/日本語"]);
  });
  inRepo((dir) => {
    writeRaw(dir, JSON.stringify({ version: 1, entries: [...unsafeBranches.map((b) => entryOf(b)), entryOf("dev/good")] }));
    eq("brw-pr-handoff/9.2 読み込みでシェルで特別な文字を含むブランチ名の記録は捨てる", readRecords(dir).map((e) => e.branch), ["dev/good"]);
  });
  inRepo((dir) => {
    prepare(dir, "dev/good", {});
    writeRaw(dir, JSON.stringify({ version: 1, entries: [entryOf("dev/$(id)", { sessionId: "s1", ago: HOUR }), entryOf("dev/good", { sessionId: "s1", ago: 2 * HOUR })] }));
    eq("brw-pr-handoff/9.2 resumableFor は危険な名前の記録を返さず、正しい記録を返す", branchOf(resumableFor(dir, "s1", NOW)), "dev/good");
  });
  inRepo((dir) => {
    writeRaw(dir, JSON.stringify({ version: 1, entries: [entryOf("dev/a;b", { ago: 10 * 1000 }), entryOf("dev/good", { ago: 20 * 1000 })] }));
    eq("brw-pr-handoff/9.2 attachSession は危険な名前の記録に付けず、正しい記録に付けて書き直す", [attachSession(dir, "s1", NOW), readRecords(dir).map((e) => [e.branch, e.sessionId])], [{ ok: true, attached: true }, [["dev/good", "s1"]]]);
    eq("brw-pr-handoff/9.2 書き直した記録ファイルに危険な名前が残らない", JSON.parse(readOrNull(fileOf(dir))).entries.map((e) => e.branch), ["dev/good"]);
  });
  // ---- 切り出し元（base）: 任意の項目。不正・無い値は null に正規化し、base の無い既存の記録も読める（後方互換）（9.5） ----
  inRepo((dir) => {
    eq("brw-pr-handoff/9.5 base を書いた記録は、読むときに同じ base で返る", [ok(writeRecord(dir, entryOf("dev/a", { base: "main" }))), readRecords(dir)[0]?.base], [true, "main"]);
  });
  inRepo((dir) => {
    const old = { branch: "dev/a", prUrl: null, repository: null, sessionId: null, at: entryOf("dev/a").at };
    writeRaw(dir, JSON.stringify({ version: 1, entries: [old] }));
    eq("brw-pr-handoff/9.5 base の無い既存の記録も読め、base は null になる（後方互換）", readRecords(dir).map((e) => [e.branch, e.base]), [["dev/a", null]]);
  });
  inRepo((dir) => {
    const invalid = ["main;rm", "a b", "", 7, "x".repeat(300), "main\u0007"];
    const got = invalid.map((b) => {
      const r = writeRecord(dir, entryOf("dev/a", { base: b }));
      return [ok(r), readRecords(dir)[0]?.base];
    });
    eq("brw-pr-handoff/9.5 不正な base は書き込みを失敗にせず、null として保存する", got, invalid.map(() => [true, null]));
  });
  inRepo((dir) => {
    writeRecord(dir, entryOf("dev/a", { base: "main", ago: 30 * 1000 }));
    const r = attachSession(dir, "s1", NOW);
    eq("brw-pr-handoff/9.5 セッションを付けても base は変わらない（attachSession）", [r, readRecords(dir)[0]?.base, readRecords(dir)[0]?.sessionId], [{ ok: true, attached: true }, "main", "s1"]);
  });

  // ---- セッションの手がかり（9.7）: 実行前に書くメモ。10 分以内・同じ作業場所のときだけ使う ----
  const hintPath = (dir) => join(dir, ".git", "brw", "session-hint.json");
  const writeHintRaw = (dir, text) => {
    mkdirSync(join(dir, ".git", "brw"), { recursive: true });
    writeFileSync(hintPath(dir), text);
  };
  inRepo((dir) => {
    const wt = join(dir, "wt");
    eq("brw-pr-handoff/9.7 メモを書けば、同じ作業場所で 10 分以内に、そのセッションの ID を読める", [writeHint(dir, { sessionId: "s1", dir: wt, now: NOW }).ok, readHint(dir, wt, NOW)], [true, "s1"]);
    eq("brw-pr-handoff/9.7 メモは、別の作業場所（別の brw pr）には使われない", readHint(dir, join(dir, "other"), NOW), null);
  });
  inRepo((dir) => {
    const wt = join(dir, "wt");
    writeHint(dir, { sessionId: "s1", dir: wt, now: NOW });
    eq("brw-pr-handoff/9.7 ちょうど 10 分後のメモは読める（境界を含む）", readHint(dir, wt, new Date(NOW.getTime() + 10 * MIN)), "s1");
    writeHint(dir, { sessionId: "s1", dir: wt, now: NOW });
    eq("brw-pr-handoff/9.7 10 分と 1 ミリ秒を超えたメモは読まない", readHint(dir, wt, new Date(NOW.getTime() + 10 * MIN + 1)), null);
    writeHint(dir, { sessionId: "s1", dir: wt, now: NOW });
    eq("brw-pr-handoff/9.7 書いた時刻より前（未来）のメモは読まない", readHint(dir, wt, new Date(NOW.getTime() - 1)), null);
  });
  inRepo((dir) => {
    const wt = join(dir, "wt");
    const bad = [{ sessionId: "" }, { sessionId: "a\u0007b" }, { sessionId: "x".repeat(201) }, { sessionId: null }];
    const res = bad.map((o) => writeHint(dir, { dir: wt, now: NOW, ...o }).ok);
    eq("brw-pr-handoff/9.7 不正な sessionId のメモは書かず、ファイルも作らない（ok:false）", [res, existsSync(hintPath(dir))], [[false, false, false, false], false]);
    const badDirs = ["relative/wt", "a\u0007b", "/" + "d".repeat(4090)];
    const res2 = badDirs.map((d) => writeHint(dir, { sessionId: "s1", dir: d, now: NOW }).ok);
    eq("brw-pr-handoff/9.7 不正な dir（相対・制御文字・上限超え）のメモは書かない（ok:false）", res2, [false, false, false]);
    eq("brw-pr-handoff/9.7 不正な時刻（暦日の補正）の入力は、時刻として書かない（ok:false）", writeHint(dir, { sessionId: "s1", dir: wt, now: new Date("invalid") }).ok, false);
  });
  inRepo((dir) => {
    const wt = join(dir, "wt");
    const cases = [
      { version: 1, sessionId: "", dir: wt, at: NOW.toISOString() },
      { version: 1, sessionId: "s1", dir: "relative", at: NOW.toISOString() },
      { version: 1, sessionId: "s1", dir: wt, at: "2026-02-30T00:00:00.000Z" },
      { version: 2, sessionId: "s1", dir: wt, at: NOW.toISOString() },
      [1, 2],
    ];
    eq("brw-pr-handoff/9.7 不正な内容のメモは読まない（null）", cases.map((c) => { writeHintRaw(dir, JSON.stringify(c)); return readHint(dir, wt, NOW); }), [null, null, null, null, null]);
  });
  inRepo((dir) => {
    writeHintRaw(dir, "{ 壊れた");
    eq("brw-pr-handoff/9.7 読めないメモは null（例外にしない）", readHint(dir, join(dir, "wt"), NOW), null);
    writeHintRaw(dir, " ".repeat(5000) + "{}");
    eq("brw-pr-handoff/9.7 上限（4 KiB）を超えるメモは読まない", readHint(dir, join(dir, "wt"), NOW), null);
  });
  inRepo((dir) => {
    const wt = join(dir, "wt");
    mkdirSync(join(dir, ".git", "brw"), { recursive: true });
    const target = join(dir, "elsewhere.json");
    writeFileSync(target, JSON.stringify({ version: 1, sessionId: "s1", dir: wt, at: NOW.toISOString() }));
    symlinkSync(target, hintPath(dir));
    eq("brw-pr-handoff/9.7 メモがシンボリックリンクなら読まない（null）", readHint(dir, wt, NOW), null);
    eq("brw-pr-handoff/9.7 メモがシンボリックリンクなら書かず、リンク先も変えない（ok:false）", [writeHint(dir, { sessionId: "s2", dir: wt, now: NOW }).ok, readFileSync(target, "utf8").includes('"s1"')], [false, true]);
  });
  inRepo((dir) => {
    const wt = join(dir, "wt");
    const real = mkdtempSync(join(tmpdir(), "brw-hint-real-"));
    rmSync(join(dir, ".git", "brw"), { recursive: true, force: true });
    symlinkSync(real, join(dir, ".git", "brw"));
    eq("brw-pr-handoff/9.7 brw ディレクトリがリンクなら書かない（ok:false）", writeHint(dir, { sessionId: "s1", dir: wt, now: NOW }).ok, false);
    rmSync(real, { recursive: true, force: true });
  });
  inRepo((dir) => {
    const a = join(dir, "a");
    const b = join(dir, "b");
    writeHint(dir, { sessionId: "s1", dir: a, now: NOW });
    writeHint(dir, { sessionId: "s2", dir: b, now: NOW });
    eq("brw-pr-handoff/9.7 メモは最新 1 件だけ（前の作業場所のメモは残らない）", [readHint(dir, a, NOW), readHint(dir, b, NOW)], [null, "s2"]);
  });
  eq("brw-pr-handoff/9.7 Git の外では書かず、読まない（例外にしない）", [writeHint(nonGitDir(), { sessionId: "s1", dir: "/x", now: NOW }).ok, readHint(nonGitDir(), "/x", NOW)], [false, null]);

  // ---- 9.7 の直し: 採用したメモは消費する・拒否されたメモは残す・最新優先・配下の作業場所も一致・開いた fd で検査する ----
  inRepo((dir) => {
    const wt = join(dir, "wt");
    writeHint(dir, { sessionId: "s1", dir: wt, now: NOW });
    eq("brw-pr-handoff/9.7 採用されたメモは読み取りで消費され、ファイルが消える", [readHint(dir, wt, NOW), existsSync(hintPath(dir))], ["s1", false]);
    eq("brw-pr-handoff/9.7 消費されたメモは、2 回目には使われない（null）", readHint(dir, wt, NOW), null);
  });
  inRepo((dir) => {
    const wt = join(dir, "wt");
    writeHint(dir, { sessionId: "s1", dir: wt, now: NOW });
    eq("brw-pr-handoff/9.7 作業場所が一致しないメモは採用されず、ファイルも消さない", [readHint(dir, join(dir, "other"), NOW), existsSync(hintPath(dir))], [null, true]);
  });
  inRepo((dir) => {
    const wt = join(dir, "wt");
    writeHint(dir, { sessionId: "denied-s", dir: wt, now: NOW });
    writeHint(dir, { sessionId: "other-s", dir: join(dir, "elsewhere"), now: NOW });
    eq("brw-pr-handoff/9.7 拒否された呼び出しのメモの後に別の作業場所のメモが来ても、前のメモは使われない（最新 1 件）", readHint(dir, wt, NOW), null);
  });
  inRepo((dir) => {
    const wt = join(dir, "wt");
    mkdirSync(join(wt, "src"), { recursive: true });
    writeHint(dir, { sessionId: "s1", dir: join(wt, "src"), now: NOW });
    eq("brw-pr-handoff/9.7 作業場所の配下（src/）から呼んだメモも、作業場所と一致する", readHint(dir, wt, NOW), "s1");
  });
  inRepo((dir) => {
    const wt = join(dir, "wt");
    mkdirSync(join(dir, "wt-other"), { recursive: true });
    writeHint(dir, { sessionId: "s1", dir: join(dir, "wt-other"), now: NOW });
    eq("brw-pr-handoff/9.7 兄弟のディレクトリ（<wt>-other）のメモは、作業場所と一致しない", readHint(dir, wt, NOW), null);
  });
  inRepo((dir) => {
    writeHintRaw(dir, JSON.stringify({ version: 1, sessionId: "s1", dir: join(dir, "wt"), at: NOW.toISOString() }));
    mkdirSync(join(dir, "wt"), { recursive: true });
    eq("brw-pr-handoff/9.7 メモの中身の読み取りは上限内で行い、ディレクトリを置いたパスは読まない（null）", (() => { rmSync(hintPath(dir)); mkdirSync(hintPath(dir)); return readHint(dir, join(dir, "wt"), NOW); })(), null);
  });

  // ---- 9.7 の 2 回目の直し: 検証→採用→消費をロックの下で一体にする・削除失敗は null・FIFO で止まらない・限界の確認 ----
  const RR_PATH = fileURLToPath(new URL("../scripts/resume-record.mjs", import.meta.url));
  const lockOf = (dir) => join(dir, ".git", "brw", "session-hint.json.lock");
  // 別のプロセスが保持しているように見せるロック（生きている pid を書く）
  const holdLock = (dir) => writeFileSync(lockOf(dir), String(process.pid));
  const childRead = (code) => {
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 10000 });
    return { status: res.status, signal: res.signal, out: res.stdout ?? "" };
  };
  inRepo((dir) => {
    const wt = join(dir, "wt");
    writeHint(dir, { sessionId: "s1", dir: wt, now: NOW });
    holdLock(dir);
    eq("brw-pr-handoff/9.7 ロックが取れないときは、セッションを返さず、メモも消さない（検証と消費を同じロックの下で行う）", [readHint(dir, wt, NOW, { lockWaitMs: 20 }), existsSync(hintPath(dir))], [null, true]);
    rmSync(lockOf(dir), { force: true });
  });
  inRepo((dir) => {
    const wt = join(dir, "wt");
    writeHint(dir, { sessionId: "s1", dir: wt, now: NOW });
    eq("brw-pr-handoff/9.7 メモを消せないときは、セッションを返さない（再利用の防止）", readHint(dir, wt, NOW, { remove: () => { throw new Error("消せない（試験）"); } }), null);
  });
  inRepo((dir) => {
    const wt = join(dir, "wt");
    writeHint(dir, { sessionId: "s1", dir: wt, now: NOW });
    const replaced = JSON.stringify({ version: 1, sessionId: "s2", dir: wt, at: NOW.toISOString() });
    const got = readHint(dir, wt, NOW, { beforeRemove: () => writeHintRaw(dir, replaced) });
    eq("brw-pr-handoff/9.7 検証の後で内容が変わったメモは、返さず、消さない（新しいメモを消さない）", [got, readOrNull(hintPath(dir))], [null, replaced]);
  });
  inRepo((dir) => {
    mkdirSync(join(dir, ".git", "brw"), { recursive: true });
    const r = spawnSync("mkfifo", [hintPath(dir)]);
    const wt = join(dir, "wt");
    const c = childRead(`import(${JSON.stringify(RR_PATH)}).then((m) => { process.stdout.write(JSON.stringify(m.readSessionHint(${JSON.stringify(dir)}, ${JSON.stringify(wt)}, new Date()))); });`);
    eq("brw-pr-handoff/9.7 メモの置き場が FIFO でも、読み取りはブロックせず null を返す（タイムアウトしない）", [r.status, c.status, c.signal, c.out], [0, 0, null, "null"]);
  });
  inRepo((dir) => {
    mkdirSync(join(dir, ".git", "brw"), { recursive: true });
    const r = spawnSync("mkfifo", [join(dir, ".git", "brw", "resume.json")]);
    const c = childRead(`import(${JSON.stringify(RR_PATH)}).then((m) => { process.stdout.write(JSON.stringify(m.readRecords(${JSON.stringify(dir)}))); });`);
    eq("brw-pr-handoff/9.7 resume.json の置き場が FIFO でも、読み取りはブロックせず空を返す（タイムアウトしない）", [r.status, c.status, c.signal, c.out], [0, 0, null, "[]"]);
  });
  // 限界の確認: 後続の呼び出しのメモ書き込みが失敗すると、直前の拒否・失敗した呼び出しのセッションを採用しうる（10 分以内・同じ作業場所）
  inRepo((dir) => {
    const wt = join(dir, "wt");
    writeHint(dir, { sessionId: "denied-s", dir: wt, now: NOW });
    holdLock(dir);
    const w2 = writeHint(dir, { sessionId: "later-s", dir: wt, now: NOW }, { lockWaitMs: 20 });
    rmSync(lockOf(dir), { force: true });
    eq("brw-pr-handoff/9.7 限界: 後続の呼び出しのメモ書き込みが失敗すると、直前の拒否した呼び出しのセッションを採用しうる（10 分以内・同じ作業場所）", [w2.ok, readHint(dir, wt, NOW)], [false, "denied-s"]);
  });
  // 後続の呼び出しが自分のメモを書けば置き換わり、そのセッションが採用される（失敗・拒否の後の別セッションを含む）
  inRepo((dir) => {
    const wt = join(dir, "wt");
    writeHint(dir, { sessionId: "denied-s", dir: wt, now: NOW });
    writeHint(dir, { sessionId: "later-s", dir: wt, now: NOW });
    eq("brw-pr-handoff/9.7 後続の呼び出しが自分のメモを書けば置き換わり、そのセッションが採用される", readHint(dir, wt, NOW), "later-s");
  });

};

// 指定した経過時間の記録を 1 件置き、その記録を resumableFor で探す（境界の試験用）
const prepareAndFind = (dir, agoMs) => {
  prepare(dir, "dev/foo", { record: entryOf("dev/foo", { ago: agoMs, sessionId: "s1" }) });
  return resumableFor(dir, "s1", NOW);
};
