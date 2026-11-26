// フックの稼働と対応経路の診断（brw-enforcement 6.4）。読み取り専用。
// 「登録されている」（設定の内容の証拠）と「実際に応答する・記録する」（登録と同じ実行手段を、無害な合成入力で子プロセス実行した結果）を別々に確かめ、
// ホスト × 実行環境（ローカル・クラウド） × イベントの経路ごとに状態を返す。
// 状態: active（登録と応答・記録を確認）・not-installed（未導入）・untrusted（未信頼）・unsupported（非対応）・conflict（衝突）・unverifiable（確認不能）。
// 判定できないものは確認不能とし、成功とは表示しない。検査に使う一時リポジトリは毎回作って消す。導入先の設定は書かない。
// 資格情報は読まず、結果にも出さない。子プロセスには最小限の環境だけを渡す。CLI への接続（brw check・install の表示）は 7.x で行う。
// 外部依存なし（Node 標準ライブラリと内部モジュールのみ）。
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkClaudeHooks, codexCommand, hasManaged, hooksDisabled, mergeCodexHooks, registrationSourceOf } from "./hook-install.mjs";
import { load, markReady, startWork, stateFileOf } from "./publish.mjs";

/** ホストごとの経路のイベント。Claude は PermissionRequest を登録しない。 */
const ROUTE_EVENTS = { claude: ["PreToolUse", "PostToolUse", "Stop"], codex: ["PreToolUse", "PermissionRequest", "PostToolUse", "Stop"] };
const PROBE_TIMEOUT_MS = 20000;
const PROBE_PREFIX = "brw-diag-probe-";
const PROBE_REMOTE = "https://github.com/brw-diagnose/probe.git";
const PROBE_SESSION = "brw-diag-probe";
const PROBE_REPO = { id: 4242, owner: "brw-diagnose", name: "probe" };
const DECLARATION = { workBranches: ["dev/*"], protectedBranches: ["main"], baseBranch: "develop" };
// 子プロセスへ渡す最小限の環境。PATH と言語だけを既定で渡し、資格情報・利用者の Git 設定は渡さない
const BASE_ENV_KEYS = ["PATH", "LANG", "LC_ALL"];

const DENY = { name: "deny", expect: "deny", repo: "main", text: "git commit -m brw-diag" };
const ALLOW = { name: "allow", expect: "allow", repo: "dev", text: "git push origin dev/diag" };

/**
 * 経路ごとの確認。応答の形（expect）と、必要なら状態の記録（verify）を確かめる。
 * repo は検査用の一時リポジトリの種類。PostToolUse・Stop は状態を使うため、専用のリポジトリで確かめる。
 */
const probesOf = (host, event) => {
  if (event === "PreToolUse") return host === "claude" ? [DENY, ALLOW] : [DENY];
  if (event === "PermissionRequest") return [DENY, ALLOW];
  if (event === "PostToolUse") return [{ name: "attach", expect: "none", repo: "post", attach: true }, { name: "noop", expect: "none", repo: "main", text: "git status" }];
  return [{ name: "ready", expect: "block", repo: "stop" }, { name: "idle", expect: "none", repo: "main" }];
};

/** 経路 1 件を作る。 */
const route = (host, environment, event, status, reasonCode, reason, extra = {}) => ({
  host, environment, event, status, reasonCode, reason, managedHooksRequired: false, probes: [], ...extra,
});

/**
 * 対応していない経路（6.1・2.1・2.2・2.3・6.3 の申し送りの限界）。どのホストの、どの経路の限界かを示す。
 * 項目を増減したら、テストの EXPECTED_LIMIT_IDS も合わせる。
 */
const LIMITS = [
  { id: "origin-trust-base", host: "both", text: "origin 自体が別のリポジトリを指す場合、または url.<…>.insteadOf で origin ごと書き換えた場合は、信頼の基準が origin のため確認省略（allow）になります。" },
  { id: "codex-pretooluse-no-ask", host: "codex", text: "Codex の PreToolUse は ask を返せません。承認なしの実行環境では、参照を動かす操作の歯止めにならず、拒否だけが効きます。" },
  { id: "nested-shell", host: "both", text: "bash -c、括弧、サブシェルなど入れ子の命令は分類できません。確定できない変更は確認省略せず、拒否または通常の承認に任せます。" },
  { id: "url-without-github", host: "both", text: "curl・wget などで URL に github を含まない書き込み（GHES など）は検出できません。" },
  { id: "external-script-git", host: "both", text: "別のスクリプトや node・python・make 経由で git・gh を呼ぶ操作は検出できません。" },
  { id: "other-mcp", host: "both", text: "GitHub かどうか判断できない MCP ツールは強制の範囲外です。導入検査では範囲外と表示します。" },
  { id: "outside-hooks", host: "both", text: "対話シェル内の命令や、フックの対象にならないツール経路は、フックでは止まりません。GitHub 上の分岐元への反映は Ruleset で止まります。" },
  { id: "post-stop-unobserved", host: "both", text: "PostToolUse・Stop は、登録されたランチャーが動き、作業の関連付け・案内が状態に現れることまでを確かめます。ホストから届いたこと自体は観測できず、8.4 の実機検査で確認します。" },
  { id: "cloud-managed-only", host: "both", text: "Work Cloud の経路は管理対象の Global MCP フックが前提です。リポジトリのコマンドフックだけの構成は、この経路では動きません。" },
  { id: "body-file-swap", host: "both", text: "--body-file は判定の後に差し替えられうるため、作業ディレクトリ配下の通常ファイルに限って認めます（実害は小さい範囲に限られます）。" },
  { id: "gh-repo-flag-uncloned", host: "both", text: "gh -R で別のリポジトリを指し、作業ディレクトリが未導入のリポジトリだと、判定の対象外として通過します（git の -C と同じ扱い）。" },
  { id: "gh-host-only", host: "both", text: "GH_HOST だけを指定した gh の呼び出しは、ホストの照合が完全には確かめられません。" },
  { id: "mcp-update-base", host: "both", text: "MCP の update_pull_request による base の変更は強制の範囲外で、通常の承認に任せます。" },
  { id: "mcp-pr-approval", host: "both", text: "MCP の PR 作成は確認省略しない方針です。拒否か通常の承認だけで、BRW の公開計画を経た場合にだけ確認省略されます。" },
  { id: "graphql-indeterminate", host: "both", text: "GitHub の GraphQL は対象を確定できないため、常に確定不能として扱います。" },
  { id: "ref-moving-local", host: "both", text: "update-ref・reset・symbolic-ref・tag・branch の変更系など、ローカルの参照を動かす操作は、Claude では確認を求め、Codex では応答を返さず通常の承認に任せます。拒否はされません。" },
  { id: "over-detection", host: "both", text: "-c の危険な設定や、引数に展開・ワイルドカードを含む fetch は、安全側に倒れるため過検出になりえます。" },
  { id: "sync-ff-unverified", host: "both", text: "pull・fetch による基底の更新は、取得前のため分岐を確かめません。fast-forward の保証は --ff-only・+ なしの更新が持ち、分岐していれば git が止めます。" },
  { id: "tool-response-format", host: "both", text: "PostToolUse の tool_response は、Claude は exit_code の無いオブジェクト、Codex は出力の文字列で届くことを実機（8.4）で確認し、その形で成功を判定します。判定できない形なら作業は記録されません（安全側）。" },
  { id: "codex-format-unverified", host: "codex", text: "Codex の hooks.json の形、matcher の正規表現としての解釈、信頼の実承認（/hooks）は、実機で未確認です（8.4）。linked worktree は、worktree に .codex/ ディレクトリがあるときだけ親チェックアウトの hooks.json が読まれることを実機で確認済みです。" },
  { id: "codex-hooks-disabled-partial", host: "codex", text: "Codex の hooks 無効の判定は限定的です。[features] の見出しにコメントが付く場合、ドット形式のキー、プロジェクトの .codex/config.toml は見逃します。" },
  { id: "codex-trust-by-caller", host: "codex", text: "Codex の信頼状態は読み取れません。呼び出し側が渡した値（codexTrust）を使い、渡されなければ確認不能とします。" },
  { id: "codex-command-hooks-caller", host: "codex", text: "コマンドフックを使えるかどうかは呼び出し側が渡します（既定は使える）。CLI からは常に使える前提です。" },
];

const lstatOrNull = (p) => {
  try { return lstatSync(p); } catch { return null; }
};

/** JSON を読む。読めなければ null（例外にしない）。 */
const readJsonOrNull = (file) => {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
};

/** 導入場所が決まらないときの登録状態。 */
const unknownAt = (reasonCode, reason) => ({ status: "unknown", reasonCode, reason, missing: new Map() });

/** linked worktree に `.codex/` ディレクトリが無い。Codex は worktree に .codex/ があるときだけ親の hooks.json を読む（8.4 実機）。 */
const WORKTREE_NOT_REGISTERED = "worktree-not-registered";

/**
 * Claude プラグインの登録状態（checkClaudeHooks の読み取り結果）。
 * 戻り値: { status: "ok" | "conflict" | "unknown", reasonCode, reason, missing: Map<イベント, 理由> }
 */
function claudeRegistration(pluginRoot) {
  if (!pluginRoot) return unknownAt("location-unspecified", "BRW のプラグインの場所が指定されていないため、登録を確認できません。");
  const c = checkClaudeHooks(pluginRoot);
  if (c.status === "conflict") return { status: "conflict", reasonCode: c.reasonCode, reason: "プラグインの hooks/hooks.json に旧い登録が残り、二重に判定されるおそれがあります。", missing: new Map() };
  const missing = new Map();
  for (const label of c.missing) {
    const event = label.split("(")[0];
    missing.set(event, c.reasonCode === "not-installed" ? "not-installed" : "missing-registration");
  }
  return { status: "ok", reasonCode: null, reason: null, missing };
}

/**
 * Codex の登録状態（.codex/hooks.json の読み取り）。mergeCodexHooks は純粋な変換なので、ファイルは書かない。
 * 戻り値の形は claudeRegistration と同じ。hooksDisabled は [features] で hooks が無効な設定（unsupported）。
 */
function codexRegistration(args) {
  const reg = codexRegistrationOfSource(args);
  if (reg.status !== "ok" || !args.codexRepoDir) return reg;
  // linked worktree は、worktree 自身に .codex/ ディレクトリが無いと親の登録が読まれない（親が登録済みでも届かない）
  try {
    const src = registrationSourceOf(args.codexRepoDir);
    if (src.linked && !lstatOrNull(join(src.worktree, ".codex"))?.isDirectory()) return { ...reg, missing: new Map(ROUTE_EVENTS.codex.map((e) => [e, WORKTREE_NOT_REGISTERED])) };
  } catch { /* 登録元の判定は codexRegistrationOfSource で済んでいる */ }
  return reg;
}

function codexRegistrationOfSource({ codexRepoDir, launcher, featuresText }) {
  if (!launcher) return unknownAt("location-unspecified", "BRW のプラグインの場所が指定されていないため、Codex の登録を確認できません。");
  if (!codexRepoDir) return unknownAt("location-unspecified", "Codex の導入先が指定されていないため、登録を確認できません。");
  if (!existsSync(codexRepoDir)) return unknownAt("location-missing", "Codex の導入先が存在しないため、登録を確認できません。");
  if (hooksDisabled(featuresText)) return { status: "unsupported", reasonCode: "hooks-disabled", reason: "設定の [features] で hooks が無効です。", missing: new Map() };
  let src;
  try {
    src = registrationSourceOf(codexRepoDir);
  } catch {
    return unknownAt("location-missing", "Codex の導入先を確認できないため、登録を確認できません。");
  }
  if (src.source === null) return { status: "conflict", reasonCode: "unknown-common-dir", reason: "共通の Git ディレクトリ名が .git ではないため、登録元を決められません。", missing: new Map() };
  // 作業ディレクトリ側に同じ定義があると、親からの継承と二重になる
  if (src.linked) {
    const own = readJsonOrNull(join(src.worktree, ".codex", "hooks.json"));
    if (own && hasManaged(own)) return { status: "conflict", reasonCode: "duplicate-worktree", reason: "作業ディレクトリの .codex/hooks.json に同じ定義があり、親からの継承と二重になります。", missing: new Map() };
  }
  const file = join(src.source, ".codex", "hooks.json");
  const fst = lstatOrNull(file);
  if (!fst) {
    // 設定ファイルが無ければ、すべてのイベントが未導入
    return { status: "ok", reasonCode: null, reason: null, missing: new Map(ROUTE_EVENTS.codex.map((e) => [e, "not-installed"])) };
  }
  if (fst.isSymbolicLink()) return { status: "conflict", reasonCode: "symlink", reason: ".codex/hooks.json がシンボリックリンクのため、登録を確かめられません。", missing: new Map() };
  if (!fst.isFile()) return { status: "conflict", reasonCode: "not-a-file", reason: ".codex/hooks.json が通常のファイルではありません。", missing: new Map() };
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { status: "conflict", reasonCode: "unreadable-json", reason: "既存の .codex/hooks.json を JSON として読めません。", missing: new Map() };
  }
  let m;
  try {
    m = mergeCodexHooks(doc, launcher);
  } catch {
    return { status: "conflict", reasonCode: "shape-mismatch", reason: "既存の .codex/hooks.json の形が想定と違います。", missing: new Map() };
  }
  if (m.blocked) return { status: "conflict", reasonCode: m.reasonCode, reason: m.blocked, missing: new Map() };
  // 同じ定義の古い絶対パス（旧いクローン）は、稼働しているとは言えない
  if (m.changes.some((c) => c.action === "update")) return { status: "conflict", reasonCode: "stale-launcher", reason: "旧い絶対パスのランチャーが登録されています。導入をやり直してください。", missing: new Map() };
  const missing = new Map();
  for (const c of m.changes) if (!missing.has(c.event)) missing.set(c.event, "missing-registration");
  return { status: "ok", reasonCode: null, reason: null, missing };
}

/**
 * 呼び出し元の Git 設定を読ませずに fn を実行する（HOME を検査用の空の場所に、Git の設定ファイルを /dev/null に向ける）。必ず元へ戻す。
 */
const withIsolatedGit = (home, fn) => {
  const keys = ["HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.HOME = home;
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  try {
    return fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
};

/**
 * 検査に使う一時リポジトリを作る。宣言は commit しておき、origin は GitHub の形にするだけで通信はしない。
 * main（保護ブランチ）・dev（開発ブランチ dev/diag）・post（作業を開始して関連付けを確かめる）・stop（準備済みの未公開作業を作る）。
 * 状態を使うものは、同じ経路の検査の中で作る。後始末は cleanup。
 */
function makeProbes() {
  const base = mkdtempSync(join(tmpdir(), PROBE_PREFIX));
  const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=brw-diag", "-c", "user.email=brw-diag@localhost", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "ignore" });
  const make = (name, branch) => {
    const dir = join(base, name);
    mkdirSync(dir);
    git(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, ".branch-release-workflow.json"), JSON.stringify(DECLARATION));
    git(dir, "add", ".branch-release-workflow.json");
    git(dir, "commit", "-q", "-m", "宣言");
    git(dir, "remote", "add", "origin", PROBE_REMOTE);
    if (branch !== "main") git(dir, "checkout", "-q", "-b", branch);
    return dir;
  };
  const cleanup = () => rmSync(base, { recursive: true, force: true });
  const home = join(base, "home");
  mkdirSync(home);
  try {
    // 利用者の Git 設定（insteadOf など）の影響を受けないよう、準備の間だけ設定の参照先を空にする
    return withIsolatedGit(home, () => {
      const main = make("main", "main");
      const dev = make("dev", "dev/diag");
      const post = make("post", "dev/post");
      const stop = make("stop", "dev/stop");
      // 作業の状態を使う検査の準備。失敗したら後始末して例外にし、呼び出し側で probe-failed にする
      const started = startWork(stop, { sessionId: PROBE_SESSION });
      if (!started.ok) throw new Error("検査用の作業を開始できません");
      const ready = markReady(stop, started.work.workId, { completion: "診断用の検査", verification: { passed: true, summary: "診断用の検査" }, repository: PROBE_REPO });
      if (!ready.ok) throw new Error("検査用の作業を準備できません");
      const postWork = startWork(post, {});
      if (!postWork.ok) throw new Error("検査用の作業を開始できません");
      return { base, main, dev, post, stop, postWorkId: postWork.work.workId, cleanup };
    });
  } catch (error) {
    cleanup();
    throw error;
  }
}

/** 作業の関連付けが、検査用リポジトリの状態に記録されたか。読み取りだけを行う。 */
const attachedIn = (dir, workId) => {
  try {
    const { state } = load(stateFileOf(dir));
    return state.works?.[workId]?.sessionId === PROBE_SESSION;
  } catch {
    return false;
  }
};

/** 子プロセスの応答の種類。none は出力なし、block は Stop の案内、invalid は形が違うもの。 */
const responseKind = (event, out) => {
  if (out.trim() === "") return "none";
  let j;
  try {
    j = JSON.parse(out);
  } catch {
    return "invalid";
  }
  const h = j?.hookSpecificOutput;
  if (event === "PermissionRequest") return ["allow", "deny"].includes(h?.decision?.behavior) ? h.decision.behavior : "invalid";
  if (event === "PreToolUse") return ["allow", "deny", "ask"].includes(h?.permissionDecision) ? h.permissionDecision : "invalid";
  if (event === "Stop") return j?.decision === "block" ? "block" : "invalid";
  return "invalid";
};

/** 期待する応答と照らして、probe の結果を返す。ok・no-response（応答なし・記録なし）・probe-failed（起動失敗・形の違い・期待と違う）。 */
const judge = (expect, kind) => {
  if (kind === "invalid") return "probe-failed";
  if (expect === "none") return kind === "none" ? "ok" : "probe-failed";
  if (kind === "none") return "no-response";
  return kind === expect ? "ok" : "probe-failed";
};

/** 登録と同じ文字列のコマンドを子プロセスで実行し、入力（合成イベント）を標準入力に渡す。終了コードが 0 でなければ null。 */
const runCommand = (command, { cwd, env, input }) => {
  const r = spawnSync("/bin/sh", ["-c", command], { cwd, env, input, encoding: "utf8", timeout: PROBE_TIMEOUT_MS, stdio: ["pipe", "pipe", "ignore"] });
  return r.error || r.status !== 0 ? null : r.stdout ?? "";
};

/** 合成入力を作る（実際の Git・GitHub は実行しない。判定と、検査用リポジトリの状態の記録だけが起きる）。 */
const inputFor = (event, cwd, { text, output }) => {
  const base = { session_id: PROBE_SESSION, cwd, hook_event_name: event };
  if (event === "Stop") return { ...base, stop_hook_active: false };
  if (event === "PostToolUse") return { ...base, tool_name: "Bash", tool_input: { command: text }, tool_response: { exit_code: 0, stdout: output ?? "" } };
  return { ...base, tool_name: "Bash", tool_input: { command: text } };
};

/**
 * 経路の確認を実行する。子プロセスには最小限の環境だけを渡す（HOME は検査用の空の場所、Git の設定は読まない）。
 * 呼び出し側の env は明示したものだけを重ねる。
 */
function runProbes({ host, event, launcher, pluginRoot, env }) {
  let probes;
  try {
    probes = makeProbes();
  } catch {
    return probesOf(host, event).map((p) => ({ name: p.name, result: "probe-failed" }));
  }
  const home = join(probes.base, "home");
  try {
    const picked = Object.fromEntries(BASE_ENV_KEYS.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
    const childEnv = { ...picked, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", ...env };
    const brwCli = (() => {
      const p = join(dirname(launcher), "brw.mjs");
      try { return realpathSync(p); } catch { return p; }
    })();
    const command = host === "claude" ? `node "\${CLAUDE_PLUGIN_ROOT}/scripts/agent-hooks.mjs" claude ${event}` : codexCommand(launcher, event);
    const cmdEnv = host === "claude" ? { ...childEnv, CLAUDE_PLUGIN_ROOT: pluginRoot } : childEnv;
    return probesOf(host, event).map((p) => {
      const cwd = probes[p.repo];
      // 作業の関連付けは、開始の成功を示す合成入力と、検査用の作業 ID の出力で与える
      const spec = p.attach
        ? { text: `node "${brwCli}" work start`, output: probes.postWorkId }
        : { text: p.text };
      const out = runCommand(command, { cwd, env: cmdEnv, input: JSON.stringify(inputFor(event, cwd, spec)) });
      if (out === null) return { name: p.name, result: "probe-failed" };
      const r = judge(p.expect, responseKind(event, out));
      // 出力のない記録の確認は、作業が関連付けられたかで決める
      if (r === "ok" && p.attach && !withIsolatedGit(home, () => attachedIn(probes.post, probes.postWorkId))) return { name: p.name, result: "no-response" };
      return { name: p.name, result: r };
    });
  } finally {
    probes.cleanup();
  }
}

/** 応答の確認が欠けた・失敗した経路の理由。 */
const PROBE_REASON = {
  "no-response": { code: "no-response", text: "登録はありますが、応答または記録が確認できません。イベントが届いていない可能性があります。" },
  "probe-failed": { code: "probe-failed", text: "登録されたランチャーが起動しないか、期待と違う応答を返しました。" },
};

/**
 * ホストのフック経路の状態を診断する。読み取り専用（導入先の設定は書かない）。
 * 引数:
 *   pluginRoot     BRW の clone（hooks/hooks.json と scripts/agent-hooks.mjs を持つディレクトリ）。Claude の登録と Codex のランチャーの場所。
 *   codexRepoDir   Codex の導入先（作業ディレクトリ。linked worktree は親の .codex を読むが、worktree に .codex/ ディレクトリが要る）。
 *   host           "claude" または "codex" で絞る（省略時は両方）。
 *   commandHooks   このローカル実行環境でコマンドフックが使えるか（既定 true。偽なら Codex のローカル経路は非対応）。
 *   featuresText   Codex の設定ファイルの文字列（[features] の hooks が無効か判定する）。読むのは呼び出し側。
 *   codexTrust     Codex の信頼状態（"trusted" | "untrusted" | "unknown"）。既定は unknown（確認不能）。
 *   env            子プロセスへ明示的に渡す環境変数。既定では渡さない（資格情報を含めてよいが、結果には出さない）。
 * 戻り値: { routes: [経路ごとの状態], limits: [対応していない経路] }
 */
export function diagnoseHooks({ pluginRoot, codexRepoDir, host, commandHooks = true, featuresText = "", codexTrust = "unknown", env = {} } = {}) {
  const hosts = host ? [host] : Object.keys(ROUTE_EVENTS);
  const routes = [];
  const launcher = pluginRoot ? (() => {
    const p = join(pluginRoot, "scripts", "agent-hooks.mjs");
    try { return realpathSync(p); } catch { return p; }
  })() : null;
  for (const h of hosts) {
    if (!ROUTE_EVENTS[h]) continue;
    const reg = h === "claude"
      ? claudeRegistration(pluginRoot)
      : codexRegistration({ codexRepoDir, launcher, featuresText });
    for (const event of ROUTE_EVENTS[h]) {
      // クラウド経路は管理対象フックが前提のため、リポジトリの登録だけでは判定せず非対応と表示する
      routes.push(route(h, "cloud", event, "unsupported", "managed-hooks-required", "Work Cloud の経路は管理対象の Global MCP フックが前提のため、リポジトリのコマンドフックでは動きません。", { managedHooksRequired: true }));
      routes.push(localRoute({ h, event, reg, commandHooks, codexTrust, launcher, pluginRoot, env }));
    }
  }
  return { routes, limits: LIMITS.filter((l) => !host || l.host === host || l.host === "both") };
}

/** ローカル経路の状態。登録 → 対応状況 → 信頼（承認済みか分かるもの）→ 応答と記録の確認 → 信頼の確認の順に判定する。 */
function localRoute({ h, event, reg, commandHooks, codexTrust, launcher, pluginRoot, env }) {
  const L = (status, reasonCode, reason, extra) => route(h, "local", event, status, reasonCode, reason, extra);
  if (h === "codex" && !commandHooks) return L("unsupported", "command-hooks-unavailable", "コマンドフックを使えない実行環境のため、このイベントは届きません。管理対象フックが必要です。", { managedHooksRequired: true });
  if (reg.status === "unknown") return L("unverifiable", reg.reasonCode, reg.reason);
  if (reg.status === "conflict") return L("conflict", reg.reasonCode, reg.reason);
  if (reg.status === "unsupported") return L("unsupported", reg.reasonCode, reg.reason);
  if (reg.missing.has(event)) {
    const code = reg.missing.get(event);
    if (code === WORKTREE_NOT_REGISTERED) return L("not-installed", code, "この worktree に .codex/ ディレクトリが無いため、親チェックアウトの登録は読まれません。brw create・brw resume で作り直すか、install-codex.mjs --repo <この worktree> で有効化してください。");
    return L("not-installed", code, code === "not-installed" ? "フックが導入されていません。導入を実行してください。" : "このイベントの登録がありません。導入をやり直してください。");
  }
  // 未承認と分かっている Codex は、応答の確認より先に未信頼と表示する（承認までは読み込まれない）
  if (h === "codex" && codexTrust === "untrusted") return L("untrusted", "review-required", "Codex で未承認です。/hooks で承認するまで読み込まれません。");
  const probes = runProbes({ host: h, event, launcher, pluginRoot, env });
  const failed = probes.find((p) => p.result !== "ok");
  if (failed) {
    const why = PROBE_REASON[failed.result] ?? PROBE_REASON["probe-failed"];
    return L("unverifiable", why.code, why.text, { probes });
  }
  // 応答と記録は確かめられた。Claude のプラグインは導入で信頼が満たされ、Codex は確認状態を別に見る
  if (h === "claude") return L("active", null, "登録と、登録されたランチャーの応答・記録を確認しました。ホストからの配信は 8.4 の実機検査で確認します。", { probes });
  if (codexTrust === "trusted") return L("active", null, "登録・応答・記録・信頼状態を確認しました。ホストからの配信は 8.4 の実機検査で確認します。", { probes });
  return L("unverifiable", "trust-unconfirmed", "登録と応答は確認できましたが、Codex の信頼状態は読めません。/hooks で承認済みか確かめてください。", { probes });
}
