import { PROVIDER_TYPES, type ProviderType } from '../../shared/constants/adf-defaults'
import type { ModelConfig } from '../../shared/types/adf-v02.types'
import type { ContentBlock } from '../../shared/types/provider.types'

export type MediaKind = 'image' | 'audio' | 'video'
export type MediaSupport = Readonly<Record<MediaKind, boolean>>
type MediaToggles = Pick<ModelConfig, 'multimodal' | 'vision'>

export const MEDIA_KINDS: readonly MediaKind[] = ['image', 'audio', 'video']

const ALL: MediaSupport = { image: true, audio: true, video: true }
const IMAGE_ONLY: MediaSupport = { image: true, audio: false, video: false }

/**
 * The media each provider's request path can carry. This is the one capability
 * source: the agent's model toggles narrow it and never widen it.
 *
 * - Anthropic and Claude Code take images, not audio or video.
 * - OpenAI and ChatGPT use the Responses API, which has no audio or video input parts.
 * - Grok goes through the OpenAI-compatible path, but xAI takes images only.
 * - OpenRouter and OpenAI-compatible endpoints (local servers, proxies) carry
 *   all three. The toggles say what the model behind them takes.
 */
const PROVIDER_MEDIA: Partial<Record<ProviderType, MediaSupport>> = {
  anthropic: IMAGE_ONLY,
  'claude-subscription': IMAGE_ONLY,
  openai: IMAGE_ONLY,
  'chatgpt-subscription': IMAGE_ONLY,
  'grok-subscription': IMAGE_ONLY,
}

export function providerMediaSupport(type: ProviderType | undefined): MediaSupport {
  return (type && PROVIDER_MEDIA[type]) || ALL
}

/** Whether the agent's model settings turn a modality on (`vision` is the legacy image flag). */
export function mediaToggle(model: MediaToggles | undefined, kind: MediaKind): boolean {
  if (kind === 'image') return model?.multimodal?.image ?? model?.vision ?? false
  return model?.multimodal?.[kind] ?? false
}

/** What a request may carry: the provider's media, narrowed by the agent's toggles. */
export function effectiveMediaSupport(model: MediaToggles | undefined, type: ProviderType | undefined): MediaSupport {
  const provider = providerMediaSupport(type)
  return {
    image: provider.image && mediaToggle(model, 'image'),
    audio: provider.audio && mediaToggle(model, 'audio'),
    video: provider.video && mediaToggle(model, 'video'),
  }
}

export function mediaKindOf(block: ContentBlock): MediaKind | undefined {
  if (block.type === 'image_url') return 'image'
  if (block.type === 'input_audio') return 'audio'
  if (block.type === 'video_url') return 'video'
  return undefined
}

function providerLabel(type: ProviderType | undefined): string {
  return PROVIDER_TYPES.find(entry => entry.type === type)?.label ?? 'This provider'
}

/** Why a modality is left out: the agent's toggle, or the provider. */
export function mediaOmissionReason(kind: MediaKind, model: MediaToggles | undefined, type: ProviderType | undefined): string {
  if (!providerMediaSupport(type)[kind]) return `${providerLabel(type)} does not accept ${kind} input`
  return `${kind} input is off in this agent's model settings`
}

/**
 * Why new input cannot go to this model, or null. New input is refused rather
 * than sent without its attachments: the sender sees the reason and can resend.
 */
export function unsupportedMediaInput(content: readonly ContentBlock[] | undefined, model: MediaToggles | undefined, type: ProviderType | undefined): string | null {
  if (!content?.length) return null
  const support = effectiveMediaSupport(model, type)
  const refused = new Set<MediaKind>()
  for (const block of content) {
    const kind = mediaKindOf(block)
    if (kind && !support[kind]) refused.add(kind)
  }
  if (refused.size === 0) return null
  const reasons = MEDIA_KINDS.filter(kind => refused.has(kind)).map(kind => mediaOmissionReason(kind, model, type))
  const first = reasons[0]
  return `${[first[0].toUpperCase() + first.slice(1), ...reasons.slice(1)].join('; ')}. Remove the attachment, or change the model settings.`
}
