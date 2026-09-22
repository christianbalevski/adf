import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import * as mupdf from 'mupdf'

/** Decode a binary fs_read record. Call fs_read from sys_code, not chat. */
export function vfsBytes(fileRecord) {
  if (!fileRecord || typeof fileRecord.content !== 'string') {
    throw new TypeError('Expected a binary fs_read record with base64 content')
  }
  return new Uint8Array(Buffer.from(fileRecord.content, 'base64'))
}

/** Shape a binary result for fs_write({ encoding: "base64", ... }). */
export function vfsWritePayload(bytes, mimeType) {
  if (!(bytes instanceof Uint8Array) && !Buffer.isBuffer(bytes)) {
    throw new TypeError('Expected Uint8Array or Buffer')
  }
  return {
    content: Buffer.from(bytes).toString('base64'),
    encoding: 'base64',
    mime_type: mimeType,
  }
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
  const document = await PDFDocument.create()
  document.setTitle(title)
  const page = document.addPage([width, height])
  const font = await document.embedFont(StandardFonts.Helvetica)
  let y = height - 72
  for (const line of lines) {
    page.drawText(line, { x: 72, y, size: 14, font, color: rgb(0.1, 0.1, 0.1) })
    y -= 22
  }
  return new Uint8Array(await document.save())
}

/** Update an existing PDF without mutating the input bytes. */
export async function updatePdf(
  inputBytes,
  { text = 'Updated by ADF', title, pageIndex = 0, x = 72, y = 72, size = 12 } = {},
) {
  if (!(inputBytes instanceof Uint8Array) && !Buffer.isBuffer(inputBytes)) {
    throw new TypeError('inputBytes must be Uint8Array or Buffer')
  }
  const document = await PDFDocument.load(inputBytes)
  const pages = document.getPages()
  if (!pages[pageIndex]) throw new RangeError(`No PDF page at index ${pageIndex}`)
  if (title !== undefined) document.setTitle(title)
  const font = await document.embedFont(StandardFonts.Helvetica)
  pages[pageIndex].drawText(text, { x, y, size, font, color: rgb(0.8, 0.1, 0.1) })
  return new Uint8Array(await document.save())
}

/** Extract the text layer with MuPDF. Scanned-image pages normally return empty text. */
export function extractText(inputBytes) {
  const document = mupdf.Document.openDocument(Buffer.from(inputBytes), 'application/pdf')
  const pages = []
  for (let index = 0; index < document.countPages(); index += 1) {
    pages.push(document.loadPage(index).toStructuredText().asText())
  }
  return pages
}

/** Render one page for visual inspection; this is not OCR or redaction. */
export function renderPagePng(inputBytes, { pageIndex = 0, scale = 1.5 } = {}) {
  if (!Number.isFinite(scale) || scale <= 0) throw new RangeError('scale must be positive')
  const document = mupdf.Document.openDocument(Buffer.from(inputBytes), 'application/pdf')
  if (pageIndex < 0 || pageIndex >= document.countPages()) {
    throw new RangeError(`No PDF page at index ${pageIndex}`)
  }
  const page = document.loadPage(pageIndex)
  const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false)
  return {
    png: new Uint8Array(pixmap.asPNG()),
    width: pixmap.getWidth(),
    height: pixmap.getHeight(),
  }
}

/** Reopen and inspect a PDF; use this after every write/update. */
export function inspectPdf(inputBytes, { render = false } = {}) {
  const document = mupdf.Document.openDocument(Buffer.from(inputBytes), 'application/pdf')
  const pageCount = document.countPages()
  const text = extractText(inputBytes)
  const result = { pageCount, text }
  if (render && pageCount > 0) {
    const preview = renderPagePng(inputBytes)
    result.preview = { width: preview.width, height: preview.height, pngBytes: preview.png.length }
  }
  return result
}
