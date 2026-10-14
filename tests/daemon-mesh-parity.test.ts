import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { AdfWorkspace } from '../src/main/adf/adf-workspace'
import { AgentRuntimeBuilder } from '../src/main/runtime/agent-runtime-builder'
import { createHeadlessAgent, MockLLMProvider } from '../src/main/runtime/headless'
import { MeshManager } from '../src/main/runtime/mesh-manager'
import { ChannelAdapterManager } from '../src/main/services/channel-adapter-manager'
import { clearAllUmbilicalBuses } from '../src/main/runtime/umbilical-bus'
import { createDispatch, createEvent } from '../src/shared/types/adf-event.types'
import type { AssembledAgent } from '../src/main/runtime/assemble-agent'
import type { CreateMessageOptions, LLMProvider } from '../src/main/providers/provider.interface'
import type { LLMResponse } from '../src/shared/types/provider.types'
import type { AgentConfig } from '../src/shared/types/adf-v02.types'

/**
 * Parity scenario "mesh-triggered turn" (tracker W1-B acceptance; stub for the
 * W5-A parity harness). Two daemon-built agents in one runtime: agent-1 sends
 * agent-2 a message from a chat turn; agent-2 (messaging mode respond_only,
 * on_inbox on) wakes on it and replies. The same scenario runs against the
 * registration Studio's background host performs (registerAgent with the
 * executor's isMessageTriggered) and the daemon's (registerServableAgent), and
 * the observable results must match.
 */

type Register = (mesh: MeshManager, filePath: string, config: AgentConfig, agent: AssembledAgent<'daemon'>) => void

const studioBackgroundRegistration: Register = (mesh, filePath, config, agent) => {
  mesh.registerAgent(
    filePath, config, agent.registry, agent.workspace, agent.session, agent.triggerEvaluator, false,
    () => agent.executor.isMessageTriggered,
    agent.executor, agent.adfCallHandler, agent.codeSandboxService,
  )
}

const daemonRegistration: Register = (mesh, filePath, config, agent) => {
  mesh.registerServableAgent(
    filePath, config, agent.registry, agent.workspace, agent.session,
    agent.executor, agent.adfCallHandler, agent.codeSandboxService, agent.triggerEvaluator,
  )
}

/** Sends one msg_send to `recipient` on its first turn; every other step ends the turn. */
class MessagingProvider implements LLMProvider {
  readonly name = 'messaging'
  readonly modelId = 'messaging-v1'
  readonly toolResults: Array<{ ok: boolean; text: string }> = []
  calls = 0
  constructor(private readonly recipient: string, private readonly content: string) {}

  async createMessage(opts: CreateMessageOptions): Promise<LLMResponse> {
    this.calls++
    const last = opts.messages[opts.messages.length - 1]
    const lastBlocks = Array.isArray(last?.content) ? last.content : []
    const toolResult = lastBlocks.find((b: { type: string }) => b.type === 'tool_result') as { content?: unknown; is_error?: boolean } | undefined
    if (toolResult || this.toolResults.length > 0) {
      if (!toolResult) return { id: `idle-${this.calls}`, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }
      this.toolResults.push({
        ok: !toolResult.is_error,
        text: typeof toolResult.content === 'string' ? toolResult.content : JSON.stringify(toolResult.content),
      })
      return { id: `done-${this.calls}`, content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }
    }
    return {
      id: `send-${this.calls}`,
      content: [{ type: 'tool_use', id: `send-${this.calls}`, name: 'msg_send', input: { recipient: this.recipient, content: this.content } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 1, output_tokens: 1 },
    }
  }

  async validateConfig(): Promise<{ valid: boolean; error?: string }> {
    return { valid: true }
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for predicate')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function buildAgent(dir: string, name: string, provider: LLMProvider, patch: Partial<AgentConfig>) {
  const filePath = join(dir, `${name}.adf`)
  createHeadlessAgent({ filePath, name, provider: new MockLLMProvider(), createOptions: { handle: name } }).dispose()
  const workspace = AdfWorkspace.open(filePath)
  workspace.setAgentConfig({ ...workspace.getAgentConfig(), ...patch })
  const config = workspace.getAgentConfig()
  const agent = await new AgentRuntimeBuilder().build({ workspace, filePath, config, provider, restoreLoop: true })
  return { filePath, workspace, config, agent }
}

interface ScenarioResult {
  agent1Inbox: string[]
  agent2Inbox: string[]
  agent2Turns: number
  agent1SendResults: string[]
  agent2SendResults: string[]
  busRegistrations: string[]
  outbox1: string[]
  outbox2: string[]
}

const running: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const stop of running.splice(0)) await stop()
  clearAllUmbilicalBuses()
})

async function runMeshTurnScenario(register: Register): Promise<ScenarioResult> {
  const dir = mkdtempSync(join(tmpdir(), 'adf-mesh-parity-'))
  const mesh = new MeshManager([dir])
  mesh.enableMesh()
  const provider1 = new MessagingProvider('agent-2', 'hello from agent-1')
  const provider2 = new MessagingProvider('agent-1', 'reply from agent-2')
  const base = await buildAgent(dir, 'agent-0', new MockLLMProvider(), {})
  await base.agent.disposeAsync()
  const noInbox = { ...base.config.triggers, on_inbox: { enabled: false, targets: [] } } as AgentConfig['triggers']
  const onInbox = { ...base.config.triggers, on_inbox: { enabled: true, targets: [{ scope: 'agent' }] } } as AgentConfig['triggers']
  const a1 = await buildAgent(dir, 'agent-1', provider1, { triggers: noInbox })
  const a2 = await buildAgent(dir, 'agent-2', provider2, {
    messaging: { receive: true, mode: 'respond_only' },
    triggers: onInbox,
  })
  running.push(async () => {
    mesh.disableMesh()
    await a1.agent.disposeAsync()
    await a2.agent.disposeAsync()
  })
  register(mesh, a1.filePath, a1.config, a1.agent)
  register(mesh, a2.filePath, a2.config, a2.agent)

  await a1.agent.dispatch(createDispatch(
    createEvent({
      type: 'chat',
      source: 'test',
      data: { message: { seq: 0, role: 'user', content_json: [{ type: 'text', text: 'message agent-2' }], created_at: Date.now() } },
    }),
    { scope: 'agent' },
  ))
  await waitFor(() => provider2.toolResults.length > 0)
  await waitFor(() => a1.workspace.getInbox('unread').length > 0)

  const inbox = (ws: AdfWorkspace) => [...ws.getInbox('unread'), ...ws.getInbox('read')].map(m => String(m.content))
  const outbox = (ws: AdfWorkspace) => ws.getOutbox().map(m => `${m.status}:${m.content}`)
  return {
    agent1Inbox: inbox(a1.workspace),
    agent2Inbox: inbox(a2.workspace),
    agent2Turns: provider2.calls,
    agent1SendResults: provider1.toolResults.map(r => r.ok),
    agent2SendResults: provider2.toolResults.map(r => r.ok),
    busRegistrations: mesh.getDebugInfo().busRegistrations.map(r => r.name).sort(),
    outbox1: outbox(a1.workspace),
    outbox2: outbox(a2.workspace),
  }
}

describe('parity scenario: mesh-triggered turn between agent-1 and agent-2', () => {
  it('behaves the same under the daemon registration as under Studio background registration', async () => {
    const studio = await runMeshTurnScenario(studioBackgroundRegistration)
    const daemon = await runMeshTurnScenario(daemonRegistration)

    // Absolute expectations: each message lands exactly once (no double
    // delivery through the bus), and the respond_only reply is allowed
    // because the turn was message-triggered.
    expect(studio.agent2Inbox).toEqual(['hello from agent-1'])
    expect(studio.agent1Inbox).toEqual(['reply from agent-2'])
    expect(studio.agent1SendResults).toEqual([true])
    expect(studio.agent2SendResults).toEqual([true])
    expect(studio.outbox1).toEqual(['delivered:hello from agent-1'])
    expect(studio.outbox2).toEqual(['delivered:reply from agent-2'])
    expect(studio.busRegistrations).toHaveLength(2)

    const normalize = (r: ScenarioResult) => ({ ...r, busRegistrations: r.busRegistrations.map(name => name.replace(/^.*[\\/]/, '')) })
    expect(normalize(daemon)).toEqual(normalize(studio))
  }, 30_000)
})

describe('daemon mesh registration', () => {
  it('follows config changes announced by the builder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-mesh-config-'))
    const mesh = new MeshManager([dir])
    mesh.enableMesh()
    const a1 = await buildAgent(dir, 'agent-1', new MockLLMProvider(), {})
    running.push(async () => { mesh.disableMesh(); await a1.agent.disposeAsync() })
    daemonRegistration(mesh, a1.filePath, a1.config, a1.agent)

    const next = { ...a1.workspace.getAgentConfig(), description: 'changed by a config write' }
    a1.workspace.setAgentConfig(next)
    a1.agent.applyConfigChange(next)
    expect(mesh.getServableAgent('agent-1')?.config).toBe(next)

    // After unregistering, a later change no longer reaches the mesh.
    mesh.unregisterAgent(a1.filePath)
    const after = { ...next, description: 'after unregister' }
    a1.agent.applyConfigChange(after)
    expect(mesh.getServableAgent('agent-1')).toBeNull()
  })

  it('holds the adapter manager only while the agent is registered', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-mesh-adapters-'))
    const mesh = new MeshManager([dir])
    const adapterManagers = (mesh as unknown as { adapterManagers: Map<string, unknown> }).adapterManagers
    const a1 = await buildAgent(dir, 'agent-1', new MockLLMProvider(), {})
    running.push(async () => { mesh.disableMesh(); await a1.agent.disposeAsync() })
    const manager = new ChannelAdapterManager()
    const register = () => mesh.registerServableAgent(
      a1.filePath, a1.config, a1.agent.registry, a1.agent.workspace, a1.agent.session,
      a1.agent.executor, a1.agent.adfCallHandler, a1.agent.codeSandboxService, a1.agent.triggerEvaluator, manager,
    )

    // Disabled mesh: not registered, so the manager is not kept either.
    register()
    expect(adapterManagers.has(a1.filePath)).toBe(false)

    mesh.enableMesh()
    register()
    expect(adapterManagers.get(a1.filePath)).toBe(manager)

    mesh.unregisterAgent(a1.filePath)
    expect(adapterManagers.has(a1.filePath)).toBe(false)
  })

  it('registers nobody while the mesh is disabled (Studio parity)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-mesh-disabled-'))
    const mesh = new MeshManager([dir])
    const a1 = await buildAgent(dir, 'agent-1', new MockLLMProvider(), {})
    running.push(async () => { await a1.agent.disposeAsync() })
    daemonRegistration(mesh, a1.filePath, a1.config, a1.agent)
    expect(mesh.getServableAgent('agent-1')).toBeNull()
    expect(mesh.getDebugInfo().busRegistrations).toEqual([])
  })
})
