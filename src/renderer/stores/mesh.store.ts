import { create } from 'zustand'
import type { FleetAgentStatus, AgentState } from '../../shared/types/ipc.types'
import { LOCAL_RUNTIME, type RuntimeId } from '../../shared/runtime-tag'

/** One runtime's mesh: whether it runs and its agents. */
export interface MeshSlice {
  enabled: boolean
  /** Bumped by every local setEnabled/reset: a status read that started before one is stale. */
  enabledRev: number
  agents: FleetAgentStatus[]
}

/**
 * The mesh per runtime (docs/design/multi-runtime.md §5.3). The top-level
 * fields are This computer's slice (an agent window's: its own runtime's),
 * exactly as before; every other runtime of the set has a slice in
 * `byRuntime`. Every action takes an optional runtime id last; omitted, it
 * acts on the top-level slice.
 */
interface MeshStoreState extends MeshSlice {
  /** Runtimes other than This computer. */
  byRuntime: Record<RuntimeId, MeshSlice>

  setEnabled: (enabled: boolean, runtimeId?: RuntimeId) => void
  /** The runtime's answer to a status read started at `rev`; ignored when a local change came since. */
  syncEnabled: (running: boolean, rev: number, runtimeId?: RuntimeId) => void
  setAgents: (agents: FleetAgentStatus[], runtimeId?: RuntimeId) => void
  upsertAgents: (live: Omit<FleetAgentStatus, 'online'>[], runtimeId?: RuntimeId) => void
  markAgentOffline: (filePath: string, runtimeId?: RuntimeId) => void
  updateAgentState: (filePath: string, state: AgentState, runtimeId?: RuntimeId) => void
  /** Batch form for the per-frame event flush — one set() per frame. */
  updateAgentStates: (states: Record<string, AgentState>, runtimeId?: RuntimeId) => void
  reset: (runtimeId?: RuntimeId) => void
  /** A runtime left the set: its slice goes. */
  dropRuntime: (runtimeId: RuntimeId) => void
}

const EMPTY_SLICE: MeshSlice = { enabled: false, enabledRev: 0, agents: [] }

const isTop = (runtimeId?: RuntimeId | null): boolean => !runtimeId || runtimeId === LOCAL_RUNTIME

/** The slice of `runtimeId` (omitted or `local`: the top-level one). */
export function selectMeshSlice(s: Pick<MeshStoreState, 'enabled' | 'enabledRev' | 'agents' | 'byRuntime'>, runtimeId?: RuntimeId | null): MeshSlice {
  if (isTop(runtimeId)) return s
  return s.byRuntime[runtimeId!] ?? EMPTY_SLICE
}

/**
 * Apply `change` to one runtime's slice. `change` returns the slice itself
 * when nothing changed, which leaves the state as it is (identity-stable).
 */
function onSlice(s: MeshStoreState, runtimeId: RuntimeId | undefined, change: (slice: MeshSlice) => MeshSlice | Partial<MeshSlice>): MeshStoreState | Partial<MeshStoreState> {
  const slice = selectMeshSlice(s, runtimeId)
  const patch = change(slice)
  if (patch === slice) return s
  if (isTop(runtimeId)) return patch
  return { byRuntime: { ...s.byRuntime, [runtimeId!]: { enabled: slice.enabled, enabledRev: slice.enabledRev, agents: slice.agents, ...patch } } }
}

export const useMeshStore = create<MeshStoreState>((set) => ({
  enabled: false,
  enabledRev: 0,
  agents: [],
  byRuntime: {},

  setEnabled: (enabled, runtimeId) => set((s) => onSlice(s, runtimeId, (m) => ({ enabled, enabledRev: m.enabledRev + 1 }))),
  syncEnabled: (running, rev, runtimeId) => set((s) => onSlice(s, runtimeId, (m) => (m.enabledRev !== rev || m.enabled === running ? m : { enabled: running }))),
  // Identity-stable: the 5s poll delivers a fresh array even when nothing
  // changed, and that churn cascades through the fleet map (full layout
  // recompute, node/edge rediff, every terrain node re-rendering). Keep the
  // old reference when the content is byte-identical so memos stay warm.
  setAgents: (agents, runtimeId) =>
    set((s) => onSlice(s, runtimeId, (m) => (JSON.stringify(m.agents) === JSON.stringify(agents) ? m : { agents }))),
  // Merge live mesh registrations into the fleet without dropping agents the
  // live snapshot doesn't know about (offline ghosts only exist in the
  // fleet-status poll — a replace here collapses the map to live agents).
  // Undefined fields in the live snapshot must not clobber known values
  // (e.g. an icon or status the fleet poll already resolved).
  upsertAgents: (live, runtimeId) =>
    set((s) => onSlice(s, runtimeId, (m) => {
      const byPath = new Map(m.agents.map((a) => [a.filePath, a]))
      for (const a of live) {
        const defined = Object.fromEntries(
          Object.entries(a).filter(([, v]) => v !== undefined)
        ) as typeof a
        byPath.set(a.filePath, { ...byPath.get(a.filePath), ...defined, online: true })
      }
      return { agents: [...byPath.values()] }
    })),
  // A departed agent still exists on disk — turn it into a ghost in place so
  // it keeps its hex instead of vanishing until the next fleet poll.
  markAgentOffline: (filePath, runtimeId) =>
    set((s) => onSlice(s, runtimeId, (m) => ({
      agents: m.agents.map((a) =>
        a.filePath === filePath
          ? { ...a, online: false, participating: false, state: 'off' as AgentState }
          : a
      )
    }))),
  // Identity-stable like setAgents: bail when the state is already current
  // (per-call event churn re-reports it constantly) and touch only the one
  // changed row, so per-agent selectors elsewhere stay warm.
  updateAgentState: (filePath, state, runtimeId) =>
    set((s) => onSlice(s, runtimeId, (m) => {
      const idx = m.agents.findIndex((a) => a.filePath === filePath)
      if (idx === -1 || m.agents[idx].state === state) return m
      const agents = [...m.agents]
      agents[idx] = { ...agents[idx], state }
      return { agents }
    })),
  updateAgentStates: (states, runtimeId) =>
    set((s) => onSlice(s, runtimeId, (m) => {
      let agents: FleetAgentStatus[] | null = null
      for (let i = 0; i < m.agents.length; i++) {
        const next = states[m.agents[i].filePath]
        if (next === undefined || m.agents[i].state === next) continue
        if (!agents) agents = [...m.agents]
        agents[i] = { ...agents[i], state: next }
      }
      return agents ? { agents } : m
    })),
  reset: (runtimeId) => set((s) => onSlice(s, runtimeId, (m) => ({ enabled: false, enabledRev: m.enabledRev + 1, agents: [] }))),
  dropRuntime: (runtimeId) =>
    set((s) => {
      if (isTop(runtimeId) || !(runtimeId in s.byRuntime)) return s
      const { [runtimeId]: _, ...rest } = s.byRuntime
      return { byRuntime: rest }
    }),
}))
