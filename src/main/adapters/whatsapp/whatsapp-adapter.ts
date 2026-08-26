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
import { withSetupGuide } from '../shared/error-hints'
import { markdownToWhatsApp } from './wa-markdown'
import { resolveOutboundText } from '../form-render'
import { buildGroupMeta, GroupMetaCache } from '../group-meta'
import type { GroupMeta } from '../group-meta'
import { resolveCatchUpConfig } from '../../../shared/types/channel-adapter.types'
import type {
  ChannelAdapter,
  AdapterContext,
  AdapterStatus,
  OutboundMessage,
  DeliveryResult,
  InboundMessage,
  ChatInfoResult
} from '../../../shared/types/channel-adapter.types'

import { chmodSync } from 'node:fs'

const QR_PATH = 'imported/whatsapp/pairing-qr.png'
const MAX_QUOTE_RING = 500
const RECONNECT_BASE_MS = 2_000
const RECONNECT_MAX_MS = 60_000

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
 * SECURITY: Baileys' useMultiFileAuthState persists creds.json and the Signal
 * key files as CLEARTEXT JSON — unlike other adapter credentials, which are
 * encrypted in the identity keystore. Those files are equivalent to a fully
 * paired WhatsApp session: anyone who can read them can impersonate the
 * account without re-pairing. We restrict the auth directory to owner-only
 * (0700) as a mitigation, but the directory must be excluded from backups /
 * sync of the agent directory and treated as a live session credential.
 *
 * NOTE: Baileys is an unofficial client. WhatsApp may ban accounts that look
 * automated — use a non-critical account.
 */
export class WhatsAppAdapter implements ChannelAdapter {
  private sock: WASocket | null = null
  private ctx: AdapterContext | null = null
  private currentStatus: AdapterStatus = 'disconnected'
  private selfJid: string | null = null
  /** LID identity (<id>@lid) — WhatsApp's alternate self address used in LID-migrated groups */
  private selfLid: string | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private groupMetaCache = new GroupMetaCache()
  /** Recent inbound messages by id, kept for quoted replies */
  private quoteRing = new Map<string, WAMessage>()
  /** Auth/session directory, kept for actionable error messages */
  private authDir: string | null = null
  /** Rich explanation of a terminal close (logged out / banned / replaced) —
   * returned verbatim to the agent on subsequent send attempts */
  private terminalError: string | null = null

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
    this.authDir = authDir
    this.terminalError = null
    // The auth state below is CLEARTEXT (see class doc) — owner-only perms as
    // a mitigation. Best effort: no-op where the platform ignores modes.
    try { chmodSync(authDir, 0o700) } catch { /* ignore */ }
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

      // WhatsApp has finished replaying the messages queued while we were
      // offline (they arrive as 'append' upserts, handled below).
      if (update.receivedPendingNotifications) {
        this.ctx?.log('info', 'WhatsApp offline message queue flushed')
      }

      if (connection === 'open') {
        this.currentStatus = 'connected'
        this.reconnectAttempts = 0
        this.terminalError = null
        this.selfJid = sock.user?.id ? jidNormalizedUser(sock.user.id) : null
        this.selfLid = sock.user?.lid ? jidNormalizedUser(sock.user.lid) : null
        this.ctx?.log('info', `WhatsApp connected as ${this.selfJid ?? 'unknown'}${this.selfLid ? ` (lid ${this.selfLid})` : ''}`)
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode
        if (this.currentStatus === 'disconnected') {
          return // deliberate stop
        }
        const terminal = this.terminalCloseMessage(statusCode)
        if (terminal) {
          this.currentStatus = 'error'
          this.terminalError = terminal
          this.ctx?.log('error', terminal)
        } else {
          // Transient close — Baileys sockets are one-shot and never reconnect
          // on their own, so re-create the socket ourselves. Staying in
          // 'connecting' keeps the manager's finite restart budget out of the
          // steady-state reconnect loop (it remains the backstop for hard
          // start() failures).
          this.currentStatus = 'connecting'
          this.ctx?.log('warn', `WhatsApp connection closed (code ${statusCode ?? 'unknown'}) — reconnecting`)
          this.scheduleReconnect()
        }
      }
    })

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      // 'notify' = live delivery. 'append' = offline replay: WhatsApp queues
      // undelivered messages server-side (~30 days) and Baileys re-emits them
      // decrypted but stamped 'append' on reconnect; its event buffer can also
      // batch genuinely new messages under 'append' during that window. Dedup
      // via InboundMessage.messageId makes any overlap idempotent. Other batch
      // types stay dropped.
      if (type === 'append') {
        const catchUp = resolveCatchUpConfig(this.ctx?.getConfig().config)
        if (!catchUp.enabled) return
        await this.drainCatchUp(messages, catchUp)
        return
      }
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

  /**
   * Re-create the socket after a transient close (Baileys sockets never
   * reconnect themselves). Exponential backoff, reset on a successful 'open'.
   * A pending timer is deduplicated; stop() cancels it. If start() itself
   * throws, we flip to 'error' and leave recovery to the manager's health
   * check rather than looping internally on a hard failure.
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    const ctx = this.ctx
    if (!ctx) return
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempts, RECONNECT_MAX_MS)
    this.reconnectAttempts++
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      // Stopped (or restarted with a fresh context) while waiting — do nothing
      if (this.ctx !== ctx || this.currentStatus === 'disconnected') return
      this.start(ctx).catch((err) => {
        this.currentStatus = 'error'
        ctx.log('error', `WhatsApp reconnect failed: ${err instanceof Error ? err.message : err}`)
      })
    }, delay)
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

  /**
   * Shared re-pair recipe. Adapter error strings flow verbatim into the
   * agent's tool result — the agent reads them to walk the human through a
   * fix, so spell out every step.
   */
  private repairInstructions(): string {
    const dir = this.authDir
      ? `the WhatsApp session directory at ${this.authDir}`
      : `the adapter's WhatsApp session directory (the whatsapp folder inside <agent>.adf.adapters next to the agent's .adf file)`
    return (
      `To re-pair: delete ${dir} to clear the stale session, restart the adapter, ` +
      `then on the phone open WhatsApp > Settings > Linked Devices > Link a Device and scan the QR code ` +
      `written to ${QR_PATH} in the agent's files (the QR expires after ~60 seconds — restart the adapter for a fresh one).`
    )
  }

  /**
   * Map a terminal disconnect (one that reconnecting cannot fix) to a
   * plain-language explanation, or null for transient closes that should go
   * through the normal reconnect loop.
   */
  private terminalCloseMessage(statusCode: number | undefined): string | null {
    if (typeof statusCode !== 'number') return null
    switch (statusCode) {
      case DisconnectReason.loggedOut:
        return withSetupGuide(
          'whatsapp',
          `This WhatsApp account has been logged out (unpaired) — the session is no longer valid ` +
            `(it may have been removed under Linked Devices on the phone, or invalidated by WhatsApp). ` +
            `No messages can be sent or received until it is re-paired. ${this.repairInstructions()}`
        )
      case DisconnectReason.forbidden:
        return withSetupGuide(
          'whatsapp',
          `WhatsApp refused the connection (403 forbidden) — the account appears to be blocked or restricted. ` +
            `WhatsApp may restrict accounts that look automated (this adapter uses an unofficial client), ` +
            `which is why the setup guide recommends pairing a non-critical account. ` +
            `Check whether the account still works in the WhatsApp app on the phone; if it does, re-pair from scratch. ${this.repairInstructions()}`
        )
      case DisconnectReason.multideviceMismatch:
        return withSetupGuide(
          'whatsapp',
          `WhatsApp closed the connection with a multi-device mismatch (411) — the stored session no longer matches ` +
            `the account's device state (often after WhatsApp was reinstalled or the phone changed). ${this.repairInstructions()}`
        )
      case DisconnectReason.connectionReplaced:
        return withSetupGuide(
          'whatsapp',
          `Another client took over this WhatsApp session (connection replaced, 440) — a second WhatsApp Web / Baileys ` +
            `client signed in with the same account, and only one such session can be active at a time. ` +
            `Close the other client (or stop the duplicate adapter), then restart this adapter to reconnect.`
        )
      default:
        return null
    }
  }

  /**
   * Rich not-connected explanation for send()/getChatInfo(). Prefers the
   * stored terminal-close message (logged out / banned / replaced) when the
   * session died for a known reason.
   */
  private notConnectedError(): string {
    if (this.terminalError) return this.terminalError
    return withSetupGuide(
      'whatsapp',
      `The WhatsApp session is not connected (status: ${this.currentStatus}). ` +
        `If this account has never been paired: on the phone open WhatsApp > Settings > Linked Devices > Link a Device ` +
        `and scan the QR code written to ${QR_PATH} in the agent's files (the QR expires after ~60 seconds — restart the ` +
        `adapter for a fresh one). If it was paired before, the adapter may still be reconnecting — retry in a few ` +
        `seconds, and restart the adapter if it stays disconnected. If pairing repeatedly fails, delete ` +
        `${this.authDir ?? "the adapter's WhatsApp session directory (next to the agent's .adf file)"} and restart the ` +
        `adapter to force a clean re-pair.`
    )
  }

  /**
   * Translate a Baileys/Boom error into an actionable message. Terminal
   * session errors reuse the close-handler wording (minus the guide link,
   * which callers append once per result).
   */
  private describeWaError(err: unknown): string {
    const raw = String(err instanceof Error ? err.message : err)
    const statusCode = (err as { output?: { statusCode?: number } } | null)?.output?.statusCode
    if (typeof statusCode === 'number') {
      switch (statusCode) {
        case DisconnectReason.loggedOut:
          return `the WhatsApp session was logged out (unpaired) mid-operation. ${this.repairInstructions()}`
        case DisconnectReason.forbidden:
          return (
            `WhatsApp refused the request (403 forbidden) — the account appears blocked or restricted. ` +
            `WhatsApp may restrict accounts that look automated; verify the account in the WhatsApp app on the phone, ` +
            `and consider pairing a non-critical account. ${this.repairInstructions()}`
          )
        case DisconnectReason.multideviceMismatch:
          return `WhatsApp reported a multi-device mismatch (411) — the stored session no longer matches the account's device state. ${this.repairInstructions()}`
        case DisconnectReason.connectionReplaced:
          return (
            `another client took over this WhatsApp session (connection replaced) — close the other WhatsApp Web / ` +
            `Baileys client using this account, then restart this adapter.`
          )
        case DisconnectReason.connectionClosed:
        case DisconnectReason.connectionLost:
          return `the WhatsApp connection dropped mid-operation (${raw}). The adapter reconnects automatically — wait a few seconds and retry.`
        case DisconnectReason.unavailableService:
          return `WhatsApp's servers are temporarily unavailable (503): ${raw}. This is on WhatsApp's side — retry in a few minutes.`
      }
    }
    if (/media upload|failed to upload|upload failed/i.test(raw)) {
      return (
        `WhatsApp rejected the media upload (${raw}). This is usually a transient server/network issue — retry in a ` +
        `moment. Very large files can also be refused; try a smaller file if retries keep failing.`
      )
    }
    if (/timed?[ -]?out/i.test(raw)) {
      return `the request to WhatsApp timed out (${raw}). The adapter reconnects automatically — wait a few seconds and retry.`
    }
    return raw
  }

  /** True when the jid is a shape sendMessage can actually deliver to */
  private isSendableJid(jid: string): boolean {
    return (
      /^\d{5,}@s\.whatsapp\.net$/.test(jid) ||
      /^[\d-]+@g\.us$/.test(jid) ||
      /^\d+(:\d+)?@lid$/.test(jid)
    )
  }

  private invalidRecipientError(recipientId: string): string {
    return withSetupGuide(
      'whatsapp',
      `"${recipientId}" is not a valid WhatsApp recipient — nothing was sent. Expected formats: a phone number in ` +
        `international format with country code and no symbols (recipient "whatsapp:15551234567" or bare ` +
        `"15551234567"), a full user JID ("15551234567@s.whatsapp.net"), or a group JID ("120363041234567890@g.us"). ` +
        `Group ids come from the chat_id of an inbound group message — a phone number cannot address a group. ` +
        `Check for typos and a missing country code.`
    )
  }

  async stop(): Promise<void> {
    this.currentStatus = 'disconnected'
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.reconnectAttempts = 0
    this.terminalError = null
    if (this.sock) {
      try { this.sock.end(undefined) } catch { /* ignore */ }
      this.sock = null
    }
    this.ctx = null
    this.selfJid = null
    this.selfLid = null
    this.quoteRing.clear()
    this.groupMetaCache.clear()
  }

  /** True when jid is this account under either its phone (@s.whatsapp.net)
   * or LID (@lid) identity — LID-migrated groups address us by the latter. */
  private isSelfJid(jid: string): boolean {
    const normalized = jidNormalizedUser(jid)
    return (
      (this.selfJid !== null && normalized === this.selfJid) ||
      (this.selfLid !== null && normalized === this.selfLid)
    )
  }

  /** messageTimestamp (epoch seconds, number or Long) → epoch millis */
  private messageMillis(ts: WAMessage['messageTimestamp']): number | undefined {
    if (typeof ts === 'number') return ts * 1000
    return ts ? Number(ts) * 1000 : undefined
  }

  /**
   * Process an offline-replay ('append') batch through the normal inbound
   * path, bounded by the catch-up caps. Runs inside a catch-up phase so the
   * host buffers trigger notifications and wakes the agent once at the end.
   * Offline call placeholders also arrive as 'append' but carry no
   * msg.message and fall out of handleMessage's guards.
   */
  private async drainCatchUp(
    messages: WAMessage[],
    caps: { max_age_hours: number; max_messages: number }
  ): Promise<void> {
    const ctx = this.ctx
    if (!ctx) return
    const cutoff = Date.now() - caps.max_age_hours * 3_600_000
    ctx.beginCatchUp?.()
    try {
      let processed = 0
      let tooOld = 0
      let overflow = 0
      for (const msg of messages) {
        const ts = this.messageMillis(msg.messageTimestamp)
        if (ts !== undefined && ts < cutoff) {
          tooOld++
          continue
        }
        if (processed >= caps.max_messages) {
          overflow++
          continue
        }
        processed++
        try {
          await this.handleMessage(msg)
        } catch (err) {
          ctx.log('warn', `Catch-up handling failed: ${err instanceof Error ? err.message : err}`)
        }
      }
      if (overflow > 0 || tooOld > 0) {
        const parts: string[] = []
        if (overflow > 0) parts.push(`capped at ${caps.max_messages} messages (${overflow} dropped)`)
        if (tooOld > 0) parts.push(`${tooOld} older message(s) skipped (max_age_hours ${caps.max_age_hours})`)
        ctx.log('info', `WhatsApp catch-up ${parts.join('; ')}`)
      }
    } finally {
      ctx.endCatchUp?.()
    }
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
        const mentioned = (contextInfo?.mentionedJid ?? []).some((jid) => this.isSelfJid(jid))
        const quotedOurs = contextInfo?.participant
          ? this.isSelfJid(contextInfo.participant)
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
          // Never drop the message over media: it is still ingested below with
          // the placeholder text and no attachment.
          this.ctx.log(
            'warn',
            `Failed to download inbound ${media.kind} from ${remoteJid}: ${this.describeWaError(err)}. ` +
              `The message was still delivered to the inbox with a "${media.placeholder}" placeholder and no attachment. ` +
              `WhatsApp media expires from its servers after a while — if the file is needed, ask the sender to re-send it.`
          )
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

    const timestamp = this.messageMillis(msg.messageTimestamp)

    const inbound: InboundMessage = {
      sender: senderJid.split('@')[0].split(':')[0],
      senderName,
      // Stable per-message id so replayed offline batches dedup against rows
      // already ingested live (WA ids are only unique per chat — scope by jid)
      messageId: msg.key.id ? `${remoteJid}:${msg.key.id}` : undefined,
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

  /** Fetch a group's metadata mapped to the shared participant shape —
   * shared by fetchGroupMeta and getChatInfo. */
  private async fetchGroupSnapshot(jid: string): Promise<{
    title?: string
    description?: string
    participants: GroupMeta['participants']
  } | null> {
    if (!this.sock) return null
    const metadata = await this.sock.groupMetadata(jid)
    return {
      title: metadata.subject,
      description: metadata.desc ?? undefined,
      participants: metadata.participants.map((p) => ({
        id: p.id,
        role: p.admin ?? 'member'
      }))
    }
  }

  private async fetchGroupMeta(jid: string): Promise<GroupMeta | null> {
    const snapshot = await this.fetchGroupSnapshot(jid)
    if (!snapshot) return null
    return buildGroupMeta({
      platform: 'whatsapp',
      chatId: jid,
      chatType: 'group',
      title: snapshot.title,
      description: snapshot.description,
      participants: snapshot.participants,
      participantCount: snapshot.participants.length,
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
      return { success: false, error: this.notConnectedError() }
    }

    const chatId = msg.sourceMeta?.chat_id as string | undefined
    const jid = chatId ?? this.normalizeJid(msg.recipientId)
    // chat_id values came from a real inbound message and may use jid shapes
    // we don't enumerate — only validate what we derived from recipientId.
    if (!chatId && !this.isSendableJid(jid)) {
      return { success: false, error: this.invalidRecipientError(msg.recipientId) }
    }

    const quotedId = msg.sourceMeta?.message_id as string | undefined
    const quoted = quotedId ? this.quoteRing.get(quotedId) : undefined
    const sendOpts = quoted ? { quoted } : undefined

    let lastId: string | undefined
    let textId: string | undefined

    // Typed form content: WhatsApp has no reliable interactive components for
    // personal accounts — render as a numbered plain-text questionnaire.
    // HTML content converts to readable text.
    const { text, isHtml } = resolveOutboundText(msg)

    if (text || !msg.attachments?.length) {
      try {
        const result = await this.sock.sendMessage(
          jid,
          { text: isHtml ? text : markdownToWhatsApp(text) },
          sendOpts
        )
        textId = result?.key?.id ?? undefined
        lastId = textId
        this.ctx?.log('info', `Sent text to ${jid}: id=${lastId}`)
      } catch (error) {
        const reason = this.describeWaError(error)
        this.ctx?.log('error', `Send failed: ${reason}`)
        const suffix = msg.attachments?.length
          ? ` The ${msg.attachments.length} attachment(s) were not sent either.`
          : ''
        return {
          success: false,
          error: withSetupGuide('whatsapp', `Sending the text message to ${jid} failed: ${reason}${suffix}`)
        }
      }
    }

    // WhatsApp delivers each attachment as its own message — send them
    // individually so one failure neither aborts the rest nor masks what
    // already went out.
    const deliveredNames: string[] = []
    const failures: string[] = []
    const degraded: string[] = []
    if (msg.attachments?.length) {
      for (const att of msg.attachments) {
        if (!att.data) continue
        const caption = !lastId && msg.payload ? markdownToWhatsApp(msg.payload) : undefined
        let content: AnyMessageContent
        let degradation: string | null = null
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
          } catch (convErr) {
            // ffmpeg unavailable — fall back to a document, and tell the agent
            // truthfully that the file went out, just not as a voice note.
            content = { document: att.data, fileName: att.filename, mimetype: att.mimeType, caption }
            degradation =
              `"${att.filename}": sent as a plain document, not a playable voice note — converting WAV audio to ` +
              `WhatsApp's voice-note format (OGG/Opus) requires ffmpeg on PATH ` +
              `(${convErr instanceof Error ? convErr.message : convErr}). Install ffmpeg (e.g. "brew install ffmpeg" ` +
              `on macOS) and re-send only if a playable voice note is required.`
          }
        } else {
          content = { document: att.data, fileName: att.filename, mimetype: att.mimeType, caption }
        }
        try {
          const result = await this.sock.sendMessage(jid, content, sendOpts)
          lastId = result?.key?.id ?? lastId
          this.ctx?.log('info', `Sent ${att.filename} to ${jid}: id=${result?.key?.id}`)
          if (degradation) degraded.push(degradation)
          else deliveredNames.push(att.filename)
        } catch (err) {
          const reason = this.describeWaError(err)
          this.ctx?.log('error', `Attachment send failed for "${att.filename}": ${reason}`)
          failures.push(`"${att.filename}": ${reason}`)
        }
      }
    }

    const sourceMeta = { chat_id: jid, message_id: lastId }

    if (failures.length > 0 || degraded.length > 0) {
      const problems: string[] = []
      if (failures.length > 0) problems.push(`${failures.length} attachment(s) failed to send — ${failures.join('; ')}`)
      if (degraded.length > 0) problems.push(`${degraded.length} attachment(s) were delivered in degraded form — ${degraded.join('; ')}`)
      // Partial success: tell the agent what DID go out so it doesn't re-send
      // the delivered parts while chasing the failure.
      const delivered: string[] = []
      if (textId) delivered.push(`Text message was delivered to ${jid} (id=${textId})`)
      if (deliveredNames.length > 0) delivered.push(`${deliveredNames.length} attachment(s) were delivered (${deliveredNames.join(', ')})`)
      const error =
        delivered.length > 0
          ? `${delivered.join(', and ')}, but ${problems.join('; and ')}. Do not re-send the parts that were already delivered.`
          : failures.length > 0
            ? `Nothing was delivered to ${jid}: ${problems.join('; and ')}.`
            : `Delivery to ${jid} completed with caveats: ${problems.join('; and ')}.`
      return {
        success: false,
        error: withSetupGuide('whatsapp', error),
        ...(lastId !== undefined ? { sourceMeta } : {})
      }
    }

    return { success: true, sourceMeta }
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
      return { supported: false, reason: this.notConnectedError() }
    }
    const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 100)
    const jid = this.normalizeJid(chatId)

    try {
      if (jid.endsWith('@g.us')) {
        const snapshot = await this.fetchGroupSnapshot(jid)
        if (!snapshot) return { supported: false, reason: this.notConnectedError() }
        const all = snapshot.participants
        return {
          supported: true,
          info: {
            platform: 'whatsapp',
            chat_id: jid,
            chat_type: 'group',
            title: snapshot.title,
            description: snapshot.description,
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
      return { supported: false, reason: withSetupGuide('whatsapp', this.describeWaError(error)) }
    }
  }
}
