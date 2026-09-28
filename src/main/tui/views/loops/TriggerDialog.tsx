// Edit one trigger (enabled + targets, including each target's loop). Works on
// a local draft; nothing is written until the diff is reviewed and confirmed.

import { useState } from 'react'
import { Box, Text } from 'ink'
import { useTheme } from '../../app/theme'
import { useKeys } from '../../app/keys'
import { useActions, useStore } from '../../state/store'
import { useLoops } from '../../state/hooks'
import { List, ListRow } from '../../ui/List'
import { Modal } from '../../ui/Modal'
import { truncate } from '../../ui/text'
import { MAIN_LOOP } from '../../api/types'
import { Form, type FieldSpec, type FormValues } from './Form'
import { agentName } from './common'
import { useAsyncData } from './hooks'
import { describeTarget, formatDuration, parseDuration, type TriggerConfig, type TriggerTarget, type TriggerTypeV3 } from './model'
import { diffText, writeTrigger } from './trigger-ops'
import type { OverlayProps } from '../types'

export interface TriggerDialogProps {
  agentId: string
  type: TriggerTypeV3
}

type Step = 'targets' | 'target' | 'review' | 'running' | 'result'
type Timing = 'none' | 'debounce' | 'interval' | 'batch'

export function TriggerDialog({ overlay, close, width, height }: OverlayProps) {
  const props = (overlay.props ?? {}) as unknown as TriggerDialogProps
  const theme = useTheme()
  const store = useStore()
  const actions = useActions()
  const loops = useLoops(props.agentId) ?? []
  const loaded = useAsyncData(c => c.config(props.agentId), [props.agentId])
  const original: TriggerConfig | undefined = loaded.data?.config.triggers?.[props.type]
  const [draft, setDraft] = useState<TriggerConfig | null>(null)
  const current: TriggerConfig | null = draft ?? (loaded.data ? original ?? { enabled: false, targets: [] } : null)
  const [step, setStep] = useState<Step>('targets')
  const [index, setIndex] = useState(0)
  const [editing, setEditing] = useState<number | null>(null)
  const [targetValues, setTargetValues] = useState<FormValues>({})
  const [targetErrors, setTargetErrors] = useState<Record<string, string | undefined>>({})
  const [message, setMessage] = useState('')

  const dialogWidth = Math.max(44, Math.min(width - 4, 96))
  const inner = dialogWidth - 4
  const bodyRows = Math.max(6, height - 8)
  const title = `Trigger ${props.type} ${theme.glyph.sep} ${agentName(store.getState(), props.agentId)}`
  const loopNames = [MAIN_LOOP, ...loops.filter(l => !l.info.isMain).map(l => l.info.name)]
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(original ?? { enabled: false, targets: [] })
  const [confirmClose, setConfirmClose] = useState(false)

  const update = (next: TriggerConfig) => setDraft(next)

  const openTarget = (i: number | null) => {
    const target = i === null ? undefined : current?.targets[i]
    setEditing(i)
    setTargetValues(targetToValues(target))
    setTargetErrors({})
    setStep('target')
  }

  const saveTarget = () => {
    if (!current) return
    const built = valuesToTarget(targetValues, editing === null ? undefined : current.targets[editing])
    if ('errors' in built) { setTargetErrors(built.errors); return }
    const targets = [...current.targets]
    if (editing === null) targets.push(built.target)
    else targets[editing] = built.target
    update({ ...current, targets })
    setIndex(editing ?? targets.length - 1)
    setStep('targets')
  }

  const apply = async () => {
    if (!current) return
    setStep('running')
    const result = await writeTrigger(actions, props.agentId, props.type, original, current)
    setMessage(result.message)
    if (result.ok) setDraft(null)
    setStep('result')
    if (result.ok) loaded.reload()
  }

  useKeys((input, key) => {
    if (step === 'targets' && confirmClose) {
      if (input === 'y' || key.return) { close(); return true }
      if (input === 'n' || key.escape || (key.ctrl && input === 'c')) setConfirmClose(false)
      return true
    }
    if (step === 'targets') {
      if (key.escape || (key.ctrl && input === 'c')) { if (dirty) setConfirmClose(true); else close(); return true }
      if (key.ctrl && input === 's') { if (dirty) setStep('review'); else actions.toast('No changes to save', 'info'); return true }
      if (!current) return true
      if (input === 'x' || input === ' ') { update({ ...current, enabled: !current.enabled }); return true }
      if (input === 'n') { openTarget(null); return true }
      if ((input === 'd' || key.delete) && current.targets[index]) {
        update({ ...current, targets: current.targets.filter((_, i) => i !== index) })
        setIndex(Math.max(0, index - 1))
        return true
      }
      if (input === 'u' && dirty) { setDraft(null); return true }
      return false
    }
    if (step === 'review') {
      if (key.return || input === 'y') { void apply(); return true }
      if (key.escape || input === 'n' || input === 'b') { setStep('targets'); return true }
      return true
    }
    if (step === 'result') { if (key.return || key.escape) close(); return true }
    return true
  }, { layer: 'overlay', active: step !== 'target' })

  if (!current) {
    return (
      <Modal title={title} width={dialogWidth} hints={[{ keys: 'esc', label: 'close' }]}>
        <Text color={loaded.error ? theme.color.error : theme.color.muted}>{loaded.error ?? 'Loading config…'}</Text>
      </Modal>
    )
  }

  if (step === 'target') {
    const scope = String(targetValues.scope ?? 'agent')
    const timing = String(targetValues.timing ?? 'none') as Timing
    const fields: FieldSpec[] = [
      { kind: 'choice', key: 'scope', label: 'Scope', options: [{ value: 'agent', label: 'agent (wake a loop)' }, { value: 'system', label: 'system (lambda / command)' }] },
      { kind: 'choice', key: 'loop', label: 'Target loop', hidden: scope !== 'agent', options: withCurrent(loopNames, String(targetValues.loop ?? MAIN_LOOP)).map(n => ({ value: n, label: n })), hint: 'which of the agent\'s loops this trigger wakes' },
      { kind: 'text', key: 'lambda', label: 'Lambda', hidden: scope !== 'system', placeholder: 'path/file.ts:functionName' },
      { kind: 'text', key: 'command', label: 'Command', hidden: scope !== 'system', placeholder: 'shell command (instead of a lambda)' },
      { kind: 'bool', key: 'warm', label: 'Warm', hidden: scope !== 'system' },
      { kind: 'choice', key: 'timing', label: 'Timing', options: [{ value: 'none', label: 'immediate' }, { value: 'debounce', label: 'debounce' }, { value: 'interval', label: 'at most every' }, { value: 'batch', label: 'batch window' }] },
      { kind: 'text', key: 'timingValue', label: 'Window', hidden: timing === 'none', placeholder: '30s, 5m', hint: 'duration like 30s, 5m, 1h' },
      { kind: 'text', key: 'batchCount', label: 'Batch count', hidden: timing !== 'batch', placeholder: 'optional: fire early after N events' },
      { kind: 'text', key: 'filter', label: 'Filter (JSON)', placeholder: '{"source":"telegram"}', hint: `per-type filter fields, e.g. watch, sender, tools, level` },
      { kind: 'bool', key: 'locked', label: 'Owner lock', hint: 'the agent cannot modify or remove this target' },
    ]
    return (
      <Modal title={`${title} ${theme.glyph.sep} ${editing === null ? 'new target' : `target ${editing + 1}`}`} width={dialogWidth} hints={[{ keys: 'ctrl+s', label: 'keep target' }, { keys: 'esc', label: 'back' }]}>
        <Form
          fields={fields}
          values={targetValues}
          onChange={setTargetValues}
          errors={targetErrors}
          onSubmit={saveTarget}
          onCancel={() => setStep('targets')}
          width={inner}
          height={bodyRows - 2}
          initialField="scope"
        />
      </Modal>
    )
  }

  if (step === 'review' || step === 'running') {
    const lines = diffText({ [props.type]: original ?? null }, { [props.type]: current }, Math.max(6, bodyRows - 4)).split('\n')
    return (
      <Modal title={`${title} ${theme.glyph.sep} review`} width={dialogWidth} hints={step === 'running' ? [] : [{ keys: 'y enter', label: 'write config' }, { keys: 'n esc', label: 'back' }]}>
        <Text color={theme.color.muted}>PUT /agents/:id/config (only triggers.{props.type} changes):</Text>
        {lines.map((line, i) => (
          <Text key={i} color={line.startsWith('+') ? theme.color.success : line.startsWith('-') ? theme.color.error : theme.color.dim} wrap="truncate-end">{truncate(line, inner)}</Text>
        ))}
        {step === 'running' ? <Text color={theme.color.live}>Writing{theme.glyph.ellipsis}</Text> : null}
      </Modal>
    )
  }

  if (step === 'result') {
    return (
      <Modal title={`${title} ${theme.glyph.sep} done`} width={dialogWidth} hints={[{ keys: 'enter esc', label: 'close' }]}>
        <Text wrap="wrap" color={draft ? theme.color.error : theme.color.success}>{message}</Text>
      </Modal>
    )
  }

  return (
    <Modal
      title={title}
      width={dialogWidth}
      hints={[{ keys: 'x', label: current.enabled ? 'disable' : 'enable' }, { keys: 'n', label: 'add target' }, { keys: 'enter', label: 'edit target' }, { keys: 'd', label: 'remove' }, { keys: 'ctrl+s', label: 'review & save' }, { keys: 'esc', label: dirty ? 'discard' : 'close' }]}
    >
      <Text>
        <Text color={theme.color.muted}>Status: </Text>
        <Text bold color={current.enabled ? theme.color.success : theme.color.dim}>{current.enabled ? 'enabled' : 'disabled'}</Text>
        {current.locked ? <Text color={theme.color.warn}>  owner-locked</Text> : null}
        {dirty ? <Text color={theme.color.warn}>  unsaved changes (u undo all)</Text> : null}
        {confirmClose ? <Text bold color={theme.color.warn}>  {theme.glyph.warn} Discard unsaved trigger changes and close? y discard {theme.glyph.sep} n keep editing</Text> : null}
      </Text>
      <Text color={theme.color.muted}>Targets ({current.targets.length}):</Text>
      <List
        items={current.targets.map((t, i) => ({ t, i }))}
        getKey={x => String(x.i)}
        height={Math.max(2, Math.min(current.targets.length || 1, bodyRows - 5))}
        width={inner}
        keyLayer="overlay"
        selectedIndex={index}
        onSelectedIndexChange={i => setIndex(i)}
        onSubmit={x => openTarget(x.i)}
        emptyText="No targets: this trigger wakes nothing. Press n to add one."
        renderItem={(x, { selected, width: w }) => <ListRow selected={selected} width={w} text={`${x.i + 1}. ${describeTarget(x.t)}`} color={x.t.scope === 'agent' ? theme.color.loop : theme.color.text} />}
      />
    </Modal>
  )
}

function withCurrent(names: string[], current: string): string[] {
  return names.includes(current) ? names : [...names, current]
}

function targetToValues(target: TriggerTarget | undefined): FormValues {
  const timing: Timing = target?.batch_ms ? 'batch' : target?.interval_ms ? 'interval' : target?.debounce_ms ? 'debounce' : 'none'
  const ms = target?.batch_ms ?? target?.interval_ms ?? target?.debounce_ms
  return {
    scope: target?.scope ?? 'agent',
    loop: target?.loop ?? MAIN_LOOP,
    lambda: target?.lambda ?? '',
    command: target?.command ?? '',
    warm: !!target?.warm,
    timing,
    timingValue: ms ? formatDuration(ms) : '',
    batchCount: target?.batch_count ? String(target.batch_count) : '',
    filter: target?.filter && Object.keys(target.filter).length ? JSON.stringify(target.filter) : '',
    locked: !!target?.locked,
  }
}

export function valuesToTarget(v: FormValues, base?: TriggerTarget): { target: TriggerTarget } | { errors: Record<string, string> } {
  const errors: Record<string, string> = {}
  const scope = v.scope === 'system' ? 'system' : 'agent'
  const target: TriggerTarget = { ...(base ?? {}), scope } as TriggerTarget
  for (const key of ['loop', 'lambda', 'command', 'warm', 'debounce_ms', 'interval_ms', 'batch_ms', 'batch_count', 'filter', 'locked'] as const) delete target[key]
  if (scope === 'agent') {
    const loop = String(v.loop ?? MAIN_LOOP)
    if (loop !== MAIN_LOOP) target.loop = loop
  } else {
    const lambda = String(v.lambda ?? '').trim()
    const command = String(v.command ?? '').trim()
    if (!lambda && !command) errors.lambda = 'System targets need a lambda or a command'
    if (lambda) target.lambda = lambda
    if (command) target.command = command
    if (v.warm) target.warm = true
  }
  const timing = String(v.timing ?? 'none') as Timing
  if (timing !== 'none') {
    const ms = parseDuration(String(v.timingValue ?? ''))
    if (!ms) errors.timingValue = 'Duration like 30s, 5m or 1h'
    else if (timing === 'debounce') target.debounce_ms = ms
    else if (timing === 'interval') target.interval_ms = ms
    else target.batch_ms = ms
    if (timing === 'batch' && String(v.batchCount ?? '').trim()) {
      const n = Number(String(v.batchCount).trim())
      if (!Number.isInteger(n) || n <= 0) errors.batchCount = 'Positive whole number'
      else target.batch_count = n
    }
  }
  const filter = String(v.filter ?? '').trim()
  if (filter) {
    try {
      const parsed = JSON.parse(filter) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) errors.filter = 'Filter must be a JSON object'
      else target.filter = parsed as TriggerTarget['filter']
    } catch (err) {
      errors.filter = `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  if (v.locked) target.locked = true
  return Object.keys(errors).length ? { errors } : { target }
}
