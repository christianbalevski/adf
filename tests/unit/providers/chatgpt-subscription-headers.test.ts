import { afterEach, describe, expect, it, vi } from 'vitest'
import { createChatGPTSubscriptionProvider } from '../../../src/main/providers/chatgpt-subscription'

afterEach(() => vi.unstubAllGlobals())

describe('ChatGPT subscription request headers', () => {
  it('sends an Astra-compatible Codex version through the Responses SDK', async () => {
    const fetchSpy = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('request captured'))
    vi.stubGlobal('fetch', fetchSpy)
    const { provider, setInstructions } = createChatGPTSubscriptionProvider({
      getValidAccessToken: async () => 'test-token',
      getAccountId: () => 'test-account',
    })
    setInstructions('Reply briefly.')

    await expect(provider.responses('gpt-6-astra').doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
    })).rejects.toThrow('request captured')

    expect(fetchSpy).toHaveBeenCalledOnce()
    const [url, init] = fetchSpy.mock.calls[0]
    expect(String(url)).toBe('https://chatgpt.com/backend-api/codex/responses')
    const headers = new Headers(init?.headers)
    expect(headers.get('originator')).toBe('codex_cli_rs')
    expect(headers.get('version')).toBe('0.153.0')
    expect(headers.get('Authorization')).toBe('Bearer test-token')
    expect(headers.get('ChatGPT-Account-ID')).toBe('test-account')
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'gpt-6-astra',
      instructions: 'Reply briefly.',
      stream: true,
      store: false,
    })
  })
})
