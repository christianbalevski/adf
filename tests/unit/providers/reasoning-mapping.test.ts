import { describe, expect, it } from 'vitest'

import { planReasoning } from '../../../src/main/providers/ai-sdk-provider'
import type { CreateMessageOptions } from '../../../src/main/providers/provider.interface'
import type { ReasoningConfig } from '../../../src/shared/types/provider.types'

// planReasoning(style, options, requestMaxTokens) maps the provider-agnostic
// `reasoning` config onto each provider's native request options. These tests
// lock the mapping matrix + the legacy thinking_budget bridge.

function opts(reasoning?: ReasoningConfig, thinkingBudget?: number): CreateMessageOptions {
  return { system: '', messages: [], reasoning, thinkingBudget } as CreateMessageOptions
}

describe('planReasoning — gating', () => {
  it('returns null when reasoning is unset (anthropic/openai/none reason only when asked)', () => {
    for (const style of ['anthropic', 'openai', 'none'] as const) {
      expect(planReasoning(style, opts())).toBeNull()
    }
  })

  it('disables OpenRouter reasoning when off (mandatory endpoints handled by runtime retry)', () => {
    const off = { providerOptions: { openrouter: { reasoning: { enabled: false } } }, omitTempParams: false }
    // unset reasoning → send an explicit disable (it reasons by default otherwise)
    expect(planReasoning('openrouter', opts())).toEqual(off)
    // explicit enabled:false → same, even if an effort is also present
    expect(planReasoning('openrouter', opts({ enabled: false, effort: 'high' }))).toEqual(off)
  })

  it('returns null for unknown / openai-compatible style (no auto-mapping — params bypass)', () => {
    expect(planReasoning(undefined, opts({ effort: 'high' }))).toBeNull()
    expect(planReasoning('none', opts({ effort: 'high' }))).toBeNull()
  })

  it('honors explicit enabled:false for non-openrouter styles (no disable signal)', () => {
    expect(planReasoning('anthropic', opts({ enabled: false, effort: 'high' }))).toBeNull()
    expect(planReasoning('openai', opts({ enabled: false, effort: 'high' }))).toBeNull()
  })

  it('turns on from effort, max_tokens, enabled, or legacy thinkingBudget', () => {
    expect(planReasoning('openrouter', opts({ effort: 'low' }))).not.toBeNull()
    expect(planReasoning('openrouter', opts({ max_tokens: 2000 }))).not.toBeNull()
    expect(planReasoning('openrouter', opts({ enabled: true }))).not.toBeNull()
    expect(planReasoning('openrouter', opts(undefined, 3000))).not.toBeNull()
  })
})

describe('planReasoning — anthropic', () => {
  it('derives budget from effort × request max tokens, omits temp params', () => {
    const plan = planReasoning('anthropic', opts({ effort: 'high' }), 10_000)
    expect(plan).toEqual({
      providerOptions: { anthropic: { thinking: { type: 'enabled', budgetTokens: 8000 } } },
      omitTempParams: true,
    })
  })

  it('uses explicit max_tokens as the budget (wins over effort)', () => {
    const plan = planReasoning('anthropic', opts({ effort: 'high', max_tokens: 5000 }), 10_000)
    expect((plan!.providerOptions!.anthropic.thinking as any).budgetTokens).toBe(5000)
  })

  it('clamps the budget to [1024, 128000]', () => {
    const low = planReasoning('anthropic', opts({ max_tokens: 500 }))
    expect((low!.providerOptions!.anthropic.thinking as any).budgetTokens).toBe(1024)
    const high = planReasoning('anthropic', opts({ max_tokens: 200_000 }))
    expect((high!.providerOptions!.anthropic.thinking as any).budgetTokens).toBe(128_000)
  })

  it('falls back to a 16k base when no request max tokens is given', () => {
    const plan = planReasoning('anthropic', opts({ effort: 'high' }))
    // floor(16000 * 0.8) = 12800
    expect((plan!.providerOptions!.anthropic.thinking as any).budgetTokens).toBe(12_800)
  })

  it('maps legacy thinkingBudget to the budget', () => {
    const plan = planReasoning('anthropic', opts(undefined, 3000))
    expect((plan!.providerOptions!.anthropic.thinking as any).budgetTokens).toBe(3000)
    expect(plan!.omitTempParams).toBe(true)
  })
})

describe('planReasoning — openrouter', () => {
  it('passes effort through, keeps temp params', () => {
    const plan = planReasoning('openrouter', opts({ effort: 'high' }))
    expect(plan).toEqual({
      providerOptions: { openrouter: { reasoning: { effort: 'high' } } },
      omitTempParams: false,
    })
  })

  it('prefers max_tokens over effort', () => {
    const plan = planReasoning('openrouter', opts({ effort: 'high', max_tokens: 2000 }))
    expect(plan!.providerOptions!.openrouter.reasoning).toEqual({ max_tokens: 2000 })
  })

  it('includes exclude when set', () => {
    const plan = planReasoning('openrouter', opts({ effort: 'high', exclude: true }))
    expect(plan!.providerOptions!.openrouter.reasoning).toEqual({ effort: 'high', exclude: true })
  })

  it('falls back to enabled:true when only enabled is set', () => {
    const plan = planReasoning('openrouter', opts({ enabled: true }))
    expect(plan!.providerOptions!.openrouter.reasoning).toEqual({ enabled: true })
  })
})

describe('planReasoning — openai / chatgpt-subscription', () => {
  it('emits reasoningEffort + reasoningSummary (default auto)', () => {
    const plan = planReasoning('openai', opts({ effort: 'high' }))
    expect(plan).toEqual({
      providerOptions: { openai: { reasoningEffort: 'high', reasoningSummary: 'auto' } },
      omitTempParams: false,
    })
  })

  it('honors an explicit summary', () => {
    const plan = planReasoning('openai', opts({ effort: 'medium', summary: 'detailed' }))
    expect(plan!.providerOptions!.openai).toEqual({ reasoningEffort: 'medium', reasoningSummary: 'detailed' })
  })

  it('derives an effort level from a max_tokens budget', () => {
    // 8000 / 10000 = 0.8 ratio → 'high'
    const plan = planReasoning('openai', opts({ max_tokens: 8000 }), 10_000)
    expect(plan!.providerOptions!.openai.reasoningEffort).toBe('high')
  })

  it('defaults to medium effort when neither effort nor budget is given', () => {
    const plan = planReasoning('openai', opts({ enabled: true }))
    expect(plan!.providerOptions!.openai.reasoningEffort).toBe('medium')
  })
})
