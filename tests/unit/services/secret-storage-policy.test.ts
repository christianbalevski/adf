import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  SECRET_STORAGE_POLICY_KEY,
  chooseKeyringStorage,
  choosePlaintextStorage,
  isSecretSettingsKey,
  launchChoice,
  secretInventory,
  secretStorageView,
  secretWriteRefusal,
  type SecretCipher,
} from '../../../src/main/services/secret-storage-policy'
import { replaceFileStrict, type StrictReplaceFs } from '../../../src/main/utils/atomic-json'

/** Stands for the process dying at that point: nothing after it runs. */
class ProcessDied extends Error {}

/** A reversible fake keychain cipher (`safe:` + base64 of reversed text). */
function fakeCipher(overrides: Partial<SecretCipher> = {}): SecretCipher & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    encrypt: (plain) => { calls.push('encrypt'); return 'safe:' + Buffer.from([...plain].reverse().join('')).toString('base64') },
    decrypt: (stored) => stored.startsWith('safe:') ? [...Buffer.from(stored.slice(5), 'base64').toString()].reverse().join('') : null,
    ...overrides,
  }
}

const PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow'
const OLD_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

/** A legacy keyring-less install: every secret plain text, next to ordinary settings that look secret-ish. */
function legacyPlaintext(): Record<string, unknown> {
  return {
    ownerDid: 'did:key:zOwner',
    runtimeDid: 'did:key:zRuntime',
    runtimeEncPublicKey: 'cHVibGlj',
    runtimeDelegation: { issuer: 'did:key:zOwner', subject: 'did:key:zRuntime', signature: 'sig' },
    ownerMnemonic: PHRASE,
    'ownerMnemonicSuperseded:did:key:zOld': OLD_PHRASE,
    runtimePrivateKey: 'cnVudGltZS1zaWduaW5n',
    runtimeEncPrivateKey: 'cnVudGltZS1lbmM=',
    mcpOauthCredentials: JSON.stringify({ 'https://mcp.example': { tokens: { access_token: 'at' } } }),
    // Ordinary settings: never treated as Studio secrets, whatever they hold.
    providers: [{ id: 'anthropic', type: 'anthropic', name: 'Anthropic', baseUrl: '', apiKey: 'sk-ant-plain' }],
    mcpServers: [{ id: 'm', name: 'm', env: [{ key: 'TOKEN', value: 'tok' }] }],
    apiKeyHint: 'secret-looking string',
    theme: 'dark',
  }
}

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'adf-secret-policy-'))
  path = join(dir, 'adf-settings.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const write = (data: unknown) => writeFileSync(path, JSON.stringify(data, null, 2))
const readText = () => readFileSync(path, 'utf-8')
const read = () => JSON.parse(readText()) as Record<string, unknown>

describe('secret inventory', () => {
  it('lists exactly the setSecret keys, including every superseded owner copy, and no ordinary setting', () => {
    const inv = secretInventory(legacyPlaintext())
    expect(inv.plaintext.sort()).toEqual(['mcpOauthCredentials', 'ownerMnemonic', 'ownerMnemonicSuperseded:did:key:zOld', 'runtimeEncPrivateKey', 'runtimePrivateKey'])
    expect(inv.encrypted).toEqual([])
    for (const key of ['providers', 'mcpServers', 'apiKeyHint', 'ownerDid', 'runtimeEncPublicKey', 'runtimeDelegation', SECRET_STORAGE_POLICY_KEY]) {
      expect(isSecretSettingsKey(key)).toBe(false)
    }
  })

  it('tells ciphertext from plain text and flags values setSecret never writes', () => {
    const inv = secretInventory({ ownerMnemonic: 'safe:abc', runtimePrivateKey: 'plain', runtimeEncPrivateKey: 42, mcpOauthCredentials: null })
    expect(inv).toEqual({ encrypted: ['ownerMnemonic'], plaintext: ['runtimePrivateKey'], unexpected: ['runtimeEncPrivateKey'] })
  })
})

describe('write refusal and the launch question', () => {
  it('refuses secret writes only when the keychain is chosen (or nothing is) and unusable', () => {
    expect(secretWriteRefusal(null, true)).toBeNull()
    expect(secretWriteRefusal('keyring', true)).toBeNull()
    expect(secretWriteRefusal('plaintext', false)).toBeNull()
    expect(secretWriteRefusal(null, false)).toMatch(/keychain is not available/)
    expect(secretWriteRefusal('keyring', false)).toMatch(/keychain is not available/)
  })

  it('asks a fresh install with no keychain; never one with a keychain and nothing unencrypted', () => {
    expect(launchChoice({}, false, { writesSecrets: true })).toMatchObject({ reason: 'no-keyring', keyringChosenBefore: false })
    expect(launchChoice({}, true, { writesSecrets: true })).toBeNull()
    // Local mode: the daemon stores the secrets; Studio writes none of its own.
    expect(launchChoice({}, false, { writesSecrets: false })).toBeNull()
  })

  it('asks about plain-text secrets with no saved choice even while the keychain works', () => {
    expect(launchChoice(legacyPlaintext(), true, { writesSecrets: true })).toMatchObject({ reason: 'plaintext-found', plaintextSecrets: 5, keyringAvailable: true })
    expect(launchChoice(legacyPlaintext(), true, { writesSecrets: false })).toMatchObject({ reason: 'plaintext-found' })
    // A saved 'keyring' choice does not make leftover plain text silently acceptable either.
    expect(launchChoice({ ...legacyPlaintext(), [SECRET_STORAGE_POLICY_KEY]: 'keyring' }, true, { writesSecrets: true })).toMatchObject({ reason: 'plaintext-found' })
  })

  it('never asks again once plain text was chosen, even with a working keychain', () => {
    expect(launchChoice({ ...legacyPlaintext(), [SECRET_STORAGE_POLICY_KEY]: 'plaintext' }, true, { writesSecrets: true })).toBeNull()
    expect(launchChoice({ [SECRET_STORAGE_POLICY_KEY]: 'plaintext' }, false, { writesSecrets: true })).toBeNull()
  })

  it('a keychain chosen before (saved, or ciphertext on disk) that is gone now can be continued without', () => {
    expect(launchChoice({ ownerMnemonic: 'safe:x' }, false, { writesSecrets: true })).toMatchObject({ reason: 'no-keyring', keyringChosenBefore: true })
    expect(launchChoice({ [SECRET_STORAGE_POLICY_KEY]: 'keyring' }, false, { writesSecrets: true })).toMatchObject({ keyringChosenBefore: true })
  })

  it('the Settings view keeps showing the plain-text choice while the keychain works', () => {
    expect(secretStorageView({ [SECRET_STORAGE_POLICY_KEY]: 'plaintext', ownerMnemonic: PHRASE }, true))
      .toMatchObject({ policy: 'plaintext', keyringAvailable: true, plaintextSecrets: 1, writesBlocked: false })
    expect(secretStorageView({ ownerMnemonic: 'safe:x' }, false))
      .toMatchObject({ policy: 'keyring', keyringAvailable: false, plaintextSecrets: 0, writesBlocked: true })
  })
})

describe('choosePlaintextStorage', () => {
  it('saves only the choice: ciphertext stays ciphertext, everything else byte-for-byte the same data', () => {
    const before = { ...legacyPlaintext(), runtimePrivateKey: 'safe:c2VjcmV0' }
    write(before)
    const result = choosePlaintextStorage(path)
    expect(result.ok).toBe(true)
    expect(read()).toEqual({ ...before, [SECRET_STORAGE_POLICY_KEY]: 'plaintext' })
  })

  it('works on a fresh install with no settings file yet', () => {
    expect(choosePlaintextStorage(path).ok).toBe(true)
    expect(read()).toEqual({ [SECRET_STORAGE_POLICY_KEY]: 'plaintext' })
  })

  it('refuses a corrupt settings file and leaves it alone', () => {
    writeFileSync(path, '{"ownerMnemonic": "x",')
    const result = choosePlaintextStorage(path)
    expect(result).toEqual({ ok: false, error: 'The settings file is not valid JSON. Nothing was changed.' })
    expect(readText()).toBe('{"ownerMnemonic": "x",')
  })
})

describe('chooseKeyringStorage (the switch back, and Encrypt with Keychain at launch)', () => {
  it('encrypts every plain-text secret in one write, keeps every value and the identity, and saves the choice', () => {
    const before = { ...legacyPlaintext(), 'ownerMnemonicSuperseded:did:key:zOlder': 'safe:YWxyZWFkeQ==' }
    write(before)
    const cipher = fakeCipher()
    const result = chooseKeyringStorage(path, cipher, true)
    expect(result).toMatchObject({ ok: true, encrypted: 5 })
    const after = read()
    expect(after[SECRET_STORAGE_POLICY_KEY]).toBe('keyring')
    for (const key of ['ownerMnemonic', 'ownerMnemonicSuperseded:did:key:zOld', 'runtimePrivateKey', 'runtimeEncPrivateKey', 'mcpOauthCredentials']) {
      expect(after[key]).toMatch(/^safe:/)
      expect(cipher.decrypt(after[key] as string)).toBe(before[key as keyof typeof before])
    }
    // Already encrypted: untouched, not re-encrypted.
    expect(after['ownerMnemonicSuperseded:did:key:zOlder']).toBe('safe:YWxyZWFkeQ==')
    // Identity and ordinary settings (provider keys, MCP env) exactly as they were.
    for (const key of ['ownerDid', 'runtimeDid', 'runtimeEncPublicKey', 'runtimeDelegation', 'providers', 'mcpServers', 'apiKeyHint', 'theme']) {
      expect(after[key]).toEqual(before[key as keyof typeof before])
    }
    expect(Object.keys(after).sort()).toEqual([...Object.keys(before), SECRET_STORAGE_POLICY_KEY].sort())
    expect(secretInventory(after).plaintext).toEqual([])
  })

  it('without a usable keychain changes nothing', () => {
    write(legacyPlaintext())
    const text = readText()
    expect(chooseKeyringStorage(path, fakeCipher(), false)).toEqual({ ok: false, error: 'The OS keychain is not available. Nothing was changed.' })
    expect(readText()).toBe(text)
  })

  it('an encryption failure part-way writes nothing', () => {
    write(legacyPlaintext())
    const text = readText()
    let n = 0
    const real = fakeCipher()
    const cipher = fakeCipher({ encrypt: (plain) => { if (++n === 3) throw new Error('keychain locked'); return real.encrypt(plain) } })
    const result = chooseKeyringStorage(path, cipher, true)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toMatch(/could not be encrypted with the OS keychain\. Nothing was changed\.$/)
    expect(readText()).toBe(text)
  })

  it('a value that does not decrypt back to itself before the write writes nothing', () => {
    write(legacyPlaintext())
    const text = readText()
    const cipher = fakeCipher({ decrypt: () => 'something else' })
    const result = chooseKeyringStorage(path, cipher, true)
    expect(!result.ok && result.error).toMatch(/did not decrypt back to its value/)
    expect(readText()).toBe(text)
  })

  it('a value setSecret never writes (not a string) stops the switch before anything is written', () => {
    write({ ...legacyPlaintext(), runtimeEncPrivateKey: { unexpected: true } })
    const text = readText()
    const result = chooseKeyringStorage(path, fakeCipher(), true)
    expect(!result.ok && result.error).toMatch(/runtimeEncPrivateKey in the settings file is not a stored secret/)
    expect(readText()).toBe(text)
  })

  // --- The swap: rename only, never an in-place overwrite (atomic-json replaceFileStrict) ---

  /** The settings file's exact bytes, and that no temp file is left beside it. */
  const bytes = () => readFileSync(path)
  const leftovers = () => readdirSync(dir).filter((n) => n.endsWith('.tmp'))

  for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
    it(`a destination held open (${code} on every rename attempt) keeps the exact previous bytes; nothing is overwritten in place`, () => {
      write(legacyPlaintext())
      const original = bytes()
      let renames = 0
      const fsSeam: Partial<StrictReplaceFs> = {
        rename: () => { renames++; throw Object.assign(new Error('locked'), { code }) },
      }
      const result = chooseKeyringStorage(path, fakeCipher(), true, { readText: (p) => readFileSync(p, 'utf-8'), fs: fsSeam })
      expect(result).toEqual({ ok: false, error: `The file could not be replaced (${code}); it was left as it was. Nothing was changed.` })
      expect(renames).toBe(3)
      expect(bytes().equals(original)).toBe(true)
      expect(leftovers()).toEqual([])
    })
  }

  it('a temp file that does not read back as written is never swapped in', () => {
    write(legacyPlaintext())
    const original = bytes()
    const result = chooseKeyringStorage(path, fakeCipher(), true, {
      readText: (p) => readFileSync(p, 'utf-8'),
      fs: { read: (p) => (p.endsWith('.tmp') ? '{"truncated":' : readFileSync(p, 'utf-8')) },
    })
    expect(!result.ok && result.error).toBe('The new file did not read back as written. Nothing was changed.')
    expect(bytes().equals(original)).toBe(true)
    expect(leftovers()).toEqual([])
  })

  it('a temp write that fails part-way (disk full) leaves the previous bytes', () => {
    write(legacyPlaintext())
    const original = bytes()
    const result = chooseKeyringStorage(path, fakeCipher(), true, {
      readText: (p) => readFileSync(p, 'utf-8'),
      fs: { writeTemp: (p, text) => { writeFileSync(p, text.slice(0, 40)); throw Object.assign(new Error('full'), { code: 'ENOSPC' }) } },
    })
    expect(!result.ok && result.error).toBe('The new file could not be written (ENOSPC). Nothing was changed.')
    expect(bytes().equals(original)).toBe(true)
    expect(leftovers()).toEqual([])
  })

  // Crash boundaries: what a process killed at that instant leaves on disk, captured at that instant.
  it('a crash at any point before the rename leaves the exact previous bytes', () => {
    write(legacyPlaintext())
    const original = bytes()
    const atCrash: Buffer[] = []
    const result = chooseKeyringStorage(path, fakeCipher(), true, {
      readText: (p) => readFileSync(p, 'utf-8'),
      fs: {
        writeTemp: (p, text, mode) => { atCrash.push(bytes()); writeFileSync(p, text.slice(0, 10), { mode }); atCrash.push(bytes()); writeFileSync(p, text, { mode }) },
        rename: (from, to) => { atCrash.push(bytes()); renameSync(from, to) },
      },
    })
    expect(result.ok).toBe(true)
    expect(atCrash).toHaveLength(3)
    for (const snapshot of atCrash) expect(snapshot.equals(original)).toBe(true)
  })

  it('a crash right after the rename leaves the whole new file: every secret decrypts to its old value', () => {
    write(legacyPlaintext())
    const before = read()
    const cipher = fakeCipher()
    let atCrash: Record<string, unknown> | null = null
    const result = chooseKeyringStorage(path, cipher, true, {
      readText: (p) => readFileSync(p, 'utf-8'),
      fs: { syncDir: () => { atCrash = read(); throw new ProcessDied() } },
    })
    // A failed directory sync after the swap is not reported as "nothing changed": the switch happened.
    expect(result).toMatchObject({ ok: true, encrypted: 5 })
    const onDisk = atCrash as unknown as Record<string, unknown>
    expect(onDisk[SECRET_STORAGE_POLICY_KEY]).toBe('keyring')
    for (const key of secretInventory(before).plaintext) expect(cipher.decrypt(onDisk[key] as string)).toBe(before[key])
    expect(onDisk.ownerDid).toBe(before.ownerDid)
  })

  it('a write by another process during the switch is kept: the switch is rebuilt on the new content, not overwritten', () => {
    write(legacyPlaintext())
    const cipher = fakeCipher()
    let raced = false
    const result = chooseKeyringStorage(path, cipher, true, {
      readText: (p) => readFileSync(p, 'utf-8'),
      fs: {
        // The daemon writes the file after Studio read it, before Studio's swap.
        writeTemp: (p, text, mode) => {
          if (!raced) { raced = true; write({ ...read(), theme: 'light', trackedDirectories: ['/agents'] }) }
          writeFileSync(p, text, { mode })
        },
      },
    })
    expect(result).toMatchObject({ ok: true, encrypted: 5 })
    const onDisk = read()
    expect(onDisk.theme).toBe('light')
    expect(onDisk.trackedDirectories).toEqual(['/agents'])
    expect(cipher.decrypt(onDisk.ownerMnemonic as string)).toBe(PHRASE)
  })

  it('a write by another process while a locked rename waits to retry is kept, not overwritten by the retry', () => {
    write(legacyPlaintext())
    const cipher = fakeCipher()
    let renames = 0
    const result = chooseKeyringStorage(path, cipher, true, {
      readText: (p) => readFileSync(p, 'utf-8'),
      fs: {
        // First rename: destination held open (Windows), and the daemon writes during the backoff.
        rename: (from, to) => {
          if (++renames === 1) {
            write({ ...read(), theme: 'light', trackedDirectories: ['/agents'] })
            throw Object.assign(new Error('locked'), { code: 'EBUSY' })
          }
          renameSync(from, to)
        },
      },
    })
    expect(result).toMatchObject({ ok: true, encrypted: 5 })
    // The retry saw the change and aborted; the rebuilt transaction renamed once.
    expect(renames).toBe(2)
    const onDisk = read()
    expect(onDisk.theme).toBe('light')
    expect(onDisk.trackedDirectories).toEqual(['/agents'])
    expect(onDisk[SECRET_STORAGE_POLICY_KEY]).toBe('keyring')
    expect(cipher.decrypt(onDisk.ownerMnemonic as string)).toBe(PHRASE)
    expect(onDisk.ownerDid).toBe('did:key:zOwner')
    expect(leftovers()).toEqual([])
  })

  it('replaceFileStrict treats a throwing unchanged() check as changed: the file is untouched and the temp file removed', () => {
    write(legacyPlaintext())
    const original = bytes()
    let renames = 0
    expect(() => replaceFileStrict(path, '{"replaced":true}', {
      unchanged: () => { throw new Error('read failed') },
      fs: { rename: () => { renames++ } },
    })).toThrow(expect.objectContaining({ name: 'StrictReplaceError', reason: 'changed' }))
    expect(renames).toBe(0)
    expect(bytes().equals(original)).toBe(true)
    expect(leftovers()).toEqual([])
  })

  it('a file that never stops changing fails safely, unchanged by Studio', () => {
    write(legacyPlaintext())
    let n = 0
    const result = chooseKeyringStorage(path, fakeCipher(), true, {
      readText: (p) => readFileSync(p, 'utf-8'),
      fs: { writeTemp: (p, text, mode) => { write({ ...read(), counter: ++n }); writeFileSync(p, text, { mode }) } },
    })
    expect(!result.ok && result.error).toBe('The settings file kept changing while Studio updated it. Nothing was changed; try again.')
    expect(read().counter).toBe(5)
    expect(read().ownerMnemonic).toBe(PHRASE)
    expect(leftovers()).toEqual([])
  })

  it('the plain-text choice uses the same strict swap', () => {
    write(legacyPlaintext())
    const original = bytes()
    const result = choosePlaintextStorage(path, { readText: (p) => readFileSync(p, 'utf-8'), fs: { rename: () => { throw Object.assign(new Error('x'), { code: 'EBUSY' }) } } })
    expect(result.ok).toBe(false)
    expect(bytes().equals(original)).toBe(true)
  })

  it('error messages never carry a secret value', () => {
    write(legacyPlaintext())
    const results = [
      chooseKeyringStorage(path, fakeCipher({ encrypt: () => { throw new Error(PHRASE) } }), true),
      chooseKeyringStorage(path, fakeCipher({ decrypt: () => PHRASE + 'x' }), true),
    ]
    for (const r of results) {
      expect(r.ok).toBe(false)
      expect(JSON.stringify(r)).not.toContain('legal winner')
      expect(JSON.stringify(r)).not.toContain('cnVudGltZS1zaWduaW5n')
    }
  })
})
