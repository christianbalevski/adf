import './daemon-mode-platform'
/**
 * W3-A: the daemon-mode template handlers answer what the embedded handlers
 * (AgentTemplatesService) answer, refusals included, from the daemon's
 * /templates routes; deleting a template in local mode puts it in the OS
 * trash as embedded does; added files travel as raw bytes.
 */
import { stageTemplateAddFiles, type TemplateAddFileItem } from '../../src/main/adf/agent-templates'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { stub } = vi.hoisted(() => ({ stub: { module: {} as Record<string, unknown> } }))
vi.mock('electron', async () => {
  const { createElectronStub } = await import('./daemon-mode-electron')
  const electron = createElectronStub()
  Object.assign(stub, electron)
  return electron.module
})

import { DaemonClient } from '../../src/shared/daemon-client'
import { IPC } from '../../src/shared/constants/ipc-channels'
import { TEMPLATE_HANDLERS } from '../../src/main/backend/daemon-mode/documents/template-handlers'
import type { DaemonModeContext } from '../../src/main/backend/daemon-mode/context'
import type { ElectronStub } from './daemon-mode-electron'
import { createFakeDaemon } from './daemon-mode-fakes'

const BASE = 'http://127.0.0.1:47386'
const TOKEN = 'b'.repeat(43)
const daemon = createFakeDaemon(BASE)
const uploads: Array<{ path: string; query: Record<string, string>; bytes: Buffer }> = []
// Raw uploads (octet-stream) are not JSON: record their bytes, answer from the route table.
const fetchWithRaw = (async (input: string | URL | Request, init?: RequestInit) => {
  if (init?.body instanceof Uint8Array) {
    const url = new URL(String(input))
    uploads.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), bytes: Buffer.from(init.body) })
    return daemon.fetch(input, { ...init, body: undefined })
  }
  return daemon.fetch(input, init)
}) as typeof fetch

let dir: string
let folder: string
const clientSettings = new Map<string, unknown>()
const logs: string[] = []
const electron = stub as unknown as ElectronStub
const trashed: string[] = []
const shown: string[] = []
let picked: string[] = []

function ctx(mode: 'local' | 'remote' = 'local'): DaemonModeContext {
  const client = new DaemonClient({ baseUrl: BASE, credentials: { token: () => TOKEN }, fetch: fetchWithRaw })
  return {
    mode,
    ready: async () => client,
    clientSettings: { get: (k: string) => clientSettings.get(k) },
    log: { log: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m) },
  } as unknown as DaemonModeContext
}
const call = (channel: string, args?: unknown, mode: 'local' | 'remote' = 'local') =>
  Promise.resolve(TEMPLATE_HANDLERS[channel as keyof typeof TEMPLATE_HANDLERS]!(ctx(mode), {} as never, args))

const summary = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, filePath: join(folder, `${id}.adf`), reviewed: true, modifiedAt: 1, ...extra })
const refuse = (status: number, error: string, code: string) => () => ({ status, body: { error, code } })

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'adf-template-handlers-'))
  folder = join(dir, 'templates')
  mkdirSync(folder, { recursive: true })
  vi.stubGlobal('fetch', fetchWithRaw)
  const shell = electron.module.shell as Record<string, unknown>
  shell.trashItem = async (p: string) => { trashed.push(p) }
  shell.showItemInFolder = (p: string) => { shown.push(p) }
  ;(electron.module.dialog as Record<string, unknown>).showOpenDialog = async () => ({ canceled: picked.length === 0, filePaths: picked })
})

afterAll(() => {
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  daemon.routes.clear()
  daemon.requests.length = 0
  uploads.length = 0
  trashed.length = 0
  shown.length = 0
  picked = []
  clientSettings.clear()
  daemon.routes.set('GET /templates', () => ({ templates: [summary('standard', { shipped: 'standard' }), summary('mine')], defaultId: 'mine', folder, defaultDirectory: dir, migrated: { id: 'mine' } }))
})

describe('daemon-mode template handlers (W3-A)', () => {
  it('TEMPLATES_LIST: the embedded list; `migrated` dropped once the client key templatesMigrationSeen is set', async () => {
    const list = await call(IPC.TEMPLATES_LIST) as Record<string, unknown>
    expect(Object.keys(list).sort()).toEqual(['defaultId', 'folder', 'migrated', 'templates'])
    expect(list.migrated).toEqual({ id: 'mine' })
    clientSettings.set('templatesMigrationSeen', true)
    expect(await call(IPC.TEMPLATES_LIST)).toEqual({ templates: [summary('standard', { shipped: 'standard' }), summary('mine')], folder, defaultId: 'mine' })
  })

  it('TEMPLATE_CREATE: { success, id }, and the service sentence on a refusal', async () => {
    daemon.routes.set('POST /templates', ({ body }) => (body as { name: string }).name === 'Ok'
      ? { status: 201, body: { id: 'ok', template: null } }
      : { status: 400, body: { error: 'Template names may only contain letters, digits, spaces, - and _.', code: 'template_invalid' } })
    expect(await call(IPC.TEMPLATE_CREATE, { name: 'Ok' })).toEqual({ success: true, id: 'ok' })
    expect(await call(IPC.TEMPLATE_CREATE, { name: 'bad/name' })).toEqual({ success: false, error: 'Template names may only contain letters, digits, spaces, - and _.' })
    expect(await call(IPC.TEMPLATE_CREATE)).toMatchObject({ success: false })
    expect(daemon.requests.at(-1)?.body).toEqual({ name: '' })
  })

  it('TEMPLATE_DELETE local: the OS trash and the default reset, as embedded; a missing file is success', async () => {
    writeFileSync(join(folder, 'mine.adf'), 'x')
    daemon.routes.set('PATCH /settings', ({ body }) => ({ settings: body }))
    expect(await call(IPC.TEMPLATE_DELETE, { id: 'mine' })).toEqual({ success: true })
    expect(trashed).toEqual([join(folder, 'mine.adf')])
    expect(daemon.requests.find((r) => r.method === 'PATCH')?.body).toEqual({ defaultTemplateId: 'standard' })
    expect(daemon.requests.some((r) => r.method === 'DELETE')).toBe(false)
    expect(await call(IPC.TEMPLATE_DELETE, { id: 'gone' })).toEqual({ success: true })
    expect(trashed).toHaveLength(1)
    expect(await call(IPC.TEMPLATE_DELETE, { id: '../x' })).toEqual({ success: false, error: 'Unknown template.' })
  })

  it('TEMPLATE_DELETE remote: the daemon\'s DELETE', async () => {
    daemon.routes.set('DELETE /templates/mine', () => ({ deleted: true, id: 'mine' }))
    expect(await call(IPC.TEMPLATE_DELETE, { id: 'mine' }, 'remote')).toEqual({ success: true })
    expect(trashed).toEqual([])
  })

  it('TEMPLATE_RESET_SHIPPED: the shipped id finds the marked file, even renamed', async () => {
    daemon.routes.set('GET /templates', () => ({ templates: [summary('my-standard', { shipped: 'standard' }), summary('blank')], defaultId: 'standard', folder, defaultDirectory: dir }))
    daemon.routes.set('POST /templates/my-standard/reset', () => ({ id: 'my-standard', template: null }))
    expect(await call(IPC.TEMPLATE_RESET_SHIPPED, { id: 'standard' })).toEqual({ success: true })
    expect(await call(IPC.TEMPLATE_RESET_SHIPPED, { id: 'mine' })).toEqual({ success: false, error: '"mine" is not a shipped template.' })
    daemon.routes.set('GET /templates', () => ({ templates: [summary('standard')], defaultId: 'standard', folder, defaultDirectory: dir }))
    expect(await call(IPC.TEMPLATE_RESET_SHIPPED, { id: 'standard' })).toEqual({ success: false, error: 'standard.adf in the templates folder is not the shipped template. Rename or remove it first.' })
  })

  it('TEMPLATE_REVEAL: the file in local mode, the folder when it is gone; remote says where it is', async () => {
    writeFileSync(join(folder, 'standard.adf'), 'x')
    await call(IPC.TEMPLATE_REVEAL, { id: 'standard' })
    expect(shown).toEqual([join(folder, 'standard.adf')])
    await call(IPC.TEMPLATE_REVEAL, { id: 'nope' })
    expect(electron.calls.at(-1)).toEqual({ api: 'shell.openPath', args: [folder] })
    await expect(call(IPC.TEMPLATE_REVEAL, { id: 'standard' }, 'remote')).rejects.toThrow(folder)
  })

  it('edits answer { success } and the service sentences', async () => {
    daemon.routes.set('POST /templates/mine/default', () => ({ defaultId: 'mine' }))
    daemon.routes.set('POST /templates/gone/default', refuse(404, 'gone.adf is not in the templates folder.', 'template_missing'))
    daemon.routes.set('PATCH /templates/mine', ({ body }) => (body as { name?: string }).name === 'Renamed' ? { id: 'renamed' } : { id: 'mine' })
    daemon.routes.set('GET /templates/mine', () => ({ template: null, isDefault: false, defaultId: 'standard', contents: { config: { name: 'mine' }, files: { readme: '', mind: '', soul: '' }, extra: [] } }))
    daemon.routes.set('PUT /templates/mine/config', refuse(400, 'tools: Expected array, received string', 'template_invalid'))
    daemon.routes.set('PUT /templates/mine/files', () => ({ id: 'mine', path: 'mind.md', success: true }))
    daemon.routes.set('DELETE /templates/mine/files', refuse(400, 'mind.md is a seed file; clear its text instead.', 'template_invalid'))
    expect(await call(IPC.TEMPLATE_SET_DEFAULT, { id: 'mine' })).toEqual({ success: true })
    expect(await call(IPC.TEMPLATE_SET_DEFAULT, { id: 'gone' })).toEqual({ success: false, error: 'gone.adf is not in the templates folder.' })
    expect(await call(IPC.TEMPLATE_RENAME, { id: 'mine', name: 'Renamed' })).toEqual({ success: true, id: 'renamed' })
    expect(await call(IPC.TEMPLATE_SET_META, { id: 'mine', description: 'notes' })).toEqual({ success: true })
    expect(daemon.requests.at(-1)?.body).toEqual({ description: 'notes' })
    expect(await call(IPC.TEMPLATE_GET_CONTENTS, { id: 'mine' })).toEqual({ success: true, contents: { config: { name: 'mine' }, files: { readme: '', mind: '', soul: '' }, extra: [] } })
    expect(await call(IPC.TEMPLATE_SET_CONFIG, { id: 'mine', config: { tools: 'x' } })).toEqual({ success: false, error: 'tools: Expected array, received string' })
    expect(await call(IPC.TEMPLATE_SET_FILE, { id: 'mine', path: ' mind.md ', content: '# m' })).toEqual({ success: true })
    expect(daemon.requests.at(-1)?.body).toEqual({ path: 'mind.md', content: '# m' })
    expect(await call(IPC.TEMPLATE_SET_FILE, { id: 'mine', path: ' ', content: '' })).toEqual({ success: false, error: 'Path is required.' })
    expect(await call(IPC.TEMPLATE_REMOVE_FILE, { id: 'mine', path: 'mind.md' })).toEqual({ success: false, error: 'mind.md is a seed file; clear its text instead.' })
    expect(await call(IPC.TEMPLATE_REMOVE_FILE, { id: '..', path: 'a' })).toEqual({ success: false, error: 'Unknown template.' })
  })

  it('TEMPLATE_ADD_FILES: native picker, checks the whole batch first, then one raw upload per file', async () => {
    daemon.routes.set('GET /templates/mine', () => ({ contents: {} }))
    let n = 0
    daemon.routes.set('PUT /templates/mine/files/raw', ({ query }) => ({ id: 'mine', path: n++ === 0 ? query.name : 'logo-2.png', size: 3, success: true }))
    // The daemon plans with embedded's own staging (AgentTemplatesService.addFiles), on a template without README.md.
    daemon.routes.set('POST /templates/mine/files/plan', ({ body }) => {
      const plan = stageTemplateAddFiles(new Set(['mind.md', 'soul.md']), (body as { files: TemplateAddFileItem[] }).files)
      return 'error' in plan ? { success: false, error: plan.error } : { success: true, dests: plan.dests }
    })
    const a = join(dir, 'logo.png')
    const b = join(dir, 'sub', 'logo.png')
    mkdirSync(join(dir, 'sub'), { recursive: true })
    writeFileSync(a, Buffer.from([1, 2, 3]))
    writeFileSync(b, Buffer.from([4, 5, 6]))
    expect(await call(IPC.TEMPLATE_ADD_FILES, { id: 'mine' })).toEqual({ success: false, error: 'Cancelled' })
    picked = [a, b]
    expect(await call(IPC.TEMPLATE_ADD_FILES, { id: 'mine' })).toEqual({ success: true, added: ['logo.png', 'logo-2.png'] })
    expect(uploads.map((u) => [u.path, u.query.name, [...u.bytes]])).toEqual([
      ['/templates/mine/files/raw', 'logo.png', [1, 2, 3]],
      ['/templates/mine/files/raw', 'logo.png', [4, 5, 6]],
    ])
    // A folder in the batch refuses it before anything is uploaded.
    uploads.length = 0
    picked = [a, join(dir, 'sub')]
    expect(await call(IPC.TEMPLATE_ADD_FILES, { id: 'mine' })).toEqual({ success: false, error: 'sub is not a file.' })
    expect(uploads).toEqual([])
    // A reserved seed name the template lacks refuses the whole batch: nothing is half written.
    const readme = join(dir, 'README.md')
    writeFileSync(readme, 'x')
    picked = [a, readme]
    expect(await call(IPC.TEMPLATE_ADD_FILES, { id: 'mine' })).toEqual({ success: false, error: 'README.md: README.md is created by the agent itself.' })
    expect(uploads).toEqual([])
    daemon.routes.set('GET /templates/gone', refuse(404, 'gone.adf is not in the templates folder.', 'template_missing'))
    expect(await call(IPC.TEMPLATE_ADD_FILES, { id: 'gone' })).toEqual({ success: false, error: 'gone.adf is not in the templates folder.' })
  })

  it('TEMPLATE_CHECK_REVIEW and TEMPLATE_REVIEW_ACCEPT: the embedded answers', async () => {
    daemon.routes.set('GET /templates/found/review', () => ({ id: 'found', needsReview: true, reviewed: false, summary: { name: 'found' } }))
    daemon.routes.set('GET /templates/mine/review', () => ({ id: 'mine', needsReview: false, reviewed: true }))
    expect(await call(IPC.TEMPLATE_CHECK_REVIEW, { id: 'found' })).toEqual({ needsReview: true, configSummary: { name: 'found' } })
    expect(await call(IPC.TEMPLATE_CHECK_REVIEW, { id: 'mine' })).toEqual({ needsReview: false })
    expect(await call(IPC.TEMPLATE_CHECK_REVIEW, { id: 'gone' })).toEqual({ needsReview: false })
    daemon.routes.set('POST /templates/found/review/accept', ({ body }) => (body as { password?: string }).password === 'pw'
      ? { id: 'found', reviewed: true }
      : { status: 403, body: { error: 'Wrong password', code: 'wrong_password' } })
    daemon.routes.set('POST /templates/gone/review/accept', refuse(404, 'gone.adf is not in the templates folder.', 'template_missing'))
    expect(await call(IPC.TEMPLATE_REVIEW_ACCEPT, { id: 'found', password: 'pw' })).toEqual({ success: true })
    expect(await call(IPC.TEMPLATE_REVIEW_ACCEPT, { id: 'found', password: 'no' })).toEqual({ success: false, error: 'Wrong password' })
    expect(await call(IPC.TEMPLATE_REVIEW_ACCEPT, { id: 'gone' })).toEqual({ success: false, error: 'That template is not in the templates folder any more.' })
  })
})
