/**
 * Review findings on the renderer's multi-runtime state and routing
 * (docs/design/multi-runtime.md): each test reproduces one finding (C1–C13)
 * against the stores and surfaces a window has, with This computer and
 * host-1, and the same agent path on both where it matters.
 *
 * No jsdom: components render to static markup. Handlers are reached through
 * the elements a render creates (`capture`), never through a DOM.
 */
import React from 'react'
import { renderToStaticMarkup, renderToString } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionsView, RuntimeView } from '../../../src/shared/types/connection.types'
import type { TrackedDirEntry } from '../../../src/shared/types/ipc.types'

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
const LOCAL: RuntimeView = { id: 'local', kind: 'local', name: 'host-0 (Local)', url: null, state: 'connected' }
const REMOTE: RuntimeView = { id: HOST_1, kind: 'remote', name: 'host-1', url: 'https://host-1.example:7386', state: 'connected' }
const HOST_2 = 'remote:host-2'
const REMOTE_2: RuntimeView = { id: HOST_2, kind: 'remote', name: 'host-2', url: 'https://host-2.example:7386', state: 'connected' }
/** One path on both runtimes: two agents. */
const PATH = '/srv/agents/agent-1.adf'
const PATH_2 = '/srv/agents/agent-2.adf'
const DIR = '/srv/agents'
const ID_1 = '3f8a1c52-9d4e-4b7a-8e21-6c0d5b9a7f13'
const KEY = `${HOST_1}\n${PATH}`
const KEY_2 = `${HOST_1}\n${PATH_2}`

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function view(runtimes?: RuntimeView[]): ConnectionsView {
  return { current: { id: 'local', kind: 'local', name: 'host-0 (Local)', url: null, state: 'connected' }, next: null, rows: [], discovery: null, ...(runtimes ? { runtimes } : {}) }
}

interface Surface { api: Record<string, unknown>; calls: Array<[string, unknown[]]>; names: () => string[] }

/** A runtime's surface that records every call: `impl` answers; anything else never answers, a subscription is a no-op. */
function surface(runtimeId: string | undefined, impl: Record<string, unknown> = {}): Surface {
  const calls: Array<[string, unknown[]]> = []
  const api = new Proxy(impl, {
    get: (target, p) => {
      if (typeof p !== 'string' || p === 'then') return undefined
      if (p === 'runtimeId') return runtimeId
      if (p in target) {
        const v = target[p]
        return typeof v === 'function' ? (...args: unknown[]) => { calls.push([p, args]); return (v as (...a: unknown[]) => unknown)(...args) } : v
      }
      return (...args: unknown[]) => { calls.push([p, args]); return p.startsWith('on') ? () => {} : new Promise(() => {}) }
    },
  })
  return { api, calls, names: () => calls.map(([n]) => n).filter((n) => n !== 'runtime') }
}

/** A fresh page (`search`: an agent window's query) with the runtime set and a recording surface per runtime. */
async function page(runtimes: RuntimeView[] | undefined, opts: { search?: string; local?: Record<string, unknown>; remote?: Record<string, unknown>; remote2?: Record<string, unknown> } = {}) {
  vi.resetModules()
  // Each surface binds the others, as preload's runtime() does.
  const bind = (id: string) => (id === HOST_1 ? remote.api : id === HOST_2 ? remote2.api : local.api)
  const remote = surface(HOST_1, { platform: 'linux', runtime: bind, ...opts.remote })
  const remote2 = surface(HOST_2, { platform: 'linux', runtime: bind, ...opts.remote2 })
  const local = surface(undefined, { platform: 'linux', runtime: bind, ...opts.local })
  // An agent window of host-1: its window.adfApi is host-1's surface.
  const own = opts.search?.includes('runtime=') ? remote : local
  vi.stubGlobal('window', { location: { search: opts.search ?? '?agentWindows=1' }, adfApi: own.api, addEventListener: () => {}, removeEventListener: () => {} })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  const { useConnectionStore } = await import('../../../src/renderer/stores/connection.store')
  await import('../../../src/renderer/stores/runtimes.store')
  useConnectionStore.getState().setView(view(runtimes))
  return { local, remote, remote2 }
}

/** Render, recording every element made: a handler is then called as the click would. */
function capture(render: () => string): { html: string; elements: Array<{ type: unknown; props: Record<string, unknown> }> } {
  const elements: Array<{ type: unknown; props: Record<string, unknown> }> = []
  recorder.on = (type, props) => { elements.push({ type, props }) }
  try {
    return { html: render(), elements }
  } finally {
    recorder.on = null
  }
}

async function notices(): Promise<string[]> {
  const { useFailureNoticesStore } = await import('../../../src/renderer/stores/failure-notices.store')
  return useFailureNoticesStore.getState().notices.map((n) => n.text)
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('C1: the open agent of a runtime that connected again without it', () => {
  async function setup(held: string | null, reopenOk = true) {
    const { remote } = await page([LOCAL, REMOTE], { remote: { getCurrentFile: async () => ({ filePath: held, agentRunning: false }) } })
    const { syncRuntimeFeeds } = await import('../../../src/renderer/hooks/useRuntimeFeeds')
    const { useDocumentStore } = await import('../../../src/renderer/stores/document.store')
    const { useAgentStore } = await import('../../../src/renderer/stores/agent.store')
    const reopen = vi.fn(async (filePath: string, runtimeId: string) => {
      if (!reopenOk) return { success: false, error: 'not opened' }
      useDocumentStore.getState().setFilePath(filePath, runtimeId)
      return { success: true }
    })
    syncRuntimeFeeds([LOCAL, REMOTE], reopen)
    useDocumentStore.getState().setFilePath(PATH, HOST_1)
    useAgentStore.getState().setConfig({ id: ID_1, name: 'agent-1' } as never)
    // Reconnect: the runtime goes down and its new connection connects.
    syncRuntimeFeeds([LOCAL, { ...REMOTE, state: 'retrying' }], reopen)
    syncRuntimeFeeds([LOCAL, REMOTE], reopen)
    await flush()
    return { remote, reopen, useDocumentStore }
  }

  it('is opened again on its runtime, and the user is told', async () => {
    const { reopen, remote } = await setup(null)
    expect(remote.names()).toContain('getCurrentFile')
    expect(reopen).toHaveBeenCalledWith(PATH, HOST_1)
    expect(await notices()).toEqual(['host-1 reconnected; agent-1 reopened.'])
  })

  it('a runtime that still has it open: nothing happens', async () => {
    const { reopen } = await setup(PATH)
    expect(reopen).not.toHaveBeenCalled()
    expect(await notices()).toEqual([])
  })

  it('an open that fails shows Home, said', async () => {
    const { useDocumentStore } = await setup(null, false)
    expect(useDocumentStore.getState().filePath).toBeNull()
    expect(await notices()).toEqual(['host-1 reconnected; agent-1 closed.'])
  })
})

describe('C2: queued messages of a remote agent window', () => {
  const queues = { [PATH]: { main: [{ id: 'm-1', text: 'hello' }] } }

  it('an agent window of host-1 names its runtime on each entry; one of This computer does not', async () => {
    await page([LOCAL, REMOTE], { search: `?window=agent&runtime=${encodeURIComponent(HOST_1)}&file=${encodeURIComponent(PATH)}` })
    const remoteWindow = await import('../../../src/renderer/utils/agent-window')
    expect(remoteWindow.queueEntries(queues, PATH)).toEqual([{ filePath: PATH, runtimeId: HOST_1, loop: 'main', messages: [{ id: 'm-1', text: 'hello' }] }])
    await page([LOCAL, REMOTE], { search: `?window=agent&file=${encodeURIComponent(PATH)}` })
    const localWindow = await import('../../../src/renderer/utils/agent-window')
    expect(localWindow.queueEntries(queues, PATH)).toEqual([{ filePath: PATH, loop: 'main', messages: [{ id: 'm-1', text: 'hello' }] }])
  })

  it('the main window queues them for host-1\'s agent and sends them there, not to This computer\'s agent of the same path', async () => {
    const { local, remote } = await page([LOCAL, REMOTE], {
      local: { invokeAgent: vi.fn(async () => ({ success: true })) },
      remote: { invokeAgent: vi.fn(async () => ({ success: true })) },
    })
    const { useBackgroundAgentsStore } = await import('../../../src/renderer/stores/background-agents.store')
    useBackgroundAgentsStore.getState().setAgents([{ filePath: PATH, handle: 'agent-1', state: 'idle' }] as never)
    useBackgroundAgentsStore.getState().setAgents([{ filePath: PATH, handle: 'agent-1', state: 'idle' }] as never, HOST_1)
    const { adoptQueueHandover } = await import('../../../src/renderer/utils/agent-window')
    adoptQueueHandover([{ filePath: PATH, runtimeId: HOST_1, loop: 'main', messages: [{ id: 'm-1', text: 'hello' }] }])
    await flush()
    expect(remote.calls.filter(([n]) => n === 'invokeAgent').map(([, a]) => a.slice(0, 2))).toEqual([['hello', PATH]])
    expect(local.names()).not.toContain('invokeAgent')
  })

  it('a busy agent keeps them under its runtime\'s key', async () => {
    await page([LOCAL, REMOTE])
    const { adoptQueueHandover } = await import('../../../src/renderer/utils/agent-window')
    const { useMessageQueueStore } = await import('../../../src/renderer/stores/message-queue.store')
    adoptQueueHandover([{ filePath: PATH, runtimeId: HOST_1, loop: 'main', messages: [{ id: 'm-1', text: 'hello' }] }])
    expect(Object.keys(useMessageQueueStore.getState().queues)).toEqual([KEY])
  })
})

describe('C3: the provider sheet for an agent of another runtime', () => {
  it('the main window does not set up This computer\'s providers for host-1\'s agent: its refusal is shown as it is', async () => {
    await page([LOCAL, REMOTE], { remote: { startAgent: async () => ({ success: false, code: 'provider_missing', error: 'host-1 has no provider p-1' }) } })
    const { useDocumentStore } = await import('../../../src/renderer/stores/document.store')
    const { useAppStore } = await import('../../../src/renderer/stores/app.store')
    const { useAgentStore, selectLoopSlice, MAIN_LOOP } = await import('../../../src/renderer/stores/agent.store')
    const request = vi.fn(async () => null)
    useAppStore.setState({ requestProviderSetup: request } as never)
    useDocumentStore.getState().setFilePath(PATH, HOST_1)
    const { startForegroundAgent } = await import('../../../src/renderer/utils/start-agent')
    expect(await startForegroundAgent({ skipReviewGate: true })).toEqual({ success: false, error: 'host-1 has no provider p-1' })
    expect(request).not.toHaveBeenCalled()
    expect(selectLoopSlice(useAgentStore.getState(), MAIN_LOOP).log.map((e) => e.content)).toEqual(['host-1 has no provider p-1'])
  })

  it('This computer\'s agent still gets the sheet', async () => {
    await page([LOCAL, REMOTE], { local: { startAgent: async () => ({ success: false, code: 'provider_missing', error: 'no provider' }) } })
    const { useDocumentStore } = await import('../../../src/renderer/stores/document.store')
    const { useAppStore } = await import('../../../src/renderer/stores/app.store')
    const request = vi.fn(async () => null)
    useAppStore.setState({ requestProviderSetup: request } as never)
    useDocumentStore.getState().setFilePath(PATH)
    const { startForegroundAgent } = await import('../../../src/renderer/utils/start-agent')
    expect(await startForegroundAgent({ skipReviewGate: true })).toMatchObject({ cancelled: true })
    expect(request).toHaveBeenCalledWith('provider_missing', PATH)
  })
})

describe('C5: two quick opens on different runtimes', () => {
  it('the later open shows; the earlier one applies nothing and closes what it opened', async () => {
    let answerRemote!: (r: unknown) => void
    const files = {
      getBatch: async () => ({ document: '', agentConfig: null, statusText: '', chat: { uiLog: [] } }),
      readInternalFile: async () => null,
      checkAgentReview: async () => ({ needsReview: false }),
      closeFile: async () => ({ success: true }),
    }
    const { remote, local } = await page([LOCAL, REMOTE], {
      local: { ...files, openFile: async (filePath: string) => ({ success: true, filePath }) },
      remote: { ...files, openFile: () => new Promise((resolve) => { answerRemote = resolve }) },
    })
    const { useAdfFile } = await import('../../../src/renderer/hooks/useAdfFile')
    const { useDocumentStore } = await import('../../../src/renderer/stores/document.store')
    let api!: ReturnType<typeof useAdfFile>
    const Probe = (): null => { api = useAdfFile(); return null }
    renderToString(<Probe />)
    const first = api.openFile(PATH, HOST_1)
    const second = api.openFile(PATH_2)
    await second
    expect(useDocumentStore.getState()).toMatchObject({ filePath: PATH_2, runtimeId: 'local' })
    answerRemote({ success: true, filePath: PATH })
    await first
    expect(useDocumentStore.getState()).toMatchObject({ filePath: PATH_2, runtimeId: 'local' })
    expect(remote.names().filter((n) => n === 'closeFile')).toHaveLength(1)
    expect(local.names()).not.toContain('closeFile')
  })
})

describe('C6: sidebar updates of the open agent go to its runtime\'s slice', () => {
  it('the slice argument is the open agent\'s runtime in the main window, none in an agent window', async () => {
    await page([LOCAL, REMOTE])
    const main = await import('../../../src/renderer/utils/runtime-api')
    const { useDocumentStore } = await import('../../../src/renderer/stores/document.store')
    const { useTrackedDirsStore } = await import('../../../src/renderer/stores/tracked-dirs.store')
    const entry = (): TrackedDirEntry => ({ filePath: PATH, fileName: 'agent-1.adf', agentName: 'agent-1', agentId: ID_1 })
    useTrackedDirsStore.getState().setFilesForDir(DIR, [entry()])
    useTrackedDirsStore.getState().setFilesForDir(DIR, [entry()], HOST_1)
    useDocumentStore.getState().setFilePath(PATH, HOST_1)
    expect(main.openSliceRuntime()).toBe(HOST_1)
    useTrackedDirsStore.getState().updateFileEntry(PATH, { reviewed: true }, main.openSliceRuntime())
    expect(useTrackedDirsStore.getState().filesByDir[DIR][0].reviewed).toBeUndefined()
    expect(useTrackedDirsStore.getState().byRuntime[HOST_1].filesByDir[DIR][0].reviewed).toBe(true)
    await page([LOCAL, REMOTE], { search: `?window=agent&runtime=${encodeURIComponent(HOST_1)}&file=${encodeURIComponent(PATH)}` })
    expect((await import('../../../src/renderer/utils/runtime-api')).openSliceRuntime()).toBeUndefined()
  })

  it('every renderer call of updateFileEntry names the runtime of the entry (Config save, rename, review)', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '../../../src/renderer')
    for (const file of ['components/agent/AgentConfig.tsx', 'components/common/AgentReviewDialog.tsx', 'components/layout/Sidebar.tsx']) {
      const source = readFileSync(join(root, file), 'utf8')
      const calls = [...source.matchAll(/updateFileEntry\(([^;]*?)\)\s*(?:\n|$)/g)].map((m) => m[1])
      const named = (call: string) => /openSliceRuntime\(\)|runtimeId/.test(call)
      for (const call of calls.filter((c) => !c.startsWith('filePath: string'))) expect([file, named(call)]).toEqual([file, true])
    }
  })
})

describe('C7: an open of a running agent of host-1 keeps its starting mark', () => {
  it('its agent_stopped (moved to the foreground) does not drop the mark; another agent\'s does', async () => {
    await page([LOCAL, REMOTE])
    const { applyRuntimeBackgroundBatch } = await import('../../../src/renderer/hooks/useRuntimeFeeds')
    const { openingFilePaths } = await import('../../../src/renderer/hooks/useAdfFile')
    const { useAppStore } = await import('../../../src/renderer/stores/app.store')
    const { useDocumentStore } = await import('../../../src/renderer/stores/document.store')
    useDocumentStore.getState().setFilePath(PATH, HOST_1)
    const third = `${HOST_1}\n/srv/agents/agent-3.adf`
    for (const k of [KEY, KEY_2, third]) useAppStore.getState().addStartingFilePath(k)
    openingFilePaths.add(KEY_2)
    applyRuntimeBackgroundBatch(HOST_1, ['agent-1', 'agent-2', 'agent-3'].map((n) => ({ type: 'agent_stopped', payload: { filePath: `/srv/agents/${n}.adf` } })) as never)
    expect([...useAppStore.getState().startingFilePaths].sort()).toEqual([KEY, KEY_2].sort())
    openingFilePaths.delete(KEY_2)
  })
})

describe('C8: the Mesh view\'s peer stations', () => {
  it('a runtime of the set is never its own peer station, even while it is down (its DID is known)', async () => {
    await page([LOCAL, { ...REMOTE, state: 'retrying' }], { local: { getOwnerIdentityStatus: async () => ({ runtimeDid: 'did:key:this-computer' }), getMeshServerLanIps: async () => ({ hostname: 'host-0', addresses: [] }) } })
    const { fleetPeers } = await import('../../../src/renderer/components/mesh/MeshGraphView')
    const own = [{ runtime_id: 'rt-host-1', runtime_did: 'did:key:host-1', url: `http://${new URL(REMOTE.url!).hostname}:7295` }, { runtime_id: 'rt-desk', runtime_did: 'did:key:desk' }]
    const state = { seq: {}, errors: {}, dids: { [HOST_1]: 'did:key:host-1' } as Record<string, string | null> }
    expect(await fleetPeers(own, [], state)).toEqual([own[1]])
  })

  it('This computer only: its list as it is, with no call', async () => {
    const { local } = await page([LOCAL])
    const { fleetPeers } = await import('../../../src/renderer/components/mesh/MeshGraphView')
    const own = [{ runtime_id: 'rt-desk' }, { runtime_id: 'rt-desk' }]
    expect(await fleetPeers(own, [], { seq: {}, errors: {}, dids: {} })).toBe(own)
    expect(local.names()).toEqual([])
  })
})

describe('C9 and C13: a runtime that leaves the set', () => {
  async function removed(opts: { open?: boolean } = {}) {
    const recoveryStash = vi.fn(async () => ({ success: true }))
    const { local } = await page([LOCAL, REMOTE], { local: { recoveryStash } })
    const { syncRuntimeFeeds } = await import('../../../src/renderer/hooks/useRuntimeFeeds')
    const { useDocumentStore } = await import('../../../src/renderer/stores/document.store')
    const { useAgentStore } = await import('../../../src/renderer/stores/agent.store')
    const { useEditorTabsStore } = await import('../../../src/renderer/stores/editor-tabs.store')
    const { useMessageQueueStore } = await import('../../../src/renderer/stores/message-queue.store')
    const { useAppStore } = await import('../../../src/renderer/stores/app.store')
    const { useFleetStore } = await import('../../../src/renderer/stores/fleet.store')
    syncRuntimeFeeds([LOCAL, REMOTE])
    if (opts.open) {
      useDocumentStore.getState().setFilePath(PATH, HOST_1)
      useAgentStore.getState().setConfig({ id: ID_1, name: 'agent-1' } as never)
      useEditorTabsStore.getState().openTab('mind.md', 'saved text', false)
      useEditorTabsStore.getState().updateTabContent('mind.md', 'unsaved text')
    }
    useMessageQueueStore.getState().enqueue(KEY_2, 'main', { text: 'hello' })
    useMessageQueueStore.getState().enqueue(PATH_2, 'main', { text: 'stays' })
    useDocumentStore.getState().setDraftInput(KEY_2, 'draft')
    useAppStore.getState().addStartingFilePath(KEY_2)
    useAppStore.getState().addStoppingFilePath(KEY)
    useFleetStore.getState().setSelection([KEY_2, PATH_2])
    syncRuntimeFeeds([LOCAL])
    await flush()
    return { local, recoveryStash, useDocumentStore, useEditorTabsStore, useMessageQueueStore, useAppStore, useFleetStore }
  }

  it('C9: its queues, drafts, marks and fleet selection go; the discarded queue is said; This computer\'s stay', async () => {
    const s = await removed()
    expect(Object.keys(s.useMessageQueueStore.getState().queues)).toEqual([PATH_2])
    expect(s.useDocumentStore.getState().draftInputs).toEqual({})
    expect([...s.useAppStore.getState().startingFilePaths, ...s.useAppStore.getState().stoppingFilePaths]).toEqual([])
    expect(s.useFleetStore.getState().selection).toEqual([PATH_2])
    expect(await notices()).toEqual(['host-1 removed; 1 queued message discarded.'])
  })

  it('C9: a fleet save after Remove never writes the removed runtime\'s saved entry back (main deleted it)', async () => {
    const setSettings = vi.fn(async () => ({ success: true }))
    await page([LOCAL, REMOTE, REMOTE_2], { local: { setSettings } })
    const fleet = await import('../../../src/renderer/components/mesh/runtime-fleet')
    const { syncRuntimeFeeds } = await import('../../../src/renderer/hooks/useRuntimeFeeds')
    fleet.setStoredRuntimeFleet({ [HOST_1]: { fleetGroups: { team: [PATH] } }, [HOST_2]: { fleetGroups: { ops: [PATH_2] } } })
    syncRuntimeFeeds([LOCAL, REMOTE, REMOTE_2])
    syncRuntimeFeeds([LOCAL, REMOTE_2])
    // A group still naming host-1's agent (the map's copy), saved with host-2's part.
    await fleet.saveFleetKeys({ groups: { ops: [`${HOST_2}\n${PATH_2}`, KEY] } }, [LOCAL, REMOTE_2])
    expect(setSettings).toHaveBeenCalledWith({ fleetGroups: {}, runtimeFleet: { [HOST_2]: { fleetGroups: { ops: [PATH_2] } } } })
  })

  it('C13: the open agent on it closes with its unsaved editors kept as recovery copies, said', async () => {
    const s = await removed({ open: true })
    expect(s.useDocumentStore.getState().filePath).toBeNull()
    expect(s.useEditorTabsStore.getState().tabs).toEqual([])
    // R3B-3: under the hand-off's own stamp.
    expect(s.recoveryStash).toHaveBeenCalledWith({ agentFilePath: PATH, path: 'mind.md', content: 'unsaved text', runtimeId: HOST_1, kept: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d+$/) })
    expect(await notices()).toEqual(['host-1 removed; agent-1 closed; 1 queued message discarded; unsaved changes kept for recovery.'])
  })
})

describe('C10: guards and drafts compare the agent, not its path', () => {
  it('a start whose agent the user left for This computer\'s agent of the same path touches neither', async () => {
    let answer!: (r: unknown) => void
    await page([LOCAL, REMOTE], { remote: { startAgent: () => new Promise((resolve) => { answer = resolve }) } })
    const { useDocumentStore } = await import('../../../src/renderer/stores/document.store')
    const { useAgentStore, selectLoopSlice, MAIN_LOOP } = await import('../../../src/renderer/stores/agent.store')
    useDocumentStore.getState().setFilePath(PATH, HOST_1)
    const { startForegroundAgent } = await import('../../../src/renderer/utils/start-agent')
    const started = startForegroundAgent({ skipReviewGate: true })
    useDocumentStore.getState().setFilePath(PATH, 'local')
    answer({ success: true, agentState: 'idle', sessionId: 's-1' })
    expect(await started).toEqual({ success: true })
    expect(useAgentStore.getState().state).toBe('off')
    expect(selectLoopSlice(useAgentStore.getState(), MAIN_LOOP).log).toEqual([])
  })

  it('the composer of host-1\'s agent does not show the draft of This computer\'s agent of the same path', async () => {
    await page([LOCAL, REMOTE])
    const { useDocumentStore } = await import('../../../src/renderer/stores/document.store')
    useDocumentStore.getState().setFilePath(PATH, HOST_1)
    useDocumentStore.getState().setDraftInput(PATH, 'draft of This computer')
    useDocumentStore.getState().setDraftInput(KEY, 'draft of host-1')
    const { AgentLoop } = await import('../../../src/renderer/components/agent/AgentLoop')
    const html = renderToStaticMarkup(<AgentLoop />)
    expect(html).not.toContain('draft of This computer')
    expect(html).toContain('draft of host-1')
  }, 30_000)

  it('Home\'s Stop on This computer\'s row stops that agent, not host-1\'s open agent of the same path', async () => {
    const { local, remote } = await page([LOCAL, REMOTE], { local: { stopBackgroundAgent: vi.fn(async () => ({ success: true })), stopAgent: vi.fn(async () => ({ success: true })) } })
    const { useDocumentStore } = await import('../../../src/renderer/stores/document.store')
    useDocumentStore.getState().setFilePath(PATH, HOST_1)
    const { AgentList } = await import('../../../src/renderer/components/home/HomeStatusLine')
    const row = { file: { filePath: PATH, fileName: 'agent-1.adf', agentName: 'agent-1', agentId: ID_1 }, folderHint: null }
    const { elements } = capture(() => renderToStaticMarkup(<AgentList rows={[row] as never} kind="running" />))
    const stop = elements.find((e) => e.type === 'button' && JSON.stringify(e.props.children ?? '').includes('Stop'))
    ;(stop!.props.onClick as () => void)()
    await flush()
    expect(local.names()).toEqual(['stopBackgroundAgent'])
    expect(remote.names()).toEqual([])
  })
})

describe('C11: Go to Agent in an agent window of host-1', () => {
  it('names the runtime it lists; with This computer only, the title is unchanged', async () => {
    const title = async (runtimes: RuntimeView[]) => {
      await page(runtimes, { search: `?window=agent&runtime=${encodeURIComponent(HOST_1)}&file=${encodeURIComponent(PATH)}` })
      const { AgentSwitcher } = await import('../../../src/renderer/components/common/AgentSwitcher')
      const { elements } = capture(() => renderToStaticMarkup(<AgentSwitcher />))
      return elements.map((e) => e.props.title).find((t) => typeof t === 'string' && t.startsWith('Agents'))
    }
    expect(await title([LOCAL, REMOTE])).toBe('Agents · host-1')
    expect(await title([REMOTE])).toBe('Agents')
  })
})

describe('C12: no silent failures', () => {
  it('the status bar\'s Save saves the open agent on its runtime', async () => {
    const { local, remote } = await page([LOCAL, REMOTE], { remote: { saveFile: vi.fn(async () => ({ success: true })) } })
    const { useDocumentStore } = await import('../../../src/renderer/stores/document.store')
    useDocumentStore.getState().setFilePath(PATH, HOST_1)
    const { StatusBar } = await import('../../../src/renderer/components/layout/StatusBar')
    const { elements } = capture(() => renderToStaticMarkup(<StatusBar />))
    const save = elements.find((e) => e.props.title === 'Save')
    await (save!.props.onClick as () => Promise<void>)()
    expect(remote.names()).toContain('saveFile')
    expect(local.names()).not.toContain('saveFile')
  })

  it('a row of another runtime says why it does not drag out; This computer\'s rows do not', async () => {
    await page([LOCAL, REMOTE])
    const { useTrackedDirsStore } = await import('../../../src/renderer/stores/tracked-dirs.store')
    const entry = (): TrackedDirEntry => ({ filePath: PATH, fileName: 'agent-1.adf', agentName: 'agent-1', agentId: ID_1 })
    useTrackedDirsStore.getState().setDirectories([DIR])
    useTrackedDirsStore.getState().setFilesForDir(DIR, [entry()])
    useTrackedDirsStore.getState().setDirectories([DIR], HOST_1)
    useTrackedDirsStore.getState().setFilesForDir(DIR, [entry()], HOST_1)
    const { Sidebar } = await import('../../../src/renderer/components/layout/Sidebar')
    const { elements } = capture(() => renderToStaticMarkup(<Sidebar />))
    const tips = elements.map((e) => e.props.tip).filter((t): t is string => typeof t === 'string' && t.startsWith(PATH))
    expect(tips.sort()).toEqual([PATH, `${PATH} · Drag out: Local only`])
  })

  it('Open in new window that fails is said', async () => {
    await page([LOCAL, REMOTE], { local: { openAgentWindow: async () => ({ success: false, error: 'host-1 is not connected' }) } })
    const { openAgentWindow } = await import('../../../src/renderer/utils/window-kind')
    openAgentWindow({ filePath: PATH, runtimeId: HOST_1 })
    await flush()
    expect(await notices()).toEqual(['Open in new window failed: host-1 is not connected'])
  })
})

// ---- Second review (R2C, docs/design/multi-runtime.md §17) -------------------------------------

/** What an agent open reads, on any runtime. */
const FILES = {
  getBatch: async () => ({ document: '', agentConfig: null, statusText: '', chat: { uiLog: [] } }),
  readInternalFile: async () => null,
  checkAgentReview: async () => ({ needsReview: false }),
  closeFile: async () => ({ success: true }),
}

/** The main window's openFile (useAdfFile), as the runtime feeds call it. */
async function mainOpenFile() {
  const { useAdfFile } = await import('../../../src/renderer/hooks/useAdfFile')
  let api!: ReturnType<typeof useAdfFile>
  const Probe = (): null => { api = useAdfFile(); return null }
  renderToString(<Probe />)
  return api.openFile
}

/** host-1's agent-1 open, with notes.md under a "changed elsewhere" notice. */
async function openWithConflict(useDocumentStore: typeof import('../../../src/renderer/stores/document.store').useDocumentStore) {
  const { useAgentStore } = await import('../../../src/renderer/stores/agent.store')
  const { useEditorTabsStore } = await import('../../../src/renderer/stores/editor-tabs.store')
  useDocumentStore.getState().setFilePath(PATH, HOST_1)
  useAgentStore.getState().setConfig({ id: ID_1, name: 'agent-1' } as never)
  const tabs = useEditorTabsStore.getState()
  tabs.openTab('notes.md', 'base', false, undefined, 1)
  tabs.updateTabContent('notes.md', 'mine')
  tabs.updateTabFromExternal('notes.md', 'theirs', { revision: 2, writer: { kind: 'agent' } } as never)
}

const removals = (stash: ReturnType<typeof vi.fn>) => stash.mock.calls.map((c) => c[0] as { path: string; content: string | null }).filter((s) => s.content === null)
/** The copies a hand-off kept (R3B-3: each names its hand-off's stamp). */
const kepts = (stash: ReturnType<typeof vi.fn>) => stash.mock.calls.map((c) => c[0] as { kept?: string }).filter((s) => s.kept !== undefined)
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d+$/

describe('R2C-1: the open agent reopened after a reconnect, or closed by Remove, keeps its recovery copies', () => {
  it('reconnect: no confirm dialog, the agent reopens, and the copies just kept are not removed', async () => {
    const recoveryStash = vi.fn(async () => ({ success: true }))
    const { local } = await page([LOCAL, REMOTE], {
      local: { recoveryStash },
      remote: { ...FILES, getCurrentFile: async () => ({ filePath: null, agentRunning: false }), openFile: async (filePath: string) => ({ success: true, filePath }) },
    })
    const confirm = vi.fn(() => false)
    ;(window as unknown as { confirm: unknown }).confirm = confirm
    const { syncRuntimeFeeds, reopenerOf } = await import('../../../src/renderer/hooks/useRuntimeFeeds')
    const { useDocumentStore } = await import('../../../src/renderer/stores/document.store')
    const { startEditRecovery } = await import('../../../src/renderer/utils/edit-recovery')
    const stop = startEditRecovery(local.api as never, 500)
    const reopen = reopenerOf(await mainOpenFile())
    syncRuntimeFeeds([LOCAL, REMOTE], reopen)
    await openWithConflict(useDocumentStore)
    expect(recoveryStash).toHaveBeenCalledWith({ agentFilePath: PATH, path: 'notes.md', content: 'mine', runtimeId: HOST_1 })
    syncRuntimeFeeds([LOCAL, { ...REMOTE, state: 'retrying' }], reopen)
    syncRuntimeFeeds([LOCAL, REMOTE], reopen)
    for (let i = 0; i < 10; i++) await flush()
    stop()
    expect(confirm).not.toHaveBeenCalled()
    expect(useDocumentStore.getState()).toMatchObject({ filePath: PATH, runtimeId: HOST_1 })
    // R3B-3: the copy just kept is the hand-off's own (its stamp); the notice's copy goes with its editor, as for any
    // resolved notice, and no removal ever names a hand-off's copy.
    expect(kepts(recoveryStash)).toEqual([{ agentFilePath: PATH, path: 'notes.md', content: 'mine', runtimeId: HOST_1, kept: expect.stringMatching(STAMP) }])
    expect(removals(recoveryStash)).toEqual([{ agentFilePath: PATH, path: 'notes.md', content: null, runtimeId: HOST_1 }])
    expect(await notices()).toEqual(['host-1 reconnected; agent-1 reopened; unsaved changes kept for recovery.'])
  })

  it('Remove: the agent closes only once its copies are written, and they are not removed', async () => {
    const pending: Array<() => void> = []
    const recoveryStash = vi.fn((s: { content: string | null }) => (s.content === null ? Promise.resolve({ success: true }) : new Promise((resolve) => { pending.push(() => resolve({ success: true })) })))
    const { local } = await page([LOCAL, REMOTE], { local: { recoveryStash } })
    const { syncRuntimeFeeds } = await import('../../../src/renderer/hooks/useRuntimeFeeds')
    const { useDocumentStore } = await import('../../../src/renderer/stores/document.store')
    const { startEditRecovery } = await import('../../../src/renderer/utils/edit-recovery')
    const stop = startEditRecovery(local.api as never, 500)
    syncRuntimeFeeds([LOCAL, REMOTE])
    await openWithConflict(useDocumentStore)
    // The copy the notice keeps.
    pending.shift()!()
    await flush()
    syncRuntimeFeeds([LOCAL])
    await flush()
    // The copy for Remove is on its way: the agent is still shown.
    expect(pending).toHaveLength(1)
    expect(useDocumentStore.getState().filePath).toBe(PATH)
    pending.shift()!()
    for (let i = 0; i < 5; i++) await flush()
    stop()
    expect(useDocumentStore.getState().filePath).toBeNull()
    // R3B-3: as for a reconnect.
    expect(kepts(recoveryStash)).toEqual([{ agentFilePath: PATH, path: 'notes.md', content: 'mine', runtimeId: HOST_1, kept: expect.stringMatching(STAMP) }])
    expect(removals(recoveryStash)).toEqual([{ agentFilePath: PATH, path: 'notes.md', content: null, runtimeId: HOST_1 }])
    expect(await notices()).toEqual(['host-1 removed; agent-1 closed; unsaved changes kept for recovery.'])
  })
})

describe('R2C-5: a reconnect reopen overtaken by the user\'s own open', () => {
  it('says nothing: the agent the user opened shows', async () => {
    let answer: ((r: unknown) => void) | null = null
    await page([LOCAL, REMOTE], {
      local: { ...FILES, openFile: async (filePath: string) => ({ success: true, filePath }) },
      remote: { ...FILES, getCurrentFile: async () => ({ filePath: null, agentRunning: false }), openFile: () => new Promise((resolve) => { answer = resolve }) },
    })
    const { syncRuntimeFeeds, reopenerOf } = await import('../../../src/renderer/hooks/useRuntimeFeeds')
    const { useDocumentStore } = await import('../../../src/renderer/stores/document.store')
    const { useAgentStore } = await import('../../../src/renderer/stores/agent.store')
    const openFile = await mainOpenFile()
    const reopen = reopenerOf(openFile)
    syncRuntimeFeeds([LOCAL, REMOTE], reopen)
    useDocumentStore.getState().setFilePath(PATH, HOST_1)
    useAgentStore.getState().setConfig({ id: ID_1, name: 'agent-1' } as never)
    syncRuntimeFeeds([LOCAL, { ...REMOTE, state: 'retrying' }], reopen)
    syncRuntimeFeeds([LOCAL, REMOTE], reopen)
    for (let i = 0; i < 5; i++) await flush()
    expect(answer).toBeTypeOf('function')
    await openFile(PATH_2)
    answer!({ success: true, filePath: PATH })
    for (let i = 0; i < 5; i++) await flush()
    expect(useDocumentStore.getState()).toMatchObject({ filePath: PATH_2, runtimeId: 'local' })
    expect(await notices()).toEqual([])
  })
})

describe('R2C-2 and R2C-3: the same computer under another id (a rename, the remote slot cleared)', () => {
  async function moved(opts: { mainFleet?: Record<string, unknown> } = {}) {
    const setSettings = vi.fn(async () => ({ success: true }))
    const getSettings = vi.fn(async () => ({ runtimeFleet: opts.mainFleet ?? {} }))
    const { remote2 } = await page([LOCAL, REMOTE], {
      local: { setSettings, getSettings },
      remote2: { ...FILES, getCurrentFile: async () => ({ filePath: null, agentRunning: false }), openFile: async (filePath: string) => ({ success: true, filePath }) },
    })
    const feeds = await import('../../../src/renderer/hooks/useRuntimeFeeds')
    const fleet = await import('../../../src/renderer/components/mesh/runtime-fleet')
    const { useDocumentStore } = await import('../../../src/renderer/stores/document.store')
    const { useAgentStore } = await import('../../../src/renderer/stores/agent.store')
    const { useMessageQueueStore } = await import('../../../src/renderer/stores/message-queue.store')
    const { useAppStore } = await import('../../../src/renderer/stores/app.store')
    const { useFleetStore } = await import('../../../src/renderer/stores/fleet.store')
    const reopen = feeds.reopenerOf(await mainOpenFile())
    feeds.syncRuntimeFeeds([LOCAL, REMOTE], reopen)
    await flush()
    // The Mesh view read runtimeFleet when it mounted.
    fleet.setStoredRuntimeFleet({ [HOST_1]: { fleetGroups: { team: [PATH] } } })
    useDocumentStore.getState().setFilePath(PATH, HOST_1)
    useAgentStore.getState().setConfig({ id: ID_1, name: 'agent-1' } as never)
    useMessageQueueStore.getState().enqueue(KEY, 'main', { text: 'hello' })
    useDocumentStore.getState().setDraftInput(KEY_2, 'draft')
    useAppStore.getState().addStartingFilePath(KEY_2)
    useFleetStore.getState().setSelection([KEY_2, PATH_2])
    useFleetStore.getState().setNamedGroups({ team: [KEY, PATH_2] })
    useFleetStore.getState().setStewards({ [`${HOST_1}\n${DIR}`]: 'did:key:agent-1' })
    useFleetStore.getState().setPlacement({ regionOrigins: { [`${HOST_1}\n`]: { q: 1, r: 2 } }, cellPins: { [KEY]: { q: 3, r: 4 } } })
    // Main pushes the move before the runtime set that no longer has host-1.
    feeds.noteRuntimeMoves({ moves: { [HOST_1]: HOST_2 }, replaced: [] })
    feeds.syncRuntimeFeeds([LOCAL, REMOTE_2], reopen)
    for (let i = 0; i < 10; i++) await flush()
    return { feeds, fleet, setSettings, getSettings, remote2, useDocumentStore, useMessageQueueStore, useAppStore, useFleetStore }
  }

  const K = (p: string) => `${HOST_2}\n${p}`

  it('queues, drafts, marks, the fleet copy and the open agent follow it; nothing is said removed', async () => {
    const s = await moved()
    expect(Object.keys(s.useMessageQueueStore.getState().queues)).toEqual([K(PATH)])
    expect(s.useDocumentStore.getState().draftInputs).toEqual({ [K(PATH_2)]: 'draft' })
    expect([...s.useAppStore.getState().startingFilePaths]).toEqual([K(PATH_2)])
    const f = s.useFleetStore.getState()
    expect(f.selection).toEqual([K(PATH_2), PATH_2])
    expect(f.namedGroups).toEqual({ team: [K(PATH), PATH_2] })
    expect(f.stewards).toEqual({ [K(DIR)]: 'did:key:agent-1' })
    expect(f.placement).toEqual({ regionOrigins: { [`${HOST_2}\n`]: { q: 1, r: 2 } }, cellPins: { [K(PATH)]: { q: 3, r: 4 } } })
    // The open agent is host-2's now, opened there (host-2 is connected and does not hold it).
    expect(s.useDocumentStore.getState()).toMatchObject({ filePath: PATH, runtimeId: HOST_2 })
    expect(s.remote2.names()).toContain('openFile')
    const said = await notices()
    expect(said.some((n) => n.includes('removed'))).toBe(false)
    expect(said).toEqual(['host-1 is now host-2; agent-1 reopened.'])
  })

  it('the next fleet save writes host-2\'s entry only, never host-1\'s from the copy read at mount', async () => {
    const s = await moved()
    await s.fleet.saveFleetKeys({ groups: s.useFleetStore.getState().namedGroups }, [LOCAL, REMOTE_2])
    expect(s.setSettings).toHaveBeenLastCalledWith({ fleetGroups: { team: [PATH_2] }, runtimeFleet: { [HOST_2]: { fleetGroups: { team: [PATH] } } } })
  })

  it('R2C-3: the runtime set changed, runtimeFleet is read again from main', async () => {
    const s = await moved({ mainFleet: { [HOST_2]: { fleetGroups: { team: [PATH] }, fleetMapState: { savedAt: 1 } } } })
    expect(s.getSettings).toHaveBeenCalled()
    expect(s.fleet.storedRuntimeFleetOf()).toEqual({ [HOST_2]: { fleetGroups: { team: [PATH] }, fleetMapState: { savedAt: 1 } } })
  })

  it('R2C-2: the Mesh view gets the saved groups, stewards and placement of a runtime it has nothing of; its own keys stay', async () => {
    await page([LOCAL, REMOTE, REMOTE_2])
    const fleet = await import('../../../src/renderer/components/mesh/runtime-fleet')
    const { useFleetStore } = await import('../../../src/renderer/stores/fleet.store')
    useFleetStore.getState().setNamedGroups({ team: [KEY] })
    useFleetStore.getState().setPlacement({ regionOrigins: { [`${HOST_1}
`]: { q: 0, r: 0 } }, cellPins: {} })
    const getSettings = vi.fn(async () => ({ runtimeFleet: {
      [HOST_1]: { fleetGroups: { stale: [PATH] } },
      [HOST_2]: { fleetGroups: { team: [PATH_2] }, fleetStewards: { [DIR]: 'did:key:agent-2' }, fleetMapState: { placement: { regionOrigins: { '': { q: 5, r: 5 } }, cellPins: { [PATH_2]: { q: 6, r: 6 } } } } },
    } }))
    await fleet.reloadRuntimeFleet([LOCAL, REMOTE, REMOTE_2], { getSettings } as never)
    const f = useFleetStore.getState()
    expect(f.namedGroups).toEqual({ team: [KEY, `${HOST_2}
${PATH_2}`] })
    expect(f.stewards).toEqual({ [`${HOST_2}
${DIR}`]: 'did:key:agent-2' })
    expect(f.placement).toEqual({ regionOrigins: { [`${HOST_1}
`]: { q: 0, r: 0 }, [`${HOST_2}
`]: { q: 5, r: 5 } }, cellPins: { [`${HOST_2}
${PATH_2}`]: { q: 6, r: 6 } }, districtAnchors: {} })
  })

  it('R2C-3: a save sends only the fields it saves, per runtime of the set', async () => {
    await page([LOCAL, REMOTE, REMOTE_2])
    const fleet = await import('../../../src/renderer/components/mesh/runtime-fleet')
    fleet.setStoredRuntimeFleet({ [HOST_1]: { fleetGroups: { stale: [PATH] } }, 'remote:gone': { fleetGroups: { old: [PATH] } } })
    const patch = fleet.fleetSettingsPatch({ fleetMapState: { savedAt: 2 } as never }, { [HOST_2]: { fleetMapState: { savedAt: 2 } as never } }, [LOCAL, REMOTE, REMOTE_2])
    expect(patch).toEqual({ fleetMapState: { savedAt: 2 }, runtimeFleet: { [HOST_2]: { fleetMapState: { savedAt: 2 } } } })
  })
})

describe('R2C-4: per-runtime caches go with the runtime', () => {
  it('Remove clears its config caches, model lists and templates; This computer\'s stay', async () => {
    const listModels = vi.fn(async () => ({ models: ['model-1'] }))
    await page([LOCAL, REMOTE], { remote: { listModels } })
    const { syncRuntimeFeeds } = await import('../../../src/renderer/hooks/useRuntimeFeeds')
    const { cachesOf } = await import('../../../src/renderer/utils/config-caches')
    const { loadProviderModels } = await import('../../../src/renderer/hooks/useProviderModels')
    const { useTemplatesStore } = await import('../../../src/renderer/hooks/useTemplates')
    const { useDocumentStore } = await import('../../../src/renderer/stores/document.store')
    syncRuntimeFeeds([LOCAL, REMOTE])
    cachesOf(HOST_1).toolDefs = { fs_read: {} }
    cachesOf('local').toolDefs = { fs_write: {} }
    useDocumentStore.getState().setFilePath(PATH, HOST_1)
    await loadProviderModels('provider-1')
    await loadProviderModels('provider-1')
    expect(listModels).toHaveBeenCalledTimes(1)
    useTemplatesStore.setState({ byRuntime: { [HOST_1]: { templates: [], folder: '/srv/templates', defaultId: 'standard', migrated: null, loaded: true } } })
    syncRuntimeFeeds([LOCAL])
    await flush()
    expect(cachesOf(HOST_1).toolDefs).toBeNull()
    expect(cachesOf('local').toolDefs).toEqual({ fs_write: {} })
    expect(useTemplatesStore.getState().byRuntime[HOST_1]).toBeUndefined()
    // host-1 added again: its list is read again.
    syncRuntimeFeeds([LOCAL, REMOTE])
    useDocumentStore.getState().setFilePath(PATH, HOST_1)
    await loadProviderModels('provider-1')
    expect(listModels).toHaveBeenCalledTimes(2)
  })

  it('a runtime now another computer (replaced) loses them too', async () => {
    await page([LOCAL, REMOTE])
    const { syncRuntimeFeeds, noteRuntimeMoves } = await import('../../../src/renderer/hooks/useRuntimeFeeds')
    const { cachesOf } = await import('../../../src/renderer/utils/config-caches')
    syncRuntimeFeeds([LOCAL, REMOTE])
    cachesOf(HOST_1).toolDefs = { fs_read: {} }
    noteRuntimeMoves({ moves: {}, replaced: [HOST_1] })
    expect(cachesOf(HOST_1).toolDefs).toBeNull()
  })
})

describe('R3B-5: a create that fails after the open agent of another runtime was closed for it', () => {
  async function onHost1(local: Record<string, unknown>) {
    const closeFile = vi.fn(async () => ({ success: true }))
    await page([LOCAL, REMOTE], { local, remote: { closeFile } })
    const alert = vi.fn()
    vi.stubGlobal('alert', alert)
    const { useAdfFile } = await import('../../../src/renderer/hooks/useAdfFile')
    const { useDocumentStore } = await import('../../../src/renderer/stores/document.store')
    const { useEditorTabsStore } = await import('../../../src/renderer/stores/editor-tabs.store')
    useDocumentStore.getState().setFilePath(PATH, HOST_1)
    useEditorTabsStore.getState().openTab('notes.md', 'text', false, undefined, 1)
    let api!: ReturnType<typeof useAdfFile>
    const Probe = (): null => { api = useAdfFile(); return null }
    renderToString(<Probe />)
    return { api, alert, closeFile, useDocumentStore, useEditorTabsStore }
  }

  it('New agent: the closed agent\'s view goes, and the error shows', async () => {
    const t = await onHost1({ createFile: async () => ({ success: false, error: 'agent-2.adf already exists.' }) })
    const result = await t.api.createFile('agent-2')
    expect(result).toMatchObject({ success: false })
    expect(t.closeFile).toHaveBeenCalledTimes(1)
    expect(t.useDocumentStore.getState().filePath).toBeNull()
    expect(t.useEditorTabsStore.getState().tabs).toEqual([])
    expect(t.alert).toHaveBeenCalledTimes(1)
    expect(String(t.alert.mock.calls[0][0])).toContain('agent-2.adf already exists.')
  })

  it('the home composer\'s create: the closed agent\'s view goes; the composer shows the error', async () => {
    const t = await onHost1({ createQuickAgent: async () => ({ success: false, error: 'The agents folder cannot be written.' }) })
    const result = await t.api.createQuickAgent('hello')
    expect(result).toMatchObject({ success: false, error: 'The agents folder cannot be written.' })
    expect(t.closeFile).toHaveBeenCalledTimes(1)
    expect(t.useDocumentStore.getState().filePath).toBeNull()
    expect(t.useEditorTabsStore.getState().tabs).toEqual([])
  })

  it('a create on the runtime of the open agent that fails keeps it, as before', async () => {
    const createFile = vi.fn(async () => ({ success: false, error: 'agent-2.adf already exists.' }))
    await page([LOCAL, REMOTE], { local: { createFile } })
    vi.stubGlobal('alert', vi.fn())
    const { useAdfFile } = await import('../../../src/renderer/hooks/useAdfFile')
    const { useDocumentStore } = await import('../../../src/renderer/stores/document.store')
    useDocumentStore.getState().setFilePath('/home/agents/agent-1.adf', 'local')
    let api!: ReturnType<typeof useAdfFile>
    const Probe = (): null => { api = useAdfFile(); return null }
    renderToString(<Probe />)
    await api.createFile('agent-2')
    expect(useDocumentStore.getState()).toMatchObject({ filePath: '/home/agents/agent-1.adf', runtimeId: 'local' })
  })
})
