import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  AdapterContext,
  AdapterInstanceConfig
} from '../../../src/shared/types/channel-adapter.types'

// vi.mock factories hoist — keep all mutable mock state on globalThis so it
// doesn't TDZ when the factory runs ahead of module init.
interface MockFetchMessage {
  uid: number
  envelope: { date?: Date }
  source: Buffer
}

declare global {
  // eslint-disable-next-line no-var
  var __emailCatchupMocks: {
    /** Messages the next fetch() calls yield (adapter filters/caps on top) */
    fetchMessages: MockFetchMessage[]
    /** Overrides the fetch generator entirely — used to hold a fetch in flight */
    fetchImpl: (() => AsyncGenerator<MockFetchMessage>) | null
    /** Mailbox state exposed on client.mailbox (uidValidity/uidNext) */
    mailbox: { uidValidity: bigint; uidNext: number } | false
  }
}

vi.mock('imapflow', async () => {
  const { EventEmitter: NodeEventEmitter } = await import('events')

  class MockImapFlow extends NodeEventEmitter {
    public close = vi.fn()
    public connect = vi.fn(async () => {})
    public getMailboxLock = vi.fn(async () => ({ release: () => {} }))
    public messageFlagsAdd = vi.fn(async () => true)
    public fetch = vi.fn(async function* () {
      if (globalThis.__emailCatchupMocks.fetchImpl) {
        yield* globalThis.__emailCatchupMocks.fetchImpl()
        return
      }
      for (const m of globalThis.__emailCatchupMocks.fetchMessages) yield m
    })

    get mailbox() {
      return globalThis.__emailCatchupMocks.mailbox
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

/** Build a fetch-shaped message with a real RFC822 source (parsed by mailparser). */
function makeEmail(opts: {
  uid: number
  messageId?: string
  date?: Date
  subject?: string
}): MockFetchMessage {
  const date = opts.date ?? new Date()
  const headers = [
    'From: Sender <sender@example.com>',
    'To: user@example.com',
    `Subject: ${opts.subject ?? `Test ${opts.uid}`}`,
    `Date: ${date.toUTCString()}`,
    ...(opts.messageId ? [`Message-ID: ${opts.messageId}`] : [])
  ]
  return {
    uid: opts.uid,
    envelope: { date },
    source: Buffer.from(headers.join('\r\n') + '\r\n\r\nHello body\r\n')
  }
}

type TestCtx = AdapterContext & {
  logs: Array<{ level: string; msg: string }>
  ingest: ReturnType<typeof vi.fn>
  beginCatchUp: ReturnType<typeof vi.fn>
  endCatchUp: ReturnType<typeof vi.fn>
}

function makeCtx(catchUp?: Record<string, unknown>): TestCtx {
  const logs: Array<{ level: string; msg: string }> = []
  const credentials: Record<string, string | null> = {
    EMAIL_USERNAME: 'user@example.com',
    EMAIL_PASSWORD: 'hunter2'
  }
  const config: AdapterInstanceConfig = {
    enabled: true,
    config: {
      // Polling mode so we don't kick off the long-running IDLE loop; huge
      // interval so only the initial (backlog) poll fires during a test.
      idle: false,
      poll_interval: 1_000_000,
      ...(catchUp ? { catch_up: catchUp } : {})
    }
  }
  return {
    ingest: vi.fn(() => 'row-id'),
    writeAttachment: vi.fn(),
    getConfig: () => config,
    getCredential: (k: string) => credentials[k] ?? null,
    log: vi.fn((level: 'info' | 'warn' | 'error', msg: string) => { logs.push({ level, msg }) }),
    beginCatchUp: vi.fn(),
    endCatchUp: vi.fn(() => ({ ingested: 0, deduped: 0 })),
    logs
  } as unknown as TestCtx
}

/** start() fires the initial poll without awaiting it — wait for it to settle. */
async function startAndDrain(adapter: EmailAdapter, ctx: TestCtx): Promise<void> {
  await adapter.start(ctx)
  // The initial pollInbox(true) runs unawaited; drain its async chain
  // (mailbox lock → fetch generator → mailparser streams) with macrotask turns.
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 0))
  }
}

beforeEach(() => {
  globalThis.__emailCatchupMocks = {
    fetchMessages: [],
    fetchImpl: null,
    mailbox: { uidValidity: 42n, uidNext: 100 }
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** Grab the (single) mocked ImapFlow instance the adapter created. */
function imapClientOf(adapter: EmailAdapter): {
  fetch: ReturnType<typeof vi.fn>
  messageFlagsAdd: ReturnType<typeof vi.fn>
} {
  return (adapter as unknown as { client: ReturnType<typeof imapClientOf> }).client
}

describe('EmailAdapter dedup identity', () => {
  it('sets InboundMessage.messageId from the RFC Message-ID header when present', async () => {
    const adapter = new EmailAdapter()
    const ctx = makeCtx()
    globalThis.__emailCatchupMocks.fetchMessages = [
      makeEmail({ uid: 7, messageId: '<msg-7@example.com>' })
    ]

    await startAndDrain(adapter, ctx)

    expect(ctx.ingest).toHaveBeenCalledTimes(1)
    expect(ctx.ingest.mock.calls[0][0].messageId).toBe('<msg-7@example.com>')
    await adapter.stop()
  })

  it('falls back to uidvalidity:uid when the message has no Message-ID header', async () => {
    const adapter = new EmailAdapter()
    const ctx = makeCtx()
    globalThis.__emailCatchupMocks.fetchMessages = [makeEmail({ uid: 7 })]

    await startAndDrain(adapter, ctx)

    expect(ctx.ingest).toHaveBeenCalledTimes(1)
    expect(ctx.ingest.mock.calls[0][0].messageId).toBe('42:7')
    await adapter.stop()
  })
})

describe('EmailAdapter fetch reentrancy', () => {
  it('skips a fetchUnseen invoked while another is in flight — no double-fetch', async () => {
    const adapter = new EmailAdapter()
    const ctx = makeCtx()
    await startAndDrain(adapter, ctx) // initial drain: empty mailbox
    const client = imapClientOf(adapter)
    expect(client.fetch).toHaveBeenCalledTimes(1)

    // Hold the next fetch open so a concurrent call races against it.
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    globalThis.__emailCatchupMocks.fetchImpl = async function* () {
      await gate
      yield makeEmail({ uid: 1, messageId: '<a@example.com>' })
    }

    const invoke = adapter as unknown as { fetchUnseen: (initial?: boolean) => Promise<void> }
    const first = invoke.fetchUnseen.call(adapter)
    const second = invoke.fetchUnseen.call(adapter) // must return immediately
    release()
    await Promise.all([first, second])

    // Exactly one additional fetch — the concurrent call was skipped, so the
    // message was ingested once, not twice.
    expect(client.fetch).toHaveBeenCalledTimes(2)
    expect(ctx.ingest).toHaveBeenCalledTimes(1)

    // The guard releases: a later sequential call fetches again.
    globalThis.__emailCatchupMocks.fetchImpl = null
    globalThis.__emailCatchupMocks.fetchMessages = []
    await invoke.fetchUnseen.call(adapter)
    expect(client.fetch).toHaveBeenCalledTimes(3)
    await adapter.stop()
  })
})

describe('EmailAdapter catch-up phase', () => {
  it('wraps the initial backlog drain in beginCatchUp/endCatchUp around the ingests', async () => {
    const adapter = new EmailAdapter()
    const ctx = makeCtx()
    globalThis.__emailCatchupMocks.fetchMessages = [
      makeEmail({ uid: 1, messageId: '<m1@example.com>' }),
      makeEmail({ uid: 2, messageId: '<m2@example.com>' })
    ]

    await startAndDrain(adapter, ctx)

    expect(ctx.ingest).toHaveBeenCalledTimes(2)
    expect(ctx.beginCatchUp).toHaveBeenCalledTimes(1)
    expect(ctx.endCatchUp).toHaveBeenCalledTimes(1)
    // Phase brackets the ingests: begin < first ingest < end
    const begin = ctx.beginCatchUp.mock.invocationCallOrder[0]
    const end = ctx.endCatchUp.mock.invocationCallOrder[0]
    for (const order of ctx.ingest.mock.invocationCallOrder) {
      expect(order).toBeGreaterThan(begin)
      expect(order).toBeLessThan(end)
    }

    // A subsequent (non-initial) fetch is live traffic — no catch-up phase.
    globalThis.__emailCatchupMocks.fetchMessages = [makeEmail({ uid: 3, messageId: '<m3@example.com>' })]
    const invoke = adapter as unknown as { fetchUnseen: (initial?: boolean) => Promise<void> }
    await invoke.fetchUnseen.call(adapter)
    expect(ctx.ingest).toHaveBeenCalledTimes(3)
    expect(ctx.beginCatchUp).toHaveBeenCalledTimes(1)
    expect(ctx.endCatchUp).toHaveBeenCalledTimes(1)
    await adapter.stop()
  })

  it('caps ingestion at max_messages oldest-first, leaves the rest unseen, and logs the remainder', async () => {
    const adapter = new EmailAdapter()
    const ctx = makeCtx({ max_messages: 2 })
    globalThis.__emailCatchupMocks.fetchMessages = [
      makeEmail({ uid: 1, messageId: '<m1@example.com>' }),
      makeEmail({ uid: 2, messageId: '<m2@example.com>' }),
      makeEmail({ uid: 3, messageId: '<m3@example.com>' }),
      makeEmail({ uid: 4, messageId: '<m4@example.com>' })
    ]

    await startAndDrain(adapter, ctx)

    // Oldest two (fetch yields in mailbox order) ingested, rest deferred.
    expect(ctx.ingest).toHaveBeenCalledTimes(2)
    const ingested = ctx.ingest.mock.calls.map(c => c[0].messageId)
    expect(ingested).toEqual(['<m1@example.com>', '<m2@example.com>'])
    const capLog = ctx.logs.find(l => l.msg.includes('2 unread remain past the 2-message cap; will ingest next cycle'))
    expect(capLog).toBeTruthy()

    // Only the ingested messages were flagged \Seen — capped-out ones stay
    // UNSEEN so the next cycle picks them up.
    const client = imapClientOf(adapter)
    expect(client.messageFlagsAdd).toHaveBeenCalledTimes(1)
    expect(client.messageFlagsAdd).toHaveBeenCalledWith('1,2', ['\\Seen'], { uid: true })
    await adapter.stop()
  })

  it('skips messages older than max_age_hours and never flags them \\Seen', async () => {
    const adapter = new EmailAdapter()
    const ctx = makeCtx({ max_age_hours: 1 })
    const threeHoursAgo = new Date(Date.now() - 3 * 3_600_000)
    globalThis.__emailCatchupMocks.fetchMessages = [
      makeEmail({ uid: 1, messageId: '<old@example.com>', date: threeHoursAgo }),
      makeEmail({ uid: 2, messageId: '<fresh@example.com>' })
    ]

    await startAndDrain(adapter, ctx)

    expect(ctx.ingest).toHaveBeenCalledTimes(1)
    expect(ctx.ingest.mock.calls[0][0].messageId).toBe('<fresh@example.com>')
    const ageLog = ctx.logs.find(l => l.msg.includes('1 unread older than 1h skipped'))
    expect(ageLog).toBeTruthy()

    // The aged-out message is untouched in the mailbox.
    const client = imapClientOf(adapter)
    expect(client.messageFlagsAdd).toHaveBeenCalledTimes(1)
    expect(client.messageFlagsAdd).toHaveBeenCalledWith('2', ['\\Seen'], { uid: true })
    await adapter.stop()
  })

  it('enabled:false skips the initial backlog and only ingests post-connect arrivals', async () => {
    const adapter = new EmailAdapter()
    const ctx = makeCtx({ enabled: false })
    globalThis.__emailCatchupMocks.mailbox = { uidValidity: 42n, uidNext: 50 }
    globalThis.__emailCatchupMocks.fetchMessages = [
      makeEmail({ uid: 49, messageId: '<pre@example.com>' })
    ]

    await startAndDrain(adapter, ctx)

    // Initial drain returns before fetching anything.
    const client = imapClientOf(adapter)
    expect(client.fetch).not.toHaveBeenCalled()
    expect(ctx.ingest).not.toHaveBeenCalled()
    expect(ctx.beginCatchUp).not.toHaveBeenCalled()
    expect(ctx.logs.some(l => l.msg.includes('Catch-up disabled'))).toBe(true)

    // Later cycles fetch but the pre-connect message stays below the UID floor;
    // a post-connect arrival is ingested normally.
    globalThis.__emailCatchupMocks.fetchMessages.push(makeEmail({ uid: 51, messageId: '<post@example.com>' }))
    const invoke = adapter as unknown as { fetchUnseen: (initial?: boolean) => Promise<void> }
    await invoke.fetchUnseen.call(adapter)

    expect(ctx.ingest).toHaveBeenCalledTimes(1)
    expect(ctx.ingest.mock.calls[0][0].messageId).toBe('<post@example.com>')
    // The pre-connect message was never flagged — re-enabling catch-up later
    // can still ingest it.
    expect(client.messageFlagsAdd).toHaveBeenCalledTimes(1)
    expect(client.messageFlagsAdd).toHaveBeenCalledWith('51', ['\\Seen'], { uid: true })
    await adapter.stop()
  })
})
