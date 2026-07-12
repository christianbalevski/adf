import { describe, it, expect } from 'vitest'
import { computeFleetLayout, NODE_WIDTH } from '../../src/renderer/components/mesh/fleet-layout'
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

describe('computeFleetLayout', () => {
  it('groups agents into one terrain region per tracked dir, sorted and non-overlapping', () => {
    const result = computeFleetLayout([
      agent({ filePath: '/work/beta/b.adf', trackedDirRoot: '/work/beta' }),
      agent({ filePath: '/work/alpha/a.adf', trackedDirRoot: '/work/alpha' }),
      agent({ filePath: '/work/alpha/a2.adf', trackedDirRoot: '/work/alpha' })
    ])

    const terrains = terrainNodes(result)
    expect(terrains.map((t) => t.id)).toEqual(['terrain:/work/alpha', 'terrain:/work/beta'])
    expect(terrains[0].data.agentCount).toBe(2)
    expect(terrains[1].data.agentCount).toBe(1)

    // Regions never overlap (they may pack beside OR below each other)
    const [a, b] = terrains
    const disjointX =
      a.position.x + (a.data.width as number) <= b.position.x ||
      b.position.x + (b.data.width as number) <= a.position.x
    const disjointY =
      a.position.y + (a.data.height as number) <= b.position.y ||
      b.position.y + (b.data.height as number) <= a.position.y
    expect(disjointX || disjointY).toBe(true)

    // Agents sit inside their terrain's x range
    for (const a of agentNodes(result)) {
      const terrain = a.id.includes('alpha') ? terrains[0] : terrains[1]
      expect(a.position.x).toBeGreaterThanOrEqual(terrain.position.x)
      expect(a.position.x + NODE_WIDTH).toBeLessThanOrEqual(terrain.position.x + (terrain.data.width as number))
    }
  })

  it('puts agents without a tracked dir into an Untracked region', () => {
    const result = computeFleetLayout([agent({ filePath: '/stray/x.adf' })])
    const terrains = terrainNodes(result)
    expect(terrains).toHaveLength(1)
    expect(terrains[0].data.label).toBe('Untracked')
  })

  it('places lineage relatives adjacently and emits org-chart edges, without overlap', () => {
    const result = computeFleetLayout([
      agent({ filePath: '/d/parent.adf', trackedDirRoot: '/d', did: 'did:adf:p' }),
      agent({ filePath: '/d/kid1.adf', trackedDirRoot: '/d', parentDid: 'did:adf:p' }),
      agent({ filePath: '/d/kid2.adf', trackedDirRoot: '/d', parentDid: 'did:adf:p' }),
      agent({ filePath: '/d/stranger.adf', trackedDirRoot: '/d' })
    ])

    // Settlement grid: no two agents share a cell
    const nodes = agentNodes(result)
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]
        const b = nodes[j]
        const overlap =
          Math.abs(a.position.x - b.position.x) < NODE_WIDTH &&
          Math.abs(a.position.y - b.position.y) < 100
        expect(overlap).toBe(false)
      }
    }

    // Lineage order: parent placed first, kids immediately after (grid adjacency)
    const order = nodes.map((n) => n.id)
    expect(order.indexOf('/d/parent.adf')).toBeLessThan(order.indexOf('/d/kid1.adf'))
    expect(order.indexOf('/d/kid2.adf')).toBeLessThan(order.indexOf('/d/stranger.adf'))

    // Org-chart edges from the lineage
    expect(result.lineageEdges.map((e) => `${e.source}->${e.target}`).sort()).toEqual([
      '/d/parent.adf->/d/kid1.adf',
      '/d/parent.adf->/d/kid2.adf'
    ])
  })

  it('shelf-packs many regions into 2D instead of one horizontal strip', () => {
    const agents = Array.from({ length: 6 }, (_, i) =>
      agent({ filePath: `/r${i}/a.adf`, trackedDirRoot: `/r${i}` })
    )
    const result = computeFleetLayout(agents)
    const terrains = terrainNodes(result)
    const ys = new Set(terrains.map((t) => t.position.y))
    expect(ys.size).toBeGreaterThan(1)
  })

  it('resolves a rotated parent DID through history (D4 cascade)', () => {
    const result = computeFleetLayout([
      agent({ filePath: '/d/parent.adf', trackedDirRoot: '/d', did: 'did:adf:new', didHistory: ['did:adf:old'] }),
      agent({ filePath: '/d/kid.adf', trackedDirRoot: '/d', parentDid: 'did:adf:old' })
    ])
    expect(result.lineage.parents.get('/d/kid.adf')).toBe('/d/parent.adf')
    expect(result.lineageEdges).toHaveLength(1)
  })

  it('treats a child whose parent lives in another region as a local root, edge preserved', () => {
    const result = computeFleetLayout([
      agent({ filePath: '/a/parent.adf', trackedDirRoot: '/a', did: 'did:adf:p' }),
      agent({ filePath: '/b/kid.adf', trackedDirRoot: '/b', parentDid: 'did:adf:p' })
    ])
    const kid = nodeById(result, '/b/kid.adf')
    const parent = nodeById(result, '/a/parent.adf')
    // Each sits inside its own region (positions carry per-agent jitter)
    const terrains = terrainNodes(result)
    const inRegion = (n: { position: { x: number; y: number } }, p: string) => {
      const t = terrains.find((t) => t.id === `terrain:${p}`)!
      return (
        n.position.x >= t.position.x &&
        n.position.x + NODE_WIDTH <= t.position.x + (t.data.width as number) &&
        n.position.y >= t.position.y &&
        n.position.y <= t.position.y + (t.data.height as number)
      )
    }
    expect(inRegion(parent, '/a')).toBe(true)
    expect(inRegion(kid, '/b')).toBe(true)
    // Cross-region lineage edge still drawn
    expect(result.lineageEdges).toHaveLength(1)
  })

  it('places every agent even with a parent-reference cycle', () => {
    const result = computeFleetLayout([
      agent({ filePath: '/d/a.adf', trackedDirRoot: '/d', did: 'did:adf:a', parentDid: 'did:adf:b' }),
      agent({ filePath: '/d/b.adf', trackedDirRoot: '/d', did: 'did:adf:b', parentDid: 'did:adf:a' })
    ])
    expect(agentNodes(result)).toHaveLength(2)
    const [a, b] = agentNodes(result)
    expect(a.position.x).not.toBe(b.position.x)
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

  it('carries vitals into node data', () => {
    const result = computeFleetLayout([
      agent({ filePath: '/d/a.adf', trackedDirRoot: '/d', model: 'claude-sonnet-5', state: 'active', status: 'crunching' })
    ])
    const node = nodeById(result, '/d/a.adf')
    expect(node.data).toMatchObject({ model: 'claude-sonnet-5', state: 'active', status: 'crunching', online: true })
  })

  it('renders subdirectories as sub-terrain districts inside the region', () => {
    const result = computeFleetLayout([
      agent({ filePath: '/d/root.adf', trackedDirRoot: '/d' }),
      agent({ filePath: '/d/recon/a.adf', trackedDirRoot: '/d' }),
      agent({ filePath: '/d/recon/b.adf', trackedDirRoot: '/d' })
    ])

    const terrains = terrainNodes(result)
    const root = terrains.find((t) => t.data.variant === 'root')!
    const sub = terrains.find((t) => t.data.variant === 'sub')!
    expect(root.data.label).toBe('d')
    expect(sub.data.label).toBe('recon')
    expect(sub.data.agentCount).toBe(2)

    // District sits inside the parent region
    expect(sub.position.x).toBeGreaterThanOrEqual(root.position.x)
    expect(sub.position.x + (sub.data.width as number)).toBeLessThanOrEqual(root.position.x + (root.data.width as number))

    // District members sit inside the district rect
    for (const id of ['/d/recon/a.adf', '/d/recon/b.adf']) {
      const n = nodeById(result, id)
      expect(n.position.x).toBeGreaterThanOrEqual(sub.position.x)
      expect(n.position.x + NODE_WIDTH).toBeLessThanOrEqual(sub.position.x + (sub.data.width as number))
    }
    // Root-level agent is not inside the district rect (districts may pack
    // beside or below the root group in 2D)
    const rootAgent = nodeById(result, '/d/root.adf')
    const insideX =
      rootAgent.position.x >= sub.position.x &&
      rootAgent.position.x < sub.position.x + (sub.data.width as number)
    const insideY =
      rootAgent.position.y >= sub.position.y &&
      rootAgent.position.y < sub.position.y + (sub.data.height as number)
    expect(insideX && insideY).toBe(false)
  })

  it('nested subdirectory paths get their own district', () => {
    const result = computeFleetLayout([
      agent({ filePath: '/d/x/deep/n.adf', trackedDirRoot: '/d' })
    ])
    const sub = terrainNodes(result).find((t) => t.data.variant === 'sub')!
    expect(sub.data.label).toBe('x/deep')
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
})
