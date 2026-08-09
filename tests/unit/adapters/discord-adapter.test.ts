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
    setToken() { return this }
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
import { DiscordAdapter, describeDiscordError } from '../../../src/main/adapters/discord/discord-adapter'
import { findAdapterRegistryEntry } from '../../../src/shared/constants/adapter-registry'

// Every user-actionable error must end with the setup-guide link so the agent
// can point the user at the docs. Derived from the registry, not hardcoded.
const DISCORD_DOCS_URL = findAdapterRegistryEntry('discord')?.docsUrl ?? ''
const SETUP_GUIDE_RE = new RegExp(
  `Setup guide: ${DISCORD_DOCS_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
)

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

  it('returns an actionable not-connected error when send() is called before start', async () => {
    const adapter = new DiscordAdapter()
    const result = await adapter.send({
      id: 'm1', recipientId: 'channel-1', payload: 'hi'
    } satisfies OutboundMessage)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not connected/i)
    expect(result.error).toMatch(/Settings > Channel Adapters > Discord/)
    expect(result.error).toMatch(SETUP_GUIDE_RE)
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

  describe('actionable error messages', () => {
    it('sanity: the discord registry entry has a docs URL for withSetupGuide', () => {
      expect(DISCORD_DOCS_URL).toMatch(/^https:\/\//)
    })

    it('maps an invalid-token login failure to bot-token fix steps', async () => {
      const adapter = new DiscordAdapter()
      const ctx = makeCtx()
      globalThis.__discordMocks.loginMock.mockRejectedValue(
        Object.assign(new Error('An invalid token was provided.'), { code: 'TokenInvalid' })
      )
      const startPromise = adapter.start(ctx)
      await expect(startPromise).rejects.toThrow(/DISCORD_BOT_TOKEN/)
      await expect(startPromise).rejects.toThrow(/Reset Token/)
      await expect(startPromise).rejects.toThrow(/Settings > Channel Adapters > Discord/)
      await expect(startPromise).rejects.toThrow(SETUP_GUIDE_RE)
      expect(adapter.status()).toBe('error')
    })

    it('maps a disallowed-intents login failure to privileged-intents fix steps', async () => {
      const adapter = new DiscordAdapter()
      const ctx = makeCtx()
      globalThis.__discordMocks.loginMock.mockRejectedValue(new Error('Used disallowed intents'))
      const startPromise = adapter.start(ctx)
      await expect(startPromise).rejects.toThrow(/Privileged Gateway Intents/)
      await expect(startPromise).rejects.toThrow(/MESSAGE CONTENT INTENT/)
      await expect(startPromise).rejects.toThrow(SETUP_GUIDE_RE)
      expect(adapter.status()).toBe('error')
    })

    it('maps 50013 Missing Permissions send failures to permission fix steps', async () => {
      const adapter = new DiscordAdapter()
      const ctx = makeCtx()
      const client = await startConnected(adapter, ctx)

      const sendMock = vi.fn().mockRejectedValue(
        Object.assign(new Error('Missing Permissions'), { code: 50013, status: 403 })
      )
      globalThis.__discordMocks.channelsFetch.mockResolvedValue({ send: sendMock })
      client.channels = { fetch: globalThis.__discordMocks.channelsFetch }

      const result = await adapter.send({
        id: 'm1', recipientId: 'channel-1', payload: 'hi'
      } satisfies OutboundMessage)

      expect(result.success).toBe(false)
      expect(result.error).toMatch(/50013/)
      expect(result.error).toMatch(/View Channels, Send Messages/)
      expect(result.error).toMatch(/re-invite/)
      expect(result.error).toMatch(SETUP_GUIDE_RE)
    })

    it('delivers the text without files and reports partial success when the combined send fails on an attachment', async () => {
      const adapter = new DiscordAdapter()
      const ctx = makeCtx()
      const client = await startConnected(adapter, ctx)

      const tooLarge = Object.assign(new Error('Request entity too large'), { code: 40005, status: 413 })
      const sendMock = vi.fn()
        .mockRejectedValueOnce(tooLarge) // combined text+files send
        .mockResolvedValueOnce({ id: 'sent-9', guildId: 'g-1' }) // text-only retry
      globalThis.__discordMocks.channelsFetch.mockResolvedValue({ send: sendMock })
      client.channels = { fetch: globalThis.__discordMocks.channelsFetch }

      const result = await adapter.send({
        id: 'm1',
        recipientId: 'channel-1',
        payload: 'report attached',
        attachments: [{
          path: 'out/big.bin',
          filename: 'big.bin',
          mimeType: 'application/octet-stream',
          size: 1024,
          data: Buffer.alloc(1024)
        }]
      } satisfies OutboundMessage)

      // First call carried the file, retry dropped it but kept the text
      expect(sendMock).toHaveBeenCalledTimes(2)
      expect(sendMock.mock.calls[0][0].files).toHaveLength(1)
      expect(sendMock.mock.calls[1][0].files).toBeUndefined()
      expect(sendMock.mock.calls[1][0].content).toBe('report attached')

      expect(result.success).toBe(false)
      expect(result.error).toMatch(/Text message was delivered to channel channel-1 \(message_id=sent-9\)/)
      expect(result.error).toMatch(/1 attachment\(s\) failed to send \("big\.bin"\)/)
      expect(result.error).toMatch(/40005/)
      expect(result.error).toMatch(/upload limit/)
      expect(result.error).toMatch(/Do not re-send the text/)
      expect(result.error).toMatch(SETUP_GUIDE_RE)
      // sourceMeta preserved for the delivered text so replies can thread
      expect(result.sourceMeta).toEqual({
        channel_id: 'channel-1', message_id: 'sent-9', guild_id: 'g-1'
      })
    })

    it('reports a full failure (no partial-success claim) when the text-only retry also fails', async () => {
      const adapter = new DiscordAdapter()
      const ctx = makeCtx()
      const client = await startConnected(adapter, ctx)

      const denied = Object.assign(new Error('Missing Permissions'), { code: 50013 })
      const sendMock = vi.fn().mockRejectedValue(denied)
      globalThis.__discordMocks.channelsFetch.mockResolvedValue({ send: sendMock })
      client.channels = { fetch: globalThis.__discordMocks.channelsFetch }

      const result = await adapter.send({
        id: 'm1',
        recipientId: 'channel-1',
        payload: 'hello',
        attachments: [{
          path: 'out/a.png', filename: 'a.png', mimeType: 'image/png', size: 10, data: Buffer.alloc(10)
        }]
      } satisfies OutboundMessage)

      expect(sendMock).toHaveBeenCalledTimes(2) // combined send + failed retry
      expect(result.success).toBe(false)
      expect(result.error).not.toMatch(/Text message was delivered/)
      expect(result.error).toMatch(/50013/)
      expect(result.error).toMatch(SETUP_GUIDE_RE)
      expect(result.sourceMeta).toBeUndefined()
    })

    it('keeps unmapped errors verbatim but still appends the setup-guide link', async () => {
      const adapter = new DiscordAdapter()
      const ctx = makeCtx()
      const client = await startConnected(adapter, ctx)

      const sendMock = vi.fn().mockRejectedValue(new Error('socket hang up'))
      globalThis.__discordMocks.channelsFetch.mockResolvedValue({ send: sendMock })
      client.channels = { fetch: globalThis.__discordMocks.channelsFetch }

      const result = await adapter.send({
        id: 'm1', recipientId: 'channel-1', payload: 'hi'
      } satisfies OutboundMessage)

      expect(result.success).toBe(false)
      expect(result.error).toContain('socket hang up')
      expect(result.error).toMatch(SETUP_GUIDE_RE)
    })

    describe('describeDiscordError mappings', () => {
      it('maps 50007 to DM privacy guidance', () => {
        const text = describeDiscordError(
          Object.assign(new Error('Cannot send messages to this user'), { code: 50007 })
        )
        expect(text).toMatch(/privacy settings/)
        expect(text).toMatch(/mutual server|shares a server/)
      })

      it('maps 50001 to missing-access guidance', () => {
        const text = describeDiscordError(
          Object.assign(new Error('Missing Access'), { code: 50001 })
        )
        expect(text).toMatch(/50001/)
        expect(text).toMatch(/invite the bot/)
      })

      it('maps 10003 to wrong-channel-id guidance', () => {
        const text = describeDiscordError(
          Object.assign(new Error('Unknown Channel'), { code: 10003 })
        )
        expect(text).toMatch(/Unknown Channel/)
        expect(text).toMatch(/Copy Channel ID/)
      })

      it('maps rate limits to retry-later guidance', () => {
        const text = describeDiscordError(
          Object.assign(new Error('You are being rate limited.'), { status: 429 })
        )
        expect(text).toMatch(/rate limiting/)
        expect(text).toMatch(/retry/)
      })

      it('names the largest attachment on 40005', () => {
        const text = describeDiscordError(
          Object.assign(new Error('Request entity too large'), { code: 40005 }),
          [
            { name: 'small.png', size: 2 * 1024 * 1024 },
            { name: 'huge.mov', size: 30 * 1024 * 1024 }
          ]
        )
        expect(text).toMatch(/40005/)
        expect(text).toMatch(/"huge\.mov" \(30\.0 MB\)/)
        expect(text).toMatch(/"huge\.mov" is the largest/)
        expect(text).toMatch(/8-25 MB/)
      })
    })
  })

  describe('meta.group enrichment', () => {
    it('attaches meta.group to guild messages with mentions scope and the author included', async () => {
      const onIngest = vi.fn()
      const adapter = new DiscordAdapter()
      const ctx = makeCtx({ onIngest })
      const client = await startConnected(adapter, ctx)

      client.emit('messageCreate', makeGuildMessage({
        content: 'hello guild',
        authorId: 'user-1',
        mentions: new Set(['user-2']),
        guild: { name: 'My Guild', memberCount: 250 },
        channelName: 'general'
      }))
      await new Promise((r) => setImmediate(r))

      expect(onIngest).toHaveBeenCalledTimes(1)
      const inbound: InboundMessage = onIngest.mock.calls[0][0]
      expect(inbound.meta).toBeDefined()
      const group = (inbound.meta as { group: Record<string, unknown> }).group
      expect(group).toMatchObject({
        platform: 'discord',
        chat_id: 'guild-channel',
        chat_type: 'guild',
        title: '#general',
        description: 'My Guild',
        participant_count: 250,
        participants_scope: 'mentions',
        participants_truncated: true
      })
      const participants = group.participants as { id: string; name?: string }[]
      // Author comes first, then the users mentioned in this message
      expect(participants[0]).toEqual({ id: 'user-1', name: 'U' })
      expect(participants.map((p) => p.id)).toContain('user-2')
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

function makeGuildMessage(opts: {
  content: string
  authorId: string
  mentions: Set<string>
  guild?: { name: string; memberCount: number }
  channelName?: string
}): unknown {
  const userMap = new Map<string, { id: string; username: string }>()
  for (const id of opts.mentions) userMap.set(id, { id, username: `name-${id}` })
  // discord.js Collections expose .map (used by meta.group enrichment) on top
  // of the Map interface (.has is used by the mention policy filter).
  const users = Object.assign(userMap, {
    map: <T>(fn: (u: { id: string; username: string }) => T): T[] => [...userMap.values()].map(fn)
  })
  return {
    id: 'msg-' + Math.random().toString(36).slice(2),
    content: opts.content,
    author: { id: opts.authorId, bot: false, username: 'u', globalName: 'U' },
    channel: {
      id: 'guild-channel',
      type: 0 /* GuildText */,
      ...(opts.channelName ? { name: opts.channelName } : {})
    },
    guildId: 'g-1',
    guild: opts.guild ?? null,
    mentions: { users, repliedUser: null },
    attachments: new Map(),
    reference: null,
    createdTimestamp: Date.now()
  }
}
