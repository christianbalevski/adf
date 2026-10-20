import { useEffect, useState } from 'react'
import { openApi, useOpenRuntime } from '../utils/runtime-api'
import { useDocumentStore } from '../stores/document.store'
import { LOCAL_RUNTIME, type RuntimeId } from '../../shared/runtime-tag'

export interface ProviderModelList {
  models: string[]
  error?: string
}

// Keyed by provider id, plus the agent file when the list is fetched with the
// agent's own key — a provider copy on an agent can see a different catalog
// than the app's entry of the same id. The list comes from the open agent's
// runtime: another runtime's key is its runtime and the rest.
let cache = new Map<string, ProviderModelList>()
const inflight = new Map<string, Promise<ProviderModelList>>()

const cacheKey = (providerId: string, filePath?: string, runtimeId: RuntimeId = LOCAL_RUNTIME) => {
  const key = filePath ? `${filePath}\0${providerId}` : providerId
  return runtimeId === LOCAL_RUNTIME ? key : `${runtimeId}\n${key}`
}

/** Drop every cached list (provider settings or keys changed). */
export function invalidateProviderModels(): void {
  cache = new Map()
}

/**
 * The provider's model list, fetched once per key, from the open agent's
 * runtime. Pass `filePath` when the provider is stored on that agent so the
 * backend lists with the agent's key.
 */
export function loadProviderModels(providerId: string, filePath?: string): Promise<ProviderModelList> {
  const key = cacheKey(providerId, filePath, useDocumentStore.getState().runtimeId)
  const cached = cache.get(key)
  if (cached) return Promise.resolve(cached)
  let pending = inflight.get(key)
  if (!pending) {
    pending = (openApi()?.listModels(providerId, filePath) ?? Promise.resolve({ models: [] }))
      .catch((err: unknown) => ({ models: [], error: String(err) }))
      .then((result) => {
        cache.set(key, result)
        return result
      })
      .finally(() => inflight.delete(key))
    inflight.set(key, pending)
  }
  return pending
}

export function useProviderModels(providerId: string | undefined, filePath?: string): ProviderModelList & { loading: boolean } {
  const runtimeId = useOpenRuntime()
  const key = providerId ? cacheKey(providerId, filePath, runtimeId) : ''
  const [state, setState] = useState<{ key: string; list: ProviderModelList } | null>(null)

  useEffect(() => {
    if (!providerId) return
    let live = true
    void loadProviderModels(providerId, filePath).then((list) => {
      if (live) setState({ key, list })
    })
    return () => { live = false }
  }, [providerId, filePath, key])

  if (!providerId) return { models: [], loading: false }
  const list = state?.key === key ? state.list : cache.get(key)
  return list ? { ...list, loading: false } : { models: [], loading: true }
}
