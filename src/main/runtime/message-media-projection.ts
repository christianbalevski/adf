import type { ModelConfig } from '../../shared/types/adf-v02.types'
import type { ContentBlock, LLMMessage } from '../../shared/types/provider.types'

type MediaPolicy = Pick<ModelConfig, 'multimodal' | 'vision'>
type Projection = { length: number; messages: LLMMessage[]; changed: boolean }
const projections = new WeakMap<LLMMessage[], Map<number, Projection>>()
const mediaBits = { image_url: 1, input_audio: 2, video_url: 4 } as const
const mediaNames = { image_url: 'image', input_audio: 'audio', video_url: 'video' } as const

/**
 * Apply the current model's configured media policy to a request, never to the
 * session. Turning a modality off must also cover media acquired before a live
 * model switch; turning it back on can reuse the original retained payload.
 * Stable placeholders keep media-only messages valid and explain the omission.
 *
 * Like provider conversion, this cache relies on AgentSession's append-only
 * array: edits/repair/pruning replace the array reference. Reuse the projected
 * array so disabled media does not force full history conversion on every step.
 */
export function projectMessageMedia(messages: LLMMessage[], policy: MediaPolicy): LLMMessage[] {
  const mask = ((policy.multimodal?.image ?? policy.vision ?? false) ? 1 : 0)
    | (policy.multimodal?.audio ? 2 : 0)
    | (policy.multimodal?.video ? 4 : 0)
  if (mask === 7) return messages

  let policies = projections.get(messages)
  if (!policies) {
    policies = new Map()
    projections.set(messages, policies)
  }
  let cached = policies.get(mask)
  if (!cached || cached.length > messages.length) {
    cached = { length: 0, messages: [], changed: false }
    policies.set(mask, cached)
  }
  for (let i = cached.length; i < messages.length; i++) {
    const message = messages[i]
    let changed = false
    const content = Array.isArray(message.content)
      ? message.content.map((block): ContentBlock => {
        if (!(block.type in mediaBits)) return block
        const type = block.type as keyof typeof mediaBits
        if (mask & mediaBits[type]) return block
        changed = true
        return { type: 'text', text: `[${mediaNames[type]} attachment omitted: ${mediaNames[type]} input is disabled for this model.]` }
      })
      : message.content
    cached.messages.push(changed ? { ...message, content } : message)
    cached.changed ||= changed
  }
  cached.length = messages.length
  return cached.changed ? cached.messages : messages
}
