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

  it('treats self-references with no alternative as unresolvable', () => {
    const weird = agent({ filePath: '/self.adf', did: 'did:key:zSelf', parentDid: 'did:key:zSelf' })
    const result = resolveLineage([weird])

    expect(result.orphaned).toEqual(['/self.adf'])
    expect(result.roots).toEqual(['/self.adf'])
    expect(result.parents.size).toBe(0)
  })

  it('resolves a kept-identity clone listed first to its source, never to itself', () => {
    // Clone kept the source's keys: same current DID, parent ref = that DID
    const clone = agent({ filePath: '/clone.adf', did: 'did:key:zSame', parentDid: 'did:key:zSame' })
    const source = agent({ filePath: '/source.adf', did: 'did:key:zSame' })
    const result = resolveLineage([clone, source])

    expect(result.parents.get('/clone.adf')).toBe('/source.adf')
    expect(result.children.get('/source.adf')).toEqual(['/clone.adf'])
    expect(result.roots).toEqual(['/source.adf'])
    expect(result.orphaned).toEqual([])
    expect(result.duplicateDids.get('did:key:zSame')).toEqual(['/clone.adf', '/source.adf'])
  })

  it('resolves a kept-identity clone through history after the source rotated', () => {
    const clone = agent({ filePath: '/clone.adf', did: 'did:key:zOld', parentDid: 'did:key:zOld' })
    const source = agent({ filePath: '/source.adf', did: 'did:key:zNew', didHistory: ['did:key:zOld'] })
    const result = resolveLineage([clone, source])

    expect(result.parents.get('/clone.adf')).toBe('/source.adf')
    expect(result.orphaned).toEqual([])
  })

  it('resolves several kept-identity clones to their source whatever the scan order', () => {
    // B and C kept A's keys: all three present did:key:zA; B and C point at it, A points at X
    const x = agent({ filePath: '/x.adf', did: 'did:key:zX' })
    const a = agent({ filePath: '/a.adf', did: 'did:key:zA', parentDid: 'did:key:zX' })
    const b = agent({ filePath: '/b.adf', did: 'did:key:zA', parentDid: 'did:key:zA' })
    const c = agent({ filePath: '/c.adf', did: 'did:key:zA', parentDid: 'did:key:zA' })
    const result = resolveLineage([b, c, a, x])

    expect(result.parents.get('/b.adf')).toBe('/a.adf')
    expect(result.parents.get('/c.adf')).toBe('/a.adf')
    expect(result.parents.get('/a.adf')).toBe('/x.adf')
    expect(result.children.get('/a.adf')).toEqual(['/b.adf', '/c.adf'])
    expect(result.roots).toEqual(['/x.adf'])
    expect(result.orphaned).toEqual([])

    // Three clones, source last
    const d = agent({ filePath: '/d.adf', did: 'did:key:zA', parentDid: 'did:key:zA' })
    const three = resolveLineage([b, c, d, a, x])
    expect(three.children.get('/a.adf')).toEqual(['/b.adf', '/c.adf', '/d.adf'])
    expect(three.parents.get('/a.adf')).toBe('/x.adf')
    expect(three.roots).toEqual(['/x.adf'])
  })

  it('prefers the earliest-created holder when every holder is a clone', () => {
    // Nobody is "the source": all three point at the shared DID. Oldest wins, then first-seen.
    const a = agent({ filePath: '/a.adf', did: 'did:key:zS', parentDid: 'did:key:zS', createdAt: '2026-03-01' })
    const b = agent({ filePath: '/b.adf', did: 'did:key:zS', parentDid: 'did:key:zS', createdAt: '2026-01-01' })
    const c = agent({ filePath: '/c.adf', did: 'did:key:zS', parentDid: 'did:key:zS', createdAt: '2026-01-01' })
    const result = resolveLineage([a, b, c])

    expect(result.parents.get('/a.adf')).toBe('/b.adf')
    // B → C → B is a loop; its youngest member (C, tie → last-seen) is cut loose
    expect(result.parents.get('/b.adf')).toBe('/c.adf')
    expect(result.parents.has('/c.adf')).toBe(false)
    expect(result.orphaned).toEqual(['/c.adf'])
    expect(result.roots).toEqual(['/c.adf'])
  })

  it('breaks the self-reference → rotated-history loop by orphaning exactly one member', () => {
    // A points at its own DID; B rotated away from that DID and points at it too
    const a = agent({ filePath: '/a.adf', did: 'did:key:zX', parentDid: 'did:key:zX' })
    const b = agent({ filePath: '/b.adf', did: 'did:key:zY', didHistory: ['did:key:zX'], parentDid: 'did:key:zX' })
    const result = resolveLineage([a, b])

    // A → B (history) and B → A (current) close a loop; no timestamps, so the last-seen member is cut
    expect(result.parents.get('/a.adf')).toBe('/b.adf')
    expect(result.parents.has('/b.adf')).toBe(false)
    expect(result.orphaned).toEqual(['/b.adf'])
    expect(result.roots).toEqual(['/b.adf'])
    expect(result.children.get('/b.adf')).toEqual(['/a.adf'])
    expect(result.children.get('/a.adf')).toBeUndefined()
  })

  it('breaks a pre-existing A↔B cycle deterministically (latest createdAt, then last-seen)', () => {
    const a = agent({ filePath: '/a.adf', did: 'did:key:zA', parentDid: 'did:key:zB', createdAt: '2026-02-01' })
    const b = agent({ filePath: '/b.adf', did: 'did:key:zB', parentDid: 'did:key:zA', createdAt: '2026-01-01' })
    const byAge = resolveLineage([a, b])
    expect(byAge.parents.get('/b.adf')).toBe('/a.adf')
    expect(byAge.parents.has('/a.adf')).toBe(false)
    expect(byAge.orphaned).toEqual(['/a.adf'])
    expect(byAge.roots).toEqual(['/a.adf'])
    expect(byAge.children.get('/b.adf')).toBeUndefined()
    expect(byAge.children.get('/a.adf')).toEqual(['/b.adf'])

    // No timestamps: the last-seen member is cut, regardless of who is scanned first
    const p = agent({ filePath: '/p.adf', did: 'did:key:zP', parentDid: 'did:key:zQ' })
    const q = agent({ filePath: '/q.adf', did: 'did:key:zQ', parentDid: 'did:key:zP' })
    expect(resolveLineage([p, q]).orphaned).toEqual(['/q.adf'])
    expect(resolveLineage([q, p]).orphaned).toEqual(['/p.adf'])
    // A third node hanging off the cycle stays attached
    const r = agent({ filePath: '/r.adf', did: 'did:key:zR', parentDid: 'did:key:zQ' })
    const withLeaf = resolveLineage([p, q, r])
    expect(withLeaf.parents.get('/r.adf')).toBe('/q.adf')
    expect(withLeaf.roots).toEqual(['/q.adf'])
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
