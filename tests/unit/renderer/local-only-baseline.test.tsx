/**
 * With only This computer, Studio looks exactly as it did before multi-runtime
 * (docs/design/multi-runtime.md §1.3). The baselines in __baseline__/ were
 * rendered from the pre-multi-runtime code (d00491a0, the parent of PR #177's
 * merge) by this same file, with the same fixtures: `T6_WRITE=<dir>` writes
 * the renders there instead of comparing.
 *
 * Every surface renders twice on the current code: with no runtime list (the
 * connections view a single-runtime Studio sends) and with a list of This
 * computer alone. Both must equal the old render.
 *
 * Normalization: React's useId ids (`:R…:` / `«r…»`) are replaced by their
 * order of appearance, as they depend on the shape of the whole tree. Nothing
 * else is changed. Math.random is a fixed sequence (the Mesh view's loading
 * line is picked at random).
 *
 * No jsdom: components render to static markup (effects do not run, so no
 * IPC is made), except the agent-window title effect, which is run inline.
 */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

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

// Effects do not run in a static render; the agent-window title is one, so the effects that set it run inline.
vi.mock('react', async (importOriginal) => {
  const r = await importOriginal<typeof import('react')>()
  const useEffect = ((fn: () => unknown, deps?: unknown[]) => {
    if (String(fn).includes('document.title')) fn()
    return r.useEffect(fn as never, deps as never)
  }) as typeof r.useEffect
  return { ...r, default: { ...r, useEffect }, useEffect }
})

const BASELINE = join(dirname(fileURLToPath(import.meta.url)), '__baseline__')
const WRITE = process.env.T6_WRITE

const AGENT_1 = { id: '5b0f3c3e-6c1d-4f5a-9a51-2f7c0a3d9e11', path: '/agents/agent-1.adf' }
const AGENT_2 = { id: '8e2d4b7a-1f3c-4e9b-b2a6-7c5d9f0e3a22', path: '/agents/agent-2.adf' }

const CURRENT = { id: 'local', kind: 'local', name: 'This computer', url: null, state: 'connected' }
const LOCAL = { ...CURRENT }

type Variant = 'none' | 'local'

/** A process-wide stand-in for main: every call is answered never, every subscription returns a no-op. */
function inertApi(own: Record<string, unknown>): unknown {
  const inert: unknown = new Proxy(function () {}, {
    get: (_t, p) => (p === 'then' ? () => inert : inert),
    apply: () => inert,
  })
  return new Proxy(own, { get: (t, p) => (p in t ? t[p as string] : inert) })
}

/** A fresh page: the window (`search`), the connections view (`variant`), and the fixtures in the stores. */
async function page(variant: Variant, opts: { search?: string; open?: boolean; mesh?: boolean } = {}) {
  vi.resetModules()
  let seed = 1
  vi.spyOn(Math, 'random').mockImplementation(() => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646 })
  vi.stubGlobal('window', {
    location: { search: opts.search ?? '?agentWindows=1' },
    adfApi: inertApi({ platform: 'linux', runtime: undefined, runtimeId: undefined }),
    addEventListener: () => {}, removeEventListener: () => {},
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }),
  })
  vi.stubGlobal('document', { title: 'ADF Studio', documentElement: { classList: { contains: () => false } } })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  const { useConnectionStore } = await import('../../../src/renderer/stores/connection.store')
  const view: Record<string, unknown> = { current: CURRENT, next: null, rows: [], discovery: null }
  if (variant === 'local') view.runtimes = [LOCAL]
  useConnectionStore.getState().setView(view as never)

  const { useTrackedDirsStore } = await import('../../../src/renderer/stores/tracked-dirs.store')
  useTrackedDirsStore.getState().setDirectories(['/agents'])
  useTrackedDirsStore.getState().setFilesForDir('/agents', [
    { filePath: AGENT_1.path, fileName: 'agent-1.adf', agentName: 'agent-1', agentId: AGENT_1.id, reviewed: true, canReceive: true, sendMode: 'proactive' },
    { filePath: AGENT_2.path, fileName: 'agent-2.adf', agentName: 'agent-2', agentId: AGENT_2.id, reviewed: true, canReceive: true, sendMode: 'proactive' },
  ])
  const { useBackgroundAgentsStore } = await import('../../../src/renderer/stores/background-agents.store')
  useBackgroundAgentsStore.getState().setAgents([{ filePath: AGENT_2.path, handle: 'agent-2', state: 'idle' }] as never)

  if (opts.open) {
    const { useDocumentStore } = await import('../../../src/renderer/stores/document.store')
    useDocumentStore.getState().setFilePath(AGENT_1.path)
    const { useAgentStore } = await import('../../../src/renderer/stores/agent.store')
    useAgentStore.getState().setConfig({ id: AGENT_1.id, name: 'agent-1' } as never)
  }
  if (opts.mesh) {
    const { useMeshStore } = await import('../../../src/renderer/stores/mesh.store')
    useMeshStore.getState().setEnabled(true)
    useMeshStore.getState().setAgents([
      { filePath: AGENT_1.path, handle: 'agent-1', agentId: AGENT_1.id, state: 'off', online: false, directory: '/agents' },
      { filePath: AGENT_2.path, handle: 'agent-2', agentId: AGENT_2.id, state: 'idle', online: true, directory: '/agents' },
    ] as never)
  }

  const { useApprovalsStore } = await import('../../../src/renderer/stores/approvals.store')
  useApprovalsStore.getState().pushToast({ id: 'n-1', kind: 'approval', agentName: 'agent-2', loop: 'main', detail: 'sys_fetch', filePath: AGENT_2.path } as never)
  useApprovalsStore.getState().pushToast({ id: 'n-2', kind: 'ask', agentName: 'agent-2', loop: 'side', detail: 'Which folder?', filePath: AGENT_2.path } as never)
}

/** useId ids, numbered in order of appearance. */
function normalize(html: string): string {
  const ids = new Map<string, string>()
  return html.replace(/(:R[0-9A-Za-z]*:|«r[0-9a-z]*»|:r[0-9a-z]+:)/g, (id) => {
    if (!ids.has(id)) ids.set(id, `:id${ids.size}:`)
    return ids.get(id)!
  })
}

/** Each surface: its name and its render, on a page already set up. */
const SURFACES: Array<{ name: string; setup: { search?: string; open?: boolean; mesh?: boolean }; render: () => Promise<string> }> = [
  {
    name: 'status-bar',
    setup: {},
    render: async () => {
      const { StatusBar } = await import('../../../src/renderer/components/layout/StatusBar')
      return renderToStaticMarkup(<StatusBar />)
    },
  },
  {
    name: 'status-bar-open',
    setup: { open: true },
    render: async () => {
      const { StatusBar } = await import('../../../src/renderer/components/layout/StatusBar')
      return renderToStaticMarkup(<StatusBar />)
    },
  },
  {
    name: 'sidebar',
    setup: { open: true },
    render: async () => {
      const { Sidebar } = await import('../../../src/renderer/components/layout/Sidebar')
      return renderToStaticMarkup(<Sidebar />)
    },
  },
  {
    name: 'toasts',
    setup: {},
    render: async () => {
      const { ApprovalToasts } = await import('../../../src/renderer/components/layout/ApprovalsMenu')
      return renderToStaticMarkup(<ApprovalToasts />)
    },
  },
  {
    name: 'mesh-off',
    setup: {},
    render: async () => {
      const { MeshGraphView } = await import('../../../src/renderer/components/mesh/MeshGraphView')
      return renderToStaticMarkup(<MeshGraphView />)
    },
  },
  {
    name: 'mesh-on',
    setup: { mesh: true },
    render: async () => {
      const { MeshGraphView } = await import('../../../src/renderer/components/mesh/MeshGraphView')
      return renderToStaticMarkup(<MeshGraphView />)
    },
  },
  {
    // The agent window's title: the agent's name.
    name: 'agent-window-title',
    setup: { search: '?window=agent&file=%2Fagents%2Fagent-1.adf', open: true },
    render: async () => titleOf(),
  },
  {
    // No config yet: the file's name.
    name: 'agent-window-title-file',
    setup: { search: '?window=agent&file=%2Fagents%2Fagent-2.adf' },
    render: async () => titleOf(),
  },
]

/** document.title after App renders once (its title effect run inline). */
async function titleOf(): Promise<string> {
  const { default: App } = await import('../../../src/renderer/App')
  try { renderToStaticMarkup(<App />) } catch { /* the title effect ran before anything that needs a real DOM */ }
  return (globalThis as unknown as { document: { title: string } }).document.title
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('This computer only: the pre-multi-runtime render (d00491a0)', () => {
  for (const surface of SURFACES) {
    const variants: Variant[] = WRITE ? ['none'] : ['none', 'local']
    for (const variant of variants) {
      it(`${surface.name}, ${variant === 'none' ? 'no runtime list' : 'runtime list of This computer'}`, async () => {
        await page(variant, surface.setup)
        const html = normalize(await surface.render())
        if (WRITE) {
          mkdirSync(WRITE, { recursive: true })
          writeFileSync(join(WRITE, `${surface.name}.html`), html)
          return
        }
        // A checkout with core.autocrlf turns the baseline's line breaks into CRLF; the render has LF.
        expect(html).toBe(readFileSync(join(BASELINE, `${surface.name}.html`), 'utf8').replace(/\r\n/g, '\n'))
      }, 60_000)
    }
  }
})
