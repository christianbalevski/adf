# ADF Documentation

Welcome to the ADF documentation. ADF Studio is the desktop application for creating, configuring, and managing autonomous AI agents packaged as portable `.adf` files. The ADF daemon is the headless ADF runtime that serves an API for running those agents without the Studio UI.

## What is ADF?

The **Agent Document Format** (`.adf`) is a self-contained SQLite database that bundles an AI agent's memory, logic, configuration, and communication history into a single portable file. Each `.adf` file represents one agent paired with one primary document — the atomic unit of the ADF ecosystem.

ADF Studio is the visual IDE for working with these files. The daemon is the headless API runtime path for automation, deployment, and service-style operation. Both operate on the same `.adf` file format.

## Documentation

### Runtime Tracks

- [Studio Documentation](ADF_STUDIO_DOCS.md) — Desktop authoring and visual runtime reference
- [Daemon Documentation](daemon/index.md) — Headless runtime overview, API, operations, and performance harness

### Daemon

- [Daemon Overview](daemon/index.md) — What the daemon is, what works today, and current caveats
- [Daemon Getting Started](daemon/getting-started.md) — Run the daemon, load agents, chat, inspect loop state, and autostart
- [Daemon HTTP API](daemon/http-api.md) — Endpoint reference for headless clients
- [Daemon CLI](daemon/cli.md) — Terminal client for agent control, resources, diagnostics, events, and chat
- [Daemon Runtime Settings](daemon/runtime-settings.md) — Direct JSON settings, example schema, and settings API usage
- [Daemon Runtime Architecture](daemon/runtime-architecture.md) — RuntimeService, AgentRuntimeBuilder, triggers, MCP, adapters, compute, and mesh
- [Daemon Operations](daemon/operations.md) — Settings, ports, process management, compatibility, and troubleshooting
- [Headless Performance Harness](daemon/performance-harness.md) — Benchmark headless runtime behavior with mock providers

### Studio Getting Started

- [Getting Started](getting-started.md) — Create your first agent and start a conversation

### Studio Concepts

- [Core Concepts](core-concepts.md) — Sovereignty, one-agent-one-document, and the ADF stack

### Studio Guides

- [Creating and Configuring Agents](guides/creating-agents.md) — Set up an agent's identity, model, and instructions
- [Agent States and Lifecycle](guides/agent-states.md) — Understand active, idle, hibernate, suspended, and off
- [Documents and Files](guides/documents-and-files.md) — The primary document, mind file, and virtual filesystem
- [Tools](guides/tools.md) — Built-in tool catalog and how agents use them
- [Code Execution Environment](guides/code-execution.md) — Sandbox, security, and execution contexts
- [The adf Proxy Object](guides/adf-object.md) — API reference for code running in the sandbox
- [MCP Integration](guides/mcp-integration.md) — Connect external tool servers via MCP
- [Triggers](guides/triggers.md) — Configure what events activate your agent
- [Messaging](guides/messaging.md) — Inter-agent communication, channels, and routing
- [LAN Discovery](guides/lan-discovery.md) — mDNS-based cross-runtime agent discovery and troubleshooting
- [Contacts](guides/contacts.md) — Agent-managed contacts: reference patterns and the primitives they build on
- [Timers](guides/timers.md) — Schedule one-time, recurring, and cron-based events
- [Security Architecture](guides/security-architecture.md) — Trust boundaries, defense layers, and hardening controls
- [Authorized Code Execution](guides/authorized-code.md) — File-level trust boundary, method gating, and governance patterns
- [Security and Identity](guides/security-and-identity.md) — Cryptographic identity, encryption, and passwords
- [Memory Management](guides/memory-management.md) — Loop history, compaction, archiving, and the mind file
- [Tasks](guides/tasks.md) — Async tool execution, trigger interception, and task lifecycle
- [Logging](guides/logging.md) — Structured runtime logs for lambdas, function calls, and API serving
- [HTTP Serving](guides/serving.md) — Serve static files, shared data, and API endpoints over HTTP
- [Custom Middleware](guides/middleware.md) — User-defined lambdas for routes, inbox, outbox, and fetch pipelines
- [Settings](guides/settings.md) — Providers, MCP servers, and global configuration
