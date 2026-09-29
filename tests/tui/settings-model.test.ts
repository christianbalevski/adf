import { describe, expect, it } from 'vitest'
import { DEFAULT_AGENT_CONFIG } from '../../src/shared/constants/adf-defaults'
import type { AgentConfig } from '../../src/main/tui/api/types'
import {
  buildToolRows, contextTokens, filterToolRows, hasHostAccess, mainThreshold, parseThreshold, setHostAccess, setInboxMode,
  setMainThreshold, setReceive, setSendMode, settingRows, toggleGroup, toggleSectionLock, toggleToolEnabled, toggleToolLock,
  toggleToolRestricted, toggleToolVisible, type GroupRow, type ToolRow, INSTRUCTIONS_LOCK_KEYS,
} from '../../src/main/tui/views/inspect/settings-model'

function config(patch: Partial<AgentConfig> = {}): AgentConfig {
  const base = JSON.parse(JSON.stringify(DEFAULT_AGENT_CONFIG)) as AgentConfig
  return { ...base, id: '6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f', name: 'agent-1', handle: 'agent-1', ...patch }
}

const ok = <T extends { ok: boolean }>(r: T) => { if (!r.ok) throw new Error(`expected ok: ${JSON.stringify(r)}`); return r as Extract<T, { ok: true }> }
const tool = (c: AgentConfig, name: string) => c.tools.find(t => t.name === name)!
/** No on_inbox trigger, no inbox mode: Studio greys out the Messaging and Inbox groups. */
const blocked = (c: AgentConfig): AgentConfig => ({ ...c, triggers: { ...(c.triggers as object), on_inbox: { enabled: false, targets: [] } } as never, messaging: { ...(c.messaging ?? { receive: true, mode: 'respond_only' }), inbox_mode: false } })

describe('settings model: tools', () => {
  it('groups tools like Studio, with MCP servers and an Other group', () => {
    const c = config({
      mcp: { servers: [{ name: 'github', transport: 'stdio', available_tools: [{ name: 'search', description: 'Search issues' }] }] } as unknown as AgentConfig['mcp'],
    })
    c.tools.push({ name: 'mcp_github_search', enabled: true, visible: true, restricted: true })
    const rows = buildToolRows(c)
    const groups = rows.filter((r): r is GroupRow => r.kind === 'group').map(r => r.label)
    expect(groups.slice(0, 3)).toEqual(['ADF Shell', 'Filesystem', 'System'])
    expect(groups).toContain('Other') // chat_info
    expect(groups.at(-1)).toBe('MCP github')
    const mcp = rows.find((r): r is ToolRow => r.kind === 'tool' && r.name === 'mcp_github_search')!
    expect(mcp).toMatchObject({ label: 'search', mcpServer: 'github', restricted: true, description: 'Search issues' })
    // Messaging needs the on_inbox trigger, like Studio's disabled group.
    const messaging = buildToolRows(blocked(c)).find((r): r is GroupRow => r.kind === 'group' && r.id === 'messaging')
    expect(messaging?.blocked ?? '').toMatch(/messaging/)
    // A catalog tool the config does not declare shows up disabled.
    const withCatalog = buildToolRows(c, [{ name: 'brand_new', enabled: false, visible: false, restricted: false, locked: false, source: 'builtin', description: 'New tool', schema: {}, restrictions: { restricted: false, locked: false } }])
    expect(withCatalog.find(r => r.kind === 'tool' && r.name === 'brand_new')).toMatchObject({ enabled: false, description: 'New tool' })
  })

  it('filters by name and keeps the group header', () => {
    const rows = filterToolRows(buildToolRows(config()), 'fs_del')
    expect(rows.map(r => (r.kind === 'group' ? `#${r.label}` : r.name))).toEqual(['#Filesystem', 'fs_delete'])
    expect(filterToolRows(buildToolRows(config()), 'timers').filter(r => r.kind === 'tool')).toHaveLength(3)
  })

  it('toggles like Studio: enabling shows it, locks block enable/show, turn tools have no approval', () => {
    const c = config()
    const enabled = ok(toggleToolEnabled(c, 'fs_delete'))
    expect(tool(enabled.config, 'fs_delete')).toMatchObject({ enabled: true, visible: true })
    expect(enabled.message).toBe('fs_delete enabled')
    const hidden = ok(toggleToolVisible(enabled.config, 'fs_delete'))
    expect(tool(hidden.config, 'fs_delete').visible).toBe(false)
    expect(toggleToolVisible(c, 'fs_delete')).toMatchObject({ ok: false, error: expect.stringMatching(/enable it first/) })
    const locked = ok(toggleToolLock(c, 'fs_read'))
    expect(tool(locked.config, 'fs_read').locked).toBe(true)
    expect(toggleToolEnabled(locked.config, 'fs_read')).toMatchObject({ ok: false, error: expect.stringMatching(/locked/) })
    // A locked built-in may still be gated (Studio), and unlocking clears the flag.
    expect(tool(ok(toggleToolRestricted(locked.config, 'fs_read')).config, 'fs_read').restricted).toBe(true)
    expect(tool(ok(toggleToolLock(locked.config, 'fs_read')).config, 'fs_read').locked).toBeUndefined()
    expect(toggleToolRestricted(c, 'say')).toMatchObject({ ok: false })
    const gated = ok(toggleToolRestricted(c, 'fs_write'))
    expect(tool(gated.config, 'fs_write').restricted).toBe(true)
    expect(tool(ok(toggleToolRestricted(gated.config, 'fs_write')).config, 'fs_write').restricted).toBeUndefined()
    // Only the named tool changes.
    const before = c.tools.filter(t => t.name !== 'fs_delete')
    expect(enabled.config.tools.filter(t => t.name !== 'fs_delete')).toEqual(before)
  })

  it('refuses enable/show in a blocked group and locks on MCP tools', () => {
    const c = blocked(config())
    expect(toggleToolEnabled(c, 'msg_send')).toMatchObject({ ok: false, error: expect.stringMatching(/needs messaging/) })
    c.mcp = { servers: [{ name: 'gh', transport: 'stdio', available_tools: [{ name: 'x' }] }] } as unknown as AgentConfig['mcp']
    c.tools.push({ name: 'mcp_gh_x', enabled: true, visible: true, locked: true })
    expect(toggleToolRestricted(c, 'mcp_gh_x')).toMatchObject({ ok: false })
    expect(toggleToolLock(c, 'mcp_gh_x')).toMatchObject({ ok: false })
  })

  it('bulk-toggles a group, skipping locked tools', () => {
    const c = config()
    c.tools = c.tools.map(t => (t.name === 'fs_read' ? { ...t, locked: true } : t))
    const off = ok(toggleGroup(c, 'fs', 'enabled'))
    // fs_delete was off (mixed) → the eligible ones all turn on.
    expect(['fs_write', 'fs_list', 'fs_delete'].map(n => tool(off.config, n).enabled)).toEqual([true, true, true])
    expect(tool(off.config, 'fs_read')).toEqual(tool(c, 'fs_read'))
    expect(off.message).toMatch(/3 tools enabled \(locked ones skipped\)/)
    const gated = ok(toggleGroup(off.config, 'fs', 'restricted'))
    expect(['fs_write', 'fs_list', 'fs_delete'].every(n => tool(gated.config, n).restricted)).toBe(true)
    expect(toggleGroup(c, 'turn', 'restricted')).toMatchObject({ ok: false })
    expect(toggleGroup(blocked(c), 'inbox', 'enabled')).toMatchObject({ ok: false, error: expect.stringMatching(/inbox mode/) })
  })
})

describe('settings model: compaction, messaging, host, locks', () => {
  it('parses thresholds like the schema: positive whole tokens, empty = default', () => {
    expect(parseThreshold('80000')).toEqual({ ok: true, value: 80000 })
    expect(parseThreshold('80k')).toEqual({ ok: true, value: 80000 })
    expect(parseThreshold('1.5m')).toEqual({ ok: true, value: 1_500_000 })
    expect(parseThreshold('120,000')).toEqual({ ok: true, value: 120000 })
    expect(parseThreshold('')).toEqual({ ok: true, value: null })
    expect(parseThreshold('default')).toEqual({ ok: true, value: null })
    expect(parseThreshold('0')).toEqual({ ok: true, value: null })
    expect(parseThreshold('-5').ok).toBe(false)
    expect(parseThreshold('12.5').ok).toBe(false)
    expect(parseThreshold('lots').ok).toBe(false)
    // A typo far past any context window (e.g. 80000 + 80k typed together) is refused.
    expect(parseThreshold('8000080k').ok).toBe(false)
    expect(parseThreshold('10m')).toEqual({ ok: true, value: 10_000_000 })
  })

  it('sets and clears main’s threshold without touching the rest of context', () => {
    const c = config()
    expect(mainThreshold(c)).toEqual({ value: 100_000, source: 'default' })
    const set = ok(setMainThreshold(c, 80_000))
    expect(set.config.context?.compact_threshold).toBe(80_000)
    expect(set.config.context?.dynamic_instructions).toEqual(c.context?.dynamic_instructions)
    expect(mainThreshold(set.config)).toEqual({ value: 80_000, source: 'context' })
    const cleared = ok(setMainThreshold(set.config, null))
    expect('compact_threshold' in (cleared.config.context ?? {})).toBe(false)
  })

  it('reads context in use from the newest entry with token usage', () => {
    expect(contextTokens([
      { seq: 1, role: 'assistant', content_json: [], created_at: 1, tokens: { input: 1000, cache_read: 500 } },
      { seq: 2, role: 'user', content_json: [], created_at: 2 },
    ] as never)).toBe(1500)
    expect(contextTokens([])).toBeNull()
  })

  it('messaging switches the messaging / inbox tools with it (Studio)', () => {
    const on = ok(setReceive(config(), true))
    expect(on.config.messaging?.receive).toBe(true)
    const inbox = ok(setInboxMode(on.config, true))
    expect(['msg_list', 'msg_read', 'msg_update'].every(n => tool(inbox.config, n).enabled && tool(inbox.config, n).visible)).toBe(true)
    const listen = ok(setSendMode(inbox.config, 'listen_only'))
    expect(tool(listen.config, 'msg_send').enabled).toBe(false)
    expect(tool(listen.config, 'agent_discover').enabled).toBe(false)
    const off = ok(setReceive(listen.config, false))
    expect(['msg_send', 'agent_discover', 'msg_list', 'msg_read', 'msg_update'].some(n => tool(off.config, n).enabled)).toBe(false)
    expect(setInboxMode(config({ messaging: { receive: false, mode: 'respond_only' } } as never), true).ok).toBe(false)
  })

  it('host access adds / removes the host compute target and keeps a default', () => {
    const c = config({ compute: { enabled: false } } as never)
    expect(hasHostAccess(c)).toBe(false)
    const on = ok(setHostAccess(c, true))
    expect(on.config.compute).toMatchObject({ host_access: true, allowed_targets: ['shared', 'host'], default_target: 'shared' })
    const off = ok(setHostAccess(on.config, false))
    expect(off.config.compute).toMatchObject({ host_access: false, allowed_targets: ['shared'] })
    expect(setHostAccess(config({ compute: { enabled: false, allowed_targets: ['host'], default_target: 'host' } } as never), false).ok).toBe(false)
  })

  it('section locks cover every key a section writes', () => {
    const locked = ok(toggleSectionLock(config(), INSTRUCTIONS_LOCK_KEYS, 'Instructions'))
    expect(locked.config.locked_fields).toEqual(expect.arrayContaining(INSTRUCTIONS_LOCK_KEYS))
    expect(settingRows(locked.config).find(r => r.id === 'instructions')?.locked).toBe(true)
    const unlocked = ok(toggleSectionLock(locked.config, INSTRUCTIONS_LOCK_KEYS, 'Instructions'))
    expect(unlocked.config.locked_fields ?? []).toEqual([])
  })

  it('lists the Settings rows; messaging details only while receiving', () => {
    const ids = settingRows(config({ messaging: { receive: false, mode: 'respond_only' } } as never)).map(r => r.id)
    expect(ids).toEqual(['instructions', 'tools', 'compaction', 'autonomous', 'autostart', 'receive', 'host'])
    const rows = settingRows(config({ messaging: { receive: true, mode: 'proactive', visibility: 'lan' }, instructions: 'Be brief.\nCite files.' } as never), { context: { main: 25_000 } })
    expect(rows.map(r => r.id)).toContain('visibility')
    expect(rows.find(r => r.id === 'visibility')).toMatchObject({ value: 'lan', warn: true })
    expect(rows.find(r => r.id === 'instructions')).toMatchObject({ value: '2 lines, 21 chars', hint: '“Be brief.”' })
    expect(rows.find(r => r.id === 'compaction')?.value).toBe('main at 100k (default) · in use 25k (25%)')
  })
})
