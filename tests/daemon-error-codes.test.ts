/**
 * Error bodies carry a machine-readable `code`, and the specific refusals
 * answer with their own status + code instead of a generic 500.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  const dir = join(tmpdir(), `adf-daemon-error-codes-${process.pid}`)
  return {
    app: { getPath: () => dir, on: () => {}, getName: () => 'adf-daemon-error-codes', getVersion: () => '0.0.0-test' },
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
import { RuntimeService } from '../src/main/runtime/runtime-service'
import { createHeadlessAgent, MockLLMProvider } from '../src/main/runtime/headless'

const TOKEN = 'b'.repeat(43)
const servers: Array<{ close: () => Promise<unknown> }> = []
const runtimes: RuntimeService[] = []
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => s.close()))
  // unloadAgent, not shutdownAll: shutdownAll latches the process-wide RuntimeGate teardown.
  for (const runtime of runtimes.splice(0)) {
    for (const agent of runtime.listAgents()) await runtime.unloadAgent(agent.id, { mode: 'immediate' })
  }
})
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

function memorySettings(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { trackedDirectories: [], providers: [], ...initial }
  return {
    filePath: join(tmpdir(), 'adf-error-codes-settings.json'),
    get: (key: string) => data[key],
    set: (key: string, value: unknown) => { data[key] = value },
    getAll: () => ({ ...data }),
    update: (patch: Record<string, unknown>) => { Object.assign(data, patch) },
  }
}

function setup(settings = memorySettings()) {
  const runtime = new RuntimeService({ enforceReviewGate: false, settings, providerFactory: () => new MockLLMProvider({ tokensPerResponse: 10 }) })
  runtimes.push(runtime)
  const ref = runtime.createAgent({ name: 'agent-1', provider: new MockLLMProvider({ tokensPerResponse: 10 }) })
  const server = createDaemonHttpApi(runtime, { settingsStore: settings, security: { token: TOKEN } })
  servers.push(server)
  const auth = { authorization: `Bearer ${TOKEN}` }
  return { runtime, ref, server, auth }
}

describe('daemon error codes', () => {
  it('every 400/404/409 body carries a code (route helpers and Fastify defaults)', async () => {
    const { ref, server, auth } = setup()
    const cases: Array<[string, string, number, string, unknown?]> = [
      ['GET', '/agents/agent-9/status', 404, 'not_found'],
      ['GET', `/agents/${ref.id}/logs?limit=abc`, 400, 'bad_request'],
      ['GET', '/no/such/route', 404, 'not_found'],
      ['POST', `/agents/${ref.id}/chat`, 400, 'bad_request', {}],
      ['DELETE', `/agents/${ref.id}/loops/main`, 409, 'conflict'],
    ]
    for (const [method, url, status, code, payload] of cases) {
      const res = await server.inject({ method: method as 'GET', url, headers: auth, ...(payload !== undefined ? { payload: payload as object } : {}) })
      expect(res.statusCode, `${method} ${url}`).toBe(status)
      expect(res.json().code, `${method} ${url}`).toBe(code)
      expect(typeof res.json().error === 'string' || typeof res.json().message === 'string').toBe(true)
    }
  })

  it('settings refusals are 403 setting_not_writable', async () => {
    const { server, auth } = setup()
    const put = await server.inject({ method: 'PUT', url: '/settings/ownerDid', headers: auth, payload: { value: 'did:key:x' } })
    expect(put.statusCode).toBe(403)
    expect(put.json().code).toBe('setting_not_writable')
    const patch = await server.inject({ method: 'PATCH', url: '/settings', headers: auth, payload: { trustedDaemonEncKeys: [] } })
    expect(patch.statusCode).toBe(403)
    expect(patch.json().code).toBe('setting_not_writable')
  })

  it('answering an unknown ask is 404 ask_not_found', async () => {
    const { ref, server, auth } = setup()
    const res = await server.inject({ method: 'POST', url: `/agents/${ref.id}/asks/nope/respond`, headers: auth, payload: { answer: 'x' } })
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('ask_not_found')
  })

  it('a credential write to a password-locked legacy agent is 409 credentials_locked', async () => {
    const { runtime, ref, server, auth } = setup()
    const managed = (runtime as unknown as { requireAgent(id: string): { agent: { workspace: { isPasswordProtected(): boolean } } } }).requireAgent(ref.id)
    managed.agent.workspace.isPasswordProtected = () => true
    for (const [method, url, payload] of [
      ['PUT', `/agents/${ref.id}/identity/custom:token`, { value: 'v' }],
      ['PUT', `/agents/${ref.id}/providers/anthropic/credential`, { value: 'v' }],
      ['DELETE', `/agents/${ref.id}/identity/password`, undefined],
    ] as const) {
      const res = await server.inject({ method, url, headers: auth, ...(payload ? { payload } : {}) })
      expect(res.statusCode, url).toBe(409)
      expect(res.json().code, url).toBe('credentials_locked')
    }
  })

  it('starting an identifier that matches several files is 409 ambiguous_agent with the candidates', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-ambiguous-'))
    dirs.push(dir)
    const settings = memorySettings({ trackedDirectories: [dir] })
    const { server, auth } = setup(settings)
    for (const sub of ['a', 'b']) {
      mkdirSync(join(dir, sub))
      createHeadlessAgent({ filePath: join(dir, sub, 'twin.adf'), name: 'twin', provider: new MockLLMProvider(), createOptions: { handle: 'twin' } }).dispose()
    }
    const res = await server.inject({ method: 'POST', url: '/agents/twin/start', headers: auth })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('ambiguous_agent')
    expect(res.json().candidates).toHaveLength(2)
  })

  it('HEAD /health needs no token, like GET', async () => {
    const { server } = setup()
    expect((await server.inject({ method: 'HEAD', url: '/health' })).statusCode).toBe(200)
    expect((await server.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200)
    expect((await server.inject({ method: 'HEAD', url: '/agents' })).statusCode).toBe(401)
  })
})
