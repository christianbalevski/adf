import { describe, it, expect, beforeEach } from 'vitest'
import { useAgentStore, selectLoopSlice } from '../../../src/renderer/stores/agent.store'
import type { AgentLogEntry } from '../../../src/renderer/stores/agent.store'

/**
 * `structuralVersion` is the signal the loop view rebuilds its whole-log passes
 * on (the tool_result filter, the tool_call↔result pairing, the activity
 * grouping). A streamed answer bumps `logVersion` ~20×/s; if those passes keyed
 * on that they would re-walk the entire transcript per delta.
 *
 * The contract is narrow on purpose: withhold the structural bump ONLY when a
 * text/thinking entry's prose grew and nothing else about it moved. Everything
 * that can re-group a row — a rewritten metadata object, an appended entry, a
 * replaced window — must bump, or the view hands out a stale row.
 */

const textEntry = (id: string, content: string): AgentLogEntry =>
  ({ id, type: 'text', content, timestamp: 1 })

const toolEntry = (id: string): AgentLogEntry =>
  ({ id, type: 'tool_call', content: 'fs_read', timestamp: 1, metadata: { name: 'fs_read', outOfBand: true } })

function versions(loop?: string): { log: number; structural: number } {
  const slice = selectLoopSlice(useAgentStore.getState(), loop)
  return { log: slice.logVersion, structural: slice.structuralVersion }
}

beforeEach(() => {
  useAgentStore.getState().reset()
})

describe('structuralVersion', () => {
  it('starts at zero for main and for an untouched side loop', () => {
    expect(versions().structural).toBe(0)
    expect(versions('agent-1').structural).toBe(0)
  })

  it('bumps on append', () => {
    const before = versions()
    useAgentStore.getState().addLogEntry(textEntry('e1', 'hello'))
    const after = versions()
    expect(after.structural).toBe(before.structural + 1)
    expect(after.log).toBe(before.log + 1)
  })

  it('holds still while a text entry streams', () => {
    const store = useAgentStore.getState()
    store.addLogEntry(textEntry('e1', 'hel'))
    const before = versions()
    store.updateEntryAt(0, (e) => { e.content += 'lo' })
    store.updateEntryAt(0, (e) => { e.content += ' there' })
    const after = versions()
    expect(after.structural).toBe(before.structural)
    expect(after.log).toBe(before.log + 2)
    expect(useAgentStore.getState().log[0].content).toBe('hello there')
  })

  it('holds still while a thinking entry streams', () => {
    const store = useAgentStore.getState()
    store.addLogEntry({ id: 't1', type: 'thinking', content: 'a', timestamp: 1 })
    const before = versions()
    store.updateLastEntry((e) => { e.content += 'b' })
    expect(versions().structural).toBe(before.structural)
  })

  it('bumps when an update rewrites metadata', () => {
    const store = useAgentStore.getState()
    store.addLogEntry(toolEntry('e1'))
    const before = versions()
    store.updateEntryAt(0, (e) => { e.metadata = { ...e.metadata, askAnswer: 'yes' } })
    expect(versions().structural).toBe(before.structural + 1)
  })

  it('bumps when an update changes an entry type', () => {
    const store = useAgentStore.getState()
    store.addLogEntry(textEntry('e1', 'hello'))
    const before = versions()
    store.updateEntryAt(0, (e) => { e.type = 'error' })
    expect(versions().structural).toBe(before.structural + 1)
  })

  it('bumps for a content change on an entry that is not text/thinking', () => {
    const store = useAgentStore.getState()
    store.addLogEntry({ id: 's1', type: 'system', content: 'working', timestamp: 1 })
    const before = versions()
    store.updateEntryAt(0, (e) => { e.content = 'Turn complete' })
    expect(versions().structural).toBe(before.structural + 1)
  })

  it('bumps on markApprovalOutcome — the row object is replaced', () => {
    const store = useAgentStore.getState()
    store.addLogEntry(toolEntry('e1'))
    const before = versions()
    store.markApprovalOutcome('e1', true)
    expect(versions().structural).toBe(before.structural + 1)
  })

  it('bumps on setLog, prependLog and clearLog', () => {
    const store = useAgentStore.getState()
    store.setLog([textEntry('e1', 'a')], 3)
    const afterSet = versions()
    expect(afterSet.structural).toBe(1)

    store.prependLog([textEntry('e0', 'older')], 2)
    expect(versions().structural).toBe(afterSet.structural + 1)

    store.clearLog()
    expect(versions().structural).toBe(afterSet.structural + 2)
  })

  it('tracks side loops independently of main', () => {
    const store = useAgentStore.getState()
    store.addLogEntry(textEntry('e1', 'hi'), 'agent-1')
    expect(versions('agent-1').structural).toBe(1)
    expect(versions().structural).toBe(0)

    store.updateEntryAt(0, (e) => { e.content += '!' }, 'agent-1')
    expect(versions('agent-1').structural).toBe(1)
  })

  it('is a no-op for an out-of-range index', () => {
    const store = useAgentStore.getState()
    store.addLogEntry(textEntry('e1', 'hi'))
    const before = versions()
    store.updateEntryAt(7, (e) => { e.content = 'x' })
    expect(versions()).toEqual(before)
  })
})
