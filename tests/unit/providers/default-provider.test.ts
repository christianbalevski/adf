import { describe, expect, it } from 'vitest'
import { applyDefaultProviderToOptions, resolveDefaultProvider } from '../../../src/main/adf/apply-default-provider'
import type { ProviderConfig } from '../../../src/shared/types/ipc.types'

const providers: ProviderConfig[] = [
  { id: 'p1', type: 'anthropic', name: 'Anthropic', apiKey: 'k1', defaultModel: 'model-a' },
  { id: 'p2', type: 'openai', name: 'OpenAI', apiKey: 'k2', defaultModel: 'model-b' },
]

describe('resolveDefaultProvider', () => {
  it('returns the provider marked default', () => {
    expect(resolveDefaultProvider(providers, 'p2')?.id).toBe('p2')
  })

  it('falls back to the first provider when none is marked default', () => {
    expect(resolveDefaultProvider(providers, undefined)?.id).toBe('p1')
  })

  it('falls back to the first provider when the marked default no longer exists', () => {
    expect(resolveDefaultProvider(providers, 'gone')?.id).toBe('p1')
  })

  it('returns undefined when no providers are configured', () => {
    expect(resolveDefaultProvider([], undefined)).toBeUndefined()
    expect(resolveDefaultProvider([], 'p1')).toBeUndefined()
  })
})

describe('applyDefaultProviderToOptions', () => {
  it('fills model and copies the provider (sans secrets) when none specified', () => {
    const out = applyDefaultProviderToOptions({ name: 'child' }, providers[0])
    expect(out.model?.provider).toBe('p1')
    expect(out.model?.model_id).toBe('model-a')
    expect(out.providers).toHaveLength(1)
    expect(out.providers?.[0].id).toBe('p1')
    expect((out.providers?.[0] as Record<string, unknown>).apiKey).toBeUndefined()
  })

  it('leaves options unchanged when a provider is already specified', () => {
    const opts = { name: 'child', model: { provider: 'mine', model_id: 'x' } }
    expect(applyDefaultProviderToOptions(opts, providers[0])).toBe(opts)
  })
})
