import { nanoid } from 'nanoid'
import { useAgentStore, selectLoopSlice, MAIN_LOOP, type AgentState } from '../stores/agent.store'
import { useDocumentStore } from '../stores/document.store'
import { useMessageQueueStore, queuedLoops, selectQueue, sameAgentPath, heldForOwner, MAX_AUTOMATIC_SENDS, type QueuedMessage } from '../stores/message-queue.store'
import type { BackgroundAgentStatus, RendererBackgroundAgentEvent } from '../../shared/types/ipc.types'
import type { ContentBlock } from '../../shared/types/provider.types'

/**
 * Send a loop's queued messages as one chat, now that its turn has ended.
 *
 * Works for any agent, open or not: the queue is taken (removed) first, so a
 * second settle signal for the same turn end finds nothing.
 *
 * `automatic`: a turn end sends it, not the owner. A queue whose send failed
 * MAX_AUTOMATIC_SENDS times in a row is then left alone: it stays shown as
 * "Not sent" with the reason until the owner sends it (Send now, or the next
 * message, which takes the whole queue along).
 */
export function deliverQueuedMessages(filePath: string, loop: string, opts: { automatic?: boolean } = {}): boolean {
  if (opts.automatic && heldForOwner(selectQueue(useMessageQueueStore.getState(), filePath, loop))) {
    console.warn(`[queue] Not retrying the queue of ${filePath} (${loop}) on this turn end: its send failed ${MAX_AUTOMATIC_SENDS} times; it waits for the owner`)
    return false
  }
  const queue = useMessageQueueStore.getState().take(filePath, loop)
  if (queue.length === 0) return false
  sendQueuedMessages(filePath, loop, queue)
  return true
}

/**
 * Send messages already taken off a queue as one chat. Only the open agent
 * gets the optimistic user bubble; a background agent's message is in its
 * loop history when the owner opens it again.
 *
 * A send main did not take ({success: false}, or a rejected call) is never
 * dropped: the messages go back to the head of their queue in order, marked
 * with the error so the queue shows them as not sent, and the bubble that
 * claimed they went is taken back. A send the backend took but could not see
 * through (`accepted`: daemon mode, the connection dropped or the wait timed
 * out after the daemon answered the chat) was delivered: it stays sent, or
 * the next idle would send it twice.
 */
export function sendQueuedMessages(filePath: string, loop: string, queue: QueuedMessage[]): void {
  const combined = queue.map((m) => m.text).join('\n\n')
  const content = queue.flatMap((m) => m.content ?? [{ type: 'text' as const, text: m.text }])
  const imagePreviewUrls = queue.flatMap((m) => m.imagePreviewUrls ?? [])
  let bubbleId: string | null = null
  let previousState: AgentState | null = null
  if (sameAgentPath(useDocumentStore.getState().filePath, filePath)) {
    const agentStore = useAgentStore.getState()
    previousState = selectLoopSlice(agentStore, loop).state
    bubbleId = nanoid()
    agentStore.addLogEntry({
      id: bubbleId,
      type: 'user',
      content: combined,
      timestamp: Date.now(),
      metadata: imagePreviewUrls.length > 0 ? { imagePreviewUrls } : undefined
    }, loop)
    agentStore.setState('active', loop)
  }

  const fail = (error: string): void => {
    useMessageQueueStore.getState().restore(filePath, loop, queue, error)
    if (!bubbleId || !sameAgentPath(useDocumentStore.getState().filePath, filePath)) return
    const agentStore = useAgentStore.getState()
    const slice = selectLoopSlice(agentStore, loop)
    if (slice.log.some((e) => e.id === bubbleId)) {
      agentStore.setLog(slice.log.filter((e) => e.id !== bubbleId), undefined, loop)
    }
    // Only undo our own optimistic 'active'; a state main reported since stands.
    if (previousState && slice.state === 'active') agentStore.setState(previousState, loop)
  }

  const pending = window.adfApi?.invokeAgent(combined, filePath, content, loop)
  if (!pending) {
    fail('Studio is not connected to the agent runtime')
    return
  }
  void Promise.resolve(pending).then(
    (result) => {
      if (!result || result.success !== false) return
      if (result.accepted) {
        console.warn(`[queue] Queued message to ${filePath} (${loop}) was delivered; its turn's end was not seen: ${result.error ?? 'unknown'}`)
        return
      }
      fail(result.error ?? 'The agent did not take the message')
    },
    (error: unknown) => fail(error instanceof Error ? error.message : String(error))
  )
}

/**
 * Send a message the owner typed straight to an idle loop (the composer shows
 * it already, and the loop as active). A send the backend refused (the agent
 * is not running, the message is too large) ends in that chat as an error
 * row, and the loop's optimistic `active` goes back to idle, the same in
 * both backends. A send the backend accepted is the turn's own business.
 */
export function sendOwnerMessage(filePath: string | null, loop: string, text: string, content: ContentBlock[]): void {
  const pending = window.adfApi?.invokeAgent(text, filePath ?? undefined, content, loop)
  if (!pending) return
  const refused = (error: string): void => {
    console.warn(`[chat] Message to ${filePath ?? 'the open agent'} (${loop}) was not sent: ${error}`)
    if (filePath && !sameAgentPath(useDocumentStore.getState().filePath, filePath)) return
    const agentStore = useAgentStore.getState()
    agentStore.addLogEntry({ id: nanoid(), type: 'error', content: `Not sent: ${error}`, timestamp: Date.now() }, loop)
    if (selectLoopSlice(agentStore, loop).state === 'active') agentStore.setState('idle', loop)
  }
  void Promise.resolve(pending).then(
    (result) => { if (result && result.success === false && !result.accepted) refused(result.error ?? 'The agent did not take the message') },
    (error: unknown) => refused(error instanceof Error ? error.message : String(error))
  )
}

/**
 * Route a message the owner just sent from the composer. It is queued while
 * the loop is mid-turn, and also while older queued messages still wait (a
 * send that failed, a loop held on an approval), so it can never jump ahead of
 * them. On an idle loop the whole queue then goes now, oldest first.
 * False: nothing is queued, the caller sends it directly.
 */
export function queueOwnerMessage(
  filePath: string | null,
  loop: string,
  loopState: string,
  agentState: string,
  message: Omit<QueuedMessage, 'id'>
): boolean {
  if (!filePath) return false
  const waiting = selectQueue(useMessageQueueStore.getState(), filePath, loop).length > 0
  if (loopState !== 'active' && !waiting) return false
  useMessageQueueStore.getState().enqueue(filePath, loop, message)
  if (loopState === 'idle' && agentState !== 'off') deliverQueuedMessages(filePath, loop)
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
    deliverQueuedMessages(filePath, loop, { automatic: true })
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
    deliverSettledQueues(filePath, states, agents.find((a) => sameAgentPath(a.filePath, filePath))?.state)
  }
}
