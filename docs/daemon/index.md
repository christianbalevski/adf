# ADF Daemon

The ADF daemon is the headless ADF runtime that serves an API for `.adf`
agents. It runs agents without the Studio UI: it loads the agents in your
tracked folders, keeps them running (timers, triggers, channels, MCP servers,
compute), serves their websites through the mesh server, and exposes
agent control over an authenticated HTTP API. Native clients use bearer
tokens; Browser Studio uses same-origin cookies backed by that authority.

The ADF CLI and its terminal app (`adf`, npm package
[`@agentdocumentformat/cli`](https://www.npmjs.com/package/@agentdocumentformat/cli))
are clients of that API, and start the daemon in the background when they need
it. Desktop Studio in Local mode is another client of the daemon,
with a desktop UI for authoring and observing agents. The legacy Inside
Studio mode hosts agents in Studio itself. Both runtime hosts build agents
with the same canonical assembler; the daemon selects the exhaustive
`daemon` capability profile.

## Documentation

- [Getting Started](getting-started.md): install, owner identity, providers, create or load agents, chat, and the same over HTTP
- [Studio in a browser](../guides/studio-web.md): the shared Studio UI, local `adf web` launch, remote browser pairing and deployment
- [Terminal app](../cli/terminal-app.md): `adf` with no command: your fleet, each agent's loops, approvals, files and live events
- [ADF CLI](../cli/index.md): one-shot commands for agent control, resources, diagnostics, events and chat
- [API guide](api-guide.md): building on the HTTP API: authentication and remote access, agents and loops, chat and events, approvals, identity, credentials, channels, MCP, providers, templates, skills, errors
- [API reference](api-reference.md): every endpoint, generated from [`openapi.json`](openapi.json)
- [HTTP API overview](http-api.md): the API at a glance, by area
- [Operations](operations.md): running and stopping the daemon, data directory, ports, token, Studio compatibility, troubleshooting
- [Owner secret storage](owner-secret-storage.md): where the seed phrase and keys are kept; Linux keyrings, the passphrase file, systemd credentials, containers, WSL
- [Runtime Settings](runtime-settings.md): the settings file, providers, MCP, channels, compute, mesh, and the settings API
- [Runtime Architecture](runtime-architecture.md): RuntimeService, AgentRuntimeBuilder, the request guard, triggers, MCP, channels, compute and mesh serving
- [Lifecycle Assembly Contract](lifecycle-assembly.md): shared profiles, dispatch boundary, ownership, startup, transfer and shutdown
- [Performance Harness](performance-harness.md): the headless runtime stress harness

## Daemon vs Studio

| Area | Studio | Daemon |
|------|--------|--------|
| Primary use | Desktop authoring and visual operation | Headless runtime: terminal, scripts, servers, other clients |
| Entry point | The ADF Studio app (`npm run dev` from source) | `adf` (auto-start), `adf daemon [start]` (`npm run daemon` from source) |
| Agent control | Desktop UI connected to the daemon; main-process IPC in legacy Inside Studio mode | HTTP API on `127.0.0.1:7385` (bearer token), Browser Studio (cookie session), the terminal app and the CLI |
| Agent visibility | Loop panel, logs panel, agent panels | Terminal app, `/events` stream, diagnostics and resource endpoints, daemon log |
| Settings | App settings UI for the connected runtime | The same `adf-settings.json` (edited by the terminal app, the API, or by hand) |
| Owner identity | Local mode and legacy Inside Studio share the owner identity and settings on this computer; [secret storage](owner-secret-storage.md) depends on the runtime host | The same identity (shared keychain), or a passphrase file where there is none |
| Mesh serving | The connected daemon's mesh; an in-process server in legacy Inside Studio mode | Same mesh server on port `7295`, on by default |
| Runtime wiring | Daemon client in Local mode; canonical assembler with Studio foreground/background profiles in legacy Inside Studio mode | Canonical assembler with the `daemon` profile, hosted by `RuntimeService` |

Studio in Local mode and `adf` can use the same daemon at the same time.
In legacy Inside Studio mode, Studio runs agents itself, so `adf` refuses
to auto-start a daemon while that Studio runs on the same settings. Agent
leases normally prevent separate runtimes on one computer from running the
same file; the caveat below applies when lease storage is unavailable. See [Studio at the same time](../cli/troubleshooting.md#studio-at-the-same-time)
and [agent leases](../cli/troubleshooting.md#agent-is-already-running-agent_leased).

## What works today

- Background daemon management (`adf daemon start|stop|status|restart|logs|token`), auto-start from `adf`
- Browser Studio in builds containing the browser client: shared renderer, local launch tickets and host-approved remote pairing
- Token-authenticated HTTP API with Host / Origin checks, loopback-only identity and shutdown routes
- Owner identity create, restore, unlock and lock; agents created from templates, sealed like Studio's
- Tracked folders with autostart and a review gate; every agent on disk listed with what it needs
- Loading, starting, stopping, interrupting and aborting agents; inner loops (side loops) and per-loop chat, history, compaction and timers
- Asynchronous chat turns and a Server-Sent Events stream with resume and replay
- Approvals (approve, deny with feedback, always approve, approve all), questions and suspends
- Sealed per-agent credentials (metadata-only reads), channels, MCP servers, API-key providers in the secret store, Claude, ChatGPT and Grok subscription sign-in
- File-backed skills, agent files, config, timers, inbox, outbox, logs and tables
- Context breakdowns, token usage, and runtime diagnostics for providers, auth, MCP, channels, network, compute and WebSockets
- Built-in, code, compute and MCP tools; channel messages waking agents through triggers
- Agent websites and APIs through the mesh server on port `7295`
- A headless performance harness with mock providers

## Current caveats

- The `/events` replay buffer is in memory (1000 frames): live visibility and short reconnects, not an audit log. Durable history is in each agent's file.
- File-change triggers are incomplete without Studio's document editor.
- The daemon speaks plain HTTP. Remote access on a LAN sends the token unencrypted; for https use `adf daemon remote serve on` (tailscale serve), an SSH tunnel or a TLS proxy ([Remote daemon](../cli/remote-daemon.md)).
- If the lease folder is not writable, the agent starts with a warning and without protection against a second runtime opening it. See [agent leases](../cli/troubleshooting.md#agent-is-already-running-agent_leased).
