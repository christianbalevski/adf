import { useCallback } from 'react'
import { useAppStore } from '../stores/app.store'
import { useDocumentStore } from '../stores/document.store'
import { useAdfFile } from './useAdfFile'

/**
 * Open the agent that raised a notification so its in-chat card is visible.
 *
 * Extracted from ApprovalsMenu so every surface that can point at a pending
 * request — the bell's rows, the in-app toasts, and a clicked OS notification —
 * lands in ONE code path. A second implementation would drift: this one also
 * has to leave whatever full-screen view is covering the editor (settings, the
 * fleet map), and forgetting that is how "clicking the notification did
 * nothing" happens.
 */
export function useJumpToAgent(): (filePath: string) => void {
  const { openFile } = useAdfFile()
  return useCallback((filePath: string) => {
    const app = useAppStore.getState()
    if (app.showSettings) app.setShowSettings(false)
    if (app.showMeshGraph) app.setShowMeshGraph(false)
    // Reveal the chat itself, not just the agent (B4): for an ask "Respond" the
    // whole point is to land on the composer. expandRightPanelToTab('loop')
    // routes to the center tab or the dock's Loops tab as appropriate. This must
    // also run on the early-return path below — an already-open agent still
    // needs its (possibly collapsed / non-loop) chat brought to the front.
    app.expandRightPanelToTab('loop')
    if (useDocumentStore.getState().filePath === filePath) return
    void openFile(filePath)
  }, [openFile])
}
