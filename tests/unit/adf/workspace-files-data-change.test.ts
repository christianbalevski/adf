import { describe, it, expect, afterAll, beforeEach } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'
import { unlinkSync, existsSync } from 'fs'
import { AdfWorkspace, type WorkspaceDataScope } from '../../../src/main/adf/adf-workspace'

/**
 * The workspace `files` data-change scope: every file mutation (text and
 * binary writes, deletes, renames of a file or a folder) raises it, so the
 * Files panel can follow writers `file_updated` does not cover.
 */

const testFile = join(tmpdir(), `adf-files-scope-${Date.now()}.adf`)
const ws = AdfWorkspace.create(testFile, { name: 'agent-1' })
const scopes: WorkspaceDataScope[] = []
ws.setOnDataChangeCallback((scope) => { scopes.push(scope) })

afterAll(() => {
  try { ws.close() } catch { /* ignore */ }
  for (const suffix of ['', '-shm', '-wal']) {
    const p = testFile + suffix
    if (existsSync(p)) try { unlinkSync(p) } catch { /* ignore */ }
  }
})

beforeEach(() => { scopes.length = 0 })

const filesSignals = (): number => scopes.filter((s) => s === 'files').length

describe('files data-change scope', () => {
  it('a text write raises it', () => {
    ws.writeFile('notes/a.md', 'hello')
    expect(filesSignals()).toBeGreaterThan(0)
  })

  it('a binary write raises it (file_updated carries text only)', () => {
    ws.writeFileBuffer('img/b.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image/png')
    expect(filesSignals()).toBeGreaterThan(0)
  })

  it('a delete raises it', () => {
    ws.writeFile('tmp.txt', 'x')
    scopes.length = 0
    expect(ws.deleteFile('tmp.txt')).toBe(true)
    expect(filesSignals()).toBeGreaterThan(0)
  })

  it('a file rename raises it', () => {
    ws.writeFile('old.txt', 'x')
    scopes.length = 0
    expect(ws.renameInternalFile('old.txt', 'new.txt')).toBe(true)
    expect(filesSignals()).toBeGreaterThan(0)
  })

  it('a folder rename raises it', () => {
    ws.writeFile('dir1/c.txt', 'x')
    scopes.length = 0
    expect(ws.renameFolder('dir1', 'dir2')).toBeGreaterThan(0)
    expect(filesSignals()).toBeGreaterThan(0)
  })

  it('a table change does not raise it', () => {
    ws.writeFile('seed.txt', 'x')
    scopes.length = 0
    ws.executeSQL('CREATE TABLE local_t1 (id INTEGER PRIMARY KEY)')
    expect(scopes).toContain('tables')
    expect(filesSignals()).toBe(0)
  })
})
