/**
 * Old `.adf` files for tests (W5-H): a v2 file, older than the migration
 * ladder in AdfDatabase.open (which starts at v3), and a v31 file, one step
 * behind. Written with raw SQLite, never through AdfDatabase.open.
 */
import Database from 'better-sqlite3'
import { AdfDatabase } from '../../src/main/adf/adf-database'

export interface OldAdfOptions {
  id: string
  name: string
  /** v31 only: the `Created:` date README.md states (create() writes today's), for recordings. */
  createdDate?: string
}

/**
 * A v2 file: `schema_version` 2 in an `adf_meta` without the `protection`
 * column, `adf_files.protected`, an `adf_loop` without `model`/`tokens`/
 * `created_at`, the legacy trigger shape, and an `adf_archive` table holding
 * one archived snapshot (the table the always-run steps of open() drop).
 * WAL mode, as the runtime writes every file.
 */
export function writeV2Adf(filePath: string, opts: OldAdfOptions): void {
  const db = new Database(filePath)
  try {
    db.pragma('journal_mode = WAL')
    db.exec(`
      CREATE TABLE adf_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE adf_config (id INTEGER PRIMARY KEY CHECK (id = 1), config_json TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE adf_files (path TEXT PRIMARY KEY, content BLOB NOT NULL, mime_type TEXT, size INTEGER NOT NULL, protected INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE adf_loop (seq INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, content_json TEXT NOT NULL);
      CREATE TABLE adf_archive (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, data BLOB NOT NULL, created_at INTEGER NOT NULL);
    `)
    const meta = db.prepare('INSERT INTO adf_meta (key, value) VALUES (?, ?)')
    meta.run('adf_version', '0.1')
    meta.run('schema_version', '2')
    const config = {
      id: opts.id,
      name: opts.name,
      security: { allow_protected_writes: true },
      triggers: { document: { enabled: true }, agent: { enabled: true } },
      tools: [{ name: 'container_exec', enabled: true }],
    }
    db.prepare('INSERT INTO adf_config (id, config_json, updated_at) VALUES (1, ?, ?)').run(JSON.stringify(config), '2026-01-01T00:00:00.000Z')
    db.prepare('INSERT INTO adf_files (path, content, mime_type, size, protected, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)')
      .run('document.md', Buffer.from(`# ${opts.name}\n`), 'text/markdown', opts.name.length + 3, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    db.prepare('INSERT INTO adf_loop (role, content_json) VALUES (?, ?)').run('user', JSON.stringify([{ type: 'text', text: 'hello' }]))
    db.prepare('INSERT INTO adf_archive (source, data, created_at) VALUES (?, ?, ?)').run('loop', Buffer.from('archived transcript'), 1767225600000)
  } finally {
    db.close()
  }
}

/**
 * A v31 file: a current file with the v31 → v32 step undone (no
 * `idx_adf_outbox_created`, `adf_schema_version` 31). Closed cleanly.
 */
export function writeV31Adf(filePath: string, opts: OldAdfOptions): void {
  AdfDatabase.create(filePath, { name: opts.name, handle: opts.name, icon: '🤖' }).close()
  const db = new Database(filePath)
  try {
    const row = db.prepare('SELECT config_json FROM adf_config WHERE id = 1').get() as { config_json: string }
    db.prepare('UPDATE adf_config SET config_json = ? WHERE id = 1').run(JSON.stringify({ ...JSON.parse(row.config_json), id: opts.id }))
    if (opts.createdDate) {
      const readme = db.prepare("SELECT content FROM adf_files WHERE path = 'README.md'").get() as { content: Buffer } | undefined
      if (readme) {
        const pinned = Buffer.from(Buffer.from(readme.content).toString('utf-8').replace(/^Created: \d{4}-\d{2}-\d{2}$/m, `Created: ${opts.createdDate}`))
        db.prepare("UPDATE adf_files SET content = ?, size = ? WHERE path = 'README.md'").run(pinned, pinned.length)
      }
    }
    db.exec('DROP INDEX IF EXISTS idx_adf_outbox_created')
    db.prepare("UPDATE adf_meta SET value = '31' WHERE key = 'adf_schema_version'").run()
  } finally {
    db.close()
  }
}
