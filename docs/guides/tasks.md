---
type: guide
description: Deferred and asynchronous tool executions in adf_tasks — creation paths, statuses, querying, and resolution
see_also:
  - triggers.md — reacting to on_task_create / on_task_complete
  - authorized-code.md — task-level authorization for approvals
---

# Tasks

Tasks track deferred and asynchronous tool executions. When a tool call requires approval (HIL via `restricted`) or is executed asynchronously, the runtime creates a task entry in `adf_tasks` that records the tool name, arguments, status, and eventual result.

## When Tasks Are Created

Tasks are created in two scenarios:

### 1. Restricted Tools from the LLM Loop (HIL)

Tools configured with `enabled: true` and `restricted: true` create a task with `pending_approval` status and `requires_authorization: true` when called from the LLM loop. The agent's turn blocks until the task is resolved (approved or denied).

The task can be resolved by:
- **UI approval dialog / HTTP** — the owner clicks approve/deny in the Studio UI, or a client calls the daemon endpoint `POST /agents/:id/tasks/:taskId/resolve`
- **`on_task_create` trigger lambda** — notifies or routes to an external approval system (Telegram, multi-agent vote, etc.); only owner-authorized code can then call `task_resolve`. See [Routing approvals outside Studio](#routing-approvals-outside-studio) before resolving tasks from a chat channel.
- **`task_resolve` from authorized code** — any authorized lambda can approve/deny

The resolve endpoint returns **404** for an unknown task id and **409** when the task is not in a resolvable status — only `pending` and `pending_approval` rows can be resolved. A task already swept to a terminal status by orphan reconciliation therefore returns 409.

When a **blocking** (synchronous) HIL task is **denied**, `on_task_complete` is deliberately **not** fired — the agent already receives the rejection in-band as the tool-call error result, so a trigger would be redundant. Denials of **async** (`_async: true`) HIL tasks *do* fire `on_task_complete`, since the agent has no inline context for those.

```json
{
  "tools": [
    { "name": "fs_write", "enabled": true, "restricted": true }
  ]
}
```

`restricted` is owner-set only — an agent's `sys_update_config` call touching it is hard-denied (no HIL prompt). See [Authorized Code](authorized-code.md) for the security model.

**Async HIL:** If the agent calls a restricted tool with `_async: true`, the task is created but the agent continues without waiting. The task reference is returned immediately:

```json
{ "task_id": "task_abc123", "status": "pending_approval", "tool": "fs_write" }
```

### 2. Async Execution (`_async: true`)

Any tool call can be made asynchronous by including `_async: true` in the input. The runtime strips the flag, creates a task in `running` status, and executes the tool in the background:

```json
{ "task_id": "task_def456", "status": "running", "tool": "sys_code" }
```

The LLM can continue its turn without waiting. The task updates to `completed` or `failed` when execution finishes.

## Task Statuses

| Status | Description |
|--------|-------------|
| `pending` | Created, not yet executing |
| `pending_approval` | Awaiting human/authorized approval (HIL) |
| `running` | Currently executing |
| `completed` | Finished successfully |
| `failed` | Finished with an error |
| `denied` | Approval rejected |
| `cancelled` | Cancelled before completion |

Terminal statuses (`completed`, `failed`, `denied`, `cancelled`) record a `completed_at` timestamp.

## Orphaned Task Reconciliation (on load)

A crash or hard shutdown can leave `adf_tasks` rows stranded in a non-terminal state. On load — before any turn of the new session runs — the executor sweeps these orphans (every row it sees predates the load, so nothing legitimately in flight is affected):

| Orphaned row | Swept to | Why |
|--------------|----------|-----|
| `running` | `failed` (error: "outcome unknown") | The tool may have produced side effects before the process died; the outcome cannot be known. |
| `pending_approval`, **executor-managed** | `cancelled` | These are the executor's own blocking HIL approvals — nobody is left waiting on them. Not `denied`: no human ever decided. |
| `pending_approval`, **not** executor-managed | *left open* | Owned by lambdas/UI, which can still resolve them after restart. |

Each swept executor-managed approval emits `hil.resolved { orphaned: true, approved: false }` (closing the one-resolve-per-request guarantee for a request whose emitter died). If any rows were swept, the executor emits a single `loop.recovered { reason: 'orphaned_tasks', running, awaiting_approval }`. Reconciliation is diagnostic — a failure never blocks agent load.

## Task Schema

The `adf_tasks` table:

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PRIMARY KEY | Unique identifier (`task_` + nanoid) |
| `tool` | TEXT | Tool name (e.g., `fs_write`) |
| `args` | TEXT | JSON-stringified tool arguments |
| `status` | TEXT | Current status (see above) |
| `result` | TEXT | JSON result on success, NULL otherwise |
| `error` | TEXT | Error message on failure, NULL otherwise |
| `created_at` | INTEGER | Unix timestamp (ms) |
| `completed_at` | INTEGER | Unix timestamp (ms), set on terminal status |
| `origin` | TEXT | Source — `hil:AgentName:id` for HIL, `agent:AgentName:id` for async |
| `requires_authorization` | INTEGER | `1` if only authorized code can approve/deny this task |
| `executor_managed` | INTEGER | `1` if the executor is waiting to execute the tool after approval |

## Task-Level Authorization

HIL tasks are created with `requires_authorization: true`, meaning only authorized code (or the UI dialog, which is owner-authorized) can approve or deny them. This prevents the agent from self-approving its own gated tool calls.

For non-HIL tasks, `requires_authorization` can be set via `task_resolve`:

```javascript
await adf.task_resolve({
  task_id: taskId,
  action: "pending_approval",
  requires_authorization: true
});
```

Once set, the flag cannot be unset.

## Code Execution and Restricted Tools

Restricted tools (`restricted: true`) can only be called freely from authorized code. Unauthorized code is always blocked.

| Code Context | Restricted tool |
|---|---|
| `sys_code` (always unauthorized) | Blocked |
| `sys_lambda` from loop → unauthorized target | Blocked |
| `sys_lambda` from loop → authorized target | **HIL** — approved → Allowed |
| `sys_lambda` from authorized file (authorized) | Allowed |
| Trigger/timer lambda from authorized file | Allowed |

When the LLM calls `sys_lambda` targeting an authorized file, the runtime triggers a HIL approval prompt. If approved, the lambda runs with authorization and can call restricted tools. This is the same approval mechanism used for restricted tool calls from the loop. Authorized lambdas called from code or triggers run without prompting.

Hiding a tool from the LLM does not make it inaccessible to code. Set `visible: false` to keep an enabled tool callable from code (and lambdas) while removing it from the LLM's tool schema. A tool with `enabled: false, restricted: true` can still be called from authorized code — it is just hidden from the LLM loop.

## Querying Tasks

Use `db_query` to inspect tasks. Note that the `on_task_create` trigger below is disabled by default — enable via `triggers.on_task_create.enabled`.

```sql
-- Recent tasks
SELECT * FROM adf_tasks ORDER BY created_at DESC LIMIT 20

-- Pending approval tasks
SELECT * FROM adf_tasks WHERE status = 'pending_approval'

-- Failed tasks for a specific tool
SELECT * FROM adf_tasks WHERE tool = 'fs_write' AND status = 'failed'
```

## Task Triggers

### `on_task_create`

Fires when a task is created. This is the hook for external approval routing — the lambda receives the full task details and can dispatch approval requests.

```json
{
  "on_task_create": {
    "enabled": true,
    "targets": [{
      "scope": "system",
      "lambda": "lib/hil/dispatcher.ts:onTaskCreate",
      "filter": { "tools": ["*"] }
    }]
  }
}
```

Example lambda — a **notification only**: it tells the owner a decision is waiting and leaves the decision in Studio:

```javascript
export async function onTaskCreate(event) {
  const { task } = event.data;
  if (!task.requires_authorization || task.status !== 'pending_approval') return;
  // Protection overrides (and anything without reason 'restricted') stay Studio-only.
  if (task.approval_meta?.reason !== 'restricted') return;

  await adf.msg_send({
    recipient: "telegram:123456789",   // the owner's numeric user ID (private chat)
    // Never put task.args here: they can hold file contents, commands or secrets.
    content: `Approval pending: task ${task.id} (${task.tool}). Open Studio to review and decide.`,
    subject: `task:${task.id}`
  });
}
```

#### Routing approvals outside Studio

Sending a notification is safe; **resolving** a task from a chat reply is not, unless the resolver does all of the following:

- **Privacy.** Send only safe fields (task ID, tool name, a hash of the full input). Arguments, commands and file contents stay in Studio, where the owner inspects them before deciding.
- **Sender binding.** Accept a verdict only from the owner's numeric user ID, in a private chat with that ID, as a direct reply (`parent_id`) to the exact message the resolver sent. A subject line, a task ID in the text, or a matching display name is not authentication.
- **Request binding.** Keep issued requests in a `local_*` table that the owner protects as `authorized` and locks (`locked_fields`), so only the reviewed resolver can write it. Check that the task is still `pending_approval` and unchanged since the request was sent, and expire requests.
- **Studio-only overrides.** Never forward, resolve or time out a task whose `approval_meta.reason` is not `restricted`. Protection overrides (`reason: 'protection'`) unlock owner-locked files, metadata or config and must be decided in Studio.
- **Authorized code.** The resolver must be owner-reviewed and authorized; unauthorized code gets `REQUIRES_AUTHORIZED_CODE` from `task_resolve`. Treat an `INVALID_STATE` result as "already decided elsewhere" and do not report a verdict to the chat.

A Telegram remote-approval skill implementing these rules is an experimental review candidate. It is not shipped with ADF and has not been validated against live Telegram.

### `on_task_complete`

Fires when a task reaches a terminal status (`completed`, `failed`, `denied`, `cancelled`). Filter by tool name and/or status:

```json
{
  "on_task_complete": {
    "enabled": true,
    "targets": [{
      "scope": "agent",
      "filter": { "tools": ["fs_write", "msg_send"], "status": "completed" }
    }]
  }
}
```

See [Triggers](triggers.md) for the full trigger system.

## Tool Side Effects Through Task Resolution

When `task_resolve` approves a task, the tool executes and its side effects are propagated. For HIL tasks (executor-managed), the executor runs the tool in its own context — preserving `endTurn` handling, file diffs, and state transitions. For deferred tasks, `task_resolve` executes the tool in the call handler context.

## UI

The **Tasks** tab in the [Bottom Panel](settings.md#bottom-panel-logs--tasks) displays all tasks with status filtering, expandable argument/result details, auto-refresh, and an AUTH badge for tasks requiring authorized code.
