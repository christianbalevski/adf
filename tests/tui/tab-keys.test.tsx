// One key model for the tabbed views (Files, Loops, Inspect, Runtime):
// ←/→ switch the view's tabs from its lists ([ ] still work, unlisted);
// Enter opens a list item's detail, Backspace or Esc go back one level; in a
// filter box Backspace edits the text and ←/→ stay put.

import React from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { App } from '../../src/main/tui/app/App'
import { createTheme } from '../../src/main/tui/app/theme'
import { DaemonClient } from '../../src/main/tui/api/client'
import { createTuiStore, type TuiStore } from '../../src/main/tui/state/store'
import { readInspectState } from '../../src/main/tui/views/inspect/state'
import { AGENT_1_ID, startMockDaemon, type MockDaemon } from './fixtures/mock-daemon'
import { renderTui, type RenderedTui } from './fixtures/render'

const KEY = { enter: '\r', esc: '\u001b', left: '\u001b[D', right: '\u001b[C', backspace: '\u007f', down: '\u001b[B' }

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

async function mount(view: string) {
  ui = renderTui(<App store={store} theme={createTheme({ mono: true })} />, { columns: 130, rows: 34 })
  await store.start()
  await ui.waitFor(f => f.includes('agent-1') && f.includes('live'))
  store.actions.selectAgent(AGENT_1_ID)
  store.actions.setView(view)
  store.actions.setFocus('main')
  return ui
}

const esc = async (tui: RenderedTui) => { await tui.press(KEY.esc); await new Promise(r => setTimeout(r, 30)) }
const loopsTab = () => (store.getState().viewState.loops as { tab?: string } | undefined)?.tab ?? 'loops'
const runtimeTab = () => (store.getState().viewState.runtime as { tab?: string } | undefined)?.tab ?? 'status'

describe('←/→ switch the tabs of every tabbed view', () => {
  it('Loops', async () => {
    const tui = await mount('loops')
    await tui.waitFor('Loops of agent-1')
    await tui.press(KEY.right)
    await tui.waitFor(() => loopsTab() === 'timers')
    await tui.press(KEY.left)
    await tui.waitFor(() => loopsTab() === 'loops')
    await tui.press(KEY.left)
    await tui.waitFor(() => loopsTab() === 'history')
  })

  it('Inspect, and not while typing a list filter', async () => {
    const tui = await mount('inspect')
    await tui.waitFor('Identities')
    await tui.press(KEY.right)
    await tui.waitFor(() => readInspectState(store.getState()).tab === 'settings')
    await tui.press(KEY.left)
    await tui.waitFor(() => readInspectState(store.getState()).tab === 'diag')
    store.actions.setViewState('inspect', { ...readInspectState(store.getState()), tab: 'logs' })
    await tui.waitFor('entries')
    await tui.press('/')
    await tui.type('abc')
    await tui.waitFor('/abc')
    await tui.press(KEY.right)
    await tui.press(KEY.backspace)
    await tui.waitFor(f => /\/ab\b/.test(f) && !f.includes('/abc'))
    expect(readInspectState(store.getState()).tab).toBe('logs')
    expect(store.getState().focus).toBe('main')
  })

  it('Runtime', async () => {
    const tui = await mount('runtime')
    await tui.waitFor('Folders')
    await tui.press(KEY.right)
    await tui.waitFor(() => runtimeTab() === 'folders')
    await tui.press(KEY.left)
    await tui.waitFor(() => runtimeTab() === 'status')
  })
})

describe('Enter opens, Backspace / Esc go back', () => {
  it('Inspect › Events: the detail closes with Backspace, and with Esc before the tab bar', async () => {
    const tui = await mount('inspect')
    store.actions.setViewState('inspect', { ...readInspectState(store.getState()), tab: 'events' })
    for (let i = 0; i < 3; i++) mock.emit({ event_type: 'tool.started', agent_id: AGENT_1_ID, payload: { name: `probe_${i}` } })
    await tui.waitFor('probe_2')
    const detail = (f: string) => f.includes('"event_type": "tool.started"') || f.includes('event_type')
    await tui.press(KEY.enter)
    await tui.waitFor(detail)
    await tui.press(KEY.backspace)
    await tui.waitFor(f => !detail(f))
    await tui.press(KEY.enter)
    await tui.waitFor(detail)
    await esc(tui)
    await tui.waitFor(f => !detail(f))
    expect(store.getState().focus).toBe('main')
    await esc(tui)
    expect(store.getState().focus).toBe('tabs')
  })

  it('Loops › History: Enter opens an entry, Backspace closes it', async () => {
    const tui = await mount('loops')
    store.actions.setViewState('loops', { tab: 'history' })
    await tui.waitFor('History of agent-1')
    await tui.waitFor(f => /\d+\s+\d\d:\d\d/.test(f) || f.includes('user'))
    await tui.press(KEY.enter)
    await tui.waitFor('entry #')
    await tui.press(KEY.backspace)
    await tui.waitFor(f => !f.includes('entry #'))
    expect(store.getState().overlays).toHaveLength(0)
    expect(loopsTab()).toBe('history')
  })
})

void React
