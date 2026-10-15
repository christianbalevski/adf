# Studio on the Daemon Backend: Tracker

**Design**: [daemon-backend.md](daemon-backend.md) · **Branch**: `feat/daemon-backend`

Section references (§n) point into the design. Each workstream is sized for one subagent in one focused session. Workstreams in the same wave run in parallel; a wave starts when the workstreams it depends on are merged.

## 1. Rules for every workstream

- Type-check: `npx tsc --noEmit -p tsconfig.node.json`. About 186 errors exist on `main`; the count MUST NOT grow. Report before/after counts.
- Tests run through Electron-as-Node: `ELECTRON_RUN_AS_NODE=1 <electron.exe> node_modules/vitest/vitest.mjs run <paths>`.
- Fixtures use handles/names `agent-1`, `agent-2`, ids are UUIDs.
- Embedded code changes only under Rules E1-E3 (design §3.2). Each E1 extraction lands with its characterization test in the same commit, test first.
- Every new daemon route goes into a new or owned `src/main/daemon/routes/*-routes.ts` module and is registered in `src/main/daemon/routes/index.ts` (append one line). It MUST be documented in `docs/daemon/openapi.json` in the same change; `tests/openapi-coverage.test.ts` MUST pass. `openapi.json` edits add entries only; no reformatting.
- No silent actions: every automatic action (spawn, attach, lease skip, handover move, shutdown) is logged and, where the user triggered the flow, shown in the UI.
- Docs follow `docs/STYLE.md`.
- Each workstream ends with an adversarial review by a separate agent using the "Review focus" list, before merge.

## 2. File ownership

A file listed here MUST be edited only by its owner in that wave. Others request changes from the owner (an interface named in the owner's acceptance criteria) or wait.

| File | W0 | W1 | W2 | W3 | W4 |
|---|---|---|---|---|---|
| `src/main/ipc/index.ts` | W0-C (lease hunks) | none | none | W3-A (E1 extractions only) | none |
| `src/main/runtime/background-agent-manager.ts` | W0-C (lease hunks) | W1-F | none | none | none |
| `src/main/runtime/runtime-service.ts` | W0-C (lease hunks) | W1-A | W2-A | none | W4-A (reload hook) |
| `src/main/runtime/agent-runtime-builder.ts` | none | W1-B | none | none | none |
| `src/main/daemon/http-api.ts` | W0-D (route hook) | none | W2-A (resource routes on open documents) | none | none |
| `src/main/daemon/routes/index.ts` | W0-D creates | append-only, all | append-only, all | append-only, all | append-only, all |
| `src/main/daemon/index.ts` | W0-D | W1-C | W2-B | none | W4-A |
| `src/main/daemon/daemon-identity.ts` | none | W1-C | none | none | none |
| `src/main/runtime/mesh-manager.ts` | none | W1-B | none | none | none |
| `docs/daemon/openapi.json` | append-only, all (lead merges serially) | same | same | same | same |
| `src/main/index.ts` | W0-E | none | W2-C | none | W4-A |
| `src/preload/api.ts`, `src/preload/index.ts` | W0-E (additive) | none | none | none | W4-B (additive) |
| `src/shared/constants/ipc-channels.ts` | W0-E (additive) | none | none | none | W4-B (additive) |
| `src/main/backend/channel-map.ts` | W0-A | none | W2-C | W3-* append handler refs via own files | W4-B |
| `src/main/tui/api/**`, `src/shared/daemon-client/**` | W0-B | none | W2-B (client-session methods) | none | none |
| `electron.vite.config.ts`, `electron-builder.yml` | W0-D | none | none | none | none |
| `src/main/backend/daemon-mode/**` | W0-E (stub) | none | W2-C | W3-* (own subfolders) | W4-A, W4-B |
| `tests/parity/**` | W0-F | none | W2-C (daemon side) | W3-* (own scenario files) | W5-A |

## 3. Status

| ID | Workstream | Wave | Depends on | Status |
|---|---|---|---|---|
| W0-A | Channel map and settings-key classes | 0 | none | MERGED |
| W0-B | Shared daemon client | 0 | none | MERGED e23ec054 |
| W0-C | Agent lease and runtime host registry | 0 | none | MERGED |
| W0-D | Daemon packaging, process control, `/version`, route hook | 0 | none | MERGED |
| W0-E | Backend selection at boot, Settings → Backend | 0 | W0-A (merge order) | MERGED c0305508 |
| W0-F | Parity harness, embedded side | 0 | none | MERGED |
| W1-A | RuntimeService parity hooks | 1 | W0-C, W0-D | MERGED |
| W1-B | AgentRuntimeBuilder and mesh parity | 1 | W0-D | MERGED |
| W1-C | Daemon identity: runtime adoption, unlock cascade, app OAuth store, owner import | 1 | W0-D | MERGED |
| W1-D | Gap routes: approvals, fleet, dashboard, registries, MCP probes | 1 | W0-D | MERGED |
| W1-E | File-level ops, raw file routes, tracked-dir watcher | 1 | W0-D, W0-C | MERGED |
| W1-F | E1 extraction: background event mapping | 1 | W0-F | MERGED (squashed) |
| W1-G | Compute ownership: a runtime stops only containers it started | 1 | none | MERGED |
| W2-A | Open documents | 2 | W1-A, W1-E | MERGED |
| W2-B | Client sessions and client event stream (+ TUI on client sessions) | 2 | W1-A, W0-B | MERGED |
| W2-C2 | Studio main switches from the interim `/events` adapter to W2-B client sessions (focus, holds, reattach, gap) | 2 | W2-B, W2-C | MERGED |
| W2-C | Daemon-mode core in Studio main | 2 | W0-A, W0-B, W0-E, W1-F | MERGED |
| W3-A | Proxy: files, documents, agent runtime, review, templates | 3 | W2-A, W2-B, W2-C | MERGED |
| W3-B | Proxy: settings, providers, models, subscription auth, identity, credentials | 3 | W2-C, W1-C | MERGED |
| W3-C | Proxy: MCP, adapters, sandbox packages, skills, registries | 3 | W2-C, W1-D | MERGED |
| W3-D | Proxy: mesh, fleet, dashboard, tools, token usage, compute, emergency stop | 3 | W2-C, W1-D | MERGED |
| W3-E | TUI on client sessions — folded into W2-B (owner, 2026-10-14) | 2 | — | IN W2-B |
| W3-F | MERGED. Multi-client write conflicts: revisions + `If-Match` on config/document/file writes, `409 stale_revision`, "changed elsewhere" handling in Studio and TUI editors. Baseline (embedded today): an external (agent) write replaces the open tab and discards unsaved local edits (`editor-tabs.store.ts` `updateTabFromExternal`), and the save layer drops a pending autosave (`lastExternalWrite`). Another client's save arrives through the same path, so parity holds without W3-F; W3-F is an improvement for both modes | 3 | W2-A, W2-B | TODO |
| W4-A | Mode switch, handover, quit behaviour | 4 | W3-A, W3-B, W1-C, W0-D, **W1-G (hard)** | MERGED |
| W4-B | Remote mode | 4 | W3-A … W3-D | MERGED |
| W4-C | Documentation | 4 | W4-A | TODO |
| W5-A | Full parity run and triage | 5 | W4-A | TODO |
| W5-B | OS matrix, packaging, Defender, soak | 5 | W4-A | TODO |

## 4. Workstreams

### Wave 0

#### W0-A Channel map and settings-key classes

- **Goal**: design D2 and §4.1 as code.
- **Owns**: `src/main/backend/channel-map.ts`, `src/shared/constants/client-settings-keys.ts`, `tests/backend/channel-map.test.ts`, `tests/backend/settings-key-classes.test.ts`.
- **Deliverables**: every invoke and push channel in `ipc-channels.ts` (plus `ORBITAL_CACHE_*`, `OPEN_FILE_GET_PENDING`, `APP_*FULLSCREEN`, updater and spellcheck channels registered outside `ipc/index.ts`) classified `local | proxied | remote-variant | remote-unsupported`, with the daemon route(s) or the gap workstream ID per `proxied` channel. `CLIENT_SETTINGS_KEYS` per §4.1.
- **Acceptance**: `satisfies Record<…>` makes an unclassified channel a compile error; a test greps `src/` for `settings.get('…')`/`readAppSetting('…')` keys and fails on a key in neither class; the map's gap list is reconciled with the ~60 gaps in the briefing and each gap names its W1 workstream.
- **Review focus**: channels that look Electron-local but read workspace or settings state (e.g. `FILE_SHARE_DRAG_START` builds a snapshot from the workspace); backend keys read in Studio main that would silently go stale; the raw `'stdlib-install-progress'` string channel.

#### W0-B Shared daemon client

- **Goal**: D8.
- **Owns**: `src/shared/daemon-client/**`, `src/main/tui/api/**` (become re-exports), `src/main/cli/daemon-url.ts` (provider implementation), `scripts/build-npm.mjs` if the bundle needs it.
- **Acceptance**: no `node:` or `fs` import under `src/shared/daemon-client` (test); timeouts configurable per call; SSE client accepts an arbitrary path and query (for W2-B); all existing TUI tests pass; `npm run build:npm` succeeds; the token is attached only to the configured origin (test, including after `withBaseUrl`).
- **Review focus**: ESM/CJS interop (`tui/package.json` is `"type":"module"`, `interop.ts`); 401 re-read of the local token sending a local token to a remote URL; behaviour change in the TUI.

#### W0-C Agent lease and runtime host registry

- **Goal**: design §10.
- **Owns**: `src/main/runtime/agent-lease.ts`, `tests/runtime/agent-lease.test.ts`, `src/main/cli/daemon-control.ts` (conflict check); E2 hunks in `ipc/index.ts` (`AGENT_START` fresh path, `tryAutostart`, `performAdfRename`, dispose points), `background-agent-manager.ts` (`doStartAgent`, dispose), `runtime-service.ts` (`loadAgent`, `unloadAgent`).
- **Acceptance**: tests for two processes racing on one file (one wins, the other gets `agent_leased`), stale pid takeover, rename re-key, release on every failed-start return path, foreground↔background hand-off keeps the lease, Windows path-case canonicalization; embedded start shows the `agent_leased` sentence in the existing error UI; the daemon autostart report lists `leased_elsewhere`; `adf daemon start` while a `local`-mode Studio runs is not refused; while an embedded Studio on the same settings runs it is refused.
- **Review focus**: lease leak on exceptions between acquire and assemble; `tryAutostart` parallelism; PID reuse; lease dir resolution differing between Studio (Electron `app.getPath`) and Node.

#### W0-D Daemon packaging, process control, `/version`, route hook

- **Goal**: §8.1, §8.2 mechanics.
- **Owns**: `electron.vite.config.ts`, `electron-builder.yml`, `src/main/backend/daemon-process.ts`, `src/main/daemon/daemon-host.ts`, `src/main/daemon/routes/index.ts` (new), `src/main/daemon/routes/meta-routes.ts` (new), one-line hook in `http-api.ts`, version plumbing in `daemon/index.ts`.
- **Acceptance**: `npm run package` output contains `out/main/daemon.js`; `daemon-process.ts` can spawn (detached, `windowsHide`, `ELECTRON_RUN_AS_NODE=1`, CLI pid file path), detect, attach and stop a daemon, unit-tested with a fake spawner; a manual run on Windows starts the packaged daemon and runs `agent-1` through one turn with a mock provider; `GET /version` returns non-null `version` and `clientApiVersion`; `adf daemon status` sees the Studio-spawned daemon.
- **Review focus**: env passed to the child (no secrets, no `ELECTRON_*` besides `RUN_AS_NODE`); zombie/orphan processes on Studio crash; Windows Defender behaviour on a long-lived Electron-as-Node process (see risk K1); `NoDefaultCurrentDirectoryInExePath` and Spectre packaging prerequisites.

#### W0-E Backend selection at boot, Settings → Backend

- **Goal**: D9, the `studio-backend.json` file, and the UI to choose a mode (actions disabled until W4-A).
- **Owns**: `src/main/index.ts` (boot branch before `registerAllIpcHandlers`), `src/main/backend/backend-config.ts`, `src/main/backend/daemon-mode/index.ts` (stub that registers `local` channels only), additive members in `src/preload/api.ts` and `src/preload/index.ts`, additive channels in `ipc-channels.ts` (classified in the channel map after W0-A merges), renderer `components/settings/BackendSettings.tsx` (new) and its single insertion in `SettingsPage.tsx`.
- **Acceptance**: with no `studio-backend.json` Studio boots embedded with zero behaviour change (parity harness smoke); the mode field persists; the token is stored `safe:`; an env override `ADF_STUDIO_BACKEND=embedded` exists for recovery and is documented.
- **Review focus**: any code path in embedded boot that now runs differently; token visible in logs or renderer.

#### W0-F Parity harness, embedded side

- **Goal**: design §12 item 2, embedded half.
- **Owns**: `tests/parity/**` (harness, normalizer, mock provider, fixtures, first scenarios).
- **Acceptance**: three deterministic scenarios against `registerAllIpcHandlers`: open `agent-1`, start it, one chat turn with tool call through the mock provider; recorded invoke results and push sequences are stable across 10 runs; the normalizer's rules are listed in one file.
- **Review focus**: over-normalization that hides real differences; dependence on the developer's real settings or keychain (must use `ADF_USER_DATA_DIR`, `ADF_LEASE_DIR`, `ADF_SECRET_STORE=file`).

### Wave 1

#### W1-A RuntimeService parity hooks

- **Goal**: daemon-side hooks other workstreams consume.
- **Owns**: `src/main/runtime/runtime-service.ts`, its tests.
- **Deliverables**: `agent-lifecycle` emits (`agent_starting`, `agent_started`, `agent_start_failed`, `agent_stopping`, `agent_stopped`, `agent_loops_changed`, display-state `agent_state_changed`); host attachment forwards trigger events, trigger errors and startup-dispatch failures; `rekeyAgentPath(old, new)`; derived-key propagation callback to builder-created consumers; `409 duplicate_agent_id`; `config.name` ← basename on load; `preflightProvider(agentId)` returning `provider_missing`/`provider_unconfigured`; prompt settings read at use.
- **Acceptance**: unit tests per item; no change to the existing umbilical `/events` output (snapshot test).
- **Review focus**: emitting lifecycle events from inside `inFlightLoads` dedupe; event ordering between `agent_started` and the first executor event.

#### W1-B AgentRuntimeBuilder and mesh parity

- **Goal**: design §6 rows owned by the builder and mesh.
- **Owns**: `src/main/runtime/agent-runtime-builder.ts`, `src/main/runtime/mesh-manager.ts`, their tests.
- **Deliverables**: shared `ensureCoreToolDeclarations` (E1: delete the private copy); MCP reconcile on config change; keep MCP manager on setup failure; derived-key consumers (provider, MCP, adapters, `AdfCallHandler`) with restart after unlock; full mesh registration (message bus, `isMessageTriggered`, config updates); umbilical taps on (or a written reason); interactive MCP OAuth as a HIL request carrying the authorize URL.
- **Acceptance**: tests per row; a mesh-triggered turn between `agent-1` and `agent-2` in one daemon behaves as in Studio (harness scenario stub ready for W5-A).
- **Review focus**: `registerServableAgent` callers that relied on no message-bus subscription (double delivery); OAuth HIL request lifetime vs agent teardown.

#### W1-C Daemon identity

- **Goal**: design §5.3, §5.4 daemon side.
- **Owns**: `src/main/daemon/daemon-identity.ts`, identity section of `src/main/daemon/index.ts`, `src/main/daemon/identity-routes.ts`, new `DaemonAppOAuthStore` in `src/main/services/mcp-oauth-store.ts` (new class only; `AppSettingsOAuthStore` untouched), `src/main/cli` `identity import` command.
- **Deliverables**: read and verify keychain account `studio-runtime:<scope>`; settings mapping to Studio runtime keys when valid; unlock cascade Studio enc key → daemon enc key → owner key; no minting while adopted; app-level MCP OAuth store on the secret backend; local-only `POST /identity/import`; mesh `/ping` reports the runtime DID the daemon actually signs with.
- **Acceptance**: tests: valid adoption; forged delegation (wrong issuer), subject mismatch, enc-key mismatch each rejected with a log line; review scenario `mine` for a file created by embedded Studio and opened by the adopted daemon; a file created by the adopted daemon opens unlocked in embedded Studio without the owner key; keychain-less fallback keeps daemon runtime.
- **Review focus**: any path that writes `runtimeDid`/`runtimeDelegation` from the daemon into the shared settings file; `ensureRuntimeKey` re-signing with the wrong owner; key material in logs or HTTP responses.

#### W1-D Gap routes

- **Goal**: daemon routes for `proxied` channels without equivalents, per the W0-A gap list, excluding file ops (W1-E), documents (W2-A) and client sessions (W2-B).
- **Owns**: new `src/main/daemon/routes/{approvals,fleet,dashboard,registry,catalog,mcp-admin,credentials}-routes.ts` and tests.
- **Deliverables** (from the briefing gap list): approvals hub snapshot and resolve; fleet/mesh stats; dashboard; agent registry; skills catalog; MCP registry, probe, registration test, OAuth status; credential-list-files; owner envelope, attestations, identity drafts.
- **Acceptance**: each route returns the shape the Studio handler returns today, verified by a shape test against the embedded handler's output for the same fixture.
- **Review focus**: routes that expose secrets (credential files, OAuth status must stay metadata-only); routes that do network I/O on the request path without timeouts.

#### W1-E File-level ops, raw file routes, tracked-dir watcher

- **Goal**: file operations and transfers in the daemon.
- **Owns**: `src/main/daemon/routes/file-routes.ts`, `src/main/daemon/tracked-dirs.ts`, new `src/main/daemon/dir-watcher.ts`, tests.
- **Deliverables**: save-as, clone (with `clone-fixup`), delete, rename (uses `rekeyAgentPath` from W1-A and the lease re-key), share snapshot; `GET/PUT /agents/:id/files/raw` (octet-stream, per-route `bodyLimit`); `POST /files/import`; `GET /agents/:id/export` (SQLite backup API); `GET /fs/browse`; chokidar watcher with autostart of new files and a `tracked_dirs` push source.
- **Acceptance**: tests per route including a 20 MiB raw upload; rename while running keeps the agent, its lease and its mesh registration; export of a running agent yields a file that opens with an integrity check.
- **Review focus**: path traversal in `/fs/browse` and raw file paths; deleting a running agent; watcher event storms on large trees.

#### W1-F E1 extraction: background event mapping

- **Goal**: one pure mapping from executor/host events to background events, used by BAM now and by the bridge in W2-C.
- **Owns**: `src/main/runtime/background-agent-manager.ts` (mapping sections 1035-1071 and 1918-1955), new `src/main/runtime/background-event-mapping.ts`, characterization test.
- **Acceptance**: characterization test written first against current BAM output for a recorded event sequence; identical after extraction; embedded parity harness unchanged.
- **Review focus**: subtle differences between the two existing mapping sites (adopted vs started agents) being merged into one.

#### W1-G Compute ownership

- **Goal**: with two runtimes on one machine (embedded Studio, local daemon, CLI daemon), a graceful shutdown stops only the containers that runtime started or is using.
- **Owns**: `src/main/services/podman.service.ts` (`stopAll` and container bookkeeping), its tests.
- **Background**: `PodmanService.stopAll` stops every running managed `adf-*` container. On 2026-10-14 a test daemon's shutdown stopped six of the owner's live agent containers. Embedded Studio's quit has the same effect on a daemon's containers today.
- **Acceptance**: tests with a fake podman: runtime A's shutdown leaves runtime B's containers running; the shared `adf-mcp` container is stopped only when no other live runtime uses it (lease or host-registry check from W0-C); the log line names what was stopped and what was left.
- **Review focus**: orphaned containers after a crash (nobody stops them); the shared container's lifetime with several runtimes.

### Wave 2

#### W2-A Open documents

- **Goal**: design D4.
- **Owns**: `src/main/runtime/runtime-service.ts`, resource-route section of `src/main/daemon/http-api.ts`, new `src/main/runtime/document-host.ts`, tests.
- **Acceptance**: every `/agents/:id/*` resource route works on an open, not-running document (table-driven test over the route list); start on an open document reuses the workspace; stop keeps it open while held; open documents are invisible to mesh, timers and autostart; a held document is released when its session expires (with W2-B's hook).
- **Review focus**: two handles to one workspace (document + runtime); writes to a document while a runtime starts (`pickFresherConfig` race, `config-freshness.ts`); password-protected documents.

#### W2-B Client sessions and client event stream

- **Goal**: design D5.
- **Owns**: new `src/main/daemon/client-sessions.ts`, `src/main/daemon/routes/client-routes.ts`, client-session methods in `src/shared/daemon-client/**`, client wiring in `src/main/daemon/index.ts`, `src/main/tui/**` (the terminal app on the session stream, owner 2026-10-14), tests.
- **Acceptance**: frames per agent in emission order; deltas only for the focused agent; per-session ring of 4096 with `stream.gap` on eviction and epoch change; session expiry releases documents; `exitDaemonWhenClosed` orphan rule (§8.3); delta frame latency p95 ≤ 50 ms on loopback measured by a test; the existing `/events` output is unchanged.
- **Acceptance (several clients, owner 2026-10-14)**: three concurrent sessions on one daemon, two focused on the same agent, receive the same non-delta frames per agent in the same order; both focused sessions get the deltas, the third none. A session that goes slow or disconnects mid-turn and resumes with `since=` gets the missed frames or a `stream.gap`; the others are unaffected and stay within the latency budget. A REST write by one client (config, document, file, inbox, HIL resolve) produces the matching frame on every other session (the writer's own echo is skipped, as in embedded Studio). A HIL request and its resolution reach every session. Fan-out is per session (D5.1).
- **Acceptance (terminal app, owner 2026-10-14)**: the TUI opens a session on connect and ends it on exit; its focus is the chat view's agent, which streams tokens whatever `umbilical.stream_deltas` says; other agents update from non-delta frames; frames map into the existing reducer; reconnect keeps backoff, idle watchdog and resume; `stream.gap` resyncs chat, agents and approvals; an older daemon or another `clientApiVersion` falls back to `/events`, logged once; all TUI suites pass (`--project tui --maxWorkers=4`); a Studio-like and a TUI session on one daemon see the same state.
- **Review focus**: memory growth with many agents and a slow client (back-pressure, drop policy must be a visible gap, never silent loss); executor event payload size (`tool_call_result` content).

#### W2-C Daemon-mode core in Studio main

- **Goal**: D1, D3, D6, §4.2 in Studio main.
- **Owns**: `src/main/backend/daemon-mode/{index,session,event-bridge,settings,adf-file}.ts`, `src/main/index.ts` (protocol handler branch), `src/main/menu.ts` ("Open daemon log"), `src/main/backend/channel-map.ts` (handler wiring), daemon side of `tests/parity/**`.
- **Deliverables**: handler registration from the channel map; `DaemonModeSession` (current file, focus, derived-key cache semantics); event bridge using `background-event-mapping.ts` and `BackgroundEventBatcher`; resync on `stream.gap`; settings split with `studio-client-settings.json`; `adf-file://` from `/agents/:id/files/raw`; native notifier, menu bar and approvals reveal fed from the stream.
- **Acceptance**: the three W0-F scenarios pass in daemon mode with zero diffs; a forced `stream.gap` produces the documented resync pushes; a disconnected daemon shows a visible "backend not connected" state and reconnects.
- **Review focus**: any handler that reads embedded module globals; push sends while the window is loading (`sendReveal` queueing); `APPROVALS_CHANGED` to all windows.

### Wave 3

Each W3 workstream implements the daemon-mode handlers for its channels in `src/main/backend/daemon-mode/<domain>/**` and adds parity scenarios in `tests/parity/<domain>/**`. Result shapes SHOULD be built in the handler from daemon data. Logic that must be shared with embedded mode is extracted from `ipc/index.ts` only by W3-A (E1), on request.

#### W3-A Files, documents, agent runtime, review, templates

- **Owns**: `src/main/backend/daemon-mode/documents/**`, `tests/parity/documents/**`, `src/main/ipc/index.ts` (E1 extractions only).
- **Channels**: `FILE_*`, `DOC_*`, `AGENT_*`, `BACKGROUND_AGENT_*`, review, templates, directory bulk, tracked dirs.
- **Acceptance**: parity scenarios: open/switch files with a running background agent; password-protected agent prompt and unlock; config edits during start; review accept of a foreign file; template create; rename while running; delete.
- **Review focus**: foreground/background hand-off semantics (design §3.1 D3) and `AGENT_START` reuse path equivalence; derived-key cache behaviour across file switches.

#### W3-B Settings, providers, models, subscription auth, identity, credentials

- **Owns**: `src/main/backend/daemon-mode/settings/**`, `…/identity/**`, `tests/parity/settings/**`, `tests/parity/identity/**`.
- **Acceptance**: provider add/edit with redacted keys round-trips; ChatGPT/Grok/Claude sign-in flows; identity panel shapes for each daemon identity status; reveal phrase via the shared keychain entry; per-agent credential set/replace with locked-envelope choices.
- **Review focus**: secrets crossing into the renderer; `__redacted__` written back as a key.

#### W3-C MCP, adapters, sandbox packages, skills, registries

- **Owns**: `src/main/backend/daemon-mode/mcp/**`, `…/adapters/**`, `tests/parity/mcp/**`.
- **Acceptance**: install-progress pushes match; MCP attach/detach/credential flows; adapter attach with Telegram fake; interactive OAuth HIL opens the authorize URL in the local browser.
- **Review focus**: long-running installs and request timeouts in the shared client; progress events for an install started before a reconnect.

#### W3-D Mesh, fleet, dashboard, tools, token usage, compute, emergency stop

- **Owns**: `src/main/backend/daemon-mode/mesh/**`, `…/compute/**`, `tests/parity/mesh/**`.
- **Acceptance**: fleet map statuses for 2 running + 1 stopped agent match; inter-agent message renders; emergency stop stops every agent in the daemon; compute phase pushes.
- **Review focus**: `MESH_FIREWALL_*` (local to the Studio host, hidden in remote); polling handlers that would hammer the daemon.

### Wave 4

#### W4-A Mode switch, handover, quit behaviour

- **Goal**: design §8.3, §11.
- **Owns**: `src/main/backend/handover.ts`, `src/main/backend/daemon-process.ts`, `src/main/index.ts` (quit path), `src/main/daemon/index.ts` and `runtime-service.ts` (credential reload hook, `POST /client/reload-credentials`), Settings → Backend actions.
- **Acceptance**: round trip embedded → local → embedded keeps ChatGPT, Grok and MCP OAuth sessions alive with a rotating-refresh fake (test); runtime identity entry written on first switch; client keys copied both ways; the switch dialog lists every moved item; `keepDaemonRunning` false/true behaviours; Studio crash orphan shutdown after 60 s; a CLI-started daemon is never stopped by Studio.
- **Review focus**: partial handover after a crash mid-move (each move MUST be idempotent and resumable, never leave zero copies); accounts conflict dialog.

#### W4-B Remote mode

- **Goal**: design §9.
- **Owns**: `src/main/backend/daemon-mode/remote/**`, additive preload members and channels for remote file transfer, channel-map `remote-variant` wiring.
- **Acceptance**: transport rule enforced (test matrix of URLs); token never sent to another origin; open via daemon-side picker; upload/download/export/drag-share via temp files; OAuth and ChatGPT relay through a local callback; every `remote-unsupported` action shows its sentence; tested against a daemon on another machine through an SSH tunnel and through `tailscale serve`.
- **Review focus**: plain-HTTP opt-in UX; leftover temp files with agent contents; large transfers blocking the main process (no sync work on main hot paths).

#### W4-C Documentation

- **Owns**: new `docs/guides/studio-backend.md`; updates to `docs/cli/remote-daemon.md`, `docs/daemon/operations.md` ("run one at a time" becomes the lease behaviour), `docs/daemon/runtime-architecture.md` (known gaps), `docs/cli/troubleshooting.md` (`agent_leased`, lease files), `docs/daemon/http-api.md` (client routes are internal).
- **Acceptance**: `docs/STYLE.md` rules; every user-visible message added in W0-W4 is findable in the docs.

### Wave 5

#### W5-A Full parity run and triage

- **Owns**: `tests/parity/**`, the triage list in this tracker (§6).
- **Acceptance**: every W3 scenario green; each remaining diff is either fixed (E3, own commit) or recorded in §6 as accepted with the owner's sign-off.

#### W5-B OS matrix, packaging, Defender, soak

- **Owns**: CI workflow changes, `docs/design/daemon-backend-checklist.md` inputs (the checklist itself is written separately).
- **Acceptance**: packaged builds on Windows (`windows-2022` runner), macOS arm64, Linux AppImage start in `local` mode and run the smoke scenario; Defender detections checked with `Get-MpThreatDetection` after a 24 h soak with 5 agents; keychain prompts on macOS observed and documented.

## 5. Risk register

| ID | Risk | Likelihood | Impact | Mitigation | Owner |
|---|---|---|---|---|---|
| K1 | Defender behaviour-kills the long-lived Electron-as-Node daemon (history: `Behavior:Win32/LummaStealer.CER!MTB` on Studio) | Medium | High: all agents die silently | Signed binary; daemon reads credential stores only at boot/handover; W5-B soak; Studio shows "daemon exited" with the exit code; submission to WDSI if detected | W0-D, W5-B |
| K2 | Runtime identity adoption fails or diverges; own agents show `recognized` or credentials stay locked | Medium | High: R2 visibly broken | D10 with delegation and enc-key verification; unlock cascade; identity tests in W1-C; fallback stated in the switch dialog | W1-C |
| K3 | Handover loses a rotating refresh token (crash mid-move) | Low | Medium: user must sign in again | Idempotent move: write destination, verify, then delete source; resume on next boot | W4-A |
| K4 | Event loss or reordering across reconnects shows a stale chat | Medium | Medium | One stream per session, per-session ring, `stream.gap` resync via `chat_updated` | W2-B, W2-C |
| K5 | Delta latency or throughput over HTTP makes streaming feel slower | Medium | Medium | Loopback SSE, focus-only deltas, latency test (≤ 50 ms p95) | W2-B |
| K6 | Settings lost updates between Studio and daemon writers | Medium | Medium | One writer per file (§4.2) | W2-C |
| K7 | `runtime-service.ts`, `http-api.ts`, `ipc/index.ts`, `openapi.json` merge conflicts between parallel agents | High | Low-Medium | File ownership table (§2), route modules, serial openapi merges | Lead |
| K8 | E1 extractions change embedded behaviour | Low | High (baseline corrupted) | Characterization test first; embedded parity harness run on every merge | All E1 owners |
| K9 | Lease PID reuse blocks a start | Low | Low | Error names the pid; documented manual removal; daemon holders verified via `/version` | W0-C |
| K10 | Version skew between Studio and an npm-installed CLI daemon on the same machine | High | Medium | `/version` with `clientApiVersion`; explicit restart dialog; public API unchanged | W0-D |
| K11 | macOS keychain prompts for the daemon process on first read of `ADF` entries | Medium | Low | Same signed binary as Studio; documented "Always Allow" | W5-B |
| K12 | Machines without a keychain (Linux) cannot adopt the runtime identity or hold app OAuth | Low | Medium | Fallback to daemon runtime + trusted-daemon slot; stated in the switch dialog | W1-C, W4-A |
| K13 | Main-thread stalls in the daemon (sync work on request paths) now freeze Studio's UI | Medium | Medium | Same rule as Studio main: no sync work on hot paths; request timeouts with visible errors; perf check in W5-B | All |
| K14 | Remote token sent over plain HTTP on an untrusted network | Low | High | Transport rule §9.2 with explicit opt-in | W4-B |
| K15 | Daemon-side parity gaps found late (§6 drift list incomplete) | High | Medium | Parity harness scenarios per domain in W3; W5-A triage | W5-A |
| K16 | Orphaned daemon after a Studio crash keeps agents running unexpectedly | Medium | Medium | `exitDaemonWhenClosed` session rule; log line; `adf daemon status` | W2-B, W4-A |
| K18 | One runtime's shutdown stops another runtime's containers (`PodmanService.stopAll`, happened 2026-10-14) | High | High: live agents lose compute | W1-G; agent rule: kill test processes, never graceful stop | W1-G |
| K17 | Duplicate `config.id` files: daemon silently serves the first | Medium | Medium | `409 duplicate_agent_id` (W1-A) | W1-A |

## 6. Review follow-ups

Low-severity items accepted at merge, each with the workstream that picks it up.

| From | Item | Owner |
|---|---|---|
| W0-E | Remote→embedded fallback at boot (unconfirmed http URL dropped) is logged but not shown in Settings → Backend; a later unrelated save rewrites the file without the dropped fields, silently | W4-B (done 5a3dbad7: the URL is kept and never used; `active.notices` in Settings; the save that drops ignored fields says so) |
| W0-E | A confirmed plain-http URL cannot be un-confirmed without changing the URL | W4-B (done 5a3dbad7) |
| W0-B | Template types copied into `src/shared/daemon-client/types.ts` and `src/main/tui/templates/model.ts`; make `model.ts` re-export | W2-B |
| W0-B | `credentialsFor` implementations MUST honour the explicit `token` argument; document for Studio's implementation | W2-C |
| W0-B | `api-guide.md` lines 11, 518 and `src/main/tui/CONTRACT.md` 287, 294 still name `src/main/tui/api/*` | W4-C |
| W0-D | If the race-winning daemon is still booting 3 s after our child exits, Studio shows "exited during startup"; keep waiting while a pid file appears or retry `ensure` once | W4-A |
| W0-D | "Waiting for the ADF daemon (pid N)…" progress is not shown in the UI yet | W4-A |
| W0-D | Packaged build not verified with a real `node_modules` (junction drops transitive deps); lead verifies `npm run package` in a real checkout | Lead, W5-B |
| W0-A | `TEMPLATE_CHECK_REVIEW`: daemon reports provider status `unchecked` where Studio runs `autoProviderCheck`, and returns 409 when owner identity is not ready where embedded returns `needsReview:false` | W2-A (done: provider check through ProviderChecks; 200 `needsReview:false, identityReady:false`) |
| W0-A | `DOC_READ_INTERNAL_FILE` needs a metadata-only / size-capped read so Studio does not download whole binaries to discard them | W1-E |
| W0-A | `TEMPLATE_DELETE`: templates-trash vs OS trash semantics differ | W3-A (done: local mode moves the file to the OS trash itself; remote uses templates-trash) |
| W0-A | `fleetGroups`, `fleetStewards`, `fleetMapState` missing from `AppSettings` (`ipc.types.ts`) | W2-C |
| W0-D | Pre-existing: the daemon's podman probe writes a stray `NUL` file in its working directory | W1-G (fixed) |
| W1-B | (done in W1-A) **BLOCKING for W1-A**: nothing calls `builder.applyDerivedKey`; `RuntimeService` never passes `build({derivedKey})` (`runtime-service.ts:2449`), `unlockAgentIdentityPassword` (`:1812`) rebuilds only the provider, `createProviderForModel` fixes `derivedKey:null` (`:2457`). Password-protected agents unlocked in the daemon keep MCP, adapters and AdfCallHandler locked | W1-A |
| W1-B | Mesh-parity test runs at MeshManager level, not through the daemon builder; full in-daemon scenario | W5-A |
| W1-F | `adf_file_created` missing from `AgentExecutionEvent['type']` and `BackgroundAgentEvent['type']` (`ipc.types.ts:9,686`); add with real payload type, drop BAM cast | W2-C |
| W1-F | Wire serializer MUST treat missing key == `undefined` and MUST NOT throw on BigInt/circular values (`writeSse*`) | W2-B |
| W0-F | Streaming bound (300 ms/slice) MAY be too tight on loaded CI; make it configurable | W2-C |
| W0-F | Upserted tables (adf_meta/config/files/identity) exempt from row-order check; sort them by primary key before daemon diffs | W2-C |
| W0-F | A child spawned with a clean env (no `NODE_OPTIONS`) is unfenced | W2-C |
| W0-F | E3 candidate: `cleanupAllProcesses` never calls `AgentTemplatesService.stopWatcher` | W3-A (done, E3: also closes the tracked-folder watcher) |
| W1-G | Liveness is pid + 120 s heartbeat (interim); replace with W0-C `holderLiveness` and fold markers into the host record | W0-C (done) |
| W1-G | Studio's 6 s teardown budget can expire during the 6 s stale-marker re-check, leaving containers running (safe direction) | W4-A |
| W1-G | `leftRunning` and `containerUsers()` need UI in Settings → Compute and the reset confirmation | W3-D (done: `leftRunning` listed under the containers, `users` per row from `GET /compute/users`, named in the rebuild/remove confirmation) |
| W3-D | E3 candidate: during EMERGENCY_STOP embedded's teardown makes the open agent's startup dispatch report "Cannot dispatch startup while agent lifecycle is disposed" on AGENT_EVENT (parity allowlist `e3:emergency-stop-startup-dispatch-error`) | W5-A |
| W3-D | E1 request: extract MESH_FOUND_AGENT's destination checks and file-name slug from `ipc/index.ts`; `daemon/routes/fleet-client-routes.ts` has a copy | W3-A |
| W1-C | E3 in `owner-identity.service.ts` (owner switched outside Studio): own phrase not of `ownerDid` → take the keychain phrase; never mirror such a phrase; `getOwnerSigningKey` null for it; restamp keeps operator attestations of files stamped by another runtime. Tests: `tests/daemon-runtime-adoption.test.ts` "owner switch from the CLI…" | Lead (merge note) |
| W1-C | Write `studio-runtime:<scope>` with `serializeStudioRuntimeEntry` + `studioRuntimeScope`; rewrite it after any delegation change (owner import); delete it on the switch back to embedded; move app MCP OAuth with `DaemonAppOAuthStore.importBlob/exportBlob`; send the local proof for `POST /identity/import` | W4-A |
| W1-C | Unify `src/main/utils/test-seams.ts` with W1-G's `isPackagedRuntime` | Lead (done: both seams use `testSeamsAllowed`) |
| W1-C | Wire `identity.mcpOAuth` (DaemonAppOAuthStore) into the builder's MCP OAuth path | W1-B / W3-C |
| W0-C | `agent_leased` message for an endpoint-less stale lease (failed `listen` + reused pid) names an unfindable pid; add the lease file path and remedy | W4-C / W1-A |
| W0-C | POSIX: "socket missing = dead" also applies to the `tmpdir()` fallback socket (hosts path > 100 chars), which tmp cleaners may delete under a live holder; treat missing as dead only for the 0700 hosts-dir socket | W5-B |
| W1-D | Unknown/expired identity draft id on create silently mints a fresh DID (console.warn only); report it in the create response | W2-A (done: `identityDraft`, `warnings`) |
| W1-D | Job cancel only abandons work: OAuth loopback listener lives to its 5 min timeout; an in-flight stdio connect may outlive `disconnectAll` (orphan server process); running jobs unbounded, Python install not deduped | W3-C |
| W1-D | Peer fetch: DNS rebinding between guard lookup and fetch (pre-existing); daemon port blocked only on loopback | W4-B (done, E3: fd137041 pinned lookup in `guardedFetch`; 3f412789 every interface address; design §3.2) |
| W1-D | SSRF guard: map NAT64 `64:ff9b::/96` and 6to4 `2002::/16` back to IPv4 before checks (pre-existing gap, all callers); extend always-blocked metadata list (EKS `169.254.170.23`/`fd00:ec2::23`, Alibaba `100.100.100.200`, Azure `168.63.129.16`, OCI `192.0.0.192`); DNS-lookup failure currently passes through | W4-B (done, E3: 1e5ec44b, cf03f371, e6b223f7; characterization b4722440) |
| W1-A | Key drop (remove/wipe) restarts every running adapter, not only those using the key | W3-B |
| W1-A | Daemon-mode client must prompt for the file password before start, using the preflight `credentials_locked` code (design §6.1 row 27) | W3-A (done: FILE_OPEN asks for held and running agents; AGENT_START refuses a locked held document with code credentials_locked, which opens the dialog) |
| Lead | Regenerate `docs/daemon/api-reference.md`/`.html` once after Wave 1 merges (`npm run docs:api`) | Lead |
| W2-C | Lease client record `controlUrl` is always port 7385; daemon host record carries `version: null` | W4-A |
| W2-C | Daemon-mode quit behaviour (R4) and version-mismatch choice | W4-A |
| W2-C | CI job: build `out/main/daemon.js`, run `tests/parity` with `PARITY_REQUIRE_DAEMON=1` (the suite fails on a missing or stale bundle) | W5-B |
| W2-C | Interim first-boot seed of `studio-client-settings.json` from `adf-settings.json` (`ClientSettingsStore.seedOnce`): replace with the switch's move | W4-A |
| W2-C | Renderer ignores `chat_updated.earlierCount` (`useAgent.ts:495`): after a daemon-mode `stream.gap` resync (last 200 entries) older entries cannot be paged until reopen. Embedded sends the whole loop, no `earlierCount` | W3-A (done) |
| Lead | MERGE GATE at W2-B merge: a test in the real daemon wiring proving a document held by a live session survives past the 60 s holder TTL (W2-B `setDocumentHolderCheck` wired to W2-A's sweep) | Lead (W2-B merge) |
| W2-A | Read-only open of a file leased elsewhere still runs `AdfWorkspace.open` maintenance writes; a true read-only open needs an `AdfDatabase` change | W3-A (not done: needs a read-only AdfDatabase open; see the Lead row below) |
| W3-C | Agent MCP OAuth via HIL (`mcp_oauth_authorize`) not met end-to-end: opener sees only the connect snapshot on the interim adapter; a request pending at connect lands in the approvals panel with no Open action. Needs a parity scenario on client sessions | W2-C2 |
| W3-C | Interim-adapter install-progress branch (`install-progress.ts:121-138`, `progressLog` relay) is dead once on client sessions; delete and rerun `w3c-install-progress` on sessions | W2-C2 |
| W3-C | E3 candidate: `MCP_ATTACH_SERVER` drops OAuth flags (renderer + `ipc/index.ts:7167`); the `.adf` lacks `oauth:true`, so on another runtime it connects without OAuth and 401s | W5-A |
| W3-D | E3 candidate: embedded emergency stop logs a spurious chat error "Cannot dispatch startup while agent lifecycle is disposed" (`useAgent.ts:465`) | W5-A |
| W3-D | `/fleet/vitals` builds a second `AgentVitalsService` (duplicate caches/scans) | W5-A |
| W2-C2 | D5 deviation: executor frames carry no `turnId`, absorbed ids or discarded-turn frame; Studio works around it with `umbilical:true` (turn.completed/agent.error/chat.discarded). Add them to executor frames and drop the workaround | W5-A |
| W2-C2 | `w3a:chat-echo`: in daemon mode Studio shows its own chat twice (`POST /agents/:id/chat` lacks `echoed`). W3-A acceptance criterion | W3-A (done: the sending session alone skips its trigger_message) |
| W2-C2 | Version-mismatch refusal only offers `ADF_STUDIO_BACKEND=embedded`/hand edit as the way back; needs the §8.2 dialog | W4-A |
| W3-B | If `icacls` fails to restrict the proof file on Windows, the daemon runs without a local proof, so every local-only route (reveal, owner import) refuses; make that state visible in Studio and `adf daemon status` | W4-A |
| W3-C | Remote placeholder check is `startsWith('__redacted__')`; a backspaced or mid-edited placeholder is saved as the secret. Compare exact placeholder + track "field touched" | W4-B (done 26af1a15: exact placeholder; a value made from it is refused; the form replaces the placeholder with what is typed) |
| W3-C | E3 candidate: `closeConnection` orphans a shim-launched (cmd /c) MCP server that ignores stdin EOF on Windows | W5-A |
| Lead | MERGE GATE for W3-A: `tests/parity/documents` green on the daemon side with real W2-C2 sessions (no skip, no `PARITY_W3A_HOLDS`) | Lead (W3-A merge; met on ws/w3-a: all 8 documents scenarios green on both sides) |
| W3-A | E3 candidate: stopping an agent started idle sends "Cannot dispatch startup while agent lifecycle is disposed" on AGENT_EVENT in embedded (allowlist `e3:stop-startup-dispatch-error`, same cause as `e3:emergency-stop-startup-dispatch-error`) | W5-A |
| W3-A | A locked running agent keeps running with the stub provider in daemon mode instead of being stopped (D3 difference) | W5-A |
| W2-C2 | `agent-oauth.test.ts` compares outcomes only (embedded's 50 ms coalesced approvals snapshot lands at varying points); make the snapshot timing deterministic in the harness and compare full recordings | W5-A |
| W4-A | Linux `basic_text` safeStorage counts as available for moved-back tokens and MCP blobs (same as embedded today) | W5-B |
| W4-A | K12: no-keychain machines — `trustedDaemonEncKeys` enrollment fallback not built; switch dialog states it | W5-A |
| W4-B | DNS pinning covers only `guardedFetch`; `sys_fetch`, `ws_connect`, MCP still check-then-connect (rebinding); NAT64 local-use `64:ff9b:1::/48` and Teredo not mapped; unresolvable-host refusal breaks `NODE_USE_ENV_PROXY` without local DNS | W5-A |
| W4-B | Plain http to `100.64.0.0/10` counts as tailnet but is also ISP CGNAT; recommend https via MagicDNS in docs | W4-C |
| W4-B | User-testing checklist items wrong for remote: MODE-06, MODE-07, IDN-02, IDN-03, DMN-20, DMN-22, DMN-18/19 + Remote host row, FILE-16, TMPL-04, MESH-04, COMP-06, FILE-08 | W4-C |
| W3-F | `PUT files/raw` takes no base revision and echoes the upload to the uploader's own session | W5-A |
| W4-B | A real end push arriving after the 15 s install fallback end is pushed twice; unused `readRemoteToken` import in `connectors.ts` | W5-A |
| W1-B | `McpStatusDashboard.tsx:10-24` has no label/colour for MCP status `needs_sign_in` (blank in daemon mode) | W3-C |
| W1-C | OAuth chunk store: `chunkedSecretDelete` removes head before chunks (crash strands fragments) — delete chunks first; >999 chunks writes a head `isGeneration` rejects — throw on write; `splitOnCodePoints(size=1)` loops on a high surrogate — guard | W4-A |
| W1-C | Test-seam Deno gate misses custom `DENO_DIR` + non-npmjs registry | Lead (with seam unify) |
| W2-A | Start window: path-agent-ops `writeClosed` on a file that is loading (no open document) writes a config the start does not adopt (§6.1 row 24) | W3-A (done: path ops wait for a load in flight (RuntimeService.waitForLoad)) |
| W2-A | Start window: `agent-runtime-builder.ts:1067` writes the start-time config back to the file, over a write made during the build (§6.1 row 24) | W3-A (done: MCP tool syncs persist onto a fresh read) |
| W2-A | An open document of a file leased elsewhere still gets AdfWorkspace.open's maintenance writes (migration, clean-close marker, skills registry); a read-only AdfDatabase open would remove them | Lead |
| W2-A | Wire `setDocumentHolderCheck` and the hold/release/expiry calls to W2-B's `setDocumentHost` | W2-B merge (done: `wireDocumentsToClientSessions`; gate test `tests/daemon-client-documents-gate.test.ts`) |
| W2-B | Templates folder watcher: `daemon-agent-factory.ts` creates AgentTemplatesService with `notifyChanged: () => {}` and never starts its watcher, so templates added or removed in the folder outside the daemon's routes push no `templates` frame; pass a `notifyTemplatesChanged` hook (→ `clientSessions.publishPush('templates', {})`) and start the watcher | W3-A (done) |
| W4-B | The Mode control in Settings → Backend still disables Remote while `modeSwitchAvailable` is false; the Remote group's "Switch to remote daemon" is the way in. When W4-A enables the control it keeps `remote` allowed through `REMOTE_SWITCH_AVAILABLE`, and its switch flow reuses `BACKEND_RESTART_STUDIO` | W4-A |
| W4-B | Provider app keys: the provider form gets `__redacted__` from the daemon (§4.2); a backspaced placeholder (`__redacted_`) is saved as the key, in local and remote mode. Same fix as the MCP form: `editPlaceholderField` in the provider key field, and refuse values made from the placeholder in the settings write | W5-A |
| W4-B | `POST /oauth/relay` cannot tell whether a sign-in waits at the target (pending flows live in `mcp-admin-routes` and the approvals hub, not shared); it is bounded instead (§9.4). A shared registry of pending loopback callbacks would let it refuse every other port | Lead |
| W4-B | Docs: remote Studio (Settings → Backend actions, daemon-side picker, upload of a local file, OAuth relay, `tailscale serve`, `ADF_DAEMON_BROWSE_ROOTS`) in `docs/cli/remote-daemon.md` and the Studio guide; user-testing DMN-20 expects owner routes through an SSH tunnel, which Studio refuses by design (§9.4) | W4-C |

## 7. Parity triage (filled in W5-A)

| Scenario | Diff | Decision | Commit |
|---|---|---|---|
| | | | |
