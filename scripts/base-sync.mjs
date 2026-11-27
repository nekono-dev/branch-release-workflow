// 分岐元の取り込み・保護ブランチとの差の数・PR の作成先の決定（brw-pr-handoff 7.2）。
// 作業ツリーに触るのは `git merge --ff-only` だけ。ほかの書き込みはしない。
// ブランチ名・リモート名は execFileSync・spawnSync の引数配列で渡し、シェルを介さない。`-` で始まる名前は拒否する。
// 分岐元の push 先のリモートは publish.mjs の remoteNameOf で求める（origin を固定にしない）。
// 外部依存なし（Node 標準ライブラリと既存の scripts/ のみ）。
import { spawnSync } from "node:child_process";
import { classifyBranch } from "./lib.mjs";
import { remoteNameOf, SAFE_BRANCH } from "./publish.mjs";

// リモート名の形（git の remote 名として安全な文字だけ。先頭は英数字）
const SAFE_REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
// 固定名でないパターン（保護ブランチの宣言の glob）
const GLOB = /[*?[\]]/;

/** ブランチ名を git の引数として安全に使えるか（SAFE_BRANCH で - 始まりを拒否し、範囲記法の .. を含むものも拒否する）。 */
const validName = (name) => typeof name === "string" && SAFE_BRANCH.test(name) && !name.includes("..");

/** リモートの追跡参照の完全な名前（refs/remotes/<リモート>/<ブランチ>）。 */
const remoteRef = (remote, name) => `refs/remotes/${remote}/${name}`;

/** git を実行する。失敗は例外にせず、終了コードと出力を返す。 */
const runGit = (cwd, args) => spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });

/** 範囲の commit 数（rev-list --count）。失敗なら null。 */
const countOf = (cwd, range) => {
  const r = runGit(cwd, ["rev-list", "--count", range]);
  if (r.status !== 0) return null;
  const n = Number(r.stdout.trim());
  return Number.isSafeInteger(n) ? n : null;
};

const fail = (code, message) => ({ ok: false, code, message });

/**
 * 分岐元をリモートの状態へ fast-forward で追いつかせる。
 * 手順: fetch（失敗は fetch-failed）→ 先行（リモートへ未 push の commit）と遅れを数える → 先行・分岐は更新せず止める → 現在のブランチが分岐元のときだけ `merge --ff-only`。
 * `ff-only` は先行を見逃すため（tests/base-sync-git.mjs の観測）、先行は別に数える。
 * @param {string} cwd 作業ツリー
 * @param {string} base 分岐元のブランチ名
 * @param {string} [target] 保護ブランチ名。指定すると一緒に fetch し、差を測れるようにする
 * @returns {{ok: true, updated: boolean} | {ok: false, code: "ahead"|"diverged"|"fetch-failed"|"ff-failed", message: string}}
 */
export function syncBase(cwd, base, target) {
  if (!validName(base) || (target !== undefined && !validName(target))) return fail("fetch-failed", "ブランチ名を安全に確認できないため、取り込みません。");
  const remote = remoteNameOf(cwd, base);
  if (typeof remote !== "string" || !SAFE_REMOTE.test(remote)) return fail("fetch-failed", "分岐元の push 先のリモート名を安全に確認できないため、取り込みません。");

  // 取得先を明示した refspec にする（remote.<名前>.fetch が分岐元を追跡しない設定でも、リモートの最新を追跡参照へ入れる）
  const names = [...new Set(target === undefined ? [base] : [base, target])];
  const refspecs = names.map((n) => `+refs/heads/${n}:${remoteRef(remote, n)}`);
  const f = runGit(cwd, ["fetch", "-q", remote, ...refspecs]);
  if (f.status !== 0) return fail("fetch-failed", `${remote} から ${names.join("・")} を取得できませんでした。取得の状態を確認してください。`);

  // 比較と merge は完全な参照名で行う（リモート名と同名のローカルブランチによる曖昧さを避ける）
  const remoteFull = remoteRef(remote, base);
  const localFull = `refs/heads/${base}`;
  const ahead = countOf(cwd, `${remoteFull}..${localFull}`);
  const behind = countOf(cwd, `${localFull}..${remoteFull}`);
  if (ahead === null || behind === null) return fail("ff-failed", `${base} と ${remote}/${base} の差を数えられないため、取り込みません。`);
  if (ahead >= 1 && behind >= 1) return fail("diverged", `${base} がリモートの ${remote}/${base} と分岐しています（先行 ${ahead} 件・遅れ ${behind} 件）。手作業で整理してください。`);
  if (ahead >= 1) return fail("ahead", `${base} にリモートへ未 push の commit が ${ahead} 件あります。push してから再実行してください。`);
  if (behind === 0) return { ok: true, updated: false };

  // 取り込みは、現在のブランチが分岐元のときだけ行う（別のブランチへ merge しない）
  const cur = runGit(cwd, ["symbolic-ref", "-q", "--short", "HEAD"]);
  if (cur.status !== 0 || cur.stdout.trim() !== base) return fail("ff-failed", `現在のブランチが分岐元 ${base} ではないため、取り込みません。`);

  const m = runGit(cwd, ["merge", "--ff-only", "-q", remoteFull]);
  if (m.status !== 0) return fail("ff-failed", `${remote}/${base} を取り込めませんでした（未コミットの変更との衝突など）。作業ツリーの変更を確認してください。`);
  return { ok: true, updated: true };
}

/**
 * リモートの保護ブランチ（target）に無く、リモートの分岐元（base）にある commit の数。0 なら取り込む差が無い。
 * 失敗（取得していない・名前が不正など）は例外にせず -1 を返す（0 と区別し、呼び出し側が止める）。
 * @returns {number}
 */
export function countDiff(cwd, target, base) {
  if (!validName(target) || !validName(base)) return -1;
  const remote = remoteNameOf(cwd, base);
  if (typeof remote !== "string" || !SAFE_REMOTE.test(remote)) return -1;
  const n = countOf(cwd, `${remoteRef(remote, target)}..${remoteRef(remote, base)}`);
  return n === null ? -1 : n;
}

/**
 * PR の作成先（保護ブランチ）を決める。
 * explicitTarget（--target）があればそれを使う（保護ブランチ＝分類が protected のときだけ）。
 * 無ければ、宣言の保護ブランチのうち固定名のものが 1 つのときだけそれを使う。複数・0 件・パターンだけのときは決められず止める。
 * @returns {{ok: true, target: string} | {ok: false, message: string}}
 */
export function resolveTarget(config, explicitTarget) {
  if (explicitTarget !== undefined) {
    if (!validName(explicitTarget)) return { ok: false, message: "--target のブランチ名を安全に確認できないため、PR の作成先にできません。" };
    if (classifyBranch(config, explicitTarget) !== "protected") return { ok: false, message: `--target の ${explicitTarget} は保護ブランチではないため、PR の作成先にできません。` };
    return { ok: true, target: explicitTarget };
  }
  // 宣言の要素をパターンも含めて数える。1 つで、固定名のときだけ自動で選ぶ
  const declared = (config.protectedBranches ?? []).filter((b) => typeof b === "string");
  if (declared.length === 1 && !GLOB.test(declared[0]) && validName(declared[0])) return { ok: true, target: declared[0] };
  if (declared.length === 0) return { ok: false, message: "保護ブランチが宣言されていないため、PR の作成先を決められません。--target で指定してください。" };
  return { ok: false, message: `保護ブランチの宣言が 1 つの固定名ではないため、PR の作成先を決められません。--target で指定してください（宣言: ${declared.join("、")}）。` };
}
