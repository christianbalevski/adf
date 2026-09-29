# Daemon HTTP API

The daemon serves a local JSON-over-HTTP API, by default at:

```text
http://127.0.0.1:7385
```

Every request but `GET /health` carries `Authorization: Bearer <token>`. Live
events come as Server-Sent Events from `GET /events`. The ADF CLI and the
terminal app are clients of this API.

| Read | For |
|------|-----|
| [API guide](api-guide.md) | How to build a client: authentication and remote access, agents and loops, chat and events, approvals, identity, credentials, channels, MCP, providers, templates, skills, errors, concurrency, versioning. With curl and TypeScript examples |
| [API reference](api-reference.md) | Every endpoint with its parameters, bodies and responses, generated from [`openapi.json`](openapi.json) |
| `GET /openapi.json` | The running daemon's OpenAPI 3 contract, for generating clients or contract tests |
| [Umbilical events](../guides/umbilical-events.md) | Event types and payloads on `/events` |

## Authentication and cross-site protection

Each request passes, in order: a `Host` allow-list (`403 host_not_allowed`),
a browser check that refuses a foreign `Origin` or `Sec-Fetch-Site:
cross-site|same-site` (`403 cross_origin`; no CORS headers are sent), and the
bearer token (`401 unauthorized`). The token is minted on first start into
`<settings dir>/daemon-token`; local `adf` clients read it by themselves,
`adf daemon token` prints it, and `ADF_DAEMON_TOKEN` overrides it (required
for a non-loopback bind, with `ADF_DAEMON_ALLOWED_HOSTS` for host names).
Owner identity changes and `POST /daemon/shutdown` answer loopback callers only
(`403 loopback_only`). Details, remote access (SSH tunnel, TLS proxy) and
examples: [Base URL and authentication](api-guide.md#base-url-and-authentication).

## The API by area

| Area | Routes | Guide |
|------|--------|-------|
| Health and contract | `GET /health` (no token), `GET /openapi.json`, `POST /daemon/shutdown` | [Authentication](api-guide.md#base-url-and-authentication) |
| Events | `GET /events` (SSE), `GET /agents/:id/umbilical/events` | [The event stream](api-guide.md#the-event-stream) |
| Agents and files | `/agents`, `/agents/load`, `/agents/:id/{start,stop,unload,interrupt,abort,state,status}`, `/agents/autostart`, `/agents/review`, `/tracked-dirs` | [Agents and files](api-guide.md#agents-and-files) |
| Loops | `/agents/:id/loops[/:name]`, `loop` on chat, history, abort, interrupt, compact and timers | [Loops](api-guide.md#loops) |
| Chat and history | `POST /agents/:id/chat`, `GET\|DELETE /agents/:id/chat`, `GET /agents/:id/loop`, `POST /agents/:id/trigger` | [Chat turns](api-guide.md#chat-turns-and-reading-results) |
| Approvals, asks, suspends | `/agents/:id/tasks[...]`, `/agents/:id/asks[...]`, `/agents/:id/suspend/respond` | [HIL](api-guide.md#approvals-questions-and-suspends-hil) |
| Owner identity | `/identity`, `/identity/{create,restore,unlock,lock,confirm-backup}` | [Owner identity](api-guide.md#owner-identity) |
| Credentials | `/agents/:id/identity[...]`, `/agents/:id/{adapters,mcp}/credentials`, `/agents/:id/providers/:providerId/credential[s]` | [Credentials](api-guide.md#credentials) |
| Channels and MCP servers | `/agents/:id/adapters[...]`, `/agents/:id/mcp/servers[...]`, `/admin/{mcp,adapters,sandbox}/packages` | [Channels, MCP servers and providers](api-guide.md#channels-mcp-servers-and-providers) |
| Providers and sign-in | `/runtime/providers`, `/runtime/models`, `/agents/:id/providers`, `/auth/chatgpt/*`, `/auth/grok/*` | [Channels, MCP servers and providers](api-guide.md#channels-mcp-servers-and-providers) |
| Templates and new agents | `/templates[...]`, `POST /agents/create` | [Templates](api-guide.md#templates-and-creating-agents) |
| Agent resources | `/agents/:id/{config,tools,document,mind,files,inbox,outbox,timers,meta,logs,tables,usage}` (skills are files) | [Skills](api-guide.md#skills), [Concurrency](api-guide.md#concurrency) |
| Context and compaction | `GET /agents/:id/context`, `POST /agents/:id/compact` | [Context and compaction](api-guide.md#context-and-compaction) |
| Diagnostics | `/diagnostics`, `/runtime[/*]`, `/agents/:id/runtime[/*]`, `/agents/:id/{adapters,mcp,triggers,ws}`, `/runtime/usage`, `/runtime/token-count[/batch]` | [API reference](api-reference.md) |
| Settings | `GET\|PATCH /settings`, `GET\|PUT /settings/:key` | [Daemon settings](api-guide.md#daemon-settings) |
| Network and mesh | `/network[/*]` (mesh registration, mesh server start/stop) | [Operations](operations.md#ports) |
| Compute | `/compute/*` | [Operations](operations.md#compute) |

Errors are `{ "error": "…", "code"?: "…" }`; see [Errors](api-guide.md#errors).

## Events

### `GET /events`

A Server-Sent Events stream. Each frame's `data` is `{ cursor, event }`:
`event` is the canonical umbilical envelope (`seq`, `event_type`, `timestamp`,
`source`, `agent_id`, optional `loop`, `payload`), `cursor` (also the SSE `id`)
is the daemon-wide position to resume from with `?since=<cursor>`. Filter with
`?agentId=`. Replay comes from an in-memory buffer of 1000 frames; dedupe on
`agent_id` + `seq`. Read it with `fetch` (the token goes in a header). Framing,
resume, dedupe and gap handling:
[The event stream](api-guide.md#the-event-stream). Event types:
[Umbilical events](../guides/umbilical-events.md).

## Mesh Server

The mesh server is a separate HTTP server from the daemon API, on the mesh port
(default `7295`), and not part of the reference above. It is the agent-facing
network surface: agent websites and APIs, agent cards, health, and ALF message
delivery. It does not use the daemon token. It is on by default; the daemon
starts it once a reachable agent loads (`/network/server/*` and
`meshServerEnabled` control it).

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Mesh server health check |
| `GET` | `/ping` | Runtime identity probe |
| `GET` | `/agents` | Visibility-filtered agent directory |
| `GET` | `/agents/:handle/card` | One agent's card (reserved protocol mailbox) |
| `GET` | `/agents/:handle/health` | One agent's health (reserved protocol mailbox) |
| `POST` | `/agents/:handle/inbox` | ALF message delivery (reserved protocol mailbox) |

`POST /agents/:handle/inbox` is the only way to deliver a real inbound message
(an `adf_inbox` row): it takes a full, signed ALF wire message. The daemon's
`POST /agents/:id/trigger` does not substitute for it. Everything else under
`/agents/:handle/*` is served by the agent itself (public files, shared files,
`serving.api` lambdas, WebSocket routes); see [HTTP Serving](../guides/serving.md).
