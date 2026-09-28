// Terminal integration: kitty keyboard protocol keys (Shift+Enter & co),
// SGR mouse (wheel routing, no leaks into the prompt), the sidebar toggle,
// chat's empty-composer scrolling, persisted prefs.

import React from 'react'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { App } from '../../src/main/tui/app/App'
import { createTheme } from '../../src/main/tui/app/theme'
import { DaemonClient } from '../../src/main/tui/api/client'
import { createTuiStore, type TuiStore } from '../../src/main/tui/state/store'
import { ALT_SCROLL_OFF, ALT_SCROLL_ON, MOUSE_OFF, MOUSE_ON, installTerminalModes, isMouseGarbage, newlineKey, parseMouse, setMouseWanted, terminalCaps } from '../../src/main/tui/app/terminal'
import { defaultPrefsPath, getPrefs, loadPrefs, resetPrefs, savePrefs } from '../../src/main/tui/app/prefs'
import { readLayout } from '../../src/main/tui/app/layout'
import { tabWindow } from '../../src/main/tui/ui/Tabs'
import { detectTerminal, terminalSetupLines } from '../../src/main/tui/app/terminal-setup'
import { lineText } from '../../src/main/tui/views/inspect/format'
import { AGENT_1_ID, startMockDaemon, type MockDaemon } from './fixtures/mock-daemon'
import { renderTui, type RenderedTui } from './fixtures/render'
import { seedHistory } from './fixtures/chat-script'

const KITTY = {
  shiftEnter: '\u001b[13;2u',
  altEnter: '\u001b[13;3u',
  ctrlJ: '\u001b[106;5u',
  ctrlC: '\u001b[99;5u',
  esc: '\u001b[27u',
  shiftTab: '\u001b[9;2u',
  alt4: '\u001b[52;3u',
  ctrlK: '\u001b[107;5u',
}
const KEY = { enter: '\r', tab: '\t', up: '\u001b[A', down: '\u001b[B', ctrlUp: '\u001b[1;5A', end: '\u001b[F', shiftRight: '\u001b[1;2C', ctrlB: '\u0002' }
const wheel = (x: number, y: number, up: boolean) => `\u001b[<${up ? 64 : 65};${x + 1};${y + 1}M`
const click = (x: number, y: number) => `\u001b[<0;${x + 1};${y + 1}M`
const release = (x: number, y: number) => `\u001b[<0;${x + 1};${y + 1}m`

class FakeTty extends EventEmitter {
  isTTY = true
  written: string[] = []
  raw: boolean[] = []
  write = (data: string) => { this.written.push(data); return true }
  setRawMode = (on: boolean) => { this.raw.push(on); return this }
}

/** Reset the terminal-caps singleton (each test starts from "nothing detected"). */
function resetCaps(): void {
  const tty = new FakeTty()
  installTerminalModes({ stdin: tty as never, stdout: tty as never, mouse: false, altScreen: false })()
}

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
  resetPrefs()
  resetCaps()
})

async function mountChat(options: { columns?: number; rows?: number; history?: number } = {}) {
  mock = await startMockDaemon({ stepMs: 10 })
  if (options.history) seedHistory(mock, AGENT_1_ID, 'main', options.history)
  store = createTuiStore({ client: new DaemonClient({ baseUrl: mock.url }), initialView: 'chat' })
  ui = renderTui(<App store={store} theme={createTheme({ mono: true })} />, { columns: options.columns ?? 120, rows: options.rows ?? 34 })
  await store.start()
  await ui.waitFor('consolidator')
  store.actions.selectAgent(AGENT_1_ID)
  await ui.waitFor(() => store!.getState().focus === 'input')
  return { tui: ui, store, mock }
}

const lastUserText = (m: MockDaemon) => {
  const rows = m.agents.get(AGENT_1_ID)!.history.main
  return rows.filter(r => r.role === 'user').at(-1)?.content_json[0].text
}

describe('terminal modes', () => {
  it('parses SGR mouse reports and never mistakes keys for them', () => {
    expect(parseMouse('[<64;10;5M')).toMatchObject({ kind: 'wheel', delta: -1, x: 9, y: 4 })
    expect(parseMouse('\u001b[<65;1;1M')).toMatchObject({ kind: 'wheel', delta: 1, x: 0, y: 0 })
    expect(parseMouse('[<80;3;3M')).toMatchObject({ kind: 'wheel', delta: -1, ctrl: true })
    expect(parseMouse('[<0;3;4M')).toMatchObject({ kind: 'press', button: 0, x: 2, y: 3 })
    expect(parseMouse('[<0;3;4m')).toMatchObject({ kind: 'release' })
    expect(parseMouse('[A')).toBeNull()
    expect(parseMouse('hello')).toBeNull()
    expect(isMouseGarbage('[<64;10;5M')).toBe(true)
    expect(isMouseGarbage('<64')).toBe(false)
  })

  it('turns mouse capture on with raw mode and off whenever the terminal is handed back', () => {
    const stdin = new FakeTty()
    const stdout = new FakeTty()
    const uninstall = installTerminalModes({ stdin: stdin as never, stdout: stdout as never, mouse: true, altScreen: true })
    stdin.setRawMode(true)
    expect(stdout.written).toEqual([MOUSE_ON])
    expect(terminalCaps().mouseActive).toBe(true)
    // ink drops raw mode for suspendTerminal (editor) and on exit.
    stdin.setRawMode(false)
    expect(stdout.written).toEqual([MOUSE_ON, MOUSE_OFF])
    stdin.setRawMode(true)
    // ink's kitty enable / disable writes are observed.
    stdout.write('\u001b[>1u')
    expect(terminalCaps().kitty).toBe(true)
    expect(newlineKey()).toBe('shift+enter')
    stdout.write('\u001b[<u')
    expect(terminalCaps().kitty).toBe(false)
    expect(newlineKey()).toBe('alt+enter')
    uninstall()
    expect(stdout.written.at(-1)).toBe(MOUSE_OFF)
    expect(terminalCaps().mouseActive).toBe(false)
    expect(stdin.raw).toEqual([true, false, true])
  })

  it('by default leaves the mouse to the terminal and turns on alternate scroll (wheel → ↑/↓), restored on hand-back', () => {
    const stdin = new FakeTty()
    const stdout = new FakeTty()
    const uninstall = installTerminalModes({ stdin: stdin as never, stdout: stdout as never, mouse: false, altScreen: true })
    stdin.setRawMode(true)
    expect(stdout.written).toEqual([ALT_SCROLL_ON])
    expect(terminalCaps()).toMatchObject({ mouseActive: false, altScrollActive: true })
    stdin.setRawMode(false)
    expect(stdout.written).toEqual([ALT_SCROLL_ON, ALT_SCROLL_OFF])
    stdin.setRawMode(true)
    // /mouse on swaps alternate scroll for full mouse reporting, /mouse off swaps back.
    setMouseWanted(true)
    expect(stdout.written.at(-1)).toBe(MOUSE_ON + ALT_SCROLL_OFF)
    setMouseWanted(false)
    expect(stdout.written.at(-1)).toBe(MOUSE_OFF + ALT_SCROLL_ON)
    uninstall()
    expect(stdout.written.at(-1)).toBe(ALT_SCROLL_OFF)
    expect(terminalCaps().altScrollActive).toBe(false)
  })

  it('keeps the mouse off outside the alternate screen', () => {
    const stdin = new FakeTty()
    const stdout = new FakeTty()
    const uninstall = installTerminalModes({ stdin: stdin as never, stdout: stdout as never, mouse: true, altScreen: false })
    stdin.setRawMode(true)
    expect(stdout.written).toEqual([])
    uninstall()
  })

  it('persists prefs in a small JSON file (ADF_TUI_PREFS), in memory when off', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-tui-prefs-'))
    try {
      const file = join(dir, 'nested', 'tui-prefs.json')
      expect(defaultPrefsPath({ ADF_TUI_PREFS: file })).toBe(file)
      expect(defaultPrefsPath({ ADF_TUI_PREFS: 'off' })).toBeNull()
      expect(defaultPrefsPath({ APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }, 'win32')).toMatch(/adf-studio[\\/]tui-prefs\.json$/)
      loadPrefs(file)
      savePrefs({ sidebar: false })
      savePrefs({ tips: { shiftEnter: true } })
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ sidebar: false, tips: { shiftEnter: true } })
      expect(loadPrefs(file)).toEqual({ sidebar: false, tips: { shiftEnter: true } })
      loadPrefs(null)
      savePrefs({ mouse: false })
      expect(getPrefs()).toEqual({ mouse: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('slides a tab strip so the active tab stays visible', () => {
    const widths = [8, 10, 9, 11, 7, 7, 10, 9, 10, 10, 8]
    expect(tabWindow(widths, 0, 40)).toEqual({ start: 0, end: 3 })
    const end = tabWindow(widths, 10, 40)
    expect(end.end).toBe(10)
    expect(end.start).toBeGreaterThan(5)
  })

  it('explains Shift+Enter setup for the detected terminal', () => {
    expect(detectTerminal({ WT_SESSION: 'x' })).toBe('windows-terminal')
    expect(detectTerminal({ TERM_PROGRAM: 'vscode', WT_SESSION: 'x' })).toBe('vscode')
    expect(detectTerminal({ TERM_PROGRAM: 'iTerm.app' })).toBe('iterm2')
    expect(detectTerminal({ TMUX: '/tmp/x', TERM_PROGRAM: 'tmux' })).toBe('tmux')
    const text = terminalSetupLines('vscode').map(lineText).join('\n')
    expect(text.indexOf('VS Code')).toBeLessThan(text.indexOf('Windows Terminal'))
    expect(text).toContain('workbench.action.terminal.sendSequence')
    expect(text).toContain('\\u001b[13;2u')
    expect(text).toContain('Alt+Enter, Ctrl+J')
  })
})

describe('keys with the kitty keyboard protocol', () => {
  it('Shift+Enter and Ctrl+J insert newlines, Enter sends, nothing leaks into the prompt', async () => {
    const { tui, mock } = await mountChat()
    await tui.waitFor('Alt+Enter newline')
    await tui.type('first')
    await tui.press(KITTY.shiftEnter)
    await tui.type('second')
    await tui.press(KITTY.ctrlJ)
    await tui.type('third')
    await tui.press(KITTY.altEnter)
    await tui.type('fourth')
    const frame = await tui.waitFor('fourth')
    expect(frame).not.toMatch(/\[13;|\[106;|;2u|;5u/)
    expect(frame).toContain('first')
    // The hint switches once a real Shift+Enter arrived.
    expect(frame).not.toContain('Alt+Enter newline')
    await tui.press(KEY.enter)
    await tui.waitFor(() => lastUserText(mock) === 'first\nsecond\nthird\nfourth')
  })

  it('Esc, Ctrl+C, Shift+Tab, Ctrl+K, Alt+digit and Shift+arrows still work', async () => {
    const { tui, store } = await mountChat()
    await tui.type('draft text')
    await tui.waitFor('draft text')
    await tui.press(KITTY.ctrlC)
    await tui.waitFor(f => !f.includes('draft text'))
    await tui.press(KITTY.shiftTab)
    await tui.waitFor(() => store.getState().focus === 'main')
    await tui.press(KITTY.ctrlK)
    await tui.waitFor('Command palette')
    await tui.press(KITTY.esc)
    await tui.waitFor(f => !f.includes('Command palette'))
    await tui.press(KEY.shiftRight)
    await tui.waitFor(() => store.getState().selectedLoop[AGENT_1_ID] === 'consolidator')
    await tui.press(KITTY.alt4)
    await tui.waitFor(() => store.getState().activeView === 'loops')
  })
})

describe('mouse and scrolling', () => {
  it('the wheel scrolls the transcript under the pointer; reports never reach the prompt', async () => {
    const { tui, store } = await mountChat({ history: 80 })
    await tui.waitFor('answer 79')
    // Main pane starts right of the sidebar (~28 cols at 120).
    for (let i = 0; i < 4; i++) await tui.press(wheel(70, 12, true))
    await tui.waitFor(f => /newer rows? below/.test(f))
    expect(tui.lastFrame()).not.toMatch(/\[<6|;12M/)
    for (let i = 0; i < 6; i++) await tui.press(wheel(70, 12, false))
    await tui.waitFor(f => !/newer rows? below/.test(f))
    // Over the sidebar the transcript does not move.
    await tui.press(wheel(3, 5, true))
    await tui.press(wheel(3, 5, true))
    expect(tui.lastFrame()).not.toMatch(/newer rows? below/)
    // A click on a transcript item selects it and the prompt keeps focus; a
    // click on the sidebar focuses it; in the prompt, the prompt.
    await tui.press(click(70, 10) + release(70, 10))
    await tui.waitFor(f => f.includes('▌'))
    expect(store.getState().focus).toBe('input')
    await tui.press(click(3, 5) + release(3, 5))
    await tui.waitFor(() => store.getState().focus === 'sidebar')
    await tui.press(click(70, 31) + release(70, 31))
    await tui.waitFor(() => store.getState().focus === 'input')
  })

  it('with an empty prompt ↑/↓ select transcript items; Ctrl+↑ recalls history', async () => {
    const { tui, mock } = await mountChat({ history: 80 })
    await tui.waitFor('answer 79')
    await tui.press(KEY.up)
    await tui.waitFor(f => f.includes('▌● answer 79'))
    await tui.press(KEY.up)
    await tui.waitFor(f => f.includes('▌› question 78') && !f.includes('▌● answer 79'))
    await tui.press(KEY.end)
    await tui.waitFor(f => !/newer rows? below/.test(f) && !f.includes('▌'))
    await tui.type('hello there')
    await tui.press(KEY.enter)
    await tui.waitFor(() => lastUserText(mock) === 'hello there')
    await tui.press(KEY.ctrlUp)
    await tui.waitFor(f => f.includes('› hello there') && !/newer rows? below/.test(f))
    // With text in the box ↑ keeps editing / walking history, not scrolling.
    await tui.press(KEY.up)
    expect(tui.lastFrame()).not.toMatch(/newer rows? below/)
  })

  it('a wheel burst (alternate scroll: several ↑ in one read) scrolls even with text in the composer; a lone ↑ still edits', async () => {
    const { tui } = await mountChat({ history: 80 })
    await tui.waitFor('answer 79')
    await tui.type('draft stays')
    await tui.waitFor('draft stays')
    await tui.press(KEY.up + KEY.up + KEY.up)
    await tui.waitFor(f => /3 newer rows below/.test(f))
    expect(tui.lastFrame()).toContain('draft stays')
    await tui.press(KEY.down + KEY.down + KEY.down)
    await tui.waitFor(f => !/newer rows? below/.test(f))
    await tui.press(KEY.up)
    expect(tui.lastFrame()).not.toMatch(/newer rows? below/)
  })
})

describe('sidebar toggle', () => {
  it('Ctrl+B hides the sidebar (full-width chat), Tab skips it, the header keeps unread and pending', async () => {
    const { tui, store, mock } = await mountChat()
    await tui.waitFor('FLEET')
    await tui.press(KEY.ctrlB)
    const hidden = await tui.waitFor(f => !f.includes('FLEET') && f.includes('Sidebar hidden'))
    expect(readLayout(store.getState()).sidebarHidden).toBe(true)
    expect(hidden).toContain('agent-1 › ↻ main')
    // Focus cycles prompt → main → prompt without the sidebar.
    const seen = new Set<string>()
    for (let i = 0; i < 3; i++) { await tui.press(KEY.tab); seen.add(store.getState().focus) }
    expect(seen.has('sidebar')).toBe(false)
    mock.emit({ event_type: 'message.received', agent_id: AGENT_1_ID, payload: { from: 'agent-2' } })
    await tui.waitFor('«1 unread')
    // /sidebar on brings it back; the header drops the unread count (the tree shows it).
    store.actions.prefillPrompt('')
    await tui.waitFor(() => store.getState().focus === 'input')
    await tui.type('/sidebar on')
    await tui.press(KEY.enter)
    await tui.waitFor(f => f.includes('FLEET') && !f.includes('«1 unread '))
  })
})

void React
