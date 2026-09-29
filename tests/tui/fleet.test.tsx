import React from 'react'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Text } from 'ink'
import { App } from '../../src/main/tui/app/App'
import { createTheme } from '../../src/main/tui/app/theme'
import { DaemonClient } from '../../src/main/tui/api/client'
import { createTuiStore, type TuiStore } from '../../src/main/tui/state/store'
import { transcriptKey } from '../../src/main/tui/state/types'
import fleet from '../../src/main/tui/views/fleet/index'
import type { ViewDefinition } from '../../src/main/tui/views/types'
import { startMockDaemon, AGENT_1_ID, type MockDaemon } from './fixtures/mock-daemon'
import { createFleetFetch, AGENT_3_ID, type FleetMock } from './fixtures/fleet-mock'
import { renderTui, wrapped, type RenderedTui } from './fixtures/render'

const KEY = { tab: '\t', enter: '\r', esc: '\u001b', down: '\u001b[B', up: '\u001b[A', right: '\u001b[C', left: '\u001b[D' }

// Only the fleet view + a stub chat target, so the tests do not depend on
// other features' in-progress views.
const chatStub: ViewDefinition = {
  id: 'chat',
  title: 'Chat',
  key: '2',
  component: () => <Text>CHAT-STUB</Text>,
}

let mock: MockDaemon
let fleetMock: FleetMock
let store: TuiStore
let ui: RenderedTui | null = null
let tmp: string | null = null

beforeEach(async () => {
  mock = await startMockDaemon({ stepMs: 5 })
})

afterEach(async () => {
  ui?.unmount()
  ui = null
  store?.stop()
  await mock.close()
  if (tmp) rmSync(tmp, { recursive: true, force: true })
  tmp = null
})

async function mount(options: Parameters<typeof createFleetFetch>[1] = {}, size: { columns?: number; rows?: number } = {}) {
  fleetMock = createFleetFetch(mock, options)
  store = createTuiStore({ client: new DaemonClient({ baseUrl: mock.url, fetch: fleetMock.fetch }) })
  ui = renderTui(<App store={store} theme={createTheme({ mono: true })} views={[fleet, chatStub]} builtins={[]} />, { columns: 130, rows: 34, ...size })
  await store.start()
  await until(ui, f => f.includes('consolidator') && f.includes('pid 4242'))
  return ui
}

const NL = String.fromCharCode(10)

function until(tui: RenderedTui, test: string | RegExp | ((frame: string) => boolean), timeoutMs = 3000): Promise<string> {
  return tui.waitFor(test instanceof RegExp ? (f: string) => test.test(f) : test, timeoutMs)
}

/** The sidebar column of a frame (left of the divider). */
function sidebarOf(frame: string): string {
  return frame.split(NL).map(line => line.split('│')[0]).join(NL)
}

async function focusSidebar(tui: RenderedTui) {
  // Focus cycles main → prompt → sidebar.
  await tui.press(KEY.tab)
  await tui.press(KEY.tab)
  expect(store.getState().focus).toBe('sidebar')
}

async function typePrompt(tui: RenderedTui, text: string) {
  store.actions.setFocus('input')
  await new Promise(resolve => setTimeout(resolve, 50))
  await tui.type(text)
  await tui.press(KEY.enter)
}

describe('fleet view', () => {
  it('shows the fleet tree with loops, schedules and badges, and the dashboard', async () => {
    const tui = await mount({ unread: { 'agent-2': 2 } })
    const frame = await until(tui, f => f.includes('in 1h') && f.includes('«2'))
    expect(frame).toContain('FLEET')
    // Tree: agents, their loops, the consolidator's next scheduled run.
    expect(frame).toMatch(/↻consolidator\s+in 1h/)
    expect(frame).toContain('↻researcher')
    expect(frame).toContain('!1')
    // Dashboard: headline, daemon summary, table columns and the selected agent's loops.
    expect(frame).toContain('Fleet  2 agents')
    expect(frame).toContain('pid 4242 up 3h12m')
    expect(frame).toContain('providers 1 (1 keyed)')
    expect(frame).toContain('mesh on :7295')
    for (const col of ['AGENT', 'STATE', 'LOOPS', 'HIL', 'MODEL', 'TIMERS']) expect(frame).toContain(col)
    expect(frame).toContain('mock/mock-model')
    expect(frame).toMatch(/every 1h in 1h/)
    expect(frame).toContain('talks to you (owner thread)')
  })

  it('shows a running inner loop with a spinner and counts it as busy', async () => {
    const tui = await mount()
    mock.emit({ event_type: 'agent.state.changed', agent_id: AGENT_1_ID, loop: 'researcher', payload: { state: 'thinking' } })
    const frame = await until(tui, f => f.includes('1 busy') && /↻researcher\s+thinking/.test(f))
    expect(frame).toMatch(/↻ 4 loops \(1 running\)/)
  })

  it('filters the tree by typing and opens a loop chat with Enter', async () => {
    const tui = await mount()
    await focusSidebar(tui)
    await tui.type('res')
    const frame = await until(tui, f => f.includes('› res'))
    expect(sidebarOf(frame)).toContain('↻researcher')
    expect(sidebarOf(frame)).not.toContain('↻consolidator')
    await tui.press(KEY.down)
    await tui.press(KEY.enter)
    await until(tui, 'CHAT-STUB')
    expect(store.getState().activeView).toBe('chat')
    expect(store.getState().selectedLoop[AGENT_1_ID]).toBe('researcher')
    expect(store.getState().focus).toBe('input')
  })

  it('collapses and expands an agent with Left/Right and Space', async () => {
    const tui = await mount()
    await focusSidebar(tui)
    await tui.press(KEY.left)
    let frame = await until(tui, f => !f.includes('↻researcher') || !/↻consolidator\s+in 1h/.test(f))
    // Collapsed agent-1 shows its inner-loop count as a badge.
    expect(frame).toMatch(/agent-1.*↻2/)
    await tui.press(' ')
    frame = await until(tui, f => /↻consolidator\s+in 1h/.test(f))
    expect(frame).toContain('↻researcher')
  })

  it('stops an agent only after confirming, and reports it', async () => {
    const tui = await mount()
    await tui.press('x')
    await until(tui, 'Stop agent')
    await tui.press('n')
    await until(tui, 'Kept agent-1 running')
    expect(fleetMock.calls.some(c => c.startsWith('POST /agents/') && c.endsWith('/stop'))).toBe(false)
    await tui.press('x')
    await until(tui, 'Stop agent')
    await tui.press('y')
    await until(tui, 'Stopped and unloaded agent-1')
    expect(fleetMock.calls).toContain(`POST /agents/${AGENT_1_ID}/stop`)
    const notices = store.getState().transcripts[transcriptKey(AGENT_1_ID, 'main')]?.items.filter(i => i.kind === 'notice') ?? []
    expect(notices.map(n => n.kind === 'notice' ? n.text : '')).toContain('Stopped and unloaded agent-1')
  })

  it('starts an agent and interrupts only the loop that is running', async () => {
    const tui = await mount()
    await tui.press('s')
    await until(tui, 'Started agent-1')
    mock.emit({ event_type: 'agent.state.changed', agent_id: AGENT_1_ID, loop: 'consolidator', payload: { state: 'tool_use' } })
    await until(tui, '1 busy')
    await tui.press('a')
    await until(tui, f => f.includes('Interrupt turn') && f.includes('consolidator? Work'))
    await tui.press('y')
    await until(tui, 'Turn interrupted by you (agent-1 consolidator)')
    expect(fleetMock.calls).toContain(`POST /agents/${AGENT_1_ID}/interrupt?loop=consolidator`)
    expect(fleetMock.calls.some(c => c.includes('/abort'))).toBe(false)
    const items = store.getState().transcripts[transcriptKey(AGENT_1_ID, 'consolidator')]?.items ?? []
    expect(items.some(i => i.kind === 'notice' && i.text.includes('Turn interrupted'))).toBe(true)
  })

  it('cycles the selected loop with Left/Right on the dashboard and opens it with Enter', async () => {
    const tui = await mount()
    await tui.press(KEY.right)
    await until(tui, f => /› ○ ↻consolidator/.test(f))
    expect(store.getState().selectedLoop[AGENT_1_ID]).toBe('consolidator')
    await tui.press(KEY.enter)
    await until(tui, 'CHAT-STUB')
    expect(store.getState().selectedLoop[AGENT_1_ID]).toBe('consolidator')
  })

  it('loads an .adf from the dialog with Tab completion', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'adf-fleet-'))
    mkdirSync(join(tmp, 'agents'))
    writeFileSync(join(tmp, 'agents', 'agent-3.adf'), '')
    const tui = await mount()
    await tui.press('o')
    await until(tui, 'Load agent file')
    // Replace the prefilled directory with the temp dir, then complete.
    await tui.press('\u0015')
    await tui.type(`${tmp}${sep}ag`)
    await tui.press(KEY.tab)
    await until(tui, wrapped(`agents${sep}`))
    await tui.press(KEY.tab)
    await until(tui, wrapped('agent-3.adf'))
    await tui.press('\u0013')
    await until(tui, 'start on')
    await tui.press(KEY.enter)
    await until(tui, 'Loaded agent-3')
    await until(tui, 'Started agent-3')
    expect(fleetMock.calls).toContain('POST /agents/load')
    expect(store.getState().selectedAgentId).toBe(AGENT_3_ID)
    await until(tui, f => f.includes('Fleet  3 agents'))
  }, 10000)

  it('asks before accepting a review when loading with --review', async () => {
    const file = join(tmpdir(), 'agent-3.adf')
    const tui = await mount({ unreviewed: [file] })
    await typePrompt(tui, `/load ${file} --review`)
    await until(tui, 'Review required')
    await tui.press('y')
    await until(tui, 'Loaded agent-3')
    expect(fleetMock.reviewed.has(file)).toBe(true)
    expect(fleetMock.calls.filter(c => c === 'POST /agents/load').length).toBe(2)
  }, 10000)

  it('switches to an agent loop with /switch (fuzzy) and runs autostart from tracked directories', async () => {
    const tui = await mount({ trackedDirectories: ['/agents'] })
    await typePrompt(tui, '/switch ag1/consolidator')
    await until(tui, 'CHAT-STUB')
    expect(store.getState().selectedAgentId).toBe(AGENT_1_ID)
    expect(store.getState().selectedLoop[AGENT_1_ID]).toBe('consolidator')

    store.actions.setView('fleet')
    await typePrompt(tui, '/switch agent-1/nope')
    await until(tui, 'has no loop "nope"')

    await typePrompt(tui, '/autostart')
    await until(tui, 'Autostart')
    await tui.press('y')
    await until(tui, 'Autostart: scanned 2, started 0')
  }, 15000)

  it('drops low-priority columns in a narrow terminal', async () => {
    const tui = await mount({}, { columns: 80, rows: 24 })
    const frame = tui.lastFrame()
    expect(frame).toContain('AGENT')
    expect(frame).not.toContain('MESH')
  })
})

void React
