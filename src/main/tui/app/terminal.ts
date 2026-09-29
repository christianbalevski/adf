// Terminal modes the TUI turns on while it owns the terminal, and what the
// terminal turned out to support:
//
// - Kitty keyboard protocol (flag 1, "disambiguate"): ink queries `CSI ? u`
//   and enables it when the terminal answers (see index.tsx). With it on,
//   Shift+Enter arrives as `CSI 13;2 u` and the composer can tell it from
//   Enter. ink itself turns it off on exit, crash (signal-exit) and while an
//   editor has the terminal (suspendTerminal); we only watch its writes.
// - Mouse mode (the default; /mouse on|off, --mouse / --no-mouse, pref): SGR
//   mouse reporting (1002 + 1006: buttons, drags and wheel, no bare motion).
//   The wheel scrolls the region under the pointer, clicks focus panes, switch
//   header tabs and expand transcript items, and the TUI does its own text
//   selection (app/selection.ts over the screen mirror in app/screen.ts):
//   drag highlights and copies, right-click pastes. Shift+drag (Option+drag
//   in iTerm2) still reaches the terminal's own selection.
// - Native (/mouse off): the terminal keeps its mouse, so drag selects text,
//   Ctrl+C / Ctrl+Shift+C copy it and right-click pastes. Alternate scroll
//   mode (DECSET 1007) makes the wheel send ↑/↓ in the alternate screen, so
//   it scrolls the FOCUSED pane through the normal arrow keys.
// Both follow raw mode: ink drops raw mode on exit and around suspendTerminal
// (editor handoff), so the modes are off exactly when the TUI is not reading
// the terminal. A process 'exit' hook turns them off after a crash too.

import { useSyncExternalStore } from 'react'

/** Button-event tracking (1002: presses, releases, drags; implies 1000) in SGR encoding (1006). */
export const MOUSE_ON = '\u001b[?1002h\u001b[?1006h'
export const MOUSE_OFF = '\u001b[?1006l\u001b[?1002l\u001b[?1000l'
/** Alternate scroll mode: the wheel sends ↑/↓ in the alternate screen (native selection stays). */
export const ALT_SCROLL_ON = '\u001b[?1007h'
export const ALT_SCROLL_OFF = '\u001b[?1007l'
const KITTY_ON = /\u001b\[>\d+u/
const KITTY_OFF = '\u001b[<u'

export interface TerminalCaps {
  /** ink enabled the kitty keyboard protocol (the terminal answered the query). */
  kitty: boolean
  /** A Shift+Enter distinct from Enter was seen (kitty, or a sendInput / keybinding that sends CSI 13;2 u). */
  shiftEnterSeen: boolean
  /** ADF_TUI_SHIFT_ENTER=1: the user says their terminal sends Shift+Enter. */
  shiftEnterForced: boolean
  /** Mouse capture requested (pref / flag), and whether it is live right now. */
  mouseWanted: boolean
  mouseActive: boolean
  /** Alternate scroll mode (wheel → ↑/↓) is live: the default when mouse capture is off. */
  altScrollActive: boolean
  /** Only in the alternate screen do pointer rows map onto the frame. */
  altScreen: boolean
}

let caps: TerminalCaps = { kitty: false, shiftEnterSeen: false, shiftEnterForced: false, mouseWanted: false, mouseActive: false, altScrollActive: false, altScreen: false }
const listeners = new Set<() => void>()
let out: { write(data: string): unknown } | null = null
let rawMode = false
/** Sees every write the TUI (ink) makes to the terminal: the screen mirror. */
let writeTap: ((data: string) => void) | null = null
let lastRaw = ''

/** Register the one write tap (app/screen.ts); null removes it. */
export function setWriteTap(tap: ((data: string) => void) | null): void {
  writeTap = tap
}

/** Write straight to the terminal, past the tap (overlays, OSC 52). False when not installed. */
export function writeTerminal(data: string): boolean {
  if (!out) return false
  try { out.write(data) } catch { return false }
  return true
}

/**
 * The raw bytes of the keypress being handled (the shell records each one
 * before any key handler runs). ink folds some distinct keys together:
 * Backspace (DEL) and Ctrl+Backspace (BS, `\u0008`) both arrive as
 * `key.backspace`, and a legacy `CSI 1;9D` (Cmd+←) arrives as Alt+←.
 */
export function noteRawInput(data: string): void {
  lastRaw = data
}

export function lastRawInput(): string {
  return lastRaw
}

/** Cmd / Super + ←/→ (Home / End of the line) sent as a legacy `CSI 1;<mods>C|D` with the super bit (kitty, iTerm2, WezTerm, Ghostty). */
export function superArrow(raw: string = lastRaw): 'left' | 'right' | null {
  // eslint-disable-next-line no-control-regex
  const m = /^\u001b\[1;(\d+)([CD])$/.exec(raw)
  if (!m || ((Number(m[1]) - 1) & 8) === 0) return null
  return m[2] === 'D' ? 'left' : 'right'
}

function set(patch: Partial<TerminalCaps>): void {
  const next = { ...caps, ...patch }
  if ((Object.keys(patch) as Array<keyof TerminalCaps>).every(k => next[k] === caps[k])) return
  caps = next
  for (const listener of listeners) listener()
}

export function terminalCaps(): TerminalCaps {
  return caps
}

export function useTerminalCaps(): TerminalCaps {
  return useSyncExternalStore(
    listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    () => caps,
    () => caps,
  )
}

/** The composer can offer Shift+Enter for a newline. */
export function shiftEnterWorks(c: TerminalCaps = caps): boolean {
  return c.kitty || c.shiftEnterSeen || c.shiftEnterForced
}

/** The key label for "newline" in hints and placeholders. */
export function newlineKey(c: TerminalCaps = caps): 'shift+enter' | 'alt+enter' {
  return shiftEnterWorks(c) ? 'shift+enter' : 'alt+enter'
}

export function noteShiftEnter(): void {
  if (!caps.shiftEnterSeen) set({ shiftEnterSeen: true })
}

function syncMouse(): void {
  if (!out) return
  const live = caps.altScreen && rawMode
  const mouse = caps.mouseWanted && live
  const altScroll = !caps.mouseWanted && live
  let seq = ''
  if (mouse !== caps.mouseActive) seq += mouse ? MOUSE_ON : MOUSE_OFF
  if (altScroll !== caps.altScrollActive) seq += altScroll ? ALT_SCROLL_ON : ALT_SCROLL_OFF
  if (!seq) return
  try { out.write(seq) } catch { /* stream closed */ }
  set({ mouseActive: mouse, altScrollActive: altScroll })
}

/** Turn mouse capture on or off for this session (/mouse). */
export function setMouseWanted(on: boolean): void {
  set({ mouseWanted: on })
  syncMouse()
}

export interface InstallOptions {
  stdin: NodeJS.ReadStream
  stdout: NodeJS.WriteStream
  mouse: boolean
  altScreen: boolean
  shiftEnterForced?: boolean
}

/**
 * Watch ink's terminal writes (kitty on/off) and raw-mode switches (mouse
 * capture on/off). Returns an uninstall that restores both streams and turns
 * the mouse off.
 */
export function installTerminalModes(options: InstallOptions): () => void {
  const { stdin, stdout } = options
  out = { write: data => originalWrite(data) }
  caps = { kitty: false, shiftEnterSeen: false, shiftEnterForced: !!options.shiftEnterForced, mouseWanted: options.mouse, mouseActive: false, altScrollActive: false, altScreen: options.altScreen }
  rawMode = false

  const originalWrite = stdout.write.bind(stdout) as (data: string | Uint8Array, ...rest: unknown[]) => boolean
  const patchedWrite = (data: string | Uint8Array, ...rest: unknown[]) => {
    if (typeof data === 'string' && data.includes('\u001b[')) {
      if (data.includes(KITTY_OFF)) set({ kitty: false })
      else if (KITTY_ON.test(data)) set({ kitty: true })
    }
    const result = originalWrite(data, ...rest)
    if (writeTap) { try { writeTap(typeof data === 'string' ? data : Buffer.from(data).toString('utf8')) } catch { /* the mirror never breaks output */ } }
    return result
  }
  ;(stdout as unknown as { write: typeof patchedWrite }).write = patchedWrite

  const originalSetRawMode = typeof stdin.setRawMode === 'function' ? stdin.setRawMode.bind(stdin) : null
  if (originalSetRawMode) {
    ;(stdin as unknown as { setRawMode: (on: boolean) => unknown }).setRawMode = (on: boolean) => {
      // Mouse off before the terminal is handed back (editor, exit).
      if (!on) { rawMode = false; syncMouse() }
      const result = originalSetRawMode(on)
      if (on) { rawMode = true; syncMouse() }
      return result
    }
  }

  // Crash / hard exit: never leave the user's shell reporting mouse events.
  const restore = () => (caps.mouseActive ? MOUSE_OFF : '') + (caps.altScrollActive ? ALT_SCROLL_OFF : '')
  const onExit = () => { const seq = restore(); if (seq) { try { originalWrite(seq) } catch { /* closed */ } } }
  process.on('exit', onExit)

  return () => {
    process.off('exit', onExit)
    const seq = restore()
    if (seq) { try { originalWrite(seq) } catch { /* closed */ } }
    ;(stdout as unknown as { write: typeof originalWrite }).write = originalWrite
    if (originalSetRawMode) (stdin as unknown as { setRawMode: typeof originalSetRawMode }).setRawMode = originalSetRawMode
    rawMode = false
    out = null
    set({ mouseActive: false, altScrollActive: false, kitty: false })
  }
}

// --- mouse input -------------------------------------------------------------------

export interface MouseEvent {
  /** 'wheel' (delta -1 up / +1 down), 'press', 'drag' (moved with a button held), 'release'. */
  kind: 'wheel' | 'press' | 'drag' | 'release'
  /** Wheel: -1 = up (towards older / the top), +1 = down. */
  delta: number
  /** 0 left, 1 middle, 2 right (press / release). */
  button: number
  /** 0-based cell column / row. */
  x: number
  y: number
  shift: boolean
  alt: boolean
  ctrl: boolean
}

// ink hands us the sequence with its leading ESC stripped: `[<64;10;5M`.
// eslint-disable-next-line no-control-regex
const SGR_MOUSE = /^\u001b?\[<(\d+);(\d+);(\d+)([Mm])$/

/** Parse one SGR (1006) mouse report; null when `input` is not one. */
export function parseMouse(input: string): MouseEvent | null {
  const match = SGR_MOUSE.exec(input)
  if (!match) return null
  const code = Number(match[1])
  const x = Math.max(0, Number(match[2]) - 1)
  const y = Math.max(0, Number(match[3]) - 1)
  const mods = { shift: (code & 4) !== 0, alt: (code & 8) !== 0, ctrl: (code & 16) !== 0 }
  const base = code & ~(4 | 8 | 16)
  if (base >= 64 && base < 128) {
    // 64 up, 65 down; 66/67 are horizontal wheels (ignored as delta 0).
    const delta = base === 64 ? -1 : base === 65 ? 1 : 0
    return { kind: 'wheel', delta, button: -1, x, y, ...mods }
  }
  // 32+ is motion with a button held (1002).
  if (base & 32) return { kind: 'drag', delta: 0, button: base & 3, x, y, ...mods }
  return { kind: match[4] === 'm' ? 'release' : 'press', delta: 0, button: base & 3, x, y, ...mods }
}

/** Looks like the tail of a mouse report that lost its framing (never type it). */
export function isMouseGarbage(input: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /^\u001b?\[<\d+;\d+;\d+[Mm]/.test(input)
}
