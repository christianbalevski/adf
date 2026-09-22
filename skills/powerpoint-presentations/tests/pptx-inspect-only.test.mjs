import assert from 'node:assert/strict'
import test from 'node:test'
import JSZip from 'jszip'
import { inspectPackage, patchSlideText, preflightZipMetadata, sha256, PPTX_MIME, vfsBytes, vfsWritePayload, MAX_PPTX_ENTRY_BYTES, MAX_PPTX_ENTRIES, MAX_PPTX_TEXT_UTF8_BYTES } from '../scripts/pptx-inspect-patch.mjs'

test('JSZip-only inspect and patch module has no generation dependency', async () => {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<Types><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>')
  zip.file('ppt/presentation.xml', '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>')
  zip.file('ppt/slides/slide7.xml', '<p:sld><a:t>hello</a:t></p:sld>')
  const input = await zip.generateAsync({ type: 'nodebuffer' })
  const info = await inspectPackage(input)
  assert.deepEqual(info.slideNames, ['ppt/slides/slide7.xml'])
  const before = sha256(input)
  const output = await patchSlideText(input, { slidePartNumber: 7, from: 'hello', to: 'world' })
  const outZip = await JSZip.loadAsync(output)
  assert.match(await outZip.file('ppt/slides/slide7.xml').async('string'), /world/)
  assert.equal(sha256(input), before, 'patch must not mutate input bytes')
})

test('VFS PPTX conversion requires canonical base64, MIME, and ZIP signature', async () => {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<Types><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>')
  zip.file('ppt/presentation.xml', '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>')
  zip.file('ppt/slides/slide1.xml', '<p:sld><a:t>hello</a:t></p:sld>')
  const bytes = await zip.generateAsync({ type: 'nodebuffer' })
  const payload = await vfsWritePayload(bytes)
  assert.deepEqual([...await vfsBytes({ content: payload.content, mime_type: PPTX_MIME })], [...bytes])
  for (const record of [
    { content: payload.content + '\n', mime_type: PPTX_MIME },
    { content: 'AAAA=', mime_type: PPTX_MIME },
    { content: payload.content, mime_type: 'application/octet-stream' },
    { content: Buffer.from('not zip').toString('base64'), mime_type: PPTX_MIME },
  ]) await assert.rejects(() => vfsBytes(record), /canonical|MIME|ZIP|signature|base64|recognized/)
  await assert.rejects(() => vfsWritePayload(bytes, 'application/octet-stream'), /MIME/)

  const lookalike = new JSZip()
  lookalike.file('[Content_Types].xml', '<Types>not XML package metadata</Types>')
  lookalike.file('ppt/presentation.xml', 'not presentation XML')
  const lookalikeBytes = await lookalike.generateAsync({ type: 'nodebuffer' })
  await assert.rejects(() => vfsWritePayload(lookalikeBytes), /recognized OOXML presentation package/)
  await assert.rejects(() => vfsBytes({ content: Buffer.from(lookalikeBytes).toString('base64'), mime_type: PPTX_MIME }), /recognized OOXML presentation package/)
})

test('ZIP metadata caps reject oversized expansion before decompression', async () => {
  const hugeExpandedSize = MAX_PPTX_ENTRY_BYTES + 1
  const name = Buffer.from('ppt/slides/slide1.xml')
  const data = Buffer.from('x')
  const crc = 0x8cdc1683 // CRC32('x')
  const local = Buffer.alloc(30 + name.length + data.length)
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8)
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(hugeExpandedSize, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28)
  name.copy(local, 30); data.copy(local, 30 + name.length)
  const central = Buffer.alloc(46 + name.length)
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 8)
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(hugeExpandedSize, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(0, 42); name.copy(central, 46)
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(central.length, 12); eocd.writeUInt32LE(local.length, 16)
  const bomb = Buffer.concat([local, central, eocd])
  assert.throws(() => preflightZipMetadata(bomb), /expanded-byte cap|entry.*exceeds/)
  await assert.rejects(() => inspectPackage(bomb), /expanded-byte cap|entry.*exceeds/)
})

test('ZIP entry-count cap rejects 12006 entries but accepts below the cap', async () => {
  const makeZip = async (count) => {
    const zip = new JSZip()
    zip.file('[Content_Types].xml', '<Types><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>')
    zip.file('ppt/presentation.xml', '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>')
    zip.file('ppt/slides/slide1.xml', '<p:sld><a:t>hello</a:t></p:sld>')
    for (let i = 0; i < count - 3; i += 1) zip.file(`custom/e${i}.xml`, 'x')
    return zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' })
  }
  const below = await makeZip(MAX_PPTX_ENTRIES - 10)
  await assert.doesNotReject(() => inspectPackage(below))
  const above = await makeZip(12006)
  await assert.rejects(() => inspectPackage(above), /entries.*maximum|contains 12006/)
})

test('Replacement UTF-8 cap runs before ZIP generation and returned patch is inspectable', async () => {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<Types><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>')
  zip.file('ppt/presentation.xml', '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>')
  zip.file('ppt/slides/slide1.xml', '<p:sld><a:t>hello</a:t></p:sld>')
  const input = await zip.generateAsync({ type: 'nodebuffer' })
  await assert.rejects(() => patchSlideText(input, { slidePartNumber: 1, from: 'hello', to: 'x'.repeat(MAX_PPTX_TEXT_UTF8_BYTES + 1) }), /UTF-8 byte cap/)
  const output = await patchSlideText(input, { slidePartNumber: 1, from: 'hello', to: 'world' })
  await assert.doesNotReject(() => inspectPackage(output))
})

test('ZIP metadata rejects local/central size mismatches and data descriptors', async () => {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<Types><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>')
  zip.file('ppt/presentation.xml', '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>')
  zip.file('ppt/slides/slide1.xml', '<p:sld><a:t>hello</a:t></p:sld>')
  const bytes = await zip.generateAsync({ type: 'nodebuffer' })
  const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  const local = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
  const mismatch = Buffer.from(bytes)
  mismatch.writeUInt32LE(mismatch.readUInt32LE(central + 24) + 1, local + 22)
  await assert.rejects(() => inspectPackage(mismatch), /local\/central size mismatch|metadata mismatch/)
  const descriptor = Buffer.from(bytes)
  descriptor.writeUInt16LE(descriptor.readUInt16LE(local + 6) | 0x08, local + 6)
  await assert.rejects(() => inspectPackage(descriptor), /data-descriptor|metadata mismatch/)
})

test('JSZip-only safety rejects executable embedding entries', async () => {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<Types><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>')
  zip.file('ppt/presentation.xml', '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>')
  zip.file('ppt/slides/slide1.xml', '<p:sld><a:t>hello</a:t></p:sld>')
  zip.file('ppt/embeddings/payload.exe', Uint8Array.from([1, 2, 3]))
  const input = await zip.generateAsync({ type: 'nodebuffer' })
  await assert.rejects(() => inspectPackage(input), /executable|embedded/i)
})

test('XML 1.0 rejects noncharacters U+FFFE/U+FFFF while allowing legal supplementary text', async () => {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<Types><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>')
  zip.file('ppt/presentation.xml', '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>')
  zip.file('ppt/slides/slide1.xml', '<p:sld><a:t>hello</a:t></p:sld>')
  const input = await zip.generateAsync({ type: 'nodebuffer' })
  await assert.rejects(() => patchSlideText(input, { slidePartNumber: 1, from: 'hello', to: 'bad\uFFFE' }), /XML 1.0/)
  await assert.rejects(() => patchSlideText(input, { slidePartNumber: 1, from: 'bad\uFFFF', to: 'x' }), /XML 1.0/)
  await assert.doesNotReject(() => patchSlideText(input, { slidePartNumber: 1, from: 'hello', to: 'ok\u{1F600}' }))
})
