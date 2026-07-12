import { useMemo, useCallback, useEffect, useState, useRef } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  MiniMap,
  Controls,
  Background,
  BackgroundVariant,
  useReactFlow,
  type Node,
  type Edge,
  type NodeChange,
  type EdgeChange,
  applyNodeChanges,
  applyEdgeChanges
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { MeshGraphNode, type MeshNodeData } from './MeshGraphNode'
import { MeshGraphEdge } from './MeshGraphEdge'
import { MeshLogDrawer } from './MeshLogDrawer'
import { FleetTerrainNode } from './FleetTerrainNode'
import { FleetAlertBar } from './FleetAlertBar'
import { computeFleetLayout, NODE_WIDTH } from './fleet-layout'
import { useMeshGraph } from '../../hooks/useMeshGraph'
import { useMeshGraphStore, type PendingInteraction } from '../../stores/mesh-graph.store'
import { useMeshStore } from '../../stores/mesh.store'
import { useMesh } from '../../hooks/useMesh'
import { useAppStore } from '../../stores/app.store'
import { useAdfFile } from '../../hooks/useAdfFile'
import type { MeshAgentStatus, MeshDebugInfo } from '../../../shared/types/ipc.types'

const nodeTypes = { meshNode: MeshGraphNode, terrainNode: FleetTerrainNode }
const edgeTypes = { meshEdge: MeshGraphEdge }

function buildEdges(
  agents: MeshAgentStatus[],
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

  // Live routes from message_routed events (instant edges for animations)
  for (const route of Object.values(liveRoutes)) {
    if (!agentPaths.has(route.from) || !agentPaths.has(route.to)) continue
    const key = `${route.from}-${route.to}`
    if (edgeSet.has(key)) continue
    edgeSet.add(key)
    edges.push({
      id: `msg-${key}`,
      source: route.from,
      target: route.to,
      type: 'meshEdge',
      data: { edgeType: 'message' }
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
        const key = `${sourcePath}-${targetPath}`
        if (edgeSet.has(key)) continue
        edgeSet.add(key)
        edges.push({
          id: `msg-${key}`,
          source: sourcePath,
          target: targetPath,
          type: 'meshEdge',
          data: { edgeType: 'message', channel: entry.channel }
        })
      }
    }
  }

  return edges
}

export function MeshGraphView() {
  const meshEnabled = useMeshStore((s) => s.enabled)
  const { enableMesh } = useMesh()
  const setShowMeshGraph = useAppStore((s) => s.setShowMeshGraph)
  const resetStore = useMeshGraphStore((s) => s.reset)

  const handleClose = useCallback(() => {
    resetStore()
    setShowMeshGraph(false)
  }, [resetStore, setShowMeshGraph])

  if (!meshEnabled) {
    return (
      <div className="relative w-full h-full bg-neutral-50 dark:bg-neutral-950">
        {/* Top bar */}
        <div className="absolute top-0 left-0 right-0 z-10 flex items-center justify-between px-4 py-2 bg-white/80 dark:bg-neutral-900/80 backdrop-blur-sm border-b border-neutral-200 dark:border-neutral-800">
          <div className="flex items-center gap-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-neutral-500">
              <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
            </svg>
            <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">Fleet Map</span>
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
              <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
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

/** True when a keyboard event originates from a text-entry element. */
function isTypingTarget(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null
  if (!el) return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable
}

function MeshGraphCanvas({ onClose }: { onClose: () => void }) {
  // Subscribe to mesh graph events
  useMeshGraph()

  const meshAgents = useMeshStore((s) => s.agents)
  const setAgents = useMeshStore((s) => s.setAgents)
  const showLogDrawer = useMeshGraphStore((s) => s.showLogDrawer)
  const setShowLogDrawer = useMeshGraphStore((s) => s.setShowLogDrawer)
  const setAllPendingInteractions = useMeshGraphStore((s) => s.setAllPendingInteractions)
  const setFocusedFilePath = useMeshGraphStore((s) => s.setFocusedFilePath)
  const expandRightPanelToTab = useAppStore((s) => s.expandRightPanelToTab)
  const { openFile } = useAdfFile()
  const reactFlow = useReactFlow()

  const seedActivities = useMeshGraphStore((s) => s.seedActivities)
  const [debugInfo, setDebugInfo] = useState<MeshDebugInfo | null>(null)
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // User-dragged position overrides (filePath → position)
  const draggedPositions = useRef<Map<string, { x: number; y: number }>>(new Map())

  // Single debug poll — shared with MeshLogDrawer; also refreshes agent status
  // and reconciles pending HIL interactions from the executors' snapshot.
  const refreshDebug = useCallback(async () => {
    try {
      const [info, meshStatus, pendingList] = await Promise.all([
        window.adfApi.getMeshDebug(),
        window.adfApi.getMeshStatus(),
        window.adfApi.getMeshPendingInteractions()
      ])
      setDebugInfo(info)
      if (meshStatus.agents.length > 0) setAgents(meshStatus.agents)
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
  }, [setAgents, setAllPendingInteractions])

  useEffect(() => {
    refreshDebug()
    refreshTimerRef.current = setInterval(refreshDebug, 5000)
    return () => {
      if (refreshTimerRef.current) clearInterval(refreshTimerRef.current)
    }
  }, [refreshDebug])

  // Live routes from message_routed events (ensures edges exist for animations)
  const liveRoutes = useMeshGraphStore((s) => s.liveRoutes)

  // Message edges — merge debug-polled message log with live routes
  const messageEdges = useMemo(() => buildEdges(meshAgents, debugInfo, liveRoutes), [meshAgents, debugInfo, liveRoutes])

  // Fleet layout — tracked-dir terrain regions + parent_did lineage trees.
  // Positions are deterministic (regions and siblings sorted by path).
  const layout = useMemo(() => computeFleetLayout(meshAgents), [meshAgents])

  const nodes = useMemo(() => {
    return layout.nodes.map((node) => {
      const dragged = draggedPositions.current.get(node.id)
      return dragged ? { ...node, position: dragged } : node
    })
  }, [layout])

  const rawEdges = useMemo(() => [...layout.lineageEdges, ...messageEdges], [layout, messageEdges])

  // Use a stable state for nodes that allows drag updates
  const [controlledNodes, setControlledNodes] = useState<Node[]>(nodes)
  const [controlledEdges, setControlledEdges] = useState<Edge[]>(rawEdges)

  // Track prev layout key to know when layout should override dragged positions
  const prevLayoutKeyRef = useRef('')
  const layoutKey = meshAgents.map((a) => a.filePath).sort().join('|')

  useEffect(() => {
    // When agents change, clear dragged positions and re-layout
    if (layoutKey !== prevLayoutKeyRef.current) {
      draggedPositions.current.clear()
      prevLayoutKeyRef.current = layoutKey
    }
    setControlledNodes(nodes)
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
    // Track user drags
    for (const change of filtered) {
      if (change.type === 'position' && change.position && change.dragging) {
        draggedPositions.current.set(change.id, change.position)
      }
    }
    setControlledNodes((nds) => applyNodeChanges(filtered, nds))
  }, [])

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setControlledEdges((eds) => applyEdgeChanges(changes, eds))
  }, [])

  const onNodeClick = useCallback((_event: React.MouseEvent, node: Node) => {
    const nodeData = node.data as unknown as MeshNodeData
    if (node.type === 'meshNode' && nodeData?.filePath) {
      openFile(nodeData.filePath)
      expandRightPanelToTab('loop')
    }
  }, [openFile, expandRightPanelToTab])

  // Center the viewport on an agent and highlight it
  const focusAgent = useCallback((filePath: string) => {
    const node = reactFlow.getNode(filePath)
    if (!node) return
    setFocusedFilePath(filePath)
    reactFlow.setCenter(node.position.x + NODE_WIDTH / 2, node.position.y + 80, {
      zoom: 1,
      duration: 400
    })
  }, [reactFlow, setFocusedFilePath])

  // Hotkey cycling — `.` = next agent awaiting input, `,` = next idle agent
  // (the RTS idle-worker key), Enter = open focused agent, Escape = clear.
  const cycleIndexRef = useRef<Record<string, number>>({})
  useEffect(() => {
    const cycle = (key: string, filePaths: string[]) => {
      if (filePaths.length === 0) return
      const next = ((cycleIndexRef.current[key] ?? -1) + 1) % filePaths.length
      cycleIndexRef.current[key] = next
      focusAgent(filePaths[next])
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e) || e.metaKey || e.ctrlKey || e.altKey) return
      const graphState = useMeshGraphStore.getState()
      if (e.key === '.') {
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
        graphState.setFocusedFilePath(null)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [focusAgent, openFile, expandRightPanelToTab])

  // MiniMap colors — needs-input beats state so alerts stay visible zoomed out
  const miniMapNodeColor = useCallback((node: Node) => {
    if (node.type === 'terrainNode') return 'transparent'
    const data = node.data as unknown as MeshNodeData
    if (data?.filePath && useMeshGraphStore.getState().pendingInteractions[data.filePath]) return '#f59e0b'
    if (data?.state === 'active') return '#facc15'
    if (data?.state === 'idle') return '#4ade80'
    if (data?.state === 'error') return '#f87171'
    return '#94a3b8'
  }, [])

  return (
    <div className="relative w-full h-full bg-neutral-50 dark:bg-neutral-950">
      {/* Top bar */}
      <div className="absolute top-0 left-0 right-0 z-10 flex items-center justify-between px-4 py-2 bg-white/80 dark:bg-neutral-900/80 backdrop-blur-sm border-b border-neutral-200 dark:border-neutral-800">
        <div className="flex items-center gap-2">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-neutral-500">
            <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
          </svg>
          <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">Fleet Map</span>
          <span className="text-xs text-neutral-400 dark:text-neutral-500">
            {meshAgents.length} agent{meshAgents.length !== 1 ? 's' : ''}
          </span>
        </div>
        <div className="flex items-center gap-2">
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

      {/* Alert layer — needs-me queue + fleet state counts */}
      <FleetAlertBar onFocusAgent={focusAgent} />

      {/* React Flow canvas */}
      <ReactFlow
        nodes={controlledNodes}
        edges={controlledEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        proOptions={{ hideAttribution: true }}
        minZoom={0.2}
        maxZoom={2}
        className="mesh-graph-flow"
      >
        <MiniMap
          zoomable
          pannable
          position="bottom-right"
          style={{ width: 140, height: 90 }}
          nodeColor={miniMapNodeColor}
        />
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#d4d4d4" className="dark:!bg-neutral-950 [&>pattern>circle]:dark:!fill-neutral-800" />
        <Controls position="bottom-left" showInteractive={false} className="!bg-white !border-neutral-300 !shadow-sm [&>button]:!bg-white [&>button]:!border-neutral-300 [&>button>svg]:!fill-neutral-700" />
      </ReactFlow>

      {/* Empty state */}
      {meshAgents.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="text-center">
            <p className="text-sm text-neutral-400 dark:text-neutral-500">No mesh agents active</p>
            <p className="text-xs text-neutral-300 dark:text-neutral-600 mt-1">Start agents in tracked directories to see them here</p>
          </div>
        </div>
      )}

      {/* Log drawer — shares debugInfo from single poll */}
      <MeshLogDrawer debugInfo={debugInfo} onRefresh={refreshDebug} />
    </div>
  )
}
