/**
 * File references: how a message names media that lives in the agent's Files.
 *
 * A `file_ref` content block stores the path of a file in `adf_files`, never
 * its bytes. The runtime loads the bytes when it builds each request, so the
 * transcript stays small and a model that takes media sees every reference in
 * history, however old. Shared by the runtime, Studio, the TUI and the CLI so
 * every client reads a reference the same way.
 */

import type { ContentBlock, FileRef } from '../types/provider.types'
import type { MediaKind } from '../types/media.types'

const VISION_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

const AUDIO_INPUT_MIMES = new Set([
  'audio/wav', 'audio/mpeg', 'audio/mp3', 'audio/aiff',
  'audio/aac', 'audio/ogg', 'audio/flac', 'audio/x-m4a', 'audio/webm'
])

const VIDEO_INPUT_MIMES = new Set(['video/mp4', 'video/mpeg', 'video/quicktime', 'video/webm'])

export function isVisionMime(mime: string | undefined | null): boolean {
  return !!mime && VISION_MIMES.has(mime)
}

export function isAudioInputMime(mime: string | undefined | null): boolean {
  return !!mime && AUDIO_INPUT_MIMES.has(mime)
}

export function isVideoInputMime(mime: string | undefined | null): boolean {
  return !!mime && VIDEO_INPUT_MIMES.has(mime)
}

/** The media kind a model input of this type is, or undefined when it is not model media. */
export function mediaKindOfMime(mime: string | undefined | null): MediaKind | undefined {
  if (isVisionMime(mime)) return 'image'
  if (isAudioInputMime(mime)) return 'audio'
  if (isVideoInputMime(mime)) return 'video'
  return undefined
}

export function isFileRefBlock(block: ContentBlock): block is ContentBlock & { type: 'file_ref'; file_ref: FileRef } {
  return block.type === 'file_ref' && !!block.file_ref && typeof block.file_ref.path === 'string'
}

/** The media kind a reference carries, or undefined (not media). A deleted reference still has its kind. */
export function fileRefKind(ref: FileRef): MediaKind | undefined {
  return mediaKindOfMime(ref.mime_type)
}

/** The file name a reference shows: the last path segment. */
export function fileRefName(ref: Pick<FileRef, 'path'>): string {
  const segments = ref.path.split('/')
  return segments[segments.length - 1] || ref.path
}

/** What a deleted reference becomes, in the request and in every chat view. */
export function deletedFilePlaceholder(ref: Pick<FileRef, 'path'>): string {
  return `[deleted: ${fileRefName(ref)}]`
}

/** `adf-file://` URL of a file in the open agent's Files (each segment encoded). */
export function adfFileUrl(path: string): string {
  return `adf-file://${path.split('/').map(encodeURIComponent).join('/')}`
}

/** One reference as a chat view shows it. */
export interface DisplayAttachment {
  path: string
  name: string
  mime_type: string
  kind?: MediaKind
  /** The file was deleted: show `deletedFilePlaceholder`. */
  deleted?: true
}

export function displayAttachment(ref: FileRef): DisplayAttachment {
  const kind = fileRefKind(ref)
  return {
    path: ref.path,
    name: fileRefName(ref),
    mime_type: ref.mime_type,
    ...(kind ? { kind } : {}),
    ...(ref.deleted ? { deleted: true as const } : {}),
  }
}

/** Every reference in a message, as the chat shows it. */
export function attachmentsOf(blocks: readonly ContentBlock[]): DisplayAttachment[] {
  const out: DisplayAttachment[] = []
  for (const block of blocks) if (isFileRefBlock(block)) out.push(displayAttachment(block.file_ref))
  return out
}

/** `adf-file://` URLs of the image references whose file still exists. */
export function attachmentImageUrls(attachments: readonly DisplayAttachment[]): string[] {
  return attachments.filter(a => !a.deleted && a.kind === 'image').map(a => adfFileUrl(a.path))
}

/** An attachment as one line of text (the TUI and CLI chat views). */
export function attachmentText(a: DisplayAttachment): string {
  return a.deleted ? deletedFilePlaceholder(a) : `[${a.kind ?? 'file'}: ${a.path}]`
}

/** A reference as one line of text (TUI, CLI, compaction transcript). */
export function fileRefText(ref: FileRef): string {
  if (ref.deleted) return deletedFilePlaceholder(ref)
  return `[${fileRefKind(ref) ?? 'file'}: ${ref.path}]`
}

/** How a file operation changes the references that name it. */
export type FileRefChange =
  | { op: 'rename'; from: string; to: string }
  | { op: 'delete'; path: string }

/**
 * `blocks` with every reference the changes name rewritten: a rename moves the
 * path, a delete marks the reference deleted (it stays as a tombstone). Returns
 * the same array when nothing changed.
 */
export function applyFileRefChanges(blocks: ContentBlock[], changes: readonly FileRefChange[]): ContentBlock[] {
  let out: ContentBlock[] | null = null
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    if (!isFileRefBlock(block) || block.file_ref.deleted) continue
    let ref: FileRef = block.file_ref
    for (const change of changes) {
      if (ref.deleted) break
      if (change.op === 'rename' && ref.path === change.from) ref = { ...ref, path: change.to }
      else if (change.op === 'delete' && ref.path === change.path) ref = { ...ref, deleted: true }
    }
    if (ref === block.file_ref) continue
    out ??= blocks.slice()
    out[i] = { ...block, file_ref: ref }
  }
  return out ?? blocks
}
