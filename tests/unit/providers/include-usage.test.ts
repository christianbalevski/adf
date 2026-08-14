import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * openai-compatible backends (llama.cpp, LM Studio, vLLM, proxies, xAI) only
 * emit a usage chunk when `stream_options.include_usage` is set. Without it
 * every streaming turn reports zero usage and the runtime falls back to a
 * char-based estimate — which blinds the auto-compact gate.
 */

const captured: Array<Record<string, unknown>> = []

vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: (options: Record<string, unknown>) => {
    captured.push(options)
    const provider = (modelId: string) => ({ modelId, specificationVersion: 'v3' })
    return provider
  }
}))

import { createProvider } from '../../../src/main/providers/provider-factory'
import { createGrokSubscriptionProvider } from '../../../src/main/providers/grok-subscription'
import type { ProviderConfig } from '../../../src/shared/types/ipc.types'
import type { AgentConfig } from '../../../src/shared/types/adf-v02.types'

function agent(params?: Array<{ key: string; value: string }>): AgentConfig {
  return {
    name: 'agent-1',
    model: { provider: 'local', model_id: 'llama-3', ...(params ? { params } : {}) }
  } as unknown as AgentConfig
}

const localProvider: ProviderConfig = {
  id: 'local',
  type: 'custom',
  name: 'Local',
  apiKey: '',
  baseUrl: 'http://127.0.0.1:8080/v1'
} as ProviderConfig

const settings = { getProvider: (id: string) => (id === 'local' ? localProvider : undefined) }

beforeEach(() => {
  captured.length = 0
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('openai-compatible providers request streaming usage', () => {
  it('sets includeUsage on the pooled custom provider', () => {
    createProvider(agent(), settings)
    expect(captured.length).toBeGreaterThan(0)
    expect(captured[captured.length - 1].includeUsage).toBe(true)
  })

  it('sets includeUsage on the param-injected custom provider', () => {
    createProvider(agent([{ key: 'top_k', value: '40' }]), settings)
    const opts = captured[captured.length - 1]
    expect(opts.includeUsage).toBe(true)
    expect(typeof opts.fetch).toBe('function')
  })

  it('sets includeUsage on the grok subscription provider', () => {
    createGrokSubscriptionProvider({ getValidAccessToken: async () => 'token' })
    expect(captured[captured.length - 1].includeUsage).toBe(true)
  })
})

describe('include_usage reaches the wire', () => {
  it('emits stream_options.include_usage in the request body', async () => {
    vi.resetModules()
    vi.doUnmock('@ai-sdk/openai-compatible')
    const { createOpenAICompatible } = await vi.importActual<
      typeof import('@ai-sdk/openai-compatible')
    >('@ai-sdk/openai-compatible')

    let body: Record<string, unknown> | undefined
    const provider = createOpenAICompatible({
      name: 'probe',
      baseURL: 'http://127.0.0.1:9/v1',
      includeUsage: true,
      fetch: (async (_input, init) => {
        body = JSON.parse(String(init?.body))
        throw new Error('captured')
      }) as typeof globalThis.fetch
    })

    await expect(
      provider('m').doStream({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
      } as never)
    ).rejects.toThrow()

    expect(body?.stream).toBe(true)
    expect(body?.stream_options).toEqual({ include_usage: true })
  })
})
