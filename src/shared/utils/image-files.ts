/**
 * Image detection for workspace files, shared by the main-process file read and
 * the editor's image viewer.
 *
 * The result is always one of the canonical types below, never the stored
 * string passed through. The viewer hands it to `new Blob(..., { type })`, and
 * `adf_files.mime_type` is whatever the writer chose — an agent can store any
 * value there — so an allowlist is the only way the blob's type stays an image.
 */

/** Largest binary file the main process will send to the renderer in one read. */
export const MAX_INLINE_BINARY_BYTES = 25 * 1024 * 1024

/** Extension → canonical type, for the formats Chromium renders in an <img>. */
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif'
}

/** Stored spellings that mean one of the canonical types. */
const IMAGE_MIME_ALIASES: Record<string, string> = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/x-png': 'image/png',
  'image/x-ms-bmp': 'image/bmp',
  'image/vnd.microsoft.icon': 'image/x-icon',
  'image/ico': 'image/x-icon'
}

const CANONICAL_IMAGE_MIMES = new Set(Object.values(IMAGE_MIME_BY_EXTENSION))

/**
 * The canonical image type for a workspace file, or null when it is not an
 * image the viewer can show. The stored mime type wins when it names a
 * supported image; anything else (missing, `application/octet-stream`, an
 * image format Chromium cannot decode such as TIFF) falls back to the
 * extension.
 */
export function resolveImageMime(path: string, storedMime?: string | null): string | null {
  if (storedMime) {
    // Drop parameters: "image/svg+xml; charset=utf-8" is still an SVG.
    const normalized = storedMime.split(';')[0].trim().toLowerCase()
    const canonical = IMAGE_MIME_ALIASES[normalized] ?? normalized
    if (CANONICAL_IMAGE_MIMES.has(canonical)) return canonical
  }
  const name = path.split('/').pop() ?? path
  const dot = name.lastIndexOf('.')
  if (dot < 0) return null
  return IMAGE_MIME_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null
}
