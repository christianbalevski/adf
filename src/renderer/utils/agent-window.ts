import { useAgentWindowStore } from '../stores/agent-window.store'
import { useDocumentStore } from '../stores/document.store'
import { useAgentStore, selectLoopSlice, MAIN_LOOP } from '../stores/agent.store'
import { useBackgroundAgentsStore } from '../stores/background-agents.store'
import { useMessageQueueStore, sameAgentPath } from '../stores/message-queue.store'
import { deliverQueuedMessages } from './queued-delivery'
import { agentWindowFile } from './window-kind'
import type { QueueHandoverEntry } from '../../shared/types/ipc.types'
import type { ContentBlock } from '../../shared/types/provider.types'

/**
 * Agent windows in the renderer (docs/design/agent-windows.md): opening the
 * window's agent, and the queued messages that must outlive the window.
 */

type OpenFile = (filePath: string) => Promise<{ success?: boolean; error?: string } | undefined>

/**
 * Open the agent window's agent. The file is the one its session has open
 * (it follows renames, so a reload reopens the renamed file), else the one
 * the window was opened for. A failed open, a rejected call or an open that
 * left no file shows the error state; an open parked on a dialog
 * (password, owner, review) has its file set and is not a failure.
 */
export async function openWindowAgent(openFile: OpenFile): Promise<void> {
  useAgentWindowStore.getState().setOpening()
  // A reloaded page first takes back the queue main kept for it, so the re-attach sends it.
  await restoreWindowQueue()
  let filePath = agentWindowFile
  try {
    const session = await window.adfApi?.getCurrentFile?.()
    if (session?.filePath) filePath = session.filePath
  } catch { /* the query's file */ }
  if (!filePath) { failOpen('This window has no agent file.'); return }
  try {
    const result = await openFile(filePath)
    if (useDocumentStore.getState().filePath) return
    failOpen(result?.error ?? 'The agent did not open.')
  } catch (err) {
    failOpen(err instanceof Error ? err.message : String(err))
  }
}

function failOpen(error: string): void {
  console.error('[AgentWindow] The agent did not open:', error)
  useAgentWindowStore.getState().setFailed(error)
  void window.adfApi?.agentWindowOpenFailed?.().catch(() => {})
}

/** The window's queues as main keeps them: the open agent under its own path; image previews (blob URLs of this page) left out. */
export function queueEntries(queues: Record<string, Record<string, Array<{ id: string; text: string; content?: ContentBlock[]; error?: string; failures?: number }>>>, openFile: string | null): QueueHandoverEntry[] {
  const out: QueueHandoverEntry[] = []
  for (const [key, loops] of Object.entries(queues)) {
    const filePath = openFile && sameAgentPath(openFile, key) ? openFile : key
    for (const [loop, messages] of Object.entries(loops)) {
      if (messages.length === 0) continue
      out.push({ filePath, loop, messages: messages.map((m) => ({ id: m.id, text: m.text, ...(m.content ? { content: m.content } : {}), ...(m.error ? { error: m.error } : {}), ...(m.failures ? { failures: m.failures } : {}) })) })
    }
  }
  return out
}

let windowQueueRestored: Promise<void> | null = null

/**
 * Agent window, once per page: take back the queue main holds for this
 * window (a reload, a renderer crash), before anything is mirrored, so the
 * new page's empty queue never replaces it.
 */
export function restoreWindowQueue(): Promise<void> {
  windowQueueRestored ??= (async () => {
    try {
      const entries = await window.adfApi?.getWindowQueue?.()
      if (entries?.length) adoptQueueHandover(entries, { deliver: false })
    } catch { /* nothing kept */ }
  })()
  return windowQueueRestored
}

/**
 * Agent window: mirror its queues to main, which hands them to the main
 * window when this window closes. Starts after restoreWindowQueue; sends
 * when the queues change (or the open file, which names them), not on
 * every document change.
 */
export function startQueueMirror(): () => void {
  let started = false
  let stopped = false
  const sync = (): void => {
    if (!started || stopped) return
    const entries = queueEntries(useMessageQueueStore.getState().queues, useDocumentStore.getState().filePath)
    void window.adfApi?.syncQueuedMessages?.(entries)?.catch(() => {})
  }
  const offQueue = useMessageQueueStore.subscribe((state, prev) => { if (state.queues !== prev.queues) sync() })
  const offDoc = useDocumentStore.subscribe((state, prev) => {
    if (state.filePath !== prev.filePath && Object.keys(useMessageQueueStore.getState().queues).length > 0) sync()
  })
  void restoreWindowQueue().then(() => { started = true; sync() })
  return () => { stopped = true; offQueue(); offDoc() }
}

/**
 * Main window: take the messages closed agent windows left and queue them
 * here, after what this window already queued for that loop. A loop that is
 * idle now gets them at once; a busy one when its turn ends (the open
 * agent's own path, or the background batch); an agent that is off keeps
 * them until it starts.
 */
export function adoptQueueHandover(entries: readonly QueueHandoverEntry[], opts: { deliver?: boolean } = {}): void {
  const queue = useMessageQueueStore.getState()
  for (const entry of entries) {
    for (const m of entry.messages) {
      queue.enqueue(entry.filePath, entry.loop, {
        text: m.text,
        ...(m.content ? { content: m.content as ContentBlock[] } : {}),
        ...(m.error ? { error: m.error } : {}),
        ...(m.failures ? { failures: m.failures } : {}),
      })
    }
    console.info(`[queue] ${entry.messages.length} queued message(s) of ${entry.filePath} (${entry.loop}) taken over`)
    if (opts.deliver !== false && loopIdle(entry.filePath, entry.loop)) deliverQueuedMessages(entry.filePath, entry.loop, { automatic: true })
  }
}

function loopIdle(filePath: string, loop: string): boolean {
  if (sameAgentPath(useDocumentStore.getState().filePath, filePath)) {
    const agent = useAgentStore.getState()
    return agent.state !== 'off' && selectLoopSlice(agent, loop).state === 'idle'
  }
  if (loop !== MAIN_LOOP) return false
  return useBackgroundAgentsStore.getState().agents.some((a) => sameAgentPath(a.filePath, filePath) && a.state === 'idle')
}

/** Main window: take handovers now (a window that closed while this page loaded) and on each later one. */
export function startQueueHandover(): () => void {
  const take = (): void => {
    void window.adfApi?.takeQueueHandover?.().then((entries) => { if (entries?.length) adoptQueueHandover(entries) }).catch(() => {})
  }
  const off = window.adfApi?.onQueueHandover?.(take)
  take()
  return () => off?.()
}
