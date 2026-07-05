import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import Database from 'better-sqlite3'
import { AdfDatabase } from '../../src/main/adf/adf-database'

describe('v22 → v23 config conformance migration', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function newAdf(name: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'adf-conformance-'))
    dirs.push(dir)
    return join(dir, `${name}.adf`)
  }

  it('creates new agents at schema v23', () => {
    const adfPath = newAdf('fresh')
    const db = AdfDatabase.create(adfPath, { name: 'fresh' })
    try {
      expect(db.getMeta('adf_schema_version')).toBe('23')
    } finally {
      db.close()
    }
  })

  it('strips max_loop_messages and folds thinking_budget on open of a v22 file', () => {
    const adfPath = newAdf('legacy')
    const seed = AdfDatabase.create(adfPath, { name: 'legacy' })
    seed.close()

    // Recreate legacy v22 on-disk state with both deprecated keys present
    const raw = new Database(adfPath)
    const cfgRow = raw.prepare('SELECT config_json FROM adf_config WHERE id = 1').get() as { config_json: string }
    const cfg = JSON.parse(cfgRow.config_json)
    cfg.model.max_loop_messages = 100
    cfg.model.thinking_budget = 4096
    delete cfg.model.reasoning
    cfg.context = { ...cfg.context, max_loop_messages: 300 }
    cfg.limits = { ...cfg.limits, max_loop_rows: 500, max_daily_budget_usd: 10 }
    raw.prepare('UPDATE adf_config SET config_json = ? WHERE id = 1').run(JSON.stringify(cfg))
    raw.prepare("UPDATE adf_meta SET value = '22' WHERE key = 'adf_schema_version'").run()
    raw.close()

    const db = AdfDatabase.open(adfPath)
    try {
      expect(db.getMeta('adf_schema_version')).toBe('23')
      const migrated = db.getConfig() as Record<string, any>
      expect('max_loop_messages' in migrated.model).toBe(false)
      expect('max_loop_messages' in migrated.context).toBe(false)
      expect('max_loop_rows' in migrated.limits).toBe(false)
      expect('max_daily_budget_usd' in migrated.limits).toBe(false)
      // thinking_budget folded into reasoning, then dropped
      expect('thinking_budget' in migrated.model).toBe(false)
      expect(migrated.model.reasoning).toEqual({ enabled: true, max_tokens: 4096 })
    } finally {
      db.close()
    }
  })

  it('hardens identity meta keys to readonly on open', () => {
    const adfPath = newAdf('identity')
    const seed = AdfDatabase.create(adfPath, { name: 'identity' })
    seed.close()

    // Recreate legacy state: identity keys written with protection 'none'
    const raw = new Database(adfPath)
    for (const key of ['adf_did', 'adf_owner_did', 'adf_runtime_did']) {
      raw.prepare("INSERT OR REPLACE INTO adf_meta (key, value, protection) VALUES (?, 'did:adf:test', 'none')").run(key)
    }
    raw.close()

    const db = AdfDatabase.open(adfPath)
    try {
      for (const key of ['adf_did', 'adf_owner_did', 'adf_runtime_did']) {
        expect(db.getMetaProtection(key)).toBe('readonly')
        expect(db.getMeta(key)).toBe('did:adf:test')
      }
    } finally {
      db.close()
    }
  })

  it('does not overwrite an existing reasoning config when folding', () => {
    const adfPath = newAdf('reasoning')
    const seed = AdfDatabase.create(adfPath, { name: 'reasoning' })
    seed.close()

    const raw = new Database(adfPath)
    const cfgRow = raw.prepare('SELECT config_json FROM adf_config WHERE id = 1').get() as { config_json: string }
    const cfg = JSON.parse(cfgRow.config_json)
    cfg.model.reasoning = { enabled: true, effort: 'high' }
    cfg.model.thinking_budget = 4096
    raw.prepare('UPDATE adf_config SET config_json = ? WHERE id = 1').run(JSON.stringify(cfg))
    raw.prepare("UPDATE adf_meta SET value = '22' WHERE key = 'adf_schema_version'").run()
    raw.close()

    const db = AdfDatabase.open(adfPath)
    try {
      const migrated = db.getConfig() as Record<string, any>
      // Existing reasoning config wins; legacy thinking_budget is left as-is
      // (still consumed by the executor's deprecated fallback path).
      expect(migrated.model.reasoning).toEqual({ enabled: true, effort: 'high' })
      expect(migrated.model.thinking_budget).toBe(4096)
    } finally {
      db.close()
    }
  })
})
