#!/usr/bin/env node
// 分岐元からの PR の調整役（brw-pr-handoff 7.3）。恒常的な分岐元（develop など）を作成元として、保護ブランチ（main など）への PR を作る。
// 呼ばれるのは現在のブランチの分類が base のときだけ（振り分けは brw pr の入口が行う）。
// 作業の記録（brw work start・準備・計画・状態ファイル）は作らず、tidy（別コミット）・cleanup（片付け）・push・マージは呼ばない。
// 書き込みは、ローカルの分岐元の fast-forward 更新（base-sync.mjs の syncBase）と、PR の作成（publish-pr.mjs の createOrReusePr）だけ。
// 順序: 引数（--confirmed の端末判定を含む）→ 事前確認 → 作成先 → 本文 → 未コミットの件数（表示のみ）→ 取り込み → 差 → 作成（承認の判定を経て）。
// 終了コード: 0 PR を作成または再利用、1 途中で止まった（次の操作を表示）、2 使い方の誤り。
// 外部依存なし（Node 標準ライブラリと既存の scripts/ のみ）。
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { classifyBranch, currentBranch, git, repoRoot, worktrees } from "./lib.mjs";
import { classifyCommand } from "./operation-policy.mjs";
import { evaluateAll } from "./operation-decision.mjs";
import { countDiff, resolveTarget, syncBase } from "./base-sync.mjs";
import { createOrReusePr } from "./publish-pr.mjs";
import { defaultSession, readBody } from "./publish-cli.mjs";
import { githubRepoOf, unknownDestinationText } from "./remote-url.mjs";
import { remoteNameOf } from "./publish.mjs";
import { bodyPathOf, UNFILLED_MARK } from "./pr-template.mjs";

const consoleIo = { out: (s) => console.log(s), err: (s) => console.error(s) };
const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
// pr-flow.mjs の VALUED・FLAGS と同じ形（7.4 で振り分けるため、ここでは取り込まない）
const VALUED = ["--title", "--body-file", "--completion", "--verification", "--target", "--work"];
const FLAGS = ["--failed", "--confirmed"];
// 分岐元からの PR では使わない申告（受け取るが無視し、その旨を示す）
const IGNORED = ["--completion", "--verification", "--failed"];

// 取り込みの失敗コードごとの次の手順（base-sync.mjs の syncBase の code と対応する）
const SYNC_RETRY = {
  ahead: "リモートへ push するか、未 push の commit を残すかを利用者に確認してから、もう一度 brw pr を実行してください。",
  diverged: "分岐は自動で取り込みません。利用者が手で整理してから、もう一度 brw pr を実行してください。",
  "fetch-failed": "通信と認証を確認して、もう一度 brw pr を実行してください。",
  "ff-failed": "作業ツリーの変更を確認して、もう一度 brw pr を実行してください。",
};

/** 引数を読む（pr-flow.mjs の parse と同じ規則）。 */
function parse(args) {
  const o = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (VALUED.includes(a)) {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--") || o[a] !== undefined) return { error: `${a} には 1 回だけ値を指定してください。` };
      o[a] = v;
      i++;
    } else if (FLAGS.includes(a)) {
      if (o[a] !== undefined) return { error: `${a} は 1 回だけ指定してください。` };
      o[a] = true;
    } else return { error: a.startsWith("--") ? `不明なオプション: ${a}` : `余分な引数: ${a}` };
  }
  return { o };
}

/** 再実行のためのコマンド（利用者の端末での --confirmed を含める）。タイトル・本文ファイル・作成先は解決後の値を使う。 */
function rerunLine({ title, bodyFile, target }) {
  let s = "brw pr";
  if (title !== undefined) s += ` --title ${shq(title)}`;
  s += ` --body-file ${shq(bodyFile)} --target ${shq(target)}`;
  return `${s} --confirmed`;
}

/**
 * 作成の直前の判定（共通判定 evaluateAll、origin "brw-publish"）。publish-pr.mjs の decidePr と同じ作り方にする。
 * 戻り値: null（作成してよい）、または止める結果（kind・code・message）。
 * 承認が必要なときは、利用者が端末で --confirmed を付けて実行したときだけ作成してよい（端末判定は呼び出し前に済ませている）。
 */
function judgeCreate({ cwd, repo, target, branch, title, confirmed }) {
  const cmd = `gh pr create --repo ${repo.owner}/${repo.name} --base ${target} --head ${branch} --title ${shq(title)}`;
  const d = evaluateAll(classifyCommand(cmd, cwd), {}, { origin: "brw-publish" });
  if (d.approval === "prohibited") return { ok: false, kind: "prohibited", code: "work-restriction", message: "この操作は禁止されているため、PR を作成していません。" };
  if (d.verdict === "deny" || d.compliance !== "compliant") return { ok: false, kind: "denied", code: d.code, message: `共通判定が PR 作成を拒否したため、作成していません（${d.reason ?? d.code}）。` };
  if (d.verdict === "eligibleForApproval") return null;
  if (confirmed) return null;
  return { ok: false, kind: "needsApproval", code: "normal-approval", message: "PR 作成には通常の承認が必要なため、作成していません。" };
}

/**
 * 分岐元からの PR を作成または再利用する。
 * @param {string[]} args `--title`・`--body-file`・`--target`・`--confirmed`（`--completion`・`--verification`・`--failed` は無視、`--work` は使い方の誤り）
 * @param {{cwd?: string, session?: () => object, io?: {out: Function, err: Function}, stdinIsTTY?: boolean}} [deps]
 *   session は GitHub の接続を返す関数（既定は publish-cli の defaultSession）。stdinIsTTY は標準入力が端末か（--confirmed の判定に使う）。
 * @param {{config: object, branch: string}} ctx config は宣言の読み込み結果（正規化済み）、branch は分岐元として扱うブランチ名（現在のブランチと一致すること）。
 * @returns {Promise<number>} 0 = PR を作成または再利用 / 1 = 止まった / 2 = 使い方の誤り
 */
export async function runBasePr(args, deps = {}, ctx = {}) {
  const d = {
    cwd: deps.cwd ?? process.cwd(),
    session: deps.session ?? defaultSession,
    io: deps.io ?? consoleIo,
    stdinIsTTY: deps.stdinIsTTY ?? process.stdin.isTTY === true,
  };
  const stop = (stage, message, retry) => {
    d.io.err(`エラー: ${message}`);
    if (retry) d.io.err(retry);
    d.io.err(`（止まった段階: ${stage}。原因を直して、もう一度 brw pr を実行してください。）`);
    return 1;
  };

  // 1. 引数。--work は作業の記録を前提にするため、分岐元では使えない
  const p = parse(args);
  if (p.error) { d.io.err(`エラー: ${p.error}`); return 2; }
  const o = p.o;
  if (o["--work"] !== undefined) {
    d.io.err("エラー: --work は分岐元からの PR では使えません（作業の記録を作らないため）。");
    return 2;
  }
  // --confirmed は利用者が自分の端末で実行したときだけ有効。端末でなければ何も行わず（通信・fetch も含めて）拒否する
  if (o["--confirmed"] === true && !d.stdinIsTTY) {
    d.io.err("--confirmed は、利用者が自分の端末で実行したときだけ有効です。エージェントは付けないでください。この時点では取り込み・PR の作成を行っていません。");
    return 1;
  }
  const ignored = IGNORED.filter((k) => o[k] !== undefined);
  if (ignored.length > 0) d.io.err(`注意: 分岐元からの PR では使わないため、次の指定は無視します: ${ignored.join("・")}`);

  // 2. 事前確認: 宣言・現在のブランチ・分類（呼び出し側の前提が崩れていれば止める）
  const root = repoRoot(d.cwd);
  if (!root) return stop("precheck", "git リポジトリ内で実行してください。");
  if (!ctx.config) return stop("precheck", "宣言ファイルが読めないため、規則を確認できず PR を作りません。");
  const config = ctx.config;
  const branch = currentBranch(d.cwd);
  if (!branch || ctx.branch !== branch) return stop("precheck", `現在のブランチ（${branch ?? "（ブランチなし）"}）が分岐元（${ctx.branch ?? "不明"}）と一致しないため、PR を作りません。分岐元の worktree で実行してください。`);
  if (classifyBranch(config, branch) !== "base") return stop("precheck", `'${branch}' は恒常的な分岐元ではないため、この経路では PR を作りません。`);

  // 3. 作成先（保護ブランチ）を決める
  const r = resolveTarget(config, o["--target"]);
  if (!r.ok) return stop("target", r.message, "--target <保護ブランチ> を指定して、もう一度 brw pr を実行してください。");
  const target = r.target;

  // 4. 本文の確認（副作用の前に行う。無い・未記入なら brw pr-template を案内する）
  const [main] = worktrees(d.cwd);
  const bodyFile = o["--body-file"] ?? bodyPathOf(main?.path ?? d.cwd, branch);
  const noBody = "先に brw pr-template を実行して本文の雛形と記入指示を得て、本文を書いてから、もう一度 brw pr を実行してください。";
  if (!existsSync(resolve(d.cwd, bodyFile))) return stop("body", `PR の本文ファイルがありません（${bodyFile}）。`, noBody);
  // 読み取りの場所の検査は publish-cli の readBody と同じ（許可外は読まずに止める）
  const read = readBody(d.cwd, bodyFile);
  if (read.error) return stop("body", `${read.error}（${bodyFile}）`, "本文の場所を直して、もう一度 brw pr を実行してください。");
  const body = read.text;
  if (body.includes(UNFILLED_MARK)) return stop("body", `PR の本文ファイルが未記入です（先頭の「未記入」の印が残っています: ${bodyFile}）。`, "本文を書き終えて、先頭の印の行を削除してから、もう一度 brw pr を実行してください。");

  // 5. 未コミットの変更は PR に含めない（commit はしない。件数だけ示す）
  const status = git(d.cwd, "status", "--porcelain");
  const uncommitted = status ? status.split("\n").filter(Boolean).length : 0;
  if (uncommitted > 0) d.io.out(`未コミットの変更が ${uncommitted} 件あり、PR には含まれません（commit はしません）。`);

  // 6. 取り込み: リモートの分岐元へ fast-forward で追いつかせる。先行・分岐・取得失敗は更新せず止める
  const remote = remoteNameOf(d.cwd, branch);
  const sync = syncBase(d.cwd, branch, target);
  if (!sync.ok) {
    const retry = SYNC_RETRY[sync.code] ?? "原因を直して、もう一度 brw pr を実行してください。";
    return stop("sync", `${sync.message}PR は作りません。`, retry);
  }
  if (sync.updated) d.io.out(`分岐元 ${branch} をリモートの ${remote}/${branch} に合わせました。`);

  // 7. 差: 保護ブランチに無い commit が無ければ PR を作らない（-1 は差を確認できないので止める）
  const diff = countDiff(d.cwd, target, branch);
  if (diff < 0) return stop("diff", `${remote}/${target} と ${remote}/${branch} の差を確認できないため、PR を作りません。`, "通信と取得の状態を確認して、もう一度 brw pr を実行してください。");
  if (diff === 0) return stop("diff", `${remote}/${branch} には ${target} へ取り込む差がありません（PR を作る内容が無いため、作りません）。`, "取り込む commit があるかを git log で確認してください。");

  // 8. 送り先（push 先のリモートの GitHub リポジトリ）を確定する。ここまでは読み取り・ローカルの更新だけ
  const headOid = git(d.cwd, "rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${branch}`);
  if (!headOid) return stop("sync", `${remote}/${branch} の commit を確認できないため、PR を作りません。`, "取得の状態を確認して、もう一度 brw pr を実行してください。");
  const pushUrl = git(d.cwd, "remote", "get-url", "--push", remote);
  const gh = githubRepoOf(pushUrl ?? "");
  if (!gh) return stop("repo", unknownDestinationText(remote, pushUrl), "送り先を GitHub のリポジトリとして確定できるように remote を確認してください。");
  let session;
  try {
    session = d.session();
  } catch (e) {
    return stop("session", `GitHub に接続できません（${e?.message ?? "原因不明"}）。`, "gh auth status で認証を確認してから、もう一度 brw pr を実行してください。");
  }
  const confirmedTarget = await session.confirmTarget({ host: session.host, owner: gh.owner, name: gh.name });
  if (!confirmedTarget.ok) return stop("repo", `GitHub で対象リポジトリ ${gh.owner}/${gh.name} を確認できませんでした。`, "認証と権限を確認して、もう一度 brw pr を実行してください。");
  const repo = { id: confirmedTarget.target.repositoryId, owner: gh.owner, name: gh.name };

  // 9. PR の作成（既存の PR があれば再利用。作成の直前に承認の判定を行う）
  const title = o["--title"];
  const confirmed = o["--confirmed"] === true;
  const beforeCreate = () => {
    if (title === undefined) return { ok: false, kind: "invalidInput", code: "pr-title-required", message: "新規の PR を作るにはタイトルが必要です。" };
    return judgeCreate({ cwd: d.cwd, repo, target, branch, title, confirmed });
  };
  const made = await createOrReusePr(session, repo, { branch, base: target, headOid, title, body, beforeCreate });

  if (made.ok) {
    const url = made.pull?.url;
    d.io.out(made.reused ? `PR を再利用しました: ${url}` : `PR を作成しました: ${url}`);
    d.io.out(`取り込み先: ${target}`);
    d.io.out(`GitHub 上で PR を開き、${target} へ squash マージしてください。BRW は GitHub のマージを行いません。`);
    return 0;
  }
  if (made.kind === "needsApproval") {
    d.io.err("PR 作成には通常の承認が必要です。承認はエージェントが代行できません。利用者が自分の端末で、この worktree の中から次のコマンドを実行してください（エージェントは --confirmed を付けない）:");
    d.io.err(`  ${rerunLine({ title, bodyFile, target })}`);
    return 1;
  }
  if (made.code === "pr-title-required") return stop("publish", "新規の PR を作るにはタイトルが必要です。", "利用者にタイトルを確認し、--title を付けて、もう一度 brw pr を実行してください。");
  // 作成後に head の OID が期待値と違う: PR は作成済みなので、URL を案内し、成功とは扱わない（再実行でも同じ PR を重複して作らない）
  if (made.code === "pr-mismatch" && made.createdUrl) {
    return stop("publish", `作成された PR（${made.createdUrl}）の内容（取り込み元の commit）が ${remote}/${branch} と一致しません。PR は作成済みのため、成功とは扱いません。`, "GitHub で PR の内容を確認してください。再実行しても、同じ PR を重複して作ることはありません（既存の PR の照合で止まります）。");
  }
  return stop("publish", made.message, "GitHub の状態を確認してから、もう一度 brw pr を実行してください。");
}
