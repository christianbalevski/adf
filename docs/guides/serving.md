# HTTP Serving

ADF agents can serve content over HTTP through the mesh server. When the mesh is enabled, each agent with a `handle` gets a URL at `http://{host}:{port}/{handle}/` where it can serve static files, expose shared workspace files, and run API endpoints backed by sandboxed JavaScript lambdas.

## Overview

The mesh server (Fastify on port 7295 by default) mounts every servable agent at `/{handle}/`. Three serving modes can be combined:

| Mode | Purpose | Configuration |
|------|---------|---------------|
| **Public** | Serve static files from `public/` folder | `serving.public` |
| **Shared** | Expose workspace files matching glob patterns | `serving.shared` |
| **API** | Run JavaScript lambda functions on HTTP requests | `serving.api` |

Request resolution order: API routes → public files → shared files → 404. The `messages` path is reserved for the [message receive endpoint](messaging.md#message-receive-endpoint).

## Prerequisites

1. **Mesh enabled** — Toggle mesh on in **Settings > Web** or the sidebar
2. **Agent running** — The agent must be started (foreground or background)
3. **Handle set** — The agent needs a URL handle (defaults to the filename if not set)

## Agent Handle

The handle is the URL slug that identifies your agent on the mesh. Configure it in **Agent Config > Serving > Handle**.

- Defaults to the `.adf` filename (lowercased, sanitized)
- Must be URL-safe: lowercase letters, numbers, and hyphens
- Must be unique across all agents on the mesh
- Example: handle `my-app` → URL `http://127.0.0.1:7295/my-app/`

## Public Folder

When `serving.public` is enabled, files in the `public/` directory of the agent's workspace are served as static content.

### Configuration

```json
{
  "serving": {
    "public": {
      "enabled": true,
      "index": "index.html"
    }
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | — | Enable/disable public folder serving |
| `index` | string | `"index.html"` | Default file served at the root URL |

### URL Mapping

| Workspace File | URL |
|---------------|-----|
| `public/index.html` | `GET /{handle}/` |
| `public/style.css` | `GET /{handle}/style.css` |
| `public/js/app.js` | `GET /{handle}/js/app.js` |
| `public/images/logo.png` | `GET /{handle}/images/logo.png` |

### Supported MIME Types

The server automatically sets `Content-Type` based on file extension:

| Extension | MIME Type |
|-----------|-----------|
| `.html`, `.htm` | `text/html` |
| `.css` | `text/css` |
| `.js` | `application/javascript` |
| `.json` | `application/json` |
| `.png` | `image/png` |
| `.jpg`, `.jpeg` | `image/jpeg` |
| `.svg` | `image/svg+xml` |
| `.pdf` | `application/pdf` |
| `.woff2` | `font/woff2` |

Unknown extensions default to `application/octet-stream`.

## Shared Files

When `serving.shared` is enabled, workspace files matching configured glob patterns are served over HTTP. This is useful for exposing generated reports, data exports, or other artifacts without putting them in `public/`.

### Configuration

```json
{
  "serving": {
    "shared": {
      "enabled": true,
      "patterns": ["output/*.json", "reports/*.html", "data/*.csv"]
    }
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | boolean | Enable/disable shared file serving (toggle preserves patterns) |
| `patterns` | string[] | Glob patterns matching files to expose |

### URL Mapping

Shared files are served at their workspace path relative to the agent's root:

| Pattern | Workspace File | URL |
|---------|---------------|-----|
| `output/*.json` | `output/data.json` | `GET /{handle}/output/data.json` |
| `reports/*.html` | `reports/weekly.html` | `GET /{handle}/reports/weekly.html` |

### Restrictions

- Patterns must **not** start with `messages` (reserved path)
- Files are matched using [picomatch](https://github.com/micromatch/picomatch) glob syntax
- Disabling shared serving preserves your patterns — re-enabling restores them

## API Routes

API routes map HTTP methods and URL paths to JavaScript/TypeScript lambda functions that run in the [sandbox environment](code-execution.md) with full access to the [`adf` proxy object](adf-object.md).

### Configuration

```json
{
  "serving": {
    "api": [
      { "method": "GET", "path": "/status", "lambda": "lib/api.ts:getStatus" },
      { "method": "POST", "path": "/webhook", "lambda": "lib/api.ts:handleWebhook" },
      { "method": "GET", "path": "/users/:id", "lambda": "lib/api.ts:getUser", "warm": true }
    ]
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `method` | string | HTTP method: `GET`, `POST`, `PUT`, `PATCH`, or `DELETE` |
| `path` | string | URL path with optional `:param` placeholders and `*` wildcard |
| `lambda` | string | File and function reference: `"file.ts:functionName"` |
| `warm` | boolean | Keep sandbox alive between requests (default: `false`) |
| `middleware` | `MiddlewareRef[]` | Optional [middleware](middleware.md) chain executed before the route lambda |

### Path Matching

- Paths are matched relative to `/{handle}/`
- `:param` placeholders extract URL segments: `/users/:id` matches `/users/123` with `params.id = "123"`
- `*` wildcard captures the remaining path: `/:handle/*` matches `/:handle/any/sub/path` with `params['*'] = "any/sub/path"`
- The path `messages` is reserved and cannot be used
- Path must start with `/`

### Lambda Functions

Lambda functions receive an `HttpRequest` object and must return an `HttpResponse` object.

#### HttpRequest

```typescript
interface HttpRequest {
  method: string              // "GET", "POST", etc.
  path: string                // The matched path (e.g., "/users/123")
  params: Record<string, string>  // URL params from :placeholders
  query: Record<string, string>   // Query string parameters
  headers: Record<string, string> // Request headers
  body: unknown                   // Parsed request body (JSON or raw)
}
```

#### HttpResponse

```typescript
interface HttpResponse {
  status: number                   // HTTP status code (200, 404, 500, etc.)
  headers?: Record<string, string> // Optional response headers
  body: unknown                    // Response body (object, string, etc.)
}
```

#### Example Lambda

```javascript
// lib/api.ts

async function getStatus(request) {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: { ok: true, time: Date.now() }
  }
}

async function getUser(request) {
  const userId = request.params.id
  const data = await adf.fs_read({ path: `data/users/${userId}.json` })
  if (!data) {
    return { status: 404, body: { error: 'User not found' } }
  }
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.parse(data)
  }
}

async function handleWebhook(request) {
  const payload = request.body
  await adf.fs_write({
    path: `webhooks/${Date.now()}.json`,
    content: JSON.stringify(payload, null, 2)
  })
  return { status: 200, body: { received: true } }
}
```

### Critical: adf API Rules

Lambda functions have access to the `adf` proxy object for calling agent tools. Follow these rules:

1. **Single object argument** — Every `adf.*` call takes ONE object: `adf.fs_read({ path: "file.md" })`, **not** `adf.fs_read("file.md")` or `adf.fs_read("file.md", { encoding: "base64" })`. Multiple arguments cause a validation error.

2. **Always async/await** — `adf.*` calls are asynchronous. Functions that use them **must** be `async` and **must** `await` every call. Without `await`, calls fire-and-forget and errors are silently lost.

3. **Tool names match** — Use the same tool names as the built-in tools: `adf.fs_read()`, `adf.fs_write()`, `adf.db_query()`, `adf.db_execute()`, `adf.msg_send()`, etc.

```javascript
// CORRECT
async function handler(request) {
  const data = await adf.fs_read({ path: 'data/config.json' })
  await adf.fs_write({ path: 'logs/access.log', content: 'accessed\n' })
  return { status: 200, body: JSON.parse(data) }
}

// WRONG — will fail silently or crash
function handler(request) {
  const data = adf.fs_read('data/config.json')  // wrong: string arg, not awaited
  adf.fs_write('logs/access.log', 'accessed\n') // wrong: two args, not awaited
  return { status: 200, body: data }             // data is a Promise, not content!
}
```

### Console Output

`console.log()`, `console.warn()`, `console.error()`, and `console.info()` output from lambda functions is captured and logged to `adf_logs` with the API response entry. View these in the **Bottom Panel > Logs** tab.

### Warm Mode

When `warm: true` is set on a route, the sandbox worker is kept alive between requests instead of being destroyed after each execution. This reduces startup overhead for frequently-called endpoints. Use for:

- High-traffic endpoints
- Routes that benefit from cached state between calls

The sandbox ID for API routes is `{agentId}:api`, shared across all warm routes for the same agent.

## Serving from a Frontend

When serving an HTML page from `public/`, API requests should use **relative paths** since the page and API share the same base URL:

```html
<!-- public/index.html served at /{handle}/ -->
<script>
  // Relative fetch — automatically resolves to /{handle}/api/data
  const res = await fetch('api/data')
  const data = await res.json()
</script>
```

This works because the browser resolves relative URLs from the page's base URL (`/{handle}/`).

### HTTP/1.1 Connection Limits

The mesh server uses HTTP/1.1. Browsers enforce a **6 TCP connection per origin** limit, and all served webapps share the same origin (`http://{host}:{port}`). Unconsumed `fetch()` response bodies hold their connection slot until garbage collection, and with polling or multiple tabs open to the same app, this quickly exhausts the pool — causing requests to stall for the entire polling interval.

**Rules:**

1. **Always consume the response body** — call `.json()`, `.text()`, or `.body.cancel()` on every `fetch()` response, including fire-and-forget or warmup calls:

   ```javascript
   // BAD — response body not consumed, connection leaked
   fetch('api/warmup').then(() => { startPolling() })

   // GOOD — body consumed, connection released immediately
   fetch('api/warmup').then(r => r.json()).then(() => { startPolling() })
   ```

2. **Avoid concurrent polling from multiple tabs** — if users may have the same app open in multiple tabs, each tab's polling competes for the shared 6-connection pool. Consider coordinating via `BroadcastChannel` or `localStorage` events so only one tab polls at a time.

## Managing Serving via sys_update_config

Agents can manage their own serving configuration at runtime using `sys_update_config`:

### Toggle Public/Shared

```json
// Enable public folder
{ "path": "serving.public.enabled", "value": true }

// Set index file
{ "path": "serving.public.index", "value": "app.html" }

// Enable shared serving
{ "path": "serving.shared.enabled", "value": true }

// Set shared patterns
{ "path": "serving.shared.patterns", "value": ["output/*.json"] }
```

### API Route Management

Use the path-based API for route CRUD:

```json
// Add a route
{ "path": "serving.api", "action": "append", "value": { "method": "GET", "path": "/status", "lambda": "lib/api.ts:getStatus" } }

// Remove route at index 1
{ "path": "serving.api", "action": "remove", "index": 1 }

// Replace all routes
{ "path": "serving.api", "value": [
  { "method": "GET", "path": "/status", "lambda": "lib/api.ts:status" },
  { "method": "POST", "path": "/data", "lambda": "lib/api.ts:postData" }
] }

// Update a field on an existing route
{ "path": "serving.api.0.warm", "value": true }
```

Route validation rules:
- Path must start with `/`
- Path must not start with `/messages` (reserved)
- Lambda must use `file:functionName` format
- Method must be one of: GET, POST, PUT, PATCH, DELETE

## UI Configuration

### Settings > Web Tab

The **Web** tab in Settings shows:

- **Server status** — Running/stopped indicator with host and port
- **Mesh toggle** — Enable/disable the mesh
- **LAN access toggle** — Bind to `0.0.0.0` instead of `127.0.0.1` for local network access
- **Agent endpoints** — Table of all agents currently serving, with handles, URLs, and serving mode badges

### Agent Config > Serving Section

The Serving section in Agent Config provides UI for:

- **Handle** — Text input for the URL slug
- **Public serving** — Toggle + index file name
- **Shared files** — Toggle + glob patterns textarea (one per line)
- **API routes** — Array editor with method dropdown (GET, POST, PUT, PATCH, DELETE, WS), path input, lambda reference, warm toggle, and remove button. Selecting `WS` as the method hides warm/cache/middleware options and shows a hint that lambda is required.
- **URL preview** — Clickable link to the agent's mesh URL (when server is running)
- **WebSocket Connections** — See [WebSocket Connections > UI Configuration](websocket.md#ui-configuration) for outbound connection management

## Server Configuration

### Port

Default: `7295`. Override via:

- Environment variable: `MESH_PORT=8080`
- Settings: `meshPort` setting

### Host / LAN Access

Default: `127.0.0.1` (localhost only). To allow access from other devices on your local network:

- Environment variable: `MESH_HOST=0.0.0.0`
- Settings: Toggle **Allow LAN access** in the Web tab (sets host to `0.0.0.0`)

When LAN access is enabled, other devices can reach the server at `http://{your-ip}:{port}/{handle}/`.

### Server Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Server health check (uptime, agent count, port) |
| `GET /:handle/mesh/card` | Signed agent card (handle, description, DID, endpoints, policies, signature) |
| `GET /:handle/mesh/health` | Agent health status |
| `POST /:handle/mesh/inbox` | [ALF message delivery](messaging.md#message-receive-endpoint) |
| `GET /:handle/mesh/ws` | [WebSocket upgrade endpoint](websocket.md) (when agent has a WS route) |
| `ALL /:handle/mesh/*` | Mesh namespace routes (cards, messaging, protocol) |
| `ALL /:handle/*` | Agent request resolution (API, public, shared) |

## Agent Card

Each servable agent exposes a signed card at `GET /{handle}/mesh/card`:

```json
{
  "did": "did:key:z6Mk...",
  "handle": "my-app",
  "description": "A web application agent",
  "icon": "🌐",
  "public_key": "z6Mk...",
  "resolution": {
    "method": "self",
    "endpoint": "http://127.0.0.1:7295/my-app/mesh/card"
  },
  "endpoints": {
    "inbox": "http://127.0.0.1:7295/my-app/mesh/inbox",
    "card": "http://127.0.0.1:7295/my-app/mesh/card",
    "health": "http://127.0.0.1:7295/my-app/mesh/health"
  },
  "mesh_routes": [
    { "method": "GET", "path": "/status" },
    { "method": "POST", "path": "/data" }
  ],
  "public": true,
  "shared": ["output/data.json", "output/report.json"],
  "policies": [
    { "type": "signing", "standard": "ed25519", "send": "required", "receive": "required" }
  ],
  "attestations": [],
  "signed_at": "2026-03-07T12:00:00Z",
  "signature": "ed25519:..."
}
```

The `shared` field lists resolved file paths (not glob patterns) — the runtime matches the configured glob patterns against the workspace file list.

The `endpoints.inbox` URL is the delivery address for this agent. Other agents can use this as the `address` parameter when sending messages via `msg_send`. The card is signed with Ed25519 on every build — verifiers check the `signature` against `public_key`.

Agents can override auto-derived endpoints and resolution via config (`card.endpoints`, `card.resolution`) — useful when deployed behind a relay or public domain. Agents can also retrieve their own card via `sys_get_config` with `section: "card"`.

## Logging

API requests and responses are logged to `adf_logs`:

| Event | Description |
|-------|-------------|
| `api_request` | Incoming request — method, path, params, query |
| `api_response` | Response — status code, duration, console output (in metadata) |

Lambda `console.log` output is bundled into the `api_response` log entry's metadata (`stdout` field) rather than as a separate log line.

sys_lambda executions are also logged:

| Event | Description |
|-------|-------------|
| `execute` | Function call start — function name and args |
| `result` | Function call result — success/error, duration, stdout |

View logs in the **Bottom Panel > Logs** tab with auto-refresh enabled.

## Example: Full Serving Agent

Here's a complete example of an agent that serves a web dashboard:

### agent.json (relevant fields)

```json
{
  "serving": {
    "public": { "enabled": true, "index": "index.html" },
    "shared": { "enabled": true, "patterns": ["data/*.json"] },
    "api": [
      { "method": "GET", "path": "/api/stats", "lambda": "lib/api.ts:getStats" },
      { "method": "GET", "path": "/api/agents", "lambda": "lib/api.ts:getAgents" }
    ]
  }
}
```

### public/index.html

```html
<!DOCTYPE html>
<html>
<head><title>Dashboard</title></head>
<body>
  <h1>Agent Dashboard</h1>
  <div id="stats"></div>
  <script>
    async function loadStats() {
      const res = await fetch('api/stats')
      const stats = await res.json()
      document.getElementById('stats').textContent = JSON.stringify(stats, null, 2)
    }
    loadStats()
  </script>
</body>
</html>
```

### lib/api.ts

```javascript
async function getStats(request) {
  const loops = await adf.db_query({ sql: 'SELECT COUNT(*) as count FROM adf_loop' })
  const files = await adf.fs_list({})
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: {
      loopEntries: JSON.parse(loops)[0]?.count ?? 0,
      fileCount: files ? JSON.parse(files).length : 0,
      uptime: Date.now()
    }
  }
}

async function getAgents(request) {
  const agents = await adf.agent_discover({})
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.parse(agents)
  }
}
```

### Result

- `http://127.0.0.1:7295/{handle}/` — Serves the dashboard HTML
- `http://127.0.0.1:7295/{handle}/api/stats` — Returns live stats
- `http://127.0.0.1:7295/{handle}/api/agents` — Returns mesh agents
- `http://127.0.0.1:7295/{handle}/data/report.json` — Serves shared data files
