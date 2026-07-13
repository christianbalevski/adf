import { describe, it, expect } from 'vitest'
import { computeFleetLayout, NODE_WIDTH, HEX_COL_W, HEX_ROW_H, type TerrainNodeData } from '../../src/renderer/components/mesh/fleet-layout'
import type { FleetAgentStatus } from '../../src/shared/types/ipc.types'

function agent(overrides: Partial<FleetAgentStatus> & { filePath: string }): FleetAgentStatus {
  return {
    handle: overrides.filePath.split('/').pop()!.replace('.adf', ''),
    state: 'idle',
    participating: true,
    online: true,
    ...overrides
  }
}

const agentNodes = (r: ReturnType<typeof computeFleetLayout>) =>
  r.nodes.filter((n) => n.type === 'meshNode')
const terrainNodes = (r: ReturnType<typeof computeFleetLayout>) =>
  r.nodes.filter((n) => n.type === 'terrainNode')
const nodeById = (r: ReturnType<typeof computeFleetLayout>, id: string) => {
  const node = r.nodes.find((n) => n.id === id)
  if (!node) throw new Error(`node ${id} not in layout`)
  return node
}
const terrainData = (n: { data: unknown }) => n.data as TerrainNodeData

describe('computeFleetLayout (hex world)', () => {
  it('gives every agent its own cell — no two agents share a hex', () => {
    const result = computeFleetLayout(
      Array.from({ length: 9 }, (_, i) => agent({ filePath: `/d/a${i}.adf`, trackedDirRoot: '/d' }))
    )
    const terrain = terrainNodes(result)[0]
    const occupied = terrainData(terrain).cells.filter((c) => c.filePath)
    expect(occupied).toHaveLength(9)
    const keys = new Set(occupied.map((c) => `${c.q},${c.r}`))
    expect(keys.size).toBe(9)
    // Every agent node is centered on its cell
    for (const cell of occupied) {
      const n = nodeById(result, cell.filePath!)
      expect(n.position.x + NODE_WIDTH / 2).toBeCloseTo(terrain.position.x + cell.x, 5)
    }
  })

  it('agent cells never overlap across the whole map (center distance ≥ one hex step)', () => {
    const agents = [
      ...Array.from({ length: 7 }, (_, i) => agent({ filePath: `/a/x${i}.adf`, trackedDirRoot: '/a' })),
      ...Array.from({ length: 5 }, (_, i) => agent({ filePath: `/b/y${i}.adf`, trackedDirRoot: '/b' }))
    ]
    const result = computeFleetLayout(agents)
    const centers = agentNodes(result).map((n) => ({ x: n.position.x + NODE_WIDTH / 2, y: n.position.y + 20 }))
    const minStep = Math.min(HEX_COL_W, HEX_ROW_H) * 0.99
    for (let i = 0; i < centers.length; i++) {
      for (let j = i + 1; j < centers.length; j++) {
        const d = Math.hypot(centers[i].x - centers[j].x, centers[i].y - centers[j].y)
        expect(d).toBeGreaterThanOrEqual(minStep)
      }
    }
  })

  it('cells include a padding ring around occupied cells', () => {
    const result = computeFleetLayout([agent({ filePath: '/d/solo.adf', trackedDirRoot: '/d' })])
    const cells = terrainData(terrainNodes(result)[0]).cells
    expect(cells.filter((c) => c.filePath)).toHaveLength(1)
    expect(cells.filter((c) => !c.filePath)).toHaveLength(6) // hex neighbors
  })

  it('territory cells align with the global lattice (snap keeps q/r pixel-consistent)', () => {
    const result = computeFleetLayout([
      agent({ filePath: '/a/one.adf', trackedDirRoot: '/a' }),
      agent({ filePath: '/b/two.adf', trackedDirRoot: '/b' })
    ])
    for (const terrain of terrainNodes(result)) {
      for (const cell of terrainData(terrain).cells) {
        const absX = terrain.position.x + cell.x
        const absY = terrain.position.y + cell.y
        // Pixel center must satisfy the lattice equations for integers q, r
        const q = absX / HEX_COL_W
        expect(Math.abs(q - Math.round(q))).toBeLessThan(1e-6)
        const r = absY / HEX_ROW_H - Math.round(q) / 2
        expect(Math.abs(r - Math.round(r))).toBeLessThan(1e-6)
      }
    }
  })

  it('same-district agents occupy contiguous cells and districts are listed', () => {
    const result = computeFleetLayout([
      agent({ filePath: '/d/root.adf', trackedDirRoot: '/d' }),
      agent({ filePath: '/d/recon/a.adf', trackedDirRoot: '/d' }),
      agent({ filePath: '/d/recon/b.adf', trackedDirRoot: '/d' })
    ])
    const data = terrainData(terrainNodes(result)[0])
    expect(data.districts).toEqual(['recon'])
    const recon = data.cells.filter((c) => c.filePath && c.district === 'recon')
    expect(recon).toHaveLength(2)
    // Contiguous: the two recon cells are hex neighbors
    const [c1, c2] = recon
    const dq = c2.q - c1.q
    const dr = c2.r - c1.r
    const neighbor = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]].some(([q, r]) => q === dq && r === dr)
    expect(neighbor).toBe(true)
  })

  it('districts form satellite mini-clusters separated from the root cluster by open ocean', () => {
    const result = computeFleetLayout([
      agent({ filePath: '/d/root.adf', trackedDirRoot: '/d' }),
      agent({ filePath: '/d/recon/a.adf', trackedDirRoot: '/d' }),
      agent({ filePath: '/d/recon/b.adf', trackedDirRoot: '/d' })
    ])
    const cells = terrainData(terrainNodes(result)[0]).cells
    const rootMaxQ = Math.max(...cells.filter((c) => c.district === '').map((c) => c.q))
    const reconMinQ = Math.min(...cells.filter((c) => c.district === 'recon').map((c) => c.q))
    // At least one full empty lattice column between the clusters
    expect(reconMinQ - rootMaxQ).toBeGreaterThanOrEqual(2)
  })

  it('resolves a rotated parent DID through history (D4 cascade) and emits lineage edges', () => {
    const result = computeFleetLayout([
      agent({ filePath: '/d/parent.adf', trackedDirRoot: '/d', did: 'did:adf:new', didHistory: ['did:adf:old'] }),
      agent({ filePath: '/d/kid.adf', trackedDirRoot: '/d', parentDid: 'did:adf:old' })
    ])
    expect(result.lineage.parents.get('/d/kid.adf')).toBe('/d/parent.adf')
    expect(result.lineageEdges).toHaveLength(1)
  })

  it('lineage relatives sit on adjacent cells (parent placed, children next)', () => {
    const result = computeFleetLayout([
      agent({ filePath: '/d/parent.adf', trackedDirRoot: '/d', did: 'did:adf:p' }),
      agent({ filePath: '/d/kid.adf', trackedDirRoot: '/d', parentDid: 'did:adf:p' }),
      agent({ filePath: '/d/zzz-stranger.adf', trackedDirRoot: '/d' })
    ])
    const cells = terrainData(terrainNodes(result)[0]).cells.filter((c) => c.filePath)
    const parent = cells.find((c) => c.filePath === '/d/parent.adf')!
    const kid = cells.find((c) => c.filePath === '/d/kid.adf')!
    const dist = (Math.abs(parent.q - kid.q) + Math.abs(parent.q + parent.r - kid.q - kid.r) + Math.abs(parent.r - kid.r)) / 2
    expect(dist).toBe(1)
  })

  it('places every agent even with a parent-reference cycle', () => {
    const result = computeFleetLayout([
      agent({ filePath: '/d/a.adf', trackedDirRoot: '/d', did: 'did:adf:a', parentDid: 'did:adf:b' }),
      agent({ filePath: '/d/b.adf', trackedDirRoot: '/d', did: 'did:adf:b', parentDid: 'did:adf:a' })
    ])
    expect(agentNodes(result)).toHaveLength(2)
  })

  it('is deterministic — same agents in any order produce identical positions', () => {
    const agents = [
      agent({ filePath: '/d/parent.adf', trackedDirRoot: '/d', did: 'did:adf:p' }),
      agent({ filePath: '/d/kid1.adf', trackedDirRoot: '/d', parentDid: 'did:adf:p' }),
      agent({ filePath: '/e/solo.adf', trackedDirRoot: '/e' })
    ]
    const forward = computeFleetLayout(agents)
    const reversed = computeFleetLayout([...agents].reverse())
    for (const node of forward.nodes) {
      expect(nodeById(reversed, node.id).position).toEqual(node.position)
    }
  })

  it('carries vitals and a guaranteed icon into node data', () => {
    const result = computeFleetLayout([
      agent({ filePath: '/d/a.adf', trackedDirRoot: '/d', model: 'claude-sonnet-5', state: 'active', status: 'crunching' })
    ])
    const node = nodeById(result, '/d/a.adf')
    expect(node.data).toMatchObject({ model: 'claude-sonnet-5', state: 'active', status: 'crunching', online: true })
    expect(typeof node.data.icon).toBe('string')
    expect((node.data.icon as string).length).toBeGreaterThan(0)
  })

  it('includes offline ghosts in the same geography', () => {
    const result = computeFleetLayout([
      agent({ filePath: '/d/live.adf', trackedDirRoot: '/d', online: true }),
      agent({ filePath: '/d/ghost.adf', trackedDirRoot: '/d', online: false, state: 'off' })
    ])
    const ghost = nodeById(result, '/d/ghost.adf')
    expect(ghost.data).toMatchObject({ online: false, state: 'off' })
    expect(agentNodes(result)).toHaveLength(2)
  })

  it('territories never overlap', () => {
    const result = computeFleetLayout(
      Array.from({ length: 5 }, (_, i) => agent({ filePath: `/r${i}/a.adf`, trackedDirRoot: `/r${i}` }))
    )
    const rects = terrainNodes(result).map((t) => ({
      x: t.position.x,
      y: t.position.y,
      w: terrainData(t).width,
      h: terrainData(t).height
    }))
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]
        const b = rects[j]
        const disjoint = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y
        expect(disjoint).toBe(true)
      }
    }
  })
})
