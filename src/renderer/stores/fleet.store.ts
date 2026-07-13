import { create } from 'zustand'
import type { FleetBurnResult } from '../../shared/types/ipc.types'

/**
 * Fleet-level runtime telemetry that isn't per-node graph state:
 * token burn (resource bar + per-card readout) and the current selection
 * used by control groups and batch commands.
 */
interface FleetStoreState {
  burn: FleetBurnResult | null
  /** filePaths of currently selected agent nodes (marquee / click / control group) */
  selection: string[]
  /** Lineage family (parents + children) of the current selection/focus — violet tile glow */
  family: string[]
  /** Control groups: digit (1-9) → agent filePaths (session-scoped) */
  controlGroups: Record<string, string[]>
  /** Named groups — persisted in app settings under `fleetGroups` */
  namedGroups: Record<string, string[]>

  setBurn: (burn: FleetBurnResult | null) => void
  setSelection: (filePaths: string[]) => void
  setFamily: (filePaths: string[]) => void
  assignControlGroup: (digit: string, filePaths: string[]) => void
  setNamedGroups: (groups: Record<string, string[]>) => void
  reset: () => void
}

export const useFleetStore = create<FleetStoreState>((set) => ({
  burn: null,
  selection: [],
  family: [],
  controlGroups: {},
  namedGroups: {},

  setBurn: (burn) => set({ burn }),
  setSelection: (filePaths) =>
    set((s) => {
      if (s.selection.length === filePaths.length && s.selection.every((p, i) => p === filePaths[i])) {
        return s
      }
      return { selection: filePaths }
    }),
  setFamily: (filePaths) =>
    set((s) => {
      if (s.family.length === filePaths.length && s.family.every((p, i) => p === filePaths[i])) {
        return s
      }
      return { family: filePaths }
    }),
  assignControlGroup: (digit, filePaths) =>
    set((s) => ({ controlGroups: { ...s.controlGroups, [digit]: filePaths } })),
  setNamedGroups: (groups) => set({ namedGroups: groups }),
  // Named groups survive reset — they're persisted config, not view state
  reset: () => set({ burn: null, selection: [], family: [], controlGroups: {} })
}))
