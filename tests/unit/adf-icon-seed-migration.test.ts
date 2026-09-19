import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import Database from 'better-sqlite3'
import { AdfDatabase, ADF_LATEST_SCHEMA_VERSION } from '../../src/main/adf/adf-database'
import { AGENT_ICON_POOL, pickAgentIcon } from '../../src/shared/constants/agent-icons'

let rootDir: string

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'adf-icon-migration-'))
})

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true })
})

function setIcon(adfPath: string, icon: string | undefined, version: string): void {
  const raw = new Database(adfPath)
  const row = raw.prepare('SELECT config_json FROM adf_config WHERE id = 1').get() as { config_json: string }
  const cfg = JSON.parse(row.config_json)
  if (icon === undefined) delete cfg.icon
  else cfg.icon = icon
  raw.prepare('UPDATE adf_config SET config_json = ? WHERE id = 1').run(JSON.stringify(cfg))
  raw.prepare("UPDATE adf_meta SET value = ? WHERE key = 'adf_schema_version'").run(version)
  raw.close()
}

describe('v30 → v31 icon seed migration', () => {
  it('new agents are created with an icon from the pool', () => {
    const db = AdfDatabase.create(join(rootDir, 'fresh.adf'), { name: 'fresh' })
    try {
      const cfg = db.getConfig()
      expect(AGENT_ICON_POOL).toContain(cfg.icon)
      expect(cfg.icon).toBe(pickAgentIcon(cfg.id))
    } finally {
      db.close()
    }
  })

  it('seeds the id-picked icon into a v30 agent that has none', () => {
    const adfPath = join(rootDir, 'legacy.adf')
    AdfDatabase.create(adfPath, { name: 'legacy' }).close()
    setIcon(adfPath, undefined, '30')

    const db = AdfDatabase.open(adfPath)
    try {
      const cfg = db.getConfig()
      expect(db.getMeta('adf_schema_version')).toBe(String(ADF_LATEST_SCHEMA_VERSION))
      expect(cfg.icon).toBe(pickAgentIcon(cfg.id))
    } finally {
      db.close()
    }
  })

  it('treats an empty-string icon as unset', () => {
    const adfPath = join(rootDir, 'blank.adf')
    AdfDatabase.create(adfPath, { name: 'blank' }).close()
    setIcon(adfPath, '', '30')

    const db = AdfDatabase.open(adfPath)
    try {
      const cfg = db.getConfig()
      expect(cfg.icon).toBe(pickAgentIcon(cfg.id))
    } finally {
      db.close()
    }
  })

  it('preserves an icon the owner already chose', () => {
    const adfPath = join(rootDir, 'custom.adf')
    AdfDatabase.create(adfPath, { name: 'custom' }).close()
    setIcon(adfPath, '🐋', '30')

    const db = AdfDatabase.open(adfPath)
    try {
      expect(db.getMeta('adf_schema_version')).toBe(String(ADF_LATEST_SCHEMA_VERSION))
      expect(db.getConfig().icon).toBe('🐋')
    } finally {
      db.close()
    }
  })
})
