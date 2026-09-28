import { Text, useAnimation } from 'ink'
import { useTheme } from '../app/theme'

export interface SpinnerProps {
  /** Text after the spinner. */
  label?: string
  color?: string
  /** Stop animating (renders a static dot) — e.g. in tests or when idle. */
  paused?: boolean
}

export function Spinner({ label, color, paused = false }: SpinnerProps) {
  const theme = useTheme()
  const { frame } = useAnimation({ interval: 90, isActive: !paused })
  const frames = theme.glyph.spinner
  const glyph = paused ? theme.glyph.dot : frames[frame % frames.length]
  return (
    <Text color={color ?? theme.color.live}>
      {glyph}
      {label ? <Text color={theme.color.muted}> {label}</Text> : null}
    </Text>
  )
}
