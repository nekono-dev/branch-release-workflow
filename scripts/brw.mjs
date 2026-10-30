#!/usr/bin/env node
// branch-release-workflow の CLI。サブコマンド:
//   hook                       PreToolUse フック（標準入力の JSON を判定して deny/ask を返す）
//   create <名前> [--base b] [--branch-only]   作業ブランチ（と worktree）を命名規則に従って作成
//   finish [ブランチ] | --merged  切り出し元へ取り込まれた（保護ブランチへの PR がある）作業ブランチの worktree を片付ける
//   resume <ブランチ>          作業ブランチの続きを始める（無ければリモートから worktree を作り直す）
//   url [ブランチ]             プレビューURLを表示
//   check                      宣言・workflow・provider 設定の整合検査
//   gen-workflow [--write]     provider の preview workflow 雛形を出力（--write で .github/workflows/preview.yaml へ）
//   cleanup <ブランチ> [--execute]  provider 固有の後始末（既定は表示のみ）
//   wrangler-config [ファイル] [--write]  独自ドメインの有効状況に応じて wrangler 設定の workers_dev / preview_urls を設定
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CONFIG_REL, configRel, checkName, configCommitted, currentBranch, enabledInRepo, git, globToRegExp, judgeBranch, loadConfig, matchesAny, repoRoot,
  scanWorkflows, shortRef, undeclaredCiBranches, aliasOf, worktrees,
} from "./lib.mjs";
import { getProvider, previewUrl } from "./providers/index.mjs";
import { applyWorkersDev } from "./providers/cloudflare-previews.mjs";

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
  if (r.decision === "allow") return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: r.decision, permissionDecisionReason: `[branch-release-workflow] ${r.reason}` },
  }));
}

// ---- 各サブコマンド -------------------------------------------------------------

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
  if (matchesAny(config.protectedBranches ?? [], branch)) fail(`'${branch}' は保護ブランチです。`);
  const bad = checkName(config, branch);
  if (bad) fail(`${bad}\n  namePattern: ${config.namePattern ?? "(なし)"} / 最大 ${config.maxNameLength} 文字`);
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

// 作業ブランチの切り出し元。create が記録したもの、無ければ宣言の baseBranch
const baseOf = (repo, config, branch) => git(repo, "config", `branch.${branch}.brwBase`) || config.baseBranch;

// 作業ブランチが片付けてよい状態か。切り出し元へ取り込まれた、または保護ブランチへの PR がある、のどれかを満たすと done。
// 取り込みは commit の祖先関係のほか、squash merge を見込んで「ブランチで変えたファイルが切り出し元で同じ内容」でも判定する
function landedState(repo, config, branch, base) {
  git(repo, "fetch", "origin", base, "--quiet");
  const target = git(repo, "show-ref", "--verify", "--quiet", `refs/remotes/origin/${base}`) !== null ? `origin/${base}` : base;
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
  if (!matchesAny(config.workBranches, branch) || matchesAny(config.protectedBranches ?? [], branch)) return `'${branch}' は作業ブランチではありません。`;
  if (git(main.path, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`) === null) return `ローカルに ${branch} がありません。`;
  const wt = others.find((w) => w.branch === branch);
  if (wt && git(wt.path, "status", "--porcelain") !== "") return `worktree ${wt.path} に commit していない変更があります。`;
  if (main.branch === branch) return `本体の作業ツリーが ${branch} を使っています。`;
  const landed = landedState(main.path, config, branch, base);
  if (!landed.done) return landed.how;
  // 取り込み後に積んだ commit が手元にしか無ければ消さない
  const remote = git(main.path, "fetch", "origin", branch, "--quiet") !== null;
  const ahead = remote ? git(main.path, "rev-list", "--count", `origin/${branch}..refs/heads/${branch}`) : null;
  if (remote && ahead !== "0") return `${branch} に push していない commit があります（${ahead ?? "不明"} 件）。`;
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
      .filter((b) => b && matchesAny(config.workBranches, b) && !matchesAny(config.protectedBranches ?? [], b));
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

// 作業ブランチの続きを始める。ローカルに無ければリモートから取得し直して worktree を作り、
// 残っていればリモートの更新（別の環境からの push など）を取り込んでから使う
function resume(args) {
  const cwd = process.cwd();
  repoRoot(cwd) ?? fail("git リポジトリ内で実行してください。", 2);
  const [main, ...others] = worktrees(cwd);
  const config = need(main.path);
  const branch = args.find((a) => !a.startsWith("--")) ?? fail("使い方: resume <ブランチ>", 2);
  if (!matchesAny(config.workBranches, branch) || matchesAny(config.protectedBranches ?? [], branch)) fail(`'${branch}' は作業ブランチではありません。`);
  const remote = git(main.path, "fetch", "origin", branch, "--quiet") !== null;
  if (git(main.path, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`) !== null) {
    const wt = others.find((w) => w.branch === branch);
    if (!wt) fail(`ローカルに ${branch} がありますが worktree がありません。\`git worktree add .claude/worktrees/${aliasOf(branch)} ${branch}\` で作ってください。`);
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
  const url = previewUrl(config, branch);
  if (url) console.log(`プレビューURL（push 後）: ${url}`);
}

function url(args) {
  const root = repoRoot(process.cwd()) ?? fail("git リポジトリ内で実行してください。", 2);
  const config = need(root);
  const branch = args[0] ?? currentBranch(root) ?? fail("ブランチを特定できません。", 2);
  if (config.preview.provider === "none") fail("宣言の preview が無効（provider: none）のため、プレビューURLはありません。");
  if (!matchesAny(config.workBranches, branch) || checkName(config, branch)) fail(`ブランチ '${branch}' は作業ブランチの命名規則に合わないため、プレビューは発行されません。`);
  console.log(previewUrl(config, branch));
}

function check(args = []) {
  if (args.some((arg) => arg !== "--branches-only")) fail("使い方: check [--branches-only]", 2);
  const root = repoRoot(process.cwd()) ?? fail("git リポジトリ内で実行してください。", 2);
  const config = need(root);
  const findings = [];
  if (!configCommitted(root))
    findings.push({ level: "error", message: `${configRel(root)} が commit されていません。CI やほかの clone から宣言が見えないため、commit してリポジトリに登録してください。` });
  for (const f of undeclaredCiBranches(config, scanWorkflows(root)))
    findings.push({ level: "warn", message: `${f.file}: push 対象 '${f.glob}' が宣言の workBranches / protectedBranches に含まれません（意図しない CI/デプロイの可能性）。` });
  if (!args.includes("--branches-only")) findings.push(...getProvider(config).check(root, config));
  for (const f of findings) console.log(`${f.level === "error" ? "ERROR" : "WARN "} ${f.message}`);
  console.log("\n注意: workflow が本番向けかどうか（wrangler deploy か preview か等）と、リポジトリ外の設定（Pages の本番ブランチ等）は機械判定できません。");
  if (findings.some((f) => f.level === "error")) process.exit(1);
  if (!findings.length) console.log("整合性の問題は見つかりませんでした。");
}

function genWorkflow(args) {
  const root = repoRoot(process.cwd()) ?? fail("git リポジトリ内で実行してください。", 2);
  const config = need(root);
  const text = getProvider(config).workflow(config);
  if (!text) fail(`provider '${config.preview.provider}' には workflow 雛形がありません。`);
  if (!args.includes("--write")) return process.stdout.write(text);
  const path = join(root, ".github/workflows/preview.yaml");
  if (existsSync(path)) fail(`${path} は既に存在します（上書きしません）。`);
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  writeFileSync(path, text);
  console.log(`作成しました: ${path}`);
}

function cleanup(args) {
  const root = repoRoot(process.cwd()) ?? fail("git リポジトリ内で実行してください。", 2);
  const config = need(root);
  const branch = args.find((a) => !a.startsWith("--")) ?? fail("使い方: cleanup <ブランチ> [--execute]", 2);
  const c = getProvider(config).cleanup(config, branch);
  if (!c) return console.log(`provider '${config.preview.provider}' には後始末がありません。`);
  console.log(`${c.cmd} ${c.args.join(" ")}`);
  if (!args.includes("--execute")) return console.log("（表示のみ。実行するには --execute）");
  process.exit(spawnSync(c.cmd, c.args, { cwd: root, stdio: "inherit" }).status ?? 1);
}

// 宣言ファイルや git リポジトリには依存しない（CI の設定生成でも使えるようにするため）
function wranglerConfig(args) {
  const file = args.find((a) => !a.startsWith("--")) ?? "wrangler.jsonc";
  if (!/\.jsonc?$/.test(file)) fail(`${file} は JSONC / JSON ではありません（toml は対象外です）。`);
  if (!existsSync(file)) fail(`${file} が見つかりません。`);
  let r;
  try {
    r = applyWorkersDev(readFileSync(file, "utf8"));
  } catch (e) {
    fail(`${file} を処理できません: ${e.message}`);
  }
  if (!args.includes("--write")) return process.stdout.write(r.text);
  writeFileSync(file, r.text);
  console.log(`${file}: 有効な独自ドメインが${r.active ? "あるため workers_dev / preview_urls を false にしました" : "ないため workers_dev / preview_urls を true にしました"}`);
}

// Codex などフックが自動適用されない環境向け。判定のみ行い、コマンドは実行しない。
function guard(args) {
  if (args.length !== 1) fail('使い方: guard "git commit / git push のコマンド"', 2);
  const result = judgeCommand(args[0], process.cwd());
  console.log(`[${result.decision}] ${result.reason ?? "ブランチ規則に適合しています。"}`);
  if (result.decision !== "allow") process.exit(1);
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const [sub, ...rest] = process.argv.slice(2);
  const cmds = { guard, hook, create, finish, resume, url, check, "gen-workflow": genWorkflow, cleanup, "wrangler-config": wranglerConfig };
  if (!cmds[sub]) fail(`サブコマンドは ${Object.keys(cmds).join(" / ")} のいずれかです。`, 2);
  await cmds[sub](rest);
}
