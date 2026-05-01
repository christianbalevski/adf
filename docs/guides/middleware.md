# Custom Middleware

ADF agents can install custom middleware lambdas at four integration points in the message and request pipelines. Middleware functions run in the agent's [sandbox environment](code-execution.md) and can inspect, transform, or reject data as it flows through.

## Overview

| Point | When It Runs | Data Shape | Use Cases |
|-------|-------------|------------|-----------|
| **Route** | Before an API route lambda executes | `HttpRequest` | Auth, rate limiting, CORS headers |
| **Inbox** | After ingress verification, before message storage | `AlfMessage` | Content filtering, spam detection |
| **Outbox** | After message build, before signing/sending | `EgressContext` | PII scrubbing, format transforms, delivery re-routing |
| **Fetch** | Before `sys_fetch` makes an HTTP request | Fetch params | Inject auth headers, URL allowlisting |

Middleware is configured per-agent. Each middleware entry references a lambda function in the agent's file store using the standard `file:functionName` format.

## Middleware Contract

Every middleware function receives a single `MiddlewareInput` object and returns a `MiddlewareOutput` object.

### Input

```typescript
interface MiddlewareInput {
  /** Which pipeline point */
  point: 'route' | 'inbox' | 'outbox' | 'fetch'
  /** The data being processed — shape depends on point */
  data: unknown
  /** Metadata bag — accumulates across the middleware chain */
  meta: Record<string, unknown>
}
```

The `data` field shape depends on the pipeline point:

| Point | `data` shape |
|-------|-------------|
| `route` | [`HttpRequest`](serving.md#httprequest) — `{ method, path, params, query, headers, body }` |
| `inbox` | `AlfMessage` — the full message after ingress verification (with verification stamps in `meta`) |
| `outbox` | `EgressContext` — `{ message: AlfMessage, transport: { address, method, headers? }, agent: { did } }` |
| `fetch` | `{ url, method, headers?, body?, timeout_ms? }` — the `sys_fetch` input params |

Inbox receives an `AlfMessage` while outbox receives an `EgressContext` that wraps the message with transport and agent info. This allows outbox middleware to modify the delivery address (`transport.address`) and inspect the sender's DID (`agent.did`). To query contact data the agent manages itself (e.g. a `local_contacts` table), use `adf.db_query()` from within the middleware. Route and fetch keep their own shapes since they are not message-based.

### Output

```typescript
interface MiddlewareOutput {
  /** Replace the data for downstream middleware/handlers (pass-through if omitted) */
  data?: unknown
  /** Merge into meta for downstream middleware */
  meta?: Record<string, unknown>
  /** Reject — short-circuits the chain and returns an error to the caller */
  reject?: { code: number; reason: string }
}
```

Three behaviors:

1. **Pass-through** — Return `{}` or `{ meta: { ... } }`. Data flows through unchanged.
2. **Transform** — Return `{ data: modifiedData }`. Downstream middleware and handlers see the modified data.
3. **Reject** — Return `{ reject: { code: 403, reason: "Blocked" } }`. The pipeline stops immediately and the caller gets the rejection.

## Configuration

### Inbox / Outbox / Fetch Middleware

Configured in the agent's `security` section:

```json
{
  "security": {
    "allow_unsigned": true,
    "middleware": {
      "inbox": [
        { "lambda": "lib/middleware.ts:validateContent" },
        { "lambda": "lib/middleware.ts:logInbound" }
      ],
      "outbox": [
        { "lambda": "lib/middleware.ts:scrubPII" }
      ]
    },
    "fetch_middleware": [
      { "lambda": "lib/middleware.ts:injectAuthHeaders" }
    ]
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `security.middleware.inbox` | `MiddlewareRef[]` | Middleware chain for inbound messages |
| `security.middleware.outbox` | `MiddlewareRef[]` | Middleware chain for outbound messages |
| `security.fetch_middleware` | `MiddlewareRef[]` | Middleware chain for `sys_fetch` requests |

### Route Middleware

Configured per-route in the `serving.api` array:

```json
{
  "serving": {
    "api": [
      {
        "method": "POST",
        "path": "/webhook",
        "lambda": "lib/api.ts:handleWebhook",
        "middleware": [
          { "lambda": "lib/auth.ts:checkApiKey" },
          { "lambda": "lib/cors.ts:addHeaders" }
        ]
      }
    ]
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `route.middleware` | `MiddlewareRef[]` | Middleware chain executed before the route lambda |

### MiddlewareRef

Each middleware reference is an object with a single `lambda` field:

```typescript
interface MiddlewareRef {
  lambda: string  // "path/file.ts:functionName"
}
```

The format is the same as trigger lambdas and API route lambdas: `filePath:functionName` where `filePath` is relative to the agent's file store.

## Execution

### Chain Order

Middleware functions execute **in array order**. Each function receives the (possibly transformed) data from the previous middleware:

```
Request → middleware[0] → middleware[1] → middleware[2] → handler
```

If any middleware returns `reject`, the chain short-circuits immediately — no further middleware or handler runs.

### Sandbox

Middleware lambdas run in the agent's [sandbox environment](code-execution.md) with access to the [`adf` proxy object](adf-object.md). Each pipeline point gets its own sandbox ID (`{agentId}:mw:{point}`), separate from API route sandboxes.

### Error Handling

If a middleware lambda throws an error or the referenced file/function is not found, the error is logged and the middleware is skipped — the chain continues with the next middleware. This prevents a broken middleware from blocking all traffic.

### Rejection Behavior

When middleware rejects, the caller receives the error:

| Point | Rejection Result |
|-------|-----------------|
| Route | HTTP response with the rejection `code` and `reason` as the error body |
| Inbox (HTTP) | HTTP response with the rejection `code` and `reason` |
| Inbox (local) | Sender's outbox status set to `failed`, error returned to `msg_send` |
| Outbox | Error returned to `msg_send` — message is not sent |
| Fetch | `sys_fetch` returns an error result with the rejection reason |

## Examples

### Auth Middleware for API Routes

```javascript
// lib/auth.ts

async function checkApiKey(input) {
  const headers = input.data.headers || {}
  const apiKey = headers['x-api-key'] || headers['authorization']

  if (!apiKey) {
    return { reject: { code: 401, reason: 'API key required' } }
  }

  // Validate against stored keys
  const keys = await adf.fs_read({ path: 'config/api-keys.json' })
  const validKeys = JSON.parse(keys)

  if (!validKeys.includes(apiKey)) {
    return { reject: { code: 403, reason: 'Invalid API key' } }
  }

  // Pass through with auth metadata
  return { meta: { authenticated: true, apiKey } }
}
```

### Spam Filter for Inbox

```javascript
// lib/middleware.ts

function blockSpam(input) {
  const message = input.data
  const content = typeof message.payload.content === 'string'
    ? message.payload.content
    : JSON.stringify(message.payload.content)

  const spamPatterns = ['buy now', 'free money', 'click here']
  const isSpam = spamPatterns.some(p =>
    content.toLowerCase().includes(p)
  )

  if (isSpam) {
    return { reject: { code: 403, reason: 'Message flagged as spam' } }
  }

  return { meta: { spam_checked: true } }
}
```

### PII Scrubbing for Outbox

```javascript
// lib/middleware.ts

function scrubPII(input) {
  const ctx = input.data  // EgressContext
  const message = ctx.message
  let content = typeof message.payload.content === 'string'
    ? message.payload.content
    : JSON.stringify(message.payload.content)

  // Redact email addresses
  content = content.replace(
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    '[REDACTED_EMAIL]'
  )

  // Redact phone numbers
  content = content.replace(
    /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g,
    '[REDACTED_PHONE]'
  )

  // Return transformed EgressContext
  return {
    data: {
      ...ctx,
      message: {
        ...message,
        payload: { ...message.payload, content }
      }
    },
    meta: { pii_scrubbed: true }
  }
}
```

### Delivery Re-routing for Outbox

```javascript
// lib/middleware.ts

function rerouteToProxy(input) {
  const ctx = input.data  // EgressContext

  // Re-route all HTTP deliveries through a proxy
  if (ctx.transport.method === 'http') {
    return {
      data: {
        ...ctx,
        transport: {
          ...ctx.transport,
          address: 'https://proxy.example.com/relay',
          headers: { 'X-Original-Address': ctx.transport.address }
        }
      }
    }
  }

  return {}
}
```

### Auth Header Injection for Fetch

```javascript
// lib/middleware.ts

async function injectAuthHeaders(input) {
  const fetchData = input.data

  // Read API token from identity store or file
  const token = await adf.fs_read({ path: 'config/api-token.txt' })

  if (token) {
    const headers = { ...(fetchData.headers || {}), 'Authorization': `Bearer ${token.trim()}` }
    return { data: { ...fetchData, headers } }
  }

  return {}
}
```

### URL Allowlist for Fetch

```javascript
// lib/middleware.ts

function enforceAllowlist(input) {
  const { url } = input.data
  const allowed = [
    'https://api.example.com',
    'https://hooks.slack.com'
  ]

  const isAllowed = allowed.some(prefix => url.startsWith(prefix))
  if (!isAllowed) {
    return { reject: { code: 403, reason: `URL not in allowlist: ${url}` } }
  }

  return {}
}
```

### Logging Middleware (Pass-Through)

```javascript
// lib/middleware.ts

function logRequest(input) {
  console.log(`[MW] ${input.point}:`, JSON.stringify(input.data).slice(0, 200))
  return { meta: { logged_at: Date.now() } }
}
```

## UI Configuration

### Security Section

In **Agent Config > Security**, a "Custom Middleware" area appears with three lists:

- **Inbox** — Lambda references for inbound message middleware
- **Outbox** — Lambda references for outbound message middleware
- **Fetch** — Lambda references for `sys_fetch` request middleware

Each list has an **+ Add** button to add entries and an **x** button to remove them. Enter lambda references in `path/file.ts:functionName` format.

### Route Cards

In **Agent Config > Serving > API Routes**, each route card has a middleware section with the same **+ Add** / **x** pattern. Route middleware runs before that specific route's lambda function.

## Pipeline Integration

### Where Middleware Runs in Each Pipeline

**Route pipeline:**
```
HTTP request → Fastify preHandlers (resolve agent) → build HttpRequest
  → route middleware chain → route lambda → HTTP response
```

**Inbox pipeline (HTTP delivery):**
```
HTTP POST → validate message → verify signatures
  → inbox middleware chain → flatten to inbox row → fire on_inbox trigger
```

**Inbox pipeline (local delivery):**
```
msg_send → build AlfMessage → egress pipeline (signing)
  → ingress pipeline (verification) → inbox middleware chain
  → flatten to inbox row → fire on_inbox trigger
```

**Outbox pipeline:**
```
msg_send → build AlfMessage → wrap in EgressContext
  → outbox middleware chain (can modify transport.address)
  → egress pipeline (signing) → write outbox row → deliver
```

**Fetch pipeline:**
```
sys_fetch call → fetch middleware chain → HTTP fetch → return result
```

## Middleware Authorization

By default (`require_middleware_authorization: true`), middleware lambdas must be from [authorized files](authorized-code.md). If a middleware lambda's source file is not authorized, it is **silently skipped** and the message passes through unmodified. A warning is logged.

This prevents agents from writing middleware that tampers with messages before the agent sees them. The owner must review and authorize middleware code via the Files panel before it takes effect.

To allow agent-written middleware (an explicit trust decision), set `require_middleware_authorization: false` in the security config. Unauthorized middleware will run but cannot call [restricted methods](authorized-code.md#restricting-methods).

See [Authorized Code Execution](authorized-code.md) for the full authorization model.

## Best Practices

1. **Keep middleware fast.** Middleware runs on every request/message. Avoid heavy computation or slow I/O.
2. **Use pass-through by default.** Return `{}` when no action is needed. Only return `data` when you actually transform it.
3. **Order matters.** Auth middleware should come before logging middleware. Validation before transformation.
4. **Test rejection paths.** Verify that rejected requests return the expected error codes and messages.
5. **Use `meta` for cross-middleware communication.** An early middleware can set `meta.authenticated = true` and a later one can check it.
6. **Don't modify message signatures.** Outbox middleware runs before signing. Inbox middleware runs after verification. Modifying signatures will break the crypto pipeline.
7. **Outbox middleware operates on EgressContext.** Access the message via `ctx.message` and delivery info via `ctx.transport`. You can change the delivery address by modifying `ctx.transport.address`.
