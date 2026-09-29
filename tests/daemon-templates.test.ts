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
  return { server, settings, identity }
}

type Server = ReturnType<typeof makeDaemon>['server']
const call = async (server: Server, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) => {
  const res = await server.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) })
  return { status: res.statusCode, body: res.json() as Record<string, any> }
}
const templatesDir = () => join(h.userDataDir, 'templates')

describe('daemon template routes', () => {
  it('need the owner identity (409 identity_not_ready)', async () => {
    const { server } = makeDaemon()
    const early = await call(server, 'GET', '/templates/standard')
    expect(early.status).toBe(409)
    expect(early.body.code).toBe('identity_not_ready')
    expect((await call(server, 'POST', '/templates', { name: 'x' })).status).toBe(409)
    expect((await call(server, 'POST', '/templates/standard/review/accept')).status).toBe(409)
  })

  it('create, contents, notes, rename, default, files, config, delete into the trash folder', async () => {
    const { server } = makeDaemon()
    await call(server, 'POST', '/identity/create', {})

    const standard = await call(server, 'GET', '/templates/standard')
    expect(standard.status).toBe(200)
    expect(standard.body).toMatchObject({ isDefault: true, template: { id: 'standard', shipped: 'standard', reviewed: true } })
    expect(standard.body.contents.config.name).toBeTruthy()
    expect(typeof standard.body.contents.files.readme).toBe('string')
    expect((await call(server, 'GET', '/templates/nope')).status).toBe(404)
    expect((await call(server, 'GET', '/templates/..%2Fx')).status).toBe(404)

    const dup = await call(server, 'POST', '/templates', { name: 'Research copy', fromId: 'standard' })
    expect(dup.status).toBe(201)
    expect(dup.body).toMatchObject({ id: 'research-copy', template: { name: 'Research copy', reviewed: true } })
    expect((await call(server, 'POST', '/templates', { name: 'bad/name' })).status).toBe(400)
    const blank = await call(server, 'POST', '/templates', { name: 'Blank one' })
    expect(blank.body.id).toBe('blank-one')

    const patched = await call(server, 'PATCH', '/templates/research-copy', { name: 'Research', description: 'Reads papers.', warning: 'Fetches the web.' })
    expect(patched.status).toBe(200)
    expect(patched.body).toMatchObject({ id: 'research', template: { name: 'Research', templateDescription: 'Reads papers.', warning: 'Fetches the web.' } })
    expect(existsSync(join(templatesDir(), 'research.adf'))).toBe(true)
    expect(existsSync(join(templatesDir(), 'research-copy.adf'))).toBe(false)

    expect((await call(server, 'POST', '/templates/research/default')).body.defaultId).toBe('research')
    expect((await call(server, 'GET', '/templates')).body.defaultId).toBe('research')

    expect((await call(server, 'PUT', '/templates/research/files', { path: 'mind.md', content: '# mind\nremember' })).status).toBe(200)
    expect((await call(server, 'PUT', '/templates/research/files', { path: 'notes/a.txt', content: 'extra' })).status).toBe(200)
    let contents = (await call(server, 'GET', '/templates/research')).body.contents
    expect(contents.files.mind).toBe('# mind\nremember')
    expect(contents.extra.map((f: { path: string }) => f.path)).toContain('notes/a.txt')
    expect((await call(server, 'DELETE', '/templates/research/files?path=notes%2Fa.txt')).status).toBe(200)
    expect((await call(server, 'DELETE', '/templates/research/files?path=mind.md')).status).toBe(400)

    // A template may leave provider + model unset (shipped ones do): editing it still saves.
    expect(contents.config.model.provider).toBe('')
    expect((await call(server, 'PUT', '/templates/research/config', { config: { ...contents.config, instructions: 'Unset model is fine.' } })).status).toBe(200)
    const config = { ...contents.config, model: { ...contents.config.model, provider: 'anthropic', model_id: 'claude-sonnet' }, instructions: 'Be brief.' }
    expect((await call(server, 'PUT', '/templates/research/config', { config })).status).toBe(200)
    contents = (await call(server, 'GET', '/templates/research')).body.contents
    expect(contents.config.instructions).toBe('Be brief.')
    const invalid = await call(server, 'PUT', '/templates/research/config', { config: { ...config, tools: 'nope' } })
    expect(invalid.status).toBe(400)
    expect(invalid.body.error).toContain('tools')

    const deleted = await call(server, 'DELETE', '/templates/research')
    expect(deleted.status).toBe(200)
    expect(deleted.body).toMatchObject({ deleted: true, defaultId: 'standard' })
    expect(existsSync(join(templatesDir(), 'research.adf'))).toBe(false)
    const trash = join(h.userDataDir, 'templates-trash')
    expect(readdirSync(trash).some((f) => f.startsWith('research-') && f.endsWith('.adf'))).toBe(true)
    expect((await call(server, 'DELETE', '/templates/research')).status).toBe(404)
  })

  it('resets a shipped template; refuses a user one', async () => {
    const { server } = makeDaemon()
    await call(server, 'POST', '/identity/create', {})
    const before = (await call(server, 'GET', '/templates/standard')).body.contents.files.readme
    await call(server, 'PUT', '/templates/standard/files', { path: 'README.md', content: 'changed' })
    expect((await call(server, 'GET', '/templates/standard')).body.contents.files.readme).toBe('changed')
    const reset = await call(server, 'POST', '/templates/standard/reset')
    expect(reset.status).toBe(200)
    expect((await call(server, 'GET', '/templates/standard')).body.contents.files.readme).toBe(before)
    await call(server, 'POST', '/templates', { name: 'Mine' })
    expect((await call(server, 'POST', '/templates/mine/reset')).status).toBe(400)
  })

  it('reviews a foreign template with the agent review summary, and accepting claims it', async () => {
    const { server, identity } = makeDaemon()
    await call(server, 'POST', '/identity/create', {})
    await call(server, 'GET', '/templates')
    // Someone else's template: no identity of ours (stripped), not reviewed.
    const file = join(templatesDir(), 'shared-find.adf')
    const ws = AdfWorkspace.create(file, { name: 'Shared find' })
    ws.close()
    AdfDatabase.stripIdentity(file)

    const listed = (await call(server, 'GET', '/templates')).body.templates.find((t: { id: string }) => t.id === 'shared-find')
    expect(listed.reviewed).toBe(false)
    const review = await call(server, 'GET', '/templates/shared-find/review')
    expect(review.status).toBe(200)
    expect(review.body).toMatchObject({ needsReview: true, reviewed: false, summary: { name: 'Shared find', identity: { scenario: 'unclaimed', needsClaim: true } } })
    expect(Array.isArray(review.body.summary.tools)).toBe(true)
    expect(review.body.summary.provider.status).toMatch(/missing|unchecked/)

    const accepted = await call(server, 'POST', '/templates/shared-find/review/accept', {})
    expect(accepted.status).toBe(200)
    expect(accepted.body).toMatchObject({ reviewed: true, template: { reviewed: true } })
    const after = AdfWorkspace.open(file)
    try {
      expect(after.getDid()).toMatch(/^did:key:z/)
      expect(after.getMeta('adf_owner_did')).toBe(identity.status().ownerDid)
      expect(after.getAgentConfig().locked_fields).toContain('compute')
    } finally {
      after.close()
    }
    expect((await call(server, 'GET', '/templates/shared-find/review')).body.needsReview).toBe(false)
  })
})
