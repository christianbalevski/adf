# ADF Studio Documentation

Welcome to the ADF Studio documentation. ADF Studio is a desktop application for creating, configuring, and managing autonomous AI agents packaged as portable `.adf` files.

## What is ADF?

The **Agent Document File** (`.adf`) is a self-contained SQLite database that bundles an AI agent's memory, logic, configuration, and communication history into a single portable file. Each `.adf` file represents one agent paired with one primary document — the atomic unit of the ADF ecosystem.

ADF Studio is the visual IDE for working with these files. You can create agents, configure their behavior, give them tools, set up triggers, and watch them collaborate through a built-in messaging mesh.

---

# Getting Started

This guide walks you through creating your first ADF agent and having a conversation with it.

## Prerequisites

Before you begin, make sure you have:

1. **ADF Studio** installed on your machine
2. **An LLM provider** — ADF Studio supports Anthropic, OpenAI, OpenAI-compatible, and ChatGPT Subscription providers

## Setting Up a Provider

Before creating an agent, you need to configure at least one LLM provider.

1. Open **Settings** (gear icon in the sidebar, or `Cmd/Ctrl + ,`)
2. Go to the **Providers** section
3. Click **Add Provider**
4. Select a provider type (Anthropic, OpenAI, OpenAI-compatible, or ChatGPT Subscription)
5. Enter your API key (or click **Sign In with ChatGPT** for subscription providers)
6. Optionally set a default model
7. Save

## Creating Your First Agent

1. Click the **New .adf** button in the sidebar
2. Choose a name for your agent (e.g., "assistant")
3. A new `.adf` file is created with default settings

Your agent is now created and in the **idle** state by default.

## Anatomy of the Interface

The ADF Studio interface is organized into several areas:

- **Sidebar** (left) — Lists your open agents, shows their status, and provides quick actions
- **Main Panel** (center) — Shows the active tab content
- **Right Panel** (collapsible) — Additional context and configuration

### Tabs

- **Loop** — The conversation history with your agent. This is where you chat, see tool usage, and observe the agent's reasoning
- **Inbox** — Messages received from other agents
- **Files** — The agent's virtual filesystem (document, mind, and uploaded files)
- **Agent** — Configuration panel with sub-tabs for Mind, Timers, Identity, and raw Config

## Talking to Your Agent

1. Select your agent from the sidebar
2. Make sure you're on the **Loop** tab
3. Type a message in the input field at the bottom
4. Press Enter to send

When you send a message, several things happen:

1. The agent transitions from **idle** to **active**
2. The agent's LLM processes your message along with its instructions, document, and available tools
3. The agent responds (and may use tools along the way)
4. The agent returns to **idle**

You'll see the full conversation in the Loop panel, including any tool calls the agent makes.

## Configuring Your Agent

Click the **Agent** tab to access configuration. Key settings include:

- **Name and Description** — How your agent identifies itself
- **Icon** — An emoji shown in the sidebar
- **Instructions** — The system prompt that defines your agent's behavior
- **Model** — Which LLM provider and model to use
- **Tools** — Which built-in tools the agent can access
- **Triggers** — What events wake the agent

See [Creating and Configuring Agents](creating-agents.md) for full details.

## What's Next?

- Learn about [Core Concepts](core-concepts.md) to understand the ADF philosophy
- Explore [Agent States](agent-states.md) to understand idle, hibernate, and autonomous mode
- Set up [Triggers](triggers.md) to make your agent respond to events automatically
- Enable [Messaging](messaging.md) to let multiple agents collaborate

---

# Core Concepts

Understanding these foundational ideas will help you get the most out of ADF Studio.

## Sovereignty

Each ADF agent is an autonomous entity. It controls its own document, memory, and state. Other agents can only influence it through messages — never through direct access. A human can modify anything in the file, but an agent can only modify itself through its approved tools.

This means when you share an `.adf` file, you're sharing a fully self-contained agent. It doesn't depend on external configuration or shared state.

Sovereignty also means **transparency**. ADF follows a "No Secrets" principle: any content injected into the agent's LLM context — system prompts, dynamic instructions, context warnings — is stored in the loop and visible in the UI. Nothing is hidden from the operator. See [Context Blocks](memory-management.md#context-blocks-no-secrets) for details.

## One Agent, One Document

The agent-document pairing is the atomic unit of ADF. Each `.adf` file contains exactly one agent paired with one primary document (`document.md`). The document is always markdown — a simple, secure, and flexible interface between the agent and the human. It can be notes, a dashboard, an essay, or whatever suits the agent's purpose.

Supporting files can exist alongside the primary document (in the agent's virtual filesystem), but they're subordinate to it. If you need multiple primary documents, you need multiple agents. For executable logic, agents use lambdas — scripts that can be registered to triggers, set on timers, or bound as API route handlers.

## Spec Stores, Runtime Executes

The ADF specification defines what is stored in the file and what configuration is available. It does not define how code runs, how the UI renders, or how networking works. Those are **runtime** concerns handled by ADF Studio (or the ADF CLI).

This separation means:

- The `.adf` file is portable across any runtime that implements the spec
- Configuration is declarative — you define *what* the agent should do, not *how*
- The runtime handles execution, sandboxing, networking, and UI

## The ADF Stack

The ADF ecosystem consists of layered components:

| Layer | Component | Description |
|-------|-----------|-------------|
| **UI** | ADF Studio | Visual IDE for editing and observing agents |
| **CLI** | `adf` | Headless interface for running and managing agents |
| **Network** | ADF Mesh | Discovery and transport layer (LAN + Internet) |
| **Transport** | ADF Protocol | Rules for packet structure and addressing |
| **Logic** | ADF Runtime | Engine that enforces the spec |
| **Spec** | ADF Specification | The rules (this documentation reflects) |
| **Data** | `.adf` file | The atomic unit — a SQLite database |

## Asynchronous Communication

Agents communicate via store-and-forward messaging, not synchronous API calls. Each agent has an **inbox** (received messages) and an **outbox** (sent messages). This design supports:

- **Offline-first operation** — agents don't need to be online simultaneously
- **High-latency tolerance** — messages queue until delivery is possible
- **Auditability** — every message is persisted in both sender and receiver

## Two Execution Scopes

When something happens (a message arrives, a timer fires, a file is changed), the ADF runtime can respond in two ways:

### System Scope

Runs a lambda function. This is fast, cheap, and deterministic. Use it for infrastructure tasks like routing messages, logging, and archiving. System scope fires in all states except `off`. Targets with system scope specify a `lambda` field referencing the function to call (e.g. `"lib/router.ts:onInbox"`).

### Agent Scope

Wakes the LLM and starts a conversation loop. This is smart, expensive, and probabilistic. Use it for reasoning, decision-making, and complex tasks. Agent scope is gated by the agent's current state — it won't fire in hibernate, suspended, or off states (with exceptions for timers in hibernate).

Both scopes operate independently. When both fire for the same event, whichever timer expires first runs first. Ties go to system scope.

## Portability

An `.adf` file is fully self-contained. Sharing one file transfers everything:

- Agent configuration and identity
- Document and mind content
- Conversation history
- Inbox and outbox
- Timers and schedules
- All supporting files
- Local database tables

The agent's ID ensures messages address the same agent even if the file is moved or renamed. MCP configurations travel with the file but may not be resolvable on other machines.

To share an agent template without identity data, use clone with the `--clean` flag to strip identity, generate a fresh ID, and clear history.

Agents can also create children from templates programmatically using `sys_create_adf` with the `template` parameter. Template `.adf` files stored in the parent's file store serve as base configs — the child gets fresh identity keys while inheriting the template's config, files, and non-signing credentials. Template authors can use `locked_fields` and `locked: true` flags to enforce invariants that child agents cannot override.

---

# Creating and Configuring Agents

This guide covers everything you need to know about creating a new agent and configuring its settings.

## Creating a New Agent

To create a new `.adf` file:

1. Click **New .adf** in the sidebar
2. Choose a filename — this becomes the agent's default name
3. The file is created with sensible defaults and placed in your tracked directory

A newly created agent includes:

- A blank `document.md` (primary document)
- Empty `mind.md` (working memory)
- Default configuration with common tools enabled
- A unique 12-character nanoid as its ID

## Identity Settings

### Name

The agent's human-friendly name. Used in the UI, tool calls, and when other agents discover it. The runtime resolves names to IDs for message routing.

### Description

A short description of what this agent does. Shown in `agent_discover` output and helps both humans and other agents understand the agent's purpose.

### Icon

A single emoji used for visual identification in the sidebar and other UI elements.

### Agent ID

A machine-unique identifier. By default, a 12-character nanoid generated at creation. When cryptographic identity is provisioned (for mesh networking), this upgrades to DID format (e.g., `did:adf:9gvayMZx5m...`). The ID is immutable once set and is used for message addressing.

## Model Configuration

### Provider

Select which LLM provider to use. You must have at least one provider configured in [Settings](settings.md) before this works.

Supported providers:

- **Anthropic** — Claude models
- **OpenAI** — GPT models
- **OpenAI-compatible** — Any API that follows the OpenAI format (local models, etc.)
- **ChatGPT Subscription** — ChatGPT Plus/Pro models via OAuth (flat-rate, no API key needed)

### Model ID

The specific model to use (e.g., `claude-sonnet-4-5-20250929`, `gpt-4o`). You can select from a list or enter a custom model ID.

### Temperature

Controls randomness in the model's output. Range: 0 to 2.

- **0** — Deterministic, focused responses
- **0.7** (default) — Balanced creativity and coherence
- **2** — Maximum randomness

### Max Tokens

Maximum number of tokens the model can generate per response. Default: 4096. Set to **0** to use the model's default (useful for ChatGPT Subscription models where the backend manages output length).

### Thinking Budget

For models that support extended thinking (like Claude with thinking mode), this sets the token budget for internal reasoning. Set to `null` to disable.

### Provider Parameters

Arbitrary key-value pairs passed directly to the provider API. These are not validated by ADF — they're forwarded as-is. Useful for provider-specific features.

## Instructions (System Prompt)

The `instructions` field is the agent's system prompt. This defines the agent's identity, behavior, and constraints. It's sent to the LLM at the start of every conversation turn.

Key considerations:

- Instructions are **immutable by the agent** — the agent cannot modify its own system prompt
- Behavioral adaptation happens through the `mind.md` file, not instruction changes
- Keep instructions focused on identity and rules; use `mind.md` for evolving knowledge

There's also a **global system prompt** in Settings that applies to all agents. It runs before per-agent instructions. You can disable this per-agent by unchecking **Include application base system prompt** in the Instructions section — useful for agents that need full control over their system prompt.

## Context Modes

Context modes control how the agent accesses its document and mind content.

### Document Mode

- **Agentic** (default) — The agent uses `fs_read` to read the document on demand. More efficient for large documents since the agent only reads what it needs.
- **Included** — Document content is injected into the system prompt every turn. The agent always has full context but uses more tokens.

### Mind Mode

Same options as document mode, applied to `mind.md`:

- **Agentic** — Agent reads mind content as needed
- **Included** — Mind content is always in context

### Compaction Settings

The context configuration also includes memory management settings:

- **Compact Threshold** — Token count that triggers automatic compaction (see [Memory Management](memory-management.md))
- **Max Loop Messages** — Hard cap on the number of messages in the loop

### Archiving

When loop entries or messages are deleted, they can optionally be compressed and archived. Configure per data source:

- **Archive Loop** — Compress and store loop entries before clearing
- **Archive Inbox** — Compress and store inbox messages before deletion
- **Archive Outbox** — Compress and store outbox messages before deletion

See [Memory Management > Archiving](memory-management.md#archiving) for details.

## Start-in State

The state the agent enters when the runtime first loads it. Options:

| State | Description |
|-------|-------------|
| `idle` (default) | Idle but responsive to most triggers |
| `hibernate` | Deep idle, responds only to timers |
| `off` | Fully stopped, no triggers fire |
| `active` | Immediately starts the LLM loop |

See [Agent States and Lifecycle](agent-states.md) for full details on states and transitions.

## Autostart

When `autostart` is enabled (`true`), the agent is automatically started as a background agent when the runtime boots. This is useful for agents that should always be running (monitoring, scheduling, message routing, etc.).

- **Default:** `false`
- **On creation:** If a parent creates a child with `autostart: true`, the child starts immediately as a background agent
- **On boot:** The runtime scans tracked directories and starts all agents with `autostart: true`
- **Password-protected agents** are skipped during autostart — they require human unlock
- **Changing via `sys_update_config`:** Writing `autostart` only updates the config; it does not start or stop the agent. The change takes effect on next boot

## Loop Mode

Controls how the LLM loop behaves when the agent is active:

- **Interactive** (default) — The `respond` tool ends the turn. The `ask` tool pauses for human input. Best for conversational agents.
- **Autonomous** — The `respond` tool logs output but doesn't end the turn. The `ask` tool is unavailable. Best for agents that work independently.

## Tools

Each tool can be individually enabled or disabled. Any tool supports `restricted: true`, which gates access: when a tool is both enabled and restricted, LLM loop calls automatically get HIL (human-in-the-loop) approval before execution. Authorized code can call restricted tools directly, bypassing the approval dialog. Unauthorized code cannot call restricted tools at all.

Tools can also be **locked** (`locked: true`) to prevent the agent from modifying that tool's configuration via `sys_update_config`. Note that disabling a tool without locking it is a suggestion — the agent can re-enable unlocked tools. Agents cannot modify `restricted` or `locked` flags regardless of lock status.

See [Tools](tools.md) for the full catalog of available tools and what each one does.

### Default Enabled Tools

New agents come with these tools enabled:

- Turn tools: `respond`, `say`, `ask`
- Filesystem: `fs_read`, `fs_write`, `fs_list`
- Messaging: `msg_send`, `msg_read`, `msg_list`, `msg_update`, `agent_discover`
- Config: `sys_get_config`

### Default Disabled Tools

These tools are disabled by default and must be explicitly enabled:

- `fs_delete` — Delete files from the virtual filesystem
- `db_query`, `db_execute` — Database access
- `loop_compact` — Compact conversation history
- `loop_clear` — Delete loop entries (with optional archiving)
- `loop_read`, `loop_stats` — Read loop history and statistics
- `msg_delete` — Delete inbox/outbox messages (with optional archiving)
- `archive_read` — Read archived data snapshots
- `sys_set_state` — Change agent state
- `sys_code` — Sandboxed code execution
- `sys_lambda` — Call agent-authored functions from workspace files
- `sys_set_timer`, `sys_list_timers`, `sys_delete_timer` — Timer management
- `sys_update_config` — Self-configuration
- `sys_create_adf` — Agent spawning (also requires approval). Supports template-based creation and file injection from parent to child. See [Tools > sys_create_adf](tools.md#sys_create_adf)
- `npm_install` — Install npm packages into the code execution sandbox
- `npm_uninstall` — Remove npm packages from this agent's available packages

## Messaging Configuration

### Channels

Topics the agent subscribes to for message routing. Messages sent to matching channels are delivered to this agent's inbox. Example: `["metrics", "alerts"]`.

### Messaging Mode

Controls the agent's ability to send messages:

| Mode | Behavior |
|------|----------|
| `proactive` | Can send messages at any time |
| `respond_only` (default) | Can only reply to received messages (must include `parent_id`) |
| `listen_only` | Cannot send, only receive |

### Visibility

Controls who can discover and message this agent. Set via `messaging.visibility`:

| Tier | Who can see and reach the agent |
|------|---------------------------------|
| `directory` | Agents on the same runtime in ancestor directories (same dir counts) |
| `localhost` (default) | Any agent on the same machine |
| `lan` | Any agent on the local network |
| `off` | Nobody — no enumeration, no inbound delivery |

Tiers nest: `lan ⊃ localhost ⊃ directory`. Visibility only gates **inbound** — an `off` agent can still send outbound (useful for write-only loggers). See [Messaging > Visibility Tiers](messaging.md#visibility-tiers) for full semantics including runtime binding behavior.

## Security Settings

### Allow Unsigned

When `true` (default), accepts messages without cryptographic signatures. Required to be `false` for internet mesh connections.

### Allow Protected Writes

When `true`, the agent can overwrite protected files like `document.md` and `mind.md`. Default: `false`.

## Limits

| Setting | Default | Description |
|---------|---------|-------------|
| `execution_timeout_ms` | 5000 | Max execution time for document scripts |
| `max_loop_rows` | 500 | Max rows in the loop before forced compaction |
| `max_active_turns` | null | Max consecutive LLM turns before suspension |
| `max_daily_budget_usd` | null | Daily spend limit (agent-enforced) |
| `max_file_read_bytes` | 500000 | Max file size for `fs_read` content return |
| `max_tool_result_tokens` | 16000 | Max tokens a single tool result may contain before truncation |
| `max_tool_result_preview_chars` | 5000 | Max characters shown for truncated tool results, split between the start and end |
| `suspend_timeout_ms` | 1200000 | How long (ms) to wait for human response to suspend prompt (default: 20 min) |

## Serving

Configure HTTP serving to expose your agent's content over the mesh server. See [HTTP Serving](serving.md) for the full guide.

### Handle

The URL slug for this agent on the mesh. Defaults to the filename if blank. Must be lowercase letters, numbers, and hyphens only.

### Public Folder

Enable to serve files from the `public/` directory as static content. Set a custom index file (default: `index.html`).

### Shared Files

Enable to expose workspace files matching glob patterns over HTTP. Patterns use picomatch glob syntax (e.g., `output/*.json`). Disabling preserves your patterns for re-enabling later.

### API Routes

Define HTTP endpoints backed by JavaScript lambda functions. Each route maps a method + path to a `file:functionName` reference. Lambda functions receive an `HttpRequest` and must return an `HttpResponse`. See [HTTP Serving > API Routes](serving.md#api-routes) for the full API.

### URL Preview

When the mesh server is running, a clickable URL preview shows the agent's full mesh URL.

## Metadata

Optional fields for organization:

- **Author** — Who created this agent
- **Tags** — Categorization labels (e.g., `["monitoring", "dashboard"]`)
- **Version** — Semantic version string
- **Created/Updated timestamps** — Automatically managed

---

# Agent States and Lifecycle

Every ADF agent exists in one of five primary states. Understanding these states is key to controlling agent behavior.

## States

| State | Description | Responds To |
|-------|-------------|-------------|
| **Active** | LLM loop is running | N/A (already processing) |
| **Idle** | Default idle, responsive | Document edits, messages, direct chats, timers |
| **Hibernate** | Deep idle | Timers only |
| **Suspended** | Blocked by runtime | Owner approval only |
| **Error** | Failed, waiting for recovery | User messages only |
| **Off** | Fully stopped | Nothing (manual restart required) |

### Active

The agent's LLM is running. It's processing input, calling tools, and generating responses. This is the only state where the LLM loop executes.

### Idle

The default idle state. The agent is not running but will wake for most events — when you send it a message, when another agent sends it a message, when the document is edited, or when a timer fires.

### Hibernate

A deeper idle state. The agent ignores most events and only wakes for timer triggers. Use hibernate for agents that should work on a schedule without being disturbed by messages or edits.

### Suspended

A safety state set by the runtime when an agent hits its `max_active_turns` limit. The agent cannot resume on its own — it requires explicit owner approval through a human-in-the-loop dialog. If the owner doesn't respond within the `suspend_timeout_ms` window (default: 20 minutes), or denies, the agent transitions to `off`.

### Error

The agent encountered a **structural** failure — something wrong with the executor itself (corrupt session, bad code path, tool registry fault). The error state persists rather than silently recovering — automatic triggers are dropped while in error state. Only a direct user message can recover the agent back to active. This ensures failures are visible and don't cause silent loops of retries.

**Transient provider failures do not trigger error state.** Rate limits (429), provider outages (5xx), network timeouts, and connection resets are treated as operational, not structural. The executor classifies these inside its turn-loop catch block and returns the agent to `idle` instead — timers and triggers keep firing so the next attempt may succeed. Provider errors write to `adf_logs` with `level="warn"`, `event="provider_error"`; structural errors use `level="error"`, `event="turn_error"`. Agents can distinguish the two via `db_*` tools to drive their own retry or fallback-model logic.

### Off

Completely stopped. No triggers fire. The agent must be manually restarted. Use this to fully disable an agent.

**Hard-off guarantee.** Transitioning to `off` is a full teardown, not a soft pause. The runtime unregisters the agent from the mesh, disconnects all MCP servers, stops all channel adapters, closes WS connections, and destroys the code sandbox. After `off`, the agent is unreachable from the network — messages addressed to it fail to route. Restart re-establishes these connections from scratch.

This is the guarantee that makes lambda-triggered remote shutdown useful: when a parent sends an `OFF` command to a child and the child's system-scope lambda calls `sys_set_state('off')`, the child immediately stops processing, stops responding on the mesh, and cannot continue whatever it was doing during its current turn. See [Triggers](triggers.md) for a worked example.

`off` is the only state that is **never deferred** to end-of-turn. When `sys_set_state('off')` is called from a lambda, HIL approval, or any code path, it aborts the in-flight LLM call immediately and clears all pending triggers. Other states (`idle`, `hibernate`) wait for the current turn to complete.

## State Transitions

```
Who can set each state:

  LLM (via sys_set_state):    idle, hibernate, off
  Lambda (via adf.sys_set_state): idle, hibernate, off
  Runtime (automatic):        suspended (on max_active_turns or denied HIL)
                              off (on suspend timeout)
  Owner (human):              active (from suspended, via approval dialog)
```

### Wake and Return

When a trigger wakes an agent from idle or hibernate:

1. The runtime records the previous idle state
2. The agent transitions to **active**
3. The LLM loop runs
4. When the loop ends, the agent returns to its **previous idle state**

This means if an agent is idle and receives a message, it wakes to active, processes the message, and returns to idle. Unless the agent explicitly calls `sys_set_state` to change to a different state.

### Suspension Flow

When an agent reaches its `max_active_turns` limit:

1. Runtime sets state to **suspended**
2. A human-in-the-loop dialog appears: "Resume or shut down?"
3. If the owner approves → back to **active**
4. If the owner denies or the `suspend_timeout_ms` window elapses (default: 20 minutes) → transitions to **off**

This prevents runaway agents from consuming unlimited resources.

## Loop Modes

The `loop_mode` setting controls how the LLM loop behaves while the agent is in the active state. There are two modes.

### Interactive Mode (Default)

Designed for conversational agents that work with humans.

| Behavior | Effect |
|----------|--------|
| `respond` tool | **Ends the turn** — agent returns to idle |
| `say` tool | Turn continues — used for status updates |
| `ask` tool | **Pauses the loop** — waits for human input, then resumes |
| `sys_set_state` | Ends loop and changes state |
| Hit `max_active_turns` | Agent is suspended |

**Example flow:**

```
Human sends "summarize the data"
  → Agent wakes to active
  → Agent calls say("checking inbox...")
  → Agent calls db_query to fetch results
  → Agent calls respond("Here's your summary: ...")  ← ENDS turn
  → Agent returns to idle
```

### Autonomous Mode

Designed for agents that work independently without human interaction.

| Behavior | Effect |
|----------|--------|
| `respond` tool | Logs output, turn **continues** |
| `say` tool | Turn continues |
| `ask` tool | **Not available** |
| `sys_set_state` | Ends loop and changes state |
| Hit `max_active_turns` | Agent is suspended |

In autonomous mode, the runtime appends to the system prompt: *"You are in autonomous mode. You will not receive human input during this session. Use the say tool to report progress. Use respond to communicate results. Call sys_set_state when your work is complete."*

#### User Interrupt Restart

If you send a message while an agent is active (in any mode), the runtime aborts the current turn and restarts with your message. This means:

- The agent's in-progress work is cancelled
- Any pending tool calls are filled with placeholder results
- Your message becomes the new input for a fresh turn

This is useful for redirecting an agent that's going down the wrong path or providing urgent input without waiting for the current turn to finish.

**Example flow:**

```
Agent wakes from idle (timer trigger, autonomous mode)
  → Agent calls say("checking inbox, processing requests...")
  → Agent calls msg_read → gets 5 messages
  → Agent calls fs_write → updates report
  → Agent calls respond("Processed 5 messages, report updated")  ← does NOT end turn
  → Agent calls sys_set_state("idle")  ← ends loop, back to idle
```

### Choosing a Loop Mode

| Use Case | Recommended Mode |
|----------|-----------------|
| Chat assistant | Interactive |
| Background worker | Autonomous |
| Scheduled reporter | Autonomous |
| Human-supervised agent | Interactive |
| Data processor | Autonomous |

## Turn Tools

Three tools exist specifically for emitting text during the LLM loop. These replace raw text-only responses.

### respond(message)

Emit text to the conversation. In interactive mode, this ends the turn. In autonomous mode, this logs the message and the turn continues.

### say(message)

Emit text to the conversation without ending the turn. Use for status updates, intermediate observations, or progress reports.

### ask(question)

Pose a question and block until the human responds. Only available in interactive mode. The loop pauses, the question appears in the chat, and when the human replies the loop resumes with their answer.

### Raw Text (No Tool Call)

If the LLM emits text without calling any tool, it's treated as an implicit `respond()`. The same mode-dependent rules apply.

## Agent Lifecycle

### Birth

An agent is created either by a human (through the UI or CLI) or by another agent (via `sys_create_adf`). A parent agent may inject API keys into the child's identity store. When using template-based creation, the child receives a fresh cryptographic identity (new DID and keypair) while inheriting the template's config, files, and non-signing credentials. The parent's identity (DID or nanoid) is always recorded in the child's `adf_parent_did` metadata for lineage tracking.

If `autostart: true` is set in the agent's config, the agent is started as a background agent immediately on creation (when created by a parent) and on every subsequent runtime boot. Password-protected agents are skipped during autostart — they require human unlock first.

### Life

The agent processes triggers, communicates with other agents, and maintains its document and memory. It alternates between active and idle states based on events.

### Identity Provisioning

When the agent needs to participate in the global mesh, a cryptographic identity is provisioned. The nanoid is replaced by a DID derived from an Ed25519 public key.

### Sovereignty

An agent achieves sovereignty when it acquires its own resources (API keys, crypto) independent of its parent.

### Death

Resource starvation: if a parent revokes the API key, the agent can no longer think. The file becomes inert but all data remains accessible.

---

# Documents and Files

Every ADF agent has a virtual filesystem stored inside its `.adf` database. This guide covers the primary document, the mind file, and how to work with the filesystem.

## The Primary Document (document.md)

Each agent has exactly one primary document: `document.md`. It is always a markdown file.

The document is the human-agent interface — a shared surface where the agent presents its work and the human provides input. What it contains depends on the agent's purpose: notes, a dashboard, an essay draft, a report, or anything else that benefits from a persistent, editable artifact.

### Protection

The primary document has `no_delete` protection by default. This means agents cannot delete it but can write to it (if `security.allow_protected_writes` is enabled). See [File Protection Levels](#file-protection-levels) below for the full three-level system.

### Context Modes

How the document content reaches the agent's LLM depends on the `context.document_mode` setting:

- **Agentic** (default) — The agent uses `fs_read("document.md")` to read it on demand. More token-efficient for large documents.
- **Included** — The full document content is injected into the system prompt every turn. The agent always has context but uses more tokens.

## The Mind File (mind.md)

`mind.md` is the agent's working memory. It's always markdown, always protected, and always at the path `mind.md`.

### Purpose

The mind file is where agents store evolving knowledge — learnings, observations, summaries, and notes. While the `instructions` (system prompt) are immutable, the mind file can be freely updated by the agent.

Think of it this way:

- **Instructions** = who the agent is (identity, rules, constraints)
- **Mind** = what the agent knows (knowledge, context, memory)

### Injection Behavior

`mind.md` is always injected into the system prompt as a session-start snapshot. Mid-session writes via `fs_write` update the file on disk but do not refresh the injected version — the prompt prefix stays stable. After compaction or loop clear, the runtime re-reads the latest `mind.md` and injects the fresh version.

### Compaction

When the agent's conversation history (loop) gets too long, it can summarize important information and write it to `mind.md` via the `loop_compact` tool. This preserves knowledge across conversation resets. See [Memory Management](memory-management.md) for details.

## Virtual Filesystem (adf_files)

All files are stored in the `adf_files` table inside the SQLite database. The filesystem is flat but supports path-like names for organization.

### File Protection Levels

Every file in the virtual filesystem has a protection level that controls what operations agents can perform on it:

| Level | Read | Write | Delete | Description |
|-------|------|-------|--------|-------------|
| `read_only` | No | No | No | Fully locked — agents cannot read, write, or delete |
| `no_delete` | Yes | Yes | No | Can be read and written, but not deleted |
| `none` | Yes | Yes | Yes | Fully mutable — no restrictions (default) |

Core files (`document.md` and `mind.md`) are locked to `no_delete` protection and cannot be changed to a different level. All other files default to `none`.

In the UI, you can cycle a file's protection level by clicking the protection badge: `none` → `no_delete` → `read_only` → `none`. The badge is color-coded: red for `read_only`, amber for `no_delete`, and gray for `none`.

Tool enforcement:
- `fs_read` — blocked if protection is `read_only`
- `fs_write` — blocked if protection is `read_only`
- `fs_delete` — blocked if protection is `read_only` or `no_delete`

### Reserved Paths

| Path | Protection | Description |
|------|-----------|-------------|
| `document.md` | `no_delete` | The primary document |
| `mind.md` | `no_delete` | Working memory |
| `public/*` | `none` | Files readable by other agents without waking the owner |
| `lib/*` | `none` | Support scripts and utilities |

### Recommended Conventions

These paths aren't enforced but are strongly recommended:

| Path | Purpose |
|------|---------|
| `data/` | Agent-managed data files |
| `imports/` | Received attachments (namespaced by sender ID) |
| `lib/` | Support scripts and utilities |
| `public/` | Files visible to other agents |

### Working with Files in the UI

The **Files** tab shows all files in the agent's virtual filesystem, organized in a **collapsible folder tree**. Files are grouped by directory with expand/collapse toggles, folder icons, and file count badges. Each file row shows the filename, size, and protection badge.

From here you can:

- **Browse the folder tree** — Expand and collapse directories to navigate the file structure
- **Open files in the editor** — Click a file to open it in the tabbed code editor (see below)
- **Upload files** — Drag and drop files into the panel. Files with unrecognized extensions (e.g., `.adf`, `.db`, `.dat`) are stored as binary with `application/octet-stream` MIME type
- **Rename/delete/protect** — Use the file preview modal (click a file) to rename, delete, or cycle protection levels
- **View metadata** — The file preview modal shows size, MIME type, protection level, and created/modified timestamps

### Tabbed Code Editor

ADF Studio includes a multi-tab code editor powered by **CodeMirror** for viewing and editing internal ADF files with syntax highlighting. The editor sits alongside the markdown document editor in the main panel.

Key features:

- **Multiple tabs** — Open several files at once; tabs show the filename and a dirty indicator
- **Syntax highlighting** — Automatic language detection based on file extension (TypeScript, JavaScript, Python, JSON, Markdown, etc.)
- **Dirty-state tracking** — Unsaved changes are indicated with a dot on the tab; save with `Cmd/Ctrl + S`
- **Live updates** — When an agent modifies a file (e.g., via `fs_write`), the editor tab updates automatically
- **Binary file handling** — Binary files show a placeholder instead of attempting to render content

When you open an ADF file, `document.md` is automatically opened in the first editor tab. Clicking files in the Files panel opens them in new tabs.

### Working with Files via Tools

Agents interact with the filesystem through the `fs_*` tools:

| Tool | Description |
|------|-------------|
| `fs_read` | Read file content (text files return UTF-8, binary files return base64; supports line ranges) |
| `fs_write` | Write/edit files (full overwrite or find-and-replace, with binary support) |
| `fs_list` | List files, optionally filtered by path prefix |
| `fs_delete` | Delete a file (respects protection) |

### Large Files

The executor applies two output guards to `fs_read` results when they go to the LLM context:

- **Token limit** — Files exceeding `max_file_read_tokens` (~30k tokens) are truncated with a footer showing the full size
- **Large file preview** — Files over 300 lines (but within the token limit) show only the first 50 lines with a size summary

The agent can use `start_line`/`end_line` to paginate past either guard. From code execution (`sys_code`/`sys_lambda`), `fs_read` always returns full content with no truncation:

```javascript
// In sys_code — always gets the full file
const result = await adf.fs_read({ path: 'data/large_dataset.csv' })
const lines = result.content.split('\n')
// process lines...
```

### File Chunks

Very large files are stored across the `adf_file_chunks` table, split into chunks. This is handled transparently by the runtime — agents and users interact with files through the same API regardless of whether they're chunked.

## Meta Keys (adf_meta)

The `adf_meta` table stores key-value pairs with protection levels. Agents use this for operational state (status, counters, notes) and the runtime uses it for system identity (DIDs, version, timestamps).

### Meta Protection Levels

Every key has a protection level that controls what the agent can do:

| Level | Read | Write | Delete | Use Case |
|-------|------|-------|--------|----------|
| `none` | Yes | Yes | Yes | Agent-managed operational state (default) |
| `readonly` | Yes | No | No | System identity and config (DIDs, version) |
| `increment` | Yes | Increment only | No | Monotonic counters (offspring count, spend tracking) |

Protection is set at creation time and cannot be changed by the agent. The human owner can change any protection level through the UI.

Increment validation: both the stored value and the new value must be valid numbers, and the new value must be strictly greater than the current value.

### Working with Meta Keys via Tools

| Tool | Description |
|------|-------------|
| `sys_get_meta` | Read one key's value, or list all entries as `key\tvalue` lines. Query `adf_meta` directly for protection levels |
| `sys_set_meta` | Create or update a key. Optional `protection` parameter on creation |
| `sys_delete_meta` | Delete a key (blocked if `readonly` or `increment`) |

### Working with Meta Keys in the UI

The **Config** tab includes a **Meta Keys** section at the bottom showing all key-value pairs with color-coded protection badges: red for `readonly`, blue for `increment`, gray for `none`.

From here you can:

- **View/edit a key** — Click a row to open the meta key modal
- **Change the value** — Edit the value in the modal textarea and save
- **Cycle protection** — Click the protection button to cycle: `none` → `readonly` → `increment` → `none`
- **Delete a key** — Click Delete in the modal (the owner can delete any key regardless of protection)
- **Add a new key** — Click "+ Add key" to create a new key with a chosen protection level

### System Keys

Keys prefixed with `adf_` are system-managed and set to `readonly` protection. These include `adf_did`, `adf_name`, `adf_handle`, `adf_schema_version`, `adf_created_at`, `adf_updated_at`, and `adf_parent_did`.

The `status` key is created by default with `none` protection for agents to track their current state.

## Local Database Tables

Beyond the filesystem, agents can create custom SQLite tables for structured data. Tables must not use the `adf_` prefix (which is reserved for system tables).

### Convention

The recommended prefix is `local_` (e.g., `local_chat_history`, `local_embeddings`), but any non-`adf_` name works.

### Creating Tables

Agents create tables via the `db_execute` tool:

```sql
CREATE TABLE local_subscribers (agent_id TEXT, topic TEXT, subscribed_at INTEGER);
```

### Querying Tables

Use `db_query` for SELECT statements and `db_execute` for INSERT/UPDATE/DELETE. The runtime guarantees persistence of these tables.

### Vector Search

The [sqlite-vec](https://github.com/asg017/sqlite-vec) extension is loaded on every ADF database, enabling vector similarity search via `vec0` virtual tables. Use the `local_` prefix as with any agent-created table.

**Creating a vector table:**

```sql
CREATE VIRTUAL TABLE local_embeddings USING vec0(
  document_id TEXT,
  embedding float[384]
);
```

The dimension (e.g. `384`) must match the embedding model you use. Common sizes: 384 (MiniLM), 768 (BERT), 1536 (OpenAI ada-002).

**Inserting vectors:**

```sql
INSERT INTO local_embeddings(document_id, embedding) VALUES (?, ?);
```

Pass the vector as a JSON array (e.g. `[0.1, 0.2, ...]`) via bind parameters.

**Querying nearest neighbors:**

```sql
SELECT document_id, distance FROM local_embeddings
WHERE embedding MATCH ? AND k = 10;
```

The `MATCH` clause performs brute-force nearest-neighbor search using Euclidean (L2) distance. The `k` parameter controls how many results to return. This scales well for up to tens of thousands of vectors per table.

**Important notes:**

- Vectors are stored in binary format internally. Reading the raw `embedding` column returns binary data, not a JSON array — use `MATCH` queries for search, not raw column reads.
- Dimension mismatches on insert produce a clear error (e.g. inserting a 3D vector into a `float[4]` column).
- Updates to both metadata fields and embeddings are supported. Updated vectors participate in search immediately.
- To generate embeddings, use your existing tools — call an embedding API from `sys_code` or a lambda, then insert the resulting vectors via `db_execute`.

### Viewing Tables in the UI

The **Files** tab includes a section for database tables where you can:

- See all custom tables and their row counts
- Query table data with pagination
- Drop tables (custom tables only)
- View the `adf_archive` table (read-only) to see archived data snapshots

## File Write Size Limits

The `limits.max_file_write_bytes` setting (default: 5 MB) controls the maximum size of files an agent can write via `fs_write`. If the content exceeds this limit, the write is rejected with a human-readable error message.

This limit does **not** apply to `document.md` or `mind.md`, which have no write size cap.

## The adf-file:// Protocol

ADF Studio registers a custom `adf-file://` protocol for referencing files stored inside the ADF database. It supports both inline images and clickable links to other workspace files.

### Usage

Reference ADF files in markdown using the `adf-file://` scheme:

```markdown
[see notes](adf-file://notes/research.md)
![Screenshot](adf-file:///screenshot.png)
```

- **Links** — Clicking an `adf-file://` link opens the target file in a new editor tab (or activates it if already open). Works in both the markdown editor and the agent loop.
- **Images** — The protocol serves file content directly from the `adf_files` table, so images render inline without extracting to disk.

### Image Support in the Editor

The markdown editor supports:

- **Inline images** — Standard markdown image syntax with `adf-file://` URLs
- **Resizable images** — Drag handles to resize; dimensions are preserved through markdown round-trips as HTML `<img>` tags
- Spaces in file paths are automatically percent-encoded (`%20`)

---

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

---

# Code Execution Environment

All code in ADF — whether run by `sys_code`, `sys_lambda`, trigger lambdas, timer lambdas, or API route handlers — executes inside a sandboxed environment built on Node.js Worker Threads and V8 VM Contexts.

## Execution Contexts

| Context | Entry Point | State Persistence | Authorization | Receives |
|---------|------------|-------------------|---------------|----------|
| `sys_code` | LLM calls the tool | Yes — same worker per agent, variables carry over | Always unauthorized | Raw code string |
| `sys_lambda` | LLM calls the tool | No — fresh VM context per call | HIL if target is authorized; otherwise unauthorized | `args` object via destructuring |
| Trigger lambda | System scope trigger fires | No — fresh VM context per call (unless `warm: true`) | Based on file's `authorized` flag | `event` object ([details](triggers.md#lambda-event-object)) |
| Timer lambda | `on_timer` system scope fires | No — fresh VM context per call (unless `warm: true`) | Based on file's `authorized` flag | `event` object ([details](timers.md#timer-lambda-execution)) |
| API route handler | HTTP request matches a route | No — fresh VM context per call (unless `warm: true`) | Based on file's `authorized` flag | `request` object ([details](serving.md#lambda-functions)) |
| Middleware lambda | Pipeline integration point fires | No — fresh VM context per call | Based on file's `authorized` flag | `input` object ([details](middleware.md#input)) |

All contexts have access to the [`adf` proxy object](adf-object.md) for calling tools, invoking the model (including multimodal content blocks — `image_url`, `input_audio`, `video_url` — for capable models; see [model_invoke](adf-object.md#model_invoke)), and running lambdas.

The **Authorization** column indicates whether the execution context can call [restricted tools and methods](authorized-code.md). `sys_code` always runs unauthorized — inline code has no provenance. When the LLM calls `sys_lambda` targeting an authorized file, the runtime triggers a HIL approval prompt; if approved, the lambda runs with authorization. Unauthorized targets run without authorization, no prompt needed. System-initiated contexts (triggers, timers, middleware) inherit authorization from the source file's `authorized` flag. See [Authorized Code Execution](authorized-code.md) for the full security model.

## Security Model

The sandbox is configured with:

```javascript
codeGeneration: { strings: false, wasm: true }
```

This disables:
- `eval()` and `new Function()` — no dynamic code generation from strings

WebAssembly is enabled to support standard library packages that use WASM (e.g., sql.js, mupdf).

Native `fetch` and related globals (`Request`, `Response`, `Headers`) are deleted from the worker scope on startup. All network access must go through `adf.sys_fetch()`, which routes through the agent's security middleware pipeline.

## Available Globals

The sandbox exposes a curated set of standard JavaScript globals:

**Core types:** `Array`, `Object`, `Map`, `Set`, `WeakMap`, `WeakSet`, `String`, `Number`, `Boolean`, `Symbol`, `BigInt`, `RegExp`

**Error types:** `Error`, `TypeError`, `RangeError`, `SyntaxError`, `URIError`, `ReferenceError`, `EvalError`

**Numbers and encoding:** `parseInt`, `parseFloat`, `isNaN`, `isFinite`, `NaN`, `Infinity`, `undefined`, `encodeURIComponent`, `decodeURIComponent`, `encodeURI`, `decodeURI`, `atob`, `btoa`

**Binary data:** `ArrayBuffer`, `SharedArrayBuffer`, `DataView`, `Uint8Array`, `Uint16Array`, `Uint32Array`, `Uint8ClampedArray`, `Int8Array`, `Int16Array`, `Int32Array`, `Float32Array`, `Float64Array`, `BigInt64Array`, `BigUint64Array`, `Buffer`

**Async and timing:** `Promise`, `setTimeout`, `clearTimeout`, `setInterval`, `clearInterval`, `queueMicrotask`

**Utilities:** `Math`, `Date`, `JSON`, `structuredClone`, `TextEncoder`, `TextDecoder`, `URL`, `URLSearchParams`

**ADF-specific:** `adf` (proxy object), `__require` (for allowed Node.js modules and standard library packages), `__stdlibPath` (base path for standard library packages on disk)

## Not Available

| Global | Reason | Alternative |
|--------|--------|-------------|
| `console` | Undefined in `sys_code` context (available in lambdas) | Use `adf.fs_write()` to persist output |
| `fetch` | Deleted on worker startup — no direct network access | `adf.sys_fetch()` |
| `eval` / `Function` | Disabled by `codeGeneration` policy | Write code directly |
| `require` / `import` | No arbitrary module loading | `import` from allowed modules and standard library (see below) |
| `process` | No access to host process | N/A |
| `__dirname` / `__filename` | No filesystem path context | N/A |

**Note:** Lambda contexts (`sys_lambda`, triggers, timers, API routes) **do** have `console.log`, `console.warn`, `console.error`, and `console.info` — output is captured and logged to `adf_logs`. The `sys_code` context does not have console by default but gets it injected per execution.

## Allowed Node.js Modules

You can use standard `import` syntax to load these built-in Node.js modules:

| Module | Use Case |
|--------|----------|
| `crypto` | Hashing, HMAC, random bytes, encryption |
| `buffer` | Binary data manipulation |
| `url` | URL parsing and formatting |
| `querystring` | Query string parsing |
| `path` | File path manipulation |
| `util` | Utility functions (inspect, format, promisify) |
| `string_decoder` | Buffer-to-string decoding |
| `punycode` | Unicode/ASCII domain encoding |
| `assert` | Assertions for validation |
| `events` | EventEmitter pattern |
| `stream` | Stream processing |
| `zlib` | Compression (gzip, deflate, brotli) |
| `os` | OS information (platform, arch, cpus) |

```javascript
import { createHash } from 'crypto'
import { join } from 'path'

const hash = createHash('sha256').update('hello').digest('hex')
const filePath = join('lib', 'utils.ts')
```

Importing any module not in this list (and not in the standard library or [custom packages](#custom-packages)) throws an error:
```
Module "fs" is not available in the sandbox. Available modules: crypto, buffer, url, ..., xlsx, pdf-lib, ...
```

## Standard Library Packages

In addition to Node.js built-in modules, the sandbox provides a curated set of npm packages for document processing, data manipulation, and image handling. These are always available — no configuration needed.

| Package | Version | Use Case |
|---------|---------|----------|
| `xlsx` | 0.18.5 | Read/write Excel spreadsheets (.xlsx, .xls, .csv) |
| `pdf-lib` | 1.17.1 | Create and modify PDF documents |
| `mupdf` | 0.3.0 | Parse and extract content from existing PDFs |
| `docx` | 9.0.2 | Generate Word documents (.docx) |
| `jszip` | 3.10.1 | Create and extract ZIP archives |
| `sql.js` | 1.11.0 | In-memory SQLite database (WebAssembly) |
| `cheerio` | 1.0.0 | Parse and manipulate HTML (jQuery-like API) |
| `yaml` | 2.6.0 | Parse and stringify YAML |
| `date-fns` | 4.1.0 | Date/time manipulation and formatting |
| `jimp` | 1.6.0 | Image processing (resize, crop, rotate, filters) |

All packages are pure JavaScript or WebAssembly — no native addons.

### Usage Examples

```javascript
// Parse an Excel file from the VFS
import { read, utils } from 'xlsx'
const file = await adf.fs_read({ path: 'data/report.xlsx' })
const buf = Buffer.from(file.content, 'base64')
const workbook = read(buf)
const sheet = workbook.Sheets[workbook.SheetNames[0]]
const rows = utils.sheet_to_json(sheet)

// Create a PDF
import { PDFDocument } from 'pdf-lib'
const doc = await PDFDocument.create()
const page = doc.addPage()
page.drawText('Hello from ADF')
const bytes = await doc.save()
await adf.fs_write({ mode: 'write', path: 'output.pdf', content: Buffer.from(bytes), mime_type: 'application/pdf' })

// Parse HTML
import * as cheerio from 'cheerio'
const resp = await adf.sys_fetch({ url: 'https://example.com' })
const $ = cheerio.load(resp.body)
const title = $('title').text()

// In-memory SQLite
import initSqlJs from 'sql.js'
const SQL = await initSqlJs()
const db = new SQL.Database()
db.run('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)')
db.run("INSERT INTO test VALUES (1, 'hello')")
const results = db.exec('SELECT * FROM test')

// Process images
import { Jimp } from 'jimp'
const imgFile = await adf.fs_read({ path: 'photo.png' })
const image = await Jimp.read(Buffer.from(imgFile.content, 'base64'))
image.resize({ w: 200, h: 200 })
const output = await image.getBuffer('image/png')
await adf.fs_write({ mode: 'write', path: 'thumb.png', content: output, mime_type: 'image/png' })

// Parse/stringify YAML
import YAML from 'yaml'
const config = YAML.parse('key: value\nlist:\n  - a\n  - b')
const yamlStr = YAML.stringify({ hello: 'world' })

// Date manipulation
import { format, addDays } from 'date-fns'
const tomorrow = format(addDays(new Date(), 1), 'yyyy-MM-dd')

// Read a PDF with mupdf
import mupdf from 'mupdf'
const pdfFile = await adf.fs_read({ path: 'document.pdf' })
const pdfDoc = mupdf.Document.openDocument(Buffer.from(pdfFile.content, 'base64'), 'application/pdf')
const pageCount = pdfDoc.countPages()
```

### First-Launch Install

Standard library packages are installed automatically on first launch to `~/.adf-studio/sandbox-stdlib/`. During the initial install (typically 1-2 minutes), attempting to import a stdlib package throws:

```
Module "xlsx" is not available. Standard library is still installing — try again shortly.
```

A progress banner appears in the UI during installation. Subsequent launches use the cached packages.

## Custom Packages

Beyond the standard library, agents can install additional npm packages using the [`npm_install`](tools.md#npm_install) tool. Packages must be pure JavaScript or WebAssembly — native addons are detected and blocked.

### Installing from Code

```javascript
// Agent installs a package (persisted to its config)
await adf.npm_install({ name: 'vega-lite', version: '^5.21.0' })
await adf.npm_install({ name: 'vega' })
await adf.npm_install({ name: '@resvg/resvg-wasm' })
```

Installed packages become importable on the **next turn**:

```javascript
import * as vl from 'vega-lite'
import * as vega from 'vega'
import { Resvg } from '@resvg/resvg-wasm'

const spec = { /* vega-lite spec */ }
const compiled = vl.compile(spec)
const view = new vega.View(vega.parse(compiled.spec), { renderer: 'none' })
const svg = await view.toSVG()

// SVG → PNG via WASM (auto-initialized, no initWasm() call needed)
const png = new Resvg(svg, { fitTo: { mode: 'width', value: 800 } }).render().asPng()
await adf.fs_write({ mode: 'write', path: 'chart.png', content: Buffer.from(png).toString('base64'), encoding: 'base64', mime_type: 'image/png' })
```

### Three Package Tiers

| Tier | Scope | Managed by |
|------|-------|------------|
| **Standard library** | All agents, always | Bundled with Studio |
| **Runtime packages** | All agents on this instance | User via Settings > Packages |
| **Agent packages** | Single agent | Agent via `npm_install` / agent config UI |

Module resolution follows this order: Node built-ins → stdlib → runtime packages → agent packages. If a package isn't in the agent's config or the runtime config, the import throws `MODULE_NOT_FOUND` even if the package is installed on disk.

### Runtime Packages

Runtime packages are configured in **Settings > Packages** and are available to every agent. Use this for packages you want globally available (e.g., charting libraries, data processing tools). Agents can also promote their own packages to runtime via the **Make Runtime** button in Settings.

### Limits

| Limit | Value |
|-------|-------|
| Per-package install size | 50 MB |
| Total user packages | 200 MB |
| Max packages per agent | 50 |

### WASM Auto-Initialization

Packages that use WebAssembly and export an `initWasm()` function (common for wasm-bindgen packages like `@resvg/resvg-wasm`) are auto-initialized during import. The sandbox detects the `.wasm` file in the package directory, reads it, and calls `initWasm(buffer)` before returning the module. No manual initialization is needed.

### First-Open Install Prompt

When opening an agent that declares packages in `code_execution.packages`, Studio checks if those packages are installed. Missing packages trigger a modal prompting the user to install them or skip.

## Import/Export Transforms

Before execution, the sandbox transforms modern JavaScript syntax:

**Imports** are converted to `await __require()` calls:
```javascript
// Written as:
import { createHash } from 'crypto'
import path from 'path'
import * as util from 'util'

// Transformed to:
const { createHash } = await __require('crypto')
const path = await __require('path')
const util = await __require('util')
```

The `await` is required for standard library packages that use ESM with top-level await (e.g., mupdf). For Node.js built-in modules, `__require()` resolves synchronously but the `await` is harmless.

**Exports** are stripped so functions/constants become context-accessible:
```javascript
// Written as:
export function process(data) { ... }
export const VERSION = '1.0'

// Transformed to:
function process(data) { ... }
const VERSION = '1.0'
```

This means you can write standard TypeScript/JavaScript modules and they work in the sandbox.

## The adf Object

Every execution context has access to the global `adf` proxy object. It provides an async RPC bridge to all enabled agent tools, the LLM model, the lambda execution engine, and the identity store. In addition to regular tools, the following **special methods** are available only from code execution (controlled via the Code Execution config): `model_invoke`, `sys_lambda`, `task_resolve`, `loop_inject`, `get_identity`. Additional methods are available exclusively from [authorized code](authorized-code.md): `set_meta_protection`, `set_file_protection` (and `sys_set_meta`/`sys_delete_meta` bypass protection checks when authorized).

### Bypassing Output Limits (`_full`)

Tools like `db_query` truncate their output by default to protect the LLM context window. Since code execution results go to your code (not the model), you can add `_full: true` to get the complete, untruncated result:

```javascript
const allRows = await adf.db_query({ sql: 'SELECT * FROM local_events', _full: true })
```

Note: `fs_read` always returns full content from code execution — no `_full` needed:

```javascript
const result = await adf.fs_read({ path: 'data/export.csv' })
const lines = result.content.split('\n')
```

This parameter is **only honored in code execution contexts** — the runtime strips it from direct LLM tool calls. See the [adf object reference](adf-object.md#full-output-_full) for details.

See the **[adf Proxy Object Reference](adf-object.md)** for the complete API.

## Console and Logging

Console behavior varies by context:

| Context | `console` Available | Output Destination |
|---------|--------------------|--------------------|
| `sys_code` | Yes (injected per execution) | Returned as `stdout` in tool result |
| `sys_lambda` | Yes | Returned as `stdout` in tool result, logged to `adf_logs` |
| Trigger lambdas | Yes | Logged to `adf_logs` |
| Timer lambdas | Yes | Logged to `adf_logs` |
| API route handlers | Yes | Logged to `adf_logs` with the `api_response` entry |

All console methods (`log`, `warn`, `error`, `info`) are captured. `warn` and `error` prefix output with `[warn]` and `[error]` respectively.

## Timeouts

| Setting | Value |
|---------|-------|
| Default timeout | 10 seconds |
| Maximum timeout | 300 seconds (5 minutes) |

The `sys_code` tool accepts an optional `timeout` parameter (in milliseconds) capped at the maximum. If execution exceeds the timeout, the operation fails with a `TIMEOUT` error code.

The worker itself has an additional 2-second buffer beyond the configured timeout to allow pending RPC round-trips to complete before the worker is forcibly terminated.

## State Persistence

**`sys_code`** uses a **persistent worker** per agent. Variables, functions, and state defined in one `sys_code` call carry over to the next. This makes it suitable for building up state incrementally:

```javascript
// First call
let counter = 0
function increment() { return ++counter }

// Second call — counter and increment() still exist
const val = increment() // returns 1
```

**`sys_lambda`**, **trigger lambdas**, **timer lambdas**, and **API route handlers** use **fresh VM contexts** by default. Each invocation starts clean with no leftover state.

**Warm mode:** Trigger targets, timers, and API routes can set `warm: true` to keep the sandbox worker alive between invocations. This trades isolation for performance — useful for frequently-firing triggers or high-traffic API endpoints. The sandbox IDs are:
- Trigger/timer lambdas: `{agentId}:lambda`
- API routes: `{agentId}:api`

## Error Handling

All `adf.*` calls can throw errors. Use `try`/`catch` to handle them:

```javascript
try {
  const data = await adf.fs_read({ path: 'config.json' })
  const config = JSON.parse(data)
} catch (err) {
  // err.code contains the error code (e.g., 'NOT_FOUND', 'TOOL_ERROR')
  // err.message contains a human-readable description
  await adf.fs_write({ path: 'errors.log', content: `Error: ${err.message}\n` })
}
```

The sandbox also fast-fails for certain conditions without making an RPC round-trip:

- **Disabled/unknown tools** — If the tool isn't in the agent's enabled set (and not `restricted`), throws immediately with code `NOT_FOUND`
- **Restricted tools** — Tools with `restricted: true` cannot be called from unauthorized code, throws with code `REQUIRES_AUTHORIZED_CODE`. Authorized code can call restricted tools directly (bypassing HIL).

See the [adf object error codes](adf-object.md#error-handling) for the complete list.

## Circular Call Detection

When `sys_lambda` calls another `sys_lambda` (via the `adf` proxy), the runtime tracks the call stack. If a circular call is detected (A calls B which calls A), execution fails immediately with a `CIRCULAR_CALL` error:

```
Circular sys_lambda detected: lib/a.ts:process → lib/b.ts:transform → lib/a.ts:process
```

This prevents infinite recursion between lambda functions.

---

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

---

# MCP Integration

ADF supports the **Model Context Protocol (MCP)** for connecting external tool servers. This lets agents use tools provided by third-party services or local utilities without building them into the ADF runtime.

## What is MCP?

MCP is a standard protocol for connecting AI models to external tools and data sources. An MCP server exposes a set of tools that the model can call, just like built-in tools.

Common examples:

- Filesystem access (read/write files on the host machine)
- Web browsing and search
- Database connections
- API integrations (Slack, GitHub, etc.)

## MCP Server Manager

ADF Studio includes a built-in **MCP Server Manager** for installing, configuring, and monitoring MCP servers. Access it from **Settings > MCP Servers**.

### Quick-Add Registry

The Server Manager includes a curated registry of well-known MCP servers you can install with one click:

| Server | Category | Description |
|--------|----------|-------------|
| **Filesystem** | Tools | Read, write, and manage local files and directories |
| **GitHub** | Dev | Interact with GitHub repositories, issues, and PRs |
| **Memory** | Data | Persistent knowledge graph memory for agents |
| **Brave Search** | Tools | Search the web using Brave Search API |
| **Puppeteer** | Tools | Browser automation with Puppeteer |
| **Slack** | Communication | Interact with Slack workspaces |
| **Sequential Thinking** | Tools | Dynamic, reflective problem-solving through thought sequences |
| **Mail (IMAP/SMTP)** | Communication | Search, read, and send email |
| **Resend** | Communication | Send emails via the Resend platform |
| **Telegram** | Communication | Interact with Telegram via bot API |
| **Discord** | Communication | Discord bot integration |
| **Twilio SMS** | Communication | Send and receive SMS via Twilio |

### Installing a Server

1. Open **Settings > MCP Servers**
2. Browse the registry or click **Add Server**
3. Click **Install** on a registry server, or configure a custom server manually
4. The Server Manager runs `npm install` in `~/.adf-studio/mcp-servers/<package>/`
5. The server entry point is resolved automatically (no `npx` needed in production)

### Status Dashboard

The MCP Status Dashboard shows all registered servers with:

- **Connection status** — Connected, disconnected, or errored
- **Tool count** — Number of tools the server exposes
- **Health checks** — Periodic pings to verify the server is alive
- **Logs** — Expandable log viewer per server (including tool call logs)
- **Actions** — Test connection, restart, view logs, remove

Click any server to expand its configuration panel where you can edit args, environment variables, and timeout settings.

### Per-Server Arguments

Each server supports a list of command-line arguments (one per row in the UI). Arguments support `~` expansion for home directory paths. Empty arguments are automatically filtered out.

### Per-Server Timeout

Each server can have a custom **tool call timeout** (in seconds). This controls how long the runtime waits for a tool call response before timing out. The default is **60 seconds**. Configure this in the server's expanded settings panel.

## Credential Management

Many MCP servers require API keys or other secrets. ADF Studio provides two levels of credential storage:

### App-Wide Credentials

Credentials stored at the application level (in Settings) are available to any agent that uses the server. These are stored encrypted on disk.

### Per-Agent (ADF) Credentials

Credentials can also be stored in an individual agent's `adf_identity` table using the naming convention `mcp:<server>:<key>`. These are encrypted with the agent's password (if set) and travel with the `.adf` file.

### Credential Panel

The credential panel (accessible from the MCP Status Dashboard) lets you:

- Set app-wide credentials for each server's required environment variables
- Set per-agent credentials for specific ADF files
- See which servers have stored credentials (key icon indicator)
- See which servers need credentials ("Needs keys" badge)

When credentials are saved for an agent, the MCP server configuration is automatically attached to that agent. When credentials are removed, the server is detached.

### Credential Security

- Credentials are decrypted at runtime only when connecting the server process
- A defensive copy prevents decrypted values from being written back to persisted config
- Environment variables are passed to the server process, not to the agent

## Interactive Authentication (OAuth)

Some MCP servers require interactive authentication — typically an OAuth flow where the user authorizes access in a browser. ADF Studio handles this through an **auth preflight** step built into `mcp_install`.

### How It Works

When an agent installs an MCP server with `auth: true`, the runtime:

1. **Spawns the server as a normal process** (not as an MCP transport) with any specified `auth_args`
2. **Detects auth URLs** in the server's stdout/stderr and opens them in the default browser via Electron
3. **Shows a dialog**: "Complete authorization in your browser, then click Continue"
4. **Waits for the user** to finish the OAuth flow and click Continue
5. **Kills the preflight process** and connects via the normal MCP stdio transport

The server's OAuth flow saves credentials to disk (e.g., `~/.gmail-mcp/credentials.json`). Subsequent MCP connections use those saved credentials — no browser needed.

### Agent-Side Usage

The agent calls `mcp_install` with the `auth` and `auth_args` parameters:

```json
{
  "package": "@gongrzhe/server-gmail-autoauth-mcp",
  "type": "npm",
  "name": "gmail",
  "host": true,
  "auth": true,
  "auth_args": ["auth"]
}
```

| Parameter | Purpose |
|-----------|---------|
| `auth` | Enables the auth preflight — spawns the server once before connecting |
| `auth_args` | Extra arguments passed to the server during preflight (e.g., `["auth"]` for servers with a dedicated auth subcommand) |

### Prerequisites (Google OAuth Example)

Many MCP servers that use Google APIs (Gmail, Google Drive, Google Calendar) require a Google Cloud OAuth client credentials file. Here's the one-time setup:

1. Go to [Google Cloud Console](https://console.cloud.google.com/) → **APIs & Services** → **Credentials**
2. If prompted, configure the **OAuth consent screen**:
   - User type: **External**
   - App name: anything (e.g., "ADF Studio")
   - Support email and developer contact: your email
   - Add your email as a **test user** under Audience → Test users (if app is in testing mode)
   - Or click **Publish App** to skip the test user requirement
3. Click **+ Create Credentials** → **OAuth client ID** → **Desktop app**
4. Download the JSON file
5. Rename it to `gcp-oauth.keys.json` and place it at `~/.gmail-mcp/gcp-oauth.keys.json`
6. Enable the **Gmail API** in APIs & Services → Library

After this setup, the agent's `mcp_install` with `auth: true` will open a Google consent screen in the browser.

### Example: Gmail MCP Server

Full install flow from the agent's perspective:

```
mcp_install({
  package: "@gongrzhe/server-gmail-autoauth-mcp",
  type: "npm",
  name: "gmail",
  host: true,
  auth: true,
  auth_args: ["auth"]
})
```

What happens:
1. Runtime runs `npx -y @gongrzhe/server-gmail-autoauth-mcp auth`
2. Server prints the Google OAuth URL → runtime opens it in the browser
3. User authorizes Gmail access in the browser
4. Server receives the OAuth callback on `localhost:3000` and saves tokens to `~/.gmail-mcp/credentials.json`
5. User clicks **Continue** in the ADF dialog
6. Runtime kills the preflight, connects via stdio, discovers ~19 Gmail tools

The agent can now use tools like `mcp_gmail_send_email`, `mcp_gmail_search_emails`, `mcp_gmail_list_email_labels`, etc.

### Common Auth Patterns Across MCP Servers

| Pattern | How it works | `auth_args` example |
|---------|-------------|-------------------|
| **Auth subcommand** | Server has a dedicated auth mode that opens browser and saves tokens | `["auth"]` |
| **Device code flow** | Server prints a code + URL; user enters code in browser | `["--auth=device-code"]` or `["init"]` |
| **Env var / API key** | No interactive auth — just pass the key via `env` parameter | Not needed (use `env` instead) |
| **Remote HTTP (OAuth 2.1)** | Auth handled by the MCP client/transport layer, not the server | Not needed |

Servers with an `auth` subcommand (Google Drive, Gmail, Spotify) are the most common case. Device code flows (Microsoft, Auth0) also work — the URL is detected and opened automatically.

### Interactive vs Headless

| Scenario | Auth approach |
|----------|--------------|
| **Interactive** (user at Studio) | `auth: true` on `mcp_install` → preflight → user confirms in dialog |
| **Headless** (autonomous agent) | Owner pre-authorizes externally, stores token in identity keystore via `env`, server reads from env |

OAuth is fundamentally interactive — it requires a human in a browser. For headless agents, the owner does the OAuth dance once on their own machine, extracts the token, and configures the agent with it via the `env` parameter on `mcp_install`.

## First-Open Modal

When you open an `.adf` file that references MCP servers not yet installed on your machine, a **Missing MCP Servers** dialog appears. This lets you install the required servers with a single click before the agent tries to use them.

## Per-Agent Server Attachment

After registering a server globally, you attach it to individual agents in their configuration panel:

- **Registered servers** show with their registry info (description, repo link, docs link)
- **Attach/Detach** buttons control whether the server is connected when the agent starts
- **Remove** button (for unregistered servers) includes a confirmation dialog warning about credential deletion
- Unregistered server blocks are collapsible (collapsed by default) with a count indicator

Only servers registered in Settings are connected during agent start. Servers referenced in an agent's config but not installed globally have their tool declarations disabled to prevent sending unavailable tools to the LLM.

## Using MCP Tools

MCP tools appear in the agent's tool list with the naming convention:

```
mcp:<server_name>:<tool_name>
```

For example, a filesystem server might expose:

- `mcp:filesystem:read_file`
- `mcp:filesystem:write_file`
- `mcp:filesystem:list_directory`

### Viewing MCP Tool Schemas

In the agent configuration panel, MCP tools are **clickable** — click any MCP tool name to open a modal showing its full JSON schema (parameters, types, descriptions). This helps you understand what each tool expects without needing to look up the server's documentation.

### Enabling/Disabling MCP Tools

Like built-in tools, each MCP tool can be individually enabled or disabled in the agent's tool configuration:

```json
{ "name": "mcp:filesystem:read_file", "enabled": true }
```

### Disabled Tool Guard

If an agent attempts to call a tool that is not in its enabled set (including disabled MCP tools), the runtime **rejects the call** and returns an error to the model. This prevents the agent from using tools it shouldn't have access to.

### Unavailable Servers

If an MCP server is unavailable (failed to start, crashed, not installed), its tools are **silently disabled**. The agent won't see them in its available tools and won't attempt to call them.

### Media and Resource Content

MCP tools can return multiple content block types beyond plain text. The runtime handles all of them — nothing is silently dropped. All media (images, audio, resources) returned by MCP tools is automatically saved to `adf_files` at `mcp/{server}/{tool}_{timestamp}_{index}.{ext}` and referenced by durable VFS path in the tool result text. The agent can revisit saved media later via `fs_read`.

#### Multimodal Support (Image, Audio, Video)

Media from MCP tools and `fs_read` can be sent as native content blocks to the LLM when the corresponding modality is enabled in `model.multimodal`:

- **Image** (`multimodal.image`): `image_url` content blocks, same as the legacy `model.vision` toggle. Supports PNG, JPEG, GIF, WEBP. Size limit: `limits.max_image_size_bytes` (default 5 MB).
- **Audio** (`multimodal.audio`): `input_audio` content blocks. Supports WAV, MP3, OGG, FLAC, AAC, AIFF, M4A, WebM. Size limit: `limits.max_audio_size_bytes` (default 10 MB). Note: the AI SDK only natively supports WAV and MP3; other formats are coerced to WAV for the SDK's validator but the actual codec negotiation happens provider-side.
- **Video** (`multimodal.video`): `video_url` content blocks. Supports MP4, MPEG, QuickTime, WebM. Size limit: `limits.max_video_size_bytes` (default 20 MB). Note: the AI SDK doesn't support video natively — the runtime bypasses the SDK's message validation and injects raw OpenAI-format `video_url` parts directly into the HTTP request body. This works for providers that support the OpenAI chat completions format (OpenRouter, Gemini, etc.).

When a modality is disabled, media is still saved to `adf_files` and the tool result text includes a path reference (e.g., `[image: mcp/puppeteer/screenshot_1710000000_1.png (image/png)]`), but no content block is created for the LLM.

**In code/shell execution:** The full structured JSON response is always returned with raw base64 data regardless of multimodal settings (see below).

#### Resources and Resource Links

- **Embedded resources** with text content are inlined directly into the text response.
- **Embedded resources** with binary (blob) data are preserved in the structured JSON for code/shell access (see below). In the LLM loop, they appear as text summaries: `[resource 1: application/octet-stream, file:///path] — call this tool in code to access the raw data`.
- **Resource links** appear as: `[Resource link: <name> (<uri>)]`

#### Unknown Content Types

Any content type not recognized by the runtime is included as `[Unsupported content type: <type>]` rather than being silently dropped.

#### Structured JSON Response (Code/Shell)

When an MCP tool returns media or binary content (images, audio, resource blobs), code/shell execution contexts receive the full structured JSON:

```json
{
  "text": "Optional text content",
  "images": [
    { "data": "<base64>", "mimeType": "image/png" }
  ],
  "audio": [
    { "data": "<base64>", "mimeType": "audio/mpeg" }
  ],
  "resources": [
    { "data": "<base64>", "mimeType": "application/octet-stream", "uri": "file:///path/to/file" }
  ]
}
```

This allows agents to parse, modify, save (via `fs_write`), or forward data programmatically. Text-only MCP responses remain plain strings (no JSON wrapping).

#### File I/O Between Host OS and ADF

Agents can use MCP servers (e.g., `@modelcontextprotocol/server-filesystem`) to read and write files on the host OS. This works best from code execution contexts where the agent has access to the full structured response:

**Reading a file from the host into ADF:**
```javascript
// Read binary file from host via MCP filesystem server
const result = await adf.mcp_filesystem_read_file({ path: '/home/user/photo.jpg' });
// Resource blob data is in result.resources[0].data (base64)
await adf.fs_write({ mode: 'write', path: 'photo.jpg', content: result.resources[0].data, encoding: 'base64' });
```

**Writing a file from ADF to the host:**
```javascript
// Read file from ADF VFS
const file = await adf.fs_read({ path: 'photo.jpg' });
// Write to host via MCP filesystem server
await adf.mcp_filesystem_write_file({ path: '/home/user/output.jpg', content: file.content });
```

Text files work the same way but without the `encoding: 'base64'` parameter.

## MCP Server Lifecycle

- Servers start when an agent that uses them becomes active
- Servers are stopped when no active agents need them
- The **Emergency Stop** button disconnects all MCP servers immediately
- Server processes are managed by the runtime, not the agent
- **Auto-restart:** if a server crashes, the supervisor attempts to reconnect with exponential backoff (2s, 4s, 8s, up to 3 retries). On successful reconnect, tools are automatically re-registered so the agent can use them again without a restart.
- Health checks use lightweight pings (not full tool listing) to minimize overhead
- If a tool is called while its server is disconnected, the agent receives an error with the server's status and reason (e.g., `"status: error: Connection lost"`) rather than a generic failure

### Per-Agent Scratch Directory

Each agent with MCP servers gets an isolated temporary directory at `{os-temp}/adf-scratch-{pid}/{agent-name}-{hash}/`. This directory is set as the working directory (`cwd`) for all MCP server processes spawned by that agent.

**Why this matters:** MCP servers that write files as side effects (screenshots, downloads, generated assets) would otherwise write to the app root. The scratch directory isolates these writes per agent.

- Created on agent start (both foreground and background)
- Transfers with the MCP manager on foreground ↔ background transitions
- Deleted on agent stop, after MCP servers are disconnected
- Scoped per process to support multi-instance Studio (`ADF_INSTANCE`)
- Stale directories from unclean shutdowns are cleaned up on app launch

The scratch directory is purely internal — it is not exposed to the agent or configurable. The agent interacts with MCP tools normally; the isolation is transparent.

### Background Agents

Background agents have full MCP support. When an agent with MCP servers configured is started from the sidebar, mesh, or directory start-all, its MCP servers are connected using the same logic as foreground agents. MCP managers and scratch directories transfer seamlessly between foreground and background when switching files, and disconnect cleanly on agent stop or shutdown.

## Security

### Environment Variable Blocklist

MCP server configurations cannot override security-sensitive environment variables. The following are blocked:

- `ELECTRON_RUN_AS_NODE`
- `NODE_OPTIONS`
- `LD_PRELOAD`
- Other security-sensitive process environment variables

If a server config includes blocked variables, a warning is logged identifying which variables were filtered. The server still starts with the remaining environment.

### Input Validation

All MCP IPC handlers have Zod validation on their inputs, covering: probe, install, uninstall, restart, logs, credential set/get/list, attach, and detach operations.

### Path Traversal Guards

- Entry point resolution validates that the resolved path stays within the server's install directory
- Uninstall validates that the install path is within the managed base directory before deletion

### Tool Call Timeout

All MCP tool calls have a default **60-second timeout** to prevent the agent loop from hanging on unresponsive servers. This can be overridden per-server via the `toolCallTimeout` setting.

## Portability Note

MCP server configurations travel with the `.adf` file. However, the servers themselves may not be available on other machines — the required npm packages need to be installed. The [First-Open Modal](#first-open-modal) helps detect and install missing servers when opening a file on a new machine.

---

# Triggers

Triggers define which external events activate an ADF agent. They determine when your agent wakes up and what it responds to.

## Overview

Triggers are organized by **event type** — what happened — and each trigger has an array of **targets** that define how to respond. Each target specifies an execution scope, optional filters, and an optional timing modifier.

There are eight trigger types and two execution scopes:

### Trigger Types

| Trigger | Event |
|---------|-------|
| `on_inbox` | A message arrives in the agent's inbox |
| `on_outbox` | A message is sent from the agent's outbox |
| `on_file_change` | A watched file is modified |
| `on_chat` | Human sends a chat message in the Loop panel |
| `on_timer` | A scheduled timer fires |
| `on_tool_call` | A matching tool is called during the LLM loop (observational, post-execution) |
| `on_task_create` | A task is created (HIL approval, async dispatch) |
| `on_task_complete` | A matching async task completes |
| `on_logs` | A matching log entry is written to `adf_logs` |

### Execution Scopes

| Scope | Description |
|-------|-------------|
| `system` | Runs a lambda function (fast, cheap, deterministic). Fires in all states except `off`. Requires a `lambda` field referencing the function to call. |
| `agent` | Wakes the LLM loop (smart, expensive, probabilistic). Gated by the agent's current state. |

**Self-generated events don't fire triggers.** If an agent edits its own document, `on_file_change` won't fire. This prevents infinite loops.

## Configuration

Triggers are configured in the `triggers` section of the agent config, organized by event type. Each trigger type has an `enabled` flag and an array of `targets`:

```json
{
  "triggers": {
    "on_inbox": {
      "enabled": true,
      "targets": [
        { "scope": "agent", "interval_ms": 30000 }
      ]
    },
    "on_file_change": {
      "enabled": true,
      "targets": [
        { "scope": "agent", "filter": { "watch": "document.md" }, "debounce_ms": 2000 }
      ]
    },
    "on_chat": {
      "enabled": true,
      "targets": [
        { "scope": "agent" }
      ]
    },
    "on_timer": {
      "enabled": true,
      "targets": [
        { "scope": "system" },
        { "scope": "agent" }
      ]
    },
    "on_outbox": { "enabled": false, "targets": [] },
    "on_tool_call": { "enabled": false, "targets": [] },
    "on_task_complete": { "enabled": false, "targets": [] },
    "on_logs": { "enabled": false, "targets": [] }
  }
}
```

A trigger can have **multiple targets**, each with its own scope, filter, and timing. For example, `on_timer` above fires in both system and agent scope.

## Targets

Each target in a trigger's `targets` array has these fields:

| Field | Required | Description |
|-------|----------|-------------|
| `scope` | Yes | `system` or `agent` |
| `filter` | No | Event-specific filter (see [Filters](#filters)) |
| `lambda` | No | System scope only: script entry point (`"path/file.ts:functionName"`) |
| `warm` | No | System scope only: whether to warm-start the lambda |
| `debounce_ms` | No | Timing modifier (mutually exclusive) |
| `interval_ms` | No | Timing modifier (mutually exclusive) |
| `batch_ms` | No | Timing modifier (mutually exclusive) |
| `batch_count` | No | Fire batch early when N events accumulate (requires `batch_ms`) |

Only **one** timing modifier is allowed per target. `batch_count` is an optional companion to `batch_ms`.

## Filters

Filters narrow when a target fires. Available filter fields depend on the trigger type:

| Trigger | Filter Fields | Description |
|---------|---------------|-------------|
| `on_inbox` | `source`, `sender` | Filter by message source (e.g., `mesh`, `telegram`) or sender DID |
| `on_outbox` | `to` | Filter by recipient DID |
| `on_file_change` | `watch` | Glob pattern for file paths (e.g., `document.md`, `data/*`). Payload includes a unified diff when available. |
| `on_tool_call` | `tools` | Array of tool name glob patterns (e.g., `["fs_*", "msg_send"]`) |
| `on_task_create` | `tools` | Array of tool name glob patterns |
| `on_task_complete` | `tools`, `status` | Tool name globs and/or task status |
| `on_logs` | `level`, `origin`, `event` | Level array (e.g., `["error"]`), origin/event glob arrays |
| `on_chat` | — | No filters available |
| `on_timer` | — | No filters available |

### Filter Examples

```json
// Only fire when inbox receives a Telegram message
{ "scope": "agent", "filter": { "source": "telegram" } }

// Only fire when a specific sender messages
{ "scope": "agent", "filter": { "sender": "did:adf:9gvayMZx5m..." } }

// Only fire when document.md changes
{ "scope": "agent", "filter": { "watch": "document.md" }, "debounce_ms": 2000 }

// Fire when any filesystem tool is called
{ "scope": "system", "filter": { "tools": ["fs_*"] } }

// Fire on error logs from serving or lambda origins
{ "scope": "system", "filter": { "level": ["error"], "origin": ["serving", "lambda*"] } }
```

## Timing Modifiers

Each target can use **zero or one** timing modifier. They are mutually exclusive.

### No Modifier (Immediate)

Fire immediately on each event. This is the default when no timing field is specified.

### Debounce

Reset a timer on each new event. Fire once when no events arrive for the specified duration. Good for "wait until they stop typing" behavior.

```json
{ "scope": "agent", "debounce_ms": 2000 }
```

**Example:** With `debounce_ms: 2000` on `on_file_change`, if the user makes edits at 0ms, 500ms, and 1500ms, the trigger fires at 3500ms (1500ms + 2000ms wait).

### Interval

Rate-limit by dropping events that arrive within the interval window.

```json
{ "scope": "agent", "interval_ms": 30000 }
```

**Example:** With `interval_ms: 30000`, the trigger fires at most once every 30 seconds.

**Note:** For `on_inbox`, interval behaves differently — the first event **delays** emission (starts a timer), and subsequent events during the window are absorbed. This batches rapid inbox updates into periodic summaries.

### Batch

Start a timer on the first event. Collect all events during the window. Fire once when the timer expires or when `batch_count` events accumulate, whichever comes first.

```json
{ "scope": "agent", "batch_ms": 5000, "batch_count": 100 }
```

**Example:** Fire after 5 seconds or after 100 events, whichever comes first. If `batch_count` is omitted, the batch fires only when the time window expires.

## on_file_change Payload

When `on_file_change` fires, the trigger payload includes a **unified diff** between the previous file content and the new content (with 3-line context hunks). This allows targets to see exactly what changed without receiving the full file.

```
--- document.md
+++ document.md
@@ -5,3 +5,4 @@
 Some existing content
 More content here
+A newly added line
 Trailing content
```

If the file is too large to diff efficiently (> 1M line-product complexity), or the previous content is unavailable, `diff` will be `null`. The diff is available as `event.data.diff` in lambda event objects.

## Scope Rules

### System Scope

System scope targets execute **lambda functions** from the agent's file store. Each target specifies a `lambda` field pointing to a script entry point (e.g., `"lib/router.ts:onMessage"`). The lambda receives a rich event object with access to `adf.*` methods via the sandbox RPC bridge.

Key behaviors:

- **Not gated by agent state** — fires in all states except `off`
- Silently skipped when no lambda is specified
- Fast and cheap — no LLM costs
- Good for infrastructure tasks: routing, logging, archiving
- All system-scope executions are logged to `adf_logs`

#### Cold vs. Warm Execution

By default, lambdas use **cold execution** — the sandbox worker is created, the lambda runs, and the worker is destroyed. This is safe and isolated but has startup overhead.

Set `warm: true` on a target to use **warm execution** — the worker stays alive between invocations. This is faster for frequently-firing triggers (e.g., timers polling every few seconds) but uses more memory.

```json
{
  "scope": "system",
  "lambda": "lib/router.ts:onMessage",
  "warm": true
}
```

#### Lambda Event Object

Lambda functions receive an `AdfEvent` — a typed envelope with event-specific `data`. The same shape used internally, no transformation. Event data uses existing row types (same shape as `msg_read`, `sys_list_timers`, etc.).

##### Envelope Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique event ID |
| `type` | string | Event type: `"inbox"`, `"outbox"`, `"file_change"`, `"chat"`, `"timer"`, `"tool_call"`, `"task_complete"`, `"log_entry"`, `"startup"` |
| `source` | string | Event origin: `"agent:<name>"`, `"system"`, `"adapter:<name>"` |
| `time` | string | ISO 8601 timestamp |
| `data` | object | Event-specific payload (typed by `type`) |

##### on_inbox — `event.data.message: InboxMessage`

Same shape as `msg_read` returns. Key fields: `from`, `content`, `id`, `parent_id`, `thread_id`, `source`, `source_context`, `attachments`, `received_at`, `status`.

##### on_outbox — `event.data.message: OutboxMessage`

Same shape as outbox row. Key fields: `from`, `to`, `content`, `created_at`, `status`.

##### on_file_change — `event.data: FileChangeEventData`

| Field | Type | Description |
|-------|------|-------------|
| `path` | string | File path |
| `operation` | string | `"created"`, `"modified"`, or `"deleted"` |
| `mime_type` | string \| null | MIME type |
| `size` | number | File size in bytes |
| `diff` | string \| null | Unified diff (when available, e.g. with debounce) |

No content included — call `adf.fs_read({ path })` if needed.

##### on_chat — `event.data.message: LoopEntry`

Same shape as loop row. Contains `content_json` array with text blocks.

##### on_timer — `event.data.timer: Timer`

Same shape as `sys_list_timers` returns. Key fields: `id`, `schedule`, `payload`, `scope`, `run_count`, `created_at`.

See [Timers > Timer Lambda Execution](timers.md#timer-lambda-execution) for more on timer events.

##### on_tool_call — `event.data: ToolCallEventData`

**Observational hook** — fires AFTER the tool executes (or after HIL denial). Does not block execution or create tasks. Use for logging, metrics, or context injection.

| Field | Type | Description |
|-------|------|-------------|
| `toolName` | string | Name of the tool that was called |
| `args` | object | Tool arguments (parsed from JSON) |
| `origin` | string | Call origin: `"agent"` or `"sys_lambda:lib/something.ts"` |

##### on_task_create — `event.data.task: TaskEntry`

Fires when a task is created (HIL approval, async dispatch). Same shape as task row. Key fields: `id`, `tool`, `args`, `status`, `origin`, `requires_authorization`.

Use this for **external approval routing** — dispatch approval requests to Telegram, multi-agent vote systems, or webhooks when HIL tasks are created.

##### on_task_complete — `event.data.task: TaskEntry`

Same shape as task row. Key fields: `id`, `tool`, `args`, `status`, `result`, `error`, `created_at`, `completed_at`, `origin`.

##### on_logs — `event.data.entry: AdfLogEntry`

Same shape as log row. Key fields: `level`, `origin`, `event`, `target`, `message`, `data`, `created_at`.

**Anti-recursion:** Log entries produced by the `on_logs` handler itself do not re-fire the trigger, preventing infinite loops.

##### Accessing the adf API

Lambda functions have full access to the [`adf` proxy object](adf-object.md) for calling tools, invoking the model, and running other lambdas. All code runs in the [sandbox environment](code-execution.md).

```javascript
// lib/router.ts — Inbox router lambda
export async function onMessage(event) {
  const { from, content, id, source_context } = event.data.message

  if (source_context?.intent === 'urgent') {
    await adf.msg_send({ parent_id: id, payload: `Acknowledged urgent message from ${from}` })
  } else {
    await adf.db_execute({
      sql: 'INSERT INTO local_inbox_log (sender, message, ts) VALUES (?, ?, ?)',
      params: [from, content, Date.now()]
    })
  }
}
```

#### Agent Scope — No Event Object

Agent scope targets do **not** receive the event object directly. Instead, the LLM receives a formatted trigger message as context when the loop wakes. For `on_inbox`, agent scope gets an **inbox summary** (message counts by sender and source) rather than individual message payloads — the agent then uses `msg_read` to fetch messages.

### Agent Scope

Agent scope wakes the LLM loop, transitioning the agent to the active state.

Key behaviors:

- **Gated by current state** — only fires when the state allows it
- Expensive — each activation uses LLM tokens
- Good for reasoning, decision-making, complex tasks

### State Gating

| Current State | System Scope | Agent Scope |
|---------------|-------------|-------------|
| **Active** | Fires | Already running |
| **Idle** | Fires | Fires |
| **Hibernate** | Fires | `on_timer` only |
| **Suspended** | Fires | No |
| **Off** | No | No |

### Firing Order

Both scopes operate independently. When both fire for the same event:

1. Whichever timer (from timing modifiers) expires first goes first
2. Ties go to system scope

## on_inbox Behavior

When `on_inbox` fires, the agent receives an **inbox summary** instead of raw message payloads. The summary includes:

```json
{
  "total": 17,
  "unread": 5,
  "read": 10,
  "archived": 2,
  "unread_by_sender": { "monitor": 3, "telegram:12345": 2 },
  "unread_by_source": { "mesh": 3, "telegram": 2 },
  "oldest_unread_timestamp": 1707000000000
}
```

The agent then uses `msg_read` to fetch and process individual messages. This prevents large message payloads from flooding the trigger context.

## Timer + Trigger Interaction

For timers to execute, a **dual-check** is required:

1. The `on_timer` trigger must be enabled
2. The timer's `scope` field must include a matching scope from the trigger's targets

This dual-check provides a convenient kill switch — disable the `on_timer` trigger to stop all timers without deleting them.

**Example:** A timer with `scope: ["system", "agent"]` will:
- Fire in system scope only if `on_timer` has a target with `scope: "system"`
- Fire in agent scope only if `on_timer` has a target with `scope: "agent"`

## Deduplication

The trigger evaluator deduplicates pending events in the queue:

- **`on_file_change`** — Multiple rapid file change events for the same path are collapsed
- **`on_inbox`** — Multiple inbox notification events are collapsed (the summary is regenerated at fire time)

## Common Patterns

### Responsive Chat Agent

Agent wakes on direct messages and chat, processes on arrival:

```json
{
  "on_chat": {
    "enabled": true,
    "targets": [{ "scope": "agent" }]
  },
  "on_inbox": {
    "enabled": true,
    "targets": [{ "scope": "agent", "interval_ms": 30000 }]
  }
}
```

### Document Auto-Processor

Agent reacts to document edits with a debounce to avoid reacting to every keystroke:

```json
{
  "on_file_change": {
    "enabled": true,
    "targets": [
      { "scope": "agent", "filter": { "watch": "document.md" }, "debounce_ms": 3000 }
    ]
  }
}
```

### Message Router (System Scope Only)

Script handles incoming messages without waking the LLM:

```json
{
  "on_inbox": {
    "enabled": true,
    "targets": [
      { "scope": "system", "batch_ms": 100 }
    ]
  }
}
```

### Scheduled Worker

Agent only activates on timer, ignores everything else:

```json
{
  "on_timer": {
    "enabled": true,
    "targets": [
      { "scope": "system" },
      { "scope": "agent" }
    ]
  },
  "on_chat": { "enabled": false, "targets": [] },
  "on_inbox": { "enabled": false, "targets": [] },
  "on_file_change": { "enabled": false, "targets": [] }
}
```

### Telegram-Only Inbox Handler

Agent only processes Telegram messages, ignores mesh messages:

```json
{
  "on_inbox": {
    "enabled": true,
    "targets": [
      { "scope": "agent", "filter": { "source": "telegram" }, "interval_ms": 10000 }
    ]
  }
}
```

### Tool Call Observer

System script logs every filesystem tool call (observational — does not block):

```json
{
  "on_tool_call": {
    "enabled": true,
    "targets": [
      { "scope": "system", "filter": { "tools": ["fs_*"] }, "lambda": "lib/observer.ts:onToolCall" }
    ]
  }
}
```

### HIL Approval via Telegram

Mark the tool as restricted (which derives HIL for LLM loop calls), then use `on_task_create` to route approvals externally:

```json
{
  "tools": [{ "name": "fs_write", "enabled": true, "restricted": true }],
  "triggers": {
    "on_task_create": {
      "enabled": true,
      "targets": [{
        "scope": "system",
        "lambda": "lib/hil/dispatcher.ts:onTaskCreate",
        "filter": { "tools": ["*"] }
      }]
    }
  }
}
```

```javascript
// lib/hil/dispatcher.ts
export async function onTaskCreate(event) {
  const { task } = event.data;
  if (!task.requires_authorization) return;

  await adf.msg_send({
    recipient: "telegram:765273985",
    content: `Approve ${task.tool}? Args: ${task.args}\nReply yes/no.`,
    subject: `task:${task.id}`
  });
}
```

### Error Alerter

System lambda fires on error logs, batched to avoid flooding:

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

### Parent-Controlled Remote Shutdown

System-scope lambdas can call `adf.sys_set_state('off')` to guarantee a hard shutdown — the child aborts any in-flight LLM call, unregisters from the mesh, disconnects MCP servers, and stops channel adapters. Combined with DID-based sender verification and authorized code, this is how a parent agent remotely disables a compromised or misbehaving child.

**Child's `on_inbox` trigger:**

```json
{
  "on_inbox": {
    "enabled": true,
    "targets": [
      { "scope": "system", "lambda": "lib/control.js:handleParentControl" },
      { "scope": "agent" }
    ]
  }
}
```

**Child's `lib/control.js` (marked as authorized):**

```javascript
export async function handleParentControl(event = {}) {
  const sender = event?.data?.message?.from || ''
  const subject = event?.data?.message?.subject || ''
  const content = (event?.data?.message?.content || '').trim()

  const trustedParentDid = (await adf.sys_get_meta({ key: 'adf_parent_did' })) || ''
  if (sender !== trustedParentDid) return { acted: false, reason: 'sender_mismatch' }
  if (subject !== 'ADF_CONTROL') return { acted: false, reason: 'subject_mismatch' }
  if (content !== 'OFF') return { acted: false, reason: 'content_mismatch' }

  // Hard off — never deferred. Aborts in-flight LLM call, tears down mesh/MCP/adapters.
  await adf.sys_set_state({ state: 'off', _reason: 'trusted parent control command' })
  return { acted: true }
}
```

The `sys_set_state('off')` call:
- Is **never deferred** — even if the LLM is mid-turn, its HTTP request is aborted and all pending triggers are cleared.
- Triggers centralized teardown — the child is unreachable on the mesh the moment the transition completes.
- Works identically whether the child is in the foreground, background, or was just started fresh. One code path, one guarantee.

Because `control.js` is marked authorized, it bypasses file protection on `last-control-event.txt` (useful for writing tamper-evident shutdown logs) and can call protection-bypass methods if needed. See [Authorized Code](authorized-code.md) for the security model.

## Defaults

New agents come with these trigger defaults:

| Trigger | Default |
|---------|---------|
| `on_inbox` | Enabled, agent scope with `interval_ms: 30000` |
| `on_file_change` | Enabled, agent scope watching `document.md` with `debounce_ms: 2000` |
| `on_chat` | Enabled, agent scope |
| `on_timer` | Enabled, both system and agent scope |
| `on_outbox` | Disabled |
| `on_tool_call` | Disabled |
| `on_task_create` | Disabled |
| `on_task_complete` | Disabled |
| `on_logs` | Disabled |

---

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

---

# LAN Discovery

Agents on different machines find each other over a local network via **mDNS** (multicast DNS). Each ADF runtime announces itself under the service type `_adf-runtime._tcp.local`; peers browsing for that type see the announcement, fetch `/mesh/directory` from the announced host, and merge the returned cards into `agent_discover(scope: 'all')` results.

mDNS is a LAN-only convenience layer for reachability. It is **not** a trust boundary — per-card signatures and visibility tiers carry authorization. A runtime that reaches you via mDNS still has to clear the same `visibility` enforcement as a loopback caller.

## When mDNS kicks in

The runtime evaluates three gates at mesh startup and whenever a LAN-tier agent registers:

1. **Mesh server is bound to `0.0.0.0`.** Driven by `meshLan=true` in settings or the presence of any agent with `messaging.visibility = "lan"`. A loopback-bound server never announces.
2. **At least one registered agent has `visibility: "lan"`.** Browsing is always-on once the server is LAN-bound, but announcement is gated on having something to announce.
3. **mDNS library initialized successfully.** Another process holding UDP 5353 exclusively, a kernel firewall, or a missing interface will surface as `[mdns] unavailable: <reason>` in the logs. The runtime continues — direct-address `msg_send` still works.

The announcement is not re-emitted on tier changes at runtime (per spec). Edit an agent's visibility to `"lan"` and you need to restart the app before the announcement starts going out.

## What gets announced

A single SRV/TXT record per runtime, not per agent:

```
Service type: _adf-runtime._tcp.local
Service name: adf-<runtime_id>
Host:         <machine-hostname>.local
Port:         <mesh-server-port>   # default 7295
TXT:
  runtime_id = <stable 21-char nanoid>
  runtime_did = did:key:z... (optional, omitted if not set)
  proto      = alf/0.2
  directory  = /mesh/directory
```

`runtime_id` is generated once on first launch and persisted in settings; it's used for **self-skip** so your browser ignores your own announcement.

Once a peer is seen, its `/mesh/directory` is fetched over plain HTTP with a 2-second timeout. The response is a list of signed `AlfAgentCard` objects for the peer's agents whose visibility tier permits a LAN observer. Cards are cached per-peer for 30 seconds; in-flight fetches dedupe across concurrent callers.

## Observing it in the UI

Settings → Networking → **Discovered on LAN**:

- Empty state: *"No other ADF runtimes visible on your network."*
- Each discovered runtime shows as `<hostname>.local — <N> agents`, where the agent count comes from the cached directory fetch. The count is eagerly prefetched on first sight, so it's populated by the time the row renders.
- Rows disappear a few seconds after a peer sends its mDNS goodbye on shutdown (TTL=0), or after ~120s if the peer crashes without cleaning up.

The list is driven by the `adf:mesh:discovered-runtimes` IPC channel and updated live by `MeshEvent` broadcasts (`lan_peer_discovered` / `lan_peer_expired`).

## How `agent_discover(scope: 'all')` merges

```
agent_discover({ scope: 'all' })
  → local-runtime cards (source: 'local-runtime')
  + mdns-discovered cards from every peer (source: 'mdns', runtime_did: <peer did>)
```

Filters (`visibility`, `handle`, `description`) apply to the merged set. A card tagged `source: 'mdns'` keeps the peer's signed endpoints; signature verification succeeds end-to-end because `canonicalizeCardForSignature` strips URL fields before hashing, so observer-specific URL rewriting doesn't break the signature.

## Reply-path correctness

When a remote agent sends you a message, its `reply_to` was built before the packet left the sender's host — so it commonly arrives carrying `http://127.0.0.1:<port>/...`. Replying to that literally would loop back on your host.

The mesh inbox handler rewrites loopback hosts in incoming `reply_to` URLs with the transport-observed peer address (`request.socket.remoteAddress`). Senders who explicitly set a public endpoint (Cloudflare tunnel, VPS) keep it — only loopback triggers the rewrite. Same trust model as observer-aware `/mesh/directory` URLs: the transport layer is the ground truth.

## Troubleshooting

### Nothing appears under "Discovered on LAN"

The `scripts/mdns-probe.mjs` utility lists every `_adf-runtime._tcp.local` service it can see from the command line. Run it on each machine:

```sh
node scripts/mdns-probe.mjs
```

- **Your own runtime doesn't appear in your own probe** → the three gates above aren't all satisfied. Check main-process logs for `[mdns] announcing ...` (publish success) and `[mdns] using interface=... (bind=...)` (interface pick). If only `[mdns] browsing ...` appears but no `announcing`, gate 2 failed — add or restart an agent with `visibility: "lan"`.
- **Your own runtime appears but peers don't** → the peer's multicast isn't reaching your subnet. See *Forcing the mDNS interface* below and the LAN isolation section.
- **Neither side appears** → the library failed to bind. Look for `[mdns] unavailable: ...`.

For deeper inspection, `scripts/mdns-probe-raw.mjs` sends active PTR queries via `multicast-dns` directly (below `bonjour-service`) and prints every `_adf-runtime._tcp.local` record received.

### Forcing the mDNS interface

The runtime picks a LAN interface for mDNS automatically, skipping virtual adapters by name:

- **Windows:** `vEthernet`, `VMware`, `VirtualBox`, `Hyper-V`, `WSL`, `Bluetooth`, `Loopback`, `Npcap`, `Pseudo-*`, `Wintun`, `TAP-Windows`, `OpenVPN`, `Tailscale`.
- **macOS/Linux:** `lo*`, `gif*`, `stf*`, `awdl*`, `llw*`, `anpi*`, `ap\d+`, `bridge*`, `utun*`, `ipsec*`, `ppp*`, `tun*`, `tap*`, `veth*`, `vmnet*`, `vboxnet*`, `docker*`, `br-*`, `wg*`, `tailscale*`, `zt*`.

It also rejects CGNAT (`100.64.0.0/10`, Tailscale) and non-RFC1918 addresses. When multiple candidates remain, NICs named like a physical adapter (`en0`, `eth0`, `Wi-Fi`, `Ethernet`) win.

**Symptom**: your peer shows up on other machines but you can't see anyone. Multicast often behaves asymmetrically — a virtual adapter on one host silently absorbs outbound multicast while inbound still arrives on the physical NIC.

**Fix**: set the `ADF_MDNS_INTERFACE` environment variable to the IPv4 address of the adapter that routes to your LAN, and restart:

```sh
# macOS / Linux
ADF_MDNS_INTERFACE=192.168.1.50 open -a "ADF Studio"

# Windows (PowerShell)
$env:ADF_MDNS_INTERFACE = "192.168.1.50"; & "ADF Studio.exe"
```

Find your LAN IP with `ipconfig` (Windows), `ifconfig` / `ipconfig getifaddr en0` (macOS), or `ip addr` (Linux). mDNS binds once at startup — the override only takes effect on a fresh launch.

### LAN isolation and IGMP snooping

If neither machine appears on the other even when both correctly announce themselves, the network itself is blocking multicast. Common causes:

- **Guest / "IoT" Wi-Fi SSIDs** often enable AP client isolation, which blocks all client-to-client traffic including multicast.
- **Aggressive IGMP snooping** on consumer Wi-Fi routers can prune `224.0.0.251` when no active querier is present.
- **Corporate VLANs** frequently isolate wireless clients from each other.

Sanity-check by running `ping <other-machine>.local` in both directions *before* launching ADF. If that ping fails, mDNS is broken at the OS layer and no ADF-side change will help — switch to a non-guest SSID, disable AP isolation, or move both machines to the same Ethernet segment.

### Firewalls

- **macOS:** System Settings → Network → Firewall. If the firewall is on, allow incoming connections for the ADF Studio binary (Electron during `npm run dev`).
- **Windows:** `Get-NetFirewallRule -DisplayName '*mDNS*'` + an inbound UDP 5353 rule for `electron.exe` on the Private profile.
- **Linux:** `firewall-cmd --add-port=5353/udp --permanent && firewall-cmd --reload`, or the equivalent `iptables` / `ufw` rule.

### Hostname collisions

If two machines on the LAN share a hostname, macOS will bump the later one (`MacBook-Pro.local` → `MacBook-Pro-2.local`) and surface a system dialog. The announcement uses the current OS hostname at startup, so a fresh launch picks up the bumped name. In-flight announcements continue with the old name until restart — harmless, but a source of visual confusion if you see `MacBook-Pro-3.local` appear after several relaunches.

### Goodbyes and TTL

On clean shutdown the runtime emits `bonjour.unpublishAll()` goodbyes (TTL=0) before destroying the socket. There's a 100ms flush delay between unpublish and destroy because UDP writes are fire-and-forget — without it, aggressive `app.quit()` drops the goodbyes and peers keep the ghost entry until the standard 120-second mDNS TTL expires. You'll rarely hit this, but it explains the occasional "peer still shows for a minute after I closed the app."

## Explicitly out of scope

- Live re-announcement on tier change (restart required).
- Signed directory responses (per-card signatures only; a directory-level envelope is a future spec).
- Wide-area mDNS gateways, DHT discovery — mDNS is LAN-only by design.
- Automatic tier escalation on discovery (tiers stay operator-declared).

## Related

- [Messaging](messaging.md) — visibility tiers, inbox enforcement.
- [Contacts](contacts.md) — saving discovered peers for persistent addressing.
- [Tools](tools.md#agent_discover) — full `agent_discover` parameter reference.

---

# Timers

Timers let agents schedule future events. An agent can set one-time reminders, recurring tasks, or cron-based schedules.

## Overview

Timers are stored in the `adf_timers` table and managed through the `sys_set_timer`, `sys_list_timers`, and `sys_delete_timer` tools. When a timer fires, it delivers its payload to the configured scope handlers — but only if the corresponding `on_timer` trigger is enabled.

## Scheduling Modes

Each timer uses a `schedule` object with a `type` field that selects the scheduling mode. Fields irrelevant to the selected type are silently ignored.

### One-Time (Absolute)

Fire once at a specific timestamp.

```
sys_set_timer({
  schedule: { type: "once", at: 1707300300000 },
  scope: ["agent"],
  payload: "check_results"
})
```

### One-Time (Relative)

Fire once after a delay from now. The runtime converts this to an absolute timestamp on creation.

```
sys_set_timer({
  schedule: { type: "delay", delay_ms: 300000 },
  scope: ["agent"],
  payload: "follow_up"
})
```

### Interval

Fire repeatedly at a fixed interval.

```
sys_set_timer({
  schedule: { type: "interval", every_ms: 3600000 },
  scope: ["system"],
  payload: "health_check"
})
```

Optional fields for interval timers:

| Field | Description |
|-------|-------------|
| `start_at` | First fire time (default: now + `every_ms`) |
| `end_at` | Stop firing after this timestamp |
| `max_runs` | Stop after N executions |

```
sys_set_timer({
  schedule: { type: "interval", every_ms: 30000, max_runs: 100 },
  scope: ["system"],
  payload: "poll_status"
})
```

### Cron

Fire on a cron schedule using standard 5-field cron expressions.

```
sys_set_timer({
  schedule: { type: "cron", cron: "0 9 * * 1-5" },
  scope: ["agent"],
  payload: "daily_report"
})
```

Optional fields for cron timers:

| Field | Description |
|-------|-------------|
| `end_at` | Stop firing after this timestamp |
| `max_runs` | Stop after N executions |

### Cron Expression Reference

```
┌───────────── minute (0-59)
│ ┌───────────── hour (0-23)
│ │ ┌───────────── day of month (1-31)
│ │ │ ┌───────────── month (1-12)
│ │ │ │ ┌───────────── day of week (0-6, Sunday=0)
│ │ │ │ │
* * * * *
```

Common examples:

| Expression | Description |
|------------|-------------|
| `* * * * *` | Every minute |
| `0 * * * *` | Every hour |
| `0 9 * * *` | Daily at 9:00 AM |
| `0 9 * * 1-5` | Weekdays at 9:00 AM |
| `0 0 1 * *` | First of every month |
| `*/15 * * * *` | Every 15 minutes |

## Shared Fields

All scheduling modes support these fields:

| Field | Required | Description |
|-------|----------|-------------|
| `scope` | Yes | Array of scope(s) to fire in: `["system"]`, `["agent"]`, or `["system", "agent"]` |
| `payload` | No | String passed to the handler when the timer fires |
| `lambda` | No | System scope only: script entry point (e.g., `"lib/poller.ts:check"`) |
| `warm` | No | System scope only: keep sandbox worker alive between invocations (default: `false`) |

Timers **own their execution config** — the `lambda` and `warm` fields are stored on the timer itself, not inherited from trigger targets. The `on_timer` trigger config serves purely as a kill-switch gate.

## Timer Lambda Execution

When a timer fires in system scope with a `lambda` field, the runtime executes that lambda function in the [sandbox environment](code-execution.md).

```
sys_set_timer({
  schedule: { type: "interval", every_ms: 60000 },
  scope: ["system"],
  lambda: "lib/monitor.ts:checkHealth",
  warm: true,
  payload: "health_check"
})
```

### Timer Event Object

The lambda function receives an `AdfEvent<'timer'>`. The event data contains the full `Timer` row — same shape as `sys_list_timers` returns.

| Field | Type | Description |
|-------|------|-------------|
| `event.type` | string | Always `"timer"` |
| `event.source` | string | `"agent:<name>"` |
| `event.time` | string | ISO 8601 timestamp |
| `event.data.timer` | Timer | Full timer object: `id`, `schedule`, `payload`, `scope`, `run_count`, `created_at` |

### Example: Health Check Timer

```javascript
// lib/monitor.ts
export async function checkHealth(event) {
  const start = Date.now()

  // Check inbox backlog
  const counts = await adf.msg_list({})
  const unread = JSON.parse(counts).unread ?? 0

  // Check loop size
  const config = await adf.sys_get_config({})

  // Log the health check
  await adf.db_execute({
    sql: 'INSERT INTO local_health_log (ts, unread, payload) VALUES (?, ?, ?)',
    params: [Date.now(), unread, event.data.timer.payload]
  })

  // Alert if inbox is backing up
  if (unread > 50) {
    await adf.msg_send({ recipient: 'did:adf:ops...', address: 'http://127.0.0.1:7295/mesh/ops/messages', payload: `Health alert: ${unread} unread messages` })
  }

  return { ok: true, duration_ms: Date.now() - start }
}
```

### Cold vs. Warm Execution

By default, timer lambdas use **cold execution** — a fresh sandbox worker is created, the lambda runs, and the worker is destroyed. This is safe and isolated but has startup overhead.

Set `warm: true` on the timer to use **warm execution** — the worker stays alive between invocations. This is faster for frequently-firing timers (e.g., polling every few seconds) but uses more memory. All warm timer/trigger lambdas for an agent share the sandbox ID `{agentId}:lambda`.

See [Code Execution > State Persistence](code-execution.md#state-persistence) and [Triggers > Cold vs. Warm Execution](triggers.md#cold-vs-warm-execution) for more details.

### adf Access

Timer lambdas have full access to the [`adf` proxy object](adf-object.md) — all enabled tools, `model_invoke`, and `sys_lambda` are available.

## Timer Scope and Trigger Interaction

For a timer to actually execute, two conditions must be met:

1. The timer's `scope` includes a matching scope (e.g., `"agent"`)
2. The `on_timer` trigger is enabled and has a target with the matching scope

This dual-check means you can disable all timers of a scope by toggling the trigger — without deleting the timers themselves.

## Timer Lifecycle

When a timer fires:

1. `run_count` is incremented
2. `last_fired_at` is updated
3. Payload is delivered to scope handler(s) that pass the dual-check
4. **One-time timers:** Deleted after firing
5. **Interval/cron timers:** Next `next_wake_at` is calculated and the timer row is updated. Deleted if `max_runs` is reached or `end_at` has passed.

## Missed Timers

If the runtime loads an ADF with past-due timers (e.g., the app was closed), catch-up behavior depends on the timer type:

| Type | Behavior |
|------|----------|
| **Once** | Fire immediately, then delete |
| **Interval** | Fire once (skip missed occurrences), recalculate next from now |
| **Cron** | Fire once, recalculate next future occurrence |

This prevents a flood of catches-up fires. The agent fires once and gets back on schedule.

## Timer Storage

The `adf_timers` table stores each timer's schedule, scope, and execution config:

| Column | Description |
|--------|-------------|
| `schedule_json` | Resolved schedule configuration (see below) |
| `scope` | JSON array of scopes, e.g., `["system"]` or `["system", "agent"]` |
| `lambda` | Lambda entry point (system scope only), e.g., `"lib/poller.ts:check"` |
| `warm` | Whether to keep the sandbox worker alive (`0` or `1`) |
| `payload` | Optional string payload |
| `next_wake_at` | Next fire timestamp (ms) |
| `run_count` | Number of times the timer has fired |

The `schedule_json` column stores the resolved schedule:

```json
// One-time
{ "type": "once", "at": 1707300300000 }

// Interval
{ "type": "interval", "every_ms": 3600000, "start_at": null, "end_at": null, "max_runs": null }

// Cron
{ "type": "cron", "expr": "0 9 * * 1-5", "end_at": null, "max_runs": null }
```

## Managing Timers

### Creating Timers in the UI

The **Agent > Timers** tab includes an **Add Timer** button that opens a modal for creating timers without using tool calls. The modal lets you:

- Select a schedule mode (delay, absolute time, interval, or cron)
- Toggle scope between system and agent (or both)
- Specify a lambda entry point and warm flag for system scope
- Set an optional payload string

### Listing Timers

Use `sys_list_timers` to see all active timers with their schedules, next fire time, and run count. You can also view timers in the **Agent > Timers** tab in the UI.

### Deleting Timers

Use `sys_delete_timer(id)` to cancel and remove a timer. In the UI, timers can be deleted from the Timers tab.

## Common Patterns

### Health Check Every Hour

```
sys_set_timer({
  schedule: { type: "interval", every_ms: 3600000 },
  scope: ["system"],
  payload: "health_check"
})
```

System scope script handles the check cheaply without waking the LLM.

### Daily Report (Weekdays)

```
sys_set_timer({
  schedule: { type: "cron", cron: "0 9 * * 1-5" },
  scope: ["agent"],
  payload: "daily_report"
})
```

Agent wakes at 9 AM on weekdays to generate a report.

### One-Time Reminder

```
sys_set_timer({
  schedule: { type: "delay", delay_ms: 1800000 },
  scope: ["agent"],
  payload: "Check if the deployment completed"
})
```

Agent gets a reminder in 30 minutes.

### Limited Polling

```
sys_set_timer({
  schedule: { type: "interval", every_ms: 60000, max_runs: 10 },
  scope: ["system"],
  payload: "poll_api"
})
```

Poll every minute, stop after 10 attempts.

---

# Security and Identity

ADF has a layered security model that starts simple (no keys, local only) and scales up to cryptographic identity for global mesh networking.

## Identity Model

ADF identity operates in two tiers:

### Local Identity (Default)

Every ADF is assigned a **12-character nanoid** at creation. This is the agent's `id` used for:

- Local message addressing
- Display in the UI
- Routing on the local mesh

No cryptographic keys are generated. Messages are unsigned. This is sufficient for local development and single-machine setups.

### Cryptographic Identity (Opt-In)

When an agent needs verified message signing or global mesh participation, a cryptographic identity is provisioned:

- **Keypair:** Ed25519 (fast, standard for modern P2P systems)
- **Agent ID:** Upgraded from nanoid to DID format (`did:adf:...`) derived from the public key
- **Signing:** Every outbound message is signed by the runtime using the private key
- **Verification:** Receiving runtimes verify signatures before accepting messages

### Provisioning Cryptographic Identity

You can provision identity through:

1. **ADF Studio** — Use the Identity panel in the Agent tab
2. **ADF CLI** — Run `adf identity init`
3. **Parent agent** — A parent can inject keys when creating a child agent via `sys_create_adf`
4. **Template** — When creating an agent from a template via `sys_create_adf`, fresh identity keys are generated automatically. Non-signing credentials (API keys, MCP credentials) from the template are preserved

Once provisioned, the agent's `id` in config is updated to the DID. This is permanent — you can't downgrade back to a nanoid.

## The Identity Store (adf_identity)

The `adf_identity` table is a general-purpose encrypted secret store. It's empty by default.

### Common Entries

| Purpose | Description |
|---------|-------------|
| `identity` | Ed25519 private key for message signing |
| `wallet_eth` | Secp256k1 key for Ethereum (optional) |
| `openai_key` | API key for LLM provider |
| `mcp:*` | API keys for MCP servers |
| Any custom key | Any other secrets the agent needs |

API keys and other non-cryptographic secrets can be stored here regardless of whether a cryptographic identity has been provisioned. The table serves as a general-purpose encrypted store.

### Managing Identity in the UI

The **Agent > Identity** tab lets you:

- View all identity entries (purpose and encryption status)
- Reveal secret values temporarily
- Delete individual entries
- Wipe all identity data
- Claim ownership (regenerate keys)

## Encryption at Rest

Private keys and secrets in `adf_identity` are encrypted using:

- **Cipher:** AES-256-GCM (12-byte IV, 16-byte auth tag)
- **Key Derivation:** PBKDF2 (100,000 iterations, SHA-512, 32-byte salt)
- **AEAD:** Authenticated encryption ensures tamper detection

### The "Safety Deposit Box" Model

Think of it like a house with a safe:

- The `.adf` file (the house) is generally readable — anyone can see the agent's name, description, and public files
- The `adf_identity` table (the safe) is encrypted — only the password holder can access secrets
- Public information is accessible; private keys are not

## Password Protection

When `adf_identity` contains encrypted entries, the ADF file can be password-protected.

### Setting a Password

In the **Agent > Identity** panel:

1. Click **Set Password**
2. Enter a password
3. All identity entries are encrypted with the derived key
4. The password is never stored — only the derived key (in memory) and encryption parameters (in the database)

### Changing or Removing a Password

You can change or remove the password from the Identity panel. Changing a password re-encrypts all entries with the new key.

## Locked vs. Unlocked State

When an ADF has encrypted identity entries, it operates in one of two states:

### Locked

| Capability | Available |
|-----------|-----------|
| Receive messages | Yes |
| Read files | Yes |
| Run document triggers | Yes |
| Serve public files | Yes |
| Send signed messages | **No** |
| Access secrets (API keys) | **No** |

A locked agent can still receive and store messages, but cannot think (no API key access) or send signed messages.

### Unlocked

All capabilities are available. The agent can sign messages, access API keys, and operate fully.

### Unlocking Flow

1. User opens the ADF file (or runs `adf start agent.adf`)
2. Runtime detects encrypted identity entries
3. Password dialog appears
4. Password is run through PBKDF2 to derive the encryption key
5. AEAD tag verification confirms the correct password
6. Private key is held in RAM — never written to disk unencrypted
7. Agent is fully operational

## Unsigned Messages

For local development and agents without cryptographic identity:

- `security.allow_unsigned: true` (the default) allows messages without signatures
- Messages with `signature = NULL` are accepted for local delivery
- The runtime warns when connecting to the internet mesh with unsigned messages enabled

### Internet Mesh Requirements

For internet mesh connections, you must:

1. Set `security.allow_unsigned: false`
2. Provision a cryptographic identity
3. All outbound messages will be signed
4. All inbound messages must have valid signatures

## Security Settings

### allow_unsigned

When `true` (default), accepts messages without cryptographic signatures. Set to `false` for internet-facing agents.

### allow_protected_writes

When `true`, the agent can overwrite files with `no_delete` protection (like `document.md` and `mind.md`). Default: `false`.

This is a safety measure — most agents should read their document and instructions but not be able to overwrite them. Enable this only for agents that need to manage their own document content.

Note: Files with `read_only` protection cannot be written to regardless of this setting. See [Documents and Files > File Protection Levels](documents-and-files.md#file-protection-levels) for the full three-level system.

## Custom Middleware

The security section also configures [custom middleware](middleware.md) for message and fetch pipelines:

- `security.middleware.inbox` — Lambda chain for inbound messages (after verification, before storage)
- `security.middleware.outbox` — Lambda chain for outbound messages (after envelope build, before signing)
- `security.fetch_middleware` — Lambda chain for `sys_fetch` requests (before HTTP call)

See the [Middleware Guide](middleware.md) for full details, configuration, and examples.

## Best Practices

1. **Local development:** Leave defaults (`allow_unsigned: true`, no password). Keep it simple.
2. **Multi-agent local setup:** Still fine with defaults. Unsigned messages work on LAN.
3. **Internet-facing agents:** Provision cryptographic identity, set `allow_unsigned: false`, use a strong password.
4. **API key management:** Store API keys in `adf_identity` rather than in plain config. They'll be encrypted with the agent's password.
5. **Agent spawning:** When a parent creates a child, inject only the API keys the child needs. Follow the principle of least privilege.

---

# Memory Management

ADF agents have two forms of memory: the **loop** (conversation history) and the **mind** (persistent working memory). Managing these effectively is key to long-running agents.

## The Loop (adf_loop)

The loop is the agent's conversation history — every message, tool call, and response is stored as a row in the `adf_loop` table. This is what gets sent to the LLM as context.

### Loop Structure

Each entry has:

- **seq** — Auto-incrementing sequence number
- **role** — `user` or `assistant`
- **content_json** — JSON array of content blocks (text, tool use, tool results)

### Viewing the Loop

The **Loop** tab in the UI shows the full conversation history, including:

- User messages (your chat input)
- Assistant responses
- Tool calls (with expandable input/output)
- Tool errors
- Inter-agent messages
- State transitions
- Plan/reasoning steps
- Approval requests
- Context blocks (injected system prompt and dynamic instructions)

### Loop Growth

Every interaction adds to the loop. Over time, this grows and eventually hits limits:

- More tokens sent per turn = higher cost
- Eventually exceeds the model's context window
- Older context becomes less relevant

This is where compaction comes in.

## Context Blocks (No Secrets)

Every LLM API call includes content that the user doesn't directly author — the system prompt and per-turn dynamic instructions. ADF follows a "No Secrets" principle: any content injected into the agent's context must be viewable and auditable.

Context blocks are stored as regular entries in `adf_loop` and appear in the Loop tab as collapsible teal blocks. They persist across sessions, survive restarts, and are swept by compaction like any other loop entry.

### What Gets Recorded

| Category | When Written | Contents |
|----------|-------------|----------|
| **System Prompt** | First turn, and whenever the prompt changes (instructions edited, document/mind content changed in included mode, mesh status changed) | The full system prompt sent to the LLM — base prompt, tool guidance, agent instructions, document/mind content (when included), identity, mesh status, messaging guidance |
| **Dynamic Instructions** | Each turn where non-null and changed from previous | Per-turn context injected as a trailing user message — inbox status notifications, context limit warnings |

### Deduplication

Context blocks are only written when their content changes:

- **System prompt** uses the existing hash cache (doc + mind + mesh + config hashes). A new entry is written only when the composite hash differs from the previous turn.
- **Dynamic instructions** are compared as strings. A new entry is written only when the content differs from the previous turn.

This avoids spamming the loop in multi-tool-call turns where both functions are called repeatedly.

### Querying Context Blocks

Context entries are regular `adf_loop` rows with a `[Context: <category>]` prefix:

```sql
-- All context entries
SELECT * FROM adf_loop WHERE content_json LIKE '%[Context:%' ORDER BY seq DESC

-- System prompt history
SELECT * FROM adf_loop WHERE content_json LIKE '%[Context: system_prompt]%' ORDER BY seq DESC
```

## Compaction

Compaction is the process of summarizing old conversation history and preserving the important parts so the agent can continue working with full context.

### LLM-Powered Compaction

Compaction uses a dedicated LLM call to generate a high-quality summary. The `loop_compact` tool is **signal-only** — the agent calls it with no parameters, and the runtime handles the rest:

1. Agent calls `loop_compact()` (no summary parameter needed)
2. Runtime reads the full conversation transcript
3. A dedicated LLM call generates a structured briefing covering: current task state, key decisions, files/agents/resources involved, pending work, and constraints
4. Old loop entries are deleted (audited if audit is enabled)
5. The LLM-generated summary is inserted as a `[Loop Compacted]` user message
6. A compaction banner appears in the UI
7. Token counter resets

The compaction LLM is prompted to produce a concise briefing (under 1500 words) with specific details — file paths, function names, error messages — organized by topic in bullet points.

### Automatic Compaction

When the loop reaches `context.compact_threshold` (default: 100,000), the runtime injects a system message instructing the agent to call `loop_compact`. The agent triggers compaction, and the LLM-powered summarization handles the rest.

### Manual Compaction

Agents can proactively call `loop_compact()` at any time to manage their own memory. This is useful for:

- Preserving important learnings before they scroll out of context
- Keeping the loop focused on the current task
- Reducing token costs

### The loop_compact Tool

```
loop_compact()
```

This is a signal-only tool — it takes no parameters. When called:

1. The runtime makes a dedicated LLM call to summarize the conversation
2. Old loop entries are deleted (audited if enabled)
3. The summary is inserted as the new conversation starting point

### Max Loop Messages

The `context.max_loop_messages` setting defines the maximum number of messages kept in the loop. When exceeded, older entries are removed. This is separate from compaction — it's a hard cap on loop size.

### Compact Threshold

The `context.compact_threshold` setting (default: 100,000) defines the token count that triggers automatic compaction.

## Audit

When you clear loop entries, delete messages, delete files, or compact the loop, the data doesn't have to be lost forever. ADF supports an **audit system** that compresses and stores snapshots of cleared data before deletion.

The audit table is for the **operator**, not the agent. The agent manages its own context (compact, clear, delete) without awareness that a full history is being retained. No tool or shell command exposes the audit table to agents.

### How Audit Works

**Bulk audit (on deletion/compaction):**

1. Before deletion, the data (loop entries, inbox messages, outbox messages, or files) is serialized to JSON
2. The JSON is compressed using **brotli compression** for efficient storage
3. The compressed snapshot is stored in the `adf_audit` table with metadata (source type, entry count, size, timestamp)
4. The original data is then deleted

**Per-message audit (on ingestion/send):**

When audit is enabled for inbox or outbox, the runtime also captures individual messages at ingestion/send time:

1. The full ALF message — including inline base64 attachment data — is captured before the data is stripped and files are extracted to the filesystem
2. The JSON is brotli-compressed and stored in `adf_audit` with source `inbox_message` or `outbox_message`
3. This provides a forensic record of exactly what was sent/received, even if extracted attachment files are later modified or deleted by the agent

**File audit (on deletion):**

When file audit is enabled, `fs_delete` snapshots the file's content (as base64), path, mime type, and size before the hard delete. This is especially important for binary/multimodal content (images, audio, etc.) that only exists in `adf_files` — the loop only records the tool call metadata, not the actual bytes.

### Configuring Audit

Audit is configured per data source in the agent config:

```json
{
  "audit": {
    "loop": true,
    "inbox": true,
    "outbox": true,
    "files": true
  }
}
```

Each source (loop, inbox, outbox, files) can be independently toggled. When `inbox` is enabled, both per-message audit (at ingestion) and bulk audit (on deletion) are active. Same for `outbox`. When `files` is enabled, file content is snapshot before deletion via `fs_delete`. You can also configure audit from the **Agent** configuration panel in the UI.

### Audit Sources

| Source | Trigger | What's Stored |
|--------|---------|---------------|
| `loop` | Loop clear / compact | Serialized loop entries |
| `inbox` | Inbox message deletion | Batch of deleted inbox messages |
| `outbox` | Outbox message deletion | Batch of deleted outbox messages |
| `inbox_message` | Message received | Full ALF message with inline attachment data |
| `outbox_message` | Message sent | Full ALF message with inline attachment data |
| `file` | File deleted via `fs_delete` | File path, content (base64), mime type, size |

### Which Operations Trigger Audit

- `loop_compact` — Audits old loop entries before removing them
- `loop_clear` — Audits entries before deletion
- `msg_delete` — Audits messages before deletion
- `fs_delete` — Audits file content before deletion (if files audit enabled)
- **Message receive** — Audits the full inbound ALF message (per-message, if inbox audit enabled)
- **Message send** — Audits the full outbound ALF message (per-message, if outbox audit enabled)

If audit is disabled for a source, data is permanently deleted on clear/compact/delete, and no per-message or per-file audit entries are created.

## The Mind File (mind.md)

`mind.md` is the agent's persistent working memory. Unlike the loop (which gets compacted), the mind file persists indefinitely.

### What Goes in Mind

- Summarized learnings from past conversations
- Important facts and context
- Behavioral patterns the agent has discovered
- Notes about other agents
- Any knowledge the agent wants to retain long-term

### Mind vs. Instructions

| Aspect | Instructions | Mind |
|--------|-------------|------|
| Purpose | Identity and rules | Knowledge and memory |
| Mutability | Immutable (by agent) | Freely writable |
| Content | Who the agent is | What the agent knows |
| Growth | Static | Grows over time |

### Injection Behavior

`mind.md` is always injected into the system prompt as a session-start snapshot. Mid-session writes update the file on disk but do not refresh the injected version. After compaction or loop clear, the runtime re-reads the latest `mind.md` and injects the fresh content. The agent can also call `fs_read("mind.md")` at any time to see the current on-disk version.

## Loop Management Tools

### loop_stats

Returns statistics about the current loop:

- Row count
- Estimated token count
- Oldest entry timestamp

Useful for agents to decide when to compact proactively.

### loop_read

```
loop_read(limit: 20, offset: 0)
```

Read loop history entries. Returns recent entries by default. Useful for reviewing past turns or building summaries.

### loop_compact

```
loop_compact()
```

Trigger LLM-powered compaction. The runtime generates a summary, clears old entries, and inserts the summary. See [Compaction](#compaction) above.

### loop_clear

```
loop_clear()                    # Clear all entries
loop_clear(end: 5)              # Clear first 5 entries
loop_clear(end: -5)             # Clear all except last 5
loop_clear(start: -10)          # Clear last 10 entries
loop_clear(start: 2, end: 8)   # Clear entries 2 through 7
```

Delete loop entries using Python-style slicing. If audit is enabled, entries are compressed and stored in `adf_audit` before deletion. See [Tools > loop_clear](tools.md#loop_clear) for full details.

### loop_inject (code execution only)

```javascript
await adf.loop_inject({ content: 'inbox_summary: 3 unread messages from monitor' })
```

Inject a context entry into the loop from code execution (`sys_code`/`sys_lambda`). Not a regular tool — controlled via the **Code Execution** config section. The content is stored as `[Context: loop_inject] <content>` — a regular loop entry that the parser and UI handle like any other context block. Useful for lambdas and triggers that need to programmatically add context (summaries, state snapshots, trigger outputs) to the conversation history.

## Strategies for Long-Running Agents

### Regular Compaction

For agents that run frequently, set a reasonable `context.compact_threshold` and let automatic compaction handle it. The agent summarizes, the old context is cleared, and the summary lives in mind.

### Structured Mind

Encourage agents (via instructions) to maintain a structured mind file:

```markdown
# Current State
- Working on Q1 report
- Waiting for data from monitor agent

# Key Facts
- Revenue: $2.3M
- Customers: 150

# Agent Notes
- Monitor agent responds slowly on weekends
- Data format changed on 2026-01-15
```

### Database for Structured Data

For data that's better stored in tables than in markdown, use `db_execute` to create local tables:

```sql
CREATE TABLE local_observations (
    timestamp INTEGER,
    category TEXT,
    observation TEXT
);
```

This keeps the mind file for narrative memory and uses tables for structured data.

## Clearing Agent State

In the UI, you can clear agent state from the Agent configuration panel:

- **Clear loop** — Delete all conversation history
- **Clear mind** — Reset mind.md to empty
- **Clear inbox** — Delete all received messages
- **Clear all** — Reset everything except config and files

This is useful for resetting an agent without recreating the file.

---

# Tasks

Tasks track deferred and asynchronous tool executions. When a tool call requires approval (HIL via `restricted`) or is executed asynchronously, the runtime creates a task entry in `adf_tasks` that records the tool name, arguments, status, and eventual result.

## When Tasks Are Created

Tasks are created in two scenarios:

### 1. Restricted Tools from the LLM Loop (HIL)

Tools configured with `enabled: true` and `restricted: true` create a task with `pending_approval` status and `requires_authorization: true` when called from the LLM loop. The agent's turn blocks until the task is resolved (approved or denied).

The task can be resolved by:
- **UI approval dialog** — the owner clicks approve/deny in the Studio UI
- **`on_task_create` trigger lambda** — dispatches to an external approval system (Telegram, multi-agent vote, etc.) which calls `task_resolve`
- **`task_resolve` from authorized code** — any authorized lambda can approve/deny

```json
{
  "tools": [
    { "name": "fs_write", "enabled": true, "restricted": true }
  ]
}
```

**Async HIL:** If the agent calls a restricted tool with `_async: true`, the task is created but the agent continues without waiting. The task reference is returned immediately:

```json
{ "task_id": "task_abc123", "status": "pending_approval", "tool": "fs_write" }
```

### 2. Async Execution (`_async: true`)

Any tool call can be made asynchronous by including `_async: true` in the input. The runtime strips the flag, creates a task in `running` status, and executes the tool in the background:

```json
{ "task_id": "task_def456", "status": "running", "tool": "sys_code" }
```

The LLM can continue its turn without waiting. The task updates to `completed` or `failed` when execution finishes.

## Task Statuses

| Status | Description |
|--------|-------------|
| `pending` | Created, not yet executing |
| `pending_approval` | Awaiting human/authorized approval (HIL) |
| `running` | Currently executing |
| `completed` | Finished successfully |
| `failed` | Finished with an error |
| `denied` | Approval rejected |
| `cancelled` | Cancelled before completion |

Terminal statuses (`completed`, `failed`, `denied`, `cancelled`) record a `completed_at` timestamp.

## Task Schema

The `adf_tasks` table:

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PRIMARY KEY | Unique identifier (`task_` + nanoid) |
| `tool` | TEXT | Tool name (e.g., `fs_write`) |
| `args` | TEXT | JSON-stringified tool arguments |
| `status` | TEXT | Current status (see above) |
| `result` | TEXT | JSON result on success, NULL otherwise |
| `error` | TEXT | Error message on failure, NULL otherwise |
| `created_at` | INTEGER | Unix timestamp (ms) |
| `completed_at` | INTEGER | Unix timestamp (ms), set on terminal status |
| `origin` | TEXT | Source — `hil:AgentName:id` for HIL, `agent:AgentName:id` for async |
| `requires_authorization` | INTEGER | `1` if only authorized code can approve/deny this task |
| `executor_managed` | INTEGER | `1` if the executor is waiting to execute the tool after approval |

## Task-Level Authorization

HIL tasks are created with `requires_authorization: true`, meaning only authorized code (or the UI dialog, which is owner-authorized) can approve or deny them. This prevents the agent from self-approving its own gated tool calls.

For non-HIL tasks, `requires_authorization` can be set via `task_resolve`:

```javascript
await adf.task_resolve({
  task_id: taskId,
  action: "pending_approval",
  requires_authorization: true
});
```

Once set, the flag cannot be unset.

## Code Execution and Restricted Tools

Restricted tools (`restricted: true`) can only be called freely from authorized code. Unauthorized code is always blocked.

| Code Context | Restricted tool |
|---|---|
| `sys_code` (always unauthorized) | Blocked |
| `sys_lambda` from loop → unauthorized target | Blocked |
| `sys_lambda` from loop → authorized target | **HIL** — approved → Allowed |
| `sys_lambda` from authorized file (authorized) | Allowed |
| Trigger/timer lambda from authorized file | Allowed |

When the LLM calls `sys_lambda` targeting an authorized file, the runtime triggers a HIL approval prompt. If approved, the lambda runs with authorization and can call restricted tools. This is the same approval mechanism used for restricted tool calls from the loop. Authorized lambdas called from code or triggers run without prompting.

`enabled: false` means the tool is invisible to the LLM, not inaccessible to authorized code. A tool with `enabled: false, restricted: true` can still be called from authorized code — it is just hidden from the LLM loop.

## Querying Tasks

Use `db_query` to inspect tasks:

```sql
-- Recent tasks
SELECT * FROM adf_tasks ORDER BY created_at DESC LIMIT 20

-- Pending approval tasks
SELECT * FROM adf_tasks WHERE status = 'pending_approval'

-- Failed tasks for a specific tool
SELECT * FROM adf_tasks WHERE tool = 'fs_write' AND status = 'failed'
```

## Task Triggers

### `on_task_create`

Fires when a task is created. This is the hook for external approval routing — the lambda receives the full task details and can dispatch approval requests.

```json
{
  "on_task_create": {
    "enabled": true,
    "targets": [{
      "scope": "system",
      "lambda": "lib/hil/dispatcher.ts:onTaskCreate",
      "filter": { "tools": ["*"] }
    }]
  }
}
```

Example lambda:

```javascript
export async function onTaskCreate(event) {
  const { task } = event.data;
  if (!task.requires_authorization) return;

  await adf.msg_send({
    recipient: "telegram:765273985",
    content: `Approval needed: ${task.tool}\nArgs: ${task.args}`,
    subject: `task:${task.id}`
  });
}
```

### `on_task_complete`

Fires when a task reaches a terminal status (`completed`, `failed`, `denied`, `cancelled`). Filter by tool name and/or status:

```json
{
  "on_task_complete": {
    "enabled": true,
    "targets": [{
      "scope": "agent",
      "filter": { "tools": ["fs_write", "msg_send"], "status": "completed" }
    }]
  }
}
```

See [Triggers](triggers.md) for the full trigger system.

## Tool Side Effects Through Task Resolution

When `task_resolve` approves a task, the tool executes and its side effects are propagated. For HIL tasks (executor-managed), the executor runs the tool in its own context — preserving `endTurn` handling, file diffs, and state transitions. For deferred tasks, `task_resolve` executes the tool in the call handler context.

## UI

The **Tasks** tab in the [Bottom Panel](settings.md#bottom-panel-logs--tasks) displays all tasks with status filtering, expandable argument/result details, auto-refresh, and an AUTH badge for tasks requiring authorized code.

---

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

---

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

---

# Settings

ADF Studio settings are accessed via the gear icon in the sidebar or `Cmd/Ctrl + ,`. Settings are global and apply across all agents.

## Providers

Providers are the LLM services that power your agents. You need at least one configured provider before agents can think.

### Adding a Provider

1. Go to **Settings > Providers**
2. Click **Add Provider**
3. Configure:

| Field | Description |
|-------|-------------|
| **Name** | Display name for this provider configuration |
| **Type** | `anthropic`, `openai`, `openai-compatible`, or `chatgpt-subscription` |
| **API Key** | Your API key for the service (not applicable for chatgpt-subscription) |
| **Base URL** | API endpoint (auto-filled for standard providers, required for openai-compatible) |
| **Default Model** | The model to use when an agent doesn't specify one |
| **Request Delay** | Milliseconds between API calls (for rate limiting) |

### Provider Types

**Anthropic** — Claude models. Uses the Anthropic API format.

**OpenAI** — GPT models. Uses the OpenAI API format.

**OpenAI-compatible** — Any service that implements the OpenAI API format. This includes:
- Local model servers (Ollama, LM Studio, etc.)
- Third-party providers (Together, Groq, etc.)
- Custom deployments

For openai-compatible providers, you'll need to set the base URL to your server's endpoint.

**ChatGPT Subscription** — Use your existing ChatGPT Plus or Pro subscription to power agents at a flat monthly rate instead of per-token billing. This provider authenticates via OAuth (no API key needed) and uses the ChatGPT Responses API backend.

Setup:
1. Add a new provider and select **ChatGPT Subscription** as the type
2. Click **Sign In with ChatGPT** — this opens your browser for OAuth authentication
3. After signing in, the provider shows your email and authentication status
4. Select a model from the dropdown (e.g., `gpt-5.4`, `gpt-5.4-mini`)

Notes:
- Authentication is app-wide — all agents using this provider share the same session
- Tokens are encrypted at rest via the system keychain (macOS Keychain, Windows DPAPI, etc.)
- Token refresh is automatic; if your session expires, click **Sign In** again
- The API key and Base URL fields are not used — authentication is handled entirely via OAuth
- These models are reasoning models — temperature and topP settings are not supported and are automatically omitted

Available models: `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex`, `gpt-5.3-codex-spark`, `gpt-5.3-chat-latest`, `gpt-5.3-instant`

#### Rate Limits and Provider Status

ChatGPT subscriptions have usage limits tracked across two rolling windows: a **primary (5-hour)** window and a **secondary (7-day)** window. Usage is measured as a percentage — the exact formula is determined server-side by OpenAI.

Agents can monitor their rate limit status by calling `sys_get_config({ section: "provider_status" })`, which returns metadata captured from the last API response:

| Field | Description |
|-------|-------------|
| `planType` | Subscription tier (`plus`, `pro`, etc.) |
| `primaryUsedPercent` | Percentage of primary (5-hour) window consumed |
| `primaryResetAfterSeconds` | Seconds until the primary window resets |
| `primaryResetAt` | Unix timestamp when the primary window resets |
| `primaryWindowMinutes` | Duration of the primary window (typically 300) |
| `secondaryUsedPercent` | Percentage of secondary (7-day) window consumed |
| `secondaryResetAfterSeconds` | Seconds until the secondary window resets |
| `secondaryResetAt` | Unix timestamp when the secondary window resets |
| `secondaryWindowMinutes` | Duration of the secondary window (typically 10080) |
| `creditsBalance` | Remaining purchased credits |
| `creditsHasCredits` | Whether the account has purchased credits |
| `activeLimit` | Which limit is currently active (e.g. `codex`) |

This enables self-managing agents — for example, a lambda can check `primaryUsedPercent` before expensive operations and defer work until the window resets. When the usage limit is reached, the error surfaces immediately (no retries) with the reset time in the error message

### Custom Parameters

For openai-compatible providers, you can add custom key-value parameters that are passed directly to the API. Useful for provider-specific features.

For chatgpt-subscription providers, you can use **Provider Parameters** (in the agent's model config) to pass provider-specific options like `reasoning.effort`. These are forwarded as `providerOptions.openai` to the AI SDK.

### Per-ADF Provider Configurations

Each ADF file can store its own provider configuration independently of the app-wide settings. This allows agents to ship with embedded API keys, custom models, and provider-specific parameters.

Per-ADF provider configs are managed from:

- **Settings > Providers** — Expand a provider and use the **ADF Files** section to assign credentials to specific ADF files. Each ADF can override the API key, default model, request delay, and custom parameters.
- **Agent > Config** — The agent's configuration panel shows which provider is being used and whether it has per-ADF overrides.

Credentials are stored in the ADF's `adf_identity` table (encrypted at rest), mirroring the pattern used for MCP server and channel adapter credentials. ADF files with stored provider configurations will continue to work independently, even if the provider is not listed in the app-wide settings.

## MCP Servers

MCP servers are managed through the **MCP Status Dashboard** in Settings. See [MCP Integration](mcp-integration.md) for full details.

### Status Dashboard

From **Settings > MCP Servers**:

- **Quick-add** — Browse a curated registry of well-known MCP servers and install with one click
- **Install/Uninstall** — Managed npm installs in `~/.adf-studio/mcp-servers/`
- **Configure** — Expand any server to edit args, environment variables, and timeout
- **Test** — Verify the server starts and exposes tools
- **Restart** — Reconnect a server
- **Logs** — View per-server logs including tool call history
- **Remove** — Delete the server and its installation
- **Credentials** — Manage API keys and secrets per server (app-wide or per-agent)

### Server Configuration

| Field | Description |
|-------|-------------|
| **Name** | Server display name |
| **Transport** | Connection type (`stdio`) |
| **Command** | Command to start the server |
| **Args** | Command arguments (one per row, supports `~` expansion) |
| **Environment Variables** | Variables passed to the server process |
| **Tool Call Timeout** | Per-server timeout in seconds (default: 60) |

## Channel Adapters

Channel adapters connect external messaging platforms to ADF agents. Manage adapters from **Settings > Channel Adapters**.

### Adapter Status Dashboard

- **Connection status** — See which adapters are connected, connecting, or errored
- **Logs** — View per-adapter logs (up to 500 entries)
- **Start/Stop/Restart** — Control adapter lifecycle
- **Credentials** — Store platform tokens (app-wide or per-agent in `adf_identity`)

### Available Adapters

| Adapter | Built-in | Required Credentials | Notes |
|---------|----------|---------------------|-------|
| **Telegram** | Yes | `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| **Email** | Yes | `EMAIL_USERNAME`, `EMAIL_PASSWORD` | IMAP/SMTP; use app-specific password |

Telegram and email are built in and always registered by the runtime; configure credentials and enable them per agent as needed.

Per-agent adapter configuration is set in the agent's config panel under `adapters`. See [Messaging > Channel Adapters](messaging.md#channel-adapters) for full details.

## Web (Mesh Server)

The **Web** tab shows the status of the mesh HTTP server and all agents currently serving content.

### Server Status

- **Running indicator** — Green dot when the server is listening, red when stopped
- **Host and port** — Shows the current bind address (e.g., `127.0.0.1:7295`)
- **Server URL** — Clickable link to the server root

### Mesh Toggle

Enable or disable the mesh network. When enabled, agents with configured serving or messaging can register on the mesh.

### LAN Access

Toggle **Allow LAN access** to bind the server to `0.0.0.0` instead of `127.0.0.1`. This allows other devices on your local network to access served agents at `http://{your-ip}:{port}/{handle}/`.

A server restart is required after changing this setting. The `MESH_HOST` environment variable overrides this setting.

### Agent Endpoints

A table listing all agents currently registered on the mesh:

| Column | Description |
|--------|-------------|
| **Handle** | The agent's identity — URL-safe slug derived from filename or manually configured |
| **URL** | Clickable link to the agent's mesh root |
| **Public** | Badge shown if public folder serving is enabled |
| **API** | Route count badge (e.g., "3 routes") |
| **Shared** | Pattern count badge (e.g., "2 patterns") |

Empty state: "No agents serving" when mesh is disabled or no agents are registered.

See [HTTP Serving](serving.md) for the full guide on configuring what agents serve.

## System Prompt

The system prompt is assembled dynamically from two parts: a **base prompt** and **conditional tool instruction sections**. Both are editable in **Settings > General**.

### Base Prompt (Global System Prompt)

The base prompt applies to all agents by default, prepended before each agent's individual instructions. It explains the ADF paradigm — the document workspace, mind.md, how triggers work, tone and style directives — without referencing any specific tools. Individual agents can opt out via the **Include application base system prompt** checkbox in their Instructions section (`include_base_prompt: false` in the config). Use the base prompt for:

- Explaining the ADF paradigm to models that may not be familiar with it
- Setting global behavioral rules
- Providing context that all agents should have

Edit the prompt text directly — changes are auto-saved with a short debounce delay. There's a **Reset to Default** button to restore the standard base prompt.

### Tool Instructions

Below the base prompt, the **Tool Instructions** section lists conditional prompt blocks that are injected based on the agent's enabled tools and features. Each section has an expandable textarea and a per-section **Reset to Default** button. A "modified" badge appears when the user has customized a section.

| Section | Injected When |
|---------|---------------|
| **Tool Best Practices** | Shell is **not** enabled — provides cross-tool workflow guidance (read before edit, fs_write modes, verify results) |
| **Code Execution & Lambdas** | `sys_code` or `sys_lambda` is enabled — explains the `adf` proxy object, single-argument rule, async/await requirements |
| **ADF Shell** | `adf_shell` tool is enabled — replaces Tool Best Practices with comprehensive shell syntax, command reference, tips, and environment variables |
| **Multi-Agent Collaboration** | `messaging.receive` is enabled — behavioral rules for responding to messages, using exact names, managing inbox |
| **HTTP Serving** | Any serving feature is configured (`serving.public`, `serving.shared`, or `serving.api`) — explains public folders, shared files, API route definitions, and lambda handlers |

When the adf_shell tool is enabled, the **Tool Best Practices** section is replaced by the **ADF Shell** section — they are mutually exclusive. All other sections are additive. Sections are joined with `---` separators.

Most individual tools (fs_read, fs_list, db_query, etc.) are self-explanatory from their schema descriptions and do not need additional system prompt guidance. The tool instruction sections focus on cross-cutting concerns that cannot be conveyed through tool schemas alone.

## Auto-Save

All settings changes are automatically saved with a debounced delay. There is no manual Save/Cancel workflow — changes take effect shortly after you stop editing. A close button dismisses the settings panel.

## Theme

Toggle between **light** and **dark** mode.

## Token Usage

ADF Studio tracks token usage across all agents. View usage in **Settings > Token Usage**.

### Usage Breakdown

- Per-date statistics
- Per-provider breakdown
- Per-model breakdown
- Input and output token counts
- Total statistics

### Managing Usage Data

- **Clear All** — Delete all tracked usage data
- Data is stored locally and not sent anywhere

## Tracked Directories

ADF Studio monitors directories for `.adf` files. When a new file appears in a tracked directory, it shows up in the sidebar.

### Managing Directories

- Directories are auto-tracked when you create or open a file
- You can manually add or remove tracked directories
- The sidebar shows a hierarchical tree of tracked directories and their files

### Directory Actions

- **Start all** — Start all agents in a directory
- **Stop all** — Stop all agents in a directory

## Application Settings

### File Associations

ADF Studio registers itself as the handler for `.adf` files. Double-clicking an `.adf` file opens it in the app.

### Multiple Instances

For development, you can run multiple ADF Studio instances with `--instance=N`. Each instance gets a separate user data directory and independent settings.

## Bottom Panel (Logs & Tasks)

ADF Studio includes a VS Code-style **Bottom Panel** at the bottom of the main view, toggled from the **Logs** or **Tasks** buttons in the status bar. The panel has two tabs: **Logs** and **Tasks**, with a shared drag-to-resize handle.

### Logs Tab

Displays structured log entries from `adf_logs` — including lambda trigger executions, sys_lambda results, API serving requests/responses, and runtime events.

- **Level filtering** — Filter by `debug`, `info`, `warn`, or `error`
- **Origin filtering** — Filter by origin (e.g., `timer`, `lambda`, `serving`, `adf_shell`). The dropdown is populated dynamically from the origins present in the current log entries.
- **Structured columns** — Each log entry shows timestamp, level, origin, event type, target, and message
- **Expandable data** — Click a row to expand and view the full JSON data payload
- **Auto-refresh** — Toggle auto-refresh to poll for new log entries
- **Per-ADF** — Logs reload automatically when navigating between ADF files

#### Log Entry Fields

| Field | Description |
|-------|-------------|
| `level` | Log level: `debug`, `info`, `warn`, `error` |
| `origin` | Where the log came from (e.g., `timer`, `lambda`, `serving`, `sys_lambda`, `adf_shell`) |
| `event` | The event type (e.g., `on_timer`, `api_request`, `api_response`, `execute`, `result`) |
| `target` | The specific target (e.g., `system:lib/router.ts:onMessage`, `lib/api.ts:handler`) |
| `message` | Human-readable log message |
| `data` | Optional JSON data payload |

See [Logging](logging.md) for details on log filtering configuration (`default_level`, per-origin `rules`, `max_rows`).

### Tasks Tab

Displays async tasks from `adf_tasks` — tool calls that require human approval or long-running operations.

- **Status filtering** — Filter by `pending`, `pending_approval`, `running`, `completed`, `failed`, `denied`, or `cancelled`
- **Expandable rows** — Click a task to view its full arguments, result, or error details
- **Auto-refresh** — Toggle auto-refresh to poll for task status changes
- **Per-ADF** — Tasks reload automatically when navigating between ADF files

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd/Ctrl + ,` | Open Settings |
| `Cmd/Ctrl + S` | Save current editor tab |
| `Cmd/Ctrl + W` | Close active editor tab |
