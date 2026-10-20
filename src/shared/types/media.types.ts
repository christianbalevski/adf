export type MediaKind = 'image' | 'audio' | 'video'
export type MediaSupport = Readonly<Record<MediaKind, boolean>>
/** Why each modality a loop's model may not take is refused. */
export type MediaRefusals = Partial<Record<MediaKind, string>>

/** A loop's effective media: the connector's set narrowed by the agent's toggles. */
export interface LoopMedia {
  support: MediaSupport
  refusals: MediaRefusals
}
