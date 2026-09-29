# ADF CLI

The ADF CLI (`adf`) is a client for the daemon HTTP API. It is useful for local scripts, smoke checks, and terminal-first operation. The CLI is a client of the daemon; when the daemon URL is on this machine and nothing answers there, `adf` starts the daemon in the background first (see [Background daemon](#background-daemon)).

Run it with `adf <command>` (the [npm package](getting-started.md#install-from-npm)) or, from a source checkout:

```bash
npm run adf -- <command>
```

With no command, `npm run adf` opens the terminal app instead: the
whole fleet, every agent's loops, chat, approvals, files and live events. See
[Terminal app](tui.md).

Show the built-in command list without contacting the daemon:

```bash
npm run adf -- --help
```

The npm script runs the TypeScript CLI source directly; a Studio production build is not required.

The CLI talks to `http://127.0.0.1:7385` by default.

## Options

| Option | Description |
|--------|-------------|
| `--url <daemon-url>` | Override the daemon base URL |
| `--url=<daemon-url>` | Same as `--url` |
| `-u <daemon-url>` | Short form URL override |
| `--token <token>` | Daemon access token (default `ADF_DAEMON_TOKEN`, else read automatically on the daemon's machine) |
| `--json` | Print raw JSON responses instead of formatted tables |
| `--no-daemon` | Never start the daemon automatically (also `ADF_NO_AUTOSTART=1`) |
| `--version`, `-v` | Print the version |

You can also set:

```bash
ADF_DAEMON_URL=http://127.0.0.1:7385 npm run adf -- agents
```

Every command sends the daemon's access token as `Authorization: Bearer
<token>`. On the daemon's machine `adf` reads it by itself from
`<settings dir>/daemon-token` (the same `ADF_DAEMON_SETTINGS` /
`ADF_USER_DATA_DIR` resolution as the daemon; created on the daemon's first
start). For a daemon elsewhere, print its token there with `adf daemon token`
and pass it with `--token <token>` or `ADF_DAEMON_TOKEN` (which also overrides
the file). The local token is never sent to a non-loopback URL. A `401` means
the token is missing or wrong (or `adf` predates tokens: update it).

## Common Commands

```bash
npm run adf -- agents
npm run adf -- status agent-id
npm run adf -- chat agent-id "hello daemon"
npm run adf -- tasks agent-id
npm run adf -- asks agent-id
npm run adf -- events agent-id
```

Agent arguments can be an agent ID, handle, or name when the daemon can resolve them uniquely.

Loading a file is currently an HTTP operation rather than a CLI command:

```bash
curl -X POST http://127.0.0.1:7385/agents/load \
  -H 'Content-Type: application/json' \
  -d '{"filePath":"/absolute/path/to/example.adf"}'
```

## Background daemon

`adf` (the terminal app) and every command that talks to the daemon first check
`<url>/health`. When nothing answers and the URL is loopback (`127.0.0.1`,
`localhost`, `::1`), `adf` starts `adf daemon` for that port in the
background, waits until it answers (`Starting the ADF daemon…`), and goes on.
The daemon is detached: it keeps running after the command or the terminal app exits
and after the terminal closes. It is never started for a remote URL, with
`--no-daemon` / `ADF_NO_AUTOSTART=1`, or while ADF Studio runs on the same
settings (Studio and the daemon would run the same agents twice; `adf` says
so and what to do).

| Command | Purpose |
|---------|---------|
| `daemon` | Run the daemon in the foreground (`--port`, `--host`, `--settings`; Ctrl+C stops it) |
| `daemon start [--force]` | Start it in the background; `--force` skips the Studio check |
| `daemon status` | Running or not, pid, uptime, version, data dir and log file (exit 3 when not running) |
| `daemon stop` | Graceful stop (`POST /daemon/shutdown`, loopback only): agents unloaded, compute containers stopped. Never a hard kill |
| `daemon restart` | Stop, then start in the background |
| `daemon logs [-f] [-n <lines>]` | The background daemon's log, `<data dir>/logs/adf-daemon.log` |
| `daemon token` | Print this install's daemon access token (`<data dir>/daemon-token`, created if missing; `ADF_DAEMON_TOKEN` when set) for a client on another machine. Only the token goes to stdout |

Each takes `--port <n>` or `--url <url>` (default: `ADF_DAEMON_URL`, then
`ADF_DAEMON_PORT`, then `http://127.0.0.1:7385`). The data dir is the folder
of the daemon's settings file (`ADF_DAEMON_SETTINGS`, else the Studio
settings location, or `ADF_USER_DATA_DIR`); the pid file is
`adf-daemon.pid` there (`adf-daemon-<port>.pid` for other ports,
`ADF_DAEMON_PIDFILE` overrides). From a source checkout the start also runs
`scripts/rebuild-for-node.mjs`, as `npm run daemon` does.

## Command Reference

| Command | Purpose |
|---------|---------|
| `agents` | List loaded agents |
| `status <agent>` | Show runtime status |
| `start <agent>` | Start an agent and fire startup when applicable |
| `stop <agent>` | Stop and unload an agent |
| `unload <agent>` | Alias for `stop` |
| `loops <agent>` | List the agent's loops: `main` plus its inner (side) loops, the parallel threads with their own history (e.g. a memory consolidator on a timer) |
| `interrupt <agent> [--loop <name>]` | End the running turn of main (or an inner loop); it goes idle and keeps accepting chats, timers and triggers |
| `abort <agent> [--loop <name>]` | Hard-abort the current turn without unloading; that loop stays stopped until the agent is reloaded (prefer `interrupt`) |
| `runtime` | Show daemon-level runtime diagnostics |
| `runtime <agent>` | Show per-agent runtime diagnostics |
| `providers` | Show provider configuration and agent provider resolution |
| `auth` | Show auth and credential presence |
| `auth login <chatgpt\|grok>` | Sign in to a subscription provider |
| `auth logout <chatgpt\|grok>` | Clear a subscription provider's tokens |
| `settings` | Show sanitized daemon runtime settings |
| `network` | Show mesh and WebSocket diagnostics |
| `network mesh [status\|enable\|disable]` | Inspect or control mesh registration |
| `network server [status\|start\|stop\|restart]` | Inspect or control the mesh HTTP server |
| `network tools` | Show recent mesh tool calls |
| `network lan` | Show LAN addresses |
| `network runtimes` | Show discovered runtimes |
| `usage` | Show daemon-wide token usage |
| `usage <agent>` | Show one agent's token usage |
| `config <agent>` | Show agent config |
| `files <agent>` | List agent files |
| `file <agent> <path>` | Print one agent file |
| `inbox <agent>` | List inbox messages |
| `outbox <agent>` | List outbox messages |
| `timers <agent>` | List timers |
| `tasks <agent>` | List tasks and pending approvals |
| `task <agent> <taskId>` | Show one task |
| `approve <agent> <taskId>` | Approve a pending task |
| `deny <agent> <taskId> [reason]` | Deny a pending task |
| `asks <agent>` | List pending ask requests |
| `answer <agent> <requestId> <answer>` | Answer a pending ask request |
| `identities <agent>` | List identity metadata without secret values |
| `mcp` | Show daemon MCP registrations |
| `mcp <agent>` | Show one agent's MCP state |
| `adapters` | Show daemon adapter registrations |
| `adapters <agent>` | Show one agent's adapter state |
| `events` | Follow all daemon SSE events |
| `events <agent>` | Follow SSE events for one agent |
| `chat <agent> [--loop <name>] <message>` | Send chat to main (or an inner loop) and print the accepted turn ID |
| `identity` | Show the owner identity status (`none`, `locked`, `restore-needed`, `ready`) |
| `identity new` | Create an owner identity and show its 12-word seed phrase once |
| `identity restore` | Restore the owner identity from its seed phrase (hidden prompt) |
| `identity unlock` / `identity lock` | Unlock/lock a passphrase-file identity (no OS keychain) |
| `templates` | List the agent templates `new` can use |
| `new [name] [--template <id>] [--provider <id>] [--model <id>] [--dir <path>] [--start]` | Create an agent from a template, sealed with the owner identity |

## Owner Identity

Agents are created and sealed under your **owner identity**, the same one ADF
Studio uses. It is derived from a 12-word seed phrase: the same phrase in
Studio and in the CLI is the same owner, so agents made in either open in both.

```bash
npm run adf -- identity            # status
npm run adf -- identity new        # first time on this machine
npm run adf -- identity restore    # you already have a phrase (from Studio or another machine)
```

- `identity new` prints the 12 words **once** — write them down, in order. Type
  `yes` to confirm you saved them (Studio's "I have written it down"). The
  daemon never shows the phrase again; anyone with it can act as you.
- `identity restore` asks for the phrase at a hidden prompt (it never goes
  through argv or shell history; piping it on stdin also works). If this
  machine already has an owner (for example from Studio), the phrase must
  belong to that owner or it is refused — switch owners in Studio instead.
- On the same machine as Studio there is usually nothing to do: Studio and the
  daemon share the phrase through the OS keychain, so `adf identity` already
  reports `ready`.
- Where no OS keychain is usable (e.g. a headless Linux server), the phrase is
  kept in a passphrase-protected file next to the daemon settings. `new` and
  `restore` ask for a passphrase; after a daemon restart run `adf identity
  unlock` (or start the daemon with `ADF_OWNER_PASSPHRASE` /
  `ADF_OWNER_PASSPHRASE_FILE`).

## Create an Agent

```bash
npm run adf -- templates
npm run adf -- new agent-1 --template standard --start
```

`new` makes the agent exactly like Studio's "new agent": an instance of the
template (default: your default template), a fresh identity sealed to your
owner key with owner/runtime attestations, marked reviewed, its directory
tracked, and loaded in the daemon (`--start` also starts it). Without a name
you get a generated one; without `--dir`, agents go to Studio's agents folder
(`agentsFolder` setting, else `~/Documents/adf-agents`).

## Auth

The daemon keeps its own subscription session, separate from ADF Studio's — so
`adf auth login` is how the daemon gets one, whether or not you have already
signed in to Studio. See
[Where subscription sessions are stored](../guides/settings.md#where-subscription-sessions-are-stored)
for the storage format and its security trade-off.

```bash
npm run adf -- auth                    # who's signed in, and which providers have keys
npm run adf -- auth login grok
npm run adf -- auth login chatgpt
npm run adf -- auth logout chatgpt
```

**Grok** uses an OAuth device code: the CLI prints a URL and a short code, opens
your browser when it can, and polls until you approve. Nothing is bound to a
particular host, so this works unchanged against a remote daemon.

**ChatGPT** uses a loopback OAuth redirect, which means the callback server has
to be on the same machine as the browser. The CLI picks the mode from `--url`:

| Daemon | Mode | What happens |
| --- | --- | --- |
| local (default) | `loopback` | the daemon serves the callback on `127.0.0.1:1455` |
| remote (`--url http://host:7385`) | `relay` | the CLI serves the callback locally and posts the code back to the daemon |

Override with `--relay` or `--loopback` when the guess is wrong — for example
`--loopback` if you're tunnelling port 1455 to the daemon over SSH:

```bash
ssh -L 1455:localhost:1455 daemon-host
npm run adf -- --url http://127.0.0.1:7385 auth login chatgpt --loopback
```

Relay mode never sends your credentials through the daemon — only the
short-lived authorization code, which is useless without the PKCE verifier the
daemon kept. The relay `redirectUri` must be a loopback address; the daemon
rejects anything else so a caller can't redirect the code to a host it controls.

## Examples

List agents:

```bash
npm run adf -- agents
```

Send chat:

```bash
npm run adf -- chat agent-id "summarize your current queue"
```

Follow events:

```bash
npm run adf -- events agent-id
```

Inspect daemon-level diagnostics:

```bash
npm run adf -- runtime
npm run adf -- providers
npm run adf -- network
```

Inspect one agent:

```bash
npm run adf -- runtime agent-id
npm run adf -- loops agent-id
npm run adf -- chat agent-id --loop consolidator "Consolidate today's notes"
npm run adf -- files agent-id
npm run adf -- file agent-id README.md
npm run adf -- inbox agent-id
npm run adf -- mcp agent-id
npm run adf -- adapters agent-id
```

Work with human-in-the-loop tasks:

```bash
npm run adf -- tasks agent-id
npm run adf -- task agent-id task-id
npm run adf -- approve agent-id task-id
npm run adf -- deny agent-id task-id "not allowed"
```

Answer pending `ask` requests:

```bash
npm run adf -- asks agent-id
npm run adf -- answer agent-id request-id "yes, continue"
```

Use JSON output for scripts:

```bash
npm run adf -- --json status agent-id
```

Use another daemon URL:

```bash
npm run adf -- --url http://127.0.0.1:7390 agents
```

## Stop vs Interrupt vs Abort

`stop` and `unload` unload the agent from the daemon runtime. Use them when you want the daemon to release the agent, adapters, MCP clients, sandbox workers, and mesh registration.

`interrupt` ends the current turn and leaves that loop `idle`. Use it when a turn is stuck or no longer needed: the agent stays available for later triggers, timers and chat. `--loop <name>` targets an inner loop instead of main.

`abort` cancels the current turn but also leaves that loop's executor `stopped`: it runs nothing more (chat, triggers, timers) until the agent is stopped and loaded again. Keep it for a loop that must not run again this session.

`stop` uses the assembled agent's normal asynchronous teardown. It refuses new dispatches, stops trigger intake, lets tracked dispatches finish during the five-second grace period, and then aborts remaining work before releasing resources. `abort` is deliberately narrower: it immediately aborts the executor's current turn without unloading the assembled agent.

Chat, startup, timer, trigger, and other host work all enter the runtime as dispatch objects through the assembled handle. The CLI and HTTP API do not call the executor directly, so they share the same lifecycle and shutdown behavior as Studio.
