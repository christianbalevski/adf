// Markdown-lite for terminal output: headings, emphasis, inline code, fenced
// code, lists, quotes, rules, links. Anything else renders as plain text —
// nothing the model wrote is ever dropped.

import { useLayoutEffect, useReducer, useRef, type ReactNode } from 'react'
import { Box, Text, measureElement, type DOMElement } from 'ink'
import { measuredBlockWindow, type BlockMeasurement, type MarkdownViewport } from './markdown-window'
import { useTheme, type Theme } from '../app/theme'

export interface MarkdownProps {
  text: string
  /** Base color for body text. */
  color?: string
  /** Render syntax as plain text (no parsing). */
  raw?: boolean
  /** Rows of this Markdown body that can intersect the transcript viewport. */
  viewport?: MarkdownViewport
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

export function Markdown({ text, color, raw = false, viewport }: MarkdownProps) {
  const theme = useTheme()
  const [, measured] = useReducer((n: number) => n + 1, 0)
  const cache = useRef<{ text: string; width: number; theme: Theme; heights: Map<number, BlockMeasurement> } | null>(null)
  const nodes = useRef(new Map<number, DOMElement>())
  const blocks = raw ? [] : parseBlocks(text)
  const signatures = viewport ? blocks.map(block => JSON.stringify(block)) : []
  if (viewport && (!cache.current || cache.current.width !== viewport.width || cache.current.theme !== theme || !text.startsWith(cache.current.text))) {
    cache.current = { text, width: viewport.width, theme, heights: new Map() }
  }
  const heights = cache.current?.heights
  if (cache.current) cache.current.text = text
  const hidden = viewport && heights ? measuredBlockWindow(signatures, heights, viewport) : []

  useLayoutEffect(() => {
    if (!viewport || !heights) return
    // Only mounted blocks are measured. Hidden blocks retain their exact Ink
    // height; a changed/unknown block is always mounted, never guessed away.
    for (const [i, node] of nodes.current) {
      if (i < signatures.length) heights.set(i, { signature: signatures[i], height: measureElement(node).height })
    }
    for (const i of heights.keys()) if (i >= signatures.length) heights.delete(i)
    const next = measuredBlockWindow(signatures, heights, viewport)
    // Measuring a streaming suffix usually leaves the window unchanged. Do
    // not cause a second render unless newly measured rows can be omitted.
    if (next.some((value, i) => value !== hidden[i])) measured()
  })

  if (raw) return <Text wrap="wrap" color={color}>{text}</Text>
  if (!viewport || !heights) return <Box flexDirection="column">{blocks.map((block, i) => renderBlock(block, i, theme, color))}</Box>
  const children: ReactNode[] = []
  let spacer = 0
  const flush = (i: number) => {
    if (spacer > 0) children.push(<Box key={`space:${i}`} height={spacer} flexShrink={0} />)
    spacer = 0
  }
  for (let i = 0; i < blocks.length; i++) {
    if (hidden[i]) { spacer += heights.get(i)!.height; continue }
    flush(i)
    children.push(<Box key={i} flexDirection="column" flexShrink={0} ref={node => {
      if (node) nodes.current.set(i, node)
      else nodes.current.delete(i)
    }}>{renderBlock(blocks[i], i, theme, color)}</Box>)
  }
  flush(blocks.length)
  return <Box flexDirection="column">{children}</Box>
}
