// The composer's top border with the selected agent's status line (adf_meta
// `status`) inset on the right, like a sticky note:
// `╭──────────── Quiet; next 44 30 Sep 07:00Z ─╮`. It only takes border cells;
// a click on it (mouse mode) opens Inspect › Status.

import { useRef } from 'react'
import { Box, Text, type DOMElement } from 'ink'
import { useTheme } from './theme'
import { useClick } from './keys'
import { useStore, useTuiSelector } from '../state/store'
import { displayWidth, oneLine, truncate } from '../ui/text'
import { INSPECT_VIEW, patchInspectState } from '../views/inspect/state'

/** The badge's share of the composer width, at most. */
export const BADGE_MAX_SHARE = 0.4

/**
 * The inset text for a status line at a composer `width` (border included):
 * ` status ` (colour) or `[ status ]` (mono), cut with … to 40% of the width;
 * null when there is no status or no room for a readable badge.
 */
export function statusBadgeText(status: string | undefined, width: number, mono: boolean, ellipsis = '…'): string | null {
  const text = oneLine(status ?? '').trim()
  if (!text) return null
  const pad = mono ? 4 : 2
  const room = Math.min(Math.floor(width * BADGE_MAX_SHARE), width - 5) - pad
  if (room < 4) return null
  const shown = truncate(text, room, ellipsis)
  return mono ? `[ ${shown} ]` : ` ${shown} `
}

/**
 * The status line to show: the selected agent's (inner loops carry no status
 * line of their own, so an inner loop shows its agent's).
 */
export function useComposerStatus(): string | undefined {
  return useTuiSelector(s => (s.selectedAgentId ? s.web?.agents[s.selectedAgentId]?.status : undefined))
}

/** The top border row; `badge` null draws a plain border. */
export function ComposerTop({ width, focused, badge }: { width: number; focused: boolean; badge: string | null }) {
  const theme = useTheme()
  const store = useStore()
  const ref = useRef<DOMElement>(null)
  useClick(ref, () => {
    if (!badge) return false
    const state = store.getState()
    if (!state.selectedAgentId) return false
    patchInspectState(store.actions, state, { tab: 'diag' })
    store.actions.setView(INSPECT_VIEW)
    return true
  }, { active: !!badge })
  const [left, fill, right] = theme.ascii ? ['+', '-', '+'] : ['╭', '─', '╮']
  const color = focused ? theme.color.borderFocus : theme.color.border
  const badgeWidth = badge ? displayWidth(badge) : 0
  const dashes = Math.max(0, width - 2 - badgeWidth - (badge ? 1 : 0))
  return (
    <Box width={width} height={1} flexDirection="row">
      <Text color={color}>{left}{fill.repeat(dashes)}</Text>
      {badge ? (
        <Box ref={ref} flexShrink={0}>
          <Text color={theme.mono ? undefined : theme.color.selectionFg} backgroundColor={theme.mono ? undefined : theme.color.accent} bold={theme.mono}>{badge}</Text>
        </Box>
      ) : null}
      <Text color={color}>{badge ? fill : ''}{right}</Text>
    </Box>
  )
}
