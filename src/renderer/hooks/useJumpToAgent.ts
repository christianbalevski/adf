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
    if (useDocumentStore.getState().filePath === filePath) return
    void openFile(filePath)
  }, [openFile])
}
