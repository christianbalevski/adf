import { describe, expect, it, vi } from 'vitest'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { createAnthropic } from '@ai-sdk/anthropic'
import { AiSdkProvider, convertMessages } from '../../../src/main/providers/ai-sdk-provider'
import type { LLMMessage } from '../../../src/shared/types/provider.types'

const firstVideo = 'data:video/mp4;base64,AAAA'
const secondVideo = 'https://example.invalid/second.webm'
type WireMessage = { role: string; content: string | Array<{ type: string; video_url?: { url: string } }> }
type WireBody = { messages: WireMessage[]; stream?: boolean }

function response(stream = false): Response {
  if (stream) {
    const chunks = [
      { id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'video-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] },
      { id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'video-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } },
    ]
    return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  }
  return new Response(JSON.stringify({
    id: 'chatcmpl-1', object: 'chat.completion', created: 1, model: 'video-model',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
  }), { headers: { 'content-type': 'application/json' } })
}

function setup(kind: 'compatible' | 'openrouter', fetchOverride?: (body: WireBody) => Promise<Response>) {
  const requests: WireBody[] = []
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as WireBody
    requests.push(body)
    return fetchOverride ? fetchOverride(body) : response(body.stream)
  })
  const model = kind === 'compatible'
    ? createOpenAICompatible({ name: 'provider-1', apiKey: 'test', baseURL: 'https://example.invalid/v1', fetch })('video-model')
    : createOpenRouter({ apiKey: 'test', fetch })('google/video-model')
  const provider = new AiSdkProvider(model, kind, 'video-model')
  return { requests, provider, model, fetch }
}

function userVideo(url: string, text = 'Inspect this video'): LLMMessage {
  return { role: 'user', content: [{ type: 'text', text }, { type: 'video_url', video_url: { url } }] }
}

function videoPositions(body: WireBody) {
  return body.messages.flatMap((message, messageIndex) => Array.isArray(message.content)
    ? message.content.filter(part => part.type === 'video_url').map(part => ({ messageIndex, url: part.video_url!.url }))
    : [])
}

for (const kind of ['compatible', 'openrouter'] as const) {
  describe(`${kind} video history on the actual SDK wire`, () => {
    it.each([false, true])('preserves repeat/append prefixes, original video positions and cached/source messages (stream=%s)', async stream => {
      const { provider, requests } = setup(kind)
      const messages = [userVideo(firstVideo)]
      const original = structuredClone(messages)
      const converted = convertMessages(messages)
      const convertedBefore = structuredClone(converted)
      const send = () => provider.createMessage({ system: 'stable system', messages, dynamicInstructions: 'Current dynamic hint', ...(stream ? { onTextDelta: () => {} } : {}) })
      await send()
      await send()
      expect(requests[1].messages).toEqual(requests[0].messages)
      expect(videoPositions(requests[0])).toEqual([{ messageIndex: 1, url: firstVideo }])
      expect(requests[0].messages.at(-1)?.content).toBe('Current dynamic hint')
      expect(messages).toEqual(original)
      expect(converted).toEqual(convertedBefore)

      messages.push({ role: 'assistant', content: 'first observation' }, userVideo(secondVideo, 'Compare with this video'))
      await send()
      await send()
      expect(requests[3].messages).toEqual(requests[2].messages)
      expect(requests[2].messages.slice(0, 2)).toEqual(requests[0].messages.slice(0, 2))
      expect(videoPositions(requests[2])).toEqual([{ messageIndex: 1, url: firstVideo }, { messageIndex: 3, url: secondVideo }])
      expect(requests[2].messages.at(-1)?.content).toBe('Current dynamic hint')
      expect(converted).toEqual(convertedBefore)
      expect(JSON.stringify(requests)).not.toContain('__adf_video')
    })

    it('keeps tool-result videos in their split follow-up message before later user context', async () => {
      const { provider, requests } = setup(kind)
      const messages: LLMMessage[] = [
        { role: 'user', content: 'read the video' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'read_video', input: {} }] },
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: 'video loaded' },
          { type: 'video_url', video_url: { url: firstVideo } },
        ] },
        { role: 'user', content: 'describe it' },
      ]
      await provider.createMessage({ system: '', messages, dynamicInstructions: 'current hint' })
      expect(requests[0].messages.map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'user', 'user', 'user'])
      expect(videoPositions(requests[0])).toEqual([{ messageIndex: 3, url: firstVideo }])
      expect(requests[0].messages[4].content).toBe('describe it')
      expect(requests[0].messages[5].content).toBe('current hint')
    })

    it('retains video-only messages and multiple videos in one historical message', async () => {
      const { provider, requests } = setup(kind)
      const messages: LLMMessage[] = [{ role: 'user', content: [
        { type: 'video_url', video_url: { url: firstVideo } },
        { type: 'video_url', video_url: { url: secondVideo } },
      ] }, { role: 'assistant', content: 'observed' }, { role: 'user', content: 'what happened?' }]
      await provider.createMessage({ system: '', messages })
      expect(videoPositions(requests[0])).toEqual([{ messageIndex: 0, url: firstVideo }, { messageIndex: 0, url: secondVideo }])
      expect(JSON.stringify(requests[0])).not.toContain('[video attached]')
    })
  })
}

describe('shared compatible model video isolation', () => {
  it('keeps overlapping video/text requests separate and never patches the shared model', async () => {
    const pending: Array<() => void> = []
    const { provider, requests, model } = setup('compatible', body => new Promise(resolve => pending.push(() => resolve(response(body.stream)))))
    const sharedModel = model as typeof model & { transformRequestBody: unknown }
    const transform = sharedModel.transformRequestBody
    const first = provider.createMessage({ system: '', messages: [userVideo(firstVideo, 'first')] })
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    expect(sharedModel.transformRequestBody).toBe(transform)
    const second = provider.createMessage({ system: '', messages: [userVideo(secondVideo, 'second')] })
    const plain = provider.createMessage({ system: '', messages: [{ role: 'user', content: 'plain text' }] })
    await vi.waitFor(() => expect(requests).toHaveLength(3))
    expect(videoPositions(requests[0])).toEqual([{ messageIndex: 0, url: firstVideo }])
    expect(videoPositions(requests[1])).toEqual([{ messageIndex: 0, url: secondVideo }])
    expect(videoPositions(requests[2])).toEqual([])
    expect(sharedModel.transformRequestBody).toBe(transform)
    pending[1]()
    pending[2]()
    pending[0]()
    await Promise.all([first, second, plain])
    expect(sharedModel.transformRequestBody).toBe(transform)
  })
})

describe('providers without video input', () => {
  it('refuse a direct video request with a plain error before anything is sent (Anthropic)', async () => {
    const fetch = vi.fn(async () => new Response('{}'))
    const model = createAnthropic({ apiKey: 'test', fetch })('claude-sonnet-4-20250514')
    const provider = new AiSdkProvider(model, 'provider-1', 'claude-sonnet-4-20250514', 0, { providerType: 'anthropic' })
    await expect(provider.createMessage({ system: '', messages: [userVideo(firstVideo)] }))
      .rejects.toThrow('Video input is not supported by this provider')
    expect(fetch).not.toHaveBeenCalled()
  })
})
