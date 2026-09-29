// Daemon reports: the pages of the Runtime view (views/runtime) behind
// /status /usage /providers /network /settings /compute. Each loads what it
// needs and returns the raw data (for /json) and readable lines.

import type { DaemonClient } from '../../api/client'
import { MAIN_LOOP } from '../../api/types'
import type { TuiState } from '../../state/types'
import { SERVER_STOPPED_TEXT, parseServer, servedText, serverText, siteOf } from '../../web/model'
import {
  blank,
  formatDuration,
  formatNumber,
  heading,
  plain,
  redactSecrets,
  tableLines,
  treeLines,
  type Line,
} from '../../views/inspect/format'

export type ReportKind = 'status' | 'usage' | 'providers' | 'auth' | 'network' | 'settings' | 'compute' | 'mcp' | 'channels'

export interface ReportResult {
  data: unknown
  lines: Line[]
}

export interface Report {
  title: string
  load(client: DaemonClient, state: TuiState): Promise<ReportResult>
}

const indent = (line: Line): Line => [{ text: '  ' }, ...line]
const handleOf = (state: TuiState, id: string) => state.agents[id]?.summary.handle || state.agents[id]?.summary.name || id

async function settle<T>(p: Promise<T>): Promise<{ value?: T; error?: string }> {
  try { return { value: await p } } catch (err) { return { error: err instanceof Error ? err.message : String(err) } }
}

export const REPORTS: Record<ReportKind, Report> = {
  status: {
    title: 'Status',
    async load(client, state) {
      const [health, runtime] = await Promise.all([settle(client.health()), settle(client.runtime())])
      const agents = state.agentOrder.map(id => {
        const a = state.agents[id]
        const loops = a?.loops ?? []
        const running = loops.filter(l => (l.executorState && !['idle', 'stopped'].includes(l.executorState)) || l.info.status === 'running').map(l => l.info.name)
        return {
          agent: handleOf(state, id),
          id,
          state: a?.executorState ?? a?.status?.runtimeState ?? 'unknown',
          loops: loops.map(l => l.info.name),
          running,
          selectedLoop: state.selectedLoop[id] ?? MAIN_LOOP,
          pendingApprovals: a?.pendingTasks.length ?? 0,
          pendingAsks: a?.pendingAsks.length ?? 0,
          error: a?.error,
        }
      })
      const data = {
        daemon: {
          url: state.daemonUrl,
          reachable: health.value?.ok ?? false,
          error: health.error,
          liveEvents: state.connection.state,
          pid: runtime.value?.daemon.pid,
          uptimeSeconds: runtime.value?.daemon.uptime,
          version: runtime.value?.daemon.version,
        },
        agents,
      }
      const lines: Line[] = [heading('Daemon')]
      lines.push(indent([{ text: 'url         ', tone: 'key' }, { text: state.daemonUrl }]))
      lines.push(indent([{ text: 'health      ', tone: 'key' }, health.value?.ok ? { text: 'ok', tone: 'success' } : { text: `unreachable${health.error ? `: ${health.error}` : ''}`, tone: 'error' }]))
      lines.push(indent([{ text: 'live events ', tone: 'key' }, { text: state.connection.state, tone: state.connection.state === 'open' ? 'success' : 'warn' }, { text: state.connection.error ? ` (${state.connection.error})` : '', tone: 'muted' }]))
      if (runtime.value) {
        const d = runtime.value.daemon
        if (d.version) lines.push(indent([{ text: 'version     ', tone: 'key' }, { text: String(d.version) }]))
        lines.push(indent([{ text: 'pid         ', tone: 'key' }, { text: String(d.pid) }]))
        lines.push(indent([{ text: 'uptime      ', tone: 'key' }, { text: formatDuration(d.uptime * 1000) }]))
        if (d.node) lines.push(indent([{ text: 'node        ', tone: 'key' }, { text: `${d.node}${d.platform ? ` ${'·'} ${d.platform}` : ''}`, tone: 'muted' }]))
        const identity = state.identity
        if (identity) lines.push(indent([{ text: 'owner       ', tone: 'key' }, { text: identity.status, tone: identity.status === 'ready' ? 'success' : 'warn' }, { text: '  (Identity tab)', tone: 'muted' }]))
        const compute = runtime.value.compute as Record<string, unknown> | null
        if (compute) lines.push(indent([{ text: 'compute     ', tone: 'key' }, { text: String(compute.status ?? compute.state ?? (compute.running ? 'running' : 'stopped')) }, { text: '  (Compute tab)', tone: 'muted' }]))
      } else if (runtime.error) {
        lines.push(indent(plain(`runtime: ${runtime.error}`, 'warn')))
      }
      lines.push(blank(), heading(`Agents (${agents.length})`))
      lines.push(...tableLines(
        ['agent', 'state', 'loops', 'running', 'hil'],
        agents.map(a => [a.agent, a.state, a.loops.join(', ') || MAIN_LOOP, a.running.join(', ') || '-', String(a.pendingApprovals + a.pendingAsks)]),
        { maxWidth: 36, align: ['left', 'left', 'left', 'left', 'right'] },
      ).map(indent))
      lines.push(blank(), plain('Loops are each agent’s parallel chat sessions: main talks to you, inner loops work on their own goal.', 'muted'))
      return { data, lines }
    },
  },

  usage: {
    title: 'Usage',
    async load(client, state) {
      const runtime = await settle(client.usage())
      const lines: Line[] = []
      if (runtime.value) {
        const u = runtime.value
        lines.push(heading('Daemon: by model (all agents)'))
        lines.push(...tableLines(
          ['provider', 'model', 'days', 'input', 'output', 'total'],
          (u.byModel ?? []).map(m => [m.provider, m.model, String(m.days), formatNumber(m.input), formatNumber(m.output), formatNumber(m.total)]),
          { align: ['left', 'left', 'right', 'right', 'right', 'right'] },
        ).map(indent))
        lines.push(indent(plain(`total input ${formatNumber(u.totals?.input)} ${'·'} output ${formatNumber(u.totals?.output)} ${'·'} ${formatNumber(u.totals?.total)}`, 'muted')))
        if (u.note) lines.push(indent(plain(u.note, 'muted')))
      } else if (runtime.error) {
        lines.push(plain(`Daemon usage: ${runtime.error}`, 'error'))
      }
      lines.push(blank(), heading('This TUI session (live, every agent)'))
      lines.push(...tableLines(
        ['agent', 'input', 'output', 'cache read', 'last model'],
        state.agentOrder.map(id => {
          const t = state.agents[id]?.tokens
          return [handleOf(state, id), formatNumber(t?.input ?? 0), formatNumber(t?.output ?? 0), formatNumber(t?.cacheRead ?? 0), state.agents[id]?.lastModel ?? '-']
        }),
        { align: ['left', 'right', 'right', 'right', 'left'] },
      ).map(indent))
      lines.push(blank(), plain('One agent by model: Inspect › Usage (5).', 'muted'))
      const { usage: _daily, ...daemonSummary } = (runtime.value ?? {}) as Record<string, unknown>
      return { data: { daemon: runtime.value ? daemonSummary : runtime.error }, lines }
    },
  },

  providers: {
    title: 'Providers',
    async load(client) {
      const d = await client.providers()
      const lines: Line[] = [heading('Registered providers')]
      lines.push(...tableLines(
        ['id', 'type', 'name', 'credentials'],
        (d.providers as Array<Record<string, unknown>>).map(p => [String(p.id ?? ''), String(p.type ?? ''), String(p.name ?? ''), String(p.credentialStorage ?? 'app')]),
      ).map(indent))
      lines.push(blank(), heading('What each agent uses'))
      lines.push(...tableLines(
        ['agent', 'provider', 'model', 'source'],
        d.agentUsage.map(a => [a.handle || a.name, a.providerId || '-', a.modelId || '-', a.source]),
      ).map(indent))
      if (d.agentUsage.some(a => a.source === 'missing')) lines.push(blank(), plain('source "missing": the agent names a provider the daemon does not know. Add it in Studio settings.', 'warn'))
      return { data: redactSecrets(d), lines }
    },
  },

  auth: {
    title: 'Auth',
    async load(client) {
      const d = await client.authStatus()
      const lines: Line[] = [heading('Subscription sign-ins')]
      for (const [name, status] of [['chatgpt', d.chatgpt], ['grok', d.grok]] as const) {
        const s = (status ?? {}) as Record<string, unknown>
        lines.push(indent([{ text: name.padEnd(9), tone: 'key' }, s.authenticated ? { text: 'signed in', tone: 'success' } : { text: 'not signed in', tone: 'muted' }, { text: s.email ? `  ${String(s.email)}` : '', tone: 'muted' }]))
      }
      lines.push(blank(), heading('API-key providers'))
      lines.push(...tableLines(
        ['id', 'type', 'key', 'stored in'],
        d.providers.map(p => [p.id, p.type, p.hasApiKey ? 'set' : 'missing', p.credentialStorage]),
      ).map(indent))
      lines.push(blank(), heading('Sign in or out'))
      lines.push(indent(plain('Enter opens the sign-in dialog · /login chatgpt · /login grok · /logout <chatgpt|grok>', 'accent')))
      lines.push(indent(plain('From a shell: adf auth login <chatgpt|grok>', 'muted')))
      lines.push(indent(plain('API keys: Studio settings, stored by the daemon (never shown here).', 'muted')))
      return { data: redactSecrets(d), lines }
    },
  },

  network: {
    title: 'Network',
    async load(client, state) {
      const [d, server] = await Promise.all([client.network(), settle(client.meshServer())])
      const safe = redactSecrets(d) as Record<string, unknown>
      const { agents, ...rest } = safe
      const mesh = (safe.mesh ?? {}) as Record<string, unknown>
      const lines: Line[] = [heading('Mesh')]
      lines.push(indent([{ text: 'mesh        ', tone: 'key' }, meshOn(mesh) ? { text: 'on', tone: 'success' } : { text: 'off', tone: 'muted' }, { text: `  port ${String(mesh.port ?? '-')}${mesh.lan ? ` ${'·'} LAN` : ''}`, tone: 'muted' }]))
      if (server.value) lines.push(indent([{ text: 'web server  ', tone: 'key' }, { text: serverText(parseServer(server.value)), tone: serverRunning(server.value) ? 'success' : 'warn' }, { text: '  serves agent sites / APIs, receives mesh messages', tone: 'muted' }]))
      lines.push(indent(plain(`m mesh on/off (asks) · s web server ${server.value && serverRunning(server.value) ? 'stop (asks)' : 'start'} · R restart`, 'accent')))
      // Agent websites, with the live server state (the report's own read wins over the store's).
      const live = parseServer(server.value)
      const view = { ...state, web: state.web ? { ...state.web, server: live ?? state.web.server } : live ? { server: live, lan: [], agents: {}, at: Date.now() } : null }
      const sites = state.agentOrder.map(id => siteOf(view, id)).filter(site => !!site)
      if (sites.length) {
        lines.push(blank(), heading(`Agent websites (${sites.length})`))
        for (const site of sites) lines.push(indent([{ text: site.handle.padEnd(14), tone: 'key' }, site.url ? { text: site.url, tone: 'accent' } : { text: SERVER_STOPPED_TEXT, tone: 'warn' }, { text: `  ${servedText(site)}`, tone: 'muted' }]))
        lines.push(indent(plain('Open one: Fleet w · /open-site <agent> · Ctrl+K "Open agent website"', 'muted')))
      }
      lines.push(blank(), ...treeLines(rest))
      if (Array.isArray(agents)) {
        lines.push(blank(), heading('Agents on the mesh'))
        lines.push(...tableLines(
          ['agent', 'receive', 'send mode', 'ws', 'routes', 'public'],
          (agents as Array<Record<string, unknown>>).map(a => [String(a.handle || a.name || a.agentId), String(a.receive), String(a.sendMode ?? '-'), String(a.wsConnectionsConfigured ?? 0), String(a.servingRoutes ?? 0), a.publicServingEnabled ? 'yes' : 'no']),
        ).map(indent))
      }
      return { data: { ...safe, server: server.value ?? server.error }, lines }
    },
  },

  compute: {
    title: 'Compute',
    async load(client) {
      const [status, containers] = await Promise.all([settle(client.computeStatus()), settle(client.computeContainers())])
      const lines: Line[] = [heading('Container runtime')]
      if (status.value) lines.push(...treeLines(redactSecrets(status.value), 2))
      else lines.push(indent(plain(`Not available: ${status.error ?? 'unknown'}`, 'muted')))
      const list = containers.value?.containers ?? []
      lines.push(blank(), heading(`Containers (${list.length})`))
      if (list.length) {
        lines.push(...tableLines(
          ['name', 'state', 'image', 'agent'],
          list.map(c => [String(c.name ?? c.id ?? '-'), String(c.state ?? c.status ?? '-'), String(c.image ?? '-'), String(c.agent ?? c.agentName ?? c.owner ?? '-')]),
          { maxWidth: 40 },
        ).map(indent))
      } else if (containers.error) lines.push(indent(plain(containers.error, 'muted')))
      else lines.push(indent(plain('None running.', 'muted')))
      lines.push(blank(), plain('Containers run MCP servers and agent code in isolation; Studio starts and stops them (POST /compute/*).', 'muted'))
      return { data: { status: status.value ?? status.error, containers: containers.value?.containers ?? containers.error }, lines }
    },
  },

  mcp: {
    title: 'MCP servers',
    async load(client) {
      const d = redactSecrets(await client.runtimeMcp())
      const lines: Line[] = [heading('MCP servers registered with the daemon'), ...treeLines(d, 2)]
      lines.push(blank(), plain('Each agent’s own MCP state: Inspect › MCP (5).', 'muted'))
      return { data: d, lines }
    },
  },

  channels: {
    title: 'Channels',
    async load(client) {
      const d = redactSecrets(await client.runtimeAdapters())
      const lines: Line[] = [heading('Channels (channel adapters) available to agents'), ...treeLines(d, 2)]
      lines.push(blank(), plain('Each agent’s own channels and their live state: Inspect › Channels (5); /channels adds one.', 'muted'))
      return { data: d, lines }
    },
  },

  settings: {
    title: 'Settings',
    async load(client) {
      const [summary, all] = await Promise.all([settle(client.runtimeSettings()), settle(client.settings())])
      const lines: Line[] = []
      if (summary.value) lines.push(heading('Summary'), ...treeLines(redactSecrets(summary.value), 2))
      else if (summary.error) lines.push(plain(`Summary: ${summary.error}`, 'warn'))
      const settings = all.value ? redactSecrets(all.value) : undefined
      if (settings) lines.push(blank(), heading('All settings (secrets redacted)'), ...treeLines(settings, 2))
      else if (all.error) lines.push(plain(`Settings: ${all.error}`, 'warn'))
      lines.push(blank(), plain('Change settings in Studio, or PUT /settings/:key on the daemon.', 'muted'))
      return { data: { summary: summary.value, settings }, lines }
    },
  },
}

/** The mesh is on: the running service says so, else the saved setting. */
export function meshOn(mesh: Record<string, unknown>): boolean {
  const status = mesh.status as Record<string, unknown> | null | undefined
  if (status && typeof status.meshEnabled === 'boolean') return status.meshEnabled
  if (status && typeof status.running === 'boolean') return status.running
  if (status && typeof status.enabled === 'boolean') return status.enabled
  return mesh.enabledSetting === true
}

export function serverRunning(server: Record<string, unknown>): boolean {
  return server.running === true || server.status === 'running'
}
