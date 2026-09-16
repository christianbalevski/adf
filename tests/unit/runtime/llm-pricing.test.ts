/**
 * Pricing-table cost estimation — pins the universal cache-aware formula.
 * AI SDK v6 reports input_tokens as inputTokens.total, which is cache-inclusive
 * for EVERY provider, so base input is always input - cache_read - cache_write.
 * The estimator is pure: it never looks at the (opaque) provider id.
 */

import { describe, expect, it } from 'vitest'
import { estimateLlmCallCostUsd, LLM_PRICING } from '../../../src/main/runtime/llm-pricing'
import { buildLlmCallMetadata } from '../../../src/main/runtime/llm-call-metadata'
import type { LLMProvider } from '../../../src/main/providers/provider.interface'
import type { LLMResponse } from '../../../src/shared/types/provider.types'
import type { LlmCallMetadata } from '../../../src/shared/types/adf-event.types'

function meta(overrides: Partial<LlmCallMetadata>): LlmCallMetadata {
  return {
    provider: 'test',
    model: 'unknown-model',
    input_tokens: 0,
    output_tokens: 0,
    duration_ms: 0,
    stop_reason: 'end_turn',
    ...overrides,
  }
}

describe('estimateLlmCallCostUsd', () => {
  it('returns undefined for models missing from the table', () => {
    expect(estimateLlmCallCostUsd(meta({ model: 'no-such-model', input_tokens: 1000 }))).toBeUndefined()
  })

  it('computes plain input/output cost when no cache tokens are present', () => {
    const cost = estimateLlmCallCostUsd(meta({
      model: 'gpt-5.4',
      input_tokens: 1_000_000,
      output_tokens: 500_000,
    }))
    // 1M * $2.50/M + 0.5M * $10/M
    expect(cost).toBeCloseTo(2.50 + 5.00, 8)
  })

  it('has anthropic cache rates at the standard multipliers', () => {
    const p = LLM_PRICING['claude-sonnet-4-5-20250929']
    expect(p.cache_write_per_million).toBeCloseTo(p.input_per_million * 1.25, 8)
    expect(p.cache_read_per_million).toBeCloseTo(p.input_per_million * 0.1, 8)
  })

  it('carves BOTH cache buckets out of input_tokens (worked example)', () => {
    // input_tokens 10000 = 1000 fresh + 8000 cache_read + 1000 cache_write
    const cost = estimateLlmCallCostUsd(meta({
      provider: 'custom:a1b2c3', // opaque settings key — must not matter
      model: 'claude-sonnet-4-5-20250929',
      input_tokens: 10_000,
      output_tokens: 0,
      cache_read_tokens: 8_000,
      cache_write_tokens: 1_000,
    }))
    const expected =
      1_000 * 3.00 / 1e6 +   // fresh input
      8_000 * 0.30 / 1e6 +   // cache read at 0.1x
      1_000 * 3.75 / 1e6     // cache write at 1.25x
    expect(expected).toBeCloseTo(0.00915, 10)
    expect(cost).toBeCloseTo(0.00915, 8)
  })

  it('is independent of the provider id', () => {
    const base = {
      model: 'claude-sonnet-4-5-20250929',
      input_tokens: 10_000,
      output_tokens: 500,
      cache_read_tokens: 8_000,
      cache_write_tokens: 1_000,
    }
    const viaAnthropic = estimateLlmCallCostUsd(meta({ ...base, provider: 'anthropic' }))
    const viaOpaqueKey = estimateLlmCallCostUsd(meta({ ...base, provider: 'custom:zz9' }))
    const viaOpenRouter = estimateLlmCallCostUsd(meta({ ...base, provider: 'openrouter' }))
    expect(viaOpaqueKey).toBe(viaAnthropic)
    expect(viaOpenRouter).toBe(viaAnthropic)
  })

  it('openai-style report: cache_write undefined carves out only cache_read', () => {
    const cost = estimateLlmCallCostUsd(meta({
      provider: 'openai',
      model: 'claude-sonnet-4-5-20250929',
      input_tokens: 1_000_000,
      output_tokens: 0,
      cache_read_tokens: 600_000,
      // cache_write_tokens deliberately absent
    }))
    const expected =
      0.4 * 3.00 +   // input minus cached subset
      0.6 * 0.30     // cached subset at read rate
    expect(cost).toBeCloseTo(expected, 8)
  })

  it('clamps base input at zero if cache tokens exceed input_tokens', () => {
    const cost = estimateLlmCallCostUsd(meta({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
      input_tokens: 100,
      output_tokens: 0,
      cache_read_tokens: 200,
      cache_write_tokens: 100,
    }))
    expect(cost).toBeGreaterThanOrEqual(0)
  })

  it('bills cache tokens at the input rate for models without cache rates', () => {
    // No cache pricing in the table → cache buckets fall back to the input
    // rate, so the carve-out is cost-neutral and the total equals plain input.
    const withCache = estimateLlmCallCostUsd(meta({
      provider: 'openai',
      model: 'gpt-5.4',
      input_tokens: 1_000_000,
      output_tokens: 0,
      cache_read_tokens: 500_000,
    }))
    const without = estimateLlmCallCostUsd(meta({
      provider: 'openai',
      model: 'gpt-5.4',
      input_tokens: 1_000_000,
      output_tokens: 0,
    }))
    expect(withCache).toBeCloseTo(without!, 8)
  })
})

describe('buildLlmCallMetadata cost gating by provider_type', () => {
  function fakeProvider(overrides: Partial<LLMProvider>): LLMProvider {
    return {
      name: 'Fake',
      providerId: 'custom:fake01',
      modelId: 'claude-sonnet-4-5-20250929', // priced in the table
      createMessage: async () => { throw new Error('not used') },
      validateConfig: async () => ({ valid: true }),
      ...overrides,
    }
  }
  const response: LLMResponse = {
    id: 'r1',
    content: [{ type: 'text', text: 'hi' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10_000, output_tokens: 100 },
  }

  it('plumbs provider_type into the metadata', () => {
    const metadata = buildLlmCallMetadata(fakeProvider({ providerType: 'anthropic' }), response, 1)
    expect(metadata.provider).toBe('custom:fake01')
    expect(metadata.provider_type).toBe('anthropic')
    expect(metadata.cost_source).toBe('table')
  })

  it.each(['chatgpt-subscription', 'grok-subscription'] as const)(
    'never attaches a table cost for %s',
    (providerType) => {
      const metadata = buildLlmCallMetadata(fakeProvider({ providerType }), response, 1)
      expect(metadata.provider_type).toBe(providerType)
      expect(metadata.input_tokens).toBe(10_000)
      expect(metadata.cost_usd).toBeUndefined()
      expect(metadata.cost_source).toBeUndefined()
    },
  )

  it('still honors a provider-reported cost for a subscription provider', () => {
    const metadata = buildLlmCallMetadata(
      fakeProvider({ providerType: 'chatgpt-subscription' }),
      { ...response, providerMetadata: { adf: { costUsd: 0.01 } } },
      1,
    )
    expect(metadata.cost_usd).toBe(0.01)
    expect(metadata.cost_source).toBe('provider')
  })

  it('omits provider_type when the provider does not declare one', () => {
    const metadata = buildLlmCallMetadata(fakeProvider({}), response, 1)
    expect('provider_type' in metadata).toBe(false)
    expect(metadata.cost_source).toBe('table')
  })
})
