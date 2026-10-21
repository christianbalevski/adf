/**
 * Multi-runtime routing that happens in effects (docs/design/multi-runtime.md
 * §4.1, §6.3): what a page reads when it mounts goes to the runtime it shows.
 * Each window runtime has a recording surface; the effects of a static render
 * run inline, so their calls can be counted per runtime.
 *
 * - Settings: the runtime pages (providers, MCP, channels, usage, templates)
 *   under a SettingsRuntimeProvider reach the picked runtime's surface only.
 * - C4: a remote agent's Config panel reads that runtime's settings, tools
 *   and models, not the cached ones of another runtime.
 * - C1: a reloaded main window reopens its open agent on the runtime main
 *   names.
 */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionsView, RuntimeView } from '../../../src/shared/types/connection.types'

;(globalThis as { React?: typeof React }).React = React

vi.mock('zustand', async (importOriginal) => {
  const z = await importOriginal<typeof import('zustand')>()
  const create = ((init: Parameters<typeof z.createStore>[0]) => {
    const api = z.createStore(init)
    api.getInitialState = api.getState
    const hook = (selector?: (s: unknown) => unknown) => z.useStore(api, selector as never)
    return Object.assign(hook, api)
  }) as unknown as typeof z.create
  return { ...z, create }
})

/** Which effects run inline: all of them, or those whose source matches. */
const effects = vi.hoisted(() => ({ match: null as RegExp | null, errors: [] as unknown[] }))
vi.mock('react', async (importOriginal) => {
  const r = await importOriginal<typeof import('react')>()
  const inline = ((fn: () => unknown) => {
    if (effects.match && !effects.match.test(String(fn))) return
    // After the render, as a mounted page runs them: a state update then changes nothing.
    queueMicrotask(() => { try { fn() } catch (err) { effects.errors.push(err) } })
  }) as typeof r.useEffect
  return { ...r, default: { ...r, useEffect: inline, useLayoutEffect: inline }, useEffect: inline, useLayoutEffect: inline }
})

const HOST_1 = 'remote:host-1'
const LOCAL: RuntimeView = { id: 'local', kind: 'local', name: 'host-0 (Local)', url: null, state: 'connected' }
const REMOTE: RuntimeView = { id: HOST_1, kind: 'remote', name: 'host-1', url: 'https://host-1.example:7386', state: 'connected' }
const PATH = '/srv/agents/agent-1.adf'
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function view(runtimes?: RuntimeView[]): ConnectionsView {
  return { current: { id: 'local', kind: 'local', name: 'host-0 (Local)', url: null, state: 'connected' }, next: null, rows: [], discovery: null, ...(runtimes ? { runtimes } : {}) }
}

interface Surface { api: Record<string, unknown>; names: () => string[] }

/** A recording surface: `impl` answers; anything else never answers, a subscription is a no-op. */
function surface(runtimeId: string | undefined, impl: Record<string, unknown>): Surface {
  const calls: string[] = []
  const api = new Proxy(impl, {
    get: (target, p) => {
      if (typeof p !== 'string' || p === 'then') return undefined
      if (p === 'runtimeId') return runtimeId
      if (p in target) {
        const v = target[p]
        return typeof v === 'function' ? (...args: unknown[]) => { calls.push(p); return (v as (...a: unknown[]) => unknown)(...args) } : v
      }
      return () => { calls.push(p); return p.startsWith('on') ? () => {} : new Promise(() => {}) }
    },
  })
  return { api, names: () => calls.filter((n) => n !== 'runtime') }
}

async function page(runtimes: RuntimeView[], opts: { local?: Record<string, unknown>; remote?: Record<string, unknown>; match?: RegExp | null } = {}) {
  vi.resetModules()
  effects.match = opts.match ?? null
  effects.errors = []
  const bind = (id: string) => (id === HOST_1 ? remote.api : local.api)
  const remote = surface(HOST_1, { platform: 'linux', runtime: bind, ...opts.remote })
  const local = surface(undefined, { platform: 'linux', runtime: bind, ...opts.local })
  const noop = () => {}
  vi.stubGlobal('window', {
    location: { search: '?agentWindows=1' }, adfApi: local.api, addEventListener: noop, removeEventListener: noop,
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop }),
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: noop, requestAnimationFrame: () => 0, cancelAnimationFrame: noop,
  })
  vi.stubGlobal('document', { title: 'ADF Studio', addEventListener: noop, removeEventListener: noop, getElementById: () => null, querySelector: () => null, documentElement: { classList: { contains: () => false, add: noop, remove: noop, toggle: noop }, style: { setProperty: noop } }, body: { classList: { add: noop, remove: noop } } })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: noop, removeItem: noop })
  vi.stubGlobal('setInterval', () => 0)
  const { useConnectionStore } = await import('../../../src/renderer/stores/connection.store')
  await import('../../../src/renderer/stores/runtimes.store')
  useConnectionStore.getState().setView(view(runtimes))
  return { local, remote }
}

afterEach(() => { vi.unstubAllGlobals() })

/** The runtime Settings pages, each as Settings renders it for the picked runtime. */
const PAGES: Array<{ name: string; render: () => Promise<React.ReactElement> }> = [
  { name: 'providers', render: async () => { const { ProviderAgentOverrides } = await import('../../../src/renderer/components/providers/ProviderAgentOverrides'); return <ProviderAgentOverrides provider={{ id: 'p-1', type: 'openai', name: 'p-1', baseUrl: '', apiKey: '', defaultModel: 'model-1' } as never} apiKeyPlaceholder="" /> } },
  { name: 'mcp', render: async () => { const { McpStatusDashboard } = await import('../../../src/renderer/components/mcp/McpStatusDashboard'); return <McpStatusDashboard mcpServers={[]} onServersChanged={() => {}} /> } },
  { name: 'channels', render: async () => { const { ChannelsPanel } = await import('../../../src/renderer/components/adapters/ChannelsPanel'); return <ChannelsPanel adapters={[]} onAdaptersChanged={() => {}} /> } },
  { name: 'usage', render: async () => { const { TokenUsageSection } = await import('../../../src/renderer/components/settings/UsageSection'); return <TokenUsageSection /> } },
  { name: 'templates', render: async () => { const { AgentTemplatesTab } = await import('../../../src/renderer/components/settings/AgentTemplatesTab'); return <AgentTemplatesTab providers={[]} defaultProviderId={undefined} onOpenProviders={() => {}} /> } },
]

describe('Settings runtime pages reach the picked runtime (§6.3)', () => {
  for (const { name, render } of PAGES) {
    it(`${name}: host-1 picked, every read goes to host-1; This computer picked, to This computer`, async () => {
      const calls = async (runtimeId: string) => {
        const { local, remote } = await page([LOCAL, REMOTE])
        const { SettingsRuntimeProvider } = await import('../../../src/renderer/components/settings/settings-runtime')
        const element = await render()
        renderToStaticMarkup(<SettingsRuntimeProvider runtimeId={runtimeId}>{element}</SettingsRuntimeProvider>)
        await flush()
        return { local: local.names(), remote: remote.names() }
      }
      const onHost = await calls(HOST_1)
      // host-1 picked: everything the page reads is read on host-1, nothing on This computer.
      expect(onHost.remote.length).toBeGreaterThan(0)
      expect(onHost.local).toEqual([])
      // This computer picked: the same reads, all on This computer.
      const onLocal = await calls('local')
      expect(onLocal.remote).toEqual([])
      expect([...new Set(onLocal.local)].sort()).toEqual([...new Set(onHost.remote)].sort())
    }, 30_000)
  }
})

describe('C4: a remote agent\'s Config panel', () => {
  const settings = (provider: string) => async () => ({ providers: [{ id: provider }], mcpServers: [], adapters: [], compute: {} })

  it('reads the open agent\'s runtime\'s settings and tools, not those another runtime\'s agent cached', async () => {
    const { local, remote } = await page([LOCAL, REMOTE], {
      match: /getToolDescriptions|hostApprovedSources/,
      local: { getSettings: settings('p-local'), getToolDescriptions: async () => ({ fs_read: 'This computer' }) },
      remote: { getSettings: settings('p-host-1'), getToolDescriptions: async () => ({ fs_read: 'host-1' }) },
    })
    const { useDocumentStore } = await import('../../../src/renderer/stores/document.store')
    const { AgentConfig } = await import('../../../src/renderer/components/agent/AgentConfig')
    useDocumentStore.getState().setFilePath('/agents/agent-2.adf')
    renderToStaticMarkup(<AgentConfig />)
    await flush()
    const count = (names: string[], n: string) => names.filter((x) => x === n).length
    expect([count(local.names(), 'getSettings'), count(local.names(), 'getToolDescriptions')]).toEqual([2, 1])
    useDocumentStore.getState().setFilePath(PATH, HOST_1)
    renderToStaticMarkup(<AgentConfig />)
    await flush()
    expect([count(remote.names(), 'getSettings'), count(remote.names(), 'getToolDescriptions')]).toEqual([2, 1])
    // Back on This computer's agent: its own cache, no new read of providers or tools.
    useDocumentStore.getState().setFilePath('/agents/agent-2.adf', 'local')
    renderToStaticMarkup(<AgentConfig />)
    await flush()
    expect([count(local.names(), 'getSettings'), count(local.names(), 'getToolDescriptions')]).toEqual([3, 1])
  }, 30_000)

  it('lists a provider\'s models on the open agent\'s runtime, each runtime with its own cache', async () => {
    const { local, remote } = await page([LOCAL, REMOTE], {
      local: { listModels: async () => ({ models: ['model-local'] }) },
      remote: { listModels: async () => ({ models: ['model-host-1'] }) },
    })
    const { useDocumentStore } = await import('../../../src/renderer/stores/document.store')
    const { loadProviderModels } = await import('../../../src/renderer/hooks/useProviderModels')
    expect(await loadProviderModels('p-1')).toEqual({ models: ['model-local'] })
    useDocumentStore.getState().setFilePath(PATH, HOST_1)
    expect(await loadProviderModels('p-1')).toEqual({ models: ['model-host-1'] })
    expect([local.names(), remote.names()]).toEqual([['listModels'], ['listModels']])
  })
})

describe('C1: a reloaded main window', () => {
  it('reopens its open agent on the runtime main names; with none named, on This computer as before', async () => {
    const files = {
      openFile: async (filePath: string) => ({ success: true, filePath }),
      getBatch: async () => ({ document: '', agentConfig: null, statusText: '', chat: { uiLog: [] } }),
      readInternalFile: async () => null,
      checkAgentReview: async () => ({ needsReview: false }),
    }
    const reload = async (session: Record<string, unknown>) => {
      const { local, remote } = await page([LOCAL, REMOTE], { match: /getCurrentFile/, local: { ...files, getCurrentFile: async () => session }, remote: files })
      const { default: App } = await import('../../../src/renderer/App')
      renderToStaticMarkup(<App />)
      for (let i = 0; i < 5; i++) await flush()
      const { useDocumentStore } = await import('../../../src/renderer/stores/document.store')
      return { local: local.names(), remote: remote.names(), doc: useDocumentStore.getState() }
    }
    const remoteOpen = await reload({ filePath: PATH, agentRunning: false, runtimeId: HOST_1 })
    expect(remoteOpen.remote).toContain('openFile')
    expect(remoteOpen.local).not.toContain('openFile')
    expect(remoteOpen.doc).toMatchObject({ filePath: PATH, runtimeId: HOST_1 })
    const localOpen = await reload({ filePath: '/agents/agent-2.adf', agentRunning: false })
    expect(localOpen.local).toContain('openFile')
    expect(localOpen.remote).toEqual([])
    expect(localOpen.doc).toMatchObject({ filePath: '/agents/agent-2.adf', runtimeId: 'local' })
  }, 60_000)
})
