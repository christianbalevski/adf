import type { ModelConfig } from '../../shared/types/adf-v02.types'
import type { ContentBlock } from '../../shared/types/provider.types'
import type { MediaKind, MediaSupport, MediaRefusals } from '../../shared/types/media.types'
import { fileRefKind, isFileRefBlock } from '../../shared/utils/file-ref'

export type { MediaKind, MediaSupport, MediaRefusals } from '../../shared/types/media.types'
type MediaToggles = Pick<ModelConfig, 'multimodal' | 'vision'>

export const MEDIA_KINDS: readonly MediaKind[] = ['image', 'audio', 'video']

/** Building blocks for a connector's own declaration (LLMProvider.media). */
export const ALL_MEDIA: MediaSupport = Object.freeze({ image: true, audio: true, video: true })
export const IMAGE_ONLY_MEDIA: MediaSupport = Object.freeze({ image: true, audio: false, video: false })

/**
 * What a connector can carry to its provider. Each connector declares this
 * itself (LLMProvider.media, set where the connector is built); this reads
 * the declaration. No declaration: the connector carries all three (local
 * servers, proxies), and the agent's toggles say what the model takes.
 *
 * This is not what a model understands: that is the owner's per-agent choice
 * (model.multimodal), which can only narrow this set.
 */
export function connectorMedia(provider: { media?: MediaSupport } | null | undefined): MediaSupport {
  return provider?.media ?? ALL_MEDIA
}

/** Whether the agent's model settings turn a modality on (`vision` is the legacy image flag). */
export function mediaToggle(model: MediaToggles | undefined, kind: MediaKind): boolean {
  if (kind === 'image') return model?.multimodal?.image ?? model?.vision ?? false
  return model?.multimodal?.[kind] ?? false
}

type Connector = { name?: string; media?: MediaSupport } | null | undefined

/** What a request may carry: the connector's media, narrowed by the agent's toggles. */
export function effectiveMediaSupport(model: MediaToggles | undefined, provider: Connector): MediaSupport {
  const carried = connectorMedia(provider)
  return {
    image: carried.image && mediaToggle(model, 'image'),
    audio: carried.audio && mediaToggle(model, 'audio'),
    video: carried.video && mediaToggle(model, 'video'),
  }
}

/**
 * The media kind a block carries to the model. A `file_ref` carries its
 * file's kind; a deleted one carries nothing (it becomes `[deleted: …]`).
 */
export function mediaKindOf(block: ContentBlock): MediaKind | undefined {
  if (block.type === 'image_url') return 'image'
  if (block.type === 'input_audio') return 'audio'
  if (block.type === 'video_url') return 'video'
  if (isFileRefBlock(block) && !block.file_ref.deleted) return fileRefKind(block.file_ref)
  return undefined
}

/** Why a modality is left out: the connector, or the agent's toggle. */
export function mediaOmissionReason(kind: MediaKind, model: MediaToggles | undefined, provider: Connector): string {
  if (!connectorMedia(provider)[kind]) return `${provider?.name || 'This provider'} does not accept ${kind} input`
  return `${kind} input is off in this agent's model settings`
}

/** The reason for each modality a request may not carry (the effective set's complement). */
export function mediaRefusals(model: MediaToggles | undefined, provider: Connector): MediaRefusals {
  const support = effectiveMediaSupport(model, provider)
  const refusals: MediaRefusals = {}
  for (const kind of MEDIA_KINDS) if (!support[kind]) refusals[kind] = mediaOmissionReason(kind, model, provider)
  return refusals
}

/**
 * Why new input cannot go to this model, or null. New input is refused rather
 * than sent without its attachments: the sender sees the reason and can resend.
 */
export function unsupportedMediaInput(content: readonly ContentBlock[] | undefined, model: MediaToggles | undefined, provider: Connector): string | null {
  if (!content?.length) return null
  const refusals = mediaRefusals(model, provider)
  const refused = new Set<MediaKind>()
  for (const block of content) {
    const kind = mediaKindOf(block)
    if (kind && refusals[kind]) refused.add(kind)
  }
  if (refused.size === 0) return null
  const reasons = MEDIA_KINDS.filter(kind => refused.has(kind)).map(kind => refusals[kind]!)
  const first = reasons[0]
  return `${[first[0].toUpperCase() + first.slice(1), ...reasons.slice(1)].join('; ')}. Remove the attachment, or change the model settings.`
}
