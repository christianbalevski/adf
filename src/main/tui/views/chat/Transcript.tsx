// Transcript item renderers. Every item kind renders; nothing the model wrote
// is dropped — long tool output and thinking collapse but expand on Enter.

import { memo } from 'react'
import { Box, Text } from 'ink'
import { useTheme, type Theme } from '../../app/theme'
import { Markdown } from '../../ui/Markdown'
import { Spinner } from '../../ui/Spinner'
import { oneLine, previewJson, truncate } from '../../ui/text'
import type { TranscriptItem } from '../../state/types'
import { EXPANDED_TOOL_LINES, isRuntimeText, prettyJson, triggerLabel } from './model'

export interface ItemViewProps {
  item: TranscriptItem
  width: number
  selected: boolean
  expanded: boolean
  showThinking: boolean
  queued: boolean
}

function capLines(text: string, max: number): { text: string; more: number } {
  const lines = text.split('\n')
  if (lines.length <= max) return { text, more: 0 }
  return { text: lines.slice(0, max).join('\n'), more: lines.length - max }
}

function lineCount(text: string): number {
  return text ? text.split('\n').length : 0
}

function Gutter({ selected, theme }: { selected: boolean; theme: Theme }) {
  return <Text color={theme.color.accent} bold inverse={theme.mono && selected}>{selected ? theme.glyph.vbar : ' '}</Text>
}

function ItemBody({ item, width, expanded, showThinking, queued }: Omit<ItemViewProps, 'selected'>) {
  const theme = useTheme()
  const g = theme.glyph
  const w = Math.max(8, width)
  switch (item.kind) {
    case 'user': {
      if (item.origin === 'loop') {
        return (
          <Box flexDirection="column" width={w} borderStyle={theme.ascii ? 'classic' : 'single'} borderLeft borderRight={false} borderTop={false} borderBottom={false} borderColor={theme.color.loop} paddingLeft={1}>
            <Text wrap="truncate-end">
              <Text bold color={theme.color.loop}>{g.loop} from loop {item.from ?? '?'}</Text>
              <Text color={theme.color.dim}> {g.sep} inter-loop message</Text>
            </Text>
            <Markdown text={item.text} color={theme.color.text} />
          </Box>
        )
      }
      if (item.origin === 'runtime' || isRuntimeText(item.text)) {
        const label = triggerLabel(item.text)
        return (
          <Box flexDirection="column" width={w}>
            <Text wrap="truncate-end">
              <Text color={theme.color.info}>{expanded ? g.expanded : g.collapsed} woken by </Text>
              <Text bold color={theme.color.info}>{label}</Text>
              {!expanded ? <Text color={theme.color.dim}>  {truncate(oneLine(item.text), Math.max(0, w - label.length - 14))}</Text> : null}
            </Text>
            {expanded ? <Box paddingLeft={2}><Text wrap="wrap" color={theme.color.muted}>{item.text}</Text></Box> : null}
          </Box>
        )
      }
      return (
        <Box flexDirection="row" width={w}>
          <Text bold color={theme.color.user}>{g.pointer} </Text>
          <Box width={w - 2} flexDirection="column">
            <Text wrap="wrap" color={theme.color.user}>
              {item.text}
              {queued ? <Text color={theme.color.warn}>  [queued]</Text> : null}
              {!queued && item.pending && !item.accepted && item.local ? <Text color={theme.color.dim}>  [sending{g.ellipsis}]</Text> : null}
            </Text>
          </Box>
        </Box>
      )
    }
    case 'assistant':
      return (
        <Box flexDirection="row" width={w}>
          <Text color={item.streaming ? theme.color.live : theme.color.assistant}>{g.dot} </Text>
          <Box width={w - 2} flexDirection="column">
            {item.text ? <Markdown text={item.text} color={theme.color.assistant} /> : <Text> </Text>}
          </Box>
        </Box>
      )
    case 'thinking': {
      const open = expanded || showThinking
      const lines = lineCount(item.text)
      return (
        <Box flexDirection="column" width={w}>
          <Text wrap="truncate-end" italic color={theme.color.thinking}>
            {item.streaming ? <Spinner color={theme.color.thinking} /> : <Text>{open ? g.expanded : g.collapsed}</Text>}
            <Text> thinking</Text>
            {!open ? <Text color={theme.color.dim}> {g.sep} {lines} line{lines === 1 ? '' : 's'}{item.streaming ? `  ${truncate(oneLine(item.text.slice(-200)), Math.max(0, w - 30))}` : ''}</Text> : null}
          </Text>
          {open ? <Box paddingLeft={2}><Text wrap="wrap" italic color={theme.color.thinking}>{item.text || ' '}</Text></Box> : null}
        </Box>
      )
    }
    case 'tool': {
      const status = item.status === 'running'
        ? <Spinner color={theme.color.tool} />
        : <Text color={item.status === 'error' ? theme.color.error : theme.color.success}>{item.status === 'error' ? g.cross : g.check}</Text>
      const args = previewJson(item.input, Math.max(8, w - item.name.length - 6))
      if (!expanded) {
        const result = item.result ?? ''
        const more = lineCount(result) - 1
        return (
          <Box flexDirection="column" width={w}>
            <Text wrap="truncate-end">
              {status}
              <Text bold color={theme.color.tool}> {item.name}</Text>
              <Text color={theme.color.dim}> {args}</Text>
            </Text>
            {item.result !== undefined ? (
              <Text wrap="truncate-end" color={item.status === 'error' ? theme.color.error : theme.color.muted}>
                {'  '}{g.arrow} {truncate(oneLine(result.split('\n')[0] ?? '') || '(empty)', Math.max(4, w - 20))}
                {more > 0 ? <Text color={theme.color.dim}> (+{more} line{more === 1 ? '' : 's'}, Enter)</Text> : null}
              </Text>
            ) : null}
          </Box>
        )
      }
      const input = capLines(prettyJson(item.input), EXPANDED_TOOL_LINES)
      const result = capLines(item.result ?? '', EXPANDED_TOOL_LINES)
      return (
        <Box flexDirection="column" width={w}>
          <Text wrap="truncate-end">
            {status}
            <Text bold color={theme.color.tool}> {item.name}</Text>
            <Text color={theme.color.dim}> {item.toolUseId ?? ''}</Text>
          </Text>
          {input.text ? (
            <Box flexDirection="column" paddingLeft={2}>
              <Text color={theme.color.dim}>input</Text>
              <Box paddingLeft={2}><Text wrap="wrap" color={theme.color.muted}>{input.text}{input.more ? `\n… ${input.more} more lines` : ''}</Text></Box>
            </Box>
          ) : null}
          {item.result !== undefined ? (
            <Box flexDirection="column" paddingLeft={2}>
              <Text color={theme.color.dim}>result</Text>
              <Box paddingLeft={2}><Text wrap="wrap" color={item.status === 'error' ? theme.color.error : theme.color.text}>{result.text || '(empty)'}{result.more ? `\n… ${result.more} more lines` : ''}</Text></Box>
            </Box>
          ) : null}
        </Box>
      )
    }
    case 'hil': {
      const tone = item.status === 'pending' ? theme.color.warn : item.status === 'approved' ? theme.color.success : theme.color.error
      return (
        <Box flexDirection="column" width={w} borderStyle={theme.ascii ? 'classic' : 'single'} borderLeft borderRight={false} borderTop={false} borderBottom={false} borderColor={tone} paddingLeft={1}>
          <Text wrap="truncate-end">
            <Text bold color={tone}>{g.warn} approval {item.status}</Text>
            <Text color={theme.color.tool}> {item.tool}</Text>
            <Text color={theme.color.dim}> {g.sep} {item.taskId}</Text>
          </Text>
          {expanded
            ? <Text wrap="wrap" color={theme.color.muted}>{prettyJson(item.input)}</Text>
            : <Text wrap="truncate-end" color={theme.color.muted}>{previewJson(item.input, Math.max(8, w - 4))}</Text>}
          {item.reason ? <Text wrap="truncate-end" color={theme.color.dim}>reason: {item.reason}</Text> : null}
          {item.feedback ? <Text wrap="truncate-end" color={theme.color.muted}>feedback: {item.feedback}</Text> : null}
        </Box>
      )
    }
    case 'ask':
      return (
        <Box flexDirection="column" width={w} borderStyle={theme.ascii ? 'classic' : 'single'} borderLeft borderRight={false} borderTop={false} borderBottom={false} borderColor={item.status === 'pending' ? theme.color.warn : theme.color.dim} paddingLeft={1}>
          <Text bold color={item.status === 'pending' ? theme.color.warn : theme.color.muted}>? {item.status === 'pending' ? 'the agent asks you' : 'answered'}</Text>
          <Text wrap="wrap" color={theme.color.text}>{item.question}</Text>
          {item.answer ? <Text wrap="truncate-end" color={theme.color.user}>{g.pointer} {item.answer}</Text> : null}
        </Box>
      )
    case 'notice':
      return (
        <Text wrap="truncate-end" color={item.level === 'warn' ? theme.color.warn : item.event === 'marker' ? theme.color.info : theme.color.muted}>
          {item.event === 'marker' ? g.arrow : g.hbar} {item.text}
        </Text>
      )
    case 'context': {
      const label = item.category === 'compaction' ? 'compacted history summary' : `context ${g.sep} ${item.category}`
      return (
        <Box flexDirection="column" width={w}>
          <Text wrap="truncate-end" color={theme.color.dim}>
            {expanded ? g.expanded : g.collapsed} {label} <Text color={theme.color.dim}>({item.text.length} chars{expanded ? '' : ', Enter'})</Text>
          </Text>
          {expanded ? <Box paddingLeft={2}><Text wrap="wrap" color={theme.color.muted}>{item.text}</Text></Box> : null}
        </Box>
      )
    }
    case 'error':
      return (
        <Box flexDirection="row" width={w}>
          <Text color={theme.color.error}>{g.cross} </Text>
          <Box width={w - 2}><Text wrap="wrap" color={theme.color.error}>{item.text}</Text></Box>
        </Box>
      )
  }
}

export const TranscriptItemView = memo(function TranscriptItemView(props: ItemViewProps) {
  const theme = useTheme()
  const gap = props.item.kind === 'notice' || (props.item.kind === 'context' && !props.expanded) ? 0 : 1
  return (
    <Box flexDirection="row" width={props.width} marginBottom={gap} flexShrink={0}>
      <Gutter selected={props.selected} theme={theme} />
      <Box flexDirection="column" width={props.width - 1}>
        <ItemBody {...props} width={props.width - 1} />
      </Box>
    </Box>
  )
})
