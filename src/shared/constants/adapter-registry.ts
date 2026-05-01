/**
 * Curated registry of well-known channel adapters.
 * Used by the adapter dashboard for quick install and by the first-open modal.
 */

import type { AdapterRegistration, AdaptersConfig, AdapterInstanceConfig } from '../types/channel-adapter.types'

export interface AdapterRegistryEntry {
  /** Short identifier used as adapter type key */
  type: string
  /** Human-readable display name */
  displayName: string
  /** npm package name (not needed for built-in adapters) */
  npmPackage?: string
  /** Whether this adapter is built into the app (no npm install needed) */
  builtIn?: boolean
  /** Description of what the adapter provides */
  description: string
  /** Required credential keys (stored in adf_identity) */
  requiredEnvKeys: string[]
  /** Optional credential keys */
  optionalEnvKeys?: string[]
  /** Repository/docs URL */
  repo?: string
  /** Whether this is a verified/recommended adapter */
  verified: boolean
}

export const ADAPTER_REGISTRY: AdapterRegistryEntry[] = [
  {
    type: 'telegram',
    displayName: 'Telegram',
    builtIn: true,
    description: 'Receive and send Telegram messages via a bot token',
    requiredEnvKeys: ['TELEGRAM_BOT_TOKEN'],
    verified: true
  },
  {
    type: 'email',
    displayName: 'Email',
    builtIn: true,
    description: 'Send and receive email via IMAP/SMTP',
    requiredEnvKeys: ['EMAIL_USERNAME', 'EMAIL_PASSWORD'],
    verified: true
  }
]

const BUILT_IN_ADAPTER_REGISTRATIONS: AdapterRegistration[] = ADAPTER_REGISTRY
  .filter((entry) => entry.builtIn)
  .map((entry) => ({
    id: entry.type,
    type: entry.type,
    managed: false
  }))

/**
 * Return app/runtime adapter registrations with built-in adapters always present.
 *
 * User-provided registrations for the same type win, so app-level credentials,
 * package metadata, and storage preferences are preserved.
 */
export function withBuiltInAdapterRegistrations(
  registrations?: AdapterRegistration[] | null,
): AdapterRegistration[] {
  const builtInsByType = new Map(BUILT_IN_ADAPTER_REGISTRATIONS.map((entry) => [entry.type, entry]))
  const seenTypes = new Set<string>()
  const merged: AdapterRegistration[] = []

  for (const registration of registrations ?? []) {
    const builtIn = builtInsByType.get(registration.type)
    merged.push(builtIn ? { ...builtIn, ...registration } : { ...registration })
    seenTypes.add(registration.type)
  }

  for (const builtIn of BUILT_IN_ADAPTER_REGISTRATIONS) {
    if (!seenTypes.has(builtIn.type)) {
      merged.push({ ...builtIn })
    }
  }

  return merged
}

/**
 * Look up a registry entry by adapter type.
 */
export function findAdapterRegistryEntry(type: string): AdapterRegistryEntry | undefined {
  return ADAPTER_REGISTRY.find((e) => e.type === type)
}

/**
 * Look up a registry entry by npm package name.
 */
export function findAdapterRegistryEntryByPackage(npmPackage: string): AdapterRegistryEntry | undefined {
  return ADAPTER_REGISTRY.find((e) => e.npmPackage === npmPackage)
}

/**
 * Return the per-agent adapter config only when the agent explicitly enables it.
 *
 * Runtime registrations make adapters available globally, but they must not
 * auto-start for every agent just because the adapter exists in app settings.
 */
export function getEnabledAgentAdapterConfig(
  adapters: AdaptersConfig | undefined,
  type: string,
): AdapterInstanceConfig | null {
  const config = adapters?.[type]
  return config?.enabled === true ? config : null
}
