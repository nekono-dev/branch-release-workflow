import { configFields, formatProblem } from "./config-schema.mjs";

export const CONFIG_FILE = ".cc-sdd-bootstrap.json";
export const UPDATE_COMMAND = "npx github:nekono-dev/cc-sdd-bootstrap update";
export const INIT_COMMAND = "npx github:nekono-dev/cc-sdd-bootstrap init";
export const FAILURE_RECORD = ".cache/cc-sdd-install.failed";
export const STATE_PATH = ".cache/cc-sdd-install.state.json";
export const RETRY_COMMAND = "node .agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs";
export const NPX_TIMEOUT_MS = 540000;

const own = (o, k) => Object.hasOwn(o, k) ? o[k] : undefined;

/**
 * 設定ファイルのテキストを解析し、有効な設定オブジェクトまたは失敗理由を返す。
 * 不正な形式や欠損項目は日本語のメッセージで報告する。
 * @param {string | null} text
 * @returns {{ ok: true, config: { version: any, lang: any, keepTemplates: boolean } } | { ok: false, reason: string }}
 */
export function readInstallConfig(text) {
  const fail = (detail) => ({
    ok: false,
    reason: `${detail} ${CONFIG_FILE} を直すか、${UPDATE_COMMAND} で設定を新しくしてください。`
  });

  if (text === null) {
    return { ok: false, reason: `${CONFIG_FILE} がありません。${INIT_COMMAND} で作成してください。` };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail(`${CONFIG_FILE} が JSON として読めません。`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fail(`${CONFIG_FILE} がオブジェクトではありません。`);
  }

  const fmtProb = formatProblem(parsed.format);
  if (typeof fmtProb === "string") {
    return fail(`${CONFIG_FILE} の ${fmtProb}`);
  }

  const ccSdd = (parsed.ccSdd && typeof parsed.ccSdd === "object" && !Array.isArray(parsed.ccSdd))
    ? parsed.ccSdd
    : {};

  const version = own(ccSdd, "version");
  const lang = own(ccSdd, "lang");
  const keepRaw = own(ccSdd, "keepTemplates");
  const keepTemplates = keepRaw === undefined ? false : keepRaw;

  const checks = [
    { path: "ccSdd.version", val: version },
    { path: "ccSdd.lang", val: lang },
    ...(keepRaw === undefined ? [] : [{ path: "ccSdd.keepTemplates", val: keepTemplates }])
  ];

  for (const c of checks) {
    const field = configFields.find((f) => f.path === c.path);
    if (field) {
      const err = field.validate(c.val);
      if (typeof err === "string") {
        return fail(`${CONFIG_FILE} の ${c.path}: ${err}`);
      }
    }
  }

  return { ok: true, config: { version, lang, keepTemplates } };
}

/** buildState: 設定と導入したファイルの指紋から、導入状態の記録を組み立てる */
export function buildState({ config, files }) {
  return {
    format: 1,
    version: config.version,
    lang: config.lang,
    keepTemplates: config.keepTemplates,
    files: { ...files }
  };
}

/** parseState: 導入状態の記録の文字列を厳密に検証して返す。読めない・形が違えば null */
export function parseState(text) {
  if (text === null) return null;
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
  const { format, version, lang, keepTemplates, files } = obj;
  if (format !== 1) return null;
  if (typeof version !== "string" || version.length === 0) return null;
  if (typeof lang !== "string" || lang.length === 0) return null;
  if (typeof keepTemplates !== "boolean") return null;
  if (typeof files !== "object" || files === null || Array.isArray(files)) return null;
  for (const [path, fp] of Object.entries(files)) {
    if (typeof fp !== "string" || !/^[0-9a-f]{64}$/.test(fp)) return null;
    if (!isRelativePath(path)) return null;
  }
  return { format, version, lang, keepTemplates, files };
}

/** 相対の道筋か（絶対・`\` を含む・`..` や `.`・空の区間を含むものは外） */
function isRelativePath(p) {
  if (typeof p !== "string" || p.length === 0) return false;
  if (p.startsWith("/") || p.includes("\\")) return false;
  return !p.split("/").some((seg) => seg === "" || seg === "." || seg === "..");
}

/** isFingerprintTarget: 指紋を取る対象かどうか。保持を選んだときは雛形の下を外す */
export function isFingerprintTarget(path, keepTemplates) {
  if (path.startsWith(".claude/skills/kiro-")) return true;
  if (path === ".kiro/settings/cc-sdd-guide.md") return true;
  if (path.startsWith(".kiro/settings/templates/")) return !keepTemplates;
  return false;
}

/** 状態と現在の導入物から、入れ直す理由または省略を返す。 */
export function decideInstall({ config, state, failureRecordExists, currentHashes, templatesMissing }) {
  if (failureRecordExists) return { action: "install", reason: "failure-record" };
  if (state === null) return { action: "install", reason: "no-state" };
  if (config.version !== state.version || config.lang !== state.lang || config.keepTemplates !== state.keepTemplates) {
    return { action: "install", reason: "config-changed" };
  }
  if (Object.entries(state.files).some(([path, hash]) => currentHashes[path] !== hash)) {
    return { action: "install", reason: "files-changed" };
  }
  if (config.keepTemplates && templatesMissing) return { action: "install", reason: "templates-missing" };
  return { action: "skip" };
}

/** 削除する導入物の道筋を順に返す。 */
export function removalTargets({ skillEntries, keepTemplates }) {
  return [
    ...skillEntries.filter((name) => name.startsWith("kiro-")).map((name) => `.claude/skills/${name}`),
    ".kiro/settings/cc-sdd-guide.md",
    ...(!keepTemplates ? [".kiro/settings/templates"] : [])
  ];
}

/** cc-sdd が解釈する manifest を設定に応じて組み立てる。 */
export function buildManifest({ keepTemplates, templatesMissing }) {
  const artifacts = [
    {
      id: "skills",
      source: { type: "templateDir", fromDir: "templates/agents/{{AGENT}}/skills", toDir: "{{AGENT_COMMANDS_DIR}}" }
    },
    {
      id: "doc_main",
      source: { type: "templateFile", from: "templates/agents/{{AGENT}}/docs/CLAUDE.md", toDir: "{{KIRO_DIR}}/settings", rename: "cc-sdd-guide.md" }
    }
  ];
  if (!keepTemplates || templatesMissing) {
    artifacts.push({
      id: "settings_templates",
      source: { type: "templateDir", fromDir: "templates/shared/settings/templates", toDir: "{{KIRO_DIR}}/settings/templates" }
    });
  }
  return { version: 1, artifacts };
}

/** npx に渡す引数をシェル展開なしで配列として返す。 */
export function npxArgs(config, manifestPath) {
  return ["--yes", `cc-sdd@${config.version}`, "--yes", "--overwrite", "force", "--manifest", manifestPath, "--claude-skills", "--lang", config.lang];
}

/** 導入開始時に失敗の記録へ書く案内文 */
export const RECORD_IN_PROGRESS = `cc-sdd の導入が完了していません（導入中、または中断）。再試行: ${RETRY_COMMAND}（Claude の外で実行する）`;

/** 導入成功を利用者へ知らせる */
export function messageInstalled(config) {
  return `cc-sdd ${config.version}（言語: ${config.lang}）の導入物を更新しました（.claude/skills/kiro-*・.kiro/settings/）。\nCLAUDE.md は変更していません。`;
}

/** 入れ直しを省いたことを利用者へ知らせる */
export function messageSkipped(config) {
  return `cc-sdd ${config.version}（言語: ${config.lang}）は揃っているため、入れ直しを省きました。`;
}

/** 一覧に載らないスキルの使い方を案内する */
export function messageGuide() {
  return "スキル一覧に載らないスキル（kiro-discovery・kiro-impl など）は、依頼に対応する .claude/skills/<名前>/SKILL.md を Read して、その手順を最後まで実行してください。";
}

/** 失敗の理由と再試行方法を記録する文 */
export function failureRecordText(reason) {
  return `cc-sdd の導入に失敗しました。\n理由: ${reason}\n再試行: ${RETRY_COMMAND}（Claude の外で実行する）`;
}

/** セッション開始時に導入失敗を利用者へ知らせる */
export function messageFailed(reason) {
  return `cc-sdd の導入に失敗しました。理由: ${reason}\n次の入力は止まります。再試行: ${RETRY_COMMAND}（Claude の外で実行する）。新しいセッションを開くと再試行されます。`;
}
