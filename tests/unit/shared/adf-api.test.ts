import { describe, expect, it, vi } from 'vitest'
import { createAdfApi } from '../../../src/shared/adf-api'
import { IPC } from '../../../src/shared/constants/ipc-channels'
import type { IpcListener, RuntimeIpc } from '../../../src/shared/runtime-ipc'

function host(platform: 'darwin' | 'web') {
  const listeners = new Map<string, Set<IpcListener>>()
  const ipc: RuntimeIpc = {
    runtimeId: 'local',
    invoke: vi.fn(async () => ({ success: true })),
    send: vi.fn(),
    on(channel, listener) {
      const subscriptions = listeners.get(channel) ?? new Set()
      subscriptions.add(listener)
      listeners.set(channel, subscriptions)
    },
    removeListener(channel, listener) { listeners.get(channel)?.delete(listener) },
  }
  const setZoomFactor = vi.fn()
  return { api: createAdfApi(ipc, { platform, setZoomFactor }), ipc, listeners, setZoomFactor }
}

describe('shared Studio API factory', () => {
  it('opens browser Studio without accepting a renderer-selected destination or token', async () => {
    const { api, ipc } = host('darwin')
    await api.openStudioInBrowser()
    expect(ipc.invoke).toHaveBeenCalledExactlyOnceWith(IPC.STUDIO_OPEN_BROWSER)
  })

  it('preserves optimistic-concurrency payloads on desktop and browser transports', async () => {
    for (const platform of ['darwin', 'web'] as const) {
      const { api, ipc } = host(platform)
      await api.setDocument('updated', { baseRevision: 4 })
      expect(ipc.invoke).toHaveBeenLastCalledWith(IPC.DOC_SET_DOCUMENT, { content: 'updated', baseRevision: 4 })
      await api.setDocument('new')
      expect(ipc.invoke).toHaveBeenLastCalledWith(IPC.DOC_SET_DOCUMENT, { content: 'new' })
      expect(api.platform).toBe(platform)
    }
  })

  it('delivers only the event payload and removes exactly its own subscription', () => {
    const { api, listeners } = host('web')
    const first = vi.fn()
    const second = vi.fn()
    const off = api.onFileRenamed(first)
    api.onFileRenamed(second)
    const payload = { oldPath: '/before.adf', newPath: '/after.adf' }
    for (const listener of listeners.get(IPC.FILE_RENAMED)!) listener({}, payload)
    expect(first).toHaveBeenCalledWith(payload)
    expect(second).toHaveBeenCalledWith(payload)
    off()
    first.mockClear()
    second.mockClear()
    for (const listener of listeners.get(IPC.FILE_RENAMED)!) listener({}, payload)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledOnce()
  })

  it('delegates valid zoom values to the host without requiring Electron', () => {
    const { api, setZoomFactor } = host('web')
    for (const factor of [NaN, Infinity, 0, -1]) api.setZoomFactor(factor)
    expect(setZoomFactor).not.toHaveBeenCalled()
    api.setZoomFactor(1.25)
    expect(setZoomFactor).toHaveBeenCalledExactlyOnceWith(1.25)
  })
})
