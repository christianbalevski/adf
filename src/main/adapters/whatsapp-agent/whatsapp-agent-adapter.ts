import { createHash } from 'node:crypto'
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { convertToOggOpus } from '../shared/audio-convert'
import { withSetupGuide } from '../shared/error-hints'
import { markdownToWhatsApp } from '../whatsapp/wa-markdown'
import { resolveOutboundText } from '../form-render'
import { resolveCatchUpConfig } from '../../../shared/types/channel-adapter.types'
import type {
  Attachment,
  ChannelAdapter,
  AdapterContext,
  AdapterStatus,
  OutboundMessage,
  DeliveryResult,
  InboundMessage,
  ChatInfoResult
} from '../../../shared/types/channel-adapter.types'

export const ADAPTER_TYPE = 'whatsapp_agent'
export const CREDENTIAL_KEY = 'WHATSAPP_AGENT_API_KEY'
export const DEFAULT_API_BASE = 'https://api.whatsapp.com/agent/v1'

const STATE_FILE = 'state.json'
const IMPORT_DIR = `imported/${ADAPTER_TYPE}`
/** Long-poll hold; the API clamps to 0–25s */
const POLL_TIMEOUT_S = 25
/** 15 polls/min per agent → never start two polls less than 4s apart */
const MIN_POLL_SPACING_MS = 4_000
const BACKOFF_BASE_MS = 2_000
const BACKOFF_MAX_MS = 60_000
const MAX_TEXT = 4096
const MAX_SEND_ATTEMPTS = 3
const KEY_HELP =
  'In WhatsApp open the agent\'s chat → Chat info → API key, copy it, and paste it as the channel\'s API key.'

/** Upload limits and accepted types (developer manual §4). */
const MB = 1024 * 1024
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png'])
const VIDEO_TYPES = new Set(['video/mp4', 'video/3gpp'])
const AUDIO_TYPES = new Set(['audio/aac', 'audio/mp4', 'audio/mpeg', 'audio/amr', 'audio/ogg', 'audio/opus'])
const DOCUMENT_TYPES = new Set([
  'application/pdf',
  'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'
])

interface PersistedState {
  /** Fingerprint of the key the offset belongs to — a new key starts fresh */
  key: string
  offset: number
}

interface ApiError {
  status: number
  code?: number
  message: string
  details?: string
}

interface UpdatesBody {
  entry?: Array<{
    id?: string
    changes?: Array<{
      value?: {
        contacts?: Array<{ wa_id: string; profile?: { name?: string } }>
        messages?: AgentMessage[]
        statuses?: unknown[]
      }
    }>
  }>
  next_offset?: number
}

interface InboundMedia {
  id: string
  mime_type?: string
  caption?: string
  filename?: string
  voice?: boolean
}

interface AgentMessage {
  from: string
  id: string
  timestamp?: string
  type: string
  context?: { id?: string; from?: string }
  text?: { body?: string }
  image?: InboundMedia
  audio?: InboundMedia
  video?: InboundMedia
  document?: InboundMedia
  sticker?: InboundMedia
  reaction?: { message_id?: string; emoji?: string }
}

type OutboundKind = 'image' | 'video' | 'audio' | 'document'

class ApiRequestError extends Error {
  constructor(readonly api: ApiError) {
    super(api.message)
  }
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
  })

/**
 * WhatsApp's official third-party agent API (WhatsApp → Settings → Agents).
 *
 * The person creates an agent inside their own WhatsApp and pastes its API key
 * here. The agent gets its own 1:1 chat with that person — and only that
 * person: the API refuses to message anyone but the agent's creator, and there
 * are no groups. Chats are NOT end-to-end encrypted (they pass through Meta).
 *
 * Transport is outbound-only HTTPS: inbound via the GET /updates long poll,
 * whose offset is persisted in the adapter data dir so messages that arrive
 * while the agent is offline are replayed (30-day server retention) through the
 * normal catch-up path. Only one poller per key may run at a time (409).
 *
 * Spec: WhatsApp Agent Platform Developer Manual v1 (2026-08-25).
 */
export class WhatsAppAgentAdapter implements ChannelAdapter {
  private readonly apiBase: string
  private ctx: AdapterContext | null = null
  private key: string | null = null
  private currentStatus: AdapterStatus = 'disconnected'
  private abort: AbortController | null = null
  private loop: Promise<void> | null = null
  private statePath: string | null = null
  private offset: number | null = null
  private savedOffset: number | null = null
  private lastPollStart = 0
  private failures = 0
  private agentId: string | null = null
  /** The creator's participant id (user:<id>) — the only reachable recipient */
  private creatorId: string | null = null
  private names = new Map<string, string>()
  /** Terminal failure (bad key, another poller) — surfaced verbatim on sends */
  private terminalError: string | null = null

  private readonly pollTimeoutS: number
  private readonly minPollSpacingMs: number
  private readonly backoffBaseMs: number

  /** Options exist for tests (mock server, fast timings); production uses the defaults. */
  constructor(opts: { apiBase?: string; pollTimeoutS?: number; minPollSpacingMs?: number; backoffBaseMs?: number } = {}) {
    this.apiBase = (opts.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '')
    this.pollTimeoutS = opts.pollTimeoutS ?? POLL_TIMEOUT_S
    this.minPollSpacingMs = opts.minPollSpacingMs ?? MIN_POLL_SPACING_MS
    this.backoffBaseMs = opts.backoffBaseMs ?? BACKOFF_BASE_MS
  }

  async start(ctx: AdapterContext): Promise<void> {
    await this.stop()
    this.ctx = ctx
    this.terminalError = null
    this.currentStatus = 'connecting'

    const key = ctx.getCredential(CREDENTIAL_KEY)?.trim()
    if (!key) {
      this.currentStatus = 'error'
      throw new Error(withSetupGuide(ADAPTER_TYPE, `No WhatsApp agent API key is set for this agent. ${KEY_HELP}`))
    }
    if (!ctx.getDataDir) {
      this.currentStatus = 'error'
      throw new Error('The WhatsApp agent channel requires a host with adapter data directory support (getDataDir)')
    }
    this.key = key
    const dir = ctx.getDataDir()
    try { chmodSync(dir, 0o700) } catch { /* best effort */ }
    this.statePath = join(dir, STATE_FILE)
    const saved = this.loadOffset(key)
    // First start: read from 0 and skip what predates this start. Polling
    // without an offset would be simpler, but an empty (204) answer carries no
    // next_offset, so every later poll would re-resolve the head and drop
    // anything arriving between polls (manual §2, "Starting a new agent").
    const skipBeforeSec = saved === null ? Math.floor(Date.now() / 1000) : null
    this.offset = saved ?? 0

    const abort = new AbortController()
    this.abort = abort
    this.loop = this.run(ctx, abort.signal, skipBeforeSec)
    ctx.log('info', `WhatsApp agent channel starting (${saved === null ? 'first start: new messages only' : `resuming at offset ${saved}`})`)
  }

  async stop(): Promise<void> {
    this.currentStatus = 'disconnected'
    this.abort?.abort()
    this.abort = null
    const loop = this.loop
    this.loop = null
    if (loop) await loop.catch(() => {})
    this.ctx = null
    this.key = null
    this.savedOffset = null
    this.failures = 0
    this.lastPollStart = 0
  }

  status(): AdapterStatus {
    return this.currentStatus
  }

  canDeliver(id: string): boolean {
    return this.currentStatus === 'connected' && /^user:\d+$/.test(id)
  }

  // ---------------------------------------------------------------------------
  // Inbound: long-poll loop
  // ---------------------------------------------------------------------------

  private async run(ctx: AdapterContext, signal: AbortSignal, skipBeforeSec: number | null): Promise<void> {
    // Drain the backlog before going live: on a resume these are messages that
    // arrived while offline (one catch-up phase); on a first start, retained
    // history from before the channel existed is skipped.
    const drained = await this.drainCatchUp(ctx, signal, skipBeforeSec)
    if (!drained) return
    while (!signal.aborted) {
      const ok = await this.pollOnce(ctx, signal, this.pollTimeoutS, (msgs) => this.ingestAll(ctx, msgs))
      if (ok === 'stop') return
    }
  }

  /** Poll with timeout 0 until the backlog is empty, applying catch-up caps. */
  private async drainCatchUp(ctx: AdapterContext, signal: AbortSignal, skipBeforeSec: number | null): Promise<boolean> {
    const caps = resolveCatchUpConfig(ctx.getConfig().config)
    const cutoff = Date.now() - caps.max_age_hours * 3_600_000
    let processed = 0
    let tooOld = 0
    let overflow = 0
    let skipped = 0
    let history = 0
    ctx.beginCatchUp?.()
    try {
      for (;;) {
        let empty = false
        const result = await this.pollOnce(ctx, signal, 0, async (msgs, isEmpty) => {
          empty = isEmpty
          const keep: AgentMessage[] = []
          for (const m of msgs) {
            if (skipBeforeSec !== null && Number(m.timestamp) < skipBeforeSec) { history++; continue }
            if (!caps.enabled) { skipped++; continue }
            const ts = Number(m.timestamp) * 1000
            if (Number.isFinite(ts) && ts < cutoff) { tooOld++; continue }
            if (processed >= caps.max_messages) { overflow++; continue }
            processed++
            keep.push(m)
          }
          await this.ingestAll(ctx, keep)
        })
        if (result === 'stop' || signal.aborted) return false
        if (result === 'ok' && empty) break
      }
    } finally {
      ctx.endCatchUp?.()
    }
    if (history > 0) ctx.log('info', `First start: skipped ${history} earlier message(s) already in the chat`)
    const parts: string[] = []
    if (skipped > 0) parts.push(`${skipped} message(s) skipped (catch_up.enabled is false)`)
    if (overflow > 0) parts.push(`capped at ${caps.max_messages} messages (${overflow} dropped)`)
    if (tooOld > 0) parts.push(`${tooOld} older message(s) skipped (max_age_hours ${caps.max_age_hours})`)
    if (parts.length) ctx.log('info', `WhatsApp agent catch-up ${parts.join('; ')}`)
    return true
  }

  /**
   * One GET /updates round trip. Returns 'ok' after a successful poll (handled
   * and offset advanced), 'retry' after a transient failure (already backed
   * off), or 'stop' on abort or a terminal failure.
   */
  private async pollOnce(
    ctx: AdapterContext,
    signal: AbortSignal,
    timeoutS: number,
    handle: (msgs: AgentMessage[], empty: boolean) => Promise<void>
  ): Promise<'ok' | 'retry' | 'stop'> {
    const wait = this.lastPollStart + this.minPollSpacingMs - Date.now()
    if (wait > 0) await sleep(wait, signal)
    if (signal.aborted) return 'stop'
    this.lastPollStart = Date.now()

    const params = new URLSearchParams({ limit: '100', timeout: String(timeoutS) })
    if (this.offset !== null) params.set('offset', String(this.offset))
    let res: Response
    try {
      res = await fetch(`${this.apiBase}/updates?${params}`, {
        headers: this.authHeaders(),
        signal: AbortSignal.any([signal, AbortSignal.timeout((timeoutS + 15) * 1000)])
      })
    } catch (err) {
      if (signal.aborted) return 'stop'
      return this.transientFailure(ctx, signal, `network error: ${err instanceof Error ? err.message : err}`)
    }
    if (signal.aborted) return 'stop'

    if (res.status === 204) {
      this.markConnected(ctx)
      // Persist the starting point even before any traffic, so a restart
      // resumes (catch-up) instead of treating the gap as a first start
      if (this.offset !== null && this.savedOffset !== this.offset) this.saveOffset(this.offset)
      await handle([], true)
      return 'ok'
    }
    if (!res.ok) {
      const api = await this.readError(res)
      if (res.status === 401 || (res.status === 400 && api.code === 100)) {
        return this.terminal(ctx, `WhatsApp rejected the agent API key (HTTP ${res.status}${api.code ? `, code ${api.code}` : ''}) — it is wrong, or it was regenerated (a new key is issued when the agent is re-created or WhatsApp is reinstalled). ${KEY_HELP} Then restart the channel.`)
      }
      if (res.status === 409) {
        return this.terminal(ctx, 'Another program is already receiving messages with this WhatsApp agent API key (HTTP 409: a newer poll replaced this one). Only one copy can run per key — stop the other copy (another ADF Studio, daemon, or tool using the same key), then restart this channel.')
      }
      return this.transientFailure(ctx, signal, `HTTP ${res.status}: ${api.message}`)
    }

    let body: UpdatesBody
    try {
      body = (await res.json()) as UpdatesBody
    } catch (err) {
      return this.transientFailure(ctx, signal, `unreadable response: ${err instanceof Error ? err.message : err}`)
    }
    this.markConnected(ctx)

    const entry = body.entry?.[0]
    if (entry?.id) this.agentId = entry.id
    const value = entry?.changes?.[0]?.value
    for (const c of value?.contacts ?? []) {
      if (c.profile?.name) this.names.set(c.wa_id, c.profile.name)
    }
    const msgs = value?.messages ?? []
    await handle(msgs, msgs.length === 0 && (value?.statuses?.length ?? 0) === 0)
    // Advance only after handling, so a crash mid-batch replays it (dedup by wamid)
    if (typeof body.next_offset === 'number') this.saveOffset(body.next_offset)
    return 'ok'
  }

  private markConnected(ctx: AdapterContext): void {
    this.failures = 0
    if (this.currentStatus !== 'connected') {
      this.currentStatus = 'connected'
      ctx.log('info', 'WhatsApp agent channel connected')
    }
  }

  private async transientFailure(ctx: AdapterContext, signal: AbortSignal, reason: string): Promise<'retry'> {
    const delay = Math.min(this.backoffBaseMs * 2 ** this.failures, BACKOFF_MAX_MS)
    this.failures++
    if (this.currentStatus === 'connected') this.currentStatus = 'connecting'
    ctx.log('warn', `WhatsApp agent poll failed (${reason}) — retrying in ${Math.round(delay / 1000)}s`)
    await sleep(delay, signal)
    return 'retry'
  }

  private terminal(ctx: AdapterContext, message: string): 'stop' {
    this.terminalError = withSetupGuide(ADAPTER_TYPE, message)
    this.currentStatus = 'error'
    ctx.log('error', message)
    return 'stop'
  }

  private async ingestAll(ctx: AdapterContext, msgs: AgentMessage[]): Promise<void> {
    let lastIngested: string | null = null
    for (const m of msgs) {
      try {
        if (await this.handleMessage(ctx, m)) lastIngested = m.id
      } catch (err) {
        ctx.log('warn', `Inbound handling failed for ${m.id}: ${err instanceof Error ? err.message : err}`)
      }
    }
    // One read receipt per batch (12/min budget). Best effort.
    if (lastIngested) void this.markRead(lastIngested)
  }

  private async handleMessage(ctx: AdapterContext, m: AgentMessage): Promise<boolean> {
    if (!m?.from || !m.id) return false
    if (m.from.startsWith('user:')) this.creatorId = m.from

    let text = ''
    const attachments: Attachment[] = []
    const media =
      m.type === 'image' ? m.image :
      m.type === 'video' ? m.video :
      m.type === 'audio' ? m.audio :
      m.type === 'document' ? m.document :
      m.type === 'sticker' ? m.sticker :
      undefined

    if (m.type === 'text') {
      text = m.text?.body ?? ''
    } else if (m.type === 'reaction') {
      const emoji = m.reaction?.emoji?.trim()
      if (!emoji) return false // reaction removed
      text = `[Reacted ${emoji}]`
    } else if (media) {
      const placeholder =
        m.type === 'audio' ? (media.voice ? '[Voice message]' : '[Audio]') :
        `[${m.type[0].toUpperCase()}${m.type.slice(1)}]`
      text = media.caption ?? ''
      const saved = await this.downloadInbound(ctx, m, media, placeholder)
      if (saved) attachments.push(saved)
      if (!text) text = placeholder
    } else {
      ctx.log('info', `Skipping unsupported inbound message type "${m.type}" (${m.id})`)
      return false
    }
    if (!text && attachments.length === 0) return false

    const senderName = this.names.get(m.from)
    const sourceMeta: Record<string, unknown> = {
      chat_id: m.from,
      chat_type: 'dm',
      message_id: m.id
    }
    if (senderName) sourceMeta.username = senderName
    if (m.context?.id) sourceMeta.reply_to_message_id = m.context.id
    if (m.type === 'reaction' && m.reaction?.message_id) sourceMeta.reply_to_message_id = m.reaction.message_id

    const ts = Number(m.timestamp)
    const inbound: InboundMessage = {
      sender: m.from,
      senderName,
      messageId: m.id,
      payload: text,
      attachments: attachments.length ? attachments : undefined,
      sourceMeta,
      originalMessage: JSON.stringify(m),
      sentAt: Number.isFinite(ts) ? ts * 1000 : undefined
    }
    ctx.log('info', `Inbound ${m.type} ${m.id}`)
    ctx.ingest(inbound)
    return true
  }

  private async downloadInbound(
    ctx: AdapterContext,
    m: AgentMessage,
    media: InboundMedia,
    placeholder: string
  ): Promise<Attachment | null> {
    const max = ctx.getConfig().limits?.max_attachment_size ?? 10_000_000
    try {
      const meta = (await this.request('GET', `/media/${encodeURIComponent(media.id)}`)) as {
        url?: string; mime_type?: string; file_size?: number
      }
      if (typeof meta.file_size === 'number' && meta.file_size > max) {
        ctx.log('warn', `Inbound ${m.type} ${m.id} is ${meta.file_size} bytes, over limits.max_attachment_size (${max}) — delivered as "${placeholder}" without the file`)
        return null
      }
      if (!meta.url) throw new Error('media lookup returned no url')
      const url = new URL(meta.url)
      if (!this.isTrustedMediaHost(url)) {
        throw new Error(`media url host ${url.host} is not a WhatsApp host — refusing to send the API key there`)
      }
      const res = await fetch(url, { headers: this.authHeaders(), signal: AbortSignal.timeout(120_000) })
      if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
      const data = Buffer.from(await res.arrayBuffer())
      const mime = media.mime_type ?? meta.mime_type ?? 'application/octet-stream'
      const ext = mime.split('/')[1]?.split(';')[0] ?? 'bin'
      const filename = (media.filename ?? `${m.type}_${media.id}.${ext}`).replace(/[\\/]/g, '_')
      const path = `${IMPORT_DIR}/${filename}`
      const saved = ctx.writeAttachment(path, data, mime) || path
      return { path: saved, filename, mimeType: mime, size: data.length }
    } catch (err) {
      ctx.log('warn', `Failed to download inbound ${m.type} ${m.id}: ${this.describe(err)}. The message was still delivered with a "${placeholder}" placeholder and no attachment.`)
      return null
    }
  }

  /** Bytes may live on a different host than the API (lookaside.fbsbx.com). */
  private isTrustedMediaHost(url: URL): boolean {
    const base = new URL(this.apiBase)
    if (url.origin === base.origin) return true
    return url.protocol === 'https:' && (url.hostname === 'fbsbx.com' || url.hostname.endsWith('.fbsbx.com') || url.hostname.endsWith('.whatsapp.com') || url.hostname.endsWith('.whatsapp.net'))
  }

  private async markRead(messageId: string): Promise<void> {
    try {
      await this.request('POST', '/statuses', { messaging_product: 'whatsapp', status: 'read', message_id: messageId })
    } catch (err) {
      this.ctx?.log('info', `Read receipt not sent for ${messageId}: ${this.describe(err)}`)
    }
  }

  // ---------------------------------------------------------------------------
  // Outbound
  // ---------------------------------------------------------------------------

  async send(msg: OutboundMessage): Promise<DeliveryResult> {
    if (this.currentStatus !== 'connected' || !this.key) {
      return { success: false, error: this.notConnectedError() }
    }
    const chatId = msg.sourceMeta?.chat_id
    const to = typeof chatId === 'string' && chatId ? chatId : msg.recipientId
    if (!/^user:\d+$/.test(to)) {
      return {
        success: false,
        error: withSetupGuide(ADAPTER_TYPE,
          `"${to}" is not a WhatsApp agent recipient — nothing was sent. This channel can only message the person who created the agent, ` +
          `addressed as "whatsapp_agent:user:<id>"${this.creatorId ? ` (here: "whatsapp_agent:${this.creatorId}")` : ''}. ` +
          `Reply with parent_id, or copy the chat_id from one of their messages. Phone numbers and groups are not supported.`)
      }
    }

    const quotedId = msg.sourceMeta?.message_id
    let quote: string | undefined = typeof quotedId === 'string' && quotedId.startsWith('wamid.') ? quotedId : undefined
    const { text, isHtml } = resolveOutboundText(msg)
    const body = isHtml ? text : markdownToWhatsApp(text)

    const sent: string[] = []
    let lastId: string | undefined
    const deliverOne = async (payload: Record<string, unknown>): Promise<string | undefined> => {
      try {
        const id = await this.postMessage(to, payload, quote)
        quote = undefined // quote only the first part
        return id
      } catch (err) {
        // A quote that no longer resolves (older than 30 days, or from another
        // chat) must not cost the reply — resend once without it.
        if (quote && err instanceof ApiRequestError && err.api.status === 400) {
          this.ctx?.log('info', `Quoted message ${quote} not accepted (${err.api.message}) — sending without the quote`)
          quote = undefined
          return this.postMessage(to, payload, undefined)
        }
        throw err
      }
    }

    if (body || !msg.attachments?.length) {
      for (const part of splitText(body || ' ', MAX_TEXT)) {
        try {
          lastId = await deliverOne({ type: 'text', text: { body: part } })
          sent.push('text')
        } catch (err) {
          const done = sent.length ? ` ${sent.length} earlier text part(s) were delivered — do not re-send them.` : ''
          const suffix = msg.attachments?.length ? ` The ${msg.attachments.length} attachment(s) were not sent.` : ''
          return {
            success: false,
            error: withSetupGuide(ADAPTER_TYPE, `Sending the text to ${to} failed: ${this.describe(err)}.${done}${suffix}`),
            ...(lastId ? { sourceMeta: { chat_id: to, message_id: lastId } } : {})
          }
        }
      }
    }

    const delivered: string[] = []
    const failures: string[] = []
    for (const att of msg.attachments ?? []) {
      if (!att.data) continue
      try {
        const { kind, data, mime } = await this.prepareAttachment(att)
        const mediaId = await this.upload(data, mime, att.filename)
        const media: Record<string, unknown> = { id: mediaId }
        if (kind === 'document') media.filename = att.filename
        lastId = await deliverOne({ type: kind, [kind]: media })
        delivered.push(att.filename)
      } catch (err) {
        failures.push(`"${att.filename}": ${this.describe(err)}`)
      }
    }

    const sourceMeta = { chat_id: to, message_id: lastId }
    if (failures.length) {
      const parts: string[] = []
      if (sent.length) parts.push('the text was delivered')
      if (delivered.length) parts.push(`${delivered.length} attachment(s) were delivered (${delivered.join(', ')})`)
      const lead = parts.length ? `${parts.join(' and ')}, but ` : 'Nothing was delivered: '
      return {
        success: false,
        error: withSetupGuide(ADAPTER_TYPE, `${lead[0].toUpperCase()}${lead.slice(1)}${failures.length} attachment(s) failed — ${failures.join('; ')}.${parts.length ? ' Do not re-send the parts that were already delivered.' : ''}`),
        ...(lastId ? { sourceMeta } : {})
      }
    }
    return { success: true, sourceMeta }
  }

  /** POST /messages with bounded retries for the cases the manual marks safe (429, 503/131016). */
  private async postMessage(to: string, payload: Record<string, unknown>, quote: string | undefined): Promise<string | undefined> {
    const reqBody: Record<string, unknown> = { messaging_product: 'whatsapp', to, ...payload }
    if (quote) reqBody.context = { message_id: quote }
    for (let attempt = 1; ; attempt++) {
      try {
        const res = (await this.request('POST', '/messages', reqBody)) as { messages?: Array<{ id?: string }> }
        return res.messages?.[0]?.id
      } catch (err) {
        const retryable = err instanceof ApiRequestError &&
          (err.api.status === 429 || (err.api.status === 503 && err.api.code === 131016))
        if (!retryable || attempt >= MAX_SEND_ATTEMPTS) throw err
        await sleep(this.backoffBaseMs * 2 ** (attempt - 1))
      }
    }
  }

  /** Map an attachment onto a sendable type, or fail plainly with what would work. */
  private async prepareAttachment(att: Attachment): Promise<{ kind: OutboundKind; data: Buffer; mime: string }> {
    const mime = att.mimeType.split(';')[0].trim().toLowerCase()
    let data = att.data as Buffer
    const check = (limit: number, what: string): void => {
      if (data.length > limit) {
        throw new Error(`${data.length} bytes is over WhatsApp's ${limit / MB} MB limit for ${what} — send a smaller file`)
      }
    }
    if (IMAGE_TYPES.has(mime)) { check(5 * MB, 'images'); return { kind: 'image', data, mime } }
    if (VIDEO_TYPES.has(mime)) { check(16 * MB, 'video'); return { kind: 'video', data, mime } }
    if (mime === 'audio/wav' || mime === 'audio/x-wav' || mime === 'audio/wave' || /\.wav$/i.test(att.filename)) {
      try {
        data = await convertToOggOpus(data)
      } catch (err) {
        throw new Error(`WAV audio must be converted to Ogg/Opus, which needs ffmpeg on PATH (${err instanceof Error ? err.message : err}); send MP3, AAC, M4A or OGG instead`)
      }
      check(16 * MB, 'audio')
      return { kind: 'audio', data, mime: 'audio/ogg' }
    }
    if (AUDIO_TYPES.has(mime)) { check(16 * MB, 'audio'); return { kind: 'audio', data, mime } }
    // Everything else (other images, CSV, ZIP, JSON, …) goes as a document —
    // listed office/PDF/text types keep their type, the rest as generic binary.
    check(16 * MB, 'documents')
    return { kind: 'document', data, mime: DOCUMENT_TYPES.has(mime) ? mime : 'application/octet-stream' }
  }

  private async upload(data: Buffer, mime: string, filename: string): Promise<string> {
    const form = new FormData()
    form.set('messaging_product', 'whatsapp')
    form.set('type', mime)
    form.set('file', new Blob([new Uint8Array(data)], { type: mime }), filename)
    const res = (await this.request('POST', '/media', form)) as { id?: string }
    if (!res.id) throw new Error('media upload returned no id')
    return res.id
  }

  // ---------------------------------------------------------------------------
  // Chat info
  // ---------------------------------------------------------------------------

  async getChatInfo(chatId: string, opts?: { limit?: number }): Promise<ChatInfoResult> {
    void opts
    if (this.currentStatus !== 'connected') return { supported: false, reason: this.notConnectedError() }
    const name = this.names.get(chatId)
    return {
      supported: true,
      info: {
        platform: ADAPTER_TYPE,
        chat_id: chatId,
        chat_type: 'dm',
        participant_count: 2,
        participants: [
          ...(this.agentId ? [{ id: `agent:${this.agentId}`, role: 'self' }] : []),
          { id: chatId, ...(name ? { name } : {}), role: 'creator' }
        ],
        participants_truncated: false,
        participants_scope: 'all',
        fetched_at: Date.now()
      }
    }
  }

  // ---------------------------------------------------------------------------
  // HTTP helpers
  // ---------------------------------------------------------------------------

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.key}` }
  }

  private async request(method: 'GET' | 'POST' | 'DELETE', path: string, body?: Record<string, unknown> | FormData): Promise<unknown> {
    if (!this.key) throw new Error('channel is stopped')
    const headers = this.authHeaders()
    let payload: string | FormData | undefined
    if (body instanceof FormData) payload = body
    else if (body) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json' }
    // Generous read timeout: a timeout after the request went out leaves a
    // send's outcome unknown, so it should only trip on a real hang.
    const res = await fetch(`${this.apiBase}${path}`, { method, headers, body: payload, signal: AbortSignal.timeout(90_000) })
    if (!res.ok) throw new ApiRequestError(await this.readError(res))
    const textBody = await res.text()
    return textBody ? JSON.parse(textBody) : {}
  }

  private async readError(res: Response): Promise<ApiError> {
    let parsed: { error?: { message?: string; code?: number; error_data?: { details?: string } } } = {}
    try { parsed = (await res.json()) as typeof parsed } catch { /* non-JSON body */ }
    return {
      status: res.status,
      code: parsed.error?.code,
      message: parsed.error?.message ?? `HTTP ${res.status}`,
      details: parsed.error?.error_data?.details
    }
  }

  /** Plain explanation of a failed API call, keyed on error.code (manual §5). */
  private describe(err: unknown): string {
    if (!(err instanceof ApiRequestError)) {
      const raw = err instanceof Error ? err.message : String(err)
      if (/timeout|aborted|fetch failed|ECONN|ENOTFOUND/i.test(raw)) {
        return `the request did not complete (${raw}); it may or may not have been delivered — check the chat before re-sending`
      }
      return raw
    }
    const { status, code, message, details } = err.api
    const detail = details ? ` (${details})` : ''
    if (code === 131005 || status === 403) {
      return `WhatsApp only lets an agent message the person who created it${this.creatorId ? ` (${this.creatorId})` : ''}${detail}`
    }
    if (status === 401 || code === 190 || (status === 400 && code === 100 && /token|auth/i.test(message))) {
      return `the API key was rejected — ${KEY_HELP}`
    }
    if (code === 130429 || status === 429) return 'rate limited (WhatsApp allows 12 sends per minute per agent) — wait a minute and retry'
    if (code === 131016) return 'WhatsApp did not accept the message for delivery (503) — retry in a moment'
    if (code === 131053) return `WhatsApp rejected the file${detail} — check its size and type`
    if (status >= 500) return `WhatsApp server error (${message}) — the message may or may not have been delivered; check the chat before re-sending`
    return `${message}${detail}`
  }

  private notConnectedError(): string {
    if (this.terminalError) return this.terminalError
    return withSetupGuide(ADAPTER_TYPE,
      `The WhatsApp agent channel is not connected (status: ${this.currentStatus}). If it just started, retry in a few seconds. ` +
      `If it stays disconnected, check the channel log — a rejected key needs a fresh one: ${KEY_HELP}`)
  }

  // ---------------------------------------------------------------------------
  // Offset persistence
  // ---------------------------------------------------------------------------

  private fingerprint(key: string): string {
    return createHash('sha256').update(key).digest('hex').slice(0, 16)
  }

  private loadOffset(key: string): number | null {
    if (!this.statePath) return null
    try {
      const state = JSON.parse(readFileSync(this.statePath, 'utf8')) as PersistedState
      if (state.key === this.fingerprint(key) && Number.isSafeInteger(state.offset)) {
        this.savedOffset = state.offset
        return state.offset
      }
      this.ctx?.log('info', 'API key changed since the last run — starting fresh (new messages only)')
    } catch { /* first start */ }
    return null
  }

  private saveOffset(offset: number): void {
    this.offset = offset
    if (!this.statePath || !this.key) return
    const state: PersistedState = { key: this.fingerprint(this.key), offset }
    const tmp = `${this.statePath}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 })
      renameSync(tmp, this.statePath)
      this.savedOffset = offset
    } catch (err) {
      this.ctx?.log('warn', `Could not save the poll offset: ${err instanceof Error ? err.message : err}`)
    }
  }
}

/** Split text into ≤max chunks, preferring paragraph, then line, then word breaks. */
export function splitText(text: string, max: number): string[] {
  const out: string[] = []
  let rest = text
  while (rest.length > max) {
    const window = rest.slice(0, max)
    let cut = window.lastIndexOf('\n\n')
    if (cut < max / 2) cut = window.lastIndexOf('\n')
    if (cut < max / 2) cut = window.lastIndexOf(' ')
    if (cut < max / 2) cut = max
    out.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).replace(/^\s+/, '')
  }
  if (rest.length || out.length === 0) out.push(rest)
  return out
}
