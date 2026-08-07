import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import Database from 'better-sqlite3'
import { AdfDatabase } from '../../src/main/adf/adf-database'

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

  it('reopens a current-version file (fast path) with working statements', () => {
    const adfPath = newAdf('fastpath')
    const created = AdfDatabase.create(adfPath, { name: 'agent-1' })
    created.setMeta('probe', 'value', 'none')
    created.close()

    const db = AdfDatabase.open(adfPath)
    try {
      expect(db.getMeta('adf_schema_version')).toBe('25')
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
      expect(db.getMeta('adf_schema_version')).toBe('25')
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
      expect(db.getMeta('adf_schema_version')).toBe('25')
    } finally {
      db.close()
    }
  })

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
