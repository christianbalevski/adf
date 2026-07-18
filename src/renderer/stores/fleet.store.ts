import { create } from 'zustand'
import type { FleetBurnResult, RemotePeerAgent } from '../../shared/types/ipc.types'

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
export const FLEET_LENSES = ['terrain', 'burn', 'model', 'health', 'lineage'] as const
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
  /** Voice-chip layer override (V key / alert-bar pill). null = automatic:
   *  chips show on the terrain lens and yield to diagnostic lenses. Resets
   *  to automatic whenever the lens changes. */
  voicesOverride: boolean | null
  /** Message composer visibility — the M hotkey opens it for the selection */
  composerOpen: boolean
  /** Optimistic boot state: filePath → when start was commanded. Tiles show a
   *  boot animation until the poll reports the agent online (or ~30s pass) */
  starting: Record<string, number>
  /** Hovered remote agent on a peer station — drives the screen-space card */
  peerAgentHover: { agent: RemotePeerAgent; peerHost: string; peerSource?: string; x: number; y: number } | null
  /** Clicked remote agent — full-card readout modal (peer-tile click).
   *  peerUrl = the discovered runtime's base URL for shared-file fetches. */
  peerReadout: { agent: RemotePeerAgent; peerHost: string; peerUrl?: string; peerSource?: string } | null
  /** Directory whose full-screen group readout is open (voice-chip click) */
  readoutDir: string | null
  /** Local agent whose full-detail readout is open (hover-card click / I key / Details) */
  agentReadout: string | null
  /** Agent whose pending HIL approval is open in the full-context modal */
  hilModal: string | null
  /** Peer station whose runtime readout modal is open (station node id) */
  stationReadout: string | null
  /** Directory whose voice chip is hovered — lights the name + cluster border */
  hoverDir: string | null
  /** Click-to-place move mode (More ▾ menu): what the map should pick up.
   *  MeshGraphView resolves members from the current selection. */
  moveMode: { kind: 'agents' | 'district' | 'territory' } | null
  /** Hovered hex (world axial) — HOISTED out of the canvas component so
   *  pointer movement re-renders only the tiny overlay that draws it,
   *  never the 1700-line canvas. Written imperatively from mousemove. */
  cursorCell: { q: number; r: number; agent: boolean } | null
  /** Move/drag placement ghost — same hoisting rationale as cursorCell. */
  dragGhost: { cells: { q: number; r: number }[]; valid: boolean } | null
  /** Frozen geography — remembered region origins + user-chosen founding
   *  cells (world axial), persisted in `fleetMapState.placement`. null until
   *  settings hydrate; layout runs unpinned (and records nothing) before then. */
  placement: {
    regionOrigins: Record<string, { q: number; r: number }>
    cellPins: Record<string, { q: number; r: number; solo?: boolean }>
    districtAnchors?: Record<string, { q: number; r: number }>
    stationPins?: Record<string, { q: number; r: number; auto?: boolean }>
  } | null

  setBurn: (burn: FleetBurnResult | null) => void
  setPeerAgentHover: (hover: { agent: RemotePeerAgent; peerHost: string; peerSource?: string; x: number; y: number } | null) => void
  setPeerReadout: (readout: { agent: RemotePeerAgent; peerHost: string; peerUrl?: string; peerSource?: string } | null) => void
  setReadoutDir: (dir: string | null) => void
  setAgentReadout: (filePath: string | null) => void
  setHilModal: (filePath: string | null) => void
  setStationReadout: (stationId: string | null) => void
  setHoverDir: (dir: string | null) => void
  markStarting: (filePaths: string[]) => void
  clearStarting: (filePaths: string[]) => void
  setLens: (lens: FleetLens) => void
  cycleLens: () => void
  setVoicesOverride: (v: boolean | null) => void
  setComposerOpen: (open: boolean) => void
  setSelection: (filePaths: string[]) => void
  setFamily: (filePaths: string[]) => void
  assignControlGroup: (digit: string, filePaths: string[]) => void
  setNamedGroups: (groups: Record<string, string[]>) => void
  setStewards: (stewards: Record<string, string>) => void
  setMoveMode: (mode: FleetStoreState['moveMode']) => void
  setCursorCell: (cell: FleetStoreState['cursorCell']) => void
  setDragGhost: (ghost: FleetStoreState['dragGhost']) => void
  setPlacement: (placement: FleetStoreState['placement']) => void
  /** Pin an agent to the cell the user founded it on (world axial). */
  pinCell: (filePath: string, cell: { q: number; r: number }) => void
  /** Merge pin/origin/anchor/station updates in one shot (drag moves). */
  updatePlacement: (
    pins: Record<string, { q: number; r: number; solo?: boolean }>,
    origins?: Record<string, { q: number; r: number }>,
    anchors?: Record<string, { q: number; r: number }>,
    stations?: Record<string, { q: number; r: number; auto?: boolean }>
  ) => void
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
  voicesOverride: null,
  composerOpen: false,
  starting: {},
  peerAgentHover: null,
  peerReadout: null,
  readoutDir: null,
  agentReadout: null,
  hilModal: null,
  stationReadout: null,
  hoverDir: null,
  moveMode: null,
  cursorCell: null,
  dragGhost: null,
  placement: null,

  setMoveMode: (moveMode) => set({ moveMode }),
  setCursorCell: (cell) =>
    set((s) => {
      const cur = s.cursorCell
      if (cur === cell) return s
      if (cur && cell && cur.q === cell.q && cur.r === cell.r && cur.agent === cell.agent) return s
      return { cursorCell: cell }
    }),
  setDragGhost: (dragGhost) => set({ dragGhost }),
  setPeerAgentHover: (peerAgentHover) => set({ peerAgentHover }),
  setPeerReadout: (peerReadout) => set({ peerReadout }),
  setReadoutDir: (readoutDir) => set({ readoutDir }),
  setAgentReadout: (agentReadout) => set({ agentReadout }),
  setHilModal: (hilModal) => set({ hilModal }),
  setStationReadout: (stationReadout) => set({ stationReadout }),
  setHoverDir: (hoverDir) => set({ hoverDir }),
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
  // Lens changes reset the voice layer to automatic — each lens starts at
  // its own default (terrain speaks, diagnostic lenses read clean)
  setLens: (lens) => set({ lens, voicesOverride: null }),
  cycleLens: () =>
    set((s) => ({
      lens: FLEET_LENSES[(FLEET_LENSES.indexOf(s.lens) + 1) % FLEET_LENSES.length],
      voicesOverride: null
    })),
  setVoicesOverride: (voicesOverride) => set({ voicesOverride }),
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
  setPlacement: (placement) => set({ placement }),
  pinCell: (filePath, cell) =>
    set((s) => ({
      placement: {
        ...(s.placement ?? { regionOrigins: {}, cellPins: {} }),
        cellPins: { ...(s.placement?.cellPins ?? {}), [filePath]: cell }
      }
    })),
  updatePlacement: (pins, origins, anchors, stations) =>
    set((s) => ({
      placement: {
        regionOrigins: { ...(s.placement?.regionOrigins ?? {}), ...(origins ?? {}) },
        cellPins: { ...(s.placement?.cellPins ?? {}), ...pins },
        districtAnchors: { ...(s.placement?.districtAnchors ?? {}), ...(anchors ?? {}) },
        stationPins: { ...(s.placement?.stationPins ?? {}), ...(stations ?? {}) }
      }
    })),
  // Named groups and stewards survive reset — persisted config, not view state
  reset: () => set({ burn: null, burnBaseline: {}, selection: [], family: [], controlGroups: {}, lens: 'terrain', voicesOverride: null, composerOpen: false, starting: {}, moveMode: null, cursorCell: null, dragGhost: null })
}))
