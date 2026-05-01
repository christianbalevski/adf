import { useEffect } from 'react'
import { useBackgroundAgentsStore } from '../stores/background-agents.store'
import type { BackgroundAgentEvent } from '../../shared/types/ipc.types'

/**
 * Subscribes to BACKGROUND_AGENT_EVENT IPC and updates the background agents store.
 * Should be called once at the app root level.
 */
export function useBackgroundAgentEvents() {
  useEffect(() => {
    if (!window.adfApi?.onBackgroundAgentEvent) return

    // Fetch initial status
    window.adfApi.getBackgroundAgentStatus().then((result) => {
      useBackgroundAgentsStore.getState().setAgents(result.agents)
    })

    const unsubscribe = window.adfApi.onBackgroundAgentEvent((event: BackgroundAgentEvent) => {
      const store = useBackgroundAgentsStore.getState()

      switch (event.type) {
        case 'agent_started': {
          store.addAgent({
            filePath: event.payload.filePath,
            handle: (event.payload as Record<string, unknown>).handle as string
              ?? event.payload.filePath.split('/').pop()?.replace('.adf', '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
              ?? 'agent',
            state: event.payload.state ?? 'idle'
          })
          break
        }
        case 'agent_stopped': {
          store.removeAgent(event.payload.filePath)
          break
        }
        case 'agent_state_changed': {
          if (event.payload.state) {
            store.updateAgentState(event.payload.filePath, event.payload.state)
          }
          break
        }
      }
    })

    return unsubscribe
  }, [])
}
