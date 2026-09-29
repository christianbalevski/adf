// Fleet — the ADF home screen. A daemon summary, every agent in one table
// (state, loops busy/total, approvals, inbox, model, tokens, timers, last
// activity, mesh), and the selected agent's cognition loops with their
// schedules. Everything acts on (agent, loop).

import { Box, Text } from 'ink'
import { useTheme, stateColor, type Theme } from '../../app/theme'
import { KeyHints, type KeyHintSpec } from '../../ui/KeyHint'
import { useKeys } from '../../app/keys'
import { useStore } from '../../state/store'
import { useAgents, useConnection, useIdentity, useSelectedAgent, useSelectedLoop, useViewState } from '../../state/hooks'
import { IDENTITY_BANNER_KEY } from '../../identity/model'
import { authNeedOf, authNeedText } from '../../auth/model'
import { shallowEqual, useTuiSelector } from '../../state/store'
import type { SubscriptionProvider } from '../../api/types'
import { IdentityBanner, IdentityOnboarding, bannerKeyOf, identityKey, needsAttention, openNewAgent } from '../../identity/Onboarding'
import { Table, type TableColumn } from '../../ui/Table'
import { Spinner } from '../../ui/Spinner'
import { formatAgo, formatCount, truncate, fit, displayWidth } from '../../ui/text'
import type { RuntimeOverview, Timer } from '../../api/types'
import type { AgentEntry } from '../../state/types'
import type { ViewDefinition, ViewProps } from '../types'
import { fleetCommands, LOAD_OVERLAY } from './commands'
import { agentGlyph } from './Sidebar'
import { LoadDialog } from './LoadDialog'
import { TrackDialog } from './TrackDialog'
import { UntrackDialog } from './UntrackDialog'
import { TRACK_OVERLAY, UNTRACK_OVERLAY } from './folders'
import { useFleetData, useFleetPoller, useLastActivity, type FleetData } from './data'
import { agentName, describeAgent, describeLoop, describeSchedule, formatIn, formatUptime, liveTimers, nextRunByLoop, timerLoop } from './model'
import { interruptAgent, openChat, refreshFleet, runAutostart, startAgent, stopAgent } from './ops'
import { SERVER_STOPPED_TEXT, servedText, siteKind, siteOf, type Site } from '../../web/model'
import { copySiteUrl, openSite } from '../../web/ops'

type MeshInfo = RuntimeOverview['network']['agents'][number]

function FleetView({ width, height, focused }: ViewProps) {
  useFleetPoller()
  const theme = useTheme()
  const store = useStore()
  const agents = useAgents()
  const data = useFleetData()
  const lastActivity = useLastActivity()
  const selected = useSelectedAgent()
  const selectedLoop = useSelectedLoop()
  const selectedIndex = Math.max(0, agents.findIndex(a => a.summary.id === selected?.summary.id))
  const offline = useConnection().reachable === false
  const identity = useIdentity()
  const needs = useTuiSelector(s => Object.fromEntries(s.agentOrder.map(id => [id, authNeedOf(s, id)])) as Record<string, SubscriptionProvider | null>, shallowEqual)
  const [bannerHidden] = useViewState<string>(IDENTITY_BANNER_KEY, '')
  // Empty fleet + identity not ready: onboarding replaces the empty table.
  const onboarding = agents.length === 0 && !!identity && identity.status !== 'ready'
  const banner = !onboarding && needsAttention(identity) && bannerHidden !== bannerKeyOf(identity) ? identity : null
  // Agent websites: re-render when the web server or what agents serve changes.
  useTuiSelector(s => s.web)
  const sites: Record<string, Site | null> = Object.fromEntries(agents.map(a => [a.summary.id, siteOf(store.getState(), a.summary.id)]))
  const statusOf = (id: string) => store.getState().web?.agents[id]?.status

  useKeys((input, key) => {
    // Ctrl/Meta chords belong to the shell (Ctrl+K palette, Ctrl+←/→ loops): never read Ctrl+K as k.
    if (key.ctrl || key.meta) return false
    const agent = agents[selectedIndex]
    const move = key.upArrow || input === 'k' ? -1 : key.downArrow || input === 'j' ? 1 : 0
    if (move && agents.length) {
      const next = agents[Math.max(0, Math.min(agents.length - 1, selectedIndex + move))]
      if (next.summary.id !== selected?.summary.id) store.actions.selectAgent(next.summary.id)
      return true
    }
    if ((key.leftArrow || key.rightArrow || input === 'h' || input === 'l') && agent) {
      const loops = agent.loops ?? []
      if (loops.length < 2) return true
      const at = Math.max(0, loops.findIndex(l => l.info.name === selectedLoop))
      const step = key.leftArrow || input === 'h' ? -1 : 1
      store.actions.selectLoop(agent.summary.id, loops[(at + step + loops.length) % loops.length].info.name)
      return true
    }
    if (key.return && agent) { openChat(store, agent.summary.id, selectedLoop); return true }
    if (identityKey(store, identity, input, onboarding)) return true
    if (input === 'n') { openNewAgent(store); return true }
    if (input === 'o') { store.actions.pushOverlay({ kind: LOAD_OVERLAY }); return true }
    if (input === 'f') { store.actions.pushOverlay({ kind: TRACK_OVERLAY }); return true }
    if (input === 'A') { void runAutostart(store); return true }
    if (input === 'r') { void refreshFleet(store); return true }
    if (!agent) return false
    if (input === 's') { void startAgent(store, agent.summary.id); return true }
    if (input === 'x') { void stopAgent(store, agent.summary.id); return true }
    if (input === 'a') { void interruptAgent(store, agent.summary.id); return true }
    if (input === 'w') { void openSite(store, agent.summary.id); return true }
    if (input === 'W') { void copySiteUrl(store, agent.summary.id); return true }
    return false
  }, { layer: 'main', active: focused })

  const inner = Math.max(20, width - 2)
  const selectedSite = selected ? sites[selected.summary.id] ?? null : null
  const detailRows = selected ? Math.min(Math.max(3, (selected.loops?.length ?? 1) + 2 + (selectedSite ? 1 : 0)), Math.max(3, Math.floor(height / 3))) : 0
  const tableRows = Math.max(2, height - 4 - detailRows - 1 - (banner ? 1 : 0))

  if (offline && agents.length === 0) return <DaemonOffline width={width} height={height} />

  if (onboarding && identity) {
    return (
      <Box flexDirection="column" width={width} height={height} paddingX={1}>
        <FleetHeadline agents={agents} />
        <DaemonLine data={data} width={inner} />
        <IdentityOnboarding identity={identity} width={inner} focused={focused} />
      </Box>
    )
  }

  return (
    <Box flexDirection="column" width={width} height={height} paddingX={1}>
      <FleetHeadline agents={agents} />
      <DaemonLine data={data} width={inner} />
      {banner ? <IdentityBanner identity={banner} width={inner} /> : <Box height={1} />}
      <Table
        width={inner}
        height={tableRows}
        rows={agents}
        getKey={a => a.summary.id}
        selectedIndex={agents.length ? selectedIndex : undefined}
        emptyText="No agents loaded — n new agent · f track a folder · o load an .adf · A autostart tracked folders"
        columns={columnsFor(inner, theme, data, lastActivity, needs, sites)}
      />
      {selected ? (
        <Box flexDirection="column" marginTop={1} height={detailRows} overflow="hidden">
          <AgentDetails agent={selected} need={needs[selected.summary.id] ?? null} loop={selectedLoop} timers={data.agents[selected.summary.id]?.timers} mesh={data.runtime?.network.agents.find(a => a.agentId === selected.summary.id)} site={selectedSite} status={statusOf(selected.summary.id)} width={inner} rows={detailRows} />
        </Box>
      ) : null}
      <Box flexGrow={1} />
      <KeyHints hints={focused ? DASHBOARD_KEYS.slice(1) : DASHBOARD_KEYS.slice(0, 1)} />
    </Box>
  )
}

const DASHBOARD_KEYS: KeyHintSpec[] = [
  { keys: 'shift+tab', label: 'focus the dashboard for its keys' },
  { keys: 'up down', label: 'agent' },
  { keys: 'left right', label: 'loop' },
  { keys: 'enter', label: 'chat' },
  { keys: 's', label: 'start' },
  { keys: 'x', label: 'stop' },
  { keys: 'a', label: 'interrupt' },
  { keys: 'w', label: 'website' },
  { keys: 'n', label: 'new agent' },
  { keys: 'o', label: 'load .adf' },
  { keys: 'f', label: 'track folder' },
  { keys: 'A', label: 'autostart' },
  { keys: 'r', label: 'refresh' },
]

/** No daemon to talk to: say so, where we looked, and how to start one. */
export function DaemonOffline({ width, height }: { width: number; height: number }) {
  const theme = useTheme()
  const { info, url } = useConnection()
  const retry = info.retryInMs !== undefined ? `retrying in ${Math.max(1, Math.round(info.retryInMs / 1000))}s` : 'retrying'
  return (
    <Box flexDirection="column" width={width} height={height} paddingX={1}>
      <Text bold color={theme.color.error}>{theme.glyph.dot} Daemon offline</Text>
      <Text> </Text>
      <Text wrap="wrap" color={theme.color.text}>No ADF daemon answers at {url}. The TUI is a client: agents run in the daemon, so there is nothing to show or load until it is up.</Text>
      <Text> </Text>
      <Text color={theme.color.muted}>Start it in another terminal:</Text>
      <Text color={theme.color.accent}>  npm run daemon</Text>
      <Text> </Text>
      <Text wrap="wrap" color={theme.color.muted}>Once it is up: f track a folder of agents · o load an .adf · n new agent.</Text>
      <Text> </Text>
      <Text wrap="wrap" color={theme.color.muted}>Daemon elsewhere? Set ADF_DAEMON_URL, restart with --url &lt;url&gt;, or switch now with /url &lt;url&gt; (ADF_DAEMON_TOKEN or --token for a remote daemon).</Text>
      <Text> </Text>
      <Text wrap="truncate-end" color={theme.color.dim}>{retry}{info.attempt > 0 ? ` ${theme.glyph.sep} attempt ${info.attempt}` : ''}{info.error ? ` ${theme.glyph.sep} ${info.error}` : ''}</Text>
    </Box>
  )
}

function FleetHeadline({ agents }: { agents: AgentEntry[] }) {
  const theme = useTheme()
  const busy = agents.filter(a => describeAgent(a).busy)
  const loops = agents.reduce((n, a) => n + (a.loops?.length ?? 1), 0)
  const runningLoops = agents.reduce((n, a) => n + describeAgent(a).runningLoops.length, 0)
  const pending = agents.reduce((n, a) => n + a.pendingTasks.length + a.pendingAsks.length, 0)
  return (
    <Text wrap="truncate-end">
      <Text bold color={theme.color.accent}>Fleet</Text>
      <Text color={theme.color.muted}>  {agents.length} agent{agents.length === 1 ? '' : 's'}</Text>
      <Text color={theme.color.dim}> {theme.glyph.sep} </Text>
      {busy.length ? <Spinner label={`${busy.length} busy`} /> : <Text color={theme.color.muted}>all idle</Text>}
      <Text color={theme.color.dim}> {theme.glyph.sep} </Text>
      <Text color={theme.color.loop}>{theme.glyph.loop} {loops} loops{runningLoops ? ` (${runningLoops} running)` : ''}</Text>
      {pending ? <><Text color={theme.color.dim}> {theme.glyph.sep} </Text><Text bold color={theme.color.warn}>{theme.glyph.warn}{pending} awaiting you</Text></> : null}
    </Text>
  )
}

function DaemonLine({ data, width }: { data: FleetData; width: number }) {
  const theme = useTheme()
  const rt = data.runtime
  if (!rt) {
    return (
      <Text color={data.runtimeError ? theme.color.warn : theme.color.dim} wrap="truncate-end">
        daemon {data.runtimeError ? `runtime overview unavailable: ${data.runtimeError}` : 'reading runtime overview…'}
      </Text>
    )
  }
  const providers = rt.providers.providers
  const keyed = providers.filter(p => p.hasApiKey).length
  const mesh = rt.network.mesh
  const meshStatus = mesh.status as { running?: boolean; agents?: unknown[]; registeredAgents?: unknown[] } | null
  const meshAgents = rt.network.agents.filter(a => a.receive).length
  const compute = rt.compute as { status?: string; running?: boolean; available?: boolean } | null
  const computeText = !compute ? 'off' : compute.status ?? (compute.running ? 'running' : compute.available === false ? 'unavailable' : 'ready')
  const parts: Array<[string, string | undefined]> = [
    [`pid ${rt.daemon.pid} up ${formatUptime(rt.daemon.uptime)}`, theme.color.muted],
    [`providers ${providers.length}${providers.length ? ` (${keyed} keyed)` : ''}`, providers.length ? theme.color.muted : theme.color.warn],
    [`mesh ${mesh.enabledSetting ? `on :${mesh.port}${mesh.lan ? ' lan' : ''}` : 'off'}${meshStatus?.running === false ? ' (down)' : ''} ${meshAgents} reachable`, mesh.enabledSetting ? theme.color.live : theme.color.dim],
    [`ws ${rt.network.websocket.activeConnections}`, theme.color.muted],
    [`compute ${computeText}`, theme.color.muted],
    [`sync ${data.runtimeAt ? formatAgo(data.runtimeAt) : '—'} ago`, theme.color.dim],
  ]
  return (
    <Text wrap="truncate-end">
      <Text bold color={theme.color.muted}>daemon </Text>
      {parts.map(([text, color], i) => (
        <Text key={i}>
          {i > 0 ? <Text color={theme.color.dim}> {theme.glyph.sep} </Text> : null}
          <Text color={color}>{truncate(text, width)}</Text>
        </Text>
      ))}
    </Text>
  )
}

function columnsFor(width: number, theme: Theme, data: FleetData, lastActivity: Record<string, number>, needs: Record<string, SubscriptionProvider | null>, sites: Record<string, Site | null>): TableColumn<AgentEntry>[] {
  const extras = (a: AgentEntry) => data.agents[a.summary.id]
  const mesh = (a: AgentEntry): MeshInfo | undefined => data.runtime?.network.agents.find(m => m.agentId === a.summary.id)
  const cols: Array<TableColumn<AgentEntry> & { minWidth?: number; priority: number }> = [
    { key: 'agent', title: 'AGENT', minWidth: 10, priority: 0, value: a => `${agentGlyph(theme, describeAgent(a).kind).glyph} ${agentName(a)}`, color: a => agentGlyph(theme, describeAgent(a).kind).color },
    { key: 'state', title: 'STATE', width: 12, priority: 0, value: a => describeAgent(a).label, color: a => stateColor(theme, describeAgent(a).kind === 'busy' ? 'thinking' : describeAgent(a).kind) },
    { key: 'loops', title: 'LOOPS', width: 6, align: 'right', priority: 1, value: a => a.loops ? `${describeAgent(a).runningLoops.length}/${a.loops.length}` : '?', color: a => describeAgent(a).runningLoops.length ? theme.color.loop : theme.color.muted },
    { key: 'hil', title: 'HIL', width: 4, align: 'right', priority: 0, value: a => String(a.pendingTasks.length + a.pendingAsks.length), color: a => (a.pendingTasks.length + a.pendingAsks.length) ? theme.color.warn : theme.color.dim },
    { key: 'inbox', title: 'INBOX', width: 5, align: 'right', priority: 2, value: a => String(extras(a)?.unread ?? a.unreadInbox), color: a => (extras(a)?.unread ?? a.unreadInbox) ? theme.color.info : theme.color.dim },
    { key: 'model', title: 'MODEL', minWidth: 12, priority: 1, value: a => (needs[a.summary.id] ? `${theme.glyph.warn} signed out` : modelOf(a)), color: a => (needs[a.summary.id] ? theme.color.warn : theme.color.muted) },
    { key: 'tokens', title: 'TOKENS', width: 7, align: 'right', priority: 3, value: a => tokensOf(a, extras(a)?.usageTotal), color: () => theme.color.muted },
    { key: 'timers', title: 'TIMERS', width: 6, align: 'right', priority: 2, value: a => (extras(a)?.timers ? String(liveTimers(extras(a)?.timers).length) : '·'), color: () => theme.color.muted },
    { key: 'last', title: 'LAST', width: 5, align: 'right', priority: 3, value: a => (lastActivity[a.summary.id] ? formatAgo(lastActivity[a.summary.id]) : '—'), color: () => theme.color.dim },
    { key: 'mesh', title: 'MESH', width: 5, priority: 4, value: a => { const m = mesh(a); return !m ? '·' : m.receive ? 'recv' : 'off' }, color: a => (mesh(a)?.receive ? theme.color.live : theme.color.dim) },
    // What the agent serves on the web; amber while the web server is stopped.
    { key: 'web', title: 'WEB', width: 5, priority: 4, value: a => { const site = sites[a.summary.id]; return site ? siteKind(site) : '·' }, color: a => { const site = sites[a.summary.id]; return !site ? theme.color.dim : site.url ? theme.color.live : theme.color.warn } },
  ]
  // Drop the least important columns until the table fits; WEB only when some agent serves.
  let shown = Object.values(sites).some(Boolean) ? cols : cols.filter(c => c.key !== 'web')
  for (let p = 4; p >= 1; p--) {
    const need = shown.reduce((n, c) => n + (c.width ?? c.minWidth ?? 6) + 1, 2)
    if (need <= width) break
    shown = shown.filter(c => c.priority < p)
  }
  return shown
}

function modelOf(a: AgentEntry): string {
  const model = a.config?.model
  if (model?.model_id) return model.provider ? `${model.provider}/${model.model_id}` : model.model_id
  return a.lastModel ?? '—'
}

function tokensOf(a: AgentEntry, usageTotal: number | undefined): string {
  const session = a.tokens.input + a.tokens.output
  const total = usageTotal && usageTotal > 0 ? usageTotal : session
  return total > 0 ? formatCount(total) : '—'
}

function AgentDetails({ agent, need, loop, timers, mesh, site, status, width, rows }: { agent: AgentEntry; need: SubscriptionProvider | null; loop: string; timers?: Timer[]; mesh?: MeshInfo; site: Site | null; status?: string; width: number; rows: number }) {
  const theme = useTheme()
  const next = nextRunByLoop(timers)
  const byLoop = new Map<string, Timer[]>()
  for (const t of liveTimers(timers)) {
    const l = timerLoop(t)
    if (l) byLoop.set(l, [...(byLoop.get(l) ?? []), t])
  }
  const loops = agent.loops ?? []
  const nameWidth = Math.min(16, Math.max(6, ...loops.map(l => displayWidth(l.info.name))))
  const meta = [
    agent.summary.filePath ?? 'in-memory',
    `autostart ${agent.summary.autostart ? 'on' : 'off'}`,
    mesh ? `mesh ${mesh.receive ? 'receiving' : 'not receiving'}${mesh.sendMode ? `, send ${mesh.sendMode}` : ''}` : '',
    agent.status?.degraded ? `degraded: ${agent.status.degraded}` : '',
  ].filter(Boolean).join(` ${theme.glyph.sep} `)
  return (
    <Box flexDirection="column" width={width}>
      <Text wrap="truncate-end">
        <Text bold color={theme.color.text}>{agentName(agent)}</Text>
        {status ? <Text color={theme.color.muted}>  {status}</Text> : null}
        <Text color={theme.color.dim}>  {meta}</Text>
      </Text>
      {site ? <SiteLine site={site} /> : null}
      {need ? <Text color={theme.color.warn} wrap="truncate-end">{theme.glyph.warn} {authNeedText(need)}</Text> : null}
      {agent.loopsError ? <Text color={theme.color.warn} wrap="truncate-end">loops: {agent.loopsError}</Text> : null}
      {loops.length === 0 && !agent.loopsError ? <Text color={theme.color.dim}>reading loops…</Text> : null}
      {loops.slice(0, Math.max(1, rows - 1 - (site ? 1 : 0))).map(l => {
        const d = describeLoop(agent, l)
        const isSel = l.info.name === loop
        const schedule = (byLoop.get(l.info.name) ?? []).map(describeSchedule).join(', ')
        const when = next[l.info.name] !== undefined ? formatIn(next[l.info.name]) : ''
        const plan = [schedule, when].filter(Boolean).join(' ')
        const goal = l.info.isMain ? 'talks to you (owner thread)' : l.info.goal
        const planText = fit(plan || (l.info.isMain ? '' : 'on demand'), 22)
        const status = fit(d.kind === 'running' ? d.label : d.kind === 'disabled' ? 'off' : 'idle', 10)
        const used = 2 + 2 + nameWidth + 1 + 10 + 1 + 22 + 1
        return (
          <Text key={l.info.name} wrap="truncate-end" inverse={theme.mono && isSel}>
            <Text color={theme.color.accent}>{isSel ? `${theme.glyph.pointer} ` : '  '}</Text>
            {d.kind === 'running' ? <Spinner color={theme.color.loop} /> : <Text color={d.kind === 'disabled' ? theme.color.dim : theme.color.muted}>{d.kind === 'disabled' ? '-' : theme.glyph.ring}</Text>}
            <Text color={!l.info.enabled ? theme.color.dim : l.info.isMain ? theme.color.accent : theme.color.loop} bold={isSel}> {fit(`${theme.glyph.loop}${l.info.name}`, nameWidth + 1)}</Text>
            <Text color={d.kind === 'running' ? theme.color.live : theme.color.muted}> {status}</Text>
            <Text color={plan ? theme.color.info : theme.color.dim}> {planText}</Text>
            <Text color={theme.color.dim}> {truncate(goal, Math.max(4, width - used))}</Text>
          </Text>
        )
      })}
    </Box>
  )
}

/** `web  http://127.0.0.1:7295/agents/agent-1/  public/ (index.html) · 1 API route  w open · W copy`. */
function SiteLine({ site }: { site: Site }) {
  const theme = useTheme()
  const sep = ` ${theme.glyph.sep} `
  return (
    <Text wrap="truncate-end">
      <Text color={theme.color.muted}>web  </Text>
      {site.url
        ? <Text color={theme.color.live} underline>{site.url}</Text>
        : <Text color={theme.color.warn}>{SERVER_STOPPED_TEXT} (w)</Text>}
      {site.lanUrls.length ? <Text color={theme.color.dim}>{sep}LAN {site.lanUrls[0]}{site.lanUrls.length > 1 ? ` +${site.lanUrls.length - 1}` : ''}</Text> : null}
      <Text color={theme.color.dim}>{sep}{servedText(site)}</Text>
      {site.url ? <Text color={theme.color.dim}>{sep}w open{sep}W copy</Text> : null}
    </Text>
  )
}

const fleet: ViewDefinition = {
  id: 'fleet',
  title: 'Fleet',
  key: '1',
  component: FleetView,
  keyHints: [{ keys: 'enter', label: 'chat' }, { keys: 'n', label: 'new' }, { keys: 'o', label: 'load' }],
  helpKeys: [{
    keys: [
      { keys: 'n', label: 'New agent from a template (sets up your owner identity first if needed)' },
      { keys: 'i', label: 'Owner identity: status, create, restore, unlock (I hides the banner)' },
      { keys: 'c r u', label: 'With no agents and no ready identity: create, restore, unlock the owner identity' },
      { keys: 'up down', label: 'Select an agent (j k)' },
      { keys: 'left right', label: 'Select one of its loops (h l)' },
      { keys: 'enter', label: 'Open the agent › loop in Chat' },
      { keys: 's', label: 'Start the agent' },
      { keys: 'x', label: 'Stop and unload the agent (asks; the .adf is kept)' },
      { keys: 'a', label: 'Abort the turns running now (asks)' },
      { keys: 'w', label: 'Open the agent’s website (starts the web server if it is stopped)' },
      { keys: 'W', label: 'Copy the agent’s website URL' },
      { keys: 'o', label: 'Load an .adf (Tab completes, ^R require review, ^S start after load)' },
      { keys: 'f', label: 'Track a folder of agents (Tab completes folders): its reviewed autostart agents load now and at every daemon start · /untrack <dir> stops' },
      { keys: 'A', label: 'Autostart: scan tracked directories (asks)' },
      { keys: 'r', label: 'Refresh agents, timers, inbox and the daemon line' },
    ],
  }],
  overlays: { [LOAD_OVERLAY]: LoadDialog, [TRACK_OVERLAY]: TrackDialog, [UNTRACK_OVERLAY]: UntrackDialog },
  ...fleetCommands,
}

export default fleet
