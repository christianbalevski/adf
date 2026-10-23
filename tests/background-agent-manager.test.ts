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

  // The Kill race: a click that opens a background agent mid-stopAll would
  // take it to the foreground, out of the stop's reach.
  it('a background agent cannot be extracted for the foreground while stopAll stops it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-bam-extract-'))
    const filePath = createAdfFile(dir, 'extract-agent')
    const manager = makeManager()
    expect(await manager.startAgent(filePath)).toBe(true)

    // A start in flight makes stopAll wait before it clears its agents: the
    // window in which extract-agent is still listed but already being stopped.
    const racing = manager.startAgent(createAdfFile(dir, 'racing-agent'))
    const stopPromise = manager.stopAll()
    expect(manager.hasAgent(filePath)).toBe(true)
    expect(manager.extractBackgroundAgent(filePath)).toBeNull()
    await stopPromise
    await racing
    expect(manager.getAgentCount()).toBe(0)
  })

  it('a start that lands during a Kill, after stopAll finished, is refused', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-bam-kill-'))
    const filePath = createAdfFile(dir, 'late-agent')
    const manager = makeManager()
    await manager.stopAll()
    const release = RuntimeGate.beginKill()
    try {
      expect(await manager.startAgent(filePath)).toBe(false)
    } finally {
      release()
    }
    expect(manager.getAgentCount()).toBe(0)
  })
})

describe('RuntimeGate during a Kill', () => {
  it('resume() is refused until the Kill releases; the gate then stays stopped until a deliberate start', async () => {
    const release = RuntimeGate.beginKill()
    expect(RuntimeGate.stopped).toBe(true)
    expect(RuntimeGate.killing).toBe(true)
    let settled = false
    void RuntimeGate.whenKillSettled().then(() => { settled = true })

    RuntimeGate.resume()
    expect(RuntimeGate.stopped).toBe(true)

    release()
    release() // a second release is a no-op
    await Promise.resolve()
    expect(settled).toBe(true)
    expect(RuntimeGate.killing).toBe(false)
    expect(RuntimeGate.stopped).toBe(true)

    RuntimeGate.resume()
    expect(RuntimeGate.stopped).toBe(false)
  })

  it('overlapping Kills hold the gate until the last one releases', async () => {
    const first = RuntimeGate.beginKill()
    const second = RuntimeGate.beginKill()
    let settled = false
    void RuntimeGate.whenKillSettled().then(() => { settled = true })
    first()
    await Promise.resolve()
    expect(RuntimeGate.killing).toBe(true)
    expect(settled).toBe(false)
    second()
    await Promise.resolve()
    expect(RuntimeGate.killing).toBe(false)
    expect(settled).toBe(true)
  })

  it('killedSince: a Kill begun after the epoch was taken, even one already over', () => {
    const epoch = RuntimeGate.killEpoch
    expect(RuntimeGate.killedSince(epoch)).toBe(false)
    RuntimeGate.beginKill()()
    expect(RuntimeGate.killedSince(epoch)).toBe(true)
    expect(RuntimeGate.killedSince(RuntimeGate.killEpoch)).toBe(false)
  })
})

describe('BackgroundAgentManager adapter inbox pushes', () => {
  it('preserves canonical inbox sender, content and reply metadata in the renderer snapshot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-bam-inbox-'))
    const filePath = createAdfFile(dir, 'agent-1')
    const manager = makeManager()
    expect(await manager.startAgent(filePath)).toBe(true)
    const agent = manager.getAgent(filePath)!
    const messageId = agent.workspace.addToInbox({ from: 'telegram:123', content: 'hello team', source: 'telegram', parent_id: 'parent-1', source_context: { chat_id: '123' }, received_at: 1234, status: 'unread' })
    const pushes: unknown[] = []
    manager.on('inbox_updated', (push: unknown) => pushes.push(push))
    expect(agent.adapterManager).not.toBeNull()
    agent.adapterManager!.emit('inbound', 'telegram', { sender: '123', payload: 'hello team' }, { inboxId: messageId })
    expect(pushes).toEqual([{ filePath: agent.workspace.getFilePath(), inbox: { version: 1, messages: agent.workspace.getInbox() } }])
    expect(pushes).toEqual([expect.objectContaining({ inbox: expect.objectContaining({ messages: [expect.objectContaining({ from: 'telegram:123', content: 'hello team', parent_id: 'parent-1', source_context: { chat_id: '123' } })] }) })])
  })

  it('includes archived messages, unread then read then archived, like the foreground push', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-bam-inbox-archived-'))
    const filePath = createAdfFile(dir, 'agent-1')
    const manager = makeManager()
    expect(await manager.startAgent(filePath)).toBe(true)
    const agent = manager.getAgent(filePath)!
    const archived = agent.workspace.addToInbox({ from: 'telegram:1', content: 'old', source: 'telegram', received_at: 1, status: 'archived' })
    const read = agent.workspace.addToInbox({ from: 'telegram:2', content: 'seen', source: 'telegram', received_at: 2, status: 'read' })
    const unread = agent.workspace.addToInbox({ from: 'telegram:3', content: 'new', source: 'telegram', received_at: 3, status: 'unread' })
    const pushes: Array<{ inbox: { messages: Array<{ id: string }> } }> = []
    manager.on('inbox_updated', (push) => pushes.push(push))
    agent.adapterManager!.emit('inbound', 'telegram', { sender: '3', payload: 'new' }, { inboxId: unread })
    expect(pushes[0].inbox.messages.map((m) => m.id)).toEqual([unread, read, archived])
  })
})
