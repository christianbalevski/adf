import { useCallback } from 'react'
import { useDocumentStore } from '../stores/document.store'
import { useAgentStore } from '../stores/agent.store'
import { useAppStore } from '../stores/app.store'
import { useEditorTabsStore } from '../stores/editor-tabs.store'
import { nanoid } from 'nanoid'
import { toDisplayState } from './useAgent'

/**
 * Hook for managing ADF file operations.
 */
export function useAdfFile() {
  const setDocumentContent = useDocumentStore((s) => s.setDocumentContent)
  const setMindContent = useDocumentStore((s) => s.setMindContent)
  const setFilePath = useDocumentStore((s) => s.setFilePath)
  const setDirty = useDocumentStore((s) => s.setDirty)
  const setConfig = useAgentStore((s) => s.setConfig)
  const setStatusText = useAgentStore((s) => s.setStatusText)
  const setLog = useAgentStore((s) => s.setLog)
  const clearLog = useAgentStore((s) => s.clearLog)
  const setTokenUsage = useAgentStore((s) => s.setTokenUsage)
  const resetDocument = useDocumentStore((s) => s.reset)
  const resetAgent = useAgentStore((s) => s.reset)
  const setShowSettings = useAppStore((s) => s.setShowSettings)

  const loadFileContents = useCallback(async () => {
    try {
      const t0 = performance.now()
      // Single IPC round-trip instead of 4 separate calls
      const batch = await window.adfApi.getBatch()
      console.log(`[PERF:renderer] loadFileContents.getBatch IPC: ${(performance.now() - t0).toFixed(1)}ms`)

      const t1 = performance.now()
      setDocumentContent(batch.document)
      setMindContent(batch.mind)
      setConfig(batch.agentConfig)
      setStatusText(batch.statusText ?? '')
      setDirty(false)

      // Restore loop (conversation history) if present
      if (batch.chat && batch.chat.uiLog.length > 0) {
        setLog(batch.chat.uiLog)
        console.log(`[PERF:renderer] loadFileContents.setStores: ${(performance.now() - t1).toFixed(1)}ms (logEntries=${batch.chat.uiLog.length})`)
      } else {
        clearLog()
        console.log(`[PERF:renderer] loadFileContents.setStores: ${(performance.now() - t1).toFixed(1)}ms (empty log)`)
      }

      // Restore token usage from last assistant message
      if (batch.lastTokens) {
        setTokenUsage(batch.lastTokens.input ?? 0, batch.lastTokens.output ?? 0)
      }
      console.log(`[PERF:renderer] loadFileContents total: ${(performance.now() - t0).toFixed(1)}ms`)

      // Reset editor tabs and open document.md
      useEditorTabsStore.getState().reset()
      useEditorTabsStore.getState().openTab('document.md', batch.document, false)
    } catch (error) {
      console.error('[useAdfFile] Error loading file contents:', error)
      throw error
    }
  }, [setDocumentContent, setMindContent, setConfig, setStatusText, setDirty, setLog, clearLog, setTokenUsage])

  const completeFileOpen = useCallback(async () => {
    setShowSettings(false)
    resetAgent()
    await loadFileContents()

    // Check if review is needed (replaces MCP server check)
    try {
      const review = await window.adfApi.checkAgentReview()
      if (review.needsReview) {
        useAppStore.getState().setAgentReviewDialog(true, review.configSummary)
        return
      }
    } catch {
      // Non-fatal — skip review check
    }
  }, [setShowSettings, resetAgent, loadFileContents])

  const openFile = useCallback(async (filePath?: string) => {
    const tTotal = performance.now()

    // Loop history is persisted via the adf_loop table by AgentSession.
    // No need to send the UI log back — DOC_SET_CHAT is a no-op in v0.2.

    let t1 = performance.now()
    const result = await window.adfApi.openFile(filePath)
    console.log(`[PERF:renderer] openFile.openFile IPC: ${(performance.now() - t1).toFixed(1)}ms`)

    if (result.success && result.filePath) {
      // Check if password is needed
      if (result.needsPassword) {
        setFilePath(result.filePath)
        useAppStore.getState().setPasswordDialogOpen(true, result.filePath)
        return result
      }

      // Check if owner mismatch
      if (result.ownerMismatch) {
        setFilePath(result.filePath)
        useAppStore.getState().setOwnerMismatchDialogOpen(true, result.fileOwnerDid)
        return result
      }

      // Close settings if it's open
      setShowSettings(false)

      // Reset agent state and update filePath immediately so any in-flight
      // async handlers from the previous agent see the filePath has changed
      // (prevents their stillViewing checks from passing incorrectly).
      t1 = performance.now()
      resetAgent()
      setFilePath(result.filePath)
      console.log(`[PERF:renderer] openFile.resetAgent: ${(performance.now() - t1).toFixed(1)}ms`)

      // Load new file contents (document, mind, loop, config)
      t1 = performance.now()
      await loadFileContents()
      console.log(`[PERF:renderer] openFile.loadFileContents: ${(performance.now() - t1).toFixed(1)}ms`)

      // Check if agent review is needed (first open or config changed)
      if (!result.agentWasRunning) {
        try {
          const review = await window.adfApi.checkAgentReview()
          if (review.needsReview) {
            useAppStore.getState().setAgentReviewDialog(true, review.configSummary)
          }
        } catch {
          // Non-fatal — skip review check
        }
      }

      // If the agent was running in the background, auto-start it
      if (result.agentWasRunning) {
        t1 = performance.now()
        const startResult = await window.adfApi.startAgent()
        console.log(`[PERF:renderer] openFile.startAgent IPC: ${(performance.now() - t1).toFixed(1)}ms`)
        if (startResult.success) {
          // Use the actual executor state (may be mid-turn: thinking/tool_use)
          useAgentStore.getState().setState(toDisplayState(startResult.agentState ?? 'idle'))

          // Restore pending HIL approvals so the user can still approve/reject
          const pending = (startResult as { pendingApprovals?: Array<{ requestId: string; name: string; input: unknown }> }).pendingApprovals
          if (pending && pending.length > 0) {
            const store = useAgentStore.getState()
            for (const approval of pending) {
              // Find the matching tool_call log entry by tool name (search from end)
              const log = store.log
              let matched = false
              for (let i = log.length - 1; i >= 0; i--) {
                const entry = log[i]
                if (entry.type === 'tool_call' && entry.metadata?.name === approval.name) {
                  store.addPendingApproval(entry.id, approval.requestId)
                  matched = true
                  break
                }
              }
              // If no matching log entry found (e.g. log was truncated), synthesize one
              if (!matched) {
                const entryId = nanoid()
                store.addLogEntry({
                  id: entryId,
                  type: 'tool_call',
                  content: `Calling ${approval.name}`,
                  timestamp: Date.now(),
                  metadata: { name: approval.name, input: approval.input }
                })
                store.addPendingApproval(entryId, approval.requestId)
              }
            }
          }

          // Restore pending ask requests so the reply box reappears after navigation
          const pendingAsks = (startResult as { pendingAsks?: Array<{ requestId: string; question: string }> }).pendingAsks
          if (pendingAsks && pendingAsks.length > 0) {
            const store = useAgentStore.getState()
            for (const ask of pendingAsks) {
              // Find the matching ask tool_call log entry (search from end)
              const log = store.log
              let matched = false
              for (let i = log.length - 1; i >= 0; i--) {
                const entry = log[i]
                if (entry.type === 'tool_call' && entry.metadata?.name === 'ask') {
                  store.addPendingAsk(entry.id, ask.requestId, ask.question)
                  matched = true
                  break
                }
              }
              // If no matching log entry found, synthesize one
              if (!matched) {
                const entryId = nanoid()
                store.addLogEntry({
                  id: entryId,
                  type: 'tool_call',
                  content: `Calling ask`,
                  timestamp: Date.now(),
                  metadata: { name: 'ask', input: { question: ask.question } }
                })
                store.addPendingAsk(entryId, ask.requestId, ask.question)
              }
            }
          }
        }
      }

      console.log(`[PERF:renderer] openFile total: ${(performance.now() - tTotal).toFixed(1)}ms`)
    } else {
      console.error('[useAdfFile] Failed to open file:', result.error)
      // Show error to user
      if (result.error?.includes('old ZIP format')) {
        alert(
          'Cannot open this file\n\n' +
          'This ADF file uses the old ZIP format (pre-v0.1).\n\n' +
          'The format has been upgraded to SQLite for better performance and reliability.\n\n' +
          'Please delete this file and create a new one with the same name.'
        )
      } else {
        alert(`Failed to open file:\n\n${result.error}`)
      }
    }
    return result
  }, [setShowSettings, resetAgent, loadFileContents, setFilePath])

  const createFile = useCallback(async (name: string) => {
    const result = await window.adfApi.createFile(name)
    if (result.success && result.filePath) {
      // Close settings if it's open
      setShowSettings(false)

      setFilePath(result.filePath)
      await loadFileContents()
    }
    return result
  }, [setShowSettings, setFilePath, loadFileContents])

  const saveFile = useCallback(async () => {
    const result = await window.adfApi.saveFile()
    if (result.success) {
      setDirty(false)
    }
    return result
  }, [setDirty])

  const closeFile = useCallback(async () => {
    await window.adfApi.closeFile()
    resetDocument()
    resetAgent()
    useEditorTabsStore.getState().reset()
  }, [resetDocument, resetAgent])

  return { openFile, createFile, saveFile, closeFile, loadFileContents, completeFileOpen }
}
