# Daemon HTTP API

The daemon is the headless ADF runtime that serves a local Fastify API for headless clients. The default base URL is:

```text
http://127.0.0.1:7385
```

Unless configured otherwise, bind the daemon API to localhost only. The current API has no authentication layer.

## Health

### `GET /health`

Returns a basic liveness response.

```json
{
  "ok": true
}
```

## Events

### `GET /events`

Opens a Server-Sent Events stream for live daemon and agent events.

```bash
curl -N http://127.0.0.1:7385/events
```

Optional query parameters:

| Parameter | Description |
|-----------|-------------|
| `agentId` | Only stream events for one agent |
| `since` | Replay buffered events with sequence numbers greater than this value |

Examples:

```bash
curl -N "http://127.0.0.1:7385/events?agentId=agent-id"
```

```bash
curl -N "http://127.0.0.1:7385/events?since=42"
```

The stream starts with a comment frame:

```text
: connected
```

Events use the SSE `id`, `event`, and `data` fields:

```text
id: 43
event: agent.state.changed
data: {"seq":43,"type":"agent.state.changed","agentId":"agent-id","timestamp":1710000000000,"payload":{"filePath":"/path/to/agents/example-agent.adf","state":"idle"}}
```

Event envelopes:

```json
{
  "seq": 43,
  "type": "agent.state.changed",
  "agentId": "agent-id",
  "timestamp": 1710000000000,
  "payload": {}
}
```

Currently published event types include:

| Event | Meaning |
|-------|---------|
| `daemon.started` | Daemon HTTP API started |
| `agent.loaded` | Agent loaded into the daemon runtime |
| `agent.unloaded` | Agent unloaded from the daemon runtime |
| `agent.event` | Raw forwarded `AgentExecutor` event |
| `agent.state.changed` | Agent runtime state changed |
| `turn.completed` | Agent turn completed |
| `tool.started` | Tool call started |
| `tool.completed` | Tool call completed successfully |
| `tool.failed` | Tool call threw or returned isError |
| `agent.error` | Agent execution error |
| `adapter.status.changed` | Channel adapter status changed |
| `adapter.log` | Channel adapter emitted a runtime log entry |
| `mcp.status.changed` | MCP server status changed |
| `mcp.tools.discovered` | MCP server tool discovery completed |
| `mcp.log` | MCP server emitted a runtime log entry |
| `daemon.autostart.report` | Startup autostart scan completed |

The event bus keeps a bounded in-memory buffer for short replay windows. Use persisted ADF tables and `/agents/:id/loop` for durable history.

## Settings

The daemon can expose and update its JSON settings file when it is started with a writable settings store. `npm run daemon` uses `FileSettingsStore`, so these endpoints are available.

### `GET /settings`

Returns the loaded settings file path and all settings.

```json
{
  "filePath": "/path/to/adf-settings.json",
  "settings": {}
}
```

### `PATCH /settings`

Merges a JSON object into settings.

```bash
curl -X PATCH http://127.0.0.1:7385/settings \
  -H 'Content-Type: application/json' \
  -d '{"meshEnabled":true,"meshPort":7295}'
```

Response:

```json
{
  "filePath": "/path/to/adf-settings.json",
  "settings": {
    "meshEnabled": true,
    "meshPort": 7295
  }
}
```

### `GET /settings/:key`

Returns one setting value. Missing values are returned as `null`.

```json
{
  "key": "meshEnabled",
  "value": true
}
```

### `PUT /settings/:key`

Sets one setting value. The request body must contain a `value` field.

```bash
curl -X PUT http://127.0.0.1:7385/settings/meshEnabled \
  -H 'Content-Type: application/json' \
  -d '{"value":false}'
```

Response:

```json
{
  "key": "meshEnabled",
  "value": false
}
```

## Runtime Diagnostics

Diagnostics endpoints are read-only and sanitize secrets. They are intended for CLI/TUI clients, operational checks, and debugging headless runtime wiring.

### `GET /diagnostics`

Returns a compact daemon summary with per-agent status, adapter state, MCP state, and WebSocket counts.

```json
{
  "daemon": {
    "uptime": 123.4,
    "pid": 12345
  },
  "agents": []
}
```

### `GET /runtime`

Returns daemon-level runtime diagnostics: settings summary, provider resolution, auth state, MCP registrations, adapter registrations, network diagnostics, compute status, and loaded agent status.

### `GET /runtime/providers`

Returns sanitized provider registrations and how loaded agents resolve providers.

```json
{
  "providers": [
    {
      "id": "provider-id",
      "type": "openai",
      "name": "Provider Name",
      "defaultModel": "model-id",
      "hasApiKey": true
    }
  ],
  "agentUsage": [
    {
      "agentId": "agent-id",
      "handle": "example-agent",
      "providerId": "provider-id",
      "modelId": "model-id",
      "source": "app"
    }
  ]
}
```

### `GET /runtime/auth`

Returns ChatGPT subscription auth status and provider credential presence without exposing credential values.

### `GET /runtime/settings`

Returns a sanitized settings summary, including tracked directories, scan depth, prompt override counts, and counts for providers, MCP servers, adapters, and sandbox packages.

### `GET /runtime/mcp`

Returns sanitized global MCP server registrations. Environment variables are reported as `{ "key": "...", "hasValue": true }` instead of exposing values.

### `GET /runtime/adapters`

Returns sanitized global channel adapter registrations. Environment variables are reported by key and value presence only.

### `GET /runtime/network`

Returns mesh settings, WebSocket connection counts, optional mesh service status, and network-facing configuration for loaded agents.

## Network Admin

These endpoints expose mesh controls for headless daemon operation. They require the daemon to be started with a network service.

### `GET /network`

Alias for `GET /runtime/network`.

### `GET /network/mesh`

Returns live mesh status, registered mesh agents, and debug information when available.

### `POST /network/mesh/enable`

Enables mesh registration and re-registers currently loaded agents.

### `POST /network/mesh/disable`

Disables mesh registration and unregisters mesh agents without unloading them.

### `GET /network/mesh/recent-tools?limit=...`

Returns recent tool calls by registered mesh agent. `limit` is optional.

### `GET /network/mesh/lan-addresses`

Returns LAN addresses visible to the daemon host.

### `GET /network/mesh/discovered-runtimes`

Returns LAN-discovered remote runtimes when discovery is configured. Headless daemon discovery currently returns an empty array.

### `GET /network/server`

Returns mesh HTTP server status.

### `POST /network/server/start`

Starts the mesh HTTP server.

### `POST /network/server/stop`

Stops the mesh HTTP server.

### `POST /network/server/restart`

Restarts the mesh HTTP server.

### `GET /runtime/usage`

Returns daemon-wide token usage totals recorded by provider/model.

### `GET /runtime/models?provider=...&agentId=...`

Lists models for a configured provider. `agentId` is optional and lets the daemon resolve provider config and agent-scoped provider credentials from a loaded agent. Remote provider failures are returned as `{ "models": [], "error": "..." }`.

### `POST /runtime/token-count`

Counts tokens for one text string.

```json
{
  "text": "hello",
  "provider": "openai",
  "model": "gpt-test",
  "agentId": "agent-id"
}
```

`provider` and `model` are optional. If omitted and `agentId` is supplied, the loaded agent's current model config is used.

### `POST /runtime/token-count/batch`

Counts tokens for multiple strings. The request body is the same as `/runtime/token-count`, except it uses `texts`.

## Agents

Most `:id` agent parameters can be an agent ID, handle, or name. IDs are safest for scripts; handles are convenient for humans.

### `GET /agents`

Lists loaded agents.

```json
[
  {
    "id": "agent-id",
    "filePath": "/path/to/agents/example-agent.adf",
    "name": "Example Agent",
    "handle": "example-agent",
    "autostart": true
  }
]
```

### `GET /agents/:id`

Returns a loaded agent reference, including full agent config.

```json
{
  "id": "agent-id",
  "filePath": "/path/to/agents/example-agent.adf",
  "config": {}
}
```

Returns `404` when the agent is not loaded.

### `GET /agents/:id/status`

Returns runtime status for one loaded agent.

```json
{
  "id": "agent-id",
  "filePath": "/path/to/agents/example-agent.adf",
  "name": "Example Agent",
  "handle": "example-agent",
  "autostart": true,
  "runtimeState": "idle",
  "targetState": "idle",
  "loopCount": 42
}
```

Fields:

| Field | Description |
|-------|-------------|
| `runtimeState` | Current executor state |
| `targetState` | Last target state requested by the agent, or `null` |
| `loopCount` | Number of persisted loop entries |

### `GET /agents/:id/loop`

Returns paginated persisted loop entries.

Query parameters:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `limit` | `50` | Number of entries, clamped between `1` and `500` |
| `offset` | last page | Zero-based offset into loop history |

Example:

```bash
curl "http://127.0.0.1:7385/agents/agent-id/loop?limit=20&offset=0"
```

Response:

```json
{
  "agentId": "agent-id",
  "total": 42,
  "limit": 20,
  "offset": 0,
  "entries": []
}
```

### `POST /agents/load`

Loads an `.adf` file into the daemon runtime.

Request body:

```json
{
  "filePath": "/path/to/agents/example-agent.adf",
  "requireReview": false
}
```

Fields:

| Field | Required | Description |
|-------|----------|-------------|
| `filePath` | Yes | Local path to the `.adf` file |
| `requireReview` | No | When `true`, enforce the review gate before loading |

Direct loads bypass review by default. Autostart scans always apply review checks.

Response:

```json
{
  "id": "agent-id",
  "filePath": "/path/to/agents/example-agent.adf",
  "config": {}
}
```

Review failure:

```json
{
  "error": "Agent must be reviewed before loading into the runtime.",
  "code": "AGENT_REVIEW_REQUIRED",
  "agentId": "agent-id",
  "filePath": "/path/to/agents/example-agent.adf"
}
```

## Agent Resources

These endpoints expose and mutate data stored in the loaded `.adf` file. Most mutating responses return `{ "success": true }` plus the `agentId` or operation-specific fields.

### `GET /agents/:id/config`

Returns the agent config.

```json
{
  "agentId": "agent-id",
  "config": {}
}
```

### `PUT /agents/:id/config`

Replaces the agent config and updates the running executor, trigger evaluator, and system-call handler.

```bash
curl -X PUT http://127.0.0.1:7385/agents/agent-id/config \
  -H 'Content-Type: application/json' \
  -d @agent-config.json
```

### `GET /agents/:id/document`

Returns the primary document content.

```json
{
  "agentId": "agent-id",
  "content": "# Document"
}
```

### `PUT /agents/:id/document`

Writes the primary document content and fires file/document-change trigger hooks for the loaded agent.

```json
{
  "content": "# Updated"
}
```

### `GET /agents/:id/mind`

Returns `mind.md`.

### `PUT /agents/:id/mind`

Writes `mind.md`.

```json
{
  "content": "Remember this."
}
```

### `GET /agents/:id/chat`

Returns a display-oriented chat history derived from recent loop rows. Optional `limit` defaults to `200`.

### `DELETE /agents/:id/chat`

Clears persisted loop/chat history and resets the in-memory session.

### `GET /agents/:id/files`

Lists files in the agent virtual filesystem.

```json
{
  "agentId": "agent-id",
  "files": [
    {
      "path": "document.md",
      "size": 1024,
      "mime_type": "text/markdown",
      "protection": "normal"
    }
  ]
}
```

### `GET /agents/:id/files/content?path=...`

Returns one file. Text-like files use `encoding: "utf-8"` and `content`. Binary files use `encoding: "base64"` and `content_base64`.

```json
{
  "agentId": "agent-id",
  "path": "document.md",
  "mime_type": "text/markdown",
  "size": 1024,
  "protection": "normal",
  "authorized": false,
  "encoding": "utf-8",
  "content": "# Document"
}
```

### `PUT /agents/:id/files/content?path=...`

Writes a virtual file. Text writes use `content`; binary writes use `content_base64`.

```json
{
  "content": "hello",
  "protection": "none"
}
```

```json
{
  "content_base64": "AAECAw==",
  "mime_type": "application/octet-stream"
}
```

### `DELETE /agents/:id/files/content?path=...`

Deletes a virtual file.

### `POST /agents/:id/files/rename`

Renames a virtual file.

```json
{
  "oldPath": "old.md",
  "newPath": "new.md"
}
```

### `POST /agents/:id/files/rename-folder`

Renames all virtual files under a folder prefix.

```json
{
  "oldPrefix": "drafts",
  "newPrefix": "archive/drafts"
}
```

### `PATCH /agents/:id/files/protection`

Sets file protection.

```json
{
  "path": "notes.md",
  "protection": "read_only"
}
```

Allowed protection values are `none`, `read_only`, and `no_delete`.

### `PATCH /agents/:id/files/authorized`

Sets whether authorized code can access a file.

```json
{
  "path": "notes.md",
  "authorized": true
}
```

### `GET /agents/:id/inbox`

Lists inbox messages. Optional `status` values are `unread`, `read`, and `archived`.

```bash
curl "http://127.0.0.1:7385/agents/agent-id/inbox?status=unread"
```

### `DELETE /agents/:id/inbox`

Deletes all inbox messages, preserving audit snapshots when the ADF audit configuration requires them.

### `GET /agents/:id/outbox`

Lists outbox messages. Optional `status` values are `pending`, `sent`, `delivered`, and `failed`.

### `GET /agents/:id/timers`

Lists scheduled timers.

### `POST /agents/:id/timers`

Adds a timer. The body matches Studio timer creation: `mode` is one of `once_at`, `once_delay`, `interval`, or `cron`.

```json
{
  "mode": "once_delay",
  "delay_ms": 60000,
  "scope": ["agent"],
  "payload": "wake up"
}
```

### `PUT /agents/:id/timers/:timerId`

Updates an existing timer using the same body as timer creation.

### `DELETE /agents/:id/timers/:timerId`

Deletes a timer.

### `GET /agents/:id/meta`

Lists all metadata entries.

### `PUT /agents/:id/meta/:key`

Sets one metadata value.

```json
{
  "value": "example",
  "protection": "none"
}
```

Allowed metadata protection values are `none`, `readonly`, and `increment`.

### `DELETE /agents/:id/meta/:key`

Deletes one metadata entry.

### `PATCH /agents/:id/meta/:key/protection`

Updates metadata protection.

```json
{
  "protection": "readonly"
}
```

### `GET /agents/:id/identities`

Lists identity metadata without secret values.

```json
{
  "agentId": "agent-id",
  "identities": [
    {
      "purpose": "credential-purpose",
      "encrypted": true,
      "code_access": false
    }
  ]
}
```

### Identity and Credential Mutation

The daemon exposes loaded-agent identity storage directly for headless clients. Secret-bearing endpoints return values because they are intended for localhost automation; do not expose the daemon API on an untrusted interface.

Identity endpoints:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/agents/:id/identity?prefix=...` | List identity purposes, optionally filtered by prefix |
| `GET` | `/agents/:id/identity/entries` | List identity metadata without secret values |
| `GET` | `/agents/:id/identity/:purpose` | Read one decrypted identity value |
| `PUT` | `/agents/:id/identity/:purpose` | Set one identity value with `{ "value": "..." }` |
| `DELETE` | `/agents/:id/identity/:purpose` | Delete one identity value |
| `DELETE` | `/agents/:id/identity-prefix?prefix=...` | Delete identity values by purpose prefix |
| `PATCH` | `/agents/:id/identity/:purpose/code-access` | Set code access with `{ "codeAccess": true }` |
| `GET` | `/agents/:id/identity/password` | Return password protection and unlock status |
| `POST` | `/agents/:id/identity/password/unlock` | Unlock with `{ "password": "..." }` |
| `PUT` | `/agents/:id/identity/password` | Encrypt identity storage with `{ "password": "..." }` |
| `DELETE` | `/agents/:id/identity/password` | Remove identity password after unlock |
| `POST` | `/agents/:id/identity/password/change` | Change password with `{ "newPassword": "..." }` |
| `GET` | `/agents/:id/identity/did` | Read the agent DID |
| `POST` | `/agents/:id/identity/generate-keys` | Generate signing keys and DID |
| `POST` | `/agents/:id/identity/wipe` | Wipe all identity rows and DID metadata |

Provider credential endpoints:

| Method | Path | Description |
|--------|------|-------------|
| `PUT` | `/agents/:id/providers/:providerId/credential` | Store `provider:{providerId}:apiKey` with `{ "value": "..." }` |
| `GET` | `/agents/:id/providers/:providerId/credentials` | Return stored provider credentials and provider config overrides |
| `POST` | `/agents/:id/providers` | Upsert an ADF provider config with `{ "provider": { ... } }` |
| `DELETE` | `/agents/:id/providers/:providerId` | Remove provider config and `provider:{providerId}:*` identity rows |

MCP credential endpoints:

| Method | Path | Description |
|--------|------|-------------|
| `PUT` | `/agents/:id/mcp/credentials` | Store `mcp:{npmPackage}:{envKey}` with `{ "npmPackage": "...", "envKey": "...", "value": "..." }` |
| `GET` | `/agents/:id/mcp/credentials?npmPackage=...` | Return all credentials for an MCP package namespace |
| `POST` | `/agents/:id/mcp/servers` | Attach an ADF `McpServerConfig` with `{ "server": { ... } }` |
| `DELETE` | `/agents/:id/mcp/servers/:serverName?credentialNamespace=...` | Remove server config and matching MCP identity rows |

Adapter credential endpoints:

| Method | Path | Description |
|--------|------|-------------|
| `PUT` | `/agents/:id/adapters/credentials` | Store `adapter:{adapterType}:{envKey}` with `{ "adapterType": "...", "envKey": "...", "value": "..." }` |
| `GET` | `/agents/:id/adapters/credentials?adapterType=...` | Return all credentials for an adapter type |
| `POST` | `/agents/:id/adapters` | Attach/update an adapter config with `{ "adapterType": "...", "config": { ... } }` |
| `DELETE` | `/agents/:id/adapters/:adapterType` | Remove adapter config and `adapter:{adapterType}:*` identity rows |

### `GET /agents/:id/logs`

Lists structured runtime logs. Optional query parameters:

| Parameter | Description |
|-----------|-------------|
| `limit` | Number of log rows, clamped between `1` and `500` |
| `origin` | Filter by log origin |
| `event` | Filter by log event |

### `GET /agents/:id/logs/after?afterId=...`

Lists logs with IDs greater than `afterId`.

### `DELETE /agents/:id/logs`

Clears persisted logs.

### `GET /agents/:id/tables`

Lists local tables.

### `GET /agents/:id/tables/:table`

Queries a local table with optional `limit` and `offset`. Table names must start with `local_`; `adf_audit` is also readable.

### `DELETE /agents/:id/tables/:table`

Drops a local table. Only `local_` tables can be dropped.

## Agent Tasks and HIL

These endpoints expose task state and human-in-the-loop controls. Listing endpoints are read-only. Resolve/respond endpoints mutate pending runtime state.

### `GET /agents/:id/tasks`

Lists tasks. Optional query parameters:

| Parameter | Description |
|-----------|-------------|
| `status` | Filter by task status |
| `limit` | Number of task rows, clamped between `1` and `1000` |

Allowed `status` values:

```text
pending, pending_approval, running, completed, failed, denied, cancelled
```

Example:

```bash
curl "http://127.0.0.1:7385/agents/agent-id/tasks?status=pending_approval"
```

Response:

```json
{
  "agentId": "agent-id",
  "tasks": [
    {
      "id": "task-id",
      "status": "pending_approval",
      "tool": "fs_write",
      "requires_authorization": true
    }
  ]
}
```

### `GET /agents/:id/tasks/:taskId`

Returns one task.

```json
{
  "agentId": "agent-id",
  "task": {
    "id": "task-id",
    "status": "pending_approval"
  }
}
```

### `POST /agents/:id/tasks/:taskId/resolve`

Resolves a pending or pending-approval task.

Request body:

```json
{
  "action": "approve",
  "modifiedArgs": {}
}
```

Allowed `action` values:

| Action | Meaning |
|--------|---------|
| `approve` | Approve the task and allow it to continue |
| `deny` | Deny the task, optionally with `reason` |
| `pending_approval` | Mark a pending task as awaiting approval |

The body also accepts `modified_args` for clients that use snake case.

Response:

```json
{
  "agentId": "agent-id",
  "taskId": "task-id",
  "resolution": {
    "task_id": "task-id",
    "status": "approved"
  },
  "task": {}
}
```

### `GET /agents/:id/asks`

Lists pending `ask` requests.

```json
{
  "agentId": "agent-id",
  "asks": [
    {
      "requestId": "request-id",
      "question": "Proceed?"
    }
  ]
}
```

### `POST /agents/:id/asks/:requestId/respond`

Answers a pending `ask` request.

Request body:

```json
{
  "answer": "yes"
}
```

Response:

```json
{
  "agentId": "agent-id",
  "requestId": "request-id",
  "answered": true
}
```

### `POST /agents/:id/suspend/respond`

Responds to a pending suspend request.

Request body:

```json
{
  "resume": true
}
```

Response:

```json
{
  "agentId": "agent-id",
  "resume": true,
  "resolved": true
}
```

## Agent Runtime Diagnostics

### `GET /agents/:id/runtime`

Returns a per-agent runtime diagnostics bundle:

```json
{
  "agentId": "agent-id",
  "status": {},
  "adapters": {},
  "mcp": {},
  "triggers": {},
  "ws": {
    "configured": [],
    "active": []
  }
}
```

### `GET /agents/:id/runtime/adapters`

Returns configured adapter declarations and runtime adapter states for one agent.

Alias: `GET /agents/:id/adapters`

### `GET /agents/:id/runtime/mcp`

Returns configured MCP server declarations and runtime MCP server states for one agent.

Alias: `GET /agents/:id/mcp`

### `GET /agents/:id/runtime/triggers`

Returns configured triggers, target counts, target definitions, and current trigger display state.

Alias: `GET /agents/:id/triggers`

### `GET /agents/:id/runtime/ws`

Returns configured WebSocket connections, active WebSocket connections, and recent WebSocket logs.

Alias: `GET /agents/:id/ws`

## Agent Control

### `POST /agents/autostart`

Scans directories for `.adf` files and starts eligible autostart agents.

Request body:

```json
{
  "trackedDirs": ["/path/to/agents"],
  "maxDepth": 5
}
```

Response:

```json
{
  "scanned": 1,
  "started": [],
  "skipped": [],
  "failed": []
}
```

Skipped reasons:

| Reason | Meaning |
|--------|---------|
| `already_loaded` | This file is already loaded into the daemon |
| `not_autostart` | The agent is not configured for autostart |
| `password_protected` | The agent has encrypted identity data requiring human unlock |
| `unreviewed` | The agent has not been accepted through the review gate |

### `POST /agents/:id/start`

Triggers the startup event if the agent's configured `start_in_state` is `active`.

Response:

```json
{
  "success": true,
  "startupTriggered": true
}
```

### `POST /agents/:id/stop`

Stops and unloads the agent from the daemon runtime.

Response:

```json
{
  "success": true
}
```

### `POST /agents/:id/unload`

Alias for `POST /agents/:id/stop`.

### `POST /agents/:id/abort`

Aborts the current turn without unloading the agent.

Response:

```json
{
  "success": true
}
```

### `POST /agents/:id/chat`

Queues an asynchronous user chat event.

Request body:

```json
{
  "text": "hello daemon"
}
```

Response status is `202 Accepted`:

```json
{
  "accepted": true,
  "turnId": "turn_example123"
}
```

The response confirms scheduling, not completion. Poll `/agents/:id/status` and `/agents/:id/loop` to observe progress.

### `POST /agents/:id/trigger`

Queues an arbitrary ADF event dispatch. This is the write-side counterpart to `GET /events`: `/events` streams runtime events out to clients, while `/trigger` injects a client-provided event into the agent runtime.

The body can be a full dispatch:

```json
{
  "event": {
    "type": "chat",
    "source": "daemon-client",
    "data": {
      "message": {
        "seq": 1,
        "role": "user",
        "content_json": [{ "type": "text", "text": "hello" }],
        "created_at": 1710000000000
      }
    }
  },
  "scope": "agent"
}
```

Or a raw event plus an optional target:

```json
{
  "type": "startup",
  "target": { "scope": "agent" }
}
```

The daemon fills missing `event.id`, `event.time`, and `event.source`. Supported event types are:

```text
inbox, outbox, file_change, chat, timer, tool_call, task_create, task_complete, log_entry, startup, llm_call
```

Batch dispatches use `events`:

```json
{
  "events": [
    { "type": "startup" },
    { "type": "log_entry", "data": { "entry": {} } }
  ],
  "scope": "agent"
}
```

Response status is `202 Accepted`:

```json
{
  "accepted": true,
  "turnId": "trigger_example123"
}
```

The response confirms scheduling, not completion. Observe results with `/events`, `/agents/:id/status`, and `/agents/:id/loop`.

## Review

### `GET /agents/review?filePath=...`

Returns review information for an `.adf` file.

```json
{
  "agentId": "agent-id",
  "filePath": "/path/to/agents/example-agent.adf",
  "reviewed": false,
  "summary": {
    "name": "Example Agent"
  }
}
```

### `POST /agents/review/accept`

Accepts the agent review and stores the agent ID in `reviewedAgents`.

Request body:

```json
{
  "filePath": "/path/to/agents/example-agent.adf"
}
```

Response:

```json
{
  "agentId": "agent-id",
  "filePath": "/path/to/agents/example-agent.adf",
  "reviewed": true,
  "summary": {
    "name": "Example Agent"
  }
}
```

## ChatGPT Subscription Auth

### `GET /auth/chatgpt/status`

Returns the app-wide ChatGPT subscription auth status.

```json
{
  "authenticated": false
}
```

### `POST /auth/chatgpt/start`

Starts a detached OAuth flow. The daemon prints completion status to stdout.

Response:

```json
{
  "started": true,
  "authUrl": "https://...",
  "callbackPort": 12345
}
```

Open `authUrl` in a browser to complete sign-in.

### `POST /auth/chatgpt/logout`

Logs out of the ChatGPT subscription session.

```json
{
  "success": true
}
```

## Compute

Compute endpoints are available when the daemon is started with a compute service. `npm run daemon` wires `PodmanService`.

### `GET /compute/status`

Returns shared compute environment status.

```json
{
  "status": "stopped",
  "containerName": "adf-mcp",
  "activeAgents": []
}
```

### `GET /compute/containers`

Lists known compute containers.

```json
{
  "containers": [
    {
      "name": "adf-mcp",
      "status": "running",
      "running": true
    }
  ]
}
```

### `POST /compute/start`

Ensures the shared compute environment is running, then returns status.

### `POST /compute/stop`

Stops the shared compute environment, then returns status.

### `POST /compute/destroy`

Destroys the shared compute container state when supported by the daemon compute service.

### `POST /compute/setup`

Runs Podman setup/bootstrap steps used by Studio's compute setup UI.

```json
{
  "step": "check"
}
```

Valid `step` values are `check`, `install`, `machine_init`, and `machine_start`. `install` also accepts `installCommand`.

### `GET /compute/exec-log?name=...`

Returns recent compute exec history. `name` is optional and filters by container.

### `GET /compute/containers/:name`

Returns live detail for one compute container: process list, package summary, workspace listing, and inspect info when supported.

### `POST /compute/containers/:name/start`

Starts one known compute container.

### `POST /compute/containers/:name/stop`

Stops one known compute container.

### `POST /compute/containers/:name/destroy`

Removes one compute container.

## Admin Packages

These endpoints expose package installation surfaces used by Studio through IPC. They are intentionally direct and should only be used on trusted local daemon bindings.

### `GET /admin/mcp/packages`

Lists installed managed MCP packages across npm and Python/uvx package stores.

### `POST /admin/mcp/packages/npm`

Installs a managed npm MCP server package.

```json
{
  "package": "@modelcontextprotocol/server-github"
}
```

### `DELETE /admin/mcp/packages/npm?package=...`

Uninstalls a managed npm MCP server package.

### `POST /admin/mcp/packages/python`

Installs a managed Python MCP server package through uv/uvx.

```json
{
  "package": "mcp-server-time",
  "version": "1.0.0"
}
```

### `DELETE /admin/mcp/packages/python?package=...`

Uninstalls a managed Python MCP server package.

### `GET /admin/adapters/packages`

Lists installed managed channel adapter packages.

### `POST /admin/adapters/packages`

Installs a managed channel adapter npm package.

### `DELETE /admin/adapters/packages?package=...`

Uninstalls a managed channel adapter npm package.

### `GET /admin/sandbox/packages`

Lists sandbox packages available to code execution, including the package base path and installed module names.

### `POST /admin/sandbox/packages`

Installs one sandbox npm package.

```json
{
  "name": "lodash",
  "version": "4.17.21",
  "agentName": "optional-agent-name"
}
```

### `DELETE /admin/sandbox/packages?name=...`

Removes a sandbox package from the manifest.

### `POST /admin/sandbox/packages/check`

Checks which requested sandbox packages are missing or version-mismatched.

```json
{
  "packages": [
    { "name": "lodash", "version": "4.17.21" }
  ]
}
```

## Error Responses

Common errors:

| Status | Shape | Cause |
|--------|-------|-------|
| `400` | `{ "error": "..." }` | Invalid request body or query |
| `403` | `{ "error": "...", "code": "AGENT_REVIEW_REQUIRED" }` | Review gate blocked loading |
| `404` | `{ "error": "Unknown agent ..." }` | Agent ID is not loaded |
| `405` | `{ "error": "..." }` | Settings store is read-only |
| `503` | `{ "error": "..." }` | Optional service is not configured |
| `500` | `{ "error": "..." }` | Runtime error |

## Client Visibility

Use `/events` for live updates and `/agents/:id/loop` for persisted conversation history. `/events?since=...` can replay recent buffered events, but it is not a durable event log.
