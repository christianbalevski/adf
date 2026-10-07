import { describe, it, expect, afterAll } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'
import { unlinkSync, existsSync } from 'fs'
import { AdfWorkspace, numberedPath } from '../../../src/main/adf/adf-workspace'

/**
 * Uploads and channel attachments land flat in one folder. A name clash keeps
 * the earlier file and numbers the new one; identical bytes reuse the path.
 */

const testFile = join(tmpdir(), `adf-unique-write-${Date.now()}.adf`)
const ws = AdfWorkspace.create(testFile, { name: 'unique-write' })

afterAll(() => {
  try { ws.close() } catch { /* ignore */ }
  for (const suffix of ['', '-shm', '-wal']) {
    const p = testFile + suffix
    if (existsSync(p)) try { unlinkSync(p) } catch { /* ignore */ }
  }
})

describe('numberedPath', () => {
  it('numbers before the extension', () => {
    expect(numberedPath('loop-upload/report.pdf', 1)).toBe('loop-upload/report.pdf')
    expect(numberedPath('loop-upload/report.pdf', 2)).toBe('loop-upload/report-2.pdf')
    expect(numberedPath('a/archive.tar.gz', 3)).toBe('a/archive.tar-3.gz')
  })

  it('treats a leading dot or a dotted folder as part of the name', () => {
    expect(numberedPath('a/.env', 2)).toBe('a/.env-2')
    expect(numberedPath('a.b/README', 2)).toBe('a.b/README-2')
  })
})

describe('writeFileBufferUnique', () => {
  const a = Buffer.from('first')
  const b = Buffer.from('second')
  const c = Buffer.from('third')

  it('writes to the requested path when it is free', () => {
    expect(ws.writeFileBufferUnique('loop-upload/photo.png', a, 'image/png')).toBe('loop-upload/photo.png')
  })

  it('keeps a different file and numbers the new one', () => {
    expect(ws.writeFileBufferUnique('loop-upload/photo.png', b, 'image/png')).toBe('loop-upload/photo-2.png')
    expect(ws.writeFileBufferUnique('loop-upload/photo.png', c, 'image/png')).toBe('loop-upload/photo-3.png')
    expect(ws.readFileBuffer('loop-upload/photo.png')?.equals(a)).toBe(true)
    expect(ws.readFileBuffer('loop-upload/photo-2.png')?.equals(b)).toBe(true)
    expect(ws.readFileBuffer('loop-upload/photo-3.png')?.equals(c)).toBe(true)
  })

  it('reuses the path of identical bytes instead of adding a copy', () => {
    expect(ws.writeFileBufferUnique('loop-upload/photo.png', a, 'image/png')).toBe('loop-upload/photo.png')
    expect(ws.writeFileBufferUnique('loop-upload/photo.png', b, 'image/png')).toBe('loop-upload/photo-2.png')
    expect(ws.fileExists('loop-upload/photo-4.png')).toBe(false)
  })
})
