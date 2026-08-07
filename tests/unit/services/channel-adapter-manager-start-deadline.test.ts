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

  it('keeps retrying in the background after a start timeout and recovers', async () => {
    const manager = new ChannelAdapterManager()
    // First start hangs; the auto-restart attempt succeeds.
    const adapter = new MockAdapter(['hang', 'ok'])

    const startPromise = manager.startAdapter('test', () => adapter, config, workspace)
    await vi.advanceTimersByTimeAsync(START_TIMEOUT_MS + 10)
    expect(await startPromise).toBe(false)

    // Auto-restart fires after the initial backoff: stop() then start() again.
    await vi.advanceTimersByTimeAsync(INITIAL_BACKOFF_MS + 10)

    expect(adapter.stopCalls).toBeGreaterThanOrEqual(1)
    expect(adapter.startCalls).toBe(2)
    expect(manager.getStatus('test')).toBe('connected')
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
