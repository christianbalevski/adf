import { Box, Text } from 'ink'
import { useTheme } from '../app/theme'
import { displayWidth, truncate } from './text'

export interface TabSpec {
  id: string
  title: string
}

/**
 * The first..last tabs that fit `room` cells with `active` visible: the
 * strip slides so the active tab never falls off the end at 80 columns.
 */
export function tabWindow(labels: number[], active: number, room: number): { start: number; end: number } {
  let start = Math.max(0, active)
  let end = start
  let used = labels[start] ?? 0
  // Grow right first (tabs read left to right), then left.
  while (end + 1 < labels.length && used + labels[end + 1] <= room) used += labels[++end]
  while (start > 0 && used + labels[start - 1] <= room) used += labels[--start]
  return { start, end }
}

/**
 * One row: an optional bold lead (e.g. the agent), the tabs, and right-aligned
 * context. Tabs that do not fit are elided with ‹ › markers.
 */
export function TabStrip({ tabs, active, width, lead, right }: { tabs: readonly TabSpec[]; active: string; width: number; lead?: string; right?: string }) {
  const theme = useTheme()
  const leadText = lead ? `${lead} ` : ''
  const rightText = right ?? ''
  const rightWidth = rightText ? Math.min(displayWidth(rightText), Math.max(8, Math.floor(width / 3))) : 0
  const room = Math.max(8, width - displayWidth(leadText) - rightWidth - 4)
  const labels = tabs.map(t => ` ${t.title} `)
  const at = Math.max(0, tabs.findIndex(t => t.id === active))
  const { start, end } = tabWindow(labels.map(l => l.length), at, room)
  return (
    <Box width={width} justifyContent="space-between">
      <Text wrap="truncate-end">
        {leadText ? <Text bold color={theme.color.text}>{leadText}</Text> : null}
        <Text color={theme.color.dim}>{start > 0 ? (theme.ascii ? '<' : '‹') : ' '}</Text>
        {tabs.slice(start, end + 1).map((tab, i) => {
          const selected = start + i === at
          return (
            <Text key={tab.id} bold={selected} inverse={selected && theme.mono} underline={selected && !theme.mono} color={selected ? theme.color.accent : theme.color.muted}>
              {labels[start + i]}
            </Text>
          )
        })}
        <Text color={theme.color.dim}>{end < tabs.length - 1 ? (theme.ascii ? '>' : '›') : ' '}</Text>
      </Text>
      {rightText ? <Text color={theme.color.muted}>{truncate(rightText, rightWidth)}</Text> : null}
    </Box>
  )
}
