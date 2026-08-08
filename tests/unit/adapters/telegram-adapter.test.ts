import { beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  AdapterContext,
  AdapterInstanceConfig,
  InboundMessage,
  OutboundMessage
} from '../../../src/shared/types/channel-adapter.types'

// vi.mock factories are hoisted — keep all mutable mock state on globalThis to
// avoid temporal-dead-zone errors when the factory runs before module init.
type Handler = (ctx: unknown) => Promise<void> | void

interface MockBotShape {
  botInfo: { id: number; username: string }
  handlers: Record<string, Handler>
  api: Record<string, ReturnType<typeof vi.fn>>
}

declare global {
  // eslint-disable-next-line no-var
  var __grammyMocks: {
    api: Record<string, ReturnType<typeof vi.fn>>
    startOpts: Record<string, unknown> | null
    tokens: string[]
    lastBot: MockBotShape | null
  }
}

vi.mock('grammy', () => {
  class MockBot {
    public botInfo = { id: 0, username: '' }
    public handlers: Record<string, Handler> = {}
    public api: Record<string, ReturnType<typeof vi.fn>>

    constructor(token: string) {
      globalThis.__grammyMocks.tokens.push(token)
      this.api = globalThis.__grammyMocks.api
      globalThis.__grammyMocks.lastBot = this as unknown as MockBotShape
    }

    on(event: string, handler: Handler): void {
      this.handlers[event] = handler
    }

    async init(): Promise<void> {
      this.botInfo = { id: 999, username: 'testbot' }
    }

    start(opts?: { onStart?: (info: unknown) => void; allowed_updates?: string[] }): Promise<void> {
      globalThis.__grammyMocks.startOpts = (opts ?? null) as Record<string, unknown> | null
      opts?.onStart?.(this.botInfo)
      return Promise.resolve()
    }

    async stop(): Promise<void> {}
  }

  class InputFile {
    constructor(public data: unknown, public filename?: string) {}
  }

  return { Bot: MockBot, InputFile }
})

// Import AFTER vi.mock so the factory wins.
import { TelegramAdapter } from '../../../src/main/adapters/telegram/telegram-adapter'

function makeCtx(overrides: Partial<{
  credentials: Record<string, string | null>
  config: AdapterInstanceConfig
  onIngest: (m: InboundMessage) => void
}> = {}): AdapterContext {
  const credentials = overrides.credentials ?? { TELEGRAM_BOT_TOKEN: 'test-token' }
  const config = overrides.config ?? { enabled: true }
  return {
    ingest: overrides.onIngest ?? vi.fn(),
    writeAttachment: vi.fn(),
    getConfig: () => config,
    getCredential: (k: string) => credentials[k] ?? null,
    log: vi.fn()
  }
}

beforeEach(() => {
  let nextMessageId = 1
  globalThis.__grammyMocks = {
    api: {
      deleteWebhook: vi.fn().mockResolvedValue(true),
      sendMessage: vi.fn().mockImplementation(async () => ({ message_id: nextMessageId++ })),
      getChatMemberCount: vi.fn().mockResolvedValue(0),
      getChatAdministrators: vi.fn().mockResolvedValue([]),
      getChat: vi.fn(),
      editMessageText: vi.fn().mockResolvedValue(true),
      editMessageReplyMarkup: vi.fn().mockResolvedValue(true),
      getFile: vi.fn()
    },
    startOpts: null,
    tokens: [],
    lastBot: null
  }
})

async function startConnected(adapter: TelegramAdapter, ctx: AdapterContext): Promise<MockBotShape> {
  await adapter.start(ctx)
  return globalThis.__grammyMocks.lastBot!
}

function makeGrammyCtx(opts: {
  chat: Record<string, unknown>
  from: Record<string, unknown>
  message: Record<string, unknown>
}): unknown {
  return {
    chat: opts.chat,
    from: opts.from,
    message: opts.message,
    api: globalThis.__grammyMocks.api
  }
}

function makeCallbackCtx(opts: {
  data: string
  chatId: number
  messageId: number
  chatType?: string
  text?: string
}): { callbackQuery: unknown; answerCallbackQuery: ReturnType<typeof vi.fn> } {
  return {
    callbackQuery: {
      data: opts.data,
      from: { id: 7, first_name: 'Bob' },
      message: {
        chat: { id: opts.chatId, type: opts.chatType ?? 'private' },
        message_id: opts.messageId,
        text: opts.text ?? 'question?'
      }
    },
    answerCallbackQuery: vi.fn().mockResolvedValue(true)
  }
}

describe('TelegramAdapter', () => {
  describe('start()', () => {
    it('throws when TELEGRAM_BOT_TOKEN is missing', async () => {
      const adapter = new TelegramAdapter()
      const ctx = makeCtx({ credentials: {} })
      await expect(adapter.start(ctx)).rejects.toThrow(/TELEGRAM_BOT_TOKEN/)
      expect(adapter.status()).toBe('error')
    })

    it('starts polling with callback_query in allowed_updates', async () => {
      const adapter = new TelegramAdapter()
      await startConnected(adapter, makeCtx())
      expect(adapter.status()).toBe('connected')
      expect(globalThis.__grammyMocks.startOpts?.allowed_updates).toEqual(
        expect.arrayContaining(['message', 'callback_query'])
      )
    })
  })

  describe('group meta enrichment', () => {
    const groupChat = { id: -100123, type: 'supergroup', title: 'Team Chat' }
    const from = { id: 7, first_name: 'Bob', last_name: 'B', username: 'bob' }

    it('attaches meta.group with admins roster and member count', async () => {
      const onIngest = vi.fn()
      const adapter = new TelegramAdapter()
      const bot = await startConnected(adapter, makeCtx({ onIngest }))

      bot.api.getChatMemberCount.mockResolvedValue(42)
      bot.api.getChatAdministrators.mockResolvedValue([
        { user: { id: 1, first_name: 'Alice' }, status: 'creator' },
        { user: { id: 2, first_name: 'Carol', last_name: 'C' }, status: 'administrator' }
      ])

      await bot.handlers['message'](makeGrammyCtx({
        chat: groupChat,
        from,
        message: { message_id: 10, text: 'hello group', date: 1700000000 }
      }))

      expect(onIngest).toHaveBeenCalledTimes(1)
      const inbound: InboundMessage = onIngest.mock.calls[0][0]
      const group = (inbound.meta as { group: Record<string, unknown> }).group
      expect(group.title).toBe('Team Chat')
      expect(group.participants_scope).toBe('admins')
      expect(group.participant_count).toBe(42)
      expect(group.participants).toEqual([
        { id: '1', name: 'Alice', role: 'creator' },
        { id: '2', name: 'Carol C', role: 'administrator' }
      ])
      expect(group.participants_truncated).toBe(true) // 2 admins < 42 members
    })

    it('still ingests with title-only group meta when the roster APIs fail', async () => {
      const onIngest = vi.fn()
      const adapter = new TelegramAdapter()
      const bot = await startConnected(adapter, makeCtx({ onIngest }))

      bot.api.getChatMemberCount.mockRejectedValue(new Error('403'))
      bot.api.getChatAdministrators.mockRejectedValue(new Error('403'))

      await bot.handlers['message'](makeGrammyCtx({
        chat: groupChat,
        from,
        message: { message_id: 11, text: 'still here', date: 1700000000 }
      }))

      expect(onIngest).toHaveBeenCalledTimes(1)
      const inbound: InboundMessage = onIngest.mock.calls[0][0]
      const group = (inbound.meta as { group: Record<string, unknown> }).group
      expect(group.title).toBe('Team Chat')
      expect(group.participants).toEqual([])
    })

    it('caches group meta — second message does not refetch admins', async () => {
      const onIngest = vi.fn()
      const adapter = new TelegramAdapter()
      const bot = await startConnected(adapter, makeCtx({ onIngest }))

      bot.api.getChatMemberCount.mockResolvedValue(5)
      bot.api.getChatAdministrators.mockResolvedValue([
        { user: { id: 1, first_name: 'Alice' }, status: 'creator' }
      ])

      const msg = (id: number) => makeGrammyCtx({
        chat: groupChat,
        from,
        message: { message_id: id, text: `msg ${id}`, date: 1700000000 }
      })
      await bot.handlers['message'](msg(20))
      await bot.handlers['message'](msg(21))

      expect(onIngest).toHaveBeenCalledTimes(2)
      expect(bot.api.getChatAdministrators).toHaveBeenCalledTimes(1)
    })
  })

  describe('private message ingest', () => {
    it('has no meta.group and captures originalMessage as JSON', async () => {
      const onIngest = vi.fn()
      const adapter = new TelegramAdapter()
      const bot = await startConnected(adapter, makeCtx({ onIngest }))

      const message = { message_id: 1, text: 'hi there', date: 1700000000 }
      await bot.handlers['message'](makeGrammyCtx({
        chat: { id: 42, type: 'private' },
        from: { id: 7, first_name: 'Bob' },
        message
      }))

      expect(onIngest).toHaveBeenCalledTimes(1)
      const inbound: InboundMessage = onIngest.mock.calls[0][0]
      expect(inbound.payload).toBe('hi there')
      expect(inbound.meta).toBeUndefined()
      expect(inbound.originalMessage).toBe(JSON.stringify(message))
      expect(bot.api.getChatAdministrators).not.toHaveBeenCalled()
    })
  })

  describe('form sends', () => {
    const form = {
      id: 'poll',
      questions: [
        {
          id: 'q1',
          text: 'Pick a color',
          type: 'choice',
          options: [
            { id: 'r', label: 'Red' },
            { id: 'b', label: 'Blue' }
          ]
        },
        { id: 'q2', text: 'Anything else?', type: 'text' }
      ]
    }

    it('renders one message per question with inline keyboards and returns all message_ids', async () => {
      const adapter = new TelegramAdapter()
      const bot = await startConnected(adapter, makeCtx())

      const result = await adapter.send({
        id: 'm1',
        recipientId: '555',
        payload: JSON.stringify(form),
        contentType: 'application/vnd.adf.form+json'
      } as OutboundMessage)

      expect(result.success).toBe(true)
      expect(bot.api.sendMessage).toHaveBeenCalledTimes(2)

      // Choice question: inline keyboard with encoded callback_data ≤ 64 bytes
      const [, q1Text, q1Opts] = bot.api.sendMessage.mock.calls[0]
      expect(q1Text).toBe('Pick a color')
      const keyboard = q1Opts.reply_markup.inline_keyboard as { text: string; callback_data: string }[][]
      expect(keyboard).toHaveLength(2)
      expect(keyboard[0][0]).toEqual({ text: 'Red', callback_data: 'f|poll|q1|r' })
      expect(keyboard[1][0]).toEqual({ text: 'Blue', callback_data: 'f|poll|q1|b' })
      for (const row of keyboard) {
        expect(Buffer.byteLength(row[0].callback_data, 'utf-8')).toBeLessThanOrEqual(64)
      }

      // Text question: plain message, no keyboard
      const [, q2Text, q2Opts] = bot.api.sendMessage.mock.calls[1]
      expect(q2Text).toContain('Anything else?')
      expect(q2Text).toContain('reply to this message')
      expect(q2Opts?.reply_markup).toBeUndefined()

      // All sent message ids come back for parent_id resolution
      const meta = result.sourceMeta as { message_ids: number[]; form_id: string }
      expect(meta.message_ids).toHaveLength(2)
      expect(meta.form_id).toBe('poll')
    })

    it('falls back to a plain text send when the form hint is invalid', async () => {
      const adapter = new TelegramAdapter()
      const bot = await startConnected(adapter, makeCtx())

      const result = await adapter.send({
        id: 'm2',
        recipientId: '555',
        payload: JSON.stringify({ id: 'BAD ID WITH SPACES', questions: [] }),
        contentType: 'application/vnd.adf.form+json'
      } as OutboundMessage)

      expect(result.success).toBe(true)
      expect(bot.api.sendMessage).toHaveBeenCalledTimes(1)
      const [, text, opts] = bot.api.sendMessage.mock.calls[0]
      // Degrades to sending the raw payload as text — no keyboard, no form ids
      expect(text).toContain('BAD ID WITH SPACES')
      expect(opts?.reply_markup).toBeUndefined()
      expect((result.sourceMeta as Record<string, unknown>).message_ids).toBeUndefined()
    })

    it('answers callbacks, edits the question message, and ingests the answer', async () => {
      const onIngest = vi.fn()
      const adapter = new TelegramAdapter()
      const bot = await startConnected(adapter, makeCtx({ onIngest }))

      const result = await adapter.send({
        id: 'm3',
        recipientId: '555',
        payload: JSON.stringify(form),
        contentType: 'application/vnd.adf.form+json'
      } as OutboundMessage)
      const [q1MessageId] = (result.sourceMeta as { message_ids: number[] }).message_ids

      const cbCtx = makeCallbackCtx({
        data: 'f|poll|q1|b',
        chatId: 555,
        messageId: q1MessageId,
        text: 'Pick a color'
      })
      await bot.handlers['callback_query:data'](cbCtx)

      expect(cbCtx.answerCallbackQuery).toHaveBeenCalledTimes(1)
      expect(bot.api.editMessageText).toHaveBeenCalledTimes(1)
      const [editChatId, editMessageId, editedText] = bot.api.editMessageText.mock.calls[0]
      expect(editChatId).toBe(555)
      expect(editMessageId).toBe(q1MessageId)
      expect(editedText).toContain('Blue')

      expect(onIngest).toHaveBeenCalledTimes(1)
      const inbound: InboundMessage = onIngest.mock.calls[0][0]
      expect(inbound.payload).toBe('Blue')
      expect(inbound.sourceMeta).toMatchObject({
        form_id: 'poll',
        question_id: 'q1',
        answer_id: 'b',
        answer_value: 'Blue',
        reply_to_message_id: q1MessageId
      })
    })

    it('multi questions toggle via markup edits and only ingest on Done', async () => {
      const onIngest = vi.fn()
      const adapter = new TelegramAdapter()
      const bot = await startConnected(adapter, makeCtx({ onIngest }))

      const multiForm = {
        id: 'multi',
        questions: [
          {
            id: 'q1',
            text: 'Pick toppings',
            type: 'multi',
            options: [
              { id: 'ch', label: 'Cheese' },
              { id: 'ol', label: 'Olives' }
            ]
          }
        ]
      }
      const result = await adapter.send({
        id: 'm4',
        recipientId: '555',
        payload: JSON.stringify(multiForm),
        contentType: 'application/vnd.adf.form+json'
      } as OutboundMessage)
      const [qMessageId] = (result.sourceMeta as { message_ids: number[] }).message_ids

      // Toggle both options — keyboard is re-rendered, nothing ingested yet
      await bot.handlers['callback_query:data'](makeCallbackCtx({
        data: 'f|multi|q1|ch', chatId: 555, messageId: qMessageId
      }))
      await bot.handlers['callback_query:data'](makeCallbackCtx({
        data: 'f|multi|q1|ol', chatId: 555, messageId: qMessageId
      }))
      expect(bot.api.editMessageReplyMarkup).toHaveBeenCalledTimes(2)
      expect(onIngest).not.toHaveBeenCalled()

      // Done finalizes with the combined labels
      await bot.handlers['callback_query:data'](makeCallbackCtx({
        data: 'f|multi|q1|__done', chatId: 555, messageId: qMessageId
      }))
      expect(onIngest).toHaveBeenCalledTimes(1)
      const inbound: InboundMessage = onIngest.mock.calls[0][0]
      expect(inbound.payload).toBe('Cheese, Olives')
      expect(inbound.sourceMeta).toMatchObject({
        form_id: 'multi',
        question_id: 'q1',
        answer_value: 'Cheese, Olives'
      })
      expect(inbound.sourceMeta?.answer_id).toEqual(['ch', 'ol'])
    })
  })

  describe('getChatInfo()', () => {
    it('returns supported chat info with admins scope when connected', async () => {
      const adapter = new TelegramAdapter()
      const bot = await startConnected(adapter, makeCtx())

      bot.api.getChat.mockResolvedValue({
        id: -100123, type: 'supergroup', title: 'Team Chat', description: 'The team'
      })
      bot.api.getChatMemberCount.mockResolvedValue(10)
      bot.api.getChatAdministrators.mockResolvedValue([
        { user: { id: 1, first_name: 'Alice' }, status: 'creator' }
      ])

      const result = await adapter.getChatInfo('-100123')
      expect(result.supported).toBe(true)
      if (!result.supported) throw new Error('unreachable')
      expect(result.info).toMatchObject({
        platform: 'telegram',
        chat_id: '-100123',
        chat_type: 'supergroup',
        title: 'Team Chat',
        description: 'The team',
        participant_count: 10,
        participants: [{ id: '1', name: 'Alice', role: 'creator' }],
        participants_truncated: true,
        participants_scope: 'admins'
      })
      // Numeric-looking chat ids are passed to the API as numbers
      expect(bot.api.getChat).toHaveBeenCalledWith(-100123)
    })

    it('is unsupported when the bot is not connected', async () => {
      const adapter = new TelegramAdapter()
      const result = await adapter.getChatInfo('123')
      expect(result).toEqual({ supported: false, reason: 'Telegram bot not connected' })
    })
  })

  describe('text/html content', () => {
    it('sanitizes HTML to the Telegram tag subset and sends with parse_mode HTML', async () => {
      const adapter = new TelegramAdapter()
      const bot = await startConnected(adapter, makeCtx())

      const result = await adapter.send({
        id: 'h1',
        recipientId: '555',
        payload: '<h1>Title</h1><p>Hello <b class="x">world</b></p><span>plain</span>',
        contentType: 'text/html'
      } as OutboundMessage)

      expect(result.success).toBe(true)
      const [, text, opts] = bot.api.sendMessage.mock.calls[0]
      expect(opts.parse_mode).toBe('HTML')
      expect(text).toContain('<b>Title</b>')
      expect(text).toContain('Hello <b>world</b>')
      expect(text).not.toContain('<span>')
      expect(text).not.toContain('<p>')
      expect(text).not.toContain('class=')
    })

    it('falls back to converted plain text when Telegram rejects the HTML', async () => {
      const adapter = new TelegramAdapter()
      const bot = await startConnected(adapter, makeCtx())
      bot.api.sendMessage
        .mockRejectedValueOnce(new Error('400: cannot parse entities'))
        .mockImplementationOnce(async () => ({ message_id: 42 }))

      const result = await adapter.send({
        id: 'h2',
        recipientId: '555',
        payload: '<p>Hello <b>world</b></p>',
        contentType: 'text/html'
      } as OutboundMessage)

      expect(result.success).toBe(true)
      const [, fallbackText, fallbackOpts] = bot.api.sendMessage.mock.calls[1]
      expect(fallbackOpts?.parse_mode).toBeUndefined()
      expect(fallbackText).toContain('Hello world')
      expect(fallbackText).not.toContain('<')
    })
  })
})
