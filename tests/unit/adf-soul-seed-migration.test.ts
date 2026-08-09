import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import Database from 'better-sqlite3'
import { AdfDatabase, ADF_LATEST_SCHEMA_VERSION } from '../../src/main/adf/adf-database'
import { DEFAULT_SOUL_CONTENT } from '../../src/shared/types/adf-v02.types'

let rootDir: string

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'adf-soul-migration-'))
})

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true })
})

describe('v24 → v25 soul.md seed migration', () => {
  it('new agents are created with the default soul.md', () => {
    const db = AdfDatabase.create(join(rootDir, 'fresh.adf'), { name: 'fresh' })
    try {
      const soul = db.readFile('soul.md')
      expect(soul).not.toBeNull()
      expect(soul!.content.toString()).toBe(DEFAULT_SOUL_CONTENT)
      expect(soul!.protection).toBe('no_delete')
    } finally {
      db.close()
    }
  })

  it('seeds soul.md into a v24 agent that lacks one', () => {
    const adfPath = join(rootDir, 'legacy.adf')
    AdfDatabase.create(adfPath, { name: 'legacy' }).close()

    // Recreate v24 state: no soul.md, version 24
    const raw = new Database(adfPath)
    raw.prepare("DELETE FROM adf_files WHERE path = 'soul.md'").run()
    raw.prepare("UPDATE adf_meta SET value = '24' WHERE key = 'adf_schema_version'").run()
    raw.close()

    const db = AdfDatabase.open(adfPath)
    try {
      expect(db.getMeta('adf_schema_version')).toBe(String(ADF_LATEST_SCHEMA_VERSION))
      expect(db.readFile('soul.md')?.content.toString()).toBe(DEFAULT_SOUL_CONTENT)
    } finally {
      db.close()
    }
  })

  it('preserves an existing soul.md on migration', () => {
    const adfPath = join(rootDir, 'custom.adf')
    const created = AdfDatabase.create(adfPath, { name: 'custom' })
    created.writeFile('soul.md', Buffer.from('# my own voice'), 'text/markdown', 'no_delete')
    created.close()

    const raw = new Database(adfPath)
    raw.prepare("UPDATE adf_meta SET value = '24' WHERE key = 'adf_schema_version'").run()
    raw.close()

    const db = AdfDatabase.open(adfPath)
    try {
      expect(db.getMeta('adf_schema_version')).toBe(String(ADF_LATEST_SCHEMA_VERSION))
      expect(db.readFile('soul.md')?.content.toString()).toBe('# my own voice')
    } finally {
      db.close()
    }
  })
})
