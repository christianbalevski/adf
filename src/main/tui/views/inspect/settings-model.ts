// Inspect › Settings: the agent settings Studio's agent config panel edits
// most (instructions, tools, compaction, autonomy, messaging, host access) as
// pure functions over an AgentConfig. Every change is a function of the FRESH
// config (re-read right before the write, settings-ops.ts), so it changes only
// the fields it names. Rules mirror src/renderer/components/agent/AgentConfig.tsx:
// the daemon's PUT /config (the owner path) does not validate locks — the
// owner may change anything — so the same guards Studio applies live here.

import type { AgentConfig, AgentToolEntry, LoopEntry } from '../../api/types'

type ToolDecl = AgentConfig['tools'][number]
type TriState = 'all' | 'none' | 'mixed'

export const DEFAULT_COMPACT_THRESHOLD = 100_000
/** Sanity cap (the schema has none): beyond every model's context window, so it is a typo. */
export const MAX_COMPACT_THRESHOLD = 10_000_000

/** Studio's tool groups, in order (AgentConfig.tsx TOOL_GROUPS). */
export const TOOL_GROUPS: ReadonlyArray<{ id: string; label: string; tools: readonly string[]; note?: string }> = [
  { id: 'shell', label: 'ADF Shell', tools: ['adf_shell'], note: 'bash-like interface; can run any tool by name' },
  { id: 'fs', label: 'Filesystem', tools: ['fs_read', 'fs_write', 'fs_list', 'fs_delete'] },
  { id: 'system', label: 'System', tools: ['sys_get_config', 'sys_update_config', 'sys_code', 'sys_lambda', 'sys_create_adf', 'sys_get_meta', 'sys_set_meta', 'sys_delete_meta'] },
  { id: 'timers', label: 'Timers', tools: ['sys_set_timer', 'sys_list_timers', 'sys_delete_timer'] },
  { id: 'packages', label: 'Packages', tools: ['npm_install', 'npm_uninstall'] },
  { id: 'mcp-tools', label: 'MCP', tools: ['mcp_install', 'mcp_restart', 'mcp_uninstall'] },
  { id: 'compute', label: 'Compute', tools: ['fs_transfer', 'compute_exec'] },
  { id: 'network', label: 'Network', tools: ['sys_fetch'] },
  { id: 'database', label: 'Database', tools: ['db_query', 'db_execute'] },
  { id: 'loop', label: 'Loop', tools: ['loop_compact', 'loop_clear', 'loop_send', 'loop_list', 'loop_manage'] },
  { id: 'websocket', label: 'WebSocket', tools: ['ws_connect', 'ws_disconnect', 'ws_connections', 'ws_send'] },
  { id: 'stream', label: 'Stream Bind', tools: ['stream_bind', 'stream_unbind', 'stream_bindings'] },
  { id: 'messaging', label: 'Messaging', tools: ['msg_send', 'agent_discover'], note: 'requires messaging' },
  { id: 'inbox', label: 'Inbox', tools: ['msg_list', 'msg_read', 'msg_update', 'msg_delete'], note: 'requires inbox mode' },
  { id: 'turn', label: 'Turn', tools: ['say', 'ask', 'sys_set_state'] },
]

const MESSAGING_TOOLS = new Set(['msg_send', 'agent_discover'])
const INBOX_TOOLS = new Set(['msg_list', 'msg_read', 'msg_update'])
const GROUPED = new Set(TOOL_GROUPS.flatMap(g => g.tools))

/** Every top-level key Studio's Instructions section writes (its section lock covers all three). */
export const INSTRUCTIONS_LOCK_KEYS = ['instructions', 'include_base_prompt', 'bare_prompt']

export const VISIBILITY_TIERS = ['off', 'directory', 'localhost', 'lan', 'public'] as const
export type VisibilityTier = typeof VISIBILITY_TIERS[number]
export const VISIBILITY_HINTS: Record<VisibilityTier, string> = {
  off: 'nobody: no inbound messages, sends still allowed',
  directory: 'only ancestor-directory agents on this runtime',
  localhost: 'any agent on this machine',
  lan: 'any agent on the local network (binds 0.0.0.0)',
  public: 'any agent reachable over the public internet (binds 0.0.0.0)',
}
export const SEND_MODES = ['proactive', 'respond_only', 'listen_only'] as const
export type SendMode = typeof SEND_MODES[number]
export const SEND_MODE_HINTS: Record<SendMode, string> = {
  proactive: 'can send anytime',
  respond_only: 'sends only when a message triggered the turn',
  listen_only: 'listen only, never sends',
}

// --- tools -------------------------------------------------------------------

export interface ToolRow {
  kind: 'tool'
  /** Declared name (`mcp_<server>_<tool>` for MCP tools). */
  name: string
  /** What the row shows (MCP tools: the server's own tool name). */
  label: string
  groupId: string
  enabled: boolean
  visible: boolean
  restricted: boolean
  locked: boolean
  /** Built-in rows only (Studio has no per-tool lock on MCP rows). */
  mcpServer?: string
  /** Why enabled / visible can't change here (group needs messaging / inbox mode). */
  blocked?: string
  /** The Turn tools (say, ask, sys_set_state) have no approval gate. */
  canRestrict: boolean
  status?: 'new' | 'changed' | 'removed'
  description?: string
}

export interface GroupRow {
  kind: 'group'
  id: string
  label: string
  note?: string
  mcpServer?: string
  tools: string[]
  enabled: TriState
  visible: TriState
  restricted: TriState
  blocked?: string
  canRestrict: boolean
  /** Enabled / total, for the header. */
  count: { enabled: number; total: number }
}

export type ToolListRow = GroupRow | ToolRow

function triState<T>(items: T[], pred: (item: T) => boolean): TriState {
  if (items.length === 0) return 'none'
  const n = items.filter(pred).length
  return n === 0 ? 'none' : n === items.length ? 'all' : 'mixed'
}

function groupBlocked(config: AgentConfig, groupId: string): string | undefined {
  // Studio: Messaging needs the on_inbox trigger, Inbox needs inbox mode.
  const triggers = config.triggers as { on_inbox?: { enabled?: boolean } } | undefined
  if (groupId === 'messaging' && !triggers?.on_inbox?.enabled) return 'needs messaging (the on_inbox trigger)'
  if (groupId === 'inbox' && config.messaging?.inbox_mode !== true) return 'needs inbox mode (Settings › Inbox mode)'
  return undefined
}

function mcpServers(config: AgentConfig): Array<{ name: string; tools: Array<{ name: string; description?: string }> }> {
  return (config.mcp?.servers ?? []).map(s => ({ name: s.name, tools: (s.available_tools ?? []).map(t => ({ name: t.name, description: t.description })) }))
}

/**
 * The Tools list: Studio's groups (with the tools this agent declares), an
 * "Other" group for declared tools outside them (e.g. chat_info, which Studio
 * shows under Code Execution), then one group per MCP server with the tools it
 * advertises that the config declares. `catalog` (GET /agents/:id/tools) adds
 * descriptions and tools the registry holds that the config does not declare
 * yet (shown disabled, like Studio's ensureRuntimeTools).
 */
export function buildToolRows(config: AgentConfig, catalog?: AgentToolEntry[] | null): ToolListRow[] {
  const decls = new Map<string, ToolDecl>((config.tools ?? []).map(t => [t.name, t]))
  const describe = new Map((catalog ?? []).map(t => [t.name, t.description]))
  for (const entry of catalog ?? []) {
    if (!decls.has(entry.name) && entry.source === 'builtin') decls.set(entry.name, { name: entry.name, enabled: false, visible: false })
  }
  const servers = mcpServers(config)
  const mcpNames = new Set<string>()
  for (const s of servers) for (const t of s.tools) mcpNames.add(`mcp_${s.name}_${t.name}`)
  const isMcp = (name: string) => mcpNames.has(name) || (name.startsWith('mcp_') && !GROUPED.has(name))

  const rows: ToolListRow[] = []
  const pushGroup = (id: string, label: string, names: string[], opts: { note?: string; mcpServer?: string; labels?: Map<string, string> } = {}) => {
    const tools = names.map(n => decls.get(n)).filter((t): t is ToolDecl => !!t)
    if (tools.length === 0) return
    const blocked = groupBlocked(config, id)
    const canRestrict = id !== 'turn'
    const eligible = tools.filter(t => !t.locked)
    const eligibleEnabled = eligible.filter(t => t.enabled)
    rows.push({
      kind: 'group', id, label, note: opts.note, mcpServer: opts.mcpServer, tools: tools.map(t => t.name),
      enabled: triState(eligible, t => t.enabled),
      visible: triState(eligibleEnabled, t => !!t.visible),
      restricted: triState(eligible, t => !!t.restricted),
      blocked, canRestrict,
      count: { enabled: tools.filter(t => t.enabled).length, total: tools.length },
    })
    for (const t of tools) {
      rows.push({
        kind: 'tool', name: t.name, label: opts.labels?.get(t.name) ?? t.name, groupId: id,
        enabled: blocked ? false : t.enabled, visible: !!t.visible, restricted: !!t.restricted, locked: !!t.locked,
        mcpServer: opts.mcpServer, blocked, canRestrict,
        status: t.mcp_tool_status, description: describe.get(t.name) || undefined,
      })
    }
  }
  for (const g of TOOL_GROUPS) pushGroup(g.id, g.label, [...g.tools], { note: g.note })
  const other = [...decls.keys()].filter(n => !GROUPED.has(n) && !isMcp(n)).sort()
  pushGroup('other', 'Other', other, { note: other.includes('chat_info') ? 'chat_info: sandbox code (adf.chat_info)' : undefined })
  for (const s of servers) {
    const labels = new Map(s.tools.map(t => [`mcp_${s.name}_${t.name}`, t.name]))
    for (const t of s.tools) if (!describe.has(`mcp_${s.name}_${t.name}`) && t.description) describe.set(`mcp_${s.name}_${t.name}`, t.description)
    pushGroup(`mcp:${s.name}`, `MCP ${s.name}`, [...labels.keys()], { mcpServer: s.name, labels })
  }
  // Declared MCP tools whose server is gone or no longer lists them.
  const orphans = [...decls.keys()].filter(n => isMcp(n) && !mcpNames.has(n)).sort()
  pushGroup('mcp:other', 'MCP (not listed by a configured server)', orphans, { mcpServer: '?' })
  return rows
}

/** Rows whose tool (or group label) matches `query`; a group header stays with its matches. */
export function filterToolRows(rows: ToolListRow[], query: string): ToolListRow[] {
  const q = query.trim().toLowerCase()
  if (!q) return rows
  const out: ToolListRow[] = []
  let header: GroupRow | null = null
  let headerAll = false
  for (const row of rows) {
    if (row.kind === 'group') { header = row; headerAll = row.label.toLowerCase().includes(q); continue }
    if (headerAll || row.name.toLowerCase().includes(q) || (row.description ?? '').toLowerCase().includes(q)) {
      if (header && out[out.length - 1] !== header && !out.includes(header)) out.push(header)
      out.push(row)
    }
  }
  return out
}

export function toolSummary(config: AgentConfig): string {
  const tools = config.tools ?? []
  const enabled = tools.filter(t => t.enabled).length
  const approval = tools.filter(t => t.enabled && t.restricted).length
  const locked = tools.filter(t => t.locked).length
  const servers = config.mcp?.servers?.length ?? 0
  return `${enabled}/${tools.length} enabled${approval ? ` · ${approval} need approval` : ''}${locked ? ` · ${locked} locked` : ''}${servers ? ` · ${servers} MCP server${servers === 1 ? '' : 's'}` : ''}`
}

// --- changes -----------------------------------------------------------------

/** A change applied to a fresh config: the next config + what to toast, or why not. */
export type Change = { ok: true; config: AgentConfig; message: string } | { ok: false; error: string }

const clone = (config: AgentConfig): AgentConfig => JSON.parse(JSON.stringify(config)) as AgentConfig

function withTool(config: AgentConfig, name: string, fn: (tool: ToolDecl, next: AgentConfig) => ToolDecl | string): Change {
  const next = clone(config)
  next.tools = next.tools ?? []
  let index = next.tools.findIndex(t => t.name === name)
  if (index < 0) { next.tools.push({ name, enabled: false, visible: false }); index = next.tools.length - 1 }
  const result = fn(next.tools[index], next)
  if (typeof result === 'string') return { ok: false, error: result }
  next.tools[index] = result
  return { ok: true, config: next, message: '' }
}

function groupOfTool(config: AgentConfig, name: string): string | undefined {
  return TOOL_GROUPS.find(g => g.tools.includes(name))?.id
}

const isMcpTool = (config: AgentConfig, name: string) => (name.startsWith('mcp_') && !GROUPED.has(name)) || (config.mcp?.servers ?? []).some(s => name.startsWith(`mcp_${s.name}_`))

/** Space: enable / disable (enabling also shows it in the tool list, as Studio does). */
export function toggleToolEnabled(config: AgentConfig, name: string): Change {
  const change = withTool(config, name, t => {
    if (t.locked) return `${name} is locked: unlock it first (l)`
    const blocked = groupBlocked(config, groupOfTool(config, name) ?? '')
    if (blocked) return `${name} ${blocked}`
    const enabled = !t.enabled
    return { ...t, enabled, visible: enabled ? true : t.visible }
  })
  if (!change.ok) return change
  const t = change.config.tools.find(x => x.name === name)!
  return { ...change, message: `${name} ${t.enabled ? 'enabled' : 'disabled'}` }
}

/** v: show / hide an enabled tool in the LLM's active tool list. */
export function toggleToolVisible(config: AgentConfig, name: string): Change {
  const change = withTool(config, name, t => {
    if (t.locked) return `${name} is locked: unlock it first (l)`
    const blocked = groupBlocked(config, groupOfTool(config, name) ?? '')
    if (blocked) return `${name} ${blocked}`
    if (!t.enabled) return `${name} is disabled: enable it first (Space)`
    return { ...t, visible: !t.visible }
  })
  if (!change.ok) return change
  const t = change.config.tools.find(x => x.name === name)!
  return { ...change, message: `${name} ${t.visible ? 'shown in' : 'hidden from'} the agent’s tool list` }
}

/** r: require (or stop requiring) owner approval. Studio allows it on a locked built-in, not on a locked MCP tool. */
export function toggleToolRestricted(config: AgentConfig, name: string): Change {
  const change = withTool(config, name, t => {
    if (groupOfTool(config, name) === 'turn') return `${name} is a turn tool: it has no approval gate`
    if (t.locked && isMcpTool(config, name)) return `${name} is locked: unlock it first`
    return { ...t, restricted: !t.restricted || undefined }
  })
  if (!change.ok) return change
  const t = change.config.tools.find(x => x.name === name)!
  return { ...change, message: t.restricted ? `${name} now needs your approval${t.enabled ? '' : ' (when enabled)'}` : `${name} no longer needs approval` }
}

/** l: owner lock on a built-in tool (the agent's sys_update_config cannot change a locked entry). */
export function toggleToolLock(config: AgentConfig, name: string): Change {
  if (isMcpTool(config, name)) return { ok: false, error: 'MCP tools have no per-tool lock here (lock the tools section instead)' }
  const change = withTool(config, name, t => ({ ...t, locked: !t.locked || undefined }))
  if (!change.ok) return change
  const t = change.config.tools.find(x => x.name === name)!
  return { ...change, message: t.locked ? `${name} locked: the agent cannot change it` : `${name} unlocked: the agent may change it` }
}

function groupToolNames(config: AgentConfig, groupId: string): string[] {
  return buildToolRows(config).filter((r): r is ToolRow => r.kind === 'tool' && r.groupId === groupId).map(r => r.name)
}

/** Space / v / r on a group header: bulk toggle, skipping locked tools (Studio's section toggles). */
export function toggleGroup(config: AgentConfig, groupId: string, field: 'enabled' | 'visible' | 'restricted', names = groupToolNames(config, groupId)): Change {
  if (names.length === 0) return { ok: false, error: 'No tools in this group' }
  const group = buildToolRows(config).find((r): r is GroupRow => r.kind === 'group' && r.id === groupId)
  const blocked = groupBlocked(config, groupId)
  if (blocked) return { ok: false, error: `${group?.label ?? groupId} ${blocked}` }
  if (field === 'restricted' && groupId === 'turn') return { ok: false, error: 'Turn tools have no approval gate' }
  const next = clone(config)
  const set = new Set(names)
  const eligible = next.tools.filter(t => set.has(t.name) && !t.locked)
  if (eligible.length === 0) return { ok: false, error: `Every tool in ${group?.label ?? groupId} is locked` }
  const enabledEligible = eligible.filter(t => t.enabled)
  let target: boolean
  if (field === 'enabled') target = triState(eligible, t => t.enabled) !== 'all'
  else if (field === 'visible') {
    if (enabledEligible.length === 0) return { ok: false, error: `No enabled tools in ${group?.label ?? groupId} to show or hide` }
    target = triState(enabledEligible, t => !!t.visible) !== 'all'
  } else target = triState(eligible, t => !!t.restricted) !== 'all'
  next.tools = next.tools.map(t => {
    if (!set.has(t.name) || t.locked) return t
    if (field === 'enabled') return { ...t, enabled: target, visible: target ? true : t.visible }
    if (field === 'visible') return t.enabled ? { ...t, visible: target } : t
    return { ...t, restricted: target || undefined }
  })
  const label = group?.label ?? groupId
  const what = field === 'enabled' ? (target ? 'enabled' : 'disabled') : field === 'visible' ? (target ? 'shown' : 'hidden') : (target ? 'need approval' : 'no longer need approval')
  return { ok: true, config: next, message: `${label}: ${eligible.length} tool${eligible.length === 1 ? '' : 's'} ${what}${eligible.length < names.length ? ' (locked ones skipped)' : ''}` }
}

// --- instructions / compaction ----------------------------------------------

export function setInstructions(config: AgentConfig, text: string): Change {
  const next = clone(config)
  next.instructions = text
  return { ok: true, config: next, message: `Instructions saved (${text.length} chars)` }
}

/** Effective compaction threshold of main: context → model → 100k (agent-executor). */
export function mainThreshold(config: AgentConfig): { value: number; source: 'context' | 'model' | 'default' } {
  const ctx = config.context?.compact_threshold
  if (typeof ctx === 'number' && ctx > 0) return { value: ctx, source: 'context' }
  const model = (config.model as { compact_threshold?: number | null } | undefined)?.compact_threshold
  if (typeof model === 'number' && model > 0) return { value: model, source: 'model' }
  return { value: DEFAULT_COMPACT_THRESHOLD, source: 'default' }
}

export function setMainThreshold(config: AgentConfig, value: number | null): Change {
  const next = clone(config)
  const context = { ...(next.context ?? {}) } as NonNullable<AgentConfig['context']>
  if (value === null) delete (context as { compact_threshold?: number }).compact_threshold
  else context.compact_threshold = value
  next.context = context
  return { ok: true, config: next, message: value === null ? `main compacts at the default (${formatTokens(mainThreshold(next).value)})` : `main compacts at ${formatTokens(value)} tokens` }
}

/**
 * `80000`, `80k`, `80,000`, `1.5m` → a positive whole number of tokens;
 * empty / `default` / `inherit` / `0` → null (unset). Schema: int, positive.
 */
export function parseThreshold(text: string): { ok: true; value: number | null } | { ok: false; error: string } {
  const raw = text.trim().toLowerCase().replace(/[,_\s]/g, '')
  if (!raw || raw === 'default' || raw === 'inherit' || raw === '0') return { ok: true, value: null }
  const m = /^(\d+(?:\.\d+)?)([km]?)$/.exec(raw)
  if (!m) return { ok: false, error: 'A whole number of tokens (e.g. 80000 or 80k), or empty for the default' }
  const exact = Number(m[1]) * (m[2] === 'k' ? 1000 : m[2] === 'm' ? 1_000_000 : 1)
  const value = Math.round(exact)
  if (Math.abs(exact - value) > 1e-6) return { ok: false, error: 'A whole number of tokens' }
  if (!Number.isFinite(value) || value < 1) return { ok: false, error: 'Must be at least 1 token' }
  if (value > MAX_COMPACT_THRESHOLD) return { ok: false, error: `At most ${formatTokens(MAX_COMPACT_THRESHOLD)} tokens (larger than any model’s context window)` }
  return { ok: true, value }
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(2)}M`
  if (n >= 1000) return `${+(n / 1000).toFixed(1)}k`
  return String(n)
}

/** Context in use: the newest entry with token usage (input + cache read + cache write). */
export function contextTokens(entries: LoopEntry[]): number | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const t = entries[i].tokens
    if (!t) continue
    const total = (t.input ?? 0) + (t.cache_read ?? 0) + (t.cache_write ?? 0)
    if (total > 0) return total
  }
  return null
}

// --- toggles -----------------------------------------------------------------

export function setAutonomous(config: AgentConfig, on: boolean): Change {
  const next = clone(config)
  next.autonomous = on
  return { ok: true, config: next, message: on ? 'Autonomous: on (keeps working without stopping after each reply)' : 'Autonomous: off' }
}

export function setAutostart(config: AgentConfig, on: boolean): Change {
  const next = clone(config)
  if (on) next.autostart = true
  else delete (next as { autostart?: boolean }).autostart
  return { ok: true, config: next, message: on ? 'Autostart: on (starts when the daemon starts)' : 'Autostart: off' }
}

type Messaging = NonNullable<AgentConfig['messaging']>
const baseMessaging = (config: AgentConfig): Messaging => ({ ...(config.messaging ?? { receive: false, mode: 'respond_only' }) } as Messaging)

/** Receive off also disables the messaging + inbox tools (Studio). */
export function setReceive(config: AgentConfig, receive: boolean): Change {
  const next = clone(config)
  next.messaging = { ...baseMessaging(next), receive }
  const all = new Set([...MESSAGING_TOOLS, ...INBOX_TOOLS])
  next.tools = (next.tools ?? []).map(t => (all.has(t.name) ? { ...t, enabled: receive ? t.enabled : false, visible: receive ? t.visible : false } : t))
  return { ok: true, config: next, message: receive ? 'Messaging: receives messages from other agents' : 'Messaging: off (messaging and inbox tools disabled)' }
}

/** Inbox mode switches the inbox tools with it (Studio). */
export function setInboxMode(config: AgentConfig, on: boolean): Change {
  if (!config.messaging?.receive) return { ok: false, error: 'Turn on Receive messages first' }
  const next = clone(config)
  next.messaging = { ...baseMessaging(next), inbox_mode: on }
  next.tools = (next.tools ?? []).map(t => (INBOX_TOOLS.has(t.name) ? { ...t, enabled: on, visible: on } : t))
  return { ok: true, config: next, message: on ? 'Inbox mode: on (messages wait in the inbox)' : 'Inbox mode: off (messages trigger the agent)' }
}

export function setVisibility(config: AgentConfig, tier: VisibilityTier): Change {
  if (!config.messaging?.receive) return { ok: false, error: 'Turn on Receive messages first' }
  const next = clone(config)
  next.messaging = { ...baseMessaging(next), visibility: tier } as Messaging
  return { ok: true, config: next, message: `Mesh visibility: ${tier} (${VISIBILITY_HINTS[tier]})` }
}

/** Send mode also switches msg_send / agent_discover (Studio). */
export function setSendMode(config: AgentConfig, mode: SendMode): Change {
  if (!config.messaging?.receive) return { ok: false, error: 'Turn on Receive messages first' }
  const next = clone(config)
  next.messaging = { ...baseMessaging(next), mode }
  const send = mode !== 'listen_only'
  const list = mode === 'proactive'
  next.tools = (next.tools ?? []).map(t => (t.name === 'msg_send' ? { ...t, enabled: send, visible: send } : t.name === 'agent_discover' ? { ...t, enabled: list, visible: list } : t))
  return { ok: true, config: next, message: `Send mode: ${mode} (${SEND_MODE_HINTS[mode]})` }
}

/** Compute targets as Studio reads them (allowed_targets, else the legacy flags). */
export function allowedTargets(config: AgentConfig): string[] {
  const c = config.compute
  if (c?.allowed_targets) return [...c.allowed_targets]
  if (c?.target) return [c.target]
  return [...(c?.enabled ? ['isolated'] : []), 'shared', ...(c?.host_access ? ['host'] : [])]
}

export function hasHostAccess(config: AgentConfig): boolean {
  return allowedTargets(config).includes('host')
}

/** Host access = the `host` compute target (Studio's Compute › Local host). */
export function setHostAccess(config: AgentConfig, on: boolean): Change {
  const allowed = allowedTargets(config)
  const nextAllowed = on ? (allowed.includes('host') ? allowed : [...allowed, 'host']) : allowed.filter(t => t !== 'host')
  if (nextAllowed.length === 0) return { ok: false, error: 'The agent needs at least one compute environment: allow shared or isolated first' }
  const next = clone(config)
  const current = { ...(next.compute ?? { enabled: false }) } as NonNullable<AgentConfig['compute']>
  delete (current as { target?: string }).target
  const defaultTarget = current.default_target ?? config.compute?.target ?? (current.enabled ? 'isolated' : 'shared')
  next.compute = {
    ...current,
    enabled: nextAllowed.includes('isolated'),
    host_access: nextAllowed.includes('host'),
    allowed_targets: nextAllowed,
    default_target: nextAllowed.includes(defaultTarget) ? defaultTarget : nextAllowed[0],
  }
  return { ok: true, config: next, message: on ? 'Host access: on (restart the agent so its tools see it)' : 'Host access: off (restart the agent so its tools see it)' }
}

export function setNewMcpToolsRestricted(config: AgentConfig, on: boolean): Change {
  const next = clone(config)
  const mcp = { ...(next.mcp ?? { servers: [] }) } as NonNullable<AgentConfig['mcp']>
  if (on) delete (mcp as { new_tools_restricted?: boolean }).new_tools_restricted
  else mcp.new_tools_restricted = false
  next.mcp = mcp
  return { ok: true, config: next, message: on ? 'New MCP tools need approval' : 'New MCP tools run without approval' }
}

/** Section lock (`locked_fields`): binds the agent's sys_update_config, never the owner. */
export function isLocked(config: AgentConfig, keys: readonly string[]): boolean {
  const locked = config.locked_fields ?? []
  return keys.length > 0 && keys.every(k => locked.includes(k))
}

export function toggleSectionLock(config: AgentConfig, keys: readonly string[], label: string): Change {
  const next = clone(config)
  const current = next.locked_fields ?? []
  const unlock = keys.every(k => current.includes(k))
  const fields = unlock ? current.filter(k => !keys.includes(k)) : [...current, ...keys.filter(k => !current.includes(k))]
  if (fields.length > 0) next.locked_fields = fields
  else delete (next as { locked_fields?: string[] }).locked_fields
  return { ok: true, config: next, message: unlock ? `${label}: unlocked (the agent may change it)` : `${label}: locked (the agent cannot change it)` }
}

// --- the Settings tab rows ----------------------------------------------------

export type SettingId = 'instructions' | 'tools' | 'compaction' | 'autonomous' | 'autostart' | 'receive' | 'inbox' | 'visibility' | 'send' | 'host' | 'mcp-approval'

export interface SettingRow {
  id: SettingId
  label: string
  value: string
  /** Second line: what it means / the warning. */
  hint?: string
  warn?: boolean
  /** How Enter / Space act: open a dialog, flip a switch, pick a choice. */
  kind: 'dialog' | 'bool' | 'choice'
  on?: boolean
  /** locked_fields keys this row's section lock covers (l toggles). */
  lockKeys?: string[]
  locked?: boolean
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find(l => l.trim()) ?? ''
  return line.trim()
}

export interface SettingsExtras {
  /** Context in use per loop (main first), when known. */
  context?: Record<string, number | null>
  /** The daemon's compute.hostAccessEnabled setting, when known. */
  daemonHostAccess?: boolean | null
}

export function settingRows(config: AgentConfig, extras: SettingsExtras = {}): SettingRow[] {
  const rows: SettingRow[] = []
  const lock = (keys: string[]) => ({ lockKeys: keys, locked: isLocked(config, keys) })
  const instructions = config.instructions ?? ''
  const lines = instructions ? instructions.split(/\r?\n/).length : 0
  rows.push({
    id: 'instructions', label: 'Instructions', kind: 'dialog',
    value: instructions ? `${lines} line${lines === 1 ? '' : 's'}, ${instructions.length} chars` : 'none',
    hint: instructions ? `“${firstLine(instructions)}”` : 'The agent’s own text, always in its system prompt',
    ...lock(INSTRUCTIONS_LOCK_KEYS),
  })
  rows.push({ id: 'tools', label: 'Tools', kind: 'dialog', value: toolSummary(config), hint: 'Enable, show, require approval, lock; built-in and MCP', ...lock(['tools']) })
  const main = mainThreshold(config)
  const used = extras.context?.main
  rows.push({
    id: 'compaction', label: 'Compaction', kind: 'dialog',
    value: `main at ${formatTokens(main.value)}${main.source === 'default' ? ' (default)' : ''}${typeof used === 'number' ? ` · in use ${formatTokens(used)} (${Math.round(used / main.value * 100)}%)` : ''}`,
    hint: (config.loops ?? []).length ? `inner loops: ${(config.loops ?? []).map(l => `${l.name} ${l.compact_threshold != null ? formatTokens(l.compact_threshold) : 'inherit'}`).join(', ')}` : 'History is summarized when the context reaches this size',
    ...lock(['context']),
  })
  rows.push({
    id: 'autonomous', label: 'Autonomous', kind: 'bool', on: !!config.autonomous, value: config.autonomous ? 'on' : 'off',
    hint: config.autonomous ? 'Keeps making LLM calls without pausing between turns: ongoing API cost' : 'Stops after each reply',
    warn: !!config.autonomous,
  })
  rows.push({ id: 'autostart', label: 'Autostart', kind: 'bool', on: !!config.autostart, value: config.autostart ? 'on' : 'off', hint: 'Start as a background agent when the daemon starts' })
  const m = config.messaging
  rows.push({ id: 'receive', label: 'Receive messages', kind: 'bool', on: !!m?.receive, value: m?.receive ? 'on' : 'off', hint: 'Takes part in the mesh and receives messages from other agents', ...lock(['messaging']) })
  if (m?.receive) {
    const tier = (m.visibility ?? 'localhost') as VisibilityTier
    rows.push({ id: 'visibility', label: '  Visibility', kind: 'choice', value: tier, hint: VISIBILITY_HINTS[tier] ?? '', warn: tier === 'public' || tier === 'lan', ...lock(['messaging']) })
    const mode = (m.mode ?? 'respond_only') as SendMode
    rows.push({ id: 'send', label: '  Send mode', kind: 'choice', value: mode, hint: SEND_MODE_HINTS[mode] ?? '', ...lock(['messaging']) })
    rows.push({ id: 'inbox', label: '  Inbox mode', kind: 'bool', on: !!m.inbox_mode, value: m.inbox_mode ? 'on' : 'off', hint: m.inbox_mode ? 'Messages wait in the inbox; the agent is notified' : 'Messages trigger the agent immediately', ...lock(['messaging']) })
  }
  const host = hasHostAccess(config)
  rows.push({
    id: 'host', label: 'Host access', kind: 'bool', on: host, value: host ? 'on' : 'off', warn: host,
    hint: host
      ? `Runs tools directly on this machine, outside container isolation${extras.daemonHostAccess === false ? ' · the daemon’s host access setting is off, so it has no effect yet' : ''}`
      : 'Direct access to this machine (bypasses container isolation)',
    ...lock(['compute']),
  })
  if ((config.mcp?.servers ?? []).length > 0) {
    const on = config.mcp?.new_tools_restricted !== false
    rows.push({ id: 'mcp-approval', label: 'New MCP tools need approval', kind: 'bool', on, value: on ? 'on' : 'off', hint: 'Tools found on a newly attached server start behind the approval gate', warn: !on, ...lock(['mcp']) })
  }
  return rows
}
