// In-app text selection for mouse mode. Mouse reporting takes drag-to-select
// away from the terminal, so the TUI does it itself (like opencode): a drag
// highlights cells (reverse video, app/screen.ts paints it over the frame),
// the release copies them. The selection stays inside the pane the drag
// started in (never the sidebar next to the chat). Double-click selects a
// word, triple-click a line. A press and release on one cell is a click.
//
// Pure: cells come from a `ScreenText` (the screen mirror, or a test frame),
// effects go through `MouseDeps`.

import type { MouseEvent } from './terminal'

export interface Cell { x: number; y: number }

/** A pane's cells: x0 / y0 inclusive, x1 / y1 exclusive. */
export interface Bounds { x0: number; y0: number; x1: number; y1: number }

export interface TextSelection { anchor: Cell; focus: Cell; bounds: Bounds }

/** What is on screen, cell by cell. */
export interface ScreenText {
  readonly cols: number
  readonly rows: number
  /** The character in a cell: ' ' when blank, '' for the second half of a wide character. */
  cell(x: number, y: number): string
}

export interface SelectionRow { y: number; x0: number; x1: number }

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function clampCell(cell: Cell, b: Bounds): Cell {
  return { x: clamp(cell.x, b.x0, b.x1 - 1), y: clamp(cell.y, b.y0, b.y1 - 1) }
}

function before(a: Cell, b: Cell): boolean {
  return a.y < b.y || (a.y === b.y && a.x <= b.x)
}

/** The highlighted cells, row by row in reading order (x1 exclusive). */
export function selectionRows(sel: TextSelection): SelectionRow[] {
  const a = clampCell(sel.anchor, sel.bounds)
  const f = clampCell(sel.focus, sel.bounds)
  const [start, end] = before(a, f) ? [a, f] : [f, a]
  const rows: SelectionRow[] = []
  for (let y = start.y; y <= end.y; y++) {
    rows.push({ y, x0: y === start.y ? start.x : sel.bounds.x0, x1: y === end.y ? end.x + 1 : sel.bounds.x1 })
  }
  return rows
}

export function rowText(screen: ScreenText, y: number, x0: number, x1: number): string {
  let out = ''
  for (let x = Math.max(0, x0); x < Math.min(screen.cols, x1); x++) out += screen.cell(x, y)
  return out
}

/**
 * The selected text: each row with trailing blanks cut, the indent every
 * line shares removed (the pane's padding and gutters), blank edges dropped.
 */
export function selectionText(sel: TextSelection, screen: ScreenText): string {
  const lines = selectionRows(sel).map(r => rowText(screen, r.y, r.x0, r.x1).replace(/\s+$/, ''))
  while (lines.length > 0 && lines[0] === '') lines.shift()
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const indents = lines.filter(l => l.trim()).map(l => l.length - l.trimStart().length)
  const common = indents.length > 0 ? Math.min(...indents) : 0
  return lines.map(l => l.slice(common)).join('\n')
}

// Word characters for double-click: identifiers, paths, URLs, numbers.
const WORD = /[\p{L}\p{N}_\-./\\:@~+%#?=&]/u

/** The word (or run of one other character) under a cell, within the pane. */
export function wordAt(screen: ScreenText, at: Cell, b: Bounds): TextSelection {
  const isWord = (x: number) => { const ch = screen.cell(x, at.y); return ch === '' || WORD.test(ch) }
  const here = screen.cell(at.x, at.y)
  if (!WORD.test(here) && here !== '') return { anchor: at, focus: at, bounds: b }
  let x0 = at.x
  let x1 = at.x
  while (x0 > b.x0 && isWord(x0 - 1)) x0--
  while (x1 < b.x1 - 1 && isWord(x1 + 1)) x1++
  // Trailing sentence punctuation is not part of a word.
  while (x1 > x0 && /[.:,?]/.test(screen.cell(x1, at.y))) x1--
  return { anchor: { x: x0, y: at.y }, focus: { x: x1, y: at.y }, bounds: b }
}

/** The whole row of the pane under a cell. */
export function lineAt(at: Cell, b: Bounds): TextSelection {
  return { anchor: { x: b.x0, y: at.y }, focus: { x: b.x1 - 1, y: at.y }, bounds: b }
}

/** Plain text frame (a test frame, or any ANSI-free screen) as ScreenText. Wide characters take two cells. */
export function frameScreen(frame: string, cols: number, rows?: number): ScreenText {
  // eslint-disable-next-line no-control-regex
  const lines = frame.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').split('\n')
  const grid = lines.map(line => {
    const cells: string[] = []
    for (const ch of line) {
      const wide = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{1f300}-\u{1faff}]/u.test(ch)
      cells.push(ch)
      if (wide) cells.push('')
    }
    return cells
  })
  return {
    cols,
    rows: rows ?? grid.length,
    cell: (x, y) => grid[y]?.[x] ?? ' ',
  }
}

// --- the mouse controller ---------------------------------------------------------

/** Presses on one cell within this window count as a double / triple click. */
export const MULTI_CLICK_MS = 450

export interface MouseDeps {
  now(): number
  screen(): ScreenText | null
  /** The pane under a cell: the selection stays inside it. */
  paneAt(x: number, y: number): Bounds
  /** A press the shell handles itself (header tabs, web badge): no selection. */
  pressHandled(event: MouseEvent): boolean
  /** A plain left click (press + release on one cell, no drag). */
  click(event: MouseEvent): void
  /** Right button: paste. */
  rightClick(event: MouseEvent): void
  /** Show (or clear, null) the highlight. */
  highlight(sel: TextSelection | null): void
  /** Copy the selected text (the release). */
  copy(text: string): void
}

export interface MouseController {
  /** Feed a press / drag / release (wheel notches are routed elsewhere). */
  handle(event: MouseEvent): void
  /** Drop the highlight (a key was pressed). */
  clear(): void
  /** The current highlight (tests). */
  selection(): TextSelection | null
}

export function createMouseController(deps: MouseDeps): MouseController {
  let press: { event: MouseEvent; bounds: Bounds; count: number; dragging: boolean } | null = null
  let last: { x: number; y: number; at: number; count: number } | null = null
  let current: TextSelection | null = null

  const show = (sel: TextSelection | null) => {
    if (!sel && !current) return
    current = sel
    deps.highlight(sel)
  }

  return {
    selection: () => current,
    clear: () => show(null),
    handle(event) {
      if (event.kind === 'press' && event.button === 2) { show(null); deps.rightClick(event); return }
      if (event.kind === 'press' && event.button === 0) {
        show(null)
        press = null
        if (deps.pressHandled(event)) { last = null; return }
        const now = deps.now()
        const count = last && last.x === event.x && last.y === event.y && now - last.at <= MULTI_CLICK_MS ? Math.min(3, last.count + 1) : 1
        last = { x: event.x, y: event.y, at: now, count }
        const bounds = deps.paneAt(event.x, event.y)
        press = { event, bounds, count, dragging: false }
        const screen = deps.screen()
        if (count === 2 && screen) show(wordAt(screen, event, bounds))
        else if (count === 3) show(lineAt(event, bounds))
        return
      }
      if (!press) return
      if (event.kind === 'drag') {
        const focus = clampCell(event, press.bounds)
        if (!press.dragging && focus.x === press.event.x && focus.y === press.event.y) return
        press.dragging = true
        last = null
        show({ anchor: clampCell(press.event, press.bounds), focus, bounds: press.bounds })
        return
      }
      if (event.kind === 'release') {
        const done = press
        press = null
        if (done.dragging || done.count > 1) {
          const screen = deps.screen()
          const text = current && screen ? selectionText(current, screen) : ''
          if (text) deps.copy(text)
          return
        }
        deps.click(done.event)
      }
    },
  }
}
