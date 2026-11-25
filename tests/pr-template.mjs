// PR 本文の雛形・記入指示・本文ファイル（pr-template）の試験。selftest.mjs から呼ばれる。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bodyPathOf, buildTemplate, instruction, prepareBody, resolveTemplate, UNFILLED_MARK } from "../scripts/pr-template.mjs";
import { TIDY_SUBJECT } from "../scripts/tidy.mjs";

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
  eq("brw-pr-handoff/6.2 記入指示にも雛形にも、特定の呼び出し側の語を含めない", [CALLER.test(ins), CALLER.test(instruction({ bodyPath: path, base: "develop", language: "en" })), CALLER.test(resolveTemplate(d, "ja").text), CALLER.test(resolveTemplate(d, "en").text)], [false, false, false, false]);
  eq("brw-pr-handoff/3.7 英語の記入指示も同じ要素を含む", (() => { const e = instruction({ bodyPath: path, base: "develop", language: "en" }); return [e.includes(path), e.includes("git log develop..HEAD"), e.includes(`brw pr --body-file ${path}`)]; })(), [true, true, true]);
};
