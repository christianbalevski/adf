import type { AgentLogEntry } from '../stores/agent.store'

/**
 * What the chat says about a message sent straight to an idle loop, judged
 * from the rows that arrived after it (`before`: the ids already shown when
 * it was sent). `failed`: the send path wrote its "Not sent" row. `delivered`:
 * the agent did anything else. `pending`: nothing has decided it yet.
 */
export function directSendOutcome(log: AgentLogEntry[], before: ReadonlySet<string>): 'failed' | 'delivered' | 'pending' {
  let outcome: 'delivered' | 'pending' = 'pending'
  for (let index = log.length - 1; index >= 0; index--) {
    const entry = log[index]
    if (before.has(entry.id)) break
    if (entry.type === 'error' && entry.content.startsWith('Not sent: ')) return 'failed'
    if (entry.type !== 'user') outcome = 'delivered'
  }
  return outcome
}

/** The composer text after a failed send comes back: the message, then anything typed since. */
export function restoreDraft(current: string, text: string): string {
  if (!text) return current
  return current.trim() ? `${text}\n\n${current}` : text
}

/**
 * Whether the composer's send goes to the loop's queue rather than straight
 * to the agent: the loop is mid-turn, or older messages still wait. Mirrors
 * `queueOwnerMessage`; a queued message is never lost, it shows in the queue.
 */
export function sendIsQueued(filePath: string | null, loopState: string, queueLength: number): boolean {
  return filePath !== null && (loopState === 'active' || queueLength > 0)
}
