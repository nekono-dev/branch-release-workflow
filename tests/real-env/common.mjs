// 実環境検証（brw-enforcement 8.3）の共通部分。通常の selftest からは読み込まれない。
// BRW_REAL_ENV=1 のときだけ実行される。node: 標準モジュールのみ。
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const BRW_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// 検証用リポジトリ（利用者から使用の許可を得ている）
export const OWNER = "nekono-dev";
export const REPO = "branch-release-workflow";
export const SLUG = `${OWNER}/${REPO}`;
// 状態ファイルと一時クローンを置く固定の作業場所（自分が作る専用の場所。環境変数で変更可）
export const WORK_DIR = resolve(process.env.BRW_REAL_ENV_DIR ?? "/tmp/brw-real-env");
export const STATE_FILE = join(WORK_DIR, ".brw-verify-state.json");

/** BRW_REAL_ENV=1 でなければ説明を出して終了コード 0 で終わる。 */
export function requireRealEnv(scriptName) {
  if (process.env.BRW_REAL_ENV === "1") return;
  console.log(`${scriptName}: 実環境検証用です。BRW_REAL_ENV=1 を付けたときだけ動きます（何もせず終了します）。`);
  console.log("詳細は tests/real-env/README.md を参照してください。");
  process.exit(0);
}

/** 子プロセスを同期実行する。資格情報は env で渡し、出力には含めない。 */
export function run(cmd, args, { cwd, env, input } = {}) {
  const r = spawnSync(cmd, args, { cwd, env: env ?? process.env, input, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "", error: r.error };
}

/** gh api を呼ぶ。失敗しても例外にせず結果を返す。 */
export function ghApi(args, { env } = {}) {
  return run("gh", ["api", ...args], { env });
}

export const ghJson = (path, args = []) => {
  const r = ghApi([path, ...args]);
  if (r.code !== 0) return { ok: false, err: r.err.trim().split("\n")[0] };
  try { return { ok: true, data: JSON.parse(r.out) }; } catch { return { ok: false, err: "JSON を解釈できません" }; }
};

export function readState() {
  if (!existsSync(STATE_FILE)) return null;
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return null; }
}

/** 状態ファイルを一時ファイル＋rename で書く（資格情報は含めない）。 */
export function writeState(state) {
  mkdirSync(WORK_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, STATE_FILE);
}

/**
 * 8.4/8.5 の検証コマンドに渡す認証の環境変数を作る。値は表示・記録しない。
 *   設定用   BRW_SETUP_GH_TOKEN  常に gh のログインから作る
 *   作業用   BRW_WORK_GH_TOKEN   BRW_REAL_ENV_WORK_TOKEN があればそれ、無ければ gh のログイン（管理者のため drift が正しい）
 */
export function authEnv() {
  const t = run("gh", ["auth", "token"]);
  if (t.code !== 0 || !t.out.trim()) throw new Error("gh のログインから資格情報を取得できません（gh auth login が必要です）");
  const login = t.out.trim();
  return { BRW_SETUP_GH_TOKEN: login, BRW_WORK_GH_TOKEN: process.env.BRW_REAL_ENV_WORK_TOKEN || login };
}
