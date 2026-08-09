/**
 * AgentExecutor protection→HIL contract.
 *
 * requestProtectionApproval is the blocking override primitive used by the
 * shell gate and the adf_call sandbox: it must emit a tool_approval_request
 * carrying protection meta (reason 'protection', canAlwaysApprove false),
 * close the task itself on resolve, honor the auto-deny timeout, and expose
 * meta via getPendingApprovalMeta for the server-side always-approve refusal.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { AgentExecutor } from '../../../src/main/runtime/agent-executor'
import type { AgentConfig } from '../../../src/shared/types/adf-v02.types'
import type { AgentExecutionEvent } from '../../../src/shared/types/ipc.types'

function makeExecutor(toolOverrides: Array<Record<string, unknown>> = []) {
  const tasks = new Map<string, { status: string; result?: string; error?: string }>()
  const workspace = {
    insertTask: (id: string) => { tasks.set(id, { status: 'pending' }) },
    updateTaskStatus: (id: string, status: string, result?: string, error?: string) => {
      tasks.set(id, { status, result, error })
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
      { name: 'sys_update_config', enabled: true, visible: true, restricted: true, locked: true },
      { name: 'compute_exec', enabled: true, visible: true, restricted: true },
      ...toolOverrides,
    ],
    triggers: {},
    limits: {},
  } as unknown as AgentConfig
  const executor = new AgentExecutor(config, {} as never, { executeTool: vi.fn() } as never, session)
  const events: AgentExecutionEvent[] = []
  executor.on('event', (e: AgentExecutionEvent) => events.push(e))
  return { executor, events, tasks }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('requestProtectionApproval', () => {
  const protection = { kind: 'file_protection' as const, target: 'mind.md', level: 'no_delete' }

  it('emits tool_approval_request with protection meta; approve closes the task', async () => {
    const { executor, events, tasks } = makeExecutor()
    const promise = executor.requestProtectionApproval('fs_delete', { path: 'mind.md' }, protection, { timeoutMs: null })

    const req = events.find(e => e.type === 'tool_approval_request')
    expect(req).toBeDefined()
    const payload = req!.payload as Record<string, unknown>
    expect(payload.reason).toBe('protection')
    expect(payload.protection).toEqual(protection)
    expect(payload.canAlwaysApprove).toBe(false)
    expect(payload.alwaysApproveBlockedReason).toContain('no_delete')

    const requestId = payload.requestId as string
    expect(executor.getPendingApprovalMeta(requestId)?.canAlwaysApprove).toBe(false)

    executor.resolveHilTask(requestId, true)
    const decision = await promise
    expect(decision.approved).toBe(true)
    expect(tasks.get(requestId)?.status).toBe('completed')
  })

  it('deny carries feedback and marks the task denied', async () => {
    const { executor, events, tasks } = makeExecutor()
    const promise = executor.requestProtectionApproval('fs_delete', { path: 'mind.md' }, protection, { timeoutMs: null })
    const requestId = (events.find(e => e.type === 'tool_approval_request')!.payload as { requestId: string }).requestId

    executor.resolveHilTask(requestId, false, undefined, 'leave it alone')
    const decision = await promise
    expect(decision.approved).toBe(false)
    expect(decision.feedback).toBe('leave it alone')
    expect(tasks.get(requestId)?.status).toBe('denied')
    expect(tasks.get(requestId)?.error).toBe('leave it alone')
  })

  it('auto-denies after the timeout', async () => {
    vi.useFakeTimers()
    const { executor, tasks, events } = makeExecutor()
    const promise = executor.requestProtectionApproval('fs_delete', { path: 'mind.md' }, protection, { timeoutMs: 1000 })
    vi.advanceTimersByTime(1001)
    const decision = await promise
    expect(decision.approved).toBe(false)
    const requestId = (events.find(e => e.type === 'tool_approval_request')!.payload as { requestId: string }).requestId
    expect(tasks.get(requestId)?.status).toBe('denied')
  })

  it('abort resolves a pending protection approval as denied', async () => {
    const { executor } = makeExecutor()
    const promise = executor.requestProtectionApproval('fs_delete', { path: 'mind.md' }, protection, { timeoutMs: null })
    executor.abort()
    const decision = await promise
    expect(decision.approved).toBe(false)
  })
})

describe('approval meta for restricted tools', () => {
  it('locked declaration → canAlwaysApprove false with reason', async () => {
    const { executor, events } = makeExecutor()
    void executor.requestHilApproval('sys_update_config', { path: 'x', value: 1 })
    const payload = events.find(e => e.type === 'tool_approval_request')!.payload as Record<string, unknown>
    expect(payload.reason).toBe('restricted')
    expect(payload.canAlwaysApprove).toBe(false)
    expect(payload.alwaysApproveBlockedReason).toBe('Tool declaration is locked')
    executor.abort()
  })

  it('unlocked restricted declaration → canAlwaysApprove true', async () => {
    const { executor, events } = makeExecutor()
    void executor.requestHilApproval('compute_exec', { code: '1' })
    const payload = events.find(e => e.type === 'tool_approval_request')!.payload as Record<string, unknown>
    expect(payload.reason).toBe('restricted')
    expect(payload.canAlwaysApprove).toBe(true)
    executor.abort()
  })

  it('getPendingApprovals returns meta for UI rehydration', async () => {
    const { executor } = makeExecutor()
    void executor.requestHilApproval('sys_update_config', { path: 'x', value: 1 })
    const pending = executor.getPendingApprovals()
    expect(pending).toHaveLength(1)
    expect(pending[0].canAlwaysApprove).toBe(false)
    executor.abort()
  })
})

describe('approveAllGatedHilTasks (batch approve, gated only)', () => {
  const protection = { kind: 'file_protection' as const, target: 'mind.md', level: 'no_delete' }

  it('approves every restricted task and SKIPS protection overrides', async () => {
    const { executor } = makeExecutor()

    // Two gated (reason 'restricted') approvals + one protection override.
    const gated1 = executor.requestHilApproval('fs_delete', { path: 'a.txt' })
    const gated2 = executor.requestHilApproval('compute_exec', { code: '1' })
    let protectionResolved = false
    const prot = executor
      .requestProtectionApproval('fs_delete', { path: 'mind.md' }, protection, { timeoutMs: null })
      .then((d) => { protectionResolved = true; return d })

    expect(executor.getPendingApprovals()).toHaveLength(3)

    const result = executor.approveAllGatedHilTasks()
    expect(result).toEqual({ approved: 2, skippedProtection: 1 })

    // The two gated approvals resolved as approved…
    expect((await gated1).approved).toBe(true)
    expect((await gated2).approved).toBe(true)

    // …while the protection override stays pending — batch never touches it.
    await Promise.resolve()
    expect(protectionResolved).toBe(false)
    const stillPending = executor.getPendingApprovals()
    expect(stillPending).toHaveLength(1)
    expect(stillPending[0].reason).toBe('protection')

    executor.abort()
    await prot
  })

  it('reports zero approved when only protection approvals are pending', async () => {
    const { executor } = makeExecutor()
    void executor.requestProtectionApproval('fs_delete', { path: 'mind.md' }, protection, { timeoutMs: null })

    const result = executor.approveAllGatedHilTasks()
    expect(result).toEqual({ approved: 0, skippedProtection: 1 })
    expect(executor.getPendingApprovals()).toHaveLength(1)
    executor.abort()
  })
})
