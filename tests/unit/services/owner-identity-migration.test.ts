import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const h = vi.hoisted(() => ({ userDataDir: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => h.userDataDir, on: () => {}, getName: () => 't', getVersion: () => '0' },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
  shell: { openExternal: async () => {} },
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
  BrowserWindow: class {},
  dialog: {}
}))

import { SettingsService } from '../../../src/main/services/settings.service'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { readAdfAttestations, verifyAttestation } from '../../../src/main/services/attestation.service'
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
  rootDir = mkdtempSync(join(tmpdir(), 'adf-owner-identity-'))
  h.userDataDir = join(rootDir, 'userData')
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
