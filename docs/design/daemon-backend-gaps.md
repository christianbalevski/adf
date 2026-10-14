# Studio on the Daemon Backend: Gap List

**Source of truth**: [`src/main/backend/channel-map.ts`](../../src/main/backend/channel-map.ts) (`gaps` of each entry) · **Design**: [daemon-backend.md](daemon-backend.md) D2 · **Tracker**: [daemon-backend-tracker.md](daemon-backend-tracker.md)

This list groups the channel map's gaps by the workstream that closes them. A gap is what the daemon lacks today for a daemon-mode handler to reach embedded parity: a route, a change to an existing route, a producer for a push, or runtime behaviour. Channels whose daemon routes exist and suffice have no row.

`tests/backend/channel-map.test.ts` fails when a channel with a gap for a workstream is missing from that workstream's section, or a section names a channel the map gives no gap for that workstream. Change the map first, then this file.

Counts at W0-A: 277 channels (276 in `IPC`, 1 raw string channel). 217 `proxied` invoke channels, 50 of them with no daemon route today; 16 `proxied` push channels, all fed from the client stream (W2-B); 7 `remote-variant`, 7 `remote-unsupported`, 30 `local`.

## Reconciliation with the tracker

The briefing gap list the tracker cites was not in the repository at W0-A. This list was built from the handlers in `src/main/ipc/index.ts` and the routes in `docs/daemon/openapi.json`, then compared with the tracker's deliverables.

- **W1-D** covers every tracker item: approvals hub, fleet and mesh stats, dashboard, agent registry, skills catalog, MCP registry, probe, registration test and OAuth status, the three credential-list-files channels, owner envelope, attestations, identity drafts. Added here: offline owner messages (`MESH_MESSAGE_AGENTS`), `TOOLS_DESCRIPTIONS`, `TOKEN_USAGE_CLEAR`, `PROVIDER_TEST`, `PROVIDER_AGENT_KEY_SOURCES`, MCP log cache, `MCP_ENSURE_PYTHON_RUNTIME`, `COMPUTE_REBUILD_CONTAINER`, `COMPUTE_TEST_EXECUTION_TARGET`, `COMPUTE_BROWSER_INFO`, `IDENTITY_CLAIM`, cross-agent adapter status and adapter restart, the two peer fetches, `EMERGENCY_STOP`.
- **W1-E** covers save-as and share snapshot, clone, delete, rename, raw file routes, `GET /fs/browse` and the watcher. Added here: binary template files, the tracked-dir tree scan, rename on config name change (design §6), unique upload names, relocate on review accept. `POST /files/import` and `GET /agents/:id/export` have no `local`-mode channel; W4-B uses them for the remote variants (§9.3).
- **W2-A** covers open documents (D4). Added here: checkpoint, keyset chat paging, `lastTokens`/`contextBaseline`, content blocks in chat, review summary and accept parity. These change existing routes in `src/main/daemon/http-api.ts`, which W2-A owns in wave 2.
- **W1-A** adds the `sandboxMaxWorkers` live apply next to the prompt keys (§4.2). It is read in `src/main/daemon/index.ts`, which W1-A does not own; the lead assigns the hunk.
- **W1-B** adds mDNS and tailnet discovery in the daemon. `GET /network/mesh/discovered-runtimes` returns `[]` today because `src/main/daemon/index.ts:343` wires no discovery; the same ownership note applies.

## W1-A

| Need | Channels |
|---|---|
| config.name <- file basename on open | `FILE_OPEN` |
| provider_missing / provider_unconfigured preflight codes | `AGENT_START` |
| trigger_message, trigger errors and startup-dispatch failures through the host attachment | `AGENT_EVENT` |
| apply sandboxMaxWorkers live (read once at boot, daemon/index.ts:183), like the prompt keys | `SETTINGS_SET` |
| agent_starting ... agent_stopped host lifecycle events | `BACKGROUND_AGENT_EVENT_BATCH` |
| in-flight starts (embedded `starting`): agent_starting / agent_start_failed host events | `BACKGROUND_AGENT_STATUS` |

## W1-B

| Need | Channels |
|---|---|
| MCP reconcile on config change | `DOC_SET_AGENT_CONFIG` |
| the derived key reaches provider, MCP, adapters and AdfCallHandler; restart after unlock | `IDENTITY_PASSWORD_UNLOCK` |
| mDNS and tailnet discovery in the daemon (the route returns [], daemon/index.ts:343), with directory cards, /ping meta and trust decoration | `MESH_DISCOVERED_RUNTIMES` |

## W1-C

| Need | Channels |
|---|---|
| DaemonAppOAuthStore | `MCP_OAUTH_SIGNOUT`, `MCP_OAUTH_STATUS` |
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
| pending asks and approvals across agents (the approvals hub snapshot covers it) | `MESH_PENDING_INTERACTIONS` |
| fleet status rows (AgentVitalsService.getFleetStatus exists in the daemon) | `MESH_FLEET_STATUS` |
| fleet token burn, hydrated from the client key fleetMapState.burnTotals passed as a parameter | `MESH_TOKEN_BURN` |
| one aggregate fleet-map poll: mesh debug, fleet, burn, adapters, peers | `MESH_MAP_POLL` |
| owner message to an agent that refuses to start: append it to the agent loop | `MESH_MESSAGE_AGENTS` |
| tool schema catalog in provider format, including the stubbed runtime tools; GET /agents/:id/tools is per loaded agent and another shape | `TOOLS_DESCRIPTIONS` |
| clear token usage | `TOKEN_USAGE_CLEAR` |
| dashboard quick stats | `DASHBOARD_QUICK_STATS` |
| dashboard provider tests (session-cached) | `DASHBOARD_PROVIDER_TESTS` |
| dashboard agent stats over tracked files | `DASHBOARD_AGENT_STATS` |
| MCP probe (temporary connect, tool list) | `MCP_PROBE_SERVER` |
| MCP registration connect test | `MCP_REGISTRATION_TEST` |
| MCP logs of probe and registration-test runs and of stopped agents (embedded mcpLogCache) | `MCP_GET_SERVER_LOGS` |
| MCP credential-list-files across loaded and tracked agents (metadata only) | `MCP_CREDENTIAL_LIST_FILES` |
| ensure uv and Python on the daemon host (UvManager) | `MCP_ENSURE_PYTHON_RUNTIME` |
| MCP registry (remote-first, cached and bundled fallback) | `MCP_REGISTRY_GET` |
| agent registry listing | `AGENT_REGISTRY_GET` |
| agent registry refresh | `AGENT_REGISTRY_REFRESH` |
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
| provider connection test; force bypasses the session cache | `PROVIDER_TEST` |
| fetch a peer agent shared file (2 MB cap) | `MESH_PEER_SHARED_FILE` |
| peer agent /health probe | `MESH_PEER_AGENT_HEALTH` |
| emergency stop: every agent and the mesh in the daemon, resumable (teardownRuntime emergency) | `EMERGENCY_STOP` |
| mint an identity draft; only { draftId, did } leaves the daemon | `IDENTITY_DRAFT_MINT` |
| discard an identity draft | `IDENTITY_DRAFT_DISCARD` |

## W1-E

| Need | Channels |
|---|---|
| delete an agent file, stopping a running agent first | `FILE_DELETE` |
| clone with selected tables and clone-fixup | `FILE_CLONE` |
| rename an agent file; deferred while it runs (rekeyAgentPath, W1-A) | `FILE_RENAME` |
| emit file_renamed on rename and on accept-relocate | `FILE_RENAMED` |
| identity-free share snapshot of an agent file as bytes (AdfDatabase.snapshotForSend) | `FILE_SHARE_PREPARE`, `FILE_SHARE_SAVE_AS` |
| a name change renames the file (syncAgentFileToName) and returns filePath or renameDeferred | `DOC_SET_AGENT_CONFIG` |
| binary template extra files up to 25 MiB; the route takes text content in a 1 MiB JSON body | `TEMPLATE_ADD_FILES` |
| tracked-dir watcher (embedded starts it from this handler) | `TRACKED_DIRS_GET` |
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
| checkpoint the WAL of an open document | `FILE_SAVE` |
| keyset page of display entries before a seq (beforeSeq); the route pages by offset | `DOC_GET_CHAT_OLDER` |
| lastTokens and contextBaseline of an agent (no route returns them) | `DOC_GET_BATCH` |
| start assembles a runtime on the open document | `AGENT_START` |
| stop keeps the document open while the session holds it | `AGENT_STOP` |
| content blocks (images, files) in the chat body; the route takes text only | `AGENT_INVOKE` |
| review summary parity: identity scenario (deriveReviewIdentity), provider usability, willRelocate and relocateTo | `FILE_CHECK_REVIEW` |
| accept parity: claim, model override, auto-locked fields, envelope provisioning (the route only marks the config reviewed) | `FILE_REVIEW_ACCEPT` |

## W2-B

| Need | Channels |
|---|---|
| hold the file as the session document (POST /client/sessions/:id/documents) | `FILE_OPEN`, `FILE_CREATE`, `FILE_CREATE_QUICK` |
| release the session document (DELETE /client/sessions/:id/documents/:agentId) | `FILE_CLOSE` |
| client-stream push topic `file_renamed` | `FILE_RENAMED` |
| client-stream push topic `config_changed` | `DOC_AGENT_CONFIG_CHANGED` |
| set the session focus to the started agent | `AGENT_START` |
| executor frames, deltas for the focused agent only | `AGENT_EVENT` |
| client-stream push topic `approvals` | `APPROVALS_CHANGED` |
| client-stream push topic `templates` | `TEMPLATES_CHANGED` |
| client-stream push topic `tracked_dirs` | `TRACKED_DIRS_CHANGED` |
| client-stream push topic `mesh` | `MESH_EVENT` |
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
