import { describe, it, expect, beforeEach } from 'vitest'
import { useAgentStore, selectLoopSlice, type AgentLogEntry } from '../../../src/renderer/stores/agent.store'

const row = (id: string, seq: number, type: AgentLogEntry['type'] = 'text'): AgentLogEntry =>
  ({ id, type, content: id, timestamp: 0, metadata: { seq } })
const archived = (id: string): AgentLogEntry => ({ id, type: 'text', content: id, timestamp: 0, metadata: { archived: true } })
const archive = (loop?: string) => selectLoopSlice(useAgentStore.getState(), loop).archive

/** Peek, then load one page, as the loop view does. */
function loadPage(liveHead: number | null, entries: AgentLogEntry[], loop?: string): void {
  const s = useAgentStore.getState()
  const generation = archive(loop).generation
  s.patchArchive(generation, { hasMore: true, liveHead }, loop)
  s.prependArchive(generation, { entries, cursor: 'c', hasMore: true, unreadable: 0 }, loop)
}

beforeEach(() => useAgentStore.getState().reset())

describe('loop archive (store)', () => {
  it('keeps the archive apart from the live log, across a reload with the same head', () => {
    const s = useAgentStore.getState()
    s.setLog([row('a', 10), row('b', 11)], 0)
    loadPage(10, [archived('x')])
    expect(useAgentStore.getState().log.map(e => e.id)).toEqual(['a', 'b'])
    s.setLog([row('a', 10), row('b', 11), row('c', 12)], 0)
    expect(archive().entries.map(e => e.id)).toEqual(['x'])
  })

  it('drops the archive when the reloaded window starts elsewhere (a compaction)', () => {
    const s = useAgentStore.getState()
    s.setLog([row('a', 10), row('b', 11)], 0)
    loadPage(10, [archived('x')])
    s.setLog([row('sum', 20, 'compaction'), row('b', 11)], 0)
    expect(archive()).toMatchObject({ entries: [], hasMore: null, cursor: null })
  })

  it('after a clear, keeps the archive as new rows arrive, until a compaction', () => {
    const s = useAgentStore.getState()
    s.clearLog()
    loadPage(null, [archived('x')])
    s.setLog([row('n', 50)], 0)
    expect(archive()).toMatchObject({ liveHead: 50 })
    expect(archive().entries).toHaveLength(1)
    s.setLog([row('sum', 60, 'compaction'), row('m', 55)], 0)
    expect(archive().entries).toHaveLength(0)
  })

  it('drops a page whose read started before a reset, even across a store reset', () => {
    const s = useAgentStore.getState()
    s.setLog([row('a', 10)], 0)
    const stale = archive().generation
    s.clearLog()
    s.prependArchive(stale, { entries: [archived('x')], cursor: 'c', hasMore: false, unreadable: 0 })
    expect(archive().entries).toHaveLength(0)
    s.reset()
    s.patchArchive(stale, { hasMore: true })
    expect(archive().hasMore).toBeNull()
  })

  it('keeps side loops separate from main', () => {
    const s = useAgentStore.getState()
    s.setLog([row('a', 10)], 0, 'side')
    loadPage(10, [archived('x')], 'side')
    expect(archive('side').entries).toHaveLength(1)
    expect(archive().entries).toHaveLength(0)
  })
})
