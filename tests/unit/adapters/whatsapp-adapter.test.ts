import { beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  AdapterContext,
  AdapterInstanceConfig,
  InboundMessage,
  OutboundMessage
} from '../../../src/shared/types/channel-adapter.types'

// vi.mock factories are hoisted — keep all mutable mock state on globalThis to
// avoid temporal-dead-zone errors when the factory runs before module init.
interface FakeSock {
  ev: {
    on: ReturnType<typeof vi.fn>
    handlers: Map<string, (arg: never) => unknown>
  }
  user: { id: string; lid?: string } | null
  sendMessage: ReturnType<typeof vi.fn>
  groupMetadata: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
}

declare global {
  // eslint-disable-next-line no-var
  var __waMocks: {
    makeWASocket: ReturnType<typeof vi.fn>
    useMultiFileAuthState: ReturnType<typeof vi.fn>
    downloadMediaMessage: ReturnType<typeof vi.fn>
    qrToBuffer: ReturnType<typeof vi.fn>
    lastSock: FakeSock | null
  }
}

vi.mock('@whiskeysockets/baileys', () => {
  const makeWASocket = (opts: unknown): unknown => globalThis.__waMocks.makeWASocket(opts)
  return {
    default: makeWASocket,
    makeWASocket,
    useMultiFileAuthState: (dir: string) => globalThis.__waMocks.useMultiFileAuthState(dir),
    DisconnectReason: { loggedOut: 401 },
    downloadMediaMessage: (...a: unknown[]) => globalThis.__waMocks.downloadMediaMessage(...a),
    // Passthrough normalization: strip the ':NN' device suffix
    jidNormalizedUser: (jid: string) => (jid ?? '').replace(/:\d+@/, '@')
  }
})

vi.mock('qrcode', () => ({
  toBuffer: (...a: unknown[]) => globalThis.__waMocks.qrToBuffer(...a)
}))

// Import AFTER vi.mock so the factories win.
import { WhatsAppAdapter } from '../../../src/main/adapters/whatsapp/whatsapp-adapter'

const SELF_RAW_ID = '15551234567:12@s.whatsapp.net'
const SELF_JID = '15551234567@s.whatsapp.net'

function makeFakeSock(): FakeSock {
  const handlers = new Map<string, (arg: never) => unknown>()
  return {
    ev: {
      handlers,
      on: vi.fn((event: string, fn: (arg: never) => unknown) => {
        handlers.set(event, fn)
      })
    },
    user: null,
    sendMessage: vi.fn().mockResolvedValue({ key: { id: 'SENT-1' } }),
    groupMetadata: vi.fn().mockResolvedValue({
      subject: 'Test Group',
      desc: 'A test group',
      participants: [
        { id: 'admin@s.whatsapp.net', admin: 'admin' },
        { id: 'member@s.whatsapp.net', admin: null }
      ]
    }),
    end: vi.fn()
  }
}

function makeCtx(overrides: Partial<{
  config: AdapterInstanceConfig
  onIngest: (m: InboundMessage) => void
  onWriteAttachment: (path: string, data: Buffer, mimeType?: string) => void
  getDataDir: (() => string) | null
}> = {}): AdapterContext {
  const config = overrides.config ?? { enabled: true }
  const ctx: AdapterContext = {
    ingest: overrides.onIngest ?? vi.fn(),
    writeAttachment: overrides.onWriteAttachment ?? vi.fn(),
    getConfig: () => config,
    getCredential: () => null,
    log: vi.fn()
  }
  // getDataDir: null means "omit entirely" (older host); undefined means default
  if (overrides.getDataDir !== null) {
    ctx.getDataDir = overrides.getDataDir ?? (() => '/tmp/wa-auth')
  }
  return ctx
}

beforeEach(() => {
  globalThis.__waMocks = {
    makeWASocket: vi.fn((_opts: unknown) => {
      const sock = makeFakeSock()
      globalThis.__waMocks.lastSock = sock
      return sock
    }),
    useMultiFileAuthState: vi.fn().mockResolvedValue({ state: {}, saveCreds: vi.fn() }),
    downloadMediaMessage: vi.fn().mockResolvedValue(Buffer.from('media-bytes')),
    qrToBuffer: vi.fn().mockResolvedValue(Buffer.from('png-bytes')),
    lastSock: null
  }
})

async function flush(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setImmediate(r))
  }
}

/** Start the adapter and drive it to 'connected' via connection.update. */
async function startConnected(adapter: WhatsAppAdapter, ctx: AdapterContext): Promise<FakeSock> {
  await adapter.start(ctx)
  const sock = globalThis.__waMocks.lastSock!
  sock.user = { id: SELF_RAW_ID }
  const onUpdate = sock.ev.handlers.get('connection.update')!
  onUpdate({ connection: 'open' } as never)
  await flush()
  return sock
}

async function emitUpsert(sock: FakeSock, messages: unknown[], type = 'notify'): Promise<void> {
  const handler = sock.ev.handlers.get('messages.upsert')!
  await handler({ messages, type } as never)
  await flush()
}

function dmMessage(overrides: {
  text?: string
  remoteJid?: string
  id?: string
  fromMe?: boolean
  message?: Record<string, unknown> | null
} = {}): unknown {
  return {
    key: {
      fromMe: overrides.fromMe ?? false,
      remoteJid: overrides.remoteJid ?? '15550001111@s.whatsapp.net',
      id: overrides.id ?? 'MSG-1'
    },
    message: overrides.message === undefined
      ? { conversation: overrides.text ?? 'hello' }
      : overrides.message,
    pushName: 'Alice',
    messageTimestamp: 1700000000
  }
}

function groupMessage(overrides: {
  message?: Record<string, unknown>
  participant?: string
  id?: string
} = {}): unknown {
  return {
    key: {
      fromMe: false,
      remoteJid: '12036304@g.us',
      participant: overrides.participant ?? '15550002222@s.whatsapp.net',
      id: overrides.id ?? 'GMSG-1'
    },
    message: overrides.message ?? { conversation: 'group chatter' },
    pushName: 'Bob',
    messageTimestamp: 1700000001
  }
}

describe('WhatsAppAdapter', () => {
  describe('start()', () => {
    it('throws when the host provides no getDataDir', async () => {
      const adapter = new WhatsAppAdapter()
      const ctx = makeCtx({ getDataDir: null })
      await expect(adapter.start(ctx)).rejects.toThrow(/getDataDir/)
      expect(adapter.status()).toBe('error')
    })

    it('loads auth state from the adapter data dir and resolves before connecting', async () => {
      const adapter = new WhatsAppAdapter()
      const ctx = makeCtx({ getDataDir: () => '/data/agents/a1/whatsapp' })
      await adapter.start(ctx)
      expect(globalThis.__waMocks.useMultiFileAuthState).toHaveBeenCalledWith('/data/agents/a1/whatsapp')
      expect(globalThis.__waMocks.makeWASocket).toHaveBeenCalledTimes(1)
      // Connection completes asynchronously — start() leaves us 'connecting'
      expect(adapter.status()).toBe('connecting')
    })
  })

  describe('connection.update', () => {
    it('writes the pairing QR to the file store and stays connecting', async () => {
      const onWriteAttachment = vi.fn()
      const adapter = new WhatsAppAdapter()
      const ctx = makeCtx({ onWriteAttachment })
      await adapter.start(ctx)
      const sock = globalThis.__waMocks.lastSock!

      sock.ev.handlers.get('connection.update')!({ qr: 'qr-payload' } as never)
      await flush() // writePairingQr resolves the qrcode promise asynchronously

      expect(globalThis.__waMocks.qrToBuffer).toHaveBeenCalledWith('qr-payload', { type: 'png', width: 512 })
      expect(onWriteAttachment).toHaveBeenCalledTimes(1)
      const [path, data, mime] = onWriteAttachment.mock.calls[0]
      expect(path).toBe('imported/whatsapp/pairing-qr.png')
      expect(Buffer.isBuffer(data)).toBe(true)
      expect(mime).toBe('image/png')
      expect(adapter.status()).toBe('connecting')
    })

    it('flips to connected on open', async () => {
      const adapter = new WhatsAppAdapter()
      await startConnected(adapter, makeCtx())
      expect(adapter.status()).toBe('connected')
    })

    it('reports error on loggedOut close', async () => {
      const adapter = new WhatsAppAdapter()
      const ctx = makeCtx()
      const sock = await startConnected(adapter, ctx)

      sock.ev.handlers.get('connection.update')!({
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 401 } } }
      } as never)

      expect(adapter.status()).toBe('error')
      expect(ctx.log).toHaveBeenCalledWith('error', expect.stringContaining('logged out'))
    })

    it('re-creates the socket itself on transient close (Baileys sockets are one-shot)', async () => {
      const adapter = new WhatsAppAdapter()
      const ctx = makeCtx()
      const sock = await startConnected(adapter, ctx)
      expect(globalThis.__waMocks.makeWASocket).toHaveBeenCalledTimes(1)

      vi.useFakeTimers()
      try {
        sock.ev.handlers.get('connection.update')!({
          connection: 'close',
          lastDisconnect: { error: { output: { statusCode: 428 } } }
        } as never)

        // Stays 'connecting' (not 'error') so the manager's finite restart
        // budget is never consumed by routine reconnects
        expect(adapter.status()).toBe('connecting')
        expect(ctx.log).toHaveBeenCalledWith('warn', expect.stringContaining('reconnecting'))

        await vi.advanceTimersByTimeAsync(120_000)
        expect(globalThis.__waMocks.makeWASocket).toHaveBeenCalledTimes(2)

        await adapter.stop()
      } finally {
        vi.useRealTimers()
      }
    })

    it('does not reconnect after a deliberate stop', async () => {
      const adapter = new WhatsAppAdapter()
      const ctx = makeCtx()
      const sock = await startConnected(adapter, ctx)

      vi.useFakeTimers()
      try {
        sock.ev.handlers.get('connection.update')!({
          connection: 'close',
          lastDisconnect: { error: { output: { statusCode: 428 } } }
        } as never)
        await adapter.stop()

        await vi.advanceTimersByTimeAsync(120_000)
        expect(globalThis.__waMocks.makeWASocket).toHaveBeenCalledTimes(1)
        expect(adapter.status()).toBe('disconnected')
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('messages.upsert', () => {
    it('skips our own (fromMe) messages', async () => {
      const onIngest = vi.fn()
      const adapter = new WhatsAppAdapter()
      const sock = await startConnected(adapter, makeCtx({ onIngest }))

      await emitUpsert(sock, [dmMessage({ fromMe: true })])
      expect(onIngest).not.toHaveBeenCalled()
    })

    it('skips status@broadcast messages', async () => {
      const onIngest = vi.fn()
      const adapter = new WhatsAppAdapter()
      const sock = await startConnected(adapter, makeCtx({ onIngest }))

      await emitUpsert(sock, [dmMessage({ remoteJid: 'status@broadcast' })])
      expect(onIngest).not.toHaveBeenCalled()
    })

    it('ingests a DM text message with full sourceMeta', async () => {
      const onIngest = vi.fn()
      const adapter = new WhatsAppAdapter()
      const sock = await startConnected(adapter, makeCtx({ onIngest }))

      await emitUpsert(sock, [dmMessage({ text: 'hello there', id: 'MSG-42' })])
      expect(onIngest).toHaveBeenCalledTimes(1)
      const inbound = onIngest.mock.calls[0][0] as InboundMessage
      expect(inbound.payload).toBe('hello there')
      expect(inbound.sender).toBe('15550001111')
      expect(inbound.senderName).toBe('Alice')
      expect(inbound.sourceMeta).toMatchObject({
        chat_id: '15550001111@s.whatsapp.net',
        chat_type: 'dm',
        message_id: 'MSG-42',
        sender_jid: '15550001111@s.whatsapp.net'
      })
      expect(inbound.sourceMeta?.reply_to_message_id).toBeUndefined()
    })

    it('sets chat_type group and maps quoted stanzaId to reply_to_message_id', async () => {
      const onIngest = vi.fn()
      const adapter = new WhatsAppAdapter()
      const sock = await startConnected(adapter, makeCtx({ onIngest }))

      await emitUpsert(sock, [groupMessage({
        message: {
          extendedTextMessage: {
            text: 'quoted reply',
            contextInfo: { stanzaId: 'ORIG-9' }
          }
        }
      })])

      expect(onIngest).toHaveBeenCalledTimes(1)
      const inbound = onIngest.mock.calls[0][0] as InboundMessage
      expect(inbound.sourceMeta).toMatchObject({
        chat_id: '12036304@g.us',
        chat_type: 'group',
        sender_jid: '15550002222@s.whatsapp.net',
        reply_to_message_id: 'ORIG-9'
      })
    })
  })

  describe('group mention policy', () => {
    it('drops group messages without a self mention', async () => {
      const onIngest = vi.fn()
      const adapter = new WhatsAppAdapter()
      const ctx = makeCtx({ config: { enabled: true, policy: { groups: 'mention' } }, onIngest })
      const sock = await startConnected(adapter, ctx)

      await emitUpsert(sock, [groupMessage()])
      expect(onIngest).not.toHaveBeenCalled()
    })

    it('ingests group messages whose mentionedJid includes our jid', async () => {
      const onIngest = vi.fn()
      const adapter = new WhatsAppAdapter()
      const ctx = makeCtx({ config: { enabled: true, policy: { groups: 'mention' } }, onIngest })
      const sock = await startConnected(adapter, ctx)

      await emitUpsert(sock, [groupMessage({
        message: {
          extendedTextMessage: {
            text: '@bot ping',
            // Device-suffixed jid — must normalize to our self jid
            contextInfo: { mentionedJid: [SELF_RAW_ID] }
          }
        }
      })])

      expect(onIngest).toHaveBeenCalledTimes(1)
      expect((onIngest.mock.calls[0][0] as InboundMessage).payload).toBe('@bot ping')
    })

    it('ingests group messages that mention our LID identity', async () => {
      const onIngest = vi.fn()
      const adapter = new WhatsAppAdapter()
      const ctx = makeCtx({ config: { enabled: true, policy: { groups: 'mention' } }, onIngest })
      await adapter.start(ctx)
      const sock = globalThis.__waMocks.lastSock!
      sock.user = { id: SELF_RAW_ID, lid: '98765:4@lid' }
      sock.ev.handlers.get('connection.update')!({ connection: 'open' } as never)
      await flush()

      await emitUpsert(sock, [groupMessage({
        message: {
          extendedTextMessage: {
            text: '@bot ping',
            // LID-addressed group: mentions carry the @lid identity, never the phone jid
            contextInfo: { mentionedJid: ['98765@lid'] }
          }
        }
      })])

      expect(onIngest).toHaveBeenCalledTimes(1)
    })
  })

  describe('meta.group enrichment', () => {
    it('attaches group metadata and caches it across messages', async () => {
      const onIngest = vi.fn()
      const adapter = new WhatsAppAdapter()
      const sock = await startConnected(adapter, makeCtx({ onIngest }))

      await emitUpsert(sock, [groupMessage({ id: 'GMSG-1' })])
      expect(onIngest).toHaveBeenCalledTimes(1)
      const group = ((onIngest.mock.calls[0][0] as InboundMessage).meta as {
        group: Record<string, unknown>
      }).group
      expect(group.platform).toBe('whatsapp')
      expect(group.chat_id).toBe('12036304@g.us')
      expect(group.title).toBe('Test Group')
      expect(group.description).toBe('A test group')
      expect(group.participants).toEqual([
        { id: 'admin@s.whatsapp.net', role: 'admin' },
        { id: 'member@s.whatsapp.net', role: 'member' }
      ])
      expect(group.participant_count).toBe(2)
      expect(group.participants_truncated).toBe(false)
      expect(group.participants_scope).toBe('all')

      await emitUpsert(sock, [groupMessage({ id: 'GMSG-2' })])
      expect(onIngest).toHaveBeenCalledTimes(2)
      expect(((onIngest.mock.calls[1][0] as InboundMessage).meta as {
        group: Record<string, unknown>
      }).group).toEqual(group)
      expect(sock.groupMetadata).toHaveBeenCalledTimes(1)
    })

    it('does not attach meta.group for DMs', async () => {
      const onIngest = vi.fn()
      const adapter = new WhatsAppAdapter()
      const sock = await startConnected(adapter, makeCtx({ onIngest }))

      await emitUpsert(sock, [dmMessage()])
      expect((onIngest.mock.calls[0][0] as InboundMessage).meta).toBeUndefined()
      expect(sock.groupMetadata).not.toHaveBeenCalled()
    })
  })

  describe('send()', () => {
    it('returns an error when not connected', async () => {
      const adapter = new WhatsAppAdapter()
      const result = await adapter.send({
        id: 'm0', recipientId: '15559998888', payload: 'hi'
      } satisfies OutboundMessage)
      expect(result).toEqual({ success: false, error: 'WhatsApp not connected' })
    })

    it('normalizes bare numbers to @s.whatsapp.net and returns the sent id', async () => {
      const adapter = new WhatsAppAdapter()
      const sock = await startConnected(adapter, makeCtx())
      sock.sendMessage.mockResolvedValue({ key: { id: 'SENT-42' } })

      const result = await adapter.send({
        id: 'm1', recipientId: '+1 (555) 999-8888', payload: 'hey there'
      } satisfies OutboundMessage)

      expect(sock.sendMessage).toHaveBeenCalledTimes(1)
      const [jid, content, opts] = sock.sendMessage.mock.calls[0]
      expect(jid).toBe('15559998888@s.whatsapp.net')
      expect(content).toEqual({ text: 'hey there' })
      expect(opts).toBeUndefined()
      expect(result.success).toBe(true)
      expect(result.sourceMeta?.chat_id).toBe('15559998888@s.whatsapp.net')
      expect(result.sourceMeta?.message_id).toBe('SENT-42')
    })

    it('prefers sourceMeta.chat_id over the recipient id', async () => {
      const adapter = new WhatsAppAdapter()
      const sock = await startConnected(adapter, makeCtx())

      await adapter.send({
        id: 'm2',
        recipientId: '15559998888',
        payload: 'to the group',
        sourceMeta: { chat_id: '12036304@g.us' }
      } satisfies OutboundMessage)

      expect(sock.sendMessage.mock.calls[0][0]).toBe('12036304@g.us')
    })

    it('renders typed form content as a plain-text questionnaire', async () => {
      const adapter = new WhatsAppAdapter()
      const sock = await startConnected(adapter, makeCtx())

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
        id: 'm3',
        recipientId: '15559998888',
        payload: JSON.stringify(form),
        contentType: 'application/vnd.adf.form+json'
      } satisfies OutboundMessage)

      expect(result.success).toBe(true)
      const content = sock.sendMessage.mock.calls[0][1] as { text: string }
      expect(content.text).toContain('What is your favorite color?')
      expect(content.text).toContain('Red')
      expect(content.text).not.toContain('"questions"')
    })
  })

  describe('canDeliver()', () => {
    it('rejects everything when disconnected', () => {
      const adapter = new WhatsAppAdapter()
      expect(adapter.canDeliver('15551234567')).toBe(false)
    })

    it('accepts digits, user jids, and group jids when connected', async () => {
      const adapter = new WhatsAppAdapter()
      await startConnected(adapter, makeCtx())
      expect(adapter.canDeliver('15551234567')).toBe(true)
      expect(adapter.canDeliver('+15551234567')).toBe(true)
      expect(adapter.canDeliver('15550001111@s.whatsapp.net')).toBe(true)
      expect(adapter.canDeliver('12036304@g.us')).toBe(true)
      expect(adapter.canDeliver('not-a-number')).toBe(false)
      expect(adapter.canDeliver('123')).toBe(false)
    })
  })

  describe('getChatInfo()', () => {
    it('returns unsupported when disconnected', async () => {
      const adapter = new WhatsAppAdapter()
      const result = await adapter.getChatInfo('12036304@g.us')
      expect(result.supported).toBe(false)
      if (!result.supported) expect(result.reason).toMatch(/not connected/)
    })

    it('returns group metadata with participant roles', async () => {
      const adapter = new WhatsAppAdapter()
      await startConnected(adapter, makeCtx())

      const result = await adapter.getChatInfo('12036304@g.us')
      expect(result.supported).toBe(true)
      if (!result.supported) return
      expect(result.info.platform).toBe('whatsapp')
      expect(result.info.chat_type).toBe('group')
      expect(result.info.title).toBe('Test Group')
      expect(result.info.participants).toEqual([
        { id: 'admin@s.whatsapp.net', role: 'admin' },
        { id: 'member@s.whatsapp.net', role: 'member' }
      ])
      expect(result.info.participant_count).toBe(2)
      expect(result.info.participants_truncated).toBe(false)
      expect(result.info.participants_scope).toBe('all')
    })

    it('returns the two known participants for a DM', async () => {
      const adapter = new WhatsAppAdapter()
      await startConnected(adapter, makeCtx())

      const result = await adapter.getChatInfo('15550001111')
      expect(result.supported).toBe(true)
      if (!result.supported) return
      expect(result.info.chat_type).toBe('dm')
      expect(result.info.chat_id).toBe('15550001111@s.whatsapp.net')
      expect(result.info.participant_count).toBe(2)
      expect(result.info.participants).toEqual([
        { id: SELF_JID, role: 'self' },
        { id: '15550001111@s.whatsapp.net' }
      ])
    })
  })
})
