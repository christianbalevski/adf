/**
 * inter_agent_message parity (W2-B review item 9): the daemon registers its
 * agents with registerServableAgent (never foreground), so mesh-manager's
 * `foreground_incoming` never fires there. `agent_incoming` fires for every
 * delivery to a registered agent and reaches the client stream as the
 * `inter_agent_message` push: the full message to the session focused on the
 * recipient, a stub to the others.
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { AdfWorkspace } from '../src/main/adf/adf-workspace'
import { ClientSessionRegistry, wireMeshToClientSessions, type ClientFrame, type ClientStreamSink } from '../src/main/daemon/client-sessions'
import { AgentRuntimeBuilder } from '../src/main/runtime/agent-runtime-builder'
import { createHeadlessAgent, MockLLMProvider } from '../src/main/runtime/headless'
import { MeshManager } from '../src/main/runtime/mesh-manager'
import { clearAllUmbilicalBuses } from '../src/main/runtime/umbilical-bus'
import { createDispatch, createEvent } from '../src/shared/types/adf-event.types'
import type { CreateMessageOptions, LLMProvider } from '../src/main/providers/provider.interface'
import type { LLMResponse } from '../src/shared/types/provider.types'
import type { AgentConfig } from '../src/shared/types/adf-v02.types'

/** Sends one msg_send to `recipient` on its first turn, then ends turns. */
class MessagingProvider implements LLMProvider {
  readonly name = 'messaging'
  readonly modelId = 'messaging-v1'
  private sent = false
  constructor(private readonly recipient: string, private readonly content: string) {}
  async createMessage(_opts: CreateMessageOptions): Promise<LLMResponse> {
    if (this.sent) return { id: 'done', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }
    this.sent = true
    return { id: 'send', content: [{ type: 'tool_use', id: 'send-1', name: 'msg_send', input: { recipient: this.recipient, content: this.content } }], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } }
  }
  async validateConfig(): Promise<{ valid: boolean; error?: string }> { return { valid: true } }
}

class Sink extends EventEmitter implements ClientStreamSink {
  text = ''
  destroyed = false
  write(chunk: string): boolean { this.text += chunk; return true }
  destroy(): void { this.destroyed = true }
  frames(): ClientFrame[] {
    return this.text.split('\n\n').map(b => b.split('\n').find(l => l.startsWith('data: ') && b.includes('id: '))).filter(Boolean).map(l => JSON.parse(l!.slice(6)))
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
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

const running: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const stop of running.splice(0)) await stop()
  clearAllUmbilicalBuses()
})

describe('mesh: incoming messages for every registered agent', () => {
  it('a daemon-registered recipient raises agent_incoming; the focused session gets the message, the others a stub', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-mesh-incoming-'))
    const mesh = new MeshManager([dir])
    mesh.enableMesh()
    const noInbox = { on_inbox: { enabled: false, targets: [] } } as unknown as AgentConfig['triggers']
    const a1 = await buildAgent(dir, 'agent-1', new MessagingProvider('agent-2', 'hello from agent-1'), { triggers: noInbox })
    const a2 = await buildAgent(dir, 'agent-2', new MockLLMProvider(), { messaging: { receive: true, mode: 'respond_only' }, triggers: noInbox })
    running.push(async () => {
      mesh.disableMesh()
      await a1.agent.disposeAsync()
      await a2.agent.disposeAsync()
    })
    for (const a of [a1, a2]) {
      mesh.registerServableAgent(a.filePath, a.config, a.agent.registry, a.agent.workspace, a.agent.session, a.agent.executor, a.agent.adfCallHandler, a.agent.codeSandboxService, a.agent.triggerEvaluator)
    }

    const incoming: Array<{ filePath: string; fromAgent: string; toAgent: string; content: string }> = []
    mesh.on('agent_incoming', (e) => incoming.push(e))
    const foreground: unknown[] = []
    mesh.on('foreground_incoming', (e) => foreground.push(e))

    const sessions = new ClientSessionRegistry({ log: () => {} })
    sessions.indexAgent(a2.filePath, a2.config.id)
    wireMeshToClientSessions(sessions, mesh)
    const focused = sessions.create({ client: 'studio', version: '1' })
    sessions.setFocus(focused.sessionId, a2.config.id)
    const focusedSink = new Sink()
    sessions.attach(focused.sessionId, focusedSink)
    const other = sessions.create({ client: 'tui', version: '1' })
    const otherSink = new Sink()
    sessions.attach(other.sessionId, otherSink)

    await a1.agent.dispatch(createDispatch(createEvent({
      type: 'chat',
      source: 'test',
      data: { message: { seq: 0, role: 'user', content_json: [{ type: 'text', text: 'message agent-2' }], created_at: Date.now() } },
    }), { scope: 'agent' }))
    await waitFor(() => incoming.length > 0)
    await new Promise(r => setImmediate(r))

    expect(foreground).toEqual([]) // the daemon has no foreground agents
    expect(incoming).toEqual([expect.objectContaining({ fromAgent: 'agent-1', toAgent: 'agent-2', content: 'hello from agent-1' })])
    const message = (sink: Sink) => sink.frames().find(f => f.kind === 'push' && f.topic === 'inter_agent_message')
    expect(message(focusedSink)).toMatchObject({ agentId: a2.config.id, payload: { fromAgent: 'agent-1', toAgent: 'agent-2', content: 'hello from agent-1', direction: 'incoming' } })
    expect(message(otherSink)).toMatchObject({ stripped: 'stub', payload: { fromAgent: 'agent-1', toAgent: 'agent-2', size: 18, direction: 'incoming' } })
    expect(message(otherSink)?.kind === 'push' && 'content' in (message(otherSink)!.payload as object)).toBe(false)
  })
})
