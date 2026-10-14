// The terminal app on the daemon's client-session stream (design
// daemon-backend.md D5, GET /client/sessions/:id/events).
//
// The TUI's state model is built on umbilical envelopes, so its session asks
// for them (`umbilical: true`) and they reach the reducer unchanged. Executor
// frames add what the umbilical lacks:
//
//   text / thinking delta batches  the focused agent's tokens, whatever
//                                  `umbilical.stream_deltas` says (the session
//                                  never carries `turn.delta`); fed to the
//                                  reducer as `turn.delta`
//   tool_call_result               the full result (tool.completed carries a
//                                  truncated copy)
//   chat_updated                   the loop's display log was replaced
//                                  (compaction, rewrite): reload that transcript
//
// Host and push frames are not needed: the umbilical envelopes carry the same
// lifecycle and state changes for this model.

import type { ClientFrame, DaemonEventFrame, UmbilicalEvent } from '../api/types'

/** Client name the TUI's sessions are opened with (the daemon logs it). */
export const TUI_CLIENT_NAME = 'tui'

const MAIN = 'main'

export interface ClientFrameEffects {
  /** Envelopes for the reducer and the store's event side effects, in order. */
  frames: DaemonEventFrame[]
  /** A full tool result for the transcript's tool item. */
  toolResult?: { agentId: string; loop: string; toolUseId: string; result: string; isError: boolean }
  /** Reload this transcript from history. */
  reload?: { agentId: string; loop: string }
}

const NONE: ClientFrameEffects = { frames: [] }

/** What one client-session frame means for the TUI. Pure. */
export function clientFrameEffects(frame: ClientFrame): ClientFrameEffects {
  if (frame.kind === 'umbilical') return { frames: [{ cursor: frame.cursor, event: frame.event }] }
  if (frame.kind !== 'executor') return NONE
  const { event, agentId } = frame
  const loop = frame.loop ?? event.loop ?? MAIN
  const payload = (event.payload ?? {}) as Record<string, unknown>
  switch (event.type) {
    case 'text_delta':
    case 'text_delta_batch':
    case 'thinking_delta':
    case 'thinking_delta_batch': {
      const text = deltaText(payload)
      if (!text) return NONE
      const kind = event.type.startsWith('thinking') ? 'thinking' : 'text'
      const delta: UmbilicalEvent = {
        seq: 0,
        event_type: 'turn.delta',
        timestamp: event.timestamp,
        source: `agent:${agentId}`,
        agent_id: agentId,
        ...(loop !== MAIN ? { loop } : {}),
        payload: { kind, text },
      }
      return { frames: [{ cursor: frame.cursor, event: delta }] }
    }
    case 'tool_call_result': {
      if (frame.stripped) return NONE
      const id = typeof payload.id === 'string' ? payload.id : undefined
      const result = payload.result as { content?: unknown; isError?: unknown } | undefined
      if (!id || typeof result?.content !== 'string') return NONE
      return { frames: [], toolResult: { agentId, loop, toolUseId: id, result: result.content, isError: result.isError === true } }
    }
    case 'chat_updated':
      return { frames: [], reload: { agentId, loop } }
    default:
      return NONE
  }
}

/** The text of a delta event: `{deltas: string[]}` (batches) or `{delta}` / `{text}` (single). */
function deltaText(payload: Record<string, unknown>): string {
  if (Array.isArray(payload.deltas)) return payload.deltas.filter((d): d is string => typeof d === 'string').join('')
  if (typeof payload.delta === 'string') return payload.delta
  return typeof payload.text === 'string' ? payload.text : ''
}
