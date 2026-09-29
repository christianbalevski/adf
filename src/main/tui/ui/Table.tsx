import { useRef } from 'react'
import { Box, Text, type DOMElement } from 'ink'
import { useTheme } from '../app/theme'
import { useWheel } from '../app/keys'
import { fit } from './text'

export interface TableColumn<T> {
  key: string
  title: string
  /** Fixed cell width. Columns without one share the remaining width. */
  width?: number
  /** Minimum width for a flexible column. Default 6. */
  minWidth?: number
  align?: 'left' | 'right'
  /** Plain-text cell value. */
  value: (row: T) => string
  /** Optional color per cell. */
  color?: (row: T) => string | undefined
}

export interface TableProps<T> {
  columns: TableColumn<T>[]
  rows: T[]
  getKey: (row: T) => string
  width: number
  /** Highlight this row (e.g. List-driven selection). */
  selectedIndex?: number
  /** Max body rows; the window follows the selection. */
  height?: number
  emptyText?: string
  /** Mouse wheel over the table: -1 up / +1 down per notch (the owner moves its selection). */
  onWheel?: (delta: number) => void
}

/** Fixed-width text table. Pair with List-style keys in the owning view for selection. */
export function Table<T>({ columns, rows, getKey, width, selectedIndex, height, emptyText = 'No rows.', onWheel }: TableProps<T>) {
  const theme = useTheme()
  const boxRef = useRef<DOMElement>(null)
  useWheel(boxRef, delta => onWheel?.(delta), { active: !!onWheel })
  const gap = 1
  const fixed = columns.reduce((sum, c) => sum + (c.width ?? 0), 0)
  const flexible = columns.filter(c => c.width === undefined)
  const spare = Math.max(0, width - fixed - gap * (columns.length - 1) - 2)
  const share = flexible.length ? Math.floor(spare / flexible.length) : 0
  const widths = columns.map(c => c.width ?? Math.max(c.minWidth ?? 6, share))

  const bodyRows = height === undefined ? rows.length : Math.max(0, height - 1)
  const selected = selectedIndex ?? -1
  const start = selected >= bodyRows ? selected - bodyRows + 1 : 0
  const visible = rows.slice(start, start + bodyRows)

  const line = (cells: string[]) => cells.join(' '.repeat(gap))
  return (
    <Box ref={boxRef} flexDirection="column" width={width}>
      <Text bold color={theme.color.muted} underline={theme.mono}>
        {'  '}{line(columns.map((c, i) => fit(c.title, widths[i], c.align)))}
      </Text>
      {rows.length === 0 ? <Text color={theme.color.muted}>  {emptyText}</Text> : null}
      {visible.map((row, i) => {
        const isSelected = start + i === selected
        return (
          <Text
            key={getKey(row)}
            backgroundColor={isSelected ? theme.color.selectionBg : undefined}
            inverse={theme.mono && isSelected}
            wrap="truncate-end"
          >
            <Text color={isSelected ? theme.color.selectionFg : theme.color.accent}>{isSelected ? `${theme.glyph.pointer} ` : '  '}</Text>
            {columns.map((c, ci) => (
              <Text key={c.key} color={isSelected ? theme.color.selectionFg : c.color?.(row) ?? theme.color.text}>
                {(ci > 0 ? ' '.repeat(gap) : '') + fit(c.value(row), widths[ci], c.align)}
              </Text>
            ))}
          </Text>
        )
      })}
    </Box>
  )
}
