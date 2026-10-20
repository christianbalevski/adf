/**
 * Multi-runtime phase 3 in the renderer (docs/design/multi-runtime.md §6.2,
 * §6.3, §6.5, §9.3): the status bar's runtime groups and their Kill, the
 * Settings runtime picker, the Add dialog, and This computer only exactly as
 * before (no runtime name, picker or group).
 *
 * No jsdom: components render to static markup (effects do not run, so no
 * IPC is made).
 */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionsView, RuntimeView } from '../../../src/shared/types/connection.types'

;(globalThis as { React?: typeof React }).React = React

// A static render reads a zustand store's server snapshot, its initial state; here, the state the test set.
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

const HOST_1 = 'remote:host-1'
const HOST_2 = 'remote:host-2'
const LOCAL: RuntimeView = { id: 'local', kind: 'local', name: 'This computer', url: null, state: 'connected' }
const REMOTE: RuntimeView = { id: HOST_1, kind: 'remote', name: 'host-1', url: 'https://host-1.example:7386', state: 'connected' }
const REMOTE_2: RuntimeView = { id: HOST_2, kind: 'remote', name: 'host-2', url: 'https://host-2.example:7386', state: 'retrying' }

function view(runtimes?: RuntimeView[]): ConnectionsView {
  return { current: { id: 'local', kind: 'local', name: 'This computer', url: null, state: 'connected' }, next: null, rows: [], discovery: null, ...(runtimes ? { runtimes } : {}) }
}

/** A fresh page with the runtime set; `search` is the page query (an agent window's). */
async function page(runtimes: RuntimeView[] | undefined, opts: { search?: string; adfApi?: Record<string, unknown> } = {}) {
  vi.resetModules()
  vi.stubGlobal('window', { location: { search: opts.search ?? '?agentWindows=1' }, adfApi: { platform: 'linux', ...opts.adfApi }, addEventListener: () => {}, removeEventListener: () => {} })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  const { useConnectionStore } = await import('../../../src/renderer/stores/connection.store')
  await import('../../../src/renderer/stores/runtimes.store')
  useConnectionStore.getState().setView(view(runtimes))
  return {
    statusBar: async () => {
      const { StatusBar } = await import('../../../src/renderer/components/layout/StatusBar')
      return renderToStaticMarkup(<StatusBar />)
    },
  }
}

afterEach(() => { vi.unstubAllGlobals() })

/** The runtime groups of a status bar, in order: [id, text]. */
const groups = (html: string) => [...html.matchAll(/data-runtime-group="([^"]*)"/g)].map((m) => m[1])

describe('status bar (§6.2)', () => {
  it('This computer only: one group without a name or id, the markup of no runtime list at all', async () => {
    const none = await (await page(undefined)).statusBar()
    const one = await (await page([LOCAL])).statusBar()
    expect(one).toBe(none)
    expect(groups(one)).toEqual(['true'])
    expect(one).not.toContain('This computer')
    expect(one).not.toContain('Runtimes')
    expect(one).toContain('aria-label="Kill: nothing running"')
  })

  it('more than one runtime: one group per runtime, This computer first, each named, with its own Mesh and Kill', async () => {
    const html = await (await page([LOCAL, REMOTE, REMOTE_2])).statusBar()
    expect(groups(html)).toEqual(['local', HOST_1, HOST_2])
    expect(html).toContain('aria-label="Runtime: This computer"')
    expect(html).toContain('aria-label="Runtime: host-1"')
    expect(html).toContain('title="https://host-1.example:7386"')
    // A runtime that is down: its state, and its Kill disabled with the state as tooltip.
    expect(html).toContain('aria-label="Runtime: host-2 · Not connected, retrying"')
    expect(html).toContain('aria-label="Kill on host-2: Not connected, retrying"')
    expect(html).toContain('aria-label="Kill on This computer: nothing running"')
    expect(html.match(/>Kill</g)).toHaveLength(3)
    expect(html.match(/Mesh off/g)?.length).toBeGreaterThanOrEqual(3)
  })

  it('Kill names the runtime it stops once something runs there', async () => {
    await page([LOCAL, REMOTE])
    const { useMeshStore } = await import('../../../src/renderer/stores/mesh.store')
    useMeshStore.getState().setEnabled(true, HOST_1)
    const { StatusBar } = await import('../../../src/renderer/components/layout/StatusBar')
    const html = renderToStaticMarkup(<StatusBar />)
    expect(html).toContain('aria-label="Stops all agents and mesh on host-1"')
    expect(html).toContain('aria-label="Kill on This computer: nothing running"')
  })

  it('an agent window shows its own runtime\'s group only', async () => {
    const html = await (await page([LOCAL, REMOTE], { search: '?window=agent&runtime=remote%3Ahost-1&file=%2Fsrv%2Fagents%2Fagent-1.adf' })).statusBar()
    expect(groups(html)).toEqual([HOST_1])
  })

  it('the groups fold into Runtimes when they do not fit, and unfold once the bar is that wide again', async () => {
    const { foldRuntimeGroups } = await import('../../../src/renderer/components/layout/StatusBar')
    const inline = { folded: false, needed: 0 }
    expect(foldRuntimeGroups(inline, { scrollWidth: 900, clientWidth: 900 })).toBe(inline)
    const folded = foldRuntimeGroups(inline, { scrollWidth: 1200, clientWidth: 900 })
    expect(folded).toEqual({ folded: true, needed: 1200 })
    expect(foldRuntimeGroups(folded, { scrollWidth: 900, clientWidth: 1100 })).toBe(folded)
    expect(foldRuntimeGroups(folded, { scrollWidth: 1200, clientWidth: 1200 })).toEqual({ folded: false, needed: 0 })
  })
})

describe('Settings runtime picker (§6.3)', () => {
  it('opens on a requested runtime, else the open agent\'s, else This computer; always one of the set', async () => {
    await page([LOCAL, REMOTE])
    const { initialSettingsRuntime, requestSettingsRuntime } = await import('../../../src/renderer/stores/settings-runtime.store')
    const { useDocumentStore } = await import('../../../src/renderer/stores/document.store')
    expect(initialSettingsRuntime()).toBe('local')
    useDocumentStore.setState({ filePath: '/srv/agents/agent-1.adf', runtimeId: HOST_1 })
    expect(initialSettingsRuntime()).toBe(HOST_1)
    requestSettingsRuntime('local')
    expect(initialSettingsRuntime()).toBe('local')
    // A request is used once.
    expect(initialSettingsRuntime()).toBe(HOST_1)
    requestSettingsRuntime('remote:gone')
    expect(initialSettingsRuntime()).toBe(HOST_1)
  })

  it('runtime pages reach the picked runtime\'s surface; outside Settings, window.adfApi', async () => {
    const bound: string[] = []
    await page([LOCAL, REMOTE], { adfApi: { runtime: (id: string) => { bound.push(id); return { runtimeId: id } } } })
    const { SettingsRuntimeProvider, useSettingsApi } = await import('../../../src/renderer/components/settings/settings-runtime')
    const seen: unknown[] = []
    const Probe = () => { seen.push(useSettingsApi()); return null }
    renderToStaticMarkup(<Probe />)
    renderToStaticMarkup(<SettingsRuntimeProvider runtimeId="local"><Probe /></SettingsRuntimeProvider>)
    renderToStaticMarkup(<SettingsRuntimeProvider runtimeId={HOST_1}><Probe /></SettingsRuntimeProvider>)
    renderToStaticMarkup(<SettingsRuntimeProvider runtimeId={HOST_1}><Probe /></SettingsRuntimeProvider>)
    const api = (window as unknown as { adfApi: unknown }).adfApi
    expect(seen[0]).toBe(api)
    expect(seen[1]).toBe(api)
    expect(seen[2]).toEqual({ runtimeId: HOST_1 })
    // One surface per runtime: the same object every time.
    expect(seen[3]).toBe(seen[2])
    expect(bound).toEqual([HOST_1])
  })

  it('a settings write goes to the surface it is given', async () => {
    await page([LOCAL, REMOTE])
    const { writeSettings } = await import('../../../src/renderer/components/settings/settings-save')
    const patches: unknown[] = []
    expect(await writeSettings({ meshPort: 7300 }, { setSettings: async (p) => { patches.push(p); return { success: true } } })).toEqual({ ok: true })
    expect(patches).toEqual([{ meshPort: 7300 }])
  })

  it('the Settings sidebar: a Runtime picker over the runtime pages with more than one runtime; none with This computer only', async () => {
    const render = async (runtimes: RuntimeView[]) => {
      await page(runtimes, { adfApi: { runtime: (id: string) => ({ runtimeId: id }) } })
      const { SettingsPage } = await import('../../../src/renderer/components/settings/SettingsPage')
      return renderToStaticMarkup(<SettingsPage />)
    }
    const one = await render([LOCAL])
    expect(one).not.toContain('data-runtime-picker')
    expect(one).not.toContain('aria-label="Runtime"')
    const two = await render([LOCAL, REMOTE_2])
    expect(two).toContain('data-runtime-picker')
    expect(two).toContain('aria-label="Runtime"')
    expect(two).toContain('>This computer</option>')
    expect(two).toContain('>host-2 · Not connected, retrying</option>')
    // Studio pages come first, unaffected by the picker.
    expect(two.indexOf('data-settings-scope="studio"')).toBeLessThan(two.indexOf('data-runtime-picker'))
    // Settings is a large module: imported twice, fresh, under a loaded run.
  }, 60_000)
})

describe('Connections: Add (§6.5)', () => {
  it('one dialog titled Add; on a found computer it shows that computer and its address', async () => {
    await page([LOCAL, REMOTE])
    const { AddConnectionDialog, foundMismatchMessage } = await import('../../../src/renderer/components/settings/ConnectionSettings')
    const found = { name: 'desk', url: 'http://192.168.1.44:7385', address: '192.168.1.44', fingerprint: 'NEWW-2345', encrypted: false }
    const html = renderToStaticMarkup(<AddConnectionDialog onClose={() => {}} found={found} />)
    expect(html).toContain('>Add</h2>')
    expect(html).toContain('desk at 192.168.1.44, fingerprint NEWW-2345.')
    expect(html).toContain('value="http://192.168.1.44:7385"')
    expect(html).not.toContain('Add connection')
    expect(html).not.toContain('>Connect<')
    expect(foundMismatchMessage(found, 'EVIL-0001')).toBe('192.168.1.44 now answers as another computer (EVIL-0001). Add it from the list again.')
  })
})

describe('a runtime that leaves the set (§3.3)', () => {
  it('the main window\'s open agent on it closes; one on This computer stays', async () => {
    await page([LOCAL, REMOTE], { adfApi: { runtime: (id: string) => ({ runtimeId: id, onTrackedDirsChanged: () => () => {}, onBackgroundAgentEvents: () => () => {}, onMeshEvent: () => () => {}, onFileRenamed: () => () => {} }) } })
    const { syncRuntimeFeeds } = await import('../../../src/renderer/hooks/useRuntimeFeeds')
    const { useDocumentStore } = await import('../../../src/renderer/stores/document.store')
    syncRuntimeFeeds([LOCAL, { ...REMOTE, state: 'retrying' }])
    useDocumentStore.setState({ filePath: '/srv/agents/agent-1.adf', runtimeId: HOST_1 })
    syncRuntimeFeeds([LOCAL])
    expect(useDocumentStore.getState().filePath).toBeNull()
    useDocumentStore.setState({ filePath: '/agents/agent-1.adf', runtimeId: 'local' })
    syncRuntimeFeeds([LOCAL])
    expect(useDocumentStore.getState().filePath).toBe('/agents/agent-1.adf')
  })
})
