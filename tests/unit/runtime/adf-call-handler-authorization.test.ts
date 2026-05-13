/**
 * AdfCallHandler authorization scoping — regression coverage.
 *
 * Pins the bug where the handler's single `isAuthorized` field could be
 * clobbered between an authorized lambda's setAuthorizationContext(true) and
 * its later task_resolve call (e.g. by a concurrent sys_code, a nested
 * sys_lambda to an unauthorized helper, or another trigger fanning out).
 *
 * The fix routes per-call authorization through AsyncLocalStorage; these
 * tests exercise handleCall directly under different ALS scopes.
 */

import { describe, expect, it } from 'vitest'
import { AdfCallHandler } from '../../../src/main/runtime/adf-call-handler'
import { withAuthorization } from '../../../src/main/runtime/authorization-context'
import type { AgentConfig } from '../../../src/shared/types/adf-v02.types'

interface TaskRow {
  id: string
  tool: string
  args: string
  status: string
  requires_authorization: boolean
  executor_managed: boolean
  result?: string
  error?: string
}

function makeHandler(taskOverrides: Partial<TaskRow> = {}) {
  const task: TaskRow = {
    id: 'task_test',
    tool: 'fs_write',
    args: '{}',
    status: 'pending_approval',
    requires_authorization: true,
    executor_managed: true,
    ...taskOverrides,
  }

  const logs: Array<{ level: string; message: string }> = []
  const statusUpdates: Array<{ id: string; status: string }> = []
  const hilSignals: Array<{ id: string; approved: boolean }> = []

  const workspace = {
    getTask: (id: string) => (id === task.id ? { ...task } : null),
    updateTaskStatus: (id: string, status: string) => {
      task.status = status
      statusUpdates.push({ id, status })
    },
    setTaskRequiresAuthorization: () => { /* unused in these tests */ },
    insertLog: (level: string, _origin: string, _event: string | null, _target: string | null, message: string) => {
      logs.push({ level, message })
    },
    isFileAuthorized: () => false,
  }

  const config: AgentConfig = {
    name: 'test-agent',
    id: 'test-agent',
    tools: [],
    code_execution: {
      task_resolve: true,
      // Disable everything else so the test can't accidentally land in those branches.
      model_invoke: false,
      sys_lambda: false,
      loop_inject: false,
      get_identity: false,
      set_identity: false,
      emit_event: false,
    } as AgentConfig['code_execution'],
  } as unknown as AgentConfig

  const handler = new AdfCallHandler({
    toolRegistry: { get: () => null, executeTool: async () => ({ content: '', isError: false }) } as never,
    workspace: workspace as never,
    config,
    provider: {} as never,
  })

  handler.onHilApproved = (id, approved) => {
    hilSignals.push({ id, approved })
  }

  return { handler, task, logs, statusUpdates, hilSignals }
}

describe('AdfCallHandler authorization scoping', () => {
  it('rejects task_resolve on a HIL task when no ALS auth scope is set and the legacy field is false', async () => {
    const { handler } = makeHandler()
    const result = await handler.handleCall('task_resolve', { task_id: 'task_test', action: 'approve' })
    expect(result.errorCode).toBe('REQUIRES_AUTHORIZED_CODE')
  })

  it('approves task_resolve when wrapped in withAuthorization(true) — even with the legacy field still false', async () => {
    const { handler, hilSignals } = makeHandler()
    // Intentionally do NOT call setAuthorizationContext — ALS alone must be
    // sufficient to authorize the call.
    const result = await withAuthorization(true, () =>
      handler.handleCall('task_resolve', { task_id: 'task_test', action: 'approve' })
    )
    expect(result.error).toBeUndefined()
    expect(result.result).toContain('approved')
    expect(hilSignals).toEqual([{ id: 'task_test', approved: true }])
  })

  it('regression: an authorized scope that ran a nested unauthorized scope still resolves task_resolve', async () => {
    const { handler, hilSignals } = makeHandler()

    // Models the bug: an authorized lambda calls a nested unauthorized lambda
    // (which previously clobbered the field), and then calls task_resolve.
    const result = await withAuthorization(true, async () => {
      await withAuthorization(false, async () => {
        // Inner unauthorized work — handler must see auth=false here.
        const innerCheck = await handler.handleCall('task_resolve', { task_id: 'task_test', action: 'pending_approval' })
        expect(innerCheck.error).toBeUndefined()
      })
      // Back in the outer authorized scope. Pre-fix this returned
      // REQUIRES_AUTHORIZED_CODE because the field was now false.
      return handler.handleCall('task_resolve', { task_id: 'task_test', action: 'approve' })
    })

    expect(result.error).toBeUndefined()
    expect(result.result).toContain('approved')
    expect(hilSignals).toEqual([{ id: 'task_test', approved: true }])
  })

  it('regression: a concurrent unauthorized scope cannot hijack an authorized scope mid-await', async () => {
    // Two distinct tasks so neither call can interfere with the other's
    // status transitions — we want to isolate the authorization scoping
    // question from the task lifecycle question.
    const a = makeHandler({ id: 'task_a' })
    const b = makeHandler({ id: 'task_b' })

    // Models a system-scope authorized lambda fanning out at the same time
    // as an unauthorized sys_code call from the LLM loop. Pre-fix, the
    // unauthorized call's setAuthorizationContext(false) would clobber the
    // authorized handler's field before the authorized call resolved.
    const authorizedCall = withAuthorization(true, async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
      return a.handler.handleCall('task_resolve', { task_id: 'task_a', action: 'approve' })
    })
    const unauthorizedCall = withAuthorization(false, async () => {
      await new Promise(resolve => setTimeout(resolve, 1))
      return b.handler.handleCall('task_resolve', { task_id: 'task_b', action: 'approve' })
    })

    const [authorized, unauthorized] = await Promise.all([authorizedCall, unauthorizedCall])
    expect(authorized.errorCode).toBeUndefined()
    expect(unauthorized.errorCode).toBe('REQUIRES_AUTHORIZED_CODE')
    expect(a.hilSignals).toEqual([{ id: 'task_a', approved: true }])
    expect(b.hilSignals).toEqual([])
  })

  it('legacy setAuthorizationContext still works for callers that haven\'t migrated', async () => {
    const { handler, hilSignals } = makeHandler({ id: 'task_legacy' })
    handler.setAuthorizationContext(true)
    const result = await handler.handleCall('task_resolve', { task_id: 'task_legacy', action: 'approve' })
    expect(result.error).toBeUndefined()
    expect(hilSignals).toEqual([{ id: 'task_legacy', approved: true }])
  })

  it('ALS auth=false overrides the legacy field when set to true', async () => {
    const { handler } = makeHandler({ id: 'task_als_wins' })
    handler.setAuthorizationContext(true)
    const result = await withAuthorization(false, () =>
      handler.handleCall('task_resolve', { task_id: 'task_als_wins', action: 'approve' })
    )
    expect(result.errorCode).toBe('REQUIRES_AUTHORIZED_CODE')
  })
})
