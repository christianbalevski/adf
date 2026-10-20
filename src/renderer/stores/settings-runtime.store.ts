import { create } from 'zustand'
import { LOCAL_RUNTIME, type RuntimeId } from '../../shared/runtime-tag'
import { useDocumentStore } from './document.store'
import { useRuntimesStore } from './runtimes.store'

/**
 * The runtime Settings opens on (docs/design/multi-runtime.md §6.3): the one
 * a caller asked for (an agent window's Settings link, a status-bar group),
 * else the runtime of the main window's open agent, else This computer. The
 * choice is not saved.
 */
interface SettingsRuntimeState {
  /** Asked for by the next open, or by Settings while it is open; consumed by Settings. */
  requested: RuntimeId | null
  request: (id: RuntimeId) => void
  take: () => RuntimeId | null
}

export const useSettingsRuntimeStore = create<SettingsRuntimeState>((set, get) => ({
  requested: null,
  request: (id) => set({ requested: id || LOCAL_RUNTIME }),
  take: () => {
    const id = get().requested
    if (id !== null) set({ requested: null })
    return id
  },
}))

/** Settings opens on `id` (a runtime of the set; This computer otherwise). */
export function requestSettingsRuntime(id: RuntimeId | null | undefined): void {
  useSettingsRuntimeStore.getState().request(id || LOCAL_RUNTIME)
}

/** The runtime Settings starts on now: a request, else the open agent's runtime, else This computer; always one of the set. */
export function initialSettingsRuntime(): RuntimeId {
  const runtimes = useRuntimesStore.getState().runtimes
  const inSet = (id: RuntimeId | null | undefined): id is RuntimeId => !!id && runtimes.some((r) => r.id === id)
  const requested = useSettingsRuntimeStore.getState().take()
  if (inSet(requested)) return requested
  const open = useDocumentStore.getState()
  if (open.filePath && inSet(open.runtimeId)) return open.runtimeId
  return LOCAL_RUNTIME
}
