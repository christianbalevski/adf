# Daemon CLI

The repository includes a CLI client for the daemon HTTP API. It is useful for local scripts, smoke checks, and terminal-first operation. The CLI is a client: start the daemon before running commands that access agents or runtime state.

Run it with:

```bash
npm run adf -- <command>
```

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
| `--json` | Print raw JSON responses instead of formatted tables |

You can also set:

```bash
ADF_DAEMON_URL=http://127.0.0.1:7385 npm run adf -- agents
```

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

## Command Reference

| Command | Purpose |
|---------|---------|
| `agents` | List loaded agents |
| `status <agent>` | Show runtime status |
| `start <agent>` | Start an agent and fire startup when applicable |
| `stop <agent>` | Stop and unload an agent |
| `unload <agent>` | Alias for `stop` |
| `abort <agent>` | Abort the current turn without unloading the agent |
| `runtime` | Show daemon-level runtime diagnostics |
| `runtime <agent>` | Show per-agent runtime diagnostics |
| `providers` | Show provider configuration and agent provider resolution |
| `auth` | Show auth and credential presence |
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
| `chat <agent> <message>` | Send chat and print the accepted turn ID |

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

## Stop vs Abort

`stop` and `unload` unload the agent from the daemon runtime. Use them when you want the daemon to release the agent, adapters, MCP clients, sandbox workers, and mesh registration.

`abort` cancels the current turn but keeps the agent loaded. Use it when a turn is stuck or no longer needed but the agent should remain available for later triggers or chat.

`stop` uses the assembled agent's normal asynchronous teardown. It refuses new dispatches, stops trigger intake, lets tracked dispatches finish during the five-second grace period, and then aborts remaining work before releasing resources. `abort` is deliberately narrower: it immediately aborts the executor's current turn without unloading the assembled agent.

Chat, startup, timer, trigger, and other host work all enter the runtime as dispatch objects through the assembled handle. The CLI and HTTP API do not call the executor directly, so they share the same lifecycle and shutdown behavior as Studio.
