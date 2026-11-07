/**
 * Where the LLM loop offers `_async`: tools that wait on something external
 * (EXTERNAL_WAIT_TOOLS), MCP server tools, and any tool restricted for this
 * agent — a restricted call waits on the owner, so `_async` lets the agent keep
 * working until the owner decides. Elsewhere the flag is not offered and the
 * call runs in the turn. Code may still run any task-capable tool as a task.
 *
 * Task-backed approvals: the agent's own (unauthorized) code may deny one,
 * the outcome is reported once, and a restart reopens it instead of cancelling.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { AgentRuntimeBuilder } from '../../../src/main/runtime/agent-runtime-builder'
import { CodeSandboxService } from '../../../src/main/runtime/code-sandbox'
import { createHeadlessAgent, MockLLMProvider } from '../../../src/main/runtime/headless'
import { EXTERNAL_WAIT_TOOLS } from '../../../src/main/tools/built-in/loop-reset-tools'
import { createDispatch, createEvent } from '../../../src/shared/types/adf-event.types'
import type { CreateMessageOptions, LLMProvider } from '../../../src/main/providers/provider.interface'
import type { LLMResponse } from '../../../src/shared/types/provider.types'
import type { AgentExecutionEvent } from '../../../src/shared/types/ipc.types'

const cleanupDirs: string[] = []
const sandboxes: CodeSandboxService[] = []
afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) sandbox.destroyAll()
  for (const dir of cleanupDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows file locks */ }
  }
})

const chatDispatch = () => createDispatch(
  createEvent({
    type: 'chat',
    source: 'test',
    data: { message: { seq: 0, role: 'user', content_json: [{ type: 'text', text: 'go' }], created_at: Date.now() } },
  }),
  { scope: 'agent' },
)

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Serves one tool_use, then an end_turn reply; records what it was offered. */
class ScriptedProvider implements LLMProvider {
  readonly name = 'scripted'
  readonly modelId = 'scripted-v1'
  offered: CreateMessageOptions['tools'] = []
  results: unknown[] = []
  private calls = 0
  constructor(private tool: string, private input: Record<string, unknown>) {}
  async createMessage(opts: CreateMessageOptions): Promise<LLMResponse> {
    this.calls++
    if (this.calls === 1) {
      this.offered = opts.tools
      return {
        id: 'r1',
        content: [{ type: 'tool_use', id: 'toolu_1', name: this.tool, input: this.input }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 1, output_tokens: 1 },
      }
    }
    this.results.push(opts.messages[opts.messages.length - 1]?.content)
    return { id: `r${this.calls}`, content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }
  }
  async validateConfig(): Promise<{ valid: boolean }> { return { valid: true } }
}

function newAgentFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'adf-async-offer-'))
  cleanupDirs.push(dir)
  const filePath = join(dir, 'agent-1.adf')
  createHeadlessAgent({ filePath, name: 'agent-1', provider: new MockLLMProvider() }).dispose()
  return filePath
}

async function open(filePath: string, provider: LLMProvider, opts: { restricted?: string[]; sandbox?: boolean } = {}) {
  const workspace = AdfWorkspace.open(filePath)
  const config = workspace.getAgentConfig()
  // Enable the turn-bound tools so their schemas and refusals are exercised.
  const turnBound = ['ask', 'loop_clear', 'loop_compact']
  const restricted = new Set(opts.restricted ?? [])
  config.tools = [
    ...config.tools.filter(t => !turnBound.includes(t.name)),
    ...turnBound.map(name => ({ name, enabled: true, visible: true }) as never),
  ].map(t => (restricted.has(t.name) ? { ...t, enabled: true, restricted: true } : t))
  workspace.setAgentConfig(config)
  let codeSandboxService: CodeSandboxService | undefined
  if (opts.sandbox) {
    codeSandboxService = new CodeSandboxService()
    sandboxes.push(codeSandboxService)
  }
  const agent = await new AgentRuntimeBuilder({ codeSandboxService })
    .build({ workspace, filePath, config: workspace.getAgentConfig(), provider })
  return { workspace, agent }
}

async function waitForTask(workspace: AdfWorkspace, tool: string, status: string) {
  const deadline = Date.now() + 2_000
  let task = workspace.getAllTasks().find(t => t.tool === tool)
  while (task?.status !== status && Date.now() < deadline) {
    await sleep(10)
    task = workspace.getAllTasks().find(t => t.tool === tool)
  }
  return task
}

const hasAsync = (t: NonNullable<CreateMessageOptions['tools']>[number]) =>
  Boolean(((t.input_schema as { properties?: Record<string, unknown> }).properties ?? {})._async)

describe('_async offer (LLM loop)', () => {
  it('offers _async only on external-wait tools and tools restricted for this agent', async () => {
    const provider = new ScriptedProvider('say', { text: 'hi' })
    const { workspace, agent } = await open(newAgentFile(), provider, { restricted: ['fs_write'] })
    try {
      await agent.executor.executeTurn(chatDispatch())
      const offered = provider.offered ?? []
      expect(offered.length).toBeGreaterThan(0)
      const restricted = new Set(workspace.getAgentConfig().tools.filter(t => t.enabled && t.restricted).map(t => t.name))
      const withAsync = offered.filter(hasAsync).map(t => t.name).sort()
      const expected = offered
        .map(t => t.name)
        .filter(n => EXTERNAL_WAIT_TOOLS.has(n) || restricted.has(n))
        .sort()
      expect(withAsync).toEqual(expected)
      expect(withAsync).toContain('fs_write')
      const names = new Set(offered.map(t => t.name))
      for (const local of ['fs_read', 'fs_list', 'db_query', 'mcp_install', 'mcp_uninstall']) {
        if (names.has(local)) expect(withAsync).not.toContain(local)
      }
    } finally {
      await agent.disposeAsync()
    }
  })

  it('runs a call in the turn when _async is not offered on its tool', async () => {
    const provider = new ScriptedProvider('fs_read', { path: 'notes.md', _async: true })
    const { workspace, agent } = await open(newAgentFile(), provider)
    try {
      workspace.writeFile('notes.md', 'hello')
      await agent.executor.executeTurn(chatDispatch())
      expect(workspace.getAllTasks().filter(t => t.tool === 'fs_read')).toHaveLength(0)
      expect(JSON.stringify(provider.results[0])).toContain('hello')
    } finally {
      await agent.disposeAsync()
    }
  })

  it.each(['loop_compact', 'loop_clear'])('refuses %s with _async instead of a reset that never completes', async (tool) => {
    const provider = new ScriptedProvider(tool, { _async: true })
    const { workspace, agent } = await open(newAgentFile(), provider, { restricted: [tool] })
    try {
      await agent.executor.executeTurn(chatDispatch())
      expect(workspace.getAllTasks().filter(t => t.tool === tool)).toHaveLength(0)
      const result = JSON.stringify(provider.results[0])
      expect(result).toContain(`${tool} only works as a direct tool call`)
      expect(result).not.toContain('Compaction initiated')
    } finally {
      await agent.disposeAsync()
    }
  })
})

describe('task-backed approvals (_async on a restricted tool)', () => {
  it('does not hold the turn; approval runs the task, shaped like the sync path', async () => {
    // 1x1 PNG
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

    const sync = new ScriptedProvider('fs_read', { path: 'pic.png' })
    const a = await open(newAgentFile(), sync)
    let syncContent: string
    try {
      a.workspace.writeFileBuffer('pic.png', png, 'image/png')
      await a.agent.executor.executeTurn(chatDispatch())
      const blocks = sync.results[0] as Array<{ type: string; content?: string }>
      syncContent = blocks.find(b => b.type === 'tool_result')!.content!
    } finally {
      await a.agent.disposeAsync()
    }
    expect(syncContent).toContain('[image: pic.png (image/png)]')

    const asyncProvider = new ScriptedProvider('fs_read', { path: 'pic.png', _async: true })
    const b = await open(newAgentFile(), asyncProvider, { restricted: ['fs_read'] })
    try {
      b.workspace.writeFileBuffer('pic.png', png, 'image/png')
      await b.agent.executor.executeTurn(chatDispatch())
      // The turn finished while the approval is still open.
      const pending = b.workspace.getAllTasks().find(t => t.tool === 'fs_read')
      expect(pending?.status).toBe('pending_approval')
      expect(JSON.stringify(asyncProvider.results[0])).toContain(pending!.id)
      expect(b.agent.executor.getState()).toBe('awaiting_approval')

      b.agent.executor.resolveHilTask(pending!.id, true)
      const task = await waitForTask(b.workspace, 'fs_read', 'completed')
      expect(task?.status).toBe('completed')
      expect(b.agent.executor.getState()).toBe('idle')
      const shape = (json: string) => {
        const row = JSON.parse(json) as Record<string, unknown>
        delete row.created_at
        delete row.updated_at
        return row
      }
      expect(shape(task!.result!)).toEqual(shape(syncContent))
      expect(task!.result).not.toContain(png.toString('base64'))
    } finally {
      await b.agent.disposeAsync()
    }
  })

  it('applies sys_set_state approved as a task, like the sandbox path does', async () => {
    const provider = new ScriptedProvider('sys_set_state', { state: 'hibernate', _async: true })
    const { workspace, agent } = await open(newAgentFile(), provider, { restricted: ['sys_set_state'] })
    const states: string[] = []
    agent.executor.on('event', (e: AgentExecutionEvent) => {
      if (e.type === 'state_changed') states.push((e.payload as { state: string }).state)
    })
    try {
      await agent.executor.executeTurn(chatDispatch())
      const pending = workspace.getAllTasks().find(t => t.tool === 'sys_set_state')
      expect(pending?.status).toBe('pending_approval')
      agent.executor.resolveHilTask(pending!.id, true)
      await waitForTask(workspace, 'sys_set_state', 'completed')
      const deadline = Date.now() + 2_000
      while (!states.includes('hibernate') && Date.now() < deadline) await sleep(10)
      expect(states).toContain('hibernate')
    } finally {
      await agent.disposeAsync()
    }
  })

  it("lets the agent's own (unauthorized) code deny it, reporting the outcome once", async () => {
    const provider = new ScriptedProvider('fs_write', { path: 'out.md', content: 'x', _async: true })
    const { workspace, agent } = await open(newAgentFile(), provider, { restricted: ['fs_write'], sandbox: true })
    const completions: string[] = []
    const count = <T extends unknown[]>(fn: ((...a: T) => void) | undefined) => (...a: T) => {
      completions.push(String(a[0]))
      fn?.(...a)
    }
    agent.executor.onTaskCompleted = count(agent.executor.onTaskCompleted)
    agent.adfCallHandler!.onTaskCompleted = count(agent.adfCallHandler!.onTaskCompleted)
    try {
      await agent.executor.executeTurn(chatDispatch())
      const pending = workspace.getAllTasks().find(t => t.tool === 'fs_write')
      expect(pending?.status).toBe('pending_approval')

      // Approve stays authorized-only.
      const approve = await agent.adfCallHandler!.handleCall('task_resolve', { task_id: pending!.id, action: 'approve' })
      expect(approve.errorCode).toBe('REQUIRES_AUTHORIZED_CODE')

      const deny = await agent.adfCallHandler!.handleCall('task_resolve', { task_id: pending!.id, action: 'deny', reason: 'no longer needed' })
      expect(deny.error).toBeUndefined()
      expect(workspace.getTask(pending!.id)?.status).toBe('denied')
      expect(workspace.readFile('out.md')).toBeNull()
      expect(completions.filter(id => id === pending!.id)).toHaveLength(1)
      // The denial wakes the agent (on_task_complete); the approval no longer holds the state.
      expect(agent.executor.getState()).not.toBe('awaiting_approval')
    } finally {
      await agent.disposeAsync()
    }
  })
})

describe('approval tasks at load', () => {
  function seedApproval(filePath: string, taskId: string, opts: { handedOut: boolean }) {
    const workspace = AdfWorkspace.open(filePath)
    try {
      workspace.writeFile('notes.md', 'hello')
      workspace.insertTask(taskId, 'fs_read', JSON.stringify({ path: 'notes.md' }), 'hil:agent-1', true, true, JSON.stringify({ reason: 'restricted' }))
      workspace.updateTaskStatus(taskId, 'pending_approval')
      if (opts.handedOut) {
        workspace.appendToLoop('assistant', [{ type: 'tool_use', id: 'toolu_seed', name: 'fs_read', input: { path: 'notes.md', _async: true } }] as never)
        workspace.appendToLoop('user', [{
          type: 'tool_result', tool_use_id: 'toolu_seed',
          content: JSON.stringify({ task_id: taskId, status: 'pending_approval', tool: 'fs_read' }),
        }] as never)
      }
    } finally {
      workspace.close()
    }
  }

  it('reopens an _async approval the agent holds the task id of, and runs it on approval', async () => {
    const filePath = newAgentFile()
    seedApproval(filePath, 'task_async_seed', { handedOut: true })
    const { workspace, agent } = await open(filePath, new MockLLMProvider(), { restricted: ['fs_read'] })
    try {
      expect(workspace.getTask('task_async_seed')?.status).toBe('pending_approval')
      expect(agent.executor.getState()).toBe('awaiting_approval')
      agent.executor.resolveHilTask('task_async_seed', true)
      const task = await waitForTask(workspace, 'fs_read', 'completed')
      expect(task?.status).toBe('completed')
      expect(task?.result).toContain('hello')
    } finally {
      await agent.disposeAsync()
    }
  })

  it('still cancels a blocking approval whose turn died with the process', async () => {
    const filePath = newAgentFile()
    seedApproval(filePath, 'task_blocking_seed', { handedOut: false })
    const { workspace, agent } = await open(filePath, new MockLLMProvider(), { restricted: ['fs_read'] })
    try {
      expect(workspace.getTask('task_blocking_seed')?.status).toBe('cancelled')
    } finally {
      await agent.disposeAsync()
    }
  })
})
