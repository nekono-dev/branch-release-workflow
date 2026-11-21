// 導入・移行と状態検査の CLI（brw-enforcement 7.3）: `brw setup`・`brw setup --migrate`・`brw check --ruleset` の追加節。
// 実処理は ruleset-choice（選択の保存）・ruleset-apply（事前検査と追加）・ruleset-inspect（適用後と日常の検査）・
// hook-install（登録）・hook-diagnose（稼働の診断）に任せる。ここでは対象の決定、利用者への問い、結果の表示、終了コードを扱う。
// 終了コード: 0 完了・問題なし、1 誤り・設定のずれ・衝突（直す必要がある）、2 使い方の誤り、3 保留・確認不能（利用者の判断または再試行が必要）。
// 認証: 設定用（管理者）は環境変数 BRW_SETUP_GH_TOKEN、作業経路の確認用は BRW_WORK_GH_TOKEN。未設定の設定用は gh の保存済みログインを使う。
// 値は出力・記録しない。TTY 判定は process.stdin.isTTY だけで行い、テストだけ deps で注入する（環境変数・引数では迂回できない）。
// 外部依存なし（Node 標準ライブラリと内部モジュールのみ）。
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { CONFIG_REL, LEGACY_CONFIG_REL, git, loadConfig, repoRoot, validateConfig } from "./lib.mjs";
import { createGitHubSession } from "./github-client.mjs";
import { applyRuleset } from "./ruleset-apply.mjs";
import { inspectRulesets } from "./ruleset-inspect.mjs";
import { recordChoice, refsOf, resolveChoice } from "./ruleset-choice.mjs";
import { checkClaudeHooks, installCodexHooks } from "./hook-install.mjs";
import { diagnoseHooks } from "./hook-diagnose.mjs";
import { githubRepoOf } from "./publish.mjs";

export const ADMIN_TOKEN_ENV = "BRW_SETUP_GH_TOKEN";
export const WORK_TOKEN_ENV = "BRW_WORK_GH_TOKEN";
const HOST = "github.com";
const BRW_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// --keep-confirm で明示的に確認を求める項目（移行時に autoApprove を false にする）
const KEEP_CONFIRM = { push: ["push"], pullRequest: ["pullRequest"], all: ["push", "pullRequest"] };
const CODE_OF_INSPECT = { enforced: 0, drift: 1, "verify-failed": 1, unverifiable: 3, invalidInput: 1 };
// 適用結果ごとの終了コード。applied・reused・skipped は問題なし
const CODE_OF_APPLY = { applied: 0, reused: 0, skipped: 0, pending: 3, unknown: 3, blocked: 1, conflict: 1, rejected: 1, mismatch: 1, invalidInput: 1 };
const USAGE = "使い方: brw setup [--ruleset on|off] | brw setup --migrate [--keep-confirm push|pullRequest|all]";

const consoleIo = { out: (s) => console.log(s), err: (s) => console.error(s) };
/** 対話の質問。TTY でだけ使う。 */
const defaultAsk = async (question) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
};

const norm = (deps = {}) => ({
  cwd: deps.cwd ?? process.cwd(),
  io: deps.io ?? consoleIo,
  // 対話端末か。注入は呼び出し元（テスト）だけが行う。環境変数では迂回できない
  stdinIsTTY: deps.stdinIsTTY ?? (process.stdin.isTTY === true),
  ask: deps.ask ?? defaultAsk,
  env: deps.env ?? process.env,
  makeSession: deps.makeSession ?? (({ host, token }) => createGitHubSession({ host, token })),
  pluginRoot: deps.pluginRoot ?? BRW_ROOT,
  codexHome: deps.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"),
  diagnose: deps.diagnose ?? diagnoseHooks,
});

const readText = (file) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};
const tokenOf = (d, name) => d.env[name] || undefined;
const combine = (codes) => (codes.includes(1) ? 1 : codes.includes(3) ? 3 : 0);
const usage = (io, msg) => {
  io.err(msg);
  return 2;
};

/** 引数を読む。誤りは error を返す。 */
export function parseSetupArgs(args) {
  const o = { ruleset: undefined, migrate: false, keepConfirm: undefined };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--ruleset") {
      const v = args[++i];
      if ((v !== "on" && v !== "off") || o.ruleset !== undefined) return { error: true };
      o.ruleset = v;
    } else if (a === "--migrate") {
      o.migrate = true;
    } else if (a === "--keep-confirm") {
      const v = args[++i];
      if (typeof v !== "string" || !Object.hasOwn(KEEP_CONFIRM, v)) return { error: true };
      o.keepConfirm = v;
    } else return { error: true };
  }
  if (o.keepConfirm !== undefined && !o.migrate) return { error: true };
  if (o.migrate && o.ruleset !== undefined) return { error: true };
  return o;
}

// ---- 対象の決定 ----

/** ローカルのリモート設定のうち GitHub のリポジトリを候補にする。 */
function remotesOf(root) {
  const names = (git(root, "remote") ?? "").split("\n").filter(Boolean);
  const out = [];
  for (const name of names) {
    const gh = githubRepoOf(git(root, "remote", "get-url", "--push", name));
    if (gh) out.push({ remote: name, owner: gh.owner.toLowerCase(), repository: gh.name.toLowerCase() });
  }
  return out;
}

/**
 * Ruleset の対象を決める。origin があればそれ、無ければ GitHub のリモートが 1 つだけならそれ。複数で origin が無い場合は決めない。
 * 戻り値: { kind: none|ambiguous|ok, candidates, refs, target: {host, owner, repository}|null, reason }
 */
export function rulesetTargetOf(root, config) {
  const candidates = remotesOf(root);
  const refs = refsOf(config);
  if (candidates.length === 0) return { kind: "none", candidates, refs, target: null, reason: "GitHub のリモートがありません。" };
  const chosen = candidates.find((c) => c.remote === "origin") ?? (candidates.length === 1 ? candidates[0] : null);
  if (!chosen) return { kind: "ambiguous", candidates, refs, target: null, reason: "GitHub のリモートが複数あり origin がないため、対象を決められません。origin を導入先のリポジトリにしてください。" };
  return { kind: "ok", candidates, refs, target: { host: HOST, owner: chosen.owner, repository: chosen.repository }, reason: null };
}

const describeTarget = (t) => `${t.host}/${t.owner}/${t.repository}`;

// ---- 導入の選択 ----

/**
 * 導入の採否を決める。戻り値: { enabled, keepId } か、保留の { pending: 理由 }。
 * 指定（--ruleset）→ 保存済みの選択（同じ対象）→ 対話の既定（導入する）の順。非対話で採否が無ければ保留する。
 */
async function decideChoice(d, root, target, refs, explicit) {
  const saved = resolveChoice(root, { ...target, refs });
  if (!saved.ok) return { pending: saved.error.message };
  if (explicit !== undefined) return { enabled: explicit === "on", keepId: saved.status === "selected" ? saved.repositoryId : null };
  if (saved.status === "selected") return { enabled: true, keepId: saved.repositoryId };
  if (saved.status === "skipped") return { enabled: false, keepId: null };
  if (!d.stdinIsTTY) return { pending: saved.reason ?? "導入の選択が未設定です。" };
  d.io.out(`Ruleset の導入（対象: ${describeTarget(target)}）`);
  d.io.out(`  対象の分岐元: ${refs.join(", ")}（宣言の baseBranch と baseBranches）`);
  d.io.out("  効果: 上の分岐元への変更は PR 経由に限られ、マージは squash のみになります。通常の作業権限による直接 push は GitHub 側で拒否されます。既存のレビュー・必須チェックは変更しません。");
  d.io.out(`  導入には管理権限のある認証が必要です（${ADMIN_TOKEN_ENV}、未設定なら gh の保存済みログイン）。`);
  const answer = String(await d.ask("導入する [Y/n]: ")).trim();
  return { enabled: answer === "" || /^(y|yes|はい)$/i.test(answer), keepId: null };
}

/** 作業経路の確認に使う接続。BRW_WORK_GH_TOKEN が無ければ作業経路は指定しない（確認不能になる）。 */
function workRoutes(d, host) {
  const token = tokenOf(d, WORK_TOKEN_ENV);
  if (!token) return [];
  return [{ name: `作業用の認証（${WORK_TOKEN_ENV}）`, transport: "gh", session: d.makeSession({ role: "work", host, token }) }];
}

/**
 * 適用後・日常の検査の結果を表示し、終了コードを返す。
 * 読めなかった項目（verify-failed）は、適用後の検査では適用の失敗（1）、日常の検査では確認不能（3）として扱う。
 */
function reportInspect(d, ins, label) {
  d.io.out(`${label}: ${ins.status}（${ins.reason}）`);
  for (const c of ins.checks ?? []) if (c.status !== "ok") d.io.out(`  ${c.id}: ${c.status}（${c.reason}）${c.remedy ? ` → ${c.remedy}` : ""}`);
  for (const r of ins.refs ?? []) d.io.out(`  分岐元 ${r.ref}: ${r.status}（${r.reason}）`);
  for (const r of ins.routes ?? []) d.io.out(`  作業経路 ${r.name}: ${r.status}（${r.reason}）${r.remedy ? ` → ${r.remedy}` : ""}`);
  if ((ins.routes ?? []).length === 0) d.io.out(`  作業経路の権限は未確認です。作業用の認証を ${WORK_TOKEN_ENV} に設定して brw check --ruleset で確かめられます。`);
  if (ins.status === "verify-failed" && !ins.afterApply) return 3;
  return CODE_OF_INSPECT[ins.status] ?? 1;
}

/** 適用の結果を表示し、終了コードを返す。 */
function reportApply(d, res) {
  const ids = res.rulesetId !== undefined ? `（ID ${res.rulesetId}）` : "";
  switch (res.status) {
    case "applied":
      // 応答が届かず一覧で照合して記録したもの。今回の送信で作られたか別の管理者が作ったかは区別できないため、追加とは断定しない
      if (res.reconciled) d.io.out(`既存の同条件の Ruleset を確認して記録しました${ids}。応答が届かなかったため一覧で照合し、追加の要求は再送していません（今回の要求で作られたか別の管理者が作ったかは応答からは判別できません）。対象: ${(res.includedRefs ?? []).join(", ")}`);
      else d.io.out(`Ruleset を追加しました${ids}。対象: ${(res.includedRefs ?? []).join(", ")}`);
      break;
    case "reused": d.io.out(`既存の Ruleset を再利用しました（書き込みなし）。ID: ${Object.values(res.reusedRulesetIds ?? {}).flat().join(", ")}`); break;
    case "skipped": d.io.out("Ruleset は見送りのため適用しません。"); break;
    case "blocked":
    case "unknown":
      // 事前検査の項目（ng・unknown）ごとに、理由と再試行の対応を表示する（要件 5.2）
      if (res.checks) {
        d.io.err(`事前検査が通らないため Ruleset を変更していません（${res.branch ?? ""}）${res.status === "unknown" ? "。確認できない項目があります" : ""}。`);
        for (const c of res.checks) d.io.err(`  ${c.id}: ${c.status}（${c.reason}）${c.remedy ? ` → ${c.remedy}` : ""}`);
      } else {
        d.io.err(res.reason ?? `Ruleset の適用を完了できませんでした（${res.status}）。`);
        if (res.remedy) d.io.err(`  ${res.remedy}`);
      }
      break;
    case "conflict":
      d.io.err(`${res.reason}${res.candidateIds ? `（候補 ID: ${res.candidateIds.join(", ")}）` : ""}`);
      break;
    case "mismatch":
      d.io.err(`作成された Ruleset が要求と一致しません（ID ${res.rulesetId ?? "不明"}）: ${(res.differences ?? []).join("、")}`);
      if (res.remedy) d.io.err(`  ${res.remedy}`);
      break;
    default:
      d.io.err(res.reason ?? `Ruleset の適用を完了できませんでした（${res.status}）。`);
      if (res.remedy) d.io.err(`  ${res.remedy}`);
  }
  return CODE_OF_APPLY[res.status] ?? 1;
}

/**
 * 導入の一連の処理（照合 → 事前検査 → 追加 → 適用後検査）。戻り値は終了コード。
 * 対象の照合で保存済みのリポジトリ ID と食い違えば、書き込まずに再確認を求める。
 */
async function installRuleset(d, root, t, explicit) {
  const target = t.target;
  const base = { host: target.host, owner: target.owner, repository: target.repository, refs: t.refs };
  const dec = await decideChoice(d, root, target, t.refs, explicit);
  if (dec.pending !== undefined) {
    d.io.err(`Ruleset: 導入の採否が決まらないため適用を保留します（フックの導入は続けます）。理由: ${dec.pending}`);
    d.io.err("採否を指定して再実行してください: brw setup --ruleset on（導入する）または --ruleset off（見送る）");
    return 3;
  }
  if (!dec.enabled) {
    const rec = recordChoice(root, { ...base, enabled: false });
    if (!rec.ok) {
      d.io.err(`Ruleset: 見送りを保存できません: ${rec.error.message}`);
      return 1;
    }
    d.io.out("Ruleset: 見送りを記録しました（GitHub の設定は変更しません。GitHub の認証も求めません）。");
    return 0;
  }
  const saved = recordChoice(root, { ...base, enabled: true, repositoryId: dec.keepId ?? null });
  if (!saved.ok) {
    d.io.err(`Ruleset: 導入の選択を保存できません: ${saved.error.message}`);
    return 1;
  }

  const tgt = { host: target.host, owner: target.owner, name: target.repository };
  const session = d.makeSession({ role: "admin", host: HOST, token: tokenOf(d, ADMIN_TOKEN_ENV) });
  const c = await session.confirmTarget(tgt);
  if (!c.ok) {
    d.io.err(`Ruleset: 対象を GitHub の応答で照合できません（${c.kind}）: ${c.reason}`);
    return c.kind === "target-mismatch" ? 1 : 3;
  }
  const sel = resolveChoice(root, { ...base, repositoryId: c.target.repositoryId });
  if (sel.status !== "selected") {
    d.io.err(`Ruleset: リポジトリの確認が保存済みの選択と合いません（${sel.reason}）。再確認してから再実行してください。適用は保留しました。`);
    return 3;
  }
  const res = await applyRuleset(root, { session, target: tgt, refs: t.refs });
  const applyCode = reportApply(d, res);
  if (!res.ok) return applyCode;
  const ins = await inspectRulesets(session, tgt, t.refs, { routes: workRoutes(d, HOST), afterApply: true, cwd: root });
  return reportInspect(d, ins, "適用後の検査");
}

// ---- フック ----

/** 導入（Codex のプロジェクト設定への登録）と Claude の登録の検査を行い、終了コードを返す。 */
function installHooks(d, root) {
  let codex;
  try {
    const launcherPath = realpathSync(join(d.pluginRoot, "scripts", "agent-hooks.mjs"));
    codex = installCodexHooks({ repoDir: root, launcherPath, featuresText: readText(join(d.codexHome, "config.toml")) ?? "" });
  } catch (e) {
    d.io.err(`Codex のフックを登録できませんでした: ${e.message}`);
    return 1;
  }
  const claude = checkClaudeHooks(d.pluginRoot);
  let code = 0;
  if (codex.status === "registered") d.io.out("Codex hooks: registered（変更なし）");
  else if (codex.status === "untrusted") d.io.out(`Codex hooks: untrusted（登録しました。Codex で /hooks を開き、BRW のフックを確認して信頼してください。信頼するまで読み込まれません）`);
  else {
    code = 1;
    d.io.err(`Codex hooks: ${codex.status} [${codex.reasonCode}]: ${codex.reason ?? ""}`);
    for (const c of codex.conflicts ?? []) d.io.err(`  衝突: ${JSON.stringify(c)}`);
  }
  if (claude.status === "registered") d.io.out("Claude hooks: registered（プラグインの登録を確認）");
  else {
    code = 1;
    d.io.err(`Claude hooks: ${claude.status} [${claude.reasonCode}]${claude.missing?.length ? `（不足: ${claude.missing.join(", ")}）` : ""}。プラグインを更新してください（claude plugin update branch-release-workflow@nekono-dev）。`);
  }
  return code;
}

// ---- 移行 ----

const show = (v) => (v === undefined ? "未指定" : JSON.stringify(v));

/**
 * 旧パスの宣言の移行計画を作る（書き込みはしない）。
 * 明示の制限（false など）は保つ。未指定の確認省略は新しい既定値（有効）になるため、変更点として示す。
 */
export function migrationOf(root, keepConfirm) {
  const legacyPath = join(root, LEGACY_CONFIG_REL);
  const newPath = join(root, CONFIG_REL);
  if (!existsSync(legacyPath)) return { status: "none" };
  let raw;
  try {
    raw = JSON.parse(readFileSync(legacyPath, "utf8"));
  } catch (e) {
    return { status: "invalid", error: `${LEGACY_CONFIG_REL} の JSON が不正です: ${e.message}` };
  }
  const errors = validateConfig(raw);
  if (errors.length) return { status: "invalid", error: `${LEGACY_CONFIG_REL} が不正です: ${errors.join("、")}` };
  if (existsSync(newPath)) {
    let cur;
    try { cur = JSON.parse(readFileSync(newPath, "utf8")); } catch { cur = undefined; }
    return { status: JSON.stringify(cur) === JSON.stringify(raw) ? "identical" : "conflict" };
  }
  const keys = keepConfirm ? KEEP_CONFIRM[keepConfirm] : [];
  const next = structuredClone(raw);
  if (keys.length) next.autoApprove = { ...(raw.autoApprove ?? {}), ...Object.fromEntries(keys.map((k) => [k, false])) };
  const changes = [`宣言の場所: ${LEGACY_CONFIG_REL} → ${CONFIG_REL}`];
  const notes = [];
  for (const k of ["push", "pullRequest"]) {
    const before = raw.autoApprove?.[k];
    const after = keys.includes(k) ? false : before;
    if (after !== before) changes.push(`autoApprove.${k}: ${show(before)} → ${show(after)}（確認を求める）`);
    if (after === undefined) notes.push(`autoApprove.${k} は未指定のままです。新しい既定値では確認を省きます（旧版は確認を求めていました）。従来どおり確認を求めるなら --keep-confirm ${k === "push" ? "push" : "pullRequest"} を指定してください。`);
  }
  return { status: "ready", legacyPath, newPath, text: `${JSON.stringify(next, null, 2)}\n`, changes, notes };
}

function runMigrate(d, root, o) {
  const m = migrationOf(root, o.keepConfirm);
  switch (m.status) {
    case "none": d.io.out("旧パスの宣言はありません。移行は不要です。"); return 0;
    case "invalid": d.io.err(m.error); return 1;
    case "identical":
      d.io.out(`${CONFIG_REL} が旧パスの宣言と同じ内容で既にあります。旧パス ${LEGACY_CONFIG_REL} は参照されないため、不要なら git rm で削除してください。`);
      return 0;
    case "conflict":
      d.io.err(`${CONFIG_REL} と ${LEGACY_CONFIG_REL} の内容が違うため、移行を止めました（上書きしません）。どちらを使うか決めて、片方を直してください。`);
      return 1;
    default: break;
  }
  d.io.out("移行の差分（書き込む前の内容）:");
  for (const c of m.changes) d.io.out(`  - ${c}`);
  for (const n of m.notes) d.io.out(`  注意: ${n}`);
  try {
    writeFileSync(m.newPath, m.text, { flag: "wx" });
  } catch (e) {
    d.io.err(e.code === "EEXIST" ? `${CONFIG_REL} が既にあるため上書きしません。` : `${CONFIG_REL} を書けません: ${e.message}`);
    return 1;
  }
  d.io.out(`作成しました: ${CONFIG_REL}（旧パス ${LEGACY_CONFIG_REL} は残しています。内容を確認して commit したあと、旧パスを git rm してください）。`);
  d.io.out("注意: 新しい宣言は commit するまで CI やほかの clone からは見えません。");
  return 0;
}

// ---- 入口 ----

/** `brw setup` を実行する。終了コードを返す。 */
export async function runSetup(args = [], deps = {}) {
  const d = norm(deps);
  const o = parseSetupArgs(args);
  if (o.error) return usage(d.io, USAGE);
  const root = repoRoot(d.cwd);
  if (!root) return usage(d.io, "git リポジトリ内で実行してください。");
  if (o.migrate) return runMigrate(d, root, o);

  const loaded = loadConfig(root);
  if (loaded.error) {
    d.io.err(loaded.error);
    return 1;
  }
  if (!loaded.config) {
    d.io.err(`宣言ファイル ${CONFIG_REL} がありません。先に宣言を作って commit してください。`);
    return 1;
  }
  if (loaded.legacy) d.io.out(`注意: 旧パス ${LEGACY_CONFIG_REL} の宣言を使っています。新しいパスへの移行は brw setup --migrate で行えます（変更点を表示してから書き込みます）。`);

  const t = rulesetTargetOf(root, loaded.config);
  d.io.out(t.candidates.length
    ? `対象候補（ローカルのリモート設定）: ${t.candidates.map((c) => `${c.remote} → ${describeTarget({ host: HOST, owner: c.owner, repository: c.repository })}`).join(", ")}`
    : "対象候補: GitHub のリモートがありません（Ruleset は対象外）。");

  let rs;
  if (t.kind === "none") {
    d.io.out("Ruleset: GitHub のリモートがないため対象外です。");
    rs = 0;
  } else if (t.kind === "ambiguous") {
    d.io.err(`Ruleset: ${t.reason}（適用は保留します）`);
    rs = 3;
  } else rs = await installRuleset(d, root, t, o.ruleset);

  const hk = installHooks(d, root);
  const code = combine([rs, hk]);
  if (code === 0) d.io.out("導入を完了しました。");
  else if (code === 3) d.io.out("保留または確認できない項目があります（上の表示を確認し、再実行してください）。");
  else d.io.out("導入を完了できませんでした（上の理由を解消してから再実行してください）。");
  return code;
}

/**
 * brw check の追加節（フックの稼働と、Ruleset の状態）。戻り値は終了コード。
 * フックは経路ごとの状態と限界を表示し、終了コードには含めない（導入の誤りは brw setup で扱う）。
 * ruleset が真なら Ruleset の状態を読み取りだけで検査し、0 問題なし・1 設定のずれ・3 確認不能か保留 を返す。
 */
export async function runStateCheck(cwd, { ruleset = false } = {}, deps = {}) {
  const d = norm({ ...deps, cwd });
  const root = repoRoot(d.cwd);
  if (!root) return usage(d.io, "git リポジトリ内で実行してください。");
  const dx = d.diagnose({ pluginRoot: d.pluginRoot, codexRepoDir: root, featuresText: readText(join(d.codexHome, "config.toml")) ?? "", codexTrust: "unknown", env: {} });
  d.io.out("フック（経路ごと。クラウドは管理対象フックが前提のため非対応）:");
  for (const r of dx.routes) {
    d.io.out(`  ${r.host} ${r.environment === "local" ? "ローカル" : "クラウド"} ${r.event}: ${r.status}${r.reasonCode ? ` [${r.reasonCode}]` : ""}（${r.reason ?? ""}）`);
  }
  d.io.out("フックの対応範囲の限界:");
  for (const l of dx.limits) d.io.out(`  - [${l.id}] ${l.text}`);
  if (!ruleset) return 0;
  return checkRuleset(d, root);
}

/** Ruleset の状態を読み取りだけで確かめる。 */
async function checkRuleset(d, root) {
  const loaded = loadConfig(root);
  if (!loaded.config) {
    d.io.err("Ruleset: 宣言が無いため対象の分岐元を決められません。");
    return 3;
  }
  const t = rulesetTargetOf(root, loaded.config);
  if (t.kind === "none") {
    d.io.out("Ruleset: GitHub のリモートがないため対象外です。");
    return 0;
  }
  if (!t.target) {
    d.io.out(`Ruleset: 対象を決められません（${t.reason}）`);
    return 3;
  }
  const target = t.target;
  const base = { host: target.host, owner: target.owner, repository: target.repository, refs: t.refs };
  d.io.out(`Ruleset（対象: ${describeTarget(target)}、分岐元: ${t.refs.join(", ")}）:`);
  const saved = resolveChoice(root, base);
  if (!saved.ok) {
    d.io.out(`  状態: 選択を読めません（${saved.error.message}）`);
    return 3;
  }
  if (saved.status === "skipped") {
    d.io.out("  見送り（Ruleset は適用しない。GitHub の認証は不要）");
    return 0;
  }
  if (saved.status !== "selected") {
    d.io.out(`  状態: 選択待ち（${saved.reason}）。brw setup で採否を決めてください。`);
    return 3;
  }

  const tgt = { host: target.host, owner: target.owner, name: target.repository };
  const session = d.makeSession({ role: "admin", host: HOST, token: tokenOf(d, ADMIN_TOKEN_ENV) });
  const c = await session.confirmTarget(tgt);
  if (!c.ok) {
    d.io.out(`  対象を GitHub の応答で照合できません（${c.kind}）`);
    return c.kind === "target-mismatch" ? 1 : 3;
  }
  const sel = resolveChoice(root, { ...base, repositoryId: c.target.repositoryId });
  if (sel.status !== "selected") {
    d.io.out(`  状態: 選択待ち（${sel.reason}）`);
    return 3;
  }
  // 読み取りだけ（afterApply と cwd は使わない。記録の確認済みは適用後の検査でだけ行う）
  const ins = await inspectRulesets(session, tgt, t.refs, { routes: workRoutes(d, HOST) });
  return reportInspect(d, ins, "  検査結果");
}
