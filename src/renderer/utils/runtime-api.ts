import type { AdfApi } from '../../preload/api'
import { LOCAL_RUNTIME, type RuntimeId } from '../../shared/runtime-tag'
import { agentKey } from '../../shared/types/agent-ref'
import { useDocumentStore } from '../stores/document.store'
import { isAgentWindow } from './window-kind'

/**
 * How renderer code reaches a runtime (docs/design/multi-runtime.md §4.1):
 * `apiFor(runtimeId)` (omitted: This computer) is `window.adfApi` when that
 * is the window's own runtime, else the surface bound to `runtimeId`. With
 * This computer only, every call goes through `window.adfApi` exactly as
 * before. An agent window of another runtime reaches This computer through
 * `apiFor('local')`, untagged.
 */
export function apiFor(runtimeId?: RuntimeId | null): AdfApi {
  const api = window.adfApi
  const target = runtimeId || LOCAL_RUNTIME
  const own = typeof api?.runtimeId === 'string' && api.runtimeId ? api.runtimeId : LOCAL_RUNTIME
  if (own === target || typeof api?.runtime !== 'function') return api
  return api.runtime(target)
}

/**
 * The surface of the open agent's runtime. An agent window's `window.adfApi`
 * is already bound to its runtime (preload); the main window's follows the
 * agent it has open.
 */
export function openApi(): AdfApi {
  if (isAgentWindow) return window.adfApi
  return apiFor(useDocumentStore.getState().runtimeId)
}

/** The runtime of the open agent (main window: the agent it has open). */
export function openRuntime(): RuntimeId {
  return useDocumentStore.getState().runtimeId
}

/**
 * The open agent's key in maps keyed by agent (agentKey): its path on This
 * computer, as before; runtime and path on another runtime. Null when no
 * agent is open. An agent window shows one runtime, whose stores are its
 * own: its keys are paths.
 */
export function openAgentKey(): string | null {
  const { filePath, runtimeId } = useDocumentStore.getState()
  if (!filePath) return null
  return isAgentWindow ? filePath : agentKey({ runtimeId, filePath })
}

/** The key of `filePath` on `runtimeId` in this window's maps (an agent window's are keyed by path). */
export function windowAgentKey(runtimeId: RuntimeId | null | undefined, filePath: string): string {
  return isAgentWindow ? filePath : agentKey({ runtimeId, filePath })
}

/** openAgentKey as a hook: the open agent's key, or null. */
export function useOpenAgentKey(): string | null {
  return useDocumentStore((s) => (s.filePath ? windowAgentKey(s.runtimeId, s.filePath) : null))
}

/** The open agent's runtime as a hook (main window: the agent it has open; an agent window: its own). */
export function useOpenRuntime(): RuntimeId {
  return useDocumentStore((s) => s.runtimeId)
}
