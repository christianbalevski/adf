// Agent and MCP registry routes plus skill catalogs (W1-D). Shape parity:
// the routes return what the same services return in Studio for the same
// bundled dir, cache dir and fetch results. remoteCatalogsEnabled: false
// keeps both registries off the network; every fetch here is a stub.
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const guarded = vi.hoisted(() => ({ fn: vi.fn() }))
vi.mock('../src/main/utils/guarded-fetch', async (orig) => ({ ...(await orig<object>()), guardedFetch: guarded.fn }))

import { AdfWorkspace } from '../src/main/adf/adf-workspace'
import { createDaemonHttpApi } from '../src/main/daemon/http-api'
import { RuntimeService } from '../src/main/runtime/runtime-service'
import { AgentRegistryService } from '../src/main/services/agent-registry.service'
import { McpRegistryFetchService } from '../src/main/services/mcp-registry-fetch.service'
import { bundledRegistryDir } from '../src/main/daemon/routes/registry-routes'
import type { GuardedFetchResult } from '../src/main/utils/guarded-fetch'
import type { ProviderConfig } from '../src/shared/types/ipc.types'

const BUNDLED = resolve('registry')
const cleanups: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => {
  guarded.fn.mockReset()
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

function setup(settingsData: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'adf-daemon-registry-'))
  const cacheDir = join(root, 'data')
  const agentsDir = join(root, 'agents')
  const data: Record<string, unknown> = { remoteCatalogsEnabled: false, ...settingsData }
  const settings = { get: (key: string) => data[key] }
  const agentFetchFn = vi.fn(async (): Promise<GuardedFetchResult> => ({ error: 'offline' }))
  const mcpFetchFn = vi.fn(async () => { throw new Error('offline') }) as unknown as typeof fetch
  const server = createDaemonHttpApi(new RuntimeService({ enforceReviewGate: false }), {
    settingsStore: settings,
    version: '0.6.3',
    agentFactory: { defaultDirectory: () => agentsDir } as never,
    routes: { gaps: { registry: { bundledDir: BUNDLED, userDataDir: cacheDir, agentFetchFn, mcpFetchFn } } },
  })
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  cleanups.push(() => server.close())
  return { root, cacheDir, agentsDir, data, server, agentFetchFn, mcpFetchFn }
}

describe('agent registry routes', () => {
  it('GET /registry/agents matches the service for the same inputs; the opt-out keeps it off the network', async () => {
    const { server, cacheDir, agentFetchFn } = setup()
    const res = await server.inject({ method: 'GET', url: '/registry/agents' })
    expect(res.statusCode).toBe(200)
    const reference = await new AgentRegistryService({ bundledDir: BUNDLED, userDataDir: cacheDir, appVersion: '0.6.3', fetchFn: agentFetchFn, isRemoteEnabled: () => false }).getRegistry()
    expect(res.json()).toEqual(JSON.parse(JSON.stringify(reference)))
    expect(res.json().agents.length).toBeGreaterThan(0)
    expect(agentFetchFn).not.toHaveBeenCalled()

    const refreshed = await server.inject({ method: 'POST', url: '/registry/agents/refresh' })
    expect(refreshed.statusCode).toBe(200)
    expect(agentFetchFn).not.toHaveBeenCalled()
  })

  it('with remote catalogs on, a failed index fetch still renders the bundled gallery', async () => {
    const { server, agentFetchFn } = setup({ remoteCatalogsEnabled: true })
    const res = await server.inject({ method: 'GET', url: '/registry/agents' })
    expect(agentFetchFn).toHaveBeenCalledTimes(1)
    expect(agentFetchFn.mock.calls[0][1]).toMatchObject({ timeoutMs: expect.any(Number) })
    expect(res.json().agents.length).toBeGreaterThan(0)
  })

  it('POST /registry/agents/:id/bring-home copies into the agents folder without identity', async () => {
    const provider: ProviderConfig = { id: 'anthropic', type: 'anthropic', name: 'Anthropic', baseUrl: '', apiKey: 'sk-ant-SECRET-9', defaultModel: 'claude-x' }
    const { server, agentsDir } = setup({ providers: [provider] })
    const gallery = (await server.inject({ method: 'GET', url: '/registry/agents' })).json() as { agents: Array<{ id: string; file: string }> }
    const entry = gallery.agents[0]
    const res = await server.inject({ method: 'POST', url: `/registry/agents/${entry.id}/bring-home` })
    expect(res.json()).toEqual({ success: true, filePath: join(agentsDir, entry.file) })
    const ws = AdfWorkspace.open(join(agentsDir, entry.file))
    try {
      expect(ws.getDid()).toBeNull()
      expect(ws.getAgentConfig().name).toBe(entry.file.replace(/\.adf$/, ''))
    } finally {
      ws.close()
    }
    expect(res.body).not.toContain('sk-ant-SECRET-9')
    const unknown = await server.inject({ method: 'POST', url: `/registry/agents/${randomUUID()}/bring-home` })
    expect(unknown.json().success).toBe(false)
    expect(readdirSync(agentsDir).filter((f) => f.endsWith('.partial'))).toEqual([])
  })

  it('finds the repo registry from the daemon module in a dev tree', () => {
    expect(bundledRegistryDir()).toBe(BUNDLED)
  })
})

describe('MCP registry route', () => {
  it('GET /registry/mcp matches the service; the opt-out never fetches', async () => {
    const { server, cacheDir, mcpFetchFn } = setup()
    const res = await server.inject({ method: 'GET', url: '/registry/mcp' })
    expect(res.statusCode).toBe(200)
    const reference = await new McpRegistryFetchService({ userDataDir: cacheDir, fetchFn: mcpFetchFn, isRemoteEnabled: () => false }).getRegistry()
    expect(res.json()).toEqual(JSON.parse(JSON.stringify(reference)))
    expect(mcpFetchFn).not.toHaveBeenCalled()
  })
})

describe('skill catalog routes', () => {
  it('read through the guarded fetch with Studio checks', async () => {
    const { server } = setup()
    expect((await server.inject({ method: 'GET', url: '/catalog/skills?url=http%3A%2F%2Fx.test%2Fc.json' })).json()).toEqual({ ok: false, error: 'Catalog URL must be https' })
    guarded.fn.mockResolvedValueOnce({ bytes: Buffer.from('not json') })
    expect((await server.inject({ method: 'GET', url: '/catalog/skills?url=https%3A%2F%2Fx.test%2Fc.json' })).json()).toEqual({ ok: false, error: 'Catalog is not valid JSON' })
    guarded.fn.mockResolvedValueOnce({ bytes: Buffer.from('# Skill\n') })
    expect((await server.inject({ method: 'GET', url: '/catalog/skills/package?url=https%3A%2F%2Fx.test%2FSKILL.md' })).json()).toEqual({ ok: true, content: '# Skill\n' })
    expect(guarded.fn).toHaveBeenLastCalledWith('https://x.test/SKILL.md', expect.objectContaining({ timeoutMs: 10_000 }))
  })
})
