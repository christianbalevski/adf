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
  root = mkdtempSync(join(tmpdir(), 'adf-daemon-draft-create-'))
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
  return { server, settings, identity }
}

type Server = ReturnType<typeof makeDaemon>['server']
const call = async (server: Server, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) => {
  const res = await server.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) })
  return { status: res.statusCode, body: res.json() as Record<string, any> }
}
const templatesDir = () => join(h.userDataDir, 'templates')

describe('POST /agents/create adopts an identity draft (W1-D)', () => {
  it('the created agent has the draft DID; the draft is consumed', async () => {
    const { server } = makeDaemon()
    await call(server, 'POST', '/identity/create', {})
    const dir = join(root, 'agents')
    mkdirSync(dir)
    const draft = await call(server, 'POST', '/identity/drafts')
    expect(draft.body.did).toMatch(/^did:key:z/)
    const created = await call(server, 'POST', '/agents/create', { name: 'agent-1', directory: dir, identityDraftId: draft.body.draftId })
    expect(created.status).toBe(201)
    expect(created.body.did).toBe(draft.body.did)
    const ws = AdfWorkspace.open(created.body.filePath)
    try { expect(ws.getDid()).toBe(draft.body.did) } finally { ws.close() }
    expect((await call(server, 'DELETE', `/identity/drafts/${draft.body.draftId}`)).body).toEqual({ discarded: false })

    // An unknown (or expired) draft falls back to a fresh identity.
    const fresh = await call(server, 'POST', '/agents/create', { name: 'agent-2', directory: dir, identityDraftId: 'no-such-draft' })
    expect(fresh.status).toBe(201)
    expect(fresh.body.did).toMatch(/^did:key:z/)
    expect(fresh.body.did).not.toBe(draft.body.did)
    expect((await call(server, 'POST', '/agents/create', { name: 'agent-3', directory: dir, identityDraftId: 7 })).status).toBe(400)
  })
})
