# Umbilical Event Taxonomy

Reference for every event type the runtime publishes to the umbilical. Events
flow to agent taps via the per-agent UmbilicalBus and to external `/events`
SSE subscribers via the daemon bus.

Every event has this envelope:

```typescript
interface UmbilicalEvent {
  seq: number              // monotonic per-agent
  event_type: string       // dotted path, see below
  timestamp: number        // epoch ms
  source: string           // agent:<turn>, lambda:<file>:<fn>, system:<subsystem>
  payload: Record<string, unknown>
}
```

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
