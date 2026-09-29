// The header groups the views: the selected agent's (1 Chat 2 Files 3 Loops
// 4 Inspect) after its agent › loop label, a quiet separator, then the app's
// (5 Fleet 6 Runtime). Digits and Alt+digits follow the new numbers.

import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { App } from '../../src/main/tui/app/App'
import { createTheme } from '../../src/main/tui/app/theme'
import { agentLabelMin, agentLabelText, headerLayout, tabOrder } from '../../src/main/tui/app/Header'
import { DaemonClient } from '../../src/main/tui/api/client'
import { createTuiStore, type TuiStore } from '../../src/main/tui/state/store'
import { VIEWS } from '../../src/main/tui/views/registry'
import { AGENT_1_ID, startMockDaemon, type MockDaemon } from './fixtures/mock-daemon'
import { renderTui, type RenderedTui } from './fixtures/render'

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
})

async function mount(columns: number, rows: number, theme = createTheme({ mono: true })) {
  mock = await startMockDaemon({ stepMs: 5 })
  store = createTuiStore({ client: new DaemonClient({ baseUrl: mock.url }) })
  ui = renderTui(<App store={store} theme={theme} />, { columns, rows })
  await store.start()
  await ui.waitFor(f => f.includes('agent-1') && f.includes('live'))
  return ui
}

const header = (frame: string) => frame.split('\n')[0]

describe('header groups (pure)', () => {
  it('orders the agent views first, then the app views', () => {
    const order = tabOrder(VIEWS)
    expect(order.grouped).toBe(true)
    expect(order.all.map(v => `${v.key} ${v.title}`)).toEqual(['1 Chat', '2 Files', '3 Loops', '4 Inspect', '5 Fleet', '6 Runtime'])
    // Views without groups (tests, embedders): no label, their own order.
    expect(tabOrder(VIEWS.map(v => ({ ...v, group: undefined }))).grouped).toBe(false)
  })

  it('fits the agent label: the loop shortens first, then the name; never below the minimum', () => {
    expect(agentLabelText('agent-1', null, 40, '›')).toBe(' agent-1 ›')
    expect(agentLabelText('agent-1', 'researcher', 40, '›')).toBe(' agent-1 › researcher')
    expect(agentLabelText('agent-1', 'researcher', 16, '›')).toBe(' agent-1 › rese…')
    expect(agentLabelText('agent-1', 'researcher', 12, '›')).toBe(' agent-1 ›')
    expect(agentLabelText('a-very-long-agent-name', null, 12, '›', '...')).toBe(' a-very... ›')
    expect(agentLabelText(null, null, 40, '›')).toBe(' no agent')
    expect(agentLabelMin('a-very-long-agent-name', '›')).toBe(11)
  })

  it('at 80 columns the pending badge goes bare before tab names become digits', () => {
    const titles = tabOrder(VIEWS).all.map(v => v.title)
    const fit = headerLayout(80, titles, { full: '!1 pending  ● live'.length, compact: '!1 pending  ● live'.length, minimal: '!1  ● live'.length }, '127.0.0.1:7385', 0, agentLabelMin('agent-1', '›'))
    expect(fit).toMatchObject({ tabs: 'short', minimal: true })
    const quiet = headerLayout(80, titles, '● live'.length, '127.0.0.1:7385', 0, agentLabelMin('agent-1', '›'))
    expect(quiet).toMatchObject({ tabs: 'short', minimal: false })
  })
})

describe('header render', () => {
  it('120 columns: agent › views | app views, then the badges', async () => {
    const tui = await mount(120, 34)
    store!.actions.selectAgent(AGENT_1_ID)
    const row = header(await tui.waitFor(f => header(f).includes('agent-1 ›')))
    expect(row).toMatch(/^ ◆ ADF  agent-1 ›  1 Chat   2 Files   3 Loops   4 Inspect │ 5 Fleet   6 Runtime\s+.*!1 pending {2}● live/)
  })

  it('120 columns with an inner loop selected: agent › loop', async () => {
    const tui = await mount(120, 34)
    store!.actions.selectAgent(AGENT_1_ID)
    store!.actions.selectLoop(AGENT_1_ID, 'researcher')
    // The whole label outlasts the web badge.
    const row = header(await tui.waitFor(f => header(f).includes('researcher')))
    expect(row).toMatch(/ADF {2}agent-1 › researcher {2}1 Chat /)
    expect(row).not.toContain('web :')
  })

  it('no agent selected: a dim "no agent" and the views say to select one', async () => {
    const tui = await mount(120, 34)
    store!.actions.selectAgent(null)
    store!.actions.setView('files')
    const frame = await tui.waitFor(f => header(f).includes('no agent'))
    expect(header(frame)).toMatch(/ADF {2}no agent {2}1 Chat /)
    expect(frame).toContain('Select an agent')
  })

  it('80 columns: the label and the separator stay; names shorten', async () => {
    const tui = await mount(80, 24)
    store!.actions.selectAgent(AGENT_1_ID)
    store!.actions.selectLoop(AGENT_1_ID, 'consolidator')
    const row = header(await tui.waitFor(f => header(f).includes('agent-1')))
    expect(row).toMatch(/agent-1 ›.* 1 Chat .*4 Insp │ 5 Flt +6 Rt /)
    expect(row).toContain('● live')
    expect(row.length).toBeLessThanOrEqual(80)
  })

  it('80 columns without an agent', async () => {
    const tui = await mount(80, 24)
    store!.actions.selectAgent(null)
    const row = header(await tui.waitFor(f => header(f).includes('no agent')))
    expect(row).toMatch(/no agent {2}1 Chat .*│ 5 Flt/)
  })

  it('ASCII: the separator and pointer fall back', async () => {
    const tui = await mount(120, 34, createTheme({ mono: true, ascii: true }))
    store!.actions.selectAgent(AGENT_1_ID)
    const row = header(await tui.waitFor(f => header(f).includes('agent-1')))
    expect(row).toMatch(/agent-1 > {2}1 Chat .*4 Inspect \| 5 Fleet/)
    expect(row).toMatch(/^[ -~]*$/)
  })
})

describe('view hotkeys', () => {
  it('digits and Alt+digits follow the new numbers', async () => {
    const tui = await mount(120, 34)
    store!.actions.selectAgent(AGENT_1_ID)
    store!.actions.setView('fleet')
    store!.actions.setFocus('main')
    const expected = ['chat', 'files', 'loops', 'inspect', 'fleet', 'runtime']
    for (const [i, id] of expected.entries()) {
      store!.actions.setFocus('main')
      await tui.press(String(i + 1))
      await tui.waitFor(() => store!.getState().activeView === id)
    }
    // Alt+digit works from the prompt too.
    store!.actions.setView('chat')
    await tui.waitFor(() => store!.getState().focus === 'input')
    await tui.press('\u001b4')
    await tui.waitFor(() => store!.getState().activeView === 'inspect')
    await tui.press('\u001b5')
    await tui.waitFor(() => store!.getState().activeView === 'fleet')
  })
})

void React
