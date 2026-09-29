/**
 * Shared naming for app-level provider API keys kept in a secret store
 * instead of adf-settings.json (`apiKeyStorage: 'secret-store'`, empty
 * `apiKey` in the file). The daemon (provider-key-vault.ts) and Studio
 * (SettingsService) both derive the keychain account from here, so a key
 * added from the terminal app resolves in Studio and vice versa.
 *
 * Electron-free; never logs secret values.
 */

import { createHash } from 'crypto'
import { resolve } from 'path'
import { openKeychainBackend, type SecretBackend } from './owner-secret-store'

export const SECRET_STORE_KEY_STORAGE = 'secret-store' as const

/**
 * Keychain scope of one settings file: two installs with different settings
 * files stay apart in one keychain. Same hash as the daemon runtime key
 * account (daemon-identity.ts) — changing it orphans stored keys.
 */
export function settingsScope(settingsPath: string): string {
  return createHash('sha256').update(resolve(settingsPath)).digest('hex').slice(0, 12)
}

/** Keychain account of one provider's API key under a settings scope. */
export function providerKeyAccount(scope: string, providerId: string): string {
  return `provider-api-key:${scope}:${providerId}`
}

/**
 * Why a secret-store provider has no key on this side (reads only, never
 * persisted): 'unavailable' = no usable OS keychain here; 'missing' = the
 * keychain works but holds no key for this provider (e.g. the daemon keeps it
 * in its passphrase file on a machine without a keychain, or it was removed).
 */
export type ProviderKeyStatus = 'unavailable' | 'missing'

/** A miss is re-checked after this long, so a key added from the terminal app shows up without a restart. */
const MISS_TTL_MS = 30_000

/**
 * Studio's read/write handle on the OS-keychain provider keys. The keychain is
 * opened lazily (a sync N-API probe) on first use and found keys are cached
 * for the process (misses for MISS_TTL_MS), so hot paths rarely touch the
 * keychain.
 */
export class KeychainProviderKeys {
  private backend: SecretBackend | null | undefined
  private readonly cache = new Map<string, { value: string | null; at: number }>()

  constructor(
    private readonly settingsPath: () => string,
    private readonly openBackend: () => SecretBackend | null = openKeychainBackend,
    private readonly now: () => number = Date.now,
  ) {}

  private store(): SecretBackend | null {
    if (this.backend === undefined) {
      try {
        this.backend = this.openBackend()
      } catch {
        this.backend = null
      }
    }
    return this.backend
  }

  private account(providerId: string): string {
    return providerKeyAccount(settingsScope(this.settingsPath()), providerId)
  }

  available(): boolean {
    return this.store() !== null
  }

  get(providerId: string): string | null {
    const backend = this.store()
    if (!backend) return null
    const hit = this.cache.get(providerId)
    if (hit && (hit.value !== null || this.now() - hit.at < MISS_TTL_MS)) return hit.value
    let value: string | null = null
    try {
      value = backend.get(this.account(providerId)) || null
    } catch {
      return null
    }
    this.cache.set(providerId, { value, at: this.now() })
    return value
  }

  /** False when no keychain is usable or the write failed (the key is then NOT stored anywhere). */
  set(providerId: string, value: string): boolean {
    const backend = this.store()
    if (!backend) return false
    try {
      backend.set(this.account(providerId), value)
    } catch {
      this.cache.delete(providerId)
      return false
    }
    this.cache.set(providerId, { value, at: this.now() })
    return true
  }
}
