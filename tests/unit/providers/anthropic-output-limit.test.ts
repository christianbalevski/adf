import { describe, it, expect } from 'vitest'
import { createAnthropic } from '@ai-sdk/anthropic'
import { generateText } from 'ai'

/**
 * With no max tokens set, ADF sends no cap and @ai-sdk/anthropic fills the
 * required max_tokens from its model table. Models missing from that table get
 * 4096, which starves reasoning models — keep the SDK current enough to know
 * the Claude models ADF offers.
 */
async function sentMaxTokens(modelId: string): Promise<number> {
  let body: { max_tokens?: number } = {}
  const anthropic = createAnthropic({
    apiKey: 'test',
    fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({
        id: 'msg_1', type: 'message', role: 'assistant', model: modelId,
        content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { headers: { 'content-type': 'application/json' } })
    },
  })
  await generateText({ model: anthropic(modelId), prompt: 'hi' })
  return body.max_tokens ?? 0
}

describe('@ai-sdk/anthropic default output limit', () => {
  it.each(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1'])('knows %s', async (model) => {
    expect(await sentMaxTokens(model)).toBeGreaterThan(4096)
  })
})
