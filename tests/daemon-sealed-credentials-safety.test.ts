import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Data safety: a Studio-sealed agent loaded by a daemon that cannot open its
 * envelopes (owner identity none / restore-needed / a different owner) must
 * never lose, overwrite or re-key its sealed credentials — and its adapters
 * must recover once the identity becomes ready.
 */

const h = vi.hoisted(() => ({ userDataDir: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => h.userDataDir, on: () => {}, getName: () => 't', getVersion: () => '0' },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s, 'utf-8'),
    decryptString: (b: Buffer) => b.toString('utf-8'),
  },
  shell: { openExternal: async () => {} },
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
  BrowserWindow: class {},
  dialog: {},
}))

// Stand-in for the Telegram adapter: no network, same credential contract
// (reads adapter:telegram:TELEGRAM_BOT_TOKEN through ctx.getCredential).
vi.mock('../src/main/adapters/telegram/index', () => ({
  createAdapter: () => {
    let status: 'connected' | 'disconnected' = 'disconnected'
    return {
      start: async (ctx: { getCredential: (k: string) => string | null }) => {
        if (!ctx.getCredential('TELEGRAM_BOT_TOKEN')) throw new Error('Missing TELEGRAM_BOT_TOKEN credential.')
        status = 'connected'
      },
      stop: async () => { status = 'disconnected' },
      send: async () => ({ success: true }),
      canDeliver: () => true,
      status: () => status,
    }
  },
}))

import { FileSettingsStore } from '../src/main/daemon/file-settings-store'
import { ensureDaemonEncKey } from '../src/main/daemon/daemon-enc-key'
import { DaemonIdentity } from '../src/main/daemon/daemon-identity'
import { DaemonAgentFactory } from '../src/main/daemon/daemon-agent-factory'
import { createDaemonHttpApi } from '../src/main/daemon/http-api'
import { RuntimeService } from '../src/main/runtime/runtime-service'
import { AgentRuntimeBuilder } from '../src/main/runtime/agent-runtime-builder'
import { MockLLMProvider } from '../src/main/runtime/headless'
import { setWorkspaceIdentityHooks } from '../src/main/runtime/identity-provisioner'
import { AdfWorkspace } from '../src/main/adf/adf-workspace'
import { SettingsService } from '../src/main/services/settings.service'
import { deriveOwnerEncryptionKey, generateMnemonic } from '../src/main/crypto/mnemonic-identity'
import { KeychainSecretBackend } from '../src/main/services/owner-secret-store'

const TOKEN_PURPOSE = 'adapter:telegram:TELEGRAM_BOT_TOKEN'
const TOKEN = '123456:studio-sealed-token'

function fakeKeychainBackend() {
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
let settingsPath: string
let agentsDir: string
const servers: Array<{ close: () => Promise<unknown> }> = []
const runtimes: RuntimeService[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'adf-sealed-cred-safety-'))
  h.userDataDir = join(root, 'userData')
  mkdirSync(h.userDataDir, { recursive: true })
  process.env.ADF_USER_DATA_DIR = h.userDataDir
  settingsPath = join(h.userDataDir, 'adf-settings.json')
  agentsDir = join(root, 'agents')
  mkdirSync(agentsDir, { recursive: true })
})

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()))
  for (const runtime of runtimes.splice(0)) {
    for (const agent of runtime.listAgents()) await runtime.unloadAgent(agent.id, { mode: 'immediate' })
  }
  delete process.env.ADF_USER_DATA_DIR
  rmSync(root, { recursive: true, force: true })
})

/** Studio-made agent: envelopes for `phrase`'s owner, telegram enabled, token sealed. */
function makeStudioAgent(phrase: string): string {
  const studio = new SettingsService().getOwnerIdentity()
  studio.importMnemonic(phrase)
  studio.ensureIdentity()
  const file = join(agentsDir, 'agent-1.adf')
  const ws = AdfWorkspace.create(file, { name: 'agent-1' })
  try {
    studio.ensureWorkspaceIdentity(ws)
    expect(ws.getEnvelopeState('credentials')).toBe('unlocked')
    ws.setIdentity(TOKEN_PURPOSE, TOKEN)
    const config = ws.getAgentConfig()
    config.adapters = { telegram: { enabled: true, policy: { dm: 'all', groups: 'mention' } } } as typeof config.adapters
    config.tools = [...config.tools.filter((t) => t.name !== 'sys_update_config'), { name: 'sys_update_config', enabled: true, visible: true, restricted: false }]
    ws.setAgentConfig(config)
  } finally {
    ws.close()
  }
  return file
}

function makeDaemon() {
  const settings = new FileSettingsStore(settingsPath)
  const encKey = ensureDaemonEncKey(h.userDataDir)
  const identity = new DaemonIdentity({ settings, settingsPath, encKey, backend: fakeKeychainBackend() })
  // Same wiring as src/main/daemon/index.ts.
  setWorkspaceIdentityHooks({
    ensureIdentity: (ws) => {
      if (identity.isReady()) identity.service.ensureWorkspaceIdentity(ws)
      else identity.service.unlockWorkspaceEnvelopes(ws)
    },
    unlockEnvelopes: (ws) => identity.service.unlockWorkspaceEnvelopes(ws),
    canProvision: () => identity.isReady(),
  })
  const agentRuntimeBuilder = new AgentRuntimeBuilder({ settings })
  const runtime = new RuntimeService({ settings, providerFactory: () => new MockLLMProvider(), agentRuntimeBuilder })
  runtimes.push(runtime)
  identity.onReady(() => { void runtime.refreshAgentCredentials('owner identity ready') })
  const agentFactory = new DaemonAgentFactory({ settings, identity, runtime })
  const server = createDaemonHttpApi(runtime, { settingsStore: settings, identity, agentFactory })
  servers.push(server)
  return { settings, identity, runtime, server }
}

/** Read-only check on the file: the row exists, is still sealed, and the owner key opens it. */
function expectTokenIntact(file: string, phrase: string): void {
  const ws = AdfWorkspace.open(file)
  try {
    const row = ws.getIdentityRow(TOKEN_PURPOSE)
    expect(row).not.toBeNull()
    expect(row!.encryption_algo).toBe('env:credentials')
    ws.unlockEnvelopes({ ownerEncPrivateKey: deriveOwnerEncryptionKey(phrase).privateKeyPkcs8 })
    expect(ws.getIdentity(TOKEN_PURPOSE)).toBe(TOKEN)
  } finally {
    ws.close()
  }
}

function telegramState(runtime: RuntimeService, agentId: string) {
  const managed = (runtime as unknown as { agents: Map<string, { agent: { adapterManager: { getStates(): Array<{ type: string; status: string; error?: string }> } | null } }> }).agents.get(agentId)
  return managed?.agent.adapterManager?.getStates().find((s) => s.type === 'telegram')
}

async function toggleViaSysUpdateConfig(runtime: RuntimeService, agentId: string, enabled: boolean) {
  const managed = (runtime as unknown as { agents: Map<string, { agent: { registry: { get(n: string): { execute(i: unknown, ws: AdfWorkspace): Promise<{ isError: boolean; content: string }> } }; workspace: AdfWorkspace } }> }).agents.get(agentId)!
  const tool = managed.agent.registry.get('sys_update_config')
  const res = await tool.execute({ path: 'adapters.telegram.enabled', value: enabled }, managed.agent.workspace)
  expect(res.isError, res.content).toBe(false)
}

describe('AdfWorkspace.setIdentity on a locked envelope', () => {
  it('refuses to overwrite a sealed row with plaintext (agent set_identity / shell export / daemon writes)', () => {
    const phrase = generateMnemonic()
    const file = makeStudioAgent(phrase)
    const ws = AdfWorkspace.open(file) // no keys: envelopes stay foreign
    try {
      expect(ws.getEnvelopeState('credentials')).toBe('foreign')
      expect(() => ws.setIdentity(TOKEN_PURPOSE, '')).toThrow(/sealed/)
      // A brand-new purpose keeps the interim-plain contract (sealed on a later unlock).
      ws.setIdentity('adapter:telegram:OTHER', 'x')
      expect(ws.getIdentityRow('adapter:telegram:OTHER')!.encryption_algo).toBe('plain')
    } finally {
      ws.close()
    }
    expectTokenIntact(file, phrase)
  })
})

describe('sealed channel credentials survive a daemon that cannot open them', () => {
  it('load locked → toggle adapter off/on (tool + PUT config) → restore: token intact and adapter reconnects', async () => {
    const phrase = generateMnemonic()
    const file = makeStudioAgent(phrase)
    const { identity, runtime, server } = makeDaemon()
    expect(identity.status().status).toBe('restore-needed')

    const ref = await runtime.loadAgent(file, { enforceReviewGate: false })
    await vi.waitFor(() => expect(telegramState(runtime, ref.id)?.status).toBe('error'))
    expect(telegramState(runtime, ref.id)?.error).toMatch(/^credentials locked/)

    // The agent "resets" the adapter with its own tool, then the owner via PUT config.
    await toggleViaSysUpdateConfig(runtime, ref.id, false)
    await toggleViaSysUpdateConfig(runtime, ref.id, true)
    const cfg = (await server.inject({ method: 'GET', url: `/agents/${ref.id}/config` })).json()
    const config = cfg.config ?? cfg
    config.adapters.telegram.enabled = false
    expect((await server.inject({ method: 'PUT', url: `/agents/${ref.id}/config`, payload: config })).statusCode).toBe(200)
    config.adapters.telegram.enabled = true
    expect((await server.inject({ method: 'PUT', url: `/agents/${ref.id}/config`, payload: config })).statusCode).toBe(200)

    expectTokenIntact(file, phrase)
    // Re-enabled while locked: still the recoverable locked stub, not a
    // "Missing TELEGRAM_BOT_TOKEN" failure that never retries after unlock.
    await vi.waitFor(() => expect(telegramState(runtime, ref.id)?.error ?? '').toMatch(/^credentials locked/))

    const restored = await server.inject({ method: 'POST', url: '/identity/restore', payload: { mnemonic: phrase } })
    expect(restored.json().identity.status).toBe('ready')
    await vi.waitFor(() => expect(runtime.getAgentStatus(ref.id)?.degraded).toBeUndefined())
    await vi.waitFor(() => expect(telegramState(runtime, ref.id)?.status).toBe('connected'))

    expectTokenIntact(file, phrase)
  }, 60_000)

  it('identity restored first, then load: token intact, adapter connects', async () => {
    const phrase = generateMnemonic()
    const file = makeStudioAgent(phrase)
    const { runtime, server } = makeDaemon()
    expect((await server.inject({ method: 'POST', url: '/identity/restore', payload: { mnemonic: phrase } })).json().identity.status).toBe('ready')
    const ref = await runtime.loadAgent(file, { enforceReviewGate: false })
    await vi.waitFor(() => expect(telegramState(runtime, ref.id)?.status).toBe('connected'))
    await toggleViaSysUpdateConfig(runtime, ref.id, false)
    await toggleViaSysUpdateConfig(runtime, ref.id, true)
    await vi.waitFor(() => expect(telegramState(runtime, ref.id)?.status).toBe('connected'))
    expectTokenIntact(file, phrase)
  }, 60_000)

  it('Studio owner differs from the daemon owner: nothing is deleted, re-keyed or written plain', async () => {
    const studioPhrase = generateMnemonic()
    const file = makeStudioAgent(studioPhrase)
    // A different machine owner in the daemon's settings (e.g. `adf identity new` on a separate settings file).
    rmSync(settingsPath, { force: true })
    const { runtime, server } = makeDaemon()
    const created = await server.inject({ method: 'POST', url: '/identity/create', payload: {} })
    expect(created.statusCode).toBe(201)
    const before = AdfWorkspace.open(file)
    const slotsBefore = JSON.stringify(before.readEnvelopeSlots('credentials'))
    before.close()

    const ref = await runtime.loadAgent(file, { enforceReviewGate: false })
    await toggleViaSysUpdateConfig(runtime, ref.id, false)
    await toggleViaSysUpdateConfig(runtime, ref.id, true)
    await vi.waitFor(() => expect(telegramState(runtime, ref.id)?.error ?? '').toMatch(/^credentials locked/))

    // Owner-side credential write while locked must be refused, not written plain over the sealed row.
    const put = await server.inject({ method: 'PUT', url: `/agents/${ref.id}/adapters/credentials`, payload: { adapterType: 'telegram', envKey: 'TELEGRAM_BOT_TOKEN', value: 'other' } })
    expect(put.statusCode).toBeGreaterThanOrEqual(400)
    const putIdentity = await server.inject({ method: 'PUT', url: `/agents/${ref.id}/identity/${encodeURIComponent(TOKEN_PURPOSE)}`, payload: { value: 'other' } })
    expect(putIdentity.statusCode).toBeGreaterThanOrEqual(400)

    const after = AdfWorkspace.open(file)
    expect(JSON.stringify(after.readEnvelopeSlots('credentials'))).toBe(slotsBefore)
    after.close()
    expectTokenIntact(file, studioPhrase)
  }, 60_000)
})
