// Claude Code と Codex のフック入力例（fixture）を作る補助。ホスト製品は呼ばない。

/** ホストごとに扱うイベント名。 */
export const HOSTS = {
  claude: ["PreToolUse", "PostToolUse", "Stop"],
  codex: ["PreToolUse", "PostToolUse", "PermissionRequest", "Stop"],
};

/**
 * フックの入力（標準入力に渡す JSON の中身）を作る。
 * @param {"claude"|"codex"} host
 * @param {string} event イベント名
 * @param {{cwd?: string, command?: string, tool?: string, toolInput?: object, sessionId?: string, omit?: string[], raw?: string}} [o]
 *   command は Bash 操作、tool と toolInput は MCP などの別ツール。omit は欠落させる項目、raw は不正な文字列をそのまま返す。
 * @returns {object|string}
 */
export const hookInput = (host, event, { cwd, command, tool, toolInput, sessionId = `${host}-session`, omit = [], raw } = {}) => {
  if (!HOSTS[host]) throw new Error(`未対応のホスト: ${host}`);
  if (raw !== undefined) return raw;
  const ev = { session_id: sessionId, cwd, hook_event_name: event };
  if (event === "Stop") ev.stop_hook_active = false;
  else {
    ev.tool_name = tool ?? "Bash";
    ev.tool_input = toolInput ?? (command === undefined ? {} : { command });
    if (event === "PostToolUse") ev.tool_response = { exit_code: 0 };
  }
  for (const k of omit) delete ev[k];
  return ev;
};
