import { useEffect } from 'react'
import { useBackgroundAgentsStore } from '../stores/background-agents.store'
import { useAppStore } from '../stores/app.store'
import type { BackgroundAgentEvent } from '../../shared/types/ipc.types'

/**
 * Subscribes to BACKGROUND_AGENT_EVENT IPC and updates the background agents store.
 * Should be called once at the app root level.
 */
export function useBackgroundAgentEvents() {
  useEffect(() => {
    if (!window.adfApi?.onBackgroundAgentEvent) return

    // Fetch initial status. `starting` seeds the sidebar spinners for the boot
    // autostart queue — those agent_starting events may have fired before this
    // renderer mounted.
    window.adfApi.getBackgroundAgentStatus().then((result) => {
      useBackgroundAgentsStore.getState().setAgents(result.agents)
      for (const fp of result.starting ?? []) {
        useAppStore.getState().addStartingFilePath(fp)
      }
    })

    const unsubscribe = window.adfApi.onBackgroundAgentEvent((event: BackgroundAgentEvent) => {
      const store = useBackgroundAgentsStore.getState()
      const app = useAppStore.getState()

      switch (event.type) {
        case 'agent_starting': {
          app.addStartingFilePath(event.payload.filePath)
          break
        }
        case 'agent_start_failed': {
          app.removeStartingFilePath(event.payload.filePath)
          break
        }
        case 'agent_stopping': {
          app.addStoppingFilePath(event.payload.filePath)
          break
        }
        case 'agent_started': {
          app.removeStartingFilePath(event.payload.filePath)
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
          app.removeStartingFilePath(event.payload.filePath)
          app.removeStoppingFilePath(event.payload.filePath)
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
