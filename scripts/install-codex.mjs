#!/usr/bin/env node
// Git clone を Codex の skill 探索先へリンクする。既存の別の導入先は上書きしない。
import { lstatSync, mkdirSync, readlinkSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.length && (args[0] !== "--skills-dir" || args.length !== 2)) {
  console.error("使い方: node scripts/install-codex.mjs [--skills-dir <探索先>]");
  process.exit(2);
}
const skills = resolve(args[1] ?? join(homedir(), ".agents/skills"));
mkdirSync(skills, { recursive: true });
const target = join(skills, "branch-release-workflow");
let existing;
try { existing = lstatSync(target); } catch (error) { if (error.code !== "ENOENT") throw error; }
if (existing) {
  if (!existing.isSymbolicLink() || resolve(skills, readlinkSync(target)) !== root) {
    console.error(`既存の導入先を保持しました: ${target}。削除または移行してから再実行してください。`);
    process.exit(1);
  }
} else symlinkSync(root, target, "dir");
console.log(`Codex skill: ${target} -> ${root}`);
