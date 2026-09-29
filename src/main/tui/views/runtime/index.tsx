// Runtime: the daemon itself, across every agent. Status (version, uptime,
// every agent's loops), owner identity, provider sign-in, providers, usage by
// model, network / mesh, compute (containers), daemon-level MCP servers and
// adapters, settings (redacted) and the live event tail of every agent.
// The selected agent's own pages are Inspect (5).

import { useMemo } from 'react'
import { Box, Text } from 'ink'
import { useTheme } from '../../app/theme'
import { useKeys, type Key } from '../../app/keys'
import { useActions, useStore, useTuiSelector } from '../../state/store'
import { useIdentity } from '../../state/hooks'
import { TabStrip } from '../../ui/Tabs'
import { formatClock } from '../../ui/text'
import { REPORTS, meshOn, serverRunning, type ReportKind } from '../../commands/builtin/reports'
import { openIdentity } from '../../identity/Onboarding'
import { onboardingChoices, onboardingLines, identityBadge, IDENTITY_EXPLAINER } from '../../identity/model'
import { openAuth } from '../../commands/builtin/auth'
import { EventsTab } from '../inspect/EventsTab'
import { LinesView } from '../inspect/LinesView'
import { useDaemonData } from '../inspect/hooks'
import { readInspectState } from '../inspect/state'
import { blank, heading, jsonLines, plain, redactSecrets, treeLines, type Line } from '../inspect/format'
import { EVENT_KEYS } from '../inspect/event-keys'
import type { ViewDefinition, ViewProps } from '../types'
import { RUNTIME_TABS, RUNTIME_VIEW, useRuntimeState } from './state'
import { toggleWebServer } from '../../web/ops'
import { runtimeCommands } from './commands'
import { FoldersTab } from './FoldersTab'

interface TabProps { width: number; height: number; focused: boolean }

/** A daemon report as a scrollable page: r reloads, /json shows it raw. */
function ReportTab({ kind, width, height, focused, onKey, hint }: TabProps & {
  kind: ReportKind
  /** Page-specific keys (after r); `reload` refetches. */
  onKey?: (input: string, key: Key, reload: () => void) => boolean
  hint?: string
}) {
  const theme = useTheme()
  const store = useStore()
  const json = useStoreJson()
  const report = REPORTS[kind]
  const { data, error, loading, loadedAt, reload } = useDaemonData(kind, client => report.load(client, store.getState()))
  useKeys((input, key) => {
    if (key.ctrl || key.meta) return false
    if (input === 'r') { reload(); return true }
    return onKey?.(input, key, reload) ?? false
  }, { layer: 'main', active: focused })
  const lines = useMemo((): Line[] => {
    if (error) return [plain(`Could not load: ${error}`, 'error'), plain('r retries.', 'muted')]
    if (!data) return []
    return json ? jsonLines(data.data) : data.lines
  }, [data, error, json])
  return (
    <Box flexDirection="column" width={width} height={height}>
      <LinesView lines={lines} width={width} height={Math.max(1, height - 1)} active={focused} emptyText={loading ? `Asking the daemon at ${store.getState().daemonUrl}…` : 'Nothing to show.'} />
      <Text color={theme.color.dim} wrap="truncate-end">
        r refresh {theme.glyph.sep} /json raw {hint ? `${theme.glyph.sep} ${hint} ` : ''}{theme.glyph.sep} {loading ? 'loading…' : loadedAt ? `as of ${formatClock(loadedAt)}` : ''}
      </Text>
    </Box>
  )
}

function useStoreJson(): boolean {
  return useTuiSelector(s => readInspectState(s).json)
}

function IdentityTab({ width, height, focused }: TabProps) {
  const theme = useTheme()
  const store = useStore()
  const identity = useIdentity()
  const choices = identity ? onboardingChoices(identity) : []
  useKeys((input, key) => {
    if (key.ctrl || key.meta || !identity) return false
    if (key.return) { openIdentity(store, { mode: 'status' }); return true }
    if (input === 'r' && !choices.some(c => c.key === 'r')) { void store.actions.refreshIdentity(); return true }
    const choice = choices.find(c => c.key === input)
    if (choice) { openIdentity(store, { mode: choice.mode }); return true }
    return false
  }, { layer: 'main', active: focused })
  const lines = useMemo((): Line[] => {
    if (!identity) return [plain('This daemon does not report an owner identity (update the daemon).', 'muted')]
    const badge = identityBadge(identity)
    const { title, next } = onboardingLines(identity)
    const out: Line[] = [heading(title)]
    if (next) out.push(plain(`  ${next}`, 'warn'))
    if (badge) out.push([{ text: '  ' }, { text: badge.text, tone: badge.tone === 'warn' ? 'warn' : 'muted' }])
    out.push(blank(), ...treeLines(redactSecrets(identity), 2))
    out.push(blank(), heading('Actions'))
    out.push(plain(`  Enter  identity dialog (status, backup, lock / unlock)`, 'accent'))
    for (const c of choices) out.push(plain(`  ${c.key}      ${c.label}`, 'accent'))
    out.push(plain('  r      re-read the status', 'accent'))
    out.push(blank(), plain(`  ${IDENTITY_EXPLAINER}`, 'muted'))
    return out
  }, [identity, choices.map(c => c.key).join()])
  return (
    <Box flexDirection="column" width={width} height={height}>
      <LinesView lines={lines} width={width} height={Math.max(1, height - 1)} active={focused} />
      <Text color={theme.color.dim} wrap="truncate-end">enter identity dialog {choices.map(c => `${theme.glyph.sep} ${c.key} ${c.label.toLowerCase()} `).join('')}{theme.glyph.sep} /identity</Text>
    </Box>
  )
}

function NetworkTab(props: TabProps) {
  const store = useStore()
  const actions = useActions()
  const ask = async (title: string, message: string, run: () => Promise<unknown>, done: string, reload: () => void) => {
    if (!await actions.confirm({ title, message, danger: true })) return
    const result = await actions.run(title, run)
    if (result !== undefined) actions.toast(done, 'success')
    reload()
  }
  return (
    <ReportTab
      {...props}
      kind="network"
      hint="m mesh · s web server on/off · R restart"
      onKey={(input, _key, reload) => {
        const client = store.client
        if (input === 'm') {
          void client.network().then(d => {
            const on = meshOn(d.mesh as unknown as Record<string, unknown>)
            void ask(on ? 'Turn the mesh off' : 'Turn the mesh on', on ? 'Agents stop reaching and serving each other over the mesh.' : 'Agents can reach and serve each other over the mesh.', () => client.setMesh(!on), on ? 'Mesh off' : 'Mesh on', reload)
          }, err => actions.toast(`Network: ${err instanceof Error ? err.message : String(err)}`, 'error'))
          return true
        }
        // The web server (serves agent sites / APIs, receives mesh messages):
        // starting needs no confirm, stopping asks (same as /web and the header badge).
        if (input === 's') {
          void toggleWebServer(store).then(reload)
          return true
        }
        if (input === 'R') {
          void client.meshServer().then(server => {
            if (!serverRunning(server)) { void toggleWebServer(store, true).then(reload); return }
            void ask('Restart the web server', 'Open connections drop and reconnect.', () => client.meshServerAction('restart'), 'Web server restarted', () => { reload(); void actions.refreshWeb() })
          }, err => actions.toast(`Web server: ${err instanceof Error ? err.message : String(err)}`, 'error'))
          return true
        }
        return false
      }}
    />
  )
}

function RuntimeView({ width: paneWidth, height, focused }: ViewProps) {
  const width = Math.max(10, paneWidth - 2)
  const theme = useTheme()
  const store = useStore()
  const [state, update] = useRuntimeState()
  const json = useStoreJson()
  const tab = state.tab

  useKeys((input, key) => {
    if (key.ctrl || key.meta || (key.shift && (key.leftArrow || key.rightArrow))) return false
    const at = RUNTIME_TABS.findIndex(t => t.id === tab)
    if (key.rightArrow || input === ']') { update({ tab: RUNTIME_TABS[(at + 1) % RUNTIME_TABS.length].id }); return true }
    if (key.leftArrow || input === '[') { update({ tab: RUNTIME_TABS[(at + RUNTIME_TABS.length - 1) % RUNTIME_TABS.length].id }); return true }
    return false
  }, { layer: 'view' })

  const bodyHeight = Math.max(1, height - 2)
  const props = { width, height: bodyHeight, focused }
  let body
  switch (tab) {
    case 'identity': body = <IdentityTab {...props} />; break
    case 'folders': body = <FoldersTab {...props} />; break
    case 'auth': body = <ReportTab key="auth" {...props} kind="auth" hint="enter sign in" onKey={(input, key) => { if (!key.return && input !== 'l') return false; openAuth(store.actions); return true }} />; break
    case 'network': body = <NetworkTab key="network" {...props} />; break
    case 'events': body = <EventsTab {...props} scope="all" filters={state.events} update={events => update({ events })} json={json} />; break
    default: body = <ReportTab key={tab} {...props} kind={tab} />
  }

  return (
    <Box flexDirection="column" width={paneWidth} height={height} paddingX={1}>
      <TabStrip tabs={RUNTIME_TABS} active={tab} width={width} lead={`daemon ${theme.glyph.pointer}`} />
      <Text color={theme.color.dim}>{theme.glyph.hbar.repeat(Math.max(1, width))}</Text>
      <Box flexDirection="column" height={bodyHeight} width={width} overflow="hidden">{body}</Box>
    </Box>
  )
}

const runtime: ViewDefinition = {
  id: RUNTIME_VIEW,
  title: 'Runtime',
  key: '6',
  component: RuntimeView,
  keyHints: [
    { keys: 'left right', label: 'tab' },
    { keys: 'r', label: 'refresh' },
    { keys: 'enter', label: 'open' },
  ],
  helpKeys: [
    { keys: [{ keys: 'left right', label: `The daemon’s tabs: ${RUNTIME_TABS.map(t => t.title).join(' ')} ([ ])` }] },
    {
      title: 'Pages',
      keys: [
        { keys: 'r', label: 'Reload the page' },
        { keys: 'enter', label: 'Identity: the identity dialog · Sign-in: the sign-in dialog' },
        { keys: 'c r u', label: 'Identity: create / restore / unlock (when offered)' },
        { keys: 'enter', label: 'Folders: the selected folder’s agents (loaded, needs review, errors): review + accept + load, or load' },
        { keys: 'a d', label: 'Folders: track a folder (its reviewed autostart agents load now) / stop tracking the selected one (asks; files untouched, optionally unload its agents)' },
        { keys: 'm', label: 'Network: mesh on / off (asks)' },
        { keys: 's', label: 'Network: web server (serves agent sites, APIs, mesh delivery) start / stop (stopping asks)' },
        { keys: 'R', label: 'Network: restart the web server (asks)' },
      ],
    },
    { title: 'Events (every agent’s live umbilical events)', keys: EVENT_KEYS },
  ],
  ...runtimeCommands,
}

export default runtime
