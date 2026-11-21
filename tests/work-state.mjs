// 作業 ID と中断・再開の記録（brw-enforcement 4.1）の契約テスト。selftest.mjs から呼ばれる。
import { existsSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { currentWork, getRestrictions, pauseWork, readWork, recordResult, resumeWork, setRestrictions, setStatus, startWork, stateFileOf } from "../scripts/publish.mjs";
import { evaluate, contextFor } from "../scripts/operation-decision.mjs";
import { classifyCommand } from "../scripts/operation-policy.mjs";
import { gitOut, mkRepoWithRemote, mkWorktree } from "./support/git-fixture.mjs";

const CONFIG = { workBranches: ["dev/*"], protectedBranches: ["main"], baseBranch: "develop" };

export const runWorkStateChecks = async (eq) => {
  const r = mkRepoWithRemote({ branch: "dev/foo", config: CONFIG });
  try {
    const d = r.dir;
    const head = gitOut(d, "rev-parse", "HEAD");

    // ---- 作業 ID の発行 ----
    const a = startWork(d, { sessionId: "s1" });
    eq("enforcement/2.2 作業を始めると作業 ID が発行され、進行中として記録される", [a.ok, typeof a.work.workId, a.work.status, a.work.branch, a.work.sessionId], [true, "string", "inProgress", "dev/foo", "s1"]);
    eq("enforcement/2.2 状態は worktree 単位の一時ファイルから置換して保存され、一時ファイルは残らない", [existsSync(stateFileOf(d)), readdirSync(join(stateFileOf(d), "..")).filter((n) => n.includes(".tmp")).length], [true, 0]);
    eq("enforcement/2.2 保存した状態は読み戻せる", readWork(d, a.work.workId).work, a.work);
    eq("enforcement/2.2 現在の作業は直近に始めた作業", currentWork(d).work.workId, a.work.workId);

    // ---- 禁止と結果の保存 ----
    eq("enforcement/2.6 作業の禁止を記録でき、判定へ渡せる形で読める", [setRestrictions(d, a.work.workId, { noPush: true }).ok, getRestrictions(d, a.work.workId)], [true, { noPush: true, noPr: false }]);
    eq("enforcement/2.6 禁止は追加のみで、同じ作業の再記録でも外れない", [setRestrictions(d, a.work.workId, { noPr: true }).ok, setRestrictions(d, a.work.workId, { noPush: false }).ok, getRestrictions(d, a.work.workId)], [true, true, { noPush: true, noPr: true }]);
    eq("enforcement/2.6 保存した禁止は共通判定で push を実行しない扱いにする", (() => {
      const op = classifyCommand("git push origin dev/foo", d).operations[0];
      return evaluate(op, contextFor(op, getRestrictions(d, a.work.workId))).approval;
    })(), "prohibited");
    eq("enforcement/2.7 操作別の結果を記録する", (() => {
      recordResult(d, a.work.workId, "push", { outcome: "prohibited", code: "work-restriction" });
      recordResult(d, a.work.workId, "pr", { outcome: "success", url: "https://github.com/acme/app/pull/3" });
      return readWork(d, a.work.workId).work.results;
    })(), { push: { outcome: "prohibited", code: "work-restriction" }, pr: { outcome: "success", code: null, url: "https://github.com/acme/app/pull/3" } });
    eq("enforcement/2.7 結果の種類・操作は決まった値だけ受け付ける", [recordResult(d, a.work.workId, "merge", { outcome: "success" }).error?.kind, recordResult(d, a.work.workId, "push", { outcome: "done" }).error?.kind], ["invalidInput", "invalidInput"]);
    eq("enforcement/2.7 PR 本文・資格情報などの余計な項目や秘密らしい値は記録しない", (() => {
      recordResult(d, a.work.workId, "push", { outcome: "failed", code: "network", body: "秘密の本文", token: "ghp_abcdefghijklmnopqrstuvwxyz0123456789", message: "ghp_abcdefghijklmnopqrstuvwxyz0123456789 で失敗" });
      pauseWork(d, a.work.workId, "token=ghp_abcdefghijklmnopqrstuvwxyz0123456789 を確認中");
      const text = readFileSync(stateFileOf(d), "utf8");
      return [text.includes("秘密の本文"), text.includes("ghp_abcdefghij"), readWork(d, a.work.workId).work.results.push];
    })(), [false, false, { outcome: "failed", code: "network" }]);
    resumeWork(d, a.work.workId);
    eq("enforcement/2.7 URL は https のものだけ記録する", recordResult(d, a.work.workId, "pr", { outcome: "success", url: "javascript:alert(1)" }).error?.kind, "invalidInput");
    eq("enforcement/2.7 認証情報・クエリ・フラグメント付きの URL は拒否し、状態ファイルに残さない", (() => {
      const bads = [
        "https://x-access-token:ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/a/b/pull/1",
        "https://u:p@github.com/a/b/pull/1",
        "https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/a/b/pull/1",
        "https://github.com/a/b/pull/1?token=abc123456789",
        "https://github.com/a/b/pull/1#secret-fragment",
        "https://github.com/a/b/pull/1?",
        "https://github.com/a/b/pull/1#",
      ];
      const kinds = bads.map((u) => recordResult(d, a.work.workId, "pr", { outcome: "success", url: u }).error?.kind);
      const text = readFileSync(stateFileOf(d), "utf8");
      return [kinds, ["x-access-token", "ghp_abcdefghij", "token=abc", "secret-fragment"].filter((s) => text.includes(s))];
    })(), [Array(7).fill("invalidInput"), []]);
    eq("enforcement/2.7 https の URL は origin と pathname に正規化して保存する", (() => {
      const x = recordResult(d, a.work.workId, "pr", { outcome: "success", url: "https://GitHub.com:443/acme/app/pull/3" });
      return [x.ok, readWork(d, a.work.workId).work.results.pr.url];
    })(), [true, "https://github.com/acme/app/pull/3"]);

    // ---- 同じセッション・HEAD での 2 件目 ----
    setStatus(d, a.work.workId, "ready");
    const b = startWork(d, { sessionId: "s1" });
    eq("enforcement/2.2 同じセッション・worktree・HEAD でも別の作業 ID になる", [b.ok, b.work.workId !== a.work.workId, gitOut(d, "rev-parse", "HEAD") === head], [true, true, true]);
    eq("enforcement/2.2 2 件目は 1 件目の公開済み状態・結果・禁止を引き継がない", [b.work.status, b.work.results, getRestrictions(d, b.work.workId), b.work.ready ?? null, b.work.pausedReason ?? null], ["inProgress", {}, { noPush: false, noPr: false }, null, null]);
    eq("enforcement/2.5 作業を切り替えると 1 件目は中断として記録され、禁止と結果は 1 件目に残る", (() => {
      const w = readWork(d, a.work.workId).work;
      return [typeof w.pausedReason, w.status, getRestrictions(d, a.work.workId), Object.keys(w.results).sort()];
    })(), ["string", "ready", { noPush: true, noPr: true }, ["pr", "push"]]);
    eq("enforcement/2.5 現在の作業は 2 件目に切り替わる", currentWork(d).work.workId, b.work.workId);

    // ---- 中断と明示再開 ----
    eq("enforcement/2.5 中断には理由が必要", pauseWork(d, b.work.workId, "").error?.kind, "invalidInput");
    eq("enforcement/2.5 中断を記録する", (() => { const p = pauseWork(d, b.work.workId, "追加の指示待ち"); return [p.ok, readWork(d, b.work.workId).work.pausedReason]; })(), [true, "追加の指示待ち"]);
    eq("enforcement/2.5 中断中の作業は現在の作業にならない", currentWork(d).work ?? null, null);
    eq("enforcement/2.5 作業 ID を明示した再開で中断が解け、現在の作業になる", (() => {
      const x = resumeWork(d, a.work.workId, { sessionId: "s2" });
      const w = readWork(d, a.work.workId).work;
      return [x.ok, w.pausedReason ?? null, w.sessionId, currentWork(d).work.workId];
    })(), [true, null, "s2", a.work.workId]);
    eq("enforcement/2.5 再開した作業も禁止を保持し、切り替え前の作業は中断される", [getRestrictions(d, a.work.workId), typeof readWork(d, b.work.workId).work.pausedReason], [{ noPush: true, noPr: true }, "string"]);
    eq("enforcement/2.5 存在しない作業 ID は再開できない", resumeWork(d, "w-none").error?.kind, "invalidInput");
    eq("enforcement/2.5 別のブランチの worktree からは再開できない", (() => {
      gitOut(d, "checkout", "-q", "-b", "dev/zzz");
      const x = resumeWork(d, a.work.workId);
      gitOut(d, "checkout", "-q", "dev/foo");
      return x.error?.kind;
    })(), "conflict");
    eq("enforcement/2.5 公開準備の後に HEAD が進んだ作業は再開時に準備済みを取り消す", (() => {
      // 準備済みの記録（4.2 が書く形）を直接置く
      const f = stateFileOf(d);
      const s = JSON.parse(readFileSync(f, "utf8"));
      s.works[b.work.workId].ready = { headOid: head, branch: "dev/foo" };
      s.works[b.work.workId].status = "ready";
      s.works[b.work.workId].results = { push: { outcome: "success", code: null }, pr: { outcome: "success", code: null, url: "https://github.com/acme/app/pull/9" }, other: { outcome: "x" } };
      writeFileSync(f, JSON.stringify(s));
      gitOut(d, "commit", "-q", "--allow-empty", "-m", "進んだ");
      const x = resumeWork(d, b.work.workId);
      const w = readWork(d, b.work.workId).work;
      return [x.ok, w.status, w.ready ?? null, w.results.push ?? null, w.results.pr ?? null];
    })(), [true, "inProgress", null, null, null]);
    eq("enforcement/2.5 HEAD が進んでいなければ再開しても準備済みと結果を取り消さない", (() => {
      const f = stateFileOf(d);
      const s = JSON.parse(readFileSync(f, "utf8"));
      const h = gitOut(d, "rev-parse", "HEAD");
      Object.assign(s.works[b.work.workId], { status: "ready", ready: { headOid: h, branch: "dev/foo" }, results: { push: { outcome: "success", code: null } } });
      writeFileSync(f, JSON.stringify(s));
      const x = resumeWork(d, b.work.workId);
      const w = readWork(d, b.work.workId).work;
      return [x.ok, w.status, w.results.push?.outcome];
    })(), [true, "ready", "success"]);
    eq("enforcement/2.5 検証用に inProgress へ戻す", (() => {
      const f = stateFileOf(d);
      const s = JSON.parse(readFileSync(f, "utf8"));
      delete s.works[b.work.workId].ready;
      s.works[b.work.workId].status = "inProgress";
      writeFileSync(f, JSON.stringify(s));
      return readWork(d, b.work.workId).work.status;
    })(), "inProgress");
    eq("enforcement/2.2 状態の遷移は決まった順だけ許す", [setStatus(d, b.work.workId, "published").error?.kind, setStatus(d, b.work.workId, "bogus").error?.kind], ["conflict", "invalidInput"]);
    eq("enforcement/2.2 公開済みの作業は再開できず、禁止などを保持する", (() => {
      setStatus(d, b.work.workId, "ready");
      setStatus(d, b.work.workId, "published");
      return [resumeWork(d, b.work.workId).error?.kind, readWork(d, b.work.workId).work.status];
    })(), ["conflict", "published"]);

    // ---- worktree 単位 ----
    resumeWork(d, a.work.workId);
    const wt = mkWorktree(d, "dev/wt");
    const c = startWork(wt, { sessionId: "s1" });
    eq("enforcement/2.2 別の worktree の状態は互いに独立する", [stateFileOf(wt) !== stateFileOf(d), readWork(wt, a.work.workId).ok, readWork(d, c.work.workId).ok, currentWork(wt).work.workId === c.work.workId, currentWork(d).work.workId], [true, false, false, true, a.work.workId]);
    eq("enforcement/2.2 ブランチの無い（detached）状態では作業を始めない", (() => {
      gitOut(d, "checkout", "-q", "--detach");
      const x = startWork(d, {});
      gitOut(d, "checkout", "-q", "dev/foo");
      return x.error?.kind;
    })(), "invalidInput");

    // ---- 壊れた状態・同時実行は安全側 ----
    eq("enforcement/2.7 壊れた状態ファイルでは作業を始めず、禁止は維持された扱いにする", (() => {
      writeFileSync(stateFileOf(d), "{broken");
      return [startWork(d, {}).error?.kind, currentWork(d).ok, getRestrictions(d, a.work.workId)];
    })(), ["conflict", false, { noPush: true, noPr: true }]);
    eq("enforcement/2.7 形が違う・空の状態ファイルでも作業を始めず、禁止は維持された扱いにする", (() => {
      const out = [];
      for (const text of ["", "[]", "null", JSON.stringify({ version: 2, works: {} })]) {
        writeFileSync(stateFileOf(d), text);
        out.push([startWork(d, {}).error?.kind, getRestrictions(d, a.work.workId)]);
      }
      return out;
    })(), Array(4).fill(["conflict", { noPush: true, noPr: true }]));
    eq("enforcement/2.7 restrictions 項目が欠けた作業は禁止ありとして扱う", (() => {
      const id = "w-abc-0123abcd";
      const mk = (restrictions) => {
        const w = { workId: id, status: "inProgress", results: {} };
        if (restrictions !== undefined) w.restrictions = restrictions;
        writeFileSync(stateFileOf(d), JSON.stringify({ version: 1, worktreeId: "x", current: null, works: { [id]: w } }));
        return getRestrictions(d, id);
      };
      return [mk(undefined), mk({}), mk({ noPush: false }), mk({ noPush: "no", noPr: false }), mk(null), mk({ noPush: false, noPr: false })];
    })(), [{ noPush: true, noPr: true }, { noPush: true, noPr: true }, { noPush: true, noPr: true }, { noPush: true, noPr: true }, { noPush: true, noPr: true }, { noPush: false, noPr: false }]);
    eq("enforcement/2.7 持ち主のいない古いロックは外して更新できる", (() => {
      writeFileSync(stateFileOf(wt), JSON.stringify({ version: 1, worktreeId: "x", works: {}, current: null }));
      const lock = stateFileOf(wt) + ".lock";
      writeFileSync(lock, "2147483646");
      const old = new Date(Date.now() - 120_000);
      utimesSync(lock, old, old);
      const x = startWork(wt, { lockWaitMs: 500 });
      return [x.ok, existsSync(lock), readdirSync(join(stateFileOf(wt), "..")).filter((n) => n.includes(".stale")).length];
    })(), [true, false, 0]);
    eq("enforcement/2.7 別プロセスが状態ロックを保持している間は書き込まず衝突を返す", (() => {
      writeFileSync(stateFileOf(wt), JSON.stringify({ version: 1, worktreeId: "x", works: {}, current: null }));
      writeFileSync(stateFileOf(wt) + ".lock", String(process.pid));
      const x = startWork(wt, { lockWaitMs: 50 });
      return [x.error?.kind, readFileSync(stateFileOf(wt), "utf8").includes("works")];
    })(), ["conflict", true]);
  } finally {
    r.cleanup();
  }
};
