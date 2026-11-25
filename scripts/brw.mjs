#!/usr/bin/env node
// branch-release-workflow の CLI。サブコマンド:
//   hook                       旧経路の PreToolUse フック（手動実行用。標準入力の JSON を判定して deny/ask/allow を返す）。
//                              現行のフック登録は agent-hooks.mjs（Claude Code・Codex 共通）が行い、このサブコマンドは登録しない
//   create <名前> [--base b] [--branch-only]   作業ブランチ（と worktree）を命名規則に従って作成
//   finish [ブランチ] | --merged  切り出し元へ取り込まれた（保護ブランチへの PR がある）作業ブランチの worktree を片付ける
//   resume <ブランチ>          作業ブランチの続きを始める（無ければリモートかローカルのブランチから worktree を作る）
//   merge <取り込み元>         開発ブランチ同士の取り込みをローカルでマージする（PR は作らない。取り込み先は現在の worktree のブランチ）
//   work start                 変更作業を始め、作業 ID を 1 つ出力する（調査だけの依頼では使わない）
//   work resume --work <id>    中断した作業を明示して再開する（作業 ID を 1 つ出力する）
//   work restrict --work <id> --no-push|--no-pr   作業で push・PR 作成を禁止する（追加のみ。外せない）
//   work ready --work <id> --completion <申告> --verification <要約> [--failed] [--target <取り込み先>]   完了を申告して公開の準備を確定する
//   work plan --work <id>      公開の計画を作り、計画 ID を出力する（読み取りと記録だけ。遠隔は書き換えない）
//   publish --work <id> --plan <計画 ID> [--title <t> --body-file <path>]   計画どおりに push し、保護対象は PR を作成・再利用する（--confirmed は利用者が自分の端末で実行するときだけ有効）
//   pause --work <id> --reason <理由>   作業の次の公開を保留する（再開は work resume）
//   url [ブランチ]             プレビューURLを表示
//   check [--branches-only] [--ruleset]  宣言・workflow・provider 設定の整合検査。続けてフックの稼働を経路ごとに表示し、--ruleset で Ruleset の状態を読み取りで検査する
//                              終了コード: 0 問題なし、1 宣言・整合の誤りや Ruleset のずれ、3 Ruleset の確認不能・過去の選択が読めない保留（見送り・未選択は 0）（フックの状態は終了コードに含めない）
//   setup [--ruleset on|off]   導入: 対象候補を表示し、フックを登録する。Ruleset は既定 off（--ruleset on か対話で y のときだけ適用する）
//                              非対話で採否が無ければ見送る（通信なし・フックは進める）。過去の選択が読めないときだけ保留する。終了コード: 0 完了・見送り、1 誤り、2 使い方、3 保留
//   setup --migrate [--keep-confirm push|pullRequest|all]   旧パス .claude/branch-release-workflow.json の宣言を新しいパスへ移行する（明示時のみ書き込み。旧パスは残す）
//   gen-workflow [preview|deploy] [--write]  preview（provider）または deploy（配備先）の workflow 雛形を出力（--write で .github/workflows/<種類>.yaml へ）
//   cleanup <ブランチ> [--execute]  provider 固有の後始末（既定は表示のみ）
//   wrangler-config [ファイル] [--write]  独自ドメインの有効状況と配信方式に応じて wrangler 設定の workers_dev / preview_urls を設定（配備先を宣言しない構成）
//   render-wrangler --target <配備先> [--write]  テンプレートから配備先の wrangler 設定を生成（--write で生成先へ書き renderHook を呼ぶ）
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_REL, autoApproveOf, configRel, branchBase, checkName, classifyBranch, configCommitted, configMatchesHead, currentBranch, enabledInRepo, git, globToRegExp, judgeBranch, loadConfig, matchesAny, repoRoot,
  scanWorkflows, shortRef, undeclaredCiBranches, aliasOf, worktrees, deliveryOf,
} from "./lib.mjs";
import { getProvider, previewUrl, previewUrlInfo } from "./providers/index.mjs";
import { denyOfCommand } from "./agent-hooks.mjs";
import * as deployCf from "./deploy/cloudflare-workers.mjs";
import { applyWorkersDev } from "./providers/cloudflare-previews.mjs";
import { installWorktreeHooks } from "./hook-install.mjs";
import { runPause, runPublish, runWork } from "./publish-cli.mjs";
import { runSetup, runStateCheck } from "./setup-cli.mjs";

// ---- フック用: シェルコマンドから git commit / push を抽出 --------------------------

function tokenize(seg) {
  const toks = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(seg))) toks.push(m[1] ?? m[2] ?? m[3]);
  return toks;
}

// リダイレクト（2>&1、> file、2>/dev/null など）を引数から除く。送り先のブランチと取り違えないため
export function stripRedirects(args) {
  const out = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (/^\d*(>>?|<|&>)$/.test(a)) k++; // 演算子だけのトークンは、次のトークン（ファイル名）も除く
    else if (!/^\d*(>>?|<|&>)/.test(a)) out.push(a);
  }
  return out;
}

// コマンド文字列を解析し、{ kind: "commit"|"push", cwd, args }[] を返す
export function extractGitOps(command, cwd) {
  const ops = [];
  let cur = cwd;
  for (const seg of command.split(/&&|\|\||;|\||\n/)) {
    const t = tokenize(seg.trim());
    if (t[0] === "cd" && t[1]) {
      cur = join(cur, t[1].replace(/^~$/, process.env.HOME ?? "~"));
      if (t[1].startsWith("/")) cur = t[1];
      continue;
    }
    const gi = t.indexOf("git");
    if (gi < 0 || !t.slice(0, gi).every((x) => /^\w+=/.test(x))) continue; // 前置は環境変数代入のみ許容
    let dir = cur;
    let i = gi + 1;
    while (i < t.length && t[i].startsWith("-")) {
      if (t[i] === "-C" && t[i + 1]) {
        dir = t[i + 1].startsWith("/") ? t[i + 1] : join(dir, t[i + 1]);
        i += 2;
      } else if (t[i] === "-c") i += 2;
      else i += 1;
    }
    if (t[i] === "commit" || t[i] === "push") ops.push({ kind: t[i], cwd: dir, args: stripRedirects(t.slice(i + 1)) });
  }
  return ops;
}

// push の対象ブランチ一覧。null は特定不能（--all / --mirror）
export function pushTargets(args, cwd) {
  if (args.some((a) => a === "--all" || a === "--mirror" || a === "--branches")) return null;
  const pos = args.filter((a) => !a.startsWith("-"));
  const refspecs = pos.slice(1); // 先頭はリモート名
  if (!refspecs.length) {
    const b = currentBranch(cwd);
    return b ? [b] : [];
  }
  const out = [];
  for (const r of refspecs) {
    if (r.startsWith("refs/tags/") || args.includes("--tags")) continue;
    const dst = r.includes(":") ? r.split(":")[1] : r;
    if (dst === "HEAD" || dst === "") {
      const b = currentBranch(cwd);
      if (b) out.push(b);
    } else out.push(shortRef(dst));
  }
  return out;
}

const rank = { allow: 0, ask: 1, deny: 2 };

export function judgeCommand(command, cwd) {
  const ops = extractGitOps(command, cwd);
  let worst = { decision: "allow", reason: "" };
  for (const op of ops) {
    const root = repoRoot(op.cwd);
    if (!root) continue;
    const { config, error } = loadConfig(root);
    let r;
    if (error) r = { decision: "ask", reason: error };
    else if (!config) {
      // 宣言の無いリポジトリは運用の対象外（プラグインはどのリポジトリでも有効になりうる）。
      // ただしリポジトリの設定でプラグインを有効にしているのに宣言が無いのは導入の途中なので、宣言を作るまで止める
      if (!enabledInRepo(root)) continue;
      r = { decision: "deny", reason: `このリポジトリはプラグインを有効にしていますが、宣言ファイル ${CONFIG_REL} がありません。宣言ファイルを作ってリポジトリに登録してください（スキル branch-release-workflow の references/setup.md）。` };
    }
    else if (op.kind === "commit") r = judgeBranch(config, currentBranch(op.cwd));
    else {
      const targets = pushTargets(op.args, op.cwd);
      if (targets === null) r = { decision: "ask", reason: "--all / --mirror は保護ブランチを含みうるため確認が必要です。" };
      else {
        r = { decision: "allow", reason: "" };
        for (const b of targets) {
          const j = judgeBranch(config, b);
          if (rank[j.decision] > rank[r.decision]) r = j;
        }
      }
    }
    if (rank[r.decision] > rank[worst.decision]) worst = r;
  }
  return worst;
}

// ---- フック用: 作業ブランチ運用の操作の確認を省けるか ---------------------------
// 宣言の autoApprove で有効にした操作について、フックは許可（allow）を返し、利用者への確認を省く。
//   push        作業ブランチへの通常の push
//   pullRequest 作業ブランチから切り出し元（baseBranch）への PR の作成（gh pr create）
// allow は Bash コマンド全体に効くため、コマンド全体がこれらの操作（と cd）だけのときに限る。
// 少しでも外れるものは省かず、通常の確認に回す（拒否はしない）。

// コマンドを引用符を考慮して区切る。戻り値: { segments: [{ tokens, pipes }] } か、解釈しきれないとき null。
// 区切り: && と改行。パイプ（|）は直前の部分に付ける。; || & と、展開（$ ` \）は解釈しきれないので null
export function splitCommand(command) {
  const segments = [];
  let tokens = [];
  let pipes = null; // パイプの後ろのトークン列の配列
  let cur = null; // 作りかけのトークン（null は無し）
  let q = null; // 引用符の種類
  const target = () => (pipes ? pipes[pipes.length - 1] : tokens);
  const flush = () => {
    if (cur !== null) target().push(cur);
    cur = null;
  };
  const endSegment = () => {
    flush();
    if (tokens.length || pipes) segments.push({ tokens, pipes: pipes ?? [] });
    tokens = [];
    pipes = null;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (q === "'") {
      if (c === "'") q = null;
      else cur += c;
      continue;
    }
    if (q === '"') {
      if (c === '"') q = null;
      else if (c === "$" || c === "`" || c === "\\") return null;
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      cur ??= "";
    } else if (c === "$" || c === "`" || c === "\\" || c === ";" || c === "(" || c === ")") return null;
    else if (c === "&" && command[i + 1] === "&") {
      endSegment();
      i++;
    } else if (c === "\n") endSegment();
    else if (c === "|") {
      if (command[i + 1] === "|") return null;
      flush();
      (pipes ??= []).push([]);
    } else if (c === "&") {
      // 2>&1・&>/dev/null の & だけを許す（後回しの & は許さない）
      if (!(cur !== null && /^\d?>$/.test(cur)) && command[i + 1] !== ">") return null;
      cur = (cur ?? "") + c;
    } else if (c === " " || c === "\t") flush();
    else cur = (cur ?? "") + c;
  }
  if (q) return null;
  endSegment();
  return segments;
}

// 許すリダイレクト（出力を捨てる・まとめるだけ）。ファイルへの書き出しは含めない
const SAFE_REDIRECT = /^(\d?>&\d|\d?>\/dev\/null|&>\/dev\/null)$/;
// パイプの後ろに許すのは、出力の末尾・先頭を切り出すだけのコマンド
const safePipe = (t) => (t[0] === "tail" || t[0] === "head") && (t.length === 1 || (t.length === 2 && /^-\d+$/.test(t[1])) || (t.length === 3 && t[1] === "-n" && /^\d+$/.test(t[2])));

// 確認を省ける push のオプション。強制・削除・タグ・pre-push の省略・任意のコマンド実行につながるものは含めない
const SAFE_PUSH_OPTS = new Set(["-u", "--set-upstream", "-q", "--quiet", "-v", "--verbose", "--porcelain", "-n", "--dry-run", "--progress", "--no-progress"]);

// git push の部分が確認を省ける形か。省けるなら { kind, cwd, args } を返す
function safePush(t, cur) {
  if (t[0] !== "git") return null; // 環境変数の前置（GIT_SSH_COMMAND など）は許さない
  let dir = cur;
  let i = 1;
  while (i < t.length && t[i].startsWith("-")) {
    if (t[i] !== "-C" || !t[i + 1]) return null; // -c（設定の上書き）などは許さない
    dir = t[i + 1].startsWith("/") ? t[i + 1] : join(dir, t[i + 1]);
    i += 2;
  }
  if (t[i] !== "push") return null;
  const args = [];
  for (const a of t.slice(i + 1)) {
    if (SAFE_REDIRECT.test(a)) continue;
    if (/[<>]/.test(a)) return null;
    if (a.startsWith("-")) {
      if (!SAFE_PUSH_OPTS.has(a)) return null;
    } else if (a.startsWith("+") || a.startsWith(":") || a.includes(":+") || a.includes("refs/tags/")) return null; // 強制・削除・タグ
    args.push(a);
  }
  return { kind: "push", cwd: dir, args };
}

// gh pr create のオプション。値を取るものと取らないもの。他のリポジトリを指す -R・ブラウザを開く -w などは含めない
const PR_VALUE_OPTS = { "-B": "base", "--base": "base", "-H": "head", "--head": "head", "-t": null, "--title": null, "-b": null, "--body": null, "-F": null, "--body-file": null, "-l": null, "--label": null, "-a": null, "--assignee": null, "-r": null, "--reviewer": null, "-m": null, "--milestone": null, "-p": null, "--project": null, "-T": null, "--template": null };
const PR_FLAG_OPTS = new Set(["-d", "--draft", "-f", "--fill", "--fill-first", "--fill-verbose", "--no-maintainer-edit", "--dry-run"]);

// gh pr create の部分が確認を省ける形か。省けるなら { kind, cwd, base, head } を返す
function safePullRequest(t, cur) {
  if (t[0] !== "gh" || t[1] !== "pr" || t[2] !== "create") return null;
  let base = null;
  let head = null;
  for (let i = 3; i < t.length; i++) {
    let a = t[i];
    if (SAFE_REDIRECT.test(a)) continue;
    let value;
    const eqAt = a.startsWith("--") ? a.indexOf("=") : -1;
    if (eqAt > 0) {
      value = a.slice(eqAt + 1);
      a = a.slice(0, eqAt);
    }
    if (a in PR_VALUE_OPTS) {
      if (value === undefined) {
        if (i + 1 >= t.length) return null;
        value = t[++i];
      }
      if (PR_VALUE_OPTS[a] === "base") base = value;
      if (PR_VALUE_OPTS[a] === "head") head = value;
    } else if (!PR_FLAG_OPTS.has(a) || value !== undefined) return null;
  }
  if (!base) return null; // 省くと gh はリポジトリの既定ブランチ（保護ブランチのことが多い）を使うので、明示を求める
  if (head?.includes(":")) return null; // 別のリポジトリのブランチは対象外
  return { kind: "pullRequest", cwd: cur, base, head: head ?? currentBranch(cur) };
}

export function autoApprovable(command, cwd) {
  const segments = splitCommand(command);
  if (!segments) return false;
  let cur = cwd;
  const ops = [];
  for (const { tokens: t, pipes } of segments) {
    if (pipes.some((p) => !safePipe(p))) return false;
    if (t.length === 0) return false;
    if (t[0] === "cd" && t.length === 2 && pipes.length === 0) {
      cur = t[1].startsWith("/") ? t[1] : join(cur, t[1]);
      continue;
    }
    const op = safePush(t, cur) ?? safePullRequest(t, cur);
    if (!op) return false;
    ops.push(op);
  }
  if (ops.length === 0) return false;
  for (const op of ops) {
    const root = repoRoot(op.cwd);
    if (!root) return false;
    const { config, error } = loadConfig(root);
    // 未指定は有効・明示的な false は無効・未登録/編集中は無効（lib.mjs の autoApproveOf と同じ規則）
    if (error || !config || !autoApproveOf(config, configMatchesHead(root))[op.kind]) return false;
    if (op.kind === "push") {
      if (!sameNamePush(op.args, op.cwd)) return false;
      const targets = pushTargets(op.args, op.cwd);
      if (!targets || targets.length === 0) return false;
      if (targets.some((b) => judgeBranch(config, b).decision !== "allow")) return false;
    } else {
      // 取り込み先は切り出し元だけ。取り込み元は作業ブランチ（保護ブランチでない）
      if (op.base !== config.baseBranch) return false;
      if (!op.head || judgeBranch(config, op.head).decision !== "allow") return false;
    }
  }
  return true;
}
// 送り先が、判定に使ったブランチ名そのものになるか。git の設定で別のブランチへ送られうるときは false
function sameNamePush(args, cwd) {
  // remote.<名前>.push は送り先の対応を書き換える（develop を main へ送る、など）
  if (git(cwd, "config", "--get-regexp", "^remote\\..*\\.push$")) return false;
  const refspecs = args.filter((a) => !a.startsWith("-")).slice(1);
  if (refspecs.length > 0) return true;
  // 送り先を省いた push は push.default と追跡先で決まる。同じ名前へ送る設定でなければ省かない
  const mode = git(cwd, "config", "--get", "push.default") ?? "simple";
  if (!["simple", "current"].includes(mode)) return false;
  const branch = currentBranch(cwd);
  if (!branch) return false;
  const merge = git(cwd, "config", "--get", `branch.${branch}.merge`);
  return merge === null || merge === `refs/heads/${branch}`;
}

async function hook() {
  let input = "";
  for await (const c of process.stdin) input += c;
  let ev;
  try {
    ev = JSON.parse(input);
  } catch {
    return; // 判定不能なときは何もしない
  }
  if (ev.tool_name !== "Bash" || !ev.tool_input?.command) return;
  const r = judgeCommand(ev.tool_input.command, ev.cwd ?? process.cwd());
  if (r.decision === "allow") {
    if (autoApprovable(ev.tool_input.command, ev.cwd ?? process.cwd())) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "[branch-release-workflow] 作業ブランチ運用の操作です（宣言の autoApprove により確認を省きます）。" },
      }));
    }
    return;
  }
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: r.decision, permissionDecisionReason: `[branch-release-workflow] ${r.reason}` },
  }));
}

// ---- 各サブコマンド -------------------------------------------------------------

// 共通判定（classifyBranch）の分類の表示名。判定の理由に使う
const CLASS_LABEL = { protected: "保護ブランチ", base: "恒常的な分岐元", undeclared: "宣言外のブランチ", development: "開発ブランチ" };

function need(root) {
  const { config, error } = loadConfig(root);
  if (error) fail(error);
  if (!config) fail(`宣言ファイル ${CONFIG_REL} がありません。スキルの assets/config.example.json を元に作成してください。`);
  return config;
}

function fail(msg, code = 1) {
  console.error(`エラー: ${msg}`);
  process.exit(code);
}

// 作業ブランチ名の接頭辞（workBranches の最初の "xxx/*" 形式）
function branchPrefix(config) {
  const g = config.workBranches.find((w) => /\/\*+$/.test(w));
  return g ? g.replace(/\*+$/, "") : null;
}

function create(args) {
  const root = repoRoot(process.cwd()) ?? fail("git リポジトリ内で実行してください。", 2);
  const config = need(root);
  let name, base = config.baseBranch, branchOnly = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--base") base = args[++i] ?? fail("--base に値が必要です。", 2);
    else if (args[i] === "--branch-only") branchOnly = true;
    else if (!name) name = args[i];
    else fail("引数が不正です。", 2);
  }
  if (!name) fail("使い方: create <名前> [--base <ブランチ>] [--branch-only]", 2);
  const prefix = branchPrefix(config);
  const branch = matchesAny(config.workBranches, name) ? name : prefix ? prefix + name : fail(`workBranches（${config.workBranches.join(", ")}）に新規作成できるパターン（xxx/*）がありません。`);
  // 作れるのは共通判定で開発ブランチと分類されるものだけ（保護・分岐元・命名規則違反は拒否）
  const cls = classifyBranch(config, branch);
  if (cls === "protected") fail(`'${branch}' は保護ブランチです。`);
  if (cls === "base") fail(`'${branch}' は恒常的な分岐元のため、作業ブランチとして作れません。`);
  if (cls !== "development") {
    const bad = checkName(config, branch) ?? `'${branch}' は workBranches（${config.workBranches.join(", ")}）に一致しません。`;
    fail(`${bad}\n  namePattern: ${config.namePattern ?? "(なし)"} / 最大 ${config.maxNameLength} 文字`);
  }
  if (git(root, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`) !== null || git(root, "show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`) !== null)
    fail(`ブランチ ${branch} は既に存在します。`);
  if (git(root, "fetch", "origin", base, "--quiet") === null) console.error(`警告: origin/${base} を取得できませんでした。ローカルの ${base} を使います。`);
  const start = git(root, "show-ref", "--verify", "--quiet", `refs/remotes/origin/${base}`) !== null ? `origin/${base}`
    : git(root, "show-ref", "--verify", "--quiet", `refs/heads/${base}`) !== null ? base : fail(`分岐元ブランチ ${base} が見つかりません。`);
  // 導入時は、宣言ファイルが分岐元にまだ無い。作業ブランチで登録するため、新しい worktree へ移す
  const rel = configRel(root);
  const unregistered = git(root, "cat-file", "-e", `${start}:${rel}`) === null;
  if (branchOnly) {
    execFileSync("git", ["branch", "--no-track", branch, start], { cwd: root, stdio: "inherit" });
    console.log(`ブランチを作成しました: ${branch}（分岐元: ${start}）`);
    if (unregistered) console.log(`注意: ${rel} は ${start} に登録されていません。このブランチで commit して登録してください。`);
  } else {
    const wt = join(root, ".claude/worktrees", aliasOf(branch));
    mkdirSync(join(root, ".claude/worktrees"), { recursive: true });
    execFileSync("git", ["worktree", "add", "--no-track", "-b", branch, wt, start], { cwd: root, stdio: "inherit" });
    console.log(`ブランチと worktree を作成しました: ${branch}\n  worktree: ${wt}`);
    hooksForWorktree(worktrees(root)[0]?.path ?? root, wt);
    if (unregistered) {
      mkdirSync(dirname(join(wt, rel)), { recursive: true });
      renameSync(join(root, rel), join(wt, rel));
      console.log(`${rel} は ${start} に登録されていないため、worktree へ移しました。この作業ブランチで commit して登録してください。`);
    }
  }
  git(root, "config", `branch.${branch}.brwBase`, base); // finish が取り込み先を判定するため
  const url = previewUrl(config, branch);
  if (url) console.log(`プレビューURL（push 後）: ${url}`);
}

// 新しい worktree で Codex のフックが読まれるようにする。Codex は linked worktree で親チェックアウトの .codex/hooks.json を読むが、
// worktree 自身に .codex/ ディレクトリがあるときだけ（8.4 実機）。登録と信頼は親に結び付く。親に BRW の登録が無ければ何もしない。
// 失敗しても作成は成功のまま、注意だけを表示する。
function hooksForWorktree(parent, wt) {
  try {
    const r = installWorktreeHooks({ parentDir: parent, worktreeDir: wt });
    if (r.status === "skipped") return;
    if (r.status === "failed") console.log(`注意: この worktree の .codex/ を作れず、Codex のフックが読まれない可能性があります。install-codex.mjs --repo ${wt} で確認してください。`);
    else console.log("Codex のフックをこの worktree で有効にしました（親チェックアウトの登録を読みます）。親で /hooks の承認が済んでいなければ、承認するまで読み込まれません（承認は親と共通）。");
  } catch (error) {
    console.log(`注意: この worktree の Codex フックの有効化に失敗しました: ${error.message}`);
  }
}

// 作業ブランチの切り出し元。create が記録したもの、無ければ宣言の baseBranch
const baseOf = branchBase;

// 作業ブランチが片付けてよい状態か。切り出し元へ取り込まれた、または保護ブランチへの PR がある、のどれかを満たすと done。
// 取り込みは commit の祖先関係のほか、squash merge を見込んで「ブランチで変えたファイルが切り出し元で同じ内容」でも判定する
// 取り込み先の ref（origin の追跡ブランチがあればそれ、無ければローカル）
const targetOf = (repo, base) => (git(repo, "show-ref", "--verify", "--quiet", `refs/remotes/origin/${base}`) !== null ? `origin/${base}` : base);

// 遠隔の同名ブランチの状態。present（存在し、追跡ブランチを更新済み）・absent（存在しない）・unknown（確かめられない）
function remoteState(cwd, branch) {
  const r = spawnSync("git", ["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (r.status === 2) return { state: "absent" };
  if (r.status !== 0) return { state: "unknown", why: "リモートへの照会が失敗しました" };
  if (git(cwd, "fetch", "origin", branch, "--quiet") === null) return { state: "unknown", why: "リモートからの取得が失敗しました" };
  return { state: "present" };
}

function landedState(repo, config, branch, base) {
  git(repo, "fetch", "origin", base, "--quiet");
  const target = targetOf(repo, base);
  if (git(repo, "merge-base", "--is-ancestor", `refs/heads/${branch}`, target) !== null) return { done: true, how: `${target} に取り込まれています` };
  const mb = git(repo, "merge-base", `refs/heads/${branch}`, target);
  const files = mb ? (git(repo, "diff", "--name-only", mb, `refs/heads/${branch}`) ?? "").split("\n").filter(Boolean) : [];
  if (mb && files.length && git(repo, "diff", "--quiet", `refs/heads/${branch}`, target, "--", ...files) !== null)
    return { done: true, how: `変更が ${target} に取り込まれています（squash merge など）` };
  const gh = spawnSync("gh", ["pr", "list", "--head", branch, "--state", "all", "--json", "baseRefName,state,url", "--limit", "20"], { cwd: repo, encoding: "utf8" });
  if (gh.status === 0) {
    let prs = [];
    try {
      prs = JSON.parse(gh.stdout);
    } catch {}
    const merged = prs.find((p) => p.state === "MERGED" && p.baseRefName === base);
    if (merged) return { done: true, how: `${base} への PR がマージされています（${merged.url}）` };
    const toProtected = prs.find((p) => p.state !== "CLOSED" && matchesAny(config.protectedBranches ?? [], p.baseRefName));
    if (toProtected) return { done: true, how: `保護ブランチ ${toProtected.baseRefName} への PR があります（${toProtected.url}）` };
  }
  return { done: false, how: `${base} にまだ取り込まれておらず、保護ブランチへの PR も見つかりません${gh.status === 0 ? "" : "（gh が使えないため PR は確認していません）"}` };
}

// 片付けの可否を確かめる。片付けられないときは理由を返す
function finishBlocker(main, others, config, branch, base) {
  if (classifyBranch(config, branch) !== "development") return `'${branch}' は作業ブランチではありません。`;
  if (git(main.path, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`) === null) return `ローカルに ${branch} がありません。`;
  const wt = others.find((w) => w.branch === branch);
  if (wt && git(wt.path, "status", "--porcelain") !== "") return `worktree ${wt.path} に commit していない変更があります。`;
  if (main.branch === branch) return `本体の作業ツリーが ${branch} を使っています。`;
  const landed = landedState(main.path, config, branch, base);
  if (!landed.done) return landed.how;
  // 取り込み後に積んだ commit が手元にしか無ければ消さない。遠隔の状態を確かめられないときも残す
  const rs = remoteState(main.path, branch);
  if (rs.state === "unknown") return `遠隔（origin）の状態を確認できないため残します（${rs.why}）。`;
  // 遠隔に無いのは、squash マージ後にリモートのブランチが削除された場合にも起きる。取り込みの判定（landed）は上で満たしているので片付けてよい
  if (rs.state === "absent") return null;
  const ahead = git(main.path, "rev-list", "--count", `origin/${branch}..refs/heads/${branch}`);
  if (ahead !== "0") return `${branch} に push していない commit があります（${ahead ?? "不明"} 件）。`;
  return null;
}

function removeBranch(main, others, branch) {
  const wt = others.find((w) => w.branch === branch);
  // 変更が無いことは確かめてある。submodule を含む worktree は --force が無いと消せないため付ける
  if (wt) execFileSync("git", ["worktree", "remove", "--force", wt.path], { cwd: main.path, stdio: "inherit" });
  execFileSync("git", ["branch", "-D", branch], { cwd: main.path, stdio: "inherit" });
  return wt;
}

// 切り出し元へ取り込まれた（または保護ブランチへの PR を作った）作業ブランチの worktree とローカルブランチを消す。
// --merged なら、そうなっている作業ブランチをまとめて片付ける。自分の worktree の中からも実行できるよう、git の操作は本体の作業ツリーで行う
function finish(args) {
  const cwd = process.cwd();
  repoRoot(cwd) ?? fail("git リポジトリ内で実行してください。", 2);
  const [main, ...others] = worktrees(cwd);
  const config = need(main.path);
  const baseArg = args.includes("--base") ? args[args.indexOf("--base") + 1] ?? fail("--base に値が必要です。", 2) : null;
  if (args.includes("--merged")) {
    const branches = (git(main.path, "for-each-ref", "--format=%(refname:short)", "refs/heads") ?? "").split("\n")
      .filter((b) => b && classifyBranch(config, b) === "development");
    let n = 0;
    for (const b of branches) {
      const why = finishBlocker(main, others, config, b, baseArg ?? baseOf(main.path, config, b));
      if (why) console.log(`残します: ${b} — ${why}`);
      else {
        const wt = removeBranch(main, others, b);
        console.log(`片付けました: ${b}${wt ? `（worktree: ${wt.path}）` : ""}`);
        n++;
      }
    }
    if (!n) console.log("片付けられる作業ブランチはありませんでした。");
    return;
  }
  const branch = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--base") ?? currentBranch(cwd) ?? fail("使い方: finish [ブランチ] [--base <切り出し元>] | finish --merged", 2);
  const base = baseArg ?? baseOf(main.path, config, branch);
  const why = finishBlocker(main, others, config, branch, base);
  if (why) fail(`${why}\n  ${branch} は片付けません。worktree は、切り出し元（${base}）へのマージか、保護ブランチへの PR 作成の後に片付けます。`);
  const wt = removeBranch(main, others, branch);
  console.log(`片付けました: ${branch}${wt ? `（worktree: ${wt.path}）` : ""}`);
  console.log(`同じブランチで続けるときは \`brw resume ${branch}\`、新しい作業は \`brw create <名前>\` で、リモートから取得し直して作ります。`);
}

// 開発ブランチ同士の取り込み。取り込み元は、確かめた時点のローカルの commit（OID）に固定してマージする。
// PR は作らず、GitHub（gh）にも接続しない。競合は自動解決せず、中断している旨と解決方法を示す。
function merge(args) {
  const cwd = process.cwd();
  const root = repoRoot(cwd) ?? fail("git リポジトリ内で実行してください。", 2);
  const config = need(root);
  const pos = args.filter((a) => !a.startsWith("--"));
  if (args.length !== 1 || pos.length !== 1) fail("使い方: merge <取り込み元の開発ブランチ>（取り込み先は現在の worktree のブランチ）", 2);
  const source = pos[0];
  const target = currentBranch(root) ?? fail("detached HEAD のため、取り込み先のブランチを確定できません。");
  // 共通判定: 取り込み元・先がともに宣言上の開発ブランチであること
  const tCls = classifyBranch(config, target);
  if (tCls !== "development") fail(`取り込み先 '${target}' は${CLASS_LABEL[tCls]}のため、ローカルマージできません。マージ先は開発ブランチだけです。`);
  const sCls = classifyBranch(config, source);
  if (sCls !== "development") fail(`取り込み元 '${source}' は${CLASS_LABEL[sCls]}のため、ローカルマージできません。開発ブランチ間の取り込みだけが対象です。`);
  if (source === target) fail(`取り込み元と取り込み先が同じブランチ（${target}）です。`);
  if (git(root, "rev-parse", "-q", "--verify", "MERGE_HEAD") !== null) fail("前の取り込みが終わっていません。競合を解決して commit するか、`git merge --abort` で取り消してから再実行してください。");
  const status = git(root, "status", "--porcelain");
  if (status === null || status !== "") fail("未コミットの変更があるため取り込みません。commit するか退避してから再実行してください。");
  // 取り込み元はローカルのブランチの現在の commit に固定する（リモートの状態は見ない）
  const oid = git(root, "rev-parse", "--verify", "--quiet", `refs/heads/${source}`);
  if (!oid) fail(`取り込み元 '${source}' がローカルにありません。`);
  const r = spawnSync("git", ["merge", "--no-edit", "-m", `Merge branch '${source}' into ${target}`, oid], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  process.stdout.write(r.stdout ?? "");
  process.stderr.write(r.stderr ?? "");
  if (r.status === 0) return console.log(`取り込みました: ${source}（${oid.slice(0, 12)}）→ ${target}。PR は作成していません。`);
  if (git(root, "rev-parse", "-q", "--verify", "MERGE_HEAD") !== null) {
    const files = (git(root, "diff", "--name-only", "--diff-filter=U") ?? "").split("\n").filter(Boolean);
    console.log(`競合が起きたため、取り込みを中断しています（自動解決はしていません）。\n競合ファイル:\n${files.map((f) => `  - ${f}`).join("\n")}`);
    console.log("解決する場合は競合を手で直して commit してください。取り消す場合は `git merge --abort` を実行してください。");
    process.exit(1);
  }
  fail(`取り込みに失敗しました（${source} → ${target}）。取り込みは行われていません。`);
}

// 作業ブランチの続きを始める。ローカルに無ければリモートから取得し直して worktree を作り、
// 残っていればリモートの更新（別の環境からの push など）を取り込んでから使う
function resume(args) {
  const cwd = process.cwd();
  repoRoot(cwd) ?? fail("git リポジトリ内で実行してください。", 2);
  const [main, ...others] = worktrees(cwd);
  const config = need(main.path);
  const branch = args.find((a) => !a.startsWith("--")) ?? fail("使い方: resume <ブランチ>", 2);
  // 共通判定: 再開できるのは開発ブランチだけ（保護・分岐元・宣言外は拒否）
  const cls = classifyBranch(config, branch);
  if (cls !== "development") fail(`'${branch}' は${CLASS_LABEL[cls]}のため、作業ブランチとして再開できません。`);
  const remote = git(main.path, "fetch", "origin", branch, "--quiet") !== null;
  if (git(main.path, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`) !== null) {
    const wt = others.find((w) => w.branch === branch);
    if (!wt) {
      // ローカルにだけあるブランチ（リモートにあるならそれと同じ線上にあること）から worktree を作る
      if (main.branch === branch) fail(`${branch} は本体の作業ツリーで使用中のため、worktree を作れません。`);
      if (remote && git(main.path, "merge-base", "--is-ancestor", `refs/heads/${branch}`, `refs/remotes/origin/${branch}`) === null
        && git(main.path, "merge-base", "--is-ancestor", `refs/remotes/origin/${branch}`, `refs/heads/${branch}`) === null)
        fail(`${branch} がリモートと分岐しています（rebase された可能性があります）。差分を確かめてから取り込んでください。worktree は作っていません。`);
      const newWt = join(main.path, ".claude/worktrees", aliasOf(branch));
      mkdirSync(join(main.path, ".claude/worktrees"), { recursive: true });
      execFileSync("git", ["worktree", "add", newWt, branch], { cwd: main.path, stdio: "inherit" });
      if (remote && git(newWt, "merge", "--ff-only", "--quiet", `origin/${branch}`) === null)
        fail(`${branch} の worktree を作りましたが、リモートの更新を取り込めませんでした: ${newWt}`);
      console.log(`ローカルのブランチから worktree を作りました${remote ? "（リモートの更新を取り込みました）" : "（リモートにはまだありません）"}: ${branch}\n  worktree: ${newWt}`);
      hooksForWorktree(main.path, newWt);
      return;
    }
    if (remote) {
      if (git(wt.path, "status", "--porcelain") !== "") fail(`worktree ${wt.path} に commit していない変更があるため、リモートの更新を取り込めません。`);
      if (git(wt.path, "merge", "--ff-only", "--quiet", `origin/${branch}`) === null)
        fail(`${branch} がリモートと分岐しています（rebase された可能性があります）。差分を確かめてから取り込んでください。`);
    }
    console.log(`既存の worktree を使います${remote ? "（リモートの更新を取り込みました）" : "（リモートにはまだありません）"}: ${branch}\n  worktree: ${wt.path}`);
    return;
  }
  if (!remote) fail(`origin/${branch} を取得できません。`);
  const wt = join(main.path, ".claude/worktrees", aliasOf(branch));
  mkdirSync(join(main.path, ".claude/worktrees"), { recursive: true });
  execFileSync("git", ["worktree", "add", "--track", "-b", branch, wt, `origin/${branch}`], { cwd: main.path, stdio: "inherit" });
  console.log(`リモートから取得し直して worktree を作りました: ${branch}\n  worktree: ${wt}`);
  hooksForWorktree(main.path, wt);
  const url = previewUrl(config, branch);
  if (url) console.log(`プレビューURL（push 後）: ${url}`);
}

function url(args) {
  const root = repoRoot(process.cwd()) ?? fail("git リポジトリ内で実行してください。", 2);
  const config = need(root);
  const branch = args[0] ?? currentBranch(root) ?? fail("ブランチを特定できません。", 2);
  if (config.preview.provider === "none") fail("宣言の preview が無効（provider: none）のため、プレビューURLはありません。");
  if (!matchesAny(config.workBranches, branch) || checkName(config, branch)) fail(`ブランチ '${branch}' は作業ブランチの命名規則に合わないため、プレビューは発行されません。`);
  const { url: u, missing } = previewUrlInfo(config, branch, root);
  console.log(u);
  if (missing.length) console.error(`注意: 変数 ${missing.join(", ")} を解決できませんでした（環境変数か GitHub Variables を設定してください）。`);
}

// 終了コードを返す（既存の宣言・workflow の誤りは 1）。フックと Ruleset の状態は setup-cli の追加節で表示する（7.3）
async function check(args = []) {
  if (args.some((arg) => !["--branches-only", "--ruleset"].includes(arg))) fail("使い方: check [--branches-only] [--ruleset]", 2);
  if (args.includes("--branches-only") && args.includes("--ruleset")) fail("--branches-only と --ruleset は同時に使えません（--branches-only は宣言と分岐の整合だけを見ます）。", 2);
  const root = repoRoot(process.cwd()) ?? fail("git リポジトリ内で実行してください。", 2);
  const config = need(root);
  const findings = [];
  if (!configCommitted(root))
    findings.push({ level: "error", message: `${configRel(root)} が commit されていません。CI やほかの clone から宣言が見えないため、commit してリポジトリに登録してください。` });
  for (const f of undeclaredCiBranches(config, scanWorkflows(root)))
    findings.push({ level: "warn", message: `${f.file}: push 対象 '${f.glob}' が宣言の workBranches / protectedBranches に含まれません（意図しない CI/デプロイの可能性）。` });
  if (!args.includes("--branches-only")) {
    if (config.deploy) findings.push(...deployCf.check(root, config));
    findings.push(...getProvider(config).check(root, config));
  }
  for (const f of findings) console.log(`${f.level === "error" ? "ERROR" : "WARN "} ${f.message}`);
  console.log("\n注意: workflow が本番向けかどうか（wrangler deploy か preview か等）と、リポジトリ外の設定（Pages の本番ブランチ等）は機械判定できません。");
  const configFailed = findings.some((f) => f.level === "error");
  if (!findings.length) console.log("整合性の問題は見つかりませんでした。");
  if (args.includes("--branches-only")) return configFailed ? 1 : 0;
  const state = await runStateCheck(root, { ruleset: args.includes("--ruleset") });
  return configFailed ? 1 : state;
}

function genWorkflow(args) {
  const root = repoRoot(process.cwd()) ?? fail("git リポジトリ内で実行してください。", 2);
  const config = need(root);
  const kind = args.find((a) => !a.startsWith("--")) ?? "preview";
  if (!["preview", "deploy"].includes(kind) || args.some((a) => a.startsWith("--") && a !== "--write")) fail("使い方: gen-workflow [preview|deploy] [--write]", 2);
  let text;
  if (kind === "deploy") text = config.deploy ? deployCf.workflow(config) : fail("宣言に deploy（配備先）がありません。");
  else text = getProvider(config).workflow(config) ?? fail(`provider '${config.preview.provider}' には workflow 雛形がありません。`);
  if (!args.includes("--write")) return process.stdout.write(text);
  const path = join(root, `.github/workflows/${kind}.yaml`);
  if (existsSync(path)) fail(`${path} は既に存在します（上書きしません）。`);
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  writeFileSync(path, text);
  console.log(`作成しました: ${path}`);
}

function cleanup(args) {
  const root = repoRoot(process.cwd()) ?? fail("git リポジトリ内で実行してください。", 2);
  const config = need(root);
  const branch = args.find((a) => !a.startsWith("--")) ?? fail("使い方: cleanup <ブランチ> [--execute]", 2);
  const c = getProvider(config).cleanup(config, branch, root);
  if (!c) return console.log(`provider '${config.preview.provider}' には後始末がありません。`);
  if (c.error) fail(c.error);
  console.log(`${c.cmd} ${c.args.join(" ")}`);
  if (!args.includes("--execute")) return console.log("（表示のみ。実行するには --execute）");
  process.exit(spawnSync(c.cmd, c.args, { cwd: root, stdio: "inherit" }).status ?? 1);
}

// 宣言ファイルや git リポジトリが無くても動く（CI の設定生成でも使えるようにするため）。
// 宣言が読めれば、その urlTemplate から配信方式を判定する。読めなければ独自ドメイン配信として扱う
function wranglerConfig(args) {
  const root = repoRoot(process.cwd());
  const { config } = root ? loadConfig(root) : {};
  const delivery = config?.preview?.provider === "none" ? "custom-domain" : deliveryOf(config?.preview?.urlTemplate);
  const file = args.find((a) => !a.startsWith("--")) ?? "wrangler.jsonc";
  if (!/\.jsonc?$/.test(file)) fail(`${file} は JSONC / JSON ではありません（toml は対象外です）。`);
  if (!existsSync(file)) fail(`${file} が見つかりません。`);
  let r;
  try {
    r = applyWorkersDev(readFileSync(file, "utf8"), delivery);
  } catch (e) {
    fail(`${file} を処理できません: ${e.message}`);
  }
  if (!args.includes("--write")) return process.stdout.write(r.text);
  writeFileSync(file, r.text);
  console.log(`${file}: 有効な独自ドメインが${r.active ? "ある" : "ない"}${delivery === "workers-dev" ? "（workers.dev 配信）" : ""}ため workers_dev: ${r.want.workers_dev} / preview_urls: ${r.want.preview_urls} にしました`);
}

// 共有テンプレートと宣言から、指定した配備先の wrangler 設定を生成する。
function renderWrangler(args) {
  const root = repoRoot(process.cwd()) ?? process.cwd();
  const config = need(root);
  if (!config.deploy) fail("宣言に deploy（配備先）がありません。配備先を宣言しない構成では wrangler-config を使います。");
  const ti = args.indexOf("--target");
  const target = ti >= 0 ? args[ti + 1] : undefined;
  if (!target || args.some((a, i) => a !== "--write" && i !== ti && i !== ti + 1)) fail("使い方: render-wrangler --target <配備先> [--write]", 2);
  const r = deployCf.render(root, config, target);
  if (r.error) fail(r.error);
  if (!args.includes("--write")) return process.stdout.write(r.text);
  process.exit(deployCf.writeAndHook(root, config, target, r));
}

// 手順書の経路で、共通の判定の拒否を必ず止める操作の種類: ブランチの作成・再開（create）と PR 作成（pr-create）
const GUARD_OP_KINDS = ["create", "pr-create"];

// Codex などフックが自動適用されない環境向け。判定のみ行い、コマンドは実行しない。
function guard(args) {
  if (args.length !== 1) fail('使い方: guard "git commit / git push のコマンド"', 2);
  // 作成・再開・PR 作成を含むコマンドは、共通の判定（フックと同じ）が拒否したら、拒否の code によらず止める。
  // それ以外（commit・push だけ）は従来の判定へ進み、出力と終了コードを変えない
  const denial = denyOfCommand(args[0], process.cwd());
  if (denial && denial.kinds.some((k) => GUARD_OP_KINDS.includes(k))) {
    console.log(`[deny] ${denial.reason}`);
    process.exit(1);
  }
  const result = judgeCommand(args[0], process.cwd());
  console.log(`[${result.decision}] ${result.reason ?? "ブランチ規則に適合しています。"}`);
  if (result.decision !== "allow") process.exit(1);
}

// Node は import.meta.url を実体のパスに解決するが、argv は Codex 導入先のリンクのまま。
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
if (isMain) {
  const [sub, ...rest] = process.argv.slice(2);
  const cmds = {
    guard, hook, create, finish, resume, merge, url, "gen-workflow": genWorkflow,
    // 導入・移行と状態検査（7.3）。終了コードは各関数が返す
    check: async (a) => { process.exitCode = await check(a); },
    setup: async (a) => { process.exitCode = await runSetup(a); }, cleanup, "wrangler-config": wranglerConfig, "render-wrangler": renderWrangler,
    // 完了公開（7.2）。終了コードは各関数が返す
    work: async (a) => { process.exitCode = await runWork(a); },
    publish: async (a) => { process.exitCode = await runPublish(a); },
    pause: async (a) => { process.exitCode = await runPause(a); },
  };
  if (!cmds[sub]) fail(`サブコマンドは ${Object.keys(cmds).join(" / ")} のいずれかです。`, 2);
  await cmds[sub](rest);
}
