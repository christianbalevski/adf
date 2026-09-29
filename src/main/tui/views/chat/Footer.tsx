// One-line turn footer: live spinner + elapsed + this turn's tokens, or the
// last turn's totals when idle.

import { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import { useTheme, stateColor } from '../../app/theme'
import { Spinner } from '../../ui/Spinner'
import { formatCount, truncate } from '../../ui/text'
import type { TurnStats } from './model'
import { pressureOf } from '../../context/model'

export interface FooterProps {
  width: number
  running: boolean
  state: string
  turn: TurnStats | undefined
  /** Fallback turn start when the state event predates the TUI. */
  since: number
  model: string | undefined
  error?: string
  /** Context used vs the loop's auto-compact threshold (percent), when known: "ctx 42%". */
  contextPercent?: number | null
}

function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m${String(s % 60).padStart(2, '0')}s`
}

export function Footer({ width, running, state, turn, since, model, error, contextPercent }: FooterProps) {
  const theme = useTheme()
  const g = theme.glyph
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!running) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running])

  const tokens = turn && (turn.input || turn.output)
    ? `${g.arrow === '->' ? '^' : '↑'}${formatCount(turn.input)} ${g.arrow === '->' ? 'v' : '↓'}${formatCount(turn.output)} tok`
    : ''
  const modelText = truncate(turn?.model ?? model ?? '', 28)
  const ctxPressure = contextPercent == null ? null : pressureOf(contextPercent)
  const ctx = contextPercent == null ? null : (
    <>
      <Text color={theme.color.dim}> {g.sep} </Text>
      <Text color={ctxPressure === 'high' ? theme.color.error : ctxPressure === 'warn' ? theme.color.warn : theme.color.dim} bold={ctxPressure !== 'ok'}>ctx {contextPercent}%</Text>
    </>
  )

  if (error) {
    return <Box width={width} height={1}><Text wrap="truncate-end" color={theme.color.error}>{g.cross} {error}</Text></Box>
  }
  if (running) {
    const open = turn && turn.endedAt === undefined ? turn.startedAt : since
    return (
      <Box width={width} height={1}>
        <Text wrap="truncate-end">
          <Spinner label={`${state}${g.ellipsis}`} color={theme.color.live} />
          <Text color={theme.color.muted}> {elapsed(now - open)}</Text>
          {tokens ? <Text color={theme.color.dim}> {g.sep} {tokens}</Text> : null}
          {ctx}
          {modelText ? <Text color={theme.color.dim}> {g.sep} {modelText}</Text> : null}
          <Text color={theme.color.dim}> {g.sep} </Text>
          <Text color={theme.color.accent}>esc</Text>
          <Text color={theme.color.dim}> to interrupt</Text>
        </Text>
      </Box>
    )
  }
  const last = turn && turn.endedAt !== undefined ? `last turn ${elapsed(turn.endedAt - turn.startedAt)}` : ''
  return (
    <Box width={width} height={1}>
      <Text wrap="truncate-end">
        <Text color={stateColor(theme, state)}>{g.ring} {state}</Text>
        {last ? <Text color={theme.color.dim}> {g.sep} {last}</Text> : null}
        {tokens ? <Text color={theme.color.dim}> {g.sep} {tokens}</Text> : null}
        {ctx}
        {modelText ? <Text color={theme.color.dim}> {g.sep} {modelText}</Text> : null}
      </Text>
    </Box>
  )
}
