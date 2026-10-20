import { describe, expect, it } from 'vitest'
import { mediaPlaceholder, projectMessageMedia } from '../../../src/main/runtime/message-media-projection'
import { effectiveMediaSupport, unsupportedMediaInput } from '../../../src/main/providers/media-capabilities'
import type { ContentBlock, LLMMessage } from '../../../src/shared/types/provider.types'

const media: ContentBlock[] = [
  { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } },
  { type: 'input_audio', input_audio: { data: 'YXVkaW8=', format: 'wav' } },
  { type: 'video_url', video_url: { url: 'data:video/mp4;base64,dmlkZW8=' } },
]

type Toggles = Parameters<typeof effectiveMediaSupport>[0]
const project = (messages: LLMMessage[], toggles: Toggles, type?: Parameters<typeof effectiveMediaSupport>[1]) =>
  projectMessageMedia(messages, effectiveMediaSupport(toggles, type)).messages

describe('request media projection', () => {
  it('keeps history intact across capable → text-only → capable model switches', () => {
    const messages: LLMMessage[] = [{ role: 'user', content: [...media], seq: 4, created_at: 1234 }]
    Object.freeze(messages[0].content)
    Object.freeze(messages[0])
    const original = structuredClone(messages)
    const enabled = { multimodal: { image: true, audio: true, video: true } }
    expect(project(messages, enabled)).toBe(messages)
    expect(projectMessageMedia(messages, effectiveMediaSupport({}, undefined)).omitted).toEqual({ image: 1, audio: 1, video: 1 })
    const textOnly = project(messages, {})
    expect(textOnly[0]).toEqual({
      ...original[0],
      content: (['image', 'audio', 'video'] as const).map(name => ({ type: 'text', text: mediaPlaceholder(name) })),
    })
    messages.push({ role: 'assistant', content: 'I can use the textual description.' })
    messages.push({ role: 'user', content: 'Continue.' })
    expect(project(messages, {})).toBe(textOnly)
    expect(textOnly.slice(1)).toEqual(messages.slice(1))
    expect(project(messages, enabled)).toBe(messages)
    expect(messages[0]).toEqual(original[0])
  })

  it('preserves tool pairing, text and supported media while omitting only disabled modalities', () => {
    const messages: LLMMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'read', name: 'fs_read', input: { path: 'photo.png' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read', content: 'photo.png' }, ...media] },
    ]
    const projected = project(messages, { vision: true })
    expect(projected[0]).toBe(messages[0])
    expect((projected[1].content as ContentBlock[]).map(b => b.type)).toEqual(['tool_result', 'image_url', 'text', 'text'])
    expect((projected[1].content as ContentBlock[])[1]).toBe(media[0])
    expect((project(messages, { vision: true, multimodal: { image: false } })[1].content as ContentBlock[])[1].type).toBe('text')
  })

  it('does not change text-only history or history containing only supported media', () => {
    const messages: LLMMessage[] = [{ role: 'user', content: 'hello' }]
    expect(project(messages, {})).toBe(messages)
    messages.push({ role: 'user', content: [media[0]] })
    expect(project(messages, { multimodal: { image: true } })).toBe(messages)
    expect(project(messages, {})).not.toBe(messages)
  })

  it('rebuilds after session repair/pruning replaces history', () => {
    const messages: LLMMessage[] = [{ role: 'user', content: [...media] }]
    project(messages, {})
    const repaired: LLMMessage[] = [{ role: 'user', content: 'Media removed during reset.' }]
    expect(project(repaired, {})).toBe(repaired)
  })

  it('narrows toggles by what the provider carries, never widens them', () => {
    const messages: LLMMessage[] = [{ role: 'user', content: [...media] }]
    const all = { multimodal: { image: true, audio: true, video: true } }
    const anthropic = projectMessageMedia(messages, effectiveMediaSupport(all, 'anthropic'))
    expect(anthropic.omitted).toEqual({ audio: 1, video: 1 })
    expect((anthropic.messages[0].content as ContentBlock[]).map(b => b.type)).toEqual(['image_url', 'text', 'text'])
    expect(project(messages, all, 'openrouter')).toBe(messages)
    expect(effectiveMediaSupport({}, 'openrouter')).toEqual({ image: false, audio: false, video: false })
  })

  it('names why new input is refused', () => {
    const video = [media[2]]
    expect(unsupportedMediaInput(video, { multimodal: { video: true } }, 'anthropic')).toBe(
      'Anthropic does not accept video input. Remove the attachment, or change the model settings.')
    expect(unsupportedMediaInput([media[0]], {}, 'openai-compatible')).toBe(
      "Image input is off in this agent's model settings. Remove the attachment, or change the model settings.")
    expect(unsupportedMediaInput([media[0]], { vision: true }, 'anthropic')).toBeNull()
    expect(unsupportedMediaInput([{ type: 'text', text: 'hi' }], {}, undefined)).toBeNull()
  })
})
