# ADF Documentation

ADF Studio provides desktop and browser interfaces for creating and configuring AI agents stored as `.adf` files. The ADF daemon runs the agents and serves the browser client as well as its HTTP API. Browser Studio can run from the CLI without installing the desktop app.

## What is ADF?

The Agent Document Format (`.adf`) stores an AI agent in one SQLite file. An `.adf` file is one localized agent: its identity, state and behaviour in a single file ([what's inside](../ADF_SPEC_v0.2.md#13-one-file-one-agent)).

ADF Studio is the visual IDE for working with these files. The daemon supplies execution and APIs for Studio, automation, deployment, and service-style operation. Both operate on the same `.adf` file format.

## Documentation

- [What ADF Studio Can Do](CAPABILITIES.md) — the full capability catalogue: what an agent can do and what you can do with it, then the mechanisms underneath
- [Network Traffic](NETWORK.md) — every outbound connection Studio and the daemon make, who starts it, and how to turn it off
- [Docs Style Guide](STYLE.md) — how ADF documents are written: terminology, requirement keywords, linking to the spec

### Runtime Tracks

- [Studio Documentation](ADF_STUDIO_DOCS.md) — Visual authoring reference and desktop integrations
- [Browser Studio](guides/studio-web.md) — Local automatic sign-in with `adf web`, remote pairing, shared implementation and browser differences
- [Daemon Documentation](daemon/index.md) — Headless runtime overview, API, operations, and performance harness

### Daemon

- [Daemon Overview](daemon/index.md) — What the daemon is, what works today, and current caveats
- [Daemon Getting Started](daemon/getting-started.md) — Install `adf`, set up your owner identity, create or load agents, chat, and the same over HTTP
- [Daemon API Guide](daemon/api-guide.md) — Building on the HTTP API: authentication and remote access, agents and loops, chat and events, approvals, identity, credentials, channels, MCP, providers, errors
- [Daemon API Reference](daemon/api-reference.md) — Every endpoint, generated from [`openapi.json`](daemon/openapi.json)
- [Daemon HTTP API Overview](daemon/http-api.md) — The API at a glance, by area
- [ADF CLI](cli/index.md) — Command-line client for agent control, resources, diagnostics, events, and chat
- [Terminal app](cli/terminal-app.md) — `adf` with no command: your fleet, each agent's loops and their transcripts, approvals, files and live events
- [Daemon Runtime Settings](daemon/runtime-settings.md) — The settings file, providers, MCP, channels, compute, mesh, and the settings API
- [Daemon Runtime Architecture](daemon/runtime-architecture.md) — RuntimeService, AgentRuntimeBuilder, the request guard, triggers, MCP, channels, compute, and mesh
- [Daemon Operations](daemon/operations.md) — Running and stopping the daemon, data directory, ports, access token, compatibility, and troubleshooting
- [Owner Secret Storage](daemon/owner-secret-storage.md) — Where the seed phrase and keys are kept; Linux keyrings, the passphrase file, systemd credentials, containers, and WSL
- [Headless Performance Harness](daemon/performance-harness.md) — Benchmark headless runtime behavior with mock providers

### Studio Getting Started

- [Getting Started](getting-started.md) — Create your first agent and start a conversation
- [Browser Studio](guides/studio-web.md) — Open Studio locally or connect from another device without installing desktop Studio

### Knowledge Base

The [Knowledge Base](knowledge/index.md) is a task-oriented routing layer for reusable capabilities.

- [Desktop Applications with Isolated Compute](knowledge/desktop-apps.md) — Run available Linux GUI applications in a visible, agent-dedicated container, transfer files, and validate screenshots without assuming a full desktop or generic GUI automation.
- [Persistent Investigations](knowledge/persistent-investigations.md) — Keep unresolved research questions available across compaction and restart using existing capabilities and an installable skill.

- [Gmail setup](knowledge/gmail-setup.md) — Connect a mailbox with MCP and choose tool permissions
- [Composio MCP](knowledge/composio-mcp.md) — Trial notes on Composio's hosted MCP server, its tool permissions, and Gmail connection

### Studio Concepts

- [Core Concepts](core-concepts.md) — One file, one agent; the access boundary; the ADF stack

### Studio Guides

- [Creating and Configuring Agents](guides/creating-agents.md) — Set up an agent's identity, model, and instructions
- [Agent States and Lifecycle](guides/agent-states.md) — Understand active, idle, hibernate, suspended, and off
- [Mesh view](guides/fleet-map.md) — Command your whole fleet from the RTS-style map: territories, selection, hotkeys, moving agents, approvals
- [Agent Overview](guides/agent-overview.md) — How the Overview card scores Experience, Reach, Access and Autonomy, agent metrics, and the Contents meter
- [Documents and Files](guides/documents-and-files.md) — The primary document, mind file, and virtual filesystem
- [Skills](guides/skills.md) — File-backed reusable agent procedures and their catalog
- [Tools](guides/tools.md) — Built-in tool catalog and how agents use them
- [Code Execution Environment](guides/code-execution.md) — Sandbox, security, and execution contexts
- [The adf Proxy Object](guides/adf-object.md) — API reference for code running in the sandbox
- [MCP Integration](guides/mcp-integration.md) — Connect external tool servers via MCP
- [Computer](guides/browser.md) — Each isolated agent's visible desktop: managed Chromium, Playwright automation, interactive login, and portable profiles
- [Computer Use](guides/computer-use.md) — Driving that desktop from tool calls: screenshots, xdotool, clipboard, opening apps and files, sharing the screen
- [Triggers](guides/triggers.md) — Configure what events activate your agent
- [Inner Loops](guides/inner-loops.md) — The main loop plus up to 16 inner loops (side loops) in one agent, the `loop_*` tools, and per-loop pacing
- [Messaging](guides/messaging.md) — Inter-agent communication, channels, and routing
- [LAN Discovery](guides/lan-discovery.md) — mDNS-based cross-runtime agent discovery and troubleshooting
- [Contacts](guides/contacts.md) — Agent-managed contacts: reference patterns and the primitives they build on
- [Timers](guides/timers.md) — Schedule one-time, recurring, and cron-based events
- [Security Architecture](guides/security-architecture.md) — Trust boundaries, defense layers, and hardening controls
- [Authorized Code Execution](guides/authorized-code.md) — File-level trust boundary, method gating, and governance patterns
- [Security and Identity](guides/security-and-identity.md) — Owner/runtime/agent identity, seed-phrase backup, envelope encryption, sharing and claiming agents, attestations and agent-negotiated trust
- [Memory Management](guides/memory-management.md) — Loop history, compaction, archiving, and the mind file
- [Tasks](guides/tasks.md) — Async tool execution, trigger interception, and task lifecycle
- [Logging](guides/logging.md) — Structured runtime logs for lambdas, function calls, and API serving
- [HTTP Serving](guides/serving.md) — Serve static files, shared data, and API endpoints over HTTP
- [Custom Middleware](guides/middleware.md) — User-defined lambdas for routes, inbox, outbox, and fetch pipelines
- [Settings](guides/settings.md) — Providers, MCP servers, and global configuration
