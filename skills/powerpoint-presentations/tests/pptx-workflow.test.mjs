import assert from 'node:assert/strict'
import test from 'node:test'
import JSZip from 'jszip'
import {
  createPresentation,
  inspectPackage,
  patchSlideText,
  vfsBytes,
  vfsWritePayload,
} from '../scripts/pptx-workflow.mjs'

test('create, reopen as OOXML package, and patch one known text node', async () => {
  const original = await createPresentation({ slides: [{ title: 'One', body: 'Hello' }] })
  const info = await inspectPackage(original)
  assert.equal(info.slideCount, 1)
  const patched = await patchSlideText(original, { slideNumber: 1, from: 'Hello', to: 'Updated' })
  assert.notDeepEqual(Buffer.from(patched), Buffer.from(original))
  const patchedInfo = await inspectPackage(patched)
  assert.equal(patchedInfo.slideCount, 1)

  // Attribute-bearing a:t nodes are valid; replacement text must remain literal.
  const withAttributeZip = await JSZip.loadAsync(original)
  const originalXml = await withAttributeZip.file('ppt/slides/slide1.xml').async('string')
  withAttributeZip.file('ppt/slides/slide1.xml', originalXml.replace('<a:t>Hello</a:t>', '<a:t xml:space="preserve">Hello</a:t>'))
  const withAttribute = await withAttributeZip.generateAsync({ type: 'nodebuffer' })
  const literal = await patchSlideText(withAttribute, { slideNumber: 1, from: 'Hello', to: '$& cost' })
  const literalZip = await JSZip.loadAsync(literal)
  const literalXml = await literalZip.file('ppt/slides/slide1.xml').async('string')
  assert.match(literalXml, /<a:t xml:space="preserve">\$&amp; cost<\/a:t>/)
})

test('VFS binary conversion is explicit and round-trips', () => {
  const bytes = Uint8Array.from([0, 1, 2, 255])
  const payload = vfsWritePayload(bytes)
  assert.deepEqual([...vfsBytes({ content: payload.content })], [...bytes])
})

test('meaningful failures reject ambiguous or absent XML targets', async () => {
  const pptx = await createPresentation({ slides: [{ title: 'One', body: 'Hello' }] })
  await assert.rejects(() => patchSlideText(pptx, { from: 'Nope', to: 'x' }), /Expected exactly one (?:complete a:t text-node )?match/)
  await assert.rejects(() => patchSlideText(pptx, { slideNumber: 4, from: 'Hello', to: 'x' }), /Missing ppt\/slides\/slide4.xml/)
  await assert.rejects(() => patchSlideText(pptx, { from: 'Hello', to: '<a>' }), /not XML markup/)
  await assert.rejects(() => patchSlideText(pptx, { from: 'lang', to: 'x' }), /complete a:t text-node/)
  await assert.rejects(() => patchSlideText(pptx, { from: 'Hel', to: 'x' }), /complete a:t text-node/)
  await assert.rejects(() => patchSlideText(pptx, { from: 'bad\u0001', to: 'x' }), /XML control/)

  const notPptx = await new JSZip().file('not-pptx.txt', 'nope').generateAsync({ type: 'nodebuffer' })
  await assert.rejects(() => patchSlideText(notPptx, { from: 'Hello', to: 'x' }), /Not a recognized OOXML presentation package/)
})
