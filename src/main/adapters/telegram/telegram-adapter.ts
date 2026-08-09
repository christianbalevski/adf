import { Bot, InputFile } from 'grammy'
import type { CallbackQueryContext, Context } from 'grammy'
import { convertToOggOpus } from '../shared/audio-convert'
import { buildGroupMeta, GroupMetaCache } from '../group-meta'
import type { GroupMeta } from '../group-meta'
import { decodeFormAction, encodeFormAction, FORM_MULTI_DONE, FORM_ANSWERED, FORM_CONTENT_TYPE } from '../../../shared/types/form-hints.types'
import type { FormHint } from '../../../shared/types/form-hints.types'
import { parseFormJson, TypedContentError } from '../form-render'
import { HTML_CONTENT_TYPE, sanitizeTelegramHtml, htmlToPlainText } from '../shared/html-content'
import { withSetupGuide } from '../shared/error-hints'
import type {
  ChannelAdapter,
  AdapterContext,
  AdapterStatus,
  OutboundMessage,
  DeliveryResult,
  InboundMessage,
  ChatInfoResult
} from '../../../shared/types/channel-adapter.types'

/**
 * Telegram adapter using grammy.
 *
 * Receives messages via long-polling and delivers outbound messages
 * via the Bot API. Policy filtering (DM, groups, allowlist) is applied
 * before ingesting inbound messages.
 */
interface PendingFormQuestion {
  questionId: string
  questionText: string
  type: 'choice' | 'multi'
  options: { id: string; label: string }[]
  /** Multi-select toggles keyed by tapper user id — group chats share one
   * keyboard, but each user's selections are tracked and finalized
   * separately so one user's Done never absorbs another user's toggles. */
  selectedByUser: Map<string, Set<string>>
  /** Set once answered (compact mode keeps the message alive until every
   * question is answered, so answered questions must be remembered). */
  answeredLabel?: string
}

/** All live form state for one Telegram message (one question per message in
 * per_question mode; every question in compact mode). */
interface PendingFormMessage {
  formId: string
  title?: string
  compact: boolean
  questions: PendingFormQuestion[]
}

interface PendingPoll {
  formId: string
  questionId: string
  options: { id: string; label: string }[]
  chatId: number | string
  messageId: number
}

/**
 * Map a Telegram Bot API failure to an actionable message. grammY's
 * GrammyError carries the Bot API error payload: `error_code`, `description`
 * and `parameters.retry_after`. These strings flow verbatim into the agent's
 * tool result — the agent reads them to walk the user through a fix, so each
 * mapped message states what happened, the likely cause, and the concrete
 * fix steps. Callers append the setup-guide link via withSetupGuide.
 */
function describeTelegramError(err: unknown): string {
  const api = err as {
    error_code?: number
    description?: string
    parameters?: { retry_after?: number }
  }
  const code = typeof api?.error_code === 'number' ? api.error_code : undefined
  const rawDesc = typeof api?.description === 'string' && api.description
    ? api.description
    : String(err instanceof Error ? err.message : err)
  const desc = rawDesc.toLowerCase()

  if (code === 401 || desc.includes('unauthorized')) {
    return 'Telegram rejected the request (401 Unauthorized): the TELEGRAM_BOT_TOKEN is invalid or was revoked. Get the current token from @BotFather in Telegram (/mybots > API Token), update it in Settings > Channel Adapters > Telegram, then restart the adapter'
  }
  if (code === 403 || desc.includes('forbidden')) {
    if (desc.includes('blocked by the user')) {
      return 'Telegram rejected the request (403 Forbidden): the recipient has blocked this bot. Ask them to unblock the bot in Telegram and send it a message, then resend'
    }
    if (desc.includes('kicked')) {
      return 'Telegram rejected the request (403 Forbidden): the bot was kicked from this chat. Ask a chat admin to re-add the bot, then resend'
    }
    if (desc.includes("bots can't send messages to bots")) {
      return 'Telegram rejected the request (403 Forbidden): bots cannot message other bots. The recipient id belongs to another bot — use the chat id of a human user or a group instead'
    }
    if (desc.includes("can't initiate conversation")) {
      return 'Telegram rejected the request (403 Forbidden): bots cannot start a conversation with a user — the user must message the bot first. Ask them to open the bot in Telegram and press Start (or send any message), then resend'
    }
    return `Telegram rejected the request (403 Forbidden): ${rawDesc}. The bot lacks access to this chat — verify it is still a member and allowed to post there`
  }
  if (code === 409 || desc.includes('terminated by other getupdates')) {
    return 'Telegram reported a polling conflict (409): another process is polling with the same bot token. Stop the other bot instance (or create a separate bot with @BotFather for this adapter), then restart the adapter'
  }
  if (code === 413 || desc.includes('request entity too large') || desc.includes('file is too big')) {
    return 'Telegram rejected the upload: the file exceeds the Bot API upload limit for bots (50 MB). Compress or split the file, or send a download link instead'
  }
  if (desc.includes('chat not found')) {
    return 'Telegram rejected the request (400 Bad Request): chat not found. The chat id is wrong or the bot has never seen this chat — double-check the recipient chat id; a user must message the bot at least once before it can reply, and for groups the bot must be added as a member'
  }
  if (desc.includes('message is too long') || desc.includes('caption is too long')) {
    return 'Telegram rejected the message (400 Bad Request): the text is too long — Telegram caps messages at 4096 characters (captions at 1024). Split the text into shorter messages and resend'
  }
  if (code === 429 || desc.includes('too many requests')) {
    const fromDesc = desc.match(/retry after (\d+)/)
    const retryAfter = api?.parameters?.retry_after ?? (fromDesc ? Number(fromDesc[1]) : undefined)
    return `Telegram is rate-limiting this bot (429 Too Many Requests)${retryAfter != null ? `: retry after ${retryAfter}s` : ''}. Wait${retryAfter != null ? ` at least ${retryAfter} seconds` : ' a moment'} before resending and reduce the send rate to this chat`
  }
  return rawDesc
}

export class TelegramAdapter implements ChannelAdapter {
  private bot: Bot | null = null
  private ctx: AdapterContext | null = null
  private currentStatus: AdapterStatus = 'disconnected'
  private pollingAbortController: AbortController | null = null
  private groupMetaCache = new GroupMetaCache()
  /** Live form messages keyed by `${chatId}:${messageId}` — in-memory only;
   * after a restart, callbacks still decode via callback_data and parent_id
   * resolves through the persisted outbox meta (message_ids). */
  private formMessages = new Map<string, PendingFormMessage>()
  /** Live native polls keyed by Telegram poll id (poll_answer updates carry
   * the poll id, not the message id). */
  private pendingPolls = new Map<string, PendingPoll>()

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx
    this.currentStatus = 'connecting'

    const token = ctx.getCredential('TELEGRAM_BOT_TOKEN')
    if (!token) {
      this.currentStatus = 'error'
      throw new Error(withSetupGuide('telegram', 'Missing TELEGRAM_BOT_TOKEN credential. Create a bot with @BotFather in Telegram (/newbot), copy its API token, and add it in Settings > Channel Adapters > Telegram.'))
    }

    this.bot = new Bot(token)

    // Register message handler
    this.bot.on('message', async (grammyCtx) => {
      if (!this.ctx) return

      const config = this.ctx.getConfig()
      const policy = config.policy ?? {}
      const chat = grammyCtx.chat
      const from = grammyCtx.from

      if (!from) return

      // Policy filtering
      const isPrivate = chat.type === 'private'
      const isGroup = chat.type === 'group' || chat.type === 'supergroup'

      if (isPrivate) {
        const dmPolicy = policy.dm ?? 'all'
        if (dmPolicy === 'none') return
        if (dmPolicy === 'allowlist') {
          const allowFrom = policy.allow_from ?? []
          if (!allowFrom.includes(String(from.id))) return
        }
      }

      if (isGroup) {
        const groupPolicy = policy.groups ?? 'all'
        if (groupPolicy === 'none') return
        if (groupPolicy === 'mention') {
          // Only process if bot is mentioned or replied to
          const botInfo = this.bot!.botInfo
          const text = grammyCtx.message?.text ?? ''
          const replyTo = grammyCtx.message?.reply_to_message
          const isMentioned = text.includes(`@${botInfo.username}`)
          const isReply = replyTo?.from?.id === botInfo.id
          if (!isMentioned && !isReply) return
        }
      }

      const senderName = [from.first_name, from.last_name].filter(Boolean).join(' ') || String(from.id)
      let text = grammyCtx.message?.text ?? grammyCtx.message?.caption ?? ''

      if (!text && !grammyCtx.message?.photo && !grammyCtx.message?.document && !grammyCtx.message?.voice && !grammyCtx.message?.video && !grammyCtx.message?.video_note && !grammyCtx.message?.audio && !grammyCtx.message?.animation) return

      // Handle attachments
      const attachments: InboundMessage['attachments'] = []
      const limits = config.limits ?? {}
      const maxAttachmentSize = limits.max_attachment_size ?? 10_000_000 // 10MB default

      // Photos
      if (grammyCtx.message?.photo) {
        const photo = grammyCtx.message.photo[grammyCtx.message.photo.length - 1]
        if (photo.file_size && photo.file_size <= maxAttachmentSize) {
          try {
            const file = await grammyCtx.api.getFile(photo.file_id)
            if (file.file_path) {
              const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`
              const response = await fetch(url)
              const buffer = Buffer.from(await response.arrayBuffer())
              const filename = `photo_${photo.file_id}.jpg`
              const importPath = `imported/telegram/${filename}`
              this.ctx.writeAttachment(importPath, buffer, 'image/jpeg')
              attachments.push({
                path: importPath, filename, mimeType: 'image/jpeg',
                size: buffer.length
              })
            }
          } catch (err) {
            this.logInboundDownloadFailure('photo', err)
          }
        }
      }

      // Documents
      if (grammyCtx.message?.document) {
        const doc = grammyCtx.message.document
        if (doc.file_size && doc.file_size <= maxAttachmentSize) {
          try {
            const file = await grammyCtx.api.getFile(doc.file_id)
            if (file.file_path) {
              const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`
              const response = await fetch(url)
              const buffer = Buffer.from(await response.arrayBuffer())
              const filename = doc.file_name ?? `doc_${doc.file_id}`
              const importPath = `imported/telegram/${filename}`
              this.ctx.writeAttachment(importPath, buffer, doc.mime_type)
              attachments.push({
                path: importPath, filename, mimeType: doc.mime_type ?? 'application/octet-stream',
                size: buffer.length
              })
            }
          } catch (err) {
            this.logInboundDownloadFailure('document', err)
          }
        }
      }

      // Voice messages
      if (grammyCtx.message?.voice) {
        const voice = grammyCtx.message.voice
        if (!voice.file_size || voice.file_size <= maxAttachmentSize) {
          try {
            const file = await grammyCtx.api.getFile(voice.file_id)
            if (file.file_path) {
              const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`
              const response = await fetch(url)
              const buffer = Buffer.from(await response.arrayBuffer())
              const filename = `voice_${voice.file_id}.ogg`
              const importPath = `imported/telegram/${filename}`
              this.ctx.writeAttachment(importPath, buffer, voice.mime_type ?? 'audio/ogg')
              attachments.push({
                path: importPath, filename, mimeType: voice.mime_type ?? 'audio/ogg',
                size: buffer.length
              })
            }
          } catch (err) {
            this.logInboundDownloadFailure('voice message', err)
          }
        }
        // Use placeholder text for voice-only messages
        if (!text) text = '[Voice message]'
      }

      // Video
      if (grammyCtx.message?.video) {
        const video = grammyCtx.message.video
        if (!video.file_size || video.file_size <= maxAttachmentSize) {
          try {
            const file = await grammyCtx.api.getFile(video.file_id)
            if (file.file_path) {
              const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`
              const response = await fetch(url)
              const buffer = Buffer.from(await response.arrayBuffer())
              const ext = video.mime_type?.split('/')[1] ?? 'mp4'
              const filename = video.file_name ?? `video_${video.file_id}.${ext}`
              const importPath = `imported/telegram/${filename}`
              this.ctx.writeAttachment(importPath, buffer, video.mime_type ?? 'video/mp4')
              attachments.push({
                path: importPath, filename, mimeType: video.mime_type ?? 'video/mp4',
                size: buffer.length
              })
            }
          } catch (err) {
            this.logInboundDownloadFailure('video', err)
          }
        }
        if (!text) text = '[Video]'
      }

      // Video notes (round/circular videos)
      if (grammyCtx.message?.video_note) {
        const vn = grammyCtx.message.video_note
        if (!vn.file_size || vn.file_size <= maxAttachmentSize) {
          try {
            const file = await grammyCtx.api.getFile(vn.file_id)
            if (file.file_path) {
              const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`
              const response = await fetch(url)
              const buffer = Buffer.from(await response.arrayBuffer())
              const filename = `videonote_${vn.file_id}.mp4`
              const importPath = `imported/telegram/${filename}`
              this.ctx.writeAttachment(importPath, buffer, 'video/mp4')
              attachments.push({
                path: importPath, filename, mimeType: 'video/mp4',
                size: buffer.length
              })
            }
          } catch (err) {
            this.logInboundDownloadFailure('video note', err)
          }
        }
        if (!text) text = '[Video note]'
      }

      // Audio files (distinct from voice messages)
      if (grammyCtx.message?.audio) {
        const audio = grammyCtx.message.audio
        if (!audio.file_size || audio.file_size <= maxAttachmentSize) {
          try {
            const file = await grammyCtx.api.getFile(audio.file_id)
            if (file.file_path) {
              const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`
              const response = await fetch(url)
              const buffer = Buffer.from(await response.arrayBuffer())
              const filename = audio.file_name ?? `audio_${audio.file_id}.${audio.mime_type?.split('/')[1] ?? 'mp3'}`
              const importPath = `imported/telegram/${filename}`
              this.ctx.writeAttachment(importPath, buffer, audio.mime_type ?? 'audio/mpeg')
              attachments.push({
                path: importPath, filename, mimeType: audio.mime_type ?? 'audio/mpeg',
                size: buffer.length
              })
            }
          } catch (err) {
            this.logInboundDownloadFailure('audio file', err)
          }
        }
        if (!text) text = '[Audio]'
      }

      // Animations (GIFs sent as MPEG4)
      if (grammyCtx.message?.animation) {
        const anim = grammyCtx.message.animation
        if (!anim.file_size || anim.file_size <= maxAttachmentSize) {
          try {
            const file = await grammyCtx.api.getFile(anim.file_id)
            if (file.file_path) {
              const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`
              const response = await fetch(url)
              const buffer = Buffer.from(await response.arrayBuffer())
              const filename = anim.file_name ?? `animation_${anim.file_id}.mp4`
              const importPath = `imported/telegram/${filename}`
              this.ctx.writeAttachment(importPath, buffer, anim.mime_type ?? 'video/mp4')
              attachments.push({
                path: importPath, filename, mimeType: anim.mime_type ?? 'video/mp4',
                size: buffer.length
              })
            }
          } catch (err) {
            this.logInboundDownloadFailure('animation', err)
          }
        }
        if (!text) text = '[Animation]'
      }

      const sourceMeta: Record<string, unknown> = {
        chat_id: chat.id,
        message_id: grammyCtx.message?.message_id,
        chat_type: chat.type,
        username: from.username
      }

      // Capture reply_to_message for parent_id resolution
      const replyToMsg = grammyCtx.message?.reply_to_message
      if (replyToMsg?.message_id) {
        sourceMeta.reply_to_message_id = replyToMsg.message_id
      }

      // Group context (meta.group) — cached, never blocks ingest. The Bot API
      // cannot enumerate members, so the roster is admins + total count.
      let meta: Record<string, unknown> | undefined
      if (isGroup) {
        const title = 'title' in chat ? chat.title : undefined
        const group = await this.groupMetaCache.getOrFetch(String(chat.id), () =>
          this.fetchGroupMeta(chat.id, chat.type, title)
        )
        if (group) meta = { group }
      }

      const inbound: InboundMessage = {
        sender: String(from.id),
        senderName,
        payload: text,
        attachments: attachments.length > 0 ? attachments : undefined,
        sourceMeta,
        meta,
        originalMessage: grammyCtx.message ? JSON.stringify(grammyCtx.message) : undefined,
        sentAt: grammyCtx.message?.date ? grammyCtx.message.date * 1000 : undefined
      }

      this.ctx.log('info', `Inbound from ${senderName} (${from.id}) in ${chat.type} chat ${chat.id}`)
      this.ctx.ingest(inbound)
    })

    // Inline-keyboard answers for application/vnd.adf.form+json form questions
    this.bot.on('callback_query:data', async (cbCtx) => {
      try {
        await this.handleFormCallback(cbCtx)
      } catch (err) {
        this.ctx?.log('warn', `callback_query handler failed: ${err instanceof Error ? err.message : err}`)
      }
    })

    // Native-poll form answers (render: 'poll')
    this.bot.on('poll_answer', async (paCtx) => {
      try {
        await this.handlePollAnswer(paCtx.pollAnswer)
      } catch (err) {
        this.ctx?.log('warn', `poll_answer handler failed: ${err instanceof Error ? err.message : err}`)
      }
    })

    // Start long-polling
    const bot = this.bot
    try {
      // Abort signal covers the init phase too — a stop() during a hung
      // start() cancels the in-flight API calls instead of leaking them.
      this.pollingAbortController = new AbortController()
      // grammY's typings reference the abort-controller polyfill's AbortSignal;
      // the native signal is runtime-compatible.
      const signal = this.pollingAbortController.signal as unknown as Parameters<Bot['init']>[0]

      // init (validates token, fetches bot username) and webhook cleanup are
      // independent Bot API calls in grammY — run them in parallel to halve
      // start latency. deleteWebhook drops pending updates to avoid 409
      // conflicts with stale polling sessions; its failure is non-fatal.
      await Promise.all([
        bot.init(signal),
        bot.api.deleteWebhook({ drop_pending_updates: true }, signal).catch(() => {
          // Non-fatal — continue even if this fails
        })
      ])

      // stop() may have run while init was in flight — don't start polling
      if (this.bot !== bot || this.wasStopped()) return

      // Start polling in background (non-blocking).
      // Catch the returned promise to prevent unhandled rejections from
      // the long-running polling loop (e.g. 409 Conflict errors).
      bot.start({
        onStart: () => {
          if (this.bot !== bot) return // stale — adapter was stopped/restarted
          this.currentStatus = 'connected'
          this.ctx?.log('info', `Bot started: @${bot.botInfo.username}`)
        },
        allowed_updates: ['message', 'callback_query', 'poll_answer'],
        drop_pending_updates: true
      }).catch((err) => {
        // Polling loop terminated — only log if this bot is still current
        // and we're still supposed to be running
        if (this.bot === bot && this.currentStatus !== 'disconnected') {
          this.ctx?.log('error', withSetupGuide('telegram', `Telegram polling stopped: ${describeTelegramError(err)}.`))
          this.currentStatus = 'error'
        }
      })

      this.currentStatus = 'connected'
      ctx.log('info', `Telegram bot initialized: @${bot.botInfo.username}`)
    } catch (error) {
      // If stop() aborted us mid-start, stay 'disconnected' and rethrow as-is
      if (this.wasStopped()) throw error
      this.currentStatus = 'error'
      const described = withSetupGuide('telegram', `Telegram bot failed to start: ${describeTelegramError(error)}.`)
      ctx.log('error', described)
      throw new Error(described)
    }
  }

  /** Inbound attachment downloads are best-effort: a failure never drops the
   * message itself — it is ingested without the attachment, and this warn log
   * tells the agent/user how to fix the download for next time. */
  private logInboundDownloadFailure(kind: string, err: unknown): void {
    this.ctx?.log('warn', withSetupGuide('telegram',
      `Failed to download inbound ${kind}: ${describeTelegramError(err)}. The message was still ingested without this attachment. If this keeps happening, verify the TELEGRAM_BOT_TOKEN is valid and note the Bot API only serves files up to 20 MB for download.`))
  }

  /** True when stop() ran (possibly while start() was awaiting network I/O). */
  private wasStopped(): boolean {
    return this.currentStatus === 'disconnected'
  }

  async stop(): Promise<void> {
    this.currentStatus = 'disconnected'
    if (this.pollingAbortController) {
      this.pollingAbortController.abort()
      this.pollingAbortController = null
    }
    if (this.bot) {
      try {
        await this.bot.stop()
      } catch { /* ignore */ }
      this.bot = null
    }
    this.ctx = null
    this.groupMetaCache.clear()
    this.formMessages.clear()
    this.pendingPolls.clear()
  }

  /** Best-effort member count + admin roster (the Bot API can only enumerate
   * admins). Shared by fetchGroupMeta and getChatInfo. */
  private async fetchChatRoster(
    chatId: number | string,
    limit?: number
  ): Promise<{ participantCount?: number; admins: GroupMeta['participants'] }> {
    let participantCount: number | undefined
    let admins: GroupMeta['participants'] = []
    if (!this.bot) return { admins }
    try {
      participantCount = await this.bot.api.getChatMemberCount(chatId)
    } catch { /* count is best-effort */ }
    try {
      const members = await this.bot.api.getChatAdministrators(chatId)
      admins = (limit != null ? members.slice(0, limit) : members).map((m) => ({
        id: String(m.user.id),
        name: [m.user.first_name, m.user.last_name].filter(Boolean).join(' ') || m.user.username || String(m.user.id),
        role: m.status
      }))
    } catch { /* roster is best-effort — bot may lack rights */ }
    return { participantCount, admins }
  }

  private async fetchGroupMeta(chatId: number, chatType: string, title?: string): Promise<GroupMeta | null> {
    if (!this.bot) return null
    const { participantCount, admins } = await this.fetchChatRoster(chatId)

    return buildGroupMeta({
      platform: 'telegram',
      chatId: String(chatId),
      chatType,
      title,
      participants: admins,
      participantCount,
      participantsScope: 'admins'
    })
  }

  async getChatInfo(chatId: string, opts?: { limit?: number }): Promise<ChatInfoResult> {
    if (!this.bot || this.currentStatus !== 'connected') {
      return { supported: false, reason: 'Telegram bot not connected' }
    }
    const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 100)
    try {
      const numericId = /^-?\d+$/.test(chatId) ? Number(chatId) : chatId
      const chat = await this.bot.api.getChat(numericId)
      const isGroup = chat.type === 'group' || chat.type === 'supergroup'

      let participantCount: number | undefined
      let admins: GroupMeta['participants'] = []
      if (isGroup || chat.type === 'channel') {
        ({ participantCount, admins } = await this.fetchChatRoster(numericId, limit))
      }

      const title = 'title' in chat ? chat.title : undefined
      const description = 'description' in chat ? (chat as { description?: string }).description : undefined
      return {
        supported: true,
        info: {
          platform: 'telegram',
          chat_id: String(chat.id),
          chat_type: chat.type,
          title,
          description,
          participant_count: participantCount,
          participants: admins,
          // The Bot API can only enumerate admins — the roster never covers a
          // full group, so it's truncated whenever the group is bigger.
          participants_truncated: participantCount != null && admins.length < participantCount,
          participants_scope: 'admins',
          fetched_at: Date.now()
        }
      }
    } catch (error) {
      return { supported: false, reason: withSetupGuide('telegram', `${describeTelegramError(error)}.`) }
    }
  }

  async send(msg: OutboundMessage): Promise<DeliveryResult> {
    if (!this.bot || this.currentStatus !== 'connected') {
      return {
        success: false,
        error: withSetupGuide('telegram', `Telegram bot is not connected (status: ${this.currentStatus}). Start the Telegram adapter in Settings > Channel Adapters and check its logs — an invalid TELEGRAM_BOT_TOKEN is the most common cause.`)
      }
    }

    try {
      // Determine chat_id from sourceMeta (for replies) or recipientId
      const chatId = (msg.sourceMeta?.chat_id as number | string) ?? msg.recipientId
      const replyToMessageId = msg.sourceMeta?.message_id as number | undefined
      const replyParams = replyToMessageId ? { reply_parameters: { message_id: replyToMessageId } } : undefined

      // Typed form content. Contract violations (malformed JSON, ineligible
      // explicit render) fail the delivery with a precise error — agents are
      // competent; a clear error beats a silently degraded message.
      if (msg.contentType === FORM_CONTENT_TYPE) {
        return await this.sendForm(chatId, parseFormJson(msg.payload), replyParams)
      }

      let lastMessageId: number | undefined
      let textMessageId: number | undefined

      // Send text message (if there's text or no attachments)
      if (msg.payload || !msg.attachments?.length) {
        const text = msg.payload || ''
        // HTML content is sanitized to Telegram's tag subset; markdown (the
        // default) is converted. Either way a parse failure falls back to a
        // readable plain-text send.
        const isHtml = msg.contentType === HTML_CONTENT_TYPE
        const html = isHtml ? sanitizeTelegramHtml(text) : markdownToTelegramHtml(text)
        const plainFallback = isHtml ? htmlToPlainText(text) : text
        let sent
        try {
          sent = await this.bot.api.sendMessage(chatId, html, { ...replyParams, parse_mode: 'HTML' })
        } catch {
          sent = await this.bot.api.sendMessage(chatId, plainFallback, replyParams)
        }
        lastMessageId = sent.message_id
        textMessageId = sent.message_id
        this.ctx?.log('info', `Sent text to chat ${chatId}: message_id=${sent.message_id}`)
      }

      // Send attachments individually so one failure neither aborts the
      // remaining sends nor masks the fact that the text message above
      // already went out (partial-success report, mirroring the Slack adapter).
      const attachmentFailures: string[] = []
      if (msg.attachments?.length) {
        for (const att of msg.attachments) {
          if (!att.data) continue

          const file = new InputFile(att.data, att.filename)
          const isAudio = att.mimeType.startsWith('audio/')
          const isGif = !isAudio && att.mimeType === 'image/gif'
          const isImage = !isAudio && !isGif && att.mimeType.startsWith('image/')

          const rawCaption = !lastMessageId ? msg.payload : undefined
          const captionOpts = {
            caption: rawCaption ? markdownToTelegramHtml(rawCaption) : undefined,
            parse_mode: rawCaption ? 'HTML' as const : undefined,
            ...(!lastMessageId ? replyParams : undefined)
          }

          try {
            if (isAudio) {
              try {
                let voiceData = att.data
                if (att.mimeType === 'audio/wav' || att.mimeType === 'audio/x-wav' || att.filename.endsWith('.wav')) {
                  voiceData = await convertToOggOpus(att.data)
                }
                const sent = await this.bot.api.sendVoice(chatId, new InputFile(voiceData, att.filename), captionOpts)
                lastMessageId = sent.message_id
                this.ctx?.log('info', `Sent voice "${att.filename}" to chat ${chatId}: message_id=${sent.message_id}`)
              } catch (err) {
                // Fall back to document if voice sending fails (e.g. ffmpeg missing for conversion)
                this.ctx?.log('warn', `sendVoice failed for "${att.filename}", falling back to sendDocument: ${err}`)
                const docFile = new InputFile(att.data, att.filename)
                const sent = await this.bot.api.sendDocument(chatId, docFile, captionOpts)
                lastMessageId = sent.message_id
              }
            } else if (isGif) {
              const sent = await this.bot.api.sendAnimation(chatId, file, captionOpts)
              lastMessageId = sent.message_id
              this.ctx?.log('info', `Sent animation "${att.filename}" to chat ${chatId}: message_id=${sent.message_id}`)
            } else if (isImage) {
              try {
                const sent = await this.bot.api.sendPhoto(chatId, file, captionOpts)
                lastMessageId = sent.message_id
                this.ctx?.log('info', `Sent photo "${att.filename}" to chat ${chatId}: message_id=${sent.message_id}`)
              } catch {
                // Telegram rejects some valid images (CMYK, high-res, etc.) — fall back to document
                this.ctx?.log('warn', `sendPhoto failed for "${att.filename}", falling back to sendDocument`)
                const docFile = new InputFile(att.data, att.filename)
                const sent = await this.bot.api.sendDocument(chatId, docFile, captionOpts)
                lastMessageId = sent.message_id
                this.ctx?.log('info', `Sent as document "${att.filename}" to chat ${chatId}: message_id=${sent.message_id}`)
              }
            } else {
              const sent = await this.bot.api.sendDocument(chatId, file, captionOpts)
              lastMessageId = sent.message_id
              this.ctx?.log('info', `Sent document "${att.filename}" to chat ${chatId}: message_id=${sent.message_id}`)
            }
          } catch (err) {
            const reason = describeTelegramError(err)
            this.ctx?.log('error', `Attachment send failed for "${att.filename}": ${reason}`)
            attachmentFailures.push(`"${att.filename}": ${reason}`)
          }
        }
      }

      const sourceMeta = {
        chat_id: chatId,
        message_id: lastMessageId
      }

      if (attachmentFailures.length > 0) {
        const detail = attachmentFailures.join('; ')
        // Partial success: tell the agent what DID go out so it doesn't
        // re-send the text while chasing the attachment failure.
        const error = withSetupGuide('telegram', textMessageId != null
          ? `Text message was delivered to chat ${chatId} (message_id=${textMessageId}), but ${attachmentFailures.length} attachment(s) failed to send — ${detail}.`
          : `Attachment send to chat ${chatId} failed — ${detail}.`)
        return { success: false, error, ...(lastMessageId != null ? { sourceMeta } : {}) }
      }

      return { success: true, sourceMeta }
    } catch (error) {
      // Form contract violations are the agent's to fix (message shape, not
      // adapter setup) — surface them verbatim without setup guidance.
      if (error instanceof TypedContentError) {
        this.ctx?.log('error', `Send failed: ${error.message}`)
        return { success: false, error: error.message }
      }
      const errorMsg = withSetupGuide('telegram', `${describeTelegramError(error)}.`)
      this.ctx?.log('error', `Send failed: ${errorMsg}`)
      return { success: false, error: errorMsg }
    }
  }

  /**
   * Renderer validation — the agent chose `render`; the adapter's only job is
   * to check the form's shape against that surface's contract and dispatch.
   *   - 'poll'         native Telegram poll — single choice/multi question,
   *                    2-10 options, title+question <=300 / options <=100 chars
   *   - 'compact'      ONE message with one combined keyboard — requires no
   *                    free-text questions
   *   - 'per_question' one message per question (any shape)
   * A shape that doesn't satisfy the chosen surface FAILS the delivery with
   * the precise reason. There is no automatic selection.
   */
  private validateFormRenderer(form: FormHint): 'poll' | 'compact' | 'per_question' {
    if (form.render === 'poll') {
      const q0 = form.questions[0]
      const problem =
        form.questions.length !== 1 ? `has ${form.questions.length} questions (polls hold exactly one)` :
        q0.type === 'text' ? `question "${q0.id}" is free-text (polls need choice/multi)` :
        (q0.options?.length ?? 0) < 2 || (q0.options?.length ?? 0) > 10 ? `question "${q0.id}" has ${q0.options?.length ?? 0} options (polls allow 2-10)` :
        // The poll question is "title\ntext" when a title is set — the combined
        // length is what Telegram's 300-char limit applies to.
        (form.title ? form.title.length + 1 : 0) + q0.text.length > 300
          ? `title + question text is ${(form.title ? form.title.length + 1 : 0) + q0.text.length} chars (poll limit 300)` :
        (q0.options ?? []).some((o) => o.label.length > 100) ? 'an option label exceeds the 100-char poll limit' :
        null
      if (problem) throw new TypedContentError(`render 'poll' rejected: ${problem}. Use render 'compact' or 'per_question'.`)
      return 'poll'
    }
    if (form.render === 'compact') {
      const textQuestion = form.questions.find((q) => q.type === 'text')
      if (textQuestion) throw new TypedContentError(`render 'compact' rejected: question "${textQuestion.id}" is free-text (compact keyboards can only render choice/multi). Use render 'per_question'.`)
      return 'compact'
    }
    return 'per_question'
  }

  private async sendForm(
    chatId: number | string,
    form: FormHint,
    replyParams?: { reply_parameters: { message_id: number } }
  ): Promise<DeliveryResult> {
    if (!this.bot) {
      return {
        success: false,
        error: withSetupGuide('telegram', 'Telegram bot is not connected. Start the Telegram adapter in Settings > Channel Adapters, then retry.')
      }
    }
    const renderer = this.validateFormRenderer(form)
    if (renderer === 'poll') return this.sendFormPoll(chatId, form, replyParams)
    if (renderer === 'compact') return this.sendFormCompact(chatId, form, replyParams)
    return this.sendFormPerQuestion(chatId, form, replyParams)
  }

  private toPendingQuestion(q: FormHint['questions'][number]): PendingFormQuestion {
    return {
      questionId: q.id,
      questionText: q.text,
      type: q.type as 'choice' | 'multi',
      options: q.options ?? [],
      selectedByUser: new Map()
    }
  }

  /** Max buttons per keyboard row in compact mode. Telegram allows 8; 4 keeps
   * labels readable on phones. Deterministic \u2014 part of the render contract. */
  private static readonly COMPACT_BUTTONS_PER_ROW = 4

  /**
   * Keyboard rows for one question.
   * per_question mode: one option per row (Telegram-conventional list).
   * compact mode: options share rows horizontally, chunked at
   * COMPACT_BUTTONS_PER_ROW (Done rides the last chunk) \u2014 that's what makes
   * the single message compact instead of a stacked list with prefixes.
   */
  private buildQuestionRows(
    formId: string,
    q: PendingFormQuestion,
    selected: Set<string>,
    opts: { compact: boolean; numberPrefix?: string }
  ): { text: string; callback_data: string }[][] {
    const prefix = opts.numberPrefix ?? ''
    if (q.answeredLabel != null) {
      return [[{
        text: `${prefix}\u2713 ${q.answeredLabel}`,
        callback_data: encodeFormAction(formId, q.questionId, FORM_ANSWERED)
      }]]
    }
    const buttons = q.options.map((opt, oi) => ({
      // In compact mode only the first button of a question carries the number
      text: `${oi === 0 ? prefix : ''}${selected.has(opt.id) ? '\u2705 ' : ''}${opt.label}`,
      callback_data: encodeFormAction(formId, q.questionId, opt.id)
    }))
    if (q.type === 'multi') {
      buttons.push({ text: '\u2713 Done', callback_data: encodeFormAction(formId, q.questionId, FORM_MULTI_DONE) })
    }
    if (!opts.compact) {
      return buttons.map((b) => [b])
    }
    const rows: { text: string; callback_data: string }[][] = []
    for (let i = 0; i < buttons.length; i += TelegramAdapter.COMPACT_BUTTONS_PER_ROW) {
      rows.push(buttons.slice(i, i + TelegramAdapter.COMPACT_BUTTONS_PER_ROW))
    }
    return rows
  }

  /** Combined keyboard for a compact form message, rendered with `userId`'s
   * multi-select state (the keyboard is shared; the last tapper's view wins).
   * Question-number prefixes appear only when the form has several questions. */
  private buildCompactKeyboard(entry: PendingFormMessage, userId: string): { text: string; callback_data: string }[][] {
    const rows: { text: string; callback_data: string }[][] = []
    const numbered = entry.questions.length > 1
    entry.questions.forEach((q, qi) => {
      const selected = q.selectedByUser.get(userId) ?? new Set<string>()
      rows.push(...this.buildQuestionRows(entry.formId, q, selected, {
        compact: true,
        numberPrefix: numbered ? `${qi + 1} \u00b7 ` : undefined
      }))
    })
    return rows
  }

  /**
   * render: 'poll' - the question becomes a native Telegram poll (single
   * block, platform-rendered). Non-anonymous so poll_answer updates identify
   * the voter; multi questions allow multiple answers. Vote changes re-ingest
   * (latest answer wins - aggregation is the agent's job).
   */
  private async sendFormPoll(
    chatId: number | string,
    form: FormHint,
    replyParams?: { reply_parameters: { message_id: number } }
  ): Promise<DeliveryResult> {
    const q = form.questions[0]
    const options = q.options ?? []
    const question = form.title ? `${form.title}\n${q.text}` : q.text
    const sent = await this.bot!.api.sendPoll(chatId, question, options.map((o) => o.label), {
      ...replyParams,
      is_anonymous: false,
      allows_multiple_answers: q.type === 'multi'
    })
    if (sent.poll?.id) {
      this.pendingPolls.set(sent.poll.id, {
        formId: form.id,
        questionId: q.id,
        options,
        chatId,
        messageId: sent.message_id
      })
    }
    this.ctx?.log('info', `Sent form "${form.id}" as native poll to chat ${chatId}`)
    return {
      success: true,
      sourceMeta: {
        chat_id: chatId,
        message_id: sent.message_id,
        message_ids: [sent.message_id],
        form_id: form.id
      }
    }
  }

  /**
   * render: 'compact' - the whole form is ONE message: numbered questions in
   * the text, one combined keyboard underneath. Answered questions collapse
   * to a checkmark row; the message finalizes once every question is
   * answered.
   */
  private async sendFormCompact(
    chatId: number | string,
    form: FormHint,
    replyParams?: { reply_parameters: { message_id: number } }
  ): Promise<DeliveryResult> {
    const entry: PendingFormMessage = {
      formId: form.id,
      title: form.title,
      compact: true,
      questions: form.questions.map((q) => this.toPendingQuestion(q))
    }
    const lines: string[] = []
    if (form.title) lines.push(`**${form.title}**`, '')
    // Number the questions only when there are several — a single question
    // reads cleaner bare, matching the unnumbered keyboard.
    form.questions.forEach((q, qi) => lines.push(form.questions.length > 1 ? `${qi + 1}. ${q.text}` : q.text))
    const text = markdownToTelegramHtml(lines.join('\n'))

    const keyboard = this.buildCompactKeyboard(entry, '')
    let sent
    try {
      sent = await this.bot!.api.sendMessage(chatId, text, {
        ...replyParams,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: keyboard }
      })
    } catch {
      sent = await this.bot!.api.sendMessage(chatId, lines.join('\n'), {
        ...replyParams,
        reply_markup: { inline_keyboard: keyboard }
      })
    }
    this.formMessages.set(`${chatId}:${sent.message_id}`, entry)
    this.ctx?.log('info', `Sent form "${form.id}" (${form.questions.length} questions) as one compact message to chat ${chatId}`)
    return {
      success: true,
      sourceMeta: {
        chat_id: chatId,
        message_id: sent.message_id,
        message_ids: [sent.message_id],
        form_id: form.id
      }
    }
  }

  /**
   * render: 'per_question' - one Telegram message per question. choice/multi
   * questions get inline keyboards; text questions ask for a reply. Every
   * sent message_id is returned so replies to any of them resolve parent_id.
   */
  private async sendFormPerQuestion(
    chatId: number | string,
    form: FormHint,
    replyParams?: { reply_parameters: { message_id: number } }
  ): Promise<DeliveryResult> {
    const messageIds: number[] = []

    try {
      if (form.title) {
        const sent = await this.bot!.api.sendMessage(chatId, markdownToTelegramHtml(`**${form.title}**`), { ...replyParams, parse_mode: 'HTML' })
        messageIds.push(sent.message_id)
      }

      for (const q of form.questions) {
        if (q.type === 'text') {
          const sent = await this.bot!.api.sendMessage(chatId, `${q.text}\n(reply to this message to answer)`, messageIds.length === 0 ? replyParams : undefined)
          messageIds.push(sent.message_id)
          continue
        }

        const pending = this.toPendingQuestion(q)
        const sent = await this.bot!.api.sendMessage(chatId, q.text, {
          ...(messageIds.length === 0 ? replyParams : undefined),
          reply_markup: { inline_keyboard: this.buildQuestionRows(form.id, pending, new Set(), { compact: false }) }
        })
        messageIds.push(sent.message_id)
        this.formMessages.set(`${chatId}:${sent.message_id}`, {
          formId: form.id,
          compact: false,
          questions: [pending]
        })
      }
    } catch (error) {
      // A mid-form failure marks the outbox row failed, so the message_ids
      // sent so far would never be registered (their answers would lose
      // parent_id) and a retry would duplicate the questions. Best-effort
      // delete of what was already delivered so a retry starts clean.
      this.ctx?.log('warn', `Form "${form.id}" failed mid-send after ${messageIds.length} message(s) - rolling back delivered questions`)
      for (const id of messageIds) {
        this.formMessages.delete(`${chatId}:${id}`)
        try { await this.bot!.api.deleteMessage(chatId, id) } catch { /* best-effort */ }
      }
      throw error
    }

    this.ctx?.log('info', `Sent form "${form.id}" (${form.questions.length} questions) to chat ${chatId}`)
    return {
      success: true,
      sourceMeta: {
        chat_id: chatId,
        message_id: messageIds[messageIds.length - 1],
        message_ids: messageIds,
        form_id: form.id
      }
    }
  }

  /** Shared policy gate for form interactions (button taps and poll votes).
   * `isPrivate` decides which policy applies; taps/votes always target our
   * own message, so groups 'mention' is satisfied by the interaction itself. */
  private formInteractionAllowed(isPrivate: boolean, fromId: string): boolean {
    const policy = this.ctx?.getConfig().policy ?? {}
    if (isPrivate) {
      const dmPolicy = policy.dm ?? 'all'
      if (dmPolicy === 'none') return false
      if (dmPolicy === 'allowlist') {
        const allowFrom = policy.allow_from ?? []
        if (!allowFrom.includes(fromId)) return false
      }
      return true
    }
    return (policy.groups ?? 'all') !== 'none'
  }

  private ingestFormAnswer(input: {
    from: { id: number; first_name?: string; last_name?: string; username?: string }
    chatId: number | string
    chatType?: string
    formId: string
    questionId: string
    answerIds: string[]
    answerLabels: string
    replyToMessageId: number
  }): void {
    if (!this.ctx) return
    const senderName = [input.from.first_name, input.from.last_name].filter(Boolean).join(' ') || String(input.from.id)
    const inbound: InboundMessage = {
      sender: String(input.from.id),
      senderName,
      payload: input.answerLabels,
      sourceMeta: {
        chat_id: input.chatId,
        chat_type: input.chatType,
        username: input.from.username,
        form_id: input.formId,
        question_id: input.questionId,
        answer_id: input.answerIds.length === 1 ? input.answerIds[0] : input.answerIds,
        answer_value: input.answerLabels,
        // Resolves parent_id to the form's outbox row via registered message_ids
        reply_to_message_id: input.replyToMessageId
      },
      sentAt: Date.now()
    }
    this.ctx.log('info', `Form answer from ${senderName}: ${input.formId}/${input.questionId} = ${input.answerLabels}`)
    this.ctx.ingest(inbound)
  }

  private async handleFormCallback(cbCtx: CallbackQueryContext<Context>): Promise<void> {
    if (!this.bot || !this.ctx) return
    const query = cbCtx.callbackQuery

    // Clear the button spinner inside Telegram's short ACK window, before any
    // slower work.
    try { await cbCtx.answerCallbackQuery() } catch { /* expired queries are fine */ }

    const action = decodeFormAction(query.data)
    if (!action) return
    if (action.optionId === FORM_ANSWERED) return // tap on an already-answered row

    const message = query.message
    if (!message) return
    const chatId = message.chat.id
    const messageId = message.message_id
    const from = query.from

    if (!this.formInteractionAllowed(message.chat.type === 'private', String(from.id))) return

    const entry = this.formMessages.get(`${chatId}:${messageId}`)
    const pending = entry?.questions.find((q) => q.questionId === action.questionId)

    // The Done sentinel is only meaningful while the multi-select state
    // exists. After a restart the map is empty - never ingest '__done' as an
    // answer; leave the keyboard live so options can be tapped again.
    if (!pending && action.optionId === FORM_MULTI_DONE) {
      this.ctx.log('warn', `Ignoring form Done tap for ${action.formId}/${action.questionId} - selection state lost (adapter restarted)`)
      return
    }
    if (pending?.answeredLabel != null) return // question already answered

    // Resolve the human-readable answer label; after a restart the map is
    // empty, so fall back to the option id from the callback data.
    const option = pending?.options.find((o) => o.id === action.optionId)
    const label = option?.label ?? action.optionId
    const userId = String(from.id)

    if (pending?.type === 'multi' && action.optionId !== FORM_MULTI_DONE) {
      // Toggle the tapper's own selection and refresh the keyboard with
      // check prefixes reflecting that user's state
      let selected = pending.selectedByUser.get(userId)
      if (!selected) {
        selected = new Set()
        pending.selectedByUser.set(userId, selected)
      }
      if (selected.has(action.optionId)) selected.delete(action.optionId)
      else selected.add(action.optionId)
      const keyboard = entry!.compact
        ? this.buildCompactKeyboard(entry!, userId)
        : this.buildQuestionRows(entry!.formId, pending, selected, { compact: false })
      try {
        await this.bot.api.editMessageReplyMarkup(chatId, messageId, { reply_markup: { inline_keyboard: keyboard } })
      } catch { /* markup unchanged is a Telegram error - ignore */ }
      return
    }

    // Final answer: single choice, or multi finalized via Done - using only
    // the finalizing user's own selections
    let answerIds: string[]
    let answerLabels: string
    if (pending?.type === 'multi') {
      const selected = pending.selectedByUser.get(userId) ?? new Set<string>()
      answerIds = [...selected]
      answerLabels = pending.options.filter((o) => selected.has(o.id)).map((o) => o.label).join(', ') || '(none)'
    } else {
      answerIds = [action.optionId]
      answerLabels = label
    }

    if (entry && pending) {
      pending.answeredLabel = answerLabels
      if (entry.compact) {
        const allAnswered = entry.questions.every((q) => q.answeredLabel != null)
        if (allAnswered) {
          // Finalize: stamp all answers into the text, drop the keyboard
          const lines: string[] = []
          if (entry.title) lines.push(entry.title, '')
          entry.questions.forEach((q, qi) => lines.push(`${entry.questions.length > 1 ? `${qi + 1}. ` : ''}${q.questionText}\n   \u2713 ${q.answeredLabel}`))
          try {
            await this.bot.api.editMessageText(chatId, messageId, lines.join('\n'))
          } catch {
            try { await this.bot.api.editMessageReplyMarkup(chatId, messageId, { reply_markup: { inline_keyboard: [] } }) } catch { /* ignore */ }
          }
          this.formMessages.delete(`${chatId}:${messageId}`)
        } else {
          // Collapse this question's rows, keep the rest live
          try {
            await this.bot.api.editMessageReplyMarkup(chatId, messageId, { reply_markup: { inline_keyboard: this.buildCompactKeyboard(entry, userId) } })
          } catch { /* ignore */ }
        }
      } else {
        // Per-question message: stamp the answer, remove the keyboard
        try {
          await this.bot.api.editMessageText(chatId, messageId, `${pending.questionText}\n\n\u2713 ${answerLabels}`)
        } catch {
          try { await this.bot.api.editMessageReplyMarkup(chatId, messageId, { reply_markup: { inline_keyboard: [] } }) } catch { /* ignore */ }
        }
        this.formMessages.delete(`${chatId}:${messageId}`)
      }
    } else {
      // Restart fallback: no state - still stamp something readable
      try {
        await this.bot.api.editMessageText(chatId, messageId, `${message.text ?? ''}\n\n\u2713 ${answerLabels}`)
      } catch {
        try { await this.bot.api.editMessageReplyMarkup(chatId, messageId, { reply_markup: { inline_keyboard: [] } }) } catch { /* ignore */ }
      }
    }

    this.ingestFormAnswer({
      from,
      chatId,
      chatType: message.chat.type,
      formId: action.formId,
      questionId: action.questionId,
      answerIds,
      answerLabels,
      replyToMessageId: messageId
    })
  }

  /** Answers to render:'poll' forms. Vote changes fire again (latest wins);
   * retractions (empty option_ids) are ignored. */
  private async handlePollAnswer(pollAnswer: {
    poll_id: string
    user?: { id: number; first_name?: string; last_name?: string; username?: string }
    option_ids: number[]
  }): Promise<void> {
    if (!this.ctx) return
    const pending = this.pendingPolls.get(pollAnswer.poll_id)
    if (!pending) return // not one of our form polls (or state lost to a restart)
    const from = pollAnswer.user
    if (!from) return // anonymous channel votes carry no user

    // Telegram group/supergroup chat ids are negative; private chats positive.
    const isPrivate = typeof pending.chatId === 'number' ? pending.chatId > 0 : !String(pending.chatId).startsWith('-')
    if (!this.formInteractionAllowed(isPrivate, String(from.id))) return

    if (pollAnswer.option_ids.length === 0) {
      this.ctx.log('info', `Poll vote retracted for form ${pending.formId}/${pending.questionId} - ignoring`)
      return
    }

    const chosen = pollAnswer.option_ids
      .map((i) => pending.options[i])
      .filter((o): o is { id: string; label: string } => !!o)
    this.ingestFormAnswer({
      from,
      chatId: pending.chatId,
      chatType: isPrivate ? 'private' : 'group',
      formId: pending.formId,
      questionId: pending.questionId,
      answerIds: chosen.map((o) => o.id),
      answerLabels: chosen.map((o) => o.label).join(', '),
      replyToMessageId: pending.messageId
    })
  }

  canDeliver(_id: string): boolean {
    return this.currentStatus === 'connected'
  }

  status(): AdapterStatus {
    return this.currentStatus
  }
}

/**
 * Convert standard markdown to Telegram-compatible HTML.
 * Escapes HTML entities first, then converts common markdown patterns.
 * Handles: code blocks, inline code, bold, italic, strikethrough, links.
 */
function markdownToTelegramHtml(text: string): string {
  // Escape HTML entities
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  // Code blocks (``` ... ```) — must be before inline code
  html = html.replace(/```\w*\n?([\s\S]*?)```/g, '<pre>$1</pre>')

  // Inline code (`...`)
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>')

  // Bold (**text**) — must be before italic
  html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')

  // Italic (*text*)
  html = html.replace(/(?<!\w)\*(.+?)\*(?!\w)/g, '<i>$1</i>')

  // Strikethrough (~~text~~)
  html = html.replace(/~~(.+?)~~/g, '<s>$1</s>')

  // Links [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')

  return html
}
