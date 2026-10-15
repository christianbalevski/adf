import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// encryptionAvailable/decryptThrows default to the plaintext-fallback behavior
// the pre-existing tests assume; the locked-secret tests flip them per case.
const h = vi.hoisted(() => ({ userDataDir: '', encryptionAvailable: false, decryptThrows: false }))

vi.mock('electron', () => ({
  app: { getPath: () => h.userDataDir, on: () => {}, getName: () => 't', getVersion: () => '0' },
  safeStorage: {
    isEncryptionAvailable: () => h.encryptionAvailable,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => {
      if (h.decryptThrows) throw new Error('keychain access denied')
      return b.toString()
    }
  },
  shell: { openExternal: async () => {} },
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
  BrowserWindow: class {},
  dialog: {}
}))

import { SettingsService } from '../../../src/main/services/settings.service'
import { ownerMnemonicSupersededKey } from '../../../src/main/services/owner-identity.service'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { appendAdfAttestation, createAttestation, readAdfAttestations, verifyAttestation } from '../../../src/main/services/attestation.service'
import { extractRawPublicKey, generateEd25519KeyPair, publicKeyToDid } from '../../../src/main/crypto/identity-crypto'
import { deriveOwnerIdentity, generateMnemonic } from '../../../src/main/crypto/mnemonic-identity'

const LEGACY_OWNER = 'did:key:zLegacyOwner111'
const LEGACY_RUNTIME = 'did:key:zLegacyRuntime111'

let rootDir: string
let trackedDir: string

function seedSettings(data: Record<string, unknown>): void {
  writeFileSync(join(h.userDataDir, 'adf-settings.json'), JSON.stringify(data), 'utf-8')
}

function makeAdf(name: string, opts?: { ownerDid?: string; runtimeDid?: string; withKeys?: boolean; password?: string }): string {
  const filePath = join(trackedDir, `${name}.adf`)
  const ws = AdfWorkspace.create(filePath, { name })
  try {
    if (opts?.withKeys) ws.generateIdentityKeys(null)
    if (opts?.ownerDid) ws.setMeta('adf_owner_did', opts.ownerDid, 'readonly')
    if (opts?.runtimeDid) ws.setMeta('adf_runtime_did', opts.runtimeDid, 'readonly')
    if (opts?.password) ws.setPassword(opts.password)
  } finally {
    ws.close()
  }
  return filePath
}

function readMeta(filePath: string, key: string): string | null {
  const ws = AdfWorkspace.open(filePath)
  try {
    return ws.getMeta(key)
  } finally {
    ws.close()
  }
}

beforeEach(() => {
  h.encryptionAvailable = false
  h.decryptThrows = false
  rootDir = mkdtempSync(join(tmpdir(), 'adf-owner-identity-'))
  h.userDataDir = join(rootDir, 'userData')
  // getUserDataPath() prefers the env var over the mocked app.getPath.
  process.env.ADF_USER_DATA_DIR = h.userDataDir
  trackedDir = join(rootDir, 'agents')
  mkdirSync(h.userDataDir, { recursive: true })
  mkdirSync(trackedDir, { recursive: true })
})

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true })
})

describe('OwnerIdentityService.ensureIdentity', () => {
  it('fresh install: mints mnemonic-backed owner + runtime identity with delegation', () => {
    const settings = new SettingsService()
    const { ownerDid, runtimeDid, migrated } = settings.getOwnerIdentity().ensureIdentity()

    expect(migrated).toBe(false)
    expect(ownerDid.startsWith('did:key:z')).toBe(true)
    expect(runtimeDid.startsWith('did:key:z')).toBe(true)
    expect(ownerDid).not.toBe(runtimeDid)

    const status = settings.getOwnerIdentity().getStatus()
    expect(status.hasMnemonic).toBe(true)
    expect(status.backupConfirmed).toBe(false)
    expect(status.legacyOwnerDids).toEqual([])

    // Runtime delegation verifies: owner attests the runtime key
    const delegation = settings.getOwnerIdentity().getRuntimeDelegation()
    expect(delegation).not.toBeNull()
    expect(delegation!.issuer).toBe(ownerDid)
    expect(delegation!.role).toBe('runtime')
    expect(verifyAttestation(delegation!, { expectedSubject: runtimeDid })).toBe(true)

    // Mnemonic re-derives the same owner DID
    const mnemonic = settings.getOwnerIdentity().revealMnemonic()
    expect(deriveOwnerIdentity(mnemonic!).did).toBe(ownerDid)
  })

  it('upgrade: migrates legacy DIDs, restamps matching ADFs only, attests keyed files', () => {
    seedSettings({ ownerDid: LEGACY_OWNER, runtimeDid: LEGACY_RUNTIME, trackedDirectories: [trackedDir] })
    const mine = makeAdf('mine', { ownerDid: LEGACY_OWNER, runtimeDid: LEGACY_RUNTIME, withKeys: true })
    const foreign = makeAdf('foreign', { ownerDid: 'did:key:zSomeoneElse', withKeys: true })
    const unstamped = makeAdf('unstamped', { withKeys: true })

    const settings = new SettingsService()
    const { ownerDid, runtimeDid, migrated } = settings.getOwnerIdentity().ensureIdentity()

    expect(migrated).toBe(true)
    expect(ownerDid).not.toBe(LEGACY_OWNER)
    expect(settings.getOwnerIdentity().getStatus().legacyOwnerDids).toEqual([LEGACY_OWNER])

    // Owner-matched file: restamped + attested
    expect(readMeta(mine, 'adf_owner_did')).toBe(ownerDid)
    expect(readMeta(mine, 'adf_runtime_did')).toBe(runtimeDid)
    const ws = AdfWorkspace.open(mine)
    try {
      const atts = readAdfAttestations(ws)
      expect(atts.length).toBeGreaterThanOrEqual(1)
      const ownerAtt = atts.find((a) => a.role === 'owner')!
      expect(ownerAtt.issuer).toBe(ownerDid)
      expect(verifyAttestation(ownerAtt, { expectedSubject: ws.getDid()! })).toBe(true)
    } finally {
      ws.close()
    }

    // Foreign + unstamped files: untouched
    expect(readMeta(foreign, 'adf_owner_did')).toBe('did:key:zSomeoneElse')
    expect(readMeta(unstamped, 'adf_owner_did')).toBeNull()
  })

  it('restamps password-locked files (attestations live in adf_meta, not the encrypted keystore)', () => {
    seedSettings({ ownerDid: LEGACY_OWNER, trackedDirectories: [trackedDir] })
    const locked = makeAdf('locked', { ownerDid: LEGACY_OWNER, withKeys: true, password: 'hunter2' })

    const settings = new SettingsService()
    const { ownerDid } = settings.getOwnerIdentity().ensureIdentity()

    expect(readMeta(locked, 'adf_owner_did')).toBe(ownerDid)
    const ws = AdfWorkspace.open(locked)
    try {
      expect(ws.isPasswordProtected()).toBe(true)
      expect(readAdfAttestations(ws).length).toBeGreaterThanOrEqual(1)
    } finally {
      ws.close()
    }
  })

  it('is idempotent: second launch changes nothing', () => {
    seedSettings({ ownerDid: LEGACY_OWNER, trackedDirectories: [trackedDir] })
    const settings = new SettingsService()
    const first = settings.getOwnerIdentity().ensureIdentity()

    const settings2 = new SettingsService()
    const second = settings2.getOwnerIdentity().ensureIdentity()
    expect(second.migrated).toBe(false)
    expect(second.ownerDid).toBe(first.ownerDid)
    expect(second.runtimeDid).toBe(first.runtimeDid)
    expect(settings2.getOwnerIdentity().getStatus().legacyOwnerDids).toEqual([LEGACY_OWNER])
  })
})

describe('OwnerIdentityService.ensureIdentity with a locked mnemonic', () => {
  const EXISTING_OWNER = 'did:key:zExistingOwner111'
  const EXISTING_RUNTIME = 'did:key:zExistingRuntime111'
  const LOCKED_MNEMONIC = 'safe:' + Buffer.from('not-really-ciphertext').toString('base64')
  const LOCKED_RUNTIME_KEY = 'safe:' + Buffer.from('not-really-a-key').toString('base64')
  const LOCKED_ENC_KEY = 'safe:' + Buffer.from('not-really-an-enc-key').toString('base64')

  let consoleError: ReturnType<typeof vi.spyOn>
  let consoleWarn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleError.mockRestore()
    consoleWarn.mockRestore()
  })

  function seedLockedIdentity(): void {
    seedSettings({
      ownerDid: EXISTING_OWNER,
      runtimeDid: EXISTING_RUNTIME,
      ownerMnemonic: LOCKED_MNEMONIC,
      runtimePrivateKey: LOCKED_RUNTIME_KEY,
      runtimeEncPrivateKey: LOCKED_ENC_KEY,
      trackedDirectories: [trackedDir]
    })
  }

  function readSettingsFile(): Record<string, unknown> {
    return JSON.parse(readFileSync(join(h.userDataDir, 'adf-settings.json'), 'utf-8'))
  }

  function expectNothingRotated(settings: SettingsService): void {
    const raw = readSettingsFile()
    expect(raw.ownerMnemonic).toBe(LOCKED_MNEMONIC)
    expect(raw.ownerDid).toBe(EXISTING_OWNER)
    expect(raw.runtimeDid).toBe(EXISTING_RUNTIME)
    expect(raw.runtimePrivateKey).toBe(LOCKED_RUNTIME_KEY)
    expect(raw.runtimeEncPrivateKey).toBe(LOCKED_ENC_KEY)

    const status = settings.getOwnerIdentity().getStatus()
    expect(status.mnemonicLocked).toBe(true)
    expect(status.hasMnemonic).toBe(false)
    expect(status.legacyOwnerDids).toEqual([])
    expect(status.legacyRuntimeDids).toEqual([])
  }

  it('refuses to re-mint when the blob is present but decryption fails', () => {
    h.encryptionAvailable = true
    h.decryptThrows = true
    seedLockedIdentity()

    const settings = new SettingsService()
    const result = settings.getOwnerIdentity().ensureIdentity()

    expect(result).toEqual({ ownerDid: EXISTING_OWNER, runtimeDid: EXISTING_RUNTIME, migrated: false })
    expectNothingRotated(settings)
  })

  it('refuses to re-mint when safeStorage is unavailable but a blob exists', () => {
    h.encryptionAvailable = false
    seedLockedIdentity()

    const settings = new SettingsService()
    const result = settings.getOwnerIdentity().ensureIdentity()

    expect(result).toEqual({ ownerDid: EXISTING_OWNER, runtimeDid: EXISTING_RUNTIME, migrated: false })
    expectNothingRotated(settings)
  })

  it('leaves a locked runtime encryption keypair alone while the mnemonic still reads', () => {
    // Mnemonic stored plaintext (readable) but the enc key is a stale blob:
    // ensureEncryptionKeys must not mint over it.
    const mnemonic = generateMnemonic()
    h.encryptionAvailable = false
    seedSettings({
      ownerDid: deriveOwnerIdentity(mnemonic).did,
      runtimeDid: EXISTING_RUNTIME,
      ownerMnemonic: mnemonic,
      runtimeEncPrivateKey: LOCKED_ENC_KEY,
      runtimeEncPublicKey: 'stale-public-half'
    })

    const settings = new SettingsService()
    settings.getOwnerIdentity().ensureIdentity()

    const raw = readSettingsFile()
    expect(raw.runtimeEncPrivateKey).toBe(LOCKED_ENC_KEY)
    expect(raw.runtimeEncPublicKey).toBe('stale-public-half')
  })

  it('a genuinely absent mnemonic still mints (fresh install unchanged)', () => {
    const settings = new SettingsService()
    const { ownerDid, runtimeDid } = settings.getOwnerIdentity().ensureIdentity()

    expect(ownerDid.startsWith('did:key:z')).toBe(true)
    expect(runtimeDid.startsWith('did:key:z')).toBe(true)

    const status = settings.getOwnerIdentity().getStatus()
    expect(status.mnemonicLocked).toBe(false)
    expect(status.hasMnemonic).toBe(true)
  })
})

describe('OwnerIdentityService.importMnemonic', () => {
  it('converges to the imported identity and restamps local files', () => {
    seedSettings({ trackedDirectories: [trackedDir] })
    const settings = new SettingsService()
    const before = settings.getOwnerIdentity().ensureIdentity()

    const mine = makeAdf('mine', { ownerDid: before.ownerDid, withKeys: true })

    // Import a "machine A" mnemonic
    const sharedMnemonic = generateMnemonic()
    const expected = deriveOwnerIdentity(sharedMnemonic)
    const result = settings.getOwnerIdentity().importMnemonic(sharedMnemonic)

    expect(result.ownerDid).toBe(expected.did)
    expect(result.restamped).toBe(1)
    expect(readMeta(mine, 'adf_owner_did')).toBe(expected.did)

    const status = settings.getOwnerIdentity().getStatus()
    expect(status.legacyOwnerDids).toContain(before.ownerDid)
    expect(status.backupConfirmed).toBe(true)

    // Runtime delegation re-signed under the imported owner
    const delegation = settings.getOwnerIdentity().getRuntimeDelegation()
    expect(delegation!.issuer).toBe(expected.did)
    expect(verifyAttestation(delegation!, { expectedSubject: before.runtimeDid })).toBe(true)
  })

  it('rejects invalid phrases', () => {
    const settings = new SettingsService()
    settings.getOwnerIdentity().ensureIdentity()
    expect(() => settings.getOwnerIdentity().importMnemonic('twelve garbage words that are not a bip39 phrase at all')).toThrow(/Invalid mnemonic/)
  })
})

describe('secret redaction', () => {
  it('getAll never exposes the mnemonic or runtime private key', () => {
    const settings = new SettingsService()
    settings.getOwnerIdentity().ensureIdentity()
    const all = settings.getAll()
    expect(all.ownerMnemonic).toBeUndefined()
    expect(all.runtimePrivateKey).toBeUndefined()
    // But they are persisted on disk (plaintext fallback in this mock)
    const raw = JSON.parse(readFileSync(join(h.userDataDir, 'adf-settings.json'), 'utf-8'))
    expect(raw.ownerMnemonic).toBeDefined()
  })
})

// Rule E3 (daemon-backend W1-C review): the owner switched outside Studio
// (`adf identity import` rewrites ownerDid and the shared keychain phrase).
describe('owner switched outside Studio', () => {
  function switchedOutside(keychainPhrase: string, opts: { recordSwitch?: boolean } = {}) {
    h.encryptionAvailable = true
    const old = generateMnemonic()
    const next = generateMnemonic()
    const first = new SettingsService().getOwnerIdentity()
    first.importMnemonic(old)
    first.ensureIdentity()
    const runtimeDid = first.getRuntimeDid()
    // What the daemon's import writes into the shared settings file.
    const path = join(h.userDataDir, 'adf-settings.json')
    const disk = JSON.parse(readFileSync(path, 'utf-8'))
    disk.ownerDid = deriveOwnerIdentity(next).did
    // A genuine switch records the previous owner (importMnemonic); a hand edit does not.
    if (opts.recordSwitch !== false) disk.legacyOwnerDids = [deriveOwnerIdentity(old).did]
    writeFileSync(path, JSON.stringify(disk), 'utf-8')
    let keychain = keychainPhrase === 'next' ? next : keychainPhrase
    const shared = { read: () => keychain, write: (m: string) => { keychain = m } }
    const svc = new SettingsService().getOwnerIdentity()
    svc.setSharedMnemonicStore(shared)
    return { svc, old, next, runtimeDid, keychain: () => keychain }
  }

  it('takes the keychain phrase of the owner on record over its own stale copy, keeps the stale one, re-signs its delegation', () => {
    const { svc, old, next, runtimeDid, keychain } = switchedOutside('next')
    svc.ensureIdentity()
    expect(svc.revealMnemonic()).toBe(next)
    expect(keychain()).toBe(next)
    // The previous owner's phrase is kept, encrypted like ownerMnemonic, and never shown.
    const key = ownerMnemonicSupersededKey(deriveOwnerIdentity(old).did)
    const settings = new SettingsService()
    expect(settings.getSecret(key)).toBe(old)
    const raw = JSON.parse(readFileSync(join(h.userDataDir, 'adf-settings.json'), 'utf-8'))[key] as string
    expect(raw.startsWith('safe:')).toBe(true)
    expect(raw).not.toContain(old)
    expect(settings.getAll()).not.toHaveProperty(key)
    expect(svc.getRuntimeDid()).toBe(runtimeDid)
    const status = svc.getStatus()
    expect(status.runtimeDelegation?.issuer).toBe(deriveOwnerIdentity(next).did)
    expect(status.runtimeDelegationValid).toBe(true)
  })

  it('a wrong ownerDid (hand edit, copied settings) with that owner phrase in the keychain: keeps its own phrase', () => {
    const { svc, old, next, keychain } = switchedOutside('next', { recordSwitch: false })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    svc.ensureIdentity()
    expect(svc.revealMnemonic()).toBe(old)
    expect(keychain()).toBe(next) // and its own phrase is not mirrored over it either
    expect(warn.mock.calls.some((c) => String(c[0]).includes('no owner switch from it is recorded'))).toBe(true)
    warn.mockRestore()
  })

  it('restamp: a file with no runtime stamp still gets an operator attestation from this runtime', () => {
    h.encryptionAvailable = true
    const settings = new SettingsService()
    const svc = settings.getOwnerIdentity()
    svc.ensureIdentity()
    settings.set('legacyOwnerDids', [LEGACY_OWNER])
    const filePath = makeAdf('agent-2', { ownerDid: LEGACY_OWNER, withKeys: true })
    const ws = AdfWorkspace.open(filePath)
    try {
      expect(svc.restampAndAttest(ws)).toMatchObject({ restamped: true, attested: true })
      const operators = readAdfAttestations(ws).filter((a) => a.role === 'operator')
      expect(operators.map((a) => a.issuer)).toEqual([svc.getRuntimeDid()])
      expect(verifyAttestation(operators[0], { expectedSubject: ws.getDid()! })).toBe(true)
    } finally {
      ws.close()
    }
  })

  it('without a matching keychain phrase: never mirrors the stale copy and never signs with it', () => {
    const third = generateMnemonic()
    const { svc, old, keychain } = switchedOutside(third)
    svc.ensureIdentity()
    expect(svc.revealMnemonic()).toBe(old)
    expect(keychain()).toBe(third) // not overwritten with the previous owner's phrase
    expect(svc.getOwnerSigningKey()).toBeNull()
  })

  it('a restamp keeps the operator attestations of a file stamped by another runtime', () => {
    h.encryptionAvailable = true
    const settings = new SettingsService()
    const svc = settings.getOwnerIdentity()
    svc.ensureIdentity()
    settings.set('legacyOwnerDids', [LEGACY_OWNER])
    const other = generateEd25519KeyPair()
    const otherDid = publicKeyToDid(extractRawPublicKey(other.publicKey))
    const filePath = makeAdf('agent-1', { ownerDid: LEGACY_OWNER, runtimeDid: otherDid, withKeys: true })
    const ws = AdfWorkspace.open(filePath)
    try {
      const subject = ws.getDid()!
      const operator = createAttestation({ issuer: otherDid, subject, role: 'operator', issued_at: new Date().toISOString() }, other.privateKey)
      appendAdfAttestation(ws, operator)
      expect(svc.restampAndAttest(ws)).toMatchObject({ restamped: true, attested: true })
      const atts = readAdfAttestations(ws)
      expect(atts.filter((a) => a.role === 'owner').map((a) => a.issuer)).toEqual([svc.getOwnerDid()])
      expect(atts.filter((a) => a.role === 'operator')).toEqual([operator])
      expect(verifyAttestation(operator, { expectedSubject: subject })).toBe(true)
    } finally {
      ws.close()
    }
  })
})

describe('owner switched on disk while Studio runs (adf identity import)', () => {
  it('ensureIdentity mirrors the phrase only for the owner the settings file names now', () => {
    h.encryptionAvailable = true
    const settings = new SettingsService()
    const svc = settings.getOwnerIdentity()
    let keychain: string | null = null
    svc.setSharedMnemonicStore({ read: () => keychain, write: (m) => { keychain = m } })
    svc.ensureIdentity()
    const mine = svc.revealMnemonic()!
    expect(keychain).toBe(mine)

    // The daemon's switch: the new phrase in the keychain, the new owner in the settings file.
    const next = generateMnemonic()
    keychain = next
    const path = join(h.userDataDir, 'adf-settings.json')
    const disk = JSON.parse(readFileSync(path, 'utf-8'))
    disk.ownerDid = deriveOwnerIdentity(next).did
    disk.legacyOwnerDids = [deriveOwnerIdentity(mine).did]
    writeFileSync(path, JSON.stringify(disk), 'utf-8')

    // A later ensureIdentity in the same Studio run (IPC handlers call it).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    svc.ensureIdentity()
    // W5-D1 (E3): the owner on disk is re-read first; the new owner's phrase is left in place.
    expect(keychain).toBe(next)
    expect(warn.mock.calls.some((c) => String(c[0]).includes(`the settings file now names the owner ${deriveOwnerIdentity(next).did}`))).toBe(true)
    warn.mockRestore()
  })
})
