import { describe, expect, it, vi } from 'vitest'

// Subscription connectors are built without signing in; never reach a real token store.
vi.mock('../../../src/main/providers/chatgpt-subscription/auth-manager', () => ({
  getChatGptAuthManager: () => ({ getValidAccessToken: async () => 'token-1', getAccountId: async () => 'account-1' }),
}))
vi.mock('../../../src/main/providers/grok-subscription/auth-manager', () => ({
  getGrokAuthManager: () => ({ getValidAccessToken: async () => 'token-1' }),
}))

import { createProvider } from '../../../src/main/providers/provider-factory'
import { ALL_MEDIA, IMAGE_ONLY_MEDIA, connectorMedia, effectiveMediaSupport, mediaRefusals } from '../../../src/main/providers/media-capabilities'
import type { ProviderType } from '../../../src/shared/constants/adf-defaults'
import type { AgentConfig } from '../../../src/shared/types/adf-v02.types'
import type { ProviderConfig } from '../../../src/shared/types/ipc.types'

function build(type: ProviderType, model: string) {
  const cfg: ProviderConfig = { id: 'provider-1', type, name: 'Provider 1', apiKey: 'test-key', baseUrl: 'https://example.invalid/v1' }
  return createProvider({ model: { provider: cfg.id, model_id: model } } as AgentConfig, { getProvider: () => cfg })
}

describe('connector-declared media', () => {
  it.each([
    ['anthropic', 'claude-sonnet-4-20250514', IMAGE_ONLY_MEDIA],
    ['openai', 'gpt-5.5', IMAGE_ONLY_MEDIA],
    ['chatgpt-subscription', 'gpt-5.5', IMAGE_ONLY_MEDIA],
    ['grok-subscription', 'grok-4.5', IMAGE_ONLY_MEDIA],
    ['claude-subscription', 'claude-sonnet-5-5', IMAGE_ONLY_MEDIA],
    ['openrouter', 'google/gemini-3-pro', ALL_MEDIA],
    ['openai-compatible', 'local-model', ALL_MEDIA],
  ] as const)('%s declares what it carries', (type, model, expected) => {
    expect(connectorMedia(build(type, model))).toEqual(expected)
  })

  it('reads all three when a connector declares nothing', () => {
    expect(connectorMedia({})).toEqual(ALL_MEDIA)
    expect(connectorMedia(null)).toEqual(ALL_MEDIA)
  })

  it('lets the toggles narrow the declaration, never widen it', () => {
    const anthropic = build('anthropic', 'claude-sonnet-4-20250514')
    const all = { multimodal: { image: true, audio: true, video: true } }
    expect(effectiveMediaSupport(all, anthropic)).toEqual(IMAGE_ONLY_MEDIA)
    expect(effectiveMediaSupport({ multimodal: { image: false } }, anthropic)).toEqual({ image: false, audio: false, video: false })
    expect(mediaRefusals({ multimodal: { image: false, video: true } }, anthropic)).toEqual({
      image: "image input is off in this agent's model settings",
      audio: 'Provider 1 does not accept audio input',
      video: 'Provider 1 does not accept video input',
    })
  })
})
