// Characterization of Studio's home-dashboard slices and provider connection
// checks (DASHBOARD_QUICK_STATS, DASHBOARD_PROVIDER_TESTS,
// DASHBOARD_AGENT_STATS, PROVIDER_TEST and the autoProviderCheck /
// testProviderCredentialsForDashboard helpers in ipc/index.ts), written
// against that code before it moved into services/provider-checks.ts and
// services/dashboard-stats.ts (rule E1). The daemon's dashboard routes call
// the same functions.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => ({ chatgpt: false, grok: true, claude: false }))
vi.mock('../../../src/main/providers/chatgpt-subscription/auth-manager', () => ({ getChatGptAuthManager: () => ({ isAuthenticated: () => auth.chatgpt }) }))
vi.mock('../../../src/main/providers/grok-subscription/auth-manager', () => ({ getGrokAuthManager: () => ({ isAuthenticated: () => auth.grok }) }))
vi.mock('../../../src/main/providers/claude-subscription/auth-manager', () => ({ getClaudeAuthManager: () => ({ isAuthenticated: async () => auth.claude }) }))

import { ProviderChecks } from '../../../src/main/services/provider-checks'
import { buildAgentStats, buildQuickStats, runDashboardProviderTests, testProviderById } from '../../../src/main/services/dashboard-stats'
import type { ProviderConfig } from '../../../src/shared/types/ipc.types'

const fetchMock = vi.fn()
beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { vi.unstubAllGlobals() })

const anthropic: ProviderConfig = { id: 'anthropic', type: 'anthropic', name: 'Anthropic', baseUrl: '', apiKey: 'sk-ant-1' }
const openai: ProviderConfig = { id: 'openai', type: 'openai', name: 'OpenAI', baseUrl: '' }
const local: ProviderConfig = { id: 'custom:ab12cd', type: 'openai-compatible', name: 'Local', baseUrl: 'http://127.0.0.1:1/v1/' }
const router: ProviderConfig = { id: 'openrouter', type: 'openrouter', name: 'OpenRouter', baseUrl: '', apiKey: 'or-1' }
const grok: ProviderConfig = { id: 'grok', type: 'grok-subscription', name: 'Grok', baseUrl: '' }
const chatgpt: ProviderConfig = { id: 'chatgpt', type: 'chatgpt-subscription', name: 'ChatGPT', baseUrl: '' }

describe('ProviderChecks', () => {
  it('probes /models per provider type, with a 5 s timeout, and caches per session', async () => {
    fetchMock.mockImplementation(async (url: string) => ({ ok: !String(url).includes('127.0.0.1') }))
    const checks = new ProviderChecks({ isEnabled: () => true })

    expect(await checks.test(anthropic)).toBe('ok')
    expect(fetchMock).toHaveBeenLastCalledWith('https://api.anthropic.com/v1/models', expect.objectContaining({
      headers: { 'x-api-key': 'sk-ant-1', 'anthropic-version': '2023-06-01' }, signal: expect.any(AbortSignal),
    }))
    expect(await checks.test(router)).toBe('ok')
    expect(fetchMock).toHaveBeenLastCalledWith('https://openrouter.ai/api/v1/models', expect.objectContaining({ headers: { Authorization: 'Bearer or-1' } }))
    expect(await checks.test(local)).toBe('failed')
    expect(fetchMock).toHaveBeenLastCalledWith('http://127.0.0.1:1/v1/models', expect.objectContaining({ headers: { 'Content-Type': 'application/json' } }))
    expect(await checks.test(openai)).toBe('unconfigured')
    expect(await checks.test(grok)).toBe('ok')
    expect(await checks.test(chatgpt)).toBe('unconfigured')

    const calls = fetchMock.mock.calls.length
    expect(await checks.test(anthropic)).toBe('ok')
    expect(fetchMock.mock.calls.length).toBe(calls) // cached
    expect(await checks.test(anthropic, true)).toBe('ok')
    expect(fetchMock.mock.calls.length).toBe(calls + 1) // force re-probes
    expect(await checks.test({ ...anthropic, apiKey: undefined })).toBe('unconfigured') // key presence is part of the cache key
  })

  it('a network error is failed; the opt-out serves the cache or unchecked without a request', async () => {
    fetchMock.mockRejectedValue(new Error('offline'))
    let enabled = true
    const checks = new ProviderChecks({ isEnabled: () => enabled })
    expect(await checks.autoCheck(anthropic)).toBe('failed')
    enabled = false
    fetchMock.mockClear()
    expect(await checks.autoCheck(anthropic)).toBe('failed')
    expect(await checks.autoCheck(router)).toBe('unchecked')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('dashboard slices', () => {
  it('provider tests count ok / failed / unconfigured; unchecked counts nowhere', async () => {
    fetchMock.mockResolvedValue({ ok: true })
    const checks = new ProviderChecks({ isEnabled: () => true })
    expect(await runDashboardProviderTests([anthropic, openai, grok, chatgpt], checks)).toEqual({ ok: 2, failed: 0, unconfigured: 2 })
    const off = new ProviderChecks({ isEnabled: () => false })
    expect(await runDashboardProviderTests([anthropic], off)).toEqual({ ok: 0, failed: 0, unconfigured: 0 })
  })

  it('PROVIDER_TEST: unknown id is unconfigured, force probes live, otherwise the opt-out applies', async () => {
    fetchMock.mockResolvedValue({ ok: true })
    const checks = new ProviderChecks({ isEnabled: () => false })
    expect(await testProviderById([anthropic], 'missing', false, checks)).toEqual({ status: 'unconfigured' })
    expect(await testProviderById([anthropic], 'anthropic', false, checks)).toEqual({ status: 'unknown' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await testProviderById([anthropic], 'anthropic', true, checks)).toEqual({ status: 'ok' })
    expect(await testProviderById([anthropic], 'anthropic', false, checks)).toEqual({ status: 'ok' }) // now cached
  })

  it('quick stats read settings and the services', () => {
    const settings: Record<string, unknown> = {
      providers: [anthropic, openai],
      mcpServers: [{ name: 'a' }],
      adapters: [{ type: 'telegram' }, { type: 'telegram' }, { type: 'email' }, {}],
      compute: { hostAccessEnabled: true },
    }
    const tokens = { totalTokens: 10 }
    expect(buildQuickStats({ get: (k) => settings[k], installedPackageCount: () => 3, tokenSummary: () => tokens })).toEqual({
      providers: { total: 2 },
      mcp: { configured: 1 },
      adapters: { configured: 4, types: ['telegram', 'email'] },
      packages: { total: 3 },
      hostAccess: { enabledGlobally: true },
      tokens,
    })
    expect(buildQuickStats({ get: () => undefined, installedPackageCount: () => 0, tokenSummary: () => tokens })).toEqual({
      providers: { total: 0 }, mcp: { configured: 0 }, adapters: { configured: 0, types: [] }, packages: { total: 0 }, hostAccess: { enabledGlobally: false }, tokens,
    })
  })

  describe('agent stats', () => {
    let dir: string
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'adf-dash-stats-')) })
    afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

    it('counts unique files (by realpath) across tracked dirs, with depth 5', async () => {
      const a = join(dir, 'a')
      mkdirSync(a)
      const files: Record<string, { autostart: boolean; autonomous: boolean; hostAccess: boolean } | null> = {
        [join(a, 'agent-1.adf')]: { autostart: true, autonomous: true, hostAccess: false },
        [join(a, 'agent-2.adf')]: { autostart: false, autonomous: true, hostAccess: true },
        [join(a, 'agent-3.adf')]: null,
      }
      const listed: Array<[string, number]> = []
      const result = await buildAgentStats([a, a], {
        listAdfFiles: async (root, depth) => { listed.push([root, depth]); return Object.keys(files) },
        peekMeta: (fp) => files[fp] ?? null,
      })
      expect(listed).toEqual([[a, 5], [a, 5]])
      expect(result).toEqual({ total: 3, autostart: 1, autonomous: 2, hostAccessAgents: 1 })
    })
  })
})
