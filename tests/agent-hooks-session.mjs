// 作業 ID の関連付け（PostToolUse）と終了時の案内（Stop）の契約テスト（brw-enforcement 6.2）。selftest.mjs から呼ばれる。
// 実際のホストは呼ばず、入力の形（fixture）と応答の形を確かめる。遠隔（bare remote）と GitHub には触れない。
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as publish from "../scripts/publish.mjs";
import * as remainder from "../scripts/work-remainder.mjs";
import { gitOut, mkRepoWithRemote, mkWorktree } from "./support/git-fixture.mjs";
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
  // 導入済みの形に近づける: 恒常的な分岐元（develop）がリモートにある（分岐元の commit を未 push と数えないため。16.3 で追加）
  gitOut(r.dir, "push", "-q", "origin", "main:refs/heads/develop");
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
    // 実機（8.4）で確認した tool_response の形。Claude は exit_code が無く interrupted:false、Codex は出力の文字列だけが届く
    const claudeReal = (stdout, extra = {}) => ({ stdout, stderr: "", interrupted: false, isImage: false, noOutputExpected: false, ...extra });
    const r = repoOf();
    try {
      const id = publish.startWork(r.dir, {}).work.workId;
      postOf("claude", r.dir, START(r.dir), claudeReal(id, { interrupted: true }));
      postOf("codex", r.dir, START(r.dir), `node:fs:1364\nError: ENOENT, mkdir '/x/.git/brw/work'\n    at ${id}`, "codex-s1");
      postOf("codex", r.dir, START(r.dir), `${id}\n${id}`, "codex-s1");
      eq("enforcement/2.2 実機の形でも、中断・失敗の出力（ID だけでない文字列）では記録しない", workOf(r.dir, id).sessionId, undefined);
      postOf("claude", r.dir, START(r.dir), claudeReal(id));
      eq("enforcement/2.2 実機の Claude の形（exit_code なし・interrupted:false）で記録する", workOf(r.dir, id).sessionId, SESSION);
    } finally {
      r.cleanup();
    }
    const r2 = repoOf();
    try {
      const id = publish.startWork(r2.dir, {}).work.workId;
      postOf("codex", r2.dir, START(r2.dir), `注意: 進行中の作業 w-old-deadbeef を中断して、新しい作業を始めます。\n${id}\n`, "codex-s1");
      eq("enforcement/2.2 実機の Codex の形（出力の文字列。注意の行を除いて ID だけ）で記録する", workOf(r2.dir, id).sessionId, "codex-s1");
    } finally {
      r2.cleanup();
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
      eq("enforcement/2.5 準備済みで未公開の作業があれば、Claude は block の応答で作業 ID の再試行と中断を案内する", [block(c), c?.reason?.includes(id), c?.reason?.includes(`.mjs' publish --work ${id}`), c?.reason?.includes(`.mjs' pause --work ${id}`)], [true, true, true, true]);
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
      eq("enforcement/2.5 準備の後に HEAD が変わった作業は、再開を案内する", [block(c), c?.reason?.includes(`.mjs' work resume --work ${id}`)], [true, true]);
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

  // ---- Stop: 作業ブランチの残りの案内（brw-enforcement 16.3。公開の案内と 1 つの block に統合する） ----
  const RPFX = "[branch-release-workflow] ";
  const REMAIN_DIRTY = "未コミットの変更が残っている開発ブランチがあります。";
  const REMAIN_UNPUSHED = "未 push の commit が残っている開発ブランチがあります。";
  const writeNew = (dir) => writeFileSync(join(dir, "new.txt"), "x\n");
  {
    // 残りの案内の基本: 未コミット・未 push（作業の記録もセッション ID も無い状態で評価する）
    const r = repoOf();
    try {
      // 追跡ブランチを模擬する（repoOf の origin は GitHub の形のため、push ではなく参照を進める）
      gitOut(r.dir, "update-ref", "refs/remotes/origin/dev/foo", "HEAD");
      eq("enforcement/2.13 push 済みで clean（調査のみ）なら残りを案内しない", stopOf("claude", r.dir), null);
      writeNew(r.dir);
      const c = stopOf("claude", r.dir);
      eq("enforcement/2.9 作業の記録が無くても、未コミットの変更があれば Claude は block で案内する", [block(c), c?.reason?.startsWith(RPFX + REMAIN_DIRTY), c?.reason?.includes("git commit")], [true, true, true]);
      eq("enforcement/2.9 セッション ID が無くても、残りを block で案内する", block(stopOf("claude", r.dir, { omit: ["session_id"] })), true);
      eq("enforcement/2.9 Codex の Stop も同じ残りを同じ応答で案内する", stopOf("codex", r.dir), c);
      eq("enforcement/2.9 stop_hook_active が真の再入では残りを案内せず終了させる", stopOf("claude", r.dir, { stopActive: true }), null);
      rmSync(join(r.dir, "new.txt"));
      gitOut(r.dir, "commit", "--allow-empty", "-q", "-m", "未 push の commit");
      const u = stopOf("claude", r.dir);
      eq("enforcement/2.9 未 push の commit だけでも block で案内する", [block(u), u?.reason?.startsWith(RPFX + REMAIN_UNPUSHED)], [true, true]);
      eq("enforcement/2.9 残りの案内でも作業の記録を作らない（読み取りだけ）", existsSync(join(r.dir, ".git", "brw")), false);
    } finally {
      r.cleanup();
    }
  }
  {
    // 制限: noPush の作業では未 push を理由にせず、未コミットだけを commit までの案内にする
    const r = repoOf();
    try {
      gitOut(r.dir, "update-ref", "refs/remotes/origin/dev/foo", "HEAD");
      const id = publish.startWork(r.dir, {}).work.workId;
      publish.setRestrictions(r.dir, id, { noPush: true });
      gitOut(r.dir, "commit", "--allow-empty", "-q", "-m", "未 push の commit");
      const unpushedOnly = stopOf("claude", r.dir);
      writeNew(r.dir);
      const c = stopOf("claude", r.dir);
      eq("enforcement/2.16 push 禁止の作業で未 push だけなら、残りを案内しない", unpushedOnly, null);
      eq("enforcement/2.16 push 禁止でも未コミットがあれば、commit までにとどめる案内にし、未 push を理由にしない", [block(c), c?.reason?.includes("commit までにとどめ"), c?.reason?.includes("未 push の commit"), c?.reason?.includes("git push")], [true, true, false, false]);
    } finally {
      r.cleanup();
    }
  }
  {
    // 宣言の autoApprove.push が明示的に false: 未 push は理由にしない。未指定（上の基本）は理由にする
    const r = mkRepoWithRemote({ branch: "dev/foo", config: { ...CONFIG, autoApprove: { push: false } } });
    try {
      gitOut(r.dir, "commit", "--allow-empty", "-q", "-m", "未 push の commit");
      const unpushedOnly = stopOf("claude", r.dir);
      writeNew(r.dir);
      const c = stopOf("codex", r.dir);
      eq("enforcement/2.16 宣言の autoApprove.push: false では、未 push だけなら理由にしない", unpushedOnly, null);
      eq("enforcement/2.16 宣言の autoApprove.push: false でも未コミットは commit までの案内にする", [block(c), c?.reason?.includes("commit までにとどめ"), c?.reason?.includes("git push")], [true, true, false]);
    } finally {
      r.cleanup();
    }
  }
  {
    // Stop の cwd が clean な本体（保護ブランチ）で、別の worktree の開発ブランチに残りがある場合（Codex の実機の形）
    const r = mkRepoWithRemote({ branch: "main", config: CONFIG });
    const wt = mkWorktree(r.dir, "dev/wt");
    let devPath = null;
    try {
      gitOut(wt, "push", "-q", "-u", "origin", "dev/wt");
      eq("enforcement/2.9 すべての worktree が clean で push 済みなら、本体からでも止めない", [stopOf("claude", r.dir), stopOf("codex", r.dir)], [null, null]);
      writeNew(wt);
      const c = stopOf("codex", r.dir);
      eq("enforcement/2.9 cwd が clean な本体でも、別の worktree の開発ブランチの残りを block で案内する（Codex の形）", [block(c), c?.reason?.includes(wt), c?.reason?.includes(`cd '${wt}'`)], [true, true, true]);
      eq("enforcement/2.9 Claude の cwd が clean な本体でも同じ応答になる", stopOf("claude", r.dir), c);
      rmSync(join(wt, "new.txt"));
      // 保護ブランチ・恒常的な分岐元（develop）側の worktree の変更は対象にしない
      gitOut(r.dir, "branch", "develop");
      devPath = mkdtempSync(join(tmpdir(), "brw-dev-wt-"));
      rmSync(devPath, { recursive: true, force: true });
      gitOut(r.dir, "worktree", "add", "-q", devPath, "develop");
      writeFileSync(join(devPath, "base.txt"), "x\n");
      eq("enforcement/2.18 基底（develop）側の worktree の変更は案内しない", stopOf("codex", r.dir), null);
    } finally {
      if (devPath) {
        try { gitOut(r.dir, "worktree", "remove", "--force", devPath); } catch { /* 無ければ無視 */ }
        rmSync(devPath, { recursive: true, force: true });
      }
      r.cleanup();
    }
  }
  {
    // 公開の案内と残りの案内が両方あるとき、公開を先に並べ、1 つの block にする。公開だけなら従来の文面と同一
    const r = repoOf();
    try {
      const id = readyWork(r.dir);
      const pubOnly = stopOf("claude", r.dir);
      eq("enforcement/2.5 公開の案内だけなら、従来の文面（残りの案内を含まない）", [pubOnly?.reason?.startsWith(`${RPFX}準備済みで公開が終わっていない作業があります。次のいずれかを行ってから終了してください。\n- 作業 ${id}: `), pubOnly?.reason?.includes("未コミット")], [true, false]);
      writeNew(r.dir);
      const both = stopOf("claude", r.dir);
      eq("enforcement/2.16 公開と残りが両方あれば 1 つの block にし、公開を先、空行を挟んで残りを並べる", [block(both), both?.reason?.startsWith(pubOnly.reason + "\n\n"), both?.reason?.includes("\n\n" + REMAIN_DIRTY), both?.reason?.split(RPFX).length], [true, true, true, 2]);
      eq("enforcement/2.16 両方あるときの Codex も同じ応答", stopOf("codex", r.dir), both);
      eq("enforcement/2.16 stop_hook_active の再入では両方とも案内しない", stopOf("claude", r.dir, { stopActive: true }), null);
    } finally {
      r.cleanup();
    }
  }
  {
    // 状態・ロック・設定を書き換えない（残りの案内の評価の前後で、状態ファイル・ディレクトリ・宣言・作業ツリーが同じ）
    const r = repoOf();
    try {
      readyWork(r.dir);
      writeNew(r.dir);
      const stateBefore = stateText(r.dir);
      const dirBefore = readdirSync(join(publish.stateFileOf(r.dir), "..")).sort().join();
      const statusBefore = gitOut(r.dir, "status", "--porcelain");
      const cfgBefore = readFileSync(join(r.dir, ".branch-release-workflow.json"), "utf8");
      stopOf("claude", r.dir);
      stopOf("codex", r.dir);
      stopOf("claude", r.dir, { stopActive: true });
      eq("enforcement/2.13 残りの案内の評価は状態・ディレクトリ・宣言・作業ツリーを書き換えない", [stateText(r.dir) === stateBefore, readdirSync(join(publish.stateFileOf(r.dir), "..")).sort().join() === dirBefore, gitOut(r.dir, "status", "--porcelain") === statusBefore, readFileSync(join(r.dir, ".branch-release-workflow.json"), "utf8") === cfgBefore], [true, true, true, true]);
    } finally {
      r.cleanup();
    }
  }
  {
    // Git の外の cwd では残りを案内せず、例外も出さない
    const outside = mkdtempSync(join(tmpdir(), "brw-nogit2-"));
    try {
      eq("enforcement/2.9 Git の外の cwd では残りを案内せず、例外も出さない", stopOf("claude", outside), null);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  }
  {
    // 本体のパスに空白・日本語・改行を含み、宣言に autoApprove.push: false がある（改行を含むパスは worktree list の行では読めない）
    const r = mkRepoWithRemote({ branch: "dev/foo", config: { ...CONFIG, autoApprove: { push: false } } });
    const dir = join(dirname(r.dir), "作業 本体\n改行");
    try {
      gitOut(r.dir, "push", "-q", "origin", "main:refs/heads/develop");
      gitOut(r.dir, "update-ref", "refs/remotes/origin/dev/foo", "HEAD");
      renameSync(r.dir, dir);
      eq("enforcement/2.16 本体のパスを改行を含む実パスとして読み、宣言の autoApprove.push: false を読める", [remainder.mainWorktreeOf?.(dir) ?? null, remainder.declaredNoPushOf?.(dir) ?? null], [dir, true]);
      gitOut(dir, "commit", "--allow-empty", "-q", "-m", "未 push の commit");
      eq("enforcement/2.16 特殊なパスの本体でも、宣言の autoApprove.push: false なら未 push だけでは block しない", stopOf("claude", dir), null);
      writeFileSync(join(dir, "new.txt"), "x\n");
      const c = stopOf("codex", dir);
      eq("enforcement/2.16 特殊なパスの本体で未コミットがあれば、commit までの案内にし、未 push を理由にしない", [block(c), c?.reason?.includes("commit までにとどめ"), c?.reason?.includes("git push")], [true, true, false]);
    } finally {
      r.cleanup();
    }
  }
  // ---- brw guard --finish: 終了前の残りの確認（brw-enforcement 16.4。Stop と同じ判定を、コマンドを渡さずに行う） ----
  const FIN_ALLOW = "[allow] 未コミットの変更も未 push の commit も残っていません。";
  const BLOCK = "[block] ";
  const finishOf = (dir, args = ["--finish"]) => {
    const g = spawnSync("node", [BRW, "guard", ...args], { cwd: dir, encoding: "utf8" });
    return { status: g.status, out: g.stdout, err: g.stderr };
  };
  {
    // 残りあり（未コミット）: [block] と終了コード 1。案内に worktree のパスと commit の手順を含み、Stop の reason 本文と同じ
    const r = repoOf();
    try {
      gitOut(r.dir, "update-ref", "refs/remotes/origin/dev/foo", "HEAD");
      eq("enforcement/2.19 残りが無ければ [allow] と終了コード 0 を返す", finishOf(r.dir), { status: 0, out: `${FIN_ALLOW}\n`, err: "" });
      writeNew(r.dir);
      const f = finishOf(r.dir);
      const stopBody = (stopOf("claude", r.dir)?.reason ?? "").slice(RPFX.length);
      eq("enforcement/2.19 未コミットがあれば [block] で終了コード 1、案内に worktree のパスと commit の手順を含む", [f.status, f.out.startsWith(BLOCK), f.out.includes(r.dir), f.out.includes("git commit"), f.err], [1, true, true, true, ""]);
      eq("enforcement/2.19 [block] の案内本文は Stop の reason 本文と同じ（接頭辞を除く）", [f.out.slice(BLOCK.length).trimEnd(), stopBody], [stopBody, stopBody]);
      rmSync(join(r.dir, "new.txt"));
      gitOut(r.dir, "commit", "--allow-empty", "-q", "-m", "未 push の commit");
      const u = finishOf(r.dir);
      eq("enforcement/2.19 未 push の commit だけでも [block] で終了コード 1 を返す", [u.status, u.out.startsWith(BLOCK), u.out.includes("未 push の commit")], [1, true, true]);
    } finally {
      r.cleanup();
    }
  }
  {
    // 対象外（保護ブランチ・宣言外のブランチ）と、未導入のリポジトリ・Git の外は [allow]（判定できない側に倒す）
    const r = mkRepoWithRemote({ branch: "main", config: CONFIG });
    const plain = mkRepoWithRemote({ branch: "dev/foo", config: null });
    const outside = mkdtempSync(join(tmpdir(), "brw-nogit3-"));
    try {
      writeNew(r.dir);
      eq("enforcement/2.19 保護ブランチの未コミットは対象外として [allow] を返す", finishOf(r.dir), { status: 0, out: `${FIN_ALLOW}\n`, err: "" });
      rmSync(join(r.dir, "new.txt"));
      gitOut(r.dir, "checkout", "-q", "-b", "feature/x");
      writeNew(r.dir);
      eq("enforcement/2.19 宣言外のブランチの未コミットは [allow] で終了コード 0 を返す", finishOf(r.dir).status, 0);
      writeNew(plain.dir);
      eq("enforcement/2.19 BRW 未導入のリポジトリでは [allow] を返す", finishOf(plain.dir), { status: 0, out: `${FIN_ALLOW}\n`, err: "" });
      eq("enforcement/2.19 Git の外では [allow] で終了コード 0 を返す", finishOf(outside).status, 0);
    } finally {
      plain.cleanup();
      rmSync(outside, { recursive: true, force: true });
      r.cleanup();
    }
  }
  {
    // push 禁止（宣言の autoApprove.push: false）: 未 push だけなら [allow]、未コミットがあれば commit までの案内で [block]
    const r = mkRepoWithRemote({ branch: "dev/foo", config: { ...CONFIG, autoApprove: { push: false } } });
    try {
      gitOut(r.dir, "push", "-q", "origin", "main:refs/heads/develop");
      gitOut(r.dir, "commit", "--allow-empty", "-q", "-m", "未 push の commit");
      eq("enforcement/2.19 宣言の autoApprove.push: false で未 push だけなら [allow] を返す", finishOf(r.dir).status, 0);
      writeNew(r.dir);
      const f = finishOf(r.dir);
      eq("enforcement/2.19 宣言の autoApprove.push: false で未コミットがあれば、commit までの案内で [block]", [f.status, f.out.startsWith(BLOCK), f.out.includes("commit までにとどめ"), f.out.includes("git push")], [1, true, true, false]);
    } finally {
      r.cleanup();
    }
  }
  {
    // 作業の制限（noPush）も push 禁止として扱う: 未 push だけなら [allow]
    const r = repoOf();
    try {
      gitOut(r.dir, "update-ref", "refs/remotes/origin/dev/foo", "HEAD");
      const id = publish.startWork(r.dir, {}).work.workId;
      publish.setRestrictions(r.dir, id, { noPush: true });
      gitOut(r.dir, "commit", "--allow-empty", "-q", "-m", "未 push の commit");
      eq("enforcement/2.19 作業の制限 noPush で未 push だけなら [allow] を返す", finishOf(r.dir).status, 0);
    } finally {
      r.cleanup();
    }
  }
  {
    // どの worktree から実行しても同じ結果（本体・作業の worktree のどちらからも、残りのある worktree を判定する）
    const r = mkRepoWithRemote({ branch: "main", config: CONFIG });
    const wt = mkWorktree(r.dir, "dev/wt");
    try {
      gitOut(wt, "push", "-q", "-u", "origin", "dev/wt");
      writeNew(wt);
      const fromMain = finishOf(r.dir);
      const fromWt = finishOf(wt);
      eq("enforcement/2.19 本体・作業の worktree のどちらから実行しても、同じ出力と終了コードになる", fromWt, fromMain);
      eq("enforcement/2.19 本体から実行しても、別の worktree の開発ブランチの残りを [block] で案内する", [fromMain.status, fromMain.out.startsWith(BLOCK), fromMain.out.includes(wt)], [1, true, true]);
    } finally {
      r.cleanup();
    }
  }
  {
    // 従来の形（コマンド文字列を 1 つ渡す）の出力と終了コードは変えない。使い方は 2（--finish を含む使い方の文言）
    const r = repoOf();
    try {
      const legacy = finishOf(r.dir, ["git commit -m x"]);
      eq("enforcement/2.19 従来の guard \"git commit -m x\" の出力と終了コードを変えない", [legacy.status, legacy.out], [0, "[allow] \n"]);
      const none = finishOf(r.dir, []);
      eq("enforcement/2.19 引数が無い guard は使い方で終了コード 2 を返し、guard --finish を示す", [none.status, none.err.includes("guard --finish")], [2, true]);
      const extra = finishOf(r.dir, ["--finish", "extra"]);
      eq("enforcement/2.19 guard --finish に余分な引数があれば使い方で終了コード 2", [extra.status, extra.err.includes("guard --finish")], [2, true]);
      const mixed = finishOf(r.dir, ["--finish", "git commit -m x"]);
      eq("enforcement/2.19 guard --finish と他の引数の併用は使い方で終了コード 2", [mixed.status, mixed.err.includes("guard --finish")], [2, true]);
    } finally {
      r.cleanup();
    }
  }
};
