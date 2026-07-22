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
  // Bail when the state is already current — per-call event churn re-reports
  // the same value, and a fresh array here re-renders every subscriber.
  updateAgentState: (filePath, state) =>
    set((s) => {
      const idx = s.agents.findIndex((a) => a.filePath === filePath)
      if (idx === -1 || s.agents[idx].state === state) return s
      const agents = [...s.agents]
      agents[idx] = { ...agents[idx], state }
      return { agents }
    }),
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
