// Tracked agents that are not loaded show in the sidebar and the Fleet next
// to the running ones (dimmed, under their folder), like Studio's sidebar:
// s / Enter starts one (review first when it needs it), Chat / Files show a
// "stopped" panel instead of errors, and H / `/agents running` hides them.

import React from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { App } from '../../src/main/tui/app/App'
import { createTheme } from '../../src/main/tui/app/theme'
import { resetPrefs } from '../../src/main/tui/app/prefs'
import { DaemonClient } from '../../src/main/tui/api/client'
import { createTuiStore, type TuiStore } from '../../src/main/tui/state/store'
import { isTrackedKey, trackedKey } from '../../src/main/tui/state/tracked'
import fleet from '../../src/main/tui/views/fleet/index'
import chat from '../../src/main/tui/views/chat/index'
import files from '../../src/main/tui/views/files/index'
import { MOCK_AGENTS_DIR, startMockDaemon, type MockDaemon } from './fixtures/mock-daemon'
import { renderTui, type RenderedTui } from './fixtures/render'

const KEY = { enter: '\r', esc: '\u001b', down: '\u001b[B', up: '\u001b[A', end: '\u001b[F' }
const LAB = '/home/owner/lab'

let mock: MockDaemon
let store: TuiStore
let ui: RenderedTui | null = null

beforeEach(async () => {
  resetPrefs()
  mock = await startMockDaemon({ stepMs: 5, trackedDirs: [MOCK_AGENTS_DIR, LAB], existingDirs: [LAB] })
  mock.folderFiles.push(
    { filePath: `${LAB}/agent-3.adf`, name: 'agent-3', autostart: true, reviewed: true },
    { filePath: `${LAB}/agent-4.adf`, name: 'agent-4', autostart: true, reviewed: false },
    { filePath: `${LAB}/agent-5.adf`, name: 'agent-5', autostart: false, reviewed: true, loadError: 'Provider "anthropic" not found.' },
  )
})

afterEach(async () => {
  ui?.unmount()
  ui = null
  store?.stop()
  await mock.close()
  resetPrefs()
})

async function mount(columns = 120, rows = 34) {
  store = createTuiStore({ client: new DaemonClient({ baseUrl: mock.url }) })
  ui = renderTui(<App store={store} theme={createTheme({ mono: true })} views={[fleet, chat, files]} builtins={[]} />, { columns, rows })
  await store.start()
  await ui.waitFor(f => f.includes('agent-1') && f.includes('agent-3'))
  return ui
}

const names = () => Object.values(store.getState().agents).map(a => a.summary.name).sort()

describe('stopped tracked agents', () => {
  it('lists every tracked agent: loaded first, then each folder’s stopped ones, dimmed with their state', async () => {
    const tui = await mount()
    const frame = await tui.waitFor(f => f.includes('agent-5'))
    // Only the folder that has stopped agents gets a header (with loaded/total).
    expect(frame).toMatch(/lab\s+0\/3/)
    expect(frame).toMatch(/agent-3 stopped/)
    expect(frame).toMatch(/agent-4 needs review/)
    // The table: loaded agents, then the stopped ones with their state.
    expect(frame).toMatch(/agent-3\s+stopped/)
    expect(frame).toMatch(/agent-4\s+needs review/)
    expect(frame).toContain('2 agents running · 3 stopped')
    expect(store.getState().tracked?.stopped.map(t => t.agent.name)).toEqual(['agent-3', 'agent-4', 'agent-5'])
  })

  it('s on a stopped agent loads + starts it and selects it; a failed load shows its error', async () => {
    const tui = await mount()
    store.actions.selectAgent(trackedKey(`${LAB}/agent-3.adf`))
    let frame = await tui.waitFor('s (or Enter) loads it')
    expect(frame).toContain(`${LAB}/agent-3.adf`)
    await tui.press('s')
    await tui.waitFor(() => names().includes('agent-3'))
    await tui.waitFor(() => store.getState().selectedAgentId === 'mock-agent-3')
    frame = await tui.waitFor(f => /Loaded agent-3 and started it/.test(f))
    expect(store.getState().tracked?.stopped.map(t => t.agent.name)).toEqual(['agent-4', 'agent-5'])

    store.actions.selectAgent(trackedKey(`${LAB}/agent-5.adf`))
    await tui.waitFor(f => f.includes('agent-5') && f.includes('autostart off'))
    await tui.press('s')
    frame = await tui.waitFor(f => /agent-5\s+load error/.test(f))
    expect(frame).toContain('Provider "anthropic" not found.')
    expect(names()).not.toContain('agent-5')
  })

  it('s on an agent that needs review opens its review; y accepts, loads and starts it', async () => {
    const tui = await mount()
    store.actions.selectAgent(trackedKey(`${LAB}/agent-4.adf`))
    await tui.waitFor('s reviews it')
    await tui.press('s')
    const frame = await tui.waitFor(f => f.includes('Review agent-4') && f.includes('compute_exec'))
    expect(frame).toContain('host access')
    await tui.press('y')
    await tui.waitFor(() => names().includes('agent-4'))
    expect(mock.folderFiles.find(f => f.name === 'agent-4')?.reviewed).toBe(true)
  })

  it('Chat and Files show a stopped panel; the sidebar Enter starts it; a message starts it and is sent', async () => {
    const tui = await mount()
    const key = trackedKey(`${LAB}/agent-3.adf`)
    store.actions.selectAgent(key)
    store.actions.setView('files')
    let frame = await tui.waitFor('no document, mind or files to show yet')
    expect(frame).toContain('agent-3')
    store.actions.setView('chat')
    frame = await tui.waitFor('no conversation to show yet')
    expect(frame).toContain('a message starts it')
    expect(frame).toMatch(/agent-3\s+○ stopped|agent-3\s+o stopped/)
    await tui.type('hello there')
    await tui.press(KEY.enter)
    await tui.waitFor(() => names().includes('agent-3'))
    await tui.waitFor(() => (mock.agents.get('mock-agent-3')?.history.main ?? []).length > 0)
    expect(isTrackedKey(store.getState().selectedAgentId)).toBe(false)
  })

  it('the sidebar lists them under their folder; Enter on one starts it', async () => {
    const tui = await mount()
    store.actions.setFocus('sidebar')
    await new Promise(resolve => setTimeout(resolve, 50))
    await tui.press(KEY.end)
    await tui.waitFor(() => store.getState().selectedAgentId === trackedKey(`${LAB}/agent-5.adf`))
    await tui.press(KEY.up)
    await tui.press(KEY.up)
    await tui.waitFor(() => store.getState().selectedAgentId === trackedKey(`${LAB}/agent-3.adf`))
    // Up again steps over the folder header onto the last loaded row.
    await tui.press(KEY.up)
    await tui.waitFor(() => !isTrackedKey(store.getState().selectedAgentId))
    await tui.press(KEY.down)
    await tui.waitFor(() => store.getState().selectedAgentId === trackedKey(`${LAB}/agent-3.adf`))
    await tui.press(KEY.enter)
    await tui.waitFor(() => store.getState().selectedAgentId === 'mock-agent-3')
  })

  it('H hides stopped agents (remembered as a pref); /agents all shows them again', async () => {
    const tui = await mount()
    store.actions.setFocus('main')
    await tui.press('H')
    let frame = await tui.waitFor(f => !f.includes('agent-4'))
    expect(frame).toContain('3 stopped (hidden)')
    await tui.press('/')
    await tui.type('agents all')
    await tui.press(KEY.enter)
    frame = await tui.waitFor(f => f.includes('agent-4'))
    expect(frame).toContain('3 stopped')
  })

  it('an agent stopped from the TUI stays selected as a stopped agent', async () => {
    mock.folderFiles.push({ filePath: `${LAB}/agent-6.adf`, name: 'agent-6', autostart: false, reviewed: true })
    const tui = await mount()
    store.actions.selectAgent(trackedKey(`${LAB}/agent-6.adf`))
    await tui.waitFor('s (or Enter) loads it')
    await tui.press('s')
    await tui.waitFor(() => store.getState().selectedAgentId === 'mock-agent-6')
    // Unloaded elsewhere (Studio, CLI): it comes back as a stopped entry, still selected.
    mock.agents.delete('mock-agent-6')
    mock.emit({ event_type: 'agent.unloaded', agent_id: 'mock-agent-6' })
    await tui.waitFor(() => store.getState().selectedAgentId === trackedKey(`${LAB}/agent-6.adf`), 5000)
    await tui.waitFor('s (or Enter) loads it')
  }, 15_000)

  it('fits 80x24 (sidebar collapsed below 70 columns is not an issue; the table keeps the stopped rows)', async () => {
    const tui = await mount(80, 24)
    const frame = await tui.waitFor(f => f.includes('agent-5'))
    for (const line of frame.split('\n')) expect(line.length).toBeLessThanOrEqual(80)
    expect(frame).toMatch(/agent-4\s+needs review/)
  })
})
