// 完了公開の CLI（brw-enforcement 7.2）の契約テスト。selftest.mjs から呼ばれる。
// 作業の開始・再開・禁止・中断は brw.mjs を実際に実行して確かめる（GitHub には触れない）。
// 準備・計画・公開は CLI の関数を呼び、GitHub の応答だけを fake-github.mjs で注入する（通信しない）。
// 遠隔は bare remote（GIT_SSH_COMMAND の試験用スクリプトで差し替え）を使う。
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as publish from "../scripts/publish.mjs";
import { createGitHubSession } from "../scripts/github-client.mjs";
import { handleHook } from "../scripts/agent-hooks.mjs";
import { createFakeGitHub } from "./support/fake-github.mjs";
import { gitOut, mkRepoWithRemote } from "./support/git-fixture.mjs";
import { hookInput } from "./support/hook-fixtures.mjs";

// scripts/publish-cli.mjs は 7.2 で追加する。未実装の間も失敗として数えられるよう、名前が無くても落ちない形にする
const cli = await import("../scripts/publish-cli.mjs").catch(() => ({}));
const BRW = join(dirname(fileURLToPath(import.meta.url)), "../scripts/brw.mjs");
const WORK_ID = /^w-[a-z0-9]+-[0-9a-f]{8}$/;
const CONFIG = { workBranches: ["dev/*"], protectedBranches: ["main"], baseBranch: "develop" };
const GH_SSH = "git@github.com:acme/app.git";
const REPO = { id: 4242, owner: "acme", name: "app" };
const HOST = "github.com";
const TOKEN = "test-token-cli-xyz";
const DONE = "依頼の完了条件を満たした";
const VERIFY = "npm test が成功";
const BODY_MARK = "本文の目印-7f3a";

// 試験用 ssh 代わり。対象の GitHub パスを BRW_TEST_BARE（bare remote）へ置き換えて実行する
const FAKE_SSH = `#!/bin/sh
cmd=$(printf '%s' "$2" | sed "s#acme/app.git#$BRW_TEST_BARE#")
exec sh -c "$cmd"
`;

// fake-github の経路キー（クエリまで一致させる）
const REPO_KEY = "GET /repos/acme/app";
const LIST = "GET /repos/acme/app/pulls?state=open&head=acme:dev/foo&per_page=100";
const FILTERED = "GET /repos/acme/app/pulls?state=open&head=acme:dev/foo&base=main&per_page=100";
const POST = "POST /repos/acme/app/pulls";

/** 応答の PR（head の OID は指定の値）。 */
const PR = (head, over = {}) => ({
  number: 7,
  html_url: "https://github.com/acme/app/pull/7",
  state: "open",
  draft: false,
  base: { ref: "main", repo: { id: 4242, full_name: "acme/app" } },
  head: { ref: "dev/foo", sha: head, repo: { id: 4242, full_name: "acme/app" } },
  ...over,
});

/** GitHub を使わない呼び出しで、誤って通信しようとしたら失敗させる。 */
const noGithub = () => { throw new Error("テストで GitHub に接続しようとした"); };

/** 実際の GitHub クライアントに、偽の応答層を transport として注入する。 */
const github = ({ scenario: sc = "success", routes = {}, mutate } = {}) => {
  const table = {
    [REPO_KEY]: { status: 200, body: { id: 4242, full_name: "acme/app" } },
    [LIST]: { status: 200, body: [] },
    [FILTERED]: { status: 200, body: [] },
    ...routes,
  };
  const fake = createFakeGitHub({ scenario: sc, routes: table });
  const transport = async ({ method, path, body, host }) => {
    const before = fake.applied.length;
    try {
      return await fake.request(method, path, body, { host });
    } finally {
      if (mutate && fake.applied.length > before) mutate(table);
    }
  };
  const session = createGitHubSession({ host: HOST, token: TOKEN, transport });
  return { session, fake };
};

/** brw.mjs を実際に実行する（環境変数は呼び出し元の設定をそのまま引き継ぐ）。 */
const brwRun = (cwd, args) => spawnSync("node", [BRW, ...args], { cwd, encoding: "utf8", env: process.env });

/** 宣言つきの一時リポジトリを作り、push 先を GitHub の形の URL にする。 */
const setup = ({ recorded = "main", config = CONFIG } = {}) => {
  const r = mkRepoWithRemote({ branch: "dev/foo", config });
  gitOut(r.dir, "remote", "set-url", "origin", GH_SSH);
  if (recorded) gitOut(r.dir, "config", "branch.dev/foo.brwBase", recorded);
  process.env.BRW_TEST_BARE = r.remote;
  return r;
};
const withRepo = async (opts, fn) => {
  const r = setup(opts);
  try {
    return await fn(r);
  } finally {
    r.cleanup();
  }
};

/** CLI の関数を呼び、終了コードと標準出力・標準エラーを集める。session は GitHub 応答（github() の結果）。 */
const call = async (fn, dir, args, gh, extra = {}) => {
  const out = [];
  const err = [];
  if (!fn) return { code: "未実装", out: "", err: "未実装" };
  // stdinIsTTY は既定で偽（エージェントの実行に相当）。利用者の端末での実行は extra.tty で模擬する
  const code = await fn(args, { cwd: dir, session: gh ? () => gh.session : noGithub, stdinIsTTY: extra.tty === true, io: { out: (s) => out.push(s), err: (s) => err.push(s) } });
  return { code, out: out.join("\n"), err: err.join("\n") };
};
const work = (dir, args, gh) => call(cli.runWork, dir, args, gh);
const publishCmd = (dir, args, gh, extra) => call(cli.runPublish, dir, args, gh, extra);
/** 利用者が自分の端末で実行した相当（TTY）。 */
const TTY = { tty: true };

const workOf = (d, id) => publish.readWork(d, id).work ?? {};
const stateText = (d) => (existsSync(publish.stateFileOf(d)) ? readFileSync(publish.stateFileOf(d), "utf8") : "");
/** 作業を開始し（brw.mjs の work start）、作業 ID を返す。 */
const startId = (dir) => brwRun(dir, ["work", "start"]).stdout.trim();
/** 準備まで済ませて計画 ID を返す。 */
const readyAndPlan = async (dir, id, gh) => {
  const rd = await work(dir, ["ready", "--work", id, "--completion", DONE, "--verification", VERIFY], gh);
  if (rd.code !== 0) return undefined; // 準備に失敗したら計画は無い（各検査が失敗として数える）
  const pl = await work(dir, ["plan", "--work", id], gh);
  return pl.code === 0 ? pl.out.match(/計画 ID: (p-[0-9a-f]+)/)?.[1] : undefined;
};

export const runPublishCliChecks = async (eq) => {
  // 試験用 ssh を環境変数に設定する（終了時に元へ戻す）
  const sshDir = mkdtempSync(join(tmpdir(), "brw-ssh-cli-"));
  const sshPath = join(sshDir, "fake-ssh.sh");
  writeFileSync(sshPath, FAKE_SSH, { mode: 0o755 });
  const saved = { cmd: process.env.GIT_SSH_COMMAND, variant: process.env.GIT_SSH_VARIANT, bare: process.env.BRW_TEST_BARE };
  process.env.GIT_SSH_COMMAND = sshPath;
  process.env.GIT_SSH_VARIANT = "simple";

  try {
    // ---- 作業の開始・再開・禁止・中断（brw.mjs の実行。GitHub には触れない） ----
    {
      const r = mkRepoWithRemote({ branch: "dev/foo", config: CONFIG });
      const a = brwRun(r.dir, ["work", "start"]);
      const id = a.stdout.trim();
      eq("enforcement/7.2 work start は作業 ID を 1 つだけ標準出力に出す", [a.status, a.stdout.trim().split("\n").length, WORK_ID.test(id)], [0, 1, true]);
      eq("enforcement/7.2 start は作業を inProgress で記録し、セッションは関連付けない（PostToolUse が後で行う）", [workOf(r.dir, id)?.status, workOf(r.dir, id)?.sessionId ?? null], ["inProgress", null]);
      const b = brwRun(r.dir, ["work", "start"]);
      const id2 = b.stdout.trim();
      eq("enforcement/7.2 2 件目の start は別の作業 ID を発行し、1 件目を中断扱いにする", [b.status, id2 !== id, workOf(r.dir, id)?.pausedReason !== undefined, publish.currentWork(r.dir).work?.workId], [0, true, true, id2]);
      eq("enforcement/7.2 保護ブランチでは work start を拒否し、作業を作らない", [brwRun(mkRepoWithRemote({ branch: "main", config: CONFIG }).dir, ["work", "start"]).status], [1]);
      // brw-pr-handoff 6.2: 分岐元からの work start の拒否は、分岐元から保護ブランチへの PR を brw pr で作れることを示す
      eq("brw-pr-handoff/6.2 分岐元での work start の拒否は、分岐元→保護ブランチの PR を brw pr で作れることを示す", (() => { const x = brwRun(mkRepoWithRemote({ branch: "develop", config: CONFIG }).dir, ["work", "start"]); return [x.status, x.stderr.includes("恒常的な分岐元のため、作業を始めません"), x.stderr.includes("分岐元から保護ブランチへの PR は brw pr で作れます")]; })(), [1, true, true]);
      eq("brw-pr-handoff/6.2 保護ブランチでの work start の拒否には、brw pr の案内を足さない", (() => { const x = brwRun(mkRepoWithRemote({ branch: "main", config: CONFIG }).dir, ["work", "start"]); return x.stderr.includes("brw pr"); })(), false);
      eq("enforcement/7.2 work の不明なオプションは使い方の誤りとして終了コード 2", [brwRun(r.dir, ["work", "start", "--bogus"]).status, brwRun(r.dir, ["work", "unknown"]).status], [2, 2]);

      publish.attachSession(r.dir, id2, "claude-P");
      const rs = brwRun(r.dir, ["work", "restrict", "--work", id2, "--no-push"]);
      eq("enforcement/7.2 work restrict --no-push で push の禁止を記録する", [rs.status, workOf(r.dir, id2)?.restrictions], [0, { noPush: true, noPr: false }]);
      const rs2 = brwRun(r.dir, ["work", "restrict", "--work", id2, "--no-pr"]);
      eq("enforcement/7.2 work restrict --no-pr を追加し、禁止は追加だけで外れない", [rs2.status, workOf(r.dir, id2)?.restrictions], [0, { noPush: true, noPr: true }]);
      eq("enforcement/7.2 禁止の指定が無い restrict は終了コード 2", brwRun(r.dir, ["work", "restrict", "--work", id2]).status, 2);

      const beforeSession = workOf(r.dir, id2)?.sessionId;
      const p = brwRun(r.dir, ["pause", "--work", id2, "--reason", "依頼の変更"]);
      eq("enforcement/7.2 pause は関連付け済みの作業を中断し、セッションの関連付けを解除する", [beforeSession, p.status, workOf(r.dir, id2)?.pausedReason !== undefined, workOf(r.dir, id2)?.sessionId ?? null], ["claude-P", 0, true, null]);
      eq("enforcement/7.2 pause は理由が無ければ拒否する", brwRun(r.dir, ["pause", "--work", id2]).status !== 0, true);
      const rr = brwRun(r.dir, ["work", "resume", "--work", id2]);
      eq("enforcement/7.2 work resume は作業 ID を 1 つだけ出し、中断を解く", [rr.status, rr.stdout.trim(), workOf(r.dir, id2)?.pausedReason ?? null], [0, id2, null]);
      eq("enforcement/7.2 中断後も禁止は残る（再開で外れない）", workOf(r.dir, id2)?.restrictions, { noPush: true, noPr: true });
      r.cleanup();
    }

    // ---- 関連付けの上書き（6.2 申し送り (a)）: 開始は既存の関連付けを上書きしない ----
    {
      await withRepo({}, async (r) => {
        const id = startId(r.dir);
        publish.attachSession(r.dir, id, "claude-A");
        const other = publish.attachSession(r.dir, id, "claude-B", { onlyIfUnset: true });
        eq("enforcement/7.2 関連付け済みの作業は onlyIfUnset で別セッションに上書きしない", [other.ok, other.error?.kind, workOf(r.dir, id).sessionId], [false, "conflict", "claude-A"]);
        const again = publish.attachSession(r.dir, id, "claude-A", { onlyIfUnset: true });
        eq("enforcement/7.2 同じセッションの再関連付けは許す", [again.ok, workOf(r.dir, id).sessionId], [true, "claude-A"]);
        const resumed = publish.attachSession(r.dir, id, "claude-B");
        eq("enforcement/7.2 再開（上書き可）の関連付けは従来どおり置き換える", [resumed.ok, workOf(r.dir, id).sessionId], [true, "claude-B"]);
      });
    }

    // ---- フック経由の開始: 別のセッションが関連付け済みの作業を、開始の出力で上書きしない（6.2 申し送り (a)） ----
    await withRepo({}, async (r) => {
      const id = startId(r.dir);
      publish.attachSession(r.dir, id, "claude-s1");
      const ev = hookInput("claude", "PostToolUse", { cwd: r.dir, command: `node ${BRW} work start`, sessionId: "claude-s2" });
      ev.tool_response = { exit_code: 0, stdout: `${id}\n` };
      handleHook("claude", "PostToolUse", ev);
      eq("enforcement/7.2 開始の出力を見たフックは、別セッションの関連付けを上書きしない", workOf(r.dir, id).sessionId, "claude-s1");
    });

    // ---- 途中の push・調査だけでは公開済みにならない（GitHub には触れない） ----
    await withRepo({ recorded: "dev/parent" }, async (r) => {
      const id = startId(r.dir);
      gitOut(r.dir, "push", "-q", "origin", "dev/foo");
      const pl = await work(r.dir, ["plan", "--work", id]);
      const pub = await publishCmd(r.dir, ["--work", id, "--plan", "p-none"]);
      eq("enforcement/7.2 準備していない作業は計画も公開もせず、途中の push では公開済みにならない", [pl.code, pub.code, workOf(r.dir, id).status, workOf(r.dir, id).results ?? {}], [1, 1, "inProgress", {}]);
    });

    // ---- 準備（ready）: 開発間は push で完了する取り込み先、保護対象は PR を伴う公開 ----
    await withRepo({ recorded: "dev/parent" }, async (r) => {
      const id = startId(r.dir);
      const gh = github();
      const x = await work(r.dir, ["ready", "--work", id, "--completion", DONE, "--verification", VERIFY], gh);
      eq("enforcement/7.2 開発ブランチへの取り込みは push の公開として準備し、次の手順を案内する", [x.code, x.out.includes("brw work plan"), workOf(r.dir, id).status, workOf(r.dir, id).ready?.publication], [0, true, "ready", "push"]);
      eq("enforcement/7.2 準備では GitHub の対象の照合だけを行い、書き込みはしない", gh.fake.writeCount, 0);
    });
    await withRepo({}, async (r) => {
      const id = startId(r.dir);
      const gh = github();
      const x = await work(r.dir, ["ready", "--work", id, "--completion", DONE, "--verification", VERIFY], gh);
      eq("enforcement/7.2 保護対象への取り込みは PR を伴う公開として準備する", [x.code, workOf(r.dir, id).ready?.publication, workOf(r.dir, id).ready?.integration?.ref], [0, "pr", "main"]);
    });
    await withRepo({}, async (r) => {
      const id = startId(r.dir);
      writeFileSync(join(r.dir, "untracked.txt"), "x");
      const x = await work(r.dir, ["ready", "--work", id, "--completion", DONE, "--verification", VERIFY], github());
      eq("enforcement/7.2 未コミットの変更があれば準備せず、失敗を返す", [x.code, workOf(r.dir, id).status], [1, "inProgress"]);
    });
    await withRepo({}, async (r) => {
      const id = startId(r.dir);
      const x = await work(r.dir, ["ready", "--work", id, "--completion", DONE, "--verification", VERIFY, "--failed"], github());
      eq("enforcement/7.2 検証に失敗したと申告した作業は準備しない", [x.code, workOf(r.dir, id).status], [1, "inProgress"]);
    });
    await withRepo({}, async (r) => {
      const id = startId(r.dir);
      const x = await work(r.dir, ["ready", "--work", id, "--completion", DONE], github());
      eq("enforcement/7.2 検証の要約が無い ready は使い方の誤りとして終了コード 2", x.code, 2);
    });
    await withRepo({}, async (r) => {
      const id = startId(r.dir);
      const gh = github({ routes: { [LIST]: { status: 200, body: [PR("0".repeat(40), { base: { ref: "develop", repo: { id: 4242, full_name: "acme/app" } } })] } } });
      const x = await work(r.dir, ["ready", "--work", id, "--completion", DONE, "--verification", VERIFY], gh);
      eq("enforcement/7.2 同じ作業の既存 PR が別の取り込み先なら準備せず、取り込み先の明示を求める", [x.code, x.err.includes("--target"), workOf(r.dir, id).status], [1, true, "inProgress"]);
    });
    await withRepo({}, async (r) => {
      const id = startId(r.dir);
      const x = await work(r.dir, ["ready", "--work", id, "--completion", DONE, "--verification", VERIFY], github({ scenario: "auth" }));
      eq("enforcement/7.2 GitHub の認証に失敗したら準備せず、書き込みもしない", [x.code, workOf(r.dir, id).status], [1, "inProgress"]);
    });

    // ---- 計画（plan）: 許可された書き込みだけを計画に入れる ----
    await withRepo({}, async (r) => {
      const id = startId(r.dir);
      const gh = github();
      const pid = await readyAndPlan(r.dir, id, gh);
      const w = workOf(r.dir, id);
      eq("enforcement/7.2 保護対象の計画は push と PR 作成を含み、計画 ID を出力する", [typeof pid, w.plan?.writes?.map((x) => x.operation)], ["string", ["push", "pr"]]);
      eq("enforcement/7.2 計画の発行では書き込みをしない", gh.fake.writeCount, 0);
    });
    await withRepo({ recorded: "dev/parent" }, async (r) => {
      const id = startId(r.dir);
      const pid = await readyAndPlan(r.dir, id, github());
      eq("enforcement/7.2 開発ブランチへの計画は push だけを含み、PR を含まない", [typeof pid, workOf(r.dir, id).plan?.writes?.map((x) => x.operation)], ["string", ["push"]]);
    });
    await withRepo({}, async (r) => {
      const id = startId(r.dir);
      const gh = github();
      await readyAndPlan(r.dir, id, gh);
      publish.setRestrictions(r.dir, id, { noPr: true });
      const pl = await work(r.dir, ["plan", "--work", id], gh);
      eq("enforcement/7.2 禁止を追加したあとの計画は禁止された PR を含まない（push だけ）", [pl.code, workOf(r.dir, id).plan?.writes?.map((x) => x.operation)], [0, ["push"]]);
    });

    // ---- 公開（publish）: 保護対象は push のあと PR を作成し、URL と squash の案内を返す ----
    await withRepo({}, async (r) => {
      const id = startId(r.dir);
      publish.attachSession(r.dir, id, "claude-s1");
      const gh = github({ routes: { [POST]: { status: 201, body: PR(gitOut(r.dir, "rev-parse", "HEAD")) } } });
      const pid = await readyAndPlan(r.dir, id, gh);
      const noTitle = await publishCmd(r.dir, ["--work", id, "--plan", pid], gh);
      eq("enforcement/7.2 新規 PR のタイトルが無ければ、書き込まずに次の操作（タイトルの指定）を出力する", [noTitle.code, noTitle.out.includes("--title") || noTitle.err.includes("--title"), gh.fake.writeCount, workOf(r.dir, id).status, gitOut(r.dir, "ls-remote", "origin", "refs/heads/dev/foo").length > 0], [1, true, 0, "pushed", true]);
      writeFileSync(join(r.dir, ".git", "brw-pr-body.md"), `${BODY_MARK}\n`);
      const x = await publishCmd(r.dir, ["--work", id, "--plan", pid, "--title", "変更の要約", "--body-file", ".git/brw-pr-body.md"], gh);
      eq("enforcement/7.2 保護対象の公開は PR の URL と GitHub 上で squash する案内を返す", [x.code, x.out.includes("https://github.com/acme/app/pull/7"), x.out.includes("squash")], [0, true, true]);
      eq("enforcement/7.2 PR は計画どおり 1 件だけ作成し、タイトルと本文は指定の値", [gh.fake.writeCount, gh.fake.applied[0]?.body], [1, { title: "変更の要約", body: `${BODY_MARK}\n`, head: "dev/foo", base: "main" }]);
      eq("enforcement/7.2 公開完了で作業を published にし、セッションの関連付けを解除する", [workOf(r.dir, id).status, workOf(r.dir, id).sessionId ?? null, publish.currentWork(r.dir).work], ["published", null, null]);
      const text = stateText(r.dir);
      eq("enforcement/7.2 状態ファイルと出力に資格情報・本文を含めない", [text.includes(TOKEN), text.includes(BODY_MARK), `${x.out}${x.err}`.includes(TOKEN), `${x.out}${x.err}`.includes(BODY_MARK)], [false, false, false, false]);
    });
    await withRepo({ recorded: "dev/parent" }, async (r) => {
      const id = startId(r.dir);
      const pid = await readyAndPlan(r.dir, id, github());
      const x = await publishCmd(r.dir, ["--work", id, "--plan", pid]);
      eq("enforcement/7.2 開発ブランチへの公開は push で完了し、PR を作らず、ローカル取り込みを案内する", [x.code, x.out.includes("brw merge dev/foo"), workOf(r.dir, id).status, workOf(r.dir, id).results?.pr ?? null], [0, true, "published", null]);
    });
    await withRepo({}, async (r) => {
      const id = startId(r.dir);
      const gh = github({ routes: { [POST]: { status: 201, body: PR(gitOut(r.dir, "rev-parse", "HEAD")) } } });
      const pid = await readyAndPlan(r.dir, id, gh);
      const body = join(r.dir, "outside.md");
      writeFileSync(body, "x");
      const x = await publishCmd(r.dir, ["--work", id, "--plan", pid, "--title", "変更", "--body-file", "/etc/hostname"], gh);
      eq("enforcement/7.2 作業ディレクトリの外の本文ファイルは拒否し、push もしない", [x.code, gh.fake.writeCount, workOf(r.dir, id).status], [2, 0, "ready"]);
      rmSync(body, { force: true });
    });
    await withRepo({ recorded: "dev/parent" }, async (r) => {
      const id = startId(r.dir);
      const gh = github();
      await readyAndPlan(r.dir, id, gh);
      publish.setRestrictions(r.dir, id, { noPush: true });
      // 禁止を追加したら計画は失効するので、取り直してから公開する
      const pid = (await work(r.dir, ["plan", "--work", id], gh)).out.match(/計画 ID: (p-[0-9a-f]+)/)?.[1];
      const x = await publishCmd(r.dir, ["--work", id, "--plan", pid]);
      eq("enforcement/7.2 push が禁止されていれば公開せず、禁止を結果として報告する", [x.code, workOf(r.dir, id).results?.push?.outcome, workOf(r.dir, id).status], [1, "prohibited", "ready"]);
    });
    await withRepo({}, async (r) => {
      const id = startId(r.dir);
      const gh = github({ routes: { [POST]: { status: 201, body: PR(gitOut(r.dir, "rev-parse", "HEAD")) } } });
      const pid = await readyAndPlan(r.dir, id, gh);
      publish.setRestrictions(r.dir, id, { noPr: true });
      // 禁止を追加したら計画は失効するので、取り直してから公開する
      const pid2 = (await work(r.dir, ["plan", "--work", id], gh)).out.match(/計画 ID: (p-[0-9a-f]+)/)?.[1];
      const x = await publishCmd(r.dir, ["--work", id, "--plan", pid2, "--title", "変更"], gh);
      eq("enforcement/7.2 PR 作成だけが禁止なら push は完了し、PR は作らず、公開済みにしない", [x.code, gh.fake.writeCount, workOf(r.dir, id).results?.push?.outcome, workOf(r.dir, id).results?.pr?.outcome, workOf(r.dir, id).status], [1, 0, "success", "prohibited", "pushed"]);
    });
    await withRepo({ config: { ...CONFIG, autoApprove: { pullRequest: false } } }, async (r) => {
      const id = startId(r.dir);
      const gh = github({ routes: { [POST]: { status: 201, body: PR(gitOut(r.dir, "rev-parse", "HEAD")) } } });
      const pid = await readyAndPlan(r.dir, id, gh);
      const x = await publishCmd(r.dir, ["--work", id, "--plan", pid, "--title", "変更"], gh);
      eq("enforcement/7.2 PR の確認省略が無効なら作成せず、個別の確認（--confirmed）を案内する", [x.code, x.out.includes("--confirmed") || x.err.includes("--confirmed"), gh.fake.writeCount, workOf(r.dir, id).status], [1, true, 0, "pushed"]);
      const y = await publishCmd(r.dir, ["--work", id, "--plan", pid, "--title", "変更", "--confirmed"], gh, TTY);
      eq("enforcement/7.2 利用者の確認を経た実行（--confirmed）で作成して公開する", [y.code, gh.fake.writeCount, workOf(r.dir, id).status], [0, 1, "published"]);
    });
    await withRepo({ config: { ...CONFIG, autoApprove: { push: false } } }, async (r) => {
      const id = startId(r.dir);
      const gh = github({ routes: { [POST]: { status: 201, body: PR(gitOut(r.dir, "rev-parse", "HEAD")) } } });
      const pid = await readyAndPlan(r.dir, id, gh);
      const x = await publishCmd(r.dir, ["--work", id, "--plan", pid, "--title", "変更"], gh);
      eq("enforcement/7.2 push の確認省略が無効なら push せず、個別の確認を案内する", [x.code, x.out.includes("--confirmed") || x.err.includes("--confirmed"), gitOut(r.dir, "ls-remote", "origin", "refs/heads/dev/foo").includes("dev/foo"), gh.fake.writeCount], [1, true, false, 0]);
    });
    await withRepo({}, async (r) => {
      const id = startId(r.dir);
      const gh = github({ routes: { [POST]: { status: 201, body: PR(gitOut(r.dir, "rev-parse", "HEAD")) } } });
      const pid = await readyAndPlan(r.dir, id, gh);
      const x = await publishCmd(r.dir, ["--work", id, "--plan", pid, "--title", "変更"], github({ scenario: "permission" }));
      eq("enforcement/7.2 PR 作成の権限が無ければ失敗を返し、push の結果は残す（再試行は同じ計画で行う）", [x.code, workOf(r.dir, id).results?.push?.outcome, workOf(r.dir, id).status], [1, "success", "pushed"]);
      const y = await publishCmd(r.dir, ["--work", id, "--plan", pid, "--title", "変更"], gh);
      eq("enforcement/7.2 再試行では既存 PR を重複させず、同じ計画で完了する", [y.code, gh.fake.writeCount, workOf(r.dir, id).status], [0, 1, "published"]);
    });

    // ---- --confirmed は利用者の端末（TTY）からだけ有効。エージェント（非対話）の --confirmed は承認にならない（7.2 差し戻し対応） ----
    await withRepo({ config: { ...CONFIG, autoApprove: { push: false } } }, async (r) => {
      const id = startId(r.dir);
      const gh = github({ routes: { [POST]: { status: 201, body: PR(gitOut(r.dir, "rev-parse", "HEAD")) } } });
      const pid = await readyAndPlan(r.dir, id, gh);
      const x = await publishCmd(r.dir, ["--work", id, "--plan", pid, "--title", "変更", "--confirmed"], gh);
      const remoteHas = gitOut(r.dir, "ls-remote", "origin", "refs/heads/dev/foo").length > 0;
      eq("enforcement/7.2 非対話の --confirmed は承認にならず、push も PR も行わず、遠隔に ref を作らない", [x.code, remoteHas, gh.fake.writeCount, workOf(r.dir, id).status, workOf(r.dir, id).results?.push ?? null], [1, false, 0, "ready", null]);
      eq("enforcement/7.2 非対話の --confirmed は、利用者が自分の端末で実行する全文を案内する", [x.err.includes("自分の端末"), x.err.includes(`brw publish --work ${id} --plan ${pid}`), x.err.includes("--confirmed")], [true, true, true]);
    });
    await withRepo({ recorded: "dev/parent", config: { ...CONFIG, autoApprove: { push: false } } }, async (r) => {
      const id = startId(r.dir);
      const pid = await readyAndPlan(r.dir, id, github());
      const x = await publishCmd(r.dir, ["--work", id, "--plan", pid, "--confirmed"]);
      eq("enforcement/7.2 非対話の --confirmed（開発間）でも push せず、公開済みにしない", [x.code, gitOut(r.dir, "ls-remote", "origin", "refs/heads/dev/foo").length > 0, workOf(r.dir, id).status], [1, false, "ready"]);
    });
    await withRepo({ recorded: "dev/parent", config: { ...CONFIG, autoApprove: { push: false } } }, async (r) => {
      const id = startId(r.dir);
      const pid = await readyAndPlan(r.dir, id, github());
      const x = await publishCmd(r.dir, ["--work", id, "--plan", pid], undefined, TTY.tty ? { tty: false } : undefined);
      eq("enforcement/7.2 通常の承認が必要な push は、--confirmed が無ければ push しない", [x.code, gitOut(r.dir, "ls-remote", "origin", "refs/heads/dev/foo").length > 0], [1, false]);
    });
    await withRepo({ recorded: "dev/parent", config: { ...CONFIG, autoApprove: { push: false } } }, async (r) => {
      const id = startId(r.dir);
      const pid = await readyAndPlan(r.dir, id, github());
      const x = await publishCmd(r.dir, ["--work", id, "--plan", pid, "--confirmed"], undefined, TTY);
      eq("enforcement/7.2 利用者の端末（TTY）の --confirmed は従来どおり、通常の承認を経た push を実行する", [x.code, gitOut(r.dir, "ls-remote", "origin", "refs/heads/dev/foo").length > 0, workOf(r.dir, id).status], [0, true, "published"]);
    });
    await withRepo({ recorded: "dev/parent" }, async (r) => {
      const id = startId(r.dir);
      const gh = github();
      const pid = await readyAndPlan(r.dir, id, gh);
      publish.setRestrictions(r.dir, id, { noPush: true });
      const pid2 = (await work(r.dir, ["plan", "--work", id], gh)).out.match(/計画 ID: (p-[0-9a-f]+)/)?.[1];
      const x = await publishCmd(r.dir, ["--work", id, "--plan", pid2, "--confirmed"], undefined, TTY);
      eq("enforcement/7.2 push の禁止は利用者の端末の --confirmed でも迂回できない", [x.code, gitOut(r.dir, "ls-remote", "origin", "refs/heads/dev/foo").length > 0, workOf(r.dir, id).results?.push?.outcome, workOf(r.dir, id).status], [1, false, "prohibited", "ready"]);
      void pid;
    });
    await withRepo({}, async (r) => {
      const id = startId(r.dir);
      const gh = github({ routes: { [POST]: { status: 201, body: PR(gitOut(r.dir, "rev-parse", "HEAD")) } } });
      const pid = await readyAndPlan(r.dir, id, gh);
      publish.setRestrictions(r.dir, id, { noPr: true });
      const pid2 = (await work(r.dir, ["plan", "--work", id], gh)).out.match(/計画 ID: (p-[0-9a-f]+)/)?.[1];
      const x = await publishCmd(r.dir, ["--work", id, "--plan", pid2, "--title", "変更", "--confirmed"], gh, TTY);
      eq("enforcement/7.2 PR 作成の禁止は利用者の端末の --confirmed でも迂回できず、PR を作らない", [x.code, gh.fake.writeCount, workOf(r.dir, id).results?.pr?.outcome, workOf(r.dir, id).status], [1, 0, "prohibited", "pushed"]);
      void pid;
    });

    // ---- 公開完了時のセッション解除（setStatus の published） ----
    await withRepo({ recorded: "dev/parent" }, async (r) => {
      const id = startId(r.dir);
      publish.attachSession(r.dir, id, "claude-S");
      await readyAndPlan(r.dir, id, github());
      publish.setStatus(r.dir, id, "pushed");
      const done = publish.setStatus(r.dir, id, "published");
      eq("enforcement/7.2 状態を published にすると、セッションの関連付けを解除する", [done.ok, workOf(r.dir, id).status, workOf(r.dir, id).sessionId ?? null], [true, "published", null]);
    });

    // ---- 確認省略の判定（6.1）と公開の引数の形が一致する（信頼済み publish は計画の書き込みに限る） ----
    await withRepo({}, async (r) => {
      const id = startId(r.dir);
      const pid = await readyAndPlan(r.dir, id, github());
      const cmd = `node ${BRW} publish --work ${id} --plan ${pid} --title 変更`;
      const allowed = handleHook("claude", "PreToolUse", hookInput("claude", "PreToolUse", { cwd: r.dir, command: cmd, sessionId: "s1" }));
      eq("enforcement/7.2 計画どおりの publish（--title 付き）は確認省略の対象になる", allowed?.hookSpecificOutput?.permissionDecision, "allow");
      const confirmed = handleHook("claude", "PreToolUse", hookInput("claude", "PreToolUse", { cwd: r.dir, command: `${cmd} --confirmed`, sessionId: "s1" }));
      eq("enforcement/7.2 --confirmed を付けた publish は確認省略せず、ホストの確認に任せる", confirmed, null);
    });

    // ---- 中断（pause）後は公開を起動しない ----
    await withRepo({}, async (r) => {
      const id = startId(r.dir);
      const gh = github({ routes: { [POST]: { status: 201, body: PR(gitOut(r.dir, "rev-parse", "HEAD")) } } });
      const pid = await readyAndPlan(r.dir, id, gh);
      brwRun(r.dir, ["pause", "--work", id, "--reason", "確認待ち"]);
      const x = await publishCmd(r.dir, ["--work", id, "--plan", pid, "--title", "変更"], gh);
      eq("enforcement/7.2 中断中の作業は公開せず、書き込みもしない", [x.code, gh.fake.writeCount, workOf(r.dir, id).status], [1, 0, "ready"]);
    });
    // ---- 非対話の brw publish --confirmed（本番の既定の TTY 判定を通す spawn）。実在の作業 ID と計画 ID を使う（7.2 申し送り a） ----
    await withRepo({ config: { ...CONFIG, autoApprove: { push: false } } }, async (r) => {
      const id = startId(r.dir);
      const gh = github({ routes: { [POST]: { status: 201, body: PR(gitOut(r.dir, "rev-parse", "HEAD")) } } });
      const pid = await readyAndPlan(r.dir, id, gh);
      const s = spawnSync("node", [BRW, "publish", "--work", id, "--plan", pid, "--confirmed"], { cwd: r.dir, encoding: "utf8", env: process.env, stdio: ["pipe", "pipe", "pipe"] });
      const remoteHas = gitOut(r.dir, "ls-remote", "origin", "refs/heads/dev/foo").length > 0;
      eq("enforcement/7.2 非 TTY の spawn による --confirmed は終了コード 1・遠隔に ref なし・作業は ready のまま（本番の既定の判定）", [typeof pid, s.status, remoteHas, workOf(r.dir, id).status, gh.fake.writeCount], ["string", 1, false, "ready", 0]);
    });
  } finally {
    for (const [k, v] of [["GIT_SSH_COMMAND", saved.cmd], ["GIT_SSH_VARIANT", saved.variant], ["BRW_TEST_BARE", saved.bare]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(sshDir, { recursive: true, force: true });
  }
};
