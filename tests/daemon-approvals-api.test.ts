// Approvals hub routes (W1-D). Studio's APPROVALS_LIST / _GET_INPUT /
// _RESOLVE handlers are one-line calls into the process-wide approvalHub, so
// the parity reference for each route is that same hub call on the same state.
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDaemonHttpApi } from '../src/main/daemon/http-api'
import { approvalHub, notificationKey } from '../src/main/runtime/approval-hub'
import { RuntimeService } from '../src/main/runtime/runtime-service'
import type { PendingNotification } from '../src/shared/types/ipc.types'

const FILE_1 = '/agents/agent-1.adf'
const FILE_2 = '/agents/agent-2.adf'

function approval(filePath: string, requestId: string, loop = 'main', resolve?: (approved: boolean, feedback?: string) => void): PendingNotification & { resolve?: (approved: boolean, feedback?: string) => void } {
  return {
    id: notificationKey(filePath, loop, requestId),
    kind: 'approval',
    requestId,
    filePath,
    agentName: 'agent-1',
    loop,
    toolName: 'fs_write',
    preview: '{"path":"a.txt","content":"<5 chars>"}',
    input: { path: 'a.txt', content: 'hello' },
    reason: 'restricted',
    canAlwaysApprove: true,
    requestedAt: Date.now(),
    resolve,
  }
}

function ask(filePath: string, requestId: string): PendingNotification {
  return {
    id: notificationKey(filePath, 'main', requestId),
    kind: 'ask',
    requestId,
    filePath,
    agentName: 'agent-2',
    loop: 'main',
    preview: 'Which folder?',
    question: 'Which folder?',
    requestedAt: Date.now(),
  }
}

const servers: Array<{ close(): Promise<unknown> }> = []
afterEach(async () => {
  approvalHub.clear()
  for (const s of servers.splice(0)) await s.close()
})

function setup() {
  const server = createDaemonHttpApi(new RuntimeService({ enforceReviewGate: false }))
  servers.push(server)
  return server
}

describe('approvals hub routes', () => {
  it('GET /approvals returns the hub snapshot Studio returns', async () => {
    const server = setup()
    approvalHub.register(approval(FILE_1, randomUUID(), 'main', () => {}))
    approvalHub.register(ask(FILE_2, 'ask_1'))
    approvalHub.unregister(notificationKey(FILE_2, 'main', 'ask_1'), 'answered')
    approvalHub.register(ask(FILE_2, 'ask_2'))

    const res = await server.inject({ method: 'GET', url: '/approvals' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(JSON.parse(JSON.stringify(approvalHub.fullSnapshot())))
    // The broadcast snapshot never carries raw tool input.
    expect(JSON.stringify(res.json())).not.toContain('hello')
  })

  it('GET /approvals/input returns the raw input, {} when gone or another file', async () => {
    const server = setup()
    const entry = approval(FILE_1, randomUUID(), 'main', () => {})
    approvalHub.register(entry)

    const ok = await server.inject({ method: 'GET', url: `/approvals/input?filePath=${encodeURIComponent(FILE_1)}&approvalId=${encodeURIComponent(entry.id)}` })
    expect(ok.json()).toEqual({ input: approvalHub.getApprovalInput(FILE_1, entry.id) })

    const other = await server.inject({ method: 'GET', url: `/approvals/input?filePath=${encodeURIComponent(FILE_2)}&approvalId=${encodeURIComponent(entry.id)}` })
    expect(other.json()).toEqual({})
    expect(approvalHub.getApprovalInput(FILE_2, entry.id)).toBeUndefined()

    const missing = await server.inject({ method: 'GET', url: '/approvals/input?filePath=x' })
    expect(missing.statusCode).toBe(400)
  })

  it('POST /approvals/resolve routes into the entry callback and answers as the hub does', async () => {
    const server = setup()
    const resolve = vi.fn()
    const entry = approval(FILE_1, randomUUID(), 'main', resolve)
    approvalHub.register(entry)

    const wrongFile = await server.inject({ method: 'POST', url: '/approvals/resolve', payload: { filePath: FILE_2, approvalId: entry.id, approved: true } })
    expect(wrongFile.json()).toEqual({ success: false, error: 'Approval belongs to a different agent.' })

    const res = await server.inject({ method: 'POST', url: '/approvals/resolve', payload: { filePath: FILE_1, approvalId: entry.id, approved: false, feedback: 'not now' } })
    expect(res.json()).toEqual({ success: true })
    expect(resolve).toHaveBeenCalledWith(false, 'not now')
    expect(approvalHub.historySnapshot()[0]).toMatchObject({ id: entry.id, outcome: 'rejected' })

    const again = await server.inject({ method: 'POST', url: '/approvals/resolve', payload: { filePath: FILE_1, approvalId: entry.id, approved: true } })
    expect(again.json()).toEqual(approvalHub.resolve(FILE_1, entry.id, true))

    const askEntry = ask(FILE_2, 'ask_9')
    approvalHub.register(askEntry)
    const askRes = await server.inject({ method: 'POST', url: '/approvals/resolve', payload: { filePath: FILE_2, approvalId: askEntry.id, approved: true } })
    expect(askRes.json()).toEqual({ success: false, error: 'This request needs a typed answer — open the agent to respond.' })

    const bad = await server.inject({ method: 'POST', url: '/approvals/resolve', payload: {} })
    expect(bad.json()).toEqual({ success: false, error: 'filePath and approvalId are required' })
  })

  it('GET /approvals/interactions lists main-loop asks then approvals per agent, with input', async () => {
    const server = setup()
    const a1 = approval(FILE_1, 'task-1', 'main', () => {})
    approvalHub.register(a1)
    approvalHub.register(approval(FILE_1, 'task-2', 'critic', () => {}))
    approvalHub.register(ask(FILE_1, 'ask_1'))

    const res = await server.inject({ method: 'GET', url: '/approvals/interactions' })
    expect(res.json()).toEqual([
      { filePath: FILE_1, handle: 'agent-1', type: 'ask', requestId: 'ask_1', question: 'Which folder?' },
      {
        filePath: FILE_1,
        handle: 'agent-1',
        type: 'approval',
        requestId: 'task-1',
        toolName: 'fs_write',
        input: { path: 'a.txt', content: 'hello' },
        reason: 'restricted',
        canAlwaysApprove: true,
      },
    ])
  })
})
