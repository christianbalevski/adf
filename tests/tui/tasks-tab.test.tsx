import React from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { App } from '../../src/main/tui/app/App'
import { createTheme } from '../../src/main/tui/app/theme'
import { DaemonClient } from '../../src/main/tui/api/client'
import { createTuiStore, type TuiStore } from '../../src/main/tui/state/store'
import { VIEWS } from '../../src/main/tui/views/registry'
import { collectCommands } from '../../src/main/tui/commands/registry'
import { BUILTIN_COMMANDS } from '../../src/main/tui/commands/builtin/index'
import { isTaskEvent, matchesFilter, nextFilter, searchTasks, sortTasks, taskDetailLines, taskLoop, taskReason } from '../../src/main/tui/views/inspect/tasks'
import { lineText } from '../../src/main/tui/views/inspect/format'
import { findTab } from '../../src/main/tui/views/inspect/state'
import type { TaskListEntry } from '../../src/main/tui/api/types'
import { AGENT_1_ID, startMockDaemon, type MockDaemon } from './fixtures/mock-daemon'
import { renderTui, type RenderedTui } from './fixtures/render'

const KEY = { enter: '\r', esc: '\u001b', down: '\u001b[B', up: '\u001b[A' }
const MIN = 60_000

const task = (over: Partial<TaskListEntry> & { id: string }): TaskListEntry => ({ tool: 'fs_read', args: '{}', status: 'completed', created_at: 1, ...over })

describe('tasks model', () => {
  it('filters, searches, sorts newest first and reads loop + _reason', () => {
    const rows = [
      task({ id: 'a', status: 'pending_approval', created_at: 1 }),
      task({ id: 'b', status: 'running', created_at: 3, origin: 'loop:researcher', args: JSON.stringify({ _reason: 'check  the\ndocs', url: 'x' }) }),
      task({ id: 'c', status: 'completed', created_at: 2 }),
      task({ id: 'd', status: 'pending', created_at: 4 }),
    ]
    expect(sortTasks(rows).map(t => t.id)).toEqual(['d', 'b', 'c', 'a'])
    expect(rows.filter(t => matchesFilter(t, 'pending')).map(t => t.id)).toEqual(['a', 'd'])
    expect(rows.filter(t => matchesFilter(t, 'active')).map(t => t.id)).toEqual(['a', 'b', 'd'])
    expect(rows.filter(t => matchesFilter(t, 'all'))).toHaveLength(4)
    expect(nextFilter('pending')).toBe('active')
    expect(nextFilter('active')).toBe('all')
    expect(nextFilter('all')).toBe('pending')
    expect(taskLoop(rows[1])).toBe('researcher')
    expect(taskLoop({ ...rows[0], loop: 'critic' } as TaskListEntry)).toBe('critic')
    expect(taskLoop(rows[0])).toBe('main')
    expect(taskReason(rows[1])).toBe('check the docs')
    expect(searchTasks(rows, 'researcher docs').map(t => t.id)).toEqual(['b'])
    expect(findTab('tasks')).toBe('tasks')
    expect(findTab('approvals')).toBe('tasks')
    expect(findTab('tab')).toBe('tables')
    expect(isTaskEvent({ seq: 1, event_type: 'hil.requested', timestamp: 1, source: 'x', agent_id: 'A', payload: {} }, 'A')).toBe(true)
    expect(isTaskEvent({ seq: 1, event_type: 'hil.requested', timestamp: 1, source: 'x', agent_id: 'B', payload: {} }, 'A')).toBe(false)
    expect(isTaskEvent({ seq: 1, event_type: 'turn.delta', timestamp: 1, source: 'x', agent_id: 'A', payload: {} }, 'A')).toBe(false)
  })

  it('detail lines carry args (redacted), result, denial feedback and the always-approve rule', () => {
    const text = (t: TaskListEntry) => taskDetailLines(t, 10 * MIN).map(lineText).join('\n')
    const denied = text(task({ id: 'x', status: 'denied', tool: 'fs_delete', args: JSON.stringify({ path: 'a', _reason: 'tidy', apiKey: 'sk-1' }), error: 'not now', created_at: MIN, completed_at: 2 * MIN }))
    expect(denied).toContain('"_reason": "tidy"')
    expect(denied).not.toContain('sk-1')
    expect(denied).toContain('rejected: not now')
    const pending = text(task({ id: 'y', status: 'pending_approval', canAlwaysApprove: false, alwaysApproveBlockedReason: 'One-time approval only for this request', approval_meta: { reason: 'restricted' } }))
    expect(pending).toContain('not offered: One-time approval only for this request')
    expect(pending).toContain('restricted tool')
  })

  it('registers /tasks without a command-name collision', () => {
    const registry = collectCommands(VIEWS, [BUILTIN_COMMANDS])
    expect(registry.conflicts).toEqual([])
    expect(registry.commands.some(c => c.name === 'tasks')).toBe(true)
  })
})

describe('Inspect › Tasks against the mock daemon', () => {
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

  const tasksOf = () => mock.agents.get(AGENT_1_ID)!.tasks
  const pendingTask = () => tasksOf().find(t => t.id === 'task_approve_1')!

  function seed() {
    const now = Date.now()
    tasksOf().push(
      { id: 'task_read', tool: 'fs_read', args: JSON.stringify({ path: 'notes.md', _reason: 'read the notes' }), status: 'completed', created_at: now - 30 * MIN, completed_at: now - 29 * MIN, origin: 'agent', result: 'file text here' },
      { id: 'task_delete', tool: 'fs_delete', args: JSON.stringify({ path: 'old.md' }), status: 'denied', created_at: now - 20 * MIN, completed_at: now - 19 * MIN, error: 'not now' },
      { id: 'task_fetch', tool: 'web_fetch', args: JSON.stringify({ url: 'https://example.test', _reason: 'check the docs', _async: true }), status: 'running', created_at: now - 10 * MIN, origin: 'loop:researcher' },
    )
  }

  async function mount() {
    ui = renderTui(<App store={store} theme={createTheme({ mono: true })} />, { columns: 140, rows: 36 })
    await store.start()
    await ui.waitFor('consolidator')
    store.actions.selectAgent(AGENT_1_ID)
    return ui
  }

  async function slash(tui: RenderedTui, command: string) {
    store.actions.prefillPrompt('')
    await tui.waitFor(() => store.getState().focus === 'input')
    await tui.type(command)
    await tui.press(KEY.enter)
  }

  async function openTasks(tui: RenderedTui, arg = '') {
    await slash(tui, `/tasks${arg ? ` ${arg}` : ''}`)
    await tui.waitFor(f => f.includes('Tasks ') && f.includes('msg_send'))
    store.actions.setFocus('main')
    await new Promise(resolve => setTimeout(resolve, 60))
  }

  it('lists newest first, cycles the filter, searches and opens the detail', async () => {
    seed()
    const tui = await mount()
    await openTasks(tui)
    expect(store.getState().activeView).toBe('inspect')
    const frame = await tui.waitFor(f => f.includes('web_fetch') && f.includes('fs_read'))
    const order = ['web_fetch', 'fs_delete', 'fs_read', 'msg_send'].map(t => frame.indexOf(t))
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(frame).toMatch(/running\s+web_fetch\s+researcher/)
    expect(frame).toContain('check the docs')
    expect(frame).toContain('4/4')

    await tui.press('f')
    await tui.waitFor(f => f.includes('pending (awaiting') && f.includes('msg_send') && !f.includes('fs_read'))
    await tui.press('f')
    await tui.waitFor(f => f.includes('active (pending + running)') && f.includes('web_fetch') && f.includes('msg_send') && !f.includes('fs_delete'))
    await tui.press('f')
    await tui.waitFor(f => f.includes('4/4') && f.includes('fs_delete'))

    await tui.press('/')
    await tui.waitFor('search ›')
    await tui.type('notes')
    await tui.press(KEY.enter)
    await tui.waitFor(f => f.includes('1/4') && f.includes('fs_read') && !f.includes('web_fetch'))
    await tui.press(KEY.enter)
    const detail = await tui.waitFor(f => f.includes('Task task_read') && f.includes('file text here'))
    expect(detail).toContain('"path": "notes.md"')
    expect(detail).toContain('"_reason": "read the notes"')
    expect(detail).toMatch(/resolution\s+ran/)
    await tui.press(KEY.esc)
    await tui.waitFor(f => f.includes('search: notes') && !f.includes('Task task_read'))
    await tui.press(KEY.esc)
    await tui.waitFor(f => f.includes('4/4'))
  })

  it('approves the highlighted pending call with y; a on a finished row does nothing', async () => {
    seed()
    const tui = await mount()
    await openTasks(tui)
    // Top row is the running web_fetch: approval keys do nothing there.
    await tui.press('a')
    await tui.press('y')
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(store.getState().overlays).toHaveLength(0)
    expect(mock.requests.some(r => r.includes('/resolve') || r.includes('always-approve'))).toBe(false)
    expect(pendingTask().status).toBe('pending_approval')

    for (let i = 0; i < 3; i++) await tui.press(KEY.down)
    await tui.waitFor(f => f.includes('y approve'))
    await tui.press('y')
    await tui.waitFor(() => pendingTask().status === 'completed')
    await tui.waitFor(f => f.includes('Approved task_approve_1') || /completed\s+msg_send/.test(f))
    await tui.waitFor(f => /completed\s+msg_send/.test(f))
  })

  it('refuses always approve when the daemon says one-time only, and rejects with feedback via the chat dialog', async () => {
    pendingTask().approval_meta = { reason: 'restricted', canAlwaysApprove: false, alwaysApproveBlockedReason: 'One-time approval only for this request' }
    const tui = await mount()
    await openTasks(tui, 'pending')
    await tui.waitFor(f => f.includes('pending (awaiting') && f.includes('y approve'))
    await tui.press('a')
    await tui.waitFor(() => store.getState().toasts.some(t => t.text.includes('Always approve is not available') && t.text.includes('One-time approval only')))
    expect(store.getState().overlays.some(o => o.kind === 'confirm')).toBe(false)
    expect(mock.requests.some(r => r.includes('always-approve'))).toBe(false)
    expect(pendingTask().status).toBe('pending_approval')

    await tui.press(KEY.enter)
    await tui.waitFor(f => f.includes('not offered: One-time approval only'))
    await tui.press('N')
    await tui.waitFor('Reject msg_send with feedback')
    await tui.type('ask agent-2 first')
    await tui.press(KEY.enter)
    await tui.waitFor(() => pendingTask().status === 'denied')
    expect(pendingTask().error).toBe('ask agent-2 first')
    await tui.waitFor(f => f.includes('rejected: ask agent-2 first'))
  })

  it('reloads live on hil.requested and keeps the cursor on the task it was on', async () => {
    const tui = await mount()
    await openTasks(tui)
    await tui.waitFor(f => f.includes('1/1'))
    tasksOf().push({ id: 'task_live_2', tool: 'fs_write', args: JSON.stringify({ path: 'draft.md', _reason: 'save the draft' }), status: 'pending_approval', created_at: Date.now(), approval_meta: { reason: 'restricted' } })
    mock.emit({ event_type: 'hil.requested', agent_id: AGENT_1_ID, payload: { request_id: 'task_live_2', task_id: 'task_live_2', tool: 'fs_write', reason: 'restricted', input: {}, can_always_approve: true } })
    const frame = await tui.waitFor(f => f.includes('save the draft') && f.includes('2/2'))
    expect(frame.indexOf('fs_write')).toBeLessThan(frame.indexOf('msg_send'))
    // The new row arrived above; y still approves the row the cursor was on.
    await tui.press('y')
    await tui.waitFor(() => pendingTask().status === 'completed')
    expect(tasksOf().find(t => t.id === 'task_live_2')!.status).toBe('pending_approval')
  })
})
