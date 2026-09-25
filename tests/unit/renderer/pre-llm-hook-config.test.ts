import { describe, expect, it } from 'vitest'
import {
  preLlmHookDraftFromConfig,
  validatePreLlmHookDraft,
  PRE_LLM_HOOK_MAX_TIMEOUT_MS,
  PRE_LLM_HOOK_MIN_TIMEOUT_MS,
  PRE_LLM_HOOK_MAX_LOOPS,
  PRE_LLM_HOOK_MAIN_TARGET,
  type PreLlmHookDraft,
} from '../../../src/renderer/components/agent/pre-llm-hook-config'

const draft = (patch: Partial<PreLlmHookDraft>): PreLlmHookDraft => ({
  source: 'lib/hook.ts',
  targetMode: 'targets',
  targets: [PRE_LLM_HOOK_MAIN_TARGET],
  timeout_ms: '',
  ...patch,
})

describe('pre-LLM hook Studio target draft', () => {
  it('defaults a new hook to Main only', () => {
    expect(preLlmHookDraftFromConfig()).toEqual({
      source: '', targetMode: 'targets', targets: ['main'], timeout_ms: '',
    })
    expect(validatePreLlmHookDraft(preLlmHookDraftFromConfig()).config).toBeUndefined()
  })

  it('preserves legacy all scope when opening and saving', () => {
    const loaded = preLlmHookDraftFromConfig({ source: 'lib/hook.ts', scope: 'all', timeout_ms: 2500 })
    expect(loaded).toEqual({ source: 'lib/hook.ts', targetMode: 'all', targets: [], timeout_ms: '2500' })
    expect(validatePreLlmHookDraft(loaded)).toEqual({
      errors: [], config: { source: 'lib/hook.ts', scope: 'all', timeout_ms: 2500 },
    })
  })

  it.each([
    ['main only', ['main'], { source: 'lib/hook.ts', scope: 'main' }],
    ['named only', ['future_loop'], { source: 'lib/hook.ts', scope: 'loops', loops: ['future_loop'] }],
    ['main and named loops', ['main', 'future_loop'], { source: 'lib/hook.ts', scope: 'loops', include_main: true, loops: ['future_loop'] }],
  ] as const)('maps %s targets to the compatible runtime shape', (_name, targets, config) => {
    expect(validatePreLlmHookDraft(draft({ targets }))).toEqual({ errors: [], config })
  })

  it('loads combined scope with Main before named loops', () => {
    expect(preLlmHookDraftFromConfig({
      source: 'lib/hook.ts', scope: 'loops', include_main: true, loops: ['future_loop'], timeout_ms: 2500,
    })).toEqual({ source: 'lib/hook.ts', targetMode: 'targets', targets: ['main', 'future_loop'], timeout_ms: '2500' })
  })

  it.each([
    ['empty source', draft({ source: ' ' })],
    ['empty target', draft({ targets: [''] })],
    ['duplicate target', draft({ targets: ['main', 'main'] })],
    ['main as a named-loop-looking invalid identifier', draft({ targets: ['main', 'main'] })],
    ['uppercase target', draft({ targets: ['Future'] })],
    ['punctuated target', draft({ targets: ['future.loop'] })],
  ] as const)('rejects %s without producing config', (_name, value) => {
    const result = validatePreLlmHookDraft(value)
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.config).toBeUndefined()
  })

  it('rejects more than the runtime maximum named loops but accepts Main plus 64 loops', () => {
    const loops = Array.from({ length: PRE_LLM_HOOK_MAX_LOOPS + 1 }, (_, index) => `loop-${index}`)
    const tooMany = validatePreLlmHookDraft(draft({ targets: ['main', ...loops] }))
    expect(tooMany.errors).toContain(`Choose no more than ${PRE_LLM_HOOK_MAX_LOOPS} named inner loops.`)
    expect(tooMany.config).toBeUndefined()

    const boundary = Array.from({ length: PRE_LLM_HOOK_MAX_LOOPS }, (_, index) => `loop-${index}`)
    const valid = validatePreLlmHookDraft(draft({ targets: ['main', ...boundary] }))
    expect(valid.errors).toEqual([])
    expect(valid.config).toMatchObject({ scope: 'loops', include_main: true, loops: boundary })
  })

  it('allows future free-form names matching the loop identifier schema', () => {
    const result = validatePreLlmHookDraft(draft({ targets: ['future_loop_2'] }))
    expect(result.errors).toEqual([])
    expect(result.config).toEqual({ source: 'lib/hook.ts', scope: 'loops', loops: ['future_loop_2'] })
  })

  it.each([
    ['', 'blank'],
    ['999', 'below minimum'],
    [String(PRE_LLM_HOOK_MAX_TIMEOUT_MS + 1), 'above maximum'],
    ['1.5', 'decimal'],
    ['Infinity', 'non-finite'],
  ])('validates %s timeout (%s)', (timeout_ms) => {
    const result = validatePreLlmHookDraft(draft({ timeout_ms }))
    if (timeout_ms === '') {
      expect(result.errors).toEqual([])
      expect(result.config?.timeout_ms).toBeUndefined()
    } else {
      expect(result.errors.join(' ')).toContain(`Timeout must be a whole number from ${PRE_LLM_HOOK_MIN_TIMEOUT_MS} to ${PRE_LLM_HOOK_MAX_TIMEOUT_MS}`)
      expect(result.config).toBeUndefined()
    }
  })

  it('accepts timeout boundaries and trims textual values', () => {
    const result = validatePreLlmHookDraft(draft({ source: '  lib/hook.ts  ', timeout_ms: String(PRE_LLM_HOOK_MIN_TIMEOUT_MS) }))
    expect(result).toEqual({ errors: [], config: { source: 'lib/hook.ts', scope: 'main', timeout_ms: PRE_LLM_HOOK_MIN_TIMEOUT_MS } })
    expect(validatePreLlmHookDraft(draft({ timeout_ms: String(PRE_LLM_HOOK_MAX_TIMEOUT_MS) })).errors).toEqual([])
  })

  it('keeps All streams exclusive from target rows', () => {
    const result = validatePreLlmHookDraft({ source: 'lib/hook.ts', targetMode: 'all', targets: ['main', 'future'], timeout_ms: '' })
    expect(result).toEqual({ errors: [], config: { source: 'lib/hook.ts', scope: 'all' } })
  })
})
