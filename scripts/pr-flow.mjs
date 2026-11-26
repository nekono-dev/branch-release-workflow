#!/usr/bin/env node
// `brw pr`（brw-pr-handoff）: 完了公開（準備・計画・公開）を 1 つの入口にまとめ、PR 作成後に作業場所を片付ける調整役。
// 既存の公開の段階（brw work ready / plan・brw publish）を、出力を捕捉する io で呼ぶ。済んだ段階は飛ばして再実行できる。
// 手順: 事前確認 → 作業の特定 → 本文の確認 → 別コミット（tidy）→ 準備 → 計画 → 公開 → 片付け（宣言の afterPublish.cleanup が有効なとき）。
// 終了コード: 0 完了、1 途中で止まった（次の操作を表示。再実行で続きから進む）、2 使い方・入力の誤り。外部依存なし。
import { existsSync, readFileSync } from "node:fs";
import { branchBase, classifyBranch, currentBranch, git, loadConfig, repoRoot, worktrees } from "./lib.mjs";
import { cleanupAfterPr } from "./cleanup.mjs";
import * as publish from "./publish.mjs";
import { runPublish, runWork } from "./publish-cli.mjs";
import { bodyPathOf, UNFILLED_MARK } from "./pr-template.mjs";
import { tidyChanges } from "./tidy.mjs";

const consoleIo = { out: (s) => console.log(s), err: (s) => console.error(s) };
const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const VALUED = ["--title", "--body-file", "--completion", "--verification", "--target", "--work"];
const FLAGS = ["--failed", "--confirmed"];

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

/** 既存の段階を、出力を捕捉して呼ぶ。code と、出力の行を返す。 */
async function capture(fn, args, d) {
  const out = [];
  const err = [];
  const code = await fn(args, { cwd: d.cwd, session: d.session, stdinIsTTY: d.stdinIsTTY, io: { out: (s) => out.push(String(s)), err: (s) => err.push(String(s)) } });
  return { code, out, err, text: [...out, ...err].join("\n") };
}

/** 再実行のためのコマンド（利用者の端末での --confirmed を含められる）。 */
function rerunLine(o, extra = "") {
  let s = "brw pr";
  for (const k of VALUED) if (o[k] !== undefined && k !== "--work") s += ` ${k} ${shq(o[k])}`;
  if (o["--failed"]) s += " --failed";
  return `${s}${extra}`;
}

/**
 * `brw pr` を実行する。
 * @param {string[]} args
 * @param {{cwd?: string, session?: Function, io?: {out: Function, err: Function}, stdinIsTTY?: boolean}} [deps]
 * @returns {Promise<number>} 終了コード
 */
export async function runPr(args, deps = {}) {
  const d = { cwd: deps.cwd ?? process.cwd(), session: deps.session, io: deps.io ?? consoleIo, stdinIsTTY: deps.stdinIsTTY ?? process.stdin.isTTY === true };
  const stop = (stage, message, retry) => {
    d.io.err(`エラー: ${message}`);
    if (retry) d.io.err(retry);
    d.io.err(`（止まった段階: ${stage}。原因を直して、もう一度 brw pr を実行すると続きから進みます。）`);
    return 1;
  };
  const p = parse(args);
  if (p.error) { d.io.err(`エラー: ${p.error}`); return 2; }
  const o = p.o;

  // 1. 事前確認: 導入済み・開発ブランチ
  const root = repoRoot(d.cwd);
  if (!root) return stop("precheck", "git リポジトリ内で実行してください。");
  const loaded = loadConfig(root);
  if (loaded.error || !loaded.config) return stop("precheck", loaded.error ?? "宣言ファイルがありません。規則を確認できないため、PR を作りません。");
  const config = loaded.config;
  const branch = currentBranch(d.cwd);
  const cls = branch ? classifyBranch(config, branch) : "undeclared";
  if (cls !== "development") return stop("precheck", `'${branch ?? "（ブランチなし）"}' は開発ブランチではないため、PR を作りません。開発ブランチの worktree で実行してください。`);
  const [main, ...others] = worktrees(d.cwd);

  // 2. 作業の特定: 指定 → 現在の作業 → 公開済みで片付けが残る作業 → 開始
  let work = null;
  if (o["--work"] !== undefined) {
    const r = publish.readWork(d.cwd, o["--work"]);
    if (!r.ok) return stop("work", r.error.message);
    work = r.work;
  } else {
    const cur = publish.currentWork(d.cwd);
    if (!cur.ok) return stop("work", cur.error.message);
    work = cur.work;
    if (!work) {
      const file = publish.stateFileOf(d.cwd);
      const loadedState = file ? publish.load(file) : { state: { works: {} } };
      if (loadedState.error) return stop("work", loadedState.error);
      const left = Object.values(loadedState.state.works).filter((w) => w.status === "published" && w.branch === branch && w.results?.pr?.outcome === "success").sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
      if (left) work = left;
    }
  }

  let workId = work?.workId;
  if (work && work.status === "published") return finishUp({ d, config, main, others, branch, workId, o, prOut: null });

  // 3. 本文の確認: 取り込み先が保護対象（PR を作りうる）のとき、記入済みの本文ファイルが無ければ副作用の前に止める
  const target = o["--target"] ?? branchBase(d.cwd, config, branch);
  const mayCreatePr = classifyBranch(config, target) !== "development";
  const bodyFile = o["--body-file"] ?? bodyPathOf(main.path, branch);
  if (mayCreatePr) {
    if (!existsSync(bodyFile)) return stop("body", `PR の本文ファイルがありません（${bodyFile}）。`, "先に brw pr-template を実行して本文の雛形と記入指示を得て、本文を書いてから、もう一度 brw pr を実行してください。");
    if (readFileSync(bodyFile, "utf8").includes(UNFILLED_MARK)) return stop("body", `PR の本文ファイルが未記入です（先頭の「未記入」の印が残っています: ${bodyFile}）。`, "本文を書き終えて、先頭の印の行を削除してから、もう一度 brw pr を実行してください。");
  }
  const needDeclaration = () => stop("ready", "--completion（完了の申告）と --verification（検証の要約）が必要です。", "例: brw pr --title '<タイトル>' --completion '<何を完了したか>' --verification '<何をどう確かめたか>'");
  if (!work && (o["--completion"] === undefined || o["--verification"] === undefined)) return needDeclaration();

  // 開始（作業が無いとき）
  if (!work) {
    const s = await capture(runWork, ["start"], d);
    if (s.code !== 0) return stop("work", s.text.trim());
    workId = s.out[s.out.length - 1]?.trim();
    work = publish.readWork(d.cwd, workId).work;
  }

  // 4. 別コミット（pushed の後は公開する内容が固まっているので行わない）
  if (work.status !== "pushed") {
    const t = tidyChanges(d.cwd);
    if (t.kind === "blocked") {
      d.io.err(`エラー: 秘密情報らしい名前のファイルが未コミットの変更に含まれるため、コミットも公開も行いません: ${t.secretLike.join(", ")}`);
      d.io.err("コミットしないなら .gitignore に追加するか削除し、コミットすべきものなら名前を変えてから、もう一度 brw pr を実行してください。");
      return 1;
    }
    if (t.kind === "failed") return stop("tidy", t.message);
    if (t.kind === "committed") d.io.out(`作業外の変更を別コミットにしました（${t.files.length} 件）。`);
  }

  // 5. 準備: 未準備・準備後に HEAD が変わった場合は（再）準備する
  work = publish.readWork(d.cwd, workId).work;
  const head = git(d.cwd, "rev-parse", "--verify", "HEAD");
  // 準備後に HEAD が変わったときは、前回の申告・検証の要約・未通過の記録を引き継いで準備をやり直す（実態と違う検証結果で公開しない）
  let prev = null;
  if (work.status === "ready" && work.ready?.headOid !== head) {
    prev = work.ready;
    const r = await capture(runWork, ["resume", "--work", workId], d);
    if (r.code !== 0) return stop("ready", r.text.trim());
    work = publish.readWork(d.cwd, workId).work;
  }
  if (work.status === "inProgress") {
    const completion = o["--completion"] ?? prev?.completion;
    const verification = o["--verification"] ?? prev?.verification?.summary;
    if (completion === undefined || verification === undefined) return needDeclaration();
    const failed = o["--failed"] === true || (o["--verification"] === undefined && prev?.verification?.passed === false);
    const readyArgs = ["ready", "--work", workId, "--completion", completion, "--verification", verification];
    if (failed) readyArgs.push("--failed");
    if (o["--target"] !== undefined) readyArgs.push("--target", o["--target"]);
    const r = await capture(runWork, readyArgs, d);
    if (r.code !== 0) return stop("ready", r.text.trim());
  }

  // 6. 計画
  const plan = await capture(runWork, ["plan", "--work", workId], d);
  if (plan.code !== 0) return stop("plan", plan.text.trim());
  const planId = /計画 ID: (\S+)/.exec(plan.text)?.[1];
  if (!planId) return stop("plan", "公開の計画の ID を読み取れませんでした。");

  // 7. 公開
  const pubArgs = ["--work", workId, "--plan", planId];
  if (o["--title"] !== undefined) pubArgs.push("--title", o["--title"]);
  if (mayCreatePr) pubArgs.push("--body-file", bodyFile);
  if (o["--confirmed"]) pubArgs.push("--confirmed");
  const pub = await capture(runPublish, pubArgs, d);
  if (pub.code !== 0) {
    if (/通常の承認が必要/.test(pub.text)) {
      d.io.err("PR の公開には通常の承認が必要です。承認はエージェントが代行できません。利用者が自分の端末で、作業ツリー（この worktree）の中から次のコマンドを実行してください（エージェントは --confirmed を付けない）:");
      d.io.err(`  ${rerunLine(o, " --confirmed")}`);
      return 1;
    }
    if (/タイトルが必要/.test(pub.text)) return stop("publish", "新規の PR を作るにはタイトルが必要です。", `利用者にタイトルを確認し、--title を付けて、もう一度 brw pr を実行してください。`);
    return stop("publish", pub.text.trim());
  }
  for (const line of pub.out) d.io.out(line);
  if (/取り込みは push で完了/.test(pub.text)) {
    // 開発ブランチへの取り込みは PR を作らない。作業場所は片付けず、取り込みの手順を案内する
    return 0;
  }
  return finishUp({ d, config, main, others, branch, workId, o, prOut: pub.out });
}

/** 片付け（宣言で有効なとき）と、片付け後の案内。公開済みの作業を対象にする。 */
function finishUp({ d, config, main, others, branch, workId, o }) {
  const w = publish.readWork(d.cwd, workId);
  if (!w.ok) return (d.io.err(`エラー: ${w.error.message}`), 1);
  const push = w.work.results?.push;
  const pr = w.work.results?.pr;
  if (!config.afterPublish?.cleanup) {
    d.io.out("宣言の afterPublish.cleanup が無効のため、片付けは行いません（何も削除していません）。");
    d.io.out(`PR がマージされた後に、本体（${main.path}）で brw finish ${branch} を実行して片付けてください。`);
    return 0;
  }
  const known = push?.oid && push?.remote && pr?.url && pr?.base ? { url: pr.url, base: pr.base, oid: push.oid, remote: push.remote } : null;
  const r = cleanupAfterPr({ main, others, config, branch, workId, known });
  if (r.kind === "kept") {
    d.io.out(`PR は作成済みです。片付けは行いませんでした: ${r.reason}`);
    d.io.out(`原因を解消してから、もう一度 brw pr（この worktree の中）を実行するか、本体（${main.path}）で brw finish ${branch} を実行してください。`);
    return 1;
  }
  d.io.out(`片付けました: ${r.branch}（worktree: ${r.worktree}）`);
  if (r.stateNote) d.io.out(`注意: ${r.stateNote}`);
  d.io.out(`この worktree は削除されました。次の作業は本体（${r.main}）で行います。新しい作業は、本体で brw create <名前> を実行してください。`);
  return 0;
}
