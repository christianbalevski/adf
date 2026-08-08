import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  jidNormalizedUser
} from '@whiskeysockets/baileys'
import type { WASocket, WAMessage, AnyMessageContent } from '@whiskeysockets/baileys'
import type { Boom } from '@hapi/boom'
import { toBuffer as qrToBuffer } from 'qrcode'
import { convertToOggOpus } from '../shared/audio-convert'
import { markdownToWhatsApp } from './wa-markdown'
import { FORM_CONTENT_TYPE } from '../../../shared/types/form-hints.types'
import { renderFormAsText, parseFormJson } from '../form-render'
import { buildGroupMeta, GroupMetaCache } from '../group-meta'
import type { GroupMeta } from '../group-meta'
import type {
  ChannelAdapter,
  AdapterContext,
  AdapterStatus,
  OutboundMessage,
  DeliveryResult,
  InboundMessage,
  ChatInfoResult
} from '../../../shared/types/channel-adapter.types'

const QR_PATH = 'imported/whatsapp/pairing-qr.png'
const MAX_QUOTE_RING = 500

/** Minimal pino-shaped logger bridging Baileys internals to the adapter log */
function makeSilentLogger(ctx: () => AdapterContext | null): Record<string, unknown> {
  const logger: Record<string, unknown> = {
    level: 'silent',
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (obj: unknown) => {
      const msg = obj instanceof Error ? obj.message : typeof obj === 'string' ? obj : JSON.stringify(obj)
      ctx()?.log('warn', `Baileys: ${msg}`)
    }
  }
  logger.child = () => logger
  return logger
}

/**
 * WhatsApp adapter using Baileys (multi-device WebSocket protocol).
 *
 * Pairs with a personal WhatsApp account via QR code — no tokens. The QR is
 * written to the agent's file store at imported/whatsapp/pairing-qr.png and
 * refreshed until scanned. Signal auth state lives on disk in the adapter
 * data dir (ctx.getDataDir); delete that directory and restart to unpair.
 *
 * NOTE: Baileys is an unofficial client. WhatsApp may ban accounts that look
 * automated — use a non-critical account.
 */
export class WhatsAppAdapter implements ChannelAdapter {
  private sock: WASocket | null = null
  private ctx: AdapterContext | null = null
  private currentStatus: AdapterStatus = 'disconnected'
  private selfJid: string | null = null
  private groupMetaCache = new GroupMetaCache()
  /** Recent inbound messages by id, kept for quoted replies */
  private quoteRing = new Map<string, WAMessage>()

  async start(ctx: AdapterContext): Promise<void> {
    // Re-entrant: the manager calls stop() before restarting, but guard anyway
    if (this.sock) {
      try { this.sock.end(undefined) } catch { /* ignore */ }
      this.sock = null
    }

    this.ctx = ctx
    this.currentStatus = 'connecting'

    if (!ctx.getDataDir) {
      this.currentStatus = 'error'
      throw new Error('WhatsApp adapter requires a host with adapter data directory support (getDataDir)')
    }
    const authDir = ctx.getDataDir()
    const { state, saveCreds } = await useMultiFileAuthState(authDir)

    const sock = makeWASocket({
      auth: state,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger: makeSilentLogger(() => this.ctx) as any,
      // We surface the QR ourselves as a PNG in the file store
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false
    })
    this.sock = sock

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        this.writePairingQr(qr)
      }

      if (connection === 'open') {
        this.currentStatus = 'connected'
        this.selfJid = sock.user?.id ? jidNormalizedUser(sock.user.id) : null
        this.ctx?.log('info', `WhatsApp connected as ${this.selfJid ?? 'unknown'}`)
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode
        if (this.currentStatus === 'disconnected') {
          return // deliberate stop
        }
        if (statusCode === DisconnectReason.loggedOut) {
          this.currentStatus = 'error'
          this.ctx?.log('error', `WhatsApp unpaired (logged out). Delete the adapter data directory (${authDir}) and restart the adapter to pair again.`)
        } else {
          // Transient close — the manager's health check auto-restarts us
          this.currentStatus = 'error'
          this.ctx?.log('warn', `WhatsApp connection closed (code ${statusCode ?? 'unknown'}) — will auto-reconnect`)
        }
      }
    })

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return
      for (const msg of messages) {
        try {
          await this.handleMessage(msg)
        } catch (err) {
          this.ctx?.log('warn', `Inbound handling failed: ${err instanceof Error ? err.message : err}`)
        }
      }
    })

    // start() resolves once the socket is set up; pairing/connection completes
    // asynchronously via connection.update. If auth state already exists this
    // usually flips to connected within a few seconds.
    ctx.log('info', `WhatsApp adapter starting (auth dir: ${authDir}). If unpaired, scan ${QR_PATH} from the agent's files.`)
  }

  private writePairingQr(qr: string): void {
    qrToBuffer(qr, { type: 'png', width: 512 })
      .then((png) => {
        this.ctx?.writeAttachment(QR_PATH, png, 'image/png')
        this.ctx?.log('info', `WhatsApp pairing required — QR written to ${QR_PATH} (expires in ~60s, regenerates automatically)`)
      })
      .catch((err) => {
        this.ctx?.log('warn', `Failed to render pairing QR: ${err instanceof Error ? err.message : err}`)
      })
  }

  async stop(): Promise<void> {
    this.currentStatus = 'disconnected'
    if (this.sock) {
      try { this.sock.end(undefined) } catch { /* ignore */ }
      this.sock = null
    }
    this.ctx = null
    this.selfJid = null
    this.quoteRing.clear()
    this.groupMetaCache.clear()
  }

  private async handleMessage(msg: WAMessage): Promise<void> {
    if (!this.ctx || !this.sock) return
    if (msg.key.fromMe) return
    const remoteJid = msg.key.remoteJid
    if (!remoteJid || remoteJid === 'status@broadcast') return
    const content = msg.message
    if (!content) return
    // Skip protocol-only payloads (key rotations, deletes, reactions, ...)
    if (content.protocolMessage || content.reactionMessage) return

    const isGroup = remoteJid.endsWith('@g.us')
    const senderJid = isGroup ? (msg.key.participant ?? remoteJid) : remoteJid
    const config = this.ctx.getConfig()
    const policy = config.policy ?? {}

    const contextInfo =
      content.extendedTextMessage?.contextInfo ??
      content.imageMessage?.contextInfo ??
      content.videoMessage?.contextInfo ??
      content.documentMessage?.contextInfo ??
      content.audioMessage?.contextInfo

    if (isGroup) {
      const groupPolicy = policy.groups ?? 'all'
      if (groupPolicy === 'none') return
      if (groupPolicy === 'mention') {
        const mentioned = (contextInfo?.mentionedJid ?? []).some(
          (jid) => this.selfJid && jidNormalizedUser(jid) === this.selfJid
        )
        const quotedOurs = contextInfo?.participant
          ? this.selfJid === jidNormalizedUser(contextInfo.participant)
          : false
        if (!mentioned && !quotedOurs) return
      }
    } else {
      const dmPolicy = policy.dm ?? 'all'
      if (dmPolicy === 'none') return
      if (dmPolicy === 'allowlist') {
        const allowFrom = policy.allow_from ?? []
        const bareNumber = senderJid.split('@')[0].split(':')[0]
        if (!allowFrom.includes(senderJid) && !allowFrom.includes(bareNumber)) return
      }
    }

    let text =
      content.conversation ??
      content.extendedTextMessage?.text ??
      content.imageMessage?.caption ??
      content.videoMessage?.caption ??
      content.documentMessage?.caption ??
      ''

    // Media
    const attachments: InboundMessage['attachments'] = []
    const maxAttachmentSize = config.limits?.max_attachment_size ?? 10_000_000
    const media =
      content.imageMessage ? { kind: 'image', mime: content.imageMessage.mimetype, size: content.imageMessage.fileLength, placeholder: '[Image]' } :
      content.videoMessage ? { kind: 'video', mime: content.videoMessage.mimetype, size: content.videoMessage.fileLength, placeholder: '[Video]' } :
      content.audioMessage ? { kind: 'audio', mime: content.audioMessage.mimetype, size: content.audioMessage.fileLength, placeholder: content.audioMessage.ptt ? '[Voice message]' : '[Audio]' } :
      content.documentMessage ? { kind: 'document', mime: content.documentMessage.mimetype, size: content.documentMessage.fileLength, placeholder: '[Document]' } :
      content.stickerMessage ? { kind: 'sticker', mime: content.stickerMessage.mimetype, size: content.stickerMessage.fileLength, placeholder: '[Sticker]' } :
      null

    if (media) {
      const size = Number(media.size ?? 0)
      if (!size || size <= maxAttachmentSize) {
        try {
          const buffer = (await downloadMediaMessage(msg, 'buffer', {})) as Buffer
          const ext = (media.mime ?? '').split('/')[1]?.split(';')[0] ?? 'bin'
          const baseName = content.documentMessage?.fileName ?? `${media.kind}_${msg.key.id}.${ext}`
          const importPath = `imported/whatsapp/${baseName}`
          this.ctx.writeAttachment(importPath, buffer, media.mime ?? undefined)
          attachments.push({
            path: importPath,
            filename: baseName,
            mimeType: media.mime ?? 'application/octet-stream',
            size: buffer.length
          })
        } catch (err) {
          this.ctx.log('warn', `Failed to download ${media.kind}: ${err instanceof Error ? err.message : err}`)
        }
      }
      if (!text) text = media.placeholder
    }

    if (!text && attachments.length === 0) return

    const senderName = msg.pushName ?? senderJid.split('@')[0]
    const sourceMeta: Record<string, unknown> = {
      chat_id: remoteJid,
      chat_type: isGroup ? 'group' : 'dm',
      message_id: msg.key.id,
      username: senderName,
      sender_jid: senderJid
    }
    if (contextInfo?.stanzaId) {
      sourceMeta.reply_to_message_id = contextInfo.stanzaId
    }

    // Keep the raw message for quoted replies
    if (msg.key.id) {
      this.quoteRing.set(msg.key.id, msg)
      if (this.quoteRing.size > MAX_QUOTE_RING) {
        const oldest = this.quoteRing.keys().next().value
        if (oldest) this.quoteRing.delete(oldest)
      }
    }

    // Group context (meta.group) — cached, never blocks ingest
    let meta: Record<string, unknown> | undefined
    if (isGroup) {
      const group = await this.groupMetaCache.getOrFetch(remoteJid, () => this.fetchGroupMeta(remoteJid))
      if (group) meta = { group }
    }

    const timestamp = typeof msg.messageTimestamp === 'number'
      ? msg.messageTimestamp * 1000
      : msg.messageTimestamp
        ? Number(msg.messageTimestamp) * 1000
        : undefined

    const inbound: InboundMessage = {
      sender: senderJid.split('@')[0].split(':')[0],
      senderName,
      payload: text,
      attachments: attachments.length > 0 ? attachments : undefined,
      sourceMeta,
      meta,
      originalMessage: JSON.stringify(msg),
      sentAt: timestamp
    }

    this.ctx.log('info', `Inbound from ${senderName} in ${isGroup ? 'group' : 'dm'} ${remoteJid}`)
    this.ctx.ingest(inbound)
  }

  private async fetchGroupMeta(jid: string): Promise<GroupMeta | null> {
    if (!this.sock) return null
    const metadata = await this.sock.groupMetadata(jid)
    return buildGroupMeta({
      platform: 'whatsapp',
      chatId: jid,
      chatType: 'group',
      title: metadata.subject,
      description: metadata.desc ?? undefined,
      participants: metadata.participants.map((p) => ({
        id: p.id,
        role: p.admin ?? 'member'
      })),
      participantCount: metadata.participants.length,
      participantsScope: 'all'
    })
  }

  /** Normalize a recipient id (bare number, number@server, or group jid) to a full JID */
  private normalizeJid(id: string): string {
    if (id.includes('@')) return id
    return `${id.replace(/[^\d]/g, '')}@s.whatsapp.net`
  }

  async send(msg: OutboundMessage): Promise<DeliveryResult> {
    if (!this.sock || this.currentStatus !== 'connected') {
      return { success: false, error: 'WhatsApp not connected' }
    }

    try {
      const jid = (msg.sourceMeta?.chat_id as string) ?? this.normalizeJid(msg.recipientId)
      const quotedId = msg.sourceMeta?.message_id as string | undefined
      const quoted = quotedId ? this.quoteRing.get(quotedId) : undefined
      const sendOpts = quoted ? { quoted } : undefined

      let lastId: string | undefined

      // Typed form content: WhatsApp has no reliable interactive components for
      // personal accounts — render as a numbered plain-text questionnaire.
      const form = msg.contentType === FORM_CONTENT_TYPE ? parseFormJson(msg.payload) : null
      const text = form ? renderFormAsText(form) : msg.payload || ''

      if (text || !msg.attachments?.length) {
        const result = await this.sock.sendMessage(
          jid,
          { text: markdownToWhatsApp(text) },
          sendOpts
        )
        lastId = result?.key?.id ?? undefined
        this.ctx?.log('info', `Sent text to ${jid}: id=${lastId}`)
      }

      if (msg.attachments?.length) {
        for (const att of msg.attachments) {
          if (!att.data) continue
          const caption = !lastId && msg.payload ? markdownToWhatsApp(msg.payload) : undefined
          let content: AnyMessageContent
          if (att.mimeType.startsWith('image/') && att.mimeType !== 'image/gif') {
            content = { image: att.data, caption }
          } else if (att.mimeType.startsWith('video/')) {
            content = { video: att.data, caption }
          } else if (att.mimeType.startsWith('audio/')) {
            let voiceData = att.data
            try {
              if (att.mimeType === 'audio/wav' || att.mimeType === 'audio/x-wav' || att.filename.endsWith('.wav')) {
                voiceData = await convertToOggOpus(att.data)
              }
              content = { audio: voiceData, ptt: true, mimetype: 'audio/ogg; codecs=opus' }
            } catch {
              // ffmpeg unavailable — fall back to a document
              content = { document: att.data, fileName: att.filename, mimetype: att.mimeType, caption }
            }
          } else {
            content = { document: att.data, fileName: att.filename, mimetype: att.mimeType, caption }
          }
          const result = await this.sock.sendMessage(jid, content, sendOpts)
          lastId = result?.key?.id ?? lastId
          this.ctx?.log('info', `Sent ${att.filename} to ${jid}: id=${result?.key?.id}`)
        }
      }

      return {
        success: true,
        sourceMeta: {
          chat_id: jid,
          message_id: lastId
        }
      }
    } catch (error) {
      const errorMsg = String(error instanceof Error ? error.message : error)
      this.ctx?.log('error', `Send failed: ${errorMsg}`)
      return { success: false, error: errorMsg }
    }
  }

  canDeliver(id: string): boolean {
    if (this.currentStatus !== 'connected') return false
    return /^\+?\d{5,}$/.test(id) || /@s\.whatsapp\.net$/.test(id) || /@g\.us$/.test(id)
  }

  status(): AdapterStatus {
    return this.currentStatus
  }

  async getChatInfo(chatId: string, opts?: { limit?: number }): Promise<ChatInfoResult> {
    if (!this.sock || this.currentStatus !== 'connected') {
      return { supported: false, reason: 'WhatsApp not connected' }
    }
    const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 100)
    const jid = this.normalizeJid(chatId)

    try {
      if (jid.endsWith('@g.us')) {
        const metadata = await this.sock.groupMetadata(jid)
        const all = metadata.participants.map((p) => ({ id: p.id, role: p.admin ?? 'member' }))
        return {
          supported: true,
          info: {
            platform: 'whatsapp',
            chat_id: jid,
            chat_type: 'group',
            title: metadata.subject,
            description: metadata.desc ?? undefined,
            participant_count: all.length,
            participants: all.slice(0, limit),
            participants_truncated: all.length > limit,
            participants_scope: 'all',
            fetched_at: Date.now()
          }
        }
      }

      // DM: WhatsApp exposes no profile lookup for arbitrary numbers beyond
      // registration checks — return the two participants we know about.
      return {
        supported: true,
        info: {
          platform: 'whatsapp',
          chat_id: jid,
          chat_type: 'dm',
          participant_count: 2,
          participants: [
            ...(this.selfJid ? [{ id: this.selfJid, role: 'self' }] : []),
            { id: jid }
          ],
          participants_truncated: false,
          participants_scope: 'all',
          fetched_at: Date.now()
        }
      }
    } catch (error) {
      return { supported: false, reason: String(error instanceof Error ? error.message : error) }
    }
  }
}
