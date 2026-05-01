import { create } from 'zustand'
import type { BackgroundAgentStatus, AgentState } from '../../shared/types/ipc.types'

interface BackgroundAgentsStoreState {
  agents: BackgroundAgentStatus[]

  setAgents: (agents: BackgroundAgentStatus[]) => void
  updateAgentState: (filePath: string, state: AgentState) => void
  addAgent: (agent: BackgroundAgentStatus) => void
  removeAgent: (filePath: string) => void
  reset: () => void
}

export const useBackgroundAgentsStore = create<BackgroundAgentsStoreState>((set) => ({
  agents: [],

  setAgents: (agents) => set({ agents }),
  updateAgentState: (filePath, state) =>
    set((s) => ({
      agents: s.agents.map((a) =>
        a.filePath === filePath ? { ...a, state } : a
      )
    })),
  addAgent: (agent) =>
    set((s) => ({
      agents: [...s.agents.filter((a) => a.filePath !== agent.filePath), agent]
    })),
  removeAgent: (filePath) =>
    set((s) => ({
      agents: s.agents.filter((a) => a.filePath !== filePath)
    })),
  reset: () => set({ agents: [] })
}))
