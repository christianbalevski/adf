import { create } from 'zustand'

export interface NodeActivity {
  id: string
  toolName: string
  args?: string
  timestamp: number
  type:
    | 'tool_start'
    | 'tool_result'
    | 'message_sent'
    | 'message_recv'
    | 'ask'
    | 'approval'
    | 'llm'
    | 'state'
    | 'error'
    | 'turn'
  isError?: boolean
  /** Optional secondary text (e.g. full error message behind a truncated args) */
  detail?: string
}

export interface PendingInteraction {
  type: 'ask' | 'approval'
  requestId: string
  question?: string
  toolName?: string
  input?: unknown
}

interface EdgeAnimation {
  id: string
  from: string
  to: string
  channel?: string
  timestamp: number
}

export interface EdgeHeatEntry {
  lastAt: number
  count: number
}

const MAX_ACTIVITIES = 5
const ANIMATION_DURATION_MS = 1500
const CLEANUP_INTERVAL_MS = 3000
/** Rolling window for fleet-rate metrics (msgs/min, tools/min) */
const PULSE_WINDOW_MS = 5 * 60_000
/** Peer-agent ping TTL — the stationHop sweep animates for 1.6s; entries
 *  older than this render nothing and would otherwise accumulate forever
 *  (the map was never pruned). */
const PEER_PING_TTL_MS = 30_000

/**
 * Append an event timestamp to a pulse array. Timestamps arrive in order,
 * so the array stays sorted — instead of re-filtering the whole 5-minute
 * window on every event (O(window) predicate work per push; thousands of
 * entries at 100 agents) we compact only when at least HALF the array has
 * fallen out of the window: amortized O(1) prunes via a binary search for
 * the cut point, and the array stays bounded at ~2× the in-window count.
 * Per-agent consumers filter by their own window on read (FleetLeaderboard
 * ranking), so the few stale entries kept below the half-way mark are
 * invisible to them — identical observed values. The fleet-wide rates read
 * the precomputed activityInWindow/messageInWindow counters instead.
 */
const pushPulse = (pulse: number[], t: number): number[] => {
  const cutoff = t - PULSE_WINDOW_MS
  const n = pulse.length
  if (n === 0 || pulse[0] >= cutoff || pulse[n >> 1] >= cutoff) {
    const next = pulse.slice()
    next.push(t)
    return next
  }
  // ≥ half stale: binary search the first in-window entry, drop the rest
  let lo = 0
  let hi = n
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (pulse[mid] < cutoff) lo = mid + 1
    else hi = mid
  }
  const next = pulse.slice(lo)
  next.push(t)
  return next
}

/**
 * Count of pulse entries inside the rolling window — binary search over the
 * sorted array for the first in-window timestamp, O(log n). Feeds the
 * write-time rate counters below so the alert bar never has to read the
 * clock (or scan the array) inside a selector.
 */
const pulseCountInWindow = (pulse: number[], now: number): number => {
  const cutoff = now - PULSE_WINDOW_MS
  let lo = 0
  let hi = pulse.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (pulse[mid] < cutoff) lo = mid + 1
    else hi = mid
  }
  return pulse.length - lo
}

/**
 * Station annex growth — per-station quantized traffic aggregate, maintained
 * at WRITE time so FleetStationNode subscribes to one number instead of
 * scanning every edgeHeat entry on every store change (O(all-heat) per
 * station per event at 100 agents). A module-level index maps each station
 * node id to the heat keys touching it; the quantized annex count (0–6,
 * 24h-decayed, log-spaced thresholds — same formula the old selector used)
 * is recomputed only for stations a write actually touched, plus a cheap
 * all-stations decay pass on the 3s cleanup sweep.
 */
const STATION_HEAT_WINDOW_MS = 24 * 60 * 60 * 1000
const heatKeysByStation = new Map<string, Set<string>>()

function indexHeatKeyForStations(key: string): void {
  const sep = key.indexOf('|')
  if (sep === -1) return
  for (const end of [key.slice(0, sep), key.slice(sep + 1)]) {
    if (!end.startsWith('station:')) continue
    let set = heatKeysByStation.get(end)
    if (!set) {
      set = new Set()
      heatKeysByStation.set(end, set)
    }
    set.add(key)
  }
}

function rebuildStationHeatIndex(edgeHeat: Record<string, EdgeHeatEntry>): void {
  heatKeysByStation.clear()
  for (const key of Object.keys(edgeHeat)) indexHeatKeyForStations(key)
}

/** Quantized annex count for one station: ~3 msgs → first annex; ~12 →
 *  second; ~40 → third; ~150 → fourth… capped at 6. */
function stationAnnexCount(
  stationId: string,
  edgeHeat: Record<string, EdgeHeatEntry>,
  now: number
): number {
  const keys = heatKeysByStation.get(stationId)
  if (!keys) return 0
  let weighted = 0
  for (const key of keys) {
    const e = edgeHeat[key]
    if (!e) continue
    weighted += e.count * Math.max(0, 1 - (now - e.lastAt) / STATION_HEAT_WINDOW_MS)
  }
  return Math.min(6, Math.floor(Math.log2(1 + weighted) / 1.6))
}

/**
 * Recompute quantized station heat for the given stations (all indexed
 * stations when null). Returns null when no quantized value moved, so
 * callers can bail identity-stable — stations only re-render when an annex
 * threshold is actually crossed.
 */
function updatedStationHeat(
  prev: Record<string, number>,
  edgeHeat: Record<string, EdgeHeatEntry>,
  stations: Iterable<string> | null,
  now: number
): Record<string, number> | null {
  let next: Record<string, number> | null = null
  for (const st of stations ?? heatKeysByStation.keys()) {
    if (!st.startsWith('station:')) continue
    const v = stationAnnexCount(st, edgeHeat, now)
    if ((prev[st] ?? 0) === v) continue
    if (!next) next = { ...prev }
    if (v === 0) delete next[st]
    else next[st] = v
  }
  return next
}

/**
 * Store state uses plain arrays/objects instead of Set/Map to avoid
 * referential instability with Zustand selectors.
 *
 * All nodes are always expanded at a fixed height.
 */
export interface MeshGraphState {
  nodeActivities: Record<string, NodeActivity[]>
  /** Timestamp of each agent's newest feed entry — the cheap slice terrain
   *  cells read for recency lighting, so the glow doesn't ride the wholesale
   *  nodeActivities identity. Feed consumers keep using nodeActivities. */
  lastActivityAt: Record<string, number>
  pendingInteractions: Record<string, PendingInteraction>

  // Edge animation state
  activeAnimations: EdgeAnimation[]
  activeAnimationIndex: Record<string, EdgeAnimation>

  // Message-frequency heat, keyed `${fromFilePath}|${toFilePath}`.
  // Entries are never pruned — styling decays purely by lastAt timestamp.
  edgeHeat: Record<string, EdgeHeatEntry>

  // Per-station quantized annex count (0–6) — maintained at write time from
  // edgeHeat so station nodes subscribe to their own key instead of scanning
  // the whole heat map. Decay is re-evaluated on the cleanup sweep.
  stationHeat: Record<string, number>

  // Live message routes (filePath pairs) — ensures edges exist when animation fires
  liveRoutes: Record<string, { from: string; to: string }>

  // Last-hop targeting into a peer station: a cross-runtime message flies to
  // the station node (React Flow edges are node-to-node), then the station
  // lights the specific recipient sub-tile. Keyed `${runtimeId}|${didOrHandle}`
  // → timestamp; the station node reads freshness to pulse the right tile.
  peerAgentPings: Record<string, number>

  // Persistent last-hop topology — same key as peerAgentPings but heat
  // semantics (count + lastAt), so the "street" from a peer platform's
  // gate to each recipient tile survives the delivery flash and decays
  // like any other trace. Persisted with fleetMapState.
  peerStreetHeat: Record<string, EdgeHeatEntry>

  // Rolling event timestamps (pruned to the last 5 min) — fleet-rate metrics
  activityPulse: number[]
  messagePulse: number[]

  // In-window pulse counts — maintained at WRITE time (stationHeat precedent)
  // so FleetAlertBar subscribes to two primitives instead of clock-reading
  // filters over the arrays on every notification. Exact on every push;
  // decay is re-derived on the 3s cleanup sweep, so between sweeps a count
  // may briefly include entries up to 3s past the window edge — invisible
  // at per-minute display granularity.
  activityInWindow: number
  messageInWindow: number

  // Per-agent rolling activity timestamps — leaderboard ranking. State
  // transitions are excluded (a state flip isn't work).
  agentPulse: Record<string, number[]>

  // View state
  showLogDrawer: boolean
  /** Node highlighted by alert-queue click or idle-worker hotkey cycling */
  focusedFilePath: string | null

  // Actions
  seedActivities: (data: Record<string, NodeActivity[]>) => void
  addActivity: (filePath: string, activity: NodeActivity) => void
  resolveActivity: (filePath: string, toolName: string, isError: boolean) => void
  setPendingInteraction: (filePath: string, interaction: PendingInteraction | null) => void
  /** Poll reconciliation — replaces the whole map with the executors' authoritative snapshot */
  setAllPendingInteractions: (interactions: Record<string, PendingInteraction>) => void
  triggerEdgeAnimation: (from: string, to: string[], channel?: string) => void
  /** Light a specific remote agent tile inside a peer station (last hop). */
  pingPeerAgent: (runtimeId: string, id: string) => void
  cleanupAnimations: () => void
  setShowLogDrawer: (show: boolean) => void
  setFocusedFilePath: (filePath: string | null) => void
  /** Restore persisted topology (heat + routes + streets) — merged, newest/highest wins */
  hydrateGraphState: (
    heat: Record<string, EdgeHeatEntry>,
    routes: Record<string, { from: string; to: string }>,
    streets?: Record<string, EdgeHeatEntry>
  ) => void
  reset: () => void
}

let activityCounter = 0
let lastHeatPrune = 0

/**
 * Pure per-event reducers. The store actions below wrap them one-to-one; the
 * fleet map's rAF flush (useMeshGraph) folds a whole frame's events into a
 * single set() by chaining them over a draft state. They return null when
 * nothing changed so both callers can bail identity-stable.
 */
export function applyActivity(
  s: MeshGraphState,
  filePath: string,
  activity: NodeActivity
): Partial<MeshGraphState> | null {
  const existing = s.nodeActivities[filePath] ?? []
  // Consecutive identical state entries carry no new information — skip
  const last = existing[existing.length - 1]
  if (activity.type === 'state' && last?.type === 'state' && last.args === activity.args) {
    return null
  }
  const activityPulse =
    activity.type === 'tool_start' ? pushPulse(s.activityPulse, activity.timestamp) : s.activityPulse
  return {
    nodeActivities: { ...s.nodeActivities, [filePath]: [...existing, activity].slice(-MAX_ACTIVITIES) },
    lastActivityAt: { ...s.lastActivityAt, [filePath]: activity.timestamp },
    activityPulse,
    ...(activityPulse !== s.activityPulse
      ? { activityInWindow: pulseCountInWindow(activityPulse, activity.timestamp) }
      : {}),
    agentPulse: activity.type === 'state'
      ? s.agentPulse
      : { ...s.agentPulse, [filePath]: pushPulse(s.agentPulse[filePath] ?? [], activity.timestamp) }
  }
}

/** Update the most recent tool_start for this tool with its result status. */
export function applyResolveActivity(
  s: MeshGraphState,
  filePath: string,
  toolName: string,
  isError: boolean
): Partial<MeshGraphState> | null {
  const activities = s.nodeActivities[filePath]
  if (!activities) return null
  // Find the last unresolved tool_start matching this tool name
  const idx = activities.findLastIndex(
    (a) => a.type === 'tool_start' && a.toolName === toolName && a.isError === undefined
  )
  if (idx === -1) return null
  const updated = [...activities]
  updated[idx] = { ...updated[idx], isError }
  return { nodeActivities: { ...s.nodeActivities, [filePath]: updated } }
}

export function applyPendingInteraction(
  s: MeshGraphState,
  filePath: string,
  interaction: PendingInteraction | null
): Partial<MeshGraphState> | null {
  if (interaction) {
    return { pendingInteractions: { ...s.pendingInteractions, [filePath]: interaction } }
  }
  if (!(filePath in s.pendingInteractions)) return null
  const { [filePath]: _, ...rest } = s.pendingInteractions
  return { pendingInteractions: rest }
}

export function applyEdgeAnimation(
  s: MeshGraphState,
  from: string,
  to: string[],
  channel?: string
): Partial<MeshGraphState> {
  const now = Date.now()
  const newAnimations = to.map((t) => ({
    id: `anim-${++activityCounter}`,
    from,
    to: t,
    channel,
    timestamp: now
  }))
  const allAnimations = [...s.activeAnimations, ...newAnimations]
  const index = { ...s.activeAnimationIndex }
  const heat = { ...s.edgeHeat }
  // liveRoutes keeps its reference unless a genuinely NEW pair appears:
  // its identity feeds the edge-array rebuild + React Flow rediff, and
  // messages on existing routes (the common case) must not pay that.
  let routes = s.liveRoutes
  const touchedStations = new Set<string>()
  for (const a of newAnimations) {
    const routeKey = `${a.from}|${a.to}`
    index[routeKey] = a
    if (!routes[routeKey]) {
      if (routes === s.liveRoutes) routes = { ...s.liveRoutes }
      routes[routeKey] = { from: a.from, to: a.to }
    }
    heat[routeKey] = { lastAt: now, count: (heat[routeKey]?.count ?? 0) + 1 }
    indexHeatKeyForStations(routeKey)
    if (a.from.startsWith('station:')) touchedStations.add(a.from)
    if (a.to.startsWith('station:')) touchedStations.add(a.to)
  }
  const stationHeat =
    touchedStations.size > 0 ? updatedStationHeat(s.stationHeat, heat, touchedStations, now) : null
  const messagePulse = pushPulse(s.messagePulse, now)
  return {
    activeAnimations: allAnimations,
    activeAnimationIndex: index,
    liveRoutes: routes,
    edgeHeat: heat,
    messagePulse,
    messageInWindow: pulseCountInWindow(messagePulse, now),
    ...(stationHeat ? { stationHeat } : {})
  }
}

/** Light a specific remote agent tile inside a peer station (last hop). */
export function applyPeerAgentPing(
  s: MeshGraphState,
  runtimeId: string,
  id: string
): Partial<MeshGraphState> {
  const key = `${runtimeId}|${id}`
  const now = Date.now()
  return {
    peerAgentPings: { ...s.peerAgentPings, [key]: now },
    peerStreetHeat: {
      ...s.peerStreetHeat,
      [key]: { lastAt: now, count: (s.peerStreetHeat[key]?.count ?? 0) + 1 }
    }
  }
}

export const useMeshGraphStore = create<MeshGraphState>((set) => ({
  nodeActivities: {},
  lastActivityAt: {},
  pendingInteractions: {},
  activeAnimations: [],
  activeAnimationIndex: {},
  edgeHeat: {},
  stationHeat: {},
  liveRoutes: {},
  peerAgentPings: {},
  peerStreetHeat: {},
  activityPulse: [],
  messagePulse: [],
  activityInWindow: 0,
  messageInWindow: 0,
  agentPulse: {},
  showLogDrawer: false,
  focusedFilePath: null,

  seedActivities: (data) =>
    set((s) => {
      const merged = { ...s.nodeActivities }
      const lastAt = { ...s.lastActivityAt }
      for (const [filePath, activities] of Object.entries(data)) {
        // Only seed if no real-time activities have arrived yet
        if (!merged[filePath] || merged[filePath].length === 0) {
          const kept = activities.slice(-MAX_ACTIVITIES)
          merged[filePath] = kept
          const newest = kept[kept.length - 1]
          if (newest) lastAt[filePath] = newest.timestamp
        }
      }
      return { nodeActivities: merged, lastActivityAt: lastAt }
    }),

  addActivity: (filePath, activity) => set((s) => applyActivity(s, filePath, activity) ?? s),

  resolveActivity: (filePath, toolName, isError) =>
    set((s) => applyResolveActivity(s, filePath, toolName, isError) ?? s),

  setPendingInteraction: (filePath, interaction) =>
    set((s) => applyPendingInteraction(s, filePath, interaction) ?? s),

  setAllPendingInteractions: (interactions) =>
    set((s) => {
      const prev = s.pendingInteractions
      const prevKeys = Object.keys(prev)
      const nextKeys = Object.keys(interactions)
      if (
        prevKeys.length === nextKeys.length &&
        nextKeys.every((k) => prev[k]?.requestId === interactions[k]?.requestId)
      ) {
        return s
      }
      return { pendingInteractions: interactions }
    }),

  triggerEdgeAnimation: (from, to, channel) => set((s) => applyEdgeAnimation(s, from, to, channel)),

  pingPeerAgent: (runtimeId, id) => set((s) => applyPeerAgentPing(s, runtimeId, id)),

  cleanupAnimations: () =>
    set((s) => {
      const now = Date.now()
      // Hourly heat prune, piggybacked on the animation sweep: entries idle
      // past the persistence window would otherwise accumulate toward
      // O(pairs²) forever ("never pruned" was fine at 10 agents, not 100).
      let prunedHeat: typeof s.edgeHeat | null = null
      let prunedStreets: typeof s.peerStreetHeat | null = null
      if (now - lastHeatPrune > 60 * 60 * 1000) {
        lastHeatPrune = now
        const cutoff = now - 7 * 24 * 60 * 60 * 1000
        const heat: typeof s.edgeHeat = {}
        let dropped = false
        for (const [k, e] of Object.entries(s.edgeHeat)) {
          if (e.lastAt >= cutoff) heat[k] = e
          else dropped = true
        }
        if (dropped) {
          prunedHeat = heat
          rebuildStationHeatIndex(heat)
        }
        const streets: typeof s.peerStreetHeat = {}
        let droppedStreets = false
        for (const [k, e] of Object.entries(s.peerStreetHeat)) {
          if (e.lastAt >= cutoff) streets[k] = e
          else droppedStreets = true
        }
        if (droppedStreets) prunedStreets = streets
      }
      // Stale peer-agent pings — the same sweep covers the ping map (its
      // stationHop animations finished long ago; keeping the timestamps
      // around only bloats the map and re-runs station selectors for keys
      // nothing will ever draw again).
      let prunedPings: typeof s.peerAgentPings | null = null
      {
        const cutoff = now - PEER_PING_TTL_MS
        let dropped = false
        for (const t of Object.values(s.peerAgentPings)) {
          if (t < cutoff) {
            dropped = true
            break
          }
        }
        if (dropped) {
          const pings: typeof s.peerAgentPings = {}
          for (const [k, t] of Object.entries(s.peerAgentPings)) {
            if (t >= cutoff) pings[k] = t
          }
          prunedPings = pings
        }
      }
      // Station annex decay — quantized values only move when a threshold is
      // crossed, so this all-stations pass is identity-stable almost always.
      const stationHeat = updatedStationHeat(s.stationHeat, prunedHeat ?? s.edgeHeat, null, now)
      // Rate-counter decay — pushes keep the counts exact upward; this sweep
      // brings them back down as timestamps age past the 5-min window (≤3s
      // late — fine at per-minute display granularity). Only written when a
      // count actually moved, so the pass stays identity-stable.
      const activityInWindow = pulseCountInWindow(s.activityPulse, now)
      const messageInWindow = pulseCountInWindow(s.messagePulse, now)
      const ratesMoved =
        activityInWindow !== s.activityInWindow || messageInWindow !== s.messageInWindow
      const active = s.activeAnimations.filter((a) => now - a.timestamp < ANIMATION_DURATION_MS)
      if (
        active.length === s.activeAnimations.length &&
        !prunedHeat &&
        !prunedStreets &&
        !prunedPings &&
        !stationHeat &&
        !ratesMoved
      ) {
        return s
      }
      const index: Record<string, EdgeAnimation> = {}
      for (const a of active) {
        index[`${a.from}|${a.to}`] = a
      }
      return {
        activeAnimations: active,
        activeAnimationIndex: index,
        ...(prunedHeat ? { edgeHeat: prunedHeat } : {}),
        ...(prunedStreets ? { peerStreetHeat: prunedStreets } : {}),
        ...(prunedPings ? { peerAgentPings: prunedPings } : {}),
        ...(stationHeat ? { stationHeat } : {}),
        ...(ratesMoved ? { activityInWindow, messageInWindow } : {})
      }
    }),

  setShowLogDrawer: (show) => set({ showLogDrawer: show }),

  setFocusedFilePath: (filePath) => set({ focusedFilePath: filePath }),

  hydrateGraphState: (heat, routes, streets) =>
    set((s) => {
      const mergeHeat = (into: Record<string, EdgeHeatEntry>, from: Record<string, EdgeHeatEntry>) => {
        const merged = { ...into }
        for (const [key, entry] of Object.entries(from)) {
          const cur = merged[key]
          merged[key] = cur
            ? { lastAt: Math.max(cur.lastAt, entry.lastAt), count: Math.max(cur.count, entry.count) }
            : entry
        }
        return merged
      }
      const edgeHeat = mergeHeat(s.edgeHeat, heat)
      rebuildStationHeatIndex(edgeHeat)
      const stationHeat = updatedStationHeat(s.stationHeat, edgeHeat, null, Date.now())
      return {
        edgeHeat,
        peerStreetHeat: streets ? mergeHeat(s.peerStreetHeat, streets) : s.peerStreetHeat,
        liveRoutes: { ...routes, ...s.liveRoutes },
        ...(stationHeat ? { stationHeat } : {})
      }
    }),

  reset: () => {
    heatKeysByStation.clear()
    set({
      nodeActivities: {},
      lastActivityAt: {},
      pendingInteractions: {},
      activeAnimations: [],
      activeAnimationIndex: {},
      edgeHeat: {},
      stationHeat: {},
      liveRoutes: {},
      peerAgentPings: {},
      peerStreetHeat: {},
      activityPulse: [],
      messagePulse: [],
      activityInWindow: 0,
      messageInWindow: 0,
      agentPulse: {},
      showLogDrawer: false,
      focusedFilePath: null
    })
  }
}))

export { CLEANUP_INTERVAL_MS, ANIMATION_DURATION_MS }
