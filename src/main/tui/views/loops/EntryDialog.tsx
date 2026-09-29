// One persisted loop entry in full: every content block, token usage, model.

import { useState } from 'react'
import { Box, Text } from 'ink'
import { useTheme } from '../../app/theme'
import { useKeys } from '../../app/keys'
import { Modal } from '../../ui/Modal'
import { formatClock } from '../../ui/text'
import type { LoopEntry } from '../../api/types'
import { formatTokens } from './model'
import type { OverlayProps } from '../types'

export interface EntryDialogProps {
  entry: LoopEntry
  loop: string
}

export function entryLines(entry: LoopEntry, width: number): Array<{ text: string; tone: 'head' | 'body' | 'tool' | 'dim' }> {
  const out: Array<{ text: string; tone: 'head' | 'body' | 'tool' | 'dim' }> = []
  const push = (text: string, tone: 'head' | 'body' | 'tool' | 'dim') => {
    for (const raw of text.split('\n')) {
      if (raw.length <= width) { out.push({ text: raw, tone }); continue }
      for (let i = 0; i < raw.length; i += width) out.push({ text: raw.slice(i, i + width), tone })
    }
  }
  ;(entry.content_json ?? []).forEach((block, i) => {
    const b = block as { type: string; text?: string; name?: string; id?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean; thinking?: string }
    switch (b.type) {
      case 'text':
        push(`[${i + 1}] text`, 'head')
        push(b.text ?? '', 'body')
        break
      case 'tool_use':
        push(`[${i + 1}] tool_use ${b.name ?? ''} ${b.id ? `(${b.id})` : ''}`, 'head')
        push(pretty(b.input), 'tool')
        break
      case 'tool_result':
        push(`[${i + 1}] tool_result ${b.is_error ? 'ERROR ' : ''}${b.tool_use_id ? `(${b.tool_use_id})` : ''}`, 'head')
        push(typeof b.content === 'string' ? b.content : pretty(b.content), 'tool')
        break
      case 'thinking':
      case 'reasoning':
        push(`[${i + 1}] ${b.type}`, 'head')
        push(b.thinking ?? b.text ?? '', 'dim')
        break
      default:
        push(`[${i + 1}] ${b.type}`, 'head')
        push(pretty(b), 'dim')
    }
  })
  return out
}

function pretty(value: unknown): string {
  try { return JSON.stringify(value, null, 2) ?? '' } catch { return String(value) }
}

export function EntryDialog({ overlay, close, width, height }: OverlayProps) {
  const { entry, loop } = (overlay.props ?? {}) as unknown as EntryDialogProps
  const theme = useTheme()
  const dialogWidth = Math.max(40, Math.min(width - 4, 110))
  const inner = dialogWidth - 4
  const rows = Math.max(4, height - 10)
  const lines = entry ? entryLines(entry, inner) : []
  const [top, setTop] = useState(0)
  const maxTop = Math.max(0, lines.length - rows)
  useKeys((input, key) => {
    if (key.escape || key.backspace || key.return || input === 'q') { close(); return true }
    if (key.downArrow || input === 'j') { setTop(t => Math.min(maxTop, t + 1)); return true }
    if (key.upArrow || input === 'k') { setTop(t => Math.max(0, t - 1)); return true }
    if (key.pageDown || input === ' ') { setTop(t => Math.min(maxTop, t + rows)); return true }
    if (key.pageUp) { setTop(t => Math.max(0, t - rows)); return true }
    if (key.home || input === 'g') { setTop(0); return true }
    if (key.end || input === 'G') { setTop(maxTop); return true }
    return true
  }, { layer: 'overlay' })
  if (!entry) return null
  const tokens = formatTokens(entry)
  return (
    <Modal title={`${loop} ${theme.glyph.sep} entry #${entry.seq}`} width={dialogWidth} hints={[{ keys: 'up down', label: 'scroll' }, { keys: 'pgup pgdn', label: 'page' }, { keys: 'backspace esc', label: 'back' }]}>
      <Text color={theme.color.muted}>
        {entry.role} {theme.glyph.sep} {new Date(entry.created_at).toLocaleDateString()} {formatClock(entry.created_at)}
        {entry.model ? ` ${theme.glyph.sep} ${entry.model}` : ''}
        {tokens ? ` ${theme.glyph.sep} ${tokens}` : ''}
      </Text>
      <Box flexDirection="column" height={Math.min(rows, Math.max(1, lines.length))}>
        {lines.slice(top, top + rows).map((line, i) => (
          <Text key={top + i} wrap="truncate-end" bold={line.tone === 'head'} color={line.tone === 'head' ? theme.color.accent : line.tone === 'tool' ? theme.color.tool : line.tone === 'dim' ? theme.color.thinking : theme.color.text}>
            {line.text || ' '}
          </Text>
        ))}
      </Box>
      {lines.length > rows ? <Text color={theme.color.dim}>lines {top + 1}-{Math.min(lines.length, top + rows)} of {lines.length}</Text> : null}
    </Modal>
  )
}
