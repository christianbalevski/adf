/**
 * Remote mode in Studio main (design §9.3, tracker W4-B), on a scripted
 * daemon: the daemon-side picker behind every channel that would open a
 * native dialog, the upload of a file of this computer, and the sentence of
 * each `remote-unsupported` channel (never a raw error).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('./daemon-mode-electron')).electronStub.module)

/** Every fs stat main makes, to prove a network path never reaches the file system. */
const statCalls = vi.hoisted(() => [] as string[])
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  const stat = ((p: Parameters<typeof real.stat>[0], ...rest: unknown[]) => { statCalls.push(String(p)); return (real.stat as (...a: unknown[]) => unknown)(p, ...rest) }) as typeof real.stat
  return { ...real, stat, default: { ...real, stat } }
})

import { electronStub } from './daemon-mode-electron'
import { createFakeClientSession, createFakeDaemon } from './daemon-mode-fakes'
import { IPC } from '../../src/shared/constants/ipc-channels'
import { CHANNEL_MAP, type ChannelEntry, type MappedChannel } from '../../src/main/backend/channel-map'
import { registerDaemonModeHandlers, REMOTE_BROWSER_SESSION_SENTENCE, type DaemonModeHandle } from '../../src/main/backend/daemon-mode'
import { REMOTE_MODE_HANDLERS, REMOTE_OWNER_IDENTITY_SENTENCE } from '../../src/main/backend/daemon-mode/remote/handlers'
import { RemotePicker } from '../../src/main/backend/daemon-mode/remote/picker'
import type { RemotePickRequest } from '../../src/shared/types/backend.types'
import { _resetLocalOpenGrants, grantLocalOpen, unsafeLocalPath } from '../../src/main/backend/local-open-grants'

const BASE = 'https://adf.example.test:8443'
const HOST = 'adf.example.test:8443'
const AGENT = '7d2e4f6a-8b1c-4d3e-9f5a-6b7c8d9e0f01'
const SERVER_FILE = '/srv/agents/agent-1.adf'
const TOKEN = 'r'.repeat(43)

let dir: string
let localAdf: string
let handle: DaemonModeHandle
const daemon = createFakeDaemon(BASE)
const uploads: Array<{ query: Record<string, string>; bytes: Buffer; headers: Record<string, string> }> = []
const logs: string[] = []
const log = { log: (m: string) => { logs.push(m) }, warn: (m: string) => { logs.push(m) }, error: (m: string) => { logs.push(String(m)) } }

/** The scripted daemon, plus a streamed upload body read the way the daemon reads it. */
const fetchWithUploads = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input))
  if (url.pathname === '/files/import' && init?.body && typeof init.body !== 'string') {
    const bytes = Buffer.from(await new Response(init.body as ReadableStream).arrayBuffer())
    uploads.push({ query: Object.fromEntries(url.searchParams), bytes, headers: init.headers as Record<string, string> })
    const name = url.searchParams.get('name')
    return new Response(JSON.stringify({ success: true, filePath: `${url.searchParams.get('directory')}/${name}.adf`, name, agentId: AGENT, reviewed: false, size: bytes.length }), { status: 201 })
  }
  return daemon.fetch(input, init)
}) as typeof fetch

const invoke = (channel: string, ...args: unknown[]) => Promise.resolve(electronStub.handlers.get(channel)!({}, ...args)) as Promise<any>
const picks = () => electronStub.pushes.filter((p) => p.channel === IPC.REMOTE_PICKER_REQUEST).map((p) => p.args[0] as RemotePickRequest)
let answered = 0
/** Wait for the next pick request and answer it as the renderer's picker would. */
async function answerPick(answer: unknown): Promise<RemotePickRequest> {
  await vi.waitFor(() => expect(picks().length).toBeGreaterThan(answered))
  const request = picks()[answered++]
  expect(await invoke(IPC.REMOTE_PICKER_RESPOND, request.requestId, answer)).toBe(true)
  return request
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'adf-daemon-mode-remote-files-'))
  localAdf = join(dir, 'agent-9.adf')
  writeFileSync(localAdf, Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(4096, 7)]))
  daemon.routes.set('GET /agents', () => [])
  daemon.routes.set('GET /approvals', () => ({ pending: [], history: [] }))
  const session = createFakeClientSession(() => AGENT)
  session.holdsAvailable = true
  handle = registerDaemonModeHandlers({
    mode: 'remote',
    userDataDir: dir,
    connect: async () => ({ baseUrl: BASE, logFile: null, description: 'a remote fake daemon', source: { token: () => TOKEN } }),
    leases: { registerClient: async () => {} },
    fetch: fetchWithUploads,
    createSession: () => session,
    log,
  })
  expect(await handle.ready).toBe(true)
})

afterAll(async () => {
  await handle.shutdown()
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  daemon.requests.length = 0
  uploads.length = 0
  electronStub.dialogResponse = 0
  daemon.routes.set('GET /files/agent', ({ query }) => (query.path === SERVER_FILE || query.path.startsWith('/srv/')
    ? { filePath: query.path, agentId: AGENT, loaded: false, tracked: true }
    : { status: 404, body: { error: `No such file: ${query.path}`, code: 'not_found' } }))
  daemon.routes.set(`GET /agents/${AGENT}/identity/password`, () => ({ agentId: AGENT, needsPassword: false, unlocked: false }))
  daemon.routes.set(`GET /agents/${AGENT}/status`, () => ({ status: 404, body: { error: `Unknown agent "${AGENT}"` } }))
})

describe('remote-variant channels: the daemon-side picker (§9.3)', () => {
  it('FILE_OPEN without a path asks the picker for an agent on the daemon host and opens it there', async () => {
    const opened = invoke(IPC.FILE_OPEN)
    const request = await answerPick({ path: SERVER_FILE })
    expect(request).toMatchObject({ kind: 'open-adf', host: HOST, title: `Open an agent on ${HOST}` })
    expect(await opened).toEqual({ success: true, filePath: SERVER_FILE, agentWasRunning: false })
    expect(electronStub.calls.filter((c) => c.api === 'dialog.showOpenDialog')).toEqual([])
  })

  it('a cancelled pick answers Cancelled', async () => {
    const opened = invoke(IPC.FILE_OPEN)
    await answerPick(null)
    expect(await opened).toEqual({ success: false, error: 'Cancelled' })
  })

  it('a daemon path goes into Open Recent but never into the OS recent documents (the Windows shell may contact a UNC host)', async () => {
    const before = electronStub.calls.length
    expect((await invoke(IPC.FILE_OPEN, { filePath: SERVER_FILE })).success).toBe(true)
    expect(electronStub.calls.slice(before).filter((c) => c.api === 'app.addRecentDocument')).toEqual([])
    // Kept under remote mode's own key, which a switch to embedded leaves behind (W5-D3).
    expect(handle.clientSettings.get('remoteRecentFiles')).toContain(SERVER_FILE)
    expect(handle.clientSettings.get('recentFiles') ?? []).not.toContain(SERVER_FILE)
  })

  it('FILE_OPEN of a path the daemon has opens it without asking', async () => {
    expect(await invoke(IPC.FILE_OPEN, { filePath: SERVER_FILE })).toEqual({ success: true, filePath: SERVER_FILE, agentWasRunning: false })
    expect(uploads).toEqual([])
  })

  it('FILE_OPEN of a file this computer handed over (OS open, Open Recent) offers an upload; on yes it streams the copy into the picked folder and opens it', async () => {
    grantLocalOpen(localAdf)
    const shown = electronStub.calls.length
    const opened = invoke(IPC.FILE_OPEN, { filePath: localAdf })
    const request = await answerPick({ path: '/srv/agents' })
    expect(request).toMatchObject({ kind: 'folder', within: 'import', title: `Upload agent-9.adf to a folder on ${HOST}` })
    expect(await opened).toEqual({ success: true, filePath: '/srv/agents/agent-9.adf', agentWasRunning: false })
    const box = electronStub.calls.slice(shown).find((c) => c.api === 'dialog.showMessageBox')?.args[0] as { message: string; detail: string; buttons: string[] }
    expect(box.message).toBe(`agent-9.adf is on this computer, not on ${HOST}.`)
    // The full local path, so the user sees which file would travel.
    expect(box.detail.startsWith(localAdf)).toBe(true)
    expect(box.buttons).toEqual(['Upload a copy…', 'Cancel'])
    expect(uploads).toHaveLength(1)
    expect(uploads[0].query).toEqual({ directory: '/srv/agents', name: 'agent-9', unique: 'true' })
    expect(uploads[0].bytes.subarray(0, 15).toString()).toBe('SQLite format 3')
    expect(uploads[0].bytes.length).toBe(16 + 4096)
    expect(uploads[0].headers).toMatchObject({ Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/octet-stream' })
  })

  it('declining the upload sends nothing', async () => {
    grantLocalOpen(localAdf)
    electronStub.dialogResponse = 1
    expect(await invoke(IPC.FILE_OPEN, { filePath: localAdf })).toEqual({ success: false, error: 'Cancelled' })
    expect(uploads).toEqual([])
  })

  it('a path main did not hand over is never read from this disk: a daemon cannot get a local file offered (W4-B review)', async () => {
    _resetLocalOpenGrants()
    statCalls.length = 0
    const shown = electronStub.calls.length
    const answer = await invoke(IPC.FILE_OPEN, { filePath: localAdf })
    // It says only what is known: this computer was not looked at.
    expect(answer).toMatchObject({ success: false, error: expect.stringMatching(/No agent file at .*To upload a file of this computer, open it with ADF Studio from the file manager, or start ADF Studio with its path on the command line.$/) })
    expect(answer.error).not.toMatch(/none on this computer/)
    expect(statCalls).toEqual([])
    expect(electronStub.calls.slice(shown).filter((c) => c.api === 'dialog.showMessageBox')).toEqual([])
    expect(uploads).toEqual([])
  })

  it.each(['\\\\attacker.example\\share\\agent-1.adf', '//attacker.example/share/agent-1.adf', '\\\\?\\UNC\\attacker\\s\\a.adf', '\\\\.\\pipe\\x.adf'])('no file-system call for the network or device path %s, even when granted', async (p) => {
    grantLocalOpen(p)
    statCalls.length = 0
    const answer = await invoke(IPC.FILE_OPEN, { filePath: p })
    expect(answer.success).toBe(false)
    expect(statCalls).toEqual([])
    expect(unsafeLocalPath(p, 'win32')).toMatch(/network or device/)
  })

  it('unsafeLocalPath refuses relative and device paths', () => {
    expect(unsafeLocalPath('agent.adf', 'win32')).toMatch(/not an absolute path/)
    expect(unsafeLocalPath('C:\\agents\\CON.adf', 'win32')).toMatch(/device/)
    expect(unsafeLocalPath('C:\\agents\\agent-1.adf', 'win32')).toBeNull()
    expect(unsafeLocalPath('/home/me/agent-1.adf', 'linux')).toBeNull()
    expect(unsafeLocalPath('agent-1.adf', 'linux')).toMatch(/not an absolute path/)
  })

  it('a handed-over path on neither machine is a sentence that says this computer was looked at', async () => {
    grantLocalOpen(join(dir, 'missing.adf'))
    const answer = await invoke(IPC.FILE_OPEN, { filePath: join(dir, 'missing.adf') })
    expect(answer.success).toBe(false)
    expect(answer.error).toMatch(new RegExp(`No agent file at .*missing\\.adf on ${HOST}.*none on this computer`))
  })

  it('FILE_CREATE picks a folder and a name on the daemon host; replace only when the picker confirmed it', async () => {
    const bodies: unknown[] = []
    daemon.routes.set('POST /agents/create', ({ body }) => { bodies.push(body); return { agentId: AGENT, name: 'agent-5', filePath: '/srv/agents/agent-5.adf', did: 'did:key:z6Mk' } })
    const created = invoke(IPC.FILE_CREATE, { name: 'Untitled' })
    const request = await answerPick({ directory: '/srv/agents', name: 'agent-5' })
    expect(request).toMatchObject({ kind: 'save-adf', defaultName: 'Untitled' })
    expect(await created).toEqual({ success: true, filePath: '/srv/agents/agent-5.adf' })
    const replaced = invoke(IPC.FILE_CREATE, { name: 'agent-5' })
    await answerPick({ directory: '/srv/agents', name: 'agent-5', replace: true })
    await replaced
    expect(bodies).toEqual([
      { name: 'agent-5', directory: '/srv/agents', load: false },
      { name: 'agent-5', directory: '/srv/agents', replace: true, load: false },
    ])
  })

  it('TRACKED_DIRS_ADD, DIALOG_PICK_DIRECTORY and MCP_PICK_ADF_FILE pick on the daemon host', async () => {
    daemon.routes.set('GET /tracked-dirs', () => ({ directories: [{ path: '/srv/agents' }] }))
    daemon.routes.set('POST /tracked-dirs', ({ body }) => ({ directories: ['/srv/agents', (body as { path: string }).path] }))
    const tracked = invoke(IPC.TRACKED_DIRS_ADD)
    expect((await answerPick({ path: '/srv/more' })).kind).toBe('folder')
    expect(await tracked).toEqual({ directories: ['/srv/agents', '/srv/more'] })

    const folder = invoke(IPC.DIALOG_PICK_DIRECTORY)
    await answerPick({ path: '/srv/agents' })
    expect(await folder).toEqual({ path: '/srv/agents' })

    const mcp = invoke(IPC.MCP_PICK_ADF_FILE)
    expect((await answerPick({ path: SERVER_FILE })).kind).toBe('open-adf')
    expect(await mcp).toEqual({ filePath: SERVER_FILE, fileName: 'agent-1.adf' })
  })

  it('an answer of the wrong shape cancels the pick', async () => {
    const opened = invoke(IPC.FILE_OPEN)
    await vi.waitFor(() => expect(picks().length).toBeGreaterThan(answered))
    const request = picks()[answered++]
    // An open-adf pick must name an .adf file.
    expect(await invoke(IPC.REMOTE_PICKER_RESPOND, request.requestId, { path: '/srv/agents' })).toBe(false)
    expect(await opened).toEqual({ success: false, error: 'Cancelled' })
  })

  it('REMOTE_FS_BROWSE lists through GET /fs/browse and answers refusals as values', async () => {
    daemon.routes.set('GET /fs/browse', ({ query }) => (query.path === '/etc'
      ? { status: 403, body: { error: 'Outside the folders this daemon lists (home, tracked folders, agents folder, ADF_DAEMON_BROWSE_ROOTS): /etc', code: 'outside_roots' } }
      : { path: query.path ?? null, parent: null, roots: [{ path: '/srv/agents', kind: 'agents' }], entries: [], truncated: false }))
    expect(await invoke(IPC.REMOTE_FS_BROWSE, {})).toMatchObject({ path: null, roots: [{ path: '/srv/agents', kind: 'agents' }] })
    expect(await invoke(IPC.REMOTE_FS_BROWSE, { path: '/etc' })).toEqual({ error: expect.stringMatching(/^Outside the folders/), code: 'outside_roots' })
    expect(daemon.requests.filter((r) => r.path === '/fs/browse').map((r) => r.query)).toEqual([{}, { path: '/etc' }])
  })
})

describe('remote-unsupported channels: each shows its sentence, never a raw error', () => {
  const unsupported = (Object.entries(CHANNEL_MAP) as Array<[MappedChannel, ChannelEntry]>)
    .filter(([, e]) => e.class === 'remote-unsupported' && e.kind === 'invoke')
    .map(([channel]) => channel)

  const ARGS: Partial<Record<MappedChannel, unknown[]>> = {
    [IPC.FILE_REVEAL]: [{ filePath: SERVER_FILE }],
    [IPC.TEMPLATE_REVEAL]: [{ id: 'base' }],
    [IPC.COMPUTE_BROWSER_INFO]: [{ agentName: 'agent-1', agentId: AGENT }],
    [IPC.IDENTITY_REVEAL]: [{ purpose: 'app:token' }],
    [IPC.IDENTITY_OWNER_IMPORT]: ['abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'],
    [IPC.PROVIDER_CREDENTIAL_GET]: [{ filePath: SERVER_FILE, providerId: 'p1' }],
  }

  it('covers every remote-unsupported invoke channel', () => {
    expect(unsupported.sort()).toEqual([
      IPC.FILE_REVEAL, IPC.TEMPLATE_REVEAL, IPC.COMPUTE_BROWSER_INFO, IPC.IDENTITY_GET, IPC.IDENTITY_REVEAL,
      IPC.IDENTITY_OWNER_REVEAL_MNEMONIC, IPC.IDENTITY_OWNER_CONFIRM_BACKUP, IPC.IDENTITY_OWNER_IMPORT, IPC.PROVIDER_CREDENTIAL_GET,
    ].sort())
  })

  // IDENTITY_GET answers a value slot (placeholder or null), covered in daemon-mode-remote-values.test.ts.
  it.each([
    IPC.FILE_REVEAL, IPC.TEMPLATE_REVEAL, IPC.COMPUTE_BROWSER_INFO, IPC.IDENTITY_REVEAL,
    IPC.IDENTITY_OWNER_REVEAL_MNEMONIC, IPC.IDENTITY_OWNER_CONFIRM_BACKUP, IPC.IDENTITY_OWNER_IMPORT, IPC.PROVIDER_CREDENTIAL_GET,
  ])('%s', async (channel) => {
    await handle.session.openFile(SERVER_FILE, async () => AGENT)
    daemon.routes.set('GET /templates', () => ({ folder: '/srv/adf/templates', templates: [] }))
    daemon.routes.set('GET /compute/browser-info', () => ({ containerName: 'adf-agent-1', hostPort: 6080, phase: 'ready' }))
    const before = electronStub.calls.length
    daemon.routes.set(`GET /agents/${AGENT}/identity`, () => ({ purposes: [] }))
    // An answer, never a rejection: the renderer shows answers; a rejection is a raw error (W4-B review).
    const answer = await invoke(channel, ...(ARGS[channel as MappedChannel] ?? []))
    const text = JSON.stringify(answer ?? null)
    const boxes = electronStub.calls.slice(before).filter((c) => c.api === 'dialog.showMessageBox').map((c) => JSON.stringify(c.args[0]))
    const shown = [text, ...boxes].join('\n')
    expect(shown).not.toMatch(/not available in daemon mode yet|W4-B|HTTP \d{3}|Unknown agent/)
    expect(shown).toMatch(/daemon host|daemon's machine|on adf\.example\.test|remote (ADF )?daemon|on its machine|on that host|on the server|remote server/i)
  })

  it('FILE_REVEAL of a path with control characters shows it escaped and offers no Copy', async () => {
    const before = electronStub.calls.length
    await invoke(IPC.FILE_REVEAL, { filePath: '/srv/agents/a\u001b[31m\u202eevil.adf' })
    const box = electronStub.calls.slice(before).find((c) => c.api === 'dialog.showMessageBox')?.args[0] as { detail: string; buttons: string[] }
    expect(box.buttons).toEqual(['OK'])
    expect(box.detail).toContain('a\\u001b[31m\\u202eevil.adf')
    expect(electronStub.calls.slice(before).some((c) => c.api === 'clipboard.writeText')).toBe(false)
  })

  it('FILE_REVEAL shows the daemon path as text, with a Copy button', async () => {
    electronStub.dialogResponse = 1
    const before = electronStub.calls.length
    await invoke(IPC.FILE_REVEAL, { filePath: SERVER_FILE })
    const calls = electronStub.calls.slice(before)
    expect(calls.find((c) => c.api === 'dialog.showMessageBox')?.args[0]).toMatchObject({ message: `This file is on ${HOST}.`, buttons: ['OK', 'Copy path'] })
    expect(calls.find((c) => c.api === 'clipboard.writeText')?.args).toEqual([SERVER_FILE])
  })

  it('owner import never sends the phrase to a remote daemon', async () => {
    expect(await invoke(IPC.IDENTITY_OWNER_IMPORT, 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about')).toEqual({ success: false, error: REMOTE_OWNER_IDENTITY_SENTENCE })
    expect(daemon.requests.filter((r) => r.path.startsWith('/identity'))).toEqual([])
  })

  it('a browser session push is replaced by a notice: its viewer is on the server\'s loopback', async () => {
    const pushes = electronStub.pushes.length
    const calls = electronStub.calls.length
    handle.bridge.handleFrame({ kind: 'push', topic: 'browser_session', agentId: AGENT, filePath: SERVER_FILE, payload: { agentId: AGENT, agentName: 'agent-1', agentFilePath: SERVER_FILE, containerName: 'adf-agent-1', hostPort: 6080, timestamp: 1 } })
    expect(electronStub.pushes.slice(pushes).filter((p) => p.channel === IPC.COMPUTE_BROWSER_SESSION)).toEqual([])
    expect(electronStub.calls.slice(calls).find((c) => c.api === 'Notification.new')?.args[0]).toMatchObject({ body: `agent-1 ${REMOTE_BROWSER_SESSION_SENTENCE}` })
  })
})

describe('RemotePicker', () => {
  const quiet = { log: () => {}, warn: () => {} }
  it('no window: cancelled at once; no answer in time: cancelled; answers are checked for their kind', async () => {
    const noWindow = new RemotePicker({ send: () => false, host: () => 'h', log: quiet })
    expect(await noWindow.pick('folder', 't')).toBeNull()
    expect(noWindow.waiting).toBe(0)

    const slow = new RemotePicker({ send: () => true, host: () => 'h', log: quiet, timeoutMs: 20 })
    expect(await slow.pick('folder', 't')).toBeNull()

    const sent: RemotePickRequest[] = []
    const picker = new RemotePicker({ send: (r) => { sent.push(r); return true }, host: () => 'h', log: quiet })
    const save = picker.pick('save-adf', 't', { defaultName: 'x' })
    expect(picker.respond(sent[0].requestId, { directory: '/srv', name: 'a/b' })).toBe(false)
    expect(await save).toBeNull()
    const ok = picker.pick('save-adf', 't')
    expect(picker.respond(sent[1].requestId, { directory: '/srv', name: 'agent-3.adf', replace: true })).toBe(true)
    expect(await ok).toEqual({ directory: '/srv', name: 'agent-3', replace: true })
    expect(picker.respond('unknown', { path: '/x' })).toBe(false)
    const pending = picker.pick('open-adf', 't')
    picker.cancelAll()
    expect(await pending).toBeNull()
  })

  it('remote handlers exist only for remote-variant and remote-unsupported channels', () => {
    for (const channel of Object.keys(REMOTE_MODE_HANDLERS)) {
      const entry = CHANNEL_MAP[channel as MappedChannel]
      expect(['remote-variant', 'remote-unsupported'], channel).toContain(entry.class)
    }
  })
})

describe('provider keys shown as the placeholder', () => {
  it('SETTINGS_SET refuses a key made from the placeholder and passes the untouched one to the daemon', async () => {
    const patches: unknown[] = []
    daemon.routes.set('PATCH /settings', ({ body }) => { patches.push(body); return {} })
    await expect(invoke(IPC.SETTINGS_SET, { providers: [{ id: 'p1', name: 'OpenAI', apiKey: '__redacted_' }] })).rejects.toThrow(/API key of OpenAI was shown as a placeholder/)
    expect(patches).toEqual([])
    expect(await invoke(IPC.SETTINGS_SET, { providers: [{ id: 'p1', name: 'OpenAI', apiKey: '__redacted__' }] })).toEqual({ success: true })
    expect(patches).toHaveLength(1)
  })

  it("SETTINGS_SET refuses a Settings → MCP env value made from the placeholder, in the per-agent forms' sentence", async () => {
    const patches: unknown[] = []
    daemon.routes.set('PATCH /settings', ({ body }) => { patches.push(body); return {} })
    const servers = (value: string) => ({ mcpServers: [{ id: 'mcp:acme', name: 'acme', type: 'npm', env: [{ key: 'API_KEY', value }] }] })
    for (const edited of ['__redacted_', '__redacted__abc', '__redaXcted__']) {
      await expect(invoke(IPC.SETTINGS_SET, servers(edited)), edited).rejects.toThrow('The value of API_KEY was shown as a placeholder (a remote ADF daemon never sends stored values), so an edit of it cannot be saved. Clear the field and type the whole value.')
    }
    expect(patches).toEqual([])
    expect(await invoke(IPC.SETTINGS_SET, servers('k-2'))).toEqual({ success: true })
    expect(patches).toEqual([servers('k-2')])
  })
})

// Last: it ends the shared connection.
describe('remote connection: a 401 after connecting', () => {
  it('is the refused-token sentence and ends the connection (no endless retry)', async () => {
    daemon.routes.set('GET /tracked-dirs', () => ({ status: 401, body: { error: 'Unauthorized' } }))
    await expect(invoke(IPC.TRACKED_DIRS_GET)).rejects.toThrow()
    expect(handle.connection.state).toMatchObject({ state: 'failed', message: expect.stringMatching(/refused the token; choose Add device on \S+ and pair again\./) })
  })
})
