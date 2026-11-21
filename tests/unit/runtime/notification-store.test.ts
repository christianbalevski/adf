import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApprovalHub } from '../../../src/main/runtime/approval-hub'
import { NotificationStore } from '../../../src/main/runtime/notification-store'

const dirs: string[] = []
const hubs: ApprovalHub[] = []
function storagePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'adf-notifications-'))
  dirs.push(dir)
  return join(dir, 'notification-history.json')
}
function reopen(path: string): ApprovalHub {
  const hub = new ApprovalHub()
  hub.initializePersistence(path)
  hubs.push(hub)
  return hub
}
function entry(id: string) {
  return { id, kind: 'approval' as const, requestId: id, filePath: '/a.adf', agentName: 'A', loop: 'main', preview: 'Write a file', requestedAt: 1 }
}
afterEach(() => {
  for (const hub of hubs.splice(0)) hub.clear()
  vi.restoreAllMocks()
  vi.useRealTimers()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('persistent notification history', () => {
  it('survives a restart, retains more than 50 receipts and never writes raw inputs', () => {
    const path = storagePath()
    const first = reopen(path)
    for (let i = 0; i < 60; i++) {
      first.register({ ...entry(`n${i}`), input: { secret: 'never-save-this' }, resolve: vi.fn() })
      first.unregister(`n${i}`, i % 2 ? 'approved' : 'rejected')
    }
    first.flushPersistence()
    const second = reopen(path)
    expect(second.fullSnapshot()).toEqual(first.fullSnapshot())
    expect(second.historySnapshot()).toHaveLength(60)
    expect(readFileSync(path, 'utf8')).not.toContain('never-save-this')
    expect(readFileSync(path, 'utf8')).not.toContain('"input"')
  })

  it('recovers interrupted asks and approvals as expired exactly once', () => {
    const path = storagePath()
    const first = reopen(path)
    first.register({ ...entry('approval'), input: { secret: 'private' }, resolve: vi.fn() })
    first.register({ ...entry('ask'), kind: 'ask', question: 'Which folder?' })
    first.flushPersistence()
    const second = reopen(path)
    expect(second.snapshot()).toEqual([])
    expect(second.historySnapshot()).toMatchObject([
      { id: 'approval', outcome: 'expired' }, { id: 'ask', outcome: 'expired', question: 'Which folder?' },
    ])
    expect(second.resolve('/a.adf', 'approval', true).success).toBe(false)
    expect(reopen(path).fullSnapshot()).toEqual(second.fullSnapshot())
  })

  it('persists manual clearing, broadcasts it, and keeps live requests actionable', () => {
    vi.useFakeTimers()
    const path = storagePath()
    const hub = reopen(path)
    hub.register(entry('done'))
    hub.unregister('done', 'answered')
    const resolve = vi.fn()
    hub.register({ ...entry('pending'), resolve })
    const listener = vi.fn()
    const unsubscribe = hub.subscribe(listener)
    expect(hub.clearHistory()).toEqual({ success: true })
    vi.advanceTimersByTime(50)
    expect(listener).toHaveBeenLastCalledWith({ pending: [entry('pending')], history: [] })
    unsubscribe()
    expect(resolve).not.toHaveBeenCalled()
    expect(reopen(path).historySnapshot().map((notice) => notice.id)).toEqual(['pending'])
    expect(hub.resolve('/a.adf', 'pending', true).success).toBe(true)
    expect(resolve).toHaveBeenCalledWith(true, undefined)
    expect(hub.clearHistory().success).toBe(true)
    expect(reopen(path).fullSnapshot()).toEqual({ pending: [], history: [] })
  })

  it('keeps history visible when a clear cannot be saved', () => {
    const path = storagePath()
    const hub = reopen(path)
    hub.register(entry('done'))
    hub.unregister('done', 'approved')
    hub.flushPersistence()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const save = vi.spyOn(NotificationStore.prototype, 'save').mockImplementation(() => { throw new Error('disk full') })
    expect(hub.clearHistory().success).toBe(false)
    expect(hub.historySnapshot()).toHaveLength(1)
    save.mockRestore()
    expect(reopen(path).historySnapshot()).toHaveLength(1)
  })

  it('preserves malformed JSON and starts a usable history file', () => {
    const path = storagePath()
    writeFileSync(path, '{broken')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const hub = reopen(path)
    hub.register(entry('new'))
    hub.unregister('new', 'approved')
    hub.flushPersistence()
    expect(reopen(path).historySnapshot()).toHaveLength(1)
    expect(readdirSync(dirs[0]).some((name) => name.includes('.corrupt-'))).toBe(true)
  })

  it('shows recovered history even if the startup write fails', () => {
    const path = storagePath()
    const hub = reopen(path)
    hub.register(entry('done'))
    hub.unregister('done', 'approved')
    hub.flushPersistence()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const save = vi.spyOn(NotificationStore.prototype, 'save').mockImplementation(() => { throw new Error('disk full') })
    const recovered = reopen(path)
    expect(recovered.historySnapshot()).toHaveLength(1)
    expect(recovered.clearHistory().success).toBe(false)
    save.mockRestore()
    expect(recovered.clearHistory().success).toBe(true)
    expect(reopen(path).historySnapshot()).toEqual([])
  })

  it('never overwrites an unrecognized file or reports its history cleared', () => {
    const path = storagePath()
    const original = JSON.stringify({ history: 'unrecognized' })
    writeFileSync(path, original)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const hub = reopen(path)
    hub.register(entry('new'))
    hub.unregister('new', 'approved')
    expect(hub.clearHistory().success).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe(original)
  })

  it('coalesces disk writes without subscribers and flushes the last change at shutdown', () => {
    vi.useFakeTimers()
    const path = storagePath()
    const hub = reopen(path)
    const save = vi.spyOn(NotificationStore.prototype, 'save')
    for (let i = 0; i < 60; i++) {
      hub.register(entry(`n${i}`))
      hub.unregister(`n${i}`, 'approved')
    }
    expect(save).not.toHaveBeenCalled()
    vi.advanceTimersByTime(50)
    expect(save).toHaveBeenCalledTimes(1)
    expect(reopen(path).historySnapshot()).toHaveLength(60)
    hub.register(entry('last'))
    hub.unregister('last', 'answered')
    hub.flushPersistence()
    expect(reopen(path).historySnapshot()[0]).toMatchObject({ id: 'last', outcome: 'answered' })
  })

  it('a delayed save cannot resurrect history after a manual clear', () => {
    vi.useFakeTimers()
    const path = storagePath()
    const hub = reopen(path)
    hub.register(entry('done'))
    hub.unregister('done', 'approved')
    expect(hub.clearHistory().success).toBe(true)
    vi.advanceTimersByTime(50)
    expect(reopen(path).historySnapshot()).toEqual([])
  })
})
