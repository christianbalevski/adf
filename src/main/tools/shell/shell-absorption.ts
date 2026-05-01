/**
 * Tool absorption rules for the shell.
 *
 * When shell is enabled, absorbed tools are NOT injected as individual schemas
 * to the LLM — saving thousands of tokens per turn.
 */

/** Tools absorbed by the shell (not injected as individual LLM tool schemas).
 *  fs_write is intentionally NOT absorbed — agents use it directly for
 *  multi-line content creation, which is more ergonomic as a structured tool call. */
const ABSORBED_TOOLS = new Set([
  'fs_read', 'fs_list', 'fs_delete',
  'db_query', 'db_execute',
  'msg_send', 'msg_read', 'msg_list', 'agent_discover', 'msg_update', 'msg_delete',
  'sys_set_timer', 'sys_list_timers', 'sys_delete_timer',
  'sys_code', 'sys_lambda', 'sys_fetch',
  'sys_get_config', 'sys_update_config',
  'sys_get_meta', 'sys_set_meta', 'sys_delete_meta',
])

/** Tools that always remain as structured tool calls (never absorbed) */
const NON_ABSORBED = new Set([
  'say', 'ask', 'loop_compact', 'loop_clear',
  'sys_set_state', 'sys_create_adf', 'adf_shell',
  'fs_transfer', 'compute_exec',
])

/**
 * Check if a tool is absorbed by the shell.
 * MCP tools (names starting with 'mcp_') are also absorbed.
 */
export function isAbsorbedByShell(toolName: string): boolean {
  if (NON_ABSORBED.has(toolName)) return false
  if (ABSORBED_TOOLS.has(toolName)) return true
  if (toolName.startsWith('mcp_')) return true
  return false
}

/** Get the set of absorbed tool names (for testing/inspection) */
export function getAbsorbedTools(): ReadonlySet<string> {
  return ABSORBED_TOOLS
}
