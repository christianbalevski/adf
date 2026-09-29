# Daemon API Guide

How to build on the ADF daemon's HTTP API: a terminal app, a desktop or hosted
client, a bot bridge, or a shell script. This guide explains the concepts and
the flows. Every endpoint, parameter and response field is in the generated
[API reference](api-reference.md), built from the machine-readable
[`openapi.json`](openapi.json) (also served by the daemon at
`GET /openapi.json`).

The ADF CLI and the terminal app are clients of exactly this API
([`src/main/tui/api/client.ts`](../../src/main/tui/api/client.ts) is a complete
typed client), so anything they do, your client can do.

- [Quick start](#quick-start)
- [Base URL and authentication](#base-url-and-authentication)
- [Conventions](#conventions)
- [Agents and files](#agents-and-files)
- [Loops](#loops)
- [Chat turns and reading results](#chat-turns-and-reading-results)
- [The event stream](#the-event-stream)
- [Approvals, questions and suspends (HIL)](#approvals-questions-and-suspends-hil)
- [Owner identity](#owner-identity)
- [Credentials](#credentials)
- [Channels, MCP servers and providers](#channels-mcp-servers-and-providers)
- [Templates and creating agents](#templates-and-creating-agents)
- [Skills](#skills)
- [Context and compaction](#context-and-compaction)
- [Daemon settings](#daemon-settings)
- [Errors](#errors)
- [Concurrency](#concurrency)
- [Versioning and compatibility](#versioning-and-compatibility)

## Quick start

With the ADF CLI installed (`npm i -g @agentdocumentformat/cli`), `adf daemon
start` starts a daemon in the background (plain `adf` does it on its own) and
`adf daemon token` prints its access token:

```bash
adf daemon start
export ADF=http://127.0.0.1:7385
export TOKEN=$(adf daemon token 2>/dev/null)   # PowerShell: $env:TOKEN = adf daemon token 2>$null
H="Authorization: Bearer $TOKEN"

curl -s -H "$H" $ADF/agents                      # loaded agents
curl -s -H "$H" -X POST $ADF/agents/agent-1/chat \
  -H 'Content-Type: application/json' -d '{"text":"hello"}'   # 202 {accepted, turnId}
curl -sN -H "$H" "$ADF/events?agentId=<agent id>"             # watch the turn happen
```

The curl examples below assume `ADF` and `H` are set like this.

A minimal TypeScript client (Node 18+, Deno or Bun; global `fetch`), reused by
the TypeScript examples below:

```ts
// adf.ts
export const BASE = process.env.ADF_DAEMON_URL ?? 'http://127.0.0.1:7385'
export const TOKEN = process.env.ADF_DAEMON_TOKEN ?? '' // `adf daemon token` prints it

export class AdfError extends Error {
  constructor(readonly status: number, readonly code: string | undefined, message: string, readonly body: unknown) {
    super(message)
  }
}

export async function adf<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new AdfError(res.status, data?.code, data?.error ?? data?.message ?? res.statusText, data)
  return data as T
}
```

## Base URL and authentication

The daemon listens on `http://127.0.0.1:7385` by default (`ADF_DAEMON_HOST`,
`ADF_DAEMON_PORT`, or `adf daemon --host/--port`). It speaks plain HTTP.

### The access token

Every request except `GET /health` needs `Authorization: Bearer <token>`,
including `GET /openapi.json` and the `/events` stream. A missing or wrong
token gets `401` with `code: "unauthorized"`.

- On first start the daemon mints a random token into
  `<settings dir>/daemon-token` (mode 0600, next to `adf-settings.json`). The
  settings dir is the one the daemon uses: `ADF_DAEMON_SETTINGS`'s directory,
  else `ADF_USER_DATA_DIR`, else the platform default (`ADF Studio` or
  `adf-studio` under `~/Library/Application Support`, `%APPDATA%` or
  `$XDG_CONFIG_HOME`/`~/.config`).
- `ADF_DAEMON_TOKEN` overrides the file, on the daemon and in `adf` clients.
- The `adf` CLI, the terminal app, `adf daemon start|stop|status` and
  auto-start read the file by themselves, and send it only to loopback URLs,
  never to a remote daemon. The terminal app re-reads it once after a `401`.
- `adf daemon token` prints the token on stdout (its source on stderr), creating
  the file if needed. Use it for scripts, or to hand the token to a client on
  another machine (`adf --token <token>`, or `ADF_DAEMON_TOKEN` there).
- To rotate: stop the daemon, delete `daemon-token`, start it again.

A client on the daemon's machine can also read the file directly:

```ts
import { readFileSync } from 'node:fs'
const token = readFileSync('/path/to/settings-dir/daemon-token', 'utf8').trim()
```

### Browsers are refused

The token keeps other local processes' web pages out, and three header checks
stop a browser from being used against the daemon (CSRF, DNS rebinding):

| Check | Refused with |
|-------|--------------|
| `Host` must be `127.0.0.1`, `localhost` or `[::1]` (any port, so SSH tunnels work), or the bind address with the bound port. A non-loopback bind also accepts any IP literal on the bound port and the names in `ADF_DAEMON_ALLOWED_HOSTS` (comma/space separated; `name` = any port, `name:port`) | `403 host_not_allowed` |
| An `Origin` header that is not one of those hosts (`Origin: null` included) | `403 cross_origin` |
| `Sec-Fetch-Site: cross-site` or `same-site` | `403 cross_origin` |

The daemon sends no CORS headers. So a web page cannot call the daemon, even
with the token: a hosted or browser-based client needs a server-side backend
that talks to the daemon (and holds the token). Native apps, CLIs and servers
send neither `Origin` nor `Sec-Fetch-Site` and are unaffected.

### Loopback-only routes

These answer only callers whose TCP connection comes from the daemon's own
machine (`403 loopback_only` otherwise), on top of the token:

- `POST /identity/create`, `/identity/restore`, `/identity/unlock`,
  `/identity/lock`, `/identity/confirm-backup` (they move the seed phrase or
  passphrase, or change identity state)
- `POST /daemon/shutdown`

### Remote access

Pick one:

- **SSH tunnel** (simplest, encrypted, nothing exposed):
  `ssh -N -L 7386:127.0.0.1:7385 user@daemon-host`, then
  `adf --url http://127.0.0.1:7386 --token $(ssh user@daemon-host adf daemon
  token)` (or `ADF_DAEMON_TOKEN`). Loopback `Host` names are accepted on any
  port, so the local port is free. `adf` treats a loopback port other than
  its own daemon's (7385 / `ADF_DAEMON_PORT`) as a tunnel: no auto-start, no
  local token, so `--token` is required. Loopback-only routes work through
  the tunnel, since sshd connects from the host itself.
- **TLS reverse proxy** on the daemon host (nginx, Caddy), daemon still on
  `127.0.0.1`. The proxy must send `Host: 127.0.0.1:7385` upstream (nginx's
  default `proxy_pass http://127.0.0.1:7385` does; Caddy needs `header_up Host
  127.0.0.1:7385`) and must not buffer `/events` (the daemon sends
  `X-Accel-Buffering: no`). Every proxied request arrives from loopback, so
  loopback-only routes become reachable to anyone with the token: block
  `POST /identity/*` and `/daemon/shutdown` at the proxy unless you want that.
- **Direct bind** off loopback: `ADF_DAEMON_HOST=0.0.0.0` requires
  `ADF_DAEMON_TOKEN` (the daemon refuses to start without it); list the host
  names clients use in `ADF_DAEMON_ALLOWED_HOSTS`. Traffic, token included, is
  plain HTTP: only on a network you trust.

| Variable | Where | Meaning |
|----------|-------|---------|
| `ADF_DAEMON_HOST`, `ADF_DAEMON_PORT` | daemon | Bind address (default `127.0.0.1:7385`) |
| `ADF_DAEMON_TOKEN` | daemon, clients | Token, overriding `<settings dir>/daemon-token`; required for a non-loopback bind |
| `ADF_DAEMON_ALLOWED_HOSTS` | daemon | Extra `Host` names for a non-loopback bind |
| `ADF_DAEMON_URL` | `adf` clients | Daemon URL (default `http://127.0.0.1:7385`) |

## Conventions

- **JSON in, JSON out.** Send `Content-Type: application/json` only with a body.
  A `POST` with that header and an empty body is rejected (`400`) by the HTTP
  framework; send no header (or `{}`) for body-less `POST`s like
  `/agents/:id/interrupt`.
- **Agent ids.** `:id` accepts the agent id, handle or name of a *loaded* agent
  (`404` otherwise). Ids are safest for scripts; `GET /agents/:id` returns the
  id for a handle. Events carry the id (`agent_id`), never the handle.
- **Loops.** Loop-scoped routes take `loop` (query or body); absent means
  `main`. See [Loops](#loops).
- **Asynchronous work.** `POST /agents/:id/chat` and `/trigger` answer `202`
  once the work is queued, not when it finishes. Watch [events](#the-event-stream).
- **Secrets never come back.** Credential and API-key reads return metadata;
  provider keys in `GET /settings` read `"__redacted__"` (writing that
  placeholder back keeps the stored key).

## Agents and files

An agent is an `.adf` file. The daemon *loads* files into its runtime; a
loaded agent runs (timers, triggers, channels, chat). Stopping an agent unloads
it: the file stays where it is.

**Tracked folders** are where the daemon looks for agents
(`trackedDirectories` in settings, shared with ADF Studio). At boot, and when a
folder is added, it loads every agent in them that is marked `autostart` and
has passed review on this machine.

| Goal | Call |
|------|------|
| Loaded agents | `GET /agents` (summaries), `GET /agents/:id/status` (`runtimeState`, `degraded`, …) |
| Every agent on disk, loaded or not | `GET /tracked-dirs/agents/all`: each tracked folder with its agents and a `status`: `loaded`, `stopped` (should run, did not: `error` says why), `not_autostart`, `needs_review`, `password_protected`, `unreadable` |
| Track / untrack a folder | `POST /tracked-dirs {path}` (loads its autostart agents at once; unreviewed ones come back in `needsReview`), `DELETE /tracked-dirs?path=…&unload=true` |
| Load a file | `POST /agents/load {filePath}` (bypasses review unless `requireReview: true`) |
| Start | `POST /agents/:id/start`: loads the agent if needed (by id, handle or name found in tracked folders, or an `.adf` path), then fires its startup turn when `start_in_state` is `active`. Returns `{loaded, startupTriggered, agent}` |
| Stop | `POST /agents/:id/stop` (alias `/unload`): unloads, with a five-second grace for in-flight work |
| End a turn, keep working | `POST /agents/:id/interrupt[?loop=]`: the loop goes `idle` and keeps taking chats, timers and triggers. Use this for "Esc" |
| Hard stop a turn | `POST /agents/:id/abort[?loop=]`: that loop's executor stays `stopped` until the agent is reloaded |
| Review | `GET /agents/review?filePath=` (summary of what the agent can do), `POST /agents/review/accept {filePath}` |

Agents a folder scan skips are listed in the autostart report (`skipped` with
a `reason`, `failed` with an `error`), and `GET /tracked-dirs/agents/all` keeps
the last load error per file until the agent loads.

`runtimeState` is the main loop's executor state: `idle`, `thinking`,
`tool_use`, `awaiting_approval`, `awaiting_ask`, `suspended`, `error`,
`stopped`. The agent's display state (`active`, `idle`, `hibernate`,
`suspended`, `off`) moves with `POST /agents/:id/state {state}`; it is live
only and not saved to the file. `degraded` (e.g. `CREDENTIALS_LOCKED`) means the
agent runs without some of its sealed credentials; see
[Owner identity](#owner-identity).

```ts
const { folders } = await adf('GET', '/tracked-dirs/agents/all')
for (const f of folders) for (const a of f.agents)
  if (a.status === 'stopped' && a.agentId) await adf('POST', `/agents/${a.agentId}/start`)
```

## Loops

An agent has one or more **loops**: parallel chat sessions with their own
history, sharing the agent's file, identity and credentials. `main` is the one
you talk to by default. **Inner loops (side loops)** are declared in the
agent's config (`loops`), each with a goal and a subset of the agent's tools,
e.g. a `consolidator` that tidies memory every hour. Design:
[Inner Loops](../guides/inner-loops.md).

| Goal | Call |
|------|------|
| List | `GET /agents/:id/loops` (`main` first; `status` `idle`/`running`, `entryCount`, `effectiveTools`) |
| Create / change / delete an inner loop | `POST /agents/:id/loops {name, goal, …}`, `PATCH /agents/:id/loops/:name`, `DELETE /agents/:id/loops/:name` (archives its history) |
| Talk to a loop | `POST /agents/:id/chat {text, loop}` |
| Read a loop's history | `GET /agents/:id/chat?loop=`, `GET /agents/:id/loop?loop=` |
| Clear it | `DELETE /agents/:id/chat?loop=` (that loop only) |
| Interrupt / abort / compact it | `POST /agents/:id/interrupt\|abort\|compact?loop=` |
| Run it on a schedule | `POST /agents/:id/timers {mode, …, scope: ["agent"], loop}` |

Loop changes go through the same checks as the agent's own `loop_manage` tool:
an owner lock on `loops` (`409`), unknown or never-grantable tools (`400`), the
loop cap. Chatting to a disabled loop is refused (`409`) before anything is
queued. Events from an inner loop carry `event.loop`; events from `main` have
no `loop` field.

## Chat turns and reading results

`POST /agents/:id/chat {text, loop?}` queues the message as the owner's voice
and answers `202 {accepted: true, turnId}`. The turn runs when the loop is
free: a message sent mid-turn waits for the current turn. `turnId` is a request
id for daemon logs; events do not carry it.

To get the answer:

1. **Live:** open `/events?agentId=<id>` *before* posting, then wait for
   `turn.completed` from the same loop: its `payload.content` is the final
   assistant text. Along the way you see `tool.started`/`tool.completed`,
   `hil.requested` (the turn waits for you), `ask.requested`,
   `agent.state.changed`, and `agent.error` on failure. `turn.delta` (streamed
   text) is off unless the agent sets `umbilical.stream_deltas: true`.
2. **Afterwards:** `GET /agents/:id/chat?loop=&limit=` returns display-ready
   history (`chatHistory.uiLog`, with `total` and `earlierCount` so truncation
   is visible), and `GET /agents/:id/loop?loop=&limit=&offset=` the raw rows
   (`{seq, role, content_json, model, tokens, created_at}`, paginated, last page
   by default).

The daemon cannot tell your turn's `turn.completed` from another client's if
two clients chat to the same loop at once.

```ts
import { adf } from './adf'
import { openEvents } from './adf-events' // see "The event stream"

export async function chat(agent: string, text: string, loop = 'main'): Promise<string> {
  const { id } = await adf<{ id: string }>('GET', `/agents/${encodeURIComponent(agent)}`)
  const ac = new AbortController()
  // Headers arrive only after the daemon subscribed this stream, so nothing is missed.
  const events = await openEvents({ agentId: id, since: Number.MAX_SAFE_INTEGER, signal: ac.signal })
  try {
    await adf('POST', `/agents/${id}/chat`, loop === 'main' ? { text } : { text, loop })
    for await (const { event } of events) {
      if ((event.loop ?? 'main') !== loop) continue
      if (event.event_type === 'turn.completed') return String(event.payload.content ?? '')
      if (event.event_type === 'agent.error') throw new Error(JSON.stringify(event.payload))
      if (event.event_type === 'hil.requested') console.error(`approval needed: ${event.payload.tool} (task ${event.payload.task_id})`)
    }
    throw new Error('event stream ended')
  } finally {
    ac.abort()
  }
}
```

`POST /agents/:id/trigger` injects any other ADF event (`inbox`, `timer`,
`startup`, …) straight into the executor. It skips trigger evaluation entirely
and may not claim the owner's voice (`data.message.source: "user"` is `400`):
use `/chat` to speak as the owner. See
[the reference](api-reference.md) before using it.

## The event stream

`GET /events` is a Server-Sent Events stream of everything the runtime reports:
daemon and agent lifecycle, turns, tool calls, state changes, approvals,
errors. It is the same envelope in-process taps receive; the catalog of types
and payloads is [Umbilical events](../guides/umbilical-events.md).

`EventSource` cannot send the `Authorization` header, so read it with `fetch`.
Frames look like this:

```text
: connected

id: 43
event: agent.state.changed
data: {"cursor":43,"event":{"seq":118,"event_type":"agent.state.changed","timestamp":1760000000000,"source":"system:runtime","agent_id":"abc123","payload":{"filePath":"/agents/agent-1.adf","state":"idle"}}}

: heartbeat 1760000030000
```

| Field | Meaning |
|-------|---------|
| `cursor` (also the SSE `id`) | Transport position. Daemon-wide, per process, starts at 1 on every daemon start. Only for `?since=` |
| `event.agent_id` | Owning agent id, `null` for daemon events (`daemon.started`, …) |
| `event.seq` | Per-agent sequence, +1 per event of that agent, persisted in the file across restarts. `0` without an owning agent |
| `event.loop` | Inner loop that produced it; absent for `main` |
| `event.source` | `agent:<turn>`, `lambda:<file>:<fn>`, `system:<subsystem>` |

Query parameters: `agentId` (one agent's events, replay included) and `since`
(replay buffered frames with `cursor > since`, then go live). Without `since`
the whole buffer is replayed first; `since=9007199254740991` starts live. The
daemon ignores `Last-Event-ID`: pass `since`.

**Replay is short.** The buffer holds the last 1000 frames of all agents, in
memory. A client that was away longer, or a daemon restart, loses the frames in
between. Durable state is in the agent (`/chat`, `/loop`, `/tasks`, `/logs`):
re-read it when you detect a gap.

A reconnecting client should:

- resume with `?since=<last cursor>`, with backoff;
- **dedupe** on `agent_id` + `seq` (replay can repeat frames); daemon events
  (`seq` 0) on `cursor`;
- detect a **gap** when an agent's `seq` jumps by more than one, and a **daemon
  restart** when a cursor goes backwards (or on `daemon.started`), then
  re-snapshot the state it shows;
- treat ~75 s without bytes as a dead connection (heartbeats come every 30 s).

```ts
// adf-events.ts
import { BASE, TOKEN } from './adf'

export interface UmbilicalEvent {
  seq: number; event_type: string; timestamp: number; source: string
  agent_id: string | null; loop?: string; payload: Record<string, any>
}
export interface Frame { cursor: number; event: UmbilicalEvent }

export async function openEvents(opts: { agentId?: string; since?: number; signal?: AbortSignal } = {}) {
  const qs = new URLSearchParams()
  if (opts.agentId) qs.set('agentId', opts.agentId)
  if (opts.since !== undefined) qs.set('since', String(opts.since))
  const res = await fetch(`${BASE}/events?${qs}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'text/event-stream' },
    signal: opts.signal,
  })
  if (!res.ok || !res.body) throw new Error(`events: HTTP ${res.status}`)
  return frames(res.body)
}

async function* frames(body: ReadableStream<Uint8Array>): AsyncGenerator<Frame> {
  const decoder = new TextDecoder()
  let buf = ''
  for await (const chunk of body as any as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true }).replace(/\r\n?/g, '\n')
    for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
      const block = buf.slice(0, i)
      buf = buf.slice(i + 2)
      const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n')
      if (data) yield JSON.parse(data) as Frame
    }
  }
}

// A resilient subscriber: resume, dedupe, gap and restart detection.
export async function follow(onEvent: (e: UmbilicalEvent) => void, resync: (agentId?: string) => void) {
  let cursor = Number.MAX_SAFE_INTEGER // start live; 0 replays the buffer
  const lastSeq = new Map<string, number>()
  for (let attempt = 0; ; attempt++) {
    try {
      for await (const f of await openEvents({ since: cursor })) {
        attempt = 0
        if (cursor !== Number.MAX_SAFE_INTEGER && f.cursor < cursor) resync() // daemon restarted
        cursor = f.cursor
        const e = f.event
        if (e.agent_id && e.seq > 0) {
          const last = lastSeq.get(e.agent_id)
          if (last !== undefined && e.seq <= last) continue // duplicate
          if (last !== undefined && e.seq > last + 1) resync(e.agent_id) // missed events
          lastSeq.set(e.agent_id, e.seq)
        }
        onEvent(e)
      }
    } catch { /* dropped: reconnect */ }
    await new Promise(r => setTimeout(r, Math.min(10_000, 500 * 2 ** attempt)))
  }
}
```

(Add an idle timer that aborts the fetch in production; the terminal app's
[`sse.ts`](../../src/main/tui/api/sse.ts) is a complete implementation.)

For one agent there is also a pull alternative, `GET
/agents/:id/umbilical/events?since_seq=`, over an opt-in in-memory window
(`umbilical.log.enabled` in the agent config); see the
[reference](api-reference.md).

## Approvals, questions and suspends (HIL)

A turn stops and waits for the owner in three cases. All of them surface as
events and as pollable state, across `main` and every running inner loop.

**Tool approvals.** A call to a `restricted` tool, or a protection denial the
owner may override (a locked file, meta key or config field), creates a task
in `pending_approval` and emits `hil.requested` (`task_id`, `tool`, `reason`,
`input`, `can_always_approve`). The loop's state is `awaiting_approval`.

| Goal | Call |
|------|------|
| Pending approvals | `GET /agents/:id/tasks?status=pending_approval` (each row has `canAlwaysApprove`, or `alwaysApproveBlockedReason`) |
| Approve | `POST /agents/:id/tasks/:taskId/resolve {action: "approve", modifiedArgs?}` |
| Deny, with feedback | `{action: "deny", reason: "use the staging bucket"}`: the agent gets the reason as the owner's feedback in the tool result |
| Always approve this tool | `POST /agents/:id/tasks/:taskId/always-approve` (no body): the tool's declaration becomes `enabled, restricted: false` in the agent's config, then the request is approved |
| Approve everything waiting | `POST /agents/:id/tasks/approve-all {loop?}` → `{approved, skippedProtection}` |

Protections get one-time approvals only: always-approve is refused (`409`,
`error` = the blocked reason) for protection overrides, one-shot requests (e.g.
MCP OAuth sign-in) and locked tool declarations, and approve-all never includes
protection overrides (it counts them in `skippedProtection`). Resolving a task
that is no longer pending is `409`; tasks left pending by a crash are cancelled
at the next load.

**Questions.** The agent's `ask` tool emits `ask.requested {request_id,
question}` and the loop waits in `awaiting_ask`. List with `GET
/agents/:id/asks` (each with its `loop`); answer with `POST
/agents/:id/asks/:requestId/respond {answer, loop}`. Request ids are numbered
per loop, so pass `loop` when two loops ask at once.

**Suspends.** An agent that hits `limits.max_active_turns` emits
`suspend.requested`; answer with `POST /agents/:id/suspend/respond {resume:
true|false}` (`false` shuts it down). Unanswered, it times out as `false`.

```bash
curl -s -H "$H" "$ADF/agents/agent-1/tasks?status=pending_approval"
curl -s -H "$H" -X POST $ADF/agents/agent-1/tasks/<taskId>/resolve \
  -H 'Content-Type: application/json' -d '{"action":"deny","reason":"not on prod"}'
```

## Owner identity

New agents are sealed under the **owner identity**: a DID derived from a
12-word seed phrase, the same identity ADF Studio uses (same phrase, same
owner). The daemon keeps the phrase in the OS keychain (shared with Studio on
the same machine) or, without a usable keychain, in a passphrase-encrypted
file next to its settings.

`GET /identity` reports `status`:

| `status` | Meaning | Next |
|----------|---------|------|
| `none` | No owner on this machine | `POST /identity/create` or `/identity/restore` |
| `locked` | The passphrase file is not unlocked | `POST /identity/unlock {passphrase}` |
| `restore-needed` | The machine knows an owner DID (e.g. from Studio) but the daemon lacks its phrase | `POST /identity/restore {mnemonic}` with that owner's phrase |
| `ready` | Agents can be created and credentials sealed | |

`passphraseRequired: true` means file storage: create, restore and unlock need
a `passphrase`. The daemon can also unlock at boot from
`ADF_OWNER_PASSPHRASE` or `ADF_OWNER_PASSPHRASE_FILE`.

- `POST /identity/create` returns the phrase (`mnemonic`, `words`) once, with
  `Cache-Control: no-store`, and never again. Show it, have the user write it
  down, then `POST /identity/confirm-backup`.
- `POST /identity/lock` (file storage) forgets the decrypted secrets.
- All five `POST /identity/*` routes are [loopback-only](#loopback-only-routes).
  A remote client can read `GET /identity` and tell the user to run `adf
  identity` on the daemon host.
- Errors carry a `code`: `identity_exists`, `invalid_mnemonic`,
  `passphrase_required`, `wrong_passphrase`, `weak_passphrase`,
  `owner_mismatch` (the phrase is another owner's), `not_file_storage`,
  `nothing_to_unlock`.

Agents loaded while the identity was not ready run `degraded`
(`CREDENTIALS_LOCKED`) without their sealed credentials. When the identity
becomes ready (create, restore, unlock, or a phrase Studio put in the shared
keychain; re-checked every minute while any agent is degraded), the daemon
unlocks them in place, no reload: `degraded` clears, their channels restart,
and each emits `agent.credentials.unlocked`.

## Credentials

Channel tokens, MCP server keys and per-agent provider keys live in the agent's
own file, **sealed** (envelope-encrypted) under the owner identity. They go
in; they never come out. Every read returns metadata only:

```json
{ "purpose": "adapter:telegram:TELEGRAM_BOT_TOKEN", "present": true, "storage": "sealed",
  "sealed": true, "locked": false, "length": 46, "code_access": false }
```

| Credential | Write | Read (metadata) |
|------------|-------|-----------------|
| Channel | `PUT /agents/:id/adapters/credentials {adapterType, envKey, value}` | `GET /agents/:id/adapters/credentials?adapterType=` |
| MCP server | `PUT /agents/:id/mcp/credentials {npmPackage, envKey, value}` | `GET /agents/:id/mcp/credentials?npmPackage=` |
| Agent's own provider key | `PUT /agents/:id/providers/:providerId/credential {value}` | `GET /agents/:id/providers/:providerId/credentials` |
| Any purpose | `PUT /agents/:id/identity/:purpose {value}` | `GET /agents/:id/identity/:purpose`, `GET /agents/:id/identity/entries` |

**Writes while locked.** While the agent's credentials envelope is locked on
this daemon (the owner identity is not ready here), a write answers `409` with
`code: "credentials_locked"`: storing it would either destroy a sealed value
the daemon cannot read or keep a new one unsealed. The client should offer:

- **Unlock** (the owner identity flow above), then save again; or
- **Replace**: resend with `"replace": true`. A locked sealed value is
  discarded unread, the new value is stored unsealed and sealed automatically
  once the envelope unlocks, the response carries `"replaced": true` when an
  old value was discarded, and the agent's `adf_logs` records
  `credential_replaced`. Key material (`crypto:*`) cannot be replaced (`400`).

Agent code has no such override. Detaching a channel, MCP server or provider
(below) also deletes its credentials.

## Channels, MCP servers and providers

**Channels** (channel adapters in the API: `telegram`, `email`, or an installed
package) are per agent. Store the credentials, then attach:

```bash
curl -s -H "$H" -X PUT $ADF/agents/agent-1/adapters/credentials -H 'Content-Type: application/json' \
  -d '{"adapterType":"telegram","envKey":"TELEGRAM_BOT_TOKEN","value":"123456789:AA…"}'
curl -s -H "$H" -X POST $ADF/agents/agent-1/adapters -H 'Content-Type: application/json' \
  -d '{"adapterType":"telegram","config":{"enabled":true}}'
curl -s -H "$H" $ADF/agents/agent-1/adapters     # live state
```

Attaching or changing a channel starts or reconfigures it at once;
`DELETE /agents/:id/adapters/:type` removes it and its credentials. Inbound
messages wake the agent through its `on_inbox` trigger.

**MCP servers** are per agent too: `POST /agents/:id/mcp/servers {server:
{name, transport: "stdio"|"http", …}}` adds the declaration, but the server
connects only at the next agent start, or now with
`POST /agents/:id/mcp/servers/:name/restart` (also the retry for a failed
server; the reply has `toolsDiscovered` or the `error`). Managed packages
install with `POST /admin/mcp/packages/npm|python`. Live state: `GET
/agents/:id/mcp`.

**Providers.** Daemon-wide API-key providers: `POST /runtime/providers {type,
name?, apiKey, defaultModel?, baseUrl?, preset?}` with `type` `anthropic`,
`openai`, `openrouter` or `openai-compatible` (`baseUrl` required, key
optional). The key goes to the daemon's secret store (OS keychain, or the
owner's passphrase file), never to the settings file, and is never returned;
`409 secret_store_locked` until the owner identity is set up or unlocked. A new
provider becomes the default (`defaultProviderId`) when there is none. `GET /runtime/providers` lists them
(`hasApiKey`, no key) and which provider each loaded agent resolves;
`DELETE /runtime/providers/:id` removes one and its key. `GET
/runtime/models?provider=&agentId=` lists a provider's models. An agent picks
its provider and model in its config (`model.provider`, `model.model_id`); an
agent can also carry its own provider entry and key (`POST
/agents/:id/providers`, `PUT …/credential`).

**Subscription sign-in** (ChatGPT, Grok) replaces an API key; `POST
/runtime/providers` refuses those types (`400 subscription_type`). The daemon
keeps its own session, separate from Studio's.

| Provider | Flow |
|----------|------|
| ChatGPT, browser on the daemon's machine | `POST /auth/chatgpt/start` (`mode: "loopback"`, the default): open `authUrl`; the daemon serves the OAuth callback; poll `GET /auth/chatgpt/status` |
| ChatGPT, remote daemon | `POST /auth/chatgpt/start {mode: "relay", redirectUri: "http://localhost:1455/auth/callback"}`: your client serves that loopback callback, then posts the `code` and `state` it receives to `POST /auth/chatgpt/complete {flowId, code, state}` within 10 minutes |
| Grok | `POST /auth/grok/start`: show `verificationUriComplete` (or `verificationUri` + `userCode`), open it in any browser, poll `GET /auth/grok/status`. Device code, so it works remotely as is |

When a sign-in completes, loops that failed on an auth error from that provider
type return to `idle` (`agent.recovered`); the failed turn is not re-run.
`POST /auth/<provider>/logout` signs out. `GET /runtime/auth` summarizes both
sessions and which providers have keys.

## Templates and creating agents

`POST /agents/create` is Studio's "new agent": a copy of a template gets a
fresh identity sealed under the owner, is marked reviewed, its folder is
tracked, and it is loaded (and started with `start: true`).

```bash
curl -s -H "$H" $ADF/templates      # {templates, defaultId, folder, defaultDirectory}
curl -s -H "$H" -X POST $ADF/agents/create -H 'Content-Type: application/json' \
  -d '{"name":"agent-2","template":"standard","start":true}'
```

All fields are optional (`name`, `directory` absolute and existing, `template`,
`provider` a configured provider id, `model`, `start`). Both routes answer
`409 identity_not_ready` (with the `identity` status) until the owner identity
is ready; offer create, restore or unlock then. Other codes: `name_taken`
(`409`), `template_missing` / `template_unreviewed` (`422`), `load_failed`
(`422`: the file exists, reviewed and tracked, but did not load, e.g. no
provider; fix it and `POST /agents/load`).

Templates are ordinary `.adf` files in the daemon's templates folder, managed
with `POST /templates`, `GET|PATCH|DELETE /templates/:id` and the
`/templates/:id/{default,reset,review,review/accept,config,files}` routes
(Studio's Settings > Agent templates). Someone else's template must be accepted
(`POST /templates/:id/review/accept`) before agents can be made from it.

## Skills

Skills are files in the agent, so there is no skills endpoint: the file routes
do it ([Skills guide](../guides/skills.md)).

| Goal | How |
|------|-----|
| Installed skills | `GET /agents/:id/files`, then read `skills-registry.json` (derived by the runtime, read-only; never write it) |
| Install | `PUT /agents/:id/files/content?path=skills/<name>/<file>` for each file, `skills/<name>/SKILL.md` **last** |
| Remove | `DELETE …?path=skills/<name>/SKILL.md` **first**, then the rest |
| Mute / unmute | Edit the `disabled` list in `skills-state.json` (`{"schema": 1, "disabled": ["name"]}`) |

The runtime re-indexes on every write under `skills/` and to
`skills-state.json`, and rewrites the registry. A folder name outside
`[a-z0-9-]` (up to 64 characters), frontmatter `name` that differs from the
folder, a `SKILL.md` over 256 KB, or a 49th skill is rejected, and listed under
`rejected` in the registry. The skills catalog (browse and
install from a URL) is client-side: the terminal app fetches the sources listed
in the `skillCatalogSources` setting.

## Context and compaction

`GET /agents/:id/context?loop=&items=` is Studio's context breakdown for one
loop: what the next request would carry, by category (`system`, `files`,
`tools`, one `mcp:<server>` per MCP server, `dynamic`, `messages`), with
`totalTokens`, `percent` and the `compactThreshold` that loop compacts at
(and where it comes from). `available: false` means the loop has no live
executor (disabled or asleep).

`POST /agents/:id/compact?loop=` compacts one loop's history now (summarize and
replace). `409` while that loop is mid-turn or already compacting, or when
there is nothing to compact; `502` when the summarizing model call fails
(history kept). Emits `loop.compacted` or `loop.compaction_failed`.

## Daemon settings

`GET /settings` returns the settings file (secrets removed, provider keys as
`"__redacted__"`); `PATCH /settings {…}` sets several top-level keys, `GET|PUT
/settings/:key {value}` one. Each key's value is replaced (partial `compute`
objects merge). Identity and key material (`ownerDid`, `runtimeDid`,
`trustedDaemonEncKeys`, …) are refused with `403`; tracked folders have their
own routes (`/tracked-dirs`). Some settings take effect only after a daemon
restart. Keys and file format: [Runtime Settings](runtime-settings.md).

## Errors

Errors are JSON with a human-readable `error`, plus a machine `code` wherever a
client is expected to branch on it:

```json
{ "error": "The credentials envelope of this agent is locked on this daemon — …", "code": "credentials_locked" }
```

Show `error` to the user; branch on `status` and `code`. Some bodies carry more
(`identity` on `identity_not_ready`, `agentId`/`filePath` on a review refusal,
`coveredBy` on a tracked-folder conflict). Framework-level errors (unknown
route, malformed JSON, empty JSON body) come from Fastify as `{statusCode,
error, message}`.

| Status | Means | Common `code`s |
|--------|-------|----------------|
| `400` | Bad request body or query | `bad_request`, `invalid_mnemonic`, `passphrase_required`, `subscription_type`, `bad_type`, `api_key_required`, `password_required` |
| `401` | Missing or wrong token | `unauthorized` |
| `403` | Refused by a guard or policy | `host_not_allowed`, `cross_origin`, `loopback_only`, `wrong_passphrase`, `wrong_password`, `AGENT_REVIEW_REQUIRED`; settings write denials have no code |
| `404` | Unknown agent (or not loaded), loop, task, file, template | `template_missing`, `not_found` |
| `405` | Read-only settings store | `read_only` |
| `409` | Valid, but not in the current state | `credentials_locked`, `identity_not_ready`, `identity_exists`, `owner_mismatch`, `name_taken`, `secret_store_locked`, `nothing_to_unlock`; plus code-less conflicts: task not pending, loop mid-turn or disabled, loops locked by the owner, agent not running |
| `422` | Accepted input, but the result could not be produced | `template_unreviewed`, `load_failed` |
| `502` | An upstream model call failed | (compaction) |
| `503` | That service is not configured on this daemon | |
| `500` | Unexpected runtime error | |

## Concurrency

There are no ETags or `If-Match`: the last write wins. The daemon is shared by
the terminal app, Studio-style clients, scripts and the agents themselves (an
agent can change its own config with `sys_update_config` and its loops with
`loop_manage`). So:

- Prefer the targeted routes (loops, timers, channels, MCP servers, providers,
  credentials, state, files, meta). Each changes one thing, server-side, in one
  step.
- `PUT /agents/:id/config` replaces the whole config. Re-read it right before,
  change only the fields you mean to, and write it back at once. Owner writes
  are not checked against the agent's own locks (`locked`, `locked_fields`);
  apply those rules in your UI if you show them.
- After a `202` or a write, re-read what you display (or follow events) rather
  than assuming your local copy is current.
- `PATCH /settings` and `PUT /settings/:key` replace each named key's whole
  value. Change lists that have their own routes (tracked folders, providers)
  through those routes.

## Versioning and compatibility

The API is not versioned by URL. `GET /runtime` returns `daemon.version` (the
package version, or `null` when unknown), `node` and `platform`; `adf daemon
status` shows it. `GET /openapi.json` is the contract of the running daemon.

Build clients to tolerate drift:

- ignore fields you do not know; new fields are added freely;
- treat a `404` on a route you need as "this daemon is older" and fall back or
  tell the user to update (the terminal app does this, e.g. per-folder reads
  when `GET /tracked-dirs/agents/all` is missing);
- stable event types keep their payload fields; see the stability labels in
  [Umbilical events](../guides/umbilical-events.md#stability).

An older `adf` against a token-requiring daemon gets a `401` telling the user
to update or run `adf daemon token`; a newer `adf` against an older daemon
still works (the old daemon ignores the `Authorization` header).

## See also

- [API reference](api-reference.md): every endpoint, generated from [`openapi.json`](openapi.json)
- [HTTP API overview](http-api.md)
- [Umbilical events](../guides/umbilical-events.md): event types and payloads
- [ADF CLI](cli.md) and [Terminal app](tui.md): the reference clients
- [Operations](operations.md): running the daemon, ports, logs, troubleshooting
