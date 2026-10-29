import { afterEach, describe, expect, it, vi } from 'vitest'
import { browserIpc } from '../../src/web/browser-ipc'
import { WebTransport } from '../../src/web/transport'
import { IPC } from '../../src/shared/constants/ipc-channels'
import { browserId, claimBrowserClient, readStored } from '../../src/web/browser-storage'

function storage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial))
  return {
    getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) },
    removeItem: (key) => { values.delete(key) }, clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null, get length() { return values.size },
  }
}
class Channel {
  static peers: Channel[] = []
  onmessage: ((event: { data: unknown }) => void) | null = null
  constructor() { Channel.peers.push(this) }
  postMessage(data: unknown) { for (const other of Channel.peers) if (other !== this) queueMicrotask(() => other.onmessage?.({ data })) }
  close() { Channel.peers = Channel.peers.filter((peer) => peer !== this) }
}

describe('browser client storage', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); Channel.peers = [] })
  it('generates UUIDs without secure-context randomUUID on a LAN origin', () => {
    vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array) => { bytes.fill(1); return bytes } })
    expect(browserId()).toBe('01010101-0101-4101-8101-010101010101')
  })
  it('recovers gracefully from corrupt or blocked storage reads', () => {
    expect(readStored(storage({ key: '{bad' }), 'key', [])).toEqual([])
    expect(readStored({ getItem: () => { throw new Error('blocked') } } as unknown as Storage, 'key', null)).toBeNull()
  })
  it('retains a tab ID on reload but splits a duplicated live tab', async () => {
    vi.useFakeTimers()
    const saved = storage({ client: 'existing-browser-tab' })
    vi.stubGlobal('sessionStorage', saved)
    vi.stubGlobal('BroadcastChannel', Channel)
    vi.stubGlobal('window', { addEventListener: vi.fn() })
    const first = claimBrowserClient('client')
    await vi.advanceTimersByTimeAsync(130)
    expect(await first).toBe('existing-browser-tab')
    const second = claimBrowserClient('client')
    await vi.advanceTimersByTimeAsync(130)
    expect(await second).not.toBe('existing-browser-tab')
    expect(saved.getItem('client')).not.toBe('existing-browser-tab')
  })
})


describe('browser IPC session storage isolation', () => {
  afterEach(() => vi.unstubAllGlobals())
  function setup(search = '') {
    const local = storage()
    vi.stubGlobal('localStorage', local)
    vi.stubGlobal('sessionStorage', storage())
    vi.stubGlobal('location', { search, href: `http://localhost/studio/${search}` })
    vi.stubGlobal('window', { setInterval: vi.fn(), addEventListener: vi.fn() })
    vi.stubGlobal('document', { addEventListener: vi.fn() })
    vi.stubGlobal('navigator', { locks: { request: (_name: string, run: () => unknown) => run() } })
    return local
  }
  function ipc(scope: string, recoveryScope = scope, clientId = 'same-browser-tab') {
    return browserIpc(new WebTransport(clientId, scope, () => {}, vi.fn(), class {} as typeof EventSource), scope, recoveryScope)
  }
  it('does not silently perform a browser-local operation for another runtime', async () => {
    setup()
    await expect(ipc('first-session-scope').invoke(IPC.FILE_REVEAL, { $runtime: 'another-daemon' }, { filePath: '/agent.adf' })).rejects.toThrow('other daemon')
  })
  it('keeps a previous sign-in’s recovery copies out of the next sign-in', async () => {
    setup()
    const first = ipc('first-session-scope')
    const second = ipc('second-session-scope')
    await first.invoke(IPC.RECOVERY_STASH, { agentFilePath: '/agent.adf', path: 'README.md', content: 'private edit' })
    expect((await first.invoke(IPC.RECOVERY_LIST)).files).toHaveLength(1)
    expect((await second.invoke(IPC.RECOVERY_LIST)).files).toEqual([])
  })
  it('retains recovery copies after the same principal signs in again', async () => {
    setup()
    await ipc('first-session-scope', 'same-device-identity').invoke(IPC.RECOVERY_STASH, { agentFilePath: '/agent.adf', path: 'README.md', content: 'recover me' })
    expect((await ipc('second-session-scope', 'same-device-identity').invoke(IPC.RECOVERY_LIST)).files).toHaveLength(1)
  })
  it('keeps separate atomic recovery copies when two tabs edit the same file', async () => {
    const local = setup()
    const first = ipc('first-session-scope', 'same-device-identity', 'first-browser-tab')
    const second = ipc('first-session-scope', 'same-device-identity', 'second-browser-tab')
    await Promise.all([
      first.invoke(IPC.RECOVERY_STASH, { agentFilePath: '/agent.adf', path: 'README.md', content: 'first tab edit' }),
      second.invoke(IPC.RECOVERY_STASH, { agentFilePath: '/agent.adf', path: 'README.md', content: 'second tab edit' }),
    ])
    expect((await first.invoke(IPC.RECOVERY_LIST)).files).toHaveLength(2)
    const values = Array.from({ length: local.length }, (_, i) => local.getItem(local.key(i)!))
    expect(values.some(value => value?.includes('first tab edit'))).toBe(true)
    expect(values.some(value => value?.includes('second tab edit'))).toBe(true)
    await first.invoke(IPC.RECOVERY_STASH, { agentFilePath: '/agent.adf', path: 'README.md', content: null })
    expect((await second.invoke(IPC.RECOVERY_LIST)).files).toHaveLength(1)
  })
  it('reads legacy recovery arrays and does not resurrect cleared copies', async () => {
    const local = setup()
    local.setItem('adf.web.recovery.same-device-identity', JSON.stringify([
      { agentFilePath: '/agent.adf', path: 'README.md', content: 'old readme', modifiedAt: 1 },
      { agentFilePath: '/agent.adf', path: 'notes.md', content: 'old notes', modifiedAt: 1 },
    ]))
    const api = ipc('first-session-scope', 'same-device-identity')
    expect((await api.invoke(IPC.RECOVERY_LIST)).files).toHaveLength(2)
    await api.invoke(IPC.RECOVERY_STASH, { agentFilePath: '/agent.adf', path: 'README.md', content: null })
    await api.invoke(IPC.RECOVERY_STASH, { agentFilePath: '/agent.adf', path: 'notes.md', content: 'new notes' })
    expect((await api.invoke(IPC.RECOVERY_LIST)).files.map((file: { path: string }) => file.path)).toEqual(['notes.md'])
    expect(await api.invoke(IPC.RECOVERY_ARCHIVE)).toEqual({ moved: 1 })
    expect((await api.invoke(IPC.RECOVERY_LIST)).files).toEqual([])
  })
  it('does not remove a new recovery copy written while older copies are archived', async () => {
    const local = setup()
    const first = ipc('first-session-scope', 'same-device-identity', 'first-browser-tab')
    const second = ipc('first-session-scope', 'same-device-identity', 'second-browser-tab')
    await first.invoke(IPC.RECOVERY_STASH, { agentFilePath: '/agent.adf', path: 'README.md', content: 'old edit' })
    const set = local.setItem.bind(local)
    local.setItem = (key, value) => {
      set(key, value)
      if (key.includes('.archive.')) void second.invoke(IPC.RECOVERY_STASH, { agentFilePath: '/agent.adf', path: 'README.md', content: 'new edit' })
    }
    await first.invoke(IPC.RECOVERY_ARCHIVE)
    expect((await first.invoke(IPC.RECOVERY_LIST)).files).toHaveLength(1)
    const remaining = Array.from({ length: local.length }, (_, i) => local.key(i)!).filter(key => key.includes('.entry.')).map(key => local.getItem(key))
    expect(remaining).toHaveLength(1)
    expect(remaining[0]).toContain('new edit')
  })
  it('does not hand a previous sign-in’s messages to the next sign-in', async () => {
    const local = setup()
    const queue = [{ filePath: '/agent.adf', loop: 'main', messages: [{ text: 'pending mutation' }] }]
    local.setItem('adf.web.session.first-session-scope.tab.old-tab', JSON.stringify({
      clientId: 'old-tab', filePath: '/agent.adf', agentId: null, runtimeId: 'local', seen: 0, closed: true, queue,
    }))
    expect(await ipc('second-session-scope').invoke(IPC.QUEUE_HANDOVER_TAKE)).toEqual([])
    expect(await ipc('first-session-scope').invoke(IPC.QUEUE_HANDOVER_TAKE)).toEqual(queue)
  })

  it('does not release queued messages when the browser refuses to close an agent tab', async () => {
    const local = setup('?window=agent&file=%2Fagent.adf')
    Object.assign(window, { close: vi.fn(), closed: false })
    const api = ipc('first-session-scope')
    const queue = [{ filePath: '/agent.adf', messages: [{ text: 'send once' }] }]
    await api.invoke(IPC.WINDOW_QUEUE_SYNC, queue)
    expect(await api.invoke(IPC.WINDOW_CLOSE)).toEqual({ success: false })
    expect(JSON.parse(local.getItem('adf.web.session.first-session-scope.tab.same-browser-tab')!).closed).toBe(false)
    expect(await api.invoke(IPC.QUEUE_HANDOVER_TAKE)).toEqual([])
    expect(await api.invoke(IPC.WINDOW_QUEUE_GET)).toEqual(queue)
  })

  it('recovers a crashed child only after observing that its window is closed', async () => {
    const local = setup()
    const child = { closed: false, opener: null, focus: vi.fn(), sessionStorage: storage() }
    Object.assign(window, { open: vi.fn(() => child) })
    const api = ipc('first-session-scope')
    await api.invoke(IPC.WINDOW_OPEN_AGENT, { filePath: '/agent.adf' })
    const tabId = new URL(vi.mocked(window.open).mock.calls[0][0]!.toString()).searchParams.get('tab')
    child.sessionStorage.setItem(`adf.web.client.${tabId}`, 'crashed-child')
    const queue = [{ filePath: '/agent.adf', messages: [{ text: 'recover once' }] }]
    const key = 'adf.web.session.first-session-scope.tab.crashed-child'
    local.setItem(key, JSON.stringify({ clientId: 'crashed-child', filePath: '/agent.adf', runtimeId: 'local', seen: 0, closed: false, tabId, queue }))
    expect((await api.invoke(IPC.WINDOW_LIST_AGENTS)).windows).toHaveLength(1)
    expect(await api.invoke(IPC.QUEUE_HANDOVER_TAKE)).toEqual([])
    // A duplicated tab has the same URL/tab id, but a different live claim.
    const duplicateKey = 'adf.web.session.first-session-scope.tab.live-duplicate'
    local.setItem(duplicateKey, JSON.stringify({ clientId: 'live-duplicate', filePath: '/duplicate.adf', runtimeId: 'local', seen: 0, closed: false, tabId, queue }))
    child.closed = true
    expect((await api.invoke(IPC.WINDOW_LIST_AGENTS)).windows).toEqual([{ filePath: '/duplicate.adf', agentId: undefined, runtimeId: 'local' }])
    expect(await api.invoke(IPC.QUEUE_HANDOVER_TAKE)).toEqual(queue)
    expect(await api.invoke(IPC.QUEUE_HANDOVER_TAKE)).toEqual([])
  })

  it('preserves pending messages if cross-tab handover cannot be serialized', async () => {
    const local = setup()
    vi.stubGlobal('navigator', {})
    const queue = [{ filePath: '/agent.adf', messages: [{ text: 'preserve me' }] }]
    const key = 'adf.web.session.first-session-scope.tab.old-child'
    local.setItem(key, JSON.stringify({ clientId: 'old-child', filePath: '/agent.adf', runtimeId: 'local', seen: 0, closed: true, queue }))
    await expect(ipc('first-session-scope').invoke(IPC.QUEUE_HANDOVER_TAKE)).rejects.toThrow('remain saved')
    expect(JSON.parse(local.getItem(key)!).queue).toEqual(queue)
  })
})
