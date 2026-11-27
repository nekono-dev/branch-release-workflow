// `brw resume`（引数なし）の一覧（brw-pr-handoff 7.3・9.3）の試験。selftest.mjs から呼ばれる。
// 実際の scripts/brw.mjs を子プロセスで実行し、一時リポジトリ（本体・worktree・bare の遠隔）で確かめる。
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeRecord } from "../scripts/resume-record.mjs";
import { gitOut, mkRepoWithRemote, mkWorktree } from "./support/git-fixture.mjs";

const BRW = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "brw.mjs");
const CONFIG = { workBranches: ["dev/*"], protectedBranches: ["main"], baseBranch: "develop" };

/** brw を本体（cwd）で実行する。 */
const brw = (cwd, ...args) => {
  const r = spawnSync(process.execPath, [BRW, ...args], { cwd, encoding: "utf8", env: { ...process.env, BRW_NO_GH: "1" } });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
};

/** 一覧の行（「  - `名前`」）から名前を取り出す。 */
const itemsOf = (out) => out.split("\n").filter((l) => l.startsWith("  - `")).map((l) => /^  - `([^`]*)`/.exec(l)[1]);

/**
 * 本体・宣言・遠隔の作業ブランチを用意する。
 * 遠隔に push したブランチ（names）、worktree を持つブランチ（withWorktree）、ローカルにだけあるブランチを作る。
 */
function fixture({ names = [], withWorktree = null, extraPushed = [], localOnly = [] } = {}) {
  const r = mkRepoWithRemote({ branch: "main", config: CONFIG });
  gitOut(r.dir, "branch", "develop");
  const pushed = [...names, ...extraPushed];
  for (const n of pushed) gitOut(r.dir, "branch", n);
  for (const n of localOnly) gitOut(r.dir, "branch", n);
  let wt = null;
  if (withWorktree) {
    wt = mkWorktree(r.dir, withWorktree);
    pushed.push(withWorktree);
  }
  gitOut(r.dir, "push", "-q", "origin", "develop", ...pushed);
  // 遠隔にだけ残すブランチは、ローカルのブランチを消す（一覧は遠隔の追跡ブランチを見る）
  for (const n of pushed) if (n !== withWorktree) gitOut(r.dir, "branch", "-q", "-D", n);
  return { ...r, wt };
}

export const runResumeListChecks = (eq) => {
  // ---- 候補: 遠隔の開発ブランチのうち、作業場所が無いもの。保護・分岐元・宣言外・ローカルだけのものは除く ----
  {
    const t = fixture({
      names: ["dev/a", "dev/b", "feature/x"],
      withWorktree: "dev/with-wt",
      localOnly: ["dev/local-only"],
    });
    const x = brw(t.dir, "resume");
    const items = itemsOf(x.out);
    eq("brw-pr-handoff/7.3 引数なしの brw resume は、作業場所の無い遠隔の開発ブランチだけを一覧し、終了コード 0 にする", [x.code, items.sort()], [0, ["dev/a", "dev/b"]]);
    eq("brw-pr-handoff/7.3 一覧には使い方（brw resume <ブランチ>）と git fetch の案内を含める", [x.out.includes("使い方: brw resume <ブランチ>"), x.out.includes("git fetch")], [true, true]);
    t.cleanup();
  }

  // ---- 公開の記録があるものを先頭（記録の新しい順）、続けて名前順 ----
  {
    const t = fixture({ names: ["dev/a", "dev/b", "dev/c"] });
    const now = Date.now();
    writeRecord(t.dir, { branch: "dev/c", prUrl: "https://github.com/acme/app/pull/3", repository: "acme/app", sessionId: null, at: new Date(now - 1000).toISOString() });
    writeRecord(t.dir, { branch: "dev/b", prUrl: "https://github.com/acme/app/pull/2", repository: "acme/app", sessionId: null, at: new Date(now).toISOString() });
    const x = brw(t.dir, "resume");
    eq("brw-pr-handoff/7.3 公開の記録があるものを先頭（記録の新しい順）にし、続けて名前順に並べる", itemsOf(x.out), ["dev/b", "dev/c", "dev/a"]);
    eq("brw-pr-handoff/7.3 記録のある行には PR の URL と公開の時刻を示す", x.out.includes("https://github.com/acme/app/pull/2"), true);
    t.cleanup();
  }

  // ---- 候補が無いとき ----
  {
    const t = fixture({ names: [] });
    const x = brw(t.dir, "resume");
    eq("brw-pr-handoff/9.3 候補が無いときは、その旨と brw create を示し、終了コード 0 にする", [x.code, x.out.includes("再開できる作業ブランチはありません"), x.out.includes("brw create"), itemsOf(x.out).length], [0, true, true, 0]);
    t.cleanup();
  }

  // ---- 21 件以上は 20 件までを示し、残りは「ほか N 件」 ----
  {
    const names = Array.from({ length: 21 }, (_, i) => `dev/n${String(i + 1).padStart(2, "0")}`);
    const t = fixture({ names });
    const x = brw(t.dir, "resume");
    eq("brw-pr-handoff/9.3 候補が 21 件以上のときは 20 件を示し、残りを「ほか 1 件」と書く", [itemsOf(x.out).length, x.out.includes("ほか 1 件")], [20, true]);
    t.cleanup();
  }

  // ---- 表示の無害化: 書式制御文字は \uXXXX として示し、生の文字は出さない ----
  {
    const raw = "dev/x\u202Ey";
    const t = fixture({ names: [raw] });
    const x = brw(t.dir, "resume");
    eq("brw-pr-handoff/9.3 一覧の値の書式制御文字は \\uXXXX として示し、生の文字を出さない", [x.out.includes("dev/x\\u202ey"), x.out.includes(raw)], [true, false]);
    t.cleanup();
  }

  // ---- 一覧の候補は origin の追跡ブランチだけ（引数ありの resume が取得する先と同じ）。別のリモートだけにあるものは出さない ----
  {
    const t = fixture({ names: ["dev/foo"] });
    const up = join(dirname(t.dir), "upstream.git");
    gitOut(t.dir, "init", "-q", "--bare", up);
    gitOut(t.dir, "remote", "add", "upstream", up);
    gitOut(t.dir, "push", "-q", "upstream", "origin/dev/foo:refs/heads/dev/foo");
    gitOut(t.dir, "push", "-q", "upstream", "origin/dev/foo:refs/heads/dev/only-up");
    const x = brw(t.dir, "resume");
    eq("brw-pr-handoff/7.3 一覧の候補は origin の追跡ブランチだけ（upstream だけにあるブランチは出さず、origin にあるものは 1 件だけ出す）", [x.code, itemsOf(x.out)], [0, ["dev/foo"]]);
    t.cleanup();
  }

  // ---- origin が無いリポジトリでは、一覧を出せない旨を示す（終了コード 0） ----
  {
    const t = fixture({ names: ["dev/foo"] });
    gitOut(t.dir, "remote", "remove", "origin");
    const x = brw(t.dir, "resume");
    eq("brw-pr-handoff/7.3 origin が無いときは、一覧を出せない旨を示し、終了コード 0 にする", [x.code, x.out.includes("origin が無いので一覧を出せません"), itemsOf(x.out).length], [0, true, 0]);
    t.cleanup();
  }

  // ---- 引数ありの従来の動作は変えない ----
  {
    const t = fixture({ names: ["dev/a"] });
    const protectedRun = brw(t.dir, "resume", "main");
    eq("brw-pr-handoff/7.3 引数ありで保護ブランチを指定したときは、従来どおり拒否（終了コード 1）し、一覧を出さない", [protectedRun.code, protectedRun.out.includes("再開できる作業ブランチ")], [1, false]);
    const unknownOption = brw(t.dir, "resume", "--bogus");
    eq("brw-pr-handoff/7.3 不明なオプションだけのときは、従来どおり使い方の誤り（終了コード 2）", unknownOption.code, 2);
    const ok = brw(t.dir, "resume", "dev/a");
    eq("brw-pr-handoff/7.3 引数ありで遠隔のブランチを指定したときは、従来どおり worktree を作る", [ok.code, ok.out.includes("リモートから取得し直して worktree を作りました")], [0, true]);
    t.cleanup();
  }

  // ---- brw resume: 作業場所をリモートから作り直したとき、再開の記録の base を切り出し元（brwBase）に戻す（9.5） ----
  // 条件: brwBase が未設定・記録に同じブランチの有効な base・その base が宣言で認められた取り込み先（undeclared でない）のときだけ
  const brwBaseOf = (cwd, branch) => {
    const res = spawnSync("git", ["config", "--get", `branch.${branch}.brwBase`], { cwd, encoding: "utf8" });
    return res.status === 0 ? res.stdout.trim() : null;
  };
  // 遠隔にだけあるブランチ（ローカルのブランチと作業場所は無い）を用意する。record は記録の内容（null なら記録を書かない）。presetConfig は再開の前の brwBase
  const remoteOnly = (branch, { record = null, presetConfig = null } = {}) => {
    const r = mkRepoWithRemote({ branch: "main", config: CONFIG });
    gitOut(r.dir, "branch", "develop");
    gitOut(r.dir, "branch", branch);
    gitOut(r.dir, "push", "-q", "origin", "develop", branch);
    gitOut(r.dir, "branch", "-q", "-D", branch);
    if (presetConfig !== null) gitOut(r.dir, "config", `branch.${branch}.brwBase`, presetConfig);
    if (record !== null) {
      const w = writeRecord(r.dir, { branch, prUrl: "https://github.com/acme/app/pull/7", repository: "acme/app", sessionId: null, at: new Date().toISOString(), base: record });
      if (!w.ok) throw new Error(`記録の準備に失敗: ${w.message}`);
    }
    return r;
  };
  {
    const r = remoteOnly("dev/rest", { record: "main" });
    const res = brw(r.dir, "resume", "dev/rest");
    eq("brw-pr-handoff/9.5 brw resume: 記録の base（main）を brwBase に戻す（作業場所をリモートから作り直したとき）", [res.code, brwBaseOf(r.dir, "dev/rest")], [0, "main"]);
    eq("brw-pr-handoff/9.5 brw resume: 戻したことを 1 行で表示する", res.out.includes("切り出し元（main）を再開の記録から復元しました"), true);
    r.cleanup();
  }
  {
    const r = remoteOnly("dev/nore");
    const res = brw(r.dir, "resume", "dev/nore");
    eq("brw-pr-handoff/9.5 brw resume: 記録が無ければ brwBase は設定しない（従来どおり）", [res.code, brwBaseOf(r.dir, "dev/nore")], [0, null]);
    r.cleanup();
  }
  {
    const r = remoteOnly("dev/undec", { record: "feature/x" });
    const res = brw(r.dir, "resume", "dev/undec");
    eq("brw-pr-handoff/9.5 brw resume: 記録の base が宣言外（undeclared）なら設定しない", [res.code, brwBaseOf(r.dir, "dev/undec")], [0, null]);
    r.cleanup();
  }
  {
    const r = remoteOnly("dev/keep", { record: "main", presetConfig: "develop" });
    const res = brw(r.dir, "resume", "dev/keep");
    eq("brw-pr-handoff/9.5 brw resume: 既に設定された brwBase は上書きしない", [res.code, brwBaseOf(r.dir, "dev/keep")], [0, "develop"]);
    r.cleanup();
  }


  // 書き込みの失敗（brwBase の設定だけを拒否する git の shim）: 復元の成功は表示せず、警告を標準エラーに出す。終了コードは成功のまま
  {
    const r = remoteOnly("dev/denied", { record: "main" });
    const shimDir = mkdtempSync(join(tmpdir(), "brw-rl-shim-"));
    const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    writeFileSync(join(shimDir, "git"), `#!/bin/sh\ncase " $* " in *" branch."*".brwBase "*) case " $* " in *" --get "*) ;; *) echo "shim: denied" >&2; exit 1;; esac;; esac\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
    const res = spawnSync("node", [BRW, "resume", "dev/denied"], { cwd: r.dir, encoding: "utf8", env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}`, BRW_NO_GH: "1" } });
    eq("brw-pr-handoff/9.5 brw resume: 復元の書き込みが失敗したら、成功の表示を出さず、標準エラーに警告を出す（終了コードは成功のまま）", [res.status, res.stdout.includes("切り出し元（main）を再開の記録から復元しました"), res.stderr.includes("切り出し元の復元に失敗しました"), brwBaseOf(r.dir, "dev/denied")], [0, false, true, null]);
    rmSync(shimDir, { recursive: true, force: true });
    r.cleanup();
  }

};
