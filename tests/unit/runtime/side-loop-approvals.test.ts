/**
 * Approvals raised by an inner loop, across the assembled agent.
 *
 * A request parks on the executor that raised it, and only that executor can
 * resume the call; answering on another one is a silent no-op. These tests
 * cover the agent-level paths that used to reach main only: the holder lookup
 * Studio's IPC resolves through, and `task_resolve` from code (a
 * remote-approval lambda) on main's handler and a loop's.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { MockLLMProvider } from '../../../src/main/runtime/headless'
import { assembleAgent, type AssembledAgent } from '../../../src/main/runtime/assemble-agent'
import { AdfCallHandler } from '../../../src/main/runtime/adf-call-handler'
import { findApprovalHolder, findAskHolder } from '../../../src/main/runtime/approval-holder'
import { approvalHub } from '../../../src/main/runtime/approval-hub'
import { withAuthorization } from '../../../src/main/runtime/authorization-context'
import { ToolRegistry } from '../../../src/main/tools/tool-registry'
import { registerBuiltInTools } from '../../../src/main/tools/built-in/register-built-in-tools'
import { clearAllUmbilicalBuses } from '../../../src/main/runtime/umbilical-bus'
import type { AgentExecutor } from '../../../src/main/runtime/agent-executor'

let dir: string
let workspace: AdfWorkspace
let agent: AssembledAgent<'headlessLive'>

/** Park an ask form on `executor` (`requestAsk` is private: only the ask tool path reaches it). */
function parkAsk(executor: AgentExecutor, question: string) {
  const asked = (executor as unknown as { requestAsk(q: Array<{ question: string }>): { requestId: string; answers: Promise<unknown> } }).requestAsk([{ question }])
  return asked
}

/** Park a blocking HIL request on `executor`; returns its task id and the promise the call awaits. */
function park(executor: AgentExecutor, tool = 'fs_write') {
  const promise = executor.requestHilApproval(tool, { path: 'a.md' })
  const pending = executor.getPendingApprovals()
  return { taskId: pending[pending.length - 1].requestId, promise }
}

beforeEach(async () => {
  approvalHub.clear()
  dir = mkdtempSync(join(tmpdir(), 'adf-side-loop-approvals-'))
  workspace = AdfWorkspace.create(join(dir, 'agent.adf'), { name: 'approvals', start_in_state: 'idle' })
  const config = workspace.getAgentConfig()
  const registry = new ToolRegistry()
  registerBuiltInTools(registry)
  const provider = new MockLLMProvider()
  agent = assembleAgent({
    profile: 'headlessLive',
    workspace,
    config,
    provider,
    registry,
    adfCallHandler: new AdfCallHandler({ toolRegistry: registry, workspace, config, provider }),
  })
  await agent.loopPool.createLoop({ name: 'reflector', goal: 'Notice what main missed.', enabled: true, tools: [] })
})

afterEach(() => {
  try { agent.dispose() } catch { /* already disposed */ }
  approvalHub.clear()
  clearAllUmbilicalBuses()
  rmSync(dir, { recursive: true, force: true })
})

describe('side-loop approvals on the assembled agent', () => {
  it('the hub row carries the loop, and the holder lookup finds the loop executor, not main', () => {
    const loopExecutor = agent.loopPool.getRuntime('reflector')!.executor
    const { taskId } = park(loopExecutor)

    expect(approvalHub.snapshot()).toEqual([expect.objectContaining({ requestId: taskId, loop: 'reflector' })])
    const holder = findApprovalHolder(agent.executor, agent.loopPool, taskId)
    expect(holder?.loop).toBe('reflector')
    expect(holder?.executor).toBe(loopExecutor)
    // Main does not hold it: resolving there is the silent no-op the lookup exists to avoid.
    expect(agent.executor.getPendingApprovalMeta(taskId)).toBeUndefined()
  })

  it('resolving through the holder resumes the loop executor', async () => {
    const loopExecutor = agent.loopPool.getRuntime('reflector')!.executor
    const { taskId, promise } = park(loopExecutor)
    findApprovalHolder(agent.executor, agent.loopPool, taskId)!.executor.resolveApproval(taskId, true)
    await expect(promise).resolves.toEqual(expect.objectContaining({ approved: true }))
    expect(approvalHub.snapshot()).toHaveLength(0)
  })

  it('task_resolve from main\'s code resumes the inner loop that holds the request', async () => {
    const loopExecutor = agent.loopPool.getRuntime('reflector')!.executor
    const handler = agent.adfCallHandler!

    const approved = park(loopExecutor)
    const res = await withAuthorization(true, () => handler.handleCall('task_resolve', { task_id: approved.taskId, action: 'approve' }))
    expect(res.error).toBeUndefined()
    await expect(approved.promise).resolves.toEqual(expect.objectContaining({ approved: true }))

    const denied = park(loopExecutor)
    await handler.handleCall('task_resolve', { task_id: denied.taskId, action: 'deny', reason: 'not now' })
    await expect(denied.promise).resolves.toEqual(expect.objectContaining({ approved: false, feedback: 'not now' }))
    expect(loopExecutor.getPendingApprovals()).toHaveLength(0)
  })

  it('task_resolve from a loop\'s code reaches main\'s request', async () => {
    const loopHandler = agent.loopPool.getRuntime('reflector')!.callHandler!
    const { taskId, promise } = park(agent.executor)
    await loopHandler.handleCall('task_resolve', { task_id: taskId, action: 'deny', reason: 'from the loop' })
    await expect(promise).resolves.toEqual(expect.objectContaining({ approved: false, feedback: 'from the loop' }))
  })

  it('a loop\'s pending_approval row reaches on_task_create, as main\'s does', () => {
    const onTaskCreate = vi.spyOn(agent.triggerEvaluator, 'onTaskCreate')
    const { taskId } = park(agent.loopPool.getRuntime('reflector')!.executor)
    expect(onTaskCreate).toHaveBeenCalledWith(expect.objectContaining({ id: taskId, status: 'pending_approval' }))
  })

  it('an ask reaches the loop that asked; ids are unique across loops', async () => {
    const loopExecutor = agent.loopPool.getRuntime('reflector')!.executor
    const mainAsk = parkAsk(agent.executor, 'main?')
    const loopAsk = parkAsk(loopExecutor, 'loop?')
    expect(loopAsk.requestId).not.toBe(mainAsk.requestId)

    const holder = findAskHolder(agent.executor, agent.loopPool, loopAsk.requestId)
    expect(holder?.loop).toBe('reflector')
    holder!.executor.resolveAsk(loopAsk.requestId, ['from the tab'])
    await expect(loopAsk.answers).resolves.toEqual(['from the tab'])
    expect(agent.executor.getPendingAsks()).toHaveLength(1)
    expect(findAskHolder(agent.executor, agent.loopPool, mainAsk.requestId)?.loop).toBe('main')
    // A named loop that does not hold the id finds nothing.
    expect(findAskHolder(agent.executor, agent.loopPool, mainAsk.requestId, 'reflector')).toBeUndefined()
  })
})
