import { describe, expect, it } from 'vitest'
import { projectMessageMedia } from '../../../src/main/runtime/message-media-projection'
import type { ContentBlock, LLMMessage } from '../../../src/shared/types/provider.types'

const media: ContentBlock[] = [
  { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } },
  { type: 'input_audio', input_audio: { data: 'YXVkaW8=', format: 'wav' } },
  { type: 'video_url', video_url: { url: 'data:video/mp4;base64,dmlkZW8=' } },
]

describe('request media projection', () => {
  it('keeps history intact across capable → text-only → capable model switches', () => {
    const messages: LLMMessage[] = [{ role: 'user', content: [...media], seq: 4, created_at: 1234 }]
    Object.freeze(messages[0].content)
    Object.freeze(messages[0])
    const original = structuredClone(messages)
    const enabled = { multimodal: { image: true, audio: true, video: true } }
    expect(projectMessageMedia(messages, enabled)).toBe(messages)
    const textOnly = projectMessageMedia(messages, {})
    expect(textOnly[0]).toEqual({
      ...original[0],
      content: ['image', 'audio', 'video'].map(name => ({ type: 'text', text: `[${name} attachment omitted: ${name} input is disabled for this model.]` })),
    })
    messages.push({ role: 'assistant', content: 'I can use the textual description.' })
    messages.push({ role: 'user', content: 'Continue.' })
    expect(projectMessageMedia(messages, {})).toBe(textOnly)
    expect(textOnly.slice(1)).toEqual(messages.slice(1))
    expect(projectMessageMedia(messages, enabled)).toBe(messages)
    expect(messages[0]).toEqual(original[0])
  })

  it('preserves tool pairing, text and supported media while omitting only disabled modalities', () => {
    const messages: LLMMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'read', name: 'fs_read', input: { path: 'photo.png' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read', content: 'photo.png' }, ...media] },
    ]
    const projected = projectMessageMedia(messages, { vision: true })
    expect(projected[0]).toBe(messages[0])
    expect((projected[1].content as ContentBlock[]).map(b => b.type)).toEqual(['tool_result', 'image_url', 'text', 'text'])
    expect((projected[1].content as ContentBlock[])[1]).toBe(media[0])
    expect((projectMessageMedia(messages, { vision: true, multimodal: { image: false } })[1].content as ContentBlock[])[1].type).toBe('text')
  })

  it('does not change text-only history or history containing only supported media', () => {
    const messages: LLMMessage[] = [{ role: 'user', content: 'hello' }]
    expect(projectMessageMedia(messages, {})).toBe(messages)
    messages.push({ role: 'user', content: [media[0]] })
    expect(projectMessageMedia(messages, { multimodal: { image: true } })).toBe(messages)
    expect(projectMessageMedia(messages, {})).not.toBe(messages)
  })

  it('rebuilds after session repair/pruning replaces history', () => {
    const messages: LLMMessage[] = [{ role: 'user', content: [...media] }]
    projectMessageMedia(messages, {})
    const repaired: LLMMessage[] = [{ role: 'user', content: 'Media removed during reset.' }]
    expect(projectMessageMedia(repaired, {})).toBe(repaired)
  })
})
