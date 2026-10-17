import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AdfDatabase } from '../../../src/main/adf/adf-database'
import { mergeTemplateWithOverrides } from '../../../src/main/adf/adf-template'
import { DEFAULT_AGENT_CONFIG } from '../../../src/shared/constants/adf-defaults'
import type { CreateAgentOptions } from '../../../src/shared/types/adf-v02.types'

const directories: string[] = []
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('agent creation partial overrides', () => {
  it.each([false, true])('preserves inherited tool visibility and logging defaults (file template=%s)', (fileTemplate) => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-create-overrides-'))
    directories.push(dir)
    const tools = [{ name: 'fs_read', enabled: true, visible: false }]
    const overrides: CreateAgentOptions = {
      name: 'child',
      tools: [{ name: 'fs_read', enabled: false }, { name: 'custom_tool', enabled: true }],
      logging: { max_rows: 123 },
    }
    let options: CreateAgentOptions = { ...overrides, template: { tools } }
    if (fileTemplate) {
      const merged = mergeTemplateWithOverrides({ ...DEFAULT_AGENT_CONFIG, tools }, overrides)
      expect(merged.ok).toBe(true)
      if (!merged.ok) throw new Error(merged.error)
      options = merged.options
    }
    const db = AdfDatabase.create(join(dir, 'child.adf'), options)
    try {
      const config = db.getConfig()
      expect(config.tools.find(tool => tool.name === 'fs_read')).toMatchObject({ enabled: false, visible: false })
      expect(config.tools.find(tool => tool.name === 'custom_tool')).toMatchObject({ enabled: true, visible: true })
      expect(config.logging).toMatchObject({ ...DEFAULT_AGENT_CONFIG.logging, max_rows: 123 })
    } finally { db.close() }
  })
})
