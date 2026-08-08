import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import Database from 'better-sqlite3'
import { AdfDatabase, ADF_LATEST_SCHEMA_VERSION } from '../../src/main/adf/adf-database'

const CLEAN_CLOSE_KEY = 'adf_clean_close'

function readMarker(adfPath: string): string | null {
  const raw = new Database(adfPath, { readonly: true })
  try {
    const row = raw.prepare('SELECT value FROM adf_meta WHERE key = ?').get(CLEAN_CLOSE_KEY) as
      | { value: string }
      | undefined
    return row?.value ?? null
  } finally {
    raw.close()
  }
}

describe('AdfDatabase open fast path + clean-close marker', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function newAdf(name: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'adf-fastpath-'))
    dirs.push(dir)
    return join(dir, `${name}.adf`)
  }

  it('close() writes the clean-close marker; open() clears it', () => {
    const adfPath = newAdf('marker')
    const db = AdfDatabase.create(adfPath, { name: 'agent-1' })
    db.close()
    expect(readMarker(adfPath)).not.toBeNull()

    const reopened = AdfDatabase.open(adfPath)
    try {
      // While a session is live the marker must be absent so a crash is
      // detected as an unclean shutdown by the next open.
      expect(readMarker(adfPath)).toBeNull()
    } finally {
      reopened.close()
    }
    expect(readMarker(adfPath)).not.toBeNull()
  })

  it('writes the marker only when the last in-process connection closes', () => {
    const adfPath = newAdf('multi-conn')
    const a = AdfDatabase.create(adfPath, { name: 'agent-1' })
    const b = AdfDatabase.open(adfPath)

    // First close: another in-process connection is still writing this file,
    // so certifying it clean now would falsely cover a later crash of b.
    a.close()
    expect(readMarker(adfPath)).toBeNull()

    // Last in-process close writes the marker.
    b.close()
    expect(readMarker(adfPath)).not.toBeNull()
  })

  it('reopens a current-version file (fast path) with working statements', () => {
    const adfPath = newAdf('fastpath')
    const created = AdfDatabase.create(adfPath, { name: 'agent-1' })
    created.setMeta('probe', 'value', 'none')
    created.close()

    const db = AdfDatabase.open(adfPath)
    try {
      expect(db.getMeta('adf_schema_version')).toBe(String(ADF_LATEST_SCHEMA_VERSION))
      expect(db.getMeta('probe')).toBe('value')
      expect(db.getConfig().name).toBe('agent-1')
    } finally {
      db.close()
    }
  })

  it('opens uncleanly-closed files (no marker) via the full integrity check path', () => {
    const adfPath = newAdf('unclean')
    const created = AdfDatabase.create(adfPath, { name: 'agent-1' })
    created.close()

    // Simulate an unclean shutdown: remove the marker outside AdfDatabase.
    const raw = new Database(adfPath)
    raw.prepare('DELETE FROM adf_meta WHERE key = ?').run(CLEAN_CLOSE_KEY)
    raw.close()

    const db = AdfDatabase.open(adfPath)
    try {
      expect(db.getMeta('adf_schema_version')).toBe(String(ADF_LATEST_SCHEMA_VERSION))
    } finally {
      db.close()
    }
  })

  it('supports forcing the full integrity check via open options', () => {
    const adfPath = newAdf('forced')
    const created = AdfDatabase.create(adfPath, { name: 'agent-1' })
    created.close()

    const db = AdfDatabase.open(adfPath, { forceIntegrityCheck: true })
    try {
      expect(db.getMeta('adf_schema_version')).toBe(String(ADF_LATEST_SCHEMA_VERSION))
    } finally {
      db.close()
    }
  })

  it('rethrows lock contention during open as a retryable locked error, not corruption', () => {
    const adfPath = newAdf('locked')
    AdfDatabase.create(adfPath, { name: 'agent-1' }).close()

    // Foreign holder with a retained EXCLUSIVE lock — the same primitive the
    // sidecar reap uses. open()'s first statement (the clean-close marker
    // SELECT) hits SQLITE_BUSY after the default busy timeout; that must
    // surface as a retryable "locked" error, never enter the repair path.
    const holder = new Database(adfPath)
    holder.pragma('locking_mode = EXCLUSIVE')
    holder.exec('BEGIN IMMEDIATE; COMMIT')
    try {
      expect(() => AdfDatabase.open(adfPath)).toThrow(/locked by another process/)
      // No corruption/repair artifacts were produced.
      expect(existsSync(`${adfPath}.corrupt`)).toBe(false)
      expect(existsSync(`${adfPath}.repaired`)).toBe(false)
    } finally {
      holder.close()
    }

    // Once the holder releases, the same file opens normally — nothing was
    // touched while it was locked.
    const db = AdfDatabase.open(adfPath)
    try {
      expect(db.getConfig().name).toBe('agent-1')
    } finally {
      db.close()
    }
  }, 30_000)

  it('peekBootStatusDetailed returns the parsed config and agent identity', () => {
    const adfPath = newAdf('peek')
    const created = AdfDatabase.create(adfPath, { name: 'agent-1', autostart: true })
    const agentId = created.getConfig().id
    created.close()

    const result = AdfDatabase.peekBootStatusDetailed(adfPath)
    expect(result.error).toBeUndefined()
    expect(result.status).toMatchObject({
      autostart: true,
      agentId,
      agentName: 'agent-1',
      hasEncryptedIdentity: false,
    })
    expect(result.config).toMatchObject({ id: agentId, name: 'agent-1', autostart: true })
  })
})
