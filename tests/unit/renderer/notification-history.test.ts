import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useApprovalsStore } from '../../../src/renderer/stores/approvals.store'
import type { NotificationHistoryPage, ResolvedNotification } from '../../../src/shared/types/ipc.types'

const receipt = (id: string): ResolvedNotification => ({
  id, requestId: id, kind: 'approval', filePath: '/agent.adf', agentName: 'Agent', loop: 'main',
  preview: 'Write a file', requestedAt: 1, resolvedAt: 2, outcome: 'approved',
})
const state = () => useApprovalsStore.getState()
beforeEach(() => state().reset())
afterEach(() => { vi.unstubAllGlobals(); state().reset() })

describe('notification history browsing', () => {
  it('routes pages to their runtime and replaces, rather than accumulates, the page', async () => {
    const remoteRead = vi.fn().mockResolvedValueOnce({ history: [receipt('newer')], nextBefore: 25 }).mockResolvedValueOnce({ history: [receipt('older')], nextBefore: null })
    const localRead = vi.fn()
    const runtime = vi.fn(() => ({ getNotificationHistory: remoteRead }))
    vi.stubGlobal('adfApi', { runtimeId: 'local', getNotificationHistory: localRead, runtime })
    await state().browseHistory('remote:one')
    expect(state().historyPage?.nextBefore).toBe(25)
    await state().browseHistory('remote:one', 25)
    expect(remoteRead).toHaveBeenLastCalledWith(25)
    expect(localRead).not.toHaveBeenCalled()
    expect(runtime).toHaveBeenCalledWith('remote:one')
    expect(state().historyPage).toEqual({ history: [receipt('older')], nextBefore: null, runtimeId: 'remote:one' })
  })

  it('keeps browsing through pending-only snapshots', async () => {
    const history = [receipt('recent')]
    state().setSnapshot({ pending: [], history })
    vi.stubGlobal('adfApi', { getNotificationHistory: vi.fn().mockResolvedValue({ history: [receipt('old')], nextBefore: null }) })
    await state().browseHistory('local')
    const page = state().historyPage
    state().setSnapshot({ pending: [{ ...receipt('pending') }], history: history.map((entry) => ({ ...entry })) })
    expect(state().history).toBe(history)
    expect(state().historyPage).toBe(page)
  })

  it('discards an in-flight response when history is cleared, even if new receipts arrive', async () => {
    state().setSnapshot({ pending: [], history: [receipt('recent')] })
    let finish!: (page: NotificationHistoryPage) => void
    vi.stubGlobal('adfApi', { getNotificationHistory: () => new Promise<NotificationHistoryPage>((resolve) => { finish = resolve }) })
    const request = state().browseHistory('local')
    state().setSnapshot({ pending: [], history: [] })
    state().setSnapshot({ pending: [], history: [receipt('new')] })
    finish({ history: [receipt('cleared')], nextBefore: null })
    await request
    expect(state().historyPage).toBeNull()
    expect(state().historyLoading).toBe(false)
    expect(state().history.map((entry) => entry.id)).toEqual(['new'])
  })

  it('Back to recent cancels an outstanding page without restoring it later', async () => {
    let finish!: (page: NotificationHistoryPage) => void
    vi.stubGlobal('adfApi', { getNotificationHistory: () => new Promise<NotificationHistoryPage>((resolve) => { finish = resolve }) })
    const request = state().browseHistory('local')
    state().showRecentHistory()
    finish({ history: [receipt('old')], nextBefore: null })
    await request
    expect(state().historyPage).toBeNull()
    expect(state().historyLoading).toBe(false)
  })

  it('reports a page failure and preserves the current page for retry', async () => {
    const read = vi.fn().mockResolvedValueOnce({ history: [receipt('page')], nextBefore: 10 }).mockRejectedValueOnce(new Error('Runtime unavailable'))
    vi.stubGlobal('adfApi', { getNotificationHistory: read })
    await state().browseHistory('local')
    const page = state().historyPage
    await state().browseHistory('local', 10)
    expect(state().historyError).toBe('Runtime unavailable')
    expect(state().historyPage).toBe(page)
    expect(state().historyLoading).toBe(false)
  })
})
