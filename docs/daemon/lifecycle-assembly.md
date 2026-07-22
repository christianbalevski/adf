# Lifecycle Assembly Contract

ADF has one canonical agent assembly path. Studio foreground, Studio background, the daemon, and lightweight headless callers select an explicit capability profile and receive an assembled-agent handle. Foreground/background movement transfers that handle; it does not reconstruct the agent.

This contract keeps lifecycle behavior consistent while preserving deliberate differences between hosts.

## Construction and Dispatch

Production code has one `new AgentExecutor(...)` call site in `assemble-agent.ts`. The call site is reusable: one agent may invoke the assembler N times with derived configuration when loop coordination is introduced. The invariant is one construction recipe, not one executor instance.

Hosts submit work only through the assembled handle:

```ts
dispatch(
  dispatch: AdfEventDispatch | AdfBatchDispatch,
  options?: DispatchOptions,
): Promise<void>
```

The argument is always a dispatch object, never a bare message. This boundary is the future loop router's interposition seam: loop selection can happen before executor delivery without changing host APIs. Hosts must not call `executeTurn()` directly.

Dispatch is accepted only while the handle is `running`. Calls made while `created` or `starting` reject; startup work is performed by the assembler's explicit once-only startup sequence, not by an incidental early-work queue. Calls also reject after stopping begins.

## Profiles Are Exhaustive Data

Capabilities and profiles live as data in one module. `AGENT_CAPABILITIES` defines the complete capability union, and every entry in `AGENT_PROFILES` satisfies `Record<AgentCapability, boolean>`. Adding a capability therefore fails typechecking until every profile takes an explicit position on it.

The profiles are:

- `studioForeground`
- `studioBackground`
- `daemon`
- `headlessLive`
- `benchmark`

Profiles enumerate observable subsystems such as timers, code and system scope, compute, MCP and MCP-management tools, adapters, npm tools, shell support, stream bindings, umbilical taps, and mesh/WebSocket integration. `headlessLive` enables timers; `benchmark` disables them explicitly when polling would distort measurements.

The runtime fallback is not a sixth profile or construction path. It is a compatibility adapter that delegates to the same `headlessLive` assembler used by direct headless callers. Its test surface is delegation equivalence, not another lifecycle matrix column.

## Handle and Host Attachment

An assembled handle owns stable executor, session, workspace, registry, evaluator, and manager references. `attachHost()` atomically replaces the single owning host attachment and returns an idempotent detach token. Telemetry observers are independent subscriptions and do not compete for host ownership.

Host attachment is framework-neutral: it contains no Electron window or daemon socket types. Reattaching a Studio window and reconnecting a daemon client are the same operation—bind a new host to a running agent without stopping it, reconstructing it, or disturbing in-flight turns and human-in-the-loop state.

Studio handoff also transfers workspace-close ownership on the same stable handle. Background ownership closes the workspace during handle disposal; foreground ownership leaves the visible document open for the Studio file lifecycle to close. This direction-sensitive ownership prevents both background leaks and foreground use-after-close failures.

Lifecycle states are `created`, `starting`, `running`, `stopping`, `stopped`, and `disposed`. `start()`, `stop()`, and `disposeAsync()` are idempotent and concurrency-safe; callers share an active lifecycle promise. A stopped or disposed handle cannot restart.

Synchronous `dispose()` is exposed only by sync-safe headless and benchmark types. Conditional types omit it from profiles with asynchronous teardown, and a runtime invariant rejects any supposedly sync-safe profile that enables MCP, adapters, taps, or another asynchronous teardown subsystem.

## Shutdown Modes

`DEFAULT_STOP_GRACE_MS` is `5_000` and is defined beside the shutdown mode types.

- Normal stop disables timer and trigger intake first, waits for tracked dispatches, and aborts remaining work at the grace deadline.
- Owner-off stop aborts immediately.
- Emergency stop aborts immediately.

Cleanup runs in reverse startup order and continues after individual teardown errors. `disposeAsync()` is the canonical teardown for full profiles.

## Startup, Recovery, and Characterization

Core startup failures reject and roll back acquired resources. Optional MCP, adapter, and compute failures retain their degrade-and-log behavior. Configured `on_startup` targets and the default active-state startup turn each execute at most once; Studio's pending-user-message suppression remains explicit.

Checkpoint recovery is a permanent conformance fence, not a temporary test for a known bug. Every construction profile must pass seeded stale-checkpoint recovery, and CI must retain a real child-process crash/reopen test regardless of whether the current implementation is believed to have fixed the underlying issue.

Characterization differences are recorded in a ledger and must terminate as either `fixed` or `declaredByProfile`. The completed migration ledger is closed with **9 findings: 6 `fixed`, 3 `declaredByProfile`, and 0 `pending`**. The production status type intentionally has no `pending` member, and a verbose CI assertion independently verifies those terminal counts. This makes both source-level additions and runtime data drift fail before migration observations can become undocumented behavior.

## Ownership Bridge Removal

The migration used a temporary ownership bridge so legacy Studio aliases could reference assembled resources without owning them. Dispose-counting conformance fakes enforce the bridge's defining rule: teardown through competing entry points, including repeated and concurrent calls, disposes every shared resource exactly once.

That bridge is no longer production machinery. The final architecture gate scans production source and fails if its named identifiers or raw-adoption helper return. The same gate enforces the single `AgentExecutor` construction call site and the single evaluator-to-`dispatch()` wiring path. This removal check prevents compatibility scaffolding from becoming another permanent lifecycle implementation.

## Conformance Matrix

The main lifecycle matrix covers Studio foreground, Studio background, daemon through `RuntimeService` and the builder, live headless, and the benchmark profile where capability differences matter. Foreground/background handoff and the file-changed-during-startup race are transfer scenarios, not construction columns.

In addition to profile-specific registry and event expectations, the suite verifies startup once-semantics, timer ordering, dispatch refusal outside `running`, exact-once disposal, partial-start rollback, repeated handoff without listener leaks, shutdown modes, stale-checkpoint recovery, and compatibility of IPC, runtime events, mesh registration, persisted `.adf` data, and synchronous headless call signatures.
