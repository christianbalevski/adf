import type { LlmCallMetadata } from '../../shared/types/adf-event.types'

export interface LlmModelPricing {
  input_per_million: number
  output_per_million: number
}

export const LLM_PRICING: Record<string, LlmModelPricing> = {
  'gpt-5.4': { input_per_million: 2.50, output_per_million: 10.00 },
  'gpt-5.4-mini': { input_per_million: 0.25, output_per_million: 2.00 },
  'gpt-5.3-codex': { input_per_million: 3.00, output_per_million: 12.00 },
  'gpt-5.3-codex-spark': { input_per_million: 0.50, output_per_million: 2.00 },
  'claude-sonnet-4-5-20250929': { input_per_million: 3.00, output_per_million: 15.00 },
}

export function estimateLlmCallCostUsd(metadata: LlmCallMetadata): number | undefined {
  const pricing = LLM_PRICING[metadata.model]
  if (!pricing) return undefined
  const inputCost = metadata.input_tokens * pricing.input_per_million / 1_000_000
  const outputCost = metadata.output_tokens * pricing.output_per_million / 1_000_000
  return Number((inputCost + outputCost).toFixed(8))
}
