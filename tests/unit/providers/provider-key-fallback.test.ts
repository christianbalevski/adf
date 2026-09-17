import { describe, it, expect } from 'vitest'
import { resolveEffectiveProviderConfig } from '../../../src/main/providers/provider-factory'
import type { ProviderConfig } from '../../../src/shared/types/ipc.types'

const app: ProviderConfig = {
  id: 'anthropic',
  type: 'anthropic',
  name: 'Anthropic',
  baseUrl: '',
  apiKey: 'sk-app',
  defaultModel: 'claude-app',
  params: [{ key: 'a', value: '1' }],
  requestDelayMs: 100,
}

const settings = {
  getProvider: (id: string) => (id === 'anthropic' ? app : undefined),
} as unknown as Parameters<typeof resolveEffectiveProviderConfig>[1]

describe('resolveEffectiveProviderConfig', () => {
  it('uses the app provider when the agent carries no copy', () => {
    expect(resolveEffectiveProviderConfig('anthropic', settings)).toBe(app)
  })

  it("borrows only the app key for a key-less agent copy (Studio's default-provider copy)", () => {
    const copy: ProviderConfig = { ...app, apiKey: '', defaultModel: 'claude-agent', params: [], requestDelayMs: 0 }
    const eff = resolveEffectiveProviderConfig('anthropic', settings, copy)
    expect(eff?.apiKey).toBe('sk-app')
    expect(eff?.defaultModel).toBe('claude-agent')
    expect(eff?.params).toEqual([])
    expect(eff?.requestDelayMs).toBe(0)
  })

  it("never replaces an agent copy's own key", () => {
    const copy: ProviderConfig = { ...app, apiKey: 'sk-agent' }
    expect(resolveEffectiveProviderConfig('anthropic', settings, copy)?.apiKey).toBe('sk-agent')
  })

  it('leaves a key-less copy key-less when no app provider shares the id', () => {
    const copy: ProviderConfig = { ...app, id: 'custom:abc', apiKey: '' }
    expect(resolveEffectiveProviderConfig('custom:abc', settings, copy)?.apiKey).toBe('')
  })

  it('returns undefined when neither side knows the provider', () => {
    expect(resolveEffectiveProviderConfig('custom:zzz', settings)).toBeUndefined()
  })
})
