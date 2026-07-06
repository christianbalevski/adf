import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import Database from 'better-sqlite3'
import { AdfDatabase } from '../../src/main/adf/adf-database'

let rootDir: string

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'adf-att-migration-'))
})

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true })
})

describe('v23 → v24 attestations migration (ADF_IDENTITY_SPEC D15)', () => {
  it('copies the legacy meta array into the table and retires the meta key', () => {
    const adfPath = join(rootDir, 'legacy.adf')
    AdfDatabase.create(adfPath, { name: 'legacy' }).close()

    // Recreate v23 state: no attestations table, JSON array in adf_meta
    const legacyAtts = [
      { issuer: 'did:key:zOwner', subject: 'did:key:zAgent', role: 'owner', issued_at: '2026-07-01T00:00:00.000Z', signature: 'ed25519:AAAA' },
      { issuer: 'did:key:zOwner', subject: 'did:key:zAgent', role: 'clone', issued_at: '2026-07-02T00:00:00.000Z', scope: 'did:key:zPrev', signature: 'ed25519:BBBB' }
    ]
    const raw = new Database(adfPath)
    raw.exec('DROP TABLE IF EXISTS adf_attestations')
    raw.prepare("UPDATE adf_meta SET value = '23' WHERE key = 'adf_schema_version'").run()
    raw.prepare("INSERT OR REPLACE INTO adf_meta (key, value, protection) VALUES ('adf_attestations', ?, 'readonly')").run(JSON.stringify(legacyAtts))
    raw.close()

    const db = AdfDatabase.open(adfPath)
    try {
      expect(db.getMeta('adf_schema_version')).toBe('24')
      expect(db.getMeta('adf_attestations')).toBeNull()
      const migrated = db.listAttestations()
      expect(migrated).toHaveLength(2)
      expect(migrated.map((a) => a.role).sort()).toEqual(['clone', 'owner'])
      expect(migrated.find((a) => a.role === 'clone')?.scope).toBe('did:key:zPrev')
    } finally {
      db.close()
    }
  })

  it('migrates cleanly when no legacy attestations exist', () => {
    const adfPath = join(rootDir, 'empty.adf')
    AdfDatabase.create(adfPath, { name: 'empty' }).close()

    const raw = new Database(adfPath)
    raw.exec('DROP TABLE IF EXISTS adf_attestations')
    raw.prepare("UPDATE adf_meta SET value = '23' WHERE key = 'adf_schema_version'").run()
    raw.close()

    const db = AdfDatabase.open(adfPath)
    try {
      expect(db.getMeta('adf_schema_version')).toBe('24')
      expect(db.listAttestations()).toEqual([])
    } finally {
      db.close()
    }
  })

  it('new files are created at v24 with the table present', () => {
    const db = AdfDatabase.create(join(rootDir, 'fresh.adf'), { name: 'fresh' })
    try {
      expect(db.getMeta('adf_schema_version')).toBe('24')
      expect(db.listAttestations()).toEqual([])
    } finally {
      db.close()
    }
  })
})
