# Daemon Operations

This guide covers day-to-day operation for the daemon, the headless ADF runtime that serves an API: settings, ports, process supervision, compatibility with Studio, compute, troubleshooting, and known caveats.

## Recommended Operating Model

For local development:

1. Use Studio to create and configure agents.
2. Stop Studio.
3. Run `npm run daemon`.
4. Use HTTP clients, scripts, or the bundled CLI against `http://127.0.0.1:7385`.

For long-running daemon work:

1. Use a dedicated settings file with `ADF_DAEMON_SETTINGS`.
2. Use dedicated tracked directories for daemon-owned agents.
3. Avoid opening the same `.adf` files in Studio while the daemon owns them.
4. Use a process supervisor and `ADF_DAEMON_PIDFILE` if you need restart management.

## Settings File

By default, the daemon uses the same settings path as Studio:

```text
~/Library/Application Support/adf-studio/adf-settings.json
```

Override it:

```bash
ADF_DAEMON_SETTINGS=/path/to/adf-daemon/settings.json npm run daemon
```

Common settings keys used by the daemon:

| Key | Purpose |
|-----|---------|
| `providers` | Provider configurations used by `provider-factory` |
| `trackedDirectories` | Directories scanned at startup for autostart agents |
| `maxDirectoryScanDepth` | Directory scan depth for startup autostart |
| `reviewedAgents` | Agent IDs accepted by the review gate |
| `globalSystemPrompt` | Base prompt prepended to agents that include the app base prompt |
| `toolPrompts` | Conditional tool prompt sections |
| `compactionPrompt` | Prompt used for loop compaction |
| `mcpServers` | Global MCP server registrations |
| `adapters` | Global channel adapter registrations |
| `compute` | Podman and compute routing settings |
| `meshEnabled` | Enables mesh behavior unless explicitly `false` |
| `meshPort` | Mesh server port used by the mesh service |
| `meshLan` | Studio setting for LAN binding; daemon mesh behavior depends on mesh service support |

The daemon settings store reads JSON and writes JSON. It does not run all Studio settings migrations. If you use an isolated daemon settings file, start from the [runtime settings example](runtime-settings.md) or provide all required keys explicitly.

## Ports

| Service | Default | Override |
|---------|---------|----------|
| Daemon HTTP API | `127.0.0.1:7385` | `ADF_DAEMON_HOST`, `ADF_DAEMON_PORT` |
| Mesh server | `127.0.0.1:7295` | `MESH_HOST`, `MESH_PORT`, or mesh settings |

The daemon HTTP API should stay on localhost unless you add an authentication and network boundary outside the daemon.

Studio and daemon both use the mesh server port by default. Running both at the same time can cause a bind failure or split ownership of agents.

## Process Management

Start:

```bash
npm run daemon
```

Write a pid file:

```bash
ADF_DAEMON_PIDFILE=/tmp/adf-daemon.pid npm run daemon
```

The daemon removes the pid file on `SIGINT` and `SIGTERM` shutdown.

The daemon logs to stdout/stderr. Important startup messages include:

- Listening address
- Settings path
- Mesh server startup errors
- Autostart report
- MCP setup logs
- Adapter startup logs
- Compute startup logs

## CLI Operations

Use the bundled CLI for common operational checks:

```bash
npm run adf -- agents
npm run adf -- runtime
npm run adf -- providers
npm run adf -- network
npm run adf -- events
```

Use `--json` for scripts:

```bash
npm run adf -- --json runtime
```

Use `ADF_DAEMON_URL` or `--url` when the daemon is not on the default URL:

```bash
ADF_DAEMON_URL=http://127.0.0.1:7390 npm run adf -- agents
```

See [Daemon CLI](cli.md) for the full command reference.

## Stop and Abort

`stop` and `unload` release an agent from the daemon runtime:

```bash
npm run adf -- stop agent-id
```

This disposes the loaded runtime wiring, including adapters, MCP clients, sandbox workers, and mesh registration.

`abort` cancels the current turn but keeps the agent loaded:

```bash
npm run adf -- abort agent-id
```

Use `abort` for stuck or unwanted turns when the agent should remain available.

## Human-In-The-Loop Operations

The daemon exposes pending tool approvals and `ask` requests so headless clients can complete human-in-the-loop workflows.

List tasks and pending approvals:

```bash
npm run adf -- tasks agent-id
npm run adf -- task agent-id task-id
```

Approve or deny a task:

```bash
npm run adf -- approve agent-id task-id
npm run adf -- deny agent-id task-id "not allowed"
```

List and answer pending asks:

```bash
npm run adf -- asks agent-id
npm run adf -- answer agent-id request-id "yes, continue"
```

The HTTP API also exposes `POST /agents/:id/suspend/respond` for pending suspend requests.

## Native SQLite ABI

Studio runs under Electron and the daemon runs under Node. Native modules compiled for one runtime may not load in the other.

`npm run daemon` runs:

```bash
node scripts/rebuild-for-node.mjs
```

before launching the daemon. This fixes the common case where Studio rebuilt `better-sqlite3` for Electron and the daemon later needs it for Node.

If Studio fails after daemon work, reinstall or run the Studio flow so Electron rebuilds native modules again.

## Review and Autostart

Autostart is intentionally conservative. The daemon skips agents that are unreviewed, password protected, not configured for autostart, or already loaded.

Use the review endpoints:

```bash
curl "http://127.0.0.1:7385/agents/review?filePath=/path/to/agent.adf"
```

```bash
curl -X POST http://127.0.0.1:7385/agents/review/accept \
  -H 'Content-Type: application/json' \
  -d '{"filePath":"/path/to/agent.adf"}'
```

Then either restart the daemon or call:

```bash
curl -X POST http://127.0.0.1:7385/agents/autostart \
  -H 'Content-Type: application/json' \
  -d '{"trackedDirs":["/path/to/agents"],"maxDepth":5}'
```

## Compute Operations

Check compute status:

```bash
curl http://127.0.0.1:7385/compute/status
```

Start shared compute:

```bash
curl -X POST http://127.0.0.1:7385/compute/start
```

Stop shared compute:

```bash
curl -X POST http://127.0.0.1:7385/compute/stop
```

List compute containers:

```bash
curl http://127.0.0.1:7385/compute/containers
```

Agents with isolated compute enabled can cause agent-specific containers to start during runtime build. MCP servers may also use shared or isolated containers depending on compute routing.

## Channel Adapter Operations

The daemon can start configured channel adapters for loaded agents. Current built-in adapters are Telegram and email.

Operational checklist:

- Register the adapter in settings under `adapters`.
- Configure per-agent adapter settings in `config.adapters`.
- Store required credentials either in global adapter environment settings or per-agent identity storage.
- Enable `on_inbox` triggers if inbound messages should wake the agent.
- Confirm daemon logs show the adapter started for the agent.

Inbound messages are persisted to the ADF inbox. The daemon trigger evaluator then wakes the loop when the agent's trigger config matches the inbound event.

## MCP Operations

The daemon connects MCP servers declared by the agent when they are registered in settings or include enough source information to resolve.

Operational checklist:

- Confirm `mcpServers` settings contain the server registration.
- Confirm the agent config includes the server under `mcp.servers`.
- Provide required environment variables or identity-backed secrets.
- Check daemon logs for discovery or skip messages.
- Inspect agent config after load; discovered MCP tools are added as tool declarations.

If a server is not registered and has no source, the daemon skips it and continues loading the agent.

## Mesh and Serving Operations

The daemon starts the mesh server on the configured mesh port. Agent websites use the same serving config described in [HTTP Serving](../guides/serving.md), and mesh behavior is enabled unless `meshEnabled` is explicitly `false`.

Typical URLs:

```text
http://127.0.0.1:7295/{handle}/
http://127.0.0.1:7295/{handle}/mesh/inbox
http://127.0.0.1:7295/{handle}/mesh/card
http://127.0.0.1:7295/{handle}/mesh/health
```

If an agent website does not appear:

1. Check that the daemon is running.
2. Check that mesh is enabled.
3. Check that the agent is loaded.
4. Check that the agent has a unique handle.
5. Check daemon logs for mesh server bind errors.
6. Confirm Studio is not already using port `7295`.

## Studio Compatibility

The daemon is built alongside Studio, not as a replacement.

Known compatibility risks:

- Studio and daemon can both open and write the same `.adf` files.
- Both can try to own the same mesh port.
- Both can start adapters for the same external account or bot.
- Both can trigger the same autostart or timer behavior.
- Switching between them can rebuild native SQLite bindings for different runtimes.

The safest workflow is single-owner operation: either Studio owns an agent file, or the daemon owns it.

## Troubleshooting

### `Unable to read ADF boot status`

Run the daemon through `npm run daemon` so the Node ABI rebuild happens before launch. The autostart report now includes the underlying boot-status error when available.

### Agent skipped as `unreviewed`

Accept review for that `.adf` file, then rerun autostart or restart the daemon.

### Agent skipped as `password_protected`

Password-protected agents need a human unlock path. The daemon currently skips them during autostart.

### `POST /agents/:id/chat` returns accepted but nothing appears

Check:

- The agent ID, handle, or name is loaded and resolves to the intended agent.
- Provider settings are valid.
- Daemon stderr for provider errors.
- `npm run adf -- runtime agent-id` for adapters, MCP, triggers, and WebSocket diagnostics.
- `npm run adf -- tasks agent-id` for pending approvals that may be blocking progress.
- `npm run adf -- asks agent-id` for pending user questions.
- `/events?agentId=agent-id` for live state, tool, turn, or error events.
- `/agents/:id/status` for runtime state.
- `/agents/:id/loop?limit=20` for recent loop entries.

The chat endpoint is asynchronous, so `202 Accepted` means the turn was queued, not that it completed.

### Adapter messages are stored but the agent does not respond

Check the agent's `on_inbox` trigger. Inbound adapter messages wake the loop only when trigger config includes an enabled agent-scope target.

### Mesh website does not load

Check port `7295`, mesh enabled status, agent handle, and daemon logs. Studio running at the same time is the most common conflict.

### MCP tools are missing

Check whether the MCP server is registered in settings. Unregistered servers without source metadata are skipped. Also check environment variables, package installation, `uvx` resolution, and container routing logs.

CLI shortcuts:

```bash
npm run adf -- mcp
npm run adf -- mcp agent-id
```

## Current Caveats

- The `/events` stream uses an in-memory ring buffer, not durable event storage.
- File-change triggers are incomplete in headless operation.
- No built-in authentication on the daemon HTTP API.
- No cross-process lock prevents Studio and daemon from opening the same `.adf`.
