import type { ContentBlock, LLMMessage } from '../../shared/types/provider.types'
import { MEDIA_KINDS, mediaKindOf, type MediaKind, type MediaSupport } from '../providers/media-capabilities'

export type MediaOmissions = Partial<Record<MediaKind, number>>
export interface MediaProjection {
  messages: LLMMessage[]
  /** Attachments this request leaves out, per kind; null when none. */
  omitted: MediaOmissions | null
}

type Cached = { length: number; messages: LLMMessage[]; omitted: MediaOmissions }
const projections = new WeakMap<LLMMessage[], Map<number, Cached>>()
const bits: Record<MediaKind, number> = { image: 1, audio: 2, video: 4 }

/** Stable request text for an attachment left out. Never stored in history. */
export function mediaPlaceholder(kind: MediaKind): string {
  return `[${kind} attachment omitted: ${kind} input is not available for this model.]`
}

/**
 * Apply what the current model can take (effectiveMediaSupport) to a request,
 * never to the session. Turning a modality off also covers media acquired
 * before a live model switch; turning it back on reuses the retained payload.
 * Stable placeholders keep media-only messages valid and the prefix cacheable.
 *
 * Like provider conversion, this cache relies on AgentSession's append-only
 * array: edits/repair/pruning replace the array reference. Reuse the projected
 * array so disabled media does not force full history conversion on every step.
 */
export function projectMessageMedia(messages: LLMMessage[], support: MediaSupport): MediaProjection {
  const mask = MEDIA_KINDS.reduce((acc, kind) => acc | (support[kind] ? bits[kind] : 0), 0)
  if (mask === 7) return { messages, omitted: null }

  let policies = projections.get(messages)
  if (!policies) {
    policies = new Map()
    projections.set(messages, policies)
  }
  let cached = policies.get(mask)
  if (!cached || cached.length > messages.length) {
    cached = { length: 0, messages: [], omitted: {} }
    policies.set(mask, cached)
  }
  const omitted = cached.omitted
  for (let i = cached.length; i < messages.length; i++) {
    const message = messages[i]
    let changed = false
    const content = Array.isArray(message.content)
      ? message.content.map((block): ContentBlock => {
        const kind = mediaKindOf(block)
        if (!kind || support[kind]) return block
        changed = true
        omitted[kind] = (omitted[kind] ?? 0) + 1
        return { type: 'text', text: mediaPlaceholder(kind) }
      })
      : message.content
    cached.messages.push(changed ? { ...message, content } : message)
  }
  cached.length = messages.length
  return Object.keys(omitted).length > 0
    ? { messages: cached.messages, omitted: { ...omitted } }
    : { messages, omitted: null }
}
