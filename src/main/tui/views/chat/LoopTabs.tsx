// Slim strip of an agent's loops (main first, then inner loops): state,
// pending approvals and unseen activity at a glance.

import { Box, Text } from 'ink'
import { useTheme } from '../../app/theme'
import { displayWidth, truncate } from '../../ui/text'
import type { LoopTab } from './model'

export interface LoopTabsProps {
  agentLabel: string
  tabs: LoopTab[]
  selected: string
  unseen: Set<string>
  pending: Set<string>
  width: number
}

interface Seg {
  name: string
  text: string
  width: number
}

export function LoopTabs({ agentLabel, tabs, selected, unseen, pending, width }: LoopTabsProps) {
  const theme = useTheme()
  const g = theme.glyph
  const stateGlyph = (tab: LoopTab) => (!tab.enabled ? g.cross : tab.running ? g.dot : g.ring)
  const segs: Seg[] = tabs.map(tab => {
    const marks = `${pending.has(tab.name) ? ` ${g.warn}` : ''}${unseen.has(tab.name) && tab.name !== selected ? ` ${g.bullet}` : ''}`
    const text = ` ${stateGlyph(tab)} ${tab.name}${marks} `
    return { name: tab.name, text, width: displayWidth(text) }
  })

  const head = truncate(agentLabel, Math.max(6, Math.floor(width / 4)))
  const hint = tabs.length > 1 ? ` Shift+${g.arrow === '->' ? '<-' : '←'}/${g.arrow} ` : ''
  const room = Math.max(8, width - displayWidth(head) - 3 - displayWidth(hint))

  // Keep the selected tab visible: grow a window around it.
  const at = Math.max(0, segs.findIndex(s => s.name === selected))
  let first = at
  let last = at
  let used = segs[at]?.width ?? 0
  for (let grew = true; grew;) {
    grew = false
    if (last + 1 < segs.length && used + segs[last + 1].width + 2 <= room) { last++; used += segs[last].width; grew = true }
    if (first > 0 && used + segs[first - 1].width + 2 <= room) { first--; used += segs[first].width; grew = true }
  }

  const tabColor = (tab: LoopTab) => (!tab.enabled ? theme.color.dim : tab.running ? theme.color.live : tab.name === 'main' ? theme.color.accent : theme.color.loop)
  return (
    <Box width={width} height={1} flexDirection="row" justifyContent="space-between">
      <Text wrap="truncate-end">
        <Text bold color={theme.color.text}>{head}</Text>
        <Text color={theme.color.dim}> {g.pointer} </Text>
        {first > 0 ? <Text color={theme.color.dim}>{g.ellipsis}</Text> : null}
        {segs.slice(first, last + 1).map((seg, i) => {
          const tab = tabs[first + i]
          const isSel = seg.name === selected
          return (
            <Text
              key={seg.name}
              bold={isSel}
              underline={isSel && theme.mono}
              inverse={isSel && theme.mono}
              color={isSel ? theme.color.selectionFg : tabColor(tab)}
              backgroundColor={isSel ? theme.color.selectionBg : undefined}
            >
              {seg.text}
            </Text>
          )
        })}
        {last < segs.length - 1 ? <Text color={theme.color.dim}>{g.ellipsis}</Text> : null}
      </Text>
      {hint ? <Text color={theme.color.dim}>{hint}</Text> : null}
    </Box>
  )
}
