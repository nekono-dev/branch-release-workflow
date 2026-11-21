// 導入・移行と状態検査の CLI（brw-enforcement 7.3）の契約テスト。selftest.mjs から呼ばれる。
// GitHub はメモリ上の偽の GitHub（createWorld）だけを使い、通信も実際の認証もしない。要求の先と書き込み件数を記録する。
// 導入の選択は一時リポジトリの Git 共通ディレクトリ、フックの登録は一時リポジトリの .codex に置く。CODEX_HOME は空の一時ディレクトリへ向ける。
// 利用者の ~/.codex・~/.claude には触れない。
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGitHubSession, ghEnv } from "../scripts/github-client.mjs";
import { choiceFileOf, recordChoice, resolveChoice } from "../scripts/ruleset-choice.mjs";
import { gitOut, mkRepoWithRemote } from "./support/git-fixture.mjs";

// scripts/setup-cli.mjs は 7.3 で追加する。未実装の間も失敗として数えられるよう、名前が無くても落ちない形にする
const cli = await import("../scripts/setup-cli.mjs").catch(() => ({}));
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BRW = join(ROOT, "scripts/brw.mjs");
const CONFIG = { workBranches: ["dev/*"], protectedBranches: ["main"], baseBranch: "develop", baseBranches: ["release"] };
const LEGACY = ".claude/branch-release-workflow.json";
const ROOT_CONFIG = ".branch-release-workflow.json";
const TARGET = { host: "github.com", owner: "acme", repository: "app", refs: ["develop", "release"] };
const ADMIN_TOKEN = "admin-secret-token-7c1e";
const WORK_TOKEN = "work-secret-token-9a2b";
const STUB_DIAG = () => ({
  routes: [{ host: "claude", environment: "local", event: "PreToolUse", status: "active", reasonCode: null, reason: "stub", probes: [], managedHooksRequired: false }],
  limits: [{ id: "stub-limit", host: "both", text: "stub" }],
});

// ---- 偽の GitHub（メモリ上） ----

/** リポジトリ acme/app の小さな状態。ブランチ・Ruleset・権限を持つ。 */
const createWorld = ({ adminPerms = true, workPerms = false, rulesets = [], branches = ["main", "develop", "release"] } = {}) => ({
  repoId: 42, adminPerms, workPerms, branches, rulesets, nextId: 100, writes: 0, calls: [], denyRules: false,
});
const listItem = (rs) => ({ id: rs.id, name: rs.name, target: rs.target, enforcement: rs.enforcement, source_type: rs.source_type, source: rs.source });
/** 分岐元の実効ルール。有効な Ruleset のうち、その分岐元を対象にするものの規則を返す。 */
const effectiveOf = (w, ref) => w.rulesets
  .filter((rs) => rs.enforcement === "active" && rs.conditions.ref_name.include.includes(`refs/heads/${ref}`))
  .flatMap((rs) => rs.rules.map((r) => ({ type: r.type, ruleset_id: rs.id, ruleset_source_type: "Repository", ruleset_source: "acme/app", parameters: r.parameters })));

/** 役割（admin: 設定用、work: 通常作業）ごとの通信層。両方の要求を同じ状態へ向ける。 */
const transportFor = (w, role) => async ({ method, path, body }) => {
  w.calls.push({ role, method, path });
  const [p] = path.split("?");
  const admin = role === "admin";
  const perms = admin ? w.adminPerms : w.workPerms;
  const hit = (status, b, headers = {}) => ({ status, body: b, headers });
  if (method === "GET") {
    if (p === "/user") return hit(200, { login: admin ? "admin-user" : "dev-user" }, admin ? { "x-oauth-scopes": "repo" } : {});
    if (p === "/repos/acme/app") return hit(200, { id: w.repoId, full_name: "acme/app", private: false, visibility: "public", allow_squash_merge: true, default_branch: "main", permissions: { admin: perms, push: true, pull: true } });
    if (p === "/repos/acme/app/branches") return hit(200, w.branches.map((name) => ({ name })));
    if (p === "/repos/acme/app/rulesets") return hit(200, w.rulesets.map(listItem));
    const d = /^\/repos\/acme\/app\/rulesets\/(\d+)$/.exec(p);
    if (d) {
      const rs = w.rulesets.find((x) => x.id === Number(d[1]));
      return rs ? hit(200, rs) : hit(404, { message: "Not Found" });
    }
    const b = /^\/repos\/acme\/app\/rules\/branches\/([^/]+)$/.exec(p);
    if (b) return w.denyRules ? hit(403, { message: "Resource not accessible" }) : hit(200, effectiveOf(w, b[1]));
  }
  if (method === "POST" && p === "/repos/acme/app/rulesets") {
    if (!admin) return hit(403, { message: "Resource not accessible" });
    w.writes++;
    const rs = { ...structuredClone(body), id: w.nextId++, source_type: "Repository", source: "acme/app" };
    w.rulesets.push(rs);
    return hit(201, rs);
  }
  return hit(404, { message: "Not Found" });
};

/** 役割ごとの GitHub 接続を作る（テストでは通信層だけを差し替える）。 */
const sessionsOf = (w) => ({ role, host, token }) => createGitHubSession({ host, token, transport: transportFor(w, role) });
const networkCalls = (w) => w.calls.length;

// ---- 実行の補助 ----

const scratch = mkdtempSync(join(tmpdir(), "brw-setup-scratch-"));
/** 存在しない CODEX_HOME（利用者の Codex 設定を読まないため）。 */
const NO_CODEX = join(scratch, "no-codex-home");
const cleanupAll = () => rmSync(scratch, { recursive: true, force: true });

/** runSetup を実行する。既定は非対話・空の環境変数・偽の診断。 */
const setupRun = async (dir, args, extra = {}) => {
  const out = [];
  const err = [];
  const code = await cli.runSetup(args, {
    cwd: dir, io: { out: (s) => out.push(s), err: (s) => err.push(s) }, stdinIsTTY: false, env: {}, codexHome: NO_CODEX, pluginRoot: ROOT, diagnose: STUB_DIAG, ...extra,
  });
  return { code, text: [...out, ...err].join("\n"), out: out.join("\n"), err: err.join("\n") };
};

/** runStateCheck（brw check の追加節）を実行する。 */
const checkRun = async (dir, opts, extra = {}) => {
  const out = [];
  const err = [];
  const code = await cli.runStateCheck(dir, opts, {
    cwd: dir, io: { out: (s) => out.push(s), err: (s) => err.push(s) }, env: {}, codexHome: NO_CODEX, pluginRoot: ROOT, diagnose: STUB_DIAG, ...extra,
  });
  return { code, text: [...out, ...err].join("\n") };
};

/** origin を GitHub のリポジトリ（acme/app）にした一時リポジトリ。通信はしない（URL の文字列だけ）。 */
const ghRepo = (config) => {
  const r = mkRepoWithRemote({ branch: "dev/foo", config });
  gitOut(r.dir, "remote", "set-url", "origin", "https://github.com/acme/app.git");
  return r;
};

const choiceJson = (dir) => JSON.parse(readFileSync(choiceFileOf(dir), "utf8"));
const codexHooksOf = (dir) => join(dir, ".codex", "hooks.json");

/** 対話の相当（stdinIsTTY 真）。ask は質問文を記録して答えを返す。 */
const ttyDeps = (answer) => {
  const asked = [];
  return { asked, deps: { stdinIsTTY: true, ask: async (q) => { asked.push(q); return answer; } } };
};

export const runSetupCliChecks = async (eq) => {
  if (!cli.runSetup || !cli.runStateCheck) {
    eq("setup/7.3 scripts/setup-cli.mjs が未実装", false, true);
    cleanupAll();
    return;
  }

  // ---- 旧パスの宣言の移行（明示時のみ書き換え、旧パスは残す） ----
  {
    const r = mkRepoWithRemote({ branch: "dev/foo", config: CONFIG, configPath: LEGACY });
    try {
      const plain = await setupRun(r.dir, ["--ruleset", "off"]);
      eq("setup/7.3 旧パスの宣言だけでは、通常の setup は新しいパスへ書かず --migrate を案内する", [existsSync(join(r.dir, ROOT_CONFIG)), plain.text.includes("--migrate")], [false, true]);
      const m = await setupRun(r.dir, ["--migrate"]);
      const moved = existsSync(join(r.dir, ROOT_CONFIG)) ? JSON.parse(readFileSync(join(r.dir, ROOT_CONFIG), "utf8")) : null;
      eq("setup/7.3 --migrate は旧パスと同じ内容を新しいパスへ書き、旧パスは残す（autoApprove は未指定のまま）", [m.code, moved, existsSync(join(r.dir, LEGACY))], [0, CONFIG, true]);
    } finally { r.cleanup(); }
  }
  {
    const r = mkRepoWithRemote({ branch: "dev/foo", config: { ...CONFIG, autoApprove: { push: false } }, configPath: LEGACY });
    try {
      const m = await setupRun(r.dir, ["--migrate", "--keep-confirm", "pullRequest"]);
      const moved = JSON.parse(readFileSync(join(r.dir, ROOT_CONFIG), "utf8"));
      eq("setup/7.3 移行では旧宣言の明示的な false を維持し、--keep-confirm で指定した項目を明示的に無効化する", [m.code, moved.autoApprove], [0, { push: false, pullRequest: false }]);
    } finally { r.cleanup(); }
  }
  {
    const r = mkRepoWithRemote({ branch: "dev/foo", config: CONFIG, configPath: LEGACY });
    try {
      writeFileSync(join(r.dir, ROOT_CONFIG), JSON.stringify({ ...CONFIG, baseBranch: "main" }));
      const m = await setupRun(r.dir, ["--migrate"]);
      eq("setup/7.3 新旧の宣言が食い違うときは上書きせず、利用者に決めてもらう（終了コード 1）", [m.code, JSON.parse(readFileSync(join(r.dir, ROOT_CONFIG), "utf8")).baseBranch], [1, "main"]);
    } finally { r.cleanup(); }
  }
  {
    // 移行の書き込みは排他（wx）。既存の項目（ここでは壊れた symlink）を上書きも辿りもしない
    const r = mkRepoWithRemote({ branch: "dev/foo", config: CONFIG, configPath: LEGACY });
    try {
      const target = join(r.dir, "elsewhere.json");
      symlinkSync(target, join(r.dir, ROOT_CONFIG));
      const m = await setupRun(r.dir, ["--migrate"]);
      eq("setup/7.3 移行は既存の項目（symlink）を上書きせず、リンク先を作らず終了コード 1", [m.code, existsSync(target), existsSync(join(r.dir, LEGACY))], [1, false, true]);
    } finally { r.cleanup(); }
  }
  {
    // 子の gh へ両方の BRW 用トークンを継承させない（渡すのは引数の 1 つだけ）
    const e = ghEnv("github.com", "only-one-token", { BRW_SETUP_GH_TOKEN: "a-admin", BRW_WORK_GH_TOKEN: "b-work", PATH: "/usr/bin" });
    eq("setup/7.3 子の gh の環境には導入用の 2 つのトークンを残さず、引数の 1 つだけを GH_TOKEN に渡す", [e.BRW_SETUP_GH_TOKEN, e.BRW_WORK_GH_TOKEN, e.GH_TOKEN, e.PATH], [undefined, undefined, "only-one-token", "/usr/bin"]);
  }
  {
    const r = mkRepoWithRemote({ branch: "dev/foo", config: CONFIG, configPath: LEGACY });
    try {
      const bad = await setupRun(r.dir, ["--keep-confirm", "push"]);
      eq("setup/7.3 --keep-confirm は --migrate と一緒にだけ使える（使い方の誤り 2）", bad.code, 2);
    } finally { r.cleanup(); }
  }

  // ---- 導入の選択（非対話・対話・見送り・保存済みの選択） ----
  {
    const r = ghRepo(CONFIG);
    try {
      const w = createWorld();
      const res = await setupRun(r.dir, [], { makeSession: sessionsOf(w) });
      // 方針変更（2026-11-21）: Ruleset は既定 off。非対話で未指定は保留（3）ではなく見送り（0）。認証・通信・書き込み・記録は 0
      eq("setup/7.3 非対話で --ruleset 未指定なら Ruleset は既定どおり導入せず（終了コード 0）、GitHub へ通信せず、選択も記録しない", [res.code, networkCalls(w), w.writes, existsSync(choiceFileOf(r.dir))], [0, 0, 0, false]);
      eq("setup/7.3 既定の見送りでもフック（Codex の .codex/hooks.json）は導入する", existsSync(codexHooksOf(r.dir)), true);
      eq("setup/7.3 既定の見送りの案内に、後から --ruleset on で導入できると示す", res.text.includes("--ruleset on"), true);
      const later = await setupRun(r.dir, ["--ruleset", "on"], { env: { BRW_SETUP_GH_TOKEN: ADMIN_TOKEN, BRW_WORK_GH_TOKEN: WORK_TOKEN }, makeSession: sessionsOf(createWorld({ adminPerms: true, workPerms: false })) });
      eq("setup/7.3 既定の見送りのあとでも --ruleset on で導入でき（終了コード 0）、選択が保存される", [later.code, resolveChoice(r.dir, { ...TARGET, repositoryId: 42 }).status], [0, "selected"]);
    } finally { r.cleanup(); }
  }
  {
    const r = ghRepo(CONFIG);
    try {
      const w = createWorld();
      const res = await setupRun(r.dir, ["--ruleset", "off"], { makeSession: sessionsOf(w) });
      const saved = resolveChoice(r.dir, TARGET);
      eq("setup/7.3 見送り（off）は GitHub の認証なしで選択を保存し、フック導入まで進む", [res.code, networkCalls(w), saved.status], [0, 0, "skipped"]);
      const again = await setupRun(r.dir, [], { makeSession: sessionsOf(w) });
      eq("setup/7.3 保存済みの見送りは次回の非対話でもそのまま使い、GitHub へ通信しない", [again.code, networkCalls(w)], [0, 0]);
      const first = readFileSync(codexHooksOf(r.dir), "utf8");
      const third = await setupRun(r.dir, ["--ruleset", "off"], { makeSession: sessionsOf(w) });
      eq("setup/7.3 フックの再導入は変更なしで終わる（ファイルの内容が同じ）", [third.code, readFileSync(codexHooksOf(r.dir), "utf8") === first, third.text.includes("registered")], [0, true, true]);
    } finally { r.cleanup(); }
  }
  {
    const r = ghRepo(CONFIG);
    try {
      const w = createWorld();
      const t = ttyDeps("n");
      const res = await setupRun(r.dir, [], { ...t.deps, makeSession: sessionsOf(w) });
      eq("setup/7.3 対話では「導入しますか [y/N]」（既定は見送り）を聞き、対象と効果は聞く前に表示する", [t.asked.length, t.asked[0]?.includes("導入しますか [y/N]"), res.out.includes("github.com/acme/app"), res.out.includes("squash")], [1, true, true, true]);
      eq("setup/7.3 対話で n と答えたら見送りとして保存し、GitHub へは通信しない", [res.code, networkCalls(w), resolveChoice(r.dir, TARGET).status], [0, 0, "skipped"]);
    } finally { r.cleanup(); }
  }

  // 対話で Enter（既定）は見送り。通信 0・書き込み 0
  {
    const r = ghRepo(CONFIG);
    try {
      const w = createWorld();
      const t = ttyDeps("");
      const res = await setupRun(r.dir, [], { ...t.deps, makeSession: sessionsOf(w) });
      eq("setup/7.3 対話で Enter（既定）は見送りになり、GitHub へ通信せず書き込まない（終了コード 0）", [res.code, networkCalls(w), w.writes, resolveChoice(r.dir, TARGET).status], [0, 0, 0, "skipped"]);
      eq("setup/7.3 対話の見送りでもフックは導入する", existsSync(codexHooksOf(r.dir)), true);
    } finally { r.cleanup(); }
  }

  // ---- 導入を選んだ場合（対話の既定の選択肢 → 照合 → 事前検査 → 追加 → 適用後検査） ----
  {
    const r = ghRepo(CONFIG);
    try {
      const w = createWorld({ adminPerms: true, workPerms: false });
      const t = ttyDeps("y");
      const env = { BRW_SETUP_GH_TOKEN: ADMIN_TOKEN, BRW_WORK_GH_TOKEN: WORK_TOKEN };
      const res = await setupRun(r.dir, [], { ...t.deps, env, makeSession: sessionsOf(w) });
      const rec = resolveChoice(r.dir, { ...TARGET, repositoryId: 42 });
      const rs = w.rulesets[0];
      eq("setup/7.3 対話で y と答えると（既定は見送りのため明示が必要）、Ruleset を 1 件追加し、適用後検査まで通る（終了コード 0）", [res.code, w.writes, w.rulesets.length], [0, 1, 1]);
      eq("setup/7.3 追加する Ruleset は対象の分岐元すべてを完全な ref で指定し、バイパスなし・有効", [rs?.conditions?.ref_name?.include, rs?.bypass_actors, rs?.enforcement, rs?.target], [["refs/heads/develop", "refs/heads/release"], [], "active", "branch"]);
      eq("setup/7.3 適用後検査が通ったら、記録の Ruleset ID を確認済みにする", [rec.status, rec.appliedRulesetIds, choiceJson(r.dir).repos["github.com/acme/app"].applied[0]?.verified], ["selected", [rs.id], true]);
      eq("setup/7.3 認証の値は出力にも選択の記録にも出さない", [res.text.includes(ADMIN_TOKEN), res.text.includes(WORK_TOKEN), readFileSync(choiceFileOf(r.dir), "utf8").includes(ADMIN_TOKEN)], [false, false, false]);
      eq("setup/7.3 設定用の認証は admin の要求に、作業用の認証は作業経路の読み取りに使う（作業経路で書き込みはしない）", [w.calls.some((c) => c.role === "work" && c.method !== "GET"), w.calls.some((c) => c.role === "admin" && c.method === "POST")], [false, true]);
    } finally { r.cleanup(); }
  }
  {
    const r = ghRepo(CONFIG);
    try {
      const w = createWorld({ adminPerms: false });
      const res = await setupRun(r.dir, ["--ruleset", "on"], { makeSession: sessionsOf(w) });
      eq("setup/7.3 管理権限がなければ事前検査で止まり、書き込みは 0 件（終了コード 1）", [res.code, w.writes, w.rulesets.length], [1, 0, 0]);
    } finally { r.cleanup(); }
  }
  {
    const r = ghRepo(CONFIG);
    try {
      const w = createWorld({ adminPerms: true, workPerms: true });
      const res = await setupRun(r.dir, ["--ruleset", "on"], { env: { BRW_WORK_GH_TOKEN: WORK_TOKEN }, makeSession: sessionsOf(w) });
      eq("setup/7.3 作業用の認証が Ruleset を変えられる（管理権限あり）と、設定のずれとして終了コード 1", [res.code, w.writes], [1, 1]);
    } finally { r.cleanup(); }
  }
  {
    const r = ghRepo(CONFIG);
    try {
      const w = createWorld();
      const res = await setupRun(r.dir, ["--ruleset", "on"], { makeSession: sessionsOf(w) });
      eq("setup/7.3 作業経路の権限を確認できなければ、適用は済んでも迂回不可とは表示せず確認不能（終了コード 3）", [res.code, w.writes, res.text.includes("確認")], [3, 1, true]);
    } finally { r.cleanup(); }
  }
  {
    const r = ghRepo(CONFIG);
    try {
      recordChoice(r.dir, { ...TARGET, enabled: true, repositoryId: 999 });
      const w = createWorld();
      const res = await setupRun(r.dir, ["--ruleset", "on"], { env: { BRW_WORK_GH_TOKEN: WORK_TOKEN }, makeSession: sessionsOf(w) });
      eq("setup/7.3 保存済みのリポジトリ ID と GitHub の応答が違えば再確認にして、書き込まない（終了コード 3）", [res.code, w.writes], [3, 0]);
      eq("setup/7.3 ID の食い違いは CLI 自身が照合して再確認を案内する（適用の内部検査に任せない）", res.text.includes("保存済みの選択と合いません"), true);
    } finally { r.cleanup(); }
  }
  {
    const r = ghRepo(CONFIG);
    try {
      recordChoice(r.dir, { ...TARGET, refs: ["develop"], enabled: true });
      const w = createWorld();
      const res = await setupRun(r.dir, [], { makeSession: sessionsOf(w) });
      eq("setup/7.3 対象の分岐元が変わった選択は取り直しになり、非対話では保留（通信なし）", [res.code, networkCalls(w)], [3, 0]);
    } finally { r.cleanup(); }
  }
  {
    const r = ghRepo(CONFIG);
    try {
      gitOut(r.dir, "remote", "rename", "origin", "up");
      gitOut(r.dir, "remote", "add", "other", "https://github.com/acme/other.git");
      const w = createWorld();
      const res = await setupRun(r.dir, ["--ruleset", "on"], { makeSession: sessionsOf(w) });
      eq("setup/7.3 GitHub のリモートが複数あり origin が無いときは対象を決めず、通信しない（終了コード 3）", [res.code, networkCalls(w)], [3, 0]);
    } finally { r.cleanup(); }
  }

  // ---- 状態検査（brw check の追加節） ----
  {
    const r = ghRepo(CONFIG);
    try {
      const w = createWorld();
      const c = await checkRun(r.dir, { ruleset: false }, { makeSession: sessionsOf(w) });
      eq("check/7.3 フックの状態は経路ごとに表示し、Ruleset の節は出さず、GitHub へ通信しない", [c.code, c.text.includes("フック"), c.text.includes("PreToolUse"), c.text.includes("Ruleset"), networkCalls(w)], [0, true, true, false, 0]);
      eq("check/7.3 フックの限界（対応していない経路）も一緒に表示する", c.text.includes("stub-limit"), true);
    } finally { r.cleanup(); }
  }
  {
    const r = ghRepo(CONFIG);
    try {
      const w = createWorld();
      const c = await checkRun(r.dir, { ruleset: true }, { makeSession: sessionsOf(w) });
      // 方針変更（2026-11-21）: 未選択は既定 off として問題にしない（保留の 3 ではなく 0）
      eq("check/7.3 導入の選択が未設定の Ruleset は未選択（既定は適用しない）として表示し、通信せず終了コード 0", [c.code, c.text.includes("未選択"), networkCalls(w)], [0, true, 0]);
    } finally { r.cleanup(); }
  }
  {
    const r = ghRepo(CONFIG);
    try {
      const w = createWorld();
      await setupRun(r.dir, ["--ruleset", "off"], { makeSession: sessionsOf(w) });
      const s = await checkRun(r.dir, { ruleset: true }, { makeSession: sessionsOf(w) });
      eq("check/7.3 見送りの Ruleset は未適用として表示し、終了コード 0（通信なし）", [s.code, s.text.includes("見送り"), networkCalls(w)], [0, true, 0]);
    } finally { r.cleanup(); }
  }
  {
    const r = ghRepo(CONFIG);
    try {
      const w = createWorld({ adminPerms: true, workPerms: false });
      await setupRun(r.dir, ["--ruleset", "on"], { env: { BRW_WORK_GH_TOKEN: WORK_TOKEN }, makeSession: sessionsOf(w) });
      const before = w.writes;
      const c = await checkRun(r.dir, { ruleset: true }, { env: { BRW_WORK_GH_TOKEN: WORK_TOKEN }, makeSession: sessionsOf(w) });
      eq("check/7.3 適用済みで要件を満たす Ruleset は enforced として終了コード 0。読み取りだけで書き込みは増えない", [c.code, c.text.includes("enforced") || c.text.includes("適用済み"), w.writes === before], [0, true, true]);
    } finally { r.cleanup(); }
  }
  {
    const r = ghRepo(CONFIG);
    try {
      const w = createWorld();
      await setupRun(r.dir, ["--ruleset", "on"], { env: { BRW_WORK_GH_TOKEN: WORK_TOKEN }, makeSession: sessionsOf(w) });
      w.denyRules = true;
      const c = await checkRun(r.dir, { ruleset: true }, { env: { BRW_WORK_GH_TOKEN: WORK_TOKEN }, makeSession: sessionsOf(w) });
      eq("check/7.3 検査権限が足りず実効ルールを読めないときは確認不能（終了コード 3）。設定のずれとは表示しない", [c.code, c.text.includes("verify-failed"), c.text.includes("ずれ")], [3, true, false]);
    } finally { r.cleanup(); }
  }
  {
    const r = ghRepo(CONFIG);
    try {
      const w = createWorld({ adminPerms: true, workPerms: true });
      await setupRun(r.dir, ["--ruleset", "on"], { makeSession: sessionsOf(w) });
      const c = await checkRun(r.dir, { ruleset: true }, { env: { BRW_WORK_GH_TOKEN: WORK_TOKEN }, makeSession: sessionsOf(w) });
      eq("check/7.3 作業経路が迂回できる（設定のずれ）なら終了コード 1", c.code, 1);
    } finally { r.cleanup(); }
  }
  {
    // 実際の診断（子プロセスで応答を確かめる）を使う経路。GitHub には触れない
    const r = ghRepo(CONFIG);
    try {
      const out = [];
      const code = await cli.runStateCheck(r.dir, { ruleset: false }, { cwd: r.dir, io: { out: (s) => out.push(s), err: (s) => out.push(s) }, env: {}, codexHome: NO_CODEX, pluginRoot: ROOT });
      eq("check/7.3 実際のフック診断の結果を経路ごとに表示する（子プロセスで確かめる）", [code, out.join("\n").includes("PreToolUse")], [0, true]);
    } finally { r.cleanup(); }
  }

  // ---- 実際の CLI（brw.mjs）の配線。非対話で GitHub へ通信しない経路だけを確かめる ----
  {
    const r = ghRepo(CONFIG);
    try {
      const env = { ...process.env, CODEX_HOME: NO_CODEX };
      const s = spawnSync("node", [BRW, "setup"], { cwd: r.dir, env, encoding: "utf8" });
      eq("setup/7.3 brw setup は非対話で採否が無ければ既定どおり導入せず終了コード 0（実際の CLI の配線。方針変更 2026-11-21）", [s.status, (s.stdout + s.stderr).includes("--ruleset")], [0, true]);
      const c = spawnSync("node", [BRW, "check", "--ruleset"], { cwd: r.dir, env, encoding: "utf8" });
      eq("check/7.3 brw check --ruleset は非対話で選択が無ければ未選択として終了コード 0（実際の CLI の配線。方針変更 2026-11-21）", c.status, 0);
      const b = spawnSync("node", [BRW, "check", "--branches-only"], { cwd: r.dir, env, encoding: "utf8" });
      eq("check/7.3 --branches-only の出力にはフックの節も Ruleset の節も出ない", [b.status, b.stdout.includes("フック"), b.stdout.includes("Ruleset")], [0, false, false]);
      const bo = spawnSync("node", [BRW, "check", "--branches-only", "--ruleset"], { cwd: r.dir, env, encoding: "utf8" });
      eq("check/7.3 --branches-only と --ruleset の同時指定は使い方の誤り（終了コード 2）", bo.status, 2);
    } finally { r.cleanup(); }
  }

  cleanupAll();
};
