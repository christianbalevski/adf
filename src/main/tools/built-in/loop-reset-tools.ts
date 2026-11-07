/**
 * Loop-reset tools (loop_compact, loop_clear) are only HALF a tool. Their
 * execute() cannot finish the job: AgentExecutor completes it in turn
 * post-processing, and it decides by matching the TOP-LEVEL tool block name of
 * the model's turn (`toolBlock.name === 'loop_compact' | 'loop_clear'`).
 *
 * Any indirect invocation — `adf loop_compact` through adf_shell, or
 * adf.loop_compact() from sandbox code — arrives at the tool as a nested call,
 * so the executor branch never fires:
 *
 *   loop_compact  the tool only reports intent; the summarize / clear / re-seed
 *                 pass lives entirely in the executor. Result: the agent is
 *                 told "Compaction initiated for N loop entries" and nothing is
 *                 compacted at all.
 *   loop_clear    the tool does delete the adf_loop rows, but the executor's
 *                 session reset (session.reset + restoreMessages +
 *                 resetContextState) never runs, so the in-memory conversation
 *                 still holds the deleted turns and keeps sending them. Result:
 *                 the DB and the live session silently disagree.
 *
 * Both failures are quiet, so the indirect doors refuse these names outright
 * rather than report a success that isn't one.
 */

export const LOOP_RESET_TOOLS = new Set(['loop_compact', 'loop_clear'])

/**
 * Tools that belong to the model's own turn and cannot be called from code:
 * `say` is its own tool_use block in the conversation, and the executor
 * intercepts `ask` by its top-level name to block on the human.
 */
export const TURN_ONLY_TOOLS = new Set(['say', 'ask'])

/**
 * Whether `tool` may run as a background task (`_async: true`). A task runs
 * the tool through the registry outside the turn, so every tool the executor
 * completes or intercepts by its top-level name is out.
 */
export function canRunAsTask(tool: string): boolean {
  return !LOOP_RESET_TOOLS.has(tool) && !TURN_ONLY_TOOLS.has(tool)
}

/**
 * Built-in tools that wait on something outside the process (a subprocess, a
 * container, the network, sandboxed code), so running them as a task frees the
 * turn. The local fs_* and db_* tools run on synchronous SQLite in-process: as a
 * task they block the same event loop a moment later and add a wake turn.
 * mcp_install / mcp_uninstall are left out because `adf_shell` can already run
 * them in the background.
 */
export const EXTERNAL_WAIT_TOOLS = new Set(['adf_shell', 'sys_code', 'sys_lambda', 'sys_fetch', 'compute_exec'])

/**
 * Whether the LLM loop offers (and honors) `_async` on `tool`: a tool that waits
 * on something external, any MCP server tool, or any tool restricted for this
 * agent. A restricted call waits on the owner's approval, so `_async` lets the
 * agent keep working until the owner decides. Code (`adf.<tool>({ _async: true })`)
 * may run any task-capable tool in the background; this only shapes the
 * model's schema.
 */
export function offersAsync(tool: string, opts: { mcp: boolean; restricted: boolean }): boolean {
  if (!canRunAsTask(tool)) return false
  return EXTERNAL_WAIT_TOOLS.has(tool) || opts.mcp || opts.restricted
}

/** What goes wrong for each tool when the executor branch is skipped. */
const INDIRECT_EFFECT: Record<string, string> = {
  loop_compact: 'it would report compaction started while nothing is summarized or cleared',
  loop_clear: 'it would delete the loop rows while the live session keeps sending them, desyncing the two',
}

/** Refusal text for an indirect loop-reset call. `via` names the door used. */
export function loopResetRefusal(tool: string, via: 'adf_shell' | 'code' | '_async'): string {
  const effect = INDIRECT_EFFECT[tool] ?? 'it would not take effect'
  return (
    `${tool} only works as a direct tool call — the runtime completes the loop reset ` +
    `after the turn by matching the top-level tool name. Invoked through ${via}, ` +
    `${effect}. Call the ${tool} tool directly instead.`
  )
}
