import './daemon-mode-platform'
/**
 * W3-A file handlers in daemon mode (documents/file-handlers.ts): each answer
 * has the embedded handler's shape (src/main/ipc/index.ts), error answers
 * included, and the work goes to the daemon routes.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  calls: [] as Array<{ api: string; args: unknown[] }>,
  saveDialog: { canceled: true, filePath: undefined as string | undefined },
  openDialog: { canceled: true, filePaths: [] as string[] },
  willQuit: [] as Array<() => void>,
}))

vi.mock('electron', async () => {
  const { electronStub } = await import('./daemon-mode-electron')
  const m = electronStub.module as Record<string, Record<string, unknown>>
  const call = (api: string, args: unknown[]) => { native.calls.push({ api, args }) }
  return {
    ...m,
    app: {
      ...m.app,
      getPath: () => tmpdir(),
      getAppPath: () => process.cwd(),
      getFileIcon: async () => ({ icon: true }),
      once: (event: string, fn: () => void) => { if (event === 'will-quit') native.willQuit.push(fn) },
    },
    shell: { ...m.shell, showItemInFolder: (p: string) => call('shell.showItemInFolder', [p]) },
    dialog: {
      ...m.dialog,
      showSaveDialog: async (opts: unknown) => { call('dialog.showSaveDialog', [opts]); return native.saveDialog },
      showOpenDialog: async (opts: unknown) => { call('dialog.showOpenDialog', [opts]); return native.openDialog },
    },
    nativeImage: { createFromPath: () => ({ fallback: true }) },
  }
})

import { createFakeClientSession, createFakeDaemon } from './daemon-mode-fakes'
import { IPC } from '../../src/shared/constants/ipc-channels'
import { FILE_HANDLERS, FILE_SEND_HANDLERS, _shareSnapshotCount } from '../../src/main/backend/daemon-mode/documents/file-handlers'
import { createStudioDaemonClient } from '../../src/main/backend/daemon-mode/credentials'
import { DaemonModeSession } from '../../src/main/backend/daemon-mode/session'
import { ClientSettingsStore } from '../../src/main/backend/daemon-mode/settings'
import type { DaemonModeContext } from '../../src/main/backend/daemon-mode/context'
import { DAEMON_MODE_UNAVAILABLE } from '../../src/main/backend/daemon-mode/errors'

const BASE = 'http://127.0.0.1:47386'
const AGENT_1 = '6a0f2c1e-3b4d-4f5a-8c9d-1e2f3a4b5c01'
const AGENT_2 = '6a0f2c1e-3b4d-4f5a-8c9d-1e2f3a4b5c02'
const dir = mkdtempSync(join(tmpdir(), 'adf-file-handlers-'))
const agent1 = join(dir, 'agent-1.adf')
const quiet = { log: () => {}, warn: () => {}, error: () => {} }

let daemon: ReturnType<typeof createFakeDaemon>
let ctx: DaemonModeContext
let recent: string[]

function setup(mode: 'local' | 'remote' = 'local'): void {
  daemon = createFakeDaemon(BASE)
  const client = createStudioDaemonClient({ baseUrl: BASE, source: { token: () => 't'.repeat(43) }, fetch: daemon.fetch })
  const fake = createFakeClientSession((p) => (p.endsWith('agent-2.adf') ? AGENT_2 : AGENT_1))
  fake.holdsAvailable = true
  const session = new DaemonModeSession(fake, quiet, undefined, mode === 'remote')
  recent = []
  ctx = {
    mode,
    connection: {} as never,
    session,
    // The relocate's FILE_RENAMED push has reached the window (EventBridge.awaitPush).
    bridge: { awaitPush: () => ({ done: Promise.resolve(true), cancel: () => {} }) } as never,
    clientSettings: new ClientSettingsStore(join(dir, `client-${Math.random()}.json`), quiet),
    approvals: {} as never,
    ready: async () => client,
    runningAgentAt: async () => null,
    raw: async (path, query) => daemon.fetch(client.url(path, query), { headers: client.headers({ Accept: '*/*' }) }),
    recordRecentFile: (p) => { recent.push(p) },
    hooks: {},
    log: quiet,
  }
  native.calls.length = 0
}

const call = (channel: string, ...args: unknown[]) => Promise.resolve(FILE_HANDLERS[channel as keyof typeof FILE_HANDLERS]!(ctx, {} as never, ...args))

beforeEach(() => setup())
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('FILE_SAVE', () => {
  it('answers embedded\'s refusal without a file, checkpoints the open one', async () => {
    expect(await call(IPC.FILE_SAVE)).toEqual({ success: false, error: 'No file open' })
    await ctx.session.openFile(agent1, async () => null)
    daemon.routes.set(`POST /agents/${AGENT_1}/checkpoint`, () => ({ agentId: AGENT_1, success: true }))
    expect(await call(IPC.FILE_SAVE)).toEqual({ success: true })
    daemon.routes.set(`POST /agents/${AGENT_1}/checkpoint`, () => ({ status: 500, body: { error: 'disk full' } }))
    expect(await call(IPC.FILE_SAVE)).toEqual({ success: false, error: 'Error: disk full' })
  })
})

describe('FILE_CREATE_QUICK / FILE_CREATE', () => {
  it.each(['C:\\agents', '/agents/MixedCase'])('preserves remote folder %s and uses the daemon-created name', async (folder) => {
    setup('remote')
    const made = folder + (folder.includes('\\') ? '\\' : '/') + 'Agent.adf'
    daemon.routes.set('POST /agents/create', () => ({ agentId: AGENT_2, filePath: made, name: 'Agent', did: 'did:key:z6Mk1' }))
    expect(await call(IPC.FILE_CREATE_QUICK, { folder, name: 'Agent' })).toEqual({ success: true, filePath: made, name: 'Agent', did: 'did:key:z6Mk1' })
    expect(daemon.requests.find((r) => r.path === '/agents/create')?.body).toMatchObject({ directory: folder })
    expect(ctx.session.filePath).toBe(made)
  })

  it('creates closed through the daemon, then makes the new file the open file', async () => {
    const made = join(dir, 'agent-2.adf')
    daemon.routes.set('POST /agents/create', ({ body }) => ({ status: 201, body: { agentId: AGENT_2, name: 'agent-2', filePath: made, did: 'did:key:z6Mk1', loaded: false, started: false, echo: body } }))
    const result = await call(IPC.FILE_CREATE_QUICK, { name: 'agent-2', providerId: 'p1', modelId: '', templateId: 'blank', identityDraftId: 'draft-1' })
    expect(result).toEqual({ success: true, filePath: made, name: 'agent-2', did: 'did:key:z6Mk1' })
    expect(daemon.requests.find((r) => r.path === '/agents/create')?.body).toEqual({ name: 'agent-2', provider: 'p1', template: 'blank', identityDraftId: 'draft-1', load: false })
    expect(ctx.session.filePath).toBe(made)
    expect(ctx.session.agentId).toBe(AGENT_2)
    expect(recent).toEqual([made])
  })

  it('refuses a missing folder and a taken typed name with embedded\'s sentences; a template refusal keeps its code', async () => {
    expect(await call(IPC.FILE_CREATE_QUICK, { folder: join(dir, 'nope') })).toEqual({ success: false, error: 'That folder does not exist' })
    // The test folder is under the OS temp dir: refused as embedded refuses it.
    expect(await call(IPC.FILE_CREATE_QUICK, { folder: dir })).toEqual({ success: false, error: 'Pick a folder outside the temporary directory' })
    daemon.routes.set('GET /files/agents-folder', () => ({ path: join(dir, 'adf-agents'), source: 'default', exists: true }))
    daemon.routes.set('POST /agents/create', () => ({ status: 409, body: { error: `An agent named "agent-1" already exists in ${join(dir, 'adf-agents')}.`, code: 'name_taken' } }))
    expect(await call(IPC.FILE_CREATE_QUICK, { name: 'agent-1' })).toEqual({
      success: false, code: 'name_taken', error: 'An agent named "agent-1" already exists in adf-agents.',
    })
    daemon.routes.set('POST /agents/create', () => ({ status: 422, body: { error: 'The template was refused', code: 'template_unreviewed' } }))
    expect(await call(IPC.FILE_CREATE_QUICK, {})).toEqual({ success: false, code: 'template_unreviewed', error: 'The template was refused' })
    expect(ctx.session.filePath).toBeNull()
  })

  it('FILE_CREATE: the save dialog picks the path; cancel answers Cancelled', async () => {
    native.saveDialog = { canceled: true, filePath: undefined }
    expect(await call(IPC.FILE_CREATE, { name: 'agent-2' })).toEqual({ success: false, error: 'Cancelled' })
    const made = join(dir, 'agent-2.adf')
    native.saveDialog = { canceled: false, filePath: made }
    daemon.routes.set('POST /agents/create', () => ({ status: 201, body: { agentId: AGENT_2, name: 'agent-2', filePath: made, did: 'did:key:z6Mk2', loaded: false, started: false } }))
    expect(await call(IPC.FILE_CREATE, { name: 'agent-2' })).toEqual({ success: true, filePath: made })
    expect(daemon.requests.find((r) => r.path === '/agents/create')?.body).toEqual({ name: 'agent-2', directory: dir, replace: true, load: false })
  })

  it('remote mode refuses the native save dialog with the W4-B hook', async () => {
    setup('remote')
    await expect(call(IPC.FILE_CREATE, { name: 'agent-2' })).rejects.toMatchObject({ code: DAEMON_MODE_UNAVAILABLE, message: expect.stringContaining('W4-B') })
  })
})

describe('FILE_RENAME / FILE_DELETE', () => {
  it('refuses an invalid name before the daemon; a stopped file answers without renameDeferred', async () => {
    expect(await call(IPC.FILE_RENAME, { filePath: agent1, newName: 'a/b' })).toEqual({ success: false, error: 'Name contains characters not allowed in file names.' })
    await ctx.session.openFile(agent1, async () => null)
    const renamed = join(dir, 'agent-3.adf')
    daemon.routes.set('POST /files/rename', () => ({ success: true, filePath: renamed, renameDeferred: false, agentId: AGENT_1 }))
    expect(await call(IPC.FILE_RENAME, { filePath: agent1, newName: ' agent-3 ' })).toEqual({ success: true, filePath: renamed })
    expect(daemon.requests.find((r) => r.path === '/files/rename')?.body).toEqual({ path: agent1, newName: 'agent-3' })
    expect(ctx.session.filePath).toBe(renamed)
  })

  it('a running agent: renameDeferred; a taken name: embedded\'s plain sentence', async () => {
    ctx.runningAgentAt = async () => AGENT_1
    daemon.routes.set('POST /files/rename', () => ({ success: true, filePath: agent1, renameDeferred: true, agentId: AGENT_1 }))
    expect(await call(IPC.FILE_RENAME, { filePath: agent1, newName: 'agent-3' })).toEqual({ success: true, filePath: agent1, renameDeferred: true })
    daemon.routes.set('POST /files/rename', () => ({ status: 409, body: { error: 'A file named "agent-3.adf" already exists.', code: 'name_taken' } }))
    expect(await call(IPC.FILE_RENAME, { filePath: agent1, newName: 'agent-3' })).toEqual({ success: false, error: 'A file named "agent-3.adf" already exists.' })
  })

  it('deleting the open file releases it first', async () => {
    await ctx.session.openFile(agent1, async () => null)
    daemon.routes.set('DELETE /files', () => ({ success: true, filePath: agent1, stopped: false }))
    expect(await call(IPC.FILE_DELETE, { filePath: agent1 })).toEqual({ success: true })
    expect(ctx.session.filePath).toBeNull()
    expect(daemon.requests.find((r) => r.path === '/files')?.query).toEqual({ path: agent1 })
    daemon.routes.set('DELETE /files', () => ({ status: 409, body: { error: 'agent-1 is running in the ADF daemon, pid 4242', code: 'agent_leased' } }))
    expect(await call(IPC.FILE_DELETE, { filePath: agent1 })).toEqual({ success: false, error: 'Error: agent-1 is running in the ADF daemon, pid 4242' })
  })

  it('FILE_CLONE and FILE_LIST_TABLES in embedded shapes', async () => {
    daemon.routes.set('POST /files/clone', () => ({ status: 201, body: { success: true, filePath: join(dir, 'agent-1 (2).adf'), name: 'agent-1 (2)', agentId: AGENT_2, identity: 'fresh', warnings: ['w'] } }))
    expect(await call(IPC.FILE_CLONE, { filePath: agent1, selectedTables: ['adf_loop'] })).toEqual({ success: true, filePath: join(dir, 'agent-1 (2).adf'), warnings: ['w'] })
    daemon.routes.set('GET /files/agent/tables', () => ({ filePath: agent1, loaded: false, tables: [{ name: 'adf_loop', row_count: 3 }] }))
    expect(await call(IPC.FILE_LIST_TABLES, { filePath: agent1 })).toEqual({ tables: [{ name: 'adf_loop', row_count: 3 }] })
    daemon.routes.set('GET /files/agent/tables', () => ({ status: 404, body: { error: `No such agent file: ${agent1}`, code: 'not_found' } }))
    expect(await call(IPC.FILE_LIST_TABLES, { filePath: agent1 })).toEqual({ tables: [], error: `Error: No such agent file: ${agent1}` })
  })
})

describe('review of the open file', () => {
  it('FILE_CHECK_REVIEW: needsReview with the summary; false without a file or on error', async () => {
    expect(await call(IPC.FILE_CHECK_REVIEW)).toEqual({ needsReview: false })
    await ctx.session.openFile(agent1, async () => null)
    daemon.routes.set('GET /agents/review', () => ({ agentId: AGENT_1, filePath: agent1, reviewed: false, needsReview: true, summary: { name: 'agent-1' } }))
    expect(await call(IPC.FILE_CHECK_REVIEW)).toEqual({ needsReview: true, configSummary: { name: 'agent-1' } })
    daemon.routes.set('GET /agents/review', () => ({ status: 500, body: { error: 'boom' } }))
    expect(await call(IPC.FILE_CHECK_REVIEW)).toEqual({ needsReview: false })
  })

  it('FILE_REVIEW_ACCEPT: bound to the reviewed file; accept then relocate, re-keying the session and recent files', async () => {
    expect(await call(IPC.FILE_REVIEW_ACCEPT, { expectedPath: agent1 })).toEqual({ success: false, error: 'No workspace open' })
    await ctx.session.openFile(agent1, async () => null)
    expect(await call(IPC.FILE_REVIEW_ACCEPT, { expectedPath: join(dir, 'agent-2.adf') })).toEqual({
      success: false, error: 'The open file changed while the review dialog was up — review the current file again',
    })
    ctx.clientSettings.set('recentFiles', [agent1])
    const moved = join(dir, 'agents', 'agent-1.adf')
    daemon.routes.set('POST /agents/review/accept', () => ({ agentId: AGENT_1, filePath: agent1, reviewed: true, claimed: true, did: 'did:key:z', config: {}, lockedFields: [], summary: {} }))
    daemon.routes.set('POST /files/relocate', () => ({ movedTo: moved }))
    expect(await call(IPC.FILE_REVIEW_ACCEPT, { expectedPath: agent1, claim: true, model: { provider: 'p1', model_id: 'm1' } })).toEqual({ success: true, movedTo: moved })
    expect(daemon.requests.find((r) => r.path === '/agents/review/accept')?.body).toEqual({ filePath: agent1, claim: true, model: { provider: 'p1', model_id: 'm1' } })
    expect(ctx.session.filePath).toBe(moved)
    expect(ctx.clientSettings.get('recentFiles')).toEqual([moved])
    expect(recent).toContain(moved)
  })

  it('FILE_REVIEW_ACCEPT: embedded\'s refusal sentences', async () => {
    await ctx.session.openFile(agent1, async () => null)
    daemon.routes.set('POST /agents/review/accept', () => ({ status: 409, body: { error: 'Owner and runtime encryption keys are unavailable (keystore locked?), so the agent cannot be claimed securely.', code: 'identity_not_ready' } }))
    expect(await call(IPC.FILE_REVIEW_ACCEPT, { expectedPath: agent1, claim: true })).toEqual({
      success: false, error: 'Owner and runtime encryption keys are unavailable (keystore locked?), so the template cannot be claimed securely.',
    })
    daemon.routes.set('POST /agents/review/accept', () => ({ status: 400, body: { error: 'Provider "x" is not configured in Settings', code: 'provider_unknown' } }))
    expect(await call(IPC.FILE_REVIEW_ACCEPT, { expectedPath: agent1, model: { provider: 'x', model_id: 'm' } })).toEqual({ success: false, error: 'Provider "x" is not configured in Settings' })
  })
})

describe('tracked directories, picker, drafts, reveal', () => {
  it('TRACKED_DIRS_ADD: cancel and an already covered folder answer the list', async () => {
    daemon.routes.set('GET /tracked-dirs', () => ({ maxDepth: 5, directories: [{ path: dir, exists: true, agentCount: 1, loadedCount: 0 }] }))
    native.openDialog = { canceled: true, filePaths: [] }
    expect(await call(IPC.TRACKED_DIRS_ADD)).toEqual({ directories: [dir] })
    native.openDialog = { canceled: false, filePaths: [join(dir, 'sub')] }
    daemon.routes.set('POST /tracked-dirs', () => ({ status: 409, body: { error: `Already tracked through its parent folder ${dir}`, coveredBy: dir } }))
    expect(await call(IPC.TRACKED_DIRS_ADD)).toEqual({ directories: [dir] })
    daemon.routes.set('POST /tracked-dirs', () => ({ status: 201, body: { directories: [dir, join(tmpdir(), 'other')] } }))
    expect(await call(IPC.TRACKED_DIRS_ADD)).toEqual({ directories: [dir, join(tmpdir(), 'other')] })
    // As embedded Studio: tracking does not start the folder's agents.
    expect(daemon.requests.filter((r) => r.method === 'POST' && r.path === '/tracked-dirs').at(-1)?.body).toEqual({ path: join(dir, 'sub'), autostart: false })
  })

  it('TRACKED_DIRS_GET collapses nested entries and persists the list; REMOVE of an untracked folder answers the list', async () => {
    const sub = join(dir, 'nested')
    mkdirSync(sub, { recursive: true })
    daemon.routes.set('GET /tracked-dirs', () => ({ maxDepth: 5, directories: [{ path: dir }, { path: sub }] }))
    daemon.routes.set('PATCH /settings', () => ({ settings: {} }))
    expect(await call(IPC.TRACKED_DIRS_GET)).toEqual({ directories: [dir] })
    expect(daemon.requests.find((r) => r.method === 'PATCH')?.body).toEqual({ trackedDirectories: [dir] })
    daemon.routes.set('DELETE /tracked-dirs', () => ({ status: 404, body: { error: 'Not a tracked folder' } }))
    expect(await call(IPC.TRACKED_DIRS_REMOVE, { dirPath: '/nope' })).toEqual({ directories: [dir, sub] })
    daemon.routes.set('GET /tracked-dirs/tree', () => ({ status: 404, body: { error: 'Not inside a tracked folder' } }))
    expect(await call(IPC.TRACKED_DIRS_SCAN, { dirPath: '/nope' })).toEqual({ files: [] })
  })

  it('identity drafts unwrap the route answers; reveal is local in local mode, refused in remote mode', async () => {
    daemon.routes.set('POST /identity/drafts', () => ({ draftId: 'd1', did: 'did:key:z1' }))
    expect(await call(IPC.IDENTITY_DRAFT_MINT)).toEqual({ draftId: 'd1', did: 'did:key:z1' })
    daemon.routes.set('DELETE /identity/drafts/d1', () => ({ discarded: true }))
    expect(await call(IPC.IDENTITY_DRAFT_DISCARD, 'd1')).toBe(true)
    expect(await call(IPC.IDENTITY_DRAFT_DISCARD, 42)).toBe(false)
    daemon.routes.set('GET /files/agents-folder', () => ({ path: join(dir, 'adf-agents'), source: 'default', exists: false }))
    expect(await call(IPC.AGENTS_FOLDER_DEFAULT_GET)).toEqual({ path: join(dir, 'adf-agents') })
    await call(IPC.FILE_REVEAL, { filePath: agent1 })
    expect(native.calls).toContainEqual({ api: 'shell.showItemInFolder', args: [agent1] })
    setup('remote')
    await expect(call(IPC.FILE_REVEAL, { filePath: agent1 })).rejects.toMatchObject({ code: DAEMON_MODE_UNAVAILABLE })
    await expect(call(IPC.DIALOG_PICK_DIRECTORY)).rejects.toMatchObject({ code: DAEMON_MODE_UNAVAILABLE })
  })
})

describe('share by drag and save a copy', () => {
  it('PREPARE downloads the share snapshot into Studio\'s scratch dir; the drag token is single-use; DISCARD removes it', async () => {
    const source = join(dir, 'agent-1.adf')
    mkdirSync(dir, { recursive: true })
    writeFileSync(source, 'x')
    daemon.routes.set('GET /files/snapshot', () => ({ status: 200, raw: 'SNAPSHOT', headers: { 'Content-Type': 'application/octet-stream' } }))
    const prepared = await call(IPC.FILE_SHARE_PREPARE, { filePath: source }) as { success: boolean; token: string }
    expect(prepared).toEqual({ success: true, token: expect.any(String) })
    expect(daemon.requests.find((r) => r.path === '/files/snapshot')?.query).toEqual({ path: source, mode: 'share' })
    const drags: unknown[] = []
    const event = { sender: { startDrag: (d: { file: string }) => { drags.push(d); expect(readFileSync(d.file, 'utf-8')).toBe('SNAPSHOT') } } }
    FILE_SEND_HANDLERS[IPC.FILE_SHARE_DRAG_START]!(ctx, event as never, { token: prepared.token })
    FILE_SEND_HANDLERS[IPC.FILE_SHARE_DRAG_START]!(ctx, event as never, { token: prepared.token })
    expect(drags).toHaveLength(1)
    const file = (drags[0] as { file: string }).file
    await call(IPC.FILE_SHARE_DISCARD, { token: prepared.token })
    expect(_shareSnapshotCount()).toBe(0)
    await vi.waitFor(() => expect(existsSync(file)).toBe(false))
    expect(await call(IPC.FILE_SHARE_PREPARE, { filePath: join(dir, 'missing.adf') })).toEqual({ success: false, error: 'Not an .adf file' })
  })

  it('at quit every snapshot left is deleted synchronously, before the process can exit (embedded rmSync)', async () => {
    const source = join(dir, 'agent-1.adf')
    mkdirSync(dir, { recursive: true })
    writeFileSync(source, 'x')
    daemon.routes.set('GET /files/snapshot', () => ({ status: 200, raw: 'SNAPSHOT', headers: { 'Content-Type': 'application/octet-stream' } }))
    const prepared = await call(IPC.FILE_SHARE_PREPARE, { filePath: source }) as { token: string }
    const drags: Array<{ file: string }> = []
    FILE_SEND_HANDLERS[IPC.FILE_SHARE_DRAG_START]!(ctx, { sender: { startDrag: (d: { file: string }) => drags.push(d) } } as never, { token: prepared.token })
    expect(native.willQuit.length).toBeGreaterThan(0)
    for (const fn of native.willQuit) fn()
    // No await: gone as soon as the will-quit listener returned.
    expect(existsSync(drags[0].file)).toBe(false)
    expect(_shareSnapshotCount()).toBe(0)
  })

  it('SAVE_AS writes the snapshot where the user picked; refuses the agent itself', async () => {
    const source = join(dir, 'agent-1.adf')
    writeFileSync(source, 'x')
    daemon.routes.set('GET /files/snapshot', () => ({ status: 200, raw: 'COPY', headers: { 'Content-Type': 'application/octet-stream' } }))
    native.saveDialog = { canceled: false, filePath: source }
    expect(await call(IPC.FILE_SHARE_SAVE_AS, { filePath: source })).toEqual({ success: false, error: 'Choose a different file — a shared copy cannot overwrite the agent it came from' })
    const dest = join(dir, 'copy.adf')
    native.saveDialog = { canceled: false, filePath: dest }
    expect(await call(IPC.FILE_SHARE_SAVE_AS, { filePath: source })).toEqual({ success: true, filePath: dest })
    expect(readFileSync(dest, 'utf-8')).toBe('COPY')
    expect(existsSync(`${dest}.partial`)).toBe(false)
  })
})
