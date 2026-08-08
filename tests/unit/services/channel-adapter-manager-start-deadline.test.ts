import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ChannelAdapterManager } from '../../../src/main/services/channel-adapter-manager'
import type {
  AdapterContext,
  AdapterInstanceConfig,
  AdapterStatus,
  ChannelAdapter
} from '../../../src/shared/types/channel-adapter.types'
import type { AdfWorkspace } from '../../../src/main/adf/adf-workspace'

const START_TIMEOUT_MS = 10_000
const INITIAL_BACKOFF_MS = 2_000
const HEALTH_CHECK_INTERVAL_MS = 30_000
const MAX_RETRIES = 5

/**
 * Mock adapter whose start() behavior is scriptable per call:
 * - 'hang'    → never settles (simulates a packet-dropping host)
 * - 'ok'      → resolves immediately
 * - 'fail'    → rejects immediately
 * Hung starts can be settled later via resolveHung()/rejectHung().
 */
class MockAdapter implements ChannelAdapter {
  startCalls = 0
  stopCalls = 0
  currentStatus: AdapterStatus = 'disconnected'
  script: Array<'hang' | 'ok' | 'fail'>
  private hungResolvers: Array<{ resolve: () => void; reject: (e: Error) => void }> = []

  constructor(script: Array<'hang' | 'ok' | 'fail'>) {
    this.script = script
  }

  start(_ctx: AdapterContext): Promise<void> {
    const mode = this.script[this.startCalls] ?? 'ok'
    this.startCalls++
    if (mode === 'ok') {
      this.currentStatus = 'connected'
      return Promise.resolve()
    }
    if (mode === 'fail') {
      this.currentStatus = 'error'
      return Promise.reject(new Error('boom'))
    }
    // hang
    this.currentStatus = 'connecting'
    return new Promise<void>((resolve, reject) => {
      this.hungResolvers.push({
        resolve: () => { this.currentStatus = 'connected'; resolve() },
        reject: (e: Error) => { this.currentStatus = 'error'; reject(e) }
      })
    })
  }

  resolveHung(): void {
    this.hungResolvers.shift()?.resolve()
  }

  rejectHung(err: Error): void {
    this.hungResolvers.shift()?.reject(err)
  }

  async stop(): Promise<void> {
    this.stopCalls++
    this.currentStatus = 'disconnected'
  }

  async send() {
    return { success: true as const }
  }

  canDeliver(): boolean {
    return this.currentStatus === 'connected'
  }

  status(): AdapterStatus {
    return this.currentStatus
  }
}

const config: AdapterInstanceConfig = { enabled: true }
// Workspace methods are only reached through ctx callbacks (ingest,
// getCredential, ...) which these tests never invoke.
const workspace = {} as AdfWorkspace

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ChannelAdapterManager start deadline', () => {
  it('starts normally when the adapter connects within the deadline', async () => {
    const manager = new ChannelAdapterManager()
    const adapter = new MockAdapter(['ok'])

    const ok = await manager.startAdapter('test', () => adapter, config, workspace)

    expect(ok).toBe(true)
    expect(manager.getStatus('test')).toBe('connected')
  })

  it('returns degraded (false) when start() hangs past the deadline instead of blocking forever', async () => {
    const manager = new ChannelAdapterManager()
    const adapter = new MockAdapter(['hang'])

    const startPromise = manager.startAdapter('test', () => adapter, config, workspace)
    await vi.advanceTimersByTimeAsync(START_TIMEOUT_MS + 10)
    const ok = await startPromise

    expect(ok).toBe(false)
    const state = manager.getState('test')
    expect(state?.status).toBe('error')
    expect(state?.error).toMatch(/timed out/i)
  })

  it('waits for the hung start() to settle before restarting, then recovers', async () => {
    const manager = new ChannelAdapterManager()
    // First start hangs; the auto-restart attempt (after settle) succeeds.
    const adapter = new MockAdapter(['hang', 'ok'])

    const startPromise = manager.startAdapter('test', () => adapter, config, workspace)
    await vi.advanceTimersByTimeAsync(START_TIMEOUT_MS + 10)
    expect(await startPromise).toBe(false)

    // No second start() while the original is still in flight — a concurrent
    // start() on one adapter instance duplicates pollers (Telegram 409s).
    await vi.advanceTimersByTimeAsync(HEALTH_CHECK_INTERVAL_MS * 4)
    expect(adapter.startCalls).toBe(1)

    // The hung start finally fails — the settle chain kicks auto-restart.
    adapter.rejectHung(new Error('connect aborted'))
    await vi.advanceTimersByTimeAsync(INITIAL_BACKOFF_MS + 10)

    expect(adapter.stopCalls).toBeGreaterThanOrEqual(1)
    expect(adapter.startCalls).toBe(2)
    expect(manager.getStatus('test')).toBe('connected')
  })

  it('never runs a second start() while the first is in flight, even if the adapter reports error', async () => {
    const manager = new ChannelAdapterManager()
    const adapter = new MockAdapter(['hang', 'ok'])

    const startPromise = manager.startAdapter('test', () => adapter, config, workspace)
    await vi.advanceTimersByTimeAsync(START_TIMEOUT_MS + 10)
    expect(await startPromise).toBe(false)

    // Adapter flips to 'error' while its start() is still hung — the health
    // check must not kick a concurrent restart (start-in-flight guard).
    adapter.currentStatus = 'error'
    await vi.advanceTimersByTimeAsync(HEALTH_CHECK_INTERVAL_MS * 3)
    expect(adapter.startCalls).toBe(1)

    adapter.rejectHung(new Error('aborted'))
    await vi.advanceTimersByTimeAsync(INITIAL_BACKOFF_MS + 10)
    expect(adapter.startCalls).toBe(2)
    expect(manager.getStatus('test')).toBe('connected')
  })

  it('schedules background recovery after a fail-fast start()', async () => {
    const manager = new ChannelAdapterManager()
    // start() rejects immediately (e.g. null credentials); retry succeeds.
    const adapter = new MockAdapter(['fail', 'ok'])

    const ok = await manager.startAdapter('test', () => adapter, config, workspace)
    expect(ok).toBe(false)
    expect(manager.getState('test')?.status).toBe('error')

    await vi.advanceTimersByTimeAsync(INITIAL_BACKOFF_MS + 10)

    expect(adapter.stopCalls).toBeGreaterThanOrEqual(1)
    expect(adapter.startCalls).toBe(2)
    expect(manager.getStatus('test')).toBe('connected')
  })

  it('bounds fail-fast recovery by MAX_RETRIES', async () => {
    const manager = new ChannelAdapterManager()
    const adapter = new MockAdapter(['fail', 'fail', 'fail', 'fail', 'fail', 'fail', 'fail'])

    expect(await manager.startAdapter('test', () => adapter, config, workspace)).toBe(false)

    // Walk far past every backoff and health-check interval.
    for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(60_000)

    // Initial attempt + MAX_RETRIES restarts, then gives up for good.
    expect(adapter.startCalls).toBe(1 + MAX_RETRIES)
    expect(manager.getStatus('test')).toBe('error')
  })

  it('adopts a late-succeeding start() without double-registering', async () => {
    const manager = new ChannelAdapterManager()
    // Initial start hangs; the auto-restart attempt also hangs (so the retry
    // cycle fails with its own timeout and releases the lifecycle), then the
    // ORIGINAL start finally succeeds.
    const adapter = new MockAdapter(['hang', 'hang'])

    const startPromise = manager.startAdapter('test', () => adapter, config, workspace)
    await vi.advanceTimersByTimeAsync(START_TIMEOUT_MS + 10)
    expect(await startPromise).toBe(false)

    // Walk through backoff + the retry's own start timeout so restarting=false.
    await vi.advanceTimersByTimeAsync(INITIAL_BACKOFF_MS + START_TIMEOUT_MS + 20)
    expect(manager.getStatus('test')).toBe('error')

    // The original hung start() now resolves — the manager adopts it.
    adapter.resolveHung()
    await vi.advanceTimersByTimeAsync(10)

    expect(manager.getStatus('test')).toBe('connected')
    const state = manager.getState('test')
    expect(state?.error).toBeUndefined()
  })

  it('ignores a late-failing start() (no unhandled rejection, status untouched)', async () => {
    const manager = new ChannelAdapterManager()
    const adapter = new MockAdapter(['hang'])

    const startPromise = manager.startAdapter('test', () => adapter, config, workspace)
    await vi.advanceTimersByTimeAsync(START_TIMEOUT_MS + 10)
    expect(await startPromise).toBe(false)

    adapter.rejectHung(new Error('late failure'))
    await vi.advanceTimersByTimeAsync(10)

    expect(manager.getState('test')?.status).toBe('error')
  })

  it('stopAdapter during a hung start tears the adapter down and a late success does not resurrect it', async () => {
    const manager = new ChannelAdapterManager()
    const adapter = new MockAdapter(['hang'])

    const startPromise = manager.startAdapter('test', () => adapter, config, workspace)
    await vi.advanceTimersByTimeAsync(START_TIMEOUT_MS + 10)
    expect(await startPromise).toBe(false)

    await manager.stopAdapter('test')
    expect(manager.getState('test')).toBeNull()
    const stopsAfterStop = adapter.stopCalls

    // The zombie start() finally resolves — manager must stop it again, not adopt it.
    adapter.resolveHung()
    await vi.advanceTimersByTimeAsync(10)

    expect(manager.getState('test')).toBeNull()
    expect(adapter.stopCalls).toBeGreaterThan(stopsAfterStop)
  })
})
