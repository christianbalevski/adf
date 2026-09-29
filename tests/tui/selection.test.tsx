// Chat item navigation (↑/↓ select, Enter expands, tall items scroll inside,
// wheel bursts still scroll), mouse mode (click expands, drag selects and
// copies, right-click pastes) and the composer's line-editing keys, driven
// with the bytes real terminals send.

import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { App } from '../../src/main/tui/app/App'
import { createTheme } from '../../src/main/tui/app/theme'
import { DaemonClient } from '../../src/main/tui/api/client'
import { createTuiStore, type TuiStore } from '../../src/main/tui/state/store'
import { setClipboardReader, setClipboardWriter } from '../../src/main/tui/app/clipboard'
import { setScreenText } from '../../src/main/tui/app/screen'
import { createMouseController, frameScreen, lineAt, selectionText, wordAt, type Bounds } from '../../src/main/tui/app/selection'
import { itemAtRow, navigate } from '../../src/main/tui/views/chat/model'
import { applyEdit, wordLeft, wordRight } from '../../src/main/tui/ui/edit'
import type { MouseEvent } from '../../src/main/tui/app/terminal'
import { AGENT_1_ID, startMockDaemon, type MockDaemon } from './fixtures/mock-daemon'
import { renderTui, type RenderedTui } from './fixtures/render'

const KEY = { enter: '\r', esc: '\u001b', up: '\u001b[A', down: '\u001b[B', end: '\u001b[F', space: ' ' }
const mouse = (code: number, x: number, y: number, up = false) => `\u001b[<${code};${x + 1};${y + 1}${up ? 'm' : 'M'}`
const press = (x: number, y: number) => mouse(0, x, y)
const drag = (x: number, y: number) => mouse(32, x, y)
const release = (x: number, y: number) => mouse(0, x, y, true)

let mock: MockDaemon | null = null
let store: TuiStore | null = null
let ui: RenderedTui | null = null

afterEach(async () => {
  ui?.unmount()
  ui = null
  store?.stop()
  store = null
  await mock?.close()
  mock = null
  setClipboardWriter(null)
  setClipboardReader(null)
  setScreenText(null)
})

const BIG_RESULT = Array.from({ length: 60 }, (_, i) => `result line ${i}`).join('\n')

async function mountChat(options: { rows?: number; columns?: number; bigTool?: boolean } = {}) {
  mock = await startMockDaemon({ stepMs: 15 })
  if (options.bigTool) {
    const rows = mock.agents.get(AGENT_1_ID)!.history.main
    const at = Date.now()
    rows.push({ seq: 90_001, role: 'assistant', content_json: [{ type: 'tool_use', id: 'tu_big', name: 'fs_read', input: { path: 'big.txt' } }], created_at: at })
    rows.push({ seq: 90_002, role: 'user', content_json: [{ type: 'tool_result', tool_use_id: 'tu_big', content: BIG_RESULT }], created_at: at + 1 })
  }
  store = createTuiStore({ client: new DaemonClient({ baseUrl: mock.url }), initialView: 'chat' })
  ui = renderTui(<App store={store} theme={createTheme({ mono: true })} />, { columns: options.columns ?? 120, rows: options.rows ?? 34 })
  await store.start()
  await ui.waitFor(f => f.includes('consolidator') && f.includes('fs_read'))
  await ui.waitFor(() => store!.getState().focus === 'input')
  return { tui: ui, store, mock }
}

/** The composer's text (the line under the prompt's `› `). */
function promptText(frame: string): string {
  const lines = frame.split('\n').filter(l => /│ › /.test(l))
  const line = lines.at(-1) ?? ''
  return (line.split('│ › ')[1] ?? '').replace(/\s*│\s*$/, '').trimEnd()
}

const rowOf = (frame: string, text: string) => frame.split('\n').findIndex(l => l.includes(text))
const colOf = (frame: string, text: string) => frame.split('\n')[rowOf(frame, text)].indexOf(text)

describe('item navigation (pure)', () => {
  // Heights oldest → newest; viewport 10, offset = rows hidden below.
  const heights = [2, 3, 30, 2]

  it('↑ with nothing selected picks the newest visible item, ↓ follows live', () => {
    expect(navigate(heights, -1, 0, 10, -1, 5)).toEqual({ index: 3, offset: 0 })
    expect(navigate(heights, -1, 0, 10, 1, 5)).toEqual({ index: 'follow', offset: 0 })
  })

  it('moves item by item, and past the newest back to the live end', () => {
    expect(navigate(heights, 3, 0, 10, 1, 5).index).toBe('follow')
    expect(navigate(heights, 1, 32, 10, 1, 5).index).toBe(2)
    expect(navigate(heights, 1, 32, 10, -1, 5)).toMatchObject({ index: 0 })
    expect(navigate(heights, 0, 35, 10, -1, 5)).toMatchObject({ index: 0, loadOlder: true })
  })

  it('an item taller than the viewport scrolls inside before the selection moves', () => {
    // Up into the tall item: its bottom shows first.
    const into = navigate(heights, 3, 0, 10, -1, 5)
    expect(into).toEqual({ index: 2, offset: 2 })
    // Up again scrolls within it (top is 32 rows up) by the step…
    expect(navigate(heights, 2, 2, 10, -1, 5)).toEqual({ index: 2, offset: 7 })
    // …until its top is on screen, then moves on.
    expect(navigate(heights, 2, 22, 10, -1, 5)).toMatchObject({ index: 1 })
    // Down scrolls back through it, then to the newer item.
    expect(navigate(heights, 2, 22, 10, 1, 5)).toEqual({ index: 2, offset: 17 })
    expect(navigate(heights, 2, 2, 10, 1, 5)).toEqual({ index: 3, offset: 0 })
  })

  it('finds the item under a viewport row', () => {
    expect(itemAtRow(heights, 0, 10, 9)).toBe(3)
    expect(itemAtRow(heights, 0, 10, 7)).toBe(2)
    expect(itemAtRow([1, 1], 0, 10, 0)).toBe(-1)
  })
})

describe('selection (pure)', () => {
  const frame = [
    'FLEET     │ › hello brave new world',
    'agent-1   │   second line here.',
    '          │',
  ].join('\n')
  const screen = frameScreen(frame, 40)
  const pane: Bounds = { x0: 11, y0: 0, x1: 40, y1: 3 }

  it('extracts the text of a drag, pane-bounded, trimmed and dedented', () => {
    expect(selectionText({ anchor: { x: 14, y: 0 }, focus: { x: 18, y: 0 }, bounds: pane }, screen)).toBe('hello')
    // Dragged back over the sidebar: clamped to the pane, never "agent-1".
    const back = selectionText({ anchor: { x: 13, y: 0 }, focus: { x: 0, y: 1 }, bounds: pane }, screen)
    expect(back).toBe('hello brave new world')
    const two = selectionText({ anchor: { x: 11, y: 0 }, focus: { x: 39, y: 1 }, bounds: pane }, screen)
    expect(two).toBe('› hello brave new world\n  second line here.')
  })

  it('double-click takes a word, triple-click the line', () => {
    expect(selectionText(wordAt(screen, { x: 21, y: 0 }, pane), screen)).toBe('brave')
    expect(selectionText(wordAt(screen, { x: 24, y: 1 }, pane), screen)).toBe('line')
    expect(selectionText(wordAt(screen, { x: 28, y: 1 }, pane), screen)).toBe('here')
    expect(selectionText(lineAt({ x: 20, y: 1 }, pane), screen)).toBe('second line here.')
  })

  it('the controller: drag copies, a still click clicks, right-click pastes', () => {
    const calls: string[] = []
    let now = 0
    const ctl = createMouseController({
      now: () => now,
      screen: () => screen,
      paneAt: () => pane,
      pressHandled: () => false,
      click: e => calls.push(`click ${e.x},${e.y}`),
      rightClick: () => calls.push('paste'),
      highlight: sel => calls.push(sel ? 'highlight' : 'clear'),
      copy: text => calls.push(`copy ${text}`),
    })
    const ev = (kind: MouseEvent['kind'], x: number, y: number, button = 0): MouseEvent => ({ kind, x, y, button, delta: 0, shift: false, alt: false, ctrl: false })
    ctl.handle(ev('press', 14, 0))
    ctl.handle(ev('drag', 18, 0))
    ctl.handle(ev('release', 18, 0))
    expect(calls).toEqual(['highlight', 'copy hello'])
    calls.length = 0
    now = 5000
    ctl.handle(ev('press', 22, 1))
    ctl.handle(ev('release', 22, 1))
    expect(calls).toEqual(['clear', 'click 22,1'])
    calls.length = 0
    now += 100
    ctl.handle(ev('press', 22, 1))
    ctl.handle(ev('release', 22, 1))
    expect(calls).toEqual(['highlight', 'copy line'])
    calls.length = 0
    ctl.handle(ev('press', 5, 5, 2))
    expect(calls).toEqual(['clear', 'paste'])
  })
})

describe('composer line editing (pure)', () => {
  it('words stop at punctuation and whitespace, like readline / VS Code', () => {
    const v = 'git commit -m "fix: the thing"'
    expect(wordLeft(v, v.length)).toBe(v.length - 1)
    expect(wordLeft(v, v.length - 1)).toBe(v.length - 6)
    expect(wordRight('foo.bar baz', 0)).toBe(3)
    expect(wordRight('foo.bar baz', 3)).toBe(4)
    expect(applyEdit('deleteLineLeft', 'one\ntwo', 4)).toEqual({ value: 'onetwo', cursor: 3 })
    expect(applyEdit('deleteLineLeft', 'one\ntwo', 7)).toEqual({ value: 'one\n', cursor: 4 })
  })
})

describe('composer line editing (bytes from real terminals)', () => {
  it('Ctrl+Backspace (BS), Alt+Backspace, Ctrl+W delete words; Backspace (DEL) one char', async () => {
    const { tui } = await mountChat()
    await tui.type('hello big world')
    await tui.waitFor(f => promptText(f) === 'hello big world')
    await tui.press('\u0008') // Windows Terminal / xterm Ctrl+Backspace
    await tui.waitFor(f => promptText(f) === 'hello big')
    await tui.press('\u001b\u007f') // Alt/Option+Backspace
    await tui.waitFor(f => promptText(f) === 'hello')
    await tui.press('\u007f') // Backspace (DEL): the space, then one letter
    await tui.press('\u007f')
    await tui.waitFor(f => promptText(f) === 'hell')
    await tui.press('\u0017') // Ctrl+W
    await tui.waitFor(f => f.includes('› Message agent-1'))
  })

  it('kitty protocol Ctrl+Backspace / Cmd+Backspace, Ctrl+U, Cmd+←/→, Ctrl+Delete, Alt+D', async () => {
    const { tui } = await mountChat()
    await tui.type('alpha beta gamma')
    await tui.press('\u001b[127;5u') // kitty Ctrl+Backspace
    await tui.waitFor(f => promptText(f) === 'alpha beta')
    await tui.press('\u001b[1;9D') // Cmd+← (super) → line start
    await tui.type('X')
    await tui.waitFor(f => promptText(f) === 'Xalpha beta')
    await tui.press('\u001b[3;5~') // Ctrl+Delete: the next word
    await tui.waitFor(f => promptText(f) === 'X beta')
    await tui.press('\u001bd') // Alt+D
    await tui.waitFor(f => promptText(f) === 'X')
    await tui.type(' tail')
    await tui.press('\u0001') // Ctrl+A
    await tui.press('\u0005') // Ctrl+E
    await tui.press('\u001b[127;9u') // kitty Cmd+Backspace: to the line start
    await tui.waitFor(f => f.includes('› Message agent-1'))
    await tui.type('keep this')
    await tui.press('\u0015') // Ctrl+U (iTerm2's Cmd+Backspace)
    await tui.waitFor(f => f.includes('› Message agent-1'))
  })
})

describe('chat item navigation', () => {
  it('↑ from an empty composer selects items, Enter / Space expand, Esc lets go', async () => {
    const { tui } = await mountChat()
    await tui.press(KEY.up)
    await tui.waitFor(f => /▌.*mind\.md updated/.test(f))
    await tui.press(KEY.up)
    await tui.waitFor(f => /▌.*fs_read/.test(f))
    await tui.press(KEY.enter)
    await tui.waitFor('v2 is frozen.')
    expect(tui.lastFrame()).toContain('"path": "notes/api.md"')
    await tui.press(KEY.space)
    await tui.waitFor(f => !f.includes('"path": "notes/api.md"'))
    await tui.press(KEY.esc)
    await tui.waitFor(f => !f.includes('▌'))
    // Typing still types; ↑ then edits the text.
    await tui.type('draft')
    await tui.press(KEY.up)
    expect(tui.lastFrame()).not.toContain('▌')
  })

  it('a wheel burst (several ↑ in one read) scrolls by lines and never moves the selection', async () => {
    const { tui } = await mountChat({ rows: 24 })
    await tui.press(KEY.up + KEY.up + KEY.up)
    await tui.waitFor(f => /3 newer rows below/.test(f))
    expect(tui.lastFrame()).not.toContain('▌')
  })

  it('a selected tool call taller than the view scrolls inside before moving on', async () => {
    const { tui } = await mountChat({ rows: 30, bigTool: true })
    await tui.press(KEY.up)
    await tui.waitFor(f => /▌.*fs_read/.test(f))
    // Expanding keeps the item's first row on screen (it grows downwards).
    await tui.press(KEY.enter)
    await tui.waitFor(f => /▌.*fs_read big\.txt|▌.*fs_read tu_big/.test(f) && !f.includes('result line 59'))
    // ↓ scrolls inside the tall item (the bar stays) until its end shows…
    await tui.press(KEY.down)
    const inside = await tui.waitFor(f => !f.includes('fs_read tu_big') && f.includes('result line'))
    expect(inside).toContain('▌')
    for (let i = 0; i < 12 && !tui.lastFrame().includes('result line 59'); i++) await tui.press(KEY.down)
    await tui.waitFor('result line 59')
    expect(tui.lastFrame()).toContain('▌')
    // …then ↑ scrolls back up through it before moving to the older item.
    await tui.press(KEY.up)
    await tui.waitFor(f => !f.includes('result line 59') && f.includes('▌'))
    for (let i = 0; i < 14; i++) await tui.press(KEY.up)
    await tui.waitFor(f => /▌.*What did we decide|▌.*mind\.md|▌.*We keep|▌.*from loop/.test(f))
  })
})

describe('mouse mode', () => {
  it('a click on a tool call selects and expands it; the composer keeps focus', async () => {
    const { tui, store } = await mountChat()
    const frame = tui.lastFrame()
    const y = rowOf(frame, 'fs_read')
    await tui.press(press(60, y) + release(60, y))
    await tui.waitFor('v2 is frozen.')
    expect(tui.lastFrame()).toMatch(/▌.*fs_read/)
    expect(store.getState().focus).toBe('input')
    // The item grew; click its header row again (another cell: not a double-click).
    const y2 = rowOf(tui.lastFrame(), 'fs_read tu_1')
    await tui.press(press(61, y2) + release(61, y2))
    await tui.waitFor(f => !f.includes('"path": "notes/api.md"'))
  })

  it('drag highlights and copies the text (pane-bounded); right-click pastes into the composer', async () => {
    const copied: string[] = []
    setClipboardWriter(async text => { copied.push(text); return true })
    setClipboardReader(async () => 'pasted\r\ntext')
    const { tui } = await mountChat()
    const frame = tui.lastFrame()
    setScreenText(frameScreen(frame, 120))
    const y = rowOf(frame, 'What did we decide')
    const x = colOf(frame, 'What did we decide')
    await tui.press(press(x, y) + drag(x + 5, y) + drag(x + 7, y) + release(x + 7, y))
    await tui.waitFor(() => copied.length === 1)
    expect(copied[0]).toBe('What did')
    await tui.waitFor('Copied 8 chars')
    // Dragged back over the sidebar: stops at the chat pane's edge.
    await tui.press(press(x + 3, y) + drag(2, y + 1) + release(2, y + 1))
    await tui.waitFor(() => copied.length === 2)
    expect(copied[1]).not.toMatch(/agent-1|FLEET|consolidator/)
    expect(copied[1].startsWith('t did we decide about the standings API?')).toBe(true)
    // Right-click pastes the clipboard at the caret.
    await tui.press(mouse(2, 60, 30))
    await tui.waitFor(f => f.includes('pasted') && f.includes('text'))
  })
})

void React
