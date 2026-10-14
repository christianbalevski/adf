// Dashboard, provider test, tool catalog and token-usage routes (W1-D). Shape
// parity: each route returns the shared body Studio's handler returns
// (services/dashboard-stats.ts, provider-checks.ts, tool-descriptions.ts) for
// the same settings and files. Provider checks honour providerChecksEnabled:
// with it off, no request leaves the daemon unless the caller forces a Test.
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AdfWorkspace } from '../src/main/adf/adf-workspace'
import { createDaemonHttpApi } from '../src/main/daemon/http-api'
import { RuntimeService } from '../src/main/runtime/runtime-service'
import { CodeSandboxService } from '../src/main/runtime/code-sandbox'
import { AdfDatabase } from '../src/main/adf/adf-database'
import { buildAgentStats, buildQuickStats } from '../src/main/services/dashboard-stats'
import { getTokenUsageService } from '../src/main/services/token-usage.service'
import { SandboxPackagesService } from '../src/main/services/sandbox-packages.service'
import { buildToolDescriptions } from '../src/main/services/tool-descriptions'
import { registerBuiltInTools } from '../src/main/tools/built-in/register-built-in-tools'
import { ToolRegistry } from '../src/main/tools/tool-registry'
import type { ProviderConfig } from '../src/shared/types/ipc.types'

const KEY = 'sk-ant-SECRET-dash-1'
const fetchMock = vi.fn()
const cleanups: Array<() => Promise<unknown> | unknown> = []
beforeEach(() => { fetchMock.mockReset(); fetchMock.mockResolvedValue({ ok: true }); vi.stubGlobal('fetch', fetchMock) })
afterEach(async () => {
  vi.unstubAllGlobals()
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

function setup(settingsData: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'adf-daemon-dash-'))
  const data: Record<string, unknown> = { trackedDirectories: [dir], ...settingsData }
  const settings = { get: (key: string) => data[key] }
  const sandboxPackages = { getInstalledPackages: () => [{ name: 'lodash', version: '4.17.21', installedAt: 1, size_mb: 1 }] }
  const server = createDaemonHttpApi(new RuntimeService({ enforceReviewGate: false }), { settingsStore: settings, sandboxPackageService: sandboxPackages as never })
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  cleanups.push(() => server.close())
  return { dir, data, settings, server }
}

const anthropic: ProviderConfig = { id: 'anthropic', type: 'anthropic', name: 'Anthropic', baseUrl: '', apiKey: KEY }
const openai: ProviderConfig = { id: 'openai', type: 'openai', name: 'OpenAI', baseUrl: '' }

describe('dashboard slices', () => {
  it('quick stats match buildQuickStats over the daemon settings and services', async () => {
    const { server, settings } = setup({ providers: [anthropic, openai], mcpServers: [{ name: 'fs' }], adapters: [{ type: 'telegram' }], compute: { hostAccessEnabled: true } })
    const res = await server.inject({ method: 'GET', url: '/dashboard/quick-stats' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(JSON.parse(JSON.stringify(buildQuickStats({ get: settings.get, installedPackageCount: () => 1, tokenSummary: () => getTokenUsageService().getSummary() }))))
    expect(res.json()).toMatchObject({ providers: { total: 2 }, mcp: { configured: 1 }, packages: { total: 1 }, hostAccess: { enabledGlobally: true } })
    expect(res.body).not.toContain(KEY)
  })

  it('agent stats count the tracked files as Studio does', async () => {
    const { dir, server } = setup()
    for (const [n, autostart] of [[1, true], [2, false]] as const) {
      const ws = AdfWorkspace.create(join(dir, `agent-${n}.adf`), { name: `agent-${n}` })
      try { ws.setAgentConfig({ ...ws.getAgentConfig(), id: randomUUID(), autostart }) } finally { ws.close() }
    }
    const res = await server.inject({ method: 'GET', url: '/dashboard/agent-stats' })
    const reference = await buildAgentStats([dir], {
      listAdfFiles: async () => [join(dir, 'agent-1.adf'), join(dir, 'agent-2.adf')],
      peekMeta: (fp) => AdfDatabase.peekAgentMeta(fp),
    })
    expect(res.json()).toEqual(reference)
    expect(res.json()).toMatchObject({ total: 2, autostart: 1 })
  })

  it('provider tests probe each provider once per session; the opt-out sends nothing', async () => {
    const { server, data } = setup({ providers: [anthropic, openai] })
    expect((await server.inject({ method: 'GET', url: '/dashboard/provider-tests' })).json()).toEqual({ ok: 1, failed: 0, unconfigured: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
    await server.inject({ method: 'GET', url: '/dashboard/provider-tests' })
    expect(fetchMock).toHaveBeenCalledTimes(1) // session cache

    data.providerChecksEnabled = false
    data.providers = [{ ...anthropic, id: 'anthropic-2' }]
    fetchMock.mockClear()
    expect((await server.inject({ method: 'GET', url: '/dashboard/provider-tests' })).json()).toEqual({ ok: 0, failed: 0, unconfigured: 0 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('POST /runtime/providers/:id/test: opt-out answers unknown, force probes live', async () => {
    const { server } = setup({ providers: [anthropic], providerChecksEnabled: false })
    expect((await server.inject({ method: 'POST', url: '/runtime/providers/anthropic/test', payload: {} })).json()).toEqual({ status: 'unknown' })
    expect(fetchMock).not.toHaveBeenCalled()
    fetchMock.mockResolvedValueOnce({ ok: false })
    expect((await server.inject({ method: 'POST', url: '/runtime/providers/anthropic/test', payload: { force: true } })).json()).toEqual({ status: 'failed' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect((await server.inject({ method: 'POST', url: '/runtime/providers/missing/test', payload: {} })).json()).toEqual({ status: 'unconfigured' })
    expect((await server.inject({ method: 'POST', url: '/runtime/providers/anthropic/test', payload: { force: 'yes' } })).statusCode).toBe(400)
  })
})

describe('tool catalog and token usage', () => {
  it('GET /runtime/tools/descriptions is the built-in catalog with the runtime stubs', async () => {
    const { server } = setup()
    const res = await server.inject({ method: 'GET', url: '/runtime/tools/descriptions' })
    expect(res.statusCode).toBe(200)
    const builtIns = new ToolRegistry()
    registerBuiltInTools(builtIns)
    const reference = buildToolDescriptions([builtIns], { codeSandboxService: new CodeSandboxService(), sandboxPackagesService: new SandboxPackagesService() })
    expect(res.json()).toEqual(JSON.parse(JSON.stringify(reference)))
    expect(res.json()).toHaveProperty('sys_code')
  })

  it('DELETE /runtime/usage clears the ledger', async () => {
    const { server } = setup()
    const clear = vi.spyOn(getTokenUsageService(), 'clearAll')
    expect((await server.inject({ method: 'DELETE', url: '/runtime/usage' })).json()).toEqual({ success: true })
    expect(clear).toHaveBeenCalled()
  })
})
