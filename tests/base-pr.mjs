// 分岐元からの PR の調整役 runBasePr の試験（brw-pr-handoff 7.3）。selftest.mjs から呼ばれる。
// 一時リポジトリ（origin は GitHub の形の URL。試験用 ssh が bare remote へ向ける）と、偽の GitHub 応答（fake-github.mjs）で実行する。
// HOME と Git の全域設定は隔離する。作業の記録（.git/brw）・別コミット・push・片付けが起きないことも確かめる。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitHubSession } from "../scripts/github-client.mjs";
import { loadConfig } from "../scripts/lib.mjs";
import { UNFILLED_MARK } from "../scripts/pr-template.mjs";
import { createFakeGitHub } from "./support/fake-github.mjs";

// 未実装の間は関数が無いため、各項目は失敗として記録される（RED の確認用）
const bp = await import("../scripts/base-pr.mjs").catch(() => ({}));
const runBasePr = (...a) => (bp.runBasePr ? bp.runBasePr(...a) : Promise.resolve(-1));

const CONFIG = { workBranches: ["dev/*"], protectedBranches: ["main"], baseBranch: "develop" };
const HOST = "github.com";
const TOKEN = "test-token-base-pr";
const TITLE = "変更の要約";
const BODY = "本文の内容\n";
const ORIGIN_URL = "git@github.com:acme/app.git";
const REPO_KEY = "GET /repos/acme/app";
const LIST = "GET /repos/acme/app/pulls?state=open&head=acme:develop&per_page=100";
const FILTERED = "GET /repos/acme/app/pulls?state=open&head=acme:develop&base=main&per_page=100";
const POST = "POST /repos/acme/app/pulls";
const PR_URL = "https://github.com/acme/app/pull/7";

// 応答の PR（head の OID は指定の値。取り込み元 develop・取り込み先 main）
const PR = (sha, over = {}) => ({
  number: 7,
  html_url: PR_URL,
  state: "open",
  draft: false,
  base: { ref: "main", repo: { id: 4242, full_name: "acme/app" } },
  head: { ref: "develop", sha, repo: { id: 4242, full_name: "acme/app" } },
  ...over,
});

/** 偽の応答層を注入した GitHub クライアント。mutate は書き込みの適用後に経路の応答を差し替える。 */
const github = ({ routes = {}, mutate } = {}) => {
  const table = {
    [REPO_KEY]: { status: 200, body: { id: 4242, full_name: "acme/app" } },
    [LIST]: { status: 200, body: [] },
    [FILTERED]: { status: 200, body: [] },
    ...routes,
  };
  const fake = createFakeGitHub({ scenario: "success", routes: table });
  const transport = async ({ method, path, body, host }) => {
    const before = fake.applied.length;
    try {
      return await fake.request(method, path, body, { host });
    } finally {
      if (mutate && fake.applied.length > before) mutate(table);
    }
  };
  return { session: createGitHubSession({ host: HOST, token: TOKEN, transport }), fake };
};

// 試験で差し替える環境変数（終了時に元へ戻す）
const ENV_KEYS = ["HOME", "XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT", "GIT_SSH_COMMAND", "GIT_SSH_VARIANT", "BRW_TEST_BARE", "BRW_TEST_SSHLOG", "BRW_NO_GH"];
// 試験用 ssh。受け取った要求を記録し、GitHub のパスを bare remote へ置き換えて実行する
const FAKE_SSH = `#!/bin/sh
printf '%s\\n' "$2" >> "$BRW_TEST_SSHLOG"
cmd=$(printf '%s' "$2" | sed "s#acme/app.git#$BRW_TEST_BARE#")
exec sh -c "$cmd"
`;
const GIT_BASE = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];

/** git を実行し、標準出力を前後の空白なしで返す。失敗は例外。環境は process.env（setup で隔離済み）。 */
const git = (cwd, ...args) => execFileSync("git", [...GIT_BASE, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** ファイルを書いて commit する。 */
const commitFile = (cwd, name, message) => {
  writeFileSync(join(cwd, name), `${message}\n`);
  git(cwd, "add", name);
  git(cwd, "commit", "-q", "-m", message);
};

/**
 * 一時の作業場所を作り、環境変数を隔離する。main と develop（main の先に d1。withDiff=false なら同じ commit）を origin（bare）へ push 済みにする。
 * other は別の clone（別環境）で、develop の先行を作るのに使う。cleanup で環境変数を戻し、一時ディレクトリを消す。
 */
const setup = ({ config = CONFIG, withDiff = true } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "brw-basepr-"));
  const home = join(root, "home");
  mkdirSync(home);
  const bare = join(root, "bare.git");
  const sshLog = join(root, "ssh.log");
  const sshPath = join(root, "fake-ssh.sh");
  writeFileSync(sshPath, FAKE_SSH, { mode: 0o755 });
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const restore = () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(root, { recursive: true, force: true });
  };
  Object.assign(process.env, {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: sshPath,
    GIT_SSH_VARIANT: "simple",
    BRW_TEST_BARE: bare,
    BRW_TEST_SSHLOG: sshLog,
    BRW_NO_GH: "1",
  });
  try {
    git(root, "init", "-q", "--bare", "-b", "main", bare);
    const w = join(root, "w");
    mkdirSync(w);
    git(w, "init", "-q", "-b", "main");
    git(w, "remote", "add", "origin", ORIGIN_URL);
    // 本文の置き場（.worktree/.brw/）は作業ツリーから除外する（未コミットの件数に含めない）
    writeFileSync(join(w, ".gitignore"), ".claude/\n.worktree/\n");
    writeFileSync(join(w, ".branch-release-workflow.json"), JSON.stringify(config));
    writeFileSync(join(w, "init.txt"), "init\n");
    git(w, "add", "-A");
    git(w, "commit", "-q", "-m", "init");
    git(w, "checkout", "-q", "-b", "develop");
    if (withDiff) commitFile(w, "d1.txt", "d1");
    git(w, "push", "-q", "origin", "main", "develop");
    const other = join(root, "other");
    git(root, "clone", "-q", "-b", "develop", ORIGIN_URL, other);
    // 準備の push の記録は数えない（試験の対象の操作だけを数える）
    writeFileSync(sshLog, "");
    // 既定の本文の置き場（絶対パス。本体の配置先の .worktree/.brw/ の配下）
    const bodyDir = join(w, ".worktree", ".brw");
    mkdirSync(bodyDir, { recursive: true });
    const body = join(bodyDir, "develop.md");
    writeFileSync(body, BODY);
    return { root, w, other, bare, sshLog, body, bodyDir, config: loadConfig(w).config, restore };
  } catch (e) {
    restore();
    throw e;
  }
};

const sshLines = (s) => readFileSync(s.sshLog, "utf8").split("\n").filter(Boolean);
const headOf = (s) => git(s.w, "rev-parse", "HEAD");
const refOf = (s, ref) => git(s.bare, "rev-parse", ref);

/** runBasePr を、出力を捕捉して呼ぶ。 */
const run = async (s, { args = [], gh, stdinIsTTY = false, config = s.config, branch = "develop", cwd = s.w }) => {
  const out = [];
  const err = [];
  const code = await runBasePr(args, { cwd, session: () => gh.session, io: { out: (x) => out.push(String(x)), err: (x) => err.push(String(x)) }, stdinIsTTY }, { config, branch });
  return { code, out: out.join("\n"), err: err.join("\n") };
};

/** タイトルと本文を指定する基本の引数。 */
const ARGS = (s, extra = []) => ["--title", TITLE, "--body-file", s.body, ...extra];

export const runBasePrChecks = async (eq) => {
  // a. 最新の分岐元から PR を作成し、再実行では再利用する（書き込みは作成の 1 件だけ）
  {
    const s = setup();
    try {
      const oid = refOf(s, "refs/heads/develop");
      const mainBefore = refOf(s, "refs/heads/main");
      const devBefore = refOf(s, "refs/heads/develop");
      const headBefore = headOf(s);
      const commitsBefore = git(s.w, "rev-list", "--count", "HEAD");
      const gh = github({
        routes: { [POST]: { status: 201, body: PR(oid) } },
        mutate: (t) => { t[LIST] = { status: 200, body: [PR(oid)] }; t[FILTERED] = { status: 200, body: [PR(oid)] }; },
      });
      const x = await run(s, { args: ARGS(s), gh });
      eq("brw-pr-handoff/7.3 a 最新の分岐元から PR を作成し、終了コード 0 と URL を表示する", [x.code, x.out.includes(`PR を作成しました: ${PR_URL}`)], [0, true]);
      eq("brw-pr-handoff/7.3 a 書き込みは作成の 1 件で、引数は head（分岐元）・base（保護）・タイトル・本文の実際の値", [gh.fake.writeCount, gh.fake.applied[0]?.body], [1, { title: TITLE, body: BODY, head: "develop", base: "main" }]);
      eq("brw-pr-handoff/7.3 a 作業の記録（.git/brw）・別コミット・push・片付けが起きない（HEAD と commit 数、bare の ref、分岐元の枝と worktree が残る）", [
        existsSync(join(s.w, ".git", "brw")), git(s.w, "rev-list", "--count", "HEAD") === commitsBefore, headOf(s) === headBefore,
        refOf(s, "refs/heads/main") === mainBefore, refOf(s, "refs/heads/develop") === devBefore,
        git(s.w, "branch", "--list", "develop") !== "", git(s.w, "worktree", "list").split("\n").length,
      ], [false, true, true, true, true, true, 1]);
      const again = await run(s, { args: ARGS(s), gh });
      eq("brw-pr-handoff/7.3 a 同じ状態での再実行は既存の PR を再利用し、重複して作らない", [again.code, again.out.includes(`PR を再利用しました: ${PR_URL}`), gh.fake.writeCount], [0, true, 1]);
    } finally { s.restore(); }
  }

  // b. リモートが先行: 取り込んでから PR を作る（ローカルの分岐元が進む）
  {
    const s = setup();
    try {
      commitFile(s.other, "d2.txt", "d2");
      git(s.other, "push", "-q", "origin", "develop");
      const oid = git(s.other, "rev-parse", "HEAD");
      const gh = github({ routes: { [POST]: { status: 201, body: PR(oid) } } });
      const x = await run(s, { args: ARGS(s), gh });
      eq("brw-pr-handoff/7.3 b リモートが先行: 取り込んでから PR を作り、ローカルの分岐元がリモートと一致する", [x.code, headOf(s) === oid, x.out.includes("合わせました"), x.out.includes(`PR を作成しました: ${PR_URL}`), gh.fake.writeCount], [0, true, true, true, 1]);
    } finally { s.restore(); }
  }

  // c. ローカルが先行（未 push の commit）: 止まり、書き込みは 0 件、HEAD は変わらない
  {
    const s = setup();
    try {
      commitFile(s.w, "local.txt", "local1");
      const headBefore = headOf(s);
      const gh = github({ routes: { [POST]: { status: 201, body: PR(headBefore) } } });
      const x = await run(s, { args: ARGS(s), gh });
      eq("brw-pr-handoff/7.3 c ローカル先行: 未 push があるため止まり、書き込み 0 件・HEAD 不変", [x.code, gh.fake.writeCount, headOf(s) === headBefore, x.err.includes("未 push")], [1, 0, true, true]);
    } finally { s.restore(); }
  }

  // d. 分岐（両方に commit）: 自動で取り込まず止まり、書き込み 0 件、HEAD は変わらない
  {
    const s = setup();
    try {
      commitFile(s.w, "local.txt", "local1");
      commitFile(s.other, "d3.txt", "d3");
      git(s.other, "push", "-q", "origin", "develop");
      const headBefore = headOf(s);
      const gh = github();
      const x = await run(s, { args: ARGS(s), gh });
      eq("brw-pr-handoff/7.3 d 分岐: 自動で取り込まず止まり、書き込み 0 件・HEAD 不変", [x.code, gh.fake.writeCount, headOf(s) === headBefore, x.err.includes("分岐")], [1, 0, true, true]);
    } finally { s.restore(); }
  }

  // e. 取り込む差が無い（develop が main と同じ）: PR を作らずに止まる
  {
    const s = setup({ withDiff: false });
    try {
      const gh = github();
      const x = await run(s, { args: ARGS(s), gh });
      eq("brw-pr-handoff/7.3 e 取り込む差が無ければ止まり、PR を作らない", [x.code, gh.fake.writeCount, x.err.includes("取り込む差がありません")], [1, 0, true]);
    } finally { s.restore(); }
  }

  // f. 既存の PR（同じ head・base）がある: 作成せず URL を報告し、再実行でも重複しない
  {
    const s = setup();
    try {
      const oid = refOf(s, "refs/heads/develop");
      const gh = github({ routes: { [LIST]: { status: 200, body: [PR(oid)] }, [FILTERED]: { status: 200, body: [PR(oid)] } } });
      const first = await run(s, { args: ARGS(s), gh });
      const second = await run(s, { args: ARGS(s), gh });
      eq("brw-pr-handoff/7.3 f 既存の PR を作成せず URL を報告し、再実行でも書き込みは 0 件", [first.code, first.out.includes(`PR を再利用しました: ${PR_URL}`), second.code, second.out.includes(`PR を再利用しました: ${PR_URL}`), gh.fake.writeCount], [0, true, 0, true, 0]);
    } finally { s.restore(); }
  }

  // g. 承認が必要な宣言（autoApprove.pullRequest が偽）: PR を作らず、--confirmed の全文を案内して終了コード 1
  {
    const s = setup({ config: { ...CONFIG, autoApprove: { pullRequest: false } } });
    try {
      const gh = github();
      const x = await run(s, { args: ARGS(s), gh });
      const line = `brw pr --title '${TITLE}' --body-file '${s.body}' --target 'main' --confirmed`;
      eq("brw-pr-handoff/7.3 g 承認が必要なら PR を作らず、--confirmed の全文を案内して終了コード 1", [x.code, gh.fake.writeCount, x.err.includes(line)], [1, 0, true]);
    } finally { s.restore(); }
  }

  // h. --confirmed は標準入力が端末でなければ何もせず拒否する（通信・fetch を含む）。端末なら承認済みとして作成する
  {
    const s = setup({ config: { ...CONFIG, autoApprove: { pullRequest: false } } });
    try {
      const oid = refOf(s, "refs/heads/develop");
      const gh = github({ routes: { [POST]: { status: 201, body: PR(oid) } } });
      const refused = await run(s, { args: [...ARGS(s), "--confirmed"], gh, stdinIsTTY: false });
      eq("brw-pr-handoff/7.3 h --confirmed が端末でなければ、通信・fetch の前に拒否して終了コード 1（書き込み 0・通信 0・ssh 0）", [refused.code, gh.fake.writeCount, gh.fake.requests.length, sshLines(s).length], [1, 0, 0, 0]);
      const allowed = await run(s, { args: [...ARGS(s), "--confirmed"], gh, stdinIsTTY: true });
      eq("brw-pr-handoff/7.3 h --confirmed が端末なら承認済みとして作成する（書き込み 1）", [allowed.code, allowed.out.includes(`PR を作成しました: ${PR_URL}`), gh.fake.writeCount], [0, true, 1]);
    } finally { s.restore(); }
  }

  // j. 未コミットの変更は件数を示して進めるが、commit しない
  {
    const s = setup();
    try {
      writeFileSync(join(s.w, "memo.txt"), "x\n");
      const headBefore = headOf(s);
      const oid = refOf(s, "refs/heads/develop");
      const gh = github({ routes: { [POST]: { status: 201, body: PR(oid) } } });
      const x = await run(s, { args: ARGS(s), gh });
      eq("brw-pr-handoff/7.3 j 未コミットの変更の件数を示して進め、commit せず、PR も作成する", [x.code, x.out.includes("未コミットの変更が 1 件あり、PR には含まれません"), headOf(s) === headBefore, git(s.w, "status", "--porcelain").includes("?? memo.txt"), gh.fake.writeCount], [0, true, true, true, 1]);
    } finally { s.restore(); }
  }

  // k. 本文ファイルが無い・未記入: 副作用（fetch・通信）の前に、brw pr-template を案内して止まる
  {
    const s = setup();
    try {
      const gh = github();
      rmSync(s.body);
      const missing = await run(s, { args: ["--title", TITLE], gh });
      eq("brw-pr-handoff/7.3 k 本文ファイルが無ければ brw pr-template を案内して止まる（fetch・通信 0）", [missing.code, missing.err.includes("brw pr-template"), sshLines(s).length, gh.fake.requests.length], [1, true, 0, 0]);
      writeFileSync(s.body, `${UNFILLED_MARK} -->\n${BODY}`);
      const unfilled = await run(s, { args: ARGS(s), gh });
      eq("brw-pr-handoff/7.3 k 本文が未記入なら止まる（fetch・通信 0）", [unfilled.code, unfilled.err.includes("未記入"), sshLines(s).length, gh.fake.requests.length], [1, true, 0, 0]);
    } finally { s.restore(); }
  }

  // l. 作成先が決められない（保護ブランチが複数で --target が無い）: 副作用の前に止まる
  {
    const s = setup({ config: { ...CONFIG, protectedBranches: ["main", "release"] } });
    try {
      const gh = github();
      const x = await run(s, { args: ARGS(s), gh });
      eq("brw-pr-handoff/7.3 l 作成先を決められなければ --target を案内して止まる（fetch・通信 0）", [x.code, x.err.includes("--target"), sshLines(s).length, gh.fake.requests.length], [1, true, 0, 0]);
    } finally { s.restore(); }
  }

  // m. 呼び出しの前提が違う・宣言が読めない・宣言の不備: いずれも副作用の前後で止まり、書き込みは 0 件
  {
    const s = setup();
    try {
      const gh = github();
      const otherBranch = await run(s, { args: ARGS(s), gh, branch: "main" });
      eq("brw-pr-handoff/7.3 m 指定の分岐元が現在のブランチと違えば止まる（通信・fetch 0）", [otherBranch.code, sshLines(s).length, gh.fake.requests.length], [1, 0, 0]);
      const noConfig = await run(s, { args: ARGS(s), gh, config: null });
      eq("brw-pr-handoff/7.3 m 宣言が読めなければ止まる（通信・fetch 0）", [noConfig.code, sshLines(s).length, gh.fake.requests.length], [1, 0, 0]);
      writeFileSync(join(s.w, ".branch-release-workflow.json"), "{");
      const oid = refOf(s, "refs/heads/develop");
      const broken = github({ routes: { [POST]: { status: 201, body: PR(oid) } } });
      const x = await run(s, { args: ARGS(s), gh: broken });
      eq("brw-pr-handoff/7.3 m 作業ツリーの宣言が不正なら共通判定が拒否し、書き込み 0 件で止まる", [x.code, broken.fake.writeCount, x.err.includes("宣言ファイル")], [1, 0, true]);
    } finally { s.restore(); }
  }

  // n. 使い方の誤り: --work は分岐元では使わない（終了コード 2）。未知のオプション・値の欠落も 2
  {
    const s = setup();
    try {
      const gh = github();
      const codes = [];
      for (const args of [["--work", "w-1"], ["--bogus"], ["--title"]]) codes.push((await run(s, { args, gh })).code);
      eq("brw-pr-handoff/7.3 n --work・未知のオプション・値の欠落は使い方の誤りとして終了コード 2（通信・fetch 0）", [codes, sshLines(s).length, gh.fake.requests.length], [[2, 2, 2], 0, 0]);
    } finally { s.restore(); }
  }

  // p. 本文の場所の検査（publish-cli の readBody と同じ規則）: 許可外は fetch・通信の前に止まり、HEAD と書き込みは変わらない
  {
    const s = setup();
    try {
      const outside = join(s.root, "outside.md");
      writeFileSync(outside, BODY);
      const link = join(s.bodyDir, "link.md");
      // 旧置き場の本文（実体は存在する。新しい置き場の外なので拒否される）
      mkdirSync(join(s.w, ".claude", "worktrees", ".brw"), { recursive: true });
      writeFileSync(join(s.w, ".claude", "worktrees", ".brw", "develop.md"), BODY);
      symlinkSync(outside, link);
      const dir = join(s.bodyDir, "sub");
      mkdirSync(dir);
      const cases = {
        "作業ディレクトリ外の絶対パス": outside,
        "..を含む相対パス": "../outside.md",
        "外部を指すシンボリックリンク": link,
        "ディレクトリ": dir,
        "存在しない": join(s.bodyDir, "none.md"),
        // 旧置き場（.claude/worktrees/.brw/）の配下の絶対パスは受け付けず、移し方を示して拒否する
        "旧置き場の本文": join(s.w, ".claude", "worktrees", ".brw", "develop.md"),
      };
      const gh = github();
      const headBefore = headOf(s);
      const results = [];
      for (const [, file] of Object.entries(cases)) {
        const x = await run(s, { args: ["--title", TITLE, "--body-file", file], gh });
        results.push([x.code, x.err.length > 0]);
      }
      eq("brw-pr-handoff/7.3 p 本文の場所が許可外（外の絶対パス・..・外部のシンボリックリンク・ディレクトリ・存在しない）なら止まる", results, Object.keys(cases).map(() => [1, true]));
      eq("brw-pr-handoff/7.3 p 拒否のとき fetch・通信・書き込みは 0 件、HEAD 不変", [sshLines(s).length, gh.fake.requests.length, gh.fake.writeCount, headOf(s) === headBefore], [0, 0, 0, true]);
    } finally { s.restore(); }
  }

  // p3. 本文置き場（.worktree/.brw）がリンクで旧置き場（.claude/worktrees/.brw）を指すとき、旧置き場の本文は読まない（要件 3.12）
  {
    const s = setup();
    try {
      const legacy = join(s.w, ".claude", "worktrees", ".brw");
      mkdirSync(legacy, { recursive: true });
      writeFileSync(join(legacy, "develop.md"), BODY);
      rmSync(s.bodyDir, { recursive: true, force: true });
      symlinkSync(legacy, s.bodyDir);
      const gh = github();
      const x = await run(s, { args: ["--title", TITLE, "--body-file", join(s.bodyDir, "develop.md")], gh });
      eq("brw-pr-handoff/3.12 本文置き場がリンクで旧置き場を指すとき、旧置き場の本文を読まず、通信の前に止まる", [x.code, x.err.length > 0, sshLines(s).length, gh.fake.requests.length, gh.fake.writeCount], [1, true, 0, 0, 0]);
    } finally { s.restore(); }
  }

  // p2. 作業ディレクトリ配下の相対パスは受け付ける（ignore された置き場の中）
  {
    const s = setup();
    try {
      const oid = refOf(s, "refs/heads/develop");
      const gh = github({ routes: { [POST]: { status: 201, body: PR(oid) } } });
      const rel = join(".worktree", ".brw", "rel.md");
      writeFileSync(join(s.w, rel), "相対パスの本文\n");
      const x = await run(s, { args: ["--title", TITLE, "--body-file", rel], gh });
      eq("brw-pr-handoff/7.3 p2 作業ディレクトリ配下の相対パスの本文を読み、PR を作成する", [x.code, gh.fake.writeCount, gh.fake.applied[0]?.body?.body], [0, 1, "相対パスの本文\n"]);
    } finally { s.restore(); }
  }

  // q. 送り先が origin 以外（branch.<分岐元>.pushRemote = up）: 取り込み・差・PR の head は up のリモートで決まる
  {
    const s = setup();
    try {
      const upBare = join(s.root, "up.git");
      git(s.root, "init", "-q", "--bare", "-b", "main", upBare);
      git(s.w, "remote", "add", "up", upBare);
      git(s.w, "push", "-q", "up", "main", "develop");
      git(s.w, "remote", "set-url", "--push", "up", ORIGIN_URL);
      git(s.w, "config", "branch.develop.pushRemote", "up");
      // up にだけ先行の commit を置く（origin には無い）
      const tmpc = join(s.root, "tmpc");
      git(s.root, "clone", "-q", upBare, tmpc);
      git(tmpc, "checkout", "-q", "-b", "develop", "origin/develop");
      commitFile(tmpc, "up-only.txt", "up-only");
      git(tmpc, "push", "-q", "origin", "develop");
      const upOid = git(upBare, "rev-parse", "refs/heads/develop");
      const originBefore = refOf(s, "refs/heads/develop");
      const gh = github({ routes: { [POST]: { status: 201, body: PR(upOid) } } });
      const x = await run(s, { args: ARGS(s), gh });
      eq("brw-pr-handoff/7.3 q pushRemote が origin 以外のとき、そのリモートから取り込み、head の OID はそのリモートの値で PR を作る", [x.code, headOf(s) === upOid, gh.fake.writeCount, gh.fake.applied[0]?.body?.head], [0, true, 1, "develop"]);
      eq("brw-pr-handoff/7.3 q origin は取得・push されない（ssh 0、origin の ref 不変）", [sshLines(s).length, refOf(s, "refs/heads/develop") === originBefore], [0, true]);
    } finally { s.restore(); }
  }

  // r. PR 作成の応答の head の OID が期待値と違う: 作成済みの URL を案内し、成功にしない（終了コード 1）。再実行でも重複しない
  {
    const s = setup();
    try {
      const other = "b".repeat(40);
      const gh = github({
        routes: { [POST]: { status: 201, body: PR(other) } },
        mutate: (t) => { t[LIST] = { status: 200, body: [PR(other)] }; t[FILTERED] = { status: 200, body: [PR(other)] }; },
      });
      const x = await run(s, { args: ARGS(s), gh });
      eq("brw-pr-handoff/7.3 r 作成の応答の head の OID が違えば、成功にせず終了コード 1 で作成済みの URL を案内する", [x.code, x.out.includes("PR を作成しました"), x.err.includes(PR_URL), x.err.includes("成功とは扱いません"), gh.fake.writeCount], [1, false, true, true, 1]);
      const again = await run(s, { args: ARGS(s), gh });
      eq("brw-pr-handoff/7.3 r 食い違いの後の再実行は PR を重複して作らない（書き込みは増えない）", [again.code, gh.fake.writeCount], [1, 1]);
    } finally { s.restore(); }
  }
};
