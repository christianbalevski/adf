import { describe, expect, it } from 'vitest'
import { resolveLineage, type LineageAgentRef } from '../../src/shared/utils/lineage'

function agent(overrides: Partial<LineageAgentRef> & { filePath: string }): LineageAgentRef {
  return overrides
}

describe('resolveLineage (ADF_IDENTITY_SPEC D4)', () => {
  it('resolves a parent by current DID', () => {
    const parent = agent({ filePath: '/a/parent.adf', did: 'did:key:zParent' })
    const child = agent({ filePath: '/a/child.adf', did: 'did:key:zChild', parentDid: 'did:key:zParent' })
    const result = resolveLineage([parent, child])

    expect(result.parents.get('/a/child.adf')).toBe('/a/parent.adf')
    expect(result.children.get('/a/parent.adf')).toEqual(['/a/child.adf'])
    expect(result.roots).toEqual(['/a/parent.adf'])
    expect(result.orphaned).toEqual([])
  })

  it('resolves through DID history after the parent rotated', () => {
    const parent = agent({
      filePath: '/a/parent.adf',
      did: 'did:key:zParentNew',
      didHistory: ['did:key:zParentOld']
    })
    const child = agent({ filePath: '/a/child.adf', did: 'did:key:zChild', parentDid: 'did:key:zParentOld' })
    const result = resolveLineage([parent, child])

    expect(result.parents.get('/a/child.adf')).toBe('/a/parent.adf')
    expect(result.orphaned).toEqual([])
  })

  it('falls back to legacy config.id references', () => {
    const parent = agent({ filePath: '/a/parent.adf', did: 'did:key:zParent', agentId: 'abc123def456' })
    const child = agent({ filePath: '/a/child.adf', parentDid: 'abc123def456' })
    const result = resolveLineage([parent, child])

    expect(result.parents.get('/a/child.adf')).toBe('/a/parent.adf')
  })

  it('prefers current DID over history over config.id', () => {
    // 'ref' is simultaneously: current DID of A, history DID of B, agentId of C
    const a = agent({ filePath: '/a.adf', did: 'ref' })
    const b = agent({ filePath: '/b.adf', did: 'did:key:zB', didHistory: ['ref'] })
    const c = agent({ filePath: '/c.adf', did: 'did:key:zC', agentId: 'ref' })
    const child = agent({ filePath: '/child.adf', parentDid: 'ref' })

    expect(resolveLineage([a, b, c, child]).parents.get('/child.adf')).toBe('/a.adf')
    expect(resolveLineage([b, c, child]).parents.get('/child.adf')).toBe('/b.adf')
    expect(resolveLineage([c, child]).parents.get('/child.adf')).toBe('/c.adf')
  })

  it('marks unresolvable references orphaned and treats them as roots', () => {
    const child = agent({ filePath: '/child.adf', did: 'did:key:zChild', parentDid: 'did:key:zGone' })
    const result = resolveLineage([child])

    expect(result.orphaned).toEqual(['/child.adf'])
    expect(result.roots).toEqual(['/child.adf'])
    expect(result.parents.size).toBe(0)
  })

  it('treats self-references as unresolvable', () => {
    const weird = agent({ filePath: '/self.adf', did: 'did:key:zSelf', parentDid: 'did:key:zSelf' })
    const result = resolveLineage([weird])

    expect(result.orphaned).toEqual(['/self.adf'])
    expect(result.roots).toEqual(['/self.adf'])
  })

  it('reports duplicate current DIDs (same-owner file copies)', () => {
    const original = agent({ filePath: '/original.adf', did: 'did:key:zDupe' })
    const copy = agent({ filePath: '/copy.adf', did: 'did:key:zDupe' })
    const child = agent({ filePath: '/child.adf', parentDid: 'did:key:zDupe' })
    const result = resolveLineage([original, copy, child])

    expect(result.duplicateDids.get('did:key:zDupe')).toEqual(['/original.adf', '/copy.adf'])
    // Deterministic: first-seen wins so the tree stays drawable
    expect(result.parents.get('/child.adf')).toBe('/original.adf')
  })

  it('builds multi-level trees with sibling ordering preserved', () => {
    const root = agent({ filePath: '/root.adf', did: 'did:key:zRoot' })
    const mid = agent({ filePath: '/mid.adf', did: 'did:key:zMid', parentDid: 'did:key:zRoot' })
    const leaf1 = agent({ filePath: '/leaf1.adf', did: 'did:key:zL1', parentDid: 'did:key:zMid' })
    const leaf2 = agent({ filePath: '/leaf2.adf', did: 'did:key:zL2', parentDid: 'did:key:zMid' })
    const result = resolveLineage([root, mid, leaf1, leaf2])

    expect(result.roots).toEqual(['/root.adf'])
    expect(result.children.get('/root.adf')).toEqual(['/mid.adf'])
    expect(result.children.get('/mid.adf')).toEqual(['/leaf1.adf', '/leaf2.adf'])
  })

  it('handles agents with no identity at all', () => {
    const bare = agent({ filePath: '/bare.adf' })
    const result = resolveLineage([bare])

    expect(result.roots).toEqual(['/bare.adf'])
    expect(result.orphaned).toEqual([])
  })
})
