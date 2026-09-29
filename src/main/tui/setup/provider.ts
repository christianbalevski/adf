// /provider add: connect an API-key model provider to the daemon. The list is
// Studio's provider catalog (shared/constants/provider-catalog.ts); the key
// goes to POST /runtime/providers, which keeps it in the daemon secret store
// (OS keychain or the owner's passphrase file), never in the settings file,
// and never sends it back. Subscriptions (ChatGPT, Grok) sign in via /login.

import * as catalogNs from '../../../shared/constants/provider-catalog'
import type { ProviderCatalogEntry } from '../../../shared/constants/provider-catalog'
import type { AddProviderInput } from '../api/types'
import { cjs } from '../interop'

const { PROVIDER_CATALOG } = cjs(catalogNs)

export const PROVIDER_OVERLAY = 'provider.add'

/** API-key types the daemon route accepts. */
const API_TYPES = new Set(['anthropic', 'openai', 'openrouter', 'openai-compatible'])

export interface ProviderChoiceRow {
  entry: ProviderCatalogEntry
  /** Subscriptions open the sign-in dialog instead of the form. */
  signIn?: 'chatgpt' | 'grok'
}

/** Subscriptions first (they sign in), then APIs, local servers, other. */
export function providerRows(): ProviderChoiceRow[] {
  const order: Record<string, number> = { subscription: 0, api: 1, local: 2, other: 3 }
  return [...PROVIDER_CATALOG]
    .filter(e => e.group === 'subscription' || API_TYPES.has(e.type))
    .sort((a, b) => (order[a.group] ?? 9) - (order[b.group] ?? 9))
    .map(entry => ({
      entry,
      ...(entry.type === 'chatgpt-subscription' ? { signIn: 'chatgpt' as const } : entry.type === 'grok-subscription' ? { signIn: 'grok' as const } : {}),
    }))
}

export function findProviderRow(key: string | undefined): ProviderChoiceRow | undefined {
  if (!key) return undefined
  const wanted = key.trim().toLowerCase()
  return providerRows().find(r => r.entry.key === wanted || r.entry.label.toLowerCase() === wanted || r.entry.type === wanted)
}

/** A local server or the generic OpenAI-compatible entry may run without a key. */
export function keyOptional(entry: ProviderCatalogEntry): boolean {
  return entry.keyOptional === true || entry.group === 'other'
}

export function needsBaseUrl(entry: ProviderCatalogEntry): boolean {
  return entry.type === 'openai-compatible'
}

export interface ProviderFormValues {
  name: string
  baseUrl: string
  apiKey: string
  defaultModel: string
}

export function validateProvider(entry: ProviderCatalogEntry, v: ProviderFormValues): Record<string, string> {
  const errors: Record<string, string> = {}
  if (needsBaseUrl(entry)) {
    const url = v.baseUrl.trim()
    if (!url) errors.baseUrl = 'The server’s base URL, e.g. http://localhost:11434/v1.'
    else if (/YOUR_[A-Z_]+/.test(url)) errors.baseUrl = 'Replace the YOUR_… part of the URL with your own value.'
    else {
      try {
        const parsed = new URL(url)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') errors.baseUrl = 'Use an http(s) URL.'
      } catch {
        errors.baseUrl = 'Not a URL.'
      }
    }
  }
  const key = v.apiKey.trim()
  if (!key && !keyOptional(entry)) errors.apiKey = 'Paste the API key.'
  else if (/\s/.test(key)) errors.apiKey = 'No spaces: paste the key exactly.'
  return errors
}

export function providerInput(entry: ProviderCatalogEntry, v: ProviderFormValues): AddProviderInput {
  const key = v.apiKey.trim()
  return {
    type: entry.type as AddProviderInput['type'],
    name: v.name.trim() || entry.label,
    ...(needsBaseUrl(entry) ? { baseUrl: v.baseUrl.trim() } : {}),
    ...(v.defaultModel.trim() ? { defaultModel: v.defaultModel.trim() } : {}),
    preset: entry.key,
    ...(key ? { apiKey: key } : {}),
  }
}

/** Where the key ends up, in words. */
export function keyStorageText(storage: 'keychain' | 'file' | undefined): string {
  return storage === 'file'
    ? 'the daemon’s passphrase-protected secret file'
    : 'the OS keychain'
}
