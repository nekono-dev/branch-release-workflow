import path from "node:path";

export function detectCommand(prompt) {
  const match = /^([/$])(kiro-[a-z0-9-]+)(?=\s|$)/.exec(prompt.trimStart());
  return match ? { skill: match[2], sigil: match[1] } : null;
}

export function skillPath(tool, skill) {
  const directory = tool === "claude" ? ".claude" : ".agents";
  return `${directory}/skills/${skill}/SKILL.md`;
}

export function isExpandedInvocation(tool, sigil, skill, listed) {
  return ((tool === "claude" && sigil === "/") || (tool === "codex" && sigil === "$"))
    && listed.includes(skill);
}

export function decidePreToolUse(state, call, root, cwd = root) {
  if (!state || state.read) return { allow: true };

  const absSkillPath = path.resolve(root, state.skillPath);
  if (call.toolName === "ToolSearch") return { allow: true };
  if (call.toolName === "Read" && typeof call.toolInput?.file_path === "string"
    && path.isAbsolute(call.toolInput.file_path)
    && path.resolve(call.toolInput.file_path) === absSkillPath) {
    return { allow: true };
  }
  if (call.toolName === "Bash" && typeof call.toolInput?.command === "string"
    && isReadCommand(call.toolInput.command, cwd, absSkillPath)) {
    return { allow: true };
  }

  return { allow: false, reason: messageDeny(state) };
}

export function isReadCommand(command, cwd, absSkillPath) {
  const firstCommand = command.split(/&&|[;|]/, 1)[0].trim();
  const words = firstCommand.match(/(?:"[^"]*"|'[^']*'|\S+)/g) ?? [];
  const executable = words[0]?.replace(/^['"]|['"]$/g, "");
  if (!["cat", "head", "nl"].includes(executable)) return false;

  return words.slice(1).some((word) => {
    if (word.startsWith("-")) return false;
    const argument = word.replace(/^['"]|['"]$/g, "");
    return path.resolve(cwd, argument) === path.resolve(absSkillPath);
  });
}

export function isSkillRead(state, call, firstLine, root, cwd = root) {
  const readOperation = (call.toolName === "Read"
    && typeof call.toolInput?.file_path === "string"
    && path.isAbsolute(call.toolInput.file_path)
    && path.resolve(call.toolInput.file_path) === path.resolve(root, state.skillPath))
    || (call.toolName === "Bash"
      && typeof call.toolInput?.command === "string"
      && isReadCommand(call.toolInput.command, cwd, path.resolve(root, state.skillPath)));
  if (!readOperation || !decidePreToolUse(state, call, root, cwd).allow) return false;

  const response = typeof call.toolResponse === "string"
    ? call.toolResponse
    : JSON.stringify(call.toolResponse) ?? "";
  return response.includes(firstLine);
}

export function messageDeny(state) {
  return `先に手順書 ${state.skillPath} を読んでから、作業を進めてください。`;
}

export function decideStop(state, stopHookActive) {
  if (!state || state.read || state.stopBlocked || stopHookActive) return { block: false };
  return { block: true, reason: messageStop(state) };
}

export function messageAdditionalContext(state) {
  return `作業の前に手順書 ${state.skillPath} を先に読み、その手順に従って作業を進めてください。`;
}

export function messageStop(state) {
  return `手順書 ${state.skillPath} を先に読んでから、作業を続けてください。`;
}
