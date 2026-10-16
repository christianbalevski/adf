import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, openSync, writeSync, closeSync, copyFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import Database from 'better-sqlite3'
import { AdfDatabase, AdfSchemaTooOldError, ADF_LATEST_SCHEMA_VERSION } from '../../src/main/adf/adf-database'
import { writeV2Adf, writeV31Adf } from '../helpers/old-schema-adf'

const AGENT_ID = '5f1d7a3e-2c4b-4e8a-9b6d-0a1b2c3d4e01'

const dirs: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function newDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'adf-old-schema-'))
  dirs.push(dir)
  return dir
}

function schemaVersion(filePath: string): string | undefined {
  const db = new Database(filePath, { readonly: true })
  try {
    return (db.prepare("SELECT value FROM adf_meta WHERE key = 'adf_schema_version'").get() as { value: string } | undefined)?.value
  } finally {
    db.close()
  }
}

function hasIndex(filePath: string, name: string): boolean {
  const db = new Database(filePath, { readonly: true })
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(name)
  } finally {
    db.close()
  }
}

/**
 * Characterization (W5-H, written before the fix): how valid files (v3 and
 * later) open. The fix for too-old files and failed opens MUST NOT change it.
 */
describe('AdfDatabase.open of valid files (characterization)', () => {
  it('migrates a v31 file to the latest version, backs it up first and removes the backup after', () => {
    const dir = newDir()
    const filePath = join(dir, 'agent-1.adf')
    writeV31Adf(filePath, { id: AGENT_ID, name: 'agent-1' })
    const log = vi.spyOn(console, 'log')

    const db = AdfDatabase.open(filePath)
    try {
      expect(db.getMeta('adf_schema_version')).toBe(String(ADF_LATEST_SCHEMA_VERSION))
      expect(db.getConfig().id).toBe(AGENT_ID)
      expect(existsSync(`${filePath}.bak`)).toBe(false)
    } finally {
      db.close()
    }
    // Listed first: a read-only peek of a WAL file creates -wal/-shm beside it.
    expect(readdirSync(dir).sort()).toEqual(['agent-1.adf'])
    expect(log.mock.calls.some(([line]) => String(line).includes(`Backup created before migration (v31 → v${ADF_LATEST_SCHEMA_VERSION})`))).toBe(true)
    expect(schemaVersion(filePath)).toBe(String(ADF_LATEST_SCHEMA_VERSION))
    expect(hasIndex(filePath, 'idx_adf_outbox_created')).toBe(true)
  })

  it('opens a current file without a backup', () => {
    const dir = newDir()
    const filePath = join(dir, 'agent-1.adf')
    AdfDatabase.create(filePath, { name: 'agent-1' }).close()
    const db = AdfDatabase.open(filePath)
    try {
      expect(db.getMeta('adf_schema_version')).toBe(String(ADF_LATEST_SCHEMA_VERSION))
      expect(existsSync(`${filePath}.bak`)).toBe(false)
    } finally {
      db.close()
    }
    expect(readdirSync(dir).sort()).toEqual(['agent-1.adf'])
  })

  it('opens a file from a newer runtime without migrating it', () => {
    const dir = newDir()
    const filePath = join(dir, 'agent-1.adf')
    AdfDatabase.create(filePath, { name: 'agent-1' }).close()
    const raw = new Database(filePath)
    raw.prepare("UPDATE adf_meta SET value = ? WHERE key = 'adf_schema_version'").run(String(ADF_LATEST_SCHEMA_VERSION + 1))
    raw.close()
    vi.spyOn(console, 'assert').mockImplementation(() => {})

    const db = AdfDatabase.open(filePath)
    try {
      expect(db.getMeta('adf_schema_version')).toBe(String(ADF_LATEST_SCHEMA_VERSION + 1))
      expect(existsSync(`${filePath}.bak`)).toBe(false)
    } finally {
      db.close()
    }
  })
})

/**
 * W5-H: a file older than the migration ladder (v2; the ladder starts at
 * v3) is refused before anything is written. It used to be backed up, run
 * through the always-run steps (which dropped adf_archive and replaced a
 * legacy trigger config), have its backup deleted, and then fail in the
 * constructor with the connection left open — at every boot.
 */
describe('AdfDatabase.open of a file too old to upgrade (W5-H)', () => {
  it('refuses a v2 file with a clear message and leaves it byte-identical', () => {
    const dir = newDir()
    const filePath = join(dir, 'agent-1.adf')
    writeV2Adf(filePath, { id: AGENT_ID, name: 'agent-1' })
    const before = readFileSync(filePath)
    const log = vi.spyOn(console, 'log')

    for (let attempt = 0; attempt < 2; attempt++) {
      let thrown: unknown
      try { AdfDatabase.open(filePath).close() } catch (err) { thrown = err }
      expect(thrown).toBeInstanceOf(AdfSchemaTooOldError)
      expect((thrown as Error).message).toBe('agent-1.adf uses schema v2, which this version cannot upgrade (it upgrades v3 and later; no released version upgrades older files). The file was not changed. See "An agent file uses schema v2" in the ADF troubleshooting guide.')
      expect((thrown as AdfSchemaTooOldError).code).toBe('schema_too_old')
      expect(readdirSync(dir).sort()).toEqual(['agent-1.adf'])
      expect(readFileSync(filePath).equals(before)).toBe(true)
    }
    expect(log.mock.calls.some(([line]) => String(line).includes('Backup created before migration'))).toBe(false)

    // Its tables are as they were: adf_archive kept, no adf_audit added.
    const raw = new Database(filePath, { readonly: true })
    try {
      const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((t) => t.name)
      expect(tables).toContain('adf_archive')
      expect(tables).not.toContain('adf_audit')
      expect((raw.prepare('SELECT COUNT(*) AS n FROM adf_archive').get() as { n: number }).n).toBe(1)
    } finally {
      raw.close()
    }
  })

  it('opens a file whose adf_meta has no schema version, as before (a clone with adf_meta deselected)', () => {
    const dir = newDir()
    const filePath = join(dir, 'agent-1.adf')
    AdfDatabase.create(filePath, { name: 'agent-1' }).close()
    const raw = new Database(filePath)
    raw.prepare('DELETE FROM adf_meta').run()
    raw.close()

    const db = AdfDatabase.open(filePath)
    try {
      expect(db.getConfig().name).toBe('agent-1')
    } finally {
      db.close()
    }
  })

  it('stamps an unversioned clone with the latest version at its first open; the second open makes no backup', () => {
    const dir = newDir()
    const filePath = join(dir, 'agent-1.adf')
    AdfDatabase.create(filePath, { name: 'agent-1' }).close()
    const raw = new Database(filePath)
    raw.prepare('DELETE FROM adf_meta').run()
    raw.close()
    const log = vi.spyOn(console, 'log')

    AdfDatabase.open(filePath).close()
    expect(schemaVersion(filePath)).toBe(String(ADF_LATEST_SCHEMA_VERSION))
    const backups = () => log.mock.calls.filter(([line]) => String(line).includes('before migration')).length
    expect(backups()).toBe(1)
    AdfDatabase.open(filePath).close()
    expect(backups()).toBe(1)
    expect(readdirSync(dir).filter((n) => n.includes('.bak'))).toEqual([])
  })

  it('does not refuse v3, the oldest version the ladder upgrades', () => {
    const dir = newDir()
    const filePath = join(dir, 'agent-1.adf')
    AdfDatabase.create(filePath, { name: 'agent-1' }).close()
    const raw = new Database(filePath)
    raw.prepare("UPDATE adf_meta SET value = '3' WHERE key = 'adf_schema_version'").run()
    raw.close()

    let thrown: unknown
    try { AdfDatabase.open(filePath).close() } catch (err) { thrown = err }
    expect(thrown).not.toBeInstanceOf(AdfSchemaTooOldError)
  })
})

/**
 * W5-H: an open that fails after the connection is up (a migration step, or
 * the constructor's statements) closes the connection, gives back its open
 * count, leaves no sidecars, and puts the file back from its pre-migration
 * backup, which it keeps. The backup goes only after a fully successful open.
 */
describe('AdfDatabase.open that fails (W5-H)', () => {
  const forceConstructorFailure = () =>
    vi.spyOn(AdfDatabase.prototype as unknown as { prepareStatements(): void }, 'prepareStatements')
      .mockImplementationOnce(() => { throw new Error('forced constructor failure') })

  it('a constructor failure after a migration restores the file from its backup and keeps the backup', () => {
    const dir = newDir()
    const filePath = join(dir, 'agent-1.adf')
    writeV31Adf(filePath, { id: AGENT_ID, name: 'agent-1' })
    forceConstructorFailure()

    expect(() => AdfDatabase.open(filePath)).toThrow('forced constructor failure')
    expect(readdirSync(dir).sort()).toEqual(['agent-1.adf', 'agent-1.adf.bak'])
    expect(readFileSync(filePath).equals(readFileSync(`${filePath}.bak`))).toBe(true)
    expect(AdfDatabase.openFilePaths()).toEqual([])
    expect(schemaVersion(filePath)).toBe('31')
    expect(hasIndex(filePath, 'idx_adf_outbox_created')).toBe(false)

    // The next open migrates it.
    const db = AdfDatabase.open(filePath)
    try {
      expect(db.getMeta('adf_schema_version')).toBe(String(ADF_LATEST_SCHEMA_VERSION))
      expect(db.getConfig().id).toBe(AGENT_ID)
    } finally {
      db.close()
    }
  })

  it('a failed migration step restores the file from its backup and keeps the backup', () => {
    const dir = newDir()
    const filePath = join(dir, 'agent-1.adf')
    writeV31Adf(filePath, { id: AGENT_ID, name: 'agent-1' })
    // The v31 → v32 step indexes adf_outbox: without the table it throws.
    const raw = new Database(filePath)
    raw.exec('DROP TABLE adf_outbox')
    raw.close()
    vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(() => AdfDatabase.open(filePath)).toThrow(/no such table: (main\.)?adf_outbox/)
    expect(readdirSync(dir).sort()).toEqual(['agent-1.adf', 'agent-1.adf.bak'])
    expect(readFileSync(filePath).equals(readFileSync(`${filePath}.bak`))).toBe(true)
    expect(AdfDatabase.openFilePaths()).toEqual([])
    expect(schemaVersion(filePath)).toBe('31')
  })

  it('a constructor failure on a current file closes the connection and leaves no sidecars', () => {
    const dir = newDir()
    const filePath = join(dir, 'agent-1.adf')
    AdfDatabase.create(filePath, { name: 'agent-1' }).close()
    forceConstructorFailure()

    expect(() => AdfDatabase.open(filePath)).toThrow('forced constructor failure')
    expect(readdirSync(dir).sort()).toEqual(['agent-1.adf'])
    expect(AdfDatabase.openFilePaths()).toEqual([])
    const db = AdfDatabase.open(filePath)
    db.close()
  })
})

const tableNames = (filePath: string) => {
  const db = new Database(filePath, { readonly: true })
  try {
    return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name)
  } finally {
    db.close()
  }
}
const configOf = (filePath: string) => {
  const db = new Database(filePath, { readonly: true })
  try {
    return JSON.parse((db.prepare('SELECT config_json FROM adf_config WHERE id = 1').get() as { config_json: string }).config_json)
  } finally {
    db.close()
  }
}

/** W5-H review: every path to a migration is closed for files too old to upgrade. */
describe('AdfDatabase.open fails closed (W5-H review)', () => {
  it('refuses a v2-shaped file with no schema version row before any write', () => {
    const dir = newDir()
    const filePath = join(dir, 'agent-1.adf')
    writeV2Adf(filePath, { id: AGENT_ID, name: 'agent-1' })
    const raw = new Database(filePath)
    raw.prepare("DELETE FROM adf_meta WHERE key = 'schema_version'").run()
    raw.close()
    const before = readFileSync(filePath)

    expect(() => AdfDatabase.open(filePath)).toThrow(/^agent-1\.adf has no schema version and an older layout, which this version cannot upgrade .* The file was not changed\./)
    expect(readdirSync(dir)).toEqual(['agent-1.adf'])
    expect(readFileSync(filePath).equals(before)).toBe(true)
  })

  it('refuses a legacy-shaped file with no version even when adf_meta has a protection column', () => {
    const dir = newDir()
    const filePath = join(dir, 'agent-1.adf')
    writeV2Adf(filePath, { id: AGENT_ID, name: 'agent-1' })
    const raw = new Database(filePath)
    raw.prepare("DELETE FROM adf_meta WHERE key = 'schema_version'").run()
    raw.exec("ALTER TABLE adf_meta ADD COLUMN protection TEXT NOT NULL DEFAULT 'none'")
    raw.close()

    expect(() => AdfDatabase.open(filePath)).toThrow(AdfSchemaTooOldError)
    expect(tableNames(filePath)).toContain('adf_archive')
    expect(configOf(filePath).triggers).toEqual({ document: { enabled: true }, agent: { enabled: true } })
  })

  it('a busy pre-check fails as locked, never migrates', () => {
    const dir = newDir()
    const filePath = join(dir, 'agent-1.adf')
    writeV2Adf(filePath, { id: AGENT_ID, name: 'agent-1' })
    const before = readFileSync(filePath)
    vi.spyOn(AdfDatabase as unknown as { readSchemaVersion(db: unknown): number | null }, 'readSchemaVersion')
      .mockImplementationOnce(() => { throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }) })

    expect(() => AdfDatabase.open(filePath)).toThrow(/locked by another process/)
    expect(readdirSync(dir)).toEqual(['agent-1.adf'])
    expect(readFileSync(filePath).equals(before)).toBe(true)
  })

  it('a pre-check that throws (not busy) does not fall through: the authoritative read refuses before any write', () => {
    const dir = newDir()
    const filePath = join(dir, 'agent-1.adf')
    writeV2Adf(filePath, { id: AGENT_ID, name: 'agent-1' })
    const before = readFileSync(filePath)
    const read = vi.spyOn(AdfDatabase as unknown as { readSchemaVersion(db: unknown): number | null }, 'readSchemaVersion')
      .mockImplementationOnce(() => { throw new Error('disk I/O error') })

    expect(() => AdfDatabase.open(filePath)).toThrow(AdfSchemaTooOldError)
    expect(read.mock.calls.length).toBe(2)
    expect(readdirSync(dir)).toEqual(['agent-1.adf'])
    expect(readFileSync(filePath).equals(before)).toBe(true)
    expect(tableNames(filePath)).toContain('adf_archive')
  })

  it('a pre-check that cannot read (corrupt adf_meta index) never leads to a migration', () => {
    const dir = newDir()
    const filePath = join(dir, 'agent-1.adf')
    writeV2Adf(filePath, { id: AGENT_ID, name: 'agent-1' })
    const raw = new Database(filePath)
    const root = (raw.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'sqlite_autoindex_adf_meta_1'").get() as { rootpage: number }).rootpage
    const pageSize = raw.pragma('page_size', { simple: true }) as number
    raw.pragma('journal_mode = DELETE')
    raw.close()
    const fd = openSync(filePath, 'r+')
    writeSync(fd, Buffer.alloc(pageSize, 0xab), 0, pageSize, (root - 1) * pageSize)
    closeSync(fd)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})

    let thrown: unknown
    try { AdfDatabase.open(filePath).close() } catch (err) { thrown = err }
    // Unrepairable here; a repaired file would be refused by the authoritative read.
    expect(String((thrown as Error)?.message)).toMatch(/corrupt|cannot upgrade/)
    if (thrown instanceof AdfSchemaTooOldError) expect(thrown.message).not.toContain('The file was not changed')
    expect(tableNames(filePath)).toContain('adf_archive')
    expect(tableNames(filePath)).not.toContain('adf_audit')
    expect(readdirSync(dir).some((n) => n.endsWith('.bak'))).toBe(false)
  })

  it('a refused file with a hot -wal: the WAL is not folded into it', () => {
    const dir = newDir()
    const source = join(dir, 'source.adf')
    writeV2Adf(source, { id: AGENT_ID, name: 'agent-1' })
    const writer = new Database(source)
    writer.pragma('wal_autocheckpoint = 0')
    writer.prepare("INSERT INTO adf_loop (role, content_json) VALUES ('user', '[]')").run()
    // A crash: the main file and its WAL with committed frames, no -shm.
    const filePath = join(dir, 'agent-1.adf')
    copyFileSync(source, filePath)
    copyFileSync(`${source}-wal`, `${filePath}-wal`)
    writer.close()
    const before = readFileSync(filePath)
    const walBefore = readFileSync(`${filePath}-wal`)

    let thrown: unknown
    try { AdfDatabase.open(filePath).close() } catch (err) { thrown = err }
    expect(thrown).toBeInstanceOf(AdfSchemaTooOldError)
    expect((thrown as Error).message).toContain('The file was not changed.')
    expect(readFileSync(filePath).equals(before)).toBe(true)
    expect(readFileSync(`${filePath}-wal`).equals(walBefore)).toBe(true)
  })
})

describe('AdfDatabase.open migrates in one transaction (W5-H review)', () => {
  it('a failing step rolls back the steps before it; a second failure reuses the identical backup', () => {
    const dir = newDir()
    const filePath = join(dir, 'agent-1.adf')
    writeV31Adf(filePath, { id: AGENT_ID, name: 'agent-1' })
    const raw = new Database(filePath)
    const row = raw.prepare('SELECT config_json FROM adf_config WHERE id = 1').get() as { config_json: string }
    // Stripped by a step that runs for every version, before the ladder's v31 → v32 step fails.
    raw.prepare('UPDATE adf_config SET config_json = ? WHERE id = 1').run(JSON.stringify({ ...JSON.parse(row.config_json), security: { allow_protected_writes: true } }))
    raw.exec('DROP TABLE adf_outbox')
    raw.close()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log')

    for (let attempt = 0; attempt < 3; attempt++) {
      expect(() => AdfDatabase.open(filePath)).toThrow(/no such table: (main\.)?adf_outbox/)
      expect(readdirSync(dir).sort()).toEqual(['agent-1.adf', 'agent-1.adf.bak'])
      expect(readFileSync(filePath).equals(readFileSync(`${filePath}.bak`))).toBe(true)
      expect(configOf(filePath).security).toEqual({ allow_protected_writes: true })
      expect(schemaVersion(filePath)).toBe('31')
      expect(AdfDatabase.openFilePaths()).toEqual([])
    }
    expect(log.mock.calls.filter(([line]) => String(line).includes('already on disk, unchanged')).length).toBe(2)
  })

  it('a constructor failure after the commit keeps the backup and says so when another connection holds the file', () => {
    const dir = newDir()
    const filePath = join(dir, 'agent-1.adf')
    writeV31Adf(filePath, { id: AGENT_ID, name: 'agent-1' })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(AdfDatabase.prototype as unknown as { prepareStatements(): void }, 'prepareStatements')
      .mockImplementationOnce(() => { throw new Error('forced constructor failure') })
    const other = new Database(filePath)
    try {
      other.prepare('SELECT COUNT(*) FROM adf_meta').get()
      expect(() => AdfDatabase.open(filePath)).toThrow(/^forced constructor failure\. agent-1\.adf was migrated and could not be put back from its backup because another connection has the file open; the backup is kept at /)
      expect(existsSync(`${filePath}.bak`)).toBe(true)
      expect(AdfDatabase.openFilePaths()).toEqual([])
    } finally {
      other.close()
    }
  })
})
