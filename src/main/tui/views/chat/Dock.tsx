// The card under the transcript for whatever the loop is blocked on —
// a tool approval, a question for the owner, a suspend — plus queued sends.

import type { ReactNode } from 'react'
import { Box, Text } from 'ink'
import { useTheme } from '../../app/theme'
import { KeyHints } from '../../ui/KeyHint'
import { oneLine, previewJson, truncate, wrappedHeight } from '../../ui/text'
import type { AskEntry, TaskEntry } from '../../api/types'
import type { TranscriptItem } from '../../state/types'
import { parseArgs } from './model'

export interface DockModel {
  tasks: TaskEntry[]
  asks: AskEntry[]
  suspended: boolean
  queued: TranscriptItem[]
}

export type DockCard = 'hil' | 'ask' | 'suspend' | null

export function topCard(model: DockModel): DockCard {
  if (model.tasks.length > 0) return 'hil'
  if (model.asks.length > 0) return 'ask'
  if (model.suspended) return 'suspend'
  return null
}

const ASK_LINES = 3

export function taskReason(task: TaskEntry): string | undefined {
  const meta = task.approval_meta as { reason?: string; protection?: { description?: string } } | undefined
  if (!meta) return undefined
  return meta.protection?.description ?? (meta.reason === 'restricted' ? 'restricted tool - needs your approval' : meta.reason)
}

/** Rows the dock takes at `width` (must match the render). */
export function dockHeight(model: DockModel, width: number): number {
  const queued = model.queued.length > 0 ? 1 : 0
  switch (topCard(model)) {
    case 'hil': return queued + 2 + 3 + (taskReason(model.tasks[0]) ? 1 : 0)
    case 'ask': return queued + 2 + 2 + Math.min(ASK_LINES, wrappedHeight(model.asks[0].question || ' ', Math.max(8, width - 4)))
    case 'suspend': return queued + 2 + 2
    default: return queued
  }
}

export function Dock({ model, width, focused, agentLabel }: { model: DockModel; width: number; focused: boolean; agentLabel: string }) {
  const theme = useTheme()
  const g = theme.glyph
  const card = topCard(model)
  const inner = Math.max(8, width - 4)
  const act = (hints: Array<{ keys: string; label: string }>) => (
    focused ? <KeyHints hints={hints} /> : <Text wrap="truncate-end" color={theme.color.dim}>Shift+Tab: {hints.map(h => `${h.keys} ${h.label}`).join(` ${theme.glyph.sep} `)}</Text>
  )
  const border = (color: string | undefined, children: ReactNode) => (
    <Box width={width} flexDirection="column" borderStyle={theme.ascii ? 'classic' : 'round'} borderColor={color} paddingX={1}>{children}</Box>
  )

  return (
    <Box flexDirection="column" width={width}>
      {model.queued.length > 0 ? (
        <Text wrap="truncate-end" color={theme.color.warn}>
          {g.ellipsis} {model.queued.length} queued until the turn ends:
          <Text color={theme.color.muted}> {model.queued.map(q => truncate(oneLine(q.kind === 'user' ? q.text : ''), 40)).join(` ${g.sep} `)}</Text>
        </Text>
      ) : null}
      {card === 'hil' ? (() => {
        const task = model.tasks[0]
        const reason = taskReason(task)
        const more = model.tasks.length - 1
        return border(theme.color.warn, (
          <>
            <Text wrap="truncate-end">
              <Text bold color={theme.color.warn}>{g.warn} {agentLabel} wants to run </Text>
              <Text bold color={theme.color.tool}>{task.tool}</Text>
              {more > 0 ? <Text color={theme.color.muted}>  (+{more} more pending)</Text> : null}
              {model.asks.length > 0 ? <Text color={theme.color.muted}>  (+{model.asks.length} question{model.asks.length === 1 ? '' : 's'} waiting)</Text> : null}
            </Text>
            <Text wrap="truncate-end" color={theme.color.muted}>{previewJson(parseArgs(task.args), inner)}</Text>
            {reason ? <Text wrap="truncate-end" color={theme.color.dim}>{truncate(reason, inner)}</Text> : null}
            {act([{ keys: 'y', label: 'approve (twice)' }, { keys: 'n', label: 'deny' }, { keys: 'v', label: 'details' }])}
          </>
        ))
      })() : null}
      {card === 'ask' ? border(theme.color.warn, (
        <>
          <Text wrap="truncate-end" bold color={theme.color.warn}>? {agentLabel} asks you{model.asks.length > 1 ? `  (+${model.asks.length - 1} more)` : ''}</Text>
          <Box height={Math.min(ASK_LINES, wrappedHeight(model.asks[0].question || ' ', inner))} overflow="hidden">
            <Text wrap="wrap" color={theme.color.text}>{model.asks[0].question}</Text>
          </Box>
          <Text color={theme.color.dim} wrap="truncate-end">Type the answer in the prompt {g.sep} Enter sends it to the agent {focused ? `${g.sep} a to focus the prompt` : ''}</Text>
        </>
      )) : null}
      {card === 'suspend' ? border(theme.color.warn, (
        <>
          <Text bold color={theme.color.warn}>{g.warn} {agentLabel} is suspended and waiting for you</Text>
          {act([{ keys: 'y', label: 'resume' }, { keys: 'n', label: 'shut down' }])}
        </>
      )) : null}
    </Box>
  )
}
