import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHeadlessAgent, MockLLMProvider } from '../../../src/main/runtime/headless'
import { createProvider } from '../../../src/main/providers/provider-factory'
import { mediaPlaceholder } from '../../../src/main/runtime/message-media-projection'
import { createDispatch, createEvent } from '../../../src/shared/types/adf-event.types'
import type { AgentConfig } from '../../../src/shared/types/adf-v02.types'
import type { ProviderConfig } from '../../../src/shared/types/ipc.types'
import type { ContentBlock, LLMMessage } from '../../../src/shared/types/provider.types'

const turn = (agent: ReturnType<typeof createHeadlessAgent>, text = 'continue') => agent.executor.executeTurn(createDispatch(createEvent({
  type: 'chat', source: 'test', data: { message: { seq: 0, role: 'user', content_json: [{ type: 'text', text }], created_at: 1234 } },
}), { scope: 'agent' }))

/** The status notices this agent's loop recorded. */
const notices = (agent: ReturnType<typeof createHeadlessAgent>) => agent.workspace.getLoop()
  .flatMap(row => row.content_json)
  .filter(block => block.type === 'text' && block.text?.startsWith('[Context: status] [System] Not sent to this model'))
  .map(block => block.text!)

afterEach(() => vi.unstubAllGlobals())

describe('live model media policy changes', () => {
  it('filters requests without deleting retained media or changing the stored loop, and says so once per turn', async () => {
    const provider = new MockLLMProvider()
    const requests: LLMMessage[][] = []
    vi.spyOn(provider, 'createMessage').mockImplementation(async options => {
      requests.push(structuredClone(options.messages))
      return { id: 'reply', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 1 } }
    })
    const agent = createHeadlessAgent({ name: 'agent-1', provider, profile: 'benchmark', registerTools() {} })
    const events: Array<{ category?: string; content?: string }> = []
    agent.executor.on('event', (event: { type: string; payload: { category?: string; content?: string } }) => {
      if (event.type === 'context_injected' && event.payload.category === 'status') events.push(event.payload)
    })
    const media: ContentBlock[] = [
      { type: 'text', text: 'Saved file: clip.mp4' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } },
      { type: 'input_audio', input_audio: { data: 'YXVkaW8=', format: 'wav' } },
      { type: 'video_url', video_url: { url: 'data:video/mp4;base64,dmlkZW8=' } },
    ]
    try {
      agent.session.addMessage({ role: 'user', content: media })
      const config = agent.executor.getConfig()
      const capable = { ...config, model: { ...config.model, multimodal: { image: true, audio: true, video: true } } }
      agent.executor.updateConfig(capable)
      await turn(agent)
      expect(notices(agent)).toHaveLength(0)
      agent.executor.updateConfig({ ...config, model: { ...config.model, model_id: 'text-model', multimodal: { image: false, audio: false, video: false } } })
      await turn(agent)
      expect(notices(agent)).toEqual([
        "[Context: status] [System] Not sent to this model: 1 image (image input is off in this agent's model settings), " +
        "1 audio (audio input is off in this agent's model settings), 1 video (video input is off in this agent's model settings). The originals stay in history.",
      ])
      expect(events.filter(event => event.content?.includes('Not sent to this model'))).toHaveLength(1)
      agent.executor.updateConfig(capable)
      await turn(agent)
      expect(notices(agent)).toHaveLength(1)
      expect(requests).toHaveLength(3)
      expect(requests[0][0].content).toEqual(media)
      expect((requests[1][0].content as ContentBlock[]).every(block => block.type === 'text')).toBe(true)
      expect(requests[2][0]).toEqual(requests[0][0])
      expect(agent.session.getMessages()[0].content).toEqual(media)
      const stored = agent.workspace.getLoop().find(row => row.seq === agent.session.getMessages()[0].seq)
      expect(stored?.content_json).toEqual([media[0]])
    } finally {
      await agent.disposeAsync({ mode: 'immediate' })
    }
  })

  it('keeps direct Anthropic turns working with video in history: a placeholder on the wire and a notice', async () => {
    const bodies: Array<{ messages: Array<{ content: unknown }> }> = []
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      bodies.push(body)
      if (!body.stream) {
        return new Response(JSON.stringify({
          id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-4-20250514',
          content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 1 },
        }), { headers: { 'content-type': 'application/json' } })
      }
      // The executor streams turns.
      const events = [
        ['message_start', { type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-4-20250514', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
        ['message_stop', { type: 'message_stop' }],
      ] as const
      return new Response(events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
    }))
    const cfg: ProviderConfig = { id: 'provider-1', type: 'anthropic', name: 'Anthropic', apiKey: 'test-key', baseUrl: '' }
    const provider = createProvider({ model: { provider: cfg.id, model_id: 'claude-sonnet-4-20250514' } } as AgentConfig, { getProvider: () => cfg })
    const agent = createHeadlessAgent({ name: 'agent-1', provider, profile: 'benchmark', registerTools() {} })
    try {
      const config = agent.executor.getConfig()
      agent.executor.updateConfig({ ...config, model: { ...config.model, multimodal: { image: true, audio: false, video: true } } })
      agent.session.addMessage({ role: 'user', content: [
        { type: 'text', text: 'Watch this' },
        { type: 'video_url', video_url: { url: 'data:video/mp4;base64,dmlkZW8=' } },
      ] })
      await turn(agent)
      expect(bodies.length).toBeGreaterThan(0)
      const wire = JSON.stringify(bodies.map(body => body.messages).find(messages => JSON.stringify(messages).includes('Watch this')))
      expect(wire).toContain(mediaPlaceholder('video'))
      expect(wire).not.toContain('dmlkZW8=')
      expect(notices(agent)).toEqual([
        '[Context: status] [System] Not sent to this model: 1 video (Anthropic does not accept video input). The originals stay in history.',
      ])
      expect(agent.executor.getState()).not.toBe('error')
      expect(agent.session.getMessages()[0].content).toContainEqual({ type: 'video_url', video_url: { url: 'data:video/mp4;base64,dmlkZW8=' } })
      // New input with video is refused at the boundary with the reason.
      expect(agent.executor.mediaInputError([{ type: 'video_url', video_url: { url: 'data:video/mp4;base64,AAAA' } }]))
        .toBe('Anthropic does not accept video input. Remove the attachment, or change the model settings.')
    } finally {
      await agent.disposeAsync({ mode: 'immediate' })
    }
  })
})
