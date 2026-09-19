import { useEffect } from 'react'
import { useBackgroundAgentsStore } from '../stores/background-agents.store'
import { useAppStore } from '../stores/app.store'
import { useDocumentStore } from '../stores/document.store'
import { foldAgentStatuses } from '../utils/background-agent-statuses'
import type { RendererBackgroundAgentEvent } from '../../shared/types/ipc.types'

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
      // per store — a batch of 40 events was 40 synchronous re-renders. The
      // status list folds in its own pure pass; only the spinner sets, which
      // need the open file, are folded here.
      const previousAgents = useBackgroundAgentsStore.getState().agents
      const agents = foldAgentStatuses(previousAgents, events)
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
            break
          }
          case 'agent_stopped': {
            // A background agent that is now the OPEN file was not stopped: it
            // was extracted for foreground attach (FILE_OPEN), and openFile is
            // re-starting it right now. Dropping its spinner here would race the
            // re-attach and blank the indicator for the whole rebuild window.
            if (filePath !== useDocumentStore.getState().filePath) dropStarting(filePath)
            dropStopping(filePath)
            break
          }
        }
      }

      if (agents !== previousAgents) useBackgroundAgentsStore.setState({ agents })
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
