import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHeadlessAgent, type HeadlessAgent } from '../../../src/main/runtime/headless'
import { mediaPlaceholder } from '../../../src/main/runtime/message-media-projection'
import { REQUEST_MEDIA_MAX_ITEMS, attachmentLabel, overLimitPlaceholder, requestMediaFloor, requestMediaLimit, resolveFileRefs } from '../../../src/main/runtime/file-ref-media'
import { AgentConfigSchema } from '../../../src/main/adf/adf-schema'
import { FileRefRegistry } from '../../../src/main/adf/file-ref-registry'
import { MeshManager } from '../../../src/main/runtime/mesh-manager'
import { parseLoopToDisplay } from '../../../src/shared/utils/loop-parser'
import { applyFileRefChanges } from '../../../src/shared/utils/file-ref'
import { createDispatch, createEvent } from '../../../src/shared/types/adf-event.types'
import type { CreateMessageOptions, LLMProvider } from '../../../src/main/providers/provider.interface'
import type { AlfMessage, Visibility } from '../../../src/shared/types/adf-v02.types'
import type { ContentBlock, LLMMessage, LLMResponse } from '../../../src/shared/types/provider.types'

// A small PNG header is enough: nothing decodes it.
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const PNG_B64 = PNG.toString('base64')
const PNG_URI = `data:image/png;base64,${PNG_B64}`

/** Answers each request from a script (default: "ok") and records what it was sent. */
class ScriptedProvider implements LLMProvider {
  readonly name = 'scripted'
  readonly modelId = 'scripted-v1'
  readonly requests: LLMMessage[][] = []
  constructor(private readonly script: Array<ContentBlock[]> = []) {}

  async createMessage(opts: CreateMessageOptions): Promise<LLMResponse> {
    this.requests.push(structuredClone(opts.messages))
    const content = this.script.shift() ?? [{ type: 'text', text: 'ok' }]
    const toolUse = content.some(block => block.type === 'tool_use')
    return { id: `r${this.requests.length}`, content, stop_reason: toolUse ? 'tool_use' : 'end_turn', usage: { input_tokens: 10, output_tokens: 1 } }
  }

  async validateConfig(): Promise<{ valid: boolean }> {
    return { valid: true }
  }

  /** The newest request as one JSON string. */
  last(): string {
    return JSON.stringify(this.requests[this.requests.length - 1])
  }
}

function chat(content: ContentBlock[]) {
  return createDispatch(createEvent({
    type: 'chat', source: 'test', data: { message: { seq: 0, role: 'user', content_json: content, created_at: 1234 } },
  }), { scope: 'agent' })
}

const agents: HeadlessAgent[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.disposeAsync({ mode: 'immediate' })
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeAgent(provider: LLMProvider, opts: { image?: boolean; filePath?: string; tools?: boolean } = {}): HeadlessAgent {
  const agent = createHeadlessAgent({
    name: 'agent-1',
    provider,
    profile: 'benchmark',
    ...(opts.filePath ? { filePath: opts.filePath } : {}),
    ...(opts.tools === false ? { registerTools() {} } : {}),
  })
  agents.push(agent)
  setImage(agent, opts.image ?? true)
  return agent
}

function setImage(agent: HeadlessAgent, image: boolean): void {
  const config = agent.executor.getConfig()
  agent.executor.updateConfig({ ...config, model: { ...config.model, multimodal: { image, audio: false, video: false } } })
}

/** Every file reference the agent's stored loop holds. */
function storedRefs(agent: HeadlessAgent) {
  return agent.workspace.getLoop().flatMap(row => row.content_json).filter(block => block.type === 'file_ref').map(block => block.file_ref!)
}

/** The System notices the agent's loop recorded about media left out. */
function systemNotices(agent: HeadlessAgent): string[] {
  return agent.workspace.getLoop().flatMap(row => row.content_json)
    .filter(b => b.type === 'text' && b.text?.startsWith('[Context: System] [System] Not sent to this model'))
    .map(b => b.text!)
}

/** Every file reference the live session holds. */
function sessionRefs(agent: HeadlessAgent) {
  return agent.session.getMessages().flatMap(m => Array.isArray(m.content) ? m.content : []).filter(b => b.type === 'file_ref').map(b => b.file_ref!)
}

describe('attachments are files; messages refer to them', () => {
  it('an inline image in a chat is saved to Files and the message keeps a reference', async () => {
    const provider = new ScriptedProvider()
    const agent = makeAgent(provider, { tools: false })
    await agent.executor.executeTurn(chat([{ type: 'text', text: 'what is this?' }, { type: 'image_url', image_url: { url: PNG_URI } }]))

    expect(agent.workspace.readFileBuffer('loop-upload/image.png')?.equals(PNG)).toBe(true)
    expect(storedRefs(agent)).toEqual([{ path: 'loop-upload/image.png', mime_type: 'image/png', size: PNG.length }])
    // No copy of the bytes in the stored loop or in the session.
    expect(JSON.stringify(agent.workspace.getLoop())).not.toContain(PNG_B64)
    expect(JSON.stringify(agent.session.getMessages())).not.toContain(PNG_B64)
    // The request carries the image itself.
    expect(provider.last()).toContain(PNG_URI)
  })

  it('a reference to an uploaded file (Studio, the CLI) takes its type and size from the file; a missing one is refused', async () => {
    const provider = new ScriptedProvider()
    const agent = makeAgent(provider, { tools: false })
    const path = agent.workspace.writeFileBufferUnique('loop-upload/photo.png', PNG, 'image/png')
    const ref: ContentBlock = { type: 'file_ref', file_ref: { path, mime_type: '', size: 0 } }
    expect(agent.executor.fileRefInputError([ref])).toBeNull()
    expect(agent.executor.fileRefInputError([{ type: 'file_ref', file_ref: { path: 'loop-upload/none.png', mime_type: 'image/png', size: 1 } }]))
      .toBe("Not in this agent's files: loop-upload/none.png. Upload the file first.")
    // The gate reads the stored type: an image for a text-only model is refused.
    setImage(agent, false)
    expect(agent.executor.mediaInputError([ref])).toContain('Image input is off')
    setImage(agent, true)
    await agent.executor.executeTurn(chat([{ type: 'text', text: 'look' }, ref]))
    expect(storedRefs(agent)).toEqual([{ path, mime_type: 'image/png', size: PNG.length }])
    expect(provider.last()).toContain(PNG_URI)
  })

  it('an image the agent reads with fs_read is a reference in history, its bytes only in the request', async () => {
    const provider = new ScriptedProvider([[{ type: 'tool_use', id: 'toolu_1', name: 'fs_read', input: { path: 'photo.png' } }]])
    const agent = makeAgent(provider)
    agent.workspace.writeFileBuffer('photo.png', PNG, 'image/png')
    await agent.executor.executeTurn(chat([{ type: 'text', text: 'read photo.png' }]))

    const row = agent.workspace.getLoop().find(r => r.content_json.some(b => b.type === 'tool_result'))!
    expect(row.content_json.map(b => b.type)).toEqual(['tool_result', 'file_ref'])
    expect(row.content_json[1].file_ref).toEqual({ path: 'photo.png', mime_type: 'image/png', size: PNG.length })
    expect(JSON.stringify(agent.workspace.getLoop())).not.toContain(PNG_B64)
    expect(provider.requests).toHaveLength(2)
    expect(JSON.stringify(provider.requests[1])).toContain(PNG_URI)
  })

  it('an inbox attachment from another agent lands in Files, and reading it leaves a reference', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-file-ref-inbox-'))
    dirs.push(dir)
    const filePath = join(dir, 'agent-1.adf')
    const provider = new ScriptedProvider([[{ type: 'tool_use', id: 'toolu_1', name: 'fs_read', input: { path: 'imported/peer/photo.png' } }]])
    const agent = createHeadlessAgent({
      filePath, name: 'agent-1', provider, profile: 'benchmark',
      createOptions: { handle: 'agent-1', messaging: { mode: 'proactive', visibility: 'localhost' as Visibility, receive: true } as never },
    })
    agents.push(agent)
    setImage(agent, true)
    const mesh = new MeshManager([dir])
    mesh.enableMesh()
    mesh.registerServableAgent(filePath, agent.workspace.getAgentConfig(), agent.registry, agent.workspace, agent.session, agent.executor)
    try {
      const message: AlfMessage = {
        version: '0.1', network: 'devnet', id: 'm-file-ref-1', timestamp: new Date(0).toISOString(),
        from: 'did:key:zPeerSenderDid0123456789', to: agent.workspace.getDid()!, reply_to: 'http://127.0.0.1:1/agents/peer/inbox',
        payload: {
          content: 'see attached', content_type: 'text/plain', sent_at: new Date(0).toISOString(), sender_alias: 'peer',
          attachments: [{ filename: 'photo.png', content_type: 'image/png', transfer: 'inline', data: PNG_B64, size_bytes: PNG.length }],
        },
      }
      const res = await mesh.processIngressMessage(filePath, message)
      expect(res.success).toBe(true)
      expect(agent.workspace.getInbox()[0].attachments![0]).toMatchObject({ transfer: 'imported', path: 'imported/peer/photo.png' })
      expect(agent.workspace.readFileBuffer('imported/peer/photo.png')?.equals(PNG)).toBe(true)

      await agent.executor.executeTurn(chat([{ type: 'text', text: 'open the attachment' }]))
      expect(storedRefs(agent)).toEqual([{ path: 'imported/peer/photo.png', mime_type: 'image/png', size: PNG.length }])
      expect(provider.last()).toContain(PNG_URI)
    } finally {
      mesh.unregisterAgent(filePath)
    }
  })
})

describe('requests resolve references; history keeps them', () => {
  it('vision → text → vision restores an image from more than 4 messages back', async () => {
    const provider = new ScriptedProvider()
    const agent = makeAgent(provider, { tools: false })
    await agent.executor.executeTurn(chat([{ type: 'text', text: 'keep this' }, { type: 'image_url', image_url: { url: PNG_URI } }]))
    for (let i = 0; i < 4; i++) await agent.executor.executeTurn(chat([{ type: 'text', text: `message ${i}` }]))
    expect(agent.session.getMessages().length).toBeGreaterThan(8)

    setImage(agent, false)
    await agent.executor.executeTurn(chat([{ type: 'text', text: 'text model now' }]))
    expect(provider.last()).not.toContain(PNG_B64)
    expect(provider.last()).toContain(mediaPlaceholder('image'))

    setImage(agent, true)
    await agent.executor.executeTurn(chat([{ type: 'text', text: 'vision again' }]))
    expect(provider.last()).toContain(PNG_URI)
    expect(storedRefs(agent)).toHaveLength(1)
  })

  it('older messages are byte-identical across requests (cached prefix)', async () => {
    const provider = new ScriptedProvider()
    const agent = makeAgent(provider, { tools: false })
    await agent.executor.executeTurn(chat([{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: PNG_URI } }]))
    await agent.executor.executeTurn(chat([{ type: 'text', text: 'and again' }]))
    await agent.executor.executeTurn(chat([{ type: 'text', text: 'once more' }]))
    const [, second, third] = provider.requests
    expect(JSON.stringify(third.slice(0, second.length))).toBe(JSON.stringify(second))
    expect(JSON.stringify(second)).toContain(PNG_URI)
  })

  it('the same resolved string is reused from request to request', async () => {
    const registry = new FileRefRegistry()
    let reads = 0
    const read = () => { reads++; return PNG }
    const limits = { image: 1_000_000, audio: 1_000_000, video: 1_000_000 }
    const all = { image: true, audio: true, video: true }
    const messages: LLMMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'file_ref', file_ref: { path: 'a.png', mime_type: 'image/png', size: PNG.length } }] }]
    const first = await resolveFileRefs(messages, registry, read, limits, all)
    messages.push({ role: 'assistant', content: [{ type: 'text', text: 'b' }] })
    const second = await resolveFileRefs(messages, registry, read, limits, all)
    expect(second.messages).toBe(first.messages)
    expect(second.messages[0]).toBe(first.messages[0])
    expect(reads).toBe(1)
    // A copy of the array (a session repair) resolves from the byte cache: no read.
    const third = await resolveFileRefs(messages.slice(), registry, read, limits, all)
    expect(JSON.stringify(third.messages)).toBe(JSON.stringify(second.messages))
    expect(reads).toBe(1)
    // A change to the file is a new read.
    registry.invalidate('a.png')
    await resolveFileRefs(messages.slice(), registry, read, limits, all)
    expect(reads).toBe(2)
  })
})

describe('deleting, renaming and moving a referenced file', () => {
  it('a deleted file leaves a tombstone: the request and the chat say [deleted: name], and the turn runs', async () => {
    const provider = new ScriptedProvider()
    const agent = makeAgent(provider, { tools: false })
    await agent.executor.executeTurn(chat([{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: PNG_URI } }]))
    expect(agent.workspace.deleteFile('loop-upload/image.png')).toBe(true)

    expect(storedRefs(agent)).toEqual([{ path: 'loop-upload/image.png', mime_type: 'image/png', size: PNG.length, deleted: true }])
    expect(sessionRefs(agent)[0].deleted).toBe(true)
    await agent.executor.executeTurn(chat([{ type: 'text', text: 'still there?' }]))
    expect(agent.executor.getState()).not.toBe('error')
    expect(provider.last()).toContain('[deleted: image.png]')
    expect(provider.last()).not.toContain(PNG_B64)

    const entry = parseLoopToDisplay(agent.workspace.getLoop()).find(e => e.type === 'user' && e.content === 'look')!
    expect(entry.metadata?.attachments).toEqual([{ path: 'loop-upload/image.png', name: 'image.png', mime_type: 'image/png', kind: 'image', deleted: true }])
    expect(entry.metadata?.imagePreviewUrls).toBeUndefined()
    // A new file at the same path does not bring the old reference back.
    agent.workspace.writeFileBuffer('loop-upload/image.png', PNG, 'image/png')
    expect(storedRefs(agent)[0].deleted).toBe(true)
  })

  it('a rename or a folder move keeps the reference, on disk and in the live session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-file-ref-rename-'))
    dirs.push(dir)
    const provider = new ScriptedProvider()
    const agent = makeAgent(provider, { tools: false, filePath: join(dir, 'agent-1.adf') })
    await agent.executor.executeTurn(chat([{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: PNG_URI } }]))

    expect(agent.workspace.renameInternalFile('loop-upload/image.png', 'pics/cat.png')).toBe(true)
    expect(storedRefs(agent).map(r => r.path)).toEqual(['pics/cat.png'])
    expect(sessionRefs(agent).map(r => r.path)).toEqual(['pics/cat.png'])
    await agent.executor.executeTurn(chat([{ type: 'text', text: 'renamed' }]))
    expect(provider.last()).toContain(PNG_URI)

    expect(agent.workspace.renameFolder('pics', 'archive/2026')).toBe(1)
    expect(storedRefs(agent).map(r => r.path)).toEqual(['archive/2026/cat.png'])
    expect(sessionRefs(agent).map(r => r.path)).toEqual(['archive/2026/cat.png'])
    await agent.executor.executeTurn(chat([{ type: 'text', text: 'moved' }]))
    expect(provider.last()).toContain(PNG_URI)
    expect(provider.last()).not.toContain('[deleted')
  })

  it('applyFileRefChanges rewrites only what the change names', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'x' },
      { type: 'file_ref', file_ref: { path: 'a.png', mime_type: 'image/png', size: 1 } },
      { type: 'file_ref', file_ref: { path: 'b.png', mime_type: 'image/png', size: 1 } },
    ]
    expect(applyFileRefChanges(blocks, [{ op: 'rename', from: 'z.png', to: 'y.png' }])).toBe(blocks)
    const renamed = applyFileRefChanges(blocks, [{ op: 'rename', from: 'a.png', to: 'c.png' }, { op: 'delete', path: 'b.png' }])
    expect(renamed.map(b => b.file_ref)).toEqual([undefined, { path: 'c.png', mime_type: 'image/png', size: 1 }, { path: 'b.png', mime_type: 'image/png', size: 1, deleted: true }])
    expect(blocks[1].file_ref!.path).toBe('a.png')
  })
})

const ALL = { image: true, audio: true, video: true }
const BIG = { image: 1_000_000, audio: 1_000_000, video: 1_000_000 }
const refMessage = (path: string, size = PNG.length): LLMMessage => ({ role: 'user', content: [{ type: 'file_ref', file_ref: { path, mime_type: 'image/png', size } }] })

describe('size and request limits', () => {
  it('a reference over the per-file limit is a placeholder with the reason', async () => {
    const registry = new FileRefRegistry()
    const messages = [refMessage('big.png', 2_000)]
    const out = await resolveFileRefs(messages, registry, () => Buffer.alloc(2_000), { image: 1_024, audio: 1, video: 1 }, ALL)
    expect(out.messages[0].content).toEqual([
      { type: 'text', text: attachmentLabel({ path: 'big.png', mime_type: 'image/png', size: 2_000 }) },
      { type: 'text', text: '[image not sent: big.png is 2.0 KB, over the 1.0 KB limit]' },
    ])
    expect(out.notSent).toEqual({ unsupported: {}, oversize: { image: 1 }, overLimit: {} })
  })

  it('past the request media limit the oldest drop to half the limit, so the window moves rarely', async () => {
    const sizes = Array.from({ length: REQUEST_MEDIA_MAX_ITEMS }, () => ({ bytes: 10 }))
    expect(requestMediaFloor(sizes)).toBe(0)
    expect(requestMediaFloor([...sizes, { bytes: 10 }])).toBe(REQUEST_MEDIA_MAX_ITEMS / 2 + 1)
    // The next nine fit without moving the window again.
    const more = [...sizes, ...Array.from({ length: 10 }, () => ({ bytes: 10 }))]
    expect(requestMediaFloor(more)).toBe(REQUEST_MEDIA_MAX_ITEMS / 2 + 1)
    // The newest file is always sent, whatever its size.
    expect(requestMediaFloor([{ bytes: 10 }, { bytes: 100 * 1024 * 1024 }])).toBe(1)

    const registry = new FileRefRegistry()
    const messages = Array.from({ length: REQUEST_MEDIA_MAX_ITEMS + 1 }, (_, i) => refMessage(`p${i}.png`))
    const out = await resolveFileRefs(messages, registry, () => PNG, BIG, ALL)
    const dropped = REQUEST_MEDIA_MAX_ITEMS / 2 + 1
    expect(out.notSent).toEqual({ unsupported: {}, oversize: {}, overLimit: { image: dropped } })
    const ref = (messages[0].content as ContentBlock[])[0].file_ref!
    expect(out.messages[0].content).toEqual([{ type: 'text', text: attachmentLabel(ref) }, { type: 'text', text: overLimitPlaceholder(ref, 'image') }])
    expect(JSON.stringify(out.messages[dropped].content)).toContain(PNG_URI)
  })

  it('every turn whose request leaves files out for the limit says so, with counts', async () => {
    const provider = new ScriptedProvider()
    const agent = makeAgent(provider, { tools: false })
    const refs: ContentBlock[] = Array.from({ length: REQUEST_MEDIA_MAX_ITEMS + 1 }, (_, i) => {
      const path = agent.workspace.writeFileBufferUnique(`loop-upload/p${i}.png`, Buffer.concat([PNG, Buffer.from([i])]), 'image/png')
      return { type: 'file_ref', file_ref: { path, mime_type: 'image/png', size: PNG.length + 1 } }
    })
    await agent.executor.executeTurn(chat([{ type: 'text', text: 'all of these' }, ...refs]))
    await agent.executor.executeTurn(chat([{ type: 'text', text: 'and now?' }]))
    const notice = '[Context: System] [System] Not sent to this model: 11 images (older than the request media limit: 20 files, 20.0 MB). The originals stay in history.'
    expect(systemNotices(agent)).toEqual([notice, notice])
  })

  it('the limit is the agent config: default when unset, an override applies, a very large one is accepted', async () => {
    expect(requestMediaLimit(undefined)).toEqual({ files: 20, bytes: 20 * 1024 * 1024 })
    expect(requestMediaLimit({ max_request_media_files: null, max_request_media_mb: null })).toEqual({ files: 20, bytes: 20 * 1024 * 1024 })
    expect(requestMediaLimit({ max_request_media_files: 1_000_000, max_request_media_mb: 1_000_000 })).toEqual({ files: 1_000_000, bytes: 1_000_000 * 1024 * 1024 })

    const provider = new ScriptedProvider()
    const agent = makeAgent(provider, { tools: false })
    const config = agent.executor.getConfig()
    agent.executor.updateConfig({ ...config, context: { ...config.context, max_request_media_files: 2 } })
    const refs: ContentBlock[] = [0, 1, 2].map(i => {
      const path = agent.workspace.writeFileBufferUnique(`loop-upload/q${i}.png`, Buffer.concat([PNG, Buffer.from([i])]), 'image/png')
      return { type: 'file_ref', file_ref: { path, mime_type: 'image/png', size: PNG.length + 1 } }
    })
    await agent.executor.executeTurn(chat([{ type: 'text', text: 'three' }, ...refs]))
    // Over 2: the oldest drop until half (1) remains.
    expect(systemNotices(agent)).toEqual(['[Context: System] [System] Not sent to this model: 2 images (older than the request media limit: 2 files, 20.0 MB). The originals stay in history.'])
    expect(provider.last()).toContain('outside the request media limit (2 files, 20.0 MB)')

    // A very large limit sends them all, with no clamping.
    agent.executor.updateConfig({ ...config, context: { ...config.context, max_request_media_files: 1_000_000, max_request_media_mb: 1_000_000 } })
    await agent.executor.executeTurn(chat([{ type: 'text', text: 'again' }]))
    expect(provider.last()).not.toContain('outside the request media limit')
    expect(systemNotices(agent)).toHaveLength(1)
  })

  it('the config schema takes any positive whole number and refuses zero and negatives', () => {
    const context = AgentConfigSchema.shape.context
    expect(context.safeParse({ max_request_media_files: 1_000_000_000, max_request_media_mb: 1_000_000_000 }).success).toBe(true)
    expect(context.safeParse({}).success).toBe(true)
    for (const bad of [0, -1, 1.5]) {
      expect(context.safeParse({ max_request_media_files: bad }).success).toBe(false)
      expect(context.safeParse({ max_request_media_mb: bad }).success).toBe(false)
    }
  })
})

describe('attachments are parts of the message', () => {
  it('the typed text is stored as typed; each file is a part, labelled for the model only in the request', async () => {
    const provider = new ScriptedProvider()
    const agent = makeAgent(provider, { tools: false })
    const path = agent.workspace.writeFileBufferUnique('loop-upload/report.pdf', Buffer.from('%PDF-1.4'), 'application/pdf')
    const image = agent.workspace.writeFileBufferUnique('loop-upload/cat.png', PNG, 'image/png')
    await agent.executor.executeTurn(chat([
      { type: 'text', text: 'what do these say?' },
      { type: 'file_ref', file_ref: { path, mime_type: '', size: 0 } },
      { type: 'file_ref', file_ref: { path: image, mime_type: '', size: 0 } },
    ]))
    const row = agent.workspace.getLoop().find(r => r.role === 'user' && r.content_json.some(b => b.type === 'file_ref'))!
    expect(row.content_json).toEqual([
      { type: 'text', text: 'what do these say?' },
      { type: 'file_ref', file_ref: { path, mime_type: 'application/pdf', size: 8 } },
      { type: 'file_ref', file_ref: { path: image, mime_type: 'image/png', size: PNG.length } },
    ])
    // One user message, multi-part: text, label, (file), label, image.
    const sent = provider.requests[0].find(m => m.role === 'user' && JSON.stringify(m.content).includes('what do these say?'))!
    expect((sent.content as ContentBlock[]).map(b => b.type)).toEqual(['text', 'text', 'text', 'image_url'])
    expect((sent.content as ContentBlock[])[0].text).toBe('what do these say?')
    expect((sent.content as ContentBlock[])[1].text).toBe('[Attached file: loop-upload/report.pdf (application/pdf, 8 B). Read it with fs_read.]')
    // The chat shows the text as typed and the files as chips.
    const entry = parseLoopToDisplay(agent.workspace.getLoop()).find(e => e.type === 'user')!
    expect(entry.content).toBe('what do these say?')
    expect((entry.metadata?.attachments as Array<{ name: string }>).map(a => a.name)).toEqual(['report.pdf', 'cat.png'])
    // The label is the same bytes on the next request.
    await agent.executor.executeTurn(chat([{ type: 'text', text: 'and?' }]))
    expect(JSON.stringify(provider.requests[1]).includes(JSON.stringify(sent))).toBe(true)
  })

  it('old rows with [Uploaded file: …] lines show those lines as chips; the stored text is unchanged', () => {
    const text = 'look at this\n\n[Uploaded file: loop-upload/notes.pdf (application/pdf, 1.2 KB). Use fs_read with path "loop-upload/notes.pdf" to inspect it.]'
    const rows = [{ seq: 1, role: 'user' as const, content_json: [{ type: 'text' as const, text }], created_at: 1 }]
    const [entry] = parseLoopToDisplay(rows)
    expect(entry.content).toBe('look at this')
    expect(entry.metadata?.attachments).toEqual([{ path: 'loop-upload/notes.pdf', name: 'notes.pdf', mime_type: 'application/pdf' }])
    expect(rows[0].content_json[0].text).toBe(text)
  })
})
