import { nanoid } from 'nanoid'
import { useAgentStore } from '../stores/agent.store'
import { useDocumentStore } from '../stores/document.store'
import { useMessageQueueStore } from '../stores/message-queue.store'

/**
 * Send a loop's queued messages as one chat, now that its turn has ended.
 *
 * Works for any agent, open or not: the queue is taken (removed) first, so a
 * second settle signal for the same turn end finds nothing. Only the open
 * agent gets the optimistic user bubble; a background agent's message is in
 * its loop history when the owner opens it again.
 */
export function deliverQueuedMessages(filePath: string, loop: string): boolean {
  const queue = useMessageQueueStore.getState().take(filePath, loop)
  if (queue.length === 0) return false
  const combined = queue.map((m) => m.text).join('\n\n')
  const content = queue.flatMap((m) => m.content ?? [{ type: 'text' as const, text: m.text }])
  const imagePreviewUrls = queue.flatMap((m) => m.imagePreviewUrls ?? [])
  if (useDocumentStore.getState().filePath === filePath) {
    const agentStore = useAgentStore.getState()
    agentStore.addLogEntry({
      id: nanoid(),
      type: 'user',
      content: combined,
      timestamp: Date.now(),
      metadata: imagePreviewUrls.length > 0 ? { imagePreviewUrls } : undefined
    }, loop)
    agentStore.setState('active', loop)
  }
  window.adfApi?.invokeAgent(combined, filePath, content, loop)
  return true
}
