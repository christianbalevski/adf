import { describe, expect, it } from 'vitest'
import { directSendOutcome, restoreDraft } from '../../../src/renderer/utils/send-recovery'
import type { AgentLogEntry } from '../../../src/renderer/stores/agent.store'

const entry = (id: string, type: AgentLogEntry['type'], content = id): AgentLogEntry => ({ id, type, content, timestamp: 1 })
const earlier = [entry('a', 'text'), entry('b', 'error', 'Not sent: Agent not running')]
const before = new Set(earlier.map((e) => e.id))

describe('direct send outcome', () => {
  it('is pending while only the owner bubble has arrived', () => {
    expect(directSendOutcome([...earlier, entry('bubble', 'user')], before)).toBe('pending')
  })

  it('fails on a Not sent row after the send, never on an earlier one', () => {
    expect(directSendOutcome([...earlier, entry('bubble', 'user'), entry('err', 'error', 'Not sent: Agent not running')], before)).toBe('failed')
    expect(directSendOutcome([...earlier], before)).toBe('pending')
  })

  it('is delivered once the agent shows anything else', () => {
    expect(directSendOutcome([...earlier, entry('bubble', 'user'), entry('t', 'thinking')], before)).toBe('delivered')
    expect(directSendOutcome([...earlier, entry('bubble', 'user'), entry('e', 'error', '503 Service Unavailable')], before)).toBe('delivered')
  })
})

describe('restored draft', () => {
  it('puts the message back, ahead of anything typed since', () => {
    expect(restoreDraft('', 'hello')).toBe('hello')
    expect(restoreDraft('  ', 'hello')).toBe('hello')
    expect(restoreDraft('more', 'hello')).toBe('hello\n\nmore')
    expect(restoreDraft('more', '')).toBe('more')
  })
})
