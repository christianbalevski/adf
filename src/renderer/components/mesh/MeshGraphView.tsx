import { useMemo, useCallback, useEffect, useState, useRef } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  MiniMap,
  Controls,
  useReactFlow,
  useStore,
  type Node,
  type Edge,
  type NodeChange,
  type EdgeChange,
  type OnSelectionChangeParams,
  applyNodeChanges,
  applyEdgeChanges
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { MeshGraphNode, type MeshNodeData } from './MeshGraphNode'
import { MeshGraphEdge } from './MeshGraphEdge'
import { MeshLogDrawer } from './MeshLogDrawer'
import { FleetTerrainNode } from './FleetTerrainNode'
import { HexBackground } from './HexBackground'
import { FleetAlertBar } from './FleetAlertBar'
import { FleetLeaderboard } from './FleetLeaderboard'
import { FleetTerrainLabelNode } from './FleetTerrainLabelNode'
import { FleetLensLegend } from './FleetLensLegend'
import { FleetShortcutsOverlay } from './FleetShortcutsOverlay'
import { FleetStationNode, STATION_W, STATION_H, rotCW, type StationNodeData } from './FleetStationNode'
import { FleetCommandBar } from './FleetCommandBar'
import { FleetHoverCard } from './FleetHoverCard'
import { FleetStationCard } from './FleetStationCard'
import { FleetPeerAgentCard } from './FleetPeerAgentCard'
import { FleetLoadingVeil } from './FleetLoadingVeil'
import { FleetGroupReadout } from './FleetGroupReadout'
import { FleetStewardsPanel } from './FleetStewardsPanel'
import { FleetAmbienceLayer, type AmbienceEmitter } from './FleetAmbienceLayer'
import { FleetGardenLayer } from './FleetGardenLayer'
import { computeFleetLayout, NODE_WIDTH, NODE_EST_HEIGHT, HEX_SIZE, HEX_ROW_H, hexCorners, axialToPixel, pixelToAxialRounded, type TerrainNodeData } from './fleet-layout'
import { useMeshGraph } from '../../hooks/useMeshGraph'
import { useMeshGraphStore, type PendingInteraction } from '../../stores/mesh-graph.store'
import { useMeshStore } from '../../stores/mesh.store'
import { useFleetStore } from '../../stores/fleet.store'
import { useMesh } from '../../hooks/useMesh'
import { useAppStore } from '../../stores/app.store'
import { useAdfFile } from '../../hooks/useAdfFile'
import type { FleetAgentStatus, MeshDebugInfo, RemotePeerAgent } from '../../../shared/types/ipc.types'

const nodeTypes = { meshNode: MeshGraphNode, terrainNode: FleetTerrainNode, terrainLabelNode: FleetTerrainLabelNode, stationNode: FleetStationNode }
const edgeTypes = { meshEdge: MeshGraphEdge }

function buildEdges(
  agents: FleetAgentStatus[],
  debugInfo: MeshDebugInfo | null,
  liveRoutes: Record<string, { from: string; to: string }>
): Edge[] {
  const edges: Edge[] = []
  const edgeSet = new Set<string>()

  // Map agent handles to filePaths (node IDs use filePaths)
  const nameToPath = new Map<string, string>()
  const agentPaths = new Set<string>()
  for (const agent of agents) {
    agentPaths.add(agent.filePath)
    const base = agent.filePath.split('/').pop()?.replace('.adf', '') ?? ''
    if (base) nameToPath.set(base, agent.filePath)
    nameToPath.set(agent.handle, agent.filePath)
  }

  // Live routes from message_routed events (instant edges for animations).
  // Station targets (adapter base stations, web gateway) are legal endpoints.
  // Edges are UNDIRECTED — one canonical path per pair, or ingress and
  // egress render two mirrored corridors and every message pulses both.
  const isStation = (id: string) => id.startsWith('station:')
  const canonical = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a])
  for (const route of Object.values(liveRoutes)) {
    if (!agentPaths.has(route.from) && !isStation(route.from)) continue
    if (!agentPaths.has(route.to) && !isStation(route.to)) continue
    const [a, b] = canonical(route.from, route.to)
    const key = `${a}-${b}`
    if (edgeSet.has(key)) continue
    edgeSet.add(key)
    edges.push({
      id: `msg-${key}`,
      source: a,
      target: b,
      type: 'meshEdge',
      data: { edgeType: 'message' }
    })
  }

  // Standing boundary links — agents with open WebSocket pipes get a dashed
  // channel edge to the gateway: "has a live connection to the outside" is a
  // different (and more security-relevant) statement than "sent a request".
  for (const agent of agents) {
    if (!agent.wsConnections) continue
    const key = `ws-${agent.filePath}`
    if (edgeSet.has(key)) continue
    edgeSet.add(key)
    edges.push({
      id: key,
      source: agent.filePath,
      target: 'station:web',
      type: 'meshEdge',
      selectable: false,
      data: { edgeType: 'channel' }
    })
  }

  // Build message edges from log (debug poll — fills in any missed routes)
  if (debugInfo?.messageLog) {
    for (const entry of debugInfo.messageLog) {
      if (!entry.delivered) continue
      const sourcePath = nameToPath.get(entry.from)
      if (!sourcePath) continue
      for (const target of entry.deliveredTo) {
        const targetPath = nameToPath.get(target)
        if (!targetPath) continue
        const [a, b] = canonical(sourcePath, targetPath)
        const key = `${a}-${b}`
        if (edgeSet.has(key)) continue
        edgeSet.add(key)
        edges.push({
          id: `msg-${key}`,
          source: a,
          target: b,
          type: 'meshEdge',
          data: { edgeType: 'message', channel: entry.channel }
        })
      }
    }
  }

  return edges
}

/**
 * Persist the map's accumulated telemetry — trace heat/topology and burn
 * totals — so the world survives shutdowns. State capture is synchronous;
 * only the settings write is async (fire-and-forget, next cycle retries).
 */
function persistFleetMapState(): void {
  try {
    const { edgeHeat, liveRoutes } = useMeshGraphStore.getState()
    const burn = useFleetStore.getState().burn
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
    const heat: typeof edgeHeat = {}
    const routes: typeof liveRoutes = {}
    for (const [key, entry] of Object.entries(edgeHeat)) {
      if (entry.lastAt < cutoff) continue
      heat[key] = entry
      const route = liveRoutes[key]
      if (route) routes[key] = route
    }
    const burnTotals: Record<string, number> = {}
    if (burn?.perAgent) {
      for (const [fp, e] of Object.entries(burn.perAgent)) {
        if (e.totalTokens > 0) burnTotals[fp] = e.totalTokens
      }
    }
    void window.adfApi.setSettings({ fleetMapState: { heat, routes, burnTotals, savedAt: Date.now() } })
  } catch { /* next save cycle */ }
}

export function MeshGraphView() {
  const meshEnabled = useMeshStore((s) => s.enabled)
  const { enableMesh } = useMesh()
  const setShowMeshGraph = useAppStore((s) => s.setShowMeshGraph)
  const resetStore = useMeshGraphStore((s) => s.reset)
  const resetFleetStore = useFleetStore((s) => s.reset)

  const handleClose = useCallback(() => {
    persistFleetMapState()
    resetStore()
    resetFleetStore()
    setShowMeshGraph(false)
  }, [resetStore, resetFleetStore, setShowMeshGraph])

  if (!meshEnabled) {
    return (
      <div className="relative w-full h-full bg-neutral-50 dark:bg-neutral-950">
        {/* Top bar */}
        <div className="absolute top-0 left-0 right-0 z-10 flex items-center justify-between px-4 py-2 bg-white/80 dark:bg-neutral-900/80 backdrop-blur-sm border-b border-neutral-200 dark:border-neutral-800">
          <div className="flex items-center gap-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-neutral-500">
              <path d="M12 2l8.66 5v10L12 22l-8.66-5V7z" />
            </svg>
            <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">Age of Agents</span>
          </div>
          <button
            onClick={handleClose}
            className="p-1 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
            title="Close graph view"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        {/* Enable Mesh CTA */}
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-center space-y-3">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mx-auto text-neutral-400">
              <path d="M12 2l8.66 5v10L12 22l-8.66-5V7z" />
            </svg>
            <p className="text-sm text-neutral-500 dark:text-neutral-400">Mesh is not enabled</p>
            <button
              onClick={() => enableMesh()}
              className="px-4 py-2 text-sm font-medium text-white bg-green-500 hover:bg-green-600 rounded-lg transition-colors"
            >
              Enable Mesh
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <ReactFlowProvider>
      <MeshGraphCanvas onClose={handleClose} />
    </ReactFlowProvider>
  )
}

/**
 * Cursor hex — Civ-style light outline on whatever tile the mouse is over,
 * with a stronger accent when that tile is an agent so you always know which
 * hex you're about to click. Renders as a screen-space overlay following the
 * viewport transform; stroke width divides by zoom to stay constant on screen.
 */
function CursorHexOverlay({ cell }: { cell: { q: number; r: number; agent: boolean } | null }) {
  const [tx, ty, zoom] = useStore((s) => s.transform)
  if (!cell) return null
  const { x, y } = axialToPixel(cell.q, cell.r)
  return (
    <svg className="absolute inset-0 w-full h-full pointer-events-none z-[25]" style={{ overflow: 'hidden' }}>
      <g transform={`translate(${tx} ${ty}) scale(${zoom})`}>
        <polygon
          points={hexCorners(x, y, HEX_SIZE - 2)}
          fill={cell.agent ? 'rgba(139,92,246,0.03)' : 'none'}
          stroke={cell.agent ? 'rgba(139,92,246,0.35)' : 'rgba(148,163,184,0.45)'}
          strokeWidth={(cell.agent ? 1.75 : 1.5) / zoom}
        />
      </g>
    </svg>
  )
}

interface FoundingSite {
  q: number
  r: number
  /** Destination dir — for ocean sites, the nearest territory root (or its
   *  parent when founding a brand-new root) */
  dir: string
  /** True when founded on open water: the name creates a new group folder */
  ocean: boolean
  /** Far ocean: the group becomes a NEW tracked root beside existing ones */
  newRoot?: boolean
}

/**
 * Foundation hex — double-click empty land to found an agent there. The
 * clicked cell answers "which folder" (district cell → that subdir, capital
 * land → the root, open ocean → a new group under the nearest root). Inline
 * naming, city-style; Enter creates, Esc abandons. `a/b` paths nest freely.
 */
function FoundingOverlay({
  site,
  onCancel,
  onFounded
}: {
  site: FoundingSite
  onCancel: () => void
  onFounded: (filePath: string) => void
}) {
  const [tx, ty, zoom] = useStore((s) => s.transform)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)

  // Click-away abandons the site (Esc works too)
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (cardRef.current && !cardRef.current.contains(e.target as HTMLElement)) onCancel()
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [onCancel])

  const { x, y } = axialToPixel(site.q, site.r)
  const sx = tx + x * zoom
  const sy = ty + y * zoom

  const rootName = site.dir.split('/').filter(Boolean).pop() ?? site.dir
  const resolve = (raw: string): { dir: string; agent: string } => {
    if (raw.includes('/')) {
      const idx = raw.lastIndexOf('/')
      return { dir: `${site.dir}/${raw.slice(0, idx)}`, agent: raw.slice(idx + 1) }
    }
    // Ocean founding without a slash: the agent founds a group of its own name
    if (site.ocean) return { dir: `${site.dir}/${raw}`, agent: raw }
    return { dir: site.dir, agent: raw }
  }
  const preview = name.trim() ? resolve(name.trim()) : null

  const submit = async () => {
    const raw = name.trim()
    if (!raw || busy) return
    const { dir, agent } = resolve(raw)
    if (!agent.trim()) return
    setBusy(true)
    setError(null)
    try {
      const res = await window.adfApi.foundFleetAgent(dir, agent, site.newRoot)
      if (res.success && res.filePath) {
        onFounded(res.filePath)
      } else {
        setError(res.error ?? 'Could not create agent')
        setBusy(false)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div className="absolute inset-0 pointer-events-none z-[6] overflow-hidden">
      <svg className="absolute inset-0 w-full h-full">
        <g transform={`translate(${tx} ${ty}) scale(${zoom})`}>
          <polygon
            points={hexCorners(x, y, HEX_SIZE - 2)}
            fill="rgba(139,92,246,0.08)"
            stroke="rgba(139,92,246,0.7)"
            strokeWidth={2.5 / zoom}
            strokeDasharray={`${10 / zoom} ${6 / zoom}`}
            style={{ animation: 'hexPulse 2s ease-in-out infinite' }}
          />
        </g>
      </svg>
      <div
        ref={cardRef}
        className="absolute w-[300px] pointer-events-auto -translate-x-1/2 rounded-xl bg-white/95 dark:bg-neutral-900/95 backdrop-blur-sm border border-violet-300 dark:border-violet-700 shadow-xl px-3 py-2.5 space-y-1.5"
        style={{ left: sx, top: sy + HEX_SIZE * zoom * 0.95, animation: 'meshFadeIn 150ms ease-out' }}
      >
        <div className="text-[11px] font-medium text-neutral-600 dark:text-neutral-300">
          {site.newRoot
            ? 'Create a new root folder'
            : site.ocean ? `Create a new group near ${rootName}` : `Create an agent in ${rootName}`}
        </div>
        <input
          autoFocus
          type="text"
          value={name}
          onChange={(e) => { setName(e.target.value); setError(null) }}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') submit()
            if (e.key === 'Escape') onCancel()
          }}
          placeholder={site.ocean ? 'group-name/agent-name' : 'agent-name'}
          className="w-full px-2 py-1 text-[12px] rounded-md bg-neutral-100 dark:bg-neutral-800 focus:outline-none focus:ring-1 focus:ring-violet-400 text-neutral-700 dark:text-neutral-200 placeholder:text-neutral-400"
        />
        <div className="text-[10px] text-neutral-400 dark:text-neutral-500 truncate">
          {error
            ? <span className="text-red-500">{error}</span>
            : preview
              ? `→ ${preview.dir.split('/').filter(Boolean).pop()}/${preview.agent}.adf${site.newRoot ? ' · new tracked folder' : ''} · Enter to create`
              : site.newRoot
                ? `New folder beside ${rootName} — it becomes its own territory`
                : 'Enter creates the agent and opens its chat'}
        </div>
        {busy && <div className="text-[10px] text-violet-500">Creating…</div>}
      </div>
    </div>
  )
}

/** True when a keyboard event originates from a text-entry element. */
function isTypingTarget(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null
  if (!el) return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable
}

function MeshGraphCanvas({ onClose }: { onClose: () => void }) {
  // Subscribe to mesh graph events
  useMeshGraph()

  // Theme — read at render; the theme toggle re-renders the tree
  const isDark = document.documentElement.classList.contains('dark')

  // First-load veil — up until the first fleet poll lands and layout settles
  const [booting, setBooting] = useState(true)

  const meshAgents = useMeshStore((s) => s.agents)
  const setAgents = useMeshStore((s) => s.setAgents)
  const showLogDrawer = useMeshGraphStore((s) => s.showLogDrawer)
  const setShowLogDrawer = useMeshGraphStore((s) => s.setShowLogDrawer)
  const setAllPendingInteractions = useMeshGraphStore((s) => s.setAllPendingInteractions)
  const setFocusedFilePath = useMeshGraphStore((s) => s.setFocusedFilePath)
  const setBurn = useFleetStore((s) => s.setBurn)
  const setSelection = useFleetStore((s) => s.setSelection)
  const setFamily = useFleetStore((s) => s.setFamily)
  const expandRightPanelToTab = useAppStore((s) => s.expandRightPanelToTab)
  const { openFile } = useAdfFile()
  const reactFlow = useReactFlow()

  const seedActivities = useMeshGraphStore((s) => s.seedActivities)
  const [debugInfo, setDebugInfo] = useState<MeshDebugInfo | null>(null)
  const [adapters, setAdapters] = useState<{ type: string; status: string }[]>([])
  const [lanPeers, setLanPeers] = useState<{ runtime_id: string; host: string; agent_count?: number; first_seen?: number; agents?: RemotePeerAgent[] }[]>([])
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Hover preview — screen-space card, delayed so pans don't flicker it
  const [hovered, setHovered] = useState<{ filePath: string; x: number; y: number; pinned?: boolean } | null>(null)
  const peerAgentHover = useFleetStore((s) => s.peerAgentHover)
  const readoutDir = useFleetStore((s) => s.readoutDir)
  const setReadoutDir = useFleetStore((s) => s.setReadoutDir)
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Cursor hex — which lattice cell the mouse is over (rAF-throttled)
  const [cursorCell, setCursorCell] = useState<{ q: number; r: number; agent: boolean } | null>(null)
  const cursorRaf = useRef(0)

  // Immersive mode — the map takes the whole window (F toggles, Esc exits)
  const [immersive, setImmersive] = useState(false)
  const immersiveRef = useRef(false)
  immersiveRef.current = immersive

  // Keyboard command card — ? toggles, Esc dismisses before anything else
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const shortcutsOpenRef = useRef(false)
  shortcutsOpenRef.current = shortcutsOpen

  // Single debug poll — shared with MeshLogDrawer; refreshes the full fleet
  // (live + on-disk ghosts), pending HIL snapshot, and token burn together.
  const refreshDebug = useCallback(async () => {
    try {
      const [info, fleet, pendingList, burn, adapterStatus, peers] = await Promise.all([
        window.adfApi.getMeshDebug(),
        window.adfApi.getMeshFleetStatus(),
        window.adfApi.getMeshPendingInteractions(),
        window.adfApi.getMeshTokenBurn(),
        window.adfApi.getAdapterStatus().catch(() => ({ adapters: [] })),
        window.adfApi.getDiscoveredRuntimes().catch(() => [])
      ])
      setDebugInfo(info)
      setAdapters((adapterStatus as { adapters: { type: string; status: string }[] }).adapters ?? [])
      setLanPeers((peers as { runtime_id: string; host: string; agent_count?: number; first_seen?: number; agents?: RemotePeerAgent[] }[]) ?? [])
      if (fleet.agents.length > 0) setAgents(fleet.agents)
      setBurn(burn)
      // Boot animations end when the poll confirms the agent is up — or
      // after 30s if the start silently failed (button reappears)
      const { starting, clearStarting } = useFleetStore.getState()
      const startingPaths = Object.keys(starting)
      if (startingPaths.length > 0) {
        const online = new Set(fleet.agents.filter((a) => a.online).map((a) => a.filePath))
        const now = Date.now()
        const done = startingPaths.filter((p) => online.has(p) || now - starting[p] > 30_000)
        if (done.length > 0) clearStarting(done)
      }
      const pendingMap: Record<string, PendingInteraction> = {}
      for (const p of pendingList) {
        if (pendingMap[p.filePath]) continue // one alert per agent — executors pause per request anyway
        pendingMap[p.filePath] = {
          type: p.type,
          requestId: p.requestId,
          question: p.question,
          toolName: p.toolName,
          input: p.input
        }
      }
      setAllPendingInteractions(pendingMap)
    } catch { /* ignore */ }
  }, [setAgents, setAllPendingInteractions, setBurn])

  useEffect(() => {
    // Veil stays up through the first poll + one layout frame, so the world
    // appears whole instead of assembling piecemeal
    refreshDebug().finally(() => setTimeout(() => setBooting(false), 350))
    refreshTimerRef.current = setInterval(refreshDebug, 5000)
    return () => {
      if (refreshTimerRef.current) clearInterval(refreshTimerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Named groups + stewards persist in app settings — load once per mount,
  // along with the map's accumulated telemetry (heat topology). Saves run
  // every 60s and on close, so the world survives shutdowns.
  const setNamedGroups = useFleetStore((s) => s.setNamedGroups)
  const setStewards = useFleetStore((s) => s.setStewards)
  useEffect(() => {
    window.adfApi.getSettings().then((settings) => {
      const s = settings as unknown as {
        fleetGroups?: Record<string, string[]>
        fleetStewards?: Record<string, string>
        fleetMapState?: {
          heat?: Record<string, { lastAt: number; count: number }>
          routes?: Record<string, { from: string; to: string }>
        }
      }
      if (s.fleetGroups) setNamedGroups(s.fleetGroups)
      if (s.fleetStewards) setStewards(s.fleetStewards)
      if (s.fleetMapState?.heat) {
        useMeshGraphStore.getState().hydrateGraphState(s.fleetMapState.heat, s.fleetMapState.routes ?? {})
      }
    }).catch(() => { /* ignore */ })
    const saveTimer = setInterval(persistFleetMapState, 60_000)
    return () => clearInterval(saveTimer)
  }, [setNamedGroups, setStewards])

  // Live routes from message_routed events (ensures edges exist for animations)
  const liveRoutes = useMeshGraphStore((s) => s.liveRoutes)

  // Message edges — merge debug-polled message log with live routes
  const messageEdges = useMemo(() => buildEdges(meshAgents, debugInfo, liveRoutes), [meshAgents, debugInfo, liveRoutes])

  // Fleet layout — tracked-dir terrain regions + subdir districts + lineage
  // trees. Positions are deterministic (regions and siblings sorted by path).
  const layout = useMemo(() => computeFleetLayout(meshAgents), [meshAgents])

  // Base stations — perimeter structures for the fleet's boundary contacts:
  // one per configured channel adapter plus the web gateway (sys_fetch).
  // Lined up along the northern edge, lattice-snapped, outside all territory.
  const stationNodes = useMemo<Node[]>(() => {
    if (layout.nodes.length === 0) return []
    // Peer runtimes take the next golden-angle slot around the ring (offset
    // 15° off the channel slots, sorted by first-seen so newcomers append
    // and existing peers keep their spot) — the sunflower trick: no two
    // peers ever land close, no matter how many machines join.
    const GOLDEN_DEG = 137.508
    const sortedPeers = [...lanPeers].sort((a, b) => (a.first_seen ?? 0) - (b.first_seen ?? 0))
    const kinds: { id: string; kind: string; label: string; status: string; slotDeg?: number; detail?: StationNodeData['detail']; peerAgents?: RemotePeerAgent[] }[] = [
      ...adapters.map((a) => ({ id: `station:${a.type}`, kind: a.type, label: a.type, status: a.status })),
      { id: 'station:web', kind: 'web', label: 'internet', status: 'running' },
      ...sortedPeers.map((p, pi) => ({
        id: `station:peer:${p.runtime_id}`,
        kind: 'peer',
        label: (p.host || p.runtime_id).replace(/\.local\.?$/, '').slice(0, 14),
        status: p.agent_count != null ? `${p.agent_count} agents` : 'directory unreachable',
        slotDeg: (15 + pi * GOLDEN_DEG) % 360,
        detail: { host: p.host, agentCount: p.agent_count, firstSeen: p.first_seen },
        peerAgents: p.agents
      }))
    ]
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const n of layout.nodes) {
      if (n.type !== 'terrainNode') continue
      const data = n.data as unknown as TerrainNodeData
      minX = Math.min(minX, n.position.x)
      maxX = Math.max(maxX, n.position.x + data.width)
      minY = Math.min(minY, n.position.y)
      maxY = Math.max(maxY, n.position.y + data.height)
    }
    if (!Number.isFinite(minX)) return []
    // Each channel owns a FIXED compass slot — station positions must never
    // depend on which other stations exist, or an agent starting a new
    // adapter re-deals the whole ring.
    const SLOT_DEG: Record<string, number> = {
      telegram: -90, // N
      email: 0, //     E
      discord: 90, //  S
      web: 180, //     W
      imessage: -45,
      slack: 135
    }
    // Quantized ellipse: center and radii snap to coarse steps so ordinary
    // fleet growth doesn't nudge the ring — stations move only when the
    // world genuinely outgrows it (and slide there via the reflow animation).
    const QUANT = HEX_ROW_H * 2
    const centerX = Math.round((minX + maxX) / 2 / QUANT) * QUANT
    const centerY = Math.round((minY + maxY) / 2 / QUANT) * QUANT
    // Facing target: the agent-mass centroid (average tile center) — a big
    // cluster in one corner drags the visual middle away from the bbox center
    let massX = 0
    let massY = 0
    let massN = 0
    for (const n of layout.nodes) {
      if (n.type !== 'meshNode') continue
      massX += n.position.x + NODE_WIDTH / 2
      massY += n.position.y + NODE_EST_HEIGHT / 2
      massN++
    }
    if (massN > 0) {
      massX /= massN
      massY /= massN
    } else {
      massX = centerX
      massY = centerY
    }
    const rx = Math.ceil(((maxX - minX) / 2 + HEX_ROW_H * 3.4) / QUANT) * QUANT
    const ry = Math.ceil(((maxY - minY) / 2 + HEX_ROW_H * 3.4) / QUANT) * QUANT
    return kinds.map((k, i) => {
      const slotDeg = k.slotDeg ?? SLOT_DEG[k.kind] ?? (i * 67) % 360
      const angle = (slotDeg * Math.PI) / 180
      const rawX = centerX + rx * Math.cos(angle)
      const rawY = centerY + ry * Math.sin(angle)
      const { q, r } = pixelToAxialRounded(rawX, rawY)
      const { x: px, y: py } = axialToPixel(q, r)
      // Face the fleet: brute-force the six lattice rotations and keep the
      // one whose support-pad midpoint points most directly at the fleet
      // mass — no angle arithmetic, no sign bugs.
      const tx = massX - px
      const ty = massY - py
      const tlen = Math.hypot(tx, ty) || 1
      let facing = 0
      let bestDot = -Infinity
      for (let step = 0; step < 6; step++) {
        const a = rotCW(-1, 1, step)
        const b = rotCW(1, 0, step)
        const mx = ((a.q + b.q) / 2) * (HEX_SIZE * 1.5)
        const my = ((a.r + a.q / 2 + b.r + b.q / 2) / 2) * HEX_ROW_H
        const mlen = Math.hypot(mx, my) || 1
        const dot = (mx / mlen) * (tx / tlen) + (my / mlen) * (ty / tlen)
        if (dot > bestDot) {
          bestDot = dot
          facing = step
        }
      }
      return {
        id: k.id,
        type: 'stationNode',
        // Node center = icon pad = a lattice point, so traces land on the pad
        position: { x: px - STATION_W / 2, y: py - STATION_H / 2 },
        draggable: false,
        selectable: false,
        focusable: false,
        initialWidth: STATION_W,
        initialHeight: STATION_H,
        data: { kind: k.kind, label: k.label, status: k.status, facing, detail: k.detail, peerAgents: k.peerAgents } satisfies StationNodeData
      }
    })
  }, [layout, adapters, lanPeers])

  // Geography is fixed — agents live on their hex; nothing is draggable
  const nodes = useMemo(() => [...layout.nodes, ...stationNodes], [layout, stationNodes])

  // Firefly emitters — one per agent tile, world-space centers. State drives
  // emission density in the ambience layer (pending-HIL read imperatively
  // there, so this memo doesn't churn on every interaction event).
  const ambienceEmitters = useMemo<AmbienceEmitter[]>(() => {
    const out: AmbienceEmitter[] = []
    for (const n of layout.nodes) {
      if (n.type !== 'meshNode') continue
      const d = n.data as unknown as MeshNodeData
      out.push({
        x: n.position.x + NODE_WIDTH / 2,
        y: n.position.y + NODE_EST_HEIGHT / 2,
        state: d.state ?? 'off',
        online: d.online !== false,
        filePath: n.id
      })
    }
    return out
  }, [layout])

  // Absolute axial cell → agent, for the cursor-hex agent accent
  const occupiedCells = useMemo(() => {
    const map = new Set<string>()
    for (const n of layout.nodes) {
      if (n.type !== 'meshNode') continue
      const { q, r } = pixelToAxialRounded(n.position.x + NODE_WIDTH / 2, n.position.y + NODE_EST_HEIGHT / 2)
      map.add(`${q},${r}`)
    }
    return map
  }, [layout])

  // Every territory cell → its folder (district cells → the subdir), plus
  // per-root cell positions so ocean founds route by distance to the nearest
  // SHORE — measuring to territory centers mis-attributes clicks beside a big
  // territory to a small one whose center happens to be closer.
  const cellDirs = useMemo(() => {
    const dirs = new Map<string, string>()
    const roots: { rootDir: string; pts: { x: number; y: number }[] }[] = []
    for (const n of layout.nodes) {
      if (n.type !== 'terrainNode') continue
      const data = n.data as unknown as TerrainNodeData
      if (!data.dirPath) continue
      const pts: { x: number; y: number }[] = []
      for (const cell of data.cells) {
        const ax = n.position.x + cell.x
        const ay = n.position.y + cell.y
        pts.push({ x: ax, y: ay })
        const { q, r } = pixelToAxialRounded(ax, ay)
        dirs.set(`${q},${r}`, cell.district ? `${data.dirPath}/${cell.district}` : data.dirPath)
      }
      roots.push({ rootDir: data.dirPath, pts })
    }
    return { dirs, roots }
  }, [layout])

  // Founding — double-click empty land (or ocean) to create an agent there
  const [founding, setFounding] = useState<FoundingSite | null>(null)
  const onCanvasDoubleClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    if (target.closest('.react-flow__node')) return // agent tiles open on dbl-click
    if (!target.closest('.react-flow__pane')) return
    const pos = reactFlow.screenToFlowPosition({ x: e.clientX, y: e.clientY })
    const { q, r } = pixelToAxialRounded(pos.x, pos.y)
    const key = `${q},${r}`
    if (occupiedCells.has(key)) return
    const dir = cellDirs.dirs.get(key)
    if (dir) {
      setFounding({ q, r, dir, ocean: false })
      return
    }
    // Ocean: nearest shore decides the root. Close by → new group in that
    // root; far from every coastline → a brand-new root folder, created as a
    // sibling of the nearest tracked root and auto-tracked.
    let best: string | null = null
    let bestDist = Infinity
    for (const root of cellDirs.roots) {
      for (const p of root.pts) {
        const d = Math.hypot(p.x - pos.x, p.y - pos.y)
        if (d < bestDist) { bestDist = d; best = root.rootDir }
      }
    }
    if (!best) return
    const NEW_ROOT_DIST = HEX_ROW_H * 3.5
    if (bestDist > NEW_ROOT_DIST) {
      const parent = best.slice(0, best.lastIndexOf('/'))
      if (parent) setFounding({ q, r, dir: parent, ocean: true, newRoot: true })
    } else {
      setFounding({ q, r, dir: best, ocean: true })
    }
  }, [reactFlow, occupiedCells, cellDirs])

  const onFounded = useCallback(async (filePath: string) => {
    setFounding(null)
    refreshDebug()
    // Straight into the briefing: open the newborn's doc + loop panel
    await openFile(filePath)
    expandRightPanelToTab('loop')
  }, [refreshDebug, openFile, expandRightPanelToTab])

  const onCanvasMouseMove = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    const overCanvas = !!target.closest('.react-flow__pane') || !!target.closest('.react-flow__node')
    const { clientX, clientY } = e
    cancelAnimationFrame(cursorRaf.current)
    cursorRaf.current = requestAnimationFrame(() => {
      if (!overCanvas) {
        setCursorCell((c) => (c === null ? c : null))
        return
      }
      const pos = reactFlow.screenToFlowPosition({ x: clientX, y: clientY })
      const { q, r } = pixelToAxialRounded(pos.x, pos.y)
      const agent = occupiedCells.has(`${q},${r}`)
      setCursorCell((c) => (c && c.q === q && c.r === r && c.agent === agent ? c : { q, r, agent }))
    })
  }, [reactFlow, occupiedCells])

  // Lineage renders as a family glow on tiles (see effect below), not as
  // permanent lines — only live message traffic draws edges.
  const rawEdges = messageEdges

  // Use a stable state for nodes that allows drag updates
  const [controlledNodes, setControlledNodes] = useState<Node[]>(nodes)
  const [controlledEdges, setControlledEdges] = useState<Edge[]>(rawEdges)

  // Track prev layout key to know when layout should override dragged positions
  const prevLayoutKeyRef = useRef('')
  const layoutKey = meshAgents.map((a) => a.filePath).sort().join('|')

  useEffect(() => {
    prevLayoutKeyRef.current = layoutKey
    // Preserve selection flags across data refreshes
    setControlledNodes((prev) => {
      const selected = new Set(prev.filter((n) => n.selected).map((n) => n.id))
      return nodes.map((n) => (selected.has(n.id) ? { ...n, selected: true } : n))
    })
    setControlledEdges(rawEdges)
  }, [nodes, rawEdges, layoutKey])

  // Seed historical tool calls from agent loop tables.
  // Re-runs when agents join/leave so late-starting agents get populated.
  useEffect(() => {
    let cancelled = false
    window.adfApi.getMeshRecentTools?.().then((data) => {
      if (cancelled || !data) return
      const seed: Record<string, import('../../stores/mesh-graph.store').NodeActivity[]> = {}
      let counter = 0
      for (const [filePath, tools] of Object.entries(data)) {
        seed[filePath] = tools.map((t) => ({
          id: `seed-${++counter}`,
          toolName: t.name,
          args: t.args,
          timestamp: t.timestamp,
          type: 'tool_start' as const,
          isError: t.isError
        }))
      }
      seedActivities(seed)
    }).catch(() => { /* ignore */ })
    return () => { cancelled = true }
  }, [seedActivities, layoutKey])

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    // Filter out dimension changes — dynamic node sizing + controlled mode causes
    // infinite re-measurement loops. Layout handles positioning; we don't need React Flow dimensions.
    const filtered = changes.filter((c) => c.type !== 'dimensions')
    if (filtered.length === 0) return
    setControlledNodes((nds) => applyNodeChanges(filtered, nds))
  }, [])

  // Hover preview handlers — 220ms arm delay so sweeping the cursor across
  // the map doesn't strobe cards
  const onNodeMouseEnter = useCallback((event: React.MouseEvent, node: Node) => {
    if (node.type !== 'meshNode' && node.type !== 'stationNode') return
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
    const x = event.clientX
    const y = event.clientY
    hoverTimerRef.current = setTimeout(() => {
      setHovered((prev) => (prev?.pinned ? prev : { filePath: node.id, x, y }))
    }, 220)
  }, [])

  const onNodeMouseLeave = useCallback(() => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = null
    }
    setHovered((prev) => (prev?.pinned ? prev : null))
  }, [])

  // Clicking a station pins its card (stations aren't selectable, so a
  // click is otherwise dead); click anywhere on the pane to dismiss.
  const onNodeClick = useCallback((event: React.MouseEvent, node: Node) => {
    if (node.type !== 'stationNode') return
    setHovered({ filePath: node.id, x: event.clientX, y: event.clientY, pinned: true })
  }, [])


  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setControlledEdges((eds) => applyEdgeChanges(changes, eds))
  }, [])

  // RTS semantics: single click only selects (React Flow handles it) so the
  // viewport never jumps; double-click opens the agent's file + loop panel.
  const onNodeDoubleClick = useCallback((_event: React.MouseEvent, node: Node) => {
    const nodeData = node.data as unknown as MeshNodeData
    if (node.type === 'meshNode' && nodeData?.filePath) {
      openFile(nodeData.filePath)
      expandRightPanelToTab('loop')
    }
  }, [openFile, expandRightPanelToTab])

  // Selection → fleet store (drives command bar + control-group assign)
  const onSelectionChange = useCallback(({ nodes: selectedNodes }: OnSelectionChangeParams) => {
    const filePaths = selectedNodes
      .filter((n) => n.type === 'meshNode')
      .map((n) => n.id)
      .sort()
    setSelection(filePaths)
  }, [setSelection])

  // Shift-click toggles an agent in/out of the selection (RTS add-to-group).
  // Handled at capture phase with stopPropagation so React Flow's own click
  // selection never runs for these clicks — one writer, no races.
  const onMouseDownCapture = useCallback((e: React.MouseEvent) => {
    if (!e.shiftKey || e.button !== 0) return
    const nodeEl = (e.target as HTMLElement).closest('.react-flow__node') as HTMLElement | null
    const id = nodeEl?.getAttribute('data-id')
    if (!id || id.startsWith('terrain:')) return
    e.preventDefault()
    e.stopPropagation()
    const base = new Set(useFleetStore.getState().selection)
    if (base.has(id)) base.delete(id)
    else base.add(id)
    setControlledNodes((nds) => nds.map((n) => (n.type === 'meshNode' ? { ...n, selected: base.has(n.id) } : n)))
    setSelection([...base].sort())
  }, [setSelection])

  // The browser fires `click` independently of the intercepted mousedown —
  // swallow shift-clicks on nodes here too or React Flow re-selects.
  const onClickCapture = useCallback((e: React.MouseEvent) => {
    const nodeEl = (e.target as HTMLElement).closest('.react-flow__node') as HTMLElement | null
    const id = nodeEl?.getAttribute('data-id')
    // Dismiss a pinned station card on any click that isn't on a station —
    // selection-on-drag swallows onPaneClick, so this is the reliable path.
    // A station click re-pins right after via onNodeClick (bubble phase).
    if (!id?.startsWith('station:')) {
      setHovered((prev) => (prev?.pinned ? null : prev))
    }
    if (!e.shiftKey) return
    if (!id || id.startsWith('terrain:')) return
    e.preventDefault()
    e.stopPropagation()
  }, [])

  // Family glow: selected/focused agents highlight their lineage relatives
  const selection = useFleetStore((s) => s.selection)
  const focusedFilePath = useMeshGraphStore((s) => s.focusedFilePath)
  useEffect(() => {
    const anchors = focusedFilePath ? [...selection, focusedFilePath] : selection
    if (anchors.length === 0) {
      setFamily([])
      return
    }
    const related = new Set<string>()
    for (const filePath of anchors) {
      const parent = layout.lineage.parents.get(filePath)
      if (parent) related.add(parent)
      for (const child of layout.lineage.children.get(filePath) ?? []) related.add(child)
    }
    for (const filePath of anchors) related.delete(filePath)
    setFamily([...related].sort())
  }, [selection, focusedFilePath, layout, setFamily])

  /** Select a set of agents programmatically (control-group recall). */
  const selectAgents = useCallback((filePaths: string[]) => {
    const wanted = new Set(filePaths)
    setControlledNodes((nds) => nds.map((n) => ({ ...n, selected: wanted.has(n.id) })))
    setSelection([...filePaths].sort())
    if (filePaths.length > 0) {
      reactFlow.fitView({ nodes: filePaths.map((id) => ({ id })), duration: 300, padding: 0.35 })
    }
  }, [reactFlow, setSelection])

  // Center the viewport on an agent and highlight it
  const focusAgent = useCallback((filePath: string) => {
    const node = reactFlow.getNode(filePath)
    if (!node) return
    setFocusedFilePath(filePath)
    reactFlow.setCenter(node.position.x + NODE_WIDTH / 2, node.position.y + 140, {
      zoom: 1,
      duration: 400
    })
  }, [reactFlow, setFocusedFilePath])

  // Hotkeys — `.` = next agent awaiting input, `,` = next idle agent (the
  // RTS idle-worker key), Enter = open focused, Escape = clear focus and
  // selection, Ctrl/Cmd+1-9 = assign control group, 1-9 = recall group.
  const cycleIndexRef = useRef<Record<string, number>>({})
  useEffect(() => {
    const cycle = (key: string, filePaths: string[]) => {
      if (filePaths.length === 0) return
      const next = ((cycleIndexRef.current[key] ?? -1) + 1) % filePaths.length
      cycleIndexRef.current[key] = next
      focusAgent(filePaths[next])
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e) || e.altKey) return
      const fleet = useFleetStore.getState()

      if (e.key >= '1' && e.key <= '9') {
        if (e.metaKey || e.ctrlKey) {
          if (fleet.selection.length > 0) {
            e.preventDefault()
            fleet.assignControlGroup(e.key, fleet.selection)
          }
        } else {
          const group = fleet.controlGroups[e.key]
          if (group && group.length > 0) {
            e.preventDefault()
            selectAgents(group)
          }
        }
        return
      }
      if (e.metaKey || e.ctrlKey) return

      const graphState = useMeshGraphStore.getState()
      if (e.key === '?') {
        e.preventDefault()
        setShortcutsOpen((v) => !v)
      } else if (e.key === 'l' || e.key === 'L') {
        e.preventDefault()
        fleet.cycleLens()
      } else if (e.key === 'f' || e.key === 'F') {
        e.preventDefault()
        setImmersive((v) => !v)
      } else if (e.key.startsWith('Arrow')) {
        // RTS camera: arrows pan the map (selection moves via . and ,)
        e.preventDefault()
        const { x, y, zoom } = reactFlow.getViewport()
        const step = 180
        const dx = e.key === 'ArrowLeft' ? step : e.key === 'ArrowRight' ? -step : 0
        const dy = e.key === 'ArrowUp' ? step : e.key === 'ArrowDown' ? -step : 0
        reactFlow.setViewport({ x: x + dx, y: y + dy, zoom }, { duration: 120 })
      } else if (e.key === 'm' || e.key === 'M') {
        // Message the selection: click a tile, M, type, Enter
        if (fleet.selection.length > 0) {
          e.preventDefault()
          fleet.setComposerOpen(true)
        }
      } else if (e.key === 'h' || e.key === 'H') {
        // Hold position — toggles hold/resume on the selection. Reads live
        // fleet status, not the store: the 5s poll lags and a quick H-H
        // toggle would re-hold instead of resuming.
        const sel = new Set(fleet.selection)
        if (sel.size > 0) {
          e.preventDefault()
          window.adfApi.getMeshFleetStatus().then((status) => {
            const mine = status.agents.filter((a) => sel.has(a.filePath))
            const held = mine.filter((a) => a.held)
            if (held.length > 0) {
              return window.adfApi.holdFleetAgents(held.map((a) => a.filePath), false)
            }
            const online = mine.filter((a) => a.online)
            if (online.length > 0) {
              return window.adfApi.holdFleetAgents(online.map((a) => a.filePath), true)
            }
            return undefined
          }).catch(() => { /* poll reflects it */ })
        }
      } else if (e.key === 'a' || e.key === 'A') {
        // Select the whole standing army
        e.preventDefault()
        selectAgents(useMeshStore.getState().agents.filter((a) => a.online).map((a) => a.filePath))
      } else if (e.key === ' ') {
        // Jump the camera to the selection (or fit the world)
        e.preventDefault()
        if (fleet.selection.length > 0) {
          reactFlow.fitView({ nodes: fleet.selection.map((id) => ({ id })), duration: 300, padding: 0.35 })
        } else {
          reactFlow.fitView({ duration: 300, padding: 0.3 })
        }
      } else if (e.key === 'g' || e.key === 'G') {
        // Go — start the selected offline agents
        const sel = new Set(fleet.selection)
        const offline = useMeshStore.getState().agents.filter((a) => sel.has(a.filePath) && !a.online)
        if (offline.length > 0) {
          e.preventDefault()
          useFleetStore.getState().markStarting(offline.map((a) => a.filePath))
          for (const a of offline) window.adfApi.startBackgroundAgent(a.filePath).catch(() => { /* poll reflects it */ })
        }
      } else if (e.key === 's' || e.key === 'S') {
        // Stop the selected running agents
        const sel = new Set(fleet.selection)
        const online = useMeshStore.getState().agents.filter((a) => sel.has(a.filePath) && a.online)
        if (online.length > 0) {
          e.preventDefault()
          for (const a of online) window.adfApi.stopBackgroundAgent(a.filePath).catch(() => { /* poll reflects it */ })
        }
      } else if (e.key === '.') {
        e.preventDefault()
        cycle('pending', Object.keys(graphState.pendingInteractions).sort())
      } else if (e.key === ',') {
        e.preventDefault()
        const idle = useMeshStore.getState().agents
          .filter((a) => a.state === 'idle')
          .map((a) => a.filePath)
          .sort()
        cycle('idle', idle)
      } else if (e.key === 'Enter' && graphState.focusedFilePath) {
        e.preventDefault()
        openFile(graphState.focusedFilePath)
        expandRightPanelToTab('loop')
      } else if (e.key === 'Escape') {
        // Esc peels layers: command card, then immersive, then selection
        if (shortcutsOpenRef.current) {
          setShortcutsOpen(false)
          return
        }
        if (immersiveRef.current) {
          setImmersive(false)
          return
        }
        graphState.setFocusedFilePath(null)
        selectAgents([])
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [focusAgent, openFile, expandRightPanelToTab, selectAgents, reactFlow])

  // MiniMap colors — needs-input beats state so alerts stay visible zoomed out
  const miniMapNodeColor = useCallback((node: Node) => {
    if (node.type === 'terrainNode' || node.type === 'terrainLabelNode') return 'transparent'
    if (node.type === 'stationNode') return '#94a3b8'
    const data = node.data as unknown as MeshNodeData
    if (data?.filePath && useMeshGraphStore.getState().pendingInteractions[data.filePath]) return '#f59e0b'
    if (data?.online === false) return '#d4d4d8'
    if (data?.state === 'active') return '#facc15'
    if (data?.state === 'idle') return '#4ade80'
    if (data?.state === 'error') return '#f87171'
    return '#94a3b8'
  }, [])

  return (
    <div
      className={`bg-neutral-50 dark:bg-neutral-950 ${
        immersive ? 'fixed inset-0 z-50' : 'relative w-full h-full'
      }`}
      // Immersive covers the hidden-titlebar DRAG strip — drag regions are
      // registered with the OS by geometry, not z-order, so without this
      // carve-out every control in the top ~40px (including Exit) is dead:
      // clicks drag the window instead of reaching the DOM.
      style={immersive ? ({ WebkitAppRegion: 'no-drag' } as React.CSSProperties) : undefined}
      onMouseDownCapture={onMouseDownCapture}
      onClickCapture={onClickCapture}
      onDoubleClick={onCanvasDoubleClick}
      onMouseMove={onCanvasMouseMove}
      onMouseLeave={() => setCursorCell(null)}
    >
      {/* Top bar — immersive mode covers the hidden titlebar, so clear the
          macOS traffic lights on the left */}
      <div className={`absolute top-0 left-0 right-0 z-10 flex items-center justify-between py-2 pr-4 bg-white/80 dark:bg-neutral-900/80 backdrop-blur-sm border-b border-neutral-200 dark:border-neutral-800 ${immersive ? 'pl-24' : 'pl-4'}`}>
        <div className="flex items-center gap-2">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-neutral-500">
            <path d="M12 2l8.66 5v10L12 22l-8.66-5V7z" />
          </svg>
          <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">Age of Agents</span>
          <span className="text-xs text-neutral-400 dark:text-neutral-500">
            {meshAgents.length} agent{meshAgents.length !== 1 ? 's' : ''}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShortcutsOpen((v) => !v)}
            className="w-6 h-6 flex items-center justify-center rounded-full text-[12px] font-semibold text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 border border-neutral-200 dark:border-neutral-700"
            title="Keyboard commands (?)"
          >
            ?
          </button>
          <button
            onClick={() => setImmersive((v) => !v)}
            className="p-1 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
            title={immersive ? 'Exit full screen (Esc)' : 'Full screen (F)'}
          >
            {immersive ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
              </svg>
            )}
          </button>
          <button
            onClick={() => setShowLogDrawer(!showLogDrawer)}
            className={`px-3 py-1 text-xs rounded border transition-colors ${
              showLogDrawer
                ? 'bg-blue-50 dark:bg-blue-900/30 border-blue-300 dark:border-blue-700 text-blue-600 dark:text-blue-400'
                : 'bg-white dark:bg-neutral-800 border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-700'
            }`}
          >
            Log
          </button>
          <button
            onClick={onClose}
            className="p-1 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
            title="Close graph view"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Alert layer — needs-me queue + fleet state counts + token burn */}
      <FleetAlertBar
        onFocusAgent={focusAgent}
        onSelectGroup={(filePaths) => {
          const known = new Set(meshAgents.map((a) => a.filePath))
          selectAgents(filePaths.filter((p) => known.has(p)))
        }}
      />

      {/* Left rail — chain of command on top (steward statuses speak for
          whole groups), resource readout below */}
      <div className="absolute left-3 top-[4.7rem] z-10 w-[280px] flex flex-col gap-2 pointer-events-none">
        <FleetStewardsPanel onFocusAgent={focusAgent} />
        <FleetLeaderboard onFocusAgent={focusAgent} />
      </div>

      {/* Lens key — swaps content with the active lens */}
      <FleetLensLegend />

      {/* Cursor hex — light outline on the hovered tile, accented on agents */}
      <CursorHexOverlay cell={cursorCell} />

      {/* Command card — ? for the full key list */}
      {shortcutsOpen && <FleetShortcutsOverlay onClose={() => setShortcutsOpen(false)} />}

      {/* Foundation hex — double-click empty land to settle a new agent */}
      {founding && <FoundingOverlay site={founding} onCancel={() => setFounding(null)} onFounded={onFounded} />}

      {/* React Flow canvas — left-drag = marquee selection (RTS), middle/right drag = pan */}
      <ReactFlow
        nodes={controlledNodes}
        edges={controlledEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDoubleClick={onNodeDoubleClick}
        onSelectionChange={onSelectionChange}
        onNodeMouseEnter={onNodeMouseEnter}
        onNodeMouseLeave={onNodeMouseLeave}
        onNodeClick={onNodeClick}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable={false}
        selectionOnDrag
        selectionKeyCode={null}
        zoomOnDoubleClick={false}
        panOnDrag={[1, 2]}
        panOnScroll
        zoomOnScroll={false}
        zoomOnPinch
        fitView
        fitViewOptions={{ padding: 0.3 }}
        proOptions={{ hideAttribution: true }}
        minZoom={0.06}
        maxZoom={2}
        className="mesh-graph-flow"
      >
        <MiniMap
          zoomable
          pannable
          position="bottom-right"
          style={{ width: 140, height: 90 }}
          nodeColor={miniMapNodeColor}
          bgColor={isDark ? '#171717' : undefined}
          maskColor={isDark ? 'rgba(64, 64, 64, 0.6)' : undefined}
        />
        <HexBackground />
        <FleetGardenLayer />
        <Controls
          position="bottom-left"
          showInteractive={false}
          className="!bg-white dark:!bg-neutral-900 !border-neutral-300 dark:!border-neutral-700 !shadow-sm [&>button]:!bg-white dark:[&>button]:!bg-neutral-900 [&>button]:!border-neutral-300 dark:[&>button]:!border-neutral-700 [&>button>svg]:!fill-neutral-700 dark:[&>button>svg]:!fill-neutral-300"
        />
      </ReactFlow>

      {/* Ambient fireflies — motes along the lattice, density tracks state */}
      <FleetAmbienceLayer emitters={ambienceEmitters} />

      {/* Batch command bar — visible while agents are selected */}
      <FleetCommandBar
        onDone={refreshDebug}
        onOpenAgent={(filePath) => {
          openFile(filePath)
          expandRightPanelToTab('loop')
        }}
        onFlyTo={(filePaths) => {
          reactFlow.fitView({ nodes: filePaths.map((id) => ({ id })), duration: 350, padding: 0.35 })
        }}
      />

      {/* Hover preview — screen-space, readable at any zoom */}
      {hovered && !hovered.filePath.startsWith('station:') && (
        <FleetHoverCard filePath={hovered.filePath} x={hovered.x} y={hovered.y} />
      )}
      {hovered && hovered.filePath.startsWith('station:') && !peerAgentHover && (() => {
        const n = stationNodes.find((s) => s.id === hovered.filePath)
        if (!n) return null
        const d = n.data as unknown as StationNodeData
        return (
          <FleetStationCard
            station={{ id: n.id, kind: d.kind, label: d.label, status: d.status, detail: d.detail }}
            x={hovered.x}
            y={hovered.y}
          />
        )
      })()}

      {/* First-load veil — the world appears whole, never half-built */}
      <FleetLoadingVeil visible={booting} />

      {/* Group readout — full status + cluster vitals for a clicked chip */}
      {readoutDir && (
        <FleetGroupReadout dir={readoutDir} onClose={() => setReadoutDir(null)} onFocusAgent={focusAgent} />
      )}

      {/* Remote agent card — hovering a tile on a peer-runtime platform */}
      {peerAgentHover && (
        <FleetPeerAgentCard
          agent={peerAgentHover.agent}
          peerHost={peerAgentHover.peerHost}
          x={peerAgentHover.x}
          y={peerAgentHover.y}
        />
      )}

      {/* Empty state */}
      {meshAgents.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="text-center">
            <p className="text-sm text-neutral-400 dark:text-neutral-500">No agents found</p>
            <p className="text-xs text-neutral-300 dark:text-neutral-600 mt-1">Add .adf files to tracked directories to see them here</p>
          </div>
        </div>
      )}

      {/* Log drawer — shares debugInfo from single poll */}
      <MeshLogDrawer debugInfo={debugInfo} onRefresh={refreshDebug} />
    </div>
  )
}
