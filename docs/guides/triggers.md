---
type: guide
description: Event-driven agent activation — trigger types, targets, scopes, filters, timing modifiers, and lambda event payloads
see_also:
  - timers.md — scheduling the events that fire on_timer
  - tasks.md — the task lifecycle behind on_task_* events
---

# Triggers

Triggers define which external events activate an ADF agent. They determine when your agent wakes up and what it responds to.

## Overview

Triggers are organized by **event type** — what happened — and each trigger has an array of **targets** that define how to respond. Each target specifies an execution scope, optional filters, and an optional timing modifier.

There are eleven trigger types and two execution scopes:

### Trigger Types

| Trigger | Event |
|---------|-------|
| `on_startup` | The agent finishes loading (fires once at boot) |
| `on_inbox` | A message arrives in the agent's inbox |
| `on_outbox` | A message is sent from the agent's outbox |
| `on_file_change` | A watched file is modified |
| `on_chat` | Human sends a chat message in the Loop panel |
| `on_timer` | A scheduled timer fires |
| `on_tool_call` | A matching tool is called during the LLM loop (observational, post-execution) |
| `on_task_create` | A task is created (HIL approval, async dispatch) |
| `on_task_complete` | A matching async task completes |
| `on_logs` | A matching log entry is written to `adf_logs` |
| `on_llm_call` | An LLM request is made (filterable by `provider` and `source`) |

### Execution Scopes

| Scope | Description |
|-------|-------------|
| `system` | Runs a lambda function (fast, cheap, deterministic). Fires in all states except `off`. Requires a `lambda` field referencing the function to call. |
| `agent` | Wakes the LLM loop (smart, expensive, probabilistic). Gated by the agent's current state. |

**Self-generated file events are suppressed by default.** Writes made by an agent turn or one of its lambdas do not fire `on_file_change` unless that target explicitly sets `filter.include_self: true`. This prevents an agent from waking itself forever by writing a watched file. Studio edits, uploads, imports, transfers, deletes, and renames still fire normally.

## Configuration

Triggers are configured in the `triggers` section of the agent config, organized by event type. Each trigger type has an `enabled` flag and an array of `targets`:

```json
{
  "triggers": {
    "on_inbox": {
      "enabled": true,
      "targets": [
        { "scope": "agent", "interval_ms": 30000 }
      ]
    },
    "on_file_change": {
      "enabled": true,
      "targets": [
        { "scope": "agent", "filter": { "watch": "README.md" }, "debounce_ms": 2000 }
      ]
    },
    "on_chat": {
      "enabled": true,
      "targets": [
        { "scope": "agent" }
      ]
    },
    "on_timer": {
      "enabled": true,
      "targets": [
        { "scope": "system" },
        { "scope": "agent" }
      ]
    },
    "on_outbox": { "enabled": false, "targets": [] },
    "on_tool_call": { "enabled": false, "targets": [] },
    "on_task_complete": { "enabled": false, "targets": [] },
    "on_logs": { "enabled": false, "targets": [] }
  }
}
```

A trigger can have **multiple targets**, each with its own scope, filter, and timing. For example, `on_timer` above fires in both system and agent scope.

## Targets

Each target in a trigger's `targets` array has these fields:

| Field | Required | Description |
|-------|----------|-------------|
| `scope` | Yes | `system` or `agent` |
| `filter` | No | Event-specific filter (see [Filters](#filters)) |
| `lambda` | No | System scope only: script entry point (`"path/file.ts:functionName"`) or shell script path (`"jobs/task.sh"`) |
| `command` | No | System scope only: shell command to run when the target fires |
| `warm` | No | System scope only: whether to warm-start the lambda |
| `debounce_ms` | No | Timing modifier (mutually exclusive) |
| `interval_ms` | No | Timing modifier (mutually exclusive) |
| `batch_ms` | No | Timing modifier (mutually exclusive) |
| `batch_count` | No | Fire batch early when N events accumulate (requires `batch_ms`) |

Only **one** timing modifier is allowed per target. `batch_count` is an optional companion to `batch_ms`.

## System scope execution limits

System-scope lambdas run under a timeout and a concurrency cap. Neither is
configurable — both are derived from the trigger type, because a trigger's
shape is a property of the trigger, not of the agent that wired it.

| Trigger | Timeout | Concurrent dispatches |
|---------|---------|-----------------------|
| `on_llm_call`, `on_tool_call`, `on_logs`, `on_file_change` | 30 s, or `limits.execution_timeout_ms` if that is smaller | 1 (strictly serialized) |
| `on_timer`, `on_startup`, `on_inbox`, `on_outbox`, `on_task_create`, `on_task_complete`, `on_chat` | `limits.execution_timeout_ms` | 4 |

The first group fires once per model call, tool call, log row or file write, so
a single burst can produce hundreds of dispatches. Those lambdas are short, and
they are usually accumulators reading and rewriting the same rows — serializing
them makes that correct and bounds worker count at the same time. The 30 s
timeout is a hang detector, not a work budget.

The second group is work the user asked for and may legitimately run for
minutes, so it keeps the agent-wide execution budget.

Concurrency is tracked per **trigger type + executable** (the lambda path, or
the command string). Two different lambdas never throttle each other, and the
same lambda under two different triggers gets two independent lanes. Several
timers pointing at the same lambda deliberately share one lane. Beyond the
concurrency cap, up to 64 dispatches wait; past that a dispatch is dropped,
recorded in `adf_logs` at `error` level, and reported to the host as a failed
trigger. A timer whose dispatch is dropped is rewound rather than consumed.

Shell targets (`command`, or a `.sh` lambda) are exempt from the timeout — the
shell runner takes no deadline — but they are lane-limited like any other
target.

## Filters

Filters narrow when a target fires. Available filter fields depend on the trigger type:

| Trigger | Filter Fields | Description |
|---------|---------------|-------------|
| `on_inbox` | `source`, `sender` | Filter by message source (e.g., `mesh`, `telegram`) or sender DID |
| `on_outbox` | `to` | Filter by recipient DID |
| `on_file_change` | `watch`, `include_self` | `watch` is a glob pattern for file paths (e.g., `README.md`, `data/*`). Set `include_self: true` only for workflows that intentionally react to their own writes. Payload includes a unified diff when available. |
| `on_tool_call` | `tools` | Array of tool name glob patterns (e.g., `["fs_*", "msg_send"]`) |
| `on_task_create` | `tools` | Array of tool name glob patterns |
| `on_task_complete` | `tools`, `status` | Tool name globs and/or task status |
| `on_logs` | `level`, `origin`, `event` | Level array (e.g., `["error"]`), origin/event glob arrays |
| `on_llm_call` | `provider`, `source` | `provider` is a string array of provider display names/ids; `source` is a string array of call origins. A row matches when the event value is in the array. |
| `on_chat` | — | No filters available |
| `on_timer` | — | No filters available |
| `on_startup` | — | No filters available |

### Filter Examples

```json
// Only fire when inbox receives a Telegram message
{ "scope": "agent", "filter": { "source": "telegram" } }

// Only fire when a specific sender messages
{ "scope": "agent", "filter": { "sender": "did:adf:9gvayMZx5m..." } }

// Only fire when README.md changes
{ "scope": "agent", "filter": { "watch": "README.md" }, "debounce_ms": 2000 }

// Reconcile a skill catalog after the agent installs or updates a skill.
// Self-generated file changes are otherwise suppressed.
{
  "scope": "system",
  "lambda": "lib/skill-indexer.ts:refresh",
  "filter": { "watch": "skills/*", "include_self": true },
  "debounce_ms": 250
}

// Fire when any filesystem tool is called
{ "scope": "system", "filter": { "tools": ["fs_*"] } }

// Fire on error logs from serving or lambda origins
{ "scope": "system", "filter": { "level": ["error"], "origin": ["serving", "lambda*"] } }
```

## Timing Modifiers

Each target can use **zero or one** timing modifier. They are mutually exclusive.

### No Modifier (Immediate)

Fire immediately on each event. This is the default when no timing field is specified.

### Debounce

Reset a timer on each new event. Fire once when no events arrive for the specified duration. Good for "wait until they stop typing" behavior.

```json
{ "scope": "agent", "debounce_ms": 2000 }
```

**Example:** With `debounce_ms: 2000` on `on_file_change`, if the user makes edits at 0ms, 500ms, and 1500ms, the trigger fires at 3500ms (1500ms + 2000ms wait).

### Interval

Rate-limit by dropping events that arrive within the interval window.

```json
{ "scope": "agent", "interval_ms": 30000 }
```

**Example:** With `interval_ms: 30000`, the trigger fires at most once every 30 seconds.

**Note:** For `on_inbox`, interval behaves differently — the first event **delays** emission (starts a timer), and subsequent events during the window are absorbed. This batches rapid inbox updates into periodic summaries.

### Batch

Start a timer on the first event. Collect all events during the window. Fire once when the timer expires or when `batch_count` events accumulate, whichever comes first.

```json
{ "scope": "agent", "batch_ms": 5000, "batch_count": 100 }
```

**Example:** Fire after 5 seconds or after 100 events, whichever comes first. If `batch_count` is omitted, the batch fires only when the time window expires.

## on_file_change Payload

When `on_file_change` fires, the trigger payload includes a **unified diff** between the previous file content and the new content (with 3-line context hunks). This allows targets to see exactly what changed without receiving the full file.

```
--- README.md
+++ README.md
@@ -5,3 +5,4 @@
 Some existing content
 More content here
+A newly added line
 Trailing content
```

If the file is too large to diff efficiently (> 1M line-product complexity), or the previous content is unavailable, `diff` will be `null`. The diff is available as `event.data.diff` in lambda event objects.

The event envelope's `source` identifies the mutation origin, such as `agent:<turn-id>`, `lambda:<path>:<function>`, or a host/daemon origin like `system:runtime-api` (or `system:unknown` for an operation without an execution context). Only `agent:*` and `lambda:*` writes count as self-generated and are suppressed unless a target sets `filter.include_self: true`; host/daemon writes (`system:*`, e.g. `system:runtime-api`) are never self-generated and always fire. A system lambda is never re-dispatched for a file change it caused itself, even when `include_self` is enabled. Keep self-watching agent targets narrow and idempotent: an agent-scope target can intentionally react to its own write, then make another write in the resulting turn.

## Scope Rules

### System Scope

System scope targets execute **lambda functions** from the agent's file store. Each target specifies a `lambda` field pointing to a script entry point (e.g., `"lib/router.ts:onMessage"`). The lambda receives a rich event object with access to `adf.*` methods via the sandbox RPC bridge.

Key behaviors:

- **Not gated by agent state** — fires in all states except `off`
- Silently skipped when no lambda or command is specified
- Fast and cheap — no LLM costs
- Good for infrastructure tasks: routing, logging, archiving
- All system-scope executions are logged to `adf_logs`

#### Shell Targets

System targets can run shell code instead of a JS/TS lambda:

- `lambda: "jobs/task.sh"` — runs the script headlessly through the shell runner (no JS shim)
- `command: "<shell command>"` — runs a one-line shell command

Shell targets receive event context as **environment variables** (`$EVENT_TYPE`, `$MSG_ID`, `$TIMER_ID`, `$TIMER_PAYLOAD`, ...) rather than an event object argument. `.ts:function` lambdas still receive the event object described below.

#### Cold vs. Warm Execution

By default, lambdas use **cold execution** — the sandbox worker is created, the lambda runs, and the worker is destroyed. This is safe and isolated but has startup overhead.

Set `warm: true` on a target to use **warm execution** — the worker stays alive between invocations. This is faster for frequently-firing triggers (e.g., timers polling every few seconds) but uses more memory.

```json
{
  "scope": "system",
  "lambda": "lib/router.ts:onMessage",
  "warm": true
}
```

#### Lambda Event Object

Lambda functions receive an `AdfEvent` — a typed envelope with event-specific `data`. The same shape used internally, no transformation. Event data uses existing row types (same shape as `msg_read`, `sys_list_timers`, etc.).

##### Envelope Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique event ID |
| `type` | string | Event type: `"inbox"`, `"outbox"`, `"file_change"`, `"chat"`, `"timer"`, `"tool_call"`, `"task_complete"`, `"log_entry"`, `"startup"` |
| `source` | string | Event origin: `"agent:<turn-id>"`, `"lambda:<path>:<function>"`, `"system:*"`, or `"adapter:<name>"` |
| `time` | string | ISO 8601 timestamp |
| `data` | object | Event-specific payload (typed by `type`) |

##### on_inbox — `event.data.message: InboxMessage`

Same shape as `msg_read` returns. Key fields: `from`, `content`, `id`, `parent_id`, `thread_id`, `source`, `source_context`, `attachments`, `received_at`, `status`.

##### on_outbox — `event.data.message: OutboxMessage`

Same shape as outbox row. Key fields: `from`, `to`, `content`, `created_at`, `status`.

##### on_file_change — `event.data: FileChangeEventData`

| Field | Type | Description |
|-------|------|-------------|
| `path` | string | File path |
| `operation` | string | `"created"`, `"modified"`, or `"deleted"` |
| `mime_type` | string \| null | MIME type |
| `size` | number | File size in bytes |
| `diff` | string \| null | Unified diff (when available, e.g. with debounce) |

No content included — call `adf.fs_read({ path })` if needed.

##### on_chat — `event.data.message: LoopEntry`

Same shape as loop row. Contains `content_json` array with text blocks.

##### on_timer — `event.data.timer: Timer`

Same shape as `sys_list_timers` returns. Key fields: `id`, `schedule`, `payload`, `scope`, `run_count`, `created_at`.

See [Timers > Timer Lambda Execution](timers.md#timer-lambda-execution) for more on timer events.

##### on_tool_call — `event.data: ToolCallEventData`

**Observational hook** — fires AFTER the tool executes (or after HIL denial). Does not block execution or create tasks. Use for logging, metrics, or context injection.

This holds for tools driven through `adf_shell` too: the command runs, then the observer fires. To *block* a tool call, mark the tool `restricted: true` — HIL approval is the gate; `on_tool_call` is the watcher.

| Field | Type | Description |
|-------|------|-------------|
| `toolName` | string | Name of the tool that was called |
| `args` | object | Tool arguments (parsed from JSON). For a shell-driven call this is `{ command, intercepted_by }` — the shell builds tool inputs internally, so the command line is what it can report |
| `origin` | string | Call origin: `"agent"` or `"sys_lambda:lib/something.ts"` |

##### on_task_create — `event.data.task: TaskEntry`

Fires when a task is created (HIL approval, async dispatch). Same shape as task row. Key fields: `id`, `tool`, `args`, `status`, `origin`, `requires_authorization`.

Use this for **external approval routing** — dispatch approval requests to Telegram, multi-agent vote systems, or webhooks when HIL tasks are created.

##### on_task_complete — `event.data.task: TaskEntry`

Same shape as task row. Key fields: `id`, `tool`, `args`, `status`, `result`, `error`, `created_at`, `completed_at`, `origin`.

##### on_logs — `event.data.entry: AdfLogEntry`

Same shape as log row. Key fields: `level`, `origin`, `event`, `target`, `message`, `data`, `created_at`.

**Anti-recursion:** Log entries produced by the `on_logs` handler itself do not re-fire the trigger, preventing infinite loops.

##### Accessing the adf API

Lambda functions have full access to the [`adf` proxy object](adf-object.md) for calling tools, invoking the model, and running other lambdas. All code runs in the [sandbox environment](code-execution.md).

```javascript
// lib/router.ts — Inbox router lambda
export async function onMessage(event) {
  const { from, content, id, source_context } = event.data.message

  if (source_context?.intent === 'urgent') {
    await adf.msg_send({ parent_id: id, payload: `Acknowledged urgent message from ${from}` })
  } else {
    await adf.db_execute({
      sql: 'INSERT INTO local_inbox_log (sender, message, ts) VALUES (?, ?, ?)',
      params: [from, content, Date.now()]
    })
  }
}
```

#### Agent Scope — No Event Object

Agent scope targets do **not** receive the event object directly. Instead, the LLM receives a formatted trigger message as context when the loop wakes. For `on_inbox`, agent scope gets an **inbox summary** (message counts by sender and source) rather than individual message payloads — the agent then uses `msg_read` to fetch messages.

### Agent Scope

Agent scope wakes the LLM loop, transitioning the agent to the active state.

Key behaviors:

- **Gated by current state** — only fires when the state allows it
- Expensive — each activation uses LLM tokens
- Good for reasoning, decision-making, complex tasks

### State Gating

| Current State | System Scope | Agent Scope |
|---------------|-------------|-------------|
| **Active** | Fires | Already running |
| **Idle** | Fires | Fires |
| **Hibernate** | Fires | `on_timer` only |
| **Suspended** | Fires | No |
| **Error** | Fires | No |
| **Off** | No | No |

System scope fires in every state except `off` — including `error` and `suspended`. Agent scope is the only scope the state gate can hold back.

### Firing Order

Both scopes operate independently. When both fire for the same event:

1. Whichever timer (from timing modifiers) expires first goes first
2. Ties go to system scope

## on_inbox Behavior

When `on_inbox` fires, the agent receives an **inbox summary** instead of raw message payloads. The summary includes:

```json
{
  "total": 17,
  "unread": 5,
  "read": 10,
  "archived": 2,
  "unread_by_sender": { "monitor": 3, "telegram:12345": 2 },
  "unread_by_source": { "mesh": 3, "telegram": 2 },
  "oldest_unread_timestamp": 1707000000000
}
```

The agent then uses `msg_read` to fetch and process individual messages. This prevents large message payloads from flooding the trigger context.

## Timer + Trigger Interaction

For timers to execute, a **dual-check** is required:

1. The `on_timer` trigger must be enabled
2. The timer's `scope` field must include a matching scope from the trigger's targets

This dual-check provides a convenient kill switch — disable the `on_timer` trigger to stop all timers without deleting them.

**Example:** A timer with `scope: ["system", "agent"]` will:
- Fire in system scope only if `on_timer` has a target with `scope: "system"`
- Fire in agent scope only if `on_timer` has a target with `scope: "agent"`

## Hibernate Nudge

While an agent is hibernating, agent-scope triggers are suppressed (only `on_timer` reaches the loop). To keep a hibernating agent from going dark indefinitely, the evaluator runs a periodic **hibernate nudge**, configured under `limits.hibernate_nudge`:

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` | Whether the nudge fires at all |
| `interval_ms` | `86400000` (24h) | Idle interval before a nudge fires |

Requirements for a nudge to fire: the agent is in `hibernate`, `hibernate_nudge.enabled` is true, and `on_timer` is enabled. After `interval_ms` elapses with no trigger activity, the evaluator synthesizes an **agent-scope timer event** with a synthetic timer (`timer.id = -1`) whose payload reads *"You have been hibernating for N hours without any triggers…"*, prompting the agent to confirm hibernation, take action, or set a timer. The nudge is polled on the same 5s timer tick.

## Injecting Events Directly (`POST /agents/:id/trigger`)

The daemon endpoint `POST /agents/:id/trigger` dispatches an event **straight into the loop**, bypassing the trigger evaluator entirely — no `enabled` check, no filter matching, no scope routing, and no state gating. It is a direct injection surface for tools and tests, not a way to exercise your trigger config. To verify that a trigger's `enabled`/`filter`/`scope`/state gating behaves as configured, drive the real source event (write the watched file, send the inbox message, etc.) rather than calling this endpoint.

## Deduplication

The trigger evaluator deduplicates pending events in the queue:

- **`on_file_change`** — Multiple rapid file change events for the same path are collapsed
- **`on_inbox`** — Multiple inbox notification events are collapsed (the summary is regenerated at fire time)

## Common Patterns

### Responsive Chat Agent

Agent wakes on direct messages and chat, processes on arrival:

```json
{
  "on_chat": {
    "enabled": true,
    "targets": [{ "scope": "agent" }]
  },
  "on_inbox": {
    "enabled": true,
    "targets": [{ "scope": "agent", "interval_ms": 30000 }]
  }
}
```

### Document Auto-Processor

Agent reacts to document edits with a debounce to avoid reacting to every keystroke:

```json
{
  "on_file_change": {
    "enabled": true,
    "targets": [
      { "scope": "agent", "filter": { "watch": "README.md" }, "debounce_ms": 3000 }
    ]
  }
}
```

### Message Router (System Scope Only)

Script handles incoming messages without waking the LLM:

```json
{
  "on_inbox": {
    "enabled": true,
    "targets": [
      { "scope": "system", "batch_ms": 100 }
    ]
  }
}
```

### Scheduled Worker

Agent only activates on timer, ignores everything else:

```json
{
  "on_timer": {
    "enabled": true,
    "targets": [
      { "scope": "system" },
      { "scope": "agent" }
    ]
  },
  "on_chat": { "enabled": false, "targets": [] },
  "on_inbox": { "enabled": false, "targets": [] },
  "on_file_change": { "enabled": false, "targets": [] }
}
```

### Telegram-Only Inbox Handler

Agent only processes Telegram messages, ignores mesh messages:

```json
{
  "on_inbox": {
    "enabled": true,
    "targets": [
      { "scope": "agent", "filter": { "source": "telegram" }, "interval_ms": 10000 }
    ]
  }
}
```

### Tool Call Observer

System script logs every filesystem tool call (observational — does not block):

```json
{
  "on_tool_call": {
    "enabled": true,
    "targets": [
      { "scope": "system", "filter": { "tools": ["fs_*"] }, "lambda": "lib/observer.ts:onToolCall" }
    ]
  }
}
```

### HIL Approval via Telegram

Mark the tool as restricted (which derives HIL for LLM loop calls), then use `on_task_create` to route approvals externally:

```json
{
  "tools": [{ "name": "fs_write", "enabled": true, "restricted": true }],
  "triggers": {
    "on_task_create": {
      "enabled": true,
      "targets": [{
        "scope": "system",
        "lambda": "lib/hil/dispatcher.ts:onTaskCreate",
        "filter": { "tools": ["*"] }
      }]
    }
  }
}
```

```javascript
// lib/hil/dispatcher.ts
export async function onTaskCreate(event) {
  const { task } = event.data;
  if (!task.requires_authorization) return;

  await adf.msg_send({
    recipient: "telegram:123456789",
    content: `Approve ${task.tool}? Args: ${task.args}\nReply yes/no.`,
    subject: `task:${task.id}`
  });
}
```

### Error Alerter

System lambda fires on error logs, batched to avoid flooding:

```json
{
  "on_logs": {
    "enabled": true,
    "targets": [
      {
        "scope": "system",
        "lambda": "lib/alerter.ts:onError",
        "filter": { "level": ["error"] },
        "batch_ms": 5000,
        "batch_count": 10
      }
    ]
  }
}
```

### Parent-Controlled Remote Shutdown

System-scope lambdas can call `adf.sys_set_state('off')` to guarantee a hard shutdown — the child aborts any in-flight LLM call, unregisters from the mesh, disconnects MCP servers, and stops channel adapters. Combined with DID-based sender verification and authorized code, this is how a parent agent remotely disables a compromised or misbehaving child.

**Child's `on_inbox` trigger:**

```json
{
  "on_inbox": {
    "enabled": true,
    "targets": [
      { "scope": "system", "lambda": "lib/control.js:handleParentControl" },
      { "scope": "agent" }
    ]
  }
}
```

**Child's `lib/control.js` (marked as authorized):**

```javascript
export async function handleParentControl(event = {}) {
  const sender = event?.data?.message?.from || ''
  const subject = event?.data?.message?.subject || ''
  const content = (event?.data?.message?.content || '').trim()

  const trustedParentDid = (await adf.sys_get_meta({ key: 'adf_parent_did' })) || ''
  if (sender !== trustedParentDid) return { acted: false, reason: 'sender_mismatch' }
  if (subject !== 'ADF_CONTROL') return { acted: false, reason: 'subject_mismatch' }
  if (content !== 'OFF') return { acted: false, reason: 'content_mismatch' }

  // Hard off — never deferred. Aborts in-flight LLM call, tears down mesh/MCP/adapters.
  await adf.sys_set_state({ state: 'off', _reason: 'trusted parent control command' })
  return { acted: true }
}
```

The `sys_set_state('off')` call:
- Is **never deferred** — even if the LLM is mid-turn, its HTTP request is aborted and all pending triggers are cleared.
- Triggers centralized teardown — the child is unreachable on the mesh the moment the transition completes.
- Works identically whether the child is in the foreground, background, or was just started fresh. One code path, one guarantee.

Because `control.js` is marked authorized, it bypasses file protection on `last-control-event.txt` (useful for writing tamper-evident shutdown logs) and can call protection-bypass methods if needed. See [Authorized Code](authorized-code.md) for the security model.

## Defaults

New agents come with these trigger defaults:

| Trigger | Default |
|---------|---------|
| `on_inbox` | Enabled, agent scope, **no** timing modifier (fires immediately on each inbox event) |
| `on_file_change` | Enabled, agent scope watching `README.*` with `debounce_ms: 2000` |
| `on_chat` | Enabled, agent scope |
| `on_timer` | Enabled, both system and agent scope |
| `on_task_complete` | **Enabled**, agent scope |
| `on_outbox` | Disabled |
| `on_tool_call` | Disabled |
| `on_task_create` | Disabled |
| `on_logs` | Disabled |
| `on_startup` | Disabled |
| `on_llm_call` | Disabled |
