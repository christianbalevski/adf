# The Umbilical

The umbilical is a real-time stream of events describing an agent's own
activity, consumable by **taps** — warm lambdas that run inside the agent's
sandbox and receive matching events with low latency.

Every meaningful runtime action — tool call, LLM turn, DB read/write, file
I/O, message delivery, trigger fire, timer fire, WS open/close, lambda
invocation — emits an event. Taps filter, transform, forward, aggregate, or
react using the full `adf.*` API.

For the full catalog of event types and payload shapes, see
[umbilical-events.md](./umbilical-events.md).

---

## Why

Three things agents previously couldn't do without instrumenting every call
site by hand:

- **Real-time replication.** Forward every `db.write` against `local_orders`
  to a peer agent — see the canonical recipe below.
- **Cross-agent tracing.** A tap on `tool.completed` that emits
  `custom.trace.span` to the daemon bus via `/events` forwarding.
- **Self-optimization.** A tap on `turn.completed` that watches token
  usage and suggests compaction when thresholds are crossed.

The underlying primitive is broader than any one of these — streams,
replication, monitoring, and governance are all taps.

---

## Tap configuration

Add `umbilical_taps` to your agent config:

```jsonc
{
  "umbilical_taps": [
    {
      "name": "order_replicator",
      "lambda": "lib/replicator.ts:onEvent",
      "filter": {
        "event_types": ["db.write"],
        "when": "event.payload.sql.includes('local_orders')"
      }
    }
  ]
}
```

Fields:

| Field | Required | Default | Description |
|---|---|---|---|
| `name` | Yes | — | Unique identifier for this tap |
| `lambda` | Yes | — | `file:function` ref; function runs with event as first arg |
| `filter.event_types` | No | `["*"]` | Exact match or prefix (`"tool.*"`). `"*"` and bare prefixes require `allow_wildcard: true` |
| `filter.when` | No | — | Expression over `event`; same semantics as trigger `when` |
| `filter.allow_wildcard` | No | `false` | Explicit opt-in for wildcard filters |
| `exclude_own_origin` | No | `true` | Suppress dispatch when `event.source` equals `"lambda:<this tap's lambda>"` |
| `max_rate_per_sec` | No | `100` | Token-bucket cap; overruns drop and log |

Taps are **warm**. The lambda sandbox persists for the agent's lifetime and
module-level state is shared across events — critical for batching, caching,
or maintaining in-memory queues.

---

## Lambda contract

```typescript
// lib/replicator.ts
import type { UmbilicalEvent } from '../types'

// Module-level state survives every invocation.
const pending: unknown[] = []

export async function onEvent(event: UmbilicalEvent): Promise<void> {
  // Filter handled at config level; this function only sees matching events.
  pending.push(event.payload)
  // ...
}
```

Event shape:

```typescript
interface UmbilicalEvent {
  seq: number              // monotonic per-agent
  event_type: string
  timestamp: number        // epoch ms
  source: string           // agent:<turn>, lambda:<file>:<fn>, system:<subsystem>
  payload: Record<string, unknown>
}
```

---

## Loop protection

Taps that act on events generate new events. Three layered mechanisms stop
infinite loops:

1. **`exclude_own_origin` (default `true`).** When the tap's own action
   produces an event, the bus suppresses redelivery to the same tap by
   comparing `event.source` to `"lambda:<this tap's lambda>"`.
2. **`max_rate_per_sec` token bucket.** Backstop for multi-hop loops
   (tap A fires tap B fires tap A) and for filter mistakes. Overruns are
   dropped and logged.
3. **Wildcard opt-in.** `"*"` or bare-prefix filters (`"tool.*"`) require
   `allow_wildcard: true` explicitly. This is a code-review signal, not a
   functional guard.

### Wildcard taps and `lambda.*`

A tap subscribed to `"*"` or `"lambda.*"` matches its own invocation because
tap invocations produce `lambda.started/completed/failed` events.
`exclude_own_origin` catches the direct case — but if the tap does something
that causes another lambda to run, that lambda's events pass the filter and
fan back through the rate limiter.

The safe pattern is to exclude `lambda.*` explicitly in your `when` clause:

```jsonc
{
  "name": "universal_observer",
  "lambda": "lib/trace.ts:onEvent",
  "filter": {
    "event_types": ["*"],
    "allow_wildcard": true,
    "when": "!event.event_type.startsWith('lambda.')"
  }
}
```

---

## Custom events

Agent code emits events with `adf.emit_event`:

```typescript
await adf.emit_event({
  event_type: 'custom.signal.regime_change',
  payload: { regime: 'risk_off', confidence: 0.82 }
})
```

The `custom.` prefix is **required** — agents cannot spoof runtime-emitted
events. The emit helper stamps `source` from the AsyncLocalStorage context
automatically (either `agent:<turn_id>` or `lambda:<file>:<fn>` depending on
where the code is running).

---

## Canonical durable-tap recipe — DB replication

The umbilical is **best-effort**. Events can drop on throttle, be lost
during agent downtime, or be dropped when a tap handler throws. Taps that
need at-least-once delivery implement durability themselves.

The pattern: buffer events into a `local_*` table, process in a separate
flush loop, delete on ack. If the process crashes mid-flush, queued rows
persist and flush retries them on next startup.

### Tap 1 — enqueue (synchronous, narrow, cannot lose events)

```typescript
// lib/replication-queue.ts
export async function enqueue(event: UmbilicalEvent): Promise<void> {
  // Single INSERT. If this fails the event is lost — but db writes are
  // synchronous and reliable locally, so the failure mode is narrow.
  await adf.db_execute({
    sql: `INSERT INTO local_replication_queue (seq, payload_json, enqueued_at)
          VALUES (?, ?, ?)`,
    params: [event.seq, JSON.stringify(event.payload), Date.now()]
  })
}
```

Config:

```jsonc
{
  "umbilical_taps": [
    {
      "name": "replication_enqueue",
      "lambda": "lib/replication-queue.ts:enqueue",
      "filter": {
        "event_types": ["db.write"],
        "when": "event.payload.sql.includes('local_orders')"
      },
      "max_rate_per_sec": 10000
    }
  ]
}
```

`max_rate_per_sec` is raised far above the default so the enqueue path never
throttles — throttling silently loses events, which defeats durability.

### Table schema

```sql
CREATE TABLE local_replication_queue (
  seq INTEGER PRIMARY KEY,       -- event.seq, monotonic per agent
  payload_json TEXT NOT NULL,
  enqueued_at INTEGER NOT NULL,
  attempt_count INTEGER DEFAULT 0
);
```

`seq` is the primary key — if the same event somehow gets enqueued twice
(e.g. handler retry after a crash between emit and ack), the second INSERT
fails and nothing is duplicated.

### Flush loop — a second tap on `timer.fired`

```typescript
// lib/replication-flush.ts
export async function flushTick(): Promise<void> {
  const pending = await adf.db_query({
    sql: `SELECT seq, payload_json FROM local_replication_queue
          ORDER BY seq ASC LIMIT 100`
  })
  for (const row of pending) {
    try {
      await adf.ws_send({
        connection_id: PEER_CONN_ID,
        data: row.payload_json
      })
      // Ack by delete — if the process crashes before this, the row stays
      // and gets retried on next tick.
      await adf.db_execute({
        sql: `DELETE FROM local_replication_queue WHERE seq = ?`,
        params: [row.seq]
      })
    } catch (err) {
      // Leave the row. Next tick will retry. Consider incrementing
      // attempt_count and dead-lettering beyond a threshold.
      break
    }
  }
}
```

### Why this works under crashes

- The enqueue tap is synchronous: when `adf.db_execute` returns, the row is
  durable in SQLite's WAL.
- The flush tap reads-then-sends-then-deletes. A crash between send and
  delete leaves the row; next flush retries.
- On receiver side, idempotency comes from the `seq` primary key in the
  analogous `local_inbox_seq` table: INSERT OR IGNORE makes duplicates a no-op.
- Replay on restart is automatic — the table is the queue.

This pattern is tested by `tests/integration/umbilical-replication-crash.test.ts`
(Phase 9 crash-during-flush test).

---

## External forwarding

The daemon's `/events` SSE endpoint already serves external observers. The
umbilical feeds from the same bus, so external forwarding isn't automatic —
configure a tap that forwards explicitly via `adf.emit_event` (custom namespace)
or the HTTP tool.

```jsonc
{
  "name": "external_trace",
  "lambda": "lib/forward-external.ts:onEvent",
  "filter": { "event_types": ["tool.*"] }
}
```

Forwarding `tool.*` externally will forward tool parameters — which may
include credentials. Filter or redact in the tap.

---

## Relationship to triggers

Triggers and taps answer different questions and are not collapsing into each
other:

- **Triggers** — named, typed, single-category hooks. "When X happens, do Y."
  `on_inbox`, `on_timer`, `on_document_edit`, `on_tool_call`, etc. Each trigger
  type has a specific event shape appropriate to its category. Good for
  reactive agent logic where the mental model is "run this lambda when that
  thing happens."

- **Umbilical taps** — uniform event-stream subscribers. "Observe every event
  of these types with this shape, wherever it comes from." One event envelope
  (`UmbilicalEvent`), one subscribe API, one dispatch path. Good for
  cross-cutting observability (tracing, replication, monitoring), fleet-scale
  telemetry forwarding, and any workload that wants to treat many event
  categories uniformly.

There is overlap — an `on_inbox` trigger and a tap filtered on
`message.received` can both react to an inbound message. Prefer triggers for
reactive logic (they read more naturally and their filters are
category-specific); prefer taps for observation, forwarding, and anything
that needs to compose across event types.

The two systems will continue to evolve together but separately. Don't look
for a future unification — the uniform envelope is the tap's feature, and
cramming triggers into it would re-introduce the trigger-type schema
variance that makes taps valuable in the first place.
