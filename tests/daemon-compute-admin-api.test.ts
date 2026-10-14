// Compute gap routes (W1-D) against a fake compute service: no PodmanService
// is constructed and no container is touched.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDaemonHttpApi, type DaemonHttpApiOptions } from '../src/main/daemon/http-api'
import { RuntimeService } from '../src/main/runtime/runtime-service'
import { getComputeBrowserInfo } from '../src/main/services/compute-browser-info'

const cleanups: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn() })

function fakeCompute() {
  return {
    getStatus: () => ({ status: 'running' }) as never,
    listContainers: async () => [],
    ensureRunning: async () => {},
    stop: async () => {},
    rebuildContainer: vi.fn(async (name: string) => {
      if (name === 'adf-broken') throw new Error('image pull failed')
      return { recreated: true }
    }),
    containerPhase: vi.fn(async () => ({ phase: 'ready' as const })),
    browserReady: vi.fn(async () => {}),
    getNovncHostPort: vi.fn(async () => 6081),
  }
}

function setup(opts: Partial<DaemonHttpApiOptions> = {}) {
  const server = createDaemonHttpApi(new RuntimeService({ enforceReviewGate: false }), opts)
  cleanups.push(() => server.close())
  return server
}

describe('compute gap routes', () => {
  it('rebuild answers { success, recreated } or the error, as Studio', async () => {
    const compute = fakeCompute()
    const server = setup({ computeService: compute })
    expect((await server.inject({ method: 'POST', url: '/compute/containers/adf-agent-1/rebuild' })).json()).toEqual({ success: true, recreated: true })
    expect(compute.rebuildContainer).toHaveBeenCalledWith('adf-agent-1')
    expect((await server.inject({ method: 'POST', url: '/compute/containers/adf-broken/rebuild' })).json()).toEqual({ success: false, error: 'image pull failed' })
    expect((await setup().inject({ method: 'POST', url: '/compute/containers/x/rebuild' })).json()).toEqual({ success: false, error: 'Compute is not configured on this daemon' })
  })

  it('browser-info is the shared lookup on the daemon compute service', async () => {
    const compute = fakeCompute()
    const server = setup({ computeService: compute })
    const res = await server.inject({ method: 'GET', url: '/compute/browser-info?agentName=agent-1&agentId=abc123' })
    expect(res.json()).toEqual(JSON.parse(JSON.stringify(await getComputeBrowserInfo(compute, { agentName: 'agent-1', agentId: 'abc123' }))))
    expect(res.json()).toMatchObject({ hostPort: 6081, phase: 'ready' })
    expect((await server.inject({ method: 'GET', url: '/compute/browser-info?agentName=agent-1' })).statusCode).toBe(400)
    expect((await setup().inject({ method: 'GET', url: '/compute/browser-info?agentName=a&agentId=b' })).statusCode).toBe(503)
  })

  it('execution target test passes the body to the probe', async () => {
    const probe = vi.fn(async () => ({ success: true, engine: 'docker', version: '27.0' }))
    const server = setup({ routes: { gaps: { externalExecution: { probe } } } })
    const target = { id: 't1', engine: 'docker', container: 'dev' }
    expect((await server.inject({ method: 'POST', url: '/compute/execution-targets/test', payload: target })).json()).toEqual({ success: true, engine: 'docker', version: '27.0' })
    expect(probe).toHaveBeenCalledWith(target)
  })
})
