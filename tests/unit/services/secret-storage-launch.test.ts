import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { MessageBoxOptions } from 'electron'
import {
  choiceDialog,
  keyringGuidance,
  plaintextConfirmDialog,
  settleSecretStorageAtLaunch,
  type SecretStorageLaunchDeps,
} from '../../../src/main/services/secret-storage-launch'
import { SECRET_STORAGE_POLICY_KEY, type SecretCipher } from '../../../src/main/services/secret-storage-policy'

const PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow'

const cipher: SecretCipher = {
  encrypt: (plain) => 'safe:' + Buffer.from(plain).toString('base64'),
  decrypt: (stored) => (stored.startsWith('safe:') ? Buffer.from(stored.slice(5), 'base64').toString() : null),
}

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'adf-secret-launch-'))
  path = join(dir, 'adf-settings.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Answers the dialogs by button label, in order; records what was asked. */
function harness(answers: Array<{ button: string; checkbox?: boolean } | ((o: MessageBoxOptions) => { button: string; checkbox?: boolean })>, opts: Partial<SecretStorageLaunchDeps> & { keyring?: () => boolean } = {}) {
  const asked: MessageBoxOptions[] = []
  const log: string[] = []
  const deps: SecretStorageLaunchDeps = {
    settingsPath: path,
    writesSecrets: true,
    platform: 'linux',
    keyring: () => false,
    cipher,
    log: (line) => log.push(line),
    ask: async (options) => {
      asked.push(options)
      const next = answers.shift()
      if (!next) throw new Error(`unexpected dialog: ${options.message}`)
      const { button, checkbox } = typeof next === 'function' ? next(options) : next
      const response = options.buttons!.indexOf(button)
      if (response < 0) throw new Error(`no "${button}" in [${options.buttons!.join(', ')}]`)
      return { response, checkboxChecked: checkbox ?? false }
    },
    ...opts,
  }
  return { deps, asked, log }
}

const disk = () => JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>

describe('fresh install, no keychain', () => {
  it('asks before anything exists; Quit writes nothing at all', async () => {
    const { deps, asked } = harness([{ button: 'Quit' }])
    expect(await settleSecretStorageAtLaunch(deps)).toBe('quit')
    expect(asked[0].message).toBe('ADF Studio cannot use your system keychain')
    expect(asked[0].buttons).toEqual(['Retry', 'Store Unencrypted…', 'Quit'])
    expect(asked[0].cancelId).toBe(2) // Esc / closing the dialog is Quit
    expect(existsSync(path)).toBe(false)
  })

  it('Store Unencrypted needs the warning acknowledged; Back returns to the question; nothing is saved until then', async () => {
    const { deps, asked } = harness([
      { button: 'Store Unencrypted…' },
      { button: 'Store Unencrypted', checkbox: false }, // not acknowledged: asked again
      { button: 'Back' },
      { button: 'Store Unencrypted…' },
      { button: 'Store Unencrypted', checkbox: true },
    ])
    expect(await settleSecretStorageAtLaunch(deps)).toBe('continue')
    expect(asked.map((o) => o.title)).toEqual(['Secret storage', 'Store secrets unencrypted', 'Store secrets unencrypted', 'Secret storage', 'Store secrets unencrypted'])
    expect(asked[1].checkboxLabel).toBe('I understand these secrets will not be encrypted')
    expect(asked[1].checkboxChecked).toBe(false)
    expect(asked[1].defaultId).toBe(1) // Back is the default
    expect(disk()).toEqual({ [SECRET_STORAGE_POLICY_KEY]: 'plaintext' })
  })

  it('the choice is remembered: the next launch asks nothing', async () => {
    writeFileSync(path, JSON.stringify({ [SECRET_STORAGE_POLICY_KEY]: 'plaintext', ownerMnemonic: PHRASE }))
    const { deps, asked } = harness([])
    expect(await settleSecretStorageAtLaunch(deps)).toBe('continue')
    // ...even once a keychain works: switching back is the user's move in Settings.
    expect(await settleSecretStorageAtLaunch({ ...deps, keyring: () => true })).toBe('continue')
    expect(asked).toEqual([])
  })

  it('Retry rechecks the keychain; once it works Studio goes on with nothing to ask', async () => {
    let keyring = false
    const { deps, asked } = harness([
      { button: 'Retry' },
      () => { keyring = true; return { button: 'Retry' } },
    ], { keyring: () => keyring })
    expect(await settleSecretStorageAtLaunch(deps)).toBe('continue')
    expect(asked).toHaveLength(2)
    expect(existsSync(path)).toBe(false)
  })
})

describe('an existing unencrypted install (no choice saved)', () => {
  const legacy = { ownerDid: 'did:key:zOwner', ownerMnemonic: PHRASE, runtimePrivateKey: 'cnVudGltZQ==', theme: 'dark' }

  it('is asked the same question even with a working keychain, and nothing changes before the answer', async () => {
    writeFileSync(path, JSON.stringify(legacy))
    const bytes = readFileSync(path, 'utf-8')
    const { deps, asked } = harness([{ button: 'Quit' }], { keyring: () => true })
    expect(await settleSecretStorageAtLaunch(deps)).toBe('quit')
    expect(asked[0].message).toBe('2 ADF Studio secrets are stored unencrypted')
    expect(asked[0].buttons).toEqual(['Encrypt with Keychain', 'Keep Unencrypted…', 'Quit'])
    expect(readFileSync(path, 'utf-8')).toBe(bytes)
  })

  it('Encrypt with Keychain migrates every secret, keeps the identity, and asks nothing more', async () => {
    writeFileSync(path, JSON.stringify(legacy))
    const { deps, log } = harness([{ button: 'Encrypt with Keychain' }], { keyring: () => true })
    expect(await settleSecretStorageAtLaunch(deps)).toBe('continue')
    const after = disk()
    expect(after[SECRET_STORAGE_POLICY_KEY]).toBe('keyring')
    expect(cipher.decrypt(after.ownerMnemonic as string)).toBe(PHRASE)
    expect(cipher.decrypt(after.runtimePrivateKey as string)).toBe('cnVudGltZQ==')
    expect(after.ownerDid).toBe('did:key:zOwner')
    expect(after.theme).toBe('dark')
    expect(log.join('\n')).not.toContain('legal winner')
  })

  it('a failed migration is shown, leaves the file as it was, and asks again', async () => {
    writeFileSync(path, JSON.stringify(legacy))
    const bytes = readFileSync(path, 'utf-8')
    const { deps, asked } = harness([{ button: 'Encrypt with Keychain' }, { button: 'OK' }, { button: 'Quit' }], {
      keyring: () => true,
      cipher: { ...cipher, decrypt: () => null },
    })
    expect(await settleSecretStorageAtLaunch(deps)).toBe('quit')
    expect(asked[1]).toMatchObject({ type: 'error', message: 'The secrets could not be encrypted' })
    expect(asked[1].detail).toMatch(/Nothing was changed\.$/)
    expect(readFileSync(path, 'utf-8')).toBe(bytes)
  })

  it('Keep Unencrypted saves the choice and leaves the values as they are', async () => {
    writeFileSync(path, JSON.stringify(legacy))
    const { deps } = harness([{ button: 'Keep Unencrypted…' }, { button: 'Store Unencrypted', checkbox: true }], { keyring: () => true })
    expect(await settleSecretStorageAtLaunch(deps)).toBe('continue')
    expect(disk()).toEqual({ ...legacy, [SECRET_STORAGE_POLICY_KEY]: 'plaintext' })
  })

  it('is asked in Local mode too (the daemon stores new secrets; these are Studio\'s old ones)', async () => {
    writeFileSync(path, JSON.stringify(legacy))
    const { deps, asked } = harness([{ button: 'Quit' }], { writesSecrets: false })
    expect(await settleSecretStorageAtLaunch(deps)).toBe('quit')
    expect(asked[0].buttons).toEqual(['Retry', 'Keep Unencrypted…', 'Quit'])
  })
})

describe('the keychain was chosen before and is gone now', () => {
  it('offers Continue Without Keychain: the ciphertext stays untouched and nothing is written', async () => {
    writeFileSync(path, JSON.stringify({ [SECRET_STORAGE_POLICY_KEY]: 'keyring', ownerMnemonic: 'safe:Y2lwaGVy' }))
    const bytes = readFileSync(path, 'utf-8')
    const { deps, asked } = harness([{ button: 'Continue Without Keychain' }])
    expect(await settleSecretStorageAtLaunch(deps)).toBe('continue')
    expect(asked[0].buttons).toEqual(['Retry', 'Continue Without Keychain', 'Store Unencrypted…', 'Quit'])
    expect(asked[0].detail).toMatch(/They are kept as they are/)
    expect(readFileSync(path, 'utf-8')).toBe(bytes)
  })

  it('Local mode with nothing unencrypted asks nothing (Studio writes no secrets there)', async () => {
    writeFileSync(path, JSON.stringify({ ownerMnemonic: 'safe:Y2lwaGVy' }))
    const { deps, asked } = harness([], { writesSecrets: false })
    expect(await settleSecretStorageAtLaunch(deps)).toBe('continue')
    expect(asked).toEqual([])
  })
})

describe('dialog text', () => {
  it('gives short per-platform steps without promising a package fixes everything', () => {
    expect(keyringGuidance('linux')).toMatch(/gnome-keyring/)
    expect(keyringGuidance('linux')).toMatch(/KWallet.*Frameworks 5\.97.*depends on your distribution/)
    expect(keyringGuidance('linux')).toMatch(/Installing a package is not always enough/)
    expect(keyringGuidance('darwin')).toMatch(/login keychain.*Allow/)
    expect(keyringGuidance('win32')).toMatch(/DPAPI/)
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const { options } = choiceDialog({ reason: 'no-keyring', keyringAvailable: false, plaintextSecrets: 0, keyringChosenBefore: false }, platform)
      expect(options.detail).toContain(keyringGuidance(platform))
    }
  })

  it('the warning names the file and what plain text means', () => {
    const options = plaintextConfirmDialog('/home/u/.config/ADF Studio/adf-settings.json')
    expect(options.detail).toContain('/home/u/.config/ADF Studio/adf-settings.json')
    expect(options.detail).toMatch(/can copy these secrets and act as you/)
    expect(options.type).toBe('warning')
  })
})
