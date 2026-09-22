import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createPdf,
  extractText,
  inspectPdf,
  renderPagePng,
  updatePdf,
  vfsBytes,
  vfsWritePayload,
} from '../scripts/pdf-workflow.mjs'

test('create, reopen, inspect, render, and update a PDF', async () => {
  const original = await createPdf({ title: 'Test', lines: ['alpha', 'beta'] })
  const first = inspectPdf(original, { render: true })
  assert.equal(first.pageCount, 1)
  assert.match(first.text[0], /alpha/)
  assert.match(first.text[0], /beta/)
  assert.ok(first.preview.pngBytes > 100)

  const updated = await updatePdf(original, { text: 'gamma', title: 'Updated' })
  assert.notDeepEqual(Buffer.from(updated), Buffer.from(original), 'update must produce new bytes')
  assert.match(extractText(updated)[0], /gamma/)

  const preview = renderPagePng(updated)
  assert.equal(preview.png[0], 0x89)
  assert.equal(preview.png[1], 0x50)
})

test('VFS binary conversion is explicit and round-trips', () => {
  const bytes = Uint8Array.from([0, 1, 2, 255])
  const payload = vfsWritePayload(bytes, 'application/pdf')
  assert.equal(payload.encoding, 'base64')
  assert.equal(payload.mime_type, 'application/pdf')
  assert.deepEqual([...vfsBytes({ content: payload.content })], [...bytes])
})

test('meaningful failures reject missing PDF pages', async () => {
  const pdf = await createPdf()
  await assert.rejects(() => updatePdf(pdf, { pageIndex: 2 }), /No PDF page/)
})
