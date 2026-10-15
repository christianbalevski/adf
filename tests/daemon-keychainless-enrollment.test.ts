/**
 * K12 (design daemon-backend.md §5.3 "Fallback", tracker §5): a machine
 * without a usable keychain. The daemon cannot adopt Studio's runtime
 * identity, so it runs as its own runtime and keeps the owner phrase in its
 * passphrase file. Trusting the daemon's key (`trustedDaemonEncKeys`) is an
 * explicit owner action (POST /identity/trust-daemon, adf identity
 * trust-daemon), never automatic, and refused when the daemon reads the OS
 * keychain. ADF_KEYCHAIN=0 stands in for "no keychain"; every store is a temp
 * file or in memory.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Studio side runs with a working safeStorage (passthrough), like Linux basic_text.
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
import { daemonEncKeyLabel, ensureDaemonEncKey } from '../src/main/daemon/daemon-enc-key'
import { DaemonIdentity, DaemonIdentityError } from '../src/main/daemon/daemon-identity'
import { createDaemonHttpApi } from '../src/main/daemon/http-api'
import { DaemonAgentFactory } from '../src/main/daemon/daemon-agent-factory'
import { setWorkspaceIdentityHooks } from '../src/main/runtime/identity-provisioner'
import { RuntimeService } from '../src/main/runtime/runtime-service'
import { MockLLMProvider } from '../src/main/runtime/headless'
import { AdfWorkspace } from '../src/main/adf/adf-workspace'
import { SettingsService } from '../src/main/services/settings.service'
import { openKeySlot, type KeySlotRecord } from '../src/main/crypto/envelope-crypto'
import type { SecretBackend } from '../src/main/services/owner-secret-store'
import { fakeKeychain } from './helpers/studio-runtime-entry'

const PASSPHRASE = 'a long daemon passphrase'
const SECRET = 'mcp:@acme/server:API_KEY'
const PROOF = 'test-local-proof-0123456789abcdefghijklmnopqrstuvwxyz'

let root: string
let settingsPath: string
let agentsDir: string
const servers: Array<{ close: () => Promise<unknown> }> = []
const runtimes: RuntimeService[] = []
const savedKeychainEnv = process.env.ADF_KEYCHAIN

beforeAll(() => { process.env.ADF_KEYCHAIN = '0' })
afterAll(() => {
  if (savedKeychainEnv === undefined) delete process.env.ADF_KEYCHAIN
  else process.env.ADF_KEYCHAIN = savedKeychainEnv
})

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'adf-k12-'))
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

/** A daemon on the shared settings file: no keychain (ADF_KEYCHAIN=0) unless `backend` is given. */
function makeDaemon(opts: { bootPassphrase?: string; backend?: SecretBackend } = {}) {
  const settings = new FileSettingsStore(settingsPath)
  const encKey = ensureDaemonEncKey(h.userDataDir)
  const identity = new DaemonIdentity({ settings, settingsPath, encKey, bootPassphrase: opts.bootPassphrase, backend: opts.backend })
  return { settings, encKey, identity }
}

/** The same daemon with its HTTP API, as daemon/index.ts wires it. */
function makeDaemonApi(opts: { bootPassphrase?: string; backend?: SecretBackend } = {}) {
  const d = makeDaemon(opts)
  setWorkspaceIdentityHooks(d.identity.workspaceHooks())
  const runtime = new RuntimeService({ settings: d.settings, enforceReviewGate: false, providerFactory: () => new MockLLMProvider() })
  runtimes.push(runtime)
  const agentFactory = new DaemonAgentFactory({ settings: d.settings, identity: d.identity, runtime })
  const server = createDaemonHttpApi(runtime, { settingsStore: d.settings, identity: d.identity, agentFactory, security: { localProof: PROOF } })
  servers.push(server)
  return { ...d, runtime, server }
}

/** Embedded Studio (fresh SettingsService over the shared file, as at each Studio start). */
function makeStudio() {
  const studio = new SettingsService()
  const svc = studio.getOwnerIdentity()
  svc.ensureIdentity()
  return { studio, svc, phrase: svc.revealMnemonic()! }
}

/** A Studio-made agent with one sealed credential. */
function studioAgent(svc: ReturnType<typeof makeStudio>['svc'], name: string): string {
  const filePath = join(agentsDir, `${name}.adf`)
  const ws = AdfWorkspace.create(filePath, { name })
  try {
    svc.ensureWorkspaceIdentity(ws)
    ws.setIdentitySealed(SECRET, `value-of-${name}`)
  } finally {
    ws.close()
  }
  return filePath
}

/** Open as the daemon does (its workspace hooks) and read the sealed credential. */
function daemonRead(identity: DaemonIdentity, filePath: string): string | null {
  const ws = AdfWorkspace.open(filePath)
  try {
    identity.workspaceHooks().ensureIdentity(ws)
    return ws.getIdentityDecrypted(SECRET, null)
  } finally {
    ws.close()
  }
}

/** Whether the file has a credentials slot under `label` that `privateKey` opens. */
function hasWorkingSlot(filePath: string, label: string, privateKey: Buffer): boolean {
  const ws = AdfWorkspace.open(filePath)
  try {
    const slot = (ws.readEnvelopeSlots('credentials') ?? []).find((s) => s.type !== 'password' && (s as KeySlotRecord).recipient_did === label) as KeySlotRecord | undefined
    return !!slot && openKeySlot(slot, 'credentials', privateKey) !== null
  } finally {
    ws.close()
  }
}

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

const disk = () => JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
const withProof = { 'x-adf-local-proof': PROOF }

describe('K12: no automatic enrollment', () => {
  it('without a keychain the owner key opens a Studio agent, but nothing enrolls the daemon', () => {
    const s = makeStudio()
    const first = studioAgent(s.svc, 'agent-1')
    const d = makeDaemon()
    d.identity.restore({ mnemonic: s.phrase, passphrase: PASSPHRASE })
    expect(d.identity.status().runtime.state).toBe('unavailable')
    expect(d.identity.status().trust).toMatchObject({ state: 'not-trusted', label: d.encKey.label })
    expect(daemonRead(d.identity, first)).toBe('value-of-agent-1')
    expect(disk().trustedDaemonEncKeys).toBeUndefined()
    expect(hasWorkingSlot(first, d.encKey.label, d.encKey.privateKeyPkcs8)).toBe(false)
  })

  it('a keychain whose read throws (adoption unavailable) enrolls nothing, and trust is refused', () => {
    const keychain = fakeKeychain()
    const s = new SettingsService()
    const svc = s.getOwnerIdentity()
    svc.setSharedMnemonicStore(keychain.shared)
    svc.ensureIdentity()
    const first = studioAgent(svc, 'agent-1')
    // The keychain answers the owner phrase but fails on Studio's runtime entry.
    const flaky = Object.create(keychain.backend) as SecretBackend
    flaky.get = (account: string) => {
      if (account.startsWith('studio-runtime:')) throw new Error('keychain read failed')
      return keychain.backend.get(account)
    }
    const d = makeDaemon({ backend: flaky })
    const status = d.identity.status()
    expect(status.runtime.state).toBe('unavailable')
    expect(status.storage).toBe('keychain')
    expect(status.trust?.state).toBe('not-applicable')
    expect(daemonRead(d.identity, first)).toBe('value-of-agent-1') // through the owner key
    expect(disk().trustedDaemonEncKeys).toBeUndefined()
    expect(hasWorkingSlot(first, d.encKey.label, d.encKey.privateKeyPkcs8)).toBe(false)
    expect(() => d.identity.trustDaemon()).toThrow(DaemonIdentityError)
    try { d.identity.trustDaemon() } catch (err) { expect((err as DaemonIdentityError).code).toBe('keychain_available') }
    expect(disk().trustedDaemonEncKeys).toBeUndefined()
  })
})

describe('K12: trust-daemon and untrust-daemon (owner actions)', () => {
  it('needs the local proof, the confirm and the owner key', async () => {
    const s = makeStudio()
    studioAgent(s.svc, 'agent-1')
    const d = makeDaemonApi()
    const noProof = await d.server.inject({ method: 'POST', url: '/identity/trust-daemon', payload: { confirm: true } })
    expect(noProof.statusCode).toBe(403)
    const noConfirm = await d.server.inject({ method: 'POST', url: '/identity/trust-daemon', headers: withProof, payload: {} })
    expect(noConfirm.statusCode).toBe(400)
    expect(noConfirm.json()).toMatchObject({ code: 'confirm_required' })
    expect(noConfirm.json().error).toContain('not a signed statement')
    const noOwner = await d.server.inject({ method: 'POST', url: '/identity/trust-daemon', headers: withProof, payload: { confirm: true } })
    expect(noOwner.statusCode).toBe(409)
    expect(noOwner.json()).toMatchObject({ code: 'not_ready' })
    expect(disk().trustedDaemonEncKeys).toBeUndefined()
  })

  it('an explicit trust enrolls: the key in trustedDaemonEncKeys, slots on open agents and on agents Studio makes later; credentials unlock without the passphrase', async () => {
    const s = makeStudio()
    const first = studioAgent(s.svc, 'agent-1')
    const d = makeDaemonApi()
    d.identity.restore({ mnemonic: s.phrase, passphrase: PASSPHRASE })
    const ref = await d.runtime.loadAgent(first)
    expect(ref.id).toBeTruthy()

    const trusted = await d.server.inject({ method: 'POST', url: '/identity/trust-daemon', headers: withProof, payload: { confirm: true } })
    expect(trusted.statusCode).toBe(200)
    expect(trusted.json()).toMatchObject({ trust: { state: 'trusted', label: d.encKey.label }, agentsUpdated: 1 })
    expect(disk().trustedDaemonEncKeys).toEqual([d.encKey.publicKeyB64])
    expect(hasWorkingSlot(first, d.encKey.label, d.encKey.privateKeyPkcs8)).toBe(true)
    const version = (await d.server.inject({ method: 'GET', url: '/version' })).json()
    expect(version.trust).toMatchObject({ state: 'trusted' })
    await d.runtime.unloadAgent(ref.id, { mode: 'immediate' })

    // Embedded Studio wraps a new agent to the trusted key (Phase C); a daemon started without its passphrase opens both.
    const s2 = makeStudio()
    const second = studioAgent(s2.svc, 'agent-2')
    expect(hasWorkingSlot(second, daemonEncKeyLabel(d.encKey.publicKeyRaw), d.encKey.privateKeyPkcs8)).toBe(true)
    const restarted = makeDaemon()
    expect(restarted.identity.status().status).toBe('locked')
    expect(daemonRead(restarted.identity, first)).toBe('value-of-agent-1')
    expect(daemonRead(restarted.identity, second)).toBe('value-of-agent-2')
    // Only the credentials envelope: the identity envelope never gets a daemon slot.
    const ws = AdfWorkspace.open(second)
    try {
      expect(ws.unlockEnvelopes({ runtimeEncPrivateKey: restarted.encKey.privateKeyPkcs8 }).identity).not.toBe('unlocked')
    } finally {
      ws.close()
    }
  })

  it('untrust revokes: the key leaves the list and is rotated, loaded and tracked agents lose the slot, an unloaded copy loses it when opened, and nothing is re-added', async () => {
    const s = makeStudio()
    const first = studioAgent(s.svc, 'agent-1')
    const second = studioAgent(s.svc, 'agent-2')
    const d = makeDaemonApi()
    d.settings.set('trackedDirectories', [agentsDir])
    d.identity.restore({ mnemonic: s.phrase, passphrase: PASSPHRASE })
    expect((await d.server.inject({ method: 'POST', url: '/identity/trust-daemon', headers: withProof, payload: { confirm: true } })).statusCode).toBe(200)
    expect(daemonRead(d.identity, second)).toBe('value-of-agent-2')
    const ref = await d.runtime.loadAgent(first)
    const old = { label: d.encKey.label, privateKey: d.encKey.privateKeyPkcs8 }
    expect(hasWorkingSlot(first, old.label, old.privateKey)).toBe(true)
    expect(hasWorkingSlot(second, old.label, old.privateKey)).toBe(true)
    // A copy outside the tracked folders, as a backup or a file sent elsewhere.
    const outside = join(root, 'outside', 'agent-2.adf')
    mkdirSync(join(root, 'outside'), { recursive: true })
    copyFileSync(second, outside)

    const revoked = await d.server.inject({ method: 'POST', url: '/identity/untrust-daemon', headers: withProof })
    expect(revoked.statusCode).toBe(200)
    expect(revoked.json()).toMatchObject({ trust: { state: 'not-trusted' }, retiredLabel: old.label, agentsUpdated: 1, sweep: 'started' })
    expect(revoked.json().trust.label).not.toBe(old.label)
    expect(disk().trustedDaemonEncKeys).toEqual([])
    // The key file holds a new key; the old one is no longer used.
    const rotated = ensureDaemonEncKey(h.userDataDir)
    expect(rotated.label).not.toBe(old.label)
    expect(rotated.privateKeyPkcs8.equals(old.privateKey)).toBe(false)
    expect(hasWorkingSlot(first, old.label, old.privateKey)).toBe(false) // loaded: at once
    await waitFor(() => !hasWorkingSlot(second, old.label, old.privateKey)) // tracked: the background sweep
    await d.runtime.unloadAgent(ref.id, { mode: 'immediate' })

    // The copy outside the tracked folders still carries the old slot: whoever holds the old key file can open it until it is opened here.
    expect(hasWorkingSlot(outside, old.label, old.privateKey)).toBe(true)
    // A daemon restarted without the passphrase, on the rotated key: nothing unlocks, and opening the copy removes the old slot.
    const restarted = makeDaemon()
    expect(restarted.encKey.label).toBe(rotated.label)
    expect(daemonRead(restarted.identity, first)).toBeNull()
    expect(daemonRead(restarted.identity, second)).toBeNull()
    expect(daemonRead(restarted.identity, outside)).toBeNull()
    expect(hasWorkingSlot(outside, old.label, old.privateKey)).toBe(false)

    // With the owner key the daemon opens agents again, and adds neither its key nor a slot.
    expect(daemonRead(d.identity, first)).toBe('value-of-agent-1')
    expect(disk().trustedDaemonEncKeys).toEqual([])
    expect(hasWorkingSlot(first, rotated.label, rotated.privateKeyPkcs8)).toBe(false)
    // Embedded Studio wraps nothing to either key any more.
    const s2 = makeStudio()
    const third = studioAgent(s2.svc, 'agent-3')
    expect(hasWorkingSlot(third, old.label, old.privateKey)).toBe(false)
    expect(hasWorkingSlot(third, rotated.label, rotated.privateKeyPkcs8)).toBe(false)
  })

  it('a junk slot under the daemon label is replaced once trusted (label squat)', async () => {
    const { randomBytes } = await import('node:crypto')
    const s = makeStudio()
    const first = studioAgent(s.svc, 'agent-1')
    const d = makeDaemon()
    d.identity.restore({ mnemonic: s.phrase, passphrase: PASSPHRASE })
    const ws = AdfWorkspace.open(first)
    try {
      s.svc.unlockWorkspaceEnvelopes(ws)
      ws.addEnvelopeKeySlot('credentials', 'runtime', d.encKey.label, randomBytes(32))
    } finally {
      ws.close()
    }
    d.identity.trustDaemon()
    expect(daemonRead(d.identity, first)).toBe('value-of-agent-1')
    expect(hasWorkingSlot(first, d.encKey.label, d.encKey.privateKeyPkcs8)).toBe(true)
  })
})
