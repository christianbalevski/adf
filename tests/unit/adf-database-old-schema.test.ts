import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import Database from 'better-sqlite3'
import { AdfDatabase, ADF_LATEST_SCHEMA_VERSION } from '../../src/main/adf/adf-database'
import { writeV31Adf } from '../helpers/old-schema-adf'

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
