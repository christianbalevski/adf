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
| `embedded` | `registerAllIpcHandlers` (`src/main/ipc/index.ts:1864`) | Studio main process. Legacy since Q6 (§14): a fallback for one release |
| `local` | Daemon on this machine, same settings file and data dir as Studio | Daemon process spawned or attached by Studio. The default since Q6 (§4.4) |
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

#### D4 as built (W2-A)

Code: `src/main/runtime/document-host.ts` (records), `RuntimeService` (lifecycle), `src/main/daemon/routes/agent-resolver.ts` (the one resolver other route modules use).

| Item | Behaviour |
|---|---|
| Hold API (W2-B) | `RuntimeService.openDocument(filePath, { holder })` → `{agentId, filePath, name, running, needsPassword, holders, nameChangedFrom?}` (Studio's FILE_OPEN answer; `running` is `agentWasRunning`). `releaseDocument(idOrPath, holder)` releases one hold. `releaseDocumentHolder(holder)` is the session-expiry hook: it releases every document of that holder and forgets the keys it unlocked. A holder is a client session id (a UUID, as W2-B mints them; other strings are refused with 400). Holders that are not live sessions are released by a sweep: with W2-B's check (`setDocumentHolderCheck`), every holder it does not know; until that hook is set, a holder that held nothing for 60 s (D5's session expiry). So a client that never releases cannot pin a file. `'document-opened'` and `'document-closed'` events report the changes. |
| One workspace | A document and the runtime started on it share one `AdfWorkspace` and one derived-key cell. Start on a document assembles on its workspace; opening a running agent's file joins the runtime's workspace. The workspace belongs to the document while it is held (`setWorkspaceOwnership(false)`) and to the runtime once the last holder releases it. A failed start reopens the document's file when the build closed it. |
| Routes | Every `/agents/:id/*` resource route resolves a running agent first, then an open document. Runtime actions on a document that is not running (chat, trigger, abort, interrupt, compact, loop changes, display state, approvals, asks, suspend, MCP restart) answer `409 agent_not_running`. Stop and unload of such a document are no-ops. `GET /agents` lists running agents only. |
| Invisible | Opening emits no `'agent-loaded'` (the mesh registers on it), builds no executor or trigger evaluator (no timers, triggers or adapters run) and adds nothing to the loaded-path index, so autostart does not count it as loaded: an autostart agent that is open starts on the document's workspace. |
| Open steps | Studio's FILE_OPEN: envelope unlock, then (owner identity ready) the lazy legacy-DID restamp and `ensureWorkspaceIdentity` with keys minted only for a reviewed file; `config.name` from the file name; the agent's own providers added to `settings.providers` without a key; the orphan WAL sweep of the folder, deferred. A file another live runtime holds the lease of opens read-only: none of these steps runs, the answer carries `readOnly` (the sentence naming the holder) and writes are refused. AdfWorkspace.open's own maintenance (the schema migration of an old file, the clean-close marker, the skills registry) still runs, as for any second process that opens the file; a truly read-only workspace needs a read-only AdfDatabase open (not built). |
| Lease | An open document takes no agent lease. Opening is not running, and embedded Studio's FILE_OPEN takes none, so a file open in one runtime never blocks another runtime from starting it. A start on the document takes the lease as every load does; stop releases it and the document stays open. A write through a document that is not running is refused with `409 agent_leased`, naming the holder, while another live runtime holds the file's lease (an HTTP `preHandler`; the same rule as W1-E's writes to closed files). Reads always work. This keeps one runtime from editing a file another one runs. Embedded Studio allows that edit today; the case needs two runtimes on one file, which the CLI conflict check already refuses for one settings file. |
| Derived key (D3) | Studio caches a file-password key per path for its process lifetime. Here the key lives in the document's cell, so it survives stop and start while the file is open. Only the session that typed the password (the unlock call's `X-ADF-Client-Session` header) remembers it, and reopens the file without a prompt; its expiry drops the key. Trust model: one owner. While the document is open, every session holding it uses the unlocked key (several windows of one owner, as one Studio); a session that joins an unlocked document is not prompted, but it does not remember the key, so it is prompted after the document closes. The per-session cache saves prompts; it does not isolate sessions from each other. Removing the password or wiping the identity forgets the key everywhere. |
| Start window | A config write through the document while a start on it is building reaches the file but no executor. The start counts such writes and, after the build, adopts the file's config with `applyConfigChange` (Studio's `pickFresherConfig` at install). |
| File moves | A rename of a document that is not running closes its workspace, moves the file and reopens it at the new path (Studio's `performAdfRename`), keeping holders and key. Accept-relocate does the same (`withDocumentMoved`); while that asynchronous move runs, every route, start and open of the document answers `409 file_moving`. No load, open or reopen creates a missing file. DELETE closes the document for every holder first. |
| Review accept | Refused with `409 agent_leased` while another runtime runs the file (accept writes identity, model and locked fields; a claim re-keys). The answer lists `lockedFields`, and the TUI names them. |

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
- Reattach: when the stream reopens after a drop (an exact resume, an eviction or a new epoch), the client re-sends its focus and re-holds every document it holds before it processes the first frame of the new connection. Studio's `ClientSession` contract has this as `ClientStreamListener.onReattached` (`src/main/backend/daemon-mode/client-stream.ts`).
- Turn bookkeeping: `executor` frames carry the `turnId` of the chat that started the turn and, on `turn_complete` and `error`, the turn ids it absorbed (`absorbed_turn_ids`); a stop that drops queued chats or cuts off running ones sends a `turn` frame with their ids. A client waiting for a chat's turn (Studio's AGENT_INVOKE) settles on these, also when the end arrived before the client knew the id.

Rationale: the existing `/events` stream is lossy for UI purposes (no `chat_updated`, `loop_seq`, `trigger_message`, `adf_file_created`, delta batches, full `tool_call_result`, BAM lifecycle events) and is global. Translating umbilical events back into executor events would be a second, drifting copy of the mapping in `agent-executor.ts:5423-5482`. The raw events already exist (`'agent-event'`), so forwarding them costs little. Domain frames, not IPC payloads, keep the daemon free of Studio's channel names and stay useful for the terminal app (richer chat view).

#### D5.1 Client stream contract (W2-B)

Code: `src/main/daemon/client-sessions.ts` (registry, frames, producers), `src/main/daemon/routes/client-routes.ts` (routes), `src/main/daemon/sse-wire.ts` (serializer); client methods `createClientSession`, `clientSessionEvents`, `setClientSessionFocus`, `holdClientSessionDocument`, `releaseClientSessionDocument`, `endClientSession`, `withClientSession` in `src/shared/daemon-client/client.ts`. Route bodies and answers are in `openapi.json`.

Additions to the table above, all additive: `POST …/documents` takes `{filePath}` or `{agentId}`; `GET …/events` also takes `epoch` and `Last-Event-ID`, and without `since` replays from the session's first frame; the `host` frame also carries the lifecycle `payload` and `timestamp`; `POST /client/sessions` answers 201 and takes `umbilical: true`, which adds a fourth frame kind, `umbilical` `{agentId, event}`: every envelope `GET /events` carries except `turn.delta` (the focused agent's tokens arrive as `executor` frames). The terminal app sets it; Studio does not.

Turn bookkeeping (W5-A2, client API version 2): RuntimeService stamps each executor event with the `turnId` of the async context's turn (the umbilical `turn_id` of the same event) and, on `error` and a `turn_complete` that was not interrupted, the executor's absorbed ids (`absorbedTurnIds`); `executor` frames carry both, also when stripped. The executor's `chat.discarded` becomes a fifth frame kind, `turn` `{agentId, filePath, loop?, outcome: 'discarded', turnIds, unansweredTurnIds}`, sent to every session. Studio's AGENT_INVOKE waits settle on these (`client-stream.ts` `turnEndOf`); it no longer opens its session with `umbilical: true`.

Delivery:

- Fan-out is per session. Each session has its own ring, cursor space (`epoch`), focus, documents and expiry clock; sessions share nothing but the serialized frame text. A slow, absent or expired session MUST NOT delay, drop or reorder frames of another session.
- One SSE connection per session; a new connect replaces the open one. Frames of one agent arrive in emission order on that connection.
- The ring holds the newest 4096 frames and at most 32 Mi serialized characters (the newest frame always stays). The stream writes until the socket refuses, then waits for `drain`; frames keep landing in the ring. A frame evicted before it was written MUST be announced: `stream.gap` `{reason: 'evicted', dropped, requestedCursor, oldestCursor, latestCursor, epoch}` precedes the next frame. Memory per session is the ring plus one 64 Ki-character write chunk. A single frame over 4 Mi characters (MAX_FRAME_CHARS) is not kept: the session that would get it sees `stream.gap` reason `oversized` (with `size`); other sessions are not touched.
- The shared client's `EventStream` reports every `stream.gap`, including one in the middle of a live connection, through `onGap`.
- Payload size matches embedded (lead decision 2026-10-14). The session focused on an agent gets its full payloads, as embedded IPC sends the open file's `AGENT_EVENT`. Every other session gets what `BACKGROUND_AGENT_EVENT_BATCH` carries: `state_changed`, `ask_request`, `tool_approval_request`, `response_metadata`, `error`, `turn_complete` and `adf_file_created` in full; `tool_call_start` in full but with each top-level `input` field cut to 2048 characters (`inputTruncated: true`, `stripped: 'tool_input'`; the mesh graph shows the arguments and draws the `msg_send` pulse from `input`); `tool_call_result` as `result: {isError}` plus `resultSize` (`stripped: 'tool_result'`; that is what `stripForRenderer` keeps, so the bridge MUST take `resultSize` from the payload); every other executor type as a stub, `stripped: 'stub'`: its scalar fields and strings up to 200 characters, plus `size` (so `file_updated` keeps `path`, `chat_updated` `contextBaseline`). `inbox` arrives as `{counts: {unread, read, archived}}` and `inter_agent_message` without `content` (with `size`). Clients fetch details on demand. One agent's large write therefore never fills another session's ring.
- Origin dedup: a request to `/agents/:id/*` with header `X-ADF-Client-Session: <id>` (`withClientSession`) stamps only its own writes. The route handler's synchronous part, where it calls the RuntimeService write, runs inside `runAsClientWrite`; the `config_changed` / `file_updated` that write raises synchronously (and the `document_updated` of `PUT …/document`) is not sent to that session. No async context is used: work the request queues (the turn `POST …/chat` starts, a timer, the startup turn of `POST …/start`) and changes the agent makes meanwhile reach that session as every other. The stamping preHandler MUST stay the last one, so its `done()` runs the handler.
- A frame whose payload cannot be serialized keeps its envelope (`kind`, type, agent); the payload becomes `{unserializable: reason}` and the frame carries `unserializable: true`. A `PUT /agents/:id/document` raises `document_updated` (the event an agent's own `fs_write` of `document.md` raises), so other clients refresh through the same renderer path.
- `trigger_error` and `startup_failed` host frames follow an `error` executor frame that RuntimeService already emitted (W1-A). The bridge MUST NOT synthesize a second `error` for them.

Push topics. Each payload is the IPC payload of the named channel; `agentId`/`filePath` on the frame name the agent (null for daemon-wide topics). Pushes embedded Studio sends only for the open file are sent for every agent; the client filters.

| Topic | Channel | Daemon source |
|---|---|---|
| `config_changed` | `DOC_AGENT_CONFIG_CHANGED` | `agent-runtime-signals` config change of a loaded agent; mesh-persisted defaults (`setConfigPersistedListener`) |
| `inbox` | `INBOX_UPDATED` | mesh `inbox_updated`; adapter `inbound`; `DELETE /agents/:id/inbox` (empty inbox) |
| `workspace_data` | `WORKSPACE_DATA_CHANGED` | workspace data-change callback of a loaded agent, 250 ms per scope |
| `approvals` | `APPROVALS_CHANGED` | `approvalHub.subscribe`: the full snapshot, not a delta (the hub coalesces; a late or resynced client is correct after one frame) |
| `mesh` | `MESH_EVENT` | mesh `mesh_event`; `station:<adapter>` `message_routed` on adapter inbound |
| `inter_agent_message` | `AGENT_EVENT` `inter_agent_message` (focused agent); the mesh-graph `msg_recv` pulse | mesh `agent_incoming`: every delivery to a registered agent (local send, ingress, message bus); the daemon registers no foreground agents, so `foreground_incoming` never fires there |
| `templates` | `TEMPLATES_CHANGED` | the templates service: its writes and the templates-folder watcher (`DaemonAgentFactory` `notifyTemplatesChanged`), debounced as in Studio |
| `daemon_orphan_hold` | none (the TUI shows a notice) | orphan rule, below |
| `tracked_dirs` | `TRACKED_DIRS_CHANGED` | `TrackedDirWatcher` (W1-E) |
| `file_renamed` | `FILE_RENAMED` | `TrackedDirWatcher`; RuntimeService `agent-file-renamed` / `agent-path-changed`; the same rename within 500 ms is sent once |
| `agent_path_changed` | none (session state) | RuntimeService `agent-path-changed` |
| `autostart`, `autostart_overflow` | none (no Studio push) | `TrackedDirWatcher` |
| `adf_file_created` | the bridge runs `notifyAdfFileCreated` | `POST /registry/agents/:id/bring-home` success (`sys_create_adf` arrives as an `executor` frame) |
| `mcp_install`, `adapter_install`, `sandbox_install` | `*_INSTALL_PROGRESS` | the admin install routes' package services (`withInstallProgress`); agent-driven installs push nothing, as in Studio |
| `mcp_status` | `MCP_SERVER_STATUS_CHANGED` | loaded agent's `McpClientManager` `status-changed`, with `toolCount` |
| `adapter_status` | `ADAPTER_STATUS_CHANGED` | loaded agent's `ChannelAdapterManager` `status-changed` |
| `compute_phase`, `browser_session` | `COMPUTE_CONTAINER_PHASE`, `COMPUTE_BROWSER_SESSION` | compute service events |

Sessions and documents:

- A session expires 60 s after its stream disconnects, or after creation if it never connects; a stream that closed before it was attached never counts as connected. Session documents are W2-A's open documents (`wireDocumentsToClientSessions`): hold = `runtime.openDocument(path, {holder: sessionId})`, release = `releaseDocument`, expiry and `DELETE /client/sessions/:id` = `releaseDocumentHolder(sessionId)`. The holder is always the session id from the route, never a request body, and answers never list holders; `POST /agents/create` with `load: false` takes its holder from the `X-ADF-Client-Session` header and requires a live session. W2-A's holder sweep asks `setDocumentHolderCheck` whether a holder is a live session, so a live session's documents are never swept. Then each `onSessionEnded` listener gets `{sessionId, client, reason: 'ended' | 'expired' | 'shutdown', documents}`.
- Orphan rule (§8.3): when an `exitDaemonWhenClosed` session expires and GET /version `startedBy` is `studio`, the daemon shuts down if no other session is open. If others are open, the shutdown is pending: they get `daemon_orphan_hold` `{holding: true}`, and every later end or expiry of a session re-checks it, so the daemon stops when the last one ends. A new `exitDaemonWhenClosed` session (Studio back) clears it (`holding: false`). Each decision is logged with its reason. `DELETE` of the owning session never stops the daemon: a quitting Studio decides that itself (§8.3).

Terminal app (`src/main/tui/state/store.tsx`, `state/client-stream.ts`): on start it reads `GET /version`; with `clientApiVersion` equal to `SUPPORTED_CLIENT_API_VERSION` it opens a session (`client: 'tui'`, `umbilical: true`) and reads its stream, else it keeps `GET /events` and writes the reason once to its activity log. Its focus is the agent whose chat view is open. `umbilical` frames feed the existing reducer unchanged; the focused agent's delta batches become a synthetic `turn.delta` (keyed by cursor, kept out of the activity log and the event tail; other agents' umbilical `turn.delta` still arrive with `stream_deltas` on), a full `tool_call_result` replaces the truncated `tool.completed` copy, and `chat_updated` reloads that transcript. Reconnect keeps the stream's backoff, idle watchdog and resume; `stream.gap` reloads agents, approvals and open transcripts; a 404 on reconnect opens a new session. Quitting ends the session.

Wire serialization (`sse-wire.ts`, also used by `GET /events`): plain JSON values are preserved exactly. A key whose value is `undefined` (or a function or symbol) is omitted; consumers and the parity normalizer MUST treat a missing key as equal to `undefined`. `undefined` in an array becomes `null`; `NaN` and `±Infinity` become `null`; a BigInt becomes its decimal string; a reference cycle becomes the string `"[Circular]"`; `toJSON` applies (Date → ISO string, Buffer → `{type, data}`); Map, Set, other typed arrays, class instances and Errors become their own enumerable properties. The serializer never throws. For serializable input `GET /events` output is byte-identical to before.

#### D5.2 Revisions and write conflicts (W3-F)

Code: `src/main/runtime/resource-revisions.ts` (revisions), `RuntimeService` write methods, `src/main/backend/edit-conflicts.ts` (Studio main's answer, both backends), `src/renderer/utils/edit-conflict.ts` and `components/editor/ChangedElsewhereNotice.tsx` (editors), `src/main/tui/util/revisions.ts` (terminal app).

| Item | Behaviour |
|---|---|
| Resources | Per agent: `config`, and `file:<path>` for every internal file. The document is the file at its document path (one revision for `GET …/document` and `GET …/files/content?path=README.md`). |
| Revision | An integer from one process-wide counter, `max(previous + 1, Date.now() × 1000)`: monotonic per agent and resource, and above every revision an earlier daemon run issued unless the clock went back. Kept in memory per workspace (the open document and the agent started on it share one, D4). |
| How it moves | Derived from content. Each resource keeps the revision it last issued and the sha1 of the content that revision names. Every observation (a read, a write, a change frame) hashes the current content: the same hash keeps the revision, another takes the next one. A write no client announced (shell redirection, `sys_code`, a lambda, a mesh delivery) moves the revision at the next look. A revision names exactly one content, so a write whose base is current was made over the current content. |
| Writer | `{kind: 'agent'}`, `{kind: 'client', client}` (the client session's name, never its id), or `{kind: 'cli'}` (a request without a live session). A route write runs inside `runAsWriter` (client-routes.ts, beside `runAsClientWrite`); a change detected without one is the agent's. Embedded Studio writes as `{kind: 'client', client: 'studio'}`. A route whose write runs after an await (`PUT …/files/raw`) wraps it in `runAsWriter(requestWriter(request))` itself. |
| Reads | `GET …/config`, `…/document`, `…/mind`, `…/files/content` answer `revision`; `…/batch` (a file switch; not `…/header`, read every turn end) answers `configRevision` and `documentRevision`; `GET …/files/raw` sends `X-ADF-Revision`. |
| Writes | `PUT …/config` (base as `If-Match` or `?baseRevision=`), `…/document`, `…/mind`, `…/files/content` (also `baseRevision` in the body) answer the new `revision`. A base that is not the current revision answers `409 stale_revision` with `resource`, `revision`, `baseRevision`, `writer`, `size` and `hash`, and writes nothing. A write without a base replaces whatever is there, so the CLI, the agent's own tools and older clients are unchanged. `If-Match: *` is no base. `PUT …/files/content` with `mustNotExist` (or `If-None-Match: *`) is a create: refused with `409 stale_revision` when the file exists. |
| Frames | `file_updated` and `document_updated` (executor events, both backends) and `config_changed` (push) carry `revision` and `writer`. A `PUT …/config`, `…/files/content` or `…/mind` of an open document that is not running announces itself (`config_changed` / `file_updated`), as `PUT …/document` already did (D5.1); a running agent raises its own. Origin dedup is unchanged. |
| Studio, both backends | `getBatch`, `getDocument` and `readInternalFile` answer the revisions; `setDocument`, `writeInternalFile` and `setAgentConfig` take an optional `{ baseRevision }` (preload, additive) and answer `{ success: false, error, conflict }` for a stale one, `conflict` carrying the current text or config and the writer. Editor tabs and the config panel save over the revision they last saw. A change from elsewhere over unsaved text, or a refused save, keeps the text and shows the "changed elsewhere" notice naming the writer, with Reload (their version) and Keep mine (save over their revision). A clean tab updates as before. A refusal whose current content is still the content the edit started from (the revision only moved, e.g. after a daemon restart) saves again over the new revision without asking, and logs it. Ctrl+S / File > Save goes through the same save path (`utils/editor-save.ts`) and saves nothing while the notice is up (the notice gets focus). A save's base (revision and text) is taken when it is scheduled; a save of a closed tab goes out over it, and a refusal brings the tab back with the notice. Closing a tab, switching or closing the agent with unsaved text under a notice (tabs and the config panel) asks first. While a notice is up, Studio main keeps a copy at `<userData>/recovered/<agent>/<path>` (`backend/edit-recovery.ts`, `local` channels `RECOVERY_*`); resolving removes it, a quit or crash leaves it, and the next launch lists it (Show folder; Dismiss moves it under `recovered/archive/<time>/`). One-shot config writes (Identity, provider setup) read with `getAgentConfigWithRevision`, save over it and give the store the saved revision; the skills-state merge saves over the revision it read and merges again when refused. |
| Terminal app | Config (`/config edit`) and file edits (`$EDITOR`, external app) save over the revision of the re-check before the write. A `409 stale_revision` asks Overwrite (save over their revision) or Reload theirs (nothing written; the edited copy is kept). Reload theirs on a config edit keeps the edited JSON in a temp file; a create is sent with `mustNotExist`. |
| Parity | Normalizer rule R18 replaces the clock-seeded `revision`, `baseRevision`, `configRevision` and `documentRevision` values with `<rev#n>`, numbered by first appearance, so a save over the wrong revision shows; `writer` is compared as is (`tests/parity/normalize-revisions.test.ts`). The recordings were re-recorded for it. Scenario `w3f-write-conflicts` records the refusals. |

Rationale: revisions derived from content need no hook in every write path (agent tools reach the workspace through many) and survive a restart without storing anything in the `.adf`; the per-content hash makes "base is current" equivalent to "nothing was lost". A revision that only moved costs one extra request, never a prompt.

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

Deliberate embedded deviations (security fixes in code both modes share, accepted by the lead; each changes embedded behaviour on purpose):

| Commit | Change | Rationale |
|---|---|---|
| 67d208a0 | Peer health and shared-file reads go through the egress guard: cloud metadata addresses and the daemon port refused on every redirect hop, 2 MB cap enforced while streaming. LAN, link-local and http stay allowed. | A peer URL comes from a remote directory card, so it is attacker-influenced; an unguarded fetch could reach cloud credentials or the local daemon API. |
| 49e7f043 | MCP stdio servers and auth preflights no longer inherit `ADF_DAEMON_TOKEN` or `ADF_OWNER_PASSPHRASE*`. | An MCP server is third-party code; the daemon token drives every route and the passphrase unlocks the owner identity. |
| 324378a2 | The MCP registration test takes an optional cancel signal (Studio passes none, so its runs are unchanged). | Lets the daemon run the test as a cancellable job instead of holding a request open for minutes. |
| e6ed9b06 | `AdfDatabase` identity prefix matches (`deleteIdentityByPrefix`, `listIdentityPurposes(prefix)`, `peekIdentityPurposes`) compare the exact, case-sensitive prefix instead of `LIKE`. Test: `tests/daemon-file-routes.test.ts` "the /agents/:id detach routes delete credentials by exact prefix too". | With `LIKE`, `_` and `%` in a server or adapter name were wildcards and case was ignored, so detaching one MCP server or adapter deleted another's credentials. |
| W1-E (daemon only) | Delete and rename refuse an agent file named through a symlink or a Windows short (8.3) path with `path_not_canonical`; the sentence names the real path to use. Embedded Studio acts on the link's target. Not a change to embedded code: a daemon-mode difference kept on purpose, listed in the gaps doc's remaining differences. | A link can point a destructive operation at a file the user did not name (another tracked folder, an agent another runtime holds). |
| 03220394 | `IDENTITY_REVEAL` and `IDENTITY_GET` refuse key material (`crypto:*`): `{ value: null, reason }`, and the Identity panel shows the reason. Test: parity scenario agent-keystore. | Embedded sent the agent's private signing key to the renderer on Reveal; nothing in the UI needs it, and the daemon never returns it (§5.4.1). |
| 4570606c | A credential save (`IDENTITY_SET`, `PROVIDER_CREDENTIAL_SET`) to a locked credentials envelope asks Replace or Cancel (`services/locked-credential.ts`, `locked-credential-dialog.ts`, shared with the daemon). Characterization first: cf83a1d6. Test: parity scenario locked-credentials, both backends. | Embedded wrote a new value unsealed without asking, and over a sealed value failed with a dead-end error; the daemon asks (as the terminal app does). One rule in both modes. |
| 9d367acd | `PROVIDER_CREDENTIAL_SET` on a file that is not the open one runs the envelope unlock cascade before writing, as `MCP_CREDENTIAL_SET` and `ADAPTER_CREDENTIAL_SET` do. Characterization first: fbfdcc9d. Test: parity scenario owner-sealed-key, both backends. | Without it the owner's own sealed key read as locked (since 4570606c): Replace was offered and a key this machine opens was discarded. The daemon unlocks first. |
| 65ced379 | An abandoned MCP connect attempt (stale, failed, or cancelled through `McpConnectOptions.signal`) kills its process tree on Windows first, awaited, then closes the client and transport. Test: `tests/unit/services/mcp-client-manager-abort.test.ts` "abort of a server behind a cmd.exe shim (npx/uvx) kills the whole tree". | E3. The pid was read after `client.close()` had dropped the process, so the sweep never ran, and a sweep after close reaches only the dead cmd.exe shim: a server started through npx or uvx outlived the attempt. |
| 690e0046 | Settings → MCP shows a label ("Sign in needed") and an amber dot for MCP status `needs_sign_in`. Test: `tests/unit/utils/mcp-status-dashboard.test.ts`. | E3. The status (W1-B) showed its raw value and a grey dot. |
| 8601abcb | Embedded DOC_SET_DOCUMENT, DOC_WRITE_INTERNAL_FILE and DOC_SET_AGENT_CONFIG refuse a save whose optional base revision is stale (`{ success: false, error, conflict }`); DOC_GET_DOCUMENT, DOC_READ_INTERNAL_FILE (text), DOC_GET_BATCH, the save answers and DOC_AGENT_CONFIG_CHANGED carry revisions; `file_updated` / `document_updated` carry `revision` and `writer` (assemble-agent.ts, agent-executor.ts). Characterization first: 84fb96a6. Tests: parity scenario w3f-write-conflicts, `tests/unit/runtime/write-event-payloads.characterization.test.ts`. A save without a base is unchanged. | E3. A save over a change the agent made since the editor read the file replaced that change, and an agent write over unsaved text replaced the text (D5.2). |
| 4db10a14, 919b9a7c | Editor tabs keep unsaved text under a "changed elsewhere" notice instead of taking an external write over it (4db10a14); closing a tab or switching agent over such text asks first, and a quit leaves a recovery copy (919b9a7c). Characterization: 8009e724, `tests/unit/renderer/edit-discard.characterization.test.ts`. It was written after 4db10a14 (history is not rewritten): it transcribes the store at 84fb96a6, where an external write replaced the unsaved text, and records 4db10a14's silent drop on close and switch, before 919b9a7c. | E3. An agent's or another client's write discarded the user's unsaved edit without a word; then closing or switching dropped the kept text. |
| 1e5ec44b | The egress guard classifies NAT64 (`64:ff9b::/96`) and 6to4 (`2002::/16`) addresses as the IPv4 address they carry. Characterization first: b4722440. Test: `tests/unit/utils/ssrf-follow-ups.test.ts`. | E3 (W1-D follow-up). A NAT64 gateway connects `64:ff9b::a9fe:a9fe` to 169.254.169.254; the guard saw a public IPv6 address. |
| cf03f371 | The always-blocked metadata tier adds 169.254.170.23 and fd00:ec2::23 (EKS Pod Identity), 100.100.100.200 (Alibaba), 168.63.129.16 (Azure WireServer), 192.0.0.192 (OCI). Same test. | E3 (W1-D follow-up). allow_local_fetch reopened them. |
| c09f137d | Host stdio MCP servers are spawned with `windowsHide` in every host process: `mcp-client-manager.ts` loads the SDK's `stdio.js` against a cross-spawn that always sets it. Test: `tests/unit/services/mcp-stdio-windows-hide.test.ts`. Embedded Studio is unchanged (the SDK already hid the window inside Electron main). | The SDK sets `windowsHide` only when it detects Electron main (`'type' in process`). In the daemon and the CLI (Node, no console) every npx/uvx/node MCP server on Windows opened a visible console window for as long as it ran. |
| e6b223f7 | A host name the guard cannot resolve is refused with the resolver's code (sys_fetch, ws_connect, peer fetch, catalogs). Same test. | E3 (W1-D follow-up). It passed the guard, leaving the check to the connection's own lookup. |
| 3f412789 | The daemon-port tier covers every address of this machine (`os.networkInterfaces`, cached 30 s), not only loopback and the unspecified address. Same test. | E3 (W1-D follow-up). With allow_local_fetch, or for a peer, a daemon bound to the network was reachable through the host's LAN address. |
| fd137041 | `guardedFetch` (catalogs, peer reads) connects through node:http(s) with a lookup that checks every answered address against the guard's policy. Same test. | E3 (W1-D follow-up, DNS rebinding). The guard and the connection resolved the host separately. |
| 7c3e7626, c299e801, 2524c76b | When Node's env proxy is on (`NODE_USE_ENV_PROXY=1`, or `--use-env-proxy` in execArgv or `NODE_OPTIONS`) and applies to the URL (HTTP(S)_PROXY and NO_PROXY, read as undici reads them), the guard still looks the host name up and checks its answers. Only a name this machine cannot resolve (ENOTFOUND, EAI_AGAIN) is left to the proxy, unchecked and logged once. Literal addresses and loopback names are always checked. Characterization first: 0e84c654. Test: `tests/unit/utils/egress-pinning.test.ts`. | E3 (W4-B follow-up). Since e6b223f7, a machine whose only way out is the proxy had every host name refused. A name the proxy resolves differently from this machine's answer is not covered. |
| ca0f38d4, a9c45219, c2291403, a8c82177, ecb83e02 | sys_fetch, MCP HTTP transports and the interactive MCP OAuth sign-in (`runMcpHttpOAuthFlow`) send through `egressFetch`/`pinnedFetch` (utils/guarded-fetch.ts). Every hop is checked first, literal addresses included, and redirects come back to the hop loop. A direct hop connects over node:http(s) with `guardedLookup` to an address the guard passed, keeping the name as SNI and Host. A hop behind the env proxy, or over a replaced global fetch, is sent with `redirect: manual`. An abort is honoured between hops. MCP HTTP was unguarded before; it gets the always-blocked tiers (`MCP_HTTP_EGRESS`): cloud metadata and the daemon control API are refused, loopback, LAN and link-local are allowed. Characterization first: 0e84c654. Tests: `egress-pinning.test.ts`, `tests/unit/services/mcp-http-pinning.test.ts`, `mcp-http-pinning-e2e.test.ts`. | E3 (W4-B follow-up, DNS rebinding). The guard and the connection resolved the host separately, so a changed answer reached a refused address. MCP HTTP and its sign-in had no check at all. Behind a proxy, the proxy's own lookup is outside the pin. |
| b9efc894, ee15cef0 | Every outbound ws socket (ws_connect ad hoc, a stored config started by registerAgent or by id, and reconnects) is held to the agent's egress policy, read at connect time (`security.allow_local_fetch`, the daemon control port). A literal address is refused before the socket exists (`checkLiteralConnectTarget`). A host name's answers are checked by the socket's `guardedLookup`. Test: `egress-pinning.test.ts`. | E3 (W4-B follow-up). Only an ad-hoc URL was checked, and the socket resolved the host itself. Visible: a stored connection to a LAN address now needs allow_local_fetch, as an ad-hoc one always did. |
| ab718b81, 29f45e1e, fce59f62 | The guard reads every IPv4 address an IPv6 address carries (`embeddedIPv4s`) and refuses the address when any reading is refused, each reading counted on its own. Covered forms: mapped and compatible; NAT64 64:ff9b::/96; local-use NAT64 64:ff9b:1::/48 as /48, /56, /64 (RFC 6052 positions, u-octet zero, zero suffix) and /96; 6to4; Teredo; ISATAP (0:5efe / 200:5efe interface ids). Characterization first: 0e84c654. Test: `egress-pinning.test.ts`. | E3 (W4-B follow-up). A translator or relay reaches the IPv4 host, but the guard saw a public IPv6 address. The prefix length of a local-use NAT64 prefix is the network's choice, so every possible reading counts. |
| 2be82976, W5-A1 review fix | MCP_ATTACH_SERVER keeps the OAuth flag: the per-agent credential panel sends the registration's (or catalog entry's) `oauth` unless the save includes a bearer or header token (a dual-mode server given a pasted token uses the token, as the TUI writes `oauth: false` for it), and `mcpAttachEntry` (one builder for both modes, E1 88a975bb) writes `oauth: true`, which wins over the bearer variable as for a Settings install. Client id and scopes stay on the registration. Not retroactive: the handler leaves an already-attached server's entry as it is (`alreadyAttached`), so files attached before keep theirs until the server is detached and attached again. Tests: `tests/unit/ipc/mcp-attach-entry.test.ts`, `tests/backend/daemon-mode-mcp.test.ts`. | E3 (W5-A1). The `.adf` entry had no `oauth` (a dual-mode server got `bearer_token_env_var` as its auth), so on another runtime the server connected without OAuth and got a 401. |
| a1784bd7 | On Windows `closeConnection` (disconnect, restart, agent stop) ends a stdio server's stdin, waits 2 s (the SDK's own grace) for it to exit, and otherwise kills its process tree while the shim still links it (logged), as `abandonAttempt` does since 65ced379. A server that exits on EOF still exits gracefully. Characterization first: d34aa0ff. Test: `tests/unit/services/mcp-client-manager-close.test.ts`. | E3 (W5-A1). The SDK's close killed only the `cmd.exe` shim of an npx/uvx server, and the sweep after close reached only the dead shim: a server that ignores stdin EOF was orphaned. |
| d0fca922, W5-A1 review fix (daemon mode, renderer) | Daemon-mode FILE_OPEN of a running agent the daemon holds no password key for (it runs on the stub provider) answers `needsPassword` with `agentWasRunning: true` and does not stop it; other clients watching it see no change. After a successful unlock (the daemon rebuilds the real provider in place) `completeFileOpen` re-attaches it through AGENT_START, as `openFile` does for a running agent (`useAdfFile.ts` `reattachAfterUnlock`, `applyReattach`). Cancel closes the file, as in embedded; the agent keeps running and stays in the background list with the state its executor reports, the closest state the renderer has for running-but-locked (each turn fails with the stub's `credentials_locked` message naming the unlock). Embedded is unchanged: it stops such a background agent before the prompt, because it cannot hand it to the foreground without the key, and never answers both flags. Test: `tests/backend/daemon-mode-agent-handlers.test.ts` (a second client watching the agent). | Lead decision (tracker §6, W3-A). The daemon runs the agent for every client; a prompt in one Studio must not stop it. |
| 9d6939a0, W5-A1 review fix (daemon only) | K12: on a daemon without a usable keychain the owner can trust the daemon's key (`adf identity trust-daemon`, `POST /identity/trust-daemon`, local proof and `confirm: true`, owner key required, refused with a keychain); the daemon then gives the agents it opens a trusted-daemon credentials slot (`OwnerIdentityService.enrollTrustedDaemonSlot`) and embedded Studio wraps every agent to it (Phase C). `adf identity untrust-daemon` revokes. Never automatic: the first version (9d6939a0) enrolled itself whenever it held the owner key, also on a keychain machine whose read failed. Test: `tests/daemon-keychainless-enrollment.test.ts`. | W5-A1, lead decision (§5.3 "Fallback"). Studio-made agents opened only through the owner key, so an agent Studio made later stayed locked to a daemon restarted without its passphrase. |
| e3b93b3c (characterization 6652c31a), 0c15323a, a2e2fbfd, e1daef2c, 150aadc5 (W1-G) | Container ownership, embedded included. A quit (`PodmanService.stopAll`) and Settings → Compute → Stop (`stop()`, `BackgroundAgentManager.stopAll`) leave running every container another live runtime on this machine claims (the shared `adf-mcp` included); before, they stopped every managed `adf-*` container. What a stop left running is in `getStatus().leftRunning` (`{name, holders, reason}`), returned by `COMPUTE_STATUS` and listed in Settings → Compute; it clears on a container start or a stop that finds nothing running. One log line names what was stopped and what was left. Reset/destroy still removes the shared container but logs the runtimes it takes it from (the users per row and the confirmation wording are shown in daemon mode only). On Windows `podman machine` subcommands run from `%TEMP%\adf-podman-machine`, so podman's stray `NUL` file no longer lands in Studio's working directory. Tests: `tests/unit/services/podman-stop-ownership.test.ts` ("runtime A's shutdown leaves runtime B's containers running", "destroy() warns about the runtimes it takes the shared container from", "leftRunning clears on…"), `tests/unit/services/podman-machine-cwd.test.ts`. | W1-G, lead decision (podman safety). A Studio quit stopped the daemon's (or another Studio's) agent containers mid-turn. |
| cbd951fe, 8230df9d (with 76fd17a1, daemon side) | Studio follows an owner switch made outside it (`adf identity import`). `getOwnerSigningKey` returns null when the stored phrase does not derive `ownerDid`; `mirrorToSharedStore` never writes such a phrase over the keychain entry; when its own phrase is of another owner and `legacyOwnerDids` records the switch from it, Studio takes the keychain phrase and keeps its own as the secret `ownerMnemonicSuperseded:<DID>` (never returned by `getAll`), otherwise it keeps its phrase and warns; `restampAndAttest` keeps the operator attestations of a file stamped by another runtime (a file with no runtime stamp still gets this runtime's). Tests: `tests/unit/services/owner-identity-migration.test.ts` "owner switched outside Studio", `tests/daemon-runtime-adoption.test.ts` "owner switch from the CLI, then embedded Studio starts". The tracker's "done 76fd17a1" names the daemon-side commit; the embedded code is cbd951fe and 8230df9d. | E3 (W1-C). Embedded Studio mirrored its old phrase over the new owner's, the only copy, and signed attestations that never verified. |
| 05ada052 (characterization), 663f9d35 (W5-D1) | Before mirroring its phrase into the keychain, Studio re-reads `ownerDid` from the settings file on disk (`SettingsService.readOnDisk`); when another writer (the daemon's owner import) changed it, Studio mirrors nothing and logs that a restart follows the switch. `restampLocalAdfs` takes an optional `skip` (embedded passes none: unchanged). Test: `tests/unit/services/owner-identity-migration.test.ts` "owner switched on disk while Studio runs". | E3 (W5-D1). A Studio that loaded its settings before `adf identity import` wrote the old owner's phrase over the new owner's keychain entry at its next `ensureIdentity`. |
| aed1ebf7, 5a7981ac (W3-A) | Embedded `cleanupAllProcesses` closes the tracked-folder (chokidar) watcher and stops the templates-folder watcher; both were left open at quit. 5a7981ac also removed the parity harness's exemption for it. Tests: `tests/parity/documents/tracked-dir-watcher-shutdown.test.ts`, `tests/parity/documents/templates-watcher-shutdown.test.ts` ("leaves no file watcher open after cleanupAllProcesses"). | E3 (W0-F, W3-A). Open watchers kept handles past quit and raced the next start. |
| 7c564457 (W4-B) | Embedded Open Recent drops every path that starts with `\\` or `//` (UNC, `\\?\`, `\\.\`) before the `existsSync` that hides missing files, so no file-system call reaches a network host; such entries are not shown. Test: `tests/backend/menu-recent-unc.test.ts`. | W4-B security review. On Windows an `existsSync` on a UNC path sends the user's NTLM credentials to that host. |
| 0337eefd, 3339d189, 8ed054ba (W4-A) | Every embedded boot runs the handover (`runBootHandover('embedded')`, before any IPC handler) and the switch resume (`resumeSwitchedAgents`, a no-op without `studio-switch-resume.json`). The handover moves client keys back into `adf-settings.json`; with no `studio-handover.json` marker on an existing install (settings hold a `runtimeDid`) it opens the OS keychain (`handoverNeedsKeychain`), and if Studio's `studio-runtime:<scope>` entry is there it deletes the entry and leaves sign-ins with the daemon (said once). From W5-D1 it also deletes `auth.replaced.json` files older than 30 days. Tests: `tests/backend/handover.test.ts` ("opens the keychain at boot only when something can go through it", "a deleted marker falls back to the runtime entry…", "auth.replaced.json lifetime"), `tests/backend/mode-switch.test.ts` "embedded resume waits for the backend to be ready…". | W4-A, lead decision. Credentials and the runtime entry must come back after a switch to local, including a crash mid-switch; the keychain access at boot (a macOS prompt on a first read) is the visible cost. |
| 3359a13d, 19402e23, 00c8dbdb, 4213182e (W0-C, E2) | Agent leases, visible in embedded. Studio registers as a runtime host and takes a lease per agent at a fresh AGENT_START and a background start (released at stop, agent-off, file switch and a failed start; re-keyed on rename). A start of an agent another runtime on this machine runs is refused with `agent_leased` in the existing start-error UI, naming the holder and what to do ("X is already running in the ADF daemon (pid N). Stop it there with `adf stop X`, or stop that daemon with `adf daemon stop`, then start it here."). A lease dir that cannot be written lets the start proceed and shows "Agent leases unavailable: …" (foreground: AGENT_EVENT error; background: an error event, code `LEASES_UNAVAILABLE`). Tests: `tests/runtime/agent-lease.test.ts` ("background start takes the lease, a failed start releases it, a leased start fails with agent_leased", "names the holder and what to do in the agent_leased sentence", "an unusable lease dir lets the start proceed unprotected, with an error logged"). | E2 (§10). Two runtimes on one file both ran its timers and turns and polled its Telegram bot (HTTP 409). |
| 697e8299 (W5-D1) | `credential.key` (`utils/credential-cipher.ts`, shared by Studio and the daemon) is restricted to the current user on every write, and an existing one once per process at its first read (W5-D1 follow-up): on Windows its own ACL (`icacls /inheritance:r /grant:r`, `utils/secret-file.ts`), elsewhere mode 0600; a failure is logged with the path. Test: `tests/secret-file-acl.test.ts` "credential.key (Studio and the daemon)". | E3 (W5-D1 review). Mode 0600 means nothing on Windows: the key kept the folder's inherited ACL. |
| 4a4bb9d2 (W5-D1) | `auth.replaced.json` (the session the accounts dialog set aside) is deleted 30 days after it was written, at the next handover run (every Studio start), and at once when a ChatGPT or Grok sign-in to its account succeeds (`subscription-token-store` `signedIn`, shared with the daemon); both logged. The accounts dialog says so. Tests: `tests/backend/handover.test.ts` "auth.replaced.json lifetime (W5-D1)". | E3 (W5-D1 review). A signed-out session stayed on disk with no end. |
| 9959cbeb | The boot WAL sweep skips a recent file whose path `unsafeLocalPath` refuses (UNC, `\\?\`, `\\.\`, relative, device names), and logs it. Characterization first: be94d754 (`recentFileSweepDirs`, E1). Test: `tests/unit/utils/boot-wal-sweep.test.ts`. | E3 (W5-D3). A remote daemon's paths reached `recentFiles` (moved into `adf-settings.json` by a switch from remote), and a `readdirSync` on `\\host\share` sends the user's NTLM credentials to that host. Remote mode now keeps its recent files in `remoteRecentFiles` (3bdd8f76), which the handover never moves back. |
| 3cf0ee19 | Embedded `COMPUTE_LIST_CONTAINERS` rows carry `users` (other live runtimes using the container, W1-G), as daemon mode's do; Settings → Compute Stop asks before stopping a container another runtime uses (both modes; Remove and Rebuild already asked and now name them). Characterization first: 08b0fa74. Tests: `tests/unit/services/podman-stop-ownership.test.ts`, `tests/unit/renderer/container-stop-confirmation.test.ts`. | E3 (W5-D3). Embedded Studio stopped or removed a container a daemon on this machine used without a word. |
| 56acbc7f | E2 lease hook: a start that knows the agent id (Studio's `AGENT_START`; `BackgroundAgentManager` and `RuntimeService.loadAgent` once they read the config, `noteAgentId`) is refused with `agent_leased` when a live lease of the same id is held at another path, in another process or this one. Test: `tests/runtime/agent-lease.test.ts` "a copy of a running agent …". | W5-D3. Leases were keyed by path: a copied or restored `.adf` in a tracked folder autostarted next to the original and polled its Telegram bot twice. |
| 641eb630 | After a switch, a resumed start refused with `agent_leased` is retried every 5 s for up to 60 s (`resumeSwitchedAgents`, both directions). Test: `tests/backend/mode-switch.test.ts`. | W5-D3. A daemon that took longer than the 22 s quit wait still held the leases, and the resume never tried again. |
| c9d4fb49 (W5-D2) | A file write through the daemon API from Studio's client session runs as `system:studio`, as embedded Studio's own writes (`runAsApiWrite`, `apiWriteSource` in runtime/resource-revisions.ts; the terminal app and CLI stay `system:runtime-api`). In assemble-agent.ts such a write still raises `file_updated` (other clients follow it; the daemon skips the writing session), where embedded Studio's own write raises none. Embedded is unchanged: `inApiWrite()` is never true there. Characterization: 84fb96a6, `tests/unit/runtime/write-event-payloads.characterization.test.ts`, extended. Parity: `w5d2-studio-write-source`. | E3. A file-change lambda or tap acting only on Studio's edits never ran in daemon mode. |
| 16e635dc (W5-D2, E1) | Embedded's agent file-name rule (ipc/index.ts) moves unchanged to `shared/utils/agent-file-name.ts`; the daemon's create, rename, import and name sync use it (eb954c13), plus a refusal of Windows device names on every OS. Characterization first: `tests/unit/utils/agent-file-name.characterization.test.ts`. | E1. The daemon had three copies with other limits (64, 255 characters) and one without the backslash. |
| 11fa794b (W5-E) | `agentLeasedMessage` and `agentIdLeasedMessage` (`runtime/agent-lease.ts`) name the agent from the lease path split on either separator. Test: `tests/runtime/agent-lease.test.ts` "names the holder and what to do in the agent_leased sentence". | E3 (W5-E, first CI run on Linux and macOS). A Windows path in a lease folder shared with a macOS or Linux machine printed the whole path as the agent's name. |
| b0fe3596, 69a8ca37, be8a3800 (W5-E) | `lockTakeover` probes a takeover lock's live holder again only every 250 ms (be8a3800; b0fe3596 kept the first judgement for the whole 2 s wait), not on every 5-20 ms retry. Test also: "a takeover lock whose live holder dies during the wait is taken in that same wait". Test: `tests/runtime/agent-lease.test.ts` "a taker whose event loop is blocked (not awaiting) keeps its takeover lock: one holder" (failed on macOS CI before). | E3 (W5-E). A holder with a blocked event loop accepts no probe; the probes filled its socket's accept queue, macOS then refused connections (ECONNREFUSED, read as dead) and the holder's lock was broken under it. |
| 29738721 (W5-E) | Recovery copies (`backend/edit-recovery.ts`) refuse a path with a `..` segment split on either separator, on every platform; `agentFolder(path, platform)` uses that platform's path functions. Test: `tests/backend/edit-recovery.test.ts` "never writes outside the agent's folder". | E3 (W5-E). On macOS and Linux `..\escape.md` was kept as a file name inside the agent's folder; the same copy opened on Windows climbs out. |
| ca68b68f, 31aff35f, c2e8e810, 0912fecc (W5-G) | The machine id lookup (`runtime/agent-lease.ts`) tries again with a 10 s timeout after a failed first attempt (3 s) and remembers a failure for 15 s instead of for the process. A registry's first write still waits at most 3 s; when the id is not read by then, the lookup goes on (and is retried every 15 s), and once it answers the host record and every held lease are rewritten with it (logged), each lease under its takeover lock and only while it still names this runtime, and an acquire under way then gets it too (0912fecc). A platform with no machine id is cached for the process and said once; anything that needs the id (liveness checks included) waits for it at most 3 s (c2e8e810). Test: `tests/runtime/agent-lease-machine-id.test.ts`. | E3 (W5-G, CI run 38749217035). On a loaded Windows machine reg.exe took 2-4 s, past the 3 s timeout; the null was cached, so every record of the process carried `machineId: null`. Such a record is judged by the reader's own pids: a runtime on another machine sharing the lease folder could take a live agent. |
| e1ff555c, 0591c03a (W5-G) | The boot envelope sweep's 2 s timer is kept in a module variable; `cancelDeferredEnvelopeSweep()` and `runDeferredEnvelopeSweepNow()` (ipc/index.ts) are the parity harness's switch. Studio is unchanged (the timer runs the sweep as before). Test: `tests/parity/boot-sweep/harness-switch.test.ts`. | E3 (W5-G, a parity-harness artifact, CI run 38749217035). On its timer the sweep ran inside any scenario that outlasted 2 s on a loaded runner, so an embedded recording depended on its run time. |
| 1ddf5341 (W5-G; the same commit adds the daemon's sweep and the parity scenario) | Embedded's boot envelope sweep becomes `OwnerIdentityService.sweepEnvelopeMigration`, shared with the daemon: async folder walk, a yield after every file, and files another live runtime holds the lease of are not opened (`leaseHolderElsewhere`, moved to `runtime/agent-lease.ts`). Tests: `tests/unit/services/envelope-migration.test.ts`, parity scenario `w5g-boot-envelope-sweep` (both backends). | E3 (W5-G). The synchronous sweep blocked Studio's main process for the whole tracked tree and opened files a daemon runs. One sweep in both modes keeps them indistinguishable. |
| 15172196, 99686322 (W5-G review) | `ensureWorkspaceIdentity` mints envelopes and signing keys in one BEGIN IMMEDIATE transaction that re-checks for them (`AdfDatabase`/`AdfWorkspace.immediateTransaction`), for every caller. A read-only pre-check runs first: an already provisioned file takes no write lock (99686322). A mint waits at most 100 ms for another connection's write lock (the sweep 25 ms, and it skips a busy file as a named failure); the open path logs the failure and the next open retries. Tests also: "an already provisioned file opens while another connection writes it", "the sweep against a file another connection is writing fails fast". Test: `envelope-migration.test.ts` "a second connection provisioning the same file meanwhile cannot interleave". | E3 (W5-G review). Two runtimes provisioning one file at once (the sweep in one, a lazy open in the other) both minted envelopes and keys; the last writer won and the other's cached DEK sealed rows no one can open. |
| b3035c49, f858638f (W5-G merge review) | Embedded FILE_REVIEW_ACCEPT answers `{ success: false, code: 'agent_file_busy', error }` and create fails with the same sentence ("agent-1.adf is busy (another program is writing it); try again."; the new file is kept) when the identity mint, or the open's own writes, find the file busy (`AgentFileBusyError`, `agentFileBusy`). The daemon answers 409 with that sentence. Tests: `tests/parity/boot-sweep/embedded-busy.test.ts`, `tests/daemon-agent-file-busy.test.ts`. | E3 (W5-G merge review). Since 99686322 a busy mint fails after 100 ms: the accept showed a raw SQLite error, and the embedded create swallowed it and made the agent without its identity, silently. |
| 9f637ea1 (W5-G review) | The boot sweep also skips the file open in this process and the agents it runs (`openHereOrLeasedElsewhere`, one rule for both modes), logs "Envelope sweep skipped: the owner identity is not ready" instead of returning quietly, and names each failed file in its log line. Tests: `envelope-migration.test.ts` "the sweep skip rule", "does nothing without an owner identity", "the log line names each failed file". | E3 (W5-G review). It opened a second connection to files Studio had open (provisioned when opened), and a sweep that did nothing for want of an owner said nothing. |
| f8e86bb4 (W5-G review; since 2662832b) | `ADF_MACHINE_ID` is honoured only where `testSeamsAllowed()` holds (ADF_TEST_SEAMS=1, unpackaged); `tests/isolate-user-data.setup.ts` and the parity environment set ADF_TEST_SEAMS=1. Test: `tests/runtime/agent-lease-machine-id.test.ts` "ADF_MACHINE_ID is a test seam". | E3 (W5-G review, pre-existing since 2662832b). Any process honoured it, so an environment variable could give a packaged Studio or daemon another machine's id, and its records would never be judged stale. |
| 773f43a3 (W5-H; characterization first: 3eeb3e51) | `AdfDatabase.open` reads the schema version first and refuses 1 ≤ v < 3 (`ADF_OLDEST_MIGRATABLE_SCHEMA_VERSION`) with `AdfSchemaTooOldError`, code `schema_too_old`: "agent-1.adf uses schema v2, which this version cannot upgrade (it upgrades v3 and later). The file was not changed." Nothing is written (no marker delete, no `.bak`, no always-run step), and sidecars the read created are reaped. A file with no version (0, a clone with `adf_meta` deselected) and v3+ open as before. Tests: `tests/unit/adf-database-old-schema.test.ts`; parity scenario `w5g-boot-envelope-sweep` (the open answers the same sentence in both backends). | E3 (W5-H, found by W5-G naming the files in the sweep log). The ladder starts at v3, so a v2 file ran only the always-run steps (dropped `adf_archive`, replaced a legacy trigger config), lost its `.bak`, and then failed in the constructor ("table adf_meta has no column named protection"), at every boot. Main showed that SQLite error. |
| 7771ce09 (W5-H) | A failed open (a migration step, or the constructor's pragmas and statements) closes the connection, gives back the open count, reaps the sidecars it created and, when a complete pre-migration backup was taken and no other connection holds the file (exclusive-lock probe), puts the file back from the `.bak` (copy, then rename). The `.bak` is kept; it is removed only after a fully successful open. Test: `adf-database-old-schema.test.ts` "AdfDatabase.open that fails". | E3 (W5-H). The migration path's `new AdfDatabase` ran outside the try: a constructor failure left the connection open (-wal/-shm behind), leaked the open count, and the `.bak` was already gone; a failed migration step left the file half-migrated. |
| 9028aaf9 (W5-H) | The boot envelope sweep (`sweepEnvelopeMigration`, both modes) reads the schema version and agent id read-only first (`AdfDatabase.peekSweepStatus`) and does not open a file below the latest schema version or one that is not reviewed; they are counted in `needUpgradeOrReview`, and the log line says "N skipped: need upgrade or review" once. A migration runs only when the user opens the file. Tests: `envelope-migration.test.ts` "sweepEnvelopeMigration never migrates (W5-H)"; parity scenario `w5g-boot-envelope-sweep` (a v31 and a v2 file, reviewed, left byte-identical in every backend). | E3 (W5-H). The sweep opened every tracked file, so every boot migrated files a user had not opened and ran the always-run steps on files too old to upgrade. User-visible: an unreviewed file is no longer opened by the sweep (it was opened and closed unprovisioned before). |
| f19f3f2e (W5-H review) | `open()` fails closed: the authoritative schema read, moved before the clean-close marker delete, refuses again what the pre-check refuses, and a failed read there fails the open; a busy pre-check fails as locked. An unversioned file (0, or unparsable) is refused unless it has a clone's layout (`adf_audit`, `adf_loop.loop`, no `adf_archive`). With a -wal beside the file the pre-check reads read-only, so a refused file's WAL is not folded into it. The sentence adds "no released version upgrades older files" and points to Troubleshooting. Tests: `adf-database-old-schema.test.ts` "AdfDatabase.open fails closed". | E3 (W5-H review). A pre-check that threw, a repaired file, or an unversioned legacy file still reached the migration; a refused file's hot WAL was checkpointed by the close. |
| e19e9fb1 (W5-H review; supersedes the migration-step restore of 7771ce09) | The whole migration runs in one `BEGIN IMMEDIATE` transaction (the ladder's transactions nest as savepoints; nothing inside writes a pragma, vacuums or checkpoints); a failure rolls back. File restore only after a committed migration (the constructor), only with no connection in this process, no -wal, and an exclusive lock (busy_timeout 0); POSIX renames under the lock, Windows' rename refuses while another program holds the file; fsync before the rename. Otherwise the `.bak` is kept and the error says why. An existing `.bak` with the same size and SHA-256 is reused. Tests: "AdfDatabase.open migrates in one transaction". | E3 (W5-H review). Non-transactional steps left a half-migrated file; the restore could rename over a file another process had just opened; each failed retry left another `.bak.<time>`. |
| ef05d6cb (W5-H review) | Clone-fixup writes `adf_schema_version` (latest) when `adf_meta` was deselected. Test: `tests/unit/adf/clone-fixup.test.ts` "restamps the schema version". Clones made before keep version 0 and still migrate on each open. | E3 (W5-H review). Such clones got a backup and the whole migration on every open. |
| fa36f649 (W5-I E3; characterization first: 82af4a8d), 6725a32e (W5-I follow-up; characterization first: 077a6fc3) | `IpcHostHooks.skipBootAutostart`: when the host passes a reason, `registerAllIpcHandlers` skips the boot autostart of tracked folders and logs `[autostart] Boot autostart skipped: <reason>`; the tracked-folder watcher does not autostart a new `.adf` either and logs `[autostart] Watcher autostart skipped for <file>: <reason>`. main/index.ts passes it only for a first launch on the Local daemon default that found an older ADF daemon on these settings and runs Embedded for that session (§4.4); every other boot is unchanged. Tests: `tests/parity/boot-sweep/embedded-boot-autostart.test.ts`, `embedded-watcher-autostart.test.ts`. | E3 (W5-I review, accepted by the lead). A 0.7.x daemon takes no agent lease, so an embedded session next to it would start the same agents twice. |
| 0c5edd3a (W5-H review) | The sweep's read-only peek uses `SWEEP_BUSY_TIMEOUT_MS` (25 ms); a locked file is a named "busy" failure. Test: `envelope-migration.test.ts` "sweepEnvelopeMigration read-only peek". | E3 (W5-H review). The peek waited the default 5 s per locked file. |

## 4. Settings model

### 4.1 Key classes

| Class | Keys | Lives in (daemon mode) |
|---|---|---|
| **Client** (Studio presentation and Studio-host behaviour) | `theme`, `uiFont`, `uiFontCustom`, `uiScale`, `agentAvatars`, `fleetMapState`, `fleetGroups`, `fleetStewards`, `onboardingSharedAt`, `templatesMigrationSeen`, `nativeNotificationsEnabled`, `menuBarEnabled`, `recentFiles`, `remoteRecentFiles` (remote mode's Open Recent; stays in the client file on a switch to embedded), `updateChecksEnabled`, `spellcheckDownloadsEnabled` | `studio-client-settings.json` (Studio userData) |
| **Backend** (read by runtime, providers, MCP, adapters, mesh, review, compute, tracked dirs) | every other key, including `trackedDirectories`, `agentsFolder`, `compute`, `remoteCatalogsEnabled`, `providerChecksEnabled`, `skillCatalogSources` (the terminal app reads it) | The daemon's settings file, through `GET/PATCH /settings` and the dedicated routes |
| **Backend selection** | `mode` (default `local`, §4.4), `keepDaemonRunning` (default `false`), `remote.url`, `remote.token` | `studio-backend.json` (Studio userData), token as `safe:` |

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

### 4.4 Default backend (Q6, W5-I)

No `studio-backend.json` and no `ADF_STUDIO_BACKEND` resolve to `local` (`DEFAULT_BACKEND_MODE`, `backend-config.ts`), for new installs and for 0.7.x installs upgrading. An explicit `"mode": "embedded"` is honoured. A file that exists but cannot be used is never a silent fallback (Bad file below).

| Step | Behaviour (`src/main/backend/first-launch.ts`) |
|---|---|
| Handover | The boot handover to `local` runs as after a switch (§11.1): client keys, ChatGPT and Grok sessions, app MCP sign-ins, owner phrase mirror and runtime entry. On a keychain never used the entries are created; without a keychain the daemon can read, the K12 fallback applies (§5.3) and the notice says so. |
| Bad file (`guardBoot`, before the handover) | `fileProblem` (unreadable, corrupt and quarantined, not an object, unknown mode): a dialog on the boot window (`utils/windowless-dialog.ts`) names the path and the problem and offers Use Local Daemon (Recommended) / Use Embedded; the answer is saved, then the handover runs for it. `writeBlocked` (cannot be read or replaced, e.g. EACCES): the dialog adds the fix, the answer applies to this launch only (source `session`, `sessionReason`; session-only handover, no credential moves), and the next launch asks again. |
| Older daemon (`guardBoot`) | First launch on the default only: `DaemonProcessController.detect()` on Studio's settings. `unidentified` (no `/version`, another token) or `running` with a lower client API: no handover, the default is not saved, the launch runs Embedded (source `session`) with `IpcHostHooks.skipBootAutostart` (that daemon runs those agents and takes no lease), and a dialog over the main window: "An older ADF daemon (adf X.Y, started by the npm CLI) is running and uses the same settings." with "Stop it with `adf daemon stop`, update the CLI (…), then restart Studio." A current daemon is attached as usual. |
| Persist | After the handover, before the daemon starts, `persistDefaultBackend` writes the resolved config to `studio-backend.json`. Not on an override launch (`env`, `session`) and not over a file that could not be read. A failed write is logged; the next launch resolves the default again. |
| Notice | An install with an `adf-settings.json` (it ran Embedded): the notice is kept in `studio-default-switch.pending.json` and shown over the main window once it is ready and the daemon connection settled (`DaemonModeHandle.ready`): "Studio now runs agents in the ADF daemon.", "Moved: …", what stays in Studio, what is not done, the macOS keychain question, "Settings → Backend has the details.", buttons OK / Open the Guide; when the connection failed, "… but could not connect to it." and that no agent runs yet. Once shown, `studio-default-switch.json` records it (one-time; Settings → Backend's "Default changed") and the pending file is removed; a launch that quit before shows it again, with its own handover merged in (moved adds up, "not done" is the current state) in place of its summary. While Studio quits or restarts (app `before-quit`, e.g. "Use Embedded Mode for This Session") the notice is not shown and stays pending. A fresh install moves nothing and shows no dialog. |
| Accounts conflict | The §11.1 accounts dialog, at boot, on the visible boot window (7f6b702a); its answer applies in the same handover. |
| Running agents | 0.7.x writes no `studio-switch-resume.json`, so nothing is resumed. The daemon autostarts agents from the same `trackedDirectories` in the same settings file, as embedded Studio did. |
| Fallback | Settings → Backend → "Embedded (legacy, removed in the next release)" is the persistent switch with the reverse handover. `ADF_STUDIO_BACKEND=embedded` is a session-only override that moves no credential back and is not the fallback. |

Tests: `tests/backend/backend-config.test.ts` (resolution: no file, explicit file, env; `persistDefaultBackend`), `tests/backend/first-launch.test.ts` (fresh install, 0.7.x upgrade with credentials on an empty keychain, the notice after the connection or its failure, a quit before the notice, K12, running agents, explicit embedded, bad file, EACCES, older daemon), `tests/backend/main-boot-default.test.ts`, `main-boot-fresh.test.ts` and `main-boot-old-daemon.test.ts` (the real boot).

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

#### 5.3.1 Keychain entry `studio-runtime:<scope>` (version 1)

Code: `src/main/daemon/studio-runtime-entry.ts` (type `StudioRuntimeEntryV1`, writer `serializeStudioRuntimeEntry`, reader `verifyStudioRuntimeEntry`). Studio main MUST write the entry with `serializeStudioRuntimeEntry` and nothing else.

| Item | Value |
|---|---|
| Service | `ADF` (`KEYCHAIN_SERVICE`) |
| Account | `studio-runtime:` + `studioRuntimeScope(settingsPath)`: the first 12 hex characters of `sha256(canonicalSettingsPath(settingsPath))`. The canonical path is the native realpath (as the agent lease canonicalizes, W0-C), long-path prefix stripped, case-folded on Windows and macOS, so every spelling of one file gives one account. Studio MUST use `studioRuntimeScope`. An entry found only under the old `settingsScope` account is reported as `scope_mismatch`, naming the canonical path. |
| Value | JSON object, fields below |

| Field | Type | Content |
|---|---|---|
| `v` | number | `1`. A reader MUST reject any other value (`unsupported_version`). |
| `runtimeDid` | string | Studio's `runtimeDid` |
| `runtimeDelegation` | object | Studio's `runtimeDelegation` (`AlfAttestation`, role `runtime`) |
| `runtimePrivateKey` | string | Studio's `runtimePrivateKey` secret: base64 PKCS8 DER, Ed25519 |
| `runtimeEncPrivateKey` | string | Studio's `runtimeEncPrivateKey` secret: base64 PKCS8 DER, X25519 |
| `runtimeEncPublicKey` | string | Studio's `runtimeEncPublicKey`: base64, raw 32 bytes |
| `writtenAt` | string | ISO 8601; diagnostics only |

The daemon adopts the entry only when every check passes; the first failing check is the `reason` in `GET /identity` → `runtime`:

| Check | `reason` on failure |
|---|---|
| Valid JSON object with every field typed as above | `malformed` |
| `v` is 1 | `unsupported_version` |
| The settings file has an `ownerDid` | `no_owner` |
| `runtimeDelegation.role` is `runtime` | `bad_delegation` |
| `runtimeDelegation.issuer` equals `ownerDid` in the settings file | `owner_mismatch` |
| `runtimePrivateKey` is an Ed25519 PKCS8 key | `bad_signing_key` |
| The DID of that key equals `runtimeDid` and the delegation subject | `subject_mismatch` |
| The delegation signature verifies and has not expired | `bad_delegation` |
| `runtimeDid` equals `runtimeDid` in the settings file | `runtime_did_mismatch` |
| The public key of `runtimeEncPrivateKey` equals `runtimeEncPublicKey` in the entry and in the settings file | `enc_key_mismatch` |
| (no entry under the canonical account, one under the uncanonicalized one) | `scope_mismatch` |

Only the attestation fields of `runtimeDelegation` (`issuer`, `subject`, `role`, `issued_at`, `expires_at`, `scope`, `signature`) are read; the copy that is verified is the one the daemon uses.

The entry is re-read at boot, on every identity refresh (`GET /identity`, an owner change, the 60 s re-check while an agent is degraded). Studio MUST rewrite it whenever one of the copied values changes, including after an owner import, which re-signs `runtimeDelegation`; until then the daemon reports `rejected` / `owner_mismatch` and runs as its own runtime. One writer besides Studio (W5-D1): an owner switch made in the daemon while it has adopted the entry (`POST /identity/import`, `adf identity import`) rewrites the entry itself with `serializeStudioRuntimeEntry`, keeping every key and replacing only `runtimeDelegation` with the one the new owner signed, before the daemon refreshes; adoption keeps verifying, so Studio-made agents unlock, and their MCP servers and adapters start, with no Studio running. Studio's own `runtimeDelegation` in the settings file is not written; Studio re-signs it at its next start (`ensureRuntimeKey`). Test: `tests/daemon-runtime-adoption.test.ts` "the daemon re-signs the adopted runtime and rewrites its entry…". Studio MUST delete it when it rotates its runtime key, and MUST delete it when it switches back to embedded mode (W4-A), so no copy of its runtime keys outlives local mode.

Owner switch from the daemon (`POST /identity/import` with `switchOwner`, `adf identity import`): the daemon keeps the adopted runtime for the restamp, so Studio-stamped files get operator attestations from Studio's runtime key, and rewrites the entry with the re-signed delegation (above); a restamp by any runtime keeps the existing operator attestations of a file stamped by another runtime. It overwrites the daemon's copy of the phrase (the keychain entry, or the passphrase file when the daemon uses file storage; a keychain copy is then left as it is) and moves Studio's stored copy of the previous phrase, still encrypted, from `ownerMnemonic` to `ownerMnemonicSuperseded:<previous owner DID>` (never overwriting an existing one). Embedded Studio at its next start finds no phrase of its own, imports the keychain phrase for the owner on record, and `ensureRuntimeKey` re-signs its runtime delegation under the new owner (the step Studio's own Import identity also runs). Rule E3 hardens the same path for a Studio copy that is still present: Studio takes the keychain phrase when its own copy does not derive `ownerDid` AND `legacyOwnerDids` records the switch from its copy's owner (a merely wrong `ownerDid`, from a hand edit or copied settings, never costs Studio its phrase), keeps its copy as `ownerMnemonicSuperseded:<DID>`, never mirrors such a copy over the keychain entry, and never signs owner attestations with it. `ownerMnemonicSuperseded:*` keys are secret: never returned by `getAll` or the daemon's `/settings`, never writable over HTTP. Adoption recovers when Studio next writes the entry. The switch is refused while the previous owner's backup is unconfirmed, unless the caller states it holds that phrase (`previousOwnerBackupConfirmed`, `--i-have-a-backup`), because the switch deletes it from the machine.

`GET /identity` → `runtime` = `{state: 'adopted' | 'absent' | 'rejected' | 'unavailable', source: 'studio' | 'daemon', reason, daemonRuntimeDid, daemonEncPublicKey, message}`. The switch dialog SHOULD show `message` when `state` is not `adopted`.

Testing: `tests/helpers/studio-runtime-entry.ts` (`writeStudioRuntimeEntry`, `fakeKeychain`). A spawned test daemon reads a plaintext keychain file named by `ADF_TEST_KEYCHAIN_FILE` when `src/main/utils/test-seams.ts` allows it: `ADF_TEST_SEAMS=1`, the code does not run from `app.asar` or `node_modules`, and the process is not a packaged Electron (to be unified with W1-G's `isPackagedRuntime` at merge); otherwise that variable makes it use the passphrase file, never the OS keychain. `ADF_KEYCHAIN=0` disables every keychain, including the test file.

Security: on Windows (Credential Manager) and Linux (Secret Service) any process of the OS user reads every `ADF` entry; there the entry exposes nothing such a process could not already read, PROVIDED the owner phrase is also in the keychain (`ADF / owner-mnemonic`, which Studio mirrors when a keychain exists): the phrase is strictly stronger (it signs delegations and opens every owner slot). Without the phrase in the keychain, the entry is new exposure: Studio's runtime signing and encryption keys, which otherwise sit only in Studio's safeStorage, become readable to that user's processes. On macOS keychain items carry per-application ACLs: the entry is created by Studio, and the daemon reading it prompts once; the real weakening is that the daemon runs as a generic Electron-as-Node or `node` binary, so "Always Allow" grants that binary, and with it any script it runs, access to the item. The switch dialog SHOULD say so on macOS. The delegation check stops a corrupted, stale or planted entry from changing the signing identity; it is no barrier to someone who holds the phrase. No route accepts or returns key material, and `POST /identity/import` requires the local proof file in every mode. Stored credential values (not key material) do leave the daemon, to local callers with that proof only; the rationale and the macOS consequence are in §5.4.1.

The daemon token is equivalent to the owner phrase. A token holder can run code as the daemon's OS user: it can attach a stdio MCP server or an adapter whose command it chooses and start the agent, and that process reads the owner phrase from the keychain entry `ADF / owner-mnemonic` (or from the daemon's memory once the passphrase file is unlocked) and every `ADF` entry. The local proof keeps a token holder off the routes that return secrets directly; it does not stop that path. Whoever holds the token MUST be treated as holding the 12 words: the token file is restricted to the current user (mode 0600; on Windows its own ACL, §5.4.1), a remote client is a machine the owner trusts with the phrase, and a leaked token is answered by rotating it (delete `daemon-token`, restart the daemon) and, if the daemon had the phrase, by moving the agents to a new owner.

Fallback: without a usable keychain (Linux without Secret Service), adoption is not possible. The daemon keeps its own runtime; Studio enrolls the daemon's enc key into `trustedDaemonEncKeys` on switch (Phase C) so credentials unlock. Review then shows `recognized` for files stamped by the other runtime. This difference MUST be stated in the switch dialog.

As built (W5-A1 and its review): trusting the daemon's key is an explicit owner action, never automatic.

- `adf identity trust-daemon` (`POST /identity/trust-daemon`, local callers with the local proof, body `confirm: true`) adds the daemon's key (`runtime-enc-key`) to `trustedDaemonEncKeys`; the agents the daemon has loaded get their trusted-daemon credentials slot at once, the others when the daemon opens them or embedded Studio unlocks them (Phase C). Credentials then unlock in the daemon without the owner passphrase. The CLI says what that means and asks for "trust" first.
- It is refused when the daemon reads the OS keychain (`keychain_available`: there the daemon shares Studio's runtime identity, and a trusted key file would let a plain file unlock what the keychain protects; a keychain read that fails leaves adoption `unavailable` but still refuses), and without the owner key (`not_ready`: unlock or restore the owner identity first).
- `adf identity untrust-daemon` (`POST /identity/untrust-daemon`) removes the key from the list and rotates it: a new key replaces `runtime-enc-key`, the old one is no longer used, and its label goes into `runtime-enc-key.revoked`. The slot comes off the loaded agents at once, off the agents in the tracked folders in a background sweep (it skips files another runtime holds the lease on and documents this daemon holds open; they are cleaned when next opened), and off any other agent when the daemon opens it (it removes every revoked label it finds) or when Studio unlocks it (unlisted `daemon:*` slots). The daemon never adds a key back by itself. Slots of the daemon's own runtime that were wrapped to the old key (files it created, owner-key re-wraps) open again only after the next owner-key unlock, which re-wraps them to the new key.
- Remaining window: a copy of an `.adf` outside the tracked folders (a backup, a file sent elsewhere) keeps the old slot until it is opened by this daemon or Studio. Rotation makes that slot useless to the daemon, which no longer has the old key, but anyone who holds a copy of the old key file can still open the credentials of such a copy.
- Trust model: the grant is an entry in the settings file, not a signed statement. Any process that can write the settings file can add a key, and anyone who can read the key file can unlock the credentials wrapped to it. `docs/design/mcp-credential-identity.md` D-G states the same.
- The state is shown by `GET /identity` and `GET /version` (`trust`), `adf identity status`, `adf daemon status` and the ADF daemon line in Settings → Backend (read when Studio connects).
- A keychain that exists but does not answer is not "no keychain" (W5-D1). On Windows and macOS the daemon probes it three times over 5 s at boot (waits of 1 s and 4 s, each logged) before it falls back to the passphrase file, and then reports why: `keychainProblem` in `GET /identity` and `GET /version`, `adf daemon status` (`keychain  unavailable: …`) and the ADF daemon line in Settings → Backend. While it runs on that fallback, create, restore, import and trust-daemon answer 409 `keychain_unavailable` (the secrets would land in the file instead of the keychain Studio shares); `ADF_SECRET_STORE=file` chooses the file on purpose and lifts the refusal. `refresh()` probes again at most every 30 s and says when the keychain answers; the daemon keeps the file it booted with until it restarts. Linux without a Secret Service stays "no keychain" (one probe, nothing refused). Test: `tests/daemon-keychain-probe.test.ts`.

Limitation (documented, not built): when the owner phrase exists only in Studio (no keychain to share it, never restored into the daemon), the daemon cannot open Studio-made agents' credentials and `trust-daemon` is refused for lack of the owner key. The owner restores the phrase into the daemon (`adf identity restore`) or switches back to embedded. The switch dialog says so. Switching back to embedded leaves a trusted key in place.

Rationale against keeping separate runtimes everywhere: unlock would mostly work through the owner key, but every own agent created in one mode would show as `recognized` in the other, new agents would carry a mode-dependent runtime DID, and mesh peers would see the runtime change with the mode. That fails R2 for a reason the user can see in the review panel.

### 5.4 Owner identity in daemon mode

| Studio action | `local` mode | `remote` mode |
|---|---|---|
| Status | `GET /identity` mapped to the Studio status shape | Same |
| Create / restore / unlock / lock / confirm backup | Existing local-only routes (`local-access.ts`); Studio main is a loopback caller | Refused by the daemon. Studio shows the daemon's message (run `adf identity …` on the server) |
| Back up seed phrase (reveal) | Studio main reads the shared keychain entry (`SharedMnemonicStore`) as a local operation. The daemon never returns the phrase | Not available; Studio says so |
| Import identity (switch owner) | New local-only route `POST /identity/import` performing `importMnemonic` + restamp, unloading and reloading loaded agents around the restamp. The CLI gains `adf identity import` | Refused, as above |
| Envelope / password / keystore actions per agent | Existing `/agents/:id/identity*` routes plus the password routes; the derived key lives in daemon memory | Same |
| Reveal a stored value (Identity panel, provider key field, `IDENTITY_GET`) | The local-only reveal routes with the local proof (§5.4.1); key material never | Not available; Studio says so (`remote-unsupported`) |
| Unlock a legacy whole-file password | The unlock route converts the owner's own file as Studio does (`envelope-actions.ts` `convertOwnLegacyPassword`) and answers `converted` | Same |

The derived key of a password-protected agent MUST reach every consumer in the daemon (provider, MCP, adapters, `AdfCallHandler`); today `unlockAgentIdentityPassword` rebuilds only the provider (`runtime-service.ts:1812`).

#### 5.4.1 Stored values for Studio: the one exception to "values never leave the daemon"

The daemon's credential and identity reads answer metadata only. Embedded Studio, though, shows stored values in its own window: Reveal in the agent's Identity panel, the key field of an agent's provider override, the MCP environment form (`IDENTITY_GET`). In daemon mode that window belongs to a separate process, so the values have to cross a process boundary. Two routes carry them, and nothing else does:

| Route | Reads |
|---|---|
| `POST /agents/:id/identity/reveal` | Values of a running agent or open document, with its unlocked key |
| `POST /files/agent/identity/reveal?path=` | The same for any path; a file nobody has open is read through one readonly connection (plain values only, nothing written, no envelope unlocked) |
| `GET /agents/:id/export`, `GET /files/snapshot?mode=export` (W5-D1) | The whole `.adf`, identity included. Its plain secrets (a legacy agent's plain `crypto:signing:private_key`, plain credential values) are left out unless the caller passes `includeSecrets=true`; the public key, envelope descriptors, KDF rows and sealed rows stay. Studio never calls them (its Share and Save a copy… use `mode=share`, identity-free, token only). Test: `tests/daemon-file-routes.test.ts` "a full export needs the local proof and leaves plain secrets out unless includeSecrets" |

Rules:

- Both answer only a local caller (loopback peer, no proxy header) that ALSO presents this run's local proof (`X-ADF-Local-Proof`) in every mode, as `POST /identity/import` does. The bearer token alone is not enough: a token forwarded to the loopback port (`ssh -L`, socat, a container port map) passes the loopback check but has no proof.
- Key material (`crypto:*`: the agent's signing key, envelope descriptors, KDF rows) is never returned. Studio refuses to reveal it in both modes (Rule E3 row below), with a reason the panel shows.
- Answers carry `Cache-Control: no-store`; values are never logged. Studio main sends the proof only on these routes and the other local-only ones (`isLocalOnlyRoute`), never to another host. In `remote` mode Studio asks nothing and says that a remote daemon never sends values (`IDENTITY_GET`, `IDENTITY_REVEAL`, `PROVIDER_CREDENTIAL_GET` are `remote-unsupported`).

Threat model. The daemon writes the proof at every start to `<settings dir>/daemon-local-proof` (`-<port>` off the default port). On macOS and Linux the file is mode 0600, so only the OS user (and root) can read it. On Windows mode bits mean nothing and the folder's inherited ACL depends on where the settings live (`ADF_USER_DATA_DIR` or a custom settings path need not be in the user profile), so the daemon gives the file its own ACL before writing the secret into it: inheritance removed, full control for the current user only (`icacls /inheritance:r /grant:r`), on every write; if that fails the daemon runs without a proof and the routes that need it refuse (`local-access.ts`, test `tests/daemon-local-proof-acl.test.ts`). Administrators can still take ownership, as of any file. Any process of that user that reads the token file AND the proof file gets every stored value decrypted, without a keychain prompt, including on macOS, where the keychain otherwise asks per application before the daemon's binary reads an `ADF` item (§5.3.1). Such a process could already read the `.adf` files and, on Windows and Linux, the keychain entries that unlock them (§5.3.1), so the routes add no access on those systems. On macOS they do: a user process that could not pass the keychain prompt can read the files and both secrets of the daemon. The proof file's permissions are the only limit on that. Remote callers, proxied callers and token holders on another machine cannot call these routes.

That does not make the token harmless. A token holder anywhere can run code as the daemon (an MCP server or adapter command, then agent start), and that code reads what the daemon's OS user reads: the owner phrase in the keychain, the token and proof files, every `.adf`. The token is as powerful as the owner phrase (§5.3.1); the proof only keeps it off the routes that hand secrets out directly.

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
| 7 | Interactive OAuth sign-in from an agent call | `mcp_oauth_signin` approval, browser opened by Studio | Same approval, injected runner | None | W1-B: same approval; the daemon runs the flow and raises `mcp_oauth_authorize` with `authorize_url`. It stays pending until the callback lands (approve = opened); the runtime ends it with `AgentExecutor.settleHilTask` (outcome `completed`). One sign-in per server. Studio daemon mode MUST open that URL without a click (W3-C); remote mode needs the relayed callback (§9.3, W4-B) |
| 8 | Stdio auth preflight (`mcp_install` with `auth`) | Native "Continue" dialog | Same (injected) | Headless: browser best-effort, wait for exit | Open: needs a HIL-based preflight; proposed for W3-C with the registration-test gap (W1-D list) |
| 9 | MCP setup-level failure | Keeps manager, removes scratch dir | Keeps both | Manager `null` | W1-B: BAM behaviour |
| 10 | MCP reconcile on config change | Agents-screen save and `sys_update_config` | None | None | W1-B: on every `applyConfigChange` (agent writes and `RuntimeService.setAgentConfig`); a server `mcp_install` already connected is skipped; it prompts for OAuth only while a turn runs |
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
| 24 | Config written during the startup window | Adopted at install (`pickFresherConfig`); MCP startup sync onto a fresh read | Start-time config | Start-time config | W2-A: a start on an open document counts the writes made through it during the build and adopts the file's config afterwards (D4 as built). W3-A: a path-addressed write waits for a load in flight and goes through the loaded agent (`RuntimeService.waitForLoad`); the builder persists MCP tool syncs onto a fresh read instead of the start-time config |
| 25 | Idle sweep (`beforeDispatch` activity, session rehydrate) | n/a | Yes | None | Accepted: memory relief only, nothing visible |
| 26 | Peer discovery | mDNS, tailnet, manual peers | n/a | `[]` | W1-B: `services/runtime-discovery.ts`. It polls the mesh server state (2 s) where Studio reacts in its start/stop handlers. `GET /network/mesh/discovered-runtimes?force=1` forwards `force` (W2-A) |
| 27 | Agent whose own provider key is locked (file password, or a sealed envelope) | FILE_OPEN answers `needsPassword` (`ipc/index.ts:2116-2179`); the renderer opens the password dialog before anything starts (`useAdfFile.ts:289`); the start uses the captured key | Autostart skips password-protected files | Built with the real provider: empty key, every turn sent to the provider and answered "isn't authenticated… Settings → Providers" | W1-A: the provider is a stub that fails each call with `credentials_locked` and the unlock route or `adf identity unlock` in its text, before any request; an unlock rebuilds the real provider. `POST /agents/{id}/start?preflight=1` answers 200 with `preflight.code: credentials_locked`. The daemon-mode client (W2-C/W3-A) MUST reproduce Studio's prompt-before-start: for an agent that is not running, `POST /agents/load` (it assembles without the startup turn), read `GET /agents/{id}/identity/password` (`needsPassword && !unlocked`), open the password dialog, `POST /agents/{id}/identity/password/unlock`, then `POST /agents/{id}/start`. A start that answers `preflight.code: credentials_locked` (startup turn already failed with the stub's error) opens the same dialog. Envelope-locked: show the owner-identity unlock instead. As built (W3-A): with open documents the hold replaces the load: FILE_OPEN reads `GET /agents/{id}/identity/password` for the held (or running) agent and answers `needsPassword`, so the renderer prompts on open as in embedded; AGENT_START refuses a held document still locked with `code: credentials_locked` (no start), and passes the code on when the start route answered it; the renderer opens the same dialog on that code (`utils/start-agent.ts`). W5-A1: FILE_OPEN of a running agent that is still locked answers `needsPassword` and `agentWasRunning` and leaves it running; after the unlock the renderer re-attaches it (§3.2) |

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

1. Read the pid file; if a live daemon answers `/health`, call `/version`. Before that call (and before any other request that carries the token or the local proof) Studio checks who answers (W5-D1): `GET /health` reports the daemon's `pid` (no token), the pid file MUST name that pid (Studio waits up to 3 s for the file a daemon writes right after it listens), and the pid MUST be alive. Otherwise Studio sends nothing and shows why (`detect` → `unidentified`). This puts the bare pid, and nothing else, on the unauthenticated `/health`: a narrowing of the lead decision above, so that a program squatting on the port never receives the token. A pid can be claimed by anyone who reads the pid file; a token-keyed challenge would close that and is not built.
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
| Host exec approvals, podman, firewall | Act on the server; the firewall panel is `local` and refers to the laptop, so in `remote` it is labelled with the reason and offers no fix (§9.4) |

Every unsupported action MUST show a sentence that names the reason and the terminal command to run on the server where one exists.

### 9.4 As built (W4-B)

Code: `src/main/backend/daemon-mode/remote/`; route `POST /oauth/relay` (`src/main/daemon/routes/oauth-relay-routes.ts`). In remote mode the handlers of `remote/handlers.ts` take precedence over the shared ones; every other channel works as in local mode.

| Item | Behaviour |
|---|---|
| Connector | `remote/connector.ts`. Before any request: the saved URL passes `remoteTransportRefusal` (§9.2) and the token decrypts. Handshake: `GET /health` without the token, then `GET /version` with it; `clientApiVersion` MUST equal Studio's. Redirects are never followed. Each failure is one sentence: wrong token (401), unreachable host or timeout, TLS failure (certificate codes, https to an http port), redirect, proxy without its daemon (502/503/504), host name not in `ADF_DAEMON_ALLOWED_HOSTS` (403 `host_not_allowed`), not a daemon, other client API version. The failure dialog points at Settings → Backend, which works without a daemon. A daemon unreachable at launch (unreachable host, proxy without its daemon) is retried with backoff (2 s doubling to 30 s, a progress line, one notification); the other failures are not. A 401 after connecting ends the connection with the refused-token sentence. |
| Credentials | The token source has no local proof and no token-file refresh; the shared client sends the token to the URL's origin only (W0-B). Tests: `tests/backend/remote-connector.test.ts` (URL matrix, real http/https servers, every local-only route), the remote parity run (a proxy that sees a proof fails the run). |
| Unconfirmed plain http | Kept in `studio-backend.json` and shown, never used: Studio still boots remote (no embedded fallback, which would autostart this computer's agents), the connector refuses with the failure dialog, Settings → Backend shows the notice (`active.notices`), and `readRemoteToken` answers null. Mode remote without a URL boots remote the same way. A confirmation can be withdrawn without changing the URL. |
| Picker | `remote/picker.ts`: Studio main sends `REMOTE_PICKER_REQUEST` (`open-adf`, `folder`, `save-adf`) to the window; `RemotePickerDialog.tsx` lists `GET /fs/browse` through `REMOTE_FS_BROWSE` (refusals are answered as values) and answers with `REMOTE_PICKER_RESPOND`. A typed path opens on Enter (a folder lists at most 2000 entries); arrow keys and Enter work in the list; New folder creates one through `POST /fs/folders` (inside a browse root, one segment); an error clears the listing, and only the newest browse sets it. Answers are checked for their kind's shape; an unanswered pick is cancelled after 30 minutes. Used by FILE_OPEN, FILE_CREATE (asks before it replaces a file), TRACKED_DIRS_ADD, DIALOG_PICK_DIRECTORY, MCP_PICK_ADF_FILE. |
| Files of this computer | FILE_OPEN with a path asks the daemon first (`GET /files/agent`). This computer's disk is read only for a path main itself handed to the renderer: an OS open, the command line or a second instance (`backend/local-open-grants.ts`, 10-minute grants; Open Recent lists daemon paths in remote mode and grants nothing); every other path may come from the daemon. Network (UNC, `\\?\`, `\\.\`) and device paths never reach the file system. Such a path is offered as an upload of a copy: a native question showing the full local path, then a picked tracked folder or agents folder on the daemon, then `POST /files/import` streamed from disk with task-bar progress (`remote/services.ts`, 30-minute limit). The copy needs review; the file here is not changed. Nothing is uploaded without the user's choice. |
| Downloads | FILE_SHARE_PREPARE, FILE_SHARE_SAVE_AS and DOC_DOWNLOAD_INTERNAL_FILE already read the daemon's bytes (W3-A). Share snapshots live in Studio's per-process scratch folder, are deleted after their drag or 5 minutes and at quit, and a crashed Studio's scratch folder is deleted at the next launch (`purgeStaleProcessDirs`). |
| OAuth | `remote/oauth-relay.ts`. An authorization page is opened only when it is https, has no credentials in the URL, and is on a public IP address or a DNS name all of whose addresses are public (loopback, private, CGNAT, ULA, link-local and metadata refused, so `127.0.0.1.nip.io` is too); a loopback `redirect_uri` needs a port from 1024 to 65535 and the URL a `state`; opens are throttled (one per 5 s, five per 10 minutes); and the user confirms a native question naming the daemon's host and the page's host. A refused page ends the MCP connect test with the reason; a refused agent sign-in, and a page opened without the relay, are shown in a dialog. When its `redirect_uri` is a loopback callback, Studio listens on that port of this computer, takes the one callback whose `state` matches, and posts its OAuth parameters (`code`, `state`, `error`, `error_description`, `error_uri`, `iss`) to `POST /oauth/relay`. The daemon delivers them to its own loopback callback with one GET (http on 127.0.0.1, localhost or [::1], explicit port 1024-65535 other than its own; no redirect followed; the body is not returned). Used by the agent sign-in (`mcp_oauth_authorize`) and the MCP connect test. A port in use on this computer opens the page without the relay and says so. ChatGPT already relays in both modes (W3-B). The route cannot tell whether a sign-in waits at the target: the bearer token already allows more on that host, so the bounds keep it from being a general loopback fetch. |
| remote-unsupported | Each answers its sentence, never a raw error (`tests/backend/daemon-mode-remote.test.ts` over every such channel): FILE_REVEAL and TEMPLATE_REVEAL show the daemon path with a Copy button (no Copy, and the text escaped, for a path with control or bidi characters); IDENTITY_OWNER_REVEAL_MNEMONIC answers `{ mnemonic: null, reason }` and Settings → Identity disables Back up and Import with the CLI commands to run on the server; IDENTITY_GET answers the placeholder for a stored value (IDENTITY_SET keeps the stored value for it); IDENTITY_OWNER_IMPORT and IDENTITY_OWNER_CONFIRM_BACKUP answer without a request (a seed phrase never goes to another machine); a COMPUTE_BROWSER_SESSION push becomes a notice (the viewer is the server's loopback). |
| Settings → Backend | Test connection (the handshake against the draft URL; the saved token only for the saved origin), and Switch to This Daemon (saved URL and token, transport rule), which opens W4-A's switch dialog (§11.1 Remote row). Restart now (`BACKEND_RESTART_STUDIO`) shows only while the saved mode differs from the running one outside a switch. |

`/fs/browse` exposure. A remote client with the token lists folder names and `.adf` names (size, mtime) inside the daemon host's browse roots: the OS user's home folder, the tracked folders, the agents folder and `ADF_DAEMON_BROWSE_ROOTS`. Links that resolve outside every root are left out; dot entries need `showHidden`. The token already allows tracking any folder and running agents with host access, so the listing adds no access. A server operator who wants remote clients to see less sets `ADF_DAEMON_BROWSE_ROOTS` (the home folder is then not a root).

Remote mode and the user-testing rows. Owner identity actions are not available from Studio in remote mode, through an SSH tunnel too: the import route needs the server's local proof in every mode, and Studio does not send a seed phrase to another machine. DMN-20's "owner routes (IDN-02/03) work" holds for the `adf` CLI run on the server.

## 10. Agent lease

### 10.1 Problem

Two runtime hosts on one machine (embedded Studio and a daemon, or two daemons on different settings files) both autostart the same agents: duplicate timers and turns, duplicate Telegram pollers (HTTP 409), contention on mesh port 7295 (`docs/daemon/operations.md:237-249`). Studio in daemon mode runs no agents, so the lease matters for embedded + daemon and daemon + daemon.

### 10.2 Design

- Registry directory: `<per-user config dir>/adf/leases/`, independent of `ADF_USER_DATA_DIR`, `ADF_DAEMON_SETTINGS` and `ADF_INSTANCE`; `ADF_LEASE_DIR` overrides it for tests.
- One lease file per agent file: name `sha256(canonicalKey(realpath))` (same canonical key as `AdfDatabase.openCounts`), content `{v:1, path, agentId, holder:{kind: 'studio-embedded' | 'daemon', pid, runtimeId, settingsPath, startedAt, controlUrl?}, acquiredAt}`.
- Acquire with `open(…, 'wx')` before any host preparation: `AGENT_START` fresh path, BAM `doStartAgent`, `tryAutostart`, `RuntimeService.loadAgent`. Foreground/background hand-offs inside one process keep the lease. Release on dispose. Rename re-keys the lease.
- A lease is stale when its pid is not alive, or, for `daemon` holders, when `controlUrl/version` answers with another pid. A stale lease is replaced (unlink + `wx`; the loser of a race re-reads).
- A live lease held by another process makes start fail with code `agent_leased` and a sentence naming the holder ("agent-1 is running in the ADF daemon, pid 4242"). Autostart records `leased_elsewhere` in its report. No automatic takeover of live leases.
- Agent id (W5-D3): once a start knows the agent id (Studio's `AGENT_START` at acquire; a background start and a daemon load when they read the config, `noteAgentId`), a live lease of the same id at another path (a copied or restored `.adf`), in another process or this one, refuses the start with `agent_leased` and a sentence naming both paths. The check runs after the path lease is written, so two hosts starting two copies at once see each other (at worst both refuse). A stale lease of that id does not block.
- Scope: one OS user on one machine. `.adf` files on network shares opened from two machines are out of scope (documented).

Rationale against a sidecar lease next to the `.adf`: a sidecar would also cover other OS users and sync to other machines, but it cannot use pid liveness across hosts and would need heartbeat writes into synced folders. Against a lease row inside the `.adf`: it would write to every running agent's file periodically. PID reuse can make a dead embedded holder look alive; the error names the pid, and troubleshooting documents deleting the lease file.

### 10.3 Runtime host registry

`<lease dir>/hosts/<pid>.json` = `{kind, pid, settingsPath, startedAt, version, mode}` for every runtime host process (embedded Studio, daemon). Studio in `local`/`remote` mode does not register as a host. The CLI conflict check reads this registry (§8.2) and keeps the old heuristics only for Studio versions that do not write it.

## 11. Mode switch and handover

Switching backends happens at restart (D9) and moves, not copies, the state that cannot be shared:

| State | embedded → `local` | `local` → embedded |
|---|---|---|
| Running agents | Stopped by Studio at quit; the daemon autostarts per the usual rules | Stopped by the daemon (if Studio stops it) or left running there; embedded Studio then hits `agent_leased` for each, visibly |
| Client settings | Copied into `studio-client-settings.json` | Copied back into `adf-settings.json`, except `remoteRecentFiles` (paths on a remote daemon's machine), which stays in the client file |
| Runtime identity | Written to keychain `studio-runtime:<scope>` (§5.3) | Nothing (Studio kept its copy) |
| App-level MCP OAuth | Moved from `mcpOauthCredentials` into the daemon's secret-backend account; removed from Studio | Moved back; removed from the daemon store |
| ChatGPT / Grok sessions | Moved from `auth.json` to `auth.daemon.json` (written with `credential-cipher`); `auth.json` removed | Moved back |
| Open file and focus | Reopened in the daemon after restart | Reopened in embedded after restart |

Studio main performs the handover itself before starting or attaching to the daemon: it has safeStorage, the keychain and the credential-cipher key file, so no route returns secrets over HTTP. If a daemon is already running, Studio asks it to reload the moved stores (`POST /client/reload-credentials`, local-only, carries no secrets).

The switch dialog lists each moved item. Each move is logged. If the daemon already holds a ChatGPT/Grok session for another account, the dialog names both accounts and the user chooses which to keep.

App-level MCP OAuth mapping (`DaemonAppOAuthStore`, `src/main/services/mcp-oauth-store.ts`): Studio's `mcpOauthCredentials` secret is one JSON blob `Record<serverUrl, McpOAuthRecord>`. The daemon keeps one record per server in its secret backend: index account `mcp-oauth-credentials:<studioRuntimeScope>` = `{"v":1,"servers":[serverUrl…]}`, record account `mcp-oauth-credentials:<studioRuntimeScope>:<first 16 hex of sha256(serverUrl)>` (the canonical scope since W4-A; records under the older `settingsScope` account are adopted) = the record JSON, both chunked because Windows Credential Manager caps a value at 1280 UTF-16 characters, less than one JWT pair: head `{"v":1,"gen","n","sha256"}`, chunks at `<account>#<gen>:<i>` (at most 1000 characters, cut on code-point boundaries). A write stores a new generation, flips the head, then deletes the old generation; a crash leaves the head on one complete generation, the read verifies the checksum, and leftovers listed in the head (`pending`, `prev`) are deleted by the next write. W4-A moves the blob with `importBlob(blob)` (to local) and `exportBlob()` (to embedded); record contents and blob keys are unchanged.

Rationale: ChatGPT and MCP OAuth refresh tokens rotate. A copied session is invalidated in one place the first time the other refreshes it, so one-way import on first switch would sign the user out after switching back. Moving the session with the backend role keeps exactly one live copy.

#### 11.1 As built (W4-A)

Code: `src/main/backend/handover.ts` (moves, Electron-free), `mode-switch.ts` (dialogs, restart, resuming agents), `daemon-secrets.ts` (the keychain the daemon reads), `daemon-mode/daemon-exit.ts`, `daemon/routes/client-lifecycle-routes.ts`. Tests: `tests/backend/handover.test.ts` (round trip with a rotating-refresh fake, crash mid-move, accounts conflict, unreadable stores, running daemon, corrupt and missing marker, the daemon's own sign-ins), `tests/backend/mode-switch.test.ts`, `tests/daemon-client-lifecycle-routes.test.ts`, `tests/daemon-quit-e2e.test.ts` (real bundle).

| Item | Behaviour |
|---|---|
| When | The handover runs at Studio's boot in the new mode, before any backend handler, store or daemon exists, and on every boot (idempotent). Settings → Backend shows the switch dialog, saves `studio-backend.json` and restarts Studio. A summary dialog lists what moved and what is not done. |
| Order of a move | Write the destination, read it back, then delete the source. A crash leaves both copies; the next boot keeps the destination copy (equal refresh token), or the more recently refreshed one for one account. |
| Marker | `<userData>/studio-handover.json` v2: `holder`, `keychainUsed`, `moved` (account ids, MCP server URLs Studio moved), `daemonOwn` (the daemon's own sign-ins before the first switch). Back to embedded moves what Studio moved and what was signed in during local mode, never `daemonOwn`. `holder` flips to `studio` only when every item moved, or was absent from a store that was actually read. A keychain that cannot be opened, a locked store or no safeStorage leaves it at `daemon` and the next boot retries; when Studio wrote nothing into a keychain at the switch (`keychainUsed` false), the missing keychain is not a blocker. |
| Corrupt or missing marker | Corrupt: no credential moves in either direction; the dialog and the summary say so until it is fixed or deleted. Missing while Studio's runtime entry is in the keychain: the entry is deleted, sign-ins stay with the daemon (said once). |
| Running daemon | Before the moves back to embedded Studio checks for a daemon on these settings (pid file, `/version`). While one runs, nothing moves back and the marker stays: the summary names it and says to stop it (`adf daemon stop`) and restart Studio. |
| Session-only modes | `ADF_STUDIO_BACKEND` and "embedded for this session" (§8.2, launch flag `--adf-session-backend=embedded`, source `session`) move client keys only. Credentials, the runtime entry and the marker stay as the configured mode keeps them; the running daemon is not told to reload. |
| Accounts conflict | One account signed in on both sides on its own (the daemon's login before the switch): two refresh-token families, both kept, each on its side. One login's two token sets (a resumed move): the more recently refreshed one is kept, the other saved. Different accounts on both sides: a dialog names both. The session not kept is saved, encrypted with the daemon's cipher, as `<provider>/auth.replaced.<time>.json`, one file per provider and account, so a later conflict over another account never overwrites it and a handover re-run after a crash reuses the file (W5-F); renamed to `auth.daemon.json` it is the daemon's session. Each is deleted 30 days after it was written (`sweepReplacedSessions`, every handover run, so every Studio start) or at the next sign-in to its account on either side (`noteSignIn`), logged, as is the single `auth.replaced.json` of earlier builds; the conflict dialog says so (W5-D1). |
| Keychain | Opened only when something goes through it. App MCP sign-ins use the canonical scope (`studioRuntimeScope`), as the runtime entry; records under the older `settingsScope` account are adopted by the daemon at boot and by the handover. Without a keychain the daemon can share, MCP sign-ins and the runtime identity stay with Studio; the dialog states the fallback. |
| Runtime entry | Written on every local boot when it differs; after an owner import in local mode Studio re-signs the delegation with the new phrase and rewrites it. Deleted on the way back. Studio also mirrors its owner phrase into `ADF / owner-mnemonic` when absent. |
| Running agents | The agents running before a switch run after it, on the other side: the switch records them in `<userData>/studio-switch-resume.json` and the new launch starts each through the mode's gated background start, after the backend's own boot (embedded: the mesh, as autostart) (review, password, lease rules apply). A start refused with `agent_leased` (the previous runtime has not let go yet, e.g. a daemon that took longer than the 22 s quit wait) is tried again every 5 s for up to 60 s (W5-D3). One notification lists what started and what did not. Back to embedded with a daemon that keeps running (CLI-started, or "keep running" on), its agents stay there; the dialog says so. |
| Turns in flight | The switch dialog lists agents with a turn in flight and offers "Wait for Them to Finish" (Studio restarts once those turns end; after 30 minutes it stops waiting and says so). While a switch waits, Settings → Backend shows it with Finish Switch Now (restart, the quit stops the turns) and Cancel Switch (the running mode is saved again) or "Stop Them Now" (the quit interrupts them). Nothing is interrupted without that choice. |
| Running daemon after a switch | `POST /client/reload-credentials` (local-only): the daemon re-reads the runtime entry, re-runs the unlock of degraded agents and recovers subscription auth errors. |
| Quit (§8.3) | `POST /client/sessions/:id/quit {stopDaemon}`: the daemon ends the session and stops when `startedBy` is `studio`; with other sessions open the stop is held until the last one ends or expires (`daemon_orphan_hold`). Once it decides to stop it refuses new sessions. `keepDaemonRunning` is read at quit and sent to the session when it changes (`PUT …/exit-when-closed`), so the crash path follows it too. A switch to embedded waits up to 22 s for the daemon's pid (not its `/health`, which closes first) so its leases are free. |
| Version mismatch (§8.2) | Dialog: restart the daemon with Studio's version, or embedded for this launch only. A daemon Studio did not start, or one other clients use (`GET /client/sessions`), is named, the restart button reads "Restart It Anyway" and embedded is the default. The replacement keeps the replaced run's `startedBy`. |
| Remote | A switch to or from remote moves client keys only (`handoverNeedsKeychain` is false; `tests/backend/handover.test.ts` "never moves local credentials"). The switch dialog names the remote URL and says that sign-ins, provider keys, the owner phrase and the runtime identity stay on this computer (to remote), or that nothing comes from the remote daemon (from remote). Running agents are not carried across machines (`resumesAgents`): agents running here stop and are not started on the remote daemon; the remote daemon's agents keep running there and are not started here, and Studio does not wait for their turns. Settings → Backend "Switch to This Daemon" opens the same dialog; Restart Studio (`BACKEND_RESTART_STUDIO`) is left for a saved mode this launch does not run outside a switch, through `relaunchStudio`. |

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

Q6 (§14, 2026-10-16) schedules it: the PR that merges this branch makes Local daemon the default and keeps Embedded as a fallback for that release; a follow-up PR a few days later deletes Embedded. Its scope is in the tracker, "Embedded removal".

## 14. Owner decisions (2026-10-14, Q6 2026-10-16)

Q1-Q5 (2026-10-14) were accepted as recommended. Q2 and Q4 were decided by the lead; Q1, Q3 and Q5 by the owner. Q6 (2026-10-16) was decided by the owner.

| # | Question | Decision |
|---|---|---|
| Q1 | In `local` mode, should the daemon adopt Studio's runtime identity (§5.3)? | Yes. Without it, review shows own agents as `recognized` depending on the mode. |
| Q2 | Default of "Keep the daemon running when Studio quits"? | Off, matching embedded behaviour. |
| Q3 | Remote transport: https, loopback tunnel and tailnet only, with an explicit opt-in for other plain-HTTP URLs; no TLS in the daemon? | Yes. |
| Q4 | R6 reading: existing `window.adfApi` members keep their signatures and semantics, and new members are allowed for backend selection, daemon status and remote file transfer? | Yes. Settings → Backend cannot exist without new members. |
| Q5 | Embedded code may change only under Rules E1-E3 (§3.2)? | Yes. Copying instead of extracting recreates drift. |
| Q6 | Which backend is the default, and for how long does Embedded stay? (2026-10-16) | Local daemon for every install: new installs and 0.7.x users upgrading (§4.4). The first launch runs the handover automatically and shows one notice. Embedded stays selectable for that one release as a fallback, labelled legacy, through the persistent switch; a follow-up PR a few days later deletes it. Goal: one backend to maintain. |
