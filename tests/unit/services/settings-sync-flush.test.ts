import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const h = vi.hoisted(() => ({ userDataDir: '', failWrites: false }))

vi.mock('electron', () => ({
  app: { getPath: () => h.userDataDir, on: () => {}, getName: () => 't', getVersion: () => '0' },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
  shell: { openExternal: async () => {} },
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
  BrowserWindow: class {},
  dialog: {}
}))

vi.mock('../../../src/main/utils/atomic-json', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/main/utils/atomic-json')>()
  return {
    ...real,
    writeJsonAtomic: (path: string, data: unknown) => {
      if (h.failWrites) {
        const err = new Error('EPERM: destination held open') as NodeJS.ErrnoException
        err.code = 'EPERM'
        throw err
      }
      real.writeJsonAtomic(path, data)
    },
  }
})

import { SettingsService } from '../../../src/main/services/settings.service'

let rootDir: string

function settingsPath(dirOverride?: string): string {
  return join(dirOverride ?? h.userDataDir, 'adf-settings.json')
}

function readDisk(dirOverride?: string): Record<string, unknown> {
  return JSON.parse(readFileSync(settingsPath(dirOverride), 'utf-8')) as Record<string, unknown>
}

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'adf-settings-flush-'))
  h.userDataDir = join(rootDir, 'userData')
  mkdirSync(h.userDataDir, { recursive: true })
  h.failWrites = false
  delete process.env.ADF_USER_DATA_DIR
})

afterEach(() => {
  delete process.env.ADF_USER_DATA_DIR
  rmSync(rootDir, { recursive: true, force: true })
})

describe('SettingsService synchronous durability', () => {
  it('setSecret persists to disk within the same tick', () => {
    const settings = new SettingsService()
    settings.setSecret('ownerMnemonic', 'legal winner thank year wave sausage worth useful legal winner thank yellow')
    // No microtask boundary: a crash right now must not lose the mnemonic.
    expect(readDisk().ownerMnemonic).toBe('legal winner thank year wave sausage worth useful legal winner thank yellow')
  })

  it('set() of identity-critical keys persists within the same tick', () => {
    const settings = new SettingsService()
    settings.set('ownerDid', 'did:key:zOwner1')
    settings.set('runtimeDid', 'did:key:zRuntime1')
    const disk = readDisk()
    expect(disk.ownerDid).toBe('did:key:zOwner1')
    expect(disk.runtimeDid).toBe('did:key:zRuntime1')
  })

  it('a second SettingsService constructed in the same tick sees identity written by the first', () => {
    const s1 = new SettingsService()
    const { ownerDid, runtimeDid } = s1.getOwnerIdentity().ensureIdentity()

    // Same tick — no await, no microtask drain. This is the crash window that
    // previously regenerated the owner mnemonic.
    const s2 = new SettingsService()
    expect(s2.getSecret('ownerMnemonic')).toBe(s1.getSecret('ownerMnemonic'))
    const second = s2.getOwnerIdentity().ensureIdentity()
    expect(second.migrated).toBe(false)
    expect(second.ownerDid).toBe(ownerDid)
    expect(second.runtimeDid).toBe(runtimeDid)
  })

  it('non-critical set() stays coalesced to the next microtask', async () => {
    const settings = new SettingsService()
    await Promise.resolve() // drain constructor microtask flush
    settings.set('theme', 'dark')
    expect(readDisk().theme).not.toBe('dark') // not yet flushed
    await Promise.resolve()
    expect(readDisk().theme).toBe('dark')
  })
})

describe('SettingsService write failure handling', () => {
  it('never throws when the disk write fails, and retains dirty keys for a later flush', () => {
    const settings = new SettingsService()
    h.failWrites = true
    expect(() => settings.setSecret('ownerMnemonic', 'mnemonic-under-eperm')).not.toThrow()
    expect(() => settings.set('theme', 'dark')).not.toThrow()

    h.failWrites = false
    settings.flush()
    const disk = readDisk()
    expect(disk.ownerMnemonic).toBe('mnemonic-under-eperm')
    expect(disk.theme).toBe('dark')
  })
})

describe('ADF_USER_DATA_DIR override', () => {
  it('wins over app.getPath so Studio and the daemon share one settings file', () => {
    const override = join(rootDir, 'override-data')
    mkdirSync(override, { recursive: true })
    process.env.ADF_USER_DATA_DIR = override

    const settings = new SettingsService()
    settings.setSecret('ownerMnemonic', 'override words')

    expect(existsSync(settingsPath(override))).toBe(true)
    expect(readDisk(override).ownerMnemonic).toBe('override words')
    expect(existsSync(settingsPath(h.userDataDir))).toBe(false)
  })
})
