import type { Node, Edge } from '@xyflow/react'
import type { FleetAgentStatus } from '../../../shared/types/ipc.types'
import { resolveLineage, type ResolvedLineage } from '../../../shared/utils/lineage'
import { pickAgentIcon } from '../../../shared/constants/agent-icons'
import type { MeshNodeData } from './MeshGraphNode'

/**
 * Fleet map layout — a hex world, Civ-style.
 *
 * The whole canvas is one global flat-top hex lattice (the base terrain,
 * drawn by HexBackground). Each tracked folder claims a contiguous cluster
 * of cells: one cell per agent (assigned along a spiral so lineage
 * relatives and same-subfolder agents sit adjacent) plus a ring of padding
 * cells, all tinted with the folder's hue. Subfolder districts are
 * contiguous runs of cells in a shifted shade of the same hue. Region
 * clusters are shelf-packed into 2D and snapped onto the global lattice so
 * every territory tile lines up with the base terrain.
 *
 * Message traffic never moves a cell; agent state lights it up instead.
 */

export const NODE_WIDTH = 260
/** Node footprint spans the hex so marquee/edge anchors match the tile */
export const NODE_EST_HEIGHT = 280

/** Flat-top hexagon circumradius — one agent per cell. */
export const HEX_SIZE = 165
/** Horizontal distance between adjacent columns (flat-top axial). */
export const HEX_COL_W = 1.5 * HEX_SIZE
/** Vertical distance between adjacent rows. */
export const HEX_ROW_H = Math.sqrt(3) * HEX_SIZE

// Must exceed the max snap displacement (±HEX_COL_W per region in x, so 2
// regions can close 2*HEX_COL_W of gap) or lattice snapping could overlap
// two territories that shelfPack placed adjacent.
const TERRAIN_GAP_CELLS = 2.4
/** Terrain key for agents outside any tracked directory */
const UNTRACKED = ''

/** Axial → pixel center (flat-top). */
export function axialToPixel(q: number, r: number): { x: number; y: number } {
  return { x: HEX_COL_W * q, y: HEX_ROW_H * (r + q / 2) }
}

/** Corner points of a flat-top hex centered at (cx, cy), as an SVG polygon string. */
export function hexCorners(cx: number, cy: number, size = HEX_SIZE): string {
  const pts: string[] = []
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i)
    pts.push(`${(cx + size * Math.cos(angle)).toFixed(1)},${(cy + size * Math.sin(angle)).toFixed(1)}`)
  }
  return pts.join(' ')
}

const AXIAL_DIRS: [number, number][] = [
  [1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]
]

/** Spiral of axial coords: center, then rings outward (canonical walk). */
function hexSpiral(count: number): [number, number][] {
  const cells: [number, number][] = [[0, 0]]
  for (let ring = 1; cells.length < count; ring++) {
    // Start at direction 4 scaled by ring, then walk each of the 6 sides
    let q = AXIAL_DIRS[4][0] * ring
    let r = AXIAL_DIRS[4][1] * ring
    for (let side = 0; side < 6; side++) {
      for (let step = 0; step < ring; step++) {
        cells.push([q, r])
        q += AXIAL_DIRS[side][0]
        r += AXIAL_DIRS[side][1]
      }
    }
  }
  return cells
}

export interface TerrainCell {
  q: number
  r: number
  /** Pixel center relative to the terrain node origin */
  x: number
  y: number
  /** Occupying agent, if any (padding cells have none) */
  filePath?: string
  /** Subfolder district this cell belongs to ('' = folder root level) */
  district: string
}

export interface TerrainMember {
  filePath: string
  handle: string
  icon?: string
}

export interface TerrainNodeData {
  dirPath: string
  label: string
  agentCount: number
  width: number
  height: number
  cells: TerrainCell[]
  members: TerrainMember[]
  /** Distinct district names (subfolders) present in this region */
  districts: string[]
  [key: string]: unknown
}

export interface FleetLayoutResult {
  nodes: Node[]
  lineageEdges: Edge[]
  lineage: ResolvedLineage
}

/**
 * Order group members so lineage relatives sit adjacent on the spiral:
 * group by district (root level first), then DFS from sorted local roots
 * within each district.
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

/** Path of an agent's directory relative to its terrain root ('' = at the root). */
function relativeDir(agent: FleetAgentStatus, root: string): string {
  if (!root) return ''
  const dir = agent.filePath.slice(0, agent.filePath.lastIndexOf('/'))
  if (dir === root) return ''
  if (dir.startsWith(root + '/')) return dir.slice(root.length + 1)
  return ''
}

/**
 * Every unit gets an icon: agents created before icon assignment (or with
 * none configured) borrow a deterministic one from the curated pool, seeded
 * by file path so it's stable across sessions without touching the file.
 */
function iconFor(agent: FleetAgentStatus): string {
  return agent.icon || pickAgentIcon(agent.agentId || agent.filePath)
}

function toNodeData(agent: FleetAgentStatus): MeshNodeData {
  return {
    filePath: agent.filePath,
    handle: agent.handle,
    state: agent.state,
    status: agent.status,
    icon: iconFor(agent),
    model: agent.model,
    online: agent.online
  }
}

interface RegionPlan {
  dirPath: string
  members: FleetAgentStatus[]
  cells: TerrainCell[]
  districts: string[]
  /** Bounding box of all cells (pixel, relative to cluster axial origin) */
  minX: number
  minY: number
  width: number
  height: number
  /** Agent pixel centers relative to cluster axial origin */
  agentCenters: Map<string, { x: number; y: number }>
}

/**
 * Build one region's geography. The folder's root-level agents form the main
 * cluster; each subfolder becomes its own satellite mini-cluster, offset on
 * the lattice with a strip of open ocean between it and everything placed
 * before it — districts read as settlements orbiting the capital.
 */
function planRegion(dirPath: string, members: FleetAgentStatus[], lineage: ResolvedLineage): RegionPlan {
  const byDistrict = new Map<string, FleetAgentStatus[]>()
  for (const m of members) {
    const rel = relativeDir(m, dirPath)
    const list = byDistrict.get(rel) ?? []
    list.push(m)
    byDistrict.set(rel, list)
  }
  const districtKeys = [...byDistrict.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))

  // Each district cluster: own spiral of occupied cells + padding ring,
  // in cluster-local axial coordinates.
  const buildCluster = (group: FleetAgentStatus[], district: string): Map<string, TerrainCell> => {
    const orderedAgents = lineageOrder(group, lineage)
    const spiral = hexSpiral(Math.max(orderedAgents.length, 1))
    const cluster = new Map<string, TerrainCell>()
    for (let i = 0; i < orderedAgents.length; i++) {
      const [q, r] = spiral[i]
      cluster.set(`${q},${r}`, { q, r, x: 0, y: 0, filePath: orderedAgents[i].filePath, district })
    }
    for (const cell of [...cluster.values()]) {
      for (const [dq, dr] of AXIAL_DIRS) {
        const key = `${cell.q + dq},${cell.r + dr}`
        if (cluster.has(key)) continue
        cluster.set(key, { q: cell.q + dq, r: cell.r + dr, x: 0, y: 0, district })
      }
    }
    return cluster
  }

  // Place clusters left-to-right with a one-column ocean gap between them.
  const cells = new Map<string, TerrainCell>()
  let maxQ = -Infinity
  for (const key of districtKeys) {
    const cluster = buildCluster(byDistrict.get(key)!, key)
    const localMinQ = Math.min(...[...cluster.values()].map((c) => c.q))
    const q0 = maxQ === -Infinity ? 0 : maxQ - localMinQ + 2
    const r0 = -Math.round(q0 / 2) // keep the chain roughly level vertically
    for (const cell of cluster.values()) {
      const q = cell.q + q0
      const r = cell.r + r0
      const { x, y } = axialToPixel(q, r)
      cells.set(`${q},${r}`, { ...cell, q, r, x, y })
      maxQ = Math.max(maxQ, q)
    }
  }

  const occupied = new Map<string, TerrainCell>()
  for (const [key, cell] of cells) {
    if (cell.filePath) occupied.set(key, cell)
  }

  const all = [...cells.values()]
  const minX = Math.min(...all.map((c) => c.x)) - HEX_SIZE
  const maxX = Math.max(...all.map((c) => c.x)) + HEX_SIZE
  const minY = Math.min(...all.map((c) => c.y)) - HEX_ROW_H / 2
  const maxY = Math.max(...all.map((c) => c.y)) + HEX_ROW_H / 2

  const agentCenters = new Map<string, { x: number; y: number }>()
  for (const cell of occupied.values()) {
    if (cell.filePath) agentCenters.set(cell.filePath, { x: cell.x, y: cell.y })
  }

  return {
    dirPath,
    members,
    cells: all,
    districts: districtKeys.filter((k) => k !== ''),
    minX,
    minY,
    width: maxX - minX,
    height: maxY - minY,
    agentCenters
  }
}

interface PackItem {
  key: string
  width: number
  height: number
}

/** Shelf-pack items into rows targeting a landscape overall aspect. */
function shelfPack(items: PackItem[], gap: number): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>()
  if (items.length === 0) return out
  const totalArea = items.reduce((a, i) => a + (i.width + gap) * (i.height + gap), 0)
  const widest = items.reduce((w, i) => Math.max(w, i.width), 0)
  const targetWidth = Math.max(widest, Math.sqrt(totalArea * 1.7))

  let x = 0
  let y = 0
  let shelfHeight = 0
  for (const item of items) {
    if (x > 0 && x + item.width > targetWidth) {
      x = 0
      y += shelfHeight + gap
      shelfHeight = 0
    }
    out.set(item.key, { x, y })
    x += item.width + gap
    shelfHeight = Math.max(shelfHeight, item.height)
  }
  return out
}

/**
 * Snap a pixel offset onto the global hex lattice (even column) so every
 * region's cells align with the base terrain grid.
 */
function snapToLattice(x: number, y: number): { x: number; y: number } {
  const q = 2 * Math.round(x / (2 * HEX_COL_W))
  const r = Math.round(y / HEX_ROW_H - q / 2)
  return axialToPixel(q, r)
}

export function computeFleetLayout(agents: FleetAgentStatus[]): FleetLayoutResult {
  const lineage = resolveLineage(agents)
  const byPath = new Map(agents.map((a) => [a.filePath, a]))

  const regions = new Map<string, FleetAgentStatus[]>()
  for (const agent of agents) {
    const key = agent.trackedDirRoot ?? UNTRACKED
    const members = regions.get(key) ?? []
    members.push(agent)
    regions.set(key, members)
  }
  const regionKeys = [...regions.keys()].sort()

  const plans = regionKeys.map((dirPath) =>
    planRegion(dirPath, regions.get(dirPath)!.slice().sort((a, b) => a.filePath.localeCompare(b.filePath)), lineage)
  )

  const gap = TERRAIN_GAP_CELLS * HEX_COL_W
  const packed = shelfPack(
    plans.map((p) => ({ key: p.dirPath, width: p.width, height: p.height })),
    gap
  )

  const nodes: Node[] = []
  const agentNodes: Node[] = []

  for (const plan of plans) {
    const slot = packed.get(plan.dirPath)!
    // Cluster axial-origin position, snapped to the global lattice
    const origin = snapToLattice(slot.x - plan.minX, slot.y - plan.minY)
    const nodeX = origin.x + plan.minX
    const nodeY = origin.y + plan.minY

    nodes.push({
      id: `terrain:${plan.dirPath || 'untracked'}`,
      type: 'terrainNode',
      position: { x: nodeX, y: nodeY },
      draggable: false,
      selectable: false,
      focusable: false,
      zIndex: -1,
      // Terrain is scenery — let panning/marquee pass through to the canvas
      style: { pointerEvents: 'none' },
      // The graph filters out 'dimensions' changes (re-measure loop workaround),
      // so nodes are never measured — initial dims keep minimap/fitView bounds real
      initialWidth: plan.width,
      initialHeight: plan.height,
      data: {
        dirPath: plan.dirPath,
        label: plan.dirPath ? plan.dirPath.split('/').filter(Boolean).pop() ?? plan.dirPath : 'Untracked',
        agentCount: plan.members.length,
        width: plan.width,
        height: plan.height,
        // Cell coords relative to the terrain node's top-left
        cells: plan.cells.map((c) => ({ ...c, x: c.x - plan.minX, y: c.y - plan.minY })),
        members: plan.members.map((m) => ({ filePath: m.filePath, handle: m.handle, icon: iconFor(m) })),
        districts: plan.districts
      } satisfies TerrainNodeData
    })

    for (const [filePath, center] of plan.agentCenters) {
      const agent = byPath.get(filePath)
      if (!agent) continue
      agentNodes.push({
        id: agent.filePath,
        type: 'meshNode',
        position: {
          x: nodeX + (center.x - plan.minX) - NODE_WIDTH / 2,
          y: nodeY + (center.y - plan.minY) - NODE_EST_HEIGHT / 2
        },
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
