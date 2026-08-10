/**
 * Umbilical replay buffer — a per-agent, in-memory, bounded ring of recent
 * umbilical events.
 *
 * WHAT THIS IS FOR: exactly one thing — closing the reconnect gap in
 * snapshot-then-tail. A remote observer reads agent state through the normal
 * read API, then tails `GET /agents/:id/umbilical/events?since_seq=<n>` instead
 * of reasoning about what it missed while its SSE connection was down.
 *
 * WHAT THIS IS NOT: durable, and not an audit trail. The ring lives in the
 * runtime process and dies with the agent. Nothing is written to the agent's
 * database — an earlier design put these rows in the agent's own `local_*`
 * namespace, which was both a namespace violation (runtime bookkeeping in agent
 * space) and unnecessary: the only consumer re-snapshots on a gap, so durability
 * bought nothing. Verifiable historical audit is a separate, deferred design —
 * see docs/design/sealed-epochs.md.
 *
 * The client contract is therefore: compare your `since_seq` against the
 * `oldest_seq` the endpoint reports. If you have fallen off the back of the
 * window, re-snapshot. Do not build replication on this.
 *
 * The buffer runs in-process at publish time (subscribed by
 * `createUmbilicalLifecycleResource`), so it observes exactly the stream a tap
 * would, keyed by the bus's monotonic per-agent `seq`.
 */

import type { UmbilicalBus, UmbilicalEvent } from './umbilical-bus'
import type { UmbilicalConfig, UmbilicalLogConfig } from '../../shared/types/adf-v02.types'

export const DEFAULT_UMBILICAL_REPLAY_MAX_EVENTS = 2000

/**
 * Always dropped, regardless of config: `turn.delta` is per-token-batch and
 * `binding.flow_summary` is a periodic heartbeat. Configured `exclude_types`
 * are ADDITIVE to these — there is no way to opt back in.
 */
export const ALWAYS_EXCLUDED_EVENT_TYPES: readonly string[] = ['turn.delta', 'binding.flow_summary']

/**
 * Payloads whose JSON serialization exceeds this are replaced by a stub. Kept
 * deliberately: it bounds how much memory one event can pin, and a truncated
 * event still tells the client the event happened — it just has to fetch the
 * detail through the API rather than from the replay window.
 */
export const UMBILICAL_REPLAY_MAX_PAYLOAD_BYTES = 4096
/** Characters of the original serialization kept in the stub's `preview`. */
export const UMBILICAL_REPLAY_PREVIEW_CHARS = 4000

export interface ResolvedUmbilicalReplaySettings {
  maxEvents: number
  /** Built-in exclusions plus configured ones. */
  excludeTypes: Set<string>
}

/** Config → effective settings, or null when the replay window is off (the default). */
export function resolveUmbilicalReplaySettings(
  config: UmbilicalConfig | undefined,
): ResolvedUmbilicalReplaySettings | null {
  const log: UmbilicalLogConfig | undefined = config?.log
  if (!log?.enabled) return null

  const maxEvents = Number.isFinite(log.max_events) && (log.max_events as number) > 0
    ? Math.floor(log.max_events as number)
    : DEFAULT_UMBILICAL_REPLAY_MAX_EVENTS

  return {
    maxEvents,
    excludeTypes: new Set([...ALWAYS_EXCLUDED_EVENT_TYPES, ...(log.exclude_types ?? [])]),
  }
}

/**
 * One retained event. `payload` is the already-truncated PARSED value — either
 * the emitter's own payload object (retained by reference; umbilical payloads
 * are treated as immutable once published) or the truncation stub. Consumers
 * never see a JSON string here.
 */
export interface UmbilicalReplayRecord {
  seq: number
  event_type: string
  timestamp: number
  source: string
  payload: unknown
  truncated: boolean
}

export interface UmbilicalReplayRange {
  oldest_seq: number
  newest_seq: number
}

export interface UmbilicalReplayBufferOptions {
  agentId: string
  settings: ResolvedUmbilicalReplaySettings
}

export class UmbilicalReplayBuffer {
  readonly agentId: string
  private readonly settings: ResolvedUmbilicalReplaySettings

  /**
   * Circular ring. Grows by `push` until it reaches `maxEvents`, then overwrites
   * the slot at `start` — so eviction is O(1) and never memmoves the window.
   */
  private items: UmbilicalReplayRecord[] = []
  private start = 0
  private unsubscribe: (() => void) | null = null

  constructor(options: UmbilicalReplayBufferOptions) {
    this.agentId = options.agentId
    this.settings = options.settings
  }

  get maxEvents(): number {
    return this.settings.maxEvents
  }

  /** Events currently retained. */
  get size(): number {
    return this.items.length
  }

  attach(bus: UmbilicalBus): void {
    if (this.unsubscribe) return
    this.unsubscribe = bus.subscribe(event => { this.record(event) })
  }

  /** Stop listening. The window stays readable until the buffer is dropped. */
  detach(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  /** Public for tests; normally driven by `attach`. */
  record(event: UmbilicalEvent): void {
    if (this.settings.excludeTypes.has(event.event_type)) return
    const { payload, truncated } = truncatePayload(event.payload)
    const record: UmbilicalReplayRecord = {
      seq: event.seq,
      event_type: event.event_type,
      timestamp: event.timestamp,
      source: event.source,
      payload,
      truncated,
    }
    if (this.items.length < this.settings.maxEvents) {
      this.items.push(record)
      return
    }
    this.items[this.start] = record
    this.start = (this.start + 1) % this.items.length
  }

  /** Events with `seq` strictly greater than `sinceSeq`, oldest first. */
  getSince(sinceSeq: number, limit: number): UmbilicalReplayRecord[] {
    const out: UmbilicalReplayRecord[] = []
    if (limit <= 0) return out
    for (let i = 0; i < this.items.length; i++) {
      const record = this.at(i)
      if (record.seq <= sinceSeq) continue
      out.push(record)
      if (out.length >= limit) break
    }
    return out
  }

  /**
   * The retained window, or null when empty. A client whose cursor sits below
   * `oldest_seq - 1` has fallen off the back and must re-snapshot.
   */
  range(): UmbilicalReplayRange | null {
    if (this.items.length === 0) return null
    return { oldest_seq: this.at(0).seq, newest_seq: this.at(this.items.length - 1).seq }
  }

  /** Test/diagnostic helper. */
  clear(): void {
    this.items = []
    this.start = 0
  }

  /** Logical index → physical slot. Index 0 is the oldest retained event. */
  private at(index: number): UmbilicalReplayRecord {
    return this.items[(this.start + index) % this.items.length]
  }
}

/**
 * Build a buffer if the agent opted in, otherwise null. The only construction
 * path used in production (`createUmbilicalLifecycleResource`).
 */
export function createUmbilicalReplayBuffer(options: {
  agentId: string
  config: UmbilicalConfig | undefined
}): UmbilicalReplayBuffer | null {
  const settings = resolveUmbilicalReplaySettings(options.config)
  if (!settings) return null
  return new UmbilicalReplayBuffer({ agentId: options.agentId, settings })
}

/**
 * Bound what one event can pin. Oversize payloads become a stub rather than a
 * blindly-sliced string, so the shape stays an object either way.
 */
export function truncatePayload(payload: unknown): { payload: unknown; truncated: boolean } {
  let raw: string
  try {
    raw = JSON.stringify(payload ?? {}) ?? '{}'
  } catch {
    // Circular or otherwise unserializable — still record that the event happened.
    return { payload: { _truncated: true, preview: '[unserializable payload]' }, truncated: true }
  }
  if (Buffer.byteLength(raw, 'utf8') <= UMBILICAL_REPLAY_MAX_PAYLOAD_BYTES) {
    return { payload: payload ?? {}, truncated: false }
  }
  return {
    payload: { _truncated: true, preview: raw.slice(0, UMBILICAL_REPLAY_PREVIEW_CHARS) },
    truncated: true,
  }
}

// =============================================================================
// Per-agent registry
// =============================================================================

/**
 * Mirrors the umbilical bus registry. The catch-up endpoint reaches the buffer
 * through this rather than through a host-specific handle, so the daemon
 * (AgentRuntimeBuilder), the Studio background manager, and the Studio
 * foreground IPC path all serve the same window without extra plumbing.
 */
const registry = new Map<string, UmbilicalReplayBuffer>()

export function getUmbilicalReplayBuffer(agentId: string): UmbilicalReplayBuffer | undefined {
  return registry.get(agentId)
}

export function registerUmbilicalReplayBuffer(agentId: string, buffer: UmbilicalReplayBuffer): void {
  registry.set(agentId, buffer)
}

export function unregisterUmbilicalReplayBuffer(agentId: string): void {
  registry.delete(agentId)
}

/** Test-only helper. */
export function clearAllUmbilicalReplayBuffers(): void {
  registry.clear()
}
