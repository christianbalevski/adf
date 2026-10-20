/**
 * A pending approval wait that ends with no decision (agent stop, owner state
 * change, a chat message during the turn) tells every client: the executor
 * emits `tool_approval_resolved` with `endedBy`, so no in-chat card is left
 * that nobody can answer, and the card can say why it ended.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentExecutor } from '../../../src/main/runtime/agent-executor'
import { approvalHub } from '../../../src/main/runtime/approval-hub'
import { createDispatch, createEvent } from '../../../src/shared/types/adf-event.types'
import type { AgentConfig } from '../../../src/shared/types/adf-v02.types'
import type { AgentExecutionEvent, ToolApprovalResolvedPayload } from '../../../src/shared/types/ipc.types'

function makeExecutor() {
  const tasks = new Map<string, { status: string }>()
  const workspace = {
    insertTask: (id: string) => { tasks.set(id, { status: 'pending' }) },
    updateTaskStatus: (id: string, status: string) => { tasks.set(id, { status }) },
    getTask: (id: string) => (tasks.has(id) ? { id, ...tasks.get(id) } : null),
    getFilePath: () => '/agents/agent-1.adf',
    insertLog: () => {},
  }
  const session = { getWorkspace: () => workspace } as never
  const config = {
    name: 'agent-1',
    id: '0b6f7a52-4a8e-4c0f-9d0e-3f1c2b7a9e11',
    tools: [{ name: 'fs_write', enabled: true, visible: true, restricted: true }],
    triggers: {},
    limits: {},
  } as unknown as AgentConfig
  const executor = new AgentExecutor(config, {} as never, { executeTool: vi.fn() } as never, session)
  const events: AgentExecutionEvent[] = []
  executor.on('event', (e: AgentExecutionEvent) => events.push(e))
  const resolved = () => events
    .filter((e) => e.type === 'tool_approval_resolved')
    .map((e) => e.payload as ToolApprovalResolvedPayload)
  return { executor, resolved }
}

beforeEach(() => { approvalHub.clear() })
afterEach(() => { approvalHub.clear() })

describe('a drained approval wait', () => {
  it('agent stop: each card gets tool_approval_resolved with endedBy stop', async () => {
    const { executor, resolved } = makeExecutor()
    const first = executor.requestHilApproval('fs_write', { path: 'a.md' })
    const second = executor.requestHilApproval('fs_write', { path: 'b.md' })

    executor.abort()

    expect(await first).toMatchObject({ approved: false })
    expect(await second).toMatchObject({ approved: false })
    const ids = executor.getPendingApprovals().map((p) => p.requestId)
    expect(ids).toEqual([])
    expect(resolved()).toHaveLength(2)
    expect(resolved().every((p) => p.approved === false && p.endedBy === 'stop')).toBe(true)
  })

  it('a chat message ending the wait: endedBy chat, and beside-turn approvals stay open', async () => {
    const { executor, resolved } = makeExecutor()
    // Raised with no agent turn running: a beside-turn approval, kept by the chat drain.
    const beside = executor.requestHilApproval('fs_write', { path: 'kept.md' })
    // Raised by a running turn.
    ;(executor as unknown as { activeAgentTurnCount: number }).activeAgentTurnCount = 1
    const inTurn = executor.requestHilApproval('fs_write', { path: 'ended.md' })
    const [besideTask, inTurnTask] = executor.getPendingApprovals().map((p) => p.requestId)

    // The chat arrives while the turn waits on the owner (executeTurn's chat branch).
    void executor.executeTurn(createDispatch(createEvent({
      type: 'chat',
      source: 'test',
      data: { message: { seq: 0, role: 'user', content_json: [{ type: 'text', text: 'stop, do this instead' }], created_at: Date.now() } },
    }), { scope: 'agent' }))

    expect(await inTurn).toMatchObject({ approved: false })
    expect(resolved()).toEqual([{ requestId: inTurnTask, approved: false, endedBy: 'chat' }])
    expect(executor.getPendingApprovals().map((p) => p.requestId)).toEqual([besideTask])
    executor.resolveApproval(besideTask, true)
    expect(await beside).toMatchObject({ approved: true })
  })

  it('an owner state change mid-wait: endedBy state', async () => {
    const { executor, resolved } = makeExecutor()
    ;(executor as unknown as { activeAgentTurnCount: number }).activeAgentTurnCount = 1
    const approval = executor.requestHilApproval('fs_write', { path: 'a.md' })

    executor.endTurnAndSetState('idle')

    expect(await approval).toMatchObject({ approved: false })
    expect(resolved().map((p) => p.endedBy)).toEqual(['state'])
  })

  it('a human decision carries no endedBy', async () => {
    const { executor, resolved } = makeExecutor()
    const approval = executor.requestHilApproval('fs_write', { path: 'a.md' })
    executor.resolveApproval(executor.getPendingApprovals()[0].requestId, false)
    await approval
    expect(resolved()).toHaveLength(1)
    expect(resolved()[0].endedBy).toBeUndefined()
  })
})
