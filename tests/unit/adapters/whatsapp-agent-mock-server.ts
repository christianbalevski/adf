import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * In-process mock of the WhatsApp Agent Platform API (developer manual v1,
 * 2026-08-25): bearer auth, GET /updates long poll with offsets and 409
 * replacement, POST /messages (creator-only), POST /statuses, and the media
 * upload / lookup / download endpoints. Enough fidelity to exercise the
 * adapter end to end over real HTTP.
 */

export const AGENT_ID = '123456789'
export const CREATOR = 'user:50972923564215'

export interface SentMessage {
  to: string
  type: string
  body: Record<string, unknown>
}

interface PendingPoll {
  res: ServerResponse
  offset: number
  limit: number
  timer: ReturnType<typeof setTimeout>
}

type Entry =
  | { kind: 'message'; message: Record<string, unknown>; contact?: { wa_id: string; profile?: { name: string } } }
  | { kind: 'status'; status: Record<string, unknown> }

export class MockAgentServer {
  readonly key = 'test-agent-key'
  entries: Entry[] = []
  sent: SentMessage[] = []
  statuses: Array<Record<string, unknown>> = []
  uploads = new Map<string, { data: Buffer; mime: string; filename?: string }>()
  /** Media the "user" sent, served by GET /media/:id */
  inboundMedia = new Map<string, { data: Buffer; mime: string }>()
  polls = 0
  /** Queue of forced error responses for POST /messages */
  failNextSends: Array<{ status: number; code: number; message?: string }> = []
  /** When set, GET /media/:id returns this url instead of the local one */
  mediaUrlOverride: string | null = null
  private pending: PendingPoll | null = null
  private server: Server
  private wamidSeq = 0
  private mediaSeq = 0
  base = ''

  constructor() {
    this.server = createServer((req, res) => { void this.route(req, res) })
  }

  async listen(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    const { port } = this.server.address() as AddressInfo
    this.base = `http://127.0.0.1:${port}/agent/v1`
    return this.base
  }

  async close(): Promise<void> {
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.res.destroy() }
    this.server.closeAllConnections()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  // --- test helpers -------------------------------------------------------

  /** Simulate the creator sending the agent a message. Returns its wamid. */
  pushMessage(message: Record<string, unknown>, name: string | null = 'Alex'): string {
    const id = (message.id as string) ?? `wamid.IN${++this.wamidSeq}`
    const full = { from: CREATOR, id, timestamp: String(Math.floor(Date.now() / 1000)), ...message }
    this.entries.push({ kind: 'message', message: full, contact: { wa_id: full.from as string, ...(name ? { profile: { name } } : {}) } })
    this.flushPending()
    return id
  }

  pushStatus(status: Record<string, unknown>): void {
    this.entries.push({ kind: 'status', status })
    this.flushPending()
  }

  // --- routing ------------------------------------------------------------

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x')
    const path = url.pathname.replace(/^\/agent\/v1/, '')
    const auth = req.headers.authorization
    if (!auth || !/^Bearer \S+$/.test(auth)) return this.error(res, 401, 190, 'Malformed access token')
    if (auth !== `Bearer ${this.key}`) return this.error(res, 400, 100, 'Invalid OAuth access token')

    if (req.method === 'GET' && path === '/updates') return this.updates(url, res)
    if (req.method === 'POST' && path === '/messages') return this.messages(await this.json(req), res)
    if (req.method === 'POST' && path === '/statuses') {
      const body = await this.json(req)
      this.statuses.push(body)
      return this.send(res, 200, { success: true })
    }
    if (req.method === 'POST' && path === '/media') return this.upload(req, res)
    const contentMatch = /^\/media\/([^/]+)\/content$/.exec(path)
    if (req.method === 'GET' && contentMatch) {
      const m = this.inboundMedia.get(contentMatch[1]) ?? this.uploads.get(contentMatch[1])
      if (!m) return this.error(res, 404, 100, 'Unknown media')
      res.writeHead(200, { 'Content-Type': m.mime })
      res.end(m.data)
      return
    }
    const mediaMatch = /^\/media\/([^/]+)$/.exec(path)
    if (req.method === 'GET' && mediaMatch) {
      const id = mediaMatch[1]
      const m = this.inboundMedia.get(id) ?? this.uploads.get(id)
      if (!m) return this.error(res, 400, 100, 'Unknown media id')
      return this.send(res, 200, {
        url: this.mediaUrlOverride ?? `${this.base}/media/${id}/content`,
        mime_type: m.mime,
        sha256: 'x',
        file_size: m.data.length,
        id,
        messaging_product: 'whatsapp'
      })
    }
    return this.error(res, 404, 100, `No route ${req.method} ${path}`)
  }

  private updates(url: URL, res: ServerResponse): void {
    this.polls++
    const rawOffset = url.searchParams.get('offset')
    const offset = rawOffset === null ? this.entries.length : Math.max(0, Number(rawOffset))
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50) || 50, 1), 100)
    const timeout = Math.min(Math.max(Number(url.searchParams.get('timeout') ?? 15), 0), 25)

    // A newer poll replaces the open one (409, code 1752041)
    if (this.pending) {
      clearTimeout(this.pending.timer)
      this.error(this.pending.res, 409, 1752041, 'A newer poll replaced this one')
      this.pending = null
    }
    if (offset < this.entries.length || timeout === 0) {
      this.respondUpdates(res, offset, limit)
      return
    }
    const timer = setTimeout(() => {
      if (this.pending?.res === res) this.pending = null
      res.writeHead(204)
      res.end()
    }, timeout * 1000)
    this.pending = { res, offset, limit, timer }
    res.on('close', () => {
      if (this.pending?.res === res) { clearTimeout(timer); this.pending = null }
    })
  }

  private flushPending(): void {
    const p = this.pending
    if (!p || p.offset >= this.entries.length) return
    clearTimeout(p.timer)
    this.pending = null
    this.respondUpdates(p.res, p.offset, p.limit)
  }

  private respondUpdates(res: ServerResponse, offset: number, limit: number): void {
    const slice = this.entries.slice(offset, offset + limit)
    if (slice.length === 0) {
      res.writeHead(204)
      res.end()
      return
    }
    const contacts = new Map<string, unknown>()
    const messages: unknown[] = []
    const statuses: unknown[] = []
    for (const e of slice) {
      if (e.kind === 'message') {
        messages.push(e.message)
        if (e.contact) contacts.set(e.contact.wa_id, e.contact)
      } else {
        statuses.push(e.status)
      }
    }
    this.send(res, 200, {
      object: 'whatsapp_agent_platform',
      entry: [{
        id: AGENT_ID,
        changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', contacts: [...contacts.values()], messages, statuses } }]
      }],
      next_offset: offset + slice.length
    })
  }

  private messages(body: Record<string, unknown>, res: ServerResponse): void {
    const forced = this.failNextSends.shift()
    if (forced) return this.error(res, forced.status, forced.code, forced.message ?? 'forced failure')
    if (body.messaging_product !== 'whatsapp') return this.error(res, 400, 131009, 'messaging_product required')
    const to = body.to as string
    if (!/^user:\d+$/.test(to ?? '')) return this.error(res, 400, 131009, 'Invalid participant format', 'Invalid participant format; expected "<type>:<int id>", where type = agent|user')
    if (to !== CREATOR) return this.error(res, 403, 131005, 'Recipient is not the agent creator')
    const type = body.type as string
    if (!type || !body[type]) return this.error(res, 400, 131009, `${type} is required when type=${type}`)
    if (type === 'text' && String((body.text as { body?: string }).body ?? '').length > 4096) {
      return this.error(res, 400, 100, 'text.body')
    }
    if (['image', 'video', 'audio', 'document', 'sticker'].includes(type)) {
      const id = (body[type] as { id?: string }).id
      if (!id || !this.uploads.has(id)) return this.error(res, 400, 131009, 'Unknown media id')
    }
    const context = body.context as { message_id?: string } | undefined
    if (context) {
      const known = this.entries.some((e) => e.kind === 'message' && e.message.id === context.message_id) ||
        this.sent.some((s) => (s.body as { _id?: string })._id === context.message_id)
      if (!known) return this.error(res, 400, 131009, 'context.message_id is not a wamid from this conversation')
    }
    const id = `wamid.OUT${++this.wamidSeq}`
    this.sent.push({ to, type, body: { ...body, _id: id } })
    this.send(res, 200, { messaging_product: 'whatsapp', contacts: [{ input: to, wa_id: to }], messages: [{ id }] })
  }

  private async upload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const form = await new Request('http://x/', {
      method: 'POST',
      headers: { 'content-type': req.headers['content-type'] ?? '' },
      body: Buffer.concat(chunks)
    }).formData()
    if (form.get('messaging_product') !== 'whatsapp') return this.error(res, 400, 131009, 'messaging_product required')
    const file = form.get('file')
    if (!(file instanceof Blob)) return this.error(res, 400, 131009, 'file required')
    const mime = (form.get('type') as string | null) ?? file.type
    const id = `media-${++this.mediaSeq}`
    this.uploads.set(id, { data: Buffer.from(await file.arrayBuffer()), mime, filename: (file as File).name })
    this.send(res, 200, { id })
  }

  // --- plumbing -----------------------------------------------------------

  private async json(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    if (res.writableEnded || res.destroyed) return
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  private error(res: ServerResponse, status: number, code: number, message: string, details?: string): void {
    this.send(res, status, {
      error: {
        message: `(#${code}) ${message}`,
        type: 'OAuthException',
        code,
        ...(details ? { error_data: { messaging_product: 'whatsapp', details } } : {}),
        fbtrace_id: 'trace'
      }
    })
  }
}
