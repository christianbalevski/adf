// Markdown-lite for terminal output: headings, emphasis, inline code, fenced
// code, lists, quotes, rules, links. Anything else renders as plain text —
// nothing the model wrote is ever dropped.

import type { ReactNode } from 'react'
import { Box, Text } from 'ink'
import { useTheme, type Theme } from '../app/theme'

export interface MarkdownProps {
  text: string
  /** Base color for body text. */
  color?: string
  /** Render syntax as plain text (no parsing). */
  raw?: boolean
}

type Block =
  | { kind: 'para'; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'code'; lang: string; lines: string[] }
  | { kind: 'list'; ordered: boolean; items: Array<{ marker: string; text: string; indent: number }> }
  | { kind: 'quote'; text: string }
  | { kind: 'rule' }
  | { kind: 'blank' }

export function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const fence = line.match(/^\s*(```|~~~)\s*([\w+-]*)/)
    if (fence) {
      const close = fence[1]
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i].trimStart().startsWith(close)) body.push(lines[i++])
      i++
      blocks.push({ kind: 'code', lang: fence[2] ?? '', lines: body })
      continue
    }
    if (!line.trim()) {
      if (blocks.length && blocks[blocks.length - 1].kind !== 'blank') blocks.push({ kind: 'blank' })
      i++
      continue
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] })
      i++
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ kind: 'rule' })
      i++
      continue
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''))
      blocks.push({ kind: 'quote', text: body.join('\n') })
      continue
    }
    const listItem = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
    if (listItem.test(line)) {
      const items: Array<{ marker: string; text: string; indent: number }> = []
      const ordered = /^\s*\d/.test(line)
      while (i < lines.length && listItem.test(lines[i])) {
        const m = lines[i].match(listItem)!
        items.push({ indent: Math.floor(m[1].length / 2), marker: m[2], text: m[3] })
        i++
      }
      blocks.push({ kind: 'list', ordered, items })
      continue
    }
    const para: string[] = [line]
    i++
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*```|\s*~~~|\s*>|\s*([-*+]|\d+[.)])\s)/.test(lines[i])) para.push(lines[i++])
    blocks.push({ kind: 'para', text: para.join('\n') })
  }
  while (blocks.length && blocks[blocks.length - 1].kind === 'blank') blocks.pop()
  return blocks
}

/** Inline spans: `code`, **bold**, *em* / _em_, [text](url). */
export function Inline({ text, color }: { text: string; color?: string }) {
  const theme = useTheme()
  const parts: ReactNode[] = []
  const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(\*[^*\s][^*\n]*\*|_[^_\s][^_\n]*_)|(\[[^\]\n]+\]\([^)\s]+\))/g
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  while ((m = pattern.exec(text))) {
    if (m.index > last) parts.push(<Text key={k++} color={color}>{text.slice(last, m.index)}</Text>)
    const token = m[0]
    if (m[1]) parts.push(<Text key={k++} color={theme.color.live} inverse={theme.mono}>{token.slice(1, -1)}</Text>)
    else if (m[2]) parts.push(<Text key={k++} bold color={color}>{token.slice(2, -2)}</Text>)
    else if (m[3]) parts.push(<Text key={k++} italic color={color}>{token.slice(1, -1)}</Text>)
    else if (m[4]) {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/)!
      parts.push(<Text key={k++} underline color={theme.color.info}>{link[1]}</Text>)
      parts.push(<Text key={k++} color={theme.color.dim}> ({link[2]})</Text>)
    }
    last = m.index + token.length
  }
  if (last < text.length) parts.push(<Text key={k++} color={color}>{text.slice(last)}</Text>)
  return <Text wrap="wrap">{parts}</Text>
}

function renderBlock(block: Block, index: number, theme: Theme, color?: string) {
  switch (block.kind) {
    case 'blank':
      return <Text key={index}> </Text>
    case 'heading':
      return (
        <Text key={index} bold color={theme.color.accent} underline={block.level <= 2 && theme.mono}>
          {block.text}
        </Text>
      )
    case 'rule':
      return <Text key={index} color={theme.color.dim}>{theme.glyph.hbar.repeat(24)}</Text>
    case 'quote':
      return (
        <Box key={index} paddingLeft={1} borderStyle="single" borderLeft borderRight={false} borderTop={false} borderBottom={false} borderColor={theme.color.dim}>
          <Inline text={block.text} color={theme.color.muted} />
        </Box>
      )
    case 'code':
      return (
        <Box key={index} flexDirection="column" paddingLeft={2}>
          {block.lang ? <Text color={theme.color.dim}>{block.lang}</Text> : null}
          {block.lines.map((line, i) => <Text key={i} color={theme.color.live} wrap="wrap">{line || ' '}</Text>)}
        </Box>
      )
    case 'list':
      return (
        <Box key={index} flexDirection="column">
          {block.items.map((item, i) => (
            <Box key={i} paddingLeft={item.indent * 2}>
              <Text color={theme.color.accent}>{block.ordered ? `${item.marker} ` : `${theme.glyph.bullet} `}</Text>
              <Box flexShrink={1}><Inline text={item.text} color={color} /></Box>
            </Box>
          ))}
        </Box>
      )
    case 'para':
      return <Inline key={index} text={block.text} color={color} />
  }
}

export function Markdown({ text, color, raw = false }: MarkdownProps) {
  const theme = useTheme()
  if (raw) return <Text wrap="wrap" color={color}>{text}</Text>
  const blocks = parseBlocks(text)
  return <Box flexDirection="column">{blocks.map((block, i) => renderBlock(block, i, theme, color))}</Box>
}
