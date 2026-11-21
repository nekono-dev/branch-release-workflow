// 8.3: 実環境検証の準備。使い捨てブランチ 1 本と一時クローン（検証用宣言入り）と状態ファイルを作る。冪等。
// 使い方: BRW_REAL_ENV=1 node tests/real-env/prepare.mjs [--record ruleset=<id>|pr=<番号>|branch=<名前>]
// 既存の本物のブランチ・Ruleset・リポジトリ設定には書き込まない。
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OWNER, REPO, SLUG, STATE_FILE, WORK_DIR, ghApi, ghJson, readState, requireRealEnv, run, writeState } from "./common.mjs";

requireRealEnv("prepare.mjs");

// 8.4/8.5 が作った Ruleset・PR・ブランチを状態ファイルへ追記する入口（cleanup が消せるようにする）
const rec = process.argv.indexOf("--record");
if (rec !== -1) {
  const m = /^(ruleset|pr|branch)=(.+)$/.exec(process.argv[rec + 1] ?? "");
  const st = readState();
  if (!m || !st) { console.error("使い方: --record ruleset=<id>|pr=<番号>|branch=<名前>（先に prepare が必要です）"); process.exit(2); }
  const key = { ruleset: "rulesets", pr: "prs", branch: "extraBranches" }[m[1]];
  const v = m[1] === "branch" ? m[2] : Number(m[2]);
  if (m[1] !== "branch" && !Number.isInteger(v)) { console.error("ID・番号は整数で指定してください"); process.exit(2); }
  st[key] = [...new Set([...(st[key] ?? []), v])];
  writeState(st);
  console.log(`記録しました: ${m[1]}=${m[2]}`);
  process.exit(0);
}

const fail = (m) => { console.error(`準備を中止します: ${m}`); process.exit(1); };
const line = (ok, text) => console.log(`  [${ok ? "OK" : "NG"}] ${text}`);

// --- 検査（読み取りのみ） ---
console.log(`検証用リポジトリ: ${SLUG}`);
const repo = ghJson(`repos/${SLUG}`);
if (!repo.ok) fail(`リポジトリを読めません: ${repo.err}`);
const r = repo.data;
const head = run("gh", ["api", "-i", "user"]);
const scopes = /^x-oauth-scopes:\s*(.*)$/im.exec(head.out)?.[1]?.trim() ?? null;
const login = ghJson("user");
const kind = scopes === null ? "fine-grained / App 相当（x-oauth-scopes なし）" : `classic / OAuth（scopes: ${scopes || "なし"}）`;
console.log("検査項目:");
line(r.permissions?.admin === true, `admin 権限: ${r.permissions?.admin === true}`);
line(r.allow_squash_merge === true, `squash 利用条件 allow_squash_merge: ${r.allow_squash_merge}`);
console.log(`  [情報] gh ログイン: ${login.ok ? login.data.login : "不明"} / 認証の種類: ${kind}（値は表示しません）`);
console.log(`  [情報] 既定ブランチ: ${r.default_branch} / 公開範囲: ${r.visibility}`);
if (r.permissions?.admin !== true) fail("admin 権限がありません");
if (r.allow_squash_merge !== true) fail("allow_squash_merge が false です。設定は変更しないため中止します");

// --- 冪等: 既に準備済みなら再利用 ---
let state = readState();
if (state) {
  const ref = ghApi([`repos/${SLUG}/git/ref/heads/${state.branch}`, "--jq", ".object.sha"]);
  if (ref.code === 0 && existsSync(join(state.cloneDir, ".git"))) {
    console.log(`既に準備済みのため再利用します: ${state.branch}`);
    report(state, ref.out.trim());
    process.exit(0);
  }
  fail(`状態ファイルはありますが対象 ref または一時クローンがありません。cleanup.mjs で片付けてから再実行してください（${STATE_FILE}）`);
}

// --- 使い捨てブランチを main の現在の commit から作る ---
const main = ghApi([`repos/${SLUG}/git/ref/heads/${r.default_branch}`, "--jq", ".object.sha"]);
if (main.code !== 0) fail("main の commit を読めません");
const baseSha = main.out.trim();
const branch = `verify/brw-base-${Math.floor(Date.now() / 1000)}`;
mkdirSync(WORK_DIR, { recursive: true, mode: 0o700 });
// 先に状態を書き、作成途中で失敗しても cleanup が拾えるようにする
state = { repo: SLUG, branch, baseSha, cloneDir: join(WORK_DIR, "clone"), branchCreated: false, rulesets: [], prs: [], extraBranches: [], createdAt: new Date().toISOString(), schema: 1 };
writeState(state);
const created = ghApi(["-X", "POST", `repos/${SLUG}/git/refs`, "-f", `ref=refs/heads/${branch}`, "-f", `sha=${baseSha}`]);
if (created.code !== 0) fail(`ブランチを作れません: ${created.err.trim().split("\n")[0]}`);
state.branchCreated = true;
writeState(state);

// --- 一時クローン（公開リポジトリなので資格情報なしで取得）と検証用宣言 ---
const clone = run("git", ["clone", "--quiet", "--branch", branch, `https://github.com/${SLUG}.git`, state.cloneDir], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
if (clone.code !== 0) fail(`クローンに失敗しました: ${clone.err.trim().split("\n")[0]}`);
run("git", ["config", "user.name", "brw-verify"], { cwd: state.cloneDir });
run("git", ["config", "user.email", "brw-verify@example.invalid"], { cwd: state.cloneDir });
// baseBranch も専用ブランチにする（main を恒常的な分岐元にすると Ruleset の対象に main が入るため）。main は保護ブランチ扱い。
const declaration = {
  workBranches: ["dev/*"],
  protectedBranches: ["main"],
  baseBranch: branch,
  baseBranches: [branch],
  namePattern: "^dev/[a-z0-9]+(-[a-z0-9]+)*$",
  maxNameLength: 54,
  autoApprove: { push: true, pullRequest: true },
  preview: { provider: "none" },
};
// 宣言はクローン内に置くだけ。commit も push もしない（main や本物のブランチへ届かない）
writeFileSync(join(state.cloneDir, ".branch-release-workflow.json"), `${JSON.stringify(declaration, null, 2)}\n`);
writeState(state);
report(state, baseSha);

function report(st, sha) {
  console.log("対象 ref:");
  line(true, `refs/heads/${st.branch} が存在（${sha.slice(0, 12)}。main の commit から作成）`);
  console.log("認証（値は表示・記録しません）:");
  console.log("  設定用 BRW_SETUP_GH_TOKEN: gh のログインから作る（authEnv()）");
  console.log(`  作業用 BRW_WORK_GH_TOKEN : ${process.env.BRW_REAL_ENV_WORK_TOKEN ? "BRW_REAL_ENV_WORK_TOKEN（別の資格情報）" : "gh のログインと同じ（管理者のため brw check の作業経路は drift と出るのが正しい。README 参照）"}`);
  console.log(`一時クローン: ${st.cloneDir}（検証用宣言は未 commit。baseBranches=[${st.branch}]）`);
  console.log(`状態ファイル: ${STATE_FILE}`);
}
