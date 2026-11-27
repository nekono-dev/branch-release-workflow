// PR 本文の雛形・記入指示・本文ファイル（pr-template）の試験。selftest.mjs から呼ばれる。
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bodyPathOf, buildTemplate, instruction, prepareBody, resolveTemplate, UNFILLED_MARK } from "../scripts/pr-template.mjs";
import { TIDY_SUBJECT } from "../scripts/tidy.mjs";
import { fileURLToPath } from "node:url";
import { mkRepoWithRemote, gitOut } from "./support/git-fixture.mjs";

const git = (cwd, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-C", cwd, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const repo = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "brw-prt-")));
  execFileSync("git", ["init", "-q", "-b", "develop", d], { stdio: "ignore" });
  writeFileSync(join(d, "a.txt"), "a\n");
  git(d, "add", "-A");
  git(d, "commit", "-q", "-m", "base");
  return d;
};
const CALLER = /cc-sdd|kiro|\.kiro/i;

export const runPrTemplateChecks = async (eq) => {
  const d = repo();
  const ja = resolveTemplate(d, "ja");
  eq("brw-pr-handoff/3.2 既定の雛形は日本語で、概要・変更内容・検証・作業外の変更の 4 つの節を持つ", [ja.source, ["## 概要", "## 変更内容", "## 検証", "## 作業外の変更"].every((h) => ja.text.includes(h))], ["builtin", true]);
  const en = resolveTemplate(d, "en");
  eq("brw-pr-handoff/3.4 言語に en を指定すると、英語の既定の雛形になる", [en.source, en.text.includes("## Summary"), en.text.includes("## Out-of-scope changes")], ["builtin", true, true]);
  eq("brw-pr-handoff/3.4 言語の指定が無い・未知のときは日本語になる", [resolveTemplate(d, undefined).text.includes("## 概要"), resolveTemplate(d, "fr").text.includes("## 概要")], [true, true]);

  // リポジトリの雛形が優先
  const r = repo();
  mkdirSync(join(r, ".github"), { recursive: true });
  writeFileSync(join(r, ".github", "PULL_REQUEST_TEMPLATE.md"), "## Why\n\n## 検証\n\n(here)\n");
  const rr = resolveTemplate(r, "en");
  eq("brw-pr-handoff/3.3 リポジトリの雛形があれば、既定の雛形より優先する", [rr.source, rr.text.includes("## Why"), rr.text.includes("## Summary")], ["repo", true, false]);

  // 作業外の変更・検証の差し込み
  const built = buildTemplate({ worktree: d, language: "ja", planned: ["x.txt", "dir/y.txt"], verification: "node tests/selftest.mjs が成功", failed: false });
  const out = built.slice(built.indexOf("## 作業外の変更"));
  const ver = built.slice(built.indexOf("## 検証"), built.indexOf("## 作業外の変更"));
  eq("brw-pr-handoff/2.5 作業外の変更の節に、別コミットになる予定のファイルの一覧が入る", [out.includes("- x.txt"), out.includes("- dir/y.txt")], [true, true]);
  eq("brw-pr-handoff/3.6 検証の節に、検証の要約が入る", ver.includes("node tests/selftest.mjs が成功"), true);
  eq("brw-pr-handoff/3.6 検証が未通過なら、未通過であることを検証の節の先頭に明記する", (() => {
    const b = buildTemplate({ worktree: d, language: "ja", verification: "失敗した", failed: true });
    const v = b.slice(b.indexOf("## 検証"), b.indexOf("## 作業外の変更"));
    return [v.includes("検証未通過"), v.indexOf("検証未通過") < v.indexOf("失敗した")];
  })(), [true, true]);
  eq("brw-pr-handoff/2.5 変更が無いときは「なし」と書く", buildTemplate({ worktree: d, language: "ja" }).includes("なし"), true);

  // 既に別コミットになった分
  const t = repo();
  writeFileSync(join(t, "b.txt"), "b\n");
  git(t, "add", "b.txt");
  git(t, "commit", "-q", "-m", TIDY_SUBJECT, "-m", "- b.txt");
  eq("brw-pr-handoff/2.5 既に別コミットになった作業外の変更のファイルも、一覧に含める", buildTemplate({ worktree: t, language: "ja", planned: ["c.txt"] }).slice(-200).includes("- b.txt") && buildTemplate({ worktree: t, language: "ja", planned: ["c.txt"] }).includes("- c.txt"), true);

  // 節の無いリポジトリの雛形では末尾に追記する
  const n = repo();
  mkdirSync(join(n, ".github"), { recursive: true });
  writeFileSync(join(n, ".github", "PULL_REQUEST_TEMPLATE.md"), "変更の背景を書いてください。\n");
  const nb = buildTemplate({ worktree: n, language: "ja", planned: ["z.txt"], verification: "確認済み" });
  eq("brw-pr-handoff/3.5 節の見出しが無い雛形では、作業外の変更・検証を末尾に追記する", [nb.startsWith(UNFILLED_MARK), nb.includes("変更の背景を書いてください。"), nb.indexOf("## 検証") > nb.indexOf("変更の背景"), nb.indexOf("## 作業外の変更") > nb.indexOf("## 検証"), nb.includes("- z.txt")], [true, true, true, true, true]);

  // 本文ファイルの置き場所と、上書きしない動作
  const main = d;
  const path = bodyPathOf(main, "dev/foo");
  eq("brw-pr-handoff/3.9 本文ファイルは本体の worktree 置き場の配下（作業ツリーの外）に置く", [path, path.startsWith(join(main, ".claude", "worktrees", ".brw") + "/")], [join(main, ".claude", "worktrees", ".brw", "dev-foo.md"), true]);
  const first = prepareBody(path, { worktree: d, language: "ja", planned: ["q.txt"] });
  eq("brw-pr-handoff/3.1 本文ファイルが作られ、未記入の印を持つ", [first.written, first.filled, existsSync(path), readFileSync(path, "utf8").startsWith(UNFILLED_MARK)], [true, false, true, true]);
  const draft = `${UNFILLED_MARK} -->\n## 概要\n\n書きかけの文章\n`;
  writeFileSync(path, draft);
  const mid = prepareBody(path, { worktree: d, language: "ja", planned: ["new.txt"] });
  eq("brw-pr-handoff/3.1 記入途中（未記入の印が残る）の本文も上書きしない", [mid.written, mid.filled, readFileSync(path, "utf8")], [false, false, draft]);
  writeFileSync(path, "## 概要\n\n書き終えた本文\n");
  const again = prepareBody(path, { worktree: d, language: "ja" });
  eq("brw-pr-handoff/3.1 記入済みの本文は上書きせず、パスを案内できる", [again.written, again.filled, readFileSync(path, "utf8")], [false, true, "## 概要\n\n書き終えた本文\n"]);

  // 記入指示
  const ins = instruction({ bodyPath: path, base: "develop", language: "ja" });
  eq("brw-pr-handoff/3.7 記入指示は本文のパス・各節の書き方・事実だけ・参照する情報・書き終えた後のコマンドを含む", [
    ins.includes(path), ins.includes("事実だけ"), ins.includes("git log develop..HEAD"), ins.includes("git diff --stat develop"), ins.includes(`brw pr --body-file ${path}`),
  ], [true, true, true, true, true]);
  // ---- 分岐元での brw pr-template（brw-pr-handoff 7.4）: 実際の scripts/brw.mjs を spawn する ----
  const BRW = fileURLToPath(new URL("../scripts/brw.mjs", import.meta.url));
  const TPL_CONFIG = { workBranches: ["dev/*"], protectedBranches: ["main"], baseBranch: "develop" };
  const tpl = (cwd) => {
    const r = spawnSync(process.execPath, [BRW, "pr-template"], { cwd, encoding: "utf8", env: { ...process.env, BRW_NO_GH: "1" } });
    return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  };
  // 分岐元（develop）のチェックアウト。未コミットの作業外の変更を 1 件置く（分岐元の本文には載せないことを確かめる）
  {
    const r = mkRepoWithRemote({ branch: "main", config: TPL_CONFIG });
    try {
      gitOut(r.dir, "checkout", "-q", "-b", "develop");
      writeFileSync(join(r.dir, "d1.txt"), "d1\n");
      gitOut(r.dir, "add", "d1.txt");
      gitOut(r.dir, "commit", "-q", "-m", "d1");
      writeFileSync(join(r.dir, "extra.txt"), "作業外\n");
      const x = tpl(r.dir);
      const body = existsSync(bodyPathOf(r.dir, "develop")) ? readFileSync(bodyPathOf(r.dir, "develop"), "utf8") : "";
      eq("brw-pr-handoff/7.4 分岐元の pr-template は雛形と記入指示を出し、本文を bodyPathOf の場所に書く（終了コード 0）", [x.code, existsSync(bodyPathOf(r.dir, "develop")), body.startsWith(UNFILLED_MARK)], [0, true, true]);
      eq("brw-pr-handoff/7.4 分岐元の pr-template は作成元（develop）と作成先（main）を示す", [x.out.includes("作成元"), x.out.includes("develop"), x.out.includes("作成先"), x.out.includes("main")], [true, true, true, true]);
      eq("brw-pr-handoff/7.4 分岐元の作業外の変更の節は該当なしとし、別コミットの予定を出さない（本文にも出力にも未コミットのファイル名を載せない）", [body.includes("該当なし"), body.includes("extra.txt"), x.out.includes("extra.txt"), body.includes("別コミットに含めたファイル")], [true, false, false, false]);
      eq("brw-pr-handoff/7.4 分岐元の記入指示の取り込み先は作成先（main）で、リモートの比較（refs/remotes/origin/main..refs/remotes/origin/develop）を案内する", [x.out.includes("refs/remotes/origin/main..refs/remotes/origin/develop"), x.out.includes("git log develop..HEAD")], [true, false]);
      eq("brw-pr-handoff/7.4 分岐元の pr-template は、作業の記録（.git/brw）を作らない", existsSync(join(r.dir, ".git", "brw")), false);
    } finally { r.cleanup(); }
  }
  {
    const r = mkRepoWithRemote({ branch: "main", config: { ...TPL_CONFIG, protectedBranches: ["main", "release"] } });
    try {
      gitOut(r.dir, "checkout", "-q", "-b", "develop");
      const x = tpl(r.dir);
      eq("brw-pr-handoff/7.4 保護ブランチが複数で作成先を決められないときは、--target の指定を注記して雛形を出す", [x.code, x.out.includes("--target"), existsSync(bodyPathOf(r.dir, "develop"))], [0, true, true]);
    } finally { r.cleanup(); }
  }
  {
    const r = mkRepoWithRemote({ branch: "main", config: TPL_CONFIG });
    try {
      gitOut(r.dir, "checkout", "-q", "-b", "dev/foo");
      const x = tpl(r.dir);
      eq("brw-pr-handoff/7.4 開発ブランチの pr-template は従来どおり（作成先の表示なし・作業外の変更の節あり）", [x.code, x.out.includes("作成先"), readFileSync(bodyPathOf(r.dir, "dev/foo"), "utf8").includes("## 作業外の変更")], [0, false, true]);
    } finally { r.cleanup(); }
  }
  for (const [label, checkout] of [["保護ブランチ（main）", null], ["宣言外（feature/x）", "feature/x"]]) {
    const r = mkRepoWithRemote({ branch: "main", config: TPL_CONFIG });
    try {
      if (checkout) gitOut(r.dir, "checkout", "-q", "-b", checkout);
      const x = tpl(r.dir);
      eq(`brw-pr-handoff/7.4 ${label}では従来どおり拒否し、本文を書かない`, [x.code, x.out.includes("開発ブランチではない"), existsSync(bodyPathOf(r.dir, checkout ?? "main"))], [1, true, false]);
    } finally { r.cleanup(); }
  }
  // ---- レビュー指摘の対応（7.4）: 分岐元の記入指示はリモートの参照で比べる。保護ブランチの案内は、分岐元の一覧に応じて変える ----
  const brwRun = (cwd, args) => {
    const r = spawnSync(process.execPath, [BRW, ...args], { cwd, encoding: "utf8", env: { ...process.env, BRW_NO_GH: "1" } });
    return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  };
  {
    // 古いローカルの保護ブランチ（origin/main はその先へ進んでいる）と、未コミットの変更を置いた分岐元
    const r = mkRepoWithRemote({ branch: "main", config: TPL_CONFIG });
    try {
      gitOut(r.dir, "checkout", "-q", "-b", "develop");
      writeFileSync(join(r.dir, "d1.txt"), "d1\n");
      gitOut(r.dir, "add", "d1.txt");
      gitOut(r.dir, "commit", "-q", "-m", "d1");
      gitOut(r.dir, "push", "-q", "origin", "develop");
      const other = join(mkdtempSync(join(tmpdir(), "brw-oth-")), "o");
      gitOut(r.dir, "clone", "-q", "-b", "main", r.remote, other);
      writeFileSync(join(other, "m2.txt"), "m2\n");
      gitOut(other, "add", "m2.txt");
      gitOut(other, "commit", "-q", "-m", "m2");
      gitOut(other, "push", "-q", "origin", "main");
      gitOut(r.dir, "fetch", "-q", "origin");
      writeFileSync(join(r.dir, "extra.txt"), "未コミット\n");
      const x = brwRun(r.dir, ["pr-template"]);
      eq("brw-pr-handoff/7.4 分岐元の記入指示は、明示した refspec で両方の参照を更新してから、完全参照名のリモートの比較を案内する", [x.out.includes("git fetch origin +refs/heads/main:refs/remotes/origin/main +refs/heads/develop:refs/remotes/origin/develop"), x.out.includes("refs/remotes/origin/main..refs/remotes/origin/develop"), x.out.includes("refs/remotes/origin/main...refs/remotes/origin/develop")], [true, true, true]);
      eq("brw-pr-handoff/7.4 分岐元の記入指示は、取得の有無に依らず比較の前に必ず更新する（「まだ取得していなければ」の条件を含めない）", [x.out.includes("まだ取得していなければ"), x.out.includes("比較の前に必ず")], [false, true]);
      eq("brw-pr-handoff/7.4 分岐元の記入指示は、古いローカルの保護ブランチ基準（main..HEAD・git diff --stat main）を案内しない", [x.out.includes("main..HEAD"), x.out.includes("git diff --stat main")], [false, false]);
      eq("brw-pr-handoff/7.4 分岐元の記入指示は、未コミットの変更が PR に含まれないことを 1 行で注記する", x.out.includes("未コミットの変更は PR に含まれません"), true);
    } finally { r.cleanup(); }
  }
  {
    // 保護ブランチが唯一の恒常的な分岐元（baseBranch と protectedBranches がともに main）
    const r = mkRepoWithRemote({ branch: "main", config: { workBranches: ["dev/*"], protectedBranches: ["main"], baseBranch: "main" } });
    try {
      const x = brwRun(r.dir, ["pr-template"]);
      const y = brwRun(r.dir, ["pr", "--title", "t"]);
      eq("brw-pr-handoff/7.4 恒常的な分岐元がすべて保護ブランチのとき、brw pr-template・brw pr は分岐元のチェックアウトを案内せず、宣言の見直しを案内する", [
        x.code, y.code, x.out.includes("分岐元のチェックアウトで brw pr"), y.out.includes("分岐元のチェックアウトで brw pr"), x.out.includes("見直"), y.out.includes("見直"),
      ], [1, 1, false, false, true, true]);
    } finally { r.cleanup(); }
  }
  {
    // 別の分岐元 develop がある宣言（protectedBranches は main）では、従来どおり develop のチェックアウトを案内する
    const r = mkRepoWithRemote({ branch: "main", config: TPL_CONFIG });
    try {
      const x = brwRun(r.dir, ["pr-template"]);
      const y = brwRun(r.dir, ["pr", "--title", "t"]);
      eq("brw-pr-handoff/7.4 別の分岐元（develop）がある宣言では、保護ブランチの案内が develop のチェックアウトを示す", [
        x.out.includes("分岐元（develop）のチェックアウトで brw pr"), y.out.includes("分岐元（develop）のチェックアウトで brw pr"), y.out.includes("見直"),
      ], [true, true, false]);
    } finally { r.cleanup(); }
  }
  // 限定された fetch 設定（origin/main・origin/develop を追跡しない）で、リモートだけが進んだ後、案内どおりの fetch で両参照が最新になる（実 git）
  {
    const r = mkRepoWithRemote({ branch: "main", config: TPL_CONFIG });
    try {
      gitOut(r.dir, "checkout", "-q", "-b", "develop");
      writeFileSync(join(r.dir, "d1.txt"), "d1\n");
      gitOut(r.dir, "add", "d1.txt");
      gitOut(r.dir, "commit", "-q", "-m", "d1");
      gitOut(r.dir, "push", "-q", "origin", "develop");
      gitOut(r.dir, "fetch", "-q", "origin");
      gitOut(r.dir, "config", "remote.origin.fetch", "+refs/heads/other:refs/remotes/origin/other");
      const other = join(mkdtempSync(join(tmpdir(), "brw-fx2-")), "o");
      gitOut(r.dir, "clone", "-q", "-b", "main", r.remote, other);
      writeFileSync(join(other, "m2.txt"), "m2\n");
      gitOut(other, "add", "m2.txt");
      gitOut(other, "commit", "-q", "-m", "m2");
      gitOut(other, "push", "-q", "origin", "main");
      gitOut(other, "fetch", "-q", "origin", "develop");
      gitOut(other, "checkout", "-q", "-B", "develop", "origin/develop");
      writeFileSync(join(other, "d2.txt"), "d2\n");
      gitOut(other, "add", "d2.txt");
      gitOut(other, "commit", "-q", "-m", "d2");
      gitOut(other, "push", "-q", "origin", "develop");
      const remoteMain = gitOut(r.remote, "rev-parse", "refs/heads/main");
      const remoteDevelop = gitOut(r.remote, "rev-parse", "refs/heads/develop");
      const before = [gitOut(r.dir, "rev-parse", "refs/remotes/origin/main") === remoteMain, gitOut(r.dir, "rev-parse", "refs/remotes/origin/develop") === remoteDevelop];
      const x = brwRun(r.dir, ["pr-template"]);
      // 案内の fetch コマンドを取り出し、シェルを介さず実行する
      const cmd = /`(git fetch [^`]+)`/.exec(x.out)?.[1] ?? "";
      let ran = true;
      try { gitOut(r.dir, ...cmd.split(" ").slice(1)); } catch { ran = false; }
      const after = [gitOut(r.dir, "rev-parse", "refs/remotes/origin/main") === remoteMain, gitOut(r.dir, "rev-parse", "refs/remotes/origin/develop") === remoteDevelop];
      eq("brw-pr-handoff/7.4 限定された fetch 設定でも、案内どおりの fetch の後に refs/remotes/origin/main・develop が最新になる（実 git）", [before, ran, after], [[false, false], true, [true, true]]);
    } finally { r.cleanup(); }
  }
  eq("brw-pr-handoff/6.2 記入指示にも雛形にも、特定の呼び出し側の語を含めない", [CALLER.test(ins), CALLER.test(instruction({ bodyPath: path, base: "develop", language: "en" })), CALLER.test(resolveTemplate(d, "ja").text), CALLER.test(resolveTemplate(d, "en").text)], [false, false, false, false]);
  eq("brw-pr-handoff/3.7 英語の記入指示も同じ要素を含む", (() => { const e = instruction({ bodyPath: path, base: "develop", language: "en" }); return [e.includes(path), e.includes("git log develop..HEAD"), e.includes(`brw pr --body-file ${path}`)]; })(), [true, true, true]);
};
