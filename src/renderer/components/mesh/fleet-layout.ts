import type { Node, Edge } from '@xyflow/react'
import type { FleetAgentStatus } from '../../../shared/types/ipc.types'
import { resolveLineage, type ResolvedLineage } from '../../../shared/utils/lineage'
import type { MeshNodeData } from './MeshGraphNode'

/**
 * Fleet map layout (milestone 2).
 *
 * Geography rules: tracked folders are static terrain — every agent lives in
 * the region for its trackedDirRoot, regions are sorted by path so positions
 * survive restarts and agents joining/leaving other regions. Subdirectories
 * of a tracked dir render as micro-terrain districts inside the region.
 * Inside each district, agents are laid out as an org chart from the
 * adf_parent_did lineage tree (D4 cascade via resolveLineage). Offline
 * on-disk agents ("ghosts") occupy the same geography as running ones.
 * Message traffic never moves a node.
 */

export const NODE_WIDTH = 260
/** Reserved vertical slot per tree row — nodes grow downward with activity, so keep it roomy */
const ROW_HEIGHT = 220
const SIBLING_GAP = 40
const TERRAIN_PADDING = 48
const TERRAIN_HEADER = 34
const TERRAIN_GAP = 100
/** Sub-terrain (district) chrome */
const SUB_PADDING = 24
const SUB_HEADER = 26
const GROUP_GAP = 56
/** Terrain key for agents outside any tracked directory */
const UNTRACKED = ''

export interface TerrainNodeData {
  dirPath: string
  label: string
  agentCount: number
  width: number
  height: number
  /** 'root' = tracked directory, 'sub' = subdirectory district inside it */
  variant: 'root' | 'sub'
  [key: string]: unknown
}

export interface FleetLayoutResult {
  /** Terrain background nodes first (rendered behind), then agent nodes */
  nodes: Node[]
  /** Dashed org-chart edges from the lineage tree */
  lineageEdges: Edge[]
  lineage: ResolvedLineage
}

interface PlacedAgent {
  filePath: string
  x: number
  y: number
}

/**
 * Width each subtree needs — a parent is never narrower than its children row.
 * Bottom-up pass with a cycle guard; cyclic references count as leaves.
 */
function computeSubtreeWidths(
  roots: string[],
  children: Map<string, string[]>
): Map<string, number> {
  const widths = new Map<string, number>()
  const walk = (filePath: string, path: Set<string>): number => {
    const memo = widths.get(filePath)
    if (memo !== undefined) return memo
    if (path.has(filePath)) return NODE_WIDTH + SIBLING_GAP
    path.add(filePath)
    let sum = 0
    for (const kid of children.get(filePath) ?? []) sum += walk(kid, path)
    path.delete(filePath)
    const width = Math.max(NODE_WIDTH + SIBLING_GAP, sum)
    widths.set(filePath, width)
    return width
  }
  for (const root of roots) walk(root, new Set())
  return widths
}

/** Place a subtree with its root centered over its children, rows by depth. */
function placeSubtree(
  filePath: string,
  x: number,
  depth: number,
  children: Map<string, string[]>,
  widths: Map<string, number>,
  visited: Set<string>,
  out: PlacedAgent[]
): number {
  if (visited.has(filePath)) return 0
  visited.add(filePath)
  const width = widths.get(filePath) ?? NODE_WIDTH + SIBLING_GAP
  out.push({
    filePath,
    x: x + width / 2 - NODE_WIDTH / 2,
    y: depth * ROW_HEIGHT
  })
  let childX = x
  for (const kid of children.get(filePath) ?? []) {
    childX += placeSubtree(kid, childX, depth + 1, children, widths, visited, out)
  }
  return width
}

/**
 * Lay out one group of agents (a district or a region's root level) as a
 * lineage forest. Returns positions relative to the group origin plus size.
 */
function layoutGroup(members: FleetAgentStatus[], lineage: ResolvedLineage): {
  placed: PlacedAgent[]
  width: number
  height: number
} {
  const memberPaths = new Set(members.map((m) => m.filePath))
  // Group-local views of the global lineage: a parent living in another
  // group can't anchor a tree here, so such children become local roots.
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

  const placed: PlacedAgent[] = []
  const widths = computeSubtreeWidths(localRoots, localChildren)
  const visited = new Set<string>()
  let x = 0
  for (const root of localRoots) {
    x += placeSubtree(root, x, 0, localChildren, widths, visited, placed)
  }
  // Cycle leftovers (mutual parent references never reach a root) — append as a flat row
  for (const m of members) {
    if (!visited.has(m.filePath)) {
      placed.push({ filePath: m.filePath, x, y: 0 })
      x += NODE_WIDTH + SIBLING_GAP
    }
  }

  const maxDepth = placed.reduce((d, p) => Math.max(d, p.y / ROW_HEIGHT), 0)
  return {
    placed,
    width: Math.max(x - SIBLING_GAP, NODE_WIDTH),
    height: (maxDepth + 1) * ROW_HEIGHT - (ROW_HEIGHT - 160)
  }
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

export function computeFleetLayout(agents: FleetAgentStatus[]): FleetLayoutResult {
  const lineage = resolveLineage(agents)
  const byPath = new Map(agents.map((a) => [a.filePath, a]))

  // Group by tracked dir — sorted keys keep terrain order stable across polls
  const regions = new Map<string, FleetAgentStatus[]>()
  for (const agent of agents) {
    const key = agent.trackedDirRoot ?? UNTRACKED
    const members = regions.get(key) ?? []
    members.push(agent)
    regions.set(key, members)
  }
  const regionKeys = [...regions.keys()].sort()

  const nodes: Node[] = []
  const agentNodes: Node[] = []
  let originX = 0

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

    interface PlacedDistrict {
      rel: string
      placed: PlacedAgent[]
      x: number
      outerWidth: number
      outerHeight: number
      contentOffsetX: number
      contentOffsetY: number
    }
    const placedDistricts: PlacedDistrict[] = []
    let xCursor = 0
    for (const rel of districtKeys) {
      const group = districts.get(rel)!
      const { placed, width, height } = layoutGroup(group, lineage)
      const isSub = rel !== ''
      placedDistricts.push({
        rel,
        placed,
        x: xCursor,
        outerWidth: isSub ? width + SUB_PADDING * 2 : width,
        outerHeight: isSub ? height + SUB_PADDING * 2 + SUB_HEADER : height,
        contentOffsetX: isSub ? SUB_PADDING : 0,
        contentOffsetY: isSub ? SUB_PADDING + SUB_HEADER : 0
      })
      xCursor += placedDistricts[placedDistricts.length - 1].outerWidth + GROUP_GAP
    }

    const contentWidth = Math.max(xCursor - GROUP_GAP, NODE_WIDTH)
    const contentHeight = placedDistricts.reduce((h, d) => Math.max(h, d.outerHeight), 0)
    const terrainWidth = contentWidth + TERRAIN_PADDING * 2
    const terrainHeight = contentHeight + TERRAIN_PADDING * 2 + TERRAIN_HEADER

    nodes.push({
      id: `terrain:${dirPath || 'untracked'}`,
      type: 'terrainNode',
      position: { x: originX, y: 0 },
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
        dirPath,
        label: dirPath ? dirPath.split('/').filter(Boolean).pop() ?? dirPath : 'Untracked',
        agentCount: members.length,
        width: terrainWidth,
        height: terrainHeight,
        variant: 'root'
      } satisfies TerrainNodeData
    })

    for (const d of placedDistricts) {
      const districtOriginX = originX + TERRAIN_PADDING + d.x
      const districtOriginY = TERRAIN_PADDING + TERRAIN_HEADER

      if (d.rel !== '') {
        nodes.push({
          id: `terrain:${dirPath || 'untracked'}/${d.rel}`,
          type: 'terrainNode',
          position: { x: districtOriginX, y: districtOriginY },
          draggable: false,
          selectable: false,
          focusable: false,
          zIndex: -1,
          style: { pointerEvents: 'none' },
          initialWidth: d.outerWidth,
          initialHeight: d.outerHeight,
          data: {
            dirPath: dirPath ? `${dirPath}/${d.rel}` : d.rel,
            label: d.rel,
            agentCount: d.placed.length,
            width: d.outerWidth,
            height: d.outerHeight,
            variant: 'sub'
          } satisfies TerrainNodeData
        })
      }

      for (const p of d.placed) {
        const agent = byPath.get(p.filePath)
        if (!agent) continue
        agentNodes.push({
          id: agent.filePath,
          type: 'meshNode',
          position: {
            x: districtOriginX + d.contentOffsetX + p.x,
            y: districtOriginY + d.contentOffsetY + p.y
          },
          initialWidth: NODE_WIDTH,
          initialHeight: 110,
          data: toNodeData(agent)
        })
      }
    }

    originX += terrainWidth + TERRAIN_GAP
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
