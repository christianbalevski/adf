import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import Database from 'better-sqlite3'
import { AdfDatabase, ADF_LATEST_SCHEMA_VERSION } from '../../src/main/adf/adf-database'

let rootDir: string

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'adf-v30-migration-'))
})

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true })
})

/** Create an agent, then rewind it to v29 with the given config patch applied. */
function makeV29(name: string, patch: (cfg: Record<string, unknown>) => void): string {
  const adfPath = join(rootDir, `${name}.adf`)
  AdfDatabase.create(adfPath, { name }).close()
  const raw = new Database(adfPath)
  const row = raw.prepare('SELECT config_json FROM adf_config WHERE id = 1').get() as { config_json: string }
  const cfg = JSON.parse(row.config_json)
  patch(cfg)
  raw.prepare('UPDATE adf_config SET config_json = ? WHERE id = 1').run(JSON.stringify(cfg))
  raw.prepare("UPDATE adf_meta SET value = '29' WHERE key = 'adf_schema_version'").run()
  raw.close()
  return adfPath
}

describe('v29 → v30: bare_prompt no longer gates dynamic instructions', () => {
  it('ticks all four dynamic-instruction checkboxes off for an agent that was bare', () => {
    // Pre-v30, bare implied "no per-turn injections". Preserving that means
    // writing the equivalent checkbox state, since bare no longer implies it.
    const adfPath = makeV29('bare', (cfg) => {
      cfg.bare_prompt = true
      cfg.context = { ...(cfg.context as object), dynamic_instructions: { inbox_hints: true } }
    })
    const db = AdfDatabase.open(adfPath)
    try {
      expect(db.getMeta('adf_schema_version')).toBe(String(ADF_LATEST_SCHEMA_VERSION))
      const cfg = db.getConfig()
      expect(cfg.bare_prompt).toBe(true)
      expect(cfg.context.dynamic_instructions).toEqual({
        inbox_hints: false,
        context_warning: false,
        idle_reminder: false,
        mesh_updates: false
      })
    } finally {
      db.close()
    }
  })

  it('leaves a non-bare agent’s checkboxes exactly as they were', () => {
    const adfPath = makeV29('full', (cfg) => {
      cfg.context = { ...(cfg.context as object), dynamic_instructions: { mesh_updates: false } }
    })
    const db = AdfDatabase.open(adfPath)
    try {
      expect(db.getMeta('adf_schema_version')).toBe(String(ADF_LATEST_SCHEMA_VERSION))
      expect(db.getConfig().context.dynamic_instructions).toEqual({ mesh_updates: false })
    } finally {
      db.close()
    }
  })

  it('is a no-op for a fresh file already at the latest version', () => {
    const adfPath = join(rootDir, 'fresh.adf')
    const created = AdfDatabase.create(adfPath, { name: 'fresh' })
    const before = created.getConfig().context.dynamic_instructions
    created.close()
    const db = AdfDatabase.open(adfPath)
    try {
      expect(db.getConfig().context.dynamic_instructions).toEqual(before)
    } finally {
      db.close()
    }
  })
})
