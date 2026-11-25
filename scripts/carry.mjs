#!/usr/bin/env node
// 未コミットの変更を新しい worktree へ移す処理（brw-branch-gate の `brw create --carry`）。
// 追跡済みファイルの変更だけを移し、未追跡のファイルは移さず一覧で返す。
// 方式: ① `git stash create` で変更を表すコミット S を作る（退避の置き場 refs/stash は使わない）
//       ② 新しい worktree に `git stash apply S` で適用し、S と内容（削除・実行権限を含む）が一致することを確かめる
//       ③ 復旧用の参照 refs/brw/carry/<ブランチ> を S に向けてから、元の作業ツリーの「S と同じ内容のパス」だけを HEAD の状態へ戻す
// 元の作業ツリーに触れるのは③だけ。①②の失敗では元は変わらない。作った worktree とブランチの後始末は呼び出し側（brw create）が行う。
// 外部依存なし（Node 標準ライブラリのみ）。
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const CARRY_REF_PREFIX = "refs/brw/carry/";
const ZERO = /^0+$/;
const CHUNK = 100;

// git を実行する。trim しない（-z の出力を壊さない）。失敗は ok: false
function run(cwd, args, extra = {}) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...extra });
  return { ok: !r.error && r.status === 0, out: r.stdout ?? "", err: r.stderr ?? "" };
}
const lit = (p) => `:(literal)${p}`; // パスをパターンとして解釈させない
const nulList = (s) => s.split("\0").filter((x) => x !== "");

/** 復旧用の参照の名前（利用者に案内する値）。 */
export const carryRefOf = (branch) => `${CARRY_REF_PREFIX}${branch}`;

/**
 * 元の作業ツリーの追跡済みファイルの未コミットの変更を、新しい worktree へ移す。
 * @param {object} opts
 * @param {string} opts.source 元の作業ツリー
 * @param {string} opts.worktree 新しい worktree（開始点のコミットをチェックアウト済み）
 * @param {string} opts.startOid brw create が決めた開始点のコミット
 * @param {string} opts.branch 新しいブランチ（復旧用の参照の名前に使う）
 * @param {string[]} [opts.exclude] 移さなかったファイルの一覧から除くパス（呼び出し側が別に扱ったもの。例: 宣言ファイル）
 * @param {{beforeRemove?: () => void}} [opts.hooks] 試験用。元から取り除く直前に呼ばれる
 * @returns {{kind: "none", skipped: string[]}
 *   | {kind: "carried", files: string[], skipped: string[], recoveryRef: string}
 *   | {kind: "keptBoth", files: string[], removed: string[], kept: string[], skipped: string[], recoveryRef: string}
 *   | {kind: "failed", reason: string}}
 */
export function carryChanges({ source, worktree, startOid, branch, exclude = [], hooks = {} }) {
  const fail = (reason) => ({ kind: "failed", reason });
  const oidOf = (cwd, rev) => { const r = run(cwd, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]); return r.ok ? r.out.trim() : null; };

  // 前提: 開始点・元の HEAD・新しい worktree の HEAD が同じコミットであること（違うと適用が混ざる）
  const head = oidOf(source, "HEAD");
  const start = oidOf(source, startOid);
  const wtHead = oidOf(worktree, "HEAD");
  if (!head || !start || !wtHead) return fail("開始点・元の HEAD・新しい worktree の HEAD のどれかを確認できません。");
  if (head !== start) return fail(`開始点（${start.slice(0, 12)}）が元の作業ツリーの HEAD（${head.slice(0, 12)}）と異なります。変更を移すと内容が混ざるため、移しません。`);
  if (wtHead !== start) return fail("新しい worktree の HEAD が開始点と異なるため、移しません。");
  if (run(source, ["ls-files", "-u"]).out.trim() !== "") return fail("解決していない競合があるため、変更を移せません。");

  // 移さない未追跡のファイル（無視されるファイルは対象外）
  const skipped = nulList(run(source, ["ls-files", "-z", "--others", "--exclude-standard"]).out).filter((p) => !exclude.includes(p));

  // ① 変更を表すコミット S（退避の置き場には記録されない）。出力が空なら移す変更は無い
  const created = run(source, ["stash", "create"]);
  if (!created.ok) return fail(`変更の退避コミットを作れませんでした: ${created.err.trim() || "不明なエラー"}`);
  const S = created.out.trim();
  if (S === "") return { kind: "none", skipped };

  // 変更されたパスの一覧: HEAD と、S の作業ツリー側（S）・インデックス側（S^2）のどちらかが違うパス
  // （ステージ済みの内容が HEAD と違うのに、未ステージの編集で作業ファイルが HEAD に戻ったパスも対象にする）
  const I = `${S}^2`;
  const raw = (tree) => {
    const d = run(source, ["diff-tree", "-r", "--raw", "-z", "--no-renames", "--no-abbrev", head, tree]);
    if (!d.ok) return null;
    const out = [];
    const t = d.out.split("\0");
    for (let i = 0; i + 1 < t.length; i += 2) {
      const m = /^:(\d+) (\d+) /.exec(t[i]);
      if (m) out.push({ path: t[i + 1], modes: [m[1], m[2]] });
    }
    return out;
  };
  const wtDiff = raw(S);
  const idxDiff = raw(I);
  if (wtDiff === null || idxDiff === null) return fail("変更の一覧を読めませんでした。");
  if ([...wtDiff, ...idxDiff].some((e) => e.modes.includes("160000"))) return fail("サブモジュールの変更は移せません。");
  const files = [...new Set([...wtDiff, ...idxDiff].map((e) => e.path))];
  if (files.length === 0) return { kind: "none", skipped };
  // S の作業ツリー側に無いパスは、削除された変更
  const entries = files.map((path) => ({ path, deleted: !run(source, ["cat-file", "-e", `${S}:${path}`]).ok }));

  // ② 新しい worktree に適用（インデックスも再現する。競合・失敗なら失敗。元には触れていない）
  const applied = run(worktree, ["stash", "apply", "--index", S]);
  if (!applied.ok) return fail(`新しい worktree へ変更を適用できませんでした: ${(applied.err || applied.out).trim().split("\n")[0] || "不明なエラー"}`);

  // 照合: 適用後の作業ツリーが S、インデックスが S^2 と一致する（削除されたパスは存在しない）。stat の古さによる誤検知を避けるため先に更新する
  run(worktree, ["update-index", "-q", "--refresh"]);
  const mismatched = [];
  for (const e of entries) if (e.deleted && existsSync(join(worktree, e.path))) mismatched.push(e.path);
  // 作業ツリーは S と、インデックスは S^2 と比べる（内容で比べる git diff。diff-index は内容が同じでも差を出すことがある）
  const differs = (cwd, cached, tree, paths) => {
    const d = run(cwd, ["diff", ...(cached ? ["--cached"] : []), "--raw", "-z", "--no-renames", "--no-ext-diff", tree, "--", ...paths.map(lit)]);
    if (!d.ok) return null;
    const out = [];
    const t = d.out.split("\0");
    for (let k = 0; k + 1 < t.length; k += 2) if (t[k].startsWith(":")) out.push(t[k + 1]);
    return out;
  };
  for (let i = 0; i < files.length; i += CHUNK) {
    const part = files.slice(i, i + CHUNK);
    const w = differs(worktree, false, S, part);
    const x = differs(worktree, true, I, part);
    if (w === null || x === null) return fail("適用結果を照合できませんでした。");
    mismatched.push(...w, ...x);
  }
  if (mismatched.length > 0) return fail(`適用した内容が元の変更と一致しません（${[...new Set(mismatched)].slice(0, 5).join(", ")}）。移しません。`);

  // ③ 取り除き。進む前に、移した内容を指す復旧用の参照を作る（既に同名があれば、それを失わないよう止まる）
  const recoveryRef = carryRefOf(branch);
  const ref = run(source, ["update-ref", recoveryRef, S, ""]);
  if (!ref.ok) return fail(`復旧用の参照 ${recoveryRef} を作れませんでした（既に残っていれば、内容を確認して削除してください）。`);
  hooks.beforeRemove?.();
  run(source, ["update-index", "-q", "--refresh"]);
  const removed = [];
  const kept = [];
  for (const e of entries) {
    // 元の現在の内容が、移した内容（S）と同じパスだけを戻す
    // 作業ツリーが S、インデックスが S^2 と同じときだけ戻す（インデックスだけが変わっていても、その内容を失わない）
    const w = differs(source, false, S, [e.path]);
    const x = differs(source, true, I, [e.path]);
    const same = w !== null && x !== null && w.length === 0 && x.length === 0 && (!e.deleted || !existsSync(join(source, e.path)));
    if (!same) { kept.push(e.path); continue; }
    const inHead = run(source, ["cat-file", "-e", `${head}:${e.path}`]).ok;
    const back = inHead
      ? run(source, ["restore", "--staged", "--worktree", "--source=HEAD", "--", lit(e.path)])
      : run(source, ["rm", "-f", "-q", "--", lit(e.path)]); // HEAD に無い（新規追加）パスは、インデックスと作業ツリーから外す
    if (back.ok) removed.push(e.path);
    else kept.push(e.path);
  }
  if (kept.length === 0) return { kind: "carried", files, skipped, recoveryRef };
  return { kind: "keptBoth", files, removed, kept, skipped, recoveryRef };
}
