import type { AgentLogEntry } from '../stores/agent.store'
import { lacksSeq } from '../hooks/live-seq'

export function isTurnCompleteMarker(entry: AgentLogEntry): boolean {
  return entry.type === 'system' && entry.content.trim().toLowerCase() === 'turn complete'
}

/**
 * A runtime notice to the owner (`context_injected`, category `System`):
 * compaction, a provider that gave up, the silent-turn nudge. Status, not
 * workflow noise, so it is never folded into an activity group.
 */
export function isSystemNotice(entry: AgentLogEntry): boolean {
  return entry.type === 'context' && entry.metadata?.category === 'System'
}

/** The notice the executor emits when a compaction begins. */
export function isCompactingNotice(entry: AgentLogEntry): boolean {
  return isSystemNotice(entry) && /^(auto-)?compacting\b/i.test(entry.content.trim())
}

export interface LoopActivity {
  entryId: string | null
  phase: 'Thinking…' | 'Compacting…' | 'Starting agent…' | null
}

/** The glimmer describes the agent continuing, not an unfinished tool call. */
export function getLoopActivity(
  log: AgentLogEntry[],
  { active, starting, waiting, autonomous = false }: { active: boolean; starting: boolean; waiting: boolean; autonomous?: boolean },
): LoopActivity {
  const none: LoopActivity = { entryId: null, phase: null }
  const compacting: LoopActivity = { entryId: null, phase: 'Compacting…' }
  if (waiting) return none
  if (starting) return { entryId: null, phase: 'Starting agent…' }
  // A manual /compact runs between turns. Its notice is the last row until
  // the compacted log replaces the window, or a failure notice follows it.
  if (!active) return log.length > 0 && isCompactingNotice(log[log.length - 1]) ? compacting : none

  let sawNotice = false
  for (let index = log.length - 1; index >= 0; index--) {
    const entry = log[index]
    if (isTurnCompleteMarker(entry) || entry.type === 'error') return none
    // A streamed answer is its own activity indicator; never animate its prose.
    // An autonomous loop doesn't stop at a reply: once the block is closed
    // (stamped with its row, or a quiet-turn marker) the next call is underway.
    if (entry.type === 'text') {
      const closed = entry.metadata?.quietTurn === true || !lacksSeq(entry)
      return autonomous && closed ? { entryId: null, phase: 'Thinking…' } : none
    }
    if (entry.type === 'user' || entry.type === 'trigger' || entry.type === 'compaction') break
    if (entry.type === 'thinking') return { entryId: entry.id, phase: null }
    if (entry.type === 'tool_call') {
      // `say` never ends the turn, so the model is already composing its next
      // step — whose input arrives only when complete. Keep its prose still,
      // but show the trailing phase so a long next call isn't a silent gap.
      if (entry.metadata?.name === 'say') return { entryId: null, phase: 'Thinking…' }
      return { entryId: entry.id, phase: null }
    }
    // The latest notice decides: one after "Compacting" (it failed) ends it.
    if (isSystemNotice(entry)) {
      if (!sawNotice && isCompactingNotice(entry)) return compacting
      sawNotice = true
    }
    // Results and context updates don't end activity. Leave the glimmer on
    // the latest step while the model processes the result and decides next.
  }
  return { entryId: null, phase: 'Thinking…' }
}

export interface LiveStep {
  /** The call's `_reason`, or its tool name when it gave none. */
  text: string
  /** False once anything (a result, thinking, prose) follows the call. */
  running: boolean
}

/**
 * The latest tool call of the turn in progress, for the titlebar's live line.
 * Null before the turn's first call and once the turn has ended, so a reason
 * from an earlier turn never stands in for what the agent is doing now.
 */
export function getLiveStep(log: AgentLogEntry[]): LiveStep | null {
  let settled = false
  for (let index = log.length - 1; index >= 0; index--) {
    const entry = log[index]
    if (isTurnCompleteMarker(entry) || entry.type === 'error' || entry.type === 'user' || entry.type === 'trigger') return null
    if (entry.type === 'tool_call') {
      const input = entry.metadata?.input
      const reason = input && typeof input === 'object' ? (input as Record<string, unknown>)._reason : undefined
      const name = entry.metadata?.name
      const text = (typeof reason === 'string' && reason.trim()) || (typeof name === 'string' ? name : '')
      return text ? { text, running: !settled } : null
    }
    if (entry.type === 'text' || entry.type === 'thinking' || entry.type === 'tool_result') settled = true
  }
  return null
}
