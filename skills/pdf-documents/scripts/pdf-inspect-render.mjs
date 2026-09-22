import * as mupdf from 'mupdf'
import { MAX_PDF_BYTES, MAX_PDF_PAGES } from './pdf-workflow.mjs'

export const MAX_RENDER_PIXELS = 25_000_000
export const MAX_RENDER_SCALE = 4

function asBytes(input) {
  if (!(input instanceof Uint8Array) && !Buffer.isBuffer(input)) throw new TypeError('PDF input must be Uint8Array or Buffer')
  if (input.byteLength === 0) throw new TypeError('PDF input must be non-empty')
  if (input.byteLength > MAX_PDF_BYTES) throw new RangeError(`PDF input exceeds ${MAX_PDF_BYTES} byte safety cap`)
  return new Uint8Array(input)
}

function openPdf(inputBytes) {
  const document = mupdf.Document.openDocument(Buffer.from(asBytes(inputBytes)), 'application/pdf')
  const pageCount = document.countPages()
  if (pageCount > MAX_PDF_PAGES) throw new RangeError(`PDF exceeds ${MAX_PDF_PAGES} page safety cap`)
  return document
}

/** Extract the text layer with MuPDF. Scanned-image pages normally return empty text. */
export function extractText(inputBytes) {
  const document = openPdf(inputBytes)
  const pages = []
  let chars = 0
  for (let index = 0; index < document.countPages(); index += 1) {
    const text = document.loadPage(index).toStructuredText().asText()
    chars += text.length
    if (chars > 1_000_000) throw new RangeError('Extracted text exceeds 1000000 character safety cap')
    pages.push(text)
  }
  return pages
}

/** Render one page for visual inspection; this is not OCR or redaction. */
export function renderPagePng(inputBytes, { pageIndex = 0, scale = 1.5 } = {}) {
  if (!Number.isFinite(scale) || scale <= 0 || scale > MAX_RENDER_SCALE) throw new RangeError(`scale must be > 0 and <= ${MAX_RENDER_SCALE}`)
  const document = openPdf(inputBytes)
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= document.countPages()) {
    throw new RangeError(`No PDF page at index ${pageIndex}`)
  }
  const page = document.loadPage(pageIndex)
  const bounds = page.getBounds()
  const width = Math.ceil(Math.max(0, bounds[2] - bounds[0]) * scale)
  const height = Math.ceil(Math.max(0, bounds[3] - bounds[1]) * scale)
  if (!width || !height || width * height > MAX_RENDER_PIXELS) throw new RangeError(`Rendered page exceeds ${MAX_RENDER_PIXELS} pixel safety cap`)
  const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false)
  return { png: new Uint8Array(pixmap.asPNG()), width: pixmap.getWidth(), height: pixmap.getHeight() }
}

/** Reopen and inspect a PDF; use this after every write/update. */
export function inspectPdf(inputBytes, { render = false } = {}) {
  const document = openPdf(inputBytes)
  const pageCount = document.countPages()
  const text = extractText(inputBytes)
  const result = { pageCount, text }
  if (render && pageCount > 0) {
    const preview = renderPagePng(inputBytes)
    result.preview = { width: preview.width, height: preview.height, pngBytes: preview.png.length }
  }
  return result
}

