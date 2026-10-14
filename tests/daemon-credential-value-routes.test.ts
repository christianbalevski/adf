import { existsSync, mkdtempSync, realpathSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  const dir = join(tmpdir(), `adf-daemon-credential-values-${process.pid}`)
  return {
    app: { getPath: () => dir, on: () => {}, getName: () => 'adf-daemon-credential-values-test', getVersion: () => '0.0.0-test' },
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
import { AdfWorkspace } from '../src/main/adf/adf-workspace'
import { RuntimeService } from '../src/main/runtime/runtime-service'
import { createHeadlessAgent, MockLLMProvider } from '../src/main/runtime/headless'

// Studio's stored-value routes (tracker W3-B, routes/credential-value-routes.ts):
// the local-only reveal routes and the in-daemon "Copy app key".

const servers: Array<{ close: () => Promise<unknown> }> = []
const runtimes: RuntimeService[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()))
  for (const runtime of runtimes.splice(0)) {
    for (const agent of runtime.listAgents()) await runtime.unloadAgent(agent.id, { mode: 'immediate' })
  }
})

/** Seeded files are the owner's reviewed agents (the load gate). */
const reviewed: Record<string, string> = {}

function seedAgent(name: string): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'adf-credential-values-')))
  const filePath = join(dir, `${name}.adf`)
  createHeadlessAgent({ filePath, name, provider: new MockLLMProvider(), createOptions: { handle: name, start_in_state: 'hibernate' } }).dispose()
  const ws = AdfWorkspace.open(filePath)
  try {
    reviewed[ws.getAgentConfig().id] = 'accepted'
    ws.setIdentity('provider:p1:apiKey', 'sk-agent')
    ws.setIdentity('provider:p1_x:apiKey', 'sk-other')
    ws.setIdentity('app:token', 'code-secret')
    ws.setIdentity('crypto:test:secret', 'key-material')
  } finally {
    ws.close()
  }
  return filePath
}

function setup() {
  const data: Record<string, unknown> = { providers: [{ id: 'p1', type: 'openai', name: 'OpenAI', baseUrl: '', apiKey: 'sk-app' }], reviewedAgents: reviewed }
  const store = {
    get: (key: string) => data[key],
    set: (key: string, value: unknown) => { data[key] = value },
    getAll: () => ({ ...data }),
    update: (values: Record<string, unknown>) => { Object.assign(data, values) },
  }
  const runtime = new RuntimeService({ settings: store, providerFactory: () => new MockLLMProvider() })
  runtimes.push(runtime)
  const server = createDaemonHttpApi(runtime, { settingsStore: store, security: { localProof: PROOF } })
  servers.push(server)
  return { runtime, server }
}

const q = (p: string) => encodeURIComponent(p)
const PROOF = 'p'.repeat(43)
/** This machine's local proof, as Studio and the adf CLI send it on local-only routes. */
const proof = { 'x-adf-local-proof': PROOF }

describe('POST /agents/:id/identity/reveal and /files/agent/identity/reveal', () => {
  it('answers values under an exact prefix and named purposes, never key material, local callers only', async () => {
    const { runtime, server } = setup()
    const filePath = seedAgent('agent-1')
    const { id } = await runtime.loadAgent(filePath)

    const res = await server.inject({ method: 'POST', url: `/agents/${id}/identity/reveal`, headers: proof, payload: { prefix: 'provider:p1:', purposes: ['app:token', 'crypto:test:secret', 'missing'] } })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    // `provider:p1_x:` is not under the exact prefix `provider:p1:` (a LIKE would match it).
    expect(res.json()).toEqual({ agentId: id, values: { 'provider:p1:apiKey': 'sk-agent', 'app:token': 'code-secret' } })

    const remote = await server.inject({ method: 'POST', url: `/agents/${id}/identity/reveal`, headers: proof, payload: { prefix: 'provider:' }, remoteAddress: '10.0.0.9' })
    expect(remote.statusCode).toBe(403)
    expect(remote.json().code).toBe('loopback_only')
    expect(remote.body).not.toContain('sk-agent')
    const proxied = await server.inject({ method: 'POST', url: `/agents/${id}/identity/reveal`, payload: { prefix: 'provider:' }, headers: { ...proof, 'x-forwarded-for': '1.2.3.4' } })
    expect(proxied.statusCode).toBe(403)

    // A token holder on the loopback port without the proof (a forwarded port: ssh -L, socat) gets nothing.
    for (const headers of [{}, { 'x-adf-local-proof': 'q'.repeat(43) }]) {
      const noProof = await server.inject({ method: 'POST', url: `/agents/${id}/identity/reveal`, headers, payload: { prefix: 'provider:' } })
      expect(noProof.statusCode).toBe(403)
      expect(noProof.json().code).toBe('loopback_only')
      expect(noProof.body).not.toContain('sk-agent')
    }

    expect((await server.inject({ method: 'POST', url: `/agents/${id}/identity/reveal`, headers: proof, payload: {} })).statusCode).toBe(400)
    expect((await server.inject({ method: 'POST', url: '/agents/nope/identity/reveal', headers: proof, payload: { prefix: 'x' } })).statusCode).toBe(404)
  })

  it('reads a file nobody has open, and refuses another machine', async () => {
    const { server } = setup()
    const filePath = seedAgent('agent-2')
    const before = statSync(filePath).mtimeMs
    const res = await server.inject({ method: 'POST', url: `/files/agent/identity/reveal?path=${q(filePath)}`, headers: proof, payload: { prefix: 'provider:p1:' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ filePath, loaded: false, values: { 'provider:p1:apiKey': 'sk-agent' } })
    // A read: one readonly connection, the file and its sidecars as they were.
    expect(statSync(filePath).mtimeMs).toBe(before)
    expect(existsSync(`${filePath}-wal`)).toBe(false)
    const remote = await server.inject({ method: 'POST', url: `/files/agent/identity/reveal?path=${q(filePath)}`, headers: proof, payload: { prefix: 'provider:' }, remoteAddress: '10.0.0.9' })
    expect(remote.statusCode).toBe(403)
    const noProof = await server.inject({ method: 'POST', url: `/files/agent/identity/reveal?path=${q(filePath)}`, payload: { prefix: 'provider:' } })
    expect(noProof.statusCode).toBe(403)
  })
})

describe('POST /files/agent/providers/:providerId/credential/copy-app-key', () => {
  it('stores the app provider\'s key in the agent file without it crossing HTTP', async () => {
    const { server } = setup()
    const filePath = seedAgent('agent-3')
    const res = await server.inject({ method: 'POST', url: `/files/agent/providers/p1/credential/copy-app-key?path=${q(filePath)}`, payload: {} })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ providerId: 'p1', success: true, filePath, loaded: false })
    expect(res.body).not.toContain('sk-app')
    const ws = AdfWorkspace.open(filePath)
    try {
      expect(ws.getIdentityDecrypted('provider:p1:apiKey', null)).toBe('sk-app')
    } finally {
      ws.close()
    }
  })

  it('refuses a provider with no app key, and a running agent gets it through the runtime', async () => {
    const { runtime, server } = setup()
    const filePath = seedAgent('agent-4')
    const none = await server.inject({ method: 'POST', url: `/files/agent/providers/p2/credential/copy-app-key?path=${q(filePath)}`, payload: {} })
    expect(none.statusCode).toBe(409)
    expect(none.json().code).toBe('no_app_key')
    const { id } = await runtime.loadAgent(filePath)
    const res = await server.inject({ method: 'POST', url: `/files/agent/providers/p1/credential/copy-app-key?path=${q(filePath)}`, payload: {} })
    expect(res.json()).toMatchObject({ agentId: id, success: true, loaded: true })
    const values = await server.inject({ method: 'POST', url: `/agents/${id}/identity/reveal`, headers: proof, payload: { purposes: ['provider:p1:apiKey'] } })
    expect(values.json().values).toEqual({ 'provider:p1:apiKey': 'sk-app' })
  })
})
