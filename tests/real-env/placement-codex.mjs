// brw-branch-gate 5.2: Codex が配置先 `<本体>/.worktree/<別名>` の linked worktree でも、本体の `.codex/hooks.json` を読むことを確かめる。
// 使い方: BRW_REAL_ENV=1 node tests/real-env/placement-codex.mjs [--keep]
// Codex が cwd で実際に読み込むフックの一覧（app-server の hooks/list）を調べる。モデルは呼ばないため、認証は要らない。
// 認証は複製しない。一時の CODEX_HOME に、各プロジェクトの信頼だけを書いた最小の設定を置く。利用者の ~/.codex は読み書きしない。
// 食い違いがあれば終了コード 1。
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireRealEnv } from "./common.mjs";

requireRealEnv("placement-codex.mjs");

const KEEP = process.argv.includes("--keep");
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "brw-placement-codex-")));
const repo = join(tmp, "r");
const codexHome = join(tmp, "codex-home");

const git = (cwd, ...args) => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} が失敗しました: ${r.stderr}`);
};

// 導入先の実態に合わせる: 本体にだけ未追跡の .codex/hooks.json を置き、worktree には（BRW が作る）空の .codex/ を置く
mkdirSync(repo);
git(repo, "init", "-q", "-b", "main");
writeFileSync(join(repo, ".gitignore"), "/.worktree/\n/.claude/worktrees/\n.codex/\n");
writeFileSync(join(repo, "a.txt"), "a\n");
git(repo, "add", ".gitignore", "a.txt");
git(repo, "commit", "-q", "-m", "init");
mkdirSync(join(repo, ".codex"));
writeFileSync(join(repo, ".codex/hooks.json"), JSON.stringify({
  hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node -e 0" }] }] },
}));
const wtNew = join(repo, ".worktree/dev-x");
const wtNoCodex = join(repo, ".worktree/dev-nocodex");
const wtOld = join(repo, ".claude/worktrees/dev-y");
git(repo, "worktree", "add", "-q", wtNew, "-b", "dev/x");
git(repo, "worktree", "add", "-q", wtNoCodex, "-b", "dev/nocodex");
mkdirSync(join(repo, ".claude"), { recursive: true });
git(repo, "worktree", "add", "-q", wtOld, "-b", "dev/y");
mkdirSync(join(wtNew, ".codex"));
mkdirSync(join(wtOld, ".codex"));

// 一時の CODEX_HOME: 各 cwd のプロジェクトの信頼だけを書く（コマンドラインの -c だけでは信頼が与えられなかった。poc/design_03.md）
const cwds = [repo, wtNew, wtNoCodex, wtOld];
mkdirSync(codexHome);
writeFileSync(join(codexHome, "config.toml"), cwds.map((c) => `[projects."${c}"]\ntrust_level = "trusted"\n`).join("\n"));

/** Codex の app-server に hooks/list を問い合わせる。{cwd: [{sourcePath, trustStatus, event}]} */
async function listLoadedHooks() {
  const p = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, CODEX_HOME: codexHome } });
  let buf = "";
  let errBuf = "";
  const waiting = new Map();
  p.stderr.on("data", (d) => { errBuf += d; });
  p.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        const m = JSON.parse(line);
        if (m.id !== undefined && waiting.has(m.id)) waiting.get(m.id)(m);
      } catch { /* 通知など */ }
    }
  });
  const rpc = (id, method, params) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${method} がタイムアウトしました\n${errBuf.slice(-400)}`)), 30000);
    waiting.set(id, (m) => { clearTimeout(t); resolve(m); });
    p.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  try {
    await rpc(1, "initialize", { clientInfo: { name: "brw-placement-codex", version: "0" } });
    p.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    const r = await rpc(2, "hooks/list", { cwds });
    return Object.fromEntries((r.result?.data ?? []).map((e) => [e.cwd, e.hooks.map((h) => ({ sourcePath: h.sourcePath, trustStatus: h.trustStatus, event: h.eventName ?? h.event }))]));
  } finally {
    p.kill();
  }
}

const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok }); console.log(`${ok ? "OK" : "NG"}  ${name}${ok ? "" : `\n    ${detail}`}`); };
const mainHooks = join(repo, ".codex/hooks.json");

try {
  const loaded = await listLoadedHooks();
  // 応答に cwd が含まれないとき（問い合わせの失敗）を「フックなし」と取り違えない
  const answered = (cwd) => Array.isArray(loaded[cwd]);
  const sources = (cwd) => [...new Set((loaded[cwd] ?? []).map((h) => h.sourcePath))];
  const onlyMain = (cwd) => sources(cwd).length === 1 && sources(cwd)[0] === mainHooks;
  check("hooks/list が、問い合わせたすべての cwd について応答した", cwds.every(answered), `応答があった cwd: ${JSON.stringify(Object.keys(loaded))}`);
  check("本体: 本体の .codex/hooks.json が読まれる", answered(repo) && onlyMain(repo), JSON.stringify(sources(repo)));
  check(".worktree/<別名>（空の .codex/ あり）: 本体の .codex/hooks.json が読まれる", answered(wtNew) && onlyMain(wtNew), JSON.stringify(sources(wtNew)));
  check(".worktree/<別名>（.codex/ なし）: フックは読まれない", answered(wtNoCodex) && sources(wtNoCodex).length === 0, JSON.stringify(sources(wtNoCodex)));
  check("旧置き場（空の .codex/ あり。比較）: 本体の .codex/hooks.json が読まれ、.worktree/ と同じ結果になる",
    answered(wtOld) && onlyMain(wtOld) && onlyMain(wtNew), JSON.stringify(sources(wtOld)));
} catch (error) {
  check("hooks/list の呼び出し", false, String(error?.message ?? error));
} finally {
  if (KEEP) console.log(`一時ディレクトリを残しました: ${tmp}`);
  else rmSync(tmp, { recursive: true, force: true });
}

console.log(JSON.stringify({ script: "placement-codex", ok: checks.every((c) => c.ok), checks }));
process.exit(checks.every((c) => c.ok) ? 0 : 1);
