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
- The W1-A `sandboxMaxWorkers` gap and the W1-B discovery gap are read or wired in `src/main/daemon/index.ts`, which neither workstream owns.
- The W2-C gap (client-key migrations on `studio-client-settings.json`) followed from `uiFontSystemDefaultApplied` being a client key; closed by W2-C.
## W1-A
| Need | Channels |
|---|---|
| config.name <- file basename on open | `FILE_OPEN` |
| provider_missing / provider_unconfigured preflight codes | `AGENT_START` |
| prompt settings read at use, not at boot | `AGENT_START`, `BACKGROUND_AGENT_START` |
| trigger_message, trigger errors and startup-dispatch failures through the host attachment | `AGENT_EVENT` |
| apply sandboxMaxWorkers live (read once at boot, daemon/index.ts:183), like the prompt keys | `SETTINGS_SET` |
| agent_starting ... agent_stopped host lifecycle events | `BACKGROUND_AGENT_EVENT_BATCH` |
| in-flight starts (embedded `starting`): agent_starting / agent_start_failed host events | `BACKGROUND_AGENT_STATUS` |
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
| the derived key reaches provider, MCP, adapters and AdfCallHandler; restart after unlock | `IDENTITY_PASSWORD_UNLOCK` |
| mDNS and tailnet discovery in the daemon (the route returns [], daemon/index.ts:343), with directory cards, /ping meta and trust decoration | `MESH_DISCOVERED_RUNTIMES` |
## W1-C
| Need | Channels |
|---|---|
| DaemonAppOAuthStore | `MCP_OAUTH_SIGNOUT`, `MCP_OAUTH_STATUS` |
| unlock converts the owner's own legacy whole-file password to envelopes, keeps the password as a share slot, and returns converted | `IDENTITY_PASSWORD_UNLOCK` |
| POST /identity/import (local-only): importMnemonic, restamp, reload loaded agents | `IDENTITY_OWNER_IMPORT` |
## W1-D
All W1-D gaps are closed. The routes are in the channel map; see "Route notes from W1-D" below.
## W1-E
| Need | Channels |
|---|---|
| self-heal on open: move a reviewed agent stranded in the OS temp dir into the agents folder (persistAcceptedAgent) | `FILE_OPEN` |
| tracked_dirs push when create auto-tracks the folder | `FILE_CREATE`, `FILE_CREATE_QUICK`, `FILE_CLONE`, `MESH_FOUND_AGENT` |
| agents folder default without the identity precondition of GET /templates, resolving Documents as Electron app.getPath('documents') does (the daemon uses homedir()/Documents, daemon-agent-factory.ts:249) | `FILE_CREATE_QUICK`, `AGENTS_FOLDER_DEFAULT_GET` |
| delete an agent file, stopping a running agent first | `FILE_DELETE` |
| clone with selected tables and clone-fixup | `FILE_CLONE` |
| reach a closed agent file by path: transient hold or path-addressed file routes (embedded opens a temporary workspace) | `FILE_LIST_TABLES`, `MODELS_LIST`, `MCP_CREDENTIAL_SET`, `MCP_CREDENTIAL_GET`, `MCP_ATTACH_SERVER`, `MCP_DETACH_SERVER`, `AGENT_MODEL_SET_FOR_FILE`, `ADAPTER_CREDENTIAL_SET`, `ADAPTER_CREDENTIAL_GET`, `ADAPTER_ATTACH`, `ADAPTER_DETACH`, `PROVIDER_CREDENTIAL_SET`, `PROVIDER_CREDENTIAL_GET`, `PROVIDER_ATTACH`, `PROVIDER_DETACH` |
| table list with row counts and without FTS shadow tables | `FILE_LIST_TABLES` |
| rename an agent file; deferred while it runs (rekeyAgentPath, W1-A) | `FILE_RENAME` |
| emit file_renamed on rename and on accept-relocate | `FILE_RENAMED` |
| identity-free share snapshot of an agent file as bytes (AdfDatabase.snapshotForSend) | `FILE_SHARE_PREPARE`, `FILE_SHARE_SAVE_AS` |
| a name change renames the file (syncAgentFileToName) and returns filePath or renameDeferred | `DOC_SET_AGENT_CONFIG` |
| binary template extra files up to 25 MiB; the route takes text content in a 1 MiB JSON body | `TEMPLATE_ADD_FILES` |
| tracked-dir watcher (embedded starts it from TRACKED_DIRS_GET) | `TRACKED_DIRS_GET` |
| folder tree scan in the TrackedDirEntry shape: children, pendingName, messaging fields, agentId, icon, did | `TRACKED_DIRS_SCAN` |
| watcher emits tracked_dirs | `TRACKED_DIRS_CHANGED` |
| GET /fs/browse | `DIRECTORY_START_ALL`, `DIRECTORY_STOP_ALL` |
| GET/PUT /agents/:id/files/raw (octet-stream, own bodyLimit) | `DOC_UPLOAD_FILE`, `DOC_IMPORT_PATHS`, `DOC_PICK_AND_IMPORT`, `DOC_DOWNLOAD_INTERNAL_FILE` |
| unique naming on upload (writeFileBufferUnique) | `DOC_UPLOAD_FILE` |
| move an untracked file into the agents folder on accept (persistAcceptedAgent) | `FILE_REVIEW_ACCEPT` |
## W2-A
| Need | Channels |
|---|---|
| the route works on an open, not-running document (D4) | `FILE_OPEN`, `FILE_LIST_TABLES`, `DOC_GET_DOCUMENT`, `DOC_SET_DOCUMENT`, `DOC_GET_AGENT_CONFIG`, `DOC_SET_AGENT_CONFIG`, `DOC_GET_CHAT`, `DOC_GET_CHAT_OLDER`, `DOC_CLEAR_CHAT`, `DOC_GET_INBOX`, `DOC_CLEAR_INBOX`, `DOC_GET_OUTBOX`, `DOC_GET_BATCH`, `DOC_GET_HEADER`, `MODELS_LIST`, `DOC_GET_TIMERS`, `DOC_ADD_TIMER`, `DOC_UPDATE_TIMER`, `DOC_DELETE_TIMER`, `DOC_GET_FILES`, `DOC_UPLOAD_FILE`, `DOC_IMPORT_PATHS`, `DOC_PICK_AND_IMPORT`, `DOC_DELETE_INTERNAL_FILE`, `DOC_RENAME_INTERNAL_FILE`, `DOC_RENAME_FOLDER`, `DOC_SET_FILE_PROTECTION`, `DOC_SET_FILE_AUTHORIZED`, `DOC_READ_INTERNAL_FILE`, `DOC_WRITE_INTERNAL_FILE`, `DOC_DOWNLOAD_INTERNAL_FILE`, `DOC_GET_ALL_META`, `DOC_SET_META`, `DOC_DELETE_META`, `DOC_SET_META_PROTECTION`, `DOC_GET_LOGS`, `DOC_GET_LOGS_AFTER`, `DOC_CLEAR_LOGS`, `DOC_GET_TASKS`, `DOC_LIST_LOCAL_TABLES`, `DOC_QUERY_LOCAL_TABLE`, `DOC_DROP_LOCAL_TABLE`, `MCP_CREDENTIAL_SET`, `MCP_CREDENTIAL_GET`, `MCP_ATTACH_SERVER`, `MCP_DETACH_SERVER`, `AGENT_MODEL_SET_FOR_FILE`, `IDENTITY_SET`, `IDENTITY_GET`, `IDENTITY_DELETE`, `IDENTITY_DELETE_PREFIX`, `IDENTITY_LIST`, `IDENTITY_PASSWORD_CHECK`, `IDENTITY_PASSWORD_UNLOCK`, `IDENTITY_PASSWORD_REMOVE`, `IDENTITY_LIST_ENTRIES`, `IDENTITY_REVEAL`, `IDENTITY_WIPE_ALL`, `IDENTITY_GET_DID`, `IDENTITY_GENERATE_KEYS`, `IDENTITY_CLAIM`, `IDENTITY_SET_CODE_ACCESS`, `IDENTITY_ATTESTATIONS_GET`, `IDENTITY_ATTESTATIONS_REISSUE`, `IDENTITY_ENVELOPE_STATUS`, `IDENTITY_ENVELOPE_SHARE_SET_PASSWORD`, `IDENTITY_ENVELOPE_SHARE_REMOVE_PASSWORD`, `IDENTITY_ENVELOPE_UNLOCK_PASSWORD`, `ADAPTER_CREDENTIAL_SET`, `ADAPTER_CREDENTIAL_GET`, `ADAPTER_ATTACH`, `ADAPTER_DETACH`, `PROVIDER_CREDENTIAL_SET`, `PROVIDER_CREDENTIAL_GET`, `PROVIDER_ATTACH`, `PROVIDER_DETACH` |
| on open: lazy legacy-DID restamp (restampAndAttest), ensureWorkspaceIdentity (keys minted only when reviewed), ADF-stored providers copied into settings.providers, orphan WAL sweep of the folder | `FILE_OPEN` |
| checkpoint the WAL of an open document | `FILE_SAVE` |
| create without load (load: false) and hold the new file as an open document; POST /agents/create loads and starts it (daemon-agent-factory.ts:328) | `FILE_CREATE`, `FILE_CREATE_QUICK` |
| keyset page of display entries before a seq (beforeSeq); the route pages by offset | `DOC_GET_CHAT_OLDER` |
| lastTokens and contextBaseline of an agent (no route returns them) | `DOC_GET_BATCH` |
| one-call batch read: document, config, status meta and the last 200 display entries | `DOC_GET_BATCH` |
| one-call header read: document, config, status meta (called at every main-loop turn end) | `DOC_GET_HEADER` |
| start assembles a runtime on the open document | `AGENT_START` |
| stop keeps the document open while the session holds it | `AGENT_STOP` |
| content blocks (images, files) in the chat body; the route takes text only | `AGENT_INVOKE` |
| create without load (load: false); the file stays closed after creating (ipc/index.ts:6089), POST /agents/create loads and starts it | `MESH_FOUND_AGENT` |
| review summary parity: identity scenario (deriveReviewIdentity), provider usability (honours providerChecksEnabled), willRelocate and relocateTo | `FILE_CHECK_REVIEW` |
| accept parity: claim (removes a legacy whole-file password first, needs the derived key), model override, auto-locked fields, envelope provisioning (the route only marks the config reviewed) | `FILE_REVIEW_ACCEPT` |
## W2-B
| Need | Channels |
|---|---|
| hold the file as the session document (POST /client/sessions/:id/documents) | `FILE_OPEN`, `FILE_CREATE`, `FILE_CREATE_QUICK` |
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

## Route notes from W1-D

What the daemon-mode handlers (W2-C, W3) need to know about the W1-D routes. Each channel's routes are in the channel map.

- **Wrapped answers.** Two IPC handlers answer a value JSON cannot carry as a body: `APPROVALS_GET_INPUT` (the raw input, or undefined) and `IDENTITY_DRAFT_DISCARD` (a boolean). Their routes answer `{ input }` (`{}` for undefined) and `{ discarded }`; the handlers unwrap them.
- **Addressing.** The approvals and fleet routes take file paths, as the IPC arguments and the approvals hub do. The per-agent identity routes (`/agents/:id/claim`, `/attestations`, `/envelope*`) take an agent id and reach loaded agents only; open documents come with W2-A (`routes/agent-resolver.ts` is the one place to extend). They have no derived key until W1-A exposes one, so a whole-file-password file reads its password rows as locked and claim refuses it.
- **`MCP_GET_SERVER_LOGS`** needs the open agent's id (`agentId`) for live logs; without it the daemon answers the logs it kept from probe, test and agent runs.
- **`TOOLS_DESCRIPTIONS`** returns the built-in and stubbed runtime tools. The daemon-mode handler folds in the open agent's own tools from `GET /agents/:id/tools` (W2-C).
- **Client duties.** The fleet-burn totals are a client key: the handler calls `POST /fleet/burn/hydrate` once per session with `fleetMapState.burnTotals`. The registration test's interactive steps are polled: while its job runs, the handler polls `GET /admin/mcp/interactions?jobId=`, opens `open_url` steps with `shell.openExternal`, shows the native Continue dialog for `confirm` steps and answers `POST /admin/mcp/interactions/:interactionId/continue`. A confirm nobody answers in 5 minutes reads `timed_out` and is named in the result's notes.
- **Jobs.** Work that can take minutes answers `202 { jobId, job }`: `POST /admin/mcp/registration-test` and `POST /admin/mcp/python-runtime`. Poll `GET /jobs/:jobId` until `state` leaves `running`; the job's `result` is the IPC result. `POST /jobs/:jobId/cancel` stops it. Finished jobs are kept 10 minutes. New long-running routes use the same registry (`src/main/daemon/jobs.ts`).
- **Recent tools.** `MESH_GET_RECENT_TOOLS` uses `GET /fleet/recent-tools`, which adds loaded agents the mesh does not track. `GET /network/mesh/recent-tools` (mesh-registered agents only) stays: it is part of the published API the CLI and the terminal app use.
- **Emergency stop** answers `success: false` with `skipped` and `failed` when any part was left running; the handler shows them.

## Daemon-mode handlers after W2-C

`registerDaemonModeHandlers` (`src/main/backend/daemon-mode/index.ts`) registers a handler for every invoke and send channel of the channel map, except the 12 local channels main/index.ts and the services register in both modes (`REGISTERED_OUTSIDE`). `tests/backend/daemon-mode-handlers.test.ts` is the D2 test: every `proxied`, `remote-variant` and `remote-unsupported` channel has a daemon-mode handler, and every push channel fed from the client stream has a bridge mapping (`PUSH_TOPICS` in `event-bridge.ts`).

Implemented by W2-C (24): `FILE_OPEN`, `FILE_CLOSE`, `FILE_GET_CURRENT`, `DOC_GET_BATCH`, `DOC_GET_HEADER`, `DOC_GET_CHAT`, `DOC_READ_INTERNAL_FILE`, `AGENT_START`, `AGENT_STOP`, `AGENT_STATUS`, `AGENT_INVOKE`, `SETTINGS_GET`, `SETTINGS_SET`, `APPROVALS_LIST`, `APPROVALS_RESOLVE`, `APPROVALS_GET_INPUT`, `APPROVALS_GET_PENDING_REVEAL`, `TOOLS_DESCRIPTIONS`, `TEMPLATES_MIGRATION_SEEN`, `DOC_SET_CHAT`, `IDENTITY_PASSWORD_SET`, `IDENTITY_PASSWORD_CHANGE`, `APP_GET_VERSION`, `APP_SET_BADGE_COUNT`.

Every other channel (218) is registered with a handler that throws `<CHANNEL> is not available in daemon mode yet: <workstream>` (`pending.ts`): W3-A 86 (files, documents, agent runtime, review, templates, tracked and bulk directories, identity drafts, the share drag), W3-B 44 (models, providers, subscription auth, identity), W3-C 40 (MCP, adapters, sandbox packages, skills, registries), W3-D 48 (mesh, fleet, dashboard, token usage, compute, firewall, vitals, emergency stop). A W3 workstream adds its table to `handlers/index.ts`; the channel then leaves the pending list.

Inside the implemented handlers, a step whose daemon route has not landed throws the same error naming the route's workstream; nothing falls back to embedded state:

| Step | Workstream |
|---|---|
| Hold a file as an open document and release it (FILE_OPEN, FILE_CLOSE); until then FILE_OPEN of a file that is not running succeeds without its contents, logged once | W2-B |
| DOC_GET_BATCH, DOC_GET_HEADER, DOC_GET_CHAT, DOC_READ_INTERNAL_FILE of a file that is not running in the daemon | W2-A |
| `lastTokens` and `contextBaseline` in DOC_GET_BATCH (answered `undefined` / `null`, logged once) | W2-A |
| AGENT_START: start on the open document with `hasUserMessage` and the foreground startup dispatch; today it loads the file (`POST /agents/load`), which starts it without the startup turn; no `sessionId` in the result | W2-A, W1-A |
| AGENT_INVOKE with image or file content blocks | W2-A |
| FILE_OPEN with the native dialog in remote mode | W4-B |
| `adf-file://` (answers 501) | W1-E |

The client stream is the interim `GET /events` adapter (`createEventsAdapterSession`). It forwards only the umbilical events with an exact executor counterpart (`agent.state.changed`, `turn.completed`, `agent.error`) and `agent.loaded` / `agent.unloaded`. Not delivered until W2-B: text and thinking deltas, tool call start and result, `chat_updated`, `trigger_message`, `context_injected`, `response_metadata`, `loop_seq`, document and file updates, approvals, asks, suspend, every push topic, and the host lifecycle events other than load and unload (W1-A, W2-B).

Follow-ups for other workstreams:

- W2-B: the push frame payload of each topic is the payload of its IPC channel (`PUSH_TOPICS`); `host` frames carry `state` and `handle` for `agent_started`; executor frames carry the chat `turnId` (AGENT_INVOKE waits on it). Implement `ClientSession` (`client-stream.ts`) over `/client/sessions` and pass it as `createSession`.
- W0-C / W4-A: `registerClient` has no daemon URL, so the client record's `controlUrl` names the default port 7385 whatever port the daemon uses.
- W0-D: the daemon's host record and the agent lease carry `version: null`.
- W4-A: the quit path ends the client session and leaves the daemon running; the R4 behaviour (stop a Studio-started daemon unless `keepDaemonRunning`) and the version-mismatch choice of §8.2 (shown today as the connection-failure dialog) are W4-A's.

## Parity diffs after W2-C

`tests/parity/recordings/<scenario>.daemon.txt` against `<scenario>.embedded.txt`, for open-agent, start-agent and chat-tool-call. No normalizer rule hides any of them. Differences that remain and who closes them:

| Difference | Scenarios | Workstream |
|---|---|---|
| DOC_GET_BATCH and both DOC_READ_INTERNAL_FILE calls throw (file not running, no open document) | all | W2-A, W2-B |
| On open the daemon does not mint the agent's identity: `adf_identity` and `adf_attestations` empty, no `adf_did`, `adf_owner_did`, `adf_runtime_did` meta, no `adf_loop_tools_backfilled`, `adf_clean_close` left set, no `-wal`/`-shm` while open | all | W2-A |
| AGENT_START result has no `sessionId` | start-agent, chat-tool-call | W2-A |
| No startup turn on start (no `trigger_message`, no model call, empty loop): start with the foreground startup dispatch | start-agent | W2-A, W1-A |
| One provider preflight request fewer (Studio's `validateConfig` check on a client-initiated start) | chat-tool-call | W1-A |
| AGENT_EVENT carries only `state_changed`, `turn_complete`, `error`: no deltas (streaming check fails), tool start/result, `context_injected`, `response_metadata`, `file_updated`, `loop_seq`, `chat_updated`; AGENT_INVOKE therefore resolves after 5 pushes, not 17 | start-agent, chat-tool-call | W2-B |
| AGENT_STOP pushes `state_changed: stopped` (the executor's own event), which the embedded foreground stop does not send | start-agent | W2-B (focus and lifecycle), triage W5-A |
| `adf_effective_runtime` meta records host `daemon`, not `studioForeground` | start-agent, chat-tool-call | by design; triage W5-A |
| Help menu has "Open Daemon Log" (disabled until connected) | all | by design (§8.1) |
| `recentFiles` and the other client keys live in `studio-client-settings.json`; `adf-settings.json` has no `recentFiles` | all | by design (§4.2) |
| Lease registry: Studio is `clients/<pid>.json` (`studio-client`), the daemon `hosts/<pid>.json`; the agent lease is held by the daemon | all | by design (§10.3) |
| `user-data` has the daemon's `runtime-enc-key`, `runtime-enc-key.pub`, `daemon-local-proof-<port>`; no `templates/` until the template service is first used; a daemon scratch root under `temp/` | all | by design; triage W5-A |
| The persisted turn checkpoint and context baseline rows follow from the missing startup turn and deltas | start-agent | W2-A, W2-B |

The rows marked "by design" are differences in where daemon mode keeps things. Whether the harness compares them per mode or by contents is a W5-A decision; W2-C does not normalize them away.
