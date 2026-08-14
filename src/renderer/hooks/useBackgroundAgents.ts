import { useEffect } from 'react'
import { useBackgroundAgentsStore } from '../stores/background-agents.store'
import { useAppStore } from '../stores/app.store'
import type { RendererBackgroundAgentEvent, BackgroundAgentStatus } from '../../shared/types/ipc.types'

function handleFromPayload(payload: RendererBackgroundAgentEvent['payload']): string {
  return (payload as Record<string, unknown>).handle as string
    ?? payload.filePath.split('/').pop()?.replace('.adf', '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    ?? 'agent'
}

/**
 * Subscribes to the batched BACKGROUND_AGENT_EVENT_BATCH IPC and updates the
 * background agents store. Should be called once at the app root level.
 */
export function useBackgroundAgentEvents() {
  useEffect(() => {
    if (!window.adfApi?.onBackgroundAgentEvents) return

    // Fetch initial status. `starting` seeds the sidebar spinners for the boot
    // autostart queue — those agent_starting events may have fired before this
    // renderer mounted.
    window.adfApi.getBackgroundAgentStatus().then((result) => {
      useBackgroundAgentsStore.getState().setAgents(result.agents)
      for (const fp of result.starting ?? []) {
        useAppStore.getState().addStartingFilePath(fp)
      }
    })

    const unsubscribe = window.adfApi.onBackgroundAgentEvents((events: RendererBackgroundAgentEvent[]) => {
      // Fold the whole batch over local drafts and commit at most one set()
      // per store — a batch of 40 events was 40 synchronous re-renders.
      let agents: BackgroundAgentStatus[] = useBackgroundAgentsStore.getState().agents
      let agentsChanged = false
      const app = useAppStore.getState()
      let starting = app.startingFilePaths
      let stopping = app.stoppingFilePaths
      let startingChanged = false
      let stoppingChanged = false

      const dropStarting = (fp: string): void => {
        if (!starting.has(fp)) return
        if (!startingChanged) { starting = new Set(starting); startingChanged = true }
        starting.delete(fp)
      }
      const dropStopping = (fp: string): void => {
        if (!stopping.has(fp)) return
        if (!stoppingChanged) { stopping = new Set(stopping); stoppingChanged = true }
        stopping.delete(fp)
      }

      for (const event of events) {
        const filePath = event.payload.filePath
        switch (event.type) {
          case 'agent_starting': {
            if (starting.has(filePath)) break
            if (!startingChanged) { starting = new Set(starting); startingChanged = true }
            starting.add(filePath)
            break
          }
          case 'agent_start_failed': {
            dropStarting(filePath)
            break
          }
          case 'agent_stopping': {
            if (stopping.has(filePath)) break
            if (!stoppingChanged) { stopping = new Set(stopping); stoppingChanged = true }
            stopping.add(filePath)
            break
          }
          case 'agent_started': {
            dropStarting(filePath)
            const entry: BackgroundAgentStatus = {
              filePath,
              handle: handleFromPayload(event.payload),
              state: event.payload.state ?? 'idle'
            }
            agents = [...agents.filter((a) => a.filePath !== filePath), entry]
            agentsChanged = true
            break
          }
          case 'agent_stopped': {
            dropStarting(filePath)
            dropStopping(filePath)
            if (agents.some((a) => a.filePath === filePath)) {
              agents = agents.filter((a) => a.filePath !== filePath)
              agentsChanged = true
            }
            break
          }
          case 'agent_state_changed': {
            const state = event.payload.state
            if (!state) break
            const idx = agents.findIndex((a) => a.filePath === filePath)
            // Bail when already current — a fresh array re-renders every subscriber
            if (idx === -1 || agents[idx].state === state) break
            agents = [...agents]
            agents[idx] = { ...agents[idx], state }
            agentsChanged = true
            break
          }
        }
      }

      if (agentsChanged) useBackgroundAgentsStore.setState({ agents })
      if (startingChanged || stoppingChanged) {
        useAppStore.setState({
          ...(startingChanged ? { startingFilePaths: starting } : {}),
          ...(stoppingChanged ? { stoppingFilePaths: stopping } : {})
        })
      }
    })

    return unsubscribe
  }, [])
}
