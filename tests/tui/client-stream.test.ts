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
    expect(text.frames[0].event).toMatchObject({ event_type: 'turn.delta', agent_id: AGENT, payload: { kind: 'text', text: 'Hello' } })
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

  it('chat_updated reloads that loop; host and push frames need nothing here', () => {
    expect(clientFrameEffects(exec('chat_updated', { uiLog: [] }, { loop: 'critic' })).reload).toEqual({ agentId: AGENT, loop: 'critic' })
    expect(clientFrameEffects({ kind: 'host', cursor: 1, agentId: AGENT, filePath: null, type: 'agent_started', payload: {}, timestamp: 1 } as ClientFrame)).toEqual({ frames: [] })
    expect(clientFrameEffects({ kind: 'push', cursor: 1, agentId: null, filePath: null, topic: 'templates', payload: {} } as ClientFrame)).toEqual({ frames: [] })
  })
})
