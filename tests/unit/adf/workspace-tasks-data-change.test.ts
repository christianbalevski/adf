import { describe, it, expect, afterAll, beforeEach } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'
import { unlinkSync, existsSync } from 'fs'
import { AdfWorkspace, type WorkspaceDataScope } from '../../../src/main/adf/adf-workspace'
import { runTask } from '../../../src/main/runtime/task-run'

/**
 * The workspace `tasks` data-change scope: every adf_tasks insert and status
 * change raises it, whichever path wrote it (agent `_async`, a lambda's
 * `_async`, approval, crash reconciliation), so open views follow tasks
 * without polling.
 */

const testFile = join(tmpdir(), `adf-tasks-scope-${Date.now()}.adf`)
const ws = AdfWorkspace.create(testFile, { name: 'agent-1' })
const scopes: WorkspaceDataScope[] = []
ws.setOnDataChangeCallback((scope) => { scopes.push(scope) })

afterAll(() => {
  try { ws.close() } catch { /* ignore */ }
  for (const suffix of ['', '-shm', '-wal']) {
    const p = testFile + suffix
    if (existsSync(p)) try { unlinkSync(p) } catch { /* ignore */ }
  }
})

beforeEach(() => { scopes.length = 0 })

const taskSignals = (): number => scopes.filter((s) => s === 'tasks').length

describe('tasks data-change scope', () => {
  it('an insert raises it', () => {
    ws.insertTask('task_a', 'sys_code', '{"code":"1"}', 'agent')
    expect(taskSignals()).toBe(1)
  })

  it('a status change raises it, through running and completion', () => {
    ws.insertTask('task_b', 'sys_lambda', '{}', 'lambda')
    scopes.length = 0
    ws.updateTaskStatus('task_b', 'running')
    ws.updateTaskStatus('task_b', 'completed', 'ok')
    expect(taskSignals()).toBe(2)
  })

  it('an args rewrite raises it (approval with modified args)', () => {
    ws.insertTask('task_c', 'sys_code', '{}', 'agent')
    scopes.length = 0
    ws.updateTaskArgs('task_c', '{"code":"2"}')
    expect(taskSignals()).toBe(1)
  })

  it('a loop-bound view raises it on the root sink', () => {
    const view = ws.forLoop('side')
    view.insertTask('task_d', 'sys_code', '{}', 'agent')
    expect(taskSignals()).toBe(1)
  })
})

describe('cancelling a task', () => {
  it('aborts the tracked run, raises the signal, and cancelled is final', () => {
    ws.insertTask('task_e', 'sys_code', '{}', 'agent')
    const signal = ws.startTaskRun('task_e')!
    scopes.length = 0
    expect(ws.cancelTask('task_e')).toBe(true)
    expect(signal.aborted).toBe(true)
    expect(taskSignals()).toBe(1)
    // A late write from the run is refused and raises nothing.
    expect(ws.updateTaskStatus('task_e', 'completed', 'late')).toBe(false)
    expect(ws.getTask('task_e')).toMatchObject({ status: 'cancelled', result: null })
    expect(taskSignals()).toBe(1)
    // A cancelled task does not start again.
    expect(ws.startTaskRun('task_e')).toBeNull()
    ws.endTaskRun('task_e', signal)
  })

  it('cancels only pending or running tasks', () => {
    ws.insertTask('task_f', 'sys_code', '{}', 'agent')
    expect(ws.cancelTask('task_f')).toBe(true) // pending, no run yet
    ws.insertTask('task_g', 'sys_code', '{}', 'agent')
    ws.updateTaskStatus('task_g', 'completed', 'ok')
    expect(ws.cancelTask('task_g')).toBe(false)
    expect(ws.getTask('task_g')?.status).toBe('completed')
    expect(ws.cancelTask('task_missing')).toBe(false)
  })

  it('refuses a running task with no tracked run (an approved call running inside a turn)', () => {
    ws.insertTask('task_j', 'sys_code', '{}', 'agent')
    ws.updateTaskStatus('task_j', 'running')
    expect(ws.cancelTask('task_j')).toBe(false)
    expect(ws.getTask('task_j')?.status).toBe('running')
  })

  it('setting requires_authorization raises it', () => {
    ws.insertTask('task_k', 'sys_code', '{}', 'agent')
    scopes.length = 0
    ws.setTaskRequiresAuthorization('task_k', true)
    expect(taskSignals()).toBe(1)
  })

  it('a run started on a loop view is cancelled from the root', () => {
    ws.insertTask('task_h', 'sys_code', '{}', 'agent')
    const signal = ws.forLoop('side').startTaskRun('task_h')!
    expect(ws.cancelTask('task_h')).toBe(true)
    expect(signal.aborted).toBe(true)
  })

  it('runTask reports a cancelled run once, whatever it returns late', async () => {
    ws.insertTask('task_i', 'sys_fetch', '{}', 'agent')
    const reports: string[] = []
    let finish!: () => void
    const outcome = runTask(ws, 'task_i', 'sys_fetch', (_id, _tool, status) => { reports.push(status) },
      // Ignores its signal, then completes after the cancel.
      () => new Promise(resolve => { finish = () => resolve({ content: 'late result', isError: false }) }))
    expect(ws.getTask('task_i')?.status).toBe('running')
    ws.cancelTask('task_i')
    finish()
    await outcome
    expect(reports).toEqual(['cancelled'])
    expect(ws.getTask('task_i')).toMatchObject({ status: 'cancelled', result: null })
  })

  it('runTask reports nothing for a run stopped with its agent; the row is cancelled', async () => {
    ws.insertTask('task_l', 'sys_fetch', '{}', 'agent')
    const reports: string[] = []
    const outcome = runTask(ws, 'task_l', 'sys_fetch', (_id, _tool, status) => { reports.push(status) },
      (signal) => new Promise(resolve => signal.addEventListener('abort', () => resolve({ content: 'stopped', isError: true }))))
    ws.abortTaskRuns()
    await outcome
    expect(reports).toEqual([])
    expect(ws.getTask('task_l')?.status).toBe('cancelled')
  })
})
