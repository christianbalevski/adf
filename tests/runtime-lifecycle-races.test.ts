import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => process.env.ADF_USER_DATA_DIR!, on() {}, getName: () => 'lifecycle-races', getVersion: () => '0' },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: {}, ipcMain: {}, BrowserWindow: class {}, dialog: {},
}))

import { AdfWorkspace } from '../src/main/adf/adf-workspace'
import { RuntimeService, type RuntimeAgent } from '../src/main/runtime/runtime-service'
import { AgentLeaseRegistry } from '../src/main/runtime/agent-lease'
import { RuntimeGate } from '../src/main/runtime/runtime-gate'
import { createHeadlessAgent, MockLLMProvider } from '../src/main/runtime/headless'

const HOLDER = '00000000-0000-4000-8000-000000000001'
const runtimes: RuntimeService[] = []
const releases: Array<() => void> = []
const leaseRegistries: AgentLeaseRegistry[] = []

function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  releases.push(release)
  return { promise, release }
}

function seed(name: string) {
  const dir = mkdtempSync(join(process.env.ADF_USER_DATA_DIR!, 'lifecycle-races-'))
  const filePath = join(dir, `${name}.adf`)
  const agent = createHeadlessAgent({ filePath, name, provider: new MockLLMProvider(), createOptions: { start_in_state: 'hibernate' } })
  const id = agent.workspace.getAgentConfig().id
  agent.dispose()
  return { filePath, id }
}

function runtime() {
  const service = new RuntimeService({ agentLeases: null, enforceReviewGate: false, providerFactory: () => new MockLLMProvider() })
  runtimes.push(service)
  return service
}

afterEach(async () => {
  for (const release of releases.splice(0)) release()
  for (const service of runtimes.splice(0)) await service.shutdownAll({ agentTimeoutMs: 500 })
  for (const leases of leaseRegistries.splice(0)) await leases.close()
  vi.restoreAllMocks()
  RuntimeGate._resetForTests()
})

describe('concurrent document and runtime ownership', () => {
  it.each(['open', 'load'] as const)('shares and closes one workspace when %s starts first', async first => {
    const { filePath, id } = seed('shared')
    const service = runtime()
    const paused = gate()
    const entered = gate()
    if (first === 'open') {
      service.setDocumentOpenHooks({ leasedElsewhere: async () => { entered.release(); await paused.promise; return null } })
    } else {
      // Delaying provider construction exercises openDocument waiting for a load.
      const provider = vi.spyOn(service as unknown as { resolveProvider(): Promise<MockLLMProvider> }, 'resolveProvider')
      provider.mockImplementation(async () => { entered.release(); await paused.promise; return new MockLLMProvider() })
    }
    const openWorkspace = vi.spyOn(AdfWorkspace, 'open')
    const firstCall = first === 'open' ? service.openDocument(filePath, { holder: HOLDER }) : service.loadAgent(filePath)
    await entered.promise
    const secondCall = first === 'open' ? service.loadAgent(filePath) : service.openDocument(filePath, { holder: HOLDER })
    paused.release()
    await Promise.all([firstCall, secondCall])

    expect(openWorkspace).toHaveBeenCalledTimes(1)
    const workspace = service.getLoadedAgent(id)!.workspace
    await service.stopAgent(id)
    expect(service.getAgentWorkspace(id)!.workspace).toBe(workspace)
    expect(workspace.readDocument()).toEqual(expect.any(String))
    expect((await service.releaseDocument(id, HOLDER)).closed).toBe(true)
    expect(() => workspace.readDocument()).toThrow()
  })
})

describe('bounded runtime shutdown', () => {
  it.each([false, true])('unloads existing agents and disposes a late build (held document: %s)', async held => {
    const running = seed('running')
    const starting = seed('starting')
    const service = runtime()
    await service.loadAgent(running.filePath)
    const runningWorkspace = service.getLoadedAgent(running.id)!.workspace
    if (held) await service.openDocument(starting.filePath, { holder: HOLDER })

    const paused = gate()
    const entered = gate()
    const builder = service as unknown as { buildLoadedAgent(...args: unknown[]): Promise<RuntimeAgent> }
    const build = builder.buildLoadedAgent.bind(service)
    let lateWorkspace: AdfWorkspace | undefined
    vi.spyOn(builder, 'buildLoadedAgent').mockImplementation(async (...args) => {
      const agent = await build(...args)
      lateWorkspace = agent.workspace
      entered.release()
      await paused.promise
      return agent
    })
    const loading = service.loadAgent(starting.filePath)
    const rejectedLoad = expect(loading).rejects.toThrow(/teardown in progress/)
    await entered.promise

    // A pending build must not exhaust the shutdown budget before already-running
    // agents get a stop. The late build remains paused even after shutdown returns.
    await service.shutdownAll({ mode: 'immediate', agentTimeoutMs: 25 })
    expect(service.listAgents()).toEqual([])
    expect(() => runningWorkspace.readDocument()).toThrow()
    await expect(service.loadAgent(running.filePath)).rejects.toMatchObject({ statusCode: 503 })
    await expect(service.openDocument(running.filePath, { holder: HOLDER })).rejects.toMatchObject({ statusCode: 503 })

    paused.release()
    await rejectedLoad
    expect(() => lateWorkspace!.readDocument()).toThrow()
    expect(service.listOpenDocuments()).toEqual([])
    expect(service.listAgents()).toEqual([])
  })

  it('closes a held document when its pending lease acquisition finishes after shutdown', async () => {
    const { filePath, id } = seed('pending-lease')
    const leases = new AgentLeaseRegistry({ dir: join(process.env.ADF_USER_DATA_DIR!, 'pending-lease-registry') })
    leaseRegistries.push(leases)
    const service = new RuntimeService({ agentLeases: leases, enforceReviewGate: false, providerFactory: () => new MockLLMProvider() })
    runtimes.push(service)
    const paused = gate()
    const entered = gate()
    const acquire = leases.acquire.bind(leases)
    vi.spyOn(leases, 'acquire').mockImplementation(async (...args) => {
      entered.release()
      await paused.promise
      return acquire(...args)
    })
    await service.openDocument(filePath, { holder: HOLDER })
    const workspace = service.getAgentWorkspace(id)!.workspace
    const loading = service.loadAgent(filePath)
    const rejectedLoad = expect(loading).rejects.toMatchObject({ statusCode: 503 })
    await entered.promise
    await service.shutdownAll({ agentTimeoutMs: 25 })
    paused.release()
    await rejectedLoad
    expect(service.listOpenDocuments()).toEqual([])
    expect(() => workspace.readDocument()).toThrow()
  })

  it('bounds a pending document open and prevents it from opening a workspace afterward', async () => {
    const { filePath } = seed('pending-open')
    const service = runtime()
    const paused = gate()
    const entered = gate()
    service.setDocumentOpenHooks({ leasedElsewhere: async () => { entered.release(); await paused.promise; return null } })
    const openWorkspace = vi.spyOn(AdfWorkspace, 'open')
    const opening = service.openDocument(filePath, { holder: HOLDER })
    const rejectedOpen = expect(opening).rejects.toMatchObject({ statusCode: 503 })
    await entered.promise

    await service.shutdownAll({ agentTimeoutMs: 25 })
    paused.release()
    await rejectedOpen
    expect(openWorkspace).not.toHaveBeenCalled()
    expect(service.listOpenDocuments()).toEqual([])
  })
})
