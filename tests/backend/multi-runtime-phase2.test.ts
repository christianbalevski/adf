/**
 * Multi-runtime phase 2 in main, shared and preload code
 * (docs/design/multi-runtime.md §4, §6.1): the runtime list of the
 * connections view, Studio calls untagged on a bound surface, and runtime
 * names in OS notifications. With This computer only, each is the one before.
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('./daemon-mode-electron')).electronStub.module)

import { CHANNEL_MAP, type ChannelEntry, type MappedChannel } from '../../src/main/backend/channel-map'
import { STUDIO_CALL_CHANNELS } from '../../src/shared/constants/studio-call-channels'
import { RUNTIME_PUSH_CHANNELS } from '../../src/shared/constants/runtime-push-channels'
import { IPC } from '../../src/shared/constants/ipc-channels'
import { createRuntimeIpc, type IpcRendererLike } from '../../src/shared/runtime-ipc'
import { SavedConnectionsCache, remotesEnv } from '../../src/main/backend/connections'
import { createConnections } from '../../src/main/backend/connections-ipc'
import { createBackendSettingsStore, resolveBootBackend, type SecretCodec } from '../../src/main/backend/backend-config'
import { NativeNotifier, type NativeNotifierPlatform } from '../../src/main/runtime/native-notifier'
import type { RuntimeView } from '../../src/shared/types/connection.types'
import type { PendingNotification } from '../../src/shared/types/ipc.types'

const HOST_1 = 'remote:host-1'
const quiet = { log: () => {}, warn: () => {} }
const dirs: string[] = []
const caches: SavedConnectionsCache[] = []
afterEach(() => {
  for (const c of caches.splice(0)) c.dispose()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('Studio calls (§4.2)', () => {
  it('STUDIO_CALL_CHANNELS is every invoke and send channel of the map that is not runtime-scoped', () => {
    const fromMap = (Object.entries(CHANNEL_MAP) as Array<[MappedChannel, ChannelEntry]>)
      .filter(([, e]) => (e.kind === 'invoke' || e.kind === 'send') && e.scope !== 'runtime')
      .map(([c]) => c)
      .sort()
    expect([...STUDIO_CALL_CHANNELS].sort()).toEqual(fromMap)
  })

  it('a surface bound to another runtime tags its runtime calls and sends Studio calls untagged; This computer\'s sends no tag', () => {
    const emitter = new EventEmitter()
    const invokes: Array<{ channel: string; args: unknown[] }> = []
    const sends: Array<{ channel: string; args: unknown[] }> = []
    const ipc: IpcRendererLike = {
      invoke: async (channel, ...args) => { invokes.push({ channel, args }); return null },
      send: (channel, ...args) => { sends.push({ channel, args }) },
      on: (channel, listener) => emitter.on(channel, listener as (...a: unknown[]) => void),
      removeListener: (channel, listener) => emitter.removeListener(channel, listener as (...a: unknown[]) => void),
    }
    const studio = new Set(STUDIO_CALL_CHANNELS)
    const bound = createRuntimeIpc(ipc, HOST_1, new Set(RUNTIME_PUSH_CHANNELS), studio)
    void bound.invoke(IPC.FILE_OPEN, '/agents/agent-1.adf')
    void bound.invoke(IPC.CONNECTION_LIST)
    void bound.invoke(IPC.WINDOW_OPEN_AGENT, { filePath: '/agents/agent-1.adf', runtimeId: HOST_1 })
    bound.send(IPC.FILE_SHARE_DRAG_START, 'token')
    expect(invokes).toEqual([
      { channel: IPC.FILE_OPEN, args: [{ $runtime: HOST_1 }, '/agents/agent-1.adf'] },
      { channel: IPC.CONNECTION_LIST, args: [] },
      { channel: IPC.WINDOW_OPEN_AGENT, args: [{ filePath: '/agents/agent-1.adf', runtimeId: HOST_1 }] },
    ])
    expect(sends).toEqual([{ channel: IPC.FILE_SHARE_DRAG_START, args: ['token'] }])

    invokes.length = 0
    const local = createRuntimeIpc(ipc, 'local', new Set(RUNTIME_PUSH_CHANNELS), studio)
    void local.invoke(IPC.FILE_OPEN, '/agents/agent-1.adf')
    void local.invoke(IPC.CONNECTION_LIST)
    expect(invokes).toEqual([
      { channel: IPC.FILE_OPEN, args: ['/agents/agent-1.adf'] },
      { channel: IPC.CONNECTION_LIST, args: [] },
    ])
  })
})

describe('the connections view lists the runtime set (§4.5)', () => {
  const codec: SecretCodec = { available: () => true, encrypt: (p) => `safe:${p}`, decrypt: (s) => s.slice(5) }
  function connections(runtimes: RuntimeView[]) {
    const dir = mkdtempSync(join(tmpdir(), 'adf-mr-phase2-'))
    dirs.push(dir)
    const env = { ...remotesEnv(dir), ADF_TEST_KEYCHAIN_FILE: join(dir, 'keychain.json'), ADF_TEST_SEAMS: '1' }
    delete env.ADF_KEYCHAIN
    const boot = resolveBootBackend(join(dir, 'studio-backend.json'), {}, quiet)
    const cache = new SavedConnectionsCache(env)
    caches.push(cache)
    return createConnections({
      boot, backend: createBackendSettingsStore({ boot, codec, log: quiet }), env, saved: cache,
      daemonStatus: () => null, discovery: () => null, confirm: async () => true, push: () => {}, log: quiet,
      runtimes: () => runtimes,
    })
  }
  const LOCAL: RuntimeView = { id: 'local', kind: 'local', name: 'This computer', url: null, state: 'connected' }
  const REMOTE: RuntimeView = { id: HOST_1, kind: 'remote', name: 'host-1', url: 'https://host-1.example:7386', state: 'retrying' }

  it('with This computer only, the view has no runtime list: the one sent before', () => {
    expect('runtimes' in connections([LOCAL]).view()).toBe(false)
    expect('runtimes' in connections([]).view()).toBe(false)
  })

  it('with more than one runtime, the list in its order, each with its state', () => {
    expect(connections([LOCAL, REMOTE]).view().runtimes).toEqual([LOCAL, REMOTE])
  })
})

describe('OS notifications (§6.1)', () => {
  const entry = (id: string, runtimeId?: string): PendingNotification => ({
    id, kind: 'approval', requestId: id, filePath: '/agents/agent-1.adf', agentName: 'agent-1', loop: 'main', toolName: 'fs_write', preview: 'a.md', requestedAt: 1,
    ...(runtimeId ? { runtimeId } : {}),
  } as PendingNotification)

  function notifier(runtimeName?: NativeNotifierPlatform['runtimeName']) {
    const titles: string[] = []
    let clock = 10_000
    const platform: NativeNotifierPlatform = {
      isSupported: () => true,
      isEnabled: () => true,
      isWindowFocused: () => false,
      now: () => (clock += 5_000),
      show: (request) => { titles.push(request.title); return { close: () => {} } },
      reveal: () => {},
      openPanel: () => {},
      ...(runtimeName ? { runtimeName } : {}),
    }
    return { n: new NativeNotifier(platform), titles }
  }

  it('without runtime names (This computer only), the title is the one before', () => {
    const { n, titles } = notifier()
    n.apply({ pending: [entry('n1')], history: [] })
    expect(titles).toEqual(['agent-1 needs approval'])
  })

  it('names the runtime before the agent, and equal ids on two runtimes are two notifications', () => {
    const { n, titles } = notifier((e) => (e.runtimeId === HOST_1 ? 'host-1' : 'This computer'))
    n.apply({ pending: [entry('n1')], history: [] })
    n.apply({ pending: [entry('n1'), entry('n1', HOST_1)], history: [] })
    expect(titles).toEqual(['This computer · agent-1 needs approval', 'host-1 · agent-1 needs approval'])
  })
})
