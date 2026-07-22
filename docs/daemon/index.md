# ADF Daemon

The ADF daemon is the headless ADF runtime that serves an API for `.adf` agents. It runs agents without the Studio UI, exposes a local HTTP API, autostarts trusted agents from tracked directories, wires runtime services such as MCP and channel adapters, and serves agent websites through the same mesh server used by Studio.

Studio remains the visual IDE for authoring, configuring, and observing agents. The daemon is for automation, deployment, background agents, CLI/TUI clients, service supervisors, and any environment where a desktop UI is the wrong shape. Both hosts now use the same canonical assembled-agent lifecycle; the daemon selects the exhaustive `daemon` capability profile.

## Documentation

- [Getting Started](getting-started.md) - Start the daemon, load an agent, chat, inspect status, and autostart agents
- [HTTP API](http-api.md) - Endpoint reference for agents, loop inspection, review, settings, compute, and ChatGPT auth
- [CLI](cli.md) - Terminal client for agent control, resources, diagnostics, events, and chat
- [Runtime Settings](runtime-settings.md) - Direct JSON settings, example schema, providers, MCP, adapters, compute, and mesh
- [Runtime Architecture](runtime-architecture.md) - RuntimeService, AgentRuntimeBuilder, triggers, MCP, adapters, compute, and mesh serving
- [Lifecycle Assembly Contract](lifecycle-assembly.md) - Shared profiles, dispatch boundary, ownership, startup, transfer, and shutdown
- [Operations](operations.md) - Settings, ports, process management, Studio compatibility, troubleshooting, and current caveats
- [Performance Harness](performance-harness.md) - Run the headless runtime stress harness and interpret reports

## Daemon vs Studio

| Area | Studio | Daemon |
|------|--------|--------|
| Primary use | Desktop authoring and visual operation | Headless API runtime operation |
| Entry point | `npm run dev` | `npm run daemon` |
| Agent control | Renderer UI and main-process IPC | Local HTTP API on port `7385`, plus `npm run adf -- ...` |
| Agent visibility | Loop panel, logs panel, agent panels | CLI, `/events`, `/runtime`, `/agents/:id/runtime`, resource endpoints, stdout logs |
| Settings | App settings UI | Direct JSON settings file, plus settings HTTP endpoints |
| Mesh serving | Mesh server on port `7295` | Same mesh server on port `7295` |
| Runtime wiring | Canonical assembler with Studio foreground/background profiles | Canonical assembler with the `daemon` profile, hosted by `RuntimeService` |

The daemon does not replace Studio. Studio and daemon provide different host surfaces over the same assembled-agent lifecycle and dispatch contract.

## What Works Today

The daemon currently supports:

- Starting an HTTP API on `127.0.0.1:7385`
- Loading `.adf` files by path
- Listing loaded agents
- Inspecting agent status and persisted loop entries
- Streaming daemon and agent events with Server-Sent Events
- Inspecting read-only agent resources such as config, files, inbox, outbox, timers, identities, and logs
- Listing and resolving human-in-the-loop tasks, approvals, suspend prompts, and pending `ask` requests
- Inspecting sanitized runtime diagnostics for providers, auth, settings, MCP, adapters, network, WebSockets, and agent runtime wiring
- Using the `npm run adf -- ...` CLI client for common daemon operations
- Sending asynchronous chat turns
- Starting agents, unloading agents, and aborting current turns
- Autostart scanning from tracked directories
- Review/trust gates for autostarted or strict-loaded agents
- ChatGPT subscription auth flow endpoints
- Reading and updating daemon settings
- Compute environment status and lifecycle endpoints
- Built-in tools, code tools, compute tools, MCP tools, and channel adapters
- Inbound adapter messages waking agents through trigger evaluation
- Agent website and API serving through the mesh server on port `7295`
- A headless performance harness with mock providers

## Current Caveats

The daemon still has known operational gaps:

- Do not run Studio and the daemon against the same `.adf` files unless you intentionally want both processes touching them.
- Studio and the daemon can conflict on mesh port `7295`.
- Switching between Studio and daemon can rebuild `better-sqlite3` for different runtimes because Studio uses Electron and the daemon uses regular Node.
- File-change triggers are not fully meaningful in the daemon yet because Studio's document editor is not present.
- The event stream uses an in-memory ring buffer, so it is for live visibility and short replay windows, not durable audit storage.

Clients can use `/events` for live visibility into daemon lifecycle, agent lifecycle, turns, state changes, tool calls, and errors.
