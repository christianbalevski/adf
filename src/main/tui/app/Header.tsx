import { Box, Text } from 'ink'
import { useTheme, type Theme } from './theme'
import { useShell } from './shell-context'
import { useActiveView, useConnection, useFocus, useIdentity, usePendingHilCount } from '../state/hooks'
import { useTuiSelector } from '../state/store'
import { readLayout } from './layout'
import { identityBadge } from '../identity/model'
import { serverBadge } from '../web/model'
import { displayWidth } from '../ui/text'
import type { ConnectionInfo } from '../api/sse'

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

/**
 * What fits in the header at `width`: tab names win over the daemon host and
 * the owner badge. The host shrinks to its port, then goes; then the owner
 * badge goes (unless it warns); only then do tab names shorten
 * (`1 Flt 2 Chat …`), and bare digits are the last resort. `status` is the
 * right side's width, or its width with and without the badge.
 */
export function headerLayout(width: number, titles: string[], status: number | { full: number; compact: number }, host: string, web = 0): { tabs: TabStyle; host: string; compact: boolean; web: boolean } {
  const { full, compact } = typeof status === 'number' ? { full: status, compact: status } : status
  const left = (style: TabStyle) => WORDMARK_WIDTH + titles.reduce((n, t) => n + 3 + (style === 'key' ? 0 : 1 + tabTitle(t, style).length) + 1, 0)
  const port = host.match(/:(\d+)$/)?.[0] ?? ''
  const fits = (style: TabStyle, right: number, shown: string, withWeb = false) => left(style) + right + (withWeb && web ? web + 3 : 0) + (shown ? 2 + shown.length : 0) + 1 <= width
  // The web server badge (a control) outlasts the daemon host and a plain
  // owner badge, and goes before any view name shortens.
  if (web && fits('full', full, host, true)) return { tabs: 'full', host, compact: false, web: true }
  if (web && port && fits('full', full, port, true)) return { tabs: 'full', host: port, compact: false, web: true }
  if (web && fits('full', full, '', true)) return { tabs: 'full', host: '', compact: false, web: true }
  if (web && fits('full', compact, '', true)) return { tabs: 'full', host: '', compact: true, web: true }
  if (fits('full', full, host)) return { tabs: 'full', host, compact: false, web: false }
  if (port && fits('full', full, port)) return { tabs: 'full', host: port, compact: false, web: false }
  if (fits('full', full, '')) return { tabs: 'full', host: '', compact: false, web: false }
  if (fits('full', compact, '')) return { tabs: 'full', host: '', compact: true, web: false }
  if (fits('short', full, '')) return { tabs: 'short', host: '', compact: false, web: false }
  if (fits('short', compact, '')) return { tabs: 'short', host: '', compact: true, web: false }
  return { tabs: 'key', host: '', compact: true, web: false }
}

const WORDMARK_WIDTH = 7

/** Where things sit on the header row (cells), for mouse clicks. Filled by <Header> on each render. */
export interface HeaderHits {
  tabs: Array<{ id: string; x0: number; x1: number }>
  web: { x0: number; x1: number } | null
}

export function createHeaderHits(): HeaderHits {
  return { tabs: [], web: null }
}

/** The view tab label at a style: ` 2 Chat ` / ` 2 `. */
export function tabLabel(key: string, title: string, style: TabStyle): string {
  return style === 'key' ? ` ${key} ` : ` ${key} ${tabTitle(title, style)} `
}

const SHORT_TITLES: Record<string, string> = { Fleet: 'Flt', Files: 'File', Loops: 'Loop', Inspect: 'Insp', Runtime: 'Rt' }

function tabTitle(title: string, style: TabStyle): string {
  return style === 'short' ? SHORT_TITLES[title] ?? title.slice(0, 4) : title
}

/**
 * Top bar: wordmark, view tabs, pending HIL badge, daemon URL + connection
 * dot. With the sidebar hidden it also carries what only the sidebar showed:
 * unread inbox messages (pending approvals are always here).
 */
export function Header({ width, hits }: { width: number; hits?: HeaderHits }) {
  const theme = useTheme()
  const { views } = useShell()
  const active = useActiveView()
  const focus = useFocus()
  const overlayOpen = useTuiSelector(s => s.overlays.length > 0)
  const tabsFocused = focus === 'tabs' && !overlayOpen
  const web = serverBadge(useTuiSelector(s => s.web?.server))
  const { info, reachable, url } = useConnection()
  const pending = usePendingHilCount()
  const badge = identityBadge(useIdentity())
  const conn = connectionLabel(info, reachable)
  const sidebarHidden = useTuiSelector(s => readLayout(s).sidebarHidden)
  const unread = useTuiSelector(s => (readLayout(s).sidebarHidden ? s.agentOrder.reduce((n, id) => n + (s.agents[id]?.unreadInbox ?? 0), 0) : 0))
  const unreadText = sidebarHidden && unread > 0 ? `«${unread} unread  ` : ''
  const rest = `${pending > 0 ? `${theme.glyph.warn}${pending} pending  ` : ''}${unreadText}${theme.glyph.dot} ${conn.text}`
  // A badge that warns (not backed up, locked, no owner) stays; a plain one yields to the view names.
  const badgeText = badge ? `${badge.text}  ` : ''
  const webText = web ? `${web.running ? theme.glyph.dot : theme.glyph.ring} ${web.text}` : ''
  const layout = headerLayout(width, views.map(v => v.title), { full: badgeText.length + rest.length, compact: (badge?.tone === 'warn' ? badgeText.length : 0) + rest.length }, url.replace(/^https?:\/\//, ''), displayWidth(webText))
  const showBadge = !!badge && (!layout.compact || badge.tone === 'warn')
  const showWeb = !!web && layout.web

  if (hits) {
    let x = WORDMARK_WIDTH
    hits.tabs = views.map(view => {
      const w = displayWidth(tabLabel(view.key, view.title, layout.tabs))
      const range = { id: view.id, x0: x + 1, x1: x + 1 + w }
      x += 1 + w
      return range
    })
    // The right group is right-aligned and ends with one space; the web badge leads it.
    const rightWidth = (showWeb ? displayWidth(webText) + 2 : 0) + (showBadge ? displayWidth(badgeText) : 0) + displayWidth(rest) + (layout.host ? 2 + displayWidth(layout.host) : 0) + 1
    hits.web = showWeb ? { x0: width - rightWidth, x1: width - rightWidth + displayWidth(webText) } : null
  }

  return (
    <Box width={width} height={1} justifyContent="space-between" backgroundColor={theme.color.surface}>
      <Text wrap="truncate-end">
        <Text bold color={theme.color.accent} inverse={theme.mono}> {theme.glyph.wordmark} ADF </Text>
        {views.map(view => {
          const isActive = view.id === active
          // Focused tab bar (Esc): the current tab turns teal and underlined, the others brighten.
          const focusedTab = isActive && tabsFocused
          return (
            <Text key={view.id}>
              <Text> </Text>
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
        })}
      </Text>
      <Text wrap="truncate-start">
        {showWeb && web ? <Text color={web.running ? theme.color.live : theme.color.dim}>{webText}  </Text> : null}
        {badge && showBadge ? <Text color={badge.tone === 'warn' ? theme.color.warn : theme.color.dim}>{badge.text}  </Text> : null}
        {pending > 0 ? <Text bold color={theme.color.warn}>{theme.glyph.warn}{pending} pending  </Text> : null}
        {unreadText ? <Text color={theme.color.info}>{unreadText}</Text> : null}
        <Text color={toneColor(theme, conn.tone)}>{theme.glyph.dot} {conn.text}</Text>
        {layout.host ? <Text color={theme.color.dim}>  {layout.host}</Text> : null}
        <Text> </Text>
      </Text>
    </Box>
  )
}
