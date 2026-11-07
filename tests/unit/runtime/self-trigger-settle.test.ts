/**
 * Agent-scope trigger gating while the agent is working.
 *
 * Executor work states (thinking / tool_use / awaiting_*) are sub-states of
 * `active`: triggers caused from outside (task completion, inbox, timer) are
 * queued by the executor and run at the turn boundary. Events the agent's own
 * turn produces (its LLM calls, tool calls, logs, outbox, task creations) never
 * wake it — otherwise every turn schedules the next one. `error` stays gated.
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
import { TriggerEvaluator } from '../../../src/main/runtime/trigger-evaluator'
import { createDispatch, createEvent } from '../../../src/shared/types/adf-event.types'
import type { AdfEventDispatch, AdfBatchDispatch } from '../../../src/shared/types/adf-event.types'
import type { AgentConfig, TriggerConfig } from '../../../src/shared/types/adf-v02.types'
import type { CreateMessageOptions, LLMMessage, LLMProvider } from '../../../src/main/providers/provider.interface'
import type { LLMResponse } from '../../../src/shared/types/provider.types'

const tempDirs: string[] = []
const agents: AssembledAgent[] = []
afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.disposeAsync().catch(() => {})
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const textOf = (m: LLMMessage) =>
  Array.isArray(m.content) ? m.content.map(b => ('text' in b && b.text) || ('content' in b && typeof b.content === 'string' ? b.content : '')).join('') : String(m.content)

const chat = (text: string) => createDispatch(createEvent({
  type: 'chat', source: 'test', data: { message: { seq: 0, role: 'user', content_json: [{ type: 'text', text }], created_at: Date.now() } },
}), { scope: 'agent' })

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function startAgent(
  triggers: Partial<Record<string, TriggerConfig>>,
  provider: LLMProvider,
  setup?: (ws: AdfWorkspace) => void,
): Promise<{ agent: AssembledAgent; workspace: AdfWorkspace }> {
  const dir = mkdtempSync(join(tmpdir(), 'adf-self-trigger-'))
  tempDirs.push(dir)
  const workspace = AdfWorkspace.create(join(dir, 'agent.adf'), { name: 'self-trigger', autonomous: false })
  const config = workspace.getAgentConfig()
  config.triggers = { ...config.triggers, ...triggers } as AgentConfig['triggers']
  workspace.setAgentConfig(config)
  setup?.(workspace)
  const registry = new ToolRegistry()
  registerBuiltInTools(registry)
  const agent = assembleAgent({ profile: 'headlessLive', workspace, config: workspace.getAgentConfig(), provider, registry })
  agents.push(agent)
  await agent.start()
  return { agent, workspace }
}

/** Calls `tool` with `input` when the last message is not a tool result, else ends the turn. */
class ToolEachTurnProvider implements LLMProvider {
  readonly name = 'scripted'
  readonly modelId = 'scripted-v1'
  calls: LLMMessage[][] = []
  constructor(
    private tool: string,
    private input: Record<string, unknown>,
    private beforeReply?: (call: number) => Promise<void>,
    private maxToolCalls = Infinity,
  ) {}
  private toolCalls = 0
  async createMessage(opts: CreateMessageOptions): Promise<LLMResponse> {
    this.calls.push(opts.messages.map(m => ({ ...m })))
    await this.beforeReply?.(this.calls.length)
    const last = opts.messages[opts.messages.length - 1]
    const answeringTool = Array.isArray(last?.content) && last.content.some(b => b.type === 'tool_result')
    if (answeringTool || this.toolCalls >= this.maxToolCalls) {
      return { id: `r${this.calls.length}`, content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }
    }
    this.toolCalls++
    return {
      id: `r${this.calls.length}`,
      content: [{ type: 'tool_use', id: `toolu_${this.calls.length}`, name: this.tool, input: this.input }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 1, output_tokens: 1 },
    }
  }
  async validateConfig(): Promise<{ valid: boolean }> { return { valid: true } }
}

describe('the agent\'s own activity does not wake it', () => {
  it('settles with an agent-scope on_llm_call target', async () => {
    let calls = 0
    const provider = new (class extends MockLLMProvider {
      override async createMessage(opts: CreateMessageOptions) { calls++; return super.createMessage(opts) }
    })({ tokensPerResponse: 4 })
    const { agent } = await startAgent({ on_llm_call: { enabled: true, targets: [{ scope: 'agent' }] } as TriggerConfig }, provider)

    await agent.dispatch(chat('hello'))
    await sleep(500)
    expect(calls).toBeLessThanOrEqual(3)
  })

  it('settles with an agent-scope on_tool_call target filtered to the tool it calls', async () => {
    const provider = new ToolEachTurnProvider('fs_read', { path: 'notes.md' })
    const { agent } = await startAgent(
      { on_tool_call: { enabled: true, targets: [{ scope: 'agent', filter: { tools: ['fs_read'] } }] } as TriggerConfig },
      provider,
      (ws) => ws.writeFile('notes.md', 'hello'),
    )

    await agent.dispatch(chat('read it'))
    await sleep(500)
    // One turn = tool call + reply.
    expect(provider.calls.length).toBeLessThanOrEqual(3)
  })

  it('does not dispatch an agent-scope on_outbox event while the agent is working (fires when idle)', () => {
    // Nothing in the runtime emits on_outbox today; drive the evaluator directly.
    const evaluator = new TriggerEvaluator({ id: 'a', name: 'a', triggers: { on_outbox: { enabled: true, targets: [{ scope: 'agent' }] } } } as unknown as AgentConfig)
    const fired: (AdfEventDispatch | AdfBatchDispatch)[] = []
    evaluator.on('trigger', (d) => fired.push(d))

    evaluator.setDisplayState('thinking')
    evaluator.onOutbox('did:key:peer', 'hi')
    expect(fired).toHaveLength(0)

    evaluator.setDisplayState('idle')
    evaluator.onOutbox('did:key:peer', 'hi')
    expect(fired).toHaveLength(1)
  })
})

describe('agent-scope gating by state', () => {
  it('reports a work state as given (as on base) while gating it as active', () => {
    const evaluator = new TriggerEvaluator({ id: 'a', name: 'a', triggers: { on_task_complete: { enabled: true, targets: [{ scope: 'agent' }] } } } as unknown as AgentConfig)
    const fired: (AdfEventDispatch | AdfBatchDispatch)[] = []
    evaluator.on('trigger', (d) => fired.push(d))

    evaluator.setDisplayState('awaiting_approval')
    expect(evaluator.getDisplayState()).toBe('awaiting_approval')
    evaluator.onTaskComplete('task-1', 'fs_read', 'completed', 'ok')
    expect(fired).toHaveLength(1)
    expect((fired[0] as AdfEventDispatch).scope).toBe('agent')
  })

  it('does not fire an agent-scope trigger in error state', () => {
    const evaluator = new TriggerEvaluator({ id: 'a', name: 'a', triggers: { on_task_complete: { enabled: true, targets: [{ scope: 'agent' }] } } } as unknown as AgentConfig)
    const fired: (AdfEventDispatch | AdfBatchDispatch)[] = []
    evaluator.on('trigger', (d) => fired.push(d))

    evaluator.setDisplayState('error')
    evaluator.onTaskComplete('task-1', 'fs_read', 'completed', 'ok')
    expect(fired).toHaveLength(0)
  })

  it('wakes the agent after its turn when an _async tool from the LLM loop completes mid-turn', async () => {
    let workspaceRef: AdfWorkspace | null = null
    let agentRef: AssembledAgent | null = null
    // fs_read is restricted, so the LLM loop offers it _async (it waits on the
    // owner). Hold the reply that follows the call until the owner approves and
    // the task completes — the completion lands while the turn is running.
    const provider = new ToolEachTurnProvider('fs_read', { path: 'notes.md', _async: true }, async (call) => {
      if (call !== 2) return
      const pending = workspaceRef!.getAllTasks().find(t => t.tool === 'fs_read' && t.status === 'pending_approval')
      if (pending) agentRef!.executor.resolveHilTask(pending.id, true)
      const deadline = Date.now() + 2_000
      while (Date.now() < deadline) {
        if (workspaceRef!.getAllTasks().some(t => t.tool === 'fs_read' && t.status === 'completed')) return
        await sleep(5)
      }
    }, 1) // one task; the wake turn just replies
    const { agent, workspace } = await startAgent({}, provider, (ws) => {
      ws.writeFile('notes.md', 'hello')
      const config = ws.getAgentConfig()
      config.tools = config.tools.map(t => (t.name === 'fs_read' ? { ...t, enabled: true, restricted: true } : t))
      ws.setAgentConfig(config)
    })
    workspaceRef = workspace
    agentRef = agent

    await agent.dispatch(chat('read it in the background'))
    const task = workspace.getAllTasks().find(t => t.tool === 'fs_read')
    expect(task?.status).toBe('completed')

    const deadline = Date.now() + 2_000
    while (provider.calls.length < 3 && Date.now() < deadline) await sleep(10)
    expect(provider.calls.length).toBeGreaterThanOrEqual(3)
    const wake = provider.calls[2].map(textOf).join('\n')
    expect(wake).toContain('A task has completed.')
    expect(wake).toContain(`Task ID: ${task!.id}`)
  })
})
