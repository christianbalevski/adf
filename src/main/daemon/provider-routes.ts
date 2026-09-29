// App-level API-key providers added through the daemon (the TUI's
// `/provider add`, `adf` clients). The key goes to the daemon secret store
// (provider-key-vault.ts), never into the settings file, and never comes back
// over HTTP: responses carry `hasApiKey` only.
//
//   POST   /runtime/providers        { type, name?, baseUrl?, defaultModel?, preset?, apiKey? }
//   DELETE /runtime/providers/:id

import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { ProviderConfig } from '../../shared/types/ipc.types'
import type { ProviderKeyVault } from './provider-key-vault'
import { SECRET_STORE_KEY_STORAGE } from './provider-key-vault'

/** Structural subset of the daemon settings store these routes use. */
export interface ProviderRouteSettings {
  get(key: string): unknown
  set?(key: string, value: unknown): void
}

export interface ProviderRouteDeps {
  settingsStore?: ProviderRouteSettings
  providerKeys?: ProviderKeyVault | null
}

/** API-key provider types a client may add here. Subscriptions sign in instead (/auth). */
export const API_KEY_PROVIDER_TYPES = ['anthropic', 'openai', 'openrouter', 'openai-compatible'] as const
type ApiKeyProviderType = (typeof API_KEY_PROVIDER_TYPES)[number]

const LABELS: Record<ApiKeyProviderType, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  'openai-compatible': 'OpenAI-compatible',
}

interface AddProviderBody {
  type?: unknown
  name?: unknown
  baseUrl?: unknown
  defaultModel?: unknown
  preset?: unknown
  apiKey?: unknown
}

/** What clients see of a provider: never the key. */
export function publicProvider(provider: ProviderConfig) {
  return {
    id: provider.id,
    type: provider.type,
    name: provider.name,
    baseUrl: provider.baseUrl,
    defaultModel: provider.defaultModel,
    preset: provider.preset,
    credentialStorage: provider.credentialStorage ?? 'app',
    ...(provider.apiKeyStorage ? { apiKeyStorage: provider.apiKeyStorage } : {}),
    hasApiKey: typeof provider.apiKey === 'string' && provider.apiKey.length > 0,
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function uniqueName(label: string, taken: ProviderConfig[]): string {
  const names = new Set(taken.map(p => String(p.name ?? '').trim().toLowerCase()))
  if (!names.has(label.toLowerCase())) return label
  for (let n = 2; n < 1000; n++) if (!names.has(`${label} ${n}`.toLowerCase())) return `${label} ${n}`
  return `${label} ${Date.now()}`
}

function newId(taken: ProviderConfig[]): string {
  for (;;) {
    const id = `custom:${randomBytes(4).toString('hex').slice(0, 6)}`
    if (!taken.some(p => p.id === id)) return id
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export function registerProviderRoutes(server: FastifyInstance, deps: ProviderRouteDeps): void {
  const providers = (): ProviderConfig[] => {
    const value = deps.settingsStore?.get('providers')
    return Array.isArray(value) ? value.filter(p => p && typeof p === 'object') as ProviderConfig[] : []
  }

  server.post<{ Body: AddProviderBody }>('/runtime/providers', async (request, reply) => {
    const store = deps.settingsStore
    if (!store?.set) return reply.code(405).send({ error: 'Settings store is read-only.', code: 'read_only' })
    const body = (request.body && typeof request.body === 'object' ? request.body : {}) as AddProviderBody
    const type = str(body.type) as ApiKeyProviderType
    if (type === 'chatgpt-subscription' as string || type === 'grok-subscription' as string) {
      return reply.code(400).send({ error: 'Subscription providers sign in instead of taking a key (/login).', code: 'subscription_type' })
    }
    if (!API_KEY_PROVIDER_TYPES.includes(type)) {
      return reply.code(400).send({ error: `type must be one of ${API_KEY_PROVIDER_TYPES.join(', ')}.`, code: 'bad_type' })
    }
    const baseUrl = str(body.baseUrl).replace(/\/+$/, '')
    if (type === 'openai-compatible' && !baseUrl) return reply.code(400).send({ error: 'baseUrl is required for an OpenAI-compatible provider.', code: 'base_url_required' })
    if (baseUrl && !isHttpUrl(baseUrl)) return reply.code(400).send({ error: 'baseUrl must be an http(s) URL.', code: 'bad_base_url' })
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
    if (!apiKey && type !== 'openai-compatible') return reply.code(400).send({ error: 'apiKey is required for this provider type.', code: 'api_key_required' })
    const vault = deps.providerKeys
    if (apiKey && !vault?.available()) {
      return reply.code(409).send({
        error: 'The daemon secret store is locked or not set up yet: set up or unlock the owner identity first, then add the provider.',
        code: 'secret_store_locked',
      })
    }

    const existing = providers()
    const id = newId(existing)
    const entry: ProviderConfig = {
      id,
      type,
      name: uniqueName(str(body.name) || LABELS[type], existing),
      baseUrl,
      apiKey: '',
      defaultModel: str(body.defaultModel),
      params: [],
      ...(str(body.preset) ? { preset: str(body.preset) } : {}),
      ...(apiKey ? { apiKeyStorage: SECRET_STORE_KEY_STORAGE } : {}),
    }
    try {
      if (apiKey && vault) vault.set(id, apiKey)
      store.set('providers', [...existing, entry])
      const defaultId = store.get('defaultProviderId')
      if (typeof defaultId !== 'string' || !defaultId || !existing.some(p => p.id === defaultId)) store.set('defaultProviderId', id)
    } catch (err) {
      if (apiKey && vault) { try { vault.delete(id) } catch { /* best effort */ } }
      return reply.code(500).send({ error: `Could not save the provider: ${err instanceof Error ? err.message : String(err)}`, code: 'save_failed' })
    }
    const saved = providers().find(p => p.id === id) ?? entry
    return reply.code(201).send({ provider: publicProvider(saved), defaultProviderId: store.get('defaultProviderId') ?? null })
  })

  server.delete<{ Params: { id: string } }>('/runtime/providers/:id', async (request, reply) => {
    const store = deps.settingsStore
    if (!store?.set) return reply.code(405).send({ error: 'Settings store is read-only.', code: 'read_only' })
    const existing = providers()
    const target = existing.find(p => p.id === request.params.id)
    if (!target) return reply.code(404).send({ error: `Unknown provider "${request.params.id}"`, code: 'not_found' })
    const rest = existing.filter(p => p.id !== target.id)
    store.set('providers', rest)
    if (store.get('defaultProviderId') === target.id) store.set('defaultProviderId', rest[0]?.id ?? '')
    if (target.apiKeyStorage === SECRET_STORE_KEY_STORAGE) {
      try { deps.providerKeys?.delete(target.id) } catch { /* the entry is gone; a stale keychain row is harmless */ }
    }
    return { removed: target.id, providers: rest.map(publicProvider) }
  })
}
