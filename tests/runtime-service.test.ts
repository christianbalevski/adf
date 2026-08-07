import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

vi.mock('electron', () => {
  const dir = join(tmpdir(), `adf-runtime-service-${process.pid}`)
  return {
    app: {
      getPath: (_name: string) => dir,
      on: () => {},
      getName: () => 'adf-runtime-service-test',
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

import { RuntimeReviewRequiredError, RuntimeService } from '../src/main/runtime/runtime-service'
import { RuntimeGate } from '../src/main/runtime/runtime-gate'
import { createHeadlessAgent, MockLLMProvider } from '../src/main/runtime/headless'
import type { CreateAgentOptions } from '../src/shared/types/adf-v02.types'
import { isConfigReviewed } from '../src/main/services/agent-review'
import type { Tool } from '../src/main/tools/tool.interface'

function createTempAgent(dir: string, name: string, createOptions?: Partial<CreateAgentOptions>) {
  const filePath = join(dir, `${name}.adf`)
  const agent = createHeadlessAgent({
    filePath,
    name,
    provider: new MockLLMProvider(),
    createOptions,
  })
  const agentId = agent.workspace.getAgentConfig().id
  agent.dispose()
  return { filePath, agentId }
}

describe('RuntimeService', () => {
  afterEach(() => {
    RuntimeGate._resetForTests()
  })

  it('delegates the compatibility fallback to the headlessLive profile', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-runtime-fallback-'))
    const filePath = join(dir, 'fallback.adf')
    const runtime = new RuntimeService({ enforceReviewGate: false })
    const ref = runtime.createAgent({
      filePath,
      name: 'fallback',
      provider: new MockLLMProvider(),
    })

    const managed = (runtime as unknown as {
      requireAgent(agentId: string): { agent: { profile: string } }
    }).requireAgent(ref.id)
    expect(managed.agent.profile).toBe('headlessLive')

    await runtime.unloadAgent(ref.id)
  })

  it('enforces reviewedAgents when loading an existing .adf file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-runtime-service-'))
    const filePath = join(dir, 'review-gated.adf')
    const created = createHeadlessAgent({
      filePath,
      name: 'review-gated',
      provider: new MockLLMProvider(),
    })
    const agentId = created.workspace.getAgentConfig().id
    created.dispose()

    const settings = {
      reviewedAgents: [] as string[],
      get(key: string): unknown {
        return key === 'reviewedAgents' ? this.reviewedAgents : undefined
      },
    }
    const runtime = new RuntimeService({
      settings,
      providerFactory: () => new MockLLMProvider(),
    })

    await expect(runtime.loadAgent(filePath)).rejects.toBeInstanceOf(RuntimeReviewRequiredError)

    settings.reviewedAgents = [agentId]
    const ref = await runtime.loadAgent(filePath)
    expect(ref.id).toBe(agentId)

    await runtime.unloadAgent(ref.id)
  })

  it('autostarts reviewed agents and reports skipped files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-runtime-autostart-'))
    const active = createTempAgent(dir, 'active-reviewed', { autostart: true })
    const hibernate = createTempAgent(dir, 'hibernate-reviewed', {
      autostart: true,
      start_in_state: 'hibernate',
    })
    const unreviewed = createTempAgent(dir, 'unreviewed', { autostart: true })
    const notAutostart = createTempAgent(dir, 'not-autostart', { autostart: false })

    const settings = {
      reviewedAgents: [active.agentId, hibernate.agentId],
      get(key: string): unknown {
        return key === 'reviewedAgents' ? this.reviewedAgents : undefined
      },
    }
    const providers = new Map<string, MockLLMProvider>()
    const runtime = new RuntimeService({
      settings,
      providerFactory: (_config, filePath) => {
        const provider = new MockLLMProvider({ tokensPerResponse: 120 })
        if (filePath) providers.set(filePath, provider)
        return provider
      },
    })

    const report = await runtime.autostartFromDirectories([dir], { maxDepth: 0 })

    expect(report.scanned).toBe(4)
    expect(report.failed).toEqual([])
    expect(report.started).toHaveLength(2)
    const activeStarted = report.started.find(s => s.agentId === active.agentId)
    const hibernateStarted = report.started.find(s => s.agentId === hibernate.agentId)
    expect(activeStarted?.startupTriggered).toBe(true)
    expect(hibernateStarted?.startupTriggered).toBe(false)

    expect(report.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({
        agentId: unreviewed.agentId,
        reason: 'unreviewed',
      }),
      expect.objectContaining({
        agentId: notAutostart.agentId,
        reason: 'not_autostart',
      }),
    ]))

    expect(providers.get(activeStarted!.filePath)?.getCallCount()).toBe(1)
    expect(providers.get(hibernateStarted!.filePath)?.getCallCount()).toBe(0)

    await Promise.all(runtime.listAgents().map(agent => runtime.unloadAgent(agent.id)))
  })

  it('can start an unloaded tracked agent by handle', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-runtime-start-tracked-'))
    const tracked = createTempAgent(dir, 'agent-1', { handle: 'agent-1', autostart: true })

    const settings = {
      get(key: string): unknown {
        if (key === 'reviewedAgents') return [tracked.agentId]
        if (key === 'trackedDirectories') return [dir]
        if (key === 'maxDirectoryScanDepth') return 0
        return undefined
      },
    }
    const providers = new Map<string, MockLLMProvider>()
    const runtime = new RuntimeService({
      settings,
      providerFactory: (_config, filePath) => {
        const provider = new MockLLMProvider({ tokensPerResponse: 120 })
        if (filePath) providers.set(filePath, provider)
        return provider
      },
    })

    const loaded = await runtime.loadAgent(tracked.filePath)
    await runtime.unloadAgent(loaded.id)
    expect(runtime.getAgent('agent-1')).toBeUndefined()

    const restarted = await runtime.startOrLoadAgent('agent-1')

    expect(restarted.loaded).toBe(true)
    expect(restarted.startupTriggered).toBe(true)
    expect(restarted.ref.id).toBe(tracked.agentId)
    expect(runtime.getAgent('agent-1')).toBeDefined()
    expect(Array.from(providers.values()).some(provider => provider.getCallCount() === 1)).toBe(true)

    await runtime.unloadAgent(tracked.agentId)
  })

  it('autostarts agents created by sys_create_adf without Studio background agents', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-runtime-create-child-'))
    const parentPath = join(dir, 'parent.adf')
    const reviewedState: Record<string, unknown> = { reviewedAgents: [] }
    const settings = {
      get(key: string): unknown {
        return reviewedState[key]
      },
      set(key: string, value: unknown): void {
        reviewedState[key] = value
      },
    }
    const childProvider = new MockLLMProvider({ tokensPerResponse: 120 })
    const runtime = new RuntimeService({
      settings,
      providerFactory: () => childProvider,
    })
    const parent = runtime.createAgent({
      filePath: parentPath,
      name: 'parent-agent',
      provider: new MockLLMProvider(),
      createOptions: {
        tools: [{ name: 'sys_create_adf', enabled: true, visible: true }],
      },
    })

    const managed = (runtime as unknown as {
      requireAgent(agentId: string): { agent: ReturnType<typeof createHeadlessAgent> }
    }).requireAgent(parent.id)
    const createAdfTool = managed.agent.registry.get('sys_create_adf') as Tool
    const result = await createAdfTool.execute({
      name: 'child-agent',
      autostart: true,
      start_in_state: 'active',
      instructions: 'Child agent instructions.',
    }, managed.agent.workspace)
    expect(result.isError).toBe(false)

    const child = runtime.getAgent('child-agent')
    expect(child).toBeDefined()
    expect(child?.filePath ? basename(child.filePath) : null).toBe('child-agent.adf')
    expect(childProvider.getCallCount()).toBe(1)
    expect(isConfigReviewed(reviewedState.reviewedAgents, child!.config)).toBe(true)

    await Promise.all(runtime.listAgents().map(agent => runtime.unloadAgent(agent.id)))
  })

  it('coalesces concurrent loadAgent calls for one file into a single instance', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-runtime-load-race-'))
    const agent = createTempAgent(dir, 'load-race', { start_in_state: 'hibernate' })
    const settings = {
      get: (key: string): unknown => (key === 'reviewedAgents' ? [agent.agentId] : undefined),
    }
    let providerBuilds = 0
    const runtime = new RuntimeService({
      settings,
      providerFactory: () => {
        providerBuilds++
        return new MockLLMProvider()
      },
    })

    const [first, second] = await Promise.all([
      runtime.loadAgent(agent.filePath),
      runtime.loadAgent(agent.filePath),
    ])

    expect(first.id).toBe(agent.agentId)
    expect(second.id).toBe(agent.agentId)
    // One provider build == one agent build; without the in-flight memo the
    // second caller would construct a second full instance.
    expect(providerBuilds).toBe(1)
    expect(runtime.listAgents()).toHaveLength(1)

    await runtime.unloadAgent(first.id)
  })

  it('disposes an agent whose load finishes during shutdown and keeps the gate closed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-runtime-shutdown-race-'))
    const agent = createTempAgent(dir, 'shutdown-race', { start_in_state: 'hibernate' })
    const settings = {
      get: (key: string): unknown => (key === 'reviewedAgents' ? [agent.agentId] : undefined),
    }
    let release!: () => void
    const providerGate = new Promise<void>(resolve => { release = resolve })
    const runtime = new RuntimeService({
      settings,
      providerFactory: async () => {
        await providerGate
        return new MockLLMProvider()
      },
    })

    // Load suspends inside the provider factory; shutdown begins teardown
    // synchronously and then awaits the in-flight load.
    const loadPromise = runtime.loadAgent(agent.filePath)
    const shutdownPromise = runtime.shutdownAll()
    release()

    await expect(loadPromise).rejects.toThrow(/teardown in progress/)
    await shutdownPromise

    expect(runtime.listAgents()).toEqual([])
    // The gate stays closed for good: resume() (autostart / user click) no-ops.
    expect(RuntimeGate.stopped).toBe(true)
    RuntimeGate.resume()
    expect(RuntimeGate.stopped).toBe(true)
  })

  it('emits agent-unloaded only after dispose has settled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-runtime-unload-order-'))
    const filePath = join(dir, 'unload-order.adf')
    const runtime = new RuntimeService({ enforceReviewGate: false })
    const ref = runtime.createAgent({
      filePath,
      name: 'unload-order',
      provider: new MockLLMProvider(),
    })

    const managed = (runtime as unknown as {
      requireAgent(agentId: string): { agent: { disposeAsync?: (opts?: { mode?: string }) => Promise<void> } }
    }).requireAgent(ref.id)
    let disposeSettled = false
    const originalDispose = managed.agent.disposeAsync!.bind(managed.agent)
    managed.agent.disposeAsync = async (opts) => {
      await new Promise(resolve => setTimeout(resolve, 20))
      await originalDispose(opts)
      disposeSettled = true
    }

    let disposeSettledAtEmit: boolean | null = null
    runtime.on('agent-unloaded', () => {
      disposeSettledAtEmit = disposeSettled
    })

    await runtime.unloadAgent(ref.id)
    expect(disposeSettledAtEmit).toBe(true)
  })
})
