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
  /** Batch form for the per-frame event flush — one set() per frame. */
  updateAgentStates: (states: Record<string, AgentState>) => void
  reset: () => void
}

export const useMeshStore = create<MeshStoreState>((set) => ({
  enabled: false,
  agents: [],

  setEnabled: (enabled) => set({ enabled }),
  // Identity-stable: the 5s poll delivers a fresh array even when nothing
  // changed, and that churn cascades through the fleet map (full layout
  // recompute, node/edge rediff, every terrain node re-rendering). Keep the
  // old reference when the content is byte-identical so memos stay warm.
  setAgents: (agents) =>
    set((s) => (JSON.stringify(s.agents) === JSON.stringify(agents) ? s : { agents })),
  // Merge live mesh registrations into the fleet without dropping agents the
  // live snapshot doesn't know about (offline ghosts only exist in the
  // fleet-status poll — a replace here collapses the map to live agents).
  // Undefined fields in the live snapshot must not clobber known values
  // (e.g. an icon or status the fleet poll already resolved).
  upsertAgents: (live) =>
    set((s) => {
      const byPath = new Map(s.agents.map((a) => [a.filePath, a]))
      for (const a of live) {
        const defined = Object.fromEntries(
          Object.entries(a).filter(([, v]) => v !== undefined)
        ) as typeof a
        byPath.set(a.filePath, { ...byPath.get(a.filePath), ...defined, online: true })
      }
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
  // Identity-stable like setAgents: bail when the state is already current
  // (per-call event churn re-reports it constantly) and touch only the one
  // changed row, so per-agent selectors elsewhere stay warm.
  updateAgentState: (filePath, state) =>
    set((s) => {
      const idx = s.agents.findIndex((a) => a.filePath === filePath)
      if (idx === -1 || s.agents[idx].state === state) return s
      const agents = [...s.agents]
      agents[idx] = { ...agents[idx], state }
      return { agents }
    }),
  updateAgentStates: (states) =>
    set((s) => {
      let agents: FleetAgentStatus[] | null = null
      for (let i = 0; i < s.agents.length; i++) {
        const next = states[s.agents[i].filePath]
        if (next === undefined || s.agents[i].state === next) continue
        if (!agents) agents = [...s.agents]
        agents[i] = { ...agents[i], state: next }
      }
      return agents ? { agents } : s
    }),
  reset: () => set({ enabled: false, agents: [] })
}))
