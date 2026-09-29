// Partial / older-daemon GET /runtime responses must not crash the Fleet view.
import React from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Text } from 'ink'
import { App } from '../../src/main/tui/app/App'
import { createTheme } from '../../src/main/tui/app/theme'
import { DaemonClient } from '../../src/main/tui/api/client'
import { normalizeRuntime } from '../../src/main/tui/api/normalize'
import { createTuiStore, type TuiStore } from '../../src/main/tui/state/store'
import fleet from '../../src/main/tui/views/fleet/index'
import type { ViewDefinition } from '../../src/main/tui/views/types'
import { startMockDaemon, type MockDaemon } from './fixtures/mock-daemon'
import { renderTui, type RenderedTui } from './fixtures/render'

describe('normalizeRuntime', () => {
  it('fills every section the views read', () => {
    const rt = normalizeRuntime({ daemon: { pid: 7, uptime: 3 }, providers: {}, network: {} })
    expect(rt.providers.providers).toEqual([])
    expect(rt.network.agents).toEqual([])
    expect(rt.network.websocket.activeConnections).toBe(0)
    expect(rt.network.mesh.status).toBeNull()
    expect(rt.daemon.pid).toBe(7)
    expect(rt.agents).toEqual([])
    expect(rt.compute).toBeNull()
  })
  it('survives garbage', () => {
    for (const raw of [null, undefined, 'x', [], 42]) {
      const rt = normalizeRuntime(raw)
      expect(rt.providers.providers).toEqual([])
      expect(rt.daemon.pid).toBe(0)
    }
  })
  it('keeps real data', () => {
    const rt = normalizeRuntime({ providers: { providers: [{ id: 'p', hasApiKey: true }] }, network: { agents: [{ agentId: 'a' }], mesh: { enabledSetting: true, port: 1 } } })
    expect(rt.providers.providers).toHaveLength(1)
    expect(rt.network.agents).toHaveLength(1)
    expect(rt.network.mesh.enabledSetting).toBe(true)
  })
})

const chatStub: ViewDefinition = { id: 'chat', title: 'Chat', key: '2', component: () => <Text>CHAT-STUB</Text> }

let mock: MockDaemon
let store: TuiStore
let ui: RenderedTui | null = null

beforeEach(async () => { mock = await startMockDaemon({ stepMs: 5 }) })
afterEach(async () => { ui?.unmount(); ui = null; store?.stop(); await mock.close() })

describe('Fleet with a partial runtime overview', () => {
  it('renders instead of crashing (providers: {}, network: {})', async () => {
    const base = globalThis.fetch.bind(globalThis)
    const partial: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      if ((init?.method ?? 'GET') === 'GET' && url.pathname === '/runtime') {
        return new Response(JSON.stringify({ daemon: { uptime: 60, pid: 4242 }, settings: {}, providers: {}, auth: {}, mcp: {}, adapters: {}, network: {}, compute: null, agents: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return base(input, init)
    }
    store = createTuiStore({ client: new DaemonClient({ baseUrl: mock.url, fetch: partial }) })
    ui = renderTui(<App store={store} theme={createTheme({ mono: true })} views={[fleet, chatStub]} builtins={[]} />, { columns: 130, rows: 34 })
    await store.start()
    const frame = await ui.waitFor(f => f.includes('pid 4242'), 4000)
    expect(frame).toContain('providers 0')
    expect(frame).not.toMatch(/Cannot read properties/)
  })
})
