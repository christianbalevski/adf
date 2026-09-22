import pptxgen from 'pptxgenjs'
import JSZip from 'jszip'

export function vfsBytes(fileRecord) {
  if (!fileRecord || typeof fileRecord.content !== 'string') {
    throw new TypeError('Expected a binary fs_read record with base64 content')
  }
  return new Uint8Array(Buffer.from(fileRecord.content, 'base64'))
}

export function vfsWritePayload(bytes, mimeType = 'application/vnd.openxmlformats-officedocument.presentationml.presentation') {
  if (!(bytes instanceof Uint8Array) && !Buffer.isBuffer(bytes)) {
    throw new TypeError('Expected Uint8Array or Buffer')
  }
  return { content: Buffer.from(bytes).toString('base64'), encoding: 'base64', mime_type: mimeType }
}

/** Create a presentation by generation. This does not edit an arbitrary existing deck. */
export async function createPresentation({ title = 'ADF presentation', slides = [] } = {}) {
  if (!Array.isArray(slides)) throw new TypeError('slides must be an array')
  const pptx = new pptxgen()
  pptx.layout = 'LAYOUT_WIDE'
  pptx.author = 'ADF'
  pptx.title = title
  for (const [index, spec] of slides.entries()) {
    if (!spec || typeof spec !== 'object' || typeof spec.title !== 'string') {
      throw new TypeError(`slides[${index}] must have a string title`)
    }
    const slide = pptx.addSlide()
    slide.addText(spec.title, { x: 0.7, y: 0.5, w: 12, h: 0.6, fontSize: 26, bold: true, color: '17365D' })
    if (spec.body !== undefined) {
      if (typeof spec.body !== 'string') throw new TypeError(`slides[${index}].body must be a string`)
      slide.addText(spec.body, { x: 0.9, y: 1.5, w: 11.4, h: 4.5, fontSize: 18, breakLine: false, fit: 'shrink' })
    }
  }
  return new Uint8Array(await pptx.write({ outputType: 'nodebuffer' }))
}

/** List ZIP entries to establish that the bytes are an OOXML package. */
export async function inspectPackage(inputBytes) {
  const zip = await JSZip.loadAsync(inputBytes)
  const names = Object.keys(zip.files)
  if (!names.includes('[Content_Types].xml') || !names.includes('ppt/presentation.xml')) {
    throw new Error('Not a recognized OOXML presentation package')
  }
  const slideNames = names.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort()
  return { entries: names, slideCount: slideNames.length, slideNames }
}

/**
 * Narrow XML patch for a known existing deck. It changes only matching text in
 * one slide XML entry and preserves every other ZIP entry's logical content in the
 * regenerated ZIP. It is not a general PPTX editor and does not guarantee
 * package/signature relationship fidelity.
 */
export async function patchSlideText(inputBytes, { slideNumber = 1, from, to } = {}) {
  if (!Number.isInteger(slideNumber) || slideNumber < 1) throw new RangeError('slideNumber must be >= 1')
  if (typeof from !== 'string' || from.length === 0 || typeof to !== 'string') {
    throw new TypeError('from and to must be strings; from cannot be empty')
  }
  const invalidXmlControl = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/
  if (invalidXmlControl.test(from) || invalidXmlControl.test(to)) throw new TypeError('from/to contain invalid XML control characters')
  if (/[<>]/.test(to)) throw new TypeError('to must be text, not XML markup')
  const zip = await JSZip.loadAsync(inputBytes)
  if (!zip.file('[Content_Types].xml') || !zip.file('ppt/presentation.xml')) {
    throw new Error('Not a recognized OOXML presentation package')
  }
  const path = `ppt/slides/slide${slideNumber}.xml`
  const entry = zip.file(path)
  if (!entry) throw new RangeError(`Missing ${path}`)
  const xml = await entry.async('string')
  const escapeXmlText = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const encodedFrom = escapeRegex(escapeXmlText(from))
  const nodePattern = new RegExp(`<a:t(?:\\s[^>]*)?>${encodedFrom}</a:t>`, 'g')
  const occurrences = [...xml.matchAll(nodePattern)]
  if (occurrences.length !== 1) throw new Error(`Expected exactly one complete a:t text-node match for from; found ${occurrences.length}`)
  // This deliberately does not parse arbitrary XML. The match must be the
  // complete text of one a:t node, never an attribute, markup, or split run.
  const escapedTo = escapeXmlText(to)
  const matched = occurrences[0][0]
  const openEnd = matched.indexOf('>')
  const replacement = matched.slice(0, openEnd + 1) + escapedTo + '</a:t>'
  const offset = occurrences[0].index
  zip.file(path, xml.slice(0, offset) + replacement + xml.slice(offset + matched.length))
  return new Uint8Array(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
}
