import type { AgentLogEntry } from '../stores/agent.store'

/**
 * `metadata.seq` — the adf_loop row a transcript entry came from — on entries
 * the renderer appended LIVE, so they are indistinguishable from the same turn
 * rehydrated through `parseLoopToDisplay`.
 *
 * Why it matters: "Load earlier" pages by keyset on the seq of the oldest entry
 * still in the window. Hydrated rows carry one; live-streamed entries did not,
 * so a session that had streamed past its loaded head had no usable cursor at
 * all — and nothing could ever cap the in-memory transcript, because a dropped
 * head would be unreachable rather than paginated.
 *
 * The main process stamps most entries on the event that finalizes them (the
 * row is written through to SQLite before the event goes out). Two shapes need
 * a late stamp instead, and both are handled here:
 *
 *  - text/thinking blocks, which are STREAMED into the transcript before their
 *    assistant row exists. Their seq arrives with the first `tool_call_start`
 *    of that row, or with `turn_complete` for a row that called no tool.
 *  - tool results, shown one by one as each tool returns but persisted as one
 *    user row after the whole batch (`loop_seq`).
 *
 * One row can expand into several display entries, exactly as
 * `parseLoopToDisplay` splits a row's content blocks — so every entry derived
 * from one row shares that row's seq.
 */

/** True when this entry has no adf_loop seq yet. */
export function lacksSeq(entry: AgentLogEntry): boolean {
  return typeof entry.metadata?.seq !== 'number'
}

/**
 * Indexes of the streamed text/thinking entries that belong to the assistant
 * row which has just been persisted: the contiguous run at the tail that is
 * still unstamped.
 *
 * Contiguity is the whole guard. Anything else at the tail — a tool_call, a
 * tool_result, an injected context card — is a row boundary, so the walk stops
 * there and can never reach into an earlier row's blocks.
 */
export function pendingBlockIndexes(log: AgentLogEntry[]): number[] {
  const indexes: number[] = []
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i]
    if (entry.type !== 'text' && entry.type !== 'thinking') break
    if (!lacksSeq(entry)) break
    indexes.push(i)
  }
  return indexes.reverse()
}

/**
 * Indexes of the unstamped `tool_result` entries produced by the given tool
 * calls. Scans backwards and stops at the first entry older than the batch,
 * so a long transcript is not re-walked for every batch.
 */
export function pendingToolResultIndexes(log: AgentLogEntry[], toolUseIds: string[]): number[] {
  if (toolUseIds.length === 0) return []
  const wanted = new Set(toolUseIds)
  const indexes: number[] = []
  for (let i = log.length - 1; i >= 0 && wanted.size > 0; i--) {
    const entry = log[i]
    if (entry.type !== 'tool_result') continue
    const id = entry.metadata?.tool_use_id
    if (typeof id !== 'string' || !wanted.has(id)) continue
    wanted.delete(id)
    if (lacksSeq(entry)) indexes.push(i)
  }
  return indexes.reverse()
}

/**
 * The keyset cursor for "Load earlier": the seq of the OLDEST loaded entry that
 * has one. Scanning forward (rather than taking `log[0]`) keeps it correct for
 * a window whose head is a live entry that has not been stamped yet — and, once
 * every live entry is stamped, it is simply the first entry's seq.
 */
export function pickOldestSeq(log: Array<{ metadata?: Record<string, unknown> }>): number | undefined {
  for (const entry of log) {
    const seq = entry.metadata?.seq
    if (typeof seq === 'number') return seq
  }
  return undefined
}
