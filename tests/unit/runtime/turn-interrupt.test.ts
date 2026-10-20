/**
 * The turn interrupt (Studio's Stop and Esc, the terminal app's Esc,
 * POST /agents/:id/interrupt): it ends the running turn and stops its work.
 *
 * - mid-provider-stream: the model request is cancelled, the loop shows
 *   "Turn interrupted", the agent is idle and still takes work;
 * - mid-tool: the tool gets the abort signal, its host shell is killed, and
 *   a tool that ignores the signal no longer holds the turn;
 * - a pending approval ends with no decision (endedBy interrupt);
 * - the loop stays consistent: every tool_use has a result and the next turn
 *   sends well-formed history;
 * - Off (immediate) starts no further tool and kills the agent's shells.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { AgentRuntimeBuilder } from '../../../src/main/runtime/agent-runtime-builder'
import { createHeadlessAgent, MockLLMProvider } from '../../../src/main/runtime/headless'
import { clearAllUmbilicalBuses } from '../../../src/main/runtime/umbilical-bus'
import { approvalHub } from '../../../src/main/runtime/approval-hub'
import { INTERRUPTED_TOOL_RESULT, TURN_INTERRUPTED_NOTICE } from '../../../src/main/runtime/agent-executor'
import { interruptLoopTurn, InterruptRefusedError } from '../../../src/main/runtime/interrupt-turn'
import { hostExec, killAllHostExecs, liveHostExecCount } from '../../../src/main/services/host-exec.service'
import { createDispatch, createEvent } from '../../../src/shared/types/adf-event.types'
import { parseLoopToDisplay } from '../../../src/shared/utils/loop-parser'
import type { CreateMessageOptions, LLMProvider } from '../../../src/main/providers/provider.interface'
import type { ContentBlock, LLMMessage, LLMResponse } from '../../../src/shared/types/provider.types'
import type { Tool, ToolCallContext } from '../../../src/main/tools/tool.interface'
import type { ToolResult } from '../../../src/shared/types/tool.types'
import type { AgentExecutionEvent, ToolApprovalResolvedPayload } from '../../../src/shared/types/ipc.types'

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

async function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: timed out')
    await sleep(10)
  }
}

type Step = { kind: 'text'; text: string } | { kind: 'tools'; text?: string; calls: Array<{ id: string; name: string; input?: Record<string, unknown> }> } | { kind: 'hang' }

/**
 * Plays one step per model call. `hang` streams a delta and then waits until
 * the request is aborted (a provider stuck mid-stream). Records every
 * request's messages and whether its signal was aborted.
 */
class ScriptedProvider implements LLMProvider {
  readonly name = 'scripted'
  readonly modelId = 'scripted-v1'
  steps: Step[] = []
  requests: LLMMessage[][] = []
  abortedCalls = 0

  async createMessage(opts: CreateMessageOptions): Promise<LLMResponse> {
    this.requests.push(structuredClone(opts.messages))
    const step = this.steps.shift() ?? { kind: 'text', text: 'done' }
    if (step.kind === 'hang') {
      opts.onThinkingDelta?.('Planning the essay.')
      opts.onTextDelta?.('The essay begins')
      await new Promise<void>((_resolve, reject) => {
        const onAbort = () => { this.abortedCalls++; reject(Object.assign(new Error('Request aborted'), { name: 'AbortError' })) }
        if (opts.signal?.aborted) return onAbort()
        opts.signal?.addEventListener('abort', onAbort, { once: true })
      })
    }
    if (step.kind === 'tools') {
      return {
        id: `r${this.requests.length}`,
        content: [
          ...(step.text ? [{ type: 'text', text: step.text } as ContentBlock] : []),
          ...step.calls.map(c => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input ?? {} }) as ContentBlock),
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 100, output_tokens: 10 },
      }
    }
    return {
      id: `r${this.requests.length}`,
      content: [{ type: 'text', text: step.kind === 'text' ? step.text : '' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 10 },
    }
  }

  async validateConfig(): Promise<{ valid: boolean; error?: string }> {
    return { valid: true }
  }
}

/** A test tool: `run` decides what it does with the call's signal. */
function testTool(name: string, run: (ctx?: ToolCallContext) => Promise<ToolResult>): Tool {
  return {
    name,
    description: `test tool ${name}`,
    inputSchema: z.record(z.unknown()),
    category: 'system',
    execute: (_input, _ws, ctx) => run(ctx),
    toProviderFormat: () => ({ name, description: `test tool ${name}`, input_schema: { type: 'object', properties: {} } }),
  }
}

const TOOL_NAMES = ['test_shell', 'test_stubborn', 'test_count', 'test_gated']

async function buildAgent(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `adf-interrupt-${name}-`))
  const filePath = join(dir, 'agent-1.adf')
  createHeadlessAgent({ filePath, name: 'agent-1', provider: new MockLLMProvider() }).dispose()
  const workspace = AdfWorkspace.open(filePath)
  const base = workspace.getAgentConfig()
  const config = {
    ...base,
    tools: [
      ...base.tools,
      ...TOOL_NAMES.map(n => ({ name: n, enabled: true, visible: true, restricted: n === 'test_gated' })),
    ],
  }
  const provider = new ScriptedProvider()
  const agent = await new AgentRuntimeBuilder().build({ workspace, filePath, config, provider })
  const owner = config.id
  const shell = { result: null as { code: number; stderr: string } | null, sawAbort: false }
  let counted = 0
  agent.registry.register(testTool('test_shell', async (ctx) => {
    const r = await hostExec(dir, 'sleep 30', 60_000, { owner, signal: ctx?.signal })
    shell.result = r
    shell.sawAbort = ctx?.signal?.aborted === true
    return { content: JSON.stringify(r), isError: false }
  }))
  // Ignores the signal and takes 1.5s: the turn must not wait for it.
  agent.registry.register(testTool('test_stubborn', async () => { await sleep(1_500); return { content: 'stubborn done', isError: false } }))
  agent.registry.register(testTool('test_count', async () => { counted++; return { content: 'counted', isError: false } }))
  agent.registry.register(testTool('test_gated', async () => ({ content: 'gated ran', isError: false })))
  const events: AgentExecutionEvent[] = []
  agent.executor.on('event', (e: AgentExecutionEvent) => events.push(e))
  return { agent, provider, workspace, owner, shell, events, counted: () => counted }
}

function chat(text: string) {
  return createDispatch(createEvent({
    type: 'chat',
    source: 'test',
    data: { message: { seq: 0, role: 'user', content_json: [{ type: 'text', text }], created_at: Date.now() } },
  }), { scope: 'agent' })
}

function rowText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(b => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : '')).join('')
}

/** Every tool_use in these messages has a tool_result in the message right after it. */
function expectPaired(messages: Array<{ role: string; content: unknown }>): void {
  messages.forEach((m, i) => {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) return
    const ids = (m.content as ContentBlock[]).filter(b => b.type === 'tool_use').map(b => b.id)
    if (ids.length === 0) return
    const next = messages[i + 1]
    const results = Array.isArray(next?.content) ? (next!.content as ContentBlock[]).filter(b => b.type === 'tool_result').map(b => b.tool_use_id) : []
    expect(next?.role).toBe('user')
    for (const id of ids) expect(results).toContain(id)
  })
}

beforeEach(() => { clearAllUmbilicalBuses(); approvalHub.clear() })
afterEach(async () => { approvalHub.clear(); await killAllHostExecs(3_000) })

describe('turn interrupt', () => {
  it('mid-provider-stream: cancels the request, writes "Turn interrupted", leaves the agent idle', async () => {
    const { agent, provider, workspace, events } = await buildAgent('stream')
    try {
      provider.steps = [{ kind: 'hang' }]
      const turn = agent.executor.executeTurn(chat('write a long essay'))
      await waitFor(() => provider.requests.length === 1)
      expect(agent.executor.isTurnActive()).toBe(true)

      expect(interruptLoopTurn(agent.executor, agent.loopPool)).toEqual({ interrupted: true, loop: 'main' })
      await turn

      expect(provider.abortedCalls).toBe(1)
      expect(agent.executor.getState()).toBe('idle')
      expect(agent.executor.isTurnActive()).toBe(false)
      const loop = workspace.getLoop()
      expect(rowText(loop.at(-1)!.content_json)).toBe(TURN_INTERRUPTED_NOTICE)
      // What the model had streamed is its own output, saved before the notice and marked.
      const partial = loop.at(-2)!
      expect(partial.role).toBe('assistant')
      expect(partial.content_json).toEqual([
        { type: 'thinking', thinking: 'Planning the essay.', interrupted: true },
        { type: 'text', text: 'The essay begins', interrupted: true },
      ])
      expect(events.some(e => e.type === 'context_injected' && (e.payload as { content?: string }).content === TURN_INTERRUPTED_NOTICE)).toBe(true)
      expect(events.find(e => e.type === 'turn_complete')?.payload).toMatchObject({ interrupted: true, partial: true, seq: partial.seq })

      // A reload shows the partial text with its label (the parser Studio and the TUI use).
      const shown = parseLoopToDisplay(loop).filter(d => d.type === 'text' || d.type === 'thinking')
      expect(shown.map(d => [d.type, d.content, d.metadata?.interrupted])).toEqual([
        ['thinking', 'Planning the essay.', true],
        ['text', 'The essay begins', true],
      ])

      // Nothing running: a second interrupt is a no-op, and the agent still takes work.
      expect(interruptLoopTurn(agent.executor, agent.loopPool)).toEqual({ interrupted: false, loop: 'main' })
      provider.steps = [{ kind: 'text', text: 'hello again' }]
      await agent.executor.executeTurn(chat('are you there?'))
      expect(rowText(workspace.getLoop().at(-1)!.content_json)).toBe('hello again')
      // The next call sees the partial text as its own prior output, roles alternating.
      const next = provider.requests.at(-1)!
      const at = next.findIndex(m => m.role === 'assistant' && rowText(m.content) === 'The essay begins')
      expect(at).toBeGreaterThan(0)
      expect(next[at - 1].role).toBe('user')
      expect(next[at + 1].role).toBe('user')
      expect(rowText(next[at + 1].content)).toBe(TURN_INTERRUPTED_NOTICE)
    } finally {
      await agent.disposeAsync()
    }
  })

  it('mid-tool: the host shell is killed and every call of the batch gets a result', async () => {
    const { agent, provider, workspace, owner, shell, events, counted } = await buildAgent('shell')
    try {
      provider.steps = [{ kind: 'tools', text: 'Starting the build now.', calls: [{ id: 'tu_shell', name: 'test_shell' }, { id: 'tu_count', name: 'test_count' }] }]
      const turn = agent.executor.executeTurn(chat('run the build'))
      await waitFor(() => liveHostExecCount(owner) === 1)

      const started = Date.now()
      interruptLoopTurn(agent.executor, agent.loopPool)
      await turn
      expect(Date.now() - started).toBeLessThan(5_000)

      await waitFor(() => shell.result !== null)
      expect(shell.sawAbort).toBe(true)
      expect(shell.result!.code).toBe(130)
      expect(shell.result!.stderr).toContain('interrupted')
      expect(liveHostExecCount(owner)).toBe(0)
      // The second call never ran.
      expect(counted()).toBe(0)

      const loop = workspace.getLoop()
      // The text the model wrote before its tool calls stays, as a finished row (no marker).
      const assistantRows = loop.filter(r => r.role === 'assistant')
      expect(assistantRows).toHaveLength(1)
      expect((assistantRows[0].content_json as ContentBlock[])[0]).toEqual({ type: 'text', text: 'Starting the build now.' })
      const results = loop.flatMap(r => (Array.isArray(r.content_json) ? r.content_json as ContentBlock[] : []).filter(b => b.type === 'tool_result'))
      expect(results.map(r => [r.tool_use_id, r.content])).toEqual([
        ['tu_shell', INTERRUPTED_TOOL_RESULT],
        ['tu_count', INTERRUPTED_TOOL_RESULT],
      ])
      // The call on screen ends on screen; the one never started shows nothing.
      const shown = events.filter(e => e.type === 'tool_call_result').map(e => (e.payload as { id: string }).id)
      expect(shown).toEqual(['tu_shell'])
      expect(rowText(loop.at(-1)!.content_json)).toBe(TURN_INTERRUPTED_NOTICE)
      expect(agent.executor.getState()).toBe('idle')
    } finally {
      await agent.disposeAsync()
    }
  }, 20_000)

  it('a tool that ignores the signal no longer holds the turn', async () => {
    const { agent, provider } = await buildAgent('stubborn')
    try {
      provider.steps = [{ kind: 'tools', calls: [{ id: 'tu_s', name: 'test_stubborn' }] }]
      const turn = agent.executor.executeTurn(chat('wait for it'))
      await waitFor(() => agent.executor.getState() === 'tool_use')
      await sleep(50)
      const started = Date.now()
      interruptLoopTurn(agent.executor, agent.loopPool)
      await turn
      expect(Date.now() - started).toBeLessThan(1_000)
      expect(agent.executor.getState()).toBe('idle')
    } finally {
      await sleep(1_600)
      await agent.disposeAsync()
    }
  }, 10_000)

  it('with a pending approval: the wait ends with no decision and the call reads interrupted', async () => {
    const { agent, provider, workspace, events } = await buildAgent('approval')
    try {
      // An approval raised beside the turn (a lambda's) is not the turn's.
      const beside = agent.executor.requestHilApproval('test_gated', { from: 'lambda' }, undefined, { besideTurn: true })
      provider.steps = [{ kind: 'tools', calls: [{ id: 'tu_gated', name: 'test_gated' }] }]
      const turn = agent.executor.executeTurn(chat('do the gated thing'))
      await waitFor(() => agent.executor.getPendingApprovals().length === 2)
      expect(agent.executor.getState()).toBe('awaiting_approval')
      const turnTask = agent.executor.getPendingApprovals().find(p => (p.input as { from?: string }).from !== 'lambda')!.requestId

      interruptLoopTurn(agent.executor, agent.loopPool)
      await turn

      const resolved = events.filter(e => e.type === 'tool_approval_resolved').map(e => e.payload as ToolApprovalResolvedPayload)
      expect(resolved).toEqual([{ requestId: turnTask, approved: false, endedBy: 'interrupt' }])
      expect(workspace.getTask(turnTask)?.status).toBe('denied')
      // The lambda's approval stays open.
      expect(agent.executor.getPendingApprovals()).toHaveLength(1)
      const results = workspace.getLoop().flatMap(r => (Array.isArray(r.content_json) ? r.content_json as ContentBlock[] : []).filter(b => b.type === 'tool_result'))
      expect(results.map(r => r.content)).toEqual([INTERRUPTED_TOOL_RESULT])
      expect(agent.executor.getState()).toBe('idle')

      agent.executor.resolveApproval(agent.executor.getPendingApprovals()[0].requestId, false)
      await beside
    } finally {
      await agent.disposeAsync()
    }
  })

  it('leaves the loop consistent: the next turn sends paired history, queued chats replay', async () => {
    const { agent, provider, workspace } = await buildAgent('consistency')
    try {
      provider.steps = [{ kind: 'tools', calls: [{ id: 'tu_a', name: 'test_shell' }, { id: 'tu_b', name: 'test_count' }] }]
      const turn = agent.executor.executeTurn(chat('first'))
      await waitFor(() => agent.executor.getState() === 'tool_use')
      // A chat sent while the tool runs queues (Studio's Queue message).
      void agent.executor.executeTurn(chat('queued while working'))
      provider.steps = [{ kind: 'text', text: 'answered the queue' }]
      interruptLoopTurn(agent.executor, agent.loopPool)
      await turn
      await waitFor(() => !agent.executor.isTurnActive())

      // The queued chat ran as the next turn, after the interrupt notice.
      const next = provider.requests.at(-1)!
      expectPaired(next)
      const userTexts = next.filter(m => m.role === 'user').map(m => rowText(m.content)).filter(Boolean)
      expect(userTexts.slice(-2)).toEqual([TURN_INTERRUPTED_NOTICE, 'queued while working'])
      expectPaired(workspace.getLoop().map(r => ({ role: r.role, content: r.content_json })))
      expect(rowText(workspace.getLoop().at(-1)!.content_json)).toBe('answered the queue')
    } finally {
      await agent.disposeAsync()
    }
  }, 20_000)

  it('refuses an unknown loop', async () => {
    const { agent } = await buildAgent('unknown-loop')
    try {
      expect(() => interruptLoopTurn(agent.executor, agent.loopPool, 'nope')).toThrow(InterruptRefusedError)
    } finally {
      await agent.disposeAsync()
    }
  })
})

describe('Off', () => {
  it('immediate: no further tool starts, and the agent\'s host shells are killed', async () => {
    const { agent, provider, workspace, owner, counted } = await buildAgent('off')
    provider.steps = [{ kind: 'tools', calls: [{ id: 'tu_shell', name: 'test_shell' }, { id: 'tu_count', name: 'test_count' }] }]
    const turn = agent.executor.executeTurn(chat('run the build'))
    await waitFor(() => liveHostExecCount(owner) === 1)
    // A shell of the same agent outside the turn (an async task) goes too.
    const background = hostExec(tmpdir(), 'sleep 30', 60_000, { owner })
    await waitFor(() => liveHostExecCount(owner) === 2)
    // Another agent's shell is not touched.
    const other = hostExec(tmpdir(), 'sleep 30', 60_000, { owner: '9b2f4c1e-0d3a-4e6f-8a7b-1c2d3e4f5a6b' })

    const logs: string[] = []
    const insertLog = workspace.insertLog.bind(workspace)
    workspace.insertLog = (level, origin, event, target, message, data) => { logs.push(`${event}: ${message}`); insertLog(level, origin, event, target, message, data) }

    const started = Date.now()
    await agent.disposeAsync({ mode: 'immediate' })
    expect(Date.now() - started).toBeLessThan(4_000)
    await turn
    expect(liveHostExecCount(owner)).toBe(0)
    expect((await background).code).not.toBe(0)
    expect(liveHostExecCount('9b2f4c1e-0d3a-4e6f-8a7b-1c2d3e4f5a6b')).toBe(1)
    expect(logs.some(l => l.startsWith('host_shells_killed: Agent turned off: '))).toBe(true)
    await sleep(300)
    expect(counted()).toBe(0)
    await killAllHostExecs(3_000)
    await other
  }, 20_000)
})
