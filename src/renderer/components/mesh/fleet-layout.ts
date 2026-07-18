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

/**
 * Separator-agnostic path helpers. Windows runtimes report native backslash
 * paths (local agents AND peer directories), so any slice on '/' alone
 * silently fails there — districts collapse into the capital and territory
 * labels show the whole drive path. POSIX paths (macOS/Linux) may legally
 * contain a literal backslash inside a name, so '\' only counts as the
 * separator when the path has no '/' at all.
 */
const sepOf = (p: string): '/' | '\\' => (!p.includes('/') && p.includes('\\') ? '\\' : '/')

export const pathSegments = (p: string): string[] => p.split(sepOf(p)).filter(Boolean)

export const pathBasename = (p: string): string => pathSegments(p).pop() ?? p

export function pathDirname(p: string): string {
  const i = p.lastIndexOf(sepOf(p))
  return i > 0 ? p.slice(0, i) : ''
}

/** True if `p` sits strictly under directory `root` (either separator). */
export const isUnder = (p: string, root: string): boolean =>
  p.startsWith(root + '/') || p.startsWith(root + '\\')

/** Join a directory and a relative child using the dir's native separator. */
export const joinDir = (dir: string, child: string): string => dir + sepOf(dir) + child

/** Axial → pixel center (flat-top). */
export function axialToPixel(q: number, r: number): { x: number; y: number } {
  return { x: HEX_COL_W * q, y: HEX_ROW_H * (r + q / 2) }
}

/**
 * Pixel → axial with proper cube rounding — accurate hex hit-testing near
 * cell borders (the naive round-q-then-r shortcut misassigns edge zones).
 */
export function pixelToAxialRounded(x: number, y: number): { q: number; r: number } {
  const qf = x / HEX_COL_W
  const rf = y / HEX_ROW_H - qf / 2
  const sf = -qf - rf
  let q = Math.round(qf)
  let r = Math.round(rf)
  const s = Math.round(sf)
  const dq = Math.abs(q - qf)
  const dr = Math.abs(r - rf)
  const ds = Math.abs(s - sf)
  if (dq > dr && dq > ds) q = -r - s
  else if (dr > ds) r = -q - s
  return { q, r }
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
export function hexSpiral(count: number): [number, number][] {
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

/**
 * Outline of a hex-cell cluster: 'M x y L x y' segments for every edge NOT
 * shared with another cell in the set. Stroked darker than the interior
 * lattice, it gives a settlement a Civ-style silhouette. Cells must carry
 * axial (q,r) in the SAME frame plus their pixel centers (x,y).
 */
export function hexBoundaryPath(cells: { q: number; r: number; x: number; y: number }[], radius: number): string {
  // Neighbor delta faced by the edge between corners k and k+1 (flat-top)
  const EDGE_NEIGHBORS: [number, number][] = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]]
  const set = new Set(cells.map((c) => `${c.q},${c.r}`))
  const parts: string[] = []
  for (const c of cells) {
    for (let k = 0; k < 6; k++) {
      const [dq, dr] = EDGE_NEIGHBORS[k]
      if (set.has(`${c.q + dq},${c.r + dr}`)) continue
      const a1 = (k * Math.PI) / 3
      const a2 = ((k + 1) * Math.PI) / 3
      parts.push(
        `M ${c.x + radius * Math.cos(a1)} ${c.y + radius * Math.sin(a1)} L ${c.x + radius * Math.cos(a2)} ${c.y + radius * Math.sin(a2)}`
      )
    }
  }
  return parts.join(' ')
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

export interface AxialCoord {
  q: number
  r: number
}

/**
 * A user-chosen cell. Plain pins (founding, district/territory moves) also
 * serve as their district's ANCHOR — the whole plot arranges around them.
 * `solo` pins (dragging one tile) move ONLY that agent: they're honored in
 * the pin-enforcement pass but never steer a district or region origin.
 */
export interface CellPin extends AxialCoord {
  solo?: boolean
}

/**
 * Frozen geography. `regionOrigins` remembers where each region's cluster
 * origin (local axial 0,0) sits on the WORLD lattice — once recorded, a
 * region never moves because a neighbor grew. `districtAnchors` does the
 * same one level down: each district's CLUSTER-LOCAL anchor, keyed
 * `${regionDir}::${district}` — so moving (or growing) one district never
 * re-packs its siblings. `cellPins` remembers the world cell the user
 * founded (or dragged) an agent to — that agent keeps its hex.
 * Persisted in settings (`fleetMapState.placement`), survives sessions.
 */
export interface FleetPlacement {
  regionOrigins: Record<string, AxialCoord>
  cellPins: Record<string, CellPin>
  districtAnchors?: Record<string, AxialCoord>
  /** World cell a station (peer runtime, adapter, gateway) sits on — keyed
   *  by station node id. `auto` marks a frozen auto-slot (recorded on first
   *  render so stations never wander when agents move); a user drag writes
   *  the pin without the flag, and explicit pins outrank auto ones when two
   *  stations contest the same ground. */
  stationPins?: Record<string, AxialCoord & { auto?: boolean }>
}

export interface FleetLayoutResult {
  nodes: Node[]
  lineageEdges: Edge[]
  lineage: ResolvedLineage
  /** World origin actually used for every region this pass — the caller
   *  merges these back into placement so the geography freezes. */
  regionOrigins: Record<string, AxialCoord>
  /** Cluster-local anchor every district used, keyed `${regionDir}::${district}` —
   *  merged back into placement so sibling districts never re-pack. */
  districtAnchors: Record<string, AxialCoord>
}

/**
 * Order group members so lineage relatives sit adjacent on the spiral:
 * group by district (root level first), then DFS from sorted local roots
 * within each district.
 *
 * Roots and siblings sort by creation time (path as tiebreak/fallback), so
 * a newly created agent takes the spiral's TAIL cell and every existing
 * agent keeps its hex — growth appears at the edge instead of reshuffling
 * the cluster. Still deterministic: adf_created_at travels with the file.
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
  const byCreation = (a: string, b: string): number => {
    const ca = byPath.get(a)?.createdAt ?? ''
    const cb = byPath.get(b)?.createdAt ?? ''
    return ca < cb ? -1 : ca > cb ? 1 : a < b ? -1 : a > b ? 1 : 0
  }
  localRoots.sort(byCreation)
  for (const siblings of localChildren.values()) siblings.sort(byCreation)

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

/** District key of an agent file within its region root ('' = capital) —
 *  the SAME grouping planRegion uses, exported for the drag handlers. */
export function districtKeyOf(filePath: string, root: string): string {
  if (!root) return ''
  const dir = pathDirname(filePath)
  if (dir === root) return ''
  if (isUnder(dir, root)) return dir.slice(root.length + 1)
  return ''
}

/** Path of an agent's directory relative to its terrain root ('' = at the root). */
function relativeDir(agent: FleetAgentStatus, root: string): string {
  return districtKeyOf(agent.filePath, root)
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
    online: agent.online,
    servedUrl: agent.servedUrl
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
  /** Cluster-local anchor each district actually used this pass */
  anchors: Record<string, AxialCoord>
}

/** Axial hex distance. */
export function hexDistance(aq: number, ar: number, bq: number, br: number): number {
  const dq = aq - bq
  const dr = ar - br
  return (Math.abs(dq) + Math.abs(dq + dr) + Math.abs(dr)) / 2
}

/**
 * Build one region's geography. The folder's root-level agents form the
 * capital cluster; each subfolder district packs radially around it as a
 * distinct plot on the SAME landmass — occupied cells of different
 * districts stay ≥2 apart (so at least one blank buffer cell separates
 * them) while their padding rings merge into one contiguous territory.
 *
 * `localPins` (member filePath → CLUSTER-LOCAL axial) are user-chosen
 * founding cells: a pinned district anchors so its pinned founder lands
 * exactly there, and a pin-enforcement pass swaps any remaining pinned
 * member onto its cell. The user's click outranks the spiral.
 */
function planRegion(
  dirPath: string,
  members: FleetAgentStatus[],
  lineage: ResolvedLineage,
  localPins?: Map<string, CellPin>,
  rememberedAnchors?: Record<string, AxialCoord>
): RegionPlan {
  const byDistrict = new Map<string, FleetAgentStatus[]>()
  for (const m of members) {
    const rel = relativeDir(m, dirPath)
    const list = byDistrict.get(rel) ?? []
    list.push(m)
    byDistrict.set(rel, list)
  }
  // Capital first, then districts by SENIORITY (earliest member creation):
  // anchors are claimed in founding order and kept, so a district growing
  // past a sibling doesn't flip their placement order and swap their plots.
  // (Size-first packed tighter but reshuffled on every growth spurt.)
  const minCreated = (key: string): string =>
    byDistrict.get(key)!.reduce((min, m) => (m.createdAt && (!min || m.createdAt < min) ? m.createdAt : min), '')
  const districtKeys = [...byDistrict.keys()].sort((a, b) => {
    if (a === '') return -1
    if (b === '') return 1
    const ca = minCreated(a)
    const cb = minCreated(b)
    if (ca !== cb) return ca < cb ? -1 : 1
    return a.localeCompare(b)
  })

  /** Occupied cells for a district, in cluster-local axial coords. */
  const buildOccupied = (group: FleetAgentStatus[], district: string): TerrainCell[] => {
    const orderedAgents = lineageOrder(group, lineage)
    const spiral = hexSpiral(Math.max(orderedAgents.length, 1))
    return orderedAgents.map((agent, i) => ({
      q: spiral[i][0], r: spiral[i][1], x: 0, y: 0, filePath: agent.filePath, district
    }))
  }

  const placedOccupied: TerrainCell[] = []
  const cells = new Map<string, TerrainCell>()

  // Candidate anchor offsets, walked outward from the capital — first offset
  // that keeps a one-cell buffer to everything already placed wins, which
  // packs districts in a ring around the capital instead of a strip.
  const candidates = hexSpiral(600)

  const usedAnchors: Record<string, AxialCoord> = {}
  for (const key of districtKeys) {
    const occupied = buildOccupied(byDistrict.get(key)!, key)

    let dq0 = 0
    let dr0 = 0
    let anchored = false
    // A remembered anchor wins outright: districts keep their plot no
    // matter how siblings move or grow. Only a hard cell-for-cell overlap
    // (an earlier district grew into it) forces a re-scan.
    const remembered = rememberedAnchors?.[key]
    if (remembered) {
      if (occupied.every((c) => !cells.has(`${c.q + remembered.q},${c.r + remembered.r}`))) {
        dq0 = remembered.q
        dr0 = remembered.r
        anchored = true
      }
    }
    // A district with a pinned member anchors on the pin: offset so that
    // member's spiral cell lands on its chosen cell (founder = spiral[0], so
    // an ocean-founded group grows around the clicked hex). Only taken when
    // it doesn't collide with an already-placed district cell-for-cell —
    // buffer niceties yield to the user's choice, hard overlap does not.
    if (!anchored && localPins) {
      // Solo pins (single-tile drags) never anchor — only founding/move pins
      // steer where the whole plot sits.
      const pinned = occupied.find((c) => c.filePath && localPins.has(c.filePath) && !localPins.get(c.filePath)!.solo)
      if (pinned) {
        const pin = localPins.get(pinned.filePath!)!
        const aq = pin.q - pinned.q
        const ar = pin.r - pinned.r
        if (occupied.every((c) => !cells.has(`${c.q + aq},${c.r + ar}`))) {
          dq0 = aq
          dr0 = ar
          anchored = true
        }
      }
    }
    if (!anchored && placedOccupied.length > 0) {
      for (const [cq, cr] of candidates) {
        let minDist = Infinity
        for (const cell of occupied) {
          for (const placed of placedOccupied) {
            const d = hexDistance(cell.q + cq, cell.r + cr, placed.q, placed.r)
            if (d < minDist) minDist = d
            if (minDist < 2) break
          }
          if (minDist < 2) break
        }
        // ≥2: at least one blank cell between foreign agents.
        // ≤3: padding rings still overlap/touch — one landmass, no ocean.
        if (minDist >= 2 && minDist <= 3) {
          dq0 = cq
          dr0 = cr
          break
        }
      }
    }

    usedAnchors[key] = { q: dq0, r: dr0 }
    for (const cell of occupied) {
      const q = cell.q + dq0
      const r = cell.r + dr0
      const { x, y } = axialToPixel(q, r)
      const placed = { ...cell, q, r, x, y }
      placedOccupied.push(placed)
      cells.set(`${q},${r}`, placed)
    }
  }

  // Pin enforcement — any pinned member not already on its cell moves there;
  // an unpinned occupant of that cell takes the mover's old hex (swap). A
  // cell held by another PINNED member stays put (first pin wins).
  if (localPins) {
    for (const [fp, pin] of localPins) {
      const cur = placedOccupied.find((c) => c.filePath === fp)
      if (!cur || (cur.q === pin.q && cur.r === pin.r)) continue
      const occupant = cells.get(`${pin.q},${pin.r}`)
      if (occupant?.filePath && localPins.has(occupant.filePath)) continue
      cells.delete(`${cur.q},${cur.r}`)
      if (occupant) {
        occupant.q = cur.q
        occupant.r = cur.r
        const op = axialToPixel(cur.q, cur.r)
        occupant.x = op.x
        occupant.y = op.y
        cells.set(`${occupant.q},${occupant.r}`, occupant)
      }
      cur.q = pin.q
      cur.r = pin.r
      const cp = axialToPixel(pin.q, pin.r)
      cur.x = cp.x
      cur.y = cp.y
      cells.set(`${pin.q},${pin.r}`, cur)
    }
  }

  // Padding ring around every occupied cell — buffer cells between districts
  // become shared land, welding the plots into one territory.
  for (const cell of placedOccupied) {
    for (const [dq, dr] of AXIAL_DIRS) {
      const key = `${cell.q + dq},${cell.r + dr}`
      if (cells.has(key)) continue
      const { x, y } = axialToPixel(cell.q + dq, cell.r + dr)
      cells.set(key, { q: cell.q + dq, r: cell.r + dr, x, y, district: cell.district })
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
    agentCenters,
    anchors: usedAnchors
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

export function computeFleetLayout(agents: FleetAgentStatus[], placement?: FleetPlacement): FleetLayoutResult {
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

  const remembered = placement?.regionOrigins ?? {}
  const pins = placement?.cellPins ?? {}

  const plans = regionKeys.map((dirPath) => {
    const members = regions.get(dirPath)!.slice().sort((a, b) => a.filePath.localeCompare(b.filePath))
    // World pins → cluster-local, only translatable once the region's world
    // origin is known. (A newRoot founding records its origin at creation,
    // so its pin resolves on the very first layout with the new agent.)
    const origin = remembered[dirPath]
    let localPins: Map<string, CellPin> | undefined
    if (origin) {
      for (const m of members) {
        const pin = pins[m.filePath]
        if (!pin) continue
        localPins ??= new Map()
        localPins.set(m.filePath, { q: pin.q - origin.q, r: pin.r - origin.r, solo: pin.solo })
      }
    }
    // This region's slice of the remembered district anchors
    let regionAnchors: Record<string, AxialCoord> | undefined
    const prefix = `${dirPath}::`
    for (const [key, a] of Object.entries(placement?.districtAnchors ?? {})) {
      if (!key.startsWith(prefix)) continue
      regionAnchors ??= {}
      regionAnchors[key.slice(prefix.length)] = a
    }
    return planRegion(dirPath, members, lineage, localPins, regionAnchors)
  })

  // ---- Region placement: frozen geography over fresh packing -------------
  // Regions with a remembered origin stay exactly there (nudged along a
  // spiral only if another region's agents actually grew into overlap).
  // Regions never seen before pack into free world space WITHOUT moving
  // anyone. When nothing is remembered (first run / legacy state), the old
  // shelf-pack lays out the whole world once and every origin gets recorded.
  const originOf = new Map<string, AxialCoord>()
  const placedCells: AxialCoord[] = []

  /** Smallest hex distance from any of plan's occupied cells (at world
   *  origin oq,or) to any already-placed region's occupied cell. */
  const minDistToPlaced = (plan: RegionPlan, oq: number, or: number): number => {
    let min = Infinity
    for (const c of plan.cells) {
      if (!c.filePath) continue
      for (const pc of placedCells) {
        const d = hexDistance(c.q + oq, c.r + or, pc.q, pc.r)
        if (d < min) min = d
        if (min < 4) return min
      }
    }
    return min
  }
  const commitRegion = (plan: RegionPlan, origin: AxialCoord): void => {
    originOf.set(plan.dirPath, origin)
    for (const c of plan.cells) {
      if (c.filePath) placedCells.push({ q: c.q + origin.q, r: c.r + origin.r })
    }
  }

  const rememberedPlans = plans.filter((p) => remembered[p.dirPath])
  const freshPlans = plans.filter((p) => !remembered[p.dirPath])
  const nudgeOffsets = rememberedPlans.length > 0 || freshPlans.length > 0 ? hexSpiral(600) : []

  for (const plan of rememberedPlans) {
    const home = remembered[plan.dirPath]
    let chosen: AxialCoord | null = null
    for (const [dq, dr] of nudgeOffsets) {
      const atHome = dq === 0 && dr === 0
      const d = minDistToPlaced(plan, home.q + dq, home.r + dr)
      // Home tolerates tighter spacing (≥3 keeps padding rings apart) so a
      // legacy-packed world doesn't get "corrected"; an actual nudge must
      // clear a full buffer (≥4) or it would just re-collide next growth.
      if (atHome ? d >= 3 : d >= 4) {
        chosen = { q: home.q + dq, r: home.r + dr }
        break
      }
    }
    commitRegion(plan, chosen ?? home)
  }

  const nodes: Node[] = []
  const labelNodes: Node[] = []
  const agentNodes: Node[] = []

  if (originOf.size === 0 && freshPlans.length > 0) {
    // Legacy/first-run: shelf-pack the whole world, record every origin.
    const gap = TERRAIN_GAP_CELLS * HEX_COL_W
    const packed = shelfPack(
      freshPlans.map((p) => ({ key: p.dirPath, width: p.width, height: p.height })),
      gap
    )
    for (const plan of freshPlans) {
      const slot = packed.get(plan.dirPath)!
      const originPx = snapToLattice(slot.x - plan.minX, slot.y - plan.minY)
      const oq = Math.round(originPx.x / HEX_COL_W)
      commitRegion(plan, { q: oq, r: Math.round(originPx.y / HEX_ROW_H - oq / 2) })
    }
  } else {
    // New land in an existing world. A founding pin dictates the origin
    // outright — the pinned founder lands on the clicked hex, wherever that
    // is (the user chose it; no second-guessing). Pinless new regions spiral
    // out from the settled centroid to the first spot with a clear buffer.
    for (const plan of freshPlans) {
      let chosen: AxialCoord | null = null
      let soloFallback: AxialCoord | null = null
      for (const c of plan.cells) {
        if (!c.filePath) continue
        const pin = pins[c.filePath]
        if (!pin) continue
        const cand = { q: pin.q - c.q, r: pin.r - c.r }
        if (!pin.solo) {
          chosen = cand
          break
        }
        soloFallback ??= cand
      }
      chosen ??= soloFallback
      if (!chosen) {
        const origins = [...originOf.values()]
        const centroid = origins.length > 0
          ? {
              q: Math.round(origins.reduce((s, o) => s + o.q, 0) / origins.length),
              r: Math.round(origins.reduce((s, o) => s + o.r, 0) / origins.length)
            }
          : { q: 0, r: 0 }
        for (const [dq, dr] of hexSpiral(4000)) {
          if (minDistToPlaced(plan, centroid.q + dq, centroid.r + dr) >= 4) {
            chosen = { q: centroid.q + dq, r: centroid.r + dr }
            break
          }
        }
        chosen ??= centroid
      }
      commitRegion(plan, chosen)
    }
  }

  for (const plan of plans) {
    const originAxial = originOf.get(plan.dirPath)!
    const origin = axialToPixel(originAxial.q, originAxial.r)
    const nodeX = origin.x + plan.minX
    const nodeY = origin.y + plan.minY

    const terrainData = {
      dirPath: plan.dirPath,
      label: plan.dirPath ? pathBasename(plan.dirPath) : 'Untracked',
      agentCount: plan.members.length,
      width: plan.width,
      height: plan.height,
      // Cell coords relative to the terrain node's top-left
      cells: plan.cells.map((c) => ({ ...c, x: c.x - plan.minX, y: c.y - plan.minY })),
      members: plan.members.map((m) => ({ filePath: m.filePath, handle: m.handle, icon: iconFor(m) })),
      districts: plan.districts
    } satisfies TerrainNodeData

    nodes.push({
      id: `terrain:${plan.dirPath || 'untracked'}`,
      type: 'terrainNode',
      position: { x: nodeX, y: nodeY },
      draggable: false,
      selectable: false,
      focusable: false,
      // Below the edge svg — message traces run over the land…
      zIndex: -1,
      // Terrain is scenery — let panning/marquee pass through to the canvas
      style: { pointerEvents: 'none' },
      // The graph filters out 'dimensions' changes (re-measure loop workaround),
      // so nodes are never measured — initial dims keep minimap/fitView bounds real
      initialWidth: plan.width,
      initialHeight: plan.height,
      data: terrainData
    })

    // …and the text twin sits above the edges (default node z beats the edge
    // svg) so traces never cross names, banners, or badges.
    labelNodes.push({
      id: `terrain-label:${plan.dirPath || 'untracked'}`,
      type: 'terrainLabelNode',
      position: { x: nodeX, y: nodeY },
      draggable: false,
      selectable: false,
      focusable: false,
      style: { pointerEvents: 'none' },
      initialWidth: plan.width,
      initialHeight: plan.height,
      data: terrainData
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
        // Tiles are movable: drop re-pins the agent (⌥ its district, ⌘ its
        // whole territory) — see onNodeDragStop in MeshGraphView.
        draggable: true,
        initialWidth: NODE_WIDTH,
        initialHeight: NODE_EST_HEIGHT,
        data: toNodeData(agent)
      })
    }
  }

  // Label twins before agent nodes — equal z, so DOM order keeps the
  // interactive unit panels on top of label text.
  nodes.push(...labelNodes, ...agentNodes)

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

  const regionOrigins: Record<string, AxialCoord> = {}
  for (const [dir, origin] of originOf) regionOrigins[dir] = origin
  const districtAnchors: Record<string, AxialCoord> = {}
  for (const plan of plans) {
    for (const [district, anchor] of Object.entries(plan.anchors)) {
      districtAnchors[`${plan.dirPath}::${district}`] = anchor
    }
  }

  return { nodes, lineageEdges, lineage, regionOrigins, districtAnchors }
}
