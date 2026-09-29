# ADF Daemon

The ADF daemon is the headless ADF runtime that serves an API for `.adf`
agents. It runs agents without the Studio UI: it loads the agents in your
tracked folders, keeps them running (timers, triggers, channels, MCP servers,
compute), serves their websites through the mesh server, and exposes
everything over a local HTTP API guarded by a per-install access token.

The ADF CLI and its terminal app (`adf`, npm package
[`@agentdocumentformat/cli`](https://www.npmjs.com/package/@agentdocumentformat/cli))
are clients of that API, and start the daemon in the background when they need
it. Studio remains the visual IDE for authoring and observing agents. Both
hosts build agents with the same canonical assembler; the daemon selects the
exhaustive `daemon` capability profile.

## Documentation

- [Getting Started](getting-started.md): install, owner identity, providers, create or load agents, chat, and the same over HTTP
- [Terminal app](../cli/terminal-app.md): `adf` with no command: your fleet, each agent's loops, approvals, files and live events
- [ADF CLI](../cli/index.md): one-shot commands for agent control, resources, diagnostics, events and chat
- [API guide](api-guide.md): building on the HTTP API: authentication and remote access, agents and loops, chat and events, approvals, identity, credentials, channels, MCP, providers, templates, skills, errors
- [API reference](api-reference.md): every endpoint, generated from [`openapi.json`](openapi.json)
- [HTTP API overview](http-api.md): the API at a glance, by area
- [Operations](operations.md): running and stopping the daemon, data directory, ports, token, Studio compatibility, troubleshooting
- [Runtime Settings](runtime-settings.md): the settings file, providers, MCP, channels, compute, mesh, and the settings API
- [Runtime Architecture](runtime-architecture.md): RuntimeService, AgentRuntimeBuilder, the request guard, triggers, MCP, channels, compute and mesh serving
- [Lifecycle Assembly Contract](lifecycle-assembly.md): shared profiles, dispatch boundary, ownership, startup, transfer and shutdown
- [Performance Harness](performance-harness.md): the headless runtime stress harness

## Daemon vs Studio

| Area | Studio | Daemon |
|------|--------|--------|
| Primary use | Desktop authoring and visual operation | Headless runtime: terminal, scripts, servers, other clients |
| Entry point | The ADF Studio app (`npm run dev` from source) | `adf` (auto-start), `adf daemon [start]` (`npm run daemon` from source) |
| Agent control | Renderer UI and main-process IPC | HTTP API on `127.0.0.1:7385` (bearer token), the terminal app and the CLI |
| Agent visibility | Loop panel, logs panel, agent panels | Terminal app, `/events` stream, diagnostics and resource endpoints, daemon log |
| Settings | App settings UI | The same `adf-settings.json` (edited by the terminal app, the API, or by hand) |
| Owner identity | Seed phrase in the OS keychain | The same identity (shared keychain), or a passphrase file where there is none |
| Mesh serving | Mesh server on port `7295` | Same mesh server on port `7295`, on by default |
| Runtime wiring | Canonical assembler with Studio foreground/background profiles | Canonical assembler with the `daemon` profile, hosted by `RuntimeService` |

Run one of them at a time on the same agents: both would open the same files,
start the same channels and bind the same mesh port. `adf` refuses to
auto-start a daemon while Studio runs on the same settings.

## What works today

- Background daemon management (`adf daemon start|stop|status|restart|logs|token`), auto-start from `adf`
- Token-authenticated HTTP API with Host / Origin checks, loopback-only identity and shutdown routes
- Owner identity create, restore, unlock and lock; agents created from templates, sealed like Studio's
- Tracked folders with autostart and a review gate; every agent on disk listed with what it needs
- Loading, starting, stopping, interrupting and aborting agents; inner loops (side loops) and per-loop chat, history, compaction and timers
- Asynchronous chat turns and a Server-Sent Events stream with resume and replay
- Approvals (approve, deny with feedback, always approve, approve all), questions and suspends
- Sealed per-agent credentials (metadata-only reads), channels, MCP servers, API-key providers in the secret store, ChatGPT and Grok subscription sign-in
- File-backed skills, agent files, config, timers, inbox, outbox, logs and tables
- Context breakdowns, token usage, and runtime diagnostics for providers, auth, MCP, channels, network, compute and WebSockets
- Built-in, code, compute and MCP tools; channel messages waking agents through triggers
- Agent websites and APIs through the mesh server on port `7295`
- A headless performance harness with mock providers

## Current caveats

- The `/events` replay buffer is in memory (1000 frames): live visibility and short reconnects, not an audit log. Durable history is in each agent's file.
- File-change triggers are incomplete without Studio's document editor.
- The daemon speaks plain HTTP; remote use needs an SSH tunnel or TLS in front ([remote access](api-guide.md#remote-access)).
- No cross-process lock keeps Studio and a hand-started daemon off the same `.adf` files.
- From a source checkout, switching between Studio (Electron) and the daemon (Node) rebuilds `better-sqlite3`.
