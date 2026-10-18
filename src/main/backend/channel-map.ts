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

/** Lifetime burn totals live in the client key fleetMapState.burnTotals (§4.1). */
const BURN_HYDRATE = 'Once per session, POST /fleet/burn/hydrate with the client key fleetMapState.burnTotals.'

const REMOTE_FOLDER_PICKER = 'Daemon-side folder picker (remote/picker.ts: REMOTE_PICKER_REQUEST to the renderer, which lists GET /fs/browse); the native dialog would pick a path on the laptop.'
const REMOTE_FILE_PICKER = 'Daemon-side .adf picker (remote/picker.ts over GET /fs/browse); the native dialog would pick a path on the laptop.'

export const CHANNEL_MAP = {
  // --- File operations -------------------------------------------------------
  [IPC.FILE_OPEN]: variant('invoke', ['POST /client/sessions/:id/documents', 'PUT /client/sessions/:id/focus', 'GET /agents/:id/identity/password', 'GET /agents/:id/status', 'GET /files/agent', 'POST /files/relocate', 'PATCH /settings', 'POST /files/import'], `${REMOTE_FILE_PICKER} A path the daemon does not have but this computer does (OS open, an old recent entry) is offered as an upload of a copy (POST /files/import) into a picked daemon folder; nothing is uploaded without the user's choice.`, {
    note: 'Native open dialog in Studio main; the handler records the client key recentFiles. A running agent is reattached, not reopened. Local mode: a reviewed file in the OS temp dir that is not loaded moves into the agents folder (GET /files/agent, POST /files/relocate).',
  }),
  [IPC.FILE_SAVE]: proxied('invoke', ['POST /agents/:id/checkpoint']),
  [IPC.FILE_CREATE]: variant('invoke', ['POST /agents/create', 'POST /client/sessions/:id/documents'], 'The save dialog would pick a laptop path: the daemon-side picker picks a folder on the daemon host and a name (remote/picker.ts, kind save-adf), asking before it replaces a file.', {
    note: 'Save dialog in Studio main, then create (directory + name). The created file becomes the open file, not running; the handler records recentFiles.',
  }),
  [IPC.FILE_CREATE_QUICK]: proxied('invoke', ['POST /agents/create', 'POST /client/sessions/:id/documents', 'GET /files/agents-folder'], {
    note: 'A typed name that exists is refused with code name_taken; the folder must exist and must not be under the OS temp dir.',
  }),
  [IPC.AGENTS_FOLDER_DEFAULT_GET]: proxied('invoke', ['GET /files/agents-folder']),
  [IPC.FILE_CLOSE]: proxied('invoke', ['DELETE /client/sessions/:id/documents/:agentId', 'PUT /client/sessions/:id/focus']),
  [IPC.FILE_DELETE]: proxied('invoke', ['DELETE /files']),
  [IPC.FILE_CLONE]: proxied('invoke', ['POST /files/clone']),
  [IPC.FILE_LIST_TABLES]: proxied('invoke', ['GET /files/agent/tables'], { note: 'Clone dialog.' }),
  [IPC.FILE_RENAME]: proxied('invoke', ['POST /files/rename']),
  [IPC.FILE_RENAMED]: proxied('push', [], { frame: 'push:file_renamed' }),
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
    note: 'The handler refuses a config whose id differs from the open file (session check). A running agent\'s deferred rename is read back from GET /files/agent pendingName.',
  }),
  [IPC.DOC_AGENT_CONFIG_CHANGED]: proxied('push', [], {
    frame: 'push:config_changed',
    note: 'Runtime-originated changes only, for the open file: requests carry X-ADF-Client-Session, so this window\'s own writes are not echoed.',
  }),
  [IPC.DOC_GET_CHAT]: proxied('invoke', ['GET /agents/:id/chat']),
  [IPC.DOC_GET_CHAT_OLDER]: proxied('invoke', ['GET /agents/:id/chat']),
  [IPC.DOC_SET_CHAT]: local('invoke', 'No-op stub that returns success; chat is written by the runtime only. No daemon call.'),
  [IPC.DOC_CLEAR_CHAT]: proxied('invoke', ['DELETE /agents/:id/chat']),
  [IPC.DOC_GET_INBOX]: proxied('invoke', ['GET /agents/:id/inbox']),
  [IPC.DOC_CLEAR_INBOX]: proxied('invoke', ['DELETE /agents/:id/inbox']),
  [IPC.DOC_GET_OUTBOX]: proxied('invoke', ['GET /agents/:id/outbox']),
  [IPC.DOC_GET_BATCH]: proxied('invoke', ['GET /agents/:id/batch']),
  [IPC.DOC_GET_HEADER]: proxied('invoke', ['GET /agents/:id/header']),

  // --- Agent runtime ---------------------------------------------------------
  [IPC.AGENT_START]: proxied('invoke', ['POST /agents/:id/start', 'GET /agents/:id/status', 'GET /agents/:id/triggers', 'GET /approvals/interactions', 'GET /agents/:id/identity/password', 'POST /agents/:id/stop', 'GET /agents/:id/config'], {
    note: 'The reuse path (agent already running) returns sessionId, the display state (GET /agents/:id/triggers), and main\'s pending approvals and asks (GET /approvals/interactions). A held document whose key is locked answers code credentials_locked without starting (design §6.1 row 27).',
  }),
  [IPC.AGENT_STOP]: proxied('invoke', ['POST /agents/:id/stop']),
  [IPC.AGENT_STATUS]: proxied('invoke', ['GET /agents/:id/status']),
  [IPC.AGENT_INVOKE]: proxied('invoke', ['POST /agents/:id/chat'], {
    note: 'filePath may name a background agent; loop selects the stream. Sent echoed: the sending session alone skips the turn\'s trigger_message.',
  }),
  [IPC.AGENT_COMPACT]: proxied('invoke', ['POST /agents/:id/compact']),
  [IPC.AGENT_EVENT]: proxied('push', [], {
    frame: 'executor',
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
    note: 'Sent to every window, not only the first (ipc/index.ts:1938).',
  }),
  [IPC.APPROVALS_GET_INPUT]: proxied('invoke', ['GET /approvals/input'], { note: 'Unwraps { input }; {} answers undefined.' }),
  [IPC.APPROVALS_REVEAL]: local('push', 'Studio native notifier and menu bar click. In daemon mode the notifier is fed from the approvals frames.'),
  [IPC.APPROVALS_GET_PENDING_REVEAL]: local('invoke', 'Reveal queued in Studio main for a loading renderer.'),

  [IPC.AGENT_ASK_RESPOND]: proxied('invoke', ['POST /agents/:id/asks/:requestId/respond']),
  [IPC.AGENT_SUSPEND_RESPOND]: proxied('invoke', ['POST /agents/:id/suspend/respond']),

  // --- Models and settings ---------------------------------------------------
  [IPC.MODELS_LIST]: proxied('invoke', ['GET /runtime/models'], { note: 'filePath goes to the route as filePath (an agent file\'s own provider); a path the route refuses is dropped and the app providers are listed.' }),
  [IPC.SETTINGS_GET]: proxied('invoke', ['GET /settings', 'POST /settings/providers/keys/reveal'], {
    note: 'Returns {...daemonSettings, ...clientSettings} (§4.2); provider apiKey arrives as __redacted__; local mode replaces it with the stored key through POST /settings/providers/keys/reveal (local proof); remote mode keeps the placeholder. Studio main runs the client-key migrations on studio-client-settings.json when it loads it (daemon-mode/settings.ts).' }),
  [IPC.SETTINGS_SET]: proxied('invoke', ['PATCH /settings'], {
    note: 'Split by settingsKeyClass(): client keys go to studio-client-settings.json, backend keys to the daemon. menuBarEnabled applies in Studio main.',
  }),

  // --- Agent templates -------------------------------------------------------
  [IPC.TEMPLATES_LIST]: proxied('invoke', ['GET /templates'], { note: 'Drop `migrated` when the client key templatesMigrationSeen is set.' }),
  [IPC.TEMPLATES_CHANGED]: proxied('push', [], { frame: 'push:templates' }),
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
  [IPC.TRACKED_DIRS_CHANGED]: proxied('push', [], { frame: 'push:tracked_dirs' }),

  // --- Mesh ------------------------------------------------------------------
  [IPC.MESH_ENABLE]: proxied('invoke', ['POST /network/mesh/enable']),
  [IPC.MESH_DISABLE]: proxied('invoke', ['POST /network/mesh/disable']),
  [IPC.MESH_STATUS]: proxied('invoke', ['GET /fleet/mesh']),
  [IPC.MESH_EVENT]: proxied('push', [], {
    frame: 'push:mesh',
  }),
  [IPC.MESH_DEBUG]: local('none', 'Defined in IPC; never registered, sent or exposed in preload.'),
  [IPC.MESH_GET_RECENT_TOOLS]: proxied('invoke', ['GET /fleet/recent-tools']),
  [IPC.MESH_PENDING_INTERACTIONS]: proxied('invoke', ['GET /approvals/interactions'], { note: 'No Studio renderer consumer (ipc/index.ts:5899).' }),
  [IPC.MESH_FLEET_STATUS]: proxied('invoke', ['GET /fleet/status']),
  [IPC.MESH_TOKEN_BURN]: proxied('invoke', ['GET /fleet/burn', 'POST /fleet/burn/hydrate'], { note: BURN_HYDRATE }),
  [IPC.MESH_MAP_POLL]: proxied('invoke', ['GET /fleet/map', 'POST /fleet/burn/hydrate'], { note: BURN_HYDRATE }),
  [IPC.MESH_MESSAGE_AGENTS]: proxied('invoke', ['POST /fleet/message']),
  [IPC.MESH_SET_AGENT_STATE]: proxied('invoke', ['POST /fleet/state']),
  [IPC.MESH_FOUND_AGENT]: proxied('invoke', ['POST /fleet/found'], {
    note: 'The route checks the destination against trackedDirectories (newRoot: sibling of a tracked root), creates the folder and slugs the file name.',
  }),

  // --- Background agents -----------------------------------------------------
  [IPC.BACKGROUND_AGENT_START]: proxied('invoke', ['GET /files/agent', 'POST /agents/load', 'POST /agents/:id/start'], {
    note: 'Foreground, review and password gates from GET /files/agent (reviewed, passwordProtected), then load with requireReview: true and start (the startup turn). A file this session unlocked passes the password gate: its key stays in the daemon while the session holds it.',
  }),
  [IPC.BACKGROUND_AGENT_EVENT_BATCH]: proxied('push', [], {
    frame: 'executor',
    note: 'Non-focused agents: frames go through background-event-mapping.ts (W1-F) and BackgroundEventBatcher (W2-C). Also fed by host frames.',
  }),
  [IPC.BACKGROUND_AGENT_STATUS]: proxied('invoke', ['GET /agents', 'GET /agents/:id/status'], { note: 'The `starting` list is the agents the bridge saw announced (agent_starting host frames) that GET /agents does not list yet.' }),
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
  [IPC.INBOX_UPDATED]: proxied('push', [], { frame: 'push:inbox', note: 'Open file only.' }),
  [IPC.WORKSPACE_DATA_CHANGED]: proxied('push', [], { frame: 'push:workspace_data', note: 'Open file only; coalesced per scope (250 ms).' }),

  // --- MCP -------------------------------------------------------------------
  [IPC.MCP_PROBE_SERVER]: proxied('invoke', ['POST /admin/mcp/probe']),
  [IPC.MCP_REGISTRATION_TEST]: variant('invoke', ['POST /admin/mcp/registration-test', 'GET /jobs/:jobId', 'POST /jobs/:jobId/cancel', 'GET /admin/mcp/interactions', 'POST /admin/mcp/interactions/:interactionId/continue', 'POST /oauth/relay'], 'OAuth sign-in: Studio main listens on the authorization URL\'s loopback redirect port on this computer and relays the callback to the daemon (remote/oauth-relay.ts, POST /oauth/relay); only https authorization pages are opened.', {
    note: 'Starts a job and polls GET /jobs/:jobId. Meanwhile polls GET /admin/mcp/interactions?jobId=: opens each open_url step with shell.openExternal, shows the native Continue dialog for each confirm step, and answers with …/continue.',
  }),
  [IPC.MCP_INSTALL_PACKAGE]: proxied('invoke', ['POST /admin/mcp/packages/npm/jobs', 'GET /jobs/:jobId'], { note: 'Starts a job and polls GET /jobs/:jobId. Progress arrives as MCP_INSTALL_PROGRESS (mcp/install-progress.ts sends the ones the client stream cannot deliver).' }),
  [IPC.MCP_UNINSTALL_PACKAGE]: proxied('invoke', ['DELETE /admin/mcp/packages/npm']),
  [IPC.MCP_LIST_INSTALLED]: proxied('invoke', ['GET /admin/mcp/packages']),
  [IPC.MCP_GET_SERVER_STATUS]: proxied('invoke', ['GET /agents/:id/runtime/mcp'], { note: 'Open agent only.' }),
  [IPC.MCP_RESTART_SERVER]: proxied('invoke', ['POST /agents/:id/mcp/servers/:serverName/restart']),
  [IPC.MCP_GET_SERVER_LOGS]: proxied('invoke', ['GET /admin/mcp/logs/:serverName'], { note: 'Passes the open agent as agentId (session) for its live logs; without one the daemon answers the logs it kept from probe, test and agent runs.' }),
  [IPC.MCP_INSTALL_PROGRESS]: proxied('push', [], { frame: 'push:mcp_install' }),
  [IPC.MCP_SERVER_STATUS_CHANGED]: proxied('push', [], { frame: 'push:mcp_status', note: 'Open file only.' }),
  [IPC.MCP_CREDENTIAL_SET]: proxied('invoke', ['PUT /files/agent/mcp/credentials', 'GET /files/agent/mcp/credentials'], { note: 'Refuses plaintext when the credentials envelope is locked or foreign. Remote mode: the untouched placeholder of a stored key keeps it; an edited placeholder, or one under a key the file does not store, is refused with a sentence (GET /files/agent/mcp/credentials says which keys are stored).' }),
  [IPC.MCP_CREDENTIAL_GET]: variant('invoke', ['POST /files/agent/identity/reveal'], 'A remote daemon never sends stored values: GET /files/agent/mcp/credentials, and each readable value answers as __redacted__.', { note: 'Local mode: the values through the reveal route with the local proof (Studio sends it).' }),
  [IPC.MCP_CREDENTIAL_LIST_FILES]: proxied('invoke', ['GET /credentials/mcp/files']),
  [IPC.MCP_ATTACH_SERVER]: proxied('invoke', ['POST /files/agent/mcp/servers']),
  [IPC.MCP_DETACH_SERVER]: proxied('invoke', ['DELETE /files/agent/mcp/servers/:serverName']),
  [IPC.MCP_PICK_ADF_FILE]: variant('invoke', [], REMOTE_FILE_PICKER, { note: 'Native open dialog in Studio main.' }),
  [IPC.MCP_INSTALL_PYTHON_PACKAGE]: proxied('invoke', ['POST /admin/mcp/packages/python/jobs', 'GET /jobs/:jobId'], { note: 'Starts a job and polls GET /jobs/:jobId. Progress arrives as MCP_INSTALL_PROGRESS.' }),
  [IPC.MCP_UNINSTALL_PYTHON_PACKAGE]: proxied('invoke', ['DELETE /admin/mcp/packages/python']),
  [IPC.MCP_ENSURE_PYTHON_RUNTIME]: proxied('invoke', ['POST /admin/mcp/python-runtime', 'GET /jobs/:jobId'], { note: 'Starts (or joins) a job and polls GET /jobs/:jobId.' }),
  [IPC.MCP_REGISTRY_GET]: proxied('invoke', ['GET /registry/mcp']),

  // --- Agent registry --------------------------------------------------------
  [IPC.AGENT_REGISTRY_GET]: proxied('invoke', ['GET /registry/agents']),
  [IPC.AGENT_REGISTRY_REFRESH]: proxied('invoke', ['POST /registry/agents/refresh']),
  [IPC.AGENT_REGISTRY_BRING_HOME]: proxied('invoke', ['POST /registry/agents/:id/bring-home'], {
    note: 'The handler records the client key recentFiles.',
  }),
  [IPC.AGENT_MODEL_SET_FOR_FILE]: proxied('invoke', ['GET /files/agent', 'PUT /files/agent/model'], { note: 'Refused for the open file and for a running agent.' }),
  [IPC.MCP_OAUTH_SIGNOUT]: proxied('invoke', ['POST /admin/mcp/oauth/signout']),
  [IPC.MCP_OAUTH_STATUS]: proxied('invoke', ['GET /admin/mcp/oauth/status']),

  // --- Skill catalogs --------------------------------------------------------
  [IPC.SKILLS_CATALOG_GET]: proxied('invoke', ['GET /catalog/skills'], {
    note: 'Network read only. Not Electron-only (D2), and the terminal app reads the same catalogs.',
  }),
  [IPC.SKILLS_PACKAGE_GET]: proxied('invoke', ['GET /catalog/skills/package']),

  // --- Compute ---------------------------------------------------------------
  [IPC.COMPUTE_STATUS]: proxied('invoke', ['GET /compute/status']),
  [IPC.COMPUTE_INIT]: proxied('invoke', ['POST /compute/start']),
  [IPC.COMPUTE_STOP]: proxied('invoke', ['POST /compute/shared/stop']),
  [IPC.COMPUTE_DESTROY]: proxied('invoke', ['POST /compute/destroy']),
  [IPC.COMPUTE_LIST_CONTAINERS]: proxied('invoke', ['GET /compute/containers', 'GET /compute/users'], { note: 'Each row gets `users`, the other runtimes using the container (W1-G); absent when none.' }),
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
  }),
  [IPC.COMPUTE_BROWSER_INFO]: unsupported('invoke', ['GET /compute/browser-info'], 'Unsupported in v1: the noVNC port is on the server\'s loopback (§9.3).'),
  [IPC.COMPUTE_CONTAINER_PHASE]: proxied('push', [], { frame: 'push:compute_phase' }),

  // --- Sandbox packages ------------------------------------------------------
  [IPC.SANDBOX_CHECK_MISSING]: proxied('invoke', ['POST /admin/sandbox/packages/check']),
  [IPC.SANDBOX_INSTALL_PACKAGES]: proxied('invoke', ['POST /admin/sandbox/packages/jobs', 'GET /jobs/:jobId'], { note: 'One job installs the packages in turn; progress arrives as SANDBOX_INSTALL_PROGRESS.' }),
  [IPC.SANDBOX_INSTALL_PROGRESS]: proxied('push', [], { frame: 'push:sandbox_install' }),
  [IPC.SANDBOX_LIST_INSTALLED]: proxied('invoke', ['GET /admin/sandbox/packages']),

  // --- Identity / keystore (per agent) ---------------------------------------
  [IPC.IDENTITY_SET]: proxied('invoke', ['PUT /agents/:id/identity/:purpose'], { note: 'The derived key of a password-protected file lives in the daemon (§5.4).' }),
  [IPC.IDENTITY_GET]: unsupported('invoke', ['POST /agents/:id/identity/reveal'], 'Stored values stay on the daemon\'s machine: Studio says so ("a remote daemon never sends them").', { note: 'Local mode: the value through the reveal route, which needs the local proof (Studio sends it); key material (crypto:*) is never returned.' }),
  [IPC.IDENTITY_DELETE]: proxied('invoke', ['DELETE /agents/:id/identity/:purpose']),
  [IPC.IDENTITY_DELETE_PREFIX]: proxied('invoke', ['DELETE /agents/:id/identity-prefix']),
  [IPC.IDENTITY_LIST]: proxied('invoke', ['GET /agents/:id/identity']),
  [IPC.IDENTITY_PASSWORD_CHECK]: proxied('invoke', ['GET /agents/:id/identity/password']),
  [IPC.IDENTITY_PASSWORD_UNLOCK]: proxied('invoke', ['POST /agents/:id/identity/password/unlock'], { note: 'The route converts the owner’s own legacy file (envelope-actions.ts convertOwnLegacyPassword) and answers converted.' }),
  [IPC.IDENTITY_PASSWORD_SET]: local('invoke', 'Deprecated: always refuses. The daemon-mode handler returns the same refusal and MUST NOT call PUT /agents/:id/identity/password.'),
  [IPC.IDENTITY_PASSWORD_REMOVE]: proxied('invoke', ['DELETE /agents/:id/identity/password']),
  [IPC.IDENTITY_PASSWORD_CHANGE]: local('invoke', 'Deprecated: always refuses. The daemon-mode handler returns the same refusal.'),
  [IPC.IDENTITY_LIST_ENTRIES]: proxied('invoke', ['GET /agents/:id/identity/entries']),
  [IPC.IDENTITY_REVEAL]: unsupported('invoke', ['POST /agents/:id/identity/reveal'], 'Stored values stay on the daemon\'s machine: Studio says so ("a remote daemon never sends them").', { note: 'Local mode: the value through the reveal route, which needs the local proof (Studio sends it); key material (crypto:*) is never returned. Remote: { value: null, reason } with that sentence.' }),
  [IPC.IDENTITY_WIPE_ALL]: proxied('invoke', ['POST /agents/:id/identity/wipe']),
  [IPC.IDENTITY_GET_DID]: proxied('invoke', ['GET /agents/:id/identity/did']),
  [IPC.IDENTITY_GENERATE_KEYS]: proxied('invoke', ['POST /agents/:id/identity/generate-keys'], { note: 'The daemon issues owner and operator attestations too (runtime-service.ts:1879).' }),
  [IPC.IDENTITY_CLAIM]: proxied('invoke', ['POST /agents/:id/claim']),
  [IPC.IDENTITY_SET_CODE_ACCESS]: proxied('invoke', ['PATCH /agents/:id/identity/:purpose/code-access']),

  // --- Owner identity --------------------------------------------------------
  [IPC.IDENTITY_OWNER_STATUS]: proxied('invoke', ['GET /identity', 'GET /settings'], { note: 'Mapped to the Studio status shape (§5.4): the runtime DID, delegation and legacy runtime DIDs are the ones status.runtime says the daemon presents.' }),
  [IPC.IDENTITY_OWNER_REVEAL_MNEMONIC]: unsupported('invoke', [], 'Not available; Studio says so (§5.4).', {
    note: 'Local mode: Studio main reads the shared keychain entry (SharedMnemonicStore). No route carries the phrase.',
  }),
  [IPC.IDENTITY_OWNER_CONFIRM_BACKUP]: unsupported('invoke', ['POST /identity/confirm-backup'], 'Refused by the daemon (local-only route); Studio shows its message.'),
  [IPC.IDENTITY_OWNER_IMPORT]: unsupported('invoke', ['POST /identity/import', 'GET /settings'], 'Refused by the daemon (local-only route); Studio shows its message.', {
    note: 'Local mode: sends the local proof read next to the daemon settings file; switchOwner unless expectedOwnerDid (restore).',
  }),
  [IPC.IDENTITY_ATTESTATIONS_GET]: proxied('invoke', ['GET /agents/:id/attestations']),
  [IPC.IDENTITY_ATTESTATIONS_REISSUE]: proxied('invoke', ['POST /agents/:id/attestations/reissue']),

  // --- Envelope keystore -----------------------------------------------------
  [IPC.IDENTITY_ENVELOPE_STATUS]: proxied('invoke', ['GET /agents/:id/envelope']),
  [IPC.IDENTITY_ENVELOPE_SHARE_SET_PASSWORD]: proxied('invoke', ['PUT /agents/:id/envelope/share-password']),
  [IPC.IDENTITY_ENVELOPE_SHARE_REMOVE_PASSWORD]: proxied('invoke', ['DELETE /agents/:id/envelope/share-password']),
  [IPC.IDENTITY_ENVELOPE_UNLOCK_PASSWORD]: proxied('invoke', ['POST /agents/:id/envelope/unlock-password']),

  // --- Channel adapters ------------------------------------------------------
  [IPC.ADAPTER_INSTALL_PACKAGE]: proxied('invoke', ['POST /admin/adapters/packages/jobs', 'GET /jobs/:jobId'], { note: 'Starts a job and polls GET /jobs/:jobId. Progress arrives as ADAPTER_INSTALL_PROGRESS.' }),
  [IPC.ADAPTER_UNINSTALL_PACKAGE]: proxied('invoke', ['DELETE /admin/adapters/packages', 'GET /settings', 'PATCH /settings'], {
    note: 'The handler then removes the registration from settings.adapters with PATCH /settings; the route does not.',
  }),
  [IPC.ADAPTER_LIST_INSTALLED]: proxied('invoke', ['GET /admin/adapters/packages']),
  [IPC.ADAPTER_GET_STATUS]: proxied('invoke', ['GET /fleet/adapters']),
  [IPC.ADAPTER_RESTART]: proxied('invoke', ['POST /fleet/adapters/restart']),
  [IPC.ADAPTER_GET_LOGS]: proxied('invoke', ['GET /files/agent', 'GET /agents/:id/runtime/adapters'], { note: 'Logs ride in states[].' }),
  [IPC.ADAPTER_INSTALL_PROGRESS]: proxied('push', [], { frame: 'push:adapter_install' }),
  [IPC.ADAPTER_STATUS_CHANGED]: proxied('push', [], { frame: 'push:adapter_status', note: 'Open file only.' }),
  [IPC.ADAPTER_CREDENTIAL_SET]: proxied('invoke', ['PUT /files/agent/adapters/credentials']),
  [IPC.ADAPTER_CREDENTIAL_GET]: variant('invoke', ['GET /files/agent/adapters/credentials', 'POST /files/agent/identity/reveal'], 'A remote daemon never sends stored values: storedKeys names every stored key, credentials is empty (the channel dialog shows "stored").', { note: 'Local mode: the readable values through the reveal route with the local proof (Studio sends it); storedKeys from GET /files/agent/adapters/credentials.' }),
  [IPC.ADAPTER_CREDENTIAL_LIST_FILES]: proxied('invoke', ['GET /credentials/adapters/files']),
  [IPC.ADAPTER_ATTACH]: proxied('invoke', ['GET /files/agent/config', 'POST /files/agent/adapters'], { note: 'Reads the adapters of the file first: one that is on stays as it is, one that is off is turned on with its policy kept.' }),
  [IPC.ADAPTER_DETACH]: proxied('invoke', ['DELETE /files/agent/adapters/:adapterType']),

  // --- Provider credentials (per agent) --------------------------------------
  [IPC.PROVIDER_CREDENTIAL_SET]: proxied('invoke', ['PUT /files/agent/providers/:providerId/credential', 'POST /files/agent/providers/:providerId/credential/copy-app-key'], {
    note: 'A value of __redacted__ (Copy app key) stands for the app key the daemon holds: copy-app-key. 409 credentials_locked asks the owner (native dialog) to replace or cancel.',
  }),
  [IPC.PROVIDER_CREDENTIAL_GET]: unsupported('invoke', ['GET /files/agent/providers/:providerId/credentials', 'POST /files/agent/identity/reveal'], 'Stored values stay on the daemon\'s machine: Studio says so ("a remote daemon never sends them").', { note: 'Local mode: values through the reveal route with the local proof. Remote: { credentials: {}, error } with that sentence.' }),
  [IPC.PROVIDER_CREDENTIAL_LIST_FILES]: proxied('invoke', ['GET /credentials/providers/files']),
  [IPC.PROVIDER_ATTACH]: proxied('invoke', ['POST /files/agent/providers']),
  [IPC.PROVIDER_DETACH]: proxied('invoke', ['DELETE /files/agent/providers/:providerId']),
  [IPC.PROVIDER_AGENT_KEY_SOURCES]: proxied('invoke', ['POST /credentials/providers/key-sources']),
  [IPC.PROVIDER_TEST]: proxied('invoke', ['POST /runtime/providers/:id/test']),

  // --- Subscription sign-in --------------------------------------------------
  [IPC.CHATGPT_AUTH_START]: variant('invoke', ['POST /auth/chatgpt/start', 'POST /auth/chatgpt/complete'], 'Relay mode: Studio main runs the loopback callback and posts the code to POST /auth/chatgpt/complete.', {
    note: 'Relay mode in local mode too: Studio main runs the callback server, opens authUrl and posts the code; the daemon exchanges it and keeps the tokens.',
  }),
  [IPC.CHATGPT_AUTH_STATUS]: proxied('invoke', ['GET /auth/chatgpt/status']),
  [IPC.CHATGPT_AUTH_LOGOUT]: proxied('invoke', ['POST /auth/chatgpt/logout']),
  [IPC.GROK_AUTH_START]: proxied('invoke', ['POST /auth/grok/start'], { note: 'Device-code flow; works across machines. Studio main opens the verification page.' }),
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
  [IPC.MESH_DISCOVERED_RUNTIMES]: proxied('invoke', ['GET /network/mesh/discovered-runtimes']),
  [IPC.MESH_PEER_SHARED_FILE]: proxied('invoke', ['GET /network/peers/shared-file'], {
    note: 'Network read; proxied so it runs on the host that discovered the peer (in remote mode, the server\'s network).',
  }),
  [IPC.MESH_PEER_AGENT_HEALTH]: proxied('invoke', ['GET /network/peers/health']),
  [IPC.MESH_FIREWALL_CHECK]: local('invoke', 'The port and LAN binding come from the daemon mesh server, not from Studio main.', {
    reads: ['GET /network/server'],
    remote: 'Labelled, not hidden: the check answers supported: false with a sentence (the firewall is the laptop\'s, the mesh server the server\'s; §9.4); the panel shows it without a fix button.',
  }),
  [IPC.MESH_FIREWALL_APPLY]: local('invoke', 'Elevation prompt from Studio; the port comes from the daemon mesh server.', {
    reads: ['GET /network/server'],
    remote: 'Refused with the sentence of MESH_FIREWALL_CHECK (success: false).',
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
  [IPC.BACKEND_REMOTE_CHECK]: local('invoke', 'Registered in backend/backend-settings-ipc.ts in every mode: the remote handshake (remote/connector.ts) against a draft URL, with the saved token only for the saved origin. Never returns the token.'),
  [IPC.BACKEND_RESTART_STUDIO]: local('invoke', 'Registered in backend/backend-settings-ipc.ts in every mode: relaunchStudio (mode-switch.ts), then the normal quit path.'),

  // --- Remote mode: daemon-side picker (W4-B) -------------------------------
  [IPC.REMOTE_PICKER_REQUEST]: local('push', 'Studio main asks the renderer for a daemon-side pick (remote/picker.ts); the answer comes back on REMOTE_PICKER_RESPOND.'),
  [IPC.REMOTE_PICKER_RESPOND]: local('invoke', 'Settles the pick remote/picker.ts is waiting for; reads no daemon state. Outside daemon mode it answers false (backend-settings-ipc.ts).'),
  [IPC.REMOTE_FS_BROWSE]: proxied('invoke', ['GET /fs/browse'], { note: 'Answers { error, code } instead of rejecting, so the picker shows it. Outside daemon mode it answers an error (backend-settings-ipc.ts).' }),
  [IPC.REMOTE_FS_MKDIR]: proxied('invoke', ['POST /fs/folders'], { note: 'The picker\'s New folder. Answers { error, code } instead of rejecting. Outside daemon mode it answers an error (backend-settings-ipc.ts).' }),

  // --- Recovery copies of unsaved text (W3-F) ---------------------------------
  [IPC.RECOVERY_STASH]: local('invoke', 'Registered in backend/edit-recovery.ts in both modes; writes <userData>/recovered.'),
  [IPC.RECOVERY_LIST]: local('invoke', 'Registered in backend/edit-recovery.ts in both modes.'),
  [IPC.RECOVERY_ARCHIVE]: local('invoke', 'Registered in backend/edit-recovery.ts in both modes.'),
  [IPC.RECOVERY_REVEAL]: local('invoke', 'Registered in backend/edit-recovery.ts in both modes; opens the folder on this machine.'),

  // --- Overview, emergency stop, identity drafts -----------------------------
  [IPC.AGENT_VITALS]: proxied('invoke', ['GET /fleet/vitals']),
  [IPC.AGENT_ACTIVITY]: proxied('invoke', ['GET /fleet/activity']),
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
