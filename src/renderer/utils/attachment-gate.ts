import type { LoopMedia, MediaKind, MediaSupport } from '../../shared/types/media.types'

export type UploadKind = MediaKind | 'file'

export interface RefusedAttachment {
  name: string
  reason: string
}

/**
 * What the composer may attach natively. `loopMedia` is the running loop's
 * effective set from the runtime (its connector's media narrowed by the
 * agent's toggles, with the reasons). Before the agent runs there is no
 * connector to ask, so only the toggles narrow; the runtime still refuses the
 * rest when the message is sent.
 */
export function composerMedia(loopMedia: LoopMedia | null | undefined, toggles: MediaSupport): LoopMedia {
  if (loopMedia) return loopMedia
  const refusals: LoopMedia['refusals'] = {}
  for (const kind of ['image', 'audio', 'video'] as const) {
    if (!toggles[kind]) refusals[kind] = `${kind} input is off in this agent's model settings`
  }
  return { support: toggles, refusals }
}

/**
 * Split picked or dropped files before anything is uploaded: a media file the
 * loop's model cannot take is refused with the reason, never uploaded or sent
 * without notice. Other files pass (they go as file references).
 */
export function gateAttachments<T extends { name: string }>(
  files: readonly T[],
  kindOf: (file: T) => UploadKind,
  media: LoopMedia,
): { accepted: T[]; refused: RefusedAttachment[] } {
  const accepted: T[] = []
  const refused: RefusedAttachment[] = []
  for (const file of files) {
    const kind = kindOf(file)
    if (kind === 'file' || media.support[kind]) {
      accepted.push(file)
      continue
    }
    const reason = media.refusals[kind] ?? `${kind} input is not available for this model`
    refused.push({ name: file.name, reason: reason[0].toUpperCase() + reason.slice(1) })
  }
  return { accepted, refused }
}
