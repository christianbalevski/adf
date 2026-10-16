import { nanoid } from 'nanoid'
import { useAgentStore, MAIN_LOOP } from '../stores/agent.store'
import { useDocumentStore } from '../stores/document.store'
import { useMessageQueueStore, queuedLoops } from '../stores/message-queue.store'
import type { BackgroundAgentStatus } from '../../shared/types/ipc.types'

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

/**
 * Background agents whose state just moved: send what is queued for any loop
 * that has settled. The open agent is not handled here; its own state events
 * (and the re-attach on open) deliver its queue.
 *
 * Main settles on idle. A background status carries no per-loop state, only
 * how many inner loops are mid-turn, so an inner loop's queue goes once none
 * is, and only while the agent is up: main refuses a loop dispatch while it is
 * off or suspended, and the message would be lost.
 */
export function deliverSettledBackgroundQueues(agents: BackgroundAgentStatus[], filePaths: Iterable<string>): void {
  for (const filePath of new Set(filePaths)) {
    const loops = queuedLoops(useMessageQueueStore.getState(), filePath)
    if (loops.length === 0) continue
    const status = agents.find((a) => a.filePath === filePath)
    if (!status) continue
    const up = status.state === 'idle' || status.state === 'active'
    for (const loop of loops) {
      const settled = loop === MAIN_LOOP ? status.state === 'idle' : up && (status.activeLoops ?? 0) === 0
      if (settled) deliverQueuedMessages(filePath, loop)
    }
  }
}
