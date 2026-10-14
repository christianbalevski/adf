# Studio on the Daemon Backend: Gap List

**Source of truth**: [`src/main/backend/channel-map.ts`](../../src/main/backend/channel-map.ts) (`gaps` of each entry) · **Design**: [daemon-backend.md](daemon-backend.md) D2 · **Tracker**: [daemon-backend-tracker.md](daemon-backend-tracker.md)

This list groups the channel map's gaps by the workstream that closes them. A gap is anything the daemon lacks today for a daemon-mode handler to reach embedded parity: a route, a change to an existing route, a producer for a push, or runtime behaviour, including every embedded side effect the handler cannot reproduce from existing routes. Channels whose daemon routes exist and suffice have no row.

`tests/backend/channel-map.test.ts` fails when a row here differs from the map (workstream, need text or channel list), and when an entry's `note` describes embedded behaviour instead of recording it as a gap. Change the map first, then regenerate the rows.

The D2 test "every `proxied` channel has a daemon-mode handler" is W2-C's: it needs the handlers W2-C and W3 register. W0-A checks only that every `proxied` channel has a route or a gap.

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
- The W2-C gap (client-key migrations on `studio-client-settings.json`) follows from `uiFontSystemDefaultApplied` being a client key.
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
| Need | Channels |
|---|---|
| adopt an identity draft (identityDraftId) on create | `FILE_CREATE_QUICK` |
| approvals hub full snapshot across all agents and loops | `APPROVALS_LIST` |
| resolve an approval by (agent, approvalId) | `APPROVALS_RESOLVE` |
| approvals hub in the daemon | `APPROVALS_CHANGED` |
| raw tool input of one pending approval | `APPROVALS_GET_INPUT` |
| mesh debug view: live agent states, bus registrations, message log with a sinceSeq cursor | `MESH_STATUS` |
| recent tools of loaded agents that are not mesh-registered, read from their workspaces | `MESH_GET_RECENT_TOOLS` |
| pending asks and approvals across agents (the approvals hub snapshot covers it) | `MESH_PENDING_INTERACTIONS` |
| fleet status rows (AgentVitalsService.getFleetStatus exists in the daemon) | `MESH_FLEET_STATUS` |
| fleet token burn, hydrated from the client key fleetMapState.burnTotals passed as a parameter | `MESH_TOKEN_BURN` |
| one aggregate fleet-map poll: mesh debug, fleet, burn, adapters, peers | `MESH_MAP_POLL` |
| owner message to an agent that refuses to start: append it to the agent loop | `MESH_MESSAGE_AGENTS` |
| POST /agents/load resumes the RuntimeGate after an emergency stop, as the start route does (runtime-service.ts:792) | `MESH_MESSAGE_AGENTS`, `BACKGROUND_AGENT_START`, `DIRECTORY_START_ALL` |
| tool schema catalog in provider format, including the stubbed runtime tools; GET /agents/:id/tools is per loaded agent and another shape | `TOOLS_DESCRIPTIONS` |
| clear token usage | `TOKEN_USAGE_CLEAR` |
| dashboard quick stats | `DASHBOARD_QUICK_STATS` |
| dashboard provider tests (session-cached); honours providerChecksEnabled | `DASHBOARD_PROVIDER_TESTS` |
| dashboard agent stats over tracked files | `DASHBOARD_AGENT_STATS` |
| MCP probe (temporary connect, tool list) | `MCP_PROBE_SERVER` |
| MCP registration connect test | `MCP_REGISTRATION_TEST` |
| interactive steps reach Studio: the OAuth authorize URL to open and the stdio auth preflight Continue prompt (embedded opens the browser and a native dialog) | `MCP_REGISTRATION_TEST` |
| MCP logs of probe and registration-test runs and of stopped agents (embedded mcpLogCache) | `MCP_GET_SERVER_LOGS` |
| MCP credential-list-files across loaded and tracked agents (metadata only) | `MCP_CREDENTIAL_LIST_FILES` |
| ensure uv and Python on the daemon host (UvManager) | `MCP_ENSURE_PYTHON_RUNTIME` |
| MCP registry (remote-first, cached and bundled fallback); honours remoteCatalogsEnabled | `MCP_REGISTRY_GET` |
| agent registry listing; honours remoteCatalogsEnabled | `AGENT_REGISTRY_GET` |
| agent registry refresh; honours remoteCatalogsEnabled | `AGENT_REGISTRY_REFRESH` |
| bring a registry agent home: copy into the agents folder, strip identity, fresh config.id, default provider | `AGENT_REGISTRY_BRING_HOME` |
| MCP OAuth sign-out (app-level store) | `MCP_OAUTH_SIGNOUT` |
| MCP OAuth status (signed-in flag only) | `MCP_OAUTH_STATUS` |
| skills catalog fetch (guardedFetch) | `SKILLS_CATALOG_GET` |
| skill package fetch (guardedFetch) | `SKILLS_PACKAGE_GET` |
| rebuild a container | `COMPUTE_REBUILD_CONTAINER` |
| probe an external execution target | `COMPUTE_TEST_EXECUTION_TARGET` |
| container phase and noVNC host port for an agent | `COMPUTE_BROWSER_INFO` |
| claim an agent file under the local owner (claimWorkspace) | `IDENTITY_CLAIM` |
| attestations of an agent file | `IDENTITY_ATTESTATIONS_GET` |
| reissue owner and operator attestations | `IDENTITY_ATTESTATIONS_REISSUE` |
| envelope status (identity, credentials, sharePasswordSet) | `IDENTITY_ENVELOPE_STATUS` |
| set the credentials share password | `IDENTITY_ENVELOPE_SHARE_SET_PASSWORD` |
| remove the credentials share password | `IDENTITY_ENVELOPE_SHARE_REMOVE_PASSWORD` |
| unlock foreign credentials with the share password, adopt or session-only | `IDENTITY_ENVELOPE_UNLOCK_PASSWORD` |
| adapter states across all loaded agents, deduped by type, plus perAgent | `ADAPTER_GET_STATUS` |
| restart one adapter of an agent | `ADAPTER_RESTART` |
| adapter credential-list-files across loaded and tracked agents (metadata only) | `ADAPTER_CREDENTIAL_LIST_FILES` |
| provider credential-list-files across loaded and tracked agents (metadata only) | `PROVIDER_CREDENTIAL_LIST_FILES` |
| where each agent provider copy gets its key (agentProviderKeySource), never the key | `PROVIDER_AGENT_KEY_SOURCES` |
| provider connection test; force bypasses the session cache, otherwise honours providerChecksEnabled | `PROVIDER_TEST` |
| fetch a peer agent shared file (2 MB cap) | `MESH_PEER_SHARED_FILE` |
| peer agent /health probe | `MESH_PEER_AGENT_HEALTH` |
| emergency stop: every agent and the mesh in the daemon, resumable (teardownRuntime emergency) | `EMERGENCY_STOP` |
| mint an identity draft; only { draftId, did } leaves the daemon | `IDENTITY_DRAFT_MINT` |
| discard an identity draft | `IDENTITY_DRAFT_DISCARD` |
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
| the route works on an open, not-running document (D4) | `FILE_OPEN`, `FILE_LIST_TABLES`, `DOC_GET_DOCUMENT`, `DOC_SET_DOCUMENT`, `DOC_GET_AGENT_CONFIG`, `DOC_SET_AGENT_CONFIG`, `DOC_GET_CHAT`, `DOC_GET_CHAT_OLDER`, `DOC_CLEAR_CHAT`, `DOC_GET_INBOX`, `DOC_CLEAR_INBOX`, `DOC_GET_OUTBOX`, `DOC_GET_BATCH`, `DOC_GET_HEADER`, `MODELS_LIST`, `DOC_GET_TIMERS`, `DOC_ADD_TIMER`, `DOC_UPDATE_TIMER`, `DOC_DELETE_TIMER`, `DOC_GET_FILES`, `DOC_UPLOAD_FILE`, `DOC_IMPORT_PATHS`, `DOC_PICK_AND_IMPORT`, `DOC_DELETE_INTERNAL_FILE`, `DOC_RENAME_INTERNAL_FILE`, `DOC_RENAME_FOLDER`, `DOC_SET_FILE_PROTECTION`, `DOC_SET_FILE_AUTHORIZED`, `DOC_READ_INTERNAL_FILE`, `DOC_WRITE_INTERNAL_FILE`, `DOC_DOWNLOAD_INTERNAL_FILE`, `DOC_GET_ALL_META`, `DOC_SET_META`, `DOC_DELETE_META`, `DOC_SET_META_PROTECTION`, `DOC_GET_LOGS`, `DOC_GET_LOGS_AFTER`, `DOC_CLEAR_LOGS`, `DOC_GET_TASKS`, `DOC_LIST_LOCAL_TABLES`, `DOC_QUERY_LOCAL_TABLE`, `DOC_DROP_LOCAL_TABLE`, `MCP_CREDENTIAL_SET`, `MCP_CREDENTIAL_GET`, `MCP_ATTACH_SERVER`, `MCP_DETACH_SERVER`, `AGENT_MODEL_SET_FOR_FILE`, `IDENTITY_SET`, `IDENTITY_GET`, `IDENTITY_DELETE`, `IDENTITY_DELETE_PREFIX`, `IDENTITY_LIST`, `IDENTITY_PASSWORD_CHECK`, `IDENTITY_PASSWORD_UNLOCK`, `IDENTITY_PASSWORD_REMOVE`, `IDENTITY_LIST_ENTRIES`, `IDENTITY_REVEAL`, `IDENTITY_WIPE_ALL`, `IDENTITY_GET_DID`, `IDENTITY_GENERATE_KEYS`, `IDENTITY_SET_CODE_ACCESS`, `ADAPTER_CREDENTIAL_SET`, `ADAPTER_CREDENTIAL_GET`, `ADAPTER_ATTACH`, `ADAPTER_DETACH`, `PROVIDER_CREDENTIAL_SET`, `PROVIDER_CREDENTIAL_GET`, `PROVIDER_ATTACH`, `PROVIDER_DETACH` |
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
| client-stream push topic `browser_session` | `COMPUTE_BROWSER_SESSION` |
| client-stream push topic `compute_phase` | `COMPUTE_CONTAINER_PHASE` |
| client-stream push topic `sandbox_install`, fed by progress callbacks in the install route | `SANDBOX_INSTALL_PROGRESS` |
| client-stream push topic `adapter_install`, fed by progress callbacks in the install route | `ADAPTER_INSTALL_PROGRESS` |
| client-stream push topic `adapter_status` | `ADAPTER_STATUS_CHANGED` |
## W2-C
| Need | Channels |
|---|---|
| run the client-key migrations (migrateUiFontSystemDefault, settings-migrations.ts:101-117) on studio-client-settings.json; the daemon file never sees them | `SETTINGS_GET` |
