/**
 * An async task that completes while the agent's own turn is running must
 * still wake the agent (on_task_complete, agent scope) once that turn ends.
 *
 * The executor queues agent-scope dispatches that arrive mid-turn
 * (pendingTriggers) and drains them at the turn boundary. The trigger
 * evaluator must therefore not gate on the executor's working states
 * (thinking / tool_use / awaiting_*): those are not display states.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { ToolRegistry } from '../../../src/main/tools/tool-registry'
import { registerBuiltInTools } from '../../../src/main/tools/built-in/register-built-in-tools'
import { assembleAgent, type AssembledAgent } from '../../../src/main/runtime/assemble-agent'
import { MockLLMProvider } from '../../../src/main/runtime/headless'
import { createDispatch, createEvent } from '../../../src/shared/types/adf-event.types'
import type { CreateMessageOptions, LLMMessage } from '../../../src/main/providers/provider.interface'

const tempDirs: string[] = []
const agents: AssembledAgent[] = []
afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.disposeAsync().catch(() => {})
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const textOf = (m: LLMMessage) =>
  Array.isArray(m.content) ? m.content.map(b => ('text' in b && b.text) || '').join('') : String(m.content)

describe('on_task_complete while the agent is mid-turn', () => {
  it('delivers the completion as a turn after the running turn ends', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-task-mid-turn-'))
    tempDirs.push(dir)
    const workspace = AdfWorkspace.create(join(dir, 'agent.adf'), { name: 'task-mid-turn', autonomous: false })

    let release!: () => void
    const firstCallBlocked = new Promise<void>((r) => { release = r })
    let enteredFirstCall!: () => void
    const inFirstCall = new Promise<void>((r) => { enteredFirstCall = r })
    const calls: LLMMessage[][] = []
    const provider = new (class extends MockLLMProvider {
      override async createMessage(opts: CreateMessageOptions) {
        calls.push(opts.messages.map(m => ({ ...m })))
        if (calls.length === 1) { enteredFirstCall(); await firstCallBlocked }
        return super.createMessage(opts)
      }
    })({ tokensPerResponse: 4 })

    const registry = new ToolRegistry()
    registerBuiltInTools(registry)
    const agent = assembleAgent({ profile: 'headlessLive', workspace, config: workspace.getAgentConfig(), provider, registry })
    agents.push(agent)
    await agent.start()

    const turn = agent.dispatch(createDispatch(createEvent({
      type: 'chat', source: 'test', data: { message: { seq: 0, role: 'user', content_json: [{ type: 'text', text: 'start a task' }], created_at: Date.now() } },
    }), { scope: 'agent' }))
    await inFirstCall
    expect(agent.executor.getState()).toBe('thinking')

    // Exactly what executeAsyncTool / AdfCallHandler do when a task finishes.
    agent.executor.onTaskCompleted!('task-mid-turn-1', 'adf_shell', 'completed', 'done-output')

    release()
    await turn
    const deadline = Date.now() + 2_000
    while (calls.length < 2 && Date.now() < deadline) await new Promise(r => setTimeout(r, 10))

    expect(calls.length).toBeGreaterThanOrEqual(2)
    const last = calls[1].map(textOf).join('\n')
    expect(last).toContain('A task has completed.')
    expect(last).toContain('Task ID: task-mid-turn-1')
  })
})
