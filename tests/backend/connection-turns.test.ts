import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionState } from '../../src/main/backend/daemon-mode/connection'
import { followConnectionTurns, TURN_DISCONNECT_GRACE_MS } from '../../src/main/backend/daemon-mode/connection-turns'

function harness() {
  vi.useFakeTimers()
  let state: ConnectionState = { state: 'connecting' }
  const listeners = new Set<(state: ConnectionState) => void>()
  const fail = vi.fn()
  const recheck = vi.fn()
  const dispose = followConnectionTurns({ get state() { return state }, onState(listener) { listeners.add(listener); return () => { listeners.delete(listener) } } }, fail, recheck, { warn: vi.fn() })
  return { fail, recheck, dispose, change(next: ConnectionState) { state = next; for (const listener of listeners) listener(state) } }
}

afterEach(() => vi.useRealTimers())

describe('shared desktop/browser turn connection lifecycle', () => {
  it('ends waiting chats after the grace period and reconciles on reconnect', () => {
    const h = harness()
    h.change({ state: 'disconnected', since: 0 })
    vi.advanceTimersByTime(TURN_DISCONNECT_GRACE_MS - 1)
    expect(h.fail).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(h.fail).toHaveBeenCalledOnce()
    h.change({ state: 'connected' })
    expect(h.recheck).toHaveBeenCalledOnce()
    h.dispose()
  })

  it('keeps turns during transient disconnects and cancels every timer on disposal', () => {
    const h = harness()
    h.change({ state: 'disconnected', since: 0 })
    vi.advanceTimersByTime(100)
    h.change({ state: 'connected' })
    vi.advanceTimersByTime(TURN_DISCONNECT_GRACE_MS)
    expect(h.fail).not.toHaveBeenCalled()
    h.change({ state: 'disconnected', since: 100 })
    h.dispose()
    vi.advanceTimersByTime(TURN_DISCONNECT_GRACE_MS)
    h.change({ state: 'connected' })
    expect(h.fail).not.toHaveBeenCalled()
    expect(h.recheck).toHaveBeenCalledOnce()
  })

  it('fails immediately on fatal errors instead of waiting out the grace period', () => {
    const h = harness()
    h.change({ state: 'disconnected', since: 0 })
    h.change({ state: 'failed', message: 'Protocol mismatch' })
    expect(h.fail).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(TURN_DISCONNECT_GRACE_MS)
    expect(h.fail).toHaveBeenCalledOnce()
    h.dispose()
  })
})
