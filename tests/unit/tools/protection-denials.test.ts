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

type LogEntry = { level: string; origin: string | null; event: string | null; target: string | null; message: string }

function fileWorkspace(protection: 'read_only' | 'no_delete' | 'none') {
  const deleted: string[] = []
  const logs: LogEntry[] = []
  const ws = {
    getFileProtection: () => protection,
    deleteFile: (path: string) => { deleted.push(path); return true },
    readFile: () => 'old',
    fileExists: () => true,
    writeFile: () => {},
    getAgentConfig: () => ({ limits: {} }),
    insertLog: (level: string, origin: string | null, event: string | null, target: string | null, message: string) => {
      logs.push({ level, origin, event, target, message })
    },
  } as unknown as AdfWorkspace
  return { ws, deleted, logs }
}

function metaWorkspace(protection: 'readonly' | 'increment' | null, current = '5') {
  const writes: Array<{ key: string; value: string }> = []
  const deletes: string[] = []
  const logs: LogEntry[] = []
  const ws = {
    getMetaProtection: () => protection,
    getMeta: () => current,
    setMeta: (key: string, value: string) => { writes.push({ key, value }) },
    deleteMeta: (key: string) => { deletes.push(key); return true },
    insertLog: (level: string, origin: string | null, event: string | null, target: string | null, message: string) => {
      logs.push({ level, origin, event, target, message })
    },
  } as unknown as AdfWorkspace
  return { ws, writes, deletes, logs }
}

describe('fs_delete protection denials', () => {
  it('no_delete denial carries structured protection', async () => {
    const { ws } = fileWorkspace('no_delete')
    const result = await new FsDeleteTool().execute({ path: 'mind.md' }, ws)
    expect(result.isError).toBe(true)
    expect(result.protection).toEqual({ kind: 'file_protection', target: 'mind.md', level: 'no_delete', description: 'Delete "mind.md" — file is protected (no_delete)' })
  })

  it('read_only denial carries structured protection', async () => {
    const { ws } = fileWorkspace('read_only')
    const result = await new FsDeleteTool().execute({ path: 'a.txt' }, ws)
    expect(result.isError).toBe(true)
    expect(result.protection).toEqual({ kind: 'file_protection', target: 'a.txt', level: 'read_only', description: 'Delete "a.txt" — file is protected (read_only)' })
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
    expect(result.protection).toEqual({ kind: 'file_protection', target: 'a.txt', level: 'read_only', description: 'Overwrite "a.txt" — file is read-only' })
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
    expect(result.protection).toEqual({ kind: 'meta_protection', target: 'k', level: 'readonly', description: 'Set meta "k" — key is readonly' })
  })

  it('increment decrease denial carries structured protection', async () => {
    const { ws } = metaWorkspace('increment', '5')
    const result = await new SysSetMetaTool().execute({ key: 'k', value: '3' }, ws)
    expect(result.isError).toBe(true)
    expect(result.protection).toEqual({ kind: 'meta_protection', target: 'k', level: 'increment', description: 'Update meta "k" — must increase (current 5)' })
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
    expect(result.protection).toEqual({ kind: 'meta_protection', target: 'k', level: 'readonly', description: 'Delete meta "k" — key is protected (readonly)' })
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

function configWorkspace(config: AgentConfig, logs: LogEntry[] = []): AdfWorkspace {
  return {
    getAgentConfig: () => config,
    setAgentConfig: (c: AgentConfig) => { Object.assign(config, c) },
    insertLog: (level: string, origin: string | null, event: string | null, target: string | null, message: string) => {
      logs.push({ level, origin, event, target, message })
    }
  } as unknown as AdfWorkspace
}

describe('sys_update_config protection denials', () => {
  it('locked_fields denial carries config_lock protection', async () => {
    const config = makeConfig({ locked_fields: ['description'] })
    const result = await new SysUpdateConfigTool().execute({ path: 'description', value: 'x' }, configWorkspace(config))
    expect(result.isError).toBe(true)
    expect(result.protection).toEqual({ kind: 'config_lock', target: 'description', level: 'locked_fields', description: 'Set "description" to "x" — changing a locked setting' })
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

// =============================================================================
// description on the denial (rendered as the HIL approval title)
// =============================================================================

describe('ProtectionDenial.description (human-facing title)', () => {
  it('fs_delete describes the blocked delete without changing content', async () => {
    const { ws } = fileWorkspace('no_delete')
    const r = await new FsDeleteTool().execute({ path: 'mind.md' }, ws)
    expect(r.protection?.description).toBe('Delete "mind.md" — file is protected (no_delete)')
    expect(r.content).toBe('Cannot delete "mind.md": file is protected (no_delete).')
  })

  it('fs_write describes the blocked overwrite without changing content', async () => {
    const { ws } = fileWorkspace('read_only')
    const r = await new FsWriteTool().execute({ mode: 'write', path: 'a.txt', content: 'x' }, ws)
    expect(r.protection?.description).toBe('Overwrite "a.txt" — file is read-only')
    expect(r.content).toBe('Cannot write to "a.txt": file is read-only.')
  })

  it('sys_set_meta describes readonly and increment denials', async () => {
    const ro = await new SysSetMetaTool().execute({ key: 'k', value: 'v' }, metaWorkspace('readonly').ws)
    expect(ro.protection?.description).toBe('Set meta "k" — key is readonly')
    const inc = await new SysSetMetaTool().execute({ key: 'k', value: '3' }, metaWorkspace('increment', '5').ws)
    expect(inc.protection?.description).toBe('Update meta "k" — must increase (current 5)')
  })

  it('sys_delete_meta describes the protected-key delete', async () => {
    const { ws } = metaWorkspace('readonly')
    const r = await new SysDeleteMetaTool().execute({ key: 'k' }, ws)
    expect(r.protection?.description).toBe('Delete meta "k" — key is protected (readonly)')
  })

  it('sys_update_config describes a locked_fields change', async () => {
    const config = makeConfig({ locked_fields: ['description'] })
    const r = await new SysUpdateConfigTool().execute({ path: 'description', value: 'x' }, configWorkspace(config))
    expect(r.protection?.description).toBe('Set "description" to "x" — changing a locked setting')
  })

  it('sys_update_config names the concrete toggle for a locked tool enable', async () => {
    const config = makeConfig()
    config.tools = config.tools.map(t => t.name === 'fs_delete' ? { ...t, locked: true } : t)
    const r = await new SysUpdateConfigTool().execute({ path: 'tools.fs_delete.enabled', value: true }, configWorkspace(config))
    expect(r.protection?.description).toBe('Enable tools.fs_delete — changing a locked setting')
  })
})

// =============================================================================
// No Secrets: an authorized/override bypass of a REAL protection audits + marks
// =============================================================================

describe('protection-bypass audit + visible marker', () => {
  it('authorized delete of a protected file audits and marks; content unchanged otherwise', async () => {
    const { ws, deleted, logs } = fileWorkspace('no_delete')
    const r = await new FsDeleteTool().execute({ path: 'mind.md', _authorized: true }, ws)
    expect(r.isError).toBe(false)
    expect(deleted).toEqual(['mind.md'])
    expect(r.content).toContain('⚠ protection override: no_delete, authorized')
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ level: 'warn', origin: 'protection', target: 'mind.md' })
    expect(logs[0].message).toContain('authorized code bypass')
  })

  it('override delete audits as human-approved', async () => {
    const { ws, logs } = fileWorkspace('read_only')
    const r = await new FsDeleteTool().execute({ path: 'a.txt', _protection_override: true }, ws)
    expect(r.content).toContain('human-approved')
    expect(logs[0].message).toContain('human-approved override')
  })

  it('deleting an UNPROTECTED file emits no marker and no audit noise', async () => {
    const { ws, logs } = fileWorkspace('none')
    const r = await new FsDeleteTool().execute({ path: 'x.txt', _authorized: true }, ws)
    expect(r.isError).toBe(false)
    expect(r.content).toBe('Deleted "x.txt".')
    expect(logs).toHaveLength(0)
  })

  it('authorized write to a read_only file audits + marks', async () => {
    const { ws, logs } = fileWorkspace('read_only')
    const r = await new FsWriteTool().execute({ mode: 'write', path: 'a.txt', content: 'x', _authorized: true }, ws)
    expect(r.isError).toBe(false)
    expect(r.content).toContain('⚠ protection override: read_only, authorized')
    expect(logs).toHaveLength(1)
    expect(logs[0].origin).toBe('protection')
  })

  it('unprotected write emits neither marker nor audit', async () => {
    const { ws, logs } = fileWorkspace('none')
    const r = await new FsWriteTool().execute({ mode: 'write', path: 'a.txt', content: 'x', _authorized: true }, ws)
    expect(r.isError).toBe(false)
    expect(r.content).not.toContain('protection override')
    expect(logs).toHaveLength(0)
  })

  it('override write to readonly meta audits + marks', async () => {
    const { ws, writes, logs } = metaWorkspace('readonly')
    const r = await new SysSetMetaTool().execute({ key: 'k', value: 'v', _protection_override: true }, ws)
    expect(r.isError).toBe(false)
    expect(writes).toEqual([{ key: 'k', value: 'v' }])
    expect(r.content).toContain('⚠ protection override: readonly, human-approved')
    expect(logs).toHaveLength(1)
  })

  it('override delete of protected meta audits + marks', async () => {
    const { ws, deletes, logs } = metaWorkspace('increment')
    const r = await new SysDeleteMetaTool().execute({ key: 'k', _protection_override: true }, ws)
    expect(deletes).toEqual(['k'])
    expect(r.content).toContain('⚠ protection override: increment, human-approved')
    expect(logs).toHaveLength(1)
  })

  it('override of a locked config field audits + marks the result', async () => {
    const config = makeConfig({ locked_fields: ['description'] })
    const logs: LogEntry[] = []
    const r = await new SysUpdateConfigTool().execute(
      { path: 'description', value: 'new', _protection_override: true }, configWorkspace(config, logs)
    )
    expect(r.isError).toBe(false)
    expect(config.description).toBe('new')
    expect(r.content).toContain('⚠ protection override: locked_fields, human-approved')
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ level: 'warn', origin: 'protection' })
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
