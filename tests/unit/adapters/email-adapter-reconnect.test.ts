import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  AdapterContext,
  AdapterInstanceConfig
} from '../../../src/shared/types/channel-adapter.types'

// vi.mock factories hoist — keep all mutable mock state on globalThis so it
// doesn't TDZ when the factory runs ahead of module init.
interface MockImapClient extends EventEmitter {
  close: ReturnType<typeof vi.fn>
  connect: ReturnType<typeof vi.fn>
  removeAllListeners(): this
  getMailboxLock: ReturnType<typeof vi.fn>
  fetch: ReturnType<typeof vi.fn>
}

declare global {
  // eslint-disable-next-line no-var
  var __imapMocks: {
    /** Captured constructor args so tests can assert auth/host */
    constructorArgs: unknown[]
    /** Every ImapFlow instance ever created (test asserts which are stale) */
    instances: MockImapClient[]
    /** Forces the next .connect() call to reject with this error */
    nextConnectError: Error | null
    /** Async resolver for .connect() — lets tests pause/control timing */
    connectImpl: (() => Promise<void>) | null
  }
}

vi.mock('imapflow', async () => {
  const { EventEmitter: NodeEventEmitter } = await import('events')

  class MockImapFlow extends NodeEventEmitter {
    public close = vi.fn()
    public connect = vi.fn(async () => {
      if (globalThis.__imapMocks.nextConnectError) {
        const err = globalThis.__imapMocks.nextConnectError
        globalThis.__imapMocks.nextConnectError = null
        throw err
      }
      if (globalThis.__imapMocks.connectImpl) {
        return globalThis.__imapMocks.connectImpl()
      }
    })
    public getMailboxLock = vi.fn(async () => ({ release: () => {} }))
    public fetch = vi.fn(async function* () { /* yield nothing */ })
    public messageFlagsAdd = vi.fn()

    constructor(opts: unknown) {
      super()
      globalThis.__imapMocks.constructorArgs.push(opts)
      globalThis.__imapMocks.instances.push(this as unknown as MockImapClient)
    }
  }

  return { ImapFlow: MockImapFlow }
})

// nodemailer is touched in start(); stub it so we don't actually create real transports.
vi.mock('nodemailer', () => {
  return {
    default: {
      createTransport: () => ({
        verify: vi.fn(async () => true),
        sendMail: vi.fn(async () => ({ messageId: 'mock@id' })),
        close: vi.fn()
      })
    }
  }
})

// Import AFTER vi.mock so the factories win.
import { EmailAdapter } from '../../../src/main/adapters/email/email-adapter'

function makeCtx(): AdapterContext & { logs: Array<{ level: string; msg: string }> } {
  const logs: Array<{ level: string; msg: string }> = []
  const credentials: Record<string, string | null> = {
    EMAIL_USERNAME: 'user@example.com',
    EMAIL_PASSWORD: 'hunter2'
  }
  const config: AdapterInstanceConfig = {
    enabled: true,
    config: {
      // Use polling mode (not IDLE) so we don't kick off the long-running runIdle loop
      idle: false,
      poll_interval: 1_000_000
    }
  }
  return {
    ingest: vi.fn(),
    writeAttachment: vi.fn(),
    getConfig: () => config,
    getCredential: (k: string) => credentials[k] ?? null,
    log: vi.fn((level: 'info' | 'warn' | 'error', msg: string) => { logs.push({ level, msg }) }),
    logs
  } as AdapterContext & { logs: Array<{ level: string; msg: string }> }
}

beforeEach(() => {
  globalThis.__imapMocks = {
    constructorArgs: [],
    instances: [],
    nextConnectError: null,
    connectImpl: null
  }
  vi.useFakeTimers()
})

afterEach(async () => {
  vi.useRealTimers()
})

async function startAdapter(adapter: EmailAdapter, ctx: AdapterContext): Promise<MockImapClient> {
  const startPromise = adapter.start(ctx)
  await startPromise
  return globalThis.__imapMocks.instances[0]
}

describe('EmailAdapter reconnect hygiene', () => {
  it('ignores stale close events from a prior IMAP client after reconnect succeeds', async () => {
    // This is the regression test for the loop the user observed:
    //   "Max reconnect attempts reached — giving up"
    //   "Reconnected successfully"
    //   "IMAP connection closed unexpectedly"   ← stale event from the old client
    //   "Reconnecting in 5s (attempt 1/5)"      ← counter reset → cycle restarts
    const adapter = new EmailAdapter()
    const ctx = makeCtx()
    const firstClient = await startAdapter(adapter, ctx)
    expect(globalThis.__imapMocks.instances).toHaveLength(1)

    // Trigger a disconnect → adapter schedules a reconnect.
    firstClient.emit('close')
    expect(ctx.log).toHaveBeenCalledWith('warn', 'IMAP connection closed unexpectedly')

    // Advance through the 5s backoff so the reconnect attempt fires and a
    // second client is created + connects successfully.
    await vi.advanceTimersByTimeAsync(5_100)
    expect(globalThis.__imapMocks.instances).toHaveLength(2)
    const reconnectLogs = ctx.log.mock.calls.filter((c) => c[1] === 'Reconnected successfully')
    expect(reconnectLogs).toHaveLength(1)

    // Now the OLD client's death rattle fires after we've already swapped
    // in the new one. Before the fix this triggered a brand-new reconnect
    // cycle ("attempt 1/5"). With the epoch tag it must be a no-op.
    // Note: teardownClient() already stripped the adapter's listeners on the
    // old client, so attach a no-op error listener first to satisfy Node's
    // "unhandled error events throw" semantic when we emit below.
    firstClient.on('error', () => { /* swallow */ })
    const reconnectCallsBefore = ctx.log.mock.calls.filter((c) =>
      typeof c[1] === 'string' && c[1].startsWith('Reconnecting in')
    ).length
    firstClient.emit('close')
    firstClient.emit('error', new Error('stale error'))

    // Let any microtasks settle.
    await vi.advanceTimersByTimeAsync(100)

    const reconnectCallsAfter = ctx.log.mock.calls.filter((c) =>
      typeof c[1] === 'string' && c[1].startsWith('Reconnecting in')
    ).length
    expect(reconnectCallsAfter).toBe(reconnectCallsBefore)
    // And we should not have created a third client.
    expect(globalThis.__imapMocks.instances).toHaveLength(2)
  })

  it('treats giveUp as terminal — no further reconnects scheduled after max attempts', async () => {
    const adapter = new EmailAdapter()
    const ctx = makeCtx()
    const firstClient = await startAdapter(adapter, ctx)

    // Force every reconnect attempt to fail by making .connect() throw.
    globalThis.__imapMocks.connectImpl = async () => { throw new Error('refused') }

    // Trigger the first disconnect. The adapter will then cycle through
    // attempts 1..5 with exponential backoff. Total backoff time:
    // 5 + 10 + 20 + 40 + 60 = 135 seconds.
    firstClient.emit('close')
    await vi.advanceTimersByTimeAsync(140_000)

    expect(ctx.log).toHaveBeenCalledWith('error', 'Max reconnect attempts reached — giving up')

    // After give-up, any further stale events must be silently dropped.
    const callsBefore = ctx.log.mock.calls.length
    const instancesBefore = globalThis.__imapMocks.instances.length

    // Fire a close on the latest client (which is now nulled out by giveUp)
    // — also fire on the original client to simulate the post-mortem socket events.
    // Attach swallowing error listeners first since teardownClient stripped them.
    for (const inst of globalThis.__imapMocks.instances) {
      inst.on('error', () => { /* swallow */ })
      inst.emit('close')
      inst.emit('error', new Error('still failing'))
    }
    await vi.advanceTimersByTimeAsync(10_000)

    // No new "Reconnecting in ..." messages.
    const newReconnects = ctx.log.mock.calls.slice(callsBefore).filter((c) =>
      typeof c[1] === 'string' && c[1].startsWith('Reconnecting in')
    )
    expect(newReconnects).toHaveLength(0)
    // No new IMAP client instances.
    expect(globalThis.__imapMocks.instances.length).toBe(instancesBefore)
  })

  it('trips the flap circuit breaker when connect succeeds and immediately dies repeatedly', async () => {
    const adapter = new EmailAdapter()
    const ctx = makeCtx()
    const firstClient = await startAdapter(adapter, ctx)

    // Each reconnect succeeds → status flips to connected → we immediately
    // emit close → recordPossibleFlap() increments flapCount. After
    // FLAP_LIMIT (5) such cycles the breaker should trip.
    let currentClient = firstClient

    for (let i = 0; i < 6; i++) {
      currentClient.emit('close')
      // Walk through the backoff. Attempts after success use attempt 1 (5s),
      // since reconnectAttempts resets on each successful connect.
      await vi.advanceTimersByTimeAsync(6_000)
      const latest = globalThis.__imapMocks.instances[globalThis.__imapMocks.instances.length - 1]
      if (latest === currentClient) break // breaker tripped, no new client created
      currentClient = latest
    }

    const flapMsg = ctx.log.mock.calls.find((c) =>
      typeof c[1] === 'string' && c[1].includes('Connection is flapping')
    )
    expect(flapMsg).toBeTruthy()
    // Status should be error and gaveUp should hold.
    expect(adapter.status()).toBe('error')
  })

  it('debounces scheduleReconnect — concurrent close + error events do not stack timers', async () => {
    const adapter = new EmailAdapter()
    const ctx = makeCtx()
    const firstClient = await startAdapter(adapter, ctx)

    // Fire both events back-to-back. Without the reentrancy guard this used
    // to schedule two parallel reconnect cycles.
    firstClient.emit('error', new Error('boom'))
    firstClient.emit('close')

    const reconnectingLogs = ctx.log.mock.calls.filter((c) =>
      typeof c[1] === 'string' && c[1].startsWith('Reconnecting in')
    )
    // Exactly one "Reconnecting in 5s (attempt 1/5)" — not two.
    expect(reconnectingLogs).toHaveLength(1)
  })
})
