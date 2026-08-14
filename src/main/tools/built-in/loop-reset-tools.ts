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

/** What goes wrong for each tool when the executor branch is skipped. */
const INDIRECT_EFFECT: Record<string, string> = {
  loop_compact: 'it would report compaction started while nothing is summarized or cleared',
  loop_clear: 'it would delete the loop rows while the live session keeps sending them, desyncing the two',
}

/** Refusal text for an indirect loop-reset call. `via` names the door used. */
export function loopResetRefusal(tool: string, via: 'adf_shell' | 'code'): string {
  const effect = INDIRECT_EFFECT[tool] ?? 'it would not take effect'
  return (
    `${tool} only works as a direct tool call — the runtime completes the loop reset ` +
    `after the turn by matching the top-level tool name. Invoked through ${via}, ` +
    `${effect}. Call the ${tool} tool directly instead.`
  )
}
