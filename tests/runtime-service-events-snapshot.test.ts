/**
 * The umbilical `/events` output of a daemon agent's life (load, startup turn,
 * chat turn, display-state change, unload) through RuntimeService and the
 * daemon builder. W1-A adds host lifecycle events beside this stream; this
 * snapshot pins that the stream itself does not change.
 */
import { mkdtempSync } from 'node:fs'
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
})
