import { describe, expect, it } from 'vitest'
import {
  preLlmHookDraftFromConfig,
  validatePreLlmHookDraft,
  PRE_LLM_HOOK_MAX_TIMEOUT_MS,
  PRE_LLM_HOOK_MIN_TIMEOUT_MS,
  PRE_LLM_HOOK_MAX_LOOPS,
} from '../../../src/renderer/components/agent/pre-llm-hook-config'

describe('pre-LLM hook Studio draft', () => {
  it('loads an absent hook as an empty, all-stream draft', () => {
    expect(preLlmHookDraftFromConfig()).toEqual({ source: '', scope: 'all', loops: [], timeout_ms: '' })
    expect(validatePreLlmHookDraft(preLlmHookDraftFromConfig()).config).toBeUndefined()
  })

  it('round-trips configured source, scope, named loops, and timeout', () => {
    const draft = preLlmHookDraftFromConfig({ source: 'lib/policy.ts:transform', scope: 'loops', loops: ['future_loop'], timeout_ms: 2500 })
    expect(draft).toEqual({ source: 'lib/policy.ts:transform', scope: 'loops', loops: ['future_loop'], timeout_ms: '2500' })
    expect(validatePreLlmHookDraft(draft)).toEqual({
      errors: [],
      config: { source: 'lib/policy.ts:transform', scope: 'loops', loops: ['future_loop'], timeout_ms: 2500 },
    })
  })

  it.each([
    ['all', { source: 'lib/hook.ts', scope: 'all', loops: ['future'], timeout_ms: '' }],
    ['main', { source: 'lib/hook.ts', scope: 'main', loops: [], timeout_ms: '' }],
  ] as const)('omits loops for %s scope', (_scope, draft) => {
    const result = validatePreLlmHookDraft(draft)
    expect(result.errors).toEqual([])
    expect(result.config).toEqual(draft.scope === 'all' ? { source: 'lib/hook.ts' } : { source: 'lib/hook.ts', scope: draft.scope })
  })

  it.each([
    ['empty source', { source: ' ', scope: 'all', loops: [], timeout_ms: '' }],
    ['empty named loop', { source: 'lib/hook.ts', scope: 'loops', loops: [''], timeout_ms: '' }],
    ['duplicate named loop', { source: 'lib/hook.ts', scope: 'loops', loops: ['one', 'one'], timeout_ms: '' }],
    ['main named loop', { source: 'lib/hook.ts', scope: 'loops', loops: ['main'], timeout_ms: '' }],
    ['uppercase named loop', { source: 'lib/hook.ts', scope: 'loops', loops: ['Future'], timeout_ms: '' }],
    ['punctuated named loop', { source: 'lib/hook.ts', scope: 'loops', loops: ['future.loop'], timeout_ms: '' }],
  ] as const)('rejects %s without producing config', (_name, draft) => {
    const result = validatePreLlmHookDraft(draft)
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.config).toBeUndefined()
  })

  it('rejects more than the runtime maximum number of named loops', () => {
    const loops = Array.from({ length: PRE_LLM_HOOK_MAX_LOOPS + 1 }, (_, index) => `loop-${index}`)
    const result = validatePreLlmHookDraft({ source: 'lib/hook.ts', scope: 'loops', loops, timeout_ms: '' })
    expect(result.errors).toContain(`Choose no more than ${PRE_LLM_HOOK_MAX_LOOPS} named inner loops.`)
    expect(result.config).toBeUndefined()
  })

  it('accepts future free-form names when they match the loop identifier schema', () => {
    const result = validatePreLlmHookDraft({ source: 'lib/hook.ts', scope: 'loops', loops: ['not-yet-created_2'], timeout_ms: '' })
    expect(result.errors).toEqual([])
    expect(result.config?.loops).toEqual(['not-yet-created_2'])
  })

  it.each([
    ['', 'blank'],
    ['999', 'below minimum'],
    [String(PRE_LLM_HOOK_MAX_TIMEOUT_MS + 1), 'above maximum'],
    ['1.5', 'decimal'],
    ['Infinity', 'non-finite'],
  ])('rejects %s timeout (%s)', (timeout_ms) => {
    const result = validatePreLlmHookDraft({ source: 'lib/hook.ts', scope: 'all', loops: [], timeout_ms })
    if (timeout_ms === '') {
      expect(result.errors).toEqual([])
      expect(result.config?.timeout_ms).toBeUndefined()
    } else {
      expect(result.errors.join(' ')).toContain(`Timeout must be a whole number from ${PRE_LLM_HOOK_MIN_TIMEOUT_MS} to ${PRE_LLM_HOOK_MAX_TIMEOUT_MS}`)
      expect(result.config).toBeUndefined()
    }
  })

  it('accepts the runtime timeout boundaries and trims textual values', () => {
    const result = validatePreLlmHookDraft({ source: '  lib/hook.ts  ', scope: 'all', loops: [], timeout_ms: String(PRE_LLM_HOOK_MIN_TIMEOUT_MS) })
    expect(result).toEqual({ errors: [], config: { source: 'lib/hook.ts', timeout_ms: PRE_LLM_HOOK_MIN_TIMEOUT_MS } })
    expect(validatePreLlmHookDraft({ source: 'lib/hook.ts', scope: 'all', loops: [], timeout_ms: String(PRE_LLM_HOOK_MAX_TIMEOUT_MS) }).errors).toEqual([])
  })
})
