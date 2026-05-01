# Daemon Getting Started

This guide starts the ADF daemon, the headless ADF runtime that serves an API, then connects to its local HTTP API, loads an agent, sends a chat turn, and inspects runtime state without opening Studio.

## Prerequisites

Before running the daemon:

1. Install dependencies with `npm install`.
2. Configure at least one provider in the daemon settings file. You can write this JSON file directly, use the settings HTTP API, or reuse a settings file created by Studio.
3. Review any agents you want autostarted. Autostart uses the review gate and skips unreviewed agents.
4. Stop Studio if it is using the same `.adf` files or mesh port.

The daemon runs under regular Node, not Electron. `npm run daemon` rebuilds native SQLite bindings for Node before launch.

## Start the Daemon

```bash
npm run daemon
```

By default, this starts:

- Daemon API: `http://127.0.0.1:7385`
- Mesh server: `http://127.0.0.1:7295`
- Settings file: the platform default `adf-settings.json` used by ADF Studio

Useful environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `ADF_DAEMON_HOST` | `127.0.0.1` | Host for the daemon HTTP API |
| `ADF_DAEMON_PORT` | `7385` | Port for the daemon HTTP API |
| `ADF_DAEMON_SETTINGS` | Platform default settings path | JSON settings file to load |
| `ADF_DAEMON_PIDFILE` | unset | Optional path where the daemon writes its process id |
| `ADF_USER_DATA_DIR` | platform default user data directory | Base user data directory used when no daemon settings path is provided |

On macOS, the default settings path is:

```text
~/Library/Application Support/adf-studio/adf-settings.json
```

In another terminal, use the CLI client with:

```bash
npm run adf -- agents
```

## Check Health

```bash
curl http://127.0.0.1:7385/health
```

Expected response:

```json
{
  "ok": true
}
```

## Inspect Settings

```bash
curl http://127.0.0.1:7385/settings
```

The response includes the settings file path and the loaded JSON settings:

```json
{
  "filePath": "/path/to/adf-settings.json",
  "settings": {
    "trackedDirectories": ["/path/to/agents"],
    "meshEnabled": true,
    "providers": []
  }
}
```

The daemon settings store reads and writes JSON directly. It does not provide the Studio settings UI, but it uses the same key names.

You do not need to open Studio to configure the daemon. See [Runtime Settings](runtime-settings.md) for a direct settings file example and the supported shape.

## Load an Agent

Load a specific `.adf` file:

```bash
curl -X POST http://127.0.0.1:7385/agents/load \
  -H 'Content-Type: application/json' \
  -d '{"filePath":"/path/to/agents/example-agent.adf"}'
```

Direct local loads bypass the review gate by default. Strict clients can require review:

```bash
curl -X POST http://127.0.0.1:7385/agents/load \
  -H 'Content-Type: application/json' \
  -d '{"filePath":"/path/to/agents/example-agent.adf","requireReview":true}'
```

If review is required and the agent has not been accepted, the daemon returns:

```json
{
  "error": "Agent must be reviewed before loading into the runtime.",
  "code": "AGENT_REVIEW_REQUIRED",
  "agentId": "agent-id",
  "filePath": "/path/to/agents/example-agent.adf"
}
```

## Review an Agent

Read review information:

```bash
curl "http://127.0.0.1:7385/agents/review?filePath=/path/to/agents/example-agent.adf"
```

Accept review:

```bash
curl -X POST http://127.0.0.1:7385/agents/review/accept \
  -H 'Content-Type: application/json' \
  -d '{"filePath":"/path/to/agents/example-agent.adf"}'
```

The daemon stores accepted agent IDs in the `reviewedAgents` settings key.

## List Agents

```bash
curl http://127.0.0.1:7385/agents
```

Example response:

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

The CLI equivalent:

```bash
npm run adf -- agents
```

## Start an Agent

```bash
curl -X POST http://127.0.0.1:7385/agents/agent-id/start
```

`start` triggers the startup event only when the agent's configured `start_in_state` is `active`.

Example response:

```json
{
  "success": true,
  "startupTriggered": true
}
```

The CLI equivalent:

```bash
npm run adf -- start agent-id
```

## Send a Chat Turn

```bash
curl -X POST http://127.0.0.1:7385/agents/agent-id/chat \
  -H 'Content-Type: application/json' \
  -d '{"text":"hello daemon"}'
```

Chat requests are accepted asynchronously:

```json
{
  "accepted": true,
  "turnId": "turn_example123"
}
```

The daemon schedules the turn and returns immediately. Use the status and loop endpoints to observe completion.

The CLI equivalent:

```bash
npm run adf -- chat agent-id "hello daemon"
```

For live visibility, open the Server-Sent Events stream in another terminal:

```bash
curl -N http://127.0.0.1:7385/events
```

Filter to one agent:

```bash
curl -N "http://127.0.0.1:7385/events?agentId=agent-id"
```

The CLI can follow the same stream:

```bash
npm run adf -- events agent-id
```

## Inspect Status

```bash
curl http://127.0.0.1:7385/agents/agent-id/status
```

Example response:

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

The CLI equivalent:

```bash
npm run adf -- status agent-id
```

## Inspect the Loop

```bash
curl "http://127.0.0.1:7385/agents/agent-id/loop?limit=20"
```

Pagination parameters:

- `limit` defaults to `50` and is clamped between `1` and `500`.
- `offset` defaults to the last page.

The response includes persisted loop entries:

```json
{
  "agentId": "agent-id",
  "total": 42,
  "limit": 20,
  "offset": 22,
  "entries": []
}
```

`/loop` is still useful for persisted history and pagination. Use `/events` when a headless client needs live updates.

## Inspect Resources and Diagnostics

Recent daemon builds expose read-only resources and diagnostics for headless clients:

```bash
npm run adf -- runtime
npm run adf -- runtime agent-id
npm run adf -- files agent-id
npm run adf -- file agent-id document.md
npm run adf -- inbox agent-id
npm run adf -- outbox agent-id
npm run adf -- timers agent-id
npm run adf -- tasks agent-id
npm run adf -- asks agent-id
npm run adf -- identities agent-id
```

Use `--json` when scripting:

```bash
npm run adf -- --json runtime agent-id
```

Human-in-the-loop task approvals and pending `ask` requests are also available through the daemon:

```bash
npm run adf -- approve agent-id task-id
npm run adf -- deny agent-id task-id "not allowed"
npm run adf -- answer agent-id request-id "yes, continue"
```

## Autostart Agents

At daemon startup, the daemon reads `trackedDirectories` from settings and scans for `.adf` files. It autostarts only agents that:

- Are marked `autostart`
- Are not already loaded
- Are not password protected
- Have been reviewed
- Can be opened and assigned a provider

You can also trigger an autostart scan manually:

```bash
curl -X POST http://127.0.0.1:7385/agents/autostart \
  -H 'Content-Type: application/json' \
  -d '{"trackedDirs":["/path/to/agents"],"maxDepth":5}'
```

Example report:

```json
{
  "scanned": 3,
  "started": [
    {
      "agentId": "agent-id",
      "filePath": "/path/to/agents/example-agent.adf",
      "name": "Example Agent",
      "startupTriggered": true
    }
  ],
  "skipped": [
    {
      "filePath": "/path/to/agents/other-agent.adf",
      "name": "Other Agent",
      "reason": "unreviewed",
      "agentId": "other-agent-id"
    }
  ],
  "failed": []
}
```

Skip reasons are `already_loaded`, `not_autostart`, `password_protected`, and `unreviewed`.

## Serve Agent Websites

The daemon starts the mesh server on the mesh port. Agents with a handle can serve public files, shared files, API routes, and mesh endpoints when mesh behavior is enabled:

```text
http://127.0.0.1:7295/{handle}/
```

For an agent with handle `example-agent`:

```text
http://127.0.0.1:7295/example-agent/
```

See [HTTP Serving](../guides/serving.md) for agent serving configuration. The same serving configuration applies in Studio and the daemon.

## Stop or Abort

`stop` unloads an agent from the daemon runtime:

```bash
npm run adf -- stop agent-id
```

`abort` cancels the current turn but keeps the agent loaded:

```bash
npm run adf -- abort agent-id
```
