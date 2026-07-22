# Daemon Runtime Architecture

The daemon is the headless ADF runtime that serves an API. Internally, it is built around three layers:

- `RuntimeService` owns loaded-agent indexes, review gates, autostart scanning, API-facing operations, and runtime events.
- `AgentRuntimeBuilder` prepares daemon-specific tools and services such as MCP, adapters, compute, system scope, and stream bindings.
- `assembleAgent(..., profile: 'daemon')` creates and owns the executor, session, trigger evaluator, managers, startup sequence, dispatch tracking, and teardown lifecycle.

The daemon process in `src/main/daemon/index.ts` wires these together with settings, providers, Podman compute, mesh serving, MCP package resolution, channel adapter resolution, and the HTTP host.

This is the same canonical assembler used by Studio and lightweight headless callers. The exhaustive profile data declares which observable subsystems differ; daemon construction is no longer an independent lifecycle recipe.

## Process Startup

`npm run daemon` runs:

```bash
node scripts/rebuild-for-node.mjs && tsx src/main/daemon/index.ts
```

The rebuild step matters because Studio runs under Electron while the daemon runs under Node. Native modules such as `better-sqlite3` must match the current runtime ABI.

Startup flow:

1. Read daemon host, port, pid file, and settings path from environment variables.
2. Load settings with `FileSettingsStore`.
3. Create shared runtime services: code sandbox, Podman compute, mesh manager, WebSocket manager, mesh server, MCP resolvers, and adapter resolvers.
4. Create `AgentRuntimeBuilder`, which will select the `daemon` profile when it builds an agent.
5. Create `RuntimeService`, the daemon host for assembled handles.
6. Create and start `DaemonHost`, which exposes the HTTP API.
7. Start the mesh server.
8. Scan `trackedDirectories` and autostart eligible agents.

## RuntimeService

`RuntimeService` is the headless lifecycle boundary. It keeps an in-memory map from agent ID to managed agent, plus a file-path index so one `.adf` file is not loaded twice by the same daemon process.

Current responsibilities:

- `loadAgent(filePath)` opens an `.adf`, resolves the provider, obtains an assembled `daemon` handle from the builder, attaches the daemon host, and registers it.
- `unloadAgent(agentId)` detaches the host, awaits `disposeAsync()`, and removes file indexes.
- `createAgent(...)` is the compatibility fallback for tests and harnesses. It delegates to the same `headlessLive` assembler as direct lightweight construction; it is not another lifecycle profile or recipe.
- `startAgent(agentId)` invokes the assembled handle's once-only startup dispatch when `start_in_state` is `active`.
- `stopAgent(agentId)` unloads the agent through canonical asynchronous teardown.
- `abortAgent(agentId)` aborts the current executor turn without unloading the agent.
- `sendChat(agentId, text)` creates a chat dispatch object and submits it through the assembled handle.
- `trigger(agentId, dispatch)` submits an `AdfEventDispatch` or `AdfBatchDispatch` through the same boundary.
- `autostartFromDirectories(...)` scans tracked directories for `.adf` files and starts eligible agents.
- `getAgent`, `listAgents`, `getAgentStatus`, and `getAgentLoop` expose runtime state to HTTP clients.
- Read-only resource methods expose config, files, inbox, outbox, timers, identity metadata, and logs.
- Task and human-in-the-loop methods expose task listing, task resolution, pending asks, ask responses, and suspend responses.
- Diagnostics methods expose adapters, MCP, triggers, and WebSocket runtime state.
- `getReviewInfo` and `acceptReview` implement the review/trust gate.

Runtime events:

| Event | Purpose |
|-------|---------|
| `agent-loaded` | Emitted after an agent is registered |
| `agent-unloaded` | Emitted before an agent is disposed |
| `agent-event` | Forwards `AgentExecutor` execution events with agent ID and file path |

The daemon uses these events to register and unregister mesh serving and to publish Server-Sent Events through the daemon event bus.

## Dispatch Boundary

Every daemon-originated turn enters through the stable assembled handle:

```ts
dispatch(
  dispatch: AdfEventDispatch | AdfBatchDispatch,
  options?: DispatchOptions,
): Promise<void>
```

The daemon never calls `executeTurn()` directly. Dispatch is accepted only while the handle is `running`; it rejects while `created` or `starting`, and once stopping begins. Startup uses the separate once-only startup sequence. Keeping the host boundary as a dispatch object also leaves a stable interposition point for future loop routing.

`RuntimeService` binds its event forwarding and other host callbacks with the framework-neutral `attachHost()` API. Exactly one owning host attachment is active and its detach token is idempotent. The executor, session, evaluator, managers, in-flight turns, and human-in-the-loop state stay on the stable handle, so a future daemon client reconnect can replace a host attachment without reconstructing or stopping the agent.

## Event Bus

The daemon owns a `DaemonEventBus` that assigns monotonically increasing sequence numbers, keeps a bounded in-memory event buffer, and notifies live subscribers.

The HTTP API exposes the bus through:

```text
GET /events
GET /events?agentId=agent-id
GET /events?since=42
```

Published events include daemon startup, autostart reports, agent load/unload, raw agent executor events, state changes, turn completion, tool start/completion, adapter status/log events, MCP status/log/tool-discovery events, and errors. The buffer supports short replay windows for clients that reconnect with a `since` cursor. Durable history still lives in the `.adf` file and is exposed through APIs such as `/agents/:id/loop`.

## Review Gate

The review gate prevents untrusted `.adf` files from being autostarted invisibly.

Autostart checks:

- The file can be scanned for boot status.
- `autostart` is enabled.
- The file is not password protected.
- The agent ID is present in the `reviewedAgents` settings array.

Direct `/agents/load` calls bypass review by default because they are explicit local operator actions. Clients can set `requireReview: true` to enforce the same gate.

Review endpoints use `buildConfigSummary` so clients can show a concise review payload before accepting.

## AgentRuntimeBuilder

`AgentRuntimeBuilder` prepares the daemon-specific inputs to canonical assembly without depending on renderer IPC. It does not construct an executor or own a second lifecycle.

Build flow:

1. Normalize core tool declarations and register built-in tools.
2. Create `AdfCallHandler` when code, lambdas, middleware, or API routes need it.
3. Register code, compute, stream-binding, and fetch tools.
4. Connect optional MCP servers and register discovered MCP tools.
5. Start optional channel adapters.
6. Prepare `SystemScopeHandler` and daemon host callbacks.
7. Call the canonical assembler with the explicit `daemon` profile, workspace, resolved provider, registry, managers, and cleanup resources.
8. Await handle startup and return `AssembledAgent<'daemon'>`.

The assembler creates the session, restores the loop when requested, creates the sole production executor and evaluator, wires core callbacks, runs startup once-semantics, and tracks dispatches. If core startup fails it rolls acquired resources back. Optional MCP, adapter, and compute setup keeps degrade-and-log behavior.

## Tool Registration

All daemon agents get the normal built-in tool registry. The builder also normalizes a few runtime details:

- Ensures `msg_list`, `msg_read`, and `msg_update` are declared in config.
- Migrates legacy `container_exec` declarations to `compute_exec`.
- Registers `fs_transfer` and `compute_exec` even when isolated compute is unavailable; tool capabilities report what targets exist.
- Registers MCP tools as `mcp_{server}_{tool}` after successful discovery.
- Disables enabled MCP tool declarations when their server is unavailable and was not attempted.

## Code and System Scope

When a daemon agent has system lambdas, API routes, middleware, `sys_code`, or `sys_lambda`, the builder creates an `AdfCallHandler`.

When a code sandbox service is available, the executor receives a `SystemScopeHandler`. This allows system-scope trigger targets and lambda-backed serving routes to run without waking the LLM.

The daemon path supports:

- `sys_code`
- `sys_lambda`
- API route lambdas
- inbox, outbox, route, and fetch middleware
- `sys_fetch` middleware dependencies

## Trigger Evaluation

The canonical assembler owns a `TriggerEvaluator` for each daemon-profile agent. This is what makes headless agents react to runtime events instead of merely storing them.

Core assembly wires:

- Timer polling from the workspace
- Agent state changes back into trigger display state
- Workspace logs into log triggers
- Tool-call interception into tool-call triggers
- Task creation and completion into task triggers
- Config changes from `sys_update_config` into executor and trigger evaluator config
- Adapter inbound messages into `on_inbox`

When a channel adapter receives a message, it stores the inbound message in the ADF inbox through the adapter manager. The evaluator then produces a dispatch for the assembled handle rather than invoking the executor directly.

This wakes the agent loop when the agent has an enabled `on_inbox` trigger with an agent-scope target.

## Lifecycle and Shutdown

Daemon agents use the full asynchronous lifecycle: `created`, `starting`, `running`, `stopping`, `stopped`, and `disposed`. Lifecycle calls are idempotent and concurrent callers share the active promise. Full profiles expose `disposeAsync()` rather than synchronous `dispose()` because MCP, adapters, compute, stream bindings, and mesh/WebSocket resources may require asynchronous cleanup.

Normal stop disables timer and trigger intake, waits for tracked dispatches, and aborts at `DEFAULT_STOP_GRACE_MS` (`5_000`) if work remains. Owner-off and emergency modes abort immediately. Cleanup runs in reverse startup order and continues after individual failures. `DaemonHost` applies this teardown to every loaded agent on `SIGINT` and `SIGTERM` before stopping compute and removing its pid file.

See [Lifecycle Assembly Contract](lifecycle-assembly.md) for the shared contract and profile matrix.

## MCP

Daemon MCP setup reads global registrations from the `mcpServers` settings key and per-agent server declarations from the agent config.

The builder supports:

- Registered Studio-style MCP servers
- Agent-level MCP server declarations with `source`
- Environment variables from settings registrations
- Per-agent secrets resolved from `adf_identity`
- npm package resolution through `mcp-servers`
- `uvx` package resolution when `uv` is needed
- Optional Podman stdio transport when compute routing containerizes the server

If a server is declared by the agent but is not registered in settings and has no source, the daemon skips it instead of failing the agent build.

## Channel Adapters

Daemon channel adapter setup reads adapter registrations from the `adapters` settings key and agent-level adapter config from `config.adapters`. Built-in registrations for Telegram and email are injected automatically, so agents can use those adapter types without an explicit settings registration.

Built-in adapter factories:

- `telegram`
- `email`

External adapters can be loaded from installed npm packages when the registration includes `npmPackage`.

Started adapters write inbound messages to the agent inbox and emit inbound events. The daemon trigger evaluator turns those inbound events into `on_inbox` trigger dispatches.

## Compute

The daemon wires `PodmanService` into the runtime builder and the HTTP API.

Compute capabilities:

| Capability | Requirement |
|------------|-------------|
| Shared compute | Podman service available |
| Isolated compute | `config.compute.enabled` and Podman service available |
| Host access | `config.compute.host_access` plus compute routing settings |

When isolated compute is enabled, the builder starts the isolated container and ensures the workspace path is available. MCP servers may also be routed through shared or isolated containers depending on compute routing settings.

Default compute settings include a Debian-based Node image, common shell utilities, Python, Git, Chromium, and browser dependencies.

## Mesh Serving

The daemon starts the same `MeshServer` used by Studio. When an agent is loaded, the daemon registers it as servable with `MeshManager.registerServableAgent(...)`.

Registered daemon agents can serve:

- Static public files
- Shared workspace files
- API lambdas
- Mesh inbox, card, health, and WebSocket endpoints

For an agent with handle `example-agent`, the mesh root is:

```text
http://127.0.0.1:7295/agents/example-agent/
```

Mesh serving also registers messaging tools such as `msg_send` and `agent_discover`, so API lambdas can use mesh messaging when mesh is enabled.

## Created Child Agents

When a daemon-loaded agent calls `sys_create_adf`, `RuntimeService` marks the child config as reviewed when the daemon has a writable settings store. If the tool request sets `autostart: true`, the daemon loads the created `.adf` with the review gate bypassed for that parent-created file and triggers its startup turn when its `start_in_state` is `active`.

## Known Architecture Gaps

The daemon runtime does not yet provide:

- Full file-change trigger semantics without Studio's editor/document source
- Conflict coordination with a simultaneously running Studio process

These are runtime architecture gaps, not ADF file format gaps.
