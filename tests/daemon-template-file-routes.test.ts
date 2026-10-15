import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const h = vi.hoisted(() => ({ userDataDir: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => h.userDataDir, on: () => {}, getName: () => 't', getVersion: () => '0' },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s, 'utf-8'),
    decryptString: (b: Buffer) => b.toString('utf-8'),
  },
  // The daemon never uses the OS trash: a call here would be a bug.
  shell: { openExternal: async () => {}, trashItem: async () => { throw new Error('OS trash used by the daemon') } },
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
  BrowserWindow: class {},
  dialog: {},
}))

import { FileSettingsStore } from '../src/main/daemon/file-settings-store'
import { ensureDaemonEncKey } from '../src/main/daemon/daemon-enc-key'
import { DaemonIdentity } from '../src/main/daemon/daemon-identity'
import { DaemonAgentFactory } from '../src/main/daemon/daemon-agent-factory'
import { createDaemonHttpApi } from '../src/main/daemon/http-api'
import { RuntimeService } from '../src/main/runtime/runtime-service'
import { MockLLMProvider } from '../src/main/runtime/headless'
import { setWorkspaceIdentityHooks } from '../src/main/runtime/identity-provisioner'
import { KeychainSecretBackend } from '../src/main/services/owner-secret-store'

function fakeKeychain() {
  const store = new Map<string, string>()
  class Entry {
    constructor(private service: string, private account: string) {}
    getPassword() { return store.get(`${this.service}/${this.account}`) ?? null }
    setPassword(p: string) { store.set(`${this.service}/${this.account}`, p) }
    deleteCredential() { return store.delete(`${this.service}/${this.account}`) }
  }
  return new KeychainSecretBackend(Entry)
}

let root: string
const servers: Array<{ close: () => Promise<unknown> }> = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'adf-daemon-templates-'))
  h.userDataDir = join(root, 'userData')
  mkdirSync(h.userDataDir, { recursive: true })
  process.env.ADF_USER_DATA_DIR = h.userDataDir
})

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()))
  delete process.env.ADF_USER_DATA_DIR
  rmSync(root, { recursive: true, force: true })
})

function makeDaemon(notifyTemplatesChanged?: () => void) {
  const settingsPath = join(h.userDataDir, 'adf-settings.json')
  const settings = new FileSettingsStore(settingsPath)
  const identity = new DaemonIdentity({ settings, settingsPath, encKey: ensureDaemonEncKey(h.userDataDir), backend: fakeKeychain() })
  setWorkspaceIdentityHooks({
    ensureIdentity: (ws) => {
      if (identity.isReady()) identity.service.ensureWorkspaceIdentity(ws)
      else identity.service.unlockWorkspaceEnvelopes(ws)
    },
    unlockEnvelopes: (ws) => identity.service.unlockWorkspaceEnvelopes(ws),
    canProvision: () => identity.isReady(),
  })
  const runtime = new RuntimeService({ settings, providerFactory: () => new MockLLMProvider() })
  const agentFactory = new DaemonAgentFactory({ settings, identity, runtime, notifyTemplatesChanged })
  const server = createDaemonHttpApi(runtime, { settingsStore: settings, identity, agentFactory })
  servers.push(server)
  return { server, settings, identity, agentFactory }
}

type Server = ReturnType<typeof makeDaemon>['server']
const call = async (server: Server, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) => {
  const res = await server.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) })
  return { status: res.statusCode, body: res.json() as Record<string, any> }
}
const putRaw = async (server: Server, url: string, bytes: Buffer, contentType = 'application/octet-stream') => {
  const res = await server.inject({ method: 'PUT', url, payload: bytes, headers: { 'content-type': contentType } })
  return { status: res.statusCode, body: res.json() as Record<string, any> }
}
const templatesDir = () => join(h.userDataDir, 'templates')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('PUT /templates/:id/files/raw (W3-A)', () => {
  it('stores binary bytes under the base name, numbered past a taken one, as the Studio picker does', async () => {
    const { server } = makeDaemon()
    await call(server, 'POST', '/identity/create', {})
    await call(server, 'POST', '/templates', { name: 'Raw files' })
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x10])
    const first = await putRaw(server, '/templates/raw-files/files/raw?name=logo.png', png)
    expect(first).toEqual({ status: 200, body: { id: 'raw-files', path: 'logo.png', size: png.length, success: true } })
    const second = await putRaw(server, '/templates/raw-files/files/raw?name=' + encodeURIComponent('C:\\pics\\logo.png'), png)
    expect(second.body.path).toBe('logo-2.png')
    const extra = (await call(server, 'GET', '/templates/raw-files')).body.contents.extra as Array<{ path: string; size: number; mime: string }>
    expect(extra).toEqual(expect.arrayContaining([
      { path: 'logo.png', size: png.length, mime: 'image/png' },
      { path: 'logo-2.png', size: png.length, mime: 'image/png' },
    ]))
  })

  it('refuses what the Studio picker refuses, an unknown template, a missing name and JSON bodies', async () => {
    const { server } = makeDaemon()
    // Without the owner identity too, as embedded Studio (W5-D2).
    expect((await putRaw(server, '/templates/standard/files/raw?name=a.txt', Buffer.from('x'))).status).toBe(200)
    await call(server, 'POST', '/identity/create', {})
    await call(server, 'POST', '/templates', { name: 'Refusals' })
    const seed = await putRaw(server, '/templates/refusals/files/raw?name=' + encodeURIComponent('bad\u0001name.txt'), Buffer.from('x'))
    expect(seed.status).toBe(400)
    expect(seed.body.code).toBe('template_invalid')
    expect((await putRaw(server, '/templates/nope/files/raw?name=a.txt', Buffer.from('x'))).body.code).toBe('template_missing')
    expect((await putRaw(server, '/templates/refusals/files/raw', Buffer.from('x'))).status).toBe(400)
    expect((await server.inject({ method: 'PUT', url: '/templates/refusals/files/raw?name=a.txt', payload: { a: 1 } })).statusCode).toBe(415)
    const big = Buffer.alloc(25 * 1024 * 1024 + 1)
    const tooBig = await putRaw(server, '/templates/refusals/files/raw?name=big.bin', big)
    expect(tooBig.status).toBe(413)
    expect(tooBig.body.error).toBe('big.bin is larger than 25 MB.')
    // The other octet-stream routes keep their own parser (file-routes.ts).
    expect((await putRaw(server, '/agents/nope/files/raw?path=a.txt', Buffer.from('x'))).status).toBe(404)
  })
})

describe('POST /templates/:id/files/plan: a batch is planned whole before any upload (review fix)', () => {
  it('numbers taken names, refuses the whole batch at a reserved seed name the template lacks, and writes nothing', async () => {
    const { server } = makeDaemon()
    await call(server, 'POST', '/identity/create', {})
    await call(server, 'POST', '/templates', { name: 'Plan' })
    const file = (name: string) => ({ name, isFile: true, size: 3 })
    expect((await call(server, 'POST', '/templates/plan/files/plan', { files: [file('a.txt'), file('a.txt'), file('README.md')] })).body)
      .toEqual({ success: true, dests: ['a.txt', 'a-2.txt', 'README-2.md'] })
    const refused = await call(server, 'POST', '/templates/plan/files/plan', { files: [file('b.txt'), file('readme.md')] })
    expect(refused.body).toEqual({ success: false, error: 'readme.md: readme.md is created by the agent itself.' })
    expect((await call(server, 'POST', '/templates/plan/files/plan', { files: [{ name: 'gone.txt', statError: 'ENOENT: gone' }] })).body).toEqual({ success: false, error: 'ENOENT: gone' })
    const extra = (await call(server, 'GET', '/templates/plan')).body.contents.extra as Array<{ path: string }>
    expect(extra.map((e) => e.path)).not.toContain('b.txt')
    expect((await call(server, 'POST', '/templates/plan/files/plan', { files: [] })).status).toBe(400)
  })

  it('an upload refused before its body is read answers and closes the connection', async () => {
    const { server } = makeDaemon()
    await call(server, 'POST', '/identity/create', {})
    await server.listen({ host: '127.0.0.1', port: 0 })
    const port = (server.server.address() as { port: number }).port
    const { request } = await import('node:http')
    const outcome = await new Promise<{ status: number; closed: boolean }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, method: 'PUT', path: '/templates/standard/files/raw?name=big.bin', headers: { 'content-type': 'application/octet-stream', 'content-length': String(30 * 1024 * 1024) } })
      let status = 0
      req.on('response', (res) => { status = res.statusCode ?? 0; res.resume() })
      req.on('close', () => resolve({ status, closed: true }))
      req.on('error', (err) => (status ? resolve({ status, closed: true }) : reject(err)))
      req.write(Buffer.alloc(64 * 1024))
    })
    expect(outcome).toEqual({ status: 413, closed: true })
  }, 20_000)
})

describe('daemon templates-folder watcher (tracker §6, W2-B row)', () => {
  it('a template copied into the folder outside the routes notifies once; writes through the routes notify too', async () => {
    let notified = 0
    const { server, agentFactory } = makeDaemon(() => { notified++ })
    await call(server, 'POST', '/identity/create', {})
    await call(server, 'GET', '/templates')
    await sleep(400)
    agentFactory.startTemplatesWatcher()
    try {
      await sleep(300)
      notified = 0
      copyFileSync(join(templatesDir(), 'standard.adf'), join(templatesDir(), 'copied-in.adf'))
      for (let i = 0; i < 60 && notified === 0; i++) await sleep(100)
      await sleep(400)
      expect(notified).toBe(1)
      expect((await call(server, 'GET', '/templates')).body.templates.map((t: { id: string }) => t.id)).toContain('copied-in')

      notified = 0
      await call(server, 'POST', '/templates/copied-in/default')
      await sleep(400)
      expect(notified).toBe(1)
    } finally {
      agentFactory.stopTemplatesWatcher()
    }
  }, 20_000)
})
