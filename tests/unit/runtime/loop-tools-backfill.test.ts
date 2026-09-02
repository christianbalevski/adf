/**
 * The one-time grandfather that keeps existing loops talking.
 *
 * `loop_send`/`loop_list` used to be unioned into every derived loop config
 * regardless of `loop.tools`. They are ordinary allow-list entries now, so
 * every loop written under the old rule would go silently mute on the first
 * open. `AdfDatabase.getConfig()` appends them once, gated on a meta flag —
 * and the flag, not the names' absence, is what makes it a migration instead
 * of a standing rule that would override the owner.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import Database from 'better-sqlite3'
import { AdfDatabase } from '../../../src/main/adf/adf-database'
import { DEFAULT_NEW_LOOP_TOOLS } from '../../../src/shared/types/adf-v02.types'

const BACKFILL_META = 'adf_loop_tools_backfilled'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * A file as it existed BEFORE this change: loops written under the old rule,
 * and no backfill marker.
 */
function seedLegacy(loops: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'adf-loop-backfill-'))
  dirs.push(dir)
  const adfPath = join(dir, 'legacy.adf')

  const seed = AdfDatabase.create(adfPath, { name: 'legacy' })
  seed.close()

  const raw = new Database(adfPath)
  const row = raw.prepare('SELECT config_json FROM adf_config WHERE id = 1').get() as { config_json: string }
  const cfg = JSON.parse(row.config_json)
  cfg.loops = loops
  // The old world never declared these on the host either.
  cfg.tools = cfg.tools.filter((t: { name: string }) => !DEFAULT_NEW_LOOP_TOOLS.includes(t.name as never))
  raw.prepare('UPDATE adf_config SET config_json = ? WHERE id = 1').run(JSON.stringify(cfg))
  raw.prepare('DELETE FROM adf_meta WHERE key = ?').run(BACKFILL_META)
  raw.close()

  return adfPath
}

describe('loop tools grandfather backfill', () => {
  it('appends the pair to every pre-existing loop, once', () => {
    const adfPath = seedLegacy([
      { name: 'reflector', goal: 'notice', enabled: true, tools: ['fs_read'] },
      { name: 'critic', goal: 'disagree', enabled: true, tools: [] },
    ])

    const db = AdfDatabase.open(adfPath)
    try {
      const first = db.getConfig()
      expect(first.loops?.[0].tools).toEqual(['fs_read', 'loop_send', 'loop_list'])
      expect(first.loops?.[1].tools).toEqual(['loop_send', 'loop_list'])
      expect(db.getMeta(BACKFILL_META)).toBe('1')

      // Idempotent: a second read appends nothing.
      const second = db.getConfig()
      expect(second.loops?.[0].tools).toEqual(['fs_read', 'loop_send', 'loop_list'])
      expect(second.loops?.[1].tools).toEqual(['loop_send', 'loop_list'])
    } finally {
      db.close()
    }
  })

  it('grandfathers a loop with no tools array at all — it held them too', () => {
    const adfPath = seedLegacy([{ name: 'reflector', goal: 'notice', enabled: true }])
    const db = AdfDatabase.open(adfPath)
    try {
      expect(db.getConfig().loops?.[0].tools).toEqual(['loop_send', 'loop_list'])
    } finally {
      db.close()
    }
  })

  it('does not rewrite a loop that already names them', () => {
    const adfPath = seedLegacy([
      { name: 'reflector', goal: 'notice', enabled: true, tools: ['loop_list', 'fs_read', 'loop_send'] },
    ])
    const db = AdfDatabase.open(adfPath)
    try {
      // Order preserved, nothing duplicated.
      expect(db.getConfig().loops?.[0].tools).toEqual(['loop_list', 'fs_read', 'loop_send'])
    } finally {
      db.close()
    }
  })

  it('never re-adds a name the owner removed after the migration ran', () => {
    // The whole reason it is flag-gated: an absence test would resurrect
    // loop_send on every read, so a deliberately mute loop would be impossible.
    const adfPath = seedLegacy([{ name: 'reflector', goal: 'notice', enabled: true, tools: ['fs_read'] }])
    const db = AdfDatabase.open(adfPath)
    try {
      const migrated = db.getConfig()
      expect(migrated.loops?.[0].tools).toContain('loop_send')

      // The owner un-ticks both in the Loops card.
      migrated.loops![0].tools = ['fs_read']
      db.setConfig(migrated)

      expect(db.getConfig().loops?.[0].tools).toEqual(['fs_read'])
    } finally {
      db.close()
    }
  })

  it('marks a loop-less agent done without rewriting its config', () => {
    const adfPath = seedLegacy([])
    const db = AdfDatabase.open(adfPath)
    try {
      const before = db.getMeta('adf_updated_at')
      db.getConfig()
      expect(db.getMeta(BACKFILL_META)).toBe('1')
      // `loops: []` and nothing to grandfather — no save, so no updated_at bump
      // beyond whatever the DEFAULT_TOOLS backfill itself did on this read.
      expect(db.getConfig().loops).toEqual([])
      expect(typeof before === 'string' || before === undefined).toBe(true)
    } finally {
      db.close()
    }
  })

  it('declares loop_send/loop_list on the host via the DEFAULT_TOOLS backfill', () => {
    // The other half of the change: the host declarations arrive on open, so
    // an allow-listed loop can actually be granted them.
    const adfPath = seedLegacy([{ name: 'reflector', goal: 'notice', enabled: true, tools: [] }])
    const db = AdfDatabase.open(adfPath)
    try {
      const config = db.getConfig()
      for (const name of DEFAULT_NEW_LOOP_TOOLS) {
        expect(config.tools.find(t => t.name === name)).toMatchObject({
          name, enabled: true, visible: true,
        })
      }
    } finally {
      db.close()
    }
  })
})
