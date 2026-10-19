/**
 * Agent windows in the renderer (docs/design/agent-windows.md): which window
 * the page is, the agent window's open guard and close, its error state, the
 * notice filter, and the queued messages a closed window hands over.
 */
import React from 'react'
import { renderToStaticMarkup, renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NotificationsSnapshot, PendingNotification } from '../../../src/shared/types/ipc.types'

// Vitest compiles JSX with the classic runtime (the renderer build uses the automatic one).
;(globalThis as { React?: typeof React }).React = React

const FILE_1 = '/agents/agent-1.adf'
const FILE_2 = '/agents/agent-2.adf'

/** A page loaded with `search`, and the window.adfApi it sees. */
async function page(search: string, adfApi: Record<string, unknown> = {}) {
  vi.resetModules()
  vi.stubGlobal('window', { location: { search }, adfApi: { platform: 'linux', ...adfApi } })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  return import('../../../src/renderer/utils/window-kind')
}

afterEach(() => { vi.unstubAllGlobals() })

describe('window kind', () => {
  it('reads the page query once', async () => {
    const agent = await page(`?window=agent&file=${encodeURIComponent(FILE_1)}`)
    expect(agent).toMatchObject({ isAgentWindow: true, agentWindowFile: FILE_1, agentWindowsAvailable: false })
    const main = await page('?agentWindows=1')
    expect(main).toMatchObject({ isAgentWindow: false, agentWindowFile: null, agentWindowsAvailable: true })
    const embedded = await page('')
    expect(embedded).toMatchObject({ isAgentWindow: false, agentWindowFile: null, agentWindowsAvailable: false })
  })
})

describe('an agent window keeps its agent', () => {
  async function probe(adfApi: Record<string, unknown>) {
    await page(`?window=agent&file=${encodeURIComponent(FILE_1)}`, adfApi)
    const { useAdfFile } = await import('../../../src/renderer/hooks/useAdfFile')
    const { useDocumentStore } = await import('../../../src/renderer/stores/document.store')
    let api!: ReturnType<typeof useAdfFile>
    const Probe = (): null => { api = useAdfFile(); return null }
    renderToString(<Probe />)
    return { api, useDocumentStore }
  }

  it('another agent opens in its own window; this one stays', async () => {
    const openAgentWindow = vi.fn(async () => ({ success: true }))
    const openFile = vi.fn()
    const { api, useDocumentStore } = await probe({ openAgentWindow, openFile })
    useDocumentStore.getState().setFilePath(FILE_1)
    await api.openFile(FILE_2)
    expect(openAgentWindow).toHaveBeenCalledWith({ filePath: FILE_2 })
    expect(openFile).not.toHaveBeenCalled()
    expect(useDocumentStore.getState().filePath).toBe(FILE_1)
  })

  it('closing the agent (Close Agent, a cancelled dialog) closes the window, not the file in main', async () => {
    const closeAgentWindow = vi.fn(async () => ({ success: true }))
    const closeFile = vi.fn()
    const { api } = await probe({ closeAgentWindow, closeFile })
    await api.closeFile()
    expect(closeAgentWindow).toHaveBeenCalledTimes(1)
    expect(closeFile).not.toHaveBeenCalled()
  })
})

describe('opening the window\'s agent', () => {
  async function opener(adfApi: Record<string, unknown>) {
    await page(`?window=agent&file=${encodeURIComponent(FILE_1)}`, adfApi)
    const { openWindowAgent } = await import('../../../src/renderer/utils/agent-window')
    const { useAgentWindowStore } = await import('../../../src/renderer/stores/agent-window.store')
    const { useDocumentStore } = await import('../../../src/renderer/stores/document.store')
    return { openWindowAgent, useAgentWindowStore, useDocumentStore }
  }

  it('opens the file its session has (a rename), else the query\'s', async () => {
    const { openWindowAgent, useDocumentStore } = await opener({ getCurrentFile: async () => ({ filePath: '/agents/renamed.adf' }) })
    const openFile = vi.fn(async (filePath: string) => { useDocumentStore.getState().setFilePath(filePath); return { success: true } })
    await openWindowAgent(openFile)
    expect(openFile).toHaveBeenCalledWith('/agents/renamed.adf')
  })

  it('a refused or rejected open is the error state, and main hears of it', async () => {
    const agentWindowOpenFailed = vi.fn(async () => {})
    const { openWindowAgent, useAgentWindowStore } = await opener({ getCurrentFile: async () => ({ filePath: null }), agentWindowOpenFailed })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await openWindowAgent(async () => ({ success: false, error: 'No such agent file' }))
    expect(useAgentWindowStore.getState()).toMatchObject({ status: 'failed', error: 'No such agent file' })
    await openWindowAgent(async () => { throw new Error('daemon away') })
    expect(useAgentWindowStore.getState()).toMatchObject({ status: 'failed', error: 'daemon away' })
    expect(agentWindowOpenFailed).toHaveBeenCalledTimes(2)
  })
})

describe('the agent window\'s layout', () => {
  it('no sidebar; the error with Retry and Close window when its agent did not open', async () => {
    await page(`?window=agent&file=${encodeURIComponent(FILE_1)}`)
    const { AppShell } = await import('../../../src/renderer/components/layout/AppShell')
    const { AgentWindowStatusView } = await import('../../../src/renderer/components/layout/AgentWindowStatus')
    const opening = renderToStaticMarkup(<AppShell />)
    expect(opening).toContain('aria-label="Opening the agent"')
    expect(opening).not.toContain('Application navigation')
    // The store's state as the window shows it (server rendering reads a store's first state only).
    const failed = renderToStaticMarkup(<AgentWindowStatusView status="failed" error="No such agent file" onRetry={() => {}} onClose={() => {}} />)
    expect(failed).toContain('The agent did not open.')
    expect(failed).toContain('No such agent file')
    expect(failed).toContain('>Retry<')
    expect(failed).toContain('>Close window<')
  }, 30_000)

  it('the main window keeps its navigation', async () => {
    await page('?agentWindows=1')
    const { AppShell } = await import('../../../src/renderer/components/layout/AppShell')
    const html = renderToStaticMarkup(<AppShell />)
    expect(html).toContain('Application navigation')
    expect(html).not.toContain('The agent did not open.')
  }, 30_000)
})

describe('notices', () => {
  const n = (id: string, filePath: string): PendingNotification => ({ id, kind: 'approval', requestId: id, filePath, agentName: 'agent-1', loop: 'main', preview: '', requestedAt: 1 })

  it('a toast only for requests main names for this window, never for its own open agent', async () => {
    await page('?agentWindows=1')
    const { arrivalsToAnnounce } = await import('../../../src/renderer/hooks/useApprovals')
    const seen = new Set<string>()
    const snapshot: NotificationsSnapshot = { pending: [n('n1', FILE_1), n('n2', FILE_2), n('n3', FILE_2)], history: [], notify: ['n1', 'n2'] }
    expect(arrivalsToAnnounce(snapshot, seen, FILE_1).map((x) => x.id)).toEqual(['n2'])
    // Seen once: no second toast. Without `notify` (no agent window) the window decides alone.
    expect(arrivalsToAnnounce({ ...snapshot, pending: [...snapshot.pending, n('n4', FILE_2)], notify: undefined }, seen, FILE_1).map((x) => x.id)).toEqual(['n4'])
    // Answered ids are forgotten.
    arrivalsToAnnounce({ pending: [], history: [] }, seen, null)
    expect(seen.size).toBe(0)
  })
})

describe('queued messages of a closed agent window', () => {
  it('the main window queues them and sends at once when the loop is idle', async () => {
    const invokeAgent = vi.fn(async () => ({ success: true }))
    await page('?agentWindows=1', { invokeAgent })
    const { adoptQueueHandover, queueEntries } = await import('../../../src/renderer/utils/agent-window')
    const { useBackgroundAgentsStore } = await import('../../../src/renderer/stores/background-agents.store')
    const { useMessageQueueStore, selectQueue } = await import('../../../src/renderer/stores/message-queue.store')
    useBackgroundAgentsStore.getState().setAgents([{ filePath: FILE_1, handle: 'agent-1', state: 'idle' }, { filePath: FILE_2, handle: 'agent-2', state: 'active' }])
    vi.spyOn(console, 'info').mockImplementation(() => {})
    adoptQueueHandover([
      { filePath: FILE_1, loop: 'main', messages: [{ id: 'a', text: 'one' }, { id: 'b', text: 'two' }] },
      { filePath: FILE_2, loop: 'main', messages: [{ id: 'c', text: 'later' }] },
    ])
    expect(invokeAgent).toHaveBeenCalledWith('one\n\ntwo', FILE_1, [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }], 'main')
    // A busy loop keeps them for its turn end.
    expect(selectQueue(useMessageQueueStore.getState(), FILE_2, 'main').map((m) => m.text)).toEqual(['later'])
    // What an agent window mirrors: its agent under its own path, no image previews.
    expect(queueEntries({ [FILE_2]: { main: [{ id: 'x', text: 'hi', imagePreviewUrls: ['blob:x'] } as never] } }, FILE_2))
      .toEqual([{ filePath: FILE_2, loop: 'main', messages: [{ id: 'x', text: 'hi' }] }])
  })
})
