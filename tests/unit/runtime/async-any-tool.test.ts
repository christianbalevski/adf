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
  // Enable the turn-bound tools so their schemas and refusals are exercised.
  const config = workspace.getAgentConfig()
  const turnBound = ['ask', 'loop_clear', 'loop_compact']
  config.tools = [
    ...config.tools.filter(t => !turnBound.includes(t.name)),
    ...turnBound.map(name => ({ name, enabled: true, visible: true }) as never),
  ]
  workspace.setAgentConfig(config)
  const agent = await new AgentRuntimeBuilder().build({ workspace, filePath, config: workspace.getAgentConfig(), provider })
  return { workspace, agent }
}

describe('_async on any tool (LLM loop)', () => {
  it('offers _async on every tool that can run as a task and runs a non-listed tool (fs_read) as one', async () => {
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
        .sort()
      // Turn-bound tools only: loop resets complete in the executor's turn
      // post-processing, ask is intercepted by name, say is its own block.
      const offeredNames = new Set(offered.map(t => t.name))
      expect(withoutAsync).toEqual(['ask', 'loop_clear', 'loop_compact', 'say'].filter(n => offeredNames.has(n)))
      for (const name of ['ask', 'loop_clear', 'loop_compact']) expect(offeredNames.has(name)).toBe(true)

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

  it.each(['loop_compact', 'loop_clear'])('refuses %s with _async instead of a reset that never completes', async (tool) => {
    const provider = new ScriptedProvider(tool, { _async: true })
    const { workspace, agent } = await build(provider)
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

  it('shapes an async fs_read of an image like the sync path (file reference, not raw base64)', async () => {
    // 1x1 PNG
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

    const sync = new ScriptedProvider('fs_read', { path: 'pic.png' })
    const a = await build(sync)
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
    const b = await build(asyncProvider)
    try {
      b.workspace.writeFileBuffer('pic.png', png, 'image/png')
      await b.agent.executor.executeTurn(chatDispatch())
      const deadline = Date.now() + 2_000
      let task = b.workspace.getAllTasks().find(t => t.tool === 'fs_read')
      while (task?.status !== 'completed' && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 10))
        task = b.workspace.getAllTasks().find(t => t.tool === 'fs_read')
      }
      expect(task?.status).toBe('completed')
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
})
