// 別コミット（tidy）の試験。selftest.mjs から呼ばれる。実際の一時リポジトリで確かめる。
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previewTidy, tidyChanges, TIDY_SUBJECT } from "../scripts/tidy.mjs";

const git = (cwd, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-C", cwd, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const repo = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "brw-tidy-")));
  execFileSync("git", ["init", "-q", "-b", "dev/x", d], { stdio: "ignore" });
  writeFileSync(join(d, "a.txt"), "a\n");
  writeFileSync(join(d, "old.txt"), "old\n");
  writeFileSync(join(d, ".gitignore"), "ignored.log\n");
  git(d, "add", "-A");
  git(d, "commit", "-q", "-m", "base");
  return d;
};

export const runTidyChecks = async (eq) => {
  // 変更なし
  const clean = repo();
  const head0 = git(clean, "rev-parse", "HEAD");
  eq("brw-pr-handoff/2.6 未コミットの変更が無ければ別コミットを作らない", [tidyChanges(clean).kind, git(clean, "rev-parse", "HEAD") === head0], ["none", true]);

  // 追跡・未追跡・ディレクトリ・改名・ステージ済み・ignore の混在
  const d = repo();
  writeFileSync(join(d, "a.txt"), "a2\n"); // 追跡済みの変更
  mkdirSync(join(d, "dir/sub"), { recursive: true });
  writeFileSync(join(d, "dir/sub/n.txt"), "n\n"); // 未追跡ディレクトリ
  writeFileSync(join(d, "ignored.log"), "x\n"); // ignore 対象
  git(d, "mv", "old.txt", "renamed.txt"); // 改名（ステージ済み）
  const pre = previewTidy(d);
  eq("brw-pr-handoff/2.1 予告は全項目（未追跡ディレクトリの中・改名の旧名と新名）を挙げ、ignore 対象を含めない", [[...pre.files].sort(), pre.secretLike], [["a.txt", "dir/sub/n.txt", "old.txt", "renamed.txt"], []]);
  const r = tidyChanges(d);
  eq("brw-pr-handoff/2.1 追跡済みの変更と未追跡が 1 つの別コミットになる", [r.kind, git(d, "rev-list", "--count", "HEAD").trim(), git(d, "status", "--porcelain").trim()], ["committed", "2", ""]);
  const msg = git(d, "log", "-1", "--format=%B");
  eq("brw-pr-handoff/2.2 件名は決まった文言で、本文にファイルの一覧を書く", [msg.split("\n")[0], msg.includes("- a.txt"), msg.includes("- dir/sub/n.txt"), msg.includes("- renamed.txt")], [TIDY_SUBJECT, true, true, true]);
  eq("brw-pr-handoff/2.3 .gitignore の対象は別コミットに含まれない", git(d, "ls-files").includes("ignored.log"), false);
  eq("brw-pr-handoff/2.5 戻り値に含めたファイルの一覧とコミットの OID を持つ", [r.oid === git(d, "rev-parse", "HEAD").trim(), r.files.includes("dir/sub/n.txt")], [true, true]);
  eq("brw-pr-handoff/2.6 別コミットの後は再実行しても何も作らない", tidyChanges(d).kind, "none");

  // 秘密らしい名前
  const s = repo();
  writeFileSync(join(s, "a.txt"), "a2\n");
  writeFileSync(join(s, ".env"), "TOKEN=x\n");
  mkdirSync(join(s, "cfg"));
  writeFileSync(join(s, "cfg", "service-credentials.json"), "{}\n");
  writeFileSync(join(s, "id_rsa"), "k\n");
  const head = git(s, "rev-parse", "HEAD");
  const b = tidyChanges(s);
  eq("brw-pr-handoff/2.4 秘密らしい名前があれば、何も commit せず blocked で対象のファイル名を返す", [b.kind, [...b.secretLike].sort(), git(s, "rev-parse", "HEAD") === head, git(s, "diff", "--cached", "--name-only").trim()], ["blocked", [".env", "cfg/service-credentials.json", "id_rsa"], true, ""]);
  const only = repo();
  writeFileSync(join(only, "server.pem"), "p\n");
  eq("brw-pr-handoff/2.4 *.pem も止める", tidyChanges(only).kind, "blocked");

  // コミットの失敗（pre-commit フックの失敗）
  const f = repo();
  writeFileSync(join(f, "a.txt"), "a2\n");
  mkdirSync(join(f, ".git/hooks"), { recursive: true });
  writeFileSync(join(f, ".git/hooks/pre-commit"), "#!/bin/sh\necho 'フックが拒否'\nexit 1\n");
  chmodSync(join(f, ".git/hooks/pre-commit"), 0o755);
  const headF = git(f, "rev-parse", "HEAD");
  const ff = tidyChanges(f);
  eq("brw-pr-handoff/2.7 コミットに失敗したときは failed で理由を返し、フックは回避しない", [ff.kind, ff.message.includes("別コミットを作れませんでした"), git(f, "rev-parse", "HEAD") === headF], ["failed", true, true]);
};
