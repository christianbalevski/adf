import { describe, it, expect } from 'vitest'
import { computeFleetLayout, NODE_WIDTH } from '../../src/renderer/components/mesh/fleet-layout'
import type { MeshAgentStatus } from '../../src/shared/types/ipc.types'

function agent(overrides: Partial<MeshAgentStatus> & { filePath: string }): MeshAgentStatus {
  return {
    handle: overrides.filePath.split('/').pop()!.replace('.adf', ''),
    state: 'idle',
    participating: true,
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

    // Beta's region starts after alpha's region ends
    const alphaRight = terrains[0].position.x + (terrains[0].data.width as number)
    expect(terrains[1].position.x).toBeGreaterThan(alphaRight)

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

  it('lays out a lineage tree as an org chart — children below, parent centered', () => {
    const result = computeFleetLayout([
      agent({ filePath: '/d/parent.adf', trackedDirRoot: '/d', did: 'did:adf:p' }),
      agent({ filePath: '/d/kid1.adf', trackedDirRoot: '/d', parentDid: 'did:adf:p' }),
      agent({ filePath: '/d/kid2.adf', trackedDirRoot: '/d', parentDid: 'did:adf:p' })
    ])

    const parent = nodeById(result, '/d/parent.adf')
    const kid1 = nodeById(result, '/d/kid1.adf')
    const kid2 = nodeById(result, '/d/kid2.adf')

    expect(kid1.position.y).toBeGreaterThan(parent.position.y)
    expect(kid2.position.y).toBe(kid1.position.y)
    expect(kid1.position.x).not.toBe(kid2.position.x)
    // Parent centered over the children row
    const childCenter = (kid1.position.x + kid2.position.x) / 2
    expect(Math.abs(parent.position.x - childCenter)).toBeLessThan(1)

    // Org-chart edges from the lineage
    expect(result.lineageEdges.map((e) => `${e.source}->${e.target}`).sort()).toEqual([
      '/d/parent.adf->/d/kid1.adf',
      '/d/parent.adf->/d/kid2.adf'
    ])
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
    // Both at the top row of their own regions
    expect(kid.position.y).toBe(parent.position.y)
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
    expect(node.data).toMatchObject({ model: 'claude-sonnet-5', state: 'active', status: 'crunching' })
  })
})
