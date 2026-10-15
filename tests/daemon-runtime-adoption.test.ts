/**
 * Runtime adoption (design daemon-backend.md §5.3, D10): in local mode the
 * daemon uses Studio's runtime identity from the `studio-runtime:<scope>`
 * keychain entry, verified against the owner on record. Every keychain here is
 * in memory or a temp file; ADF_KEYCHAIN=0 keeps the real one out of reach.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

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
import { DaemonIdentity, TestKeychainFileBackend } from '../src/main/daemon/daemon-identity'
import { testSeamsAllowed } from '../src/main/utils/test-seams'
import { DaemonEventBus } from '../src/main/daemon/event-bus'
import { registerDaemonEventBus } from '../src/main/runtime/emit-umbilical'
import { DaemonAgentFactory } from '../src/main/daemon/daemon-agent-factory'
import { createDaemonHttpApi } from '../src/main/daemon/http-api'
import { STUDIO_RUNTIME_ACCOUNT_PREFIX, canonicalSettingsPath, serializeStudioRuntimeEntry, studioRuntimeAccount, studioRuntimeScope } from '../src/main/daemon/studio-runtime-entry'
import { RuntimeService } from '../src/main/runtime/runtime-service'
import { MockLLMProvider } from '../src/main/runtime/headless'
import { setWorkspaceIdentityHooks } from '../src/main/runtime/identity-provisioner'
import { AdfWorkspace } from '../src/main/adf/adf-workspace'
import { SettingsService } from '../src/main/services/settings.service'
import { OwnerIdentityService } from '../src/main/services/owner-identity.service'
import { FileSecretBackend, OWNER_MNEMONIC_ACCOUNT, type SecretBackend, type SharedMnemonicStore } from '../src/main/services/owner-secret-store'
import { settingsScope } from '../src/main/services/provider-key-store'
import { DaemonAppOAuthStore, SECRET_CHUNK_CHARS, daemonAppOAuthAccount, splitOnCodePoints } from '../src/main/services/mcp-oauth-store'
import { createAttestation, readAdfAttestations, verifyAttestation } from '../src/main/services/attestation.service'
import { deriveReviewIdentity, markConfigReviewed } from '../src/main/services/agent-review'
import { AgentLeaseRegistry } from '../src/main/runtime/agent-lease'
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

/** This run's local proof (POST /identity/import requires it in every mode). */
const PROOF = 'test-local-proof-0123456789abcdefghijklmnopqrstuvwxyz'
const withProof = { 'x-adf-local-proof': PROOF }

function makeDaemon(backend: SecretBackend, opts: { eventBus?: DaemonEventBus } = {}) {
  const settings = new FileSettingsStore(settingsPath)
  const encKey = ensureDaemonEncKey(h.userDataDir)
  const identity = new DaemonIdentity({ settings, settingsPath, encKey, backend })
  setWorkspaceIdentityHooks(identity.workspaceHooks())
  const runtime = new RuntimeService({ settings, providerFactory: () => new MockLLMProvider() })
  runtimes.push(runtime)
  const agentFactory = new DaemonAgentFactory({ settings, identity, runtime })
  const server = createDaemonHttpApi(runtime, { settingsStore: settings, identity, agentFactory, eventBus: opts.eventBus, security: { localProof: PROOF } })
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
        keychain.backend.set(studioRuntimeAccount(studioRuntimeScope(settingsPath)), JSON.stringify({ ...entry, v: 2 }))
      },
    },
    {
      name: 'malformed JSON',
      reason: 'malformed',
      forge: ({ keychain }) => keychain.backend.set(studioRuntimeAccount(studioRuntimeScope(settingsPath)), '{not json'),
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
  it('honoured only with ADF_TEST_SEAMS=1, outside app.asar / node_modules, and not in a packaged Electron', () => {
    const dev = '/repo/src/main/utils/test-seams.ts'
    const unpackaged = () => false
    expect(testSeamsAllowed({ env: {}, modulePath: dev, isPackagedRuntime: unpackaged })).toBe(false)
    expect(testSeamsAllowed({ env: { ADF_TEST_SEAMS: '1' }, modulePath: dev, isPackagedRuntime: unpackaged })).toBe(true)
    expect(testSeamsAllowed({ env: { ADF_TEST_SEAMS: '1' }, modulePath: 'C:\\Program Files\\ADF Studio\\resources\\app.asar\\out\\main\\daemon.js', isPackagedRuntime: unpackaged })).toBe(false)
    expect(testSeamsAllowed({ env: { ADF_TEST_SEAMS: '1' }, modulePath: '/usr/lib/node_modules/adf-cli/dist/daemon.js', isPackagedRuntime: unpackaged })).toBe(false)
    expect(testSeamsAllowed({ env: { ADF_TEST_SEAMS: '1' }, modulePath: null, isPackagedRuntime: unpackaged })).toBe(false)
    for (const deno of ['/home/u/.cache/deno/npm/registry.npmjs.org/adf-cli/0.6.1/dist/daemon.js', 'C:\\Users\\u\\AppData\\Local\\deno\\npm\\registry.npmjs.org\\adf-cli\\0.6.1\\dist\\daemon.js', '/srv/deno/npm/npm.example.test/adf-cli/1.0.0/daemon.js']) {
      expect(testSeamsAllowed({ env: { ADF_TEST_SEAMS: '1' }, modulePath: deno, isPackagedRuntime: unpackaged })).toBe(false)
    }
    expect(testSeamsAllowed({ env: { ADF_TEST_SEAMS: '1' }, modulePath: dev, isPackagedRuntime: () => true })).toBe(false)
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

describe('entry scope and delegation shape', () => {
  it.runIf(process.platform === 'win32')('Windows: one scope for every spelling of the settings path (case, slashes)', () => {
    new FileSettingsStore(settingsPath).set('x', 1) // the file exists, so realpath resolves it
    const scope = studioRuntimeScope(settingsPath)
    expect(studioRuntimeScope(settingsPath.toUpperCase())).toBe(scope)
    expect(studioRuntimeScope(settingsPath.replace(/\\/g, '/'))).toBe(scope)
    expect(canonicalSettingsPath(settingsPath)).toBe(canonicalSettingsPath(settingsPath).toLowerCase())
  })

  it('an entry stored under the uncanonicalized scope is reported as scope_mismatch, naming the canonical path', () => {
    const keychain = fakeKeychain()
    const s = makeStudio(keychain)
    const legacy = studioRuntimeAccount(settingsScope(settingsPath))
    if (legacy === studioRuntimeAccount(studioRuntimeScope(settingsPath))) return // already canonical here (case-sensitive fs)
    keychain.backend.set(legacy, serializeStudioRuntimeEntry(studioRuntimeEntryFrom(s.studio)))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const status = makeDaemon(keychain.backend).identity.status()
    expect(status.runtime).toMatchObject({ state: 'rejected', reason: 'scope_mismatch', source: 'daemon' })
    expect(status.runtime.message).toContain(canonicalSettingsPath(settingsPath))
    expect(status.runtime.message).not.toContain('has not shared')
  })

  it('absent: the message names the account and settings path the daemon looked for', () => {
    const status = makeDaemon(fakeKeychain().backend).identity.status()
    expect(status.runtime.state).toBe('absent')
    expect(status.runtime.message).toContain(studioRuntimeAccount(studioRuntimeScope(settingsPath)))
    expect(status.runtime.message).toContain(canonicalSettingsPath(settingsPath))
  })

  it('only the attestation fields of the delegation are kept', () => {
    const keychain = fakeKeychain()
    const s = makeStudio(keychain)
    const delegation = s.studio.get('runtimeDelegation') as Record<string, unknown>
    writeStudioRuntimeEntry(keychain.backend, settingsPath, s.studio, { runtimeDelegation: { ...delegation, injected: 'x' } as never })
    const adopted = makeDaemon(keychain.backend).identity
    expect(adopted.status().runtime.state).toBe('adopted')
    expect(adopted.presentedRuntime().delegation).toEqual(delegation)
    expect(adopted.presentedRuntime().delegation).not.toHaveProperty('injected')

  })
})

async function ping(identity: DaemonIdentity, settings: FileSettingsStore): Promise<{ body: Record<string, unknown>; text: string }> {
  const port = await findAvailablePort(41000 + Math.floor(Math.random() * 8000), '127.0.0.1')
  settings.set('meshPort', port)
  settings.set('shareOwnerIdentity', true)
  const mesh = new MeshServer({} as never, identity.presentedSettings(settings))
  await mesh.start()
  try {
    const text = await (await fetch(`http://127.0.0.1:${mesh.getPort()}/ping`)).text()
    return { body: JSON.parse(text) as Record<string, unknown>, text }
  } finally {
    await mesh.stop()
  }
}

describe('mesh /ping advertises the runtime the daemon signs with', () => {
  it('daemon runtime when not adopted, although the shared file holds Studio\'s runtimeDid', async () => {
    const keychain = fakeKeychain()
    const s = makeStudio(keychain)
    const { identity, settings } = makeDaemon(keychain.backend)
    const own = identity.status().runtimeDid
    expect(settings.get('runtimeDid')).toBe(s.runtimeDid)
    const { body } = await ping(identity, settings)
    expect(body.runtime_did).toBe(own)
    expect((body.owner_delegation as { subject: string }).subject).toBe(own)
  }, 30_000)

  it('Studio runtime when adopted', async () => {
    const keychain = fakeKeychain()
    const s = makeStudio(keychain)
    writeStudioRuntimeEntry(keychain.backend, settingsPath, s.studio)
    const { identity, settings } = makeDaemon(keychain.backend)
    const { body } = await ping(identity, settings)
    expect(body.runtime_did).toBe(s.runtimeDid)
    expect((body.owner_delegation as { subject: string }).subject).toBe(s.runtimeDid)
  }, 30_000)
})

/** Read the SSE stream from the start for `ms`. */
async function readSse(server: ReturnType<typeof createDaemonHttpApi>, ms: number): Promise<string> {
  await server.listen({ port: 0, host: '127.0.0.1' })
  const port = (server.server.address() as AddressInfo).port
  const abort = new AbortController()
  const res = await fetch(`http://127.0.0.1:${port}/events?since=0`, { signal: abort.signal })
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const deadline = Date.now() + ms
  try {
    while (Date.now() < deadline) {
      const chunk = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), deadline - Date.now()))])
      if (!chunk || chunk.done) break
      text += decoder.decode(chunk.value, { stream: true })
    }
  } finally {
    abort.abort()
  }
  return text
}

describe('key material never leaves the daemon', () => {
  it('no Studio runtime key bytes or owner phrase in logs, HTTP and SSE bodies, /ping, or error messages', async () => {
    const keychain = fakeKeychain()
    const s = makeStudio(keychain)
    const entry = studioRuntimeEntryFrom(s.studio)
    const secrets = new Set<string>([s.phrase, s.phrase.split(' ').slice(0, 3).join(' '), s.phrase.split(' ').slice(-3).join(' ')])
    for (const b64 of [entry.runtimePrivateKey, entry.runtimeEncPrivateKey]) {
      const der = Buffer.from(b64, 'base64')
      const raw = der.subarray(der.length - 32) // the 32-byte private scalar/seed
      for (const buf of [der, raw]) {
        for (const form of [buf.toString('base64'), buf.toString('base64').replace(/=+$/, ''), buf.toString('base64url'), buf.toString('hex')]) secrets.add(form)
      }
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
    const bus = new DaemonEventBus(1000)
    registerDaemonEventBus(bus)
    const { server, identity, settings } = makeDaemon(keychain.backend, { eventBus: bus })
    const bodies: string[] = []
    for (const url of ['/identity', '/settings', '/settings/runtimePrivateKey', '/settings/runtimeEncPrivateKey', '/settings/ownerMnemonic', '/runtime/settings', '/runtime', '/version']) {
      bodies.push((await server.inject({ method: 'GET', url })).body)
    }
    bodies.push((await server.inject({ method: 'POST', url: '/agents/create', payload: { name: 'agent-1', directory: agentsDir, start: true } })).body)
    bodies.push((await server.inject({ method: 'POST', url: '/identity/import', headers: withProof, payload: { mnemonic: generateMnemonic() } })).body)
    bodies.push((await server.inject({ method: 'POST', url: '/identity/import', headers: withProof, payload: { mnemonic: 'not a phrase' } })).body)
    bodies.push((await server.inject({ method: 'POST', url: '/identity/import', headers: withProof, payload: { mnemonic: s.phrase } })).body)
    bodies.push(JSON.stringify(identity.status()))
    try {
      ;(identity as unknown as { identitySettings: { setSecret(k: string, v: string): void } }).identitySettings.setSecret('runtimePrivateKey', entry.runtimePrivateKey)
    } catch (err) {
      bodies.push(err instanceof Error ? err.message : String(err))
    }
    bodies.push((await ping(identity, settings)).text)
    const sse = await readSse(server, 700)
    expect(sse).toContain('stream.hello')
    bodies.push(sse)

    expect(bodies.length).toBeGreaterThan(12)
    expect(captured.length).toBeGreaterThan(0)
    const haystack = [...captured, ...bodies].join('\n')
    for (const secret of secrets) expect(haystack).not.toContain(secret)
    expect(bodies.join('\n')).not.toContain(STUDIO_RUNTIME_ACCOUNT_PREFIX)
  }, 90_000)
})

describe('POST /identity/import', () => {
  it('needs the local proof in every mode, and loopback', async () => {
    const keychain = fakeKeychain()
    const s = makeStudio()
    const { server } = makeDaemon(keychain.backend)
    const noProof = await server.inject({ method: 'POST', url: '/identity/import', payload: { mnemonic: s.phrase } })
    expect(noProof.statusCode).toBe(403)
    expect(noProof.json().error).toContain('X-ADF-Local-Proof')
    const wrong = await server.inject({ method: 'POST', url: '/identity/import', headers: { 'x-adf-local-proof': 'nope'.repeat(10) }, payload: { mnemonic: s.phrase } })
    expect(wrong.statusCode).toBe(403)
    const remote = await server.inject({ method: 'POST', url: '/identity/import', headers: withProof, payload: { mnemonic: s.phrase }, remoteAddress: '10.1.2.3' })
    expect(remote.statusCode).toBe(403)
    expect((await server.inject({ method: 'POST', url: '/identity/import', headers: withProof, payload: { mnemonic: s.phrase } })).statusCode).toBe(200)
  })

  it('another owner: switch_unconfirmed, then backup_unconfirmed naming what is lost, both before any agent is touched', async () => {
    const keychain = fakeKeychain()
    const s = makeStudio(keychain)
    const { server, runtime, settings } = makeDaemon(keychain.backend)
    const made = (await server.inject({ method: 'POST', url: '/agents/create', payload: { name: 'agent-1', directory: agentsDir, start: true } })).json()
    const loadedId = runtime.listAgents()[0].id
    const next = generateMnemonic()
    const nextOwner = deriveOwnerIdentity(next).did

    const unconfirmed = await server.inject({ method: 'POST', url: '/identity/import', headers: withProof, payload: { mnemonic: next } })
    expect(unconfirmed.statusCode).toBe(409)
    expect(unconfirmed.json().code).toBe('switch_unconfirmed')
    expect(unconfirmed.json().error).toContain(nextOwner)
    expect(unconfirmed.json().error).toContain(s.ownerDid)
    expect(unconfirmed.body).not.toContain(next)

    const noBackup = await server.inject({ method: 'POST', url: '/identity/import', headers: withProof, payload: { mnemonic: next, switchOwner: true } })
    expect(noBackup.statusCode).toBe(409)
    expect(noBackup.json().code).toBe('backup_unconfirmed')
    expect(noBackup.json().error).toContain(s.ownerDid)
    expect(noBackup.json().error).toContain("overwrites the daemon's copy of it (the OS keychain entry ADF / owner-mnemonic)")
    expect(noBackup.json().error).toContain('ownerMnemonicSuperseded:' + s.ownerDid)
    expect(settings.get('ownerDid')).toBe(s.ownerDid)
    expect(runtime.listAgents().map((a) => a.id)).toEqual([loadedId]) // nothing unloaded
    expect(made.filePath).toBeTruthy()

    const stated = await server.inject({ method: 'POST', url: '/identity/import', headers: withProof, payload: { mnemonic: next, switchOwner: true, previousOwnerBackupConfirmed: true } })
    expect(stated.statusCode).toBe(200)
    expect(stated.json()).toMatchObject({ switched: true, ownerDid: nextOwner })
  }, 90_000)

  it('file storage on a machine with a keychain: the backup message says the keychain copy is left as it is', async () => {
    const backend = new FileSecretBackend(join(h.userDataDir, 'owner-secrets.json'))
    const { server } = makeDaemon(backend)
    await server.inject({ method: 'POST', url: '/identity/create', payload: { passphrase: 'a long passphrase' } })
    const res = await server.inject({ method: 'POST', url: '/identity/import', headers: withProof, payload: { mnemonic: generateMnemonic(), switchOwner: true } })
    expect(res.json().code).toBe('backup_unconfirmed')
    expect(res.json().error).toContain('owner-secrets.json; a copy in the OS keychain, if ADF Studio put one there, is left as it is')
  })

  it('a failed import (missing or wrong passphrase) unloads nothing', async () => {
    const backend = () => new FileSecretBackend(join(h.userDataDir, 'owner-secrets.json'))
    const first = makeDaemon(backend())
    await first.server.inject({ method: 'POST', url: '/identity/create', payload: { passphrase: 'a long passphrase' } })
    const file = join(agentsDir, 'agent-1.adf')
    AdfWorkspace.create(file, { name: 'agent-1' }).close()

    const second = makeDaemon(backend()) // restarted: the file store is locked
    expect(second.identity.status().status).toBe('locked')
    const ref = await second.runtime.loadAgent(file, { enforceReviewGate: false })
    const payload = { mnemonic: generateMnemonic(), switchOwner: true, previousOwnerBackupConfirmed: true }
    const missing = await second.server.inject({ method: 'POST', url: '/identity/import', headers: withProof, payload })
    expect(missing.statusCode).toBe(400)
    expect(missing.json().code).toBe('passphrase_required')
    const wrong = await second.server.inject({ method: 'POST', url: '/identity/import', headers: withProof, payload: { ...payload, passphrase: 'not the passphrase' } })
    expect(wrong.statusCode).toBe(403)
    expect(wrong.json().code).toBe('wrong_passphrase')
    expect(second.runtime.listAgents().map((a) => a.id)).toEqual([ref.id])
  }, 60_000)

  it('imports run one at a time; every agent ends up loaded once', async () => {
    const keychain = fakeKeychain()
    const s = makeStudio() // phrase not in the keychain: the import acts as a restore
    const { server, runtime, settings } = makeDaemon(keychain.backend)
    const file = join(agentsDir, 'agent-1.adf')
    studioAgent(s.svc, file)
    const cfg = AdfWorkspace.open(file)
    settings.set('reviewedAgents', markConfigReviewed(settings.get('reviewedAgents'), cfg.getAgentConfig()))
    cfg.close()
    await runtime.loadAgent(file)
    const log = vi.spyOn(console, 'log')
    const [a, b] = await Promise.all([
      server.inject({ method: 'POST', url: '/identity/import', headers: withProof, payload: { mnemonic: s.phrase } }),
      server.inject({ method: 'POST', url: '/identity/import', headers: withProof, payload: { mnemonic: s.phrase } }),
    ])
    expect([a.statusCode, b.statusCode]).toEqual([200, 200])
    // The runtime lists an agent by its realpath (macOS: /var is /private/var).
    expect(runtime.listAgents().map((x) => x.filePath)).toEqual([realpathSync(file)])
    // Serialized: the second unload starts after the first reload.
    const steps = log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[ADF Daemon] Owner import:'))
    expect(steps.map((l) => (l.includes('unloading') ? 'u' : 'r')).join('')).toBe('urur')
  }, 60_000)

  it('refused while an embedded Studio on the same settings file is in the host registry, naming it; another settings file does not count', async () => {
    const keychain = fakeKeychain()
    const s = makeStudio(keychain)
    s.svc.confirmBackup()
    const { server, settings } = makeDaemon(keychain.backend)
    // Another process's host record (its pid and endpoint are alive): an embedded Studio on these settings.
    const studio = new AgentLeaseRegistry({ kind: 'studio-embedded', pid: process.ppid, settingsPath, sweepDeadEntries: false })
    try {
      await studio.configure({ kind: 'studio-embedded', settingsPath })
      const payload = { mnemonic: generateMnemonic(), switchOwner: true }
      const refused = await server.inject({ method: 'POST', url: '/identity/import', headers: withProof, payload })
      expect(refused.statusCode).toBe(409)
      expect(refused.json().code).toBe('studio_running')
      expect(refused.json().error).toContain(`ADF Studio (pid ${process.ppid})`)
      expect(refused.json().error).toContain(settingsPath)
      expect(settings.get('ownerDid')).toBe(s.ownerDid)

      await studio.configure({ kind: 'studio-embedded', settingsPath: join(root, 'other', 'adf-settings.json') })
      expect((await server.inject({ method: 'POST', url: '/identity/import', headers: withProof, payload })).statusCode).toBe(200)
    } finally {
      await studio.close()
    }
  }, 60_000)

  it('the restamp leaves files another runtime runs (restamped when next opened) and lists them', async () => {
    const keychain = fakeKeychain()
    const s = makeStudio(keychain)
    s.svc.confirmBackup()
    const mine = join(agentsDir, 'agent-1.adf')
    const theirs = join(agentsDir, 'agent-2.adf')
    studioAgent(s.svc, mine)
    studioAgent(s.svc, theirs)
    const { server, settings } = makeDaemon(keychain.backend)
    settings.set('trackedDirectories', [agentsDir])
    const other = new AgentLeaseRegistry({ kind: 'daemon', pid: process.ppid, settingsPath: join(root, 'other', 'adf-settings.json'), controlUrl: 'http://127.0.0.1:1', sweepDeadEntries: false })
    try {
      expect((await other.acquire(theirs)).ok).toBe(true)
      const before = AdfWorkspace.open(theirs)
      const ownerBefore = before.getMeta('adf_owner_did')
      before.close()
      const next = generateMnemonic()
      const res = await server.inject({ method: 'POST', url: '/identity/import', headers: withProof, payload: { mnemonic: next, switchOwner: true } })
      expect(res.statusCode).toBe(200)
      expect(res.json().restamp).toMatchObject({ restamped: 1, skipped: [theirs] })
      const check = (file: string) => { const ws = AdfWorkspace.open(file); try { return ws.getMeta('adf_owner_did') } finally { ws.close() } }
      expect(check(mine)).toBe(deriveOwnerIdentity(next).did)
      expect(check(theirs)).toBe(ownerBefore) // untouched while the other runtime holds it
    } finally {
      await other.close()
    }
  }, 60_000)

  it('the same owner acts as a restore (no switch, no backup check)', async () => {
    const keychain = fakeKeychain()
    const s = makeStudio() // phrase not in the keychain: daemon is restore-needed
    const { server } = makeDaemon(keychain.backend)
    const res = await server.inject({ method: 'POST', url: '/identity/import', headers: withProof, payload: { mnemonic: s.phrase.toUpperCase() } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ switched: false, previousOwnerDid: s.ownerDid, identity: { status: 'ready', ownerDid: s.ownerDid } })
  })

  it('a daemon on its own runtime keeps the operator attestation of Studio-stamped files when it restamps them', async () => {
    const keychain = fakeKeychain()
    const s = makeStudio(keychain)
    s.svc.confirmBackup()
    const file = join(agentsDir, 'agent-1.adf')
    studioAgent(s.svc, file)
    const { server, settings, identity } = makeDaemon(keychain.backend) // no Studio entry
    settings.set('trackedDirectories', [agentsDir])
    expect(identity.status().runtime.source).toBe('daemon')
    const next = generateMnemonic()
    const res = await server.inject({ method: 'POST', url: '/identity/import', headers: withProof, payload: { mnemonic: next, switchOwner: true } })
    expect(res.statusCode).toBe(200)
    expect(res.json().restamp.restamped).toBe(1)
    const ws = AdfWorkspace.open(file)
    try {
      const did = ws.getDid()!
      expect(ws.getMeta('adf_runtime_did')).toBe(s.runtimeDid)
      const atts = readAdfAttestations(ws)
      const owner = atts.filter((a) => a.role === 'owner')
      expect(owner).toHaveLength(1)
      expect(owner[0].issuer).toBe(deriveOwnerIdentity(next).did)
      expect(verifyAttestation(owner[0], { expectedSubject: did })).toBe(true)
      const operators = atts.filter((a) => a.role === 'operator')
      expect(operators.length).toBeGreaterThan(0)
      for (const op of operators) {
        expect(op.issuer).toBe(s.runtimeDid)
        expect(verifyAttestation(op, { expectedSubject: did })).toBe(true)
      }
    } finally {
      ws.close()
    }
  }, 60_000)
})

describe('owner switch from the CLI, then embedded Studio starts', () => {
  async function switchOwner(opts: { reinsertStaleStudioPhrase?: boolean } = {}) {
    const keychain = fakeKeychain()
    const s = makeStudio(keychain)
    s.svc.confirmBackup()
    writeStudioRuntimeEntry(keychain.backend, settingsPath, s.studio)
    const daemon = makeDaemon(keychain.backend)
    daemon.settings.set('trackedDirectories', [agentsDir])
    const made = (await daemon.server.inject({ method: 'POST', url: '/agents/create', payload: { name: 'agent-1', directory: agentsDir, start: true } })).json()
    const staleBlob = diskSettings().ownerMnemonic
    expect(typeof staleBlob).toBe('string')

    const next = generateMnemonic()
    const nextOwner = deriveOwnerIdentity(next).did
    const res = await daemon.server.inject({ method: 'POST', url: '/identity/import', headers: withProof, payload: { mnemonic: next, switchOwner: true } })
    expect(res.statusCode).toBe(200)
    // The new owner re-signed Studio's runtime and the daemon rewrote the entry: still adopted.
    expect(res.json().identity.runtime).toMatchObject({ state: 'adopted', source: 'studio' })
    expect(diskSettings().ownerMnemonic).toBeUndefined() // moved aside, still encrypted:
    expect(diskSettings()['ownerMnemonicSuperseded:' + s.ownerDid]).toBe(staleBlob)
    expect((await daemon.server.inject({ method: 'GET', url: '/settings' })).body).not.toContain('ownerMnemonicSuperseded')
    expect(keychain.shared.read()).toBe(next)
    if (opts.reinsertStaleStudioPhrase) new FileSettingsStore(settingsPath).set('ownerMnemonic', staleBlob)
    return { keychain, s, daemon, made, next, nextOwner }
  }

  /** A fresh embedded Studio process on the same settings file and keychain. */
  function bootStudio(keychain: ReturnType<typeof fakeKeychain>) {
    const studio = new SettingsService()
    const svc = studio.getOwnerIdentity()
    svc.setSharedMnemonicStore(keychain.shared)
    svc.ensureIdentity()
    return { studio, svc }
  }

  for (const reinsert of [false, true]) {
    it(`Studio follows the switch (${reinsert ? 'stale Studio phrase still present' : 'stale phrase removed by the daemon'}); everything verifies; adoption recovers on the next entry write`, async () => {
      const { keychain, s, daemon, made, next, nextOwner } = await switchOwner({ reinsertStaleStudioPhrase: reinsert })
      await Promise.all(runtimes.flatMap((r) => r.listAgents().map((a) => r.unloadAgent(a.id, { mode: 'immediate' }))))

      const { studio, svc } = bootStudio(keychain)
      expect(svc.getOwnerDid()).toBe(nextOwner)
      expect(svc.revealMnemonic()).toBe(next)
      expect(keychain.shared.read()).toBe(next) // never overwritten with the old phrase
      expect(svc.getRuntimeDid()).toBe(s.runtimeDid) // same Studio runtime
      const status = svc.getStatus()
      expect(status.runtimeDelegation?.issuer).toBe(nextOwner)
      expect(status.runtimeDelegationValid).toBe(true)

      // The daemon still has the new phrase (not restore-needed).
      expect(daemon.identity.status()).toMatchObject({ status: 'ready', ownerDid: nextOwner })

      // A new agent made in Studio after the switch: attestations verify.
      const fresh = join(agentsDir, 'agent-2.adf')
      studioAgent(svc, fresh)
      for (const path of [fresh, made.filePath as string]) {
        const ws = AdfWorkspace.open(path)
        try {
          const did = ws.getDid()!
          const atts = readAdfAttestations(ws)
          const owner = atts.find((a) => a.role === 'owner')!
          expect(owner.issuer).toBe(nextOwner)
          expect(verifyAttestation(owner, { expectedSubject: did })).toBe(true)
          const operator = atts.find((a) => a.role === 'operator')!
          // The restamp kept the adopted runtime: Studio's runtime signs Studio-stamped files.
          expect(operator.issuer).toBe(s.runtimeDid)
          expect(verifyAttestation(operator, { expectedSubject: did })).toBe(true)
          svc.unlockWorkspaceEnvelopes(ws)
          expect(ws.getEnvelopeState('identity')).toBe('unlocked')
        } finally {
          ws.close()
        }
      }

      // W4-A rewrites the entry with Studio's re-signed delegation: still adopted.
      writeStudioRuntimeEntry(keychain.backend, settingsPath, studio)
      expect(daemon.identity.status()).toMatchObject({ status: 'ready', ownerDid: nextOwner, runtimeDid: s.runtimeDid, runtime: { state: 'adopted' } })
    }, 90_000)
  }
})

describe('owner switch from the CLI with no Studio running', () => {
  const SECRET = 'mcp:@acme/server:API_KEY'

  it('the daemon re-signs the adopted runtime and rewrites its entry: Studio-made agents unlock (MCP and adapters start) after the switch and after a daemon restart', async () => {
    const keychain = fakeKeychain()
    const s = makeStudio(keychain)
    s.svc.confirmBackup()
    const account = writeStudioRuntimeEntry(keychain.backend, settingsPath, s.studio)
    const before = JSON.parse(keychain.backend.get(account)!) as Record<string, unknown>
    const file = join(agentsDir, 'agent-1.adf')
    const ws = AdfWorkspace.create(file, { name: 'agent-1' })
    try {
      s.svc.ensureWorkspaceIdentity(ws)
      ws.setIdentitySealed(SECRET, 'value-of-agent-1')
    } finally {
      ws.close()
    }
    const daemon = makeDaemon(keychain.backend)
    daemon.settings.set('trackedDirectories', [agentsDir])
    const cfg = AdfWorkspace.open(file)
    daemon.settings.set('reviewedAgents', markConfigReviewed(daemon.settings.get('reviewedAgents'), cfg.getAgentConfig()))
    cfg.close()
    await daemon.runtime.loadAgent(file)
    expect(daemon.runtime.listAgents()[0].degraded).toBeUndefined()

    const next = generateMnemonic()
    const nextOwner = deriveOwnerIdentity(next).did
    const res = await daemon.server.inject({ method: 'POST', url: '/identity/import', headers: withProof, payload: { mnemonic: next, switchOwner: true } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ switched: true, identity: { ownerDid: nextOwner, runtimeDid: s.runtimeDid, runtime: { state: 'adopted' } }, reloadFailures: [] })

    // The entry: same runtime and keys, delegation now issued by the new owner and valid.
    const after = JSON.parse(keychain.backend.get(account)!) as Record<string, unknown>
    for (const key of ['v', 'runtimeDid', 'runtimePrivateKey', 'runtimeEncPrivateKey', 'runtimeEncPublicKey']) expect(after[key]).toEqual(before[key])
    const delegation = after.runtimeDelegation as Parameters<typeof verifyAttestation>[0]
    expect(delegation.issuer).toBe(nextOwner)
    expect(verifyAttestation(delegation, { expectedSubject: s.runtimeDid })).toBe(true)
    // Studio's own settings are not written by the daemon (Studio re-signs its copy at its next start).
    expect((diskSettings().runtimeDelegation as { issuer: string }).issuer).toBe(s.ownerDid)

    // The reloaded agent is not degraded: its sealed credentials opened, so MCP servers and adapters start.
    const reloaded = daemon.runtime.listAgents()
    expect(reloaded).toHaveLength(1)
    expect(reloaded[0].degraded).toBeUndefined()

    // Daemon restart, Studio still not running.
    for (const agent of daemon.runtime.listAgents()) await daemon.runtime.unloadAgent(agent.id, { mode: 'immediate' })
    const restarted = makeDaemon(keychain.backend)
    expect(restarted.identity.status()).toMatchObject({ status: 'ready', ownerDid: nextOwner, runtime: { state: 'adopted', source: 'studio' } })
    await restarted.runtime.loadAgent(file)
    expect(restarted.runtime.listAgents()[0].degraded).toBeUndefined()
    const check = AdfWorkspace.open(file)
    try {
      restarted.identity.unlockWorkspaceEnvelopes(check)
      expect(check.getEnvelopeState('credentials')).toBe('unlocked')
      expect(check.getIdentityDecrypted(SECRET, null)).toBe('value-of-agent-1')
    } finally {
      check.close()
    }
  }, 90_000)
})

describe('DaemonAppOAuthStore', () => {
  const url = 'https://mcp.example.test/mcp'
  const index = () => daemonAppOAuthAccount(settingsScope(settingsPath))

  it('one chunked account per server: every keychain value fits Windows Credential Manager', async () => {
    const keychain = fakeKeychain()
    const store = new DaemonAppOAuthStore(keychain.backend, index())
    const big = { tokens: { access_token: 'a'.repeat(3000), refresh_token: 'r'.repeat(2500), token_type: 'Bearer' }, serverUrl: url, updatedAt: 1 }
    await store.save(url, big)
    await store.save('https://other.example.test/mcp', { tokens: { access_token: 'b', token_type: 'Bearer' }, serverUrl: 'https://other.example.test/mcp', updatedAt: 2 })
    for (const value of keychain.store.values()) expect(value.length).toBeLessThanOrEqual(SECRET_CHUNK_CHARS)
    expect(SECRET_CHUNK_CHARS).toBeLessThan(1280)
    expect(await store.get(url)).toEqual(big)
    expect(store.listServerUrls()).toEqual([url, 'https://other.example.test/mcp'])
    await expect(store.get('https://evil.example.test/mcp')).resolves.toBeUndefined()

    // Handover shape = Studio's mcpOauthCredentials blob, both ways.
    const blob = store.exportBlob()
    expect(Object.keys(blob)).toEqual([url, 'https://other.example.test/mcp'])
    const other = new DaemonAppOAuthStore(keychain.backend, daemonAppOAuthAccount('scope2'))
    other.importBlob(blob)
    expect(await other.get(url)).toEqual(big)

    // A shorter rewrite leaves no stale chunks; invalidating everything leaves nothing.
    await store.save(url, { tokens: { access_token: 'short', token_type: 'Bearer' }, serverUrl: url, updatedAt: 3 })
    expect((await store.get(url))?.tokens?.access_token).toBe('short')
    await store.invalidate(url, 'all')
    await store.invalidate('https://other.example.test/mcp', 'tokens')
    expect(store.listServerUrls()).toEqual([])
    expect([...keychain.store.keys()].filter((k) => k.includes(index()))).toEqual([])
  })

  it('a crash at any point of a rewrite leaves the old or the new record, never a mix; the next write cleans up', async () => {
    const recordA = { tokens: { access_token: 'A'.repeat(1500), refresh_token: 'a'.repeat(1500), token_type: 'Bearer' }, serverUrl: url, updatedAt: 1 }
    const recordB = { tokens: { access_token: 'B'.repeat(1700), refresh_token: 'b'.repeat(1700), token_type: 'Bearer' }, serverUrl: url, updatedAt: 2 }
    // Count the backend operations of one complete rewrite, then crash after each of them.
    const probe = fakeKeychain()
    await new DaemonAppOAuthStore(probe.backend, index()).save(url, recordA)
    let ops = 0
    const counting = { ...probe.backend, isUnlocked: () => true, get: (a: string) => probe.backend.get(a), set: (a: string, v: string) => { ops++; probe.backend.set(a, v) }, delete: (a: string) => { ops++; probe.backend.delete(a) } }
    await new DaemonAppOAuthStore(counting, index()).save(url, recordB)
    expect(ops).toBeGreaterThan(4)

    for (let crashAfter = 0; crashAfter < ops; crashAfter++) {
      const keychain = fakeKeychain()
      await new DaemonAppOAuthStore(keychain.backend, index()).save(url, recordA)
      let done = 0
      const crashing = {
        isUnlocked: () => true,
        get: (a: string) => keychain.backend.get(a),
        set: (a: string, v: string) => { if (done++ >= crashAfter) throw new Error('crash'); keychain.backend.set(a, v) },
        delete: (a: string) => { if (done++ >= crashAfter) throw new Error('crash'); keychain.backend.delete(a) },
      }
      await expect(new DaemonAppOAuthStore(crashing, index()).save(url, recordB)).rejects.toThrow('crash')
      const store = new DaemonAppOAuthStore(keychain.backend, index())
      const after = await store.get(url)
      expect([JSON.stringify(recordA), JSON.stringify(recordB)]).toContain(JSON.stringify(after))
      // A later complete write leaves exactly one generation per account.
      await store.save(url, recordA)
      expect(await store.get(url)).toEqual(recordA)
      const chunkGens = new Set([...keychain.store.keys()].filter((k) => k.includes('#')).map((k) => k.slice(0, k.lastIndexOf(':'))))
      expect(chunkGens.size).toBe(2) // the index and the record, one generation each
    }
  })

  it('a chunk whose bytes do not match the head checksum reads as absent', async () => {
    const keychain = fakeKeychain()
    const store = new DaemonAppOAuthStore(keychain.backend, index())
    await store.save(url, { tokens: { access_token: 'x'.repeat(2500), token_type: 'Bearer' }, serverUrl: url, updatedAt: 1 })
    const chunk = [...keychain.store.keys()].find((k) => k.includes(':') && k.endsWith(':1') && k.includes('#'))!
    keychain.store.set(chunk, 'tampered')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await store.get(url)).toBeUndefined()
  })

  it('chunks never split a surrogate pair', async () => {
    const value = 'x' + '😀'.repeat(1200)
    const chunks = splitOnCodePoints(value, SECRET_CHUNK_CHARS)
    expect(chunks.join('')).toBe(value)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(SECRET_CHUNK_CHARS)
      const last = chunk.charCodeAt(chunk.length - 1)
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false)
      expect(() => encodeURIComponent(chunk)).not.toThrow() // a lone surrogate would throw
    }
    const keychain = fakeKeychain()
    const store = new DaemonAppOAuthStore(keychain.backend, index())
    const record = { tokens: { access_token: value, token_type: 'Bearer' }, serverUrl: url, updatedAt: 1 }
    await store.save(url, record)
    expect(await store.get(url)).toEqual(record)
  })

  it('refuses a record pinned to another URL, and never writes while the file store is locked', async () => {
    const keychain = fakeKeychain()
    const store = new DaemonAppOAuthStore(keychain.backend, daemonAppOAuthAccount('scope1'))
    await store.save(url, { tokens: { access_token: 'x', token_type: 'Bearer' }, serverUrl: 'https://other.example.test/mcp', updatedAt: 1 })
    await expect(store.get(url)).rejects.toThrow(/refusing to send credentials/)

    const locked = new FileSecretBackend(join(h.userDataDir, 'owner-secrets.json'))
    const lockedStore = new DaemonAppOAuthStore(locked, daemonAppOAuthAccount('scope1'))
    expect(lockedStore.available()).toBe(false)
    await expect(lockedStore.get(url)).resolves.toBeUndefined()
    await expect(lockedStore.save(url, { updatedAt: 1, serverUrl: url, tokens: { access_token: 'y', token_type: 'Bearer' } })).rejects.toThrow(/locked/)
    expect(existsSync(join(h.userDataDir, 'owner-secrets.json'))).toBe(false)
  })
})
