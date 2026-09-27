import { describe, expect, it } from 'vitest'
import { mayBorrowAppKey, resolveAgentProviderConfig, resolveEffectiveProviderConfig } from '../../../src/main/providers/provider-factory'
import { providerSelectionChanged } from '../../../src/main/providers/provider-selection'
import type { AgentConfig } from '../../../src/shared/types/adf-v02.types'
import type { ProviderConfig } from '../../../src/shared/types/ipc.types'

const APP: ProviderConfig[] = [
  { id: 'anthropic', type: 'anthropic', name: 'Anthropic', baseUrl: '', apiKey: 'app-anthropic' },
  { id: 'custom:lm', type: 'openai-compatible', name: 'LM', baseUrl: 'http://localhost:1234/v1', apiKey: 'app-lm' },
]
const settings = { getProvider: (id: string) => APP.find(p => p.id === id) }

function config(entry: Record<string, unknown>): AgentConfig {
  return { model: { provider: entry.id, model_id: 'm' }, providers: [entry] } as unknown as AgentConfig
}

function workspace(stored: Record<string, string | null>) {
  return {
    getIdentityDecrypted: (purpose: string) => (purpose in stored ? stored[purpose] : null),
    getIdentityRow: (purpose: string) => (purpose in stored ? { purpose } : null),
  }
}

describe('app key borrowing', () => {
  it('lends the app key to a key-less copy of the same endpoint', () => {
    const r = resolveAgentProviderConfig(config({ id: 'custom:lm', type: 'openai-compatible', name: 'LM', baseUrl: 'http://LOCALHOST:1234/v1/' }), workspace({}), null, settings)
    expect(r?.apiKey).toBe('app-lm')
  })

  it('never lends it to a copy that names the same id with another base URL (key exfiltration)', () => {
    const r = resolveAgentProviderConfig(config({ id: 'custom:lm', type: 'openai-compatible', name: 'x', baseUrl: 'https://attacker.example/v1' }), workspace({}), null, settings)
    expect(r?.apiKey).toBe('')
    expect(r?.baseUrl).toBe('https://attacker.example/v1')
  })

  it('never lends it across types (an anthropic id re-typed as openai-compatible)', () => {
    const r = resolveAgentProviderConfig(config({ id: 'anthropic', type: 'openai-compatible', name: 'x', baseUrl: 'https://attacker.example/v1' }), workspace({}), null, settings)
    expect(r?.apiKey).toBe('')
    // resolveEffectiveProviderConfig applies the same rule to a key-less copy.
    expect(resolveEffectiveProviderConfig('anthropic', settings, r)?.apiKey).toBe('')
  })

  it('lends to fixed-endpoint types regardless of base URL (it is not used)', () => {
    expect(mayBorrowAppKey({ type: 'anthropic', baseUrl: 'https://ignored' }, APP[0])).toBe(true)
  })

  it("uses the agent's own key, and fails closed when that key is stored but locked", () => {
    const entry = { id: 'custom:lm', type: 'openai-compatible', name: 'LM', baseUrl: 'http://localhost:1234/v1' }
    expect(resolveAgentProviderConfig(config(entry), workspace({ 'provider:custom:lm:apiKey': 'own' }), null, settings)?.apiKey).toBe('own')
    // Stored but undecryptable (null): no fallback to the app key.
    expect(resolveAgentProviderConfig(config(entry), workspace({ 'provider:custom:lm:apiKey': null }), null, settings)?.apiKey).toBe('')
    // Stored empty ('') is "no key": the same-endpoint app key is lent.
    expect(resolveAgentProviderConfig(config(entry), workspace({ 'provider:custom:lm:apiKey': '' }), null, settings)?.apiKey).toBe('app-lm')
  })
})

describe('providerSelectionChanged', () => {
  it("counts an edit of the selected providers[] entry as a provider change", () => {
    const a = config({ id: 'custom:lm', type: 'openai-compatible', name: 'LM', baseUrl: 'http://a/v1' })
    const b = config({ id: 'custom:lm', type: 'openai-compatible', name: 'LM', baseUrl: 'http://b/v1' })
    expect(providerSelectionChanged(a, b)).toBe(true)
    expect(providerSelectionChanged(a, structuredClone(a))).toBe(false)
  })
})
