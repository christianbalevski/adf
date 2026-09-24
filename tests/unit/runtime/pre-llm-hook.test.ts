import { describe, expect, it } from 'vitest'

import {
  PreLlmHookError,
  preLlmHookApplies,
  validatePreLlmHookRequest,
} from '../../../src/main/runtime/pre-llm-hook'
import type { AgentConfig } from '../../../src/shared/types/adf-v02.types'

const request = {
  system: 'system',
  messages: [{ role: 'user' as const, content: 'hello' }],
  tools: [{ name: 'fs_read', description: 'read', input_schema: { type: 'object' } }],
  options: { temperature: 0.2 },
}

function config(hook: Record<string, unknown>): AgentConfig {
  return {
    pre_llm_hook: { source: 'lib/hook.ts:run', ...hook },
    limits: { execution_timeout_ms: 30_000 },
  } as AgentConfig
}

describe('pre-LLM hook contract', () => {
  it('selects all, main, and an explicit inner-loop set without requiring loops to exist yet', () => {
    expect(preLlmHookApplies(config({}), 'main')).toBe(true)
    expect(preLlmHookApplies(config({}), 'future')).toBe(true)
    expect(preLlmHookApplies(config({ scope: 'main' }), 'main')).toBe(true)
    expect(preLlmHookApplies(config({ scope: 'main' }), 'worker')).toBe(false)
    expect(preLlmHookApplies(config({ scope: 'loops', loops: ['future'] }), 'future')).toBe(true)
    expect(preLlmHookApplies(config({ scope: 'loops', loops: ['future'] }), 'main')).toBe(false)
  })

  it('accepts a valid JSON request and rejects provider-breaking tool pairs', () => {
    expect(validatePreLlmHookRequest(request)).toEqual(request)
    expect(() => validatePreLlmHookRequest({
      ...request,
      messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'fs_read', input: {} }] }],
    })).toThrow(PreLlmHookError)
  })

  it('rejects configurations that would silently broaden selector intent', () => {
    expect(() => preLlmHookApplies(config({ scope: 'all', loops: ['worker'] }), 'main')).toThrow(PreLlmHookError)
    expect(() => preLlmHookApplies(config({ scope: 'loops', loops: ['main'] }), 'main')).toThrow(PreLlmHookError)
    expect(() => preLlmHookApplies(config({ scope: 'loops', loops: ['worker', 'worker'] }), 'worker')).toThrow(PreLlmHookError)
  })
})
