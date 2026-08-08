import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => {
  const dir = join(tmpdir(), `adf-bam-test-${process.pid}`)
  return {
    app: {
      getPath: (_name: string) => dir,
      on: () => {},
      getName: () => 'adf-bam-test',
      getVersion: () => '0.0.0-test',
    },
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

import { BackgroundAgentManager } from '../src/main/runtime/background-agent-manager'
import { RuntimeGate } from '../src/main/runtime/runtime-gate'
import { AdfWorkspace } from '../src/main/adf/adf-workspace'
import { createHeadlessAgent, MockLLMProvider } from '../src/main/runtime/headless'
import type { SettingsService } from '../src/main/services/settings.service'

function makeSettings(): SettingsService {
  return {
    get: (_key: string) => undefined,
    getProvider: (id: string) => ({
      id: id || 'mock',
      type: 'anthropic',
      name: 'mock-provider',
      apiKey: 'test-key',
    }),
  } as unknown as SettingsService
}

function createAdfFile(dir: string, name: string): string {
  const filePath = join(dir, `${name}.adf`)
  const created = createHeadlessAgent({
    filePath,
    name,
    provider: new MockLLMProvider(),
    // hibernate: no startup LLM turn, so the stub provider is never invoked
    createOptions: { start_in_state: 'hibernate' },
  })
  created.dispose()
  return filePath
}

const managers: BackgroundAgentManager[] = []

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    try { await manager.stopAll() } catch { /* best effort */ }
    manager.dispose()
  }
  RuntimeGate._resetForTests()
  vi.restoreAllMocks()
})

function makeManager(): BackgroundAgentManager {
  const manager = new BackgroundAgentManager(makeSettings(), '', {})
  managers.push(manager)
  return manager
}

describe('BackgroundAgentManager start races', () => {
  it('coalesces two concurrent startAgent calls on one path into a single instance', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-bam-race-'))
    const filePath = createAdfFile(dir, 'race-agent')
    const manager = makeManager()

    const openSpy = vi.spyOn(AdfWorkspace, 'open')
    let startedEvents = 0
    manager.on('background_agent_event', (event: { type: string }) => {
      if (event.type === 'agent_started') startedEvents++
    })

    // Both calls issued synchronously — the second must join the first's
    // in-flight promise instead of building a second full instance.
    const [first, second] = await Promise.all([
      manager.startAgent(filePath),
      manager.startAgent(filePath),
    ])

    expect(first).toBe(true)
    expect(second).toBe(true)
    expect(manager.getAgentCount()).toBe(1)
    expect(startedEvents).toBe(1)
    // Exactly one workspace open for the agent being started (a second open
    // would mean a second SQLite handle on the same file).
    const agentOpens = openSpy.mock.calls.filter(([p]) => String(p).endsWith('race-agent.adf'))
    expect(agentOpens).toHaveLength(1)

    await manager.stopAgent(filePath)
    expect(manager.getAgentCount()).toBe(0)
  })

  it('a start that finishes during final-teardown stopAll is disposed, not registered, and cannot reopen the gate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-bam-shutdown-'))
    const filePath = createAdfFile(dir, 'shutdown-agent')
    const manager = makeManager()

    let startedEvents = 0
    manager.on('background_agent_event', (event: { type: string }) => {
      if (event.type === 'agent_started') startedEvents++
    })

    // Start is in flight (suspended at its first await) when stopAll begins
    // teardown synchronously. The finishing start must observe the teardown
    // flag and dispose its just-built agent instead of registering it.
    const startPromise = manager.startAgent(filePath)
    const stopPromise = manager.stopAll({ finalTeardown: true })

    const started = await startPromise
    await stopPromise

    expect(started).toBe(false)
    expect(manager.getAgentCount()).toBe(0)
    expect(manager.hasAgent(filePath)).toBe(false)
    expect(startedEvents).toBe(0)

    // RuntimeGate must stay closed: deliberate-start resume() paths no-op
    // after final teardown, so the killed runtime cannot be reopened mid-quit.
    expect(RuntimeGate.stopped).toBe(true)
    RuntimeGate.resume()
    expect(RuntimeGate.stopped).toBe(true)

    // The agent file remains reopenable (workspace was disposed cleanly).
    const reopened = AdfWorkspace.open(filePath)
    expect(reopened.getAgentConfig().name).toBe('shutdown-agent')
    reopened.dispose()
  })

  it('emergency-stop stopAll (no finalTeardown) disposes racing starts but leaves the gate resumable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-bam-emergency-'))
    const filePath = createAdfFile(dir, 'emergency-agent')
    const manager = makeManager()

    // Same escape race as the final-teardown case: the in-flight start must
    // be disposed instead of registered even without the terminal latch.
    const startPromise = manager.startAgent(filePath)
    const stopPromise = manager.stopAll()

    const started = await startPromise
    await stopPromise

    expect(started).toBe(false)
    expect(manager.getAgentCount()).toBe(0)

    // EMERGENCY_STOP is resumable: the gate is stopped but NOT latched, so a
    // deliberate start re-opens it and agents can start without an app restart.
    expect(RuntimeGate.stopped).toBe(true)
    RuntimeGate.resume()
    expect(RuntimeGate.stopped).toBe(false)

    const restarted = await manager.startAgent(filePath)
    expect(restarted).toBe(true)
    expect(manager.getAgentCount()).toBe(1)
    await manager.stopAgent(filePath)
  })
})
