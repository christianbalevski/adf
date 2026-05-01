const TEXT_MIME_PREFIXES = ['text/']
const TEXT_MIME_EXACT = new Set([
  'application/json',
  'application/xml',
  'application/yaml',
  'application/javascript',
  'application/typescript',
  'application/x-sh',
  'application/sql',
  'application/graphql',
  'application/xhtml+xml',
  'application/x-httpd-php'
])

export function isTextMime(mime: string | undefined | null): boolean {
  if (!mime) return false // no mime → assume binary (safe: base64 is lossless)
  if (TEXT_MIME_PREFIXES.some((p) => mime.startsWith(p))) return true
  return TEXT_MIME_EXACT.has(mime)
}

const VISION_MIMES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp'
])

export function isVisionMime(mime: string | undefined): boolean {
  if (!mime) return false
  return VISION_MIMES.has(mime)
}

const AUDIO_INPUT_MIMES = new Set([
  'audio/wav', 'audio/mpeg', 'audio/mp3', 'audio/aiff',
  'audio/aac', 'audio/ogg', 'audio/flac', 'audio/x-m4a', 'audio/webm'
])

export function isAudioInputMime(mime: string | undefined): boolean {
  if (!mime) return false
  return AUDIO_INPUT_MIMES.has(mime)
}

const VIDEO_INPUT_MIMES = new Set([
  'video/mp4', 'video/mpeg', 'video/quicktime', 'video/webm'
])

export function isVideoInputMime(mime: string | undefined): boolean {
  if (!mime) return false
  return VIDEO_INPUT_MIMES.has(mime)
}

const AUDIO_FORMAT_MAP: Record<string, string> = {
  'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
  'audio/aiff': 'aiff', 'audio/aac': 'aac', 'audio/ogg': 'ogg',
  'audio/flac': 'flac', 'audio/x-m4a': 'm4a', 'audio/webm': 'webm',
}

export function mimeToAudioFormat(mime: string): string {
  return AUDIO_FORMAT_MAP[mime] ?? 'wav'
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1048576).toFixed(1)} MB`
}

const MIME_TO_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/ogg': '.ogg',
  'audio/webm': '.webm',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'application/pdf': '.pdf',
  'application/json': '.json',
  'text/plain': '.txt',
  'text/html': '.html',
  'text/css': '.css',
}

export function mimeToExt(mimeType: string): string {
  return MIME_TO_EXT[mimeType] ?? '.bin'
}
