import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Box, Text, type DOMElement } from 'ink'
import { useTheme } from '../app/theme'
import { WHEEL_STEP, useKeys, useWheel, type Key, type KeyLayer } from '../app/keys'
import { truncate } from './text'

export interface ListRenderState {
  selected: boolean
  index: number
  width: number
}

export interface ListProps<T> {
  items: T[]
  getKey: (item: T) => string
  renderItem: (item: T, state: ListRenderState) => ReactNode
  /** Rows available for the list body (the filter bar takes one more when shown). */
  height: number
  width?: number
  /** Rows per item. Default 1. */
  itemHeight?: number
  /** Controlled selection. Omit for internal state. */
  selectedIndex?: number
  onSelectedIndexChange?: (index: number, item: T | undefined) => void
  onSubmit?: (item: T, index: number) => void
  /** Enables `/` to filter; return true to keep an item. */
  filter?: (item: T, query: string) => boolean
  /** Extra keys for the highlighted item; return true when consumed. */
  onKey?: (input: string, key: Key, item: T | undefined, index: number) => boolean | void
  keyLayer?: KeyLayer
  /** Key handling on/off (e.g. only when this list's pane is focused). Default true. */
  active?: boolean
  emptyText?: string
  /**
   * The mouse wheel moves the selection (like ↑/↓, e.g. a live tail where
   * scrolling up pauses following). Default: the wheel scrolls the rows and
   * leaves the selection alone until the next key.
   */
  wheelSelects?: boolean
}

/** Keyboard list: ↑↓/jk move, PgUp/PgDn page, Home/End jump, Enter submit, / filter. Windowed rendering. */
export function List<T>(props: ListProps<T>) {
  const {
    items, getKey, renderItem, height, width, itemHeight = 1, selectedIndex, onSelectedIndexChange,
    onSubmit, filter, onKey, keyLayer = 'main', active = true, emptyText = 'Nothing here.', wheelSelects = false,
  } = props
  const theme = useTheme()
  const [internalIndex, setInternalIndex] = useState(0)
  const [query, setQuery] = useState('')
  const [filtering, setFiltering] = useState(false)
  const offsetRef = useRef(0)

  const visible = useMemo(
    () => (filter && query ? items.filter(item => filter(item, query)) : items),
    [items, filter, query],
  )
  const showFilterBar = filtering || query.length > 0
  const bodyRows = Math.max(1, height - (showFilterBar ? 1 : 0))
  const perPage = Math.max(1, Math.floor(bodyRows / itemHeight))
  const rawIndex = selectedIndex ?? internalIndex
  const index = visible.length === 0 ? 0 : Math.min(Math.max(0, rawIndex), visible.length - 1)

  const select = (next: number) => {
    const clamped = visible.length === 0 ? 0 : Math.min(Math.max(0, next), visible.length - 1)
    if (selectedIndex === undefined) setInternalIndex(clamped)
    onSelectedIndexChange?.(clamped, visible[clamped])
  }

  useEffect(() => {
    if (rawIndex !== index && visible.length > 0) select(index)
  }, [rawIndex, index, visible.length])

  // Keep the selection in view when it moves; a wheel scroll may leave it
  // off screen until the next key brings it back.
  const revealed = useRef<string | null>(null)
  const [, redraw] = useState(0)
  if (revealed.current !== `${index}|${perPage}`) {
    revealed.current = `${index}|${perPage}`
    if (index < offsetRef.current) offsetRef.current = index
    if (index >= offsetRef.current + perPage) offsetRef.current = index - perPage + 1
  }
  offsetRef.current = Math.max(0, Math.min(offsetRef.current, Math.max(0, visible.length - perPage)))
  const boxRef = useRef<DOMElement>(null)
  useWheel(boxRef, delta => {
    if (wheelSelects) { select(index + delta * WHEEL_STEP); return }
    const next = Math.max(0, Math.min(offsetRef.current + delta * WHEEL_STEP, Math.max(0, visible.length - perPage)))
    if (next !== offsetRef.current) { offsetRef.current = next; redraw(n => n + 1) }
  }, { layer: keyLayer === 'overlay' ? 'overlay' : 'main' })
  const start = offsetRef.current
  const window = visible.slice(start, start + perPage)

  useKeys((input, key) => {
    if (filtering) {
      if (key.escape) { setFiltering(false); setQuery(''); return true }
      if (key.return) { setFiltering(false); return true }
      if (key.backspace || key.delete) { setQuery(q => q.slice(0, -1)); return true }
      if (key.upArrow || key.downArrow) { select(index + (key.upArrow ? -1 : 1)); return true }
      if (input && !key.ctrl && !key.meta && input.length >= 1 && !/[\r\n\t]/.test(input)) { setQuery(q => q + input); return true }
      return false
    }
    if (onKey?.(input, key, visible[index], index) === true) return true
    if (key.upArrow || (input === 'k' && !key.ctrl)) { select(index - 1); return true }
    if (key.downArrow || (input === 'j' && !key.ctrl)) { select(index + 1); return true }
    if (key.pageUp) { select(index - perPage); return true }
    if (key.pageDown) { select(index + perPage); return true }
    if (key.home || input === 'g') { select(0); return true }
    if (key.end || input === 'G') { select(visible.length - 1); return true }
    if (key.return && visible[index] !== undefined) { onSubmit?.(visible[index], index); return !!onSubmit }
    if (input === '/' && filter) { setFiltering(true); return true }
    if (key.escape && query) { setQuery(''); return true }
    return false
  }, { layer: keyLayer, active })

  const innerWidth = width ?? 80
  return (
    <Box ref={boxRef} flexDirection="column" width={width} height={height}>
      {showFilterBar ? (
        <Text>
          <Text color={theme.color.accent}>/</Text>
          <Text color={theme.color.text}>{query}</Text>
          {filtering ? <Text inverse> </Text> : null}
          <Text color={theme.color.muted}>  {visible.length}/{items.length}</Text>
        </Text>
      ) : null}
      {visible.length === 0 ? (
        <Text color={theme.color.muted}>{truncate(query ? `No match for "${query}".` : emptyText, innerWidth)}</Text>
      ) : (
        window.map((item, i) => (
          <Box key={getKey(item)} height={itemHeight} overflow="hidden">
            {renderItem(item, { selected: start + i === index, index: start + i, width: innerWidth })}
          </Box>
        ))
      )}
    </Box>
  )
}

/** Default row renderer: pointer + text, highlighted when selected. */
export function ListRow({ text, selected, width, color, dim }: { text: string; selected: boolean; width: number; color?: string; dim?: boolean }) {
  const theme = useTheme()
  const label = truncate(text, Math.max(1, width - 2))
  return (
    <Text
      color={selected ? theme.color.selectionFg : dim ? theme.color.dim : color ?? theme.color.text}
      backgroundColor={selected ? theme.color.selectionBg : undefined}
      inverse={theme.mono && selected}
      bold={selected}
    >
      {selected ? `${theme.glyph.pointer} ` : '  '}{label}
    </Text>
  )
}
