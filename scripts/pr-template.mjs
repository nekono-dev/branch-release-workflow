#!/usr/bin/env node
// PR 本文の雛形・記入指示・本文ファイルの置き場所（brw-pr-handoff）。本文の記入そのものは行わない（書き手はエージェント）。
// 雛形はリポジトリの .github/PULL_REQUEST_TEMPLATE.md を優先し、無ければ同梱の言語別の雛形を使う。
// 本文ファイルは本体の worktree 置き場の配下（作業ツリーの外）に置く。外部依存なし。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { aliasOf } from "./lib.mjs";
import { TIDY_SUBJECT } from "./tidy.mjs";

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");
/** 書き終えていない本文の印。これが残る本文は未記入として、雛形で作り直してよい */
export const UNFILLED_MARK = "<!-- brw:unfilled";
const SECTIONS = {
  overview: { ja: "概要", en: "Summary", alias: ["概要", "summary", "overview"] },
  changes: { ja: "変更内容", en: "Changes", alias: ["変更内容", "changes", "what changed"] },
  verification: { ja: "検証", en: "Verification", alias: ["検証", "verification", "testing", "test plan"] },
  outOfScope: { ja: "作業外の変更", en: "Out-of-scope changes", alias: ["作業外の変更", "out-of-scope changes", "out of scope"] },
};

/** 雛形を決める。リポジトリの雛形が優先。 */
export function resolveTemplate(worktree, language) {
  const repoFile = join(worktree, ".github", "PULL_REQUEST_TEMPLATE.md");
  if (existsSync(repoFile)) return { source: "repo", text: readFileSync(repoFile, "utf8") };
  const lang = language === "en" ? "en" : "ja";
  return { source: "builtin", text: readFileSync(join(ASSETS, `pr-template.${lang}.md`), "utf8") };
}

/** 本文ファイルの場所: <本体>/.claude/worktrees/.brw/<alias>.md（作業ツリーの外） */
export const bodyPathOf = (mainPath, branch) => join(mainPath, ".claude", "worktrees", ".brw", `${aliasOf(branch)}.md`);

const headingRe = (sec) => new RegExp(`^(#{1,6})[ \\t]*(?:${sec.alias.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})[ \\t]*$`, "im");

/** 節の見出しの直後に内容を差し込む。見出しが無ければ末尾に節ごと追記する。 */
export function insertSection(text, sec, language, content) {
  const m = headingRe(sec).exec(text);
  if (!m) return `${text.replace(/\s*$/, "")}\n\n## ${sec[language === "en" ? "en" : "ja"]}\n\n${content}\n`;
  const at = m.index + m[0].length;
  return `${text.slice(0, at)}\n\n${content}${text.slice(at)}`;
}

// ブランチ内の、既に別コミットになっている作業外の変更のファイル一覧
function tidiedFilesOf(worktree, base) {
  const range = base && spawnSync("git", ["rev-parse", "--verify", "--quiet", base], { cwd: worktree }).status === 0 ? [`${base}..HEAD`] : ["-50", "HEAD"];
  const log = spawnSync("git", ["log", "--format=%H%x00%s", ...range], { cwd: worktree, encoding: "utf8" });
  if (log.status !== 0) return [];
  const files = [];
  for (const line of log.stdout.split("\n")) {
    const [oid, subject] = line.split("\0");
    if (subject !== TIDY_SUBJECT) continue;
    const show = spawnSync("git", ["show", "--name-only", "--format=", oid], { cwd: worktree, encoding: "utf8" });
    if (show.status === 0) files.push(...show.stdout.split("\n").filter(Boolean));
  }
  return [...new Set(files)];
}

/**
 * 雛形に作業外の変更と検証を差し込んだ本文を作る。
 * @param {{worktree: string, language?: "ja"|"en", base?: string, planned?: string[], verification?: string|null, failed?: boolean}} ctx
 *   planned は、これから別コミットになる予定のファイル（previewTidy の結果）。verification は検証の要約、failed は検証未通過。
 */
export function buildTemplate(ctx) {
  const language = ctx.language === "en" ? "en" : "ja";
  let { text, source } = resolveTemplate(ctx.worktree, language);
  if (source === "repo" && !text.includes(UNFILLED_MARK)) text = `${UNFILLED_MARK} この行は、本文を書き終えたら削除する -->\n${text}`;
  // 節の無い雛形への追記の順が、検証 → 作業外の変更になるよう、検証を先に差し込む
  if (ctx.verification || ctx.failed) {
    const head = ctx.failed ? (language === "en" ? "**Verification did not pass.**" : "**検証未通過。**") : "";
    text = insertSection(text, SECTIONS.verification, language, [head, ctx.verification ?? ""].filter(Boolean).join("\n\n"));
  }
  const files = [...new Set([...(ctx.planned ?? []), ...tidiedFilesOf(ctx.worktree, ctx.base)])];
  const tidy = files.length > 0 ? files.map((f) => `- ${f}`).join("\n") : (language === "en" ? "none" : "なし");
  text = insertSection(text, SECTIONS.outOfScope, language, language === "en" ? `Files in the separate commit:\n${tidy}` : `別コミットに含めたファイル:\n${tidy}`);
  return text;
}

/** 自己完結した短い記入指示。BRW も呼び出し側も知らない書き手に渡せる。 */
export function instruction({ bodyPath, base, language = "ja" }) {
  const b = base ?? "<取り込み先>";
  if (language === "en") {
    return [
      `Write the pull request body in this file: ${bodyPath}`,
      "- Replace each comment under a heading with the actual text. Keep the headings. Delete the first line (the \"unfilled\" marker) when finished.",
      "- Summary: why this change exists, in 1-3 sentences. Changes: what was changed and how. Verification: what was checked and the result. Out-of-scope changes: already filled in; fix it only if it is wrong.",
      "- Write only facts. Do not guess. The reader is a person who has not seen this work.",
      `- Facts to read: \`git log ${b}..HEAD\` and \`git diff --stat ${b}\`.`,
      "- When the body is written, run: brw pr --body-file " + bodyPath,
    ].join("\n");
  }
  return [
    `PR の本文を、次のファイルに書いてください: ${bodyPath}`,
    "- 見出しの下の説明（コメント）を、実際の文章に置き換える。見出しは残す。書き終えたら、先頭の行（「未記入」の印）を削除する。",
    "- 概要: 何のための変更かを 1〜3 文で。変更内容: 何をどう変えたか。検証: 何をどう確かめ、結果がどうだったか。作業外の変更: 記入済み。誤りがあるときだけ直す。",
    "- 事実だけを書く。推測しない。読み手は、この作業を見ていない人。",
    `- 事実を確かめるには \`git log ${b}..HEAD\` と \`git diff --stat ${b}\` を読む。`,
    `- 本文を書き終えたら、次を実行する: brw pr --body-file ${bodyPath}`,
  ].join("\n");
}

/**
 * 本文ファイルを用意する。ファイルが既にあれば、記入途中・記入済みを問わず上書きしない（書き手の文章を失わないため）。
 * 作り直したいときは、ファイルを消してから実行する。
 * @returns {{path: string, written: boolean, filled: boolean}} written は雛形を書いたか、filled は未記入の印が無い（書き終えた）本文があるか
 */
export function prepareBody(path, ctx) {
  if (existsSync(path)) return { path, written: false, filled: !readFileSync(path, "utf8").includes(UNFILLED_MARK) };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buildTemplate(ctx), { mode: 0o600, flag: "wx" });
  return { path, written: true, filled: false };
}
