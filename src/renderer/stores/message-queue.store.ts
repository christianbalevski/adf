import { create } from 'zustand'
import { nanoid } from 'nanoid'
import type { ContentBlock } from '../../shared/types/provider.types'

/** A message the owner typed while the loop was mid-turn, held until it ends. */
export interface QueuedMessage {
  id: string
  text: string
  content?: ContentBlock[]
  imagePreviewUrls?: string[]
}

/**
 * Messages queued for a busy loop, keyed by agent file and then loop.
 *
 * Lives outside the agent store on purpose: that store is the OPEN agent's
 * view and `reset()` wipes it on every agent switch, which used to drop a
 * queued message the moment the owner looked at another agent. Here a queue
 * outlives the view; it leaves only when it is delivered or cancelled.
 */
interface MessageQueueState {
  /** filePath → loop → messages, oldest first. Empty lists are removed. */
  queues: Record<string, Record<string, QueuedMessage[]>>

  enqueue: (filePath: string, loop: string, message: Omit<QueuedMessage, 'id'>) => void
  /** Remove one message and return it (undefined when it is already gone). */
  remove: (filePath: string, loop: string, id: string) => QueuedMessage | undefined
  /**
   * Remove and return a loop's whole queue in one step. Delivery goes through
   * this, so two settle signals for the same turn end (a foreground and a
   * background state event, a re-attach) can never send the same message twice.
   */
  take: (filePath: string, loop: string) => QueuedMessage[]
}

/** Stable reference for "nothing queued" so selectors don't churn. */
const EMPTY: QueuedMessage[] = []

export function selectQueue(s: Pick<MessageQueueState, 'queues'>, filePath: string | null, loop: string): QueuedMessage[] {
  if (!filePath) return EMPTY
  return s.queues[filePath]?.[loop] ?? EMPTY
}

/** Loops of one agent that hold queued messages. */
export function queuedLoops(s: Pick<MessageQueueState, 'queues'>, filePath: string): string[] {
  return Object.keys(s.queues[filePath] ?? {})
}

export const useMessageQueueStore = create<MessageQueueState>((set, get) => {
  /** Write one loop's list back, dropping empty lists and agents. */
  const write = (filePath: string, loop: string, list: QueuedMessage[]): void => {
    const queues = get().queues
    const loops = { ...queues[filePath] }
    if (list.length > 0) loops[loop] = list
    else delete loops[loop]
    const next = { ...queues }
    if (Object.keys(loops).length > 0) next[filePath] = loops
    else delete next[filePath]
    set({ queues: next })
  }

  return {
    queues: {},

    enqueue: (filePath, loop, message) => {
      write(filePath, loop, [...selectQueue(get(), filePath, loop), { ...message, id: nanoid() }])
    },
    remove: (filePath, loop, id) => {
      const list = selectQueue(get(), filePath, loop)
      const message = list.find((m) => m.id === id)
      if (message) write(filePath, loop, list.filter((m) => m.id !== id))
      return message
    },
    take: (filePath, loop) => {
      const list = selectQueue(get(), filePath, loop)
      if (list.length > 0) write(filePath, loop, [])
      return list
    }
  }
})
