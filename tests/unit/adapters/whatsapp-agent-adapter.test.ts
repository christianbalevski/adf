import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  AdapterContext,
  AdapterInstanceConfig,
  InboundMessage,
  OutboundMessage
} from '../../../src/shared/types/channel-adapter.types'

vi.mock('../../../src/main/adapters/shared/audio-convert', () => ({
  convertToOggOpus: vi.fn(async () => Buffer.from('ogg-bytes'))
}))

import { WhatsAppAgentAdapter, splitText } from '../../../src/main/adapters/whatsapp-agent/whatsapp-agent-adapter'
import { AGENT_ID, CREATOR, MockAgentServer } from './whatsapp-agent-mock-server'

let server: MockAgentServer
let dataDir: string
let adapters: WhatsAppAgentAdapter[] = []

beforeEach(async () => {
  server = new MockAgentServer()
  await server.listen()
  dataDir = mkdtempSync(join(tmpdir(), 'wa-agent-'))
})

afterEach(async () => {
  for (const a of adapters) await a.stop()
  adapters = []
  await server.close()
  rmSync(dataDir, { recursive: true, force: true })
})

interface Harness {
  adapter: WhatsAppAgentAdapter
  ctx: AdapterContext
  ingested: InboundMessage[]
  files: Map<string, Buffer>
  logs: string[]
  catchUp: { begin: number; end: number }
}

function makeAdapter(opts: { key?: string | null; config?: AdapterInstanceConfig } = {}): Harness {
  const adapter = new WhatsAppAgentAdapter({ apiBase: server.base, pollTimeoutS: 1, minPollSpacingMs: 0, backoffBaseMs: 20 })
  adapters.push(adapter)
  const ingested: InboundMessage[] = []
  const files = new Map<string, Buffer>()
  const logs: string[] = []
  const catchUp = { begin: 0, end: 0 }
  const key = opts.key === undefined ? server.key : opts.key
  const ctx: AdapterContext = {
    ingest: (m) => { ingested.push(m); return `row-${ingested.length}` },
    writeAttachment: (path, data) => { files.set(path, data); return path },
    getConfig: () => opts.config ?? { enabled: true },
    getCredential: (k) => (k === 'WHATSAPP_AGENT_API_KEY' ? key : null),
    log: (level, message) => { logs.push(`[${level}] ${message}`) },
    getDataDir: () => dataDir,
    beginCatchUp: () => { catchUp.begin++ },
    endCatchUp: () => { catchUp.end++; return { ingested: 0, deduped: 0 } }
  }
  return { adapter, ctx, ingested, files, logs, catchUp }
}

async function until(cond: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 10))
  }
}

async function startConnected(h: Harness): Promise<void> {
  await h.adapter.start(h.ctx)
  await until(() => h.adapter.status() === 'connected')
}

function outbound(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return { id: 'out-1', recipientId: CREATOR, payload: 'hello', ...overrides }
}

describe('WhatsAppAgentAdapter (against the mock Agent Platform API)', () => {
  describe('start()', () => {
    it('fails plainly with where to find the key when none is set', async () => {
      const h = makeAdapter({ key: null })
      await expect(h.adapter.start(h.ctx)).rejects.toThrow(/Chat info → API key/)
      expect(h.adapter.status()).toBe('error')
    })

    it('connects on the first successful poll', async () => {
      const h = makeAdapter()
      await startConnected(h)
      expect(h.adapter.status()).toBe('connected')
      expect(h.logs.some((l) => l.includes('first start: new messages only'))).toBe(true)
    })

    it('loses no message sent between empty polls on a first start', async () => {
      const h = makeAdapter()
      await startConnected(h)
      // The first poll answered 204; the next poll must still resume from a
      // real offset rather than re-resolving the head.
      await until(() => server.polls >= 2)
      server.pushMessage({ type: 'text', text: { body: 'between polls' } })
      await until(() => h.ingested.length === 1)
      expect(JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')).offset).toBeGreaterThanOrEqual(0)
    })

    it('stops with re-key instructions when the key is rejected', async () => {
      const h = makeAdapter({ key: 'wrong-key' })
      await h.adapter.start(h.ctx)
      await until(() => h.adapter.status() === 'error')
      const result = await h.adapter.send(outbound())
      expect(result.success).toBe(false)
      expect(result.error).toMatch(/rejected the agent API key/)
      expect(result.error).toMatch(/Setup guide: .*#whatsapp-official-agent-adapter/)
    })

    it('stops when a second poller takes over the same key (409)', async () => {
      const a = makeAdapter()
      await startConnected(a)
      const b = makeAdapter()
      await startConnected(b)
      await until(() => a.adapter.status() === 'error' || b.adapter.status() === 'error')
      const loser = a.adapter.status() === 'error' ? a : b
      expect((await loser.adapter.send(outbound())).error).toMatch(/Only one copy can run per key/)
    })
  })

  describe('inbound', () => {
    it('skips the backlog on first start, then ingests new text with reply metadata', async () => {
      server.pushMessage({ type: 'text', text: { body: 'old, before the channel existed' }, timestamp: minutesAgo(5) })
      const h = makeAdapter()
      await startConnected(h)
      const id = server.pushMessage({ type: 'text', text: { body: 'Hello agent' } })
      await until(() => h.ingested.length === 1)

      const m = h.ingested[0]
      expect(m.payload).toBe('Hello agent')
      expect(m.sender).toBe(CREATOR)
      expect(m.senderName).toBe('Alex')
      expect(m.messageId).toBe(id)
      expect(m.sourceMeta).toMatchObject({ chat_id: CREATOR, chat_type: 'dm', message_id: id, username: 'Alex' })
      expect(typeof m.sentAt).toBe('number')
      // Read receipt for the batch
      await until(() => server.statuses.length === 1)
      expect(server.statuses[0]).toMatchObject({ status: 'read', message_id: id })
    })

    it('maps a quoted message to reply_to_message_id', async () => {
      const h = makeAdapter()
      await startConnected(h)
      server.pushMessage({ type: 'text', text: { body: 'about that' }, context: { id: 'wamid.EARLIER', from: `agent:${AGENT_ID}` } })
      await until(() => h.ingested.length === 1)
      expect(h.ingested[0].sourceMeta?.reply_to_message_id).toBe('wamid.EARLIER')
    })

    it('downloads inbound media into the file store and keeps the caption', async () => {
      const h = makeAdapter()
      await startConnected(h)
      server.inboundMedia.set('img-1', { data: Buffer.from('jpeg-bytes'), mime: 'image/jpeg' })
      server.pushMessage({ type: 'image', image: { id: 'img-1', mime_type: 'image/jpeg', sha256: 'x', caption: 'look' } })
      await until(() => h.ingested.length === 1)
      const m = h.ingested[0]
      expect(m.payload).toBe('look')
      expect(m.attachments?.[0]).toMatchObject({ path: 'imported/whatsapp_agent/image_img-1.jpeg', mimeType: 'image/jpeg', size: 10 })
      expect(h.files.get('imported/whatsapp_agent/image_img-1.jpeg')?.toString()).toBe('jpeg-bytes')
    })

    it('labels a voice note and still ingests it when the download fails', async () => {
      const h = makeAdapter()
      await startConnected(h)
      server.pushMessage({ type: 'audio', audio: { id: 'missing', mime_type: 'audio/ogg', sha256: 'x', voice: true } })
      await until(() => h.ingested.length === 1)
      expect(h.ingested[0].payload).toBe('[Voice message]')
      expect(h.ingested[0].attachments).toBeUndefined()
      expect(h.logs.some((l) => l.includes('Failed to download inbound audio'))).toBe(true)
    })

    it('never sends the API key to a media url outside WhatsApp hosts', async () => {
      const h = makeAdapter()
      await startConnected(h)
      server.inboundMedia.set('doc-1', { data: Buffer.from('pdf'), mime: 'application/pdf' })
      server.mediaUrlOverride = 'https://evil.example.com/steal'
      server.pushMessage({ type: 'document', document: { id: 'doc-1', mime_type: 'application/pdf', sha256: 'x', filename: 'a.pdf' } })
      await until(() => h.ingested.length === 1)
      expect(h.ingested[0].payload).toBe('[Document]')
      expect(h.logs.some((l) => l.includes('not a WhatsApp host'))).toBe(true)
    })

    it('ingests reactions as short text and ignores removed reactions', async () => {
      const h = makeAdapter()
      await startConnected(h)
      server.pushMessage({ type: 'reaction', reaction: { message_id: 'wamid.OUT9', emoji: '' } })
      server.pushMessage({ type: 'reaction', reaction: { message_id: 'wamid.OUT9', emoji: '👍' } })
      await until(() => h.ingested.length === 1)
      expect(h.ingested[0].payload).toBe('[Reacted 👍]')
      expect(h.ingested[0].sourceMeta?.reply_to_message_id).toBe('wamid.OUT9')
    })
  })

  describe('offset persistence and catch-up', () => {
    it('saves the offset and replays messages that arrived while stopped, as one catch-up phase', async () => {
      const first = makeAdapter()
      await startConnected(first)
      server.pushMessage({ type: 'text', text: { body: 'live' } })
      await until(() => first.ingested.length === 1)
      await first.adapter.stop()
      const saved = JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'))
      expect(saved.offset).toBe(1)
      expect(JSON.stringify(saved)).not.toContain(server.key)

      server.pushMessage({ type: 'text', text: { body: 'while offline 1' } })
      server.pushMessage({ type: 'text', text: { body: 'while offline 2' } })
      const second = makeAdapter()
      await startConnected(second)
      await until(() => second.ingested.length === 2)
      expect(second.ingested.map((m) => m.payload)).toEqual(['while offline 1', 'while offline 2'])
      expect(second.catchUp).toEqual({ begin: 1, end: 1 })
    })

    it('applies catch-up caps and skips the backlog when catch-up is disabled', async () => {
      writeFileSync(join(dataDir, 'state.json'), JSON.stringify({ key: fingerprintOf(server.key), offset: 0 }))
      server.pushMessage({ type: 'text', text: { body: 'stale' }, timestamp: String(Math.floor(Date.now() / 1000) - 3 * 86_400) })
      server.pushMessage({ type: 'text', text: { body: 'a' } })
      server.pushMessage({ type: 'text', text: { body: 'b' } })
      const h = makeAdapter({ config: { enabled: true, config: { catch_up: { max_messages: 1 } } } })
      await startConnected(h)
      await until(() => h.ingested.length === 1)
      expect(h.ingested[0].payload).toBe('a')
      expect(h.logs.some((l) => l.includes('1 dropped') && l.includes('1 older message'))).toBe(true)

      await h.adapter.stop()
      server.pushMessage({ type: 'text', text: { body: 'c' } })
      const off = makeAdapter({ config: { enabled: true, config: { catch_up: { enabled: false } } } })
      await startConnected(off)
      await new Promise((r) => setTimeout(r, 100))
      expect(off.ingested).toHaveLength(0)
    })

    it('starts fresh when the API key changes', async () => {
      writeFileSync(join(dataDir, 'state.json'), JSON.stringify({ key: 'other-key-print', offset: 0 }))
      server.pushMessage({ type: 'text', text: { body: 'belongs to the old key' }, timestamp: minutesAgo(5) })
      const h = makeAdapter()
      await startConnected(h)
      await new Promise((r) => setTimeout(r, 100))
      expect(h.ingested).toHaveLength(0)
      expect(h.logs.some((l) => l.includes('API key changed'))).toBe(true)
    })
  })

  describe('send()', () => {
    it('sends WhatsApp-formatted text quoting the parent and returns the wamid', async () => {
      const h = makeAdapter()
      await startConnected(h)
      const inboundId = server.pushMessage({ type: 'text', text: { body: 'q' } })
      await until(() => h.ingested.length === 1)

      const result = await h.adapter.send(outbound({ payload: '**done**', sourceMeta: h.ingested[0].sourceMeta }))
      expect(result).toEqual({ success: true, sourceMeta: { chat_id: CREATOR, message_id: 'wamid.OUT2' } })
      expect(server.sent[0].body).toMatchObject({ messaging_product: 'whatsapp', to: CREATOR, type: 'text', text: { body: '*done*' }, context: { message_id: inboundId } })
    })

    it('resends without the quote when the quoted message is no longer accepted', async () => {
      const h = makeAdapter()
      await startConnected(h)
      const result = await h.adapter.send(outbound({ sourceMeta: { chat_id: CREATOR, message_id: 'wamid.EXPIRED' } }))
      expect(result.success).toBe(true)
      expect(server.sent).toHaveLength(1)
      expect(server.sent[0].body.context).toBeUndefined()
    })

    it('splits text over 4096 characters into ordered parts', async () => {
      const h = makeAdapter()
      await startConnected(h)
      const long = `${'a'.repeat(3000)}\n\n${'b'.repeat(3000)}`
      expect((await h.adapter.send(outbound({ payload: long }))).success).toBe(true)
      expect(server.sent.map((s) => (s.body.text as { body: string }).body)).toEqual(['a'.repeat(3000), 'b'.repeat(3000)])
    })

    it('rejects phone numbers and other recipients before calling the API', async () => {
      const h = makeAdapter()
      await startConnected(h)
      server.pushMessage({ type: 'text', text: { body: 'hi' } })
      await until(() => h.ingested.length === 1)
      const result = await h.adapter.send(outbound({ recipientId: '15551234567' }))
      expect(result.success).toBe(false)
      expect(result.error).toContain(`"whatsapp_agent:${CREATOR}"`)
      expect(server.sent).toHaveLength(0)
    })

    it('explains the creator-only rule on 403', async () => {
      const h = makeAdapter()
      await startConnected(h)
      const result = await h.adapter.send(outbound({ recipientId: 'user:999' }))
      expect(result.success).toBe(false)
      expect(result.error).toMatch(/only lets an agent message the person who created it/)
    })

    it('retries rate limits and 131016, but not unknown-outcome 500s', async () => {
      const h = makeAdapter()
      await startConnected(h)
      server.failNextSends.push({ status: 429, code: 130429 }, { status: 503, code: 131016 })
      expect((await h.adapter.send(outbound())).success).toBe(true)
      expect(server.sent).toHaveLength(1)

      server.failNextSends.push({ status: 500, code: 2 })
      const r = await h.adapter.send(outbound())
      expect(r.success).toBe(false)
      expect(r.error).toMatch(/may or may not have been delivered/)
      expect(server.sent).toHaveLength(1)
    })

    it('uploads attachments and maps them onto sendable types', async () => {
      const h = makeAdapter()
      await startConnected(h)
      const result = await h.adapter.send(outbound({
        payload: 'files',
        attachments: [
          { path: 'a.png', filename: 'a.png', mimeType: 'image/png', size: 3, data: Buffer.from('png') },
          { path: 'n.csv', filename: 'n.csv', mimeType: 'text/csv', size: 3, data: Buffer.from('1,2') },
          { path: 'v.wav', filename: 'v.wav', mimeType: 'audio/wav', size: 3, data: Buffer.from('wav') }
        ]
      }))
      expect(result.success).toBe(true)
      expect(server.sent.map((s) => s.type)).toEqual(['text', 'image', 'document', 'audio'])
      expect(server.sent[2].body.document).toMatchObject({ filename: 'n.csv' })
      const mimes = [...server.uploads.values()].map((u) => u.mime)
      expect(mimes).toEqual(['image/png', 'application/octet-stream', 'audio/ogg'])
      expect([...server.uploads.values()][2].data.toString()).toBe('ogg-bytes')
    })

    it('reports a too-large attachment without re-sending what went out', async () => {
      const h = makeAdapter()
      await startConnected(h)
      const big = Buffer.alloc(5 * 1024 * 1024 + 1)
      const result = await h.adapter.send(outbound({
        attachments: [{ path: 'b.jpg', filename: 'b.jpg', mimeType: 'image/jpeg', size: big.length, data: big }]
      }))
      expect(result.success).toBe(false)
      expect(result.error).toMatch(/The text was delivered, but 1 attachment\(s\) failed — "b.jpg": .*5 MB limit for images/)
      expect(result.sourceMeta).toMatchObject({ chat_id: CREATOR })
    })
  })

  it('canDeliver accepts only user:<id> while connected', async () => {
    const h = makeAdapter()
    expect(h.adapter.canDeliver(CREATOR)).toBe(false)
    await startConnected(h)
    expect(h.adapter.canDeliver(CREATOR)).toBe(true)
    expect(h.adapter.canDeliver('15551234567')).toBe(false)
  })

  it('getChatInfo describes the 1:1 chat with the creator', async () => {
    const h = makeAdapter()
    await startConnected(h)
    server.pushMessage({ type: 'text', text: { body: 'hi' } })
    await until(() => h.ingested.length === 1)
    const info = await h.adapter.getChatInfo(CREATOR)
    expect(info).toMatchObject({
      supported: true,
      info: { chat_type: 'dm', participants: [{ id: `agent:${AGENT_ID}`, role: 'self' }, { id: CREATOR, name: 'Alex', role: 'creator' }] }
    })
  })
})

describe('splitText', () => {
  it('prefers paragraph, then line, then word breaks', () => {
    expect(splitText('short', 10)).toEqual(['short'])
    expect(splitText('aaaa bbbb cccc', 10)).toEqual(['aaaa bbbb', 'cccc'])
    expect(splitText('x'.repeat(25), 10)).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)])
  })
})

function minutesAgo(n: number): string {
  return String(Math.floor(Date.now() / 1000) - n * 60)
}

function fingerprintOf(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}
