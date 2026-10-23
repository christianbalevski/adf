import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * Settings → Identity → Secret storage with agents on the ADF daemon (Local
 * or remote): Studio's own copies in its settings file stay visible with the
 * plain-text warning and the switch back, which changes only Studio's file,
 * never the daemon's secrets. Fake safeStorage, never the real keychain.
 */
const h = vi.hoisted(() => ({ available: true, handlers: new Map<string, (...args: unknown[]) => unknown>() }))

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp' },
  safeStorage: {
    isEncryptionAvailable: () => h.available,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (s: string) => Buffer.from('K' + s),
    decryptString: (b: Buffer) => b.toString().slice(1),
  },
}))
vi.mock('../../../src/main/backend/studio-ipc', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => { h.handlers.set(channel, fn) } },
}))

import { registerSecretStorageHandlers, type StudioSecretAccess } from '../../../src/main/backend/secret-storage-ipc'
import { IPC } from '../../../src/shared/constants/ipc-channels'
import { CHANNEL_MAP } from '../../../src/main/backend/channel-map'
import { STUDIO_CALL_CHANNELS } from '../../../src/shared/constants/studio-call-channels'

const PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow'
let dir: string
let settingsPath: string

beforeEach(() => {
  h.available = true
  h.handlers.clear()
  dir = mkdtempSync(join(tmpdir(), 'adf-secret-ipc-'))
  mkdirSync(join(dir, 'userData'))
  settingsPath = join(dir, 'userData', 'adf-settings.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const call = (channel: string) => h.handlers.get(channel)!({})
const disk = () => JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>

describe('Studio secret storage with agents on the daemon (Local mode)', () => {
  beforeEach(() => registerSecretStorageHandlers({ settingsPath, embedded: () => null }))

  it('shows a remembered plain-text choice and Studio\'s retained copies, with a working switch back', async () => {
    // Studio's own copies kept from Inside Studio, the plain-text choice made at launch, daemon keys elsewhere.
    writeFileSync(settingsPath, JSON.stringify({ secretStoragePolicy: 'plaintext', ownerDid: 'did:key:zO', runtimeDid: 'did:key:zR', ownerMnemonic: PHRASE, runtimePrivateKey: 'cnVu', providers: [{ id: 'p', apiKey: 'sk-raw' }] }))
    const daemonFiles = { 'owner-secrets.json': '{"sealed":"daemon"}', 'runtime-enc-key': 'daemon-enc-key', 'daemon-token': 'tok' }
    for (const [name, text] of Object.entries(daemonFiles)) writeFileSync(join(dir, 'userData', name), text)

    expect(await call(IPC.STUDIO_SECRET_STORAGE_GET)).toEqual({ policy: 'plaintext', keyringAvailable: true, plaintextSecrets: 2, writesBlocked: false, storedSecrets: 2, scope: 'studio-copies' })
    expect(await call(IPC.STUDIO_SECRET_STORAGE_USE_KEYRING)).toEqual({ success: true, encrypted: 2 })

    const after = disk()
    expect(after.secretStoragePolicy).toBe('keyring')
    expect(after.ownerMnemonic).toBe('safe:' + Buffer.from('K' + PHRASE).toString('base64'))
    expect(after.ownerDid).toBe('did:key:zO')
    expect(after.runtimeDid).toBe('did:key:zR')
    expect(after.providers).toEqual([{ id: 'p', apiKey: 'sk-raw' }]) // ordinary setting: not touched (and not claimed covered)
    for (const [name, text] of Object.entries(daemonFiles)) expect(readFileSync(join(dir, 'userData', name), 'utf-8')).toBe(text)
    expect(await call(IPC.STUDIO_SECRET_STORAGE_GET)).toMatchObject({ policy: 'keyring', plaintextSecrets: 0, storedSecrets: 2 })
  })

  it('without a keychain the switch back changes nothing', async () => {
    writeFileSync(settingsPath, JSON.stringify({ secretStoragePolicy: 'plaintext', ownerMnemonic: PHRASE }))
    const bytes = readFileSync(settingsPath)
    h.available = false
    expect(await call(IPC.STUDIO_SECRET_STORAGE_USE_KEYRING)).toEqual({ success: false, error: 'The OS keychain is not available. Nothing was changed.' })
    expect(readFileSync(settingsPath).equals(bytes)).toBe(true)
  })

  it('nothing to show when Studio holds no secrets and no plain-text choice', async () => {
    writeFileSync(settingsPath, JSON.stringify({ ownerDid: 'did:key:zO' }))
    expect(await call(IPC.STUDIO_SECRET_STORAGE_GET)).toBeNull()
  })
})

describe('Inside Studio', () => {
  it('goes through the settings store, never the file directly', async () => {
    const access: StudioSecretAccess = {
      status: () => ({ policy: 'keyring', keyringAvailable: true, plaintextSecrets: 0, writesBlocked: false, storedSecrets: 3, scope: 'inside-studio' }),
      useKeyring: () => ({ ok: false, error: 'from the store' }),
    }
    registerSecretStorageHandlers({ settingsPath, embedded: () => access })
    expect(await call(IPC.STUDIO_SECRET_STORAGE_GET)).toMatchObject({ scope: 'inside-studio' })
    expect(await call(IPC.STUDIO_SECRET_STORAGE_USE_KEYRING)).toEqual({ success: false, error: 'from the store' })
  })
})

describe('channels', () => {
  it('are Studio calls (no runtime), in the channel map and the Studio call list', () => {
    for (const channel of [IPC.STUDIO_SECRET_STORAGE_GET, IPC.STUDIO_SECRET_STORAGE_USE_KEYRING]) {
      expect(CHANNEL_MAP[channel as keyof typeof CHANNEL_MAP]).toMatchObject({ class: 'local', scope: 'studio' })
      expect(STUDIO_CALL_CHANNELS).toContain(channel)
    }
  })
})
