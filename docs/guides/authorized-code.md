# Authorized Code Execution

ADF agents can write and execute code. By default, all code — whether written by the agent or the owner — runs with the same privileges. This creates a privilege escalation risk: an agent with code execution can approve its own human-in-the-loop (HIL) restricted tool calls, bypassing human oversight entirely.

Authorized code execution solves this by introducing a file-level trust boundary. The owner marks specific files as **authorized**, and the runtime restricts sensitive methods so only authorized code can call them. For `task_resolve` specifically, authorization is enforced at the task level — trigger lambdas opt in by setting `requires_authorization: true` on the task via `task_resolve`, and subsequent approve/deny calls check this flag rather than relying on method-level restriction.

## Core Concepts

### The Problem

Without authorized code, these two scenarios are indistinguishable to the runtime:

1. **Owner writes** `lib/hil/vote-counter.ts` that calls `task_resolve` after verifying a 3/5 quorum from council agents
2. **Agent writes** `lib/hack.ts` that calls `task_resolve({ task_id: "...", action: "approve" })` to approve its own pending task

Both files live in `adf_files`. Both execute in the same sandbox. Both have access to the same `adf.*` methods.

For `task_resolve`, the distinction is made by the trigger lambda: a HIL lambda sets `requires_authorization: true` when escalating the task, so only authorized code can approve or deny it. Non-security interceptions (rate limiting, batching, logging) don't set the flag, so any code can resolve them.

### The Solution

A single boolean flag — `authorized` — on each file in `adf_files`. The runtime checks this flag at execution time and gates specific `adf.*` methods behind it.

| Concept | Description |
|---------|-------------|
| **Authorized file** | A file in `adf_files` with `authorized = true`. Only settable by the owner (via Studio UI) or by already-authorized code (gateway pattern). |
| **Restricted method** | A code execution method listed in `code_execution.restricted_methods`. Can only be called from authorized code. |
| **Write deauthorizes** | Any write to an authorized file via `fs_write` automatically sets `authorized = false`. The content changed — the authorization is no longer valid. |
| **Authorization is orthogonal to protection** | A file can be authorized but unprotected (`authorized: true, protection: "none"`), or protected but unauthorized. They control different things. |

## How Authorization Flows

Authorization is **not** simply "is the file authorized?" — it depends on **who invoked the code**.

### Execution Contexts

| Invocation | Authorization | Rationale |
|-----------|--------------|-----------|
| **Trigger/timer lambda** | Based on file's `authorized` flag | System-initiated — the owner configured the trigger |
| **Middleware lambda** | Based on file's `authorized` flag | System-initiated — runs in the ingress/egress pipeline |
| **`sys_lambda` from the loop** | **HIL** if target is authorized; `false` otherwise | Agent-initiated — authorized targets require human approval before running with privileges |
| **`sys_code` (inline)** | Always `false` | Agent-initiated — inline code has no provenance |
| **Code calling `adf.sys_lambda()`** | Based on target file's `authorized` flag | Unauthorized callers blocked from calling authorized targets (`REQUIRES_AUTHORIZED_CALLER`) |

The key rule: **authorized code always requires human awareness.** System channels (triggers, timers, middleware) run authorized code because the owner configured them. When the LLM calls `sys_lambda` targeting an authorized file, the runtime triggers a HIL approval prompt — the user must explicitly approve execution with elevated privileges. In code-to-code chains, unauthorized callers cannot escalate into authorized targets.

### Call Chain Rules

| Caller | Target | Result |
|--------|--------|--------|
| Authorized code | Authorized file | Allowed — target runs authorized |
| Authorized code | Unauthorized file | Allowed — target runs unauthorized |
| Unauthorized code | Authorized file | **Blocked** — `REQUIRES_AUTHORIZED_CALLER` |
| Unauthorized code | Unauthorized file | Allowed — target runs unauthorized |
| Loop `sys_lambda` | Authorized file | **HIL prompt** — approved → runs authorized; denied → blocked |
| Loop `sys_lambda` | Unauthorized file | Allowed — target runs unauthorized |

## Configuration

### Restricting Methods

Configure which `adf.*` methods require authorized code in the agent's code execution config:

```jsonc
{
  "code_execution": {
    "restricted_methods": ["get_identity"]
  },
  "security": {
    "require_middleware_authorization": true
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `code_execution.restricted_methods` | `string[]` | `[]` | Methods that can only be called from authorized code |
| `security.require_middleware_authorization` | `boolean` | `true` | Whether middleware lambdas must be from authorized files |

Common methods to restrict:

| Method | Why Restrict It |
|--------|-----------|
| `get_identity` | Restricts access to stored credentials and API keys |
| `set_identity` | Prevents agent from overwriting stored credentials |
| `authorize_file` | Restricts the gateway pattern to already-authorized code |
| `model_invoke` | Prevents unauthorized code from making LLM calls (cost control) |
| `loop_inject` | Prevents unauthorized code from injecting context into the conversation |

Note: `set_meta_protection` and `set_file_protection` are inherently authorized-code-only — they don't need to be added to `restricted_methods`. Similarly, `sys_set_meta` and `sys_delete_meta` only bypass protection checks from authorized code; from unauthorized code they enforce protection normally.

`task_resolve` is **not** listed here — it uses task-level authorization instead. HIL tasks are created with `requires_authorization: true`, and `task_resolve` checks this flag at runtime. This avoids double-restricting: the authorization requirement lives on the task, not the method.

Default is `[]` — no restriction. The owner opts in to which methods need protection.

### Restricting Tools

Tools and MCP servers use `restricted` directly on the ToolDeclaration:

```jsonc
{
  "tools": [
    { "name": "execute_trade", "enabled": true, "restricted": true }
  ]
}
```

| `enabled` | `restricted` | LLM loop | Authorized code | Unauthorized code |
|-----------|------------|----------|-----------------|-------------------|
| `false`   | `false`      | Off      | Off             | Off               |
| `true`    | `false`      | Free     | Free            | Free              |
| `false`   | `true`       | Off      | Free            | Off               |
| `true`    | `true`       | HIL      | Free            | Off               |

When a tool is both `enabled` and `restricted`, LLM loop calls automatically get HIL approval — the runtime derives HIL from the combination. Authorized code can call the tool freely, bypassing the approval step. Unauthorized code cannot call restricted tools at all.

### Middleware Authorization

`require_middleware_authorization` controls whether middleware lambdas must be from authorized files. Default: `true`.

When `true` and a middleware lambda's source file is not authorized, the middleware is **skipped** (not errored). The message passes through unmodified and a warning is logged:

```
[warn] Middleware lib/transform.ts skipped — not authorized
```

Skipping rather than erroring is deliberate — erroring would reject the inbound message, punishing the sender for the receiver's internal config state.

When `false`, all middleware runs regardless of authorization status, but the authorization context within the middleware reflects the file's actual flag. Unauthorized middleware cannot call restricted methods; authorized middleware can.

## Authorizing Files

### Via Studio UI

Open the file in the **Files** panel. Click the **Unauthorized** button to toggle it to **Authorized**. A green badge appears in the file list.

### Via Authorized Code (Gateway Pattern)

Authorized code can authorize other files using the `authorize_file` method:

```javascript
// lib/gateway.ts — this file must itself be authorized
async function authorizeDeployment(event) {
  // Custom validation logic
  const approval = await verifyHumanApproval(event)
  if (approval.verified) {
    await adf.authorize_file({ path: event.targetFile })
  }
}
```

This enables remote authorization workflows: the owner authorizes a gateway lambda that implements whatever authorization policy they want (Telegram approval, multi-agent vote, time-based rotation). The trust chain: **human** authorizes gateway, **gateway** authorizes target files.

`authorize_file` is itself restricted — it only works from already-authorized code. Add it to `restricted_methods` to enforce this (it checks `isAuthorized` internally regardless, but adding it to the list makes the policy explicit in config).

### What Cannot Authorize

These paths **cannot** set the `authorized` flag:

| Path | Why |
|------|-----|
| `fs_write` | Agent tool — writes content, does not control authorization |
| `sys_update_config` | Agent tool — modifies config, not file flags |
| `db_execute` | Agent tool — `adf_files` is blocked from `db_execute` |
| `sys_code` (inline) | No file — inline code has no authorization context |
| Unauthorized `sys_lambda` | `authorize_file` requires authorized caller |

## Write Deauthorization

Any write to an authorized file via `fs_write` automatically sets `authorized = false`. This is enforced at the database layer — the `UPDATE` statement unconditionally sets `authorized = 0`:

```sql
UPDATE adf_files SET content = ?, mime_type = ?, size = ?, authorized = 0, updated_at = ? WHERE path = ?
```

This means:

- The agent cannot write malicious code into an authorized file and have it run with privileges
- During development, each `fs_write` requires manual re-authorization via the UI
- For production, combine `authorized = true` with `protection = 'read_only'` to prevent both modification and deletion

### Protection + Authorization Matrix

| Phase | `authorized` | `protection` | Notes |
|-------|-------------|-------------|-------|
| Owner developing | `false` | `none` | Normal development, no authorization needed |
| Owner testing | `false` | `none` | Verify logic before authorizing |
| Production lockdown | `true` | `read_only` | Authorized and immutable |
| Owner patching | `true` → `false`, edit, `true` | `read_only` → `none` → `read_only` | Unlock, edit (deauthorizes), re-authorize, re-lock |

## Error Codes

When authorization checks fail, the sandbox receives these error codes:

| Error Code | Condition | Message |
|-----------|-----------|---------|
| `REQUIRES_AUTHORIZED_CODE` | Restricted method/tool called from unauthorized code, or `task_resolve` called on a task with `requires_authorization: true` from unauthorized code | `"<method>" can only be called from authorized code. Ask the owner to authorize the source file.` |
| `REQUIRES_AUTHORIZED_CALLER` | Unauthorized code calls `adf.sys_lambda()` targeting an authorized file | `Cannot call authorized code from unauthorized context` |

## Governance Patterns

The authorized code primitive enables multi-agent governance without additional framework features.

### Multi-Agent Approval (HIL Replacement)

```
Trading agent calls execute_trade(AAPL, 1000) — tool has restricted: true
  → Runtime creates HIL task (pending_approval, requires_authorization: true, executor_managed: true)
  → on_task_create trigger fires → authorized system-scope lambda receives task details
  → Lambda sends approval requests to 5 council agents via msg_send
  → Council agents reply via msg_send (normal messages)
  → on_inbox trigger fires authorized vote-counting lambda
  → Lambda queries adf_inbox for verified sender DIDs (not local_* tables)
  → 3/5 approve → adf.task_resolve({ task_id, action: "approve" })
  → Executor runs execute_trade in its own context
```

Key implementation rules for the vote-counting lambda:

1. **Read from system tables only.** Query `adf_inbox` for votes — the agent cannot forge entries in `adf_inbox`. Never read votes from `local_*` tables — the agent can freely write those.
2. **Verify sender identity.** Check the `from` field (DID) against a hardcoded or config-stored list of council agent DIDs.
3. **Don't accept parameters.** The lambda should derive its decisions from the current state of system tables, not from arguments passed by the caller.

### Remote Authorization Gateway

```javascript
// lib/auth-gateway.ts (authorized, read_only, locked)
async function onApprovalMessage(event) {
  if (event.type !== 'inbox') return

  const messages = await adf.msg_read({ status: 'unread' })
  for (const msg of messages) {
    // Only accept from the owner's management agent
    if (msg.from !== 'did:key:z6MkOwnerAgent...') continue

    const parsed = JSON.parse(msg.content)
    if (parsed.action === 'authorize' && parsed.path) {
      await adf.authorize_file({ path: parsed.path })
    }
  }
}
```

### Secure Middleware Pipeline

Middleware that modifies messages before the agent sees them is security-critical code. With `require_middleware_authorization: true` (the default), only owner-authorized middleware runs. Unauthorized middleware is silently skipped.

This means the agent can write experimental middleware, but it won't execute until the owner reviews and authorizes the file. The agent can still modify its trigger configuration to point at authorized middleware — that's intentional. The trust is in the middleware code, not in who invokes it.

## Security Analysis

### What Authorized Code Prevents

| Attack | Mitigation |
|--------|-----------|
| Agent calls `task_resolve` from `sys_code` to self-approve restricted tool's HIL task | Blocked — HIL tasks have `requires_authorization: true`, `sys_code` always runs unauthorized |
| Agent writes code that calls `task_resolve` via `sys_lambda` on restricted tool's HIL task | Blocked — loop `sys_lambda` calls run unauthorized, HIL task has `requires_authorization: true` |
| Agent writes `adf.sys_lambda()` in `sys_code` targeting authorized file | Blocked — `REQUIRES_AUTHORIZED_CALLER` (unauthorized caller) |
| Agent modifies an authorized file to inject malicious code | Blocked — `fs_write` auto-deauthorizes |
| Agent calls `authorize_file` from unauthorized code | Blocked — requires authorized caller |
| Unauthorized middleware modifies messages | Blocked (default) — `require_middleware_authorization: true` skips it |

### Authorized Code Protection Bypass

Authorized code can bypass `readonly` and `increment` protection on `adf_meta` keys and `read_only`/`no_delete` protection on files, and can change protection levels on both meta keys and files. This is equivalent to the owner making changes via the Studio UI.

| Method | Unauthorized Code | Authorized Code |
|--------|------------------|-----------------|
| `sys_set_meta` | Protection enforced | Protection bypassed — can overwrite any key |
| `sys_delete_meta` | Protection enforced | Protection bypassed — can delete any key |
| `fs_write` | Protection enforced | Protection bypassed — can overwrite any file, including `read_only` |
| `fs_delete` | Protection enforced | Protection bypassed — can delete any file, including `read_only` and `no_delete` |
| `set_meta_protection` | Not available | Can change meta key protection level |
| `set_file_protection` | Not available | Can change file protection level |
| `authorize_file` | Not available | Can authorize/deauthorize any file |

This enables remote management patterns: an authorized lambda can lock down files and meta keys after deployment, overwrite a locked config file during patching, or rotate the set of authorized code files without user intervention.

**How the bypass is wired (implementation detail):** When `adf-call-handler` dispatches a tool call from authorized code, it injects an internal `_authorized: true` flag onto the tool's input. The tool registry treats this as a cross-cutting param (alongside `_full`) — stripped before schema validation, re-attached on the tool input. Tools that support the bypass (`fs_write`, `fs_delete`, etc.) check for this flag and skip their protection checks. The agent executor unconditionally strips `_authorized` from LLM tool calls, so the LLM cannot forge it; only `adf-call-handler` can set it, and only when `this.isAuthorized` is `true`.

### What Authorized Code Does NOT Prevent

| Scenario | Why It's Acceptable |
|----------|-------------------|
| Agent creates trigger/timer pointing at authorized code | The agent controls **when** authorized code runs, not **what** it does. Authorized code validates its own inputs from system tables. |
| Agent passes arbitrary timer payload to authorized lambda | The lambda receives a structured `event` object — different shape from the inputs it was designed for. A well-written lambda ignores irrelevant event types. |
| Agent calls authorized `sys_lambda` from the loop | **HIL prompt** — the user must approve before the lambda runs with authorization. Denial blocks execution. |
| Agent re-enables a disabled tool via `sys_update_config` | The agent can toggle `enabled` on unlocked tools — disable is a suggestion, not a boundary. Lock the tool or disable `sys_update_config` to enforce. Agent **cannot** modify `restricted`, `restricted_methods`, or `locked`. |
| Owner marks a badly-written lambda as authorized | Code quality issue — authorization means "owner trusts this code." If the code blindly acts on parameters, that's the owner's responsibility. |

### Residual Risk

The authorization model assumes authorized code is **well-written**. Specifically:

- **Don't accept security-critical parameters.** A vote-counting lambda should read votes from `adf_inbox`, not from function arguments.
- **Read from system tables, not `local_*`.** The agent can write freely to `local_*` tables. System tables (`adf_inbox`, `adf_config`, `adf_files`) are write-protected from agent code.
- **Keep authorized files small and single-purpose.** A 20-line vote counter is easy to audit. A 500-line utility library is not.
- **Use `protection: 'read_only'` in production.** Prevents the agent from deleting authorized files (a disruption vector, not a privilege escalation).

## Schema

The `authorized` column is stored on the `adf_files` table:

```sql
CREATE TABLE adf_files (
  path TEXT PRIMARY KEY,
  content BLOB NOT NULL,
  mime_type TEXT,
  size INTEGER NOT NULL,
  protection TEXT NOT NULL DEFAULT 'none',
  authorized INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Task-level authorization is stored on the `adf_tasks` table:

```sql
CREATE TABLE adf_tasks (
  id TEXT PRIMARY KEY,
  tool TEXT NOT NULL,
  args TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  origin TEXT,
  requires_authorization INTEGER NOT NULL DEFAULT 0
);
```

All tasks start with `requires_authorization = 0`. A trigger lambda opts in by passing `requires_authorization: true` on `task_resolve`:

```javascript
await adf.task_resolve({
  task_id: taskId,
  action: "pending_approval",
  requires_authorization: true
});
```

Once set, the flag cannot be unset — any code can lock the door, but only authorized code can approve or deny the task. Setting to `pending_approval` is always allowed (it's restrictive). The `task_resolve` method checks this flag — not method-level restriction — to determine if the caller must be authorized.

The `authorized` field is also returned by `fs_read`:

```json
{
  "path": "lib/hil/vote-counter.ts",
  "content": "...",
  "mime_type": "text/typescript",
  "size": 847,
  "protection": "read_only",
  "authorized": true,
  "created_at": "2026-03-15T10:30:00.000Z",
  "updated_at": "2026-03-15T10:30:00.000Z"
}
```

## Implementation Reference

| Component | File | Role |
|-----------|------|------|
| Schema + migration | `src/main/adf/adf-database.ts` | `authorized` column on files (v17), `requires_authorization` on tasks (v18), auto-deauthorize on write |
| Workspace methods | `src/main/adf/adf-workspace.ts` | `isFileAuthorized()`, `setFileAuthorized()` |
| Method restriction | `src/main/runtime/adf-call-handler.ts` | `restricted_methods` check, task-level authorization check in `task_resolve`, call-chain enforcement, `authorize_file` handler, authorized meta/file protection bypass |
| `sys_lambda` context | `src/main/tools/built-in/sys-lambda.tool.ts` | AND-logic: `fileAuthorized && callerAuthorized` |
| `sys_code` context | `src/main/tools/built-in/sys-code.tool.ts` | Always `isAuthorized = false` |
| Trigger/timer context | `src/main/runtime/system-scope-handler.ts` | Sets `isAuthorized` from file flag |
| Middleware restriction | `src/main/services/middleware-executor.ts` | `require_middleware_authorization` check + context |
| Type definitions | `src/shared/types/adf-v02.types.ts` | `CodeExecutionConfig.restricted_methods`, `SecurityConfig.require_middleware_authorization`, `ToolDeclaration.restricted`, `FileEntry.authorized` |
| Zod validation | `src/main/adf/adf-schema.ts` | Schema validation for security config fields |
| IPC | `src/shared/constants/ipc-channels.ts`, `src/main/ipc/index.ts` | `DOC_SET_FILE_AUTHORIZED` channel |
| UI | `src/renderer/components/agent/AgentFiles.tsx`, `src/renderer/components/agent/AgentConfig.tsx` | File authorization toggle, security config UI |
