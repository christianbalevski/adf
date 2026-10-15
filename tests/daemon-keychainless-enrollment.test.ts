/**
 * K12 (design daemon-backend.md §5.3 "Fallback", tracker §5): a machine
 * without a usable keychain. The daemon cannot adopt Studio's runtime
 * identity, so it runs as its own runtime and keeps the owner phrase in its
 * passphrase file. ADF_KEYCHAIN=0 stands in for "no keychain"; every store is
 * a temp file.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
import { DaemonIdentity } from '../src/main/daemon/daemon-identity'
import { AdfWorkspace } from '../src/main/adf/adf-workspace'
import { SettingsService } from '../src/main/services/settings.service'
import { FileSecretBackend } from '../src/main/services/owner-secret-store'
import { openKeySlot, type KeySlotRecord } from '../src/main/crypto/envelope-crypto'

const PASSPHRASE = 'a long daemon passphrase'
const SECRET = 'mcp:@acme/server:API_KEY'

let root: string
let settingsPath: string
let agentsDir: string
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

afterEach(() => {
  delete process.env.ADF_USER_DATA_DIR
  rmSync(root, { recursive: true, force: true })
})

/** A daemon on the shared settings file, no keychain (ADF_KEYCHAIN=0): the passphrase file holds the phrase. */
function makeDaemon(opts: { bootPassphrase?: string } = {}) {
  const settings = new FileSettingsStore(settingsPath)
  const encKey = ensureDaemonEncKey(h.userDataDir)
  const identity = new DaemonIdentity({ settings, settingsPath, encKey, bootPassphrase: opts.bootPassphrase })
  return { settings, encKey, identity }
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

function credentialSlotDids(filePath: string): string[] {
  const ws = AdfWorkspace.open(filePath)
  try {
    return (ws.readEnvelopeSlots('credentials') ?? []).filter((s) => s.type !== 'password').map((s) => (s as KeySlotRecord).recipient_did)
  } finally {
    ws.close()
  }
}

const disk = () => JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>

describe('K12: a daemon without a keychain and Studio-made agents', () => {
  it('the owner key enrolls the daemon: its key in trustedDaemonEncKeys, a trusted slot in the agent; agents Studio makes later unlock without the passphrase', () => {
    const s = makeStudio()
    const first = studioAgent(s.svc, 'agent-1')

    // The user restores the owner phrase into the daemon (adf identity restore).
    const d1 = makeDaemon()
    d1.identity.restore({ mnemonic: s.phrase, passphrase: PASSPHRASE })
    expect(d1.identity.status().runtime.state).toBe('unavailable')
    expect(daemonRead(d1.identity, first)).toBe('value-of-agent-1')
    const label = daemonEncKeyLabel(d1.encKey.publicKeyRaw)
    expect(disk().trustedDaemonEncKeys).toEqual([d1.encKey.publicKeyB64])
    expect(credentialSlotDids(first)).toContain(label)
    // Idempotent: a second open writes nothing.
    const slotsBefore = credentialSlotDids(first)
    expect(daemonRead(d1.identity, first)).toBe('value-of-agent-1')
    expect(credentialSlotDids(first)).toEqual(slotsBefore)
    expect(disk().trustedDaemonEncKeys).toEqual([d1.encKey.publicKeyB64])

    // Back in embedded Studio, a new agent; then the daemon starts without its passphrase.
    const s2 = makeStudio()
    const second = studioAgent(s2.svc, 'agent-2')
    const d2 = makeDaemon()
    expect(d2.identity.status().status).toBe('locked')
    expect(daemonRead(d2.identity, first)).toBe('value-of-agent-1') // runtime slot re-wrapped through the owner key
    expect(credentialSlotDids(second)).toContain(label)
    expect(daemonRead(d2.identity, second)).toBe('value-of-agent-2')
    // Only the credentials envelope: the identity envelope never gets a daemon slot.
    const ws = AdfWorkspace.open(second)
    try {
      expect(ws.unlockEnvelopes({ runtimeEncPrivateKey: d2.encKey.privateKeyPkcs8 }).identity).not.toBe('unlocked')
    } finally {
      ws.close()
    }
  })

  it('without the owner key the daemon enrolls nothing', () => {
    const s = makeStudio()
    const first = studioAgent(s.svc, 'agent-1')
    const d = makeDaemon() // no phrase restored: restore-needed
    expect(d.identity.status().status).toBe('restore-needed')
    expect(daemonRead(d.identity, first)).toBeNull()
    expect(disk().trustedDaemonEncKeys).toBeUndefined()
  })

  it('a daemon with a keychain does not enroll itself (adoption is the answer there)', async () => {
    const { fakeKeychain } = await import('./helpers/studio-runtime-entry')
    const keychain = fakeKeychain()
    const studio = new SettingsService()
    const svc = studio.getOwnerIdentity()
    svc.setSharedMnemonicStore(keychain.shared)
    svc.ensureIdentity()
    const first = studioAgent(svc, 'agent-1')
    const settings = new FileSettingsStore(settingsPath)
    const identity = new DaemonIdentity({ settings, settingsPath, encKey: ensureDaemonEncKey(h.userDataDir), backend: keychain.backend })
    expect(identity.status().runtime.state).toBe('absent')
    expect(daemonRead(identity, first)).toBe('value-of-agent-1') // through the owner key
    expect(disk().trustedDaemonEncKeys).toBeUndefined()
  })

  it('a junk slot under the daemon label is replaced (label squat)', async () => {
    const { randomBytes } = await import('node:crypto')
    const s = makeStudio()
    const first = studioAgent(s.svc, 'agent-1')
    const d1 = makeDaemon()
    d1.identity.restore({ mnemonic: s.phrase, passphrase: PASSPHRASE })
    const ws = AdfWorkspace.open(first)
    try {
      s.svc.unlockWorkspaceEnvelopes(ws)
      ws.addEnvelopeKeySlot('credentials', 'runtime', d1.encKey.label, randomBytes(32))
    } finally {
      ws.close()
    }
    expect(daemonRead(d1.identity, first)).toBe('value-of-agent-1')
    const cold = AdfWorkspace.open(first)
    try {
      const slot = (cold.readEnvelopeSlots('credentials') ?? []).find((sl) => sl.type !== 'password' && (sl as KeySlotRecord).recipient_did === d1.encKey.label) as KeySlotRecord
      expect(openKeySlot(slot, 'credentials', d1.encKey.privateKeyPkcs8)).not.toBeNull()
    } finally {
      cold.close()
    }
  })
})
