// Line-editing keys for TextInput, readline / macOS style, over the many ways
// terminals encode them:
//
//   delete word left   Ctrl+Backspace (BS `\x08` in Windows Terminal and most
//                      xterm-likes; kitty `CSI 127;5u` / `CSI 8;5u`),
//                      Alt/Option+Backspace (`ESC DEL`), Ctrl+W
//   delete word right  Ctrl+Delete (`CSI 3;5~`), Alt+Delete, Alt+D (`ESC d`)
//   delete to line start  Cmd+Backspace (kitty `CSI 127;9u`; iTerm2 sends
//                      Ctrl+U), Ctrl+U. At the start of a line it joins the
//                      line to the previous one.
//   line start / end   Home / End, Ctrl+A / Ctrl+E, Cmd+←/→ (iTerm2 sends
//                      Ctrl+A/E or `CSI H/F`; kitty `CSI 1;9D` / `CSI 1;9C`)
//
// A "line" is the logical line the caret is on (the composer is multiline).
// Words: a run of letters / digits / `_`, or a run of other punctuation;
// whitespace in front of it goes with it (VS Code / readline alike).

import type { Key } from 'ink'
import { superArrow } from '../app/terminal'

const WORD = /[\p{L}\p{N}_]/u
const SPACE = /\s/

function isWord(ch: string | undefined): boolean {
  return ch !== undefined && WORD.test(ch)
}

function isSpace(ch: string | undefined): boolean {
  return ch !== undefined && SPACE.test(ch)
}

/** Where a word jump / delete to the left of `pos` lands. */
export function wordLeft(value: string, pos: number): number {
  let i = pos
  while (i > 0 && isSpace(value[i - 1])) i--
  if (i > 0 && isWord(value[i - 1])) {
    while (i > 0 && isWord(value[i - 1])) i--
  } else {
    while (i > 0 && !isWord(value[i - 1]) && !isSpace(value[i - 1])) i--
  }
  return i
}

/** Where a word jump / delete to the right of `pos` lands. */
export function wordRight(value: string, pos: number): number {
  let i = pos
  while (i < value.length && isSpace(value[i])) i++
  if (i < value.length && isWord(value[i])) {
    while (i < value.length && isWord(value[i])) i++
  } else {
    while (i < value.length && !isWord(value[i]) && !isSpace(value[i])) i++
  }
  return i
}

export function lineStart(value: string, pos: number): number {
  return value.lastIndexOf('\n', pos - 1) + 1
}

export function lineEnd(value: string, pos: number): number {
  const end = value.indexOf('\n', pos)
  return end < 0 ? value.length : end
}

export type EditAction = 'deleteWordLeft' | 'deleteWordRight' | 'deleteLineLeft' | 'lineStart' | 'lineEnd'

/** Which line-editing action a key is, from ink's `key` plus the raw bytes (see `lastRawInput`). */
export function editAction(input: string, key: Key, raw: string): EditAction | null {
  if (key.backspace) {
    if (key.super) return 'deleteLineLeft'
    // ink reports BS (Ctrl+Backspace) and DEL (Backspace) alike; the raw byte tells them apart.
    if (key.ctrl || key.meta || raw === '\b') return 'deleteWordLeft'
    return null
  }
  if (key.delete && (key.ctrl || key.meta)) return 'deleteWordRight'
  if (key.super && (key.leftArrow || key.rightArrow)) return key.leftArrow ? 'lineStart' : 'lineEnd'
  const cmdArrow = key.leftArrow || key.rightArrow ? superArrow(raw) : null
  if (cmdArrow) return cmdArrow === 'left' ? 'lineStart' : 'lineEnd'
  if (key.home) return 'lineStart'
  if (key.end) return 'lineEnd'
  if (key.ctrl && !key.meta) {
    if (input === 'a') return 'lineStart'
    if (input === 'e') return 'lineEnd'
    if (input === 'w') return 'deleteWordLeft'
    if (input === 'u') return 'deleteLineLeft'
  }
  if (key.meta && !key.ctrl && input === 'd') return 'deleteWordRight'
  return null
}

/** Apply an edit action: the new value and caret. */
export function applyEdit(action: EditAction, value: string, cursor: number): { value: string; cursor: number } {
  switch (action) {
    case 'lineStart': return { value, cursor: lineStart(value, cursor) }
    case 'lineEnd': return { value, cursor: lineEnd(value, cursor) }
    case 'deleteWordLeft': {
      const start = wordLeft(value, cursor)
      return { value: value.slice(0, start) + value.slice(cursor), cursor: start }
    }
    case 'deleteWordRight': {
      const end = wordRight(value, cursor)
      return { value: value.slice(0, cursor) + value.slice(end), cursor }
    }
    case 'deleteLineLeft': {
      const start = lineStart(value, cursor)
      // At the start of a line: join it to the previous one.
      const from = start === cursor ? Math.max(0, cursor - 1) : start
      return { value: value.slice(0, from) + value.slice(cursor), cursor: from }
    }
  }
}
