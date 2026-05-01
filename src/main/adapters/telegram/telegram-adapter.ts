import { Bot, InputFile } from 'grammy'
import { convertToOggOpus } from './audio-convert'
import type {
  ChannelAdapter,
  AdapterContext,
  AdapterStatus,
  OutboundMessage,
  DeliveryResult,
  InboundMessage
} from '../../../shared/types/channel-adapter.types'

/**
 * Telegram adapter using grammy.
 *
 * Receives messages via long-polling and delivers outbound messages
 * via the Bot API. Policy filtering (DM, groups, allowlist) is applied
 * before ingesting inbound messages.
 */
export class TelegramAdapter implements ChannelAdapter {
  private bot: Bot | null = null
  private ctx: AdapterContext | null = null
  private currentStatus: AdapterStatus = 'disconnected'
  private pollingAbortController: AbortController | null = null

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

      const inbound: InboundMessage = {
        sender: String(from.id),
        senderName,
        payload: text,
        attachments: attachments.length > 0 ? attachments : undefined,
        sourceMeta,
        sentAt: grammyCtx.message?.date ? grammyCtx.message.date * 1000 : undefined
      }

      this.ctx.log('info', `Inbound from ${senderName} (${from.id}) in ${chat.type} chat ${chat.id}`)
      this.ctx.ingest(inbound)
    })

    // Start long-polling
    try {
      this.pollingAbortController = new AbortController()

      // Initialize bot info first (validates token, fetches bot username)
      await this.bot.init()

      // Drop pending updates to avoid 409 conflicts with stale polling sessions
      try {
        await this.bot.api.deleteWebhook({ drop_pending_updates: true })
      } catch {
        // Non-fatal — continue even if this fails
      }

      // Start polling in background (non-blocking).
      // Catch the returned promise to prevent unhandled rejections from
      // the long-running polling loop (e.g. 409 Conflict errors).
      this.bot.start({
        onStart: () => {
          this.currentStatus = 'connected'
          this.ctx?.log('info', `Bot started: @${this.bot?.botInfo.username}`)
        },
        allowed_updates: ['message'],
        drop_pending_updates: true
      }).catch((err) => {
        // Polling loop terminated — only log if we're still supposed to be running
        if (this.currentStatus !== 'disconnected') {
          const msg = err instanceof Error ? err.message : String(err)
          this.ctx?.log('error', `Polling stopped: ${msg}`)
          this.currentStatus = 'error'
        }
      })

      this.currentStatus = 'connected'
      ctx.log('info', `Telegram bot initialized: @${this.bot.botInfo.username}`)
    } catch (error) {
      this.currentStatus = 'error'
      throw error
    }
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

      let lastMessageId: number | undefined

      // Send text message (if there's text or no attachments)
      if (msg.payload || !msg.attachments?.length) {
        const text = msg.payload || ''
        const html = markdownToTelegramHtml(text)
        let sent
        try {
          sent = await this.bot.api.sendMessage(chatId, html, { ...replyParams, parse_mode: 'HTML' })
        } catch {
          // Fallback to plain text if HTML parsing fails
          sent = await this.bot.api.sendMessage(chatId, text, replyParams)
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
