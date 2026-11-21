// Ruleset の導入・検査の契約テスト（brw-enforcement 8.2）。selftest.mjs から呼ばれる。
// 次の 2 つの経路で確かめる:
//   - 実際の CLI（scripts/brw.mjs の setup・check）を spawn する。GitHub の応答は偽の gh（tests/support/gh-shim.mjs）から返す。
//     偽の gh は状態を持たないため、現在の状態から作った静的な応答だけを渡す。
//   - runSetup・runStateCheck を deps 注入で呼ぶ。応答喪失や別管理者の変更のように途中で状態が変わる場面は、
//     tests/support/fake-github.mjs の応答層の上に作った状態つきの通信層で再現する。
// 通信も実際の認証も行わない。書き込みの件数はメソッド別に数え、事前検査の失敗時は 0 件であることを eq で比べる。
// 利用者の ~/.codex・~/.claude・~/.gitconfig には触れない（子プロセスの HOME・CODEX_HOME・Git の設定は一時の場所へ向ける）。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGitHubSession } from "../scripts/github-client.mjs";
import { runSetup, runStateCheck } from "../scripts/setup-cli.mjs";
import { RULESET_NAME } from "../scripts/ruleset-apply.mjs";
import { choiceFileOf, recordChoice } from "../scripts/ruleset-choice.mjs";
import { createFakeGitHub } from "./support/fake-github.mjs";
import { gitOut, mkRepoWithRemote } from "./support/git-fixture.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const BRW = join(ROOT, "scripts/brw.mjs");
const SHIM = join(here, "support/gh-shim.mjs");

// 偽の資格情報（値は応答の判定にだけ使い、出力に現れないことを確かめる）
const ADMIN = "admin-token-8-2";
const WORK = "work-token-8-2";
const EXPIRED = "expired-token-8-2";

const REPO_ID = 4242;
const REPO = "/repos/acme/app";
const RULESETS = `${REPO}/rulesets`;
const LIST_PATH = `${REPO}/rulesets?includes_parents=true&per_page=100&page=1`;
const BRANCHES_PATH = `${REPO}/branches?per_page=100&page=1`;
const ORIGIN = "https://github.com/acme/app.git";
const TARGET = { host: "github.com", owner: "acme", repository: "app" };
const CONFIG = { workBranches: ["dev/*"], protectedBranches: ["main"], baseBranch: "main" };
const STUB_DIAG = () => ({
  routes: [{ host: "claude", environment: "local", event: "PreToolUse", status: "active", reasonCode: null, reason: "stub", probes: [], managedHooksRequired: false }],
  limits: [{ id: "stub-limit", host: "both", text: "stub" }],
});

/** 他の管理者が作った、BRW と無関係のレビュー用 Ruleset。既存のルールを保持するかの確認に使う。 */
const REVIEW = {
  id: 50, name: "team-review", target: "branch", enforcement: "active", source_type: "Repository", source: "acme/app",
  conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
  rules: [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "ci" }], strict_required_status_checks_policy: false } }],
  bypass_actors: [],
};
/** BRW が追加する形の Ruleset（PR 必須・squash 限定・バイパスなし）。 */
const brwRuleset = (id, refs = ["main"]) => ({
  id, name: RULESET_NAME, target: "branch", enforcement: "active", source_type: "Repository", source: "acme/app",
  conditions: { ref_name: { include: refs.map((r) => `refs/heads/${r}`), exclude: [] } },
  rules: [{ type: "pull_request", parameters: { allowed_merge_methods: ["squash"], dismiss_stale_reviews_on_push: false, require_code_owner_review: false, require_last_push_approval: false, required_approving_review_count: 0, required_review_thread_resolution: false } }],
  bypass_actors: [],
});

/** 資格情報ごとの身元。admin は設定用、work は通常作業の認証。 */
const idsWith = ({ adminAdmin = true, adminScopes = null, workAdmin = false } = {}) => ({
  [ADMIN]: { login: "admin-user", scopes: adminScopes, admin: adminAdmin },
  [WORK]: { login: "dev-user", scopes: null, admin: workAdmin },
});

/** 状態。見た目の変化（権限・プラン・バイパス・ブランチ）と Ruleset の一覧を持つ。 */
const makeWorld = (over = {}) => {
  const w = {
    repoId: REPO_ID, visibility: "public", allowSquash: true, branches: ["main", "develop"],
    listStatus: 200, bypassMissing: false, rulesets: [], nextId: 100, writePlan: [],
    beforeWrite: null, afterApplied: null, ids: idsWith(),
    ...over,
  };
  w.rulesets = structuredClone(w.rulesets);
  return w;
};

const J = (status, body, headers = {}) => ({ status, body, headers });
const listItem = (rs) => ({ id: rs.id, name: rs.name, target: rs.target, enforcement: rs.enforcement, source_type: rs.source_type, source: rs.source });
const detailOf = (w, rs) => {
  const d = structuredClone(rs);
  if (w.bypassMissing) delete d.bypass_actors;
  return d;
};
/** 分岐元の実効ルール（有効な Ruleset のうち、その分岐元を含むものの規則）。 */
const effectiveOf = (w, ref) => w.rulesets
  .filter((rs) => rs.enforcement === "active" && rs.conditions.ref_name.include.includes(`refs/heads/${ref}`))
  .flatMap((rs) => rs.rules.map((r) => ({ type: r.type, ruleset_id: rs.id, ruleset_source_type: "Repository", ruleset_source: "acme/app", parameters: r.parameters })));

/** 資格情報の身元に応じた GET の応答。書き込み（POST）は createRuleset が扱う。 */
const respond = (w, credential, m, path) => {
  if (m !== "GET") return undefined;
  const id = w.ids[credential];
  const [p] = path.split("?");
  if (p === "/user") return id ? J(200, { login: id.login }, id.scopes !== null ? { "x-oauth-scopes": id.scopes } : {}) : J(401, { message: "Bad credentials" });
  if (!id) return J(401, { message: "Bad credentials" });
  if (p === REPO) return J(200, { id: w.repoId, full_name: "acme/app", private: w.visibility === "private", visibility: w.visibility, allow_squash_merge: w.allowSquash, default_branch: "main", permissions: { admin: id.admin, push: true, pull: true } });
  if (p === `${REPO}/branches`) return J(200, w.branches.map((name) => ({ name })));
  if (p === RULESETS) return w.listStatus === 200 ? J(200, w.rulesets.map(listItem)) : J(w.listStatus, { message: "Resource not accessible" });
  const d = /^\/repos\/acme\/app\/rulesets\/(\d+)$/.exec(p);
  if (d) {
    const rs = w.rulesets.find((x) => x.id === Number(d[1]));
    return rs ? J(200, detailOf(w, rs)) : J(404, { message: "Not Found" });
  }
  const b = /^\/repos\/acme\/app\/rules\/branches\/([^/]+)$/.exec(p);
  if (b) return J(200, effectiveOf(w, decodeURIComponent(b[1])));
  return undefined;
};

/** 書き込みの結果の型。ok・lost（適用後に応答が切れる）・lost-unapplied（適用前に切れる）・500-applied（適用後に 500）・500・403・422。 */
const HTTP_OF = { ok: 201, lost: 201, "lost-unapplied": 201, "500-applied": 500, 500: 500, 403: 403, 422: 422 };
/** GitHub 側で Ruleset が作られる結果。 */
const APPLIED = ["ok", "lost", "500-applied"];

/**
 * Ruleset の追加（POST）を処理する。書き込みの件数は fake-github が数える（拒否された要求も数える）。
 * 身元が無ければ 401、管理権限が無ければ 403 で、どちらも作成しない。
 * 作成は writePlan の順に結果を決める。throw する結果（lost）は応答だけ切れた状態を再現する。
 */
const createRuleset = async (w, fake, routes, body, credential) => {
  const key = `POST ${RULESETS}`;
  const id = w.ids[credential];
  let step = null;
  let created = null;
  if (!id) routes[key] = J(401, { message: "Bad credentials" });
  else if (!id.admin) routes[key] = J(403, { message: "Resource not accessible by integration" });
  else {
    w.beforeWrite?.(w);
    step = w.writePlan.length ? w.writePlan.shift() : "ok";
    created = { ...structuredClone(body), id: w.nextId++, source_type: "Repository", source: "acme/app" };
    routes[key] = J(HTTP_OF[step], step === "403" || step === "422" ? { message: "Validation Failed" } : created);
  }
  const res = await fake.request("POST", RULESETS, body, {});
  if (created && APPLIED.includes(step)) {
    w.rulesets.push(created);
    w.afterApplied?.(w, created);
  }
  if (step?.startsWith("lost")) throw Object.assign(new Error("応答が途中で切れた"), { code: "ECONNRESET" });
  return res;
};

/**
 * 状態つきの通信層。GET は状態から応答を作り、POST は createRuleset で結果を決める。
 * 要求の記録と件数は fake-github の応答層（createFakeGitHub）が持つ。
 */
const githubOf = (w) => {
  const routes = {};
  const fake = createFakeGitHub({ routes });
  const transport = async ({ method, path, body, credential, host }) => {
    const m = method.toUpperCase();
    // 経路表は要求ごとに状態から作り直す（前の要求の応答を残さない）
    for (const k of Object.keys(routes)) delete routes[k];
    if (m === "POST" && path === RULESETS) return createRuleset(w, fake, routes, body, credential);
    const r = respond(w, credential, m, path);
    if (r) routes[`${m} ${path}`] = r;
    return fake.request(m, path, body, { host });
  };
  return { fake, transport };
};

/** メソッド別の件数（キーは昇順）。書き込みがなければ空。 */
const countMethods = (list) => {
  const o = {};
  for (const e of list) o[e.method] = (o[e.method] ?? 0) + 1;
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
};
const writesOf = (gh) => countMethods(gh.fake.requests.filter((q) => q.method !== "GET"));

/** 静的な応答表（偽の gh 用）。身元 cred で見える状態を、現在の状態から全経路ぶん作る。 */
const staticRoutesOf = (w, cred) => {
  const routes = {};
  const paths = [
    "/user", REPO, BRANCHES_PATH, LIST_PATH,
    ...w.rulesets.map((rs) => `${RULESETS}/${rs.id}?includes_parents=true`),
    ...w.branches.map((b) => `${REPO}/rules/branches/${b}?per_page=100&page=1`),
  ];
  for (const p of paths) {
    const r = respond(w, cred, "GET", p);
    if (r) routes[`GET ${p}`] = r;
  }
  return routes;
};

// ---- 実行の補助 ----

const scratch = mkdtempSync(join(tmpdir(), "brw-ruleset-int-"));
const bin = join(scratch, "bin");
const home = join(scratch, "home");
const emptyCodex = join(scratch, "codex-home");
mkdirSync(bin);
mkdirSync(home);
mkdirSync(emptyCodex);
writeFileSync(join(bin, "gh"), `#!/bin/sh\nexec node "${SHIM}" "$@"\n`, { mode: 0o755 });
const repos = [];
let seq = 0;

/** 宣言つきの一時リポジトリ（origin は GitHub の URL の文字列だけ。通信しない）。 */
const repoOf = (config = CONFIG) => {
  const r = mkRepoWithRemote({ branch: "dev/foo", config });
  gitOut(r.dir, "remote", "set-url", "origin", ORIGIN);
  repos.push(r);
  return r.dir;
};
const captured = () => {
  const out = [];
  const err = [];
  return { io: { out: (s) => out.push(String(s)), err: (s) => err.push(String(s)) }, text: () => [...out, ...err].join("\n") };
};

/** runSetup を状態つきの通信層で実行する。workToken を null にすると作業用の認証は無い。 */
const setupIn = async (dir, args, w, { workToken = WORK, gh = githubOf(w) } = {}) => {
  const io = captured();
  const env = { BRW_SETUP_GH_TOKEN: ADMIN, ...(workToken ? { BRW_WORK_GH_TOKEN: workToken } : {}) };
  const code = await runSetup(args, {
    cwd: dir, io: io.io, stdinIsTTY: false, env,
    makeSession: ({ host, token }) => createGitHubSession({ host, token, transport: gh.transport }),
    codexHome: emptyCodex, pluginRoot: ROOT, diagnose: STUB_DIAG,
  });
  return { code, text: io.text(), gh };
};

/** runStateCheck（brw check --ruleset の本体）を状態つきの通信層で実行する。 */
const checkIn = async (dir, w, { workToken = WORK, gh = githubOf(w) } = {}) => {
  const io = captured();
  const env = { BRW_SETUP_GH_TOKEN: ADMIN, ...(workToken ? { BRW_WORK_GH_TOKEN: workToken } : {}) };
  const code = await runStateCheck(dir, { ruleset: true }, {
    cwd: dir, io: io.io, env,
    makeSession: ({ host, token }) => createGitHubSession({ host, token, transport: gh.transport }),
    codexHome: emptyCodex, pluginRoot: ROOT, diagnose: STUB_DIAG,
  });
  return { code, text: io.text(), gh };
};

/** 実際の CLI（brw.mjs）を spawn する。GitHub の応答は偽の gh（身元 identity の静的な応答）から返す。 */
let cliSeq = 0;
const cliIn = (dir, args, w, { identity = ADMIN, workToken = null } = {}) => {
  const n = ++cliSeq;
  const cfg = join(scratch, `gh-${n}.json`);
  const log = join(scratch, `gh-${n}.log`);
  writeFileSync(cfg, JSON.stringify({ scenario: "success", routes: staticRoutesOf(w, identity) }));
  const env = {
    ...process.env, HOME: home, CODEX_HOME: emptyCodex, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    PATH: `${bin}:${process.env.PATH}`, BRW_NO_GH: "1", BRW_SETUP_GH_TOKEN: ADMIN,
    BRW_GH_SHIM_CONFIG: cfg, BRW_GH_SHIM_LOG: log,
  };
  delete env.BRW_WORK_GH_TOKEN;
  if (workToken) env.BRW_WORK_GH_TOKEN = workToken;
  const r = spawnSync("node", [BRW, ...args], { cwd: dir, encoding: "utf8", env });
  const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { code: r.status, text: `${r.stdout}${r.stderr}`, calls };
};
const writesOfCalls = (calls) => countMethods(calls.filter((c) => c.method !== "GET"));

/** 導入の選択を保存する（対象は TARGET）。 */
const saveChoice = (dir, { refs = ["main"], enabled = true, repositoryId = REPO_ID } = {}) => {
  const r = recordChoice(dir, { ...TARGET, refs, enabled, repositoryId: enabled ? repositoryId : null });
  if (!r.ok) throw new Error(`選択を保存できない: ${r.error.message}`);
};
/** 導入の選択の記録。まだ無ければ空（何も保存されていないことを表す）。 */
const choiceStateOf = (dir) => (existsSync(choiceFileOf(dir)) ? JSON.parse(readFileSync(choiceFileOf(dir), "utf8")) : { repos: {} });
const choiceOf = (dir) => Object.values(choiceStateOf(dir).repos)[0]?.choice;
/** 記録された適用済み Ruleset ID（昇順）。 */
const appliedIdsOf = (dir) => Object.values(choiceStateOf(dir).repos).flatMap((e) => e.applied.map((a) => a.rulesetId)).sort((a, b) => a - b);
const brwCountOf = (w) => w.rulesets.filter((x) => x.name === RULESET_NAME).length;
const choiceTextOf = (dir) => readFileSync(choiceFileOf(dir), "utf8");

export const runIntegrationRulesetChecks = async (eq) => {
  // ---- 1. 実際の CLI（spawn）: 見送り・権限・プラン・再利用・対象変更・検査の経路 ----
  {
    const dir = repoOf();
    const w = makeWorld();
    const off = cliIn(dir, ["setup", "--ruleset", "off"], w, { identity: ADMIN });
    eq("ruleset-int/8.2 見送り（off）は GitHub へ一切通信せず、選択を保存して終了コード 0", [off.code, off.calls.length, writesOfCalls(off.calls), choiceOf(dir)?.enabled], [0, 0, {}, false]);
    const offCheck = cliIn(dir, ["check", "--ruleset"], w, { identity: WORK, workToken: WORK });
    eq("ruleset-int/8.2 見送りの後の check は見送りと表示し、通信せず終了コード 0", [offCheck.code, offCheck.calls.length, offCheck.text.includes("見送り")], [0, 0, true]);
  }
  {
    const dir = repoOf();
    const w = makeWorld({ ids: idsWith({ adminAdmin: false }) });
    const r = cliIn(dir, ["setup", "--ruleset", "on"], w, { identity: ADMIN });
    eq("ruleset-int/8.2 管理権限がない認証では事前検査で止まり、書き込みは 0 件（終了コード 1）", [r.code, writesOfCalls(r.calls), r.text.includes("管理権限がない")], [1, {}, true]);
  }
  {
    const dir = repoOf();
    const w = makeWorld({ visibility: "private", listStatus: 403 });
    const r = cliIn(dir, ["setup", "--ruleset", "on"], w, { identity: ADMIN });
    eq("ruleset-int/8.2 非公開で Ruleset 一覧が 403・既存 Ruleset もないプラン不明は保留（終了コード 3）、書き込みは 0 件", [r.code, writesOfCalls(r.calls), r.text.includes("事前検査が通らない")], [3, {}, true]);
    // 確認できなかった項目の名前と、再試行の対応が表示されること（要件 5.2）
    eq("ruleset-int/8.2 確認できなかった項目（プラン・Ruleset の読み取り）と再試行の対応を表示する", [r.text.includes("plan: unknown"), r.text.includes("管理画面で確認し、再試行する"), r.text.includes("rulesetAccess: unknown"), r.text.includes("対象のプランを確認して再試行する")], [true, true, true, true]);
  }
  {
    const dir = repoOf();
    const w = makeWorld({ rulesets: [brwRuleset(60)] });
    const r = cliIn(dir, ["setup", "--ruleset", "on"], w, { identity: ADMIN });
    eq("ruleset-int/8.2 同一ルールが既にあれば再利用し、書き込みは 0 件（作業経路が無いので確認不能の 3）", [r.code, writesOfCalls(r.calls), r.text.includes("既存の Ruleset を再利用しました"), choiceOf(dir)?.enabled], [3, {}, true, true]);
  }
  {
    const dir = repoOf();
    saveChoice(dir, { refs: ["main"] });
    const before = choiceTextOf(dir);
    writeFileSync(join(dir, ".branch-release-workflow.json"), JSON.stringify({ ...CONFIG, baseBranch: "develop" }));
    const r = cliIn(dir, ["setup"], makeWorld(), { identity: ADMIN });
    eq("ruleset-int/8.2 対象の分岐元が変わると保存済みの選択を使わず保留（通信 0 件、記録は変えない）", [r.code, r.calls.length, r.text.includes("分岐元が保存済み"), choiceTextOf(dir) === before], [3, 0, true, true]);
  }
  {
    const dir = repoOf();
    saveChoice(dir, { refs: ["main"], repositoryId: REPO_ID });
    const r = cliIn(dir, ["setup", "--ruleset", "on"], makeWorld({ repoId: 9999 }), { identity: ADMIN });
    eq("ruleset-int/8.2 リポジトリ ID が保存済みと違えば再確認を求め、書き込みは 0 件（終了コード 3）", [r.code, writesOfCalls(r.calls), r.text.includes("リポジトリの確認が保存済みの選択と合いません")], [3, {}, true]);
  }
  {
    const dir = repoOf();
    saveChoice(dir);
    const r = cliIn(dir, ["check", "--ruleset"], makeWorld({ rulesets: [brwRuleset(60)], bypassMissing: true }), { identity: WORK, workToken: WORK });
    eq("ruleset-int/8.2 check: バイパス情報が欠けた既存ルールは enforced と表示せず、確認不能（終了コード 3）", [r.code, writesOfCalls(r.calls), /検査結果: enforced/.test(r.text), /検査結果: verify-failed/.test(r.text)], [3, {}, false, true]);
  }
  {
    const dir = repoOf();
    saveChoice(dir);
    const r = cliIn(dir, ["check", "--ruleset"], makeWorld({ rulesets: [brwRuleset(60)] }), { identity: ADMIN, workToken: WORK });
    eq("ruleset-int/8.2 check: 作業主体が管理権限を持つなら迂回可能として設定のずれ（終了コード 1）、enforced とは表示しない", [r.code, /検査結果: drift/.test(r.text), /検査結果: enforced/.test(r.text)], [1, true, false]);
  }
  {
    const dir = repoOf();
    saveChoice(dir);
    const r = cliIn(dir, ["check", "--ruleset"], makeWorld({ rulesets: [brwRuleset(60)] }), { identity: WORK, workToken: WORK });
    eq("ruleset-int/8.2 check（対照）: 適用済みで作業主体に管理権限がなければ enforced・終了コード 0、書き込みなし", [r.code, writesOfCalls(r.calls), /検査結果: enforced/.test(r.text)], [0, {}, true]);
  }
  {
    const dir = repoOf();
    saveChoice(dir);
    const r = cliIn(dir, ["check", "--ruleset"], makeWorld({ rulesets: [brwRuleset(60)] }), { identity: WORK, workToken: null });
    eq("ruleset-int/8.2 check: 作業経路の認証がなければ enforced とは表示せず、確認不能（終了コード 3）", [r.code, /検査結果: enforced/.test(r.text), r.text.includes("作業経路の権限は未確認です")], [3, false, true]);
  }

  // ---- 2. 応答喪失・別管理者の変更（状態つきの通信層・runSetup の deps 注入） ----
  {
    const dir = repoOf();
    const w = makeWorld({ rulesets: [REVIEW], writePlan: ["lost"] });
    const r = await setupIn(dir, ["--ruleset", "on"], w);
    eq("ruleset-int/8.2 応答が切れても一覧で同条件を確かめて記録し、再送しない（書き込み 1 件、終了コード 0）", [r.code, writesOf(r.gh), brwCountOf(w), appliedIdsOf(dir)], [0, { POST: 1 }, 1, [100]]);
    eq("ruleset-int/8.2 照合で記録した場合は「追加した」と表示せず、既存の同条件の Ruleset を確認して記録したと表示する", [r.text.includes("既存の同条件の Ruleset を確認して記録しました"), r.text.includes("Ruleset を追加しました")], [true, false]);
    eq("ruleset-int/8.2 照合の文言は「応答が不確かだったため」で、届かなかったとは断定しない（409・422 でも出るため）", [r.text.includes("応答が不確かだったため一覧で照合し"), r.text.includes("応答が届かなかったため")], [true, false]);
    eq("ruleset-int/8.2 応答喪失の後も既存の Ruleset は変更・削除されず、トークンは出力に出ない", [JSON.stringify(w.rulesets.find((x) => x.id === 50)) === JSON.stringify(REVIEW), r.text.includes(ADMIN) || r.text.includes(WORK)], [true, false]);
  }
  {
    const dir = repoOf();
    const w = makeWorld({ rulesets: [REVIEW], writePlan: ["500-applied"] });
    const r = await setupIn(dir, ["--ruleset", "on"], w);
    eq("ruleset-int/8.2 作成後に 5xx が返っても再取得で確認し、再送せず記録する（書き込み 1 件、終了コード 0）", [r.code, writesOf(r.gh), brwCountOf(w), appliedIdsOf(dir)], [0, { POST: 1 }, 1, [100]]);
  }
  {
    const dir = repoOf();
    const w = makeWorld({ rulesets: [REVIEW], writePlan: ["500"] });
    const r = await setupIn(dir, ["--ruleset", "on"], w);
    eq("ruleset-int/8.2 5xx で作成されていなければ再取得しても見つからず、保留（終了コード 3）。再送せず既存の Ruleset だけが残る", [r.code, writesOf(r.gh), w.rulesets.length, appliedIdsOf(dir)], [3, { POST: 1 }, 1, []]);
  }
  {
    const dir = repoOf();
    const w = makeWorld({ rulesets: [REVIEW], writePlan: ["lost-unapplied"] });
    const r = await setupIn(dir, ["--ruleset", "on"], w);
    eq("ruleset-int/8.2 応答が切れて作成もされていなければ保留し、再送しない（書き込み 1 件、終了コード 3）", [r.code, writesOf(r.gh), brwCountOf(w)], [3, { POST: 1 }, 0]);
  }
  {
    // 別の管理者が、こちらの追加の直前に同条件の Ruleset を作っていた。こちらの要求は適用前に応答が切れる。
    const dir = repoOf();
    const w = makeWorld({
      rulesets: [REVIEW],
      writePlan: ["lost-unapplied"],
      beforeWrite: (x) => x.rulesets.push(brwRuleset(x.nextId++)),
    });
    const r = await setupIn(dir, ["--ruleset", "on"], w);
    eq("ruleset-int/8.2 別管理者が同条件を既に追加していれば、その 1 件を再利用して記録し、重複追加しない（書き込み 1 件、終了コード 0）", [r.code, writesOf(r.gh), brwCountOf(w), appliedIdsOf(dir)], [0, { POST: 1 }, 1, [100]]);
    eq("ruleset-int/8.2 別管理者の Ruleset と既存の Ruleset は変更・削除されない", [w.rulesets.some((x) => x.id === 50), JSON.stringify(w.rulesets.find((x) => x.id === 50)) === JSON.stringify(REVIEW)], [true, true]);
    eq("ruleset-int/8.2 別管理者の同条件の Ruleset を記録した場合も「追加した」とは表示しない", [r.text.includes("既存の同条件の Ruleset を確認して記録しました"), r.text.includes("Ruleset を追加しました")], [true, false]);
  }
  {
    // 応答が切れた後に、別の管理者の同条件の Ruleset が加わって候補が 2 つになる
    const dir = repoOf();
    const w = makeWorld({
      rulesets: [REVIEW],
      writePlan: ["lost"],
      afterApplied: (x) => x.rulesets.push(brwRuleset(x.nextId++)),
    });
    const r = await setupIn(dir, ["--ruleset", "on"], w);
    eq("ruleset-int/8.2 同条件の候補が複数なら衝突として候補を示し、追加の書き込みと記録を保留する（書き込み 1 件、終了コード 1）", [r.code, writesOf(r.gh), brwCountOf(w), appliedIdsOf(dir), r.text.includes("候補 ID: 100, 101")], [1, { POST: 1 }, 2, [], true]);
    eq("ruleset-int/8.2 候補が複数のときも既存の Ruleset は変更・削除されない", [w.rulesets.some((x) => x.id === 50), JSON.stringify(w.rulesets.find((x) => x.id === 50)) === JSON.stringify(REVIEW)], [true, true]);
  }

  // ---- 3. バイパス情報の欠落・設定を変更できる作業主体・確認できない認証 ----
  {
    const dir = repoOf();
    const w = makeWorld({ rulesets: [REVIEW], bypassMissing: true });
    const r = await setupIn(dir, ["--ruleset", "on"], w);
    eq("ruleset-int/8.2 バイパス情報が欠けた既存ルールは根拠にできず、書き込みせず保留（終了コード 3）", [r.code, writesOf(r.gh), w.rulesets.length], [3, {}, 1]);
  }
  {
    const dir = repoOf();
    // 既存の別の Ruleset を権限の証拠にする（空のリポジトリでは fine-grained 相当の認証は確認できないため）
    const w = makeWorld({ rulesets: [REVIEW], ids: idsWith({ workAdmin: true }) });
    const r = await setupIn(dir, ["--ruleset", "on"], w, { workToken: WORK });
    eq("ruleset-int/8.2 作業主体が管理権限を持つ場合、適用後の検査は drift（終了コード 1）で enforced と表示しない", [r.code, writesOf(r.gh), /適用後の検査: drift/.test(r.text), /適用後の検査: enforced/.test(r.text)], [1, { POST: 1 }, true, false]);
    eq("ruleset-int/8.2 作業経路が管理権限で drift のときは「適用は完了・迂回可能（enforced とは言えない）」と案内し、「導入を完了できませんでした」とは出さない", [/Ruleset の適用は完了しています。ただし作業経路の認証が管理権限を持つ/.test(r.text), /導入を完了できませんでした/.test(r.text), r.text.includes("導入を完了しました。")], [true, false, false]);
  }
  {
    const dir = repoOf();
    const w = makeWorld({ rulesets: [REVIEW] });
    const r = await setupIn(dir, ["--ruleset", "on"], w, { workToken: null });
    eq("ruleset-int/8.2 作業経路の認証がなければ適用は済んでも迂回不可とは表示せず、確認不能（終了コード 3）", [r.code, writesOf(r.gh), /適用後の検査: enforced/.test(r.text), r.text.includes("作業経路の権限は未確認です")], [3, { POST: 1 }, false, true]);
  }
  {
    const dir = repoOf();
    saveChoice(dir);
    const r = await checkIn(dir, makeWorld({ rulesets: [brwRuleset(60)] }), { workToken: EXPIRED });
    eq("ruleset-int/8.2 作業用の認証が無効（401）なら作業経路は確認不能で、enforced とは表示しない（終了コード 3）", [r.code, writesOf(r.gh), /検査結果: enforced/.test(r.text), /検査結果: unverifiable/.test(r.text)], [3, {}, false, true]);
  }

  // ---- 4. 事前検査が通らなければ書き込み 0 件（管理権限・スコープ・squash・分岐元） ----
  {
    const dir = repoOf();
    const w = makeWorld({ ids: idsWith({ adminScopes: "public_repo" }) });
    const r = await setupIn(dir, ["--ruleset", "on"], w);
    eq("ruleset-int/8.2 repo スコープのない classic トークンは事前検査で止まり、書き込み 0 件（終了コード 1）", [r.code, writesOf(r.gh), r.text.includes("repo スコープがない")], [1, {}, true]);
  }
  {
    const dir = repoOf();
    const w = makeWorld({ allowSquash: false });
    const r = await setupIn(dir, ["--ruleset", "on"], w);
    eq("ruleset-int/8.2 squash が無効なリポジトリは事前検査で止まり、設定を変えず書き込み 0 件（終了コード 1）", [r.code, writesOf(r.gh), r.text.includes("squash マージがリポジトリで無効")], [1, {}, true]);
  }
  {
    const dir = repoOf({ ...CONFIG, baseBranch: "release" });
    const w = makeWorld();
    const r = await setupIn(dir, ["--ruleset", "on"], w);
    eq("ruleset-int/8.2 分岐元が存在しなければ事前検査で止まり、書き込み 0 件（終了コード 1）", [r.code, writesOf(r.gh), w.rulesets.length], [1, {}, 0]);
  }

  for (const r of repos) r.cleanup();
  rmSync(scratch, { recursive: true, force: true });
};
