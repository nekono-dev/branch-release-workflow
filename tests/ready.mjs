// 完了申告と公開準備の確定（brw-enforcement 4.2）の契約テスト。selftest.mjs から呼ばれる。
// 未実装の間は publish.markReady が無いため、各項目は「未実装」として失敗する（RED の確認用）。
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as publish from "../scripts/publish.mjs";
import { gitOut, mkRepoWithRemote } from "./support/git-fixture.mjs";

const CONFIG = { workBranches: ["dev/*"], protectedBranches: ["main"], baseBranch: "develop" };
const GH = "https://github.com/acme/app.git";
const REPO = { id: 4242, owner: "acme", name: "app" };
const DONE = "依頼の完了条件を満たした";
const VERIFIED = { passed: true, summary: "npm test が成功" };
const UNKNOWN = { kind: "未実装", code: "未実装", message: "未実装" };

const markReady = (...args) => (publish.markReady ? publish.markReady(...args) : { ok: false, error: UNKNOWN });
const input = (over = {}) => ({ completion: DONE, verification: VERIFIED, repository: REPO, ...over });

/** 宣言つきの一時リポジトリを作り、作業の起点ブランチへ移す。origin は既定で GitHub の対象。 */
const setup = ({ recorded, origin = GH, config = CONFIG, branch = "dev/foo" } = {}) => {
  const r = mkRepoWithRemote({ branch, config });
  if (origin === null) gitOut(r.dir, "remote", "remove", "origin");
  else gitOut(r.dir, "remote", "set-url", "origin", origin);
  if (recorded) gitOut(r.dir, "config", `branch.${branch}.brwBase`, recorded);
  return r;
};

/** 作業を 1 件始めた状態でテストを行い、後始末をする。 */
const withWork = (opts, fn) => {
  const r = setup(opts);
  try {
    const started = publish.startWork(r.dir, { sessionId: "s1" });
    return fn(r.dir, started.work?.workId ?? "w-none-00000000", r.dir);
  } finally {
    r.cleanup();
  }
};

const stateText = (d) => readFileSync(publish.stateFileOf(d), "utf8");

export const runReadyChecks = async (eq) => {
  // ---- 正常な準備: 開発間の取り込みは push のみ ----
  withWork({ recorded: "dev/parent" }, (d, id) => {
    const x = markReady(d, id, input());
    const w = publish.readWork(d, id).work;
    eq("enforcement/4.2 完了申告と検証が成功し、開発間の取り込みなら準備済みになり push のみを公開方法とする", [x.ok, w.status, w.ready?.publication], [true, "ready", "push"]);
    eq("enforcement/4.2 準備の記録は公開先リポジトリ ID・push 先 ref・取り込み先（ID・ref・種類・決め方）・head OID を持つ", w.ready && {
      repositoryId: w.ready.repositoryId,
      pushRef: w.ready.pushRef,
      integration: w.ready.integration,
      headOid: w.ready.headOid,
    }, {
      repositoryId: 4242,
      pushRef: "refs/heads/dev/foo",
      integration: { repositoryId: 4242, ref: "dev/parent", kind: "development", source: "recorded" },
      headOid: gitOut(d, "rev-parse", "HEAD"),
    });
    eq("enforcement/4.2 完了申告と検証の要約を記録する", [w.ready?.completion, w.ready?.verification], [DONE, { passed: true, summary: VERIFIED.summary }]);
    eq("enforcement/4.2 準備の記録には決まった項目だけを持ち、PR 本文などは持たない", Object.keys(w.ready ?? {}).sort(), ["completion", "headOid", "integration", "publication", "pushRef", "readyAt", "repositoryId", "restrictions", "verification"]);
  });
  withWork({}, (d, id) => {
    publish.setRestrictions(d, id, { noPr: true });
    const y = markReady(d, id, input());
    eq("enforcement/4.2 準備時の作業の禁止（PR 作成の禁止）を固定して記録する", [y.ok, publish.readWork(d, id).work.ready?.restrictions], [true, { noPush: false, noPr: true }]);
  });

  // ---- 記録のない作業は宣言の既定値（保護対象の分岐元）へ PR を伴う公開 ----
  withWork({}, (d, id) => {
    const x = markReady(d, id, input());
    const w = publish.readWork(d, id).work;
    eq("enforcement/4.2 記録が無ければ宣言の既定値を取り込み先にし、PR を伴う公開とする", [x.ok, w.ready?.publication, w.ready?.integration], [true, "pr", { repositoryId: 4242, ref: "develop", kind: "base", source: "declared" }]);
  });
  withWork({}, (d, id) => {
    const x = markReady(d, id, input({ target: "main" }));
    eq("enforcement/4.2 明示指定した保護対象は取り込み先になり、PR を伴う公開とする", [x.ok, x.work?.ready?.integration, x.work?.ready?.publication], [true, { repositoryId: 4242, ref: "main", kind: "protected", source: "explicit" }, "pr"]);
  });
  withWork({ recorded: "dev/parent" }, (d, id) => {
    const x = markReady(d, id, input({ target: "main" }));
    eq("enforcement/4.2 明示指定は記録と食い違っても明示指定へ戻して採用する", [x.ok, x.work?.ready?.integration?.source], [true, "explicit"]);
  });

  // ---- 未コミット・検証失敗・申告不足は準備済みにしない ----
  withWork({}, (d, id) => {
    // 宣言は有効なまま、コミットしていない変更だけを残す
    writeFileSync(join(d, ".branch-release-workflow.json"), JSON.stringify({ ...CONFIG, baseBranch: "develop2" }));
    const x = markReady(d, id, input());
    eq("enforcement/4.2 未コミットの変更があれば準備済みにせず、状態を inProgress のまま保つ", [x.error?.kind, x.error?.code, publish.readWork(d, id).work.status, publish.readWork(d, id).work.ready ?? null], ["conflict", "uncommitted", "inProgress", null]);
  });
  withWork({}, (d, id) => {
    const x = markReady(d, id, input({ verification: { passed: false, summary: "テスト失敗" } }));
    eq("enforcement/4.2 検証が失敗していれば準備済みにしない", [x.error?.kind, x.error?.code, publish.readWork(d, id).work.status], ["conflict", "verification-failed", "inProgress"]);
  });
  withWork({}, (d, id) => {
    eq("enforcement/4.2 検証の結果が無い申告は受け付けない", [markReady(d, id, input({ verification: undefined })).error?.code, markReady(d, id, input({ verification: { passed: "yes", summary: "x" } })).error?.code], ["verification-missing", "verification-missing"]);
    eq("enforcement/4.2 完了申告が空なら受け付けない", [markReady(d, id, input({ completion: "" })).error?.code, markReady(d, id, input({ completion: "   " })).error?.code], ["completion-missing", "completion-missing"]);
  });

  // ---- 宛先（公開先・取り込み先）が確定できなければ準備しない ----
  withWork({ origin: null }, (d, id) => {
    const x = markReady(d, id, input());
    eq("enforcement/4.2 push 先のリモートが無ければ宛先不明として準備しない", [x.error?.kind, x.error?.code, publish.readWork(d, id).work.status], ["invalidInput", "destination-unknown", "inProgress"]);
  });
  for (const origin of ["https://gitlab.com/acme/app.git", "https://u:tok@github.com/acme/app.git", "/tmp/some/remote.git"]) {
    withWork({ origin }, (d, id) => {
      eq(`enforcement/4.2 GitHub のリポジトリとして読めない宛先（${origin.replace(/\/\/.*@/, "//***@")}）は準備しない`, markReady(d, id, input()).error?.code, "destination-unknown");
    });
  }
  withWork({ origin: "https://github.com/acme/other.git" }, (d, id) => {
    eq("enforcement/4.2 リモートの宛先が対象リポジトリと異なれば準備しない", markReady(d, id, input()).error?.code, "destination-mismatch");
  });
  withWork({}, (d, id) => {
    eq("enforcement/4.2 対象リポジトリ ID が無い・不正な入力は受け付けない", [
      markReady(d, id, input({ repository: undefined })).error?.code,
      markReady(d, id, input({ repository: { id: 0, owner: "acme", name: "app" } })).error?.code,
      markReady(d, id, input({ repository: { id: "4242", owner: "acme", name: "app" } })).error?.code,
      markReady(d, id, input({ repository: { id: 4242, owner: "acme", name: "other" } })).error?.code,
    ], ["repository-invalid", "repository-invalid", "repository-invalid", "destination-mismatch"]);
  });
  withWork({}, (d, id) => {
    eq("enforcement/4.2 宣言外・自分自身・不正な名前の取り込み先は準備しない", [
      markReady(d, id, input({ target: "feature/x" })).error?.code,
      markReady(d, id, input({ target: "dev/foo" })).error?.code,
      markReady(d, id, input({ target: "bad..name" })).error?.code,
    ], ["integration-undeclared", "integration-self", "integration-invalid"]);
  });

  // ---- 分岐元の記録・既存 PR・既定値の照合 ----
  withWork({ recorded: "dev/parent" }, (d, id) => {
    eq("enforcement/4.2 既存 PR の取り込み先が記録と食い違えば、明示指定を求めて準備しない", [markReady(d, id, input({ existing: { ok: true, pull: { baseRef: "develop" } } })).error?.code, publish.readWork(d, id).work.status], ["base-conflict", "inProgress"]);
    eq("enforcement/4.2 既存 PR の取り込み先が記録と一致すれば準備できる", markReady(d, id, input({ existing: { ok: true, pull: { baseRef: "dev/parent" } } })).ok, true);
  });
  withWork({}, (d, id) => {
    eq("enforcement/4.2 記録が無く既存 PR の取り込み先が既定値と異なれば、明示指定を求める", markReady(d, id, input({ existing: { ok: true, pull: { baseRef: "main" } } })).error?.code, "base-conflict");
    const y = markReady(d, id, input({ target: "main", existing: { ok: true, pull: { baseRef: "main" } } }));
    eq("enforcement/4.2 食い違う既存 PR があっても明示指定があれば、その指定を採用する", [y.ok, y.work?.ready?.integration?.source], [true, "explicit"]);
  });
  withWork({}, (d, id) => {
    eq("enforcement/4.2 既存 PR の検索が確定できなければ準備しない", markReady(d, id, input({ existing: { ok: false, kind: "network" } })).error?.code, "pr-unconfirmed");
    eq("enforcement/4.2 既存 PR が無ければ（検索が一意に無し）そのまま準備できる", markReady(d, id, input({ existing: { ok: true, pull: null } })).ok, true);
  });

  // ---- 作業の状態と Git の状態 ----
  withWork({}, (d, id) => {
    publish.pauseWork(d, id, "追加の指示待ち");
    eq("enforcement/4.2 中断中の作業は準備しない", markReady(d, id, input()).error?.code, "work-paused");
  });
  withWork({}, (d, id) => {
    eq("enforcement/4.2 準備済みの作業をもう一度準備しない", [markReady(d, id, input()).ok, markReady(d, id, input()).error?.kind], [true, "conflict"]);
  });
  withWork({}, (d, id) => {
    gitOut(d, "checkout", "-q", "-b", "dev/zzz");
    eq("enforcement/4.2 作業のブランチと現在のブランチが違えば準備しない", markReady(d, id, input()).error?.code, "work-branch-mismatch");
  });
  withWork({ branch: "main" }, (d, id) => {
    eq("enforcement/4.2 開発ブランチでない作業は準備しない", markReady(d, id, input()).error?.code, "branch-not-development");
  });
  withWork({ config: null }, (d, id) => {
    eq("enforcement/4.2 宣言が無い（規則を確認できない）場合は準備しない", markReady(d, id, input()).error?.code, "declaration-invalid");
  });
  withWork({}, (d) => {
    eq("enforcement/4.2 作業 ID が記録に無ければ準備しない", markReady(d, "w-abc-0123abcd", input()).error?.kind, "invalidInput");
  });

  // ---- 秘密情報は記録しない ----
  withWork({}, (d, id) => {
    const x = markReady(d, id, input({
      completion: "ghp_abcdefghijklmnopqrstuvwxyz0123456789 で完了",
      verification: { passed: true, summary: "token=abc123secret を使った検証" },
    }));
    const text = stateText(d);
    eq("enforcement/4.2 完了申告と検証の要約から秘密らしい値を伏せて保存する", [x.ok, text.includes("ghp_abcdefghij"), text.includes("abc123secret")], [true, false, false]);
  });
};
