import { describe, expect, it } from 'vitest'
import { initialState, tuiReducer, type TuiAction } from '../../src/main/tui/state/reducer'
import { historyToItems, mergeHistory, applyEventToItems, prependHistory } from '../../src/main/tui/state/transcript'
import { transcriptKey, type TranscriptItem, type TuiState } from '../../src/main/tui/state/types'
import type { DaemonEventFrame, LoopEntry, UmbilicalEvent } from '../../src/main/tui/api/types'

const AGENT = '6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f'

function reduce(state: TuiState, ...actions: TuiAction[]): TuiState {
  return actions.reduce(tuiReducer, state)
}

let seq = 0
function frame(event_type: string, payload: Record<string, unknown> = {}, loop?: string): DaemonEventFrame {
  seq += 1
  const event: UmbilicalEvent = { seq, event_type, timestamp: 1_000 + seq, source: 'agent:t1', agent_id: AGENT, payload, ...(loop ? { loop } : {}) }
  return { cursor: seq, event }
}

function loaded(): TuiState {
  return reduce(
    initialState('http://127.0.0.1:7385'),
    { type: 'agents/loaded', agents: [{ id: AGENT, filePath: null, name: 'agent-1', handle: 'agent-1', autostart: false }] },
    {
      type: 'loops/loaded',
      agentId: AGENT,
      loops: [
        { name: 'main', goal: '', status: 'idle', enabled: true, isMain: true, config: null, entryCount: 0, effectiveTools: null },
        { name: 'consolidator', goal: 'Consolidate memories.', status: 'idle', enabled: true, isMain: false, config: { name: 'consolidator', goal: 'Consolidate memories.', enabled: true }, entryCount: 0, effectiveTools: [] },
      ],
    },
  )
}

describe('transcript model', () => {
  it('builds items from persisted loop rows, labelling inter-loop deliveries', () => {
    const entries: LoopEntry[] = [
      { seq: 1, role: 'user', content_json: [{ type: 'text', text: 'hello' }], created_at: 1 },
      { seq: 2, role: 'assistant', content_json: [{ type: 'thinking', thinking: 'hmm' }, { type: 'tool_use', id: 'tu1', name: 'fs_read', input: { path: 'mind.md' } }], created_at: 2 },
      { seq: 3, role: 'user', content_json: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'facts' }], created_at: 3 },
      { seq: 4, role: 'user', content_json: [{ type: 'text', text: '[from loop:consolidator] mind.md updated' }], created_at: 4 },
      { seq: 5, role: 'assistant', content_json: [{ type: 'text', text: 'Done.' }], created_at: 5 },
    ]
    const items = historyToItems(entries)
    expect(items.map(i => i.kind)).toEqual(['user', 'thinking', 'tool', 'user', 'assistant'])
    expect(items[2]).toEqual(expect.objectContaining({ kind: 'tool', name: 'fs_read', status: 'ok', result: 'facts' }))
    expect(items[3]).toEqual(expect.objectContaining({ kind: 'user', origin: 'loop', from: 'consolidator', text: 'mind.md updated' }))
  })

  it('streams deltas into one assistant item and finalizes on turn.completed', () => {
    let items: TranscriptItem[] = []
    for (const text of ['Hel', 'lo']) items = applyEventToItems(items, frame('turn.delta', { kind: 'text', text }).event)
    expect(items).toHaveLength(1)
    expect(items[0]).toEqual(expect.objectContaining({ kind: 'assistant', text: 'Hello', streaming: true }))
    items = applyEventToItems(items, frame('turn.completed', { content: 'Hello' }).event)
    expect(items).toEqual([expect.objectContaining({ kind: 'assistant', text: 'Hello', streaming: false })])
  })

  it('reconciles history without dropping HIL items or unpersisted sends', () => {
    const local: TranscriptItem[] = [
      { id: 'l1', at: 10, local: true, kind: 'user', text: 'persisted', origin: 'owner', pending: true },
      { id: 'l2', at: 11, local: true, kind: 'hil', taskId: 't1', tool: 'msg_send', input: {}, status: 'pending' },
      { id: 'l3', at: 12, local: true, kind: 'user', text: 'still in flight', origin: 'owner', pending: true },
    ]
    const history = historyToItems([{ seq: 7, role: 'user', content_json: [{ type: 'text', text: 'persisted' }], created_at: 10 }])
    const merged = mergeHistory(local, history)
    expect(merged.map(i => i.id)).toEqual(['h:loop-7-0', 'l2', 'l3'])
  })
})

describe('reducer: loop-aware event ingestion', () => {
  it('routes events by envelope loop into per-(agent, loop) transcripts', () => {
    const state = reduce(
      loaded(),
      { type: 'event', frame: frame('turn.delta', { kind: 'text', text: 'main says hi' }) },
      { type: 'event', frame: frame('turn.delta', { kind: 'text', text: 'consolidating' }, 'consolidator') },
    )
    expect(state.transcripts[transcriptKey(AGENT, 'main')].items).toEqual([expect.objectContaining({ text: 'main says hi' })])
    expect(state.transcripts[transcriptKey(AGENT, 'consolidator')].items).toEqual([expect.objectContaining({ text: 'consolidating' })])
    expect(state.activity.map(a => a.loop)).toEqual(['main', 'consolidator'])
  })

  it('applies a loop-stamped state change to that loop, not to the agent', () => {
    const state = reduce(loaded(), { type: 'event', frame: frame('agent.state.changed', { state: 'thinking' }, 'consolidator') })
    const agent = state.agents[AGENT]
    expect(agent.executorState).toBeUndefined()
    expect(agent.loops?.[1]).toEqual(expect.objectContaining({ executorState: 'thinking', info: expect.objectContaining({ status: 'running' }) }))
  })

  it('tracks pending approvals and asks from HIL events', () => {
    let state = reduce(
      loaded(),
      { type: 'event', frame: frame('hil.requested', { request_id: 't9', task_id: 't9', tool: 'msg_send', input: { to: 'agent-2' }, reason: 'restricted' }) },
      { type: 'event', frame: frame('ask.requested', { request_id: 'q1', question: 'Proceed?' }, 'consolidator') },
    )
    expect(state.agents[AGENT].pendingTasks.map(t => t.id)).toEqual(['t9'])
    expect(state.agents[AGENT].pendingAsks.map(a => a.requestId)).toEqual(['q1'])
    expect(state.transcripts[transcriptKey(AGENT, 'consolidator')].items[0]).toEqual(expect.objectContaining({ kind: 'ask', question: 'Proceed?' }))
    state = reduce(state, { type: 'event', frame: frame('hil.resolved', { request_id: 't9', task_id: 't9', approved: true }) })
    expect(state.agents[AGENT].pendingTasks).toEqual([])
    expect(state.transcripts[transcriptKey(AGENT, 'main')].items[0]).toEqual(expect.objectContaining({ kind: 'hil', status: 'approved' }))
  })

  it('falls back to main when the selected loop disappears', () => {
    let state = reduce(loaded(), { type: 'select/loop', agentId: AGENT, loop: 'consolidator' })
    expect(state.selectedLoop[AGENT]).toBe('consolidator')
    state = reduce(state, { type: 'loops/loaded', agentId: AGENT, loops: [state.agents[AGENT].loops![0].info] })
    expect(state.selectedLoop[AGENT]).toBeUndefined()
  })
})

describe('loop-aware robustness', () => {
  it('keeps asks with the same id apart per loop', () => {
    let state = loaded()
    state = reduce(state,
      { type: 'event', frame: frame('ask.requested', { request_id: 'ask_1', question: 'main question?' }) },
      { type: 'event', frame: frame('ask.requested', { request_id: 'ask_1', question: 'researcher question?' }, 'consolidator') },
    )
    expect(state.agents[AGENT].pendingAsks).toEqual([
      { requestId: 'ask_1', question: 'main question?', loop: 'main' },
      { requestId: 'ask_1', question: 'researcher question?', loop: 'consolidator' },
    ])
    state = reduce(state, { type: 'event', frame: frame('ask.resolved', { request_id: 'ask_1' }) })
    expect(state.agents[AGENT].pendingAsks).toEqual([{ requestId: 'ask_1', question: 'researcher question?', loop: 'consolidator' }])
  })

  it('clears a stale running flag when the loop goes idle or stops without turn.completed', () => {
    const key = transcriptKey(AGENT, 'main')
    let state = reduce(loaded(),
      { type: 'event', frame: frame('turn.delta', { kind: 'text', text: 'partial' }) },
      { type: 'event', frame: frame('tool.started', { id: 'tu1', name: 'fs_read' }) },
    )
    expect(state.transcripts[key].live).toBe(true)
    state = reduce(state, { type: 'event', frame: frame('agent.state.changed', { state: 'stopped' }) })
    expect(state.transcripts[key].live).toBe(false)
    expect(state.transcripts[key].items.some(i => (i.kind === 'assistant' || i.kind === 'thinking') && i.streaming)).toBe(false)

    state = reduce(state, { type: 'event', frame: frame('turn.delta', { kind: 'text', text: 'again' }, 'consolidator') })
    expect(state.transcripts[transcriptKey(AGENT, 'consolidator')].live).toBe(true)
    state = reduce(state, { type: 'transcript/idle', key: transcriptKey(AGENT, 'consolidator') })
    expect(state.transcripts[transcriptKey(AGENT, 'consolidator')].live).toBe(false)
  })

  it('folds a tool result on a newer page back into its call on an older page', () => {
    const older = historyToItems([
      { seq: 1, role: 'assistant', content_json: [{ type: 'tool_use', id: 'tu1', name: 'fs_read', input: { path: 'mind.md' } }], created_at: 1 },
    ])
    const newer = historyToItems([
      { seq: 2, role: 'user', content_json: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'facts' }], created_at: 2 },
      { seq: 3, role: 'assistant', content_json: [{ type: 'text', text: 'done' }], created_at: 3 },
    ])
    expect(newer.filter(i => i.kind === 'tool')).toHaveLength(1)
    const merged = prependHistory(newer, older)
    const tools = merged.filter(i => i.kind === 'tool')
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({ kind: 'tool', toolUseId: 'tu1', status: 'ok', result: 'facts', input: { path: 'mind.md' } })
  })
})
