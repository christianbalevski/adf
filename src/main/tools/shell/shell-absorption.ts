/**
 * Shell-absorbable tool set.
 *
 * adf_shell is presented ALONGSIDE the other tools — enabling it does NOT hide
 * anything. This set is advisory: it names the tools whose functionality the
 * shell can already drive by name, so an operator or agent optimizing for a
 * small context window can toggle their `visible` flag off (reclaiming the old
 * absorption token-savings) while keeping the shell as the interface. Nothing in
 * the runtime filters on this set anymore; visibility is the single dial.
 */

/** Tools the shell can drive by name — safe candidates to hide for token savings.
 *  fs_write is intentionally excluded — agents use it directly for multi-line
 *  content creation, which is more ergonomic as a structured tool call. */
const ABSORBED_TOOLS = new Set([
  'fs_read', 'fs_list', 'fs_delete',
  'db_query', 'db_execute',
  'msg_send', 'msg_read', 'msg_list', 'agent_discover', 'msg_update', 'msg_delete',
  'sys_set_timer', 'sys_list_timers', 'sys_delete_timer',
  'sys_code', 'sys_lambda', 'sys_fetch',
  'sys_get_config', 'sys_update_config',
  'sys_get_meta', 'sys_set_meta', 'sys_delete_meta',
])

/** Tools that should stay as structured schemas even in a hide-for-tokens pass
 *  (their ergonomics or protocol don't reduce cleanly to a shell command). */
const NON_ABSORBED = new Set([
  'say', 'ask', 'loop_compact', 'loop_clear',
  'sys_set_state', 'sys_create_adf', 'adf_shell',
  'fs_transfer', 'compute_exec',
])

/**
 * Whether a tool is a safe candidate to hide (visible:false) when optimizing for
 * a small context window — i.e. the shell can drive it by name. Advisory only;
 * the runtime no longer filters schemas on this. MCP tools count as absorbable.
 */
export function isAbsorbedByShell(toolName: string): boolean {
  if (NON_ABSORBED.has(toolName)) return false
  if (ABSORBED_TOOLS.has(toolName)) return true
  if (toolName.startsWith('mcp_')) return true
  return false
}

/** Get the set of shell-absorbable tool names (for testing/inspection) */
export function getAbsorbedTools(): ReadonlySet<string> {
  return ABSORBED_TOOLS
}
