import { describe, expect, it } from 'vitest'
import { getLoopActivity } from '../../../src/renderer/utils/loop-activity'
import type { AgentLogEntry } from '../../../src/renderer/stores/agent.store'

const active = { active: true, starting: false, waiting: false }
const none = { entryId: null, phase: null }
const thinking = { entryId: null, phase: 'Thinking…' }
const entry = (id: string, type: AgentLogEntry['type'], metadata?: AgentLogEntry['metadata']): AgentLogEntry => ({
  id, type, content: id, timestamp: 1, metadata,
})
const user = entry('user', 'user')
const call = entry('call', 'tool_call', { name: 'loop_manage', tool_id: 'call' })
const result = entry('result', 'tool_result', { tool_use_id: 'call', isError: false })

describe('loop activity', () => {
  it('keeps the latest call active after its result arrives and during context updates', () => {
    for (const log of [[user, call], [user, call, result], [user, call, result, entry('context', 'context')]]) {
      expect(getLoopActivity(log, active)).toEqual({ entryId: 'call', phase: null })
    }
  })

  it('moves to the next call, even when an earlier parallel call finishes later', () => {
    const nextCall = entry('next', 'tool_call', { name: 'loop_send' })
    expect(getLoopActivity([user, call, nextCall, result], active)).toEqual({ entryId: 'next', phase: null })
  })

  it('moves to explicit reasoning and then to the following tool call', () => {
    const reasoning = entry('reasoning', 'thinking')
    const log = [user, call, result, reasoning]
    expect(getLoopActivity(log, active)).toEqual({ entryId: 'reasoning', phase: null })
    const nextCall = entry('next', 'tool_call')
    expect(getLoopActivity([...log, nextCall], active)).toEqual({ entryId: 'next', phase: null })
  })

  it('uses an inline thinking phase before the first step', () => {
    expect(getLoopActivity([], active)).toEqual(thinking)
    expect(getLoopActivity([user, entry('context', 'context')], active)).toEqual(thinking)
  })

  it.each(['user', 'trigger'] as const)('does not animate the previous turn after a new %s', (type) => {
    expect(getLoopActivity([user, call, result, entry('new turn', type)], active)).toEqual(thinking)
  })

  it('stops immediately at turn completion even before the active state changes', () => {
    expect(getLoopActivity([user, call, result, entry('Turn complete', 'system')], active)).toEqual(none)
  })

  it('stops when the agent finishes, yields, stops, or waits for input', () => {
    const log = [user, call, result]
    expect(getLoopActivity(log, { ...active, active: false })).toEqual(none)
    expect(getLoopActivity(log, { ...active, waiting: true })).toEqual(none)
  })

  it('lets the assistant response replace the glimmer without a duplicate thinking row', () => {
    expect(getLoopActivity([user, call, result, entry('Reply', 'text')], active)).toEqual(none)
    expect(getLoopActivity([user, call, result, entry('say', 'tool_call', { name: 'say' })], active)).toEqual(none)
  })

  it('stops on errors and quiet endings', () => {
    expect(getLoopActivity([user, call, entry('Failed', 'error')], active)).toEqual(none)
    expect(getLoopActivity([user, call, entry('', 'text', { quietTurn: true })], active)).toEqual(none)
  })

  it('keeps working after a tool error when the agent is still processing it', () => {
    expect(getLoopActivity([user, call, { ...result, metadata: { isError: true } }], active))
      .toEqual({ entryId: 'call', phase: null })
  })

  it('shows startup without animating a stale step', () => {
    expect(getLoopActivity([user, call, result], { ...active, starting: true }))
      .toEqual({ entryId: null, phase: 'Starting agent…' })
  })
})
