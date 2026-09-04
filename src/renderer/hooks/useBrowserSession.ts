import { useEffect } from 'react'
import { useDocumentStore } from '../stores/document.store'
import { useEditorTabsStore } from '../stores/editor-tabs.store'
import type { BrowserSessionEvent } from '../../shared/types/compute.types'

/**
 * Subscribes to COMPUTE_BROWSER_SESSION IPC and auto-opens the browser tab (in
 * the background) when a browser process appears in the focused agent's container.
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
        // Background only: the tab appears in the bar but the stage stays where
        // the user is (usually the loop chat) — they click over when they want it.
        useEditorTabsStore.getState().openBrowserTab({
          agentFilePath: event.agentFilePath,
          containerName: event.containerName,
          hostPort: event.hostPort
        }, { activate: false })
      }).catch(() => {})
    })
  }, [])
}
