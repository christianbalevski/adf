import { Box, Text } from 'ink'
import { useTheme } from './theme'
import { useToasts } from '../state/hooks'
import { truncate } from '../ui/text'
import type { ToastLevel } from '../state/types'

/** Notifications above the status bar, newest last. Errors stay longest. */
export function Toasts({ width, max = 3 }: { width: number; max?: number }) {
  const theme = useTheme()
  const toasts = useToasts()
  if (toasts.length === 0) return null
  const color = (level: ToastLevel) =>
    level === 'error' ? theme.color.error : level === 'warn' ? theme.color.warn : level === 'success' ? theme.color.success : theme.color.info
  const glyph = (level: ToastLevel) =>
    level === 'error' ? theme.glyph.cross : level === 'warn' ? theme.glyph.warn : level === 'success' ? theme.glyph.check : theme.glyph.bullet
  return (
    <Box flexDirection="column" width={width}>
      {toasts.slice(-max).map(t => (
        <Text key={t.id} wrap="truncate-end">
          <Text color={color(t.level)} bold> {glyph(t.level)} </Text>
          <Text color={t.level === 'error' ? theme.color.error : theme.color.text}>{truncate(t.text, Math.max(10, width - 4))}</Text>
        </Text>
      ))}
    </Box>
  )
}
