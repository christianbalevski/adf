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

Every built-in and MCP tool invocation, from every caller.

| Event | Payload |
|---|---|
| `tool.started` | `{ filePath, name, id?, input }` |
| `tool.completed` | `{ filePath, name, id?, result, isError: false }` |
| `tool.failed` | `{ filePath, name, id?, result, isError: true }` |

Emitted from `ToolRegistry.executeTool`, the single choke point every caller
funnels through — the LLM tool loop, sandboxed code (`adf.*`), and the shell
pipeline all emit identically. `source` distinguishes them: LLM-driven calls
carry `source: "agent:<turn_id>"`, code-driven calls
`source: "lambda:<file>:<fn>"`.

Guarantees:
- Exactly one `tool.started` and exactly one `tool.completed`/`tool.failed`
  per invocation, including unknown tools, schema-validation failures, and
  calls that fail by throwing.
- `id` is the LLM `tool_use.id`. It is **absent** on code-driven and
  shell-driven calls, which have no such id — never key on it being present.
- `input` has the runtime's internal flags (`_authorized`,
  `_protection_override`, `_full`, `_async`) stripped.
- `result.content` is truncated to ~16 KB. Taps are observers, not sinks — read
  the tool's real output from the loop if you need all of it.
- A protection denial that a human overrides produces **two** pairs for one
  `tool_use.id`: the denied execution and the approved re-execution. Two
  executions really did happen.

Tool outcomes the loop synthesizes without ever calling a tool — the `ask`
intercept, a disabled-tool rejection, a HIL denial, and the task reference
returned by an `_async` call — also emit a pair, so every result the model sees
is observable.

## `turn.*` — stable

| Event | Payload |
|---|---|
| `turn.completed` | `{ filePath, content, targetState, llm_call? }` |
| `turn.delta` | `{ kind: 'text' \| 'thinking', text }` — **opt-in**, see below |

`turn.completed` fires when the LLM loop finishes a turn (end-of-turn signal or
tool-driven stop). `content` is the final assistant text for this turn.

`turn.delta` is **off by default** — streaming every flushed batch is high
volume and most taps only want finished output. Enable it per agent:

```yaml
umbilical:
  stream_deltas: true
```

One event fires per flushed delta batch (not per token), with `text` being the
concatenated deltas in that batch. Adjacent same-kind deltas are coalesced;
mixed `[thinking, text, thinking]` stays three ordered events.

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

`kind` is one of `ws`, `sys_lambda`, `sys_code`, `middleware`, `api_route`,
`system_scope`, `tap`.

Kind-specific fields:
- `ws` — `connection_id`
- `system_scope` — `trigger` (the trigger name that fired this lambda)
- `tap` — `tap` (the tap name)
- `sys_code` — no `lambda_path` / `function_name`: inline sandboxed code has no
  backing file. Correlate via the enclosing `tool.*` pair for `sys_code`.

## `db.*` — stable

Every read/write through the `db_query` / `db_execute` tools — which is every
agent-driven SQL path, since sandboxed `adf.db_query(...)` calls and shell
`select`/`sql` commands all route through those same tools.

Emission stays at the tool layer rather than moving to
`AdfWorkspace.executeSQL` / `querySQL`, because those methods are also called
by Studio's table browser and by workspace clone/migration plumbing. Moving
emission down would fire `db.read` on every UI table click and every migration
`DROP TABLE` — noise from callers that are not the agent operating on its data.

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

Changes to the agent's `adf_files` table.

| Event | Payload |
|---|---|
| `file.read` | `{ path, bytes }` |
| `file.written` | `{ path, bytes }` |
| `file.deleted` | `{ path }` |

`file.written` and `file.deleted` are emitted from `AdfWorkspace`, so they cover
every writer — the `fs_write`/`fs_delete` tools, shell redirects, and sandboxed
code alike — including writes to the `README.md` / `document.md` / `mind.md`
aliases, which route through the same choke point.

`file.read` is emitted by the `fs_read` tool only, *not* from
`AdfWorkspace.readFile`. That method also backs internal machinery (lambda
source loading, prompt file injection), and emitting there would drown taps in
reads the agent never asked for.

## `message.*` — stable

Inbox and outbox lifecycle.

| Event | Payload |
|---|---|
| `message.received` | `{ message_id, from, content_type, size }` |
| `message.queued` | `{ message_id, to }` |
| `message.sent` | `{ message_id, status_code }` |
| `message.delivery_failed` | `{ message_id, status_code }` |

`message.queued` fires when a message is accepted into the outbox, before any
delivery attempt. `message.sent` fires on terminal success from any transport
(local, WS, HTTP, adapter). `message.delivery_failed` fires on terminal failure
after retries.

## `trigger.*` — stable

| Event | Payload |
|---|---|
| `trigger.fired` | `{ trigger_type, scope, target_lambda }` |
| `trigger.dropped` | `{ trigger_type?, reason, dropped? }` |

`trigger.dropped` makes discarded work visible — the agent never sees these, so
without the event they are invisible. `reason` is one of:

| `reason` | Meaning |
|---|---|
| `interval` | Rate-limited away by a target's `interval_ms` window |
| `superseded` | A queued latest-wins trigger (`inbox`, `file_change`) was evicted by a newer one. Owner inbox messages are never evicted |
| `hibernate` | The queued backlog was discarded on a non-idle state transition. Carries `dropped` (how many) instead of `trigger_type` |

## `timer.*` — stable

| Event | Payload |
|---|---|
| `timer.fired` | `{ timer_id, scope, run_count, scheduled_at }` |

## `hil.*` — stable

Human-in-the-loop approvals. `request_id` and `task_id` are the same value (the
`adf_tasks` row id) — both are present so consumers can key on either.

| Event | Payload |
|---|---|
| `hil.requested` | `{ request_id, task_id, tool, reason, input }` |
| `hil.resolved` | `{ request_id, task_id, approved, feedback?, timed_out? }` |

`reason` is one of:

| `reason` | Raised by |
|---|---|
| `restricted` | A tool declared `restricted: true` in the agent config |
| `protection` | A data-protection denial (locked file, meta key, or config field) that a human may override |
| `shell_gate` | A tool gated inside a shell pipeline preflight |

`input` has internal flags stripped, same as `tool.*`.

`timed_out: true` marks an auto-deny: no human decided within the timeout.
`approved` is then always `false`. "Approve all" emits one `hil.resolved` per
approved task; it never batches protection overrides, which stay individual.

Every `hil.requested` is followed by exactly one `hil.resolved`, including the
non-blocking `_async` approval flows where the request and the resolution are
turns apart.

## `ask.*` — stable

The `ask` tool: the agent asking its human a question and blocking on the answer.

| Event | Payload |
|---|---|
| `ask.requested` | `{ request_id, question }` |
| `ask.resolved` | `{ request_id, has_response, response_length, preview? }` |

The human's answer is **not** put on the wire in full. Taps get its shape —
`has_response`, `response_length`, and a `preview` truncated to 200 characters
(absent on an empty answer). A tap that legitimately needs the whole answer
reads it from the loop.

## `suspend.*` — stable

The owner decision raised when an agent hits `limits.max_active_turns`.

| Event | Payload |
|---|---|
| `suspend.requested` | `{ reason }` |
| `suspend.resolved` | `{ resumed, timed_out? }` |

`resumed: true` means resume the agent; `false` means shut down. A suspend that
nobody answers before `limits.suspend_timeout_ms` resolves
`{ resumed: false, timed_out: true }`.

## `config.changed` — stable

Fires whenever the agent config is written back to the workspace.

| Event | Payload |
|---|---|
| `config.changed` | `{ updated_at, changed_keys }` |

`changed_keys` lists the **names** of top-level `AgentConfig` keys whose JSON
representation differs from the previous config (a shallow diff — nested edits
surface as the containing top-level key).

**Values are never included.** Config holds provider API keys, adapter tokens,
and MCP credentials; a tap or an external `/events` subscriber learns *that*
`providers` changed, never to what.

## `loop.*` — stable

Conversation-loop lifecycle. These are the events that explain a discontinuity
in an agent's history.

| Event | Payload |
|---|---|
| `loop.compacted` | `{ reason, new_token_count }` |
| `loop.cleared` | `{ method: 'clear' \| 'replace' }` |
| `loop.recovered` | `{ reason: 'stale_checkpoint' \| 'malformed_checkpoint' }` |

`loop.compacted` fires after a successful compaction — from the automatic
top-of-loop guard, the pre-flight context guard, or the voluntary `loop_compact`
tool. `reason` is the human-readable trigger.

`loop.cleared` distinguishes a wipe (`clear`) from an atomic rewrite
(`replace`, e.g. stripping provider-incompatible blocks from history).

`loop.recovered` fires at load time when a durable turn checkpoint was left
`in_progress` by a crash, reload, or hard shutdown. The trigger is deliberately
**not** replayed — duplicate timer and tool side effects are unsafe — so this
event marks a turn that was cut off, not one that resumed.

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
| `ws.reconnecting` | 2 | WebSocket connection entering reconnect backoff |
| `umbilical.checkpoint` | 5 | Periodic sequence checkpoint for durable replay |

Payload shapes for reserved types are defined by the phase that starts emitting
them; do not depend on speculative fields.
