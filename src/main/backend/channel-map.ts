/**
 * Exhaustive IPC channel map for Studio on the daemon backend
 * (docs/design/daemon-backend.md D2).
 *
 * Every channel in `IPC` (src/shared/constants/ipc-channels.ts) and every raw
 * string channel in RAW_CHANNELS has one entry. The map is typed
 * `satisfies Record<IpcChannel | RawChannel, ChannelEntry>`, so a channel
 * added to `IPC` without an entry here is a compile error. Classifying a new
 * channel is one line: `[IPC.NEW_CHANNEL]: proxied('invoke', ['GET /route']),`.
 *
 * Classes:
 *
 * | Class | Meaning |
 * |---|---|
 * | `local` | Electron-only (dialogs, window, updater, spellcheck, shell, drag, orbital cache, firewall) or a stub with no backend state. One implementation, shared by both modes. `routes` lists daemon state the handler still reads. |
 * | `proxied` | Daemon mode forwards to the daemon routes in `routes`, plus the routes the `gaps` workstreams add. The same implementation serves `local` and `remote`. |
 * | `remote-variant` | The `local`-mode implementation (daemon routes, Electron APIs, or both) does not work across machines; `remote` needs the different implementation in `remote` (§9.3). |
 * | `remote-unsupported` | Works in `local` mode; in `remote` the handler returns a typed error the renderer already displays, worded as in `remote`. |
 *
 * Kinds: `invoke` (renderer `ipcRenderer.invoke`), `send` (renderer
 * `ipcRenderer.send`), `push` (main `webContents.send`), `none` (defined in
 * `IPC` but neither registered, sent nor exposed in preload).
 *
 * Routes are written as `METHOD /path` with `:param`, exactly as registered
 * and documented in docs/daemon/openapi.json (tests/backend/channel-map.test.ts
 * checks each one). Studio's handlers take file paths; daemon routes take
 * agent ids. Daemon mode resolves a path to an id through its session
 * (D3: the open document, W2-A/W2-B) or GET /tracked-dirs/agents/all, which
 * covers tracked files only. A path with no id (an untracked file that is
 * neither loaded nor held) MUST first be held as a document (W2-B) or reached
 * through a path-addressed file route (`/files/agent*`, W1-E).
 *
 * A `gaps` entry names the workstream that adds what the daemon lacks today
 * (docs/design/daemon-backend-tracker.md §4). The same list, grouped by
 * workstream, is docs/design/daemon-backend-gaps.md; the test keeps the two in
 * step. Proxied push channels name the client-stream frame (D5) that feeds
 * them in `frame`; the event bridge (W2-C) maps frames to pushes.
 *
 * Every embedded side effect a daemon-mode handler does not reproduce from
 * existing routes is a gap, never a `note`. A note states what the daemon-mode
 * handler itself does in Studio main, or a verified daemon fact; the test
 * rejects a note that describes embedded behaviour.
 */

import { IPC, type IpcChannel } from '../../shared/constants/ipc-channels'

/**
 * String channels used without an `IPC` constant. A new raw
 * `webContents.send('…')` or `ipcMain.handle('…')` in src/main fails
 * tests/backend/channel-map.test.ts until it is listed here and classified.
 */
export const RAW_CHANNELS = ['stdlib-install-progress'] as const
export type RawChannel = (typeof RAW_CHANNELS)[number]
export type MappedChannel = IpcChannel | RawChannel

export type ChannelClass = 'local' | 'proxied' | 'remote-variant' | 'remote-unsupported'
export type ChannelKind = 'invoke' | 'send' | 'push' | 'none'

/** Workstreams that add daemon routes, producers or behaviour a channel needs. */
export type GapWorkstream = 'W1-A' | 'W1-B' | 'W1-C' | 'W1-D' | 'W1-E' | 'W2-A' | 'W2-B' | 'W2-C' | 'W3-A'

export interface ChannelGap {
  ws: GapWorkstream
  need: string
}

export interface ChannelEntry {
  class: ChannelClass
  kind: ChannelKind
  /** Existing daemon routes the daemon-mode handler calls (for `local`: daemon state it reads). */
  routes: readonly string[]
  /** Proxied push: the client-stream frame (D5) it is fed from: `executor`, `host` or `push:<topic>`. */
  frame?: string
  gaps: readonly ChannelGap[]
  /** Remote-mode behaviour where it differs from `local` mode. */
  remote?: string
  note?: string
}

interface EntryOpts {
  gaps?: readonly ChannelGap[]
  frame?: string
  note?: string
}

const gap = (ws: GapWorkstream, need: string): ChannelGap => ({ ws, need })

function local(kind: ChannelKind, note?: string, opts: { reads?: readonly string[]; remote?: string } = {}): ChannelEntry {
  return { class: 'local', kind, routes: opts.reads ?? [], gaps: [], ...(opts.remote ? { remote: opts.remote } : {}), ...(note ? { note } : {}) }
}

function proxied(kind: ChannelKind, routes: readonly string[], opts: EntryOpts = {}): ChannelEntry {
  return { class: 'proxied', kind, routes, gaps: opts.gaps ?? [], ...(opts.frame ? { frame: opts.frame } : {}), ...(opts.note ? { note: opts.note } : {}) }
}

function variant(kind: ChannelKind, routes: readonly string[], remote: string, opts: EntryOpts = {}): ChannelEntry {
  return { ...proxied(kind, routes, opts), class: 'remote-variant', remote }
}

function unsupported(kind: ChannelKind, routes: readonly string[], remote: string, opts: EntryOpts = {}): ChannelEntry {
  return { ...proxied(kind, routes, opts), class: 'remote-unsupported', remote }
}

// Gaps shared by many channels.

/** D5: hold / release the open file as a session document. */
const HOLD_DOC = gap('W2-B', 'hold the file as the session document (POST /client/sessions/:id/documents)')
/** Design §6 recipe rows owned by W1-B, for every start path. */
const RECIPE = [
  gap('W1-B', 'full mesh registration: message bus subscription, isMessageTriggered, config updates (registerAgent)'),
  gap('W1-B', 'umbilical taps on, or a written reason'),
  gap('W1-B', 'shared ensureCoreToolDeclarations (delete the private copy, agent-runtime-builder.ts:350)'),
  gap('W1-B', 'interactive MCP OAuth as a HIL request carrying the authorize URL; keep the MCP manager on setup failure'),
] as const
const streamTopic = (topic: string): ChannelGap => gap('W2-B', `client-stream push topic \`${topic}\``)

/** Lifetime burn totals live in the client key fleetMapState.burnTotals (§4.1). */
const BURN_HYDRATE = 'Once per session, POST /fleet/burn/hydrate with the client key fleetMapState.burnTotals.'

const REMOTE_FOLDER_PICKER = 'Daemon-side folder picker over tracked directories and GET /fs/browse (picker UI: W4-B); the native dialog would pick a path on the laptop.'
const REMOTE_FILE_PICKER = 'Daemon-side .adf picker over tracked directories and GET /fs/browse (picker UI: W4-B); the native dialog would pick a path on the laptop.'

export const CHANNEL_MAP = {
  // --- File operations -------------------------------------------------------
  [IPC.FILE_OPEN]: variant('invoke', ['GET /agents/:id/identity/password', 'GET /agents/:id/status', 'PATCH /settings'], `${REMOTE_FILE_PICKER} A dropped or OS-opened laptop file is uploaded first (POST /files/import).`, {
    gaps: [
      HOLD_DOC,
      gap('W2-B', 'self-heal on open: the hold relocates a reviewed file stranded in the daemon host\'s OS temp dir into the agents folder (POST /files/relocate exists; nothing reports the temp location)'),
    ],
    note: 'Native open dialog in Studio main; the handler records the client key recentFiles. A running agent is reattached, not reopened.',
  }),
  [IPC.FILE_SAVE]: proxied('invoke', ['POST /agents/:id/checkpoint']),
  [IPC.FILE_CREATE]: variant('invoke', ['POST /agents/create'], 'The save dialog picks a laptop path; remote needs a daemon-side folder picker plus a name (GET /fs/browse; picker UI: W4-B).', {
    gaps: [HOLD_DOC],
    note: 'Save dialog in Studio main, then create (directory + name). The created file becomes the open file, not running; the handler records recentFiles.',
  }),
  [IPC.FILE_CREATE_QUICK]: proxied('invoke', ['POST /agents/create', 'GET /files/agents-folder'], {
    gaps: [HOLD_DOC],
    note: 'A typed name that exists is refused with code name_taken; the folder must exist and must not be under the OS temp dir.',
  }),
  [IPC.AGENTS_FOLDER_DEFAULT_GET]: proxied('invoke', ['GET /files/agents-folder']),
  [IPC.FILE_CLOSE]: proxied('invoke', [], { gaps: [gap('W2-B', 'release the session document (DELETE /client/sessions/:id/documents/:agentId)')] }),
  [IPC.FILE_DELETE]: proxied('invoke', ['DELETE /files']),
  [IPC.FILE_CLONE]: proxied('invoke', ['POST /files/clone']),
  [IPC.FILE_LIST_TABLES]: proxied('invoke', ['GET /files/agent/tables'], { note: 'Clone dialog.' }),
  [IPC.FILE_RENAME]: proxied('invoke', ['POST /files/rename']),
  [IPC.FILE_RENAMED]: proxied('push', [], { frame: 'push:file_renamed', gaps: [streamTopic('file_renamed')] }),
  [IPC.FILE_GET_CURRENT]: proxied('invoke', ['GET /agents/:id/status'], { note: 'filePath is DaemonModeSession state (D3); agentRunning comes from the status.' }),
  [IPC.FILE_REVEAL]: unsupported('invoke', [], 'Disabled; the path is shown as text (§9.3).', { note: 'Local mode: shell.showItemInFolder on the daemon path (same machine).' }),
  [IPC.FILE_SHARE_PREPARE]: proxied('invoke', ['GET /files/snapshot'], {
    note: 'Studio main writes the bytes into its scratch share dir and registers the token FILE_SHARE_DRAG_START drags; app.getFileIcon stays local.',
  }),
  [IPC.FILE_SHARE_DRAG_START]: local('send', 'startDrag of the temp file FILE_SHARE_PREPARE wrote. Reads no backend state, but works only when the daemon-mode PREPARE handler fills the same token map.'),
  [IPC.FILE_SHARE_DISCARD]: local('invoke', 'Deletes the Studio-side temp snapshot that FILE_SHARE_PREPARE wrote; the daemon holds no state for it.'),
  [IPC.FILE_SHARE_SAVE_AS]: proxied('invoke', ['GET /files/snapshot'], { note: 'Save dialog and the write stay in Studio main (a laptop path in remote mode).' }),

  // --- Document content ------------------------------------------------------
  [IPC.DOC_GET_DOCUMENT]: proxied('invoke', ['GET /agents/:id/document']),
  [IPC.DOC_SET_DOCUMENT]: proxied('invoke', ['PUT /agents/:id/document']),
  [IPC.DOC_GET_AGENT_CONFIG]: proxied('invoke', ['GET /agents/:id/config']),
  [IPC.DOC_SET_AGENT_CONFIG]: proxied('invoke', ['GET /agents/:id/config', 'PUT /agents/:id/config', 'GET /files/agent'], {
    gaps: [
      gap('W1-B', 'MCP reconcile on config change'),
      gap('W1-B', 'mesh config update on config change (meshManager.updateAgentConfig)'),
    ],
    note: 'The handler refuses a config whose id differs from the open file (session check). A running agent\'s deferred rename is read back from GET /files/agent pendingName.',
  }),
  [IPC.DOC_AGENT_CONFIG_CHANGED]: proxied('push', [], {
    frame: 'push:config_changed',
    gaps: [streamTopic('config_changed'), gap('W2-B', 'origin dedup: a config write made by a session is not echoed to that session')],
    note: 'Runtime-originated changes only, for the open file.',
  }),
  [IPC.DOC_GET_CHAT]: proxied('invoke', ['GET /agents/:id/chat']),
  [IPC.DOC_GET_CHAT_OLDER]: proxied('invoke', ['GET /agents/:id/chat']),
  [IPC.DOC_SET_CHAT]: local('invoke', 'No-op stub that returns success; chat is written by the runtime only. No daemon call.'),
  [IPC.DOC_CLEAR_CHAT]: proxied('invoke', ['DELETE /agents/:id/chat'], { gaps: [gap('W1-B', 'main-loop clear resets the mesh session (meshManager.resetAgentSession)')] }),
  [IPC.DOC_GET_INBOX]: proxied('invoke', ['GET /agents/:id/inbox']),
  [IPC.DOC_CLEAR_INBOX]: proxied('invoke', ['DELETE /agents/:id/inbox'], { gaps: [gap('W2-B', 'clearing the inbox emits the inbox topic with an empty inbox')] }),
  [IPC.DOC_GET_OUTBOX]: proxied('invoke', ['GET /agents/:id/outbox']),
  [IPC.DOC_GET_BATCH]: proxied('invoke', ['GET /agents/:id/batch']),
  [IPC.DOC_GET_HEADER]: proxied('invoke', ['GET /agents/:id/header']),

  // --- Agent runtime ---------------------------------------------------------
  [IPC.AGENT_START]: proxied('invoke', ['POST /agents/:id/start', 'GET /agents/:id/status', 'GET /agents/:id/triggers', 'GET /approvals/interactions', 'GET /agents/:id/identity/password', 'POST /agents/:id/stop', 'GET /agents/:id/config'], {
    gaps: [
      gap('W2-B', 'set the session focus to the started agent'),
      ...RECIPE,
    ],
    note: 'The reuse path (agent already running) returns sessionId, the display state (GET /agents/:id/triggers), and main\'s pending approvals and asks (GET /approvals/interactions). A held document whose key is locked answers code credentials_locked without starting (design §6.1 row 27).',
  }),
  [IPC.AGENT_STOP]: proxied('invoke', ['POST /agents/:id/stop']),
  [IPC.AGENT_STATUS]: proxied('invoke', ['GET /agents/:id/status']),
  [IPC.AGENT_INVOKE]: proxied('invoke', ['POST /agents/:id/chat'], {
    note: 'filePath may name a background agent; loop selects the stream.',
  }),
  [IPC.AGENT_COMPACT]: proxied('invoke', ['POST /agents/:id/compact']),
  [IPC.AGENT_EVENT]: proxied('push', [], {
    frame: 'executor',
    gaps: [gap('W2-B', 'executor frames, deltas for the focused agent only')],
    note: 'Focused agent only. Mesh inter_agent_message and chat_updated outside the executor are synthesized onto this channel (§7).',
  }),
  [IPC.AGENT_TOOL_APPROVAL_RESPOND]: proxied('invoke', ['POST /agents/:id/tasks/:taskId/resolve'], { note: 'requestId is the HIL task id; feedback maps to reason.' }),
  [IPC.AGENT_TOOL_ALWAYS_APPROVE]: proxied('invoke', ['POST /agents/:id/tasks/:taskId/always-approve']),
  [IPC.AGENT_TOOL_APPROVE_ALL_GATED]: proxied('invoke', ['POST /agents/:id/tasks/approve-all']),

  // --- Approvals hub ---------------------------------------------------------
  [IPC.APPROVALS_LIST]: proxied('invoke', ['GET /approvals']),
  [IPC.APPROVALS_RESOLVE]: proxied('invoke', ['POST /approvals/resolve']),
  [IPC.APPROVALS_CHANGED]: proxied('push', [], {
    frame: 'push:approvals',
    gaps: [streamTopic('approvals')],
    note: 'Sent to every window, not only the first (ipc/index.ts:1938).',
  }),
  [IPC.APPROVALS_GET_INPUT]: proxied('invoke', ['GET /approvals/input'], { note: 'Unwraps { input }; {} answers undefined.' }),
  [IPC.APPROVALS_REVEAL]: local('push', 'Studio native notifier and menu bar click. In daemon mode the notifier is fed from the approvals frames.'),
  [IPC.APPROVALS_GET_PENDING_REVEAL]: local('invoke', 'Reveal queued in Studio main for a loading renderer.'),

  [IPC.AGENT_ASK_RESPOND]: proxied('invoke', ['POST /agents/:id/asks/:requestId/respond']),
  [IPC.AGENT_SUSPEND_RESPOND]: proxied('invoke', ['POST /agents/:id/suspend/respond']),

  // --- Models and settings ---------------------------------------------------
  [IPC.MODELS_LIST]: proxied('invoke', ['GET /runtime/models'], { note: 'filePath maps to agentId for ADF-stored providers.' }),
  [IPC.SETTINGS_GET]: proxied('invoke', ['GET /settings'], {
    note: 'Returns {...daemonSettings, ...clientSettings} (§4.2); provider apiKey arrives as __redacted__. Studio main runs the client-key migrations on studio-client-settings.json when it loads it (daemon-mode/settings.ts).' }),
  [IPC.SETTINGS_SET]: proxied('invoke', ['PATCH /settings'], {
    note: 'Split by settingsKeyClass(): client keys go to studio-client-settings.json, backend keys to the daemon. menuBarEnabled applies in Studio main.',
  }),

  // --- Agent templates -------------------------------------------------------
  [IPC.TEMPLATES_LIST]: proxied('invoke', ['GET /templates'], { note: 'Drop `migrated` when the client key templatesMigrationSeen is set.' }),
  [IPC.TEMPLATES_CHANGED]: proxied('push', [], { frame: 'push:templates', gaps: [streamTopic('templates')] }),
  [IPC.TEMPLATES_MIGRATION_SEEN]: local('invoke', 'Writes the client key templatesMigrationSeen.'),
  [IPC.TEMPLATE_CREATE]: proxied('invoke', ['POST /templates']),
  [IPC.TEMPLATE_DELETE]: proxied('invoke', ['GET /templates', 'DELETE /templates/:id', 'PATCH /settings'], { note: 'Local mode: the handler moves the template file to the OS trash itself (shell.trashItem on the path GET /templates names) and resets defaultTemplateId through PATCH /settings. Remote mode: DELETE /templates/:id (the server\'s templates-trash).' }),
  [IPC.TEMPLATE_RESET_SHIPPED]: proxied('invoke', ['POST /templates/:id/reset']),
  [IPC.TEMPLATE_REVEAL]: unsupported('invoke', ['GET /templates'], 'Disabled; the templates folder path is shown as text.', { note: 'Local mode: shell on the daemon templates folder (folder from GET /templates).' }),
  [IPC.TEMPLATE_SET_DEFAULT]: proxied('invoke', ['POST /templates/:id/default']),
  [IPC.TEMPLATE_RENAME]: proxied('invoke', ['PATCH /templates/:id']),
  [IPC.TEMPLATE_SET_META]: proxied('invoke', ['PATCH /templates/:id']),
  [IPC.TEMPLATE_GET_CONTENTS]: proxied('invoke', ['GET /templates/:id']),
  [IPC.TEMPLATE_SET_CONFIG]: proxied('invoke', ['PUT /templates/:id/config']),
  [IPC.TEMPLATE_SET_FILE]: proxied('invoke', ['PUT /templates/:id/files']),
  [IPC.TEMPLATE_ADD_FILES]: proxied('invoke', ['PUT /templates/:id/files/raw'], {
    note: 'Native multi-select dialog in Studio main; Studio reads the picked files locally and uploads each (octet-stream, up to 25 MiB).',
  }),
  [IPC.TEMPLATE_REMOVE_FILE]: proxied('invoke', ['DELETE /templates/:id/files']),
  [IPC.TEMPLATE_CHECK_REVIEW]: proxied('invoke', ['GET /templates/:id/review']),
  [IPC.TEMPLATE_REVIEW_ACCEPT]: proxied('invoke', ['POST /templates/:id/review/accept']),

  // --- Tracked directories ---------------------------------------------------
  [IPC.TRACKED_DIRS_GET]: proxied('invoke', ['GET /tracked-dirs']),
  [IPC.TRACKED_DIRS_ADD]: variant('invoke', ['POST /tracked-dirs'], REMOTE_FOLDER_PICKER, { note: 'Native folder dialog in Studio main.' }),
  [IPC.TRACKED_DIRS_REMOVE]: proxied('invoke', ['DELETE /tracked-dirs']),
  [IPC.TRACKED_DIRS_SCAN]: proxied('invoke', ['GET /tracked-dirs/tree']),
  [IPC.TRACKED_DIRS_CHANGED]: proxied('push', [], { frame: 'push:tracked_dirs', gaps: [streamTopic('tracked_dirs')] }),

  // --- Mesh ------------------------------------------------------------------
  [IPC.MESH_ENABLE]: proxied('invoke', ['POST /network/mesh/enable']),
  [IPC.MESH_DISABLE]: proxied('invoke', ['POST /network/mesh/disable']),
  [IPC.MESH_STATUS]: proxied('invoke', ['GET /fleet/mesh']),
  [IPC.MESH_EVENT]: proxied('push', [], {
    frame: 'push:mesh',
    gaps: [streamTopic('mesh'), gap('W2-B', 'station:<adapter> message_routed events on adapter inbound (notifyStationInbound)')],
  }),
  [IPC.MESH_DEBUG]: local('none', 'Defined in IPC; never registered, sent or exposed in preload.'),
  [IPC.MESH_GET_RECENT_TOOLS]: proxied('invoke', ['GET /fleet/recent-tools']),
  [IPC.MESH_PENDING_INTERACTIONS]: proxied('invoke', ['GET /approvals/interactions'], { note: 'No Studio renderer consumer (ipc/index.ts:5899).' }),
  [IPC.MESH_FLEET_STATUS]: proxied('invoke', ['GET /fleet/status']),
  [IPC.MESH_TOKEN_BURN]: proxied('invoke', ['GET /fleet/burn', 'POST /fleet/burn/hydrate'], { note: BURN_HYDRATE }),
  [IPC.MESH_MAP_POLL]: proxied('invoke', ['GET /fleet/map', 'POST /fleet/burn/hydrate'], { note: BURN_HYDRATE }),
  [IPC.MESH_MESSAGE_AGENTS]: proxied('invoke', ['POST /fleet/message']),
  [IPC.MESH_SET_AGENT_STATE]: proxied('invoke', ['POST /agents/:id/state']),
  [IPC.MESH_FOUND_AGENT]: proxied('invoke', ['POST /agents/create', 'GET /settings/:key'], {
    note: 'Studio main checks the destination against trackedDirectories (newRoot: sibling of a tracked root) and slugs the file name.',
  }),

  // --- Background agents -----------------------------------------------------
  [IPC.BACKGROUND_AGENT_START]: proxied('invoke', ['GET /files/agent', 'POST /agents/load', 'POST /agents/:id/start'], {
    gaps: [...RECIPE],
    note: 'Foreground, review and password gates from GET /files/agent (reviewed, passwordProtected), then load with requireReview: true and start (the startup turn). A file this session unlocked passes the password gate: its key stays in the daemon while the session holds it.',
  }),
  [IPC.BACKGROUND_AGENT_EVENT_BATCH]: proxied('push', [], {
    frame: 'executor',
    gaps: [gap('W2-B', 'executor and host frames for every agent')],
    note: 'Non-focused agents: frames go through background-event-mapping.ts (W1-F) and BackgroundEventBatcher (W2-C). Also fed by host frames.',
  }),
  [IPC.BACKGROUND_AGENT_STATUS]: proxied('invoke', ['GET /agents', 'GET /agents/:id/status'], { gaps: [gap('W2-B', 'in-flight starts (embedded `starting`): host frames agent_starting / agent_start_failed (GET /agents lists loaded agents only)')] }),
  [IPC.BACKGROUND_AGENT_STOP]: proxied('invoke', ['POST /agents/:id/stop']),
  [IPC.BACKGROUND_AGENT_ASK_RESPOND]: proxied('invoke', ['POST /agents/:id/asks/:requestId/respond']),
  [IPC.BACKGROUND_AGENT_TOOL_APPROVAL_RESPOND]: proxied('invoke', ['POST /agents/:id/tasks/:taskId/resolve']),
  [IPC.BACKGROUND_AGENT_ALWAYS_APPROVE]: proxied('invoke', ['POST /agents/:id/tasks/:taskId/always-approve']),

  // --- Directory bulk operations ---------------------------------------------
  [IPC.DIRECTORY_START_ALL]: proxied('invoke', ['POST /agents/load', 'GET /fs/browse'], {
    note: 'The .adf files directly in dirPath (not recursive), skipping the open file, with requireReview: false.',
  }),
  [IPC.DIRECTORY_STOP_ALL]: proxied('invoke', ['POST /agents/:id/stop', 'GET /fs/browse']),

  // --- Tools and token usage -------------------------------------------------
  [IPC.TOOLS_DESCRIPTIONS]: proxied('invoke', ['GET /runtime/tools/descriptions', 'GET /agents/:id/tools'], {
    note: 'The handler folds the open agent\'s own tools (GET /agents/:id/tools, those with a schema) into the route\'s built-in and stubbed runtime tools, in provider format; a built-in wins a name clash.',
  }),
  [IPC.TOKEN_USAGE_GET]: proxied('invoke', ['GET /runtime/usage']),
  [IPC.TOKEN_USAGE_CLEAR]: proxied('invoke', ['DELETE /runtime/usage']),
  [IPC.TOKEN_USAGE_EXPORT]: local('invoke', 'Save dialog; writes the JSON string the renderer passes.'),
  [IPC.TOKEN_COUNT]: proxied('invoke', ['POST /runtime/token-count'], { note: 'Provider and model default to the open agent config (session).' }),
  [IPC.TOKEN_COUNT_BATCH]: proxied('invoke', ['POST /runtime/token-count/batch']),
  [IPC.CONTEXT_BREAKDOWN_GET]: proxied('invoke', ['GET /agents/:id/context']),

  // --- Home dashboard --------------------------------------------------------
  [IPC.DASHBOARD_QUICK_STATS]: proxied('invoke', ['GET /dashboard/quick-stats']),
  [IPC.DASHBOARD_PROVIDER_TESTS]: proxied('invoke', ['GET /dashboard/provider-tests']),
  [IPC.DASHBOARD_CONTAINERS]: proxied('invoke', ['GET /compute/containers', 'GET /compute/status']),
  [IPC.DASHBOARD_AGENT_STATS]: proxied('invoke', ['GET /dashboard/agent-stats']),

  // --- Timers ----------------------------------------------------------------
  [IPC.DOC_GET_TIMERS]: proxied('invoke', ['GET /agents/:id/timers']),
  [IPC.DOC_ADD_TIMER]: proxied('invoke', ['POST /agents/:id/timers'], { note: 'The daemon validates `loop` against the declared loops (requireLoopName, runtime-service.ts:1446).' }),
  [IPC.DOC_UPDATE_TIMER]: proxied('invoke', ['PUT /agents/:id/timers/:timerId']),
  [IPC.DOC_DELETE_TIMER]: proxied('invoke', ['DELETE /agents/:id/timers/:timerId']),

  // --- Internal files --------------------------------------------------------
  [IPC.DOC_GET_FILES]: proxied('invoke', ['GET /agents/:id/files']),
  [IPC.DOC_UPLOAD_FILE]: proxied('invoke', ['PUT /agents/:id/files/raw'], { note: 'unique=true names the file as writeFileBufferUnique does.' }),
  [IPC.DOC_IMPORT_PATHS]: proxied('invoke', ['PUT /agents/:id/files/raw'], {
    note: 'The dropped paths are on the Studio machine: Studio main reads them (directories recurse) and uploads.',
  }),
  [IPC.DOC_PICK_AND_IMPORT]: proxied('invoke', ['PUT /agents/:id/files/raw'], { note: 'Native picker and file reads in Studio main, then upload.' }),
  [IPC.DOC_DELETE_INTERNAL_FILE]: proxied('invoke', ['DELETE /agents/:id/files/content']),
  [IPC.DOC_RENAME_INTERNAL_FILE]: proxied('invoke', ['POST /agents/:id/files/rename']),
  [IPC.DOC_RENAME_FOLDER]: proxied('invoke', ['POST /agents/:id/files/rename-folder']),
  [IPC.DOC_SET_FILE_PROTECTION]: proxied('invoke', ['PATCH /agents/:id/files/protection']),
  [IPC.DOC_SET_FILE_AUTHORIZED]: proxied('invoke', ['PATCH /agents/:id/files/authorized']),
  [IPC.DOC_READ_INTERNAL_FILE]: proxied('invoke', ['GET /agents/:id/files/meta', 'GET /agents/:id/files/raw']),
  [IPC.DOC_WRITE_INTERNAL_FILE]: proxied('invoke', ['PUT /agents/:id/files/content']),
  [IPC.DOC_DOWNLOAD_INTERNAL_FILE]: proxied('invoke', ['GET /agents/:id/files/raw'], { note: 'Save dialog and the write stay in Studio main.' }),

  // --- Meta, logs, tasks, local tables ---------------------------------------
  [IPC.DOC_GET_ALL_META]: proxied('invoke', ['GET /agents/:id/meta']),
  [IPC.DOC_SET_META]: proxied('invoke', ['PUT /agents/:id/meta/:key']),
  [IPC.DOC_DELETE_META]: proxied('invoke', ['DELETE /agents/:id/meta/:key']),
  [IPC.DOC_SET_META_PROTECTION]: proxied('invoke', ['PATCH /agents/:id/meta/:key/protection']),
  [IPC.DOC_GET_LOGS]: proxied('invoke', ['GET /agents/:id/logs']),
  [IPC.DOC_GET_LOGS_AFTER]: proxied('invoke', ['GET /agents/:id/logs/after']),
  [IPC.DOC_CLEAR_LOGS]: proxied('invoke', ['DELETE /agents/:id/logs']),
  [IPC.DOC_GET_TASKS]: proxied('invoke', ['GET /agents/:id/tasks']),
  [IPC.DOC_LIST_LOCAL_TABLES]: proxied('invoke', ['GET /agents/:id/tables']),
  [IPC.DOC_QUERY_LOCAL_TABLE]: proxied('invoke', ['GET /agents/:id/tables/:table'], { note: 'Accepts local_* tables and adf_audit, as the daemon does (runtime-service.ts:2659).' }),
  [IPC.DOC_DROP_LOCAL_TABLE]: proxied('invoke', ['DELETE /agents/:id/tables/:table']),

  // --- Workspace pushes ------------------------------------------------------
  [IPC.INBOX_UPDATED]: proxied('push', [], { frame: 'push:inbox', gaps: [streamTopic('inbox')], note: 'Open file only.' }),
  [IPC.WORKSPACE_DATA_CHANGED]: proxied('push', [], { frame: 'push:workspace_data', gaps: [streamTopic('workspace_data')], note: 'Open file only; coalesced per scope (250 ms).' }),

  // --- MCP -------------------------------------------------------------------
  [IPC.MCP_PROBE_SERVER]: proxied('invoke', ['POST /admin/mcp/probe']),
  [IPC.MCP_REGISTRATION_TEST]: variant('invoke', ['POST /admin/mcp/registration-test', 'GET /jobs/:jobId', 'POST /jobs/:jobId/cancel', 'GET /admin/mcp/interactions', 'POST /admin/mcp/interactions/:interactionId/continue'], 'OAuth remotes: Studio main runs the loopback callback and relays the code (§9.3).', {
    note: 'Starts a job and polls GET /jobs/:jobId. Meanwhile polls GET /admin/mcp/interactions?jobId=: opens each open_url step with shell.openExternal, shows the native Continue dialog for each confirm step, and answers with …/continue.',
  }),
  [IPC.MCP_INSTALL_PACKAGE]: proxied('invoke', ['POST /admin/mcp/packages/npm'], { note: 'Progress arrives as MCP_INSTALL_PROGRESS.' }),
  [IPC.MCP_UNINSTALL_PACKAGE]: proxied('invoke', ['DELETE /admin/mcp/packages/npm']),
  [IPC.MCP_LIST_INSTALLED]: proxied('invoke', ['GET /admin/mcp/packages']),
  [IPC.MCP_GET_SERVER_STATUS]: proxied('invoke', ['GET /agents/:id/runtime/mcp'], { note: 'Open agent only.' }),
  [IPC.MCP_RESTART_SERVER]: proxied('invoke', ['POST /agents/:id/mcp/servers/:serverName/restart']),
  [IPC.MCP_GET_SERVER_LOGS]: proxied('invoke', ['GET /admin/mcp/logs/:serverName'], { note: 'Passes the open agent as agentId (session) for its live logs; without one the daemon answers the logs it kept from probe, test and agent runs.' }),
  [IPC.MCP_INSTALL_PROGRESS]: proxied('push', [], { frame: 'push:mcp_install', gaps: [gap('W2-B', 'client-stream push topic `mcp_install`, fed by progress callbacks in the install routes')] }),
  [IPC.MCP_SERVER_STATUS_CHANGED]: proxied('push', [], { frame: 'push:mcp_status', gaps: [streamTopic('mcp_status')], note: 'Open file only.' }),
  [IPC.MCP_CREDENTIAL_SET]: proxied('invoke', ['PUT /agents/:id/mcp/credentials', 'PUT /files/agent/mcp/credentials'], { note: 'Refuses plaintext when the credentials envelope is locked or foreign.' }),
  [IPC.MCP_CREDENTIAL_GET]: proxied('invoke', ['GET /agents/:id/mcp/credentials', 'GET /files/agent/mcp/credentials']),
  [IPC.MCP_CREDENTIAL_LIST_FILES]: proxied('invoke', ['GET /credentials/mcp/files']),
  [IPC.MCP_ATTACH_SERVER]: proxied('invoke', ['POST /agents/:id/mcp/servers', 'POST /files/agent/mcp/servers']),
  [IPC.MCP_DETACH_SERVER]: proxied('invoke', ['DELETE /agents/:id/mcp/servers/:serverName', 'DELETE /files/agent/mcp/servers/:serverName']),
  [IPC.MCP_PICK_ADF_FILE]: variant('invoke', [], REMOTE_FILE_PICKER, { note: 'Native open dialog in Studio main.' }),
  [IPC.MCP_INSTALL_PYTHON_PACKAGE]: proxied('invoke', ['POST /admin/mcp/packages/python']),
  [IPC.MCP_UNINSTALL_PYTHON_PACKAGE]: proxied('invoke', ['DELETE /admin/mcp/packages/python']),
  [IPC.MCP_ENSURE_PYTHON_RUNTIME]: proxied('invoke', ['POST /admin/mcp/python-runtime', 'GET /jobs/:jobId'], { note: 'Starts a job and polls GET /jobs/:jobId.' }),
  [IPC.MCP_REGISTRY_GET]: proxied('invoke', ['GET /registry/mcp']),

  // --- Agent registry --------------------------------------------------------
  [IPC.AGENT_REGISTRY_GET]: proxied('invoke', ['GET /registry/agents']),
  [IPC.AGENT_REGISTRY_REFRESH]: proxied('invoke', ['POST /registry/agents/refresh']),
  [IPC.AGENT_REGISTRY_BRING_HOME]: proxied('invoke', ['POST /registry/agents/:id/bring-home'], {
    gaps: [gap('W2-B', 'push adf_file_created for the brought-home file')],
    note: 'The handler records the client key recentFiles.',
  }),
  [IPC.AGENT_MODEL_SET_FOR_FILE]: proxied('invoke', ['PUT /agents/:id/config', 'PUT /files/agent/model'], { note: 'Refused for the open file and for a running agent.' }),
  [IPC.MCP_OAUTH_SIGNOUT]: proxied('invoke', ['POST /admin/mcp/oauth/signout'], { gaps: [gap('W1-C', 'DaemonAppOAuthStore')] }),
  [IPC.MCP_OAUTH_STATUS]: proxied('invoke', ['GET /admin/mcp/oauth/status'], { gaps: [gap('W1-C', 'DaemonAppOAuthStore')] }),

  // --- Skill catalogs --------------------------------------------------------
  [IPC.SKILLS_CATALOG_GET]: proxied('invoke', ['GET /catalog/skills'], {
    note: 'Network read only. Not Electron-only (D2), and the terminal app reads the same catalogs.',
  }),
  [IPC.SKILLS_PACKAGE_GET]: proxied('invoke', ['GET /catalog/skills/package']),

  // --- Compute ---------------------------------------------------------------
  [IPC.COMPUTE_STATUS]: proxied('invoke', ['GET /compute/status']),
  [IPC.COMPUTE_INIT]: proxied('invoke', ['POST /compute/start']),
  [IPC.COMPUTE_STOP]: proxied('invoke', ['POST /compute/stop']),
  [IPC.COMPUTE_DESTROY]: proxied('invoke', ['POST /compute/destroy']),
  [IPC.COMPUTE_LIST_CONTAINERS]: proxied('invoke', ['GET /compute/containers']),
  [IPC.COMPUTE_STOP_CONTAINER]: proxied('invoke', ['POST /compute/containers/:name/stop']),
  [IPC.COMPUTE_START_CONTAINER]: proxied('invoke', ['POST /compute/containers/:name/start']),
  [IPC.COMPUTE_DESTROY_CONTAINER]: proxied('invoke', ['POST /compute/containers/:name/destroy']),
  [IPC.COMPUTE_REBUILD_CONTAINER]: proxied('invoke', ['POST /compute/containers/:name/rebuild']),
  [IPC.COMPUTE_SETUP]: proxied('invoke', ['POST /compute/setup']),
  [IPC.COMPUTE_CONTAINER_DETAIL]: proxied('invoke', ['GET /compute/containers/:name']),
  [IPC.COMPUTE_EXEC_LOG]: proxied('invoke', ['GET /compute/exec-log']),
  [IPC.COMPUTE_TEST_EXECUTION_TARGET]: proxied('invoke', ['POST /compute/execution-targets/test']),
  [IPC.COMPUTE_BROWSER_SESSION]: unsupported('push', [], 'Unsupported in v1: the noVNC URL is the server\'s loopback (§9.3).', {
    frame: 'push:browser_session',
    gaps: [streamTopic('browser_session')],
  }),
  [IPC.COMPUTE_BROWSER_INFO]: unsupported('invoke', ['GET /compute/browser-info'], 'Unsupported in v1: the noVNC port is on the server\'s loopback (§9.3).'),
  [IPC.COMPUTE_CONTAINER_PHASE]: proxied('push', [], { frame: 'push:compute_phase', gaps: [streamTopic('compute_phase')] }),

  // --- Sandbox packages ------------------------------------------------------
  [IPC.SANDBOX_CHECK_MISSING]: proxied('invoke', ['POST /admin/sandbox/packages/check']),
  [IPC.SANDBOX_INSTALL_PACKAGES]: proxied('invoke', ['POST /admin/sandbox/packages'], { note: 'One route call per package; progress arrives as SANDBOX_INSTALL_PROGRESS.' }),
  [IPC.SANDBOX_INSTALL_PROGRESS]: proxied('push', [], { frame: 'push:sandbox_install', gaps: [gap('W2-B', 'client-stream push topic `sandbox_install`, fed by progress callbacks in the install route')] }),
  [IPC.SANDBOX_LIST_INSTALLED]: proxied('invoke', ['GET /admin/sandbox/packages']),

  // --- Identity / keystore (per agent) ---------------------------------------
  [IPC.IDENTITY_SET]: proxied('invoke', ['PUT /agents/:id/identity/:purpose'], { note: 'The derived key of a password-protected file lives in the daemon (§5.4).' }),
  [IPC.IDENTITY_GET]: proxied('invoke', ['GET /agents/:id/identity/:purpose']),
  [IPC.IDENTITY_DELETE]: proxied('invoke', ['DELETE /agents/:id/identity/:purpose']),
  [IPC.IDENTITY_DELETE_PREFIX]: proxied('invoke', ['DELETE /agents/:id/identity-prefix']),
  [IPC.IDENTITY_LIST]: proxied('invoke', ['GET /agents/:id/identity']),
  [IPC.IDENTITY_PASSWORD_CHECK]: proxied('invoke', ['GET /agents/:id/identity/password']),
  [IPC.IDENTITY_PASSWORD_UNLOCK]: proxied('invoke', ['POST /agents/:id/identity/password/unlock'], {
    gaps: [
      gap('W1-B', 'the derived key reaches provider, MCP, adapters and AdfCallHandler; restart after unlock'),
      gap('W1-C', 'unlock converts the owner\'s own legacy whole-file password to envelopes, keeps the password as a share slot, and returns converted'),
    ],
  }),
  [IPC.IDENTITY_PASSWORD_SET]: local('invoke', 'Deprecated: always refuses. The daemon-mode handler returns the same refusal and MUST NOT call PUT /agents/:id/identity/password.'),
  [IPC.IDENTITY_PASSWORD_REMOVE]: proxied('invoke', ['DELETE /agents/:id/identity/password']),
  [IPC.IDENTITY_PASSWORD_CHANGE]: local('invoke', 'Deprecated: always refuses. The daemon-mode handler returns the same refusal.'),
  [IPC.IDENTITY_LIST_ENTRIES]: proxied('invoke', ['GET /agents/:id/identity/entries']),
  [IPC.IDENTITY_REVEAL]: proxied('invoke', ['GET /agents/:id/identity/:purpose']),
  [IPC.IDENTITY_WIPE_ALL]: proxied('invoke', ['POST /agents/:id/identity/wipe']),
  [IPC.IDENTITY_GET_DID]: proxied('invoke', ['GET /agents/:id/identity/did']),
  [IPC.IDENTITY_GENERATE_KEYS]: proxied('invoke', ['POST /agents/:id/identity/generate-keys'], { note: 'The daemon issues owner and operator attestations too (runtime-service.ts:1879).' }),
  [IPC.IDENTITY_CLAIM]: proxied('invoke', ['POST /agents/:id/claim']),
  [IPC.IDENTITY_SET_CODE_ACCESS]: proxied('invoke', ['PATCH /agents/:id/identity/:purpose/code-access']),

  // --- Owner identity --------------------------------------------------------
  [IPC.IDENTITY_OWNER_STATUS]: proxied('invoke', ['GET /identity'], { note: 'Mapped to the Studio status shape (§5.4).' }),
  [IPC.IDENTITY_OWNER_REVEAL_MNEMONIC]: unsupported('invoke', [], 'Not available; Studio says so (§5.4).', {
    note: 'Local mode: Studio main reads the shared keychain entry (SharedMnemonicStore). No route carries the phrase.',
  }),
  [IPC.IDENTITY_OWNER_CONFIRM_BACKUP]: unsupported('invoke', ['POST /identity/confirm-backup'], 'Refused by the daemon (local-only route); Studio shows its message.'),
  [IPC.IDENTITY_OWNER_IMPORT]: unsupported('invoke', [], 'Refused by the daemon (local-only route); Studio shows its message.', {
    gaps: [gap('W1-C', 'POST /identity/import (local-only): importMnemonic, restamp, reload loaded agents')],
  }),
  [IPC.IDENTITY_ATTESTATIONS_GET]: proxied('invoke', ['GET /agents/:id/attestations']),
  [IPC.IDENTITY_ATTESTATIONS_REISSUE]: proxied('invoke', ['POST /agents/:id/attestations/reissue']),

  // --- Envelope keystore -----------------------------------------------------
  [IPC.IDENTITY_ENVELOPE_STATUS]: proxied('invoke', ['GET /agents/:id/envelope']),
  [IPC.IDENTITY_ENVELOPE_SHARE_SET_PASSWORD]: proxied('invoke', ['PUT /agents/:id/envelope/share-password']),
  [IPC.IDENTITY_ENVELOPE_SHARE_REMOVE_PASSWORD]: proxied('invoke', ['DELETE /agents/:id/envelope/share-password']),
  [IPC.IDENTITY_ENVELOPE_UNLOCK_PASSWORD]: proxied('invoke', ['POST /agents/:id/envelope/unlock-password']),

  // --- Channel adapters ------------------------------------------------------
  [IPC.ADAPTER_INSTALL_PACKAGE]: proxied('invoke', ['POST /admin/adapters/packages'], { note: 'Progress arrives as ADAPTER_INSTALL_PROGRESS.' }),
  [IPC.ADAPTER_UNINSTALL_PACKAGE]: proxied('invoke', ['DELETE /admin/adapters/packages', 'PATCH /settings'], {
    note: 'The handler then removes the registration from settings.adapters with PATCH /settings; the route does not.',
  }),
  [IPC.ADAPTER_LIST_INSTALLED]: proxied('invoke', ['GET /admin/adapters/packages']),
  [IPC.ADAPTER_GET_STATUS]: proxied('invoke', ['GET /fleet/adapters']),
  [IPC.ADAPTER_RESTART]: proxied('invoke', ['POST /fleet/adapters/restart']),
  [IPC.ADAPTER_GET_LOGS]: proxied('invoke', ['GET /agents/:id/runtime/adapters'], { note: 'Logs ride in states[].' }),
  [IPC.ADAPTER_INSTALL_PROGRESS]: proxied('push', [], { frame: 'push:adapter_install', gaps: [gap('W2-B', 'client-stream push topic `adapter_install`, fed by progress callbacks in the install route')] }),
  [IPC.ADAPTER_STATUS_CHANGED]: proxied('push', [], { frame: 'push:adapter_status', gaps: [streamTopic('adapter_status')], note: 'Open file only.' }),
  [IPC.ADAPTER_CREDENTIAL_SET]: proxied('invoke', ['PUT /agents/:id/adapters/credentials', 'PUT /files/agent/adapters/credentials']),
  [IPC.ADAPTER_CREDENTIAL_GET]: proxied('invoke', ['GET /agents/:id/adapters/credentials', 'GET /files/agent/adapters/credentials'], { note: 'storedKeys lists rows it cannot decrypt.' }),
  [IPC.ADAPTER_CREDENTIAL_LIST_FILES]: proxied('invoke', ['GET /credentials/adapters/files']),
  [IPC.ADAPTER_ATTACH]: proxied('invoke', ['POST /agents/:id/adapters', 'POST /files/agent/adapters']),
  [IPC.ADAPTER_DETACH]: proxied('invoke', ['DELETE /agents/:id/adapters/:adapterType', 'DELETE /files/agent/adapters/:adapterType']),

  // --- Provider credentials (per agent) --------------------------------------
  [IPC.PROVIDER_CREDENTIAL_SET]: proxied('invoke', ['PUT /agents/:id/providers/:providerId/credential', 'PUT /files/agent/providers/:providerId/credential']),
  [IPC.PROVIDER_CREDENTIAL_GET]: proxied('invoke', ['GET /agents/:id/providers/:providerId/credentials', 'GET /files/agent/providers/:providerId/credentials']),
  [IPC.PROVIDER_CREDENTIAL_LIST_FILES]: proxied('invoke', ['GET /credentials/providers/files']),
  [IPC.PROVIDER_ATTACH]: proxied('invoke', ['POST /agents/:id/providers', 'POST /files/agent/providers']),
  [IPC.PROVIDER_DETACH]: proxied('invoke', ['DELETE /agents/:id/providers/:providerId', 'DELETE /files/agent/providers/:providerId']),
  [IPC.PROVIDER_AGENT_KEY_SOURCES]: proxied('invoke', ['POST /credentials/providers/key-sources']),
  [IPC.PROVIDER_TEST]: proxied('invoke', ['POST /runtime/providers/:id/test']),

  // --- Subscription sign-in --------------------------------------------------
  [IPC.CHATGPT_AUTH_START]: variant('invoke', ['POST /auth/chatgpt/start', 'POST /auth/chatgpt/complete'], 'Relay mode: Studio main runs the loopback callback and posts the code to POST /auth/chatgpt/complete.', {
    note: 'Local mode: loopback mode; Studio main opens authUrl (the daemon opens no browser).',
  }),
  [IPC.CHATGPT_AUTH_STATUS]: proxied('invoke', ['GET /auth/chatgpt/status']),
  [IPC.CHATGPT_AUTH_LOGOUT]: proxied('invoke', ['POST /auth/chatgpt/logout']),
  [IPC.GROK_AUTH_START]: proxied('invoke', ['POST /auth/grok/start'], { note: 'Device-code flow; works across machines.' }),
  [IPC.GROK_AUTH_STATUS]: proxied('invoke', ['GET /auth/grok/status']),
  [IPC.GROK_AUTH_LOGOUT]: proxied('invoke', ['POST /auth/grok/logout']),
  [IPC.CLAUDE_AUTH_START]: proxied('invoke', ['POST /auth/claude/start'], { note: 'Claude Code on the daemon host opens its own browser; `url` plus CLAUDE_AUTH_SUBMIT_CODE is the remote path.' }),
  [IPC.CLAUDE_AUTH_STATUS]: proxied('invoke', ['GET /auth/claude/status']),
  [IPC.CLAUDE_AUTH_SUBMIT_CODE]: proxied('invoke', ['POST /auth/claude/code']),
  [IPC.CLAUDE_AUTH_CANCEL]: proxied('invoke', ['POST /auth/claude/cancel']),
  [IPC.CLAUDE_AUTH_LOGOUT]: proxied('invoke', ['POST /auth/claude/logout']),

  // --- Mesh HTTP server, discovery, firewall ---------------------------------
  [IPC.MESH_SERVER_STATUS]: proxied('invoke', ['GET /network/server']),
  [IPC.MESH_SERVER_RESTART]: proxied('invoke', ['POST /network/server/restart']),
  [IPC.MESH_SERVER_START]: proxied('invoke', ['POST /network/server/start']),
  [IPC.MESH_SERVER_STOP]: proxied('invoke', ['POST /network/server/stop']),
  [IPC.MESH_SERVER_LAN_IPS]: proxied('invoke', ['GET /network/mesh/lan-addresses']),
  [IPC.MESH_DISCOVERED_RUNTIMES]: proxied('invoke', ['GET /network/mesh/discovered-runtimes'], {
    gaps: [gap('W1-B', 'mDNS and tailnet discovery in the daemon (the route returns [], daemon/index.ts:343), with directory cards, /ping meta and trust decoration')],
  }),
  [IPC.MESH_PEER_SHARED_FILE]: proxied('invoke', ['GET /network/peers/shared-file'], {
    note: 'Network read; proxied so it runs on the host that discovered the peer (in remote mode, the server\'s network).',
  }),
  [IPC.MESH_PEER_AGENT_HEALTH]: proxied('invoke', ['GET /network/peers/health']),
  [IPC.MESH_FIREWALL_CHECK]: local('invoke', 'The port and LAN binding come from the daemon mesh server, not from Studio main.', {
    reads: ['GET /network/server'],
    remote: 'Hidden: the firewall is the laptop\'s, the mesh server is the server\'s (§9.3).',
  }),
  [IPC.MESH_FIREWALL_APPLY]: local('invoke', 'Elevation prompt from Studio; the port comes from the daemon mesh server.', {
    reads: ['GET /network/server'],
    remote: 'Hidden, as MESH_FIREWALL_CHECK.',
  }),

  // --- Agent review ----------------------------------------------------------
  [IPC.FILE_CHECK_REVIEW]: proxied('invoke', ['GET /agents/review']),
  [IPC.FILE_REVIEW_ACCEPT]: proxied('invoke', ['POST /agents/review/accept', 'POST /files/relocate'], { note: 'An untracked file moves into the agents folder after the accept (POST /files/relocate), as persistAcceptedAgent.' }),

  // --- Open file request, dialogs, app ---------------------------------------
  [IPC.OPEN_FILE_REQUEST]: local('push', 'Finder / menu / second-instance open; the renderer then calls FILE_OPEN.'),
  [IPC.OPEN_FILE_GET_PENDING]: local('invoke', 'Registered in main/index.ts.'),
  [IPC.DIALOG_PICK_DIRECTORY]: variant('invoke', [], REMOTE_FOLDER_PICKER, { note: 'Picks agentsFolder and the home composer folder, both paths on the backend host.' }),
  [IPC.MENU_ACTION]: local('push'),
  [IPC.APP_SHUTTING_DOWN]: local('push'),
  [IPC.APP_GET_VERSION]: local('invoke', 'Studio version; the daemon version is GET /version (W0-D).'),
  [IPC.APP_GET_FULLSCREEN]: local('invoke', 'Registered in main/index.ts.'),
  [IPC.APP_SET_FULLSCREEN]: local('invoke', 'Registered in main/index.ts.'),
  [IPC.APP_SET_BADGE_COUNT]: local('invoke'),
  [IPC.APP_FULLSCREEN_CHANGED]: local('push'),
  [IPC.APP_UPDATE_STATE]: local('push', 'Reads the client key updateChecksEnabled.'),
  [IPC.APP_UPDATE_GET_STATE]: local('invoke', 'Registered in services/app-updater.service.ts.'),
  [IPC.APP_UPDATE_CHECK]: local('invoke', 'Registered in services/app-updater.service.ts.'),
  [IPC.APP_UPDATE_DOWNLOAD]: local('invoke', 'Registered in services/app-updater.service.ts.'),
  [IPC.APP_UPDATE_INSTALL]: local('invoke', 'Registered in services/app-updater.service.ts.'),
  [IPC.SPELLCHECK_DOWNLOAD]: local('invoke', 'Registered in services/spellcheck-dictionaries.service.ts; writes the client key spellcheckDownloadsEnabled.'),
  [IPC.ORBITAL_CACHE_GET]: local('invoke', 'Registered in ipc/orbital-cache.ts; cache under Studio userData.'),
  [IPC.ORBITAL_CACHE_PUT]: local('invoke', 'Registered in ipc/orbital-cache.ts; cache under Studio userData.'),

  // --- Settings → Backend (W0-E) --------------------------------------------
  [IPC.BACKEND_SETTINGS_GET]: local('invoke', 'Registered in backend/backend-settings-ipc.ts in both modes; reads studio-backend.json.'),
  [IPC.BACKEND_SETTINGS_SET]: local('invoke', 'Registered in backend/backend-settings-ipc.ts in both modes; writes studio-backend.json (token as safe:).'),

  // --- Overview, emergency stop, identity drafts -----------------------------
  [IPC.AGENT_VITALS]: proxied('invoke', ['GET /agents/:id/vitals']),
  [IPC.AGENT_ACTIVITY]: proxied('invoke', ['GET /agents/:id/activity']),
  [IPC.EMERGENCY_STOP]: proxied('invoke', ['POST /runtime/emergency-stop'], { note: 'A partial stop answers success: false with the skipped and failed parts; the handler shows them.' }),
  [IPC.IDENTITY_DRAFT_MINT]: proxied('invoke', ['POST /identity/drafts']),
  [IPC.IDENTITY_DRAFT_DISCARD]: proxied('invoke', ['DELETE /identity/drafts/:draftId'], { note: 'Unwraps { discarded }.' }),

  // --- Raw string channels ---------------------------------------------------
  'stdlib-install-progress': local('push', 'Dead push: no preload or renderer listener. Daemon mode sends nothing.'),
} satisfies Record<MappedChannel, ChannelEntry>

export function channelEntry(channel: MappedChannel): ChannelEntry {
  return CHANNEL_MAP[channel]
}

/** Every gap in the map, one row per (channel, gap). */
export function listChannelGaps(): Array<{ channel: MappedChannel; ws: GapWorkstream; need: string }> {
  const rows: Array<{ channel: MappedChannel; ws: GapWorkstream; need: string }> = []
  for (const [channel, entry] of Object.entries(CHANNEL_MAP) as Array<[MappedChannel, ChannelEntry]>) {
    for (const g of entry.gaps) rows.push({ channel, ws: g.ws, need: g.need })
  }
  return rows
}
