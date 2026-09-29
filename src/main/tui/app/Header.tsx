import { Box, Text } from 'ink'
import { useTheme, type Theme } from './theme'
import { useShell } from './shell-context'
import { useActiveView, useConnection, useFocus, useIdentity, usePendingHilCount, useSelectedAgent, useSelectedLoop, useSelectedTracked } from '../state/hooks'
import { useTuiSelector } from '../state/store'
import { readLayout } from './layout'
import { identityBadge } from '../identity/model'
import { serverBadge } from '../web/model'
import { displayWidth, truncate } from '../ui/text'
import { MAIN_LOOP } from '../api/types'
import type { ConnectionInfo } from '../api/sse'
import type { TuiState } from '../state/types'
import type { ViewDefinition } from '../views/types'

export function connectionLabel(info: ConnectionInfo, reachable: boolean | null): { text: string; tone: 'ok' | 'warn' | 'error' | 'muted' } {
  switch (info.state) {
    case 'open':
      return { text: 'live', tone: 'ok' }
    case 'connecting':
      return { text: 'connecting', tone: 'muted' }
    case 'reconnecting':
      if (reachable === false) return { text: 'offline', tone: 'error' }
      return { text: info.attempt > 0 ? `retry ${info.attempt}` : 'reconnecting', tone: 'warn' }
    case 'closed':
      return { text: 'closed', tone: 'muted' }
    default:
      return { text: reachable === false ? 'offline' : 'idle', tone: reachable === false ? 'error' : 'muted' }
  }
}

export function toneColor(theme: Theme, tone: 'ok' | 'warn' | 'error' | 'muted'): string | undefined {
  return tone === 'ok' ? theme.color.success : tone === 'warn' ? theme.color.warn : tone === 'error' ? theme.color.error : theme.color.muted
}

export type TabStyle = 'full' | 'short' | 'key'

export interface HeaderFit { tabs: TabStyle; host: string; compact: boolean; web: boolean; minimal: boolean }

/**
 * What fits in the header at `width`: tab names win over the daemon host and
 * the owner badge. The host shrinks to its port, then goes; then the owner
 * badge goes (unless it warns); only then do tab names shorten
 * (`1 Chat 2 File …`); then the pending / unread badges drop their words
 * (`!1`); bare digits are the last resort. `status` is the right side's
 * width, or its width with and without the badge (and with bare counts).
 * `extra` is what the left side needs besides the wordmark and the tabs (the
 * agent group's label at its narrowest).
 */
export function headerLayout(width: number, titles: string[], status: number | { full: number; compact: number; minimal?: number }, host: string, web = 0, extra = 0): HeaderFit {
  const { full, compact, minimal = compact } = typeof status === 'number' ? { full: status, compact: status, minimal: status } : status
  const left = (style: TabStyle) => WORDMARK_WIDTH + extra + titles.reduce((n, t) => n + 3 + (style === 'key' ? 0 : 1 + tabTitle(t, style).length) + 1, 0)
  const port = host.match(/:(\d+)$/)?.[0] ?? ''
  const fits = (style: TabStyle, right: number, shown: string, withWeb = false) => left(style) + right + (withWeb && web ? web + 3 : 0) + (shown ? 2 + shown.length : 0) + 1 <= width
  const fit = (tabs: TabStyle, shown: string, compactRight: boolean, withWeb: boolean, bare = false): HeaderFit => ({ tabs, host: shown, compact: compactRight, web: withWeb, minimal: bare })
  // The web server badge (a control) outlasts the daemon host and a plain
  // owner badge, and goes before any view name shortens.
  if (web && fits('full', full, host, true)) return fit('full', host, false, true)
  if (web && port && fits('full', full, port, true)) return fit('full', port, false, true)
  if (web && fits('full', full, '', true)) return fit('full', '', false, true)
  if (web && fits('full', compact, '', true)) return fit('full', '', true, true)
  if (fits('full', full, host)) return fit('full', host, false, false)
  if (port && fits('full', full, port)) return fit('full', port, false, false)
  if (fits('full', full, '')) return fit('full', '', false, false)
  if (fits('full', compact, '')) return fit('full', '', true, false)
  if (fits('short', full, '')) return fit('short', '', false, false)
  if (fits('short', compact, '')) return fit('short', '', true, false)
  if (fits('short', minimal, '')) return fit('short', '', true, false, true)
  return fit('key', '', true, false, true)
}

const WORDMARK_WIDTH = 7

/** Where things sit on the header row (cells), for mouse clicks. Filled by <Header> on each render. */
export interface HeaderHits {
  tabs: Array<{ id: string; x0: number; x1: number }>
  web: { x0: number; x1: number } | null
  /** The agent group's label (opens the agent switcher). */
  agent: { x0: number; x1: number } | null
}

export function createHeaderHits(): HeaderHits {
  return { tabs: [], web: null, agent: null }
}

/**
 * The tab bar's order: the selected agent's views (group `agent`) first, then
 * the app's own views. `grouped` is false for a view list without an agent
 * group (then no agent label is shown).
 */
export function tabOrder(views: ViewDefinition[]): { grouped: boolean; agent: ViewDefinition[]; app: ViewDefinition[]; all: ViewDefinition[] } {
  const agent = views.filter(v => v.group === 'agent')
  if (agent.length === 0) return { grouped: false, agent: [], app: views, all: views }
  const app = views.filter(v => v.group !== 'agent')
  return { grouped: true, agent, app, all: [...agent, ...app] }
}

/** viewState slot: 'agent' while the tab bar's cursor sits on the agent label. */
export const TABS_CURSOR_KEY = 'shell.tabs.cursor'

export function tabsCursorOnAgent(state: TuiState): boolean {
  return state.focus === 'tabs' && state.viewState[TABS_CURSOR_KEY] === 'agent'
}

/**
 * The agent group's label: ` agent-1 ›`, or ` agent-1 › researcher` for an
 * inner loop, fitted into `room` cells (the loop shortens first, then goes,
 * then the name shortens). Leading space included.
 */
export function agentLabelText(name: string | null, loop: string | null, room: number, pointer: string, ellipsis = '…'): string {
  if (!name) return ' no agent'
  const base = ` ${name} ${pointer}`
  const full = loop ? `${base} ${loop}` : base
  if (displayWidth(full) <= room) return full
  if (loop && room - displayWidth(base) - 1 >= 4) return `${base} ${truncate(loop, room - displayWidth(base) - 1, ellipsis)}`
  if (displayWidth(base) <= room) return base
  return ` ${truncate(name, Math.max(2, room - 2 - displayWidth(pointer)), ellipsis)} ${pointer}`
}

/** The narrowest the label gets: the name cut to 8 cells, no loop. */
export function agentLabelMin(name: string | null, pointer: string): number {
  if (!name) return displayWidth(' no agent')
  return 1 + Math.min(8, displayWidth(name)) + 1 + displayWidth(pointer)
}

/** The view tab label at a style: ` 1 Chat ` / ` 1 `. */
export function tabLabel(key: string, title: string, style: TabStyle): string {
  return style === 'key' ? ` ${key} ` : ` ${key} ${tabTitle(title, style)} `
}

const SHORT_TITLES: Record<string, string> = { Fleet: 'Flt', Files: 'File', Loops: 'Loop', Inspect: 'Insp', Runtime: 'Rt' }

function tabTitle(title: string, style: TabStyle): string {
  return style === 'short' ? SHORT_TITLES[title] ?? title.slice(0, 4) : title
}

/**
 * Top bar: wordmark; the selected agent's views, introduced by its agent ›
 * loop label; a quiet separator and the app's own views; then web server,
 * owner badge, pending approvals, the connection dot and daemon host. With the
 * sidebar hidden it also carries what only the sidebar showed: unread inbox
 * messages (pending approvals are always here).
 */
export function Header({ width, hits }: { width: number; hits?: HeaderHits }) {
  const theme = useTheme()
  const { views } = useShell()
  const order = tabOrder(views)
  const active = useActiveView()
  const focus = useFocus()
  const overlayOpen = useTuiSelector(s => s.overlays.length > 0)
  const tabsFocused = focus === 'tabs' && !overlayOpen
  const onAgent = useTuiSelector(tabsCursorOnAgent) && tabsFocused && order.grouped
  const selected = useSelectedAgent()
  const stopped = useSelectedTracked()
  const loop = useSelectedLoop()
  const agentName = selected ? selected.summary.handle || selected.summary.name : stopped ? stopped.agent.name : null
  const agentLoop = selected && loop !== MAIN_LOOP ? loop : null
  const web = serverBadge(useTuiSelector(s => s.web?.server))
  const { info, reachable, url } = useConnection()
  const pending = usePendingHilCount()
  const badge = identityBadge(useIdentity())
  const conn = connectionLabel(info, reachable)
  const sidebarHidden = useTuiSelector(s => readLayout(s).sidebarHidden)
  const unread = useTuiSelector(s => (readLayout(s).sidebarHidden ? s.agentOrder.reduce((n, id) => n + (s.agents[id]?.unreadInbox ?? 0), 0) : 0))
  const unreadCount = sidebarHidden && unread > 0 ? `«${unread}` : ''
  const pendingCount = pending > 0 ? `${theme.glyph.warn}${pending}` : ''
  const connText = `${theme.glyph.dot} ${conn.text}`
  // Bare counts (`!1 «2`) when even short view names would not fit otherwise.
  const restText = (bare: boolean) => `${pendingCount ? `${pendingCount}${bare ? '' : ' pending'}  ` : ''}${unreadCount ? `${unreadCount}${bare ? '' : ' unread'}  ` : ''}${connText}`
  // A badge that warns (not backed up, locked, no owner) stays; a plain one yields to the view names.
  const badgeText = badge ? `${badge.text}  ` : ''
  const warnBadge = badge?.tone === 'warn' ? displayWidth(badgeText) : 0
  const webText = web ? `${web.running ? theme.glyph.dot : theme.glyph.ring} ${web.text}` : ''
  const labelMin = order.grouped ? agentLabelMin(agentName, theme.glyph.pointer) : 0
  const labelFull = order.grouped ? displayWidth(agentLabelText(agentName, agentLoop, Infinity, theme.glyph.pointer)) : 0
  const fitWith = (extra: number) => headerLayout(
    width,
    order.all.map(v => v.title),
    { full: displayWidth(badgeText) + displayWidth(restText(false)), compact: warnBadge + displayWidth(restText(false)), minimal: warnBadge + displayWidth(restText(true)) },
    url.replace(/^https?:\/\//, ''),
    displayWidth(webText),
    extra,
  )
  // The whole agent › loop label outlasts the badges; the view names outlast the label.
  const whole = fitWith(labelFull)
  const layout = whole.tabs === 'full' ? whole : fitWith(labelMin)
  const showBadge = !!badge && (!layout.compact || badge.tone === 'warn')
  const showWeb = !!web && layout.web
  const rest = restText(layout.minimal)
  const tabsWidth = order.all.reduce((n, v) => n + 1 + displayWidth(tabLabel(v.key, v.title, layout.tabs)), 0)
  // The right group is right-aligned and ends with one space; the web badge leads it.
  const rightWidth = (showWeb ? displayWidth(webText) + 2 : 0) + (showBadge ? displayWidth(badgeText) : 0) + displayWidth(rest) + (layout.host ? 2 + displayWidth(layout.host) : 0) + 1
  const label = order.grouped ? agentLabelText(agentName, agentLoop, Math.max(labelMin, width - WORDMARK_WIDTH - tabsWidth - rightWidth - 1), theme.glyph.pointer, theme.glyph.ellipsis) : ''
  const labelWidth = displayWidth(label)

  if (hits) {
    let x = WORDMARK_WIDTH + labelWidth
    hits.agent = order.grouped ? { x0: WORDMARK_WIDTH, x1: WORDMARK_WIDTH + labelWidth } : null
    hits.tabs = order.all.map(view => {
      const w = displayWidth(tabLabel(view.key, view.title, layout.tabs))
      const range = { id: view.id, x0: x + 1, x1: x + 1 + w }
      x += 1 + w
      return range
    })
    hits.web = showWeb ? { x0: width - rightWidth, x1: width - rightWidth + displayWidth(webText) } : null
  }

  // The first app view's gap is the group separator (same width as a gap).
  const renderTab = (view: ViewDefinition, separated: boolean) => {
    const isActive = view.id === active
    // Focused tab bar (Esc): the current tab turns teal and underlined, the others brighten.
    const focusedTab = isActive && tabsFocused && !onAgent
    return (
      <Text key={view.id}>
        {separated ? <Text color={theme.color.dim}>{theme.glyph.vbar}</Text> : <Text> </Text>}
        <Text
          color={isActive ? theme.color.selectionFg : tabsFocused ? theme.color.text : theme.color.muted}
          backgroundColor={focusedTab ? theme.color.live : isActive ? theme.color.accent : undefined}
          inverse={theme.mono && isActive}
          underline={focusedTab}
          bold={isActive}
        >
          {tabLabel(view.key, view.title, layout.tabs)}
        </Text>
      </Text>
    )
  }

  return (
    <Box width={width} height={1} justifyContent="space-between" backgroundColor={theme.color.surface}>
      <Text wrap="truncate-end">
        <Text bold color={theme.color.accent} inverse={theme.mono}> {theme.glyph.wordmark} ADF </Text>
        {!order.grouped ? null : onAgent ? (
          <Text color={theme.color.selectionFg} backgroundColor={theme.color.live} inverse={theme.mono} underline bold>{label}</Text>
        ) : (
          <Text color={agentName ? theme.color.accent : theme.color.dim} bold={!!agentName}>{label}</Text>
        )}
        {order.agent.map(view => renderTab(view, false))}
        {order.app.map((view, i) => renderTab(view, order.grouped && i === 0))}
      </Text>
      <Text wrap="truncate-start">
        {showWeb && web ? <Text color={web.running ? theme.color.live : theme.color.dim}>{webText}  </Text> : null}
        {badge && showBadge ? <Text color={badge.tone === 'warn' ? theme.color.warn : theme.color.dim}>{badge.text}  </Text> : null}
        {pendingCount ? <Text bold color={theme.color.warn}>{pendingCount}{layout.minimal ? '' : ' pending'}  </Text> : null}
        {unreadCount ? <Text color={theme.color.info}>{unreadCount}{layout.minimal ? '' : ' unread'}  </Text> : null}
        <Text color={toneColor(theme, conn.tone)}>{connText}</Text>
        {layout.host ? <Text color={theme.color.dim}>  {layout.host}</Text> : null}
        <Text> </Text>
      </Text>
    </Box>
  )
}
