// 実現性の確認のフックの入口（UserPromptSubmit）。標準入力の JSON・記録・git を扱い、判定は feasibility-gate-rules.mjs に任せる。
// 失敗（入力の JSON の不正・予期しない例外）は標準エラーに日本語で 1 行書き、出力せず終了コード 0 で通す（作業を止めない）。
// 記録が読めないことは失敗ではなく停止の条件として扱い、標準エラーには書かない。状態は持たない（何も書かない）。
import { spawnSync } from "node:child_process";
import { promises as fs, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyPrompt, decideInput, parseRecord, parseWorktreeListPorcelain, parseWorktreeListZ } from "./feasibility-gate-rules.mjs";
import { stopOutput } from "./stop-notice-rules.mjs";

// 配置先は .agent-hooks/cc-sdd-bootstrap/ なので、2 つ上が導入先の根
const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const GIT_TIMEOUT_MS = 3000;
/** 記録の上限。これを超える記録は読まず、読めないものとして止める側に倒す */
const RECORD_MAX_BYTES = 1024 * 1024;
const RECORD_NAME = "feasibility.md";
const SPECS_DIR = path.join(".kiro", "specs");

/** 引数（イベントと作業ツール）を検査する。想定外は失敗にする（通す） */
function checkArguments(argv) {
  const toolIndex = argv.indexOf("--tool");
  const tool = toolIndex >= 0 ? argv[toolIndex + 1] : null;
  if (argv[0] !== "user-prompt-submit") throw new Error("フックの種類を判定できません。");
  if (tool !== "claude" && tool !== "codex") throw new Error("作業ツールを判定できません。");
}

/** 標準入力の JSON を読む。JSON が不正・オブジェクトでなければ失敗にする */
async function readInput() {
  let raw = "";
  for await (const part of process.stdin) raw += part;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("入力の JSON を読み取れません。");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("入力の JSON を読み取れません。");
  return value;
}

/**
 * 入力の cwd の git の根。cwd が無い・存在しない・ディレクトリでない・git の外（git が失敗・timeout）は null。
 * 引数の配列で起動し、シェルは経由しない。
 */
function gitRootOf(cwd) {
  if (cwd === null || cwd === "") return null;
  try {
    if (!statSync(cwd).isDirectory()) return null;
  } catch {
    return null;
  }
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS });
  if (result.error || result.status !== 0) return null;
  const top = result.stdout.trim();
  return top === "" ? null : top;
}

/** spec を探す根の候補の上限。極端に多い worktree で遅くならないよう、先頭からこの個数まで */
const MAX_CANDIDATES = 20;

/**
 * git worktree list --porcelain の worktree の根を返す。起動は引数の配列（シェルなし）、timeout は 3 秒。
 * 失敗・git の外・出力の形が不正なら空。bare と prunable の印があるものは外す。
 * 存在しないパスは、呼び出し側（uniqueRoots）で外す。
 * @param {string} start - 一覧を求める場所（git の根、または無ければスクリプトの根）
 * @returns {string[]}
 */
function worktreeRootsOf(start) {
  // まず -z（NUL 区切りの生のパス。git 2.36 以上）を使う。使えない git なら、引用を外せない porcelain に切り替える
  const z = spawnSync("git", ["worktree", "list", "--porcelain", "-z"], { cwd: start, encoding: "utf8", timeout: GIT_TIMEOUT_MS });
  if (!z.error && z.status === 0) return parseWorktreeListZ(z.stdout);
  const plain = spawnSync("git", ["worktree", "list", "--porcelain"], { cwd: start, encoding: "utf8", timeout: GIT_TIMEOUT_MS });
  if (plain.error || plain.status !== 0) return [];
  return parseWorktreeListPorcelain(plain.stdout);
}

/**
 * 候補の根を、存在するディレクトリだけにし、実体のパスが同じものは先頭のものだけ残す。
 * 並びは先頭（優先）から保つ。null・空・存在しないものは除く。
 * @param {Array<string | null>} roots
 * @returns {string[]}
 */
function uniqueRoots(roots) {
  const seen = new Set();
  const result = [];
  for (const root of roots) {
    if (typeof root !== "string" || root === "") continue;
    let real;
    try {
      if (!statSync(root).isDirectory()) continue;
      real = realpathSync(root);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    result.push(root);
  }
  return result;
}

/**
 * spec を探す根の候補（優先順）。
 * ① 入力の cwd の git の根 ② スクリプトの位置の根 ③ git worktree list の各 worktree の根。
 * ③ の一覧は ① の根で実行し、① が無ければ ② の根で実行する。重複（実体が同じ）は先頭だけ残し、先頭 20 個まで。
 * @returns {string[]}
 */
function candidateRoots(cwd) {
  const top = gitRootOf(cwd);
  const worktrees = worktreeRootsOf(top ?? scriptRoot);
  return uniqueRoots([top, scriptRoot, ...worktrees]).slice(0, MAX_CANDIDATES);
}

/**
 * spec のディレクトリを特定する。候補の根 R を順に見て、`R/.kiro/specs/<名前>/` が最初に存在するものを使う。
 * 基準は、R の実体から求めた文字列 `realRoot/.kiro/specs`（この基準自体は実体化しない）。
 * spec の実体がその基準の下（`基準 + 区切り` で始まる）にあるときだけ特定する。
 * `.kiro` や `.kiro/specs` や spec 自体が外を指すリンクなら、実体が基準の下に来ないので特定できない扱い（null）。
 * 次の候補へは進まない（外の記録を読まないための境界）。どこにも無ければ null。
 * @param {string[]} roots - 候補の根（優先順）
 * @param {string} name - spec 名（分類の規則に合うもの）
 * @returns {string | null} 実体の spec のディレクトリ（絶対パス）
 */
function locateSpec(roots, name) {
  for (const root of roots) {
    const dir = path.join(root, SPECS_DIR, name);
    let stat;
    try {
      stat = statSync(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    let realRoot;
    let realSpecDir;
    try {
      realRoot = realpathSync(root);
      realSpecDir = realpathSync(dir);
    } catch {
      return null;
    }
    const expectedSpecs = path.join(realRoot, SPECS_DIR);
    return realSpecDir.startsWith(expectedSpecs + path.sep) ? realSpecDir : null;
  }
  return null;
}

/**
 * 記録（feasibility.md）を読む。引数は実体の spec のディレクトリ（locateSpec の結果）。
 * 記録の実体が spec のディレクトリの下にあるときだけ読む（外を指すリンクは読まない）。
 * 無い・壊れたリンク・外のリンク・ディレクトリ・上限を超える場合は null（止める側）。
 * これは入口の失敗ではなく停止の条件なので、標準エラーには書かず例外にもしない。
 * @returns {Promise<ReturnType<typeof parseRecord> | null>}
 */
async function readRecord(specDir) {
  let realRecord;
  try {
    realRecord = await fs.realpath(path.join(specDir, RECORD_NAME));
  } catch {
    return null;
  }
  if (!realRecord.startsWith(specDir + path.sep)) return null;
  let stat;
  try {
    stat = await fs.stat(realRecord);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > RECORD_MAX_BYTES) return null;
  let text;
  try {
    text = await fs.readFile(realRecord, "utf8");
  } catch {
    return null;
  }
  return parseRecord(text);
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function run() {
  checkArguments(process.argv.slice(2));
  const input = await readInput();
  // 文字列でない入力は判定しない（何も出さず通す）
  if (typeof input.prompt !== "string") return;
  const command = classifyPrompt(input.prompt);
  if (command === null) return;

  const cwd = typeof input.cwd === "string" ? input.cwd : null;
  const dir = command.spec === null ? null : locateSpec(candidateRoots(cwd), command.spec);
  const record = dir === null ? null : await readRecord(dir);
  const decision = decideInput(command, dir !== null, record);
  // 止めるときは、`decision: "block"`（モデルが動かず、リモートセッションの画面に理由が出ない）ではなく、
  // 停止の案内と止める指示を追加の文脈として渡し、モデルに応答の文章を作らせる（Claude Code・Codex 共通の形）。
  // 止めないときは、段階ごとの追加の指示を文脈として渡す。
  if (decision.kind === "block") output(stopOutput({ prompt: input.prompt, reason: decision.reason }));
  if (decision.kind === "context") {
    output({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: decision.text } });
  }
}

run().catch((error) => {
  const detail = error.message || "詳細のないエラーです。";
  process.stderr.write(`feasibility-gate: フックの処理に失敗しました。詳細: ${detail}\n`);
  process.exitCode = 0;
});
