import type { Node, Edge } from '@xyflow/react'
import type { FleetAgentStatus } from '../../../shared/types/ipc.types'
import { resolveLineage, type ResolvedLineage } from '../../../shared/utils/lineage'
import type { MeshNodeData } from './MeshGraphNode'

/**
 * Fleet map layout (milestone 3) — territory map, not a workflow diagram.
 *
 * Geography rules: tracked folders are static territories, subdirectories are
 * districts inside them. Territories shelf-pack into 2D (not a single strip)
 * targeting a landscape aspect. Inside a district, agents sit on a staggered
 * settlement grid — lineage decides *adjacency order* (a parent is placed,
 * then its children next to it), not rigid tree rows; edges are drawn
 * point-to-point by the floating edge renderer and simply follow the layout.
 * Offline on-disk agents ("ghosts") occupy the same geography as running
 * ones. Message traffic never moves a node. All ordering is sorted by path,
 * so positions are deterministic across polls and restarts.
 */

export const NODE_WIDTH = 260
/** Approx rendered card height used for packing math (not enforced as style) */
export const NODE_EST_HEIGHT = 120
const CELL_W = NODE_WIDTH + 80
const CELL_H = 240
const TERRAIN_PADDING = 44
const TERRAIN_HEADER = 34
const TERRAIN_GAP = 90
const SUB_PADDING = 22
const SUB_HEADER = 26
const GROUP_GAP = 48
/** Terrain key for agents outside any tracked directory */
const UNTRACKED = ''

export interface TerrainMember {
  filePath: string
  handle: string
}

export interface TerrainNodeData {
  dirPath: string
  label: string
  agentCount: number
  width: number
  height: number
  /** 'root' = tracked directory, 'sub' = subdirectory district inside it */
  variant: 'root' | 'sub'
  /** Members, for far-zoom summaries (most-active banner, state pips) */
  members: TerrainMember[]
  [key: string]: unknown
}

export interface FleetLayoutResult {
  /** Terrain background nodes first (rendered behind), then agent nodes */
  nodes: Node[]
  /** Dashed org-chart edges from the lineage tree */
  lineageEdges: Edge[]
  lineage: ResolvedLineage
}

/**
 * Order group members so lineage relatives sit adjacent on the grid:
 * DFS from sorted local roots, parent immediately before its children.
 * Cycle leftovers append at the end in path order.
 */
function lineageOrder(members: FleetAgentStatus[], lineage: ResolvedLineage): FleetAgentStatus[] {
  const memberPaths = new Set(members.map((m) => m.filePath))
  const byPath = new Map(members.map((m) => [m.filePath, m]))
  const localChildren = new Map<string, string[]>()
  const localRoots: string[] = []
  for (const m of members) {
    const parent = lineage.parents.get(m.filePath)
    if (parent !== undefined && memberPaths.has(parent)) {
      const siblings = localChildren.get(parent) ?? []
      siblings.push(m.filePath)
      localChildren.set(parent, siblings)
    } else {
      localRoots.push(m.filePath)
    }
  }
  localRoots.sort()
  for (const siblings of localChildren.values()) siblings.sort()

  const ordered: FleetAgentStatus[] = []
  const visited = new Set<string>()
  const walk = (filePath: string) => {
    if (visited.has(filePath)) return
    visited.add(filePath)
    const agent = byPath.get(filePath)
    if (agent) ordered.push(agent)
    for (const kid of localChildren.get(filePath) ?? []) walk(kid)
  }
  for (const root of localRoots) walk(root)
  for (const m of members) {
    if (!visited.has(m.filePath)) ordered.push(m)
  }
  return ordered
}

interface PlacedAgent {
  filePath: string
  x: number
  y: number
}

/** Small stable string hash — deterministic per-agent jitter seed. */
function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0
  }
  return h >>> 0
}

/** Organic placement jitter — same file always lands on the same offset. */
const JITTER_X = 34
const JITTER_Y = 26

/**
 * Settlement grid: members flow into a staggered grid whose column count
 * targets a landscape footprint. Odd rows shift half a cell and every unit
 * gets a deterministic jitter, for the organic units-on-tiles feel instead
 * of a machine-stamped lattice.
 */
function layoutSettlement(ordered: FleetAgentStatus[]): {
  placed: PlacedAgent[]
  width: number
  height: number
} {
  const n = ordered.length
  const cols = Math.max(1, Math.round(Math.sqrt((n * CELL_H) / CELL_W * 1.7)))
  const rows = Math.ceil(n / cols)
  const placed: PlacedAgent[] = []
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / cols)
    const col = i % cols
    const stagger = row % 2 === 1 ? CELL_W / 2 : 0
    const seed = hashString(ordered[i].filePath)
    const jx = ((seed % 1000) / 1000 - 0.5) * 2 * JITTER_X
    const jy = (((seed >> 10) % 1000) / 1000 - 0.5) * 2 * JITTER_Y
    placed.push({
      filePath: ordered[i].filePath,
      x: col * CELL_W + stagger + JITTER_X + jx,
      y: row * CELL_H + JITTER_Y + jy
    })
  }
  const hasStagger = rows > 1 && n > cols
  return {
    placed,
    width: Math.min(n, cols) * CELL_W - (CELL_W - NODE_WIDTH) + (hasStagger ? CELL_W / 2 : 0) + JITTER_X * 2,
    height: (rows - 1) * CELL_H + NODE_EST_HEIGHT + JITTER_Y * 2
  }
}

interface PackItem {
  key: string
  width: number
  height: number
}

interface PackedItem extends PackItem {
  x: number
  y: number
}

/**
 * Shelf-pack items into rows targeting a landscape overall aspect —
 * this is what stops the map collapsing into one long horizontal strip.
 */
function shelfPack(items: PackItem[], gap: number): { packed: PackedItem[]; width: number; height: number } {
  if (items.length === 0) return { packed: [], width: 0, height: 0 }
  const totalArea = items.reduce((a, i) => a + (i.width + gap) * (i.height + gap), 0)
  const widest = items.reduce((w, i) => Math.max(w, i.width), 0)
  const targetWidth = Math.max(widest, Math.sqrt(totalArea * 1.7))

  const packed: PackedItem[] = []
  let x = 0
  let y = 0
  let shelfHeight = 0
  let maxWidth = 0
  for (const item of items) {
    if (x > 0 && x + item.width > targetWidth) {
      x = 0
      y += shelfHeight + gap
      shelfHeight = 0
    }
    packed.push({ ...item, x, y })
    x += item.width + gap
    shelfHeight = Math.max(shelfHeight, item.height)
    maxWidth = Math.max(maxWidth, x - gap)
  }
  return { packed, width: maxWidth, height: y + shelfHeight }
}

/** Path of an agent's directory relative to its terrain root ('' = at the root). */
function relativeDir(agent: FleetAgentStatus, root: string): string {
  if (!root) return ''
  const dir = agent.filePath.slice(0, agent.filePath.lastIndexOf('/'))
  if (dir === root) return ''
  if (dir.startsWith(root + '/')) return dir.slice(root.length + 1)
  return ''
}

function toNodeData(agent: FleetAgentStatus): MeshNodeData {
  return {
    filePath: agent.filePath,
    handle: agent.handle,
    state: agent.state,
    status: agent.status,
    icon: agent.icon,
    model: agent.model,
    online: agent.online
  }
}

const toMembers = (agents: FleetAgentStatus[]): TerrainMember[] =>
  agents.map((a) => ({ filePath: a.filePath, handle: a.handle }))

export function computeFleetLayout(agents: FleetAgentStatus[]): FleetLayoutResult {
  const lineage = resolveLineage(agents)
  const byPath = new Map(agents.map((a) => [a.filePath, a]))

  // Group by tracked dir — sorted keys keep territory order stable across polls
  const regions = new Map<string, FleetAgentStatus[]>()
  for (const agent of agents) {
    const key = agent.trackedDirRoot ?? UNTRACKED
    const members = regions.get(key) ?? []
    members.push(agent)
    regions.set(key, members)
  }
  const regionKeys = [...regions.keys()].sort()

  // Lay out every region's interior first so regions can be shelf-packed by size
  interface RegionPlan {
    dirPath: string
    members: FleetAgentStatus[]
    width: number
    height: number
    // Placement recipes relative to region content origin
    districtRects: { rel: string; x: number; y: number; width: number; height: number; members: FleetAgentStatus[] }[]
    agentPositions: { filePath: string; x: number; y: number }[]
  }

  const plans: RegionPlan[] = []
  for (const dirPath of regionKeys) {
    const members = regions.get(dirPath)!.slice().sort((a, b) => a.filePath.localeCompare(b.filePath))

    // Partition into districts by relative subdirectory; '' (region root) first
    const districts = new Map<string, FleetAgentStatus[]>()
    for (const m of members) {
      const rel = relativeDir(m, dirPath)
      const list = districts.get(rel) ?? []
      list.push(m)
      districts.set(rel, list)
    }
    const districtKeys = [...districts.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))

    // Settle each district's grid, then shelf-pack districts inside the region
    const settlements = new Map<string, ReturnType<typeof layoutSettlement>>()
    const packItems: PackItem[] = []
    for (const rel of districtKeys) {
      const group = districts.get(rel)!
      const settlement = layoutSettlement(lineageOrder(group, lineage))
      settlements.set(rel, settlement)
      const isSub = rel !== ''
      packItems.push({
        key: rel,
        width: settlement.width + (isSub ? SUB_PADDING * 2 : 0),
        height: settlement.height + (isSub ? SUB_PADDING * 2 + SUB_HEADER : 0)
      })
    }
    const { packed, width, height } = shelfPack(packItems, GROUP_GAP)

    const districtRects: RegionPlan['districtRects'] = []
    const agentPositions: RegionPlan['agentPositions'] = []
    for (const item of packed) {
      const rel = item.key
      const settlement = settlements.get(rel)!
      const isSub = rel !== ''
      if (isSub) {
        districtRects.push({
          rel,
          x: item.x,
          y: item.y,
          width: item.width,
          height: item.height,
          members: districts.get(rel)!
        })
      }
      const offsetX = item.x + (isSub ? SUB_PADDING : 0)
      const offsetY = item.y + (isSub ? SUB_PADDING + SUB_HEADER : 0)
      for (const p of settlement.placed) {
        agentPositions.push({ filePath: p.filePath, x: offsetX + p.x, y: offsetY + p.y })
      }
    }

    plans.push({ dirPath, members, width, height, districtRects, agentPositions })
  }

  // Shelf-pack the regions themselves into a 2D map
  const regionPack = shelfPack(
    plans.map((p) => ({
      key: p.dirPath,
      width: p.width + TERRAIN_PADDING * 2,
      height: p.height + TERRAIN_PADDING * 2 + TERRAIN_HEADER
    })),
    TERRAIN_GAP
  )
  const regionOrigin = new Map(regionPack.packed.map((r) => [r.key, { x: r.x, y: r.y, width: r.width, height: r.height }]))

  const nodes: Node[] = []
  const agentNodes: Node[] = []

  for (const plan of plans) {
    const origin = regionOrigin.get(plan.dirPath)!
    const terrainWidth = origin.width
    const terrainHeight = origin.height

    nodes.push({
      id: `terrain:${plan.dirPath || 'untracked'}`,
      type: 'terrainNode',
      position: { x: origin.x, y: origin.y },
      draggable: false,
      selectable: false,
      focusable: false,
      zIndex: -2,
      // Terrain is scenery — let panning/marquee pass through to the canvas
      style: { pointerEvents: 'none' },
      // The graph filters out 'dimensions' changes (re-measure loop workaround),
      // so nodes are never measured — initial dims keep minimap/fitView bounds real
      initialWidth: terrainWidth,
      initialHeight: terrainHeight,
      data: {
        dirPath: plan.dirPath,
        label: plan.dirPath ? plan.dirPath.split('/').filter(Boolean).pop() ?? plan.dirPath : 'Untracked',
        agentCount: plan.members.length,
        width: terrainWidth,
        height: terrainHeight,
        variant: 'root',
        members: toMembers(plan.members)
      } satisfies TerrainNodeData
    })

    const contentX = origin.x + TERRAIN_PADDING
    const contentY = origin.y + TERRAIN_PADDING + TERRAIN_HEADER

    for (const d of plan.districtRects) {
      nodes.push({
        id: `terrain:${plan.dirPath || 'untracked'}/${d.rel}`,
        type: 'terrainNode',
        position: { x: contentX + d.x, y: contentY + d.y },
        draggable: false,
        selectable: false,
        focusable: false,
        zIndex: -1,
        style: { pointerEvents: 'none' },
        initialWidth: d.width,
        initialHeight: d.height,
        data: {
          dirPath: plan.dirPath ? `${plan.dirPath}/${d.rel}` : d.rel,
          label: d.rel,
          agentCount: d.members.length,
          width: d.width,
          height: d.height,
          variant: 'sub',
          members: toMembers(d.members)
        } satisfies TerrainNodeData
      })
    }

    for (const p of plan.agentPositions) {
      const agent = byPath.get(p.filePath)
      if (!agent) continue
      agentNodes.push({
        id: agent.filePath,
        type: 'meshNode',
        position: { x: contentX + p.x, y: contentY + p.y },
        initialWidth: NODE_WIDTH,
        initialHeight: NODE_EST_HEIGHT,
        data: toNodeData(agent)
      })
    }
  }

  nodes.push(...agentNodes)

  const lineageEdges: Edge[] = []
  for (const [child, parent] of lineage.parents) {
    if (!byPath.has(child) || !byPath.has(parent)) continue
    lineageEdges.push({
      id: `lin-${parent}-${child}`,
      source: parent,
      target: child,
      type: 'meshEdge',
      selectable: false,
      data: { edgeType: 'lineage' }
    })
  }

  return { nodes, lineageEdges, lineage }
}
