/**
 * W3-A DOC_* daemon-mode handlers (documents/doc-handlers.ts): each answers
 * what the embedded handler answers, built from the /agents/:id resource
 * routes, against a scripted daemon.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('./daemon-mode-electron')).electronStub.module)

import { electronStub } from './daemon-mode-electron'
import { createFakeClientSession, createFakeDaemon } from './daemon-mode-fakes'
import { IPC } from '../../src/shared/constants/ipc-channels'
import { createStudioDaemonClient } from '../../src/main/backend/daemon-mode/credentials'
import { findRunningAgent, type DaemonModeContext } from '../../src/main/backend/daemon-mode/context'
import { DaemonModeSession } from '../../src/main/backend/daemon-mode/session'
import { DOC_HANDLERS } from '../../src/main/backend/daemon-mode/documents/doc-handlers'
import { DAEMON_MODE_UNAVAILABLE } from '../../src/main/backend/daemon-mode/errors'

const BASE = 'http://127.0.0.1:47391'
const AGENT = '7c0e4b2a-1d3f-4a5b-8c6d-9e0f1a2b3c4d'
const OTHER = '7c0e4b2a-1d3f-4a5b-8c6d-9e0f1a2b3c99'

let dir: string
let file: string
const daemon = createFakeDaemon(BASE)
const rawPuts: Array<{ query: Record<string, string>; bytes: Buffer; contentType: string | null }> = []
const quiet = { log: () => {}, warn: () => {}, error: () => {} }
const client = createStudioDaemonClient({ baseUrl: BASE, source: { token: () => 'tok' }, fetch: daemon.fetch })
let session: DaemonModeSession
let ctx: DaemonModeContext

function call(channel: string, ...args: unknown[]): Promise<any> {
  return Promise.resolve(DOC_HANDLERS[channel as keyof typeof DOC_HANDLERS]!(ctx, {} as never, ...args))
}

function lastRequest(method: string, path: string) {
  return daemon.requests.filter((r) => r.method === method && r.path === path).at(-1)
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'adf-doc-handlers-'))
  file = join(dir, 'agent-1.adf')
  // Octet-stream uploads go through the global fetch; JSON requests through the client's.
  vi.stubGlobal('fetch', (async (input: string, init?: RequestInit) => {
    if (init?.method === 'PUT' && String(input).includes('/files/raw')) {
      const url = new URL(String(input))
      const headers = (init.headers ?? {}) as Record<string, string>
      rawPuts.push({ query: Object.fromEntries(url.searchParams.entries()), bytes: Buffer.from(init.body as Uint8Array), contentType: headers['Content-Type'] ?? null })
      return new Response(JSON.stringify({ agentId: AGENT, success: true, path: url.searchParams.get('unique') === 'true' ? 'up (2).bin' : url.searchParams.get('path'), size: 1 }), { status: 200 })
    }
    return daemon.fetch(input, init)
  }) as typeof fetch)
})

afterAll(() => {
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(async () => {
  daemon.requests.length = 0
  daemon.routes.clear()
  rawPuts.length = 0
  const fake = createFakeClientSession(() => AGENT)
  fake.holdsAvailable = true
  session = new DaemonModeSession(fake, quiet)
  ctx = {
    mode: 'local',
    session,
    ready: async () => client,
    runningAgentAt: (filePath: string) => findRunningAgent(client, filePath),
    raw: async (path: string, query?: Record<string, string | number | undefined>) =>
      daemon.fetch(client.url(path, query), { headers: client.headers({ Accept: '*/*' }) }),
    log: quiet,
  } as unknown as DaemonModeContext
  daemon.routes.set('GET /files/agent', () => ({ filePath: file, agentId: AGENT, loaded: false, tracked: false }))
})

afterEach(() => { electronStub.calls.length = 0 })

async function open(): Promise<void> {
  await session.openFile(file, async () => null)
}

describe('DOC_* without an open file', () => {
  it('answers embedded\'s no-workspace values, without a request', async () => {
    expect(await call(IPC.DOC_GET_DOCUMENT)).toEqual({ content: '' })
    expect(await call(IPC.DOC_SET_DOCUMENT, { content: 'x' })).toEqual({ success: false })
    expect(await call(IPC.DOC_GET_AGENT_CONFIG)).toBeNull()
    expect(await call(IPC.DOC_SET_AGENT_CONFIG, { id: AGENT })).toEqual({ success: false, error: 'No file open' })
    expect(await call(IPC.DOC_GET_CHAT_OLDER, { beforeSeq: 5 })).toEqual({ uiLog: [], earlierCount: 0 })
    expect(await call(IPC.DOC_GET_INBOX)).toEqual({ inbox: null })
    expect(await call(IPC.DOC_GET_OUTBOX)).toEqual({ outbox: null })
    expect(await call(IPC.DOC_ADD_TIMER, { mode: 'once_delay', delay_ms: 5, scope: ['agent'] })).toEqual({ success: false, error: 'No workspace open' })
    expect(await call(IPC.DOC_GET_LOGS)).toEqual({ logs: [], count: 0 })
    expect(await call(IPC.DOC_IMPORT_PATHS, { paths: [] })).toEqual({ success: false, count: 0 })
    expect(await call(IPC.DOC_QUERY_LOCAL_TABLE, { table: 'local_x' })).toEqual({ columns: [], rows: [] })
    expect(daemon.requests).toEqual([])
  })
})

describe('DOC_* on the open file', () => {
  beforeEach(open)

  it('a 404 for the agent itself is the visible "open it again" refusal, never an empty answer', async () => {
    daemon.routes.set(`GET /agents/${AGENT}/document`, () => ({ status: 404, body: { error: `Unknown agent "${AGENT}"`, code: 'not_found' } }))
    await expect(call(IPC.DOC_GET_DOCUMENT)).rejects.toThrow('is not open in the ADF daemon any more. Open it again.')
  })

  it('DOC_GET_INBOX lists unread, read, archived in that order', async () => {
    daemon.routes.set(`GET /agents/${AGENT}/inbox`, ({ query }) => ({ agentId: AGENT, messages: [{ id: query.status, status: query.status }] }))
    expect(await call(IPC.DOC_GET_INBOX)).toEqual({ inbox: { version: 1, messages: [
      { id: 'unread', status: 'unread' }, { id: 'read', status: 'read' }, { id: 'archived', status: 'archived' },
    ] } })
  })

  it('DOC_CLEAR_INBOX deletes and leaves the INBOX_UPDATED push to the stream', async () => {
    daemon.routes.set(`DELETE /agents/${AGENT}/inbox`, () => ({ agentId: AGENT, success: true, deleted: 2 }))
    electronStub.pushes.length = 0
    expect(await call(IPC.DOC_CLEAR_INBOX)).toEqual({ success: true })
    expect(electronStub.pushes).toEqual([])
  })

  it('DOC_GET_OUTBOX strips the routing and payload columns', async () => {
    daemon.routes.set(`GET /agents/${AGENT}/outbox`, () => ({ agentId: AGENT, messages: [
      { id: 'm1', content: 'hi', original_message: '{}', address: 'a', network: 'n', attachments: [], meta: {}, status: 'sent' },
    ] }))
    expect(await call(IPC.DOC_GET_OUTBOX)).toEqual({ outbox: { messages: [{ id: 'm1', content: 'hi', status: 'sent' }] } })
  })

  it('DOC_GET_TASKS drops the daemon\'s always-approve affordance; DOC_GET_LOGS asks for embedded\'s 500 and counts', async () => {
    daemon.routes.set(`GET /agents/${AGENT}/tasks`, () => ({ agentId: AGENT, tasks: [{ id: 't1', tool: 'x', status: 'pending_approval', canAlwaysApprove: false, alwaysApproveBlockedReason: 'r' }] }))
    expect(await call(IPC.DOC_GET_TASKS, {})).toEqual({ tasks: [{ id: 't1', tool: 'x', status: 'pending_approval' }] })
    daemon.routes.set(`GET /agents/${AGENT}/logs`, () => ({ agentId: AGENT, logs: [{ id: 1 }, { id: 2 }] }))
    expect(await call(IPC.DOC_GET_LOGS, {})).toEqual({ logs: [{ id: 1 }, { id: 2 }], count: 2 })
    expect(lastRequest('GET', `/agents/${AGENT}/logs`)?.query).toEqual({ limit: '500' })
  })

  it('DOC_SET_AGENT_CONFIG refuses another agent\'s config, as embedded', async () => {
    daemon.routes.set(`GET /agents/${AGENT}/config`, () => ({ agentId: AGENT, config: { id: AGENT, name: 'agent-1' } }))
    expect(await call(IPC.DOC_SET_AGENT_CONFIG, { id: OTHER, name: 'agent-1' })).toEqual({ success: false, error: 'Save refused: config belongs to a different agent file' })
    expect(lastRequest('PUT', `/agents/${AGENT}/config`)).toBeUndefined()
  })

  it('DOC_SET_AGENT_CONFIG: a running agent\'s rename is deferred (GET /files/agent pendingName)', async () => {
    daemon.routes.set(`GET /agents/${AGENT}/config`, () => ({ agentId: AGENT, config: { id: AGENT, name: 'agent-1' } }))
    daemon.routes.set(`PUT /agents/${AGENT}/config`, ({ body }) => ({ agentId: AGENT, success: true, config: body }))
    daemon.routes.set('GET /files/agent', () => ({ filePath: file, agentId: AGENT, loaded: true, tracked: false, pendingName: 'agent-2' }))
    expect(await call(IPC.DOC_SET_AGENT_CONFIG, { id: AGENT, name: 'agent-2' })).toEqual({ success: true, renameDeferred: true })
    // Name unchanged: no rename to report, even with an older pending one.
    expect(await call(IPC.DOC_SET_AGENT_CONFIG, { id: AGENT, name: 'agent-1' })).toEqual({ success: true })
  })

  it('DOC_SET_AGENT_CONFIG: an open document\'s file follows the name now, and the session follows the file', async () => {
    const moved = join(dir, 'agent-2.adf')
    daemon.routes.set(`GET /agents/${AGENT}/config`, () => ({ agentId: AGENT, config: { id: AGENT, name: 'agent-1' } }))
    daemon.routes.set(`PUT /agents/${AGENT}/config`, ({ body }) => ({ agentId: AGENT, success: true, config: body, filePath: moved }))
    expect(await call(IPC.DOC_SET_AGENT_CONFIG, { id: AGENT, name: 'agent-2' })).toEqual({ success: true, filePath: moved })
    expect(session.filePath).toBe(moved)
  })

  it('DOC_ADD_TIMER answers embedded\'s refusals before any request and keeps a loop only for agent scope', async () => {
    expect(await call(IPC.DOC_ADD_TIMER, { mode: 'once_at', at: 1, scope: ['agent'] })).toEqual({ success: false, error: 'Timestamp must be in the future' })
    expect(await call(IPC.DOC_ADD_TIMER, { mode: 'cron', scope: ['agent'] })).toEqual({ success: false, error: 'Cron expression required' })
    expect((await call(IPC.DOC_ADD_TIMER, { mode: 'cron', cron: 'not a cron', scope: ['agent'] })).error).toMatch(/^Invalid cron: /)
    expect(await call(IPC.DOC_ADD_TIMER, { mode: 'bogus', scope: ['agent'] })).toEqual({ success: false, error: 'Invalid mode' })
    // A loop the config does not declare is refused before the timer request.
    daemon.routes.set(`GET /agents/${AGENT}/config`, () => ({ agentId: AGENT, config: { loops: [] } }))
    expect(await call(IPC.DOC_ADD_TIMER, { mode: 'once_delay', delay_ms: 10, scope: ['agent'], loop: 'side' })).toEqual({ success: false, error: 'Unknown loop "side". Available: main' })
    expect(daemon.requests.filter((r) => r.path.endsWith('/timers'))).toEqual([])
    daemon.routes.set(`POST /agents/${AGENT}/timers`, () => ({ agentId: AGENT, success: true, id: 7 }))
    expect(await call(IPC.DOC_ADD_TIMER, { mode: 'once_delay', delay_ms: 10, scope: ['system'], loop: 'main' })).toEqual({ success: true, id: 7 })
    expect(lastRequest('POST', `/agents/${AGENT}/timers`)?.body).toEqual({ mode: 'once_delay', delay_ms: 10, scope: ['system'] })
  })

  it('DOC_ADD_TIMER checks a side loop against the declared loops, agent running or not', async () => {
    // Not running: a declared loop is a valid target (the timer fires once the
    // agent runs). The Timers dialog offers every declared loop.
    daemon.routes.set(`GET /agents/${AGENT}/config`, () => ({ agentId: AGENT, config: { loops: [{ name: 'side', goal: '', enabled: true }] } }))
    daemon.routes.set(`POST /agents/${AGENT}/timers`, () => ({ agentId: AGENT, success: true, id: 8 }))
    expect(await call(IPC.DOC_ADD_TIMER, { mode: 'once_delay', delay_ms: 10, scope: ['agent'], loop: 'other' })).toEqual({ success: false, error: 'Unknown loop "other". Available: main, side' })
    expect(await call(IPC.DOC_ADD_TIMER, { mode: 'once_delay', delay_ms: 10, scope: ['agent'], loop: 'side' })).toEqual({ success: true, id: 8 })
    expect(lastRequest('POST', `/agents/${AGENT}/timers`)?.body).toMatchObject({ loop: 'side' })
  })

  it('DOC_UPDATE_TIMER never moves a timer to another loop', async () => {
    daemon.routes.set(`PUT /agents/${AGENT}/timers/3`, () => ({ agentId: AGENT, success: false }))
    expect(await call(IPC.DOC_UPDATE_TIMER, { id: 3, mode: 'once_delay', delay_ms: 10, scope: ['agent'], loop: 'side' })).toEqual({ success: false })
    expect(lastRequest('PUT', `/agents/${AGENT}/timers/3`)?.body).toEqual({ mode: 'once_delay', delay_ms: 10, scope: ['agent'] })
  })

  it('DOC_CLEAR_CHAT refuses a side loop of an agent that is not running, in embedded\'s words', async () => {
    expect(await call(IPC.DOC_CLEAR_CHAT, { loop: 'side' })).toEqual({ success: false, error: 'No loop named "side"' })
    daemon.routes.set(`DELETE /agents/${AGENT}/chat`, () => ({ agentId: AGENT, loop: 'main', success: true }))
    expect(await call(IPC.DOC_CLEAR_CHAT)).toEqual({ success: true })
    expect(lastRequest('DELETE', `/agents/${AGENT}/chat`)?.query).toEqual({ loop: 'main' })
  })

  it('local tables: names are checked as embedded checks them; a failed query is an answer', async () => {
    expect(await call(IPC.DOC_QUERY_LOCAL_TABLE, { table: 'adf_meta' })).toEqual({ columns: [], rows: [], error: 'Invalid table name' })
    expect(await call(IPC.DOC_DROP_LOCAL_TABLE, { table: 'adf_audit' })).toEqual({ success: false, error: 'Invalid table name' })
    daemon.routes.set(`GET /agents/${AGENT}/tables/local_x`, () => ({ status: 500, body: { error: 'no such table: local_x' } }))
    expect(await call(IPC.DOC_QUERY_LOCAL_TABLE, { table: 'local_x' })).toEqual({ columns: [], rows: [], error: 'Error: no such table: local_x' })
    daemon.routes.set(`GET /agents/${AGENT}/tables/adf_audit`, () => ({ agentId: AGENT, columns: ['a'], rows: [{ a: 1 }] }))
    expect(await call(IPC.DOC_QUERY_LOCAL_TABLE, { table: 'adf_audit' })).toEqual({ columns: ['a'], rows: [{ a: 1 }] })
    expect(lastRequest('GET', `/agents/${AGENT}/tables/adf_audit`)?.query).toEqual({ limit: '100', offset: '0' })
  })

  it('DOC_RENAME_INTERNAL_FILE and DOC_RENAME_FOLDER answer a failure as embedded\'s String(error)', async () => {
    daemon.routes.set(`POST /agents/${AGENT}/files/rename`, () => ({ status: 500, body: { error: 'File is read-only' } }))
    expect(await call(IPC.DOC_RENAME_INTERNAL_FILE, { oldPath: 'a', newPath: 'b' })).toEqual({ success: false, error: 'Error: File is read-only' })
    daemon.routes.set(`POST /agents/${AGENT}/files/rename-folder`, () => ({ agentId: AGENT, success: true, count: 3 }))
    expect(await call(IPC.DOC_RENAME_FOLDER, { oldPrefix: 'a', newPrefix: 'b' })).toEqual({ success: true, count: 3 })
  })

  it('DOC_UPLOAD_FILE sends the bytes as octet-stream, application/octet-stream when no type is given', async () => {
    expect(await call(IPC.DOC_UPLOAD_FILE, { path: 'up.bin', data: [1, 2, 3], unique: true })).toEqual({ success: true, path: 'up (2).bin' })
    expect(rawPuts).toEqual([{ query: { path: 'up.bin', mimeType: 'application/octet-stream', unique: 'true' }, bytes: Buffer.from([1, 2, 3]), contentType: 'application/octet-stream' }])
  })

  it('DOC_IMPORT_PATHS walks folders under their own name and lets the daemon type each file', async () => {
    const src = join(dir, 'drop')
    mkdirSync(join(src, 'sub'), { recursive: true })
    writeFileSync(join(src, 'a.md'), 'A')
    writeFileSync(join(src, 'sub', 'b.txt'), 'B')
    const single = join(dir, 'c.json')
    writeFileSync(single, '{}')
    expect(await call(IPC.DOC_IMPORT_PATHS, { paths: [src, single] })).toEqual({ success: true, count: 3 })
    expect(rawPuts.map((p) => p.query).sort((a, b) => a.path.localeCompare(b.path))).toEqual([{ path: 'c.json' }, { path: 'drop/a.md' }, { path: 'drop/sub/b.txt' }])
    expect(await call(IPC.DOC_IMPORT_PATHS, { paths: [join(dir, 'missing')] })).toEqual({ success: false, count: 0 })
  })

  it('DOC_DOWNLOAD_INTERNAL_FILE: a missing file is embedded\'s "File not found"; the bytes go where the save dialog says', async () => {
    daemon.routes.set(`GET /agents/${AGENT}/files/raw`, ({ query }) => query.path === 'there.txt'
      ? { status: 200, raw: 'bytes' }
      : { status: 404, body: { error: `Unknown file "${query.path}"`, code: 'not_found' } })
    expect(await call(IPC.DOC_DOWNLOAD_INTERNAL_FILE, { path: 'gone.txt' })).toEqual({ success: false, error: 'File not found' })
    const dest = join(dir, 'saved.txt')
    const dialogs = electronStub.module.dialog as Record<string, unknown>
    dialogs.showSaveDialog = async (opts: unknown) => { electronStub.calls.push({ api: 'dialog.showSaveDialog', args: [opts] }); return { canceled: false, filePath: dest } }
    expect(await call(IPC.DOC_DOWNLOAD_INTERNAL_FILE, { path: 'there.txt' })).toEqual({ success: true })
    expect(readFileSync(dest, 'utf-8')).toBe('bytes')
    expect(electronStub.calls.find((c) => c.api === 'dialog.showSaveDialog')?.args[0]).toMatchObject({ defaultPath: 'there.txt' })
  })

  it('meta keys are path-encoded; protection goes along only when given', async () => {
    daemon.routes.set(`PUT /agents/${AGENT}/meta/a%2Fb`, () => ({ agentId: AGENT, success: true }))
    expect(await call(IPC.DOC_SET_META, { key: 'a/b', value: 'v' })).toEqual({ success: true })
    expect(daemon.requests.at(-1)?.body).toEqual({ value: 'v' })
  })
})
