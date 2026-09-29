import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/main/tui/app/App'
import { createTheme } from '../../src/main/tui/app/theme'
import { DaemonClient } from '../../src/main/tui/api/client'
import { createTuiStore, type TuiStore } from '../../src/main/tui/state/store'
import { setClipboardWriter } from '../../src/main/tui/views/chat/model'
import { transcriptKey } from '../../src/main/tui/state/types'

const NEWLINE = String.fromCharCode(10)
import { AGENT_1_ID, startMockDaemon, type MockDaemon } from './fixtures/mock-daemon'
import { renderTui, type RenderedTui } from './fixtures/render'
import { addAsk, addPendingTask, seedHistory, triggerFetch, type CapturedCall } from './fixtures/chat-script'

const KEY = {
  tab: '\t',
  enter: '\r',
  esc: '\u001b',
  up: '\u001b[A',
  down: '\u001b[B',
  pgUp: '\u001b[5~',
  end: '\u001b[F',
  home: '\u001b[H',
  ctrlRight: '\u001b[1;5C',
  ctrlLeft: '\u001b[1;5D',
  shiftTab: '\u001b[Z',
}

let mock: MockDaemon | null = null
let store: TuiStore | null = null
let ui: RenderedTui | null = null

// Midday, so "next <time>" never rolls over to the next day ("next Tue 00:10")
// and pushes the goal off the info line. Only Date is faked; timers stay real.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true })
  vi.setSystemTime(new Date(2026, 8, 28, 12, 0, 0))
})

afterEach(async () => {
  vi.useRealTimers()
  ui?.unmount()
  ui = null
  store?.stop()
  store = null
  await mock?.close()
  mock = null
  setClipboardWriter(null)
})

async function mountChat(options: { rows?: number; columns?: number; pageSize?: number; fetch?: typeof fetch; before?: (m: MockDaemon) => void } = {}) {
  mock = await startMockDaemon({ stepMs: 15 })
  options.before?.(mock)
  store = createTuiStore({ client: new DaemonClient({ baseUrl: mock.url, fetch: options.fetch }), initialView: 'chat', pageSize: options.pageSize })
  ui = renderTui(<App store={store} theme={createTheme({ mono: true })} />, { columns: options.columns ?? 120, rows: options.rows ?? 36 })
  await store.start()
  await ui.waitFor(f => f.includes('consolidator') && f.includes('What did we decide'))
  return { tui: ui, mock, store }
}

async function typeInPrompt(tui: RenderedTui, text: string) {
  for (const ch of text) await tui.press(ch)
}

describe('chat view', () => {
  it('renders loop tabs and the main transcript from history', async () => {
    const { tui } = await mountChat()
    const frame = await tui.waitFor('from loop consolidator')
    expect(frame).toMatch(/agent-1 › .*main.*consolidator.*researcher/)
    expect(frame).not.toContain('main loop: the agent itself')
    expect(frame).toMatch(/host ✓ · Merging API notes into mind.md/)
    expect(frame).toContain('› What did we decide about the standings API?')
    expect(frame).toContain('We keep v2 and add a since cursor.')
    expect(frame).toContain('• pagination stays offset-based')
    expect(frame).toMatch(/✓ fs_read .*notes\/api\.md/)
    expect(frame).toContain('→ # API notes (+1 line, Enter)')
    expect(frame).toContain('mind.md updated with 3 new facts.')
  })

  it('switches loops with Ctrl+→/← and keeps each loop’s transcript and goal', async () => {
    const { tui, store } = await mountChat()
    await tui.press(KEY.ctrlRight)
    let frame = await tui.waitFor('Merged 3 notes into mind.md.')
    expect(frame).toContain('goal: Consolidate memories into mind.md every hour.')
    expect(frame).toMatch(/wakes every 1h · next \d\d:\d\d/)
    expect(frame).not.toContain('timer #1')
    expect(frame).toContain('from loop main')
    expect(store.getState().selectedLoop[AGENT_1_ID]).toBe('consolidator')
    await tui.press(KEY.ctrlRight)
    frame = await tui.waitFor('No messages in researcher yet')
    await tui.press(KEY.ctrlLeft)
    await tui.press(KEY.ctrlLeft)
    await tui.waitFor('What did we decide')
    expect(store.getState().selectedLoop[AGENT_1_ID]).toBeUndefined()
  })

  it('sends to the selected inner loop, streams the reply and shows the turn footer', async () => {
    const { tui, mock } = await mountChat()
    await tui.press(KEY.ctrlRight)
    await tui.waitFor('Merged 3 notes')
    expect(store!.getState().focus).toBe('input')
    await typeInPrompt(tui, 'tidy up')
    await tui.press(KEY.enter)
    const frame = await tui.waitFor(f => f.includes('Working on it in consolidator') && f.includes('last turn'))
    expect(frame).toMatch(/↑1\.2k ↓80 tok/)
    expect(frame).toContain('mock-model')
    expect(mock.agents.get(AGENT_1_ID)!.history.consolidator.some(r => r.content_json[0].text === 'tidy up')).toBe(true)
    expect(mock.agents.get(AGENT_1_ID)!.history.main.some(r => r.content_json[0].text === 'tidy up')).toBe(false)
  })

  it('interrupts the running turn of the selected loop with Esc from the prompt', async () => {
    const { tui, mock } = await mountChat()
    mock.agents.get(AGENT_1_ID)!.loops[0].status = 'idle'
    await tui.press(KEY.ctrlRight)
    await tui.waitFor('Merged 3 notes')
    mock.emit({ event_type: 'agent.state.changed', agent_id: AGENT_1_ID, loop: 'consolidator', payload: { state: 'thinking' } })
    await tui.waitFor('esc to interrupt')
    await tui.press(KEY.esc)
    await tui.waitFor('Turn interrupted by you')
    expect(mock.requests.some(r => r.startsWith('POST /agents/') && r.includes('/interrupt?loop=consolidator'))).toBe(true)
    // Interrupt, not a hard abort: the loop is idle and the chat no longer shows it running.
    expect(mock.requests.some(r => r.includes('/abort'))).toBe(false)
    await tui.waitFor(f => !f.includes('esc to interrupt'))
  })

  it('clears a running indicator when the loop stops without turn.completed', async () => {
    const { tui, mock, store } = await mountChat()
    mock.emit({ event_type: 'tool.started', agent_id: AGENT_1_ID, payload: { id: 'tu_9', name: 'fs_read', input: {} } })
    await tui.waitFor(() => store.getState().transcripts[transcriptKey(AGENT_1_ID, 'main')]?.live === true)
    mock.emit({ event_type: 'agent.state.changed', agent_id: AGENT_1_ID, payload: { state: 'stopped' } })
    await tui.waitFor(() => store.getState().transcripts[transcriptKey(AGENT_1_ID, 'main')]?.live === false)
  })

  it('clears the prompt with a double Esc and never leaves it', async () => {
    const { tui, store } = await mountChat()
    await typeInPrompt(tui, 'half a thought')
    await tui.waitFor('half a thought')
    await tui.press(KEY.esc)
    expect(store.getState().focus).toBe('input')
    expect(tui.lastFrame()).toContain('half a thought')
    await tui.press(KEY.esc)
    await tui.waitFor(f => !f.includes('half a thought'))
    expect(store.getState().focus).toBe('input')
  })

  it('shows messages sent during a running turn as queued', async () => {
    const { tui, mock } = await mountChat()
    mock.emit({ event_type: 'agent.state.changed', agent_id: AGENT_1_ID, payload: { state: 'thinking' } })
    await tui.waitFor('esc to interrupt')
    await typeInPrompt(tui, 'after that, this')
    await tui.press(KEY.enter)
    const frame = await tui.waitFor('1 queued until the turn ends')
    expect(frame).toContain('after that, this  [queued]')
  })

  it('never approves from typed text; y twice in the transcript approves', async () => {
    const { tui, mock, store } = await mountChat()
    await tui.waitFor('agent-1 wants to run msg_send')
    // Arriving in Chat puts the caret in the prompt: "yes" is text, not an approval.
    await typeInPrompt(tui, 'yes')
    await tui.waitFor('› yes')
    expect(mock.agents.get(AGENT_1_ID)!.tasks.find(t => t.id === 'task_approve_1')?.status).toBe('pending_approval')
    await tui.press(KEY.shiftTab)
    await tui.waitFor(() => store.getState().focus === 'main')
    await tui.press('y')
    await tui.waitFor('Press y again to approve msg_send')
    expect(mock.agents.get(AGENT_1_ID)!.tasks.find(t => t.id === 'task_approve_1')?.status).toBe('pending_approval')
    await tui.press('y')
    await tui.waitFor(f => !f.includes('wants to run msg_send'))
    expect(mock.agents.get(AGENT_1_ID)!.tasks.find(t => t.id === 'task_approve_1')?.status).toBe('completed')
  })

  it('rejects with feedback (f) and marks the inline approval card', async () => {
    const { tui, mock } = await mountChat({ before: m => { m.agents.get(AGENT_1_ID)!.tasks = [] } })
    addPendingTask(mock, AGENT_1_ID, { id: 'task_2', tool: 'fs_write', args: { path: 'mind.md' } })
    await tui.waitFor('wants to run fs_write')
    expect(tui.lastFrame()).toContain('approval pending fs_write')
    expect(tui.lastFrame()).toMatch(/y approve · a always · n reject · f feedback · v details/)
    await tui.press(KEY.shiftTab)
    await tui.press('f')
    await tui.waitFor('Reject fs_write with feedback')
    await typeInPrompt(tui, 'not now')
    await tui.press(KEY.enter)
    const frame = await tui.waitFor('approval denied fs_write')
    expect(frame).not.toContain('wants to run fs_write')
    expect(mock.agents.get(AGENT_1_ID)!.tasks[0].status).toBe('denied')
    expect(mock.agents.get(AGENT_1_ID)!.tasks[0].error).toBe('not now')
  })

  it('always approve: a twice, confirm; refused (greyed) for one-time-only approvals; buttons click', async () => {
    const { tui, mock, store } = await mountChat({ before: m => { m.agents.get(AGENT_1_ID)!.tasks = [] } })
    addPendingTask(mock, AGENT_1_ID, { id: 'task_4', tool: 'fs_write', args: { path: 'mind.md' } })
    await tui.waitFor('wants to run fs_write')
    await tui.press(KEY.shiftTab)
    await tui.press('a')
    await tui.waitFor('Press a again to always approve fs_write')
    await tui.press('a')
    await tui.waitFor('Always approve fs_write for agent-1?')
    await tui.press('y')
    await tui.waitFor(f => !f.includes('wants to run fs_write'))
    expect(mock.agents.get(AGENT_1_ID)!.tasks[0].status).toBe('completed')
    expect(mock.agents.get(AGENT_1_ID)!.tools?.find(t => t.name === 'fs_write')).toMatchObject({ restricted: false, enabled: true })

    // A protection override: one-time only, "always" greyed with the reason.
    const agent = mock.agents.get(AGENT_1_ID)!
    addPendingTask(mock, AGENT_1_ID, { id: 'task_5', tool: 'fs_delete', args: { path: 'mind.md' } })
    agent.tasks.find(t => t.id === 'task_5')!.approval_meta = { reason: 'protection', canAlwaysApprove: false, alwaysApproveBlockedReason: 'Target is locked (no_delete)' }
    await store.actions.refreshHil(AGENT_1_ID)
    await tui.waitFor(f => f.includes('wants to run fs_delete') && f.includes('always: one-time only'))
    // Mouse mode: a click on "approve" approves at once (explicit).
    const frame = tui.lastFrame()
    const y = frame.split('\n').findIndex(l => l.includes('approve') && l.includes('reject'))
    const x = frame.split('\n')[y].indexOf('y approve') + 2
    await tui.press(`\u001b[<0;${x + 1};${y + 1}M\u001b[<0;${x + 1};${y + 1}m`)
    await tui.waitFor(f => !f.includes('wants to run fs_delete'))
    expect(agent.tasks.find(t => t.id === 'task_5')!.status).toBe('completed')
  })

  it('/reject with feedback and /approve from the prompt', async () => {
    const { tui, mock } = await mountChat({ before: m => { m.agents.get(AGENT_1_ID)!.tasks = [] } })
    addPendingTask(mock, AGENT_1_ID, { id: 'task_6', tool: 'fs_write', args: { path: 'a.md' } })
    await tui.waitFor('wants to run fs_write')
    await typeInPrompt(tui, '/reject use notes.md instead')
    await tui.press(KEY.enter)
    await tui.waitFor(f => !f.includes('wants to run fs_write'))
    expect(mock.agents.get(AGENT_1_ID)!.tasks[0]).toMatchObject({ status: 'denied', error: 'use notes.md instead' })
    addPendingTask(mock, AGENT_1_ID, { id: 'task_7', tool: 'fs_write', args: { path: 'b.md' } })
    await tui.waitFor('wants to run fs_write')
    await typeInPrompt(tui, '/approve')
    await tui.press(KEY.enter)
    await tui.waitFor(f => !f.includes('wants to run fs_write'))
    expect(mock.agents.get(AGENT_1_ID)!.tasks.find(t => t.id === 'task_7')!.status).toBe('completed')
  })

  it('routes an inner loop’s approval to that loop’s tab', async () => {
    const { tui, mock } = await mountChat({ before: m => { m.agents.get(AGENT_1_ID)!.tasks = [] } })
    addPendingTask(mock, AGENT_1_ID, { id: 'task_3', tool: 'fs_delete', args: { path: 'old.md' }, loop: 'researcher' })
    await tui.waitFor(/researcher !/.test.bind(/researcher !/))
    expect(tui.lastFrame()).not.toContain('wants to run fs_delete')
    await tui.press(KEY.ctrlLeft)
    await tui.waitFor('agent-1 › researcher wants to run fs_delete')
  })

  it('answers the agent’s question from the prompt', async () => {
    const { tui, mock } = await mountChat({ before: m => { m.agents.get(AGENT_1_ID)!.tasks = [] } })
    addAsk(mock, AGENT_1_ID, 'ask_1', 'Which cursor format do you want?')
    await tui.waitFor('agent-1 asks you')
    await tui.waitFor('Answer agent-1')
    await typeInPrompt(tui, 'opaque base64')
    await tui.press(KEY.enter)
    await tui.waitFor('Answer sent')
    expect(mock.requests).toContain(`POST /agents/${AGENT_1_ID}/asks/ask_1/respond`)
    expect(mock.agents.get(AGENT_1_ID)!.history.main.some(r => r.content_json[0].text === 'opaque base64')).toBe(false)
  })

  it('collapses thinking by default and expands it with t', async () => {
    const { tui, mock } = await mountChat()
    mock.emit({ event_type: 'turn.delta', agent_id: AGENT_1_ID, payload: { kind: 'thinking', text: 'The user wants the cursor to be opaque.' } })
    mock.emit({ event_type: 'turn.completed', agent_id: AGENT_1_ID, payload: {} })
    await tui.waitFor('thinking · 1 line')
    expect(tui.lastFrame()).not.toContain('The user wants the cursor')
    await tui.press(KEY.shiftTab)
    await tui.press('t')
    await tui.waitFor('The user wants the cursor to be opaque.')
  })

  it('expands a tool call with ↑ + Enter to show its full input and result', async () => {
    const { tui } = await mountChat()
    await tui.waitFor('from loop consolidator')
    await tui.press(KEY.shiftTab)
    await tui.press(KEY.up)
    await tui.press(KEY.up)
    await tui.press(KEY.enter)
    const frame = await tui.waitFor('v2 is frozen.')
    expect(frame).toContain('result')
    expect(frame).toContain('"path": "notes/api.md"')
  })

  it('labels a timer wake in the loop the timer targets and marks unseen loops', async () => {
    const { tui, mock } = await mountChat()
    mock.emit({ event_type: 'timer.fired', agent_id: AGENT_1_ID, payload: { timer_id: 1, scope: ['agent'], run_count: 4 } })
    mock.emit({ event_type: 'turn.delta', agent_id: AGENT_1_ID, loop: 'consolidator', payload: { kind: 'text', text: 'Consolidated 2 notes.' } })
    await tui.waitFor(/consolidator •/.test.bind(/consolidator •/))
    expect(tui.lastFrame()).not.toContain('Woken by timer')
    await tui.press(KEY.ctrlRight)
    const frame = await tui.waitFor('Woken by timer (every 1h, "consolidate")')
    expect(frame).toContain('Consolidated 2 notes.')
    expect(frame).not.toMatch(/consolidator •/)
  })

  it('pages older history in when scrolled to the top', async () => {
    const { tui, mock } = await mountChat({ pageSize: 20, rows: 30, before: m => seedHistory(m, AGENT_1_ID, 'researcher', 50) })
    await tui.press(KEY.ctrlLeft)
    await tui.waitFor('answer 49')
    await tui.press(KEY.shiftTab)
    const requested = (offset: number) => mock.requests.some(r => r.includes('/loop?loop=researcher') && r.includes(`offset=${offset}`))
    await tui.press(KEY.pgUp)
    await tui.waitFor('newer rows below')
    await tui.press(KEY.home)
    await tui.waitFor(() => requested(10))
    await tui.waitFor(() => !store!.getState().transcripts[transcriptKey(AGENT_1_ID, 'researcher')]?.loading)
    await tui.press(KEY.home)
    await tui.waitFor(() => requested(0))
    await tui.waitFor(() => store!.getState().transcripts[transcriptKey(AGENT_1_ID, 'researcher')]?.oldestOffset === 0)
    await tui.press(KEY.home)
    const frame = await tui.waitFor('question 0')
    expect(frame).not.toContain('earlier rows')
    await tui.press(KEY.end)
    await tui.waitFor(f => f.includes('answer 49') && !f.includes('newer rows below'))
  })

  it('/copy puts the last reply on the clipboard, /trigger fires into the loop', async () => {
    const copied: string[] = []
    setClipboardWriter(async text => { copied.push(text); return true })
    const calls: CapturedCall[] = []
    const { tui } = await mountChat({ fetch: triggerFetch(calls) })
    await tui.press(KEY.ctrlRight)
    await tui.waitFor('Merged 3 notes')
    await typeInPrompt(tui, '/copy')
    await tui.press(KEY.enter)
    await tui.waitFor('Copied last reply from consolidator')
    expect(copied).toEqual(['Merged 3 notes into mind.md.'])
    await typeInPrompt(tui, '/trigger startup')
    await tui.press(KEY.enter)
    await tui.waitFor('Trigger startup queued for consolidator')
    expect(calls[0].body).toEqual({ type: 'startup', target: { scope: 'agent', loop: 'consolidator' } })
  })

  it('degrades to ASCII glyphs and a narrow width', async () => {
    mock = await startMockDaemon({ stepMs: 15 })
    store = createTuiStore({ client: new DaemonClient({ baseUrl: mock.url }), initialView: 'chat' })
    ui = renderTui(<App store={store} theme={createTheme({ mono: true, ascii: true })} />, { columns: 60, rows: 24 })
    await store.start()
    const frame = await ui.waitFor('mind.md updated')
    expect(frame).toContain('@ from loop consolidator')
    const mine = frame.split(NEWLINE).filter(l => /from loop|fs_read|API notes|main loop|wants to run|approve/.test(l))
    expect(mine.length).toBeGreaterThan(4)
    for (const line of mine) expect(line).toMatch(/^[ -~]*$/)
  })
})

void React
