/**
 * Structured protection denials — the foundation of the protection→HIL flow.
 *
 * Every data-protection denial (file read_only/no_delete, meta
 * readonly/increment, config locks) must carry a `protection` field so the
 * executor/shell/sandbox can start a HIL override approval, and every tool
 * must honor the one-time `_protection_override` bypass. Hard boundaries
 * (DENIED_PATHS, lock self-protection) must stay plain errors with NO
 * protection field — they are never human-overridable.
 */

import { describe, it, expect } from 'vitest'
import { FsDeleteTool } from '../../../src/main/tools/built-in/fs-delete.tool'
import { FsWriteTool } from '../../../src/main/tools/built-in/fs-write.tool'
import { SysSetMetaTool } from '../../../src/main/tools/built-in/sys-set-meta.tool'
import { SysDeleteMetaTool } from '../../../src/main/tools/built-in/sys-delete-meta.tool'
import { SysUpdateConfigTool } from '../../../src/main/tools/built-in/sys-update-config.tool'
import { ToolRegistry } from '../../../src/main/tools/tool-registry'
import type { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import type { AgentConfig } from '../../../src/shared/types/adf-v02.types'
import { AGENT_DEFAULTS, DEFAULT_TOOLS } from '../../../src/shared/types/adf-v02.types'

function fileWorkspace(protection: 'read_only' | 'no_delete' | 'none') {
  const deleted: string[] = []
  const ws = {
    getFileProtection: () => protection,
    deleteFile: (path: string) => { deleted.push(path); return true },
    readFile: () => 'old',
    fileExists: () => true,
    writeFile: () => {},
    insertLog: () => {},
  } as unknown as AdfWorkspace
  return { ws, deleted }
}

function metaWorkspace(protection: 'readonly' | 'increment' | null, current = '5') {
  const writes: Array<{ key: string; value: string }> = []
  const deletes: string[] = []
  const ws = {
    getMetaProtection: () => protection,
    getMeta: () => current,
    setMeta: (key: string, value: string) => { writes.push({ key, value }) },
    deleteMeta: (key: string) => { deletes.push(key); return true },
  } as unknown as AdfWorkspace
  return { ws, writes, deletes }
}

describe('fs_delete protection denials', () => {
  it('no_delete denial carries structured protection', async () => {
    const { ws } = fileWorkspace('no_delete')
    const result = await new FsDeleteTool().execute({ path: 'mind.md' }, ws)
    expect(result.isError).toBe(true)
    expect(result.protection).toEqual({ kind: 'file_protection', target: 'mind.md', level: 'no_delete' })
  })

  it('read_only denial carries structured protection', async () => {
    const { ws } = fileWorkspace('read_only')
    const result = await new FsDeleteTool().execute({ path: 'a.txt' }, ws)
    expect(result.isError).toBe(true)
    expect(result.protection).toEqual({ kind: 'file_protection', target: 'a.txt', level: 'read_only' })
  })

  it('_protection_override bypasses the protection', async () => {
    const { ws, deleted } = fileWorkspace('no_delete')
    const result = await new FsDeleteTool().execute({ path: 'mind.md', _protection_override: true }, ws)
    expect(result.isError).toBe(false)
    expect(deleted).toEqual(['mind.md'])
  })

  it('_authorized still bypasses (unchanged)', async () => {
    const { ws, deleted } = fileWorkspace('no_delete')
    const result = await new FsDeleteTool().execute({ path: 'mind.md', _authorized: true }, ws)
    expect(result.isError).toBe(false)
    expect(deleted).toEqual(['mind.md'])
  })
})

describe('fs_write protection denials', () => {
  it('read_only denial carries structured protection', async () => {
    const { ws } = fileWorkspace('read_only')
    const result = await new FsWriteTool().execute({ mode: 'write', path: 'a.txt', content: 'x' }, ws)
    expect(result.isError).toBe(true)
    expect(result.protection).toEqual({ kind: 'file_protection', target: 'a.txt', level: 'read_only' })
  })

  it('_protection_override bypasses read_only', async () => {
    const written: string[] = []
    const ws = {
      getFileProtection: () => 'read_only',
      getAgentConfig: () => ({ limits: {} }),
      fileExists: () => false,
      writeFile: (path: string) => { written.push(path) },
      readFile: () => null,
      insertLog: () => {},
    } as unknown as AdfWorkspace
    const result = await new FsWriteTool().execute({ mode: 'write', path: 'a.txt', content: 'x', _protection_override: true }, ws)
    expect(result.isError).toBe(false)
  })
})

describe('sys_set_meta protection denials', () => {
  it('readonly denial carries structured protection', async () => {
    const { ws } = metaWorkspace('readonly')
    const result = await new SysSetMetaTool().execute({ key: 'k', value: 'v' }, ws)
    expect(result.isError).toBe(true)
    expect(result.protection).toEqual({ kind: 'meta_protection', target: 'k', level: 'readonly' })
  })

  it('increment decrease denial carries structured protection', async () => {
    const { ws } = metaWorkspace('increment', '5')
    const result = await new SysSetMetaTool().execute({ key: 'k', value: '3' }, ws)
    expect(result.isError).toBe(true)
    expect(result.protection).toEqual({ kind: 'meta_protection', target: 'k', level: 'increment' })
  })

  it('increment non-numeric denial stays plain (not overridable)', async () => {
    const { ws } = metaWorkspace('increment', '5')
    const result = await new SysSetMetaTool().execute({ key: 'k', value: 'abc' }, ws)
    expect(result.isError).toBe(true)
    expect(result.protection).toBeUndefined()
  })

  it('_protection_override bypasses readonly and increment-decrease', async () => {
    const ro = metaWorkspace('readonly')
    const r1 = await new SysSetMetaTool().execute({ key: 'k', value: 'v', _protection_override: true }, ro.ws)
    expect(r1.isError).toBe(false)
    expect(ro.writes).toEqual([{ key: 'k', value: 'v' }])

    const inc = metaWorkspace('increment', '5')
    const r2 = await new SysSetMetaTool().execute({ key: 'k', value: '3', _protection_override: true }, inc.ws)
    expect(r2.isError).toBe(false)
    expect(inc.writes).toEqual([{ key: 'k', value: '3' }])
  })

  it('_protection_override does NOT allow non-numeric values on increment keys', async () => {
    const { ws } = metaWorkspace('increment', '5')
    const result = await new SysSetMetaTool().execute({ key: 'k', value: 'abc', _protection_override: true }, ws)
    expect(result.isError).toBe(true)
  })
})

describe('sys_delete_meta protection denials', () => {
  it('protected-key denial carries structured protection', async () => {
    const { ws } = metaWorkspace('readonly')
    const result = await new SysDeleteMetaTool().execute({ key: 'k' }, ws)
    expect(result.isError).toBe(true)
    expect(result.protection).toEqual({ kind: 'meta_protection', target: 'k', level: 'readonly' })
  })

  it('_protection_override bypasses the protection', async () => {
    const { ws, deletes } = metaWorkspace('increment')
    const result = await new SysDeleteMetaTool().execute({ key: 'k', _protection_override: true }, ws)
    expect(result.isError).toBe(false)
    expect(deletes).toEqual(['k'])
  })
})

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    adf_version: '0.2',
    id: 'test-agent',
    name: 'Test',
    description: 'test',
    state: 'active',
    autonomous: false,
    instructions: '',
    model: { ...AGENT_DEFAULTS.model, provider: 'anthropic', model_id: 'test' },
    context: {},
    tools: [...DEFAULT_TOOLS],
    triggers: JSON.parse(JSON.stringify(AGENT_DEFAULTS.triggers)),
    security: { ...AGENT_DEFAULTS.security },
    limits: { ...AGENT_DEFAULTS.limits },
    messaging: { ...AGENT_DEFAULTS.messaging },
    metadata: { created_at: '', updated_at: '' },
    ...overrides
  } as AgentConfig
}

function configWorkspace(config: AgentConfig): AdfWorkspace {
  return {
    getAgentConfig: () => config,
    setAgentConfig: (c: AgentConfig) => { Object.assign(config, c) }
  } as unknown as AdfWorkspace
}

describe('sys_update_config protection denials', () => {
  it('locked_fields denial carries config_lock protection', async () => {
    const config = makeConfig({ locked_fields: ['description'] })
    const result = await new SysUpdateConfigTool().execute({ path: 'description', value: 'x' }, configWorkspace(config))
    expect(result.isError).toBe(true)
    expect(result.protection).toEqual({ kind: 'config_lock', target: 'description', level: 'locked_fields' })
  })

  it('locked: true item denial carries config_lock protection', async () => {
    const config = makeConfig()
    config.tools = config.tools.map(t => t.name === 'fs_read' ? { ...t, locked: true } : t)
    const result = await new SysUpdateConfigTool().execute({ path: 'tools.fs_read.enabled', value: false }, configWorkspace(config))
    expect(result.isError).toBe(true)
    expect(result.protection?.kind).toBe('config_lock')
    expect(result.protection?.level).toBe('locked')
  })

  it('_protection_override bypasses locked_fields', async () => {
    const config = makeConfig({ locked_fields: ['description'] })
    const result = await new SysUpdateConfigTool().execute(
      { path: 'description', value: 'new', _protection_override: true }, configWorkspace(config)
    )
    expect(result.isError).toBe(false)
    expect(config.description).toBe('new')
  })

  it('_protection_override bypasses locked array-element guard on remove', async () => {
    const config = makeConfig()
    const idx = config.tools.findIndex(t => t.name === 'fs_read')
    config.tools[idx] = { ...config.tools[idx], locked: true }
    const result = await new SysUpdateConfigTool().execute(
      { path: 'tools', action: 'remove', index: idx, _protection_override: true }, configWorkspace(config)
    )
    expect(result.isError).toBe(false)
    expect(config.tools.find(t => t.name === 'fs_read')).toBeUndefined()
  })

  it('_protection_override does NOT bypass DENIED_PATHS', async () => {
    const config = makeConfig()
    const result = await new SysUpdateConfigTool().execute(
      { path: 'id', value: 'new-id', _protection_override: true }, configWorkspace(config)
    )
    expect(result.isError).toBe(true)
    expect(result.protection).toBeUndefined()
  })

  it('_protection_override does NOT bypass lock self-protection', async () => {
    const config = makeConfig()
    const result = await new SysUpdateConfigTool().execute(
      { path: 'tools.fs_read.locked', value: false, _protection_override: true }, configWorkspace(config)
    )
    expect(result.isError).toBe(true)
    expect(result.protection).toBeUndefined()
  })

})

describe('ToolRegistry _protection_override plumbing', () => {
  it('strips the flag before schema validation and re-attaches it for the tool', async () => {
    const registry = new ToolRegistry()
    registry.register(new FsDeleteTool())
    const { ws, deleted } = fileWorkspace('no_delete')
    // If the registry failed to strip, zod would reject the unknown key; if it
    // failed to re-attach, the tool would deny. Success proves both.
    const result = await registry.executeTool('fs_delete', { path: 'mind.md', _protection_override: true }, ws)
    expect(result.isError).toBe(false)
    expect(deleted).toEqual(['mind.md'])
  })

  it('protection field flows through the registry on denial', async () => {
    const registry = new ToolRegistry()
    registry.register(new FsDeleteTool())
    const { ws } = fileWorkspace('no_delete')
    const result = await registry.executeTool('fs_delete', { path: 'mind.md' }, ws)
    expect(result.isError).toBe(true)
    expect(result.protection?.kind).toBe('file_protection')
  })
})
