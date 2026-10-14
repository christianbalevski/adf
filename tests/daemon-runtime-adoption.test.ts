/**
 * Runtime adoption (design daemon-backend.md §5.3, D10): in local mode the
 * daemon uses Studio's runtime identity from the `studio-runtime:<scope>`
 * keychain entry, verified against the owner on record. Every keychain here is
 * in memory or a temp file; ADF_KEYCHAIN=0 keeps the real one out of reach.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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
import { DaemonIdentity, TestKeychainFileBackend, testSeamsAllowed } from '../src/main/daemon/daemon-identity'
import { DaemonAgentFactory } from '../src/main/daemon/daemon-agent-factory'
import { createDaemonHttpApi } from '../src/main/daemon/http-api'
import { STUDIO_RUNTIME_ACCOUNT_PREFIX, serializeStudioRuntimeEntry, studioRuntimeAccount } from '../src/main/daemon/studio-runtime-entry'
import { RuntimeService } from '../src/main/runtime/runtime-service'
import { MockLLMProvider } from '../src/main/runtime/headless'
import { setWorkspaceIdentityHooks } from '../src/main/runtime/identity-provisioner'
import { AdfWorkspace } from '../src/main/adf/adf-workspace'
import { SettingsService } from '../src/main/services/settings.service'
import { OwnerIdentityService } from '../src/main/services/owner-identity.service'
import { FileSecretBackend, OWNER_MNEMONIC_ACCOUNT, type SecretBackend, type SharedMnemonicStore } from '../src/main/services/owner-secret-store'
import { settingsScope } from '../src/main/services/provider-key-store'
import { DaemonAppOAuthStore, daemonAppOAuthAccount } from '../src/main/services/mcp-oauth-store'
import { createAttestation, readAdfAttestations } from '../src/main/services/attestation.service'
import { deriveReviewIdentity } from '../src/main/services/agent-review'
import { deriveOwnerIdentity, generateMnemonic } from '../src/main/crypto/mnemonic-identity'
import { generateEd25519KeyPair } from '../src/main/crypto/identity-crypto'
import { generateX25519KeyPair } from '../src/main/crypto/envelope-crypto'
import { MeshServer, findAvailablePort } from '../src/main/services/mesh-server'
import { fakeKeychain, studioRuntimeEntryFrom, writeStudioRuntimeEntry } from './helpers/studio-runtime-entry'

let root: string
let settingsPath: string
let agentsDir: string
const servers: Array<{ close: () => Promise<unknown> }> = []
const runtimes: RuntimeService[] = []
const savedKeychainEnv = process.env.ADF_KEYCHAIN

beforeAll(() => {
  // Any code path that would open the real OS keychain gets "no keychain" instead.
  process.env.ADF_KEYCHAIN = '0'
})
afterAll(() => {
  if (savedKeychainEnv === undefined) delete process.env.ADF_KEYCHAIN
  else process.env.ADF_KEYCHAIN = savedKeychainEnv
})

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'adf-runtime-adoption-'))
  h.userDataDir = join(root, 'userData')
  mkdirSync(h.userDataDir, { recursive: true })
  process.env.ADF_USER_DATA_DIR = h.userDataDir
  settingsPath = join(h.userDataDir, 'adf-settings.json')
  agentsDir = join(root, 'agents')
  mkdirSync(agentsDir, { recursive: true })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(servers.splice(0).map((s) => s.close()))
  for (const runtime of runtimes.splice(0)) {
    for (const agent of runtime.listAgents()) await runtime.unloadAgent(agent.id, { mode: 'immediate' })
  }
  delete process.env.ADF_USER_DATA_DIR
  rmSync(root, { recursive: true, force: true })
})

function makeDaemon(backend: SecretBackend) {
  const settings = new FileSettingsStore(settingsPath)
  const encKey = ensureDaemonEncKey(h.userDataDir)
  const identity = new DaemonIdentity({ settings, settingsPath, encKey, backend })
  setWorkspaceIdentityHooks(identity.workspaceHooks())
  const runtime = new RuntimeService({ settings, providerFactory: () => new MockLLMProvider() })
  runtimes.push(runtime)
  const agentFactory = new DaemonAgentFactory({ settings, identity, runtime })
  const server = createDaemonHttpApi(runtime, { settingsStore: settings, identity, agentFactory })
  servers.push(server)
  return { settings, encKey, identity, runtime, agentFactory, server }
}

/** Embedded Studio on this machine, mirroring its phrase into `keychain` when given. */
function makeStudio(keychain?: { shared: SharedMnemonicStore }) {
  const studio = new SettingsService()
  const svc = studio.getOwnerIdentity()
  if (keychain) svc.setSharedMnemonicStore(keychain.shared)
  svc.ensureIdentity()
  return { studio, svc, phrase: svc.revealMnemonic()!, ownerDid: svc.getOwnerDid(), runtimeDid: svc.getRuntimeDid() }
}

/** Studio's identity service with the owner phrase out of reach (no owner-key unlock possible). */
function studioWithoutOwnerKey(studio: SettingsService): OwnerIdentityService {
  return new OwnerIdentityService({
    get: (k) => studio.get(k),
    set: (k, v) => studio.set(k, v),
    getSecret: (k) => (k === 'ownerMnemonic' ? null : studio.getSecret(k)),
    setSecret: (k, v) => studio.setSecret(k, v),
    secretStatus: (k) => (k === 'ownerMnemonic' ? 'absent' : studio.secretStatus(k)),
    isSafeStorageAvailable: () => studio.isSafeStorageAvailable(),
  })
}

/** A Studio-made agent file (owner + Studio runtime slots, Studio stamps). */
function studioAgent(svc: OwnerIdentityService, filePath: string): void {
  const ws = AdfWorkspace.create(filePath, { name: 'agent-1' })
  svc.ensureWorkspaceIdentity(ws)
  ws.close()
}

function reviewScenario(ws: AdfWorkspace, svc: OwnerIdentityService) {
  // Same inputs as Studio (ipc FILE_CHECK_REVIEW) and DaemonAgentFactory.reviewSummary.
  const owner = readAdfAttestations(ws).find((a) => a.role === 'owner')
  return deriveReviewIdentity({
    agentDid: ws.getDid(),
    fileOwnerDid: owner?.issuer ?? ws.getMeta('adf_owner_did') ?? null,
    fileRuntimeDid: ws.getMeta('adf_runtime_did') ?? null,
    localOwnerDid: svc.getOwnerDid(),
    localRuntimeDid: svc.getRuntimeDid(),
    identityEnvelope: ws.getEnvelopeState('identity'),
    credentialsEnvelope: ws.getEnvelopeState('credentials'),
    sharePasswordSet: false,
    filePasswordProtected: ws.isPasswordProtected(),
    ownerKeyAvailable: svc.getOwnerEncPrivateKey() !== null,
  }).scenario
}

function diskSettings(): Record<string, unknown> {
  return JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
}

describe('valid adoption', () => {
  it('uses Studio runtime DID, delegation and keys; writes nothing of Studio runtime; mints nothing', () => {
    const keychain = fakeKeychain()
    const s = makeStudio(keychain)
    writeStudioRuntimeEntry(keychain.backend, settingsPath, s.studio)
    const before = diskSettings()

    const { identity } = makeDaemon(keychain.backend)
    const status = identity.status()
    expect(status).toMatchObject({ status: 'ready', ownerDid: s.ownerDid, runtimeDid: s.runtimeDid })
    expect(status.runtime).toMatchObject({ state: 'adopted', source: 'studio', reason: null })
    expect(identity.service.getRuntimeDid()).toBe(s.runtimeDid)
    expect(identity.service.getRuntimeEncPublicKey()?.toString('base64')).toBe(s.studio.get('runtimeEncPublicKey'))
    expect(identity.service.getStatus().runtimeDelegationValid).toBe(true)
    // ensureRuntimeKey keeps Studio's key: no mint, no re-sign.
    expect(identity.service.ensureRuntimeKey()).toBe(s.runtimeDid)

    const after = diskSettings()
    for (const key of ['runtimeDid', 'runtimeDelegation', 'runtimeEncPublicKey', 'legacyRuntimeDids']) {
      expect(after[key]).toEqual(before[key])
    }
    expect(after.daemonRuntimeDid).toBeUndefined()
    expect(after.daemonRuntimeDelegation).toBeUndefined()
    expect([...keychain.store.keys()].some((k) => k.includes('daemon-runtime-signing-key'))).toBe(false)
  })

  it('a Studio-made file reviews as "mine" in the adopted daemon and unlocks through Studio\'s runtime slot', async () => {
    const keychain = fakeKeychain()
    const s = makeStudio(keychain)
    writeStudioRuntimeEntry(keychain.backend, settingsPath, s.studio)
    const file = join(agentsDir, 'agent-1.adf')
    studioAgent(s.svc, file)

    const { identity } = makeDaemon(keychain.backend)
    const ws = AdfWorkspace.open(file)
    try {
      identity.unlockWorkspaceEnvelopes(ws)
      expect(ws.getEnvelopeState('identity')).toBe('unlocked')
      expect(ws.getEnvelopeState('credentials')).toBe('unlocked')
      expect(reviewScenario(ws, identity.service)).toBe('mine')
    } finally {
      ws.close()
    }
  })

  it('control: the same file is only "recognized" by a daemon on its own runtime', () => {
    const keychain = fakeKeychain()
    const s = makeStudio(keychain)
    const file = join(agentsDir, 'agent-1.adf')
    studioAgent(s.svc, file)
    const { identity } = makeDaemon(keychain.backend) // no Studio entry
    expect(identity.status().runtime.state).toBe('absent')
    const ws = AdfWorkspace.open(file)
    try {
      identity.unlockWorkspaceEnvelopes(ws)
      expect(reviewScenario(ws, identity.service)).toBe('recognized')
    } finally {
      ws.close()
    }
  })

  it('unlocks a Studio file without the owner phrase (adoption needs only the owner DID on record)', () => {
    const keychain = fakeKeychain()
    const s = makeStudio() // phrase NOT mirrored: the daemon cannot use the owner key
    writeStudioRuntimeEntry(keychain.backend, settingsPath, s.studio)
    const file = join(agentsDir, 'agent-1.adf')
    studioAgent(s.svc, file)

    const { identity } = makeDaemon(keychain.backend)
    const status = identity.status()
    expect(status.status).toBe('restore-needed')
    expect(status.runtime.state).toBe('adopted')
    expect(identity.service.getOwnerEncPrivateKey()).toBeNull()
    const ws = AdfWorkspace.open(file)
    try {
      identity.workspaceHooks().ensureIdentity(ws)
      expect(ws.getEnvelopeState('identity')).toBe('unlocked')
      expect(ws.getEnvelopeState('credentials')).toBe('unlocked')
    } finally {
      ws.close()
    }
  })

  it('a file made by the adopted daemon opens unlocked in embedded Studio without the owner key, and is "mine" there', async () => {
    const keychain = fakeKeychain()
    const s = makeStudio(keychain)
    writeStudioRuntimeEntry(keychain.backend, settingsPath, s.studio)
    const { server } = makeDaemon(keychain.backend)

    const made = await server.inject({ method: 'POST', url: '/agents/create', payload: { name: 'agent-1', directory: agentsDir } })
    expect(made.statusCode).toBe(201)
    const filePath = made.json().filePath as string
    await Promise.all(runtimes.flatMap((r) => r.listAgents().map((a) => r.unloadAgent(a.id, { mode: 'immediate' }))))

    const studioNoOwner = studioWithoutOwnerKey(s.studio)
    expect(studioNoOwner.getOwnerEncPrivateKey()).toBeNull()
    const ws = AdfWorkspace.open(filePath)
    try {
      expect(ws.getMeta('adf_runtime_did')).toBe(s.runtimeDid)
      const operator = readAdfAttestations(ws).find((a) => a.role === 'operator')
      expect(operator?.issuer).toBe(s.runtimeDid)
      studioNoOwner.unlockWorkspaceEnvelopes(ws)
      expect(ws.getEnvelopeState('identity')).toBe('unlocked')
      expect(ws.getEnvelopeState('credentials')).toBe('unlocked')
      expect(reviewScenario(ws, s.svc)).toBe('mine')
    } finally {
      ws.close()
    }
  }, 60_000)

  it('cascade step 2: a file the daemon made before adoption still unlocks with the daemon key, without the owner key', async () => {
    const keychain = fakeKeychain()
    const s = makeStudio(keychain)
    const first = makeDaemon(keychain.backend) // own runtime: no entry yet
    const made = (await first.server.inject({ method: 'POST', url: '/agents/create', payload: { name: 'agent-1', directory: agentsDir } })).json()
    await Promise.all(runtimes.flatMap((r) => r.listAgents().map((a) => r.unloadAgent(a.id, { mode: 'immediate' }))))
    const daemonDid = first.identity.status().runtimeDid
    expect(daemonDid).not.toBe(s.runtimeDid)

    // Studio writes its entry; the owner phrase leaves the keychain.
    writeStudioRuntimeEntry(keychain.backend, settingsPath, s.studio)
    keychain.backend.delete(OWNER_MNEMONIC_ACCOUNT)
    const second = makeDaemon(keychain.backend)
    expect(second.identity.status().runtime).toMatchObject({ state: 'adopted', daemonRuntimeDid: daemonDid })
    expect(second.identity.service.getOwnerEncPrivateKey()).toBeNull()
    const ws = AdfWorkspace.open(made.filePath)
    try {
      second.identity.unlockWorkspaceEnvelopes(ws)
      expect(ws.getEnvelopeState('identity')).toBe('unlocked')
    } finally {
      ws.close()
    }
  }, 60_000)
})

describe('rejected entries keep the daemon runtime and say why', () => {
  function setup() {
    const keychain = fakeKeychain()
    const s = makeStudio(keychain)
    return { keychain, s }
  }

  const cases: Array<{ name: string; reason: string; forge: (ctx: ReturnType<typeof setup>) => void }> = [
    {
      name: 'forged delegation (issued by another owner)',
      reason: 'owner_mismatch',
      forge: ({ keychain, s }) => {
        const other = deriveOwnerIdentity(generateMnemonic())
        const forged = createAttestation({ issuer: other.did, subject: s.runtimeDid, role: 'runtime', issued_at: new Date().toISOString() }, other.privateKeyPkcs8)
        writeStudioRuntimeEntry(keychain.backend, settingsPath, s.studio, { runtimeDelegation: forged })
      },
    },
    {
      name: 'delegation signature that does not verify',
      reason: 'bad_delegation',
      forge: ({ keychain, s }) => {
        const real = s.studio.get('runtimeDelegation') as { signature: string }
        writeStudioRuntimeEntry(keychain.backend, settingsPath, s.studio, {
          runtimeDelegation: { ...(s.studio.get('runtimeDelegation') as never), issued_at: '2020-01-01T00:00:00.000Z', signature: real.signature },
        })
      },
    },
    {
      name: 'subject mismatch (owner-signed for another runtime key)',
      reason: 'subject_mismatch',
      forge: ({ keychain, s }) => {
        const owner = deriveOwnerIdentity(s.phrase)
        const stranger = generateEd25519KeyPair()
        // The entry's key is a stranger's; the delegation still certifies Studio's DID.
        writeStudioRuntimeEntry(keychain.backend, settingsPath, s.studio, {
          runtimePrivateKey: stranger.privateKey.toString('base64'),
          runtimeDelegation: createAttestation({ issuer: owner.did, subject: s.runtimeDid, role: 'runtime', issued_at: new Date().toISOString() }, owner.privateKeyPkcs8),
        })
      },
    },
    {
      name: 'enc key mismatch',
      reason: 'enc_key_mismatch',
      forge: ({ keychain, s }) => {
        writeStudioRuntimeEntry(keychain.backend, settingsPath, s.studio, { runtimeEncPrivateKey: generateX25519KeyPair().privateKey.toString('base64') })
      },
    },
    {
      name: 'runtime DID that is not Studio\'s in the settings file',
      reason: 'runtime_did_mismatch',
      forge: ({ keychain, s }) => {
        writeStudioRuntimeEntry(keychain.backend, settingsPath, s.studio)
        new FileSettingsStore(settingsPath).set('runtimeDid', 'did:key:z6MkSomeoneElse')
      },
    },
    {
      name: 'unsupported version',
      reason: 'unsupported_version',
      forge: ({ keychain, s }) => {
        const entry = JSON.parse(serializeStudioRuntimeEntry(studioRuntimeEntryFrom(s.studio)))
        keychain.backend.set(studioRuntimeAccount(settingsScope(settingsPath)), JSON.stringify({ ...entry, v: 2 }))
      },
    },
    {
      name: 'malformed JSON',
      reason: 'malformed',
      forge: ({ keychain }) => keychain.backend.set(studioRuntimeAccount(settingsScope(settingsPath)), '{not json'),
    },
  ]

  for (const c of cases) {
    it(`${c.name} → rejected (${c.reason}) with a log line`, () => {
      const ctx = setup()
      c.forge(ctx)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { identity } = makeDaemon(ctx.keychain.backend)
      const status = identity.status()
      expect(status.runtime).toMatchObject({ state: 'rejected', source: 'daemon', reason: c.reason })
      expect(status.runtimeDid).not.toBe(ctx.s.runtimeDid)
      expect(identity.service.getRuntimeDid()).not.toBe(ctx.s.runtimeDid)
      const lines = warn.mock.calls.map((args) => args.map(String).join(' ')).filter((l) => l.includes('Runtime identity'))
      expect(lines).toHaveLength(1) // logged once, not on every status poll
      expect(lines[0]).toContain("ADF Studio's runtime entry in the OS keychain was not used")
    })
  }
})

describe('keychain-less fallback', () => {
  it('file storage: daemon runtime, trusted-daemon key in the status, a sentence for the UI', async () => {
    const backend = new FileSecretBackend(join(h.userDataDir, 'owner-secrets.json'))
    const { identity, server, encKey } = makeDaemon(backend)
    await server.inject({ method: 'POST', url: '/identity/create', payload: { passphrase: 'a long passphrase' } })
    const status = (await server.inject({ method: 'GET', url: '/identity' })).json()
    expect(status.runtime).toMatchObject({ state: 'unavailable', source: 'daemon', reason: null, daemonEncPublicKey: encKey.publicKeyB64 })
    expect(status.runtime.message).toContain('no usable OS keychain')
    expect(status.runtime.message).toContain(encKey.publicKeyB64)
    expect(status.runtimeDid).toBe(diskSettings().daemonRuntimeDid)
    expect(identity.service.getRuntimeEncPublicKey()?.toString('base64')).toBe(encKey.publicKeyB64)
  })

  it('ADF_KEYCHAIN=0: no keychain at all, even with a test keychain file configured', () => {
    const saved = { seams: process.env.ADF_TEST_SEAMS, file: process.env.ADF_TEST_KEYCHAIN_FILE }
    process.env.ADF_TEST_SEAMS = '1'
    process.env.ADF_TEST_KEYCHAIN_FILE = join(root, 'keychain.json')
    try {
      const settings = new FileSettingsStore(settingsPath)
      const identity = new DaemonIdentity({ settings, settingsPath, encKey: ensureDaemonEncKey(h.userDataDir) })
      expect(identity.storage).toBe('file')
      expect(identity.status().runtime.state).toBe('unavailable')
      expect(existsSync(join(root, 'keychain.json'))).toBe(false)
    } finally {
      for (const [k, v] of [['ADF_TEST_SEAMS', saved.seams], ['ADF_TEST_KEYCHAIN_FILE', saved.file]] as const) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })
})

describe('test keychain seam', () => {
  it('honoured only with ADF_TEST_SEAMS=1 outside packaged builds', () => {
    expect(testSeamsAllowed({}, '/repo/src/main/daemon/daemon-identity.ts')).toBe(false)
    expect(testSeamsAllowed({ ADF_TEST_SEAMS: '1' }, '/repo/src/main/daemon/daemon-identity.ts')).toBe(true)
    expect(testSeamsAllowed({ ADF_TEST_SEAMS: '1' }, 'C:\\Program Files\\ADF Studio\\resources\\app.asar\\out\\main\\daemon.js')).toBe(false)
    expect(testSeamsAllowed({ ADF_TEST_SEAMS: '1' }, '/usr/lib/node_modules/adf-cli/dist/daemon.js')).toBe(false)
    expect(testSeamsAllowed({ ADF_TEST_SEAMS: '1' }, null)).toBe(false)
  })

  it('a spawned test daemon can adopt from a keychain file (ADF_TEST_SEAMS=1 + ADF_TEST_KEYCHAIN_FILE)', () => {
    const fileKeychain = new TestKeychainFileBackend(join(root, 'keychain.json'))
    const s = makeStudio({ shared: { read: () => fileKeychain.get(OWNER_MNEMONIC_ACCOUNT), write: (m) => fileKeychain.set(OWNER_MNEMONIC_ACCOUNT, m) } })
    writeStudioRuntimeEntry(fileKeychain, settingsPath, s.studio)
    const saved = { keychain: process.env.ADF_KEYCHAIN, seams: process.env.ADF_TEST_SEAMS, file: process.env.ADF_TEST_KEYCHAIN_FILE }
    delete process.env.ADF_KEYCHAIN
    process.env.ADF_TEST_SEAMS = '1'
    process.env.ADF_TEST_KEYCHAIN_FILE = fileKeychain.filePath
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const identity = new DaemonIdentity({ settings: new FileSettingsStore(settingsPath), settingsPath, encKey: ensureDaemonEncKey(h.userDataDir) })
      expect(identity.storage).toBe('keychain')
      expect(identity.status()).toMatchObject({ status: 'ready', runtimeDid: s.runtimeDid, runtime: { state: 'adopted' } })
      expect(warn.mock.calls.some((args) => String(args[0]).includes('Test seam'))).toBe(true)

      // Seams off: the file is ignored and the real keychain is NOT used (file storage instead).
      delete process.env.ADF_TEST_SEAMS
      const refused = new DaemonIdentity({ settings: new FileSettingsStore(settingsPath), settingsPath, encKey: ensureDaemonEncKey(h.userDataDir) })
      expect(refused.storage).toBe('file')
    } finally {
      for (const [k, v] of [['ADF_KEYCHAIN', saved.keychain], ['ADF_TEST_SEAMS', saved.seams], ['ADF_TEST_KEYCHAIN_FILE', saved.file]] as const) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })
})

describe('mesh /ping advertises the runtime the daemon signs with', () => {
  async function ping(identity: DaemonIdentity, settings: FileSettingsStore) {
    const port = await findAvailablePort(41000 + Math.floor(Math.random() * 8000), '127.0.0.1')
    settings.set('meshPort', port)
    settings.set('shareOwnerIdentity', true)
    const mesh = new MeshServer({} as never, identity.presentedSettings(settings))
    await mesh.start()
    try {
      return await (await fetch(`http://127.0.0.1:${mesh.getPort()}/ping`)).json() as Record<string, unknown>
    } finally {
      await mesh.stop()
    }
  }

  it('daemon runtime when not adopted, although the shared file holds Studio\'s runtimeDid', async () => {
    const keychain = fakeKeychain()
    const s = makeStudio(keychain)
    const { identity, settings } = makeDaemon(keychain.backend)
    const own = identity.status().runtimeDid
    expect(settings.get('runtimeDid')).toBe(s.runtimeDid)
    const body = await ping(identity, settings)
    expect(body.runtime_did).toBe(own)
    expect((body.owner_delegation as { subject: string }).subject).toBe(own)
  }, 30_000)

  it('Studio runtime when adopted', async () => {
    const keychain = fakeKeychain()
    const s = makeStudio(keychain)
    writeStudioRuntimeEntry(keychain.backend, settingsPath, s.studio)
    const { identity, settings } = makeDaemon(keychain.backend)
    const body = await ping(identity, settings)
    expect(body.runtime_did).toBe(s.runtimeDid)
    expect((body.owner_delegation as { subject: string }).subject).toBe(s.runtimeDid)
  }, 30_000)
})

describe('key material never leaves the daemon', () => {
  it('no Studio runtime key bytes in logs, HTTP responses or error messages', async () => {
    const keychain = fakeKeychain()
    const s = makeStudio(keychain)
    const entry = studioRuntimeEntryFrom(s.studio)
    const secrets = new Set<string>()
    for (const b64 of [entry.runtimePrivateKey, entry.runtimeEncPrivateKey]) {
      const der = Buffer.from(b64, 'base64')
      const raw = der.subarray(der.length - 32) // the 32-byte private scalar/seed
      for (const form of [b64, der.toString('hex'), raw.toString('base64'), raw.toString('hex'), raw.toString('base64url')]) secrets.add(form)
    }

    const captured: string[] = []
    for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        captured.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
      })
    }

    // Rejected entries first (every reject path logs), then a valid one.
    const forged = deriveOwnerIdentity(generateMnemonic())
    writeStudioRuntimeEntry(keychain.backend, settingsPath, s.studio, {
      runtimeDelegation: createAttestation({ issuer: forged.did, subject: s.runtimeDid, role: 'runtime', issued_at: new Date().toISOString() }, forged.privateKeyPkcs8),
    })
    makeDaemon(keychain.backend).identity.status()
    writeStudioRuntimeEntry(keychain.backend, settingsPath, s.studio, { runtimeEncPrivateKey: generateX25519KeyPair().privateKey.toString('base64') })
    makeDaemon(keychain.backend).identity.status()

    writeStudioRuntimeEntry(keychain.backend, settingsPath, s.studio)
    const { server, identity } = makeDaemon(keychain.backend)
    const bodies: string[] = []
    for (const url of ['/identity', '/settings', '/settings/runtimePrivateKey', '/settings/runtimeEncPrivateKey', '/runtime/settings', '/runtime', '/version']) {
      bodies.push((await server.inject({ method: 'GET', url })).body)
    }
    bodies.push((await server.inject({ method: 'POST', url: '/agents/create', payload: { name: 'agent-1', directory: agentsDir } })).body)
    bodies.push((await server.inject({ method: 'POST', url: '/identity/import', payload: { mnemonic: generateMnemonic() } })).body)
    bodies.push((await server.inject({ method: 'POST', url: '/identity/import', payload: { mnemonic: 'not a phrase' } })).body)
    bodies.push(JSON.stringify(identity.status()))
    try {
      identity.service.getRuntimeSigningKey() // reachable in-process only
      ;(identity as unknown as { identitySettings: { setSecret(k: string, v: string): void } }).identitySettings.setSecret('runtimePrivateKey', entry.runtimePrivateKey)
    } catch (err) {
      bodies.push(err instanceof Error ? err.message : String(err))
    }

    expect(bodies.length).toBeGreaterThan(9)
    const haystack = [...captured, ...bodies].join('\n')
    expect(captured.length).toBeGreaterThan(0)
    for (const secret of secrets) expect(haystack).not.toContain(secret)
    // The account is named in no response (it is not secret, but nothing needs it).
    expect(bodies.join('\n')).not.toContain(STUDIO_RUNTIME_ACCOUNT_PREFIX)
  }, 60_000)
})

describe('POST /identity/import', () => {
  it('another owner: 409 switch_unconfirmed naming both DIDs, then switches with switchOwner and reloads loaded agents', async () => {
    const keychain = fakeKeychain()
    const s = makeStudio(keychain)
    writeStudioRuntimeEntry(keychain.backend, settingsPath, s.studio)
    const { server, runtime, settings } = makeDaemon(keychain.backend)
    settings.set('trackedDirectories', [agentsDir])
    const made = (await server.inject({ method: 'POST', url: '/agents/create', payload: { name: 'agent-1', directory: agentsDir, start: true } })).json()
    expect(runtime.listAgents().map((a) => a.filePath)).toContain(made.filePath)

    const next = generateMnemonic()
    const nextOwner = deriveOwnerIdentity(next).did
    const remote = await server.inject({ method: 'POST', url: '/identity/import', payload: { mnemonic: next }, remoteAddress: '10.1.2.3' })
    expect(remote.statusCode).toBe(403)

    const unconfirmed = await server.inject({ method: 'POST', url: '/identity/import', payload: { mnemonic: next } })
    expect(unconfirmed.statusCode).toBe(409)
    expect(unconfirmed.json().code).toBe('switch_unconfirmed')
    expect(unconfirmed.json().error).toContain(nextOwner)
    expect(unconfirmed.json().error).toContain(s.ownerDid)
    expect(unconfirmed.body).not.toContain(next)
    expect(settings.get('ownerDid')).toBe(s.ownerDid)
    expect(runtime.listAgents()).toHaveLength(1) // nothing unloaded for a refused import

    const log = vi.spyOn(console, 'log')
    const res = await server.inject({ method: 'POST', url: '/identity/import', payload: { mnemonic: next, switchOwner: true } })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(res.body).not.toContain(next)
    expect(body).toMatchObject({ ownerDid: nextOwner, previousOwnerDid: s.ownerDid, switched: true, reloadFailures: [] })
    expect(body.identity).toMatchObject({ status: 'ready', ownerDid: nextOwner })
    // Studio's entry is certified by the previous owner: no longer adopted, and the UI is told why.
    expect(body.identity.runtime).toMatchObject({ state: 'rejected', reason: 'owner_mismatch', source: 'daemon' })
    expect(body.restamp.restamped).toBe(1)
    expect(body.reloaded.map((a: { filePath: string }) => a.filePath)).toEqual([made.filePath])
    expect(runtime.listAgents().map((a) => a.filePath)).toEqual([made.filePath])
    expect(log.mock.calls.some((a) => String(a[0]).includes('Owner import: unloading agent-1'))).toBe(true)

    const disk = diskSettings()
    expect(disk.ownerDid).toBe(nextOwner)
    expect(disk.legacyOwnerDids).toEqual([s.ownerDid])
    // Studio's runtime keys in the shared file are untouched.
    expect(disk.runtimeDid).toBe(s.runtimeDid)
    expect(disk.runtimeDelegation).toEqual(s.studio.get('runtimeDelegation'))
    const ws = AdfWorkspace.open(made.filePath)
    try {
      expect(ws.getMeta('adf_owner_did')).toBe(nextOwner)
    } finally {
      ws.close()
    }
  }, 90_000)

  it('the same owner acts as a restore (no switch needed)', async () => {
    const keychain = fakeKeychain()
    const s = makeStudio() // phrase not in the keychain: daemon is restore-needed
    const { server } = makeDaemon(keychain.backend)
    const res = await server.inject({ method: 'POST', url: '/identity/import', payload: { mnemonic: s.phrase.toUpperCase() } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ switched: false, previousOwnerDid: s.ownerDid, identity: { status: 'ready', ownerDid: s.ownerDid } })
  })
})

describe('DaemonAppOAuthStore', () => {
  const url = 'https://mcp.example.test/mcp'

  it('keeps Studio-shaped records in the secret backend under the settings scope', async () => {
    const keychain = fakeKeychain()
    const store = new DaemonAppOAuthStore(keychain.backend, daemonAppOAuthAccount(settingsScope(settingsPath)))
    await store.save(url, { tokens: { access_token: 'at-1', token_type: 'Bearer' }, serverUrl: url, updatedAt: 1 })
    expect(store.listServerUrls()).toEqual([url])
    expect((await store.get(url))?.tokens?.access_token).toBe('at-1')
    await expect(store.get('https://evil.example.test/mcp')).resolves.toBeUndefined()
    const raw = keychain.backend.get(daemonAppOAuthAccount(settingsScope(settingsPath)))
    expect(JSON.parse(raw!)[url].tokens.access_token).toBe('at-1')

    await store.invalidate(url, 'tokens')
    expect((await store.get(url))).toBeUndefined() // nothing else left → record dropped
    expect(keychain.backend.get(daemonAppOAuthAccount(settingsScope(settingsPath)))).toBeNull()
  })

  it('refuses a record pinned to another URL, and never writes while the file store is locked', async () => {
    const keychain = fakeKeychain()
    const account = daemonAppOAuthAccount('scope1')
    keychain.backend.set(account, JSON.stringify({ [url]: { tokens: { access_token: 'x', token_type: 'Bearer' }, serverUrl: 'https://other.example.test/mcp', updatedAt: 1 } }))
    await expect(new DaemonAppOAuthStore(keychain.backend, account).get(url)).rejects.toThrow(/refusing to send credentials/)

    const locked = new FileSecretBackend(join(h.userDataDir, 'owner-secrets.json'))
    const store = new DaemonAppOAuthStore(locked, account)
    expect(store.available()).toBe(false)
    await expect(store.get(url)).resolves.toBeUndefined()
    await expect(store.save(url, { updatedAt: 1, serverUrl: url, tokens: { access_token: 'y', token_type: 'Bearer' } })).rejects.toThrow(/locked/)
    expect(existsSync(join(h.userDataDir, 'owner-secrets.json'))).toBe(false)
  })
})
