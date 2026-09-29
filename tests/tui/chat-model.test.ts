import { describe, expect, it } from 'vitest'
import {
  INITIAL_CHAT_STATE,
  applyMention,
  completeMention,
  cycleLoop,
  digestEvents,
  itemHeight,
  mentionAt,
  offsetOf,
  pendingTasksFor,
  posAt,
  queuedItems,
  revealOffset,
  taskLoop,
  triggerLabel,
  windowAt,
  withMarkers,
  type LoopTab,
} from '../../src/main/tui/views/chat/model'
import { transcriptKey, type AgentEntry, type TranscriptItem } from '../../src/main/tui/state/types'
import type { Timer, UmbilicalEvent } from '../../src/main/tui/api/types'

const AGENT = '6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f'

function ev(seq: number, event_type: string, payload: Record<string, unknown> = {}, loop?: string, timestamp = 1000 + seq): UmbilicalEvent {
  return { seq, event_type, timestamp, source: 'test', agent_id: AGENT, ...(loop ? { loop } : {}), payload } as UmbilicalEvent
}

describe('chat scrolling math', () => {
  const heights = [3, 2, 5, 1, 4]
  const keys = ['a', 'b', 'c', 'd', 'e']

  it('round-trips an offset through a key-anchored position', () => {
    for (const offset of [0, 1, 4, 5, 7, 9]) {
      const pos = posAt(offset, keys, heights, 4)
      expect(offsetOf(pos, keys, heights)).toBe(Math.min(offset, 15 - 4))
    }
    expect(posAt(0, keys, heights, 4)).toEqual({ bottomKey: null, clip: 0 })
  })

  it('keeps the viewport anchored when an older page is prepended', () => {
    const pos = posAt(6, keys, heights, 4)
    expect(offsetOf(pos, ['x', 'y', ...keys], [2, 2, ...heights])).toBe(6)
  })

  it('windows the items that fill the viewport, clipping the bottom one', () => {
    expect(windowAt(heights, 0, 5)).toMatchObject({ start: 3, end: 4, clip: 0 })
    const w = windowAt(heights, 6, 4)
    expect(w.end).toBe(2)
    expect(w.clip).toBe(1)
  })

  it('reveals an item above or below the viewport', () => {
    expect(revealOffset(0, heights, 0, 4)).toBe(11)
    expect(revealOffset(4, heights, 10, 4)).toBe(0)
    expect(revealOffset(3, heights, 3, 4)).toBe(3)
    expect(revealOffset(3, heights, 0, 4)).toBe(1)
  })
})

describe('chat event digest', () => {
  const timers: Timer[] = [{ id: 1, schedule: { mode: 'interval', every_ms: 3_600_000 }, next_wake_at: 0, scope: ['agent'], run_count: 3, created_at: 0, loop: 'consolidator', payload: 'consolidate' }]

  it('tracks a loop turn: start, tokens from llm.completed, end', () => {
    const events = [
      ev(1, 'agent.state.changed', { state: 'thinking' }, 'consolidator'),
      ev(2, 'llm.completed', { model: 'mock-model', input_tokens: 1200, output_tokens: 80 }, 'consolidator'),
      ev(3, 'llm.completed', { model: 'mock-model', input_tokens: 300, output_tokens: 20 }, 'consolidator'),
      ev(4, 'agent.state.changed', { state: 'idle' }, 'consolidator'),
    ]
    const { next } = digestEvents(INITIAL_CHAT_STATE, events, () => 'unknown')
    const turn = next.turns[transcriptKey(AGENT, 'consolidator')]
    expect(turn).toMatchObject({ startedAt: 1001, endedAt: 1004, input: 1500, output: 100, calls: 2, model: 'mock-model' })
    expect(next.turns[transcriptKey(AGENT, 'main')]).toBeUndefined()
    // Re-digesting the same events (a remount) does not double count.
    const again = digestEvents(next, events, () => 'unknown').next
    expect(again.turns).toBe(next.turns)
  })

  it('files a timer wake under the timer’s loop, waiting for the timer list when needed', () => {
    const fired = ev(5, 'timer.fired', { timer_id: 1, run_count: 4 })
    const waiting = digestEvents(INITIAL_CHAT_STATE, [fired], () => 'wait')
    expect(waiting.waiting).toBe(true)
    expect(waiting.next.markers).toEqual({})
    const { next } = digestEvents(INITIAL_CHAT_STATE, [fired], (_id, timerId) => timers.find(t => t.id === timerId) ?? 'unknown')
    const markers = next.markers[transcriptKey(AGENT, 'consolidator')]
    expect(markers?.[0].text).toContain('Woken by timer (every 1h, "consolidate")')
  })

  it('merges markers into the transcript by time', () => {
    const items: TranscriptItem[] = [
      { id: 'a', at: 10, kind: 'user', text: 'hi', origin: 'owner' },
      { id: 'b', at: 30, kind: 'assistant', text: 'hello', streaming: false },
    ]
    const merged = withMarkers(items, [{ id: 'm', at: 20, text: 'Inbox: message from agent-2' }])
    expect(merged.map(i => i.id)).toEqual(['a', 'm', 'b'])
  })
})

describe('chat helpers', () => {
  it('labels what woke a loop', () => {
    expect(triggerLabel('A scheduled timer has fired.\nPayload: consolidate')).toBe('timer · consolidate')
    expect(triggerLabel('You received a message from agent "agent-2": hi')).toBe('inbox · from agent-2')
    expect(triggerLabel('A file has been modified: notes/api.md')).toBe('file modified: notes/api.md')
  })

  it('scopes pending approvals to the loop that asked', () => {
    const agent = {
      pendingTasks: [
        { id: 't1', tool: 'msg_send', args: '{}', status: 'pending_approval', created_at: 1 },
        { id: 't2', tool: 'fs_write', args: '{}', status: 'pending_approval', created_at: 2, origin: 'loop:researcher' },
      ],
    } as unknown as AgentEntry
    expect(taskLoop(agent.pendingTasks[1])).toBe('researcher')
    expect(pendingTasksFor(agent, 'main').map(t => t.id)).toEqual(['t1'])
    expect(pendingTasksFor(agent, 'researcher').map(t => t.id)).toEqual(['t2'])
  })

  it('marks owner messages sent during a running turn as queued', () => {
    const items: TranscriptItem[] = [
      { id: 'a', at: 5, kind: 'user', text: 'start', origin: 'owner', pending: true },
      { id: 'b', at: 15, kind: 'user', text: 'also this', origin: 'owner', pending: true },
    ]
    expect(queuedItems(items, true, 10).map(i => i.id)).toEqual(['b'])
    expect(queuedItems(items, false, 10)).toEqual([])
  })

  it('cycles loop tabs in both directions', () => {
    const tabs = ['main', 'consolidator', 'researcher'].map(name => ({ name })) as LoopTab[]
    expect(cycleLoop(tabs, 'main', 1)).toBe('consolidator')
    expect(cycleLoop(tabs, 'main', -1)).toBe('researcher')
  })

  it('completes @path mentions against agent files', () => {
    expect(mentionAt('look at @no')).toEqual({ start: 8, partial: 'no' })
    expect(mentionAt('mail@example')).toBeNull()
    expect(completeMention('api', ['document.md', 'notes/api.md', 'api.md'])).toEqual(['api.md', 'notes/api.md'])
    expect(applyMention('look at @no', 11, 'notes/api.md')).toEqual({ value: 'look at @notes/api.md ', cursor: 22 })
  })

  it('estimates taller rows for expanded tools and thinking', () => {
    const tool: TranscriptItem = { id: 't', at: 0, kind: 'tool', name: 'fs_read', input: { path: 'a' }, status: 'ok', result: 'l1\nl2\nl3' }
    expect(itemHeight(tool, 60, { expanded: false, showThinking: false })).toBe(3)
    expect(itemHeight(tool, 60, { expanded: true, showThinking: false })).toBeGreaterThan(6)
    const thinking: TranscriptItem = { id: 'th', at: 0, kind: 'thinking', text: 'a\nb\nc', streaming: false }
    expect(itemHeight(thinking, 60, { expanded: false, showThinking: false })).toBe(2)
    expect(itemHeight(thinking, 60, { expanded: false, showThinking: true })).toBe(5)
  })
})
