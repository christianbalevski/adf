import { useEffect, useCallback } from 'react'
import { useMeshStore } from '../stores/mesh.store'
import type { MeshEvent } from '../../shared/types/ipc.types'

/**
 * Subscribes to MESH_EVENT IPC and updates the mesh store.
 * Should be called once at the app root level.
 */
export function useMeshEvents() {
  useEffect(() => {
    if (!window.adfApi?.onMeshEvent) return

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
          // Refresh full status
          window.adfApi.getMeshStatus().then((status) => {
            store.setAgents(status.agents)
          })
          break
        }
        case 'agent_left': {
          store.setAgents(
            store.agents.filter((a) => a.filePath !== event.payload.filePath)
          )
          break
        }
        case 'message_routed': {
          // No store update needed — messages are handled via AGENT_EVENT
          break
        }
      }
    })

    return unsubscribe
  }, [])
}

/**
 * Exposes mesh control functions.
 */
export function useMesh() {
  const setEnabled = useMeshStore((s) => s.setEnabled)
  const setAgents = useMeshStore((s) => s.setAgents)
  const reset = useMeshStore((s) => s.reset)

  const enableMesh = useCallback(async () => {
    const result = await window.adfApi.enableMesh()
    if (result.success) {
      setEnabled(true)
      const status = await window.adfApi.getMeshStatus()
      setAgents(status.agents)
    }
    return result
  }, [setEnabled, setAgents])

  const disableMesh = useCallback(async () => {
    const result = await window.adfApi.disableMesh()
    if (result.success) {
      reset()
    }
    return result
  }, [reset])

  const refreshStatus = useCallback(async () => {
    const status = await window.adfApi.getMeshStatus()
    setEnabled(status.running)
    setAgents(status.agents)
  }, [setEnabled, setAgents])

  return { enableMesh, disableMesh, refreshStatus }
}
