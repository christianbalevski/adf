import { useEffect } from 'react'
import { create } from 'zustand'
import { sameAgentPath } from './message-queue.store'
import { agentWindowsAvailable } from '../utils/window-kind'

/** An agent shown in its own window (docs/design/agent-windows.md). */
export interface OpenAgentWindow {
  filePath: string
  agentId: string | null
}

interface AgentWindowsBridge {
  listAgentWindows?: () => Promise<{ windows: OpenAgentWindow[] }>
  onAgentWindowsChanged?: (callback: (payload: { windows: OpenAgentWindow[] }) => void) => () => void
}

/** Typed locally: the web tsconfig does not see the preload's Window augmentation. */
function bridge(): AgentWindowsBridge | undefined {
  return (globalThis as { adfApi?: AgentWindowsBridge }).adfApi
}

interface OpenAgentWindowsState {
  /** The agents that have their own window now. Main window only; empty elsewhere. */
  windows: OpenAgentWindow[]
  setWindows: (windows: OpenAgentWindow[]) => void
}

export const useOpenAgentWindowsStore = create<OpenAgentWindowsState>((set) => ({
  windows: [],
  setWindows: (windows) => set({ windows: Array.isArray(windows) ? windows : [] }),
}))

/** `filePath` (or `agentId`) is shown in an agent window. */
export function isInAgentWindow(windows: readonly OpenAgentWindow[], filePath: string, agentId?: string | null): boolean {
  return windows.some((w) => sameAgentPath(w.filePath, filePath) || (!!agentId && w.agentId === agentId))
}

/** Row marker: this agent has its own window. */
export function useInAgentWindow(filePath: string, agentId?: string | null): boolean {
  return useOpenAgentWindowsStore((s) => s.windows.length > 0 && isInAgentWindow(s.windows, filePath, agentId))
}

/**
 * Keep the list current while mounted: read once, then main's pushes, and
 * read again when the window gets focus (a window that retried its open, a
 * rename). Daemon mode main window only.
 */
export function useTrackAgentWindows(): void {
  useEffect(() => {
    const api = bridge()
    if (!agentWindowsAvailable || !api?.listAgentWindows) return
    let live = true
    const read = (): void => {
      api.listAgentWindows?.().then((r) => { if (live) useOpenAgentWindowsStore.getState().setWindows(r?.windows ?? []) })
        .catch((err: unknown) => console.warn('[AgentWindows] Could not list the agent windows:', err))
    }
    read()
    const off = api.onAgentWindowsChanged?.((p) => useOpenAgentWindowsStore.getState().setWindows(p?.windows ?? []))
    window.addEventListener('focus', read)
    return () => {
      live = false
      off?.()
      window.removeEventListener('focus', read)
    }
  }, [])
}
