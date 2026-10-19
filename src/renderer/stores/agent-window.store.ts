import { create } from 'zustand'

/**
 * An agent window's own state (docs/design/agent-windows.md): `opening`
 * until its agent is open (or parked on a password, owner or review
 * dialog), `failed` when the open did not happen. The window then shows the
 * error with Retry and Close window instead of a spinner.
 */
interface AgentWindowState {
  status: 'opening' | 'failed'
  error: string | null
  setOpening: () => void
  setFailed: (error: string) => void
}

export const useAgentWindowStore = create<AgentWindowState>((set) => ({
  status: 'opening',
  error: null,
  setOpening: () => set({ status: 'opening', error: null }),
  setFailed: (error) => set({ status: 'failed', error }),
}))
