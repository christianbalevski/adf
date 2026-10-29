// Transcript item renderers. Every item kind renders; nothing the model wrote
// is dropped — long tool output and thinking collapse but expand on Enter.

import { memo } from 'react'
import { Box, Text } from 'ink'
import { useTheme, type Theme } from '../../app/theme'
import { Markdown } from '../../ui/Markdown'
import { Spinner } from '../../ui/Spinner'
import { oneLine, previewJson, truncate } from '../../ui/text'
import { askQuestions } from '../../state/transcript'
import type { ToolItem, TranscriptItem } from '../../state/types'
import type { AskQuestion } from '../../../../shared/utils/ask-form'
import {
  EXPANDED_TOOL_LINES,
  askAnswers,
  capLines,
  isAsyncTool,
  isExpandable,
  isRuntimeText,
  prettyJson,
  sayText,
  shownTaskRef,
  statusLineText,
  toolArgs,
  toolReason,
  toolView,
  triggerLabel,
} from './model'

export interface ItemViewProps {
  item: TranscriptItem
  width: number
  selected: boolean
  expanded: boolean
  showThinking: boolean
  queued: boolean
  /** Conservative visible row budget; source/copy text always stays complete. */
  viewportHeight?: number
  clipBottom?: number
}

function lineCount(text: string): number {
  return text ? text.split('\n').length : 0
}

/** An ask's questions, each followed by its answer once answered (skipped dimmed). Heights: `askFormHeight`. */
function AskForm({ questions, answers }: { questions: AskQuestion[]; answers?: Array<string | null> }) {
  const theme = useTheme()
  const g = theme.glyph
  return (
    <>
      {questions.map((q, i) => {
        const answer = answers?.[i]
        return (
          <Box key={i} flexDirection="column">
            <Text wrap="wrap" color={theme.color.text}>{q.question || ' '}</Text>
            {!answers ? null : answer != null
              ? <Text wrap="truncate-end" color={theme.color.user}>{g.pointer} {oneLine(answer) || '(empty)'}</Text>
              : <Text wrap="truncate-end" color={theme.color.dim}>{g.pointer} skipped</Text>}
          </Box>
        )
      })}
    </>
  )
}

/**
 * A tool call, as Studio's loop shows it: `say` is an assistant message, `ask`
 * the ask card, a successful status / state change one quiet line, anything
 * else a row led by the agent's `_reason` (tool name after it), falling back
 * to the name + a compact args preview. Expanded, every kind shows the full
 * input (`_reason` / `_async` included), the task reference of an async call
 * and the result. Heights: `itemHeight` in model.ts, kept in step with this.
 */
function ToolBody({ item, w, expanded, viewportHeight, clipBottom = 0 }: { item: ToolItem; w: number; expanded: boolean; viewportHeight?: number; clipBottom?: number }) {
  const theme = useTheme()
  const g = theme.glyph
  const view = toolView(item)
  const failed = item.status === 'error'
  const status = item.status === 'running'
    ? <Spinner color={theme.color.tool} />
    : <Text color={failed ? theme.color.error : theme.color.success}>{failed ? g.cross : g.check}</Text>
  const asyncBadge = isAsyncTool(item) ? <Text color={theme.color.dim}> [async]</Text> : null

  if (expanded && isExpandable(item)) {
    const input = capLines(prettyJson(item.input), EXPANDED_TOOL_LINES)
    const ref = shownTaskRef(item)
    const task = ref !== undefined ? capLines(ref, EXPANDED_TOOL_LINES) : null
    const result = capLines(item.result ?? '', EXPANDED_TOOL_LINES)
    return (
      <Box flexDirection="column" width={w}>
        <Text wrap="truncate-end">
          {status}
          <Text bold color={theme.color.tool}> {item.name}</Text>
          {asyncBadge}
          <Text color={theme.color.dim}> {item.toolUseId ?? ''}</Text>
        </Text>
        {input.text ? (
          <Box flexDirection="column" paddingLeft={2}>
            <Text color={theme.color.dim}>input</Text>
            <Box paddingLeft={2}><Text wrap="wrap" color={theme.color.muted}>{input.text}{input.more ? `\n${g.ellipsis} ${input.more} more lines` : ''}</Text></Box>
          </Box>
        ) : null}
        {task ? (
          <Box flexDirection="column" paddingLeft={2}>
            <Text color={theme.color.dim}>task (returned at once)</Text>
            <Box paddingLeft={2}><Text wrap="wrap" color={theme.color.muted}>{task.text || ' '}{task.more ? `\n${g.ellipsis} ${task.more} more lines` : ''}</Text></Box>
          </Box>
        ) : null}
        {item.result !== undefined ? (
          <Box flexDirection="column" paddingLeft={2}>
            <Text color={theme.color.dim}>result</Text>
            <Box paddingLeft={2}><Text wrap="wrap" color={failed ? theme.color.error : theme.color.text}>{result.text || '(empty)'}{result.more ? `\n${g.ellipsis} ${result.more} more lines` : ''}</Text></Box>
          </Box>
        ) : null}
      </Box>
    )
  }

  switch (view) {
    case 'say':
      return (
        <Box flexDirection="row" width={w}>
          <Text color={item.status === 'running' ? theme.color.live : theme.color.assistant}>{g.dot} </Text>
          <Box width={w - 2} flexDirection="column">
            <Markdown text={sayText(item) || ' '} color={theme.color.assistant} viewport={viewportHeight === undefined ? undefined : { width: w - 2, height: viewportHeight + 2, clipBottom: Math.max(0, clipBottom - 1 - (failed ? 1 : 0)) }} />
            {failed ? (
              <Text wrap="truncate-end" color={theme.color.error}>
                {g.cross} say failed: {truncate(oneLine(item.result ?? '') || '(no detail)', Math.max(4, w - 20))}<Text color={theme.color.dim}> (Enter)</Text>
              </Text>
            ) : null}
          </Box>
        </Box>
      )
    case 'ask': {
      const pending = item.status === 'running'
      const answers = askAnswers(item)
      const reason = toolReason(item)
      return (
        <Box flexDirection="column" width={w} borderStyle={theme.ascii ? 'classic' : 'single'} borderLeft borderRight={false} borderTop={false} borderBottom={false} borderColor={pending ? theme.color.warn : theme.color.dim} paddingLeft={1}>
          <Text wrap="truncate-end">
            <Text bold color={pending ? theme.color.warn : theme.color.muted}>? {pending ? 'the agent asks you' : 'the agent asked'}</Text>
            {reason ? <Text color={theme.color.dim}> {g.sep} {reason}</Text> : null}
          </Text>
          <AskForm questions={askQuestions(item.input)} answers={answers} />
          {item.result !== undefined && !answers ? (
            <Text wrap="truncate-end" color={theme.color.error}>{g.cross} {oneLine(item.result) || '(no detail)'}</Text>
          ) : null}
        </Box>
      )
    }
    case 'status':
      return (
        <Text wrap="truncate-end" color={theme.color.muted}>
          {g.hbar} {statusLineText(item, g.sep, g.arrow)}
          {toolReason(item) ? <Text color={theme.color.dim}>  {toolReason(item)}</Text> : null}
        </Text>
      )
    case 'row':
      break
  }

  const reason = toolReason(item)
  const result = item.result ?? ''
  const more = lineCount(result) - 1
  return (
    <Box flexDirection="column" width={w}>
      {reason ? (
        <Text wrap="truncate-end">
          {status}
          <Text color={theme.color.text}> {truncate(reason, Math.max(8, w - 4 - item.name.length - (asyncBadge ? 8 : 0)))}</Text>
          <Text color={theme.color.tool}>  {item.name}</Text>
          {asyncBadge}
        </Text>
      ) : (
        <Text wrap="truncate-end">
          {status}
          <Text bold color={theme.color.tool}> {item.name}</Text>
          {asyncBadge}
          <Text color={theme.color.dim}> {previewJson(toolArgs(item.input), Math.max(8, w - item.name.length - 6 - (asyncBadge ? 8 : 0)))}</Text>
        </Text>
      )}
      {item.result !== undefined ? (
        <Text wrap="truncate-end" color={failed ? theme.color.error : theme.color.muted}>
          {'  '}{g.arrow} {truncate(oneLine(result.split('\n')[0] ?? '') || '(empty)', Math.max(4, w - 20))}
          {more > 0 ? <Text color={theme.color.dim}> (+{more} line{more === 1 ? '' : 's'}, Enter)</Text> : null}
        </Text>
      ) : null}
    </Box>
  )
}

function ItemBody({ item, width, expanded, showThinking, queued, viewportHeight, clipBottom = 0 }: Omit<ItemViewProps, 'selected'>) {
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
              {item.discarded ? <Text color={theme.color.warn}>  [not delivered]</Text> : null}
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
            {item.text ? <Markdown text={item.text} color={theme.color.assistant} viewport={viewportHeight === undefined ? undefined : { width: w - 2, height: viewportHeight + 2, clipBottom: Math.max(0, clipBottom - 1 - (item.interrupted ? 1 : 0)) }} /> : <Text> </Text>}
            {item.interrupted ? <Text color={theme.color.dim}>[interrupted]</Text> : null}
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
    case 'tool':
      return <ToolBody item={item} w={w} expanded={expanded} viewportHeight={viewportHeight} clipBottom={clipBottom} />
    case 'hil': {
      const tone = item.status === 'pending' ? theme.color.warn : item.status === 'approved' || item.status === 'completed' ? theme.color.success : theme.color.error
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
          <AskForm questions={item.questions} />
        </Box>
      )
    case 'notice':
      return (
        <Text wrap="truncate-end" color={item.level === 'warn' ? theme.color.warn : item.event === 'marker' ? theme.color.info : theme.color.muted}>
          {item.event === 'marker' ? g.arrow : g.hbar} {item.text}
        </Text>
      )
    case 'context': {
      if (item.ownerCommand) {
        const command = item.ownerCommand
        const tone = command.status === 'running' ? theme.color.tool : command.status === 'ok' ? theme.color.success : theme.color.error
        return <Box flexDirection="column" width={w}>
          <Text wrap="truncate-end">
            <Text color={tone}>{command.status === 'running' ? <Spinner color={tone} /> : command.status === 'ok' ? g.check : g.cross}</Text>
            <Text bold color={theme.color.tool}> You ran {command.command}</Text>
            <Text color={tone}> [{command.status === 'denied' ? 'permission denied' : command.status}]</Text>
            {command.authorized && <Text color={theme.color.warn}> [authorized]</Text>}
            <Text color={theme.color.dim}> {item.unrecorded ? '[not recorded]' : item.deferred ? '[recording after current step]' : ''} {expanded ? g.expanded : `${g.collapsed} Enter`}</Text>
          </Text>
          {expanded && <Box flexDirection="column" paddingLeft={2}>
            <Text wrap="wrap" color={theme.color.muted}>{item.text || (command.status === 'running' ? 'Running…' : '(empty)')}</Text>
            {command.status === 'denied' && <Text wrap="wrap" color={theme.color.warn}>Add !authorize to allow restricted calls for one run.</Text>}
          </Box>}
        </Box>
      }
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
  // The selected item gets a bar down its whole left edge (a shape, not just a
  // color: reads in every theme, mono and ASCII), so a tall item scrolled
  // part-way still shows it is the selected one.
  return (
    <Box flexDirection="row" width={props.width} marginBottom={gap} flexShrink={0}>
      <Box
        flexDirection="column"
        width={props.width}
        paddingLeft={props.selected ? 0 : 1}
        borderStyle={props.selected ? markBorder(theme) : undefined}
        borderLeft={props.selected}
        borderTop={false}
        borderRight={false}
        borderBottom={false}
        borderColor={theme.color.accent}
      >
        <ItemBody {...props} width={props.width - 1} />
      </Box>
    </Box>
  )
})

function markBorder(theme: Theme) {
  const m = theme.glyph.mark
  return { topLeft: m, top: ' ', topRight: ' ', left: m, bottomLeft: m, bottom: ' ', bottomRight: ' ', right: ' ' }
}
