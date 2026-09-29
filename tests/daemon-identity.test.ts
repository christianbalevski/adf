import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Studio side runs with a working safeStorage (passthrough), like a signed build.
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

import { FileSettingsStore } from '../src/main/daemon/file-settings-store'
import { ensureDaemonEncKey } from '../src/main/daemon/daemon-enc-key'
import { DaemonIdentity } from '../src/main/daemon/daemon-identity'
import { DaemonAgentFactory } from '../src/main/daemon/daemon-agent-factory'
import { createDaemonHttpApi } from '../src/main/daemon/http-api'
import { RuntimeService } from '../src/main/runtime/runtime-service'
import { MockLLMProvider } from '../src/main/runtime/headless'
import { setWorkspaceIdentityHooks } from '../src/main/runtime/identity-provisioner'
import { AdfWorkspace } from '../src/main/adf/adf-workspace'
import { CreateAdfTool } from '../src/main/tools/built-in/sys-create-adf.tool'
import { SettingsService } from '../src/main/services/settings.service'
import { readAdfAttestations, verifyAttestation } from '../src/main/services/attestation.service'
import { deriveOwnerEncryptionKey, deriveOwnerIdentity, generateMnemonic } from '../src/main/crypto/mnemonic-identity'
import {
  FileSecretBackend,
  KeychainSecretBackend,
  OWNER_MNEMONIC_ACCOUNT,
  type SharedMnemonicStore,
} from '../src/main/services/owner-secret-store'

/** One in-memory "OS keychain" shared by Studio and the daemon in a test. */
function fakeKeychain() {
  const store = new Map<string, string>()
  class Entry {
    constructor(private service: string, private account: string) {}
    getPassword() { return store.get(`${this.service}/${this.account}`) ?? null }
    setPassword(p: string) { store.set(`${this.service}/${this.account}`, p) }
    deleteCredential() { return store.delete(`${this.service}/${this.account}`) }
  }
  const backend = new KeychainSecretBackend(Entry)
  const shared: SharedMnemonicStore = {
    read: () => backend.get(OWNER_MNEMONIC_ACCOUNT),
    write: (m) => backend.set(OWNER_MNEMONIC_ACCOUNT, m),
  }
  return { store, backend, shared }
}

let root: string
let settingsPath: string
let agentsDir: string
const servers: Array<{ close: () => Promise<unknown> }> = []
const runtimes: RuntimeService[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'adf-daemon-identity-'))
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

function makeDaemon(opts: { backend?: ConstructorParameters<typeof DaemonIdentity>[0]['backend'] } = {}) {
  const settings = new FileSettingsStore(settingsPath)
  const encKey = ensureDaemonEncKey(h.userDataDir)
  const identity = new DaemonIdentity({ settings, settingsPath, encKey, backend: opts.backend ?? fakeKeychain().backend })
  // Same wiring as src/main/daemon/index.ts.
  setWorkspaceIdentityHooks({
    ensureIdentity: (ws) => {
      if (identity.isReady()) identity.service.ensureWorkspaceIdentity(ws)
      else identity.service.unlockWorkspaceEnvelopes(ws)
    },
    unlockEnvelopes: (ws) => identity.service.unlockWorkspaceEnvelopes(ws),
    canProvision: () => identity.isReady(),
  })
  const runtime = new RuntimeService({ settings, providerFactory: () => new MockLLMProvider() })
  runtimes.push(runtime)
  const agentFactory = new DaemonAgentFactory({ settings, identity, runtime })
  const server = createDaemonHttpApi(runtime, { settingsStore: settings, identity, agentFactory })
  servers.push(server)
  return { settings, encKey, identity, runtime, agentFactory, server }
}

/** Assert a file carries a Studio-grade identity for `ownerDid`, verifiable with the phrase alone. */
function expectSealedOwnedIdentity(filePath: string, mnemonic: string, ownerDid: string, runtimeDid: string): string {
  const ws = AdfWorkspace.open(filePath)
  try {
    const did = ws.getDid()
    expect(did).toMatch(/^did:key:z/)
    expect(ws.hasEnvelopes()).toBe(true)
    expect(ws.getIdentityRow('crypto:signing:private_key')?.encryption_algo).not.toBe('plain')
    expect(ws.getMeta('adf_owner_did')).toBe(ownerDid)
    expect(ws.getMeta('adf_runtime_did')).toBe(runtimeDid)
    // The owner key alone opens the identity envelope (any machine with the phrase).
    const states = ws.unlockEnvelopes({ ownerEncPrivateKey: deriveOwnerEncryptionKey(mnemonic).privateKeyPkcs8 })
    expect(states.identity).toBe('unlocked')
    const owner = readAdfAttestations(ws).find((a) => a.role === 'owner')
    expect(owner?.issuer).toBe(ownerDid)
    expect(verifyAttestation(owner!, { expectedSubject: did! })).toBe(true)
    const operator = readAdfAttestations(ws).find((a) => a.role === 'operator')
    expect(operator?.issuer).toBe(runtimeDid)
    expect(verifyAttestation(operator!, { expectedSubject: did! })).toBe(true)
    return did!
  } finally {
    ws.close()
  }
}

describe('daemon owner identity API', () => {
  it('create: none → ready, returns the words once, never again', async () => {
    const { server } = makeDaemon()

    const before = (await server.inject({ method: 'GET', url: '/identity' })).json()
    expect(before).toMatchObject({ status: 'none', ownerDid: null, storage: 'keychain', passphraseRequired: false })

    const created = await server.inject({ method: 'POST', url: '/identity/create', payload: {} })
    expect(created.statusCode).toBe(201)
    expect(created.headers['cache-control']).toBe('no-store')
    const body = created.json()
    expect(body.words).toHaveLength(12)
    expect(body.mnemonic).toBe(body.words.join(' '))
    expect(body.identity).toMatchObject({ status: 'ready', backupConfirmed: false })
    expect(body.identity.ownerDid).toBe(deriveOwnerIdentity(body.mnemonic).did)
    expect(body.identity.runtimeDid).toMatch(/^did:key:z/)

    // A second create is refused; nothing else ever carries the phrase.
    const again = await server.inject({ method: 'POST', url: '/identity/create', payload: {} })
    expect(again.statusCode).toBe(409)
    expect(again.json().code).toBe('identity_exists')
    const firstWord = body.words[0] as string
    for (const url of ['/identity', '/settings', '/settings/ownerMnemonic', '/runtime/settings']) {
      const res = await server.inject({ method: 'GET', url })
      expect(res.body).not.toContain(body.mnemonic)
      expect(res.body.includes(`"${firstWord} `)).toBe(false)
    }
    expect(readFileSync(settingsPath, 'utf-8')).not.toContain(body.mnemonic)

    const confirmed = await server.inject({ method: 'POST', url: '/identity/confirm-backup' })
    expect(confirmed.json().identity.backupConfirmed).toBe(true)
  })

  it('restore: refuses a phrase for another owner, accepts the matching one, and never writes Studio runtime keys', async () => {
    // Studio already set this machine up (its owner + its own runtime key).
    const studioPhrase = generateMnemonic()
    const studio = new SettingsService()
    studio.getOwnerIdentity().importMnemonic(studioPhrase)
    studio.getOwnerIdentity().ensureIdentity()
    const studioRuntime = studio.get('runtimeDid')
    const studioOwner = studio.get('ownerDid') as string
    expect(studioRuntime).toBeTruthy()

    const { server } = makeDaemon() // empty keychain: Studio could not mirror (no keychain wired here)
    const status = (await server.inject({ method: 'GET', url: '/identity' })).json()
    expect(status).toMatchObject({ status: 'restore-needed', ownerDid: studioOwner })

    const wrong = await server.inject({ method: 'POST', url: '/identity/restore', payload: { mnemonic: generateMnemonic() } })
    expect(wrong.statusCode).toBe(409)
    expect(wrong.json().code).toBe('owner_mismatch')

    const invalid = await server.inject({ method: 'POST', url: '/identity/restore', payload: { mnemonic: 'not a phrase' } })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.body).not.toContain('not a phrase')

    const ok = await server.inject({ method: 'POST', url: '/identity/restore', payload: { mnemonic: `  ${studioPhrase.toUpperCase()} ` } })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().identity).toMatchObject({ status: 'ready', ownerDid: studioOwner })

    const disk = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
    expect(disk.runtimeDid).toBe(studioRuntime)
    expect(disk.ownerDid).toBe(studioOwner)
    expect(disk.daemonRuntimeDid).toMatch(/^did:key:z/)
    expect(disk.daemonRuntimeDid).not.toBe(studioRuntime)
  })

  it('secret routes answer loopback callers only', async () => {
    const { server } = makeDaemon()
    for (const url of ['/identity/create', '/identity/restore', '/identity/unlock']) {
      const res = await server.inject({ method: 'POST', url, payload: {}, remoteAddress: '10.1.2.3' })
      expect(res.statusCode).toBe(403)
      expect(res.json().code).toBe('loopback_only')
    }
    expect((await server.inject({ method: 'GET', url: '/identity', remoteAddress: '10.1.2.3' })).statusCode).toBe(200)
  })

  it('file storage: passphrase to create, locked after restart, wrong passphrase refused, unlock → ready', async () => {
    const file = () => new FileSecretBackend(join(h.userDataDir, 'owner-secrets.json'))
    const first = makeDaemon({ backend: file() })
    const none = (await first.server.inject({ method: 'GET', url: '/identity' })).json()
    expect(none).toMatchObject({ status: 'none', storage: 'file', passphraseRequired: true })
    expect((await first.server.inject({ method: 'POST', url: '/identity/create', payload: {} })).json().code).toBe('passphrase_required')
    expect((await first.server.inject({ method: 'POST', url: '/identity/create', payload: { passphrase: 'short' } })).json().code).toBe('weak_passphrase')
    const created = await first.server.inject({ method: 'POST', url: '/identity/create', payload: { passphrase: 'a long passphrase' } })
    expect(created.statusCode).toBe(201)
    const { mnemonic } = created.json()
    expect(readFileSync(join(h.userDataDir, 'owner-secrets.json'), 'utf-8')).not.toContain(mnemonic.split(' ')[0] + ' ')

    // "Restart": a new daemon over the same files starts locked.
    const second = makeDaemon({ backend: file() })
    expect((await second.server.inject({ method: 'GET', url: '/identity' })).json()).toMatchObject({ status: 'locked', passphraseRequired: true })
    const bad = await second.server.inject({ method: 'POST', url: '/identity/unlock', payload: { passphrase: 'nope nope nope' } })
    expect(bad.statusCode).toBe(403)
    expect(bad.json().code).toBe('wrong_passphrase')
    const good = await second.server.inject({ method: 'POST', url: '/identity/unlock', payload: { passphrase: 'a long passphrase' } })
    expect(good.json().identity).toMatchObject({ status: 'ready', ownerDid: deriveOwnerIdentity(mnemonic).did })
    const locked = await second.server.inject({ method: 'POST', url: '/identity/lock' })
    expect(locked.json().identity.status).toBe('locked')
  })
})

describe('daemon agent creation', () => {
  it('409 until the identity is ready, then 201 with a Studio-grade sealed identity; 409 name taken; 422 template missing', async () => {
    const { server, identity } = makeDaemon()

    const early = await server.inject({ method: 'POST', url: '/agents/create', payload: { name: 'agent-1', directory: agentsDir } })
    expect(early.statusCode).toBe(409)
    expect(early.json()).toMatchObject({ code: 'identity_not_ready', identity: { status: 'none' } })
    expect((await server.inject({ method: 'GET', url: '/templates' })).statusCode).toBe(409)

    const { mnemonic } = (await server.inject({ method: 'POST', url: '/identity/create', payload: {} })).json()
    const status = identity.status()

    const templates = (await server.inject({ method: 'GET', url: '/templates' })).json()
    expect(templates.templates.map((t: { id: string }) => t.id)).toContain('standard')
    expect(templates.defaultId).toBe('standard')

    const bad = await server.inject({ method: 'POST', url: '/agents/create', payload: { name: 'a/b', directory: agentsDir } })
    expect(bad.statusCode).toBe(400)
    const relative = await server.inject({ method: 'POST', url: '/agents/create', payload: { name: 'agent-1', directory: 'agents' } })
    expect(relative.statusCode).toBe(400)

    const created = await server.inject({ method: 'POST', url: '/agents/create', payload: { name: 'agent-1', directory: agentsDir } })
    expect(created.statusCode).toBe(201)
    const agent = created.json()
    expect(agent).toMatchObject({ name: 'agent-1', filePath: join(agentsDir, 'agent-1.adf'), started: false })
    expect(created.body).not.toContain(mnemonic)
    const did = expectSealedOwnedIdentity(agent.filePath, mnemonic, status.ownerDid!, status.runtimeDid!)
    expect(agent.did).toBe(did)
    expect((await server.inject({ method: 'GET', url: `/agents/${agent.agentId}` })).statusCode).toBe(200)

    const disk = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
    const cfgWs = AdfWorkspace.open(agent.filePath)
    const configId = cfgWs.getAgentConfig().id
    cfgWs.close()
    expect(JSON.stringify(disk.reviewedAgents)).toContain(configId)
    expect((disk.trackedDirectories as string[]).length).toBe(1)

    const taken = await server.inject({ method: 'POST', url: '/agents/create', payload: { name: 'agent-1', directory: agentsDir } })
    expect(taken.statusCode).toBe(409)
    expect(taken.json().code).toBe('name_taken')

    const missing = await server.inject({ method: 'POST', url: '/agents/create', payload: { name: 'agent-2', directory: agentsDir, template: 'no-such-template' } })
    expect(missing.statusCode).toBe(422)
    expect(missing.json().code).toBe('template_missing')
    expect(existsSync(join(agentsDir, 'agent-2.adf'))).toBe(false)
  }, 60_000)

  it('422 load_failed when the new file cannot load (e.g. no provider): the file stays and the message says so', async () => {
    const { server, runtime } = makeDaemon()
    await server.inject({ method: 'POST', url: '/identity/create', payload: {} })
    runtime.loadAgent = (async () => { throw new Error('Provider "" not found.') }) as typeof runtime.loadAgent
    const res = await server.inject({ method: 'POST', url: '/agents/create', payload: { name: 'agent-1', directory: agentsDir } })
    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe('load_failed')
    expect(res.json().error).toContain('Provider "" not found.')
    expect(res.json().error).toContain(join(agentsDir, 'agent-1.adf'))
    expect(existsSync(join(agentsDir, 'agent-1.adf'))).toBe(true)
  }, 60_000)

  it('sys_create_adf: DID-less child without an identity, sealed + attested child with one', async () => {
    const { server, identity } = makeDaemon()
    const parentPath = join(agentsDir, 'agent-1.adf')
    const parent = AdfWorkspace.create(parentPath, { name: 'agent-1' })
    try {
      const bare = await new CreateAdfTool().execute({ name: 'agent-2' }, parent)
      expect(bare.isError).toBe(false)
      expect(bare.content).toContain('DID: none')
      const bareWs = AdfWorkspace.open(join(agentsDir, 'agent-2.adf'))
      try {
        expect(bareWs.getDid()).toBeNull()
        expect(bareWs.getIdentityRow('crypto:signing:private_key')).toBeNull()
      } finally {
        bareWs.close()
      }

      const { mnemonic } = (await server.inject({ method: 'POST', url: '/identity/create', payload: {} })).json()
      const status = identity.status()
      const child = await new CreateAdfTool().execute({ name: 'agent-3' }, parent)
      expect(child.isError).toBe(false)
      expectSealedOwnedIdentity(join(agentsDir, 'agent-3.adf'), mnemonic, status.ownerDid!, status.runtimeDid!)
    } finally {
      parent.close()
    }
  }, 60_000)
})

describe('Studio ↔ daemon on one machine (shared keychain entry)', () => {
  it('Studio identity is ready in the daemon with zero steps; agents open both ways; Studio runtime key untouched', async () => {
    const keychain = fakeKeychain()
    const studio = new SettingsService()
    const studioId = studio.getOwnerIdentity()
    studioId.setSharedMnemonicStore(keychain.shared)
    const { ownerDid, runtimeDid: studioRuntimeDid } = studioId.ensureIdentity()
    const phrase = studioId.revealMnemonic()!
    expect(keychain.shared.read()).toBe(phrase) // mirrored on create

    const daemon = makeDaemon({ backend: keychain.backend })
    const status = daemon.identity.status()
    expect(status).toMatchObject({ status: 'ready', ownerDid })
    expect(status.runtimeDid).not.toBe(studioRuntimeDid)

    // Daemon-made agent opens in Studio (owner slot → Studio re-wraps its runtime slot).
    const made = (await daemon.server.inject({ method: 'POST', url: '/agents/create', payload: { name: 'agent-1', directory: agentsDir } })).json()
    const ws = AdfWorkspace.open(made.filePath)
    try {
      studioId.unlockWorkspaceEnvelopes(ws)
      expect(ws.getEnvelopeState('identity')).toBe('unlocked')
    } finally {
      ws.close()
    }

    // Studio-made agent opens in the daemon.
    const studioFile = join(agentsDir, 'agent-2.adf')
    const sws = AdfWorkspace.create(studioFile, { name: 'agent-2' })
    studioId.ensureWorkspaceIdentity(sws)
    sws.close()
    const dws = AdfWorkspace.open(studioFile)
    try {
      daemon.identity.service.unlockWorkspaceEnvelopes(dws)
      expect(dws.getEnvelopeState('identity')).toBe('unlocked')
    } finally {
      dws.close()
    }

    const disk = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
    expect(disk.runtimeDid).toBe(studioRuntimeDid)
  }, 60_000)

  it('Studio imports the phrase from the keychain when it has the owner DID but cannot read its own copy', () => {
    const keychain = fakeKeychain()
    const phrase = generateMnemonic()
    const owner = deriveOwnerIdentity(phrase)
    keychain.shared.write(phrase)

    // Settings written by a daemon-created identity: owner DID, no Studio secret.
    const seed = new FileSettingsStore(settingsPath)
    seed.set('ownerDid', owner.did)
    seed.set('ownerSeedBackupConfirmed', true)

    const studio = new SettingsService()
    const svc = studio.getOwnerIdentity()
    svc.setSharedMnemonicStore(keychain.shared)
    const result = svc.ensureIdentity()
    expect(result.ownerDid).toBe(owner.did)
    expect(result.migrated).toBe(false)
    expect(svc.revealMnemonic()).toBe(phrase)
    expect(svc.getStatus().legacyOwnerDids).toEqual([])
    expect(result.runtimeDid).toMatch(/^did:key:z/)
    expect(svc.getStatus().runtimeDelegationValid).toBe(true)
  })

  it('passphrase-file identity from the daemon: Studio never mints over it and restores it with the same words', async () => {
    const file = () => new FileSecretBackend(join(h.userDataDir, 'owner-secrets.json'))
    const { server, settings } = makeDaemon({ backend: file() })
    const created = await server.inject({ method: 'POST', url: '/identity/create', payload: { passphrase: 'a long passphrase' } })
    const { mnemonic } = created.json() as { mnemonic: string }
    const ownerDid = deriveOwnerIdentity(mnemonic).did
    expect(settings.get('ownerDidSeedDerived')).toBe(true)

    // An agent on this machine stamped with that owner (a restamp would rewrite it).
    settings.set('trackedDirectories', [agentsDir])
    const agentPath = join(agentsDir, 'agent-1.adf')
    const ws = AdfWorkspace.create(agentPath, { name: 'agent-1' })
    ws.setMeta('adf_owner_did', ownerDid, 'readonly')
    ws.close()

    // Studio on the same machine: no keychain entry, so it cannot read the phrase.
    const studio = new SettingsService().getOwnerIdentity()
    const result = studio.ensureIdentity()
    expect(result).toMatchObject({ ownerDid, migrated: false })
    const status = studio.getStatus()
    expect(status).toMatchObject({ ownerDid, hasMnemonic: false, mnemonicLocked: false, restoreRequired: true, legacyOwnerDids: [] })
    expect(studio.revealMnemonic()).toBeNull()
    const again = AdfWorkspace.open(agentPath)
    expect(again.getMeta('adf_owner_did')).toBe(ownerDid)
    again.close()

    // Restore: a phrase of another owner is refused, the right one is taken.
    expect(() => studio.importMnemonic(generateMnemonic(), { expectedOwnerDid: ownerDid })).toThrow(/not this machine's owner/)
    expect(studio.getStatus().ownerDid).toBe(ownerDid)
    studio.importMnemonic(mnemonic.toUpperCase(), { expectedOwnerDid: ownerDid })
    expect(studio.getStatus()).toMatchObject({ ownerDid, hasMnemonic: true, restoreRequired: false, legacyOwnerDids: [] })
    expect(studio.getStatus().runtimeDelegationValid).toBe(true)
  })

  it('pre-flag seed-derived owners are recognised; a true legacy label-only DID still migrates', () => {
    const phrase = generateMnemonic()
    const owner = deriveOwnerIdentity(phrase)
    const seed = new FileSettingsStore(settingsPath)
    // Written by a daemon from before the flag: its delegation proves a seed.
    seed.set('ownerDid', owner.did)
    seed.set('daemonRuntimeDelegation', { issuer: owner.did, subject: 'did:key:zDaemonRuntime', role: 'runtime', issued_at: new Date().toISOString(), signature: 'x' })
    const studio = new SettingsService().getOwnerIdentity()
    expect(studio.ensureIdentity()).toMatchObject({ ownerDid: owner.did, migrated: false })
    expect(studio.getStatus().restoreRequired).toBe(true)

    rmSync(settingsPath, { force: true })
    new FileSettingsStore(settingsPath).set('ownerDid', 'did:key:zLegacyOwner111')
    const legacy = new SettingsService().getOwnerIdentity()
    const migrated = legacy.ensureIdentity()
    expect(migrated.migrated).toBe(true)
    expect(migrated.ownerDid).not.toBe('did:key:zLegacyOwner111')
    expect(legacy.getStatus()).toMatchObject({ hasMnemonic: true, restoreRequired: false, legacyOwnerDids: ['did:key:zLegacyOwner111'] })
    expect(JSON.parse(readFileSync(settingsPath, 'utf-8')).ownerDidSeedDerived).toBe(true)
  })

  it('Studio does not import a keychain phrase for a different owner', () => {
    const keychain = fakeKeychain()
    keychain.shared.write(generateMnemonic())
    const svc = new SettingsService().getOwnerIdentity()
    svc.setSharedMnemonicStore(keychain.shared)
    const phrase = generateMnemonic()
    svc.importMnemonic(phrase)
    // Own copy readable: mirrored over the stale entry, not replaced by it.
    svc.ensureIdentity()
    expect(svc.revealMnemonic()).toBe(phrase)
    expect(keychain.shared.read()).toBe(phrase)
  })
})

describe('identity ready → loaded agents unlock without reload', () => {
  it('an agent loaded before restore is degraded, then unlocks and clears degraded once the identity is ready', async () => {
    // Studio made the agent (owner + Studio runtime slots); the daemon has neither key yet.
    const studioPhrase = generateMnemonic()
    const studioId = new SettingsService().getOwnerIdentity()
    studioId.importMnemonic(studioPhrase)
    studioId.ensureIdentity()
    const file = join(agentsDir, 'agent-1.adf')
    const sws = AdfWorkspace.create(file, { name: 'agent-1' })
    studioId.ensureWorkspaceIdentity(sws)
    sws.close()

    const { server, identity, runtime } = makeDaemon()
    // Same wiring as src/main/daemon/index.ts.
    identity.onReady(() => { void runtime.refreshAgentCredentials('owner identity ready') })
    expect(identity.status().status).toBe('restore-needed')

    const ref = await runtime.loadAgent(file, { enforceReviewGate: false })
    const before = (await server.inject({ method: 'GET', url: `/agents/${ref.id}/status` })).json()
    expect(before.degraded).toMatch(/identity: foreign/)
    expect(before.degraded).toContain('adf identity restore')
    expect(before.degraded).not.toMatch(/Start Studio/)

    const restored = await server.inject({ method: 'POST', url: '/identity/restore', payload: { mnemonic: studioPhrase } })
    expect(restored.json().identity.status).toBe('ready')

    await vi.waitFor(() => {
      expect(runtime.getAgentStatus(ref.id)?.degraded).toBeUndefined()
    })
    const after = (await server.inject({ method: 'GET', url: `/agents/${ref.id}/status` })).json()
    expect(after.degraded).toBeUndefined()
    const log = runtime.getAgentLogs(ref.id, { event: 'credentials_unlocked' })[0]
    expect(log?.message).toContain('owner identity ready')
    expect(runtime.hasDegradedAgents()).toBe(false)
  }, 60_000)
})

describe('Studio sweep seals + attests plain-key children', () => {
  it('a reviewed child with a plain key gets envelopes, a sealed key, owner stamps and attestations', () => {
    const svc = new SettingsService().getOwnerIdentity()
    svc.ensureIdentity()
    const phrase = svc.revealMnemonic()!
    const file = join(agentsDir, 'agent-1.adf')
    const ws = AdfWorkspace.create(file, { name: 'agent-1' })
    ws.generateIdentityKeys(null) // what an older headless daemon wrote
    const didBefore = ws.getDid()
    ws.close()

    const reopened = AdfWorkspace.open(file)
    try {
      svc.ensureWorkspaceIdentity(reopened)
      expect(reopened.getDid()).toBe(didBefore)
    } finally {
      reopened.close()
    }
    expectSealedOwnedIdentity(file, phrase, svc.getOwnerDid(), svc.getRuntimeDid())
  })
})
