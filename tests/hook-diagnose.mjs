// フックの稼働と対応経路の診断（brw-enforcement 6.4）の契約テスト。selftest.mjs から呼ばれる。
// 実際のホストは呼ばず、一時ディレクトリの設定とランチャーを子プロセスで呼ぶ。利用者の ~/.claude・~/.codex には触れない。
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { installCodexHooks } from "../scripts/hook-install.mjs";

// scripts/hook-diagnose.mjs は 6.4 で作る。未実装の間は「未実装」として失敗する（RED の確認用）
const diagModule = await import("../scripts/hook-diagnose.mjs").catch(() => null);
const diagnoseHooks = diagModule?.diagnoseHooks ?? (() => ({ missing: "未実装" }));

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = realpathSync(join(root, "scripts/agent-hooks.mjs"));
const REAL_HOOKS_JSON = readFileSync(join(root, "hooks/hooks.json"), "utf8");
// テスト用の偽の資格情報。結果や理由に出てはならない
const SECRET = "ghp_abcdefghij0123456789";

/** 一時ディレクトリを作り、後始末を返す。 */
const tmp = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

/**
 * 一時の Claude プラグイン。hooks/hooks.json に hooks を置き、scripts/agent-hooks.mjs に script を置く（省略時は置かない）。
 * hooks: null なら hooks/hooks.json を置かない。
 */
const plugin = ({ hooks = REAL_HOOKS_JSON, script } = {}) => {
  const t = tmp("brw-diag-plugin-");
  if (hooks !== null) {
    mkdirSync(join(t.dir, "hooks"));
    writeFileSync(join(t.dir, "hooks/hooks.json"), hooks);
  }
  if (script !== undefined) {
    mkdirSync(join(t.dir, "scripts"));
    writeFileSync(join(t.dir, "scripts/agent-hooks.mjs"), script);
  }
  return t;
};

// 入力を読み捨て、何も出力しないランチャー（応答を返さない実装）
const SILENT = "process.stdin.on('data', () => {});\nprocess.stdin.on('end', () => process.exit(0));\n";
// 常に失敗するランチャー
const CRASH = "process.stdin.resume();\nprocess.exit(3);\n";
/** 入力に関係なく同じ応答を返すランチャー（期待と違う応答の再現に使う）。 */
const emitter = (obj) => `process.stdin.resume();\nprocess.stdin.on('end', () => { process.stdout.write(${JSON.stringify(JSON.stringify(obj))}); });\n`;
const ALLOW_ALL = emitter({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } });
const DENY_ALL = emitter({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } });
const BLOCK_ALL = emitter({ decision: "block", reason: "x" });
// 呼び出し元の資格情報が子プロセスに届いたら、拒否の入力に許可を返す（届かなければ正しく拒否する）
const LEAK_CHECK = [
  "let t = '';",
  "process.stdin.on('data', (c) => { t += c; });",
  "process.stdin.on('end', () => {",
  "  const e = JSON.parse(t);",
  "  const cmd = String(e.tool_input?.command ?? '');",
  "  const d = cmd.includes('commit') ? 'deny' : 'allow';",
  "  const leaked = process.env.GH_TOKEN !== undefined;",
  "  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: leaked ? 'allow' : d } }));",
  "});",
].join("\n");

/** 経路の [状態, 理由コード] を取り出す。経路が無ければ null。 */
const statusOf = (res, host, environment, event) => {
  const r = res?.routes?.find((x) => x.host === host && x.environment === environment && x.event === event);
  return r ? [r.status, r.reasonCode] : null;
};
const routeOf = (res, host, environment, event) => res?.routes?.find((x) => x.host === host && x.environment === environment && x.event === event);

/** 導入先の Codex 設定ファイルのパス。 */
const codexFileOf = (dir) => join(dir, ".codex", "hooks.json");

/** 呼び出し元の環境変数を一時的に差し替えて fn を実行し、必ず元へ戻す。値が undefined なら削除する。 */
const withEnv = (vars, fn) => {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

// 対応していない経路（限界）の ID の完全な一覧。追加・削除のたびにここを直す
const EXPECTED_LIMIT_IDS = [
  "body-file-swap", "cloud-managed-only", "codex-command-hooks-caller", "codex-format-unverified", "codex-hooks-disabled-partial",
  "codex-pretooluse-no-ask", "codex-trust-by-caller", "external-script-git", "gh-host-only", "gh-repo-flag-uncloned",
  "graphql-indeterminate", "mcp-pr-approval", "mcp-update-base", "nested-shell", "origin-trust-base", "other-mcp", "outside-hooks",
  "over-detection", "post-stop-unobserved", "ref-moving-local", "tool-response-format", "url-without-github",
];

export const runHookDiagnoseChecks = async (eq) => {
  // ---- 健全な導入（実際の BRW のランチャーを使う）----
  {
    const codex = tmp("brw-diag-codex-");
    try {
      const inst = installCodexHooks({ repoDir: codex.dir, launcherPath: LAUNCHER });
      eq("hook-diagnose/6.4 前提: Codex の導入が成功している", inst.status, "untrusted");
      const before = readFileSync(codexFileOf(codex.dir), "utf8");

      const res = diagnoseHooks({ pluginRoot: root, codexRepoDir: codex.dir, env: {} });

      eq("hook-diagnose/6.4 Claude のローカル PreToolUse は、拒否と確認省略の両方の応答が返れば稼働と表示する",
        [statusOf(res, "claude", "local", "PreToolUse"), routeOf(res, "claude", "local", "PreToolUse")?.probes?.map((p) => [p.name, p.result])],
        [["active", null], [["deny", "ok"], ["allow", "ok"]]]);
      eq("hook-diagnose/6.4 Claude の PostToolUse は、作業の関連付けが一時リポジトリの状態に記録されれば稼働と表示する",
        [statusOf(res, "claude", "local", "PostToolUse"), routeOf(res, "claude", "local", "PostToolUse")?.probes?.map((p) => [p.name, p.result])],
        [["active", null], [["attach", "ok"], ["noop", "ok"]]]);
      eq("hook-diagnose/6.4 Claude の Stop は、準備済みの未公開作業に block の案内が返り、作業が無いときは何も返さなければ稼働と表示する",
        [statusOf(res, "claude", "local", "Stop"), routeOf(res, "claude", "local", "Stop")?.probes?.map((p) => [p.name, p.result])],
        [["active", null], [["ready", "ok"], ["idle", "ok"]]]);
      eq("hook-diagnose/6.4 Codex のローカル経路は、信頼状態が確認できなければ確認不能（登録だけで稼働と表示しない）",
        [statusOf(res, "codex", "local", "PreToolUse"), statusOf(res, "codex", "local", "PermissionRequest")], [["unverifiable", "trust-unconfirmed"], ["unverifiable", "trust-unconfirmed"]]);
      eq("hook-diagnose/6.4 Codex の PreToolUse は拒否だけを確かめ、確認省略（allow）は PermissionRequest に限る",
        routeOf(res, "codex", "local", "PreToolUse")?.probes?.map((p) => p.name), ["deny"]);
      eq("hook-diagnose/6.4 Codex の PermissionRequest は拒否と確認省略の両方を確かめる",
        routeOf(res, "codex", "local", "PermissionRequest")?.probes?.map((p) => [p.name, p.result]), [["deny", "ok"], ["allow", "ok"]]);

      const trusted = diagnoseHooks({ pluginRoot: root, codexRepoDir: codex.dir, env: {}, codexTrust: "trusted" });
      eq("hook-diagnose/6.4 信頼済みと確認できた Codex のローカル経路は稼働と表示する",
        ["PreToolUse", "PermissionRequest", "PostToolUse", "Stop"].map((e) => statusOf(trusted, "codex", "local", e)?.[0]), ["active", "active", "active", "active"]);
      const untrusted = diagnoseHooks({ pluginRoot: root, codexRepoDir: codex.dir, env: {}, codexTrust: "untrusted" });
      eq("hook-diagnose/6.4 未信頼と確認できた Codex のローカル経路は未信頼と表示する", statusOf(untrusted, "codex", "local", "PreToolUse"), ["untrusted", "review-required"]);

      eq("hook-diagnose/6.4 診断は読み取りだけを行い、Codex の設定ファイルを書き換えない", readFileSync(codexFileOf(codex.dir), "utf8") === before, true);
      eq("hook-diagnose/6.4 診断は導入先に新しいファイルを作らない", readdirSync(join(codex.dir, ".codex")).sort(), ["hooks.json"]);
    } finally {
      codex.cleanup();
    }
  }

  // ---- クラウド経路は管理対象フックが前提（コマンドフックだけの構成は非対応）----
  {
    const codex = tmp("brw-diag-cloud-");
    try {
      installCodexHooks({ repoDir: codex.dir, launcherPath: LAUNCHER });
      const res = diagnoseHooks({ pluginRoot: root, codexRepoDir: codex.dir, env: {}, codexTrust: "trusted" });
      const cloud = (res.routes ?? []).filter((r) => r.environment === "cloud");
      eq("hook-diagnose/6.4 クラウド経路は両ホストとも非対応で、管理対象フックが必要と表示する（登録済みでも稼働とみなさない）",
        cloud.map((r) => [r.host, r.status, r.reasonCode, r.managedHooksRequired]).every((x) => x[1] === "unsupported" && x[2] === "managed-hooks-required" && x[3] === true),
        true);
      eq("hook-diagnose/6.4 同じ導入でもクラウドとローカルは別の状態になる（区別できる）",
        [statusOf(res, "claude", "cloud", "PreToolUse")?.[0] !== statusOf(res, "claude", "local", "PreToolUse")?.[0], cloud.length], [true, 7]);
    } finally {
      codex.cleanup();
    }
  }

  // ---- Codex のコマンドフックを使えない環境・フック無効の設定 ----
  {
    const codex = tmp("brw-diag-nohooks-");
    try {
      installCodexHooks({ repoDir: codex.dir, launcherPath: LAUNCHER });
      const a = diagnoseHooks({ pluginRoot: root, codexRepoDir: codex.dir, env: {}, commandHooks: false, host: "codex" });
      const localA = (a.routes ?? []).filter((r) => r.environment === "local");
      eq("hook-diagnose/6.4 コマンドフックを使えないローカル実行環境は非対応で、管理対象フックが必要と表示する",
        [localA.length, localA.every((r) => r.status === "unsupported" && r.reasonCode === "command-hooks-unavailable" && r.managedHooksRequired === true)], [4, true]);
      const b = diagnoseHooks({ pluginRoot: root, codexRepoDir: codex.dir, env: {}, featuresText: "[features]\nhooks = false\n", host: "codex" });
      eq("hook-diagnose/6.4 設定で hooks が無効なら非対応と表示する（管理対象の要否は別）",
        [statusOf(b, "codex", "local", "PreToolUse"), routeOf(b, "codex", "local", "PreToolUse")?.managedHooksRequired], [["unsupported", "hooks-disabled"], false]);
    } finally {
      codex.cleanup();
    }
  }

  // ---- 未導入・衝突・旧フック ----
  {
    const codex = tmp("brw-diag-none-");
    const p = plugin({ hooks: null });
    try {
      const res = diagnoseHooks({ pluginRoot: p.dir, codexRepoDir: codex.dir, env: {} });
      eq("hook-diagnose/6.4 未導入の Claude と Codex は未導入と表示する",
        [statusOf(res, "claude", "local", "PreToolUse"), statusOf(res, "codex", "local", "PreToolUse")], [["not-installed", "not-installed"], ["not-installed", "not-installed"]]);
    } finally {
      codex.cleanup();
      p.cleanup();
    }
  }
  {
    const codex = tmp("brw-diag-legacy-");
    const p = plugin({ hooks: JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/brw.mjs" hook' }] }] } }) });
    try {
      mkdirSync(join(codex.dir, ".codex"));
      writeFileSync(codexFileOf(codex.dir), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node '/x/brw.mjs' hook" }] }] } }));
      const res = diagnoseHooks({ pluginRoot: p.dir, codexRepoDir: codex.dir, env: {} });
      eq("hook-diagnose/6.4 旧 brw.mjs hook が残る Claude と Codex は衝突と表示する（稼働とみなさない）",
        [statusOf(res, "claude", "local", "PreToolUse"), statusOf(res, "codex", "local", "PreToolUse")], [["conflict", "legacy-brw-hook"], ["conflict", "legacy-brw-hook"]]);
    } finally {
      codex.cleanup();
      p.cleanup();
    }
  }
  {
    // 古いクローンの絶対パスを指す登録は、稼働と表示せず衝突にする
    const codex = tmp("brw-diag-stale-");
    try {
      installCodexHooks({ repoDir: codex.dir, launcherPath: "/old/clone/scripts/agent-hooks.mjs" });
      const res = diagnoseHooks({ pluginRoot: root, codexRepoDir: codex.dir, env: {}, codexTrust: "trusted", host: "codex" });
      eq("hook-diagnose/6.4 旧い絶対パスの登録は衝突とし、稼働と表示しない", statusOf(res, "codex", "local", "PreToolUse"), ["conflict", "stale-launcher"]);
    } finally {
      codex.cleanup();
    }
  }
  {
    // 登録の一部だけが欠けた場合は、その経路だけ未導入とする
    const codex = tmp("brw-diag-partial-");
    try {
      mkdirSync(join(codex.dir, ".codex"));
      writeFileSync(codexFileOf(codex.dir), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: `node '${LAUNCHER}' codex Stop` }] }] } }));
      const res = diagnoseHooks({ pluginRoot: root, codexRepoDir: codex.dir, env: {}, codexTrust: "trusted", host: "codex" });
      eq("hook-diagnose/6.4 一部のイベントだけ登録された Codex は、欠けた経路を未導入、登録済みの経路を稼働と分けて表示する",
        [statusOf(res, "codex", "local", "Stop"), statusOf(res, "codex", "local", "PreToolUse")], [["active", null], ["not-installed", "missing-registration"]]);
    } finally {
      codex.cleanup();
    }
  }

  // ---- 応答の確認（登録だけで稼働とみなさない）----
  {
    // 登録はあるが、拒否も確認省略も返さないランチャー
    const p = plugin({ script: SILENT });
    try {
      const res = diagnoseHooks({ pluginRoot: p.dir, env: {}, host: "claude" });
      eq("hook-diagnose/6.4 登録されていても応答が返らなければ、応答を確認できないと表示する（イベントが届かなかった経路）",
        [statusOf(res, "claude", "local", "PreToolUse"), routeOf(res, "claude", "local", "PreToolUse")?.probes?.[0]], [["unverifiable", "no-response"], { name: "deny", result: "no-response" }]);
    } finally {
      p.cleanup();
    }
  }
  {
    // 何もしないランチャーは、PostToolUse・Stop でも稼働とみなさない（関連付け・案内の記録が無いため）
    const p = plugin({ script: SILENT });
    try {
      const res = diagnoseHooks({ pluginRoot: p.dir, env: {}, host: "claude" });
      eq("hook-diagnose/6.4 何もしないランチャーは PostToolUse で稼働と表示せず、応答なしとする",
        [statusOf(res, "claude", "local", "PostToolUse"), routeOf(res, "claude", "local", "PostToolUse")?.probes?.[0]], [["unverifiable", "no-response"], { name: "attach", result: "no-response" }]);
      eq("hook-diagnose/6.4 何もしないランチャーは Stop で稼働と表示せず、準備済みの作業への案内なしとする",
        [statusOf(res, "claude", "local", "Stop"), routeOf(res, "claude", "local", "Stop")?.probes?.[0]], [["unverifiable", "no-response"], { name: "ready", result: "no-response" }]);
    } finally {
      p.cleanup();
    }
  }
  {
    // 期待と違う応答を返すランチャーは、どの経路でも稼働と表示しない
    const allow = plugin({ script: ALLOW_ALL });
    const deny = plugin({ script: DENY_ALL });
    const block = plugin({ script: BLOCK_ALL });
    try {
      const a = diagnoseHooks({ pluginRoot: allow.dir, env: {}, host: "claude" });
      const d = diagnoseHooks({ pluginRoot: deny.dir, env: {}, host: "claude" });
      const b = diagnoseHooks({ pluginRoot: block.dir, env: {}, host: "claude" });
      eq("hook-diagnose/6.4 拒否の入力に許可を返すランチャーは、拒否の確認で失敗として稼働と表示しない",
        [statusOf(a, "claude", "local", "PreToolUse"), routeOf(a, "claude", "local", "PreToolUse")?.probes?.[0]], [["unverifiable", "probe-failed"], { name: "deny", result: "probe-failed" }]);
      eq("hook-diagnose/6.4 確認省略の入力に拒否を返すランチャーは、確認省略の確認で失敗として稼働と表示しない",
        [statusOf(d, "claude", "local", "PreToolUse"), routeOf(d, "claude", "local", "PreToolUse")?.probes?.[1]], [["unverifiable", "probe-failed"], { name: "allow", result: "probe-failed" }]);
      eq("hook-diagnose/6.4 出力を返さないはずの Stop・PostToolUse に出力するランチャーは稼働と表示しない",
        [statusOf(b, "claude", "local", "Stop"), statusOf(b, "claude", "local", "PostToolUse")], [["unverifiable", "probe-failed"], ["unverifiable", "probe-failed"]]);
    } finally {
      allow.cleanup();
      deny.cleanup();
      block.cleanup();
    }
  }
  {
    // 起動に失敗するランチャー（終了コードが 0 でない）は、稼働と表示しない
    const p = plugin({ script: CRASH });
    try {
      const res = diagnoseHooks({ pluginRoot: p.dir, env: {}, host: "claude" });
      eq("hook-diagnose/6.4 起動に失敗するランチャーは検査不能の probe-failed と表示する", statusOf(res, "claude", "local", "PostToolUse"), ["unverifiable", "probe-failed"]);
    } finally {
      p.cleanup();
    }
  }
  {
    // ランチャーの実体が無い（登録は正しいが、実行できない）
    const p = plugin({});
    try {
      const res = diagnoseHooks({ pluginRoot: p.dir, env: {}, host: "claude" });
      eq("hook-diagnose/6.4 実行できないランチャーは稼働と表示しない", statusOf(res, "claude", "local", "PreToolUse")?.[0], "unverifiable");
    } finally {
      p.cleanup();
    }
  }
  {
    // Codex の信頼が未承認と分かっていれば、応答の確認より先に未信頼と表示する
    const p = plugin({ script: SILENT });
    const codex = tmp("brw-diag-untrust-first-");
    try {
      installCodexHooks({ repoDir: codex.dir, launcherPath: realpathSync(join(p.dir, "scripts/agent-hooks.mjs")) });
      const res = diagnoseHooks({ pluginRoot: p.dir, codexRepoDir: codex.dir, env: {}, codexTrust: "untrusted", host: "codex" });
      eq("hook-diagnose/6.4 Codex の未信頼は、応答の確認が失敗していても未信頼と表示する", statusOf(res, "codex", "local", "PreToolUse"), ["untrusted", "review-required"]);
    } finally {
      codex.cleanup();
      p.cleanup();
    }
  }

  // ---- 子プロセスの環境は最小限（呼び出し元の資格情報・gitconfig を渡さない）----
  {
    const p = plugin({ script: LEAK_CHECK });
    try {
      const res = withEnv({ GH_TOKEN: SECRET }, () => diagnoseHooks({ pluginRoot: p.dir, env: {}, host: "claude" }));
      eq("hook-diagnose/6.4 呼び出し元の GH_TOKEN は env で指定しない限り子プロセスに届かない", statusOf(res, "claude", "local", "PreToolUse")?.[0], "active");
      const leaked = withEnv({ GH_TOKEN: SECRET }, () => diagnoseHooks({ pluginRoot: p.dir, env: { GH_TOKEN: SECRET }, host: "claude" }));
      eq("hook-diagnose/6.4 env で明示的に渡した値だけが子プロセスに届く（届けば検査で検出される）", statusOf(leaked, "claude", "local", "PreToolUse")?.[0], "unverifiable");
    } finally {
      p.cleanup();
    }
  }
  {
    // 利用者の gitconfig の書き換え（insteadOf）が、送り先の判定に影響しない
    const home = tmp("brw-diag-home-");
    try {
      writeFileSync(join(home.dir, ".gitconfig"), '[url "https://invalid.example.test/"]\n\tinsteadOf = https://github.com/\n');
      const res = withEnv({ HOME: home.dir, GIT_CONFIG_GLOBAL: undefined }, () => diagnoseHooks({ pluginRoot: root, env: {}, host: "claude" }));
      eq("hook-diagnose/6.4 利用者の gitconfig（insteadOf）が検査の送り先判定に影響しない", statusOf(res, "claude", "local", "PreToolUse")?.[0], "active");
    } finally {
      home.cleanup();
    }
  }

  // ---- 入力が不足する場合は、推測せず確認不能 ----
  {
    const res = diagnoseHooks({ env: {} });
    eq("hook-diagnose/6.4 場所が指定されない経路は確認不能とする（成功と表示しない）",
      [statusOf(res, "claude", "local", "PreToolUse")?.[0], statusOf(res, "codex", "local", "PreToolUse")?.[0]], ["unverifiable", "unverifiable"]);
  }
  {
    const res = diagnoseHooks({ pluginRoot: root, codexRepoDir: join(tmpdir(), "brw-diag-no-such-dir-x"), env: {}, host: "codex" });
    eq("hook-diagnose/6.4 存在しない導入先の Codex は例外にせず確認不能とする", statusOf(res, "codex", "local", "PreToolUse")?.[0], "unverifiable");
  }
  {
    const res = diagnoseHooks({ pluginRoot: root, env: {}, host: "claude" });
    eq("hook-diagnose/6.4 host を指定すると、そのホストの経路だけを返す", [...new Set((res.routes ?? []).map((r) => r.host))], ["claude"]);
  }

  // ---- 資格情報を出力しない ----
  {
    const codex = tmp("brw-diag-secret-");
    try {
      installCodexHooks({ repoDir: codex.dir, launcherPath: LAUNCHER });
      const res = diagnoseHooks({ pluginRoot: root, codexRepoDir: codex.dir, env: { GH_TOKEN: SECRET, GITHUB_TOKEN: SECRET } });
      eq("hook-diagnose/6.4 環境変数の資格情報を結果に出力しない", JSON.stringify(res).includes(SECRET), false);
    } finally {
      codex.cleanup();
    }
  }

  // ---- 対応していない経路（限界）の一覧 ----
  {
    // 限界は host を指定せずに全件を見る。ID は完全一致で確かめる（漏れも余分も失敗にする）
    const res = diagnoseHooks({ env: {} });
    const ids = (res.limits ?? []).map((l) => l.id).sort();
    eq("hook-diagnose/6.4 対応していない経路の一覧は、申し送りの全項目と完全に一致する", ids, [...EXPECTED_LIMIT_IDS].sort());
    eq("hook-diagnose/6.4 限界の各項目はホストを持ち、説明文がある", (res.limits ?? []).every((l) => ["claude", "codex", "both"].includes(l.host) && typeof l.text === "string" && l.text.length > 0), true);
    const codexOnly = diagnoseHooks({ env: {}, host: "codex" }).limits.map((l) => l.id);
    eq("hook-diagnose/6.4 Codex だけの限界は Claude の経路では出さない", codexOnly.includes("codex-pretooluse-no-ask") && !diagnoseHooks({ env: {}, host: "claude" }).limits.some((l) => l.host === "codex"), true);
  }

  // ---- 一時リポジトリの後始末 ----
  {
    // 専用の TMPDIR に向けて、他の実行（並行する自己テストなど）の一時ファイルと混ざらないようにする
    const scratch = tmp("brw-diag-scratch-");
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = scratch.dir;
    try {
      diagnoseHooks({ pluginRoot: root, env: {}, host: "claude" });
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
    try {
      eq("hook-diagnose/6.4 検査に使った一時リポジトリを残さない", readdirSync(scratch.dir), []);
    } finally {
      scratch.cleanup();
    }
  }
};
