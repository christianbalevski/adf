import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'fs'
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
      expect((thrown as Error).message).toBe('agent-1.adf uses schema v2, which this version cannot upgrade (it upgrades v3 and later). The file was not changed.')
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
