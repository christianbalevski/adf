import { create } from 'zustand'
import type { BackgroundAgentStatus } from '../../shared/types/ipc.types'
import { LOCAL_RUNTIME, type RuntimeId } from '../../shared/runtime-tag'

const EMPTY: BackgroundAgentStatus[] = []

// Per-event mutators used to live here; useBackgroundAgents now folds a whole
// IPC batch into a single setState({ agents }) instead.
//
// Per runtime (docs/design/multi-runtime.md §5.3): `agents` is This
// computer's list (an agent window's: its own runtime's), exactly as before;
// every other runtime of the set has its list in `byRuntime`.
interface BackgroundAgentsStoreState {
  agents: BackgroundAgentStatus[]
  /** Runtimes other than This computer. */
  byRuntime: Record<RuntimeId, BackgroundAgentStatus[]>

  /** `runtimeId` omitted or `local`: the top-level list. */
  setAgents: (agents: BackgroundAgentStatus[], runtimeId?: RuntimeId) => void
  reset: () => void
  /** A runtime left the set: its list goes. */
  dropRuntime: (runtimeId: RuntimeId) => void
}

/** The running agents of `runtimeId` (omitted or `local`: the top-level list). */
export function selectBackgroundAgents(s: Pick<BackgroundAgentsStoreState, 'agents' | 'byRuntime'>, runtimeId?: RuntimeId | null): BackgroundAgentStatus[] {
  if (!runtimeId || runtimeId === LOCAL_RUNTIME) return s.agents
  return s.byRuntime[runtimeId] ?? EMPTY
}

export const useBackgroundAgentsStore = create<BackgroundAgentsStoreState>((set) => ({
  agents: [],
  byRuntime: {},

  setAgents: (agents, runtimeId) =>
    set((s) => (!runtimeId || runtimeId === LOCAL_RUNTIME ? { agents } : { byRuntime: { ...s.byRuntime, [runtimeId]: agents } })),
  reset: () => set({ agents: [], byRuntime: {} }),
  dropRuntime: (runtimeId) =>
    set((s) => {
      if (!(runtimeId in s.byRuntime)) return s
      const { [runtimeId]: _, ...rest } = s.byRuntime
      return { byRuntime: rest }
    }),
}))
