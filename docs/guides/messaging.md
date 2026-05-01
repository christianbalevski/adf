# Messaging

ADF agents communicate through an asynchronous message-passing protocol built on DIDs (Decentralized Identifiers) and delivery URLs. This guide covers how messaging works, from basic sends to multi-agent collaboration.

## Overview

Each agent has two message stores:

- **Inbox** (`adf_inbox`) — Messages received from other agents or external platforms
- **Outbox** (`adf_outbox`) — Messages sent to other agents or external platforms

Messages are delivered using a DID+address model: the sender specifies the recipient's DID (for identity verification) and delivery URL (for routing). The full message (including attachments) is persisted in both sender's outbox and receiver's inbox, supporting offline-first operation.

### Source-Based Transport

Every message has a `source` field indicating its transport origin:

| Source | Description |
|--------|-------------|
| `mesh` | Default — delivered via the ADF mesh (local or HTTP) |
| `telegram` | Delivered via the Telegram channel adapter |

The `source_context` field stores platform-specific metadata from the originating platform. This enables reply threading and multi-recipient handling:

- **Telegram:** `chat_id`, `message_id`, `reply_to_message_id`, `chat_type`
- **Email:** `message_id`, `to` (all recipients), `cc` (CC recipients), `in_reply_to`, `references`

The `original_message` field stores the raw platform message before ADF normalization (e.g., the full RFC 822 email source). This provides a forensic record and enables future features that need access to the unprocessed original.

## Sending Messages

Agents send messages using the `msg_send` tool. There are two modes:

### Mode 1: Direct Send (recipient + address)

Provide the recipient's DID and delivery URL:

```
msg_send(
  recipient: "did:adf:9gvayMZx5m...",
  address: "http://127.0.0.1:7295/monitor/mesh/inbox",
  content: "Status update"
)
```

### Mode 2: Reply via parent_id

Provide a `parent_id` referencing an inbox message — the runtime resolves the recipient DID from the message's `from` field and the delivery URL from `reply_to`:

```
msg_send(
  parent_id: "msg-abc123",
  content: "Got it, thanks!"
)
```

### msg_send Parameters

| Field | Required | Description |
|-------|----------|-------------|
| `recipient` | Yes, unless `parent_id` provided | DID of the recipient (e.g., `"did:key:..."`) or adapter address (e.g., `"telegram:123"`) |
| `address` | Yes, unless `parent_id` provided or adapter recipient | Full delivery URL (e.g., `"http://127.0.0.1:7295/agent-handle/mesh/inbox"`) |
| `content` | Always | The message content |
| `subject` | No | Optional subject line for the message |
| `thread_id` | No | Thread ID for grouping related messages. Auto-inherited from parent message if `parent_id` is provided. |
| `parent_id` | No | If set without recipient/address, runtime resolves both from the referenced inbox message |
| `attachments` | No | File paths within the agent's file store to attach |
| `meta` | No | Metadata included in the message payload. Encrypted along with content — only the recipient can read it. |
| `message_meta` | No | Metadata on the outer message. Always cleartext — visible to relays and intermediaries. Use for routing hints (e.g., `reply_all`, `cc`, `bcc` for email), PoW proofs, TTL, priority. See [Email Routing Hints](#email-routing-hints). |

### Message Flow

1. **Compose** — Agent calls `msg_send`
2. **Resolve** — If `parent_id` provided without recipient, runtime looks up the inbox message and resolves `from` → `recipient`, `reply_to` → `address`
3. **Store** — Message written to sender's `adf_outbox` with `status='pending'`
4. **Deliver** — Runtime delivers via local fast path (same runtime) or HTTP POST to the address
5. **Ingest** — Message written to recipient's `adf_inbox` with `reply_to` set to the sender's Reply-To URL
6. **Update** — Sender's outbox status updated to `delivered` or `failed`, with HTTP status code

## Messaging Modes

Each agent has a messaging mode that controls its ability to send:

| Mode | Behavior |
|------|----------|
| `proactive` | Can send messages at any time |
| `respond_only` | Can only reply (must include valid `parent_id` referencing a received message, or be in a turn triggered by an incoming message) |
| `listen_only` | Cannot send, only receive |

Messaging modes are enforced by the runtime at the tool layer. This applies to **all** message sends — whether from the LLM via `msg_send` or from lambdas via the `adf` proxy.

## Addressing

Messages use DID+address addressing:

| Field | Format | Example | Purpose |
|-------|--------|---------|---------|
| `recipient` | DID | `"did:adf:9gvayMZx5m..."` | Identity — who the message is for |
| `address` | URL | `"http://127.0.0.1:7295/monitor/mesh/inbox"` | Routing — where to deliver |

For adapter recipients (e.g., Telegram), the recipient uses the `type:id` format (e.g., `"telegram:123456"`) and no address is needed.

### Reply-To

Every inbox message includes a `reply_to` field — the URL where replies should be sent. This comes from the ALF message's `reply_to` header field (part of the message body, not an HTTP header). The sender sets it to their preferred reply endpoint, typically `http://{host}:{port}/{handle}/mesh/inbox`.

Agents can override their reply-to URL via card endpoint overrides (`card.endpoints.inbox` in config). When set, outbound messages use this URL as `reply_to` instead of the auto-derived local address. This is useful when deployed behind a relay or public domain. Update via `sys_update_config`:

```
sys_update_config({ path: "card.endpoints", value: { "inbox": "https://relay.example.com/me/inbox" } })
```

## Threading

Messages are threaded using two fields:

| Field | Description |
|-------|-------------|
| `thread_id` | Conversation thread ID. All messages in a thread share this. Auto-inherited from parent if `parent_id` is provided, otherwise defaults to the message's own ID. |
| `parent_id` | The specific message being replied to. Enables tree-structured threading. `NULL` for root messages. |

Threading is important for `respond_only` agents, which must include a valid `parent_id` to send messages. When `parent_id` is provided without `recipient` and `address`, the runtime automatically resolves both from the referenced inbox message.

## Reading Messages

### msg_list

Lightweight check — returns message counts without content:

```
msg_list(status: "unread")
→ { unread: 5, read: 12, archived: 100 }
```

### msg_read

Fetch full messages from the inbox. Messages returned are automatically marked as `read`.

```
msg_read(limit: 10, status: "unread")
```

### msg_update

Update message status after processing:

```
msg_update(ids: ["msg-1", "msg-2"], status: "archived")
```

### msg_delete

Delete messages from inbox or outbox by filter. Requires at least one filter field (status, from, source, before, thread_id) to prevent accidental mass deletion.

```
msg_delete(source: "inbox", filter: { status: "archived", before: 1707000000000 })
```

If audit is enabled, messages are compressed and stored in `adf_audit` before deletion. See [Memory Management > Audit](memory-management.md#audit) for details.

## Visibility Tiers

Every agent declares a **visibility tier** via `messaging.visibility` that governs who can enumerate it and who can deliver messages to it. There are four tiers, strictly nested:

| Tier | Who can see and reach the agent |
|------|---------------------------------|
| `directory` | Agents on the same runtime in ancestor directories (same dir counts) |
| `localhost` | Any agent on the same machine (default) |
| `lan` | Any agent on the local network |
| `off` | Nobody — no enumeration, no inbound delivery |

Tiers are a containment hierarchy: `lan ⊃ localhost ⊃ directory`. A LAN-tier agent is also localhost-reachable and directory-reachable. An `off` agent is unreachable from every scope.

Visibility governs **inbound** behavior only — it does not gate outbound sends. Outbound is governed by `messaging.mode` (`proactive` / `respond_only` / `listen_only`). An `off` agent can still send; a write-only logger or reporter is a legitimate use case.

### Default

Newly created agents default to `localhost`. `directory` is too restrictive for multi-agent composition, `lan` exposes more than a new user is likely to expect, and `off` breaks local discoverability — so `localhost` is the right starting point for single-machine development.

### Enforcement

Two surfaces enforce the tier, and both must pass:

1. **Inbox acceptance** — `POST /{handle}/mesh/inbox` rejects requests whose requester scope exceeds the recipient's visibility. A LAN-origin request to a `localhost`-tier agent returns `403 Forbidden` with reason `"visibility tier mismatch"`.
2. **Directory inclusion** — `agent_discover` and the `GET /mesh/directory` endpoint only return cards for agents whose visibility permits the requester's scope.

Same-runtime in-process delivery goes through the same check; the `msg_send` tool pre-validates visibility against the recipient's declared tier before invoking the delivery path, so `msg_send` with a blocked bare handle returns a tool-level error with the same reason string the HTTP 403 would produce.

### Runtime Network Binding

The runtime's mesh server binding follows the highest declared tier:

| Condition | Binding |
|-----------|---------|
| All agents `off` | Mesh server not started |
| No `lan`-tier agent and no `meshLan` override | `127.0.0.1` (loopback only) |
| At least one `lan`-tier agent **OR** `meshLan` setting enabled **OR** `MESH_HOST=0.0.0.0` | `0.0.0.0` (all interfaces) |

Flipping a single agent to `lan` is enough to make the runtime bind on all interfaces at next start. Live tier changes (via `sys_update_config`) take effect immediately for inbox/delivery enforcement, but upgrading binding from loopback to LAN requires a runtime restart.

### Public Reach

`public` is not a visibility tier. Agents that want to be reachable from the public internet register with a relay or expose themselves behind a public endpoint (Cloudflare tunnel, VPS, etc.) and advertise that endpoint via card endpoint overrides (`card.endpoints.inbox`). The visibility enum reflects what the runtime can meaningfully enforce; for NAT-traversing public reach, it's an agent-level decision.

## Agent Discovery

Use `agent_discover` to find agents reachable from this agent. It returns signed agent cards decorated with `visibility`, `in_subdirectory`, and a `source` field (`"local-runtime"` for same-runtime agents, `"mdns"` for LAN peers discovered via multicast DNS). The runtime only returns cards for agents whose visibility tier is reachable from the caller's scope — a `directory`-tier caller only sees ancestor agents, a `localhost`-tier caller sees everything same-runtime, and so on:

```
agent_discover()
→ [
    {
      "did": "did:key:z6Mk...",
      "handle": "monitor",
      "description": "Monitors system resources",
      "public_key": "z6Mk...",
      "endpoints": {
        "inbox": "http://127.0.0.1:7295/monitor/mesh/inbox",
        "card": "http://127.0.0.1:7295/monitor/mesh/card",
        "health": "http://127.0.0.1:7295/monitor/mesh/health"
      },
      "policies": [...],
      "visibility": "localhost",
      "in_subdirectory": false,
      "source": "local-runtime"
    }
  ]
```

### Filters

| Parameter | Description |
|-----------|-------------|
| `scope` | `"local"` (default) or `"all"`. `"all"` merges local-runtime cards with mDNS-discovered LAN peers — see [LAN Discovery](lan-discovery.md). |
| `visibility` | Array of tiers to include. E.g. `["lan"]` to find only LAN-announced agents. |
| `handle` | Case-insensitive substring match on the agent handle. |
| `description` | Case-insensitive substring match on the agent description. |
| `include_subdirectories` | (Backward-compat for `"local"` scope.) When false, excludes agents in subdirectories. |

### Managing Contacts

Contact management is an agent-level concern. There is no runtime-provided contacts book — the agent stores what it needs, how it needs it. The primitives available are:

- **DIDs + addresses** — `msg_send` accepts them directly.
- **Agent cards** — fetchable via `GET /{handle}/mesh/card`, returned by `agent_discover`, and included in inbox messages when agents introduce themselves.
- **Middleware hooks** — `on_inbox` and `on_send` lambdas let the agent rewrite messages before they land or depart.

Typical patterns: (A) a plain file in the agent's workspace; (B) a `local_*` table plus an `on_send` lambda that rewrites a handle to a DID+address; (C) an `on_inbox` lambda that auto-saves senders' cards. See [Contacts](contacts.md) for examples.

If the agent always replies via `parent_id`, it can skip contacts entirely — the runtime resolves the recipient and address from the inbox row.

## Attachments

Attachments are transferred **by value** — the actual file data is copied, not referenced.

### Sending Attachments

1. Create the file using `fs_write`
2. Include the file path in `msg_send` attachments
3. Runtime reads the file from the sender's file store

### Receiving Attachments

1. Runtime extracts inline attachment data to the recipient's file store
2. Files are namespaced to prevent collisions: `imported/{sender_name}/{filename}`
3. The attachment's `transfer` field is changed from `"inline"` to `"imported"` and the `path` field points to the local file
4. The base64 `data` is removed from the stored message — only metadata and local path are kept

### Cross-Machine Transport

For HTTP transport (across machines), attachments are base64-encoded in the message payload.

### Per-Message Audit

When audit is enabled for inbox or outbox, the runtime captures the **full ALF message with inline attachment data intact** (before extraction/tombstoning) and stores it as a brotli-compressed blob in `adf_audit`. This provides a forensic record of exactly what was sent or received, even if the extracted files are later modified or deleted.

Audit entries use source `inbox_message` or `outbox_message` to distinguish per-message audit from bulk deletion audit (`inbox`/`outbox`). See [Memory Management > Audit](memory-management.md#audit) for configuration.

## The Mesh

The ADF mesh is the discovery and transport layer that connects agents.

### Local Mesh

On a local network, agents on different runtimes discover each other via **mDNS** (multicast DNS). Runtimes announce themselves under the service type `_adf-runtime._tcp.local`, and each side fetches the other's `/mesh/directory` to merge remote cards into `agent_discover(scope: 'all')`.

See the dedicated [LAN Discovery](lan-discovery.md) guide for how announcement works, when it triggers, how to interpret the "Discovered on LAN" panel, and how to force an interface with `ADF_MDNS_INTERFACE` when the automatic picker picks wrong.

### Enabling Mesh

In the sidebar, toggle the mesh participation switch for your agent. You can also configure:

- **Receive toggle** (`messaging.receive`) — Whether the agent participates in the mesh
- **Allow list** (`messaging.allow_list`) — Only accept messages from these agent DIDs
- **Block list** (`messaging.block_list`) — Reject messages from these agent DIDs

### Message Receive Endpoint

Each agent with a handle exposes a message receive endpoint at:

```
POST /{handle}/mesh/inbox
```

The wire format is a full ALF message:

```json
{
  "version": "1.0",
  "network": "devnet",
  "id": "msg_01HQ9ZxKp4mN7qR2wT",
  "timestamp": "2026-02-28T20:00:00Z",
  "from": "did:key:z6MkAlice...",
  "to": "did:key:z6MkBob...",
  "reply_to": "http://127.0.0.1:7295/alice/mesh/inbox",
  "meta": {},
  "payload": {
    "thread_id": "thr-123",
    "parent_id": null,
    "content": "Hello from another agent",
    "sent_at": "2026-02-28T20:00:00Z",
    "attachments": []
  }
}
```

The runtime responds with `202 Accepted` and a `message_id`:

```json
{ "message_id": "inbox-abc123" }
```

Error responses:
- `400` — Malformed request (missing required fields)
- `404` — No agent with matching handle or DID
- `503` — Agent is in `off` state

### Local Delivery (Fast Path)

When the recipient is on the same runtime, the mesh manager bypasses HTTP and writes directly to the recipient's inbox. This is transparent to the agent — the message appears in the inbox the same way.

### WebSocket Delivery

When an active WebSocket connection exists to the recipient, the mesh manager sends the ALF message as a text frame over that connection instead of making an HTTP POST. This is useful for:

- **NAT traversal** — Agents behind NAT can connect outbound to a reachable peer, establishing a persistent pipe for bidirectional message delivery
- **Lower latency** — No TCP handshake overhead per message
- **Persistent connections** — Keepalive pings maintain the connection

The transport is resolved automatically on egress: local → active WebSocket → HTTP POST. If WebSocket delivery fails (e.g., connection died between resolve and send), the runtime falls through to HTTP.

See [WebSocket Connections](websocket.md) for configuration and usage details.

### Background Agents

Agents can run in the background while you work on a different file in the foreground. Background agents:

- Continue to participate in the mesh
- Process triggers and messages
- Maintain their state

### Mesh Graph

ADF Studio includes a visual **mesh graph** (accessible from the sidebar) that provides a real-time view of your agent network:

- **Node layout** — Each agent is a node in a ring layout, showing its name, state, and recent tool call activity
- **Animated edges** — Message flows between agents are shown as animated particles along connection lines
- **Interactive** — Click a node to switch to that agent and open its detail panel (loop, inbox, files, config)
- **Live activity** — Tool calls and state changes update in real-time on each node

### Mesh Monitor

The mesh monitor (also accessible from the sidebar) shows:

- Bus registrations (which agents are connected)
- Background vs. foreground agents
- Message log (last 100 messages)

## Hub Agents

For internet-scale communication beyond LAN, agents use **Hub Agents** as message routers.

### How Hubs Work

1. An agent sends a subscription request to a hub (e.g., `content: { "action": "subscribe" }`)
2. The hub adds the agent to its `local_subscribers` table
3. When the hub receives updates, it broadcasts to all subscribers using the wrapper pattern
4. The hub wraps the original message with attribution

### Hub Message Format

Hub broadcasts use the ALF wrapper pattern — the original message is nested inside `content`:

```json
{
  "version": "1.0",
  "from": "did:key:z6MkHub...",
  "to": "did:key:z6MkSubscriber...",
  "reply_to": "https://hub-server.com/hub/mesh/inbox",
  "payload": {
    "meta": { "wrapper": "fanout" },
    "content": {
      "version": "1.0",
      "from": "did:key:z6MkOriginalSender...",
      "payload": {
        "content": "The sea level is rising.",
        "sent_at": "2026-02-28T20:00:00Z"
      }
    },
    "sent_at": "2026-02-28T20:00:01Z"
  }
}
```

Hub agents require cryptographic identity for message signing and verification.

## Message Status Lifecycle

### Inbox

| Status | Description |
|--------|-------------|
| `unread` | New message, not yet processed |
| `read` | Agent has read the message |
| `archived` | Processed and stored |

### Outbox

| Status | Description |
|--------|-------------|
| `pending` | Queued for delivery |
| `sent` | Sent to transport |
| `delivered` | Successfully delivered |
| `failed` | Delivery failed |

The outbox also records:
- `status_code` — HTTP status code from the delivery attempt (e.g., 202, 404, 503)
- `delivered_at` — Timestamp of successful delivery

## Agent Card

Each agent on the mesh exposes a card at `GET /{handle}/mesh/card`:

```json
{
  "did": "did:key:z6Mk...",
  "handle": "monitor",
  "description": "Monitors system resources",
  "icon": "📊",
  "public_key": "z6Mk...",
  "endpoints": {
    "inbox": "http://127.0.0.1:7295/monitor/mesh/inbox",
    "card": "http://127.0.0.1:7295/monitor/mesh/card",
    "health": "http://127.0.0.1:7295/monitor/mesh/health"
  },
  "mesh_routes": [
    { "method": "GET", "path": "/status" }
  ],
  "policies": [],
  "public": true,
  "shared": ["reports/weekly.html", "data/metrics.json"]
}
```

The card is the agent's public-facing identity. When another agent receives a card (in a message payload, via introduction, or through discovery), it is free to store it however it chooses — see [Contacts](contacts.md) for patterns.

The `shared` field lists resolved file paths (not glob patterns) — the runtime matches the configured glob patterns against the workspace file list.

## Channel Adapters

Channel adapters bridge external messaging platforms into the ADF inbox/outbox system. They convert platform-specific messages into the unified ADF message format, allowing agents to receive and reply to messages from Telegram, and other platforms in the future.

### Architecture

Each adapter implements a standard interface:

- `start(ctx)` — Initialize and connect to the platform
- `stop()` — Disconnect cleanly
- `send(msg)` — Deliver an outbound message to the platform
- `canDeliver(id)` — Check if the adapter can reach a recipient
- `status()` — Report connection health (`connected`, `connecting`, `disconnected`, `error`)

Inbound messages from the platform are ingested into the agent's `adf_inbox` with the appropriate `source` field (e.g., `telegram`) and platform metadata in `source_context`.

### Adapter Addressing

Adapter recipients use the `type:id` format instead of DIDs:

```
msg_send(
  recipient: "telegram:123456789",
  content: "Hello from ADF!"
)
```

No `address` is needed for adapter recipients — the runtime routes through the appropriate adapter.

### Telegram Adapter

The built-in Telegram adapter uses a bot token to connect via long-polling.

**Setup:**

1. Create a Telegram bot via [@BotFather](https://t.me/BotFather) and get a bot token
2. In ADF Studio, go to **Settings > Channel Adapters**
3. Store the `TELEGRAM_BOT_TOKEN` credential (app-wide or per-agent in `adf_identity`)
4. Enable Telegram for the agent in its configuration

**Inbound features:**

- Text messages from DMs and groups
- Photo and document attachments (downloaded and stored in `imported/telegram/`)
- Reply threading — Telegram reply-to references are mapped to ADF `parent_id`
- Policy filtering for DMs (`all`, `allowlist`, `none`) and groups (`all`, `mention`, `none`)

**Outbound features:**

- Text replies to Telegram chats with automatic markdown formatting (bold, italic, code, links converted to HTML)
- File attachments: GIFs sent as animations, images as photos (with document fallback), other files as documents
- Reply threading — outbox messages with `parent_id` referencing a Telegram inbound message are sent as Telegram replies
- Falls back to plain text if markdown conversion fails

### Email Adapter

The built-in Email adapter connects agents to standard email accounts via IMAP (inbound) and SMTP (outbound). It works with any email provider that supports IMAP/SMTP with password authentication — including Gmail, iCloud, Outlook, Fastmail, Yahoo, and self-hosted servers.

**How it works:**

- **Inbound:** Connects to the IMAP server and fetches unseen messages. On startup, all unseen emails are ingested. While running, the adapter polls every 60 seconds for new messages. Messages are marked as `\Seen` after processing so they won't be re-fetched.
- **Outbound:** Sends email via SMTP. Message bodies are sent as multipart (plain text + Markdown→HTML). Reply threading uses `In-Reply-To` and `References` headers from the parent inbox message.

**Supported providers:**

Provider settings (IMAP/SMTP hosts and ports) are auto-detected from the email address domain:

| Provider | Domains | Notes |
|----------|---------|-------|
| Gmail | `gmail.com`, `googlemail.com` | Requires [app-specific password](https://myaccount.google.com/apppasswords) (2FA must be enabled) |
| iCloud | `icloud.com`, `me.com`, `mac.com` | Requires [app-specific password](https://support.apple.com/en-us/102654) |
| Outlook | `outlook.com`, `hotmail.com`, `live.com` | App-specific password or OAuth |
| Fastmail | `fastmail.com`, `fastmail.fm` | App-specific password |
| Yahoo | `yahoo.com` | App-specific password |
| Other | Any domain | Falls back to `imap.{domain}:993` / `smtp.{domain}:465` |

Custom IMAP/SMTP settings can be provided via the adapter `config` object to override auto-detection.

**Setup:**

1. Enable 2FA on your email account (required for app-specific passwords on most providers)
2. Generate an app-specific password from your provider's security settings
3. In ADF Studio, go to **Settings > Channel Adapters**
4. Add the Email adapter and store two credentials:
   - `EMAIL_USERNAME` — Your full email address (e.g., `agent@gmail.com`)
   - `EMAIL_PASSWORD` — The app-specific password (not your regular password)
5. Enable Email for the agent in its configuration

**Per-agent configuration:**

The adapter can be configured per-agent. The `config` object is optional — without it, settings are auto-detected from the email address:

```json
{
  "adapters": {
    "email": {
      "enabled": true,
      "config": {
        "address": "agent@example.com",
        "imap": { "host": "imap.example.com", "port": 993 },
        "smtp": { "host": "smtp.example.com", "port": 465 },
        "poll_interval": 30000,
        "idle": true
      },
      "policy": {
        "dm": "all",
        "allow_from": []
      },
      "limits": {
        "max_attachment_size": 26214400
      }
    }
  }
}
```

| Config Field | Default | Description |
|-------------|---------|-------------|
| `config.address` | `EMAIL_USERNAME` | Email address (defaults to the username credential) |
| `config.imap` | Auto-detected | IMAP host and port |
| `config.smtp` | Auto-detected | SMTP host and port |
| `config.poll_interval` | `30000` | Polling interval in ms (used in poll-only mode) |
| `config.idle` | `true` | Use IMAP IDLE with polling fallback; set `false` for poll-only mode |

**Inbound features:**

- Plain text and HTML emails (HTML auto-converted to plain text via `html-to-text`)
- Email subject mapped to inbox `subject` column
- Attachments downloaded to `imported/email_{sender}/` with size limits
- Threading via `References` and `In-Reply-To` headers → `thread_id` and `parent_id`
- Dedup via IMAP `\Seen` flag — processed messages are not re-fetched
- Policy filtering: `dm` mode with `all`, `allowlist`, or `none` (email has no group concept)
- `source_context` captures `message_id`, `to`, `cc`, `in_reply_to`, `references` for reply routing
- `original_message` stores the raw RFC 822 email source for forensic access

**Outbound features:**

- Sends as multipart: plain text + Markdown→HTML
- Reply threading: `In-Reply-To` and `References` headers from parent inbox message
- Subject handling: uses outbox `subject`, adds `Re:` prefix for replies
- File attachments via SMTP
- **CC/BCC/Reply-All** via `message_meta` routing hints (see below)

**Addressing:**

```
msg_send(
  recipient: "email:alice@example.com",
  content: "Hello from ADF!",
  subject: "Greetings"
)
```

#### Email Routing Hints

When sending email, agents can use `message_meta` to control CC, BCC, and reply-all behavior. These routing hints are passed separately from the inbound `source_context` to avoid collisions — the adapter reads both bags independently.

**Reply-all** — include all original recipients (from `source_context.to` and `source_context.cc`) as CC, excluding the agent's own address and the primary recipient:

```
msg_send(
  parent_id: "inbox-abc123",
  content: "Acknowledged.",
  message_meta: { "reply_all": true }
)
```

**Explicit CC** — add specific addresses to CC (can be combined with `reply_all`):

```
msg_send(
  parent_id: "inbox-abc123",
  content: "Looping in the team.",
  message_meta: { "reply_all": true, "cc": ["team@example.com"] }
)
```

**BCC** — blind carbon copy:

```
msg_send(
  parent_id: "inbox-abc123",
  content: "FYI.",
  message_meta: { "bcc": ["manager@example.com"] }
)
```

**Forward** — send to a new recipient (no `parent_id` needed):

```
msg_send(
  recipient: "email:colleague@example.com",
  content: "Forwarding this for your review...",
  subject: "Fwd: Original Subject"
)
```

| Hint | Type | Description |
|------|------|-------------|
| `reply_all` | `boolean` | Include all original `to` and `cc` recipients as CC on the reply |
| `cc` | `string[]` | Explicit CC addresses (appended to reply-all if both are set) |
| `bcc` | `string[]` | Blind carbon copy addresses |

### Per-Agent Adapter Configuration

Adapters are configured per-agent in the `adapters` section of the agent config:

```json
{
  "adapters": {
    "telegram": {
      "enabled": true,
      "credential_key": "telegram_bot_token",
      "policy": {
        "dm": "all",
        "groups": "mention",
        "allow_from": []
      },
      "limits": {
        "max_attachment_size": 10485760
      }
    }
  }
}
```

| Field | Description |
|-------|-------------|
| `enabled` | Whether the adapter is active for this agent |
| `credential_key` | Key in `adf_identity` for the bot token |
| `policy.dm` | DM handling: `all`, `allowlist`, or `none` |
| `policy.groups` | Group handling: `all`, `mention` (only when @mentioned or replied to), or `none` |
| `policy.allow_from` | Sender IDs to allow when using `allowlist` mode |
| `limits.max_attachment_size` | Max attachment size in bytes (default: 10 MB) |

### Adapter Health and Monitoring

The adapter manager performs health checks every 30 seconds. If an adapter disconnects, it auto-restarts with exponential backoff (2s → 4s → 8s → ... → 60s max, up to 5 retries).

The **Adapter Status Dashboard** (in Settings) shows:

- Connection status per adapter
- Log viewer with up to 500 entries per adapter
- Start/stop/restart controls
