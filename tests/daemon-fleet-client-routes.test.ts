// W3-D's path-addressed fleet and compute routes (routes/fleet-client-routes.ts):
// the bodies of Studio's AGENT_VITALS, AGENT_ACTIVITY, MESH_SET_AGENT_STATE,
// MESH_FOUND_AGENT and COMPUTE_STOP for the same daemon state. The compute
// service is a fake; no PodmanService is constructed.
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AdfWorkspace } from '../src/main/adf/adf-workspace'
import { createDaemonHttpApi, type DaemonHttpApiOptions } from '../src/main/daemon/http-api'
import { createDaemonVitalsDeps } from '../src/main/daemon/vitals-routes'
import { foundAgentFileName } from '../src/main/daemon/routes/fleet-client-routes'
import { MockLLMProvider, createHeadlessAgent } from '../src/main/runtime/headless'
import { RuntimeService } from '../src/main/runtime/runtime-service'
import { AgentVitalsService } from '../src/main/services/agent-vitals'

const cleanups: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => {
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

/** JSON form without the fields that move with the clock (`computedAt`, `ageDays`). */
function timeless(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (k, v) => (k === 'computedAt' || k === 'ageDays' ? undefined : v)))
}

function setup(opts: Partial<DaemonHttpApiOptions> = {}, settingsData: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'adf-daemon-fleet-client-'))
  const data: Record<string, unknown> = { trackedDirectories: [], maxDirectoryScanDepth: 0, ...settingsData }
  const settings = { get: (key: string) => data[key], set: (key: string, value: unknown) => { data[key] = value } }
  const runtime = new RuntimeService({ settings, enforceReviewGate: false, providerFactory: () => new MockLLMProvider() })
  const server = createDaemonHttpApi(runtime, { settingsStore: settings, ...opts })
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  cleanups.push(async () => { for (const a of runtime.listAgents()) await runtime.unloadAgent(a.id) })
  cleanups.push(() => server.close())
  return { dir, runtime, server, settings, data }
}

describe('GET /fleet/vitals, /fleet/activity', () => {
  it('read any .adf by path, also one that is neither loaded nor tracked (Studio\'s AGENT_VITALS)', async () => {
    const { dir, runtime, server, settings } = setup()
    const { filePath } = seedAgent(dir, 1)
    const reference = new AgentVitalsService(createDaemonVitalsDeps({ runtime, settings }))
    await reference.ensureFleetScan(30_000)
    const vitals = await server.inject({ method: 'GET', url: `/fleet/vitals?path=${encodeURIComponent(filePath)}&force=1` })
    expect(vitals.statusCode).toBe(200)
    expect(timeless(vitals.json())).toEqual(timeless(await reference.getAgentVitals(filePath, { force: true })))
    const activity = await server.inject({ method: 'GET', url: `/fleet/activity?path=${encodeURIComponent(filePath)}` })
    expect(timeless(activity.json())).toEqual(timeless(await reference.getAgentActivity(filePath, { force: true })))
    expect((await server.inject({ method: 'GET', url: '/fleet/vitals' })).statusCode).toBe(400)
    expect((await server.inject({ method: 'GET', url: `/fleet/vitals?path=${encodeURIComponent(filePath)}&force=maybe` })).statusCode).toBe(400)
  })
})

describe('POST /fleet/state', () => {
  it('sets a running agent idle or hibernate; offline and invalid states fail as in Studio', async () => {
    const { dir, runtime, server } = setup()
    const { filePath } = seedAgent(dir, 1)
    await runtime.loadAgent(filePath)
    const offline = join(dir, 'agent-2.adf')
    const res = await server.inject({ method: 'POST', url: '/fleet/state', payload: { filePaths: [filePath, offline], state: 'hibernate' } })
    expect(res.json()).toEqual({ updated: [filePath], failed: [{ filePath: offline, error: 'agent offline' }] })
    const setState = vi.spyOn(runtime, 'setAgentDisplayState')
    await server.inject({ method: 'POST', url: '/fleet/state', payload: { filePaths: [filePath], state: 'idle' } })
    expect(setState).toHaveBeenCalledWith(runtime.listAgents()[0].id, 'idle')
    const bad = await server.inject({ method: 'POST', url: '/fleet/state', payload: { filePaths: [filePath], state: 'active' } })
    expect(bad.json()).toEqual({ updated: [], failed: [{ filePath, error: 'invalid state' }] })
  })
})

describe('POST /fleet/found', () => {
  /** The agent factory's template service: makes the file with the typed name, as Studio's templatesService. */
  function deps(identityFails = false) {
    const made: Array<{ destPath: string; name: string }> = []
    const provisioned: string[] = []
    return {
      made,
      provisioned,
      opts: {
        agentFactory: {
          templatesService: () => ({
            instantiate: async (input: { destPath: string; name: string }) => {
              made.push(input)
              AdfWorkspace.create(input.destPath, { name: input.name }).close()
              return { success: true }
            },
          }),
        } as unknown as DaemonHttpApiOptions['agentFactory'],
        identity: {
          service: {
            ensureWorkspaceIdentity: (ws: { getFilePath?: () => string }) => {
              if (identityFails) throw new Error('owner identity is locked')
              provisioned.push(String(ws.getFilePath?.() ?? 'ws'))
            },
          },
        } as unknown as DaemonHttpApiOptions['identity'],
      },
    }
  }

  it('creates the folder and a closed agent (slugged file, typed name) inside a tracked folder only', async () => {
    const f = deps()
    const { dir, server, data } = setup(f.opts)
    data.trackedDirectories = [join(dir, 'fleet')]
    const target = join(dir, 'fleet', 'team-a')
    const res = await server.inject({ method: 'POST', url: '/fleet/found', payload: { dir: target, name: 'My Agent!' } })
    expect(res.json()).toEqual({ success: true, filePath: join(target, 'my-agent.adf') })
    expect(f.made).toEqual([{ destPath: join(target, 'my-agent.adf'), name: 'My Agent!' }])
    expect(f.provisioned).toHaveLength(1)
    expect(Object.keys(data.reviewedAgents as object)).toHaveLength(1)
    // Covered by the tracked root: not tracked again.
    expect(data.trackedDirectories).toEqual([join(dir, 'fleet')])

    const outside = await server.inject({ method: 'POST', url: '/fleet/found', payload: { dir: join(tmpdir(), 'elsewhere'), name: 'x' } })
    expect(outside.json()).toEqual({ success: false, error: 'Destination is outside tracked directories' })
    // A sibling of a tracked root, only as a new root; it is then tracked.
    const sibling = join(dir, 'other')
    expect((await server.inject({ method: 'POST', url: '/fleet/found', payload: { dir: sibling, name: 'x' } })).json().success).toBe(false)
    expect((await server.inject({ method: 'POST', url: '/fleet/found', payload: { dir: sibling, name: 'x', newRoot: true } })).json()).toEqual({ success: true, filePath: join(sibling, 'x.adf') })
    expect((data.trackedDirectories as string[]).length).toBe(2)
    expect((await server.inject({ method: 'POST', url: '/fleet/found', payload: { dir: target, name: '  ' } })).json()).toEqual({ success: false, error: 'Agent name required' })
    expect((await server.inject({ method: 'POST', url: '/fleet/found', payload: { dir: target, name: 'x' } })).json()).toEqual({ success: true, filePath: join(target, 'x.adf') })
    expect((await server.inject({ method: 'POST', url: '/fleet/found', payload: { dir: target, name: 'x' } })).json()).toEqual({ success: false, error: 'x.adf already exists here' })
  })

  it('refuses a relative folder before creating anything', async () => {
    const { dir, server, data } = setup(deps().opts)
    data.trackedDirectories = [dir]
    const res = await server.inject({ method: 'POST', url: '/fleet/found', payload: { dir: 'fleet/team-a', name: 'x' } })
    expect(res.json()).toEqual({ success: false, error: 'Destination must be an absolute folder path' })
    expect(existsSync(join(process.cwd(), 'fleet'))).toBe(false)
  })

  it('accepts a name longer than 64 characters, as Studio does', async () => {
    const { dir, server, data } = setup(deps().opts)
    data.trackedDirectories = [dir]
    const name = 'a'.repeat(80)
    expect((await server.inject({ method: 'POST', url: '/fleet/found', payload: { dir, name } })).json()).toEqual({ success: true, filePath: join(dir, `${name}.adf`) })
  })

  it('a locked owner identity is logged and the agent is still founded, as Studio does', async () => {
    const f = deps(true)
    const { dir, server, data } = setup(f.opts)
    data.trackedDirectories = [dir]
    const res = await server.inject({ method: 'POST', url: '/fleet/found', payload: { dir, name: 'agent-1' } })
    expect(res.json()).toEqual({ success: true, filePath: join(dir, 'agent-1.adf') })
    expect(existsSync(join(dir, 'agent-1.adf'))).toBe(true)
  })

  it('slugs names as Studio does', () => {
    expect(foundAgentFileName('My Agent!')).toBe('my-agent')
    expect(foundAgentFileName('___')).toBe('___')
    expect(foundAgentFileName('!!!')).toBe('agent')
  })
})

describe('compute', () => {
  function fakeCompute() {
    const calls: string[] = []
    return {
      calls,
      service: {
        getStatus: () => ({ status: 'stopped', containerName: 'adf-mcp', activeAgents: [] }),
        listContainers: async () => [],
        ensureRunning: async () => { calls.push('ensureRunning') },
        stop: async () => { calls.push('stop') },
        stopAll: async () => { calls.push('stopAll') },
        containerUsers: async (name: string) => (name === 'adf-mcp' ? ['daemon pid 4242'] : []),
      },
    }
  }

  it('POST /compute/shared/stop stops the shared container only', async () => {
    const c = fakeCompute()
    const { server } = setup({ computeService: c.service })
    expect((await server.inject({ method: 'POST', url: '/compute/shared/stop' })).json()).toEqual({ success: true })
    expect(c.calls).toEqual(['stop'])
  })

  it('GET /compute/users names the other runtimes per container, leaving out unused ones', async () => {
    const c = fakeCompute()
    const { server } = setup({ computeService: c.service })
    expect((await server.inject({ method: 'GET', url: '/compute/users?names=adf-agent-1-abc' })).json()).toEqual({ users: { 'adf-mcp': ['daemon pid 4242'] } })
  })

  it('both answer 503 without a compute service', async () => {
    const { server } = setup()
    expect((await server.inject({ method: 'POST', url: '/compute/shared/stop' })).statusCode).toBe(503)
    expect((await server.inject({ method: 'GET', url: '/compute/users' })).statusCode).toBe(503)
  })
})
