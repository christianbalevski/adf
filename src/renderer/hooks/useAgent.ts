import { useEffect } from 'react'
import { useAgentStore, selectLoopSlice, MAIN_LOOP, type AgentState, type AgentLogEntry } from '../stores/agent.store'
import { useDocumentStore } from '../stores/document.store'
import { useEditorTabsStore } from '../stores/editor-tabs.store'
import { AGENT_STATES, type AgentConfig } from '../../shared/types/adf-v02.types'
import type { AgentExecutionEvent, ResponseMetadataPayload, ToolApprovalRequestPayload } from '../../shared/types/ipc.types'
import { parseLoopSendStamp } from '../../shared/utils/loop-parser'
import { nanoid } from 'nanoid'
import { findApprovalTargetEntry } from './approval-target'

/**
 * Search backwards for the last entry of the given type, but only if it's
 * the most recent content entry (ignoring nothing). Stops at any other
 * content type — tool calls, tool results, system messages, etc.
 * This ensures text/thinking deltas only merge into an immediately adjacent
 * same-type entry, never across intervening tool calls or other blocks.
 */
function findLastStreamingEntry(log: AgentLogEntry[], type: 'text' | 'thinking'): number {
  const last = log.length > 0 ? log[log.length - 1] : undefined
  if (!last || last.type !== type) return -1
  // A quiet-turn marker is an empty terminal text entry standing in for a turn
  // that produced nothing. A LATER (e.g. self-scheduled successor) turn's deltas
  // must not merge into it (B16), or "ended quietly" silently becomes that
  // turn's output. Treat it as a boundary: start a fresh entry instead.
  if (last.metadata?.quietTurn) return -1
  return log.length - 1
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
    // One reference for every subscription this effect makes — they all share
    // the same lifetime and the same cleanup.
    const api = window.adfApi

    // A loop_send delivery that arrives while main is mid-block would splice into
    // the streaming text/thinking entry: the next delta no longer finds a
    // contiguous streaming entry (the loop card is now the tail) and starts a
    // fresh bubble, cutting the assistant's block in two. Hold deliveries while a
    // block is streaming and flush them as clean cards once it ends. Keyed by
    // loop; the map lives for the subscription's lifetime via this closure.
    const pendingLoopDeliveries = new Map<string, AgentLogEntry[]>()
    // Keyed by the open agent's file AS WELL AS the loop: the map outlives an
    // agent switch, and a loop name ('main') is not agent-scoped, so a card held
    // for agent A must never flush into agent B's log (review S6/P7/C8). A
    // stale key for another file simply sits until that file is open again.
    const deliveryKey = (loop: string): string =>
      `${useDocumentStore.getState().filePath ?? ''}:${loop}`
    const isBlockStreaming = (log: AgentLogEntry[]): boolean =>
      findLastStreamingEntry(log, 'text') >= 0 || findLastStreamingEntry(log, 'thinking') >= 0
    const deliverLoopMessage = (entry: AgentLogEntry, loop: string, active: boolean, log: AgentLogEntry[]): void => {
      // Only hold while the block is genuinely mid-stream (loop active AND a
      // streaming text/thinking entry at the tail). An idle agent with a leftover
      // text entry must show the delivery now, not wait for the next turn.
      if (active && isBlockStreaming(log)) {
        const key = deliveryKey(loop)
        const buf = pendingLoopDeliveries.get(key) ?? []
        buf.push(entry)
        pendingLoopDeliveries.set(key, buf)
      } else {
        useAgentStore.getState().addLogEntry(entry, loop)
      }
    }
    const flushLoopDeliveries = (loop: string): void => {
      const key = deliveryKey(loop)
      const buf = pendingLoopDeliveries.get(key)
      if (!buf || buf.length === 0) return
      pendingLoopDeliveries.delete(key)
      const store = useAgentStore.getState()
      for (const e of buf) store.addLogEntry(e, loop)
    }

    const unsubscribe = api.onAgentEvent((event: AgentExecutionEvent) => {
      const agentStore = useAgentStore.getState()
      // Uniform router (§6.2): every event belongs to exactly one loop, and an
      // emitter that predates loops (or a main-loop emitter) simply omits it.
      // `slice` is main's store root for 'main' and an isolated per-loop slice
      // otherwise, so side-loop streams can never splice into main's log.
      const loop = event.loop ?? MAIN_LOOP
      const slice = selectLoopSlice(agentStore, loop)

      switch (event.type) {
        case 'state_changed': {
          const payload = event.payload as { state: string }
          const displayState = toDisplayState(payload.state)
          agentStore.setState(displayState, loop)

          // Safety net: a stream that ends without a turn_complete (error, reset)
          // must not strand a held loop delivery. Flush on any settled state.
          if (displayState === 'idle' || displayState === 'error' || displayState === 'off') {
            flushLoopDeliveries(loop)
          }

          // Auto-send queued messages when agent goes idle
          if (displayState === 'idle') {
            const queue = slice.messageQueue
            if (queue.length > 0) {
              const combined = queue.map(m => m.text).join('\n\n')
              const content = queue.flatMap((m) => m.content ?? [{ type: 'text' as const, text: m.text }])
              const imagePreviewUrls = queue.flatMap((m) => m.imagePreviewUrls ?? [])
              const currentFile = useDocumentStore.getState().filePath
              agentStore.clearQueue(loop)
              agentStore.addLogEntry({
                id: nanoid(),
                type: 'user',
                content: combined,
                timestamp: Date.now(),
                metadata: imagePreviewUrls.length > 0 ? { imagePreviewUrls } : undefined
              }, loop)
              agentStore.setState('active', loop)
              window.adfApi?.invokeAgent(combined, currentFile ?? undefined, content, loop)
            }
          }
          break
        }

        case 'trigger_message': {
          const payload = event.payload as { content: string; triggerType: string }
          // An inter-loop delivery (loop_send) rides in as a `chat` trigger —
          // the wake dispatch is a chat event — but it is NOT owner input.
          // Tag it here so the live path renders exactly what parseLoopToDisplay
          // produces for the same row after a reload.
          const loopSend = parseLoopSendStamp(payload.content)
          if (loopSend) {
            deliverLoopMessage({
              id: nanoid(),
              type: 'context',
              content: loopSend.body,
              timestamp: event.timestamp,
              metadata: { category: 'loop', fromLoop: loopSend.fromLoop }
            }, loop, slice.state === 'active', slice.log)
            break
          }
          // Skip for manual_invoke — the UI already added it optimistically in handleSubmit
          if (payload.triggerType === 'chat') {
            // Owner chat that arrived from OUTSIDE the chat panel (fleet
            // command bar) — no optimistic echo happened, so render the
            // user's own words as a user bubble, not a trigger chip.
            agentStore.addLogEntry({
              id: nanoid(),
              type: 'user',
              content: payload.content,
              timestamp: event.timestamp
            }, loop)
          } else if (payload.triggerType !== 'manual_invoke') {
            agentStore.addLogEntry({
              id: nanoid(),
              type: 'trigger',
              content: payload.content,
              timestamp: event.timestamp,
              metadata: { triggerType: payload.triggerType }
            }, loop)
          }
          break
        }

        case 'thinking_delta':
        case 'thinking_delta_batch': {
          const payload = event.payload as { delta?: string; deltas?: string[] }
          const text = payload.deltas ? payload.deltas.join('') : payload.delta!
          const idx = findLastStreamingEntry(slice.log, 'thinking')
          if (idx >= 0) {
            agentStore.updateEntryAt(idx, (e) => { e.content += text }, loop)
          } else {
            agentStore.addLogEntry({
              id: nanoid(),
              type: 'thinking',
              content: text,
              timestamp: event.timestamp
            }, loop)
          }
          break
        }

        case 'text_delta':
        case 'text_delta_batch': {
          const payload = event.payload as { delta?: string; deltas?: string[] }
          const text = payload.deltas ? payload.deltas.join('') : payload.delta!
          const idx = findLastStreamingEntry(slice.log, 'text')
          if (idx >= 0) {
            agentStore.updateEntryAt(idx, (e) => { e.content += text }, loop)
          } else {
            agentStore.addLogEntry({
              id: nanoid(),
              type: 'text',
              content: text,
              timestamp: event.timestamp
            }, loop)
          }
          break
        }

        case 'tool_call_start': {
          const payload = event.payload as { name: string; input: unknown; id?: string }
          // The streaming text/thinking block just ended — a held loop delivery
          // lands here, after the block and before this tool call.
          flushLoopDeliveries(loop)
          agentStore.addLogEntry({
            id: nanoid(),
            type: 'tool_call',
            content: `Calling ${payload.name}`,
            timestamp: event.timestamp,
            metadata: { name: payload.name, input: payload.input, ...(payload.id ? { tool_id: payload.id } : {}) }
          }, loop)
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
          }, loop)

          // If a file tool was used, refresh the document. Other files refresh
          // their open tabs via `file_updated`.
          if (['fs_read', 'fs_write'].includes(payload.name)) {
            window.adfApi.getDocument().then((r) => {
              useDocumentStore.getState().setDocumentContent(r.content)
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
          const rmPayload = event.payload as ResponseMetadataPayload
          // A pre-flight estimate is the size of the request about to go out.
          // It lives in its own store field so it never clobbers the last real
          // call's cache/cost breakdown, and it stays visible even if that
          // request then fails with a context_length error (the post-call
          // response_metadata never fires in that case). No completed turn to
          // annotate yet — only the status bar updates.
          // Usage is CURRENT context, and context is per-executor: it lands on
          // the emitting loop's slice. `main` patches the store root, so every
          // pre-existing reader of `s.tokenUsage` / `s.tokenEstimate` keeps
          // seeing main and only main (RT-F12). What this still does NOT build
          // is cross-loop cumulative spend — nothing here sums the slices,
          // because no event carries that.
          if (rmPayload.estimated) {
            agentStore.setTokenEstimate((rmPayload.usage.input ?? 0) + (rmPayload.usage.output ?? 0), loop)
            break
          }
          // Real post-call usage (full breakdown incl. cache/cost) replaces the
          // last call's figures and retires the pre-flight estimate.
          agentStore.setTokenUsage({ ...rmPayload.usage, input: rmPayload.usage.input ?? 0, output: rmPayload.usage.output ?? 0 }, loop)
          agentStore.setTokenEstimate(null, loop)
          // Patch the entries produced by this response. A pure tool-call turn
          // has no text entry, so patching only `text` left tool-only turns
          // without their per-entry token cost — include thinking/tool_call.
          const log = slice.log
          for (let i = log.length - 1; i >= 0; i--) {
            const entry = log[i]
            // Stop at any boundary that predates this response
            if (entry.type === 'user' || entry.type === 'system' || entry.type === 'tool_result') break
            if (entry.type === 'text' || entry.type === 'thinking' || entry.type === 'tool_call') {
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
          agentStore.setLog([...log], undefined, loop)
          break
        }

        case 'turn_complete': {
          const turnPayload = event.payload as { targetState?: string }

          // A turn that produced NOTHING visible — no text, no tool call.
          // Reasoning alone does not count: a model that thinks and then
          // returns an empty message (gpt-5.6 does this in side loops) has
          // still ended the turn with nothing said, and the tab would trail
          // off after the thinking block, indistinguishable from a crash or a
          // dropped stream. The marker is an EMPTY assistant entry, which the
          // loop renders as a muted "ended quietly (no output)" one-liner.
          //
          // The boundary is this loop's last inbound row (owner message,
          // trigger, injected context): anything after it belongs to the turn
          // that just ended. Trailing thinking entries are skipped before the
          // check. Ambiguous cases resolve as "it produced something", so this
          // under-reports rather than inventing endings.
          const currentLog = selectLoopSlice(useAgentStore.getState(), loop).log
          let tailIdx = currentLog.length - 1
          while (tailIdx >= 0 && currentLog[tailIdx].type === 'thinking') tailIdx--
          const lastEntry = tailIdx >= 0 ? currentLog[tailIdx] : undefined
          const producedOutput = !lastEntry
            || (lastEntry.type !== 'user' && lastEntry.type !== 'trigger' && lastEntry.type !== 'context')
          if (!producedOutput) {
            // Tagged so a subsequent turn's deltas can't merge into this empty
            // marker (see findLastStreamingEntry). Live-only: rehydrate /
            // compaction don't reconstruct it, which is fine — it's a
            // presentational stand-in, not stream content.
            agentStore.addLogEntry({
              id: nanoid(),
              type: 'text',
              content: '',
              timestamp: event.timestamp,
              metadata: { quietTurn: true }
            }, loop)
          }
          // Drain any deliveries held during the final block AFTER the quiet-turn
          // check has read the tail: a delivery is only ever held while a
          // text/thinking block is streaming, so flushing first would put a
          // `context` entry at the tail and mis-flag a turn that demonstrably
          // produced output as "ended quietly" (review C4).
          flushLoopDeliveries(loop)

          // If sys_set_state set a target state, apply it as the display state.
          // This overrides the executor's idle fallback.
          if (turnPayload.targetState) {
            const target = turnPayload.targetState as AgentState
            if ([...AGENT_STATES, 'error'].includes(target)) {
              agentStore.setState(target, loop)
            }
          }

          // Final sync: batch fetch document and config in one IPC call to
          // ensure UI reflects everything the agent wrote during this turn.
          // Nothing in the batch is per-loop (document, agent-level config,
          // status text are all main's), so scope it to main (B11): a side
          // loop's turn firing this fanned setConfig's fresh identity into the
          // status/title/tab-strip ~6x AND, via setDocumentContent, marked the
          // open document dirty on a turn that never touched it.
          if (loop === MAIN_LOOP) {
            window.adfApi?.getBatch().then((batch) => {
              useDocumentStore.getState().setDocumentContent(batch.document)
              useAgentStore.getState().setConfig(batch.agentConfig)
              useAgentStore.getState().setStatusText(batch.statusText ?? '')
            })
          }

          // Loop history is persisted via adf_loop table by AgentSession.
          // No need to send UI log back — DOC_SET_CHAT is a no-op in v0.2.
          break
        }

        case 'error': {
          const payload = event.payload as { error: string; details?: string }
          agentStore.addLogEntry({
            id: nanoid(),
            type: 'error',
            content: payload.error,
            timestamp: event.timestamp,
            metadata: payload.details ? { details: payload.details } : undefined
          }, loop)
          break
        }

        case 'autosaved': {
          // Main process autosaved — clear dirty flag
          useDocumentStore.getState().setDirty(false)
          break
        }

        case 'document_updated': {
          // Agent wrote to README.md — update store immediately with provided content
          const payload = event.payload as { content: string }
          useDocumentStore.getState().setDocumentContent(payload.content)
          break
        }

        case 'chat_updated': {
          // This loop was compacted — replace ITS log with the compacted
          // version. Scoped to `loop` so a side loop's compaction never wipes
          // main's view (IMPL-5 / RT-F17).
          const payload = event.payload as { uiLog: any[] }
          agentStore.setLog(payload.uiLog, 0, loop)
          break
        }

        case 'tool_approval_request': {
          const payload = event.payload as ToolApprovalRequestPayload
          const approvalMeta = {
            reason: payload.reason,
            protection: payload.protection,
            canAlwaysApprove: payload.canAlwaysApprove,
            alwaysApproveBlockedReason: payload.alwaysApproveBlockedReason
          }
          // Bind to the in-flight tool_call entry for THIS tool (see
          // findApprovalTargetEntry for why "the last entry" was wrong).
          let targetId = findApprovalTargetEntry(
            slice.log,
            payload.name,
            (id) => slice.pendingApprovals.has(id)
          ) ?? undefined
          // No entry for this call — synthesize one so the prompt is always
          // visible and names the tool that actually needs approval.
          if (!targetId) {
            targetId = nanoid()
            agentStore.addLogEntry({
              id: targetId,
              type: 'tool_call',
              content: `Calling ${payload.name}`,
              timestamp: event.timestamp,
              metadata: { name: payload.name, input: payload.input, outOfBand: true }
            }, loop)
          }
          agentStore.addPendingApproval(targetId, payload.requestId, approvalMeta, loop)
          break
        }

        case 'tool_approval_resolved': {
          const payload = event.payload as { requestId: string; approved: boolean }
          // pendingApprovals maps logEntryId -> info — find by requestId value
          for (const [logEntryId, info] of slice.pendingApprovals) {
            if (info.requestId === payload.requestId) {
              // Synthesized (outOfBand) entries have no tool_result to land —
              // stamp the decision so they don't render as "running…" forever.
              agentStore.markApprovalOutcome(logEntryId, payload.approved, loop)
              agentStore.removePendingApproval(logEntryId, loop)
              break
            }
          }
          break
        }

        case 'ask_request': {
          const payload = event.payload as { requestId: string; question: string }
          const lastAskEntry = [...slice.log].reverse().find((entry) =>
            entry.type === 'tool_call' && entry.metadata?.name === 'ask'
          )
          if (lastAskEntry) {
            agentStore.addPendingAsk(lastAskEntry.id, payload.requestId, payload.question, loop)
          } else {
            const askEntryId = nanoid()
            agentStore.addLogEntry({
              id: askEntryId,
              type: 'system',
              content: payload.question,
              timestamp: event.timestamp,
              metadata: { askRequestId: payload.requestId, isAsk: true }
            }, loop)
            agentStore.addPendingAsk(askEntryId, payload.requestId, payload.question, loop)
          }
          break
        }

        case 'ask_response': {
          // Ask was resolved — remove from pending (the log entry remains)
          const askPayload = event.payload as { question: string; answer: string }
          // Find and remove the pending ask by scanning
          const asks = slice.pendingAsks
          for (const [logEntryId] of asks.entries()) {
            const idx = slice.log.findIndex((entry) => entry.id === logEntryId)
            if (idx >= 0) {
              agentStore.updateEntryAt(idx, (entry) => {
                entry.metadata = {
                  ...entry.metadata,
                  askAnswer: askPayload.answer
                }
              }, loop)
            }
            agentStore.removePendingAsk(logEntryId, loop)
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
          }, loop)
          agentStore.setPendingSuspend(suspendEntryId, loop)
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
          }, loop)
          break
        }

        case 'context_injected': {
          const payload = event.payload as { category: string; content: string }
          // A no-wake loop_send lands in the target's context rather than
          // starting a turn; same stamp, same block.
          const injectedLoopSend = parseLoopSendStamp(payload.content)
          const injectedEntry: AgentLogEntry = {
            id: nanoid(),
            type: 'context',
            content: injectedLoopSend ? injectedLoopSend.body : payload.content,
            timestamp: event.timestamp,
            metadata: injectedLoopSend
              ? { category: 'loop', fromLoop: injectedLoopSend.fromLoop }
              : { category: payload.category }
          }
          // Loop deliveries defer to the block boundary; other injections keep
          // their current inline behaviour.
          if (injectedLoopSend) deliverLoopMessage(injectedEntry, loop, slice.state === 'active', slice.log)
          else agentStore.addLogEntry(injectedEntry, loop)
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
    const unsubMcp = api.onMcpServerStatusChanged?.((event: { name: string; status: string }) => {
      if (event.status === 'connected') {
        api.getAgentConfig().then((config) => {
          if (config) useAgentStore.getState().setConfig(config)
        })
      }
    })

    // The runtime changed the config on its own — `loop_manage` adding or
    // removing an inner loop, `sys_update_config`, anything else that goes
    // through the assembled agent's config choke point. Without this the store
    // (and everything derived from it: the loop tab strip, the config panel's
    // Loops section) stayed on the pre-change config until the user switched
    // agents and back.
    //
    // Main suppresses this for Studio-originated saves, so applying the payload
    // cannot clobber an edit the user has in flight. The filePath check is the
    // second guard: a change emitted just before a file switch must not land on
    // the incoming agent.
    const unsubConfig = api.onAgentConfigChanged?.((data: { filePath: string; config: AgentConfig }) => {
      const openPath = useDocumentStore.getState().filePath
      if (openPath && data.filePath && openPath !== data.filePath) return
      if (!data.config) return
      const store = useAgentStore.getState()
      // A loop REMOVED from config (deleted, not merely disabled — a disabled
      // loop stays in the list) leaves a stale slice behind: its stream and any
      // dead pending approvals. Left in place, a later same-name recreate would
      // resurrect that old stream. Drop those slices before applying the new
      // config (B17). Disabled-but-present loops keep their slice.
      const liveNames = new Set((data.config.loops ?? []).map((l) => l.name))
      for (const name of Object.keys(store.sideLoops)) {
        if (!liveNames.has(name)) store.dropLoop(name)
      }
      store.setConfig(data.config)
    })

    return () => {
      unsubscribe()
      unsubMcp?.()
      unsubConfig?.()
    }
  }, [])
}
