// The daemon's mesh and mesh-server switches (daemon/mesh-controls.ts) and
// the persist option of /network/server/start|stop (W3-D review fixes):
// mesh off closes the WebSocket connections, as Studio's MESH_DISABLE does;
// Studio's server start/stop (persist=0) leave meshServerEnabled alone.
import { afterEach, describe, expect, it } from 'vitest'
import { createMeshControls, createMeshServerBinder } from '../src/main/daemon/mesh-controls'
import { createDaemonHttpApi } from '../src/main/daemon/http-api'
import { RuntimeService } from '../src/main/runtime/runtime-service'
import { MockLLMProvider } from '../src/main/runtime/headless'

function fakes() {
  const calls: string[] = []
  const data: Record<string, unknown> = {}
  let enabled = true
  let running = true
  const controls = createMeshControls({
    settings: { set: (key, value) => { data[key] = value; calls.push(`set ${key}=${String(value)}`) } },
    mesh: {
      isEnabled: () => enabled,
      enableMesh: () => { enabled = true; calls.push('mesh.enable') },
      disableMesh: () => { enabled = false; calls.push('mesh.disable') },
      getAgentStatuses: () => [],
    },
    server: {
      isRunning: () => running,
      getPort: () => 7295,
      getHost: () => '127.0.0.1',
      start: async () => { running = true; calls.push('server.start') },
      stop: async () => { running = false; calls.push('server.stop') },
    },
    ws: { stopAll: () => { calls.push('ws.stopAll') } },
    registerLoaded: () => { calls.push('registerLoaded') },
    log: { log: () => {} },
  })
  return { calls, data, controls }
}

describe('mesh controls', () => {
  it('mesh off persists, closes the WebSocket connections, then disables the mesh', () => {
    const f = fakes()
    expect(f.controls.disableMesh()).toMatchObject({ success: true, meshEnabled: false })
    expect(f.calls).toEqual(['set meshEnabled=false', 'ws.stopAll', 'mesh.disable'])
  })

  it('server start/stop persist meshServerEnabled by default and not with persist: false', async () => {
    const f = fakes()
    expect(await f.controls.stopServer({ persist: false })).toEqual({ success: true, running: false, port: 7295, host: '127.0.0.1' })
    expect(await f.controls.startServer({ persist: false })).toEqual({ success: true, running: true, port: 7295, host: '127.0.0.1' })
    expect('meshServerEnabled' in f.data).toBe(false)
    await f.controls.stopServer()
    expect(f.data.meshServerEnabled).toBe(false)
    await f.controls.startServer()
    expect(f.data.meshServerEnabled).toBe(true)
  })
})

describe('/network/server/start|stop?persist=', () => {
  const closers: Array<() => Promise<unknown>> = []
  afterEach(async () => { for (const c of closers.splice(0)) await c() })

  it('passes persist to the network service; default true; anything else is 400', async () => {
    const seen: unknown[] = []
    const settings = { get: () => undefined, set: () => {} }
    const runtime = new RuntimeService({ settings, enforceReviewGate: false, providerFactory: () => new MockLLMProvider() })
    const server = createDaemonHttpApi(runtime, {
      settingsStore: settings,
      networkService: {
        getStatus: () => ({}),
        startServer: (opts) => { seen.push(['start', opts]); return { success: true } },
        stopServer: (opts) => { seen.push(['stop', opts]); return { success: true } },
      },
    })
    closers.push(() => server.close())
    expect((await server.inject({ method: 'POST', url: '/network/server/stop?persist=0' })).statusCode).toBe(200)
    expect((await server.inject({ method: 'POST', url: '/network/server/start?persist=false' })).statusCode).toBe(200)
    expect((await server.inject({ method: 'POST', url: '/network/server/start' })).statusCode).toBe(200)
    expect((await server.inject({ method: 'POST', url: '/network/server/stop?persist=maybe' })).statusCode).toBe(400)
    expect(seen).toEqual([['stop', { persist: false }], ['start', { persist: false }], ['start', { persist: true }]])
  })
})

describe('mesh server binder', () => {
  function binder() {
    const calls: string[] = []
    const state = { running: false, host: '127.0.0.1', lan: false, reachable: true, enabled: true as boolean | undefined }
    const server = {
      isRunning: () => state.running,
      getHost: () => state.host,
      start: async () => { state.running = true; state.host = state.lan ? '0.0.0.0' : '127.0.0.1'; calls.push(`start ${state.host}`) },
      stop: async () => { state.running = false; calls.push('stop') },
    }
    const b = createMeshServerBinder({
      settings: { get: (key) => (key === 'meshServerEnabled' ? state.enabled : undefined) },
      mesh: { hasAnyReachableAgent: () => state.reachable, hasAgentOfTier: (tier) => tier === 'lan' && state.lan },
      server,
      debounceMs: 20,
      log: { log: () => {}, error: () => {} },
    })
    const controls = createMeshControls({
      settings: { set: () => {} },
      mesh: { isEnabled: () => true, enableMesh: () => {}, disableMesh: () => {}, getAgentStatuses: () => [] },
      server: { ...server, getPort: () => 7295 },
      ws: { stopAll: () => {} },
      registerLoaded: () => {},
      onServerSwitch: (s) => b.serverSwitched(s),
      log: { log: () => {} },
    })
    return { calls, state, b, controls }
  }
  const settle = () => new Promise(r => setTimeout(r, 60))

  it('binds at once on the first registration outside autostart (no 7295 window)', async () => {
    const { calls, b } = binder()
    b.ensure()
    await Promise.resolve()
    expect(calls).toEqual(['start 127.0.0.1'])
    b.dispose()
  })

  it('during autostart waits for the burst to settle, so a LAN agent binds 0.0.0.0 once (no loopback-then-LAN restart)', async () => {
    const { calls, state, b } = binder()
    b.autostartSettling(true)
    b.ensure()
    state.lan = true
    b.ensure()
    await settle()
    expect(calls).toEqual([])
    b.autostartSettling(false)
    await settle()
    expect(calls).toEqual(['start 0.0.0.0'])
    b.dispose()
  })

  it('a stop on request (persist=0) holds against later registrations until a start on request', async () => {
    const { calls, b, controls } = binder()
    b.ensure()
    await settle()
    await controls.stopServer({ persist: false })
    b.ensure()
    await settle()
    expect(calls).toEqual(['start 127.0.0.1', 'stop'])
    expect(b.stoppedOnRequest).toBe(true)
    await controls.startServer({ persist: false })
    expect(b.stoppedOnRequest).toBe(false)
    expect(calls).toEqual(['start 127.0.0.1', 'stop', 'start 127.0.0.1'])
    b.dispose()
  })
})
