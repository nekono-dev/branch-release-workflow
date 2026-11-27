// 完了公開の CLI（brw-enforcement 7.2）: `brw work start|resume|restrict|ready|plan`・`brw publish`・`brw pause` の入口。
// 実処理は publish.mjs（作業の状態・準備・計画・push）と publish-pr.mjs（PR）に任せる。ここでは引数の検査、
// GitHub の照合（対象のリポジトリ ID・既存 PR）、利用者へ返す文言・次の操作の案内だけを扱う。
// 出力: work start・resume は作業 ID を 1 つだけ標準出力に出す（PostToolUse が読む）。
//       資格情報・PR 本文・完了申告の全文・タイトルは出さない。
// 終了コード: 0 完了（または記録済みの成功）、1 失敗・個別の承認待ち・禁止（次の操作を表示）、2 使い方・入力の誤り。
// 外部依存なし（Node 標準ライブラリと内部モジュールのみ）。
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { branchBase, classifyBranch, currentBranch, git, loadConfig, repoRoot } from "./lib.mjs";
import { createGitHubSession } from "./github-client.mjs";
import * as publish from "./publish.mjs";
import { unknownDestinationText } from "./remote-url.mjs";
import { existingPr, runPublishPr } from "./publish-pr.mjs";

const HOST = "github.com";
const LABEL = { protected: "保護ブランチ", base: "恒常的な分岐元", undeclared: "宣言外のブランチ", development: "開発ブランチ" };
const FAILURE_TEXT = {
  auth: "GitHub の認証を確認できません（gh auth status で確認してください）",
  permission: "GitHub の権限が不足しています",
  "unknown-input": "GitHub の応答を確認できませんでした",
  network: "GitHub に接続できません。通信を確認して再実行してください",
  server: "GitHub の一時的な障害の可能性があります。再実行してください",
  "target-mismatch": "GitHub の対象リポジトリの照合が一致しません",
  refused: "GitHub への要求が拒否されました",
};
// 既存 PR の状態で準備を止めるときの文言（準備では PR を作らないので、理由と次の操作だけを示す）
const BLOCKED_TEXT = {
  "base-conflict": "同じ作業ブランチの既存の PR が別の取り込み先を指しています。取り込み先を --target で明示してから再実行してください。",
  "pr-draft": "既存の PR が draft です。GitHub で Ready for review にしてから再実行してください。",
  "pr-ambiguous": "同じ作業ブランチの PR が複数あり、一意に決められません。GitHub で確認してください。",
};

// ---- 入出力と引数 ----

const consoleIo = { out: (s) => console.log(s), err: (s) => console.error(s) };

/** 既定の GitHub 接続。資格情報は環境変数か gh の保存済みログインから得て、表示・記録しない。 */
export const defaultSession = () => {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || ghAuthToken();
  return createGitHubSession({ host: HOST, token: token || undefined });
};
const ghAuthToken = () => {
  const r = spawnSync("gh", ["auth", "token", "--hostname", HOST], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GH_PROMPT_DISABLED: "1" } });
  return r.status === 0 && typeof r.stdout === "string" ? r.stdout.trim() || null : null;
};

const norm = (deps = {}) => ({
  cwd: deps.cwd ?? process.cwd(),
  session: deps.session ?? defaultSession,
  io: deps.io ?? consoleIo,
  // 対話端末か。`--confirmed`（通常の承認を経ない書き込み）は利用者の端末からの実行だけ受け付ける。
  // 注入は呼び出し元（テスト）だけが行う。環境変数では迂回できない（brw.mjs は注入しない）
  stdinIsTTY: deps.stdinIsTTY ?? (process.stdin.isTTY === true),
});

/** 値を取るオプションと真偽のオプションを読む。未知のオプション・値の欠落・重複は使い方の誤り（error）。 */
function parseArgs(args, valued, flags = []) {
  const opts = {};
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (valued.includes(a)) {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--") || opts[a] !== undefined) return { error: `${a} には 1 回だけ値を指定してください。` };
      opts[a] = v;
      i++;
    } else if (flags.includes(a)) {
      if (opts[a] !== undefined) return { error: `${a} は 1 回だけ指定してください。` };
      opts[a] = true;
    } else if (a.startsWith("--")) {
      return { error: `不明なオプション: ${a}` };
    } else {
      pos.push(a);
    }
  }
  return { opts, pos };
}

const fail = (io, msg, code = 1) => { io.err(`エラー: ${msg}`); return code; };
const usage = (io, msg) => fail(io, msg, 2);

const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
/** 利用者が自分の端末で実行するための publish の全文（--confirmed を付ける）。 */
function confirmLine(o) {
  let s = `brw publish --work ${o["--work"]} --plan ${o["--plan"]}`;
  if (o["--title"] !== undefined) s += ` --title ${shq(o["--title"])}`;
  if (o["--body-file"] !== undefined) s += ` --body-file ${shq(o["--body-file"])}`;
  return `${s} --confirmed`;
}

/** 宣言とリポジトリの前提。対象外なら error。 */
function contextOf(cwd) {
  const root = repoRoot(cwd);
  if (!root) return { error: "git リポジトリ内で実行してください。" };
  const loaded = loadConfig(root);
  if (loaded.error || !loaded.config) return { error: loaded.error ?? "宣言ファイルがありません。規則を確認できないため、公開の操作を行いません。" };
  return { root, config: loaded.config };
}

/** 作業 ID が指定されているか。形式の検査は publish.mjs の readWork が行う。 */
const workIdOf = (opts) => opts["--work"];

/** GitHub の接続を作る。作れなければ null（理由を表示済み）。 */
function sessionOf(d) {
  try {
    return d.session();
  } catch (e) {
    fail(d.io, `GitHub に接続できません（${e?.message ?? "原因不明"}）。`);
    return null;
  }
}

// ---- GitHub の照合 ----

/** push 先の GitHub リポジトリを、GitHub の応答で照合して ID を確定する。通信は確認のための読み取りだけ。 */
async function resolveRepo(cwd, session, branch, repositoryId) {
  const remote = publish.remoteNameOf(cwd, branch);
  const pushUrl = git(cwd, "remote", "get-url", "--push", remote);
  const gh = publish.githubRepoOf(pushUrl);
  if (!gh) return { error: unknownDestinationText(remote, pushUrl) };
  const t = await session.confirmTarget({ host: session.host, owner: gh.owner, name: gh.name, ...(repositoryId !== undefined ? { repositoryId } : {}) });
  if (!t.ok) return { error: FAILURE_TEXT[t.kind] ?? "GitHub で対象リポジトリを確認できませんでした。" };
  return { repo: { id: t.target.repositoryId, owner: gh.owner, name: gh.name } };
}

/** 同じ作業ブランチの既存 PR を確かめる（読み取りのみ）。結果は準備・計画の existing の形にする。 */
async function existingFor(session, repo, branch, base, head) {
  const target = { host: session.host, owner: repo.owner, name: repo.name, repositoryId: repo.id };
  const ex = await existingPr(session, target, { branch, base, head });
  if (ex.state === "none") return { ok: true, pull: null };
  if (ex.state === "reuse") return { ok: true, pull: ex.pull };
  return { ok: false, error: { kind: "conflict", code: ex.code, message: ex.code } };
}

// ---- work start・resume・restrict・pause ----

function cmdStart(args, d) {
  const p = parseArgs(args, []);
  if (p.error || p.pos.length) return usage(d.io, "使い方: brw work start（作業 ID を 1 つ出力します）");
  const c = contextOf(d.cwd);
  if (c.error) return fail(d.io, c.error);
  const branch = currentBranch(d.cwd);
  const cls = branch ? classifyBranch(c.config, branch) : "undeclared";
  // 分岐元からは作業を始めないが、分岐元から保護ブランチへの PR は brw pr で作れる（brw-pr-handoff 6.2）
  const prNote = cls === "base" ? " 分岐元から保護ブランチへの PR は brw pr で作れます（brw pr-template で本文を用意してから brw pr）。" : "";
  if (cls !== "development") return fail(d.io, `'${branch ?? "（ブランチなし）"}' は${LABEL[cls]}のため、作業を始めません。開発ブランチで brw create または brw work resume を使ってください。${prNote}`);
  const cur = publish.currentWork(d.cwd);
  if (!cur.ok) return fail(d.io, cur.error.message);
  if (cur.work) d.io.err(`注意: 進行中の作業 ${cur.work.workId} を中断して、新しい作業を始めます。`);
  const r = publish.startWork(d.cwd);
  if (!r.ok) return fail(d.io, r.error.message);
  d.io.out(r.work.workId);
  return 0;
}

function cmdResume(args, d) {
  const p = parseArgs(args, ["--work"]);
  const id = workIdOf(p.opts ?? {});
  if (p.error || p.pos.length || !id) return usage(d.io, "使い方: brw work resume --work <作業 ID>");
  const r = publish.resumeWork(d.cwd, id);
  if (!r.ok) return fail(d.io, r.error.message);
  d.io.out(r.work.workId);
  return 0;
}

const describeRestrictions = (r) => [r.noPush && "push 禁止", r.noPr && "PR 作成禁止"].filter(Boolean).join("・") || "なし";

function cmdRestrict(args, d) {
  const p = parseArgs(args, ["--work"], ["--no-push", "--no-pr"]);
  const id = workIdOf(p.opts ?? {});
  if (p.error || p.pos.length || !id || (p.opts["--no-push"] !== true && p.opts["--no-pr"] !== true))
    return usage(d.io, "使い方: brw work restrict --work <作業 ID> --no-push | --no-pr（指定した禁止を追加します。外すことはできません）");
  const set = {};
  if (p.opts["--no-push"]) set.noPush = true;
  if (p.opts["--no-pr"]) set.noPr = true;
  const r = publish.setRestrictions(d.cwd, id, set);
  if (!r.ok) return fail(d.io, r.error.message);
  d.io.out(`作業 ${id} の禁止: ${describeRestrictions(r.work.restrictions)}`);
  return 0;
}

function cmdPause(args, d) {
  const p = parseArgs(args, ["--work", "--reason"]);
  const id = workIdOf(p.opts ?? {});
  if (p.error || p.pos.length || !id || p.opts["--reason"] === undefined)
    return usage(d.io, "使い方: brw pause --work <作業 ID> --reason <理由>");
  const r = publish.pauseWork(d.cwd, id, p.opts["--reason"]);
  if (!r.ok) return fail(d.io, r.error.message);
  d.io.out(`作業 ${id} を中断しました。再開は brw work resume --work ${id} を実行してください。`);
  return 0;
}

// ---- work ready（完了申告と公開の準備） ----

async function cmdReady(args, d) {
  const p = parseArgs(args, ["--work", "--completion", "--verification", "--target"], ["--failed"]);
  const id = workIdOf(p.opts ?? {});
  const o = p.opts ?? {};
  if (p.error || p.pos.length || !id || o["--completion"] === undefined || o["--verification"] === undefined)
    return usage(d.io, "使い方: brw work ready --work <作業 ID> --completion <完了申告> --verification <検証の要約> [--failed] [--target <取り込み先>]");
  const w = publish.readWork(d.cwd, id);
  if (!w.ok) return fail(d.io, w.error.message);
  const c = contextOf(d.cwd);
  if (c.error) return fail(d.io, c.error);
  const session = sessionOf(d);
  if (!session) return 1;
  const repoRes = await resolveRepo(d.cwd, session, w.work.branch);
  if (repoRes.error) return fail(d.io, repoRes.error);
  const head = git(d.cwd, "rev-parse", "--verify", "HEAD");
  // 取り込み先は明示指定 → 記録済みの分岐元 → 宣言の既定値（publish.markReady と同じ順序）。開発ブランチ宛なら PR は確かめない
  const base = o["--target"] ?? branchBase(d.cwd, c.config, w.work.branch);
  let existing;
  if (classifyBranch(c.config, base) !== "development") {
    const ex = await existingFor(session, repoRes.repo, w.work.branch, base, head);
    if (!ex.ok) return fail(d.io, BLOCKED_TEXT[ex.error.code] ?? `既存の PR の状態を GitHub で確定できませんでした（${ex.error.code}）。`);
    existing = ex;
  }
  const r = publish.markReady(d.cwd, id, {
    completion: o["--completion"],
    verification: { passed: o["--failed"] !== true, summary: o["--verification"] },
    repository: repoRes.repo,
    ...(o["--target"] !== undefined ? { target: o["--target"] } : {}),
    ...(existing !== undefined ? { existing } : {}),
  });
  if (!r.ok) return fail(d.io, r.error.message);
  const ref = r.ready.integration.ref;
  d.io.out(`準備しました: 作業 ${id}（取り込み先 ${ref}、${r.ready.publication === "push" ? "開発ブランチへの取り込みで、push で完了します" : "保護対象への取り込みで、PR を伴います"}）。`);
  d.io.out(`次に brw work plan --work ${id} を実行して、公開の計画を作ってください。`);
  return 0;
}

// ---- work plan（公開計画） ----

const EXCLUDED = (x) => (x.approval === "prohibited" ? "禁止されている"
  : x.approval === "normal" ? "通常の承認が必要"
    : x.code === "already-pushed" ? "push 済み"
      : x.code === "push-not-planned" ? "push が計画されていない"
        : String(x.code));

async function cmdPlan(args, d) {
  const p = parseArgs(args, ["--work"]);
  const id = workIdOf(p.opts ?? {});
  if (p.error || p.pos.length || !id) return usage(d.io, "使い方: brw work plan --work <作業 ID>");
  const w = publish.readWork(d.cwd, id);
  if (!w.ok) return fail(d.io, w.error.message);
  if (!w.work.ready) return fail(d.io, "準備済みの記録がありません。先に brw work ready を実行してください。");
  const session = sessionOf(d);
  if (!session) return 1;
  const ready = w.work.ready;
  const repoRes = await resolveRepo(d.cwd, session, w.work.branch, ready.repositoryId);
  if (repoRes.error) return fail(d.io, repoRes.error);
  const existing = ready.publication === "pr"
    ? await existingFor(session, repoRes.repo, w.work.branch, ready.integration.ref, ready.headOid)
    : undefined;
  const r = publish.issuePlan(d.cwd, id, { repository: repoRes.repo, existing });
  if (!r.ok) return fail(d.io, r.error.message);
  const { plan } = r;
  d.io.out(`計画 ID: ${plan.planId}`);
  for (const x of plan.writes) {
    d.io.out(x.operation === "push" ? `  実行する: push（${x.ref} を準備時の commit へ）` : `  実行する: PR 作成（${x.head} → ${x.base}）`);
  }
  if (r.reuse) d.io.out(`  実行する: 既存の PR を再利用する${r.reuse.url ? `（${r.reuse.url}）` : ""}`);
  for (const x of r.excluded) d.io.out(`  実行しない: ${x.operation === "push" ? "push" : "PR 作成"}（${EXCLUDED(x)}）`);
  d.io.out(`次に brw publish --work ${id} --plan ${plan.planId} を実行してください。PR を作る場合は --title を付けます（タイトルと本文は利用者に確認してから渡してください）。`);
  return 0;
}

// ---- work（まとめ）・publish ----

/**
 * 本文ファイルを読む。次のどちらかの通常ファイルに限る（フックの信頼判定と同じ基準: 実体パスで配下を確認し、`..`・配下の外へのリンクは拒否）。
 *   - 作業ディレクトリ配下の相対パス
 *   - 本体の worktree 置き場（<本体>/.claude/worktrees/.brw/）の配下の絶対パス（brw pr-template が作る本文ファイル）
 */
function readBody(cwd, file) {
  const bad = { error: "本文ファイルは作業ディレクトリ配下の相対パスか、brw pr-template が作る本文置き場（.claude/worktrees/.brw/）の配下の絶対パスで指定してください。" };
  if (file === "" || file.includes("\0") || file.split(/[\\/]/).includes("..")) return bad;
  try {
    let root;
    if (isAbsolute(file)) {
      const main = publish.worktreeMainOf(cwd);
      if (!main) return bad;
      root = realpathSync(join(main, ".claude", "worktrees", ".brw"));
    } else {
      root = realpathSync(cwd);
    }
    const real = realpathSync(resolve(cwd, file));
    if (!real.startsWith(root + sep) || !statSync(real).isFile()) return bad;
    return { text: readFileSync(real, "utf8") };
  } catch {
    return { error: "本文ファイルを読めません。" };
  }
}

/** 途中で止まったときの次の操作。計画の再作成・再試行・中断の 3 つを示す。 */
function stopped(io, id, planId, message, note = "") {
  io.err(`${note}${message}`);
  io.err(`状況を確かめてください。同じ計画で再試行するなら brw publish --work ${id} --plan ${planId}（必要なら --title を付ける）。`);
  io.err(`計画が無効になっていれば brw work plan --work ${id} で計画し直してください。中断するなら brw pause --work ${id} --reason "<理由>" を実行してください。`);
  return 1;
}

async function cmdPublish(args, d) {
  const p = parseArgs(args, ["--work", "--plan", "--title", "--body-file"], ["--confirmed"]);
  const o = p.opts ?? {};
  const id = o["--work"];
  const planId = o["--plan"];
  if (p.error || p.pos.length || !id || !planId)
    return usage(d.io, "使い方: brw publish --work <作業 ID> --plan <計画 ID> [--title <タイトル> --body-file <ファイル>]（--confirmed は利用者が自分の端末で実行するときだけ）");
  const confirmed = o["--confirmed"] === true;
  // 通常の承認を経ない書き込みは、利用者が自分の端末で実行したときだけ。エージェントの実行（非対話）では何も行わず、利用者が実行する全文を示す
  if (confirmed && !d.stdinIsTTY) {
    d.io.err("--confirmed は、利用者が自分の端末で実行したときだけ有効です。エージェントは付けないでください。この時点では push・PR を行っていません。");
    d.io.err("利用者が自分の端末で次のコマンドを実行してください:");
    d.io.err(`  ${confirmLine(o)}`);
    return 1;
  }
  let body;
  if (o["--body-file"] !== undefined) {
    const b = readBody(d.cwd, o["--body-file"]);
    if (b.error) return usage(d.io, b.error);
    body = b.text;
  }
  const w = publish.readWork(d.cwd, id);
  if (!w.ok) return fail(d.io, w.error.message);
  if (!w.work.ready) return fail(d.io, "準備済みの記録がありません。先に brw work ready と brw work plan を実行してください。");
  const pubRemote = publish.remoteNameOf(d.cwd, w.work.branch);
  const pubUrl = git(d.cwd, "remote", "get-url", "--push", pubRemote);
  const gh = publish.githubRepoOf(pubUrl);
  if (!gh) return fail(d.io, unknownDestinationText(pubRemote, pubUrl));
  const repository = { id: w.work.ready.repositoryId, owner: gh.owner, name: gh.name };
  const publication = w.work.ready.publication;

  // (1) push。禁止・承認待ち・失敗はここで結果を示す
  const pushed = publish.runPush(d.cwd, id, { planId, repository, confirmed });
  if (!pushed.ok && pushed.outcome !== "failed") return stopped(d.io, id, planId, pushed.error.message);
  if (pushed.outcome === "needsApproval") {
    d.io.err("push には通常の承認が必要です。承認はエージェントが代行できません。利用者が自分の端末で次のコマンドを実行してください（エージェントは --confirmed を付けない）:");
    d.io.err(`  ${confirmLine(o)}`);
    return 1;
  }
  const pushNote = pushed.outcome === "prohibited" ? "push は禁止されているため、この作業は公開できません。" : "";
  if (!pushed.ok) return stopped(d.io, id, planId, pushed.error.message, pushNote ? `${pushNote} ` : "");

  // (2) 取り込み先への公開（開発ブランチは push で完了、保護対象は PR を作成または再利用）
  let session;
  if (publication === "pr") {
    session = sessionOf(d);
    if (!session) return 1;
  }
  const title = o["--title"];
  const x = await runPublishPr(d.cwd, id, { planId, repository, session, confirmed, title, body });
  if (!x.ok) {
    if (x.error?.code === "pr-title-required") {
      d.io.err("新規の PR を作るにはタイトルが必要です。利用者にタイトル（と必要なら本文）を尋ねてから、次のコマンドで再実行してください。");
      d.io.err(`  brw publish --work ${id} --plan ${planId} --title "<タイトル>" [--body-file <本文ファイル>]`);
      return 1;
    }
    return stopped(d.io, id, planId, x.error?.message ?? "公開できませんでした。", pushNote ? `${pushNote} ` : "");
  }
  if (x.outcome === "needsApproval") {
    d.io.err("PR 作成には通常の承認が必要です。承認はエージェントが代行できません。利用者が自分の端末で次のコマンドを実行してください（エージェントは --confirmed を付けない）:");
    d.io.err(`  ${confirmLine(o)}`);
    return 1;
  }
  if (x.outcome === "prohibited") {
    d.io.err("PR 作成が禁止されているため、PR は作成していません。push は完了しています（作業は公開済みになりません）。");
    d.io.err(`作業を終えるなら brw pause --work ${id} --reason "<理由>" で中断してください。`);
    return 1;
  }

  // 完了
  if (x.publication === "push") {
    d.io.out(`取り込みは push で完了しました（取り込み先: ${x.base}）。PR は作成していません。`);
    d.io.out(`取り込み先（${x.base}）の作業ツリーで brw merge ${w.work.branch} を実行して、取り込んでください。`);
    return 0;
  }
  d.io.out(`PR を${x.pr.created ? "作成しました" : "用意しました（既存の PR を再利用）"}: ${x.pr.url}`);
  d.io.out(`取り込み先: ${x.base}`);
  d.io.out(`GitHub 上で PR を開き、${x.base} へ squash マージしてください。BRW は GitHub のマージを行いません。`);
  return 0;
}

// ---- 公開の入口 ----

/** `brw work <サブコマンド>` を実行する。終了コードを返す。 */
export async function runWork(args, deps) {
  const d = norm(deps);
  const [sub, ...rest] = args;
  switch (sub) {
    case "start": return cmdStart(rest, d);
    case "resume": return cmdResume(rest, d);
    case "restrict": return cmdRestrict(rest, d);
    case "ready": return cmdReady(rest, d);
    case "plan": return cmdPlan(rest, d);
    default: return usage(d.io, "使い方: brw work <start|resume|restrict|ready|plan> ...");
  }
}

/** `brw publish` を実行する。終了コードを返す。 */
export async function runPublish(args, deps) {
  return cmdPublish(args, norm(deps));
}

/** `brw pause` を実行する。終了コードを返す。 */
export async function runPause(args, deps) {
  return cmdPause(args, norm(deps));
}
