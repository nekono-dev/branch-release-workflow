// Claude Code と Codex のフック応答（brw-enforcement 6.1）の契約テスト。selftest.mjs から呼ばれる。
// 実際のホストは呼ばず、入力の形（fixture）と応答の形を確かめる。
// 公開計画の検証は一時リポジトリの計画を使い、遠隔（bare remote）には触れない。
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as publish from "../scripts/publish.mjs";
import { runPublishPr } from "../scripts/publish-pr.mjs";
import { gitOut, mkRepoWithRemote } from "./support/git-fixture.mjs";
import { hookInput } from "./support/hook-fixtures.mjs";

// scripts/agent-hooks.mjs は 6.1 で作る。未実装の間は「未実装」として失敗する（RED の確認用）
const agentModule = await import("../scripts/agent-hooks.mjs").catch(() => null);
const handleHook = agentModule?.handleHook ?? (() => ({ missing: "未実装" }));

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BRW = join(root, "scripts/brw.mjs");
const HOOK_CLI = join(root, "scripts/agent-hooks.mjs");
const CONFIG = { workBranches: ["dev/*"], protectedBranches: ["main"], baseBranch: "develop" };
const GH = "https://github.com/acme/app.git";
const REPO = { id: 4242, owner: "acme", name: "app" };
const DONE = "依頼の完了条件を満たした";
const VERIFIED = { passed: true, summary: "npm test が成功" };
const PULL = { ok: true, pull: null };
// 資格情報らしい値。応答や理由に出てはならない
const SECRET = "ghp_abcdefghij0123456789";
const TITLE = "件名 テスト";

/** 一時リポジトリ。origin を GitHub の形にする（判定と計画の照合に使う。通信はしない）。 */
const repoOf = ({ branch = "dev/foo", config = CONFIG, register = true } = {}) => {
  const r = mkRepoWithRemote({ branch, config, register });
  gitOut(r.dir, "remote", "set-url", "origin", GH);
  return r;
};

/** 応答を取り出す。Claude の PreToolUse は permissionDecision、PermissionRequest は decision.behavior。 */
const preOf = (host, command, cwd) => handleHook(host, "PreToolUse", hookInput(host, "PreToolUse", { cwd, command }))?.hookSpecificOutput?.permissionDecision ?? null;
const preReasonOf = (host, command, cwd) => handleHook(host, "PreToolUse", hookInput(host, "PreToolUse", { cwd, command }))?.hookSpecificOutput?.permissionDecisionReason ?? "";
const permOf = (host, command, cwd) => handleHook(host, "PermissionRequest", hookInput(host, "PermissionRequest", { cwd, command }))?.hookSpecificOutput?.decision?.behavior ?? null;
const bothOf = (command, cwd) => ({ claude: preOf("claude", command, cwd), codex: preOf("codex", command, cwd), codexPerm: permOf("codex", command, cwd) });
const mcpOf = (toolInput, cwd) => handleHook("claude", "PreToolUse", hookInput("claude", "PreToolUse", { cwd, tool: "mcp__github__create_pull_request", toolInput }))?.hookSpecificOutput?.permissionDecision ?? null;

/** 公開の準備と計画まで済ませた作業を用意し、fn を呼ぶ。opts.blockPush なら計画前に push を禁止する。 */
const planned = (fn, opts = {}) => {
  const r = repoOf();
  try {
    const id = publish.startWork(r.dir, { sessionId: "s1" }).work.workId;
    const ready = publish.markReady(r.dir, id, { completion: DONE, verification: VERIFIED, repository: REPO });
    if (!ready.ok) throw new Error(`準備に失敗: ${ready.error?.code}`);
    if (opts.blockPush) publish.setRestrictions(r.dir, id, { noPush: true, noPr: false });
    const x = publish.issuePlan(r.dir, id, { repository: REPO, existing: PULL });
    return fn({ dir: r.dir, remote: r.remote, id, plan: x.plan, x });
  } finally {
    r.cleanup();
  }
};

/** 公開の実行コマンド（信頼済み BRW の publish）。 */
const publishCmd = (id, plan, extra = "") => `node ${BRW} publish --work ${id} --plan ${plan} ${extra}`.trim();

export const runAgentHookChecks = async (eq) => {
  // ---- 応答の形（両ホストの契約） ----
  {
    const r = repoOf();
    const deny = handleHook("claude", "PreToolUse", hookInput("claude", "PreToolUse", { cwd: r.dir, command: "git push origin main" }));
    eq("enforcement/6.1 Claude の拒否は PreToolUse の permissionDecision と理由を返す", [deny?.hookSpecificOutput?.hookEventName, deny?.hookSpecificOutput?.permissionDecision, deny?.hookSpecificOutput?.permissionDecisionReason?.startsWith("[branch-release-workflow] ")], ["PreToolUse", "deny", true]);
    const codexDeny = handleHook("codex", "PreToolUse", hookInput("codex", "PreToolUse", { cwd: r.dir, command: "git push origin main" }));
    eq("enforcement/6.1 Codex の PreToolUse は拒否を明示的に返す", [codexDeny?.hookSpecificOutput?.hookEventName, codexDeny?.hookSpecificOutput?.permissionDecision], ["PreToolUse", "deny"]);
    const codexPermDeny = handleHook("codex", "PermissionRequest", hookInput("codex", "PermissionRequest", { cwd: r.dir, command: "git push origin main" }));
    eq("enforcement/6.1 Codex の PermissionRequest の拒否は decision.behavior と message を返す", [codexPermDeny?.hookSpecificOutput?.hookEventName, codexPermDeny?.hookSpecificOutput?.decision?.behavior, typeof codexPermDeny?.hookSpecificOutput?.decision?.message], ["PermissionRequest", "deny", "string"]);
    const allow = handleHook("claude", "PreToolUse", hookInput("claude", "PreToolUse", { cwd: r.dir, command: "git push origin dev/foo" }));
    eq("enforcement/6.1 Claude は確認省略を PreToolUse の allow で返す", allow?.hookSpecificOutput?.permissionDecision, "allow");
    eq("enforcement/6.1 Codex の PreToolUse は確認省略を返さない（PermissionRequest だけが許可を返す）", [bothOf("git push origin dev/foo", r.dir).codex, bothOf("git push origin dev/foo", r.dir).codexPerm], [null, "allow"]);
    const codexPermAllow = handleHook("codex", "PermissionRequest", hookInput("codex", "PermissionRequest", { cwd: r.dir, command: "git push origin dev/foo" }));
    eq("enforcement/6.1 Codex の PermissionRequest の許可は decision.behavior allow だけを返す", codexPermAllow?.hookSpecificOutput, { hookEventName: "PermissionRequest", decision: { behavior: "allow" } });
    eq("enforcement/6.1 通常の承認に任せる操作は応答を返さない（Claude・Codex とも）", (() => {
      const cmd = "git push --force origin dev/foo";
      return [preOf("claude", cmd, r.dir), preOf("codex", cmd, r.dir), permOf("codex", cmd, r.dir)];
    })(), [null, null, null]);
    eq("enforcement/6.1 PostToolUse と Stop は本作業（6.2）の対象で、この応答は返さない", [handleHook("claude", "PostToolUse", hookInput("claude", "PostToolUse", { cwd: r.dir, command: "git push origin main" })), handleHook("codex", "Stop", hookInput("codex", "Stop", { cwd: r.dir }))], [null, null]);
    r.cleanup();
  }

  // ---- 通常 push・保護対象への PR 作成の確認省略 ----
  {
    const r = repoOf();
    eq("enforcement/6.1 開発ブランチへの通常 push は確認省略の対象（両ホスト）", bothOf("git push origin dev/foo", r.dir), { claude: "allow", codex: null, codexPerm: "allow" });
    eq("brw-pr-handoff/1.1 開発ブランチから保護対象への直接の PR 作成も、確認省略せず拒否して brw pr を案内する", [bothOf("gh pr create --base main --head dev/foo --title t --body b", r.dir).claude, preReasonOf("claude", "gh pr create --base main --head dev/foo --title t --body b", r.dir).includes("brw pr")], ["deny", true]);
    eq("enforcement/6.1 確認省略の応答に PR の本文・タイトルや資格情報を含めない", (() => {
      const text = JSON.stringify(handleHook("claude", "PreToolUse", hookInput("claude", "PreToolUse", { cwd: r.dir, command: `gh pr create --base main --head dev/foo --title "${SECRET}" --body b` })));
      return [text.includes(SECRET), text.includes("--body")];
    })(), [false, false]);
    eq("enforcement/6.1 強制 push・削除・タグは確認省略しない", ["git push -f origin dev/foo", "git push origin :dev/foo", "git push --tags origin dev/foo"].map((c) => bothOf(c, r.dir).claude), [null, null, null]);
    // 複合した命令・認識外のコマンドが混ざる場合は確認省略しない（拒否ではない）
    eq("enforcement/6.1 認識外のコマンドや複合した命令が混ざると確認省略しない（拒否は許す）", ["git push origin dev/foo && ls", "git push origin dev/foo; rm -rf x", "git push origin dev/foo | cat", "ls && git push origin dev/foo", "git push origin dev/foo $(echo x)", "git push origin dev/foo > out.txt"].map((c) => preOf("claude", c, r.dir) !== "allow"), Array(6).fill(true));
    eq("enforcement/6.1 cd と git -C だけの複合は、どちらも通常 push として扱える", [preOf("claude", `cd ${r.dir} && git push origin dev/foo`, r.dir), preOf("claude", `git -C ${r.dir} push origin dev/foo`, r.dir)], ["allow", "allow"]);
    eq("enforcement/6.1 作業ディレクトリが不明な git 操作は理由付きで拒否する", [preOf("claude", "git push origin dev/foo", undefined), preOf("claude", "ls -la", undefined)], ["deny", null]);
    eq("enforcement/6.1 送り先が確定できない push は拒否する", ["git push origin dev/*", "git push --all", `git push https://x:${SECRET}@example.com/a/b.git dev/foo`].map((c) => preOf("claude", c, r.dir)), ["deny", "deny", "deny"]);
    const leaked = handleHook("claude", "PreToolUse", hookInput("claude", "PreToolUse", { cwd: r.dir, command: `git push https://x:${SECRET}@example.com/a/b.git dev/foo` }));
    eq("enforcement/6.1 拒否の理由に URL の資格情報を含めない", JSON.stringify(leaked).includes(SECRET), false);
    r.cleanup();
  }

  // ---- 拒否（保護・分岐元・宣言外への直接操作） ----
  {
    const r = repoOf();
    eq("enforcement/6.1 保護対象への直接 push と開発間でない merge は拒否する", ["git push origin HEAD:main", "git merge main"].map((c) => preOf("claude", c, r.dir)), ["deny", "deny"]);
    eq("enforcement/6.1 開発ブランチへの PR 作成（開発間）は拒否する", preOf("claude", "gh pr create --base dev/other --head dev/foo --title t --body b", r.dir), "deny");
    eq("enforcement/6.1 GitHub 上のマージと自動マージ予約は拒否する", ["gh pr merge 5", "gh pr merge 5 --auto --squash"].map((c) => preOf("claude", c, r.dir)), ["deny", "deny"]);
    eq("brw-pr-handoff/1.1 MCP の PR 作成は、保護対象への作成も開発間の作成も拒否する", [mcpOf({ owner: "acme", repo: "app", title: "t", head: "dev/foo", base: "main" }, r.dir), mcpOf({ owner: "acme", repo: "app", title: "t", head: "dev/foo", base: "dev/other" }, r.dir)], ["deny", "deny"]);
    eq("enforcement/6.1 MCP の必須入力が欠ける PR 作成は拒否する", mcpOf({ owner: "acme", title: "t", head: "dev/foo", base: "main" }, r.dir), "deny");
    r.cleanup();
  }

  // ---- 参照を動かす操作（2.3 申し送り (c)）は確認に倒す ----
  {
    const r = repoOf();
    eq("enforcement/6.1 参照を動かす操作は確認を求める（Claude は ask、Codex は PreToolUse で返さない）", ["git update-ref refs/heads/dev/foo HEAD~1", "git branch -D dev/other", "git reset --hard HEAD~1", "git symbolic-ref HEAD refs/heads/main", "git tag v9"].map((c) => [preOf("claude", c, r.dir), preOf("codex", c, r.dir)]), Array(5).fill(["ask", null]));
    eq("enforcement/6.1 参照を動かさない照会は確認を求めない", ["git branch --show-current", "git tag -l", "git status", "git log --oneline"].map((c) => preOf("claude", c, r.dir)), [null, null, null, null]);
    r.cleanup();
  }

  // ---- 導入の範囲 ----
  {
    const plain = repoOf({ config: null });
    eq("enforcement/6.1 BRW を導入していないリポジトリの操作は通す", ["git push origin main", "git merge main"].map((c) => preOf("claude", c, plain.dir)), [null, null]);
    plain.cleanup();
    const unreg = repoOf({ register: false });
    eq("enforcement/6.1 未登録の宣言では確認を省略しない（拒否もしない）", bothOf("git push origin dev/foo", unreg.dir), { claude: null, codex: null, codexPerm: null });
    unreg.cleanup();
    eq("enforcement/6.1 対応しない種類の入力は応答を返さない", [handleHook("claude", "PreToolUse", hookInput("claude", "PreToolUse", { cwd: "/tmp", tool: "Write", toolInput: { file_path: "/tmp/x" } })), handleHook("codex", "PreToolUse", hookInput("codex", "PreToolUse", { raw: "{oops" })), handleHook("claude", "PreToolUse", hookInput("claude", "PreToolUse", { cwd: "/tmp", omit: ["tool_input"] })), handleHook("gemini", "PreToolUse", hookInput("claude", "PreToolUse", { cwd: "/tmp", command: "git push" }))], [null, null, null, null]);
  }

  // ---- 公開計画の照合（信頼済み BRW の publish） ----
  planned(({ dir, id, plan, x }) => {
    eq("enforcement/6.1 計画の作成が済んでいる（前提の確認）", [x.ok, (plan?.writes ?? []).map((w) => w.operation)], [true, ["push", "pr"]]);
    eq("enforcement/6.1 信頼済み BRW の publish は計画どおりの書き込みに限り確認を省略する（Claude）", preOf("claude", publishCmd(id, plan.planId, `--title "${TITLE}"`), dir), "allow");
    eq("enforcement/6.1 Codex は publish の確認省略を PermissionRequest でだけ返す", [preOf("codex", publishCmd(id, plan.planId, `--title "${TITLE}"`), dir), permOf("codex", publishCmd(id, plan.planId, `--title "${TITLE}"`), dir)], [null, "allow"]);
    eq("enforcement/6.1 publish の応答に件名や資格情報を含めない", JSON.stringify(handleHook("claude", "PreToolUse", hookInput("claude", "PreToolUse", { cwd: dir, command: publishCmd(id, plan.planId, `--title "${SECRET}"`) }))).includes(SECRET), false);
    eq("enforcement/6.1 PR を作る計画で件名が無いと確認を省略しない", preOf("claude", publishCmd(id, plan.planId), dir), null);
    eq("enforcement/6.1 件名が不正（改行を含む）だと確認を省略しない", preOf("claude", publishCmd(id, plan.planId, `--title "a
b"`), dir), null);
    // brw-pr-handoff 6.1: 信頼済みの brw pr だけが確認省略の対象
    {
      const pr = (extra = "") => `node ${BRW} pr --title "${TITLE}" --completion "完了した" --verification "確認した" ${extra}`.trim();
      const bodyDir = join(dir, ".claude", "worktrees", ".brw");
      mkdirSync(bodyDir, { recursive: true });
      writeFileSync(join(bodyDir, "dev-foo.md"), "本文\n");
      writeFileSync(join(dir, "outside.md"), "別の場所\n");
      eq("brw-pr-handoff/6.1 信頼済みの brw pr は、宣言が push と PR の確認省略を有効にしているとき確認を省略する（Claude）", preOf("claude", pr(), dir), "allow");
      eq("brw-pr-handoff/6.1 本文置き場の絶対パスの --body-file も許可する", preOf("claude", pr(`--body-file ${join(bodyDir, "dev-foo.md")}`), dir), "allow");
      eq("brw-pr-handoff/6.1 本文置き場の外の絶対パス・.. を含むパスの --body-file は確認を省略しない", [
        preOf("claude", pr(`--body-file ${join(dir, "outside.md")}`), dir), preOf("claude", pr(`--body-file ${join(bodyDir, "..", "..", "..", "outside.md")}`), dir),
      ], [null, null]);
      eq("brw-pr-handoff/6.1 --confirmed・未知のオプション・値の欠落・重複は確認を省略しない（通常の承認に任せる）", [
        preOf("claude", pr("--confirmed"), dir), preOf("claude", pr("--bogus x"), dir), preOf("claude", pr("--title"), dir), preOf("claude", pr(`--title "二つ目"`), dir),
        preOf("claude", `node ${BRW} pr --title --confirmed --completion c --verification v`, dir), preOf("claude", `node ${BRW} pr --title --unknown --completion c --verification v`, dir),
      ], [null, null, null, null, null, null]);
      eq("brw-pr-handoff/6.1 信頼できない BRW のパスの pr は確認を省略しない", preOf("claude", `node /tmp/nonexistent-brw/scripts/brw.mjs pr --title "${TITLE}" --completion c --verification v`, dir), null);
      eq("brw-pr-handoff/6.1 Codex は PreToolUse では応答せず、PermissionRequest でだけ許可する", [preOf("codex", pr(), dir), permOf("codex", pr(), dir)], [null, "allow"]);
      eq("brw-pr-handoff/6.1 他の連結コマンドを含む brw pr は確認を省略しない", preOf("claude", `${pr()} && echo x`, dir), null);
      // 後続の試験が「未コミットの変更なし」を前提にするため、置いたファイルを片付ける
      rmSync(join(dir, ".claude"), { recursive: true, force: true });
      rmSync(join(dir, "outside.md"), { force: true });
    }
    eq("enforcement/6.1 信頼できない BRW のパスでは確認を省略しない", preOf("claude", `node /tmp/nonexistent-brw/scripts/brw.mjs publish --work ${id} --plan ${plan.planId} --title "${TITLE}"`, dir), null);
    eq("enforcement/6.1 計画に無い引数（強制など）が付くと確認を省略しない", preOf("claude", publishCmd(id, plan.planId, `--title "${TITLE}" --force`), dir), null);
    eq("enforcement/6.1 publish と他のコマンドを続けると確認を省略しない", preOf("claude", `${publishCmd(id, plan.planId, `--title "${TITLE}"`)} && git push origin dev/foo`, dir), null);
    eq("enforcement/6.1 計画 ID が違う（存在しない）と確認を省略しない", preOf("claude", publishCmd(id, "p-0000000000000000", `--title "${TITLE}"`), dir), null);
    eq("enforcement/6.1 計画の発行後に制限が変わると、計画は失効して確認を省略しない", (() => {
      publish.setRestrictions(dir, id, { noPush: true, noPr: false });
      return preOf("claude", publishCmd(id, plan.planId, `--title "${TITLE}"`), dir);
    })(), null);
    // 制限が変わった後の CLI の再検証（承認イベントが届かなくても残る制限）
    // 通信に出ないよう、計画の版の確認で止まることを見る（push の前の検証で失敗する）
    eq("enforcement/6.1 承認イベントが無くても、CLI は制限後の push を実行しない", (() => {
      const res = publish.runPush(dir, id, { planId: plan.planId, repository: REPO, confirmed: true });
      return [res.ok, res.error?.code];
    })(), [false, "restrictions-changed"]);
  });
  planned(({ dir, id, plan }) => {
    eq("enforcement/6.1 計画の書き込みが無い（既に成功済み等）なら確認を省略しない", preOf("claude", publishCmd(id, plan.planId, `--title "${TITLE}"`), dir), null);
  }, { blockPush: true });

  // ---- 6.1 補強: 本文ファイル・送り先・状態の破損・記録された禁止・計画の版 ----
  planned(({ dir, id, plan }) => {
    const body = (p) => publishCmd(id, plan.planId, `--title "${TITLE}" --body-file ${p}`);
    // 作業ツリーを汚さないよう、.git の中と、作業ディレクトリの外（一時ディレクトリの親）に置く
    writeFileSync(join(dir, ".git", "body.md"), "本文");
    writeFileSync(join(dir, "..", "outside-body.md"), "外の本文");
    symlinkSync("/etc/passwd", join(dir, ".git", "link.md"));
    eq("enforcement/6.1 本文ファイルが絶対パス・外のパス・外を指すリンク・デバイスなら確認を省略しない", [
      preOf("claude", body("/etc/passwd"), dir),
      preOf("claude", body("../outside-body.md"), dir),
      preOf("claude", body(".git/link.md"), dir),
      preOf("claude", body("/dev/null"), dir),
    ], [null, null, null, null]);
    eq("enforcement/6.1 本文ファイルが作業ディレクトリ配下の通常ファイルなら確認を省略する", preOf("claude", body(".git/body.md"), dir), "allow");
  });
  planned(({ dir, id, plan }) => {
    // 計画の push の OID が準備時の head と違う計画は、書き込みの形が正しくないので確認を省略しない
    const file = publish.stateFileOf(dir);
    const s = JSON.parse(readFileSync(file, "utf8"));
    s.works[id].plan.writes[0].oid = "a".repeat(40);
    writeFileSync(file, JSON.stringify(s));
    eq("enforcement/6.1 計画の push の OID が準備時の head と違うと、確認を省略しない", preOf("claude", publishCmd(id, plan.planId, `--title "${TITLE}"`), dir), null);
  });
  {
    // 別のリモート（別の GitHub リポジトリ）への通常 push、同じリポジトリを指す別名、origin の送信先の食い違い
    const r = repoOf();
    try {
      gitOut(r.dir, "remote", "add", "up", "https://github.com/evil/app.git");
      gitOut(r.dir, "remote", "add", "mirror", "git@github.com:acme/app.git");
      eq("enforcement/6.1 別のリモート（別の GitHub リポジトリ）への通常 push は確認を省略しない（両ホスト）", [bothOf("git push up dev/foo", r.dir).claude, bothOf("git push up dev/foo", r.dir).codexPerm], [null, null]);
      eq("enforcement/6.1 同じ GitHub リポジトリを指す別名のリモートへの push は確認を省略する", preOf("claude", "git push mirror dev/foo", r.dir), "allow");
      gitOut(r.dir, "remote", "set-url", "--push", "origin", "https://github.com/evil/app.git");
      eq("enforcement/6.1 origin の送信先が取得先と違うと、origin への push も確認を省略しない", preOf("claude", "git push origin dev/foo", r.dir), null);
    } finally {
      r.cleanup();
    }
  }
  {
    // 送信先が複数ある remote は、git が全件へ送る。1 件でも別のリポジトリなら確認を省略しない
    const r = repoOf();
    try {
      gitOut(r.dir, "remote", "add", "multi", GH);
      gitOut(r.dir, "remote", "set-url", "--add", "--push", "multi", GH);
      gitOut(r.dir, "remote", "set-url", "--add", "--push", "multi", "https://github.com/evil/app.git");
      eq("enforcement/6.1 送信先が複数あり 1 件でも別のリポジトリなら、push は確認を省略しない（両ホスト）", [bothOf("git push multi dev/foo", r.dir).claude, bothOf("git push multi dev/foo", r.dir).codexPerm], [null, null]);
    } finally {
      r.cleanup();
    }
  }
  {
    // 送信先が複数でも、全件が同じ GitHub リポジトリを指すなら確認を省略する（表記が違っても同一リポジトリ）
    const r = repoOf();
    try {
      gitOut(r.dir, "remote", "add", "multi", GH);
      gitOut(r.dir, "remote", "set-url", "--add", "--push", "multi", GH);
      gitOut(r.dir, "remote", "set-url", "--add", "--push", "multi", "git@github.com:acme/app.git");
      eq("enforcement/6.1 送信先が複数でも全件が同じ GitHub リポジトリなら、push は確認を省略する", preOf("claude", "git push multi dev/foo", r.dir), "allow");
    } finally {
      r.cleanup();
    }
  }
  {
    // origin に別の送信先を足すと、origin への push も確認を省略しない
    const r = repoOf();
    try {
      gitOut(r.dir, "remote", "set-url", "--add", "--push", "origin", "https://github.com/evil/app.git");
      eq("enforcement/6.1 origin に別リポジトリの送信先を足すと、origin への push も確認を省略しない", preOf("claude", "git push origin dev/foo", r.dir), null);
    } finally {
      r.cleanup();
    }
  }
  {
    // 状態ファイルが壊れている: 禁止が読めないので、push と PR 作成（gh・REST・MCP）は拒否する
    const r = repoOf();
    try {
      publish.startWork(r.dir, { sessionId: "s1" });
      writeFileSync(publish.stateFileOf(r.dir), "{oops");
      eq("enforcement/6.1 状態ファイルが壊れていると、push・gh・REST・MCP の PR 作成を拒否する", [
        preOf("claude", "git push origin dev/foo", r.dir),
        preOf("claude", "gh pr create --base main --head dev/foo --title t --body b", r.dir),
        preOf("claude", "gh api repos/acme/app/pulls -f title=t -f head=dev/foo -f base=main", r.dir),
        mcpOf({ owner: "acme", repo: "app", title: "t", head: "dev/foo", base: "main" }, r.dir),
      ], ["deny", "deny", "deny", "deny"]);
    } finally {
      r.cleanup();
    }
  }
  {
    // 計画を介さずに記録された禁止（作業の制限）: 直接の操作も拒否する
    const r = repoOf();
    try {
      const id = publish.startWork(r.dir, { sessionId: "s1" }).work.workId;
      publish.setRestrictions(r.dir, id, { noPush: true, noPr: true });
      eq("enforcement/6.1 記録された禁止（noPush・noPr）は、直接の push・PR 作成（gh・REST・MCP）を拒否する", [
        preOf("claude", "git push origin dev/foo", r.dir),
        preOf("claude", "gh pr create --base main --head dev/foo --title t --body b", r.dir),
        preOf("claude", "gh api repos/acme/app/pulls -f title=t -f head=dev/foo -f base=main", r.dir),
        mcpOf({ owner: "acme", repo: "app", title: "t", head: "dev/foo", base: "main" }, r.dir),
      ], ["deny", "deny", "deny", "deny"]);
    } finally {
      r.cleanup();
    }
  }
  {
    // 禁止は追加のみ（外せない）。noPr だけの作業では、push は確認を省略でき、PR 作成は拒否する
    const r = repoOf();
    try {
      const id = publish.startWork(r.dir, { sessionId: "s1" }).work.workId;
      publish.setRestrictions(r.dir, id, { noPush: false, noPr: true });
      eq("enforcement/6.1 noPr だけの禁止では、push は確認を省略でき、PR 作成は拒否する", [preOf("claude", "git push origin dev/foo", r.dir), preOf("claude", "gh pr create --base main --head dev/foo --title t --body b", r.dir)], ["allow", "deny"]);
    } finally {
      r.cleanup();
    }
  }
  {
    // 承認イベントが無くても、公開の実行（runPublishPr）は制限の後に計画を再検証して止まる
    const r = repoOf();
    try {
      const id = publish.startWork(r.dir, { sessionId: "s1" }).work.workId;
      publish.markReady(r.dir, id, { completion: DONE, verification: VERIFIED, repository: REPO });
      const x = publish.issuePlan(r.dir, id, { repository: REPO, existing: PULL });
      publish.setRestrictions(r.dir, id, { noPush: true, noPr: false });
      const res = await runPublishPr(r.dir, id, { planId: x.plan.planId, repository: REPO, confirmed: true, title: TITLE });
      eq("enforcement/6.1 承認イベントが無くても、PR の公開経路は制限後の計画で実行しない", [res.ok, res.error?.code], [false, "restrictions-changed"]);
    } finally {
      r.cleanup();
    }
  }

  // ---- 実行ファイルとしての入口（既存フックから呼ぶ） ----
  {
    const r = repoOf();
    const run = (host, event, input) => spawnSync("node", [HOOK_CLI, host, event], { input: JSON.stringify(input), encoding: "utf8" });
    const out = run("codex", "PermissionRequest", hookInput("codex", "PermissionRequest", { cwd: r.dir, command: "git push origin dev/foo" }));
    eq("enforcement/6.1 実行ファイルは標準入力の JSON から応答を標準出力へ書く", [out.status, JSON.parse(out.stdout || "{}").hookSpecificOutput?.decision?.behavior], [0, "allow"]);
    const none = run("codex", "PreToolUse", hookInput("codex", "PreToolUse", { cwd: r.dir, command: "git status" }));
    eq("enforcement/6.1 応答が無い場合は何も書かず正常終了する", [none.status, none.stdout], [0, ""]);
    const bad = spawnSync("node", [HOOK_CLI, "codex", "PreToolUse"], { input: "{oops", encoding: "utf8" });
    eq("enforcement/6.1 不正な入力は何も書かず正常終了する", [bad.status, bad.stdout], [0, ""]);
    r.cleanup();
  }
};
