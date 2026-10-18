// Client-session frames → the terminal app's state model (state/client-stream.ts).
import { describe, expect, it } from 'vitest'
import { clientFrameEffects } from '../../src/main/tui/state/client-stream'
import { initialState, tuiReducer, type TuiAction } from '../../src/main/tui/state/reducer'
import { transcriptKey, type TuiState } from '../../src/main/tui/state/types'
import type { ClientFrame } from '../../src/main/tui/api/types'

const AGENT = '6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f'

const exec = (type: string, payload: unknown, extra: Record<string, unknown> = {}): ClientFrame =>
  ({ kind: 'executor', cursor: 1, agentId: AGENT, filePath: null, event: { type, payload, timestamp: 5 }, ...extra }) as ClientFrame

function reduce(state: TuiState, ...actions: TuiAction[]): TuiState {
  return actions.reduce(tuiReducer, state)
}

describe('client-session frames for the terminal app', () => {
  it('umbilical frames pass through unchanged', () => {
    const event = { seq: 3, event_type: 'agent.state.changed', timestamp: 1, source: 'agent:x', agent_id: AGENT, payload: { state: 'thinking' } }
    expect(clientFrameEffects({ kind: 'umbilical', cursor: 9, agentId: AGENT, event } as ClientFrame)).toEqual({ frames: [{ cursor: 9, event }] })
  })

  it('delta batches become turn.delta for the reducer, routed by loop', () => {
    const text = clientFrameEffects(exec('text_delta_batch', { deltas: ['Hel', 'lo'] }))
    expect(text.frames[0].event).toMatchObject({ event_type: 'turn.delta', agent_id: AGENT, seq: 1, payload: { kind: 'text', text: 'Hello' } })
    expect(text.frames[0].synthetic).toBe(true)
    expect(text.frames[0].event).not.toHaveProperty('loop')
    const thinking = clientFrameEffects(exec('thinking_delta_batch', { deltas: ['hmm'] }, { loop: 'critic' }))
    expect(thinking.frames[0].event).toMatchObject({ event_type: 'turn.delta', loop: 'critic', payload: { kind: 'thinking', text: 'hmm' } })
    expect(clientFrameEffects(exec('text_delta_batch', { deltas: [] })).frames).toEqual([])
  })

  it('a full tool result replaces the truncated tool.completed copy; a stripped one is ignored', () => {
    const full = 'x'.repeat(70_000)
    const effects = clientFrameEffects(exec('tool_call_result', { name: 'fs_read', id: 'tu1', result: { content: full, isError: false } }))
    expect(effects.toolResult).toEqual({ agentId: AGENT, loop: 'main', toolUseId: 'tu1', result: full, isError: false })
    expect(clientFrameEffects(exec('tool_call_result', { name: 'fs_read', id: 'tu1', result: { isError: false }, resultSize: 5 }, { stripped: 'tool_result' }))).toEqual({ frames: [] })

    const key = transcriptKey(AGENT, 'main')
    const state = reduce(
      initialState('http://127.0.0.1:7385'),
      { type: 'transcript/append', key, item: { id: 't1', at: 1, local: true, kind: 'tool', toolUseId: 'tu1', name: 'fs_read', input: {}, status: 'ok', result: 'xxx\n[truncated]' } },
      { type: 'tool/result', key, toolUseId: 'tu1', result: full, isError: false },
    )
    expect(state.transcripts[key].items[0]).toMatchObject({ result: full, status: 'ok' })
  })

  it('a backgrounded call stays running on its task reference; the real result arrives as tool.completed', () => {
    const key = transcriptKey(AGENT, 'main')
    const ref = JSON.stringify({ task_id: 'task_abc123', status: 'running', tool: 'sys_code' })
    // Live items come from tool.started, whose input has `_async` stripped.
    const started = reduce(
      initialState('http://127.0.0.1:7385'),
      { type: 'transcript/append', key, item: { id: 't1', at: 1, local: true, kind: 'tool', toolUseId: 'tu1', name: 'sys_code', input: { code: 'x' }, status: 'running' } },
      { type: 'tool/result', key, toolUseId: 'tu1', result: ref, isError: false },
    )
    const item = started.transcripts[key].items[0]
    expect(item).toMatchObject({ status: 'running', async: true, taskRef: ref })
    expect(item).not.toHaveProperty('completedAt')
    expect((item as { result?: string }).result).toBeUndefined()
    // A fast call whose tool.completed came first keeps its real result.
    const done = reduce(
      initialState('http://127.0.0.1:7385'),
      { type: 'transcript/append', key, item: { id: 't1', at: 1, local: true, kind: 'tool', toolUseId: 'tu1', name: 'sys_code', input: {}, status: 'ok', result: 'real', completedAt: 2 } },
      { type: 'tool/result', key, toolUseId: 'tu1', result: ref, isError: false },
    )
    expect(done.transcripts[key].items[0]).toMatchObject({ status: 'ok', result: 'real', taskRef: ref })
  })

  it('synthetic deltas stream into the transcript but stay out of the activity log and the event tail; daemon turn.delta still lands there', () => {
    const key = transcriptKey(AGENT, 'main')
    const base = reduce(initialState('http://127.0.0.1:7385'), { type: 'agents/loaded', agents: [{ id: AGENT, filePath: null, name: 'agent-1', handle: 'agent-1', autostart: false }] })
    const synthetic = clientFrameEffects(exec('text_delta_batch', { deltas: ['Hi'] })).frames
    const afterSynthetic = reduce(base, { type: 'events', frames: synthetic })
    expect(afterSynthetic.transcripts[key].items).toEqual([expect.objectContaining({ kind: 'assistant', text: 'Hi', streaming: true })])
    expect(afterSynthetic.activity).toEqual([])
    expect(afterSynthetic.lastEvents).toEqual([])
    // Another agent's umbilical turn.delta (stream_deltas on) is shown as before.
    const umbilical = clientFrameEffects({ kind: 'umbilical', cursor: 2, agentId: AGENT, event: { seq: 7, event_type: 'turn.delta', timestamp: 1, source: 'agent:t', agent_id: AGENT, payload: { kind: 'text', text: '!' } } } as ClientFrame).frames
    const afterUmbilical = reduce(afterSynthetic, { type: 'events', frames: umbilical })
    expect(afterUmbilical.lastEvents.map(e => e.event_type)).toEqual(['turn.delta'])
    expect(afterUmbilical.activity).toHaveLength(1)
  })

  it('daemon_orphan_hold becomes a notice', () => {
    expect(clientFrameEffects({ kind: 'push', cursor: 1, agentId: null, filePath: null, topic: 'daemon_orphan_hold', payload: { holding: true, reason: 'studio closed', sessions: 1 } } as ClientFrame).notice).toEqual({ text: expect.stringContaining('studio closed'), level: 'warn' })
  })

  it('chat_updated reloads that loop; host and push frames need nothing here', () => {
    expect(clientFrameEffects(exec('chat_updated', { uiLog: [] }, { loop: 'critic' })).reload).toEqual({ agentId: AGENT, loop: 'critic' })
    expect(clientFrameEffects({ kind: 'host', cursor: 1, agentId: AGENT, filePath: null, type: 'agent_started', payload: {}, timestamp: 1 } as ClientFrame)).toEqual({ frames: [] })
    expect(clientFrameEffects({ kind: 'push', cursor: 1, agentId: null, filePath: null, topic: 'templates', payload: {} } as ClientFrame)).toEqual({ frames: [] })
  })
})
