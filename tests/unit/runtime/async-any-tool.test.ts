/**
 * `_async: true` is offered on, and honored for, every tool in the LLM loop —
 * the same contract the sandbox `adf.<tool>({ _async: true })` path already
 * has. A turn-control tool run as a task still applies its side effect.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { AgentRuntimeBuilder } from '../../../src/main/runtime/agent-runtime-builder'
import { createHeadlessAgent, MockLLMProvider } from '../../../src/main/runtime/headless'
import { createDispatch, createEvent } from '../../../src/shared/types/adf-event.types'
import type { CreateMessageOptions, LLMProvider } from '../../../src/main/providers/provider.interface'
import type { LLMResponse } from '../../../src/shared/types/provider.types'
import type { AgentExecutionEvent } from '../../../src/shared/types/ipc.types'

const cleanupDirs: string[] = []
afterEach(() => {
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

async function build(provider: LLMProvider) {
  const dir = mkdtempSync(join(tmpdir(), 'adf-async-any-'))
  cleanupDirs.push(dir)
  const filePath = join(dir, 'agent-1.adf')
  createHeadlessAgent({ filePath, name: 'agent-1', provider: new MockLLMProvider() }).dispose()
  const workspace = AdfWorkspace.open(filePath)
  const agent = await new AgentRuntimeBuilder().build({ workspace, filePath, config: workspace.getAgentConfig(), provider })
  return { workspace, agent }
}

describe('_async on any tool (LLM loop)', () => {
  it('offers _async on every tool schema and runs a non-listed tool (fs_read) as a task', async () => {
    const provider = new ScriptedProvider('fs_read', { path: 'notes.md', _async: true })
    const { workspace, agent } = await build(provider)
    try {
      workspace.writeFile('notes.md', 'hello')
      await agent.executor.executeTurn(chatDispatch())

      const offered = provider.offered ?? []
      expect(offered.length).toBeGreaterThan(0)
      const withoutAsync = offered
        .filter(t => !((t.input_schema as { properties?: Record<string, unknown> }).properties ?? {})._async)
        .map(t => t.name)
      expect(withoutAsync).toEqual([])

      const tasks = workspace.getAllTasks().filter(t => t.tool === 'fs_read')
      expect(tasks).toHaveLength(1)
      expect(JSON.stringify(provider.results[0])).toContain(tasks[0].id)
    } finally {
      await agent.disposeAsync()
    }
  })

  it('applies sys_set_state run as a task, like the sandbox path does', async () => {
    const provider = new ScriptedProvider('sys_set_state', { state: 'hibernate', _async: true })
    const { workspace, agent } = await build(provider)
    const states: string[] = []
    agent.executor.on('event', (e: AgentExecutionEvent) => {
      if (e.type === 'state_changed') states.push((e.payload as { state: string }).state)
    })
    try {
      await agent.executor.executeTurn(chatDispatch())
      expect(workspace.getAllTasks().filter(t => t.tool === 'sys_set_state')).toHaveLength(1)
      expect(states).toContain('hibernate')
    } finally {
      await agent.disposeAsync()
    }
  })
})
