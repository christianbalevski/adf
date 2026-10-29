import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHeadlessAgent, MockLLMProvider } from '../../../src/main/runtime/headless'
import { getTokenCounterService } from '../../../src/main/services/token-counter.service'
import type { AgentExecutor } from '../../../src/main/runtime/agent-executor'

// Exercise the two real consumers while controlling only the provider response
// and tokenizer; tokenizer call counts are deterministic performance guards.
type ContextAccess = {
  recordRequestContext(system: string, dynamic: string | undefined): void
  estimatePreflightTokens(baseline: number, dynamic: string | undefined): number
}
const agents: ReturnType<typeof createHeadlessAgent>[] = []
afterEach(() => { while (agents.length) agents.pop()!.dispose(); vi.restoreAllMocks() })
function fixture(providerId = 'audit-openai') {
  const provider = new MockLLMProvider({ latencyMs: 0 })
  Object.assign(provider, { providerId })
  const agent = createHeadlessAgent({ name: 'tokens', provider, profile: 'benchmark' })
  agents.push(agent)
  agent.executor.getContextBreakdown() // Warm the independent system/tool caches.
  return { agent, provider, executor: agent.executor as unknown as ContextAccess & Pick<AgentExecutor, 'getContextBreakdown' | 'resetContextState' | 'updateProvider'> }
}

describe('dynamic instruction token memo', () => {
  it('shares one count between preflight and repeated context reads and refreshes on text change', () => {
    const { executor } = fixture()
    const counter = vi.spyOn(getTokenCounterService(), 'countTokens').mockImplementation(text => text.length)
    executor.recordRequestContext('system', 'first hint')
    executor.estimatePreflightTokens(0, 'first hint')
    expect(executor.getContextBreakdown()?.dynamic_instructions_tokens).toBe(10)
    expect(executor.getContextBreakdown()?.dynamic_instructions_tokens).toBe(10)
    expect(counter.mock.calls.filter(([text]) => text === 'first hint')).toHaveLength(1)
    executor.recordRequestContext('system', 'second hint')
    expect(executor.getContextBreakdown()?.dynamic_instructions_tokens).toBe(11)
    expect(counter.mock.calls.filter(([text]) => text === 'second hint')).toHaveLength(1)
    executor.recordRequestContext('system', undefined)
    expect(executor.getContextBreakdown()?.dynamic_instructions_tokens).toBe(0)
  })

  it('detects tokenizer re-registration and provider changes with identical text', () => {
    const { executor } = fixture('audit-switchable')
    const tc = getTokenCounterService()
    tc.registerProviderType('audit-switchable', 'openai')
    const counter = vi.spyOn(tc, 'countTokens').mockImplementation((_text, provider) => tc.resolveTokenizer(provider) === 'gpt' ? 11 : 22)
    executor.recordRequestContext('system', 'hint')
    expect(executor.getContextBreakdown()?.dynamic_instructions_tokens).toBe(11)
    tc.registerProviderType('audit-switchable', 'anthropic')
    expect(executor.getContextBreakdown()?.dynamic_instructions_tokens).toBe(22)
    const next = new MockLLMProvider()
    Object.assign(next, { providerId: 'openai' })
    executor.updateProvider(next)
    expect(executor.getContextBreakdown()?.dynamic_instructions_tokens).toBe(11)
    expect(counter.mock.calls.filter(([text]) => text === 'hint')).toHaveLength(3)
  })

  it('drops the memo on context reset and does not retain oversized custom hints', () => {
    const { executor } = fixture()
    const counter = vi.spyOn(getTokenCounterService(), 'countTokens').mockImplementation(text => text.length)
    executor.recordRequestContext('system', 'hint')
    executor.getContextBreakdown()
    executor.resetContextState()
    expect(executor.getContextBreakdown()?.dynamic_instructions_tokens).toBe(0)
    executor.recordRequestContext('system', 'hint')
    executor.getContextBreakdown()
    expect(counter.mock.calls.filter(([text]) => text === 'hint')).toHaveLength(2)
    const large = 'x'.repeat(64 * 1024 + 1)
    executor.recordRequestContext('system', large)
    expect(executor.getContextBreakdown()?.dynamic_instructions_tokens).toBe(large.length)
    executor.getContextBreakdown()
    expect(counter.mock.calls.filter(([text]) => text === large)).toHaveLength(2)
  })
})
