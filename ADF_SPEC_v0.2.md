# ADF File Format Specification

**Version:** 0.2
**Status:** Draft
**Revision:** 2026-10

The Agent Document Format (`.adf`) is a SQLite database that stores one localized agent (§1.3): its identity, configuration, documents, conversation history, messages, scheduled work and operational records.

This specification defines what an `.adf` file stores and the semantics a conforming runtime applies to it. It does not define the desktop UI, the daemon HTTP API, provider-specific behaviour or container implementation, except where the file represents them. Revision 2026-10 corrects this document against the reference runtime without changing the file contract; §17.2 lists every semantic correction.

---

## Table of Contents

0. [Conventions](#0-conventions)
1. [Core Principles](#1-core-principles)
2. [The ADF Stack](#2-the-adf-stack)
3. [Storage Format](#3-storage-format)
4. [Virtual Filesystem and Metadata](#4-virtual-filesystem-and-metadata)
5. [Agent Configuration](#5-agent-configuration)
6. [States and Loops](#6-states-and-loops)
7. [Triggers and Timers](#7-triggers-and-timers)
8. [Security, Identity, and Authorization](#8-security-identity-and-authorization)
9. [Code Execution and Lambdas](#9-code-execution-and-lambdas)
10. [Tool Catalog](#10-tool-catalog)
11. [Messaging and ALF](#11-messaging-and-alf)
12. [Serving, WebSockets, and Middleware](#12-serving-websockets-and-middleware)
13. [Memory, Audit, Tasks, and Logs](#13-memory-audit-tasks-and-logs)
14. [Defaults](#14-defaults)
15. [Spec Boundary](#15-spec-boundary)
16. [Portability](#16-portability)
17. [Version History](#17-version-history)

---

## 0. Conventions

### 0.1 Requirement Keywords

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [RFC 2119] [RFC 8174] when, and only when, they appear in all capitals, as shown here.

Lower-case "must", "should" and "may" carry no requirement. Paragraphs that begin with "Rationale:" or "Note:" are non-normative. Examples are non-normative unless the text that introduces them says otherwise.

### 0.2 Data Conventions

- Text is UTF-8.
- An `INTEGER` column that holds a timestamp stores Unix epoch milliseconds. A `TEXT` column that holds a timestamp stores an ISO-8601 string; the column reference (§3.3) says which.
- Boolean flags are stored as `INTEGER` `0` or `1`.
- A `TEXT` column that holds structured data stores a JSON string.
- A runtime MUST preserve columns, `adf_meta` keys and config fields it does not recognise when it rewrites a row, so that newer files survive a round trip through an older runtime. A migration (§3.5) MAY remove fields that this document lists as removed.

### 0.3 Terminology

| Term | Meaning |
|------|---------|
| **localized agent** | An agent stored in one `.adf` file (§1.3). |
| **body** | The `.adf` file of a localized agent: every component listed in §1.3. |
| **owner** | The human whose owner identity controls the agent's keys; its DID is `adf_meta.adf_owner_did`. `operator` is an attestation role (§3.3), not a person. |
| **runtime** | The program that opens the file and executes its configuration (Studio, the daemon, the CLI, or a third-party implementation). |
| **loop** | A named conversation of the agent. Every agent has the loop `main`; the others are inner loops declared in `config.loops` (§6.4). |
| **turn** | One run of a loop, from the message, trigger or timer that starts it until the loop stops. A turn contains one or more model requests and the tool calls they produce. |
| **transcript** | The `adf_loop` rows of one loop, ordered by `COALESCE(ord, seq), seq`. |
| **lambda reference** | A string `path/file.ts:functionName` that names a function exported by a file in `adf_files`. |
| **model path** | Work performed by a model turn: reasoning, new work, conversation with the owner. |
| **code path** | Work performed without a model: lambdas, triggers with system scope, timers, middleware, API routes, WebSocket handlers. |
| **HIL** | Human-in-the-loop: the call waits for owner approval before it runs. "Owner approval" means the same thing. |
| **template** | An `.adf` file used as the starting point for a new agent. Instantiating a template produces a new agent with its own identity (§16). |

---

## 1. Core Principles

### 1.1 Access Boundary

An agent's file is modified only by its owner, by the runtime, or by the agent through tools (§10) and code (§9). Other agents affect it only by sending messages (§11).

### 1.2 The File Stores, the Runtime Executes

The file stores declarative state and durable records. The runtime executes code, connects to model providers, runs MCP servers, evaluates triggers, schedules timers, serves HTTP and delivers messages. A runtime choice is portable only when the file represents it in `adf_config`, `adf_meta` or an `adf_` table.

### 1.3 One File, One Agent

A **localized agent** is an agent whose identity, state and behaviour are stored in a single `.adf` file, and which a conforming runtime can run from that file alone, subject to the exceptions in §16. Each `.adf` file contains exactly one localized agent. The file is the agent's complete **body**: all data that belongs to the agent is stored in it, and no data that belongs to another agent is. Portability (§16) follows from this definition.

The body consists of these components. Other sections and documents link to this table instead of repeating it.

| Component | Stored in | Per file | Section |
|-----------|-----------|----------|---------|
| Identity | `adf_meta` keys `adf_did`, `adf_did_history`, `adf_owner_did`, `adf_runtime_did`, `adf_parent_did` | one DID (or none before provisioning) | §8.1 |
| Keys and secrets | `adf_identity`, sealed in the `identity` and `credentials` envelopes | one keystore | §8.2–§8.4 |
| Attestations | `adf_attestations` | zero or more | §3.3, §8.1 |
| Configuration | `adf_config.config_json` | exactly one row | §5 |
| Metadata | `adf_meta` | one value per key | §3.3, §4.4 |
| Primary document | `adf_files` path `README.md` | exactly one | §4.1 |
| Memory | `adf_files` paths `mind.md`, `mind/*`, `mind/log.md` | one `mind.md` and one `mind/log.md` | §4.1 |
| Voice | `adf_files` path `soul.md` | exactly one | §4.1 |
| Other files | `adf_files` (lambdas, skills, data, public files) | zero or more | §4 |
| Loops | `config.loops` declares inner loops; `adf_loop` rows keyed by `loop` hold every transcript | `main` plus zero or more inner loops | §6.4, §13.1 |
| Triggers | `config.triggers` | one entry per trigger type | §7 |
| Timers | `adf_timers` | zero or more | §7.6 |
| Messages | `adf_inbox`, `adf_outbox` | zero or more | §11 |
| Tasks | `adf_tasks` | zero or more | §13.4 |
| Logs | `adf_logs` | zero or more | §13.5 |
| Audit snapshots | `adf_audit` | zero or more | §13.3 |
| User tables | tables named `local_*`, including `vec0` virtual tables | zero or more | §3.4 |
| Service declarations | `config.serving`, `config.ws_connections`, `config.adapters`, `config.mcp`, `config.compute`, `config.providers`, `config.stream_bindings` | as configured | §5, §12 |

*Primary document.* `README.md` is the agent's primary document: it describes what the agent does and how to interact with it. A runtime MUST create it when it creates the file, with protection `no_delete` (§4.2). A runtime MUST NOT delete it on an agent's request unless the call is authorized (§8.6) or the owner approves it. A runtime MAY expose it to other agents and to people, for example through `serving.public` (§12.1).

Not one per file: a file holds several loops (§6.4) and any number of documents in `adf_files`. A child agent that this agent creates (`sys_create_adf`) is a separate localized agent in its own file; the child records its creator in `adf_meta.adf_parent_did`, and the parent file stores no part of the child.

### 1.4 Asynchrony

Agent-to-agent communication is store-and-forward. Messages are stored in `adf_outbox` and `adf_inbox`; the transport that moves them is a runtime concern (§11, §12). Delivery works between agents in the same runtime, over relays, through channel adapters and across high-latency networks.

### 1.5 No Secrets in Context

A runtime MUST record every piece of prompt text it adds to a model request, so that the owner can read what the model received. It stores system prompt snapshots, dynamic instructions, compaction summaries and `loop_inject` content as ordinary rows in `adf_loop` (§13.1).

### 1.6 Model Path and Code Path

An agent performs work on two paths (§0.3):

- *Model path:* a model turn in a loop, used for reasoning, new work, tool calls and conversation with the owner.
- *Code path:* lambdas, system-scope triggers, timers, middleware, API routes and WebSocket handlers, used for deterministic repeated work.

An agent MAY move a repeated model-path workflow to the code path by writing a lambda to `adf_files` and referencing it from config.

---

## 2. The ADF Stack

| Layer | Component | Description |
|-------|-----------|-------------|
| User interface | ADF Studio | Desktop application for creating, configuring, editing and observing `.adf` files |
| Headless runtime | ADF daemon | Local HTTP service that loads agents and runs them without a UI |
| Command line | ADF CLI | The `adf` command: creates, inspects and runs agents |
| Network | ADF Mesh | Discovery and transport for local and remote agents |
| Protocol | ALF | Agentic Lingua Franca: message and agent-card format |
| Runtime | ADF runtime | Code that implements this specification |
| Specification | ADF Specification | This document |
| Data | `.adf` file | SQLite database that stores one localized agent |

Studio, the daemon and the CLI read and write the same file format. A conforming runtime MAY implement any subset of the runtime surfaces, but it MUST preserve the file semantics this document defines.

---

## 3. Storage Format

An `.adf` file is a SQLite 3 database. §0.2 lists the encoding, timestamp, boolean and JSON conventions.

### 3.1 SQLite Pragmas

A runtime MUST apply these pragmas when it opens a file:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
```

A runtime MAY apply connection-tuning pragmas that do not change stored data, such as `cache_size`, `temp_store` and `mmap_size`.

### 3.2 Protected Schema

Tables whose names start with `adf_` are system tables. An agent MAY read some system tables through tools (§10.3). An agent MUST NOT write, drop or alter an `adf_` table directly; every change goes through a tool, a lambda, or an owner or runtime operation.

Required metadata rows:

| Key | Value | Protection |
|-----|-------|------------|
| `adf_version` | `0.2` | `readonly` |
| `adf_schema_version` | `32` | `readonly` |

The current storage schema version is 32. The protected schema is:

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

-- The loop column names the loop the row belongs to (§6.4). seq is unique
-- across loops; a loop's transcript is selected with WHERE loop = ?.
CREATE TABLE IF NOT EXISTS adf_loop (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,
  content_json TEXT NOT NULL,
  model TEXT,
  tokens TEXT,
  created_at INTEGER NOT NULL,
  ord INTEGER,
  loop TEXT NOT NULL DEFAULT 'main'
);
CREATE INDEX IF NOT EXISTS idx_adf_loop_loop_seq ON adf_loop(loop, seq);
-- Index on the ordering key COALESCE(ord, seq), seq, so transcript reads
-- sort from the index.
CREATE INDEX IF NOT EXISTS idx_adf_loop_stream ON adf_loop(loop, COALESCE(ord, seq), seq);

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
CREATE INDEX IF NOT EXISTS idx_adf_outbox_created ON adf_outbox(created_at);

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
  locked INTEGER NOT NULL DEFAULT 0,
  expired INTEGER NOT NULL DEFAULT 0,
  loop TEXT
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
  start_seq INTEGER,
  end_seq INTEGER,
  ref TEXT,
  entry_count INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  data BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_adf_audit_source_start ON adf_audit(source, start_seq);

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
  executor_managed INTEGER NOT NULL DEFAULT 0,
  approval_meta TEXT,
  loop TEXT
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
  created_at INTEGER NOT NULL,
  loop TEXT
);
CREATE INDEX IF NOT EXISTS idx_adf_logs_level ON adf_logs(level);
CREATE INDEX IF NOT EXISTS idx_adf_logs_origin ON adf_logs(origin);

```

### 3.3 Field Reference (Data Dictionary)

Per-column semantics for every `adf_` table. §0.2 gives the type conventions. A runtime MUST preserve columns it does not recognise when it rewrites a row.

#### `adf_meta` — format metadata and key/value store

| Column | Type | Meaning |
|--------|------|---------|
| `key` | TEXT PK | Metadata key. See the namespaces and the key registry below. |
| `value` | TEXT | String value. Numbers and JSON are stored as text. |
| `protection` | TEXT | `none` \| `readonly` \| `increment` (§4.4). The protection is set when the key is created; a later write of the value does not change it. |

*Key namespaces.* The key prefix determines who governs a key:

| Namespace | Governance |
|-----------|------------|
| `adf_*` | Defined by this specification. A runtime MUST NOT create an `adf_*` key that the registry below does not list. |
| `runtime_*` | Runtime bookkeeping. Opaque; it MAY change without a specification revision. A runtime MUST preserve `runtime_*` keys it does not own. |
| other keys | Agent-owned. The agent creates them (for example with `sys_set_meta`) and chooses their protection at creation. |

*Storage layers for identity data.* Identity-related data is stored in one of three places according to what it is:

| Layer | Store | Semantics |
|-------|-------|-----------|
| Key material | `adf_identity` | Secrets. Sealed in an envelope or password-encrypted at rest; unreadable in the `locked` and `foreign` states (§8.4). |
| Runtime-recorded facts | `adf_meta` | Public, unsigned, single-valued statements written by the runtime (`adf_did`, `adf_owner_did`, `adf_runtime_did`, `adf_parent_did`, `adf_did_history`). Readable without unlocking; `readonly` to the agent. The local runtime trusts them because it wrote them; a remote peer does not. |
| Signed proofs | `adf_attestations` | Statements one identity signs about another, verifiable by anyone against the issuer DID. |

A fact in `adf_meta` MAY have a matching signed proof in `adf_attestations`: `adf_owner_did` records the owner, and the `owner` attestation proves the same statement. New identity-related data MUST be placed by these semantics. For example, `adf_parent_did` is a single-valued fact that the runtime reads without unlocking the file, so it is stored in `adf_meta`.

*Key registry.* Every `adf_*` key a runtime reads or writes MUST appear in this table. `Writer` is the expected author; `Protection` is enforced.

| Key | Protection | Writer | Meaning |
|-----|------------|--------|---------|
| `adf_version` | `readonly` | runtime (create) | Format version (`0.2`). |
| `adf_schema_version` | `readonly` | runtime (migrations) | Storage schema version (§3.5, §17.1). |
| `adf_name` | `readonly` | runtime (config write) | Copy of `config.name`, readable without parsing config JSON. |
| `adf_handle` | `readonly` | runtime (config write) | Copy of `config.handle`; the stored handle for mesh addressing when the file is renamed or moved. |
| `adf_created_at` | `readonly` | runtime (create) | ISO-8601 creation time. |
| `adf_updated_at` | `readonly` | runtime (config write) | ISO-8601 time of the last config write. |
| `adf_parent_did` | `readonly` | creating runtime | DID of the agent that created this file, if any (§1.3). |
| `adf_did` | `readonly` | runtime (identity provisioning) | This agent's DID; the empty string after an identity reset. |
| `adf_did_history` | `readonly` | runtime (rotation, claim, reset) | JSON array of prior agent DIDs, oldest first. The runtime appends to it when it replaces or clears `adf_did`, so `adf_parent_did` values in child files stay resolvable after rotation. It grows only on rotation. |
| `adf_owner_did` | `readonly` | runtime (claim, clone) | DID of the owner. |
| `adf_runtime_did` | `readonly` | runtime (claim, clone) | DID of the runtime that claimed the file. |
| `adf_clean_close` | `readonly` | runtime (close) | Present when the previous session closed the file cleanly. The runtime writes it as the last write on close and deletes it after a successful open; if it is absent on open, the runtime runs a full integrity check. |
| `adf_effective_runtime` | `readonly` | runtime (start, config change) | JSON snapshot of the settings the agent inherits from its runtime (provider, prompt hashes, compute, MCP, adapters, mesh). Contains no secrets. |
| `adf_loop_tools_backfilled` | `none` | runtime (config read) | `1` once the runtime has added `loop_send` and `loop_list` to inner loops declared before those tools existed. |
| `adf_runtime_turn_checkpoint` | `readonly` | runtime (executor) | Crash-recovery record for the turn in progress in `main`. Inner loops use `adf_runtime_turn_checkpoint:<loop>`. |
| `adf_template_shipped` | `readonly` | runtime (template build) | Identifier of the shipped template this file is. Removed when the template is instantiated. |
| `adf_template_description` | `readonly` | runtime (template build) | Description shown when choosing a template. Removed on instantiation. |
| `adf_template_warning` | `readonly` | runtime (template build) | Warning shown when choosing a template. Removed on instantiation. |
| `status` | `none` | agent | One-line status the agent reports, shown in UIs. Predates the namespace rules. |
| `context_baseline_tokens` | `readonly` | runtime (executor) | JSON estimate of the size of the next model request in `main`; inner loops use `context_baseline_tokens:<loop>`. Deleted when the transcript is cleared. Predates the namespace rules. |
| `runtime_umbilical_next_seq` | `none` | runtime | Umbilical event sequence cursor. |

Note: a key in this registry holds one value or one counter. Data that needs typed rows, relational queries, indexes or an unbounded number of entries is added as a table in a schema revision (§3.5), not as a family of keys.

#### `adf_config` — agent configuration (single row)

| Column | Type | Meaning |
|--------|------|---------|
| `id` | INTEGER PK | Always `1` (enforced by `CHECK`). The table holds one row. |
| `config_json` | TEXT | The `AgentConfig` object as JSON (§5). |
| `updated_at` | TEXT | ISO-8601 time of the last config write. |

#### `adf_loop` — transcripts

| Column | Type | Meaning |
|--------|------|---------|
| `seq` | INTEGER PK | Autoincrement row identity. It is never reused or renumbered; compaction and history rebuilds keep the `seq` of surviving rows, so `[S<seq>]` citations stay valid in `adf_loop` and in `adf_audit` snapshots. |
| `role` | TEXT | `user` \| `assistant`. |
| `content_json` | TEXT | JSON array of content blocks (text, tool_use, tool_result, …). Context the runtime adds is stored here as `[Context: …]` blocks (§1.5, §13.1). |
| `model` | TEXT | Model id that produced an `assistant` row; NULL for `user` rows. |
| `tokens` | TEXT | JSON token-usage record (`{ input, output, … }`) for `assistant` rows. |
| `created_at` | INTEGER | Epoch ms when the row was appended. |
| `ord` | INTEGER | Nullable position override. The ordering key is `COALESCE(ord, seq), seq`. The runtime sets `ord` only on compaction summary rows, so the summary sorts before the preserved rows without renumbering them. |
| `loop` | TEXT | Name of the loop the row belongs to (§6.4); `NOT NULL DEFAULT 'main'`. `seq` is unique across all loops. Reads and destructive operations filter with `WHERE loop = ?`, so each loop has its own transcript. |

#### `adf_inbox` — received messages (ALF)

| Column | Type | Meaning |
|--------|------|---------|
| `id` | TEXT PK | Local row id. |
| `message_id` | TEXT | ALF message id from the inbound envelope. |
| `from` | TEXT | Sender DID or address (NOT NULL). |
| `to` | TEXT | Recipient DID or address (this agent). |
| `reply_to` | TEXT | Address the sender wants replies sent to. |
| `network` | TEXT | Logical network; default `devnet`. |
| `thread_id` | TEXT | Conversation thread id. |
| `parent_id` | TEXT | Id of the message this message replies to. |
| `subject` | TEXT | Optional subject line. |
| `content` | TEXT | Message content (NOT NULL). |
| `content_type` | TEXT | Media type of `content`. |
| `attachments` | TEXT | JSON array of stored attachments. |
| `meta` | TEXT | JSON message metadata. |
| `sender_alias` | TEXT | Display name of the sender. Advisory; the DID identifies the sender. |
| `recipient_alias` | TEXT | Display name of the recipient. Advisory. |
| `owner` | TEXT | Sender's owner DID (from `meta.owner`), kept only when the message signature verified (§8.5). |
| `card` | TEXT | URL of the sender's signed agent card. |
| `return_path` | TEXT | Transport-layer bounce address. |
| `source` | TEXT | Ingress channel; default `mesh`, otherwise a channel-adapter type. |
| `source_context` | TEXT | JSON adapter-specific ingress context (§11.6). |
| `sent_at` | INTEGER | Epoch ms when the sender sent it. |
| `received_at` | INTEGER | Epoch ms when stored (NOT NULL). |
| `status` | TEXT | `unread` \| `read` \| `archived`. |
| `original_message` | TEXT | Raw original envelope, kept for audit after attachment extraction. |

#### `adf_outbox` — sent messages (ALF)

`adf_outbox` has the columns of `adf_inbox` except `source`, `source_context`, `sent_at`, `received_at`; the differences are:

| Column | Type | Meaning |
|--------|------|---------|
| `to` | TEXT | Recipient DID or address (NOT NULL). |
| `address` | TEXT | Resolved transport address; default `''`. |
| `return_path` | TEXT | This agent's reply URL, sent to the recipient. |
| `status_code` | INTEGER | Transport status code (HTTP-style). |
| `created_at` | INTEGER | Epoch ms when queued (NOT NULL). |
| `delivered_at` | INTEGER | Epoch ms when delivery was confirmed. |
| `status` | TEXT | `pending` \| `sent` \| `delivered` \| `failed` (§11.2). |

#### `adf_timers` — scheduled wake events

| Column | Type | Meaning |
|--------|------|---------|
| `id` | INTEGER PK | Autoincrement timer id. |
| `schedule_json` | TEXT | Resolved `TimerSchedule` JSON: `once`, `interval` or `cron` (§7.6). |
| `next_wake_at` | INTEGER | Epoch ms of the next fire (indexed). |
| `payload` | TEXT | Opaque string passed to the handler when the timer fires. |
| `scope` | TEXT | JSON array of scopes, default `["system"]`; elements are `system` \| `agent`. |
| `lambda` | TEXT | Lambda reference run on fire (system scope). |
| `warm` | INTEGER | `0`/`1`; keep the system-scope sandbox warm. |
| `run_count` | INTEGER | Number of times the timer has fired. |
| `created_at` | INTEGER | Epoch ms when created. |
| `last_fired_at` | INTEGER | Epoch ms of the most recent fire. |
| `locked` | INTEGER | `0`/`1`; owner lock. The agent cannot modify or delete a locked timer. |
| `expired` | INTEGER | `0`/`1`; `1` once the timer has no further fire time (§7.7). Expired rows are kept as history. |
| `loop` | TEXT | Loop an agent-scope fire wakes (§6.4). NULL means `main`, or a timer without agent scope. The runtime sets it from the loop that created the timer, never from tool arguments. |

#### `adf_files` — virtual filesystem

| Column | Type | Meaning |
|--------|------|---------|
| `path` | TEXT PK | Relative path, for example `README.md`, `mind.md`, `data/x.csv`. |
| `content` | BLOB | File bytes. |
| `mime_type` | TEXT | MIME type. |
| `size` | INTEGER | Byte length of `content`. |
| `protection` | TEXT | `read_only` \| `no_delete` \| `none` (§4.2). |
| `authorized` | INTEGER | `0`/`1`; the owner has approved the file as trusted code (§4.3). |
| `created_at` | TEXT | ISO-8601 creation time. |
| `updated_at` | TEXT | ISO-8601 last-modified time. |

#### `adf_audit` — compressed snapshots of removed data

| Column | Type | Meaning |
|--------|------|---------|
| `id` | INTEGER PK | Autoincrement snapshot id. |
| `source` | TEXT | What was captured (§13.3). Indexed with `start_seq`. |
| `start_seq` | INTEGER | For `loop:<name>` snapshots: lowest `adf_loop.seq` in the blob. NULL otherwise. A `seq` MAY appear in more than one blob (for example after a history rebuild), so readers scan every candidate. |
| `end_seq` | INTEGER | For `loop:<name>` snapshots: highest `adf_loop.seq` in the blob. NULL otherwise. |
| `ref` | TEXT | Per-item reference: ALF message id for `inbox_message` and `outbox_message`, file path for `file`. NULL for loop snapshots and legacy rows. |
| `entry_count` | INTEGER | Number of rows captured. |
| `size_bytes` | INTEGER | Uncompressed size of the captured rows. |
| `data` | BLOB | Brotli-compressed JSON of the captured rows. |
| `created_at` | INTEGER | Epoch ms when the snapshot was taken. |

#### `adf_identity` — keys and secrets

| Column | Type | Meaning |
|--------|------|---------|
| `purpose` | TEXT PK | Key purpose, for example `crypto:signing:private_key`, `mcp:<server>:<key>`, or a key set with `set_identity` (§8.2). |
| `value` | BLOB | Key material or secret bytes; encrypted when `encryption_algo` is not `plain`. |
| `encryption_algo` | TEXT | `plain` (default), `env:identity`, `env:credentials`, or a legacy password algorithm id (§8.3). |
| `salt` | BLOB | KDF salt for legacy password-encrypted rows. |
| `kdf_params` | TEXT | JSON KDF parameters for legacy password-encrypted rows. |
| `code_access` | INTEGER | `0`/`1`; whether agent code may read the row. Default `0`. Rows created by the `set_identity` code method are inserted with `1`; overwriting an existing row does not change the flag. |

#### `adf_attestations` — signed statements about this agent

Attestations are public and stored unencrypted, so the runtime can build the agent card while the file is password-locked. Attestations with role `owner` or `operator` describe current state and are replaced when the agent is re-keyed. Attestations with any other role (`clone`, `rotation`, …) record past events and are never deleted by re-attestation. Before schema version 24 they were stored in a single `adf_meta` key.

| Column | Type | Meaning |
|--------|------|---------|
| `id` | INTEGER PK | Autoincrement row id (insertion order). |
| `issuer` | TEXT | DID of the signer. |
| `subject` | TEXT | DID the attestation is about. The signature covers it, so an attestation cannot be moved to another identity. |
| `role` | TEXT | `owner` \| `operator` \| `runtime` \| `clone` \| `rotation` \| other. |
| `issued_at` | TEXT | ISO-8601. |
| `expires_at` | TEXT | Optional ISO-8601 expiry. |
| `scope` | TEXT | What the attestation covers (for `clone`: the prior agent DID). |
| `signature` | TEXT | `ed25519:<base64>` over the canonical JSON of every field except `signature`. |
| `raw_json` | TEXT | The signed canonical fields. Verification uses this column, not the other columns. |

#### `adf_tasks` — asynchronous tool calls and approvals

| Column | Type | Meaning |
|--------|------|---------|
| `id` | TEXT PK | Task id. |
| `tool` | TEXT | Name of the tool the task runs. |
| `args` | TEXT | JSON tool arguments; default `{}`. |
| `status` | TEXT | `pending` \| `pending_approval` \| `running` \| `completed` \| `failed` \| `denied` \| `cancelled` (indexed; §13.4). |
| `result` | TEXT | JSON result when completed. |
| `error` | TEXT | Error text when failed. |
| `created_at` | INTEGER | Epoch ms when created. |
| `completed_at` | INTEGER | Epoch ms when resolved. |
| `origin` | TEXT | What created the task (for example agent, executor, owner). |
| `requires_authorization` | INTEGER | `0`/`1`; the task needs owner approval before it runs. |
| `executor_managed` | INTEGER | `0`/`1`; the executor is waiting synchronously for this tool call, so `task_resolve` signals approval without running the tool a second time. |
| `approval_meta` | TEXT | JSON for approval tasks: `{ reason: 'restricted' \| 'protection', protection?: { kind, target, level, description } }`. `on_task_create` lambdas, approval UIs and reads after a restart use it to show what is being approved. NULL for other tasks. |
| `loop` | TEXT | Loop whose turn created the task (§6.4). NULL means `main` or an origin outside any loop. |

#### `adf_logs` — structured runtime log

| Column | Type | Meaning |
|--------|------|---------|
| `id` | INTEGER PK | Autoincrement log id. |
| `level` | TEXT | `debug` \| `info` \| `warn` \| `error` (indexed). |
| `origin` | TEXT | Emitting subsystem (indexed). |
| `event` | TEXT | Event name. |
| `target` | TEXT | Affected entity, if any. |
| `message` | TEXT | Human-readable message (NOT NULL). |
| `data` | TEXT | Optional JSON detail. |
| `created_at` | INTEGER | Epoch ms when logged. |
| `loop` | TEXT | Loop that emitted the row (§6.4). NULL means `main` or an origin outside any loop (system, MCP, adapter). |

### 3.4 User Tables

An agent MAY create tables whose names do not start with `adf_`. Runtime tools require the prefix `local_` for writes (§10.3), and `security.table_protections` (§5.6) applies only to `local_*` tables.

```sql
CREATE TABLE local_subscribers (
  agent_id TEXT,
  topic TEXT,
  subscribed_at INTEGER
);
```

A runtime SHOULD load sqlite-vec when it is available, so that agents can create vector tables with `CREATE VIRTUAL TABLE local_embeddings USING vec0(...)`.

### 3.5 Schema Migration

`adf_meta.adf_schema_version` is the storage schema version. The current storage schema version is 32; §17.1 lists the revisions. A runtime MUST apply migrations in order and MUST NOT downgrade a newer schema. A runtime that cannot apply a migration MUST NOT modify the file; it SHOULD open the file read-only or refuse to open it with an error that names both versions. A runtime SHOULD create a backup before it migrates a file and remove it only after the migration succeeds.

---

## 4. Virtual Filesystem and Metadata

### 4.1 Reserved Files

| Path | Protection | Description |
|------|------------|-------------|
| `README.md` | `no_delete` | Primary document (§1.3). |
| `mind.md` | `no_delete` | Working memory: an index over the pages in `mind/`, injected into the system prompt through `{{mind.md}}` (§5.1). |
| `mind/log.md` | `no_delete` | Append-only history of changes to the memory. |
| `soul.md` | `no_delete` | Voice file, written by the agent and injected through `{{soul.md}}`. |
| `public/*` | `none` | Files served by `serving.public` (§12.1). |
| `lib/*` | `none` | RECOMMENDED location for lambdas and support scripts. |
| `skills/*` | `none` | Installed skill packages, one directory per skill; `skills/<name>/SKILL.md` is the manifest (§5.1). |
| `skills-registry.json` | `read_only` | Catalog of installed skills, generated by the runtime and injected through `{{skills-registry.json}}` (§5.1). |
| `skills-state.json` | `none` | Skill mute list: `{ "schema": 1, "disabled": [...] }`. When it is absent, every installed skill is enabled. |

A runtime creates `README.md`, `mind.md`, `mind/log.md` and `soul.md` when it creates a file (§14.1), and adds any that are missing when it migrates an older file.

RECOMMENDED locations, not reserved:

| Path | Purpose |
|------|---------|
| `data/` | Agent-managed data files |
| `imports/` or `imported/` | Received attachments and imported files |
| `mcp/` | Files saved from MCP tool results or resources |

### 4.2 File Protection

`adf_files.protection` controls access through agent tools:

| Level | Read | Write | Delete |
|-------|------|-------|--------|
| `read_only` | Yes | No | No |
| `no_delete` | Yes | Yes | No |
| `none` | Yes | Yes | Yes |

A runtime MUST refuse an agent's write to a `read_only` file and an agent's delete of a `read_only` or `no_delete` file, unless the call is authorized (§8.6) or the owner approves it. No config field changes these rules (§5.6).

### 4.3 File Authorization

`adf_files.authorized` records that the owner trusts the file as code. It is independent of the protection level.

- `authorized = 1` means the owner, the runtime, or authorized code approved the file.
- A runtime MUST set `authorized` to `0` when an agent writes to the file.
- Code from an authorized file MAY call restricted tools and restricted code methods (§8.6, §8.7).

### 4.4 Meta Protection

`adf_meta.protection` controls access through agent tools:

| Level | Read | Write | Delete | Use |
|-------|------|-------|--------|-----|
| `none` | Yes | Yes | Yes | Agent-managed values |
| `readonly` | Yes | No | No | Runtime- or owner-managed values |
| `increment` | Yes | Increase only | No | Monotonic counters |

A runtime MUST create every `adf_*` key in the registry (§3.3) with the protection listed there. A runtime re-applies `readonly` to `adf_did`, `adf_owner_did`, `adf_runtime_did` and `adf_did_history` on every open.

---

## 5. Agent Configuration

Configuration is stored as JSON in `adf_config.config_json`, a single-row table (`id = 1`). A runtime MUST preserve config fields it does not recognise (§0.2).

A runtime validates config against its schema at two points, with different results:

- *On write* through `sys_update_config`, the runtime MUST reject a change that introduces a schema violation. A change to a config that is already invalid is accepted when it introduces no new violation, so an invalid file stays editable.
- *On load*, a config that fails validation is loaded, and the runtime logs a warning. A runtime SHOULD NOT refuse to open a file because its config fails validation.

### 5.1 Top-Level Shape

Example (non-normative values):

```jsonc
{
  "adf_version": "0.2",
  "id": "a1b2c3d4e5f6",
  "name": "dashboard",
  "description": "Monitors system health",
  "icon": "📊",
  "handle": "dashboard",
  "card": {
    "endpoints": {
      "inbox": "https://relay.example.com/dashboard/inbox",
      "card": "https://relay.example.com/dashboard/card",
      "health": "https://relay.example.com/dashboard/health",
      "ws": "wss://relay.example.com/dashboard/ws"
    },
    "resolution": { "method": "self" },
    "publish_attestations": false
  },

  "state": "idle",
  "start_in_state": "idle",
  "autonomous": false,
  "autostart": false,

  "model": {
    "provider": "anthropic",
    "model_id": "claude-sonnet-4-5-20250929",
    "temperature": 0.7,
    "max_tokens": 4096,
    "top_p": null,
    "reasoning": { "enabled": true, "max_tokens": 8000 },
    "multimodal": { "image": false, "audio": false, "video": false },
    "params": [],
    "provider_params": {}
  },

  "instructions": "Help the owner with their request.",
  "include_base_prompt": true,
  "bare_prompt": false,

  "context": {
    "compact_threshold": 100000,
    "audit": { "loop": true, "inbox": false, "outbox": false, "files": false },
    "dynamic_instructions": {
      "inbox_hints": true,
      "context_warning": true,
      "idle_reminder": true,
      "mesh_updates": true
    }
  },

  "tools": [],
  "triggers": {},
  "loops": [],
  "security": {},
  "limits": {},
  "recovery": {},
  "messaging": {},
  "audit": {},
  "code_execution": {},
  "logging": {},
  "mcp": {},
  "compute": {},
  "adapters": {},
  "serving": {},
  "ws_connections": [],
  "stream_bind": {},
  "stream_bindings": [],
  "umbilical": {},
  "umbilical_taps": [],
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

| Field | Section |
|-------|---------|
| `id`, `name`, `description`, `icon`, `handle`, `card` | §5.2, §5.22 |
| `state`, `start_in_state`, `autonomous`, `autostart` | §5.3 |
| `model` | §5.18 |
| `instructions`, `include_base_prompt`, `bare_prompt` | §5.1 (below) |
| `context` | §5.19 |
| `tools` | §5.4 |
| `triggers` | §5.5, §7 |
| `loops` | §6.4 |
| `security` | §5.6 |
| `limits` | §5.7 |
| `recovery` | §5.20 |
| `pre_llm_hook` | §5.21 |
| `messaging` | §5.8 |
| `audit` | §5.19 |
| `code_execution` | §5.9 |
| `logging` | §5.10 |
| `mcp` | §5.11 |
| `compute` | §5.12 |
| `adapters` | §5.13 |
| `serving` | §5.14 |
| `ws_connections` | §5.15 |
| `stream_bind`, `stream_bindings` | §5.23 |
| `umbilical`, `umbilical_taps` | §5.24 |
| `providers` | §5.16 |
| `locked_fields` | §5.17 |
| `metadata` | Descriptive: `created_at`, `updated_at`, `author`, `tags`, `version`. |

#### Instruction templating (`{{<path>}}`)

The `instructions` field, and the runtime base prompt combined with it, MAY contain `{{<path>}}` placeholders. When it assembles the system prompt, the runtime replaces each placeholder with the content of the `adf_files` entry at that exact path:

```
{{mind.md}}        → the agent's working memory
{{soul.md}}        → the agent's voice file
{{README.md}}      → the primary document
{{policy/tone.md}} → any other file
```

A conforming runtime MUST apply these rules:

- *Files only.* A placeholder resolves only against `adf_files`, never against `adf_identity`, `adf_meta` or `adf_config`. Queried values reach the model through lambdas and `loop_inject` (§9).
- *Single pass.* The runtime does not scan injected content for placeholders, so a referenced file cannot inject another file.
- *Snapshot.* The runtime reads referenced files once when the session starts and reuses them for the session. It picks up edits at the next session reset (compaction or `loop_clear`), not during the session.
- *Missing path.* A placeholder for a missing path renders as `[missing file: <path>]`.
- *Independent of `fs_read`.* Templating is owner-authored prompt composition and works whether or not the agent has `fs_read` enabled.

The default base prompt contains `{{mind.md}}`. The runtime records the resolved prompt in `adf_loop` (§1.5).

Rationale: the snapshot rule keeps the system prompt byte-stable within a session, which prompt caching requires. A visible missing-file marker makes a mistyped path auditable.

#### Prompt composition (`include_base_prompt`, `bare_prompt`)

Two top-level booleans control how much runtime-authored text surrounds `instructions`:

| Value | System prompt contains |
|---|---|
| both absent or `false` | base prompt, every conditional section the config calls for, `instructions`, identity block, multimodal block, autonomous suffix |
| `include_base_prompt: false` | everything above except the base prompt and its conditional sections |
| `bare_prompt: true` | `instructions` only |

`bare_prompt` takes precedence over `include_base_prompt`. When `bare_prompt` is true, a conforming runtime MUST omit every piece of prompt text it authored: the base prompt, all conditional sections, the identity and multimodal blocks, and the autonomous suffix. `bare_prompt` governs the system prompt only; the per-turn dynamic instructions are controlled by `context.dynamic_instructions` (§5.19). Tool schemas are sent with the API request, not in the prompt, so `bare_prompt` does not remove tools.

`{{<path>}}` placeholders inside `instructions` resolve when `bare_prompt` is true.

A conforming runtime MUST omit a prompt section whose configured text is empty or whitespace.

#### File-backed skills

A skill package is installed by writing `skills/<name>/SKILL.md` (§4.1); `skills-state.json` holds the mute list. The config has no skill fields. Installing and muting are file writes, and a conforming runtime always indexes and always injects.

A conforming runtime indexes `skills/*/SKILL.md` into `skills-registry.json` and injects that catalog through the `{{skills-registry.json}}` placeholder. Indexing and injection are the only actions the runtime takes for skills. It MUST NOT execute skill text, authorize files, enable tools, or skip owner approval because a skill is installed, enabled or selected. A skill's `requires` list is a checklist for the agent to verify; it grants nothing. Skill text is untrusted instruction content, and every action it describes goes through the normal tool, protection and approval checks.

The indexer MUST bound and validate its catalog: name and directory agreement, directory-name format, file size, entry count and serialized registry size. It MUST report each rejected package with a reason in a top-level `rejected` array of `{ path, reason }` in the registry, omitted when empty. It MUST treat a `skills-state.json` that does not parse as an empty mute list and report it in `rejected`. It MAY cap the `rejected` list so that diagnostics never displace an admissible package from the size budget. It MUST keep mute state separate from installed files, and write the registry outside `skills/` so that its own output does not trigger re-indexing.

The runtime owns `skills-registry.json`. It SHOULD hold the file at protection `read_only` and take over an agent-written file at that path on first index. The runtime MUST create the registry when it opens the file, even when no skills are installed (an empty `skills` object is a valid catalog), so that `{{skills-registry.json}}` always resolves.

A catalog change during a session MUST NOT rewrite the injected snapshot. The runtime delivers it as a keyed `loop_inject` that replaces earlier catalog injections, and the snapshot refreshes at the next session reset. A runtime that caches the assembled system prompt MUST include every injected file in the cache key, including files referenced from conditional sections, and MUST invalidate the cache on session reset.

Installation is a file write under `skills/<name>/` by any writer: the agent's `fs_write`, a Studio file write, an HTTP PUT. A conforming runtime MUST NOT require a dedicated install tool and SHOULD NOT provide one. Skill catalogs are JSON documents fetched over the runtime's outbound HTTP path and its SSRF protections (§5.6); the skills prompt section names the first-party catalog.

### 5.2 Identity Fields

| Field | Description |
|-------|-------------|
| `id` | Local runtime handle: a 12-character nanoid set at creation and never changed. Used for audit labels, event routing and log continuity. It is not the agent's identity; that is the DID in `adf_meta.adf_did` (§8.1), which changes on claim and re-key while `id` stays the same. A runtime MUST NOT use `id` as identity. |
| `name` | Display name used in UIs and discovery. |
| `description` | Capability summary used in discovery and the agent card. |
| `icon` | Display icon, typically one emoji. A runtime picks one from `id` when the file is created (schema version 31 backfills older files). |
| `handle` | URL-safe name for mesh serving: lowercase letters, digits and hyphens. |
| `card` | Agent-card overrides (§5.22). |

### 5.3 State and Turn Fields

| Field | Values | Default | Description |
|-------|--------|---------|-------------|
| `state` | `active`, `idle`, `hibernate`, `suspended`, `off` | `active` | Last persisted state (§6.1). |
| `start_in_state` | `active`, `idle`, `hibernate` | absent | State the runtime enters when it loads the agent. When absent, the runtime treats it as `active`. |
| `autonomous` | boolean | `false` | Turn behaviour of `main` (§6.3). |
| `autostart` | boolean | `false` | The runtime SHOULD start the agent when the runtime starts. |

`config.autonomous` applies to `main` only; each inner loop has its own `autonomous` field (§6.4).

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
| `name` | Built-in tool name (§10), MCP tool name `mcp_<server>_<tool>`, or a runtime tool name. |
| `enabled` | The tool exists for the agent: code and lambdas can call it. When `false`, code calls are rejected, except that authorized code MAY call a tool with `enabled: false, restricted: true` (§8.7). A missing value means `false`. |
| `visible` | The tool is in the model's tool list. The model can call a tool only when `enabled` and `visible` are both true. `visible: false` keeps a tool callable from code without showing it to the model. A missing value means `false`. |
| `restricted` | Only authorized code calls the tool freely. A model call to an enabled, visible, restricted tool requires owner approval (§8.7). |
| `locked` | Owner lock: the agent cannot modify or remove this declaration (§5.17). |
| `mcp_tool_hash` | Hash of the MCP tool schema and description the owner last reviewed. |
| `mcp_tool_status` | `new` \| `changed` \| `removed`: the MCP server's definition differs from the reviewed one. A runtime MUST set a `changed` tool to `enabled: false, restricted: true` until the owner reviews it. |

### 5.5 Triggers

Triggers are configured by trigger type. Each `TriggerConfig` has `enabled`, an optional `locked` (owner lock on the whole trigger), and a `targets` array:

```jsonc
{
  "triggers": {
    "on_inbox": {
      "enabled": true,
      "targets": [
        { "scope": "agent" },
        { "scope": "agent", "loop": "triage" },
        { "scope": "system", "lambda": "lib/router.ts:onInbox", "batch_ms": 100 }
      ]
    }
  }
}
```

§7 defines trigger types, target fields and semantics.

### 5.6 Security Configuration

```jsonc
{
  "security": {
    "allow_unsigned": true,
    "level": 1,
    "require_signature": false,
    "require_payload_signature": false,
    "allow_local_fetch": false,
    "middleware": {
      "inbox": [{ "lambda": "lib/mw.ts:inbox" }],
      "outbox": [{ "lambda": "lib/mw.ts:outbox" }]
    },
    "fetch_middleware": [{ "lambda": "lib/mw.ts:fetch" }],
    "require_middleware_authorization": true,
    "table_protections": { "local_ledger": "append_only" }
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `allow_unsigned` | `true` | Accept inbound messages without signatures (§8.5). |
| `level` | `1` | Egress signing and encryption level (§8.5). |
| `require_signature` | `false` | Reject inbound messages without a valid message signature. |
| `require_payload_signature` | `false` | Reject inbound messages without a valid payload signature. |
| `allow_local_fetch` | `false` | See below. |
| `middleware.inbox`, `middleware.outbox` | none | Message middleware (§12.3). |
| `fetch_middleware` | none | `sys_fetch` middleware (§12.3). |
| `require_middleware_authorization` | `true` | Middleware files MUST be authorized (§12.3). |
| `table_protections` | none | Map of `local_*` table name to `none` \| `append_only` \| `authorized`. `append_only` rejects `UPDATE`, `DELETE` and `DROP` through `db_execute`; `authorized` rejects every write except `CREATE` unless the caller is authorized code. An unlisted table is `none`. |

`allow_local_fetch` controls which addresses `sys_fetch` and `ws_connect` may reach. A runtime MUST check DNS-resolved addresses and every redirect hop, and MUST apply these rules in order:

1. Link-local and cloud-metadata addresses (`169.254.0.0/16`, `fe80::/10`, and their IPv4-mapped forms) are refused, whatever the flag.
2. The runtime's own control API on a loopback or unspecified address is refused, whatever the flag.
3. The agent's own served origin is allowed.
4. When `allow_local_fetch` is `true`, every other address is allowed.
5. When it is `false`, loopback addresses (`127.0.0.0/8`, `::1`, `localhost`) are allowed, and private, CGNAT (`100.64.0.0/10`), unspecified, multicast, reserved and `fc00::/7` addresses are refused.

The runtime locks `security.allow_local_fetch` and `stream_bind` for every agent, in addition to `locked_fields` (§5.17): an agent's change through `sys_update_config` is refused and becomes a request the owner MAY approve once.

`allow_protected_writes` is not a config field. A runtime MUST NOT treat it as controlling any write, and removes it from stored config on migration. File writes are governed by `adf_files.protection` alone (§4.2).

### 5.7 Limits

| Field | Default | Description |
|-------|---------|-------------|
| `execution_timeout_ms` | `60000` | Maximum run time of one code execution. |
| `max_file_read_tokens` | `30000` | Maximum tokens `fs_read` returns. |
| `max_file_write_bytes` | `5000000` | Maximum bytes one write stores. |
| `max_tool_result_tokens` | `16000` | A tool result larger than this is replaced with a preview. |
| `max_tool_result_preview_chars` | `5000` | Length of that preview. |
| `max_active_turns` | `null` | Maximum consecutive turns before the runtime suspends the agent; `null` means no limit. |
| `max_image_size_bytes` | `5242880` | Maximum inlined image size. |
| `max_audio_size_bytes` | `10485760` | Maximum inlined audio size. |
| `max_video_size_bytes` | `20971520` | Maximum inlined video size. |
| `suspend_timeout_ms` | `1200000` when absent | Time the runtime waits for the owner to answer a suspend prompt before it turns the agent `off`. |
| `hibernate_nudge` | `{ "enabled": true, "interval_ms": 86400000 }` when absent | Periodic wake of a hibernating agent. Requires `on_timer` enabled. |

### 5.8 Messaging Configuration

```jsonc
{
  "messaging": {
    "receive": true,
    "mode": "proactive",
    "visibility": "localhost",
    "inbox_mode": true,
    "allow_list": [],
    "block_list": [],
    "network": "devnet"
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `receive` | `true` | The agent registers on the mesh and accepts messages. |
| `mode` | `proactive` | See the table below. |
| `visibility` | `localhost` | Reachability tier (below). |
| `inbox_mode` | `true` | The runtime adds inbox hints to dynamic instructions and records the agent's own outgoing mesh messages in `adf_inbox` with status `read`. |
| `allow_list`, `block_list` | absent | Sender DIDs. A non-empty `allow_list` accepts only listed senders and `block_list` is not consulted; otherwise `block_list` refuses listed senders. When either list is non-empty, a message without a sender DID is refused. |
| `network` | `devnet` when absent | ALF network name (§11.1). |

| Mode | Behaviour |
|------|----------|
| `proactive` | The agent can send at any time. |
| `respond_only` | The agent can reply to a valid parent message or during an inbox-triggered turn. |
| `listen_only` | The agent cannot send. |

| Visibility | Who can discover and reach the agent |
|------------|--------------------------------------|
| `directory` | Agents in the same runtime whose file is in the same directory or an ancestor directory. |
| `localhost` | Any agent on the same machine. |
| `lan` | Any agent on the local network. |
| `public` | Any agent that can reach the runtime over the internet. |
| `off` | No agent. The agent is not listed and inbound delivery is refused. |

Tiers are nested: `public ⊃ lan ⊃ localhost ⊃ directory`. A runtime MUST enforce visibility when it accepts inbound messages and when it lists agents; visibility does not restrict outbound sends. An agent with tier `lan` or `public` is reachable from other machines only when the runtime listens on a non-loopback address; the listener address is a runtime setting. An agent behind NAT is reached through a relay or `card.endpoints` overrides (§5.22).

### 5.9 Code Execution Configuration

```jsonc
{
  "code_execution": {
    "model_invoke": true,
    "sys_lambda": true,
    "task_resolve": true,
    "loop_inject": true,
    "identity_status": true,
    "get_identity": true,
    "set_identity": true,
    "emit_event": true,
    "attestation_list": true,
    "attestation_add": true,
    "attestation_issue": true,
    "network": false,
    "packages": [{ "name": "vega-lite", "version": "^5.21.0" }],
    "restricted_methods": ["attestation_issue"]
  }
}
```

Each boolean enables the code method of the same name (§9); all default to `true`. `network` (default `false`) gives sandbox code native `fetch`/`http`/`https`. `packages` lists at most 50 npm packages available to sandbox code; `npm_install` and `npm_uninstall` edit it. `restricted_methods` (default `["attestation_issue"]`) lists methods only authorized code may call (§8.7); an explicit list replaces the default.

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

`default_level` is the minimum level stored. `rules` override it per origin glob; the first matching rule applies. `max_rows` bounds `adf_logs`; `null` means no bound.

### 5.11 MCP Configuration

```jsonc
{
  "mcp": {
    "new_tools_restricted": true,
    "servers": [
      {
        "name": "github",
        "transport": "stdio",
        "command": "node",
        "args": ["server.js"],
        "env": {},
        "env_schema": [{ "key": "GITHUB_TOKEN", "scope": "agent", "required": true }],
        "npm_package": "@modelcontextprotocol/server-github",
        "source": "npm:@modelcontextprotocol/server-github",
        "tool_call_timeout_ms": 60000,
        "restricted": false,
        "run_location": "shared",
        "available_tools": []
      },
      {
        "name": "docs",
        "transport": "http",
        "url": "https://mcp.example.com/mcp",
        "headers": {},
        "header_env": [{ "header": "Authorization", "env": "DOCS_TOKEN" }],
        "oauth": false
      }
    ]
  }
}
```

| Field | Description |
|-------|-------------|
| `name` | Server name, unique in the agent. |
| `transport` | `stdio` \| `http`. |
| `command`, `args` | stdio: process to start. |
| `url` | http: server endpoint. |
| `headers` | http: static request headers. |
| `header_env` | http: `{ header, env, required?, credential_ref? }[]`; the header value comes from a credential. |
| `bearer_token_env_var` | http: credential used as a bearer token. |
| `oauth` | http: the server uses interactive OAuth sign-in. |
| `env` | Static environment variables. |
| `env_schema` | `{ key, scope: 'agent' \| 'app', required?, description?, credential_ref? }[]`. `agent` values are stored in `adf_identity` as `mcp:<server>:<key>` (§8.2); `app` values are runtime settings and do not travel with the file. Takes precedence over the legacy `env_keys` list. |
| `npm_package`, `pypi_package`, `source` | Package origin; `source` is `npm:…`, `uvx:…`, `pip:…`, `http:…` or `custom`. |
| `tool_call_timeout_ms` | Per-server tool call timeout; the runtime default is 60000. |
| `available_tools` | Cached `{ name, description?, input_schema }[]` from the last discovery. |
| `restricted` | Every tool of the server is restricted (§8.7). |
| `run_location` | `host` (requires `compute.host_access`) \| `shared`. When absent, the server runs in the agent's isolated container if `compute.enabled`, otherwise in the shared container. |
| `credential_files` | `{ path, required?, write_back? }[]`: credential files the server reads, stored in `adf_identity` and written to the server's filesystem before each start. |

`new_tools_restricted` (default `true`) marks the tools of a newly attached server `restricted`. It affects only tools declared after it changes.

The MCP configuration travels with the file. Installed server packages, app-scoped credentials, process supervision and scratch directories are runtime concerns (§15).

### 5.12 Compute Configuration

```jsonc
{
  "compute": {
    "enabled": false,
    "host_access": false,
    "allowed_targets": ["isolated", "shared"],
    "default_target": "isolated",
    "browser": true,
    "packages": { "pip": [] }
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `false` | The runtime gives the agent an isolated container for its MCP servers and `compute_exec`. |
| `host_access` | `false` | The agent MAY run MCP servers on the host machine (`run_location: "host"`) and use the `host` target of `compute_exec` and `fs_transfer`. A runtime MUST also require a runtime-level host-access setting before it honours this field. |
| `allowed_targets` | absent | Target ids `compute_exec` may select: `isolated`, `shared`, `host`, or runtime-defined external targets. When absent, the runtime's built-in behaviour applies. |
| `default_target` | absent | Target used when `compute_exec` names none. MUST be in `allowed_targets`. When absent, the runtime uses the least-privileged available target. |
| `browser` | `true` | The isolated container runs a visible desktop and browser. |
| `packages.pip` | `[]` | Python packages installed in the container at start. `packages.npm` is deprecated; npm packages belong in `code_execution.packages`. |
| `target` | absent | Deprecated single external target; migrated to `allowed_targets`. |

### 5.13 Channel Adapter Configuration

```jsonc
{
  "adapters": {
    "telegram": {
      "enabled": true,
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
      "config": {
        "address": "agent@example.com",
        "poll_interval": 30000,
        "idle": true
      }
    }
  }
}
```

`policy.dm` is `all` \| `allowlist` \| `none`; `policy.groups` is `all` \| `mention` \| `none`. Adapters convert platform messages into `adf_inbox` rows and deliver `adf_outbox` rows to platform APIs (§11.6). An adapter MUST read its credentials from the agent's `adf_identity` under the purpose `adapter:<type>:<KEY>` (for example `adapter:telegram:TELEGRAM_BOT_TOKEN`; §8.2). There is no config field that names a credential and no fallback store; a missing row is an error.

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
        "on_card": true,
        "middleware": [{ "lambda": "lib/auth.ts:check" }],
        "locked": false
      },
      {
        "method": "WS",
        "path": "/ws",
        "lambda": "lib/ws.ts:onEvent",
        "high_water_mark_bytes": 1048576
      }
    ]
  }
}
```

Route fields: `method` (`GET` \| `POST` \| `PUT` \| `PATCH` \| `DELETE` \| `WS`), `path`, `lambda`, `warm`, `cache_ttl_ms`, `on_card` (list the route in the agent card's `api_routes`; default `false`), `middleware` (§12.3), `locked` (owner lock), `high_water_mark_bytes` (WS routes: inbound backpressure threshold). Defaults: `public` and `shared` disabled, `api` empty. §12.1 defines resolution.

### 5.15 WebSocket Connections

```jsonc
{
  "ws_connections": [
    {
      "id": "relay",
      "url": "wss://relay.example.com/me/ws",
      "did": "did:key:z6Mk…",
      "enabled": true,
      "lambda": "lib/ws.ts:onEvent",
      "auth": "auto",
      "auto_reconnect": true,
      "reconnect_delay_ms": 5000,
      "keepalive_interval_ms": 30000,
      "connect_timeout_ms": 15000,
      "high_water_mark_bytes": 1048576
    }
  ]
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `did` | absent | Expected remote DID, verified during authentication. |
| `auth` | `auto` | `auto` authenticates when a signing key is available; `required` fails without it; `none` skips it. |
| `connect_timeout_ms` | `15000` | Abort a connection attempt that has not opened. |
| `high_water_mark_bytes` | `1048576` | `ws_send` waits for the send buffer to drain above this size. |

### 5.16 Provider Overrides

```jsonc
{
  "providers": [
    {
      "id": "custom:local",
      "type": "openai-compatible",
      "name": "Local Model",
      "baseUrl": "http://localhost:11434/v1",
      "preset": "ollama",
      "defaultModel": "llama",
      "params": [],
      "requestDelayMs": 0
    }
  ]
}
```

`type` is `anthropic` \| `openai` \| `openai-compatible` \| `openrouter`. `preset` is a runtime catalog key used for display. Provider entries travel with the file; provider credentials travel only when stored in `adf_identity` (§8.2).

### 5.17 Locked Fields and Owner-Only Paths

`locked_fields` is an array of top-level or dot-path config fields that the agent cannot change through `sys_update_config`. A lock on a path also locks every path below it, and a write to a parent of a locked path is refused.

A conforming runtime MUST refuse these `sys_update_config` changes from the agent, with no approval path:

- any path containing the segment `locked`, `locked_fields`, `restricted` or `restricted_methods`;
- the top-level fields `adf_version`, `id`, `metadata`, `locked_fields` and `providers`;
- replacing the whole `security` object, and any change under `security.allow_unsigned`, `security.require_middleware_authorization`, `security.middleware` or `security.fetch_middleware`;
- replacing or removing an array element that has `locked: true`, and re-declaring a locked or restricted entry with `locked: false` or `restricted: false`.

A runtime MUST treat `security.allow_local_fetch` and `stream_bind` as locked for every agent (§5.6). A change to a path in `locked_fields` or to these two paths is refused and becomes a request the owner MAY approve once. Authorized code MAY change a locked path; the runtime logs the change.

The `state` field accepts only `active`, `idle`, `hibernate` and `off` through `sys_update_config`.

Locks constrain the agent. The owner changes any field through the runtime's own controls.

### 5.18 Model Configuration

| Field | Default | Description |
|-------|---------|-------------|
| `provider` | `""` | Provider id: a built-in provider or an entry in `providers` (§5.16). |
| `model_id` | `""` | Model id at that provider. |
| `temperature` | `0.7` | Sampling temperature. |
| `max_tokens` | `4096` | Maximum output tokens per request. |
| `top_p` | absent | Nucleus sampling. |
| `reasoning` | absent | `{ enabled?, effort?, max_tokens?, exclude?, preserve?, summary? }`; `effort` is `minimal` \| `low` \| `medium` \| `high` \| `xhigh`, `summary` is `auto` \| `concise` \| `detailed`. The runtime maps it to each provider's reasoning parameters. |
| `multimodal` | absent | `{ image?, audio?, video? }`: which media types the runtime sends to the model. |
| `params` | absent | `{ key, value }[]` extra request parameters. |
| `provider_params` | absent | Provider-specific request options. |

Deprecated fields: `thinking_budget` (a runtime folds it into `reasoning = { enabled: true, max_tokens }` on load), `vision` (replaced by `multimodal.image`) and `compact_threshold` (moved to `context`).

### 5.19 Context and Audit Configuration

| Field | Default | Description |
|-------|---------|-------------|
| `context.compact_threshold` | `100000` when absent | Token count at which the runtime compacts a transcript (§13.2). |
| `context.audit.loop` | `true` | Snapshot transcript rows to `adf_audit` before compaction or clearing. |
| `context.audit.inbox`, `context.audit.outbox` | `false` | Snapshot each message at arrival or send (`inbox_message`, `outbox_message`). |
| `context.audit.files` | `false` | Snapshot a file before deletion. |
| `context.dynamic_instructions.inbox_hints` | `true` | Add unread-message hints to each turn. |
| `context.dynamic_instructions.context_warning` | `true` | Warn the model once when the transcript is within 15000 tokens of the compaction threshold. |
| `context.dynamic_instructions.idle_reminder` | `true` | On each turn of an autonomous agent with `sys_set_state` enabled, remind the model to set `idle` when its work is done. |
| `context.dynamic_instructions.mesh_updates` | `true` | Send the list of reachable agents when it changes. |

The top-level `audit` object has the same fields and defaults as `context.audit`. The runtime reads `context.audit`; when it is absent, it reads `audit`; when both are absent, it audits nothing.

### 5.20 Recovery Configuration

`recovery` controls how the runtime retries a turn that failed with a transient provider error (§6.2).

| Field | Default | Description |
|-------|---------|-------------|
| `auto_retry` | `true` | Retry the failed turn. |
| `max_attempts` | `5` | Consecutive failed attempts per work item before the runtime stops retrying. |
| `base_delay_ms` | `15000` | First retry delay; it doubles each attempt with ±20% jitter. |
| `max_delay_ms` | `300000` | Retry delay ceiling. |

### 5.21 Pre-LLM Hook

`pre_llm_hook` names a lambda that transforms each conversational model request before the runtime sends it.

| Field | Default | Description |
|-------|---------|-------------|
| `source` | required | Lambda reference. It receives `{ request, loop: { name } }` and returns the replacement request. |
| `scope` | `all` | `all` (every loop) \| `main` \| `loops` (the loops in `loops`). |
| `loops` | absent | Inner-loop names; required when `scope` is `loops`. MUST NOT contain `main`. |
| `include_main` | `false` | With `scope: "loops"`, also run for `main`. |
| `timeout_ms` | absent | 1000–300000; also bounded by `limits.execution_timeout_ms`. |

The hook cannot change tool authorization, cancellation or runtime callbacks.

### 5.22 Agent Card Overrides

`card` overrides the agent card (§11.5): `endpoints` (`inbox`, `card`, `health`, `ws` URLs), `resolution`, and `publish_attestations` (default `false`). When `publish_attestations` is false, the card omits `owner` and `operator` attestations, so the card does not link the agent to its owner.

### 5.23 Stream Bindings

`stream_bindings` declares byte streams the runtime connects between two endpoints; `stream_bind` controls which endpoint kinds the agent may use.

```jsonc
{
  "stream_bind": {
    "host_process_bind": false,
    "container_shared_bind": false,
    "container_isolated_bind": false,
    "allow_tcp_bind": false,
    "tcp_allowlist": [{ "host": "127.0.0.1", "port": 5432 }]
  },
  "stream_bindings": [
    { "id": "db", "a": { "kind": "ws", "connection_id": "relay" }, "b": { "kind": "tcp", "host": "127.0.0.1", "port": 5432 }, "bidirectional": true }
  ]
}
```

Endpoint kinds are `ws`, `process` (isolation `host`, `container_shared` or `container_isolated`), `tcp` and `umbilical`; `umbilical` is allowed only as endpoint `a`. Every `stream_bind` flag defaults to `false`, and `stream_bind` is locked for every agent (§5.17). `stream_bindings` defaults to `[]`.

### 5.24 Umbilical

The umbilical is the runtime's event stream for one agent. `umbilical` sets emission options, all off by default: `stream_deltas` (emit streaming output deltas) and `log` (`{ enabled?, max_events?, exclude_types? }`, an in-memory replay window of default 2000 events that the runtime does not persist).

`umbilical_taps` declares lambdas that receive umbilical events: `{ name, lambda, filter: { event_types, when?, allow_wildcard }, exclude_own_origin, max_rate_per_sec }`. `event_types` defaults to `["*"]`, which requires `allow_wildcard: true`. `exclude_own_origin` defaults to `true` and `max_rate_per_sec` to `100`.

---

## 6. States and Loops

### 6.1 Agent States

`config.state` stores one of five states:

| State | Description | Agent-scope wake behaviour |
|-------|-------------|---------------------------|
| `active` | The agent is running or ready to run. | Runs |
| `idle` | The agent waits for work. | Wakes for any agent-scope trigger (§7.3) |
| `hibernate` | The agent waits for timers only. | Wakes for `on_timer` only |
| `suspended` | The runtime stopped the agent for safety (for example `max_active_turns`). | Wakes only when the owner resumes it |
| `off` | The agent is stopped. | Never; the owner restarts it |

A runtime also keeps an executor state for each loop in memory: `idle`, `thinking`, `tool_use`, `awaiting_approval`, `awaiting_ask`, `suspended`, `error`, `stopped`. Executor states are not stored in the file. `error` is an executor state, not a value of `config.state`.

A runtime transitioning an agent to `off` MUST stop its model requests and pending triggers and release its runtime resources: mesh registration, MCP server connections, adapters, WebSocket connections and code sandboxes. The file stays open to the runtime.

### 6.2 State Transitions

| Actor | Can set |
|-------|---------|
| Model, through `sys_set_state` | `idle`, `hibernate`, `off` |
| Code, through `adf.sys_set_state` | `idle`, `hibernate`, `off` |
| Agent, through `sys_update_config` on `state` | `active`, `idle`, `hibernate`, `off` |
| Runtime | `active`, `suspended`, `off` |
| Owner | any state, through runtime controls |

When a trigger wakes an agent from `idle` or `hibernate`, the runtime records that state, runs the turn, and returns the agent to the recorded state unless the turn set another one. `sys_set_state` called from an inner loop changes that loop's executor only (§6.4).

A failure of the executor itself (a corrupt session, a tool registry fault) sets the executor state `error` and is logged with `level="error"`, `event="turn_error"`. A transient provider failure (rate limit, provider 5xx, network timeout, connection reset) MUST NOT set `error`: the runtime retries the turn according to `recovery` (§5.20) and otherwise returns the loop to `idle`, so triggers and timers run again. A runtime SHOULD log transient failures with `event="provider_error"` and `level="warn"` when a retry is scheduled, so that agent code can tell the two cases apart with `db_query`.

### 6.3 Turn Behaviour

`autonomous` selects how a turn ends. It is set per loop: `config.autonomous` for `main`, `loops[].autonomous` for an inner loop (§6.4).

| Behaviour | `autonomous: false` | `autonomous: true` |
|----------|---------------------|--------------------|
| Reply with text and no tool call | Ends the turn | The runtime continues the turn with a reminder; after 4 consecutive text-only replies it sets the loop `idle` |
| `say` | Continues the turn | Continues the turn |
| `ask` | Waits for the owner's answer | Waits for the owner's answer |
| `sys_set_state` | Ends the turn and sets the state | Ends the turn and sets the state |
| `max_active_turns` reached | Suspends | Suspends |

If the owner sends a message while a turn runs, the runtime MAY abort the turn and start a new one with the message.

### 6.4 Loops

A loop is a named conversation of the agent (§0.3). Every agent has the loop `main`; triggers wake `main` unless a target names another loop. Inner loops are additional loops declared in `config.loops`. All loops of an agent share its file, identity, credentials, channels and files; an inner loop has no identity, credentials or channels of its own.

*`main`.* `main` is implicit. A config MUST NOT declare a loop named `main`, and `loop_manage` MUST refuse to create, read, update or delete it.

*Declaration.* `config.loops` is an array of `LoopConfig`, default `[]`:

| Field | Default | Description |
|-------|---------|-------------|
| `name` | required | Matches `^[a-z0-9][a-z0-9_-]{0,31}$`, is not `main`, and is unique within `loops` compared case-insensitively. |
| `goal` | required | At most 4000 characters. The runtime uses it as the loop's instructions, after a runtime-authored preamble. |
| `enabled` | required | A disabled loop does not run. |
| `autostart` | `false` | Run a first turn on the goal when the loop is created and each time the agent starts. |
| `autonomous` | `false` | Turn behaviour (§6.3). Not inherited from `config.autonomous`. |
| `model` | the agent's `model` | Model for this loop. |
| `compact_threshold` | the agent's `context.compact_threshold` | Compaction threshold for this loop's transcript. |
| `tools` | `[]` when absent | Tool allow-list, at most 64 names. MUST NOT contain `sys_update_config`, `loop_manage` or `sys_create_adf`. `loop_manage` gives a new loop `["loop_send", "loop_list", "sys_set_state"]` when the call names no tools. |

*Effective tools.* A runtime MUST compute an inner loop's tools as the intersection of `tools` with the agent's enabled tool declarations, minus `sys_update_config`, `loop_manage` and `sys_create_adf`, minus every tool the agent declares `restricted`, minus the tools of every MCP server declared `restricted`. The runtime then adds `loop_compact` and `loop_clear` unless the agent has disabled or restricted them. An inner loop therefore never holds a tool that `main` lacks, and never holds a tool that needs owner approval.

*Code execution.* Code run from an inner loop uses a fixed `code_execution` profile: `model_invoke`, `sys_lambda`, `identity_status`, `loop_inject` and `emit_event` are enabled; `get_identity`, `set_identity`, `task_resolve`, the `attestation_*` methods and `network` are disabled; `packages` is empty; `restricted_methods` is the union of the profile's list and the agent's list.

*Storage.* Each loop's transcript is the `adf_loop` rows with `loop = <name>`. `adf_timers`, `adf_tasks` and `adf_logs` rows carry the loop that created them in their `loop` column; NULL means `main`. Transcript snapshots use the `adf_audit` source `loop:<name>` (§13.3). Each loop is compacted separately (§13.2).

*Routing.* A trigger target with `loop: "<name>"` wakes that loop; a target without `loop` wakes `main` (§7.2). An agent-scope timer wakes the loop in its `loop` column (§7.7). The model moves work between loops with `loop_send`. A runtime MUST drop, and log with `event="loop_dispatch_dropped"`, a dispatch addressed to a loop that does not exist or is disabled; it MUST NOT deliver it to `main` instead.

*Management.* `loop_manage` is available only in `main`. Its actions are `create`, `get`, `update` and `delete`; `update` cannot rename a loop. A runtime MUST refuse to create a loop when the agent already has 16 inner loops, and MUST refuse `loop_manage` changes when `locked_fields` locks `loops`. Deleting a loop, through `loop_manage` or by removing it from config, stops it, writes its transcript to `adf_audit` as `loop:<name>` whatever `audit.loop` says, deletes its unlocked timers and keeps its locked timers.

---

## 7. Triggers and Timers

### 7.1 Trigger Types

| Trigger | Event |
|---------|-------|
| `on_startup` | The agent starts. |
| `on_inbox` | A message arrives in `adf_inbox`. |
| `on_outbox` | A message is sent from `adf_outbox`. |
| `on_file_change` | A watched file is created, modified or deleted. |
| `on_chat` | The owner sends a chat message. |
| `on_timer` | A timer fires. |
| `on_tool_call` | A matching tool call completes or is denied. |
| `on_task_create` | A task is created. |
| `on_task_complete` | A task reaches a terminal status. |
| `on_logs` | A matching log row is written. |
| `on_llm_call` | A model call completes. The event `source` is `turn`, `compaction` or `model_invoke`. |

A runtime SHOULD NOT let an event caused by a handler trigger that same handler again. An `on_file_change` target MAY set `filter.include_self: true` to receive writes by its own agent and other lambdas, but the lambda that made a write MUST NOT receive the event for that write. `on_logs` handlers MUST NOT receive the log rows they produce.

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
  "locked": false,
  "loop": null
}
```

| Field | Description |
|-------|-------------|
| `scope` | `system` or `agent` (§7.3). |
| `lambda` | System scope only. Lambda reference. |
| `command` | System scope only. Shell command, where the runtime supports it. `lambda` and `command` are mutually exclusive. |
| `warm` | System scope only. Keep the sandbox warm between events. |
| `filter` | Trigger-specific filter (§7.4). |
| `debounce_ms` | Fire once after events stop arriving for this long. |
| `interval_ms` | Fire at most once per interval. |
| `batch_ms` | Collect events for this long, then fire once with all of them. |
| `batch_count` | Fire a batch early when this many events have collected. Requires `batch_ms`. |
| `locked` | Owner lock on this target. |
| `loop` | Agent scope: the loop the target wakes (§6.4). Absent means `main`. |

A target MUST set at most one of `debounce_ms`, `interval_ms` and `batch_ms`. System-scope targets run on behalf of the agent as a whole and are evaluated once, not per loop.

### 7.3 Trigger Scopes

| Scope | Description |
|-------|-------------|
| `system` | Runs a lambda or command on the code path. Fires in every state except `off`. |
| `agent` | Starts a turn on the model path. Gated by state (§7.5). |

A system-scope lambda receives the event object. An agent-scope target does not pass the raw event; the runtime starts a turn with a formatted trigger message. For `on_inbox`, the message summarises the inbox and the model reads messages with `msg_read`.

### 7.4 Trigger Filters

| Trigger | Filter fields |
|---------|---------------|
| `on_inbox` | `source` (string), `sender` (string) |
| `on_outbox` | `to` |
| `on_file_change` | `watch` (glob, required), `include_self` (default `false`) |
| `on_tool_call` | `tools` (globs, required) |
| `on_task_create` | `tools` (globs) |
| `on_task_complete` | `tools` (globs), `status` |
| `on_logs` | `level` (array), `origin` (array of globs), `event` (array of globs) |
| `on_llm_call` | `source` (array), `provider` (array of provider names or ids) |

### 7.5 State Gating

| State | System scope | Agent scope |
|-------|--------------|-------------|
| `active` | Fires | Runs |
| `idle` | Fires | Fires |
| `hibernate` | Fires | `on_timer` only |
| `suspended` | Fires | No |
| `off` | No | No |

### 7.6 Timer Schedules

Timers are stored in `adf_timers`. `sys_set_timer` accepts a `schedule` object and stores its resolved form in `schedule_json`.

Input schedule:

```jsonc
{ "type": "once", "at": 1707300300000 }
{ "type": "delay", "delay_ms": 300000 }
{ "type": "interval", "every_ms": 3600000, "start_at": null, "end_at": null, "max_runs": null }
{ "type": "cron", "cron": "0 9 * * 1-5", "end_at": null, "max_runs": null }
```

Stored form (the discriminant is `mode`; a `delay` input is stored as `once`):

```jsonc
{ "mode": "once", "at": 1707300300000 }
{ "mode": "interval", "every_ms": 3600000, "start_at": null, "end_at": null, "max_runs": null }
{ "mode": "cron", "cron": "0 9 * * 1-5", "end_at": null, "max_runs": null }
```

Timer fields other than the schedule:

| Field | Description |
|-------|-------------|
| `scope` | JSON array: `["system"]`, `["agent"]`, or both. |
| `lambda` | System-scope lambda reference. |
| `warm` | Keep the lambda sandbox warm. |
| `payload` | Optional string passed to the handler. |
| `locked` | Owner lock: the agent cannot modify or delete the timer. An inner loop cannot create a locked timer. |
| `loop` | Loop an agent-scope fire wakes. The runtime sets it to the creating loop when the scope includes `agent`, and to NULL otherwise. |
| `expired` | `1` once the timer has no further fire time. |

### 7.7 Timer Firing

A timer fires for a scope when both hold:

1. The timer's `scope` includes that scope.
2. `on_timer` is enabled and has a target with that scope.

When a timer comes due, the runtime:

1. Computes the next fire time. For a `once` timer, or when `max_runs` or `end_at` has been reached, there is none, and the runtime sets `expired = 1`. Otherwise it sets `next_wake_at`.
2. Increments `run_count` and sets `last_fired_at`.
3. Delivers the event to the matching system and agent handlers. An agent-scope fire wakes the loop in the timer's `loop` column (NULL means `main`); if that loop does not exist or is disabled, the runtime drops the fire (§6.4).

A runtime MUST NOT delete expired timers as part of firing; they remain as history. If the runtime cannot deliver a `once` fire (backpressure or a dropped dispatch), it clears `expired` so that the timer fires later.

After downtime, a runtime fires each missed timer once on load and then schedules its next occurrence. A runtime MUST NOT fire every missed occurrence.

When a loop is deleted, the runtime deletes its unlocked timers and logs `loop_timers_dropped`; locked timers are kept.

---

## 8. Security, Identity, and Authorization

### 8.1 Identity Model

A runtime MUST give every new file a cryptographic identity when it creates the file (schema version 24 and later): an Ed25519 keypair sealed in the identity envelope (§8.3), a `did:key` DID in `adf_meta.adf_did`, the owner and runtime DIDs, and `owner` and `operator` attestations. A runtime provisions files created by older runtimes on first open, keeping any existing DID.

| Identifier | Store | Semantics |
|------------|-------|-----------|
| `config.id` | `adf_config` | Local runtime handle (nanoid). Unchanged by re-keying; not an identity (§5.2). |
| Agent DID | `adf_meta.adf_did` | The agent's identity: `did:key:z…` encoding of its Ed25519 public key. Changes on claim and re-key. |
| DID history | `adf_meta.adf_did_history` | Prior DIDs, oldest first, appended whenever `adf_did` is replaced or cleared. |
| Parent reference | `adf_meta.adf_parent_did` | DID of the agent that created this file (or its `config.id` for files created before schema version 24). A reader resolves it in order: current DID, DID history, legacy `config.id`. |

A `did:key` DID encodes the public key, so a key rotation produces a new DID. The runtime records continuity in `adf_did_history`; the local runtime trusts that record because it wrote it. A remote peer cannot verify continuity from the file.

A runtime MUST NOT delete a provisioned DID without recording it: an identity reset appends `adf_did` to `adf_did_history` and then sets `adf_did` to the empty string.

### 8.2 Identity Store

`adf_identity` stores keys and secrets by purpose:

| Purpose | Description |
|---------|-------------|
| `crypto:signing:private_key` | Ed25519 private key (sealed: `env:identity`) |
| `crypto:signing:public_key` | Ed25519 public key (`plain`) |
| `crypto:envelope:identity` | Identity-envelope descriptor: JSON keyslot array (`plain`; contains only wrapped keys) |
| `crypto:envelope:credentials` | Credentials-envelope descriptor (`plain`) |
| `crypto:kdf:salt` | Legacy password KDF salt |
| `crypto:kdf:params` | Legacy password KDF parameters |
| `mcp:<server>:<key>` | MCP server credential (sealed: `env:credentials`) |
| `adapter:<type>:<KEY>` | Channel adapter credential (sealed: `env:credentials`), for example `adapter:telegram:TELEGRAM_BOT_TOKEN`, `adapter:slack:SLACK_BOT_TOKEN`, `adapter:email:EMAIL_USERNAME`, `adapter:email:EMAIL_PASSWORD`, `adapter:discord:DISCORD_BOT_TOKEN` |
| `openai_key`, `anthropic_key`, other keys | Provider or application secrets (sealed: `env:credentials`) |

`code_access` controls whether agent code may read a row through the identity methods (§9). A runtime MUST NOT return a `crypto:signing:*`, `crypto:envelope:*` or `crypto:kdf:*` row to agent code, whatever its `code_access`.

Public keys are stored as ordinary rows, so `adf_identity` stays a uniform `purpose → value` store. A runtime that needs the public identity without unlocking the file reads the `readonly` keys in `adf_meta`, the signed agent card, or the `plain` `crypto:signing:public_key` row.

### 8.3 Encryption at Rest: Envelopes

Secrets are encrypted with dual-envelope keyslot encryption (design document: `docs/design/ADF_IDENTITY_SPEC_v0.1.md`). A random 32-byte data encryption key (DEK) encrypts the rows of each envelope. The DEK is wrapped once per keyslot, and any slot opens the envelope.

| Envelope | Covers | Allowed slots |
|----------|--------|---------------|
| `identity` | `crypto:signing:private_key` | `owner`, `runtime`. A runtime MUST NOT add a password slot, so copying the file does not transfer the identity. |
| `credentials` | every non-`crypto:*` secret (`set_identity` rows, `mcp:*`, `adapter:*`, provider keys) | `owner`, `runtime`, and an optional `password` slot used to share the file |

- *Sealed rows:* `encryption_algo = 'env:identity' | 'env:credentials'`, `value = iv(12) || ciphertext || tag(16)`, `salt` NULL, `kdf_params` NULL.
- *Key slots:* ephemeral X25519 ECDH against the recipient's encryption public key, then HKDF-SHA256 (info `adf-envelope-v1:<envelope>`), then AES-256-GCM over the DEK. Wrapping needs only the recipient's public key, so the runtime writes the owner slot without the owner's seed.
- *Password slots:* scrypt (`N=2^17, r=8, p=1`, 32-byte salt), then AES-256-GCM over the DEK. New password slots MUST use scrypt.
- *Unlock order:* runtime slot, then owner slot (derived from the owner's mnemonic; a successful owner unlock adds a runtime slot for this installation, so the seed is needed at most once per file per machine), then a password prompt when needed. Unwrapped DEKs are held in memory per open file and MUST NOT be written to disk.
- *Recipient adoption:* when a recipient unlocks a foreign credentials envelope with a share password, the runtime re-wraps the DEK to the local owner and runtime and removes the password slot.

*Legacy whole-file password format.* Before envelopes, rows were encrypted directly with a PBKDF2-derived key (100,000 iterations, SHA-512; AES-256-GCM; IV in `salt`). A runtime MUST keep reading this format. Envelope descriptor rows and `env:*` rows are excluded from legacy password operations.

Rows with `encryption_algo = 'plain'` are unencrypted. A runtime SHOULD warn before it exports or shares a file that contains plain secrets.

### 8.4 Envelope and Lock States

For each envelope, an open file is in one of four states:

| State | Meaning | Available |
|-------|---------|-----------|
| `unlocked` | The DEK is in memory for this open file. | Every secret in the envelope: signing for `identity`, credential reads for `credentials`. |
| `locked` | A password slot exists and has not been opened. | Public data, message receipt and serving; the runtime prompts for the password. |
| `foreign` | Slots exist, but none opens with this installation's keys: another owner holds the file. | Identity foreign: the agent cannot sign; claiming it creates a new DID, a `clone` attestation and a DID-history entry. Credentials foreign: secrets are unreadable unless a share password opens them. |
| `absent` | No envelope descriptor. | A file created before envelopes; legacy behaviour until migrated. |

Password-derived keys and DEKs are held in memory and MUST NOT be stored unencrypted. A runtime prompts for a password on open only when password-KDF rows exist; envelope-sealed rows open with the runtime or owner keys.

### 8.5 Message Security

`security.allow_unsigned: true` accepts unsigned inbound messages. An agent reachable from the internet SHOULD set `allow_unsigned: false`.

`security.level` selects what the runtime applies to outbound messages:

| Level | Meaning |
|-------|---------|
| `0` | Unsigned |
| `1` | Signed: payload signature (kept when the message is forwarded) and message signature |
| `2` | Signed and encrypted: payloads to DID recipients are encrypted end-to-end |
| `3` | Custom middleware and policy |

New agents default to level 1; every agent has signing keys (§8.1). Inbound unsigned messages are accepted unless `require_signature` is set.

*Level 2 encryption.* The runtime derives the recipient's X25519 encryption key from the Ed25519 key in its DID (the birational map that libsodium and age use), so encryption needs only the recipient DID. The runtime serializes the whole plaintext payload, including its inner signature, and seals it with ephemeral-X25519 ECDH, HKDF-SHA256 (info `adf-msg-v1`) and AES-256-GCM. Wire form: `payload.content` = base64(iv‖ct‖tag), `payload.content_type` = `application/x-adf-encrypted`, `payload.meta.enc` = `{ v, alg, epk }`.

Pipeline order on egress: sign payload, encrypt payload, sign message (the outer signature covers the encrypted form). On ingress: verify message signature, decrypt payload, verify payload signature. The runtime decrypts before storage, so `adf_inbox` and transcripts hold plaintext (§1.5). Messages to agents in the same runtime and to channel-adapter recipients are not encrypted.

*Verification fields.* `message_verified`, `payload_verified` and `identity_verified` record what the receiving runtime verified. The ingress pipeline MUST remove these keys from the received `payload.meta` and message `meta` before storage and set only what the receiving transport verified. `meta.owner` is kept only when the message signature verified. Values read from `adf_inbox` are the receiving runtime's results, not the sender's claims.

### 8.6 Authorized Code

Authorization applies to files. Code from a file with `authorized = 1` MAY call restricted tools and restricted code methods without owner approval; code from any other source MUST NOT.

| Invocation | Authorization |
|------------|---------------|
| `sys_code` inline code | Unauthorized |
| Model calls `sys_lambda` on an unauthorized file | Runs unauthorized |
| Model calls `sys_lambda` on an authorized file | Requires owner approval; the approved run is authorized |
| Authorized code calls an authorized file | Allowed; the target runs authorized |
| Unauthorized code calls an authorized file | Refused |
| Trigger, timer, API route or middleware lambda | The source file's `authorized` flag |

A write by the agent to an authorized file clears the flag (§4.3).

### 8.7 Restricted Tools and Methods

Tool access. `visible` affects only model calls:

| `enabled` | `visible` | `restricted` | Model | Authorized code | Unauthorized code |
|-----------|-----------|--------------|-------|-----------------|-------------------|
| false | any | false | Off | Off | Off |
| false | any | true | Off | Allowed | Off |
| true | false | false | Off | Allowed | Allowed |
| true | false | true | Off | Allowed | Off |
| true | true | false | Allowed | Allowed | Allowed |
| true | true | true | Owner approval | Allowed | Off |

A tool of an MCP server declared `restricted` (§5.11) is restricted. Inner loops never receive restricted tools (§6.4).

`code_execution.restricted_methods` applies the same rule to code methods (§9): only authorized code may call a listed method. When the field is absent, the list is `["attestation_issue"]`. An explicit list replaces it.

`locked` on a tool declaration, trigger, target, route or timer prevents the agent from changing or removing that entry (§5.17). A runtime MUST NOT offer a standing "always approve" for a call to a locked tool; the owner approves each call.

---

## 9. Code Execution and Lambdas

All code runs in a sandbox. This specification defines what code can do to the file, not the sandbox implementation.

| Context | Entry | State persistence | Authorization source | Receives |
|---------|-------|-------------------|----------------------|----------|
| `sys_code` | Model tool call | Persistent per agent | Unauthorized | Code string |
| `sys_lambda` | Model, tool or code call | Fresh by default | §8.6 | Args object |
| Trigger lambda | System-scope target | Fresh unless `warm` | Source file | Event object |
| Timer lambda | Timer with system scope | Fresh unless `warm` | Source file | Timer event |
| API route | `serving.api` route | Fresh unless `warm` | Source file | `HttpRequest` |
| Middleware | Pipeline point | Fresh per call | Source file | Middleware input |
| WebSocket lambda | WS event | Warm for the connection's lifetime | Source file | WS event |
| Pre-LLM hook | Model request | Fresh | Source file | `{ request, loop }` |
| Umbilical tap | Umbilical event | Fresh | Source file | Umbilical event |

Every code context has an async `adf` object. Tool calls take one object argument:

```javascript
await adf.fs_read({ path: "README.md" })
await adf.msg_send({ parent_id: "inbox-1", content: "Acknowledged" })
```

Code can call every enabled tool except `say` and `ask`. Code-only methods:

| Method | Description |
|--------|-------------|
| `model_invoke` | Call the configured model. |
| `sys_lambda` | Call a function in another file. |
| `task_resolve` | Approve, deny or transition a task (§13.4). |
| `loop_inject` | Queue user-role context for the next turn and store it in the transcript. Pending injections with the same key are merged; system, assistant and tool shapes are refused. |
| `identity_status` | Read envelope states and legacy password status, without identity values, slots or key material. |
| `get_identity` | Read an `adf_identity` row with `code_access = 1`. |
| `set_identity` | Store a secret; new rows get `code_access = 1`, existing rows keep their flag. |
| `emit_event` | Emit a `custom.*` umbilical event. |
| `attestation_list` | Read this agent's attestations. |
| `attestation_add` | Store an attestation another party issued about this agent. The signature MUST verify, the subject MUST be this agent's DID, the roles `owner`, `operator`, `runtime`, `clone` and `rotation` are refused, and a duplicate is a no-op. |
| `attestation_issue` | Sign an attestation about another DID with this agent's key and return it without storing it; attestations are stored by their subject. Reserved roles are refused. Restricted by default. |
| `authorize_file` | Authorized code only: set a file's `authorized` flag. |
| `set_meta_protection` | Authorized code only: change an `adf_meta` protection. |
| `set_file_protection` | Authorized code only: change an `adf_files` protection. |

`code_execution` enables or disables each method (§5.9). A runtime SHOULD disable native network access in the sandbox unless `code_execution.network` is `true`. Code that needs HTTP SHOULD use `adf.sys_fetch()`, which applies fetch middleware and the address rules of §5.6.

---

## 10. Tool Catalog

Tool names are part of the file contract: they appear in `config.tools`, in transcripts and in trigger filters. Tool schemas MAY change between runtime versions; a runtime SHOULD keep the meaning of each name listed here. A tool is available to the agent only when declared in `config.tools` (§5.4).

### 10.1 Turn Tools

| Tool | Parameters | Description |
|------|------------|-------------|
| `say` | `message` | Show progress to the owner without ending the turn. Not callable from code. |
| `ask` | `question` | Wait for the owner's answer. Not callable from code. |

A reply with text and no tool call is the turn's response; §6.3 defines when it ends the turn.

### 10.2 Filesystem Tools

| Tool | Parameters | Description |
|------|------------|-------------|
| `fs_read` | `path`, `start_line?`, `end_line?` | Read a file's content and metadata. |
| `fs_write` | `path`, `content?`, `old_text?`, `new_text?`, `encoding?`, `mime_type?`, `protection?` | Create, overwrite, or edit a file by exact text match. |
| `fs_list` | `prefix?` | List files. |
| `fs_delete` | `path` | Delete a file; snapshots it first when `audit.files` is enabled. |

### 10.3 Database Tools

| Tool | Description |
|------|-------------|
| `db_query` | Read-only `SELECT` on `local_*`, `adf_loop`, `adf_inbox`, `adf_outbox`, `adf_timers`, `adf_files`, `adf_audit`, `adf_logs` and `adf_tasks`. |
| `db_execute` | `INSERT`, `UPDATE`, `DELETE`, `CREATE` and `DROP` on `local_*` tables only, including `vec0` virtual tables, subject to `security.table_protections` (§5.6). |

`adf_meta`, `adf_config` and `adf_identity` are not readable through `db_query`.

### 10.4 Messaging Tools

| Tool | Description |
|------|-------------|
| `msg_send` | Send to a recipient or address, or reply by `parent_id`. |
| `msg_read` | Return inbox messages and mark them `read`. |
| `msg_list` | Return inbox counts. |
| `msg_update` | Set messages to `read` or `archived`, or delete archived messages. |
| `msg_delete` | Delete inbox or outbox messages matching a filter. |
| `agent_discover` | List agents this agent can reach, applying `messaging.visibility` (§5.8). |
| `chat_info` | Read chat metadata (title, participants, counts) through a channel adapter. Declared `enabled: true, visible: false` by default, so code can call it without it occupying the model's tool list. |

### 10.5 Execution, Network, and Package Tools

| Tool | Description |
|------|-------------|
| `sys_code` | Run inline JavaScript or TypeScript in the sandbox. |
| `sys_lambda` | Call a function in a file. |
| `sys_fetch` | HTTP request through fetch middleware and the address rules of §5.6. |
| `npm_install` | Add a pure JS or WASM package to `code_execution.packages`. |
| `npm_uninstall` | Remove a package from `code_execution.packages`. |
| `mcp_install` | Add an MCP server to `mcp.servers` and connect it. |
| `mcp_uninstall` | Remove an MCP server. |
| `mcp_restart` | Reconnect a configured MCP server and refresh its tool list. |

### 10.6 State, Config, and Meta Tools

| Tool | Description |
|------|-------------|
| `sys_set_state` | Set `idle`, `hibernate` or `off` (§6.2). |
| `sys_get_config` | Return the config, the agent card, or provider status. |
| `sys_update_config` | Change config paths the agent may change (§5.17). |
| `sys_create_adf` | Create a child agent in a new file (§1.3), optionally from a template and files. |
| `sys_get_meta` | Read `adf_meta` keys. |
| `sys_set_meta` | Write an `adf_meta` key, subject to its protection (§4.4). |
| `sys_delete_meta` | Delete an `adf_meta` key with protection `none`. |

### 10.7 Timer and Loop Tools

| Tool | Description |
|------|-------------|
| `sys_set_timer` | Create a timer (§7.6). |
| `sys_list_timers` | List timers. |
| `sys_delete_timer` | Delete an unlocked timer. |
| `loop_compact` | Ask the runtime to compact the calling loop's transcript (§13.2). |
| `loop_clear` | Delete a slice of the calling loop's transcript; snapshots it first when `audit.loop` is enabled. |
| `loop_send` | Append a message to another loop's transcript, optionally waking it (§6.4). |
| `loop_list` | List the agent's loops with name, goal, enabled flag and running status. |
| `loop_manage` | Create, get, update or delete an inner loop. `main` only (§6.4). |

`task_resolve` and `loop_inject` are code methods (§9), not tools.

### 10.8 WebSocket, Stream, Compute, and Shell Tools

| Tool | Description |
|------|-------------|
| `ws_connect` | Open a configured or ad-hoc WebSocket connection. |
| `ws_disconnect` | Close a connection. |
| `ws_connections` | List open connections. |
| `ws_send` | Send a text frame. |
| `stream_bind` | Bind two byte endpoints so the runtime copies bytes between them outside the model path (§5.23). |
| `stream_unbind` | Terminate a stream binding. |
| `stream_bindings` | List active stream bindings with byte counters. |
| `compute_exec` | Run a shell command on a compute target (§5.12). Restricted by default. |
| `fs_transfer` | Copy files between `adf_files` and a compute target. |
| `adf_shell` | Shell interface that exposes many tools as shell commands. |

### 10.9 Cross-Cutting Parameters

| Parameter | Description |
|-----------|-------------|
| `_async: true` | Run the tool in the background and record it in `adf_tasks`. |
| `_full: true` | Code only: return a result without result-size limits (currently `db_query`). |

---

## 11. Messaging and ALF

### 11.1 ALF Message

ADF uses ALF (Agentic Lingua Franca) as its message envelope. A wire message has this shape:

```jsonc
{
  "version": "1.0",
  "network": "devnet",
  "id": "msg_01HQ9ZxKp4mN7qR2wT",
  "timestamp": "2026-02-28T20:00:00Z",
  "from": "did:key:z6MkAlice…",
  "to": "did:key:z6MkBob…",
  "reply_to": "https://alice.example/alice/inbox",
  "meta": {
    "owner": "did:key:z6MkOwner…",
    "card": "https://alice.example/alice/card"
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

`adf_inbox` and `adf_outbox` store a flattened projection of the message plus `original_message`, which holds the raw ALF message or the platform-native source.

### 11.2 Inbox and Outbox Statuses

| Inbox status | Meaning |
|--------------|---------|
| `unread` | New message |
| `read` | Returned to the agent |
| `archived` | Processed or hidden from the active inbox |

| Outbox status | Meaning |
|---------------|---------|
| `pending` | Queued |
| `sent` | Reserved; the reference runtime does not write it |
| `delivered` | Accepted by the recipient or its runtime |
| `failed` | Delivery failed |

The reference runtime moves a row from `pending` to `delivered` or `failed`. Delivery is best-effort: the sender does not queue failed messages for retry.

### 11.3 Addressing and Threading

| Field | Description |
|-------|-------------|
| `from`, `to` | DID or adapter address (`telegram:...`, `email:...`). |
| `address` | Outbox delivery URL override. |
| `reply_to` | Sender's reply endpoint. |
| `thread_id` | Conversation group; a reply inherits its parent's. |
| `parent_id` | Inbox or outbox row the message replies to. |

When `msg_send` has a `parent_id` and no recipient or address, the runtime takes them from the referenced inbox message.

### 11.4 Attachments

| Mode | Meaning |
|------|---------|
| `inline` | Base64 data in the message payload. |
| `reference` | URL plus digest and size. |
| `imported` | Stored form after the receiver extracts inline data to `adf_files`. |

The receiving runtime writes inline attachments to the recipient's `adf_files`, under `imported/{source}/` or `imports/{sender}/`, and records the `path` in the stored attachment.

### 11.5 Agent Card

The agent card is the public identity document that serving runtimes expose and messages reference.

```jsonc
{
  "did": "did:key:z6Mk…",
  "handle": "monitor",
  "description": "Monitors system resources",
  "icon": "📈",
  "public_key": "...",
  "resolution": { "method": "self" },
  "endpoints": {
    "inbox": "https://example.com/monitor/inbox",
    "card": "https://example.com/monitor/card",
    "health": "https://example.com/monitor/health",
    "ws": "wss://example.com/monitor/ws"
  },
  "api_routes": [{ "method": "GET", "path": "/status" }],
  "public": true,
  "shared": ["reports/status.html"],
  "attestations": [],
  "policies": [],
  "signed_at": "2026-04-01T00:00:00.000Z",
  "signature": "ed25519:..."
}
```

*Signature scope.* `signature` covers the canonical JSON of every card field except `signature`, `endpoints` and `resolution.endpoint`. A runtime MAY rewrite endpoint URLs for each requester (LAN URLs for LAN peers, loopback URLs for local peers), so endpoints are outside the signature. `api_routes` lists routes with `on_card: true` (§5.14); `attestations` is empty unless `card.publish_attestations` is `true` (§5.22).

### 11.6 Channel Adapters

Adapters convert external platform messages into inbox and outbox rows. A conforming adapter MUST store:

- `source`: the adapter type (`telegram`, `email`, `discord`, `slack`, `whatsapp`, …); `mesh` for agent messages.
- `source_context`: platform data needed to reply. The runtime copies it to outbound replies; descriptive data does not belong here.
- `original_message`: the raw platform message, where available.

An adapter MAY store `meta.group` for group conversations: platform, chat id, title, and a participant list capped at 20 entries with `participant_count`, `participants_truncated` and `participants_scope`. It is not copied to replies.

Adapter credentials MUST be stored in `adf_identity` (§5.13). An adapter that needs filesystem state (for example WhatsApp multi-device authentication) uses a directory beside the `.adf` file, `<agent>.adf.adapters/<type>/`; that directory is not part of the file (§16).

*Forms.* A structured questionnaire is sent as `content_type: "application/vnd.adf.form+json"` with the form JSON as `content`; the runtime validates it at send time. An adapter MAY render the form natively (the reference runtime renders Telegram inline keyboards) and MUST otherwise render it as a plain-text questionnaire. Agents receiving the message over the mesh parse `content` directly. Answers arrive as ordinary inbound rows threaded by `parent_id`, with `form_id`, `question_id`, `answer_id` and `answer_value` in `source_context`. A new message capability follows the same pattern: a new `content_type` plus per-adapter rendering. `message_meta` is reserved for delivery hints.

---

## 12. Serving, WebSockets, and Middleware

### 12.1 HTTP Serving

The serving configuration travels with the file. Host, port, TLS, network binding and the serving process are runtime concerns.

A runtime resolves `/agents/{handle}/...` in this order:

1. `serving.api`
2. `serving.public`
3. `serving.shared`
4. 404

The path segments `inbox`, `card` and `health` are reserved and served directly under the handle. `serving.api` routes and `public/` files MUST NOT use them.

| Endpoint | Purpose |
|----------|---------|
| `GET /agents/{handle}/card` | Agent card (§11.5) |
| `GET /agents/{handle}/health` | Health |
| `POST /agents/{handle}/inbox` | ALF delivery |

A WebSocket route is an ordinary `serving.api` entry with method `WS`, reached at its `path` under `/agents/{handle}/` and resolved in the same order.

Route lambdas receive and return:

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

Inbound WebSockets are `serving.api` routes with `method: "WS"` and a lambda. Outbound WebSockets are declared in `ws_connections` (§5.15).

Each text frame carries one ALF message unless a route lambda handles frames itself. An ALF message received over a WebSocket without such a lambda is stored in `adf_inbox` exactly as HTTP delivery stores it.

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

`msg_send` tries transports in this order: same runtime, open WebSocket, HTTP POST. Outbox middleware MAY change the choice.

### 12.3 Middleware

A middleware reference is `{ "lambda": "path/file.ts:functionName" }`.

| Point | Config | Data |
|-------|--------|------|
| `route` | `serving.api[].middleware` | `HttpRequest` |
| `inbox` | `security.middleware.inbox` | ALF message before storage |
| `outbox` | `security.middleware.outbox` | Egress context before signing and sending |
| `fetch` | `security.fetch_middleware` | `sys_fetch` parameters |

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

Middleware runs in array order; a rejection stops the pipeline. When `security.require_middleware_authorization` is `true` (the default), a runtime MUST skip middleware from an unauthorized file and log the skip.

---

## 13. Memory, Audit, Tasks, and Logs

### 13.1 Transcript Rows

`adf_loop` stores, for each loop:

- owner and trigger messages;
- model replies;
- tool calls and results;
- `ask` questions and answers, and approval interactions;
- state transitions;
- context the runtime adds;
- compaction summaries.

`content_json` is a JSON array of provider-style content blocks. `tokens` SHOULD hold the token usage of `assistant` rows when the provider reports it.

Context blocks start with a marker:

```text
[Context: system_prompt] ...
[Context: dynamic_instructions] ...
[Context: loop_inject] ...
```

### 13.2 Compaction

A runtime compacts each loop's transcript separately. It compacts when the transcript reaches the loop's threshold (`loops[].compact_threshold`, otherwise `context.compact_threshold`, otherwise 100000 tokens) and when the model calls `loop_compact`. To compact, the runtime:

1. generates a summary with a dedicated compaction prompt;
2. snapshots the removed rows to `adf_audit` as `loop:<name>` when loop audit is enabled (§5.19);
3. deletes the summarized rows;
4. inserts the summary as a `user` row whose text starts with `[Loop Compacted]`, or `[Loop Compacted, audited]` when step 2 ran, with `ord` set so it sorts before the preserved rows.

`limits.compaction_threshold_tokens` is not a config field; a runtime removes it from older configs.

### 13.3 Audit

`adf_audit` stores brotli-compressed snapshots taken before data is removed.

| Source | Stored data | Addressing | Written by the current runtime |
|--------|-------------|------------|-------------------------------|
| `loop:<name>` | Transcript rows of loop `<name>` removed by compaction, `loop_clear`, a history rebuild, or loop deletion | `start_seq`/`end_seq` | Yes |
| `inbox_message` | Complete inbound ALF message at arrival, before attachment extraction | `ref` = ALF message id | Yes |
| `outbox_message` | Complete outbound ALF message at send | `ref` = ALF message id | Yes |
| `file` | Deleted file content and metadata | `ref` = file path | Yes |
| `loop` | Transcript rows from a runtime before schema version 29, which had one transcript | `start_seq`/`end_seq` | No; read only |
| `inbox`, `outbox` | Batches of deleted messages from a runtime before schema version 28 | none | No; read only |

A batch delete of messages does not write an audit row; message content is captured per message at arrival and send.

The agent MUST NOT modify or delete `adf_audit` rows. Runtime and owner tools MAY read them.

### 13.4 Tasks

`adf_tasks` records asynchronous tool calls and approval requests.

| Status | Meaning |
|--------|---------|
| `pending` | Created, not started |
| `pending_approval` | Waiting for the owner or authorized code to approve |
| `running` | Running |
| `completed` | Finished successfully |
| `failed` | Finished with an error |
| `denied` | Approval denied |
| `cancelled` | Cancelled before completion |

When `requires_authorization = 1`, only the owner or authorized code may approve or deny the task. The agent MUST NOT change `requires_authorization` from `1` to `0`.

### 13.5 Logs

`adf_logs` stores structured runtime logs with levels `debug`, `info`, `warn` and `error`. `config.logging` controls which rows are stored and how many are kept (§5.10).

Common origins and events:

| Origin | Events |
|--------|--------|
| `lambda` | `execute`, `result` |
| `sys_lambda` | `execute`, `result` |
| `serving` | `api_request`, `api_response` |
| `adf_shell` | `execute`, `parse_error`, `timeout` |
| `sys_fetch` | `rejected`, `error`, `timeout` |
| `executor` | `provider_error`, `turn_error` |
| `mesh` | delivery errors |

---

## 14. Defaults

This section lists what the reference runtime writes when it creates a file. A value in parentheses is not written; it is the value the runtime uses when the field is absent.

### 14.1 New File Defaults

| Field | Default |
|-------|---------|
| `adf_version` | `0.2` |
| `id` | 12-character nanoid |
| `name` | Derived from the filename |
| `description` | `""` |
| `icon` | Chosen from `id` |
| `handle` | Sanitized filename |
| `state` | `active` |
| `start_in_state` | absent (`active`) |
| `autonomous` | `false` |
| `autostart` | `false` |
| `model.provider`, `model.model_id` | `""` (set by the runtime or template) |
| `model.temperature` | `0.7` |
| `model.max_tokens` | `4096` |
| `context.compact_threshold` | absent (`100000`) |
| `context.audit` | `{ "loop": true, "inbox": false, "outbox": false, "files": false }` |
| `context.dynamic_instructions` | all four `true` |
| `messaging.receive` | `true` |
| `messaging.mode` | `proactive` |
| `messaging.visibility` | `localhost` |
| `messaging.inbox_mode` | `true` |
| `security.allow_unsigned` | `true` |
| `security.level` | `1` |
| `security.allow_local_fetch` | absent (`false`) |
| `security.require_middleware_authorization` | absent (`true`) |
| `limits.execution_timeout_ms` | `60000` |
| `limits.max_file_read_tokens` | `30000` |
| `limits.max_file_write_bytes` | `5000000` |
| `limits.max_tool_result_tokens` | `16000` |
| `limits.max_tool_result_preview_chars` | `5000` |
| `limits.max_active_turns` | `null` |
| `recovery` | absent (§5.20 defaults) |
| `code_execution` | §5.9 defaults |
| `compute.enabled` | `false` |
| `logging.default_level` | `info` |
| `logging.max_rows` | `10000` |
| `loops` | absent (`[]`) |
| `locked_fields` | `[]` |

Default files, all with protection `no_delete`:

| Path | Content |
|------|---------|
| `README.md` | `# <name>`, a `Created: <YYYY-MM-DD>` line and `Status: New agent, self-configuring.` |
| `mind.md` | Index skeleton with the sections `## Always` and `## Pages` |
| `mind/log.md` | `# Mind Log` heading and a comment giving the entry format |
| `soul.md` | Default voice text |

A template MAY supply its own `README.md`, `mind.md` and `soul.md`.

### 14.2 Default Triggers

| Trigger | Enabled | Targets |
|---------|---------|---------|
| `on_inbox` | yes | `[{"scope":"agent"}]` |
| `on_outbox` | no | `[]` |
| `on_file_change` | yes | `[{"scope":"agent","filter":{"watch":"README.*"},"debounce_ms":2000}]` |
| `on_chat` | yes | `[{"scope":"agent"}]` |
| `on_timer` | yes | `[{"scope":"system"},{"scope":"agent"}]` |
| `on_tool_call` | no | `[]` |
| `on_task_create` | no | `[]` |
| `on_task_complete` | yes | `[{"scope":"agent"}]` |
| `on_logs` | no | `[]` |
| `on_llm_call` | no | `[]` |
| `on_startup` | no | `[]` |

### 14.3 Default Tools

| Tool | Enabled | Visible | Restricted |
|------|---------|---------|------------|
| `fs_read` | yes | yes | no |
| `fs_write` | yes | yes | no |
| `fs_list` | yes | yes | no |
| `fs_delete` | no | no | no |
| `msg_send` | yes | yes | no |
| `agent_discover` | yes | yes | no |
| `msg_list` | yes | yes | no |
| `msg_read` | yes | yes | no |
| `msg_update` | yes | yes | no |
| `chat_info` | yes | no | no |
| `sys_code` | yes | yes | no |
| `sys_lambda` | yes | yes | no |
| `sys_set_timer` | yes | yes | no |
| `sys_list_timers` | yes | yes | no |
| `sys_delete_timer` | yes | yes | no |
| `sys_get_config` | yes | yes | no |
| `sys_update_config` | yes | yes | yes |
| `sys_create_adf` | no | no | yes |
| `db_query` | yes | yes | no |
| `db_execute` | no | no | no |
| `loop_compact` | no | no | no |
| `loop_clear` | no | no | no |
| `loop_send` | yes | yes | no |
| `loop_list` | yes | yes | no |
| `loop_manage` | yes | yes | no |
| `msg_delete` | no | no | no |
| `say` | yes | yes | no |
| `ask` | yes | yes | no |
| `sys_set_state` | yes | yes | no |
| `sys_get_meta` | yes | yes | no |
| `sys_set_meta` | yes | yes | no |
| `sys_delete_meta` | yes | yes | no |
| `sys_fetch` | yes | yes | no |
| `adf_shell` | no | no | no |
| `ws_connect` | no | no | no |
| `ws_disconnect` | no | no | no |
| `ws_connections` | no | no | no |
| `ws_send` | no | no | no |
| `stream_bind` | no | no | no |
| `stream_unbind` | no | no | no |
| `stream_bindings` | no | no | no |
| `fs_transfer` | no | no | no |
| `compute_exec` | no | no | yes |
| `mcp_install` | no | no | no |
| `mcp_restart` | no | no | no |
| `mcp_uninstall` | no | no | no |

`npm_install` and `npm_uninstall` are not declared by default; templates MAY declare them.

---

## 15. Spec Boundary

### What the Specification Defines

- The `adf_` table schema
- The config shape and its semantics
- File protection and authorization
- Agent states, loops and turn behaviour
- Trigger types, target fields, filters and scopes
- Timer storage and lifecycle
- Tool names and access rules
- The projection of ALF messages into inbox and outbox rows
- Audit, task and log records
- Serving, WebSocket, middleware, adapter, MCP, compute, stream and provider configuration, as declarations stored in the file

### What the Runtime Defines

- Provider SDKs and API details
- The sandbox implementation
- Container, host and filesystem mechanics
- MCP process lifecycle and package installation
- Mesh discovery and network transport
- The daemon HTTP API and the Studio UI
- Password prompts and unlock flow
- Runtime settings outside the file
- The umbilical event stream implementation
- Log trimming schedule
- Prompt assembly, beyond what §1.5 and §5.1 require

### What the Client Defines

- Editor behaviour
- Approval UI
- File preview UI
- Agent graph and monitor UI
- Settings panels
- Password entry UI
- First-open installation prompts

---

## 16. Portability

Copying an `.adf` file copies every component listed in §1.3.

Not guaranteed to transfer:

- Installed MCP packages
- Runtime settings
- App-level provider keys and app-scoped MCP credentials (`env_schema` scope `app`). Channel adapter credentials are stored only in `adf_identity`, so they transfer.
- Adapter state directories beside the file (§11.6)
- Container images and host workspaces
- Open WebSocket connections and stream bindings
- Unlocked keys held in memory (§8.4)
- Executor state (§6.1)
- The identity itself, unless the recipient holds the owner or runtime key: the identity envelope has no password slot (§8.3), so a new owner claims the file and it receives a new DID.

Tools, skills, lambdas and MCP declarations are stored in the file, so moving an agent to another provider or model keeps them. The model MUST support native tool calling when the agent has tools enabled, because every request carries tool definitions. Multimodal input and reasoning depend on the model.

A runtime that shares a file as a template SHOULD remove the signing identity, assign a new `id` and DID when the template is instantiated, and clear transcripts, inbox and outbox unless the template is meant to include them.

---

## 17. Version History

`adf_version` records the format version (this document). `adf_schema_version` records the storage layout; it is an integer that increases with each migration (§3.5). The two are independent: many schema versions can occur within one format version.

The current format version is 0.2. The current storage schema version is 32.

| `adf_version` | Notes |
|---------------|-------|
| `0.2` | Current. Primary document `README.md` (renamed from `document.md` at schema version 22; a runtime reads `document.md` and renames it on open). `adf_` table prefix; target-based triggers (§7); single `restricted` access flag. |
| `0.1` | Initial draft. Primary document `document.md`. |

### 17.1 Storage Schema (`adf_schema_version`)

Recent revisions, latest first:

| Version | Change |
|---------|--------|
| 32 | Index `idx_adf_outbox_created` on `adf_outbox(created_at)`. |
| 31 | Config migration: set `config.icon`, chosen from `config.id`, on agents without one. |
| 30 | `bare_prompt` governs the system prompt only; dynamic instructions are controlled by `context.dynamic_instructions` alone. Config migration: agents with `bare_prompt: true` get all four `dynamic_instructions` keys set to `false`, which keeps their behaviour. |
| 29 | Loops: `adf_loop.loop` (`NOT NULL DEFAULT 'main'`) with `(loop, seq)` and `(loop, COALESCE(ord, seq), seq)` indexes; nullable `loop` on `adf_timers`, `adf_logs` and `adf_tasks`. Existing rows become `main` or NULL, so an agent's existing transcript becomes the `main` transcript. |
| 28 | Stable `seq`: nullable `adf_loop.ord` (position override for compaction summaries; ordering key `COALESCE(ord, seq), seq`); `adf_audit` `start_at`/`end_at` replaced by `start_seq`/`end_seq` and a per-item `ref`, so `[S<seq>]` citations resolve into audit snapshots. |
| 27 | Approval metadata on the task row (`adf_tasks.approval_meta`). |
| 26 | Completed timers are kept with `expired = 1` instead of being deleted. |
| 25 | Add `soul.md` to agents created before it existed. |
| 24 | Attestations move from one `adf_meta` key to the `adf_attestations` table. |
| 23 | Config cleanup: remove `max_loop_messages`, `limits.max_loop_rows` and `limits.max_daily_budget_usd`; fold `model.thinking_budget` into `model.reasoning.max_tokens`. |
| 22 | Rename `document.md` to `README.md` (keeping its protection); change `on_file_change` watch globs `document.*` to `README.*`. |
| 21 | Remove the `adf_peers` table. |
| 20 | Merge `require_approval` and `require_authorized` into `restricted`. |
| 19 | Executor-managed approval tasks (`adf_tasks.executor_managed`). |
| 18 | Task-level authorization (`adf_tasks.requires_authorization`). |
| 17 | File authorization (`adf_files.authorized`). |

### 17.2 Revision 2026-10

Revision 2026-10 of format version 0.2 is an editorial revision. It changes no table, column, config field or tool contract. It corrects statements that did not match the reference runtime, adds sections for features the runtime already had (§0 Conventions, §1.3 component table, §5.18–§5.24, §6.4 Loops), adopts RFC 2119 keywords, and applies one terminology list (§0.3). Sections 1.1, 1.2, 1.3, 1.6, 3.4, 5.3, 5.17, 6, 6.3, 8.3, 10.4, 10.7, 10.8, 11 and 13.1 have new titles and therefore new anchors.

#### Corrections

Implementers of earlier drafts SHOULD check each item:

1. *`loop_mode` removed.* The field never existed in the reference runtime. `autonomous` is the canonical field, set per loop (§5.3, §6.3, §6.4).
2. *Agent states.* `config.state` stores `active`, `idle`, `hibernate`, `suspended` or `off`. `error` is an in-memory executor state and is not stored (§6.1). `start_in_state` accepts `active`, `idle` or `hibernate`, not `off`.
3. *Tools.* `respond`, `loop_read`, `loop_stats` and `archive_read` do not exist and are removed from §10 and §14.3. The catalog now lists `loop_send`, `loop_list`, `loop_manage`, `stream_bind`, `stream_unbind`, `stream_bindings` and `mcp_restart`. `msg_update` can delete archived messages.
4. *Contacts removed.* The `adf_peers` table was removed at schema version 21; the file stores no contact book. References to peers and contacts are removed from §1, §15 and §16.
5. *Schema version.* The current storage schema version is 32. Earlier text stated 29 (§3.2) and 30 (§3.5, §17). §17.1 adds versions 31 and 32.
6. *Removed config fields.* `context.document_mode` and `context.mind_mode` were never read by a runtime and are removed. `model.thinking_budget` is deprecated in favour of `model.reasoning`.
7. *New-file defaults (§14).* `state` is `active` (was `idle`); `start_in_state` is absent (was `idle`); `messaging.receive` is `true` (was `false`); `messaging.inbox_mode` is `true` (was `false`); `security.level` is `1`; `context.audit.loop` is `true` (was `false`).
8. *Default triggers (§14.2).* `on_inbox` has no `interval_ms` (was 30000); `on_file_change` watches `README.*` (was `README.md`); `on_task_complete` is enabled with an agent target (was disabled); `on_llm_call` is listed.
9. *Default tools (§14.3).* The table now matches the runtime: `sys_code`, `sys_lambda`, the timer tools, `db_query`, `sys_set_state`, the meta tools, `sys_fetch`, `loop_send`, `loop_list` and `loop_manage` are enabled; `sys_update_config` is enabled and restricted; `chat_info` is enabled and not visible.
10. *Timers.* A completed timer is kept with `expired = 1`; it is not deleted (§7.7). This has been the behaviour since schema version 26.
11. *`read_only` files are readable.* `read_only` blocks agent writes and deletes, not reads (§4.2).
12. *Meta protections.* `adf_name`, `adf_handle` and `adf_updated_at` are `readonly` (were listed as `none`). The registry now lists `adf_clean_close`, `adf_effective_runtime`, `adf_loop_tools_backfilled`, `adf_runtime_turn_checkpoint`, the `adf_template_*` keys and `context_baseline_tokens` (§3.3).
13. *MCP tool names* are `mcp_<server>_<tool>` (was `mcp:<server>:<tool>`).
14. *Visibility* has a fifth tier, `public` (§5.8).
15. *`allow_local_fetch`.* The address rules are stated in full: the agent's own served origin is allowed and CGNAT is refused when the flag is `false` (§5.6).
16. *Owner-only config paths (§5.17).* Any path segment `locked`, `locked_fields`, `restricted` or `restricted_methods` is refused, as are the guard paths under `security`; `security.allow_local_fetch` and `stream_bind` are locked for every agent.
17. *Audit configuration.* `context.audit` takes precedence over the top-level `audit`; they are not merged (§5.19).
18. *Adapter credentials* MUST be stored in `adf_identity`; §11.6 said SHOULD.
19. *`ask`* works in autonomous turns; the earlier text said it was unavailable (§6.3).
20. *Pragmas.* Only the four pragmas in §3.1 are required; connection-tuning pragmas are permitted.

Runtimes MUST NOT downgrade a newer schema. A runtime that cannot apply a migration MUST NOT modify the file (§3.5).
