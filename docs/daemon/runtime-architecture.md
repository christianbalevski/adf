# Daemon Runtime Architecture

The daemon is the headless ADF runtime that serves an API. Internally, it is built around three layers:

- `RuntimeService` owns loaded-agent indexes, review gates, autostart scanning, API-facing operations, and runtime events.
- `AgentRuntimeBuilder` prepares daemon-specific tools and services such as MCP, adapters, compute, system scope, and stream bindings.
- `assembleAgent(..., profile: 'daemon')` creates and owns the executor, session, trigger evaluator, managers, startup sequence, dispatch tracking, and teardown lifecycle.

The daemon process in `src/main/daemon/index.ts` wires these together with settings, providers, Podman compute, mesh serving, MCP package resolution, channel adapter resolution, and the HTTP host.

This is the same canonical assembler used by Studio and lightweight headless callers. The exhaustive profile data declares which observable subsystems differ; daemon construction is no longer an independent lifecycle recipe.

## Process Startup

The daemon is `adf daemon` (npm package `@agentdocumentformat/cli`; `adf` and
`adf daemon start` launch it detached in the background), or `npm run daemon`
from a source checkout:

```bash
node scripts/rebuild-for-node.mjs && tsx src/main/daemon/index.ts
```

The rebuild step matters in a checkout because Studio runs under Electron while the daemon runs under Node. Native modules such as `better-sqlite3` must match the current runtime ABI. The npm package ships prebuilt Node binaries.

Startup flow (`src/main/daemon/index.ts`; the module boots on import):

1. Install signal and fatal-error handlers (errors are logged, never fatal; signals run a bounded shutdown).
2. Read host, port, pid file and settings path from the environment (`adf daemon --host/--port/--settings` set them).
3. Load settings with `FileSettingsStore` and create the `DaemonEventBus` (1000-frame replay buffer).
4. Load or mint the daemon's envelope key (`runtime-enc-key`) and the API access token (`daemon-token`, unless `ADF_DAEMON_TOKEN` is set). Failing to write the token is fatal.
5. Open the owner identity (`DaemonIdentity`: OS keychain, or the passphrase file unlocked from `ADF_OWNER_PASSPHRASE[_FILE]`) and wire the provider-key vault and workspace identity hooks.
6. Create shared runtime services: code sandbox, Podman compute, mesh manager (enabled unless `meshEnabled` is `false`), WebSocket manager, mesh server, MCP and adapter package resolvers.
7. Create `AgentRuntimeBuilder` (selects the `daemon` profile when it builds an agent), `RuntimeService`, `DaemonAgentFactory` and `DaemonHost`.
8. `DaemonHost.start()` writes the pid file, binds the HTTP API (refusing a non-loopback host without `ADF_DAEMON_TOKEN`), and emits `daemon.started`.
9. In the background: install the sandbox standard library, start the shared compute container after five seconds, and start the mesh server once a reachable agent registers (unless `meshServerEnabled` is `false`).
10. Autostart eligible agents from `trackedDirectories`, emit `daemon.autostart.report`, then sweep stale WAL sidecars.

While any loaded agent is `degraded` on locked credentials, the daemon re-checks
once a minute, and immediately whenever the owner identity becomes ready.

## RuntimeService

`RuntimeService` is the headless lifecycle boundary. It keeps an in-memory map from agent ID to managed agent, plus a file-path index so one `.adf` file is not loaded twice by the same daemon process.

Current responsibilities:

- `loadAgent(filePath)` opens an `.adf`, resolves the provider, obtains an assembled `daemon` handle from the builder, attaches the daemon host, and registers it.
- `unloadAgent(agentId)` detaches the host, awaits `disposeAsync()`, and removes file indexes.
- `createAgent(...)` is the compatibility fallback for tests and harnesses. It delegates to the same `headlessLive` assembler as direct lightweight construction; it is not another lifecycle profile or recipe.
- `startAgent(agentId)` invokes the assembled handle's once-only startup dispatch when `start_in_state` is `active`; `startOrLoadAgent(identifier)` first loads an unloaded agent found by id, handle or name in the tracked directories (or by `.adf` path).
- `stopAgent(agentId)` unloads the agent through canonical asynchronous teardown.
- `interruptAgent(agentId, loop?)` ends one loop's running turn and leaves it `idle`; `abortAgent(agentId, loop?)` hard-aborts it (the executor stays stopped).
- `sendChat(agentId, text, loop?)` creates a chat dispatch object (source `user`, the owner's voice) and submits it through the assembled handle, to `main` or an inner loop.
- `trigger(agentId, dispatch)` submits an `AdfEventDispatch` or `AdfBatchDispatch` through the same boundary.
- `autostartFromDirectories(...)` scans tracked directories for `.adf` files and starts eligible agents.
- `getAgent`, `listAgents`, `getAgentStatus`, `getAgentLoop` and `getAgentChat` expose runtime state to HTTP clients.
- Loop methods list, create, patch and delete inner loops through the agent's loop pool (the `loop_manage` path), and compact one loop on demand.
- Resource methods read and write config, files, inbox, outbox, timers, meta, logs and tables.
- Credential methods write identity values (refusing with `credentials_locked` while the envelope is locked, unless `replace`) and return metadata only; `refreshAgentCredentials` unlocks degraded agents in place.
- Task and human-in-the-loop methods expose tasks, resolve, always-approve and approve-all, pending asks and answers, and suspend responses, across `main` and running inner loops.
- Diagnostics methods expose adapters, MCP, triggers, WebSocket state, tools and context breakdowns.
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

The daemon owns a `DaemonEventBus` that assigns a monotonically increasing transport `cursor`, keeps a bounded in-memory event buffer, and notifies live subscribers. Each buffered frame is `{ cursor, event }`, where `event` is the canonical umbilical envelope also delivered to in-process agent taps — the daemon does not reshape it.

The HTTP API exposes the bus through:

```text
GET /events
GET /events?agentId=agent-id
GET /events?since=42
```

[docs/guides/umbilical-events.md](../guides/umbilical-events.md) is the canonical catalog of published event types and payload shapes. The buffer holds the last 1000 frames of all agents, for clients that reconnect with a `since` cursor; see [the event stream](api-guide.md#the-event-stream) for resume, dedupe and gap handling. Durable history still lives in the `.adf` file and is exposed through APIs such as `/agents/:id/chat` and `/agents/:id/loop`.

## HTTP Host and Request Guard

`DaemonHost` owns the Fastify server built by `createDaemonHttpApi`
(`src/main/daemon/http-api.ts`, plus `identity-routes.ts`, `template-routes.ts`,
`provider-routes.ts` and `context-routes.ts`). Every request passes
`DaemonRequestGuard` (`request-guard.ts`) first: the `Host` allow-list, the
`Origin` / `Sec-Fetch-Site` browser check, then the bearer token
(`daemon-token.ts`) on everything but `GET /health`. Identity routes that move
secrets and `POST /daemon/shutdown` additionally require a loopback peer. See
[Base URL and authentication](api-guide.md#base-url-and-authentication).

## Review Gate

The review gate prevents untrusted `.adf` files from being autostarted invisibly.

Autostart checks:

- The file can be scanned for boot status.
- `autostart` is enabled.
- The file is not password protected.
- The agent has been reviewed on this machine (recorded in the `reviewedAgents` setting).

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

Normal stop (`POST /agents/:id/stop`) disables timer and trigger intake, waits for tracked dispatches, and aborts at `DEFAULT_STOP_GRACE_MS` (`5_000`) if work remains. Owner-off and emergency modes abort immediately. Cleanup runs in reverse startup order and continues after individual failures. Daemon shutdown (`SIGINT`, `SIGTERM`, `adf daemon stop` / `POST /daemon/shutdown`) flushes token usage, closes the HTTP server, unloads every agent in immediate mode under a per-agent deadline, stops compute, runs the remaining shutdown hooks (WebSockets, mesh, sandboxes, child processes, WAL sweep), and removes its pid file, all within a 20-second budget.

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

Daemon channel adapter setup reads adapter registrations from the `adapters` settings key and agent-level adapter config from `config.adapters`. Built-in registrations for Telegram and email are injected automatically, so agents can use those adapter types without an explicit settings registration. Registrations describe *how to load* an adapter; credentials come only from the agent's `adf_identity` rows (`adapter:{type}:{KEY}`) — the registration's `env` and `credentialStorage` fields are deprecated and ignored.

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
