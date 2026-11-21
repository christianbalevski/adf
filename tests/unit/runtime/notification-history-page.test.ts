import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApprovalHub, HISTORY_PAGE_SIZE } from '../../../src/main/runtime/approval-hub'
import type { NotificationsSnapshot } from '../../../src/shared/types/ipc.types'

function entry(id: string, preview = id) {
  return { id, kind: 'approval' as const, requestId: id, filePath: '/a.adf', agentName: 'A', loop: 'main', preview, requestedAt: 1 }
}

function remember(hub: ApprovalHub, id: string, preview = id): void {
  hub.register(entry(id, preview))
  hub.unregister(id, 'approved')
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('notification history pages', () => {
  it('keeps live snapshots bounded without discarding older receipts', () => {
    vi.useFakeTimers()
    const hub = new ApprovalHub()
    const pushes: NotificationsSnapshot[] = []
    const unsubscribe = hub.subscribe((snapshot) => pushes.push(snapshot))
    const total = HISTORY_PAGE_SIZE * 3 + 7
    for (let i = 0; i < total; i++) remember(hub, `n${i}`)
    hub.register(entry('still-pending'))
    vi.advanceTimersByTime(50)
    unsubscribe()

    expect(pushes).toHaveLength(1)
    expect(pushes[0].pending).toEqual([entry('still-pending')])
    expect(pushes[0].history).toHaveLength(HISTORY_PAGE_SIZE)
    expect(pushes[0]).toEqual(hub.fullSnapshot())
    expect(hub.historySnapshot()).toHaveLength(total)
    expect(hub.historyPage().history).toEqual(pushes[0].history)
    expect(hub.historyPage().nextBefore).toBe(total - HISTORY_PAGE_SIZE)
  })

  it('paginates repeated IDs and equal timestamps without gaps when new receipts arrive', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const hub = new ApprovalHub()
    const total = HISTORY_PAGE_SIZE * 2 + 7
    // Executors can reuse request IDs after a restart, and an entire batch
    // can resolve within the same millisecond. Neither is a unique cursor.
    for (let i = 0; i < total; i++) remember(hub, 'reused-id', `original-${i}`)
    const first = hub.historyPage()
    expect(first.nextBefore).not.toBeNull()
    for (let i = 0; i < 5; i++) remember(hub, 'reused-id', `new-${i}`)
    const second = hub.historyPage(first.nextBefore!)
    expect(second.nextBefore).not.toBeNull()
    const third = hub.historyPage(second.nextBefore!)

    expect(third.nextBefore).toBeNull()
    const original = [...first.history, ...second.history, ...third.history]
    expect(original.map((row) => row.preview)).toEqual(
      Array.from({ length: total }, (_, i) => `original-${total - 1 - i}`),
    )
    expect(original.every((row) => row.id === 'reused-id' && row.resolvedAt === 1000)).toBe(true)
    expect(hub.historyPage().history[0].preview).toBe('new-4')
  })

  it('clears every page while leaving pending requests actionable', () => {
    const hub = new ApprovalHub()
    for (let i = 0; i < HISTORY_PAGE_SIZE + 3; i++) remember(hub, `n${i}`)
    const cursor = hub.historyPage().nextBefore!
    const resolve = vi.fn()
    hub.register({ ...entry('pending'), resolve })

    expect(hub.clearHistory()).toEqual({ success: true })
    expect(hub.historyPage()).toEqual({ history: [], nextBefore: null })
    expect(hub.historyPage(cursor)).toEqual({ history: [], nextBefore: null })
    expect(hub.resolve('/a.adf', 'pending', true)).toEqual({ success: true })
    expect(resolve).toHaveBeenCalledWith(true, undefined)
  })

  it('keeps only display fields when a large form becomes history', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const hub = new ApprovalHub()
    const base = { ...entry('ask'), kind: 'ask' as const, question: 'Which folder?' }
    hub.register({
      ...base,
      questions: [{ question: 'form-only-content'.repeat(100_000) }],
      input: { secret: 'raw-input-must-not-survive' },
      reason: 'restricted',
      canAlwaysApprove: false,
      alwaysApproveBlockedReason: 'pending-only-reason',
      resolve: vi.fn(),
    })
    hub.unregister('ask', 'answered')

    const receipt = { ...base, outcome: 'answered', resolvedAt: 1000 }
    expect(hub.historySnapshot()).toEqual([receipt])
    expect(hub.historyPage().history).toEqual([receipt])
    expect(hub.fullSnapshot().history).toEqual([receipt])
    expect(JSON.stringify(hub.fullSnapshot()).length).toBeLessThan(1000)
  })
})
