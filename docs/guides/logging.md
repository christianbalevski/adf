# Logging

ADF Studio writes structured log entries to the `adf_logs` table for runtime events — lambda executions, function calls, API serving requests, and trigger evaluations.

## Log Entry Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | INTEGER | Auto-incrementing entry ID |
| `level` | TEXT | `debug`, `info`, `warn`, or `error` |
| `origin` | TEXT | Source of the log (e.g., `timer`, `lambda`, `sys_lambda`, `serving`, `adf_shell`) |
| `event` | TEXT | Event category (e.g., `on_timer`, `api_request`, `execute`, `result`) |
| `target` | TEXT | Specific target (e.g., `system:lib/router.ts:onMessage`, `lib/api.ts:handler`) |
| `message` | TEXT | Human-readable log message |
| `data` | TEXT | Optional JSON payload with additional context |
| `created_at` | INTEGER | Unix timestamp (ms) |

## What Gets Logged

### Lambda and Trigger Executions

When a trigger fires and executes a lambda, the runtime logs:
- **execute** — Lambda started, with the trigger type and target
- **result** — Lambda completed, with duration and any return value

### Function Calls (`sys_lambda`)

Each `sys_lambda` tool invocation logs:
- **execute** — Function call started, with source file and arguments
- **result** — Function completed, with duration

### API Serving

When an agent serves HTTP requests:
- **api_request** — Incoming request with method, path, and query parameters
- **api_response** — Response sent with status code and duration

### Shell Commands

Shell tool executions log:
- **execute** — Command summary with duration
- **parse_error** — Parse failures
- **timeout** — Commands that exceeded the timeout

### Tool Calls

Tool-level logging includes:
- **sys_code** — Execution results and errors with duration
- **sys_fetch** — Middleware rejections, fetch errors, and timeouts
- **adf_call** — Sandbox-to-tool call routing with error categories (`EXCLUDED_TOOL`, `NOT_FOUND`, `DISABLED`, `REQUIRES_APPROVAL`, etc.)

### Mesh Delivery

Mesh message delivery logs:
- Local delivery failures
- HTTP delivery failures and non-2xx responses

### Console Output

Code running in the sandbox (via `sys_code`, `sys_lambda`, or lambdas) can write to logs using `console.log`, `console.warn`, and `console.error`. These appear as log entries with the appropriate level.

## Logging Configuration

The `logging` section in the agent config controls log filtering and retention. All filtering happens **before** the SQLite INSERT, so filtered entries incur zero I/O cost.

```json
{
  "logging": {
    "default_level": "info",
    "max_rows": 10000,
    "rules": [
      { "origin": "serving", "min_level": "error" },
      { "origin": "lambda*", "min_level": "warn" },
      { "origin": "adf_shell", "min_level": "info" }
    ]
  }
}
```

### Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `default_level` | string | `"info"` | Global minimum log level. Entries below this are dropped. |
| `max_rows` | number \| null | `10000` | Ring buffer size. Old entries are trimmed when this limit is exceeded. `null` = unlimited. |
| `rules` | array | `[]` | Per-origin overrides. First matching rule wins. |

### Rules

Each rule has:
- **`origin`** — Glob pattern matched against the log entry's origin (e.g., `"serving"`, `"lambda*"`, `"sys_*"`)
- **`min_level`** — Minimum level to keep for matching origins (`debug`, `info`, `warn`, `error`)

Rules are evaluated in order — the **first match wins**. If no rule matches, `default_level` applies.

### Ring Buffer

The `adf_logs` table acts as a ring buffer. When `max_rows` is set, old entries are automatically trimmed. The trim runs every 100 inserts (amortized) to avoid per-insert overhead.

For high-throughput agents (e.g., relay ADFs handling 1k+ requests/second), set a restrictive `default_level` and/or lower `max_rows` to prevent the log table from becoming a bottleneck. Set `max_rows: null` for unlimited retention — useful when a custom lambda handles cleanup via the `on_logs` trigger.

### Configuring at Runtime

Use `sys_update_config` to modify logging settings:

```json
// Set default level
{ "path": "logging.default_level", "value": "warn" }

// Set per-origin rules
{ "path": "logging.rules", "value": [
  { "origin": "serving", "min_level": "error" }
]}

// Set max rows (null for unlimited)
{ "path": "logging.max_rows", "value": 50000 }
```

## on_logs Trigger

The `on_logs` [trigger](triggers.md) fires when a matching log entry is written. This enables reactive patterns — alerting, log forwarding, anomaly detection — without polling.

```json
{
  "on_logs": {
    "enabled": true,
    "targets": [
      {
        "scope": "system",
        "lambda": "lib/alerter.ts:onError",
        "filter": { "level": ["error"] },
        "batch_ms": 5000,
        "batch_count": 10
      }
    ]
  }
}
```

### Anti-Recursion

Log entries produced by the `on_logs` trigger handler itself do **not** re-fire the trigger. This prevents infinite loops.

### Filter Fields

| Field | Type | Description |
|-------|------|-------------|
| `level` | string[] | Match log levels (e.g., `["warn", "error"]`) |
| `origin` | string[] | Glob patterns for origin (e.g., `["serving", "lambda*"]`) |
| `event` | string[] | Glob patterns for event (e.g., `["api_*"]`) |

### Lambda Event Object

When `on_logs` fires in system scope, the lambda receives:

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | `"log_entry"` |
| `scope` | string | `"system"` |
| `timestamp` | number | Event timestamp (epoch ms) |
| `content` | string | Log message |
| `logLevel` | string | Log level (`debug`, `info`, `warn`, `error`) |
| `logOrigin` | string \| null | Log origin |
| `logEvent` | string \| null | Log event |
| `logTarget` | string \| null | Log target |

## Querying Logs

Use `db_query` to inspect logs:

```sql
-- Recent errors
SELECT * FROM adf_logs WHERE level = 'error' ORDER BY id DESC LIMIT 20

-- All logs from a specific origin
SELECT * FROM adf_logs WHERE origin LIKE 'agent:Monitor%' ORDER BY id DESC

-- API serving activity
SELECT * FROM adf_logs WHERE event IN ('api_request', 'api_response') ORDER BY id DESC LIMIT 50

-- Logs after a specific ID (for polling)
SELECT * FROM adf_logs WHERE id > 1000 ORDER BY id ASC
```

## Log Schema

The `adf_logs` table has indexes on `level` and `origin` for efficient filtering.

```sql
CREATE TABLE adf_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL DEFAULT 'info',
  origin TEXT,
  event TEXT,
  target TEXT,
  message TEXT NOT NULL,
  data TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_adf_logs_level ON adf_logs(level);
CREATE INDEX idx_adf_logs_origin ON adf_logs(origin);
```

## UI

The **Logs** tab in the [Bottom Panel](settings.md#bottom-panel-logs--tasks) provides level and origin filtering, expandable JSON data payloads, and auto-refresh polling. Logs reload automatically when switching between ADF files.
