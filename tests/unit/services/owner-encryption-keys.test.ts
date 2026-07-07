import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'fs'
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
import { deriveOwnerEncryptionKey, generateMnemonic } from '../../../src/main/crypto/mnemonic-identity'

let rootDir: string

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'adf-enc-keys-'))
  h.userDataDir = join(rootDir, 'userData')
  mkdirSync(h.userDataDir, { recursive: true })
})

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true })
})

describe('OwnerIdentityService encryption keys (ADF_IDENTITY_SPEC D7)', () => {
  it('provisions owner + runtime encryption keys on fresh mint', () => {
    const settings = new SettingsService()
    const svc = settings.getOwnerIdentity()
    svc.ensureIdentity()

    const ownerEncPub = svc.getOwnerEncPublicKey()
    expect(ownerEncPub).not.toBeNull()
    expect(ownerEncPub!.length).toBe(32)
    expect(svc.getRuntimeEncPrivateKey()).not.toBeNull()
    expect(svc.getRuntimeEncPublicKey()!.length).toBe(32)

    // Cached public key matches on-demand derivation from the mnemonic
    const mnemonic = settings.getSecret('ownerMnemonic')!
    expect(deriveOwnerEncryptionKey(mnemonic).publicKeyRaw.equals(ownerEncPub!)).toBe(true)
    // Private half is derivable on demand (recovery path)
    expect(svc.getOwnerEncPrivateKey()).not.toBeNull()
  })

  it('backfills encryption keys for an already-migrated install', () => {
    // Simulate a pre-envelope install: mnemonic-backed identity, enc keys stripped
    const settings = new SettingsService()
    const svc = settings.getOwnerIdentity()
    svc.ensureIdentity()
    settings.delete('ownerEncPublicKey')
    settings.delete('runtimeEncPublicKey')
    settings.delete('runtimeEncPrivateKey')
    expect(svc.getOwnerEncPublicKey()).toBeNull()

    const { migrated } = svc.ensureIdentity()
    expect(migrated).toBe(false) // already mnemonic-backed — backfill, not migration
    expect(svc.getOwnerEncPublicKey()).not.toBeNull()
    expect(svc.getRuntimeEncPrivateKey()).not.toBeNull()
  })

  it('re-derives the owner encryption key on mnemonic import, keeping the runtime key', () => {
    const settings = new SettingsService()
    const svc = settings.getOwnerIdentity()
    svc.ensureIdentity()
    const runtimeEncBefore = svc.getRuntimeEncPrivateKey()!
    const ownerEncBefore = svc.getOwnerEncPublicKey()!

    const imported = generateMnemonic()
    svc.importMnemonic(imported)

    const ownerEncAfter = svc.getOwnerEncPublicKey()!
    expect(ownerEncAfter.equals(ownerEncBefore)).toBe(false)
    expect(ownerEncAfter.equals(deriveOwnerEncryptionKey(imported).publicKeyRaw)).toBe(true)
    expect(svc.getRuntimeEncPrivateKey()!.equals(runtimeEncBefore)).toBe(true)
  })

  it('never ships the runtime encryption private key to the renderer', () => {
    const settings = new SettingsService()
    settings.getOwnerIdentity().ensureIdentity()

    const shipped = settings.getAll()
    expect(shipped.runtimeEncPrivateKey).toBeUndefined()
    expect(shipped.ownerMnemonic).toBeUndefined()
    expect(shipped.runtimePrivateKey).toBeUndefined()
    // Public halves are fine to ship
    expect(shipped.ownerEncPublicKey).toBeDefined()
  })
})
