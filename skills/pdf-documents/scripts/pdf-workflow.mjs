import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

export const MAX_PDF_BYTES = 100 * 1024 * 1024
export const MAX_PDF_PAGES = 1000
export const MAX_PDF_LINES = 100
export const MAX_PDF_TEXT_CHARS = 1_000_000

function asBytes(input, label, maxBytes = MAX_PDF_BYTES) {
  const bytes = input instanceof Uint8Array || Buffer.isBuffer(input) ? new Uint8Array(input) : null
  if (!bytes || bytes.byteLength === 0) throw new TypeError(`${label} must be a non-empty Uint8Array or Buffer`)
  if (bytes.byteLength > maxBytes) throw new RangeError(`${label} exceeds ${maxBytes} byte safety cap`)
  return bytes
}

function decodeBase64(content) {
  if (typeof content !== 'string' || content.length === 0 || content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content)) {
    throw new TypeError('VFS content must be non-empty valid base64')
  }
  return asBytes(Buffer.from(content, 'base64'), 'VFS content')
}

/** Decode a binary fs_read record. Call fs_read from sys_code, not chat. */
export function vfsBytes(fileRecord) {
  if (!fileRecord || typeof fileRecord.content !== 'string') {
    throw new TypeError('Expected a binary fs_read record with base64 content')
  }
  return decodeBase64(fileRecord.content)
}

/** Shape a binary result for fs_write({ encoding: "base64", ... }). */
export function vfsWritePayload(bytes, mimeType) {
  const safeBytes = asBytes(bytes, 'PDF output')
  return {
    content: Buffer.from(safeBytes).toString('base64'),
    encoding: 'base64',
    mime_type: mimeType,
  }
}

function savedBytes(bytes) {
  return asBytes(bytes, 'PDF output')
}

/** Create a small, text-bearing PDF suitable for deterministic workflows. */
export async function createPdf({
  title = 'ADF PDF',
  lines = ['Created by ADF'],
  width = 612,
  height = 792,
} = {}) {
  if (!Array.isArray(lines) || !lines.every((line) => typeof line === 'string')) {
    throw new TypeError('lines must be an array of strings')
  }
  if (lines.length > MAX_PDF_LINES) throw new RangeError(`lines exceeds ${MAX_PDF_LINES} line safety cap`)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || width > 10000 || height > 10000) {
    throw new RangeError('width and height must be finite positive values no larger than 10000')
  }
  const document = await PDFDocument.create()
  document.setTitle(title)
  const page = document.addPage([width, height])
  const font = await document.embedFont(StandardFonts.Helvetica)
  let y = height - 72
  for (const line of lines) {
    page.drawText(line, { x: 72, y, size: 14, font, color: rgb(0.1, 0.1, 0.1) })
    y -= 22
  }
  return savedBytes(await document.save())
}

/** Update an existing PDF without mutating the input bytes. */
export async function updatePdf(
  inputBytes,
  { text = 'Updated by ADF', title, pageIndex = 0, x = 72, y = 72, size = 12 } = {},
) {
  const source = asBytes(inputBytes, 'PDF input')
  if (typeof text !== 'string' || text.length > MAX_PDF_TEXT_CHARS) throw new RangeError('text exceeds PDF text safety cap')
  if (!Number.isInteger(pageIndex) || pageIndex < 0) throw new RangeError('pageIndex must be a non-negative integer')
  const document = await PDFDocument.load(source)
  const pages = document.getPages()
  if (pages.length > MAX_PDF_PAGES) throw new RangeError(`PDF exceeds ${MAX_PDF_PAGES} page safety cap`)
  if (!pages[pageIndex]) throw new RangeError(`No PDF page at index ${pageIndex}`)
  if (title !== undefined) document.setTitle(title)
  const font = await document.embedFont(StandardFonts.Helvetica)
  pages[pageIndex].drawText(text, { x, y, size, font, color: rgb(0.8, 0.1, 0.1) })
  return savedBytes(await document.save())
}
