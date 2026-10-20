import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { hasCredential, providerReady, recommendedModel } from '../../../src/renderer/components/providers/provider-ready'
import { doneBlockedReason, keyCheckResult } from '../../../src/renderer/components/providers/ProviderModal'
import { insertSuggestion } from '../../../src/renderer/components/home/suggestions'
import type { ProviderConfig } from '../../../src/shared/types/ipc.types'

/**
 * First run on Home: the connect card stays until a provider can run a turn,
 * the provider sheet's Done waits for a key or a sign-in and a model, a key
 * check says how it went, and a suggestion chip never replaces a draft.
 */

;(globalThis as { React?: typeof React }).React = React

const provider = (patch: Partial<ProviderConfig> = {}): ProviderConfig =>
  ({ id: '6f1c2c1e-3b0a-4c55-9a51-2f6c1d1a0b7e', type: 'openai', preset: 'openai', name: 'agent-1 LLM', baseUrl: '', apiKey: '', defaultModel: '', params: [], ...patch }) as ProviderConfig

describe('a provider ready to run a new agent', () => {
  it('an empty tile is not ready: no key, no model', () => {
    expect(providerReady(provider(), undefined)).toBe(false)
    expect(providerReady(provider({ apiKey: 'sk-test' }), undefined)).toBe(false)
    expect(providerReady(provider({ defaultModel: 'gpt-4o' }), undefined)).toBe(false)
  })

  it('a key and a model are ready, unless the test says the provider is not configured', () => {
    expect(providerReady(provider({ apiKey: 'sk-test', defaultModel: 'gpt-4o' }), undefined)).toBe(true)
    expect(providerReady(provider({ apiKey: 'sk-test', defaultModel: 'gpt-4o' }), 'failed')).toBe(true)
    expect(providerReady(provider({ apiKey: 'sk-test', defaultModel: 'gpt-4o' }), 'unconfigured')).toBe(false)
    expect(providerReady(provider({ apiKeyStorage: 'secret-store', apiKeyStatus: 'missing', defaultModel: 'gpt-4o' }), undefined)).toBe(false)
  })

  it('a local server needs no key; a subscription needs its test not to say unconfigured', () => {
    expect(providerReady(provider({ type: 'openai-compatible', preset: 'ollama', defaultModel: 'llama3.3' }), undefined)).toBe(true)
    expect(providerReady(provider({ type: 'chatgpt-subscription', preset: 'chatgpt-subscription', defaultModel: 'gpt-5.6-sol' }), 'ok')).toBe(true)
    expect(providerReady(provider({ type: 'chatgpt-subscription', preset: 'chatgpt-subscription', defaultModel: 'gpt-5.6-sol' }), 'unconfigured')).toBe(false)
  })

  it('a keyless custom endpoint has a credential once its test passes', () => {
    const custom = provider({ type: 'openai-compatible', preset: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1' })
    expect(hasCredential(custom, undefined, false)).toBe(false)
    expect(hasCredential(custom, 'ok', false)).toBe(true)
  })
})

describe("the provider sheet's Done", () => {
  it('waits for a key, then for a model', () => {
    expect(doneBlockedReason(provider(), 'unconfigured', null, 'OpenAI')).toBe('Enter an API key first.')
    expect(doneBlockedReason(provider({ apiKey: 'sk-test' }), 'ok', null, 'OpenAI')).toBe('Pick a model first.')
    expect(doneBlockedReason(provider({ apiKey: 'sk-test', defaultModel: 'gpt-4o' }), 'ok', null, 'OpenAI')).toBeNull()
  })

  it('a subscription waits for its sign-in', () => {
    const sub = provider({ type: 'grok-subscription', preset: 'grok-subscription', defaultModel: 'grok-4.5' })
    expect(doneBlockedReason(sub, undefined, { authenticated: false }, 'Grok')).toBe('Sign in with Grok first.')
    expect(doneBlockedReason(sub, undefined, { authenticated: true }, 'Grok')).toBeNull()
  })
})

describe('the key check under the key field', () => {
  const text = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>)
  it('says Checking, Connected or Key rejected', () => {
    expect(text(keyCheckResult('testing', true))).toBe('Checking…')
    expect(text(keyCheckResult('ok', true))).toContain('Connected')
    expect(text(keyCheckResult('failed', true))).toContain('Key rejected')
    expect(text(keyCheckResult('failed', false))).toContain('Connection failed')
    expect(keyCheckResult('unconfigured', false)).toBeUndefined()
  })
})

describe('the recommended model', () => {
  it("is the catalog's example when listed, exactly or dated, else the first", () => {
    expect(recommendedModel({ modelPlaceholder: 'e.g. gpt-4o, o3-mini' }, ['gpt-3.5-turbo', 'gpt-4o', 'o3-mini'])).toBe('gpt-4o')
    expect(recommendedModel({ modelPlaceholder: 'e.g. claude-sonnet-4-5' }, ['claude-haiku-4-5', 'claude-sonnet-4-5-20250929'])).toBe('claude-sonnet-4-5-20250929')
    expect(recommendedModel({ modelPlaceholder: 'model id' }, ['model-a', 'model-b'])).toBe('model-a')
    expect(recommendedModel(undefined, [])).toBeUndefined()
  })
})

describe('a suggestion chip', () => {
  it('fills an empty box and never replaces a typed draft', () => {
    expect(insertSuggestion('', 'Plan my week')).toBe('Plan my week')
    expect(insertSuggestion('  \n', 'Plan my week')).toBe('Plan my week')
    expect(insertSuggestion('Sort my inbox\n', 'Plan my week')).toBe('Sort my inbox\nPlan my week')
  })
})

describe('the provider sheet request', () => {
  it('hands back the connected id; a second request cancels the first; a cancel is null', async () => {
    const { useAppStore } = await import('../../../src/renderer/stores/app.store')
    const first = useAppStore.getState().connectProvider('no_provider', null)
    const second = useAppStore.getState().requestProviderSetup('provider_missing', '/w/agent-1.adf')
    expect(await first).toBeNull()
    useAppStore.getState().resolveProviderSetup('6f1c2c1e-3b0a-4c55-9a51-2f6c1d1a0b7e')
    expect(await second).toBe(true)
    const third = useAppStore.getState().connectProvider('no_provider', null)
    expect(useAppStore.getState().providerSetupRequest).toMatchObject({ reason: 'no_provider', filePath: null })
    useAppStore.getState().resolveProviderSetup(null)
    expect(await third).toBeNull()
    expect(useAppStore.getState().providerSetupRequest).toBeNull()
  })
})
