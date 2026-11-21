// 公開の push 実行と照合（brw-enforcement 4.4）の契約テスト。selftest.mjs から呼ばれる。
// 遠隔は bare remote を使う。push 先の URL は GitHub の形（git@github.com:acme/app.git）のままにし、
// GIT_SSH_COMMAND の試験用スクリプトが第 2 引数のコマンドの対象パスを bare remote へ差し替えて実行する。
// これで「push 先が宣言のリポジトリか」の確認を通したまま、ネットワークに出ずに実際の push と ls-remote を確かめられる。
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as publish from "../scripts/publish.mjs";
import { gitOut, mkRepoWithRemote } from "./support/git-fixture.mjs";

const CONFIG = { workBranches: ["dev/*"], protectedBranches: ["main"], baseBranch: "develop" };
const GH_SSH = "git@github.com:acme/app.git";
const REPO = { id: 4242, owner: "acme", name: "app" };
const DONE = "依頼の完了条件を満たした";
const VERIFIED = { passed: true, summary: "npm test が成功" };
const PULL = (over = {}) => ({ ok: true, pull: null, ...over });

// 試験用の ssh 代わり。対象の GitHub パスを BRW_TEST_BARE（bare remote）へ置き換えて実行する。
// BRW_TEST_FAIL_LS が設定されていれば、読み取り（upload-pack）だけを失敗させる（通信不能の再現）。
// BRW_TEST_HOOK が指すスクリプトは、最初の読み取りの中で一度だけ別プロセスとして実行する（読み取りの後・状態ロック内の再検証より前に状態を変える再現）。
const FAKE_SSH = `#!/bin/sh
case "$2" in
  *upload-pack*)
    [ -n "$BRW_TEST_FAIL_LS" ] && exit 128
    if [ -n "$BRW_TEST_HOOK" ] && [ -f "$BRW_TEST_HOOK" ]; then
      mv "$BRW_TEST_HOOK" "$BRW_TEST_HOOK.done"
      sh "$BRW_TEST_HOOK.done"
    fi ;;
esac
cmd=$(printf '%s' "$2" | sed "s#acme/app.git#$BRW_TEST_BARE#")
exec sh -c "$cmd"
`;

// 割り込みの別プロセスが読む公開モジュール（絶対 URL で読む）
const PUBLISH_URL = new URL("../scripts/publish.mjs", import.meta.url).href;

/** 宣言つきの一時リポジトリを作り、push 先を GitHub の形の URL にして開発ブランチで作業を始める。 */
const setup = ({ recorded, config = CONFIG } = {}) => {
  const r = mkRepoWithRemote({ branch: "dev/foo", config });
  gitOut(r.dir, "remote", "set-url", "origin", GH_SSH);
  if (recorded) gitOut(r.dir, "config", "branch.dev/foo.brwBase", recorded);
  process.env.BRW_TEST_BARE = r.remote;
  return r;
};

// 未実装の間は publish.runPush が無いため、各項目は「未実装」として失敗する（RED の確認用）
const UNKNOWN = { kind: "未実装", code: "未実装", message: "未実装" };
const runPush = (...args) => (publish.runPush ? publish.runPush(...args) : { ok: false, error: UNKNOWN });

const markReady = (d, id, over = {}) => publish.markReady(d, id, { completion: DONE, verification: VERIFIED, repository: REPO, ...over });

/** 準備・計画まで済ませた作業を用意して fn を呼び、後始末をする。計画に失敗すれば例外。 */
const withPlanned = (opts, fn) => {
  const r = setup(opts);
  try {
    const id = publish.startWork(r.dir, { sessionId: "s1" }).work.workId;
    const ready = markReady(r.dir, id);
    if (!ready.ok) throw new Error(`準備に失敗: ${ready.error?.code}`);
    const x = publish.issuePlan(r.dir, id, { repository: REPO, existing: PULL() });
    if (!x.ok) throw new Error(`計画に失敗: ${x.error?.code}`);
    return fn({ dir: r.dir, id, remote: r.remote, planId: x.plan.planId, plan: x });
  } finally {
    r.cleanup();
  }
};

/** bare remote の ref の OID。無ければ null。 */
const remoteRef = (remote, ref) => {
  try {
    return execFileSync("git", ["--git-dir", remote, "rev-parse", "--verify", "-q", ref], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};

const stateText = (d) => readFileSync(publish.stateFileOf(d), "utf8");

export const runPublishPushChecks = async (eq) => {
  // 試験用 ssh を環境変数に設定する（終了時に元へ戻す）
  const sshDir = mkdtempSync(join(tmpdir(), "brw-ssh-"));
  const sshPath = join(sshDir, "fake-ssh.sh");
  writeFileSync(sshPath, FAKE_SSH, { mode: 0o755 });
  const saved = { cmd: process.env.GIT_SSH_COMMAND, variant: process.env.GIT_SSH_VARIANT, bare: process.env.BRW_TEST_BARE, fail: process.env.BRW_TEST_FAIL_LS };
  process.env.GIT_SSH_COMMAND = sshPath;
  process.env.GIT_SSH_VARIANT = "simple";
  delete process.env.BRW_TEST_FAIL_LS;

  try {
    // ---- 開発間の取り込み: 計画どおり push し、遠隔の ref が準備時の OID になる ----
    withPlanned({ recorded: "dev/parent" }, ({ dir, id, remote, planId }) => {
      const head = gitOut(dir, "rev-parse", "HEAD");
      const x = runPush(dir, id, { planId, repository: REPO });
      eq("enforcement/4.4 計画どおりの push が成功し、結果は success（自動の確認省略）", [x.ok, x.outcome, x.execution], [true, "success", "auto"]);
      eq("enforcement/4.4 push 後、遠隔の対象 ref が準備時の OID を指す（ls-remote 相当の読み取りで確認）", remoteRef(remote, "refs/heads/dev/foo"), head);
      const w = publish.readWork(dir, id).work;
      eq("enforcement/4.4 push の成功を結果として記録し、作業の状態を pushed にする", [w.results.push, w.status], [{ outcome: "success", code: null }, "pushed"]);
      eq("enforcement/4.4 操作の開始を記録し、開始の OID は準備時の OID と一致する", w.started?.push?.oid, head);
      eq("enforcement/4.4 状態ファイルに URL・資格情報を残さない", [stateText(dir).includes("github.com"), stateText(dir).includes("ghp_")], [false, false]);
    });

    // ---- 保護対象への公開でも、まず開発ブランチの push を行う ----
    withPlanned({}, ({ dir, id, remote, planId }) => {
      const x = runPush(dir, id, { planId, repository: REPO });
      eq("enforcement/4.4 保護対象への公開でも、先に開発ブランチを push する（PR は 4.5）", [x.ok, x.outcome, remoteRef(remote, "refs/heads/dev/foo") === gitOut(dir, "rev-parse", "HEAD")], [true, "success", true]);
    });

    // ---- 既に同じ OID が公開済み: push せず成功扱い ----
    withPlanned({ recorded: "dev/parent" }, ({ dir, id, planId }) => {
      gitOut(dir, "push", "-q", "origin", "HEAD:refs/heads/dev/foo");
      const x = runPush(dir, id, { planId, repository: REPO });
      eq("enforcement/4.4 同じ OID が遠隔にあれば push せず、already-published として成功扱いにする", [x.ok, x.outcome, x.execution], [true, "success", "already-published"]);
      eq("enforcement/4.4 already-published の結果は code に識別子を残す", publish.readWork(dir, id).work.results.push?.code, "already-published");
    });

    // ---- push 禁止: 実行せず、禁止による省略として返す ----
    withPlanned({ recorded: "dev/parent" }, ({ dir, id, remote, planId }) => {
      publish.setRestrictions(dir, id, { noPush: true });
      eq("enforcement/4.4 計画の後に追加された禁止は、計画を失効させて push を止める", runPush(dir, id, { planId, repository: REPO }).error?.code, "restrictions-changed");
      eq("enforcement/4.4 失効で止めた場合は push せず、遠隔の ref も作らない", remoteRef(remote, "refs/heads/dev/foo"), null);
    });
    withPlanned({ recorded: "dev/parent" }, ({ dir, id, remote }) => {
      publish.setRestrictions(dir, id, { noPush: true });
      const y = publish.issuePlan(dir, id, { repository: REPO, existing: PULL() });
      const x = runPush(dir, id, { planId: y.plan.planId, repository: REPO, confirmed: true });
      eq("enforcement/4.4 push 禁止の作業は、個別の確認があっても push せず prohibited を返す", [x.ok, x.outcome, x.code], [true, "prohibited", "work-restriction"]);
      eq("enforcement/4.4 禁止による省略は遠隔を書き換えない", remoteRef(remote, "refs/heads/dev/foo"), null);
      eq("enforcement/4.4 禁止による省略を結果として記録する", publish.readWork(dir, id).work.results.push, { outcome: "prohibited", code: "work-restriction" });
    });

    // ---- 通常確認待ち: 確認省略が無効な宣言では push せず、確認後の個別の実行で push する ----
    withPlanned({ recorded: "dev/parent", config: { ...CONFIG, autoApprove: { push: false } } }, ({ dir, id, remote, planId }) => {
      const x = runPush(dir, id, { planId, repository: REPO });
      eq("enforcement/4.4 確認省略が無効なら push せず、通常確認待ちとして返す", [x.ok, x.outcome, x.code], [true, "needsApproval", "normal-approval"]);
      eq("enforcement/4.4 通常確認待ちでは遠隔を書き換えない", remoteRef(remote, "refs/heads/dev/foo"), null);
      const y = runPush(dir, id, { planId, repository: REPO, confirmed: true });
      eq("enforcement/4.4 通常確認を経た個別の実行は push し、execution を confirmed とする", [y.ok, y.outcome, y.execution], [true, "success", "confirmed"]);
      eq("enforcement/4.4 個別の実行の OID が遠隔の ref と一致する", remoteRef(remote, "refs/heads/dev/foo") === gitOut(dir, "rev-parse", "HEAD"), true);
    });

    // ---- 非 fast-forward の拒否: 失敗として記録し、成功扱いしない ----
    withPlanned({ recorded: "dev/parent" }, ({ dir, id, remote, planId }) => {
      // 遠隔に別の commit（親は準備時の親）を置き、履歴を分岐させる
      const other = gitOut(remote, "commit-tree", gitOut(dir, "rev-parse", "HEAD^{tree}"), "-p", gitOut(dir, "rev-parse", "HEAD~1"), "-m", "他の変更");
      gitOut(remote, "update-ref", "refs/heads/dev/foo", other);
      const x = runPush(dir, id, { planId, repository: REPO });
      eq("enforcement/4.4 遠隔が分岐していて push が拒否されたら failed を返し、成功扱いしない", [x.ok, x.outcome, x.error?.code], [false, "failed", "push-rejected"]);
      eq("enforcement/4.4 拒否された push の結果を failed として記録する", publish.readWork(dir, id).work.results.push, { outcome: "failed", code: "push-rejected" });
      eq("enforcement/4.4 拒否された push は遠隔の ref を書き換えない", remoteRef(remote, "refs/heads/dev/foo"), other);
    });

    // ---- 遠隔の読み取りができない: push せず failed（不明は安全側） ----
    withPlanned({ recorded: "dev/parent" }, ({ dir, id, remote, planId }) => {
      process.env.BRW_TEST_FAIL_LS = "1";
      const x = runPush(dir, id, { planId, repository: REPO });
      delete process.env.BRW_TEST_FAIL_LS;
      eq("enforcement/4.4 遠隔の状態を読めなければ push せず、remote-unreadable で failed を返す", [x.ok, x.outcome, x.error?.code], [false, "failed", "remote-unreadable"]);
      eq("enforcement/4.4 遠隔を読めない場合も遠隔の ref を作らない", remoteRef(remote, "refs/heads/dev/foo"), null);
    });

    // ---- 計画・作業・対象の不一致: 副作用の前に止め、結果は記録しない ----
    withPlanned({ recorded: "dev/parent" }, ({ dir, id, remote, planId }) => {
      eq("enforcement/4.4 別の計画 ID では push しない", runPush(dir, id, { planId: "p-other", repository: REPO }).error?.code, "plan-not-found");
      eq("enforcement/4.4 対象リポジトリの ID が違えば push しない", runPush(dir, id, { planId, repository: { ...REPO, id: 1 } }).error?.code, "destination-mismatch");
      eq("enforcement/4.4 push 先の GitHub リポジトリ名が違えば push しない", runPush(dir, id, { planId, repository: { ...REPO, name: "other" } }).error?.code, "destination-mismatch");
      eq("enforcement/4.4 対象の検査で止めた場合は遠隔を書き換えず、結果も記録しない", [remoteRef(remote, "refs/heads/dev/foo"), publish.readWork(dir, id).work.results.push ?? null], [null, null]);
    });
    withPlanned({ recorded: "dev/parent" }, ({ dir, id, planId }) => {
      publish.pauseWork(dir, id, "追加の指示待ち");
      eq("enforcement/4.4 中断中の作業は push しない", runPush(dir, id, { planId, repository: REPO }).error?.code, "work-paused");
    });
    withPlanned({ recorded: "dev/parent" }, ({ dir, id, planId }) => {
      gitOut(dir, "commit", "-q", "--allow-empty", "-m", "計画の後の commit");
      eq("enforcement/4.4 計画の後に HEAD が進んでいれば push しない", runPush(dir, id, { planId, repository: REPO }).error?.code, "head-changed");
    });
    withPlanned({ recorded: "dev/parent" }, ({ dir, id, remote, planId }) => {
      eq("enforcement/4.4 確認の有無が真偽値でなければ入力として拒否する", runPush(dir, id, { planId, repository: REPO, confirmed: "yes" }).error?.kind, "invalidInput");
      eq("enforcement/4.4 入力が不正なら遠隔を書き換えない", remoteRef(remote, "refs/heads/dev/foo"), null);
    });

    // ---- push 直前の再検証（状態ロック内）: 最初の読み取りの後に別プロセスが状態を変えたら、push せず止める ----
    withPlanned({ recorded: "dev/parent" }, ({ dir, id, remote, planId }) => {
      const js = join(sshDir, "hook-pause.mjs");
      writeFileSync(js, `import * as publish from ${JSON.stringify(PUBLISH_URL)};\npublish.pauseWork(process.argv[2], process.argv[3], "割り込み");\n`);
      const sh = join(sshDir, "hook-pause.sh");
      writeFileSync(sh, `#!/bin/sh\nexec node ${JSON.stringify(js)} ${JSON.stringify(dir)} ${JSON.stringify(id)}\n`);
      process.env.BRW_TEST_HOOK = sh;
      const x = runPush(dir, id, { planId, repository: REPO });
      delete process.env.BRW_TEST_HOOK;
      eq("enforcement/4.4 読み取り後・push 前に中断されたら、状態ロック内の再検証で止め work-paused を返す", [x.ok, x.error?.code], [false, "work-paused"]);
      eq("enforcement/4.4 中断で止めた場合は push せず、遠隔の ref を作らない", remoteRef(remote, "refs/heads/dev/foo"), null);
      eq("enforcement/4.4 中断で止めた場合は操作の開始を記録しない", publish.readWork(dir, id).work.started?.push ?? null, null);
    });
    withPlanned({ recorded: "dev/parent" }, ({ dir, id, remote, planId }) => {
      const js = join(sshDir, "hook-norpush.mjs");
      writeFileSync(js, `import * as publish from ${JSON.stringify(PUBLISH_URL)};\npublish.setRestrictions(process.argv[2], process.argv[3], { noPush: true });\n`);
      const sh = join(sshDir, "hook-nopush.sh");
      writeFileSync(sh, `#!/bin/sh\nexec node ${JSON.stringify(js)} ${JSON.stringify(dir)} ${JSON.stringify(id)}\n`);
      process.env.BRW_TEST_HOOK = sh;
      const x = runPush(dir, id, { planId, repository: REPO });
      delete process.env.BRW_TEST_HOOK;
      eq("enforcement/4.4 読み取り後・push 前に禁止が追加されたら、状態ロック内の再検証で計画を失効させ restrictions-changed で止める", [x.ok, x.error?.code], [false, "restrictions-changed"]);
      eq("enforcement/4.4 禁止で止めた場合は push せず、遠隔の ref を作らない", remoteRef(remote, "refs/heads/dev/foo"), null);
      eq("enforcement/4.4 禁止で止めた場合は操作の開始を記録しない", publish.readWork(dir, id).work.started?.push ?? null, null);
    });

    // ---- 遠隔のフックによる拒否は、分岐（non-fast-forward）と区別して remote-rejected にする ----
    withPlanned({ recorded: "dev/parent" }, ({ dir, id, remote, planId }) => {
      writeFileSync(join(remote, "hooks", "pre-receive"), "#!/bin/sh\necho 'policy: denied' >&2\nexit 1\n", { mode: 0o755 });
      const x = runPush(dir, id, { planId, repository: REPO });
      eq("enforcement/4.4 遠隔のフックが拒否したら remote-rejected（分岐の push-rejected とは別）で failed を返す", [x.ok, x.outcome, x.error?.code], [false, "failed", "remote-rejected"]);
      eq("enforcement/4.4 フックで拒否された push は遠隔の ref を書き換えない", remoteRef(remote, "refs/heads/dev/foo"), null);
    });

    // ---- 同じ worktree の公開は直列化する（実行中のロックがあれば待って止める） ----
    withPlanned({ recorded: "dev/parent" }, ({ dir, id, remote, planId }) => {
      const lock = `${publish.stateFileOf(dir)}.run.lock`;
      writeFileSync(lock, String(process.pid));
      const busy = runPush(dir, id, { planId, repository: REPO, lockWaitMs: 50 });
      rmSync(lock, { force: true });
      eq("enforcement/4.4 同じ worktree で別の公開が実行中なら push せず publish-busy を返す", busy.error?.code, "publish-busy");
      eq("enforcement/4.4 ロックで止めた場合も遠隔を書き換えない", remoteRef(remote, "refs/heads/dev/foo"), null);
      const done = runPush(dir, id, { planId, repository: REPO });
      eq("enforcement/4.4 実行後は公開のロックを残さない", [done.ok, existsSync(`${publish.stateFileOf(dir)}.run.lock`)], [true, false]);
    });
  } finally {
    for (const [k, v] of [["GIT_SSH_COMMAND", saved.cmd], ["GIT_SSH_VARIANT", saved.variant], ["BRW_TEST_BARE", saved.bare], ["BRW_TEST_FAIL_LS", saved.fail]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(sshDir, { recursive: true, force: true });
  }
};
