// テスト補助そのものが動くことを示す最小のテスト。selftest.mjs から呼ばれる。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gitOut, mkRepoWithRemote, mkWorktree } from "./git-fixture.mjs";
import { hookInput, HOSTS } from "./hook-fixtures.mjs";
import { createFakeGitHub } from "./fake-github.mjs";

export const runSupportChecks = async (eq) => {
  // 一時リポジトリと bare remote（サーバー側だけの空のリポジトリ）
  const r = mkRepoWithRemote({ branch: "dev/foo", config: { workBranches: ["dev/*"], protectedBranches: ["main"] } });
  eq("support/1.2 一時リポジトリは指定ブランチにいる", gitOut(r.dir, "branch", "--show-current"), "dev/foo");
  eq("support/1.2 bare remote が origin として設定され main が push 済み", [gitOut(r.dir, "remote", "get-url", "origin") === r.remote, gitOut(r.remote, "rev-parse", "--is-bare-repository"), gitOut(r.remote, "rev-parse", "--verify", "refs/heads/main").length > 0], [true, "true", true]);
  eq("support/1.2 宣言は commit 済みで登録されている", gitOut(r.dir, "ls-files", ".branch-release-workflow.json"), ".branch-release-workflow.json");
  gitOut(r.dir, "commit", "--allow-empty", "-m", "x");
  gitOut(r.dir, "push", "-q", "origin", "dev/foo");
  eq("support/1.2 remote の ref を読める", gitOut(r.remote, "rev-parse", "refs/heads/dev/foo"), gitOut(r.dir, "rev-parse", "HEAD"));
  const wt = mkWorktree(r.dir, "dev/bar");
  eq("support/1.2 追加の worktree を作れる", [existsSync(join(wt, ".git")), gitOut(wt, "branch", "--show-current")], [true, "dev/bar"]);
  r.cleanup();
  eq("support/1.2 後始末で一時ディレクトリが消える", existsSync(r.dir) || existsSync(r.remote), false);
  eq("support/1.2 後始末で追加の worktree 用ディレクトリも消える", existsSync(wt), false);

  // 両ホストのフック入力例
  const cmd = "git push origin dev/foo";
  eq("support/1.2 Claude の PreToolUse 入力", hookInput("claude", "PreToolUse", { cwd: "/w", command: cmd, sessionId: "s1" }), { session_id: "s1", cwd: "/w", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: cmd } });
  const cx = hookInput("codex", "PermissionRequest", { cwd: "/w", command: cmd, sessionId: "s2" });
  eq("support/1.2 Codex の PermissionRequest 入力", [cx.hook_event_name, cx.tool_name, cx.tool_input.command, cx.session_id], ["PermissionRequest", "Bash", cmd, "s2"]);
  eq("support/1.2 両ホストの全イベントを作れる", HOSTS.claude.every((e) => hookInput("claude", e, { cwd: "/w" }).hook_event_name === e) && HOSTS.codex.every((e) => hookInput("codex", e, { cwd: "/w" }).hook_event_name === e), true);
  eq("support/1.2 MCP の書き込み入力はツール名と入力をそのまま持つ", hookInput("claude", "PreToolUse", { cwd: "/w", tool: "mcp__github__create_pull_request", toolInput: { owner: "o", repo: "r", head: "dev/a", base: "main" } }).tool_input.base, "main");
  eq("support/1.2 不正な入力（欠落・非 JSON）も作れる", [hookInput("claude", "PreToolUse", { cwd: "/w", omit: ["tool_input"] }).tool_input, typeof hookInput("claude", "PreToolUse", { raw: "{oops" })], [undefined, "string"]);

  // GitHub の偽の応答層（実際の通信・認証は使わない）
  const ok = createFakeGitHub({ routes: { "GET /repos/o/r": { status: 200, body: { id: 7, full_name: "o/r" } }, "POST /repos/o/r/pulls": { status: 201, body: { number: 1, html_url: "https://github.com/o/r/pull/1" } } } });
  const g1 = await ok.request("GET", "/repos/o/r");
  const g2 = await ok.request("POST", "/repos/o/r/pulls", { head: "dev/a", base: "main" });
  eq("support/1.2 偽の GitHub は成功応答を返す", [g1.status, g1.body.id, g2.status, g2.body.number], [200, 7, 201, 1]);
  eq("support/1.2 要求先と書き込み件数を記録する", [ok.requests.map((q) => `${q.method} ${q.path}`), ok.writeCount, ok.requests[1].body.base], [["GET /repos/o/r", "POST /repos/o/r/pulls"], 1, "main"]);
  eq("support/1.2 未登録の経路は 404 で、書き込みなら件数に数える", [(await ok.request("GET", "/nope")).status, (await ok.request("PUT", "/nope")).status, ok.writeCount], [404, 404, 2]);
  const denied = createFakeGitHub({ scenario: "permission", routes: { "POST /repos/o/r/rulesets": { status: 201, body: { id: 1 } } } });
  const d1 = await denied.request("POST", "/repos/o/r/rulesets", {});
  eq("support/1.2 権限不足は 403 を返し、書き込みは適用されない", [d1.status, denied.applied.length, denied.writeCount], [403, 0, 1]);
  const noauth = createFakeGitHub({ scenario: "auth" });
  eq("support/1.2 認証不能は 401", (await noauth.request("GET", "/user")).status, 401);
  const lost = createFakeGitHub({ scenario: "lost", routes: { "POST /repos/o/r/pulls": { status: 201, body: { number: 2 } } } });
  let err = null;
  try { await lost.request("POST", "/repos/o/r/pulls", { head: "a", base: "b" }); } catch (e) { err = e; }
  eq("support/1.2 応答喪失は例外になるが、書き込み自体は適用済みとして記録する", [err?.code, lost.applied.length, lost.writeCount], ["ECONNRESET", 1, 1]);
  const dump = JSON.stringify(ok.requests);
  eq("support/1.2 記録に資格情報の値を含めない", /token|authorization|bearer/i.test(dump), false);
  eq("support/1.2 補助は実際の GitHub を呼ばない（node:net/http を使わない）", ["git-fixture", "hook-fixtures", "fake-github"].some((n) => /node:(https?|net)"/.test(readFileSync(new URL(`./${n}.mjs`, import.meta.url), "utf8"))), false);
};
