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
interface MockDiscordClient extends EventEmitter {
  user: { id: string; username: string } | null
  channels: { fetch: ReturnType<typeof vi.fn> }
  login(token: string): Promise<string>
  destroy(): Promise<void>
}

declare global {
  // eslint-disable-next-line no-var
  var __discordMocks: {
    channelSend: ReturnType<typeof vi.fn>
    channelsFetch: ReturnType<typeof vi.fn>
    loginMock: ReturnType<typeof vi.fn>
    destroyMock: ReturnType<typeof vi.fn>
    restPutMock: ReturnType<typeof vi.fn>
    // Captured constructor args so tests can assert on intents
    constructorArgs: unknown[]
    // Reference to the most-recently-created mock client (so tests can drive events)
    lastClient: MockDiscordClient | null
  }
}

vi.mock('discord.js', async () => {
  // The factory is hoisted to the top of the file — keep ALL state and class
  // definitions inside it so they don't TDZ. The `EventEmitter` import path is
  // resolved lazily here to dodge the hoisting trap.
  const { EventEmitter: NodeEventEmitter } = await import('events')

  // Mirror the small surface of discord.js the adapter touches. Anything
  // structural (enums, builders, REST) gets a no-frills shim.
  const ChannelType = { DM: 1, GuildText: 0 }
  const GatewayIntentBits = {
    Guilds: 1, GuildMessages: 2, MessageContent: 4, DirectMessages: 8
  }
  const Events = {
    MessageCreate: 'messageCreate',
    InteractionCreate: 'interactionCreate',
    ClientReady: 'clientReady',
    Error: 'error'
  }
  const MessageFlags = { Ephemeral: 64 }
  const Partials = { Channel: 'CHANNEL', Message: 'MESSAGE' }

  class MockClient extends NodeEventEmitter {
    public user: { id: string; username: string } | null = null
    public channels: { fetch: ReturnType<typeof vi.fn> }

    constructor(opts: unknown) {
      super()
      globalThis.__discordMocks.constructorArgs.push(opts)
      globalThis.__discordMocks.lastClient = this as unknown as MockDiscordClient
      this.channels = { fetch: globalThis.__discordMocks.channelsFetch }
    }

    async login(token: string): Promise<string> {
      return globalThis.__discordMocks.loginMock(token)
    }

    async destroy(): Promise<void> {
      return globalThis.__discordMocks.destroyMock()
    }
  }

  class AttachmentBuilder {
    constructor(public data: Buffer | string, public opts: { name?: string }) {}
  }

  class SlashCommandBuilder {
    name = ''
    description = ''
    options: unknown[] = []
    setName(n: string) { this.name = n; return this }
    setDescription(d: string) { this.description = d; return this }
    addStringOption(fn: (opt: unknown) => unknown) {
      const opt: unknown = { setName: () => opt, setDescription: () => opt, setRequired: () => opt }
      fn(opt)
      return this
    }
    toJSON() { return { name: this.name, description: this.description } }
  }

  class REST {
    setToken(_t: string) { return this }
    async put(route: string, body: unknown) { return globalThis.__discordMocks.restPutMock(route, body) }
  }

  const Routes = { applicationCommands: (id: string) => `/applications/${id}/commands` }

  return {
    Client: MockClient,
    ChannelType,
    GatewayIntentBits,
    Events,
    MessageFlags,
    Partials,
    AttachmentBuilder,
    SlashCommandBuilder,
    REST,
    Routes
  }
})

// Import AFTER vi.mock so the factory wins.
import { DiscordAdapter } from '../../../src/main/adapters/discord/discord-adapter'

function makeCtx(overrides: Partial<{
  credentials: Record<string, string | null>
  config: AdapterInstanceConfig
  onIngest: (m: InboundMessage) => void
  onWriteAttachment: (path: string, data: Buffer, mimeType?: string) => void
}> = {}): AdapterContext {
  const credentials = overrides.credentials ?? { DISCORD_BOT_TOKEN: 'test-token' }
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
  globalThis.__discordMocks = {
    channelSend: vi.fn(),
    channelsFetch: vi.fn(),
    loginMock: vi.fn().mockResolvedValue('ok'),
    destroyMock: vi.fn().mockResolvedValue(undefined),
    restPutMock: vi.fn().mockResolvedValue(undefined),
    constructorArgs: [],
    lastClient: null
  }
})

async function startConnected(adapter: DiscordAdapter, ctx: AdapterContext): Promise<MockDiscordClient> {
  await adapter.start(ctx)
  const client = globalThis.__discordMocks.lastClient!
  client.user = { id: 'bot-123', username: 'TestBot' }
  // Rebind channels.fetch to the per-test mock so tests don't fight stale refs.
  client.channels = { fetch: globalThis.__discordMocks.channelsFetch }
  // Fire ClientReady to drive the adapter into the `connected` state.
  client.emit('clientReady', client)
  // Yield so the registered async handler can run.
  await new Promise((r) => setImmediate(r))
  return client
}

describe('DiscordAdapter', () => {
  it('throws when DISCORD_BOT_TOKEN is missing', async () => {
    const adapter = new DiscordAdapter()
    const ctx = makeCtx({ credentials: {} })
    await expect(adapter.start(ctx)).rejects.toThrow(/DISCORD_BOT_TOKEN/)
    expect(adapter.status()).toBe('error')
  })

  it('opts into Partials.Channel so DM messageCreate events fire', async () => {
    // Regression: without Partials.Channel, discord.js v14 silently drops
    // messageCreate for DMs because the DM channel isn't cached on first contact.
    const adapter = new DiscordAdapter()
    const ctx = makeCtx()
    await adapter.start(ctx)
    const opts = globalThis.__discordMocks.constructorArgs[0] as { partials?: string[] }
    expect(opts.partials).toEqual(expect.arrayContaining(['CHANNEL']))
  })

  it('hydrates partial messages before reading content', async () => {
    const onIngest = vi.fn()
    const adapter = new DiscordAdapter()
    const ctx = makeCtx({ onIngest })
    const client = await startConnected(adapter, ctx)

    const hydrated = makeDmMessage({ content: 'hi from dm', authorId: 'user-7' })
    const fetchMock = vi.fn().mockResolvedValue(hydrated)
    const partial = { partial: true, fetch: fetchMock }
    client.emit('messageCreate', partial)
    await new Promise((r) => setImmediate(r))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(onIngest).toHaveBeenCalledTimes(1)
    expect(onIngest.mock.calls[0][0].payload).toBe('hi from dm')
  })

  it('returns "Bot not connected" when send() is called before start', async () => {
    const adapter = new DiscordAdapter()
    const result = await adapter.send({
      id: 'm1', recipientId: 'channel-1', payload: 'hi'
    } satisfies OutboundMessage)
    expect(result).toEqual({ success: false, error: 'Bot not connected' })
  })

  describe('inbound policy filtering', () => {
    it('drops DMs when policy.dm === "none"', async () => {
      const onIngest = vi.fn()
      const adapter = new DiscordAdapter()
      const ctx = makeCtx({ config: { enabled: true, policy: { dm: 'none' } }, onIngest })
      const client = await startConnected(adapter, ctx)

      client.emit('messageCreate', makeDmMessage({ content: 'hello', authorId: 'user-1' }))
      await new Promise((r) => setImmediate(r))
      expect(onIngest).not.toHaveBeenCalled()
    })

    it('drops guild messages without mention when policy.groups === "mention"', async () => {
      const onIngest = vi.fn()
      const adapter = new DiscordAdapter()
      const ctx = makeCtx({ config: { enabled: true, policy: { groups: 'mention' } }, onIngest })
      const client = await startConnected(adapter, ctx)

      client.emit('messageCreate', makeGuildMessage({
        content: 'random chatter', authorId: 'user-1', mentions: new Set()
      }))
      await new Promise((r) => setImmediate(r))
      expect(onIngest).not.toHaveBeenCalled()
    })

    it('accepts guild messages when bot is mentioned and policy.groups === "mention"', async () => {
      const onIngest = vi.fn()
      const adapter = new DiscordAdapter()
      const ctx = makeCtx({ config: { enabled: true, policy: { groups: 'mention' } }, onIngest })
      const client = await startConnected(adapter, ctx)

      client.emit('messageCreate', makeGuildMessage({
        content: '<@bot-123> hi', authorId: 'user-1', mentions: new Set(['bot-123'])
      }))
      await new Promise((r) => setImmediate(r))
      expect(onIngest).toHaveBeenCalledTimes(1)
      const ingested: InboundMessage = onIngest.mock.calls[0][0]
      expect(ingested.sender).toBe('user-1')
      expect(ingested.payload).toBe('<@bot-123> hi')
      expect(ingested.sourceMeta?.channel_type).toBe('guild')
    })

    it('ignores the bot\'s own messages', async () => {
      const onIngest = vi.fn()
      const adapter = new DiscordAdapter()
      const ctx = makeCtx({ onIngest })
      const client = await startConnected(adapter, ctx)

      client.emit('messageCreate', makeDmMessage({ content: 'self-echo', authorId: 'bot-123' }))
      await new Promise((r) => setImmediate(r))
      expect(onIngest).not.toHaveBeenCalled()
    })
  })

  describe('send()', () => {
    it('sets reply.messageReference when sourceMeta.message_id is present', async () => {
      const adapter = new DiscordAdapter()
      const ctx = makeCtx()
      const client = await startConnected(adapter, ctx)

      const sendMock = vi.fn().mockResolvedValue({ id: 'sent-1', guildId: 'g-1' })
      globalThis.__discordMocks.channelsFetch.mockResolvedValue({ send: sendMock })
      client.channels = { fetch: globalThis.__discordMocks.channelsFetch }

      const result = await adapter.send({
        id: 'm1',
        recipientId: 'channel-1',
        payload: 'reply body',
        sourceMeta: { channel_id: 'channel-1', message_id: 'orig-99' }
      } satisfies OutboundMessage)

      expect(result.success).toBe(true)
      expect(result.sourceMeta?.message_id).toBe('sent-1')
      expect(sendMock).toHaveBeenCalledTimes(1)
      const sendArg = sendMock.mock.calls[0][0]
      expect(sendArg.reply).toEqual({ messageReference: 'orig-99', failIfNotExists: false })
      expect(sendArg.content).toBe('reply body')
    })

    it('attaches a .txt file and truncates content when payload exceeds 2000 chars', async () => {
      const adapter = new DiscordAdapter()
      const ctx = makeCtx()
      const client = await startConnected(adapter, ctx)

      const sendMock = vi.fn().mockResolvedValue({ id: 'sent-2', guildId: null })
      globalThis.__discordMocks.channelsFetch.mockResolvedValue({ send: sendMock })
      client.channels = { fetch: globalThis.__discordMocks.channelsFetch }

      const longPayload = 'x'.repeat(3000)
      const result = await adapter.send({
        id: 'm2', recipientId: 'channel-2', payload: longPayload
      } satisfies OutboundMessage)

      expect(result.success).toBe(true)
      const sendArg = sendMock.mock.calls[0][0]
      expect(sendArg.content.length).toBe(2000)
      expect(sendArg.content.endsWith('…')).toBe(true)
      expect(Array.isArray(sendArg.files)).toBe(true)
      expect(sendArg.files).toHaveLength(1)
      expect(sendArg.files[0].opts.name).toBe('message.txt')
    })
  })
})

// --- Test helpers ---

function makeDmMessage(opts: { content: string; authorId: string }): unknown {
  return {
    id: 'msg-' + Math.random().toString(36).slice(2),
    content: opts.content,
    author: { id: opts.authorId, bot: false, username: 'u', globalName: 'U' },
    channel: { id: 'dm-channel', type: 1 /* ChannelType.DM */ },
    guildId: null,
    mentions: { users: new Map(), repliedUser: null },
    attachments: new Map(),
    reference: null,
    createdTimestamp: Date.now()
  }
}

function makeGuildMessage(opts: { content: string; authorId: string; mentions: Set<string> }): unknown {
  const userMap = new Map<string, { id: string }>()
  for (const id of opts.mentions) userMap.set(id, { id })
  return {
    id: 'msg-' + Math.random().toString(36).slice(2),
    content: opts.content,
    author: { id: opts.authorId, bot: false, username: 'u', globalName: 'U' },
    channel: { id: 'guild-channel', type: 0 /* GuildText */ },
    guildId: 'g-1',
    mentions: { users: userMap, repliedUser: null },
    attachments: new Map(),
    reference: null,
    createdTimestamp: Date.now()
  }
}
