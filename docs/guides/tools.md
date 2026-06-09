# Tools

Tools are the capabilities available to an agent during its LLM loop. Each tool has access controls: `enabled` (the tool exists and can be called — by the LLM, lambdas, or other code), `visible` (the tool is advertised in the LLM's tool schema; this only controls what the model is *shown*, not what it may call), and `restricted` (limits access to authorized code, with HIL for loop calls).

## Tool Categories

ADF provides tools organized into these categories:

- [Turn Tools](#turn-tools) — Emitting text and controlling conversation flow
- [Filesystem Tools](#filesystem-tools) — Reading, writing, and managing files
- [Database Tools](#database-tools) — Querying and modifying local tables
- [Messaging Tools](#messaging-tools) — Sending and receiving inter-agent messages
- [WebSocket Tools](#websocket-tools) — Managing persistent WebSocket connections
- [Stream Binding Tools](#stream-binding-tools) — Pumping bytes between endpoints outside the loop
- [Execution Tools](#execution-tools) — Running code and scripts
- [Function Call Tool](#function-call-tool) — Calling agent-authored functions
- [Package Management Tools](#package-management-tools) — Installing npm packages for the sandbox
- [Timer Tools](#timer-tools) — Scheduling events
- [Loop Management Tools](#loop-management-tools) — Managing conversation history
- [Message Deletion Tools](#message-deletion-tools) — Cleaning up inbox and outbox
- [State and Config Tools](#state-and-config-tools) — Self-management

## Turn Tools

These tools control conversation flow. They replace raw text-only LLM responses.

### respond

**Parameters:** `message`

Emit text to the conversation. Behavior depends on [loop mode](agent-states.md#loop-modes):

- **Interactive mode:** Ends the turn. Agent returns to idle.
- **Autonomous mode:** Logs the message. Turn continues.

### say

**Parameters:** `message`

Emit text to the conversation without ending the turn. Use for status updates, intermediate observations, or progress reports.

### ask

**Parameters:** `question`

Pose a question and block until the human responds. **Interactive mode only** — disabled in autonomous mode.

The loop pauses, the question appears in chat, and when the human replies the loop resumes with their answer.

## Filesystem Tools

Tools for working with the agent's [virtual filesystem](documents-and-files.md).

### fs_read

**Parameters:** `path`, `start_line?`, `end_line?`

Read a file from the VFS. Always returns a JSON object with the full file record: `{ path, content, mime_type, size, protection, created_at, updated_at }`.

- **Text files** return raw text content. Use `start_line`/`end_line` for large files.
- **Binary files** return base64 content in code execution. In chat, the executor strips binary content (metadata only) — use code execution to process binary data programmatically.
- **Media files** — When the corresponding `model.multimodal` modality is enabled, the LLM receives a native content block (`image_url`, `input_audio`, or `video_url`) alongside the JSON metadata row, allowing the agent to perceive the media directly. Media blocks are ephemeral (not persisted to `adf_loop`). When disabled, media returns the JSON row with `content: null`. Media exceeding the size limit (`max_image_size_bytes`, `max_audio_size_bytes`, `max_video_size_bytes`) is skipped. See [Multimodal](../ADF_STUDIO_DOCS.md#multimodal) for supported formats and details.

Two output guards are applied by the executor when results go to the LLM context:

- **Token limit** — Files exceeding `max_file_read_tokens` (~30k tokens) are truncated with a footer showing the full size
- **Large file preview** — Files over 300 lines (but within the token limit) show only the first 50 lines with a size summary

These guards do not apply in code execution — `adf.fs_read()` always returns full content.

### fs_write

**Parameters:** `path`, `content?`, `old_text?`, `new_text?`, `protection?`, `encoding?`, `mime_type?`

Unified write/edit tool with two modes:

- **Write mode** (`content`): Create or overwrite a file. Content size is limited by `limits.max_file_write_bytes` (default: 5 MB) for non-core files. The optional `protection` parameter sets the file's protection level (`read_only`, `no_delete`, or `none`).
- **Edit mode** (`old_text` + `new_text`): Find and replace text in-place. `old_text` must match exactly once. More precise than overwriting the entire file.

Must provide either `content` OR `old_text`+`new_text`, not both.

**Binary support:** Set `encoding: "base64"` to write binary files from code. Optionally include `mime_type` (e.g. `"image/png"`). Blocked if the file's protection level is `read_only`.

**Authorized code bypass:** When called from [authorized code](authorized-code.md), `fs_write` bypasses the `read_only` file protection check and can overwrite any file. Same privilege as the Studio UI.

### fs_list

**Parameters:** `prefix?`

List files in the virtual filesystem. Optionally filtered by path prefix (e.g., `fs_list("lib/")` to list only library files). Returns file metadata including protection level.

### fs_delete

**Parameters:** `path`

Delete a file. Blocked if the file's protection level is `read_only` or `no_delete`. If `audit.files` is enabled, the file's content is snapshot to `adf_audit` before deletion. See [Memory Management > Audit](memory-management.md#audit).

**Authorized code bypass:** When called from [authorized code](authorized-code.md), `fs_delete` bypasses both `read_only` and `no_delete` protection and can delete any file. Same privilege as the Studio UI.

## Database Tools

Tools for working with custom SQLite tables.

### db_query

**Parameters:** `sql`, `params?`

Execute a read-only SELECT statement. Results are capped at **500 rows** by default — queries returning more are truncated with a footer showing the total count. Add a `LIMIT` clause to your query, or use [`_full: true`](#_full-parameter) from code execution to get all rows.

Can query:

- `local_*` tables (agent-created)
- `adf_loop`, `adf_inbox`, `adf_outbox` (conversation data)
- `adf_timers`, `adf_files` (agent state)
- `adf_audit`, `adf_logs`, `adf_tasks` (history and diagnostics)

Cannot query `adf_meta`, `adf_config`, or `adf_identity` — use `sys_get_config` instead.

### db_execute

**Parameters:** `sql`, `params?`

Execute INSERT, UPDATE, DELETE, CREATE TABLE, CREATE VIRTUAL TABLE, or DROP TABLE statements on `local_*` tables only. Cannot modify `adf_*` system tables. Supports creating `vec0` virtual tables for vector search — see [Vector Search](documents-and-files.md#vector-search).

## Messaging Tools

Tools for inter-agent communication. See [Messaging](messaging.md) for the full protocol.

### msg_send

**Parameters:** `recipient?`, `address?`, `payload`, `intent?`, `trace_id?`, `parent_id?`, `attachments?`

Send a message to another agent. Two modes:

1. **Direct send** — Provide `recipient` (DID) + `address` (delivery URL) + `payload`
2. **Reply via parent_id** — Provide `parent_id` + `payload`. The runtime resolves recipient and address from the referenced inbox message.

For adapter recipients (e.g., Telegram), use `recipient: "telegram:123"` without an address.

Use `agent_discover` to discover agents and their DIDs/addresses.

Subject to [messaging mode](creating-agents.md#messaging-mode) restrictions:

- `respond_only` agents must include a valid `parent_id` or be in a message-triggered turn
- `listen_only` agents cannot send at all

### msg_read

**Parameters:** `limit?`, `status?`

Fetch messages from the inbox. Filter by status (`unread`, `read`, `archived`). Messages returned by `msg_read` are automatically marked as `read`.

### msg_list

**Parameters:** `status?`

Lightweight inbox check — returns message counts by status without fetching full content. Useful for "Do I have mail?" checks.

### msg_update

**Parameters:** `ids`, `status`

Update message status. Typically used to mark messages as `read` or `archived` after processing.

### agent_discover

**Parameters:** `scope?`, `visibility?`, `handle?`, `description?`, `include_subdirectories?`

Discover agents reachable from this agent. Returns signed agent cards (handle, description, DID, endpoints, public_key, policies, visibility, `in_subdirectory`, `source`) — not a flattened name/address list. Visibility enforcement is symmetric with delivery: you only see an agent if you could also message it.

| Parameter | Description |
|-----------|-------------|
| `scope` | `"local"` (default) or `"all"`. `"all"` merges local-runtime cards with mDNS-discovered LAN peers. See [LAN Discovery](lan-discovery.md). |
| `visibility` | Array of tiers (`"directory"`, `"localhost"`, `"lan"`, `"off"`) to include. E.g. `["lan"]` to find only LAN-announced agents. |
| `handle` | Case-insensitive substring match on the agent handle. |
| `description` | Case-insensitive substring match on the agent description. |
| `include_subdirectories` | (Backward-compat for `"local"` scope.) When false, excludes agents in subdirectories. |

```json
[
  {
    "handle": "monitor",
    "did": "did:key:z6Mk...",
    "description": "Monitors system resources",
    "public_key": "z6Mk...",
    "endpoints": {
      "inbox": "http://127.0.0.1:7295/monitor/mesh/inbox",
      "card":  "http://127.0.0.1:7295/monitor/mesh/card",
      "health":"http://127.0.0.1:7295/monitor/mesh/health"
    },
    "policies": [],
    "visibility": "localhost",
    "in_subdirectory": false,
    "source": "local-runtime"
  }
]
```

See [Messaging > Visibility Tiers](messaging.md#visibility-tiers) for how tier filtering interacts with the caller's own declared tier.

## WebSocket Tools

Tools for managing persistent WebSocket connections. All disabled by default. See [WebSocket Connections](websocket.md) for configuration details.

### ws_connect

**Parameters:** `id?`, `url?`, `did?`, `lambda?`, `persist?`, `auto_reconnect?`, `reconnect_delay_ms?`, `keepalive_interval_ms?`

Start a WebSocket connection. Two modes:

1. **Config-based** — Provide `id` of a connection defined in `ws_connections` config
2. **Ad-hoc** — Provide `url` for an on-the-fly connection

When `persist` is true (default), the connection definition is saved to `ws_connections` config so it survives agent restarts. Set `persist: false` for ephemeral connections.

Returns `connection_id` on success.

### ws_disconnect

**Parameters:** `connection_id?`, `id?`

Close an active WebSocket connection by its `connection_id` or config `id`.

### ws_connections

**Parameters:** `direction?`

List active WebSocket connections. Optionally filter by `direction` (`inbound` or `outbound`). Returns connection ID, remote DID, direction, connection time, and last message time.

### ws_send

**Parameters:** `connection_id`, `data`, `binary?`

Send a single frame over an active WebSocket connection. Frames may carry text or raw bytes:

- **Text** (default) — pass a string. From sandbox code, text frames default to ALF messages.
- **Binary** — from sandbox code, pass a `Uint8Array`. From direct LLM tool calls (no `Uint8Array` in JSON), pass base64-encoded `data` with `binary: true`.

Sends are backpressure-aware: `ws_send` awaits a drain when the socket's `bufferedAmount` exceeds the connection's high-water mark, so agents can stream large byte payloads without overrunning the buffer. See [WebSocket Connections](websocket.md#binary-frames) for details.

## Stream Binding Tools

Stream bindings connect two byte endpoints so the runtime pumps data between them **outside the LLM loop**. Once a binding is established, bytes flow endpoint-to-endpoint at wire speed — the agent is not in the data path and does not see, buffer, or pay context tokens for the traffic. The model's job is to *set up* and *tear down* plumbing, not to shuttle every chunk.

This is what lets an agent act as infrastructure rather than a chat endpoint: it can stand up a relay, tunnel, or tap, then step back while the runtime moves the bytes.

**Endpoint kinds:**

| Kind | Description |
|------|-------------|
| `ws` | An active WebSocket connection owned by this agent (by `connection_id`) |
| `tcp` | A raw TCP socket (`host`, `port`) — gated by `stream_bind.allow_tcp_bind` and the `tcp_allowlist` |
| `process` | A spawned process whose stdio is the stream. `isolation` is `host`, `container_shared`, or `container_isolated` (the last requires an `image`). Each isolation tier has its own enable flag in `stream_bind` config |
| `umbilical` | The agent's umbilical event stream as a **read-only source**. May only appear as endpoint `a`, never `b` |

**Use cases:**

- **Relay / bridge** — connect a remote peer's `ws` connection to a `tcp` service, exposing a local database, API, or device to the mesh without the agent proxying each packet.
- **Tunnel** — pipe a remote `ws` stream into a host or container `process` (run a CLI tool, stream its stdin/stdout) so an agent can drive real software over the wire.
- **Tap / observe** — bind the `umbilical` event source into a `process` or `tcp` sink for logging, metrics, or archival of the agent's own activity.
- **Bulk transfer** — move large payloads between two endpoints at full speed, never materializing them in the model's context.

Security is config-gated by the agent's `stream_bind` config — TCP, host processes, and each container tier are off unless explicitly enabled:

| Config key | Gates |
|------------|-------|
| `allow_tcp_bind` | Whether `tcp` endpoints are permitted at all |
| `tcp_allowlist` | The `host`/`port` rules a `tcp` endpoint must match (supports `port`, `ports`, `min_port`/`max_port`) |
| `host_process_bind` | `process` endpoints with `isolation: host` |
| `container_shared_bind` | `process` endpoints in the shared container |
| `container_isolated_bind` | `process` endpoints in a per-binding isolated container |

`ws` and `umbilical` endpoints need no extra config — they're scoped to connections and events the agent already owns. A binding request to a disabled or non-allowlisted target is rejected with an error.

> Bindings can also be declared statically in the agent's `stream_bindings` config (with optional `reconnect`), which the runtime materializes on start. The tools below are the imperative equivalent for setting bindings up and tearing them down at runtime.

### stream_bind

**Parameters:** `a`, `b`, `bidirectional?`, `options?`

Bind two endpoints. `a` and `b` are endpoint objects (see kinds above). By default data flows `a → b`; set `bidirectional: true` to pump both ways (both endpoints must be readable and writable). Returns a `{ binding_id }` used to manage the binding.

`options` bound the binding's lifetime and volume:

| Option | Description |
|--------|-------------|
| `idle_timeout_ms` | Close after this long with no bytes flowing |
| `max_duration_ms` | Hard cap on total binding lifetime |
| `max_bytes` | Close once this many bytes have been pumped |
| `flow_summary_interval_ms` | How often to emit flow/byte-count summary events |
| `close_a_on_b_close` / `close_b_on_a_close` | Tear down one side when the other closes |

```jsonc
// Bridge a remote WS peer to a local TCP service
{
  "a": { "kind": "ws", "connection_id": "peer-relay" },
  "b": { "kind": "tcp", "host": "127.0.0.1", "port": 5432 },
  "bidirectional": true,
  "options": { "idle_timeout_ms": 60000, "max_bytes": 1073741824 }
}
```

### stream_unbind

**Parameters:** `binding_id`

Terminate an active stream binding by ID, closing both endpoints according to the binding's close policy. Returns `{ ok: true }`.

### stream_bindings

**Parameters:** *(none)*

List this agent's active and pending bindings. Each entry includes the `binding_id`, sanitized `a`/`b` endpoint summaries, `bidirectional`, `origin` (imperative vs declarative), `status`, `created_at`, and live byte counters (`bytes_a_to_b`, `bytes_b_to_a`) — useful for monitoring throughput and deciding when to tear a binding down.

## Execution Tools

Tools for running code within the agent's context. All code runs in the [sandbox environment](code-execution.md) with access to the [`adf` proxy object](adf-object.md).

### sys_code

**Parameters:** `code`, `language?`, `timeout?`

Execute code in a sandboxed environment. The sandbox has:

- Full compute and data processing
- [Standard library packages](code-execution.md#standard-library-packages): xlsx, pdf-lib, mupdf, docx, jszip, sql.js, cheerio, yaml, date-fns, jimp
- Additional packages installable via [`npm_install`](#npm_install)
- Read/write access to `adf_files` and `local_*` tables
- Read access to `adf_inbox`/`adf_outbox`
- Timer globals: `setTimeout`, `clearTimeout`, `setInterval`, `clearInterval`
- **No** network access (native `fetch` is disabled — use `adf.sys_fetch()`)
- **No** access to private keys

Useful for math, data transformation, document processing (spreadsheets, PDFs, Word docs), and working with binary files programmatically. Code executed via this tool has access to the `adf` proxy object for calling other tools and invoking the model.

## Function Call Tool

### sys_lambda

**Parameters:** `source`, `args?`

Call a function from a script file in the agent's workspace. The `source` parameter specifies the file and optionally the function name using colon syntax: `"lib/utils.ts:myFunction"`. If no function name is specified, `main()` is called.

Functions receive the provided `args` as a single object parameter and should use destructuring:

```javascript
// lib/math.js
function add({ a, b }) {
  return a + b;
}
```

The function runs in the same sandboxed environment as `sys_code` and has full access to the `adf` proxy object for calling tools and invoking the model.

**Calling syntax examples:**
- `sys_lambda(source: "lib/utils.js")` — Calls `main()` in `lib/utils.js`
- `sys_lambda(source: "lib/utils.js:process", args: { data: "hello" })` — Calls `process({ data: "hello" })`

Lambdas replace the need for custom tool registrations — agents can call any script they've written using `sys_lambda`.

**Authorization:** When the LLM calls `sys_lambda` targeting an [authorized file](authorized-code.md), the runtime triggers a HIL approval prompt before execution. If approved, the lambda runs with authorization and can call restricted tools and methods. Unauthorized targets run normally with no prompt. This ensures the user has visibility whenever authorized code — and its elevated privileges — is invoked from the conversation loop.

## Package Management Tools

### npm_install

**Parameters:** `name`, `version?`

Install an npm package for use in the code execution sandbox (`sys_code` / `sys_lambda`). Pure JavaScript packages only — packages with native addons (e.g., `better-sqlite3`, `sharp`) are detected and rejected at install time.

The package becomes importable starting on the **next turn** (the sandbox module resolver rebuilds at the start of each execution).

```javascript
// Install a specific version
npm_install({ name: "vega-lite", version: "^5.21.0" })

// Install latest
npm_install({ name: "lodash" })
```

**Returns:**
- Success: `{ success: true, name: "vega-lite", version: "5.21.0", size_mb: 5.5 }`
- Already installed: `{ success: true, name: "vega-lite", version: "5.21.0", already_installed: true }`
- Native addon blocked: `{ success: false, error: "native_addon", message: "..." }`
- Size limit exceeded: `{ success: false, error: "size_limit", message: "..." }`

**Limits:** 50 MB per package, 200 MB total, 50 packages max per agent.

Installed packages are persisted to the agent's `code_execution.packages` config, so they survive agent restarts. Packages are installed to a shared directory on disk (`~/.adf-studio/sandbox-packages/`) — multiple agents referencing the same package share one install.

### npm_uninstall

**Parameters:** `name`

Remove a package from this agent's available packages. The package becomes unavailable to import starting on the next turn. Does not delete the package from disk (other agents may reference it).

```javascript
npm_uninstall({ name: "lodash" })
```

### Package Tiers

Packages in the sandbox are resolved in three tiers:

| Tier | Source | Scope | Managed by |
|------|--------|-------|------------|
| Standard library | Bundled with Studio | All agents, always | Studio releases |
| Runtime packages | Studio Settings > Packages | All agents on this instance | User via Settings UI |
| Agent packages | `code_execution.packages` in agent config | Single agent | Agent via `npm_install` / user via agent config UI |

WASM packages that export `initWasm()` (e.g., `@resvg/resvg-wasm`) are auto-initialized during import — no manual `initWasm()` call needed.

## HTTP Fetch Tool

### sys_fetch

**Parameters:** `url`, `method?`, `headers?`, `body?`, `timeout_ms?`

Make an HTTP request. Response bodies are capped at 25 MB.

**Binary response handling:** The response body format depends on the response's `Content-Type` header:

- **Text** (`text/*`, `application/json`, `application/xml`, `*+json`, `*+xml`) — `body` is a UTF-8 decoded string
- **Binary** (everything else — `audio/*`, `image/*`, `application/octet-stream`, etc.) — `body` is a `Buffer` containing the raw bytes

When no `Content-Type` header is present, the response defaults to text.

**Writing binary responses to files:** Pass the `Buffer` body directly to `fs_write` — no encoding parameter needed:

```javascript
// Fetch binary content (e.g. audio from a TTS API)
const resp = await adf.sys_fetch({
  url: 'https://api.openai.com/v1/audio/speech',
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${await adf.get_identity({ purpose: 'openai' })}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ model: 'tts-1', input: 'Hello world', voice: 'alloy' })
})

// resp.body is a Buffer — write directly to the virtual filesystem
await adf.fs_write({ mode: 'write', path: 'speech.mp3', content: resp.body })
```

When the LLM calls `sys_fetch` directly (not from code), binary bodies appear as base64-encoded strings with a `_body_encoding: "base64"` field in the JSON result.

## Compute Tools

Tools for interacting with the agent's compute environment (isolated container, shared container, or host machine). Available when any compute target is accessible. See [Compute Environments](compute.md) for the full guide.

### compute_exec

**Parameters:** `command`, `target?`, `timeout_ms?`

Execute a shell command in a compute environment. Supports pipes, chaining (`&&`, `||`), redirection, and all standard shell syntax. Returns `stdout`, `stderr`, and `exit_code`.

The `target` parameter selects the environment:
- `isolated` — agent's dedicated container (requires `compute.enabled`)
- `shared` — shared MCP container (`adf-mcp`)
- `host` — host machine directly (requires `compute.host_access`)

If omitted, defaults to the most isolated environment available (isolated → shared → host).

**Has `restricted: true` by default.** Use [`on_task_create`](triggers.md) trigger lambdas to set up auto-approval policies for specific commands.

### fs_transfer

**Parameters:** `path`, `direction`, `target?`, `save_as?`

Transfer files between the VFS (`adf_files`) and a compute environment.

- `direction: 'stage'` — copies a file from VFS into the compute workspace
- `direction: 'ingest'` — pulls a file from the compute workspace into VFS

The `target` parameter works the same as `compute_exec`. If omitted, defaults to the most isolated environment available.

For container targets, files are placed at `/workspace/{agentId}/{path}`. For host, files go to `~/.adf-studio/workspaces/{agentId}/{path}`.

The `save_as` parameter (ingest only) allows saving to a different VFS path than the source.

## Timer Tools

Tools for scheduling events. See [Timers](timers.md) for the full scheduling system.

### sys_set_timer

Create a timer. Supports three scheduling modes:

- **Once:** `at` (absolute timestamp) or `delay_ms` (relative delay)
- **Interval:** `every_ms` with optional `start_at`, `end_at`, `max_runs`
- **Cron:** `cron` expression with optional `end_at`, `max_runs`

All timers require a `scope` array (`["system"]`, `["agent"]`, or `["system", "agent"]`) and an optional `payload`.

Additional fields for system scope timers:

- `lambda` — Script entry point (e.g., `"lib/poller.ts:check"`). The lambda function is executed in a sandboxed environment when the timer fires.
- `warm` — Keep the sandbox worker alive between invocations (default: `false`). Use for frequently-firing timers to avoid startup overhead.

Timers own their execution config — `lambda` and `warm` are stored on the timer, not inherited from trigger targets. See [Timers](timers.md) for full details.

### sys_list_timers

List all active timers with their schedules, next fire times, and run counts.

### sys_delete_timer

**Parameters:** `id`

Cancel and delete a timer.

## Loop Management Tools

Tools for managing the conversation history. See [Memory Management](memory-management.md) for strategy.

### loop_compact

**Parameters:** `instructions?`

Trigger LLM-powered loop compaction. When called, the runtime:

1. Makes a dedicated LLM call to summarize the full conversation transcript
2. Deletes old loop entries (archived first if archiving is enabled)
3. Inserts the LLM-generated summary as a `[Loop Compacted]` message
4. Token counter is reset

The agent does not need to provide a summary — the compaction LLM generates a structured briefing with specific details (file paths, decisions, pending work) organized by topic. A compaction banner appears in the UI. The archive label only appears when loop archiving is enabled.

Pass the optional `instructions` string to steer the summarizer — use it to highlight critical context, decisions, or state that must survive compaction (e.g. `{ "instructions": "Keep the full deployment checklist and any open error messages verbatim." }`). When omitted, the summarizer uses its default briefing strategy.

### loop_clear

**Parameters:** `start?`, `end?`

Delete loop entries using Python-style slicing. Supports negative indices.

Examples:
- `loop_clear()` — Clear all entries
- `loop_clear(end: 5)` — Clear first 5 entries
- `loop_clear(end: -5)` — Clear all except last 5 entries
- `loop_clear(start: -10)` — Clear last 10 entries
- `loop_clear(start: 2, end: 8)` — Clear entries 2 through 7

If archiving is enabled, entries are compressed and archived before deletion.

To read past loop entries or compute loop statistics (row count, estimated tokens, oldest entry), query the `adf_loop` table directly with `db_query` / `db_execute`.

## Message Deletion Tools

### msg_delete

**Parameters:** `source`, `filter`

Delete messages from inbox or outbox by filter. Requires at least one filter field to prevent accidental deletion of all messages.

**Source:** `inbox` or `outbox`

**Filter fields:**
- `status` — Filter by message status (e.g., `"unread"`, `"read"`, `"archived"` for inbox)
- `sender` — Filter by sender ID (inbox only)
- `before` — Delete messages with timestamp before this value (epoch ms)
- `trace_id` — Filter by trace/thread ID

If archiving is enabled, matched messages are compressed and archived before deletion.

## State and Config Tools

### sys_set_state

**Parameters:** `state`

Transition the agent to `idle`, `hibernate`, or `off`. Always ends the LLM loop.

The agent cannot set itself to `active` (that happens via triggers) or `suspended` (that's runtime-only).

### sys_get_config

**Parameters:** `section?` (`"config"` | `"card"` | `"provider_status"`)

Returns the full agent configuration (excluding secrets) by default. With `section: "card"`, returns the agent's signed agent card as served on the mesh — useful for introductions, posting to registries, or inspecting the agent's own public-facing identity. The card is only available when the agent is served on the mesh.

With `section: "provider_status"`, returns rate limit and usage metadata from the LLM provider. Currently supported for ChatGPT Subscription providers — returns fields like `primaryUsedPercent`, `primaryResetAfterSeconds`, `planType`, and `creditsBalance`. See [Settings > Rate Limits](settings.md#rate-limits-and-provider-status) for the full field list. Useful for self-managing agents that need to throttle or defer work based on remaining quota.

### sys_update_config

**Parameters:** `path`, `value`, `action?` ("set" | "append" | "remove"), `index?`

Update agent configuration using a dot-path. Any field not in the deny list (`adf_version`, `id`, `metadata`, `locked_fields`, `providers`) can be modified unless locked.

**Basic field updates** — `path` + `value`:

- `{ "path": "description", "value": "New description" }`
- `{ "path": "model.temperature", "value": 0.5 }`
- `{ "path": "state", "value": "idle" }`
- `{ "path": "triggers.on_chat.enabled", "value": true }`
- `{ "path": "security.allow_unsigned", "value": false }`
- `{ "path": "model.model_id", "value": "claude-sonnet-4-20250514" }`

**Array operations** — use `action` and `index`:

| Operation | Example |
|-----------|---------|
| Append to array | `{ "path": "triggers.on_inbox.targets", "action": "append", "value": { "scope": "agent" } }` |
| Remove by index | `{ "path": "serving.api", "action": "remove", "index": 1 }` |
| Replace entire array | `{ "path": "tools", "value": [...] }` |

**Name-based path segments** address items in arrays of named objects by their `name` property — no need to know the index:

- `{ "path": "tools.fs_read.enabled", "value": true }` — enable the `fs_read` tool
- `{ "path": "tools.sys_code.enabled", "value": false }` — disable the `sys_code` tool

A string segment on an array is resolved by matching the element whose `name` equals that segment. If no element has that name, the update fails with a clear error. This is the preferred form for tools and other named-object arrays since it's stable across reordering.

**Numeric path segments** also index into arrays, and still work for any array (including items without a `name`):

- `{ "path": "triggers.on_inbox.targets.2", "value": { "scope": "system", "lambda": "lib/router.ts:handle" } }` — replace 3rd target
- `{ "path": "triggers.on_inbox.targets.2.filter.status", "value": "approved" }` — update field on 3rd target
- `{ "path": "serving.api.0.warm", "value": true }` — update field on 1st route

**Locking:** Fields in `locked_fields` and items with `locked: true` (triggers, targets, routes, tools) cannot be modified.

**Restriction protection:** Agents cannot modify `restricted` or `restricted_methods` fields — these are owner-only security boundaries.

**Disallowed (immutable):** `adf_version`, `id`, `metadata`, `locked_fields`, `providers`

### sys_create_adf

**Parameters:** `name`, `location?`, `template?`, `files?`, `description?`, `instructions?`, `icon?`, `handle?`, `autonomous?`, `autostart?`, `start_in_state?`, `model?`, `context?`, `tools?`, `triggers?`, `security?`, `limits?`, `messaging?`, `audit?`, `code_execution?`, `logging?`, `mcp?`, `adapters?`, `serving?`, `providers?`, `ws_connections?`, `locked_fields?`, `card?`, `metadata?`

Create a new `.adf` file. Requires approval by default. Only `name` is required — all other parameters override defaults. The parameter schema has full parity with `AgentConfig`.

The new file is created in the same directory as the calling agent by default, or in the specified `location`. Config overrides are merged with defaults (tools by name, triggers deep-merged, metadata merged). The tool returns the new agent's name, ID, file path, and autostart status on success.

#### Autostart

When `autostart: true` is set, the child agent is immediately started as a background agent after creation — the child is working before the parent's turn ends. The tool result includes `Autostarted: true` to confirm. If the child requires a password (encrypted identity), autostart is skipped and `Autostarted: false` is returned. Setting `autostart` also means the agent will auto-start on subsequent runtime boots.

#### Template-Based Creation

Use `template` to specify a path to a `.adf` file stored in the calling agent's file store. The template's config and files become the starting point — any explicit parameters override on top. The child agent receives:

- **Fresh identity keys** — a new DID, public key, and private key are generated automatically
- **Preserved credentials** — non-signing identity rows (API keys, MCP credentials, adapter credentials) from the template are copied, provided they are stored as plaintext (encrypted rows from password-protected templates are skipped)
- **All template files** — copied to the child with their original protection levels

**Locked field enforcement:** The template's `locked_fields` and any `locked: true` flags on tools, triggers, trigger targets, and API routes are enforced during the merge. If an override targets a locked field or item, the tool returns an error without creating anything. Locked fields cannot be stripped by the creating agent — they carry forward to the child.

Config merge order: `AGENT_DEFAULTS → template config → explicit tool params`.

#### File Injection

Use `files` to copy files from the parent agent's file store into the new agent. Each entry is a `{ parent_path, child_path }` pair. If `child_path` already exists in the child (from the template or default creation), the file is overwritten unless it has `read_only` protection — in which case the tool returns an error. Overwrites preserve the existing file's protection level; new files get `none` protection.

#### Parent Lineage

When an agent creates a child via `sys_create_adf`, the parent's identity is recorded in the child's `adf_meta` table under the `adf_parent_did` key. If the parent has a cryptographic identity (DID), that is used; otherwise the parent's nanoid config ID is stored. This lineage is always set regardless of whether a template is used.

### sys_get_meta

**Parameters:** `key?`

Read metadata values from `adf_meta`. Pass a key to get just the value, or omit to list all entries as `key\tvalue` lines. Query `adf_meta` via `db_query` if you need protection levels.

### sys_set_meta

**Parameters:** `key`, `value`, `protection?`

Write a key-value pair to `adf_meta`. Creates the key if missing, overwrites if present.

Every key has a protection level that controls what the agent can do:

| Level | Read | Write | Delete | Description |
|-------|------|-------|--------|-------------|
| `none` | Yes | Yes | Yes | Fully mutable (default) |
| `readonly` | Yes | No | No | Agent cannot modify or delete |
| `increment` | Yes | Increment only | No | Value can only increase (must be numeric) |

Protection is set at creation time via the optional `protection` parameter and cannot be changed by the agent afterward. If omitted, defaults to `none`. The `protection` parameter is ignored when updating an existing key.

Increment validation: both the stored value and the new value are parsed as numbers. The write is rejected if either is not a valid number or if the new value is not greater than the current value.

**Authorized code bypass:** When called from [authorized code](authorized-code.md), `sys_set_meta` bypasses all protection checks — it can overwrite `readonly` keys, write non-incrementing values to `increment` keys, and set/change the `protection` level on existing keys. This gives authorized code the same privileges as the Studio UI.

### sys_delete_meta

**Parameters:** `key`

Delete a key from `adf_meta`. Blocked if the key's protection level is `readonly` or `increment`.

**Authorized code bypass:** When called from [authorized code](authorized-code.md), `sys_delete_meta` bypasses protection checks and can delete any key.

## Shell Tool

### shell

**Parameters:** `command`

A virtual shell that provides a bash-like interface, consolidating many individual tools into a single command-line experience. When the shell tool is enabled, it **absorbs** most filesystem, text, database, messaging, timer, code execution, and configuration tools — those tools are removed from the LLM's tool list and their functionality is accessed through shell commands instead.

**Supported syntax:** pipes (`|`), chaining (`&&`, `||`, `;`), redirects (`>`, `>>`, `<`), variables (`$VAR`, `${VAR}`), command substitution (`$(cmd)`), quoting, heredocs.

**Built-in commands by category:**

| Category | Commands |
|----------|----------|
| Filesystem | `cat`, `ls`, `rm`, `cp`, `mv`, `touch`, `find`, `du`, `chmod`, `head`, `tail` |
| Text | `grep`, `sed`, `sort`, `uniq`, `wc`, `cut`, `tr`, `tee`, `rev`, `tac`, `diff`, `xargs` |
| Data | `jq`, `sqlite3` |
| Messaging | `msg`, `who`, `ping` |
| Network | `curl` (`wget`) |
| Timers | `at`, `crontab` |
| Code | `node`, `./` |
| Process | `ps`, `kill`, `wait` |
| Identity | `whoami`, `config`, `status`, `meta`, `env`, `export`, `pwd`, `date` |
| General | `help`, `echo`, `true`, `false`, `sleep` |

Use `<command> -h` for detailed help on any command.

**Not supported:** background processes (`&`), subshells, glob expansion in arguments, arithmetic `$(())`, process substitution `<()`, if/for/while/case blocks (use `&&`/`||` chaining instead).

The shell runs in JavaScript (not real bash). The filesystem is flat (no real directories). When enabled, the system prompt automatically switches from individual tool guidance to a comprehensive shell guide.

## Enabling and Disabling Tools

In the Agent configuration panel, each tool has two independent toggles:

- **Enabled** — whether the tool exists for the agent at all, and the **only** gate on whether a call executes. A disabled tool cannot be called by the LLM, lambdas, or other code (the one exception: a disabled tool that is also `restricted` may still be called by authorized code).
- **Visible** — whether the tool is advertised in the LLM's tool schema. This controls only what the model is *shown*; it does **not** gate execution. An enabled tool is callable from the LLM loop whether or not it is visible.

These are separate flags. Toggling visibility off does not disable the tool and does not block the LLM from calling it — it only removes the tool from the advertised schema.

### Enabled Tool Guard

The runtime gates tool execution on `enabled` **only**. If the LLM calls a tool that is not enabled, the runtime **rejects the call** and returns an error to the model instead of executing it. Visibility is not part of this check: an enabled tool runs even when `visible: false` and absent from the advertised schema.

This is deliberate — because execution is decoupled from the advertised schema, you can present the model with **custom or simplified tool definitions** (different names, trimmed parameters, merged operations) and still have those calls dispatch to the underlying enabled tools. The schema the model sees and the set of tools it may call are separate concerns.

### Hiding Tools from the LLM (visibility)

Set `visible: false` on an enabled tool to remove it from the LLM's advertised schema while keeping it fully callable — both from code and from the LLM loop if the model invokes it by name (e.g. via a custom schema). This is the recommended way to expose a capability without surfacing it in the model's default tool list.

### Restricted Tools

Any tool can have `restricted: true`. This is the unified access control for gating a tool behind authorization. When a tool is restricted:

- **LLM loop calls** — if also `enabled`, the runtime creates a task in `adf_tasks` with `pending_approval` status and shows a confirmation dialog (HIL). The task can be approved via the UI dialog or externally via `task_resolve` (e.g., from an `on_task_create` trigger lambda).
- **Authorized code** — can call the tool directly without approval, regardless of `enabled`.
- **Unauthorized code** — always blocked.

#### Access Matrix

The **LLM loop** column below reflects calls the model actually makes. `visible` controls only whether a tool appears in the advertised schema (the "Advertised" column) — it never blocks execution, so an enabled tool the model invokes by name runs regardless of visibility.

| `enabled` | `visible` | `restricted` | Advertised | LLM loop | Authorized code | Unauthorized code |
|-----------|-----------|--------------|------------|----------|-----------------|-------------------|
| `false`   | —         | `false`      | No  | Off  | Off  | Off  |
| `false`   | —         | `true`       | No  | Off  | Free | Off  |
| `true`    | `false`   | `false`      | No  | Free | Free | Free |
| `true`    | `false`   | `true`       | No  | HIL  | Free | Off  |
| `true`    | `true`    | `false`      | Yes | Free | Free | Free |
| `true`    | `true`    | `true`       | Yes | HIL  | Free | Off  |

Key implications:

- **`enabled: true, visible: true, restricted: false`** — the common case. Advertised to the model and available to all code with no gates.
- **`enabled: true, visible: true, restricted: true`** — advertised; the LLM can use the tool but each call requires human approval. Authorized code bypasses the dialog.
- **`enabled: true, visible: false`** — not advertised in the model's tool list, but still callable from code, lambdas, and the LLM loop itself (e.g. via a custom schema). Restriction/HIL still apply if `restricted: true`.
- **`enabled: false, restricted: true`** — off for the LLM and unauthorized code, but authorized code can still call it. Useful for tools that should only be invoked programmatically from trusted lambdas.
- **`enabled: false, restricted: false`** — fully off. Nobody can call it.

#### Restricted Methods (Code Execution)

Code execution methods can be individually restricted via `code_execution.restricted_methods`. This works the same way: restricted methods can only be called from authorized code. From the LLM loop, calls to restricted methods get HIL automatically.

#### MCP Servers

MCP server tools use the same `restricted` flag. When an MCP tool has `restricted: true`, LLM loop calls require approval while authorized code can call freely.

## Tool Locking

Each tool has a `locked` flag that prevents the agent from modifying any of that tool's properties (including `enabled`) via `sys_update_config`. Use this to enforce tool configuration that the agent cannot change.

The lock icon appears in the Tools section of the agent config panel — hover over a tool row to reveal it, or click to toggle. Locked tools show an amber row tint and left border.

### Locking vs Restricting vs Disabling

These controls serve different purposes:

| Control | What it does | Who it affects | Agent can toggle? |
|---------|-------------|----------------|-------------------|
| **Enabled** | Tool exists and can be called by code | All callers | Yes (unless locked) |
| **Visible** | Tool is included in the LLM's active tool schema | LLM loop only | Yes (unless locked) |
| **Restricted** | Requires trust to call (HIL or authorized code) | All callers | No — owner only |
| **Locked** | Prevents agent from modifying this tool's config | Agent's `sys_update_config` | No — owner only |

**Important:** Disabling a tool without locking it is a *suggestion*, not a boundary. If `sys_update_config` is available, the agent can re-enable disabled tools. To enforce a tool being off, either lock it or disable `sys_update_config`.

### What agents can and cannot modify

Via `sys_update_config`:

- **Can modify:** `enabled` and `visible` (on any unlocked tool), and other unlocked config fields
- **Cannot modify:** `restricted`, `restricted_methods`, `locked`, `locked_fields` — these are owner-only security boundaries, blocked regardless of lock status

## Cross-Cutting Parameters

These reserved parameters (prefixed with `_`) modify tool behavior across tools. They are not part of individual tool schemas but are handled by the runtime.

### `_async`

Add `_async: true` to any tool call to execute it in the background. The tool returns immediately with a task reference. Available from both LLM tool calls and code execution. For restricted tools, the task is created with `pending_approval` status — the agent continues without blocking while approval is pending. See [Tasks](tasks.md) for details.

### `_full`

Add `_full: true` to bypass output limits on tools that truncate results. **Only available from code execution** (`sys_code`/`sys_lambda`) — the runtime strips this parameter from direct LLM tool calls to protect the context window.

This is designed for programmatic use cases where code needs to process more data than would fit in the LLM context. The result goes to your code, not the model.

Tools that support `_full`:

| Tool | Default Limit | With `_full: true` |
|------|---------------|---------------------|
| `db_query` | 500 row cap | Returns all rows |

Note: `fs_read` no longer needs `_full` — it always returns full content. Truncation is applied by the executor only when results go to the LLM context.

```javascript
// In sys_code or sys_lambda:
const allRows = await adf.db_query({ sql: 'SELECT * FROM local_events', _full: true })
```

## Default Tool Configuration

New agents come with these tools **enabled** by default:

- Turn tools: `respond`, `say`, `ask`
- Filesystem: `fs_read`, `fs_write`, `fs_list`
- Messaging: `msg_send`, `msg_read`, `msg_list`, `msg_update`, `agent_discover`
- Config: `sys_get_config`

The following are **disabled** by default:

- `fs_delete`, `db_query`, `db_execute`
- `loop_compact`, `loop_clear`
- `msg_delete`
- `sys_set_state`, `sys_code`, `sys_lambda`
- Timer tools: `sys_set_timer`, `sys_list_timers`, `sys_delete_timer`
- WebSocket tools: `ws_connect`, `ws_disconnect`, `ws_connections`, `ws_send`
- Stream binding tools: `stream_bind`, `stream_unbind`, `stream_bindings`
- `sys_update_config`, `sys_create_adf`
- Compute tools: `compute_exec` (also has `restricted: true`), `fs_transfer`
- `adf_shell`

## System Prompt & Tools

The system prompt is assembled dynamically based on which tools and features are enabled. Conditional prompt sections provide guidance that cannot be conveyed through tool schemas alone:

- **Tool Best Practices** — injected when shell is disabled (cross-tool workflow guidance)
- **Shell** — injected when shell is enabled (replaces Tool Best Practices)
- **Code Execution & Lambdas** — injected when `sys_code` or `sys_lambda` is enabled
- **Multi-Agent Collaboration** — injected when messaging is enabled
- **Database Schema** — injected when `db_query` or `db_execute` is enabled
- **HTTP Serving** — injected when serving features are configured

These sections are editable in **Settings > General > Tool Instructions**. See [Settings](settings.md#tool-instructions) for details.
