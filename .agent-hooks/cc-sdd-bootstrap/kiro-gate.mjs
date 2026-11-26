import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decidePreToolUse, decideStop, detectCommand, isExpandedInvocation, isSkillRead, messageAdditionalContext, skillPath } from "./kiro-gate-rules.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function argumentsOf(argv) {
  const event = argv[0];
  const toolIndex = argv.indexOf("--tool");
  const tool = toolIndex >= 0 ? argv[toolIndex + 1] : null;
  if (!new Set(["session-start", "user-prompt-submit", "pre-tool-use", "post-tool-use", "stop"]).has(event)) {
    throw new Error("フックの種類を判定できません。");
  }
  if (tool !== "claude" && tool !== "codex") throw new Error("作業ツールを判定できません。");
  return { event, tool };
}

async function readInput() {
  let raw = "";
  for await (const part of process.stdin) raw += part;
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    if (typeof value.session_id !== "string" || !value.session_id) throw new Error("session_id がありません。");
    return value;
  } catch (error) {
    if (error.message === "session_id がありません。") throw error;
    throw new Error("入力の JSON を読み取れません。");
  }
}

function stateFile(sessionId) {
  const key = createHash("sha256").update(`${root}\0${sessionId}`).digest("hex");
  return path.join(os.tmpdir(), "cc-sdd-bootstrap-kiro-gate", `${key}.json`);
}

async function loadState(file) {
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    const turn = value.turn;
    const validTurn = turn === null || (turn && typeof turn === "object" && !Array.isArray(turn)
      && typeof turn.skill === "string" && turn.skill.length > 0
      && typeof turn.skillPath === "string" && turn.skillPath.length > 0
      && typeof turn.read === "boolean" && typeof turn.stopBlocked === "boolean");
    if (!Array.isArray(value.listed) || !value.listed.every((name) => typeof name === "string") || !validTurn) {
      throw new Error("状態の形が正しくありません。");
    }
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return { listed: [], turn: null };
    throw error;
  }
}

async function saveState(file, state) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await fs.rename(temporary, file);
  } catch (error) {
    throw new Error(`状態の保存に失敗しました: ${error.message}`);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function savePromptState(file, state) {
  try {
    await saveState(file, state);
  } catch (error) {
    try {
      await fs.writeFile(file, JSON.stringify(state), { mode: 0o600 });
    } catch (directWriteError) {
      try {
        await fs.rm(file, { force: true });
      } catch (removeError) {
        error.message += `（古い状態の後始末にも失敗しました: 直接保存: ${directWriteError.message}、削除: ${removeError.message}）`;
      }
    }
    throw error;
  }
}

async function listedSkills(tool) {
  const directory = path.join(root, tool === "claude" ? ".claude/skills" : ".agents/skills");
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const names = [];
  for (const entry of entries) {
    if (entry.isDirectory() && /^kiro-.+/.test(entry.name)) {
      try {
        if ((await fs.stat(path.join(directory, entry.name, "SKILL.md"))).isFile()) names.push(entry.name);
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
  return names.sort();
}

async function run() {
  const { event, tool } = argumentsOf(process.argv.slice(2));
  const input = await readInput();
  const file = stateFile(input.session_id);
  const state = await loadState(file);

  if (event === "session-start") {
    if (!(tool === "claude" && input.source === "compact")) {
      state.listed = await listedSkills(tool);
      await saveState(file, state);
    }
    return;
  }

  if (["pre-tool-use", "post-tool-use"].includes(event)
    && (typeof input.tool_name !== "string" || !input.tool_name.trim())) {
    throw new Error("ツール名を判定できません。");
  }
  if (["pre-tool-use", "post-tool-use"].includes(event)
    && (!input.tool_input || typeof input.tool_input !== "object" || Array.isArray(input.tool_input))) {
    throw new Error("ツールへの入力を判定できません。");
  }
  if (event === "stop" && typeof input.stop_hook_active !== "boolean") {
    throw new Error("終了フックの状態を判定できません。");
  }
  const cwd = tool === "codex" && typeof input.cwd === "string" ? input.cwd : root;
  if (event === "pre-tool-use") {
    const decision = decidePreToolUse(state.turn, { toolName: input.tool_name, toolInput: input.tool_input }, root, cwd);
    if (!decision.allow) {
      process.stdout.write(`${JSON.stringify({ hookSpecificOutput: {
        hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: decision.reason,
      } })}\n`);
    }
    return;
  }
  if (event === "post-tool-use") {
    if (!state.turn) return;
    const contents = await fs.readFile(path.join(root, state.turn.skillPath), "utf8");
    const firstLine = contents.split(/\r?\n/).find((line) => line.trim() !== "");
    if (firstLine && isSkillRead(state.turn, {
      toolName: input.tool_name, toolInput: input.tool_input, toolResponse: input.tool_response,
    }, firstLine, root, cwd)) {
      state.turn.read = true;
      await saveState(file, state);
    }
    return;
  }
  if (event === "stop") {
    const decision = decideStop(state.turn, input.stop_hook_active === true);
    if (decision.block) {
      state.turn.stopBlocked = true;
      await saveState(file, state);
      process.stdout.write(`${JSON.stringify({ decision: "block", reason: decision.reason })}\n`);
    } else if (state.turn !== null) {
      state.turn = null;
      await saveState(file, state);
    }
    return;
  }

  const command = typeof input.prompt === "string" ? detectCommand(input.prompt) : null;
  if (!command) {
    if (state.turn !== null) {
      state.turn = null;
      await savePromptState(file, state);
    }
    return;
  }
  const relative = skillPath(tool, command.skill);
  try {
    if (!(await fs.stat(path.join(root, relative))).isFile()) throw Object.assign(new Error(), { code: "ENOENT" });
  } catch (error) {
    if (error.code === "ENOENT") {
      if (state.turn !== null) { state.turn = null; await savePromptState(file, state); }
      return;
    }
    throw error;
  }

  const turn = { skill: command.skill, skillPath: relative,
    read: isExpandedInvocation(tool, command.sigil, command.skill, state.listed), stopBlocked: false };
  state.turn = turn;
  await savePromptState(file, state);
  if (!turn.read) {
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: {
      hookEventName: "UserPromptSubmit", additionalContext: messageAdditionalContext(turn),
    } })}\n`);
  }
}

run().catch((error) => {
  const detail = error.message || "詳細のないエラーです。";
  process.stderr.write(`kiro-gate: フックの処理に失敗しました。詳細: ${detail}\n`);
  process.exitCode = 0;
});
