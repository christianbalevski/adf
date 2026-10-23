// Fleet-map routes (W1-D). Shape parity with Studio's MESH_* / ADAPTER_* /
// EMERGENCY_STOP handlers: each route returns what the shared body
// (services/mesh-status.ts, agent-vitals, fleet-burn, adapter-status,
// recent-tools, peer-fetch) returns for the same daemon state. The compute
// service is a fake; no PodmanService is constructed.
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AdfWorkspace } from '../src/main/adf/adf-workspace'
import { createDaemonHttpApi, type DaemonHttpApiOptions } from '../src/main/daemon/http-api'
import { createDaemonVitalsDeps } from '../src/main/daemon/vitals-routes'
import { MockLLMProvider, createHeadlessAgent } from '../src/main/runtime/headless'
import { RuntimeGate } from '../src/main/runtime/runtime-gate'
import { AgentLeaseRegistry, processAgentLeases } from '../src/main/runtime/agent-lease'
import { RuntimeService } from '../src/main/runtime/runtime-service'
import { AgentVitalsService } from '../src/main/services/agent-vitals'
import { getFleetBurnService } from '../src/main/services/fleet-burn.service'
import { buildMeshStatus } from '../src/main/services/mesh-status'
import { readRecentToolsFromWorkspace } from '../src/main/services/recent-tools'
import { CodeSandboxService } from '../src/main/runtime/code-sandbox'
import { MeshServer } from '../src/main/services/mesh-server'
import { UvManager } from '../src/main/services/uv-manager'
import { daemonGapRouteDeps } from '../src/main/daemon/routes/gap-deps'
import type { FleetMessageResult, MeshAgentStatus } from '../src/shared/types/ipc.types'

const cleanups: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => {
  vi.unstubAllGlobals()
  RuntimeGate._resetForTests()
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

function seedAgent(dir: string, n: number): { filePath: string; agentId: string } {
  const handle = `agent-${n}`
  const filePath = join(dir, `${handle}.adf`)
  const seeded = createHeadlessAgent({ filePath, name: handle, provider: new MockLLMProvider(), createOptions: { handle } })
  const agentId = randomUUID()
  seeded.workspace.setAgentConfig({ ...seeded.workspace.getAgentConfig(), id: agentId })
  seeded.dispose()
  return { filePath, agentId }
}

function fakeMesh(statuses: MeshAgentStatus[]) {
  return {
    enabled: true,
    isEnabled() { return this.enabled },
    getAgentStatuses: () => statuses,
    getDebugInfo: () => ({ running: true, busRegistrations: [{ name: 'agent-1', channels: ['main'] }], backgroundAgents: [], foregroundAgents: [], messageLog: [{ seq: 4 }, { seq: 9 }] }),
    disableMesh() { this.enabled = false },
  }
}

function setup(opts: Partial<DaemonHttpApiOptions> = {}, settingsData: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'adf-daemon-fleet-'))
  const data: Record<string, unknown> = { trackedDirectories: [], maxDirectoryScanDepth: 0, ...settingsData }
  const settings = { get: (key: string) => data[key], set: (key: string, value: unknown) => { data[key] = value } }
  const runtime = new RuntimeService({ settings, enforceReviewGate: false, providerFactory: () => new MockLLMProvider() })
  const server = createDaemonHttpApi(runtime, { settingsStore: settings, ...opts })
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  cleanups.push(async () => { for (const a of runtime.listAgents()) await runtime.unloadAgent(a.id) })
  cleanups.push(() => server.close())
  return { dir, runtime, server, settings, data }
}

describe('mesh status and fleet routes', () => {
  it('GET /fleet/mesh returns buildMeshStatus over the daemon mesh, with the log cursor', async () => {
    const mesh = fakeMesh([{ filePath: '/x/agent-1.adf', handle: 'agent-1', state: 'idle' } as unknown as MeshAgentStatus])
    const { runtime, server, settings } = setup({ mesh })
    const deps = createDaemonVitalsDeps({ runtime, settings, mesh })
    const src = { isRunning: () => mesh.isEnabled(), liveAgents: () => deps.getLiveMeshAgents(), debugInfo: () => mesh.getDebugInfo() }

    expect((await server.inject({ method: 'GET', url: '/fleet/mesh' })).json()).toEqual(await buildMeshStatus(src))
    const debug = await server.inject({ method: 'GET', url: '/fleet/mesh?debug=1&sinceSeq=4' })
    expect(debug.json()).toEqual(JSON.parse(JSON.stringify(await buildMeshStatus(src, { debug: true, sinceSeq: 4 }))))
    expect(debug.json()).toMatchObject({ logSeq: 9, logIncremental: true, messageLog: [{ seq: 9 }] })
    expect((await server.inject({ method: 'GET', url: '/fleet/mesh?sinceSeq=-1' })).statusCode).toBe(400)

    mesh.enabled = false
    expect((await server.inject({ method: 'GET', url: '/fleet/mesh?debug=true' })).json()).toEqual({
      running: false, agents: [], busRegistrations: [], backgroundAgents: [], foregroundAgents: [], messageLog: [],
    })
  })

  it('GET /fleet/status matches AgentVitalsService.getFleetStatus; /fleet/burn and hydrate use the shared burn service', async () => {
    const { dir, runtime, server, settings, data } = setup()
    data.trackedDirectories = [dir]
    const { filePath } = seedAgent(dir, 1)
    await runtime.loadAgent(filePath)
    const reference = await new AgentVitalsService(createDaemonVitalsDeps({ runtime, settings })).getFleetStatus()
    const res = await server.inject({ method: 'GET', url: '/fleet/status' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(JSON.parse(JSON.stringify(reference)))

    const key = join(dir, 'agent-9.adf')
    const hydrate = await server.inject({ method: 'POST', url: '/fleet/burn/hydrate', payload: { burnTotals: { [key]: 1234 } } })
    expect(hydrate.json()).toEqual({ success: true })
    const burn = await server.inject({ method: 'GET', url: '/fleet/burn' })
    expect(burn.json()).toEqual(JSON.parse(JSON.stringify(getFleetBurnService().getBurn())))
    expect(burn.json().perAgent[key].totalTokens).toBe(1234)
    expect((await server.inject({ method: 'POST', url: '/fleet/burn/hydrate', payload: { burnTotals: [1] } })).statusCode).toBe(400)
  })

  it('GET /fleet/map aggregates the slices in one call', async () => {
    const mesh = fakeMesh([])
    const { server } = setup({ mesh, networkService: { getStatus: () => ({}), getDiscoveredRuntimes: () => [{ runtime_id: 'peer-1' }] } })
    const res = await server.inject({ method: 'GET', url: '/fleet/map?sinceSeq=0' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Object.keys(body).sort()).toEqual(['adapters', 'burn', 'debug', 'fleet', 'peers'])
    expect(body.debug).toMatchObject({ running: true, logSeq: 9, logIncremental: true })
    expect(body.fleet).toHaveProperty('agents')
    expect(body.adapters).toEqual({ adapters: [], perAgent: [] })
    expect(body.peers).toEqual([{ runtime_id: 'peer-1' }])
  })

  it('GET /fleet/recent-tools adds loaded agents the mesh does not track, read from their workspaces', async () => {
    const { dir, runtime, server } = setup({ networkService: { getStatus: () => ({}), getRecentTools: () => ({ '/mesh/agent-7.adf': [{ name: 'msg_send', timestamp: 1 }] }) } })
    const { filePath } = seedAgent(dir, 1)
    await runtime.loadAgent(filePath)
    const ws = runtime.listLiveAgents()[0].workspace
    ws.appendToLoop('assistant', [{ type: 'tool_use', id: 't1', name: 'fs_read', input: { path: 'a.txt' } }])
    const res = await server.inject({ method: 'GET', url: '/fleet/recent-tools' })
    const live = runtime.listLiveAgents()[0]
    expect(res.json()).toEqual({
      '/mesh/agent-7.adf': [{ name: 'msg_send', timestamp: 1 }],
      [live.filePath]: JSON.parse(JSON.stringify(readRecentToolsFromWorkspace(live.workspace, 5))),
    })
    expect(res.json()[live.filePath][0].name).toBe('fs_read')
  })
})

describe('POST /fleet/message', () => {
  it('delivers to running agents, starts reviewed ones, writes into the loop of refused ones', async () => {
    const { dir, runtime, server } = setup()
    const running = seedAgent(dir, 1)
    const refused = seedAgent(dir, 2) // unreviewed: the review-gated start refuses it
    await runtime.loadAgent(running.filePath)
    const trigger = vi.spyOn(runtime, 'trigger').mockResolvedValue(undefined)
    const missing = join(dir, 'agent-3.adf')

    const res = await server.inject({ method: 'POST', url: '/fleet/message', payload: { filePaths: [running.filePath, refused.filePath, missing], content: 'hello team' } })
    expect(res.json()).toEqual({ delivered: [running.filePath, refused.filePath], failed: [{ filePath: missing, error: 'file not found' }] })
    expect(trigger).toHaveBeenCalledTimes(1)
    const dispatch = trigger.mock.calls[0][1] as { event: { type: string; source: string; data: { message: { content_json: unknown } } } }
    expect(dispatch.event).toMatchObject({ type: 'chat', source: 'system', data: { message: { content_json: [{ type: 'text', text: 'hello team' }] } } })
    expect(runtime.listAgents()).toHaveLength(1)

    const ws = AdfWorkspace.open(refused.filePath)
    try {
      const last = ws.getLoop().at(-1)!
      expect(last.role).toBe('user')
      expect(last.content_json).toEqual([{ type: 'text', text: 'hello team' }])
    } finally {
      ws.close()
    }

    const empty = await server.inject({ method: 'POST', url: '/fleet/message', payload: { filePaths: [running.filePath], content: '  ' } })
    expect(empty.json()).toEqual({ delivered: [], failed: [{ filePath: running.filePath, error: 'empty message' }] })
  })

  it('fails, writing nothing, for an agent another runtime runs (reviewed or not)', async () => {
    const { dir, runtime, server } = setup()
    const reviewed = seedAgent(dir, 1)
    const unreviewed = seedAgent(dir, 2)
    runtime.acceptReview(reviewed.filePath)
    const loopLength = (filePath: string) => {
      const ws = AdfWorkspace.open(filePath)
      try { return ws.getLoop().length } finally { ws.close() }
    }
    const before = [loopLength(reviewed.filePath), loopLength(unreviewed.filePath)]
    const other = new AgentLeaseRegistry({ dir: processAgentLeases().dir, kind: 'studio-embedded', settingsPath: join(dir, 'other-settings.json') })
    cleanups.push(() => other.close())
    expect((await other.acquire(reviewed.filePath, { agentId: reviewed.agentId })).ok).toBe(true)
    expect((await other.acquire(unreviewed.filePath, { agentId: unreviewed.agentId })).ok).toBe(true)
    const trigger = vi.spyOn(runtime, 'trigger').mockResolvedValue(undefined)

    const res = await server.inject({ method: 'POST', url: '/fleet/message', payload: { filePaths: [reviewed.filePath, unreviewed.filePath], content: 'hello' } })
    const body = res.json() as FleetMessageResult
    expect(body.delivered).toEqual([])
    expect(body.failed.map((f) => f.filePath)).toEqual([reviewed.filePath, unreviewed.filePath])
    expect(body.failed[0].error).toMatch(/agent-1 is already running in another ADF Studio/)
    expect(body.failed[1].error).toMatch(/agent-2 is already running in another ADF Studio/)
    expect(trigger).not.toHaveBeenCalled()
    expect(runtime.listAgents()).toEqual([])
    expect([loopLength(reviewed.filePath), loopLength(unreviewed.filePath)]).toEqual(before)
  })

  it('reopens the emergency-stop gate for a summons', async () => {
    const { dir, runtime, server } = setup()
    const agent = seedAgent(dir, 1)
    runtime.acceptReview(agent.filePath)
    vi.spyOn(runtime, 'trigger').mockResolvedValue(undefined)
    RuntimeGate.stop()
    const res = await server.inject({ method: 'POST', url: '/fleet/message', payload: { filePaths: [agent.filePath], content: 'wake up' } })
    expect(res.json()).toEqual({ delivered: [agent.filePath], failed: [] })
    expect(RuntimeGate.stopped).toBe(false)
    expect(runtime.listAgents()).toHaveLength(1)
  })
})

describe('adapter routes', () => {
  it('GET /fleet/adapters is empty without adapters; restart answers as Studio does', async () => {
    const { dir, runtime, server } = setup()
    const agent = seedAgent(dir, 1)
    await runtime.loadAgent(agent.filePath)
    expect((await server.inject({ method: 'GET', url: '/fleet/adapters' })).json()).toEqual({ adapters: [], perAgent: [] })
    const notRunning = await server.inject({ method: 'POST', url: '/fleet/adapters/restart', payload: { type: 'telegram', filePath: join(dir, 'agent-9.adf') } })
    expect(notRunning.json()).toEqual({ success: false, error: 'That agent is not running, so its channel has nothing to restart. Start the agent instead.' })
    const noPath = await server.inject({ method: 'POST', url: '/fleet/adapters/restart', payload: { type: 'telegram' } })
    expect(noPath.json()).toEqual({ success: false, error: 'No agent is open, so there is no channel to restart.' })
    expect((await server.inject({ method: 'POST', url: '/fleet/adapters/restart', payload: {} })).statusCode).toBe(400)
  })
})

describe('peer reads', () => {
  it('health and shared file go through the guarded peer fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { server } = setup()
    const lan = encodeURIComponent('http://192.168.1.20:7295/agent-1')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok', state: 'active' }), { status: 200 }))
    expect((await server.inject({ method: 'GET', url: `/network/peers/health?url=${encodeURIComponent('http://192.168.1.20:7295/agent-1/health')}` })).json()).toEqual({ ok: true, status: 'ok', state: 'active' })
    expect((await server.inject({ method: 'GET', url: '/network/peers/health?url=file%3A%2F%2Fx' })).json()).toEqual({ ok: false, error: 'Bad health URL' })
    fetchMock.mockResolvedValueOnce(new Response('# hi', { status: 200, headers: { 'content-type': 'text/markdown' } }))
    expect((await server.inject({ method: 'GET', url: `/network/peers/shared-file?baseUrl=${lan}&path=README.md` })).json())
      .toEqual({ ok: true, mime: 'text/markdown', size: 4, binary: false, content: '# hi' })
    expect((await server.inject({ method: 'GET', url: `/network/peers/shared-file?baseUrl=${lan}&path=..%2Fx` })).json()).toEqual({ ok: false, error: 'Bad file path' })
    // The metadata address is refused before any request.
    fetchMock.mockClear()
    expect((await server.inject({ method: 'GET', url: `/network/peers/health?url=${encodeURIComponent('http://169.254.169.254/health')}` })).json().ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('POST /runtime/emergency-stop', () => {
  it('closes the gate, disables the mesh, unloads every agent, stops WS, sandbox, mesh server and compute', async () => {
    const mesh = fakeMesh([])
    const compute = {
      getStatus: () => ({ status: 'running' }) as never,
      listContainers: async () => [],
      ensureRunning: async () => {},
      stop: async () => {},
      pendingStarts: vi.fn(async () => {}),
      stopAll: vi.fn(async () => {}),
    }
    const ws = { getConnections: () => [], stopAll: vi.fn() }
    const sandbox = { destroyAll: vi.fn() }
    const meshServer = { stop: vi.fn(async () => {}) }
    const { dir, runtime, server } = setup({ mesh, computeService: compute, wsService: ws, routes: { gaps: { codeSandboxService: sandbox as never, meshServer } } })
    await runtime.loadAgent(seedAgent(dir, 1).filePath)
    await runtime.loadAgent(seedAgent(dir, 2).filePath)

    const res = await server.inject({ method: 'POST', url: '/runtime/emergency-stop' })
    expect(res.json()).toEqual({ success: true, stoppedAgents: 2 })
    expect(RuntimeGate.stopped).toBe(true)
    expect(RuntimeGate.tearingDown).toBe(false) // resumable
    expect(mesh.isEnabled()).toBe(false)
    expect(runtime.listAgents()).toEqual([])
    expect(ws.stopAll).toHaveBeenCalled()
    expect(meshServer.stop).toHaveBeenCalled()
    expect(sandbox.destroyAll).toHaveBeenCalled()
    expect(compute.pendingStarts).toHaveBeenCalled()
    expect(compute.stopAll).toHaveBeenCalled()
  })
})

describe('POST /runtime/emergency-stop: partial stops and the daemon wiring', () => {
  const compute = () => ({
    getStatus: () => ({ status: 'running' }) as never,
    listContainers: async () => [],
    ensureRunning: async () => {},
    stop: async () => {},
    pendingStarts: vi.fn(async () => {}),
    stopAll: vi.fn(async () => {}),
  })

  it('answers success: false naming what it could not stop', async () => {
    const { server } = setup({ mesh: fakeMesh([]), computeService: compute() })
    const res = await server.inject({ method: 'POST', url: '/runtime/emergency-stop' })
    expect(res.json()).toMatchObject({ success: false, skipped: ['mesh server', 'sandbox workers'] })
    expect(res.json().error).toMatch(/partial/)
    expect(RuntimeGate.stopped).toBe(true)
  })

  it('a failing part is reported as failed', async () => {
    const meshServer = { stop: vi.fn(async () => { throw new Error('port stuck') }) }
    const { server } = setup({ mesh: fakeMesh([]), computeService: compute(), routes: { gaps: { codeSandboxService: { destroyAll: () => {} } as never, meshServer } } })
    expect((await server.inject({ method: 'POST', url: '/runtime/emergency-stop' })).json()).toMatchObject({ success: false, failed: ['mesh server'] })
  })

  it('with the gap deps daemon/index.ts builds (real sandbox, mesh server, uv) the stop is complete', async () => {
    const sandbox = new CodeSandboxService()
    const destroyAll = vi.spyOn(sandbox, 'destroyAll')
    const meshServer = new MeshServer(sandbox, { get: () => undefined } as never)
    const stop = vi.spyOn(meshServer, 'stop')
    const gaps = daemonGapRouteDeps({ codeSandboxService: sandbox, meshServer, uvManager: new UvManager() })
    const { dir, runtime, server } = setup({ mesh: fakeMesh([]), computeService: compute(), routes: { gaps } })
    await runtime.loadAgent(seedAgent(dir, 1).filePath)
    expect((await server.inject({ method: 'POST', url: '/runtime/emergency-stop' })).json()).toEqual({ success: true, stoppedAgents: 1 })
    expect(destroyAll).toHaveBeenCalled()
    expect(stop).toHaveBeenCalled()
    expect(runtime.listAgents()).toEqual([])
  })

  it('daemon/index.ts passes those deps as routes.gaps', () => {
    const source = readFileSync(join(__dirname, '../src/main/daemon/index.ts'), 'utf-8')
    expect(source).toMatch(/routes: \{ startedBy, gaps: daemonGapRouteDeps\(\{ codeSandboxService, meshServer, uvManager, mcpAppOAuthStore: ownerIdentity\.mcpOAuth \}\)(, [\w, ]+)? \}/)
  })
})

describe('POST /runtime/emergency-stop: nothing starts while it runs', () => {
  // Held open on the mesh server stop, after the agents are unloaded.
  function heldKill() {
    let finish: (() => void) | null = null
    const meshServer = { stop: vi.fn(() => new Promise<void>((resolve) => { finish = resolve })) }
    const gaps = { codeSandboxService: { destroyAll: () => {} } as never, meshServer }
    // A failed assertion before finish() must not leave the request (and server.close) hanging.
    cleanups.push(() => finish?.())
    return {
      gaps,
      finish: () => finish?.(),
      stopping: () => vi.waitFor(() => expect(meshServer.stop).toHaveBeenCalled(), { timeout: 5_000 }),
    }
  }

  it('a start or load mid-Kill (the click that re-attached an agent) is refused, and the gate stays closed', async () => {
    const kill = heldKill()
    const { dir, runtime, server } = setup({ routes: { gaps: kill.gaps } })
    const agent = seedAgent(dir, 1)
    await runtime.loadAgent(agent.filePath)
    const killed = server.inject({ method: 'POST', url: '/runtime/emergency-stop' })
    await kill.stopping()
    expect(RuntimeGate.killing).toBe(true)

    const start = await server.inject({ method: 'POST', url: `/agents/${encodeURIComponent(agent.filePath)}/start` })
    expect(start.statusCode).toBe(409)
    expect(start.json()).toMatchObject({ code: 'kill_in_progress' })
    const load = await server.inject({ method: 'POST', url: '/agents/load', payload: { filePath: agent.filePath } })
    expect(load.statusCode).toBe(409)
    expect(RuntimeGate.stopped).toBe(true)

    kill.finish()
    expect((await killed).json()).toEqual({ success: true, stoppedAgents: 1 })
    expect(runtime.listAgents()).toEqual([])
    expect(RuntimeGate.killing).toBe(false)
    expect(RuntimeGate.stopped).toBe(true)
  })

  it('an agent whose load was in flight when the Kill began is unloaded too', async () => {
    const kill = heldKill()
    const { dir, runtime, server } = setup({ routes: { gaps: kill.gaps } })
    // Either it registers before the first pass (and is unloaded) or the Kill refuses its registration.
    const loading = runtime.loadAgent(seedAgent(dir, 1).filePath).then(() => 'loaded', (err) => err.code)
    const killed = server.inject({ method: 'POST', url: '/runtime/emergency-stop' })
    await kill.stopping()
    kill.finish()
    expect((await killed).json()).toMatchObject({ success: true })
    expect(['loaded', 'kill_in_progress']).toContain(await loading)
    expect(runtime.listAgents()).toEqual([])
  })

  it('an agent already loaded cannot be started mid-Kill', async () => {
    const { dir, runtime } = setup()
    const { id } = await runtime.loadAgent(seedAgent(dir, 1).filePath)
    const release = RuntimeGate.beginKill()
    try {
      await expect(runtime.startAgent(id)).rejects.toMatchObject({ statusCode: 409, code: 'kill_in_progress' })
    } finally {
      release()
    }
    expect(RuntimeGate.stopped).toBe(true)
  })

  // A start that awaited (a provider check) while a whole Kill ran is not carried out after it.
  it('a start whose Kill came and went during its own awaits is refused and leaves nothing loaded', async () => {
    const { dir, runtime } = setup()
    const agent = seedAgent(dir, 1)
    const killEpoch = RuntimeGate.killEpoch
    RuntimeGate.beginKill()()
    await expect(runtime.startOrLoadAgent(agent.filePath, { killEpoch })).rejects.toMatchObject({ code: 'kill_in_progress' })
    expect(runtime.listAgents()).toEqual([])
    expect(RuntimeGate.stopped).toBe(true)
  })

  it('an autostart a Kill interrupts starts nothing after the Kill', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-daemon-fleet-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const agent = seedAgent(dir, 1)
    const ws = AdfWorkspace.open(agent.filePath)
    ws.setAgentConfig({ ...ws.getAgentConfig(), autostart: true })
    ws.close()
    const { runtime } = setup({}, { reviewedAgents: [agent.agentId] })
    const autostart = runtime.autostartFromDirectories([dir], { maxDepth: 0 })
    // The Kill runs (and ends) while the autostart scans the folder.
    RuntimeGate.beginKill()()
    const report = await autostart
    expect(report.started).toEqual([])
    expect(report.failed).toEqual([expect.objectContaining({ name: 'agent-1', error: expect.stringContaining('Kill') })])
    expect(runtime.listAgents()).toEqual([])
    expect(RuntimeGate.stopped).toBe(true)
  })

  it('after the Kill, a deliberate start reopens the gate', async () => {
    const kill = heldKill()
    const { dir, runtime, server } = setup({ routes: { gaps: kill.gaps } })
    const killed = server.inject({ method: 'POST', url: '/runtime/emergency-stop' })
    await kill.stopping()
    kill.finish()
    await killed
    const res = await server.inject({ method: 'POST', url: `/agents/${encodeURIComponent(seedAgent(dir, 1).filePath)}/start` })
    expect(res.statusCode).toBe(200)
    expect(RuntimeGate.stopped).toBe(false)
    expect(runtime.listAgents()).toHaveLength(1)
  })
})

describe('POST /agents/load after an emergency stop', () => {
  it('reopens the runtime gate, so the loaded agent runs turns', async () => {
    const { dir, runtime, server } = setup({ routes: { gaps: { codeSandboxService: { destroyAll: () => {} } as never, meshServer: { stop: async () => {} } } } })
    await server.inject({ method: 'POST', url: '/runtime/emergency-stop' })
    expect(RuntimeGate.stopped).toBe(true)
    const agent = seedAgent(dir, 1)
    const res = await server.inject({ method: 'POST', url: '/agents/load', payload: { filePath: agent.filePath } })
    expect(res.statusCode).toBe(200)
    expect(RuntimeGate.stopped).toBe(false)
    await runtime.sendChat(res.json().id, 'hello')
    const chat = runtime.getAgentChat(res.json().id)
    expect(chat.chatHistory?.uiLog.length ?? 0).toBeGreaterThan(1)
  })
})

describe('RuntimeService review identity summary', () => {
  it('derives the identity object from the workspace for both review and accept', () => {
    const ownerDid = 'did:key:owner-1'
    const { dir, runtime } = setup({}, { ownerDid })
    const agent = seedAgent(dir, 1)
    const workspace = AdfWorkspace.open(agent.filePath)
    let agentDid: string | null
    try {
      agentDid = workspace.getDid()
      workspace.setMeta('adf_owner_did', ownerDid)
    } finally { workspace.close() }
    const expected = { agentDid, fileOwnerDid: ownerDid, ownerIsYou: true, scenario: 'mine', needsClaim: false, sharePasswordSet: false, credentialsLocked: false, filePasswordProtected: false, seedUnavailable: false }
    expect(runtime.getReviewInfo(agent.filePath).summary.identity).toEqual(expected)
    const accepted = runtime.acceptReview(agent.filePath)
    expect(accepted.reviewed).toBe(true)
    expect(accepted.summary.identity).toEqual(expected)
  })
})
