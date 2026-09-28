import { Box, Text } from 'ink'
import { useTheme, type Theme } from './theme'
import { useShell } from './shell-context'
import { useActiveView, useConnection, useIdentity, usePendingHilCount } from '../state/hooks'
import { useTuiSelector } from '../state/store'
import { readLayout } from './layout'
import { identityBadge } from '../identity/model'
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
export function headerLayout(width: number, titles: string[], status: number | { full: number; compact: number }, host: string): { tabs: TabStyle; host: string; compact: boolean } {
  const { full, compact } = typeof status === 'number' ? { full: status, compact: status } : status
  const left = (style: TabStyle) => 7 + titles.reduce((n, t) => n + 3 + (style === 'key' ? 0 : 1 + tabTitle(t, style).length) + 1, 0)
  const port = host.match(/:(\d+)$/)?.[0] ?? ''
  const fits = (style: TabStyle, right: number, shown: string) => left(style) + right + (shown ? 2 + shown.length : 0) + 1 <= width
  if (fits('full', full, host)) return { tabs: 'full', host, compact: false }
  if (port && fits('full', full, port)) return { tabs: 'full', host: port, compact: false }
  if (fits('full', full, '')) return { tabs: 'full', host: '', compact: false }
  if (fits('full', compact, '')) return { tabs: 'full', host: '', compact: true }
  if (fits('short', full, '')) return { tabs: 'short', host: '', compact: false }
  if (fits('short', compact, '')) return { tabs: 'short', host: '', compact: true }
  return { tabs: 'key', host: '', compact: true }
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
export function Header({ width }: { width: number }) {
  const theme = useTheme()
  const { views } = useShell()
  const active = useActiveView()
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
  const layout = headerLayout(width, views.map(v => v.title), { full: badgeText.length + rest.length, compact: (badge?.tone === 'warn' ? badgeText.length : 0) + rest.length }, url.replace(/^https?:\/\//, ''))
  const showBadge = !!badge && (!layout.compact || badge.tone === 'warn')

  return (
    <Box width={width} height={1} justifyContent="space-between" backgroundColor={theme.color.surface}>
      <Text wrap="truncate-end">
        <Text bold color={theme.color.accent} inverse={theme.mono}> {theme.glyph.wordmark} ADF </Text>
        {views.map(view => {
          const isActive = view.id === active
          return (
            <Text key={view.id}>
              <Text> </Text>
              <Text
                color={isActive ? theme.color.selectionFg : theme.color.muted}
                backgroundColor={isActive ? theme.color.accent : undefined}
                inverse={theme.mono && isActive}
                bold={isActive}
              >
                {layout.tabs === 'key' ? ` ${view.key} ` : ` ${view.key} ${tabTitle(view.title, layout.tabs)} `}
              </Text>
            </Text>
          )
        })}
      </Text>
      <Text wrap="truncate-start">
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
