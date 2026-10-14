# Studio on the Daemon Backend: Gap List

**Source of truth**: [`src/main/backend/channel-map.ts`](../../src/main/backend/channel-map.ts) (`gaps` of each entry) · **Design**: [daemon-backend.md](daemon-backend.md) D2 · **Tracker**: [daemon-backend-tracker.md](daemon-backend-tracker.md)

This list groups the channel map's gaps by the workstream that closes them. A gap is anything the daemon lacks today for a daemon-mode handler to reach embedded parity: a route, a change to an existing route, a producer for a push, or runtime behaviour, including every embedded side effect the handler cannot reproduce from existing routes. Channels whose daemon routes exist and suffice have no row.

`tests/backend/channel-map.test.ts` fails when a row here differs from the map (workstream, need text or channel list), and when an entry's `note` describes embedded behaviour instead of recording it as a gap. Change the map first, then regenerate the rows.

The D2 test "every `proxied` channel has a daemon-mode handler" is W2-C's (`tests/backend/daemon-mode-handlers.test.ts`). W0-A checks only that every `proxied` channel has a route or a gap.

Counts at W0-A: 279 channels (278 in `IPC`, 1 raw string channel). 217 `proxied` invoke channels, 50 of them with no daemon route today; 16 `proxied` push channels, all fed from the client stream (W2-B); 7 `remote-variant`, 7 `remote-unsupported`, 32 `local`.

## Reconciliation with the coverage research

Built from the handlers in `src/main/ipc/index.ts` and the routes in `docs/daemon/openapi.json`, then compared with the lead's IPC-to-HTTP gap list. Every channel on that list has a gap here except the ones below, where this map disagrees on purpose:

- `FILE_SHARE_DISCARD`: `local`. It deletes the snapshot Studio main wrote to its own scratch directory; the daemon holds no state for it.
- `DOC_SET_CHAT`: `local`. Embedded is a no-op that returns success, so the daemon-mode handler is the same no-op.
- `TEMPLATES_MIGRATION_SEEN`: `local`. It writes the client key `templatesMigrationSeen` (§4.1); the daemon-mode `TEMPLATES_LIST` handler drops `migrated` when that key is set, so no route is needed.
- `IDENTITY_OWNER_REVEAL_MNEMONIC`: `remote-unsupported` without a gap. §5.4 has Studio main read the shared keychain entry in `local` mode, and no route carries the phrase.

Added beyond that list: the §6 recipe rows for every start path (W1-B: full mesh registration, umbilical taps, shared `ensureCoreToolDeclarations`, interactive MCP OAuth as a HIL request, MCP manager kept on setup failure; W1-A: prompt settings read at use); create without load (W2-A) because `POST /agents/create` loads and starts the agent; path-addressed access to closed files (W1-E); the agents-folder default (W1-E); the RuntimeGate resume on `POST /agents/load` (W1-D); and every embedded side effect that was a note before.

## Ownership notes for the lead

- W2-A gaps that change existing routes edit `src/main/daemon/http-api.ts`, which W2-A owns in wave 2.
- The W1-B discovery gap is wired in `src/main/daemon/index.ts`, which W1-B does not own.
- The W2-C gap (client-key migrations on `studio-client-settings.json`) followed from `uiFontSystemDefaultApplied` being a client key; closed by W2-C.
## W1-A
All W1-A gaps are closed.
## W1-B
| Need | Channels |
|---|---|
| MCP reconcile on config change | `DOC_SET_AGENT_CONFIG` |
| mesh config update on config change (meshManager.updateAgentConfig) | `DOC_SET_AGENT_CONFIG` |
| main-loop clear resets the mesh session (meshManager.resetAgentSession) | `DOC_CLEAR_CHAT` |
| full mesh registration: message bus subscription, isMessageTriggered, config updates (registerAgent) | `AGENT_START`, `BACKGROUND_AGENT_START` |
| umbilical taps on, or a written reason | `AGENT_START`, `BACKGROUND_AGENT_START` |
| shared ensureCoreToolDeclarations (delete the private copy, agent-runtime-builder.ts:350) | `AGENT_START`, `BACKGROUND_AGENT_START` |
| interactive MCP OAuth as a HIL request carrying the authorize URL; keep the MCP manager on setup failure | `AGENT_START`, `BACKGROUND_AGENT_START` |
| mDNS and tailnet discovery in the daemon (the route returns [], daemon/index.ts:343), with directory cards, /ping meta and trust decoration | `MESH_DISCOVERED_RUNTIMES` |
## W1-C
| Need | Channels |
|---|---|
| DaemonAppOAuthStore | `MCP_OAUTH_SIGNOUT`, `MCP_OAUTH_STATUS` |
## W1-D
All W1-D gaps are closed. The routes are in the channel map; see "Route notes from W1-D" below.
## W1-E
All W1-E gaps are closed. The routes are in the channel map (`/files*`, `/files/agent*`, `/agents/:id/files/raw` and `/meta`, `/fs/browse`, `/tracked-dirs/tree`).
## W2-A
All W2-A gaps are closed: every `/agents/:id/*` route reaches an open document (D4 as built), and the one-call reads, checkpoint, keyset chat paging, content blocks, create without load and the review parity are routes. Studio holds a document only through its client session (the W2-B hold gap below).
## W2-B
| Need | Channels |
|---|---|
| hold the file as the session document (POST /client/sessions/:id/documents) | `FILE_OPEN`, `FILE_CREATE`, `FILE_CREATE_QUICK` |
| self-heal on open: the hold relocates a reviewed file stranded in the daemon host's OS temp dir into the agents folder (POST /files/relocate exists; nothing reports the temp location) | `FILE_OPEN` |
| release the session document (DELETE /client/sessions/:id/documents/:agentId) | `FILE_CLOSE` |
| client-stream push topic `file_renamed` | `FILE_RENAMED` |
| client-stream push topic `config_changed` | `DOC_AGENT_CONFIG_CHANGED` |
| origin dedup: a config write made by a session is not echoed to that session | `DOC_AGENT_CONFIG_CHANGED` |
| clearing the inbox emits the inbox topic with an empty inbox | `DOC_CLEAR_INBOX` |
| set the session focus to the started agent | `AGENT_START` |
| executor frames, deltas for the focused agent only | `AGENT_EVENT` |
| client-stream push topic `approvals` | `APPROVALS_CHANGED` |
| client-stream push topic `templates` | `TEMPLATES_CHANGED` |
| client-stream push topic `tracked_dirs` | `TRACKED_DIRS_CHANGED` |
| client-stream push topic `mesh` | `MESH_EVENT` |
| station:<adapter> message_routed events on adapter inbound (notifyStationInbound) | `MESH_EVENT` |
| executor and host frames for every agent | `BACKGROUND_AGENT_EVENT_BATCH` |
| in-flight starts (embedded `starting`): host frames agent_starting / agent_start_failed (GET /agents lists loaded agents only) | `BACKGROUND_AGENT_STATUS` |
| client-stream push topic `inbox` | `INBOX_UPDATED` |
| client-stream push topic `workspace_data` | `WORKSPACE_DATA_CHANGED` |
| client-stream push topic `mcp_install`, fed by progress callbacks in the install routes | `MCP_INSTALL_PROGRESS` |
| client-stream push topic `mcp_status` | `MCP_SERVER_STATUS_CHANGED` |
| push adf_file_created for the brought-home file | `AGENT_REGISTRY_BRING_HOME` |
| client-stream push topic `browser_session` | `COMPUTE_BROWSER_SESSION` |
| client-stream push topic `compute_phase` | `COMPUTE_CONTAINER_PHASE` |
| client-stream push topic `sandbox_install`, fed by progress callbacks in the install route | `SANDBOX_INSTALL_PROGRESS` |
| client-stream push topic `adapter_install`, fed by progress callbacks in the install route | `ADAPTER_INSTALL_PROGRESS` |
| client-stream push topic `adapter_status` | `ADAPTER_STATUS_CHANGED` |
## W2-C
All W2-C gaps are closed: Studio main runs the client-key migrations on `studio-client-settings.json`, and the `TOOLS_DESCRIPTIONS` handler folds in the open agent's own tools. See "Daemon-mode handlers after W2-C" below.

## W3-A
| Need | Channels |
|---|---|
| a running agent's name change: renameDeferred from GET /files/agent pendingName (PUT /agents/:id/config reports filePath / renameDeferred for open documents only) | `DOC_SET_AGENT_CONFIG` |
| start with hasUserMessage (skip the startup turn's greeting when a message is queued); the answer carries the runtime sessionId | `AGENT_START` |
| binary template extra files up to 25 MiB; PUT /templates/:id/files takes text content in a 1 MiB JSON body | `TEMPLATE_ADD_FILES` |

## Route notes from W1-D

What the daemon-mode handlers (W2-C, W3) need to know about the W1-D routes. Each channel's routes are in the channel map.

- **Wrapped answers.** Two IPC handlers answer a value JSON cannot carry as a body: `APPROVALS_GET_INPUT` (the raw input, or undefined) and `IDENTITY_DRAFT_DISCARD` (a boolean). Their routes answer `{ input }` (`{}` for undefined) and `{ discarded }`; the handlers unwrap them.
- **Addressing.** The approvals and fleet routes take file paths, as the IPC arguments and the approvals hub do. The per-agent identity routes (`/agents/:id/claim`, `/attestations`, `/envelope*`) take an agent id and reach running agents and open documents (`routes/agent-resolver.ts`, W2-A), with the file's derived key once it is unlocked (W1-A).
- **`MCP_GET_SERVER_LOGS`** needs the open agent's id (`agentId`) for live logs; without it the daemon answers the logs it kept from probe, test and agent runs.
- **`TOOLS_DESCRIPTIONS`** returns the built-in and stubbed runtime tools. The daemon-mode handler folds in the open agent's own tools from `GET /agents/:id/tools` (W2-C).
- **Client duties.** The fleet-burn totals are a client key: the handler calls `POST /fleet/burn/hydrate` once per session with `fleetMapState.burnTotals`. The registration test's interactive steps are polled: while its job runs, the handler polls `GET /admin/mcp/interactions?jobId=`, opens `open_url` steps with `shell.openExternal`, shows the native Continue dialog for `confirm` steps and answers `POST /admin/mcp/interactions/:interactionId/continue`. A confirm nobody answers in 5 minutes reads `timed_out` and is named in the result's notes.
- **Jobs.** Work that can take minutes answers `202 { jobId, job }`: `POST /admin/mcp/registration-test` and `POST /admin/mcp/python-runtime`. Poll `GET /jobs/:jobId` until `state` leaves `running`; the job's `result` is the IPC result. `POST /jobs/:jobId/cancel` stops it. Finished jobs are kept 10 minutes. New long-running routes use the same registry (`src/main/daemon/jobs.ts`).
- **Recent tools.** `MESH_GET_RECENT_TOOLS` uses `GET /fleet/recent-tools`, which adds loaded agents the mesh does not track. `GET /network/mesh/recent-tools` (mesh-registered agents only) stays: it is part of the published API the CLI and the terminal app use.
- **Emergency stop** answers `success: false` with `skipped` and `failed` when any part was left running; the handler shows them.

## Daemon-mode handlers after W2-C

`registerDaemonModeHandlers` (`src/main/backend/daemon-mode/index.ts`) registers a handler for every invoke and send channel of the channel map, except the 12 local channels main/index.ts and the services register in both modes (`REGISTERED_OUTSIDE`). `tests/backend/daemon-mode-handlers.test.ts` is the D2 test: every `proxied`, `remote-variant` and `remote-unsupported` channel has a daemon-mode handler, and every push channel fed from the client stream has a bridge mapping (`PUSH_TOPICS` in `event-bridge.ts`). Studio main in daemon mode never loads the embedded IPC layer (`tests/backend/main-boot-daemon.test.ts`).

Implemented by W2-C (24): `FILE_OPEN`, `FILE_CLOSE`, `FILE_GET_CURRENT`, `DOC_GET_BATCH`, `DOC_GET_HEADER`, `DOC_GET_CHAT`, `DOC_READ_INTERNAL_FILE`, `AGENT_START`, `AGENT_STOP`, `AGENT_STATUS`, `AGENT_INVOKE`, `SETTINGS_GET`, `SETTINGS_SET`, `APPROVALS_LIST`, `APPROVALS_RESOLVE`, `APPROVALS_GET_INPUT`, `APPROVALS_GET_PENDING_REVEAL`, `TOOLS_DESCRIPTIONS`, `TEMPLATES_MIGRATION_SEEN`, `DOC_SET_CHAT`, `IDENTITY_PASSWORD_SET`, `IDENTITY_PASSWORD_CHANGE`, `APP_GET_VERSION`, `APP_SET_BADGE_COUNT`.

They use the merged W1-A and W1-E routes: a fresh start is `POST /agents/:id/start?preflight=1` on the file (provider codes, startup turn); the path of a file maps to its running agent through `GET /files/agent`; `DOC_READ_INTERNAL_FILE` reads `/agents/:id/files/meta` and `/agents/:id/files/raw` (a binary it only flags is never downloaded; an inline one is capped by `maxBytes`); `adf-file://` streams `/agents/:id/files/raw`.

Every other channel (218 after W2-C, 174 after W3-B) is registered with a handler that throws `<CHANNEL> is not available in daemon mode yet: <workstream>` (`pending.ts`) and logs one warning per channel the first time it is called: W3-A 86 (files, documents, agent runtime, review, templates, tracked and bulk directories, identity drafts, the share drag), W3-C 40 (MCP, adapters, sandbox packages, skills, registries), W3-D 48 (mesh, fleet, dashboard, token usage, compute, firewall, vitals, emergency stop). Until W3-A, a call of `BACKGROUND_AGENT_STATUS` also announces the running agents as `agent_started` events, so a fresh sidebar is not empty. A W3 workstream adds its table to `handlers/index.ts`; the channel then leaves the pending list.

Renderer call sites that swallow the rejection of a pending channel (`.catch(() => {})` or an empty handler), so only the main log's once-per-channel warning shows it:

| Channel | Workstream | Call sites |
|---|---|---|
| `AGENTS_FOLDER_DEFAULT_GET` | W3-A | `home/HomeComposer.tsx:96`, `home/HomePickers.tsx:452` |
| `BACKGROUND_AGENT_START` | W3-A | `mesh/FleetCommandBar.tsx:224`, `mesh/MeshGraphNode.tsx:214`, `mesh/MeshGraphView.tsx:2521` |
| `BACKGROUND_AGENT_STOP` | W3-A | `mesh/MeshGraphView.tsx:2530` |
| `DOC_GET_AGENT_CONFIG` | W3-A | `agent/AgentConfig.tsx:1114`, `agent/AgentConfig.tsx:1120` |
| `FILE_REVEAL` | W3-A | `layout/Sidebar.tsx:471`, `layout/Sidebar.tsx:501` |
| `FILE_SHARE_PREPARE`, `FILE_SHARE_DISCARD` | W3-A | `hooks/useShareDrag.ts:48`, `hooks/useShareDrag.ts:63` |
| `IDENTITY_DRAFT_DISCARD` | W3-A | `home/NextAgentIdentity.tsx:8` |
| `DASHBOARD_QUICK_STATS`, `DASHBOARD_PROVIDER_TESTS`, `DASHBOARD_AGENT_STATS` | W3-D | `home/useDashboardData.ts:40`, `:45`, `:50` |

Paths are under `src/renderer/components/` (hooks under `src/renderer/`).

Inside the implemented handlers, a step whose daemon route has not landed throws the same error naming the route's workstream; nothing falls back to embedded state:

| Step | Workstream |
|---|---|
| Hold a file as an open document and release it (FILE_OPEN, FILE_CLOSE); until then FILE_OPEN of a file that is not running succeeds without its contents, logged once | W2-B |
| DOC_GET_BATCH, DOC_GET_HEADER, DOC_GET_CHAT, DOC_READ_INTERNAL_FILE of a file that is not running in the daemon (the daemon serves open documents; Studio holds one only through its client session) | W2-B |
| AGENT_START: start with `hasUserMessage`; no `sessionId` in the result | W3-A |
| AGENT_START of a file whose own key is locked: the prompt before the start (design §6.1 row 27) | W3-A |
| FILE_OPEN with the native dialog in remote mode | W4-B |

The client stream is the interim `GET /events` adapter (`createEventsAdapterSession`). It forwards only the umbilical events with an exact executor counterpart (`agent.state.changed`, `turn.completed` with its `absorbed_turn_ids`, `agent.error`), `chat.discarded` (turn bookkeeping) and `agent.loaded` / `agent.unloaded`. Not delivered until W2-B: text and thinking deltas, tool call start and result, `chat_updated`, `trigger_message`, `context_injected`, `response_metadata`, `loop_seq`, document and file updates, approvals, asks, suspend, every push topic, and the host lifecycle events other than load and unload (W1-A emits them in the daemon; they need the client stream).

Interim behaviour W4-A replaces: on the first daemon-mode boot with no `studio-client-settings.json`, Studio copies the client keys of `adf-settings.json` into it (logged; `ClientSettingsStore.seedOnce`). Without it a switch through `ADF_STUDIO_BACKEND` or `studio-backend.json` would reset theme, recent files and the other client keys to their defaults. The mode switch moves them instead (§4.3).

Follow-ups for other workstreams:

- W2-B: implement `ClientSession` (`client-stream.ts`) over `/client/sessions` and pass it as `createSession`. Push frame payloads are the payloads of their IPC channels (`PUSH_TOPICS`); `host` frames carry `state` and `handle` for `agent_started`; executor frames carry the chat `turnId` and, on a turn's end, `absorbedTurnIds`; a stop's dropped chats arrive as a `turn` frame; after a reconnect the session calls `onReattached` before the first frame (design D5).
- W0-C, W0-D, W4-A: the bugs the allowlist below names (client record `controlUrl`, the daemon's lazy host record, the agent lease's `agentId`, `version: null`, client-key defaults written by the daemon).
- W4-A: the quit path ends the client session and leaves the daemon running; the R4 behaviour (stop a Studio-started daemon unless `keepDaemonRunning`) and the version-mismatch choice of §8.2 (shown today as the connection-failure dialog) are W4-A's.
- W5-B: the CI job that runs `tests/parity` with the daemon bundle built and `PARITY_REQUIRE_DAEMON=1`.
- W3-A (renderer, additive): `chat_updated` handling (`useAgent.ts:495`) calls `setLog(uiLog, 0, loop)` and ignores `earlierCount`. Embedded is unaffected: its `chat_updated` carries the whole loop and no `earlierCount` (`ipc/index.ts` `pushForegroundLoop`, `agent-executor.ts` after a compaction). Daemon mode's `stream.gap` resync repaints the last 200 entries (`GET /agents/:id/chat` caps at 500) with `earlierCount`, so after a resync the older entries cannot be paged until the file is reopened. The fix is the renderer honouring `payload.earlierCount` when present.

## Daemon-mode handlers after W3-B

W3-B implemented its 44 channels (`handlers/providers.ts`, `handlers/identity.ts`): `MODELS_LIST`, `PROVIDER_*`, `CHATGPT_*`, `GROK_*`, `CLAUDE_*` and `IDENTITY_*` except the drafts. `SETTINGS_GET` and `SETTINGS_SET` are W2-C's.

- Secrets. App provider keys reach Studio as `__redacted__` only. "Copy app key" (`PROVIDER_CREDENTIAL_SET` with that value) never writes the placeholder: the daemon copies the key it holds (`POST /files/agent/providers/:providerId/credential/copy-app-key`). Stored values the renderer shows (Identity panel Reveal, `IDENTITY_GET`, the provider override key field) come from the local-only reveal routes (`POST /agents/:id/identity/reveal`, `POST /files/agent/identity/reveal`); key material (`crypto:*`) never leaves the daemon, so Reveal on a `crypto:*` row shows nothing in daemon mode. The owner phrase is read from the shared keychain entry in Studio main (§5.4); with the daemon's passphrase file there is none, and "Back up seed phrase" is disabled (`hasMnemonic` false).
- Locked credentials. A credential write the daemon refuses with 409 `credentials_locked` opens a native dialog (Replace / Cancel), as the terminal app asks. Embedded Studio writes the value unsealed without asking, or fails on a sealed one.
- Sign-in. ChatGPT runs the relay flow in both modes (callback server in Studio main, code exchanged and tokens kept by the daemon). Grok's approval page and ChatGPT's sign-in page open in this machine's browser; Claude Code opens its own on the daemon host.
- Owner import refuses a switch while the previous owner's phrase is not backed up (the daemon's rule; embedded Studio switches and loses the old phrase).
- Open gaps kept: `IDENTITY_PASSWORD_UNLOCK` answers `converted: false` (W1-C row above). The per-agent identity channels need the open file's agent in the daemon (W2-B hold), as the core reads do.

## Parity diffs after W2-C

`tests/parity/daemon.test.ts` compares each core scenario's daemon-mode run with the embedded run. Every remaining difference is a named transform in `tests/parity/harness/gaps.ts`, scoped to one place, tagged with the workstream that removes it (or "by design" for a documented per-mode expectation), and applied to the daemon side only. Each entry must match in every scenario it lists, so a fixed gap fails the test until its entry is removed; nothing may be left after them. No normalizer rule hides a difference. The table is generated from the list (`renderGapTable`; `tests/parity/gaps-doc.test.ts` keeps it in step, `PARITY_WRITE_GAPS_DOC=1` rewrites it).

<!-- gap-allowlist:start -->
| Entry | Workstream | Scenarios | Where | Difference |
|---|---|---|---|---|
| `w4a:local-mode-switch` | W4-A | open-agent, start-agent, chat-tool-call, provider-round-trip, agent-provider-key, subscription-status, owner-identity, agent-keystore | harness: emulateLocalModeSwitch() (daemon-backend.ts) | The harness does what the switch to local mode will do: client keys moved to studio-client-settings.json, owner phrase and studio-runtime entry in the (test) keychain. |
| `w2b:open-document-reads` | W2-B | open-agent, start-agent, chat-tool-call | steps: every DOC_GET_BATCH and DOC_READ_INTERNAL_FILE before the first AGENT_START (and their `(threw)` timeline markers), no other step | Reading a file that is not running throws "not available in daemon mode yet: W2-B": the daemon serves open documents (W2-A), but Studio holds one only through its client session. |
| `w3a:start-session-id` | W3-A | start-agent, chat-tool-call, agent-keystore | steps: AGENT_START result `sessionId` | The start route answers no runtime session id. |
| `w2b:agent-event-stream` | W2-B | start-agent, chat-tool-call | AGENT_EVENT: the pushes, their timeline lines and the step push watermarks they shift | The interim GET /events adapter carries only state_changed, turn_complete and error; deltas, tool calls, context, metadata, file updates and loop_seq come with the client stream. |
| `w2b:streaming-check` | W2-B | start-agent, chat-tool-call | problems: the streaming check | No text_delta_batch reaches the window (same cause as w2b:agent-event-stream). |
| `w2b:identity-on-open` | W2-B | open-agent, start-agent, chat-tool-call, agent-keystore | state: adf_identity and adf_attestations rows | The daemon runs its open steps (ensureWorkspaceIdentity on open, W2-A) only for a document a client session holds: no keys, no owner and operator attestations. |
| `w2b:identity-meta` | W2-B | open-agent, start-agent, chat-tool-call, agent-keystore | state: adf_meta rows adf_did, adf_owner_did, adf_runtime_did | Same cause as w2b:identity-on-open: the identity stamps are written on open. |
| `w2b:open-document-handle` | W2-B | open-agent, start-agent | state: adf_meta row adf_clean_close | Nothing holds the file open (no client session to hold it), so the fixture's clean-close marker stays set. |
| `w2b:open-document-wal` | W2-B | open-agent, start-agent | state.tree: the -wal and -shm files of an open agent file | Same cause as w2b:open-document-handle: the file is not held open, so no -wal/-shm beside it. |
| `mode:help-menu` | by design | open-agent, start-agent, chat-tool-call, provider-round-trip, agent-provider-key, subscription-status, owner-identity, agent-keystore | local calls: Menu.setApplicationMenu (Help: the separator, "Open Daemon Log", the status line, "Reconnect to the ADF Daemon") | Daemon mode adds a separator, "Open Daemon Log" and, while not connected, the status line (and "Reconnect to the ADF Daemon") to Help (§8.1). A menu built while not connected (at boot: connecting) is rebuilt on connect; those calls carry the status line and are the daemon mode's own. |
| `w4a:daemon-writes-client-defaults` | W4-A | open-agent, start-agent, chat-tool-call, provider-round-trip, agent-provider-key, subscription-status, owner-identity, agent-keystore | state: client keys at their shipped default in the daemon's adf-settings.json | The daemon's settings store writes the defaults of Studio client keys (menuBarEnabled, updateChecksEnabled, …) into adf-settings.json after the switch moved them out. |
| `mode:client-settings-file` | by design | open-agent, start-agent, chat-tool-call, provider-round-trip, agent-provider-key, subscription-status, owner-identity, agent-keystore | state: user-data/studio-client-settings.json, compared as one merged view with adf-settings.json | Client keys live in studio-client-settings.json (§4.2); a key in both files MUST have one value. |
| `mode:redacted-provider-keys` | by design | provider-round-trip, agent-provider-key | steps: providers[].apiKey in SETTINGS_GET results and in the SETTINGS_SET args that write them back; the PROVIDER_CREDENTIAL_SET value of "Copy app key" | The daemon answers app provider keys as __redacted__ (§4.2) and the renderer writes back what it read; the daemon keeps the stored key and copies the app key itself, so the persisted keys are the same. |
| `w4a:client-record-control-url` | W4-A | open-agent, start-agent, chat-tool-call, provider-round-trip, agent-provider-key, subscription-status, owner-identity, agent-keystore | state.leases: clients/<pid:this-process>.json controlUrl | Bug: Studio's client record names the default daemon port 7385 whatever port the daemon uses (registerClient takes no URL). |
| `w0c:daemon-host-record-lazy` | W0-C | open-agent, provider-round-trip, agent-provider-key, subscription-status, owner-identity | state.leases: the daemon's hosts/<pid>.json while it holds no lease | Bug: the daemon writes its runtime host record only once it holds an agent lease; §10.3 has every runtime host register (embedded Studio does at boot). |
| `w0c:daemon-lease-agent-id` | W0-C | chat-tool-call, agent-keystore | state.leases: the agent lease's agentId | Bug: the daemon's agent lease records agentId null. |
| `w0d:daemon-version-null` | W0-D | start-agent, chat-tool-call, agent-keystore | state.leases: `version` of the daemon's host record and lease holder | Bug: the daemon records version null in its host record and agent leases. |
| `mode:lease-roles` | by design | open-agent, start-agent, chat-tool-call, provider-round-trip, agent-provider-key, subscription-status, owner-identity, agent-keystore | state.leases and their tree lines: runtime host and Studio records | In daemon mode the daemon is the runtime host (hosts/<pid:daemon>.json, lease holder kind daemon, with its controlUrl, §10.2) and Studio a client (clients/<pid>.json, §10.3); mapped to the embedded roles. |
| `mode:daemon-files` | by design | open-agent, start-agent, chat-tool-call, provider-round-trip, agent-provider-key, subscription-status, owner-identity, agent-keystore | state.tree: files of the daemon process | Named: user-data/runtime-enc-key(.pub) (the daemon's enc key), user-data/daemon-local-proof-<port>, its scratch root under temp/ (scratch-root:daemon); user-data/templates/ is created on first use, not at boot. |
| `mode:effective-runtime-host` | by design | start-agent, chat-tool-call, agent-keystore | state: adf_meta adf_effective_runtime `host` field only | The agent file records which host profile ran it: `daemon`, not `studioForeground`. |
<!-- gap-allowlist:end -->
