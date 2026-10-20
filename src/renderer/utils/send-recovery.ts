import { useAgentStore, selectLoopSlice, type AgentLogEntry } from '../stores/agent.store'
import { useDocumentStore } from '../stores/document.store'
import type { SendRoute } from './composer-send'

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
 * Send from a composer and give the message back to it (`restore`) when it
 * was not sent and nothing else holds it. Each unsent message has exactly one
 * home, so the composer is refilled only when the queue does not have it:
 * - `queued` (queued, or a start that did not happen, marked "Not sent" with
 *   the reason): the queue entry is its home; the composer is left alone.
 * - `direct`: the chat decides. A "Not sent" row (a refused send) refills
 *   the composer; anything else from the agent means it was delivered. A
 *   refusal after the owner switched agents goes into that agent's queue
 *   (sendOwnerMessage), so it is not refilled here either.
 * - a thrown send: nothing took it, so the composer gets it back.
 */
export async function sendWithRecovery(filePath: string | null, loop: string, send: () => Promise<SendRoute>, restore: () => void): Promise<void> {
  const before = new Set(selectLoopSlice(useAgentStore.getState(), loop).log.map((entry) => entry.id))
  let route: SendRoute
  try {
    route = await send()
  } catch (error) {
    console.warn('[chat] Send failed:', error)
    restore()
    return
  }
  if (route === 'queued') return
  const settle = (): boolean => {
    if (useDocumentStore.getState().filePath !== filePath) return true
    const outcome = directSendOutcome(selectLoopSlice(useAgentStore.getState(), loop).log, before)
    if (outcome === 'pending') return false
    if (outcome === 'failed') restore()
    return true
  }
  if (settle()) return
  const unsubscribe = useAgentStore.subscribe(() => { if (settle()) unsubscribe() })
}
