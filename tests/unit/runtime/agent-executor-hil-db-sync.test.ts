/**
 * Every executor-side HIL decision must persist before it settles, and a
 * protection-override conversion must relabel the task row.
 *
 * resolveHilTask is the one place every in-memory surface lands: the Studio
 * in-chat card and approvals menu (resolveApproval), "Always approve"
 * (IPC calls resolveHilTask directly), "Approve all" and the protection
 * auto-deny timer. Each used to settle the HIL promise only, leaving the row
 * at pending_approval while the approved tool ran (or after it was denied).
 * A later task_resolve (remote approval lambda, timeout sweep) then passed its
 * pending check, "succeeded", and wrote a false verdict.
 *
 * executeAsyncTool's protection conversion re-parked a task as
 * pending_approval with its old approval_meta ({reason:'restricted'}), so the
 * row claimed to be an ordinary restricted approval while it asked for a
 * protection override.
 */

import { afterEach, describe, it, expect, vi } from 'vitest'
import { AgentExecutor } from '../../../src/main/runtime/agent-executor'
import type { AgentConfig } from '../../../src/shared/types/adf-v02.types'
import type { AgentExecutionEvent } from '../../../src/shared/types/ipc.types'

type Row = { status: string; result?: string; error?: string; approval_meta?: string; requires_authorization?: boolean; executor_managed?: boolean }

function makeExecutor(executeTool = vi.fn()) {
  const tasks = new Map<string, Row>()
  const writes: Array<[string, string]> = []
  const workspace = {
    insertTask: (id: string, _tool: string, _args: string, _origin?: string, ra?: boolean, em?: boolean, meta?: string) => {
      tasks.set(id, { status: 'pending', requires_authorization: !!ra, executor_managed: !!em, approval_meta: meta })
    },
    updateTaskStatus: (id: string, status: string, result?: string, error?: string) => {
      writes.push([id, `status:${status}`])
      tasks.set(id, { ...tasks.get(id), status, result, error })
    },
    setTaskApprovalMeta: (id: string, meta: string) => {
      writes.push([id, 'meta'])
      tasks.set(id, { ...tasks.get(id)!, approval_meta: meta })
    },
    setTaskRequiresAuthorization: (id: string) => {
      writes.push([id, 'requires_authorization'])
      tasks.set(id, { ...tasks.get(id)!, requires_authorization: true })
    },
    setTaskExecutorManaged: (id: string) => {
      writes.push([id, 'executor_managed'])
      tasks.set(id, { ...tasks.get(id)!, executor_managed: true })
    },
    getTask: (id: string) => (tasks.has(id) ? { id, ...tasks.get(id) } : null),
    getFilePath: () => '/tmp/test.adf',
    insertLog: () => {},
  }
  const session = { getWorkspace: () => workspace } as never
  const config = {
    name: 'agent-1',
    id: 'agent-1',
    tools: [
      { name: 'fs_delete', enabled: true, visible: true, restricted: false },
      { name: 'compute_exec', enabled: true, visible: true, restricted: true },
    ],
    triggers: {},
    limits: {},
  } as unknown as AgentConfig
  const executor = new AgentExecutor(config, {} as never, { executeTool } as never, session)
  const events: AgentExecutionEvent[] = []
  executor.on('event', (e: AgentExecutionEvent) => events.push(e))
  const requestIds = () => events
    .filter(e => e.type === 'tool_approval_request')
    .map(e => (e.payload as { requestId: string }).requestId)
  return { executor, tasks, writes, requestIds, workspace }
}

/** What AdfCallHandler.handleTaskResolve checks before it accepts a verdict. */
const resolvable = (status: string | undefined) => status === 'pending' || status === 'pending_approval'

afterEach(() => { vi.useRealTimers() })

describe('resolveApproval (Studio card / approvals menu) persists the decision before settling', () => {
  it('approve: row is running synchronously, so a later task_resolve sees a non-pending task', async () => {
    const { executor, tasks, requestIds } = makeExecutor()
    const promise = executor.requestHilApproval('compute_exec', { code: '1' })
    const [id] = requestIds()
    expect(tasks.get(id)?.status).toBe('pending_approval')

    executor.resolveApproval(id, true)
    // No await yet: the transition must not depend on the promise continuation.
    expect(tasks.get(id)?.status).toBe('running')
    expect(resolvable(tasks.get(id)?.status)).toBe(false)

    expect((await promise).approved).toBe(true)
  })

  it('deny: row is denied synchronously with the feedback (default "Rejected")', async () => {
    const { executor, tasks, requestIds } = makeExecutor()
    const p1 = executor.requestHilApproval('compute_exec', { code: '1' })
    const p2 = executor.requestHilApproval('compute_exec', { code: '2' })
    const [a, b] = requestIds()

    executor.resolveApproval(a, false, '  not now  ')
    executor.resolveApproval(b, false)
    expect(tasks.get(a)).toMatchObject({ status: 'denied', error: 'not now' })
    expect(tasks.get(b)).toMatchObject({ status: 'denied', error: 'Rejected' })

    expect((await p1).approved).toBe(false)
    expect((await p2).approved).toBe(false)
  })

  it('never overwrites a row another resolver already moved out of pending', async () => {
    const { executor, tasks, writes, requestIds } = makeExecutor()
    void executor.requestHilApproval('compute_exec', { code: '1' })
    const [id] = requestIds()
    tasks.set(id, { status: 'denied', error: 'Telegram approval timed out' })
    const before = writes.length

    executor.resolveApproval(id, true)
    expect(writes.slice(before).filter(([t]) => t === id)).toEqual([])
    expect(tasks.get(id)).toMatchObject({ status: 'denied', error: 'Telegram approval timed out' })
  })

  it('unknown or already-settled request ids write nothing (stale card)', async () => {
    const { executor, tasks, writes, requestIds } = makeExecutor()
    const promise = executor.requestHilApproval('compute_exec', { code: '1' })
    const [id] = requestIds()
    executor.resolveApproval(id, true)
    await promise
    tasks.set(id, { status: 'completed' })
    const before = writes.length

    executor.resolveApproval(id, false)      // second click on a stale card
    executor.resolveApproval('task_nope', true)
    expect(writes.length).toBe(before)
    expect(tasks.get(id)?.status).toBe('completed')
  })
})

describe('direct resolveHilTask callers persist too', () => {
  it('"Always approve" (IPC calls resolveHilTask directly): row is running synchronously', async () => {
    const { executor, tasks, requestIds } = makeExecutor()
    const promise = executor.requestHilApproval('compute_exec', { code: '1' })
    const [id] = requestIds()
    executor.resolveHilTask(id, true)
    expect(tasks.get(id)?.status).toBe('running')
    expect((await promise).approved).toBe(true)
  })

  it('protection auto-deny timer: row is denied at the timer tick, before the promise continuation runs', async () => {
    vi.useFakeTimers()
    const { executor, tasks, requestIds } = makeExecutor()
    const promise = executor.requestProtectionApproval(
      'fs_delete', { path: 'mind.md' }, { kind: 'file_protection', target: 'mind.md', level: 'no_delete' }, { timeoutMs: 1000 }
    )
    const [id] = requestIds()
    expect(tasks.get(id)?.status).toBe('pending_approval')
    vi.advanceTimersByTime(1000)
    expect(tasks.get(id)).toMatchObject({ status: 'denied', error: 'Auto-denied: no decision within timeout' })
    expect((await promise).approved).toBe(false)
    expect(tasks.get(id)?.status).toBe('denied')
  })
})

describe('approveAllGatedHilTasks persists running for every approved row', () => {
  it('restricted rows are running synchronously; protection overrides stay pending_approval', async () => {
    const { executor, tasks, requestIds } = makeExecutor()
    const r1 = executor.requestHilApproval('compute_exec', { code: '1' })
    const r2 = executor.requestHilApproval('compute_exec', { code: '2' })
    const prot = executor.requestProtectionApproval(
      'fs_delete', { path: 'mind.md' }, { kind: 'file_protection', target: 'mind.md', level: 'no_delete' }, { timeoutMs: null }
    )
    const [a, b, p] = requestIds()

    const result = executor.approveAllGatedHilTasks()
    expect(result).toEqual({ approved: 2, skippedProtection: 1 })
    expect(tasks.get(a)?.status).toBe('running')
    expect(tasks.get(b)?.status).toBe('running')
    expect(tasks.get(p)?.status).toBe('pending_approval')

    await Promise.all([r1, r2])
    executor.resolveHilTask(p, false)
    await prot
  })
})

describe('executeAsyncTool protection conversion relabels the row', () => {
  const protection = { kind: 'file_protection', target: 'mind.md', level: 'read_only', description: 'locked' }

  it('restricted async task → protection override: approval_meta says protection before the row is pending again', async () => {
    const executeTool = vi.fn().mockResolvedValueOnce({ content: 'blocked', isError: true, protection })
    const { executor, tasks, writes, workspace } = makeExecutor(executeTool)
    workspace.insertTask('task_a', 'mcp_x', '{}', 'hil:agent-1', true, true, JSON.stringify({ reason: 'restricted' }))
    ;(executor as unknown as { executeAsyncTool(id: string, tool: string, input: unknown): void }).executeAsyncTool('task_a', 'mcp_x', { path: 'mind.md' })
    await vi.waitFor(() => expect(tasks.get('task_a')?.status).toBe('pending_approval'))

    expect(JSON.parse(tasks.get('task_a')!.approval_meta!)).toEqual({ reason: 'protection', protection })
    expect(tasks.get('task_a')).toMatchObject({ requires_authorization: true, executor_managed: true })
    const mine = writes.filter(([t]) => t === 'task_a').map(([, w]) => w)
    expect(mine.indexOf('meta')).toBeLessThan(mine.lastIndexOf('status:pending_approval'))
    expect(executor.getPendingApprovalMeta('task_a')?.reason).toBe('protection')
    executor.resolveHilTask('task_a', false)
    expect(tasks.get('task_a')?.status).toBe('denied')
  })

  it('non-restricted async task → protection override now requires authorized resolvers', async () => {
    const executeTool = vi.fn().mockResolvedValueOnce({ content: 'blocked', isError: true, protection })
    const { executor, tasks, workspace } = makeExecutor(executeTool)
    workspace.insertTask('task_b', 'mcp_x', '{}', 'agent')
    ;(executor as unknown as { executeAsyncTool(id: string, tool: string, input: unknown): void }).executeAsyncTool('task_b', 'mcp_x', {})
    await vi.waitFor(() => expect(tasks.get('task_b')?.status).toBe('pending_approval'))
    expect(tasks.get('task_b')).toMatchObject({ requires_authorization: true, executor_managed: true })
    expect(JSON.parse(tasks.get('task_b')!.approval_meta!).reason).toBe('protection')
    executor.resolveHilTask('task_b', false)
  })
})
