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

/** Agent window: mirror every queue change to main, which hands it to the main window when this window closes. */
export function startQueueMirror(): () => void {
  let last = ''
  const sync = (): void => {
    const entries = queueEntries(useMessageQueueStore.getState().queues, useDocumentStore.getState().filePath)
    const text = JSON.stringify(entries)
    if (text === last) return
    last = text
    void window.adfApi?.syncQueuedMessages?.(entries)?.catch(() => {})
  }
  const offQueue = useMessageQueueStore.subscribe(sync)
  const offDoc = useDocumentStore.subscribe(sync)
  return () => { offQueue(); offDoc() }
}

/**
 * Main window: take the messages closed agent windows left and queue them
 * here, after what this window already queued for that loop. A loop that is
 * idle now gets them at once; a busy one when its turn ends (the open
 * agent's own path, or the background batch); an agent that is off keeps
 * them until it starts.
 */
export function adoptQueueHandover(entries: readonly QueueHandoverEntry[]): void {
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
    console.info(`[queue] ${entry.messages.length} queued message(s) of ${entry.filePath} (${entry.loop}) moved here from its closed window`)
    if (loopIdle(entry.filePath, entry.loop)) deliverQueuedMessages(entry.filePath, entry.loop, { automatic: true })
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
