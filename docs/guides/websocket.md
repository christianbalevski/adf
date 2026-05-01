# WebSocket Connections

WebSocket connections provide persistent, bidirectional communication between agents. They solve the NAT traversal problem: an agent behind NAT can connect outbound to a reachable peer, establishing a pipe for message delivery in both directions.

WebSockets are a transport layer — the wire format is unchanged (one ALF message per text frame), and inbox rows are identical regardless of transport.

## Configuration

### Inbound Connections (Receiving)

To accept inbound WebSocket connections, add a WS route to `serving.api`:

```json
{
  "serving": {
    "api": [
      {
        "method": "WS",
        "path": "/ws",
        "lambda": "lib/ws-handler.ts:onEvent"
      }
    ]
  }
}
```

WS routes **require** a `lambda` handler. When an agent has a WS route, its agent card includes a `ws` endpoint:

```json
{
  "endpoints": {
    "inbox": "http://127.0.0.1:7295/my-agent/mesh/inbox",
    "card": "http://127.0.0.1:7295/my-agent/mesh/card",
    "health": "http://127.0.0.1:7295/my-agent/mesh/health",
    "ws": "ws://127.0.0.1:7295/my-agent/mesh/ws"
  }
}
```

Clients connect to the `ws` endpoint. After the [authentication handshake](../alf-protocol.md#websocket-authentication-handshake), all frames are dispatched to the lambda handler.

### Outbound Connections (Connecting)

To connect outbound to another agent's WebSocket endpoint, add entries to `ws_connections`:

```json
{
  "ws_connections": [
    {
      "id": "relay",
      "url": "wss://relay.example.com/my-agent/mesh/ws",
      "did": "did:key:z6MkRelay...",
      "enabled": true,
      "lambda": "lib/ws-handler.ts:onEvent",
      "auto_reconnect": true,
      "reconnect_delay_ms": 5000,
      "keepalive_interval_ms": 30000
    }
  ]
}
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `id` | Yes | — | Unique identifier for this connection |
| `url` | Yes | — | WebSocket URL to connect to |
| `did` | No | — | Expected remote DID (verified during auth) |
| `enabled` | Yes | — | Whether to auto-connect on agent start |
| `lambda` | No | — | Lambda handler for hot-path events |
| `auth` | No | `auto` | Auth mode: `auto` (auth if key available), `required` (always auth), `none` (skip auth) |
| `auto_reconnect` | No | `true` | Reconnect on unexpected close |
| `reconnect_delay_ms` | No | `5000` | Base delay between reconnection attempts |
| `keepalive_interval_ms` | No | `30000` | Interval for ping/pong keepalive |

## Hot Path vs Cold Path

### Hot Path (Lambda)

When a `lambda` is configured, all WebSocket events are dispatched to the lambda function. The lambda receives a `WsLambdaEvent`:

```typescript
interface WsLambdaEvent {
  type: 'open' | 'message' | 'close' | 'error'
  connection_id: string
  remote_did?: string
  data?: string          // on 'message'
  code?: number          // on 'close'
  reason?: string        // on 'close' / 'error'
  error?: string         // on 'error'
  timestamp: number
}
```

Example lambda handler:

```typescript
export async function onEvent(event: WsLambdaEvent) {
  if (event.type === 'message') {
    const msg = JSON.parse(event.data!)
    // Process the message
    await adf.ws_send({ connection_id: event.connection_id, data: JSON.stringify({ ack: true }) })
  }
  if (event.type === 'open') {
    console.log(`Connected to ${event.remote_did}`)
  }
}
```

The lambda sandbox is persistent (warm) for the lifetime of the agent — module-level state is shared across all WS events.

### Cold Path (Inbox)

When no `lambda` is configured on an outbound connection, incoming text frames are validated as ALF messages and processed through the standard ingress pipeline (signature verification, inbox middleware, inbox storage, triggers). The message appears in the inbox identically to one received via HTTP POST.

Inbound WS connections always use the hot path (lambda is required by schema).

## Authentication

Connections use mutual DID authentication via Ed25519 signatures. See the [ALF protocol WebSocket handshake](../alf-protocol.md#websocket-authentication-handshake) for the wire protocol.

### Inbound Auth

The agent's `security.allow_unsigned` setting controls whether inbound clients must authenticate. When `allow_unsigned: true`, clients may optionally send an auth frame to claim a DID, but it is accepted without cryptographic verification and stamped as `identity_verified: false`. Messages from unverified connections show an amber "unverified" badge in the inbox UI.

### Outbound Auth

Outbound auth is controlled per-connection via the `auth` field (not by the agent's `allow_unsigned` setting):

- **`auto`** (default) — Authenticate if a private key is available. This ensures connections to auth-requiring servers work even if the local agent has `allow_unsigned: true`.
- **`required`** — Always authenticate. Fails immediately if no private key is available.
- **`none`** — Skip authentication entirely.

### Identity Verification

Cold-path messages (ALF over WS without a lambda) are stamped with `meta.identity_verified`:
- `true` when the connection was mutually authenticated via Ed25519
- `false` when the connection is unsigned or the DID was claimed without verification

When a connection has a verified identity, messages with a `from` field that doesn't match the authenticated DID are rejected (close code `4003`).

## Transport Resolution

When sending messages via `msg_send`, the runtime automatically selects the best transport:

1. **Local** — Recipient is on the same runtime (direct inbox write)
2. **WebSocket** — An active, authenticated WS connection exists to the recipient's DID
3. **HTTP POST** — Default fallback

If WebSocket delivery fails (connection died between resolution and send), the runtime falls through to HTTP. Custom outbox middleware can override transport selection.

## Reconnection

Outbound connections auto-reconnect on unexpected close (any code other than 1000 or 1001):

- Increasing delay: `reconnect_delay_ms * attempt` (1x, 2x, 3x, 4x, 5x)
- After 5 consecutive failures, reconnection stops. The agent can re-initiate via `ws_connect` or a timer-triggered lambda.
- Counter resets after successful authentication (or after entering the no-auth path). A server that accepts TCP but immediately closes or rejects auth will correctly exhaust attempts.
- Set `auto_reconnect: false` to disable.

## Keepalive

The runtime sends WebSocket pings at `keepalive_interval_ms` intervals (default 30s). If no pong is received within 10s, the connection is considered dead and closed, triggering reconnection for outbound connections.

## Binary frames

`ws_send` accepts text (string) and binary (`Uint8Array`) payloads. From sandbox code:

```typescript
// Text frame (default)
await adf.ws_send({ connection_id, data: 'hello' })

// Binary frame
await adf.ws_send({ connection_id, data: new Uint8Array([0x01, 0x02, 0x03]) })
```

From direct LLM tool calls (no `Uint8Array` support in JSON), pass base64 with `binary: true`:

```jsonc
{
  "connection_id": "abc",
  "data": "AQID",
  "binary": true
}
```

Inbound frames reach the handler lambda with a `binary: boolean` flag:

```typescript
export async function onEvent(event) {
  if (event.binary) {
    const bytes = event.data as Uint8Array  // raw binary
    // ...
  } else {
    const text = event.data as string       // text frame
    // ...
  }
}
```

Cold-path connections (no lambda configured) drop binary frames with a warn log — text frames continue to validate as ALF messages.

## Backpressure

`ws_send` awaits a drain when the socket's `bufferedAmount` exceeds the per-connection high-water mark:

```typescript
// Awaits if the socket is buffered over the threshold.
await adf.ws_send({ connection_id, data: chunk })
```

Configurable per connection:

- **Outbound:** `ws_connections[].high_water_mark_bytes` (default 1 MiB)
- **Inbound:** on the matching WS route in `serving.api[].high_water_mark_bytes`

Callers that don't await retain current fire-and-forget behavior — the drain wait is only observed if you `await` the returned promise.

## Request metadata on `open`

Inbound connections populate `event.url_params` (parsed query string) and `event.headers` (upgrade request headers) on the `open` event:

```typescript
// Client: wss://host/:handle/mesh/ws?stream=abc123
export async function onEvent(event) {
  if (event.type === 'open') {
    const streamId = event.url_params?.stream
    const userAgent = event.headers?.['user-agent']
    // ...
  }
}
```

This lets a single WS endpoint disambiguate multiple concurrent sessions without requiring path-based routing.

## Tools

Four tools are available for runtime WebSocket management (all disabled by default):

| Tool | Description |
|------|-------------|
| `ws_connect` | Start a connection (by config ID or ad-hoc URL) |
| `ws_disconnect` | Close a connection |
| `ws_connections` | List active connections |
| `ws_send` | Send data over a connection |

Enable them in agent config:

```json
{
  "tools": [
    { "name": "ws_connect", "enabled": true },
    { "name": "ws_disconnect", "enabled": true },
    { "name": "ws_connections", "enabled": true },
    { "name": "ws_send", "enabled": true }
  ]
}
```

## UI Configuration

### Inbound WS Route (Agent Config > Serving > API Routes)

To add an inbound WebSocket route via the UI:

1. Go to **Agent Config > Serving > API Routes**
2. Click **Add Route**
3. Select **WS** from the method dropdown
4. Enter the path (e.g., `/ws`)
5. Enter the lambda reference (e.g., `lib/ws-handler.ts:onEvent`) — required for WS routes

When `WS` is selected as the method, the warm, cache TTL, and middleware options are hidden since they don't apply to WebSocket routes.

### Outbound Connections (Agent Config > WebSocket Connections)

The **WebSocket Connections** section appears in Agent Config between Serving and Metadata. It manages outbound `ws_connections` entries.

For each connection, the UI provides:

| Field | Control | Description |
|-------|---------|-------------|
| **Enabled** | Checkbox | Whether to auto-connect on agent start |
| **ID** | Text input | Unique identifier for this connection |
| **URL** | Text input | WebSocket URL to connect to (e.g., `wss://relay.example.com/mesh/ws`) |
| **DID** | Text input | Expected remote DID (optional — verified during auth) |
| **Lambda** | Text input | Lambda handler for hot-path events (e.g., `lib/ws-handler.ts:onEvent`) |
| **Auth** | Select | Auth mode: `auto` (default), `required`, or `none` |
| **Auto Reconnect** | Checkbox | Reconnect on unexpected close (default: on) |
| **Reconnect Delay** | Number input | Base delay in ms between reconnection attempts (default: 5000) |
| **Keepalive Interval** | Number input | Ping/pong interval in ms (default: 30000) |

Use **Add Connection** to add a new outbound connection entry, and the **Remove** button to delete one.
