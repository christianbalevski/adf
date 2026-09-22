import { createHash } from 'crypto'
import JSZip from 'jszip'

export const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
export const MAX_PPTX_COMPRESSED_BYTES = 100 * 1024 * 1024
export const MAX_PPTX_EXPANDED_BYTES = 100 * 1024 * 1024
export const MAX_PPTX_ENTRY_BYTES = 50 * 1024 * 1024
export const MAX_PPTX_BYTES = MAX_PPTX_COMPRESSED_BYTES
export const MAX_SLIDE_PARTS = 1000
export const MAX_PPTX_ENTRIES = 12000
export const MAX_PPTX_TEXT_UTF8_BYTES = MAX_PPTX_ENTRY_BYTES

function assertXml10Text(value, label) {
  // XML 1.0 Fifth Edition legal characters: #x9, #xA, #xD,
  // [#x20-#xD7FF], [#xE000-#xFFFD], [#x10000-#x10FFFF].
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    const legal = codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d ||
      (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
      (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
      (codePoint >= 0x10000 && codePoint <= 0x10ffff)
    if (!legal) throw new TypeError(`${label} contains a character not legal in XML 1.0 text`)
  }
}

function asBytes(input, label, maxBytes = MAX_PPTX_COMPRESSED_BYTES) {
  const bytes = input instanceof Uint8Array || Buffer.isBuffer(input) ? new Uint8Array(input) : null
  if (!bytes || bytes.byteLength === 0) throw new TypeError(`${label} must be a non-empty Uint8Array or Buffer`)
  if (bytes.byteLength > maxBytes) throw new RangeError(`${label} exceeds ${maxBytes} byte safety cap`)
  return bytes
}

function assertZipSignature(bytes, label) {
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
    throw new TypeError(`${label} must begin with a ZIP local-file signature (PK\\x03\\x04)`)
  }
}

function decodeCanonicalBase64(content) {
  if (typeof content !== 'string' || content.length === 0 || content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content)) {
    throw new TypeError('VFS content must be canonical base64 without whitespace')
  }
  const bytes = Buffer.from(content, 'base64')
  if (bytes.length === 0 || bytes.toString('base64') !== content) {
    throw new TypeError('VFS content must be canonical base64')
  }
  return asBytes(bytes, 'VFS content')
}

/** Decode and fully inspect a VFS PPTX record before returning bytes. */
export async function vfsBytes(fileRecord) {
  if (!fileRecord || fileRecord.mime_type !== PPTX_MIME) {
    throw new TypeError(`Expected MIME type ${PPTX_MIME}`)
  }
  const bytes = decodeCanonicalBase64(fileRecord.content)
  await inspectPackage(bytes)
  return bytes
}

/** Validate and shape a PPTX result for fs_write({ encoding: "base64", ... }). */
export async function vfsWritePayload(bytes, mimeType = PPTX_MIME) {
  if (mimeType !== PPTX_MIME) throw new TypeError(`Expected MIME type ${PPTX_MIME}`)
  const safeBytes = asBytes(bytes, 'PPTX output')
  await inspectPackage(safeBytes)
  return { content: Buffer.from(safeBytes).toString('base64'), encoding: 'base64', mime_type: PPTX_MIME }
}

/** JSON/base64 bridge for invoking this tested helper through adf.sys_lambda. */
export async function patchSlideTextFromBase64({ inputBase64, slidePartNumber = 1, from, to } = {}) {
  const inputBytes = decodeCanonicalBase64(inputBase64)
  const outputBytes = await patchSlideText(inputBytes, { slidePartNumber, from, to })
  return Buffer.from(outputBytes).toString('base64')
}

/** JSON/base64 bridge for post-write package validation through adf.sys_lambda. */
export async function inspectPackageFromBase64({ inputBase64 } = {}) {
  const inputBytes = decodeCanonicalBase64(inputBase64)
  return inspectPackage(inputBytes)
}

export function sha256(input) {
  return createHash('sha256').update(Buffer.from(asBytes(input, 'PPTX input'))).digest('hex')
}

function readU16(bytes, offset) {
  if (offset < 0 || offset + 2 > bytes.length) throw new Error('Truncated ZIP metadata')
  return bytes[offset] | (bytes[offset + 1] << 8)
}

function readU32(bytes, offset) {
  if (offset < 0 || offset + 4 > bytes.length) throw new Error('Truncated ZIP metadata')
  return bytes[offset] + bytes[offset + 1] * 0x100 + bytes[offset + 2] * 0x10000 + bytes[offset + 3] * 0x1000000
}

function findEndOfCentralDirectory(bytes) {
  const minimum = 22
  const start = Math.max(0, bytes.length - (minimum + 0xffff))
  for (let offset = bytes.length - minimum; offset >= start; offset -= 1) {
    if (readU32(bytes, offset) === 0x06054b50) return offset
  }
  throw new Error('ZIP end-of-central-directory record not found')
}

/** Read only ZIP central-directory metadata; no entry is decompressed here. */
export function preflightZipMetadata(inputBytes) {
  const bytes = asBytes(inputBytes, 'PPTX input')
  assertZipSignature(bytes, 'PPTX input')
  const eocd = findEndOfCentralDirectory(bytes)
  const entriesOnDisk = readU16(bytes, eocd + 8)
  const totalEntries = readU16(bytes, eocd + 10)
  const centralSize = readU32(bytes, eocd + 12)
  const centralOffset = readU32(bytes, eocd + 16)
  if (entriesOnDisk !== totalEntries || totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error('ZIP64 or multi-disk ZIP metadata is not supported for safe PPTX inspection')
  }
  if (totalEntries > MAX_PPTX_ENTRIES) throw new RangeError(`ZIP contains ${totalEntries} entries; maximum is ${MAX_PPTX_ENTRIES}`)
  if (centralOffset + centralSize > bytes.length || centralOffset < 0) throw new Error('ZIP central directory exceeds input bounds')
  const entries = []
  let cursor = centralOffset
  let totalCompressedBytes = 0
  let totalExpandedBytes = 0
  const seen = new Set()
  for (let index = 0; index < totalEntries; index += 1) {
    if (readU32(bytes, cursor) !== 0x02014b50) throw new Error('Invalid ZIP central-directory entry')
    const flags = readU16(bytes, cursor + 8)
    const compressedSize = readU32(bytes, cursor + 20)
    const expandedSize = readU32(bytes, cursor + 24)
    const nameLength = readU16(bytes, cursor + 28)
    const extraLength = readU16(bytes, cursor + 30)
    const commentLength = readU16(bytes, cursor + 32)
    if (compressedSize === 0xffffffff || expandedSize === 0xffffffff) throw new Error('ZIP64 entry sizes are not supported for safe PPTX inspection')
    const recordEnd = cursor + 46 + nameLength + extraLength + commentLength
    if (recordEnd > bytes.length || recordEnd > centralOffset + centralSize) throw new Error('Truncated ZIP central-directory entry')
    const nameBytes = bytes.slice(cursor + 46, cursor + 46 + nameLength)
    const name = Buffer.from(nameBytes).toString((flags & 0x800) !== 0 ? 'utf8' : 'latin1')
    const localOffset = readU32(bytes, cursor + 42)
    if (localOffset + 30 > bytes.length || readU32(bytes, localOffset) !== 0x04034b50) throw new Error(`Invalid ZIP local-file header for ${name}`)
    const localFlags = readU16(bytes, localOffset + 6)
    const localCompression = readU16(bytes, localOffset + 8)
    const localCompressedSize = readU32(bytes, localOffset + 18)
    const localExpandedSize = readU32(bytes, localOffset + 22)
    const localNameLength = readU16(bytes, localOffset + 26)
    const localExtraLength = readU16(bytes, localOffset + 28)
    const localName = Buffer.from(bytes.slice(localOffset + 30, localOffset + 30 + localNameLength)).toString((flags & 0x800) !== 0 ? 'utf8' : 'latin1')
    if (localFlags !== flags || localName !== name) throw new Error(`ZIP local/central metadata mismatch for ${name}`)
    if ((flags & 0x01) !== 0 || (flags & 0x08) !== 0) throw new Error(`Encrypted or data-descriptor ZIP entry is not supported safely: ${name}`)
    if (localCompression !== 0 && localCompression !== 8) throw new Error(`Unsupported ZIP compression method for ${name}`)
    if (localCompressedSize !== compressedSize || localExpandedSize !== expandedSize) throw new Error(`ZIP local/central size mismatch for ${name}`)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    if (dataStart > bytes.length || compressedSize > bytes.length - dataStart) throw new Error(`ZIP entry ${name} exceeds input bounds`)
    if (seen.has(name)) throw new Error(`Duplicate ZIP entry is not supported: ${name}`)
    seen.add(name)
    if (!name.endsWith('/') && expandedSize > MAX_PPTX_ENTRY_BYTES) throw new RangeError(`ZIP entry ${name} exceeds ${MAX_PPTX_ENTRY_BYTES} expanded-byte cap`)
    totalCompressedBytes += compressedSize
    totalExpandedBytes += expandedSize
    if (totalCompressedBytes > MAX_PPTX_COMPRESSED_BYTES) throw new RangeError(`ZIP entries exceed ${MAX_PPTX_COMPRESSED_BYTES} compressed-byte cap`)
    if (totalExpandedBytes > MAX_PPTX_EXPANDED_BYTES) throw new RangeError(`ZIP entries exceed ${MAX_PPTX_EXPANDED_BYTES} expanded-byte cap`)
    entries.push({ name, compressedSize, expandedSize, localOffset, dir: name.endsWith('/') })
    cursor = recordEnd
  }
  if (cursor !== centralOffset + centralSize) throw new Error('ZIP central-directory size mismatch')
  return { entries, totalCompressedBytes, totalExpandedBytes }
}

async function assertActualExpandedCaps(zip, metadata) {
  let actualTotal = 0
  for (const item of metadata.entries) {
    if (item.dir) continue
    const entry = zip.file(item.name)
    if (!entry) throw new Error(`ZIP entry disappeared during load: ${item.name}`)
    const data = await entry.async('uint8array')
    if (data.length > MAX_PPTX_ENTRY_BYTES) throw new RangeError(`ZIP entry ${item.name} exceeds actual expanded-byte cap`)
    if (data.length !== item.expandedSize) throw new Error(`ZIP entry ${item.name} expanded size does not match ZIP metadata`)
    actualTotal += data.length
    if (actualTotal > MAX_PPTX_EXPANDED_BYTES) throw new RangeError('Actual ZIP expansion exceeds expanded-byte cap')
  }
  return actualTotal
}

async function assertSafePackage(zip, metadata) {
  const contentTypesFile = zip.file('[Content_Types].xml')
  const presentationFile = zip.file('ppt/presentation.xml')
  if (!contentTypesFile || !presentationFile) throw new Error('Not a recognized OOXML presentation package')
  await assertActualExpandedCaps(zip, metadata)
  const contentTypes = await contentTypesFile.async('string')
  const presentationXml = await presentationFile.async('string')
  const contentTypesRoot = /^\uFEFF?\s*(?:<\?xml[^>]*>\s*)?<(?:[A-Za-z_][\w.-]*:)?Types(?:\s[^>]*)?\/?>(?:\s|<|$)/i
  const presentationRoot = /^\uFEFF?\s*(?:<\?xml[^>]*>\s*)?<(?:[A-Za-z_][\w.-]*:)?presentation(?:\s[^>]*)?\/?>(?:\s|<|$)/i
  const presentationContentType = /application\/vnd\.openxmlformats-officedocument\.presentationml\.presentation\.main\+xml/i.test(contentTypes)
  const presentationNamespace = /xmlns(?::p)?\s*=\s*[\"']http:\/\/schemas\.openxmlformats\.org\/presentationml\/2006\/main[\"']/i.test(presentationXml)
  if (!contentTypesRoot.test(contentTypes) || !presentationRoot.test(presentationXml) || !presentationContentType || !presentationNamespace) {
    throw new Error('Not a recognized OOXML presentation package')
  }
  const names = metadata.entries.map((entry) => entry.name)
  const forbiddenType = /macroEnabled|vbaProject|vbaProjectSignature|activeX|oleObject/i.test(contentTypes)
  const forbiddenEntry = names.some((name) => !name.endsWith('/') && /(^|\/)(vbaProject[^/]*|activeX(?:\/|$)|embeddings\/)/i.test(name))
  if (forbiddenType || forbiddenEntry) {
    throw new Error('Macro-enabled, VBA, ActiveX, OLE, or embedded executable content is not supported for ordinary PPTX patch output')
  }
}

/** List and safety-check ZIP entries. `slidePartNumber` is a file part, not visible slide order. */
export async function inspectPackage(inputBytes) {
  const bytes = asBytes(inputBytes, 'PPTX input')
  const metadata = preflightZipMetadata(bytes)
  const zip = await JSZip.loadAsync(bytes)
  await assertSafePackage(zip, metadata)
  const names = metadata.entries.map((entry) => entry.name)
  const slideNames = names.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a, b) => {
    const an = Number(a.match(/slide(\d+)\.xml$/)[1])
    const bn = Number(b.match(/slide(\d+)\.xml$/)[1])
    return an - bn
  })
  if (slideNames.length > MAX_SLIDE_PARTS) throw new RangeError(`Presentation exceeds ${MAX_SLIDE_PARTS} slide-part safety cap`)
  return { entries: names, slideCount: slideNames.length, slideNames, compressedBytes: metadata.totalCompressedBytes, expandedBytes: metadata.totalExpandedBytes }
}

/**
 * Patch exactly one complete a:t text node in a known slide part. `slidePartNumber`
 * names `ppt/slides/slideN.xml`; it is not the visible slide ordinal. Resolve an
 * ordinal through presentation relationships before calling this function.
 */
export async function patchSlideText(inputBytes, { slidePartNumber = 1, from, to } = {}) {
  const bytes = asBytes(inputBytes, 'PPTX input')
  if (!Number.isInteger(slidePartNumber) || slidePartNumber < 1 || slidePartNumber > MAX_SLIDE_PARTS) {
    throw new RangeError(`slidePartNumber must be an integer from 1 through ${MAX_SLIDE_PARTS}`)
  }
  if (typeof from !== 'string' || from.length === 0 || typeof to !== 'string') {
    throw new TypeError('from and to must be strings; from cannot be empty')
  }
  assertXml10Text(from, 'from')
  assertXml10Text(to, 'to')
  const utf8ByteLength = (value) => Buffer.byteLength(value, 'utf8')
  if (utf8ByteLength(from) > MAX_PPTX_TEXT_UTF8_BYTES || utf8ByteLength(to) > MAX_PPTX_TEXT_UTF8_BYTES) {
    throw new RangeError(`Text replacement exceeds ${MAX_PPTX_TEXT_UTF8_BYTES} UTF-8 byte cap`)
  }
  if (/[<>]/.test(to)) throw new TypeError('to must not contain literal angle brackets or XML markup')
  const metadata = preflightZipMetadata(bytes)
  const zip = await JSZip.loadAsync(bytes)
  await assertSafePackage(zip, metadata)
  const path = `ppt/slides/slide${slidePartNumber}.xml`
  const entry = zip.file(path)
  if (!entry) throw new RangeError(`Missing ${path}`)
  const xml = await entry.async('string')
  const escapeXmlText = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const encodedFrom = escapeRegex(escapeXmlText(from))
  const nodePattern = new RegExp(`<a:t(?:\\s[^>]*)?>${encodedFrom}</a:t>`, 'g')
  const occurrences = [...xml.matchAll(nodePattern)]
  if (occurrences.length !== 1) throw new Error(`Expected exactly one complete a:t text-node match for from; found ${occurrences.length}`)
  const matched = occurrences[0][0]
  const openEnd = matched.indexOf('>')
  const openingTag = matched.slice(0, openEnd + 1)
  const hasPreserve = /\bxml:space\s*=\s*["']preserve["']/i.test(openingTag)
  if (/^\s|\s$/u.test(from) || /^\s|\s$/u.test(to)) {
    if (!hasPreserve) throw new Error('Leading/trailing whitespace requires xml:space="preserve" on the text node')
  }
  const replacement = openingTag + escapeXmlText(to) + '</a:t>'
  const offset = occurrences[0].index
  zip.file(path, xml.slice(0, offset) + replacement + xml.slice(offset + matched.length))
  const output = asBytes(new Uint8Array(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })), 'PPTX output')
  const outputMetadata = preflightZipMetadata(output)
  const outputZip = await JSZip.loadAsync(output)
  await assertSafePackage(outputZip, outputMetadata)
  return output
}
