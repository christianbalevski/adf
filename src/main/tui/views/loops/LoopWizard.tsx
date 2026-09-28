// Create / edit an inner loop: template → form → review (diff) → outcome.
// Creating with a schedule is one confirmed action: the loop, then a timer
// whose `loop` targets it; the outcome screen reports both results.

import { useMemo, useState } from 'react'
import { Box, Text, useApp } from 'ink'
import { useTheme } from '../../app/theme'
import { useKeys } from '../../app/keys'
import { useActions, useStore } from '../../state/store'
import { useAgent, useLoops } from '../../state/hooks'
import { List, ListRow } from '../../ui/List'
import { Modal } from '../../ui/Modal'
import { truncate } from '../../ui/text'
import { MAIN_LOOP, type LoopConfig, type LoopCreateInput, type LoopCreateResult, type LoopPatch, type LoopUpdateResult } from '../../api/types'
import { Form, type FieldSpec, type FormValues } from './Form'
import { attempt, agentName, openTab } from './common'
import { bumpLoopsData, useAgentTimers, useModelList } from './hooks'
import { editText, editorLabel, type EditResult } from '../../util/editor'
import {
  EMPTY_SCHEDULE,
  SCHEDULE_KIND_LABEL,
  SCHEDULE_KINDS,
  defaultTools,
  describeTimer,
  hostLoopTools,
  loopPatch,
  scheduleToTimer,
  timerTriggerWarning,
  timersForLoop,
  toolOptions,
  validateGoal,
  validateLoopName,
  type FieldChange,
  type ScheduleDraft,
  type ScheduleKind,
} from './model'
import { LOOP_TEMPLATES, findTemplate, freeName, type LoopTemplate } from './templates'
import type { OverlayProps } from '../types'

export interface LoopWizardProps {
  agentId: string
  mode: 'create' | 'edit'
  /** Edit: the loop to change. */
  name?: string
  /** Create: skip the picker and prefill from this template id. */
  template?: string
}

type Step = 'template' | 'form' | 'review' | 'running' | 'result'

interface Outcome {
  lines: Array<{ text: string; level: 'ok' | 'warn' | 'error' | 'info' }>
  loopName?: string
}

const WHEN_LABEL: Record<ScheduleKind, string> = { none: '', every: 'Every', daily: 'Daily at', cron: 'Cron', in: 'After', at: 'At' }
const WHEN_HINT: Record<ScheduleKind, string> = {
  none: '',
  every: '15m, 2h, 1h30m, 1d',
  daily: 'HH:MM local time, e.g. 03:00',
  cron: 'min hour day month weekday, e.g. 0 */6 * * *',
  in: 'delay, e.g. 10m',
  at: 'HH:MM, YYYY-MM-DD HH:MM or +2h',
}

function draftFromValues(v: FormValues): ScheduleDraft {
  return { kind: (v.scheduleKind as ScheduleKind) ?? 'none', value: String(v.scheduleValue ?? ''), payload: String(v.payload ?? ''), maxRuns: String(v.maxRuns ?? '') }
}

export function LoopWizard({ overlay, close, width, height }: OverlayProps) {
  const props = (overlay.props ?? {}) as unknown as LoopWizardProps
  const theme = useTheme()
  const store = useStore()
  const actions = useActions()
  const agent = useAgent(props.agentId)
  const loops = useLoops(props.agentId) ?? []
  const timers = useAgentTimers(props.agentId)
  const { suspendTerminal } = useApp()
  const config = agent?.config
  const host = hostLoopTools(config)
  const existing = props.mode === 'edit' ? loops.find(l => l.info.name === props.name)?.info.config ?? undefined : undefined
  const provider = config?.model?.provider
  const models = useModelList(props.agentId, provider)
  const takenNames = loops.map(l => l.info.name)

  const initialTemplate = props.mode === 'create' ? findTemplate(props.template) : undefined
  const [step, setStep] = useState<Step>(props.mode === 'create' && !initialTemplate ? 'template' : 'form')
  const [template, setTemplate] = useState<LoopTemplate | undefined>(initialTemplate)
  const [values, setValues] = useState<FormValues>(() => initialValues(props, existing, initialTemplate, host, takenNames))
  const [touched, setTouched] = useState(false)
  const [outcome, setOutcome] = useState<Outcome | null>(null)

  const dialogWidth = Math.max(40, Math.min(width - 4, 96))
  const inner = dialogWidth - 4
  const bodyRows = Math.max(6, height - 8)
  const label = agent ? agentName(store.getState(), props.agentId) : props.agentId

  const wanted = Array.isArray(values.tools) ? values.tools as string[] : []
  const options = toolOptions(host, [...wanted, ...(existing?.tools ?? []), ...(template?.tools ?? [])])
  const draft = draftFromValues(values)
  const loopName = props.mode === 'edit' ? props.name ?? '' : String(values.name ?? '')
  const schedule = scheduleToTimer(draft, loopName)
  const existingTimers = timers.data ? timersForLoop(timers.data, loopName) : []

  const errors = useMemo(() => {
    const e: Record<string, string | undefined> = {}
    if (props.mode === 'create') e.name = validateLoopName(String(values.name ?? ''), takenNames) ?? undefined
    e.goal = validateGoal(String(values.goal ?? '')) ?? undefined
    const compact = String(values.compact ?? '').trim()
    if (compact && !(Number.isInteger(Number(compact)) && Number(compact) > 0)) e.compact = 'Whole number of tokens, or empty to inherit'
    if (String(values.model ?? '').trim() && !String(values.provider ?? '').trim()) e.provider = 'Provider id is required with a model'
    if (schedule.error) e.scheduleValue = schedule.error
    return e
  }, [values, schedule.error, props.mode, existing])
  const hasErrors = Object.values(errors).some(Boolean)

  const fields: FieldSpec[] = [
    { kind: 'text', key: 'name', label: 'Name', placeholder: 'e.g. consolidator', readOnly: props.mode === 'edit', hint: 'lowercase letters, digits, _ -; cannot be renamed later' },
    { kind: 'text', key: 'goal', label: 'Goal', multiline: true, rows: 5, editor: true, placeholder: 'What this loop works on. Becomes its whole system instruction.', hint: 'Enter newline · Ctrl+O open in $EDITOR · ↓ next field' },
    { kind: 'checklist', key: 'tools', label: 'Tools', rows: 7, options: options.map(o => ({ value: o.name, note: o.unavailable ? 'not granted by host' : undefined })), hint: host ? 'restricted to tools the host has enabled; loop_compact/loop_clear are added by the runtime' : 'host tool list unknown: the daemon validates on save' },
    { kind: 'combo', key: 'model', label: 'Model', options: models.data?.models ?? [], placeholder: `inherit (${config?.model?.model_id ?? 'host model'})`, hint: models.data?.error ? `models: ${models.data.error}` : `←→ pick a ${provider ?? ''} model, type any id, empty = inherit` },
    { kind: 'text', key: 'provider', label: 'Provider', hidden: !String(values.model ?? '').trim(), hint: 'provider id for the override (another configured provider is allowed)' },
    { kind: 'bool', key: 'autonomous', label: 'Autonomous', hint: 'keep turning after text-only replies until the loop calls sys_set_state' },
    { kind: 'bool', key: 'autostart', label: 'Autostart', hint: 'run a first turn on the goal now and every time the agent starts' },
    { kind: 'text', key: 'compact', label: 'Compact at', placeholder: 'inherit host threshold', hint: 'token count at which this loop compacts its own history; empty = inherit' },
    { kind: 'bool', key: 'enabled', label: 'Enabled', hint: 'disabled loops keep their history and receive messages but never run' },
    { kind: 'choice', key: 'scheduleKind', label: props.mode === 'edit' ? 'Add schedule' : 'Schedule', options: SCHEDULE_KINDS.map(k => ({ value: k, label: SCHEDULE_KIND_LABEL[k] })), hint: 'a timer whose loop targets this loop; manage all timers in the Timers tab' },
    { kind: 'text', key: 'scheduleValue', label: WHEN_LABEL[draft.kind] || 'When', hidden: draft.kind === 'none', hint: WHEN_HINT[draft.kind] },
    { kind: 'text', key: 'payload', label: 'Wake message', hidden: draft.kind === 'none', placeholder: 'optional text the timer delivers', hint: 'what the loop sees when the timer wakes it' },
    { kind: 'text', key: 'maxRuns', label: 'Max runs', hidden: !['every', 'daily', 'cron'].includes(draft.kind), placeholder: 'unlimited' },
  ]

  const openEditor = (key: string) => {
    void (async () => {
      let result: EditResult = { text: null, changed: false, editor: editorLabel() }
      await suspendTerminal(async () => { result = await editText(String(values[key] ?? ''), { filename: 'loop-goal.md', trim: true }) })
      if (result.text !== null) setValues(v => ({ ...v, [key]: result.text as string }))
      else actions.toast(`Editor ${result.editor}: ${result.error ?? 'failed'} (set ADF_EDITOR, VISUAL or EDITOR)`, 'error')
    })()
  }

  const submitForm = () => {
    setTouched(true)
    if (hasErrors) { actions.toast('Fix the highlighted fields first', 'warn'); return }
    setStep('review')
  }

  const createInput = (): LoopCreateInput => {
    const model = String(values.model ?? '').trim()
    const compact = String(values.compact ?? '').trim()
    return {
      name: String(values.name),
      goal: String(values.goal).trim(),
      tools: wanted,
      enabled: !!values.enabled,
      autostart: !!values.autostart,
      autonomous: !!values.autonomous,
      ...(model ? { model: { provider: String(values.provider).trim(), model_id: model } as LoopConfig['model'] } : {}),
      ...(compact ? { compact_threshold: Number(compact) } : {}),
    }
  }

  const editPatch = (): { patch: LoopPatch; changes: FieldChange[] } => {
    if (!existing) return { patch: {}, changes: [] }
    const model = String(values.model ?? '').trim()
    const compact = String(values.compact ?? '').trim()
    const after: LoopPatch = {
      goal: String(values.goal).trim(),
      tools: wanted,
      enabled: !!values.enabled,
      autostart: !!values.autostart,
      autonomous: !!values.autonomous,
      // Empty model = inherit main's again: null removes the override.
      ...(model ? { model: { ...(existing.model ?? {}), provider: String(values.provider).trim(), model_id: model } as LoopConfig['model'] } : existing.model ? { model: null } : {}),
      ...(compact ? { compact_threshold: Number(compact) } : existing.compact_threshold != null ? { compact_threshold: null } : {}),
    }
    return loopPatch(existing, after)
  }

  const apply = async () => {
    setStep('running')
    const lines: Outcome['lines'] = []
    const agentId = props.agentId
    let name = loopName
    let loopOk = false
    if (props.mode === 'create') {
      const created = await attempt<LoopCreateResult>(actions, 'Create loop', c => c.createLoop(agentId, createInput()))
      if (created.ok) {
        loopOk = true
        name = created.value.loop.name
        lines.push({ level: 'ok', text: `Loop ${name} created (${created.value.loop.enabled ? 'enabled' : 'disabled'})` })
        lines.push({ level: 'info', text: `Effective tools: ${created.value.effectiveTools.join(', ') || '(none: this loop only thinks)'}` })
        if (created.value.excludedTools.length) lines.push({ level: 'warn', text: `Not granted yet (disabled on host): ${created.value.excludedTools.join(', ')}` })
        if (created.value.kickoff) lines.push({ level: created.value.kickoff.woke ? 'ok' : 'warn', text: created.value.kickoff.woke ? 'Autostart: first turn is running' : `Autostart kickoff queued, not woken${created.value.kickoff.reason ? `: ${created.value.kickoff.reason}` : ''}` })
      } else {
        lines.push({ level: 'error', text: `Loop not created: ${created.error}` })
      }
    } else {
      const { patch, changes } = editPatch()
      if (changes.length === 0) {
        loopOk = true
        lines.push({ level: 'info', text: 'Loop settings unchanged' })
      } else {
        const updated = await attempt<LoopUpdateResult>(actions, 'Update loop', c => c.updateLoop(agentId, name, patch))
        if (updated.ok) {
          loopOk = true
          lines.push({ level: 'ok', text: `Loop ${name} updated: ${updated.value.updated.join(', ')}` })
          if (updated.value.loop.effectiveTools) lines.push({ level: 'info', text: `Effective tools: ${updated.value.loop.effectiveTools.join(', ') || '(none)'}` })
          if (updated.value.excludedTools.length) lines.push({ level: 'warn', text: `Not granted yet (disabled on host): ${updated.value.excludedTools.join(', ')}` })
        } else {
          lines.push({ level: 'error', text: `Loop not updated: ${updated.error}` })
        }
      }
    }
    if (loopOk && schedule.input) {
      const timer = await attempt(actions, 'Schedule', c => c.createTimer(agentId, { ...schedule.input!, ...(name !== MAIN_LOOP ? { loop: name } : {}) }))
      if (timer.ok) lines.push({ level: 'ok', text: `Timer #${timer.value.id} scheduled: ${schedule.preview}` })
      else lines.push({ level: 'error', text: `Timer not created: ${timer.error} (the loop exists; add a schedule from the Timers tab)` })
    } else if (!loopOk && schedule.input) {
      lines.push({ level: 'info', text: 'Timer skipped because the loop was not saved' })
    }
    await actions.refreshLoops(agentId)
    bumpLoopsData(actions, store.getState())
    const failed = lines.some(l => l.level === 'error')
    actions.toast(lines.filter(l => l.level !== 'info').map(l => l.text).join(' · ') || 'Done', failed ? 'error' : 'success')
    setOutcome({ lines, loopName: loopOk ? name : undefined })
    setStep('result')
  }

  useKeys((input, key) => {
    if (step === 'review') {
      if (key.return || input === 'y' || (key.ctrl && input === 's')) { void apply(); return true }
      if (key.escape || input === 'n' || input === 'b') { setStep('form'); return true }
      return true
    }
    if (step === 'result') {
      if (input === 'c' && outcome?.loopName) {
        close()
        actions.selectLoop(props.agentId, outcome.loopName)
        actions.setView('chat')
        return true
      }
      if (input === 't' && outcome?.loopName) {
        close()
        openTab(actions, store.getState(), 'timers', { fleet: false })
        return true
      }
      if (key.return || key.escape) { close(); return true }
      return true
    }
    if (step === 'running') return true
    return false
  }, { layer: 'overlay', active: step === 'review' || step === 'result' || step === 'running' })

  const title = props.mode === 'create' ? `New inner loop ${theme.glyph.sep} ${label}` : `Edit loop ${props.name} ${theme.glyph.sep} ${label}`

  if (props.mode === 'edit' && !existing) {
    return <MissingLoop title={title} name={props.name ?? ''} close={close} width={dialogWidth} />
  }

  if (step === 'template') {
    return (
      <Modal title={title} width={dialogWidth} hints={[{ keys: 'up down', label: 'choose' }, { keys: 'enter', label: 'use template' }, { keys: 'esc', label: 'cancel' }]}>
        <Text color={theme.color.muted} wrap="wrap">Inner loops (side loops) are this agent's parallel threads, each with its own history and goal: a consolidator on a recurring timer, a researcher, a critic. Pick a starting point; everything stays editable and nothing is created until you confirm.</Text>
        <Box marginTop={1}>
          <TemplatePicker
            width={inner}
            height={Math.min(LOOP_TEMPLATES.length * 2, bodyRows - 3)}
            onPick={t => {
              setTemplate(t)
              setValues(initialValues(props, existing, t, host, takenNames))
              setStep('form')
            }}
            onCancel={close}
          />
        </Box>
      </Modal>
    )
  }

  if (step === 'form') {
    const warning = draft.kind !== 'none' ? timerTriggerWarning(config) : null
    return (
      <Modal title={title} width={dialogWidth} hints={[{ keys: 'up down', label: 'field' }, { keys: 'enter', label: 'next' }, { keys: 'ctrl+s', label: 'review' }, { keys: 'esc', label: props.mode === 'create' ? 'back to templates' : 'cancel' }]}>
        {template && props.mode === 'create' ? <Text color={theme.color.dim}>Template: {template.title}</Text> : null}
        <Form
          fields={fields}
          values={values}
          onChange={setValues}
          errors={touched ? errors : { ...errors, name: undefined, goal: undefined }}
          onSubmit={submitForm}
          onCancel={props.mode === 'create' ? () => setStep('template') : close}
          cancelLabel={props.mode === 'create' ? 'go back to the templates' : 'close'}
          onEditor={openEditor}
          width={inner}
          height={bodyRows - 4}
          initialField={props.mode === 'edit' ? 'goal' : template?.name ? 'goal' : 'name'}
          footer={
            <Box flexDirection="column" marginTop={1}>
              {draft.kind !== 'none' ? <Text color={schedule.error ? theme.color.error : theme.color.info}>{truncate(`Schedule: ${schedule.error ?? schedule.preview}`, inner)}</Text> : null}
              {props.mode === 'edit' && existingTimers.length > 0 ? <Text color={theme.color.muted}>{truncate(`Existing: ${existingTimers.map(t => describeTimer(t)).join(', ')}`, inner)}</Text> : null}
              {warning ? <Text color={theme.color.warn}>{truncate(`${theme.glyph.warn} ${warning}`, inner)}</Text> : null}
            </Box>
          }
        />
      </Modal>
    )
  }

  if (step === 'review' || step === 'running') {
    return (
      <Modal title={`${title} ${theme.glyph.sep} review`} width={dialogWidth} hints={step === 'running' ? [] : [{ keys: 'y enter', label: props.mode === 'create' ? 'create' : 'apply' }, { keys: 'n esc', label: 'back to form' }]}>
        {props.mode === 'create' ? <CreateReview input={createInput()} schedulePreview={schedule.input ? schedule.preview : null} width={inner} rows={bodyRows} /> : <EditReview changes={editPatch().changes} schedulePreview={schedule.input ? schedule.preview : null} width={inner} />}
        {schedule.input && timerTriggerWarning(config) ? <Text color={theme.color.warn}>{truncate(`${theme.glyph.warn} ${timerTriggerWarning(config)}`, inner)}</Text> : null}
        {step === 'running' ? <Text color={theme.color.live}>Applying{theme.glyph.ellipsis}</Text> : null}
      </Modal>
    )
  }

  return (
    <Modal title={`${title} ${theme.glyph.sep} done`} width={dialogWidth} hints={[{ keys: 'enter esc', label: 'close' }, ...(outcome?.loopName ? [{ keys: 'c', label: 'open chat on loop' }, { keys: 't', label: 'timers' }] : [])]}>
      {(outcome?.lines ?? []).map((line, i) => (
        <Text key={i} wrap="wrap" color={line.level === 'ok' ? theme.color.success : line.level === 'warn' ? theme.color.warn : line.level === 'error' ? theme.color.error : theme.color.text}>
          {line.level === 'ok' ? theme.glyph.check : line.level === 'error' ? theme.glyph.cross : line.level === 'warn' ? theme.glyph.warn : theme.glyph.bullet} {line.text}
        </Text>
      ))}
    </Modal>
  )
}

function initialValues(props: LoopWizardProps, existing: LoopConfig | undefined, template: LoopTemplate | undefined, host: string[] | null, taken: string[]): FormValues {
  if (props.mode === 'edit' && existing) {
    return {
      name: existing.name,
      goal: existing.goal,
      tools: [...(existing.tools ?? [])],
      model: existing.model?.model_id ?? '',
      provider: existing.model?.provider ?? '',
      autonomous: !!existing.autonomous,
      autostart: !!existing.autostart,
      compact: existing.compact_threshold != null ? String(existing.compact_threshold) : '',
      enabled: existing.enabled,
      scheduleKind: 'none',
      scheduleValue: '',
      payload: '',
      maxRuns: '',
    }
  }
  const schedule = template?.schedule ?? EMPTY_SCHEDULE
  const tools = template ? template.tools.filter(t => !host || host.includes(t)) : defaultTools(host)
  return {
    name: template ? freeName(template.name, taken) : '',
    goal: template?.goal ?? '',
    tools,
    model: '',
    provider: '',
    autonomous: template?.autonomous ?? false,
    autostart: template?.autostart ?? false,
    compact: '',
    enabled: true,
    scheduleKind: schedule.kind,
    scheduleValue: schedule.value,
    payload: schedule.payload,
    maxRuns: schedule.maxRuns ?? '',
  }
}

function TemplatePicker({ width, height, onPick, onCancel }: { width: number; height: number; onPick: (t: LoopTemplate) => void; onCancel: () => void }) {
  const theme = useTheme()
  return (
    <List
      items={LOOP_TEMPLATES}
      getKey={t => t.id}
      height={Math.max(2, height)}
      width={width}
      itemHeight={2}
      keyLayer="overlay"
      onSubmit={onPick}
      onKey={(_input, key) => {
        if (key.escape) { onCancel(); return true }
        return false
      }}
      renderItem={(t, { selected, width: w }) => (
        <Box flexDirection="column">
          <ListRow selected={selected} width={w} text={t.title} color={theme.color.loop} />
          <Text color={theme.color.muted}>{'    '}{truncate(t.summary, w - 4)}</Text>
        </Box>
      )}
    />
  )
}

function CreateReview({ input, schedulePreview, width, rows }: { input: LoopCreateInput; schedulePreview: string | null; width: number; rows: number }) {
  const theme = useTheme()
  const goalLines = input.goal.split('\n')
  const goalRows = Math.max(2, Math.min(goalLines.length, rows - 12))
  const line = (k: string, v: string) => (
    <Text key={k} wrap="truncate-end"><Text color={theme.color.muted}>{k.padEnd(14)}</Text><Text color={theme.color.text}>{truncate(v, width - 14)}</Text></Text>
  )
  return (
    <Box flexDirection="column">
      <Text color={theme.color.text}>Create inner loop <Text bold color={theme.color.loop}>{input.name}</Text>:</Text>
      {line('Goal', goalLines[0] ?? '')}
      {goalLines.slice(1, goalRows).map((g, i) => <Text key={i} color={theme.color.text}>{' '.repeat(14)}{truncate(g, width - 14)}</Text>)}
      {goalLines.length > goalRows ? <Text color={theme.color.dim}>{' '.repeat(14)}{goalLines.length - goalRows} more lines</Text> : null}
      {line('Tools', input.tools?.length ? input.tools.join(', ') : '(none: a mute loop that only thinks)')}
      {line('Model', input.model ? `${input.model.provider} / ${input.model.model_id}` : 'inherit host model')}
      {line('Flags', [input.enabled ? 'enabled' : 'disabled', input.autonomous ? 'autonomous' : 'ends turn on text reply', input.autostart ? 'autostart (runs now)' : 'no autostart'].join(', '))}
      {line('Compaction', input.compact_threshold ? `${input.compact_threshold} tokens` : 'inherit')}
      {line('Schedule', schedulePreview ?? 'none: runs when sent a message, a trigger or another loop wakes it')}
      <Text color={theme.color.dim}>The daemon reports the effective tool set after creating.</Text>
    </Box>
  )
}

function EditReview({ changes, schedulePreview, width }: { changes: FieldChange[]; schedulePreview: string | null; width: number }) {
  const theme = useTheme()
  if (changes.length === 0 && !schedulePreview) return <Text color={theme.color.muted}>No changes.</Text>
  return (
    <Box flexDirection="column">
      {changes.map(c => (
        <Box key={c.field} flexDirection="column">
          <Text bold color={theme.color.text}>{c.field}</Text>
          <Text color={theme.color.error} wrap="truncate-end">  - {truncate(c.before.replace(/\s+/g, ' '), width - 4)}</Text>
          <Text color={theme.color.success} wrap="truncate-end">  + {truncate(c.after.replace(/\s+/g, ' '), width - 4)}</Text>
        </Box>
      ))}
      {schedulePreview ? <Text color={theme.color.success}>  + new timer: {schedulePreview}</Text> : null}
      <Text color={theme.color.dim}>Changes apply immediately, also to a running turn at its next model call.</Text>
    </Box>
  )
}

function MissingLoop({ title, name, close, width }: { title: string; name: string; close: () => void; width: number }) {
  const theme = useTheme()
  useKeys(() => { close(); return true }, { layer: 'overlay' })
  return (
    <Modal title={title} width={width} hints={[{ keys: 'esc', label: 'close' }]}>
      <Text color={theme.color.warn}>{name === MAIN_LOOP ? 'main is the agent itself: change its instructions, model and tools in the agent config.' : `No inner loop named "${name}" on this agent.`}</Text>
    </Modal>
  )
}
