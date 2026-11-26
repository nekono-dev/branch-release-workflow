// 送り先リモートの読み取り（brw-enforcement 1.6〜1.8）の契約テスト。selftest.mjs から呼ばれる。
// PATH の先頭に偽の ssh を置き、`ssh -G` の出力を固定する（実際の ~/.ssh/config には依存しない）。
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyCommand } from "../scripts/operation-policy.mjs";
import { contextFor, evaluate } from "../scripts/operation-decision.mjs";
import { parseRepoSpec } from "../scripts/github-operations.mjs";
import * as publish from "../scripts/publish.mjs";
import { aliasHostOf, canonicalSshHost, githubRepoOf, resetAliasCache, unknownDestinationText } from "../scripts/remote-url.mjs";
import { gitOut, mkRepoWithRemote } from "./support/git-fixture.mjs";

const CONFIG = { workBranches: ["dev/*"], protectedBranches: ["main"], baseBranch: "develop" };

export const runRemoteUrlChecks = async (eq) => {
  const bin = mkdtempSync(join(tmpdir(), "brw-fakessh-"));
  const log = join(bin, "calls.log");
  // 最後の引数（ホスト）で出力を変える偽の ssh
  writeFileSync(join(bin, "ssh"), `#!/bin/sh
echo "$@" >> "${log}"
for h; do :; done
case "$h" in
  gh-alias) echo "hostname github.com" ;;
  ghes-alias) echo "hostname ghe.example.com" ;;
  fail-alias) exit 255 ;;
  port-alias) case "$*" in *"-p 2222"*) echo "hostname github.com" ;; *) echo "hostname other.example.com" ;; esac ;;
  slow-alias) sleep 6; echo "hostname github.com" ;;
  *) exit 255 ;;
esac
`);
  chmodSync(join(bin, "ssh"), 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath}`;
  resetAliasCache();
  const calls = () => { try { return readFileSync(log, "utf8").split("\n").filter(Boolean); } catch { return []; } };
  try {
    // ---- 13.1 URL の読み取り ----
    const R = { owner: "acme", name: "app" };
    eq("enforcement/1.6 従来の https・scp・ssh 形式の github.com は ssh を使わずに読む", [
      githubRepoOf("https://github.com/acme/app.git"), githubRepoOf("git@github.com:acme/app.git"), githubRepoOf("ssh://git@github.com/acme/app"), calls().length,
    ], [R, R, R, 0]);
    eq("enforcement/1.6 github.com に解決できる別名の scp・ssh 形式を GitHub として読む", [githubRepoOf("git@gh-alias:acme/app.git"), githubRepoOf("ssh://git@gh-alias/acme/app.git")], [R, R]);
    eq("enforcement/1.6 別名の解決は ssh -G を、ユーザー指定と -- 付きで、読み取りのみで呼ぶ", calls()[0], "-G -l git -- gh-alias");
    const n = calls().length;
    githubRepoOf("git@gh-alias:acme/other.git");
    eq("enforcement/1.6 同じ別名の解決は同じプロセスで覚える", calls().length, n);
    eq("enforcement/1.7 github.com 以外に解決される別名・解決に失敗する別名・不正な別名は読めない", [
      githubRepoOf("git@ghes-alias:acme/app.git"), githubRepoOf("git@fail-alias:acme/app.git"), githubRepoOf("git@-oProxyCommand=x:acme/app.git"), githubRepoOf("git@unknown-alias:acme/app.git"),
    ], [null, null, null, null]);
    eq("enforcement/1.7 認証情報付きの URL と GitHub 以外の https は読めない", [
      githubRepoOf("https://user:token@github.com/acme/app.git"), githubRepoOf("https://token@github.com/acme/app.git"), githubRepoOf("https://example.com/acme/app.git"), githubRepoOf(null),
    ], [null, null, null, null]);
    eq("enforcement/1.7 不正な別名（記号を含む）では ssh を実行しない", calls().some((c) => c.includes("ProxyCommand")), false);
    eq("enforcement/1.6 ssh:// のポートは ssh -G に渡し、ポートごとに解決する", [githubRepoOf("ssh://git@port-alias:2222/acme/app.git"), githubRepoOf("ssh://git@port-alias/acme/app.git")], [R, null]);
    eq("enforcement/1.7 git:// や https:// のホストには SSH の別名の解決を使わない", [parseRepoSpec("git://gh-alias/acme/app.git", "github.com", false)?.host, parseRepoSpec("https://gh-alias/acme/app.git", "github.com", false)?.host], ["gh-alias", "gh-alias"]);
    const t0 = Date.now();
    const slow = githubRepoOf("git@slow-alias:acme/app.git");
    eq("enforcement/1.7 解決が時間切れになる別名は読めず、時間内に戻る", [slow, Date.now() - t0 < 5500], [null, true]);
    eq("enforcement/1.6 canonicalSshHost は github.com に解決できる別名だけ github.com にする", [canonicalSshHost("gh-alias", "git"), canonicalSshHost("ghes-alias", "git"), canonicalSshHost("github.com", "git")], ["github.com", "ghes-alias", "github.com"]);
    eq("enforcement/1.8 別名ホストが原因なら、ホスト名と対処を含む文言にする（URL は出さない）", (() => {
      const t = unknownDestinationText("origin", "git@fail-alias:acme/app.git");
      return [t.includes("fail-alias"), t.includes("SSH の別名"), t.includes("https の remote"), t.includes("acme/app")];
    })(), [true, true, true, false]);
    eq("enforcement/1.8 別名が原因でないときは従来の文言", [unknownDestinationText("origin", "https://example.com/a/b.git"), aliasHostOf("git@github.com:a/b.git"), aliasHostOf("git@fail-alias:a/b.git")], ["push 先のリモート（origin）を GitHub のリポジトリとして確定できません。", null, "fail-alias"]);
    eq("enforcement/1.8 認証情報付きの URL は秘密値を文言に出さない", unknownDestinationText("origin", "https://user:secret@github.com/a/b.git").includes("secret"), false);

    // ---- 13.2 GitHub 操作の対象の確定 ----
    eq("enforcement/1.6 parseRepoSpec は別名の scp・ssh 形式を github.com として読み、GHES など解決できない別名はそのまま", [
      parseRepoSpec("git@gh-alias:acme/app.git", "github.com", false)?.host, parseRepoSpec("ssh://git@gh-alias/acme/app.git", "github.com", false)?.host,
      parseRepoSpec("git@ghes-alias:acme/app.git", "github.com", false)?.host, parseRepoSpec("git@github.com:acme/app.git", "github.com", false)?.host,
    ], ["github.com", "github.com", "ghes-alias", "github.com"]);
    {
      const r = mkRepoWithRemote({ branch: "dev/foo", config: CONFIG });
      try {
        const d = r.dir;
        gitOut(d, "remote", "set-url", "origin", "git@gh-alias:acme/app.git");
        gitOut(d, "remote", "set-url", "--push", "origin", r.remote);
        const ev = (cmd) => { const op = classifyCommand(cmd, d).operations[0]; return evaluate(op, contextFor(op, {})); };
        const ok = ev("gh pr create -R acme/app --head dev/foo --base main --title t --body b");
        eq("enforcement/1.6 別名 origin の作業ディレクトリで、同じリポジトリを -R で指定した PR 作成は作成先の不一致で拒否されない", ok.code !== "pr-create-repository", true);
        const other = ev("gh pr create -R acme/other --head dev/foo --base main --title t --body b");
        eq("enforcement/1.7 別のリポジトリの PR 作成は従来どおり拒否される", other.code, "pr-create-repository");
        gitOut(d, "remote", "set-url", "origin", "git@fail-alias:acme/app.git");
        const un = ev("gh pr create -R acme/app --head dev/foo --base main --title t --body b");
        eq("enforcement/1.8 解決できない別名 origin では拒否され、理由に別名ホストの案内が付く", [un.code, String(un.reason ?? "").includes("fail-alias"), String(un.reason ?? "").includes("https の remote")], ["pr-create-repository", true, true]);
      } finally { r.cleanup(); }
    }

    // ---- 13.3 完了公開の送り先 ----
    {
      const r = mkRepoWithRemote({ branch: "dev/foo", config: CONFIG });
      try {
        const d = r.dir;
        gitOut(d, "remote", "set-url", "origin", "git@gh-alias:acme/app.git");
        const id = publish.startWork(d, { sessionId: "s1" }).work.workId;
        const ready = publish.markReady(d, id, { completion: "完了", verification: { passed: true, summary: "ok" }, repository: { id: 4242, owner: "acme", name: "app" } });
        eq("enforcement/1.6 別名 origin（github.com に解決）で、準備済みの記録の作成が通る", ready.ok, true);
        const plan = publish.issuePlan(d, id, { repository: { id: 4242, owner: "acme", name: "app" }, existing: { ok: true, pull: null } });
        eq("enforcement/1.6 別名 origin で公開計画の発行が通る", plan.ok, true);
        gitOut(d, "remote", "set-url", "origin", "git@fail-alias:acme/app.git");
        const id2 = publish.startWork(d, { sessionId: "s2" }).work.workId;
        const bad = publish.markReady(d, id2, { completion: "完了", verification: { passed: true, summary: "ok" }, repository: { id: 4242, owner: "acme", name: "app" } });
        eq("enforcement/1.8 解決できない別名では宛先不明で止まり、別名ホストの案内を返す", [bad.ok, bad.error?.code, bad.error?.message.includes("fail-alias"), bad.error?.message.includes("https の remote")], [false, "destination-unknown", true, true]);
      } finally { r.cleanup(); }
    }
  } finally {
    process.env.PATH = savedPath;
    resetAliasCache();
    rmSync(bin, { recursive: true, force: true });
  }
};
