# Tasks

Tasks track deferred and asynchronous tool executions. When a tool call requires approval (HIL via `restricted`) or is executed asynchronously, the runtime creates a task entry in `adf_tasks` that records the tool name, arguments, status, and eventual result.

## When Tasks Are Created

Tasks are created in two scenarios:

### 1. Restricted Tools from the LLM Loop (HIL)

Tools configured with `enabled: true` and `restricted: true` create a task with `pending_approval` status and `requires_authorization: true` when called from the LLM loop. The agent's turn blocks until the task is resolved (approved or denied).

The task can be resolved by:
- **UI approval dialog** — the owner clicks approve/deny in the Studio UI
- **`on_task_create` trigger lambda** — dispatches to an external approval system (Telegram, multi-agent vote, etc.) which calls `task_resolve`
- **`task_resolve` from authorized code** — any authorized lambda can approve/deny

```json
{
  "tools": [
    { "name": "fs_write", "enabled": true, "restricted": true }
  ]
}
```

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

`enabled: false` means the tool is invisible to the LLM, not inaccessible to authorized code. A tool with `enabled: false, restricted: true` can still be called from authorized code — it is just hidden from the LLM loop.

## Querying Tasks

Use `db_query` to inspect tasks:

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

Example lambda:

```javascript
export async function onTaskCreate(event) {
  const { task } = event.data;
  if (!task.requires_authorization) return;

  await adf.msg_send({
    recipient: "telegram:765273985",
    content: `Approval needed: ${task.tool}\nArgs: ${task.args}`,
    subject: `task:${task.id}`
  });
}
```

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
