// Esc brings focus up to the header tab bar once nothing else wants it:
// ←/→ switch views live, Enter / ↓ go back in, digits jump, Tab continues the
// cycle, a click on a tab switches. Esc keeps its earlier jobs first (dialogs,
// a view's own mode, chat's interrupt, the prompt's double-Esc clear).

import React from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { App } from '../../src/main/tui/app/App'
import { createTheme } from '../../src/main/tui/app/theme'
import { tabsCursorOnAgent } from '../../src/main/tui/app/Header'
import { DaemonClient } from '../../src/main/tui/api/client'
import { createTuiStore, type TuiStore } from '../../src/main/tui/state/store'
import { AGENT_1_ID, startMockDaemon, type MockDaemon } from './fixtures/mock-daemon'
import { renderTui, type RenderedTui } from './fixtures/render'

const KEY = { enter: '\r', esc: '\u001b', tab: '\t', shiftTab: '\u001b[Z', left: '\u001b[D', right: '\u001b[C', down: '\u001b[B', up: '\u001b[A' }

let mock: MockDaemon
let store: TuiStore
let ui: RenderedTui | null = null

beforeEach(async () => {
  mock = await startMockDaemon({ stepMs: 5 })
  store = createTuiStore({ client: new DaemonClient({ baseUrl: mock.url }) })
})

afterEach(async () => {
  ui?.unmount()
  ui = null
  store.stop()
  await mock.close()
})

async function mount(size = { columns: 120, rows: 34 }) {
  ui = renderTui(<App store={store} theme={createTheme({ mono: true })} />, size)
  await store.start()
  await ui.waitFor(f => f.includes('agent-1') && f.includes('live'))
  store.actions.selectAgent(AGENT_1_ID)
  return ui
}

const focus = () => store.getState().focus
const view = () => store.getState().activeView
/** Esc arrives alone, not glued to the next key. */
const esc = async (tui: RenderedTui) => { await tui.press(KEY.esc); await new Promise(r => setTimeout(r, 30)) }

describe('tab bar focus', () => {
  it('Esc from the main pane or the sidebar focuses the tab bar; ←/→ switch views live, Enter goes back in', async () => {
    const tui = await mount()
    store.actions.setFocus('main')
    await esc(tui)
    expect(focus()).toBe('tabs')
    const frame = await tui.waitFor('←/→ view · Enter open · 1-6 jump')
    expect(frame).toContain('w web server')
    // Order: [agent label] 1 Chat 2 Files 3 Loops 4 Inspect | 5 Fleet 6 Runtime (launch is on Fleet).
    await tui.press(KEY.right)
    expect(view()).toBe('runtime')
    expect(focus()).toBe('tabs')
    // Past the last view: the agent label (the view stays), then Chat.
    await tui.press(KEY.right)
    expect(tabsCursorOnAgent(store.getState())).toBe(true)
    expect(view()).toBe('runtime')
    await tui.press(KEY.right)
    expect(view()).toBe('chat')
    expect(tabsCursorOnAgent(store.getState())).toBe(false)
    await tui.press(KEY.right)
    expect(view()).toBe('files')
    await tui.press(KEY.left)
    await tui.press(KEY.left)
    expect(tabsCursorOnAgent(store.getState())).toBe(true)
    await tui.press(KEY.left)
    expect(view()).toBe('runtime')
    await tui.press(KEY.enter)
    expect(focus()).toBe('main')
    // From the sidebar too.
    store.actions.setFocus('sidebar')
    await esc(tui)
    expect(focus()).toBe('tabs')
    // ↓ into Chat lands in its prompt; digits jump straight into a view.
    await tui.press('1')
    expect(view()).toBe('chat')
    expect(focus()).toBe('input')
  })

  it('Tab from the tab bar continues the focus cycle; Shift+Tab goes to the last pane', async () => {
    const tui = await mount()
    store.actions.setFocus('tabs')
    await tui.press(KEY.tab)
    expect(focus()).toBe('sidebar')
    store.actions.setFocus('tabs')
    await tui.press(KEY.shiftTab)
    expect(focus()).toBe('input')
  })

  it('in the prompt: Esc with text arms, Esc again clears; Esc on an empty prompt goes to the tab bar', async () => {
    const tui = await mount()
    store.actions.setView('chat')
    await tui.waitFor('Message agent-1')
    expect(focus()).toBe('input')
    await tui.type('draft text')
    await tui.waitFor('draft text')
    await esc(tui)
    expect(focus()).toBe('input')
    expect(tui.lastFrame()).toContain('draft text')
    await tui.press(KEY.esc)
    await tui.waitFor(f => !f.includes('draft text'))
    expect(focus()).toBe('input')
    await new Promise(r => setTimeout(r, 650))
    await esc(tui)
    expect(focus()).toBe('tabs')
  })

  it('Esc still interrupts a running chat turn first, and closes dialogs before anything else', async () => {
    const tui = await mount()
    store.actions.setView('chat')
    await tui.waitFor('Message agent-1')
    // A turn that keeps running until interrupted.
    mock.emit({ event_type: 'agent.state.changed', agent_id: AGENT_1_ID, payload: { state: 'thinking' } })
    await tui.waitFor('Esc interrupts')
    await esc(tui)
    expect(focus()).toBe('input')
    expect(mock.requests.some(r => r.startsWith('POST /agents/') && r.includes('/interrupt'))).toBe(true)
    // A dialog: Esc closes it and focus stays where it was.
    await tui.waitFor(f => !f.includes('Esc interrupts'), 4000)
    store.actions.pushOverlay({ kind: 'help' })
    await tui.waitFor('ADF keys & commands')
    await esc(tui)
    expect(store.getState().overlays).toHaveLength(0)
    expect(focus()).toBe('input')
  })

  it('a view that uses Esc itself keeps it (a list filter clears before focus moves)', async () => {
    const tui = await mount()
    store.actions.setView('inspect')
    store.actions.setViewState('inspect', { tab: 'logs' })
    store.actions.setFocus('main')
    await tui.waitFor('entries')
    await tui.press('/')
    await tui.type('zz')
    await esc(tui)
    expect(focus()).toBe('main')
    await esc(tui)
    expect(focus()).toBe('tabs')
  })

  it('shows the focused tab distinctly and a click on a tab switches views', async () => {
    const tui = await mount()
    store.actions.setFocus('tabs')
    const frame = await tui.waitFor('←/→ view')
    const row = frame.split('\n')[0]
    expect(row).toContain('2 Files')
    const x = row.indexOf('3 Loops')
    tui.raw(`\u001b[<0;${x + 2};1M`)
    await tui.waitFor(() => view() === 'loops')
    expect(view()).toBe('loops')
  })

  it('the agent label opens the agent switcher: Enter on it in the tab bar, or a click', async () => {
    const tui = await mount()
    store.actions.setView('files')
    store.actions.setFocus('tabs')
    await tui.waitFor('←/→ view')
    await tui.press(KEY.left)
    await tui.press(KEY.left)
    expect(tabsCursorOnAgent(store.getState())).toBe(true)
    // Moving onto the label keeps the view the cursor passed last (Chat).
    expect(view()).toBe('chat')
    // Any view change (digit, click) takes the cursor off the label.
    store.actions.setView('files')
    await tui.waitFor(() => store.getState().viewState['shell.tabs.cursor'] == null)
    store.actions.setFocus('tabs')
    await tui.press(KEY.left)
    await tui.press(KEY.left)
    expect(tabsCursorOnAgent(store.getState())).toBe(true)
    await tui.press(KEY.enter)
    let frame = await tui.waitFor('Switch agent')
    expect(frame).toContain('agent-2')
    expect(frame).not.toContain('/help')
    expect(store.getState().overlays.at(-1)?.props).toEqual({ mode: 'agents' })
    // Picking an agent selects it; the view stays.
    await tui.type('agent-2')
    await tui.press(KEY.enter)
    await tui.waitFor(() => store.getState().overlays.length === 0)
    expect(view()).toBe('chat')
    expect(store.getState().agents[store.getState().selectedAgentId!]?.summary.handle).toBe('agent-2')
    // A click on the label (mouse mode) opens it too.
    frame = await tui.waitFor(f => /agent-2 ›/.test(f.split('\n')[0]))
    const x = frame.split('\n')[0].indexOf('agent-2')
    tui.raw(`\u001b[<0;${x + 2};1M`)
    await tui.waitFor('Switch agent')
  })

  it('Home / End go to the first / last view; Esc onto the bar starts on the view, not the label', async () => {
    const tui = await mount()
    store.actions.setView('loops')
    store.actions.setFocus('tabs')
    await tui.waitFor('←/→ view')
    await tui.press('\u001b[F')
    expect(view()).toBe('runtime')
    await tui.press('\u001b[H')
    expect(view()).toBe('chat')
    expect(tabsCursorOnAgent(store.getState())).toBe(false)
  })
})
