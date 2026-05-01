# Timers

Timers let agents schedule future events. An agent can set one-time reminders, recurring tasks, or cron-based schedules.

## Overview

Timers are stored in the `adf_timers` table and managed through the `sys_set_timer`, `sys_list_timers`, and `sys_delete_timer` tools. When a timer fires, it delivers its payload to the configured scope handlers — but only if the corresponding `on_timer` trigger is enabled.

## Scheduling Modes

Each timer uses a `schedule` object with a `type` field that selects the scheduling mode. Fields irrelevant to the selected type are silently ignored.

### One-Time (Absolute)

Fire once at a specific timestamp.

```
sys_set_timer({
  schedule: { type: "once", at: 1707300300000 },
  scope: ["agent"],
  payload: "check_results"
})
```

### One-Time (Relative)

Fire once after a delay from now. The runtime converts this to an absolute timestamp on creation.

```
sys_set_timer({
  schedule: { type: "delay", delay_ms: 300000 },
  scope: ["agent"],
  payload: "follow_up"
})
```

### Interval

Fire repeatedly at a fixed interval.

```
sys_set_timer({
  schedule: { type: "interval", every_ms: 3600000 },
  scope: ["system"],
  payload: "health_check"
})
```

Optional fields for interval timers:

| Field | Description |
|-------|-------------|
| `start_at` | First fire time (default: now + `every_ms`) |
| `end_at` | Stop firing after this timestamp |
| `max_runs` | Stop after N executions |

```
sys_set_timer({
  schedule: { type: "interval", every_ms: 30000, max_runs: 100 },
  scope: ["system"],
  payload: "poll_status"
})
```

### Cron

Fire on a cron schedule using standard 5-field cron expressions.

```
sys_set_timer({
  schedule: { type: "cron", cron: "0 9 * * 1-5" },
  scope: ["agent"],
  payload: "daily_report"
})
```

Optional fields for cron timers:

| Field | Description |
|-------|-------------|
| `end_at` | Stop firing after this timestamp |
| `max_runs` | Stop after N executions |

### Cron Expression Reference

```
┌───────────── minute (0-59)
│ ┌───────────── hour (0-23)
│ │ ┌───────────── day of month (1-31)
│ │ │ ┌───────────── month (1-12)
│ │ │ │ ┌───────────── day of week (0-6, Sunday=0)
│ │ │ │ │
* * * * *
```

Common examples:

| Expression | Description |
|------------|-------------|
| `* * * * *` | Every minute |
| `0 * * * *` | Every hour |
| `0 9 * * *` | Daily at 9:00 AM |
| `0 9 * * 1-5` | Weekdays at 9:00 AM |
| `0 0 1 * *` | First of every month |
| `*/15 * * * *` | Every 15 minutes |

## Shared Fields

All scheduling modes support these fields:

| Field | Required | Description |
|-------|----------|-------------|
| `scope` | Yes | Array of scope(s) to fire in: `["system"]`, `["agent"]`, or `["system", "agent"]` |
| `payload` | No | String passed to the handler when the timer fires |
| `lambda` | No | System scope only: script entry point (e.g., `"lib/poller.ts:check"`) |
| `warm` | No | System scope only: keep sandbox worker alive between invocations (default: `false`) |

Timers **own their execution config** — the `lambda` and `warm` fields are stored on the timer itself, not inherited from trigger targets. The `on_timer` trigger config serves purely as a kill-switch gate.

## Timer Lambda Execution

When a timer fires in system scope with a `lambda` field, the runtime executes that lambda function in the [sandbox environment](code-execution.md).

```
sys_set_timer({
  schedule: { type: "interval", every_ms: 60000 },
  scope: ["system"],
  lambda: "lib/monitor.ts:checkHealth",
  warm: true,
  payload: "health_check"
})
```

### Timer Event Object

The lambda function receives an `AdfEvent<'timer'>`. The event data contains the full `Timer` row — same shape as `sys_list_timers` returns.

| Field | Type | Description |
|-------|------|-------------|
| `event.type` | string | Always `"timer"` |
| `event.source` | string | `"agent:<name>"` |
| `event.time` | string | ISO 8601 timestamp |
| `event.data.timer` | Timer | Full timer object: `id`, `schedule`, `payload`, `scope`, `run_count`, `created_at` |

### Example: Health Check Timer

```javascript
// lib/monitor.ts
export async function checkHealth(event) {
  const start = Date.now()

  // Check inbox backlog
  const counts = await adf.msg_list({})
  const unread = JSON.parse(counts).unread ?? 0

  // Check loop size
  const config = await adf.sys_get_config({})

  // Log the health check
  await adf.db_execute({
    sql: 'INSERT INTO local_health_log (ts, unread, payload) VALUES (?, ?, ?)',
    params: [Date.now(), unread, event.data.timer.payload]
  })

  // Alert if inbox is backing up
  if (unread > 50) {
    await adf.msg_send({ recipient: 'did:adf:ops...', address: 'http://127.0.0.1:7295/mesh/ops/messages', payload: `Health alert: ${unread} unread messages` })
  }

  return { ok: true, duration_ms: Date.now() - start }
}
```

### Cold vs. Warm Execution

By default, timer lambdas use **cold execution** — a fresh sandbox worker is created, the lambda runs, and the worker is destroyed. This is safe and isolated but has startup overhead.

Set `warm: true` on the timer to use **warm execution** — the worker stays alive between invocations. This is faster for frequently-firing timers (e.g., polling every few seconds) but uses more memory. All warm timer/trigger lambdas for an agent share the sandbox ID `{agentId}:lambda`.

See [Code Execution > State Persistence](code-execution.md#state-persistence) and [Triggers > Cold vs. Warm Execution](triggers.md#cold-vs-warm-execution) for more details.

### adf Access

Timer lambdas have full access to the [`adf` proxy object](adf-object.md) — all enabled tools, `model_invoke`, and `sys_lambda` are available.

## Timer Scope and Trigger Interaction

For a timer to actually execute, two conditions must be met:

1. The timer's `scope` includes a matching scope (e.g., `"agent"`)
2. The `on_timer` trigger is enabled and has a target with the matching scope

This dual-check means you can disable all timers of a scope by toggling the trigger — without deleting the timers themselves.

## Timer Lifecycle

When a timer fires:

1. `run_count` is incremented
2. `last_fired_at` is updated
3. Payload is delivered to scope handler(s) that pass the dual-check
4. **One-time timers:** Deleted after firing
5. **Interval/cron timers:** Next `next_wake_at` is calculated and the timer row is updated. Deleted if `max_runs` is reached or `end_at` has passed.

## Missed Timers

If the runtime loads an ADF with past-due timers (e.g., the app was closed), catch-up behavior depends on the timer type:

| Type | Behavior |
|------|----------|
| **Once** | Fire immediately, then delete |
| **Interval** | Fire once (skip missed occurrences), recalculate next from now |
| **Cron** | Fire once, recalculate next future occurrence |

This prevents a flood of catches-up fires. The agent fires once and gets back on schedule.

## Timer Storage

The `adf_timers` table stores each timer's schedule, scope, and execution config:

| Column | Description |
|--------|-------------|
| `schedule_json` | Resolved schedule configuration (see below) |
| `scope` | JSON array of scopes, e.g., `["system"]` or `["system", "agent"]` |
| `lambda` | Lambda entry point (system scope only), e.g., `"lib/poller.ts:check"` |
| `warm` | Whether to keep the sandbox worker alive (`0` or `1`) |
| `payload` | Optional string payload |
| `next_wake_at` | Next fire timestamp (ms) |
| `run_count` | Number of times the timer has fired |

The `schedule_json` column stores the resolved schedule:

```json
// One-time
{ "type": "once", "at": 1707300300000 }

// Interval
{ "type": "interval", "every_ms": 3600000, "start_at": null, "end_at": null, "max_runs": null }

// Cron
{ "type": "cron", "expr": "0 9 * * 1-5", "end_at": null, "max_runs": null }
```

## Managing Timers

### Creating Timers in the UI

The **Agent > Timers** tab includes an **Add Timer** button that opens a modal for creating timers without using tool calls. The modal lets you:

- Select a schedule mode (delay, absolute time, interval, or cron)
- Toggle scope between system and agent (or both)
- Specify a lambda entry point and warm flag for system scope
- Set an optional payload string

### Listing Timers

Use `sys_list_timers` to see all active timers with their schedules, next fire time, and run count. You can also view timers in the **Agent > Timers** tab in the UI.

### Deleting Timers

Use `sys_delete_timer(id)` to cancel and remove a timer. In the UI, timers can be deleted from the Timers tab.

## Common Patterns

### Health Check Every Hour

```
sys_set_timer({
  schedule: { type: "interval", every_ms: 3600000 },
  scope: ["system"],
  payload: "health_check"
})
```

System scope script handles the check cheaply without waking the LLM.

### Daily Report (Weekdays)

```
sys_set_timer({
  schedule: { type: "cron", cron: "0 9 * * 1-5" },
  scope: ["agent"],
  payload: "daily_report"
})
```

Agent wakes at 9 AM on weekdays to generate a report.

### One-Time Reminder

```
sys_set_timer({
  schedule: { type: "delay", delay_ms: 1800000 },
  scope: ["agent"],
  payload: "Check if the deployment completed"
})
```

Agent gets a reminder in 30 minutes.

### Limited Polling

```
sys_set_timer({
  schedule: { type: "interval", every_ms: 60000, max_runs: 10 },
  scope: ["system"],
  payload: "poll_api"
})
```

Poll every minute, stop after 10 attempts.
