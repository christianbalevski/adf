import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import {
  createPdf,
  updatePdf,
  vfsBytes,
  vfsWritePayload,
} from '../scripts/pdf-workflow.mjs'
import { extractText, inspectPdf, renderPagePng } from '../scripts/pdf-inspect-render.mjs'

test('create, reopen, inspect, render, and update a PDF', async () => {
  const original = await createPdf({ title: 'Test', lines: ['alpha', 'beta'] })
  const first = inspectPdf(original, { render: true })
  assert.equal(first.pageCount, 1)
  assert.match(first.text[0], /alpha/)
  assert.match(first.text[0], /beta/)
  assert.ok(first.preview.pngBytes > 100)

  const inputHash = createHash('sha256').update(original).digest('hex')
  const updated = await updatePdf(original, { text: 'gamma', title: 'Updated' })
  assert.equal(createHash('sha256').update(original).digest('hex'), inputHash, 'update must not mutate input bytes')
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

test('meaningful failures reject empty, oversized, missing-page, and unsupported input', async () => {
  const pdf = await createPdf()
  await assert.rejects(() => updatePdf(new Uint8Array(), { pageIndex: 0 }), /non-empty|input/i)
  await assert.rejects(() => updatePdf(Buffer.alloc(100 * 1024 * 1024 + 1), { pageIndex: 0 }), /100000000|safety cap|exceeds/i)
  await assert.rejects(() => updatePdf(pdf, { pageIndex: 2 }), /No PDF page/)
  await assert.throws(() => inspectPdf(Buffer.from('not a PDF')), /cannot|invalid|PDF|objects/i)
  await assert.rejects(() => createPdf({ lines: Array.from({ length: 101 }, () => 'line') }), /100 line|safety cap|exceeds/i)
  assert.throws(() => vfsBytes({ content: '' }), /non-empty|base64/i)
})

test('standard Helvetica reports unsupported Unicode instead of silently losing it', async () => {
  await assert.rejects(() => createPdf({ lines: ['check ✓'] }), /WinAnsi|encode/)
})
