/**
 * The umbilical `/events` output of a daemon agent's life (load, startup turn,
 * chat turn, display-state change, unload) through RuntimeService and the
 * daemon builder. W1-A adds host lifecycle events beside this stream; this
 * snapshot pins that the stream itself does not change.
 */
import { copyFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  const dir = join(tmpdir(), `adf-runtime-events-snapshot-${process.pid}`)
  return {
    app: { getPath: () => dir, on: () => {}, getName: () => 'adf-runtime-events-snapshot', getVersion: () => '0.0.0-test' },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (s: string) => Buffer.from(s, 'utf-8'),
      decryptString: (b: Buffer) => b.toString('utf-8'),
    },
    shell: { openExternal: async () => {} },
    ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
    BrowserWindow: class {},
    dialog: {},
  }
})

import { DaemonEventBus, type DaemonEventEnvelope } from '../src/main/daemon/event-bus'
import { registerDaemonEventBus } from '../src/main/runtime/emit-umbilical'
import { RuntimeService } from '../src/main/runtime/runtime-service'
import { AgentRuntimeBuilder } from '../src/main/runtime/agent-runtime-builder'
import { createHeadlessAgent, MockLLMProvider } from '../src/main/runtime/headless'
import { clearAllUmbilicalBuses } from '../src/main/runtime/umbilical-bus'
import { createDispatch, createEvent } from '../src/shared/types/adf-event.types'

afterAll(() => clearAllUmbilicalBuses())

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out')
    await new Promise(r => setTimeout(r, 10))
  }
}

/** event_type, source, loop and payload keys: everything but ids, times and values. */
function normalize(event: DaemonEventEnvelope['event']): string {
  // `agent:<id>` sources carry a per-dispatch id.
  const source = event.source.replace(/^agent:.+$/, 'agent:<id>')
  const keys = Object.keys(event.payload ?? {}).sort().join(',')
  const state = event.event_type === 'agent.state.changed' ? ` state=${String((event.payload as { state?: unknown }).state)}` : ''
  return `${event.event_type} source=${source}${event.loop ? ` loop=${event.loop}` : ''}${state} {${keys}}`
}

describe('RuntimeService umbilical /events output', () => {
  it('is unchanged for load, startup turn, chat turn, state change and unload', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-runtime-events-snapshot-'))
    const filePath = join(dir, 'agent-1.adf')
    const created = createHeadlessAgent({ filePath, name: 'agent-1', provider: new MockLLMProvider() })
    const agentId = created.workspace.getAgentConfig().id
    created.dispose()

    const bus = new DaemonEventBus(5000)
    registerDaemonEventBus(bus)
    const events: string[] = []
    bus.subscribe(envelope => { if (envelope.event.agent_id === agentId) events.push(normalize(envelope.event)) })

    const runtime = new RuntimeService({
      settings: { get: (key: string) => (key === 'reviewedAgents' ? [agentId] : undefined) },
      providerFactory: () => new MockLLMProvider({ tokensPerResponse: 10 }),
      agentRuntimeBuilder: new AgentRuntimeBuilder(),
    })

    const ref = await runtime.loadAgent(filePath)
    await runtime.startAgent(ref.id)
    await waitFor(() => events.some(e => e.startsWith('turn.completed')))
    await runtime.sendChat(ref.id, 'hello')
    runtime.setAgentDisplayState(ref.id, 'hibernate')
    await runtime.unloadAgent(ref.id)

    expect(events.join('\n')).toMatchSnapshot()
  })

  // W1-A cases. Each was recorded on the pre-W1-A RuntimeService first; the
  // snapshot of a case whose output W1-A changes says so in its name.

  /** One agent-1 file, a runtime with the daemon builder and a recorder for its id. */
  function scene(opts: { providerFactory?: () => MockLLMProvider } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'adf-runtime-events-snapshot-'))
    const filePath = join(dir, 'agent-1.adf')
    const created = createHeadlessAgent({ filePath, name: 'agent-1', provider: new MockLLMProvider() })
    const agentId = created.workspace.getAgentConfig().id
    created.dispose()
    const bus = new DaemonEventBus(5000)
    registerDaemonEventBus(bus)
    const events: string[] = []
    let recording = true
    bus.subscribe(envelope => { if (recording && envelope.event.agent_id === agentId) events.push(normalize(envelope.event)) })
    const runtime = new RuntimeService({
      settings: { get: (key: string) => (key === 'reviewedAgents' ? [agentId] : undefined) },
      providerFactory: opts.providerFactory ?? (() => new MockLLMProvider({ tokensPerResponse: 10 })),
      agentRuntimeBuilder: new AgentRuntimeBuilder(),
    })
    const stop = async () => {
      recording = false
      for (const a of runtime.listAgents()) await runtime.unloadAgent(a.id, { mode: 'immediate' }).catch(() => {})
    }
    return { dir, filePath, agentId, runtime, events, stop }
  }

  it('agent off (W1-A changes it: the agent is unloaded, as in Studio)', async () => {
    const { filePath, runtime, events, stop } = scene()
    const ref = await runtime.loadAgent(filePath)
    runtime.setAgentDisplayState(ref.id, 'off')
    await waitFor(() => events.some(e => e.includes('state=off')))
    await new Promise(r => setTimeout(r, 300))
    await stop()
    expect(events.join('\n')).toMatchSnapshot()
  })

  it('a failed load', async () => {
    const { filePath, runtime, events, stop } = scene({ providerFactory: () => { throw new Error('no provider here') } })
    await expect(runtime.loadAgent(filePath)).rejects.toThrow('no provider here')
    await stop()
    expect(events.join('\n')).toMatchSnapshot()
  })

  it('a trigger error', async () => {
    const { filePath, runtime, events, stop } = scene()
    const ref = await runtime.loadAgent(filePath)
    const agent = (runtime as unknown as { requireAgent(id: string): { agent: { executor: { executeTurn: unknown }; triggerEvaluator: { emit(e: string, d: unknown): void }; workspace: { getLogs(n: number): Array<{ event: string | null; message: string }> } } } }).requireAgent(ref.id).agent
    const errors: unknown[] = []
    const origError = console.error
    console.error = (...args: unknown[]) => { errors.push(args) }
    try {
      agent.executor.executeTurn = async () => { throw new Error('turn exploded') }
      agent.triggerEvaluator.emit('trigger', createDispatch(createEvent({ type: 'chat', source: 'test', data: { message: { seq: 0, role: 'user', content_json: [{ type: 'text', text: 'wake' }], created_at: 1 } } }), { scope: 'agent' }))
      await new Promise(r => setTimeout(r, 200))
    } finally {
      console.error = origError
    }
    // The error fired: the daemon builder's trigger_error log row (before and after W1-A).
    expect(agent.workspace.getLogs(50)).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'trigger_error', message: 'turn exploded' }),
    ]))
    await stop()
    expect(events.join('\n')).toMatchSnapshot()
  })

  it("a second file with a loaded agent's id (W1-A changes it: refused before it is built)", async () => {
    const { dir, filePath, runtime, events, stop } = scene()
    await runtime.loadAgent(filePath)
    const copy = join(dir, 'agent-2.adf')
    copyFileSync(filePath, copy)
    await runtime.loadAgent(copy).catch(() => {})
    await new Promise(r => setTimeout(r, 200))
    await stop()
    expect(events.join('\n')).toMatchSnapshot()
  })
})
