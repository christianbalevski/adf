// Keyboard form for the loops dialogs. One handler on the overlay layer owns
// every key (field order is deterministic), so text fields, toggles, choices
// and checklists never fight over input.
//
// Keys: ↑↓/Tab/S-Tab move · type to edit text · Space toggles/cycles ·
// ←→ cycle choices · Enter next (last field submits) · Ctrl+S submit ·
// Ctrl+O open a multiline field in $EDITOR · Esc / Ctrl+C cancel (asks first
// when anything was edited, so one keypress never throws edits away).

import { useRef, useState, type ReactNode } from 'react'
import { Box, Text, usePaste } from 'ink'
import { useTheme } from '../../app/theme'
import { useKeys } from '../../app/keys'
import { displayWidth, truncate } from '../../ui/text'

export type FormValue = string | boolean | string[]
export type FormValues = Record<string, FormValue>

interface FieldBase {
  key: string
  label: string
  hint?: string
  hidden?: boolean
  /** Shown but not editable. */
  readOnly?: boolean
}

export type FieldSpec =
  | (FieldBase & { kind: 'text'; placeholder?: string; multiline?: boolean; rows?: number; editor?: boolean })
  | (FieldBase & { kind: 'bool' })
  | (FieldBase & { kind: 'choice'; options: Array<{ value: string; label: string }> })
  | (FieldBase & { kind: 'combo'; options: string[]; placeholder?: string })
  | (FieldBase & { kind: 'checklist'; options: Array<{ value: string; label?: string; note?: string }>; rows?: number })

export interface FormProps {
  fields: FieldSpec[]
  values: FormValues
  onChange: (values: FormValues) => void
  errors?: Record<string, string | undefined>
  onSubmit: () => void
  onCancel: () => void
  /** Ctrl+O on a multiline field with `editor: true`. */
  onEditor?: (key: string) => void
  width: number
  /** Rows available for the fields. */
  height: number
  active?: boolean
  /** Initially focused field key. */
  initialField?: string
  footer?: ReactNode
  /** What cancelling does, for the discard prompt (default "close"). */
  cancelLabel?: string
}

const LABEL_WIDTH = 16

export function Form(props: FormProps) {
  const { fields, values, onChange, errors = {}, onSubmit, onCancel, onEditor, width, height, active = true, initialField, footer, cancelLabel = 'close' } = props
  const theme = useTheme()
  const visible = fields.filter(f => !f.hidden)
  const [focusKey, setFocusKey] = useState<string>(initialField ?? visible.find(f => !f.readOnly)?.key ?? visible[0]?.key ?? '')
  const [itemCursor, setItemCursor] = useState(0)
  const index = Math.max(0, visible.findIndex(f => f.key === focusKey))
  const field = visible[index]

  // Keys can arrive faster than renders; edit the latest values, not the rendered ones.
  const latest = useRef(values)
  latest.current = values
  const set = (key: string, value: FormValue) => {
    latest.current = { ...latest.current, [key]: value }
    onChange(latest.current)
  }
  const text = (key: string) => (typeof latest.current[key] === 'string' ? latest.current[key] as string : '')
  const list = (key: string) => (Array.isArray(latest.current[key]) ? latest.current[key] as string[] : [])

  const move = (delta: number) => {
    let next = index
    for (let step = 0; step < visible.length; step++) {
      next = next + delta
      if (next < 0 || next >= visible.length) return false
      if (!visible[next].readOnly) break
    }
    const target = visible[next]
    if (!target || target.readOnly) return false
    setFocusKey(target.key)
    if (target.kind === 'checklist') setItemCursor(delta > 0 ? 0 : Math.max(0, target.options.length - 1))
    return true
  }

  const isLast = () => !visible.slice(index + 1).some(f => !f.readOnly)

  const initial = useRef(JSON.stringify(values))
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const cancel = () => {
    if (JSON.stringify(latest.current) === initial.current) onCancel()
    else setConfirmDiscard(true)
  }

  useKeys((input, key) => {
    if (confirmDiscard) {
      if (input === 'y' || key.return) { setConfirmDiscard(false); onCancel(); return true }
      if (input === 'n' || key.escape || (key.ctrl && input === 'c')) setConfirmDiscard(false)
      return true
    }
    if (key.escape || (key.ctrl && input === 'c')) { cancel(); return true }
    if (key.ctrl && input === 's') { onSubmit(); return true }
    if (!field) return true
    if (key.tab) { move(key.shift ? -1 : 1); return true }

    if (field.kind === 'checklist') {
      const n = field.options.length
      if (key.upArrow || (input === 'k' && !key.ctrl)) { if (itemCursor > 0) setItemCursor(itemCursor - 1); else move(-1); return true }
      if (key.downArrow || (input === 'j' && !key.ctrl)) { if (itemCursor < n - 1) setItemCursor(itemCursor + 1); else move(1); return true }
      if (input === ' ' && n > 0) {
        const value = field.options[itemCursor]?.value
        const current = list(field.key)
        if (value) set(field.key, current.includes(value) ? current.filter(v => v !== value) : [...current, value])
        return true
      }
      if (input === 'a' && !key.ctrl) {
        const all = field.options.map(o => o.value)
        set(field.key, list(field.key).length === all.length ? [] : all)
        return true
      }
      if (key.return) { if (isLast()) onSubmit(); else move(1); return true }
      return true
    }

    if (key.upArrow) { move(-1); return true }
    if (key.downArrow) { move(1); return true }

    switch (field.kind) {
      case 'bool':
        if (input === ' ' || key.leftArrow || key.rightArrow) { set(field.key, !latest.current[field.key]); return true }
        if (input === 'y') { set(field.key, true); return true }
        if (input === 'n') { set(field.key, false); return true }
        if (key.return) { if (isLast()) onSubmit(); else move(1); return true }
        return true
      case 'choice': {
        const at = Math.max(0, field.options.findIndex(o => o.value === latest.current[field.key]))
        const cycle = (d: number) => set(field.key, field.options[(at + d + field.options.length) % field.options.length].value)
        if (input === ' ' || key.rightArrow) { cycle(1); return true }
        if (key.leftArrow) { cycle(-1); return true }
        if (key.return) { if (isLast()) onSubmit(); else move(1); return true }
        return true
      }
      case 'combo':
      case 'text': {
        const value = text(field.key)
        if (field.kind === 'combo' && (key.leftArrow || key.rightArrow) && field.options.length > 0) {
          const at = field.options.indexOf(value)
          const d = key.rightArrow ? 1 : -1
          const next = at < 0 ? (d > 0 ? 0 : field.options.length - 1) : (at + d + field.options.length) % field.options.length
          set(field.key, field.options[next])
          return true
        }
        const multiline = field.kind === 'text' && field.multiline
        if (key.ctrl && input === 'o' && multiline && field.editor && onEditor) { onEditor(field.key); return true }
        if (key.return && key.meta && multiline) { set(field.key, `${value}\n`); return true }
        if (input === '\n' && multiline) { set(field.key, `${value}\n`); return true }
        if (key.return) {
          if (multiline) { set(field.key, `${value}\n`); return true }
          if (isLast()) onSubmit(); else move(1)
          return true
        }
        if (key.backspace || key.delete) { set(field.key, value.slice(0, -1)); return true }
        if (key.ctrl && input === 'u') { set(field.key, ''); return true }
        if (key.ctrl && input === 'w') { set(field.key, value.replace(/\S+\s*$/, '')); return true }
        if (key.ctrl || key.meta || key.leftArrow || key.rightArrow) return true
        if (input) {
          const clean = input.replace(/\r\n?/g, '\n')
          set(field.key, value + (multiline ? clean : clean.replace(/\n/g, ' ')))
        }
        return true
      }
    }
    return true
  }, { layer: 'overlay', active })

  // Bracketed paste lands in the focused text field in one piece (a pasted
  // newline never submits the form).
  usePaste(pasted => {
    if (confirmDiscard) return
    if (!field || field.readOnly || (field.kind !== 'text' && field.kind !== 'combo')) return
    const clean = pasted.replace(/\r\n?/g, '\n')
    const multiline = field.kind === 'text' && field.multiline
    set(field.key, text(field.key) + (multiline ? clean : clean.replace(/\n/g, ' ')))
  }, { isActive: active })

  // Window the fields so the focused one is always visible.
  const heights = visible.map(f => fieldHeight(f, f.key === focusKey, values, !!errors[f.key]))
  let start = 0
  let used = heights.slice(0, index + 1).reduce((a, b) => a + b, 0)
  while (used > height && start < index) { used -= heights[start]; start++ }
  let end = index + 1
  while (end < visible.length && used + heights[end] <= height) { used += heights[end]; end++ }
  const shown = visible.slice(start, end)
  const valueWidth = Math.max(8, width - LABEL_WIDTH - 3)

  return (
    <Box flexDirection="column" width={width}>
      {start > 0 ? <Text color={theme.color.dim}>{`  ${theme.ascii ? '^' : '▴'} ${start} more above`}</Text> : null}
      {shown.map(f => {
        const focused = f.key === focusKey && active
        const error = errors[f.key]
        const labelColor = f.readOnly ? theme.color.dim : focused ? theme.color.accent : theme.color.muted
        return (
          <Box key={f.key} flexDirection="column">
            <Box>
              <Text color={focused ? theme.color.accent : theme.color.dim}>{focused ? `${theme.glyph.pointer} ` : '  '}</Text>
              <Text bold={focused} color={labelColor} inverse={theme.mono && focused}>{truncate(f.label, LABEL_WIDTH - 1).padEnd(LABEL_WIDTH)}</Text>
              <Box width={valueWidth} flexDirection="column">
                <FieldValue field={f} values={values} focused={focused} width={valueWidth} itemCursor={itemCursor} />
              </Box>
            </Box>
            {error ? <Text color={theme.color.error}>{' '.repeat(LABEL_WIDTH + 2)}{truncate(`${theme.glyph.cross} ${error}`, valueWidth)}</Text> : null}
            {focused && f.hint ? <Text color={theme.color.dim}>{' '.repeat(LABEL_WIDTH + 2)}{truncate(f.hint, valueWidth)}</Text> : null}
          </Box>
        )
      })}
      {end < visible.length ? <Text color={theme.color.dim}>{`  ${theme.glyph.collapsed} ${visible.length - end} more below`}</Text> : null}
      {footer}
      {confirmDiscard ? <Text bold color={theme.color.warn}>{truncate(`${theme.glyph.warn} Discard your edits and ${cancelLabel}? y discard ${theme.glyph.sep} n keep editing`, width)}</Text> : null}
    </Box>
  )
}

function fieldHeight(field: FieldSpec, focused: boolean, values: FormValues, hasError: boolean): number {
  let rows = 1
  if (field.kind === 'text' && field.multiline) {
    const lines = (typeof values[field.key] === 'string' ? values[field.key] as string : '').split('\n').length
    rows = focused ? Math.min(field.rows ?? 5, Math.max(1, lines)) : 1
  }
  if (field.kind === 'checklist' && focused) rows = 1 + Math.min(field.rows ?? 8, field.options.length)
  if (hasError) rows++
  if (focused && field.hint) rows++
  return rows
}

function FieldValue({ field, values, focused, width, itemCursor }: { field: FieldSpec; values: FormValues; focused: boolean; width: number; itemCursor: number }) {
  const theme = useTheme()
  const value = values[field.key]
  const caret = focused && !field.readOnly ? <Text inverse> </Text> : null
  switch (field.kind) {
    case 'bool':
      return (
        <Text color={focused ? theme.color.text : theme.color.muted}>
          {value ? `[${theme.ascii ? 'x' : theme.glyph.check}] yes` : '[ ] no'}
          {focused ? <Text color={theme.color.dim}>  space toggles</Text> : null}
        </Text>
      )
    case 'choice': {
      const option = field.options.find(o => o.value === value)
      return (
        <Text color={theme.color.text}>
          {focused ? <Text color={theme.color.dim}>{'‹ '}</Text> : null}
          {option?.label ?? String(value ?? '')}
          {focused ? <Text color={theme.color.dim}>{' ›'}</Text> : null}
        </Text>
      )
    }
    case 'combo': {
      const text = typeof value === 'string' ? value : ''
      const shown = text || (focused ? '' : field.placeholder ?? '')
      return (
        <Text color={text ? theme.color.text : theme.color.dim}>
          {truncate(shown, Math.max(1, width - 12))}
          {caret}
          {focused && field.options.length > 0 ? <Text color={theme.color.dim}>  ←→ {field.options.length} options</Text> : null}
        </Text>
      )
    }
    case 'text': {
      const text = typeof value === 'string' ? value : ''
      if (field.multiline && focused) {
        const rows = field.rows ?? 5
        const lines = text.split('\n')
        const tail = lines.slice(-rows)
        return (
          <Box flexDirection="column">
            {tail.map((line, i) => (
              <Text key={i} color={theme.color.text} wrap="truncate-end">
                {i === 0 && lines.length > rows ? <Text color={theme.color.dim}>{`(${lines.length - rows} lines above) `}</Text> : null}
                {truncate(line, width - 1)}
                {i === tail.length - 1 ? caret : null}
              </Text>
            ))}
          </Box>
        )
      }
      if (!text) {
        return <Text color={theme.color.dim}>{focused ? <Text inverse> </Text> : null}{truncate(field.placeholder ?? '', width - 2)}</Text>
      }
      const flat = text.replace(/\n/g, field.multiline ? (theme.ascii ? ' / ' : ' ⏎ ') : ' ')
      const room = width - 2
      const visibleText = focused && displayWidth(flat) > room ? `…${flat.slice(-(room - 1))}` : truncate(flat, room)
      return <Text color={field.readOnly ? theme.color.muted : theme.color.text}>{visibleText}{caret}</Text>
    }
    case 'checklist': {
      const selected = Array.isArray(value) ? value as string[] : []
      if (!focused) {
        const summary = selected.length ? `${selected.length}: ${selected.join(', ')}` : '(none)'
        return <Text color={theme.color.text}>{truncate(summary, width)}</Text>
      }
      const rows = field.rows ?? 8
      const startAt = Math.max(0, Math.min(itemCursor - Math.floor(rows / 2), field.options.length - rows))
      const window = field.options.slice(startAt, startAt + rows)
      return (
        <Box flexDirection="column">
          <Text color={theme.color.dim}>{selected.length}/{field.options.length} selected · space toggles · a all/none</Text>
          {window.map((option, i) => {
            const at = startAt + i
            const on = selected.includes(option.value)
            const current = at === itemCursor
            return (
              <Text key={option.value} color={current ? theme.color.accent : on ? theme.color.text : theme.color.muted} bold={current} inverse={theme.mono && current} wrap="truncate-end">
                {current ? theme.glyph.pointer : ' '}[{on ? (theme.ascii ? 'x' : theme.glyph.check) : ' '}] {option.label ?? option.value}
                {option.note ? <Text color={theme.color.warn}>  {option.note}</Text> : null}
              </Text>
            )
          })}
        </Box>
      )
    }
  }
}
