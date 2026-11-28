// 作業場所の配置先（brw-branch-gate の placement）。配置先・旧置き場の決定と、worktree のルートの所属（4 値）を 1 か所に持つ。
// 配置先は <本体>/.worktree/<別名>。旧置き場は <本体>/.claude/worktrees/ の直下（名前が .brw のものを除く）。
// 判定は「worktree のルートを実体のパスにし、その親ディレクトリが配置先・旧置き場に等しいか」の一致だけで行う（research.md の D6）。
// 副作用を持たない（ファイル・git を変えない）。Node 標準ライブラリと lib.mjs の aliasOf だけを使う。
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { aliasOf } from "./lib.mjs";

const PLACEMENT_DIR = ".worktree";
const LEGACY_DIR = join(".claude", "worktrees");
const BRW_DIR = ".brw";

/** 配置先のディレクトリ（`<main>/.worktree`）。main は本体の作業ツリーの絶対パス */
export function placementRoot(main) {
  return join(main, PLACEMENT_DIR);
}

/** ブランチの worktree の配置先（`<main>/.worktree/<別名>`。別名は aliasOf の規則） */
export function placementOf(main, branch) {
  return join(placementRoot(main), aliasOf(branch));
}

/** 未追跡の一覧から除く前方一致の文字列（`.worktree/`） */
export function placementPrefix() {
  return `${PLACEMENT_DIR}/`;
}

/** 生の入力に `..` の区切りがあるか（`/` と `\` で区切った要素が `..` か）。文字列でなければ真（安全側）。呼び出し側は正規化の前に使う */
export function hasParentSegment(raw) {
  if (typeof raw !== "string") return true;
  return raw.split(/[\\/]/).some((s) => s === "..");
}

// パス自身の状態。"absent"（無い）・"link"（シンボリックリンク）・"entry"（ファイルかディレクトリ）・"error"（判定できない）
const kindOf = (p) => {
  try {
    return lstatSync(p).isSymbolicLink() ? "link" : "entry";
  } catch (e) {
    return e?.code === "ENOENT" ? "absent" : "error";
  }
};

// 対象の実体のパス。存在する最も深い祖先を realpath で解決し、残りの名前を足す。解決できないときは null
const canonOrNull = (p) => {
  let cur = resolve(p);
  const rest = [];
  for (;;) {
    const kind = kindOf(cur);
    if (kind === "error") return null;
    if (kind !== "absent") break;
    const parent = dirname(cur);
    if (parent === cur) return null;
    rest.unshift(basename(cur));
    cur = parent;
  }
  try {
    return join(realpathSync(cur), ...rest);
  } catch {
    return null;
  }
};

/**
 * worktree のルートの所属を 4 値で返す。
 * - "placement": 配置先（`<本体の実体>/.worktree/<名前>`）
 * - "legacy": 旧置き場（`<本体の実体>/.claude/worktrees/<名前>`。名前が `.brw` でない）
 * - "other": 配置先でも旧置き場でもないと確認できた（内部のパス・配置先そのもの・名前の前方一致・`.brw` など）
 * - "unknown": 判定できない。呼び出し側は必ず止める（許可・再利用・削除に使わない）
 */
export function placementZone(main, target) {
  // 1) 入力の検査: 絶対パスの文字列で、生の `..` を含まない
  if (typeof main !== "string" || typeof target !== "string") return "unknown";
  if (!isAbsolute(main) || !isAbsolute(target)) return "unknown";
  if (hasParentSegment(main) || hasParentSegment(target)) return "unknown";

  // 本体の実体（存在しなければ判定できない）
  let mainReal;
  try {
    mainReal = realpathSync(main);
  } catch {
    return "unknown";
  }

  // 2) 配置先・その親・旧置き場のいずれかがシンボリックリンク（または状態を判定できない）なら、対象によらず判定不能
  const guarded = [PLACEMENT_DIR, ".claude", LEGACY_DIR].map((rel) => join(mainReal, rel));
  if (!guarded.every((p) => ["absent", "entry"].includes(kindOf(p)))) return "unknown";

  // 3) 対象の実体のパス
  const real = canonOrNull(target);
  if (real === null) return "unknown";

  // 4) 親ディレクトリの一致
  const parent = dirname(real);
  if (parent === join(mainReal, PLACEMENT_DIR)) return "placement";
  if (parent === join(mainReal, LEGACY_DIR) && basename(real) !== BRW_DIR) return "legacy";
  return "other";
}

/** `placementZone(main, target) === "placement"`。判定不能・対象外は偽 */
export function isUnderPlacement(main, target) {
  return placementZone(main, target) === "placement";
}

/** `placementZone(main, target) === "legacy"`。判定不能・対象外は偽。偽を「許可してよい」の意味に使わない（`unknown` を区別するなら `placementZone` を使う） */
export function isLegacyPlacement(main, target) {
  return placementZone(main, target) === "legacy";
}
