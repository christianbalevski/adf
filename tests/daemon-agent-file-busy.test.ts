// W5-G: the daemon's review accept and create when another program is
// writing the agent file: a 409 naming the file (code agent_file_busy),
// nothing crashes, trying again works. Embedded: tests/parity/boot-sweep/embedded-busy.test.ts.
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
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
import { AdfWorkspace } from '../src/main/adf/adf-workspace'
import { AdfDatabase } from '../src/main/adf/adf-database'
import { KeychainSecretBackend } from '../src/main/services/owner-secret-store'
import { AgentFileBusyError } from '../src/main/services/owner-identity.service'

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
  root = mkdtempSync(join(tmpdir(), 'adf-daemon-file-busy-'))
  h.userDataDir = join(root, 'userData')
  mkdirSync(h.userDataDir, { recursive: true })
  process.env.ADF_USER_DATA_DIR = h.userDataDir
})

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()))
  delete process.env.ADF_USER_DATA_DIR
  rmSync(root, { recursive: true, force: true })
})

function makeDaemon() {
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
  const agentFactory = new DaemonAgentFactory({ settings, identity, runtime })
  const server = createDaemonHttpApi(runtime, { settingsStore: settings, identity, agentFactory })
  servers.push(server)
  // Created agents load: unload them so their files close before the temp root goes.
  servers.push({ close: async () => { for (const a of runtime.listAgents()) await runtime.unloadAgent(a.id) } })
  return { server, settings, identity, runtime }
}

type Server = ReturnType<typeof makeDaemon>['server']
const call = async (server: Server, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) => {
  const res = await server.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) })
  return { status: res.statusCode, body: res.json() as Record<string, any> }
}
const templatesDir = () => join(h.userDataDir, 'templates')


function holdWriteLock(filePath: string): () => void {
  const db = new Database(filePath, { fileMustExist: true })
  db.exec('BEGIN IMMEDIATE')
  return () => { try { db.exec('ROLLBACK') } finally { db.close() } }
}

const BUSY = 'agent-1.adf is busy (another program is writing it); try again.'

describe('daemon: an agent file another program is writing', () => {
  it('review accept answers 409 naming the file; accepting again works', async () => {
    const { server, runtime } = makeDaemon()
    await call(server, 'POST', '/identity/create', {})
    const dir = join(root, 'agents')
    mkdirSync(dir)
    const filePath = join(dir, 'agent-1.adf')
    AdfWorkspace.create(filePath, { name: 'agent-1' }).close()
    // Open in Studio (held as a document), as when its review dialog is up.
    // (A closed file's own open waits out busy_timeout per write: design §6.)
    await runtime.openDocument(filePath, { holder: 'client-1' })
    servers.push({ close: async () => { runtime.closeDocument(filePath, 'released') } })
    const release = holdWriteLock(filePath)
    let busy
    try {
      busy = await call(server, 'POST', '/agents/review/accept', { filePath, claim: false })
    } finally {
      release()
    }
    expect(busy.status).toBe(409)
    expect(busy.body).toEqual({ error: BUSY, code: 'agent_file_busy' })
    const accepted = await call(server, 'POST', '/agents/review/accept', { filePath, claim: false })
    expect(accepted.status).toBe(200)
    expect(accepted.body.did).toMatch(/^did:key:z/)
  }, 60_000)

  it('create answers 409 naming the file and leaves no file; creating again works', async () => {
    const { server, identity } = makeDaemon()
    await call(server, 'POST', '/identity/create', {})
    const dir = join(root, 'agents')
    mkdirSync(dir)
    // The new file cannot be locked from outside before it exists: the mint
    // reports what a held lock makes it report.
    const original = identity.service.ensureWorkspaceIdentity.bind(identity.service)
    const spy = vi.spyOn(identity.service, 'ensureWorkspaceIdentity').mockImplementation((ws, opts) => {
      if (ws.getFilePath().endsWith('agent-1.adf')) throw new AgentFileBusyError(ws.getFilePath())
      return original(ws, opts)
    })
    const busy = await call(server, 'POST', '/agents/create', { name: 'agent-1', directory: dir })
    spy.mockRestore()
    expect(busy.status).toBe(409)
    expect(busy.body).toMatchObject({ error: BUSY, code: 'agent_file_busy' })
    expect(existsSync(join(dir, 'agent-1.adf'))).toBe(false)
    const created = await call(server, 'POST', '/agents/create', { name: 'agent-1', directory: dir })
    expect(created.status).toBe(201)
  }, 60_000)
})
