# Daemon Operations

Day-to-day operation of the daemon, the headless ADF runtime that serves an
API: running and stopping it, where it keeps its data, ports, the access token,
Studio compatibility, and troubleshooting. Building a client instead? See the
[API guide](api-guide.md).

## Operating model

- **Personal machine:** install `@agentdocumentformat/cli` and run `adf`. It
  starts the daemon in the background when needed, and the daemon keeps your
  agents running after you close the terminal app. Studio and the daemon share
  settings and owner identity, but should not run at the same time (see
  [Studio compatibility](#studio-compatibility)).
- **Server or always-on host:** run `adf daemon` (foreground) under a service
  manager, with a dedicated settings file (`ADF_DAEMON_SETTINGS`), dedicated
  tracked folders, and a passphrase-file owner identity unlocked at boot
  (`ADF_OWNER_PASSPHRASE_FILE`) when the machine has no OS keychain.

## Running and stopping

| Task | Command |
|------|---------|
| Start in the background | `adf daemon start` (or any `adf` command, which auto-starts a local daemon; `--no-daemon` / `ADF_NO_AUTOSTART=1` disables that) |
| Run in the foreground | `adf daemon [--port N] [--host H] [--settings FILE]` (from source: `npm run daemon`) |
| Status | `adf daemon status`: url, running, pid, uptime, version, loaded agents, data dir, log file (exit code 3 when not running) |
| Logs | `adf daemon logs [-f] [-n N]` (background daemons log to `<data dir>/logs/adf-daemon.log`; foreground daemons to stdout/stderr) |
| Stop | `adf daemon stop` |
| Restart | `adf daemon restart` |

`adf daemon stop` calls `POST /daemon/shutdown` (local callers only, never through a proxy) and waits for
the process to exit. It is the same bounded shutdown as Ctrl+C or `SIGTERM`:
token usage is flushed, the HTTP server closes, every agent is unloaded
immediately (running turns are aborted), compute containers stop, then
WebSocket connections, the mesh server, sandboxes and child processes. The
whole shutdown is capped at 20 seconds. On Windows, `adf daemon stop` is the
only graceful way to stop a detached daemon.

`adf daemon start` refuses while ADF Studio runs on the same settings (see
below); `--force` skips that. A daemon that is starting under an existing pid
file is waited for rather than started twice, and the daemon itself refuses to
start when its pid file names a live process.

Startup output includes the listen address, settings path, owner identity
status, token file, envelope key, and the autostart report. Uncaught errors in
one agent are logged, never fatal: the daemon keeps the rest of the fleet
running.

## Data directory

Everything lives next to the settings file (`ADF_DAEMON_SETTINGS`'s directory,
else `ADF_USER_DATA_DIR`, else the platform default: `ADF Studio` or
`adf-studio` under `~/Library/Application Support`, `%APPDATA%`, or
`$XDG_CONFIG_HOME` / `~/.config`):

| File | What |
|------|------|
| `adf-settings.json` | Settings ([Runtime Settings](runtime-settings.md)) |
| `daemon-token` | The API access token (0600) |
| `runtime-enc-key`, `runtime-enc-key.pub` | The daemon's envelope key (lets it unlock agent credentials Studio shared with it) |
| `owner-secrets.json` | The owner identity, when stored in a passphrase file instead of the OS keychain |
| `adf-daemon[-<port>].pid` | Pid file of a daemon started by `adf` |
| `logs/adf-daemon[-<port>].log` | Log of a background daemon |

`adf daemon status` prints the directory. Agent templates (`templates/`,
`templates-trash/`) live in the user data directory, which is the same place
unless `ADF_DAEMON_SETTINGS` points elsewhere.

## Ports

| Service | Default | Override |
|---------|---------|----------|
| Daemon HTTP API | `127.0.0.1:7385` | `ADF_DAEMON_HOST`, `ADF_DAEMON_PORT` (`adf daemon --host/--port`) |
| Mesh server (agent websites, mesh delivery) | `127.0.0.1:7295` | `meshPort` setting, `MESH_HOST`, `MESH_PORT` |

Keep the daemon API on localhost. Binding another host requires
`ADF_DAEMON_TOKEN`, and host names clients use go in `ADF_DAEMON_ALLOWED_HOSTS`
(IP literals on the bound port are accepted as is). The daemon speaks plain
HTTP; for remote use prefer an SSH tunnel or a TLS reverse proxy
([remote access](api-guide.md#remote-access)). Behind a reverse proxy on the
same host, set `ADF_DAEMON_BEHIND_PROXY=1`: identity secrets and shutdown then
need the per-start proof in `<settings dir>/daemon-local-proof`, which only
`adf` on this host sends ([loopback-only routes](api-guide.md#loopback-only-routes)).

The mesh server is on by default. It binds once a loaded agent is reachable
over the mesh, on loopback, and rebinds to all interfaces when an agent with
`lan` or `public` visibility loads (or when `meshLan` is set). `adf network
server stop|start` (or `POST /network/server/stop|start`) turns it off or on
and persists the choice as `meshServerEnabled`. Studio uses the same port:
running both makes one fail to bind.

## Access token

Every request but `GET /health` needs `Authorization: Bearer <token>`
([details](api-guide.md#base-url-and-authentication)). On first start the
daemon writes a random token to `daemon-token` in its data directory;
`ADF_DAEMON_TOKEN` overrides it. Local clients (the `adf` CLI, the terminal
app, `adf daemon start|stop|status`, auto-start) read the file by themselves,
so nothing needs configuring on the daemon's machine. The file is replaced
when malformed; delete it and restart the daemon to rotate the token.

| Task | How |
|------|-----|
| Print the token (e.g. for a remote client) | `adf daemon token` on the daemon host (token on stdout, its source on stderr) |
| Use it from another machine | `adf --url http://host:7385 --token <token> …`, or `ADF_DAEMON_TOKEN` |
| Scripts / curl | `curl -H "Authorization: Bearer $(adf daemon token 2>/dev/null)" http://127.0.0.1:7385/agents` |

Browser requests are refused: a foreign `Origin` or `Sec-Fetch-Site:
cross-site` gets `403 cross_origin`, a `Host` outside the allow-list gets
`403 host_not_allowed` (DNS rebinding), and the daemon sends no CORS headers.
An older `adf` without token support gets a `401` that says to update it or
use `adf daemon token`.

## Owner identity and credentials

`adf identity` shows the owner identity: `none`, `locked`, `restore-needed` or
`ready` (`adf identity new|restore|unlock|lock`; `/identity` in the terminal
app). These routes answer only on the daemon's machine. With passphrase-file
storage, unlock after every restart, or set `ADF_OWNER_PASSPHRASE` /
`ADF_OWNER_PASSPHRASE_FILE` for the daemon.

Agent credentials (channel tokens, MCP keys, per-agent provider keys) are
sealed in each agent's file. The API returns only metadata about them (set,
sealed, locked, length). Agents loaded while the identity is not ready run
`degraded` without them and unlock in place once it is (checked again every
minute). While an agent's credentials are locked, saving one answers `409
credentials_locked`: unlock and save again, or replace the value (`"replace":
true`, or Replace in the terminal app). Replacing discards the old sealed value
unread, stores the new one unsealed until the envelope unlocks (it is then
sealed automatically), and logs `credential_replaced` to the agent's
`adf_logs`. Agent code can never do this. See
[Credentials](api-guide.md#credentials).

## Everyday checks

```bash
adf agents                     # loaded agents
adf runtime                    # daemon diagnostics: providers, auth, MCP, channels, network, compute
adf runtime agent-1            # one agent: status, channels, MCP, triggers, WebSockets
adf tasks agent-1              # pending approvals
adf asks agent-1               # pending questions
adf events agent-1             # live events
adf --json runtime             # JSON for scripts
```

`--url` / `ADF_DAEMON_URL` point the CLI at another daemon. The full command
list is in [ADF CLI](cli.md).

## Stop, interrupt, abort

- `adf stop agent-1` unloads the agent (its file stays): new work is refused,
  timer and trigger intake stops, in-flight work gets five seconds, then the
  rest is aborted and the agent's channels, MCP clients, sandbox workers and
  mesh registration are disposed.
- `adf interrupt agent-1 [--loop <name>]` ends the running turn; the loop goes
  `idle` and keeps taking chats, timers and triggers. Use this for a stuck or
  unwanted turn.
- `adf abort agent-1 [--loop <name>]` is the hard stop: that loop's executor
  stays `stopped` until the agent is reloaded.

## Approvals and questions

```bash
adf tasks agent-1                      # pending approvals
adf approve agent-1 <taskId>
adf deny agent-1 <taskId> "use staging"   # the reason reaches the agent as feedback
adf asks agent-1
adf answer agent-1 <requestId> "yes, continue"
```

Always-approve, approve-all and suspend answers are in the terminal app and
the API ([HIL](api-guide.md#approvals-questions-and-suspends-hil)).

## Review and autostart

At boot, and whenever a folder is tracked, the daemon loads the agents in its
tracked folders that are marked `autostart` and reviewed on this machine. It
skips agents that are unreviewed, password-protected, not autostart, or
already loaded; `adf` shows them in the fleet with what each needs.

Accept a review in the terminal app, or over HTTP (`GET /agents/review?filePath=`,
then `POST /agents/review/accept`), then start the agent (`adf start <agent>`)
or rescan (`POST /agents/autostart`). Agents an agent creates (`sys_create_adf`)
and agents made with `adf new` are reviewed automatically.

## Native SQLite ABI

Only relevant from a source checkout: Studio runs under Electron and the
daemon under Node, and `better-sqlite3` must be built for the runtime that
loads it. `npm run daemon` (and `adf` from source) runs
`node scripts/rebuild-for-node.mjs` first. If Studio then reports a
`better-sqlite3` ABI error, rebuild for Electron with `npm run postinstall`
before starting Studio. The npm package ships prebuilt binaries and is
unaffected.

## Compute

The daemon starts the shared compute container (Podman) in the background a
few seconds after boot; without Podman, MCP servers run on the host. Agents
with isolated compute get their own container when they load.

With `ADF` and `H` set as in the [API guide](api-guide.md#quick-start):

```bash
curl -s -H "$H" $ADF/compute/status
curl -s -H "$H" -X POST $ADF/compute/start      # also /compute/stop, /compute/containers
```

## Channels and MCP servers

- **Channels** (Telegram, email, installed packages) are configured per agent:
  credentials in the agent (`adapter:<type>:<KEY>`), then the channel attached
  to the agent. Attaching one starts it immediately. Inbound messages wake the
  agent through its `on_inbox` trigger. In the terminal app: `/channels`.
- **MCP servers** are declared per agent (`mcp.servers`); daemon-wide
  registrations in `mcpServers` and managed packages supply how to run them. A
  newly attached server connects at the next agent start, or at once with
  `POST /agents/:id/mcp/servers/:name/restart`. A declared server that is not
  registered and has no source is skipped, and the agent loads without it. In
  the terminal app: `/mcp`.

## Mesh and agent websites

Agent websites and mesh delivery are served by the mesh server:

```text
http://127.0.0.1:7295/agents/{handle}/
http://127.0.0.1:7295/agents/{handle}/card
http://127.0.0.1:7295/agents/{handle}/health
```

If a website does not appear: the agent is loaded, has a unique handle and a
reachable visibility, mesh is enabled (`meshEnabled` is not `false`), the mesh
server is not turned off (`meshServerEnabled`), and nothing else (Studio) holds
port 7295. `adf network` shows the state.

## Studio compatibility

Studio and the daemon are separate hosts of the same runtime, not a
replacement for each other. Run one at a time on the same agents:

- both would open and write the same `.adf` files, start the same channels
  (the same bot account), and fire the same timers;
- both want mesh port 7295;
- from a source checkout, switching rebuilds `better-sqlite3`.

`adf` refuses to auto-start a daemon while Studio runs on the same settings.
A daemon started by hand (`adf daemon`, `npm run daemon`) is not checked, and
nothing stops Studio from starting while the daemon runs.

## Troubleshooting

**`401 unauthorized`.** The client has no token or the wrong one. Local `adf`
reads it by itself (update an old `adf`); elsewhere pass `--token` or
`ADF_DAEMON_TOKEN` (from `adf daemon token`). A token in the environment
overrides the file on both sides.

**`403 host_not_allowed`.** The `Host` header does not name the daemon: e.g. a
proxy forwarding its public host name (loopback names are accepted on any
port, so SSH tunnels are fine). See [remote access](api-guide.md#remote-access).

**`403 cross_origin`.** A browser made the request. Browser pages cannot call
the daemon; use a backend.

**`403 loopback_only`.** An owner identity secret route or `POST
/daemon/shutdown` from anything but this machine's own `adf`: another host, a
request with proxy headers, or (with `ADF_DAEMON_BEHIND_PROXY`) one without the
local proof. Run the command on the daemon host against `127.0.0.1`.

**Agent skipped as `unreviewed` / `password_protected`.** Accept its review,
then start it or rescan. Password-protected agents need a human unlock and are
never autostarted.

**Chat accepted but nothing happens.** `202` means queued, not done. Check
`adf events <agent>` (errors, `hil.requested`), `adf tasks <agent>` and
`adf asks <agent>` (the turn may be waiting for you), `adf status <agent>`
(`runtimeState`, `degraded`), `adf runtime <agent>`, and the provider's
sign-in or key (`adf auth`, `adf providers`).

**Channel messages are stored but the agent does not answer.** Check the
agent's `on_inbox` trigger: inbound messages wake it only with an enabled
agent-scope target.

**MCP tools are missing.** `adf mcp <agent>` shows each server's state and
error. Check the registration or source, credentials, package install, `uvx`,
and container routing in the log.

**`Unable to read ADF boot status` (source checkout).** Start through
`npm run daemon` or `adf`, so `better-sqlite3` is rebuilt for Node.

## Current caveats

- `/events` replays from an in-memory buffer of 1000 frames; it is not an
  event log. Durable history is in each agent's file.
- File-change triggers are incomplete in headless operation (there is no
  document editor).
- The daemon speaks plain HTTP; remote use needs an SSH tunnel or TLS in front.
- No cross-process lock keeps Studio and a hand-started daemon off the same
  `.adf` files.
