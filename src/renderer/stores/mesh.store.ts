import { create } from 'zustand'
import type { MeshAgentStatus, AgentState } from '../../shared/types/ipc.types'

interface MeshStoreState {
  enabled: boolean
  agents: MeshAgentStatus[]

  setEnabled: (enabled: boolean) => void
  setAgents: (agents: MeshAgentStatus[]) => void
  updateAgentState: (filePath: string, state: AgentState) => void
  reset: () => void
}

export const useMeshStore = create<MeshStoreState>((set) => ({
  enabled: false,
  agents: [],

  setEnabled: (enabled) => set({ enabled }),
  setAgents: (agents) => set({ agents }),
  updateAgentState: (filePath, state) =>
    set((s) => ({
      agents: s.agents.map((a) =>
        a.filePath === filePath ? { ...a, state } : a
      )
    })),
  reset: () => set({ enabled: false, agents: [] })
}))
