/**
 * Per-call cost resolution in buildLlmCallMetadata — pins the precedence:
 * provider-reported cost (OpenRouter usage accounting) > pricing-table
 * estimate > nothing, and that char-estimated usage never gets a cost.
 */

import { describe, expect, it } from 'vitest'
import {
  buildLlmCallMetadata,
  loopTokensFromLlmMetadata,
  toLlmCallEventData,
} from '../../../src/main/runtime/llm-call-metadata'
import type { LLMProvider } from '../../../src/main/providers/provider.interface'
import type { LLMResponse } from '../../../src/shared/types/provider.types'

const provider = {
  providerId: 'openrouter',
  name: 'OpenRouter',
  modelId: 'claude-sonnet-4-5-20250929', // present in LLM_PRICING
} as LLMProvider

function response(providerMetadata?: Record<string, unknown>): LLMResponse {
  return {
    id: 'r1',
    content: [{ type: 'text', text: 'hi' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
    providerMetadata,
  }
}

describe('buildLlmCallMetadata cost', () => {
  it('provider-reported cost wins over the table estimate', () => {
    const metadata = buildLlmCallMetadata(
      provider,
      response({ adf: { costUsd: 0.0123, costSource: 'provider' } }),
      42,
    )
    expect(metadata.cost_usd).toBe(0.0123)
    expect(metadata.cost_source).toBe('provider')
  })

  it('reads openrouter.usage.cost directly off merged provider metadata', () => {
    const metadata = buildLlmCallMetadata(
      provider,
      response({ openrouter: { usage: { cost: 0.5 } } }),
      42,
    )
    expect(metadata.cost_usd).toBe(0.5)
    expect(metadata.cost_source).toBe('provider')
  })

  it('falls back to the pricing table when no provider cost is present', () => {
    const metadata = buildLlmCallMetadata(provider, response(), 42)
    // 1M in * $3/M + 1M out * $15/M
    expect(metadata.cost_usd).toBeCloseTo(18.0, 8)
    expect(metadata.cost_source).toBe('table')
  })

  it('leaves cost undefined for unknown models with no provider cost', () => {
    const unknownProvider = { ...provider, modelId: 'mystery-model' } as LLMProvider
    const metadata = buildLlmCallMetadata(unknownProvider, response(), 42)
    expect(metadata.cost_usd).toBeUndefined()
    expect(metadata.cost_source).toBeUndefined()
  })

  it('never attaches a table cost to char-estimated usage', () => {
    // Estimated tokens × real prices = fake dollars — tokens recorded, cost not.
    const metadata = buildLlmCallMetadata(
      provider,
      response({ adf: { usageEstimated: true } }),
      42,
    )
    expect(metadata.usage_estimated).toBe(true)
    expect(metadata.cost_usd).toBeUndefined()
    expect(metadata.input_tokens).toBe(1_000_000)
  })

  it('still honors an explicit provider cost even when usage was estimated elsewhere', () => {
    const metadata = buildLlmCallMetadata(
      provider,
      response({ adf: { usageEstimated: true, costUsd: 0.02 } }),
      42,
    )
    expect(metadata.cost_usd).toBe(0.02)
    expect(metadata.cost_source).toBe('provider')
  })

  it('carries cost into loop token usage and the llm_call event', () => {
    const metadata = buildLlmCallMetadata(
      provider,
      response({ adf: { costUsd: 0.0123 } }),
      42,
    )
    expect(loopTokensFromLlmMetadata(metadata).cost_usd).toBe(0.0123)
    const event = toLlmCallEventData(metadata, 'turn')
    expect(event.cost_usd).toBe(0.0123)
    expect(event.source).toBe('turn')
  })
})
