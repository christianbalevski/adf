/**
 * Host grouping and runtime names (docs/design/multi-runtime.md §5.4, §6.1,
 * §9.3): with This computer only, the sidebar, Go to Agent and the bell show
 * no runtime name or group; with more than one runtime, one group per runtime
 * in the set's order, and every row names its runtime. The same path on two
 * runtimes stays two rows.
 *
 * No jsdom: components render to static markup (effects do not run, so no
 * IPC is made).
 */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionsView, RuntimeView } from '../../../src/shared/types/connection.types'
import type { PendingNotification, TrackedDirEntry } from '../../../src/shared/types/ipc.types'

// Vitest compiles JSX with the classic runtime (the renderer build uses the automatic one).
;(globalThis as { React?: typeof React }).React = React

// A static render reads a zustand store's server snapshot, its initial state.
// Here it reads the state the test set, as the window would.
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
const DIR = '/agents'
const AGENT_1 = '/agents/agent-1.adf'
const AGENT_2 = '/agents/agent-2.adf'
const ID_1 = '0b7c6f1e-2d4a-4c55-9a0e-3f1c2b7a9e11'
const ID_2 = '5d2e8a90-7b13-4f6e-8c21-9e4d0a6b3c77'

const LOCAL: RuntimeView = { id: 'local', kind: 'local', name: 'This computer', url: null, state: 'connected' }
const REMOTE: RuntimeView = { id: HOST_1, kind: 'remote', name: 'host-1', url: 'https://host-1.example:7386', state: 'connected' }

const entry = (filePath: string, agentId: string): TrackedDirEntry => ({ filePath, fileName: filePath.split('/').pop()!, agentName: filePath.split('/').pop()!.replace('.adf', ''), agentId })

function view(runtimes?: RuntimeView[]): ConnectionsView {
  return { current: { id: 'local', kind: 'local', name: 'This computer', url: null, state: 'connected' }, next: null, rows: [], discovery: null, ...(runtimes ? { runtimes } : {}) }
}

/**
 * A main window page with This computer's folder (agent-1) and, on host-1,
 * the same folder with agent-1 (same path and id) and agent-2.
 */
async function page(runtimes: RuntimeView[] | undefined) {
  vi.resetModules()
  vi.stubGlobal('window', { location: { search: '?agentWindows=1' }, adfApi: { platform: 'linux' }, addEventListener: () => {}, removeEventListener: () => {} })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  const { useConnectionStore } = await import('../../../src/renderer/stores/connection.store')
  const { useTrackedDirsStore } = await import('../../../src/renderer/stores/tracked-dirs.store')
  await import('../../../src/renderer/stores/runtimes.store')
  useConnectionStore.getState().setView(view(runtimes))
  const tracked = useTrackedDirsStore.getState()
  tracked.setDirectories([DIR])
  tracked.setFilesForDir(DIR, [entry(AGENT_1, ID_1)])
  tracked.setDirectories([DIR], HOST_1)
  tracked.setFilesForDir(DIR, [entry(AGENT_1, ID_1), entry(AGENT_2, ID_2)], HOST_1)
  return {
    sidebar: async () => {
      const { Sidebar } = await import('../../../src/renderer/components/layout/Sidebar')
      return renderToStaticMarkup(<Sidebar />)
    },
  }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('sidebar', () => {
  it('This computer only: no group and no runtime name; the same markup as with no runtime list at all', async () => {
    const before = await (await page(undefined)).sidebar()
    const one = await (await page([LOCAL])).sidebar()
    expect(one).toBe(before)
    expect(one).not.toContain('This computer')
    expect(one).not.toContain('host-1')
    expect(one.match(/agent-1/g)?.length).toBeGreaterThan(0)
    expect(one).not.toContain('agent-2')
  })

  it('more than one runtime: one group per runtime, This computer first; the same path on both is two rows', async () => {
    const html = await (await page([LOCAL, REMOTE])).sidebar()
    const local = html.indexOf('This computer')
    const remote = html.indexOf('host-1')
    expect(local).toBeGreaterThan(-1)
    expect(remote).toBeGreaterThan(local)
    // agent-1 on This computer, then agent-1 and agent-2 on host-1.
    const rows = [...html.matchAll(/data-active[^>]*>|>(agent-\d)</g)].map((m) => m[1]).filter(Boolean)
    expect(rows).toEqual(['agent-1', 'agent-1', 'agent-2'])
  })

  it('a runtime that is down says so in its header, and its folders are inert', async () => {
    const html = await (await page([LOCAL, { ...REMOTE, state: 'retrying' }])).sidebar()
    expect(html).toContain('host-1 · Not connected, retrying')
    expect(html).toContain('aria-disabled="true"')
  })
})

describe('bell rows', () => {
  const approval = (runtimeId?: string): PendingNotification => ({
    id: 'n1', kind: 'approval', filePath: AGENT_1, agentName: 'agent-1', loop: 'main', requestId: 'n1', toolName: 'fs_write', preview: 'a.md', requestedAt: 1,
    ...(runtimeId ? { runtimeId } : {}),
  } as PendingNotification)

  async function row(runtimes: RuntimeView[] | undefined, runtimeId?: string): Promise<string> {
    await page(runtimes)
    const { ApprovalRow } = await import('../../../src/renderer/components/layout/ApprovalsMenu')
    return renderToStaticMarkup(<ApprovalRow approval={approval(runtimeId)} now={2} onJump={() => {}} onInspect={() => {}} />)
  }

  it('name no runtime with This computer only', async () => {
    const html = await row([LOCAL])
    expect(html).toContain('>agent-1<')
    expect(html).not.toContain('This computer')
  })

  it('name the runtime before the agent with more than one, This computer too', async () => {
    expect(await row([LOCAL, REMOTE], HOST_1)).toContain('host-1 · agent-1')
    expect(await row([LOCAL, REMOTE])).toContain('This computer · agent-1')
  })

  it('cannot be answered while their runtime is down', async () => {
    const html = await row([LOCAL, { ...REMOTE, state: 'retrying' }], HOST_1)
    expect(html.match(/<button[^>]*disabled=""[^>]*>(Approve|Reject)<\/button>/g)).toHaveLength(2)
  })
})

describe('Go to Agent', () => {
  it('shows the runtime name after the agent name only when an agent carries one', async () => {
    await page([LOCAL, REMOTE])
    const { SwitcherView } = await import('../../../src/renderer/components/common/AgentSwitcher')
    const { rankAgents } = await import('../../../src/renderer/utils/agent-switcher')
    const agents = [
      { filePath: AGENT_1, name: 'agent-1', folder: 'agents', running: false, needsYou: 0, runtimeName: 'This computer' },
      { filePath: AGENT_1, name: 'agent-1', folder: 'agents', running: false, needsYou: 0, runtimeId: HOST_1, runtimeName: 'host-1' },
    ]
    const noop = () => {}
    const html = renderToStaticMarkup(
      <SwitcherView listId="switcher" query="" matches={rankAgents(agents, '')} current={0} openFilePath={AGENT_1} onQuery={noop} onKeyDown={noop} onHover={noop} onChoose={noop} />
    )
    const options = [...html.matchAll(/<li id="[^"]+" role="option"[^>]*>(.*?)<\/li>/g)].map((m) => m[1])
    expect(options).toHaveLength(2)
    expect(options[0]).toContain('This computer')
    expect(options[0]).toContain('Open')
    expect(options[1]).toContain('host-1')
    expect(options[1]).not.toContain('>Open<')
    const plain = renderToStaticMarkup(
      <SwitcherView listId="switcher" query="" matches={rankAgents([{ filePath: AGENT_1, name: 'agent-1', folder: 'agents', running: false, needsYou: 0 }], '')} current={0} openFilePath={AGENT_1} onQuery={noop} onKeyDown={noop} onHover={noop} onChoose={noop} />
    )
    expect(plain).not.toContain('This computer')
  })
})
