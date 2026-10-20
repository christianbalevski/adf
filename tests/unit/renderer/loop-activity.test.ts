import { describe, expect, it } from 'vitest'
import { getLiveStep, getLoopActivity, isSystemNotice } from '../../../src/renderer/utils/loop-activity'
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
  })

  it('shows the thinking phase after say, without animating its prose', () => {
    const say = entry('say', 'tool_call', { name: 'say', tool_id: 'say' })
    const sayResult = entry('say result', 'tool_result', { tool_use_id: 'say', isError: false })
    expect(getLoopActivity([user, call, result, say], active)).toEqual(thinking)
    expect(getLoopActivity([user, say, sayResult], active)).toEqual(thinking)
    expect(getLoopActivity([user, say, sayResult, entry('Turn complete', 'system')], active)).toEqual(none)
  })

  it('shows the thinking phase after a finished reply in autonomous mode', () => {
    const autonomous = { ...active, autonomous: true }
    const streaming = entry('Reply', 'text')
    const closed = entry('Reply', 'text', { seq: 7 })
    const quiet = entry('', 'text', { quietTurn: true })
    expect(getLoopActivity([user, streaming], autonomous)).toEqual(none)
    expect(getLoopActivity([user, closed], autonomous)).toEqual(thinking)
    expect(getLoopActivity([user, quiet], autonomous)).toEqual(thinking)
    expect(getLoopActivity([user, closed], active)).toEqual(none)
    expect(getLoopActivity([user, closed], { ...autonomous, active: false })).toEqual(none)
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

describe('live step', () => {
  const reasoned = entry('reasoned', 'tool_call', { name: 'fs_read', input: { path: 'a.md', _reason: 'Read the draft' } })
  const done = entry('done', 'system')
  done.content = 'Turn complete'

  it('shows the latest call by its reason, falling back to the tool name', () => {
    expect(getLiveStep([user, reasoned])).toEqual({ text: 'Read the draft', running: true })
    expect(getLiveStep([user, call])).toEqual({ text: 'loop_manage', running: true })
  })

  it('stops running once a result, thinking or prose follows the call', () => {
    expect(getLiveStep([user, reasoned, result])).toEqual({ text: 'Read the draft', running: false })
    expect(getLiveStep([user, reasoned, entry('t', 'thinking')])).toEqual({ text: 'Read the draft', running: false })
  })

  it('never carries a call over from an earlier turn', () => {
    expect(getLiveStep([user])).toBeNull()
    expect(getLiveStep([reasoned, done])).toBeNull()
    expect(getLiveStep([reasoned, user])).toBeNull()
    expect(getLiveStep([reasoned, entry('trigger', 'trigger')])).toBeNull()
  })
})

describe('compaction phase', () => {
  const notice = (id: string, content: string): AgentLogEntry => ({
    id, type: 'context', content, timestamp: 1, metadata: { category: 'System' },
  })
  const compacting = { entryId: null, phase: 'Compacting…' }
  const trigger = entry('trigger', 'trigger')

  it('reads a System context entry as a notice, and only that', () => {
    expect(isSystemNotice(notice('n', 'Auto-compacting conversation history...'))).toBe(true)
    expect(isSystemNotice(entry('context', 'context', { category: 'system_prompt' }))).toBe(false)
  })

  it('shows Compacting… instead of Thinking… while a compaction runs', () => {
    expect(getLoopActivity([trigger, notice('n', 'Auto-compacting conversation history...')], active)).toEqual(compacting)
    expect(getLoopActivity([user, call, result, notice('n', 'Compacting conversation history (context limit reached)…')], active)).toEqual(compacting)
  })

  it('ends the phase once compaction failed or the compacted log arrived', () => {
    const started = notice('n', 'Compacting conversation history (manual)...')
    const failed = notice('f', 'Compaction failed — history preserved, will retry. (timeout)')
    expect(getLoopActivity([trigger, started, failed], active)).toEqual(thinking)
    expect(getLoopActivity([entry('summary', 'compaction'), started], active)).toEqual(compacting)
    expect(getLoopActivity([started, entry('summary', 'compaction')], active)).toEqual(thinking)
  })

  it('does not read the memory-flush grace notice as compacting', () => {
    const grace = notice('g', 'Compaction threshold reached — memory-flush grace turn before compacting.')
    expect(getLoopActivity([trigger, grace], active)).toEqual(thinking)
  })

  it('shows a manual /compact between turns while its notice is the last row', () => {
    const idle = { ...active, active: false }
    const started = notice('n', 'Compacting conversation history (manual)...')
    const failed = notice('f', 'Compaction failed — history preserved, will retry. (x)')
    expect(getLoopActivity([user, started], idle)).toEqual(compacting)
    expect(getLoopActivity([user, started, failed], idle)).toEqual(none)
    expect(getLoopActivity([user, started], { ...idle, waiting: true })).toEqual(none)
  })
})
