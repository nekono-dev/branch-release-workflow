// 作業場所の配置先（brw-branch-gate の placement）。配置先・旧置き場の決定と、配下の判定を 1 か所に持つ。
// 配置先は <本体>/.worktree/<別名>。旧置き場は <本体>/.claude/worktrees/ の配下（`.brw/` は PR 本文の置き場で worktree ではないため含めない）。
// 副作用を持たない（ファイル・git を変えない）。Node 標準ライブラリと lib.mjs の aliasOf だけを使う。
// 判定は実体のパス（realpath）で行う。配置先・旧置き場のディレクトリが本体の外を指すシンボリックリンクのときは、配下と認めない。
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { aliasOf } from "./lib.mjs";

const PLACEMENT_DIR = ".worktree";
const LEGACY_DIR = join(".claude", "worktrees");
const BRW_DIR = ".brw";

// パス自身（シンボリックリンクを含む）が存在するか。存在しない・壊れたリンクでも、名前があれば true
const present = (p) => {
  try { lstatSync(p); return true; } catch { return false; }
};

// 実体のパスを返す。存在する最も深い祖先を realpath で解決し、残りは文字列で足す（存在しないパスは文字列で比べる）。
// 解決できないとき（壊れたシンボリックリンクなど）は null
const canonOrNull = (p) => {
  let cur = resolve(p);
  const rest = [];
  while (!present(cur)) {
    const parent = dirname(cur);
    if (parent === cur) break;
    rest.unshift(basename(cur));
    cur = parent;
  }
  try {
    return join(realpathSync(cur), ...rest);
  } catch {
    return null;
  }
};

// 本体の下の既定の置き場（rel）の実体のパスを返す。置き場の実体が本体の内側にあるときだけ返す。
// 本体の内側を指すシンボリックリンクは認め、判定は実体のパスで行う（リンク名では判定しない）。
// 本体の外を指すとき、本体そのものを指すとき、解決できない（壊れたリンクなど）ときは null
const soundDir = (mainReal, rel) => {
  const real = canonOrNull(join(mainReal, rel));
  if (real === null || segmentsUnder(mainReal, real) === null) return null;
  return real;
};

// base の下にある target の、base からの相対の区切り（セグメント）。配下でないとき null
const segmentsUnder = (base, target) => {
  const rel = relative(base, target);
  if (rel === "" || isAbsolute(rel) || rel.split(sep)[0] === "..") return null;
  return rel.split(sep);
};

// 配置先・旧置き場の両方について、target の所属を 1 回で求める。両方が真になることは無い。
// 実体が旧置き場の領域（旧置き場の実体のディレクトリの配下。`.brw/` の下も含む）にあれば、旧置き場の判定を優先する。
// 配置先と旧置き場の実体が重なる場合は、配置先とは認めず、安全側（旧置き場として扱う）に倒す。
const judge = (main, target) => {
  const none = { placement: false, legacy: false };
  if (typeof main !== "string" || !isAbsolute(main) || typeof target !== "string" || !isAbsolute(target)) return none;
  const mainReal = canonOrNull(main);
  const targetReal = canonOrNull(target);
  if (mainReal === null || targetReal === null) return none;

  const placementBase = soundDir(mainReal, PLACEMENT_DIR);
  const legacyBase = soundDir(mainReal, LEGACY_DIR);
  const inPlacement = placementBase !== null && segmentsUnder(placementBase, targetReal) !== null;
  const legacySegments = legacyBase !== null ? segmentsUnder(legacyBase, targetReal) : null;
  // 旧置き場の領域（`.brw/` の下も含む）の中か
  const inLegacyRegion = legacySegments !== null;
  return {
    placement: inPlacement && !inLegacyRegion,
    legacy: inLegacyRegion && legacySegments[0] !== BRW_DIR,
  };
};

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

/** target が配置先の配下か（配置先ディレクトリそのものは含めない）。相対パスは配下と認めない */
export function isUnderPlacement(main, target) {
  return judge(main, target).placement;
}

/** target が旧置き場（`<main>/.claude/worktrees/` の配下）の worktree か。`.brw/` の下は含めない */
export function isLegacyPlacement(main, target) {
  return judge(main, target).legacy;
}
