import assert from 'node:assert/strict'
import test from 'node:test'
import JSZip from 'jszip'
import { createPresentation } from '../scripts/pptx-generate.mjs'
import { inspectPackage, patchSlideText, vfsBytes, vfsWritePayload } from '../scripts/pptx-inspect-patch.mjs'

test('create, reopen as OOXML package, and patch one known text node', async () => {
  const original = await createPresentation({ slides: [{ title: 'One', body: 'Hello' }, { title: 'Two', body: 'Second' }] })
  const info = await inspectPackage(original)
  assert.equal(info.slideCount, 2)
  const patched = await patchSlideText(original, { slidePartNumber: 2, from: 'Second', to: 'Updated' })
  assert.notDeepEqual(Buffer.from(patched), Buffer.from(original))
  const patchedInfo = await inspectPackage(patched)
  assert.equal(patchedInfo.slideCount, 2)

  // Attribute-bearing a:t nodes are valid; replacement text must remain literal.
  const withAttributeZip = await JSZip.loadAsync(original)
  const originalXml = await withAttributeZip.file('ppt/slides/slide2.xml').async('string')
  withAttributeZip.file('ppt/slides/slide2.xml', originalXml.replace('<a:t>Second</a:t>', '<a:t xml:space="preserve">Second</a:t>'))
  const withAttribute = await withAttributeZip.generateAsync({ type: 'nodebuffer' })
  const literal = await patchSlideText(withAttribute, { slidePartNumber: 2, from: 'Second', to: '$& cost' })
  const literalZip = await JSZip.loadAsync(literal)
  const literalXml = await literalZip.file('ppt/slides/slide2.xml').async('string')
  assert.match(literalXml, /<a:t xml:space="preserve">\$&amp; cost<\/a:t>/)

  // XML entities are matched by their encoded text representation.
  const entityDeck = await createPresentation({ slides: [{ title: 'One', body: 'Fish & Chips — café' }] })
  const entityPatched = await patchSlideText(entityDeck, { from: 'Fish & Chips — café', to: 'Fish & Chips — bistro' })
  const entityZip = await JSZip.loadAsync(entityPatched)
  const entityXml = await entityZip.file('ppt/slides/slide1.xml').async('string')
  assert.match(entityXml, /Fish &amp; Chips — bistro/)
  const secondXml = await (await JSZip.loadAsync(patched)).file('ppt/slides/slide2.xml').async('string')
  assert.match(secondXml, /Updated/)
})

test('slidePartNumber names the XML part, not visible slide ordinal', async () => {
  const deck = await createPresentation({ slides: [{ title: 'First', body: 'Alpha' }, { title: 'Second', body: 'Beta' }] })
  const patched = await patchSlideText(deck, { slidePartNumber: 2, from: 'Beta', to: 'Gamma' })
  const zip = await JSZip.loadAsync(patched)
  const firstXml = await zip.file('ppt/slides/slide1.xml').async('string')
  const secondXml = await zip.file('ppt/slides/slide2.xml').async('string')
  assert.match(firstXml, /Alpha/)
  assert.match(secondXml, /Gamma/)
})

test('VFS binary conversion is explicit and round-trips', async () => {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<Types><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>')
  zip.file('ppt/presentation.xml', '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>')
  zip.file('ppt/slides/slide1.xml', '<p:sld><a:t>ok</a:t></p:sld>')
  const bytes = await zip.generateAsync({ type: 'nodebuffer' })
  const payload = await vfsWritePayload(bytes)
  assert.deepEqual([...await vfsBytes({ content: payload.content, mime_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' })], [...bytes])
})

test('meaningful failures reject ambiguous or absent XML targets', async () => {
  const pptx = await createPresentation({ slides: [{ title: 'One', body: 'Hello' }] })
  await assert.rejects(() => patchSlideText(pptx, { from: 'Nope', to: 'x' }), /Expected exactly one (?:complete a:t text-node )?match/)
  await assert.rejects(() => patchSlideText(pptx, { slidePartNumber: 4, from: 'Hello', to: 'x' }), /Missing ppt\/slides\/slide4.xml/)
  await assert.rejects(() => patchSlideText(pptx, { from: 'Hello', to: '<a>' }), /angle brackets|XML markup/)
  await assert.rejects(() => patchSlideText(pptx, { from: 'lang', to: 'x' }), /complete a:t text-node/)
  await assert.rejects(() => patchSlideText(pptx, { from: 'Hel', to: 'x' }), /complete a:t text-node/)
  await assert.rejects(() => patchSlideText(pptx, { from: 'bad\u0001', to: 'x' }), /XML 1.0/)
  const splitZip = await JSZip.loadAsync(pptx)
  const splitXml = await splitZip.file('ppt/slides/slide1.xml').async('string')
  splitZip.file('ppt/slides/slide1.xml', splitXml.replace('<a:t>Hello</a:t>', '<a:t>Hel</a:t><a:t>lo</a:t>'))
  const splitDeck = await splitZip.generateAsync({ type: 'nodebuffer' })
  await assert.rejects(() => patchSlideText(splitDeck, { from: 'Hello', to: 'x' }), /complete a:t text-node/)

  await assert.rejects(() => patchSlideText(pptx, { slidePartNumber: 1, from: 'Hello', to: 'Hello ' }), /xml:space/)
  const preservedZip = await JSZip.loadAsync(pptx)
  const preservedXml = await preservedZip.file('ppt/slides/slide1.xml').async('string')
  preservedZip.file('ppt/slides/slide1.xml', preservedXml.replace('<a:t>Hello</a:t>', '<a:t xml:space="preserve">Hello</a:t>'))
  const preservedDeck = await preservedZip.generateAsync({ type: 'nodebuffer' })
  await assert.doesNotReject(() => patchSlideText(preservedDeck, { slidePartNumber: 1, from: 'Hello', to: 'Hello ' }))

  const macroZip = await JSZip.loadAsync(pptx)
  const contentTypes = await macroZip.file('[Content_Types].xml').async('string')
  macroZip.file('[Content_Types].xml', contentTypes.replace('</Types>', '<Override PartName="/ppt/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>'))
  macroZip.file('ppt/vbaProject.bin', Uint8Array.from([0, 1, 2]))
  const macroDeck = await macroZip.generateAsync({ type: 'nodebuffer' })
  await assert.rejects(() => inspectPackage(macroDeck), /Macro-enabled|VBA|ActiveX|embedded executable/)
  await assert.rejects(() => patchSlideText(macroDeck, { slidePartNumber: 1, from: 'Hello', to: 'x' }), /Macro-enabled|VBA|ActiveX|embedded executable/)

  const activeXZip = await JSZip.loadAsync(pptx)
  activeXZip.file('ppt/activeX/activeX1.bin', Uint8Array.from([1, 2, 3]))
  const activeXDeck = await activeXZip.generateAsync({ type: 'nodebuffer' })
  await assert.rejects(() => inspectPackage(activeXDeck), /Macro-enabled|VBA|ActiveX|embedded executable/)

  const notPptx = await new JSZip().file('not-pptx.txt', 'nope').generateAsync({ type: 'nodebuffer' })
  await assert.rejects(() => patchSlideText(notPptx, { from: 'Hello', to: 'x' }), /Not a recognized OOXML presentation package/)
  await assert.rejects(() => inspectPackage(Buffer.from('not a PPTX')), /zip|end of central directory|invalid/i)
})
