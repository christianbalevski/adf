import { EventEmitter } from 'events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  AdapterContext,
  AdapterInstanceConfig,
  InboundMessage,
  OutboundMessage
} from '../../../src/shared/types/channel-adapter.types'

// vi.mock factories are hoisted — keep all mutable mock state on globalThis to
// avoid temporal-dead-zone errors when the factory runs before module init.
interface MockSocket extends EventEmitter {
  opts: { appToken: string }
  start(): Promise<void>
  disconnect(): Promise<void>
}

declare global {
  // eslint-disable-next-line no-var
  var __slackMocks: {
    authTest: ReturnType<typeof vi.fn>
    convInfo: ReturnType<typeof vi.fn>
    convMembers: ReturnType<typeof vi.fn>
    convOpen: ReturnType<typeof vi.fn>
    convReplies: ReturnType<typeof vi.fn>
    usersInfo: ReturnType<typeof vi.fn>
    postMessage: ReturnType<typeof vi.fn>
    filesUpload: ReturnType<typeof vi.fn>
    socketStart: ReturnType<typeof vi.fn>
    socketDisconnect: ReturnType<typeof vi.fn>
    webCtorTokens: string[]
    socketCtorArgs: unknown[]
    lastSocket: MockSocket | null
  }
}

vi.mock('@slack/socket-mode', async () => {
  const { EventEmitter: NodeEventEmitter } = await import('events')

  class SocketModeClient extends NodeEventEmitter {
    constructor(public opts: { appToken: string }) {
      super()
      globalThis.__slackMocks.socketCtorArgs.push(opts)
      globalThis.__slackMocks.lastSocket = this as unknown as MockSocket
    }

    async start(): Promise<void> {
      return globalThis.__slackMocks.socketStart()
    }

    async disconnect(): Promise<void> {
      return globalThis.__slackMocks.socketDisconnect()
    }
  }

  return { SocketModeClient }
})

vi.mock('@slack/web-api', () => {
  class WebClient {
    auth = { test: (...a: unknown[]) => globalThis.__slackMocks.authTest(...a) }
    conversations = {
      info: (...a: unknown[]) => globalThis.__slackMocks.convInfo(...a),
      members: (...a: unknown[]) => globalThis.__slackMocks.convMembers(...a),
      open: (...a: unknown[]) => globalThis.__slackMocks.convOpen(...a),
      replies: (...a: unknown[]) => globalThis.__slackMocks.convReplies(...a)
    }
    users = { info: (...a: unknown[]) => globalThis.__slackMocks.usersInfo(...a) }
    chat = { postMessage: (...a: unknown[]) => globalThis.__slackMocks.postMessage(...a) }
    filesUploadV2 = (...a: unknown[]) => globalThis.__slackMocks.filesUpload(...a)

    constructor(token: string) {
      globalThis.__slackMocks.webCtorTokens.push(token)
    }
  }

  return { WebClient }
})

// Import AFTER vi.mock so the factories win.
import { SlackAdapter } from '../../../src/main/adapters/slack/slack-adapter'
import { markdownToMrkdwn } from '../../../src/main/adapters/slack/mrkdwn'

const SELF_ID = 'USELF1234'

function makeCtx(overrides: Partial<{
  credentials: Record<string, string | null>
  config: AdapterInstanceConfig
  onIngest: (m: InboundMessage) => void
  onWriteAttachment: (path: string, data: Buffer, mimeType?: string) => void
}> = {}): AdapterContext {
  const credentials = overrides.credentials ?? {
    SLACK_APP_TOKEN: 'xapp-test',
    SLACK_BOT_TOKEN: 'xoxb-test'
  }
  const config = overrides.config ?? { enabled: true }
  return {
    ingest: overrides.onIngest ?? vi.fn(),
    writeAttachment: overrides.onWriteAttachment ?? vi.fn(),
    getConfig: () => config,
    getCredential: (k: string) => credentials[k] ?? null,
    log: vi.fn()
  }
}

beforeEach(() => {
  globalThis.__slackMocks = {
    authTest: vi.fn().mockResolvedValue({
      ok: true, user_id: SELF_ID, bot_id: 'B0000001', team_id: 'T0000001', user: 'adfbot'
    }),
    convInfo: vi.fn().mockResolvedValue({ channel: { name: 'general', num_members: 2 } }),
    convMembers: vi.fn().mockResolvedValue({ members: [] }),
    convOpen: vi.fn().mockResolvedValue({ channel: { id: 'D9000001' } }),
    convReplies: vi.fn().mockResolvedValue({ messages: [] }),
    usersInfo: vi.fn().mockImplementation(async (arg: { user: string }) => ({
      user: { real_name: `Name-${arg.user}` }
    })),
    postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '999.111' }),
    filesUpload: vi.fn().mockResolvedValue({ ok: true }),
    socketStart: vi.fn().mockResolvedValue(undefined),
    socketDisconnect: vi.fn().mockResolvedValue(undefined),
    webCtorTokens: [],
    socketCtorArgs: [],
    lastSocket: null
  }
})

async function flush(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setImmediate(r))
  }
}

async function startConnected(adapter: SlackAdapter, ctx: AdapterContext): Promise<MockSocket> {
  await adapter.start(ctx)
  return globalThis.__slackMocks.lastSocket!
}

/** Emit a slack_event envelope the way SocketModeClient delivers it. */
async function emitMessageEvent(
  socket: MockSocket,
  event: Record<string, unknown>,
  ack: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined)
): Promise<ReturnType<typeof vi.fn>> {
  socket.emit('slack_event', { ack, body: { event } })
  await flush()
  return ack
}

function dmEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'message',
    channel: 'D1111111',
    channel_type: 'im',
    user: 'U1000001',
    text: 'hello there',
    ts: '1700000000.000100',
    ...overrides
  }
}

function channelEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'message',
    channel: 'C7777777',
    channel_type: 'channel',
    user: 'U1000001',
    text: 'plain chatter',
    ts: '1700000000.000200',
    ...overrides
  }
}

describe('SlackAdapter', () => {
  describe('start()', () => {
    it('throws when SLACK_APP_TOKEN is missing', async () => {
      const adapter = new SlackAdapter()
      const ctx = makeCtx({ credentials: { SLACK_BOT_TOKEN: 'xoxb-test' } })
      await expect(adapter.start(ctx)).rejects.toThrow(/SLACK_APP_TOKEN/)
      expect(adapter.status()).toBe('error')
    })

    it('throws when SLACK_BOT_TOKEN is missing', async () => {
      const adapter = new SlackAdapter()
      const ctx = makeCtx({ credentials: { SLACK_APP_TOKEN: 'xapp-test' } })
      await expect(adapter.start(ctx)).rejects.toThrow(/SLACK_BOT_TOKEN/)
      expect(adapter.status()).toBe('error')
    })

    it('validates the bot token, starts Socket Mode, and reports connected', async () => {
      const adapter = new SlackAdapter()
      const socket = await startConnected(adapter, makeCtx())
      expect(globalThis.__slackMocks.authTest).toHaveBeenCalledTimes(1)
      expect(globalThis.__slackMocks.socketStart).toHaveBeenCalledTimes(1)
      expect(globalThis.__slackMocks.webCtorTokens).toEqual(['xoxb-test'])
      expect(socket.opts).toEqual({ appToken: 'xapp-test' })
      expect(adapter.status()).toBe('connected')
    })
  })

  describe('slack_event handling', () => {
    it('acks the envelope before processing the message', async () => {
      const order: string[] = []
      const adapter = new SlackAdapter()
      const ctx = makeCtx({ onIngest: vi.fn(() => order.push('ingest')) })
      const socket = await startConnected(adapter, ctx)

      const ack = vi.fn(async () => { order.push('ack') })
      await emitMessageEvent(socket, dmEvent(), ack)

      expect(ack).toHaveBeenCalledTimes(1)
      expect(order[0]).toBe('ack')
      expect(order).toEqual(['ack', 'ingest'])
    })

    it('acks but skips messages from our own user', async () => {
      const onIngest = vi.fn()
      const adapter = new SlackAdapter()
      const socket = await startConnected(adapter, makeCtx({ onIngest }))

      const ack = await emitMessageEvent(socket, dmEvent({ user: SELF_ID }))
      expect(ack).toHaveBeenCalledTimes(1)
      expect(onIngest).not.toHaveBeenCalled()
    })

    it('skips messages carrying a bot_id', async () => {
      const onIngest = vi.fn()
      const adapter = new SlackAdapter()
      const socket = await startConnected(adapter, makeCtx({ onIngest }))

      await emitMessageEvent(socket, dmEvent({ bot_id: 'B7777777' }))
      expect(onIngest).not.toHaveBeenCalled()
    })

    it('skips message_changed subtype events', async () => {
      const onIngest = vi.fn()
      const adapter = new SlackAdapter()
      const socket = await startConnected(adapter, makeCtx({ onIngest }))

      await emitMessageEvent(socket, dmEvent({ subtype: 'message_changed' }))
      expect(onIngest).not.toHaveBeenCalled()
    })
  })

  describe('inbound policy filtering', () => {
    it('drops DMs when policy.dm === "none"', async () => {
      const onIngest = vi.fn()
      const adapter = new SlackAdapter()
      const ctx = makeCtx({ config: { enabled: true, policy: { dm: 'none' } }, onIngest })
      const socket = await startConnected(adapter, ctx)

      await emitMessageEvent(socket, dmEvent())
      expect(onIngest).not.toHaveBeenCalled()
    })

    it('applies the DM allowlist', async () => {
      const onIngest = vi.fn()
      const adapter = new SlackAdapter()
      const ctx = makeCtx({
        config: { enabled: true, policy: { dm: 'allowlist', allow_from: ['U1000001'] } },
        onIngest
      })
      const socket = await startConnected(adapter, ctx)

      await emitMessageEvent(socket, dmEvent({ user: 'U2000002', ts: '1.000001' }))
      expect(onIngest).not.toHaveBeenCalled()

      await emitMessageEvent(socket, dmEvent({ user: 'U1000001', ts: '1.000002' }))
      expect(onIngest).toHaveBeenCalledTimes(1)
      expect((onIngest.mock.calls[0][0] as InboundMessage).sender).toBe('U1000001')
    })

    it('drops channel messages without a mention when policy.groups === "mention"', async () => {
      const onIngest = vi.fn()
      const adapter = new SlackAdapter()
      const ctx = makeCtx({ config: { enabled: true, policy: { groups: 'mention' } }, onIngest })
      const socket = await startConnected(adapter, ctx)

      await emitMessageEvent(socket, channelEvent({ text: 'no mention here' }))
      expect(onIngest).not.toHaveBeenCalled()
    })

    it('accepts channel messages mentioning the bot when policy.groups === "mention"', async () => {
      const onIngest = vi.fn()
      const adapter = new SlackAdapter()
      const ctx = makeCtx({ config: { enabled: true, policy: { groups: 'mention' } }, onIngest })
      const socket = await startConnected(adapter, ctx)

      await emitMessageEvent(socket, channelEvent({ text: `<@${SELF_ID}> hi bot` }))
      expect(onIngest).toHaveBeenCalledTimes(1)
      const ingested = onIngest.mock.calls[0][0] as InboundMessage
      // The self-mention token is stripped from the visible payload
      expect(ingested.payload).toBe('hi bot')
    })
  })

  describe('sourceMeta mapping', () => {
    it('maps chat_id and message_id from channel and ts', async () => {
      const onIngest = vi.fn()
      const adapter = new SlackAdapter()
      const socket = await startConnected(adapter, makeCtx({ onIngest }))

      await emitMessageEvent(socket, dmEvent({ channel: 'D1111111', ts: '1700.500' }))
      const meta = (onIngest.mock.calls[0][0] as InboundMessage).sourceMeta!
      expect(meta.chat_id).toBe('D1111111')
      expect(meta.message_id).toBe('1700.500')
      expect(meta.channel_type).toBe('im')
      expect(meta.reply_to_message_id).toBeUndefined()
    })

    it('sets reply_to_message_id = thread_ts for thread replies', async () => {
      const onIngest = vi.fn()
      const adapter = new SlackAdapter()
      const socket = await startConnected(adapter, makeCtx({ onIngest }))

      await emitMessageEvent(socket, dmEvent({ ts: '1701.100', thread_ts: '1700.000' }))
      const meta = (onIngest.mock.calls[0][0] as InboundMessage).sourceMeta!
      expect(meta.thread_ts).toBe('1700.000')
      expect(meta.reply_to_message_id).toBe('1700.000')
    })

    it('does NOT set reply_to_message_id for a thread root (thread_ts === ts)', async () => {
      const onIngest = vi.fn()
      const adapter = new SlackAdapter()
      const socket = await startConnected(adapter, makeCtx({ onIngest }))

      await emitMessageEvent(socket, dmEvent({ ts: '1700.000', thread_ts: '1700.000' }))
      const meta = (onIngest.mock.calls[0][0] as InboundMessage).sourceMeta!
      expect(meta.thread_ts).toBe('1700.000')
      expect(meta.reply_to_message_id).toBeUndefined()
    })
  })

  describe('meta.group enrichment', () => {
    it('attaches cached group meta with capped participants for channel messages', async () => {
      const memberIds = Array.from({ length: 25 }, (_, i) => `U${String(i).padStart(7, '0')}`)
      globalThis.__slackMocks.convInfo.mockResolvedValue({
        channel: { name: 'general', num_members: 25, purpose: { value: 'All the things' } }
      })
      globalThis.__slackMocks.convMembers.mockResolvedValue({ members: memberIds })

      const onIngest = vi.fn()
      const adapter = new SlackAdapter()
      const socket = await startConnected(adapter, makeCtx({ onIngest }))

      await emitMessageEvent(socket, channelEvent({ ts: '1.000001' }))
      expect(onIngest).toHaveBeenCalledTimes(1)
      const first = onIngest.mock.calls[0][0] as InboundMessage
      const group = (first.meta as { group: Record<string, unknown> }).group
      expect(group.platform).toBe('slack')
      expect(group.chat_id).toBe('C7777777')
      expect(group.title).toBe('#general')
      // Roster capped at MAX_GROUP_PARTICIPANTS (20) with truncation flags set
      expect((group.participants as unknown[]).length).toBe(20)
      expect(group.participant_count).toBe(25)
      expect(group.participants_truncated).toBe(true)
      expect(group.participants_scope).toBe('page')

      // Second message in the same channel — meta comes from cache
      await emitMessageEvent(socket, channelEvent({ ts: '1.000002' }))
      expect(onIngest).toHaveBeenCalledTimes(2)
      const second = onIngest.mock.calls[1][0] as InboundMessage
      expect((second.meta as { group: Record<string, unknown> }).group).toEqual(group)
      expect(globalThis.__slackMocks.convInfo).toHaveBeenCalledTimes(1)
    })

    it('does not attach meta.group for DMs', async () => {
      const onIngest = vi.fn()
      const adapter = new SlackAdapter()
      const socket = await startConnected(adapter, makeCtx({ onIngest }))

      await emitMessageEvent(socket, dmEvent())
      expect((onIngest.mock.calls[0][0] as InboundMessage).meta).toBeUndefined()
    })
  })

  describe('send()', () => {
    it('returns an error when not connected', async () => {
      const adapter = new SlackAdapter()
      const result = await adapter.send({
        id: 'm0', recipientId: 'C7777777', payload: 'hi'
      } satisfies OutboundMessage)
      expect(result).toEqual({ success: false, error: 'Slack adapter not connected' })
    })

    it('threads under the parent message (thread_ts ?? message_id) and returns the posted ts', async () => {
      const adapter = new SlackAdapter()
      await startConnected(adapter, makeCtx())
      globalThis.__slackMocks.postMessage.mockResolvedValue({ ok: true, ts: '2000.999' })

      const result = await adapter.send({
        id: 'm1',
        recipientId: 'U1000001',
        payload: 'reply body',
        sourceMeta: { chat_id: 'C7777777', message_id: '1700.500' }
      } satisfies OutboundMessage)

      expect(result.success).toBe(true)
      expect(result.sourceMeta?.message_id).toBe('2000.999')
      expect(result.sourceMeta?.chat_id).toBe('C7777777')
      expect(globalThis.__slackMocks.postMessage).toHaveBeenCalledTimes(1)
      const arg = globalThis.__slackMocks.postMessage.mock.calls[0][0]
      expect(arg.channel).toBe('C7777777')
      expect(arg.thread_ts).toBe('1700.500')
      expect(arg.text).toBe('reply body')
    })

    it('prefers the parent thread_ts over message_id when both are present', async () => {
      const adapter = new SlackAdapter()
      await startConnected(adapter, makeCtx())

      await adapter.send({
        id: 'm2',
        recipientId: 'U1000001',
        payload: 'threaded',
        sourceMeta: { chat_id: 'C7777777', message_id: '1701.100', thread_ts: '1700.000' }
      } satisfies OutboundMessage)

      const arg = globalThis.__slackMocks.postMessage.mock.calls[0][0]
      expect(arg.thread_ts).toBe('1700.000')
    })

    it('opens a DM conversation when sending to a bare user id', async () => {
      const adapter = new SlackAdapter()
      await startConnected(adapter, makeCtx())
      globalThis.__slackMocks.convOpen.mockResolvedValue({ channel: { id: 'D9000001' } })

      const result = await adapter.send({
        id: 'm3', recipientId: 'U1000001A', payload: 'dm text'
      } satisfies OutboundMessage)

      expect(globalThis.__slackMocks.convOpen).toHaveBeenCalledWith({ users: 'U1000001A' })
      const arg = globalThis.__slackMocks.postMessage.mock.calls[0][0]
      expect(arg.channel).toBe('D9000001')
      expect(result.success).toBe(true)
      expect(result.sourceMeta?.chat_id).toBe('D9000001')
      expect(result.sourceMeta?.message_id).toBe('999.111')
    })

    it('renders typed form content as a plain-text questionnaire', async () => {
      const adapter = new SlackAdapter()
      await startConnected(adapter, makeCtx())

      const form = {
        id: 'colorform',
        title: 'Quick poll',
        render: 'per_question',
        questions: [{
          id: 'q1',
          text: 'What is your favorite color?',
          type: 'choice',
          options: [{ id: 'a', label: 'Red' }, { id: 'b', label: 'Blue' }]
        }]
      }
      const result = await adapter.send({
        id: 'm4',
        recipientId: 'C7777777',
        payload: JSON.stringify(form),
        contentType: 'application/vnd.adf.form+json'
      } satisfies OutboundMessage)

      expect(result.success).toBe(true)
      const arg = globalThis.__slackMocks.postMessage.mock.calls[0][0]
      expect(arg.text).toContain('What is your favorite color?')
      expect(arg.text).toContain('Red')
      expect(arg.text).not.toContain('"questions"')
    })
  })

  describe('getChatInfo()', () => {
    it('returns unsupported when disconnected', async () => {
      const adapter = new SlackAdapter()
      const result = await adapter.getChatInfo('C7777777')
      expect(result.supported).toBe(false)
      if (!result.supported) expect(result.reason).toMatch(/not connected/)
    })

    it('returns channel info with participants and truncation flags', async () => {
      globalThis.__slackMocks.convInfo.mockResolvedValue({
        channel: { name: 'general', num_members: 30, topic: { value: 'Topic here' } }
      })
      globalThis.__slackMocks.convMembers.mockResolvedValue({
        members: ['U0000001', 'U0000002', 'U0000003'],
        response_metadata: {}
      })

      const adapter = new SlackAdapter()
      await startConnected(adapter, makeCtx())

      const result = await adapter.getChatInfo('C7777777')
      expect(result.supported).toBe(true)
      if (!result.supported) return
      expect(result.info.platform).toBe('slack')
      expect(result.info.chat_id).toBe('C7777777')
      expect(result.info.chat_type).toBe('channel')
      expect(result.info.title).toBe('#general')
      expect(result.info.participants).toEqual([
        { id: 'U0000001', name: 'Name-U0000001' },
        { id: 'U0000002', name: 'Name-U0000002' },
        { id: 'U0000003', name: 'Name-U0000003' }
      ])
      expect(result.info.participant_count).toBe(30)
      expect(result.info.participants_truncated).toBe(true)
      expect(result.info.participants_scope).toBe('page')
    })
  })

  describe('canDeliver()', () => {
    it('accepts channel/DM/user ids only when connected', async () => {
      const adapter = new SlackAdapter()
      expect(adapter.canDeliver('C7777777A')).toBe(false) // not connected yet
      await startConnected(adapter, makeCtx())
      expect(adapter.canDeliver('C7777777A')).toBe(true)
      expect(adapter.canDeliver('D9000001A')).toBe(true)
      expect(adapter.canDeliver('U1000001A')).toBe(true)
      expect(adapter.canDeliver('not-an-id')).toBe(false)
    })
  })
})

describe('markdownToMrkdwn', () => {
  it('converts ** bold markers to single asterisks', () => {
    // Word-adjacent bold survives as mrkdwn bold
    expect(markdownToMrkdwn('x**bold**y')).toBe('x*bold*y')
  })

  it('keeps standalone **bold** as Slack bold, untouched by the italic pass', () => {
    expect(markdownToMrkdwn('this is **bold** text')).toBe('this is *bold* text')
  })

  it('converts [text](url) links to <url|text>', () => {
    expect(markdownToMrkdwn('see [docs](https://example.com)')).toBe('see <https://example.com|docs>')
  })

  it('preserves inline code untouched', () => {
    expect(markdownToMrkdwn('run `a < b && c` now')).toBe('run `a < b && c` now')
  })

  it('preserves fenced code block bodies untouched', () => {
    const input = '```js\nconst x = a < b && **not bold**\n```'
    const out = markdownToMrkdwn(input)
    // Body keeps raw < & ** — no escaping, no bold conversion inside the fence
    expect(out).toContain('const x = a < b && **not bold**')
    expect(out).not.toContain('&lt;')
    expect(out).not.toContain('&amp;')
  })

  it('escapes & < > outside code', () => {
    expect(markdownToMrkdwn('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d')
  })
})
