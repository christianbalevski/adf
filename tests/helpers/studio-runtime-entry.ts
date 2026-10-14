/**
 * Test helpers for runtime adoption (design daemon-backend.md §5.3): an
 * in-memory OS keychain, and the `studio-runtime:<scope>` entry Studio main
 * writes on the switch to local mode (W4-A). Never touches the real keychain.
 */
import { KeychainSecretBackend, OWNER_MNEMONIC_ACCOUNT, type SharedMnemonicStore } from '../../src/main/services/owner-secret-store'
import { settingsScope } from '../../src/main/services/provider-key-store'
import {
  serializeStudioRuntimeEntry,
  studioRuntimeAccount,
  type StudioRuntimeEntryInput,
} from '../../src/main/daemon/studio-runtime-entry'
import type { AlfAttestation } from '../../src/shared/types/adf-v02.types'

/** One in-memory "OS keychain" shared by Studio and the daemon in a test. */
export function fakeKeychain() {
  const store = new Map<string, string>()
  class Entry {
    constructor(private service: string, private account: string) {}
    getPassword() { return store.get(`${this.service}/${this.account}`) ?? null }
    setPassword(p: string) { store.set(`${this.service}/${this.account}`, p) }
    deleteCredential() { return store.delete(`${this.service}/${this.account}`) }
  }
  const backend = new KeychainSecretBackend(Entry)
  const shared: SharedMnemonicStore = {
    read: () => backend.get(OWNER_MNEMONIC_ACCOUNT),
    write: (m) => backend.set(OWNER_MNEMONIC_ACCOUNT, m),
  }
  return { store, backend, shared }
}

/** The slice of Studio's SettingsService the entry is built from. */
export interface StudioRuntimeSource {
  get(key: string): unknown
  getSecret(key: string): string | null
}

/** The entry fields from Studio's settings, as W4-A copies them. */
export function studioRuntimeEntryFrom(studio: StudioRuntimeSource): StudioRuntimeEntryInput {
  const runtimePrivateKey = studio.getSecret('runtimePrivateKey')
  const runtimeEncPrivateKey = studio.getSecret('runtimeEncPrivateKey')
  if (!runtimePrivateKey || !runtimeEncPrivateKey) throw new Error('Studio has no runtime keys yet (call ensureIdentity first)')
  return {
    runtimeDid: studio.get('runtimeDid') as string,
    runtimeDelegation: studio.get('runtimeDelegation') as AlfAttestation,
    runtimePrivateKey,
    runtimeEncPrivateKey,
    runtimeEncPublicKey: studio.get('runtimeEncPublicKey') as string,
  }
}

/**
 * Write a valid `studio-runtime:<scope>` entry for `settingsPath` from
 * Studio's settings; `overrides` replaces fields (to forge invalid entries).
 * Returns the account name.
 */
export function writeStudioRuntimeEntry(
  keychain: { set(account: string, value: string): void },
  settingsPath: string,
  studio: StudioRuntimeSource,
  overrides: Partial<StudioRuntimeEntryInput> = {},
): string {
  const account = studioRuntimeAccount(settingsScope(settingsPath))
  keychain.set(account, serializeStudioRuntimeEntry({ ...studioRuntimeEntryFrom(studio), ...overrides }))
  return account
}
