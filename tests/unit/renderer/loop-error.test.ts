import { describe, expect, it } from 'vitest'
import { actionableErrorId, errorAction, isMissingProvider } from '../../../src/renderer/utils/loop-error'
import type { AgentLogEntry } from '../../../src/renderer/stores/agent.store'

const entry = (id: string, type: AgentLogEntry['type'], content = id): AgentLogEntry => ({ id, type, content, timestamp: 1 })

describe('error row action', () => {
  it('offers Open provider for credential and missing-provider errors', () => {
    expect(errorAction("Your Anthropic provider isn't authenticated. Check the API key.\n\nDetails: 401")).toBe('provider')
    expect(errorAction('Provider "agent-1-provider" not found. Configure it in Settings → Providers.')).toBe('provider')
    expect(errorAction('Incorrect API key provided')).toBe('provider')
  })

  it('offers Compact for a context overflow', () => {
    expect(errorAction('400 prompt is too long: 210000 tokens > 200000 maximum')).toBe('compact')
    expect(errorAction("This model's maximum context length is 128000 tokens")).toBe('compact')
    expect(errorAction('context_length_exceeded')).toBe('compact')
  })

  it('offers Retry now for a transient failure', () => {
    expect(errorAction('Provider unavailable: 503 Service Unavailable\n\nAuto-recovery: retry 1/3 in ~8s.')).toBe('retry')
    // The executor's own transient classification wins over body wording.
    expect(errorAction('Provider unavailable: 429 billing quota for the project')).toBe('retry')
    expect(errorAction('Request timed out')).toBe('retry')
  })

  it('offers nothing for a refused send or an unknown error', () => {
    expect(errorAction('Not sent: Agent not running')).toBeNull()
    expect(errorAction('Tool foo crashed')).toBeNull()
  })

  it('tells a missing provider from bad credentials', () => {
    expect(isMissingProvider('Provider "agent-1-provider" not found. Configure it in Settings → Providers.')).toBe(true)
    expect(isMissingProvider("Your Anthropic provider isn't authenticated.")).toBe(false)
  })
})

describe('actionable error', () => {
  it('is the latest error while nothing the agent did follows it', () => {
    const log = [entry('old', 'error'), entry('reply', 'text'), entry('trigger', 'trigger'), entry('new', 'error'), entry('note', 'system')]
    expect(actionableErrorId(log)).toBe('new')
  })

  it('is none once the agent moved past the error', () => {
    for (const type of ['text', 'thinking', 'tool_call', 'compaction'] as const) {
      expect(actionableErrorId([entry('e', 'error'), entry('next', type)])).toBeNull()
    }
    expect(actionableErrorId([entry('u', 'user')])).toBeNull()
  })

  it('stays after the owner sends again, until the agent answers', () => {
    expect(actionableErrorId([entry('e', 'error'), entry('u', 'user')])).toBe('e')
  })
})
