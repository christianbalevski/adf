import { create } from 'zustand'
import { nanoid } from 'nanoid'
import type { ContentBlock } from '../../shared/types/provider.types'

/** A message the owner typed while the loop was mid-turn, held until it ends. */
export interface QueuedMessage {
  id: string
  text: string
  content?: ContentBlock[]
  imagePreviewUrls?: string[]
  /** Why the last send of this message failed; it is queued again (shown as "Not sent"). */
  error?: string
}

/**
 * Messages queued for a busy loop, keyed by agent file and then loop.
 *
 * Lives outside the agent store on purpose: that store is the OPEN agent's
 * view and `reset()` wipes it on every agent switch, which used to drop a
 * queued message the moment the owner looked at another agent. Here a queue
 * outlives the view; it leaves when it is delivered or cancelled, or when its
 * agent file is deleted (so an agent created later at that path starts
 * empty). A rename moves it with the file.
 *
 * Keys are `queuePathKey(filePath)`, so every caller may pass the path as it
 * has it; spellings of one file share one queue.
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
  /** Put taken messages back at the head of their queue, in order, marked with why they were not sent. */
  restore: (filePath: string, loop: string, messages: QueuedMessage[], error: string) => void
  /** Forget every queue of an agent file (deleted). */
  clearAgent: (filePath: string) => void
  /** Move an agent file's queues to its new path (renamed). */
  rekey: (oldPath: string, newPath: string) => void
}

/**
 * One key per agent file however its path is spelled, by the rule the
 * daemon's pathKey uses: case-insensitive on Windows and macOS; on Windows,
 * either slash.
 */
export function queuePathKey(filePath: string): string {
  const platform = typeof window !== 'undefined' ? window.adfApi?.platform : undefined
  const slashed = platform === 'win32' ? filePath.replace(/\\/g, '/') : filePath
  return platform === 'win32' || platform === 'darwin' ? slashed.toLowerCase() : slashed
}

/** The two paths name the same agent file. */
export function sameAgentPath(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && queuePathKey(a) === queuePathKey(b)
}

/** Stable reference for "nothing queued" so selectors don't churn. */
const EMPTY: QueuedMessage[] = []

export function selectQueue(s: Pick<MessageQueueState, 'queues'>, filePath: string | null, loop: string): QueuedMessage[] {
  if (!filePath) return EMPTY
  return s.queues[queuePathKey(filePath)]?.[loop] ?? EMPTY
}

/** Loops of one agent that hold queued messages. */
export function queuedLoops(s: Pick<MessageQueueState, 'queues'>, filePath: string): string[] {
  return Object.keys(s.queues[queuePathKey(filePath)] ?? {})
}

export const useMessageQueueStore = create<MessageQueueState>((set, get) => {
  /** Write one loop's list back, dropping empty lists and agents. */
  const write = (filePath: string, loop: string, list: QueuedMessage[]): void => {
    const key = queuePathKey(filePath)
    const queues = get().queues
    const loops = { ...queues[key] }
    if (list.length > 0) loops[loop] = list
    else delete loops[loop]
    const next = { ...queues }
    if (Object.keys(loops).length > 0) next[key] = loops
    else delete next[key]
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
    },
    restore: (filePath, loop, messages, error) => {
      if (messages.length === 0) return
      write(filePath, loop, [...messages.map((m) => ({ ...m, error })), ...selectQueue(get(), filePath, loop)])
    },
    clearAgent: (filePath) => {
      const key = queuePathKey(filePath)
      if (!(key in get().queues)) return
      const next = { ...get().queues }
      delete next[key]
      set({ queues: next })
    },
    rekey: (oldPath, newPath) => {
      const from = queuePathKey(oldPath)
      const to = queuePathKey(newPath)
      const moving = get().queues[from]
      if (!moving || from === to) return
      const next = { ...get().queues }
      delete next[from]
      // Whatever sat under the new path belonged to a file that is gone.
      next[to] = moving
      set({ queues: next })
    }
  }
})
