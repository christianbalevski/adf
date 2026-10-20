import { nanoid } from 'nanoid'
import { useAgentStore, selectLoopSlice } from '../stores/agent.store'
import { useDocumentStore } from '../stores/document.store'
import { useMessageQueueStore, sameAgentPath, type QueuedMessage } from '../stores/message-queue.store'
import { startForegroundAgent } from './start-agent'
import { queueOwnerMessage, sendOwnerMessage } from './queued-delivery'
import type { ContentBlock } from '../../shared/types/provider.types'

/** The text of a send that carries only attachments. */
export const ATTACHMENT_ONLY_TEXT = 'Please review the attached media.'

/** The open loop's states when the owner pressed Send (AgentLoop's store selectors). */
export interface ComposerTarget {
  /** The agent the composer is for, captured at submit so navigation can't redirect the message. */
  filePath: string | null
  loop: string
  loopState: string
  agentState: string
}

/**
 * Who holds a message after the composer's send. `queued`: the loop's queue
 * (queued behind a turn or older messages, or a start that did not happen put
 * it there marked "Not sent" with the reason). `direct`: no queue holds it; it
 * went to the agent, and a refusal ends in the chat's "Not sent" row.
 */
export type SendRoute = 'queued' | 'direct'

/**
 * The composer's one send path: queue, start, invoke. Everything the human
 * sends goes through here, including the message a `/<skill>` command
 * composes, which has to be indistinguishable from the same words typed by
 * hand, because that is the whole of its authority.
 *
 * Callers clear the composer first. An unsent message has one home: when
 * this answers `queued`, the queue entry is it and the composer is not
 * refilled; on `direct`, a "Not sent" row means the composer gets it back
 * (sendWithRecovery).
 */
export async function sendComposerMessage(target: ComposerTarget, message: string, content: ContentBlock[], previews: string[]): Promise<SendRoute> {
  const { filePath, loop, loopState, agentState } = target
  // Review gate, provider-at-need, store mirroring: one shared path, for
  // exactly the agent the owner sent to.
  let startError: string | undefined
  const start = async () => {
    const outcome = await startForegroundAgent({ hasUserMessage: true, announce: false, filePath })
    if (!outcome.success) startError = outcome.error
    return outcome.success
  }

  // Mid-turn, or older messages still queued: the queue is keyed by agent
  // and loop, so a message typed into an inner loop's tab is sent to that
  // loop, and it is still there (and still sent) after the owner switches
  // agents. Older queued messages go first: this one never jumps ahead of
  // them. A stopped agent with a queue is started the same way as below,
  // then sent it.
  // A start that does not happen leaves the queue where it is, marked "Not
  // sent" with the reason, the same as the direct path below.
  const startForQueue = async () => {
    const started = await start()
    if (!started && filePath) markQueueNotSent(filePath, loop, startError ?? 'the agent did not start')
    return started
  }
  if (queueOwnerMessage(filePath, loop, loopState, agentState, { text: message || ATTACHMENT_ONLY_TEXT, content, imagePreviewUrls: previews }, startForQueue)) {
    return 'queued'
  }

  const agentStore = useAgentStore.getState()
  const text = message || ATTACHMENT_ONLY_TEXT
  // Show the user message immediately
  const bubbleId = nanoid()
  agentStore.addLogEntry({
    id: bubbleId,
    type: 'user',
    content: text,
    timestamp: Date.now(),
    metadata: previews.length > 0 ? { imagePreviewUrls: previews } : undefined
  }, loop)

  // If the AGENT (not just this loop) is off, start it first then invoke.
  // Side loops run inside the same process as main, so the gate is agent-level.
  // A start that did not happen (review pending, provider sheet cancelled,
  // real error) leaves the message "Not sent" with the reason.
  if (agentState === 'off' && !(await start())) {
    return notSent(filePath, loop, bubbleId, { id: nanoid(), text, content, ...(previews.length > 0 ? { imagePreviewUrls: previews } : {}) }, startError ?? 'the agent did not start')
  }

  // Update activity state if still viewing, then always send the invoke
  if (useDocumentStore.getState().filePath === filePath) {
    useAgentStore.getState().setState('active', loop)
  }

  sendOwnerMessage(filePath, loop, message, content, previews)
  return 'direct'
}

/**
 * A message whose agent did not start. It goes into its loop's queue marked
 * "Not sent" with the reason (the queue's own treatment of a failed send), and
 * the bubble that showed it as sent is taken back; the next send or start
 * sends it first. Without a file to queue it under, the chat's "Not sent" row
 * says so and the composer gets it back.
 */
function notSent(filePath: string | null, loop: string, bubbleId: string, message: QueuedMessage, reason: string): SendRoute {
  console.warn(`[chat] Message to ${filePath ?? 'the open agent'} (${loop}) was not sent: ${reason}`)
  const agentStore = useAgentStore.getState()
  if (!filePath) {
    agentStore.addLogEntry({ id: nanoid(), type: 'error', content: `Not sent: ${reason}`, timestamp: Date.now() }, loop)
    return 'direct'
  }
  useMessageQueueStore.getState().restore(filePath, loop, [message], reason)
  if (!sameAgentPath(useDocumentStore.getState().filePath, filePath)) return 'queued'
  const log = selectLoopSlice(agentStore, loop).log
  if (log.some((e) => e.id === bubbleId)) agentStore.setLog(log.filter((e) => e.id !== bubbleId), undefined, loop)
  return 'queued'
}

/** A queue whose agent did not start: every message in it is marked "Not sent" with the reason, in order. */
function markQueueNotSent(filePath: string, loop: string, reason: string): void {
  console.warn(`[queue] ${filePath} (${loop}) did not start; its queue waits: ${reason}`)
  const queue = useMessageQueueStore.getState()
  queue.restore(filePath, loop, queue.take(filePath, loop), reason)
}
