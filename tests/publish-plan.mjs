// 公開計画の発行と検証（brw-enforcement 4.3）の契約テスト。selftest.mjs から呼ばれる。
// 未実装の間は publish.issuePlan / checkPlan が無いため、各項目は「未実装」として失敗する（RED の確認用）。
// 計画の発行は読み取りとローカル記録だけで、遠隔（bare remote）の ref が動かないことも確認する。
import { execFileSync } from "node:child_process";
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
const PULL = (over = {}) => ({ ok: true, pull: null, ...over });

const issuePlan = (...args) => (publish.issuePlan ? publish.issuePlan(...args) : { ok: false, error: UNKNOWN });
const checkPlan = (...args) => (publish.checkPlan ? publish.checkPlan(...args) : { ok: false, error: UNKNOWN });
const markReady = (d, id, over = {}) => publish.markReady(d, id, { completion: DONE, verification: VERIFIED, repository: REPO, ...over });

/** 宣言つきの一時リポジトリを作り、開発ブランチで作業を始める。 */
const setup = ({ recorded, config = CONFIG, origin = GH } = {}) => {
  const r = mkRepoWithRemote({ branch: "dev/foo", config });
  gitOut(r.dir, "remote", "set-url", "origin", origin);
  if (recorded) gitOut(r.dir, "config", "branch.dev/foo.brwBase", recorded);
  return r;
};

/** 準備済みの作業を 1 件用意して fn を呼び、後始末をする。 */
const withReady = (opts, fn) => {
  const r = setup(opts);
  try {
    const started = publish.startWork(r.dir, { sessionId: "s1" });
    const id = started.work.workId;
    const ready = markReady(r.dir, id, opts?.ready);
    if (!ready.ok) throw new Error(`準備に失敗: ${ready.error?.code}`);
    return fn(r.dir, id, r.remote);
  } finally {
    r.cleanup();
  }
};

const stateText = (d) => readFileSync(publish.stateFileOf(d), "utf8");
const writesOf = (x) => (x.plan?.writes ?? []).map((w) => w.operation);

export const runPublishPlanChecks = async (eq) => {
  // ---- 発行: 開発間の取り込みは push だけを計画する ----
  withReady({ recorded: "dev/parent" }, (d, id) => {
    const x = issuePlan(d, id, { repository: REPO });
    eq("enforcement/4.3 開発間の取り込みでは push だけを計画し、PR は計画しない", [x.ok, writesOf(x)], [true, ["push"]]);
    eq("enforcement/4.3 計画の push は準備時の OID と push 先 ref・遠隔名を持つ", x.plan?.writes?.[0], {
      operation: "push",
      remote: "origin",
      ref: "refs/heads/dev/foo",
      oid: gitOut(d, "rev-parse", "HEAD"),
    });
    eq("enforcement/4.3 計画は作業 ID・head OID・対象リポジトリ ID と版を持ち、作業状態に関連付けて保存する", (() => {
      const w = publish.readWork(d, id).work;
      return [w.plan?.planId === x.plan?.planId, typeof x.plan?.planId, w.plan?.headOid === gitOut(d, "rev-parse", "HEAD"), w.plan?.repositoryId, Object.keys(w.plan?.versions ?? {}).sort()];
    })(), [true, "string", true, 4242, ["declaration", "destination", "ready", "restrictions"]]);
    eq("enforcement/4.3 計画の記録は決まった項目だけで、URL・PR のタイトルや本文・資格情報を含まない", (() => {
      const text = JSON.stringify(publish.readWork(d, id).work.plan ?? null) ?? "";
      return [text.includes("https://"), text.includes("ghp_"), text.includes("title"), text.includes("body")];
    })(), [false, false, false, false]);
  });

  // ---- 保護対象の取り込みは push と PR を計画する（既存 PR が無い場合） ----
  withReady({}, (d, id) => {
    eq("enforcement/4.3 既存 PR の検索結果が無いと、PR を伴う公開の計画を確定できない", issuePlan(d, id, { repository: REPO }).error?.code, "pr-unconfirmed");
    const x = issuePlan(d, id, { repository: REPO, existing: PULL() });
    eq("enforcement/4.3 保護対象への公開は push と PR（取り込み先と head を持つ）を計画する", [x.ok, writesOf(x), x.plan?.writes?.[1]], [true, ["push", "pr"], { operation: "pr", base: "develop", head: "dev/foo", repositoryId: 4242 }]);
    eq("enforcement/4.3 PR の本文・タイトルは計画に持たせない（作成時に利用者の入力を使う）", Object.keys(x.plan?.writes?.[1] ?? {}).sort(), ["base", "head", "operation", "repositoryId"]);
  });
  withReady({}, (d, id) => {
    const x = issuePlan(d, id, { repository: REPO, existing: PULL({ pull: { number: 7, url: "https://github.com/acme/app/pull/7", headOid: gitOut(d, "rev-parse", "HEAD"), baseRef: "develop" } }) });
    eq("enforcement/4.3 同じ head・base の既存 PR があれば PR は計画せず、push だけを計画する", [x.ok, writesOf(x)], [true, ["push"]]);
  });
  withReady({}, (d, id) => {
    const head = gitOut(d, "rev-parse", "HEAD");
    eq("enforcement/4.3 既存 PR の取り込み先が違えば計画しない", issuePlan(d, id, { repository: REPO, existing: PULL({ pull: { number: 7, url: "https://github.com/acme/app/pull/7", headOid: head, baseRef: "main" } }) }).error?.code, "base-conflict");
    eq("enforcement/4.3 既存 PR の head が準備時の commit と違えば、成功扱いせず計画しない", issuePlan(d, id, { repository: REPO, existing: PULL({ pull: { number: 7, url: "https://github.com/acme/app/pull/7", headOid: "0".repeat(40), baseRef: "develop" } }) }).error?.code, "pr-head-differs");
    eq("enforcement/4.3 既存 PR の検索が確定できなければ計画しない", issuePlan(d, id, { repository: REPO, existing: { ok: false, kind: "network" } }).error?.code, "pr-unconfirmed");
  });

  // ---- 禁止と通常確認待ちは計画から外す ----
  withReady({}, (d, id) => {
    publish.setRestrictions(d, id, { noPr: true });
    const x = issuePlan(d, id, { repository: REPO, existing: PULL() });
    eq("enforcement/4.3 PR 作成の禁止があれば PR を計画せず、許可された push だけ計画する", [x.ok, writesOf(x), x.excluded?.find((e) => e.operation === "pr")?.approval], [true, ["push"], "prohibited"]);
  });
  withReady({}, (d, id) => {
    publish.setRestrictions(d, id, { noPush: true });
    const x = issuePlan(d, id, { repository: REPO, existing: PULL() });
    eq("enforcement/4.3 push の禁止があれば push も PR も計画しない（PR は push の結果に続くため）", [x.ok, writesOf(x), x.excluded?.find((e) => e.operation === "push")?.approval, x.excluded?.find((e) => e.operation === "pr")?.code], [true, [], "prohibited", "push-not-planned"]);
  });
  withReady({ recorded: "dev/parent", config: { ...CONFIG, autoApprove: { push: false } } }, (d, id) => {
    const x = issuePlan(d, id, { repository: REPO });
    eq("enforcement/4.3 宣言で push の確認省略が無効なら push は計画せず、通常の承認に任せる", [x.ok, writesOf(x), x.excluded?.find((e) => e.operation === "push")?.approval], [true, [], "normal"]);
  });
  withReady({}, (d, id) => {
    const x = issuePlan(d, id, { repository: REPO, existing: PULL() });
    eq("enforcement/4.3 計画の発行は作業の禁止を変更しない", publish.readWork(d, id).work.restrictions, { noPush: false, noPr: false });
    eq("enforcement/4.3 計画の発行で作業の状態は準備済みのまま", publish.readWork(d, id).work.status, "ready");
    eq("enforcement/4.3 計画の書き込みが無い場合も計画を保存できる（禁止の理由は返す）", x.ok, true);
  });

  // ---- 途中まで公開済み（push 成功）の再計画では push を計画しない ----
  withReady({}, (d, id) => {
    publish.recordResult(d, id, "push", { outcome: "success" });
    publish.setStatus(d, id, "pushed");
    const x = issuePlan(d, id, { repository: REPO, existing: PULL() });
    eq("enforcement/4.3 push 成功の記録がある再計画では push を計画せず、PR だけ計画する", [x.ok, writesOf(x), x.excluded?.find((e) => e.operation === "push")?.code], [true, ["pr"], "already-pushed"]);
  });

  // ---- 発行の失敗（照合できないもの）は計画を作らない ----
  withReady({}, (d, id) => {
    eq("enforcement/4.3 対象リポジトリ ID が違えば計画しない", issuePlan(d, id, { repository: { ...REPO, id: 1 }, existing: PULL() }).error?.code, "destination-mismatch");
    eq("enforcement/4.3 対象リポジトリの入力が不正なら計画しない", issuePlan(d, id, { repository: { id: "4242", owner: "acme", name: "app" } }).error?.code, "repository-invalid");
  });
  withReady({}, (d, id) => {
    writeFileSync(join(d, "untracked.txt"), "未コミット");
    eq("enforcement/4.3 未コミットの変更があれば計画しない", issuePlan(d, id, { repository: REPO, existing: PULL() }).error?.code, "uncommitted");
    eq("enforcement/4.3 計画を拒否しても状態を変えない", [publish.readWork(d, id).work.plan ?? null, publish.readWork(d, id).work.status], [null, "ready"]);
  });
  withReady({}, (d, id) => {
    publish.pauseWork(d, id, "追加の指示待ち");
    eq("enforcement/4.3 中断中の作業は計画しない", issuePlan(d, id, { repository: REPO, existing: PULL() }).error?.code, "work-paused");
  });
  withReady({}, (d, id) => {
    gitOut(d, "commit", "-q", "--allow-empty", "-m", "準備後の commit");
    eq("enforcement/4.3 準備後に HEAD が進んでいれば計画しない", issuePlan(d, id, { repository: REPO, existing: PULL() }).error?.code, "head-changed");
  });

  // ---- 計画の検証（版の照合）と失効 ----
  withReady({ recorded: "dev/parent" }, (d, id) => {
    const x = issuePlan(d, id, { repository: REPO });
    eq("enforcement/4.3 発行直後の計画は有効と確認できる", checkPlan(d, id, x.plan?.planId).ok, true);
    eq("enforcement/4.3 別の計画 ID では有効と確認できない", checkPlan(d, id, "p-other").error?.code, "plan-not-found");

    publish.setRestrictions(d, id, { noPr: true });
    eq("enforcement/4.3 未適用の制限（禁止の追加）があると同じ作業の計画は使えず、書き込みを止める", checkPlan(d, id, x.plan?.planId).error?.code, "restrictions-changed");

    const y = issuePlan(d, id, { repository: REPO });
    eq("enforcement/4.3 禁止を反映して再計画すると、新しい計画は有効になる", [y.ok, checkPlan(d, id, y.plan?.planId).ok], [true, true]);
    eq("enforcement/4.3 再計画で作られた前の計画 ID は使えない", checkPlan(d, id, x.plan?.planId).error?.code, "plan-not-found");
  });
  withReady({ recorded: "dev/parent" }, (d, id) => {
    const x = issuePlan(d, id, { repository: REPO });
    gitOut(d, "commit", "-q", "--allow-empty", "-m", "計画の後の commit");
    eq("enforcement/4.3 計画の後に HEAD が変わると計画は失効する", checkPlan(d, id, x.plan?.planId).error?.code, "head-changed");
  });
  withReady({ recorded: "dev/parent" }, (d, id) => {
    const x = issuePlan(d, id, { repository: REPO });
    publish.pauseWork(d, id, "中断");
    eq("enforcement/4.3 中断された作業の計画は使えない", checkPlan(d, id, x.plan?.planId).error?.code, "work-paused");
  });
  withReady({ recorded: "dev/parent" }, (d, id) => {
    const x = issuePlan(d, id, { repository: REPO });
    publish.setStatus(d, id, "pushed");
    eq("enforcement/4.3 途中まで公開（pushed）の計画は引き続き検証できる", checkPlan(d, id, x.plan?.planId).ok, true);
    publish.recordResult(d, id, "push", { outcome: "success" });
    publish.setStatus(d, id, "published");
    eq("enforcement/4.3 公開済みになった作業の計画は使えない", checkPlan(d, id, x.plan?.planId).error?.kind, "conflict");
  });
  withReady({ recorded: "dev/parent" }, (d, id) => {
    const x = issuePlan(d, id, { repository: REPO });
    const f = publish.stateFileOf(d);
    const s = JSON.parse(readFileSync(f, "utf8"));
    s.works[id].ready.repositoryId = 1;
    writeFileSync(f, JSON.stringify(s));
    eq("enforcement/4.3 準備の記録（対象リポジトリ ID など）が変わると計画は失効する", checkPlan(d, id, x.plan?.planId).error?.code, "ready-changed");
  });
  withReady({ recorded: "dev/parent" }, (d, id) => {
    const x = issuePlan(d, id, { repository: REPO });
    const f = publish.stateFileOf(d);
    const s = JSON.parse(readFileSync(f, "utf8"));
    if (s.works[id].plan?.versions) s.works[id].plan.versions.declaration = "0".repeat(64);
    writeFileSync(f, JSON.stringify(s));
    eq("enforcement/4.3 宣言の版が計画と違えば計画は失効する", checkPlan(d, id, x.plan?.planId).error?.code, "declaration-changed");
  });
  withReady({ recorded: "dev/parent" }, (d, id) => {
    const x = issuePlan(d, id, { repository: REPO });
    writeFileSync(join(d, "untracked.txt"), "未コミット");
    eq("enforcement/4.3 計画の後に未コミットの変更があれば計画は使えない", checkPlan(d, id, x.plan?.planId).ok, false);
  });

  // ---- 遠隔を書き換えないことの確認（発行と検証のあとも bare remote の ref は無い） ----
  withReady({ recorded: "dev/parent" }, (d, id, remote) => {
    issuePlan(d, id, { repository: REPO });
    const refs = execFileSync("git", ["--git-dir", remote, "for-each-ref", "refs/heads/dev"], { encoding: "utf8" }).trim();
    eq("enforcement/4.3 計画の発行と検証は bare remote の開発ブランチを作らない・動かさない", refs, "");
  });

  // ---- 状態に秘密情報を残さない ----
  withReady({}, (d, id) => {
    const x = issuePlan(d, id, { repository: REPO, existing: PULL() });
    const text = stateText(d);
    eq("enforcement/4.3 状態ファイルに資格情報らしい値や PR 本文を残さない", [x.ok, text.includes("ghp_"), text.includes("本文")], [true, false, false]);
  });
};
