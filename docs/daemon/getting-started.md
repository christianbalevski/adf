# Daemon Getting Started

This guide starts the ADF daemon, the headless ADF runtime that serves an API, then connects to its local HTTP API, loads an agent, sends a chat turn, and inspects runtime state without opening Studio.

## Install from npm

The quickest route, with no source checkout and no Electron: the [`agent-document-format`](https://www.npmjs.com/package/agent-document-format) package ships the daemon, the CLI and the TUI as one `adf` command. It needs Node.js 22 or newer. Native modules (SQLite, the OS keychain) install from prebuilt binaries for Windows x64, macOS (arm64/x64) and Linux (x64/arm64, glibc), so no compiler is needed.

```bash
npm i -g agent-document-format
adf
```

That is all: `adf` opens the TUI and, when no daemon answers at the local daemon URL, starts one in the background first (a `Starting the ADF daemon…` line, then the TUI). Quitting the TUI leaves the daemon and its agents running. One-shot commands do the same:

```bash
adf agents                 # one-shot CLI; `adf help` lists every command
adf identity               # owner identity status; `adf identity create|restore`
adf --url http://127.0.0.1:7400 agents   # or ADF_DAEMON_URL; starts a daemon on port 7400 if needed
```

Manage the background daemon with:

```bash
adf daemon status          # running? pid, uptime, version, log file
adf daemon logs -f         # its log (<data dir>/logs/adf-daemon.log); -n 200 for more lines
adf daemon stop            # graceful: agents unloaded, compute containers stopped
adf daemon restart
adf daemon start           # start it without opening anything
adf daemon                 # or run it in the foreground (Ctrl+C stops it); --port, --host, --settings
```

Auto-start only happens for a daemon URL on this machine (loopback); `--no-daemon` or `ADF_NO_AUTOSTART=1` turns it off. The background daemon is detached from the terminal (it survives closing it; no console window on Windows) and writes a pid file next to its settings (`adf-daemon.pid`, or `adf-daemon-<port>.pid` off the default port; `ADF_DAEMON_PIDFILE` overrides).

**ADF Studio:** Studio and the daemon would run the same agents from the same files, so `adf` does not start a daemon while Studio runs on the same settings (it checks for Studio's process and for a mesh server answering with this install's runtime id) and says so. Quit Studio first, or keep using Studio. `adf daemon start --force` overrides the check.

Everywhere this guide says `npm run daemon`, use `adf daemon`; for `npm run adf -- <command>`, use `adf <command>`. The environment variables below apply unchanged. The npm daemon reads the same default settings file and OS-keychain owner identity as Studio on the same machine; point `ADF_DAEMON_SETTINGS` / `ADF_USER_DATA_DIR` elsewhere to keep it separate.

To start it at login instead of on first use, use your platform's service manager (systemd user unit, launchd agent, or a Windows scheduled task) with `adf daemon` as the command. Upgrade with `npm install -g agent-document-format@latest`.

The rest of this guide runs the daemon from a source checkout.

## Prerequisites

Before running the daemon:

1. Install Node.js 22 LTS (Node.js 20+ is the current minimum), then install dependencies with `npm install`.
2. Configure at least one provider in the daemon settings file. You can write this JSON file directly, use the settings HTTP API, or reuse a settings file created by Studio.
3. Review any agents you want autostarted. Autostart uses the review gate and skips unreviewed agents.
4. Stop Studio if it is using the same `.adf` files or mesh port.

The daemon runs under regular Node, not Electron. `npm run daemon` rebuilds native SQLite bindings for Node before launch.

For the easiest first run, configure a provider and create an `.adf` agent in Studio with `npm run dev`, note its absolute path, then close Studio before starting the daemon. You can also configure the daemon directly with the settings API or a dedicated settings file.

## Start the Daemon

```bash
npm run daemon
```

By default, this starts:

- Daemon API: `http://127.0.0.1:7385`
- Mesh service: `http://127.0.0.1:7295` when at least one loaded agent is reachable through mesh visibility
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
npm run adf -- --help
npm run adf -- agents
```

The CLI connects to the daemon; it does not open an `.adf` file directly. Use the HTTP load endpoint below, or configure `trackedDirectories` and autostart.

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

## Set Up Your Owner Identity

New agents are sealed under your owner identity — the same 12-word seed phrase
identity ADF Studio uses, so the same phrase makes you the same owner in both.

```bash
npm run adf -- identity            # none | locked | restore-needed | ready
npm run adf -- identity new        # create one; write the 12 words down (shown once)
npm run adf -- identity restore    # or restore the phrase you already have
```

On a machine where Studio is already set up, the daemon picks the phrase up
from the OS keychain and reports `ready` with no steps. Without a usable OS
keychain (headless Linux), the phrase is stored in a passphrase-encrypted file
next to the daemon settings; unlock it after restarts with
`npm run adf -- identity unlock`, or start the daemon with
`ADF_OWNER_PASSPHRASE` / `ADF_OWNER_PASSPHRASE_FILE`.

Then create agents from a template:

```bash
npm run adf -- templates
npm run adf -- new agent-1 --start
```

Until the identity is ready, `adf new` is refused, and child agents spawned by
agents (`sys_create_adf`) are created without identity keys rather than with
unsealed ones.

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
npm run adf -- file agent-id README.md
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

The daemon starts the mesh server on the mesh port when at least one loaded agent has reachable mesh visibility. Agents with a handle can serve public files, shared files, API routes, and mesh endpoints when mesh behavior is enabled:

```text
http://127.0.0.1:7295/agents/{handle}/
```

For an agent with handle `example-agent`:

```text
http://127.0.0.1:7295/agents/example-agent/
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

Normal unload rejects new work, stops timer and trigger intake, waits up to five seconds for tracked dispatches, then aborts anything still running and releases resources. `abort` immediately cancels only the current turn and leaves the agent loaded.

Stop the daemon itself with `Ctrl-C` (`SIGINT`) or `SIGTERM`. It closes the HTTP server, unloads all agents through their assembled handles, stops compute, and removes its pid file when configured.

## How the Daemon Runs Agents

The daemon selects the exhaustive `daemon` capability profile and receives the same canonical assembled-agent handle used by Studio and headless callers. `RuntimeService` routes chat, startup, and trigger requests through the handle's dispatch-object API; hosts do not call `executeTurn()` directly. Full daemon agents use asynchronous teardown because MCP, adapters, compute, stream bindings, and mesh/WebSocket integration may require asynchronous cleanup.

See [Lifecycle Assembly Contract](lifecycle-assembly.md) for profiles, dispatch rules, startup once-semantics, transfer, and shutdown behavior.
