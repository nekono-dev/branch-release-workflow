// フックの登録と導入状態の検査（brw-enforcement 6.3）の契約テスト。selftest.mjs から呼ばれる。
// 実際のホストは呼ばず、一時ディレクトリの設定ファイルだけを読み書きする。利用者の ~/.codex や ~/.claude には触れない。
import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkClaudeHooks, installCodexHooks, registrationSourceOf, mergeCodexHooks, codexCommand } from "../scripts/hook-install.mjs";
import { gitOut, mkRepoWithRemote, mkWorktree } from "./support/git-fixture.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL = join(root, "scripts/install-codex.mjs");
const LAUNCHER = join(root, "scripts/agent-hooks.mjs");
// 空白と引用符を含む実体パス。シェルで 1 語として扱えることを確かめる
const ODD = "/opt/brw's clone/scripts/agent-hooks.mjs";
const OLD = "/old/clone/scripts/agent-hooks.mjs";
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const codexFile = (dir) => join(dir, ".codex", "hooks.json");

/** 一時の導入先（Git ではないディレクトリ）と後始末。 */
const plain = () => {
  const dir = mkdtempSync(join(tmpdir(), "brw-hook-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

/** 利用者が既に持つ hooks.json を置く。 */
const writeRaw = (dir, text) => {
  mkdirSync(join(dir, ".codex"), { recursive: true });
  writeFileSync(codexFile(dir), text);
};

/** 一時の Claude プラグイン（hooks/hooks.json）を作る。 */
const pluginWith = (doc) => {
  const dir = mkdtempSync(join(tmpdir(), "brw-plugin-"));
  if (doc !== undefined) {
    mkdirSync(join(dir, "hooks"));
    writeFileSync(join(dir, "hooks/hooks.json"), typeof doc === "string" ? doc : JSON.stringify(doc));
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

export const runHookInstallChecks = async (eq) => {
  // ---- Claude プラグインの登録（hooks/hooks.json）----
  eq("hook-install/6.3 同梱の hooks/hooks.json は Claude の 4 件の登録を満たす", checkClaudeHooks(root).status, "registered");
  {
    // 旧 brw.mjs hook が残っていると二重判定になるため、衝突として報告する
    const p = pluginWith({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/brw.mjs" hook' }] }] } });
    try {
      eq("hook-install/6.3 旧 brw.mjs hook が残る Claude の登録は衝突として報告する", checkClaudeHooks(p.dir).status, "conflict");
    } finally {
      p.cleanup();
    }
  }
  {
    const p = pluginWith(undefined);
    try {
      eq("hook-install/6.3 hooks/hooks.json が無い Claude は未導入として報告する", checkClaudeHooks(p.dir).status, "missing");
    } finally {
      p.cleanup();
    }
  }

  // ---- 導入元の特定（通常のディレクトリ）----
  {
    const r = plain();
    try {
      eq("hook-install/6.3 Git の外のディレクトリは自身を導入元にする", registrationSourceOf(r.dir), { source: realpathSync(r.dir), linked: false, git: false, worktree: undefined });
    } finally {
      r.cleanup();
    }
  }

  // ---- Codex: 新規導入・冪等・既存保持・絶対パス ----
  {
    const r = plain();
    try {
      const first = installCodexHooks({ repoDir: r.dir, launcherPath: ODD });
      const doc = readJson(codexFile(r.dir));
      eq("hook-install/6.3 Codex の新規導入は信頼待ちの untrusted を返し、4 イベントを登録する", [first.status, first.trust, Object.keys(doc.hooks).sort()], ["untrusted", "review-required", ["PermissionRequest", "PostToolUse", "PreToolUse", "Stop"]]);
      eq("hook-install/6.3 ランチャーは実体の絶対パスを空白と引用符を含めて 1 語に埋め込む", doc.hooks.PreToolUse[0].hooks[0].command, "node '/opt/brw'\\''s clone/scripts/agent-hooks.mjs' codex PreToolUse");
      eq("hook-install/6.3 Stop は matcher を持たず、PreToolUse は Bash と mcp__ の 2 件に分かれる", [doc.hooks.Stop?.[0]?.matcher, doc.hooks.PreToolUse?.map((g) => g.matcher)], [undefined, ["Bash", "mcp__.*"]]);
      const before = readFileSync(codexFile(r.dir), "utf8");
      const second = installCodexHooks({ repoDir: r.dir, launcherPath: ODD });
      eq("hook-install/6.3 同じ登録の再実行は変更なしで終わる（冪等）", [second.status, second.trust, second.changes.length, readFileSync(codexFile(r.dir), "utf8") === before], ["registered", "unknown", 0, true]);
    } finally {
      r.cleanup();
    }
  }
  {
    // 利用者の既存定義（別のフック・他のイベント・他の項目）を壊さず、同じ matcher の別定義は衝突として報告する
    const r = plain();
    try {
      writeRaw(r.dir, JSON.stringify({
        description: "利用者の設定",
        hooks: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo user" }] }],
          SessionStart: [{ hooks: [{ type: "command", command: "echo start" }] }],
        },
      }));
      const res = installCodexHooks({ repoDir: r.dir, launcherPath: LAUNCHER });
      const doc = readJson(codexFile(r.dir));
      const userKept = (doc.hooks?.PreToolUse ?? []).some((g) => (g.hooks ?? []).some((h) => h.command === "echo user"));
      eq("hook-install/6.3 既存の利用者定義・他のイベント・説明項目を保持する", [doc.description, userKept, doc.hooks?.SessionStart?.[0]?.hooks?.[0]?.command], ["利用者の設定", true, "echo start"]);
      eq("hook-install/6.3 同じイベント・matcher に別定義があれば衝突として報告する", res.conflicts.map((c) => [c.event, c.matcher, c.kind]), [["PreToolUse", "Bash", "shared-matcher"]]);
    } finally {
      r.cleanup();
    }
  }
  {
    // 古いクローンの絶対パスを指す自分の定義は、重複させず置き換える
    const r = plain();
    try {
      writeRaw(r.dir, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: codexCommand(OLD, "PreToolUse") }] }] } }));
      const res = installCodexHooks({ repoDir: r.dir, launcherPath: LAUNCHER });
      const doc = readJson(codexFile(r.dir));
      const bashGroups = (doc.hooks?.PreToolUse ?? []).filter((g) => g.matcher === "Bash");
      eq("hook-install/6.3 古い絶対パスの自分の定義は置き換え、重複させない", [res.status, bashGroups.length, bashGroups[0]?.hooks?.[0]?.command, res.changes.some((c) => c.action === "update")], ["untrusted", 1, codexCommand(LAUNCHER, "PreToolUse"), true]);
    } finally {
      r.cleanup();
    }
  }
  {
    // 旧 brw.mjs hook の定義は二重判定になるため、書き換えず衝突にする
    const r = plain();
    try {
      const text = JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node '/x/brw.mjs' hook" }] }] } });
      writeRaw(r.dir, text);
      const res = installCodexHooks({ repoDir: r.dir, launcherPath: LAUNCHER });
      eq("hook-install/6.3 旧 brw.mjs hook が残る場合は衝突として書き換えない", [res.status, readFileSync(codexFile(r.dir), "utf8") === text], ["conflict", true]);
    } finally {
      r.cleanup();
    }
  }
  {
    // 解釈できない既存ファイルは書き換えない
    const r = plain();
    try {
      writeRaw(r.dir, "{oops");
      const res = installCodexHooks({ repoDir: r.dir, launcherPath: LAUNCHER });
      eq("hook-install/6.3 JSON として読めない既存ファイルは衝突として書き換えない", [res.status, readFileSync(codexFile(r.dir), "utf8")], ["conflict", "{oops"]);
    } finally {
      r.cleanup();
    }
  }
  {
    // コマンドフックが使えない実行環境・フックが無効な設定では登録せず、未対応として返す
    const r = plain();
    try {
      const a = installCodexHooks({ repoDir: r.dir, launcherPath: LAUNCHER, commandHooks: false });
      const b = installCodexHooks({ repoDir: r.dir, launcherPath: LAUNCHER, featuresText: "[features]\nhooks = false\n" });
      eq("hook-install/6.4 コマンドフックを使えない環境と hooks 無効の設定は unsupported とし、書き込まない", [a.status, b.status, existsSync(join(r.dir, ".codex"))], ["unsupported", "unsupported", false]);
    } finally {
      r.cleanup();
    }
  }

  // ---- worktree の登録元と継承 ----
  {
    const r = mkRepoWithRemote({ branch: "main" });
    try {
      const wt = mkWorktree(r.dir, "dev/hook-wt");
      const src = registrationSourceOf(wt);
      const res = installCodexHooks({ repoDir: wt, launcherPath: LAUNCHER });
      eq("hook-install/6.3 linked worktree からの導入は親チェックアウトの .codex/hooks.json を登録元にする", [src.linked, src.source === realpathSync(r.dir), res.source === realpathSync(r.dir), existsSync(codexFile(r.dir)), existsSync(join(wt, ".codex"))], [true, true, true, true, false]);
      const again = installCodexHooks({ repoDir: r.dir, launcherPath: LAUNCHER });
      eq("hook-install/6.3 親チェックアウトから再実行しても同じ定義を二重登録しない", [again.status, again.changes.length], ["registered", 0]);
      // worktree 側に同じ定義がある場合は、継承と二重になるため衝突として止める
      const dup = mkWorktree(r.dir, "dev/hook-dup");
      writeFileSync(join(dup, "placeholder.txt"), "");
      mkdirSync(join(dup, ".codex"), { recursive: true });
      writeFileSync(codexFile(dup), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: codexCommand(LAUNCHER, "Stop") }] }] } }));
      const d = installCodexHooks({ repoDir: dup, launcherPath: LAUNCHER });
      eq("hook-install/6.3 worktree 側に同じ自分の定義があれば二重登録として衝突にする", d.status, "conflict");
    } finally {
      r.cleanup();
    }
  }

  // ---- 純粋な変換（mergeCodexHooks）----
  {
    const m = mergeCodexHooks({}, LAUNCHER);
    eq("hook-install/6.3 空の設定へのマージは 6 件の追加を報告する", [m.changes.length, m.blocked ?? null], [6, null]);
  }

  // ---- 導入スクリプト（install-codex.mjs --repo）----
  {
    const r = plain();
    const skills = mkdtempSync(join(tmpdir(), "brw-skills-"));
    const home = mkdtempSync(join(tmpdir(), "brw-home-"));
    try {
      // テスト用 HOME で実行し、実際の ~/.codex・~/.agents を変えない
      const out = spawnSync("node", [INSTALL, "--skills-dir", skills, "--repo", r.dir], { encoding: "utf8", env: { ...process.env, HOME: home, CODEX_HOME: join(home, ".codex") } });
      eq("hook-install/6.3 install-codex.mjs --repo はスキルのリンクとフックの登録を同時に行う", [out.status, existsSync(codexFile(r.dir))], [0, true]);
    } finally {
      r.cleanup();
      rmSync(skills, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }

  // ---- 利用者の類似コマンドは自分の定義と取り違えない（指摘 1）----
  {
    const r = plain();
    try {
      const lookalikes = ["my-audit /other/agent-hooks.mjs codex Stop", "node /other/agent-hooks.mjs codex Stop", "node '/other/agent-hooks.mjs' codex Stop --extra"];
      writeRaw(r.dir, JSON.stringify({
        hooks: {
          Stop: [{ hooks: lookalikes.map((c) => ({ type: "command", command: c })) }],
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-audit /x/brw.mjs hook" }] }],
        },
      }));
      const res = installCodexHooks({ repoDir: r.dir, launcherPath: LAUNCHER });
      const doc = readJson(codexFile(r.dir));
      const stopCmds = (doc.hooks?.Stop ?? []).flatMap((g) => (g.hooks ?? []).map((h) => h.command));
      eq("hook-install/6.3 前後に別の語がある・未引用・余分な語の類似コマンドは自分の定義と取り違えず保持する", [res.status, lookalikes.every((c) => stopCmds.includes(c)), stopCmds.includes(codexCommand(LAUNCHER, "Stop")), doc.hooks.PreToolUse[0].hooks[0].command], ["untrusted", true, true, "my-audit /x/brw.mjs hook"]);
    } finally {
      r.cleanup();
    }
  }

  // ---- 機械判別の理由コードと管理対象フックの要否（指摘 2）----
  {
    const r = plain();
    try {
      const a = installCodexHooks({ repoDir: r.dir, launcherPath: LAUNCHER, commandHooks: false });
      const b = installCodexHooks({ repoDir: r.dir, launcherPath: LAUNCHER, featuresText: "[features]\ncodex_hooks = false\n" });
      const ok = installCodexHooks({ repoDir: r.dir, launcherPath: LAUNCHER });
      eq("hook-install/6.4 unsupported は reasonCode と managedHooksRequired を返し、登録済みは理由なし", [[a.status, a.reasonCode, a.managedHooksRequired], [b.status, b.reasonCode, b.managedHooksRequired], [ok.status, ok.reasonCode, ok.managedHooksRequired]], [["unsupported", "command-hooks-unavailable", true], ["unsupported", "hooks-disabled", false], ["untrusted", null, false]]);
    } finally {
      r.cleanup();
    }
  }
  {
    const r = plain();
    try {
      writeRaw(r.dir, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node '/x/brw.mjs' hook" }] }] } }));
      const res = installCodexHooks({ repoDir: r.dir, launcherPath: LAUNCHER });
      const claude = checkClaudeHooks(pluginWith({ hooks: { Stop: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/brw.mjs" hook' }] }] } }).dir);
      eq("hook-install/6.4 衝突の理由は reasonCode で機械判別できる", [res.reasonCode, claude.reasonCode], ["legacy-brw-hook", "legacy-brw-hook"]);
    } finally {
      r.cleanup();
    }
  }

  // ---- 形の崩れた既存定義は例外にせず非破壊で止める（指摘 3）----
  {
    const bad = [
      { hooks: { PreToolUse: [null] } },
      { hooks: { PreToolUse: [{ matcher: "Bash", hooks: "x" }] } },
      { hooks: { PreToolUse: [{ matcher: 1, hooks: [] }] } },
      { hooks: { PreToolUse: [{ hooks: [null] }] } },
      { hooks: { PreToolUse: "x" } },
      { hooks: [] },
      [],
    ];
    const outs = bad.map((doc) => {
      try {
        const m = mergeCodexHooks(doc, LAUNCHER);
        return [m.blocked !== null, m.reasonCode];
      } catch (error) {
        return ["threw", error.message];
      }
    });
    eq("hook-install/6.3 形の崩れた既存定義は例外にせず blocked（shape-mismatch）として扱う", outs, bad.map(() => [true, "shape-mismatch"]));
  }
  {
    const r = plain();
    const skills = mkdtempSync(join(tmpdir(), "brw-skills-"));
    const home = mkdtempSync(join(tmpdir(), "brw-home-"));
    try {
      const text = JSON.stringify({ hooks: { PreToolUse: [null] } });
      writeRaw(r.dir, text);
      const res = installCodexHooks({ repoDir: r.dir, launcherPath: LAUNCHER });
      eq("hook-install/6.3 形の崩れたファイルは衝突として書き換えない", [res.status, res.reasonCode, readFileSync(codexFile(r.dir), "utf8") === text], ["conflict", "shape-mismatch", true]);
      const out = spawnSync("node", [INSTALL, "--skills-dir", skills, "--repo", r.dir], { encoding: "utf8", env: { ...process.env, HOME: home, CODEX_HOME: join(home, ".codex") } });
      eq("hook-install/6.3 install-codex --repo は形の崩れた定義でもスタックトレースを出さず exit 1 で止まり、書き換えない", [out.status, out.stderr.includes("    at "), out.stderr.includes("形が想定と違います"), readFileSync(codexFile(r.dir), "utf8") === text], [1, false, true, true]);
    } finally {
      r.cleanup();
      rmSync(skills, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }

  // ---- symlink・モード・原子性（指摘 4）----
  {
    const r = plain();
    const other = plain();
    try {
      mkdirSync(join(r.dir, ".codex"));
      const real = join(other.dir, "real-hooks.json");
      writeFileSync(real, "{}");
      symlinkSync(real, codexFile(r.dir));
      const res = installCodexHooks({ repoDir: r.dir, launcherPath: LAUNCHER });
      eq("hook-install/6.3 .codex/hooks.json が symlink なら書き換えず衝突にし、symlink を保つ", [res.status, res.reasonCode, lstatSync(codexFile(r.dir)).isSymbolicLink(), readFileSync(real, "utf8")], ["conflict", "symlink", true, "{}"]);
    } finally {
      r.cleanup();
      other.cleanup();
    }
  }
  {
    const r = plain();
    try {
      writeRaw(r.dir, JSON.stringify({ description: "keep" }));
      chmodSync(codexFile(r.dir), 0o640);
      const ino = statSync(codexFile(r.dir)).ino;
      // umask を絞り、作成時のモードだけでは 0640 にならないことを確かめる（既存モードを明示的に引き継ぐ）
      const oldUmask = process.umask(0o077);
      let res;
      try {
        res = installCodexHooks({ repoDir: r.dir, launcherPath: LAUNCHER });
      } finally {
        process.umask(oldUmask);
      }
      const st = statSync(codexFile(r.dir));
      // inode が変わる = 一時ファイルからの置換で書かれた（直接書き込みなら inode は同じ）。一時ファイルは残さない
      eq("hook-install/6.3 既存ファイルのモードを引き継ぎ、一時ファイルを残さず、置換で書く", [res.status, st.mode & 0o777, st.ino !== ino, readdirSync(join(r.dir, ".codex")).sort()], ["untrusted", 0o640, true, ["hooks.json"]]);
    } finally {
      r.cleanup();
    }
  }

  // ---- 共通ディレクトリが .git でない linked worktree は登録元を決めない（指摘 5）----
  {
    const sep = mkdtempSync(join(tmpdir(), "brw-sep-"));
    try {
      const repo = join(sep, "work");
      mkdirSync(repo);
      gitOut(repo, "init", "-q", "-b", "main", `--separate-git-dir=${join(sep, "store.git")}`);
      gitOut(repo, "commit", "-q", "--allow-empty", "-m", "初期");
      const wt = join(sep, "wt");
      gitOut(repo, "worktree", "add", "-q", "-b", "dev/sep", wt);
      const src = registrationSourceOf(wt);
      const res = installCodexHooks({ repoDir: wt, launcherPath: LAUNCHER });
      eq("hook-install/6.3 共通ディレクトリが .git でない linked worktree は登録元を決めず衝突として報告し、書かない", [src.source, src.reasonCode, res.status, res.reasonCode, existsSync(join(repo, ".codex")), existsSync(join(sep, ".codex"))], [null, "unknown-common-dir", "conflict", "unknown-common-dir", false, false]);
    } finally {
      rmSync(sep, { recursive: true, force: true });
    }
  }
};
