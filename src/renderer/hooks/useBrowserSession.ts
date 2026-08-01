import { useEffect } from 'react'
import { useDocumentStore } from '../stores/document.store'
import { useEditorTabsStore } from '../stores/editor-tabs.store'
import type { BrowserSessionEvent } from '../../shared/types/compute.types'

/**
 * Subscribes to COMPUTE_BROWSER_SESSION IPC and auto-opens the browser tab
 * when a browser process appears in the focused agent's container.
 * Should be called once at the app root level.
 */
export function useBrowserSessionEvents() {
  useEffect(() => {
    if (!window.adfApi?.onBrowserSession) return

    return window.adfApi.onBrowserSession((event: BrowserSessionEvent) => {
      // v1: only auto-open for the currently focused document. Match by agent
      // id, not path — path strings can differ (8.3 short names, case, slashes).
      if (!useDocumentStore.getState().filePath) return
      window.adfApi.getAgentConfig().then((config) => {
        if (!config || config.id !== event.agentId) return
        useEditorTabsStore.getState().openBrowserTab({
          agentFilePath: event.agentFilePath,
          containerName: event.containerName,
          hostPort: event.hostPort
        })
      }).catch(() => {})
    })
  }, [])
}
