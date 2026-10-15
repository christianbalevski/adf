/**
 * W3-F multi-client write conflicts on one daemon: revisions on reads and
 * writes of config, document and files; `409 stale_revision` for a write over
 * a revision someone else replaced; change frames that carry the revision and
 * the writer; and the whole path from a second client's refused save to the
 * "changed elsewhere" notice in Studio's editor (Studio's daemon-mode DOC_*
 * handlers and the renderer's save layer, against the real daemon).
 */
import { mkdtempSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  const dir = join(tmpdir(), `adf-daemon-write-conflicts-${process.pid}`)
  return {
    app: { getPath: () => dir, on: () => {}, getName: () => 'adf-daemon-write-conflicts', getVersion: () => '0.0.0-test' },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (s: string) => Buffer.from(s, 'utf-8'),
      decryptString: (b: Buffer) => b.toString('utf-8'),
    },
    shell: { openExternal: async () => {} },
    ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
    BrowserWindow: class {},
    dialog: {},
  }
})

import { createDaemonHttpApi } from '../src/main/daemon/http-api'
import { RuntimeService } from '../src/main/runtime/runtime-service'
import { AgentRuntimeBuilder } from '../src/main/runtime/agent-runtime-builder'
import { withSource } from '../src/main/runtime/execution-context'
import { createHeadlessAgent, MockLLMProvider } from '../src/main/runtime/headless'
import { clearAllUmbilicalBuses } from '../src/main/runtime/umbilical-bus'
import { DaemonClient, DaemonError, type ClientFrame, type EventStream } from '../src/shared/daemon-client'
import { IPC } from '../src/shared/constants/ipc-channels'
import { createStudioDaemonClient } from '../src/main/backend/daemon-mode/credentials'
import { findRunningAgent, type DaemonModeContext } from '../src/main/backend/daemon-mode/context'
import { DaemonModeSession } from '../src/main/backend/daemon-mode/session'
import { DOC_HANDLERS } from '../src/main/backend/daemon-mode/documents/doc-handlers'
import { createFakeClientSession } from './backend/daemon-mode-fakes'
import { useEditorTabsStore } from '../src/renderer/stores/editor-tabs.store'
import { conflictMessage, saveTabContent, type SaveAnswer } from '../src/renderer/utils/edit-conflict'
import type { AgentConfig } from '../src/shared/types/adf-v02.types'

afterAll(() => clearAllUmbilicalBuses())
vi.setConfig({ testTimeout: 30_000 })

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
  useEditorTabsStore.getState().reset()
})

async function waitFor(check: () => boolean, ms = 8000, what = 'condition'): Promise<void> {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, 10))
  }
}

function agentFile(dir: string, name: string): { filePath: string; agentId: string } {
  const filePath = join(dir, `${name}.adf`)
  const created = createHeadlessAgent({ filePath, name, provider: new MockLLMProvider() })
  const agentId = created.workspace.getAgentConfig().id
  created.dispose()
  return { filePath, agentId }
}

async function daemon(opts: { load?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'adf-write-conflicts-'))
  const one = agentFile(dir, 'agent-1')
  const runtime = new RuntimeService({
    settings: { get: (k: string) => (k === 'reviewedAgents' ? [one.agentId] : undefined) },
    providerFactory: () => new MockLLMProvider(),
    agentRuntimeBuilder: new AgentRuntimeBuilder(),
  })
  cleanups.push(async () => { for (const agent of runtime.listAgents()) await runtime.unloadAgent(agent.id, { mode: 'immediate' }).catch(() => {}) })
  const server = createDaemonHttpApi(runtime, {})
  await server.listen({ host: '127.0.0.1', port: 0 })
  cleanups.push(() => server.close())
  const baseUrl = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`
  if (opts.load !== false) await runtime.loadAgent(one.filePath)
  return { runtime, server, baseUrl, client: new DaemonClient({ baseUrl }), one }
}

interface Reader { sessionId: string; frames: ClientFrame[]; stream: EventStream<ClientFrame> }

async function reader(client: DaemonClient, name: string, focus: string): Promise<Reader> {
  const { sessionId } = await client.createClientSession({ client: name, version: '1' })
  await client.setClientSessionFocus(sessionId, focus)
  const out: Reader = { sessionId, frames: [], stream: null as never }
  let open = false
  out.stream = client.clientSessionEvents(sessionId, {
    onEvent: (frame) => { out.frames.push(frame) },
    onState: (info) => { if (info.state === 'open') open = true },
    minBackoffMs: 20,
    maxBackoffMs: 50,
  }).start()
  cleanups.push(() => out.stream.close())
  await waitFor(() => open, 5000, 'stream open')
  return out
}

/** The 409 body of a refused write. */
async function refusal(write: Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await write
  } catch (err) {
    if (err instanceof DaemonError && err.status === 409) return err.body as Record<string, unknown>
    throw err
  }
  throw new Error('the write was not refused')
}

/** The file_updated / document_updated / config_changed frames a session got: what, revision, writer. */
function changes(r: Reader): Array<{ what: string; revision: unknown; writer: unknown }> {
  return r.frames.flatMap((f) => {
    if (f.kind === 'executor' && (f.event.type === 'file_updated' || f.event.type === 'document_updated')) {
      const p = f.event.payload as { path?: string; revision?: unknown; writer?: unknown }
      return [{ what: f.event.type === 'file_updated' ? `file:${p.path}` : 'document', revision: p.revision, writer: p.writer }]
    }
    if (f.kind === 'push' && f.topic === 'config_changed') return [{ what: 'config', revision: f.payload.revision, writer: f.payload.writer }]
    return []
  })
}

describe('revisions over HTTP', () => {
  it('reads carry revisions; a write over a stale one is refused with 409 stale_revision; no base is last write wins', async () => {
    const { client, server, one } = await daemon()
    const a = `/agents/${one.agentId}`

    const config = await client.request<{ config: AgentConfig; revision: number }>('GET', `${a}/config`)
    const doc = await client.request<{ content: string; revision: number }>('GET', `${a}/document`)
    expect(config.revision).toEqual(expect.any(Number))
    expect(doc.revision).toEqual(expect.any(Number))
    // A batch (Studio's file open) names the same revisions.
    expect(await client.request('GET', `${a}/batch`)).toMatchObject({ configRevision: config.revision, documentRevision: doc.revision })

    // Document: a save over the read revision, then a second one over the same base.
    const saved = await client.request<{ revision: number }>('PUT', `${a}/document`, { body: { content: '# one', baseRevision: doc.revision } })
    expect(saved.revision).toBeGreaterThan(doc.revision)
    const stale = await refusal(client.request('PUT', `${a}/document`, { body: { content: '# two', baseRevision: doc.revision } }))
    expect(stale).toMatchObject({ code: 'stale_revision', resource: 'document', revision: saved.revision, baseRevision: doc.revision, writer: { kind: 'cli' }, size: 5, hash: expect.stringMatching(/^[0-9a-f]{40}$/) })
    expect(stale.error).toBe(`The document changed by the CLI or another API client since revision ${doc.revision} (now ${saved.revision}). Reload it, or save again with baseRevision ${saved.revision} to overwrite.`)
    expect((await client.document(one.agentId)).content).toBe('# one')
    // If-Match carries the base too; a base that is not a revision is a 400.
    const ifMatch = await server.inject({ method: 'PUT', url: `${a}/document`, headers: { 'if-match': `"${saved.revision}"` }, payload: { content: '# three' } })
    expect(ifMatch.statusCode).toBe(200)
    expect((await server.inject({ method: 'PUT', url: `${a}/document`, payload: { content: 'x', baseRevision: 'abc' } })).json()).toMatchObject({ code: 'bad_request' })
    // No base: replaces whatever is there, as every write did before revisions.
    expect(await client.request('PUT', `${a}/document`, { body: { content: '# last write wins' } })).toMatchObject({ success: true, revision: expect.any(Number) })

    // Config: the base is a query parameter (the body is the config).
    const configSaved = await client.request<{ revision: number }>('PUT', `${a}/config`, { body: { ...config.config, description: 'first' }, query: { baseRevision: config.revision } })
    expect(await refusal(client.request('PUT', `${a}/config`, { body: { ...config.config, description: 'second' }, query: { baseRevision: config.revision } })))
      .toMatchObject({ code: 'stale_revision', resource: 'config', revision: configSaved.revision })
    expect((await client.config(one.agentId)).config.description).toBe('first')

    // Files: created without a base, then the read's revision guards the next write; raw reads name it too.
    const created = await client.request<{ revision: number }>('PUT', `${a}/files/content`, { query: { path: 'notes.md' }, body: { content: 'v1' } })
    const read = await client.request<{ revision: number; content: string }>('GET', `${a}/files/content`, { query: { path: 'notes.md' } })
    expect(read.revision).toBe(created.revision)
    const raw = await server.inject({ method: 'GET', url: `${a}/files/raw?path=notes.md` })
    expect(raw.headers['x-adf-revision']).toBe(String(created.revision))
    await client.request('PUT', `${a}/files/content`, { query: { path: 'notes.md' }, body: { content: 'v2', baseRevision: read.revision } })
    expect(await refusal(client.request('PUT', `${a}/files/content`, { query: { path: 'notes.md' }, body: { content: 'v3', baseRevision: read.revision } })))
      .toMatchObject({ code: 'stale_revision', resource: 'notes.md' })
    // If-Match: * is no base; a create (If-None-Match: *, or mustNotExist) refuses an existing file.
    expect((await server.inject({ method: 'PUT', url: `${a}/files/content?path=notes.md`, headers: { 'if-match': '*' }, payload: { content: 'v4' } })).statusCode).toBe(200)
    expect((await server.inject({ method: 'PUT', url: `${a}/files/content?path=notes.md`, headers: { 'if-none-match': '*' }, payload: { content: 'v5' } })).json()).toMatchObject({ code: 'stale_revision', resource: 'notes.md', writer: { kind: 'cli' } })
    expect(await refusal(client.request('PUT', `${a}/files/content`, { query: { path: 'notes.md' }, body: { content: 'v5', mustNotExist: true } }))).toMatchObject({ code: 'stale_revision' })
    expect(await client.request('PUT', `${a}/files/content`, { query: { path: 'brand-new.md' }, body: { content: 'new', mustNotExist: true } })).toMatchObject({ success: true })
    // mind.md through its own route.
    const mind = await client.request<{ revision: number }>('GET', `${a}/mind`)
    await client.request('PUT', `${a}/mind`, { body: { content: 'remember', baseRevision: mind.revision } })
    expect(await refusal(client.request('PUT', `${a}/mind`, { body: { content: 'forget', baseRevision: mind.revision } }))).toMatchObject({ resource: 'mind.md' })
  })

  it('an agent write while a client holds a revision: its frame names the agent, and the client\'s save is refused naming the agent', async () => {
    const { client, runtime, one } = await daemon()
    const tui = await reader(client, 'tui', one.agentId)
    const a = `/agents/${one.agentId}`
    await client.request('PUT', `${a}/files/content`, { query: { path: 'notes.md' }, body: { content: 'v1' } })
    const held = await client.request<{ revision: number }>('GET', `${a}/files/content`, { query: { path: 'notes.md' } })

    // The agent's own write (a tool in its turn): the workspace's file-change choke point.
    withSource('agent:turn-1', one.agentId, () => { runtime.getLoadedAgent(one.agentId)!.agent.workspace.writeFile('notes.md', 'from the agent') })
    await waitFor(() => changes(tui).some(c => c.what === 'file:notes.md' && (c.writer as { kind?: string })?.kind === 'agent'), 5000, 'agent frame')
    const agentFrame = changes(tui).filter(c => c.what === 'file:notes.md').at(-1)!
    expect(agentFrame.revision).toBeGreaterThan(held.revision)

    const stale = await refusal(client.withClientSession(tui.sessionId).request('PUT', `${a}/files/content`, { query: { path: 'notes.md' }, body: { content: 'from the tui', baseRevision: held.revision } }))
    expect(stale).toMatchObject({ revision: agentFrame.revision, writer: { kind: 'agent' } })
  })
})

describe('writers of writes that run after an await', () => {
  it('PUT files/raw from a client session is that client\'s write, not the agent\'s', async () => {
    const { client, server, one } = await daemon()
    const tui = await reader(client, 'tui', one.agentId)
    const a = `/agents/${one.agentId}`
    const before = await client.request<{ revision: number }>('GET', `${a}/files/content`, { query: { path: 'data.txt' } }).catch(() => null)
    expect(before).toBeNull()
    const absent = (await server.inject({ method: 'GET', url: `${a}/files/meta?path=data.txt` })).statusCode
    expect(absent).toBe(404)

    const put = await server.inject({
      method: 'PUT',
      url: `${a}/files/raw?path=data.txt`,
      headers: { 'content-type': 'application/octet-stream', 'x-adf-client-session': tui.sessionId },
      payload: Buffer.from('uploaded by the terminal app'),
    })
    expect(put.statusCode).toBe(200)
    const uploaded = put.json() as { revision: number }
    expect(uploaded.revision).toEqual(expect.any(Number))
    // A stale write names who made the current revision: the terminal app.
    const stale = await refusal(client.request('PUT', `${a}/files/content`, { query: { path: 'data.txt' }, body: { content: 'x', baseRevision: uploaded.revision - 1 } }))
    expect(stale).toMatchObject({ revision: uploaded.revision, writer: { kind: 'client', client: 'tui' } })
    // And so does the change frame another session gets.
    const studio = await reader(client, 'studio', one.agentId)
    await server.inject({ method: 'PUT', url: `${a}/files/raw?path=data.txt`, headers: { 'content-type': 'application/octet-stream', 'x-adf-client-session': tui.sessionId }, payload: Buffer.from('again') })
    await waitFor(() => changes(studio).some(c => c.what === 'file:data.txt'), 5000, 'raw frame')
    expect(changes(studio).find(c => c.what === 'file:data.txt')?.writer).toEqual({ kind: 'client', client: 'tui' })
  })
})

describe('two clients, one document', () => {
  it('the second save is refused naming the first; frames carry revision and writer; Studio\'s editor shows the notice and Keep mine saves', async () => {
    const { client, baseUrl, one } = await daemon()
    const studio = await reader(client, 'studio', one.agentId)
    const tui = await reader(client, 'tui', one.agentId)
    const a = `/agents/${one.agentId}`
    const asTui = client.withClientSession(tui.sessionId)

    // Studio main in daemon mode: its DOC_* handlers over a client of its session.
    const studioClient = createStudioDaemonClient({ baseUrl, source: { token: () => undefined } }).withClientSession(studio.sessionId)
    const fakeSession = createFakeClientSession(() => one.agentId)
    fakeSession.holdsAvailable = true
    const session = new DaemonModeSession(fakeSession, { log: () => {}, warn: () => {}, error: () => {} })
    const ctx = {
      mode: 'local',
      session,
      ready: async () => studioClient,
      runningAgentAt: (filePath: string) => findRunningAgent(studioClient, filePath),
      raw: async (path: string, query?: Record<string, string | number | undefined>) => fetch(studioClient.url(path, query), { headers: studioClient.headers({ Accept: '*/*' }) }),
      log: { log: () => {}, warn: () => {}, error: () => {} },
    } as unknown as DaemonModeContext
    await session.openFile(one.filePath, async () => null)
    const ipc = (channel: string, ...args: unknown[]) => Promise.resolve(DOC_HANDLERS[channel as keyof typeof DOC_HANDLERS]!(ctx, {} as never, ...args)) as Promise<any>

    // Both open the document at the same revision; Studio's editor tab holds it.
    const studioDoc = await ipc(IPC.DOC_GET_DOCUMENT)
    const tuiDoc = await asTui.request<{ content: string; revision: number }>('GET', `${a}/document`)
    expect(studioDoc.revision).toBe(tuiDoc.revision)
    const tabs = useEditorTabsStore.getState
    tabs().openTab('README.md', studioDoc.content, false, undefined, studioDoc.revision)

    // The terminal app saves first. Studio gets the change with the revision and the writer; the TUI gets no echo.
    const tuiSaved = await asTui.request<{ revision: number }>('PUT', `${a}/document`, { body: { content: '# From the terminal', baseRevision: tuiDoc.revision } })
    await waitFor(() => changes(studio).some(c => c.what === 'document'), 5000, 'document frame')
    expect(changes(studio)).toEqual([{ what: 'document', revision: tuiSaved.revision, writer: { kind: 'client', client: 'tui' } }])
    expect(changes(tui)).toEqual([])

    // Studio's save over the revision it read (the user typed before the change arrived): refused, the text kept, the notice names the terminal app.
    tabs().updateTabContent('README.md', '# From Studio')
    const write = (text: string, baseRevision: number | undefined): Promise<SaveAnswer> => ipc(IPC.DOC_SET_DOCUMENT, { content: text, ...(baseRevision !== undefined ? { baseRevision } : {}) })
    const outcome = await saveTabContent('README.md', '# From Studio', write)
    expect(outcome).toEqual({ kind: 'conflict', conflict: { content: '# From the terminal', revision: tuiSaved.revision, writer: { kind: 'client', client: 'tui' } } })
    const conflicted = tabs().tabs[0]
    expect(conflicted).toMatchObject({ content: '# From Studio', isDirty: true })
    expect(conflictMessage('README.md', conflicted.conflict!.writer)).toBe('README.md was changed by the terminal app while you were editing.')
    expect((await asTui.request<{ content: string }>('GET', `${a}/document`)).content).toBe('# From the terminal')

    // Keep mine: saved over the terminal's revision; the terminal app gets it, naming Studio.
    tabs().resolveTabConflict('README.md', 'keep')
    expect(await saveTabContent('README.md', '# From Studio', write)).toMatchObject({ kind: 'saved' })
    expect((await asTui.request<{ content: string }>('GET', `${a}/document`)).content).toBe('# From Studio')
    await waitFor(() => changes(tui).length > 0, 5000, 'tui frame')
    expect(changes(tui)).toEqual([{ what: 'document', revision: tabs().tabs[0].revision, writer: { kind: 'client', client: 'studio' } }])

    // Config through Studio's handler: a stale base answers the conflict with the config now.
    const { config, revision } = await asTui.request<{ config: AgentConfig; revision: number }>('GET', `${a}/config`)
    await asTui.request('PUT', `${a}/config`, { body: { ...config, description: 'from the terminal' }, query: { baseRevision: revision } })
    const refused = await ipc(IPC.DOC_SET_AGENT_CONFIG, { ...config, description: 'from Studio' }, { baseRevision: revision })
    expect(refused).toMatchObject({ success: false, conflict: { resource: 'config', writer: { kind: 'client', client: 'tui' }, config: { description: 'from the terminal' } } })
    expect(refused.error).toBe('The config changed (by the terminal app) since you loaded it. Reload it, or keep your version.')
    expect(await ipc(IPC.DOC_SET_AGENT_CONFIG, { ...config, description: 'from Studio' }, { baseRevision: refused.conflict.revision })).toMatchObject({ success: true, revision: expect.any(Number) })
  })

  it('an open document that is not running announces config and file writes, with revision and writer, to the other session only', async () => {
    const { client, one } = await daemon({ load: false })
    const studio = await reader(client, 'studio', one.agentId)
    const tui = await reader(client, 'tui', one.agentId)
    await client.holdClientSessionDocument(studio.sessionId, { filePath: one.filePath })
    await client.holdClientSessionDocument(tui.sessionId, { filePath: one.filePath })
    const asStudio = client.withClientSession(studio.sessionId)
    const a = `/agents/${one.agentId}`

    const { config } = await asStudio.request<{ config: AgentConfig }>('GET', `${a}/config`)
    const savedConfig = await asStudio.request<{ revision: number }>('PUT', `${a}/config`, { body: { ...config, description: 'edited while stopped' } })
    const savedFile = await asStudio.request<{ revision: number }>('PUT', `${a}/files/content`, { query: { path: 'notes.md' }, body: { content: 'note' } })
    await waitFor(() => changes(tui).length >= 2, 5000, 'document frames')
    expect(changes(tui)).toEqual([
      { what: 'config', revision: savedConfig.revision, writer: { kind: 'client', client: 'studio' } },
      { what: 'file:notes.md', revision: savedFile.revision, writer: { kind: 'client', client: 'studio' } },
    ])
    await new Promise(r => setTimeout(r, 100))
    expect(changes(studio)).toEqual([])
  })
})
