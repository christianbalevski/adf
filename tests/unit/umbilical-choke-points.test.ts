/**
 * Phase 1a choke-point emission.
 *
 * tool.* now comes from ToolRegistry.executeTool — the single choke point every
 * caller funnels through (LLM loop, sandbox `adf.*`, shell pipeline) — so a
 * code-driven call is observable without going anywhere near the executor.
 * `file.written`, `config.changed`, and `message.queued` likewise moved onto
 * AdfWorkspace, and the executor emits hil.* around its approval primitives.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { z } from 'zod'
import { registerDaemonEventBus } from '../../src/main/runtime/emit-umbilical'
import { DaemonEventBus } from '../../src/main/daemon/event-bus'
import { clearAllUmbilicalBuses } from '../../src/main/runtime/umbilical-bus'
import { withSource } from '../../src/main/runtime/execution-context'
import { ToolRegistry } from '../../src/main/tools/tool-registry'
import type { Tool } from '../../src/main/tools/tool.interface'
import type { ToolResult } from '../../src/shared/types/tool.types'
import type { AdfWorkspace } from '../../src/main/adf/adf-workspace'
import { AdfWorkspace as Workspace } from '../../src/main/adf/adf-workspace'
import { AgentExecutor } from '../../src/main/runtime/agent-executor'
import type { AgentConfig } from '../../src/shared/types/adf-v02.types'
import type { AgentExecutionEvent } from '../../src/shared/types/ipc.types'
import type { UmbilicalEvent } from '../../src/main/runtime/umbilical-bus'

const AGENT_ID = '00000000-0000-0000-0000-0000000000a1'

/** Fresh daemon bus per test; it receives every emission regardless of agent bus. */
function captureEvents(): { events: UmbilicalEvent[]; types: () => string[] } {
  const bus = new DaemonEventBus(500)
  registerDaemonEventBus(bus)
  const events: UmbilicalEvent[] = []
  bus.subscribe(frame => events.push(frame.event))
  return { events, types: () => events.map(e => e.event_type) }
}

afterEach(() => {
  clearAllUmbilicalBuses()
  registerDaemonEventBus(new DaemonEventBus(100))
})

class EchoTool implements Tool {
  readonly name = 'echo_tool'
  readonly description = 'echo'
  readonly inputSchema = z.object({ text: z.string() })
  readonly category = 'general' as const
  constructor(private readonly impl: (input: unknown) => ToolResult | Promise<ToolResult>) {}
  async execute(input: unknown): Promise<ToolResult> {
    return this.impl(input)
  }
  toProviderFormat() {
    return { name: this.name, description: this.description, input_schema: {} }
  }
}

function registryWith(impl: (input: unknown) => ToolResult | Promise<ToolResult>): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(new EchoTool(impl))
  return registry
}

const fakeWorkspace = { getFilePath: () => '/tmp/agent-1.adf' } as unknown as AdfWorkspace

describe('tool.* from the ToolRegistry choke point', () => {
  it('emits started + completed for a code-driven call (no executor involved)', async () => {
    const { events, types } = captureEvents()
    const registry = registryWith(() => ({ content: 'ok', isError: false }))

    await withSource('lambda:worker.js:main', AGENT_ID, () =>
      registry.executeTool('echo_tool', { text: 'hi' }, fakeWorkspace)
    )

    expect(types()).toEqual(['tool.started', 'tool.completed'])
    expect(events[0].source).toBe('lambda:worker.js:main')
    expect(events[0].payload).toMatchObject({
      name: 'echo_tool', input: { text: 'hi' }, filePath: '/tmp/agent-1.adf'
    })
    // No tool_use id on code-driven calls.
    expect(events[0].payload.id).toBeUndefined()
    expect(events[1].payload).toMatchObject({
      name: 'echo_tool', isError: false, result: { content: 'ok', isError: false }
    })
  })

  it('carries the LLM tool_use id when the caller supplies one', async () => {
    const { events } = captureEvents()
    const registry = registryWith(() => ({ content: 'ok', isError: false }))

    await withSource('agent:turn-1', AGENT_ID, () =>
      registry.executeTool('echo_tool', { text: 'hi' }, fakeWorkspace, { toolUseId: 'toolu_123' })
    )

    expect(events.map(e => e.payload.id)).toEqual(['toolu_123', 'toolu_123'])
  })

  it('strips internal flags from the emitted input', async () => {
    const { events } = captureEvents()
    const registry = registryWith(() => ({ content: 'ok', isError: false }))

    await withSource('agent:turn-1', AGENT_ID, () =>
      registry.executeTool(
        'echo_tool',
        { text: 'hi', _authorized: true, _protection_override: true, _full: true, _async: false },
        fakeWorkspace
      )
    )

    expect(events[0].payload.input).toEqual({ text: 'hi' })
  })

  it('emits tool.failed for a zod validation failure', async () => {
    const { events, types } = captureEvents()
    const registry = registryWith(() => ({ content: 'never runs', isError: false }))

    const result = await withSource('agent:turn-1', AGENT_ID, () =>
      registry.executeTool('echo_tool', { text: 42 }, fakeWorkspace)
    )

    expect(result.isError).toBe(true)
    expect(types()).toEqual(['tool.started', 'tool.failed'])
    expect(events[1].payload.isError).toBe(true)
  })

  it('emits tool.failed for an unknown tool', async () => {
    const { types } = captureEvents()
    const registry = registryWith(() => ({ content: 'ok', isError: false }))

    await withSource('agent:turn-1', AGENT_ID, () =>
      registry.executeTool('no_such_tool', {}, fakeWorkspace)
    )

    expect(types()).toEqual(['tool.started', 'tool.failed'])
  })

  it('emits tool.failed and re-throws when the call escapes with a throw', async () => {
    const { types } = captureEvents()
    const registry = new ToolRegistry()
    // A tool whose schema itself throws escapes the per-tool catch.
    registry.register({
      name: 'exploding_tool',
      description: 'x',
      category: 'general',
      get inputSchema(): never { throw new Error('boom') },
      execute: async () => ({ content: '', isError: false }),
      toProviderFormat: () => ({ name: 'exploding_tool', description: 'x', input_schema: {} }),
    } as unknown as Tool)

    await expect(
      withSource('agent:turn-1', AGENT_ID, () => registry.executeTool('exploding_tool', {}, fakeWorkspace))
    ).rejects.toThrow('boom')
    expect(types()).toEqual(['tool.started', 'tool.failed'])
  })

  it('truncates oversized result content in the payload but not in the returned result', async () => {
    const { events } = captureEvents()
    const huge = 'x'.repeat(20_000)
    const registry = registryWith(() => ({ content: huge, isError: false }))

    const result = await withSource('agent:turn-1', AGENT_ID, () =>
      registry.executeTool('echo_tool', { text: 'hi' }, fakeWorkspace)
    )

    expect(result.content).toHaveLength(20_000)
    const emitted = (events[1].payload.result as { content: string }).content
    expect(emitted.length).toBeLessThan(20_000)
    expect(emitted).toContain('[truncated]')
  })
})

describe('workspace choke points', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => { for (const c of cleanups.splice(0)) c() })

  function makeWorkspace() {
    const dir = mkdtempSync(join(tmpdir(), 'adf-umbilical-'))
    const workspace = Workspace.create(join(dir, 'agent-1.adf'), { name: 'agent-1' })
    cleanups.push(() => {
      workspace.dispose()
      rmSync(dir, { recursive: true, force: true })
    })
    return workspace
  }

  it('emits config.changed with changed key NAMES only — never values', () => {
    const workspace = makeWorkspace()
    const { events } = captureEvents()

    const config = workspace.getAgentConfig()
    withSource('agent:turn-1', AGENT_ID, () => {
      workspace.setAgentConfig({ ...config, description: 'a new description' })
    })

    const changed = events.filter(e => e.event_type === 'config.changed')
    expect(changed).toHaveLength(1)
    expect(changed[0].payload.changed_keys).toContain('description')
    expect(typeof changed[0].payload.updated_at).toBe('number')
    // The value itself must not appear anywhere in the payload.
    expect(JSON.stringify(changed[0].payload)).not.toContain('a new description')
  })

  it('emits message.queued from addToOutbox', () => {
    const workspace = makeWorkspace()
    const { events } = captureEvents()

    const id = withSource('agent:turn-1', AGENT_ID, () =>
      workspace.addToOutbox({
        from: 'agent-1', to: 'agent-2', content: 'hello',
        status: 'pending', created_at: Date.now(),
      } as never)
    )

    const queued = events.filter(e => e.event_type === 'message.queued')
    expect(queued).toHaveLength(1)
    expect(queued[0].payload).toMatchObject({ message_id: id, to: 'agent-2' })
  })

  it('emits file.written / file.deleted from the workspace, not the tool', () => {
    const workspace = makeWorkspace()
    const { events } = captureEvents()

    withSource('agent:turn-1', AGENT_ID, () => {
      workspace.writeFile('notes.md', 'hello')
      workspace.deleteFile('notes.md')
    })

    const written = events.filter(e => e.event_type === 'file.written')
    expect(written).toHaveLength(1)
    expect(written[0].payload).toEqual({ path: 'notes.md', bytes: 5 })
    const deleted = events.filter(e => e.event_type === 'file.deleted')
    expect(deleted).toHaveLength(1)
    expect(deleted[0].payload).toEqual({ path: 'notes.md' })
  })
})

describe('hil.* round trip', () => {
  function makeExecutor() {
    const tasks = new Map<string, { status: string }>()
    const workspace = {
      insertTask: (id: string) => { tasks.set(id, { status: 'pending' }) },
      updateTaskStatus: (id: string, status: string) => { tasks.set(id, { status }) },
      getTask: (id: string) => (tasks.has(id) ? { id, ...tasks.get(id) } : null),
      getFilePath: () => '/tmp/agent-1.adf',
      insertLog: () => {},
    }
    const session = { getWorkspace: () => workspace } as never
    const config = {
      name: 'agent-1',
      id: AGENT_ID,
      tools: [{ name: 'fs_delete', enabled: true, visible: true, restricted: true }],
      triggers: {},
      limits: {},
    } as unknown as AgentConfig
    const executor = new AgentExecutor(config, {} as never, { executeTool: vi.fn() } as never, session)
    const events: AgentExecutionEvent[] = []
    executor.on('event', (e: AgentExecutionEvent) => events.push(e))
    return { executor, events }
  }

  it('pairs hil.requested with hil.resolved on approval', async () => {
    const { executor, events } = makeExecutor()
    const { events: umbilical } = captureEvents()

    const promise = executor.requestHilApproval('fs_delete', { path: 'mind.md', _authorized: true })
    const requestId = (events.find(e => e.type === 'tool_approval_request')!.payload as { requestId: string }).requestId

    const requested = umbilical.find(e => e.event_type === 'hil.requested')!
    expect(requested).toBeDefined()
    expect(requested.payload).toMatchObject({
      request_id: requestId, task_id: requestId, tool: 'fs_delete', reason: 'restricted'
    })
    // Internal flags are stripped from the umbilical copy of the input.
    expect(requested.payload.input).toEqual({ path: 'mind.md' })

    executor.resolveHilTask(requestId, true)
    await promise

    const resolved = umbilical.find(e => e.event_type === 'hil.resolved')!
    expect(resolved).toBeDefined()
    expect(resolved.payload).toMatchObject({ request_id: requestId, approved: true })
    expect(resolved.payload.timed_out).toBeUndefined()
  })

  it('carries feedback on denial', async () => {
    const { executor, events } = makeExecutor()
    const { events: umbilical } = captureEvents()

    const promise = executor.requestHilApproval('fs_delete', { path: 'mind.md' })
    const requestId = (events.find(e => e.type === 'tool_approval_request')!.payload as { requestId: string }).requestId
    executor.resolveHilTask(requestId, false, undefined, 'leave it alone')
    await promise

    const resolved = umbilical.find(e => e.event_type === 'hil.resolved')!
    expect(resolved.payload).toMatchObject({ approved: false, feedback: 'leave it alone' })
  })

  it('labels the shell-gate approval path distinctly', async () => {
    const { executor, events } = makeExecutor()
    const { events: umbilical } = captureEvents()

    const promise = executor.requestApproval('fs_delete', { path: 'mind.md' })
    const requestId = (events.find(e => e.type === 'tool_approval_request')!.payload as { requestId: string }).requestId
    executor.resolveHilTask(requestId, true)
    await promise

    expect(umbilical.find(e => e.event_type === 'hil.requested')!.payload.reason).toBe('shell_gate')
  })
})
