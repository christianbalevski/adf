# Daemon Getting Started

This guide gets the ADF daemon, the headless ADF runtime that serves an API,
running, sets up your owner identity, creates or loads an agent, chats with it
and watches it work, first with the ADF CLI, then over HTTP.

## Install from npm

The [`@agentdocumentformat/cli`](https://www.npmjs.com/package/@agentdocumentformat/cli)
package ships the daemon and the ADF CLI, terminal app included, as one `adf`
command. It needs Node.js 22 or newer, and no Electron or compiler: native
modules (SQLite, the OS keychain) install from prebuilt binaries for Windows
x64, macOS (arm64/x64) and Linux (x64/arm64, glibc).

```bash
npm i -g @agentdocumentformat/cli
adf
```

`adf` opens the terminal app. When no daemon answers at the daemon URL and
that URL is on this machine, it first starts one in the background (a
`Starting the ADF daemon…` line). Quitting the terminal app leaves the daemon
and its agents running. One-shot commands start it the same way:

```bash
adf agents                 # one-shot CLI; `adf help` lists every command
adf identity               # owner identity status
adf --url http://127.0.0.1:7400 agents   # or ADF_DAEMON_URL; starts a daemon on port 7400 if needed
```

`--no-daemon` or `ADF_NO_AUTOSTART=1` turns auto-start off. Upgrade with
`npm install -g @agentdocumentformat/cli@latest`, then `adf daemon restart`.

## Manage the daemon

```bash
adf daemon status          # running? pid, uptime, version, data dir, log file
adf daemon logs -f         # its log (<data dir>/logs/adf-daemon.log); -n 200 for more lines
adf daemon stop            # graceful: agents unloaded, compute containers stopped
adf daemon restart
adf daemon start           # start it in the background without opening anything
adf daemon token           # print its access token (for scripts and remote clients)
adf daemon                 # run it in the foreground instead (Ctrl+C stops it); --port, --host, --settings
```

The background daemon is detached from the terminal (it survives closing it; no
console window on Windows) and keeps a pid file next to its settings
(`adf-daemon.pid`, or `adf-daemon-<port>.pid` off the default port;
`ADF_DAEMON_PIDFILE` overrides). To start it at login instead of on first use,
run `adf daemon` from your service manager (systemd user unit, launchd agent,
or a Windows scheduled task).

**ADF Studio.** Studio and the daemon would run the same agents from the same
files, so `adf` does not start a daemon while Studio runs on the same settings
(it looks for Studio's process and for a mesh server answering with this
install's runtime id) and says so. Quit Studio first, or keep using Studio.
`adf daemon start --force` skips the check. By default the daemon reads the
same settings file and OS-keychain owner identity as Studio on the same
machine; set `ADF_DAEMON_SETTINGS` or `ADF_USER_DATA_DIR` to keep it separate.

## Set up your owner identity

New agents are sealed under your owner identity: the same 12-word seed phrase
identity ADF Studio uses, so the same phrase makes you the same owner in both.

```bash
adf identity               # none | locked | restore-needed | ready
adf identity new           # create one; write the 12 words down (shown once)
adf identity restore       # or restore the phrase you already have
```

On a machine where Studio is already set up, the daemon picks the phrase up
from the OS keychain and reports `ready` with no steps. Without a usable OS
keychain (e.g. headless Linux), the phrase is kept in a passphrase-encrypted
file next to the daemon settings: unlock it after restarts with `adf identity
unlock`, or start the daemon with `ADF_OWNER_PASSPHRASE` /
`ADF_OWNER_PASSPHRASE_FILE`.

Until the identity is ready, `adf new` is refused, credentials cannot be
sealed, and agents spawned by agents (`sys_create_adf`) are created without
identity keys rather than with unsealed ones.

## Add a model provider

In the terminal app, `/provider add` (API keys) or `/login` (ChatGPT or Grok
subscriptions). Over HTTP it is `POST /runtime/providers`; the key goes to the
daemon's secret store (the OS keychain, or the owner's passphrase file), never
to the settings file. A settings file Studio already configured works as is.
See [Runtime Settings](runtime-settings.md).

## Create or load an agent

Create one from a template (sealed under your owner identity, like Studio's
"new agent"):

```bash
adf templates
adf new agent-1 --start
```

Or track a folder of existing `.adf` files: in the terminal app, `f` on the
Fleet or `/track <dir>`; over HTTP, `POST /tracked-dirs {"path": "/abs/folder"}`. The
daemon then loads every agent there that is marked `autostart` and reviewed on
this machine, at once and at every start. Agents it has not reviewed are listed
as needing review; accept them after reading what they can do (the terminal
app shows the review, or `POST /agents/review/accept`).

## Chat and watch

```bash
adf agents                                # loaded agents
adf chat agent-1 "hello"                  # queues a turn; prints the turn id
adf events agent-1                        # follow its live events
adf loops agent-1                         # main plus its inner loops (side loops)
adf chat agent-1 --loop researcher "look into X"
adf interrupt agent-1                     # end the running turn; the agent keeps working
adf stop agent-1                          # unload it (the file stays)
```

The terminal app does all of this in one place, plus approvals, questions,
files and settings: see [Terminal app](tui.md). The full command list is in
[ADF CLI](cli.md).

## The same over HTTP

Every request but `GET /health` needs the daemon's access token:

```bash
export ADF=http://127.0.0.1:7385
export TOKEN=$(adf daemon token 2>/dev/null)
H="Authorization: Bearer $TOKEN"

curl -s $ADF/health                                    # {"ok":true}, no token needed
curl -s -H "$H" $ADF/identity                          # owner identity status
curl -s -H "$H" $ADF/agents                            # loaded agents
curl -s -H "$H" $ADF/tracked-dirs/agents/all           # every agent in tracked folders, loaded or not
curl -s -H "$H" -X POST $ADF/agents/load \
  -H 'Content-Type: application/json' -d '{"filePath":"/abs/path/agent-1.adf"}'
curl -s -H "$H" -X POST $ADF/agents/agent-1/chat \
  -H 'Content-Type: application/json' -d '{"text":"hello"}'   # 202 {"accepted":true,"turnId":"turn_…"}
curl -sN -H "$H" "$ADF/events?agentId=<agent id>"      # live events (Server-Sent Events)
curl -s -H "$H" "$ADF/agents/agent-1/chat?limit=20"    # the conversation so far
curl -s -H "$H" "$ADF/agents/agent-1/tasks?status=pending_approval"
```

A chat answers `202` as soon as the turn is queued; the reply arrives as a
`turn.completed` event and in the agent's history. The
[API guide](api-guide.md) covers authentication, remote access, events,
approvals, credentials and the rest; the [API reference](api-reference.md)
lists every endpoint.

## Agent websites

The daemon runs the same mesh server as Studio, on `http://127.0.0.1:7295`
(`meshPort`). It is on by default and starts once a loaded agent is reachable
over the mesh; `adf network server stop` turns it off and keeps it off
(`meshServerEnabled: false`). Agents with a handle serve their public files,
shared files and API routes at:

```text
http://127.0.0.1:7295/agents/{handle}/
```

See [HTTP Serving](../guides/serving.md) for the serving configuration, the
same in Studio and the daemon.

## From a source checkout

In a clone of the repository, after `npm install`:

```bash
npm run daemon             # the daemon in the foreground (rebuilds better-sqlite3 for Node first)
npm run adf -- agents      # the CLI; `npm run adf` alone opens the terminal app
```

`npm run adf -- <command>` works like `adf <command>` everywhere in these docs
(including auto-starting the daemon). `npm run daemon` writes no pid file
unless `ADF_DAEMON_PIDFILE` is set; `adf daemon status` still finds it through
`/health`. Studio runs under Electron and the daemon under Node, so switching
between them from one checkout rebuilds `better-sqlite3`; see
[Operations](operations.md#native-sqlite-abi).

| Variable | Default | Purpose |
|----------|---------|---------|
| `ADF_DAEMON_HOST` | `127.0.0.1` | Daemon API bind address (non-loopback needs `ADF_DAEMON_TOKEN`) |
| `ADF_DAEMON_PORT` | `7385` | Daemon API port |
| `ADF_DAEMON_SETTINGS` | `<user data dir>/adf-settings.json` | Settings file; its directory also holds the token, keys and logs |
| `ADF_USER_DATA_DIR` | platform default | User data directory when `ADF_DAEMON_SETTINGS` is not set |
| `ADF_DAEMON_PIDFILE` | set by `adf daemon` | Pid file path |
| `ADF_DAEMON_TOKEN` | the `daemon-token` file | Access token override |
| `ADF_DAEMON_ALLOWED_HOSTS` | none | Extra `Host` names for a non-loopback bind |
| `ADF_DAEMON_BEHIND_PROXY` | off | `1`: a reverse proxy on this host forwards to the daemon; identity secrets and shutdown then need the local proof file |
| `ADF_OWNER_PASSPHRASE`, `ADF_OWNER_PASSPHRASE_FILE` | none | Unlock a passphrase-file owner identity at boot |
| `MESH_HOST`, `MESH_PORT` | from settings | Mesh server bind override |

The default user data directory is `ADF Studio` (when it holds Studio's
settings) or `adf-studio`, under `~/Library/Application Support` on macOS,
`%APPDATA%` on Windows, and `$XDG_CONFIG_HOME` or `~/.config` on Linux.

## How the daemon runs agents

The daemon builds every agent with the same canonical assembler Studio uses,
under the exhaustive `daemon` capability profile. `RuntimeService` routes chat,
startup and trigger requests through the assembled handle's dispatch API. See
[Runtime Architecture](runtime-architecture.md) and the
[Lifecycle Assembly Contract](lifecycle-assembly.md).
