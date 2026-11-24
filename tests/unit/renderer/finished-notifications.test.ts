import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NOTIFICATIONS_SEEN_KEY, unreadFinished, useApprovalsStore } from '../../../src/renderer/stores/approvals.store'
import { newFinished } from '../../../src/shared/utils/finished-notices'
import type { ResolvedNotification } from '../../../src/shared/types/ipc.types'

const NOW = 1_000_000
const finished = (id: string, resolvedAt = NOW, over: Partial<ResolvedNotification> = {}): ResolvedNotification => ({
  id, requestId: id, kind: 'finished', filePath: `/agents/${id}.adf`, agentName: id, loop: 'main',
  preview: 'Report ready', requestedAt: resolvedAt, resolvedAt, outcome: 'completed', ...over,
})
const state = () => useApprovalsStore.getState()

beforeEach(() => {
  const items = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => { items.set(k, v) }, removeItem: (k: string) => { items.delete(k) } })
  state().reset()
})
afterEach(() => { vi.unstubAllGlobals(); state().reset() })

describe('newFinished', () => {
  it('returns each new, recent row once, oldest first, and prunes seen keys to the page', () => {
    const seen = new Set<string>(['gone'])
    const history = [finished('b', NOW), finished('a', NOW - 1)]
    expect(newFinished(history, seen, NOW).map((n) => n.id)).toEqual(['a', 'b'])
    expect(newFinished(history, seen, NOW)).toEqual([])
    expect([...seen].sort()).toEqual(['a', 'b'])
  })

  it('skips rows past the fresh window and approvals', () => {
    const seen = new Set<string>()
    const history = [finished('stale', NOW - 120_001), { ...finished('approval'), kind: 'approval' as const, outcome: 'approved' as const }]
    expect(newFinished(history, seen, NOW)).toEqual([])
  })
})

describe('bell unread state', () => {
  it('counts finished rows newer than the last panel open; opening marks them read for every window', () => {
    const history = [finished('b', NOW), finished('a', NOW - 10)]
    expect(unreadFinished(history, NOW - 5)).toBe(1)
    state().setSnapshot({ pending: [], history })
    expect(unreadFinished(state().history, state().seenAt)).toBe(2)
    const previousSeenAt = state().seenAt
    state().setPanelOpen(true)
    expect(state().openedSeenAt).toBe(previousSeenAt)
    expect(unreadFinished(state().history, state().seenAt)).toBe(0)
    expect(Number(globalThis.localStorage?.getItem(NOTIFICATIONS_SEEN_KEY))).toBe(state().seenAt)
  })

  it('a pending-only snapshot does not drop a finished notice; it does drop an answered approval notice', () => {
    state().pushToast({ id: 'f', kind: 'finished', agentName: 'a', loop: 'main', detail: 'Report ready', filePath: '/agents/a.adf' })
    state().pushToast({ id: 'p', kind: 'approval', agentName: 'b', loop: 'main', detail: 'fs_write', filePath: '/agents/b.adf' })
    state().setSnapshot({ pending: [], history: [] })
    expect(state().toasts.map((t) => t.id)).toEqual(['f'])
  })
})
