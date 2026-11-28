// 手順書・評価・配布の版の、本文置き場の記述（brw-pr-handoff 10.2）の試験。selftest.mjs から呼ばれる。
// 本文置き場は <本体>/.worktree/.brw/。旧置き場（.claude/worktrees/.brw/）への言及は、拒否・移し方の説明の行に限る。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// 旧置き場の本文置き場の形（区切りの違い `/` と `\` の両方を見る）
const LEGACY_BODY = /claude[\\/]worktrees[\\/]\.brw/;
// 旧置き場の言及を許す行の目印（拒否・移し方・旧置き場の説明）
const LEGACY_NOTE = /旧置き場|旧い|拒否|移し|mv /;

/** 手順書・評価・試験の説明に当たる Markdown と YAML の一覧（相対パス） */
const targets = () => {
  const out = [];
  const walk = (rel) => {
    for (const name of readdirSync(join(ROOT, rel))) {
      const p = join(rel, name);
      if (statSync(join(ROOT, p)).isDirectory()) walk(p);
      else if (/\.(md|yaml)$/.test(name)) out.push(p);
    }
  };
  for (const rel of ["SKILL.md", "README.md", "references", "tests/real-env", "evals"]) {
    const abs = join(ROOT, rel);
    if (!existsDir(abs) && !existsFile(abs)) continue;
    if (statSync(abs).isDirectory()) walk(rel);
    else out.push(rel);
  }
  return out;
};
const existsFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
const existsDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

export const runBodyDocsChecks = async (eq) => {
  // 1. 手順書・評価・試験の説明の旧置き場の言及は、拒否・移し方の説明の行に限る（要件 3.9・3.11）
  const hits = [];
  for (const f of targets()) {
    readFileSync(join(ROOT, f), "utf8").split("\n").forEach((line, i) => {
      if (LEGACY_BODY.test(line) && !LEGACY_NOTE.test(line)) hits.push(`${f}:${i + 1}`);
    });
  }
  eq("brw-pr-handoff/3.9 手順書・評価の本文置き場の記述は .worktree/.brw/ に合わせ、旧置き場（.claude/worktrees/.brw/）は拒否・移し方の説明に限る", hits, []);

  // 2. SKILL.md は新しい本文置き場を案内する（要件 3.9・3.11）
  const skill = readFileSync(join(ROOT, "SKILL.md"), "utf8");
  eq("brw-pr-handoff/3.11 SKILL.md は本文置き場を <本体>/.worktree/.brw/ として案内する", [skill.includes("<本体>/.worktree/.brw/"), skill.includes("<本体>/.claude/worktrees/.brw/<ブランチ名")], [true, false]);

  // 3. 旧置き場の本文は拒否し、案内に mv と新置き場を示す（試験の本体は tests/base-pr.mjs の旧置き場のケース）。ここでは版だけを確かめる
  const plugin = JSON.parse(readFileSync(join(ROOT, ".claude-plugin", "plugin.json"), "utf8"));
  eq("brw-pr-handoff/3.12 配布の版を 1.5.0 に上げる（本文置き場の移動を含む配布）", plugin.version, "1.5.0");
};
