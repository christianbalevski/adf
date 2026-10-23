import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { replaceFileStrict, StrictReplaceError, type StrictReplaceFs } from '../utils/atomic-json'
import type { SecretStoragePolicy, SecretStorageView } from '../../shared/types/secret-storage.types'

export type { SecretStoragePolicy, SecretStorageView }

/**
 * How ADF Studio stores its own secrets in `adf-settings.json`, and the one
 * place that changes it (docs/daemon/owner-secret-storage.md, "ADF Studio").
 *
 * The secrets are exactly SETTINGS_SECRET_KEYS plus every
 * `ownerMnemonicSuperseded:<owner DID>` copy: the only keys
 * SettingsService.setSecret writes. Nothing is guessed from key names or
 * values. Provider API keys and MCP server env/headers are ordinary settings
 * the daemon reads as plain JSON; they are not covered here.
 *
 * The policy is the user's choice, saved under SECRET_STORAGE_POLICY_KEY:
 * - `keyring` (or nothing saved): encrypted with the OS keychain through
 *   Electron safeStorage. With no usable keychain, nothing is written.
 * - `plaintext`: the user explicitly agreed, after a warning, to store these
 *   secrets unencrypted on this computer. New writes are plain text; values
 *   already encrypted stay encrypted.
 * Whether the keychain works right now is checked separately and never
 * changes the saved policy.
 */

export const SECRET_STORAGE_POLICY_KEY = 'secretStoragePolicy'

/** Marks a value encrypted with Electron safeStorage. */
export const SAFE_STORAGE_PREFIX = 'safe:'

/** Studio's secret settings keys. Also the HTTP deny-list (daemon/http-api.ts). */
export const SETTINGS_SECRET_KEYS: readonly string[] = ['ownerMnemonic', 'runtimePrivateKey', 'runtimeEncPrivateKey', 'mcpOauthCredentials']
/** Previous owners' phrases kept after an owner switch: `ownerMnemonicSuperseded:<did>`. */
export const SUPERSEDED_MNEMONIC_PREFIX = 'ownerMnemonicSuperseded:'

export function isSecretSettingsKey(key: string): boolean {
  return SETTINGS_SECRET_KEYS.includes(key) || key.startsWith(SUPERSEDED_MNEMONIC_PREFIX)
}

export function savedSecretStoragePolicy(data: Record<string, unknown>): SecretStoragePolicy | null {
  const value = data[SECRET_STORAGE_POLICY_KEY]
  return value === 'keyring' || value === 'plaintext' ? value : null
}

/** safeStorage ciphertext vs plain text, by key. Values never leave this function. */
export interface SecretInventory {
  encrypted: string[]
  plaintext: string[]
  /** Neither a string nor absent: never written by setSecret. Migration refuses to touch the file. */
  unexpected: string[]
}

export function secretInventory(data: Record<string, unknown>): SecretInventory {
  const inventory: SecretInventory = { encrypted: [], plaintext: [], unexpected: [] }
  for (const key of Object.keys(data)) {
    if (!isSecretSettingsKey(key)) continue
    const value = data[key]
    if (value === undefined || value === null) continue
    if (typeof value !== 'string') inventory.unexpected.push(key)
    else if (value.startsWith(SAFE_STORAGE_PREFIX)) inventory.encrypted.push(key)
    else inventory.plaintext.push(key)
  }
  return inventory
}

/** A secret write refused by the saved secret-storage choice. Carries no value. */
export class SecretStorageRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SecretStorageRefusedError'
  }
}

/**
 * Why a secret cannot be written right now, or null when it can. A saved
 * `keyring` choice (or none) with no usable keychain refuses: the user never
 * agreed to plain text, and a keychain that is back later must find its
 * ciphertext untouched.
 */
export function secretWriteRefusal(policy: SecretStoragePolicy | null, keyring: boolean): string | null {
  if (policy === 'plaintext' || keyring) return null
  return 'The OS keychain is not available, and ADF Studio does not store secrets unencrypted unless you choose to. ' +
    'Unlock or set up your keychain and restart Studio, or choose unencrypted storage when Studio asks at launch.'
}

export function secretStorageView(data: Record<string, unknown>, keyring: boolean, scope: SecretStorageView['scope'] = 'inside-studio'): SecretStorageView {
  const policy = savedSecretStoragePolicy(data) ?? 'keyring'
  const inventory = secretInventory(data)
  return {
    policy,
    keyringAvailable: keyring,
    plaintextSecrets: inventory.plaintext.length,
    writesBlocked: scope === 'inside-studio' && secretWriteRefusal(policy, keyring) !== null,
    storedSecrets: inventory.plaintext.length + inventory.encrypted.length + inventory.unexpected.length,
    scope,
  }
}

/** What Studio must ask at launch, or null when nothing. */
export interface LaunchChoice {
  /** `plaintext-found`: secrets stored unencrypted without a saved choice. `no-keyring`: nothing could be saved. */
  reason: 'plaintext-found' | 'no-keyring'
  keyringAvailable: boolean
  plaintextSecrets: number
  /**
   * The keychain was chosen before (saved, or secrets already encrypted with
   * it): Studio may also run without it, writing no secrets until it is back.
   */
  keyringChosenBefore: boolean
}

/**
 * Asked whenever no explicit `plaintext` choice is saved and either secrets
 * are stored unencrypted (even with a working keychain: changing them is the
 * user's call) or Studio will need to save secrets with no keychain to do it.
 * A saved `plaintext` choice is never asked again, even once a keychain
 * works: Settings → Identity offers the switch back.
 */
export function launchChoice(data: Record<string, unknown>, keyring: boolean, opts: { writesSecrets: boolean }): LaunchChoice | null {
  const policy = savedSecretStoragePolicy(data)
  if (policy === 'plaintext') return null
  const inventory = secretInventory(data)
  const base = {
    keyringAvailable: keyring,
    plaintextSecrets: inventory.plaintext.length,
    keyringChosenBefore: policy === 'keyring' || inventory.encrypted.length > 0,
  }
  if (inventory.plaintext.length > 0) return { reason: 'plaintext-found', ...base }
  if (!keyring && opts.writesSecrets) return { reason: 'no-keyring', ...base }
  return null
}

// --- Changing the policy -----------------------------------------------------------

/** safeStorage as a `safe:` codec. decrypt returns null when unreadable. */
export interface SecretCipher {
  encrypt(plain: string): string
  decrypt(stored: string): string | null
}

/** File access: reads, and the swap's file operations (fault-injection seams for tests). */
export interface PolicyFileIo {
  readText(path: string): string
  fs?: Partial<StrictReplaceFs>
}

const defaultIo: PolicyFileIo = {
  readText: (path) => readFileSync(path, 'utf-8'),
}

export type PolicyChangeResult =
  | { ok: true; data: Record<string, unknown>; encrypted: number }
  | { ok: false; error: string }

/** The file's exact text ('' when it does not exist yet). */
function readText(path: string, io: PolicyFileIo): string {
  try {
    return io.readText(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw err
  }
}

function readSettings(path: string, io: PolicyFileIo): { text: string; data: Record<string, unknown> } | { error: string } {
  let text: string
  try {
    text = readText(path, io)
  } catch (err) {
    return { error: `The settings file could not be read (${(err as NodeJS.ErrnoException).code ?? 'read error'}).` }
  }
  if (text === '') return { text, data: {} }
  try {
    const data = JSON.parse(text) as unknown
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { error: 'The settings file is not a JSON object.' }
    return { text, data: data as Record<string, unknown> }
  } catch {
    return { error: 'The settings file is not valid JSON.' }
  }
}

/** Reads and swaps before giving up on a file another writer keeps changing. */
const TRANSACTION_ATTEMPTS = 5

/**
 * One change of the settings file that must never lose data:
 * 1. read the exact bytes and build the complete new content in memory;
 * 2. `check` it (as parsed back from the text that will be written) before
 *    anything touches the disk;
 * 3. replaceFileStrict: write and sync a temp file, compare it byte for byte,
 *    and rename it over the file only if the file still holds the bytes read
 *    in step 1. Never an in-place overwrite, so the previous file is either
 *    whole or replaced by the whole verified new one, at any crash point.
 * A write by another process meanwhile (the daemon shares this file),
 * including during a rename retry backoff, makes the swap abort, and the
 * change is rebuilt from the new content, so that write is kept, not
 * overwritten. There is no OS file lock: a write landing between the final
 * byte check and rename() itself (two consecutive syscalls) can still be
 * replaced. Every failure leaves the file untouched.
 */
function transact(
  path: string,
  io: PolicyFileIo,
  build: (data: Record<string, unknown>) => { next: Record<string, unknown>; encrypted: number } | { error: string },
  check: (candidate: Record<string, unknown>, before: Record<string, unknown>) => string | null,
): PolicyChangeResult {
  for (let attempt = 0; attempt < TRANSACTION_ATTEMPTS; attempt++) {
    const before = readSettings(path, io)
    if ('error' in before) return { ok: false, error: `${before.error} Nothing was changed.` }
    const built = build(before.data)
    if ('error' in built) return { ok: false, error: `${built.error} Nothing was changed.` }
    const text = JSON.stringify(built.next, null, 2)
    const problem = check(JSON.parse(text) as Record<string, unknown>, before.data)
    if (problem) return { ok: false, error: `${problem} Nothing was changed.` }
    try {
      replaceFileStrict(path, text, {
        unchanged: () => { try { return readText(path, io) === before.text } catch { return false } },
        ...(io.fs ? { fs: io.fs } : {}),
      })
      return { ok: true, data: built.next, encrypted: built.encrypted }
    } catch (err) {
      if (err instanceof StrictReplaceError && err.reason === 'changed') continue
      const message = err instanceof StrictReplaceError ? err.message : 'The settings file could not be replaced.'
      return { ok: false, error: `${message} Nothing was changed.` }
    }
  }
  return { ok: false, error: 'The settings file kept changing while Studio updated it. Nothing was changed; try again.' }
}

/** Every key but the policy is exactly what it was. */
function othersUnchanged(candidate: Record<string, unknown>, before: Record<string, unknown>, changed: readonly string[]): boolean {
  const strip = (data: Record<string, unknown>) => {
    const copy = { ...data }
    delete copy[SECRET_STORAGE_POLICY_KEY]
    for (const key of changed) delete copy[key]
    return copy
  }
  return isDeepStrictEqual(strip(candidate), strip(before))
}

/**
 * Store secrets unencrypted from now on: only the policy changes. Values
 * already encrypted stay encrypted (they still open with the keychain).
 */
export function choosePlaintextStorage(path: string, io: PolicyFileIo = defaultIo): PolicyChangeResult {
  return transact(path, io,
    (data) => ({ next: { ...data, [SECRET_STORAGE_POLICY_KEY]: 'plaintext' }, encrypted: 0 }),
    (candidate, before) => (candidate[SECRET_STORAGE_POLICY_KEY] === 'plaintext' && othersUnchanged(candidate, before, []) ? null : 'The new settings did not hold the choice.'))
}

/**
 * Encrypt every plain-text secret with the keychain and save the `keyring`
 * choice, in one swap (transact). Before anything is written, each value is
 * encrypted and decrypted back from the exact text that will be written, and
 * every other key is compared. Values are only ever moved, never generated:
 * the owner and runtime identity stay what they were.
 */
export function chooseKeyringStorage(path: string, cipher: SecretCipher, keyring: boolean, io: PolicyFileIo = defaultIo): PolicyChangeResult {
  if (!keyring) return { ok: false, error: 'The OS keychain is not available. Nothing was changed.' }
  let migrated: string[] = []
  return transact(path, io,
    (data) => {
      const inventory = secretInventory(data)
      if (inventory.unexpected.length > 0) return { error: `${inventory.unexpected.join(', ')} in the settings file is not a stored secret Studio recognizes.` }
      const next: Record<string, unknown> = { ...data, [SECRET_STORAGE_POLICY_KEY]: 'keyring' }
      for (const key of inventory.plaintext) {
        try {
          next[key] = cipher.encrypt(data[key] as string)
        } catch {
          return { error: `${key} could not be encrypted with the OS keychain.` }
        }
      }
      migrated = inventory.plaintext
      return { next, encrypted: inventory.plaintext.length }
    },
    (candidate, before) => {
      for (const key of migrated) {
        const sealed = candidate[key]
        if (typeof sealed !== 'string' || !sealed.startsWith(SAFE_STORAGE_PREFIX) || cipher.decrypt(sealed) !== before[key]) {
          return `${key} did not decrypt back to its value with the OS keychain.`
        }
      }
      if (candidate[SECRET_STORAGE_POLICY_KEY] !== 'keyring' || !othersUnchanged(candidate, before, migrated)) return 'The new settings would change more than the secrets.'
      return null
    })
}
