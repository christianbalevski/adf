import type { DaemonClient, DaemonEventFrame, EventStream } from '../../../shared/daemon-client'
import type { AgentExecutionEvent } from '../../../shared/types/ipc.types'
import { DaemonModeUnavailableError } from './errors'

/**
 * The client session and client event stream as Studio main consumes them
 * (design D5). The event bridge (event-bridge.ts) and the session
 * (session.ts) depend only on `ClientSession`, so the daemon's real client
 * sessions (W2-B: `POST /client/sessions`, `GET /client/sessions/:id/events`)
 * replace the interim adapter below without touching them.
 *
 * Frames carry domain events. For `push` frames the payload of each topic is
 * the payload of its IPC push channel, exactly as embedded Studio sends it
 * (PUSH_TOPICS in event-bridge.ts names the channel); a producer that cannot
 * build that payload must say so, not send another shape.
 */

/** Host events (D5 `host` frames); W1-A emits the lifecycle ones. */
export type HostEventType =
  | 'agent_starting'
  | 'agent_started'
  | 'agent_start_failed'
  | 'agent_stopping'
  | 'agent_stopped'
  | 'agent_loops_changed'
  | 'agent_state_changed'
  /** A trigger failed (embedded shows it as `error` on AGENT_EVENT for the open agent). */
  | 'trigger_error'
  /** The startup dispatch failed. */
  | 'startup_dispatch_failed'

export interface ExecutorFrame {
  kind: 'executor'
  agentId: string
  filePath: string | null
  /** The turn that produced it (`turnId` of POST /agents/:id/chat), when the daemon knows. */
  turnId?: string
  /**
   * On `turn_complete` and `error`: chats answered inside this turn instead of
   * their own (`absorbed_turn_ids`). Their AGENT_INVOKE waits end here too.
   */
  absorbedTurnIds?: string[]
  /** The executor event as AGENT_EVENT carries it; `event.loop` names a side loop. */
  event: AgentExecutionEvent
}

export interface HostFrame {
  kind: 'host'
  agentId: string
  filePath: string | null
  type: HostEventType
  /** Event-specific fields: `state`, `handle` (agent_started), `activeLoops`, `error`, `code`. */
  payload: Record<string, unknown>
  timestamp: number
}

export type PushTopic =
  | 'inbox'
  | 'adapter_status'
  | 'mcp_status'
  | 'mcp_install'
  | 'adapter_install'
  | 'sandbox_install'
  | 'tracked_dirs'
  | 'templates'
  | 'file_renamed'
  | 'config_changed'
  | 'workspace_data'
  | 'approvals'
  | 'mesh'
  | 'inter_agent_message'
  | 'compute_phase'
  | 'browser_session'

export interface PushFrame {
  kind: 'push'
  topic: PushTopic
  /** The agent the push is about, for topics scoped to the open file. */
  agentId?: string | null
  filePath?: string | null
  payload: unknown
}

/**
 * Turn bookkeeping with no executor event: a stop dropped queued chats
 * (`turnIds`, never delivered) and cut off the running ones
 * (`unansweredTurnIds`). Their AGENT_INVOKE waits end.
 */
export interface TurnFrame {
  kind: 'turn'
  agentId: string
  filePath: string | null
  outcome: 'discarded'
  turnIds: string[]
  unansweredTurnIds: string[]
}

export type ClientFrame = ExecutorFrame | HostFrame | PushFrame | TurnFrame

export interface StreamGap {
  /** `evicted`: frames past the session ring were lost; `epoch_changed`: the daemon restarted. */
  reason: 'evicted' | 'epoch_changed'
  epoch?: string
}

export interface StreamConnection {
  state: 'connecting' | 'open' | 'reconnecting' | 'closed'
  error?: string
}

export interface ClientStreamListener {
  onFrame(frame: ClientFrame): void
  /** Frames were lost: the bridge resyncs (D6). */
  onGap(gap: StreamGap): void
  onConnection(connection: StreamConnection): void
  /**
   * The stream is open again after a drop. The client re-establishes what the
   * session held: it re-sends the focus and re-holds its documents (the
   * daemon may have expired the session, or restarted: `epochChanged`).
   * Called before any frame of the new connection is delivered.
   */
  onReattached?(info: { epochChanged: boolean }): void
}

export interface ClientSession {
  readonly kind: 'client-session' | 'events-adapter'
  /** What this implementation cannot deliver. Logged once at start and listed in the gap doc. */
  readonly limitations: readonly string[]
  start(listener: ClientStreamListener): void
  /** The agent whose text/thinking deltas the stream carries (D5). */
  setFocus(agentId: string | null): Promise<void>
  /** Hold an `.adf` as an open document (D4); resolves its agent id. */
  holdDocument(filePath: string): Promise<{ agentId: string }>
  releaseDocument(agentId: string): Promise<void>
  /** Drop the stream connection and reconnect now. */
  reconnect(): void
  /** End the session (DELETE /client/sessions/:id) and close the stream. */
  end(): Promise<void>
}

/**
 * INTERIM (until W2-B): a `ClientSession` over today's `GET /events`, the
 * umbilical stream. It is global, has no session and no focus, and is lossy
 * for UI purposes (D5 rationale): it carries only the executor events the
 * executor maps one to one onto typed umbilical events. Everything else is
 * listed in `limitations` and reaches the renderer only once W2-B ships the
 * client stream. No umbilical event is reinterpreted as something it is not.
 */
export const EVENTS_ADAPTER_LIMITATIONS: readonly string[] = [
  'no client session: documents cannot be held (FILE_OPEN of a file that is not running, FILE_CLOSE release) — W2-B',
  'no focus: text and thinking deltas are not on GET /events unless the agent sets umbilical.stream_deltas — W2-B',
  'executor events without a one-to-one umbilical event (deltas, tool_call_start/result, chat_updated, trigger_message, context_injected content, response_metadata, loop_seq, document/file updates, approvals, asks, suspend) — W2-B',
  'host lifecycle events other than agent.loaded/agent.unloaded (agent_starting, agent_start_failed, agent_stopping, loops, trigger errors) — W1-A, W2-B',
  'push topics (inbox, MCP/adapter status, installs, tracked dirs, templates, file renamed, config changed, workspace data, approvals, mesh, compute) — W2-B',
]

/** Keys the executor adds to a payload on its way onto the umbilical (agent-executor.ts emitEvent). */
const UMBILICAL_ADDED_KEYS = ['filePath', 'absorbed_turn_ids']

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
}

function withoutKeys(payload: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(payload)) if (!keys.includes(k)) out[k] = v
  return out
}

/**
 * One umbilical envelope as the frame it stands for, or null when it has no
 * exact counterpart. Exact means: `agent.state.changed`, `turn.completed` and
 * `agent.error` are emitted from exactly one executor event each, with the
 * executor payload plus the keys in UMBILICAL_ADDED_KEYS; `agent.loaded` /
 * `agent.unloaded` are the runtime's load and unload.
 */
export function translateUmbilicalEnvelope(envelope: DaemonEventFrame): ClientFrame | null {
  const e = envelope.event
  const agentId = e.agent_id
  if (!agentId) return null
  const payload = (e.payload ?? {}) as Record<string, unknown>
  const filePath = typeof payload.filePath === 'string' ? payload.filePath : null
  const absorbed = stringList(payload.absorbed_turn_ids)
  const executor = (event: AgentExecutionEvent): ExecutorFrame => ({
    kind: 'executor',
    agentId,
    filePath,
    ...(e.turn_id ? { turnId: e.turn_id } : {}),
    ...(absorbed.length ? { absorbedTurnIds: absorbed } : {}),
    event: e.loop ? { ...event, loop: e.loop } : event,
  })
  switch (e.event_type) {
    case 'agent.state.changed':
      return executor({ type: 'state_changed', payload: withoutKeys(payload, UMBILICAL_ADDED_KEYS), timestamp: e.timestamp })
    case 'turn.completed':
      return executor({ type: 'turn_complete', payload: withoutKeys(payload, UMBILICAL_ADDED_KEYS), timestamp: e.timestamp })
    case 'agent.error': {
      const inner = payload.event as AgentExecutionEvent | undefined
      if (!inner || typeof inner !== 'object' || inner.type !== 'error') return null
      return executor({ ...inner })
    }
    case 'agent.loaded':
      return {
        kind: 'host', agentId, filePath, type: 'agent_started', timestamp: e.timestamp,
        payload: typeof payload.handle === 'string' ? { handle: payload.handle } : {},
      }
    case 'agent.unloaded':
      return { kind: 'host', agentId, filePath, type: 'agent_stopped', timestamp: e.timestamp, payload: {} }
    case 'chat.discarded':
      return { kind: 'turn', agentId, filePath, outcome: 'discarded', turnIds: stringList(payload.turn_ids), unansweredTurnIds: stringList(payload.unanswered_turn_ids) }
    default:
      return null
  }
}

/** The interim adapter. `holdDocument` and `releaseDocument` refuse visibly (W2-B). */
export function createEventsAdapterSession(client: DaemonClient, opts: { idleTimeoutMs?: number } = {}): ClientSession {
  let stream: EventStream<DaemonEventFrame> | null = null
  return {
    kind: 'events-adapter',
    limitations: EVENTS_ADAPTER_LIMITATIONS,
    start(listener) {
      if (stream) return
      stream = client.events<DaemonEventFrame>({
        path: '/events',
        ...(opts.idleTimeoutMs !== undefined ? { idleTimeoutMs: opts.idleTimeoutMs } : {}),
        onEvent: (envelope) => {
          const frame = translateUmbilicalEnvelope(envelope)
          if (frame) listener.onFrame(frame)
        },
        onState: (info) => {
          listener.onConnection({ state: info.state === 'idle' ? 'connecting' : info.state, ...(info.error ? { error: info.error } : {}) })
        },
        onResume: (info) => {
          // GET /events holds no session state; the hook still runs so the
          // client re-sends what a real session would have lost.
          listener.onReattached?.({ epochChanged: info.reason === 'epoch_changed' })
          if (!info.exact) listener.onGap({ reason: info.reason === 'epoch_changed' ? 'epoch_changed' : 'evicted', epoch: info.epoch })
        },
      }).start()
    },
    async setFocus() {
      // GET /events has no focus; nothing to tell the daemon.
    },
    async holdDocument() {
      throw new DaemonModeUnavailableError('Holding an agent file as an open document', 'W2-B', 'POST /client/sessions/:id/documents')
    },
    async releaseDocument() {
      throw new DaemonModeUnavailableError('Releasing an open document', 'W2-B', 'DELETE /client/sessions/:id/documents/:agentId')
    },
    reconnect() {
      stream?.reconnect()
    },
    async end() {
      stream?.close()
      stream = null
    },
  }
}
