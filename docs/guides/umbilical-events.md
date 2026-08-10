# Umbilical Event Taxonomy

Reference for every event type the runtime publishes to the umbilical. Events
flow to agent taps via the per-agent UmbilicalBus and to external `/events`
SSE subscribers via the daemon bus.

Every event has this envelope. It is the *same object* on the per-agent bus, on
the daemon bus, and on the `/events` wire — there is no second, daemon-specific
shape:

```typescript
interface UmbilicalEvent {
  seq: number              // monotonic per-agent (0 when there is no owning agent bus)
  event_type: string       // dotted path, see below
  timestamp: number        // epoch ms
  source: string           // agent:<turn>, lambda:<file>:<fn>, system:<subsystem>
  agent_id?: string | null // owning agent; null for daemon-scope events
  payload: Record<string, unknown>
  sig?: string             // reserved: detached signature over the envelope
}
```

`source` is a first-class envelope field. It is **not** folded into `payload`
on any transport.

`GET /events` wraps this envelope in a transport frame carrying a resume
cursor: `{ cursor, event }`. `cursor` is a per-daemon-process counter used only
for `?since=` replay; per-agent ordering lives on `event.seq`. See
[http-api.md](../daemon/http-api.md#get-events).

## Typed registry

`src/shared/types/umbilical-events.ts` is the machine-readable counterpart to
this document: `UMBILICAL_EVENT_TYPES` lists every type the runtime emits, and
`isKnownUmbilicalEventType()` also accepts the open `custom.*` namespace.

A CI guard (`tests/unit/umbilical-event-registry.test.ts`) fails the build if a
runtime emit site uses a type that is not in the registry. Tap and stream-binding
filters naming an unknown type produce a **warning**, never a validation error —
filters must stay forward-compatible with newer runtimes.

## Stability

Event types in the tables below labelled **stable** commit to their payload
field names and semantics — taps that filter on these will not break across
minor versions. Events labelled **provisional** may refine their payload
shape as taps shake out real-world use.

Adding a new field to a stable payload is non-breaking. Removing or renaming
one requires a major version bump in the umbilical contract.

---

## `tool.*` — stable

Every built-in and MCP tool invocation the agent performs.

| Event | Payload |
|---|---|
| `tool.started` | `{ filePath, name, id, input }` |
| `tool.completed` | `{ filePath, name, id, result, isError: false }` |
| `tool.failed` | `{ filePath, name, id, result, isError: true }` |

`result` mirrors the `ToolResult` shape (`{ content, isError }`). LLM-driven
tool calls emit with `source: "agent:<turn_id>"`; code-driven tool calls
(sandbox `adf.*` methods) emit with `source: "lambda:<file>:<fn>"`.

## `turn.*` — stable

| Event | Payload |
|---|---|
| `turn.completed` | `{ filePath, content, targetState, llm_call? }` |

Fired when the LLM loop finishes a turn (end-of-turn signal or tool-driven
stop). `content` is the final assistant text for this turn.

## `agent.*` — stable

| Event | Payload |
|---|---|
| `agent.state.changed` | `{ filePath, state }` |
| `agent.error` | `{ filePath, event }` |
| `agent.loaded` | `{ filePath, name, handle, autostart }` |
| `agent.unloaded` | `{ filePath }` |
| `agent.event` | `{ event }` (raw forwarded executor event envelope) |

## `llm.*` — stable

Every completed model call, including regular turns, compaction calls, and
`adf.model_invoke`.

| Event | Payload |
|---|---|
| `llm.completed` | `{ provider, model, input_tokens, output_tokens, cache_read_tokens?, cache_write_tokens?, reasoning_tokens?, duration_ms, stop_reason, cost_usd?, turn_id?, call_source }` |
| `llm.failed` | Same payload, with `stop_reason: "error"` |

`call_source` is one of `turn`, `compaction`, `model_invoke`, or another
runtime source label. The event envelope's `source` remains the provenance
that caused the call (`agent:<turn>`, `lambda:<file>:<fn>`, etc.).

## `lambda.*` — stable

Every lambda invocation: WS handlers, sys_lambda, middleware, API routes,
system-scope trigger/timer lambdas, and tap lambdas.

| Event | Payload |
|---|---|
| `lambda.started` | `{ lambda_path, function_name, kind, ...kind-specific }` |
| `lambda.completed` | `{ lambda_path, function_name, kind, duration_ms, ...kind-specific }` |
| `lambda.failed` | `{ lambda_path, function_name, kind, duration_ms?, error, ...kind-specific }` |

`kind` is one of `ws`, `sys_lambda`, `middleware`, `api_route`, `system_scope`, `tap`.

Kind-specific fields:
- `ws` — `connection_id`
- `system_scope` — `trigger` (the trigger name that fired this lambda)
- `tap` — `tap` (the tap name)

## `db.*` — stable

Every read/write through the `db_query` / `db_execute` tools.

| Event | Payload |
|---|---|
| `db.read` | `{ sql, params, row_count }` |
| `db.write` | `{ sql, params, changes }` |

**No `table` field.** Parsing a table name from arbitrary SQL via regex
silently lies on edge cases (subqueries, joins, CTEs). Taps filter by SQL
substring when they need table-level granularity:

```ts
when: "event.payload.sql.includes('local_orders')"
```

Agents that need precise table parsing can do it properly inside the tap
lambda.

## `file.*` — stable

Filesystem tool calls against the agent's `adf_files` table.

| Event | Payload |
|---|---|
| `file.read` | `{ path, bytes }` |
| `file.written` | `{ path, bytes }` |
| `file.deleted` | `{ path }` |

## `message.*` — stable

Inbox and outbox lifecycle.

| Event | Payload |
|---|---|
| `message.received` | `{ message_id, from, content_type, size }` |
| `message.sent` | `{ message_id, status_code }` |
| `message.delivery_failed` | `{ message_id, status_code }` |

`message.sent` fires on terminal success from any transport (local, WS, HTTP,
adapter). `message.delivery_failed` fires on terminal failure after retries.

## `trigger.*` — stable

| Event | Payload |
|---|---|
| `trigger.fired` | `{ trigger_type, scope, target_lambda }` |

## `timer.*` — stable

| Event | Payload |
|---|---|
| `timer.fired` | `{ timer_id, scope, run_count, scheduled_at }` |

## `ws.*` — provisional

WebSocket lifecycle. Per-frame events are intentionally not emitted — use
`tool.completed` filtered on `tool === 'ws_send'` for outbound frame
observability.

| Event | Payload |
|---|---|
| `ws.opened` | `{ connection_id, direction, remote_did, url_params }` |
| `ws.closed` | `{ connection_id, direction, remote_did, code, reason, duration_ms }` |

## `binding.*` — provisional

Stream-binding lifecycle, emitted by the stream binding manager with
`source: "system:stream_bind"`. Payload shapes may still gain fields as
declarative bindings mature.

| Event | Payload |
|---|---|
| `binding.created` | `{ binding_id, a, b, bidirectional, origin, declaration_id, options }` |
| `binding.materialized` | `{ binding_id, declaration_id }` |
| `binding.pending` | `{ binding_id, declaration_id, a, b, reason }` |
| `binding.reconnecting` | `{ binding_id, declaration_id, reason }` |
| `binding.error` | `{ binding_id, endpoint?, direction?, error }` |
| `binding.threshold_exceeded` | `{ binding_id, threshold, observed, limit }` |
| `binding.flow_summary` | `{ binding_id, bytes_a_to_b, bytes_b_to_a, interval_ms, status }` |
| `binding.terminated` | `{ binding_id, reason, origin, declaration_id }` |

Notes:
- `a` / `b` are summarised endpoint descriptors, not live handles.
- `origin` is `declarative` (from `stream_bindings` in the ADF) or `imperative`
  (from a runtime `stream_bind` call). Only declarative bindings emit
  `binding.materialized`, `binding.pending`, and `binding.reconnecting`.
- `binding.error` carries `endpoint: 'a' | 'b'` for endpoint-level failures and
  `direction: 'a_to_b' | 'b_to_a'` for copy failures — never both.
- `threshold` on `binding.threshold_exceeded` names which limit tripped
  (`max_bytes`, `max_duration_ms`, `idle_timeout_ms`), with `observed` vs `limit`.
- `binding.flow_summary` fires on the `flow_summary_interval_ms` timer and once
  more immediately before termination.

## `adapter.*` / `mcp.*` — stable

Forwarded from channel-adapter and MCP server managers. See
[http-api.md](../daemon/http-api.md) for payload shapes.

## `daemon.*` — stable

Runtime startup events.

| Event | Payload |
|---|---|
| `daemon.started` | `{ host, port, settingsPath }` |
| `daemon.autostart.report` | `{ report }` |

## `custom.*` — agent-defined

Anything emitted by agent code via `adf.emit_event`. The `custom.` prefix is
reserved for agent-authored events — the runtime will never emit a
`custom.*` event. This namespacing prevents agents from spoofing
runtime-emitted events.

See [umbilical.md](./umbilical.md) for the emission API.

## Reserved types

These types are declared in the registry but are **not emitted yet** — they are
reserved by later phases of the umbilical overhaul. Filters may name them today
without triggering an unknown-type warning; taps simply never fire until the
emitting phase lands.

| Type | Phase | Intent |
|---|---|---|
| `hil.requested` / `hil.resolved` | 1 | Human-in-the-loop request opened / answered |
| `ask.requested` / `ask.resolved` | 1 | Agent-to-human question opened / answered |
| `suspend.requested` / `suspend.resolved` | 1 | Turn suspension requested / released |
| `config.changed` | 2 | Agent config mutated at runtime |
| `loop.compacted` | 2 | Conversation loop compaction completed |
| `loop.cleared` | 2 | Conversation loop cleared |
| `loop.recovered` | 2 | Loop recovered from an interrupted turn checkpoint |
| `message.queued` | 2 | Outbound message accepted into the delivery queue |
| `trigger.dropped` | 2 | Trigger discarded (rate limit, disabled scope, backpressure) |
| `ws.reconnecting` | 2 | WebSocket connection entering reconnect backoff |
| `turn.delta` | 5 | Incremental turn output (streaming) |
| `umbilical.checkpoint` | 5 | Periodic sequence checkpoint for durable replay |

Payload shapes for reserved types are defined by the phase that starts emitting
them; do not depend on speculative fields.
