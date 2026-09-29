// Shell behaviour that spans views: quitting, help, global loop switching,
// per-loop prompt drafts/history, @file completion, /compact, the fleet tree
// as the default sidebar.

import React from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { App } from '../../src/main/tui/app/App'
import { createTheme } from '../../src/main/tui/app/theme'
import { keyLabel } from '../../src/main/tui/app/keys'
import { DaemonClient } from '../../src/main/tui/api/client'
import { createTuiStore, type TuiStore } from '../../src/main/tui/state/store'
import { AGENT_1_ID, startMockDaemon, type MockDaemon } from './fixtures/mock-daemon'
import { renderTui, type RenderedTui } from './fixtures/render'

const KEY = { enter: '\r', tab: '\t', esc: '\u001b', ctrlC: '\u0003', ctrlRight: '\u001b[1;5C', ctrlLeft: '\u001b[1;5D', shiftRight: '\u001b[1;2C', shiftLeft: '\u001b[1;2D', altLeft: '\u001b[1;3D' }

let mock: MockDaemon
let store: TuiStore
let ui: RenderedTui | null = null
let exits = 0

beforeEach(async () => {
  mock = await startMockDaemon({ stepMs: 5 })
  store = createTuiStore({ client: new DaemonClient({ baseUrl: mock.url }) })
  exits = 0
})

afterEach(async () => {
  ui?.unmount()
  ui = null
  store.stop()
  await mock.close()
})

async function mount(view?: string) {
  ui = renderTui(<App store={store} theme={createTheme({ mono: true })} onExit={() => { exits++ }} />, { columns: 120, rows: 36 })
  await store.start()
  await ui.waitFor('consolidator')
  store.actions.selectAgent(AGENT_1_ID)
  if (view) store.actions.setView(view)
  return ui
}

async function focusPrompt(tui: RenderedTui) {
  store.actions.setFocus('input')
  await tui.waitFor(() => store.getState().focus === 'input')
  await new Promise(resolve => setTimeout(resolve, 80))
}

const selectedLoop = () => store.getState().selectedLoop[AGENT_1_ID] ?? 'main'

describe('shell integration', () => {
  it('labels keys without turning letters into Shift combos', () => {
    expect(keyLabel('e')).toBe('e')
    expect(keyLabel('A')).toBe('A')
    expect(keyLabel('ctrl+k')).toBe('Ctrl+K')
    expect(keyLabel('ctrl+left')).toBe('Ctrl+←')
    expect(keyLabel('alt+enter')).toBe('Alt+Enter')
    expect(keyLabel('shift+tab')).toBe('Shift+Tab')
  })

  it('clears a non-empty prompt on Ctrl+C and quits only on the second press', async () => {
    const tui = await mount('chat')
    await focusPrompt(tui)
    await tui.type('half a thought')
    await tui.waitFor('half a thought')
    await tui.press(KEY.ctrlC)
    await tui.waitFor(f => !f.includes('half a thought'))
    expect(exits).toBe(0)
    await tui.press(KEY.ctrlC)
    await tui.waitFor('Press Ctrl+C again')
    expect(exits).toBe(0)
    await tui.press(KEY.ctrlC)
    expect(exits).toBe(1)
  })

  it('cancels any open dialog on Ctrl+C instead of arming quit', async () => {
    const tui = await mount('loops')
    await tui.waitFor('Loops of agent-1')
    await tui.press('n')
    await tui.waitFor('New inner loop')
    await tui.press(KEY.ctrlC)
    await tui.waitFor(f => !f.includes('New inner loop'))
    expect(store.getState().overlays).toHaveLength(0)
    expect(tui.lastFrame()).not.toContain('Press Ctrl+C again')
    expect(exits).toBe(0)
  })

  it('opens the full reference on ? with the loops explainer and every view’s keys', async () => {
    const tui = await mount('fleet')
    await tui.press('?')
    const frame = await tui.waitFor('ADF keys & commands')
    expect(frame).toContain('Loops are an agent')
    expect(store.getState().overlays.at(-1)?.kind).toBe('help')
    await tui.press(KEY.esc)
    await tui.waitFor(f => !f.includes('ADF keys & commands'))
  })

  it('switches the selected agent’s loop with Ctrl+→/← from any view', async () => {
    const tui = await mount('loops')
    await tui.waitFor('Loops of agent-1')
    expect(selectedLoop()).toBe('main')
    await tui.press(KEY.ctrlRight)
    await tui.waitFor(() => selectedLoop() === 'consolidator')
    await tui.press(KEY.ctrlRight)
    await tui.waitFor(() => selectedLoop() === 'researcher')
    await tui.press(KEY.ctrlLeft)
    await tui.waitFor(() => selectedLoop() === 'consolidator')
    // The Loops view stays on its tab: Ctrl+arrows are not tab switches.
    expect(store.getState().activeView).toBe('loops')
  })

  it('keeps a separate prompt draft per loop in chat', async () => {
    const tui = await mount('chat')
    await focusPrompt(tui)
    await tui.type('note for main')
    await tui.waitFor('note for main')
    // With text in the prompt Ctrl+← jumps a word; Shift+→ switches the loop.
    await tui.press(KEY.ctrlLeft)
    expect(selectedLoop()).toBe('main')
    await tui.press(KEY.shiftRight)
    await tui.waitFor(() => selectedLoop() === 'consolidator')
    await tui.waitFor(f => !f.includes('note for main'))
    await tui.type('note for consolidator')
    await tui.waitFor('note for consolidator')
    await tui.press(KEY.shiftLeft)
    await tui.waitFor(() => selectedLoop() === 'main')
    const frame = await tui.waitFor('note for main')
    expect(frame).not.toContain('note for consolidator')
  })

  it('completes @file paths in the chat prompt with Tab', async () => {
    const tui = await mount('chat')
    await focusPrompt(tui)
    await tui.type('summarize @notes')
    await tui.waitFor('@notes/api.md')
    await tui.press(KEY.tab)
    await tui.waitFor('summarize @notes/api.md')
    await tui.press(KEY.enter)
    await tui.waitFor('Working on it in')
    expect(mock.agents.get(AGENT_1_ID)?.history.main.some(r => r.content_json[0].text === 'summarize @notes/api.md')).toBe(true)
  })

  it('compacts the selected loop with /compact', async () => {
    const tui = await mount('chat')
    store.actions.selectLoop(AGENT_1_ID, 'consolidator')
    await focusPrompt(tui)
    await tui.waitFor('Merged 3 notes')
    await tui.type('/compact')
    await tui.press(KEY.enter)
    await tui.waitFor('Compacted consolidator')
    await tui.waitFor('2 earlier rows summarized')
    expect(mock.agents.get(AGENT_1_ID)?.history.consolidator).toHaveLength(1)
    expect(mock.agents.get(AGENT_1_ID)?.history.main.length).toBeGreaterThan(1)
  })

  it('keeps the approval card intact through a resize sequence', async () => {
    // Same frame setup as the real TUI (reserved last row/column, colour theme).
    const tui = renderTui(<App store={store} theme={createTheme({ env: {} })} reserveRows={1} reserveColumns={1} />, { columns: 100, rows: 30 })
    ui = tui
    await store.start()
    await tui.waitFor('consolidator')
    store.actions.selectAgent(AGENT_1_ID)
    store.actions.setView('chat')
    await tui.waitFor('wants to run msg_send')
    for (const [columns, rows] of [[60, 20], [220, 55], [80, 24]]) {
      tui.resize(columns, rows)
      await new Promise(resolve => setTimeout(resolve, 400))
    }
    const frame = await tui.waitFor(f => f.includes('wants to run msg_send'))
    const lines = frame.split('\n')
    const title = lines.findIndex(l => l.includes('wants to run msg_send'))
    expect(lines[title - 1]).toMatch(/[╭+]/)
    expect(lines[title + 1]).toContain('"to":"agent-2"')
  })

  it('shows the fleet tree with loops as the sidebar in every view', async () => {
    const tui = await mount('files')
    const frame = await tui.waitFor('FLEET')
    expect(frame).toContain('consolidator')
    expect(frame).toContain('agent-2')
  })
})

void React
