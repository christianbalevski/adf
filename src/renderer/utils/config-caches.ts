import type { ProviderConfig, McpServerRegistration, AdapterRegistration } from '../../shared/types/ipc.types'
import { invalidateProviderModels } from '../hooks/useProviderModels'

/**
 * The config panel's module-level caches, to avoid redundant IPC calls on
 * every tab switch, one set per runtime: an agent of another runtime sees
 * that runtime's settings. A runtime that leaves the set, or is another
 * computer now, loses its set (dropConfigCaches).
 */
export interface ConfigCaches {
  providers: ProviderConfig[] | null
  mcpRegistrations: McpServerRegistration[] | null
  adapterRegistrations: AdapterRegistration[] | null
  toolDefs: Record<string, unknown> | null
}

const caches = new Map<string, ConfigCaches>()

export function cachesOf(runtimeId: string): ConfigCaches {
  let set = caches.get(runtimeId)
  if (!set) {
    set = { providers: null, mcpRegistrations: null, adapterRegistrations: null, toolDefs: null }
    caches.set(runtimeId, set)
  }
  return set
}

/** Call this when settings change (e.g. from SettingsPage) to bust stale caches */
export function invalidateConfigCaches(): void {
  for (const set of caches.values()) {
    set.providers = null
    set.mcpRegistrations = null
    set.adapterRegistrations = null
  }
  invalidateProviderModels()
}

/** The runtime left the set or is another computer now: everything cached for it goes, its tool catalog too. */
export function dropConfigCaches(runtimeId: string): void {
  const set = caches.get(runtimeId)
  if (!set) return
  set.providers = null
  set.mcpRegistrations = null
  set.adapterRegistrations = null
  set.toolDefs = null
  caches.delete(runtimeId)
}
