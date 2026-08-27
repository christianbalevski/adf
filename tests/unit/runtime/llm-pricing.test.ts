/**
 * Pricing-table cost estimation — pins the cache-aware math and the two
 * cache-token conventions:
 *  - anthropic: input_tokens already INCLUDES cache_read + cache_write
 *  - openai-family: cached tokens are a SUBSET of input_tokens (read-rate)
 */

import { describe, expect, it } from 'vitest'
import { estimateLlmCallCostUsd, LLM_PRICING } from '../../../src/main/runtime/llm-pricing'
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

  it('anthropic convention: cache tokens are carved OUT of input_tokens', () => {
    // input_tokens 1M includes 600k cache_read + 200k cache_write → 200k base
    const cost = estimateLlmCallCostUsd(meta({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
      input_tokens: 1_000_000,
      output_tokens: 0,
      cache_read_tokens: 600_000,
      cache_write_tokens: 200_000,
    }))
    const expected =
      0.2 * 3.00 +   // base input
      0.6 * 0.30 +   // cache read at 0.1x
      0.2 * 3.75     // cache write at 1.25x
    expect(cost).toBeCloseTo(expected, 8)
  })

  it('openai-subset convention: only cache_read is carved out of input_tokens', () => {
    // Non-anthropic provider (e.g. openrouter serving the model): cached tokens
    // are a subset of input, cache_write untouched by the base-input carve-out.
    const cost = estimateLlmCallCostUsd(meta({
      provider: 'openrouter',
      model: 'claude-sonnet-4-5-20250929',
      input_tokens: 1_000_000,
      output_tokens: 0,
      cache_read_tokens: 600_000,
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

  it('ignores cache fields for models without cache rates', () => {
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
    expect(withCache).toBe(without)
  })
})
