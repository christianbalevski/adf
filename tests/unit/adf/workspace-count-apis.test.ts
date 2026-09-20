import { describe, it, expect, afterAll } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'
import { unlinkSync, existsSync } from 'fs'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'

/**
 * The count/lookup APIs that replaced `getInbox(...).length` and
 * `getInbox().find(...)` on the hot paths, plus the blob-free fileExists and
 * the bounded log reads.
 */

const testFile = join(tmpdir(), `adf-count-apis-${Date.now()}.adf`)
const ws = AdfWorkspace.create(testFile, { name: 'count-apis' })

afterAll(() => {
  try { ws.close() } catch { /* ignore */ }
  for (const suffix of ['', '-shm', '-wal']) {
    const p = testFile + suffix
    if (existsSync(p)) try { unlinkSync(p) } catch { /* ignore */ }
  }
})

const ids: string[] = []

describe('inbox count APIs', () => {
  it('seeds a mixed inbox', () => {
    const rows: Array<[string, string, 'unread' | 'read' | 'archived', string]> = [
      ['agent-1', 'mesh', 'unread', 'a'],
      ['agent-1', 'mesh', 'unread', 'b'],
      ['agent-2', 'telegram', 'unread', 'c'],
      ['agent-2', 'telegram', 'read', 'd'],
      ['agent-1', 'mesh', 'archived', 'e'],
    ]
    rows.forEach(([from, source, status, body], i) => {
      ids.push(ws.addToInbox({
        from, source, status, content: body, received_at: 1000 + i
      }))
    })
    expect(ids).toHaveLength(5)
  })

  it('getInboxCounts groups by status without reading bodies', () => {
    expect(ws.getInboxCounts()).toEqual({ unread: 3, read: 1, archived: 1, total: 5 })
  })

  it('getInboxCounts agrees with the legacy getInbox().length it replaced', () => {
    const counts = ws.getInboxCounts()
    expect(counts.unread).toBe(ws.getInbox('unread').length)
    expect(counts.read).toBe(ws.getInbox('read').length)
    expect(counts.archived).toBe(ws.getInbox('archived').length)
  })

  it('getUnreadInboxSummary groups unread by sender and source', () => {
    const summary = ws.getUnreadInboxSummary()
    expect(summary.bySender).toEqual({ 'agent-1': 2, 'agent-2': 1 })
    expect(summary.bySource).toEqual({ mesh: 2, telegram: 1 })
    expect(summary.oldest).toBe(1000)
  })

  it('getUnreadInboxSummary on an empty unread set reports no oldest', () => {
    const empty = AdfWorkspace.create(join(tmpdir(), `adf-count-apis-empty-${Date.now()}.adf`), { name: 'empty' })
    try {
      expect(empty.getUnreadInboxSummary()).toEqual({ bySender: {}, bySource: {}, oldest: undefined })
      expect(empty.getInboxCounts()).toEqual({ unread: 0, read: 0, archived: 0, total: 0 })
    } finally {
      const p = empty.getFilePath()
      empty.close()
      for (const suffix of ['', '-shm', '-wal']) {
        if (existsSync(p + suffix)) try { unlinkSync(p + suffix) } catch { /* ignore */ }
      }
    }
  })

  it('getInboxMessageById returns the same row a full scan would find', () => {
    const byId = ws.getInboxMessageById(ids[2])
    expect(byId).not.toBeNull()
    expect(byId).toEqual(ws.getInbox().find(m => m.id === ids[2]))
    expect(ws.getInboxMessageById('no-such-id')).toBeNull()
  })

  it('counts follow a status change', () => {
    ws.updateInboxStatus(ids[0], 'read')
    expect(ws.getInboxCounts()).toEqual({ unread: 2, read: 2, archived: 1, total: 5 })
    expect(ws.getUnreadInboxSummary().bySender).toEqual({ 'agent-1': 1, 'agent-2': 1 })
    ws.updateInboxStatus(ids[0], 'unread')
  })
})

describe('fileExists', () => {
  it('reports presence without materializing the blob', () => {
    ws.writeFileBuffer('data/blob.bin', Buffer.alloc(512 * 1024, 0x61))
    expect(ws.fileExists('data/blob.bin')).toBe(true)
    expect(ws.fileExists('data/missing.bin')).toBe(false)
    ws.deleteFile('data/blob.bin')
    expect(ws.fileExists('data/blob.bin')).toBe(false)
  })

  it('still distinguishes created from modified on write', () => {
    const seen: Array<string> = []
    ws.setOnFileChangeCallback((change) => { seen.push(`${change.path}:${change.operation}`) })
    try {
      ws.writeFile('notes/one.md', 'first')
      ws.writeFile('notes/one.md', 'second')
      expect(seen).toContain('notes/one.md:created')
      expect(seen).toContain('notes/one.md:modified')
      const modified = seen.indexOf('notes/one.md:modified')
      expect(modified).toBeGreaterThan(seen.indexOf('notes/one.md:created'))
    } finally {
      ws.setOnFileChangeCallback(null)
    }
  })

  it('carries the previous text to the sink for a diff', () => {
    let previous: string | undefined = 'unset'
    ws.setOnFileChangeCallback((change) => { if (change.operation === 'modified') previous = change.previousContent })
    try {
      ws.writeFile('notes/two.md', 'before')
      ws.writeFile('notes/two.md', 'after')
      expect(previous).toBe('before')
    } finally {
      ws.setOnFileChangeCallback(null)
    }
  })
})

describe('log reads', () => {
  it('getLogsAfterId caps a page and the cursor catches the rest up', () => {
    ws.clearLogs()
    for (let i = 0; i < 40; i++) ws.insertLog('error', 'test', 'ev', null, `line ${i}`)

    const first = ws.getLogsAfterId(0, 10)
    expect(first).toHaveLength(10)
    expect(first[0].message).toBe('line 0')

    const second = ws.getLogsAfterId(first[first.length - 1].id, 10)
    expect(second).toHaveLength(10)
    expect(second[0].message).toBe('line 10')

    // Unbounded-looking call still returns everything under the default cap.
    expect(ws.getLogsAfterId(0).length).toBe(40)
  })

  it('trimLogs keeps at most maxRows rows by id arithmetic', () => {
    const db = ws.getDatabase()
    db.clearLogs()
    for (let i = 0; i < 50; i++) ws.insertLog('error', 'test', 'ev', null, `trim ${i}`)

    db.trimLogs(20)
    const kept = db.getLogs(1000)
    expect(kept.length).toBeLessThanOrEqual(20)
    expect(kept[0].message).toBe('trim 49') // getLogs is newest-first

    // Idempotent: a second pass over an already-trimmed table drops nothing.
    const before = db.getLogs(1000).length
    db.trimLogs(20)
    expect(db.getLogs(1000).length).toBe(before)

    // Empty table is a safe no-op (MAX(id) is NULL).
    db.clearLogs()
    expect(() => db.trimLogs(20)).not.toThrow()
    expect(db.getLogs(1000)).toHaveLength(0)
  })
})
