import { useEffect } from 'react'
import { useAgentStore, type AgentState, type AgentLogEntry } from '../stores/agent.store'
import { useDocumentStore } from '../stores/document.store'
import { useEditorTabsStore } from '../stores/editor-tabs.store'
import { AGENT_STATES } from '../../shared/types/adf-v02.types'
import type { AgentExecutionEvent } from '../../shared/types/ipc.types'
import { nanoid } from 'nanoid'

/**
 * Search backwards for the last entry of the given type, but only if it's
 * the most recent content entry (ignoring nothing). Stops at any other
 * content type — tool calls, tool results, system messages, etc.
 * This ensures text/thinking deltas only merge into an immediately adjacent
 * same-type entry, never across intervening tool calls or other blocks.
 */
function findLastStreamingEntry(log: AgentLogEntry[], type: 'text' | 'thinking'): number {
  const last = log.length > 0 ? log[log.length - 1] : undefined
  return last?.type === type ? log.length - 1 : -1
}

/** Map executor internal states to UI display states. */
export function toDisplayState(executorState: string): AgentState {
  switch (executorState) {
    // Executor operational states
    case 'thinking':
    case 'tool_use':
      return 'active'
    case 'idle':
      return 'idle'
    case 'awaiting_approval':
    case 'awaiting_ask':
    case 'suspended':
      return 'suspended'
    case 'error':
      return 'error'
    case 'stopped':
      return 'off'
    // ADF display states (pass-through from sys_set_state target)
    case 'active':
    case 'hibernate':
    case 'off':
      return executorState as AgentState
    default:
      return 'off'
  }
}

/**
 * Hook that listens to agent events from the main process
 * and updates the Zustand stores accordingly.
 *
 * All store mutations go through getState() so the callback
 * never becomes stale — the useEffect runs only once.
 */
export function useAgentEvents() {
  useEffect(() => {
    if (!window.adfApi) return

    const unsubscribe = window.adfApi.onAgentEvent((event: AgentExecutionEvent) => {
      const agentStore = useAgentStore.getState()

      switch (event.type) {
        case 'state_changed': {
          const payload = event.payload as { state: string }
          const displayState = toDisplayState(payload.state)
          agentStore.setState(displayState)

          // Auto-send queued messages when agent goes idle
          if (displayState === 'idle') {
            const queue = agentStore.messageQueue
            if (queue.length > 0) {
              const combined = queue.map(m => m.text).join('\n\n')
              const content = queue.flatMap((m) => m.content ?? [{ type: 'text' as const, text: m.text }])
              const imagePreviewUrls = queue.flatMap((m) => m.imagePreviewUrls ?? [])
              const currentFile = useDocumentStore.getState().filePath
              agentStore.clearQueue()
              agentStore.addLogEntry({
                id: nanoid(),
                type: 'user',
                content: combined,
                timestamp: Date.now(),
                metadata: imagePreviewUrls.length > 0 ? { imagePreviewUrls } : undefined
              })
              agentStore.setState('active')
              window.adfApi?.invokeAgent(combined, currentFile ?? undefined, content)
            }
          }
          break
        }

        case 'trigger_message': {
          const payload = event.payload as { content: string; triggerType: string }
          // Skip for manual_invoke — the UI already added it optimistically in handleSubmit
          if (payload.triggerType !== 'manual_invoke') {
            agentStore.addLogEntry({
              id: nanoid(),
              type: 'trigger',
              content: payload.content,
              timestamp: event.timestamp,
              metadata: { triggerType: payload.triggerType }
            })
          }
          break
        }

        case 'thinking_delta':
        case 'thinking_delta_batch': {
          const payload = event.payload as { delta?: string; deltas?: string[] }
          const text = payload.deltas ? payload.deltas.join('') : payload.delta!
          const idx = findLastStreamingEntry(agentStore.log, 'thinking')
          if (idx >= 0) {
            agentStore.updateEntryAt(idx, (e) => { e.content += text })
          } else {
            agentStore.addLogEntry({
              id: nanoid(),
              type: 'thinking',
              content: text,
              timestamp: event.timestamp
            })
          }
          break
        }

        case 'text_delta':
        case 'text_delta_batch': {
          const payload = event.payload as { delta?: string; deltas?: string[] }
          const text = payload.deltas ? payload.deltas.join('') : payload.delta!
          const idx = findLastStreamingEntry(agentStore.log, 'text')
          if (idx >= 0) {
            agentStore.updateEntryAt(idx, (e) => { e.content += text })
          } else {
            agentStore.addLogEntry({
              id: nanoid(),
              type: 'text',
              content: text,
              timestamp: event.timestamp
            })
          }
          break
        }

        case 'tool_call_start': {
          const payload = event.payload as { name: string; input: unknown; id?: string }
          agentStore.addLogEntry({
            id: nanoid(),
            type: 'tool_call',
            content: `Calling ${payload.name}`,
            timestamp: event.timestamp,
            metadata: { name: payload.name, input: payload.input, ...(payload.id ? { tool_id: payload.id } : {}) }
          })
          break
        }

        case 'tool_call_result': {
          const payload = event.payload as { name: string; id?: string; result: { content: string; isError: boolean }; imageUrl?: string }
          agentStore.addLogEntry({
            id: nanoid(),
            type: 'tool_result',
            content: payload.result.content,
            timestamp: event.timestamp,
            metadata: { name: payload.name, isError: payload.result.isError, ...(payload.id ? { tool_use_id: payload.id } : {}), ...(payload.imageUrl ? { imageUrl: payload.imageUrl } : {}) }
          })

          // If a file tool was used, refresh document and mind
          if (['fs_read', 'fs_write'].includes(payload.name)) {
            window.adfApi.getDocument().then((r) => {
              useDocumentStore.getState().setDocumentContent(r.content)
            })
            window.adfApi.getMind().then((r) => {
              useDocumentStore.getState().setMindContent(r.content)
            })
          }
          // If agent changed its own config, refresh it
          if (payload.name === 'sys_update_config') {
            window.adfApi.getAgentConfig().then((config) => {
              useAgentStore.getState().setConfig(config)
            })
          }
          // If agent updated meta, refresh status text
          if (payload.name === 'sys_set_meta' || payload.name === 'sys_delete_meta') {
            window.adfApi.getBatch().then((batch) => {
              useAgentStore.getState().setStatusText(batch.statusText ?? '')
            })
          }
          break
        }

        case 'response_metadata': {
          // Patch the most recent thinking/text entries from this API response
          const rmPayload = event.payload as { model: string; usage: { input: number; output: number } }
          const log = agentStore.log
          for (let i = log.length - 1; i >= 0; i--) {
            const entry = log[i]
            // Stop at any boundary that predates this response
            if (entry.type === 'user' || entry.type === 'system' || entry.type === 'tool_result') break
            if (entry.type === 'text') {
              log[i] = {
                ...entry,
                metadata: {
                  ...entry.metadata,
                  model: rmPayload.model,
                  tokens: rmPayload.usage
                }
              }
            }
          }
          // Bump version so UI re-renders
          agentStore.setLog([...log])
          // Update status bar with API-reported token counts
          agentStore.setTokenUsage(rmPayload.usage.input, rmPayload.usage.output)
          break
        }

        case 'turn_complete': {
          const turnPayload = event.payload as { targetState?: string }
          agentStore.addLogEntry({
            id: nanoid(),
            type: 'system',
            content: 'Turn complete',
            timestamp: event.timestamp
          })

          // If sys_set_state set a target state, apply it as the display state.
          // This overrides the executor's idle fallback.
          if (turnPayload.targetState) {
            const target = turnPayload.targetState as AgentState
            if ([...AGENT_STATES, 'error'].includes(target)) {
              agentStore.setState(target)
            }
          }

          // Final sync: batch fetch document, mind, and config in one IPC call
          // to ensure UI reflects everything the agent wrote during this turn
          window.adfApi?.getBatch().then((batch) => {
            useDocumentStore.getState().setDocumentContent(batch.document)
            useDocumentStore.getState().setMindContent(batch.mind)
            useAgentStore.getState().setConfig(batch.agentConfig)
            useAgentStore.getState().setStatusText(batch.statusText ?? '')
          })

          // Loop history is persisted via adf_loop table by AgentSession.
          // No need to send UI log back — DOC_SET_CHAT is a no-op in v0.2.
          break
        }

        case 'error': {
          const payload = event.payload as { error: string }
          agentStore.addLogEntry({
            id: nanoid(),
            type: 'error',
            content: payload.error,
            timestamp: event.timestamp
          })
          break
        }

        case 'autosaved': {
          // Main process autosaved — clear dirty flag
          useDocumentStore.getState().setDirty(false)
          break
        }

        case 'document_updated': {
          // Agent wrote to document.md — update store immediately with provided content
          const payload = event.payload as { content: string }
          useDocumentStore.getState().setDocumentContent(payload.content)
          break
        }

        case 'mind_updated': {
          // Agent wrote to mind.md — update store immediately with provided content
          const payload = event.payload as { content: string }
          useDocumentStore.getState().setMindContent(payload.content)
          break
        }

        case 'chat_updated': {
          // Loop was compacted — replace entire log with compacted version
          const payload = event.payload as { uiLog: any[] }
          agentStore.setLog(payload.uiLog)
          break
        }

        case 'tool_approval_request': {
          const payload = event.payload as { requestId: string; name: string; input: unknown }
          // The matching tool_call log entry was emitted just before this event
          const log = agentStore.log
          const lastEntry = log[log.length - 1]
          if (lastEntry && lastEntry.type === 'tool_call') {
            agentStore.addPendingApproval(lastEntry.id, payload.requestId)
          }
          break
        }

        case 'tool_approval_resolved': {
          const payload = event.payload as { requestId: string; approved: boolean }
          // pendingApprovals is Map<logEntryId, requestId> — find by requestId value
          for (const [logEntryId, reqId] of agentStore.pendingApprovals) {
            if (reqId === payload.requestId) {
              agentStore.removePendingApproval(logEntryId)
              break
            }
          }
          break
        }

        case 'ask_request': {
          const payload = event.payload as { requestId: string; question: string }
          const lastAskEntry = [...agentStore.log].reverse().find((entry) =>
            entry.type === 'tool_call' && entry.metadata?.name === 'ask'
          )
          if (lastAskEntry) {
            agentStore.addPendingAsk(lastAskEntry.id, payload.requestId, payload.question)
          } else {
            const askEntryId = nanoid()
            agentStore.addLogEntry({
              id: askEntryId,
              type: 'system',
              content: payload.question,
              timestamp: event.timestamp,
              metadata: { askRequestId: payload.requestId, isAsk: true }
            })
            agentStore.addPendingAsk(askEntryId, payload.requestId, payload.question)
          }
          break
        }

        case 'ask_response': {
          // Ask was resolved — remove from pending (the log entry remains)
          const askPayload = event.payload as { question: string; answer: string }
          // Find and remove the pending ask by scanning
          const asks = agentStore.pendingAsks
          for (const [logEntryId] of asks.entries()) {
            const idx = agentStore.log.findIndex((entry) => entry.id === logEntryId)
            if (idx >= 0) {
              agentStore.updateEntryAt(idx, (entry) => {
                entry.metadata = {
                  ...entry.metadata,
                  askAnswer: askPayload.answer
                }
              })
            }
            agentStore.removePendingAsk(logEntryId)
            break
          }
          break
        }

        case 'suspend_request': {
          const suspendEntryId = nanoid()
          agentStore.addLogEntry({
            id: suspendEntryId,
            type: 'system',
            content: 'Agent reached max active turns limit and has been suspended.',
            timestamp: event.timestamp,
            metadata: { isSuspend: true }
          })
          agentStore.setPendingSuspend(suspendEntryId)
          break
        }

        // timer_fired removed — agent-scope timers already produce trigger_message;
        // system-scope timers are captured in adf_logs.

        case 'inter_agent_message': {
          const payload = event.payload as {
            fromAgent: string
            toAgent: string
            channel?: string
            content: string
            direction: 'incoming' | 'outgoing'
          }
          agentStore.addLogEntry({
            id: nanoid(),
            type: 'inter_agent',
            content: payload.content,
            timestamp: event.timestamp,
            metadata: {
              fromAgent: payload.fromAgent,
              toAgent: payload.toAgent,
              channel: payload.channel,
              direction: payload.direction
            }
          })
          break
        }

        case 'context_injected': {
          const payload = event.payload as { category: string; content: string }
          agentStore.addLogEntry({
            id: nanoid(),
            type: 'context',
            content: payload.content,
            timestamp: event.timestamp,
            metadata: { category: payload.category }
          })
          break
        }

        case 'file_updated': {
          const payload = event.payload as { path: string; content: string }
          useEditorTabsStore.getState().updateTabFromExternal(payload.path, payload.content)
          break
        }
      }
    })

    // Refresh agent config when an MCP server connects (tools may have been discovered)
    const unsubMcp = window.adfApi?.onMcpServerStatusChanged?.((event: { name: string; status: string }) => {
      if (event.status === 'connected') {
        window.adfApi.getAgentConfig().then((config) => {
          if (config) useAgentStore.getState().setConfig(config)
        })
      }
    })

    return () => {
      unsubscribe()
      unsubMcp?.()
    }
  }, [])
}
