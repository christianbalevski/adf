/**
 * Request-time resolution of file references (`file_ref` blocks).
 *
 * History stores references, never media bytes. Each request loads the bytes
 * of the referenced files from the agent's Files and sends them as native
 * media blocks. Runs after projectMessageMedia (message-media-projection.ts),
 * so every reference left here is a kind the model takes.
 *
 * Prompt caching: a reference resolves to the same string every time (same
 * file, same base64, same order), so an older message is byte-identical across
 * requests. The resolved array is cached per input array and grows by
 * appending, like the projection and the provider conversion caches. It is
 * rebuilt only when a file a request carried changes, or when the request
 * media limit moves its window.
 */

import type { ContentBlock, FileRef, LLMMessage } from '../../shared/types/provider.types'
import type { MediaKind } from '../../shared/types/media.types'
import { deletedFilePlaceholder, fileRefKind, fileRefName, fileRefText, isFileRefBlock, mediaKindOfMime } from '../../shared/utils/file-ref'
import { formatSize, mimeToAudioFormat, mimeToExt } from '../tools/built-in/mime-utils'
import type { FileRefRegistry, MediaPayload } from '../adf/file-ref-registry'
import type { AdfWorkspace } from '../adf/adf-workspace'

/** Where media that arrives inline in a chat message is saved (Studio's uploads folder). */
export const UPLOAD_DIR = 'loop-upload'

/**
 * The request media limit: at most this many referenced files and bytes per
 * request. Provider limits are lower than any long history: Anthropic takes at
 * most 100 images and 32 MB, and caps image size once a request has more than
 * 20 images. Past the limit the oldest references are left out, down to half
 * the limit, so the window moves (and the cached prefix changes) once per ten
 * new attachments rather than on every one. History keeps them all.
 */
export const REQUEST_MEDIA_MAX_ITEMS = 20
export const REQUEST_MEDIA_MAX_BYTES = 20 * 1024 * 1024

/** Per-file size limits (`limits.max_image_size_bytes` and its siblings). */
export type MediaSizeLimits = Readonly<Record<MediaKind, number>>

export const DEFAULT_MEDIA_SIZE_LIMITS: MediaSizeLimits = Object.freeze({
  image: 5_242_880,
  audio: 10_485_760,
  video: 20_971_520,
})

export type MediaCounts = Partial<Record<MediaKind, number>>

export interface FileRefsNotSent {
  /** Over the per-file size limit. */
  oversize: MediaCounts
  /** Older than the request media limit's window. */
  overLimit: MediaCounts
}

export interface FileRefResolution {
  messages: LLMMessage[]
  /** References that became placeholders for a reason the owner can change; null when none. */
  notSent: FileRefsNotSent | null
}

/** Reads a file's bytes; null when the file does not exist. */
export type ReadFileBytes = (path: string) => Buffer | null

export function oversizePlaceholder(ref: FileRef, kind: MediaKind, size: number, limit: number): string {
  return `[${kind} not sent: ${fileRefName(ref)} is ${formatSize(size)}, over the ${formatSize(limit)} limit]`
}

export function overLimitPlaceholder(ref: FileRef, kind: MediaKind): string {
  return `[${kind} not sent: ${fileRefName(ref)}, outside the request media limit (${REQUEST_MEDIA_MAX_ITEMS} files, ${formatSize(REQUEST_MEDIA_MAX_BYTES)})]`
}

/** The payload a request carries for this file, in the shape the provider layer takes. */
export function mediaPayloadOf(kind: MediaKind, mime: string, bytes: Buffer): MediaPayload {
  const base64 = bytes.toString('base64')
  return { mime, size: bytes.length, payload: kind === 'audio' ? base64 : `data:${mime};base64,${base64}` }
}

/** The same payload from base64 already in hand (fs_read returns it). */
export function mediaPayloadFromBase64(kind: MediaKind, mime: string, size: number, base64: string): MediaPayload {
  return { mime, size, payload: kind === 'audio' ? base64 : `data:${mime};base64,${base64}` }
}

/** A reference to a media file in Files, or null when the file is missing or not model media. */
export function makeFileRef(workspace: Pick<AdfWorkspace, 'getFileMeta'>, path: string): ContentBlock | null {
  const meta = workspace.getFileMeta(path)
  if (!meta?.mime_type || !mediaKindOfMime(meta.mime_type)) return null
  return { type: 'file_ref', file_ref: { path: meta.path, mime_type: meta.mime_type, size: meta.size } }
}

const AUDIO_MIME_BY_FORMAT: Record<string, string> = {
  wav: 'audio/wav', mp3: 'audio/mpeg', aiff: 'audio/aiff', aac: 'audio/aac',
  ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/x-m4a', webm: 'audio/webm',
}

/** `data:<mime>;base64,<data>` → its parts, or null for any other URL. */
function parseDataUri(url: string): { mime: string; base64: string } | null {
  const match = /^data:([^;,]+)(?:;[^,;]+)*;base64,/.exec(url)
  if (!match) return null
  return { mime: match[1].toLowerCase(), base64: url.slice(match[0].length) }
}

/**
 * A chat message's content as history stores it: inline media (data URIs,
 * base64 audio from the HTTP API or an older client) is saved to Files under
 * `loop-upload/` and becomes a reference; a reference is checked against
 * Files (its type and size come from the file; a missing file is a
 * tombstone). Everything else is unchanged. Identical bytes reuse the file
 * they are already in.
 */
export function ingestMessageMedia(workspace: Pick<AdfWorkspace, 'getFileMeta' | 'writeFileBufferUnique'>, content: ContentBlock[]): ContentBlock[] {
  if (!content.some(block => block.type === 'file_ref' || block.type === 'image_url' || block.type === 'input_audio' || block.type === 'video_url')) return content
  return content.map((block): ContentBlock => {
    if (isFileRefBlock(block)) {
      const meta = workspace.getFileMeta(block.file_ref.path)
      if (!meta) return { type: 'file_ref', file_ref: { ...block.file_ref, deleted: true } }
      return { type: 'file_ref', file_ref: { path: meta.path, mime_type: meta.mime_type ?? block.file_ref.mime_type, size: meta.size } }
    }
    let inline: { mime: string; base64: string; kind: MediaKind } | null = null
    if (block.type === 'image_url' && block.image_url) {
      const uri = parseDataUri(block.image_url.url)
      if (uri) inline = { ...uri, kind: 'image' }
    } else if (block.type === 'video_url' && block.video_url) {
      const uri = parseDataUri(block.video_url.url)
      if (uri) inline = { ...uri, kind: 'video' }
    } else if (block.type === 'input_audio' && block.input_audio) {
      const format = block.input_audio.format.toLowerCase()
      inline = { mime: AUDIO_MIME_BY_FORMAT[format] ?? `audio/${format}`, base64: block.input_audio.data, kind: 'audio' }
    }
    if (!inline) return block
    try {
      const bytes = Buffer.from(inline.base64, 'base64')
      const ext = inline.kind === 'audio' ? `.${block.input_audio!.format.toLowerCase()}` : mimeToExt(inline.mime)
      const path = workspace.writeFileBufferUnique(`${UPLOAD_DIR}/${inline.kind}${ext}`, bytes, inline.mime)
      return { type: 'file_ref', file_ref: { path, mime_type: inline.mime, size: bytes.length } }
    } catch (error) {
      return { type: 'text', text: `[${inline.kind} attachment not saved: ${error instanceof Error ? error.message : String(error)}]` }
    }
  })
}

function mediaBlock(kind: MediaKind, ref: FileRef, payload: MediaPayload): ContentBlock {
  if (kind === 'image') return { type: 'image_url', image_url: { url: payload.payload } }
  if (kind === 'audio') return { type: 'input_audio', input_audio: { data: payload.payload, format: mimeToAudioFormat(ref.mime_type) } }
  return { type: 'video_url', video_url: { url: payload.payload } }
}

/** A reference the request may carry, in history order. */
interface Candidate {
  kind: MediaKind
  bytes: number
}

/**
 * Index of the first candidate inside the request media limit. Deterministic
 * from the candidates alone: the same history gives the same window after a
 * restart. The newest candidate is always inside (its own size limit applies).
 */
export function requestMediaFloor(candidates: readonly Pick<Candidate, 'bytes'>[]): number {
  let start = 0
  let count = 0
  let bytes = 0
  for (let i = 0; i < candidates.length; i++) {
    count++
    bytes += candidates[i].bytes
    if (count <= REQUEST_MEDIA_MAX_ITEMS && bytes <= REQUEST_MEDIA_MAX_BYTES) continue
    while (start < i && (count > REQUEST_MEDIA_MAX_ITEMS / 2 || bytes > REQUEST_MEDIA_MAX_BYTES / 2)) {
      bytes -= candidates[start].bytes
      count--
      start++
    }
  }
  return start
}

interface Cached {
  length: number
  generation: number
  signature: string
  floor: number
  messages: LLMMessage[]
}

const resolutions = new WeakMap<LLMMessage[], Cached>()

const yieldToEventLoop = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

/**
 * Replace every file reference in `messages` with the file's media, or with a
 * placeholder: `[deleted: name]` for a deleted or missing file, a reason for
 * one over its size limit or outside the request media limit, and the
 * reference as text for a file that is not model media. Never throws for a
 * missing file; never changes `messages`.
 *
 * Reads happen only on a cache miss, one file at a time with a yield to the
 * event loop before each read.
 */
export async function resolveFileRefs(
  messages: LLMMessage[],
  registry: FileRefRegistry,
  readFile: ReadFileBytes,
  limits: MediaSizeLimits,
): Promise<FileRefResolution> {
  const prior = resolutions.get(messages)
  const priorLength = prior && prior.length <= messages.length ? prior.length : 0

  // One pass over the history, no reads: which references a request may
  // carry (the candidates, which decide the window) and which are over their
  // size limit.
  const candidates: Candidate[] = []
  const oversize: MediaCounts = {}
  let candidatesBeforePrior = 0
  let anyRef = false
  for (let i = 0; i < messages.length; i++) {
    if (i === priorLength) candidatesBeforePrior = candidates.length
    const content = messages[i].content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (!isFileRefBlock(block)) continue
      anyRef = true
      const kind = fileRefKind(block.file_ref)
      if (block.file_ref.deleted || !kind) continue
      if (block.file_ref.size > limits[kind]) oversize[kind] = (oversize[kind] ?? 0) + 1
      else candidates.push({ kind, bytes: block.file_ref.size })
    }
  }
  if (priorLength === messages.length) candidatesBeforePrior = candidates.length
  if (!anyRef) return { messages, notSent: null }

  const floor = requestMediaFloor(candidates)
  const overLimit: MediaCounts = {}
  for (let i = 0; i < floor; i++) overLimit[candidates[i].kind] = (overLimit[candidates[i].kind] ?? 0) + 1

  const generation = registry.generation
  const signature = `${limits.image}|${limits.audio}|${limits.video}`
  let cached = prior
  let candidateIndex = candidatesBeforePrior
  if (!cached || priorLength !== cached.length || cached.generation !== generation || cached.signature !== signature || cached.floor !== floor) {
    cached = { length: 0, generation, signature, floor, messages: [] }
    resolutions.set(messages, cached)
    candidateIndex = 0
  }

  for (let i = cached.length; i < messages.length; i++) {
    const message = messages[i]
    if (!Array.isArray(message.content) || !message.content.some(isFileRefBlock)) {
      cached.messages.push(message)
      cached.length = i + 1
      continue
    }
    const content: ContentBlock[] = []
    for (const block of message.content) {
      if (!isFileRefBlock(block)) {
        content.push(block)
        continue
      }
      const ref = block.file_ref
      const kind = fileRefKind(ref)
      if (ref.deleted) {
        content.push({ type: 'text', text: deletedFilePlaceholder(ref) })
      } else if (!kind) {
        content.push({ type: 'text', text: fileRefText(ref) })
      } else if (ref.size > limits[kind]) {
        content.push({ type: 'text', text: oversizePlaceholder(ref, kind, ref.size, limits[kind]) })
      } else if (candidateIndex++ < floor) {
        content.push({ type: 'text', text: overLimitPlaceholder(ref, kind) })
      } else {
        const payload = await loadPayload(registry, readFile, ref, kind)
        if (!payload) content.push({ type: 'text', text: deletedFilePlaceholder(ref) })
        else if (payload.size > limits[kind]) content.push({ type: 'text', text: oversizePlaceholder(ref, kind, payload.size, limits[kind]) })
        else content.push(mediaBlock(kind, ref, payload))
      }
    }
    cached.messages.push({ ...message, content })
    cached.length = i + 1
  }

  const any = Object.keys(oversize).length > 0 || Object.keys(overLimit).length > 0
  return { messages: cached.messages, notSent: any ? { oversize, overLimit } : null }
}

async function loadPayload(registry: FileRefRegistry, readFile: ReadFileBytes, ref: FileRef, kind: MediaKind): Promise<MediaPayload | null> {
  registry.resolved.add(ref.path)
  const hit = registry.media.get(ref.path)
  if (hit && hit.mime === ref.mime_type) return hit
  await yieldToEventLoop()
  let bytes: Buffer | null
  try {
    bytes = readFile(ref.path)
  } catch (error) {
    console.warn(`[file-ref-media] Could not read ${ref.path}:`, error)
    return null
  }
  if (!bytes) return null
  const payload = mediaPayloadOf(kind, ref.mime_type, bytes)
  registry.media.set(ref.path, payload)
  return payload
}
