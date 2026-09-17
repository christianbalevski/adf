import { describe, it, expect } from 'vitest'
import { summarizeOverride, countOverrides } from '../../../src/renderer/components/providers/override-utils'
import type { ProviderConfig, ProviderCredentialFileInfo } from '../../../src/shared/types/ipc.types'

const app: ProviderConfig = {
  id: 'anthropic', type: 'anthropic', name: 'Anthropic', baseUrl: '', apiKey: 'sk-app',
  defaultModel: 'claude-app', params: [], requestDelayMs: 0,
}

const file = (over: Partial<ProviderCredentialFileInfo>): ProviderCredentialFileInfo => ({
  filePath: '/a/x.adf', fileName: 'x.adf', hasCredentials: false, populatedKeys: [], ...over,
})

describe('summarizeOverride', () => {
  it("treats Studio's unchanged key-less copy as not an override", () => {
    const s = summarizeOverride(file({ providerConfig: { defaultModel: 'claude-app', params: [], requestDelayMs: 0 } }), app)
    expect(s.isOverride).toBe(false)
    expect(s.badges).toEqual([])
  })

  it('an own key is an override', () => {
    expect(summarizeOverride(file({ hasCredentials: true, populatedKeys: ['apiKey'] }), app).badges).toEqual(['Own key'])
  })

  it('a differing model, params, or delay is an override', () => {
    const s = summarizeOverride(file({ providerConfig: { defaultModel: 'claude-other', params: [{ key: 'k', value: '1' }], requestDelayMs: 500 } }), app)
    expect(s.isOverride).toBe(true)
    expect(s.badges).toEqual(['Model: claude-other', 'Own params', 'Delay: 500 ms'])
  })

  it('ignores blank param rows and an empty model', () => {
    const s = summarizeOverride(file({ providerConfig: { defaultModel: '', params: [{ key: '', value: '' }] } }), app)
    expect(s.isOverride).toBe(false)
  })

  it('counts only real overrides', () => {
    expect(countOverrides([
      file({ providerConfig: { defaultModel: 'claude-app' } }),
      file({ filePath: '/a/y.adf', hasCredentials: true, populatedKeys: ['apiKey'] }),
    ], app)).toBe(1)
  })
})
