// 作業場所の配置先（brw-branch-gate の placement）。配置先・旧置き場の決定と、worktree のルートの所属（4 値）を 1 か所に持つ。
// 配置先は <本体>/.worktree/<別名>。旧置き場は <本体>/.claude/worktrees/ の直下（名前が .brw のものを除く）。
// 判定は「worktree のルートを実体のパスにし、その親ディレクトリが配置先・旧置き場に等しいか」の一致だけで行う（research.md の D6）。
// 副作用を持たない（ファイル・git を変えない）。Node 標準ライブラリと lib.mjs の aliasOf だけを使う。
import { spawnSync } from "node:child_process";
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

// シェルの 1 語として安全に渡す形にする。安全な文字だけなら無引用、それ以外は単引用符で囲み、内側の ' は '\'' にする
const shQuote = (s) => /^[A-Za-z0-9_/.:=@+,-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;

/**
 * 旧置き場の worktree を配置先へ移す手順の案内。BRW は自動で移さない（worktree・ブランチ・変更に触れない）。
 * next は実行できるコマンドの列（最後の 1 行だけ、移せないときの代替の説明）。
 */
export function legacyMoveGuidance(main, branch, oldPath) {
  const newPath = placementOf(main, branch);
  const o = shQuote(oldPath);
  const n = shQuote(newPath);
  const b = shQuote(branch);
  return {
    reason: `作業ブランチ ${branch} の worktree は旧置き場 ${oldPath} にあり、BRW の配置先（${newPath}）ではないため扱えません。BRW は worktree・ブランチ・変更に触れず、自動で移しません。次の手順で移してから、もう一度実行してください。ロックされているときだけ 1) を行います。未コミットの変更・未追跡のファイルは 2) の移動でそのまま移ります。`,
    next: [
      `git worktree unlock ${o}`,
      `git worktree move ${o} ${n}`,
      `brw resume ${b}`,
      `移せないとき（サブモジュールを持つ worktree など）は、未コミットの変更を commit か退避してから git worktree remove ${o} で片付け（変更が残っていると拒否されます。サブモジュールがあるときは --force が要るため、変更を失わないことを確かめてから）、brw resume ${b} で新しい配置先に作り直してください。`,
    ],
  };
}

/**
 * `brw finish` で、旧置き場の worktree を片付けられないときの案内。BRW は worktree・ブランチ・変更に触れない。
 * 進め方は 2 つ: 1) 配置先へ移してから `brw finish` をもう一度実行する、2) 変更が無いことを確かめてから手動で片付ける。
 * next は実行できるコマンドの列（1 行ごとに 1 つの操作）。
 */
export function legacyFinishGuidance(main, branch, oldPath) {
  const newPath = placementOf(main, branch);
  const o = shQuote(oldPath);
  const n = shQuote(newPath);
  const b = shQuote(branch);
  return {
    reason: `作業ブランチ ${branch} の worktree は旧置き場 ${oldPath} にあるため BRW は片付けません（ブランチも消しません）。BRW の配置先は ${newPath} です。BRW は worktree・ブランチ・変更に触れません。`,
    next: [
      `1) 移してから片付ける: ロックされているときは先に git worktree unlock ${o}、次に git worktree move ${o} ${n}、最後にもう一度 brw finish ${b} を実行してください。`,
      `2) 手動で片付ける: 未コミットの変更が無いことを確かめてから git worktree remove ${o} を実行し、取り込み済みなら git branch -d ${b} でブランチも消してください。`,
    ],
  };
}

/**
 * 配置先のディレクトリ全体が無視されているか。存在しない固定の子 `.worktree/.brw-probe` への git check-ignore の終了コードで判定する。
 * 0 → ignored、1 → not-ignored、それ以外（git の外・失敗など）→ unknown。ファイル・設定は書かない（git を読むだけ）。
 */
export function ignoreStatus(main) {
  const r = spawnSync("git", ["check-ignore", "-q", "--", `${PLACEMENT_DIR}/.brw-probe`], { cwd: main, stdio: "ignore" });
  if (r.error) return "unknown";
  if (r.status === 0) return "ignored";
  if (r.status === 1) return "not-ignored";
  return "unknown";
}

/** 配置先が無視されていないときの警告文（2 行）。導入先の設定は BRW が書き換えない旨を含む */
export function ignoreWarning() {
  return [
    "`.worktree/` が導入先で無視されていません。本体の作業ツリーで `git add -A` などを実行すると、worktree が埋め込みリポジトリとして誤って追加されます。",
    "`.worktree/` を無視する設定（`.gitignore` への `/.worktree/` の追記など）を導入先に追加してください。BRW はこの設定を書き換えません。",
  ];
}
