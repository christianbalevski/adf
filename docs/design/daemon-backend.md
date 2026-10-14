# Studio on the Daemon Backend

**Status**: Design (not started) · **Difficulty**: 9/10 overall · **Branch**: `feat/daemon-backend` (from `main` 56ab750f)
**Tracker**: [daemon-backend-tracker.md](daemon-backend-tracker.md)
**Depends on**: ADF_IDENTITY_SPEC_v0.1, [mcp-credential-identity.md](mcp-credential-identity.md) (Phase C trusted-daemon slots), [docs/cli/remote-daemon.md](../cli/remote-daemon.md)

## 1. Goal and constraints

ADF Studio gains a second backend. In **daemon mode** the Electron main process registers the same IPC channels as today, but each handler forwards to an ADF daemon over its HTTP API. The renderer and preload do not change. The headless daemon becomes the one API backend for Studio, the terminal app, the ADF CLI and later clients.

Requirements from the owner:

| # | Requirement |
|---|---|
| R1 | **Embedded mode** (today's in-process backend) keeps working, selectable in settings next to daemon mode. |
| R2 | Embedded and local daemon mode are indistinguishable from the user's perspective. |
| R3 | Embedded code is deleted only after extensive testing and one week of daily use in daemon mode. |
| R4 | Whether the daemon keeps running when Studio quits is a user setting. |
| R5 | Remote daemon (another machine) is in scope if the cost is moderate. |
| R6 | `window.adfApi` (`src/preload/api.ts`) stays unchanged. |
| R7 | Terminal users never need Studio (CLI first-class). |

Modes:

| Mode | Backend | Agents run in |
|---|---|---|
| `embedded` | `registerAllIpcHandlers` (`src/main/ipc/index.ts:1864`) | Studio main process |
| `local` | Daemon on this machine, same settings file and data dir as Studio | Daemon process spawned or attached by Studio |
| `remote` | Daemon on another machine, reached by URL and token | Remote daemon |

R2 applies to `embedded` vs `local`. `remote` differs where the machine boundary forces it (§9.3), and each such difference is listed.

## 2. Current state (verified anchors)

| Fact | Anchor |
|---|---|
| 241 `ipcMain.handle` + 1 `ipcMain.on` inside one function, `registerAllIpcHandlers`, lines 1864 to about 9259 | `src/main/ipc/index.ts` |
| Handlers act on module globals `currentWorkspace`, `currentFilePath`, `currentDerivedKey` and a foreground executor set | `ipc/index.ts:306-348` |
| Preload: 278 members, 252 `invoke`, 23 `on*` subscriptions, 1 `send` (`FILE_SHARE_DRAG_START`) | `src/preload/index.ts` |
| Non-JSON IPC payloads: `orbitalCachePut/Get` (`Uint8Array`), `uploadFile(path, number[])`, `readInternalFile` (base64) | `preload/index.ts:705`, `renderer/components/agent/AgentFiles.tsx:286` |
| All pushes go to `BrowserWindow.getAllWindows()[0]`, except `APPROVALS_CHANGED` (all windows) | `ipc/index.ts:841, 1938` |
| Three host recipes before `assembleAgent`: foreground `AGENT_START` (3678-5008), `BackgroundAgentManager.setupManagedAgent` (513-1993), daemon `AgentRuntimeBuilder.build` (148-348) | |
| Daemon `RuntimeService.loadAgent` = open + assemble + `start()`. No loaded-but-not-running state; `stopAgent` = `unloadAgent` | `runtime/runtime-service.ts:520-593, 836` |
| Daemon resource routes `/agents/:id/*` require a loaded agent | `daemon/http-api.ts` |
| `RuntimeService` re-emits raw executor events as `'agent-event'`; nothing subscribes | `runtime-service.ts:571, 2224` |
| SSE `GET /events` speaks umbilical envelopes; ring of 1000; only filter `agentId`; `turn.delta` only with `umbilical.stream_deltas` | `http-api.ts:694`, `agent-executor.ts:4358` |
| Daemon HTTP body limit is Fastify's default 1 MiB; files travel as JSON base64 | `http-api.ts:618` |
| `GET /runtime` `daemon.version` is null outside `npm run` (DaemonHost never passes it) | `http-api.ts:1076` |
| Daemon settings default to Studio's `adf-settings.json` | `daemon/index.ts:91`, `utils/user-data-path.ts:43` |
| Studio `SettingsService.get()` never re-reads disk; daemon `FileSettingsStore` re-reads on stat change; both merge-on-write, no file lock | `services/settings.service.ts:179`, `daemon/file-settings-store.ts:93` |
| Daemon reads `globalSystemPrompt`, `toolPrompts`, `compactionPrompt` once at boot | `daemon/index.ts:176-178` |
| `.adf` files: WAL, `busy_timeout=5000`; two processes can run the same agent; no ownership lock | `adf/adf-database.ts:2804` |
| The CLI refuses to start a daemon while Studio runs (mesh `/ping` `runtime_id` match or process scan) | `cli/daemon-control.ts:120-158` |
| Studio never talks to or spawns a daemon; the SSRF guard blocks the daemon port for agents | `utils/ssrf-guard.ts:8-26` |
| Packaged Studio has no daemon entry; no Electron fuses configured (`RunAsNode` on by default) | `electron.vite.config.ts`, `electron-builder.yml` |
| Precedent for `ELECTRON_RUN_AS_NODE` child processes | `runtime/sandbox-host.ts:183-188, 281-289` |
| Daemon profile has `umbilicalTaps: false`; Studio profiles have `true` | `runtime/agent-capability-profiles.ts` |
| Loading a second file with the same `config.id` returns the first agent and disposes the new build, silently | `runtime-service.ts:2219-2222` |

## 3. Architecture

```
renderer ──IPC (unchanged channels)──▶ Electron main
                                         ├─ mode=embedded: registerAllIpcHandlers (unchanged)
                                         └─ mode=local|remote: registerDaemonModeHandlers
                                               ├─ electron-local handlers (shared with embedded)
                                               ├─ proxied handlers ──HTTP──▶ daemon REST
                                               └─ event bridge ◀──SSE── daemon client session stream
```

### 3.1 Decisions

**D1. Main-side proxy.** In daemon mode Electron main registers an alternate handler for every IPC invoke channel and an event bridge that re-emits every push channel. The renderer and preload stay as they are. The token stays in main, Node `fetch` sends no `Origin`, so `request-guard.ts` needs no change, and `adf-file://` is served by main from the daemon.

Rationale: a renderer-side client would need CORS or an Origin exemption on the daemon, would put the token in a sandboxed renderer, and would change `window.adfApi` semantics (R6).

**D2. Exhaustive channel map as code.** A new module `src/main/backend/channel-map.ts` classifies every invoke and push channel from `src/shared/constants/ipc-channels.ts` as one of:

| Class | Meaning |
|---|---|
| `local` | Electron-only (dialogs, window, updater, spellcheck, shell, drag, orbital cache, firewall). One implementation, shared by both modes. |
| `proxied` | Daemon mode forwards to named daemon route(s). |
| `remote-variant` | `proxied` in `local`; a different implementation in `remote` (§9.3). |
| `remote-unsupported` | `proxied` in `local`; in `remote` the handler returns a typed error the renderer already displays. |

The map MUST be typed `satisfies Record<IpcChannel, ChannelClass>` so an unclassified new channel is a compile error (same technique as `AGENT_PROFILES`). A test MUST fail when a `proxied` channel has no daemon-mode handler.

**D3. Studio client state lives in Studio main.** "Current file", foreground/background distinction, the derived-key cache for the open file and the renderer focus are client state. Daemon mode keeps them in a `DaemonModeSession` object in Studio main. The daemon has no notion of a current file; it has client sessions that hold open documents and a focus (D5).

**D4. Inert documents in the daemon.** The daemon gains **open documents**: an `.adf` opened for reading and editing without assembling a runtime. All `/agents/:id/*` resource routes (config, files, chat, inbox, outbox, timers, logs, tables, identity, meta, tasks, review) MUST work on open documents. Start assembles a runtime on the already-open workspace; stop disposes the runtime and keeps the document open while a client session holds it. Open documents MUST NOT be registered with the mesh, MUST NOT run timers or triggers, and MUST NOT count as loaded for autostart. This matches embedded mode, where opening a file does not start it (`FILE_OPEN`, `ipc/index.ts:2192`).

Open documents are held by client sessions (refcount). A document with no holder and no runtime is closed. Today's duplicate-`config.id` behaviour (`runtime-service.ts:2219`) MUST become a visible `409 duplicate_agent_id` with both paths.

**D5. Client sessions and the client event stream.** The daemon gains internal routes for clients that need exact UI parity:

| Route | Purpose |
|---|---|
| `POST /client/sessions` | `{client, version, exitDaemonWhenClosed}` → `{sessionId, epoch}` |
| `GET /client/sessions/:id/events?since=` | SSE stream of client frames |
| `PUT /client/sessions/:id/focus` | `{agentId \| null}`: the agent whose deltas and full events the client wants |
| `POST /client/sessions/:id/documents` / `DELETE …/documents/:agentId` | Hold / release an open document |
| `DELETE /client/sessions/:id` | End the session |

Frames carry domain events, not IPC payloads:

| Frame kind | Content |
|---|---|
| `executor` | `{agentId, filePath, loop?, event: AgentExecutionEvent}`: the raw executor event, as `AGENT_EVENT` carries it today |
| `host` | `{agentId, filePath, type}` for `agent_starting`, `agent_started`, `agent_start_failed`, `agent_stopping`, `agent_stopped`, `agent_loops_changed`, `agent_state_changed` (display state), trigger errors and startup-dispatch failures |
| `push` | Typed topics for the remaining push channels: inbox, adapter status, MCP status, MCP/adapter/sandbox install progress, tracked dirs, templates, file renamed, config changed, workspace data changed, approvals snapshot, mesh events, inter-agent messages, compute phase, browser session |

Rules:

- `executor` frames for text and thinking deltas MUST be sent only for the session's focused agent. All other `executor` frames are sent for every agent. Deltas no longer depend on `umbilical.stream_deltas` for this stream; that flag keeps governing `/events` and taps.
- Each session has its own ring (4096 frames) and cursor. A resume with an evicted cursor or a new epoch gets `stream.gap`; Studio then resyncs (D6).
- Sessions expire 60 s after the last SSE disconnect; their documents are released. `exitDaemonWhenClosed` sessions trigger the orphan rule in §8.3.
- The routes are documented in `openapi.json` under tag `Client (internal)` with `x-adf-stability: internal`. They MAY change between versions; Studio checks `clientApiVersion` (§8.2).

Rationale: the existing `/events` stream is lossy for UI purposes (no `chat_updated`, `loop_seq`, `trigger_message`, `adf_file_created`, delta batches, full `tool_call_result`, BAM lifecycle events) and is global. Translating umbilical events back into executor events would be a second, drifting copy of the mapping in `agent-executor.ts:5423-5482`. The raw events already exist (`'agent-event'`), so forwarding them costs little. Domain frames, not IPC payloads, keep the daemon free of Studio's channel names and stay useful for the terminal app (richer chat view).

**D6. Studio maps frames to IPC pushes.** The event bridge in Studio main:

- focused agent: `executor` frames → `AGENT_EVENT` unchanged; `host` trigger/startup errors → synthetic `error` on `AGENT_EVENT` (as `ipc/index.ts:3729, 4834, 4997`);
- other agents: `executor` and `host` frames → the BAM mapping (`background-agent-manager.ts:1035-1071`) → `BackgroundEventBatcher` (`ipc/background-event-batch.ts`) → `BACKGROUND_AGENT_EVENT_BATCH`;
- `push` frames → the matching push channel;
- `stream.gap` → resync: one `chat_updated` (full `uiLog`) for the focused agent, `DOC_AGENT_CONFIG_CHANGED`, `TRACKED_DIRS_CHANGED`, a fresh approvals snapshot, and an `agent_started`/`agent_state_changed` batch for every running agent.

The BAM mapping MUST be extracted into a pure function shared by both modes (Rule E1, §3.2). The renderer-side consumers are listed in §7.

**D7. One runtime recipe in the daemon, at parity with Studio.** `AgentRuntimeBuilder` and `RuntimeService` reach the user-visible behaviour of the Studio recipes (§6). Embedded recipes are not modified beyond Rule E1.

**D8. Shared daemon client.** `src/main/tui/api/{client,sse,types,normalize}.ts` move to `src/shared/daemon-client/` with an injected `{baseUrl, token(), localProof()}` provider. Only `cli/daemon-url.ts` stays Node-specific. The terminal app and Studio main use the same client. Types stay hand-written type-imports of the real shapes, as today.

**D9. Mode switch restarts Studio.** The backend is chosen at boot, before any IPC handler is registered. Changing it in Settings shows what will happen and restarts Studio. Hot switching would require unregistering 242 handlers and migrating live executors; the restart is deterministic and testable.

### 3.2 Rules for changing embedded code

The embedded backend is the A/B baseline. Changes to embedded-mode code paths are limited to:

- **E1.** Behaviour-preserving extractions (move code into a function or module both modes call) covered by a characterization test written and passing before the move.
- **E2.** The agent lease hooks (§10) at the three start points and the dispose points.
- **E3.** Fixes for bugs found by the parity harness, each in its own commit, each with a test, each listed in the tracker.

Everything else is new code under `src/main/backend/` or daemon code.

Rationale: copying the BAM mapping, the event batcher semantics or the core-tool declaration helper into daemon mode creates the drift this project exists to remove (§6 shows the daemon already copied `ensureCoreToolDeclarations`). A pure extraction with a characterization test keeps the baseline intact and removes the copy.

## 4. Settings model

### 4.1 Key classes

| Class | Keys | Lives in (daemon mode) |
|---|---|---|
| **Client** (Studio presentation and Studio-host behaviour) | `theme`, `uiFont`, `uiFontCustom`, `uiScale`, `agentAvatars`, `fleetMapState`, `fleetGroups`, `fleetStewards`, `onboardingSharedAt`, `templatesMigrationSeen`, `nativeNotificationsEnabled`, `menuBarEnabled`, `recentFiles`, `updateChecksEnabled`, `spellcheckDownloadsEnabled` | `studio-client-settings.json` (Studio userData) |
| **Backend** (read by runtime, providers, MCP, adapters, mesh, review, compute, tracked dirs) | every other key, including `trackedDirectories`, `agentsFolder`, `compute`, `remoteCatalogsEnabled`, `providerChecksEnabled`, `skillCatalogSources` (the terminal app reads it) | The daemon's settings file, through `GET/PATCH /settings` and the dedicated routes |
| **Backend selection** | `mode`, `keepDaemonRunning`, `remote.url`, `remote.token` | `studio-backend.json` (Studio userData), token as `safe:` |

`fleetMapState` carries `burnTotals`, which `ipc/index.ts:5866` reads; in daemon mode the fleet-burn handler reads it from the client file and sends it to the daemon route as a parameter.

The list MUST be one exported constant (`CLIENT_SETTINGS_KEYS` in `src/shared/constants/`), and a test MUST fail when a key read anywhere in `src/` is in neither class.

### 4.2 Rules

- Each settings file has one writer in daemon mode. The daemon writes the backend file; Studio main writes `studio-client-settings.json` and `studio-backend.json`. Studio main MUST NOT write `adf-settings.json` in daemon mode.
- `SETTINGS_GET` in daemon mode returns `{...daemonSettings, ...clientSettings}`. `SETTINGS_SET` splits the patch by class.
- The daemon redacts provider API keys as `__redacted__` and restores them on write (`http-api.ts:555-600`). The provider form is a password field without reveal (`ProviderModal.tsx:249`), so the only visible difference is the dot count. Accepted.
- Backend settings that embedded Studio applies live MUST apply live in the daemon. Known gap: the three prompt keys read once at boot (§2).

Rationale: in `local` mode both processes could share `adf-settings.json`, but the merge-on-write scheme loses updates on read-modify-write list keys (`trackedDirectories`, `reviewedAgents`) and Studio never re-reads. One writer per file removes the race, and the same split serves `remote`, where client keys must stay on the laptop.

### 4.3 Seeding on switch

Client keys are copied from `adf-settings.json` into `studio-client-settings.json` when switching to a daemon mode, and back when switching to embedded (§11). Nothing else is copied: in `local` mode backend keys already live in the shared file.

## 5. Identity, runtime DID and envelopes

This is the riskiest part. It decides whether agents open, unlock and show the same review state in both modes.

### 5.1 What each runtime holds today

| Material | Studio | Daemon |
|---|---|---|
| Owner phrase | `ownerMnemonic` (`safe:`), mirrored to keychain `ADF / owner-mnemonic` | Keychain `ADF / owner-mnemonic`, or passphrase file `owner-secrets.json` |
| Owner DID, owner enc public key, backup flag | Shared settings keys | Same keys; writing a different `ownerDid` throws `owner_mismatch` (`daemon-identity.ts:115`) |
| Runtime signing key | `runtimePrivateKey` (`safe:`) → `runtimeDid`, `runtimeDelegation` | Keychain account `daemon-runtime-signing-key:<scope>` → `daemonRuntimeDid`, `daemonRuntimeDelegation` |
| Runtime enc key (X25519) | `runtimeEncPrivateKey` (`safe:`), `runtimeEncPublicKey` | `runtime-enc-key` file, immutable (`daemon-enc-key.ts`) |
| Trusted-daemon slots | Studio wraps the credentials DEK to each `trustedDaemonEncKeys` entry | Unlocks through those slots |
| App-level MCP OAuth | `mcpOauthCredentials` (`safe:`, `AppSettingsOAuthStore`) | None; agent keystore only |
| ChatGPT / Grok sessions | `<provider>/auth.json` (safeStorage) | `<provider>/auth.daemon.json` (AES-GCM under a machine key file) |
| Provider API keys | Settings file, or keychain `provider-api-key:<scope>:<id>` | Same (shared scope) |

### 5.2 Where the runtime DID is visible

| Consumer | Effect when Studio and daemon runtime DIDs differ |
|---|---|
| `deriveReviewIdentity` (`services/agent-review.ts:78`) | An own file stamped by the other runtime shows scenario `recognized` instead of `mine` in the review and identity panels. |
| `adf_runtime_did` meta and the `operator` attestation (`attestation.service.ts:206`) | New agents carry a different runtime DID and issuer. |
| Envelope runtime slots | The other runtime cannot use the runtime slot; it falls back to the owner key (re-wrapping a slot for itself) or a trusted-daemon slot. |
| Mesh `/ping` and mDNS TXT `runtime_did` | Peers see a different runtime identity per mode. |
| Settings → Identity | Shows a different runtime DID. |

Finding: the daemon's mesh server reads `settings.get('runtimeDid')` directly (`services/mesh-server.ts:308`), so today a daemon on Studio's settings file advertises Studio's runtime DID and delegation while it signs and wraps with `daemonRuntimeDid`.

### 5.3 Decision D10: in `local` mode the daemon adopts Studio's runtime identity

One machine and one OS user is one runtime. In `local` mode the daemon signs with Studio's runtime key, stamps `runtimeDid`, issues delegations as Studio would, and unlocks with Studio's runtime enc key. Files created in either mode are identical in identity terms, review shows `mine` in both modes, and peers see one runtime DID.

Mechanism:

1. At the first switch to `local` (and on every later switch if the keychain entry is absent), Studio main reads `runtimePrivateKey`, `runtimeEncPrivateKey` from safeStorage and writes them, with `runtimeDid` and `runtimeDelegation`, into the OS keychain under account `studio-runtime:<scope>` (service `ADF`, `scope` = `settingsScope(settingsPath)`). No HTTP route carries key material.
2. `DaemonIdentity` reads that account at boot and on `refresh()`. It MUST verify that the delegation is issued by the owner DID on record, that its subject is the DID derived from the signing key, and that the enc private key matches `runtimeEncPublicKey` in settings. On any mismatch it MUST ignore the entry and log why.
3. With a valid entry, `DaemonIdentitySettings` maps `runtimeDid`, `runtimeDelegation`, `runtimePrivateKey`, `runtimeEncPrivateKey`, `runtimeEncPublicKey` to Studio's values instead of the `daemon*` keys.
4. Unlock tries Studio's runtime enc key, then the daemon's own `runtime-enc-key` (files it created before adoption, trusted-daemon slots), then the owner key. This cascade lives in daemon code (`daemon/index.ts` identity hooks); `OwnerIdentityService` is unchanged.
5. `ensureRuntimeKey` MUST NOT mint while the adopted entry is in use.

Security: writing the keychain entry requires the same OS-user keychain access that already exposes the owner phrase in the same service, so adoption grants nothing a local attacker did not have. The delegation check stops a corrupted or planted entry from changing the signing identity. A token-only attacker (HTTP) gains nothing because no route accepts key material.

Fallback: without a usable keychain (Linux without Secret Service), adoption is not possible. The daemon keeps its own runtime; Studio enrolls the daemon's enc key into `trustedDaemonEncKeys` on switch (Phase C) so credentials unlock. Review then shows `recognized` for files stamped by the other runtime. This difference MUST be stated in the switch dialog.

Rationale against keeping separate runtimes everywhere: unlock would mostly work through the owner key, but every own agent created in one mode would show as `recognized` in the other, new agents would carry a mode-dependent runtime DID, and mesh peers would see the runtime change with the mode. That fails R2 for a reason the user can see in the review panel.

### 5.4 Owner identity in daemon mode

| Studio action | `local` mode | `remote` mode |
|---|---|---|
| Status | `GET /identity` mapped to the Studio status shape | Same |
| Create / restore / unlock / lock / confirm backup | Existing local-only routes (`local-access.ts`); Studio main is a loopback caller | Refused by the daemon. Studio shows the daemon's message (run `adf identity …` on the server) |
| Back up seed phrase (reveal) | Studio main reads the shared keychain entry (`SharedMnemonicStore`) as a local operation. The daemon never returns the phrase | Not available; Studio says so |
| Import identity (switch owner) | New local-only route `POST /identity/import` performing `importMnemonic` + restamp, unloading and reloading loaded agents around the restamp. The CLI gains `adf identity import` | Refused, as above |
| Envelope / password / keystore actions per agent | Existing `/agents/:id/identity*` routes plus the password routes; the derived key lives in daemon memory | Same |

The derived key of a password-protected agent MUST reach every consumer in the daemon (provider, MCP, adapters, `AdfCallHandler`); today `unlockAgentIdentityPassword` rebuilds only the provider (`runtime-service.ts:1812`).

### 5.5 Remote mode

The remote daemon is a different machine and therefore a different runtime. Its owner phrase is restored there (`adf identity restore`). Its runtime DID, envelope slots and stamps are its own. Studio shows them as they are. Moving an `.adf` between the laptop and the server is an export/import (§9.3) and follows the existing cross-runtime rules (owner-key re-wrap, `recognized`).

## 6. Recipe parity (daemon builder vs Studio)

The daemon recipe is the target recipe. For each drift item, the user-visible behaviour of Studio wins unless stated.

| Behaviour | Studio fg | BAM | Daemon today | Decision |
|---|---|---|---|---|
| Password derived key | Captured from FILE_OPEN cache | From cache, via gated start | `null` at build; unlock rebuilds provider only | Propagate to provider, MCP, adapters, `AdfCallHandler`; restart affected adapters/MCP after unlock |
| Provider preflight | `validateConfig()` network check, codes `provider_missing`/`provider_unconfigured` | Empty-key check | None | Daemon start route returns the same codes; preflight runs for client-initiated starts, not autostart (BAM parity) |
| `config.name` ← file basename | FILE_OPEN | 568-572 | None | Daemon applies on open and load |
| Runtime rename → file rename | `syncAgentFileToName` | Same | None | Daemon implements `syncAgentFileToName`, re-keys indexes and leases, emits `file_renamed` push |
| MCP reconcile on config change | Fresh start only | None | None | Daemon reconciles on every config write (fixes the Studio reuse-path gap only in daemon mode; recorded as a known baseline difference) |
| Adapter reconcile on config change | Runtime writes only | Same | Runtime and API writes | Keep daemon behaviour; the parity harness records the difference for UI-initiated writes |
| Adapter start | Sequential, no locked stub | Parallel, stub | Parallel, stub, restart after unlock | Keep daemon behaviour |
| MCP setup failure | Keep manager | Keep manager | Manager `null` | Keep manager |
| MCP OAuth | Interactive HIL + app store | HIL while live | Agent store only, silent | App-level store in the daemon secret backend; interactive sign-in as a HIL request whose authorize URL Studio opens (§9.3 for remote callback) |
| Core tool declarations | Shared helper | Shared helper | Private copy (`agent-runtime-builder.ts:350`) | Daemon calls the shared helper (E1) |
| `sys_create_adf` | Review/autostart gated, default provider, template | Ungated, no provider/template | Ungated, provider, template, review marking | Keep daemon behaviour (spawned children are trusted) |
| Mesh registration | `registerAgent` with message bus, derived key | Same | `registerServableAgent`: no message-bus subscription, `isMessageTriggered` false, no config update | Daemon uses the full registration; mesh-triggered turns MUST behave as in Studio |
| Umbilical taps | On | On | Off (`umbilicalTaps: false`) | Turn on, or document why the daemon cannot host taps; the parity harness covers a tap-using agent |
| Prompt settings | Live | Live | Read at boot | Read through a settings accessor at use |
| Compute `hostInfo` | Absent | Present | Present | Keep daemon behaviour |
| Tracked-dir watcher + autostart of new files | chokidar (`ipc/index.ts:1154-1221`) | n/a | None | Daemon gains the watcher; emits `tracked_dirs` push |

### 6.1 Recipe diff (W1-B, 2026-10-14)

Line-by-line comparison of the three recipes: foreground `AGENT_START` (`ipc/index.ts:3678-5008`), `BackgroundAgentManager.doStartAgent` + `setupManagedAgent` (`background-agent-manager.ts:535-1993`), and `AgentRuntimeBuilder.build` with the daemon's mesh wiring (`daemon/index.ts`). It extends the table above. "Builder" is the state before W1-B.

| # | Item | Studio fg | BAM | Builder | Resolution |
|---|---|---|---|---|---|
| 1 | Core tool declarations | Shared helper, fresh read-modify-write | Same | Private copy, wrote the start-time config back | W1-B: shared helper (E1) |
| 2 | `container_exec` → `compute_exec` | Running config only | Same | Persisted | W1-B: running config only |
| 3 | Derived key in MCP env, credential files, OAuth store, adapters, `AdfCallHandler` identity and signing | Captured key | Same | `null` everywhere | W1-B: one per-agent cell; `applyDerivedKey(agent, key)` restarts adapters and MCP servers whose credentials need the key. RuntimeService calls it after an unlock (W1-A); `build({ derivedKey })` for a key held before start |
| 4 | Derived key in `createProviderForModel` | Captured key | Same | `null` (RuntimeService) | W1-A |
| 5 | OAuth connect store | Agent store, app store fallback | Agent store | Agent store | Keep agent store; app store via `mcpOAuthAppStore` once W1-C's `DaemonAppOAuthStore` is passed in `daemon/index.ts` |
| 6 | Capture-on-attach (app token sealed into the agent before an http+oauth connect) | Yes | No | No | W1-B: done when an app store is injected |
| 7 | Interactive OAuth sign-in from an agent call | `mcp_oauth_signin` approval, browser opened by Studio | Same approval, injected runner | None | W1-B: same approval; the daemon runs the flow and raises `mcp_oauth_authorize` with `authorize_url`. Studio daemon mode MUST open that URL without a click (W3-C); remote mode needs the relayed callback (§9.3, W4-B) |
| 8 | Stdio auth preflight (`mcp_install` with `auth`) | Native "Continue" dialog | Same (injected) | Headless: browser best-effort, wait for exit | Open: needs a HIL-based preflight; proposed for W3-C with the registration-test gap (W1-D list) |
| 9 | MCP setup-level failure | Keeps manager, removes scratch dir | Keeps both | Manager `null` | W1-B: BAM behaviour |
| 10 | MCP reconcile on config change | Agents-screen save and `sys_update_config` | None | None | W1-B: on every `applyConfigChange` (agent writes and `RuntimeService.setAgentConfig`); a server `mcp_install` already connected is skipped |
| 11 | `hostDenied` in `mcp_install`/`mcp_restart` results | Yes | No | No | W1-B: yes |
| 12 | Config fan-out after an MCP tool sync | Hand-rolled `updateConfig` | Same | Same | W1-B: `applyConfigChange(…, { notifyHost: false })`, so inner loops re-derive (deliberate difference) |
| 13 | Empty host spawn args filtered (`args.filter(Boolean)`) | Yes | No | No | Keep BAM behaviour |
| 14 | MCP status push, MCP log cache kept after stop | `MCP_SERVER_STATUS_CHANGED`, `mcpLogCache` | Workspace logs | Workspace logs | W2-B (push), W3-C (logs) |
| 15 | Adapter inbound and status pushes | `INBOX_UPDATED`, `ADAPTER_STATUS_CHANGED` | `inbox_updated`, `adapter_status_changed` events | None | W2-B |
| 16 | Umbilical taps | `getTapManager` | Same | Taps registered, `tapManager` not exposed; profile `umbilicalTaps: false` | W1-B: exposed, profile on, ledger entry fixed |
| 17 | Host `onConfigChanged` | Renderer config push, mesh copy, file rename, MCP reconcile, adapter reconcile | Mesh copy, rename scheduled, adapter reconcile | Adapter reconcile | W1-B: mesh copy (through `agent-runtime-signals`), MCP reconcile. Rename: W1-A/W1-E. Config push: W2-B |
| 18 | Agent sets itself `off` | `handleAgentOff`: mesh unregister, owner-off dispose | `onStateOff` → same | Nothing: stays loaded and registered | W1-A (host attachment) |
| 19 | Trigger error shown in the UI | `error` on `AGENT_EVENT` | Display state `error` | Log only | W1-A |
| 20 | Mesh registration | `registerAgent`: bus, `isMessageTriggered`, config and key updates, adapter manager | Same | Servable only; `isMessageTriggered` false (respond_only agents could never reply) | W1-B: full registration inside `registerServableAgent` |
| 21 | Mesh registration while the mesh is disabled | None | None | Registered (served on the mesh port) | W1-B: none |
| 22 | Mesh-defaulted config pushed into the executor after registration | Yes (fresh start) | No | No | Keep BAM behaviour |
| 23 | Main-loop clear | `clearLoop` + reset, then `meshManager.resetAgentSession` (a second clear) | n/a | `RuntimeService.clearAgentChat`: one clear + the same reset | No gap: the W0-A row is met by `clearAgentChat` |
| 24 | Config written during the startup window | Adopted at install (`pickFresherConfig`); MCP startup sync onto a fresh read | Start-time config | Start-time config | No writer exists before the daemon registers an agent. W2-A open documents MUST adopt such writes |
| 25 | Idle sweep (`beforeDispatch` activity, session rehydrate) | n/a | Yes | None | Accepted: memory relief only, nothing visible |
| 26 | Peer discovery | mDNS, tailnet, manual peers | n/a | `[]` | W1-B: `services/runtime-discovery.ts`. It polls the mesh server state (2 s) where Studio reacts in its start/stop handlers. `GET /network/mesh/discovered-runtimes` does not forward `force` yet (`http-api.ts`, W2-A) |

Double delivery: the message-bus subscription adds no delivery path. Nothing calls `MessageBus.send`; local sends deliver in-process (`mesh-manager.ts` `sendMessage`), HTTP and WS ingress go through `processIngressMessage`. `tests/daemon-mesh-parity.test.ts` runs the mesh-triggered turn under both registrations.

## 7. Event parity

Renderer consumers that daemon mode MUST feed with identical payloads:

| Push | Consumers and event types |
|---|---|
| `AGENT_EVENT` | `useAgent.ts:150-657` (state, trigger message, delta batches, tool start/result, loop seq, response metadata, turn complete, error, document/chat/file updated, approvals, asks, suspend, inter-agent message, context injected); `useMeshGraph.ts:410`; `SkillsPanel.tsx:174` |
| `BACKGROUND_AGENT_EVENT_BATCH` | `useBackgroundAgents.ts:27-95`, `utils/background-agent-statuses.ts:23`, `useMeshGraph.ts:426` |
| Others | 21 channels listed in `ipc-channels.ts`; producers in `ipc/index.ts` per the tracker's channel map |

Sources that are not executor events and need daemon producers:

| Event | Studio producer | Daemon producer |
|---|---|---|
| `inter_agent_message` | `ipc/index.ts:5564` from mesh events | Mesh manager → `push`/`executor` frame |
| `chat_updated` outside the executor | `ipc/index.ts:5968` | Same code path in daemon |
| `file_updated` | Workspace file-change callback (`assemble-agent.ts:608`) | Already in the assembled host events |
| `agent_starting` … `agent_stopped` | BAM | `RuntimeService` lifecycle emits |
| `trigger_message` from `onTriggerEvent`, trigger errors | Foreground host bindings | Daemon host attachment |
| `APPROVALS_CHANGED` | `approval-hub.ts` snapshot | Same hub in the daemon; `approvals` push |

Ordering: frames for one agent MUST arrive in executor emission order. One SSE connection per session carries all frames, so ordering holds without cross-stream merging.

Latency: on loopback, a delta frame SHOULD reach `webContents.send` within 50 ms p95 of the executor's 50 ms flush. The harness measures it.

## 8. Packaging and lifecycle

### 8.1 Packaging

- `electron.vite.config.ts` builds a fourth entry, `out/main/daemon.js`, from `src/main/daemon/index.ts`, with `__ADF_VERSION__` defined. electron-builder ships it under `out/**` (already included).
- Studio spawns it with `process.execPath`, `ELECTRON_RUN_AS_NODE=1`, `detached: true`, `windowsHide: true`, and env `ADF_DAEMON_SETTINGS` = Studio's settings path, `ADF_DAEMON_PIDFILE` = the CLI's pid file path (`cli/daemon-control.ts:58-69`), so the CLI and Studio see one daemon. The Electron ABI matches Studio's `better-sqlite3` build; `@napi-rs/keyring` is N-API.
- Electron fuses MUST keep `RunAsNode` enabled; a future hardening change that disables it breaks daemon mode and the sandbox host.
- The daemon logs to the data dir (`docs/daemon/operations.md`); Studio's Help menu gains "Open daemon log" (a `local` channel).

### 8.2 Attach, version and conflicts

New authenticated route `GET /version` (it requires the daemon token like every other route; lead decision 2026-10-14, because `settingsPath`, `dataDir` and `pid` are not for unauthenticated callers. A daemon Studio cannot authenticate to is reported as "a daemon is running on port N but Studio cannot authenticate to it") → `{version, clientApiVersion, settingsPath, dataDir, runtimeId, pid, startedBy: 'studio' | 'cli' | 'service'}`. `DaemonHost` passes the version.

Studio boot in `local` mode:

1. Read the pid file; if a live daemon answers `/health`, call `/version`.
2. Same `settingsPath` and same `clientApiVersion`: attach.
3. Different `clientApiVersion`: show a dialog naming both versions, with "Restart the daemon with Studio's version" and "Use embedded mode for this session". Studio MUST NOT restart a daemon without that choice.
4. Different `settingsPath`: refuse local attach and say which file the running daemon uses.
5. No daemon: spawn, wait for `/health` (90 s budget, same as `cli/daemon-control.ts`), show progress in the window.

The CLI's Studio conflict check (`daemon-control.ts:120-158`) MUST be replaced by the runtime host registry (§10.3): only an embedded-mode Studio on the same settings file is a conflict. A Studio in `local` mode is a client.

### 8.3 Quit behaviour (R4)

Setting `keepDaemonRunning` (Settings → Backend), default `false`.

- `false`: on quit Studio calls `POST /daemon/shutdown` if Studio started this daemon run (`startedBy: 'studio'`) and no other client session is open; otherwise it leaves the daemon running and says so in the log. Its session is created with `exitDaemonWhenClosed: true`, so after a Studio crash the daemon shuts down 60 s after the session expires, if no other session exists, and logs the reason.
- `true`: Studio ends its session and leaves the daemon running. The CLI manages it from then on.

Rationale: default `false` matches embedded mode, where agents stop when Studio quits (R2). A daemon the CLI started is never stopped by Studio.

## 9. Remote mode

### 9.1 What exists

`docs/cli/remote-daemon.md` already supports remote clients: SSH tunnel, bind with `ADF_DAEMON_TOKEN` + `ADF_DAEMON_ALLOWED_HOSTS`, TLS reverse proxy with `ADF_DAEMON_BEHIND_PROXY=1`, local-only identity and shutdown routes, ChatGPT relay login. Studio reuses all of it.

### 9.2 Security model

- Studio stores the URL and the token in `studio-backend.json`, the token as `safe:`. The token MUST be sent only to that URL's origin.
- Studio MUST accept `https:` URLs, `http:` to loopback (SSH tunnel), and `http:` to tailnet addresses (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`). Any other `http:` URL MUST require an explicit "I trust this network; the token is sent unencrypted" confirmation stored with the URL.
- TLS certificates are validated by Node. No option to skip validation.
- The daemon gains no TLS listener. HTTPS is the reverse proxy's or `tailscale serve`'s job, as documented.
- The token is all-powerful; scoped tokens are out of scope.

### 9.3 Remote variants

| Studio feature | `remote` behaviour |
|---|---|
| Open file (native dialog) | Daemon-side picker: tracked directories plus `GET /fs/browse?path=` (new) |
| Drag a local `.adf` in / import | Upload (`POST /files/import`, octet-stream) into a chosen tracked directory |
| Save as / export / share by drag | Download a consistent snapshot (`GET /agents/:id/export`, SQLite backup API) to a local temp file, then the native save dialog or `startDrag` |
| Reveal in folder | Disabled; the path is shown as text |
| `uploadFile` to an agent | `PUT /agents/:id/files/raw` (octet-stream, configurable `bodyLimit`) |
| `adf-file://` | `GET /agents/:id/files/raw` streamed through main |
| MCP OAuth and ChatGPT sign-in callbacks | Studio main runs the local callback listener and relays the code, as `adf auth login --relay` does |
| Compute browser session viewer | Unsupported in v1 (the session URL is the server's loopback) |
| Identity create/restore/unlock, reveal phrase, switch owner | Unsupported by design (§5.4) |
| Host exec approvals, podman, firewall | Act on the server; the firewall panel is `local` and refers to the laptop, so it is hidden in `remote` |

Every unsupported action MUST show a sentence that names the reason and the terminal command to run on the server where one exists.

## 10. Agent lease

### 10.1 Problem

Two runtime hosts on one machine (embedded Studio and a daemon, or two daemons on different settings files) both autostart the same agents: duplicate timers and turns, duplicate Telegram pollers (HTTP 409), contention on mesh port 7295 (`docs/daemon/operations.md:237-249`). Studio in daemon mode runs no agents, so the lease matters for embedded + daemon and daemon + daemon.

### 10.2 Design

- Registry directory: `<per-user config dir>/adf/leases/`, independent of `ADF_USER_DATA_DIR`, `ADF_DAEMON_SETTINGS` and `ADF_INSTANCE`; `ADF_LEASE_DIR` overrides it for tests.
- One lease file per agent file: name `sha256(canonicalKey(realpath))` (same canonical key as `AdfDatabase.openCounts`), content `{v:1, path, agentId, holder:{kind: 'studio-embedded' | 'daemon', pid, runtimeId, settingsPath, startedAt, controlUrl?}, acquiredAt}`.
- Acquire with `open(…, 'wx')` before any host preparation: `AGENT_START` fresh path, BAM `doStartAgent`, `tryAutostart`, `RuntimeService.loadAgent`. Foreground/background hand-offs inside one process keep the lease. Release on dispose. Rename re-keys the lease.
- A lease is stale when its pid is not alive, or, for `daemon` holders, when `controlUrl/version` answers with another pid. A stale lease is replaced (unlink + `wx`; the loser of a race re-reads).
- A live lease held by another process makes start fail with code `agent_leased` and a sentence naming the holder ("agent-1 is running in the ADF daemon, pid 4242"). Autostart records `leased_elsewhere` in its report. No automatic takeover of live leases.
- Scope: one OS user on one machine. `.adf` files on network shares opened from two machines are out of scope (documented).

Rationale against a sidecar lease next to the `.adf`: a sidecar would also cover other OS users and sync to other machines, but it cannot use pid liveness across hosts and would need heartbeat writes into synced folders. Against a lease row inside the `.adf`: it would write to every running agent's file periodically. PID reuse can make a dead embedded holder look alive; the error names the pid, and troubleshooting documents deleting the lease file.

### 10.3 Runtime host registry

`<lease dir>/hosts/<pid>.json` = `{kind, pid, settingsPath, startedAt, version, mode}` for every runtime host process (embedded Studio, daemon). Studio in `local`/`remote` mode does not register as a host. The CLI conflict check reads this registry (§8.2) and keeps the old heuristics only for Studio versions that do not write it.

## 11. Mode switch and handover

Switching backends happens at restart (D9) and moves, not copies, the state that cannot be shared:

| State | embedded → `local` | `local` → embedded |
|---|---|---|
| Running agents | Stopped by Studio at quit; the daemon autostarts per the usual rules | Stopped by the daemon (if Studio stops it) or left running there; embedded Studio then hits `agent_leased` for each, visibly |
| Client settings | Copied into `studio-client-settings.json` | Copied back into `adf-settings.json` |
| Runtime identity | Written to keychain `studio-runtime:<scope>` (§5.3) | Nothing (Studio kept its copy) |
| App-level MCP OAuth | Moved from `mcpOauthCredentials` into the daemon's secret-backend account; removed from Studio | Moved back; removed from the daemon store |
| ChatGPT / Grok sessions | Moved from `auth.json` to `auth.daemon.json` (written with `credential-cipher`); `auth.json` removed | Moved back |
| Open file and focus | Reopened in the daemon after restart | Reopened in embedded after restart |

Studio main performs the handover itself before starting or attaching to the daemon: it has safeStorage, the keychain and the credential-cipher key file, so no route returns secrets over HTTP. If a daemon is already running, Studio asks it to reload the moved stores (`POST /client/reload-credentials`, local-only, carries no secrets).

The switch dialog lists each moved item. Each move is logged. If the daemon already holds a ChatGPT/Grok session for another account, the dialog names both accounts and the user chooses which to keep.

Rationale: ChatGPT and MCP OAuth refresh tokens rotate. A copied session is invalidated in one place the first time the other refreshes it, so one-way import on first switch would sign the user out after switching back. Moving the session with the backend role keeps exactly one live copy.

## 12. Testing

1. **Channel map test** (D2): every channel classified; every `proxied` channel has a handler; every `push` topic has a bridge mapping.
2. **Parity harness** (`tests/parity/`): loads `registerAllIpcHandlers` and `registerDaemonModeHandlers` with a mocked `electron` (`ipcMain.handle` captured into a map, `webContents.send` recorded), the daemon in-process on port 0, a scripted mock provider, and fixture agents `agent-1`, `agent-2` (UUID ids). Each scenario runs the same IPC call sequence against both and diffs normalized results and push sequences (ids, timestamps, DIDs, paths normalized; ordering per agent compared exactly). Runs under Electron-as-Node vitest.
3. **Daemon route tests** for every new route, and `tests/openapi-coverage.test.ts` for the contract.
4. **Lease tests**: two processes racing; stale pid; rename; crash.
5. **Identity tests**: adoption with valid, forged-delegation and mismatched-enc-key entries; unlock cascade; review scenario `mine` across modes.
6. **Handover tests**: round trip embedded → local → embedded with a rotating-refresh fake provider.
7. **Manual checklist and one week of daily use** (separate document).

## 13. Deletion criteria (R3)

Embedded code is deleted when all hold: parity harness green on the three OSes; zero open parity bugs of severity "visible"; one week of daily use in `local` mode with no fallback to embedded; the checklist signed off by the owner. Deletion is its own project and is not scheduled here.

## 14. Owner decisions (2026-10-14)

All five were accepted as recommended. Q2 and Q4 were decided by the lead; Q1, Q3 and Q5 by the owner.

| # | Question | Decision |
|---|---|---|
| Q1 | In `local` mode, should the daemon adopt Studio's runtime identity (§5.3)? | Yes. Without it, review shows own agents as `recognized` depending on the mode. |
| Q2 | Default of "Keep the daemon running when Studio quits"? | Off, matching embedded behaviour. |
| Q3 | Remote transport: https, loopback tunnel and tailnet only, with an explicit opt-in for other plain-HTTP URLs; no TLS in the daemon? | Yes. |
| Q4 | R6 reading: existing `window.adfApi` members keep their signatures and semantics, and new members are allowed for backend selection, daemon status and remote file transfer? | Yes. Settings → Backend cannot exist without new members. |
| Q5 | Embedded code may change only under Rules E1-E3 (§3.2)? | Yes. Copying instead of extracting recreates drift. |
