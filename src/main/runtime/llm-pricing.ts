/**
 * Local pricing table + pure cost estimator for LLM calls.
 *
 * `estimateLlmCallCostUsd` is a pure function of LlmCallMetadata: it never
 * inspects the provider id (an opaque settings key) and applies one universal
 * formula, because the AI SDK normalizes input_tokens to be cache-inclusive for
 * every provider. Gating (subscription providers, estimated usage) lives in
 * llm-call-metadata.ts, not here.
 */

import type { LlmCallMetadata } from '../../shared/types/adf-event.types'

export interface LlmModelPricing {
  input_per_million: number
  output_per_million: number
  cache_read_per_million?: number
  cache_write_per_million?: number
}

export const LLM_PRICING: Record<string, LlmModelPricing> = {
  'gpt-5.4': { input_per_million: 2.50, output_per_million: 10.00 },
  'gpt-5.4-mini': { input_per_million: 0.25, output_per_million: 2.00 },
  'gpt-5.3-codex': { input_per_million: 3.00, output_per_million: 12.00 },
  'gpt-5.3-codex-spark': { input_per_million: 0.50, output_per_million: 2.00 },
  // Standard Anthropic cache multipliers: write 1.25x input, read 0.1x input.
  'claude-sonnet-4-5-20250929': {
    input_per_million: 3.00,
    output_per_million: 15.00,
    cache_read_per_million: 0.30,
    cache_write_per_million: 3.75,
  },
}

export function estimateLlmCallCostUsd(metadata: LlmCallMetadata): number | undefined {
  const pricing = LLM_PRICING[metadata.model]
  if (!pricing) return undefined

  const cacheRead = metadata.cache_read_tokens ?? 0
  const cacheWrite = metadata.cache_write_tokens ?? 0

  // One convention for every provider. AI SDK v6 reports `usage.inputTokens`
  // as `inputTokens.total`, which already INCLUDES cache tokens everywhere:
  //  - anthropic:  total = uncached + cache_read + cache_creation
  //  - openai:     total = prompt_tokens, cache_read is a subset
  //  - openrouter: total = prompt_tokens, cache_read AND cache_write are subsets
  // So base (full-rate) input is always input_tokens minus both cache buckets.
  // Cache buckets bill at their own rate, falling back to the input rate when
  // the table has no cache pricing for the model.
  const baseInputTokens = Math.max(0, metadata.input_tokens - cacheRead - cacheWrite)
  const inputCost = baseInputTokens * pricing.input_per_million / 1_000_000
  const cacheCost =
    cacheRead * (pricing.cache_read_per_million ?? pricing.input_per_million) / 1_000_000 +
    cacheWrite * (pricing.cache_write_per_million ?? pricing.input_per_million) / 1_000_000
  const outputCost = metadata.output_tokens * pricing.output_per_million / 1_000_000
  return Number((inputCost + cacheCost + outputCost).toFixed(8))
}
