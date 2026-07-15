import { create } from 'zustand'
import type { FleetBurnResult } from '../../shared/types/ipc.types'

/**
 * Fleet-level runtime telemetry that isn't per-node graph state:
 * token burn (resource bar + per-card readout) and the current selection
 * used by control groups and batch commands.
 */
/**
 * Slow EMA per sample (~5s poll) — long enough memory that a burst reads as
 * deviation from the baseline instead of instantly becoming the baseline.
 */
const BASELINE_ALPHA = 0.02

/**
 * Map lenses (Civ/SimCity style) — same geography, different question:
 * terrain = live state lighting (default), burn = token-heat distribution,
 * model = which LLM runs each hex, health = where the problems are.
 */
export const FLEET_LENSES = ['terrain', 'burn', 'model', 'health'] as const
export type FleetLens = (typeof FLEET_LENSES)[number]

interface FleetStoreState {
  burn: FleetBurnResult | null
  /** Per-agent EMA of tokens/min — "normal" burn used for deviation highlighting */
  burnBaseline: Record<string, number>
  /** filePaths of currently selected agent nodes (marquee / click / control group) */
  selection: string[]
  /** Lineage family (parents + children) of the current selection/focus — violet tile glow */
  family: string[]
  /** Control groups: digit (1-9) → agent filePaths (session-scoped) */
  controlGroups: Record<string, string[]>
  /** Named groups — persisted in app settings under `fleetGroups` */
  namedGroups: Record<string, string[]>
  /** Stewards — directory path → agent DID, persisted in app settings under `fleetStewards` */
  stewards: Record<string, string>
  /** Active map lens — cycled with the L key or the alert-bar pill */
  lens: FleetLens
  /** Message composer visibility — the M hotkey opens it for the selection */
  composerOpen: boolean
  /** Optimistic boot state: filePath → when start was commanded. Tiles show a
   *  boot animation until the poll reports the agent online (or ~30s pass) */
  starting: Record<string, number>

  setBurn: (burn: FleetBurnResult | null) => void
  markStarting: (filePaths: string[]) => void
  clearStarting: (filePaths: string[]) => void
  setLens: (lens: FleetLens) => void
  cycleLens: () => void
  setComposerOpen: (open: boolean) => void
  setSelection: (filePaths: string[]) => void
  setFamily: (filePaths: string[]) => void
  assignControlGroup: (digit: string, filePaths: string[]) => void
  setNamedGroups: (groups: Record<string, string[]>) => void
  setStewards: (stewards: Record<string, string>) => void
  reset: () => void
}

export const useFleetStore = create<FleetStoreState>((set) => ({
  burn: null,
  burnBaseline: {},
  selection: [],
  family: [],
  controlGroups: {},
  namedGroups: {},
  stewards: {},
  lens: 'terrain',
  composerOpen: false,
  starting: {},

  markStarting: (filePaths) =>
    set((s) => {
      const now = Date.now()
      const next = { ...s.starting }
      for (const p of filePaths) next[p] = now
      return { starting: next }
    }),
  clearStarting: (filePaths) =>
    set((s) => {
      if (filePaths.every((p) => !(p in s.starting))) return s
      const next = { ...s.starting }
      for (const p of filePaths) delete next[p]
      return { starting: next }
    }),
  setLens: (lens) => set({ lens }),
  cycleLens: () =>
    set((s) => ({ lens: FLEET_LENSES[(FLEET_LENSES.indexOf(s.lens) + 1) % FLEET_LENSES.length] })),
  setComposerOpen: (open) => set({ composerOpen: open }),
  setBurn: (burn) =>
    set((s) => {
      if (!burn?.perAgent) return { burn }
      const baseline = { ...s.burnBaseline }
      for (const [filePath, entry] of Object.entries(burn.perAgent)) {
        const prev = baseline[filePath] ?? entry.tokensPerMin
        baseline[filePath] = prev + BASELINE_ALPHA * (entry.tokensPerMin - prev)
      }
      return { burn, burnBaseline: baseline }
    }),
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
  setStewards: (stewards) => set({ stewards }),
  // Named groups and stewards survive reset — persisted config, not view state
  reset: () => set({ burn: null, burnBaseline: {}, selection: [], family: [], controlGroups: {}, lens: 'terrain', composerOpen: false, starting: {} })
}))
