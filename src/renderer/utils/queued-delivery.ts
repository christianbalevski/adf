import { nanoid } from 'nanoid'
import { useAgentStore, MAIN_LOOP } from '../stores/agent.store'
import { useDocumentStore } from '../stores/document.store'
import { useMessageQueueStore, queuedLoops } from '../stores/message-queue.store'
import type { BackgroundAgentStatus, RendererBackgroundAgentEvent } from '../../shared/types/ipc.types'

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
 * Send the queues of an agent's loops that have settled, given the state each
 * loop reported (main under MAIN_LOOP).
 *
 * Only `idle` settles, as on the open agent's own path: a loop waiting on an
 * approval or an ask, or one that errored, keeps its queue. An inner loop also
 * needs main up; main refuses a loop dispatch while the agent is off.
 */
export function deliverSettledQueues(filePath: string, loopStates: Record<string, string>, mainState: string | undefined): void {
  for (const loop of queuedLoops(useMessageQueueStore.getState(), filePath)) {
    if (loopStates[loop] !== 'idle') continue
    if (loop !== MAIN_LOOP && mainState === 'off') continue
    deliverQueuedMessages(filePath, loop)
  }
}

/**
 * One background batch: send the queue of every loop whose LAST reported state
 * in the batch is idle. Per loop, from the loop's own transition, never from
 * the inner-loop count (a count that stays 0 → 0 hides a loop's turn end).
 * `skip` names agents whose queue is someone else's job (the file being opened).
 */
export function deliverSettledBackgroundQueues(
  agents: BackgroundAgentStatus[],
  events: RendererBackgroundAgentEvent[],
  skip: (filePath: string) => boolean
): void {
  const reported = new Map<string, Record<string, string>>()
  const note = (filePath: string, loop: string, state: unknown): void => {
    if (typeof state !== 'string') return
    const states = reported.get(filePath) ?? {}
    states[loop] = state
    reported.set(filePath, states)
  }
  for (const event of events) {
    const payload = event.payload as RendererBackgroundAgentEvent['payload'] & { loop?: unknown; loopStates?: unknown; state?: unknown }
    switch (event.type) {
      case 'agent_started':
        note(payload.filePath, MAIN_LOOP, payload.state)
        if (payload.loopStates && typeof payload.loopStates === 'object') {
          for (const [loop, state] of Object.entries(payload.loopStates)) note(payload.filePath, loop, state)
        }
        break
      case 'agent_state_changed':
        note(payload.filePath, MAIN_LOOP, payload.state)
        break
      case 'agent_loop_state_changed':
        if (typeof payload.loop === 'string') note(payload.filePath, payload.loop, payload.state)
        break
    }
  }
  for (const [filePath, states] of reported) {
    if (skip(filePath)) continue
    deliverSettledQueues(filePath, states, agents.find((a) => a.filePath === filePath)?.state)
  }
}
