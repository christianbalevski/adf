import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { brotliCompressSync, brotliDecompressSync } from 'zlib'
import Database from 'better-sqlite3'
import { AdfDatabase, ADF_LATEST_SCHEMA_VERSION } from '../../src/main/adf/adf-database'
import { DEFAULT_MIND_CONTENT, DEFAULT_MIND_LOG_CONTENT } from '../../src/shared/types/adf-v02.types'

let rootDir: string

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'adf-audit-v28-'))
})

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true })
})

function brotli(obj: unknown): Buffer {
  return brotliCompressSync(Buffer.from(JSON.stringify(obj), 'utf-8'))
}

/** Rebuild a freshly created file into the pre-v28 shape: old adf_audit
 *  columns (start_at/end_at, no seq/ref), no adf_loop.ord, version 27. */
function downgradeToV27(adfPath: string, seed: (raw: InstanceType<typeof Database>) => void): void {
  const raw = new Database(adfPath)
  raw.exec(`
    DROP TABLE adf_audit;
    CREATE TABLE adf_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      start_at INTEGER NOT NULL,
      end_at INTEGER NOT NULL,
      entry_count INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL,
      data BLOB NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_adf_audit_source ON adf_audit(source);
    -- v29's stream index is an expression over ord; SQLite refuses to drop a
    -- column an index references, and a v27 file never had the index anyway.
    DROP INDEX IF EXISTS idx_adf_loop_stream;
    ALTER TABLE adf_loop DROP COLUMN ord;
  `)
  seed(raw)
  raw.prepare("UPDATE adf_meta SET value = '27' WHERE key = 'adf_schema_version'").run()
  raw.close()
}

describe('adf_audit seq-addressing migration (v27 → v28)', () => {
  it('rebuilds adf_audit, backfills seq ranges/refs from real brotli blobs, and adds adf_loop.ord', () => {
    const adfPath = join(rootDir, 'legacy.adf')
    AdfDatabase.create(adfPath, { name: 'legacy' }).close()

    const loopEntries = [
      { seq: 5, role: 'user', content_json: [{ type: 'text', text: 'hello' }], created_at: 1000 },
      { seq: 6, role: 'assistant', content_json: [{ type: 'text', text: 'hi' }], created_at: 2000 },
      { seq: 9, role: 'user', content_json: [{ type: 'text', text: 'bye' }], created_at: 3000 }
    ]
    const inboxMsg = { version: '1.0', id: 'alf-msg-123', from: 'did:key:a', payload: { content: 'x' } }
    const fileSnap = { path: 'notes/deleted.md', content_base64: Buffer.from('# gone').toString('base64'), mime_type: 'text/markdown', size: 6 }
    const legacyBatch = [{ id: 'row-1', received_at: 10 }, { id: 'row-2', received_at: 20 }]

    downgradeToV27(adfPath, (raw) => {
      const ins = raw.prepare('INSERT INTO adf_audit (id, source, start_at, end_at, entry_count, size_bytes, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      ins.run(1, 'loop', 1000, 3000, 3, 111, brotli(loopEntries), 4000)
      ins.run(2, 'inbox_message', 50, 50, 1, 22, brotli(inboxMsg), 4001)
      ins.run(3, 'outbox_message', 60, 60, 1, 23, brotli({ ...inboxMsg, id: 'alf-msg-456' }), 4002)
      ins.run(4, 'file', 70, 70, 1, 24, brotli(fileSnap), 4003)
      ins.run(5, 'inbox', 10, 20, 2, 25, brotli(legacyBatch), 4004)
      // Corrupt blob: backfill must skip it and leave NULLs, not throw.
      ins.run(6, 'loop', 80, 90, 1, 26, Buffer.from('not brotli at all'), 4005)
      // Legacy mind state: no mind/log.md yet, empty mind.md (pre-skeleton default).
      raw.prepare("DELETE FROM adf_files WHERE path = 'mind/log.md'").run()
      raw.prepare("UPDATE adf_files SET content = ?, size = 0 WHERE path = 'mind.md'").run(Buffer.from(''))
    })

    // Sanity: pre-migration shape really is old.
    const pre = new Database(adfPath, { readonly: true })
    const preCols = (pre.prepare('PRAGMA table_info(adf_audit)').all() as Array<{ name: string }>).map(c => c.name)
    expect(preCols).toContain('start_at')
    expect(preCols).not.toContain('start_seq')
    const preLoopCols = (pre.prepare('PRAGMA table_info(adf_loop)').all() as Array<{ name: string }>).map(c => c.name)
    expect(preLoopCols).not.toContain('ord')
    pre.close()

    const db = AdfDatabase.open(adfPath)
    try {
      expect(db.getMeta('adf_schema_version')).toBe(String(ADF_LATEST_SCHEMA_VERSION))

      const raw = (db as unknown as { db: InstanceType<typeof Database> }).db
      const cols = (raw.prepare('PRAGMA table_info(adf_audit)').all() as Array<{ name: string }>).map(c => c.name)
      expect(cols).toEqual(['id', 'source', 'start_seq', 'end_seq', 'ref', 'entry_count', 'size_bytes', 'data', 'created_at'])
      const loopCols = (raw.prepare('PRAGMA table_info(adf_loop)').all() as Array<{ name: string }>).map(c => c.name)
      expect(loopCols).toContain('ord')

      const rows = raw.prepare('SELECT id, source, start_seq, end_seq, ref, entry_count, created_at FROM adf_audit ORDER BY id').all() as Array<{
        id: number; source: string; start_seq: number | null; end_seq: number | null; ref: string | null; entry_count: number; created_at: number
      }>
      expect(rows.map(r => r.id)).toEqual([1, 2, 3, 4, 5, 6])

      // loop → seq range from first/last entry in blob
      expect(rows[0]).toMatchObject({ source: 'loop', start_seq: 5, end_seq: 9, ref: null })
      // message sources → ref = ALF message id
      expect(rows[1]).toMatchObject({ source: 'inbox_message', start_seq: null, end_seq: null, ref: 'alf-msg-123' })
      expect(rows[2]).toMatchObject({ source: 'outbox_message', ref: 'alf-msg-456' })
      // file → ref = path
      expect(rows[3]).toMatchObject({ source: 'file', ref: 'notes/deleted.md' })
      // legacy batch → all NULLs (legacy-read-only source)
      expect(rows[4]).toMatchObject({ source: 'inbox', start_seq: null, end_seq: null, ref: null })
      // corrupt blob → NULLs, row preserved
      expect(rows[5]).toMatchObject({ source: 'loop', start_seq: null, end_seq: null, ref: null })

      // Metadata (entry_count/created_at) and blob bytes survive the rebuild.
      expect(rows[0].entry_count).toBe(3)
      expect(rows[0].created_at).toBe(4000)
      const blob = raw.prepare('SELECT data FROM adf_audit WHERE id = 1').get() as { data: Buffer }
      expect(JSON.parse(brotliDecompressSync(blob.data).toString('utf-8'))).toEqual(loopEntries)

      // The (source, start_seq) index exists post-rebuild.
      const idx = (raw.prepare("PRAGMA index_list('adf_audit')").all() as Array<{ name: string }>).map(i => i.name)
      expect(idx).toContain('idx_adf_audit_source_start')

      // Insert path works against the rebuilt table and continues ids.
      const newId = db.insertAudit('loop', { startSeq: 10, endSeq: 12, entryCount: 2, sizeBytes: 5, data: brotli([]) })
      expect(newId).toBeGreaterThan(6)
      expect(db.getAuditById(newId)).toMatchObject({ source: 'loop', start_seq: 10, end_seq: 12, ref: null })

      // Mind seeds: mind/log.md backfilled, empty mind.md upgraded to the skeleton.
      const mindLog = raw.prepare("SELECT content, protection FROM adf_files WHERE path = 'mind/log.md'").get() as { content: Buffer; protection: string } | undefined
      expect(mindLog).toBeDefined()
      expect(mindLog!.content.toString('utf-8')).toBe(DEFAULT_MIND_LOG_CONTENT)
      expect(mindLog!.protection).toBe('no_delete')
      const mind = raw.prepare("SELECT content FROM adf_files WHERE path = 'mind.md'").get() as { content: Buffer }
      expect(mind.content.toString('utf-8')).toBe(DEFAULT_MIND_CONTENT)
    } finally {
      db.close()
    }
  })

  it('never clobbers a lived-in mind.md while still seeding mind/log.md', () => {
    const adfPath = join(rootDir, 'lived-in.adf')
    AdfDatabase.create(adfPath, { name: 'lived-in' }).close()
    downgradeToV27(adfPath, (raw) => {
      raw.prepare("DELETE FROM adf_files WHERE path = 'mind/log.md'").run()
      raw.prepare("UPDATE adf_files SET content = ? WHERE path = 'mind.md'").run(Buffer.from('# My facts\n- the user prefers terse replies\n'))
    })

    const db = AdfDatabase.open(adfPath)
    try {
      const raw = (db as unknown as { db: InstanceType<typeof Database> }).db
      const mind = raw.prepare("SELECT content FROM adf_files WHERE path = 'mind.md'").get() as { content: Buffer }
      expect(mind.content.toString('utf-8')).toBe('# My facts\n- the user prefers terse replies\n')
      const mindLog = raw.prepare("SELECT content FROM adf_files WHERE path = 'mind/log.md'").get() as { content: Buffer } | undefined
      expect(mindLog).toBeDefined()
      expect(mindLog!.content.toString('utf-8')).toBe(DEFAULT_MIND_LOG_CONTENT)
    } finally {
      db.close()
    }
  })

  it('is idempotent for files created at v28 (fresh create needs no rebuild)', () => {
    const adfPath = join(rootDir, 'fresh.adf')
    const db = AdfDatabase.create(adfPath, { name: 'fresh' })
    try {
      expect(db.getMeta('adf_schema_version')).toBe(String(ADF_LATEST_SCHEMA_VERSION))
      const raw = (db as unknown as { db: InstanceType<typeof Database> }).db
      const cols = (raw.prepare('PRAGMA table_info(adf_audit)').all() as Array<{ name: string }>).map(c => c.name)
      expect(cols).toContain('start_seq')
      const loopCols = (raw.prepare('PRAGMA table_info(adf_loop)').all() as Array<{ name: string }>).map(c => c.name)
      expect(loopCols).toContain('ord')
      // Fresh agents get the mind wiki seeded at create().
      const mind = raw.prepare("SELECT content FROM adf_files WHERE path = 'mind.md'").get() as { content: Buffer }
      expect(mind.content.toString('utf-8')).toBe(DEFAULT_MIND_CONTENT)
      const mindLog = raw.prepare("SELECT content, protection FROM adf_files WHERE path = 'mind/log.md'").get() as { content: Buffer; protection: string }
      expect(mindLog.content.toString('utf-8')).toBe(DEFAULT_MIND_LOG_CONTENT)
      expect(mindLog.protection).toBe('no_delete')
    } finally {
      db.close()
    }
  })
})
