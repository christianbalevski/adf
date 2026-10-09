import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  const dir = join(tmpdir(), `adf-daemon-vitals-api-${process.pid}`)
  return {
    app: {
      getPath: () => dir,
      on: () => {},
      getName: () => 'adf-daemon-vitals-api-test',
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

import { createDaemonHttpApi } from '../src/main/daemon/http-api'
import { createDaemonVitalsDeps } from '../src/main/daemon/vitals-routes'
import { overlayLiveStates } from '../src/main/services/agent-vitals'
import { RuntimeService } from '../src/main/runtime/runtime-service'
import { MockLLMProvider, createHeadlessAgent } from '../src/main/runtime/headless'
import type { AgentActivity, AgentVitals } from '../src/shared/types/agent-vitals.types'
import type { MeshAgentStatus } from '../src/shared/types/ipc.types'

const cleanups: Array<() => Promise<unknown> | unknown> = []

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

/** A real .adf on disk: handle `agent-N`, UUID id, created an hour ago (so later writes count as the agent's). */
function seedAgent(dir: string, n: number, opts: { parentId?: string } = {}): { filePath: string; agentId: string } {
  const handle = `agent-${n}`
  const filePath = join(dir, `${handle}.adf`)
  const seeded = createHeadlessAgent({
    filePath,
    name: handle,
    provider: new MockLLMProvider(),
    createOptions: { handle },
  })
  const agentId = randomUUID()
  seeded.workspace.setAgentConfig({ ...seeded.workspace.getAgentConfig(), id: agentId })
  seeded.workspace.setMeta('adf_created_at', new Date(Date.now() - 3_600_000).toISOString())
  if (opts.parentId) seeded.workspace.setMeta('adf_parent_did', opts.parentId)
  seeded.dispose()
  return { filePath, agentId }
}

function setup(opts: { tracked?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'adf-daemon-vitals-'))
  const settingsData: Record<string, unknown> = { trackedDirectories: opts.tracked ? [dir] : [], maxDirectoryScanDepth: 0 }
  const settings = { get: (key: string) => settingsData[key] }
  const runtime = new RuntimeService({ enforceReviewGate: false, providerFactory: () => new MockLLMProvider() })
  const server = createDaemonHttpApi(runtime, { settingsStore: settings })
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  // Not shutdownAll: it latches the process-wide teardown gate for later tests.
  cleanups.push(async () => { for (const a of runtime.listAgents()) await runtime.unloadAgent(a.id) })
  cleanups.push(() => server.close())
  return { dir, runtime, server }
}

describe('GET /agents/:id/vitals', () => {
  it('reads a loaded agent out of its open workspace', async () => {
    const { dir, runtime, server } = setup()
    const { filePath, agentId } = seedAgent(dir, 1)
    await runtime.loadAgent(filePath)

    const res = await server.inject({ method: 'GET', url: '/agents/agent-1/vitals' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as AgentVitals
    expect(body).toEqual(expect.objectContaining({ live: true, handle: 'agent-1', agentId }))
    expect(body.ageDays).toBeGreaterThan(0)
    for (const stat of [body.stats.reach, body.stats.access, body.stats.autonomy]) {
      expect(stat.points).toBeCloseTo(stat.gated + stat.open)
      expect(stat.level).toBeGreaterThanOrEqual(1)
      expect(stat.progress).toBeGreaterThanOrEqual(0)
      expect(stat.progress).toBeLessThan(1)
    }
    expect(body.stats.experience.level).toBeGreaterThanOrEqual(1)

    // Same agent by id. A write lands on the next forced read.
    const live = runtime.listLiveAgents().find(a => a.agentId === agentId)!
    live.workspace.writeFile('notes/today.md', 'hello')
    const forced = (await server.inject({ method: 'GET', url: `/agents/${agentId}/vitals?force=1` })).json() as AgentVitals
    expect(forced.maturity.filesWritten).toBe(body.maturity.filesWritten + 1)
    expect(forced.computedAt).toBeGreaterThanOrEqual(body.computedAt)
  })

  it('reads a tracked agent that is not loaded from its file and counts its children', async () => {
    const { dir, server } = setup({ tracked: true })
    const parent = seedAgent(dir, 1)
    seedAgent(dir, 2, { parentId: parent.agentId })

    const byId = await server.inject({ method: 'GET', url: `/agents/${parent.agentId}/vitals` })
    expect(byId.statusCode).toBe(200)
    expect(byId.json()).toEqual(expect.objectContaining({
      live: false,
      handle: 'agent-1',
      agentId: parent.agentId,
      maturity: expect.objectContaining({ agentsSpawned: 1 }),
    }))

    const byHandle = await server.inject({ method: 'GET', url: '/agents/agent-2/vitals' })
    expect(byHandle.statusCode).toBe(200)
    expect(byHandle.json()).toEqual(expect.objectContaining({ live: false, handle: 'agent-2', maturity: expect.objectContaining({ agentsSpawned: 0 }) }))
  })

  it('answers 404, 409 and 400 like the other agent routes', async () => {
    const { runtime, server } = setup({ tracked: true })
    const memory = runtime.createAgent({ name: 'agent-3', provider: new MockLLMProvider() })

    const unknown = await server.inject({ method: 'GET', url: '/agents/agent-9/vitals' })
    expect(unknown.statusCode).toBe(404)
    expect(unknown.json()).toEqual({ error: 'Unknown agent "agent-9"', code: 'not_found' })

    const noFile = await server.inject({ method: 'GET', url: `/agents/${memory.id}/vitals` })
    expect(noFile.statusCode).toBe(409)
    expect(noFile.json().code).toBe('conflict')

    const badForce = await server.inject({ method: 'GET', url: `/agents/${memory.id}/vitals?force=yes` })
    expect(badForce.statusCode).toBe(400)
    expect(badForce.json().code).toBe('bad_request')
  })
})

describe('GET /agents/:id/activity', () => {
  it('reads a loaded agent: 14 local days, wakes, recent events and what it knows', async () => {
    const { dir, runtime, server } = setup()
    const { filePath, agentId } = seedAgent(dir, 1)
    await runtime.loadAgent(filePath)
    const live = runtime.listLiveAgents().find(a => a.agentId === agentId)!
    live.workspace.writeFile('notes/today.md', 'hello')
    live.workspace.addTimer({ mode: 'interval', every_ms: 600_000 }, Date.now() + 600_000, 'Check the inbox', ['agent'])

    const res = await server.inject({ method: 'GET', url: '/agents/agent-1/activity' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as AgentActivity
    expect(body.live).toBe(true)
    expect(body.daily).toHaveLength(14)
    expect(body.upcoming).toEqual([expect.objectContaining({ scope: 'agent', label: 'Check the inbox' })])
    expect(body.knowledge.files.map(f => f.path)).toContain('notes/today.md')
    expect(body.recent).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'file', label: 'notes/today.md' })]))

    // A write lands on the next forced read, by agent id.
    live.workspace.writeFile('notes/later.md', 'more')
    const forced = (await server.inject({ method: 'GET', url: `/agents/${agentId}/activity?force=1` })).json() as AgentActivity
    expect(forced.knowledge.filesTotal).toBe(body.knowledge.filesTotal + 1)
  })

  it('reads a tracked agent that is not loaded from its file', async () => {
    const { dir, server } = setup({ tracked: true })
    seedAgent(dir, 2)
    const res = await server.inject({ method: 'GET', url: '/agents/agent-2/activity' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(expect.objectContaining({ live: false, dailyPartial: false, upcoming: [] }))
  })

  it('answers 404, 409 and 400 like vitals', async () => {
    const { runtime, server } = setup({ tracked: true })
    const memory = runtime.createAgent({ name: 'agent-3', provider: new MockLLMProvider() })
    expect((await server.inject({ method: 'GET', url: '/agents/agent-9/activity' })).statusCode).toBe(404)
    const noFile = await server.inject({ method: 'GET', url: `/agents/${memory.id}/activity` })
    expect(noFile.statusCode).toBe(409)
    expect(noFile.json()).toEqual({ error: 'Agent has no .adf file; activity is read from the file.', code: 'conflict' })
    expect((await server.inject({ method: 'GET', url: `/agents/${memory.id}/activity?force=yes` })).statusCode).toBe(400)
  })
})

describe('createDaemonVitalsDeps', () => {
  it('overlays executor display states on mesh rows and reports the mesh state', () => {
    const filePath = join(tmpdir(), 'agent-1.adf')
    const row = { filePath, handle: 'agent-1', state: 'idle' } as MeshAgentStatus
    let enabled = true
    const deps = createDaemonVitalsDeps({
      runtime: {
        getAgent: () => undefined,
        scanAdfFiles: () => [],
        listLiveAgents: () => [{
          agentId: randomUUID(),
          filePath,
          executorState: 'thinking',
          workspace: {} as never,
          getContextGauge: () => ({ tokens: 1200, threshold: 100_000 }),
        }],
      },
      mesh: { isEnabled: () => enabled, getAgentStatuses: () => [row] },
      ws: { getConnections: () => [{}, {}] },
    })
    expect(deps.isMeshRunning()).toBe(true)
    expect(deps.getLiveMeshAgents()).toEqual([{ ...row, state: 'active' }])
    expect(deps.getLiveExecStates()).toEqual([{ filePath, state: 'active' }])
    expect(deps.getContextGauge(filePath)).toEqual({ tokens: 1200, threshold: 100_000 })
    expect(deps.getWsConnectionCount(filePath)).toBe(2)
    expect(deps.getTrackedDirectories()).toEqual([])
    expect(deps.getMaxScanDepth()).toBe(5)
    enabled = false
    expect(deps.isMeshRunning()).toBe(false)
    expect(deps.getLiveMeshAgents()).toEqual([])
  })

  it('overlayLiveStates: later entries win the state, activeLoops keeps the last defined count', () => {
    const row = { filePath: 'a.adf', handle: 'agent-1', state: 'idle' } as MeshAgentStatus
    expect(overlayLiveStates([row], [
      { filePath: 'a.adf', state: 'idle', activeLoops: 2 },
      { filePath: 'a.adf', state: 'active' },
    ])).toEqual([{ ...row, state: 'active', activeLoops: 2 }])
    expect(overlayLiveStates([row], [])).toEqual([row])
  })
})
