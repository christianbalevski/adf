import type { ChatHistoryEntry } from '@shared/types/adf.types'

/**
 * Pick the log entry a HIL approval prompt belongs to.
 *
 * Main-loop HIL emits the tool_call entry immediately before the approval, so
 * the match is the newest in-flight call. But a protection override raised by
 * sandboxed code, a shell pipeline, or an async task has NO log entry of its
 * own — taking "the last entry" glued those prompts onto whatever the agent
 * last called (a sys_set_meta override reading as "sys_code awaiting
 * approval"), and when the last entry wasn't a tool_call the prompt rendered
 * nowhere at all while still blocking the agent.
 *
 * Returns the id of the matching entry, or null when the caller should
 * synthesize one for the approval.
 */
export function findApprovalTargetEntry(
  log: ReadonlyArray<ChatHistoryEntry>,
  toolName: string,
  isClaimed: (entryId: string) => boolean,
): string | null {
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i]
    // Everything before the newest tool_result has already finished — an
    // approval can only belong to a call still in flight.
    if (entry.type === 'tool_result') return null
    if (entry.type !== 'tool_call') continue
    if (entry.metadata?.name !== toolName) continue
    if (isClaimed(entry.id)) continue // an earlier prompt already owns it
    return entry.id
  }
  return null
}
