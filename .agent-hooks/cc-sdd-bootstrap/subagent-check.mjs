import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EFFORT_ORDER, decideSpawn, messageConfigBroken, validateSubagents } from "./subagent-roles.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

function argumentsOf(argv) {
  const toolIndex = argv.indexOf("--tool");
  const tool = toolIndex >= 0 ? argv[toolIndex + 1] : null;
  if (argv[0] !== "pre-tool-use") throw new Error("フックの種類を判定できません。");
  if (tool !== "claude" && tool !== "codex") throw new Error("作業ツールを判定できません。");
  return tool;
}

async function readInput() {
  let raw = "";
  for await (const part of process.stdin) raw += part;
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error("入力の JSON を読み取れません。"); }
  if (!isObject(value)) throw new Error("入力の JSON を読み取れません。");
  return value;
}

/** 対象の起動か（Claude Code は Agent、Codex は spawn_agent を含む名前） */
function isSpawn(tool, name) {
  if (typeof name !== "string") return false;
  return tool === "claude" ? name === "Agent" : name.includes("spawn_agent");
}

/** 定義の名前として安全か（根の外を指せない） */
const safeName = (name) => typeof name === "string" && /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(name);

async function readTextOrNull(file) {
  try { return await fs.readFile(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "EISDIR") return null; throw error; }
}

/** 値の両端の引用符を外す */
function unquote(v) {
  const s = v.trim();
  const m = /^"((?:[^"\\]|\\.)*)"/.exec(s) ?? /^'([^']*)'/.exec(s);
  if (m) return m[1];
  return s.replace(/\s+#.*$/, "").trim();
}

/** Claude Code の定義（Markdown の frontmatter）から model・effort だけを読む */
function parseClaudeDefinition(text) {
  const out = {};
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(model|effort):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = nonEmpty(unquote(kv[2]));
  }
  return out;
}

/** Codex の定義（TOML）の最上位から model・model_reasoning_effort だけを読む */
function parseCodexDefinition(text) {
  const out = {};
  let multiline = null;
  for (const line of text.split(/\r?\n/)) {
    if (multiline) { if (line.includes(multiline)) multiline = null; continue; }
    if (/^\s*\[/.test(line)) break;
    const kv = /^\s*(?:"([A-Za-z0-9_]+)"|'([A-Za-z0-9_]+)'|([A-Za-z0-9_]+))\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    kv.splice(1, 3, kv[1] ?? kv[2] ?? kv[3]);
    const triple = /^("""|''')/.exec(kv[2]);
    if (triple) { if (!kv[2].slice(3).includes(triple[1])) multiline = triple[1]; continue; }
    if (kv[1] === "model" || kv[1] === "model_reasoning_effort") out[kv[1]] = nonEmpty(unquote(kv[2]));
  }
  return out;
}

async function readDefinition(tool, name) {
  if (!safeName(name)) return {};
  if (tool === "claude") {
    const text = await readTextOrNull(path.join(root, ".claude/agents", `${name}.md`));
    if (text === null) return {};
    const d = parseClaudeDefinition(text);
    return { model: d.model ?? null, effort: d.effort ?? null };
  }
  const text = await readTextOrNull(path.join(root, ".codex/agents", `${name}.toml`));
  if (text === null) return {};
  const d = parseCodexDefinition(text);
  return { model: d.model ?? null, effort: d.model_reasoning_effort ?? null };
}

/** 会話の記録を後ろから読み、最後の応答のモデルを返す（読めなければ null） */
async function orchestratorFromTranscript(file) {
  if (typeof file !== "string" || file === "") return null;
  let text;
  try { text = await fs.readFile(file, "utf8"); } catch { return null; } // 読めなければ不明として判定を続ける
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].trim()) continue;
    let entry;
    try { entry = JSON.parse(lines[i]); } catch { continue; }
    if (!isObject(entry) || entry.type !== "assistant" || !isObject(entry.message)) continue;
    const model = nonEmpty(entry.message.model);
    if (model && model !== "<synthetic>") return model;
  }
  return null;
}

/** 設定を読む。ファイルが無い・subagents が無ければ既定（空）。読めない・誤りは問題の一覧を返す */
async function loadConfig() {
  let text;
  try {
    text = await fs.readFile(path.join(root, ".cc-sdd-bootstrap.json"), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { ok: true, config: {} };
    return { ok: false, problems: [`.cc-sdd-bootstrap.json を読み取れません: ${error.code ?? error.message}`] };
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch (error) {
    return { ok: false, problems: [`.cc-sdd-bootstrap.json: JSON として読めません（${error.message}）`] };
  }
  if (!isObject(parsed)) return { ok: false, problems: [".cc-sdd-bootstrap.json: 対応（キーと値の組）で指定してください"] };
  return validateSubagents(parsed.subagents);
}

const effortOrNull = (v) => (EFFORT_ORDER.includes(v) ? v : null);

async function run() {
  const tool = argumentsOf(process.argv.slice(2));
  const input = await readInput();
  if (!isSpawn(tool, input.tool_name)) return;
  const toolInput = isObject(input.tool_input) ? input.tool_input : {};

  const deny = (reason) => {
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: {
      hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason,
    } })}\n`);
  };

  const loaded = await loadConfig();
  if (!loaded.ok) { deny(messageConfigBroken(loaded.problems)); return; }

  const name = tool === "claude" ? toolInput.subagent_type : toolInput.agent_type;
  const def = await readDefinition(tool, nonEmpty(name));
  const childModel = nonEmpty(toolInput.model) ?? def.model ?? null;
  // Codex は定義の推論量が起動の指定より優先される。Claude Code は定義の値だけ。
  const childEffort = tool === "codex"
    ? (effortOrNull(def.effort) ?? effortOrNull(toolInput.reasoning_effort))
    : effortOrNull(def.effort);
  const orchestratorModel = tool === "codex"
    ? nonEmpty(input.model)
    : await orchestratorFromTranscript(input.transcript_path);

  const decision = decideSpawn(
    { vendor: tool, childModel, childEffort: childEffort ?? undefined, orchestratorModel },
    loaded.config,
  );
  if (decision.deny) deny(decision.reason);
}

run().catch((error) => {
  const detail = error.message || "詳細のないエラーです。";
  process.stderr.write(`subagent-check: フックの処理に失敗しました。詳細: ${detail}\n`);
  process.exitCode = 0;
});
