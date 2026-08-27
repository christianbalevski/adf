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
  const cacheAware =
    (pricing.cache_read_per_million !== undefined || pricing.cache_write_per_million !== undefined) &&
    (cacheRead > 0 || cacheWrite > 0)

  let inputCost: number
  let cacheCost = 0
  if (cacheAware) {
    // Cache token semantics differ by provider family (LlmCallMetadata doesn't
    // carry the convention, so derive it from the provider id):
    //  - anthropic: input_tokens already INCLUDES cache_read + cache_write, so
    //    subtract them before applying the base input rate;
    //  - everyone else (openai-family): cached tokens are a SUBSET of
    //    input_tokens billed at the read rate, so subtract only cache_read.
    const anthropicInclusive = metadata.provider.startsWith('anthropic')
    const baseInputTokens = Math.max(
      0,
      metadata.input_tokens - cacheRead - (anthropicInclusive ? cacheWrite : 0)
    )
    inputCost = baseInputTokens * pricing.input_per_million / 1_000_000
    cacheCost =
      cacheRead * (pricing.cache_read_per_million ?? pricing.input_per_million) / 1_000_000 +
      cacheWrite * (pricing.cache_write_per_million ?? pricing.input_per_million) / 1_000_000
  } else {
    inputCost = metadata.input_tokens * pricing.input_per_million / 1_000_000
  }
  const outputCost = metadata.output_tokens * pricing.output_per_million / 1_000_000
  return Number((inputCost + cacheCost + outputCost).toFixed(8))
}
