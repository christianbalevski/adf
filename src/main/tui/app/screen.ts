// What is on screen, for in-app text selection (app/selection.ts). Every
// write the TUI makes to the terminal (ink's frames) is mirrored into an
// in-process headless terminal (@xterm/headless), so the cells under a drag
// are known exactly, wide characters and all. The highlight is painted over
// the frame as reverse video straight to the terminal (never into the
// mirror) after each frame; clearing it asks ink to repaint its frame.
//
// Only in the alternate screen (pointer rows map onto the frame there).
// Tests without a terminal set a ScreenText with `setScreenText`.

import type { ScreenText, TextSelection } from './selection'
import { selectionRows } from './selection'
import { setWriteTap, writeTerminal } from './terminal'

interface XtermCell { getChars(): string; getWidth(): number }
interface XtermLine { getCell(x: number): XtermCell | undefined }
interface XtermTerminal {
  cols: number
  rows: number
  buffer: { active: { viewportY: number; getLine(y: number): XtermLine | undefined } }
  write(data: string, callback?: () => void): void
  resize(cols: number, rows: number): void
  dispose(): void
}

let screen: ScreenText | null = null
let highlight: TextSelection | null = null
let repaint: (() => void) | null = null
let painted = false
let paintQueued = false

export function getScreenText(): ScreenText | null {
  return screen
}

/** Tests: a fixed screen (e.g. `frameScreen(lastFrame(), cols)`); null removes it. */
export function setScreenText(next: ScreenText | null): void {
  screen = next
}

/** How to make ink write its whole frame again (the shell: ink's write('')). */
export function setRepaint(fn: (() => void) | null): void {
  repaint = fn
}

/** The current highlight (tests). */
export function currentHighlight(): TextSelection | null {
  return highlight
}

const SAVE = '\u001b7'
const RESTORE = '\u001b8'

/** The reverse-video overlay for a selection over what `text` shows. */
export function highlightSequence(sel: TextSelection, text: ScreenText): string {
  let seq = ''
  for (const row of selectionRows(sel)) {
    let cells = ''
    for (let x = row.x0; x < row.x1 && x < text.cols; x++) cells += text.cell(x, row.y)
    if (!cells) continue
    seq += `\u001b[${row.y + 1};${row.x0 + 1}H\u001b[7m${cells}\u001b[27m`
  }
  return seq ? `${SAVE}${seq}\u001b[0m${RESTORE}` : ''
}

function cellsUnder(sel: TextSelection, text: ScreenText): string {
  return selectionRows(sel).map(row => {
    let cells = ''
    for (let x = row.x0; x < row.x1 && x < text.cols; x++) cells += text.cell(x, row.y)
    return cells
  }).join('\n')
}

let snapshot = ''

function paint(): void {
  paintQueued = false
  if (!highlight || !screen) return
  // The content moved under the highlight (scrolling, a toast, streaming):
  // drop it rather than mark cells that no longer hold the selected text.
  if (cellsUnder(highlight, screen) !== snapshot) { setHighlight(null); return }
  const seq = highlightSequence(highlight, screen)
  if (seq && writeTerminal(seq)) painted = true
}

/** Show (a selection) or clear (null) the highlight. */
export function setHighlight(sel: TextSelection | null): void {
  highlight = sel
  if (sel) { snapshot = screen ? cellsUnder(sel, screen) : ''; paint(); return }
  if (painted) {
    painted = false
    // The overlay is in the terminal only: ink redraws its frame over it.
    repaint?.()
  }
}

/** Repaint the highlight once the latest frame has been mirrored. */
function queuePaint(): void {
  if (!highlight || paintQueued) return
  paintQueued = true
  setImmediate(paint)
}

class MirrorScreen implements ScreenText {
  constructor(private term: XtermTerminal) {}
  get cols() { return this.term.cols }
  get rows() { return this.term.rows }
  cell(x: number, y: number): string {
    const buffer = this.term.buffer.active
    const cell = buffer.getLine(buffer.viewportY + y)?.getCell(x)
    if (!cell) return ' '
    if (cell.getWidth() === 0) return ''
    return cell.getChars() || ' '
  }
}

/**
 * Mirror the terminal: every later TUI write is parsed into a headless
 * terminal of the same size. Returns an uninstall. Loads @xterm/headless
 * lazily (it is only needed in a real terminal).
 */
export async function installScreenMirror(stdout: NodeJS.WriteStream): Promise<() => void> {
  const mod = (await import('@xterm/headless')) as unknown as { Terminal?: new (o: object) => XtermTerminal; default?: { Terminal: new (o: object) => XtermTerminal } }
  const Terminal = mod.Terminal ?? mod.default?.Terminal
  if (!Terminal) return () => {}
  const term = new Terminal({ cols: stdout.columns || 80, rows: stdout.rows || 24, scrollback: 0, allowProposedApi: true, logLevel: 'off' })
  screen = new MirrorScreen(term)
  const onResize = () => { try { term.resize(stdout.columns || 80, stdout.rows || 24) } catch { /* ignore */ } }
  stdout.on('resize', onResize)
  setWriteTap(data => { term.write(data, queuePaint) })
  return () => {
    setWriteTap(null)
    stdout.off('resize', onResize)
    screen = null
    highlight = null
    painted = false
    term.dispose()
  }
}
