/**
 * API keys of app-level model providers added through the daemon, kept in the
 * daemon's secret store (the OS keychain, or the owner's passphrase-protected
 * file on machines without one) instead of the settings JSON.
 *
 * The settings entry carries `apiKeyStorage: 'secret-store'` and an empty
 * `apiKey`; FileSettingsStore fills the key back in on read, so every daemon
 * code path (provider factory, model listing, diagnostics) sees an ordinary
 * provider. Values are never logged.
 */

import type { SecretBackend } from '../services/owner-secret-store'
import { providerKeyAccount } from '../services/provider-key-store'

// Naming lives in provider-key-store.ts so Studio resolves the same entries.
export { SECRET_STORE_KEY_STORAGE } from '../services/provider-key-store'

export interface ProviderKeyVault {
  /** False while the store is locked (a passphrase file not unlocked yet, or none created). */
  available(): boolean
  get(providerId: string): string | null
  set(providerId: string, value: string): void
  delete(providerId: string): void
}

export class ProviderKeyVaultLockedError extends Error {
  readonly code = 'secret_store_locked'
  constructor() {
    super('The daemon secret store is locked: set up or unlock the owner identity first (it holds provider keys on machines without an OS keychain).')
    this.name = 'ProviderKeyVaultLockedError'
  }
}

/**
 * `scope` keeps two daemons with different settings files apart in one
 * keychain: settingsScope(settingsPath) from provider-key-store.ts (same hash
 * as the daemon runtime key account).
 */
export class SecretBackendProviderKeyVault implements ProviderKeyVault {
  private readonly cache = new Map<string, string | null>()

  constructor(private readonly backend: SecretBackend, private readonly scope: string) {}

  private account(providerId: string): string {
    return providerKeyAccount(this.scope, providerId)
  }

  available(): boolean {
    return this.backend.isUnlocked()
  }

  get(providerId: string): string | null {
    if (!this.backend.isUnlocked()) return null
    if (this.cache.has(providerId)) return this.cache.get(providerId) ?? null
    let value: string | null = null
    try {
      value = this.backend.get(this.account(providerId))
    } catch {
      return null
    }
    this.cache.set(providerId, value)
    return value
  }

  set(providerId: string, value: string): void {
    if (!this.backend.isUnlocked()) throw new ProviderKeyVaultLockedError()
    this.backend.set(this.account(providerId), value)
    this.cache.set(providerId, value)
  }

  delete(providerId: string): void {
    this.cache.delete(providerId)
    if (!this.backend.isUnlocked()) return
    this.backend.delete(this.account(providerId))
  }
}

/** In-memory vault (tests). */
export class MemoryProviderKeyVault implements ProviderKeyVault {
  readonly values = new Map<string, string>()
  constructor(private unlocked = true) {}
  setUnlocked(on: boolean): void { this.unlocked = on }
  available(): boolean { return this.unlocked }
  get(providerId: string): string | null { return this.unlocked ? this.values.get(providerId) ?? null : null }
  set(providerId: string, value: string): void {
    if (!this.unlocked) throw new ProviderKeyVaultLockedError()
    this.values.set(providerId, value)
  }
  delete(providerId: string): void { this.values.delete(providerId) }
}
