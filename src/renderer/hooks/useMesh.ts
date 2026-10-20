import { useEffect, useCallback } from 'react'
import { useMeshStore } from '../stores/mesh.store'
import type { MeshEvent } from '../../shared/types/ipc.types'
import { LOCAL_RUNTIME, type RuntimeId } from '../../shared/runtime-tag'
import { apiFor } from '../utils/runtime-api'

/** Trailing window that folds an agent_joined burst into one getMeshStatus. */
const JOIN_REFRESH_DEBOUNCE_MS = 250

/**
 * Whether the mesh runs and which agents take part, from the runtime: a stale
 * read never undoes a local change made since. The agents give the status
 * bar's count, which an agent window has from nowhere else.
 */
function syncMeshRunning(): void {
  const rev = useMeshStore.getState().enabledRev
  window.adfApi?.getMeshStatus?.().then((status) => {
    useMeshStore.getState().upsertAgents(status.agents ?? [])
    useMeshStore.getState().syncEnabled(status.running === true, rev)
  }).catch(() => {})
}

/**
 * Subscribes to MESH_EVENT IPC and updates the mesh store.
 * Should be called once at the app root level.
 * Every window reads whether the mesh runs at start and on focus: Home turns
 * it on in the main window only, and an agent window (#149) never shows Home.
 */
export function useMeshEvents() {
  useEffect(() => {
    if (!window.adfApi?.onMeshEvent) return

    syncMeshRunning()
    window.addEventListener('focus', syncMeshRunning)

    // A mass start fires one agent_joined per agent; a trailing debounce
    // collapses the burst into a single status fetch.
    let joinTimer: ReturnType<typeof setTimeout> | null = null
    const scheduleStatusRefresh = () => {
      if (joinTimer) clearTimeout(joinTimer)
      joinTimer = setTimeout(() => {
        joinTimer = null
        const rev = useMeshStore.getState().enabledRev
        window.adfApi.getMeshStatus().then((status) => {
          useMeshStore.getState().upsertAgents(status.agents)
          useMeshStore.getState().syncEnabled(status.running === true, rev)
        })
      }, JOIN_REFRESH_DEBOUNCE_MS)
    }

    const unsubscribe = window.adfApi.onMeshEvent((event: MeshEvent) => {
      const store = useMeshStore.getState()

      switch (event.type) {
        case 'agent_state_changed': {
          if (event.payload.state) {
            store.updateAgentState(event.payload.filePath, event.payload.state)
          }
          break
        }
        case 'agent_joined': {
          // Merge — replacing with the live-only snapshot would wipe fleet
          // ghosts and collapse the fleet map on every mass start.
          scheduleStatusRefresh()
          break
        }
        case 'agent_left': {
          store.markAgentOffline(event.payload.filePath)
          // The mesh may have stopped (turned off or Kill in another window).
          scheduleStatusRefresh()
          break
        }
        case 'message_routed': {
          // No store update needed — messages are handled via AGENT_EVENT
          break
        }
      }
    })

    return () => {
      if (joinTimer) clearTimeout(joinTimer)
      window.removeEventListener('focus', syncMeshRunning)
      unsubscribe?.()
    }
  }, [])
}

/**
 * Exposes mesh control functions, for `runtimeId` (multi-runtime.md §6.3:
 * the Settings picker's runtime); omitted, This computer's, as before.
 */
export function useMesh(runtimeId?: RuntimeId) {
  const setEnabled = useMeshStore((s) => s.setEnabled)
  const upsertAgents = useMeshStore((s) => s.upsertAgents)
  const reset = useMeshStore((s) => s.reset)
  const other = runtimeId && runtimeId !== LOCAL_RUNTIME ? runtimeId : undefined

  const enableMesh = useCallback(async () => {
    const api = apiFor(other)
    const result = await api.enableMesh()
    if (result.success) {
      setEnabled(true, other)
      const status = await api.getMeshStatus()
      upsertAgents(status.agents, other)
    }
    return result
  }, [setEnabled, upsertAgents, other])

  const disableMesh = useCallback(async () => {
    const result = await apiFor(other).disableMesh()
    if (result.success) {
      reset(other)
    }
    return result
  }, [reset, other])

  const refreshStatus = useCallback(async () => {
    const status = await apiFor(other).getMeshStatus()
    setEnabled(status.running, other)
    upsertAgents(status.agents, other)
  }, [setEnabled, upsertAgents, other])

  return { enableMesh, disableMesh, refreshStatus }
}
