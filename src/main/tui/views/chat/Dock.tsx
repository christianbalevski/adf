// The card under the transcript for whatever the loop is blocked on —
// a tool approval, a question for the owner, a suspend — plus queued sends.

import { useRef, type ReactNode } from 'react'
import { Box, Text, type DOMElement } from 'ink'
import { useTheme } from '../../app/theme'
import { elementRect, keyLabel, useClick } from '../../app/keys'
import { displayWidth, oneLine, previewJson, truncate, wrappedHeight } from '../../ui/text'
import type { AskEntry, TaskEntry, TaskListEntry } from '../../api/types'
import type { TranscriptItem } from '../../state/types'
import type { AskAnswer } from '../../../../shared/utils/ask-form'
import { askHint, askStep, parseArgs } from './model'
import { alwaysBlocked } from './approvals'

export interface DockModel {
  tasks: TaskListEntry[]
  asks: AskEntry[]
  /** Answers given so far to the first ask (the prompt steps through its questions). */
  askAnswers?: AskAnswer[]
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
/** Options listed in the dock; the rest are still picked by number. */
const ASK_OPTIONS = 6

/** Rows of the ask card's body: the question, its options, the hint, the buttons. */
function askRows(ask: AskEntry, answers: AskAnswer[], inner: number): number {
  const { question } = askStep(ask, answers)
  const options = question.options?.length ?? 0
  const optionRows = Math.min(options, ASK_OPTIONS) + (options > ASK_OPTIONS ? 1 : 0)
  return 1 + Math.min(ASK_LINES, wrappedHeight(question.question || ' ', inner)) + optionRows + 1 + 1
}

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
    case 'ask': return queued + 2 + askRows(model.asks[0], model.askAnswers ?? [], Math.max(8, width - 4))
    case 'suspend': return queued + 2 + 2
    default: return queued
  }
}

export type DockAction = 'approve' | 'always' | 'reject' | 'feedback' | 'details' | 'resume' | 'shutdown' | 'answer' | 'skip'

interface DockButton { keys: string; label: string; action: DockAction; off?: string }

/**
 * The card's actions as a row of buttons: keys in the transcript (Shift+Tab
 * from the composer), clicks in mouse mode (a click is explicit: no second
 * press). A button that is not allowed shows greyed with why.
 */
function ActionRow({ buttons: all, focused, width, onAction }: { buttons: DockButton[]; focused: boolean; width: number; onAction?: (action: DockAction) => void }) {
  const theme = useTheme()
  const ref = useRef<DOMElement>(null)
  const sep = ` ${theme.glyph.sep} `
  const prefix = focused ? '' : 'Shift+Tab: '
  // Whole buttons only: the ones that do not fit are left off (all are in /help).
  const spans: Array<{ x0: number; x1: number; button: DockButton }> = []
  let x = displayWidth(prefix)
  for (const [i, button] of all.entries()) {
    const text = button.off ? `${button.label}: one-time only` : `${keyLabel(button.keys)} ${button.label}`
    const start = x + (i > 0 ? displayWidth(sep) : 0)
    if (start + displayWidth(text) > width) break
    spans.push({ x0: start, x1: start + displayWidth(text), button })
    x = start + displayWidth(text)
  }
  const buttons = spans.map(s => s.button)
  useClick(ref, event => {
    const rect = elementRect(ref.current)
    if (!rect || !onAction) return false
    const hit = spans.find(s => event.x - rect.x >= s.x0 && event.x - rect.x < s.x1)
    if (!hit) return false
    onAction(hit.button.action)
    return true
  }, { active: !!onAction })
  return (
    <Box ref={ref}>
      <Text wrap="truncate-end">
        {prefix ? <Text color={theme.color.dim}>{prefix}</Text> : null}
        {buttons.map((button, i) => (
          <Text key={button.action}>
            {i > 0 ? <Text color={theme.color.dim}>{sep}</Text> : null}
            {button.off
              ? <Text color={theme.color.dim}>{button.label}: one-time only</Text>
              : <><Text bold color={focused ? theme.color.accent : theme.color.muted}>{keyLabel(button.keys)}</Text><Text color={focused ? theme.color.muted : theme.color.dim}> {button.label}</Text></>}
          </Text>
        ))}
      </Text>
    </Box>
  )
}

export function Dock({ model, width, focused, agentLabel, onAction }: { model: DockModel; width: number; focused: boolean; agentLabel: string; onAction?: (action: DockAction) => void }) {
  const theme = useTheme()
  const g = theme.glyph
  const card = topCard(model)
  const inner = Math.max(8, width - 4)
  const act = (buttons: DockButton[]) => <ActionRow buttons={buttons} focused={focused} width={inner} onAction={onAction} />
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
            {act([
              { keys: 'y', label: 'approve', action: 'approve' },
              { keys: 'a', label: 'always', action: 'always', off: alwaysBlocked(task) ?? undefined },
              { keys: 'n', label: 'reject', action: 'reject' },
              { keys: 'f', label: 'feedback', action: 'feedback' },
              { keys: 'v', label: 'details', action: 'details' },
            ].sort((a, b) => (a.off ? 1 : 0) - (b.off ? 1 : 0)) as DockButton[])}
          </>
        ))
      })() : null}
      {card === 'ask' ? (() => {
        // One question at a time; the prompt answers the one shown.
        const ask = model.asks[0]
        const { index, question } = askStep(ask, model.askAnswers ?? [])
        const options = question.options ?? []
        const total = ask.questions.length
        const number = (n: number) => `${n}.`.padStart(String(options.length).length + 1)
        return border(theme.color.warn, (
          <>
            <Text wrap="truncate-end">
              <Text bold color={theme.color.warn}>? {agentLabel} asks you</Text>
              {total > 1 ? <Text color={theme.color.muted}>  {index + 1}/{total}</Text> : null}
              {model.asks.length > 1 ? <Text color={theme.color.muted}>  (+{model.asks.length - 1} more)</Text> : null}
            </Text>
            <Box height={Math.min(ASK_LINES, wrappedHeight(question.question || ' ', inner))} overflow="hidden">
              <Text wrap="wrap" color={theme.color.text}>{question.question}</Text>
            </Box>
            {options.slice(0, ASK_OPTIONS).map((option, i) => (
              <Text key={i} wrap="truncate-end">
                <Text color={theme.color.accent}>{number(i + 1)}</Text>
                <Text color={theme.color.text}> {option.label}</Text>
                {option.description ? <Text color={theme.color.dim}>  {option.description}</Text> : null}
              </Text>
            ))}
            {options.length > ASK_OPTIONS ? <Text wrap="truncate-end" color={theme.color.dim}>{g.ellipsis} {options.length - ASK_OPTIONS} more, {ASK_OPTIONS + 1}–{options.length} by number</Text> : null}
            <Text wrap="truncate-end" color={theme.color.dim}>{askHint(question)}</Text>
            {act([
              { keys: 'a', label: 'answer', action: 'answer' },
              { keys: 'x', label: index > 0 ? 'skip the rest' : total > 1 ? 'skip all' : 'skip', action: 'skip' },
            ])}
          </>
        ))
      })() : null}
      {card === 'suspend' ? border(theme.color.warn, (
        <>
          <Text bold color={theme.color.warn}>{g.warn} {agentLabel} is suspended and waiting for you</Text>
          {act([{ keys: 'y', label: 'resume', action: 'resume' }, { keys: 'n', label: 'shut down', action: 'shutdown' }])}
        </>
      )) : null}
    </Box>
  )
}
