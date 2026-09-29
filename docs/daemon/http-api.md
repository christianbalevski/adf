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

### `GET /openapi.json`

Returns the machine-readable OpenAPI 3 specification for this API — the same
document rendered by this page. Useful for generating clients or driving
contract tests.

## Events

### `GET /events`

Opens a Server-Sent Events stream for live daemon and agent events.

```bash
curl -N http://127.0.0.1:7385/events
```

Optional query parameters:

| Parameter | Description |
|-----------|-------------|
| `agentId` | Only stream events for one agent (matches `event.agent_id`) |
| `since` | Replay buffered frames with a `cursor` greater than this value |

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

Events use the SSE `id`, `event`, and `data` fields. `id` is the resume cursor (what `?since=` matches) and `event` is the `event_type`:

```text
id: 43
event: agent.state.changed
data: {"cursor":43,"event":{"seq":118,"event_type":"agent.state.changed","timestamp":1710000000000,"source":"system:runtime","agent_id":"agent-id","payload":{"filePath":"/path/to/agents/example-agent.adf","state":"idle"}}}
```

Each SSE frame carries a transport wrapper around the canonical umbilical envelope:

```json
{
  "cursor": 43,
  "event": {
    "seq": 118,
    "event_type": "agent.state.changed",
    "timestamp": 1710000000000,
    "source": "system:runtime",
    "agent_id": "agent-id",
    "payload": {}
  }
}
```

| Field | Meaning |
|-------|---------|
| `cursor` | Transport resume token. Per-daemon-process, monotonic, resets on daemon restart. Only meaningful for `?since=`. |
| `event` | The canonical umbilical envelope — byte-identical to what in-process agent taps receive. |
| `event.seq` | Monotonic **per-agent** sequence number, persisted across restarts. `0` when the event has no owning agent. |
| `event.source` | Provenance: `agent:<turn>`, `lambda:<file>:<fn>`, `system:<subsystem>`. A first-class field, not folded into `payload`. |
| `event.agent_id` | Owning agent id, or `null` for daemon-scope events. |
| `event.loop` | Inner cognition loop that produced the event (see [Cognition loops](#cognition-loops)). Absent for `main` and for events that are not loop-scoped. |
| `event.sig` | Reserved for a detached envelope signature. Not currently populated. |

Do not use `cursor` for ordering or deduplication across daemon restarts — use `event.agent_id` + `event.seq`.

[docs/guides/umbilical-events.md](../guides/umbilical-events.md) is the canonical catalog of event types and payload shapes, including stability guarantees, the open `custom.*` namespace, and reserved types not yet emitted. The machine-readable list is `UMBILICAL_EVENT_TYPES` in `src/shared/types/umbilical-events.ts`.

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
Key material and identity keys (`ownerMnemonic`, `ownerDid`, `runtimeDid`,
runtime/daemon keys and delegations, `trustedDaemonEncKeys`, ...) are refused
with `403`; the owner identity changes only through `/identity`.

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

Diagnostics endpoints are read-only and sanitize secrets. They are intended for the ADF CLI and terminal app, operational checks, and debugging headless runtime wiring.

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

### `POST /daemon/shutdown`

Stops the daemon gracefully, the same bounded shutdown as Ctrl+C / SIGTERM:
agents are unloaded, compute containers stopped, then the process exits.
Loopback callers only (`403 loopback_only` otherwise); answers `202
{ "accepted": true, "pid": … }` before shutting down. `adf daemon stop` uses
it; on Windows it is the only graceful way to stop a detached daemon.

### `GET /runtime`

Returns daemon-level runtime diagnostics: settings summary, provider resolution, auth state, MCP registrations, adapter registrations, network diagnostics, compute status, and loaded agent status. `daemon` carries `uptime`, `pid`, `version` (`ADF_VERSION`, else the npm package version; `null` when unknown), `node` and `platform`.

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

### `POST /agents/:id/mcp/servers/:serverName/restart`

Connects one configured MCP server of a running agent now, the same way the
agent's own `mcp_restart` tool does (host or container routing, the agent's
sealed credentials, tool discovery). Use it after `POST
/agents/:id/mcp/servers` (the daemon connects attached servers at the next
start otherwise) or to retry a failed server. Replies `{ agentId,
serverName, success, toolsDiscovered, location, error?, hostDenied?,
stderrTail? }`; `404` when the agent has no such server, `409` when the agent
is not running here.

### `POST /runtime/providers`

Adds an API-key model provider for every agent on this daemon. The key goes
to the daemon's secret store (the OS keychain, or the owner's
passphrase-protected secret file where there is no keychain), never into the
settings file, and is never returned. The settings entry carries
`"apiKeyStorage": "secret-store"` and an empty `apiKey`; the daemon fills the
key in when it resolves the provider, so agents, `/runtime/models` and
diagnostics see an ordinary provider.

```json
{ "type": "openrouter", "name": "OpenRouter", "preset": "openrouter", "apiKey": "sk-or-…", "defaultModel": "anthropic/claude-sonnet-4" }
```

`type` is `anthropic`, `openai`, `openrouter` or `openai-compatible`
(`baseUrl` required; `apiKey` optional, for local servers). Subscriptions
(ChatGPT, Grok) sign in instead: `400 subscription_type`. The name is made
unique (`OpenRouter 2`). The first provider becomes the default. Replies `201
{ provider, defaultProviderId }` (`provider.hasApiKey`, no key), or `409
secret_store_locked` while the secret store is locked or not set up yet (set
up or unlock the owner identity first).

### `DELETE /runtime/providers/:id`

Removes the provider and deletes its stored key. The default moves to the
next provider. `404` for an unknown id.

### `GET /runtime/auth`

Returns ChatGPT and Grok subscription auth status and provider credential presence without exposing credential values.

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

Starts the mesh HTTP server and persists `meshServerEnabled: true`.

The mesh server (agent web/API routes at `/agents/:handle/*` and mesh
delivery) is on by default: the daemon starts it once the first reachable agent
registers, and rebinds to all interfaces when a `lan`/`public` agent appears.

### `POST /network/server/stop`

Stops the mesh HTTP server and persists `meshServerEnabled: false`, so it stays
off across daemon restarts until started again.

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

## Owner Identity

The owner identity (a DID derived from a 12-word BIP-39 seed phrase) is what
new agents are sealed and attested under — the same identity ADF Studio uses.
The same phrase in Studio and in the daemon is the same owner.

Storage: the OS keychain (service `ADF`, account `owner-mnemonic`, shared with
Studio on the same machine), or — when no keychain is usable — a
passphrase-encrypted file `owner-secrets.json` next to the daemon settings.
The daemon has its own runtime key (`daemonRuntimeDid` in settings); it never
writes Studio's `runtimeDid`/runtime keys.

The owner DID is recorded as seed-derived (`ownerDidSeedDerived: true`). When
ADF Studio on the same machine cannot read the phrase (passphrase-file
storage), it never mints a replacement owner or restamps agents: it shows
"Restore your identity" and takes the same 12 words (Settings → Identity).

Routes that move secrets (`create`, `restore`, `unlock`) answer loopback
callers only (`403`, `code: "loopback_only"` otherwise), on top of
`ADF_DAEMON_TOKEN`. The seed phrase appears in the `POST /identity/create`
response and nowhere else. Errors are `{ "error": "...", "code": "..." }`.

### `GET /identity`

```json
{
  "status": "ready",
  "ownerDid": "did:key:z6Mk...",
  "runtimeDid": "did:key:z6Mk...",
  "storage": "keychain",
  "backupConfirmed": true,
  "passphraseRequired": false,
  "message": "Owner identity ready."
}
```

| `status` | Meaning | Next step |
|----------|---------|-----------|
| `none` | No owner on this machine | `POST /identity/create` or `/identity/restore` |
| `locked` | Passphrase file not unlocked | `POST /identity/unlock` |
| `restore-needed` | This machine has an owner DID (e.g. from Studio) but the daemon lacks its phrase | `POST /identity/restore` with that owner's phrase |
| `ready` | Agents can be created and sealed | — |

`passphraseRequired: true` means file storage: `create`/`restore`/`unlock`
need a `passphrase` (8+ characters when creating the file).

Agents loaded while the identity was not ready carry `degraded`
(`CREDENTIALS_LOCKED`) in `GET /agents/:id/status`. Whenever the identity
becomes ready (create, restore, unlock, boot, or a phrase Studio put in the
shared keychain) the daemon re-runs the envelope unlock for every loaded
agent — no reload — and, while any agent stays degraded, re-checks once a
minute. Each agent that unlocks gets `degraded` cleared, its locked adapters
restarted, an `adf_logs` row (`credentials_unlocked`), and an
`agent.credentials.unlocked` event (see [umbilical events](../guides/umbilical-events.md)).

### `POST /identity/create`

Body (optional): `{ "passphrase": "..." }` (file storage only). Only when
`status` is `none`; otherwise `409 identity_exists`.

`201`, `Cache-Control: no-store`:

```json
{
  "mnemonic": "word1 word2 ... word12",
  "words": ["word1", "word2", "...", "word12"],
  "identity": { "status": "ready", "backupConfirmed": false, "...": "..." }
}
```

Show the words to the user once and ask them to write them down; then call
`POST /identity/confirm-backup` (Studio's "I have written it down").

### `POST /identity/restore`

```json
{ "mnemonic": "word1 word2 ... word12", "passphrase": "optional, file storage" }
```

`200 { "identity": { ... } }`. `400 invalid_mnemonic`, `400
passphrase_required`, `403 wrong_passphrase`, `409 owner_mismatch` when the
phrase belongs to a different owner than the one this machine already has
(switch owners in Studio instead).

### `POST /identity/unlock`

`{ "passphrase": "..." }` → `200 { "identity": { ... } }`. `403
wrong_passphrase`; `400 not_file_storage` with keychain storage; `409
nothing_to_unlock` when no file exists yet. The daemon can also unlock at boot
from `ADF_OWNER_PASSPHRASE` or `ADF_OWNER_PASSPHRASE_FILE`.

### `POST /identity/lock`

File storage only: forget the decrypted secrets. `200 { "identity": { ... } }`.

### `POST /identity/confirm-backup`

Marks the phrase as written down (`backupConfirmed: true`, shared with Studio).

## Creating Agents

### `GET /templates`

Templates new agents can be made from (`409 identity_not_ready` until the
identity is ready).

```json
{
  "templates": [
    { "id": "standard", "name": "Standard", "templateDescription": "...", "reviewed": true, "shipped": "standard", "modelProvider": "anthropic", "modelId": "..." }
  ],
  "defaultId": "standard",
  "folder": "/path/to/userData/templates",
  "defaultDirectory": "/home/me/Documents/adf-agents"
}
```

### `POST /agents/create`

Studio's "new agent", headless: template instance → sealed identity with
owner/runtime stamps and attestations → marked reviewed → directory tracked →
loaded (and started with `start: true`).

```json
{ "name": "agent-1", "directory": "/abs/dir", "template": "standard", "provider": "anthropic", "model": "claude-...", "start": false }
```

All fields optional. `name`: a file name (≤64 chars; generated when omitted).
`directory`: absolute, existing (default `agentsFolder`, else
`~/Documents/adf-agents`). `provider` must be a configured provider id.

`201`:

```json
{ "agentId": "abc123", "name": "agent-1", "filePath": "/abs/dir/agent-1.adf", "did": "did:key:z6Mk...", "started": false }
```

| Status | `code` | When |
|--------|--------|------|
| `400` | `bad_request` | Invalid name/directory/provider/body |
| `409` | `identity_not_ready` | Owner identity not ready; body includes `identity` (status) so a client can offer create/restore/unlock |
| `409` | `name_taken` | The file already exists |
| `422` | `template_missing` / `template_unreviewed` | Template gone, or someone else's and not reviewed |

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
| `loop` | `main` | Cognition loop whose stream to read; unknown loops answer `404` |

Example:

```bash
curl "http://127.0.0.1:7385/agents/agent-id/loop?limit=20&offset=0"
```

Response:

```json
{
  "agentId": "agent-id",
  "loop": "main",
  "total": 42,
  "limit": 20,
  "offset": 0,
  "entries": []
}
```

### `GET /agents/:id/usage`

Returns per-agent token usage totals derived from persisted loop rows
(`adf_loop.tokens`).

```json
{
  "agentId": "agent-id",
  "source": "adf_loop",
  "note": "Includes token usage persisted on loop rows. It does not include model_invoke, compaction, or provider calls that did not create loop rows.",
  "loopRows": 42,
  "usageRows": 40,
  "totals": {},
  "byModel": []
}
```

This is the loop-row rollup; it does **not** include `model_invoke`, compaction,
or provider calls that produced no loop row. The full per-call usage/cost channel
is the `llm.completed` umbilical event — see
[the umbilical event catalog](../guides/umbilical-events.md#llm--stable).

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

## Cognition loops

An agent has one or more **cognition loops**: parallel chat sessions (threads)
with their own history, sharing the agent's file, identity and credentials.
`main` is the implicit host loop — the one you talk to by default. **Inner
loops** (declared in `AgentConfig.loops`) are interior workers with their own
goal and a subset of the agent's tools — e.g. a `consolidator` that tidies
memory on a recurring basis, a `researcher`, a `critic`. A timer or trigger
target with a `loop` field is how an inner loop runs on a schedule. Design:
[docs/design/agent-loops-mvp.md](../design/agent-loops-mvp.md).

Every mutation below goes through the agent's loop pool — the same path the
`loop_manage` tool takes — so validation, tool attenuation, owner locks
(`locked_fields: ['loops']`), and archive-on-delete hold for HTTP callers too.
Loop-scoped reads elsewhere take a `loop` query parameter (absent = `main`,
unknown = `404`): `GET /agents/:id/loop`, `GET /agents/:id/chat`,
`DELETE /agents/:id/chat`. `POST /agents/:id/chat` takes `loop` in the body,
and `POST /agents/:id/timers` takes `loop` to schedule an inner loop.

Errors: `400` invalid declaration (bad name, unknown or never-grantable tool,
rename attempt, empty patch), `404` unknown agent or loop, `409` refusal
(duplicate name, `main` is not managed here, loop cap reached, `loops` locked
by the owner, chat to a disabled loop).

### `GET /agents/:id/loops`

Lists `main` first, then inner loops in config order.

```json
{
  "agentId": "agent-id",
  "loops": [
    { "name": "main", "goal": "…", "status": "idle", "enabled": true, "isMain": true, "config": null, "entryCount": 42, "effectiveTools": null },
    {
      "name": "consolidator",
      "goal": "Consolidate memories into mind.md.",
      "status": "running",
      "enabled": true,
      "isMain": false,
      "config": { "name": "consolidator", "goal": "Consolidate memories into mind.md.", "enabled": true, "autostart": false, "tools": ["loop_send", "loop_list", "sys_set_state"] },
      "entryCount": 7,
      "effectiveTools": ["loop_send", "loop_list", "sys_set_state", "loop_compact", "loop_clear"]
    }
  ]
}
```

| Field | Description |
|-------|-------------|
| `status` | `idle` or `running` (live, in-memory) |
| `config` | The inner loop's `LoopConfig`; `null` for `main` (its config is the agent's) |
| `entryCount` | Rows in the loop's own stream |
| `effectiveTools` | Tools the loop's executor actually holds after attenuation; `null` for `main` or a loop with no live runtime (disabled) |

### `POST /agents/:id/loops`

Creates an inner loop. Body is a `LoopConfig`; only `name` and `goal` are
required. Defaults match `loop_manage`: `enabled: true`, `autostart: true`,
`tools` = `loop_send` + `loop_list` + `sys_set_state` (filtered to what this
agent can grant). An enabled autostart loop is kicked off at once through the
ordinary `loop_send` path. Returns `201`:

```json
{
  "agentId": "agent-id",
  "loop": { "name": "consolidator", "status": "idle", "enabled": true, "isMain": false, "config": {}, "entryCount": 0, "effectiveTools": [] },
  "effectiveTools": ["loop_send", "loop_list", "sys_set_state"],
  "excludedTools": [],
  "kickoff": null
}
```

`excludedTools` lists requested tools the agent has disabled — carried by name,
granted once the owner enables them. `kickoff` is the `LoopSendResult`
(`{ delivered, woke, reason? }`) when an autostart kickoff was sent.

### `GET /agents/:id/loops/:name`

Returns `{ "agentId": "…", "loop": LoopInfo }`.

### `PATCH /agents/:id/loops/:name`

Patches an inner loop. Any of `goal`, `enabled`, `autostart`, `autonomous`,
`model`, `compact_threshold`, `tools`; present keys replace wholesale.
`"model": null` / `"compact_threshold": null` remove the override, so the loop
inherits main's model / compaction threshold again. The loop is re-derived at once; `enabled: false` stops a running loop now (its
turn is aborted and flushed). Loops cannot be renamed. Returns
`{ agentId, loop, updated: string[], excludedTools }`.

### `DELETE /agents/:id/loops/:name`

Stops the loop (mid-turn included), archives its stream to `adf_audit` under
`loop:<name>`, drops its timers (locked timers are kept), then removes it.
Returns the pool's `LoopDeleteResult`:

```json
{ "agentId": "agent-id", "name": "consolidator", "archivedEntries": 7, "interruptedTurn": false }
```

There is no owner "send to loop" endpoint: `POST /agents/:id/chat` with
`loop` is the owner's voice into any loop. Loop-to-loop messages
(`[from loop:<name>]`) are the agents' own `loop_send` tool.

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

A changed `config.state` in the body does **not** move the running agent's live
state — the config field is the persisted start state, not a live control. Use
`POST /agents/:id/state` to move a loaded agent.

### `POST /agents/:id/state`

Moves the running agent's **live display state** (fleet-map semantics). This is
the dedicated surface for state control; config edits do not move a loaded agent.

Request body:

```json
{
  "state": "idle"
}
```

`state` must be one of `active`, `idle`, `hibernate`, `suspended`, `off`;
anything else returns `400`. The call errors when the executor is stopped or in
an error state. The new state is **not persisted** to the `.adf` config — it is
live-only and does not survive a reload.

Response:

```json
{
  "agentId": "agent-id",
  "success": true,
  "state": "idle"
}
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

Returns a display-oriented chat history derived from recent loop rows. Optional `limit` defaults to `200`; optional `loop` (default `main`) picks the cognition loop. The response carries `loop`.

### `DELETE /agents/:id/chat`

Clears persisted loop/chat history and resets the in-memory session. Optional `loop` query (default `main`) clears one loop's stream only — never all of them. Returns `{ agentId, loop, success }`.

### `GET /agents/:id/files`

Lists files in the agent virtual filesystem.

```json
{
  "agentId": "agent-id",
  "files": [
    {
      "path": "README.md",
      "size": 1024,
      "mime_type": "text/markdown",
      "protection": "none"
    }
  ]
}
```

### `GET /agents/:id/files/content?path=...`

Returns one file. Text-like files use `encoding: "utf-8"` and `content`. Binary files use `encoding: "base64"` and `content_base64`.

```json
{
  "agentId": "agent-id",
  "path": "README.md",
  "mime_type": "text/markdown",
  "size": 1024,
  "protection": "none",
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

Optional `loop` names the cognition loop an agent-scope wake dispatches to (absent = `main`; unknown = `404`). This is how an inner loop runs on a schedule — e.g. an hourly consolidator:

```json
{ "mode": "interval", "every_ms": 3600000, "scope": ["agent"], "loop": "consolidator", "payload": "consolidate" }
```

A system-scope-only timer carries no loop. The timer list returns each timer's `loop`.

### `PUT /agents/:id/timers/:timerId`

Updates an existing timer using the same body as timer creation. With `loop` the timer moves to that loop in place (same id; `"main"` moves it back to main; unknown loop `404`). Without `loop` it keeps the loop it has.

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

Queries a table with optional `limit` and `offset`. Reads are restricted to
`local_*` tables plus `adf_audit`; any other name returns `400` ("Invalid table
name"). In particular, `adf_inbox` and `adf_outbox` are **not** readable here —
use the dedicated `GET /agents/:id/inbox` and `GET /agents/:id/outbox` endpoints.

### `DELETE /agents/:id/tables/:table`

Drops a local table. Only `local_` tables can be dropped.

### `GET /agents/:id/umbilical/events`

Catch-up read over the agent's **in-memory umbilical replay window** — the second
half of snapshot-then-tail remote observation. Fetch state through the read
endpoints above, then poll here from the last `seq` you saw.

| Parameter | Description |
|-----------|-------------|
| `since_seq` | Return events with `seq` strictly greater than this. Omit for the whole retained window |
| `limit` | Number of events, default `500`, clamped between `1` and `2000` |

```json
{
  "agentId": "hzcR5GKpj6-4",
  "events": [
    {
      "seq": 1712,
      "event_type": "tool.completed",
      "timestamp": 1732041000123,
      "source": "agent:turn-9",
      "payload": { "name": "fs_read" },
      "truncated": false
    }
  ],
  "last_seq": 1712,
  "log_enabled": true,
  "oldest_seq": 1301
}
```

`truncated: true` means the payload's JSON exceeded 4 KB and was replaced by
`{ "_truncated": true, "preview": "..." }`. Fetch the detail through the normal
read endpoints.

`last_seq` is the highest `seq` returned, or the `since_seq` you passed when
nothing is new (`null` when neither applies) — feed it back as the next
`since_seq`.

`oldest_seq` is the lowest `seq` still in the window (omitted when the window is
empty). **Use it to detect a gap:** if `since_seq < oldest_seq - 1`, your cursor
predates the window, the events you are receiving are incomplete, and you must
**re-snapshot** rather than stitch.

The window is **opt-in** (`umbilical.log.enabled` in the agent config),
in-memory, and bounded — an event that has aged out, or an agent that restarted,
is simply a gap. Nothing is persisted. When the window is off or the agent has no
buffer, this returns **200** with:

```json
{ "events": [], "last_seq": null, "log_enabled": false }
```

That is not an error — clients probe this endpoint to decide whether tailing is
available at all. `404` still means unknown agent. See
[the umbilical guide](../guides/umbilical.md#replay-window) for the full recipe,
and [sealed epochs](../design/sealed-epochs.md) for the deferred durable-history
design.

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
      "requires_authorization": true,
      "canAlwaysApprove": true
    }
  ]
}
```

`pending_approval` rows also carry the live "Always approve" affordance,
derived from the executor (main or inner loop) holding the request — never
persisted:

| Field | Meaning |
|-------|---------|
| `canAlwaysApprove` | `true` when `POST …/always-approve` would be accepted |
| `alwaysApproveBlockedReason` | Why not, when `canAlwaysApprove` is `false`: `Target is locked (<level>)` (protection override), `One-time approval only for this request` (synthetic approval such as `mcp_oauth_signin`), `Tool declaration is locked`, or no live request waiting on the row (resolve it instead) |

### `GET /agents/:id/tasks/:taskId`

Returns one task (same `canAlwaysApprove` fields as the list).

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
| `deny` | Deny the task, optionally with `reason`. The reason is stored as the task's `error` and handed back to the agent as the owner's feedback (Studio's "Reject with feedback"): a blocking call's tool result reads `Tool call "<tool>" was rejected by authorizer. Feedback: <reason>` |
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

Status codes:

| Status | Cause |
|--------|-------|
| `400` | `action` missing or not one of `approve`, `deny`, `pending_approval` |
| `404` | Unknown agent, or unknown task id |
| `409` | The task is not `pending`/`pending_approval` (already `completed`, `failed`, `denied`, or `cancelled`) and cannot be resolved |

`404`/`409` replace what used to surface as an opaque `500`.

At load time the runtime reconciles orphaned tasks left by a crash or hard
shutdown: `running` tasks become `failed` (side effects unknown), and the
executor's own `pending_approval` tasks become `cancelled` (no human ever
decided). A task swept this way is terminal, so a later resolve on it returns
`409`.

A request parked by an inner loop's executor is answered on that executor;
the call is the same.

### `POST /agents/:id/tasks/:taskId/always-approve`

Studio's Approve ▸ Always approve. Drops the HIL gate on the tool — the HOST
declaration in `config.tools` becomes `enabled: true, restricted: false` (added
if absent) — persists and propagates it exactly like `PUT /agents/:id/config`,
then approves the pending request. No body; the tool is taken from the pending
request, never from the client.

Protections get one-time overrides only: the call is refused for protection
overrides, synthetic one-shot approvals and locked declarations (re-checked
against the live host config).

Response:

```json
{
  "agentId": "agent-id",
  "taskId": "task-id",
  "loop": "main",
  "tool": "fs_write",
  "resolution": { "task_id": "task-id", "status": "approved" },
  "task": {}
}
```

`loop` is the loop whose executor held the request. Inner loops never receive
`restricted` tools (their derived toolset excludes them), so the un-restricted
host tool reaches a loop only if that loop's `tools` allow-list names it.

Status codes:

| Status | Cause |
|--------|-------|
| `404` | Unknown agent or task |
| `409` | Task not `pending_approval`; no live request waiting on it; or always-approve not allowed — `error` is the blocked reason (same text as `alwaysApproveBlockedReason`) |

### `POST /agents/:id/tasks/approve-all`

Studio's "Approve all": approves every pending gated (`restricted`) approval
across main and every running inner loop. Protection overrides are never
included (the executor enforces it) and are counted instead. Optional body
`{ "loop": "<name>" }` (or `?loop=`) limits it to one loop.

```json
{ "agentId": "agent-id", "approved": 2, "skippedProtection": 1 }
```

With a loop, the response also echoes `"loop"`. `404` for an unknown agent or
loop, `409` when that loop has no running executor.

### `GET /agents/:id/asks`

Lists pending `ask` requests of every loop (main and each running inner
loop). `loop` names the loop whose turn is waiting on the answer.

```json
{
  "agentId": "agent-id",
  "asks": [
    {
      "requestId": "request-id",
      "question": "Proceed?",
      "loop": "main"
    }
  ]
}
```

### `POST /agents/:id/asks/:requestId/respond`

Answers a pending `ask` request.

Request body:

```json
{
  "answer": "yes",
  "loop": "researcher"
}
```

`loop` is optional. Request ids are numbered per loop, so pass the `loop` from
`GET /asks` when two loops ask at once; without it the first loop holding the
id is answered.

Response:

```json
{
  "agentId": "agent-id",
  "requestId": "request-id",
  "loop": "researcher",
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

### Tracked agent folders

Studio's tracked directories over HTTP. The list is settings
`trackedDirectories` (`string[]`), the same key Studio writes and the daemon
reads at boot for its autostart scan. The routes write it through the daemon's
internal settings store; it is not a write-denied key. Tracking or untracking
never creates, moves or deletes files. Scans use `maxDirectoryScanDepth`
(default `5`).

#### `GET /tracked-dirs`

```json
{
  "maxDepth": 5,
  "directories": [
    { "path": "C:\\Users\\me\\Documents\\adf-agents", "exists": true, "agentCount": 3, "loadedCount": 2 }
  ]
}
```

`agentCount` is the number of `.adf` files an autostart scan finds under the
folder, and `loadedCount` is how many of the agents loaded in this daemon live
under it.

#### `POST /tracked-dirs`

Body: `{ "path": "<absolute folder>" }`. The folder is tracked right away:

1. It must be an absolute path to an existing directory. It is stored
   canonicalized: resolved, with symlinks and 8.3 names expanded and no
   trailing separator.
2. It is persisted to `trackedDirectories`. As in Studio, a new parent
   replaces tracked subfolders it now covers (`absorbed`).
3. The live daemon is updated, so the mesh uses the new tracked roots
   immediately.
4. The folder goes through the same autostart pass as daemon boot and
   `POST /agents/autostart`, with the same review gate. Unreviewed agents are
   not loaded and are listed in `needsReview`; accept them with
   `POST /agents/review/accept`.

`201` response:

```json
{
  "entry": { "path": "/home/me/agents", "exists": true, "agentCount": 2, "loadedCount": 1 },
  "directories": ["/home/me/agents"],
  "absorbed": [],
  "autostart": { "scanned": 2, "started": [], "skipped": [], "failed": [] },
  "needsReview": [{ "filePath": "/home/me/agents/agent-2.adf", "name": "agent-2", "reason": "unreviewed", "agentId": "…" }]
}
```

| Status | Cause |
|--------|-------|
| `400` | `path` missing, not absolute, missing on disk, or not a directory |
| `405` | The settings store is read-only |
| `409` | Already tracked, under any spelling (case and separators are normalized on Windows/macOS), or covered by a tracked parent. `coveredBy` names the tracked entry |
| `503` | No settings store is configured |

#### `DELETE /tracked-dirs?path=<folder>&unload=true|false`

Stops tracking a folder. `path` matches the stored string exactly or names the
same folder under another spelling. A folder that no longer exists on disk can
still be untracked by its stored string. `unload` defaults to `false`, which
leaves the folder's agents running. With `unload=true`, every loaded agent
whose file is under the folder is unloaded; its files stay on disk.

```json
{ "removed": "/home/me/agents", "directories": [], "unloaded": [{ "agentId": "…", "filePath": "/home/me/agents/agent-1.adf", "name": "agent-1" }] }
```

`400`: `path` missing or `unload` not `true`/`false`. `404`: not a tracked
folder. `405` and `503`: same as POST.

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

Aborts the current turn without unloading the agent. This is a hard stop: the
executor is left `stopped` and does not run further turns, triggers or timers
until the agent is reloaded. To end a turn and keep the agent working, use
`POST /agents/:id/interrupt`.

Response:

```json
{
  "success": true
}
```

### Aborting one loop's turn

`POST /agents/:id/abort` aborts main's current turn. With `?loop=<name>` (or a
`{ "loop": "<name>" }` body) it aborts that inner loop's turn instead; unknown
loop `404`, a disabled loop (no live executor) `409`.

### `POST /agents/:id/interrupt`

Ends the running turn of main (or of an inner loop with `?loop=<name>` / a
`{ "loop": "<name>" }` body) and sets that executor `idle`, the same teardown
as Studio's fleet map. Unlike `abort`, the executor is not stopped: later chats,
triggers and timers keep running. Clients should use this for "Esc to
interrupt"; `abort` is the hard stop.

```json
{ "success": true, "interrupted": true, "loop": "main" }
```

`interrupted` is `false` when nothing was running. Unknown loop `404`; a
disabled loop, or a stopped/errored executor, `409`.

### `POST /agents/:id/compact`

Compacts one loop's history now: the same summarize-and-replace the agent's
own compaction runs, on demand (Studio's `/compact`). `?loop=<name>` (or a
`{ "loop": "<name>" }` body) picks an inner loop; absent = main. Emits
`loop.compacted` (`loop.compaction_failed` on failure). While it runs the loop
counts as mid-turn: triggers queue and chats are replayed after it. Refused
with `409` while that loop is mid-turn or already compacting, when there is
nothing to compact, or for a disabled loop; unknown loop `404`; `502` when the
summarization call fails (history is preserved).

```json
{ "agentId": "agent-id", "loop": "researcher", "success": true }
```

### `POST /agents/:id/chat`

Queues an asynchronous user chat event.

Request body:

```json
{
  "text": "hello daemon",
  "loop": "researcher"
}
```

`loop` is optional (absent = `main`). An unknown loop answers `404` and a disabled loop `409`, before any turn is queued.

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

**The owner voice is not reachable here.** An event whose `data.message.source` is `user` is rejected with `400` — that source is reserved for the owner's own voice and is inlined verbatim into the loop. To speak as the owner, use `POST /agents/:id/chat`. Use `api` or `mesh` for injected message sources.

**`/trigger` bypasses the TriggerEvaluator entirely.** The dispatch is handed straight to the agent's executor. There is no `enabled` check, no target/scope gate, no filter, no timing modifier, no state gating, and no self-suppression — none of the trigger config applies. A `{ "type": "inbox" }` dispatch fires the trigger but creates **no `adf_inbox` row** (only real ingress via the mesh inbox writes rows). Do not use `/trigger` to test trigger wiring or to simulate a real inbound message — it exercises neither path. Use `POST /agents/:handle/inbox` on the mesh server (see [Mesh Server](#mesh-server)) for a real message.

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

The daemon keeps its **own** subscription session, separate from ADF Studio's —
signing in to Studio does not sign in the daemon. See
[Where subscription sessions are stored](../guides/settings.md#where-subscription-sessions-are-stored)
for the storage format and its security trade-off.

### `GET /auth/chatgpt/status`

Returns the app-wide ChatGPT subscription auth status.

```json
{
  "authenticated": false
}
```

### `POST /auth/chatgpt/start`

Starts a detached OAuth flow. The daemon prints completion status to stdout.

Body (optional):

```json
{
  "mode": "loopback",
  "redirectUri": "http://localhost:1455/auth/callback"
}
```

`mode` defaults to `loopback`. ChatGPT uses a loopback OAuth redirect, so the
callback server must run on the same machine as the browser — pick the mode that
matches where the daemon is:

| Mode | Callback served by | Use when |
| --- | --- | --- |
| `loopback` | the daemon | the browser is on the daemon's host |
| `relay` | the caller | the daemon is remote |

**Loopback response:**

```json
{
  "started": true,
  "mode": "loopback",
  "authUrl": "https://...",
  "callbackPort": 12345
}
```

Open `authUrl` in a browser, then poll `GET /auth/chatgpt/status`.

When any sign-in completes (loopback, relay, or Grok device flow), every
loaded agent loop sitting in `error` on an authentication failure from a
provider of that type (`chatgpt-subscription` / `grok-subscription`) returns
to `idle` and emits `agent.recovered`. The failed turn is not re-run; errors
with other causes are left alone.

**Relay response.** `redirectUri` is required and must be a loopback URL — the
daemon holds the PKCE verifier while you serve the callback yourself:

```json
{
  "started": true,
  "mode": "relay",
  "flowId": "8f3c...",
  "authUrl": "https://...",
  "state": "kR2m...",
  "expiresAt": 1760000000000
}
```

Open `authUrl`, capture the `code` and `state` your callback receives, then post
them to `/auth/chatgpt/complete` within 10 minutes.

Grok needs none of this — its device-code flow works against a remote daemon as-is.

### `POST /auth/chatgpt/complete`

Finishes a `relay` flow. Each `flowId` is single-use.

Body:

```json
{
  "flowId": "8f3c...",
  "code": "authorization-code-from-your-callback",
  "state": "kR2m..."
}
```

Response:

```json
{
  "success": true,
  "status": { "authenticated": true, "email": "you@example.com", "expiresAt": 1760000000000 },
  "recovered": [{ "agentId": "...", "filePath": "...", "loop": "main", "notice": "agent-1 recovered after ChatGPT sign-in" }]
}
```

Returns `400` for an unknown or expired `flowId`, a mismatched `state`, or a
failed token exchange.

### `POST /auth/chatgpt/logout`

Logs out of the ChatGPT subscription session.

```json
{
  "success": true
}
```

## Grok Subscription Auth

### `GET /auth/grok/status`

Returns the app-wide Grok (xAI) subscription auth status. While a device-code
flow is pending, `flowPending` is `true`; a failed flow surfaces `flowError`.

```json
{
  "authenticated": false,
  "flowPending": false
}
```

### `POST /auth/grok/start`

Starts a detached OAuth device-code flow (RFC 8628). The daemon polls xAI in
the background and prints completion status to stdout — no localhost callback
is used, so this works over SSH.

Response:

```json
{
  "started": true,
  "userCode": "ABCD-EFGH",
  "verificationUri": "https://auth.x.ai/activate",
  "verificationUriComplete": "https://auth.x.ai/activate?user_code=ABCD-EFGH",
  "expiresIn": 600
}
```

Open `verificationUriComplete` (or `verificationUri` and enter `userCode`) in
any browser to complete sign-in, then poll `GET /auth/grok/status`.

### `POST /auth/grok/logout`

Logs out of the Grok subscription session.

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

Valid `step` values are `check`, `install`, `machine_init`, and `machine_start`. Any other `step` is rejected before Podman is probed.

`install` also takes `installCommand`, which must exactly match the `command` of an `autoRunnable` entry in `availability.installMethods` from the `check` step (for example `/opt/homebrew/bin/brew install podman`). Any other value is rejected with `Install command is not one this runtime can run automatically`, and nothing is run. Methods with a `url` (such as the macOS installer when Homebrew is absent) are for the user to open, not to run. On Linux every install method needs `sudo` and is not `autoRunnable`, so `install` is always refused there; run the listed command yourself.

`machine_init` sizes the Podman machine from the compute settings `machineMemoryMb` and `machineCpus`. Missing, non-integer, non-positive, or larger-than-this-host values fall back to the defaults (2048 MB, 2 CPUs).

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

## Mesh Server

The **mesh server** is a *separate* Fastify HTTP server from the daemon API. It
listens on the mesh port (default `7295`), not the daemon port (`7385`), and it
is the agent-facing network surface — agent cards, health, and ALF message
delivery. The daemon API documented above does **not** serve agent cards or
accept mesh message delivery.

The mesh server is enabled/started through the daemon's Network Admin endpoints
(`meshEnabled` / `POST /network/server/start`).

Routes (from `src/main/services/mesh-server.ts`):

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Mesh server health check |
| `GET` | `/ping` | Runtime identity probe |
| `GET` | `/agents` | Visibility-filtered agent directory |
| `GET` | `/agents/:handle/card` | One agent's card (reserved protocol mailbox) |
| `GET` | `/agents/:handle/health` | One agent's health (reserved protocol mailbox) |
| `POST` | `/agents/:handle/inbox` | ALF message delivery (reserved protocol mailbox) |

`POST /agents/:handle/inbox` is the **only** message-injection point that writes
a real inbound message. It requires a full, signed ALF wire message — it is not a
convenience endpoint. The daemon's `POST /agents/:id/trigger` does not substitute
for it (see [`/trigger`](#post-agentsidtrigger)).

Everything else under `/agents/:handle/*` is agent-controlled serving (public
files, shared files, and `serving.api` lambdas, including path-matched WebSocket
upgrades). `inbox`/`card`/`health` are reserved top-level segments within a
handle.

## Error Responses

Common errors:

| Status | Shape | Cause |
|--------|-------|-------|
| `400` | `{ "error": "..." }` | Invalid request body or query |
| `403` | `{ "error": "...", "code": "AGENT_REVIEW_REQUIRED" }` | Review gate blocked loading |
| `404` | `{ "error": "Unknown agent ..." }` | Agent ID is not loaded |
| `409` | `{ "error": "..." }` | Target resource is in a state that does not permit the operation (e.g. resolving a non-pending task) |
| `405` | `{ "error": "..." }` | Settings store is read-only |
| `503` | `{ "error": "..." }` | Optional service is not configured |
| `500` | `{ "error": "..." }` | Runtime error |

## Client Visibility

Use `/events` for live updates and `/agents/:id/loop` for persisted conversation history. `/events?since=<cursor>` can replay recent buffered frames, but it is not a durable event log — the cursor is process-local and resets when the daemon restarts.
