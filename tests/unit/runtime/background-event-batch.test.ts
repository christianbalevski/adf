import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { BackgroundEventBatcher, stripForRenderer } from '../../../src/main/ipc/background-event-batch'
import type { BackgroundAgentEvent } from '../../../src/shared/types/ipc.types'

const AGENT_1 = 'C:/agents/agent-1.adf'
const AGENT_2 = 'C:/agents/agent-2.adf'

function stateChange(filePath: string, state: string): BackgroundAgentEvent {
  return {
    type: 'agent_state_changed',
    payload: { filePath, state: state as BackgroundAgentEvent['payload']['state'] },
    timestamp: 1
  }
}

function toolStart(filePath: string, name: string): BackgroundAgentEvent {
  return { type: 'tool_call_start', payload: { filePath, name, id: 't1' }, timestamp: 1 }
}

function toolResult(filePath: string, name: string, content: string, isError = false): BackgroundAgentEvent {
  return {
    type: 'tool_call_result',
    payload: { filePath, name, id: 't1', result: { content, isError }, imageUrl: 'data:image/png;base64,AAAA' },
    timestamp: 1
  }
}

describe('BackgroundEventBatcher', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('coalesces a window of events into one send', () => {
    const send = vi.fn()
    const batcher = new BackgroundEventBatcher(send, 50)

    batcher.push(toolStart(AGENT_1, 'fs_read'))
    batcher.push(toolStart(AGENT_2, 'fs_read'))
    expect(send).not.toHaveBeenCalled()

    vi.advanceTimersByTime(50)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toHaveLength(2)
  })

  it('collapses only equal-valued repeat state changes per agent', () => {
    const send = vi.fn()
    const batcher = new BackgroundEventBatcher(send, 50)

    batcher.push(stateChange(AGENT_1, 'active'))
    batcher.push(stateChange(AGENT_1, 'active'))
    batcher.push(stateChange(AGENT_2, 'active'))
    batcher.push(stateChange(AGENT_1, 'active'))
    batcher.push(stateChange(AGENT_2, 'active'))
    vi.advanceTimersByTime(50)

    const events = send.mock.calls[0][0] as BackgroundAgentEvent[]
    expect(events).toHaveLength(2)
    expect(events[0].payload).toMatchObject({ filePath: AGENT_1, state: 'active' })
    expect(events[1].payload).toMatchObject({ filePath: AGENT_2, state: 'active' })
  })

  it('keeps a state round-trip inside one window so the turn boundary survives', () => {
    const send = vi.fn()
    const batcher = new BackgroundEventBatcher(send, 50)

    // The renderer feed dedupes consecutive identical entries, so collapsing
    // active → idle → active to a single `active` would erase the turn.
    batcher.push(stateChange(AGENT_1, 'active'))
    batcher.push(stateChange(AGENT_1, 'idle'))
    batcher.push(stateChange(AGENT_1, 'active'))
    vi.advanceTimersByTime(50)

    const events = send.mock.calls[0][0] as BackgroundAgentEvent[]
    expect(events.map((e) => e.payload.state)).toEqual(['active', 'idle', 'active'])
  })

  it('interleaves distinct-value transitions from two agents in arrival order', () => {
    const send = vi.fn()
    const batcher = new BackgroundEventBatcher(send, 50)

    batcher.push(stateChange(AGENT_1, 'idle'))
    batcher.push(stateChange(AGENT_2, 'active'))
    batcher.push(stateChange(AGENT_1, 'active'))
    batcher.push(stateChange(AGENT_2, 'active'))
    vi.advanceTimersByTime(50)

    const events = send.mock.calls[0][0] as BackgroundAgentEvent[]
    expect(events.map((e) => [e.payload.filePath, e.payload.state])).toEqual([
      [AGENT_1, 'idle'],
      [AGENT_2, 'active'],
      [AGENT_1, 'active']
    ])
  })

  it('keeps discrete events in order and reopens a collapse slot after them', () => {
    const send = vi.fn()
    const batcher = new BackgroundEventBatcher(send, 50)

    batcher.push(stateChange(AGENT_1, 'active'))
    batcher.push(toolStart(AGENT_1, 'fs_read'))
    batcher.push(toolResult(AGENT_1, 'fs_read', 'x'))
    batcher.push(stateChange(AGENT_1, 'idle'))
    vi.advanceTimersByTime(50)

    const events = send.mock.calls[0][0] as BackgroundAgentEvent[]
    expect(events.map((e) => e.type)).toEqual([
      'agent_state_changed', 'tool_call_start', 'tool_call_result', 'agent_state_changed'
    ])
    expect(events[0].payload.state).toBe('active')
    expect(events[3].payload.state).toBe('idle')
  })

  it('flushes immediately on lifecycle events, carrying the buffer with them', () => {
    const send = vi.fn()
    const batcher = new BackgroundEventBatcher(send, 50)

    batcher.push(stateChange(AGENT_1, 'active'))
    batcher.push({ type: 'agent_stopped', payload: { filePath: AGENT_1 }, timestamp: 1 })

    expect(send).toHaveBeenCalledTimes(1)
    const events = send.mock.calls[0][0] as BackgroundAgentEvent[]
    expect(events.map((e) => e.type)).toEqual(['agent_state_changed', 'agent_stopped'])
  })

  it('drains buffered events and drops the timer on dispose', () => {
    const send = vi.fn()
    const batcher = new BackgroundEventBatcher(send, 50)

    batcher.push(stateChange(AGENT_1, 'active'))
    batcher.dispose()
    expect(send).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(500)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('sends post-dispose events immediately instead of re-arming a timer', () => {
    const send = vi.fn()
    const batcher = new BackgroundEventBatcher(send, 50)

    batcher.dispose()
    batcher.push({ type: 'agent_stopped', payload: { filePath: AGENT_1 }, timestamp: 1 })
    expect(send).toHaveBeenCalledTimes(1)
    expect((send.mock.calls[0][0] as BackgroundAgentEvent[])[0].type).toBe('agent_stopped')

    // A buffered-looking event must not leave a live timer behind either
    batcher.push(stateChange(AGENT_1, 'idle'))
    expect(send).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('unrefs the batch timer so it never holds the process open', () => {
    const send = vi.fn()
    const unref = vi.fn()
    const spy = vi.spyOn(globalThis, 'setTimeout').mockReturnValue({ unref } as never)
    try {
      new BackgroundEventBatcher(send, 50).push(stateChange(AGENT_1, 'active'))
    } finally {
      spy.mockRestore()
    }
    expect(unref).toHaveBeenCalledTimes(1)
  })

  it('does not send empty batches', () => {
    const send = vi.fn()
    const batcher = new BackgroundEventBatcher(send, 50)
    batcher.flush()
    batcher.dispose()
    expect(send).not.toHaveBeenCalled()
  })
})

describe('stripForRenderer', () => {
  it('replaces tool result content with an error flag and size', () => {
    const stripped = stripForRenderer(toolResult(AGENT_1, 'fs_read', 'z'.repeat(64_000), true))
    expect(stripped.payload).toEqual({
      filePath: AGENT_1,
      name: 'fs_read',
      id: 't1',
      result: { isError: true },
      resultSize: 64_000
    })
    expect(JSON.stringify(stripped).length).toBeLessThan(300)
  })

  it('leaves other event types untouched', () => {
    const event = toolStart(AGENT_1, 'fs_read')
    expect(stripForRenderer(event)).toBe(event)
  })
})
