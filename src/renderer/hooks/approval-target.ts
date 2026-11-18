import { nanoid } from 'nanoid'
import { useAgentStore, selectLoopSlice, type AgentLogEntry, type LoopSlice } from '../stores/agent.store'
import type { AskQuestion } from '../../shared/utils/ask-form'
import type { ApprovalMeta } from '../../shared/types/ipc.types'

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
  log: ReadonlyArray<Pick<AgentLogEntry, 'id' | 'type' | 'metadata'>>,
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

/** A pending approval as the runtime reports it on re-attach. */
export interface RestorableApproval {
  requestId: string
  name: string
  input: unknown
  /** The loop that raised it; main when absent. */
  loop?: string
}

/**
 * Put a pending approval back on its loop's view: on the newest unclaimed
 * tool_call for its tool, or else on `fallback` (default: a synthesized entry)
 * appended to the log — the log may be truncated or not loaded yet.
 */
export function restorePendingApproval(approval: RestorableApproval, meta: Partial<ApprovalMeta>, fallback?: AgentLogEntry): void {
  const store = useAgentStore.getState()
  const slice = selectLoopSlice(store, approval.loop)
  const log = slice.log
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i]
    if (entry.type === 'tool_call' && entry.metadata?.name === approval.name && !slice.pendingApprovals.has(entry.id)) {
      store.addPendingApproval(entry.id, approval.requestId, meta, approval.loop)
      return
    }
  }
  const target: AgentLogEntry = fallback ?? {
    id: nanoid(),
    type: 'tool_call',
    content: `Calling ${approval.name}`,
    timestamp: Date.now(),
    metadata: { name: approval.name, input: approval.input }
  }
  store.addLogEntry(target, approval.loop)
  store.addPendingApproval(target.id, approval.requestId, meta, approval.loop)
}

/** A pending ask as the runtime reports it on re-attach. */
export interface RestorableAsk {
  requestId: string
  questions: AskQuestion[]
  /** The loop that asked; main when absent. */
  loop?: string
}

/**
 * Put a pending ask's form back on its loop's view: on the newest unclaimed
 * `ask` call, or else on `fallback` (default: a synthesized one) appended.
 */
export function restorePendingAsk(ask: RestorableAsk, fallback?: AgentLogEntry): void {
  const store = useAgentStore.getState()
  const slice = selectLoopSlice(store, ask.loop)
  for (let i = slice.log.length - 1; i >= 0; i--) {
    const entry = slice.log[i]
    if (entry.type === 'tool_call' && entry.metadata?.name === 'ask' && !slice.pendingAsks.has(entry.id)) {
      store.addPendingAsk(entry.id, ask.requestId, ask.questions, ask.loop)
      return
    }
  }
  const target: AgentLogEntry = fallback ?? {
    id: nanoid(),
    type: 'tool_call',
    content: 'Calling ask',
    timestamp: Date.now(),
    metadata: { name: 'ask', input: { questions: ask.questions } }
  }
  store.addLogEntry(target, ask.loop)
  store.addPendingAsk(target.id, ask.requestId, ask.questions, ask.loop)
}

/**
 * After a loop's log was replaced (a side loop's history loading on first
 * open), re-bind each pending approval and ask whose entry is gone. Live
 * events can reach a side loop's slice before its tab ever loaded history;
 * without this the card would point at an entry that no longer exists.
 */
export function rebindPendingRequests(previous: Pick<LoopSlice, 'log' | 'pendingApprovals' | 'pendingAsks'>, loop: string): void {
  const store = useAgentStore.getState()
  const current = new Set(selectLoopSlice(store, loop).log.map((entry) => entry.id))
  const previousEntry = (id: string) => previous.log.find((e) => e.id === id)
  for (const [entryId, info] of previous.pendingApprovals) {
    if (current.has(entryId)) continue
    const entry = previousEntry(entryId)
    store.removePendingApproval(entryId, loop)
    if (!entry) continue
    const { requestId, ...meta } = info
    if (entry.metadata?.outOfBand === true) {
      // Raised beside the turn: it has no call in the history to land on.
      store.addLogEntry(entry, loop)
      store.addPendingApproval(entry.id, requestId, meta, loop)
      continue
    }
    restorePendingApproval({ requestId, name: String(entry.metadata?.name ?? 'tool'), input: entry.metadata?.input, loop }, meta, entry)
  }
  for (const [entryId, ask] of previous.pendingAsks) {
    if (current.has(entryId)) continue
    store.removePendingAsk(entryId, loop)
    restorePendingAsk({ requestId: ask.requestId, questions: ask.questions, loop }, previousEntry(entryId))
  }
}
