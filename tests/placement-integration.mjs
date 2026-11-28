// 配置先と旧置き場の統合試験（brw-branch-gate の 7.3・7.4・7.5・7.6・7.7・7.9・7.10・2.6）。selftest.mjs から呼ばれる（selftest への登録は 7.4 が行う）。
// 一時リポジトリと bare remote の上で brw を子プロセスとして動かし、フックの判定は公開関数 handleHook を呼ぶ。通信はしない。
// 一時ディレクトリは mkdtempSync で作り、finally で後始末する。
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { handleHook } from "../scripts/agent-hooks.mjs";
import { gitOut, mkRepoWithRemote, mkWorktree } from "./support/git-fixture.mjs";
import { hookInput } from "./support/hook-fixtures.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const BRW = join(here, "..", "scripts", "brw.mjs");
const SCRIPTS = join(here, "..", "scripts");
// 開発ブランチ dev/*、保護 main、分岐元 develop（branch-ops の宣言と同じ）
const CFG = { workBranches: ["dev/*"], protectedBranches: ["main"], baseBranch: "develop", namePattern: "^dev/[a-z0-9]+(-[a-z0-9]+)*$", preview: { provider: "none" } };
// 利用者の Git 設定に左右されないための作者情報
const ID = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
// 無視の警告の文言（この出現回数で数える）
const WARN = "`.worktree/` が導入先で無視されていません";

const brw = (cwd, args) => spawnSync("node", [BRW, ...args], { cwd, encoding: "utf8", env: { ...process.env, ...ID } });
// 標準出力と標準エラーをつないだ文字列（案内・警告の検査用）
const out = (r) => `${r.stdout}${r.stderr}`;
const warnCount = (s) => s.split(WARN).length - 1;
// フックの応答（Claude の PreToolUse）から判定と理由を取り出す
const decisionOf = (res) => res?.hookSpecificOutput?.permissionDecision ?? null;
const reasonOf = (res) => res?.hookSpecificOutput?.permissionDecisionReason ?? "";
const bashHook = (cwd, command) => handleHook("claude", "PreToolUse", hookInput("claude", "PreToolUse", { cwd, command }));
const enterHook = (cwd, toolInput) => handleHook("claude", "PreToolUse", hookInput("claude", "PreToolUse", { cwd, tool: "EnterWorktree", toolInput }));

// 分岐元 develop を持つリポジトリ。develop は遠隔へ push 済みで、作業ツリーは develop 上にある
const mkTeam = () => {
  const r = mkRepoWithRemote({ branch: "main", config: CFG });
  gitOut(r.dir, "checkout", "-q", "-b", "develop");
  gitOut(r.dir, "push", "-q", "origin", "develop");
  return r;
};
// 遠隔にだけ残るブランチを作る（ローカルの枝は消す）
const remoteOnly = (dir, branch) => {
  gitOut(dir, "branch", branch, "develop");
  gitOut(dir, "push", "-q", "origin", branch);
  gitOut(dir, "branch", "-D", branch);
};
// ブランチの指す commit（無ければ null。消えたブランチを読んでも例外にしない）
const shaOf = (cwd, ref) => {
  const r = spawnSync("git", ["rev-parse", "--verify", "--quiet", ref], { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
};
// 無視の設定ファイル（.gitignore・.git/info/exclude）の内容。無ければ null
const ignoreFiles = (dir) => [".gitignore", ".git/info/exclude"].map((p) => (existsSync(join(dir, p)) ? readFileSync(join(dir, p), "utf8") : null));
// 無視の設定の文字列の列のうち、`.worktree` を含む行の数（null は 0 行とみなす）。create・resume の前後で増えていないかを見る
const placementLineCount = (texts) => texts.reduce((n, s) => n + (s ?? "").split("\n").filter((x) => x.includes(".worktree")).length, 0);
// 操作の前後で `.worktree` の行が増えた数（既存の行や `.codex/` の追記は数えない）
const addedPlacementLines = (prev, next) => placementLineCount(next) - placementLineCount(prev);

// 旧置き場を表す形: `claude` と `worktrees` の間に、英数字以外の区切りが 1 文字以上ある（長い改行・インデントを挟む分割も、長さの上限なしで検出する）
const LEGACY_RE = /claude\W+worktrees/g;
// 一致の直後が `.brw` の置き場（`.claude/worktrees/.brw/…` や `join(main, ".claude", "worktrees", ".brw", …)`）だけは許す。
// `.brw` の後ろはパス要素の終端（英数字・`-`・`_`・`.` 以外）でなければならず、`.brw-old`・`.brwx` は違反にする
const BRW_AFTER_RE = /^\W+\.brw(?![A-Za-z0-9_.-])/;
// 本文置き場（`.brw`）の形を許す行の組: 実行物の相対パスごとに、行の内容（前後の空白を除いた文字列）を並べる。
// 行番号では照合しない。許可した行の内容が変わると違反になり、見直しを要する。
// 許すのは本文置き場の本文パス生成・ルート取得・その説明とエラーメッセージの行だけ（`.brw` の置き場自体は移さない）。
const BRW_ALLOWED_LINES = {
  "scripts/pr-template.mjs": new Set([
    "/** 本文ファイルの場所: <本体>/.claude/worktrees/.brw/<alias>.md（作業ツリーの外） */",
    'export const bodyPathOf = (mainPath, branch) => join(mainPath, ".claude", "worktrees", ".brw", `${aliasOf(branch)}.md`);',
  ]),
  "scripts/agent-hooks.mjs": new Set([
    "// 絶対パスは、本体の worktree 置き場（.claude/worktrees/.brw/）の配下だけ。相対パスは作業ディレクトリの配下",
    'root = realpathSync(join(main, ".claude", "worktrees", ".brw"));',
  ]),
  "scripts/publish-cli.mjs": new Set([
    "*   - 本体の worktree 置き場（<本体>/.claude/worktrees/.brw/）の配下の絶対パス（brw pr-template が作る本文ファイル）",
    'const bad = { error: "本文ファイルは作業ディレクトリ配下の相対パスか、brw pr-template が作る本文置き場（.claude/worktrees/.brw/）の配下の絶対パスで指定してください。" };',
    'root = realpathSync(join(main, ".claude", "worktrees", ".brw"));',
  ]),
};

// 実行物（scripts/ の配下のすべての .mjs）に、旧置き場の文字列の違反を集める。
// 許すのは scripts/placement.mjs の中と、BRW_ALLOWED_LINES に載った行の中で一致の直後が `.brw` の置き場だけ。判定は行ではなく一致した箇所ごとに行う。
// 戻り値: 検査したファイル数と、違反の「相対パス:行番号: 行の内容」の列（1 行に複数の違反があっても 1 件）。
export const findLegacyStrings = (scriptsDir) => {
  const root = dirname(scriptsDir);
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".mjs")) files.push(p);
    }
  };
  walk(scriptsDir);
  const hits = [];
  for (const p of files) {
    const rel = relative(root, p).split(sep).join("/");
    if (rel === "scripts/placement.mjs") continue;
    const allowed = BRW_ALLOWED_LINES[rel] ?? new Set();
    // 行ごとではなくファイル全体の文字列に対して走査し、行をまたぐ形（join の引数を行ごとに分けた形）も見つける
    const content = readFileSync(p, "utf8");
    const reportedLines = new Set();
    for (const m of content.matchAll(LEGACY_RE)) {
      // 一致の開始位置から、その行の番号・行の先頭・行の内容を求める
      const before = content.slice(0, m.index);
      const lineNo = before.split("\n").length;
      const lineStart = before.lastIndexOf("\n") + 1;
      const lineEnd = content.indexOf("\n", m.index);
      const line = content.slice(lineStart, lineEnd === -1 ? content.length : lineEnd);
      const text = line.trim();
      // 一致が行をまたぐ場合は許さない。1 行の中の一致だけ、許可された行の内容の中で直後が `.brw` の置き場なら許す
      const spansLines = m[0].includes("\n");
      const permitted = !spansLines && allowed.has(text) && BRW_AFTER_RE.test(line.slice(m.index - lineStart + m[0].length));
      // 1 行に複数の違反があっても、その行は 1 件として数える
      if (!permitted && !reportedLines.has(lineNo)) {
        reportedLines.add(lineNo);
        hits.push(`${rel}:${lineNo}: ${text}`);
      }
    }
  }
  return { files: files.length, hits };
};

export const runPlacementIntegrationChecks = async (eq) => {
  // ---- 7.4・7.5・7.6・2.6: 同じ旧置き場の worktree を、4 つの経路が同じ旧パスと新しい配置先で拒否する ----
  {
    const t = mkTeam();
    const main = realpathSync(t.dir);
    try {
      const oldWt = join(main, ".claude", "worktrees", "dev-old");
      const newWt = join(main, ".worktree", "dev-old");
      gitOut(main, "worktree", "add", "-q", oldWt, "-b", "dev/old", "develop");
      const branchBefore = shaOf(main, "refs/heads/dev/old");

      const a = brw(main, ["resume", "dev/old"]);
      const b = brw(main, ["finish", "dev/old"]);
      const c = bashHook(main, "git switch dev/old");
      const d = enterHook(main, { path: oldWt });
      const routes = [out(a), out(b), reasonOf(c), reasonOf(d)];

      eq("brw-branch-gate/7.5 4 経路（resume・finish・置き換え・EnterWorktree の path）は、旧パスを案内に含める", routes.map((s) => s.includes(oldWt)), [true, true, true, true]);
      eq("brw-branch-gate/7.4 4 経路の案内は、同じ新しい配置先（<本体>/.worktree/<別名>）を含める", routes.map((s) => s.includes(newWt)), [true, true, true, true]);
      eq("brw-branch-gate/7.5 resume と finish は終了コード 1 で拒否し、置き換えと EnterWorktree は deny にする", [a.status, b.status, decisionOf(c), decisionOf(d)], [1, 1, "deny", "deny"]);
      eq("brw-branch-gate/7.6 拒否の経路は、旧置き場の worktree・ブランチ・配置先のどれも変えない", [
        existsSync(oldWt), existsSync(oldWt) ? gitOut(oldWt, "branch", "--show-current") : null, shaOf(main, "refs/heads/dev/old") === branchBefore, existsSync(newWt),
      ], [true, "dev/old", true, false]);
      eq("brw-branch-gate/2.6 4 つの案内はすべて、移せないとき（サブモジュールを持つ worktree など）の代替（git worktree remove <旧パス>）を含む", routes.map((s) => s.includes(`git worktree remove ${oldWt}`)), [true, true, true, true]);
      eq("brw-branch-gate/2.6 移す手順を案内する 3 経路は「移せないとき」の代替の説明を含み、finish は手動で片付ける手順を含む", [
        routes[0].includes("移せないとき"), routes[2].includes("移せないとき"), routes[3].includes("移せないとき"), routes[1].includes("手動で片付ける"),
      ], [true, true, true, true]);
      eq("brw-branch-gate/2.6 移す手順は、git worktree move で旧パスから配置先へ移す行と、その後の再開（resume・finish の再実行）を含む", [
        routes[0].includes(`git worktree move ${oldWt} ${newWt}`), routes[0].includes("brw resume dev/old"), routes[1].includes(`git worktree move ${oldWt} ${newWt}`), routes[1].includes("brw finish dev/old"),
      ], [true, true, true, true]);
      eq("brw-branch-gate/2.6 移せないときの手順は、退避・git worktree remove・作り直し（resume）を含み、finish の手動の片付けは remove と branch -d を含む", [
        routes[0].includes("退避"), routes[0].includes(`git worktree remove ${oldWt}`), routes[0].includes("作り直して"), routes[1].includes(`git worktree remove ${oldWt}`), routes[1].includes("git branch -d dev/old"),
      ], [true, true, true, true, true]);
    } finally {
      t.cleanup();
    }
  }

  // ---- 2.6・7.5・7.6: サブモジュールを持つ旧置き場の worktree は git worktree move で移せない。4 経路は旧パス・新しい配置先・代替を案内し、拒否の後も何も失わない ----
  {
    const t = mkTeam();
    const main = realpathSync(t.dir);
    // サブモジュールの元になる一時リポジトリ（本体の外に置く）
    const subSrc = realpathSync(mkdtempSync(join(tmpdir(), "brw-pi-sub-")));
    try {
      gitOut(subSrc, "init", "-q", "-b", "main");
      gitOut(subSrc, "commit", "-q", "--allow-empty", "-m", "sub");
      const oldWt = join(main, ".claude", "worktrees", "dev-sm");
      const newWt = join(main, ".worktree", "dev-sm");
      gitOut(main, "worktree", "add", "-q", oldWt, "-b", "dev/sm", "develop");
      // 旧置き場の worktree の中に実際のサブモジュールを作って commit する
      gitOut(oldWt, "-c", "protocol.file.allow=always", "submodule", "add", subSrc, "sub");
      gitOut(oldWt, "commit", "-q", "-m", "sub を追加");
      // 未コミットの変更を 1 つ置く（拒否の後も残ることを確かめる）
      writeFileSync(join(oldWt, "work.txt"), "未コミットの変更\n");
      const branchBefore = shaOf(main, "refs/heads/dev/sm");

      // git 自身がサブモジュールを持つ worktree の移動を拒否することを確かめる
      const mv = spawnSync("git", ["worktree", "move", oldWt, newWt], { cwd: main, encoding: "utf8" });

      const a = brw(main, ["resume", "dev/sm"]);
      const b = brw(main, ["finish", "dev/sm"]);
      const c = bashHook(main, "git switch dev/sm");
      const d = enterHook(main, { path: oldWt });
      const routes = [out(a), out(b), reasonOf(c), reasonOf(d)];

      eq("brw-branch-gate/2.6 サブモジュールを持つ旧置き場の worktree は、git worktree move が拒否する（移せない前提）", mv.status !== 0, true);
      eq("brw-branch-gate/2.6 サブモジュールを持つ旧 worktree でも、4 経路は旧パス・新しい配置先・git worktree remove の代替を案内する", routes.map((s) => s.includes(oldWt) && s.includes(newWt) && s.includes(`git worktree remove ${oldWt}`)), [true, true, true, true]);
      eq("brw-branch-gate/2.6 サブモジュールを持つ旧 worktree の案内は、移せないときの説明を含む（finish は手動で片付ける手順を含む）", [
        routes[0].includes("移せないとき"), routes[1].includes("手動で片付ける"), routes[2].includes("移せないとき"), routes[3].includes("移せないとき"),
      ], [true, true, true, true]);
      eq("brw-branch-gate/7.5 サブモジュールを持つ旧 worktree でも、resume と finish は終了コード 1 で拒否し、置き換えと EnterWorktree は deny にする", [a.status, b.status, decisionOf(c), decisionOf(d)], [1, 1, "deny", "deny"]);
      eq("brw-branch-gate/7.6 拒否の後も、旧 worktree・サブモジュールのディレクトリ・ブランチ・未コミットの変更は残り、配置先は作られない", [
        existsSync(oldWt), existsSync(join(oldWt, "sub")), gitOut(oldWt, "branch", "--show-current"), readFileSync(join(oldWt, "work.txt"), "utf8"),
        shaOf(main, "refs/heads/dev/sm") === branchBefore, existsSync(newWt),
      ], [true, true, "dev/sm", "未コミットの変更\n", true, false]);
    } finally {
      t.cleanup();
      rmSync(subSrc, { recursive: true, force: true });
    }
  }

  // ---- 7.7: 旧置き場の worktree があっても、別のブランチの create と resume は通る ----
  {
    const t = mkTeam();
    const main = realpathSync(t.dir);
    try {
      gitOut(main, "worktree", "add", "-q", join(main, ".claude", "worktrees", "dev-old"), "-b", "dev/old", "develop");
      const created = brw(main, ["create", "other"]);
      remoteOnly(main, "dev/rem");
      const resumed = brw(main, ["resume", "dev/rem"]);
      eq("brw-branch-gate/7.7 旧置き場の worktree があっても、別のブランチの create は通り、配置先に作る", [created.status, existsSync(join(main, ".worktree", "dev-other")), gitOut(join(main, ".worktree", "dev-other"), "branch", "--show-current")], [0, true, "dev/other"]);
      eq("brw-branch-gate/7.7 旧置き場の worktree があっても、別のブランチの resume（リモートにだけあるもの）は通り、配置先に作る", [resumed.status, existsSync(join(main, ".worktree", "dev-rem")), gitOut(join(main, ".worktree", "dev-rem"), "branch", "--show-current")], [0, true, "dev/rem"]);
    } finally {
      t.cleanup();
    }
  }

  // ---- 7.3: 連携 worktree の中から create・resume しても、本体の .worktree/ に作り、入れ子を作らない ----
  {
    const t = mkTeam();
    const main = realpathSync(t.dir);
    try {
      const w = realpathSync(mkWorktree(t.dir, "dev/outer"));
      remoteOnly(main, "dev/rem2");
      const c = brw(w, ["create", "nest"]);
      const r = brw(w, ["resume", "dev/rem2"]);
      eq("brw-branch-gate/7.3 連携 worktree から create・resume しても、本体の .worktree/ に作り、連携 worktree の中に .worktree/ を作らない", [
        c.status, r.status, existsSync(join(main, ".worktree", "dev-nest")), existsSync(join(main, ".worktree", "dev-rem2")), existsSync(join(w, ".worktree")),
      ], [0, 0, true, true, false]);
    } finally {
      t.cleanup();
    }
  }

  // ---- 7.9・7.10: 無視の警告（子の名前だけの無視・ディレクトリ全体の無視・巻き戻し・ブランチだけ・既存の再利用・判定不能） ----
  {
    // 子の名前だけを無視する設定では、ディレクトリ全体が無視されていないので create が 1 回警告する
    const t = mkTeam();
    try {
      writeFileSync(join(t.dir, ".gitignore"), "/.worktree/dev-x\n");
      const r = brw(t.dir, ["create", "x"]);
      eq("brw-branch-gate/7.9 子の名前だけを無視する設定では、create が警告を 1 回出す", [r.status, warnCount(out(r))], [0, 1]);
    } finally {
      t.cleanup();
    }
  }
  {
    // 子の名前だけを無視する設定で、resume がローカルブランチから作るときも 1 回だけ警告する。警告の文言に git add -A の危険と無視設定の追加を含む
    const t = mkTeam();
    try {
      writeFileSync(join(t.dir, ".gitignore"), "/.worktree/dev-loc\n");
      gitOut(t.dir, "branch", "dev/loc", "develop");
      const r = brw(t.dir, ["resume", "dev/loc"]);
      eq("brw-branch-gate/7.9 子の名前だけを無視する設定で、resume（ローカルブランチから作成）は通って配置先に作り、警告を 1 回出す", [
        r.status, existsSync(join(t.dir, ".worktree", "dev-loc")), gitOut(join(t.dir, ".worktree", "dev-loc"), "branch", "--show-current"), warnCount(out(r)),
      ], [0, true, "dev/loc", 1]);
      eq("brw-branch-gate/7.9 警告の文言は、git add -A による埋め込みリポジトリの危険と、無視設定の追加の必要を含む", [out(r).includes("git add -A"), out(r).includes("無視する設定")], [true, true]);
    } finally {
      t.cleanup();
    }
  }
  {
    // 子の名前だけを無視する設定で、resume が遠隔にだけあるブランチから作り直すときも 1 回だけ警告する
    const t = mkTeam();
    try {
      writeFileSync(join(t.dir, ".gitignore"), "/.worktree/dev-rem3\n");
      remoteOnly(t.dir, "dev/rem3");
      const r = brw(t.dir, ["resume", "dev/rem3"]);
      eq("brw-branch-gate/7.9 子の名前だけを無視する設定で、resume（リモートのみのブランチから再作成）は通って配置先に作り、警告を 1 回出す", [
        r.status, existsSync(join(t.dir, ".worktree", "dev-rem3")), gitOut(join(t.dir, ".worktree", "dev-rem3"), "branch", "--show-current"), warnCount(out(r)),
      ], [0, true, "dev/rem3", 1]);
    } finally {
      t.cleanup();
    }
  }
  {
    // .git/info/exclude でディレクトリ全体を無視している場合は、create は成功し、警告は出ない
    const t = mkTeam();
    try {
      mkdirSync(join(t.dir, ".git", "info"), { recursive: true });
      writeFileSync(join(t.dir, ".git", "info", "exclude"), "/.worktree/\n", { flag: "a" });
      const r = brw(t.dir, ["create", "ex"]);
      eq("brw-branch-gate/7.9 info/exclude でディレクトリ全体を無視している場合は、create は成功して配置先に作り、警告を出さない", [r.status, existsSync(join(t.dir, ".worktree", "dev-ex")), warnCount(out(r))], [0, true, 0]);
    } finally {
      t.cleanup();
    }
  }
  {
    // ディレクトリ全体を無視する設定では警告は出ない
    const t = mkTeam();
    try {
      writeFileSync(join(t.dir, ".gitignore"), "/.worktree/\n");
      const r = brw(t.dir, ["create", "all"]);
      eq("brw-branch-gate/7.9 ディレクトリ全体を無視する設定では、警告は出ない", [r.status, warnCount(out(r))], [0, 0]);
    } finally {
      t.cleanup();
    }
  }
  {
    // --branch-only は worktree を作らないので警告は出ない
    const t = mkTeam();
    try {
      const r = brw(t.dir, ["create", "bo", "--branch-only"]);
      eq("brw-branch-gate/7.9 --branch-only では警告を出さない", [r.status, warnCount(out(r))], [0, 0]);
    } finally {
      t.cleanup();
    }
  }
  {
    // 既存の worktree の再利用（resume の 2 回目）では警告を出さない。作成のときは 1 回出る
    const t = mkTeam();
    try {
      const made = brw(t.dir, ["create", "re"]);
      const reused = brw(t.dir, ["resume", "dev/re"]);
      eq("brw-branch-gate/7.9 作成では警告が 1 回出て、既存の worktree の再利用では出ない", [made.status, warnCount(out(made)), reused.status, warnCount(out(reused))], [0, 1, 0, 0]);
    } finally {
      t.cleanup();
    }
  }
  {
    // --carry の失敗で巻き戻したときは警告を出さない（最終成功ではない）。branch-ops の同じ構成を使う
    const d = realpathSync(mkdtempSync(join(tmpdir(), "brw-pi-rb-")));
    try {
      gitOut(d, "init", "-q", "-b", "develop");
      writeFileSync(join(d, ".branch-release-workflow.json"), JSON.stringify(CFG));
      writeFileSync(join(d, "a.txt"), "a\n");
      gitOut(d, "add", "a.txt");
      gitOut(d, "commit", "-q", "-m", "i");
      gitOut(d, "checkout", "-q", "-b", "side");
      writeFileSync(join(d, "a.txt"), "side\n");
      gitOut(d, "commit", "-q", "-am", "side");
      writeFileSync(join(d, "a.txt"), "dirty\n");
      const r = brw(d, ["create", "rb", "--carry"]);
      eq("brw-branch-gate/7.9 --carry の失敗で巻き戻したときは警告を出さず、配置先も作らない", [r.status !== 0, warnCount(out(r)), existsSync(join(d, ".worktree", "dev-rb"))], [true, 0, false]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }
  {
    // 配置先が判定できない（シンボリックリンク）なら、作らずに止まり、警告も出さない
    const t = mkTeam();
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "brw-pi-elsewhere-")));
    try {
      symlinkSync(elsewhere, join(t.dir, ".worktree"));
      const r = brw(t.dir, ["create", "unk"]);
      eq("brw-branch-gate/7.10 配置先を判定できないときは警告を出さず、作らずに止まる", [r.status, warnCount(out(r)), readdirSync(elsewhere).length], [1, 0, 0]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
      t.cleanup();
    }
  }

  {
    // 無視の状態が判定不能（git check-ignore 自体が終了コード 0・1 以外で失敗する）なら、create は続行して成功し、警告は出さない。
    // PATH の先頭に、配置先のプローブへの check-ignore のときだけ終了コード 128 を返すラッパーを置き、ほかは本物の git に委ねる。
    const t = mkTeam();
    const wrapDir = realpathSync(mkdtempSync(join(tmpdir(), "brw-pi-gitwrap-")));
    try {
      const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
      writeFileSync(join(wrapDir, "git"), `#!/bin/sh\ncase "$*" in *check-ignore*.worktree/.brw-probe*) exit 128 ;; esac\nexec "${realGit}" "$@"\n`);
      chmodSync(join(wrapDir, "git"), 0o755);
      const env = { ...process.env, ...ID, PATH: `${wrapDir}:${process.env.PATH}` };
      // ラッパーが効いていること（プローブの check-ignore が 128 で失敗すること）を先に確かめる
      const probe = spawnSync("git", ["check-ignore", "-q", "--", ".worktree/.brw-probe"], { cwd: t.dir, encoding: "utf8", env });
      const r = spawnSync("node", [BRW, "create", "unk2"], { cwd: t.dir, encoding: "utf8", env });
      eq("brw-branch-gate/7.10 判定不能の準備: ラッパーで check-ignore だけが終了コード 128 で失敗する", probe.status, 128);
      eq("brw-branch-gate/7.10 無視の状態が判定不能でも、create は続行して成功し、配置先に作り、警告を出さない", [
        r.status, existsSync(join(t.dir, ".worktree", "dev-unk2")), warnCount(out(r)),
      ], [0, true, 0]);
      // resume も同じ判定不能で止めず、作成し、警告を出さない（遠隔にだけあるブランチから作る）
      remoteOnly(t.dir, "dev/unk3");
      const r3 = spawnSync("node", [BRW, "resume", "dev/unk3"], { cwd: t.dir, encoding: "utf8", env });
      eq("brw-branch-gate/7.10 判定不能でも resume は続行して成功し、配置先に作り、警告を出さない", [
        r3.status, existsSync(join(t.dir, ".worktree", "dev-unk3")), warnCount(out(r3)),
      ], [0, true, 0]);
    } finally {
      t.cleanup();
      rmSync(wrapDir, { recursive: true, force: true });
    }
  }

  // ---- 7.10: create・resume の前後で、.gitignore と .git/info/exclude に .worktree/ の行が増えない（既存の行や .codex/ の追記は対象外） ----
  {
    const t = mkTeam();
    try {
      // create は新しいブランチ、resume は遠隔にだけあるブランチを使う（同じ名前だと create が止まる）
      remoteOnly(t.dir, "dev/noedit2");
      const before = ignoreFiles(t.dir);
      const c = brw(t.dir, ["create", "noedit"]);
      const afterCreate = ignoreFiles(t.dir);
      const r = brw(t.dir, ["resume", "dev/noedit2"]);
      const afterResume = ignoreFiles(t.dir);
      eq("brw-branch-gate/7.10 create・resume の前後で、.gitignore・info/exclude の .worktree/ の行は増えない", [
        c.status, r.status, addedPlacementLines(before, afterCreate), addedPlacementLines(afterCreate, afterResume),
      ], [0, 0, 0, 0]);
      // 検査そのものの自己検証: .worktree/ の追加は検出し、.codex/ の追加と既存の行は許す
      eq("brw-branch-gate/7.10 増加の検査の自己検証: .worktree/ の行の追加は 1 と数え、.codex/ の追加と既存の .worktree/ の行は数えない", [
        addedPlacementLines([null, null], [null, "/.worktree/\n"]),
        addedPlacementLines([".codex/\n", null], [".codex/\n.codex/x\n", null]),
        addedPlacementLines([null, "/.worktree/\n"], [null, "/.worktree/\n"]),
      ], [1, 0, 0]);
    } finally {
      t.cleanup();
    }
  }

  // ---- 7.3 の検査の自己検証: 旧置き場の文字列の検出規則が、分割された形と行内の別の箇所を見逃さないこと ----
  {
    // 一時の scripts/ に、指定の内容のファイルを置いて findLegacyStrings の違反数を数える
    const countHitsOf = (files) => {
      const d = realpathSync(mkdtempSync(join(tmpdir(), "brw-pi-scan-")));
      try {
        const s = join(d, "scripts");
        mkdirSync(s);
        for (const [name, body] of Object.entries(files)) writeFileSync(join(s, name), body);
        return findLegacyStrings(s).hits;
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    };
    const split = countHitsOf({ "a.mjs": 'const p = join(main, ".claude", "worktrees", "dev-old");\n' });
    const sameLineBrw = countHitsOf({ "b.mjs": 'const x = ".claude/worktrees/dev-old"; // .brw\n' });
    const unlistedBrw = countHitsOf({ "c.mjs": 'const p = join(main, ".claude", "worktrees", ".brw", name);\n' });
    const unlistedSlash = countHitsOf({ "d.mjs": 'const p = ".claude/worktrees/.brw/" + name;\n' });
    // 許可する相対パスと行の内容の組（3 ファイルの実際の行と同じ内容。前後の空白は除いて照合する）
    const allowedPr = countHitsOf({ "pr-template.mjs": 'export const bodyPathOf = (mainPath, branch) => join(mainPath, ".claude", "worktrees", ".brw", `${aliasOf(branch)}.md`);\n' });
    const allowedHook = countHitsOf({ "agent-hooks.mjs": '      root = realpathSync(join(main, ".claude", "worktrees", ".brw"));\n' });
    const allowedPublish = countHitsOf({ "publish-cli.mjs": '  root = realpathSync(join(main, ".claude", "worktrees", ".brw"));\n' });
    const otherBrwInAllowed = countHitsOf({ "agent-hooks.mjs": 'const q = join(main, ".claude", "worktrees", ".brw", "dev-x");\n' });
    const addedInAllowed = countHitsOf({ "publish-cli.mjs": '  root = realpathSync(join(main, ".claude", "worktrees", ".brw")); const q = ".claude/worktrees/dev-x";\n' });
    const splitInAllowed = countHitsOf({ "pr-template.mjs": 'const p = join(main, ".claude", "worktrees", "dev-old");\n' });
    const exemptFile = countHitsOf({ "placement.mjs": 'const LEGACY = ".claude/worktrees/dev-old";\n' });
    const twoOnOneLine = countHitsOf({ "e.mjs": 'const a = ".claude/worktrees/.brw"; const b = ".claude/worktrees/dev-old";\n' });
    eq("brw-branch-gate/7.3 検査の自己検証: 分割された形（join の引数に分けた旧置き場）を 1 件として見つける", split.length, 1);
    eq("brw-branch-gate/7.3 検査の自己検証: 行に .brw があっても、旧置き場の直後が .brw でなければ見つける", sameLineBrw.length, 1);
    eq("brw-branch-gate/7.3 検査の自己検証: 許可されていないファイルの置き場の形（.claude/worktrees/.brw/…）は見つける", [unlistedBrw.length, unlistedSlash.length], [1, 1]);
    eq("brw-branch-gate/7.3 検査の自己検証: 許可する相対パスと行の内容の組（実際の 3 ファイルの行）は見つけない", [allowedPr.length, allowedHook.length, allowedPublish.length], [0, 0, 0]);
    eq("brw-branch-gate/7.3 検査の自己検証: 許可するファイルでも、許可しない行の置き場の形は見つける", otherBrwInAllowed.length, 1);
    eq("brw-branch-gate/7.3 検査の自己検証: 許可する行に旧置き場の追記があれば見つける（同一行への別の旧置き場を許さない）", addedInAllowed.length, 1);
    eq("brw-branch-gate/7.3 検査の自己検証: 許可するファイルでも、分割された形（join の引数に分けた旧置き場）は見つける", splitInAllowed.length, 1);
    eq("brw-branch-gate/7.3 検査の自己検証: scripts/placement.mjs の中は許し、同じ行の別の旧置き場の箇所は一致ごとに見つける", [exemptFile.length, twoOnOneLine.length], [0, 1]);
    const brwOld = countHitsOf({ "f.mjs": 'const p = ".claude/worktrees/.brw-old";\n' });
    const brwX = countHitsOf({ "g.mjs": 'const p = join(main, ".claude", "worktrees", ".brwx");\n' });
    eq("brw-branch-gate/7.3 検査の自己検証: 直後が .brw で始まっても名前が続く形（.brw-old・.brwx）は、置き場ではないので見つける", [brwOld.length, brwX.length], [1, 1]);
    eq("brw-branch-gate/7.3 検査の自己検証: 違反は「相対パス:行番号:」の形で出す", split[0]?.startsWith("scripts/a.mjs:1: ") ?? false, true);
    // 複数行にまたがる形（join の引数を行ごとに分けた形）は、行をまたぐ一致として違反にする。許可する行の内容でも違反にする
    const multiLineJoin = countHitsOf({ "h.mjs": 'const p = join(main,\n    ".claude",\n    "worktrees",\n    "dev-old");\n' });
    const multiLineAllowed = countHitsOf({ "publish-cli.mjs": '  root = realpathSync(join(main,\n    ".claude",\n    "worktrees",\n    ".brw"));\n' });
    eq("brw-branch-gate/7.3 検査の自己検証: 複数行にまたがる join の旧置き場（.claude と worktrees を別の行に置いた形）を 1 件として見つける", [multiLineJoin.length, multiLineJoin[0]?.startsWith("scripts/h.mjs:2: ") ?? false], [1, true]);
    // 区切りが 60 文字を超える長い改行・インデントを挟んだ分割も、1 件として見つける（区切りの長さに上限を置かない）
    const longSeparator = countHitsOf({ "i.mjs": `const p = join(main, ".claude",\n${" ".repeat(70)}"worktrees", "dev-old");\n` });
    eq("brw-branch-gate/7.3 検査の自己検証: 区切りが 60 文字を超える長い改行・インデントの分割も、1 件として見つける", longSeparator.length, 1);
    eq("brw-branch-gate/7.3 検査の自己検証: 許可する行の内容でも、複数行にまたがる一致は許さない", multiLineAllowed.length, 1);
  }

  // ---- 7.3 の機械的な検査: 実行物（scripts/ の .mjs）に旧置き場の文字列が残らない ----
  {
    const { files, hits } = findLegacyStrings(SCRIPTS);
    eq("brw-branch-gate/7.3 実行物（scripts/ の .mjs）は、配置先の部品と .brw の定数以外に旧置き場の文字列を含まない（検査したファイル数は 10 を超える）", [files > 10, hits], [true, []]);
  }
};
