/**
 * Typed umbilical event registry.
 *
 * Single source of truth for the event types the runtime publishes onto the
 * umbilical. Every `emitUmbilicalEvent({ event_type: '<literal>' })` call site
 * in `src/main/**` must use a member of `UMBILICAL_EVENT_TYPES` — enforced by
 * tests/unit/umbilical-event-registry.test.ts.
 *
 * The `custom.*` namespace is deliberately NOT in the array: it is an open
 * namespace reserved for agent-authored events emitted through
 * `adf.emit_event`. The runtime never emits `custom.*` itself.
 *
 * See docs/guides/umbilical-events.md for payload semantics and stability
 * guarantees.
 */

export const UMBILICAL_EVENT_TYPES = [
  // --- agent lifecycle ---------------------------------------------------
  'agent.loaded',
  'agent.unloaded',
  'agent.state.changed',
  'agent.error',

  // --- turn --------------------------------------------------------------
  'turn.completed',

  // --- tools -------------------------------------------------------------
  'tool.started',
  'tool.completed',
  'tool.failed',

  // --- model calls -------------------------------------------------------
  'llm.completed',
  'llm.failed',

  // --- lambdas -----------------------------------------------------------
  'lambda.started',
  'lambda.completed',
  'lambda.failed',

  // --- triggers / timers -------------------------------------------------
  'trigger.fired',
  'timer.fired',

  // --- messaging ---------------------------------------------------------
  'message.received',
  'message.sent',
  'message.delivery_failed',

  // --- filesystem --------------------------------------------------------
  'file.read',
  'file.written',
  'file.deleted',

  // --- database ----------------------------------------------------------
  'db.read',
  'db.write',

  // --- websockets --------------------------------------------------------
  'ws.opened',
  'ws.closed',

  // --- stream bindings ---------------------------------------------------
  'binding.created',
  'binding.materialized',
  'binding.pending',
  'binding.reconnecting',
  'binding.error',
  'binding.threshold_exceeded',
  'binding.flow_summary',
  'binding.terminated',

  // --- channel adapters / MCP -------------------------------------------
  'adapter.status.changed',
  'adapter.log',
  'mcp.status.changed',
  'mcp.tools.discovered',
  'mcp.log',

  // --- daemon ------------------------------------------------------------
  'daemon.started',
  'daemon.autostart.report',

  // --- lifecycle / control-plane -----------------------------------------
  // These are emitted by the runtime (HIL, asks, suspend, config/context,
  // loop lifecycle, mesh queueing, trigger drops, WS reconnect, turn deltas).
  //
  // Exception: `umbilical.checkpoint` is the signed epoch/checkpoint marker
  // from the deferred sealed-epochs design (docs/design/sealed-epochs.md) and
  // is reserved — declared up front so tap filters validate cleanly, but
  // nothing emits it today.
  'umbilical.checkpoint',
  'hil.requested',
  'hil.resolved',
  'ask.requested',
  'ask.resolved',
  'suspend.requested',
  'suspend.resolved',
  'config.changed',
  'context.injected',
  'loop.compacted',
  'loop.compaction_failed',
  'loop.cleared',
  'loop.recovered',
  'message.queued',
  'trigger.dropped',
  // Automatic recovery from transient provider errors (config.recovery):
  // scheduled → armed a backoff retry; started → retry turn began;
  // cancelled → disarmed (fresh work, abort, or owner state change).
  'provider.retry_scheduled',
  'provider.retry_started',
  'provider.retry_cancelled',
  'ws.reconnecting',
  'turn.delta',
] as const

export type UmbilicalEventType = typeof UMBILICAL_EVENT_TYPES[number]

const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set<string>(UMBILICAL_EVENT_TYPES)

/** Open namespace prefix for agent-authored events (never in the registry). */
export const CUSTOM_EVENT_PREFIX = 'custom.'

/**
 * True for registry members and for any `custom.`-prefixed type.
 *
 * Used for non-fatal forward-compat validation warnings — an unknown type is
 * never an error, only a hint that a filter may be a typo.
 */
export function isKnownUmbilicalEventType(type: string): boolean {
  if (typeof type !== 'string' || type.length === 0) return false
  if (type.startsWith(CUSTOM_EVENT_PREFIX) && type.length > CUSTOM_EVENT_PREFIX.length) return true
  return KNOWN_EVENT_TYPES.has(type)
}

/** Distinct dotted prefixes present in the registry, e.g. `tool`, `binding`. */
export const UMBILICAL_EVENT_PREFIXES: readonly string[] = Array.from(
  new Set(UMBILICAL_EVENT_TYPES.map(type => type.slice(0, type.indexOf('.')))),
).concat('custom')

/** True for `*` and for `<known-prefix>.*` wildcard filter entries. */
export function isUmbilicalEventWildcard(entry: string): boolean {
  if (entry === '*') return true
  if (!entry.endsWith('.*')) return false
  const prefix = entry.slice(0, -2)
  return UMBILICAL_EVENT_PREFIXES.includes(prefix)
}

// ===========================================================================
// Envelope
// ===========================================================================

/**
 * The canonical umbilical event envelope — identical on the per-agent bus,
 * on the daemon bus, and on the wire (`GET /events`).
 *
 * `seq` is the monotonic per-agent sequence number (0 when the event has no
 * owning agent bus). Transport-level resume tokens live outside this envelope
 * (see `DaemonEventEnvelope.cursor`).
 */
export interface UmbilicalEventEnvelope<P = Record<string, unknown>> {
  seq: number
  event_type: string
  timestamp: number
  source: string
  agent_id?: string | null
  payload: P
  /** Reserved: detached signature over the envelope. Unused in Phase 0. */
  sig?: string
}

// ===========================================================================
// Payload shapes for the stable event families
// (docs/guides/umbilical-events.md is the prose counterpart)
// ===========================================================================

export interface ToolEventPayload {
  filePath?: string
  name?: string
  id?: string
  input?: unknown
  result?: unknown
  isError?: boolean
}

export interface TurnCompletedPayload {
  filePath?: string
  content?: string
  targetState?: string
  llm_call?: Record<string, unknown>
}

export interface AgentStateChangedPayload {
  filePath?: string
  state?: string
}

export interface AgentErrorPayload {
  filePath?: string
  event?: unknown
}

export interface AgentLoadedPayload {
  filePath?: string
  name?: string
  handle?: string
  autostart?: boolean
}

export interface AgentUnloadedPayload {
  filePath?: string
}

export interface LlmEventPayload {
  provider?: string
  model?: string
  input_tokens?: number
  output_tokens?: number
  cache_read_tokens?: number
  cache_write_tokens?: number
  reasoning_tokens?: number
  duration_ms?: number
  stop_reason?: string
  cost_usd?: number
  turn_id?: string
  call_source?: string
}

export type LambdaKind = 'ws' | 'sys_lambda' | 'sys_code' | 'middleware' | 'api_route' | 'system_scope' | 'tap'

export interface LambdaEventPayload {
  lambda_path?: string
  function_name?: string
  kind?: LambdaKind | string
  duration_ms?: number
  error?: string
  /** kind === 'ws' */
  connection_id?: string
  /** kind === 'system_scope' */
  trigger?: string
  /** kind === 'tap' */
  tap?: string
}

export interface DbReadPayload {
  sql?: string
  params?: unknown
  row_count?: number
}

export interface DbWritePayload {
  sql?: string
  params?: unknown
  changes?: number
}

export interface FileReadPayload {
  path?: string
  bytes?: number
}

export type FileWrittenPayload = FileReadPayload

export interface FileDeletedPayload {
  path?: string
}

export interface MessageReceivedPayload {
  message_id?: string
  from?: string
  content_type?: string
  size?: number
}

export interface MessageDeliveryPayload {
  message_id?: string
  status_code?: number
}

/**
 * Provenance for a context injection written to the loop (system prompt refresh,
 * dynamic instructions, or an agent `loop_inject`). The raw injected content is
 * deliberately NOT carried — it can hold the full system prompt or user text —
 * only its byte size and category, mirroring config.changed's no-leak policy.
 */
export interface ContextInjectedPayload {
  category?: string
  origin?: string
  key?: string
  delivery?: string
  bytes?: number
}

export interface TriggerFiredPayload {
  trigger_type?: string
  scope?: string
  target_lambda?: string
}

export interface TimerFiredPayload {
  timer_id?: string
  scope?: string
  run_count?: number
  scheduled_at?: number
}

export interface WsOpenedPayload {
  connection_id?: string
  direction?: string
  remote_did?: string
  url_params?: Record<string, unknown>
}

export interface WsClosedPayload extends WsOpenedPayload {
  code?: number
  reason?: string
  duration_ms?: number
}

// --- binding.* (provisional) ----------------------------------------------

export interface BindingEventPayload {
  binding_id?: string
  declaration_id?: string
}

export interface BindingErrorPayload extends BindingEventPayload {
  endpoint?: 'a' | 'b' | string
  direction?: 'a_to_b' | 'b_to_a' | string
  error?: string
}

export interface BindingThresholdExceededPayload extends BindingEventPayload {
  threshold?: string
  observed?: number
  limit?: number
}

export interface BindingFlowSummaryPayload extends BindingEventPayload {
  bytes_a_to_b?: number
  bytes_b_to_a?: number
  /** Frames discarded by backpressure or rate limiting on an unpausable source. */
  frames_dropped?: number
  interval_ms?: number
  status?: string
}

export interface BindingTerminatedPayload extends BindingEventPayload {
  reason?: string
  origin?: string
}
