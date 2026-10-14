/**
 * W2-A follow-ups that need an owner identity: create without load (closed,
 * or held as an open document), the identity-draft outcome in the create
 * answer, review summary and accept parity, TEMPLATE_CHECK_REVIEW parity,
 * MODELS_LIST for a file, discovery `force`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
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
import { createHeadlessAgent, MockLLMProvider } from '../src/main/runtime/headless'
import { setWorkspaceIdentityHooks } from '../src/main/runtime/identity-provisioner'
import { AdfWorkspace } from '../src/main/adf/adf-workspace'
import { KeychainSecretBackend } from '../src/main/services/owner-secret-store'
import { RuntimeGate } from '../src/main/runtime/runtime-gate'

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
const closers: Array<() => Promise<unknown> | unknown> = []

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'adf-w2a-create-')))
  h.userDataDir = join(root, 'userData')
  mkdirSync(h.userDataDir, { recursive: true })
  process.env.ADF_USER_DATA_DIR = h.userDataDir
})

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    try { await close() } catch { /* best effort */ }
  }
  setWorkspaceIdentityHooks({ ensureIdentity: () => {}, unlockEnvelopes: () => {} })
  RuntimeGate._resetForTests()
  delete process.env.ADF_USER_DATA_DIR
  // No links in here (junction safety): plain temp files only.
  rmSync(root, { recursive: true, force: true })
})

function makeDaemon(opts: { discovered?: (args?: { force?: boolean }) => unknown[] } = {}) {
  const settingsPath = join(h.userDataDir, 'adf-settings.json')
  const settings = new FileSettingsStore(settingsPath)
  const identity = new DaemonIdentity({ settings, settingsPath, encKey: ensureDaemonEncKey(h.userDataDir), backend: fakeKeychain() })
  setWorkspaceIdentityHooks(identity.workspaceHooks())
  const runtime = new RuntimeService({ settings, providerFactory: () => new MockLLMProvider() })
  const agentFactory = new DaemonAgentFactory({ settings, identity, runtime })
  const server = createDaemonHttpApi(runtime, {
    settingsStore: settings,
    identity,
    agentFactory,
    networkService: { getStatus: () => ({}), getDiscoveredRuntimes: opts.discovered ?? (() => []) },
  })
  closers.push(() => server.close())
  closers.push(async () => {
    for (const a of runtime.listAgents()) await runtime.unloadAgent(a.id, { mode: 'immediate' })
    for (const d of runtime.listOpenDocuments()) runtime.closeDocument(d.filePath, 'released')
  })
  return { server, settings, identity, runtime }
}

type Server = ReturnType<typeof makeDaemon>['server']
const call = async (server: Server, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) => {
  const res = await server.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) })
  return { status: res.statusCode, body: res.json() as Record<string, any> }
}

describe('POST /agents/create without load (FILE_CREATE, FILE_CREATE_QUICK, MESH_FOUND_AGENT)', () => {
  it('load: false leaves the new file closed; with a holder it is an open document, not running', async () => {
    const { server, runtime } = makeDaemon()
    await call(server, 'POST', '/identity/create', {})
    const dir = join(root, 'agents')
    mkdirSync(dir)

    const closed = await call(server, 'POST', '/agents/create', { name: 'agent-1', directory: dir, load: false })
    expect(closed.status).toBe(201)
    expect(closed.body).toMatchObject({ name: 'agent-1', loaded: false, started: false })
    expect(closed.body.document).toBeUndefined()
    expect(runtime.listAgents()).toEqual([])
    expect(runtime.listOpenDocuments()).toEqual([])
    expect(existsSync(closed.body.filePath)).toBe(true)

    const held = await call(server, 'POST', '/agents/create', { name: 'agent-2', directory: dir, load: false, holder: 'session-1' })
    expect(held.status).toBe(201)
    expect(held.body).toMatchObject({ name: 'agent-2', loaded: false, started: false, document: { running: false, holders: 1, needsPassword: false } })
    expect(runtime.listAgents()).toEqual([])
    expect(runtime.getOpenDocument(held.body.agentId)).toMatchObject({ holders: 1 })
    expect((await call(server, 'GET', `/agents/${held.body.agentId}/config`)).status).toBe(200)

    // The default still loads.
    const loaded = await call(server, 'POST', '/agents/create', { name: 'agent-3', directory: dir })
    expect(loaded.body).toMatchObject({ loaded: true, started: false })
    expect(runtime.getAgent(loaded.body.agentId)).toBeDefined()

    expect((await call(server, 'POST', '/agents/create', { name: 'agent-4', directory: dir, load: false, start: true })).status).toBe(400)
    expect((await call(server, 'POST', '/agents/create', { name: 'agent-4', directory: dir, holder: 'session-1' })).status).toBe(400)
    expect((await call(server, 'POST', '/agents/create', { name: 'agent-4', directory: dir, load: 'no' })).status).toBe(400)
  })

  it('reports an unknown or expired identity draft in the answer, not only in the log', async () => {
    const { server } = makeDaemon()
    await call(server, 'POST', '/identity/create', {})
    const dir = join(root, 'agents')
    mkdirSync(dir)
    const draft = await call(server, 'POST', '/identity/drafts')
    const adopted = await call(server, 'POST', '/agents/create', { name: 'agent-1', directory: dir, load: false, identityDraftId: draft.body.draftId })
    expect(adopted.body).toMatchObject({ identityDraft: 'adopted', did: draft.body.did })
    expect(adopted.body.warnings).toBeUndefined()
    const unknown = await call(server, 'POST', '/agents/create', { name: 'agent-2', directory: dir, load: false, identityDraftId: 'no-such-draft' })
    expect(unknown.status).toBe(201)
    expect(unknown.body.identityDraft).toBe('unknown')
    expect(unknown.body.warnings).toEqual([expect.stringMatching(/expired.*fresh identity/)])
  })
})

describe('review parity (FILE_CHECK_REVIEW, FILE_REVIEW_ACCEPT, TEMPLATE_CHECK_REVIEW)', () => {
  function foreignAgent(dir: string, name: string) {
    const filePath = join(dir, `${name}.adf`)
    const created = createHeadlessAgent({ filePath, name, provider: new MockLLMProvider(), createOptions: { handle: name } })
    const id = created.workspace.getAgentConfig().id
    created.dispose()
    return { filePath: realpathSync.native(filePath), id }
  }

  it('the summary carries the identity scenario, the provider check and willRelocate; accept claims, overrides the model and locks fields', async () => {
    const { server, settings, runtime } = makeDaemon()
    await call(server, 'POST', '/identity/create', {})
    settings.set('providers', [{ id: 'local', type: 'openai-compatible', name: 'Local', baseUrl: 'http://127.0.0.1:1/v1', apiKey: '' }])
    const outside = join(root, 'downloads')
    mkdirSync(outside)
    const agent = foreignAgent(outside, 'agent-1')

    const review = await call(server, 'GET', `/agents/review?filePath=${encodeURIComponent(agent.filePath)}`)
    expect(review.status).toBe(200)
    expect(review.body).toMatchObject({ agentId: agent.id, reviewed: false, needsReview: true })
    expect(review.body.summary.identity.scenario).toEqual(expect.any(String))
    expect(review.body.summary.willRelocate).toBe(true)
    expect(review.body.summary.relocateTo).toEqual(expect.any(String))

    // An open document is reviewed through its own workspace.
    await runtime.openDocument(agent.filePath, { holder: 'session-1' })
    const unknownModel = await call(server, 'POST', '/agents/review/accept', { filePath: agent.filePath, model: { provider: 'nope', model_id: 'm' } })
    expect(unknownModel).toMatchObject({ status: 400, body: { code: 'provider_unknown' } })
    const accepted = await call(server, 'POST', '/agents/review/accept', { filePath: agent.filePath, claim: true, model: { provider: 'local', model_id: 'm-1' } })
    expect(accepted.status).toBe(200)
    expect(accepted.body).toMatchObject({ agentId: agent.id, reviewed: true, claimed: true })
    expect(accepted.body.did).toMatch(/^did:key:z/)
    expect(accepted.body.config.model).toMatchObject({ provider: 'local', model_id: 'm-1' })
    expect(accepted.body.config.locked_fields?.length ?? 0).toBeGreaterThan(0)
    expect(runtime.getAgentConfig(agent.id).config.model.model_id).toBe('m-1')
    const after = await call(server, 'GET', `/agents/review?filePath=${encodeURIComponent(agent.filePath)}`)
    expect(after.body).toMatchObject({ reviewed: true, needsReview: false })
    expect(after.body.summary.identity.scenario).toBe('mine')
  })

  it('a claim of a password-protected file needs its key (409 password_required) and removes the password with it', async () => {
    const { server, runtime } = makeDaemon()
    await call(server, 'POST', '/identity/create', {})
    const dir = join(root, 'agents')
    mkdirSync(dir)
    const agent = foreignAgent(dir, 'agent-1')
    const ws = AdfWorkspace.open(agent.filePath)
    ws.setIdentity('custom:secret', 'hunter2')
    ws.setPassword('pw-1')
    ws.close()
    await runtime.openDocument(agent.filePath, { holder: 'session-1' })
    expect((await call(server, 'POST', '/agents/review/accept', { filePath: agent.filePath, claim: true })).body.code).toBe('password_required')
    expect((await call(server, 'POST', `/agents/${agent.id}/identity/password/unlock`, { password: 'pw-1' })).status).toBe(200)
    expect((await call(server, 'POST', '/agents/review/accept', { filePath: agent.filePath, claim: true })).status).toBe(200)
    expect(runtime.getOpenDocument(agent.id)).toMatchObject({ needsPassword: false })
    expect((await call(server, 'GET', `/agents/${agent.id}/identity/password`)).body).toMatchObject({ needsPassword: false, unlocked: false })
  })

  it('TEMPLATE_CHECK_REVIEW: needsReview false with identityReady false before the owner identity exists; afterwards a provider check, not "unchecked"', async () => {
    const { server, settings } = makeDaemon()
    const before = await call(server, 'GET', '/templates/standard/review')
    expect(before.status).toBe(200)
    expect(before.body).toMatchObject({ needsReview: false, identityReady: false })
    await call(server, 'POST', '/identity/create', {})
    settings.set('providers', [{ id: 'local', type: 'openai-compatible', name: 'Local', baseUrl: 'http://127.0.0.1:1/v1', apiKey: '' }])
    settings.set('defaultProviderId', 'local')
    const review = await call(server, 'GET', '/templates/standard/review')
    expect(review.status).toBe(200)
    expect(review.body.summary).toBeDefined()
    // The check ran (an unreachable local endpoint fails), or the template names no local provider.
    expect(['ok', 'failed', 'unconfigured', 'missing']).toContain(review.body.summary.provider.status)
    settings.set('providerChecksEnabled', false)
    const off = await call(server, 'GET', '/templates/standard/review')
    expect(['ok', 'failed', 'unconfigured', 'missing', 'unchecked']).toContain(off.body.summary.provider.status)
  })
})

describe('MODELS_LIST for a file, discovery force', () => {
  it('GET /runtime/models resolves an agent file\'s own provider (closed, then open)', async () => {
    const { server, runtime, settings } = makeDaemon()
    const dir = join(root, 'agents')
    mkdirSync(dir)
    const filePath = join(dir, 'agent-1.adf')
    const created = createHeadlessAgent({ filePath, name: 'agent-1', provider: new MockLLMProvider() })
    created.workspace.setAgentConfig({
      ...created.workspace.getAgentConfig(),
      providers: [{ id: 'own', type: 'chatgpt-subscription', name: 'Own' } as never],
    })
    created.dispose()
    const q = encodeURIComponent(realpathSync.native(filePath))
    const closed = await call(server, 'GET', `/runtime/models?provider=own&filePath=${q}`)
    expect(closed.status).toBe(200)
    expect(closed.body.error).toBeUndefined()
    expect(closed.body.models.length).toBeGreaterThan(0)
    await runtime.openDocument(filePath, { holder: 'session-1' })
    expect((await call(server, 'GET', `/runtime/models?provider=own&filePath=${q}`)).body.models.length).toBeGreaterThan(0)
    expect((await call(server, 'GET', '/runtime/models?provider=own&filePath=relative.adf')).status).toBe(400)
    // Opening it surfaced its own provider in settings (Studio's FILE_OPEN), keyless, stored in the agent.
    expect((settings.get('providers') as Array<Record<string, unknown>>).find(p => p.id === 'own')).toMatchObject({ apiKey: '', credentialStorage: 'agent' })
  })

  it('GET /network/mesh/discovered-runtimes forwards force', async () => {
    const seen: Array<boolean | undefined> = []
    const { server } = makeDaemon({ discovered: (args) => { seen.push(args?.force); return [] } })
    await call(server, 'GET', '/network/mesh/discovered-runtimes')
    await call(server, 'GET', '/network/mesh/discovered-runtimes?force=1')
    expect(seen).toEqual([false, true])
    expect((await call(server, 'GET', '/network/mesh/discovered-runtimes?force=yes')).status).toBe(400)
  })
})
