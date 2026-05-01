# The adf Proxy Object

The `adf` object is a global Proxy available in every [code execution context](code-execution.md). Any property access on `adf` returns an async function that sends an RPC call to the main thread, where the corresponding tool is executed and the result returned.

## Calling Convention

Every `adf.*` call follows three rules:

1. **Single object argument** — Pass one object with named parameters
2. **Always await** — All calls are asynchronous and return Promises
3. **Tool names match exactly** — Use the same names as the built-in tools

```javascript
// Correct
const result = await adf.fs_read({ path: 'config.json' })
const text = result.content
await adf.fs_write({ path: 'output.txt', content: 'hello' })

// Wrong — multiple arguments
const data = await adf.fs_read('config.json')

// Wrong — not awaited (fires and forgets, errors silently lost)
adf.fs_write({ path: 'output.txt', content: 'hello' })
```

Tool results are automatically parsed from JSON. If the result is a JSON string, it's parsed into an object. If parsing fails, the raw string is returned.

## Filesystem (`fs_*`)

### fs_read

Read a file from the virtual filesystem. Returns an object with the full file record.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | File path |
| `start_line` | number | No | Start line (1-based) for text files |
| `end_line` | number | No | End line (inclusive) for text files |

**Return shape:** `{ path, content, mime_type, size, protection, created_at, updated_at }`

- Text files: `content` is the raw text string
- Binary files: `content` is a base64-encoded string
- Media files (images, audio, video): `content` is base64-encoded. When the corresponding `model.multimodal` modality is enabled, the executor sends a native content block (`image_url`, `input_audio`, or `video_url`) to the LLM alongside the JSON row so the agent can perceive the media. Media blocks are ephemeral (not persisted to `adf_loop`). When disabled, or the file exceeds the size limit, the JSON row is returned with `content: null`. See [Multimodal](../ADF_STUDIO_DOCS.md#multimodal) for details.
- `document.md` / `mind.md`: synthesized record with `protection: 'no_delete'`

From code execution, `fs_read` always returns full content with no truncation. When called from the LLM, the executor applies context-window guards (token limit, large file preview).

```javascript
const result = await adf.fs_read({ path: 'document.md' })
const text = result.content  // raw text
const lines = await adf.fs_read({ path: 'data.csv', start_line: 1, end_line: 100 })
const slicedText = lines.content
const img = await adf.fs_read({ path: 'image.png' })
const base64 = img.content  // base64-encoded binary
```

### fs_write

Create, overwrite, or edit a file.

**Write mode** — provide `content`:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | File path |
| `content` | string or Buffer | Yes | File content (Buffer for binary, string for text) |
| `protection` | string | No | `"read_only"`, `"no_delete"`, or `"none"` |
| `encoding` | string | No | `"base64"` when content is a base64-encoded string |
| `mime_type` | string | No | MIME type for binary files |

When `content` is a `Buffer` (e.g. from `sys_fetch`), the file is written as binary automatically — no `encoding` or `mime_type` parameters needed.

**Edit mode** — provide `old_text` + `new_text`:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | File path |
| `old_text` | string | Yes | Text to find (must match exactly once) |
| `new_text` | string | Yes | Replacement text |

```javascript
// Write a text file
await adf.fs_write({ path: 'data/report.json', content: JSON.stringify(report, null, 2) })

// Write a binary file (Buffer from sys_fetch)
const resp = await adf.sys_fetch({ url: 'https://example.com/image.png' })
await adf.fs_write({ mode: 'write', path: 'image.png', content: resp.body })

// Edit in-place
await adf.fs_write({
  path: 'document.md',
  old_text: '## Status: Draft',
  new_text: '## Status: Published'
})
```

### fs_list

List files in the virtual filesystem.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prefix` | string | No | Path prefix filter (e.g., `"lib/"`) |

```javascript
const files = await adf.fs_list({})
const libFiles = await adf.fs_list({ prefix: 'lib/' })
```

### fs_delete

Delete a file.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | File path to delete |

```javascript
await adf.fs_delete({ path: 'temp/scratch.txt' })
```

## Messaging (`msg_*`)

### msg_send

Send a message to another agent. Two modes:

**Direct send** — provide `recipient` (DID) + `address` (delivery URL):

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `recipient` | string | Yes* | Recipient DID (e.g., `"did:adf:..."`) or adapter address (e.g., `"telegram:123"`) |
| `address` | string | Yes* | Delivery URL. Not needed for adapter recipients. |
| `payload` | string | Yes | Message content |
| `intent` | string | No | Message intent |
| `trace_id` | string | No | Trace ID for threading |
| `parent_id` | string | No | Parent message ID |
| `attachments` | string[] | No | File paths to attach |

*Not required when `parent_id` is provided — the runtime resolves recipient and address from the referenced inbox message.

**Reply via parent_id** — provide `parent_id` + `payload`:

```javascript
// Direct send
await adf.msg_send({
  recipient: 'did:adf:9gvayMZx5m...',
  address: 'http://127.0.0.1:7295/mesh/monitor/messages',
  payload: 'Health check passed'
})

// Reply to an inbox message (runtime resolves recipient + address)
await adf.msg_send({ parent_id: 'inbox-abc123', payload: 'Acknowledged' })

// Adapter send (no address needed)
await adf.msg_send({ recipient: 'telegram:123456', payload: 'Hello from ADF' })
```

### msg_read

Read messages from the inbox.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `limit` | number | No | Max messages to return |
| `status` | string | No | Filter: `"unread"`, `"read"`, `"archived"` |

```javascript
const unread = await adf.msg_read({ status: 'unread', limit: 10 })
```

### msg_update

Update message status.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ids` | string[] | Yes | Message IDs to update |
| `status` | string | Yes | New status: `"read"` or `"archived"` |

```javascript
await adf.msg_update({ ids: ['msg_abc123'], status: 'archived' })
```

### msg_list

Get inbox message counts by status.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `status` | string | No | Filter by status |

```javascript
const counts = await adf.msg_list({})
```

### agent_discover

Discover agents on the mesh.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `include_subdirectories` | boolean | No | Include agents in subdirectories |

```javascript
const agents = await adf.agent_discover({})
```

### msg_delete

Delete messages from inbox or outbox.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `source` | string | Yes | `"inbox"` or `"outbox"` |
| `filter` | object | Yes | At least one filter field required |

Filter fields: `status`, `sender`, `before` (epoch ms), `trace_id`.

```javascript
await adf.msg_delete({ source: 'inbox', filter: { status: 'archived' } })
```

## Database (`db_*`)

### db_query

Execute a read-only SELECT statement.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sql` | string | Yes | SELECT statement |
| `params` | array | No | Bound parameters |

Can query `local_*` tables and most `adf_*` tables. Cannot query `adf_meta`, `adf_config`, or `adf_identity`. Results are capped at 500 rows by default — use `LIMIT` or [`_full: true`](#full-output-_full) from code to get more.

```javascript
const rows = await adf.db_query({ sql: 'SELECT * FROM local_metrics WHERE ts > ?', params: [Date.now() - 3600000] })
const allRows = await adf.db_query({ sql: 'SELECT * FROM local_events', _full: true }) // code execution only
```

### db_execute

Execute INSERT, UPDATE, DELETE, or CREATE TABLE on `local_*` tables.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sql` | string | Yes | SQL statement |
| `params` | array | No | Bound parameters |

```javascript
await adf.db_execute({
  sql: 'CREATE TABLE IF NOT EXISTS local_events (id TEXT PRIMARY KEY, data TEXT, ts INTEGER)'
})
await adf.db_execute({
  sql: 'INSERT INTO local_events (id, data, ts) VALUES (?, ?, ?)',
  params: ['evt_1', '{"type":"click"}', Date.now()]
})
```

## System (`sys_*`)

### sys_code

Execute code in the persistent sandbox. Has access to [standard library packages](code-execution.md#standard-library-packages) (xlsx, pdf-lib, mupdf, docx, jszip, sql.js, cheerio, yaml, date-fns, jimp) via standard `import` syntax.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `code` | string | Yes | Code to execute |
| `language` | string | No | Language hint (default: `"javascript"`) |
| `timeout` | number | No | Timeout in ms (max 300000) |

### sys_lambda

Call a function from a workspace file.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `source` | string | Yes | `"path/file.ts:functionName"` (defaults to `main` if no function specified) |
| `args` | object | No | Arguments passed to the function |

```javascript
const result = await adf.sys_lambda({ source: 'lib/math.ts:add', args: { a: 1, b: 2 } })
```

**Authorization behavior:** When called from the LLM loop targeting an [authorized file](authorized-code.md), the runtime triggers a HIL approval prompt. If approved, the lambda runs with authorization and can call restricted tools/methods. If the target is not authorized, it runs normally with no prompt. From code execution, unauthorized callers cannot call authorized targets (`REQUIRES_AUTHORIZED_CALLER`); authorized callers propagate authorization based on the target file's flag.

### sys_fetch

Make an HTTP request.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | Yes | URL to fetch |
| `method` | string | No | HTTP method (default: `"GET"`) |
| `headers` | object | No | Request headers |
| `body` | string | No | Request body |
| `timeout_ms` | number | No | Timeout in ms (default: 30000, max: 60000) |

Response bodies are capped at 25 MB. The `body` field type depends on the response `Content-Type`:

- **Text** (`text/*`, `application/json`, `application/xml`, `*+json`, `*+xml`) — `body` is a `string`
- **Binary** (everything else) — `body` is a `Buffer`

```javascript
// Text response — body is a string
const res = await adf.sys_fetch({ url: 'https://api.example.com/data' })
const parsed = JSON.parse(res.body)

// Binary response — body is a Buffer, write directly to a file
const audio = await adf.sys_fetch({ url: 'https://api.example.com/tts', method: 'POST', ... })
await adf.fs_write({ mode: 'write', path: 'output.mp3', content: audio.body })
```

### sys_set_state

Transition the agent to a new state.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `state` | string | Yes | `"idle"`, `"hibernate"`, or `"off"` |

**Behavior from a lambda:**
- `"idle"` and `"hibernate"` apply immediately if the executor is idle, or at end-of-turn if a turn is in progress.
- `"off"` is **never deferred**. It aborts any in-flight LLM call, clears pending triggers, and fires the centralized hard-off teardown (mesh unregister, MCP disconnect, adapters stopped, code sandbox destroyed). Use this when implementing remote shutdown — a compromised child cannot keep running for the remainder of its turn.

See [Agent States](agent-states.md) for the full lifecycle and [Triggers](triggers.md) for system-scope lambda examples including parent-controlled shutdown.

### sys_get_config

Returns the full agent configuration (no parameters needed).

```javascript
const config = await adf.sys_get_config({})
```

### sys_update_config

Modify agent configuration using a dot-path. See [Tools > sys_update_config](tools.md#sys_update_config) for the path-based API (basic field updates, array operations, and numeric path indexing).

### sys_create_adf

Create a new `.adf` file. Supports template-based creation (pass `template` path to a `.adf` in the file store) and file injection (pass `files` array of `{ parent_path, child_path }` pairs). See [Tools > sys_create_adf](tools.md#sys_create_adf) for the full parameter list.

```javascript
// Basic creation
await adf.sys_create_adf({ name: 'worker-1', instructions: 'You are a worker agent.' })

// Template-based creation with file injection
await adf.sys_create_adf({
  name: 'worker-2',
  template: 'templates/worker.adf',
  files: [
    { parent_path: 'config/prompts.md', child_path: 'prompts.md' }
  ],
  model: { temperature: 0.5 }  // overrides template's model.temperature
})
```

## Timer Tools

### sys_set_timer

Create a timer. Requires a `schedule` object with a `type` discriminator and a `scope` array.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `schedule` | object | Yes | Schedule config — see `schedule.type` values below |
| `scope` | string[] | Yes | `["system"]`, `["agent"]`, or `["system", "agent"]` |
| `payload` | string | No | String passed to handler on fire |
| `lambda` | string | No | System scope: script entry point |
| `warm` | boolean | No | System scope: keep worker alive |

**`schedule.type` values:**

| Type | Required field | Optional fields |
|------|---------------|-----------------|
| `"once"` | `at` (Unix ms) | — |
| `"delay"` | `delay_ms` (ms) | — |
| `"interval"` | `every_ms` (ms) | `start_at`, `end_at`, `max_runs` |
| `"cron"` | `cron` (5-field expr) | `end_at`, `max_runs` |

```javascript
await adf.sys_set_timer({
  schedule: { type: 'interval', every_ms: 60000 },
  scope: ['system'],
  lambda: 'lib/monitor.ts:checkHealth',
  warm: true,
  payload: 'health_check'
})
```

### sys_list_timers

List all active timers (no parameters needed).

```javascript
const timers = await adf.sys_list_timers({})
```

### sys_delete_timer

Delete a timer.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Timer ID |

```javascript
await adf.sys_delete_timer({ id: 'timer_abc123' })
```

## Loop Management

### loop_compact

Trigger LLM-powered loop compaction (no parameters needed).

```javascript
await adf.loop_compact({})
```

### loop_clear

Delete loop entries using Python-style slicing.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `start` | number | No | Start index (supports negative) |
| `end` | number | No | End index (supports negative) |

```javascript
await adf.loop_clear({ end: -5 }) // Clear all except last 5
```

## Special Methods

These methods are available in code execution (`sys_code`/`sys_lambda`) via the `adf` proxy. They are not regular tools — they don't appear in the LLM's tool list or the Tools config section. Instead, they are controlled independently via the **Code Execution** config section in the agent panel. All are enabled by default.

### model_invoke

Make a direct LLM call using a messages array (chat completion format). No tools or streaming.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `messages` | array | Yes | Array of message objects with `role` and `content` |
| `model` | string | No | Model ID override (e.g., `"anthropic/claude-haiku-3-5-20241022"`) |
| `max_tokens` | number | No | Max response tokens (default: from agent config, fallback 4096) |
| `temperature` | number | No | Sampling temperature (default: from agent config, fallback 0.7) |
| `top_p` | number | No | Top-p sampling (default: from agent config) |

Each message object has:

| Field | Type | Description |
|-------|------|-------------|
| `role` | string | `"system"`, `"user"`, or `"assistant"` |
| `content` | string or array | Text string, or array of content blocks (see below) |

Each content block in the array can be:

- `{ type: "text", text: "..." }` — a text block
- `{ type: "image_url", image_url: { url: "data:<mime>;base64,<data>" } }` — an inline image (requires a vision-capable model)

System messages must appear at the start of the array, before any user/assistant messages.

Returns raw text (not JSON-parsed).

```javascript
// Simple single-turn call
const summary = await adf.model_invoke({
  messages: [{ role: 'user', content: 'Summarize this in one sentence: ' + longText }],
  max_tokens: 256,
  temperature: 0.3
})

// With a system prompt
const french = await adf.model_invoke({
  messages: [
    { role: 'system', content: 'Respond in French' },
    { role: 'user', content: 'Hello, how are you?' }
  ]
})

// Multi-turn conversation
const response = await adf.model_invoke({
  messages: [
    { role: 'user', content: 'What is 2+2?' },
    { role: 'assistant', content: '4' },
    { role: 'user', content: 'Multiply that by 3' }
  ]
})

// Model override — use a different model for this call
const fast = await adf.model_invoke({
  messages: [{ role: 'user', content: 'Quick classification: is this spam?' }],
  model: 'anthropic/claude-haiku-3-5-20241022'
})
```

### task_resolve

Approve, deny, or escalate a task. For HIL tasks (`executor_managed: true`), approval signals the executor to proceed. For deferred tasks, approval executes the tool directly.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task_id` | string | Yes | The task ID to resolve |
| `action` | string | Yes | `"approve"`, `"deny"`, or `"pending_approval"` |
| `reason` | string | No | Reason for denial |
| `modified_args` | object | No | Modified tool arguments (for approve) |
| `requires_authorization` | boolean | No | Set to `true` to require [authorized code](authorized-code.md) for future approve/deny (one-way, cannot be unset) |

```javascript
await adf.task_resolve({ task_id: 'task_abc123', action: 'approve' })
await adf.task_resolve({ task_id: 'task_def456', action: 'deny', reason: 'Rate limit exceeded' })
await adf.task_resolve({ task_id: 'task_ghi789', action: 'pending_approval', requires_authorization: true })
```

When `requires_authorization` is set, only authorized code can subsequently approve or deny the task. Setting to `pending_approval` is always allowed from any code. Tool side effects (e.g., `sys_set_state` state transitions) are propagated when the task is approved.

### sys_lambda

Available as a special method even when the `sys_lambda` tool is not in the agent's tool list. See [sys_lambda](#sys_lambda) above.

### loop_inject

Inject a `[Context: loop_inject]` entry into the loop. Only available from code execution — not exposed as an LLM tool.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `content` | string | Yes | Content to inject (stored as `[Context: loop_inject] <content>`) |

Useful for lambdas and triggers that need to programmatically add context (summaries, state snapshots, trigger outputs) to the conversation history. The entry uses the existing `[Context: ...]` format, so the loop parser and UI handle it automatically.

```javascript
await adf.loop_inject({ content: 'inbox_summary: 3 unread messages from monitor' })
```

### get_identity

Read a value from the agent's `adf_identity` table. Only available from code execution — not exposed as an LLM tool.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `purpose` | string | Yes | The identity key to look up |

Returns the raw value as a string. Returns an error if the key doesn't exist or `code_access` is disabled for that key.

**Security boundary:** `get_identity` only reads from `adf_identity` — it never falls back to app-level settings. Runtime/app-level provider keys (used by `model_invoke` via server-side injection) are never exposed to agent code. If the agent needs raw API access (e.g. for audio APIs), the user must store a key in the agent's identity store with `code_access` enabled.

```javascript
// Read an API key stored in identity with code_access enabled
const apiKey = await adf.get_identity({ purpose: 'provider:openrouter:apiKey' })

// Use it with sys_fetch for direct API calls
const resp = await adf.sys_fetch({
  url: 'https://openrouter.ai/api/v1/chat/completions',
  method: 'POST',
  headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'openai/gpt-4o-audio-preview', messages: [...] })
})
```

### set_meta_protection

Change the protection level of a meta key. Only available from [authorized code](authorized-code.md).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `key` | string | Yes | The meta key |
| `protection` | string | Yes | `"none"`, `"readonly"`, or `"increment"` |

Returns an error if the key doesn't exist.

```javascript
// Lock a key after writing it
await adf.sys_set_meta({ key: 'deployment_version', value: '2.1.0' })
await adf.set_meta_protection({ key: 'deployment_version', protection: 'readonly' })

// Unlock a key for update, then re-lock
await adf.set_meta_protection({ key: 'adf_name', protection: 'none' })
await adf.sys_set_meta({ key: 'adf_name', value: 'New Name' })
await adf.set_meta_protection({ key: 'adf_name', protection: 'readonly' })
```

### set_file_protection

Change the protection level of a file. Only available from [authorized code](authorized-code.md).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | File path |
| `protection` | string | Yes | `"none"`, `"read_only"`, or `"no_delete"` |

Returns an error if the file doesn't exist.

```javascript
// Lock a config file after deployment
await adf.set_file_protection({ path: 'config/production.json', protection: 'read_only' })

// Temporarily unlock for patching
await adf.set_file_protection({ path: 'lib/handler.ts', protection: 'none' })
await adf.fs_write({ path: 'lib/handler.ts', content: updatedCode })
await adf.set_file_protection({ path: 'lib/handler.ts', protection: 'read_only' })
```

### Authorized Meta/File Bypass

When called from authorized code, the following tools bypass all protection checks — same privilege as the Studio UI:

- `sys_set_meta` / `sys_delete_meta` — overwrite `readonly` keys, write non-incrementing values to `increment` keys, delete protected keys.
- `fs_write` — overwrite `read_only` files.
- `fs_delete` — delete `read_only` or `no_delete` files.

From unauthorized code (including `sys_code`), protection is enforced normally.

```javascript
// From authorized code — works even though adf_name is readonly
await adf.sys_set_meta({ key: 'adf_name', value: 'Renamed Agent' })

// From authorized code — works even though the file is read_only
await adf.fs_write({ path: 'locked-config.json', content: '...', mode: 'write' })

// From unauthorized code — returns error: Cannot write to "adf_name": key is readonly.
await adf.sys_set_meta({ key: 'adf_name', value: 'Renamed Agent' })
```

## Async Execution (`_async`)

Any tool call can be made asynchronous by adding `_async: true` to the arguments. The tool executes in the background and returns immediately with a task reference. For restricted tools, the task is created with `pending_approval` status — the caller continues without blocking while approval is pending.

```javascript
const task = await adf.msg_send({
  recipient: 'did:adf:9gvayMZx5m...',
  address: 'http://127.0.0.1:7295/mesh/monitor/messages',
  payload: 'Large dataset ready',
  _async: true
})
// task = { task_id: "task_xxxxxxxxxxxx", status: "running", tool: "msg_send" }
```

Use `db_query` to check task status:

```javascript
const result = await adf.db_query({
  sql: 'SELECT status, result, error FROM adf_tasks WHERE id = ?',
  params: [task.task_id]
})
```

Async tasks are tracked in the `adf_tasks` table and can trigger `on_task_complete` events.

## Full Output (`_full`)

Some tools truncate their output to protect the LLM context window. When calling these tools from code execution, you can add `_full: true` to bypass all output limits and get the complete result.

Unlike `_async`, `_full` is **only available from code execution** — the runtime strips it from direct LLM tool calls.

| Tool | Default Limit | With `_full: true` |
|------|---------------|---------------------|
| `db_query` | 500 row cap | Returns all rows |

Note: `fs_read` no longer needs `_full` — it always returns full content from code execution. Truncation is applied by the executor only when results go to the LLM context.

```javascript
// Read a large file — fs_read always returns full content from code
const result = await adf.fs_read({ path: 'data/export.csv' })
const lines = result.content.split('\n')

// Process every row in a large table
const rows = await adf.db_query({
  sql: 'SELECT * FROM local_events',
  _full: true
})
for (const row of rows) {
  // process each row...
}
```

This is safe because the result goes to your code, not the LLM context. Use it when you need to programmatically process data that exceeds the agent's token limits.

## Error Handling

When a tool call fails, the `adf` proxy throws an error with a `code` property. Catch errors to handle them gracefully:

```javascript
try {
  await adf.fs_read({ path: 'missing.txt' })
} catch (err) {
  console.error(err.code)    // 'TOOL_ERROR'
  console.error(err.message) // 'File not found: missing.txt'
}
```

### Error Codes

| Code | Description |
|------|-------------|
| `NOT_FOUND` | Tool does not exist or is not declared in agent config |
| `DISABLED` | Tool exists but is disabled in agent config |
| `REQUIRES_AUTHORIZED_CODE` | Tool is `restricted` — cannot be called from unauthorized code |
| `TOOL_ERROR` | Tool executed but returned an error |
| `CIRCULAR_CALL` | `sys_lambda` A called B which called A |
| `EXCLUDED_TOOL` | Tool cannot be called from code (`say`, `ask`) |
| `FN_ERROR` | `sys_lambda` execution failed |
| `INVALID_INPUT` | Missing or invalid parameters |
| `INVALID_STATE` | Task is not in a resolvable state |
| `MODEL_ERROR` | `model_invoke` LLM call failed |
| `MODEL_REFUSED` | `model_invoke` returned empty content |
| `INTERNAL_ERROR` | Unexpected runtime error |
| `WRITE_ERROR` | Database write failed (e.g., `set_meta_protection`, `set_file_protection`) |
| `MESH_NOT_ENABLED` | Mesh tools (`msg_send`, `agent_discover`) require the mesh to be enabled |
| `TIMEOUT` | Execution exceeded the timeout |

## Excluded Tools

The following tools **cannot** be called from code:

- `say` — Turn tool, only meaningful in the LLM loop
- `ask` — Requires human interaction, only works in the LLM loop
