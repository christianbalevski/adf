import { nanoid } from 'nanoid'
import { useAgentStore, selectLoopSlice, MAIN_LOOP, type AgentState } from '../stores/agent.store'
import { useDocumentStore } from '../stores/document.store'
import { useMessageQueueStore, queuedLoops, selectQueue, sameAgentPath, heldForOwner, MAX_AUTOMATIC_SENDS, type QueuedMessage } from '../stores/message-queue.store'
import type { BackgroundAgentStatus, RendererBackgroundAgentEvent } from '../../shared/types/ipc.types'
import type { ContentBlock } from '../../shared/types/provider.types'
import { attachmentMetadata } from '../../shared/utils/file-ref'
import { parseAgentKey } from '../../shared/types/agent-ref'
import { apiFor, openAgentKey, openApi } from './runtime-api'
import { isAgentWindow } from './window-kind'

/**
 * Every function here takes an agent's key (agentKey): its path on This
 * computer, as before; runtime and path on another runtime
 * (docs/design/multi-runtime.md §5.2). An agent window's keys are paths.
 * The send goes to the agent's runtime.
 */
function invokeOn(key: string, text: string, ...rest: [content?: ContentBlock[], loop?: string]) {
  if (isAgentWindow) return window.adfApi?.invokeAgent(text, key, ...rest)
  const { runtimeId, filePath } = parseAgentKey(key)
  return apiFor(runtimeId)?.invokeAgent(text, filePath, ...rest)
}

/**
 * Send a loop's queued messages as one chat, now that its turn has ended.
 *
 * Works for any agent, open or not: the queue is taken (removed) first, so a
 * second settle signal for the same turn end finds nothing.
 *
 * `automatic`: a turn end sends it, not the owner. A queue whose send failed
 * MAX_AUTOMATIC_SENDS times in a row is then left alone: it stays shown as
 * "Not sent" with the reason until the owner acts: Send now, or a new
 * message, which releases the hold (queueOwnerMessage) so the old messages
 * go first and the new one after them.
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
 * the next idle would send it twice. One exception: the daemon exited before
 * the turn ended (`code: 'daemon_exited'`) and the agent is not the open one.
 * Nothing showed it (a background loop's error reaches no view), so the
 * messages go back marked "Not sent" for the owner to see when they open it.
 */
export function sendQueuedMessages(filePath: string, loop: string, queue: QueuedMessage[]): void {
  const content = queue.flatMap((m) => m.content ?? [{ type: 'text' as const, text: m.text }])
  // The bubble shows what the owner typed; attachments are chips, not text.
  const combined = content.filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('\n\n')
  const imagePreviewUrls = queue.flatMap((m) => m.imagePreviewUrls ?? [])
  let bubbleId: string | null = null
  let previousState: AgentState | null = null
  if (sameAgentPath(openAgentKey(), filePath)) {
    const agentStore = useAgentStore.getState()
    previousState = selectLoopSlice(agentStore, loop).state
    bubbleId = nanoid()
    agentStore.addLogEntry({
      id: bubbleId,
      type: 'user',
      content: combined,
      timestamp: Date.now(),
      metadata: attachmentMetadata(content, imagePreviewUrls)
    }, loop)
    agentStore.setState('active', loop)
  }

  const fail = (error: string): void => {
    useMessageQueueStore.getState().restore(filePath, loop, queue, error)
    if (!bubbleId || !sameAgentPath(openAgentKey(), filePath)) return
    const agentStore = useAgentStore.getState()
    const slice = selectLoopSlice(agentStore, loop)
    if (slice.log.some((e) => e.id === bubbleId)) {
      agentStore.setLog(slice.log.filter((e) => e.id !== bubbleId), undefined, loop)
    }
    // Only undo our own optimistic 'active'; a state main reported since stands.
    if (previousState && slice.state === 'active') agentStore.setState(previousState, loop)
  }

  const pending = invokeOrThrown(() => invokeOn(filePath, combined, content, loop))
  if (!pending) {
    fail(NOT_CONNECTED)
    return
  }
  void Promise.resolve(pending).then(
    (result) => {
      if (!result || result.success !== false) return
      const exitedUnseen = result.code === 'daemon_exited' && !sameAgentPath(openAgentKey(), filePath)
      if (result.accepted && !exitedUnseen) {
        console.warn(`[queue] Queued message to ${filePath} (${loop}) was delivered; its turn's end was not seen: ${result.error ?? 'unknown'}`)
        return
      }
      fail(exitedUnseen ? DAEMON_EXITED : result.error ?? 'The agent did not take the message')
    },
    (error: unknown) => fail(error instanceof Error ? error.message : String(error))
  )
}

/** The "Not sent" reason of a send with no agent runtime to take it. */
const NOT_CONNECTED = 'Studio is not connected to the agent runtime'

/**
 * The invoke call, with a call that throws before it answers turned into a
 * rejected send: the caller's refusal path then keeps the message (a queue
 * already taken would otherwise be lost).
 */
function invokeOrThrown<T>(call: () => T): T | Promise<never> {
  try {
    return call()
  } catch (error) {
    return Promise.reject(error)
  }
}

/** The "Not sent" reason of a message whose daemon exited before its turn ended. */
export const DAEMON_EXITED = 'the ADF daemon exited before its turn ended'

type InvokeAnswer = Awaited<ReturnType<typeof window.adfApi.invokeAgent>> | undefined

/**
 * What went wrong with a send, for the owner to see; null when it went
 * through. `notSent`: the message did not reach the agent (refused, or a
 * daemon that exited before its turn ended); otherwise it was delivered and
 * only its end is unknown.
 */
export function sendProblem(result: InvokeAnswer): { reason: string; notSent: boolean } | null {
  if (!result || result.success !== false) return null
  if (result.code === 'daemon_exited') return { reason: DAEMON_EXITED, notSent: true }
  return { reason: result.error ?? 'The agent did not take the message', notSent: !result.accepted }
}

/**
 * Orders the fleet map sends one agent (a steward's appointment or relief).
 * The call resolves when the turn ends, so it is not awaited; a send that
 * went wrong is said through `notify`, in both backends.
 */
export function sendFleetOrders(filePath: string, who: string, text: string, notify: (notice: string) => void): void {
  const pending = invokeOn(filePath, text)
  if (!pending) {
    notify(`Orders not sent to ${who}: Studio is not connected to the agent runtime`)
    return
  }
  void Promise.resolve(pending).then(
    (result) => {
      const problem = sendProblem(result)
      if (!problem) return
      console.warn(`[fleet] Orders to ${filePath}: ${problem.reason}`)
      notify(problem.notSent ? `Orders not sent to ${who}: ${problem.reason}` : `Orders sent to ${who}, but ${problem.reason}`)
    },
    (error: unknown) => notify(`Orders not sent to ${who}: ${error instanceof Error ? error.message : String(error)}`)
  )
}

/**
 * Send a message the owner typed straight to an idle loop (the composer shows
 * it already, and the loop as active). A send the backend refused (the agent
 * is not running, the message is too large) ends in that chat as an error
 * row, and the loop's optimistic `active` goes back to idle, the same in
 * both backends. When the owner has switched to another agent meanwhile, the
 * message goes into its own agent's queue instead, marked "Not sent" with
 * the reason, so it is never lost. A send the backend accepted is the turn's
 * own business.
 */
export function sendOwnerMessage(filePath: string | null, loop: string, text: string, content: ContentBlock[], imagePreviewUrls: string[] = []): void {
  // No key: the open agent, on its runtime.
  const pending = invokeOrThrown(() => (filePath ? invokeOn(filePath, text, content, loop) : openApi()?.invokeAgent(text, undefined, content, loop)))
  const refused = (error: string, showInChat: boolean): void => {
    console.warn(`[chat] Message to ${filePath ?? 'the open agent'} (${loop}) was not sent: ${error}`)
    if (filePath && !sameAgentPath(openAgentKey(), filePath)) {
      const message: QueuedMessage = { id: nanoid(), text, content, ...(imagePreviewUrls.length > 0 ? { imagePreviewUrls } : {}) }
      useMessageQueueStore.getState().restore(filePath, loop, [message], error)
      return
    }
    if (!showInChat) return
    const agentStore = useAgentStore.getState()
    agentStore.addLogEntry({ id: nanoid(), type: 'error', content: `Not sent: ${error}`, timestamp: Date.now() }, loop)
    if (selectLoopSlice(agentStore, loop).state === 'active') agentStore.setState('idle', loop)
  }
  if (!pending) {
    refused(NOT_CONNECTED, true)
    return
  }
  void Promise.resolve(pending).then(
    (result) => {
      const problem = sendProblem(result)
      // A daemon exit on the open agent shows its own error row in this chat already.
      if (problem?.notSent) refused(problem.reason, result?.code !== 'daemon_exited')
    },
    (error: unknown) => refused(error instanceof Error ? error.message : String(error), true)
  )
}

/**
 * Route a message the owner just sent from the composer. It is queued while
 * the loop is mid-turn, and also while older queued messages still wait (a
 * send that failed, a loop held on an approval), so it can never jump ahead of
 * them. On an idle loop the whole queue then goes now, oldest first.
 *
 * A stopped agent can still have a queue (one kept when it was closed while
 * running, or a send that failed). The new message then joins it and the
 * agent is started with `start`, the composer's own start-before-send (review
 * gate, provider sheet, errors shown in the chat); once it runs the queue
 * goes, oldest first. A start that did not happen leaves the queue where it
 * is, the reason shown by `start` (the composer's marks each message "Not
 * sent" with it), as the composer's direct path queues its message too.
 *
 * False: nothing is queued, the caller sends it directly.
 */
export function queueOwnerMessage(
  filePath: string | null,
  loop: string,
  loopState: string,
  agentState: string,
  message: Omit<QueuedMessage, 'id'>,
  start?: () => Promise<boolean>
): boolean {
  if (!filePath) return false
  const waiting = selectQueue(useMessageQueueStore.getState(), filePath, loop).length > 0
  if (loopState !== 'active' && !waiting) return false
  // The owner is sending again: older messages held after repeated failures
  // get their retries back and go first, at this loop's next turn end.
  useMessageQueueStore.getState().releaseHold(filePath, loop)
  useMessageQueueStore.getState().enqueue(filePath, loop, message)
  if (agentState === 'off') {
    const count = selectQueue(useMessageQueueStore.getState(), filePath, loop).length
    if (!start) {
      console.warn(`[queue] ${filePath} is off: its ${count} queued messages (${loop}) wait until it is started`)
      return true
    }
    console.info(`[queue] ${filePath} is off: starting it to send its ${count} queued messages (${loop})`)
    void start().then(
      // Taken once: a turn end the start reported may have sent it already.
      (started) => { if (started) deliverQueuedMessages(filePath, loop) },
      (error: unknown) => console.warn(`[queue] Starting ${filePath} for its queue failed: ${error instanceof Error ? error.message : String(error)}`)
    )
    return true
  }
  if (loopState === 'idle') deliverQueuedMessages(filePath, loop)
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
