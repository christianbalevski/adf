import { useEffect, useRef, useState } from 'react'
import { Box, Text, usePaste } from 'ink'
import { useTheme } from '../app/theme'
import { useKeys, type Key, type KeyLayer } from '../app/keys'
import { isMouseGarbage, lastRawInput } from '../app/terminal'
import { applyEdit, editAction, lineEnd as lineEndOf, lineStart as lineStartOf, wordLeft as wordLeftOf, wordRight as wordRightOf } from './edit'

export interface TextInputApi {
  value: string
  cursor: number
  setValue(value: string, cursor?: number): void
  insert(text: string): void
  clear(): void
}

export interface TextInputProps {
  /** Controlled value. Omit for internal state. */
  value?: string
  onChange?: (value: string) => void
  /** Return false to keep the text in the box (e.g. the send failed validation). */
  onSubmit: (value: string) => void | boolean
  placeholder?: string
  /** Prior submissions, oldest first. ↑ on the first line walks back through them. */
  history?: string[]
  /** Keys + paste are routed here only while focused. */
  focused: boolean
  keyLayer?: KeyLayer
  /** Visible rows before the box scrolls. Default 6. */
  maxRows?: number
  prompt?: string
  /** Runs before the default editing keys; return true to consume (completion menus, Tab). */
  onKey?: (input: string, key: Key, api: TextInputApi) => boolean | void
  disabled?: boolean
  /** Render every character as this one char (passphrases, seed phrases). Pass no `history` with it. */
  mask?: string
  /** With `mask`: leave whitespace visible (a seed phrase shows its word boundaries). */
  maskKeepSpaces?: boolean
  /** Receives the editing API each render (the shell prompt: right-click paste). */
  apiRef?: { current: TextInputApi | null }
}

// The focused (unmasked) input, for right-click paste into dialogs.
let focusedInput: TextInputApi | null = null
let focusedOwner: object | null = null

/** Insert text at the caret of the focused text box. False when none is focused. */
export function insertIntoFocusedInput(text: string): boolean {
  if (!focusedInput) return false
  focusedInput.insert(text)
  return true
}

/**
 * Multiline prompt. Enter sends; Shift+Enter (terminals with the kitty
 * keyboard protocol, or a keybinding that sends `CSI 13;2 u`), Alt+Enter,
 * Ctrl+J or a trailing `\` insert a newline.
 * History: Ctrl+↑/↓ anywhere; ↑/↓ on the first / last line too (a view may
 * claim ↑/↓ on an empty box first: chat scrolls its transcript).
 * Editing (ui/edit.ts): ←→, Home/End Ctrl+A/E Cmd+←/→ (line), word jumps
 * Alt+←/→ Alt+B/F (and Ctrl+←/→ while there is text), delete a word left
 * Ctrl+Backspace Alt+Backspace Ctrl+W, a word right Ctrl+Delete Alt+D, to the
 * line start Cmd+Backspace Ctrl+U; Ctrl+C clears a non-empty box.
 * Shift+←/→ (and Ctrl+←/→ on an empty box) fall through to the shell's loop switch.
 */
export function TextInput(props: TextInputProps) {
  const { onSubmit, placeholder, history = [], focused, keyLayer = 'input', maxRows = 6, prompt = '› ', onKey, disabled = false, mask, maskKeepSpaces = false } = props
  const theme = useTheme()
  const [internal, setInternal] = useState('')
  const value = props.value ?? internal
  const [cursor, setCursor] = useState(value.length)
  const historyIndex = useRef<number | null>(null)
  const draft = useRef('')
  const lastEmitted = useRef(value)
  // The newest value + cursor, ahead of React state: several events in one
  // tick (a paste then Enter, a burst of keys) each see the previous one's edit.
  const live = useRef({ value, cursor })
  live.current = { value, cursor }

  useEffect(() => {
    // A value set from outside (prefill, history) puts the cursor at the end.
    if (value !== lastEmitted.current) {
      lastEmitted.current = value
      setCursor(value.length)
    } else if (cursor > value.length) {
      setCursor(value.length)
    }
  }, [value, cursor])

  const update = (next: string, nextCursor = next.length) => {
    lastEmitted.current = next
    live.current = { value: next, cursor: Math.max(0, Math.min(nextCursor, next.length)) }
    if (props.value === undefined) setInternal(next)
    props.onChange?.(next)
    setCursor(Math.max(0, Math.min(nextCursor, next.length)))
  }

  const api: TextInputApi = {
    value,
    cursor,
    setValue: (next, c) => update(next, c ?? next.length),
    insert: text => {
      const { value: v, cursor: c } = live.current
      update(v.slice(0, c) + text + v.slice(c), c + text.length)
    },
    clear: () => update('', 0),
  }
  if (props.apiRef) props.apiRef.current = api
  const self = useRef({})
  if (focused && !disabled && !mask) { focusedInput = api; focusedOwner = self.current }
  else if (focusedOwner === self.current) { focusedInput = null; focusedOwner = null }
  useEffect(() => () => { if (focusedOwner === self.current) { focusedInput = null; focusedOwner = null } }, [])

  const wordLeft = (pos: number) => wordLeftOf(live.current.value, pos)
  const wordRight = (pos: number) => wordRightOf(live.current.value, pos)
  const lineStart = (pos: number) => lineStartOf(live.current.value, pos)
  const lineEnd = (pos: number) => lineEndOf(live.current.value, pos)

  const recall = (direction: -1 | 1) => {
    if (history.length === 0) return false
    if (historyIndex.current === null) {
      if (direction === 1) return false
      draft.current = value
      historyIndex.current = history.length - 1
    } else {
      const next = historyIndex.current + direction
      if (next >= history.length) {
        historyIndex.current = null
        update(draft.current)
        return true
      }
      historyIndex.current = Math.max(0, next)
    }
    update(history[historyIndex.current])
    return true
  }

  const moveTo = (c: number) => {
    const v = live.current.value
    const n = Math.max(0, Math.min(c, v.length))
    live.current = { value: v, cursor: n }
    setCursor(n)
  }

  const submit = () => {
    const { value } = live.current
    // A trailing `\` continues the line, except on a /command (a Windows path: `/track C:\dir\`).
    if (value.endsWith('\\') && !value.startsWith('/')) {
      update(`${value.slice(0, -1)}\n`)
      return
    }
    historyIndex.current = null
    const keep = onSubmit(value) === false
    if (!keep) update('', 0)
  }

  usePaste(text => {
    if (!disabled) api.insert(text.replace(/\r\n?/g, '\n'))
  }, { isActive: focused && !disabled })

  useKeys((input, key) => {
    if (disabled) return false
    const { value, cursor } = live.current
    if (onKey?.(input, key, api) === true) return true
    if (key.return && (key.meta || key.shift)) { api.insert('\n'); return true }
    if (key.return) { submit(); return true }
    // Ctrl+J: a bare LF, or `CSI 106;5 u` with the kitty protocol on.
    if (input === '\n' || (key.ctrl && !key.meta && input === 'j')) { api.insert('\n'); return true }
    if (key.ctrl && !key.meta && (key.upArrow || key.downArrow)) {
      if (history.length === 0) return false
      recall(key.upArrow ? -1 : 1)
      return true
    }
    if (key.ctrl && input === 'c') {
      if (!value) return false
      update('', 0)
      return true
    }
    if ((key.leftArrow || key.rightArrow) && key.shift) return false
    const edit = editAction(input, key, lastRawInput())
    if (edit) {
      const next = applyEdit(edit, value, cursor)
      if (next.value !== value) { historyIndex.current = null; update(next.value, next.cursor) } else moveTo(next.cursor)
      return true
    }
    const wordJump = key.meta || (key.ctrl && value.length > 0)
    if (key.leftArrow && wordJump) { moveTo(wordLeft(cursor)); return true }
    if (key.rightArrow && wordJump) { moveTo(wordRight(cursor)); return true }
    if (key.meta && !key.ctrl && (input === 'b' || input === 'f')) { moveTo(input === 'b' ? wordLeft(cursor) : wordRight(cursor)); return true }
    if (key.leftArrow && !key.ctrl) { moveTo(cursor - 1); return true }
    if (key.rightArrow && !key.ctrl) { moveTo(cursor + 1); return true }
    if (key.upArrow) {
      const start = lineStart(cursor)
      if (start === 0) return recall(-1)
      const prevStart = lineStart(start - 1)
      moveTo(Math.min(prevStart + (cursor - start), start - 1))
      return true
    }
    if (key.downArrow) {
      const end = lineEnd(cursor)
      if (end === value.length) return recall(1)
      const col = cursor - lineStart(cursor)
      moveTo(Math.min(end + 1 + col, lineEnd(end + 1)))
      return true
    }
    if (key.backspace) {
      if (cursor === 0) return true
      update(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1)
      return true
    }
    if (key.delete) {
      if (cursor >= value.length) return true
      update(value.slice(0, cursor) + value.slice(cursor + 1), cursor)
      return true
    }
    if (key.ctrl || key.meta || key.escape || key.tab) return false
    // A mouse report that lost its framing is never text.
    if (isMouseGarbage(input)) return true
    if (input) {
      historyIndex.current = null
      api.insert(input.replace(/\r\n?/g, '\n'))
      return true
    }
    return false
  }, { layer: keyLayer, active: focused })

  // Masked: one mask char per typed char, so cursor math is unchanged.
  const lines = (mask ? value.replace(maskKeepSpaces ? /\S/g : /[^\n]/g, mask) : value).split('\n')
  let cursorLine = 0
  let cursorCol = cursor
  for (let i = 0, pos = 0; i < lines.length; i++) {
    if (cursor <= pos + lines[i].length) { cursorLine = i; cursorCol = cursor - pos; break }
    pos += lines[i].length + 1
  }
  const first = Math.max(0, Math.min(cursorLine - maxRows + 1, lines.length - maxRows))
  const shown = lines.slice(first, first + maxRows)
  const pad = ' '.repeat(prompt.length)

  return (
    <Box flexDirection="column">
      {value.length === 0 ? (
        <Text wrap="truncate-end">
          <Text color={focused ? theme.color.accent : theme.color.dim}>{prompt}</Text>
          {focused ? <Text inverse>{placeholder?.[0] ?? ' '}</Text> : null}
          <Text color={theme.color.dim}>{focused ? placeholder?.slice(1) ?? '' : placeholder ?? ''}</Text>
        </Text>
      ) : (
        shown.map((line, i) => {
          const lineIndex = first + i
          const isCursorLine = focused && lineIndex === cursorLine
          const lead = lineIndex === 0 ? prompt : pad
          return (
            <Text key={lineIndex} wrap="wrap">
              <Text color={focused ? theme.color.accent : theme.color.dim}>{lead}</Text>
              {isCursorLine ? (
                <>
                  <Text color={theme.color.text}>{line.slice(0, cursorCol)}</Text>
                  <Text inverse>{line[cursorCol] ?? ' '}</Text>
                  <Text color={theme.color.text}>{line.slice(cursorCol + 1)}</Text>
                </>
              ) : (
                <Text color={theme.color.text}>{line}</Text>
              )}
            </Text>
          )
        })
      )}
      {lines.length > maxRows ? (
        <Text color={theme.color.dim}>{pad}{lines.length} lines</Text>
      ) : null}
    </Box>
  )
}
