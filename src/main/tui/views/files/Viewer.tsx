// Read-only content pane: line numbers, wrap, syntax-light styling, scroll,
// `/` search with n/N, binary files as a hex dump. Shared by the files tab
// and the inbox/outbox/meta detail panes.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Box, Text, type DOMElement } from 'ink'
import { useTheme, type Theme } from '../../app/theme'
import { WHEEL_STEP, useKeys, useWheel } from '../../app/keys'
import { truncate } from '../../ui/text'
import {
  findMatches, formatBytes, hexDump, markRanges, prepareContent, styleLines, wrapSegments,
  type Lang, type Segment, type Tone,
} from './model'

export interface ViewerProps {
  width: number
  height: number
  /** Keys reach the viewer (its pane is focused). */
  active: boolean
  title: string
  /** Badges after the title (size, protection, …). */
  meta?: string[]
  /** Highlighted note under the title (e.g. "written by ↻ consolidator 3s ago"). */
  notice?: string
  /** Name used to pick the syntax (extension), e.g. `notes/api.md`. */
  name: string
  text?: string
  bytes?: Uint8Array
  mime?: string | null
  loading?: boolean
  error?: string
  /** Hide line numbers (message bodies). */
  plain?: boolean
  /** Changing it resets scroll and search. */
  resetKey: string
  onBack?: () => void
  onEdit?: () => void
  emptyText?: string
}

interface Row {
  line: number
  first: boolean
  segments: Segment[]
}

function toneColor(theme: Theme, tone: Tone | undefined): string | undefined {
  switch (tone) {
    case 'muted': return theme.color.muted
    case 'dim': return theme.color.dim
    case 'accent': return theme.color.accent
    case 'live': return theme.color.live
    case 'info': return theme.color.info
    case 'success': return theme.color.success
    case 'warn': return theme.color.warn
    case 'loop': return theme.color.loop
    default: return theme.color.text
  }
}

export function Viewer(props: ViewerProps) {
  const { width, height, active, title, meta = [], notice, name, text, bytes, mime, loading, error, plain = false, resetKey, onBack, onEdit, emptyText } = props
  const theme = useTheme()
  const [top, setTop] = useState(0)
  const [query, setQuery] = useState('')
  const [typing, setTyping] = useState(false)
  const [current, setCurrent] = useState(0)

  useEffect(() => {
    setTop(0)
    setQuery('')
    setTyping(false)
    setCurrent(0)
  }, [resetKey])

  const binary = bytes !== undefined
  const prepared = useMemo(() => {
    if (binary) return { lines: hexDump(bytes!), lang: 'text' as Lang, pretty: false }
    return prepareContent(text ?? '', name)
  }, [text, bytes, name, binary])

  const matches = useMemo(() => findMatches(prepared.lines, query), [prepared, query])
  const currentIndex = matches.length ? Math.min(current, matches.length - 1) : -1

  const gutter = plain ? 0 : String(prepared.lines.length).length + 1
  const bodyWidth = Math.max(4, width - gutter - 1)
  const { rows, lineStart } = useMemo(() => {
    const styled = styleLines(prepared.lines, prepared.lang)
    const byLine = new Map<number, Array<{ start: number; end: number; current: boolean }>>()
    matches.forEach((m, i) => {
      const list = byLine.get(m.line) ?? []
      list.push({ start: m.start, end: m.end, current: i === currentIndex })
      byLine.set(m.line, list)
    })
    const out: Row[] = []
    const starts: number[] = []
    styled.forEach((segments, line) => {
      starts.push(out.length)
      const marked = markRanges(segments, byLine.get(line) ?? [])
      wrapSegments(marked, bodyWidth).forEach((segs, i) => out.push({ line, first: i === 0, segments: segs }))
    })
    return { rows: out, lineStart: starts }
  }, [prepared, matches, currentIndex, bodyWidth])

  const headerRows = 1 + (notice ? 1 : 0) + (binary ? 1 : 0)
  const footerRows = 1
  const bodyRows = Math.max(1, height - headerRows - footerRows)
  const maxTop = Math.max(0, rows.length - bodyRows)
  const clampedTop = Math.min(top, maxTop)

  const scrollTo = (next: number) => setTop(Math.max(0, Math.min(maxTop, next)))
  const reveal = (index: number) => {
    const m = matches[index]
    if (!m) return
    const row = lineStart[m.line] ?? 0
    if (row < clampedTop || row >= clampedTop + bodyRows) scrollTo(row - Math.floor(bodyRows / 3))
  }
  const jump = (delta: number) => {
    if (matches.length === 0) return
    const next = (currentIndex + delta + matches.length) % matches.length
    setCurrent(next)
    reveal(next)
  }

  useEffect(() => {
    if (typing && matches.length > 0) {
      const firstVisible = matches.findIndex(m => (lineStart[m.line] ?? 0) >= clampedTop)
      const index = firstVisible >= 0 ? firstVisible : 0
      setCurrent(index)
      reveal(index)
    }
  }, [query])

  useKeys((input, key) => {
    if (typing) {
      if (key.escape) { setTyping(false); setQuery(''); return true }
      if (key.return) { setTyping(false); return true }
      if (key.backspace || key.delete) { setQuery(q => q.slice(0, -1)); return true }
      // ←/→ would switch the view's tabs: not while typing a search.
      if ((key.leftArrow || key.rightArrow) && !key.ctrl && !key.shift) return true
      if (input && !key.ctrl && !key.meta && !/[\r\n\t]/.test(input)) { setQuery(q => q + input); return true }
      return false
    }
    if ((key.ctrl || key.shift) && (key.leftArrow || key.rightArrow)) return false
    if (key.upArrow || (input === 'k' && !key.ctrl)) { scrollTo(clampedTop - 1); return true }
    if (key.downArrow || (input === 'j' && !key.ctrl)) { scrollTo(clampedTop + 1); return true }
    if (key.pageUp || (key.ctrl && input === 'u')) { scrollTo(clampedTop - Math.max(1, bodyRows - 1)); return true }
    if (key.pageDown || input === ' ' || (key.ctrl && input === 'd')) { scrollTo(clampedTop + Math.max(1, bodyRows - 1)); return true }
    if (key.home || input === 'g') { scrollTo(0); return true }
    if (key.end || input === 'G') { scrollTo(maxTop); return true }
    if (input === '/') { setTyping(true); setQuery(''); return true }
    if (input === 'n' && query) { jump(1); return true }
    if (input === 'N' && query) { jump(-1); return true }
    if (input === 'e' && onEdit) { onEdit(); return true }
    if (key.escape && query) { setQuery(''); return true }
    // Back to the list: Backspace or Esc (←/→ are the view's tabs).
    if ((key.escape || (key.backspace && !key.ctrl && !key.meta)) && onBack) { onBack(); return true }
    return false
  }, { layer: 'main', active })

  const boxRef = useRef<DOMElement>(null)
  useWheel(boxRef, delta => scrollTo(clampedTop + delta * WHEEL_STEP))

  const visible = rows.slice(clampedTop, clampedTop + bodyRows)
  const lastLine = visible.length ? visible[visible.length - 1].line + 1 : 0
  const firstLine = visible.length ? visible[0].line + 1 : 0
  const position = rows.length === 0 ? '' : `L${firstLine}-${lastLine}/${prepared.lines.length}${maxTop > 0 ? ` ${Math.round((clampedTop / maxTop) * 100)}%` : ''}`
  const search = typing
    ? `/${query}`
    : query
      ? `/${query}  ${matches.length ? `${currentIndex + 1}/${matches.length}` : 'no match'}  n/N`
      : ''

  const header = (
    <Text wrap="truncate-end">
      <Text bold color={active ? theme.color.accent : theme.color.text} inverse={theme.mono && active}>{truncate(title, Math.max(8, width - 20))}</Text>
      {[...meta, ...(prepared.pretty ? ['pretty-printed'] : [])].map(m => (
        <Text key={m} color={theme.color.muted}> {theme.glyph.sep} {m}</Text>
      ))}
    </Text>
  )

  let body: ReactNode
  if (loading) body = <Text color={theme.color.muted}>Loading{theme.glyph.ellipsis}</Text>
  else if (error) body = <Text color={theme.color.error} wrap="wrap">{error}</Text>
  else if (!binary && (text ?? '') === '') body = <Text color={theme.color.muted}>{emptyText ?? '(empty)'}</Text>
  else {
    body = (
      <>
        {visible.map((row, i) => (
          <Text key={clampedTop + i} wrap="truncate-end">
            {gutter > 0 ? (
              <Text color={theme.color.dim}>{(row.first ? String(row.line + 1) : '').padStart(gutter - 1)} </Text>
            ) : null}
            {row.segments.length === 0 ? ' ' : row.segments.map((seg, j) => (
              <Text
                key={j}
                color={seg.match === 'current' ? theme.color.selectionFg : toneColor(theme, seg.tone)}
                backgroundColor={seg.match === 'current' ? theme.color.selectionBg : undefined}
                inverse={seg.match === 'hit' || (seg.match === 'current' && theme.mono)}
                bold={seg.bold || seg.match === 'current'}
                italic={seg.italic}
              >
                {seg.text}
              </Text>
            ))}
          </Text>
        ))}
      </>
    )
  }

  return (
    <Box ref={boxRef} flexDirection="column" width={width} height={height}>
      {header}
      {notice ? <Text color={theme.color.loop} wrap="truncate-end">{notice}</Text> : null}
      {binary ? (
        <Text color={theme.color.warn} wrap="truncate-end">
          Binary {mime ? `(${mime}) ` : ''}{formatBytes(bytes!.length)} {theme.glyph.sep} hex dump of the first {Math.min(256, bytes!.length)} bytes
        </Text>
      ) : null}
      <Box flexDirection="column" height={bodyRows} overflow="hidden">{body}</Box>
      <Box justifyContent="space-between" width={width}>
        <Text color={typing ? theme.color.accent : theme.color.muted} wrap="truncate-end">{search || (active ? `/ search${onEdit ? ' · e edit' : ''}${onBack ? ' · Backspace back' : ''}` : '')}</Text>
        <Text color={theme.color.dim}>{position}</Text>
      </Box>
    </Box>
  )
}
