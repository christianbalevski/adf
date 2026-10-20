import { useEffect } from 'react'
import { create } from 'zustand'
import { sameAgentPath } from './message-queue.store'
import { agentWindowsAvailable } from '../utils/window-kind'
import { LOCAL_RUNTIME } from '../../shared/runtime-tag'

/** An agent shown in its own window (docs/design/agent-windows.md). */
export interface OpenAgentWindow {
  filePath: string
  agentId: string | null
  /** The agent's runtime; omitted for This computer (docs/design/multi-runtime.md §4.5). */
  runtimeId?: string
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

/**
 * `filePath` (or `agentId`) of `runtimeId` (omitted: This computer) is shown
 * in an agent window. Refs of two runtimes never match (§1.3); a path of
 * another runtime is compared exactly.
 */
export function isInAgentWindow(windows: readonly OpenAgentWindow[], filePath: string, agentId?: string | null, runtimeId?: string | null): boolean {
  const runtime = runtimeId || LOCAL_RUNTIME
  return windows.some((w) => {
    if ((w.runtimeId || LOCAL_RUNTIME) !== runtime) return false
    const samePath = runtime === LOCAL_RUNTIME ? sameAgentPath(w.filePath, filePath) : w.filePath === filePath
    return samePath || (!!agentId && w.agentId === agentId)
  })
}

/** Row marker: this agent has its own window. */
export function useInAgentWindow(filePath: string, agentId?: string | null, runtimeId?: string | null): boolean {
  return useOpenAgentWindowsStore((s) => s.windows.length > 0 && isInAgentWindow(s.windows, filePath, agentId, runtimeId))
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
