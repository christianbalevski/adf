/**
 * Blocker 5: async tools emit exactly one correlated tool.started / terminal
 * event per tool_use id, and never a premature tool.completed at enqueue.
 *
 * The async+restricted branch used to fire a synthetic tool.completed carrying
 * a `pending_approval` placeholder the moment the call was QUEUED, then a second
 * uncorrelated pair on real execution. A tap must now see:
 *   - tool.started(id=X) when the call goes in-flight (enqueue), and
 *   - exactly one terminal tool.completed(id=X) at REAL completion — never before.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { AgentRuntimeBuilder } from '../../../src/main/runtime/agent-runtime-builder'
import { createHeadlessAgent, MockLLMProvider } from '../../../src/main/runtime/headless'
import { clearAllUmbilicalBuses, ensureUmbilicalBus } from '../../../src/main/runtime/umbilical-bus'
import { createDispatch, createEvent } from '../../../src/shared/types/adf-event.types'
import type { UmbilicalEvent } from '../../../src/main/runtime/umbilical-bus'
import type { CreateMessageOptions, LLMProvider } from '../../../src/main/providers/provider.interface'
import type { LLMResponse } from '../../../src/shared/types/provider.types'
import type { Tool } from '../../../src/main/tools/tool.interface'
import type { ToolResult } from '../../../src/shared/types/tool.types'
import type { AgentExecutionEvent } from '../../../src/shared/types/ipc.types'

const cleanupDirs: string[] = []

const chatDispatch = () => createDispatch(
  createEvent({
    type: 'chat',
    source: 'test',
    data: {
      message: { seq: 0, role: 'user', content_json: [{ type: 'text', text: 'go' }], created_at: Date.now() },
    },
  }),
  { scope: 'agent' },
)

/** A restricted, async-allowed tool stand-in. `sys_fetch` is in ASYNC_ALLOWED_TOOLS. */
class FakeFetchTool implements Tool {
  readonly name = 'sys_fetch'
  readonly description = 'fake fetch'
  readonly inputSchema = z.object({}).passthrough()
  readonly category = 'general' as const
  async execute(): Promise<ToolResult> {
    return { content: 'FETCHED-OK', isError: false }
  }
  toProviderFormat() {
    return { name: this.name, description: this.description, input_schema: { type: 'object', properties: {} } }
  }
}

/** Serves a single async tool_use, then an end_turn text reply. */
class ScriptedProvider implements LLMProvider {
  readonly name = 'scripted'
  readonly modelId = 'scripted-v1'
  private calls = 0
  async createMessage(_opts: CreateMessageOptions): Promise<LLMResponse> {
    this.calls++
    if (this.calls === 1) {
      return {
        id: 'r1',
        content: [{ type: 'tool_use', id: 'toolu_async_1', name: 'sys_fetch', input: { _async: true, url: 'x' } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 1, output_tokens: 1 },
      }
    }
    return {
      id: `r${this.calls}`,
      content: [{ type: 'text', text: 'done' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }
  }
  async validateConfig(): Promise<{ valid: boolean }> {
    return { valid: true }
  }
}

describe('async+restricted tool umbilical correlation', () => {
  beforeEach(() => clearAllUmbilicalBuses())
  afterEach(() => {
    clearAllUmbilicalBuses()
    for (const dir of cleanupDirs.splice(0)) {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows file locks */ }
    }
  })

  it('emits one tool.started at enqueue and exactly one tool.completed at real completion', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-async-umbilical-'))
    cleanupDirs.push(dir)
    const filePath = join(dir, 'agent-1.adf')
    const created = createHeadlessAgent({ filePath, name: 'agent-1', provider: new MockLLMProvider() })
    created.dispose()
    const workspace = AdfWorkspace.open(filePath)

    // Declare sys_fetch enabled + restricted so the async+restricted branch fires.
    const config = workspace.getAgentConfig()
    config.tools = [
      ...config.tools.filter(t => t.name !== 'sys_fetch'),
      { name: 'sys_fetch', enabled: true, visible: true, restricted: true } as never,
    ]
    workspace.setAgentConfig(config)
    const agentId = workspace.getAgentConfig().id

    const agent = await new AgentRuntimeBuilder().build({
      workspace,
      filePath,
      config: workspace.getAgentConfig(),
      provider: new ScriptedProvider(),
    })
    // Overwrite the real sys_fetch with a harmless fake execution.
    agent.registry.register(new FakeFetchTool())

    // Subscribe to the per-agent bus — the guard that used to drop agent_id:null
    // events lives here, and it is where a tap observes tool.*.
    const seen: UmbilicalEvent[] = []
    ensureUmbilicalBus(agentId).subscribe(e => seen.push(e))

    // Capture the approval task id from the executor's event stream.
    let taskId: string | undefined
    agent.executor.on('event', (e: AgentExecutionEvent) => {
      if (e.type === 'tool_approval_request') {
        taskId = (e.payload as { taskId?: string }).taskId
      }
    })

    try {
      await agent.executor.executeTurn(chatDispatch())

      // At enqueue: exactly one tool.started (in-flight), NO terminal event yet.
      const toolEvents = () => seen.filter(e => e.event_type.startsWith('tool.'))
      const started = toolEvents().filter(e => e.event_type === 'tool.started')
      expect(started).toHaveLength(1)
      expect(started[0].payload.id).toBe('toolu_async_1')
      expect(started[0].agent_id).toBe(agentId)
      // The premature/placeholder completed is the bug — it must be absent.
      expect(toolEvents().filter(e => e.event_type === 'tool.completed')).toHaveLength(0)
      expect(toolEvents().filter(e => e.event_type === 'tool.failed')).toHaveLength(0)

      // Approve: the real execution now runs in the background.
      expect(taskId).toBeTruthy()
      agent.executor.resolveHilTask(taskId!, true)
      await new Promise(resolve => setTimeout(resolve, 30))

      // Exactly one terminal tool.completed, correlated by the SAME tool_use id.
      const completed = toolEvents().filter(e => e.event_type === 'tool.completed')
      expect(completed).toHaveLength(1)
      expect(completed[0].payload.id).toBe('toolu_async_1')
      expect(completed[0].agent_id).toBe(agentId)
      expect((completed[0].payload.result as { content: string }).content).toBe('FETCHED-OK')

      // Net invariant: one started + one completed, both id=toolu_async_1.
      expect(toolEvents().filter(e => e.event_type === 'tool.started')).toHaveLength(1)
    } finally {
      await agent.disposeAsync()
    }
  })
})
