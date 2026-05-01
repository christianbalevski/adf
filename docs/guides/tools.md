# Tools

Tools are the capabilities available to an agent during its LLM loop. Each tool has two access controls: `enabled` (visible to the LLM) and `restricted` (limits access to authorized code, with HIL for loop calls).

## Tool Categories

ADF provides tools organized into these categories:

- [Turn Tools](#turn-tools) — Emitting text and controlling conversation flow
- [Filesystem Tools](#filesystem-tools) — Reading, writing, and managing files
- [Database Tools](#database-tools) — Querying and modifying local tables
- [Messaging Tools](#messaging-tools) — Sending and receiving inter-agent messages
- [WebSocket Tools](#websocket-tools) — Managing persistent WebSocket connections
- [Execution Tools](#execution-tools) — Running code and scripts
- [Function Call Tool](#function-call-tool) — Calling agent-authored functions
- [Package Management Tools](#package-management-tools) — Installing npm packages for the sandbox
- [Timer Tools](#timer-tools) — Scheduling events
- [Loop Management Tools](#loop-management-tools) — Managing conversation history
- [Message Deletion Tools](#message-deletion-tools) — Cleaning up inbox and outbox
- [Archive Tools](#archive-tools) — Reading archived data snapshots
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

**Parameters:** `connection_id`, `data`

Send text data as a single frame over an active WebSocket connection.

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

**Parameters:** *(none — signal-only tool)*

Trigger LLM-powered loop compaction. When called, the runtime:

1. Makes a dedicated LLM call to summarize the full conversation transcript
2. Deletes old loop entries (archived first if archiving is enabled)
3. Inserts the LLM-generated summary as a `[Loop Compacted]` message
4. Token counter is reset

The agent does not need to provide a summary — the compaction LLM generates a structured briefing with specific details (file paths, decisions, pending work) organized by topic. A compaction banner appears in the UI. The archive label only appears when loop archiving is enabled.

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

### loop_read

**Parameters:** `limit?`, `offset?`

Read loop history entries. Returns recent entries by default. Useful for reviewing past conversation turns.

### loop_stats

Returns loop statistics: row count, estimated tokens, and oldest entry timestamp. Helps the agent decide when to compact.

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

## Archive Tools

### archive_read

**Parameters:** `id`

Read and decompress an archive entry by ID. Returns the original JSON data (loop entries, inbox messages, or outbox messages) that was archived.

To list available archives, use `db_query`:

```sql
SELECT id, source, entry_count, size_bytes, created_at FROM adf_audit
```

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

**Numeric path segments** index into arrays:

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

In the Agent configuration panel, each tool has a toggle to enable or disable it. Disabled tools are not presented to the LLM and cannot be called.

### Disabled Tool Guard

If the LLM attempts to call a tool that is not in the agent's enabled set, the runtime **rejects the call** and returns an error to the model instead of executing it. This provides a hard enforcement layer beyond just omitting tools from the tool list.

### Restricted Tools

Any tool can have `restricted: true`. This is the unified access control that replaces the old `require_approval` and `security.require_authorized` system. When a tool is restricted:

- **LLM loop calls** — if also `enabled`, the runtime creates a task in `adf_tasks` with `pending_approval` status and shows a confirmation dialog (HIL). The task can be approved via the UI dialog or externally via `task_resolve` (e.g., from an `on_task_create` trigger lambda).
- **Authorized code** — can call the tool directly without approval, regardless of `enabled`.
- **Unauthorized code** — always blocked.

#### Access Matrix

| `enabled` | `restricted` | LLM loop | Authorized code | Unauthorized code |
|-----------|--------------|----------|-----------------|-------------------|
| `false`   | `false`      | Off      | Off             | Off               |
| `true`    | `false`      | Free     | Free            | Free              |
| `false`   | `true`       | Off      | Free            | Off               |
| `true`    | `true`       | HIL      | Free            | Off               |

Key implications:

- **`enabled: true, restricted: false`** — the common case. Tool is available to the LLM and all code with no gates.
- **`enabled: true, restricted: true`** — the LLM can use the tool but each call requires human approval. Authorized code bypasses the dialog.
- **`enabled: false, restricted: true`** — invisible to the LLM, but authorized code can still call it. Useful for tools that should only be invoked programmatically from trusted lambdas.
- **`enabled: false, restricted: false`** — fully off. Nobody can call it.

#### Restricted Methods (Code Execution)

Code execution methods can be individually restricted via `code_execution.restricted_methods`. This works the same way: restricted methods can only be called from authorized code. From the LLM loop, calls to restricted methods get HIL automatically.

#### MCP Servers

MCP server tools use the same `restricted` flag. When an MCP tool has `restricted: true`, LLM loop calls require approval while authorized code can call freely.

## Tool Locking

Each tool has a `locked` flag that prevents the agent from modifying any of that tool's properties (including `enabled`) via `sys_update_config`. Use this to enforce tool configuration that the agent cannot change.

The lock icon appears in the Tools section of the agent config panel — hover over a tool row to reveal it, or click to toggle. Locked tools show an amber row tint and left border.

### Locking vs Restricting vs Disabling

These three controls serve different purposes:

| Control | What it does | Who it affects | Agent can toggle? |
|---------|-------------|----------------|-------------------|
| **Enabled** | Tool appears in LLM tool list | LLM loop visibility | Yes (unless locked) |
| **Restricted** | Requires trust to call (HIL or authorized code) | All callers | No — owner only |
| **Locked** | Prevents agent from modifying this tool's config | Agent's `sys_update_config` | No — owner only |

**Important:** Disabling a tool without locking it is a *suggestion*, not a boundary. If `sys_update_config` is available, the agent can re-enable disabled tools. To enforce a tool being off, either lock it or disable `sys_update_config`.

### What agents can and cannot modify

Via `sys_update_config`:

- **Can modify:** `enabled` (on any unlocked tool), and other unlocked config fields
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
- `loop_compact`, `loop_clear`, `loop_read`, `loop_stats`
- `msg_delete`, `archive_read`
- `sys_set_state`, `sys_code`, `sys_lambda`
- Timer tools: `sys_set_timer`, `sys_list_timers`, `sys_delete_timer`
- WebSocket tools: `ws_connect`, `ws_disconnect`, `ws_connections`, `ws_send`
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
