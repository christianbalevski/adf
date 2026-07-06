# ADF File Format Specification

**Version:** 0.2
**Status:** Draft
**Date:** June 2026

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
17. [Version History](#17-version-history)

---

## 1. Core Principles

### 1.1 Sovereignty

Each ADF is an autonomous entity. It owns its document, memory, configuration, local database tables, inbox, outbox, contacts, timers, logs, and audit history. Other agents influence it through messages, never by direct file or table access. A human owner can modify anything; an agent can modify itself only through tools and runtime-enforced policies.

### 1.2 Spec Stores, Runtime Executes

The ADF file stores declarative state and durable records. The runtime executes code, connects providers, runs MCP servers, evaluates triggers, schedules timers, serves HTTP, and delivers messages. Runtime choices are portable only when represented in `adf_config`, `adf_meta`, or protected ADF tables.

### 1.3 One Agent, One Document

The canonical v0.2 primary document is `README.md`. It serves as the agent's readme that explains what it can do and how one should interact wiht it. Each ADF has exactly one primary document and one `mind.md` working-memory file. Supporting files live in `adf_files` and are subordinate to the primary document.

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
| `adf_version` | `0.2` | `readonly` |
| `adf_schema_version` | `23` | `readonly` |

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

CREATE TABLE IF NOT EXISTS adf_attestations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  role TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT,
  scope TEXT,
  signature TEXT NOT NULL,
  raw_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_adf_attestations_subject ON adf_attestations(subject);

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

### 3.3 Field Reference (Data Dictionary)

Per-column semantics for every system (`adf_`) table. Conventions: columns typed
`INTEGER` that hold timestamps are **epoch milliseconds** unless noted as ISO-8601;
boolean flags are stored as `INTEGER` `0`/`1`; columns typed `TEXT` that hold structured
data store **JSON strings**. A conforming runtime MUST preserve all columns it does not
understand on read-modify-write so the file stays forward-compatible.

#### `adf_meta` — format metadata & key/value store

| Column | Type | Meaning |
|--------|------|---------|
| `key` | TEXT PK | Metadata key. See the namespace rules and well-known key registry below. |
| `value` | TEXT | String value. Numbers and JSON are stored as text. |
| `protection` | TEXT | `none` \| `readonly` \| `increment`. `readonly` = owner/runtime-writable only; `increment` = monotonic counter that may only increase. |

**Key namespaces.** `adf_meta` is a shared store; the key prefix determines governance:

| Namespace | Governance |
|-----------|------------|
| `adf_*` | Spec-governed. Reserved for this document — runtimes MUST NOT invent new `adf_*` keys outside a spec revision. |
| `runtime_*` | Runtime-internal bookkeeping. Opaque; may change without a spec revision. Implementations MUST preserve `runtime_*` keys they do not own. |
| all other keys | Agent-owned. Agents create them freely (e.g. via `sys_set_meta`); protection is chosen at creation and immutable thereafter. |

**Storage-layer taxonomy.** Identity-adjacent data lands in one of three stores by
rule, not precedent:

| Layer | Store | Semantics |
|-------|-------|-----------|
| Key material | `adf_identity` | Secrets. Envelope-sealed or password-encrypted at rest; unreadable in locked/foreign states. |
| Runtime-asserted facts | `adf_meta` | Public, unsigned, single-valued claims by the runtime (`adf_did`, `adf_owner_did`, `adf_parent_did`, `adf_did_history`). Readable without unlocking anything; protected `readonly` against agent writes. Trustworthy locally because the local runtime is the trust root; not proof to a remote peer. |
| Signed proofs | `adf_attestations` | Statements one identity signs about another, verifiable by anyone against the issuer DID. |

The recurring pattern is a **fact + proof pair**: `adf_owner_did` (fast fact) is
paired with the `owner` attestation (verifiable proof of the same statement).
New identity-adjacent data MUST pick its layer by these semantics — e.g.
`adf_parent_did` is a meta fact (single-valued, hot-path, must survive foreign
states); a future parent-signed `creator` attestation would be its proof half.

**Well-known key registry.** Every key the runtime reads or writes MUST appear here — a key the runtime depends on but the spec does not name is a contract that exists only in one implementation's habits. `Writer` is the expected author by convention; `protection` is the enforced part.

| Key | Protection | Writer | Meaning |
|-----|------------|--------|---------|
| `adf_version` | `readonly` | runtime (create) | Format/contract version (`0.2`). |
| `adf_schema_version` | `readonly` | runtime (migrations) | Storage schema version (§3.5, §17.1). |
| `adf_name` | `none` | runtime (config sync) | Denormalized `config.name` for fast lookup without parsing config JSON. |
| `adf_handle` | `none` | runtime (config sync) | Denormalized handle; stored source of truth for mesh addressing across file renames/moves. |
| `adf_created_at` | `readonly` | runtime (create) | ISO-8601 creation timestamp. |
| `adf_updated_at` | `none` | runtime (config writes) | ISO-8601 timestamp of the last config update. |
| `adf_parent_did` | `readonly` | creating runtime | DID of the parent agent that created this file, if any. |
| `adf_did` | `readonly` | runtime (identity provisioning) | This agent's DID once cryptographic identity is provisioned; empty string after identity reset. |
| `adf_did_history` | `readonly` | runtime (rotation/claim/reset) | JSON array of prior agent DIDs, oldest first, appended when `adf_did` is replaced or cleared. Keeps lineage references (`adf_parent_did`) resolvable across rotation without rewriting child files. Bounded: grows only on identity rotation. |
| `adf_owner_did` | `readonly` | runtime (claim/clone) | DID of the owning human/runtime identity. |
| `adf_runtime_did` | `readonly` | runtime (claim/clone) | DID of the runtime that claimed the file. |
| `status` | `none` | agent | Self-reported one-line status shown in UIs. Predates the namespace rules (unprefixed); retained as-is. |
| `runtime_umbilical_next_seq` | `none` | runtime | Umbilical event sequence cursor. Opaque runtime-internal state. |

**Graduation rule.** Well-known keys are appropriate for singleton values and monotonic counters. Data that needs per-row typing, relational queries, indexes, or unbounded row counts must graduate to a dedicated table via a schema revision (§3.5) — never to a growing family of structured keys.

#### `adf_config` — agent configuration (single row)

| Column | Type | Meaning |
|--------|------|---------|
| `id` | INTEGER PK | Always `1` (enforced by `CHECK`). The table holds exactly one row. |
| `config_json` | TEXT | The full `AgentConfig` object as JSON (see §5). |
| `updated_at` | TEXT | ISO-8601 timestamp of the last config write. |

#### `adf_loop` — processing loop (conversation history)

| Column | Type | Meaning |
|--------|------|---------|
| `seq` | INTEGER PK | Autoincrement turn order. |
| `role` | TEXT | `user` \| `assistant`. |
| `content_json` | TEXT | JSON array of content blocks (text, tool_use, tool_result, …). Injected system/instruction context is also stored here as `[Context: …]` entries for No-Secrets auditability (§1.5). |
| `model` | TEXT | Model id that produced an `assistant` row; null for `user` rows. |
| `tokens` | TEXT | JSON token-usage record (`{ input, output, … }`) for `assistant` rows. |
| `created_at` | INTEGER | Epoch ms when the row was appended. |

#### `adf_inbox` — received messages (ALF)

| Column | Type | Meaning |
|--------|------|---------|
| `id` | TEXT PK | Local row id. |
| `message_id` | TEXT | ALF message id from the inbound envelope. |
| `from` | TEXT | Sender DID/address (NOT NULL). |
| `to` | TEXT | Recipient DID/address (this agent). |
| `reply_to` | TEXT | Address the sender wants replies sent to. |
| `network` | TEXT | Logical network; default `devnet`. |
| `thread_id` | TEXT | Conversation thread id. |
| `parent_id` | TEXT | Id of the message this is a reply to. |
| `subject` | TEXT | Optional subject line. |
| `content` | TEXT | Message body / payload content (NOT NULL). |
| `content_type` | TEXT | Type of the content payload. |
| `attachments` | TEXT | JSON array of stored attachments. |
| `meta` | TEXT | JSON of arbitrary message metadata. |
| `sender_alias` | TEXT | Human-friendly sender name; advisory only — the DID is canonical. |
| `recipient_alias` | TEXT | Human-friendly recipient name; advisory only. |
| `owner` | TEXT | Sender's owner DID (from `meta.owner`). |
| `card` | TEXT | URL to the sender's signed agent-card endpoint. |
| `return_path` | TEXT | Transport-layer bounce address. |
| `source` | TEXT | Ingress channel; default `mesh` (e.g. `mesh` or a channel-adapter id). |
| `source_context` | TEXT | JSON adapter-specific ingress context. |
| `sent_at` | INTEGER | Epoch ms when the sender sent it. |
| `received_at` | INTEGER | Epoch ms when stored locally (NOT NULL). |
| `status` | TEXT | `unread` \| `read` \| `archived`. |
| `original_message` | TEXT | Tombstoned raw original envelope, retained for audit (formerly `envelope`). |

#### `adf_outbox` — sent messages (ALF)

Shares most columns with `adf_inbox`; the differences are:

| Column | Type | Meaning |
|--------|------|---------|
| `to` | TEXT | Recipient DID/address (NOT NULL here). |
| `address` | TEXT | Resolved transport address for delivery; default `''`. |
| `return_path` | TEXT | Our own reply-to URL advertised to the recipient. |
| `status_code` | INTEGER | Transport delivery status code (HTTP-like). |
| `created_at` | INTEGER | Epoch ms when enqueued (NOT NULL). |
| `delivered_at` | INTEGER | Epoch ms when delivery was confirmed. |
| `status` | TEXT | `pending` \| `sent` \| `delivered` \| `failed`. |

#### `adf_timers` — scheduled wake events

| Column | Type | Meaning |
|--------|------|---------|
| `id` | INTEGER PK | Autoincrement timer id. |
| `schedule_json` | TEXT | `TimerSchedule` JSON: a once, interval, or cron schedule (§7.6). |
| `next_wake_at` | INTEGER | Epoch ms of the next scheduled fire (indexed). |
| `payload` | TEXT | Opaque string handed to the trigger when the timer fires. |
| `scope` | TEXT | JSON array of scopes; default `["system"]` (`system` \| `agent`). |
| `lambda` | TEXT | Optional lambda source executed on fire. |
| `warm` | INTEGER | `0`/`1`; system-scope keep-warm flag. |
| `run_count` | INTEGER | Number of times the timer has fired. |
| `created_at` | INTEGER | Epoch ms when created. |
| `last_fired_at` | INTEGER | Epoch ms of the most recent fire. |
| `locked` | INTEGER | `0`/`1` owner lock; prevents the agent from modifying or removing the timer. |

#### `adf_files` — virtual filesystem

| Column | Type | Meaning |
|--------|------|---------|
| `path` | TEXT PK | Relative path (e.g. `README.md`, `mind.md`, `data/x.csv`). |
| `content` | BLOB | Raw file bytes. |
| `mime_type` | TEXT | MIME type. |
| `size` | INTEGER | Byte length of `content`. |
| `protection` | TEXT | `read_only` \| `no_delete` \| `none`. Core files `README.md` and `mind.md` are `no_delete` (§4.2). |
| `authorized` | INTEGER | `0`/`1`; whether the file is owner-authorized for agent code access (§4.3). |
| `created_at` | TEXT | ISO-8601 creation timestamp. |
| `updated_at` | TEXT | ISO-8601 last-modified timestamp. |

#### `adf_audit` — compressed snapshots of cleared data

| Column | Type | Meaning |
|--------|------|---------|
| `id` | INTEGER PK | Autoincrement snapshot id. |
| `source` | TEXT | What was cleared: `loop` \| `inbox` \| `outbox` (indexed). |
| `start_at` | INTEGER | Epoch ms of the earliest row in the snapshot. |
| `end_at` | INTEGER | Epoch ms of the latest row in the snapshot. |
| `entry_count` | INTEGER | Number of rows captured. |
| `size_bytes` | INTEGER | Uncompressed size of the captured rows. |
| `data` | BLOB | Brotli-compressed JSON of the cleared rows. |
| `created_at` | INTEGER | Epoch ms when the snapshot was taken. |

#### `adf_identity` — key & secret storage

| Column | Type | Meaning |
|--------|------|---------|
| `purpose` | TEXT PK | Key purpose / namespace, e.g. `crypto:signing:…`, `encryption`, or agent-set credential keys (via `set_identity`). |
| `value` | BLOB | Key material or secret bytes (encrypted when `encryption_algo` ≠ `plain`). |
| `encryption_algo` | TEXT | `plain` (default) or an encryption-algorithm id. |
| `salt` | BLOB | KDF salt, present when the value is encrypted. |
| `kdf_params` | TEXT | JSON KDF parameters. |
| `code_access` | INTEGER | `0`/`1`; whether agent code execution may read this row. Schema default `0` (hidden from code). Rows created via the `set_identity` code method are inserted with `1` so code can read back the keys it stored; overwriting an existing row never changes its flag. |

#### `adf_attestations` — delegation certificates

Public by design, stored plain (readable at card-build time even under
password lock). Two lifecycle classes: current-state certs (`owner`,
`operator`) are replaced wholesale on re-key; all other roles (`clone`,
`rotation`, …) are append-only facts that re-attestation never deletes.
Stored in a single `adf_attestations` adf_meta key before schema v24.

| Column | Type | Meaning |
|--------|------|---------|
| `id` | INTEGER PK | Autoincrement row id (insertion order). |
| `issuer` | TEXT | DID of the attesting party. |
| `subject` | TEXT | DID the attestation is about; covered by the signature so a cert cannot be replayed onto another identity. |
| `role` | TEXT | `owner` \| `operator` \| `runtime` \| `clone` \| `rotation` \| … |
| `issued_at` | TEXT | ISO 8601. |
| `expires_at` | TEXT | Optional ISO 8601 expiry. |
| `scope` | TEXT | What the attestation covers (for `clone`: the prior agent DID). |
| `signature` | TEXT | `ed25519:<base64>` over canonical JSON of all fields except `signature`. |
| `raw_json` | TEXT | The exact signed canonical fields — verification never depends on column round-tripping. |

#### `adf_tasks` — async tool interception / HIL

| Column | Type | Meaning |
|--------|------|---------|
| `id` | TEXT PK | Task id. |
| `tool` | TEXT | Name of the tool the task represents. |
| `args` | TEXT | JSON tool arguments; default `{}`. |
| `status` | TEXT | `pending` \| `pending_approval` \| `running` \| `completed` \| `failed` \| `denied` \| `cancelled` (indexed). |
| `result` | TEXT | JSON result when completed. |
| `error` | TEXT | Error string when failed. |
| `created_at` | INTEGER | Epoch ms when created. |
| `completed_at` | INTEGER | Epoch ms when resolved. |
| `origin` | TEXT | What created the task (e.g. agent, executor, owner). |
| `requires_authorization` | INTEGER | `0`/`1`; gated on owner approval before execution. |
| `executor_managed` | INTEGER | `0`/`1`; the executor is synchronously awaiting this tool — `task_resolve` signals approval without re-executing it. |

#### `adf_logs` — structured runtime log

| Column | Type | Meaning |
|--------|------|---------|
| `id` | INTEGER PK | Autoincrement log id. |
| `level` | TEXT | `debug` \| `info` \| `warn` \| `error` (indexed). |
| `origin` | TEXT | Emitting subsystem/source (indexed). |
| `event` | TEXT | Event type/name. |
| `target` | TEXT | Affected entity, if any. |
| `message` | TEXT | Human-readable message (NOT NULL). |
| `data` | TEXT | Optional JSON detail payload. |
| `created_at` | INTEGER | Epoch ms when logged. |

### 3.4 User Schema

Agents may create tables that do not start with `adf_`. The recommended prefix is `local_`. Runtime tools may require the `local_` prefix for writes even if SQLite itself could store other names.

```sql
CREATE TABLE local_subscribers (
  agent_id TEXT,
  topic TEXT,
  subscribed_at INTEGER
);
```

Runtimes SHOULD load sqlite-vec when available so agents can create vector tables with `CREATE VIRTUAL TABLE local_embeddings USING vec0(...)`.

### 3.5 Schema Migration

`adf_schema_version` in `adf_meta` is the canonical schema version (currently **23**; see §17.1 for the revision history). Runtimes MUST apply migrations sequentially and MUST NOT silently downgrade a newer schema. If a runtime cannot open a newer schema, it should fail read-only or refuse to open with a clear error. Runtimes SHOULD create a transient backup before applying migrations and remove it only after they succeed.

---

## 4. Virtual Filesystem and Metadata

### 4.1 Reserved Files

| Path | Protection | Description |
|------|------------|-------------|
| `README.md` | `no_delete` | Primary document and shared human-agent artifact |
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

Core files `README.md` and `mind.md` use `no_delete` by default. `read_only` always blocks agent writes, even when protected writes are otherwise allowed.

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
  "adf_version": "0.2",
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
    "compact_threshold": 100000,
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

#### Instruction templating (`{{<path>}}`)

The `instructions` field — and the runtime base prompt it is combined with — may
contain `{{<path>}}` placeholders. At system-prompt assembly the runtime replaces
each with the contents of the `adf_files` entry at that exact path:

```
{{mind.md}}        → the agent's working memory
{{README.md}}      → the agent's public README
{{policy/tone.md}} → any other workspace file
```

Resolution rules a conforming runtime MUST honor:

- **Files only.** A placeholder resolves only against `adf_files`, never against
  `adf_identity`, `adf_meta`, or `adf_config`. Dynamic or queried values are the
  domain of lambdas and `loop_inject`, not templating.
- **Single pass.** Injected content is not re-scanned, so a referenced file cannot
  chain-inject another. There is no recursion.
- **Snapshot.** Referenced files are read once at session start and reused for the
  session; edits are picked up at the next session reset (compaction / `loop_clear`),
  never mid-session. This keeps the system prompt stable for prompt caching.
- **Missing path** renders a visible `[missing file: <path>]` marker rather than
  silently expanding to empty, so typos are auditable.
- **Not gated on `fs_read`.** Templating is owner-authored prompt composition; it is
  independent of whether the agent has the `fs_read` tool enabled.

`mind.md` is injected via the `{{mind.md}}` placeholder in the default base prompt —
it is not a special case. The resolved result is captured in `adf_loop` like any
other context injection (§1.5).

### 5.2 Identity Fields

| Field | Description |
|-------|-------------|
| `id` | Permanent local runtime handle: a 12-character nanoid minted at creation, never rewritten. Used for audit labels, event routing, and log continuity. NOT the agent's identity — that is the DID in `adf_meta.adf_did`, which can rotate (claim, re-key) while `id` stays stable. No new feature may treat `id` as identity. |
| `name` | Human-friendly name used in UI and discovery. |
| `description` | Public capability summary used in discovery and agent cards. |
| `icon` | Optional display icon or short label. |
| `handle` | URL-safe slug for mesh serving. Lowercase letters, numbers, and hyphens. |
| `card` | Optional public card endpoint/resolution overrides. |

### 5.3 State and Loop Configuration

Canonical v0.2 fields:

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
  "visible": true,
  "restricted": false,
  "locked": false
}
```

| Field | Description |
|-------|-------------|
| `name` | Built-in tool name, MCP tool name (`mcp:<server>:<tool>`), or custom runtime tool name. |
| `enabled` | If true, the tool exists for the agent and can be called by code and lambdas. If false, the tool is off — code calls are rejected (the one exception: an `enabled: false`, `restricted: true` tool may still be called by authorized code). |
| `visible` | If true, the enabled tool is included in the LLM loop's active tool schema. The LLM can call a tool only when `enabled` and `visible` are both true. Set `visible: false` to keep a tool callable from code while hiding it from the LLM. |
| `restricted` | If true, only authorized code can call freely; when also `enabled` and `visible`, LLM loop calls require HIL. |
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
    "execution_timeout_ms": 60000,
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
    "mode": "proactive",
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
    "attestation_list": true,
    "attestation_add": true,
    "attestation_issue": true,
    "network": false,
    "packages": [{ "name": "vega-lite", "version": "^5.21.0" }],
    "restricted_methods": ["get_identity", "model_invoke", "attestation_issue"]
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

Every ADF receives cryptographic identity **at creation** (schema v24+): an
Ed25519 keypair sealed in the identity envelope (§8.3), a `did:key` DID in
`adf_meta.adf_did`, owner/runtime stamps, and owner/operator attestations.
Files created by older runtimes are provisioned on first open or by the boot
migration sweep, keeping any existing DID.

| Identifier | Store | Semantics |
|------------|-------|-----------|
| `config.id` | `adf_config` | Permanent local runtime handle (nanoid). Stable across re-keying; never an identity. |
| Agent DID | `adf_meta.adf_did` | The agent's identity: `did:key:z…` encoding of its Ed25519 public key. Rotates on claim/re-key. |
| DID history | `adf_meta.adf_did_history` | Prior DIDs, oldest first, appended whenever `adf_did` is replaced or cleared. Keeps lineage references resolvable without rewriting child files. |
| Parent reference | `adf_meta.adf_parent_did` | The spawning agent's DID (or `config.id` for pre-v24 files). Resolved read-time via the cascade: current DID → DID history → legacy `config.id`. |

DIDs are `did:key` — the identifier IS the key, so rotation genuinely creates a
new identity. Continuity is app-attested via DID history (sufficient for the
local fleet, where the runtime is the trust root) rather than cryptographically
attested; a signed rotation chain is a designated future extension for
remote-peer continuity.

Once a DID is provisioned, runtimes MUST NOT delete it silently; identity reset
clears `adf_did` to the empty string after recording it in `adf_did_history`.

### 8.2 Identity Store

`adf_identity` is a general-purpose secret store. Common purposes:

| Purpose | Description |
|---------|-------------|
| `crypto:signing:private_key` | Ed25519 private key (sealed: `env:identity`) |
| `crypto:signing:public_key` | Ed25519 public key (always plain — not a secret) |
| `crypto:envelope:identity` | Identity-envelope descriptor: JSON keyslot array (plain — wrapped material, public by design) |
| `crypto:envelope:credentials` | Credentials-envelope descriptor (plain) |
| `crypto:kdf:salt` | Legacy password KDF salt |
| `crypto:kdf:params` | Legacy password KDF params |
| `mcp:<server>:<key>` | MCP server credential (sealed: `env:credentials`) |
| `openai_key`, `anthropic_key`, custom keys | Provider or application secrets (sealed: `env:credentials`) |

`code_access` indicates whether code execution may read a row through identity
APIs. Independent of that flag, `crypto:signing:*`, `crypto:envelope:*`, and
`crypto:kdf:*` purposes are NEVER readable from agent code — key material is
runtime-only even if `code_access` is flipped on such a row.

Public keys are stored as ordinary identity rows, not as a special column. This keeps `adf_identity` a uniform `purpose -> value` store and avoids a nullable column that only applies to one key family. Runtimes that need public identity without unlocking the file should use `adf_meta` readonly keys, the signed agent card, or a plain `crypto:signing:public_key` row according to their security policy.

### 8.3 Encryption at Rest — Envelopes

The normative at-rest scheme is **dual-envelope keyslot encryption** (full
design: `ADF_IDENTITY_SPEC_v0.1.md`). A random 32-byte DEK encrypts each
envelope's rows; the DEK is wrapped once per keyslot, and any slot opens the
envelope:

| Envelope | Covers | Allowed slots |
|----------|--------|---------------|
| `identity` | `crypto:signing:private_key` | `owner`, `runtime` — never a password slot via sharing (identity is non-transferable by file copy) |
| `credentials` | every non-`crypto:*` secret (`set_identity` rows, `mcp:*`, provider keys) | `owner`, `runtime`, optional `password` (the share mechanism) |

- **Sealed rows:** `encryption_algo = 'env:identity' | 'env:credentials'`,
  `value = iv(12) || ciphertext || tag(16)`, `salt` NULL, `kdf_params` NULL.
- **Key slots:** ephemeral X25519 ECDH against the recipient's encryption
  public key → HKDF-SHA256 (info `adf-envelope-v1:<envelope>`) → AES-256-GCM
  over the DEK. Wrapping needs only the recipient public key; the owner slot
  is written without touching the seed.
- **Password slots:** scrypt (`N=2^17, r=8, p=1`, 32-byte salt) → AES-256-GCM
  over the DEK. New password slots MUST use scrypt, not the legacy PBKDF2.
- **Unlock cascade:** runtime slot → owner slot (mnemonic-derived; a
  successful owner unlock re-wraps a runtime slot for the install, so the
  seed is needed at most once per file per machine) → password prompt on
  demand. Unwrapped DEKs live in memory per open workspace, never persisted.
- **Recipient adoption:** unlocking a foreign credentials envelope with a
  share password re-wraps the DEK to the local owner/runtime and drops the
  password slot — the password is a transit artifact, not a standing secret.

**Legacy whole-file password format** (pre-envelope): rows encrypted directly
with a PBKDF2-derived key (AES-256-GCM; IV in `salt`; PBKDF2 100,000
iterations SHA-512). Runtimes MUST keep reading this format; it maps
conceptually onto password-only-slot envelopes. Envelope descriptor rows and
`env:*` rows are excluded from legacy password operations.

Rows with `encryption_algo = 'plain'` are unencrypted. Runtimes SHOULD warn before exporting or sharing files that contain plain secrets.

### 8.4 Envelope and Lock States

Per envelope, a workspace is in one of four states:

| State | Meaning | Capabilities |
|-------|---------|--------------|
| `unlocked` | DEK cached for this workspace instance | Full access to that envelope's secrets (signing for `identity`, credential reads for `credentials`). |
| `locked` | A password slot exists and has not been opened | Public data, message receipt, and serving work; prompt to unlock. |
| `foreign` | Slots exist but none open with this install's keys | The file belongs to another owner. Identity foreign ⇒ cannot sign ⇒ claim flow (new DID, `clone` attestation, old DID into history). Credentials foreign ⇒ secrets unreadable unless a share password unlocks them. |
| `absent` | No envelope descriptor | Pre-envelope file; plain/legacy behavior until migrated. |

Password-derived keys and DEKs are held in memory and never persisted
unencrypted. A file is "password-protected" (unlock prompt on open) only when
password-KDF rows exist — envelope-sealed rows do NOT trip the prompt; they
unlock automatically via the runtime/owner keys.

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

Tool access matrix. `visible` gates only the LLM loop column (the LLM sees a tool only when it is both `enabled` and `visible`); it has no effect on code-initiated calls:

| `enabled` | `visible` | `restricted` | LLM loop | Authorized code | Unauthorized code |
|-----------|-----------|--------------|----------|-----------------|-------------------|
| false | — | false | Off | Off | Off |
| false | — | true | Off | Free | Off |
| true | false | false | Off (hidden) | Free | Free |
| true | false | true | Off (hidden) | Free | Off |
| true | true | false | Free | Free | Free |
| true | true | true | HIL | Free | Off |

`code_execution.restricted_methods` applies the same authorized-code rule to code-only methods such as `get_identity`, `set_identity`, `model_invoke`, `loop_inject`, and `authorize_file`. When the field is omitted, the runtime default applies: `["attestation_issue"]` — signing certificates about other agents is a deliberate trust act. An explicit list replaces the default entirely.

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
await adf.fs_read({ path: "README.md" })
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
| `set_identity` | Store identity values when enabled; newly created keys get `code_access = 1`, existing keys keep their flag |
| `attestation_list` | Read this agent's attestations (public by design) |
| `attestation_add` | Store a peer-issued attestation about this agent. Signature must verify, subject must be this agent's DID, reserved roles (`owner`/`operator`/`runtime`/`clone`/`rotation`) are rejected, duplicates are idempotent |
| `attestation_issue` | Sign an attestation about another DID with this agent's key. Returned, not stored — attestations live with their subject. Reserved roles rejected; restricted to authorized code by default |
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

`loop_compact` is signal-only in v0.2. The runtime generates a summary using a dedicated compaction prompt, audits deleted rows if configured, deletes old loop entries, and inserts a `[Loop Compacted]` summary entry.

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
| `adf_version` | `0.2` |
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
| `context.compact_threshold` | `100000` |
| `messaging.receive` | `false` |
| `messaging.mode` | `proactive` |
| `messaging.visibility` | `localhost` |
| `security.allow_unsigned` | `true` |
| `security.allow_protected_writes` | `false` |
| `security.require_middleware_authorization` | `true` |
| `limits.execution_timeout_ms` | `60000` |
| `limits.max_file_read_tokens` | `30000` |
| `limits.max_file_write_bytes` | `5000000` |
| `limits.max_tool_result_tokens` | `16000` |
| `limits.max_active_turns` | `null` |
| `logging.default_level` | `info` |
| `logging.max_rows` | `10000` |

Default files:

| Path | Content | Protection |
|------|---------|------------|
| `README.md` | New-agent markdown stub | `no_delete` |
| `mind.md` | Empty string | `no_delete` |

### 14.2 Default Triggers

| Trigger | Default |
|---------|---------|
| `on_inbox` | Enabled, agent target with `interval_ms: 30000` |
| `on_file_change` | Enabled, agent target watching `README.md`, `debounce_ms: 2000` |
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

---

## 17. Version History

The `adf_version` row records the **format/contract** version (this document). The
`adf_schema_version` row records the **on-disk storage layout** and is a monotonically
increasing integer; runtimes apply migrations sequentially up to the latest. The two
version axes are decoupled — many `adf_schema_version` bumps may occur within a single
`adf_version`.

The current format version is **0.2**, current storage schema is **23**.

| `adf_version` | Notes |
|---------------|-------|
| `0.2` | Current. Canonical primary document is `README.md` (renamed from the earlier `document.md` at `adf_schema_version` 22; legacy `document.md` is still readable and is migrated in place on open). Tables prefixed `adf_`; target-based trigger spec (§7); consolidated `restricted` access model. |
| `0.1` | Initial draft. Primary document was `document.md`. |

### 17.1 Storage Schema (`adf_schema_version`)

`adf_schema_version` is the canonical migration counter (see §3.5). Notable recent
revisions:

| Version | Change |
|---------|--------|
| 23 | Config conformance: remove `max_loop_messages` (message-count pruning; superseded by token-based compaction), remove never-enforced `limits.max_loop_rows` / `limits.max_daily_budget_usd`, fold legacy `model.thinking_budget` into `model.reasoning.max_tokens`. |
| 22 | Rename canonical `document.md` → `README.md` (in place, preserving protection); repoint `on_file_change` watch globs `document.*` → `README.*`. |
| 21 | Remove the `adf_peers` subsystem. |
| 20 | Consolidate `require_approval` + `require_authorized` into a single `restricted` flag. |
| 19 | Executor-managed HIL tasks. |
| 18 | Task-level authorization. |
| 17 | File authorization (`adf_files.authorized`). |

Runtimes MUST NOT silently downgrade a newer schema. A runtime that cannot apply a
migration SHOULD fail closed (open read-only or refuse with a clear error) rather than
corrupt the file.