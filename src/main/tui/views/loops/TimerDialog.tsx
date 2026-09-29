// Create / edit a timer: schedule, target loop, scope, payload — with a live
// "every 15m, next at 14:30" preview and a review step before anything is
// written. Moving a timer to another loop keeps its id; an older daemon that
// ignores the move gets an explicit re-create (new id) instead.

import { useMemo, useState } from 'react'
import { Box, Text } from 'ink'
import { useTheme } from '../../app/theme'
import { useKeys } from '../../app/keys'
import { useActions, useStore } from '../../state/store'
import { useAgent, useLoops } from '../../state/hooks'
import { Modal } from '../../ui/Modal'
import { truncate } from '../../ui/text'
import { MAIN_LOOP, type Timer, type TimerInput } from '../../api/types'
import { Form, type FieldSpec, type FormValues } from './Form'
import { attempt, agentName } from './common'
import { bumpLoopsData, useAgentTimers } from './hooks'
import {
  SCHEDULE_KIND_LABEL,
  SCHEDULE_KINDS,
  describeTimer,
  formatWhen,
  scheduleToTimer,
  timerLoop,
  timerToDraft,
  timerTriggerWarning,
  type ScheduleKind,
} from './model'
import type { OverlayProps } from '../types'

export interface TimerDialogProps {
  agentId: string
  /** Edit this timer; absent = create. */
  timerId?: number
  /** Preselected target loop for a new timer. */
  loop?: string
}

type Step = 'form' | 'review' | 'running' | 'result'
type ScopeChoice = 'agent' | 'system' | 'both'

const WHEN_LABEL: Record<ScheduleKind, string> = { none: 'When', every: 'Every', daily: 'Daily at', cron: 'Cron', in: 'After', at: 'At' }
const WHEN_HINT: Record<ScheduleKind, string> = {
  none: '',
  every: '15m, 2h, 1h30m, 1d',
  daily: 'HH:MM local time, e.g. 03:00',
  cron: 'min hour day month weekday, e.g. 0 */6 * * *',
  in: 'delay, e.g. 10m',
  at: 'HH:MM, YYYY-MM-DD HH:MM or +2h',
}

function scopeOf(choice: ScopeChoice): Array<'agent' | 'system'> {
  return choice === 'both' ? ['system', 'agent'] : [choice]
}

function choiceOf(scope: string[] | undefined): ScopeChoice {
  const agent = !!scope?.includes('agent')
  const system = !!scope?.includes('system')
  return agent && system ? 'both' : system ? 'system' : 'agent'
}

export function TimerDialog({ overlay, close, width, height }: OverlayProps) {
  const props = (overlay.props ?? {}) as unknown as TimerDialogProps
  const theme = useTheme()
  const store = useStore()
  const actions = useActions()
  const agent = useAgent(props.agentId)
  const loops = useLoops(props.agentId) ?? []
  const timers = useAgentTimers(props.agentId)
  const existing: Timer | undefined = props.timerId !== undefined ? timers.data?.find(t => t.id === props.timerId) : undefined
  const editing = props.timerId !== undefined
  const [values, setValues] = useState<FormValues | null>(() => (editing ? null : initialValues(undefined, props.loop)))
  const [step, setStep] = useState<Step>('form')
  const [touched, setTouched] = useState(false)
  const [outcome, setOutcome] = useState<Array<{ text: string; level: 'ok' | 'error' | 'info' }>>([])
  const current = values ?? (existing ? initialValues(existing) : null)

  const dialogWidth = Math.max(40, Math.min(width - 4, 90))
  const inner = dialogWidth - 4
  const bodyRows = Math.max(6, height - 8)
  const label = agentName(store.getState(), props.agentId)
  const loopNames = [MAIN_LOOP, ...loops.filter(l => !l.info.isMain).map(l => l.info.name)]
  if (current && !loopNames.includes(String(current.loop))) loopNames.push(String(current.loop))

  const scopeChoice = (current?.scope as ScopeChoice) ?? 'agent'
  const kind = (current?.scheduleKind as ScheduleKind) ?? 'every'
  const targetLoop = scopeChoice === 'system' ? undefined : String(current?.loop ?? MAIN_LOOP)
  const result = current
    ? scheduleToTimer(
      { kind, value: String(current.scheduleValue ?? ''), payload: String(current.payload ?? ''), maxRuns: String(current.maxRuns ?? '') },
      targetLoop,
      { scope: scopeOf(scopeChoice), lambda: String(current.lambda ?? '').trim() || undefined },
    )
    : null
  const input: TimerInput | undefined = result?.input ? { ...result.input, ...(current?.locked ? { locked: true } : {}) } : undefined
  const oldLoop = existing ? timerLoop(existing) : null
  const loopChanged = !!existing && (targetLoop ?? null) !== oldLoop && targetLoop !== undefined && oldLoop !== null

  const errors = useMemo(() => {
    const e: Record<string, string | undefined> = {}
    if (result?.error) e.scheduleValue = result.error
    if (scopeChoice !== 'agent' && !String(current?.lambda ?? '').trim()) e.lambda = 'System-scope timers run a lambda: path/file.ts:functionName'
    return e
  }, [result?.error, scopeChoice, current?.lambda])
  const hasErrors = Object.values(errors).some(Boolean)

  const fields: FieldSpec[] = [
    { kind: 'choice', key: 'loop', label: 'Target loop', hidden: scopeChoice === 'system', options: loopNames.map(n => ({ value: n, label: n === MAIN_LOOP ? 'main (talks to you)' : n })), hint: editing ? 'moving keeps the timer id (an older daemon gets a new timer instead)' : 'the loop this timer wakes' },
    { kind: 'choice', key: 'scope', label: 'Scope', options: [{ value: 'agent', label: 'agent (wake the loop)' }, { value: 'system', label: 'system (run a lambda)' }, { value: 'both', label: 'both' }] },
    { kind: 'text', key: 'lambda', label: 'Lambda', hidden: scopeChoice === 'agent', placeholder: 'lib/jobs.ts:nightly', hint: 'system scope runs under main\'s authority and wakes no loop' },
    { kind: 'choice', key: 'scheduleKind', label: 'Schedule', options: SCHEDULE_KINDS.filter(k => k !== 'none').map(k => ({ value: k, label: SCHEDULE_KIND_LABEL[k] })) },
    { kind: 'text', key: 'scheduleValue', label: WHEN_LABEL[kind], hint: WHEN_HINT[kind] },
    { kind: 'text', key: 'payload', label: 'Wake message', placeholder: 'optional text delivered on fire' },
    { kind: 'text', key: 'maxRuns', label: 'Max runs', hidden: !['every', 'daily', 'cron'].includes(kind), placeholder: 'unlimited' },
    { kind: 'bool', key: 'locked', label: 'Owner lock', hint: 'the agent cannot modify or delete a locked timer' },
  ]

  const apply = async () => {
    if (!input) return
    setStep('running')
    const lines: typeof outcome = []
    const agentId = props.agentId
    if (!editing) {
      const created = await attempt(actions, 'Create timer', c => c.createTimer(agentId, input))
      lines.push(created.ok ? { level: 'ok', text: `Timer #${created.value.id} created: ${result?.preview}` } : { level: 'error', text: `Timer not created: ${created.error}` })
    } else if (loopChanged) {
      // Loop-aware daemons move the timer in place (same id); an older daemon
      // ignores `loop` on update, detected by reading it back → re-create.
      const target = targetLoop ?? MAIN_LOOP
      const updated = await attempt(actions, 'Move timer', c => c.updateTimer(agentId, props.timerId!, { ...input, loop: target }))
      const after = updated.ok ? await attempt(actions, 'Timers', c => c.timers(agentId)) : null
      const moved = after?.ok ? after.value.timers.find(t => t.id === props.timerId) : undefined
      if (!updated.ok) {
        lines.push({ level: 'error', text: `Timer not moved: ${updated.error}. #${props.timerId} is unchanged.` })
      } else if (moved && (moved.loop ?? MAIN_LOOP) === target) {
        lines.push({ level: 'ok', text: `Timer #${props.timerId} moved from loop ${oldLoop} to ${target}: ${result?.preview}` })
      } else {
        lines.push({ level: 'info', text: `This daemon kept timer #${props.timerId} on loop ${oldLoop}; re-creating it for ${target}` })
        const created = await attempt(actions, 'Create timer', c => c.createTimer(agentId, input))
        if (created.ok) {
          lines.push({ level: 'ok', text: `Timer #${created.value.id} created for loop ${target}: ${result?.preview}` })
          const removed = await attempt(actions, 'Delete timer', c => c.deleteTimer(agentId, props.timerId!))
          lines.push(removed.ok && removed.value.success ? { level: 'ok', text: `Old timer #${props.timerId} (loop ${oldLoop}) deleted` } : { level: 'error', text: `Old timer #${props.timerId} not deleted: ${removed.ok ? 'daemon refused' : removed.error}. Both timers exist now.` })
        } else {
          lines.push({ level: 'error', text: `Timer not moved: ${created.error}. #${props.timerId} is unchanged.` })
        }
      }
    } else {
      const updated = await attempt(actions, 'Update timer', c => c.updateTimer(agentId, props.timerId!, input))
      lines.push(updated.ok ? { level: 'ok', text: `Timer #${props.timerId} updated: ${result?.preview}` } : { level: 'error', text: `Timer not updated: ${updated.error}` })
    }
    bumpLoopsData(actions, store.getState())
    actions.toast(lines.map(l => l.text).join(' · '), lines.some(l => l.level === 'error') ? 'error' : 'success')
    setOutcome(lines)
    setStep('result')
  }

  useKeys((inputKey, key) => {
    if (step === 'review') {
      if (key.return || inputKey === 'y' || (key.ctrl && inputKey === 's')) { void apply(); return true }
      if (key.escape || inputKey === 'n' || inputKey === 'b') { setStep('form'); return true }
      return true
    }
    if (step === 'result') { if (key.return || key.escape) close(); return true }
    if (step === 'running') return true
    if (!current && key.escape) { close(); return true }
    return !current
  }, { layer: 'overlay', active: step !== 'form' || !current })

  const title = `${editing ? `Edit timer #${props.timerId}` : 'New timer'} ${theme.glyph.sep} ${label}`

  if (!current) {
    return (
      <Modal title={title} width={dialogWidth} hints={[{ keys: 'esc', label: 'close' }]}>
        <Text color={timers.error ? theme.color.error : theme.color.muted}>{timers.error ?? (timers.loading ? 'Loading timer…' : `No timer #${props.timerId} on this agent.`)}</Text>
      </Modal>
    )
  }

  if (step === 'form') {
    const warning = scopeChoice !== 'system' ? timerTriggerWarning(agent?.config) : null
    return (
      <Modal title={title} width={dialogWidth} hints={[{ keys: 'up down', label: 'field' }, { keys: 'ctrl+s', label: 'review' }, { keys: 'esc', label: 'cancel' }]}>
        <Form
          fields={fields}
          values={current}
          onChange={setValues}
          errors={touched ? errors : { ...errors, lambda: undefined }}
          onSubmit={() => {
            setTouched(true)
            if (hasErrors || !input) { actions.toast('Fix the highlighted fields first', 'warn'); return }
            setStep('review')
          }}
          onCancel={close}
          width={inner}
          height={bodyRows - 3}
          initialField={editing ? 'scheduleValue' : props.loop ? 'scheduleKind' : 'loop'}
          footer={
            <Box flexDirection="column" marginTop={1}>
              <Text color={result?.error ? theme.color.error : theme.color.info}>{truncate(`Preview: ${result?.error ?? result?.preview ?? ''}${targetLoop ? ` ${theme.glyph.arrow} wakes ${targetLoop}` : ''}`, inner)}</Text>
              {existing ? <Text color={theme.color.muted}>{truncate(`Now: ${describeTimer(existing)}, next ${formatWhen(existing.next_wake_at)}, loop ${oldLoop ?? '(system)'}`, inner)}</Text> : null}
              {warning ? <Text color={theme.color.warn}>{truncate(`${theme.glyph.warn} ${warning}`, inner)}</Text> : null}
            </Box>
          }
        />
      </Modal>
    )
  }

  if (step === 'review' || step === 'running') {
    return (
      <Modal title={`${title} ${theme.glyph.sep} review`} width={dialogWidth} hints={step === 'running' ? [] : [{ keys: 'y enter', label: editing ? 'apply' : 'create' }, { keys: 'n esc', label: 'back' }]}>
        {existing ? <Text color={theme.color.error}>- {truncate(`${describeTimer(existing)} · loop ${oldLoop ?? '(system)'} · ${existing.payload ?? ''}`, inner - 2)}</Text> : null}
        <Text color={theme.color.success}>{existing ? '+ ' : ''}{truncate(`${result?.preview} · ${targetLoop ? `loop ${targetLoop}` : 'system scope'}${input?.payload ? ` · "${input.payload}"` : ''}${input?.locked ? ' · locked' : ''}`, inner - 2)}</Text>
        {loopChanged ? <Text color={theme.color.warn} wrap="wrap">The target loop changes from {oldLoop} to {targetLoop}: timer #{props.timerId} will wake {targetLoop} instead. (An older daemon that cannot move timers gets a new timer and #{props.timerId} is deleted.)</Text> : null}
        {step === 'running' ? <Text color={theme.color.live}>Applying{theme.glyph.ellipsis}</Text> : null}
      </Modal>
    )
  }

  return (
    <Modal title={`${title} ${theme.glyph.sep} done`} width={dialogWidth} hints={[{ keys: 'enter esc', label: 'close' }]}>
      {outcome.map((line, i) => (
        <Text key={i} wrap="wrap" color={line.level === 'ok' ? theme.color.success : line.level === 'error' ? theme.color.error : theme.color.text}>
          {line.level === 'ok' ? theme.glyph.check : line.level === 'error' ? theme.glyph.cross : theme.glyph.bullet} {line.text}
        </Text>
      ))}
    </Modal>
  )
}

function initialValues(timer: Timer | undefined, loop?: string): FormValues {
  if (timer) {
    const draft = timerToDraft(timer)
    return {
      loop: timer.loop ?? MAIN_LOOP,
      scope: choiceOf(timer.scope),
      lambda: timer.lambda ?? '',
      scheduleKind: draft.kind === 'none' ? 'every' : draft.kind,
      scheduleValue: draft.value,
      payload: draft.payload,
      maxRuns: draft.maxRuns ?? '',
      locked: !!timer.locked,
    }
  }
  return { loop: loop ?? MAIN_LOOP, scope: 'agent', lambda: '', scheduleKind: 'every', scheduleValue: '1h', payload: '', maxRuns: '', locked: false }
}
