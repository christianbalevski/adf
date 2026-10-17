// Credential metadata routes (W1-D). Shape parity: each list route returns
// what Studio's *_CREDENTIAL_LIST_FILES handler returns for the same files,
// i.e. the shared scan (services/credential-list-files.ts) over the loaded
// agents and tracked directories. Metadata only: a stored secret never
// appears in any response.
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AdfWorkspace } from '../src/main/adf/adf-workspace'
import { createDaemonHttpApi } from '../src/main/daemon/http-api'
import { resolveAgentWorkspace, resolveAgentWorkspaceByPath } from '../src/main/daemon/routes/agent-resolver'
import { loadedAgentIndex } from '../src/main/daemon/routes/loaded-agents'
import { MockLLMProvider } from '../src/main/runtime/headless'
import { RuntimeService } from '../src/main/runtime/runtime-service'
import { agentProviderKeySource } from '../src/main/providers/provider-factory'
import { listAdapterCredentialFiles, listMcpCredentialFiles, listProviderCredentialFiles } from '../src/main/services/credential-list-files'
import type { ProviderConfig } from '../src/shared/types/ipc.types'

const SECRET = 'sk-test-SECRET-value-0042'
const APP_KEY = 'sk-app-SECRET-key-0043'

const cleanups: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn() })

function agentFile(dir: string, handle: string, edit: (ws: AdfWorkspace) => void): string {
  const filePath = join(dir, `${handle}.adf`)
  mkdirSync(dir, { recursive: true })
  const ws = AdfWorkspace.create(filePath, { name: handle })
  try {
    ws.setAgentConfig({ ...ws.getAgentConfig(), id: randomUUID(), handle })
    edit(ws)
  } finally {
    ws.close()
  }
  return filePath
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'adf-daemon-cred-'))
  const tracked = join(root, 'tracked')
  const outside = join(root, 'outside')
  const appProvider: ProviderConfig = { id: 'anthropic', type: 'anthropic', name: 'Anthropic', baseUrl: '', apiKey: APP_KEY }
  const data: Record<string, unknown> = { trackedDirectories: [tracked], providers: [appProvider] }
  const settings = { get: (key: string) => data[key] }
  const runtime = new RuntimeService({ enforceReviewGate: false, providerFactory: () => new MockLLMProvider() })
  const server = createDaemonHttpApi(runtime, { settingsStore: settings })
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  cleanups.push(async () => { for (const a of runtime.listAgents()) await runtime.unloadAgent(a.id) })
  cleanups.push(() => server.close())
  return { root, tracked, outside, runtime, server, data }
}

describe('credential list-files routes', () => {
  it('match the shared scan over loaded agents and tracked dirs, never carrying a value', async () => {
    const { tracked, outside, runtime, server } = setup()
    const loadedPath = agentFile(outside, 'agent-1', (ws) => {
      ws.setIdentity('mcp:@acme/server:API_KEY', SECRET)
      ws.setIdentity('adapter:telegram:BOT_TOKEN', SECRET)
    })
    agentFile(tracked, 'agent-2', (ws) => {
      const config = ws.getAgentConfig()
      config.mcp = { servers: [{ name: 'acme', transport: 'stdio', command: 'node' }] }
      config.adapters = { telegram: { enabled: true } }
      config.providers = [{ id: 'anthropic', type: 'anthropic', name: 'Anthropic', baseUrl: '', defaultModel: 'm-1' }]
      ws.setAgentConfig(config)
      ws.setIdentity('provider:anthropic:apiKey', SECRET)
    })
    await runtime.loadAgent(loadedPath)
    const sources = { knownFiles: runtime.listAgents().map((a) => a.filePath!), trackedDirs: [tracked] }

    const mcp = await server.inject({ method: 'GET', url: '/credentials/mcp/files?mcpServerName=acme&npmPackage=%40acme%2Fserver' })
    expect(mcp.statusCode).toBe(200)
    expect(mcp.json()).toEqual(JSON.parse(JSON.stringify(listMcpCredentialFiles({ mcpServerName: 'acme', npmPackage: '@acme/server' }, sources))))
    expect(mcp.json().files).toHaveLength(2)

    const adapters = await server.inject({ method: 'GET', url: '/credentials/adapters/files?adapterType=telegram' })
    expect(adapters.json()).toEqual(JSON.parse(JSON.stringify(listAdapterCredentialFiles('telegram', sources))))
    expect(adapters.json().files).toHaveLength(2)

    const providers = await server.inject({ method: 'GET', url: '/credentials/providers/files?providerId=anthropic' })
    expect(providers.json()).toEqual(JSON.parse(JSON.stringify(listProviderCredentialFiles('anthropic', sources))))
    expect(providers.json().files[0]).toMatchObject({ fileName: 'agent-2.adf', hasCredentials: true, populatedKeys: ['apiKey'], providerConfig: { defaultModel: 'm-1' } })

    for (const res of [mcp, adapters, providers]) expect(res.body).not.toContain(SECRET)

    expect((await server.inject({ method: 'GET', url: '/credentials/mcp/files?mcpServerName=acme' })).statusCode).toBe(400)
    expect((await server.inject({ method: 'GET', url: '/credentials/adapters/files' })).statusCode).toBe(400)
    expect((await server.inject({ method: 'GET', url: '/credentials/providers/files' })).statusCode).toBe(400)
  })
})

describe('POST /credentials/providers/key-sources', () => {
  it('reports where each provider copy gets its key, for loaded and closed files, never the key', async () => {
    const { tracked, outside, runtime, server, data } = setup()
    const loadedPath = agentFile(outside, 'agent-1', (ws) => ws.setIdentity('provider:custom:own:apiKey', SECRET))
    const closedPath = agentFile(tracked, 'agent-2', () => {})
    await runtime.loadAgent(loadedPath)
    const entries = [
      { id: 'custom:own', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' },
      { id: 'anthropic', type: 'anthropic', baseUrl: '' },
      { id: 'openai', type: 'openai', baseUrl: '' },
      { id: 'chatgpt', type: 'chatgpt-subscription', baseUrl: '' },
    ]

    const res = await server.inject({ method: 'POST', url: '/credentials/providers/key-sources', payload: { filePath: loadedPath, providers: entries } })
    expect(res.statusCode).toBe(200)
    const live = runtime.listLiveAgents()[0].workspace
    const settings = { getProvider: (id: string) => (data.providers as ProviderConfig[]).find((p) => p.id === id) }
    const expected = Object.fromEntries(entries.map((e) => [e.id, agentProviderKeySource(e as never, live, null, settings)]))
    expect(res.json()).toEqual({ sources: expected })
    expect(res.json().sources).toMatchObject({ 'custom:own': 'agent', chatgpt: 'app_sign_in' })
    expect(res.body).not.toContain(SECRET)
    expect(res.body).not.toContain(APP_KEY)

    const closed = await server.inject({ method: 'POST', url: '/credentials/providers/key-sources', payload: { filePath: closedPath, providers: entries.slice(0, 3) } })
    expect(closed.json()).toEqual({ sources: { 'custom:own': 'not_needed', anthropic: 'app', openai: 'none' } })

    const missing = await server.inject({ method: 'POST', url: '/credentials/providers/key-sources', payload: { filePath: join(tracked, 'nope.adf'), providers: [] } })
    expect(missing.json()).toEqual({ sources: {}, error: 'Cannot open file' })
    expect((await server.inject({ method: 'POST', url: '/credentials/providers/key-sources', payload: { filePath: closedPath } })).statusCode).toBe(400)
  })
})

describe('key-sources on a file nobody has open', () => {
  it('reads it read-only: no migration, no write, no sidecars left; plain keys read as agent', async () => {
    const { tracked, server } = setup()
    const closedPath = agentFile(tracked, 'agent-1', (ws) => ws.setIdentity('provider:custom:own:apiKey', SECRET))
    const before = statSync(closedPath)
    const res = await server.inject({ method: 'POST', url: '/credentials/providers/key-sources', payload: {
      filePath: closedPath,
      providers: [{ id: 'custom:own', type: 'openai', baseUrl: '' }, { id: 'openai', type: 'openai', baseUrl: '' }],
    } })
    expect(res.json()).toEqual({ sources: { 'custom:own': 'agent', openai: 'none' } })
    expect(res.body).not.toContain(SECRET)
    const after = statSync(closedPath)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(after.size).toBe(before.size)
    expect(existsSync(`${closedPath}-wal`)).toBe(false)
    expect(existsSync(`${closedPath}-shm`)).toBe(false)
  })
})

describe('a password-protected agent unlocked in the daemon', () => {
  it('reads as unlocked through the resolver and key-sources, not as locked', async () => {
    const { outside, runtime, server } = setup()
    let key: Buffer | null = null
    const filePath = agentFile(outside, 'agent-1', (ws) => {
      ws.setIdentity('provider:custom:own:apiKey', SECRET)
      key = ws.setPassword('pw')
    })
    const ref = await runtime.loadAgent(filePath)
    const payload = { filePath, providers: [{ id: 'custom:own', type: 'openai', baseUrl: '' }] }

    const before = await server.inject({ method: 'POST', url: '/credentials/providers/key-sources', payload })
    expect(before.json()).toEqual({ sources: { 'custom:own': 'locked' } })
    expect(resolveAgentWorkspace(runtime, ref.id)).toMatchObject({ ok: true, agent: { derivedKey: null } })

    const unlock = await server.inject({ method: 'POST', url: `/agents/${ref.id}/identity/password/unlock`, payload: { password: 'pw' } })
    expect(unlock.statusCode).toBe(200)

    const after = await server.inject({ method: 'POST', url: '/credentials/providers/key-sources', payload })
    expect(after.json()).toEqual({ sources: { 'custom:own': 'agent' } })
    expect(after.body).not.toContain(SECRET)
    const resolved = resolveAgentWorkspace(runtime, ref.id)
    expect(resolved.ok && resolved.agent.derivedKey?.equals(key!)).toBe(true)
    expect(resolveAgentWorkspaceByPath(runtime, filePath)?.derivedKey?.equals(key!)).toBe(true)
    expect(loadedAgentIndex(runtime).get(ref.id)?.derivedKey?.equals(key!)).toBe(true)
  })
})
