import type { ReactNode } from 'react'
import { Box, Text, type BoxProps } from 'ink'
import { useTheme } from '../app/theme'
import { truncate } from './text'

export interface PanelProps extends Omit<BoxProps, 'borderStyle' | 'borderColor' | 'flexDirection'> {
  title?: string
  /** Right-aligned text on the title row (counts, status). */
  meta?: string
  focused?: boolean
  /** Drop the border (keeps the title row). */
  bare?: boolean
  children?: ReactNode
}

/** A bordered, titled region. Border turns accent when focused. */
export function Panel({ title, meta, focused = false, bare = false, children, width, ...rest }: PanelProps) {
  const theme = useTheme()
  const innerWidth = typeof width === 'number' ? Math.max(1, width - (bare ? 0 : 2)) : undefined
  return (
    <Box
      flexDirection="column"
      width={width}
      borderStyle={bare ? undefined : theme.ascii ? 'classic' : 'round'}
      borderColor={focused ? theme.color.borderFocus : theme.color.border}
      paddingX={bare ? 0 : 1}
      {...rest}
    >
      {title !== undefined ? (
        <Box justifyContent="space-between" width={innerWidth ? Math.max(1, innerWidth - (bare ? 0 : 2)) : undefined}>
          <Text bold color={focused ? theme.color.accent : theme.color.muted} inverse={theme.mono && focused}>
            {innerWidth ? truncate(title, Math.max(1, innerWidth - (meta?.length ?? 0) - 4)) : title}
          </Text>
          {meta ? <Text color={theme.color.muted}>{meta}</Text> : null}
        </Box>
      ) : null}
      {children}
    </Box>
  )
}
