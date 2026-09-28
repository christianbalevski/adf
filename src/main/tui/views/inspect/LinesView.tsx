import { useEffect, useRef, useState } from 'react'
import { Box, Text, type DOMElement } from 'ink'
import { useTheme, type Theme } from '../../app/theme'
import { WHEEL_STEP, useKeys, useWheel, type KeyLayer } from '../../app/keys'
import { truncate } from '../../ui/text'
import type { Line, Tone } from './format'

export function toneColor(theme: Theme, tone: Tone | undefined): string | undefined {
  const c = theme.color
  switch (tone) {
    case 'key': return c.info
    case 'string': return c.text
    case 'number': return c.accent
    case 'bool': return c.live
    case 'null': return c.dim
    case 'muted': return c.muted
    case 'dim': return c.dim
    case 'heading': return c.accent
    case 'accent': return c.accent
    case 'loop': return c.loop
    case 'live': return c.live
    case 'success': return c.success
    case 'warn': return c.warn
    case 'error': return c.error
    default: return c.text
  }
}

export function LineText({ line, width }: { line: Line; width: number }) {
  const theme = useTheme()
  let room = Math.max(1, width)
  const parts: Array<{ text: string; tone?: Tone; bold?: boolean; mark?: boolean }> = []
  for (const seg of line) {
    if (room <= 0) break
    const text = seg.text.length > room ? truncate(seg.text, room) : seg.text
    room -= text.length
    parts.push({ ...seg, text })
  }
  return (
    <Text wrap="truncate-end">
      {parts.length === 0 ? ' ' : parts.map((seg, i) => (
        <Text key={i} color={toneColor(theme, seg.tone)} bold={seg.bold || (theme.mono && seg.tone === 'heading')} inverse={seg.mark}>{seg.text}</Text>
      ))}
    </Text>
  )
}

export interface LinesViewProps {
  lines: Line[]
  width: number
  height: number
  active?: boolean
  keyLayer?: KeyLayer
  /** Start at the bottom and stay there while new lines arrive (tail -f). */
  follow?: boolean
  emptyText?: string
}

/** Scrollable block of pre-formatted lines: ↑↓/jk, PgUp/PgDn, g/G. */
export function LinesView({ lines, width, height, active = true, keyLayer = 'main', follow = false, emptyText = 'Nothing to show.' }: LinesViewProps) {
  const theme = useTheme()
  const rows = Math.max(1, height - 1)
  const maxOffset = Math.max(0, lines.length - rows)
  const [offset, setOffset] = useState(follow ? maxOffset : 0)
  const [pinned, setPinned] = useState(follow)

  useEffect(() => {
    if (pinned) setOffset(maxOffset)
    else if (offset > maxOffset) setOffset(maxOffset)
  }, [maxOffset, pinned])

  const move = (next: number) => {
    const clamped = Math.max(0, Math.min(maxOffset, next))
    setOffset(clamped)
    setPinned(follow && clamped >= maxOffset)
  }

  const boxRef = useRef<DOMElement>(null)
  useWheel(boxRef, delta => move(offset + delta * WHEEL_STEP), { layer: keyLayer === 'overlay' ? 'overlay' : 'main' })

  useKeys((input, key) => {
    if (key.upArrow || (input === 'k' && !key.ctrl)) { move(offset - 1); return true }
    if (key.downArrow || (input === 'j' && !key.ctrl)) { move(offset + 1); return true }
    if (key.pageUp) { move(offset - rows); return true }
    if (key.pageDown || input === ' ') { move(offset + rows); return true }
    if (key.home || input === 'g') { move(0); return true }
    if (key.end || input === 'G') { move(maxOffset); setPinned(follow); return true }
    return false
  }, { layer: keyLayer, active })

  const at = Math.min(offset, maxOffset)
  const visible = lines.slice(at, at + rows)
  return (
    <Box ref={boxRef} flexDirection="column" width={width} height={height}>
      {lines.length === 0 ? <Text color={theme.color.muted}>{truncate(emptyText, width)}</Text> : null}
      {visible.map((line, i) => <LineText key={at + i} line={line} width={width} />)}
      <Box flexGrow={1} />
      {lines.length > rows ? (
        <Text color={theme.color.dim} wrap="truncate-end">
          {`${at + 1}-${Math.min(lines.length, at + rows)} of ${lines.length}${follow ? (pinned ? `  ${theme.glyph.sep} following` : `  ${theme.glyph.sep} G to follow`) : ''}`}
        </Text>
      ) : null}
    </Box>
  )
}
