import { describe, expect, it } from 'vitest'
import {
  RECENT_MS,
  finishedText,
  formatElapsed,
  taskRow,
  taskRows,
  taskSummary,
  timeoutShare
} from '../../../src/renderer/components/agent/overview/overview-tasks-model'
import type { TaskEntry } from '../../../src/shared/types/adf-v02.types'

const NOW = 1_800_000_000_000
const MIN = 60_000

function task(over: Partial<TaskEntry> & { args?: unknown }): TaskEntry {
  const { args, ...rest } = over
  return {
    id: 'task_1',
    tool: 'sys_code',
    args: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
    status: 'running',
    created_at: NOW - MIN,
    origin: 'agent',
    ...rest
  }
}

describe('formatElapsed', () => {
  it('uses m:ss, then h:mm:ss', () => {
    expect(formatElapsed(7_000)).toBe('0:07')
    expect(formatElapsed(252_000)).toBe('4:12')
    expect(formatElapsed(3_912_000)).toBe('1:05:12')
    expect(formatElapsed(-5)).toBe('0:00')
  })
})

describe('taskRow', () => {
  it('titles a script with its _reason and shows the lambda source', () => {
    const r = taskRow(task({ tool: 'sys_lambda', args: { _reason: 'Scrape listings', source: 'scrapers/listings.ts:main' } }), 300_000)
    expect(r).toMatchObject({ title: 'Scrape listings', detail: 'scrapers/listings.ts:main', timeoutMs: 300_000 })
  })

  it('shows the first code line, skipping comments, with the full code for the tooltip', () => {
    const r = taskRow(task({ args: { code: '// resize\nconst imgs = await adf.fs_list()\nreturn imgs' } }), 60_000)
    expect(r.title).toBe('sys_code')
    expect(r.detail).toBe('const imgs = await adf.fs_list()')
    expect(r.full).toContain('return imgs')
  })

  it("uses the call's own timeout, capped by the limit", () => {
    expect(taskRow(task({ args: { code: 'x', timeout: 10_000 } }), 60_000).timeoutMs).toBe(10_000)
    expect(taskRow(task({ args: { code: 'x', timeout: 900_000 } }), 60_000).timeoutMs).toBe(60_000)
  })

  it('gives a run that waited on an approval no timeout bar', () => {
    const r = taskRow(task({ origin: 'lambda', args: { code: 'x' }, approval_meta: { reason: 'protection' } }), 60_000)
    expect(r.timeoutMs).toBeUndefined()
  })

  it('gives non-script tools no timeout bar', () => {
    expect(taskRow(task({ tool: 'container_exec', args: { command: 'ls' } }), 60_000).timeoutMs).toBeUndefined()
  })

  it('survives unparseable args', () => {
    expect(taskRow(task({ args: '{oops' }), 60_000)).toMatchObject({ title: 'sys_code', detail: '' })
  })
})

describe('taskRows', () => {
  it('lists running oldest first, then recently finished newest first, and drops the rest', () => {
    const rows = taskRows([
      task({ id: 'r2', created_at: NOW - 10_000 }),
      task({ id: 'r1', created_at: NOW - 50_000 }),
      task({ id: 'done-old', status: 'completed', completed_at: NOW - RECENT_MS - 1 }),
      task({ id: 'done', status: 'completed', completed_at: NOW - 30_000 }),
      task({ id: 'fail', status: 'failed', completed_at: NOW - 5_000 }),
      task({ id: 'denied', status: 'denied', completed_at: NOW - 5_000 }),
      task({ id: 'approval', status: 'pending_approval' }),
      task({ id: 'queued', status: 'pending' })
    ], 60_000, NOW)
    expect(rows.map((r) => r.id)).toEqual(['r1', 'r2', 'fail', 'done'])
    expect(rows[2].finished).toEqual({ status: 'failed', at: NOW - 5_000 })
  })

  it('lists only async runs from the agent or a lambda, not approval rows', () => {
    const rows = taskRows([
      task({ id: 'agent' }),
      task({ id: 'lambda', origin: 'lambda' }),
      task({ id: 'hil', origin: 'hil:Agent:abc', executor_managed: true, approval_meta: { reason: 'restricted' } }),
      task({ id: 'hil-done', origin: 'hil:Agent:abc', status: 'completed', result: 'approved', completed_at: NOW - 5_000 })
    ], 60_000, NOW)
    expect(rows.map((r) => r.id).sort()).toEqual(['agent', 'lambda'])
  })
})

describe('timeoutShare and finishedText', () => {
  it('measures elapsed against the timeout, clamped', () => {
    const r = taskRow(task({ created_at: NOW - 45_000, args: { code: 'x' } }), 60_000)
    expect(timeoutShare(r, NOW)).toBeCloseTo(0.75)
    expect(timeoutShare(r, NOW + 60_000)).toBe(1)
  })

  it('says how long ago a task finished', () => {
    const r = taskRow(task({ status: 'completed', completed_at: NOW - 52_000 }), 60_000)
    expect(finishedText(r, NOW)).toBe('done 0:52 ago')
    const f = taskRow(task({ status: 'failed', completed_at: NOW - 70_000 }), 60_000)
    expect(finishedText(f, NOW)).toBe('failed 1:10 ago')
  })
})

describe('taskSummary', () => {
  it('counts the last hour and averages completed runs', () => {
    expect(taskSummary([
      task({ status: 'completed', created_at: NOW - 5 * MIN, completed_at: NOW - 4 * MIN }),
      task({ status: 'completed', created_at: NOW - 10 * MIN, completed_at: NOW - 7 * MIN }),
      task({ status: 'failed', created_at: NOW - 3 * MIN, completed_at: NOW - 2 * MIN }),
      task({ status: 'completed', created_at: NOW - 90 * MIN, completed_at: NOW - 80 * MIN }),
      task({ status: 'running' })
    ], NOW)).toBe('Last hour: 2 done · 1 failed · avg 2:00')
  })

  it('skips approval rows, and keeps approval-waited runs out of the average', () => {
    expect(taskSummary([
      task({ status: 'completed', created_at: NOW - 3 * MIN, completed_at: NOW - 2 * MIN }),
      task({ origin: 'lambda', status: 'completed', approval_meta: { reason: 'protection' }, created_at: NOW - 50 * MIN, completed_at: NOW - MIN }),
      task({ origin: 'hil:Agent:abc', status: 'completed', result: 'approved', created_at: NOW - 9 * MIN, completed_at: NOW - MIN })
    ], NOW)).toBe('Last hour: 2 done · avg 1:00')
  })

  it('is null with nothing finished in the window', () => {
    expect(taskSummary([task({ status: 'running' })], NOW)).toBeNull()
  })
})
