import { Bot, InputFile } from 'grammy'
import type { CallbackQueryContext, Context } from 'grammy'
import { convertToOggOpus } from '../shared/audio-convert'
import { buildGroupMeta, GroupMetaCache } from '../group-meta'
import type { GroupMeta } from '../group-meta'
import { decodeFormAction, encodeFormAction, FORM_MULTI_DONE, FORM_CONTENT_TYPE } from '../../../shared/types/form-hints.types'
import type { FormHint } from '../../../shared/types/form-hints.types'
import { parseFormJson } from '../form-render'
import { HTML_CONTENT_TYPE, sanitizeTelegramHtml, htmlToPlainText } from '../shared/html-content'
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
  formId: string
  questionId: string
  questionText: string
  type: 'choice' | 'multi'
  options: { id: string; label: string }[]
  selected: Set<string>
  chatId: number | string
}

export class TelegramAdapter implements ChannelAdapter {
  private bot: Bot | null = null
  private ctx: AdapterContext | null = null
  private currentStatus: AdapterStatus = 'disconnected'
  private pollingAbortController: AbortController | null = null
  private groupMetaCache = new GroupMetaCache()
  /** Live form questions keyed by `${chatId}:${messageId}` — in-memory only;
   * after a restart, callbacks still decode via callback_data and parent_id
   * resolves through the persisted outbox meta (message_ids). */
  private formQuestions = new Map<string, PendingFormQuestion>()

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx
    this.currentStatus = 'connecting'

    const token = ctx.getCredential('TELEGRAM_BOT_TOKEN')
    if (!token) {
      this.currentStatus = 'error'
      throw new Error('Missing TELEGRAM_BOT_TOKEN credential')
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
            this.ctx.log('warn', `Failed to download photo: ${err}`)
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
            this.ctx.log('warn', `Failed to download document: ${err}`)
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
            this.ctx.log('warn', `Failed to download voice: ${err}`)
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
            this.ctx.log('warn', `Failed to download video: ${err}`)
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
            this.ctx.log('warn', `Failed to download video note: ${err}`)
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
            this.ctx.log('warn', `Failed to download audio: ${err}`)
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
            this.ctx.log('warn', `Failed to download animation: ${err}`)
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

    // Inline-keyboard answers for message_meta.form questionnaires
    this.bot.on('callback_query:data', async (cbCtx) => {
      try {
        await this.handleFormCallback(cbCtx)
      } catch (err) {
        this.ctx?.log('warn', `callback_query handler failed: ${err instanceof Error ? err.message : err}`)
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
        allowed_updates: ['message', 'callback_query'],
        drop_pending_updates: true
      }).catch((err) => {
        // Polling loop terminated — only log if this bot is still current
        // and we're still supposed to be running
        if (this.bot === bot && this.currentStatus !== 'disconnected') {
          const msg = err instanceof Error ? err.message : String(err)
          this.ctx?.log('error', `Polling stopped: ${msg}`)
          this.currentStatus = 'error'
        }
      })

      this.currentStatus = 'connected'
      ctx.log('info', `Telegram bot initialized: @${bot.botInfo.username}`)
    } catch (error) {
      // If stop() aborted us mid-start, stay 'disconnected'
      if (!this.wasStopped()) this.currentStatus = 'error'
      throw error
    }
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
    this.formQuestions.clear()
  }

  private async fetchGroupMeta(chatId: number, chatType: string, title?: string): Promise<GroupMeta | null> {
    if (!this.bot) return null
    let participantCount: number | undefined
    let admins: GroupMeta['participants'] = []
    try {
      participantCount = await this.bot.api.getChatMemberCount(chatId)
    } catch { /* count is best-effort */ }
    try {
      const members = await this.bot.api.getChatAdministrators(chatId)
      admins = members.map((m) => ({
        id: String(m.user.id),
        name: [m.user.first_name, m.user.last_name].filter(Boolean).join(' ') || m.user.username || String(m.user.id),
        role: m.status
      }))
    } catch { /* roster is best-effort — bot may lack rights */ }

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
        try { participantCount = await this.bot.api.getChatMemberCount(numericId) } catch { /* best-effort */ }
        try {
          const members = await this.bot.api.getChatAdministrators(numericId)
          admins = members.slice(0, limit).map((m) => ({
            id: String(m.user.id),
            name: [m.user.first_name, m.user.last_name].filter(Boolean).join(' ') || m.user.username || String(m.user.id),
            role: m.status
          }))
        } catch { /* best-effort */ }
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
      return { supported: false, reason: String(error instanceof Error ? error.message : error) }
    }
  }

  async send(msg: OutboundMessage): Promise<DeliveryResult> {
    if (!this.bot || this.currentStatus !== 'connected') {
      return { success: false, error: 'Bot not connected' }
    }

    try {
      // Determine chat_id from sourceMeta (for replies) or recipientId
      const chatId = (msg.sourceMeta?.chat_id as number | string) ?? msg.recipientId
      const replyToMessageId = msg.sourceMeta?.message_id as number | undefined
      const replyParams = replyToMessageId ? { reply_parameters: { message_id: replyToMessageId } } : undefined

      // Typed form content — rendered as inline keyboards. msg_send validates
      // the JSON at send time, so a parse failure here (e.g. a raw send from
      // custom code) degrades to the ordinary text send below, never fails.
      if (msg.contentType === FORM_CONTENT_TYPE) {
        const form = parseFormJson(msg.payload)
        if (form) {
          return await this.sendForm(chatId, form, replyParams)
        }
        this.ctx?.log('warn', `Invalid ${FORM_CONTENT_TYPE} content — sending payload as plain text instead`)
      }

      let lastMessageId: number | undefined

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
        this.ctx?.log('info', `Sent text to chat ${chatId}: message_id=${sent.message_id}`)
      }

      // Send attachments
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
        }
      }

      return {
        success: true,
        sourceMeta: {
          chat_id: chatId,
          message_id: lastMessageId
        }
      }
    } catch (error) {
      const errorMsg = String(error instanceof Error ? error.message : error)
      this.ctx?.log('error', `Send failed: ${errorMsg}`)
      return { success: false, error: errorMsg }
    }
  }

  /**
   * Render a form hint as one Telegram message per question. choice/multi
   * questions get inline keyboards; text questions ask for a reply. Every
   * sent message_id is returned so replies to any of them resolve parent_id.
   */
  private async sendForm(
    chatId: number | string,
    form: FormHint,
    replyParams?: { reply_parameters: { message_id: number } }
  ): Promise<DeliveryResult> {
    if (!this.bot) return { success: false, error: 'Bot not connected' }

    const messageIds: number[] = []

    if (form.title) {
      const sent = await this.bot.api.sendMessage(chatId, markdownToTelegramHtml(`**${form.title}**`), { ...replyParams, parse_mode: 'HTML' })
      messageIds.push(sent.message_id)
    }

    for (const q of form.questions) {
      if (q.type === 'text') {
        const sent = await this.bot.api.sendMessage(chatId, `${q.text}\n(reply to this message to answer)`, messageIds.length === 0 ? replyParams : undefined)
        messageIds.push(sent.message_id)
        continue
      }

      const keyboard = (q.options ?? []).map((opt) => [
        { text: opt.label, callback_data: encodeFormAction(form.id, q.id, opt.id) }
      ])
      if (q.type === 'multi') {
        keyboard.push([{ text: '✓ Done', callback_data: encodeFormAction(form.id, q.id, FORM_MULTI_DONE) }])
      }
      const sent = await this.bot.api.sendMessage(chatId, q.text, {
        ...(messageIds.length === 0 ? replyParams : undefined),
        reply_markup: { inline_keyboard: keyboard }
      })
      messageIds.push(sent.message_id)
      this.formQuestions.set(`${chatId}:${sent.message_id}`, {
        formId: form.id,
        questionId: q.id,
        questionText: q.text,
        type: q.type,
        options: q.options ?? [],
        selected: new Set(),
        chatId
      })
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

  private async handleFormCallback(cbCtx: CallbackQueryContext<Context>): Promise<void> {
    if (!this.bot || !this.ctx) return
    const query = cbCtx.callbackQuery

    // Clear the button spinner inside Telegram's short ACK window, before any
    // slower work.
    try { await cbCtx.answerCallbackQuery() } catch { /* expired queries are fine */ }

    const action = decodeFormAction(query.data)
    if (!action) return

    const message = query.message
    if (!message) return
    const chatId = message.chat.id
    const messageId = message.message_id
    const from = query.from

    // Policy: apply the DM allowlist to button taps as well
    const config = this.ctx.getConfig()
    const policy = config.policy ?? {}
    if (message.chat.type === 'private' && (policy.dm ?? 'all') === 'allowlist') {
      const allowFrom = policy.allow_from ?? []
      if (!allowFrom.includes(String(from.id))) return
    }
    if ((policy.dm ?? 'all') === 'none' && message.chat.type === 'private') return

    const key = `${chatId}:${messageId}`
    const pending = this.formQuestions.get(key)
    const senderName = [from.first_name, from.last_name].filter(Boolean).join(' ') || String(from.id)

    // Resolve the human-readable answer label; after a restart the map is
    // empty, so fall back to the option id from the callback data.
    const option = pending?.options.find((o) => o.id === action.optionId)
    const label = option?.label ?? action.optionId

    if (pending?.type === 'multi' && action.optionId !== FORM_MULTI_DONE) {
      // Toggle selection and refresh the keyboard with check prefixes
      if (pending.selected.has(action.optionId)) pending.selected.delete(action.optionId)
      else pending.selected.add(action.optionId)
      const keyboard = pending.options.map((opt) => [{
        text: `${pending.selected.has(opt.id) ? '✅ ' : ''}${opt.label}`,
        callback_data: encodeFormAction(pending.formId, pending.questionId, opt.id)
      }])
      keyboard.push([{ text: '✓ Done', callback_data: encodeFormAction(pending.formId, pending.questionId, FORM_MULTI_DONE) }])
      try {
        await this.bot.api.editMessageReplyMarkup(chatId, messageId, { reply_markup: { inline_keyboard: keyboard } })
      } catch { /* markup unchanged is a Telegram error — ignore */ }
      return
    }

    // Final answer: single choice, or multi finalized via Done
    let answerIds: string[]
    let answerLabels: string
    if (pending?.type === 'multi') {
      answerIds = [...pending.selected]
      answerLabels = pending.options.filter((o) => pending.selected.has(o.id)).map((o) => o.label).join(', ') || '(none)'
    } else {
      answerIds = [action.optionId]
      answerLabels = label
    }

    // Disable the buttons and stamp the chosen answer onto the question message
    try {
      const questionText = pending?.questionText ?? message.text ?? ''
      await this.bot.api.editMessageText(chatId, messageId, `${questionText}\n\n✓ ${answerLabels}`)
    } catch {
      try { await this.bot.api.editMessageReplyMarkup(chatId, messageId, { reply_markup: { inline_keyboard: [] } }) } catch { /* ignore */ }
    }
    this.formQuestions.delete(key)

    const inbound: InboundMessage = {
      sender: String(from.id),
      senderName,
      payload: answerLabels,
      sourceMeta: {
        chat_id: chatId,
        chat_type: message.chat.type,
        username: from.username,
        form_id: action.formId,
        question_id: action.questionId,
        answer_id: answerIds.length === 1 ? answerIds[0] : answerIds,
        answer_value: answerLabels,
        // Resolves parent_id to the form's outbox row via registered message_ids
        reply_to_message_id: messageId
      },
      sentAt: Date.now()
    }

    this.ctx.log('info', `Form answer from ${senderName}: ${action.formId}/${action.questionId} = ${answerLabels}`)
    this.ctx.ingest(inbound)
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
