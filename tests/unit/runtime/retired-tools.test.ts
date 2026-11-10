/**
 * Old files still declare built-ins ADF stopped shipping long ago (peer_*,
 * plan, shell, …). `AdfDatabase.getConfig()` strips them from the host and
 * from every loop's allow-list, renames msg_list_agents, and leaves names it
 * does not recognise (another runtime's tools) alone.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import Database from 'better-sqlite3'
import { AdfDatabase } from '../../../src/main/adf/adf-database'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

type Decl = { name: string; enabled: boolean; visible?: boolean }

function seed(patch: (cfg: { tools: Decl[]; loops?: unknown[] }) => void): string {
  const dir = mkdtempSync(join(tmpdir(), 'adf-retired-tools-'))
  dirs.push(dir)
  const adfPath = join(dir, 'old.adf')
  AdfDatabase.create(adfPath, { name: 'old' }).close()

  const raw = new Database(adfPath)
  const row = raw.prepare('SELECT config_json FROM adf_config WHERE id = 1').get() as { config_json: string }
  const cfg = JSON.parse(row.config_json)
  patch(cfg)
  raw.prepare('UPDATE adf_config SET config_json = ? WHERE id = 1').run(JSON.stringify(cfg))
  raw.close()
  return adfPath
}

function storedConfig(adfPath: string): { tools: Decl[]; loops?: { tools?: string[] }[] } {
  const raw = new Database(adfPath, { readonly: true })
  const row = raw.prepare('SELECT config_json FROM adf_config WHERE id = 1').get() as { config_json: string }
  raw.close()
  return JSON.parse(row.config_json)
}

describe('retired built-in tools', () => {
  it('strips them from the host and loops, persisted, and keeps unknown names', () => {
    const adfPath = seed((cfg) => {
      cfg.tools.push(
        { name: 'peer_save', enabled: true, visible: true },
        { name: 'plan', enabled: true, visible: true },
        { name: 'shell', enabled: false, visible: false },
        { name: 'other_runtime_tool', enabled: true, visible: true },
      )
      cfg.loops = [{ name: 'critic', goal: 'disagree', enabled: true, tools: ['plan', 'fs_read', 'peer_get', 'loop_send', 'loop_list'] }]
    })

    const db = AdfDatabase.open(adfPath)
    try {
      const names = db.getConfig().tools.map((t) => t.name)
      expect(names).not.toContain('peer_save')
      expect(names).not.toContain('plan')
      expect(names).not.toContain('shell')
      expect(names).toContain('other_runtime_tool')
      expect(names).toContain('fs_read')
    } finally {
      db.close()
    }

    const stored = storedConfig(adfPath)
    expect(stored.tools.map((t) => t.name)).not.toContain('peer_save')
    expect(stored.loops?.[0].tools).toEqual(['fs_read', 'loop_send', 'loop_list'])
  })

  it('renames msg_list_agents, keeping the owner flags, unless agent_discover is already declared', () => {
    const renamed = seed((cfg) => {
      cfg.tools = cfg.tools.filter((t) => t.name !== 'agent_discover')
      cfg.tools.push({ name: 'msg_list_agents', enabled: false, visible: false })
    })
    let db = AdfDatabase.open(renamed)
    try {
      const tools = db.getConfig().tools
      expect(tools.find((t) => t.name === 'msg_list_agents')).toBeUndefined()
      expect(tools.filter((t) => t.name === 'agent_discover')).toEqual([{ name: 'agent_discover', enabled: false, visible: false }])
    } finally {
      db.close()
    }

    const both = seed((cfg) => {
      cfg.tools.push({ name: 'msg_list_agents', enabled: false, visible: false })
    })
    db = AdfDatabase.open(both)
    try {
      const tools = db.getConfig().tools
      expect(tools.find((t) => t.name === 'msg_list_agents')).toBeUndefined()
      expect(tools.filter((t) => t.name === 'agent_discover')).toHaveLength(1)
      expect(tools.find((t) => t.name === 'agent_discover')?.enabled).toBe(true)
    } finally {
      db.close()
    }
  })
})
