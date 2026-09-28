import { useEffect, useRef, useState } from 'react'
import { Box, Text, usePaste } from 'ink'
import { useTheme } from '../app/theme'
import { useKeys, type Key, type KeyLayer } from '../app/keys'
import { isMouseGarbage } from '../app/terminal'

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
}

/**
 * Multiline prompt. Enter sends; Shift+Enter (terminals with the kitty
 * keyboard protocol, or a keybinding that sends `CSI 13;2 u`), Alt+Enter,
 * Ctrl+J or a trailing `\` insert a newline.
 * History: Ctrl+↑/↓ anywhere; ↑/↓ on the first / last line too (a view may
 * claim ↑/↓ on an empty box first: chat scrolls its transcript).
 * Editing: ←→ Home/End Ctrl+A/E, word jumps Alt+←/→ Alt+B/F (and Ctrl+←/→
 * while there is text), Ctrl+W word, Ctrl+U line, Ctrl+C clears a non-empty box.
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
    if (props.value === undefined) setInternal(next)
    props.onChange?.(next)
    setCursor(Math.max(0, Math.min(nextCursor, next.length)))
  }

  const api: TextInputApi = {
    value,
    cursor,
    setValue: (next, c) => update(next, c ?? next.length),
    insert: text => update(value.slice(0, cursor) + text + value.slice(cursor), cursor + text.length),
    clear: () => update('', 0),
  }

  const wordLeft = (pos: number) => {
    let i = pos
    while (i > 0 && /\s/.test(value[i - 1])) i--
    while (i > 0 && !/\s/.test(value[i - 1])) i--
    return i
  }
  const wordRight = (pos: number) => {
    let i = pos
    while (i < value.length && /\s/.test(value[i])) i++
    while (i < value.length && !/\s/.test(value[i])) i++
    return i
  }

  const lineStart = (pos: number) => value.lastIndexOf('\n', pos - 1) + 1
  const lineEnd = (pos: number) => {
    const end = value.indexOf('\n', pos)
    return end < 0 ? value.length : end
  }

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

  const submit = () => {
    if (value.endsWith('\\')) {
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
    const wordJump = key.meta || (key.ctrl && value.length > 0)
    if (key.leftArrow && wordJump) { setCursor(wordLeft(cursor)); return true }
    if (key.rightArrow && wordJump) { setCursor(wordRight(cursor)); return true }
    if (key.meta && !key.ctrl && (input === 'b' || input === 'f')) { setCursor(input === 'b' ? wordLeft(cursor) : wordRight(cursor)); return true }
    if (key.leftArrow && !key.ctrl) { setCursor(c => Math.max(0, c - 1)); return true }
    if (key.rightArrow && !key.ctrl) { setCursor(c => Math.min(value.length, c + 1)); return true }
    if (key.home || (key.ctrl && input === 'a')) { setCursor(lineStart(cursor)); return true }
    if (key.end || (key.ctrl && input === 'e')) { setCursor(lineEnd(cursor)); return true }
    if (key.upArrow) {
      const start = lineStart(cursor)
      if (start === 0) return recall(-1)
      const prevStart = lineStart(start - 1)
      setCursor(Math.min(prevStart + (cursor - start), start - 1))
      return true
    }
    if (key.downArrow) {
      const end = lineEnd(cursor)
      if (end === value.length) return recall(1)
      const col = cursor - lineStart(cursor)
      setCursor(Math.min(end + 1 + col, lineEnd(end + 1)))
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
    if (key.ctrl && input === 'w') {
      const before = value.slice(0, cursor).replace(/\S+\s*$/, '')
      update(before + value.slice(cursor), before.length)
      return true
    }
    if (key.ctrl && input === 'u') {
      const start = lineStart(cursor)
      update(value.slice(0, start) + value.slice(cursor), start)
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
