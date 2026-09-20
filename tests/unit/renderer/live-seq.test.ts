import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useAgentStore, selectLoopSlice, type AgentLogEntry } from '../../../src/renderer/stores/agent.store'
import { useDocumentStore } from '../../../src/renderer/stores/document.store'
import { createAgentEventHandler } from '../../../src/renderer/hooks/useAgent'
import { pickOldestSeq, pendingBlockIndexes, pendingToolResultIndexes } from '../../../src/renderer/hooks/live-seq'
import { parseLoopToDisplay } from '../../../src/shared/utils/loop-parser'
import type { AgentExecutionEvent } from '../../../src/shared/types/ipc.types'
import type { LoopEntry } from '../../../src/shared/types/adf-v02.types'

/**
 * The transcript has two sources: rows rehydrated from `adf_loop` through
 * `parseLoopToDisplay`, and entries appended live from streaming events. Only
 * the first carried `metadata.seq`, so "Load earlier" — which pages by keyset
 * on the seq of the oldest loaded entry — had no cursor at all once a long
 * session had streamed past its loaded head.
 *
 * The contract these tests pin down is that the two sources are now
 * indistinguishable to that cursor: the same turn, delivered live or read back
 * from the loop table, produces the same `metadata.seq` on the same entries.
 * One loop ROW can expand into several display entries, and every entry it
 * produces shares that row's seq — including the text and thinking blocks the
 * renderer streamed into place before the row existed.
 */

const noop = () => {}

beforeEach(() => {
  useAgentStore.getState().reset()
  useDocumentStore.getState().reset()
  vi.stubGlobal('window', {
    adfApi: {
      getDocument: () => Promise.resolve({ content: '' }),
      getHeader: () => Promise.resolve({ document: '', agentConfig: null, statusText: '' }),
      getAgentConfig: () => Promise.resolve(null),
      invokeAgent: noop
    }
  })
})

/** The turn, as the main process persists it — one row per model step. */
const LOOP_ROWS: LoopEntry[] = [
  {
    seq: 10,
    role: 'user',
    created_at: 1000,
    content_json: [{ type: 'text', text: 'Write the notes file.' }]
  },
  {
    seq: 11,
    role: 'assistant',
    created_at: 1001,
    model: 'test-model',
    content_json: [
      { type: 'thinking', thinking: 'Needs a file.' },
      { type: 'text', text: "I'll write it." },
      { type: 'tool_use', id: 'call-1', name: 'fs_write', input: { path: 'notes.md', content: 'x' } }
    ]
  },
  {
    seq: 12,
    role: 'user',
    created_at: 1002,
    content_json: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'Successfully wrote "notes.md"', is_error: false }]
  },
  {
    seq: 13,
    role: 'assistant',
    created_at: 1003,
    model: 'test-model',
    content_json: [
      { type: 'thinking', thinking: 'Done now.' },
      { type: 'text', text: 'Written.' }
    ]
  }
]

/** The same turn as it arrives live, event by event, in emission order. */
const LIVE_EVENTS: AgentExecutionEvent[] = [
  { type: 'trigger_message', timestamp: 1000, payload: { content: 'Write the notes file.', triggerType: 'chat', seq: 10 } },
  { type: 'thinking_delta', timestamp: 1001, payload: { delta: 'Needs a file.' } },
  { type: 'text_delta', timestamp: 1001, payload: { delta: "I'll write it." } },
  // Emitted only after the assistant ROW is written through to SQLite, so it
  // can hand the renderer that row's seq — for the tool call AND for the two
  // blocks streamed ahead of it.
  { type: 'tool_call_start', timestamp: 1001, payload: { name: 'fs_write', input: { path: 'notes.md', content: 'x' }, id: 'call-1', seq: 11 } },
  {
    type: 'tool_call_result',
    timestamp: 1002,
    payload: {
      name: 'fs_write',
      id: 'call-1',
      result: { content: 'Successfully wrote "notes.md"', isError: false },
      targetPaths: ['notes.md'],
      documentPath: 'README.md'
    }
  },
  // The batch's results were shown one by one; they all live in row 12, which
  // only exists now.
  { type: 'loop_seq', timestamp: 1002, payload: { seq: 12, toolUseIds: ['call-1'] } },
  { type: 'thinking_delta', timestamp: 1003, payload: { delta: 'Done now.' } },
  { type: 'text_delta', timestamp: 1003, payload: { delta: 'Written.' } },
  { type: 'turn_complete', timestamp: 1003, payload: { content: [], seq: 13 } }
]

function playLive(events: AgentExecutionEvent[] = LIVE_EVENTS): AgentLogEntry[] {
  const handle = createAgentEventHandler()
  for (const event of events) handle(event)
  return selectLoopSlice(useAgentStore.getState()).log
}

describe('live entries carry the same adf_loop seq as hydrated ones', () => {
  it('produces the same (type, seq) sequence as parseLoopToDisplay', () => {
    const live = playLive()
    const hydrated = parseLoopToDisplay(LOOP_ROWS)

    const shape = (entries: Array<{ type: string; metadata?: Record<string, unknown> }>) =>
      entries.map((e) => `${e.type}:${e.metadata?.seq}`)

    expect(shape(live)).toEqual(shape(hydrated))
    expect(shape(live)).toEqual([
      'user:10',
      'thinking:11',
      'text:11',
      'tool_call:11',
      'tool_result:12',
      'thinking:13',
      'text:13'
    ])
  })

  it('leaves no live entry without a seq', () => {
    for (const entry of playLive()) {
      expect(typeof entry.metadata?.seq, `${entry.type} has no seq`).toBe('number')
    }
  })

  it('keeps everything else about the entries untouched', () => {
    const live = playLive()
    expect(live.map((e) => e.content)).toEqual([
      'Write the notes file.',
      'Needs a file.',
      "I'll write it.",
      'Calling fs_write',
      'Successfully wrote "notes.md"',
      'Done now.',
      'Written.'
    ])
    // The tool call still carries its input and id for the inspector.
    const call = live.find((e) => e.type === 'tool_call')!
    expect(call.metadata?.name).toBe('fs_write')
    expect(call.metadata?.tool_id).toBe('call-1')
  })

  it('does not renumber an entry that was already stamped', () => {
    const handle = createAgentEventHandler()
    handle({ type: 'text_delta', timestamp: 1, payload: { delta: 'hi' } })
    handle({ type: 'turn_complete', timestamp: 1, payload: { content: [], seq: 7 } })
    handle({ type: 'turn_complete', timestamp: 2, payload: { content: [], seq: 99 } })
    expect(selectLoopSlice(useAgentStore.getState()).log[0].metadata?.seq).toBe(7)
  })

  it('stamps a side loop without touching main', () => {
    const handle = createAgentEventHandler()
    handle({ type: 'text_delta', timestamp: 1, payload: { delta: 'main' } })
    handle({ type: 'text_delta', timestamp: 1, loop: 'agent-1', payload: { delta: 'side' } })
    handle({ type: 'turn_complete', timestamp: 1, loop: 'agent-1', payload: { content: [], seq: 42 } })

    const store = useAgentStore.getState()
    expect(selectLoopSlice(store, 'agent-1').log[0].metadata?.seq).toBe(42)
    expect(selectLoopSlice(store).log[0].metadata?.seq).toBeUndefined()
  })

  it('costs no structural recomputation — a seq stamp redraws nothing', () => {
    const handle = createAgentEventHandler()
    handle({ type: 'text_delta', timestamp: 1, payload: { delta: 'hi' } })
    const before = selectLoopSlice(useAgentStore.getState()).structuralVersion
    handle({ type: 'turn_complete', timestamp: 1, payload: { content: [], seq: 5 } })
    const after = selectLoopSlice(useAgentStore.getState())
    expect(after.structuralVersion).toBe(before)
    expect(after.log[0].metadata?.seq).toBe(5)
  })
})

describe('pendingBlockIndexes — which streamed blocks belong to the row', () => {
  const entry = (type: AgentLogEntry['type'], seq?: number): AgentLogEntry =>
    ({ id: type + (seq ?? 'x'), type, content: '', timestamp: 0, metadata: seq === undefined ? undefined : { seq } })

  it('takes the contiguous unstamped text/thinking run at the tail', () => {
    const log = [entry('tool_result', 4), entry('thinking'), entry('text')]
    expect(pendingBlockIndexes(log)).toEqual([1, 2])
  })

  it('stops at a row boundary — an earlier row is never reached', () => {
    const log = [entry('text'), entry('tool_call', 3), entry('text')]
    expect(pendingBlockIndexes(log)).toEqual([2])
  })

  it('stops at an already-stamped block', () => {
    const log = [entry('text', 3), entry('text')]
    expect(pendingBlockIndexes(log)).toEqual([1])
  })

  it('is empty when the tail is not a streamed block', () => {
    expect(pendingBlockIndexes([entry('text'), entry('tool_call')])).toEqual([])
    expect(pendingBlockIndexes([])).toEqual([])
  })
})

describe('pendingToolResultIndexes — results of one persisted batch', () => {
  const result = (id: string, seq?: number): AgentLogEntry =>
    ({ id: 'e' + id, type: 'tool_result', content: '', timestamp: 0, metadata: { tool_use_id: id, ...(seq !== undefined ? { seq } : {}) } })

  it('finds every unstamped result of the batch, in log order', () => {
    const log = [result('a'), result('b')]
    expect(pendingToolResultIndexes(log, ['a', 'b'])).toEqual([0, 1])
  })

  it('skips results that already have a seq and ids not in the batch', () => {
    const log = [result('a', 8), result('b'), result('c')]
    expect(pendingToolResultIndexes(log, ['a', 'b'])).toEqual([1])
  })

  it('is empty for an empty batch', () => {
    expect(pendingToolResultIndexes([result('a')], [])).toEqual([])
  })
})

describe('pickOldestSeq — the "load earlier" cursor', () => {
  it('works on a window made ONLY of live-appended entries', () => {
    const live = playLive()
    // Nothing here came from parseLoopToDisplay, yet the window still names
    // the oldest row it holds.
    expect(pickOldestSeq(live)).toBe(10)
  })

  it('is the first entry once everything is stamped', () => {
    const hydrated = parseLoopToDisplay(LOOP_ROWS)
    expect(pickOldestSeq(hydrated)).toBe(hydrated[0].metadata?.seq)
  })

  it('scans past an unstamped head instead of giving up', () => {
    const log = [
      { metadata: { quietTurn: true } },
      { metadata: undefined },
      { metadata: { seq: 31 } },
      { metadata: { seq: 32 } }
    ]
    expect(pickOldestSeq(log)).toBe(31)
  })

  it('returns undefined only when nothing in the window has a seq', () => {
    expect(pickOldestSeq([{ metadata: undefined }, {}])).toBeUndefined()
    expect(pickOldestSeq([])).toBeUndefined()
  })
})
