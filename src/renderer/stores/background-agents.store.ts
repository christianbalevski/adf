import { create } from 'zustand'
import type { BackgroundAgentStatus } from '../../shared/types/ipc.types'

// Per-event mutators used to live here; useBackgroundAgents now folds a whole
// IPC batch into a single setState({ agents }) instead.
interface BackgroundAgentsStoreState {
  agents: BackgroundAgentStatus[]

  setAgents: (agents: BackgroundAgentStatus[]) => void
  reset: () => void
}

export const useBackgroundAgentsStore = create<BackgroundAgentsStoreState>((set) => ({
  agents: [],

  setAgents: (agents) => set({ agents }),
  reset: () => set({ agents: [] })
}))
