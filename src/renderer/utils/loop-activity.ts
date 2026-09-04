import type { AgentLogEntry } from '../stores/agent.store'

export function isTurnCompleteMarker(entry: AgentLogEntry): boolean {
  return entry.type === 'system' && entry.content.trim().toLowerCase() === 'turn complete'
}

export interface LoopActivity {
  entryId: string | null
  phase: 'Thinking…' | 'Starting agent…' | null
}

/** The glimmer describes the agent continuing, not an unfinished tool call. */
export function getLoopActivity(
  log: AgentLogEntry[],
  { active, starting, waiting }: { active: boolean; starting: boolean; waiting: boolean },
): LoopActivity {
  const none: LoopActivity = { entryId: null, phase: null }
  if (waiting) return none
  if (starting) return { entryId: null, phase: 'Starting agent…' }
  if (!active) return none

  for (let index = log.length - 1; index >= 0; index--) {
    const entry = log[index]
    if (isTurnCompleteMarker(entry) || entry.type === 'error') return none
    // A streamed answer is its own activity indicator; never animate its prose.
    if (entry.type === 'text') return none
    if (entry.type === 'user' || entry.type === 'trigger') break
    if (entry.type === 'thinking') return { entryId: entry.id, phase: null }
    if (entry.type === 'tool_call') {
      if (entry.metadata?.name === 'say') return none
      return { entryId: entry.id, phase: null }
    }
    // Results and context updates don't end activity. Leave the glimmer on
    // the latest step while the model processes the result and decides next.
  }
  return { entryId: null, phase: 'Thinking…' }
}
