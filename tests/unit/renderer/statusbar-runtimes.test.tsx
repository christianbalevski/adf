/**
 * The status bar with more than one runtime (docs/design/multi-runtime.md
 * §6.2): one group, the runtime of the open agent, and the Runtimes arrow
 * whose popover lists every runtime with its state, Mesh and Kill, and Kill
 * all. And the runtime banner above the runtime Settings pages (§6.3).
 *
 * No jsdom: components render to static markup. Handlers are reached through
 * the elements a render creates (`capture`), never through a DOM. The
 * popover's portal renders in place.
 */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
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

// The server renderer has no portals: the popover renders where it is.
vi.mock('react-dom', async (importOriginal) => {
  const m = await importOriginal<typeof import('react-dom')>()
  return { ...m, default: { ...m, createPortal: (children: unknown) => children }, createPortal: (children: unknown) => children }
})

// The renderer's JSX compiles to jsxDEV: every element made goes through here, so a test can record them (`capture`).
const recorder = vi.hoisted(() => ({ on: null as ((type: unknown, props: Record<string, unknown>) => void) | null }))
vi.mock('react/jsx-dev-runtime', async (importOriginal) => {
  const m = await importOriginal<Record<string, unknown>>()
  const jsxDEV = (type: unknown, props: Record<string, unknown>, ...rest: unknown[]) => {
    recorder.on?.(type, props ?? {})
    return (m.jsxDEV as (...a: unknown[]) => unknown)(type, props, ...rest)
  }
  return { ...m, jsxDEV }
})

const HOST_1 = 'remote:host-1'
const HOST_2 = 'remote:host-2'
const LOCAL: RuntimeView = { id: 'local', kind: 'local', name: 'host-0 (Local)', url: null, state: 'connected' }
const REMOTE: RuntimeView = { id: HOST_1, kind: 'remote', name: 'host-1', url: 'https://host-1.example:7386', state: 'connected' }
const REMOTE_2: RuntimeView = { id: HOST_2, kind: 'remote', name: 'host-2', url: 'https://host-2.example:7386', state: 'connected' }
const PATH = '/srv/agents/agent-1.adf'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function view(runtimes?: RuntimeView[]): ConnectionsView {
  return { current: { id: 'local', kind: 'local', name: 'host-0 (Local)', url: null, state: 'connected' }, next: null, rows: [], discovery: null, ...(runtimes ? { runtimes } : {}) }
}

interface Surface { api: Record<string, unknown>; names: () => string[] }

/** A runtime's surface that records every call: `impl` answers; anything else never answers. */
function surface(runtimeId: string | undefined, impl: Record<string, unknown> = {}): Surface {
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

/** A fresh main window (`search`: an agent window's query) with the runtime set and a recording surface per runtime. */
async function page(runtimes: RuntimeView[] | undefined, opts: { search?: string; local?: Record<string, unknown>; remote?: Record<string, unknown>; remote2?: Record<string, unknown> } = {}) {
  vi.resetModules()
  const bind = (id: string) => (id === HOST_1 ? remote.api : id === HOST_2 ? remote2.api : local.api)
  const remote = surface(HOST_1, { platform: 'linux', runtime: bind, ...opts.remote })
  const remote2 = surface(HOST_2, { platform: 'linux', runtime: bind, ...opts.remote2 })
  const local = surface(undefined, { platform: 'linux', runtime: bind, ...opts.local })
  const own = opts.search?.includes('runtime=') ? remote : local
  vi.stubGlobal('window', { location: { search: opts.search ?? '?agentWindows=1' }, adfApi: own.api, addEventListener: () => {}, removeEventListener: () => {} })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  // The popover's portal target; the portal itself renders in place.
  vi.stubGlobal('document', { body: {} })
  const { useConnectionStore } = await import('../../../src/renderer/stores/connection.store')
  await import('../../../src/renderer/stores/runtimes.store')
  useConnectionStore.getState().setView(view(runtimes))
  const bar = await import('../../../src/renderer/components/layout/StatusBar')
  const { useDocumentStore } = await import('../../../src/renderer/stores/document.store')
  const { useMeshStore, selectMeshSlice } = await import('../../../src/renderer/stores/mesh.store')
  return { local, remote, remote2, bar, useDocumentStore, useMeshStore, selectMeshSlice }
}

type Element = { type: unknown; props: Record<string, unknown> }

/** Render, recording every element made: a handler is then called as the click would. */
function capture(render: () => string): { html: string; elements: Element[] } {
  const elements: Element[] = []
  recorder.on = (type, props) => { elements.push({ type, props }) }
  try {
    return { html: render(), elements }
  } finally {
    recorder.on = null
  }
}

const groups = (html: string) => [...html.matchAll(/data-runtime-group="([^"]*)"/g)].map((m) => m[1])
const rows = (html: string) => [...html.matchAll(/data-runtime-row="([^"]*)"/g)].map((m) => m[1])
const byLabel = (elements: Element[], label: string) => elements.find((e) => e.type === 'button' && e.props['aria-label'] === label)

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('one runtime group: the open agent\'s runtime', () => {
  it('follows the agent open in the main window; Local with none', async () => {
    const { bar, useDocumentStore } = await page([LOCAL, REMOTE, REMOTE_2])
    const render = () => renderToStaticMarkup(<bar.StatusBar />)
    expect(groups(render())).toEqual(['local'])
    useDocumentStore.getState().setFilePath(PATH, HOST_2)
    expect(groups(render())).toEqual([HOST_2])
    useDocumentStore.getState().setFilePath(PATH, HOST_1)
    expect(groups(render())).toEqual([HOST_1])
    useDocumentStore.getState().setFilePath(null as never)
    expect(groups(render())).toEqual(['local'])
  })

  it('an agent window: its own runtime, without the arrow', async () => {
    const { bar } = await page([LOCAL, REMOTE], { search: `?window=agent&runtime=${encodeURIComponent(HOST_1)}&file=${encodeURIComponent(PATH)}` })
    const html = renderToStaticMarkup(<bar.StatusBar />)
    expect(groups(html)).toEqual([HOST_1])
    expect(html).not.toContain('aria-label="Servers"')
  })

  it('the arrow: an icon button with the Servers tooltip that opens a menu', async () => {
    const { bar } = await page([LOCAL, REMOTE])
    const { Tooltip } = await import('../../../src/renderer/components/common/Tooltip')
    const { elements, html } = capture(() => renderToStaticMarkup(<bar.StatusBar />))
    expect(html).toContain('aria-haspopup="menu"')
    expect(html).toContain('aria-expanded="false"')
    expect(elements.some((e) => e.type === Tooltip && e.props.tip === 'Servers')).toBe(true)
    // Closed: no popover.
    expect(rows(html)).toEqual([])
  })
})

describe('the Servers popover', () => {
  const open = { x: 400, y: 600 }

  it('lists every runtime in the set\'s order with its name, state, Mesh and Kill, and Kill all on top', async () => {
    const { bar, useMeshStore } = await page([LOCAL, REMOTE, { ...REMOTE_2, state: 'retrying' }])
    useMeshStore.getState().setEnabled(true, HOST_1)
    const runtimes = [LOCAL, REMOTE, { ...REMOTE_2, state: 'retrying' as const }]
    const html = renderToStaticMarkup(<bar.RuntimesPopover runtimes={runtimes} position={open} onClose={() => {}} />)
    expect(html).toContain('role="menu"')
    expect(html).toContain('aria-label="Servers"')
    expect(rows(html)).toEqual(['local', HOST_1, HOST_2])
    expect(html.indexOf('data-kill-all')).toBeLessThan(html.indexOf('data-runtime-row'))
    const row = (id: string) => html.slice(html.indexOf(`data-runtime-row="${id}"`)).split('data-runtime-row=')[1]
    expect(row('local')).toContain('host-0 (Local)')
    expect(row('local')).not.toContain('data-remote-mark')
    expect(row('local')).toContain('Connected')
    expect(row('local')).toContain('Mesh off')
    expect(row('local')).toContain('aria-label="Kill on host-0 (Local): nothing running"')
    expect(row(HOST_1)).toContain('data-remote-mark')
    expect(row(HOST_1)).toContain('Mesh (0)')
    // Armed while its mesh runs.
    expect(row(HOST_1)).toContain('aria-label="Stops all agents and mesh on host-1"')
    expect(row(HOST_2)).toContain('Not connected, retrying')
    expect(row(HOST_2)).toContain('aria-label="Kill on host-2: Not connected, retrying"')
    expect(html).toContain('aria-label="Stops all agents and the mesh on every server"')
    expect(html.match(/role="menuitem"/g)).toHaveLength(4)
  })

  it('a row\'s Kill stops that runtime only, and its result shows in the row and in the bar\'s group', async () => {
    const stop = vi.fn(async () => ({ success: true, stoppedAgents: 2 }))
    const { bar, local, remote, useMeshStore, selectMeshSlice, useDocumentStore } = await page([LOCAL, REMOTE], { remote: { emergencyStop: stop } })
    useMeshStore.getState().setEnabled(true, HOST_1)
    const { elements } = capture(() => renderToStaticMarkup(<bar.RuntimesPopover runtimes={[LOCAL, REMOTE]} position={open} onClose={() => {}} />))
    await (byLabel(elements, 'Stops all agents and mesh on host-1')!.props.onClick as () => Promise<void>)()
    await flush()
    expect(remote.names()).toEqual(['emergencyStop'])
    expect(local.names()).not.toContain('emergencyStop')
    expect(selectMeshSlice(useMeshStore.getState(), HOST_1).enabled).toBe(false)
    const after = renderToStaticMarkup(<bar.RuntimesPopover runtimes={[LOCAL, REMOTE]} position={open} onClose={() => {}} />)
    expect(after).toContain('Stopped 2 agents · Mesh off')
    useDocumentStore.getState().setFilePath(PATH, HOST_1)
    expect(renderToStaticMarkup(<bar.StatusBar />)).toContain('Stopped 2 agents · Mesh off')
  })

  it('Kill all stops every runtime and says what it stopped', async () => {
    const { bar, local, remote, useMeshStore, selectMeshSlice } = await page([LOCAL, REMOTE], {
      local: { emergencyStop: vi.fn(async () => ({ success: true, stoppedAgents: 1 })) },
      remote: { emergencyStop: vi.fn(async () => ({ success: true, stoppedAgents: 2 })) },
    })
    useMeshStore.getState().setEnabled(true)
    useMeshStore.getState().setEnabled(true, HOST_1)
    const { elements } = capture(() => renderToStaticMarkup(<bar.RuntimesPopover runtimes={[LOCAL, REMOTE]} position={open} onClose={() => {}} />))
    ;(byLabel(elements, bar.KILL_ALL_TIP)!.props.onClick as () => void)()
    await flush()
    await flush()
    expect(local.names()).toEqual(['emergencyStop'])
    expect(remote.names()).toEqual(['emergencyStop'])
    expect(selectMeshSlice(useMeshStore.getState()).enabled).toBe(false)
    expect(selectMeshSlice(useMeshStore.getState(), HOST_1).enabled).toBe(false)
    expect(bar.useKillResultsStore.getState().results.all).toBe('Stopped 3 agents · Mesh off')
    const after = renderToStaticMarkup(<bar.RuntimesPopover runtimes={[LOCAL, REMOTE]} position={open} onClose={() => {}} />)
    expect(after).toContain('Stopped 3 agents · Mesh off')
    // Closed, the result shows beside the arrow.
    expect(renderToStaticMarkup(<bar.StatusBar />)).toContain('Stopped 3 agents · Mesh off')
  })

  it('Kill all names the runtimes it did not reach', async () => {
    const { bar, remote } = await page([LOCAL, REMOTE, REMOTE_2], {
      local: { emergencyStop: async () => ({ success: true, stoppedAgents: 0 }) },
      remote: { emergencyStop: async () => { throw new Error('host-1 is not connected') } },
    })
    const down = { ...REMOTE_2, state: 'not-connected' as const }
    expect(await bar.killAll([LOCAL, REMOTE, down])).toBe('Partial stop · Not reached: host-2, host-1')
    expect(remote.names()).toEqual(['emergencyStop'])
    expect(await bar.killAll([REMOTE])).toBe('Not stopped: host-1 is not connected')
  })

  it('Kill all with nothing running is disabled and says so', async () => {
    const { bar } = await page([LOCAL, REMOTE])
    const html = renderToStaticMarkup(<bar.RuntimesPopover runtimes={[LOCAL, REMOTE]} position={open} onClose={() => {}} />)
    expect(html).toMatch(/disabled="" aria-label="Kill all: nothing running"/)
  })

  it('Escape closes it and gives the focus back to the arrow', async () => {
    const { bar } = await page([LOCAL, REMOTE])
    const onClose = vi.fn()
    const arrow = { focus: vi.fn(), isConnected: true, contains: () => false }
    const { elements } = capture(() => renderToStaticMarkup(
      <bar.RuntimesPopover runtimes={[LOCAL, REMOTE]} position={open} onClose={onClose} anchor={{ current: arrow as never }} />,
    ))
    const menu = elements.find((e) => e.type === 'div' && e.props.role === 'menu')!
    ;(menu.props.onKeyDown as (e: unknown) => void)({ key: 'Escape', preventDefault() {}, stopPropagation() {} })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(arrow.focus).toHaveBeenCalledTimes(1)
  })

  it('the arrow toggles it, anchored above the arrow', async () => {
    const { bar } = await page([LOCAL, REMOTE])
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../src/renderer/components/layout/StatusBar.tsx'), 'utf-8')
    expect(src).toContain("placement={{ x: 'end', y: 'above' }}")
    expect(src).toContain('anchor={arrowRef}')
    // The fold and its observers are gone.
    expect(src).not.toContain('ResizeObserver')
    expect(src).not.toContain('foldRuntimeGroups')
    expect(bar.FocusedRuntime).toBeTypeOf('function')
  })
})

describe('local only', () => {
  it('no arrow and no popover: the status bar of one runtime', async () => {
    const { bar } = await page(undefined)
    const none = renderToStaticMarkup(<bar.StatusBar />)
    const { bar: bar1 } = await page([LOCAL])
    const one = renderToStaticMarkup(<bar1.StatusBar />)
    expect(one).toBe(none)
    expect(one).not.toContain('Servers')
    expect(one).not.toContain('data-runtimes-arrow')
    expect(groups(one)).toEqual(['true'])
  })
})

describe('Settings runtime banner (§6.3)', () => {
  const banner = async (runtimes: RuntimeView[] | undefined, picked: string | null) => {
    await page(runtimes)
    const { SettingsRuntimeBanner, SettingsRuntimeProvider } = await import('../../../src/renderer/components/settings/settings-runtime')
    return renderToStaticMarkup(picked === null ? <SettingsRuntimeBanner /> : <SettingsRuntimeProvider runtimeId={picked}><SettingsRuntimeBanner /></SettingsRuntimeProvider>)
  }

  it('shows the picked runtime\'s name and icon only with more than one runtime', async () => {
    expect(await banner(undefined, 'local')).toBe('')
    expect(await banner([LOCAL], 'local')).toBe('')
    const remote = await banner([LOCAL, REMOTE], HOST_1)
    expect(remote).toContain(`data-runtime-banner="${HOST_1}"`)
    expect(remote).toContain('>host-1</span>')
    expect(remote).toContain('data-remote-mark')
    const local = await banner([LOCAL, REMOTE], 'local')
    expect(local).toContain('>host-0 (Local)</span>')
    expect(local).not.toContain('data-remote-mark')
    expect(local).toContain('data-server-icon')
    // A quiet header strip, not an input box: the word Server, no border, no fill.
    expect(local).toContain('>Server</span>')
    expect(local.slice(0, local.indexOf('>'))).not.toMatch(/border|bg-|rounded/)
    // Outside Settings: none.
    expect(await banner([LOCAL, REMOTE], null)).toBe('')
  })

  it('is drawn once, in the page frame, above every runtime page', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../src/renderer/components/settings/SettingsPage.tsx'), 'utf-8')
    expect(src.match(/<SettingsRuntimeBanner \/>/g)).toHaveLength(1)
    const header = src.indexOf('<header className="mb-7')
    const at = src.indexOf('{runtimePage && <SettingsRuntimeBanner />}')
    expect(header).toBeGreaterThan(0)
    expect(at).toBeGreaterThan(header)
    expect(src.indexOf('<h1', header)).toBeGreaterThan(at)
  })
})
