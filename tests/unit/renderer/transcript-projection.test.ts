import { beforeEach, describe, expect, it } from 'vitest'
import { useAgentStore, type AgentLogEntry } from '../../../src/renderer/stores/agent.store'
import { TranscriptProjection, createTranscriptRows } from '../../../src/renderer/utils/transcript-projection'

const row = (id: string, type: AgentLogEntry['type'] = 'user', metadata?: AgentLogEntry['metadata']): AgentLogEntry =>
  ({ id, type, metadata, content: id, timestamp: 1 })

function project(rows: AgentLogEntry[]): TranscriptProjection {
  const projection = new TranscriptProjection()
  projection.append(rows)
  return projection
}

const boundary = { kind: 'entry' as const, id: 'archive-end', entry: row('archive-end', 'system') }

beforeEach(() => useAgentStore.getState().reset())

describe('transcript projection', () => {
  it('keeps the projected prefix and advances only new rows after streaming deltas', () => {
    let prefixReads = 0
    const prefix: AgentLogEntry = {
      id: 'old', get type() { prefixReads++; return 'user' }, timestamp: 1, content: 'old'
    }
    const original = row('streaming', 'thinking')
    const log = [prefix, original]
    const projection = project(log)
    const stable = projection.items[0]
    prefixReads = 0
    const finished = { ...original, content: 'finished' }
    const tool = row('tool', 'tool_call', { name: 'fs_write', tool_id: 'tool-use' })
    const appended = [prefix, finished, tool]
    projection.append(appended)
    expect(prefixReads).toBe(0)
    expect(projection.items[0]).toBe(stable)
    expect(projection.items[1]).toMatchObject({ kind: 'activity', entries: [finished, tool] })
    expect(projection.visible[1]).toBe(finished)
    expect(projection.findPair(tool.id)).toEqual({ call: tool, result: null })
  })

  it('splits the old group when a hidden status result arrives and preserves prior entries', () => {
    const prefix = row('prefix')
    const opening = row('thinking', 'thinking')
    const status = row('status', 'tool_call', { name: 'sys_set_meta', input: { key: 'status', value: 'ready' }, tool_id: 's' })
    const tool = row('tool', 'tool_call', { name: 'fs_read', tool_id: 'r' })
    const notice = row('notice', 'context', { category: 'runtime' })
    const result = row('result', 'tool_result', { tool_use_id: 's', isError: false })
    const log = [prefix, opening, status, tool, notice]
    const projection = project(log)
    const priorItem = projection.items[0]
    expect(projection.items[1]).toMatchObject({ kind: 'activity', entries: [opening, status, tool] })

    projection.append([...log, result])
    expect(projection.items.map(item => item.id)).toEqual(['prefix', 'thinking', 'status', 'tool', 'notice'])
    expect(projection.items[0]).toBe(priorItem)
    expect(projection.findPair('status')).toEqual({ call: status, result })
    expect(projection.findPair('result')).toBe(projection.findPair('status'))
    expect(projection.items).toEqual(project([...log, result]).items)
  })

  it('matches the latest unresolved duplicate tool ID and legacy name fallback', () => {
    const old = row('old', 'tool_call', { tool_id: 'duplicate' })
    const newest = row('new', 'tool_call', { tool_id: 'duplicate' })
    const legacy = row('legacy', 'tool_call', { name: 'same' })
    const idResult = row('id-result', 'tool_result', { tool_use_id: 'duplicate' })
    const nameResult = row('name-result', 'tool_result', { tool_use_id: 'wrong', name: 'same' })
    const projection = project([old, legacy])
    projection.append([old, legacy, newest, idResult, nameResult])
    expect(projection.findPair('old')).toBeUndefined()
    expect(projection.findPair('new')).toEqual({ call: newest, result: idResult })
    expect(projection.findPair('legacy')).toEqual({ call: legacy, result: nameResult })
  })

  it('updates only the owning activity when a delayed image result arrives', () => {
    const first = row('call', 'tool_call', { tool_id: 'image', name: 'fs_read' })
    const log = [row('step', 'thinking'), first, row('text'), row('other1', 'thinking'), row('other2', 'thinking')]
    const projection = project(log)
    const group = projection.groupFor(first.id)!
    const other = projection.groupFor('other1')!
    const revision = group.revision
    const otherRevision = other.revision
    expect(group.hasImage).toBe(false)
    projection.append([...log, row('image', 'tool_result', { tool_use_id: 'image', imageUrl: 'adf-file:///image.png' })])
    expect(projection.groupFor(first.id)).toBe(group)
    expect(group.hasImage).toBe(true)
    expect(group.revision).toBeGreaterThan(revision)
    expect(other.revision).toBe(otherRevision)
  })

  it('maps only expanded large groups to viewport rows across the archive boundary', () => {
    const archive = project([row('arch-opening'), ...Array.from({ length: 90 }, (_, i) => row(`arch-${i}`, 'thinking'))])
    const live = project([row('opening'), ...Array.from({ length: 120 }, (_, i) => row(`live-${i}`, 'thinking')), row('last')])
    const all = createTranscriptRows(archive, live, boundary, () => true)
    expect(all.count).toBe(216)
    expect(all.rowAt(0)?.key).toBe('arch-opening')
    expect(all.rowAt(1)).toMatchObject({ key: 'activity:arch-0', windowed: true })
    expect(all.rowAt(2)).toMatchObject({ key: 'arch-0', child: 0 })
    expect(all.rowAt(92)?.key).toBe('archive-end')
    expect(all.rowAt(93)?.key).toBe('opening')
    expect(all.indexOf('live-60')).toBe(155)
    expect(all.rowAt(155)).toMatchObject({ key: 'live-60', child: 60 })
    expect(all.rowAt(215)?.key).toBe('last')
    const folded = createTranscriptRows(archive, live, boundary, () => false)
    expect(folded.count).toBe(6)
    expect(folded.indexOf('live-60')).toBe(4)
    expect(folded.rowAt(4)).toMatchObject({ key: 'activity:live-0' })
  })

  it('retains the scroll anchor when a prepended context row absorbs the old top', () => {
    const meta = { category: 'provider_context', addedBy: 'Claude' }
    const top = row('old-top', 'context', meta)
    const prepended = row('prior', 'context', meta)
    const plan = createTranscriptRows(project([]), project([prepended, top]), boundary, () => false)
    expect(plan.indexOf('old-top')).toBe(0)
    expect(plan.rowAt(0)?.key).toBe('prior')
  })
})

describe('projection generations', () => {
  it('reuses an appended and streamed tail, but invalidates when an earlier row changes', () => {
    const state = () => useAgentStore.getState()
    const epoch = state().logAppendGeneration
    state().addLogEntry(row('text', 'text'))
    state().updateLastEntry(entry => { entry.content += ' tail' })
    state().addLogEntry(row('next', 'thinking'))
    expect(state().logAppendGeneration).toBe(epoch)
    state().updateEntryAt(0, entry => { entry.content += ' correction' })
    const edited = state().logAppendGeneration
    expect(edited).not.toBe(epoch)
    state().prependLog([row('earlier')], 0)
    expect(state().logAppendGeneration).not.toBe(edited)
    expect(state().log.map(entry => entry.id)).toEqual(['earlier', 'text', 'next'])
  })
})
