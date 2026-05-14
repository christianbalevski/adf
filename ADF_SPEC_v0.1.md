# ADF File Format Specification

**Version:** 0.1
**Status:** Draft
**Date:** April 2026

The Agent Document Format (`.adf`) is a portable SQLite database that bundles an agent, its memory, configuration, message history, files, contacts, scheduled work, and operational records into a single sovereign artifact.

This specification is intentionally ADF-focused. It defines what an `.adf` file stores and the portable semantics a conforming runtime must honor. It does not define the desktop UI, daemon HTTP API, provider-specific behavior, or container implementation details except where those details are represented in the file.

---

## Table of Contents

1. [Core Principles](#1-core-principles)
2. [The ADF Stack](#2-the-adf-stack)
3. [Storage Format](#3-storage-format)
4. [Virtual Filesystem and Metadata](#4-virtual-filesystem-and-metadata)
5. [Agent Configuration](#5-agent-configuration)
6. [States and Loop Behavior](#6-states-and-loop-behavior)
7. [Triggers and Timers](#7-triggers-and-timers)
8. [Security, Identity, and Authorization](#8-security-identity-and-authorization)
9. [Code Execution and Lambdas](#9-code-execution-and-lambdas)
10. [Tool Catalog](#10-tool-catalog)
11. [Messaging, Peers, and ALF](#11-messaging-peers-and-alf)
12. [Serving, WebSockets, and Middleware](#12-serving-websockets-and-middleware)
13. [Memory, Audit, Tasks, and Logs](#13-memory-audit-tasks-and-logs)
14. [Defaults](#14-defaults)
15. [Spec Boundary](#15-spec-boundary)
16. [Portability](#16-portability)
17. [Migration from v0.3](#17-migration-from-v03)
18. [Version History](#18-version-history)

---

## 1. Core Principles

### 1.1 Sovereignty

Each ADF is an autonomous entity. It owns its document, memory, configuration, local database tables, inbox, outbox, contacts, timers, logs, and audit history. Other agents influence it through messages, never by direct file or table access. A human owner can modify anything; an agent can modify itself only through tools and runtime-enforced policies.

### 1.2 Spec Stores, Runtime Executes

The ADF file stores declarative state and durable records. The runtime executes code, connects providers, runs MCP servers, evaluates triggers, schedules timers, serves HTTP, and delivers messages. Runtime choices are portable only when represented in `adf_config`, `adf_meta`, or protected ADF tables.

### 1.3 One Agent, One Document

The canonical v0.1 primary document is `document.md`. It serves as the agent's readme that explains what it can do and how one should interact wiht it. Each ADF has exactly one primary document and one `mind.md` working-memory file. Supporting files live in `adf_files` and are subordinate to the primary document.

### 1.4 Asynchrony

Agent-to-agent communication is store-and-forward. Messages are persisted in `adf_outbox` and `adf_inbox`; delivery transport is a runtime concern. This supports offline operation, local fast paths, relays, channel adapters, and high-latency networks.

### 1.5 No Secrets in Context

Any prompt or dynamic instruction content injected into an LLM turn must be observable. System prompt snapshots, dynamic instructions, compaction summaries, and explicit context injections are persisted in `adf_loop` as regular loop entries.

### 1.6 Cold Path and Hot Path

ADF separates:

- **Cold path:** the LLM loop, used for reasoning, new work, tool calls, and human interaction.
- **Hot path:** lambdas, triggers, timers, middleware, API routes, and WebSocket handlers, used for deterministic repeated work.

The file format supports agents that gradually move repeated cold-path workflows into hot-path code stored in `adf_files`.

---

## 2. The ADF Stack

| Layer | Component | Description |
|-------|-----------|-------------|
| User Interface | ADF Studio | Visual IDE for creating, configuring, editing, and observing `.adf` files |
| Headless Runtime | ADF Daemon | Local API runtime for loading agents, background operation, automation, and service deployment |
| Command Line | ADF CLI | Headless interface for creating, inspecting, and running agents |
| Network | ADF Mesh | Discovery and transport layer for local and remote agents |
| Protocol | ALF | Agentic Lingua Franca message and agent-card format |
| Runtime | ADF Runtime | Code that enforces this spec and executes configured behavior |
| Spec | ADF Specification | This document |
| Data | `.adf` file | SQLite database that stores the agent |

Studio, daemon, and CLI are clients of the same file format. A conforming runtime may implement any subset of runtime surfaces, but it must preserve the file semantics described here.

---

## 3. Storage Format

An `.adf` file is a SQLite 3 database. Text is UTF-8. Timestamps in system tables are Unix milliseconds unless a column explicitly says it stores an ISO string.

### 3.1 SQLite Pragmas

Applied on open:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
```

### 3.2 Protected Schema

Tables prefixed with `adf_` are system tables. Agents may read some system tables through tools, but they may not directly write, drop, or alter any `adf_` table. All mutation goes through tools, lambdas, or owner/runtime operations.

Required metadata rows:

| Key | Value | Protection |
|-----|-------|------------|
| `adf_version` | `0.4` | `readonly` |
| `adf_schema_version` | `21` | `readonly` |

The current protected schema is:

```sql
CREATE TABLE IF NOT EXISTS adf_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  protection TEXT NOT NULL DEFAULT 'none'
    CHECK(protection IN ('none','readonly','increment'))
);

CREATE TABLE IF NOT EXISTS adf_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  config_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS adf_loop (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,
  content_json TEXT NOT NULL,
  model TEXT,
  tokens TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS adf_inbox (
  id TEXT PRIMARY KEY,
  message_id TEXT,
  "from" TEXT NOT NULL,
  "to" TEXT,
  reply_to TEXT,
  network TEXT DEFAULT 'devnet',
  thread_id TEXT,
  parent_id TEXT,
  subject TEXT,
  content TEXT NOT NULL,
  content_type TEXT,
  attachments TEXT,
  meta TEXT,
  sender_alias TEXT,
  recipient_alias TEXT,
  owner TEXT,
  card TEXT,
  return_path TEXT,
  source TEXT DEFAULT 'mesh',
  source_context TEXT,
  sent_at INTEGER,
  received_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'unread',
  original_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_adf_inbox_status ON adf_inbox(status);
CREATE INDEX IF NOT EXISTS idx_adf_inbox_received ON adf_inbox(received_at);
CREATE INDEX IF NOT EXISTS idx_adf_inbox_thread ON adf_inbox(thread_id);
CREATE INDEX IF NOT EXISTS idx_adf_inbox_from ON adf_inbox("from");
CREATE INDEX IF NOT EXISTS idx_adf_inbox_source ON adf_inbox(source);
CREATE INDEX IF NOT EXISTS idx_adf_inbox_message_id ON adf_inbox(message_id);

CREATE TABLE IF NOT EXISTS adf_outbox (
  id TEXT PRIMARY KEY,
  message_id TEXT,
  "from" TEXT NOT NULL,
  "to" TEXT NOT NULL,
  address TEXT DEFAULT '',
  reply_to TEXT,
  network TEXT DEFAULT 'devnet',
  thread_id TEXT,
  parent_id TEXT,
  subject TEXT,
  content TEXT NOT NULL,
  content_type TEXT,
  attachments TEXT,
  meta TEXT,
  sender_alias TEXT,
  recipient_alias TEXT,
  owner TEXT,
  card TEXT,
  return_path TEXT,
  status_code INTEGER,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  original_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_adf_outbox_status ON adf_outbox(status);
CREATE INDEX IF NOT EXISTS idx_adf_outbox_thread ON adf_outbox(thread_id);
CREATE INDEX IF NOT EXISTS idx_adf_outbox_message_id ON adf_outbox(message_id);

CREATE TABLE IF NOT EXISTS adf_timers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_json TEXT NOT NULL,
  next_wake_at INTEGER NOT NULL,
  payload TEXT,
  scope TEXT NOT NULL DEFAULT '["system"]',
  lambda TEXT,
  warm INTEGER NOT NULL DEFAULT 0,
  run_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_fired_at INTEGER,
  locked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_adf_timers_wake ON adf_timers(next_wake_at);

CREATE TABLE IF NOT EXISTS adf_files (
  path TEXT PRIMARY KEY,
  content BLOB NOT NULL,
  mime_type TEXT,
  size INTEGER NOT NULL,
  protection TEXT NOT NULL DEFAULT 'none'
    CHECK(protection IN ('read_only','no_delete','none')),
  authorized INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS adf_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  entry_count INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  data BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_adf_audit_source ON adf_audit(source);

CREATE TABLE IF NOT EXISTS adf_identity (
  purpose TEXT PRIMARY KEY,
  value BLOB NOT NULL,
  encryption_algo TEXT DEFAULT 'plain',
  salt BLOB,
  kdf_params TEXT,
  code_access INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS adf_tasks (
  id TEXT PRIMARY KEY,
  tool TEXT NOT NULL,
  args TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  origin TEXT,
  requires_authorization INTEGER NOT NULL DEFAULT 0,
  executor_managed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_adf_tasks_status ON adf_tasks(status);

CREATE TABLE IF NOT EXISTS adf_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL DEFAULT 'info',
  origin TEXT,
  event TEXT,
  target TEXT,
  message TEXT NOT NULL,
  data TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_adf_logs_level ON adf_logs(level);
CREATE INDEX IF NOT EXISTS idx_adf_logs_origin ON adf_logs(origin);

```

### 3.3 User Schema

Agents may create tables that do not start with `adf_`. The recommended prefix is `local_`. Runtime tools may require the `local_` prefix for writes even if SQLite itself could store other names.

```sql
CREATE TABLE local_subscribers (
  agent_id TEXT,
  topic TEXT,
  subscribed_at INTEGER
);
```

Runtimes SHOULD load sqlite-vec when available so agents can create vector tables with `CREATE VIRTUAL TABLE local_embeddings USING vec0(...)`.

### 3.4 Schema Migration

`adf_schema_version` in `adf_meta` is the canonical schema version. Runtimes MUST apply migrations sequentially and MUST NOT silently downgrade a newer schema. If a runtime cannot open a newer schema, it should fail read-only or refuse to open with a clear error.

---

## 4. Virtual Filesystem and Metadata

### 4.1 Reserved Files

| Path | Protection | Description |
|------|------------|-------------|
| `document.md` | `no_delete` | Primary document and shared human-agent artifact |
| `mind.md` | `no_delete` | Agent working memory |
| `public/*` | `none` | Static files eligible for public serving |
| `lib/*` | `none` | Recommended location for lambdas and support scripts |

Recommended but not reserved:

| Path | Purpose |
|------|---------|
| `data/` | Agent-managed data files |
| `imports/` or `imported/` | Received attachments and imported external files |
| `mcp/` | Files saved from MCP tool media or resources |

### 4.2 File Protection

`adf_files.protection` controls agent tool access:

| Level | Read | Write | Delete | Description |
|-------|------|-------|--------|-------------|
| `read_only` | No | No | No | Fully locked from agent access |
| `no_delete` | Yes | Yes | No | Mutable but cannot be deleted |
| `none` | Yes | Yes | Yes | Fully mutable |

Core files `document.md` and `mind.md` use `no_delete` by default. `read_only` always blocks agent writes, even when protected writes are otherwise allowed.

### 4.3 File Authorization

`adf_files.authorized` is a trust flag for code provenance. It is not a file protection level.

- `authorized = 1` means the owner, runtime, or already-authorized code has approved the file as trusted code.
- Any agent write to an authorized file MUST clear `authorized` back to `0`.
- Authorized files may call restricted tools and restricted code methods as described in Section 8.

### 4.4 Meta Protection

`adf_meta.protection` controls agent access to metadata keys:

| Level | Read | Write | Delete | Description |
|-------|------|-------|--------|-------------|
| `none` | Yes | Yes | Yes | Agent-managed metadata |
| `readonly` | Yes | No | No | System or owner-managed metadata |
| `increment` | Yes | Increment only | No | Monotonic numeric counters |

System keys prefixed with `adf_` SHOULD be `readonly`. Common system keys include `adf_version`, `adf_schema_version`, `adf_created_at`, `adf_updated_at`, `adf_did`, `adf_handle`, and `adf_parent_did`.

---

## 5. Agent Configuration

Configuration is stored as JSON in `adf_config.config_json`. It is a single-row table (`id = 1`). Runtimes MUST validate the JSON before use and MUST preserve unknown forward-compatible fields unless explicitly migrating them.

### 5.1 Top-Level Shape

```jsonc
{
  "adf_version": "0.4",
  "id": "a1b2c3d4e5f6",
  "name": "dashboard",
  "description": "Monitors system health",
  "icon": "D",
  "handle": "dashboard",
  "card": {
    "endpoints": {
      "inbox": "https://relay.example.com/dashboard/mesh/inbox",
      "card": "https://relay.example.com/dashboard/mesh/card",
      "health": "https://relay.example.com/dashboard/mesh/health",
      "ws": "wss://relay.example.com/dashboard/mesh/ws"
    },
    "resolution": { "method": "self" }
  },

  "state": "idle",
  "start_in_state": "idle",
  "loop_mode": "interactive",
  "autonomous": false,
  "autostart": false,

  "model": {
    "provider": "anthropic",
    "model_id": "claude-sonnet-4-5-20250929",
    "temperature": 0.7,
    "max_tokens": 4096,
    "top_p": null,
    "thinking_budget": null,
    "multimodal": {
      "image": false,
      "audio": false,
      "video": false
    },
    "params": [],
    "provider_params": {}
  },

  "instructions": "Help the user with their request.",
  "include_base_prompt": true,

  "context": {
    "document_mode": "agentic",
    "mind_mode": "included",
    "compact_threshold": 80000,
    "max_loop_messages": null,
    "audit": {
      "loop": false,
      "inbox": false,
      "outbox": false,
      "files": false
    },
    "dynamic_instructions": {
      "inbox_hints": true,
      "context_warning": true,
      "idle_reminder": true,
      "mesh_updates": true
    }
  },

  "tools": [],
  "triggers": {},
  "security": {},
  "limits": {},
  "messaging": {},
  "audit": {},
  "code_execution": {},
  "logging": {},
  "mcp": {},
  "compute": {},
  "adapters": {},
  "serving": {},
  "ws_connections": [],
  "providers": [],
  "locked_fields": [],

  "metadata": {
    "created_at": "2026-04-01T00:00:00.000Z",
    "updated_at": "2026-04-01T00:00:00.000Z",
    "author": "user",
    "tags": [],
    "version": "1.0.0"
  }
}
```

### 5.2 Identity Fields

| Field | Description |
|-------|-------------|
| `id` | Agent identity. Defaults to a 12-character nanoid. Upgrades permanently to DID when cryptographic identity is provisioned. |
| `name` | Human-friendly name used in UI and discovery. |
| `description` | Public capability summary used in discovery and agent cards. |
| `icon` | Optional display icon or short label. |
| `handle` | URL-safe slug for mesh serving. Lowercase letters, numbers, and hyphens. |
| `card` | Optional public card endpoint/resolution overrides. |

### 5.3 State and Loop Configuration

Canonical v0.4 fields:

| Field | Values | Description |
|-------|--------|-------------|
| `state` | `active`, `idle`, `hibernate`, `suspended`, `error`, `off` | Last persisted display state. Runtime may keep the live executor state in memory. |
| `start_in_state` | `active`, `idle`, `hibernate`, `off` | State entered when the runtime loads the agent. |
| `loop_mode` | `interactive`, `autonomous` | LLM turn behavior. |
| `autostart` | boolean | Runtime should start this agent on boot if possible. |

Compatibility: existing files may use `autonomous: true|false` instead of `loop_mode`. Runtimes MUST interpret `autonomous: true` as `loop_mode: "autonomous"` and `autonomous: false` as `loop_mode: "interactive"` when `loop_mode` is absent.

### 5.4 Tool Declarations

```jsonc
{
  "name": "fs_read",
  "enabled": true,
  "restricted": false,
  "locked": false
}
```

| Field | Description |
|-------|-------------|
| `name` | Built-in tool name, MCP tool name (`mcp:<server>:<tool>`), or custom runtime tool name. |
| `enabled` | If true, visible to the LLM loop. |
| `restricted` | If true, only authorized code can call freely; LLM loop calls require HIL when enabled. |
| `locked` | If true, the agent cannot modify this declaration through config tools. |

### 5.5 Triggers

Triggers are configured by event type. Each trigger has `enabled`, optional `locked`, and a `targets` array:

```jsonc
{
  "triggers": {
    "on_inbox": {
      "enabled": true,
      "targets": [
        { "scope": "agent", "interval_ms": 30000 },
        { "scope": "system", "lambda": "lib/router.ts:onInbox", "batch_ms": 100 }
      ]
    }
  }
}
```

See Section 7 for required trigger semantics.

### 5.6 Security Configuration

```jsonc
{
  "security": {
    "allow_unsigned": true,
    "allow_protected_writes": false,
    "level": 0,
    "require_signature": false,
    "require_payload_signature": false,
    "middleware": {
      "inbox": [{ "lambda": "lib/mw.ts:inbox" }],
      "outbox": [{ "lambda": "lib/mw.ts:outbox" }]
    },
    "fetch_middleware": [{ "lambda": "lib/mw.ts:fetch" }],
    "require_middleware_authorization": true
  }
}
```

`allow_protected_writes` is retained for compatibility with older configuration panels. It never permits writes to `read_only` files.

### 5.7 Limits

```jsonc
{
  "limits": {
    "execution_timeout_ms": 5000,
    "max_loop_rows": 500,
    "max_daily_budget_usd": null,
    "max_file_read_tokens": 30000,
    "max_file_write_bytes": 5000000,
    "max_tool_result_tokens": 16000,
    "max_active_turns": null,
    "max_image_size_bytes": 5242880,
    "max_audio_size_bytes": 10485760,
    "max_video_size_bytes": 20971520,
    "suspend_timeout_ms": 1200000,
    "hibernate_nudge": {
      "enabled": true,
      "interval_ms": 86400000
    }
  }
}
```

### 5.8 Messaging Configuration

```jsonc
{
  "messaging": {
    "receive": false,
    "mode": "respond_only",
    "visibility": "localhost",
    "inbox_mode": false,
    "allow_list": [],
    "block_list": [],
    "network": "devnet"
  }
}
```

| Mode | Behavior |
|------|----------|
| `proactive` | Can send messages at any time. |
| `respond_only` | Can reply to a valid parent message or during an inbox-triggered turn. |
| `listen_only` | Cannot send. |

| Visibility | Who can see and reach the agent |
|------------|---------------------------------|
| `directory` | Agents on the same runtime in ancestor directories (same dir counts). |
| `localhost` (default) | Any agent on the same machine. |
| `lan` | Any agent on the local network. |
| `off` | Nobody — no enumeration, no inbound delivery. Outbound sends still allowed. |

Tiers are strictly nested: `lan ⊃ localhost ⊃ directory`. Visibility is enforced on two surfaces — the inbox handler and the `/mesh/directory` endpoint — and the runtime's network binding is derived from the highest declared tier (any `lan`-tier agent binds `0.0.0.0`; otherwise loopback). Public internet reachability is not a tier: agents that want public reach register with a relay or expose themselves behind a public endpoint via `card.endpoints` overrides.

### 5.9 Code Execution Configuration

```jsonc
{
  "code_execution": {
    "model_invoke": true,
    "sys_lambda": true,
    "task_resolve": true,
    "loop_inject": true,
    "get_identity": true,
    "set_identity": true,
    "network": false,
    "packages": [{ "name": "vega-lite", "version": "^5.21.0" }],
    "restricted_methods": ["get_identity", "model_invoke"]
  }
}
```

### 5.10 Logging Configuration

```jsonc
{
  "logging": {
    "default_level": "info",
    "max_rows": 10000,
    "rules": [
      { "origin": "serving", "min_level": "error" },
      { "origin": "lambda*", "min_level": "warn" }
    ]
  }
}
```

### 5.11 MCP Configuration

```jsonc
{
  "mcp": {
    "servers": [
      {
        "name": "github",
        "transport": "stdio",
        "command": "node",
        "args": ["server.js"],
        "env": {},
        "env_keys": ["GITHUB_TOKEN"],
        "npm_package": "@modelcontextprotocol/server-github",
        "source": "npm:@modelcontextprotocol/server-github",
        "tool_call_timeout_ms": 60000,
        "restricted": false,
        "run_location": "shared",
        "available_tools": []
      }
    ]
  }
}
```

MCP configurations travel with the file. Installed server binaries, app-wide credentials, process supervisors, and scratch directories are runtime concerns.

### 5.12 Compute Configuration

```jsonc
{
  "compute": {
    "enabled": false,
    "host_access": false,
    "packages": {
      "npm": [],
      "pip": []
    }
  }
}
```

`compute.enabled` requests an isolated agent compute environment. `compute.host_access` requests host execution and MUST be paired with a runtime-level host-access gate.

### 5.13 Channel Adapter Configuration

```jsonc
{
  "adapters": {
    "telegram": {
      "enabled": true,
      "credential_key": "telegram_bot_token",
      "config": {},
      "policy": {
        "dm": "all",
        "groups": "mention",
        "allow_from": []
      },
      "limits": {
        "max_attachment_size": 10485760
      }
    },
    "email": {
      "enabled": true,
      "credential_key": "email_credentials",
      "config": {
        "address": "agent@example.com",
        "poll_interval": 30000,
        "idle": true
      }
    }
  }
}
```

Adapters normalize external platform messages into `adf_inbox` and deliver `adf_outbox` rows to platform APIs. Credentials SHOULD be stored in `adf_identity`.

### 5.14 Serving Configuration

```jsonc
{
  "serving": {
    "public": { "enabled": true, "index": "index.html" },
    "shared": { "enabled": true, "patterns": ["reports/*.html"] },
    "api": [
      {
        "method": "GET",
        "path": "/status",
        "lambda": "lib/api.ts:getStatus",
        "warm": true,
        "cache_ttl_ms": 1000,
        "middleware": [{ "lambda": "lib/auth.ts:check" }],
        "locked": false
      },
      {
        "method": "WS",
        "path": "/ws",
        "lambda": "lib/ws.ts:onEvent"
      }
    ]
  }
}
```

### 5.15 WebSocket Connections

```jsonc
{
  "ws_connections": [
    {
      "id": "relay",
      "url": "wss://relay.example.com/me/mesh/ws",
      "did": "did:adf:relay",
      "enabled": true,
      "lambda": "lib/ws.ts:onEvent",
      "auth": "auto",
      "auto_reconnect": true,
      "reconnect_delay_ms": 5000,
      "keepalive_interval_ms": 30000
    }
  ]
}
```

### 5.16 Provider Overrides

```jsonc
{
  "providers": [
    {
      "id": "custom:local",
      "type": "openai-compatible",
      "name": "Local Model",
      "baseUrl": "http://localhost:11434/v1",
      "defaultModel": "llama",
      "params": [],
      "requestDelayMs": 0
    }
  ]
}
```

Provider definitions are file-carried preferences. Runtime credential storage and authentication are runtime concerns unless credentials are stored in `adf_identity`.

### 5.17 Locked Fields

`locked_fields` is an array of top-level or dot-path config fields the agent cannot modify through `sys_update_config`. The fields `adf_version`, `id`, `metadata`, `locked_fields`, `providers`, `restricted`, `restricted_methods`, and `locked` are owner-only boundaries and MUST NOT be self-modifiable by the agent.

---

## 6. States and Loop Behavior

### 6.1 Agent States

| State | Description | Agent-scope wake behavior |
|-------|-------------|---------------------------|
| `active` | LLM loop is currently running | Already running |
| `idle` | Responsive idle state | Wakes for chat, inbox, file changes, timers |
| `hibernate` | Deep idle | Wakes for timers only |
| `suspended` | Runtime safety block | Owner approval only |
| `error` | Structural executor failure visible to user | Direct user message may recover |
| `off` | Fully stopped | No triggers; manual restart required |

`off` is a hard stop. A runtime transitioning an agent to `off` MUST tear down runtime resources for that agent: active LLM request, pending triggers, mesh registration, MCP server connections, adapters, WebSocket connections, and code sandboxes.

### 6.2 State Transitions

| Actor | Can set |
|-------|---------|
| LLM via `sys_set_state` | `idle`, `hibernate`, `off` |
| Lambda via `adf.sys_set_state` | `idle`, `hibernate`, `off` |
| Runtime | `active`, `suspended`, `error`, `off` |
| Owner | Any state through trusted UI/runtime controls |

When a trigger wakes an agent from `idle` or `hibernate`, the runtime records the previous idle state, enters `active`, runs the loop, and returns to the previous idle state unless `sys_set_state` set a different target.

`error` is reserved for **structural** failures — the executor itself is broken (corrupt session, bad code path, tool registry fault). Transient external failures (provider rate limits, provider 5xx, network timeouts, connection resets) are operational and MUST return the agent to `idle` so timers and triggers can retry. A runtime SHOULD log transient failures to `adf_logs` with `level="warn"` and `event="provider_error"`, distinct from structural failures logged with `level="error"` and `event="turn_error"`, so agent code can distinguish the two categories through `db_*` queries.

### 6.3 Loop Modes

Canonical field: `loop_mode`.

Compatibility field: `autonomous`.

| Behavior | Interactive | Autonomous |
|----------|-------------|------------|
| Raw assistant text / `respond` | Ends turn | Logs output, turn continues |
| `say` | Continues turn | Continues turn |
| `ask` | Pauses for human answer | Not available or strongly discouraged |
| `sys_set_state` | Ends loop and changes state | Ends loop and changes state |
| `max_active_turns` reached | Suspends | Suspends |

If a human sends a new message while an agent is active, the runtime MAY abort the current turn and restart with the new user input.

---

## 7. Triggers and Timers

### 7.1 Trigger Types

| Trigger | Event |
|---------|-------|
| `on_startup` | Agent starts |
| `on_inbox` | Message arrives in `adf_inbox` |
| `on_outbox` | Message is sent from `adf_outbox` |
| `on_file_change` | Watched file is created, modified, or deleted |
| `on_chat` | Human sends a loop chat message |
| `on_timer` | Timer fires |
| `on_tool_call` | Matching tool call completes or is denied |
| `on_task_create` | Task is created |
| `on_task_complete` | Task reaches terminal status |
| `on_logs` | Matching log entry is written |

Self-generated events SHOULD NOT recursively trigger the same causal path.

### 7.2 Trigger Targets

```jsonc
{
  "scope": "system",
  "lambda": "lib/router.ts:onInbox",
  "command": null,
  "warm": true,
  "filter": { "source": "telegram" },
  "debounce_ms": 2000,
  "interval_ms": null,
  "batch_ms": null,
  "batch_count": null,
  "locked": false
}
```

| Field | Description |
|-------|-------------|
| `scope` | `system` or `agent` |
| `lambda` | System scope only. File/function reference. |
| `command` | System scope only. Shell command alternative when supported. |
| `warm` | System scope only. Keep sandbox warm. |
| `filter` | Trigger-specific filter. |
| `debounce_ms` | Timing modifier. Mutually exclusive with `interval_ms` and `batch_ms`. |
| `interval_ms` | Timing modifier. |
| `batch_ms` | Timing modifier. |
| `batch_count` | Optional early-fire count, requires `batch_ms`. |
| `locked` | Owner lock for this target. |

### 7.3 Trigger Scopes

| Scope | Description |
|-------|-------------|
| `system` | Runs a lambda or command. Fast path. Fires in all display states except `off`. |
| `agent` | Wakes the LLM loop. Cold path. Gated by state. |

System-scope lambdas receive an event object. Agent-scope targets do not receive the raw event directly; they wake the LLM with a formatted trigger message. For `on_inbox`, the agent receives an inbox summary and uses `msg_read` to fetch messages.

### 7.4 Trigger Filters

| Trigger | Filter fields |
|---------|---------------|
| `on_inbox` | `source`, `sender` |
| `on_outbox` | `to` |
| `on_file_change` | `watch` |
| `on_tool_call` | `tools` |
| `on_task_create` | `tools` |
| `on_task_complete` | `tools`, `status` |
| `on_logs` | `level`, `origin`, `event` |

### 7.5 State Gating

| Current State | System Scope | Agent Scope |
|---------------|--------------|-------------|
| `active` | Fires | Already running |
| `idle` | Fires | Fires |
| `hibernate` | Fires | `on_timer` only |
| `suspended` | Fires | No |
| `error` | Fires unless runtime suppresses for safety | Direct user recovery only |
| `off` | No | No |

### 7.6 Timer Schedules

Timers are stored in `adf_timers`. The API accepts a `schedule` object and stores its resolved form in `schedule_json`.

Input schedule:

```jsonc
{ "type": "once", "at": 1707300300000 }
{ "type": "delay", "delay_ms": 300000 }
{ "type": "interval", "every_ms": 3600000, "start_at": null, "end_at": null, "max_runs": null }
{ "type": "cron", "cron": "0 9 * * 1-5", "end_at": null, "max_runs": null }
```

Resolved storage:

```jsonc
{ "type": "once", "at": 1707300300000 }
{ "type": "interval", "every_ms": 3600000, "start_at": null, "end_at": null, "max_runs": null }
{ "type": "cron", "expr": "0 9 * * 1-5", "end_at": null, "max_runs": null }
```

Timer fields:

| Field | Description |
|-------|-------------|
| `scope` | JSON array: `["system"]`, `["agent"]`, or both |
| `lambda` | System-scope timer lambda |
| `warm` | Keep lambda sandbox warm |
| `payload` | Optional string delivered to handler |
| `locked` | Owner lock preventing agent modification/deletion |

### 7.7 Timer Firing

For a timer to execute, both conditions must be true:

1. The timer's `scope` includes a matching scope.
2. The `on_timer` trigger is enabled and has a target for that scope.

Lifecycle:

1. Increment `run_count`; set `last_fired_at`.
2. Deliver event to matching system and/or agent handlers.
3. Delete one-time timers.
4. For interval/cron timers, compute the next `next_wake_at` or delete if `max_runs` or `end_at` has been reached.

Missed timers fire once on load, then reschedule future occurrences. Runtimes MUST NOT flood all missed occurrences after downtime.

---

## 8. Security, Identity, and Authorization

### 8.1 Identity Model

Every ADF starts with a local nanoid. Cryptographic identity is opt-in and upgrades `config.id` to a DID.

| Tier | Description |
|------|-------------|
| Local identity | 12-character nanoid. Unsigned messages are allowed by default. |
| Cryptographic identity | Ed25519 keypair in `adf_identity`; config ID is DID; outbound ALF messages and cards can be signed. |

Once a cryptographic DID is provisioned, runtimes MUST NOT downgrade it back to a nanoid.

### 8.2 Identity Store

`adf_identity` is a general-purpose secret store. Common purposes:

| Purpose | Description |
|---------|-------------|
| `crypto:signing:private_key` | Ed25519 private key |
| `crypto:signing:public_key` | Ed25519 public key |
| `crypto:kdf:salt` | Password KDF salt |
| `crypto:kdf:params` | Password KDF params |
| `mcp:<server>:<key>` | MCP server credential |
| `openai_key`, `anthropic_key`, custom keys | Provider or application secrets |

`code_access` indicates whether code execution may read a row through identity APIs.

Public keys are stored as ordinary identity rows, not as a special column. This keeps `adf_identity` a uniform `purpose -> value` store and avoids a nullable column that only applies to one key family. Runtimes that need public identity without unlocking the file should use `adf_meta` readonly keys, the signed agent card, or a plain `crypto:signing:public_key` row according to their security policy.

### 8.3 Encryption at Rest

Encrypted identity rows use:

- Cipher: AES-256-GCM
- IV: 12 bytes, stored in `salt` for the encrypted row
- Auth tag: included with ciphertext according to runtime encoding
- KDF: PBKDF2, 100,000 iterations, SHA-512, 32-byte salt
- KDF params: JSON in `kdf_params` and/or `crypto:kdf:params`

Rows with `encryption_algo = 'plain'` are unencrypted. Runtimes SHOULD warn before exporting or sharing files that contain plain secrets.

### 8.4 Locked vs. Unlocked

When encrypted identity rows exist:

| State | Capabilities |
|-------|--------------|
| Locked | May read public file/config data, receive messages, and serve public files; cannot decrypt secrets or sign messages. |
| Unlocked | Full access to signing and secret-dependent runtime operations. |

Password-derived keys are held in memory and never persisted unencrypted.

### 8.5 Message Security

`security.allow_unsigned: true` allows unsigned local/dev messages. Internet-facing agents SHOULD set `allow_unsigned: false` and provision cryptographic identity.

`security.level` is an advisory security level:

| Level | Meaning |
|-------|---------|
| `0` | Open / unsigned allowed |
| `1` | Signed |
| `2` | Signed and encrypted |
| `3` | Advanced custom middleware/policy |

### 8.6 Authorized Code

Authorized code is file-level trust. A file with `authorized = 1` may call restricted tools and restricted code methods without HIL. Unauthorized code may not.

Invocation rules:

| Invocation | Authorization |
|------------|---------------|
| `sys_code` inline | Always unauthorized |
| LLM calls `sys_lambda` targeting unauthorized file | Runs unauthorized |
| LLM calls `sys_lambda` targeting authorized file | Requires HIL; approved run is authorized |
| Authorized code calls authorized file | Allowed; target runs authorized |
| Unauthorized code calls authorized file | Blocked |
| Trigger/timer/API/middleware lambda | Based on source file's `authorized` flag |

Any write to an authorized file deauthorizes it.

### 8.7 Restricted Tools and Methods

Tool access matrix:

| `enabled` | `restricted` | LLM loop | Authorized code | Unauthorized code |
|-----------|--------------|----------|-----------------|-------------------|
| false | false | Off | Off | Off |
| true | false | Free | Free | Free |
| false | true | Off | Free | Off |
| true | true | HIL | Free | Off |

`code_execution.restricted_methods` applies the same authorized-code rule to code-only methods such as `get_identity`, `set_identity`, `model_invoke`, `loop_inject`, and `authorize_file`.

---

## 9. Code Execution and Lambdas

All code execution contexts run in a sandbox. The spec defines their ADF-visible semantics, not the exact sandbox implementation.

| Context | Entry | State persistence | Authorization source | Receives |
|---------|-------|-------------------|----------------------|----------|
| `sys_code` | LLM tool call | Persistent per agent | Always unauthorized | Code string |
| `sys_lambda` | LLM/tool/code call | Fresh by default | Target/caller/HIL rules | Args object |
| Trigger lambda | System target | Fresh unless warm | Source file flag | Event object |
| Timer lambda | Timer system scope | Fresh unless warm | Source file flag | Timer event |
| API route | Serving route | Fresh unless warm | Source file flag | HTTP request |
| Middleware | Pipeline point | Fresh by point | Source file flag | Middleware input |
| WebSocket lambda | WS event | Warm for connection lifetime | Source file flag | WS event |

Every code context gets an async `adf` proxy object. Calls use a single object argument:

```javascript
await adf.fs_read({ path: "document.md" })
await adf.msg_send({ parent_id: "inbox-1", content: "Acknowledged" })
```

Special code-only methods include:

| Method | Description |
|--------|-------------|
| `model_invoke` | Invoke the configured model from code |
| `sys_lambda` | Call another file function |
| `task_resolve` | Approve, deny, or transition tasks |
| `loop_inject` | Persist a context block into `adf_loop` |
| `get_identity` | Read identity values allowed for code |
| `set_identity` | Store identity values when enabled |
| `authorize_file` | Authorized-code-only file authorization |
| `set_meta_protection` | Authorized-code-only metadata protection change |
| `set_file_protection` | Authorized-code-only file protection change |

Native network access from sandbox code SHOULD be disabled unless `code_execution.network` is enabled. Portable code should use `adf.sys_fetch()` so fetch middleware applies.

---

## 10. Tool Catalog

Tool names are part of the ADF contract. Tool schemas may evolve, but runtimes SHOULD preserve the following meanings.

### 10.1 Turn Tools

| Tool | Parameters | Description |
|------|------------|-------------|
| `respond` | `message` | Emit final response. Ends turn in interactive mode; continues in autonomous mode. Runtimes may implement raw assistant text as implicit `respond`. |
| `say` | `message` | Emit progress/status without ending the turn. |
| `ask` | `question` | Pause for human input in interactive mode. |

### 10.2 Filesystem Tools

| Tool | Parameters | Description |
|------|------------|-------------|
| `fs_read` | `path`, `start_line?`, `end_line?` | Read VFS file metadata and content. |
| `fs_write` | `path`, `content?`, `old_text?`, `new_text?`, `encoding?`, `mime_type?`, `protection?` | Create, overwrite, or exact-match edit a file. |
| `fs_list` | `prefix?` | List VFS files. |
| `fs_delete` | `path` | Delete mutable file, auditing first if configured. |

### 10.3 Database Tools

| Tool | Description |
|------|-------------|
| `db_query` | Read-only SELECT on allowed tables: `local_*`, `adf_loop`, `adf_inbox`, `adf_outbox`, `adf_timers`, `adf_files`, `adf_audit`, `adf_logs`, `adf_tasks`. |
| `db_execute` | INSERT/UPDATE/DELETE/CREATE/DROP on `local_*` tables only, including `vec0` virtual tables. |

`adf_meta`, `adf_config`, and `adf_identity` are not directly queryable through `db_query`.

### 10.4 Messaging and Peer Tools

| Tool | Description |
|------|-------------|
| `msg_send` | Send by recipient/address or reply by `parent_id`. |
| `msg_read` | Fetch inbox messages and mark returned messages read. |
| `msg_list` | Return inbox counts. |
| `msg_update` | Mark messages `read`, `archived`, or delete when allowed. |
| `msg_delete` | Delete inbox/outbox messages by filter. |
| `agent_discover` | Discover agents reachable from this agent. Honors the caller's and targets' `messaging.visibility` tiers. |

### 10.5 Execution, Network, and Package Tools

| Tool | Description |
|------|-------------|
| `sys_code` | Execute inline JavaScript/TypeScript in sandbox. |
| `sys_lambda` | Call a function in an ADF file. |
| `sys_fetch` | HTTP request with middleware. |
| `npm_install` | Add pure JS/WASM package to `code_execution.packages`. |
| `npm_uninstall` | Remove package from `code_execution.packages`. |
| `mcp_install` | Attach/install MCP server config. |
| `mcp_uninstall` | Detach/remove MCP server config. |

### 10.6 State, Config, and Meta Tools

| Tool | Description |
|------|-------------|
| `sys_set_state` | Transition to `idle`, `hibernate`, or `off`. |
| `sys_get_config` | Return config, agent card, or provider status. |
| `sys_update_config` | Modify unlocked config paths. |
| `sys_create_adf` | Create a child ADF, optionally from template and files. |
| `sys_get_meta` | Read metadata. |
| `sys_set_meta` | Write metadata with protection rules. |
| `sys_delete_meta` | Delete mutable metadata. |

### 10.7 Timer, Loop, Task, and Archive Tools

| Tool | Description |
|------|-------------|
| `sys_set_timer` | Create timer. |
| `sys_list_timers` | List timers. |
| `sys_delete_timer` | Delete unlocked timer. |
| `loop_compact` | Signal runtime to summarize and compact loop. |
| `loop_clear` | Delete loop slice, auditing first if configured. |
| `loop_read` | Read loop entries. |
| `loop_stats` | Return loop stats. |
| `archive_read` | Decompress and read `adf_audit` entry. |

`task_resolve` is a code-only method, not an LLM-loop tool by default.

### 10.8 WebSocket, Compute, and Shell Tools

| Tool | Description |
|------|-------------|
| `ws_connect` | Start configured or ad-hoc WebSocket connection. |
| `ws_disconnect` | Close active connection. |
| `ws_connections` | List active connections. |
| `ws_send` | Send a text frame. |
| `compute_exec` | Run shell command in isolated/shared/host compute target. Restricted by default. |
| `fs_transfer` | Stage/ingest files between VFS and compute target. |
| `adf_shell` | Virtual shell that absorbs many individual tools behind shell commands. |

### 10.9 Cross-Cutting Parameters

| Parameter | Description |
|-----------|-------------|
| `_async: true` | Execute a tool in the background and create an `adf_tasks` row. |
| `_full: true` | Code-execution-only bypass for result limits, currently for large `db_query` results. |

---

## 11. Messaging, Peers, and ALF

### 11.1 ALF Message

ADF uses ALF (Agentic Lingua Franca) as its portable message envelope. Wire messages have:

```jsonc
{
  "version": "1.0",
  "network": "devnet",
  "id": "msg_01HQ9ZxKp4mN7qR2wT",
  "timestamp": "2026-02-28T20:00:00Z",
  "from": "did:adf:alice",
  "to": "did:adf:bob",
  "reply_to": "https://alice.example/alice/mesh/inbox",
  "meta": {
    "owner": "did:adf:owner",
    "card": "https://alice.example/alice/mesh/card"
  },
  "payload": {
    "meta": {},
    "sender_alias": "Alice",
    "recipient_alias": "Bob",
    "thread_id": "thr_abc",
    "parent_id": null,
    "subject": "Status",
    "content_type": "text/plain",
    "content": "Hello",
    "attachments": [],
    "sent_at": "2026-02-28T20:00:00Z",
    "signature": "ed25519:..."
  },
  "signature": "ed25519:...",
  "transit": {}
}
```

`adf_inbox` and `adf_outbox` store a flattened projection of this message plus `original_message`, which may contain the full raw ALF or platform-native source.

### 11.2 Inbox and Outbox Statuses

| Inbox status | Meaning |
|--------------|---------|
| `unread` | New message |
| `read` | Fetched by the agent |
| `archived` | Processed or hidden from active inbox |

| Outbox status | Meaning |
|---------------|---------|
| `pending` | Queued |
| `sent` | Sent to transport |
| `delivered` | Accepted by recipient/runtime |
| `failed` | Delivery failed |

### 11.3 Addressing and Threading

| Field | Description |
|-------|-------------|
| `from`, `to` | DID or adapter-style identity (`telegram:...`, `email:...`). |
| `address` | Outbox delivery URL override. |
| `reply_to` | Sender's reply endpoint. |
| `thread_id` | Conversation group; inherited from parent on replies. |
| `parent_id` | Specific inbox/outbox row being replied to. |

If `parent_id` is provided without explicit recipient/address, the runtime resolves from the referenced inbox message.

### 11.4 Attachments

ALF attachment transfer modes:

| Mode | Meaning |
|------|---------|
| `inline` | Base64 data is present in the message payload. |
| `reference` | URL plus digest and size. |
| `imported` | Storage-only marker after the receiver extracts inline data to `adf_files`. |

Received inline attachments are written to the recipient VFS, typically under `imported/{source}/` or `imports/{sender}/`, and the stored message attachment is updated with `path`.

### 11.5 Agent Card

An agent card is the public identity document exposed by serving runtimes and exchanged in messages.

```jsonc
{
  "did": "did:adf:agent",
  "handle": "monitor",
  "description": "Monitors system resources",
  "icon": "M",
  "public_key": "...",
  "resolution": { "method": "self" },
  "endpoints": {
    "inbox": "https://example.com/monitor/mesh/inbox",
    "card": "https://example.com/monitor/mesh/card",
    "health": "https://example.com/monitor/mesh/health",
    "ws": "wss://example.com/monitor/mesh/ws"
  },
  "mesh_routes": [{ "method": "GET", "path": "/status" }],
  "public": true,
  "shared": ["reports/status.html"],
  "attestations": [],
  "policies": [],
  "signed_at": "2026-04-01T00:00:00.000Z",
  "signature": "ed25519:..."
}
```

**Signature scope.** The `signature` covers identity and policy fields only — specifically, the canonical JSON of all card fields **except** `signature`, `endpoints`, and `resolution.endpoint`. Endpoint URLs are observer-dependent (the directory endpoint rewrites them per-requester so LAN peers receive LAN URLs and loopback peers receive loopback URLs) and are therefore out of scope for the signature. Identity is what the signature protects; endpoints are reachability metadata.

### 11.6 Channel Adapters

Adapters normalize external platforms into inbox/outbox rows. Required storage semantics:

- `source` identifies adapter/runtime origin (`mesh`, `telegram`, `email`, etc.).
- `source_context` stores platform metadata needed for replies.
- `original_message` stores raw platform source where available.
- Adapter credentials SHOULD live in `adf_identity`.

---

## 12. Serving, WebSockets, and Middleware

### 12.1 HTTP Serving

Serving config is portable. The actual host, port, TLS, LAN binding, and daemon/Studio process are runtime concerns.

Resolution order for `/{handle}/...`:

1. `serving.api`
2. `serving.public`
3. `serving.shared`
4. 404

The mesh namespace is reserved:

| Endpoint | Purpose |
|----------|---------|
| `GET /{handle}/mesh/card` | Agent card |
| `GET /{handle}/mesh/health` | Health |
| `POST /{handle}/mesh/inbox` | ALF delivery |
| `GET /{handle}/mesh/ws` | WebSocket upgrade |

Route handlers receive:

```typescript
interface HttpRequest {
  method: string
  path: string
  params: Record<string, string>
  query: Record<string, string>
  headers: Record<string, string>
  body: unknown
}

interface HttpResponse {
  status: number
  headers?: Record<string, string>
  body: unknown
}
```

### 12.2 WebSockets

Inbound WebSockets are configured as `serving.api` routes with `method: "WS"` and a required lambda. Outbound WebSockets are configured in `ws_connections`.

Frames carry one ALF message per text frame unless a route lambda implements custom hot-path handling. Cold-path ALF-over-WS ingress stores messages in `adf_inbox` exactly like HTTP delivery.

WebSocket lambda event:

```typescript
interface WsLambdaEvent {
  type: 'open' | 'message' | 'close' | 'error'
  connection_id: string
  remote_did?: string
  data?: string
  code?: number
  reason?: string
  error?: string
  timestamp: number
}
```

Transport preference for `msg_send` is: local runtime, active WebSocket, HTTP POST. Outbox middleware may override.

### 12.3 Middleware

Middleware references are `{ "lambda": "path/file.ts:functionName" }`.

Pipeline points:

| Point | Config | Data |
|-------|--------|------|
| `route` | `serving.api[].middleware` | `HttpRequest` |
| `inbox` | `security.middleware.inbox` | ALF message before storage |
| `outbox` | `security.middleware.outbox` | Egress context before signing/sending |
| `fetch` | `security.fetch_middleware` | `sys_fetch` params |

Middleware input/output:

```typescript
interface MiddlewareInput {
  point: 'route' | 'inbox' | 'outbox' | 'fetch'
  data: unknown
  meta: Record<string, unknown>
}

interface MiddlewareOutput {
  data?: unknown
  meta?: Record<string, unknown>
  reject?: { code: number; reason: string }
}
```

Middleware runs in array order. If any middleware rejects, the pipeline stops. By default, middleware source files must be authorized; unauthorized middleware is skipped and logged.

---

## 13. Memory, Audit, Tasks, and Logs

### 13.1 Loop Entries

`adf_loop` stores:

- Human messages
- Assistant messages
- Tool calls and results
- Ask/approval interactions
- State transitions
- Context blocks
- Compaction summaries

`content_json` is a JSON array of provider-style content blocks. `tokens` SHOULD store token usage JSON when available.

Context blocks use text prefixes such as:

```text
[Context: system_prompt] ...
[Context: dynamic_instructions] ...
[Context: loop_inject] ...
```

### 13.2 Compaction

`loop_compact` is signal-only in v0.4. The runtime generates a summary using a dedicated compaction prompt, audits deleted rows if configured, deletes old loop entries, and inserts a `[Loop Compacted]` summary entry.

`context.compact_threshold` (default 100000) is the single source of truth for the compaction threshold. The legacy `limits.compaction_threshold_tokens` field has been removed; runtimes silently drop it from old configs.

### 13.3 Audit

`adf_audit` stores brotli-compressed snapshots before destructive operations when enabled.

Sources:

| Source | Stored data |
|--------|-------------|
| `loop` | Deleted loop rows |
| `inbox` | Deleted inbox rows |
| `outbox` | Deleted outbox rows |
| `inbox_message` | Full inbound ALF before attachment extraction/tombstoning |
| `outbox_message` | Full outbound ALF before attachment extraction/tombstoning |
| `file` | Deleted file content and metadata |

`adf_audit` is append-only from the agent perspective. Runtime/owner tools may expose archive reads, but agents must not directly mutate audit entries.

### 13.4 Tasks

`adf_tasks` records async tool calls and HIL approval work.

Statuses:

| Status | Meaning |
|--------|---------|
| `pending` | Created, not started |
| `pending_approval` | Waiting for owner or authorized-code approval |
| `running` | Executing |
| `completed` | Successful terminal status |
| `failed` | Error terminal status |
| `denied` | Approval denied |
| `cancelled` | Cancelled before completion |

`requires_authorization = 1` means only owner UI or authorized code may approve/deny. Once set, it MUST NOT be unset by the agent.

### 13.5 Logs

`adf_logs` stores structured runtime logs. Levels are `debug`, `info`, `warn`, and `error`. Log filtering and retention are controlled by `config.logging`.

Common origins/events include:

| Origin | Events |
|--------|--------|
| `lambda` | `execute`, `result` |
| `sys_lambda` | `execute`, `result` |
| `serving` | `api_request`, `api_response` |
| `adf_shell` | `execute`, `parse_error`, `timeout` |
| `sys_fetch` | `rejected`, `error`, `timeout` |
| `mesh` | delivery errors |

`on_logs` triggers MUST avoid recursing on logs produced by their own handler.

---

## 14. Defaults

### 14.1 New File Defaults

| Field | Default |
|-------|---------|
| `adf_version` | `0.1` |
| `id` | 12-character nanoid |
| `name` | Derived from filename |
| `description` | Empty string |
| `handle` | Sanitized filename |
| `state` | `idle` |
| `start_in_state` | `idle` |
| `loop_mode` | `interactive` |
| `autostart` | `false` |
| `model.temperature` | `0.7` |
| `model.max_tokens` | `4096` |
| `context.document_mode` | `agentic` |
| `context.mind_mode` | `included` |
| `context.compact_threshold` | `80000` |
| `messaging.receive` | `false` |
| `messaging.mode` | `respond_only` |
| `messaging.visibility` | `localhost` |
| `security.allow_unsigned` | `true` |
| `security.allow_protected_writes` | `false` |
| `security.require_middleware_authorization` | `true` |
| `limits.execution_timeout_ms` | `5000` |
| `limits.max_loop_rows` | `500` |
| `limits.max_file_read_tokens` | `30000` |
| `limits.max_file_write_bytes` | `5000000` |
| `limits.max_tool_result_tokens` | `16000` |
| `limits.max_active_turns` | `null` |
| `logging.default_level` | `info` |
| `logging.max_rows` | `10000` |

Default files:

| Path | Content | Protection |
|------|---------|------------|
| `document.md` | New-agent markdown stub | `no_delete` |
| `mind.md` | Empty string | `no_delete` |

### 14.2 Default Triggers

| Trigger | Default |
|---------|---------|
| `on_inbox` | Enabled, agent target with `interval_ms: 30000` |
| `on_file_change` | Enabled, agent target watching `document.md`, `debounce_ms: 2000` |
| `on_chat` | Enabled, agent target |
| `on_timer` | Enabled, system and agent targets |
| `on_startup` | Disabled |
| `on_outbox` | Disabled |
| `on_tool_call` | Disabled |
| `on_task_create` | Disabled |
| `on_task_complete` | Disabled |
| `on_logs` | Disabled |

### 14.3 Default Tools

Enabled by default:

- `respond`, `say`, `ask`
- `fs_read`, `fs_write`, `fs_list`
- `msg_send`, `agent_discover`, `msg_list`, `msg_read`, `msg_update`
- `sys_get_config`

Common disabled tools:

- `fs_delete`
- `db_query`, `db_execute`
- `loop_compact`, `loop_clear`, `loop_read`, `loop_stats`
- `msg_delete`, `archive_read`
- `sys_set_state`
- `sys_code`, `sys_lambda`
- `sys_set_timer`, `sys_list_timers`, `sys_delete_timer`
- `sys_update_config`, `sys_create_adf`
- `npm_install`, `npm_uninstall`
- `mcp_install`, `mcp_uninstall`
- `ws_connect`, `ws_disconnect`, `ws_connections`, `ws_send`
- `compute_exec` (restricted), `fs_transfer`
- `adf_shell`

Runtimes MAY enable `sys_set_state` by default for autonomous agents, but must preserve the access-control semantics.

---

## 15. Spec Boundary

### What the Spec Defines

- SQLite system table schema
- Configuration shape and portable semantics
- File protection and authorization fields
- Agent states and loop-mode behavior
- Trigger types, target fields, filters, and scope semantics
- Timer storage and lifecycle semantics
- Tool names and cross-cutting access rules
- ALF message projection into inbox/outbox
- Peer/contact storage and routing order
- Audit, task, and logging records
- Serving, WebSocket, middleware, adapter, MCP, compute, and provider configuration as file-carried declarations

### What the Runtime Defines

- Provider SDKs and API details
- Exact sandbox implementation
- Container, Podman, host, and filesystem mechanics
- MCP process lifecycle and package installation
- Mesh discovery and network transport
- Daemon HTTP API and Studio UI behavior
- Password prompts and unlock UX
- Runtime settings outside the ADF file
- Event stream implementation
- Log trimming schedule
- Prompt assembly implementation beyond stored context/audit semantics

### What the Client Defines

- Editor behavior
- Approval UI
- File preview UI
- Agent graph/monitor UI
- Settings panels
- Password entry UI
- First-open installation prompts

---

## 16. Portability

Sharing one `.adf` file transfers:

- Agent config
- Primary document and mind
- Supporting files and authorized/protection flags
- Loop history
- Inbox and outbox
- Peers/contact book
- Timers
- Tasks
- Logs
- Audit snapshots
- Identity rows and encrypted secrets
- Local tables and vector tables

Not guaranteed to transfer:

- Installed MCP packages
- Runtime app settings
- App-wide credentials
- Container images and host workspaces
- Active WebSocket connections
- In-memory unlock keys
- In-memory executor state

Template sharing SHOULD strip signing identity, rotate IDs/DIDs, and clear loop/inbox/outbox unless the template intentionally includes history.