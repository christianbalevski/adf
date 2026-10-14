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
All W1-E gaps are closed. The routes are in the channel map (`/files*`, `/files/agent*`, `/agents/:id/files/raw` and `/meta`, `/fs/browse`, `/tracked-dirs/tree`).
## W2-A
All W2-A gaps are closed: every `/agents/:id/*` route reaches an open document (D4 as built), and the one-call reads, checkpoint, keyset chat paging, content blocks, create without load and the review parity are routes. Studio holds a document only through its client session (the W2-B hold gap below).
## W2-B
All W2-B gaps are closed: client sessions, focus, session documents, executor/host/push frames with origin dedup (D5.1). Studio main runs on them (W2-C2).
## W2-C
All W2-C gaps are closed: Studio main runs the client-key migrations on `studio-client-settings.json`, and the `TOOLS_DESCRIPTIONS` handler folds in the open agent's own tools. See "Daemon-mode handlers after W2-C" below.

## W3-A
| Need | Channels |
|---|---|
| self-heal on open: a reviewed file stranded in the daemon host's OS temp dir moves into the agents folder (POST /files/relocate exists; nothing reports the temp location) | `FILE_OPEN` |
| a running agent's name change: renameDeferred from GET /files/agent pendingName (PUT /agents/:id/config reports filePath / renameDeferred for open documents only) | `DOC_SET_AGENT_CONFIG` |
| start with hasUserMessage (skip the startup turn's greeting when a message is queued); the answer carries the runtime sessionId | `AGENT_START` |
| `echoed: true` on the chat (the sending window shows the message already): the daemon announces it as a trigger_message, a second user bubble | `AGENT_INVOKE` |
| binary template extra files up to 25 MiB; PUT /templates/:id/files takes text content in a 1 MiB JSON body | `TEMPLATE_ADD_FILES` |
| in-flight starts (embedded `starting`): from the agent_starting / agent_start_failed host frames the bridge sees (GET /agents lists loaded agents only) | `BACKGROUND_AGENT_STATUS` |

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

Every other channel (218) is registered with a handler that throws `<CHANNEL> is not available in daemon mode yet: <workstream>` (`pending.ts`) and logs one warning per channel the first time it is called: W3-A 86 (files, documents, agent runtime, review, templates, tracked and bulk directories, identity drafts, the share drag), W3-B 44 (models, providers, subscription auth, identity), W3-C 40 (MCP, adapters, sandbox packages, skills, registries), W3-D 48 (mesh, fleet, dashboard, token usage, compute, firewall, vitals, emergency stop). Until W3-A, a call of `BACKGROUND_AGENT_STATUS` also announces the running agents as `agent_started` events, so a fresh sidebar is not empty. A W3 workstream adds its table to `handlers/index.ts`; the channel then leaves the pending list.

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
| `CHATGPT_AUTH_STATUS`, `GROK_AUTH_STATUS`, `CLAUDE_AUTH_STATUS` | W3-B | `providers/useProviderManager.ts:103`, `:104`, `:109`, `:210` |
| `DASHBOARD_QUICK_STATS`, `DASHBOARD_PROVIDER_TESTS`, `DASHBOARD_AGENT_STATS` | W3-D | `home/useDashboardData.ts:40`, `:45`, `:50` |

Paths are under `src/renderer/components/` (hooks under `src/renderer/`).

Inside the implemented handlers, a step whose daemon route has not landed throws the same error naming the route's workstream; nothing falls back to embedded state:

| Step | Workstream |
|---|---|
| AGENT_START: start with `hasUserMessage`; no `sessionId` in the result | W3-A |
| AGENT_START of a file whose own key is locked: the prompt before the start (design §6.1 row 27) | W3-A |
| FILE_OPEN with the native dialog in remote mode | W4-B |

Client sessions (W2-C2, `client-stream.ts` `createDaemonClientSession`). Studio opens one session per daemon connection after `GET /version` reports `clientApiVersion` equal to `SUPPORTED_CLIENT_API_VERSION`; another version fails the connection with an "update the daemon" message (no `GET /events` fallback; §8.2's dialog owns version skew). The session is opened with `exitDaemonWhenClosed` in local mode unless `keepDaemonRunning` is set; quitting ends it (`DELETE /client/sessions/:id`) and leaves the daemon running (the R4 stop is W4-A's). Every request carries `X-ADF-Client-Session`, so this window's own config and document writes are not echoed back.

- FILE_OPEN holds the file as a session document (W2-A open documents), so a file that is not running opens with its contents; the focus is the document's id and FILE_OPEN answers once the daemon applied it. Switching files releases the previous document (one kept for its derived key stays held); FILE_CLOSE and quitting release.
- Frames: the focused agent's `executor` frames go to AGENT_EVENT; a frame the daemon reduced (sent before it applied the focus) is never shown there. Other agents' frames (the background whitelist, a truncated `tool_call_start`, a `tool_call_result` with `resultSize`, stubs) feed the background mapping and batcher, which need nothing more. `inter_agent_message` becomes an AGENT_EVENT for the focused agent only, as embedded's `foreground_incoming`. `adf_file_created` (executor event or push) runs embedded's notifyAdfFileCreated against the daemon's tracked folders. `daemon_orphan_hold` is a native notification. `trigger_error` and `startup_failed` add nothing (W1-A emitted the `error`).
- Turn bookkeeping: executor frames carry no turn ids, so the session is opened with `umbilical: true` and Studio reads only `turn.completed`, `agent.error` (with `turn_id`, `absorbed_turn_ids`) and `chat.discarded` from the umbilical frames. Stamping executor frames (D5) would let Studio drop `umbilical: true`.
- Gaps: every `stream.gap` (evicted, oversized, new epoch) resyncs (D6). A loop still mid-turn at the resync gets its `chat_updated` when its turn settles; an AGENT_INVOKE wait whose end may have been lost settles when its loop is not busy. A 404 on reconnect (the session expired, or the daemon restarted) opens a new session, re-holds the documents and the focus before its frames, then resyncs.

Interim behaviour W4-A replaces: on the first daemon-mode boot with no `studio-client-settings.json`, Studio copies the client keys of `adf-settings.json` into it (logged; `ClientSettingsStore.seedOnce`). Without it a switch through `ADF_STUDIO_BACKEND` or `studio-backend.json` would reset theme, recent files and the other client keys to their defaults. The mode switch moves them instead (§4.3).

Follow-ups for other workstreams:

- W2-B follow-up: executor frames do not carry the chat `turnId` / `absorbedTurnIds` and no `turn` frame reports discarded chats (D5 "Turn bookkeeping"); Studio reads them from `umbilical: true` frames meanwhile.
- W3-A: `POST /agents/:id/chat` takes no `echoed`, so the daemon announces Studio's own chat as a `trigger_message` and the renderer shows a second user bubble (allowlist `w3a:chat-echo`). Embedded dispatches the window's chat with `echoed: true`. AGENT_INVOKE should send it.
- W0-C, W0-D, W4-A: the bugs the allowlist below names (client record `controlUrl`, the daemon's lazy host record, the agent lease's `agentId`, `version: null`, client-key defaults written by the daemon).
- W4-A: the quit path ends the client session and leaves the daemon running; the R4 behaviour (stop a Studio-started daemon unless `keepDaemonRunning`) and the version-mismatch choice of §8.2 (shown today as the connection-failure dialog) are W4-A's.
- W5-B: the CI job that runs `tests/parity` with the daemon bundle built and `PARITY_REQUIRE_DAEMON=1`.
- W3-A (renderer, additive): `chat_updated` handling (`useAgent.ts:495`) calls `setLog(uiLog, 0, loop)` and ignores `earlierCount`. Embedded is unaffected: its `chat_updated` carries the whole loop and no `earlierCount` (`ipc/index.ts` `pushForegroundLoop`, `agent-executor.ts` after a compaction). Daemon mode's `stream.gap` resync repaints the last 200 entries (`GET /agents/:id/chat` caps at 500) with `earlierCount`, so after a resync the older entries cannot be paged until the file is reopened. The fix is the renderer honouring `payload.earlierCount` when present.

## Parity diffs after W2-C

`tests/parity/daemon.test.ts` compares each core scenario's daemon-mode run with the embedded run. Every remaining difference is a named transform in `tests/parity/harness/gaps.ts`, scoped to one place, tagged with the workstream that removes it (or "by design" for a documented per-mode expectation), and applied to the daemon side only. Each entry must match in every scenario it lists, so a fixed gap fails the test until its entry is removed; nothing may be left after them. No normalizer rule hides a difference. The table is generated from the list (`renderGapTable`; `tests/parity/gaps-doc.test.ts` keeps it in step, `PARITY_WRITE_GAPS_DOC=1` rewrites it).

<!-- gap-allowlist:start -->
| Entry | Workstream | Scenarios | Where | Difference |
|---|---|---|---|---|
| `w4a:local-mode-switch` | W4-A | open-agent, start-agent, chat-tool-call | harness: emulateLocalModeSwitch() (daemon-backend.ts) | The harness does what the switch to local mode will do: client keys moved to studio-client-settings.json, owner phrase and studio-runtime entry in the (test) keychain. |
| `w3a:start-session-id` | W3-A | start-agent, chat-tool-call | steps: AGENT_START result `sessionId` | The start route answers no runtime session id. |
| `w3a:chat-echo` | W3-A | chat-tool-call | AGENT_EVENT: one `trigger_message` (triggerType chat, the AGENT_INVOKE text) per AGENT_INVOKE, its timeline line and the step push watermarks it shifts | The chat route has no `echoed`: the daemon announces Studio's own chat as a trigger_message, which the renderer shows as a second user bubble (embedded dispatches it with echoed: true). |
| `mode:wire-undefined-keys` | by design | chat-tool-call | pushes: payload keys whose embedded value is `undefined` (e.g. file_updated `previousContent`) | The client stream is JSON: a key whose value is undefined is omitted (D5.1 wire serialization), where embedded IPC keeps the key with undefined. The renderer reads both the same. |
| `mode:help-menu` | by design | open-agent, start-agent, chat-tool-call | local calls: Menu.setApplicationMenu (Help: the separator, "Open Daemon Log", the status line, "Reconnect to the ADF Daemon") | Daemon mode adds a separator, "Open Daemon Log" and, while not connected, the status line (and "Reconnect to the ADF Daemon") to Help (§8.1). A menu built while not connected (at boot: connecting) is rebuilt on connect; those calls carry the status line and are the daemon mode's own. |
| `w4a:daemon-writes-client-defaults` | W4-A | open-agent, start-agent, chat-tool-call | state: client keys at their shipped default in the daemon's adf-settings.json | The daemon's settings store writes the defaults of Studio client keys (menuBarEnabled, updateChecksEnabled, …) into adf-settings.json after the switch moved them out. |
| `mode:client-settings-file` | by design | open-agent, start-agent, chat-tool-call | state: user-data/studio-client-settings.json, compared as one merged view with adf-settings.json | Client keys live in studio-client-settings.json (§4.2); a key in both files MUST have one value. |
| `w4a:client-record-control-url` | W4-A | open-agent, start-agent, chat-tool-call | state.leases: clients/<pid:this-process>.json controlUrl | Bug: Studio's client record names the default daemon port 7385 whatever port the daemon uses (registerClient takes no URL). |
| `w0c:daemon-host-record-lazy` | W0-C | open-agent | state.leases: the daemon's hosts/<pid>.json while it holds no lease | Bug: the daemon writes its runtime host record only once it holds an agent lease; §10.3 has every runtime host register (embedded Studio does at boot). |
| `w0c:daemon-lease-agent-id` | W0-C | chat-tool-call | state.leases: the agent lease's agentId | Bug: the daemon's agent lease records agentId null. |
| `w0d:daemon-version-null` | W0-D | start-agent, chat-tool-call | state.leases: `version` of the daemon's host record and lease holder | Bug: the daemon records version null in its host record and agent leases. |
| `mode:lease-roles` | by design | open-agent, start-agent, chat-tool-call | state.leases and their tree lines: runtime host and Studio records | In daemon mode the daemon is the runtime host (hosts/<pid:daemon>.json, lease holder kind daemon, with its controlUrl, §10.2) and Studio a client (clients/<pid>.json, §10.3); mapped to the embedded roles. |
| `mode:daemon-files` | by design | open-agent, start-agent, chat-tool-call | state.tree: files of the daemon process | Named: user-data/runtime-enc-key(.pub) (the daemon's enc key), user-data/daemon-local-proof-<port>, its scratch root under temp/ (scratch-root:daemon); user-data/templates/ is created on first use, not at boot. |
| `mode:effective-runtime-host` | by design | start-agent, chat-tool-call | state: adf_meta adf_effective_runtime `host` field only | The agent file records which host profile ran it: `daemon`, not `studioForeground`. |
<!-- gap-allowlist:end -->
