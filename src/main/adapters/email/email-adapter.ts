import { ImapFlow, FetchMessageObject } from 'imapflow'
import nodemailer from 'nodemailer'
import type { Transporter } from 'nodemailer'
import { simpleParser } from 'mailparser'
import { convert } from 'html-to-text'
import { marked } from 'marked'
import type {
  ChannelAdapter,
  AdapterContext,
  AdapterStatus,
  OutboundMessage,
  DeliveryResult,
  InboundMessage
} from '../../../shared/types/channel-adapter.types'

interface EmailConfig {
  address: string
  imap: { host: string; port: number }
  smtp: { host: string; port: number }
  poll_interval: number
  idle: boolean
  folders: string[]
}

interface ProviderSettings {
  imap: { host: string; port: number }
  smtp: { host: string; port: number }
}

/** Well-known provider IMAP/SMTP settings, keyed by email domain. */
const PROVIDER_MAP: Record<string, ProviderSettings> = {
  'gmail.com':        { imap: { host: 'imap.gmail.com',        port: 993 }, smtp: { host: 'smtp.gmail.com',        port: 465 } },
  'googlemail.com':   { imap: { host: 'imap.gmail.com',        port: 993 }, smtp: { host: 'smtp.gmail.com',        port: 465 } },
  'icloud.com':       { imap: { host: 'imap.mail.me.com',      port: 993 }, smtp: { host: 'smtp.mail.me.com',      port: 587 } },
  'me.com':           { imap: { host: 'imap.mail.me.com',      port: 993 }, smtp: { host: 'smtp.mail.me.com',      port: 587 } },
  'mac.com':          { imap: { host: 'imap.mail.me.com',      port: 993 }, smtp: { host: 'smtp.mail.me.com',      port: 587 } },
  'outlook.com':      { imap: { host: 'outlook.office365.com', port: 993 }, smtp: { host: 'smtp.office365.com',    port: 587 } },
  'hotmail.com':      { imap: { host: 'outlook.office365.com', port: 993 }, smtp: { host: 'smtp.office365.com',    port: 587 } },
  'live.com':         { imap: { host: 'outlook.office365.com', port: 993 }, smtp: { host: 'smtp.office365.com',    port: 587 } },
  'fastmail.com':     { imap: { host: 'imap.fastmail.com',     port: 993 }, smtp: { host: 'smtp.fastmail.com',     port: 465 } },
  'fastmail.fm':      { imap: { host: 'imap.fastmail.com',     port: 993 }, smtp: { host: 'smtp.fastmail.com',     port: 465 } },
  'yahoo.com':        { imap: { host: 'imap.mail.yahoo.com',   port: 993 }, smtp: { host: 'smtp.mail.yahoo.com',   port: 465 } },
}

/**
 * Resolve IMAP/SMTP settings from the email domain.
 * Falls back to imap.{domain}:993 / smtp.{domain}:465 for unknown providers.
 */
function resolveProvider(email: string): ProviderSettings {
  const domain = email.split('@')[1]?.toLowerCase()
  if (!domain) throw new Error(`Invalid email address: ${email}`)

  if (PROVIDER_MAP[domain]) return PROVIDER_MAP[domain]

  // Reasonable default for self-hosted / unknown providers
  return {
    imap: { host: `imap.${domain}`, port: 993 },
    smtp: { host: `smtp.${domain}`, port: 465 }
  }
}

/**
 * Email adapter using IMAP (inbound) and SMTP (outbound).
 *
 * Supports two inbound modes:
 * - IDLE: server pushes notifications on new mail (preferred)
 * - Polling: check for unseen messages on an interval
 *
 * Provider IMAP/SMTP settings are auto-detected from the email domain
 * for well-known providers (Gmail, iCloud, Outlook, Fastmail, Yahoo).
 * Custom settings can be supplied via the adapter config object.
 */
export class EmailAdapter implements ChannelAdapter {
  private client: ImapFlow | null = null
  private transporter: Transporter | null = null
  private ctx: AdapterContext | null = null
  private currentStatus: AdapterStatus = 'disconnected'
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private idleAborted = false
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private emailConfig: EmailConfig | null = null
  private credentials: { username: string; password: string } | null = null

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx
    this.currentStatus = 'connecting'

    // Read credentials as separate keys
    const username = ctx.getCredential('EMAIL_USERNAME')
    const password = ctx.getCredential('EMAIL_PASSWORD')
    if (!username || !password) {
      this.currentStatus = 'error'
      throw new Error('Missing EMAIL_USERNAME and/or EMAIL_PASSWORD credentials')
    }
    this.credentials = { username, password }

    // Resolve email config — auto-detect provider from username, allow overrides
    const instanceConfig = ctx.getConfig()
    const rawConfig = (instanceConfig.config ?? {}) as Record<string, unknown>
    const address = (rawConfig.address as string) ?? username
    const provider = resolveProvider(address)

    this.emailConfig = {
      address,
      imap: (rawConfig.imap as { host: string; port: number }) ?? provider.imap,
      smtp: (rawConfig.smtp as { host: string; port: number }) ?? provider.smtp,
      poll_interval: (rawConfig.poll_interval as number) ?? 30000,
      idle: (rawConfig.idle as boolean) ?? true,
      folders: (rawConfig.folders as string[]) ?? ['INBOX']
    }

    ctx.log('info', `Resolved provider: IMAP ${this.emailConfig.imap.host}:${this.emailConfig.imap.port}, SMTP ${this.emailConfig.smtp.host}:${this.emailConfig.smtp.port}`)

    // Create IMAP client with protocol logging forwarded to adapter log
    const adapterLog = (level: 'info' | 'warn' | 'error', msg: string) => this.ctx?.log(level, msg)
    this.client = new ImapFlow({
      host: this.emailConfig.imap.host,
      port: this.emailConfig.imap.port,
      secure: true,
      auth: { user: this.credentials.username, pass: this.credentials.password },
      logger: {
        debug: () => {},
        info: (obj: any) => { if (obj?.msg) adapterLog('info', `IMAP: ${obj.msg}`) },
        warn: (obj: any) => { if (obj?.msg) adapterLog('warn', `IMAP: ${obj.msg}`) },
        error: (obj: any) => { if (obj?.msg) adapterLog('error', `IMAP: ${obj.msg}`) }
      } as any
    })

    // Handle IMAP errors — without this handler, socket timeouts and other
    // errors crash the process as uncaught exceptions.
    this.client.on('error', (err: Error) => {
      if (this.currentStatus !== 'disconnected') {
        this.ctx?.log('error', `IMAP error: ${err.message}`)
        this.currentStatus = 'error'
        this.scheduleReconnect()
      }
    })

    // Handle IMAP close for reconnection
    this.client.on('close', () => {
      if (this.currentStatus !== 'disconnected') {
        this.ctx?.log('warn', 'IMAP connection closed unexpectedly')
        this.currentStatus = 'error'
        this.scheduleReconnect()
      }
    })

    // Create SMTP transporter (reused for all sends)
    this.transporter = nodemailer.createTransport({
      host: this.emailConfig.smtp.host,
      port: this.emailConfig.smtp.port,
      secure: this.emailConfig.smtp.port === 465,
      auth: { user: this.credentials.username, pass: this.credentials.password }
    })

    // Connect IMAP
    try {
      ctx.log('info', `Connecting to IMAP ${this.emailConfig.imap.host}:${this.emailConfig.imap.port} as ${this.credentials.username}...`)
      await this.client.connect()
    } catch (err: any) {
      this.currentStatus = 'error'
      // imapflow errors carry the server response in .responseText or .response
      const parts = [
        err?.message,
        err?.responseText && `Server: ${err.responseText}`,
        err?.response && !err?.responseText && `Response: ${err.response}`,
        err?.code && `Code: ${err.code}`
      ].filter(Boolean)
      const detail = parts.join(' — ') || String(err)
      ctx.log('error', `IMAP connect failed: ${detail}`)
      throw new Error(`IMAP connect failed: ${detail}`)
    }

    this.currentStatus = 'connected'
    this.reconnectAttempts = 0
    ctx.log('info', `Email connected: ${this.emailConfig.address}`)

    // Verify SMTP credentials eagerly so we fail fast
    try {
      ctx.log('info', `Verifying SMTP ${this.emailConfig.smtp.host}:${this.emailConfig.smtp.port}...`)
      await this.transporter.verify()
      ctx.log('info', 'SMTP verified')
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      ctx.log('warn', `SMTP verify failed (sends may fail): ${detail}`)
      // Don't throw — IMAP inbound still works; SMTP errors will surface on send
    }

    // Start inbound processing
    if (this.emailConfig.idle) {
      this.startIdle()
    } else {
      this.pollTimer = setInterval(() => this.pollInbox(), this.emailConfig.poll_interval!)
      // Fetch unseen immediately on start
      this.pollInbox()
    }
  }

  async stop(): Promise<void> {
    this.currentStatus = 'disconnected'
    this.idleAborted = true

    // Release the IDLE hold so runIdle() can clean up
    if (this.idleResolve) {
      this.idleResolve()
      this.idleResolve = null
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }

    if (this.client) {
      try {
        // close() force-kills the TCP socket, breaking any active IDLE.
        // logout() would hang waiting for IDLE to finish first.
        this.client.close()
      } catch { /* ignore */ }
      this.client = null
    }

    if (this.transporter) {
      this.transporter.close()
      this.transporter = null
    }

    this.ctx = null
    this.credentials = null
    this.emailConfig = null
  }

  async send(msg: OutboundMessage): Promise<DeliveryResult> {
    if (!this.transporter || !this.emailConfig) {
      return { success: false, error: 'Email adapter not connected' }
    }

    try {
      const mailOptions: nodemailer.SendMailOptions = {
        from: this.emailConfig.address,
        to: msg.recipientId
      }

      // Subject — from outbound message, or construct for replies
      if (msg.subject) {
        mailOptions.subject = msg.subject
      } else {
        mailOptions.subject = 'Message from your agent'
      }

      // Threading headers for replies
      if (msg.sourceMeta?.message_id) {
        mailOptions.inReplyTo = msg.sourceMeta.message_id as string
        const refs = (msg.sourceMeta.references as string[]) ?? []
        mailOptions.references = [...refs, msg.sourceMeta.message_id as string].filter(Boolean)

        // Ensure Re: prefix on subject for replies
        if (mailOptions.subject && !mailOptions.subject.startsWith('Re:')) {
          mailOptions.subject = `Re: ${mailOptions.subject}`
        }
      }

      // CC/BCC from routing hints (kept separate from sourceMeta to avoid collisions)
      const hints = msg.routingHints ?? {}
      if (hints.reply_all && msg.sourceMeta) {
        // Reply-all: re-add original recipients as CC (minus self and primary recipient)
        const origTo = (msg.sourceMeta.to as string[]) ?? []
        const origCc = (msg.sourceMeta.cc as string[]) ?? []
        const exclude = new Set([this.emailConfig.address.toLowerCase(), msg.recipientId.toLowerCase()])
        const replyAllCc = [...origTo, ...origCc].filter(a => !exclude.has(a.toLowerCase()))
        if (replyAllCc.length) mailOptions.cc = replyAllCc
      }
      if (Array.isArray(hints.cc)) {
        // Explicit CC — append to any reply-all CC
        const existing = Array.isArray(mailOptions.cc) ? mailOptions.cc as string[] : []
        mailOptions.cc = [...new Set([...existing, ...(hints.cc as string[])])]
      }
      if (Array.isArray(hints.bcc)) {
        mailOptions.bcc = hints.bcc as string[]
      }

      // Body — send both plain text and HTML (Markdown auto-converted)
      mailOptions.text = msg.payload
      mailOptions.html = await marked(msg.payload)

      // Attachments
      if (msg.attachments?.length) {
        mailOptions.attachments = msg.attachments.map(att => ({
          filename: att.filename,
          content: att.data,
          contentType: att.mimeType
        }))
      }

      const info = await this.transporter.sendMail(mailOptions)
      this.ctx?.log('info', `Sent email to ${msg.recipientId}: ${info.messageId}`)

      return {
        success: true,
        sourceMeta: {
          message_id: info.messageId
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
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

  // ---------------------------------------------------------------------------
  // IMAP Inbound
  // ---------------------------------------------------------------------------

  private idleLock: { release: () => void } | null = null
  private idleResolve: (() => void) | null = null

  private async startIdle(): Promise<void> {
    this.idleAborted = false
    // Run IDLE in background — don't block start()
    this.runIdle().catch(err => {
      if (this.currentStatus !== 'disconnected') {
        this.ctx?.log('error', `IDLE error: ${err instanceof Error ? err.message : err}`)
        this.currentStatus = 'error'
        this.scheduleReconnect()
      }
    })
  }

  private async runIdle(): Promise<void> {
    if (!this.client || this.idleAborted) return

    // Register exists handler BEFORE opening the mailbox
    this.client.on('exists', async (data: { path: string; count: number; prevCount: number }) => {
      if (this.idleAborted || !this.client) return
      this.ctx?.log('info', `New message notification: ${data.count} total (was ${data.prevCount})`)
      try {
        await this.fetchUnseen()
      } catch (err) {
        this.ctx?.log('warn', `Error fetching new messages: ${err instanceof Error ? err.message : err}`)
      }
    })

    this.idleLock = await this.client.getMailboxLock('INBOX')
    try {
      // Fetch any unseen messages on initial connect
      await this.fetchUnseen()

      this.ctx?.log('info', 'Listening for new messages (IDLE)')

      // Polling safety net — some servers (including Gmail) can miss IDLE
      // notifications. Check every 60s as a fallback.
      this.pollTimer = setInterval(async () => {
        if (this.idleAborted || !this.client) return
        try {
          await this.fetchUnseen()
        } catch (err) {
          this.ctx?.log('warn', `Poll fallback error: ${err instanceof Error ? err.message : err}`)
        }
      }, 60000)

      // Hold the lock open until stop() is called
      await new Promise<void>(resolve => {
        this.idleResolve = resolve
      })
    } finally {
      if (this.pollTimer) {
        clearInterval(this.pollTimer)
        this.pollTimer = null
      }
      this.idleLock?.release()
      this.idleLock = null
    }
  }

  private async pollInbox(): Promise<void> {
    if (!this.client || this.currentStatus !== 'connected') return

    let lock
    try {
      lock = await this.client.getMailboxLock('INBOX')
      await this.fetchUnseen()
    } catch (err) {
      this.ctx?.log('warn', `Poll error: ${err instanceof Error ? err.message : err}`)
    } finally {
      lock?.release()
    }
  }

  private async fetchUnseen(): Promise<void> {
    if (!this.client || !this.ctx) return

    const config = this.ctx.getConfig()
    const policy = config.policy ?? {}
    const limits = config.limits ?? {}
    const maxAttachmentSize = limits.max_attachment_size ?? 26_214_400 // 25MB default

    // Collect all unseen messages first — interleaving STORE commands inside
    // an active FETCH stream can block the IMAP pipeline.
    const collected: FetchMessageObject[] = []
    try {
      for await (const msg of this.client.fetch({ seen: false }, {
        envelope: true,
        source: true,
        bodyStructure: true,
        uid: true
      })) {
        collected.push(msg)
      }
    } catch (err) {
      // fetch throws if no messages match — that's fine
      if (!(err instanceof Error && err.message.includes('Nothing to fetch'))) {
        throw err
      }
    }

    if (collected.length === 0) return
    this.ctx.log('info', `Found ${collected.length} unseen message(s)`)

    // Process each message, then mark as seen
    const processedUids: number[] = []
    for (const msg of collected) {
      try {
        await this.processMessage(msg, policy, maxAttachmentSize)
        processedUids.push(msg.uid)
      } catch (err: any) {
        const stack = err?.stack ?? String(err)
        this.ctx?.log('error', `Error processing message UID ${msg.uid}: ${stack}`)
      }
    }

    // Mark all processed messages as seen in one batch
    if (processedUids.length > 0 && this.client) {
      try {
        const uidRange = processedUids.join(',')
        await this.client.messageFlagsAdd(uidRange, ['\\Seen'], { uid: true })
        this.ctx?.log('info', `Marked ${processedUids.length} message(s) as seen`)
      } catch (err) {
        this.ctx?.log('warn', `Failed to mark messages as seen: ${err instanceof Error ? err.message : err}`)
      }
    }
  }

  private async processMessage(
    msg: FetchMessageObject,
    policy: { dm?: string; allow_from?: string[] },
    maxAttachmentSize: number
  ): Promise<void> {
    if (!this.ctx) return

    const parsed = await simpleParser(msg.source)

    const senderAddress = parsed.from?.value?.[0]?.address
    if (!senderAddress) return

    // Policy check — email is always DM (no group concept)
    const dmPolicy = policy.dm ?? 'all'
    if (dmPolicy === 'none') return
    if (dmPolicy === 'allowlist') {
      const allowFrom = policy.allow_from ?? []
      if (!allowFrom.includes(senderAddress)) return
    }

    // Extract body — prefer plain text, fall back to stripped HTML
    const content = parsed.text
      || (parsed.html ? convert(parsed.html, { wordwrap: false }) : '')

    if (!content && (!parsed.attachments || parsed.attachments.length === 0)) return

    // Download attachments
    const attachments: InboundMessage['attachments'] = []
    const safeSender = senderAddress.replace(/[^a-zA-Z0-9@._-]/g, '_')

    for (const att of parsed.attachments || []) {
      if (att.size > maxAttachmentSize) {
        attachments.push({
          path: '',
          filename: att.filename || 'unnamed',
          mimeType: att.contentType,
          size: att.size
        })
        this.ctx.log('warn', `Skipped oversized attachment "${att.filename}" (${att.size} bytes)`)
        continue
      }

      const filename = att.filename || `attachment_${Date.now()}`
      const importPath = `imported/email_${safeSender}/${filename}`
      this.ctx.writeAttachment(importPath, att.content, att.contentType)
      attachments.push({
        path: importPath,
        filename,
        mimeType: att.contentType,
        size: att.size
      })
    }

    // Threading — first Reference is thread root
    const references = Array.isArray(parsed.references)
      ? parsed.references
      : parsed.references
        ? [parsed.references]
        : []
    const threadRoot = references.length > 0 ? references[0] : parsed.messageId

    const inbound: InboundMessage = {
      sender: senderAddress,
      senderName: parsed.from?.value?.[0]?.name || undefined,
      traceId: threadRoot ? `email:${threadRoot}` : undefined,
      parentId: parsed.inReplyTo || undefined,
      subject: parsed.subject || undefined,
      messageId: parsed.messageId || undefined,
      returnPath: (() => {
        const rp = parsed.headers?.get('return-path')
        if (!rp) return undefined
        if (typeof rp === 'string') return rp
        // mailparser returns AddressObject for address headers
        if (typeof rp === 'object' && 'value' in rp) {
          const addr = (rp as any).value?.[0]?.address
          return addr || undefined
        }
        return String(rp)
      })(),
      payload: content,
      attachments: attachments.length > 0 ? attachments : undefined,
      sourceMeta: {
        message_id: parsed.messageId,
        to: parsed.to?.value?.map(v => v.address).filter(Boolean) || [],
        cc: parsed.cc?.value?.map(v => v.address).filter(Boolean) || [],
        in_reply_to: parsed.inReplyTo,
        references
      },
      originalMessage: msg.source.toString('utf-8'),
      sentAt: parsed.date ? parsed.date.getTime() : undefined
    }

    this.ctx.log('info', `Inbound from ${senderAddress}: "${parsed.subject || '(no subject)'}"`)
    this.ctx.ingest(inbound)
  }

  // ---------------------------------------------------------------------------
  // Reconnection
  // ---------------------------------------------------------------------------

  private scheduleReconnect(): void {
    if (this.currentStatus === 'disconnected') return
    if (this.reconnectAttempts >= 5) {
      this.ctx?.log('error', 'Max reconnect attempts reached — giving up')
      this.currentStatus = 'error'
      return
    }

    const delay = Math.min(5000 * Math.pow(2, this.reconnectAttempts), 60000)
    this.reconnectAttempts++
    this.ctx?.log('info', `Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts}/5)`)

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null
      if (this.currentStatus === 'disconnected') return

      try {
        // Clean up old client
        if (this.client) {
          try { this.client.close() } catch { /* ignore */ }
          this.client = null
        }

        if (!this.credentials || !this.emailConfig) return

        // Create fresh IMAP client
        this.client = new ImapFlow({
          host: this.emailConfig.imap.host,
          port: this.emailConfig.imap.port,
          secure: true,
          auth: { user: this.credentials.username, pass: this.credentials.password },
          logger: false
        })

        this.client.on('error', (err: Error) => {
          if (this.currentStatus !== 'disconnected') {
            this.ctx?.log('error', `IMAP error: ${err.message}`)
            this.currentStatus = 'error'
            this.scheduleReconnect()
          }
        })

        this.client.on('close', () => {
          if (this.currentStatus !== 'disconnected') {
            this.ctx?.log('warn', 'IMAP connection closed unexpectedly')
            this.currentStatus = 'error'
            this.scheduleReconnect()
          }
        })

        await this.client.connect()
        this.currentStatus = 'connected'
        this.reconnectAttempts = 0
        this.ctx?.log('info', 'Reconnected successfully')

        // Resume inbound processing
        if (this.emailConfig.idle) {
          this.startIdle()
        } else {
          if (this.pollTimer) clearInterval(this.pollTimer)
          this.pollTimer = setInterval(() => this.pollInbox(), this.emailConfig.poll_interval!)
          this.pollInbox()
        }
      } catch (err) {
        this.ctx?.log('warn', `Reconnect failed: ${err instanceof Error ? err.message : err}`)
        this.scheduleReconnect()
      }
    }, delay)
  }
}
