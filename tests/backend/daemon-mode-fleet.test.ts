/**
 * W3-D daemon-mode handlers (mesh, fleet map, overview, token usage,
 * dashboard, compute, firewall, emergency stop) against a scripted daemon:
 * the embedded handlers' result shapes, the routes they call, and the
 * coalescing of the polled reads.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('./daemon-mode-electron')).electronStub.module)

import { electronStub } from './daemon-mode-electron'
import { createFakeClientSession, createFakeDaemon } from './daemon-mode-fakes'
import { IPC } from '../../src/shared/constants/ipc-channels'
import { registerDaemonModeHandlers, type DaemonModeHandle } from '../../src/main/backend/daemon-mode'
import { PollCoalescer } from '../../src/main/backend/daemon-mode/handlers/poll'
import { REMOTE_FIREWALL_SENTENCE } from '../../src/main/backend/daemon-mode/handlers/mesh'
import { REMOTE_BROWSER_SENTENCE } from '../../src/main/backend/daemon-mode/handlers/compute'

const BASE = 'http://127.0.0.1:47386'
const TOKEN = 'b'.repeat(43)
const AGENT = '5f1d7a3e-2c4b-4e8a-9b6d-0a1b2c3d4e01'

let dir: string
let handle: DaemonModeHandle
const daemon = createFakeDaemon(BASE)
const log = { log: () => {}, warn: () => {}, error: () => {} }
const invoke = (channel: string, ...args: unknown[]) => Promise.resolve(electronStub.handlers.get(channel)!({}, ...args))
const requests = (method: string, path: string) => daemon.requests.filter((r) => r.method === method && r.path === path)

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'adf-daemon-mode-fleet-'))
  daemon.routes.set('GET /agents', () => [])
  daemon.routes.set('GET /approvals', () => ({ pending: [], history: [] }))
  handle = registerDaemonModeHandlers({
    mode: 'local',
    userDataDir: dir,
    connect: async () => ({ baseUrl: BASE, logFile: null, description: 'the fake daemon', source: { token: () => TOKEN } }),
    leases: { registerClient: async () => {} },
    fetch: daemon.fetch,
    createSession: () => createFakeClientSession(),
    log,
  })
  expect(await handle.ready).toBe(true)
})

afterAll(async () => {
  await handle.shutdown()
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  daemon.requests.length = 0
})

describe('PollCoalescer', () => {
  it('shares an in-flight read, serves a fresh answer, reloads after FRESH_MS or an invalidation', async () => {
    let now = 0
    const polls = new PollCoalescer(1000, () => now)
    let loads = 0
    let release!: () => void
    const load = () => { loads++; return new Promise<number>((r) => { release = () => r(loads) }) }
    const a = polls.get('k', load)
    const b = polls.get('k', load)
    release()
    expect(await a).toBe(1)
    expect(await b).toBe(1)
    now = 999
    expect(await polls.get('k', async () => { loads++; return loads })).toBe(1)
    now = 1000
    expect(await polls.get('k', async () => { loads++; return loads })).toBe(2)
    polls.invalidate()
    expect(await polls.get('k', async () => { loads++; return loads })).toBe(3)
  })

  it('never serves a failed read again', async () => {
    const polls = new PollCoalescer(1000, () => 0)
    await expect(polls.get('k', async () => { throw new Error('down') })).rejects.toThrow('down')
    expect(await polls.get('k', async () => 7)).toBe(7)
  })
})

describe('fleet map (W1-D routes)', () => {
  it('MESH_MAP_POLL hands the saved burn totals over once, then polls one batched route, coalesced', async () => {
    handle.clientSettings.set('fleetMapState', { burnTotals: { [join(dir, 'agent-1.adf')]: 1200 } })
    daemon.routes.set('POST /fleet/burn/hydrate', () => ({ success: true }))
    const map = { debug: null, fleet: { running: false, agents: [] }, burn: null, adapters: { adapters: [], perAgent: [] }, peers: [] }
    daemon.routes.set('GET /fleet/map', () => map)
    daemon.routes.set('GET /fleet/burn', () => ({ agents: [] }))
    const [a, b] = await Promise.all([invoke(IPC.MESH_MAP_POLL, { sinceSeq: 4 }), invoke(IPC.MESH_MAP_POLL, { sinceSeq: 4 })])
    expect(a).toEqual(map)
    expect(b).toEqual(map)
    expect(requests('POST', '/fleet/burn/hydrate').map((r) => r.body)).toEqual([{ burnTotals: { [join(dir, 'agent-1.adf')]: 1200 } }])
    expect(requests('GET', '/fleet/map').map((r) => r.query)).toEqual([{ sinceSeq: '4' }])
    // A settled answer is not reused: the next poll asks again (embedded has no cache).
    await invoke(IPC.MESH_MAP_POLL, { sinceSeq: 4 })
    await invoke(IPC.MESH_TOKEN_BURN)
    expect(requests('GET', '/fleet/map')).toHaveLength(2)
    expect(requests('POST', '/fleet/burn/hydrate')).toHaveLength(1)
  })

  it('a poll right after a start or stop shows it (no reuse of a settled answer)', async () => {
    let state = 'off'
    daemon.routes.set('GET /fleet/status', () => ({ running: true, agents: [{ filePath: join(dir, 'agent-5.adf'), state, online: state !== 'off', participating: false }] }))
    expect(((await invoke(IPC.MESH_FLEET_STATUS)) as { agents: Array<{ state: string }> }).agents[0].state).toBe('off')
    // Started from the fleet command bar (BACKGROUND_AGENT_START, not a W3-D write).
    state = 'idle'
    expect(((await invoke(IPC.MESH_FLEET_STATUS)) as { agents: Array<{ state: string }> }).agents[0].state).toBe('idle')
    state = 'off'
    expect(((await invoke(IPC.MESH_FLEET_STATUS)) as { agents: Array<{ state: string }> }).agents[0].state).toBe('off')
  })

  it('fleet and mesh rows get the Studio foreground/background split (D3): background state and inner-loop count from the bridge', async () => {
    const A1 = '5f1d7a3e-2c4b-4e8a-9b6d-0a1b2c3d4e11'
    const A2 = '5f1d7a3e-2c4b-4e8a-9b6d-0a1b2c3d4e12'
    const f1 = join(dir, 'fg-agent-1.adf')
    const f2 = join(dir, 'fg-agent-2.adf')
    handle.bridge.seed([{ id: A1, filePath: f1, handle: 'agent-1', runtimeState: 'idle' as never }, { id: A2, filePath: f2, handle: 'agent-2', runtimeState: 'idle' as never }])
    handle.bridge.handleFrame({ kind: 'host', type: 'agent_state_changed', agentId: A1, filePath: f1, payload: { state: 'hibernate' }, timestamp: 1 } as never)
    daemon.routes.set('GET /files/agent', ({ query }) => ({ filePath: query.path, agentId: query.path === f2 ? A2 : A1, loaded: true, tracked: true }))
    daemon.routes.set(`GET /agents/${A2}/status`, () => ({ id: A2, filePath: f2, name: 'agent-2', autostart: false, runtimeState: 'idle', targetState: null, loopCount: 0 }))
    daemon.routes.set(`GET /agents/${A2}/identity/password`, () => ({ agentId: A2, needsPassword: false, unlocked: false }))
    await invoke(IPC.FILE_OPEN, { filePath: f2 })
    const row = (filePath: string, state: string) => ({ filePath, handle: 'x', state, canReceive: true, participating: true })
    daemon.routes.set('GET /fleet/status', () => ({ running: true, agents: [row(f1, 'idle'), row(f2, 'idle'), { filePath: join(dir, 'agent-3.adf'), state: 'off', online: false, participating: false }] }))
    expect(await invoke(IPC.MESH_FLEET_STATUS)).toEqual({ running: true, agents: [
      { ...row(f1, 'hibernate'), activeLoops: 0 },
      row(f2, 'idle'),
      { filePath: join(dir, 'agent-3.adf'), state: 'off', online: false, participating: false },
    ] })
    daemon.routes.set('GET /fleet/mesh', () => ({
      running: true, agents: [row(f1, 'idle')],
      backgroundAgents: [{ filePath: f1, name: 'fg-agent-1', state: 'idle', onMessageReceived: true, hasMessaging: true, toolCount: 3 }, { filePath: f2, name: 'fg-agent-2', state: 'idle', onMessageReceived: true, hasMessaging: true, toolCount: 3 }],
      foregroundAgents: [],
    }))
    const debug = await invoke(IPC.MESH_STATUS, { debug: true }) as Record<string, unknown>
    expect(debug.backgroundAgents).toEqual([{ filePath: f1, name: 'fg-agent-1', state: 'idle', onMessageReceived: true, hasMessaging: true, toolCount: 3 }])
    expect(debug.foregroundAgents).toEqual([{ filePath: f2, name: 'fg-agent-2', onMessageReceived: true, hasMessaging: true }])
    await invoke(IPC.FILE_CLOSE)
  })

  it('MESH_STATUS, MESH_FLEET_STATUS, MESH_GET_RECENT_TOOLS read the fleet routes', async () => {
    daemon.routes.set('GET /fleet/mesh', ({ query }) => ({ running: true, agents: [], q: query }))
    daemon.routes.set('GET /fleet/status', () => ({ running: true, agents: [{ filePath: 'x', state: 'idle' }] }))
    daemon.routes.set('GET /fleet/recent-tools', () => ({ x: [] }))
    expect(await invoke(IPC.MESH_STATUS, { debug: true, sinceSeq: 2 })).toEqual({ running: true, agents: [], q: { debug: '1', sinceSeq: '2' } })
    expect(await invoke(IPC.MESH_FLEET_STATUS)).toEqual({ running: true, agents: [{ filePath: 'x', state: 'idle' }] })
    expect(await invoke(IPC.MESH_GET_RECENT_TOOLS)).toEqual({ x: [] })
  })

  it('AGENT_VITALS and AGENT_ACTIVITY address the file by path', async () => {
    daemon.routes.set('GET /fleet/vitals', ({ query }) => ({ path: query.path, force: query.force ?? null }))
    daemon.routes.set('GET /fleet/activity', ({ query }) => ({ path: query.path }))
    expect(await invoke(IPC.AGENT_VITALS, { filePath: 'C:\\a\\agent-1.adf', force: true })).toEqual({ path: 'C:\\a\\agent-1.adf', force: '1' })
    expect(await invoke(IPC.AGENT_ACTIVITY, { filePath: 'C:\\a\\agent-1.adf' })).toEqual({ path: 'C:\\a\\agent-1.adf' })
  })

  it('MESH_ENABLE / MESH_DISABLE answer only success, or String(error) as embedded', async () => {
    daemon.routes.set('POST /network/mesh/enable', () => ({ success: true, meshEnabled: true, agents: [] }))
    expect(await invoke(IPC.MESH_ENABLE)).toEqual({ success: true })
    daemon.routes.set('POST /network/mesh/disable', () => ({ status: 500, body: { error: 'boom' } }))
    expect(await invoke(IPC.MESH_DISABLE)).toEqual({ success: false, error: 'Error: boom' })
  })
})

describe('mesh server and peers', () => {
  it('MESH_SERVER_START of a running server answers without starting it (the daemon persists a start)', async () => {
    daemon.routes.set('GET /network/server', () => ({ running: true, port: 7295, host: '0.0.0.0' }))
    expect(await invoke(IPC.MESH_SERVER_START)).toEqual({ success: true, running: true, port: 7295, host: '0.0.0.0' })
    expect(requests('POST', '/network/server/start')).toHaveLength(0)
    daemon.routes.set('GET /network/server', () => ({ running: false, port: 7295, host: '127.0.0.1' }))
    daemon.routes.set('POST /network/server/start', () => ({ success: false, running: false, port: 7295, host: '127.0.0.1' }))
    expect(await invoke(IPC.MESH_SERVER_START)).toEqual({ success: false, running: false, port: 7295, host: '127.0.0.1', error: 'Failed to start server' })
    expect(requests('POST', '/network/server/start').map((r) => r.query)).toEqual([{ persist: '0' }])
  })

  it('MESH_SERVER_STOP and _RESTART answer the embedded shape; no mesh server reads as embedded with none', async () => {
    daemon.routes.set('POST /network/server/stop', () => ({ success: true, running: false, port: 7295, host: '127.0.0.1' }))
    expect(await invoke(IPC.MESH_SERVER_STOP)).toEqual({ success: true, running: false, port: 7295, host: '127.0.0.1' })
    // Studio's start/stop leave meshServerEnabled alone, as embedded (the CLI's persist).
    expect(requests('POST', '/network/server/stop').map((r) => r.query)).toEqual([{ persist: '0' }])
    daemon.routes.set('POST /network/server/restart', () => ({ success: true, running: true, port: 7295, host: '127.0.0.1' }))
    expect(await invoke(IPC.MESH_SERVER_RESTART)).toEqual({ success: true, running: true, port: 7295, host: '127.0.0.1' })
    daemon.routes.set('GET /network/server', () => ({ status: 503, body: { error: 'Network service is not configured.', code: 'unavailable' } }))
    daemon.routes.set('POST /network/server/restart', () => ({ status: 503, body: { error: 'Network service is not configured.' } }))
    expect(await invoke(IPC.MESH_SERVER_STATUS)).toEqual({ running: false, port: 7295, host: '127.0.0.1' })
    expect(await invoke(IPC.MESH_SERVER_START)).toEqual({ success: false, error: 'No mesh server' })
    expect(await invoke(IPC.MESH_SERVER_RESTART)).toEqual({ success: false, error: 'No mesh server' })
  })

  it('MESH_SERVER_LAN_IPS and MESH_DISCOVERED_RUNTIMES unwrap the route answers', async () => {
    const lan = { hostname: 'host-1', addresses: [{ iface: 'eth0', address: '192.168.1.5', family: 'IPv4', mac: '00' }] }
    daemon.routes.set('GET /network/mesh/lan-addresses', () => ({ addresses: lan }))
    expect(await invoke(IPC.MESH_SERVER_LAN_IPS)).toEqual(lan)
    daemon.routes.set('GET /network/mesh/discovered-runtimes', ({ query }) => ({ runtimes: [{ url: 'http://peer', force: query.force ?? null }] }))
    expect(await invoke(IPC.MESH_DISCOVERED_RUNTIMES, { force: true })).toEqual([{ url: 'http://peer', force: '1' }])
  })
})

describe('emergency stop', () => {
  it('a full stop answers { success: true }', async () => {
    daemon.routes.set('POST /runtime/emergency-stop', () => ({ success: true }))
    electronStub.calls.length = 0
    expect(await invoke(IPC.EMERGENCY_STOP)).toEqual({ success: true })
    expect(electronStub.calls.filter((c) => c.api === 'dialog.showMessageBox')).toHaveLength(0)
  })

  it('a partial stop answers { success: false, skipped } and is shown once', async () => {
    const partial = { success: false, error: 'Emergency stop was partial — not wired on this daemon, left running: mesh server.', skipped: ['mesh server'] }
    daemon.routes.set('POST /runtime/emergency-stop', () => partial)
    electronStub.calls.length = 0
    expect(await invoke(IPC.EMERGENCY_STOP)).toEqual(partial)
    const shown = electronStub.calls.find((c) => c.api === 'dialog.showMessageBox')?.args[0] as { message: string; detail: string }
    expect(shown.message).toBe('Emergency stop was partial.')
    expect(shown.detail).toBe('Left running (not wired on this daemon): mesh server.\n\nAgents may still be running.')
  })

  const OPEN = '5f1d7a3e-2c4b-4e8a-9b6d-0a1b2c3d4e21'
  async function openRunning(): Promise<string> {
    const filePath = join(dir, 'estop-agent-1.adf')
    daemon.routes.set('GET /files/agent', () => ({ filePath, agentId: OPEN, loaded: true, tracked: false }))
    daemon.routes.set(`GET /agents/${OPEN}/status`, () => ({ id: OPEN, filePath, name: 'agent-1', autostart: false, runtimeState: 'idle', targetState: null, loopCount: 0 }))
    daemon.routes.set(`GET /agents/${OPEN}/identity/password`, () => ({ agentId: OPEN, needsPassword: false, unlocked: false }))
    await invoke(IPC.FILE_OPEN, { filePath })
    return filePath
  }

  it('a stop that does not reach the daemon is shown as an error and rejects; the open agent stays attached', async () => {
    await openRunning()
    daemon.routes.set('POST /runtime/emergency-stop', () => { throw new Error('connect ECONNREFUSED') })
    electronStub.calls.length = 0
    electronStub.pushes.length = 0
    await expect(invoke(IPC.EMERGENCY_STOP)).rejects.toThrow('Cannot reach daemon')
    const shown = electronStub.calls.find((c) => c.api === 'dialog.showMessageBox')?.args[0] as { type: string; message: string; detail: string }
    expect(shown).toMatchObject({ type: 'error', message: 'Emergency stop did not reach the ADF daemon.' })
    expect(shown.detail).toContain('Agents may still be running.')
    handle.bridge.handleFrame({ kind: 'executor', agentId: OPEN, filePath: join(dir, 'estop-agent-1.adf'), event: { type: 'state_changed', payload: { state: 'thinking' }, timestamp: 1 } } as never)
    expect(electronStub.pushes.filter((p) => p.channel === IPC.AGENT_EVENT)).toHaveLength(1)
    await invoke(IPC.FILE_CLOSE)
  })

  it('a partial stop that left the open agent running shows it again with its current state', async () => {
    await openRunning()
    daemon.routes.set('POST /runtime/emergency-stop', () => ({ success: false, error: 'Emergency stop was partial — failed: agent x.', failed: [`agent ${OPEN}`] }))
    electronStub.pushes.length = 0
    await invoke(IPC.EMERGENCY_STOP)
    expect(electronStub.pushes.filter((p) => p.channel === IPC.AGENT_EVENT).map((p) => p.args[0])).toEqual([
      { type: 'state_changed', payload: { state: 'idle' }, timestamp: expect.any(Number) },
    ])
    await invoke(IPC.FILE_CLOSE)
  })
})

describe('compute', () => {
  it('COMPUTE_LIST_CONTAINERS adds the other runtimes that use a container (W1-G)', async () => {
    daemon.routes.set('GET /compute/containers', () => ({ containers: [{ name: 'adf-mcp', running: true }, { name: 'adf-agent-1-x', running: false }] }))
    daemon.routes.set('GET /compute/users', ({ query }) => ({ users: query.names.includes('adf-mcp') ? { 'adf-mcp': ['daemon pid 4242'] } : {} }))
    expect(await invoke(IPC.COMPUTE_LIST_CONTAINERS)).toEqual({
      containers: [{ name: 'adf-mcp', running: true, users: ['daemon pid 4242'] }, { name: 'adf-agent-1-x', running: false }],
    })
  })

  it('COMPUTE_STOP stops the shared container only; actions answer { success: false, error } on a daemon error', async () => {
    daemon.routes.set('POST /compute/shared/stop', () => ({ success: true }))
    expect(await invoke(IPC.COMPUTE_STOP)).toEqual({ success: true })
    expect(requests('POST', '/compute/stop')).toHaveLength(0)
    daemon.routes.set('POST /compute/containers/adf-x/stop', () => ({ status: 500, body: { error: 'not a managed container' } }))
    expect(await invoke(IPC.COMPUTE_STOP_CONTAINER, { name: 'adf-x' })).toEqual({ success: false, error: 'not a managed container' })
    daemon.routes.set('POST /compute/start', () => ({ status: 200, body: { status: 'running' } }))
    expect(await invoke(IPC.COMPUTE_INIT)).toEqual({ success: true })
  })

  it('DASHBOARD_CONTAINERS counts running containers and flags a missing Podman', async () => {
    daemon.routes.set('GET /compute/containers', () => ({ containers: [{ name: 'a', running: true }, { name: 'b', running: false }] }))
    daemon.routes.set('GET /compute/status', () => ({ status: 200, body: { status: 'not_installed', containerName: 'adf-mcp', activeAgents: [] } }))
    expect(await invoke(IPC.DASHBOARD_CONTAINERS)).toEqual({ total: 2, running: 1, unavailable: true })
  })
})

describe('token usage and context', () => {
  it('TOKEN_USAGE_GET answers the raw usage record; TOKEN_USAGE_CLEAR success', async () => {
    daemon.routes.set('GET /runtime/usage', () => ({ source: 'token-usage-service', totals: {}, usage: { '2026-10-14': { openai: {} } } }))
    expect(await invoke(IPC.TOKEN_USAGE_GET)).toEqual({ '2026-10-14': { openai: {} } })
    daemon.routes.set('DELETE /runtime/usage', () => ({ success: true }))
    expect(await invoke(IPC.TOKEN_USAGE_CLEAR)).toEqual({ success: true })
  })

  it('TOKEN_COUNT defaults each of provider and model to the open agent, as embedded', async () => {
    daemon.routes.set('GET /files/agent', () => ({ filePath: join(dir, 'agent-1.adf'), agentId: AGENT, loaded: true, tracked: false }))
    daemon.routes.set(`GET /agents/${AGENT}/status`, () => ({ id: AGENT, filePath: join(dir, 'agent-1.adf'), name: 'agent-1', autostart: false, runtimeState: 'idle', targetState: null, loopCount: 0 }))
    daemon.routes.set(`GET /agents/${AGENT}/identity/password`, () => ({ agentId: AGENT, needsPassword: false, unlocked: false }))
    daemon.routes.set(`GET /agents/${AGENT}/config`, () => ({ config: { model: { provider: 'parity-llm', model_id: 'mock-1' } } }))
    daemon.routes.set('POST /runtime/token-count', ({ body }) => ({ count: 3, ...(body as object) }))
    await invoke(IPC.FILE_OPEN, { filePath: join(dir, 'agent-1.adf') })
    expect(await invoke(IPC.TOKEN_COUNT, { text: 'abc', model: 'other' })).toEqual({ count: 3 })
    expect(requests('POST', '/runtime/token-count')[0].body).toEqual({ text: 'abc', provider: 'parity-llm', model: 'other' })

    daemon.routes.set(`GET /agents/${AGENT}/context`, ({ query }) => (query.loop === 'side' ? { status: 404, body: { error: 'Unknown loop' } } : { breakdown: { systemPrompt: 10 } }))
    expect(await invoke(IPC.CONTEXT_BREAKDOWN_GET, { filePath: join(dir, 'agent-1.adf') })).toEqual({ systemPrompt: 10 })
    expect(await invoke(IPC.CONTEXT_BREAKDOWN_GET, { filePath: join(dir, 'agent-1.adf'), loop: 'side' })).toBeNull()
    await invoke(IPC.FILE_CLOSE)
    daemon.routes.set('GET /files/agent', () => ({ filePath: join(dir, 'agent-2.adf'), agentId: null, loaded: false, tracked: false }))
    expect(await invoke(IPC.CONTEXT_BREAKDOWN_GET, { filePath: join(dir, 'agent-2.adf') })).toBeNull()
  })
})

describe('compute phase pushes', () => {
  it('a compute_phase push reaches COMPUTE_CONTAINER_PHASE with the payload embedded forwards (PodmanService container-phase)', () => {
    const phase = { containerName: 'adf-agent-1-5f1d7a3e', phase: 'provisioning', detail: 'Creating container', agentId: AGENT, timestamp: 1 }
    electronStub.pushes.length = 0
    handle.bridge.handleFrame({ kind: 'push', topic: 'compute_phase', agentId: AGENT, payload: phase })
    handle.bridge.handleFrame({ kind: 'push', topic: 'compute_phase', agentId: AGENT, payload: { ...phase, phase: 'ready', detail: undefined } })
    expect(electronStub.pushes.filter((p) => p.channel === IPC.COMPUTE_CONTAINER_PHASE).map((p) => p.args)).toEqual([[phase], [{ ...phase, phase: 'ready', detail: undefined }]])
  })
})

describe('remote mode', () => {
  const remoteHandlers = new Map<string, (...args: unknown[]) => unknown>()
  let remote: DaemonModeHandle
  beforeAll(async () => {
    remote = registerDaemonModeHandlers({
      mode: 'remote',
      userDataDir: dir,
      connect: async () => ({ baseUrl: BASE, logFile: null, description: 'the fake remote daemon', source: { token: () => TOKEN } }),
      leases: { registerClient: async () => {} },
      fetch: daemon.fetch,
      createSession: () => createFakeClientSession(),
      ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => { remoteHandlers.set(channel, fn) }, on: () => {} } as never,
      log,
    })
    expect(await remote.ready).toBe(true)
  })
  afterAll(async () => { await remote.shutdown() })

  it('the LAN firewall is the laptop\'s: check and apply answer with the sentence', async () => {
    daemon.routes.set('GET /network/server', () => ({ running: true, port: 7295, host: '0.0.0.0' }))
    expect(await remoteHandlers.get(IPC.MESH_FIREWALL_CHECK)!({})).toMatchObject({ supported: false, detail: REMOTE_FIREWALL_SENTENCE, port: 7295, serverLanBound: true, verified: false })
    expect(await remoteHandlers.get(IPC.MESH_FIREWALL_APPLY)!({})).toEqual({ success: false, error: REMOTE_FIREWALL_SENTENCE })
  })

  it('the browser viewer gets no port and says why', async () => {
    daemon.routes.set('GET /compute/browser-info', () => ({ containerName: 'adf-agent-1', hostPort: 6080, phase: 'ready' }))
    expect(await remoteHandlers.get(IPC.COMPUTE_BROWSER_INFO)!({}, { agentName: 'agent-1', agentId: AGENT })).toEqual({
      containerName: 'adf-agent-1', hostPort: null, phase: 'ready', detail: REMOTE_BROWSER_SENTENCE,
    })
  })
})
