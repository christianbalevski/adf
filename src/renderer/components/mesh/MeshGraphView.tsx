import { useMemo, useCallback, useEffect, useState, useRef } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  MiniMap,
  Controls,
  ControlButton,
  useReactFlow,
  useStore,
  type Node,
  type Edge,
  type NodeChange,
  type EdgeChange,
  type OnSelectionChangeParams,
  type MiniMapNodeProps,
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
import { FleetAgentReadout } from './FleetAgentReadout'
import { FleetStewardsPanel } from './FleetStewardsPanel'
import { FleetAmbienceLayer, type AmbienceEmitter } from './FleetAmbienceLayer'
import { FleetVoicesLayer, type VoiceTerrain } from './FleetVoicesLayer'
import { FleetGardenLayer } from './FleetGardenLayer'
import { computeFleetLayout, districtKeyOf, hexDistance, hexSpiral, NODE_WIDTH, NODE_EST_HEIGHT, HEX_SIZE, HEX_ROW_H, hexCorners, axialToPixel, pixelToAxialRounded, joinDir, pathBasename, pathDirname, type TerrainNodeData } from './fleet-layout'
import { FleetPeerAgentReadout } from './FleetPeerAgentReadout'
import { FleetApprovalModal } from './FleetApprovalModal'
import { FleetStationReadout } from './FleetStationReadout'
import { useDocumentStore } from '../../stores/document.store'
import { AgentTitleCluster } from '../layout/TitleBar'
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

// Hoisted React Flow props — fresh inline objects would re-diff every render
const fitViewOptions = { padding: 0.3 }
const proOptions = { hideAttribution: true }
const panOnDrag = [1, 2]
const miniMapStyle = { width: 140, height: 90 }
// Stable empty ring — a fresh [] per bail-out would re-key every memo downstream
const NO_STATIONS: Node[] = []

/**
 * Edge object cache — an edge whose computed content is unchanged keeps its
 * exact object identity across rebuilds, so memo(MeshGraphEdge) stays warm
 * fleet-wide when one route appears. Fresh `data` objects here used to defeat
 * the memo for EVERY edge on every rebuild. Entries for vanished keys are
 * pruned; `last` lets an identical rebuild return the previous array itself.
 */
interface EdgeCache {
  map: Map<string, { sig: string; edge: Edge }>
  last: Edge[]
}

function buildEdges(
  agents: FleetAgentStatus[],
  debugInfo: MeshDebugInfo | null,
  liveRoutes: Record<string, { from: string; to: string }>,
  cache: EdgeCache
): Edge[] {
  const edges: Edge[] = []
  const edgeSet = new Set<string>()
  const keep = (edge: Edge, sig: string): Edge => {
    const hit = cache.map.get(edge.id)
    if (hit && hit.sig === sig) return hit.edge
    cache.map.set(edge.id, { sig, edge })
    return edge
  }

  // Map agent handles to filePaths (node IDs use filePaths)
  const nameToPath = new Map<string, string>()
  const agentPaths = new Set<string>()
  for (const agent of agents) {
    agentPaths.add(agent.filePath)
    const base = pathBasename(agent.filePath).replace('.adf', '')
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
    edges.push(keep({
      id: `msg-${key}`,
      source: a,
      target: b,
      type: 'meshEdge',
      data: { edgeType: 'message' }
    }, `${a}|${b}|message|`))
  }

  // Standing boundary links — agents with open WebSocket pipes get a dashed
  // channel edge to the gateway: "has a live connection to the outside" is a
  // different (and more security-relevant) statement than "sent a request".
  for (const agent of agents) {
    if (!agent.wsConnections) continue
    const key = `ws-${agent.filePath}`
    if (edgeSet.has(key)) continue
    edgeSet.add(key)
    edges.push(keep({
      id: key,
      source: agent.filePath,
      target: 'station:web',
      type: 'meshEdge',
      selectable: false,
      data: { edgeType: 'channel' }
    }, 'channel'))
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
        edges.push(keep({
          id: `msg-${key}`,
          source: a,
          target: b,
          type: 'meshEdge',
          data: { edgeType: 'message', channel: entry.channel }
        }, `${a}|${b}|message|${entry.channel ?? ''}`))
      }
    }
  }

  if (cache.map.size > edges.length) {
    const live = new Set(edges.map((e) => e.id))
    for (const key of cache.map.keys()) {
      if (!live.has(key)) cache.map.delete(key)
    }
  }
  // Identical rebuild (e.g. a debug poll confirming known routes) → the
  // previous ARRAY survives too, so downstream memos and effects stay warm
  if (cache.last.length === edges.length && edges.every((e, i) => e === cache.last[i])) {
    return cache.last
  }
  cache.last = edges
  return edges
}

/**
 * Persist the map's accumulated telemetry — trace heat/topology and burn
 * totals — so the world survives shutdowns. State capture is synchronous;
 * only the settings write is async (fire-and-forget, next cycle retries).
 */
function persistFleetMapState(): void {
  try {
    const { edgeHeat, liveRoutes, peerStreetHeat } = useMeshGraphStore.getState()
    const { burn, placement } = useFleetStore.getState()
    // A save before settings hydrate would overwrite persisted heat AND the
    // frozen geography with this session's near-empty state — placement is
    // only ever non-null after hydration, so it doubles as the gate.
    if (!placement) return
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
    const heat: typeof edgeHeat = {}
    const routes: typeof liveRoutes = {}
    for (const [key, entry] of Object.entries(edgeHeat)) {
      if (entry.lastAt < cutoff) continue
      heat[key] = entry
      const route = liveRoutes[key]
      if (route) routes[key] = route
    }
    const streets: typeof peerStreetHeat = {}
    for (const [key, entry] of Object.entries(peerStreetHeat)) {
      if (entry.lastAt >= cutoff) streets[key] = entry
    }
    const burnTotals: Record<string, number> = {}
    if (burn?.perAgent) {
      for (const [fp, e] of Object.entries(burn.perAgent)) {
        if (e.totalTokens > 0) burnTotals[fp] = e.totalTokens
      }
    }
    void window.adfApi.setSettings({
      fleetMapState: {
        heat,
        routes,
        streets,
        burnTotals,
        placement,
        savedAt: Date.now()
      }
    })
  } catch { /* next save cycle */ }
}

/**
 * OS fullscreen state — mirrors the actual window, not a windowed overlay.
 * The initial fetch races the change event; the event wins if both land.
 */
function useOsFullscreen(): boolean {
  const [fullscreen, setFullscreen] = useState(false)
  useEffect(() => {
    let mounted = true
    let receivedEvent = false
    const unsubscribe = window.adfApi?.onFullscreenChanged?.((v) => {
      receivedEvent = true
      setFullscreen(v)
    })
    window.adfApi?.getFullscreenState?.().then((v) => {
      if (mounted && !receivedEvent) setFullscreen(v)
    })
    return () => {
      mounted = false
      unsubscribe?.()
    }
  }, [])
  return fullscreen
}

function MapNavButton({
  title,
  active,
  onClick,
  children
}: {
  title: string
  active?: boolean
  onClick?: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`w-7 h-7 flex items-center justify-center rounded-md transition-colors ${
        active
          ? 'bg-blue-100 text-blue-600 dark:bg-blue-900/40 dark:text-blue-400'
          : 'text-neutral-500 dark:text-neutral-400 hover:bg-neutral-200 dark:hover:bg-neutral-700'
      }`}
    >
      {children}
    </button>
  )
}

/**
 * The map's top bar doubles as the window titlebar — AppShell hides the real
 * one while the map is open, so this bar carries the drag region, the app
 * navigation (Home / map / Settings), and clearance for the native window
 * controls: macOS traffic lights overlay the left edge (hiddenInset), the
 * Windows/Linux controls overlay the right (titlebar-area env vars only
 * exist under that overlay; the 100vw fallbacks collapse the padding to
 * zero everywhere else). Real fullscreen hides both sets of controls.
 */
function FleetTopBar({
  onHome,
  onSettings,
  agentCount,
  agentCluster,
  children
}: {
  onHome: () => void
  onSettings: () => void
  agentCount?: number
  /** Open-agent identity cluster — replaces the map title while a file is
   *  open, so the bar answers "which agent owns the dock and status bar?" */
  agentCluster?: React.ReactNode
  children?: React.ReactNode
}) {
  const isFullscreen = useOsFullscreen()
  const isMac = window.adfApi?.platform === 'darwin'
  return (
    <div
      className="absolute top-0 left-0 right-0 z-10 h-10 flex items-center justify-between bg-white/80 dark:bg-neutral-900/80 backdrop-blur-sm border-b border-neutral-200 dark:border-neutral-800 select-none"
      style={{
        WebkitAppRegion: 'drag',
        paddingLeft: !isFullscreen && isMac ? 84 : 'calc(16px + env(titlebar-area-x, 0px))',
        paddingRight: isFullscreen || isMac
          ? 16
          : 'calc(16px + max(0px, 100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw)))'
      } as React.CSSProperties}
    >
      <div className="flex items-center gap-3 min-w-0">
        <nav
          className="flex items-center gap-0.5 shrink-0"
          aria-label="Application navigation"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <MapNavButton title="Home" onClick={onHome}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              <polyline points="9 22 9 12 15 12 15 22" />
            </svg>
          </MapNavButton>
          <MapNavButton title="Age of Agents" active>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2l8.66 5v10L12 22l-8.66-5V7z" />
            </svg>
          </MapNavButton>
          <MapNavButton title="Settings" onClick={onSettings}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </MapNavButton>
        </nav>
        {agentCluster ?? (
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300 truncate">Age of Agents</span>
            {agentCount != null && (
              <span className="text-xs text-neutral-400 dark:text-neutral-500 shrink-0">
                {agentCount} agent{agentCount !== 1 ? 's' : ''}
              </span>
            )}
          </div>
        )}
      </div>
      <div
        className="flex items-center gap-2 shrink-0"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        {children}
      </div>
    </div>
  )
}

export function MeshGraphView() {
  const meshEnabled = useMeshStore((s) => s.enabled)
  const { enableMesh } = useMesh()
  const setShowMeshGraph = useAppStore((s) => s.setShowMeshGraph)
  const setShowSettings = useAppStore((s) => s.setShowSettings)
  const resetStore = useMeshGraphStore((s) => s.reset)
  const resetFleetStore = useFleetStore((s) => s.reset)
  const { closeFile } = useAdfFile()

  const closeMap = useCallback(() => {
    persistFleetMapState()
    resetStore()
    resetFleetStore()
    setShowMeshGraph(false)
  }, [resetStore, resetFleetStore, setShowMeshGraph])

  const handleHome = useCallback(() => {
    closeMap()
    setShowSettings(false)
    if (useDocumentStore.getState().filePath) closeFile()
  }, [closeMap, setShowSettings, closeFile])

  const handleSettings = useCallback(() => {
    closeMap()
    setShowSettings(true)
  }, [closeMap, setShowSettings])

  if (!meshEnabled) {
    return (
      <div className="relative w-full h-full bg-neutral-50 dark:bg-neutral-950">
        <FleetTopBar onHome={handleHome} onSettings={handleSettings} />
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
      <MeshGraphCanvas onHome={handleHome} onSettings={handleSettings} />
    </ReactFlowProvider>
  )
}

/**
 * Cursor hex — Civ-style light outline on whatever tile the mouse is over,
 * with a stronger accent when that tile is an agent so you always know which
 * hex you're about to click. Renders as a screen-space overlay following the
 * viewport transform; stroke width divides by zoom to stay constant on screen.
 */
function CursorHexOverlay({ pendingCells }: { pendingCells: Set<string> }) {
  const [tx, ty, zoom] = useStore((s) => s.transform)
  const cell = useFleetStore((s) => s.cursorCell)
  // Yields on cells with an open approval card — this overlay would paint
  // straight across it (screen-space overlay vs the in-canvas card).
  if (!cell || pendingCells.has(`${cell.q},${cell.r}`)) return null
  const { x, y } = axialToPixel(cell.q, cell.r)
  return (
    // z-[5]: above the canvas (the RF viewport's transform context stacks
    // at DOM level), below every piece of chrome — the top bar, legend, and
    // rails are z-10+, and the RF panels (minimap/controls, also z-5) come
    // later in the DOM so they win the tie. A hovered hex must never paint
    // over UI.
    <svg className="absolute inset-0 w-full h-full pointer-events-none z-[5]" style={{ overflow: 'hidden' }}>
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

/**
 * Move ghost — hex outlines for every cell a drag (or More-menu move) would
 * claim: RTS building-placement idiom. Violet when the drop is legal, red
 * when any target would land on an agent outside the moving set.
 */
function DragGhostOverlay() {
  const [tx, ty, zoom] = useStore((s) => s.transform)
  const ghost = useFleetStore((s) => s.dragGhost)
  if (!ghost || ghost.cells.length === 0) return null
  const stroke = ghost.valid ? 'rgba(139,92,246,0.85)' : 'rgba(239,68,68,0.9)'
  const fill = ghost.valid ? 'rgba(139,92,246,0.10)' : 'rgba(239,68,68,0.14)'
  return (
    <svg className="absolute inset-0 w-full h-full pointer-events-none z-[6]" style={{ overflow: 'hidden' }}>
      <g transform={`translate(${tx} ${ty}) scale(${zoom})`}>
        {ghost.cells.map((c) => {
          const { x, y } = axialToPixel(c.q, c.r)
          return (
            <polygon
              key={`${c.q},${c.r}`}
              points={hexCorners(x, y, HEX_SIZE - 2)}
              fill={fill}
              stroke={stroke}
              strokeWidth={2.5 / zoom}
              strokeDasharray={`${10 / zoom} ${6 / zoom}`}
            />
          )
        })}
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

  const rootName = pathBasename(site.dir)
  const resolve = (raw: string): { dir: string; agent: string } => {
    if (raw.includes('/')) {
      const idx = raw.lastIndexOf('/')
      return { dir: joinDir(site.dir, raw.slice(0, idx)), agent: raw.slice(idx + 1) }
    }
    // Ocean founding without a slash: the agent founds a group of its own name
    if (site.ocean) return { dir: joinDir(site.dir, raw), agent: raw }
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
            ? 'Create an agent in a new root folder'
            : site.ocean ? `Create an agent in a new group near ${rootName}` : `Create an agent in ${rootName}`}
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
              ? `→ ${pathBasename(preview.dir)}/${preview.agent}.adf${site.newRoot ? ' · new tracked folder' : ''} · Enter to create`
              : site.newRoot
                ? `New folder beside ${rootName} — it becomes its own territory`
                : 'Enter creates the agent and opens its chat'}
        </div>
        {busy && <div className="text-[10px] text-violet-500">Creating…</div>}
      </div>
    </div>
  )
}

/**
 * True when the pointer sits over an open say-bubble. Bubbles are
 * pointer-transparent (clicks/drags reach the tiles they cover), so
 * "is the user reading a bubble" is answered geometrically, not by
 * event targets.
 *
 * Rects are memoized per animation frame: bubbles live 75s, so under
 * chatter several always exist and querying layout on every mousemove
 * forced a synchronous reflow between the pan's transform writes.
 */
let sayBubbleRects: DOMRect[] | null = null
function getSayBubbleRects(): DOMRect[] {
  if (!sayBubbleRects) {
    sayBubbleRects = Array.from(document.querySelectorAll('.fleet-say-bubble'), (el) =>
      el.getBoundingClientRect()
    )
    requestAnimationFrame(() => { sayBubbleRects = null })
  }
  return sayBubbleRects
}
function overSayBubble(x: number, y: number): boolean {
  for (const r of getSayBubbleRects()) {
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true
  }
  return false
}

/**
 * Minimap node with an RTS ping: while this node is an endpoint of an
 * in-flight message animation, a violet pulse marks its spot on the minimap
 * so off-screen action registers from the overview. Subscribes per node —
 * only pinging rects re-render; the heavy view never learns about pings.
 */
function FleetMiniMapNode({ id, x, y, width, height, color, borderRadius, shapeRendering }: MiniMapNodeProps) {
  const pinged = useMeshGraphStore((s) => {
    for (const key in s.activeAnimationIndex) {
      const bar = key.indexOf('|')
      if (key.slice(0, bar) === id || key.slice(bar + 1) === id) return true
    }
    return false
  })
  return (
    <>
      <rect x={x} y={y} width={width} height={height} fill={color} rx={borderRadius} shapeRendering={shapeRendering} />
      {pinged && (
        <circle
          cx={x + width / 2}
          cy={y + height / 2}
          r={Math.max(width, height) * 0.9}
          fill="#8b5cf6"
          opacity={0.85}
          style={{ animation: 'hexPulse 0.8s ease-in-out infinite' }}
        />
      )}
    </>
  )
}

/** True when a keyboard event originates from a text-entry element. */
function isTypingTarget(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null
  if (!el) return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable
}

function MeshGraphCanvas({ onHome, onSettings }: { onHome: () => void; onSettings: () => void }) {
  // Subscribe to mesh graph events
  useMeshGraph()

  // Theme — read at render; the theme toggle re-renders the tree
  const isDark = document.documentElement.classList.contains('dark')

  // First-load veil — up until the first fleet poll lands and layout settles
  const [booting, setBooting] = useState(true)

  // No whole-roster subscription: every agent event gives `agents` a new
  // identity, and re-rendering this component (plus rebuilding nodes/edges)
  // per event was the fleet-wide cascade. Instead the roster is consumed as
  // keyed projections — each selector returns a string/number that only
  // changes when ITS slice of the fleet changes — and callbacks read the
  // live array via getState(). Live per-node fields flow through the
  // patchLiveFields subscription below, never through a render of this tree.
  const agentCount = useMeshStore((s) => s.agents.length)
  const setAgents = useMeshStore((s) => s.setAgents)
  const showLogDrawer = useMeshGraphStore((s) => s.showLogDrawer)
  const setShowLogDrawer = useMeshGraphStore((s) => s.setShowLogDrawer)
  const setAllPendingInteractions = useMeshGraphStore((s) => s.setAllPendingInteractions)
  const setFocusedFilePath = useMeshGraphStore((s) => s.setFocusedFilePath)
  const setBurn = useFleetStore((s) => s.setBurn)
  const setSelection = useFleetStore((s) => s.setSelection)
  const setFamily = useFleetStore((s) => s.setFamily)
  const expandRightPanelToTab = useAppStore((s) => s.expandRightPanelToTab)
  const revealRightPanel = useAppStore((s) => s.revealRightPanel)
  const { openFile, closeFile } = useAdfFile()
  const reactFlow = useReactFlow()

  const docFilePath = useDocumentStore((s) => s.filePath)
  const seedActivities = useMeshGraphStore((s) => s.seedActivities)
  const [debugInfo, setDebugInfo] = useState<MeshDebugInfo | null>(null)
  const [adapters, setAdapters] = useState<{ type: string; status: string }[]>([])
  const [lanPeers, setLanPeers] = useState<{ runtime_id: string; host: string; agent_count?: number; first_seen?: number; source?: string; url?: string; runtime_alias?: string; owner_alias?: string; owner_verified?: boolean; is_self_owned?: boolean; agents?: RemotePeerAgent[] }[]>([])
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Hover preview — screen-space card, delayed so pans don't flicker it
  const [hovered, setHovered] = useState<{ filePath: string; x: number; y: number; pinned?: boolean } | null>(null)
  const peerAgentHover = useFleetStore((s) => s.peerAgentHover)
  const peerReadout = useFleetStore((s) => s.peerReadout)
  const setPeerReadout = useFleetStore((s) => s.setPeerReadout)
  const readoutDir = useFleetStore((s) => s.readoutDir)
  const setReadoutDir = useFleetStore((s) => s.setReadoutDir)
  const agentReadout = useFleetStore((s) => s.agentReadout)
  const hilModal = useFleetStore((s) => s.hilModal)
  const setHilModal = useFleetStore((s) => s.setHilModal)
  const stationReadout = useFleetStore((s) => s.stationReadout)
  const setStationReadout = useFleetStore((s) => s.setStationReadout)
  const setAgentReadout = useFleetStore((s) => s.setAgentReadout)
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hoverClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Pan gating — refs + a direct classList toggle so gestures never
  // re-render this component. `fleet-panning` mirrors `fleet-calm`'s
  // animation-pause rules but is owned here: the ambience governor toggles
  // fleet-calm on <html> from its own adaptive loop, and the two must not
  // fight over one class.
  const mapRootRef = useRef<HTMLDivElement | null>(null)
  const panningRef = useRef(false)
  const panSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const beginPanGesture = useCallback(() => {
    if (panSettleTimerRef.current) {
      clearTimeout(panSettleTimerRef.current)
      panSettleTimerRef.current = null
    }
    if (panningRef.current) return
    panningRef.current = true
    mapRootRef.current?.classList.add('fleet-panning')
    // A pan is navigation, not inspection: cancel any pending hover arm and
    // drop an open un-pinned card immediately (pinned cards stay).
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = null
    }
    setHovered((prev) => (prev?.pinned ? prev : null))
  }, [])

  const endPanGesture = useCallback(() => {
    if (panSettleTimerRef.current) clearTimeout(panSettleTimerRef.current)
    panSettleTimerRef.current = setTimeout(() => {
      panSettleTimerRef.current = null
      panningRef.current = false
      mapRootRef.current?.classList.remove('fleet-panning')
    }, 250)
  }, [])

  // Cursor hex — which lattice cell the mouse is over (rAF-throttled)
  // cursorCell lives in the fleet store (written imperatively, read only by
  // CursorHexOverlay) so mouse movement never re-renders this component.
  const cursorRaf = useRef(0)

  // Real OS fullscreen — F toggles, Esc exits. The map already fills the
  // window (no sidebar, its own top bar), so "full screen" means the actual
  // window going fullscreen, not a windowed overlay.
  const isFullscreen = useOsFullscreen()
  const fullscreenRef = useRef(false)
  fullscreenRef.current = isFullscreen

  // Edge scrolling — fullscreen only. In a window the cursor constantly
  // exits past the edges and it misfires; OS fullscreen is the RTS
  // condition where a cursor parked at the edge should pan the camera.
  useEffect(() => {
    if (!isFullscreen) return
    const EDGE = 28
    // Time-based so speed is identical on 60Hz and 120Hz displays — a
    // per-frame constant scrolled twice as fast on ProMotion screens.
    const PX_PER_SEC = 600
    let dx = 0
    let dy = 0
    const onMove = (e: MouseEvent): void => {
      dx = e.clientX < EDGE ? 1 : e.clientX > window.innerWidth - EDGE ? -1 : 0
      dy = e.clientY < EDGE ? 1 : e.clientY > window.innerHeight - EDGE ? -1 : 0
    }
    let raf = 0
    let lastT = 0
    let wasScrolling = false
    const tick = (t: number): void => {
      const dt = lastT ? Math.min((t - lastT) / 1000, 0.05) : 0
      lastT = t
      const scrolling = dx !== 0 || dy !== 0
      if (scrolling) {
        // The ticker is a pan gesture without a pointer drag — same gating
        // (hover suppression + paused pulses) as onMoveStart/onMoveEnd
        beginPanGesture()
        const { x, y, zoom } = reactFlow.getViewport()
        reactFlow.setViewport({ x: x + dx * PX_PER_SEC * dt, y: y + dy * PX_PER_SEC * dt, zoom })
      } else if (wasScrolling) {
        endPanGesture()
      }
      wasScrolling = scrolling
      raf = requestAnimationFrame(tick)
    }
    window.addEventListener('mousemove', onMove)
    raf = requestAnimationFrame(tick)
    return () => {
      window.removeEventListener('mousemove', onMove)
      cancelAnimationFrame(raf)
      if (wasScrolling) endPanGesture()
    }
  }, [isFullscreen, reactFlow, beginPanGesture, endPanGesture])

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
      // Content-compare before setting (the dedupe setAgents does in
      // mesh.store): the 5s poll usually returns byte-identical data, and a
      // fresh identity here rebuilds edges/stations and rediffs the graph.
      setDebugInfo((prev) => (JSON.stringify(prev) === JSON.stringify(info) ? prev : info))
      const nextAdapters = (adapterStatus as { adapters: { type: string; status: string }[] }).adapters ?? []
      setAdapters((prev) => (JSON.stringify(prev) === JSON.stringify(nextAdapters) ? prev : nextAdapters))
      // DEV: window.__fleetPeersOverride injects synthetic LAN peers for
      // testing — the contextBridge API is frozen, so it can't be patched.
      const peersOverride = import.meta.env.DEV
        ? (window as unknown as { __fleetPeersOverride?: unknown }).__fleetPeersOverride
        : undefined
      const nextPeers = ((peersOverride ?? peers) as { runtime_id: string; host: string; agent_count?: number; first_seen?: number; source?: string; url?: string; runtime_alias?: string; owner_alias?: string; owner_verified?: boolean; is_self_owned?: boolean; agents?: RemotePeerAgent[] }[]) ?? []
      setLanPeers((prev) => (JSON.stringify(prev) === JSON.stringify(nextPeers) ? prev : nextPeers))
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
          streets?: Record<string, { lastAt: number; count: number }>
          placement?: {
            regionOrigins?: Record<string, { q: number; r: number }>
            cellPins?: Record<string, { q: number; r: number; solo?: boolean }>
            districtAnchors?: Record<string, { q: number; r: number }>
            stationPins?: Record<string, { q: number; r: number }>
          }
        }
      }
      if (s.fleetGroups) setNamedGroups(s.fleetGroups)
      if (s.fleetStewards) setStewards(s.fleetStewards)
      if (s.fleetMapState?.heat || s.fleetMapState?.streets) {
        useMeshGraphStore.getState().hydrateGraphState(
          s.fleetMapState.heat ?? {},
          s.fleetMapState.routes ?? {},
          s.fleetMapState.streets
        )
      }
      // Frozen geography — non-null placement also unlocks persistence
      useFleetStore.getState().setPlacement({
        regionOrigins: s.fleetMapState?.placement?.regionOrigins ?? {},
        cellPins: s.fleetMapState?.placement?.cellPins ?? {},
        districtAnchors: s.fleetMapState?.placement?.districtAnchors ?? {},
        stationPins: s.fleetMapState?.placement?.stationPins ?? {}
      })
    }).catch(() => {
      // Unreadable settings: unlock layout recording with a blank slate
      useFleetStore.getState().setPlacement({ regionOrigins: {}, cellPins: {} })
    })
    const saveTimer = setInterval(persistFleetMapState, 60_000)
    return () => clearInterval(saveTimer)
  }, [setNamedGroups, setStewards])

  // Live routes from message_routed events (ensures edges exist for animations)
  const liveRoutes = useMeshGraphStore((s) => s.liveRoutes)

  // Pending HIL/ask interactions — a tile with an open approval card must
  // paint above its neighbors, and its hover card yields to the card.
  const pendingInteractions = useMeshGraphStore((s) => s.pendingInteractions)

  // Message edges — merge debug-polled message log with live routes. Keyed
  // on the roster fields edges actually read (who exists, handles, open WS
  // pipes — truthiness only: a 2nd connection is still one channel edge) so
  // state/status churn never rebuilds them.
  const edgeAgentsKey = useMeshStore((s) =>
    s.agents.map((a) => `${a.filePath}|${a.handle}|${a.wsConnections ? 1 : 0}`).join('\n')
  )
  const edgeCacheRef = useRef<EdgeCache>({ map: new Map(), last: [] })
  const messageEdges = useMemo(
    () => buildEdges(useMeshStore.getState().agents, debugInfo, liveRoutes, edgeCacheRef.current),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [edgeAgentsKey, debugInfo, liveRoutes]
  )

  // Fleet layout — tracked-dir terrain regions + subdir districts + lineage
  // trees. Positions are deterministic (regions and siblings sorted by path)
  // AND frozen: remembered origins + founding pins keep the geography still.
  const placement = useFleetStore((s) => s.placement)
  const setPlacement = useFleetStore((s) => s.setPlacement)
  // Layout is expensive (region planning, hex spirals, lineage resolution)
  // and depends only on the fleet's STRUCTURE — who exists, where they live,
  // their ancestry — never on state flips or status lines. Key the memo on
  // that structure so the 5s poll doesn't re-plan every territory to repaint
  // one status; live fields are decorated onto the frozen nodes downstream.
  const structKey = useMeshStore((s) =>
    s.agents
      .map((a) =>
        [a.filePath, a.trackedDirRoot, a.createdAt, a.parentDid, a.did, a.agentId, a.didHistory?.join(','), a.handle, a.icon].join('|')
      )
      .sort()
      .join('\n')
  )
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const layout = useMemo(() => computeFleetLayout(useMeshStore.getState().agents, placement ?? undefined), [structKey, placement])

  // Record where this pass actually put each region AND each district.
  // Converges: writing the merged origins/anchors re-runs the layout with
  // them honored, which reproduces the same values, and the merge no-ops.
  useEffect(() => {
    if (!placement) return
    const origins = { ...placement.regionOrigins }
    const anchors = { ...(placement.districtAnchors ?? {}) }
    let changed = false
    for (const [dir, o] of Object.entries(layout.regionOrigins)) {
      const cur = origins[dir]
      if (!cur || cur.q !== o.q || cur.r !== o.r) {
        origins[dir] = o
        changed = true
      }
    }
    for (const [key, a] of Object.entries(layout.districtAnchors)) {
      const cur = anchors[key]
      if (!cur || cur.q !== a.q || cur.r !== a.r) {
        anchors[key] = a
        changed = true
      }
    }
    if (changed) setPlacement({ ...placement, regionOrigins: origins, districtAnchors: anchors })
  }, [layout, placement, setPlacement])

  // Placement changes persist debounced — covers drags, records, and the
  // More ▾ "Reset layout" without every writer calling persist itself.
  useEffect(() => {
    if (!placement) return
    const t = setTimeout(persistFleetMapState, 2000)
    return () => clearTimeout(t)
  }, [placement])

  // Base stations — perimeter structures for the fleet's boundary contacts:
  // one per configured channel adapter plus the web gateway (sys_fetch).
  // Lined up along the northern edge, lattice-snapped, outside all territory.
  // Cached by id + content: the ring re-derives whenever layout/placement
  // change, but a station whose cell, facing, and data are unchanged keeps
  // its exact object (an unchanged ring keeps the array itself), so polls
  // and unrelated drags never re-render every platform.
  const stationCacheRef = useRef<{ map: Map<string, { sig: string; node: Node }>; last: Node[] }>({ map: new Map(), last: [] })
  const stationNodes = useMemo<Node[]>(() => {
    if (layout.nodes.length === 0) return NO_STATIONS
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
        // The runtime's chosen alias wins over the hostname mDNS/Tailscale shares.
        label: (p.runtime_alias || p.host || p.runtime_id).replace(/\.local\.?$/, '').slice(0, 18),
        status: p.agent_count != null ? `${p.agent_count} agents` : 'directory unreachable',
        slotDeg: (15 + pi * GOLDEN_DEG) % 360,
        detail: {
          host: p.host, agentCount: p.agent_count, firstSeen: p.first_seen, url: p.url, source: p.source,
          ownerAlias: p.owner_alias, ownerVerified: p.owner_verified, isSelfOwned: p.is_self_owned
        },
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
    if (!Number.isFinite(minX)) return NO_STATIONS
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
    const stationPins = placement?.stationPins ?? {}
    // Desired cell per station: its pin, else the perimeter auto-slot.
    // Conflicts (a runtime returning to find its old ground claimed) resolve
    // render-side by priority — user-dragged pin > frozen auto-slot > new
    // arrival — and the loser bumps along a spiral to the nearest clear
    // ground WITHOUT rewriting its pin, so when the winner disconnects the
    // displaced station simply returns home.
    const desired = kinds.map((k, i) => {
      const pin = stationPins[k.id]
      const slotDeg = k.slotDeg ?? SLOT_DEG[k.kind] ?? (i * 67) % 360
      const angle = (slotDeg * Math.PI) / 180
      const rawX = centerX + rx * Math.cos(angle)
      const rawY = centerY + ry * Math.sin(angle)
      const cell = pin ? { q: pin.q, r: pin.r } : pixelToAxialRounded(rawX, rawY)
      return { id: k.id, cell, priority: pin ? (pin.auto ? 1 : 0) : 2 }
    })
    const placedStations: { q: number; r: number }[] = []
    const resolvedCell = new Map<string, { q: number; r: number }>()
    for (const d of [...desired].sort((a, b) => a.priority - b.priority)) {
      let cell = d.cell
      if (placedStations.some((p) => hexDistance(cell.q, cell.r, p.q, p.r) < 5)) {
        for (const [dq, dr] of hexSpiral(600)) {
          const cand = { q: d.cell.q + dq, r: d.cell.r + dr }
          if (placedStations.every((p) => hexDistance(cand.q, cand.r, p.q, p.r) >= 5)) {
            cell = cand
            break
          }
        }
      }
      placedStations.push(cell)
      resolvedCell.set(d.id, cell)
    }
    const built = kinds.map((k) => {
      const { q, r } = resolvedCell.get(k.id)!
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
        // Stations relocate like tiles: drop pins the platform to a cell.
        // Drag only from the pads — the invisible bounding box stays inert
        // so marquee/pan through open water keeps working.
        draggable: true,
        dragHandle: '.station-drag-handle',
        selectable: false,
        focusable: false,
        initialWidth: STATION_W,
        initialHeight: STATION_H,
        data: { kind: k.kind, label: k.label, status: k.status, facing, detail: k.detail, peerAgents: k.peerAgents } satisfies StationNodeData
      }
    })
    const cache = stationCacheRef.current
    const out = built.map((n) => {
      const sig = JSON.stringify([n.position, n.data])
      const hit = cache.map.get(n.id)
      if (hit && hit.sig === sig) return hit.node
      cache.map.set(n.id, { sig, node: n })
      return n
    })
    if (cache.map.size > out.length) {
      const live = new Set(out.map((n) => n.id))
      for (const key of cache.map.keys()) {
        if (!live.has(key)) cache.map.delete(key)
      }
    }
    if (cache.last.length === out.length && out.every((n, i) => n === cache.last[i])) return cache.last
    cache.last = out
    return out
  }, [layout, adapters, lanPeers, placement])

  // Freeze the ring: any station rendering without a pin records its cell
  // (auto flag) the moment it appears — new arrivals place via the ring
  // algorithm ONCE, then hold ground forever. Without this, the ring's
  // bbox/mass geometry re-derives on every agent move and runtimes wander.
  useEffect(() => {
    if (!placement) return
    const missing: Record<string, { q: number; r: number; auto?: boolean }> = {}
    for (const n of stationNodes) {
      if (placement.stationPins?.[n.id]) continue
      const c = pixelToAxialRounded(n.position.x + STATION_W / 2, n.position.y + STATION_H / 2)
      missing[n.id] = { q: c.q, r: c.r, auto: true }
    }
    if (Object.keys(missing).length > 0) {
      useFleetStore.getState().updatePlacement({}, undefined, undefined, missing)
    }
  }, [stationNodes, placement])

  // Agents live on their hex, but tiles are movable: dropping one re-pins
  // it (⌥ moves its district, ⌘ its territory) — see onNodeDragStop.
  // A tile with a pending approval card jumps above its neighbors so the
  // card is never clipped by an adjacent tile's chrome (zIndex, patched live).
  const structuralNodes = useMemo(() => {
    // Decorate the frozen structural layout with the live per-agent fields
    // CURRENT at build time — read imperatively, so live churn never re-keys
    // this memo. This array only changes identity on STRUCTURAL change
    // (agents added/removed, geometry, stations); between rebuilds the
    // patchLiveFields subscription below keeps the controlled copies fresh.
    const byPath = new Map(useMeshStore.getState().agents.map((a) => [a.filePath, a]))
    const pending = useMeshGraphStore.getState().pendingInteractions
    const decorated = layout.nodes.map((n) => {
      let out = n
      if (n.type === 'meshNode') {
        const a = byPath.get(n.id)
        const d = n.data as unknown as MeshNodeData
        if (
          a &&
          (d.state !== a.state || d.status !== a.status || d.online !== a.online ||
            d.servedUrl !== a.servedUrl || d.model !== a.model)
        ) {
          out = { ...n, data: { ...n.data, state: a.state, status: a.status, online: a.online, servedUrl: a.servedUrl, model: a.model } }
        }
      }
      return pending[out.id] ? { ...out, zIndex: 100 } : out
    })
    return [...decorated, ...stationNodes]
  }, [layout, stationNodes])

  // Camera cap — the viewport can't wander more than a few hexes past the
  // outermost content. Unbounded panning let a tile get founded/dropped in
  // the deep void, which blew up the world bounds (and shrank the minimap
  // to specks). The extent follows content: settle the frontier and it
  // grows; drag a stray back home and it shrinks.
  const translateExtent = useMemo<[[number, number], [number, number]] | undefined>(() => {
    if (structuralNodes.length === 0) return undefined
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const n of structuralNodes) {
      minX = Math.min(minX, n.position.x)
      minY = Math.min(minY, n.position.y)
      maxX = Math.max(maxX, n.position.x + (n.width ?? NODE_WIDTH))
      maxY = Math.max(maxY, n.position.y + (n.height ?? NODE_EST_HEIGHT))
    }
    const MARGIN = HEX_ROW_H * 4 // ~4 hex rows of open frontier on every side
    return [[minX - MARGIN, minY - MARGIN], [maxX + MARGIN, maxY + MARGIN]]
  }, [structuralNodes])

  // Startup camera. One-shot fits kept losing: the fleet loads in WAVES
  // (live mesh registrations, then the full fleet poll, then peers), so any
  // fit taken when content "first lands" frames an early, smaller world that
  // then grows out from under it. Instead the camera auto-follows the world
  // while it's still building — every structural layout change re-fits after
  // a short debounce, judged ready only when React Flow's own store has
  // measured fleet content (stations arrive first with explicit widths and
  // must not count). Auto-follow disarms on the first user gesture (pointer
  // or wheel anywhere) or 10s after mount, so it can never fight you.
  const autoFitRef = useRef<{ active: boolean; deadline: number }>({ active: true, deadline: 0 })
  useEffect(() => {
    autoFitRef.current.deadline = Date.now() + 10_000
    const disarm = (): void => {
      autoFitRef.current.active = false
    }
    window.addEventListener('pointerdown', disarm, true)
    window.addEventListener('wheel', disarm, { capture: true, passive: true })
    window.addEventListener('keydown', disarm, true)
    return () => {
      window.removeEventListener('pointerdown', disarm, true)
      window.removeEventListener('wheel', disarm, true)
      window.removeEventListener('keydown', disarm, true)
    }
  }, [])
  useEffect(() => {
    const st = autoFitRef.current
    if (!st.active || Date.now() > st.deadline || !placement || layout.nodes.length === 0) return
    let cancelled = false
    let tries = 0
    const attempt = (): void => {
      if (cancelled || !st.active) return
      const fleetReady = reactFlow
        .getNodes()
        .some((n) => (n.type === 'terrainNode' || n.type === 'meshNode') && (n.measured?.width ?? n.width) != null)
      if (fleetReady) {
        void reactFlow.fitView({ padding: 0.3 })
        return
      }
      if (++tries < 600) requestAnimationFrame(attempt)
    }
    // Debounce past the wave: only a layout that stays put for a beat gets
    // framed, so the camera glides to the final world instead of each wave
    const t = setTimeout(() => requestAnimationFrame(attempt), 350)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [layout, placement, reactFlow])

  // Firefly emitters — one per agent tile, world-space centers. State drives
  // emission density in the ambience layer (pending-HIL read imperatively
  // there, so this memo doesn't churn on every interaction event). Keyed on
  // a state/online projection — the structural nodes are frozen, so the
  // emitters must re-read live state when it flips (and only then).
  const liveStateKey = useMeshStore((s) =>
    s.agents.map((a) => `${a.filePath}|${a.state}|${a.online === false ? 0 : 1}`).join('\n')
  )
  const ambienceEmitters = useMemo<AmbienceEmitter[]>(() => {
    const byPath = new Map(useMeshStore.getState().agents.map((a) => [a.filePath, a]))
    const out: AmbienceEmitter[] = []
    for (const n of structuralNodes) {
      if (n.type !== 'meshNode') continue
      const a = byPath.get(n.id)
      const d = n.data as unknown as MeshNodeData
      out.push({
        x: n.position.x + NODE_WIDTH / 2,
        y: n.position.y + NODE_EST_HEIGHT / 2,
        state: (a?.state ?? d.state) ?? 'off',
        online: (a ? a.online : d.online) !== false,
        filePath: n.id
      })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structuralNodes, liveStateKey])

  // Voice-layer anchors — territory geometry for the screen-space status
  // chips (FleetVoicesLayer picks the voices; this only carries geography)
  const voiceTerrains = useMemo<VoiceTerrain[]>(() => {
    const out: VoiceTerrain[] = []
    for (const n of layout.nodes) {
      if (n.type !== 'terrainNode') continue
      const d = n.data as unknown as TerrainNodeData
      out.push({
        dirPath: d.dirPath,
        x: n.position.x,
        y: n.position.y,
        cells: d.cells,
        districts: d.districts,
        memberPaths: d.members.map((m) => m.filePath)
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

  // Cells whose tile has an open approval/ask card — the cursor hex outline
  // is a screen-space overlay (above the canvas) that would paint straight across the
  // card, so it yields on those cells.
  const pendingCells = useMemo(() => {
    const set = new Set<string>()
    for (const n of layout.nodes) {
      if (n.type !== 'meshNode' || !pendingInteractions[n.id]) continue
      const { q, r } = pixelToAxialRounded(n.position.x + NODE_WIDTH / 2, n.position.y + NODE_EST_HEIGHT / 2)
      set.add(`${q},${r}`)
    }
    return set
  }, [layout, pendingInteractions])

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
  const foundingRef = useRef(false)
  foundingRef.current = !!founding
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
      const parent = pathDirname(best)
      if (parent) setFounding({ q, r, dir: parent, ocean: true, newRoot: true })
    } else {
      setFounding({ q, r, dir: best, ocean: true })
    }
  }, [reactFlow, occupiedCells, cellDirs])

  const onFounded = useCallback(async (filePath: string) => {
    // The clicked hex is a promise: pin the newborn to it, then persist
    // immediately so the pin survives even a crash. (A brand-new root's
    // region origin derives from this pin inside the layout itself.)
    if (founding) {
      useFleetStore.getState().pinCell(filePath, { q: founding.q, r: founding.r })
      persistFleetMapState()
    }
    setFounding(null)
    refreshDebug()
    // Straight into the briefing: open the newborn's doc + loop panel
    await openFile(filePath)
    expandRightPanelToTab('loop')
  }, [founding, refreshDebug, openFile, expandRightPanelToTab])

  const onCanvasMouseMove = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    const overCanvas = (!!target.closest('.react-flow__pane') || !!target.closest('.react-flow__node'))
    const { clientX, clientY } = e
    cancelAnimationFrame(cursorRaf.current)
    cursorRaf.current = requestAnimationFrame(() => {
      // Reading a bubble ≠ inspecting the tile under it — no hex highlight
      // there (bubbles are pointer-transparent, so check geometry). Checked
      // inside the rAF so the mousemove handler itself never reads layout.
      if (!overCanvas || overSayBubble(clientX, clientY)) {
        useFleetStore.getState().setCursorCell(null)
        return
      }
      const pos = reactFlow.screenToFlowPosition({ x: clientX, y: clientY })
      const { q, r } = pixelToAxialRounded(pos.x, pos.y)
      const agent = occupiedCells.has(`${q},${r}`)
      useFleetStore.getState().setCursorCell({ q, r, agent })
    })
  }, [reactFlow, occupiedCells])

  // Lineage renders as a family glow on tiles (see effect below), not as
  // permanent lines — only live message traffic draws edges.
  const rawEdges = messageEdges

  // Controlled state is required for drag moves over the frozen geography
  // (React Flow applies drag position changes to OUR arrays) — but it only
  // mirrors STRUCTURE. Live per-agent fields are patched into it in place by
  // patchLiveFields, so one agent's flip re-identifies one node object, not
  // the whole graph.
  const [controlledNodes, setControlledNodes] = useState<Node[]>(structuralNodes)
  const [controlledEdges, setControlledEdges] = useState<Edge[]>(rawEdges)

  // Live decoration — patch state/status/online/servedUrl/model (and the
  // pending-HIL zIndex hop) onto ONLY the nodes whose values actually
  // changed. Every other node keeps identity, so memo(MeshGraphNode) and
  // React Flow's rediff skip them; with nothing stale this bails without a
  // render. Position spreads from prev, so a patch landing mid-drag can
  // never snap a tile back.
  const patchLiveFields = useCallback(() => {
    const byPath = new Map(useMeshStore.getState().agents.map((a) => [a.filePath, a]))
    const pending = useMeshGraphStore.getState().pendingInteractions
    setControlledNodes((prev) => {
      let next: Node[] | null = null
      for (let i = 0; i < prev.length; i++) {
        const n = prev[i]
        if (n.type !== 'meshNode') continue
        const a = byPath.get(n.id)
        const d = n.data as unknown as MeshNodeData
        const wantZ = pending[n.id] ? 100 : undefined
        const dataStale =
          !!a &&
          (d.state !== a.state || d.status !== a.status || d.online !== a.online ||
            d.servedUrl !== a.servedUrl || d.model !== a.model)
        if (!dataStale && n.zIndex === wantZ) continue
        if (!next) next = [...prev]
        next[i] = {
          ...n,
          zIndex: wantZ,
          data: dataStale && a
            ? { ...n.data, state: a.state, status: a.status, online: a.online, servedUrl: a.servedUrl, model: a.model }
            : n.data
        }
      }
      return next ?? prev
    })
  }, [])

  // Layout membership key — memoized via selector so the O(n log n) sort
  // runs per roster change, never per render.
  const layoutKey = useMeshStore((s) => s.agents.map((a) => a.filePath).sort().join('|'))

  useEffect(() => {
    // Never yank a tile out from under the pointer: a poll or activity
    // event landing mid-drag would snap the dragged node back to its
    // layout position. The drop handler resyncs when the drag ends.
    if (dragActiveRef.current) return
    // Preserve selection flags across data refreshes
    setControlledNodes((prev) => {
      const selected = new Set(prev.filter((n) => n.selected).map((n) => n.id))
      return structuralNodes.map((n) => (selected.has(n.id) ? { ...n, selected: true } : n))
    })
    // Live events can land between this memo's build and this commit —
    // reconcile immediately (batched into the same render).
    patchLiveFields()
  }, [structuralNodes, patchLiveFields])

  useEffect(() => {
    setControlledEdges(rawEdges)
  }, [rawEdges])

  // The live-field pipeline: store writes → patch, no render of this tree in
  // between. Transient subscriptions, not selectors — an agent event must
  // reach React Flow through one setControlledNodes, not through a rebuild
  // of this 2400-line component's memos.
  useEffect(() => {
    const unsubMesh = useMeshStore.subscribe((s, prev) => {
      if (s.agents !== prev.agents) patchLiveFields()
    })
    const unsubGraph = useMeshGraphStore.subscribe((s, prev) => {
      if (s.pendingInteractions !== prev.pendingInteractions) patchLiveFields()
    })
    return () => {
      unsubMesh()
      unsubGraph()
    }
  }, [patchLiveFields])

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

  // ---- Drag-to-move, RTS style -------------------------------------------
  // Plain drag re-pins the agent (or every selected agent) with solo pins;
  // ⌥ translates its district RIGIDLY (persisted anchor + member pins);
  // ⌘/Ctrl translates the whole territory (origin + pins). Stations re-pin
  // to the dropped cell. While dragging, the node chrome hides (CSS) and a
  // hex GHOST previews every claimed cell — red when the drop would land on
  // an agent outside the moving set, in which case the drop snaps back.
  type MoveKind = 'agents' | 'district' | 'territory'
  // dragGhost is store state (read only by DragGhostOverlay) — per-frame
  // ghost updates during a drag must not re-render this component.
  const setDragGhost = useCallback((g: { cells: { q: number; r: number }[]; valid: boolean } | null) => {
    useFleetStore.getState().setDragGhost(g)
  }, [])
  const dragActiveRef = useRef(false)
  const dragGhostRaf = useRef(0)

  const cellOfNode = useCallback((n: Node): { q: number; r: number } =>
    pixelToAxialRounded(n.position.x + NODE_WIDTH / 2, n.position.y + NODE_EST_HEIGHT / 2), [])

  const cellOfPath = useCallback((fp: string): { q: number; r: number } | null => {
    const n = layout.nodes.find((x) => x.id === fp && x.type === 'meshNode')
    return n ? cellOfNode(n) : null
  }, [layout, cellOfNode])

  const kindOfEvent = (e: React.MouseEvent): MoveKind =>
    e.metaKey || e.ctrlKey ? 'territory' : e.altKey ? 'district' : 'agents'

  /** The set of agents a move touches: the tile, its selection, its
   *  district, or its whole territory. */
  const moveMembers = useCallback((kind: MoveKind, primary: string, selected?: string[]): string[] => {
    const agents = useMeshStore.getState().agents
    const agent = agents.find((a) => a.filePath === primary)
    if (!agent) return []
    const root = agent.trackedDirRoot ?? ''
    if (kind === 'territory') {
      return agents.filter((m) => (m.trackedDirRoot ?? '') === root).map((m) => m.filePath)
    }
    if (kind === 'district') {
      const dk = districtKeyOf(primary, root)
      return agents
        .filter((m) => (m.trackedDirRoot ?? '') === root && districtKeyOf(m.filePath, root) === dk)
        .map((m) => m.filePath)
    }
    return selected && selected.length > 1 && selected.includes(primary) ? selected : [primary]
  }, [])

  /** Target cells for members shifted by (dq,dr); null for unknown members. */
  const moveTargets = useCallback((members: string[], dq: number, dr: number): { q: number; r: number }[] => {
    const out: { q: number; r: number }[] = []
    for (const fp of members) {
      const c = cellOfPath(fp)
      if (c) out.push({ q: c.q + dq, r: c.r + dr })
    }
    return out
  }, [cellOfPath])

  /** Every target cell must be free or vacated by the moving set itself —
   *  otherwise the whole move is invalid (no half-applied splits). */
  const moveValid = useCallback((members: string[], dq: number, dr: number): boolean => {
    const vacated = new Set<string>()
    const current: { q: number; r: number }[] = []
    for (const fp of members) {
      const c = cellOfPath(fp)
      if (!c) continue
      current.push(c)
      vacated.add(`${c.q},${c.r}`)
    }
    for (const c of current) {
      const t = `${c.q + dq},${c.r + dr}`
      if (occupiedCells.has(t) && !vacated.has(t)) return false
    }
    return true
  }, [cellOfPath, occupiedCells])

  /** Commit a move. Returns false when placement state can't support it. */
  const applyMove = useCallback((kind: MoveKind, primary: string, members: string[], dq: number, dr: number): boolean => {
    const fleet = useFleetStore.getState()
    if (!fleet.placement) return false
    const pins = fleet.placement.cellPins
    const shifted: Record<string, { q: number; r: number; solo?: boolean }> = {}
    for (const fp of members) {
      const p = pins[fp]
      if (p) shifted[fp] = { ...p, q: p.q + dq, r: p.r + dr }
    }
    const agent = useMeshStore.getState().agents.find((a) => a.filePath === primary)
    const root = agent?.trackedDirRoot ?? ''
    if (kind === 'territory') {
      const origin = fleet.placement.regionOrigins[root]
      if (!origin) return false
      fleet.updatePlacement(shifted, { [root]: { q: origin.q + dq, r: origin.r + dr } })
    } else if (kind === 'district') {
      const anchorKey = `${root}::${districtKeyOf(primary, root)}`
      const anchor = fleet.placement.districtAnchors?.[anchorKey]
      if (!anchor) return false
      fleet.updatePlacement(shifted, undefined, { [anchorKey]: { q: anchor.q + dq, r: anchor.r + dr } })
    } else {
      // Every moved agent gets a solo pin on its own dropped cell
      for (const fp of members) {
        const c = cellOfPath(fp)
        if (c) shifted[fp] = { q: c.q + dq, r: c.r + dr, solo: true }
      }
      fleet.updatePlacement(shifted)
    }
    persistFleetMapState()
    return true
  }, [cellOfPath])

  const clearDragUi = useCallback(() => {
    dragActiveRef.current = false
    cancelAnimationFrame(dragGhostRaf.current)
    setDragGhost(null)
  }, [])

  const onNodeDragStart = useCallback(() => {
    dragActiveRef.current = true
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = null
    }
    setHovered((prev) => (prev?.pinned ? prev : null))
  }, [])

  const onNodeDrag = useCallback((event: React.MouseEvent, node: Node, draggedNodes: Node[]) => {
    cancelAnimationFrame(dragGhostRaf.current)
    if (node.type === 'stationNode') {
      const c = pixelToAxialRounded(node.position.x + STATION_W / 2, node.position.y + STATION_H / 2)
      dragGhostRaf.current = requestAnimationFrame(() => setDragGhost({ cells: [c], valid: true }))
      return
    }
    if (node.type !== 'meshNode') return
    const kind = kindOfEvent(event)
    const selected = draggedNodes?.filter((n) => n.type === 'meshNode').map((n) => n.id)
    dragGhostRaf.current = requestAnimationFrame(() => {
      const from = cellOfPath(node.id)
      if (!from) return
      const drop = cellOfNode(node)
      const dq = drop.q - from.q
      const dr = drop.r - from.r
      const members = moveMembers(kind, node.id, selected)
      setDragGhost({ cells: moveTargets(members, dq, dr), valid: moveValid(members, dq, dr) })
    })
  }, [cellOfPath, cellOfNode, moveMembers, moveTargets, moveValid])

  const onNodeDragStop = useCallback((event: React.MouseEvent, node: Node, draggedNodes: Node[]) => {
    clearDragUi()
    const revert = (): void => {
      setControlledNodes((prev) => {
        const selected = new Set(prev.filter((n) => n.selected).map((n) => n.id))
        return structuralNodes.map((n) => (selected.has(n.id) ? { ...n, selected: true } : n))
      })
      // The structural copies were decorated at build time — re-apply any
      // live fields that flipped since (batched into the same render).
      patchLiveFields()
    }
    const fleet = useFleetStore.getState()
    if (!fleet.placement) return revert()

    if (node.type === 'stationNode') {
      const drop = pixelToAxialRounded(node.position.x + STATION_W / 2, node.position.y + STATION_H / 2)
      fleet.updatePlacement({}, undefined, undefined, { [node.id]: drop })
      persistFleetMapState()
      return
    }
    if (node.type !== 'meshNode') return revert()
    const from = cellOfPath(node.id)
    if (!from) return revert()
    const drop = cellOfNode(node)
    if (drop.q === from.q && drop.r === from.r) return revert()
    const dq = drop.q - from.q
    const dr = drop.r - from.r
    const kind = kindOfEvent(event)
    const selected = draggedNodes?.filter((n) => n.type === 'meshNode').map((n) => n.id)
    const members = moveMembers(kind, node.id, selected)
    if (members.length === 0 || !moveValid(members, dq, dr)) {
      // "Can't place there" — the RTS beep, rendered: the red ghost holds
      // for a beat over the rejected cells while the tiles snap back.
      setDragGhost({ cells: moveTargets(members, dq, dr), valid: false })
      window.setTimeout(() => setDragGhost(null), 400)
      return revert()
    }
    if (!applyMove(kind, node.id, members, dq, dr)) return revert()
  }, [clearDragUi, structuralNodes, patchLiveFields, cellOfPath, cellOfNode, moveMembers, moveTargets, moveValid, applyMove, setDragGhost])

  // ---- Click-to-place move mode (More ▾ menu) ----------------------------
  // The command bar arms it; the selection's lead tile becomes the handle.
  // The ghost follows the cursor hex, a click places, Esc cancels.
  const moveRequest = useFleetStore((s) => s.moveMode)
  const [placeMode, setPlaceMode] = useState<{ kind: MoveKind; members: string[]; lead: string } | null>(null)
  useEffect(() => {
    if (!moveRequest) {
      setPlaceMode(null)
      return
    }
    const lead = useFleetStore.getState().selection[0]
    if (!lead) {
      useFleetStore.getState().setMoveMode(null)
      return
    }
    setPlaceMode({ kind: moveRequest.kind, members: moveMembers(moveRequest.kind, lead, useFleetStore.getState().selection), lead })
  }, [moveRequest, moveMembers])

  // Ghost-follows-cursor for click-to-place. cursorCell is store state now,
  // so this subscribes imperatively instead of re-rendering per hex crossed.
  useEffect(() => {
    if (!placeMode) {
      setDragGhost(null)
      return
    }
    const compute = (cursor: { q: number; r: number } | null): void => {
      if (!cursor) return
      const leadCell = cellOfPath(placeMode.lead)
      if (!leadCell) {
        // Lead agent vanished (poll) — a mode with no handle is a trap:
        // the ghost would freeze and clicks would do nothing. Disarm.
        useFleetStore.getState().setMoveMode(null)
        return
      }
      const dq = cursor.q - leadCell.q
      const dr = cursor.r - leadCell.r
      setDragGhost({ cells: moveTargets(placeMode.members, dq, dr), valid: moveValid(placeMode.members, dq, dr) })
    }
    compute(useFleetStore.getState().cursorCell)
    const unsub = useFleetStore.subscribe((s, prev) => {
      if (s.cursorCell !== prev.cursorCell) compute(s.cursorCell)
    })
    return () => {
      unsub()
      setDragGhost(null)
    }
  }, [placeMode, cellOfPath, moveTargets, moveValid, setDragGhost])

  const onPaneClick = useCallback(() => {
    // A click on open ground abandons a pending HIL-modal timer — the user
    // moved on; don't pop a modal at them 300ms later.
    if (hilClickTimerRef.current) {
      clearTimeout(hilClickTimerRef.current)
      hilClickTimerRef.current = null
    }
    const cursor = useFleetStore.getState().cursorCell
    if (!placeMode || !cursor) return
    const leadCell = cellOfPath(placeMode.lead)
    if (!leadCell) {
      useFleetStore.getState().setMoveMode(null)
      return
    }
    const dq = cursor.q - leadCell.q
    const dr = cursor.r - leadCell.r
    if ((dq !== 0 || dr !== 0) && moveValid(placeMode.members, dq, dr)) {
      applyMove(placeMode.kind, placeMode.lead, placeMode.members, dq, dr)
    }
    useFleetStore.getState().setMoveMode(null)
  }, [placeMode, cellOfPath, moveValid, applyMove])

  // Hover preview handlers — 550ms arm delay so sweeping the cursor across
  // the map doesn't strobe cards. Leaving the hex fades on a grace timer,
  // not instantly, so the pointer can travel ONTO the card (which cancels
  // the fade via onPointerStay) — the card is clickable now.
  const cancelHoverClear = useCallback(() => {
    if (hoverClearTimerRef.current) {
      clearTimeout(hoverClearTimerRef.current)
      hoverClearTimerRef.current = null
    }
  }, [])

  const scheduleHoverClear = useCallback(() => {
    cancelHoverClear()
    hoverClearTimerRef.current = setTimeout(() => {
      hoverClearTimerRef.current = null
      setHovered((prev) => (prev?.pinned ? prev : null))
    }, 260)
  }, [cancelHoverClear])

  const onNodeMouseEnter = useCallback((event: React.MouseEvent, node: Node) => {
    if (node.type !== 'meshNode' && node.type !== 'stationNode') return
    // Mid-drag, mid-placement, or mid-pan the cursor is a tool, not an
    // inspector — tiles sliding UNDER a parked cursor must not arm cards
    if (dragActiveRef.current || placeMode || panningRef.current) return
    // Entering through an open say-bubble means reading, not inspecting —
    // no hover card until the pointer leaves the bubble's footprint
    if (overSayBubble(event.clientX, event.clientY)) return
    cancelHoverClear()
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
    const x = event.clientX
    const y = event.clientY
    hoverTimerRef.current = setTimeout(() => {
      if (dragActiveRef.current || panningRef.current) return
      setHovered((prev) => (prev?.pinned ? prev : { filePath: node.id, x, y }))
    }, 550)
  }, [cancelHoverClear, placeMode])

  const onNodeMouseLeave = useCallback(() => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = null
    }
    scheduleHoverClear()
  }, [scheduleHoverClear])

  // Clicking a station pins its card (stations aren't selectable, so a
  // click is otherwise dead); click anywhere on the pane to dismiss.
  // HIL-gated tiles keep the RTS contract — single click just selects —
  // EXCEPT at far zoom, where the approval card isn't rendered and a click
  // would otherwise be dead: there it opens the modal after a beat (the
  // dblclick handler cancels the timer so open-agent still wins). At near
  // zoom the card itself is the modal affordance.
  const hilClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onNodeClick = useCallback((event: React.MouseEvent, node: Node) => {
    if (node.type === 'meshNode') {
      const p = useMeshGraphStore.getState().pendingInteractions[node.id]
      if (p?.type === 'approval' && reactFlow.getViewport().zoom < 0.45) {
        if (hilClickTimerRef.current) clearTimeout(hilClickTimerRef.current)
        hilClickTimerRef.current = setTimeout(() => {
          hilClickTimerRef.current = null
          useFleetStore.getState().setHilModal(node.id)
        }, 300)
      }
      return
    }
    if (node.type !== 'stationNode') return
    // Any station click SELECTS it — every trace and channel link plugged
    // into it lights up, so one click answers "who uses this?"
    useFleetStore.getState().setSelectedStation(node.id)
    // Peer runtimes get the full readout modal (alias, owner, agents,
    // traffic); adapter/web stations pin the stats card (click it for the
    // full readout).
    if (node.id.startsWith('station:peer:')) {
      setHovered(null)
      useFleetStore.getState().setStationReadout(node.id)
      return
    }
    setHovered({ filePath: node.id, x: event.clientX, y: event.clientY, pinned: true })
  }, [reactFlow])

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setControlledEdges((eds) => applyEdgeChanges(changes, eds))
  }, [])

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
    setControlledNodes((nds) => nds.map((n) => {
      if (n.type !== 'meshNode') return n
      const sel = base.has(n.id)
      return (n.selected ?? false) === sel ? n : { ...n, selected: sel }
    }))
    setSelection([...base].sort())
  }, [setSelection])

  // The browser fires `click` independently of the intercepted mousedown —
  // swallow shift-clicks on nodes here too or React Flow re-selects.
  const onClickCapture = useCallback((e: React.MouseEvent) => {
    const nodeEl = (e.target as HTMLElement).closest('.react-flow__node') as HTMLElement | null
    const id = nodeEl?.getAttribute('data-id')
    // Dismiss a pinned station card (and the station's trace highlight) on
    // any click that isn't on a station — selection-on-drag swallows
    // onPaneClick, so this is the reliable path. A station click re-pins
    // right after via onNodeClick (bubble phase). Clicks INSIDE the pinned
    // card land outside .react-flow__node too — don't tear down the card
    // the user is about to click.
    if (!id?.startsWith('station:') && !(e.target as HTMLElement).closest('[data-station-card]')) {
      setHovered((prev) => (prev?.pinned ? null : prev))
      useFleetStore.getState().setSelectedStation(null)
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

  /** Select a set of agents programmatically. RTS rule: selection never
   *  moves the camera unless asked — hotkey recalls pass center:false so
   *  you can command one group while watching another (Space or a
   *  double-tapped digit jumps deliberately). */
  const selectAgents = useCallback((filePaths: string[], opts?: { center?: boolean }) => {
    const wanted = new Set(filePaths)
    // Identity-preserving: only nodes whose selected flag actually flips get
    // a new object — Esc with nothing selected must not re-render the fleet
    setControlledNodes((nds) => nds.map((n) => {
      const sel = wanted.has(n.id)
      return (n.selected ?? false) === sel ? n : { ...n, selected: sel }
    }))
    setSelection([...filePaths].sort())
    if (filePaths.length > 0 && (opts?.center ?? true)) {
      reactFlow.fitView({ nodes: filePaths.map((id) => ({ id })), duration: 300, padding: 0.35 })
    }
  }, [reactFlow, setSelection])

  // RTS semantics: single click only selects (React Flow handles it) so the
  // viewport never jumps; double-click opens the agent + right panel. The
  // panel keeps whatever tab the user was on — only the agent context swaps.
  // ⌘/Ctrl+double-click is the RTS "select all of this type": every agent
  // in the same state joins the selection, camera stays put.
  const onNodeDoubleClick = useCallback((event: React.MouseEvent, node: Node) => {
    const nodeData = node.data as unknown as MeshNodeData
    if (node.type !== 'meshNode' || !nodeData?.filePath) return
    // Double-click wins over the delayed single-click modal
    if (hilClickTimerRef.current) {
      clearTimeout(hilClickTimerRef.current)
      hilClickTimerRef.current = null
    }
    if (event.metaKey || event.ctrlKey) {
      const agents = useMeshStore.getState().agents
      const ref = agents.find((a) => a.filePath === nodeData.filePath)
      if (!ref) return
      const same = agents
        .filter((a) => a.online === ref.online && (!ref.online || a.state === ref.state))
        .map((a) => a.filePath)
      selectAgents(same, { center: false })
      return
    }
    openFile(nodeData.filePath)
    revealRightPanel()
  }, [openFile, revealRightPanel, selectAgents])

  // RTS right-click: interact with what you clicked — a right-click on a
  // tile (not a drag; right-DRAG pans) opens the composer addressed to it.
  const onNodeContextMenu = useCallback((event: React.MouseEvent, node: Node) => {
    if (node.type !== 'meshNode') return
    event.preventDefault()
    selectAgents([node.id], { center: false })
    useFleetStore.getState().setComposerOpen(true)
  }, [selectAgents])

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
  const lastRecallRef = useRef<{ digit: string; at: number } | null>(null)
  useEffect(() => {
    const cycle = (key: string, filePaths: string[]) => {
      if (filePaths.length === 0) return
      const next = ((cycleIndexRef.current[key] ?? -1) + 1) % filePaths.length
      cycleIndexRef.current[key] = next
      focusAgent(filePaths[next])
      // Cycling also SELECTS (AoE idle-villager contract): arriving at an
      // agent, your command keys (M/H/G/S) must work immediately. focusAgent
      // already centered the camera, so no second jump.
      selectAgents([filePaths[next]], { center: false })
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e) || e.altKey) return
      const fleet = useFleetStore.getState()

      // Physical digit row (e.code survives Shift — ⇧1 emits key '!')
      const digit = e.code?.startsWith('Digit') ? e.code.slice(5) : ''
      if (digit >= '1' && digit <= '9') {
        if (e.metaKey || e.ctrlKey) {
          if (fleet.selection.length > 0) {
            e.preventDefault()
            fleet.assignControlGroup(digit, fleet.selection)
          }
        } else if (e.shiftKey) {
          // SC2 staple: ⇧# ADDS the selection to the group (⌘# replaces)
          if (fleet.selection.length > 0) {
            e.preventDefault()
            const merged = [...new Set([...(fleet.controlGroups[digit] ?? []), ...fleet.selection])]
            fleet.assignControlGroup(digit, merged)
          }
        } else {
          const group = fleet.controlGroups[digit]
          if (group && group.length > 0) {
            e.preventDefault()
            // StarCraft contract: recall selects WITHOUT moving the camera
            // (command one group while watching another); a double-tap of
            // the same digit jumps to it.
            selectAgents(group, { center: false })
            const now = Date.now()
            const last = lastRecallRef.current
            if (last && last.digit === digit && now - last.at < 450) {
              reactFlow.fitView({ nodes: group.map((id) => ({ id })), duration: 300, padding: 0.35 })
            }
            lastRecallRef.current = { digit, at: now }
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
        void window.adfApi?.setFullscreen?.(!fullscreenRef.current)
      } else if (e.key === 'v' || e.key === 'V') {
        // Voice-chip layer: flips against its effective state (auto = on
        // for terrain, off for diagnostic lenses)
        e.preventDefault()
        const on = fleet.voicesOverride ?? fleet.lens === 'terrain'
        fleet.setVoicesOverride(!on)
      } else if (e.key.startsWith('Arrow')) {
        // RTS camera: arrows pan the map (selection moves via . and ,)
        e.preventDefault()
        const { x, y, zoom } = reactFlow.getViewport()
        const step = 180
        const dx = e.key === 'ArrowLeft' ? step : e.key === 'ArrowRight' ? -step : 0
        const dy = e.key === 'ArrowUp' ? step : e.key === 'ArrowDown' ? -step : 0
        reactFlow.setViewport({ x: x + dx, y: y + dy, zoom }, { duration: 120 })
      } else if (e.key === '+' || e.key === '=' || e.key === '-') {
        // Keyboard zoom for mouse users (wheel pans; pinch/ctrl-scroll zooms)
        e.preventDefault()
        if (e.key === '-') reactFlow.zoomOut({ duration: 120 })
        else reactFlow.zoomIn({ duration: 120 })
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
        // Select the whole standing army — camera stays put (Space jumps)
        e.preventDefault()
        selectAgents(useMeshStore.getState().agents.filter((a) => a.online).map((a) => a.filePath), { center: false })
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
        // RTS Stop reflex: S = Halt (abort the turn + hold) — the unit
        // stays alive. Process SHUTDOWN, the strongest action on the map,
        // moves behind ⇧S so a mashed reflex key can't kill agents.
        const sel = new Set(fleet.selection)
        const online = useMeshStore.getState().agents.filter((a) => sel.has(a.filePath) && a.online)
        if (online.length > 0) {
          e.preventDefault()
          if (e.shiftKey) {
            for (const a of online) window.adfApi.stopBackgroundAgent(a.filePath).catch(() => { /* poll reflects it */ })
          } else {
            window.adfApi.haltFleetAgents(online.map((a) => a.filePath)).catch(() => { /* poll reflects it */ })
          }
        }
      } else if (e.key === '.') {
        e.preventDefault()
        const pendingPaths = Object.keys(graphState.pendingInteractions).sort()
        cycle('pending', pendingPaths)
        // An open approval modal follows the cycle — its content switches
        // to the agent that was just focused
        if (fleet.hilModal && pendingPaths.length > 0) {
          fleet.setHilModal(pendingPaths[cycleIndexRef.current['pending']])
        }
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
        revealRightPanel()
      } else if (e.key === 'i' || e.key === 'I') {
        // Inspect — full agent readout for the focused agent (or the single
        // selected one). Same modal a hover-card click opens.
        const target =
          graphState.focusedFilePath ??
          (fleet.selection.length === 1 ? fleet.selection[0] : null)
        if (target) {
          e.preventDefault()
          fleet.setAgentReadout(target)
        }
      } else if (e.key === 'Escape') {
        // Esc peels layers: founding, move mode, command card, fullscreen,
        // selection. Founding first — its input usually owns Esc, but if
        // focus wandered the card must still close.
        if (foundingRef.current) {
          setFounding(null)
          return
        }
        if (fleet.moveMode) {
          fleet.setMoveMode(null)
          return
        }
        if (shortcutsOpenRef.current) {
          setShortcutsOpen(false)
          return
        }
        if (fullscreenRef.current) {
          void window.adfApi?.setFullscreen?.(false)
          return
        }
        graphState.setFocusedFilePath(null)
        selectAgents([])
        fleet.setSelectedStation(null)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [focusAgent, openFile, revealRightPanel, selectAgents, reactFlow])

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
    <div className="flex relative w-full h-full">
      {/* Map area — every screen-space overlay (header, chips, cards)
          anchors here */}
      <div
        ref={mapRootRef}
        className="relative flex-1 min-w-0 overflow-hidden bg-neutral-50 dark:bg-neutral-950"
        onMouseDownCapture={onMouseDownCapture}
        onClickCapture={onClickCapture}
        onDoubleClick={onCanvasDoubleClick}
        onMouseMove={onCanvasMouseMove}
        onMouseLeave={() => useFleetStore.getState().setCursorCell(null)}
      >
        {/* Top bar — doubles as the window titlebar (drag region + nav) */}
        <FleetTopBar
          onHome={onHome}
          onSettings={onSettings}
          agentCount={agentCount}
          agentCluster={docFilePath ? <AgentTitleCluster onActivate={() => focusAgent(docFilePath)} /> : undefined}
        >
          {/* Deselect — the only way OUT of an open agent used to be opening
              another one. Closes the file: dock + status bar revert to the
              map. Map chrome (?, fullscreen, Log) lives on the map itself,
              in the bottom-left control stack. */}
          {docFilePath && (
            <button
              onClick={() => closeFile()}
              className="p-1 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
              title="Close this agent — the side panel and status bar return to the fleet"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          )}
        </FleetTopBar>

        {/* Alert layer — needs-me queue + fleet state counts + token burn */}
        <FleetAlertBar
          onFocusAgent={focusAgent}
          onSelectGroup={(filePaths) => {
            const known = new Set(useMeshStore.getState().agents.map((a) => a.filePath))
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
        <FleetLensLegend
          foreignHubs={lanPeers.map((p) => ({ runtimeId: p.runtime_id, label: (p.runtime_alias || p.host || p.runtime_id).replace(/\.local\.?$/, '') }))}
        />

        {/* Cursor hex — light outline on the hovered tile, accented on agents */}
        <CursorHexOverlay pendingCells={pendingCells} />
        <DragGhostOverlay />

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
          onNodeContextMenu={onNodeContextMenu}
          onNodeDragStart={onNodeDragStart}
          onNodeDrag={onNodeDrag}
          onNodeDragStop={onNodeDragStop}
          onPaneClick={onPaneClick}
          onMoveStart={beginPanGesture}
          onMoveEnd={endPanGesture}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          nodesDraggable={false}
          selectionOnDrag
          selectionKeyCode={null}
          zoomOnDoubleClick={false}
          panOnDrag={panOnDrag}
          panOnScroll
          zoomOnScroll={false}
          zoomOnPinch
          fitView
          fitViewOptions={fitViewOptions}
          proOptions={proOptions}
          minZoom={0.06}
          maxZoom={2}
          translateExtent={translateExtent}
          className="mesh-graph-flow"
        >
          <MiniMap
            zoomable
            pannable
            position="bottom-right"
            style={miniMapStyle}
            nodeColor={miniMapNodeColor}
            nodeComponent={FleetMiniMapNode}
            bgColor={isDark ? '#171717' : undefined}
            maskColor={isDark ? 'rgba(64, 64, 64, 0.6)' : undefined}
          />
          <HexBackground />
          <FleetGardenLayer />
          <Controls
            position="bottom-left"
            showInteractive={false}
            className="!bg-white dark:!bg-neutral-900 !border-neutral-300 dark:!border-neutral-700 !shadow-sm [&>button]:!bg-white dark:[&>button]:!bg-neutral-900 [&>button]:!border-neutral-300 dark:[&>button]:!border-neutral-700 [&>button>svg]:!fill-neutral-700 dark:[&>button>svg]:!fill-neutral-300"
          >
            {/* Map chrome rides the map, not the agent bar: shortcuts,
                real fullscreen, and the Log drawer join the zoom stack */}
            <ControlButton
              onClick={() => setShortcutsOpen((v) => !v)}
              title="Keyboard commands (?)"
            >
              <span className="text-[13px] font-bold !text-neutral-700 dark:!text-neutral-300">?</span>
            </ControlButton>
            <ControlButton
              onClick={() => void window.adfApi?.setFullscreen?.(!isFullscreen)}
              title={isFullscreen ? 'Exit full screen (F)' : 'Full screen (F)'}
            >
              {isFullscreen ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="!fill-none text-neutral-700 dark:text-neutral-300">
                  <path d="M20 10h-6V4" />
                  <path d="M14 10l7-7" />
                  <path d="M4 14h6v6" />
                  <path d="M10 14l-7 7" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="!fill-none text-neutral-700 dark:text-neutral-300">
                  <path d="M15 3h6v6" />
                  <path d="M21 3l-7 7" />
                  <path d="M9 21H3v-6" />
                  <path d="M3 21l7-7" />
                </svg>
              )}
            </ControlButton>
            <ControlButton
              onClick={() => setShowLogDrawer(!showLogDrawer)}
              title="Fleet log drawer"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className={`!fill-none ${showLogDrawer ? 'text-blue-500' : 'text-neutral-700 dark:text-neutral-300'}`}>
                <polyline points="4 17 10 11 4 5" />
                <line x1="12" y1="19" x2="20" y2="19" />
              </svg>
            </ControlButton>
          </Controls>
        </ReactFlow>

        {/* Ambient fireflies — motes along the lattice, density tracks state */}
        <FleetAmbienceLayer emitters={ambienceEmitters} />
        <FleetVoicesLayer terrains={voiceTerrains} />

        {/* Batch command bar — visible while agents are selected */}
        <FleetCommandBar
          onDone={refreshDebug}
          onOpenAgent={(filePath) => {
            openFile(filePath)
            revealRightPanel()
          }}
          onFlyTo={(filePaths) => {
            reactFlow.fitView({ nodes: filePaths.map((id) => ({ id })), duration: 350, padding: 0.35 })
          }}
        />

        {/* Hover preview — screen-space, readable at any zoom. Yields to an
            open approval/ask card on the same tile — the hover card paints
            above everything and would bury the controls the user must click. */}
        {hovered && !hovered.filePath.startsWith('station:') && !agentReadout && !pendingInteractions[hovered.filePath] && (
          <FleetHoverCard
            filePath={hovered.filePath}
            x={hovered.x}
            y={hovered.y}
            onPointerStay={cancelHoverClear}
            onPointerAway={scheduleHoverClear}
            onInspect={(filePath) => {
              cancelHoverClear()
              setHovered(null)
              setAgentReadout(filePath)
            }}
          />
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
              onPointerStay={cancelHoverClear}
              onPointerAway={scheduleHoverClear}
              onInspect={(stationId) => {
                cancelHoverClear()
                setHovered(null)
                setStationReadout(stationId)
              }}
            />
          )
        })()}

        {/* First-load veil — the world appears whole, never half-built */}
        <FleetLoadingVeil visible={booting} />

        {/* Group readout — full status + cluster vitals for a clicked chip */}
        {readoutDir && (
          <FleetGroupReadout dir={readoutDir} onClose={() => setReadoutDir(null)} onFocusAgent={focusAgent} />
        )}

        {/* Agent readout — full detail for one local agent (card click / I key) */}
        {agentReadout && (
          <FleetAgentReadout
            filePath={agentReadout}
            onClose={() => setAgentReadout(null)}
            onOpenAgent={(filePath) => {
              setAgentReadout(null)
              openFile(filePath)
              revealRightPanel()
            }}
            onFocusAgent={focusAgent}
          />
        )}

        {/* Full-context HIL approval — the map's tool inspector */}
        {hilModal && (
          <FleetApprovalModal
            key={hilModal}
            filePath={hilModal}
            onClose={() => setHilModal(null)}
            onOpenAgent={() => {
              const fp = hilModal
              setHilModal(null)
              openFile(fp)
              revealRightPanel()
            }}
          />
        )}

        {/* Remote runtime readout — clicking a peer station platform */}
        {stationReadout && (() => {
          const n = stationNodes.find((s) => s.id === stationReadout)
          if (!n) return null
          const d = n.data as unknown as StationNodeData
          return (
            <FleetStationReadout
              stationId={n.id}
              data={d}
              onClose={() => setStationReadout(null)}
              onOpenAgent={(agent) =>
                setPeerReadout({ agent, peerHost: d.detail?.host ?? d.label, peerUrl: d.detail?.url, peerSource: d.detail?.source })
              }
              onOpenLocalAgent={(filePath) => {
                // The agent readout mounts EARLIER in this tree — close the
                // station modal so the readout isn't painted underneath it.
                setStationReadout(null)
                setAgentReadout(filePath)
              }}
            />
          )
        })()}

        {/* Remote agent card — hovering a tile on a peer-runtime platform */}
        {peerAgentHover && !peerReadout && (
          <FleetPeerAgentCard
            agent={peerAgentHover.agent}
            peerHost={peerAgentHover.peerHost}
            peerSource={peerAgentHover.peerSource}
            x={peerAgentHover.x}
            y={peerAgentHover.y}
          />
        )}

        {/* Full card readout — clicking a peer-agent tile pins it */}
        {peerReadout && (
          <FleetPeerAgentReadout
            agent={peerReadout.agent}
            peerHost={peerReadout.peerHost}
            peerUrl={peerReadout.peerUrl}
            peerSource={peerReadout.peerSource}
            onClose={() => setPeerReadout(null)}
          />
        )}

        {/* Empty state */}
        {agentCount === 0 && (
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

    </div>
  )
}
