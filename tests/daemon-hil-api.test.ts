import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  const dir = join(tmpdir(), `adf-daemon-hil-api-${process.pid}`)
  return {
    app: {
      getPath: () => dir,
      on: () => {},
      getName: () => 'adf-daemon-hil-api-test',
      getVersion: () => '0.0.0-test',
    },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (s: string) => Buffer.from(s, 'utf-8'),
      decryptString: (b: Buffer) => b.toString('utf-8'),
    },
    shell: { openExternal: async () => {} },
    ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
    BrowserWindow: class {},
    dialog: {},
  }
})

import { createDaemonHttpApi } from '../src/main/daemon/http-api'
import { DaemonEventBus, type DaemonEventEnvelope } from '../src/main/daemon/event-bus'
import { registerDaemonEventBus } from '../src/main/runtime/emit-umbilical'
import { RuntimeService } from '../src/main/runtime/runtime-service'
import { MockLLMProvider } from '../src/main/runtime/headless'
import type { AgentExecutor } from '../src/main/runtime/agent-executor'
import type { AgentConfig } from '../src/shared/types/adf-v02.types'

const servers: Array<{ close: () => Promise<unknown> }> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()))
})

interface ManagedView {
  config: AgentConfig
  agent: { executor: AgentExecutor; loopPool: { getRuntime(name: string): { executor: AgentExecutor } | null | undefined } }
}

function setup() {
  const runtime = new RuntimeService({ enforceReviewGate: false })
  const ref = runtime.createAgent({ name: 'agent-1', provider: new MockLLMProvider({ tokensPerResponse: 40 }) })
  const server = createDaemonHttpApi(runtime)
  servers.push(server)
  const managed = () => (runtime as unknown as { requireAgent(id: string): ManagedView }).requireAgent(ref.id)
  return { runtime, ref, server, managed }
}

/** Park a blocking HIL request on `executor` and return its task id + the promise the agent awaits. */
function park(executor: AgentExecutor, tool: string, input: unknown = { path: 'a.md' }) {
  const promise = executor.requestHilApproval(tool, input)
  const pending = executor.getPendingApprovals()
  const taskId = pending[pending.length - 1].requestId
  return { taskId, promise }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 50))

describe('daemon HIL approval API (Studio parity)', () => {
  it('hands a deny reason back to the agent as feedback', async () => {
    const { ref, server, managed } = setup()
    const { taskId, promise } = park(managed().agent.executor, 'fs_write')

    const res = await server.inject({
      method: 'POST',
      url: `/agents/${ref.id}/tasks/${taskId}/resolve`,
      payload: { action: 'deny', reason: 'write to notes/ instead' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().task).toEqual(expect.objectContaining({ status: 'denied', error: 'write to notes/ instead' }))
    await expect(promise).resolves.toEqual(expect.objectContaining({ approved: false, feedback: 'write to notes/ instead' }))
  })

  it('surfaces canAlwaysApprove on task entries and hil.requested events', async () => {
    const bus = new DaemonEventBus(500)
    registerDaemonEventBus(bus)
    const seen: DaemonEventEnvelope[] = []
    const unsubscribe = bus.subscribe(envelope => seen.push(envelope))
    try {
      const { ref, server, managed } = setup()
      const executor = managed().agent.executor
      const gated = park(executor, 'fs_write')
      void executor.requestApproval('mcp_oauth_signin', { server: 'x' }, { canAlwaysApprove: false })
      const oneShot = executor.getPendingApprovals().find(a => a.name === 'mcp_oauth_signin')!.requestId

      const list = await server.inject({ method: 'GET', url: `/agents/${ref.id}/tasks?status=pending_approval` })
      expect(list.statusCode).toBe(200)
      const byId = new Map(list.json().tasks.map((t: { id: string }) => [t.id, t]))
      expect(byId.get(gated.taskId)).toEqual(expect.objectContaining({ canAlwaysApprove: true }))
      expect(byId.get(oneShot)).toEqual(expect.objectContaining({
        canAlwaysApprove: false,
        alwaysApproveBlockedReason: 'One-time approval only for this request',
      }))

      const one = await server.inject({ method: 'GET', url: `/agents/${ref.id}/tasks/${oneShot}` })
      expect(one.json().task).toEqual(expect.objectContaining({ canAlwaysApprove: false }))

      const requested = seen.filter(e => e.event.agent_id === ref.id && e.event.event_type === 'hil.requested')
      const payloadOf = (id: string) => requested.find(e => (e.event.payload as { task_id: string }).task_id === id)!.event.payload
      expect(payloadOf(gated.taskId)).toEqual(expect.objectContaining({ can_always_approve: true }))
      expect(payloadOf(gated.taskId)).not.toHaveProperty('always_approve_blocked_reason')
      expect(payloadOf(oneShot)).toEqual(expect.objectContaining({
        can_always_approve: false,
        always_approve_blocked_reason: 'One-time approval only for this request',
      }))
    } finally {
      unsubscribe()
    }
  })

  it('always-approve un-restricts the host tool declaration, persists it and approves the request', async () => {
    const { ref, server, managed } = setup()
    // Make fs_write gated first, the way an owner would.
    const cfg = (await server.inject({ method: 'GET', url: `/agents/${ref.id}/config` })).json().config as AgentConfig
    const tools = cfg.tools.some(t => t.name === 'fs_write')
      ? cfg.tools.map(t => t.name === 'fs_write' ? { ...t, enabled: true, restricted: true } : t)
      : [...cfg.tools, { name: 'fs_write', enabled: true, visible: true, restricted: true }]
    expect((await server.inject({ method: 'PUT', url: `/agents/${ref.id}/config`, payload: { ...cfg, tools } })).statusCode).toBe(200)

    const { taskId, promise } = park(managed().agent.executor, 'fs_write')
    const res = await server.inject({ method: 'POST', url: `/agents/${ref.id}/tasks/${taskId}/always-approve`, payload: { toolName: 'sys_update_config' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(expect.objectContaining({
      agentId: ref.id, taskId, loop: 'main', tool: 'fs_write',
      resolution: expect.objectContaining({ status: 'approved' }),
    }))
    await expect(promise).resolves.toEqual(expect.objectContaining({ approved: true }))

    // Tool name came from the pending request — the body's toolName is ignored.
    const after = (await server.inject({ method: 'GET', url: `/agents/${ref.id}/config` })).json().config as AgentConfig
    expect(after.tools.find(t => t.name === 'fs_write')).toEqual(expect.objectContaining({ enabled: true, restricted: false }))
    expect(after.tools.find(t => t.name === 'sys_update_config')?.restricted ?? null).not.toBe(false)
    // Propagated to the live executor.
    expect(managed().agent.executor.getConfig().tools.find(t => t.name === 'fs_write')).toEqual(expect.objectContaining({ restricted: false }))

    // Already resolved → 409; unknown → 404.
    expect((await server.inject({ method: 'POST', url: `/agents/${ref.id}/tasks/${taskId}/always-approve` })).statusCode).toBe(409)
    expect((await server.inject({ method: 'POST', url: `/agents/${ref.id}/tasks/task_nope/always-approve` })).statusCode).toBe(404)
  })

  it('refuses always-approve for protection overrides, one-shot approvals and locked declarations', async () => {
    const { ref, server, managed } = setup()
    const executor = managed().agent.executor

    // Protection override: one-time only.
    void executor.requestProtectionApproval('fs_delete', { path: 'mind.md' }, {
      kind: 'file', target: 'mind.md', level: 'no_delete', description: 'Delete mind.md',
    } as never, { timeoutMs: null })
    const protectionId = executor.getPendingApprovals().find(a => a.name === 'fs_delete')!.requestId
    const protection = await server.inject({ method: 'POST', url: `/agents/${ref.id}/tasks/${protectionId}/always-approve` })
    expect(protection.statusCode).toBe(409)
    expect(protection.json().error).toBe('Target is locked (no_delete)')

    // Synthetic one-shot approval.
    void executor.requestApproval('mcp_oauth_signin', { server: 'x' }, { canAlwaysApprove: false })
    const oneShotId = executor.getPendingApprovals().find(a => a.name === 'mcp_oauth_signin')!.requestId
    const oneShot = await server.inject({ method: 'POST', url: `/agents/${ref.id}/tasks/${oneShotId}/always-approve` })
    expect(oneShot.statusCode).toBe(409)
    expect(oneShot.json().error).toBe('One-time approval only for this request')

    // Declaration locked AFTER the request was parked: the live host config wins.
    const gated = park(executor, 'fs_write')
    const cfg = (await server.inject({ method: 'GET', url: `/agents/${ref.id}/config` })).json().config as AgentConfig
    const tools = cfg.tools.some(t => t.name === 'fs_write')
      ? cfg.tools.map(t => t.name === 'fs_write' ? { ...t, restricted: true, locked: true } : t)
      : [...cfg.tools, { name: 'fs_write', enabled: true, visible: true, restricted: true, locked: true }]
    await server.inject({ method: 'PUT', url: `/agents/${ref.id}/config`, payload: { ...cfg, tools } })
    const listed = (await server.inject({ method: 'GET', url: `/agents/${ref.id}/tasks/${gated.taskId}` })).json().task
    expect(listed).toEqual(expect.objectContaining({ canAlwaysApprove: false, alwaysApproveBlockedReason: 'Tool declaration is locked' }))
    const locked = await server.inject({ method: 'POST', url: `/agents/${ref.id}/tasks/${gated.taskId}/always-approve` })
    expect(locked.statusCode).toBe(409)
    expect(locked.json().error).toBe('Tool declaration is locked')

    // Nothing was approved and nothing un-restricted.
    expect(executor.getPendingApprovals()).toHaveLength(3)
    const after = (await server.inject({ method: 'GET', url: `/agents/${ref.id}/config` })).json().config as AgentConfig
    expect(after.tools.find(t => t.name === 'fs_write')).toEqual(expect.objectContaining({ restricted: true, locked: true }))
    expect(after.tools.find(t => t.name === 'fs_delete')?.restricted).not.toBe(false)

    const rt = (await server.inject({ method: 'GET', url: `/agents/${ref.id}/tasks?status=pending_approval` })).json().tasks
    expect(rt).toHaveLength(3)
  })

  it('approve-all approves gated requests and skips protection overrides', async () => {
    const { ref, server, managed } = setup()
    const executor = managed().agent.executor
    const a = park(executor, 'fs_write', { path: 'a.md' })
    const b = park(executor, 'fs_write', { path: 'b.md' })
    void executor.requestProtectionApproval('fs_delete', { path: 'mind.md' }, {
      kind: 'file', target: 'mind.md', level: 'no_delete', description: 'Delete mind.md',
    } as never, { timeoutMs: null })

    const res = await server.inject({ method: 'POST', url: `/agents/${ref.id}/tasks/approve-all` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ agentId: ref.id, approved: 2, skippedProtection: 1 })
    await expect(a.promise).resolves.toEqual(expect.objectContaining({ approved: true }))
    await expect(b.promise).resolves.toEqual(expect.objectContaining({ approved: true }))
    expect(executor.getPendingApprovals().map(p => p.name)).toEqual(['fs_delete'])

    const scoped = await server.inject({ method: 'POST', url: `/agents/${ref.id}/tasks/approve-all?loop=main` })
    expect(scoped.json()).toEqual({ agentId: ref.id, loop: 'main', approved: 0, skippedProtection: 1 })
    expect((await server.inject({ method: 'POST', url: `/agents/${ref.id}/tasks/approve-all`, payload: { loop: 'nope' } })).statusCode).toBe(404)
  })

  it('routes resolve / always-approve to the inner loop executor that holds the request', async () => {
    const { ref, server, managed } = setup()
    await server.inject({ method: 'POST', url: `/agents/${ref.id}/loops`, payload: { name: 'researcher', goal: 'Research.', autostart: false } })
    await server.inject({ method: 'POST', url: `/agents/${ref.id}/chat`, payload: { text: 'side', loop: 'researcher' } })
    await settle()
    const loopExecutor = managed().agent.loopPool.getRuntime('researcher')?.executor
    expect(loopExecutor).toBeTruthy()

    // Side loops fail closed on restricted tools in practice; park one directly
    // to prove the owner API still reaches the right executor if one exists.
    const denied = park(loopExecutor!, 'fs_write')
    const deny = await server.inject({ method: 'POST', url: `/agents/${ref.id}/tasks/${denied.taskId}/resolve`, payload: { action: 'deny', reason: 'not from a side loop' } })
    expect(deny.statusCode).toBe(200)
    await expect(denied.promise).resolves.toEqual(expect.objectContaining({ approved: false, feedback: 'not from a side loop' }))

    const gated = park(loopExecutor!, 'fs_write')
    const always = await server.inject({ method: 'POST', url: `/agents/${ref.id}/tasks/${gated.taskId}/always-approve` })
    expect(always.statusCode).toBe(200)
    expect(always.json()).toEqual(expect.objectContaining({ loop: 'researcher', tool: 'fs_write' }))
    await expect(gated.promise).resolves.toEqual(expect.objectContaining({ approved: true }))
    // The HOST declaration is what changes.
    expect(managed().config.tools.find(t => t.name === 'fs_write')).toEqual(expect.objectContaining({ enabled: true, restricted: false }))
  })
})
