/**
 * Durable umbilical event log — opt-in, agent-space, ring-capped.
 *
 * WHAT THIS IS NOT: a canonical ADF schema table. The log lives in the agent's
 * own `local_*` namespace — the same namespace `db_execute` writes to — and is
 * created lazily by plain SQL. Nothing in `adf-database.ts` knows about it, no
 * migration creates it, and dropping it is harmless (the next write recreates
 * it, chained from whatever rows remain).
 *
 * WHAT IT IS: a documented convention that turns the best-effort umbilical into
 * something a remote observer can catch up on. The dashboard fetches agent
 * state through the existing read API, then tails
 * `GET /agents/:id/umbilical/events?since_seq=<n>` — snapshot-then-tail, no SSE
 * gap to reason about.
 *
 * The writer runs in-process at publish time (subscribed by
 * `createUmbilicalLifecycleResource`), so it observes exactly the stream a tap
 * would, with the bus's monotonic per-agent `seq` as the primary key.
 *
 * The agent can read its own log with `db_query`. That is deliberate — an agent
 * inspecting its own recent history is the point, not a leak.
 *
 * Rolling hash: each row carries `sha256(prev_rolling_hash + '\n' +
 * seq|event_type|timestamp|source|payload_json)`, payload_json exactly as
 * stored. The chain lives entirely in the rows — nothing else is persisted — so
 * a later attestation phase can verify a range without trusting the writer.
 * Editing or deleting a row from the middle breaks verification from that point
 * on; ring pruning from the front does not (verification starts from a known
 * row's hash).
 *
 * Feedback loops: `db.read` / `db.write` umbilical events are emitted at the
 * TOOL level (Phase 1a), so this runtime-internal SQL emits nothing.
 */

import { createHash } from 'node:crypto'

import type { UmbilicalBus, UmbilicalEvent } from './umbilical-bus'
import type { UmbilicalConfig, UmbilicalLogConfig } from '../../shared/types/adf-v02.types'

export const DEFAULT_UMBILICAL_LOG_TABLE = 'local_umbilical_log'
export const DEFAULT_UMBILICAL_LOG_MAX_EVENTS = 2000

/**
 * Always dropped, regardless of config: `turn.delta` is per-token-batch and
 * `binding.flow_summary` is a periodic heartbeat. Configured `exclude_types`
 * are ADDITIVE to these — there is no way to opt back in.
 */
export const ALWAYS_EXCLUDED_EVENT_TYPES: readonly string[] = ['turn.delta', 'binding.flow_summary']

/** Serialized payloads larger than this are replaced by a truncation stub. */
export const UMBILICAL_LOG_MAX_PAYLOAD_BYTES = 4096
/** Characters of the original serialization kept in the stub's `preview`. */
export const UMBILICAL_LOG_PREVIEW_CHARS = 4000
/** Amortized ring trim, mirroring AdfWorkspace.insertLog's TRIM_INTERVAL. */
export const UMBILICAL_LOG_PRUNE_INTERVAL = 100

/** Table names are interpolated into SQL, so the shape is enforced, not escaped. */
const LOCAL_TABLE_NAME = /^local_[A-Za-z0-9_]+$/

/** The slice of AdfWorkspace the writer needs. Keeps the unit tests cheap. */
export interface UmbilicalLogStore {
  executeSQL(sql: string, params?: unknown[]): { changes: number }
  querySQL(sql: string, params?: unknown[]): unknown[]
  insertLog?(level: string, origin: string | null, event: string | null, target: string | null, message: string, data?: unknown): void
}

export interface ResolvedUmbilicalLogSettings {
  table: string
  maxEvents: number
  /** Built-in exclusions plus configured ones. */
  excludeTypes: Set<string>
}

/**
 * Config → effective settings, or null when logging is off (the default) or the
 * table name is not in the agent's `local_*` namespace.
 */
export function resolveUmbilicalLogSettings(
  config: UmbilicalConfig | undefined,
  onInvalid?: (message: string) => void,
): ResolvedUmbilicalLogSettings | null {
  const log: UmbilicalLogConfig | undefined = config?.log
  if (!log?.enabled) return null

  const table = log.table ?? DEFAULT_UMBILICAL_LOG_TABLE
  if (!LOCAL_TABLE_NAME.test(table)) {
    onInvalid?.(`umbilical.log.table "${table}" must start with "local_" — logging disabled.`)
    return null
  }

  const maxEvents = Number.isFinite(log.max_events) && (log.max_events as number) > 0
    ? Math.floor(log.max_events as number)
    : DEFAULT_UMBILICAL_LOG_MAX_EVENTS

  return {
    table,
    maxEvents,
    excludeTypes: new Set([...ALWAYS_EXCLUDED_EVENT_TYPES, ...(log.exclude_types ?? [])]),
  }
}

export interface UmbilicalLogWriterOptions {
  agentId: string
  store: UmbilicalLogStore
  settings: ResolvedUmbilicalLogSettings
}

export class UmbilicalLogWriter {
  private readonly agentId: string
  private readonly store: UmbilicalLogStore
  private readonly settings: ResolvedUmbilicalLogSettings

  private tableReady = false
  private prevHash = ''
  private insertsSincePrune = 0
  private unsubscribe: (() => void) | null = null
  /** One console/adf_logs line per agent, however many writes fail. */
  private failureReported = false
  private failureCount = 0

  constructor(options: UmbilicalLogWriterOptions) {
    this.agentId = options.agentId
    this.store = options.store
    this.settings = options.settings
  }

  get table(): string {
    return this.settings.table
  }

  /** Failed writes since construction. Diagnostics only. */
  get failures(): number {
    return this.failureCount
  }

  attach(bus: UmbilicalBus): void {
    if (this.unsubscribe) return
    this.unsubscribe = bus.subscribe(event => { this.record(event) })
  }

  /**
   * Stop listening and settle the ring. Writes are synchronous (better-sqlite3),
   * so there is no buffer to drain — the final prune is the whole "flush".
   */
  detach(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    if (!this.tableReady) return
    try {
      this.prune()
    } catch (error) {
      this.reportFailure(error)
    }
  }

  /** Public for tests and for the perf harness; normally driven by `attach`. */
  record(event: UmbilicalEvent): void {
    if (this.settings.excludeTypes.has(event.event_type)) return
    try {
      this.ensureTable()
      const { payloadJson, truncated } = serializePayload(event.payload)
      const line = `${event.seq}|${event.event_type}|${event.timestamp}|${event.source}|${payloadJson}`
      const rollingHash = sha256Hex(`${this.prevHash}\n${line}`)

      const { changes } = this.store.executeSQL(
        `INSERT OR IGNORE INTO "${this.settings.table}"
           (seq, event_type, timestamp, source, payload_json, truncated, rolling_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [event.seq, event.event_type, event.timestamp, event.source, payloadJson, truncated, rollingHash],
      )
      // A duplicate seq is ignored by SQLite; advancing the chain on a row that
      // was never written would desync every hash after it.
      if (changes <= 0) return

      this.prevHash = rollingHash
      if (++this.insertsSincePrune >= UMBILICAL_LOG_PRUNE_INTERVAL) {
        this.insertsSincePrune = 0
        this.prune()
      }
    } catch (error) {
      this.reportFailure(error)
    }
  }

  /**
   * Lazy DDL plus chain seeding. Reading the last row's hash is what lets a
   * restarted agent (or a second writer over an existing table) continue the
   * same chain instead of starting a new one.
   */
  private ensureTable(): void {
    if (this.tableReady) return
    this.store.executeSQL(
      `CREATE TABLE IF NOT EXISTS "${this.settings.table}" (
         seq INTEGER PRIMARY KEY,
         event_type TEXT NOT NULL,
         timestamp INTEGER NOT NULL,
         source TEXT NOT NULL,
         payload_json TEXT NOT NULL,
         truncated INTEGER NOT NULL DEFAULT 0,
         rolling_hash TEXT NOT NULL
       )`,
    )
    const rows = this.store.querySQL(
      `SELECT rolling_hash FROM "${this.settings.table}" ORDER BY seq DESC LIMIT 1`,
    ) as Array<{ rolling_hash?: unknown }>
    const last = rows[0]?.rolling_hash
    this.prevHash = typeof last === 'string' ? last : ''
    this.tableReady = true
  }

  /** Ring trim, same shape as AdfDatabase.trimLogs: count, then delete the tail. */
  private prune(): void {
    const rows = this.store.querySQL(`SELECT COUNT(*) as count FROM "${this.settings.table}"`) as Array<{ count?: number }>
    const count = Number(rows[0]?.count ?? 0)
    if (count <= this.settings.maxEvents) return
    this.store.executeSQL(
      `DELETE FROM "${this.settings.table}"
       WHERE seq <= (SELECT seq FROM "${this.settings.table}" ORDER BY seq DESC LIMIT 1 OFFSET ?)`,
      [this.settings.maxEvents],
    )
  }

  /** Logging must never break emission — swallow, count, report once. */
  private reportFailure(error: unknown): void {
    this.failureCount++
    if (this.failureReported) return
    this.failureReported = true
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[UmbilicalLog] write failed for ${this.agentId} (further failures suppressed):`, error)
    try {
      this.store.insertLog?.('error', 'runtime', 'umbilical_log_write_failed', this.settings.table, message.slice(0, 200))
    } catch { /* non-fatal */ }
  }
}

/**
 * Build a writer if the agent opted in, otherwise null. The only construction
 * path used in production (`createUmbilicalLifecycleResource`).
 */
export function createUmbilicalLogWriter(options: {
  agentId: string
  store: UmbilicalLogStore
  config: UmbilicalConfig | undefined
}): UmbilicalLogWriter | null {
  const settings = resolveUmbilicalLogSettings(options.config, (message) => {
    console.warn(`[UmbilicalLog] ${options.agentId}: ${message}`)
    try {
      options.store.insertLog?.('warn', 'runtime', 'umbilical_log_config_invalid', null, message.slice(0, 200))
    } catch { /* non-fatal */ }
  })
  if (!settings) return null
  return new UmbilicalLogWriter({ agentId: options.agentId, store: options.store, settings })
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/**
 * JSON.stringify, with an oversize payload replaced by a stub rather than a
 * blindly-sliced string (which would not be valid JSON).
 */
export function serializePayload(payload: unknown): { payloadJson: string; truncated: 0 | 1 } {
  let raw: string
  try {
    raw = JSON.stringify(payload ?? {}) ?? '{}'
  } catch {
    // Circular or otherwise unserializable — still record that the event happened.
    return { payloadJson: JSON.stringify({ _truncated: true, preview: '[unserializable payload]' }), truncated: 1 }
  }
  if (Buffer.byteLength(raw, 'utf8') <= UMBILICAL_LOG_MAX_PAYLOAD_BYTES) {
    return { payloadJson: raw, truncated: 0 }
  }
  return {
    payloadJson: JSON.stringify({ _truncated: true, preview: raw.slice(0, UMBILICAL_LOG_PREVIEW_CHARS) }),
    truncated: 1,
  }
}
