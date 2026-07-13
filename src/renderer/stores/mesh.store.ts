import { create } from 'zustand'
import type { FleetAgentStatus, AgentState } from '../../shared/types/ipc.types'

interface MeshStoreState {
  enabled: boolean
  agents: FleetAgentStatus[]

  setEnabled: (enabled: boolean) => void
  setAgents: (agents: FleetAgentStatus[]) => void
  upsertAgents: (live: Omit<FleetAgentStatus, 'online'>[]) => void
  markAgentOffline: (filePath: string) => void
  updateAgentState: (filePath: string, state: AgentState) => void
  reset: () => void
}

export const useMeshStore = create<MeshStoreState>((set) => ({
  enabled: false,
  agents: [],

  setEnabled: (enabled) => set({ enabled }),
  setAgents: (agents) => set({ agents }),
  // Merge live mesh registrations into the fleet without dropping agents the
  // live snapshot doesn't know about (offline ghosts only exist in the
  // fleet-status poll — a replace here collapses the map to live agents).
  upsertAgents: (live) =>
    set((s) => {
      const byPath = new Map(s.agents.map((a) => [a.filePath, a]))
      for (const a of live) byPath.set(a.filePath, { ...byPath.get(a.filePath), ...a, online: true })
      return { agents: [...byPath.values()] }
    }),
  // A departed agent still exists on disk — turn it into a ghost in place so
  // it keeps its hex instead of vanishing until the next fleet poll.
  markAgentOffline: (filePath) =>
    set((s) => ({
      agents: s.agents.map((a) =>
        a.filePath === filePath
          ? { ...a, online: false, participating: false, state: 'off' as AgentState }
          : a
      )
    })),
  updateAgentState: (filePath, state) =>
    set((s) => ({
      agents: s.agents.map((a) =>
        a.filePath === filePath ? { ...a, state } : a
      )
    })),
  reset: () => set({ enabled: false, agents: [] })
}))
