import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Box, Text, type DOMElement } from 'ink'
import { useTheme } from '../app/theme'
import { useKeys, useWheel, type KeyLayer } from '../app/keys'

export interface ScrollViewProps<T> {
  items: T[]
  getKey: (item: T) => string
  renderItem: (item: T, index: number) => ReactNode
  /** Estimated rows an item takes at `width` — drives the window; errors only clip or pad. */
  estimateHeight: (item: T, width: number) => number
  height: number
  width: number
  keyLayer?: KeyLayer
  /** Key handling on/off. Default true. */
  active?: boolean
  /** Called when the user scrolls to the oldest item (load an older page). */
  onReachTop?: () => void
  /** Text shown when there are no items. */
  emptyText?: string
}

/**
 * Bottom-anchored, virtualized scroll region for long transcripts. Only the
 * items that fit are rendered. Follows the tail until the user scrolls up
 * (↑/↓ one item, PgUp/PgDn a page, Home oldest, End/G back to live).
 */
export function ScrollView<T>(props: ScrollViewProps<T>) {
  const { items, getKey, renderItem, estimateHeight, height, width, keyLayer = 'main', active = true, onReachTop, emptyText } = props
  const theme = useTheme()
  // Anchored by key, not index, so prepending an older page does not move the view.
  const [anchorKey, setAnchorKey] = useState<string | null>(null)
  const reachedTop = useRef(false)

  const last = items.length - 1
  // Only a scrolled view looks its anchor up (following is the common case).
  const anchorIndex = anchorKey === null ? -1 : findFromEnd(items, getKey, anchorKey)
  const anchor = anchorIndex < 0 ? null : anchorIndex
  const bottom = anchor === null ? last : Math.min(anchor, last)
  const following = anchor === null || bottom >= last
  const setAnchor = (index: number | null) => setAnchorKey(index === null || !items[index] ? null : getKey(items[index]))

  // Walk up from the anchor until the viewport is full.
  const reserve = following ? 0 : 1
  let rows = 0
  let start = bottom + 1
  while (start > 0 && rows < height - reserve) {
    start -= 1
    rows += Math.max(1, estimateHeight(items[start], width))
  }
  const hiddenAbove = Math.max(0, start)
  const newer = following ? 0 : last - bottom

  useEffect(() => {
    if (hiddenAbove === 0 && items.length > 0 && anchor !== null && !reachedTop.current) {
      reachedTop.current = true
      onReachTop?.()
    }
    if (hiddenAbove > 0) reachedTop.current = false
  }, [hiddenAbove, anchor, items.length])

  const pageItems = Math.max(1, bottom - start)
  const move = (delta: number) => {
    if (items.length === 0) return
    const next = Math.max(0, Math.min(last, bottom + delta))
    setAnchor(next >= last ? null : next)
  }

  const boxRef = useRef<DOMElement>(null)
  useWheel(boxRef, delta => move(delta), { layer: keyLayer === 'overlay' ? 'overlay' : 'main' })

  useKeys((input, key) => {
    if (key.pageUp) { move(-pageItems); return true }
    if (key.pageDown) { move(pageItems); return true }
    if (key.upArrow && !key.ctrl) { move(-1); return true }
    if (key.downArrow && !key.ctrl) { move(1); return true }
    if (key.home) {
      setAnchor(0)
      if (hiddenAbove === 0) onReachTop?.()
      return true
    }
    if (key.end || input === 'G') { setAnchor(null); return true }
    return false
  }, { layer: keyLayer, active })

  if (items.length === 0) {
    return (
      <Box height={height} width={width} flexDirection="column" justifyContent="flex-end">
        {emptyText ? <Text color={theme.color.muted}>{emptyText}</Text> : null}
      </Box>
    )
  }

  return (
    <Box ref={boxRef} height={height} width={width} flexDirection="column">
      <Box flexGrow={1} flexDirection="column" justifyContent="flex-end" overflow="hidden">
        {items.slice(start, bottom + 1).map((item, i) => (
          <Box key={getKey(item)} flexShrink={0} flexDirection="column">{renderItem(item, start + i)}</Box>
        ))}
      </Box>
      {newer > 0 ? (
        <Text color={theme.color.accent}>{theme.glyph.expanded} {newer} newer {theme.glyph.sep} End to follow</Text>
      ) : null}
    </Box>
  )
}

/** Index of the item with `key`, searching from the newest end (anchors sit near it). */
function findFromEnd<T>(items: T[], getKey: (item: T) => string, key: string): number {
  for (let i = items.length - 1; i >= 0; i--) if (getKey(items[i]) === key) return i
  return -1
}
