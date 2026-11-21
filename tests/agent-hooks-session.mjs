// 作業 ID の関連付け（PostToolUse）と終了時の案内（Stop）の契約テスト（brw-enforcement 6.2）。selftest.mjs から呼ばれる。
// 実際のホストは呼ばず、入力の形（fixture）と応答の形を確かめる。遠隔（bare remote）と GitHub には触れない。
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as publish from "../scripts/publish.mjs";
import { gitOut, mkRepoWithRemote } from "./support/git-fixture.mjs";
import { hookInput } from "./support/hook-fixtures.mjs";

// scripts/agent-hooks.mjs は 6.2 で拡張する。未実装の間も失敗として数えられるよう、名前が無くても落ちない形にする
const agentModule = await import("../scripts/agent-hooks.mjs").catch(() => null);
const handleHook = agentModule?.handleHook ?? (() => ({ missing: "未実装" }));
// 関連付けの関数も同様に、未実装なら失敗として数える
const attachSession = publish.attachSession ?? (() => ({ ok: false, error: { kind: "missing", message: "未実装" } }));

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BRW = join(root, "scripts/brw.mjs");
const CONFIG = { workBranches: ["dev/*"], protectedBranches: ["main"], baseBranch: "develop" };
const GH = "https://github.com/acme/app.git";
const REPO = { id: 4242, owner: "acme", name: "app" };
const DONE = "依頼の完了条件を満たした";
const VERIFIED = { passed: true, summary: "npm test が成功" };
const SESSION = "claude-s1";
const OTHER = "claude-s2";
const SECRET = "ghp_abcdefghij0123456789";

/** 一時リポジトリ。origin を GitHub の形にする（判定と計画の照合に使う。通信はしない）。 */
const repoOf = () => {
  const r = mkRepoWithRemote({ branch: "dev/foo", config: CONFIG });
  gitOut(r.dir, "remote", "set-url", "origin", GH);
  return r;
};

/** 成功した `brw work start` の PostToolUse 入力（tool_response を指定の形にする）。 */
const postOf = (host, dir, command, response, sessionId = SESSION) => {
  const ev = hookInput(host, "PostToolUse", { cwd: dir, command, sessionId });
  if (response !== undefined) ev.tool_response = response;
  return handleHook(host, "PostToolUse", ev);
};
const START = (dir) => `node ${BRW} work start`;
const RESUME = (id) => `node ${BRW} work resume --work ${id}`;
const ok = (stdout) => ({ exit_code: 0, stdout });

/** Stop の入力。stopActive は stop_hook_active、omit は欠落させる項目。 */
const stopOf = (host, dir, { sessionId = SESSION, stopActive = false, omit = [] } = {}) => {
  const ev = hookInput(host, "Stop", { cwd: dir, sessionId, omit });
  ev.stop_hook_active = stopActive;
  return handleHook(host, "Stop", ev);
};

const workOf = (dir, id) => publish.readWork(dir, id).work;
const stateText = (dir) => readFileSync(publish.stateFileOf(dir), "utf8");

/** 準備済み（ready）まで進めた作業を用意する。sessionId を PostToolUse で関連付ける。 */
const readyWork = (dir, { host = "claude", session = SESSION } = {}) => {
  const id = publish.startWork(dir, {}).work.workId;
  postOf(host, dir, START(dir), ok(`作業を開始しました: ${id}`), session);
  const ready = publish.markReady(dir, id, { completion: DONE, verification: VERIFIED, repository: REPO });
  if (!ready.ok) throw new Error(`準備に失敗: ${ready.error?.code}`);
  return id;
};

const block = (r) => r?.decision === "block" && typeof r.reason === "string";

export const runAgentHookSessionChecks = async (eq) => {
  // ---- PostToolUse: 正常な作業開始・再開の関連付け ----
  {
    const r = repoOf();
    try {
      const id = publish.startWork(r.dir, {}).work.workId;
      const res = postOf("claude", r.dir, START(r.dir), ok(`作業を開始しました: ${id}\n  worktree: ${r.dir}`));
      eq("enforcement/2.2 Claude の PostToolUse は正常な work start の作業 ID を関連付け、応答は返さない", [res, workOf(r.dir, id).sessionId], [null, SESSION]);
    } finally {
      r.cleanup();
    }
  }
  {
    const r = repoOf();
    try {
      const id = publish.startWork(r.dir, {}).work.workId;
      const res = postOf("codex", r.dir, START(r.dir), ok(`作業を開始しました: ${id}`), "codex-s1");
      eq("enforcement/2.2 Codex の PostToolUse も同じ基準で関連付け、応答は返さない", [res, workOf(r.dir, id).sessionId], [null, "codex-s1"]);
    } finally {
      r.cleanup();
    }
  }
  {
    // 失敗・中断・不正な呼び出し・不正な出力では記録しない
    const r = repoOf();
    try {
      const id = publish.startWork(r.dir, {}).work.workId;
      const out = `作業を開始しました: ${id}`;
      postOf("claude", r.dir, START(r.dir), { exit_code: 1, stdout: out });
      postOf("claude", r.dir, START(r.dir), { exit_code: 0, stdout: out, interrupted: true });
      postOf("claude", r.dir, START(r.dir), { stdout: out });
      postOf("claude", r.dir, START(r.dir), undefined);
      postOf("claude", r.dir, `node ${join(r.dir, "brw.mjs")} work start`, ok(out));
      postOf("claude", r.dir, `node ${BRW} work start --extra`, ok(out));
      postOf("claude", r.dir, `node ${BRW} work start; ls`, ok(out));
      postOf("claude", r.dir, START(r.dir), ok("作業を開始しました"));
      postOf("claude", r.dir, START(r.dir), ok(`${id} と w-old-deadbeef の両方`), "bad session id");
      eq("enforcement/2.2 失敗・中断・信頼できない呼び出し・ID の無い出力では記録しない", workOf(r.dir, id).sessionId, undefined);
      postOf("claude", r.dir, "git status", ok(out));
      const readEv = hookInput("claude", "PostToolUse", { cwd: r.dir, sessionId: SESSION });
      readEv.tool_name = "Read";
      readEv.tool_input = { file_path: "/x" };
      handleHook("claude", "PostToolUse", readEv);
      eq("enforcement/2.2 Bash 以外のツールは作業の関連付けに使わない", workOf(r.dir, id).sessionId, undefined);
    } finally {
      r.cleanup();
    }
  }
  {
    // 同じ HEAD の別作業を取り違えない: 現在の作業（state の current）と一致する ID だけを採る
    const r = repoOf();
    try {
      const id1 = publish.startWork(r.dir, {}).work.workId;
      const id2 = publish.startWork(r.dir, {}).work.workId;
      postOf("claude", r.dir, START(r.dir), ok(`作業を開始しました: ${id1}`));
      eq("enforcement/2.2 現在でない作業（同じ HEAD の前の作業）の ID は関連付けない", [workOf(r.dir, id1).sessionId, workOf(r.dir, id2).sessionId], [undefined, undefined]);
      postOf("claude", r.dir, START(r.dir), ok(`前の作業 ${id1} を中断し、作業を開始しました: ${id2}`));
      eq("enforcement/2.2 出力に複数の ID があっても、現在の作業だけを関連付ける", [workOf(r.dir, id1).sessionId, workOf(r.dir, id2).sessionId], [undefined, SESSION]);
    } finally {
      r.cleanup();
    }
  }
  {
    // 再開: 中断した作業を明示 ID で再開したときだけ関連付ける
    const r = repoOf();
    try {
      const id1 = publish.startWork(r.dir, {}).work.workId;
      publish.pauseWork(r.dir, id1, "調査のため中断");
      publish.resumeWork(r.dir, id1);
      const res = postOf("claude", r.dir, RESUME(id1), ok(`作業を再開しました: ${id1}`), OTHER);
      eq("enforcement/2.2 明示 ID の再開を関連付ける（セッションは再開したホストのもの）", [res, workOf(r.dir, id1).sessionId], [null, OTHER]);
      publish.pauseWork(r.dir, id1, "再度中断");
      const id2 = publish.startWork(r.dir, {}).work.workId;
      postOf("claude", r.dir, RESUME(id1), ok(`作業を再開しました: ${id1}`), "claude-s3");
      // 中断（7.2）で関連付けは解除済み。食い違う再開で claude-s3 が付かないことを確かめる
      eq("enforcement/2.2 --work と現在の作業が食い違う再開は関連付けない", [workOf(r.dir, id1).sessionId, workOf(r.dir, id2).sessionId], [undefined, undefined]);
      postOf("claude", r.dir, RESUME(id2), ok(`作業を再開しました: ${id1}`), "claude-s4");
      eq("enforcement/2.2 出力の ID が --work と食い違う再開は関連付けない", workOf(r.dir, id2).sessionId, undefined);
    } finally {
      r.cleanup();
    }
  }
  {
    // 状態が壊れていれば記録せず、例外も出さない（状態の中身は変えない）
    const r = repoOf();
    try {
      const id = publish.startWork(r.dir, {}).work.workId;
      writeFileSync(publish.stateFileOf(r.dir), "{oops");
      let threw = false;
      try { postOf("claude", r.dir, START(r.dir), ok(`作業を開始しました: ${id}`)); } catch { threw = true; }
      eq("enforcement/2.2 状態が壊れていれば関連付けず、例外も出さず、状態を書き換えない", [threw, stateText(r.dir)], [false, "{oops"]);
    } finally {
      r.cleanup();
    }
  }
  {
    // 関連付けの関数: 現在の作業だけ、公開済みでなければ関連付けられる
    const r = repoOf();
    try {
      const id1 = publish.startWork(r.dir, {}).work.workId;
      const id2 = publish.startWork(r.dir, {}).work.workId;
      const notCurrent = attachSession(r.dir, id1, SESSION);
      const cur = attachSession(r.dir, id2, SESSION);
      eq("enforcement/2.2 関連付けは現在の作業だけに許し、他の作業は conflict にする", [notCurrent.ok, notCurrent.error?.kind, cur.ok, workOf(r.dir, id2).sessionId], [false, "conflict", true, SESSION]);
      eq("enforcement/2.2 関連付けは不正な ID・セッション ID を invalidInput で拒否する", [attachSession(r.dir, "x", SESSION).error?.kind, attachSession(r.dir, id2, "a b").error?.kind], ["invalidInput", "invalidInput"]);
    } finally {
      r.cleanup();
    }
  }

  // ---- Stop: 準備済みで未公開の作業だけを案内する ----
  {
    const r = repoOf();
    try {
      const id = readyWork(r.dir);
      const c = stopOf("claude", r.dir);
      eq("enforcement/2.5 準備済みで未公開の作業があれば、Claude は block の応答で作業 ID の再試行と中断を案内する", [block(c), c?.reason?.includes(id), c?.reason?.includes(`brw publish --work ${id}`), c?.reason?.includes(`brw pause --work ${id}`)], [true, true, true, true]);
      const again1 = stopOf("claude", r.dir)?.reason;
      const again2 = stopOf("claude", r.dir)?.reason;
      eq("enforcement/2.5 同じ作業の案内は何度でも同じ内容になる（再試行）", [typeof again1 === "string", again1 === c?.reason, again2 === c?.reason], [true, true, true]);
      eq("enforcement/2.5 Codex の Stop も同じ作業を案内する", block(stopOf("codex", r.dir)), true);
      eq("enforcement/2.5 stop_hook_active が真なら案内せず終了させる（無限ループ防止）", stopOf("claude", r.dir, { stopActive: true }), null);
      eq("enforcement/2.5 別のセッションの作業は案内しない", stopOf("claude", r.dir, { sessionId: OTHER }), null);
      eq("enforcement/2.5 セッション ID が無い入力は案内せず終了させる", stopOf("claude", r.dir, { omit: ["session_id"] }), null);
      const before = stateText(r.dir);
      const entriesBefore = readdirSync(join(publish.stateFileOf(r.dir), "..")).sort();
      stopOf("claude", r.dir);
      stopOf("codex", r.dir);
      eq("enforcement/2.5 Stop は状態を書き換えず、一時ファイルやロックも作らない", [stateText(r.dir) === before, readdirSync(join(publish.stateFileOf(r.dir), "..")).sort().join() === entriesBefore.join()], [true, true]);
      eq("enforcement/2.5 案内の文面に資格情報を含めない", JSON.stringify(c).includes(SECRET), false);
      const paused = publish.pauseWork(r.dir, id, "中断");
      eq("enforcement/2.5 中断済みの作業は案内しない", [paused.ok, stopOf("claude", r.dir)], [true, null]);
    } finally {
      r.cleanup();
    }
  }
  {
    // 作業途中・調査のみ（inProgress）は案内しない
    const r = repoOf();
    try {
      const id = publish.startWork(r.dir, {}).work.workId;
      postOf("claude", r.dir, START(r.dir), ok(`作業を開始しました: ${id}`));
      eq("enforcement/2.5 作業途中（inProgress）の作業は案内せず終了させる", stopOf("claude", r.dir), null);
    } finally {
      r.cleanup();
    }
  }
  {
    // 禁止の追加: noPush が残ると、準備済みの push は行えないので案内しない。noPr だけなら push は残るので案内する
    const r = repoOf();
    try {
      const id = readyWork(r.dir);
      publish.setRestrictions(r.dir, id, { noPr: true });
      eq("enforcement/2.6 noPr だけが加わったときは、未済の push があるので案内する", block(stopOf("claude", r.dir)), true);
      publish.setRestrictions(r.dir, id, { noPush: true });
      eq("enforcement/2.6 noPush が加わり明示禁止だけが残るときは案内せず終了させる", stopOf("claude", r.dir), null);
    } finally {
      r.cleanup();
    }
  }
  {
    // push 済みの作業: PR が残るなら案内し、noPr で PR が残らないなら案内しない
    const r = repoOf();
    try {
      const id = readyWork(r.dir);
      publish.setStatus(r.dir, id, "pushed");
      eq("enforcement/2.6 push 済みで PR が残る作業は案内する", block(stopOf("claude", r.dir)), true);
      publish.setRestrictions(r.dir, id, { noPr: true });
      eq("enforcement/2.6 push 済みで PR だけが禁止なら案内しない", stopOf("claude", r.dir), null);
    } finally {
      r.cleanup();
    }
  }
  {
    // 準備の後に HEAD が変わった作業は、再開して準備をやり直す案内に変える
    const r = repoOf();
    try {
      const id = readyWork(r.dir);
      gitOut(r.dir, "commit", "--allow-empty", "-m", "準備の後の変更");
      const c = stopOf("claude", r.dir);
      eq("enforcement/2.5 準備の後に HEAD が変わった作業は、再開を案内する", [block(c), c?.reason?.includes(`brw work resume --work ${id}`)], [true, true]);
    } finally {
      r.cleanup();
    }
  }
  {
    // 同じ HEAD の別作業を取り違えない: 準備済みの作業を後から始めた作業が中断させた場合、案内はどちらにも出ない
    const r = repoOf();
    try {
      const id1 = readyWork(r.dir);
      const id2 = publish.startWork(r.dir, {}).work.workId;
      postOf("claude", r.dir, START(r.dir), ok(`作業を開始しました: ${id2}`), OTHER);
      eq("enforcement/2.2 同じ HEAD で別の作業を始めたら、前の準備済みの作業は中断扱いで案内しない", [workOf(r.dir, id1).pausedReason !== undefined, stopOf("claude", r.dir), stopOf("claude", r.dir, { sessionId: OTHER })], [true, null, null]);
    } finally {
      r.cleanup();
    }
  }
  {
    // 関連付け不能（記録が無い・Git の外・状態が壊れている）では案内せず終了させる
    const r = repoOf();
    const outside = mkdtempSync(join(tmpdir(), "brw-nogit-"));
    try {
      readyWork(r.dir, { session: "unrelated" });
      const noRecord = stopOf("claude", r.dir);
      const notRepo = stopOf("claude", outside);
      writeFileSync(publish.stateFileOf(r.dir), "{oops");
      const broken = stopOf("claude", r.dir, { sessionId: "unrelated" });
      eq("enforcement/2.5 関連付けられない・Git の外・状態が壊れている場合は案内せず終了させる", [noRecord, notRepo, broken], [null, null, null]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
      r.cleanup();
    }
  }
};
