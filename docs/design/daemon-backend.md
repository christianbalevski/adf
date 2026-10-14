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
| `templates` | `TEMPLATES_CHANGED` | template writes (`/templates*`); the templates folder watcher is a W3-A follow-up (tracker §6) |
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
| 03220394 | `IDENTITY_REVEAL` and `IDENTITY_GET` refuse key material (`crypto:*`): `{ value: null, reason }`, and the Identity panel shows the reason. Test: parity scenario agent-keystore. | Embedded sent the agent's private signing key to the renderer on Reveal; nothing in the UI needs it, and the daemon never returns it (§5.4.1). |
| 4570606c | A credential save (`IDENTITY_SET`, `PROVIDER_CREDENTIAL_SET`) to a locked credentials envelope asks Replace or Cancel (`services/locked-credential.ts`, `locked-credential-dialog.ts`, shared with the daemon). Characterization first: cf83a1d6. Test: parity scenario locked-credentials, both backends. | Embedded wrote a new value unsealed without asking, and over a sealed value failed with a dead-end error; the daemon asks (as the terminal app does). One rule in both modes. |

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

The entry is re-read at boot, on every identity refresh (`GET /identity`, an owner change, the 60 s re-check while an agent is degraded). Studio MUST rewrite it whenever one of the copied values changes, including after an owner import, which re-signs `runtimeDelegation`; until then the daemon reports `rejected` / `owner_mismatch` and runs as its own runtime. Studio MUST delete it when it rotates its runtime key, and MUST delete it when it switches back to embedded mode (W4-A), so no copy of its runtime keys outlives local mode.

Owner switch from the daemon (`POST /identity/import` with `switchOwner`, `adf identity import`): the daemon keeps the adopted runtime for the restamp, so Studio-stamped files get operator attestations from Studio's runtime key; a restamp by any runtime keeps the existing operator attestations of a file stamped by another runtime. It overwrites the daemon's copy of the phrase (the keychain entry, or the passphrase file when the daemon uses file storage; a keychain copy is then left as it is) and moves Studio's stored copy of the previous phrase, still encrypted, from `ownerMnemonic` to `ownerMnemonicSuperseded:<previous owner DID>` (never overwriting an existing one). Embedded Studio at its next start finds no phrase of its own, imports the keychain phrase for the owner on record, and `ensureRuntimeKey` re-signs its runtime delegation under the new owner (the step Studio's own Import identity also runs). Rule E3 hardens the same path for a Studio copy that is still present: Studio takes the keychain phrase when its own copy does not derive `ownerDid` AND `legacyOwnerDids` records the switch from its copy's owner (a merely wrong `ownerDid`, from a hand edit or copied settings, never costs Studio its phrase), keeps its copy as `ownerMnemonicSuperseded:<DID>`, never mirrors such a copy over the keychain entry, and never signs owner attestations with it. `ownerMnemonicSuperseded:*` keys are secret: never returned by `getAll` or the daemon's `/settings`, never writable over HTTP. Adoption recovers when Studio next writes the entry. The switch is refused while the previous owner's backup is unconfirmed, unless the caller states it holds that phrase (`previousOwnerBackupConfirmed`, `--i-have-a-backup`), because the switch deletes it from the machine.

`GET /identity` → `runtime` = `{state: 'adopted' | 'absent' | 'rejected' | 'unavailable', source: 'studio' | 'daemon', reason, daemonRuntimeDid, daemonEncPublicKey, message}`. The switch dialog SHOULD show `message` when `state` is not `adopted`.

Testing: `tests/helpers/studio-runtime-entry.ts` (`writeStudioRuntimeEntry`, `fakeKeychain`). A spawned test daemon reads a plaintext keychain file named by `ADF_TEST_KEYCHAIN_FILE` when `src/main/utils/test-seams.ts` allows it: `ADF_TEST_SEAMS=1`, the code does not run from `app.asar` or `node_modules`, and the process is not a packaged Electron (to be unified with W1-G's `isPackagedRuntime` at merge); otherwise that variable makes it use the passphrase file, never the OS keychain. `ADF_KEYCHAIN=0` disables every keychain, including the test file.

Security: on Windows (Credential Manager) and Linux (Secret Service) any process of the OS user reads every `ADF` entry; there the entry exposes nothing such a process could not already read, PROVIDED the owner phrase is also in the keychain (`ADF / owner-mnemonic`, which Studio mirrors when a keychain exists): the phrase is strictly stronger (it signs delegations and opens every owner slot). Without the phrase in the keychain, the entry is new exposure: Studio's runtime signing and encryption keys, which otherwise sit only in Studio's safeStorage, become readable to that user's processes. On macOS keychain items carry per-application ACLs: the entry is created by Studio, and the daemon reading it prompts once; the real weakening is that the daemon runs as a generic Electron-as-Node or `node` binary, so "Always Allow" grants that binary, and with it any script it runs, access to the item. The switch dialog SHOULD say so on macOS. The delegation check stops a corrupted, stale or planted entry from changing the signing identity; it is no barrier to someone who holds the phrase. A token-only attacker (HTTP) gains nothing: no route accepts or returns key material, and `POST /identity/import` requires the local proof file in every mode. Stored credential values (not key material) do leave the daemon, to local callers with that proof only; the rationale and the macOS consequence are in §5.4.1.

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
| Reveal a stored value (Identity panel, provider key field, `IDENTITY_GET`) | The local-only reveal routes with the local proof (§5.4.1); key material never | Not available; Studio says so (`remote-unsupported`) |
| Unlock a legacy whole-file password | The unlock route converts the owner's own file as Studio does (`envelope-actions.ts` `convertOwnLegacyPassword`) and answers `converted` | Same |

The derived key of a password-protected agent MUST reach every consumer in the daemon (provider, MCP, adapters, `AdfCallHandler`); today `unlockAgentIdentityPassword` rebuilds only the provider (`runtime-service.ts:1812`).

#### 5.4.1 Stored values for Studio: the one exception to "values never leave the daemon"

The daemon's credential and identity reads answer metadata only. Embedded Studio, though, shows stored values in its own window: Reveal in the agent's Identity panel, the key field of an agent's provider override, the MCP environment form (`IDENTITY_GET`). In daemon mode that window belongs to a separate process, so the values have to cross a process boundary. Two routes carry them, and nothing else does:

| Route | Reads |
|---|---|
| `POST /agents/:id/identity/reveal` | Values of a running agent or open document, with its unlocked key |
| `POST /files/agent/identity/reveal?path=` | The same for any path; a file nobody has open is read through one readonly connection (plain values only, nothing written, no envelope unlocked) |

Rules:

- Both answer only a local caller (loopback peer, no proxy header) that ALSO presents this run's local proof (`X-ADF-Local-Proof`) in every mode, as `POST /identity/import` does. The bearer token alone is not enough: a token forwarded to the loopback port (`ssh -L`, socat, a container port map) passes the loopback check but has no proof.
- Key material (`crypto:*`: the agent's signing key, envelope descriptors, KDF rows) is never returned. Studio refuses to reveal it in both modes (Rule E3 row below), with a reason the panel shows.
- Answers carry `Cache-Control: no-store`; values are never logged. Studio main sends the proof only on these routes and the other local-only ones (`isLocalOnlyRoute`), never to another host. In `remote` mode Studio asks nothing and says that a remote daemon never sends values (`IDENTITY_GET`, `IDENTITY_REVEAL`, `PROVIDER_CREDENTIAL_GET` are `remote-unsupported`).

Threat model. The daemon writes the proof at every start to `<settings dir>/daemon-local-proof` (`-<port>` off the default port). On macOS and Linux the file is mode 0600, so only the OS user (and root) can read it. On Windows mode bits mean nothing and the folder's inherited ACL depends on where the settings live (`ADF_USER_DATA_DIR` or a custom settings path need not be in the user profile), so the daemon gives the file its own ACL before writing the secret into it: inheritance removed, full control for the current user only (`icacls /inheritance:r /grant:r`), on every write; if that fails the daemon runs without a proof and the routes that need it refuse (`local-access.ts`, test `tests/daemon-local-proof-acl.test.ts`). Administrators can still take ownership, as of any file. Any process of that user that reads the token file AND the proof file gets every stored value decrypted, without a keychain prompt, including on macOS, where the keychain otherwise asks per application before the daemon's binary reads an `ADF` item (§5.3.1). Such a process could already read the `.adf` files and, on Windows and Linux, the keychain entries that unlock them (§5.3.1), so the routes add no access on those systems. On macOS they do: a user process that could not pass the keychain prompt can read the files and both secrets of the daemon. The proof file's permissions are the only limit on that. Remote callers, proxied callers, and token holders on another machine gain nothing.

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
| 24 | Config written during the startup window | Adopted at install (`pickFresherConfig`); MCP startup sync onto a fresh read | Start-time config | Start-time config | W2-A: a start on an open document counts the writes made through it during the build and adopts the file's config afterwards (D4 as built). Open: path-agent-ops `writeClosed` during a load (no document) is not counted, and `agent-runtime-builder.ts:1067` writes the start-time config back; both tracked for W3-A |
| 25 | Idle sweep (`beforeDispatch` activity, session rehydrate) | n/a | Yes | None | Accepted: memory relief only, nothing visible |
| 26 | Peer discovery | mDNS, tailnet, manual peers | n/a | `[]` | W1-B: `services/runtime-discovery.ts`. It polls the mesh server state (2 s) where Studio reacts in its start/stop handlers. `GET /network/mesh/discovered-runtimes?force=1` forwards `force` (W2-A) |
| 27 | Agent whose own provider key is locked (file password, or a sealed envelope) | FILE_OPEN answers `needsPassword` (`ipc/index.ts:2116-2179`); the renderer opens the password dialog before anything starts (`useAdfFile.ts:289`); the start uses the captured key | Autostart skips password-protected files | Built with the real provider: empty key, every turn sent to the provider and answered "isn't authenticated… Settings → Providers" | W1-A: the provider is a stub that fails each call with `credentials_locked` and the unlock route or `adf identity unlock` in its text, before any request; an unlock rebuilds the real provider. `POST /agents/{id}/start?preflight=1` answers 200 with `preflight.code: credentials_locked`. The daemon-mode client (W2-C/W3-A) MUST reproduce Studio's prompt-before-start: for an agent that is not running, `POST /agents/load` (it assembles without the startup turn), read `GET /agents/{id}/identity/password` (`needsPassword && !unlocked`), open the password dialog, `POST /agents/{id}/identity/password/unlock`, then `POST /agents/{id}/start`. A start that answers `preflight.code: credentials_locked` (startup turn already failed with the stub's error) opens the same dialog. Envelope-locked: show the owner-identity unlock instead |

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

App-level MCP OAuth mapping (`DaemonAppOAuthStore`, `src/main/services/mcp-oauth-store.ts`): Studio's `mcpOauthCredentials` secret is one JSON blob `Record<serverUrl, McpOAuthRecord>`. The daemon keeps one record per server in its secret backend: index account `mcp-oauth-credentials:<settingsScope>` = `{"v":1,"servers":[serverUrl…]}`, record account `mcp-oauth-credentials:<settingsScope>:<first 16 hex of sha256(serverUrl)>` = the record JSON, both chunked because Windows Credential Manager caps a value at 1280 UTF-16 characters, less than one JWT pair: head `{"v":1,"gen","n","sha256"}`, chunks at `<account>#<gen>:<i>` (at most 1000 characters, cut on code-point boundaries). A write stores a new generation, flips the head, then deletes the old generation; a crash leaves the head on one complete generation, the read verifies the checksum, and leftovers listed in the head (`pending`, `prev`) are deleted by the next write. W4-A moves the blob with `importBlob(blob)` (to local) and `exportBlob()` (to embedded); record contents and blob keys are unchanged.

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
