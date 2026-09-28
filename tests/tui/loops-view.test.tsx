import React from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { App } from '../../src/main/tui/app/App'
import { createTheme } from '../../src/main/tui/app/theme'
import { DaemonClient } from '../../src/main/tui/api/client'
import { createTuiStore, type TuiStore } from '../../src/main/tui/state/store'
import { AGENT_1_ID, startMockDaemon, type MockDaemon } from './fixtures/mock-daemon'
import { createLoopsMock, type LoopsMock } from './fixtures/loops-daemon'
import { renderTui, type RenderedTui } from './fixtures/render'

const KEY = { tab: '\t', enter: '\r', esc: '\u001b', down: '\u001b[B', up: '\u001b[A', right: '\u001b[C', left: '\u001b[D', ctrlS: '\u0013' }

let mock: MockDaemon
let loops: LoopsMock
let store: TuiStore
let ui: RenderedTui | null = null

beforeEach(async () => {
  mock = await startMockDaemon({ stepMs: 5 })
  loops = createLoopsMock(mock)
  store = createTuiStore({ client: new DaemonClient({ baseUrl: mock.url, fetch: loops.fetch }), initialView: 'loops' })
})

afterEach(async () => {
  ui?.unmount()
  ui = null
  store.stop()
  await mock.close()
})

async function mount() {
  ui = renderTui(<App store={store} theme={createTheme({ mono: true })} />, { columns: 140, rows: 40 })
  await store.start()
  store.actions.selectAgent(AGENT_1_ID)
  await ui.waitFor(f => f.includes('Loops of agent-1') && f.includes('every 1h'))
  return ui
}

const agent1 = () => mock.agents.get(AGENT_1_ID)!

/** Focus the prompt and let it re-render before keys arrive. */
async function focusPrompt() {
  store.actions.setFocus('input')
  await new Promise(resolve => setTimeout(resolve, 60))
}

async function typeText(tui: RenderedTui, text: string) {
  for (const ch of text) await tui.press(ch)
}

describe('loops manager', () => {
  it('lists main and inner loops with status, tools, model, flags and what wakes them', async () => {
    const tui = await mount()
    const frame = await tui.waitFor(f => f.includes('researcher') && f.includes('on_timer'))
    expect(frame).toMatch(/main\s+idle/)
    expect(frame).toMatch(/consolidator\s+idle\s+2\s+5/)
    expect(frame).toContain('every 1h in 1h')
    expect(frame).toContain('WAKES ON')
    expect(frame).toContain('[Loops]')
    // main is selected: its detail pane shows the host model and the triggers that wake it.
    expect(frame).toContain('mock / mock-model')
    await tui.press(KEY.down)
    const detail = await tui.waitFor('Consolidate memories into mind.md')
    expect(detail).toMatch(/timers\s+#1 every 1h/)
    expect(store.getState().selectedLoop[AGENT_1_ID]).toBe('consolidator')
  })

  it('creates a loop from the consolidator template with a daily schedule in one confirmed action', async () => {
    const tui = await mount()
    await tui.press('n')
    await tui.waitFor('Memory consolidator')
    await tui.press(KEY.enter)
    const form = await tui.waitFor('Template: Memory consolidator')
    expect(form).toContain('consolidator-2')
    expect(form).toContain('Schedule: daily at 03:00')
    await tui.press(KEY.ctrlS)
    const review = await tui.waitFor('review')
    expect(review).toContain('Create inner loop consolidator-2')
    expect(review).toMatch(/Tools\s+loop_send, loop_list, sys_set_state, fs_read, fs_list, fs_write/)
    expect(agent1().loops.map(l => l.name)).not.toContain('consolidator-2')
    await tui.press('y')
    const done = await tui.waitFor('Timer #2 scheduled')
    expect(done).toContain('Loop consolidator-2 created')
    expect(done).toContain('Effective tools: loop_send')
    expect(agent1().loops.map(l => l.name)).toContain('consolidator-2')
    const timer = agent1().timers.find(t => t.id === 2)!
    expect(timer.loop).toBe('consolidator-2')
    expect(timer.schedule).toMatchObject({ mode: 'cron', cron: '0 3 * * *' })
    await tui.press(KEY.enter)
    await tui.waitFor(f => !f.includes('done') && f.includes('consolidator-2'))
  }, 15000)

  it('goes back to the templates on Esc and asks before dropping edits', async () => {
    const tui = await mount()
    await tui.press('n')
    await tui.waitFor('Memory consolidator')
    await tui.press(KEY.enter)
    await tui.waitFor('Template: Memory consolidator')
    // Untouched form: Esc steps back to the template picker, not out of the wizard.
    await tui.press(KEY.esc)
    await tui.waitFor(f => f.includes('Pick a starting point') && !f.includes('Template: Memory consolidator'))
    await tui.press(KEY.enter)
    await tui.waitFor('Template: Memory consolidator')
    await typeText(tui, ' tonight')
    await tui.press(KEY.esc)
    await tui.waitFor('Discard your edits and go back to the templates?')
    await tui.press('n')
    await tui.waitFor(f => !f.includes('Discard your edits'))
    expect(tui.lastFrame()).toContain('Template: Memory consolidator')
    await tui.press(KEY.esc)
    await tui.waitFor('Discard your edits')
    await tui.press('y')
    await tui.waitFor(f => f.includes('Pick a starting point') && !f.includes('Template: Memory consolidator'))
    expect(store.getState().overlays).toHaveLength(1)
  }, 15000)

  it('validates the loop name before review', async () => {
    const tui = await mount()
    await tui.press('n')
    await tui.waitFor('Blank loop')
    for (let i = 0; i < 4; i++) await tui.press(KEY.down)
    await tui.press(KEY.enter)
    await tui.waitFor('Template: Blank loop')
    await typeText(tui, 'Bad Name')
    await tui.press(KEY.ctrlS)
    const frame = await tui.waitFor('lowercase letters')
    expect(frame).toContain('Goal is required')
    expect(frame).not.toContain('Create inner loop')
    await tui.press(KEY.esc)
  }, 15000)

  it('edits a loop with a diff and confirm', async () => {
    const tui = await mount()
    await tui.press(KEY.down)
    await tui.press(KEY.down)
    await tui.waitFor(() => store.getState().selectedLoop[AGENT_1_ID] === 'researcher')
    await tui.press('e')
    await tui.waitFor('Edit loop researcher')
    await typeText(tui, ' Cite sources.')
    await tui.press(KEY.ctrlS)
    const review = await tui.waitFor('review')
    expect(review).toContain('- Research whatever main hands over and report back.')
    expect(review).toContain('+ Research whatever main hands over and report back. Cite sources.')
    await tui.press('y')
    await tui.waitFor('Loop researcher updated: goal')
    expect(agent1().loops.find(l => l.name === 'researcher')?.goal).toBe('Research whatever main hands over and report back. Cite sources.')
  }, 15000)

  it('disables and deletes a loop, confirming the delete and reporting the archive', async () => {
    const tui = await mount()
    await tui.press(KEY.down)
    await tui.waitFor(() => store.getState().selectedLoop[AGENT_1_ID] === 'consolidator')
    await tui.press('x')
    await tui.waitFor('Loop consolidator disabled')
    await tui.waitFor(f => /consolidator\s+off/.test(f))
    await tui.press('d')
    await tui.waitFor('Delete loop')
    const confirm = store.getState().overlays.at(-1)?.props?.message as string
    expect(confirm).toContain('2 history entries are archived to the audit log (adf_audit, source loop:consolidator)')
    await tui.press('y')
    await tui.waitFor('2 entries archived')
    expect(agent1().loops.map(l => l.name)).not.toContain('consolidator')
    expect(store.getState().selectedLoop[AGENT_1_ID] ?? 'main').toBe('main')
  }, 15000)

  it('sends a one-off message to a loop without leaving the view', async () => {
    const tui = await mount()
    await tui.press(KEY.down)
    await tui.press(KEY.down)
    await tui.waitFor(() => store.getState().selectedLoop[AGENT_1_ID] === 'researcher')
    await tui.press('s')
    await tui.waitFor('Send to researcher')
    await typeText(tui, 'look into pricing')
    await tui.press(KEY.enter)
    await tui.waitFor('turn queued')
    expect(agent1().history.researcher.some(r => r.content_json[0].text === 'look into pricing')).toBe(true)
    expect(store.getState().activeView).toBe('loops')
  }, 15000)

  it('lists, edits, creates and deletes timers; fleet mode shows every agent', async () => {
    const tui = await mount()
    await tui.press(KEY.right)
    let frame = await tui.waitFor('Timers of agent-1')
    expect(frame).toMatch(/#1\s+consolidator\s+every 1h/)

    await tui.press('e')
    await tui.waitFor('Edit timer #1')
    for (let i = 0; i < 3; i++) await tui.press('\u007f')
    await typeText(tui, '30m')
    frame = await tui.waitFor('Preview: every 30m')
    expect(frame).toContain('wakes consolidator')
    await tui.press(KEY.ctrlS)
    await tui.waitFor('review')
    await tui.press('y')
    await tui.waitFor('Timer #1 updated: every 30m')
    expect(agent1().timers[0].schedule).toMatchObject({ mode: 'interval', every_ms: 1_800_000 })
    await tui.press(KEY.enter)

    await tui.press('n')
    await tui.waitFor('New timer')
    await tui.press(KEY.right) // target loop: main → consolidator
    await tui.press(KEY.ctrlS)
    await tui.waitFor('review')
    await tui.press('y')
    await tui.waitFor('Timer #2 created')
    expect(agent1().timers.find(t => t.id === 2)?.loop).toBe('consolidator')
    await tui.press(KEY.enter)

    await tui.press('f')
    frame = await tui.waitFor('Upcoming')
    expect(frame).toContain('AGENT')
    await tui.press('f')
    await tui.waitFor('Timers of agent-1')
    await tui.press('d')
    await tui.waitFor('Delete timer #')
    await tui.press('y')
    await tui.waitFor(f => /Timer #\d deleted/.test(f))
    expect(agent1().timers.length).toBe(1)
  }, 20000)

  it('toggles a trigger through a config diff and shows each target\'s loop', async () => {
    const tui = await mount()
    await tui.press(KEY.right)
    await tui.press(KEY.right)
    let frame = await tui.waitFor('Triggers of agent-1')
    expect(frame).toMatch(/on_timer\s+on\s+on 2t\s+→ main, consolidator/)
    expect(frame).toMatch(/on_inbox\s+off\s+off 1t\s+→ researcher/)
    // on_startup, on_inbox, on_outbox, on_file_change, on_chat, on_timer
    for (let i = 0; i < 5; i++) await tui.press(KEY.down)
    frame = await tui.waitFor('2. agent · loop consolidator')
    await tui.press('x')
    frame = await tui.waitFor('Disable on_timer')
    expect(frame).toContain('-     "enabled": true')
    expect(frame).toContain('+     "enabled": false')
    await tui.press('y')
    await tui.waitFor('on_timer saved (disabled, 2 targets)')
    expect(loops.calls.some(c => c.startsWith('PUT /agents/'))).toBe(true)
    const saved = loops.configs.get(AGENT_1_ID) as { triggers: Record<string, { enabled: boolean }> }
    expect(saved.triggers.on_timer.enabled).toBe(false)
    expect(saved.triggers.on_chat.enabled).toBe(true)
  }, 15000)

  it('browses a loop\'s history and opens an entry', async () => {
    const tui = await mount()
    await tui.press(KEY.down)
    await tui.waitFor(() => store.getState().selectedLoop[AGENT_1_ID] === 'consolidator')
    await tui.press('h')
    let frame = await tui.waitFor('History of agent-1')
    expect(frame).toContain('consolidator')
    expect(frame).toContain('rows 1-2 of 2')
    expect(frame).toContain('Merged 3 notes into mind.md.')
    await tui.press(KEY.enter)
    frame = await tui.waitFor('entry #')
    expect(frame).toContain('[1] text')
    await tui.press(KEY.esc)
    await tui.press('f')
    await tui.waitFor('show user')
  }, 15000)

  it('runs the loops slash commands', async () => {
    const tui = await mount()
    await tui.press(KEY.tab)
    await typeText(tui, '/timer add --loop researcher')
    await tui.press(KEY.enter)
    const frame = await tui.waitFor('New timer')
    expect(frame).toMatch(/Target loop\s+researcher/)
    await tui.press(KEY.esc)
    await tui.waitFor(f => !f.includes('New timer'))
    await focusPrompt()
    await typeText(tui, '/history consolidator')
    await tui.press(KEY.enter)
    await tui.waitFor('History of agent-1 › consolidator')
    await focusPrompt()
    await typeText(tui, '/loop new researcher')
    await tui.press(KEY.enter)
    const wizard = await tui.waitFor('Template: Researcher')
    expect(wizard).toContain('researcher-2')
    await tui.press(KEY.esc)
  }, 15000)
})
