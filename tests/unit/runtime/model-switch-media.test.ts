import { describe, expect, it, vi } from 'vitest'
import { createHeadlessAgent, MockLLMProvider } from '../../../src/main/runtime/headless'
import { createDispatch, createEvent } from '../../../src/shared/types/adf-event.types'
import type { ContentBlock, LLMMessage } from '../../../src/shared/types/provider.types'

describe('live model media policy changes', () => {
  it('filters requests without deleting retained media or changing the stored loop', async () => {
    const provider = new MockLLMProvider()
    const requests: LLMMessage[][] = []
    vi.spyOn(provider, 'createMessage').mockImplementation(async options => {
      requests.push(structuredClone(options.messages))
      return { id: 'reply', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 1 } }
    })
    const agent = createHeadlessAgent({ name: 'media-switch', provider, profile: 'benchmark', registerTools() {} })
    const media: ContentBlock[] = [
      { type: 'text', text: 'Saved file: clip.mp4' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } },
      { type: 'input_audio', input_audio: { data: 'YXVkaW8=', format: 'wav' } },
      { type: 'video_url', video_url: { url: 'data:video/mp4;base64,dmlkZW8=' } },
    ]
    const turn = () => agent.executor.executeTurn(createDispatch(createEvent({
      type: 'chat', source: 'test', data: { message: { seq: 0, role: 'user', content_json: [{ type: 'text', text: 'continue' }], created_at: 1234 } },
    }), { scope: 'agent' }))
    try {
      agent.session.addMessage({ role: 'user', content: media })
      const config = agent.executor.getConfig()
      const capable = { ...config, model: { ...config.model, multimodal: { image: true, audio: true, video: true } } }
      agent.executor.updateConfig(capable)
      await turn()
      agent.executor.updateConfig({ ...config, model: { ...config.model, model_id: 'text-model', multimodal: { image: false, audio: false, video: false } } })
      await turn()
      agent.executor.updateConfig(capable)
      await turn()
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
})
