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
 * (D3: the open document, W2-A/W2-B) or GET /tracked-dirs/agents/all.
 *
 * A `gaps` entry names the workstream that adds what the daemon lacks today
 * (docs/design/daemon-backend-tracker.md §4). The same list, grouped by
 * workstream, is docs/design/daemon-backend-gaps.md; the test keeps the two in
 * step. Proxied push channels name the client-stream frame (D5) that feeds
 * them in `frame`; the event bridge (W2-C) maps frames to pushes.
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
export type GapWorkstream = 'W1-A' | 'W1-B' | 'W1-C' | 'W1-D' | 'W1-E' | 'W2-A' | 'W2-B'

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

/** D4: every /agents/:id/* resource route works on an open, not-running document. */
const OPEN_DOC = gap('W2-A', 'the route works on an open, not-running document (D4)')
/** D5: hold / release the open file as a session document. */
const HOLD_DOC = gap('W2-B', 'hold the file as the session document (POST /client/sessions/:id/documents)')
/** W1-E: raw octet-stream file routes; the JSON base64 routes stop at Fastify's 1 MiB body limit. */
const RAW_FILE = gap('W1-E', 'GET/PUT /agents/:id/files/raw (octet-stream, own bodyLimit)')
/** W1-E: daemon-side folder and file listing for remote pickers and folder-scoped actions. */
const FS_BROWSE = gap('W1-E', 'GET /fs/browse')
const SHARE_SNAPSHOT = gap('W1-E', 'identity-free share snapshot of an agent file as bytes (AdfDatabase.snapshotForSend)')
const streamTopic = (topic: string): ChannelGap => gap('W2-B', `client-stream push topic \`${topic}\``)

const REMOTE_FOLDER_PICKER = 'Daemon-side folder picker over tracked directories and GET /fs/browse (W1-E); the native dialog would pick a path on the laptop.'
const REMOTE_FILE_PICKER = 'Daemon-side .adf picker over tracked directories and GET /fs/browse (W1-E); the native dialog would pick a path on the laptop.'

export const CHANNEL_MAP = {
  // --- File operations -------------------------------------------------------
  [IPC.FILE_OPEN]: variant('invoke', ['GET /agents/:id/identity/password', 'PATCH /settings'], `${REMOTE_FILE_PICKER} A dropped or OS-opened laptop file is uploaded first (POST /files/import, W1-E).`, {
    gaps: [HOLD_DOC, gap('W1-A', 'config.name <- file basename on open'), OPEN_DOC],
    note: 'Native open dialog in Studio main. recordRecentFile writes the client key recentFiles. A running agent is reattached, not reopened. Embedded copies ADF-stored providers into settings.providers.',
  }),
  [IPC.FILE_SAVE]: proxied('invoke', [], { gaps: [gap('W2-A', 'checkpoint the WAL of an open document')] }),
  [IPC.FILE_CREATE]: variant('invoke', ['POST /agents/create'], 'The save dialog picks a laptop path; remote needs a daemon-side folder picker plus a name (GET /fs/browse, W1-E).', {
    gaps: [HOLD_DOC],
    note: 'Save dialog in Studio main, then create (directory + name). The created file becomes the open file.',
  }),
  [IPC.FILE_CREATE_QUICK]: proxied('invoke', ['POST /agents/create', 'GET /templates'], {
    gaps: [gap('W1-D', 'adopt an identity draft (identityDraftId) on create'), HOLD_DOC],
    note: 'A typed name that exists is refused with code name_taken; the folder must exist and must not be under the OS temp dir.',
  }),
  [IPC.AGENTS_FOLDER_DEFAULT_GET]: proxied('invoke', ['GET /templates'], { note: 'defaultDirectory field.' }),
  [IPC.FILE_CLOSE]: proxied('invoke', [], { gaps: [gap('W2-B', 'release the session document (DELETE /client/sessions/:id/documents/:agentId)')] }),
  [IPC.FILE_DELETE]: proxied('invoke', [], { gaps: [gap('W1-E', 'delete an agent file, stopping a running agent first')] }),
  [IPC.FILE_CLONE]: proxied('invoke', [], { gaps: [gap('W1-E', 'clone with selected tables and clone-fixup')] }),
  [IPC.FILE_LIST_TABLES]: proxied('invoke', ['GET /agents/:id/tables'], { gaps: [OPEN_DOC], note: 'Clone dialog: any file, with row counts.' }),
  [IPC.FILE_RENAME]: proxied('invoke', [], { gaps: [gap('W1-E', 'rename an agent file; deferred while it runs (rekeyAgentPath, W1-A)')] }),
  [IPC.FILE_RENAMED]: proxied('push', [], { frame: 'push:file_renamed', gaps: [streamTopic('file_renamed'), gap('W1-E', 'emit file_renamed on rename and on accept-relocate')] }),
  [IPC.FILE_GET_CURRENT]: proxied('invoke', ['GET /agents/:id/status'], { note: 'filePath is DaemonModeSession state (D3); agentRunning comes from the status.' }),
  [IPC.FILE_REVEAL]: unsupported('invoke', [], 'Disabled; the path is shown as text (§9.3).', { note: 'Local mode: shell.showItemInFolder on the daemon path (same machine).' }),
  [IPC.FILE_SHARE_PREPARE]: proxied('invoke', [], {
    gaps: [SHARE_SNAPSHOT],
    note: 'Studio main writes the bytes into its scratch share dir and registers the token FILE_SHARE_DRAG_START drags; app.getFileIcon stays local.',
  }),
  [IPC.FILE_SHARE_DRAG_START]: local('send', 'startDrag of the temp file FILE_SHARE_PREPARE wrote. Reads no backend state, but works only when the daemon-mode PREPARE handler fills the same token map.'),
  [IPC.FILE_SHARE_DISCARD]: local('invoke', 'Deletes the Studio-side temp snapshot.'),
  [IPC.FILE_SHARE_SAVE_AS]: proxied('invoke', [], { gaps: [SHARE_SNAPSHOT], note: 'Save dialog and the write stay in Studio main (a laptop path in remote mode).' }),

  // --- Document content ------------------------------------------------------
  [IPC.DOC_GET_DOCUMENT]: proxied('invoke', ['GET /agents/:id/document'], { gaps: [OPEN_DOC] }),
  [IPC.DOC_SET_DOCUMENT]: proxied('invoke', ['PUT /agents/:id/document'], { gaps: [OPEN_DOC] }),
  [IPC.DOC_GET_AGENT_CONFIG]: proxied('invoke', ['GET /agents/:id/config'], { gaps: [OPEN_DOC] }),
  [IPC.DOC_SET_AGENT_CONFIG]: proxied('invoke', ['PUT /agents/:id/config'], {
    gaps: [OPEN_DOC, gap('W1-E', 'a name change renames the file (syncAgentFileToName) and returns filePath or renameDeferred'), gap('W1-B', 'MCP reconcile on config change')],
    note: 'Refuse a config whose id differs from the open file (session check). The write MUST NOT echo back as DOC_AGENT_CONFIG_CHANGED to this session.',
  }),
  [IPC.DOC_AGENT_CONFIG_CHANGED]: proxied('push', [], {
    frame: 'push:config_changed',
    gaps: [streamTopic('config_changed')],
    note: 'Runtime-originated changes only, for the open file (origin dedup: embedded saves pass notifyHost: false).',
  }),
  [IPC.DOC_GET_CHAT]: proxied('invoke', ['GET /agents/:id/chat'], { gaps: [OPEN_DOC] }),
  [IPC.DOC_GET_CHAT_OLDER]: proxied('invoke', ['GET /agents/:id/loop'], { gaps: [OPEN_DOC, gap('W2-A', 'keyset page of display entries before a seq (beforeSeq); the route pages by offset')] }),
  [IPC.DOC_SET_CHAT]: local('invoke', 'No-op stub in embedded (returns success); daemon mode returns the same.'),
  [IPC.DOC_CLEAR_CHAT]: proxied('invoke', ['DELETE /agents/:id/chat'], { gaps: [OPEN_DOC], note: 'Main-loop clear also resets the mesh session in embedded.' }),
  [IPC.DOC_GET_INBOX]: proxied('invoke', ['GET /agents/:id/inbox'], { gaps: [OPEN_DOC] }),
  [IPC.DOC_CLEAR_INBOX]: proxied('invoke', ['DELETE /agents/:id/inbox'], { gaps: [OPEN_DOC], note: 'Embedded also pushes INBOX_UPDATED with an empty inbox.' }),
  [IPC.DOC_GET_OUTBOX]: proxied('invoke', ['GET /agents/:id/outbox'], { gaps: [OPEN_DOC] }),
  [IPC.DOC_GET_BATCH]: proxied('invoke', ['GET /agents/:id/document', 'GET /agents/:id/config', 'GET /agents/:id/chat', 'GET /agents/:id/meta'], {
    gaps: [OPEN_DOC, gap('W2-A', 'lastTokens and contextBaseline of an agent (no route returns them)')],
  }),
  [IPC.DOC_GET_HEADER]: proxied('invoke', ['GET /agents/:id/document', 'GET /agents/:id/config', 'GET /agents/:id/meta'], { gaps: [OPEN_DOC] }),

  // --- Agent runtime ---------------------------------------------------------
  [IPC.AGENT_START]: proxied('invoke', ['POST /agents/:id/start', 'GET /agents/:id/status', 'GET /agents/:id/tasks', 'GET /agents/:id/asks'], {
    gaps: [
      gap('W2-A', 'start assembles a runtime on the open document'),
      gap('W1-A', 'provider_missing / provider_unconfigured preflight codes'),
      gap('W2-B', 'set the session focus to the started agent'),
    ],
    note: 'The reuse path (agent already running) returns sessionId, agentState, pendingApprovals and pendingAsks.',
  }),
  [IPC.AGENT_STOP]: proxied('invoke', ['POST /agents/:id/stop'], { gaps: [gap('W2-A', 'stop keeps the document open while the session holds it')] }),
  [IPC.AGENT_STATUS]: proxied('invoke', ['GET /agents/:id/status']),
  [IPC.AGENT_INVOKE]: proxied('invoke', ['POST /agents/:id/chat'], {
    gaps: [gap('W2-A', 'content blocks (images, files) in the chat body; the route takes text only')],
    note: 'filePath may name a background agent; loop selects the stream.',
  }),
  [IPC.AGENT_COMPACT]: proxied('invoke', ['POST /agents/:id/compact']),
  [IPC.AGENT_EVENT]: proxied('push', [], {
    frame: 'executor',
    gaps: [gap('W2-B', 'executor frames, deltas for the focused agent only'), gap('W1-A', 'trigger_message, trigger errors and startup-dispatch failures through the host attachment')],
    note: 'Focused agent only. Mesh inter_agent_message and chat_updated outside the executor are synthesized onto this channel (§7).',
  }),
  [IPC.AGENT_TOOL_APPROVAL_RESPOND]: proxied('invoke', ['POST /agents/:id/tasks/:taskId/resolve'], { note: 'requestId is the HIL task id; feedback maps to reason.' }),
  [IPC.AGENT_TOOL_ALWAYS_APPROVE]: proxied('invoke', ['POST /agents/:id/tasks/:taskId/always-approve']),
  [IPC.AGENT_TOOL_APPROVE_ALL_GATED]: proxied('invoke', ['POST /agents/:id/tasks/approve-all']),

  // --- Approvals hub ---------------------------------------------------------
  [IPC.APPROVALS_LIST]: proxied('invoke', [], { gaps: [gap('W1-D', 'approvals hub full snapshot across all agents and loops')] }),
  [IPC.APPROVALS_RESOLVE]: proxied('invoke', [], { gaps: [gap('W1-D', 'resolve an approval by (agent, approvalId)')] }),
  [IPC.APPROVALS_CHANGED]: proxied('push', [], {
    frame: 'push:approvals',
    gaps: [gap('W1-D', 'approvals hub in the daemon'), streamTopic('approvals')],
    note: 'Sent to every window, not only the first (ipc/index.ts:1938).',
  }),
  [IPC.APPROVALS_GET_INPUT]: proxied('invoke', [], { gaps: [gap('W1-D', 'raw tool input of one pending approval')] }),
  [IPC.APPROVALS_REVEAL]: local('push', 'Studio native notifier and menu bar click. In daemon mode the notifier is fed from the approvals frames.'),
  [IPC.APPROVALS_GET_PENDING_REVEAL]: local('invoke', 'Reveal queued in Studio main for a loading renderer.'),

  [IPC.AGENT_ASK_RESPOND]: proxied('invoke', ['POST /agents/:id/asks/:requestId/respond']),
  [IPC.AGENT_SUSPEND_RESPOND]: proxied('invoke', ['POST /agents/:id/suspend/respond']),

  // --- Models and settings ---------------------------------------------------
  [IPC.MODELS_LIST]: proxied('invoke', ['GET /runtime/models'], { gaps: [OPEN_DOC], note: 'filePath maps to agentId for ADF-stored providers.' }),
  [IPC.SETTINGS_GET]: proxied('invoke', ['GET /settings'], { note: 'Returns {...daemonSettings, ...clientSettings} (§4.2); provider apiKey arrives as __redacted__.' }),
  [IPC.SETTINGS_SET]: proxied('invoke', ['PATCH /settings'], {
    gaps: [gap('W1-A', 'apply sandboxMaxWorkers live (read once at boot, daemon/index.ts:183), like the prompt keys')],
    note: 'Split by settingsKeyClass(): client keys go to studio-client-settings.json, backend keys to the daemon. menuBarEnabled applies in Studio main.',
  }),

  // --- Agent templates -------------------------------------------------------
  [IPC.TEMPLATES_LIST]: proxied('invoke', ['GET /templates'], { note: 'Drop `migrated` when the client key templatesMigrationSeen is set.' }),
  [IPC.TEMPLATES_CHANGED]: proxied('push', [], { frame: 'push:templates', gaps: [streamTopic('templates')] }),
  [IPC.TEMPLATES_MIGRATION_SEEN]: local('invoke', 'Writes the client key templatesMigrationSeen.'),
  [IPC.TEMPLATE_CREATE]: proxied('invoke', ['POST /templates']),
  [IPC.TEMPLATE_DELETE]: proxied('invoke', ['DELETE /templates/:id'], { note: 'The daemon moves the file into templates-trash; embedded uses the OS trash.' }),
  [IPC.TEMPLATE_RESET_SHIPPED]: proxied('invoke', ['POST /templates/:id/reset']),
  [IPC.TEMPLATE_REVEAL]: unsupported('invoke', ['GET /templates'], 'Disabled; the templates folder path is shown as text.', { note: 'Local mode: shell on the daemon templates folder (folder from GET /templates).' }),
  [IPC.TEMPLATE_SET_DEFAULT]: proxied('invoke', ['POST /templates/:id/default']),
  [IPC.TEMPLATE_RENAME]: proxied('invoke', ['PATCH /templates/:id']),
  [IPC.TEMPLATE_SET_META]: proxied('invoke', ['PATCH /templates/:id']),
  [IPC.TEMPLATE_GET_CONTENTS]: proxied('invoke', ['GET /templates/:id']),
  [IPC.TEMPLATE_SET_CONFIG]: proxied('invoke', ['PUT /templates/:id/config']),
  [IPC.TEMPLATE_SET_FILE]: proxied('invoke', ['PUT /templates/:id/files']),
  [IPC.TEMPLATE_ADD_FILES]: proxied('invoke', ['PUT /templates/:id/files'], {
    gaps: [gap('W1-E', 'binary template extra files up to 25 MiB; the route takes text content in a 1 MiB JSON body')],
    note: 'Native multi-select dialog in Studio main; Studio reads the picked files locally.',
  }),
  [IPC.TEMPLATE_REMOVE_FILE]: proxied('invoke', ['DELETE /templates/:id/files']),
  [IPC.TEMPLATE_CHECK_REVIEW]: proxied('invoke', ['GET /templates/:id/review']),
  [IPC.TEMPLATE_REVIEW_ACCEPT]: proxied('invoke', ['POST /templates/:id/review/accept']),

  // --- Tracked directories ---------------------------------------------------
  [IPC.TRACKED_DIRS_GET]: proxied('invoke', ['GET /tracked-dirs'], { gaps: [gap('W1-E', 'tracked-dir watcher (embedded starts it from this handler)')] }),
  [IPC.TRACKED_DIRS_ADD]: variant('invoke', ['POST /tracked-dirs'], REMOTE_FOLDER_PICKER, { note: 'Native folder dialog in Studio main.' }),
  [IPC.TRACKED_DIRS_REMOVE]: proxied('invoke', ['DELETE /tracked-dirs']),
  [IPC.TRACKED_DIRS_SCAN]: proxied('invoke', ['GET /tracked-dirs/agents'], {
    gaps: [gap('W1-E', 'folder tree scan in the TrackedDirEntry shape: children, pendingName, messaging fields, agentId, icon, did')],
  }),
  [IPC.TRACKED_DIRS_CHANGED]: proxied('push', [], { frame: 'push:tracked_dirs', gaps: [gap('W1-E', 'watcher emits tracked_dirs'), streamTopic('tracked_dirs')] }),

  // --- Mesh ------------------------------------------------------------------
  [IPC.MESH_ENABLE]: proxied('invoke', ['POST /network/mesh/enable']),
  [IPC.MESH_DISABLE]: proxied('invoke', ['POST /network/mesh/disable']),
  [IPC.MESH_STATUS]: proxied('invoke', ['GET /network/mesh'], {
    gaps: [gap('W1-D', 'mesh debug view: live agent states, bus registrations, message log with a sinceSeq cursor')],
  }),
  [IPC.MESH_EVENT]: proxied('push', [], {
    frame: 'push:mesh',
    gaps: [streamTopic('mesh')],
    note: 'Includes station:<adapter> message_routed events for adapter inbound messages (notifyStationInbound).',
  }),
  [IPC.MESH_DEBUG]: local('none', 'Defined in IPC; never registered, sent or exposed in preload.'),
  [IPC.MESH_GET_RECENT_TOOLS]: proxied('invoke', ['GET /network/mesh/recent-tools'], { note: 'Embedded also reads loaded agents that are not mesh-registered from their workspaces.' }),
  [IPC.MESH_PENDING_INTERACTIONS]: proxied('invoke', [], {
    gaps: [gap('W1-D', 'pending asks and approvals across agents (the approvals hub snapshot covers it)')],
    note: 'No Studio renderer consumer (ipc/index.ts:5899).',
  }),
  [IPC.MESH_FLEET_STATUS]: proxied('invoke', [], { gaps: [gap('W1-D', 'fleet status rows (AgentVitalsService.getFleetStatus exists in the daemon)')] }),
  [IPC.MESH_TOKEN_BURN]: proxied('invoke', [], { gaps: [gap('W1-D', 'fleet token burn, hydrated from the client key fleetMapState.burnTotals passed as a parameter')] }),
  [IPC.MESH_MAP_POLL]: proxied('invoke', [], { gaps: [gap('W1-D', 'one aggregate fleet-map poll: mesh debug, fleet, burn, adapters, peers')] }),
  [IPC.MESH_MESSAGE_AGENTS]: proxied('invoke', ['POST /agents/:id/chat', 'POST /agents/load'], {
    gaps: [gap('W1-D', 'owner message to an agent that refuses to start: append it to the agent loop')],
  }),
  [IPC.MESH_SET_AGENT_STATE]: proxied('invoke', ['POST /agents/:id/state']),
  [IPC.MESH_FOUND_AGENT]: proxied('invoke', ['POST /agents/create', 'GET /settings/:key'], {
    note: 'Studio main checks the destination against trackedDirectories (newRoot: sibling of a tracked root) and slugs the file name.',
  }),

  // --- Background agents -----------------------------------------------------
  [IPC.BACKGROUND_AGENT_START]: proxied('invoke', ['POST /agents/load'], { note: 'requireReview: true. The password gate needs the derived key in the daemon.' }),
  [IPC.BACKGROUND_AGENT_EVENT_BATCH]: proxied('push', [], {
    frame: 'executor',
    gaps: [gap('W2-B', 'executor and host frames for every agent'), gap('W1-A', 'agent_starting ... agent_stopped host lifecycle events')],
    note: 'Non-focused agents: frames go through background-event-mapping.ts (W1-F) and BackgroundEventBatcher (W2-C). Also fed by host frames.',
  }),
  [IPC.BACKGROUND_AGENT_STATUS]: proxied('invoke', ['GET /agents'], { gaps: [gap('W1-A', 'in-flight starts (embedded `starting`): agent_starting / agent_start_failed host events')] }),
  [IPC.BACKGROUND_AGENT_STOP]: proxied('invoke', ['POST /agents/:id/stop']),
  [IPC.BACKGROUND_AGENT_ASK_RESPOND]: proxied('invoke', ['POST /agents/:id/asks/:requestId/respond']),
  [IPC.BACKGROUND_AGENT_TOOL_APPROVAL_RESPOND]: proxied('invoke', ['POST /agents/:id/tasks/:taskId/resolve']),
  [IPC.BACKGROUND_AGENT_ALWAYS_APPROVE]: proxied('invoke', ['POST /agents/:id/tasks/:taskId/always-approve']),

  // --- Directory bulk operations ---------------------------------------------
  [IPC.DIRECTORY_START_ALL]: proxied('invoke', ['POST /agents/load'], {
    gaps: [FS_BROWSE],
    note: 'The .adf files directly in dirPath (not recursive). Embedded skips the open file and applies no review gate.',
  }),
  [IPC.DIRECTORY_STOP_ALL]: proxied('invoke', ['POST /agents/:id/stop'], { gaps: [FS_BROWSE] }),

  // --- Tools and token usage -------------------------------------------------
  [IPC.TOOLS_DESCRIPTIONS]: proxied('invoke', [], {
    gaps: [gap('W1-D', 'tool schema catalog in provider format, including the stubbed runtime tools; GET /agents/:id/tools is per loaded agent and another shape')],
  }),
  [IPC.TOKEN_USAGE_GET]: proxied('invoke', ['GET /runtime/usage']),
  [IPC.TOKEN_USAGE_CLEAR]: proxied('invoke', [], { gaps: [gap('W1-D', 'clear token usage')] }),
  [IPC.TOKEN_USAGE_EXPORT]: local('invoke', 'Save dialog; writes the JSON string the renderer passes.'),
  [IPC.TOKEN_COUNT]: proxied('invoke', ['POST /runtime/token-count'], { note: 'Provider and model default to the open agent config (session).' }),
  [IPC.TOKEN_COUNT_BATCH]: proxied('invoke', ['POST /runtime/token-count/batch']),
  [IPC.CONTEXT_BREAKDOWN_GET]: proxied('invoke', ['GET /agents/:id/context']),

  // --- Home dashboard --------------------------------------------------------
  [IPC.DASHBOARD_QUICK_STATS]: proxied('invoke', [], { gaps: [gap('W1-D', 'dashboard quick stats')] }),
  [IPC.DASHBOARD_PROVIDER_TESTS]: proxied('invoke', [], { gaps: [gap('W1-D', 'dashboard provider tests (session-cached)')] }),
  [IPC.DASHBOARD_CONTAINERS]: proxied('invoke', ['GET /compute/containers', 'GET /compute/status']),
  [IPC.DASHBOARD_AGENT_STATS]: proxied('invoke', [], { gaps: [gap('W1-D', 'dashboard agent stats over tracked files')] }),

  // --- Timers ----------------------------------------------------------------
  [IPC.DOC_GET_TIMERS]: proxied('invoke', ['GET /agents/:id/timers'], { gaps: [OPEN_DOC] }),
  [IPC.DOC_ADD_TIMER]: proxied('invoke', ['POST /agents/:id/timers'], { gaps: [OPEN_DOC], note: 'Embedded validates `loop` against the declared loops.' }),
  [IPC.DOC_UPDATE_TIMER]: proxied('invoke', ['PUT /agents/:id/timers/:timerId'], { gaps: [OPEN_DOC] }),
  [IPC.DOC_DELETE_TIMER]: proxied('invoke', ['DELETE /agents/:id/timers/:timerId'], { gaps: [OPEN_DOC] }),

  // --- Internal files --------------------------------------------------------
  [IPC.DOC_GET_FILES]: proxied('invoke', ['GET /agents/:id/files'], { gaps: [OPEN_DOC] }),
  [IPC.DOC_UPLOAD_FILE]: proxied('invoke', ['PUT /agents/:id/files/content'], {
    gaps: [OPEN_DOC, RAW_FILE, gap('W1-E', 'unique naming on upload (writeFileBufferUnique)')],
  }),
  [IPC.DOC_IMPORT_PATHS]: proxied('invoke', ['PUT /agents/:id/files/content'], {
    gaps: [OPEN_DOC, RAW_FILE],
    note: 'The dropped paths are on the Studio machine: Studio main reads them (directories recurse) and uploads.',
  }),
  [IPC.DOC_PICK_AND_IMPORT]: proxied('invoke', ['PUT /agents/:id/files/content'], { gaps: [OPEN_DOC, RAW_FILE], note: 'Native picker and file reads in Studio main, then upload.' }),
  [IPC.DOC_DELETE_INTERNAL_FILE]: proxied('invoke', ['DELETE /agents/:id/files/content'], { gaps: [OPEN_DOC] }),
  [IPC.DOC_RENAME_INTERNAL_FILE]: proxied('invoke', ['POST /agents/:id/files/rename'], { gaps: [OPEN_DOC] }),
  [IPC.DOC_RENAME_FOLDER]: proxied('invoke', ['POST /agents/:id/files/rename-folder'], { gaps: [OPEN_DOC] }),
  [IPC.DOC_SET_FILE_PROTECTION]: proxied('invoke', ['PATCH /agents/:id/files/protection'], { gaps: [OPEN_DOC] }),
  [IPC.DOC_SET_FILE_AUTHORIZED]: proxied('invoke', ['PATCH /agents/:id/files/authorized'], { gaps: [OPEN_DOC] }),
  [IPC.DOC_READ_INTERNAL_FILE]: proxied('invoke', ['GET /agents/:id/files/content'], { gaps: [OPEN_DOC] }),
  [IPC.DOC_WRITE_INTERNAL_FILE]: proxied('invoke', ['PUT /agents/:id/files/content'], { gaps: [OPEN_DOC] }),
  [IPC.DOC_DOWNLOAD_INTERNAL_FILE]: proxied('invoke', ['GET /agents/:id/files/content'], { gaps: [OPEN_DOC, RAW_FILE], note: 'Save dialog and the write stay in Studio main.' }),

  // --- Meta, logs, tasks, local tables ---------------------------------------
  [IPC.DOC_GET_ALL_META]: proxied('invoke', ['GET /agents/:id/meta'], { gaps: [OPEN_DOC] }),
  [IPC.DOC_SET_META]: proxied('invoke', ['PUT /agents/:id/meta/:key'], { gaps: [OPEN_DOC] }),
  [IPC.DOC_DELETE_META]: proxied('invoke', ['DELETE /agents/:id/meta/:key'], { gaps: [OPEN_DOC] }),
  [IPC.DOC_SET_META_PROTECTION]: proxied('invoke', ['PATCH /agents/:id/meta/:key/protection'], { gaps: [OPEN_DOC] }),
  [IPC.DOC_GET_LOGS]: proxied('invoke', ['GET /agents/:id/logs'], { gaps: [OPEN_DOC] }),
  [IPC.DOC_GET_LOGS_AFTER]: proxied('invoke', ['GET /agents/:id/logs/after'], { gaps: [OPEN_DOC] }),
  [IPC.DOC_CLEAR_LOGS]: proxied('invoke', ['DELETE /agents/:id/logs'], { gaps: [OPEN_DOC] }),
  [IPC.DOC_GET_TASKS]: proxied('invoke', ['GET /agents/:id/tasks'], { gaps: [OPEN_DOC] }),
  [IPC.DOC_LIST_LOCAL_TABLES]: proxied('invoke', ['GET /agents/:id/tables'], { gaps: [OPEN_DOC] }),
  [IPC.DOC_QUERY_LOCAL_TABLE]: proxied('invoke', ['GET /agents/:id/tables/:table'], { gaps: [OPEN_DOC], note: 'Embedded allows local_* tables and adf_audit.' }),
  [IPC.DOC_DROP_LOCAL_TABLE]: proxied('invoke', ['DELETE /agents/:id/tables/:table'], { gaps: [OPEN_DOC] }),

  // --- Workspace pushes ------------------------------------------------------
  [IPC.INBOX_UPDATED]: proxied('push', [], { frame: 'push:inbox', gaps: [streamTopic('inbox')], note: 'Open file only.' }),
  [IPC.WORKSPACE_DATA_CHANGED]: proxied('push', [], { frame: 'push:workspace_data', gaps: [streamTopic('workspace_data')], note: 'Open file only; coalesced per scope (250 ms).' }),

  // --- MCP -------------------------------------------------------------------
  [IPC.MCP_PROBE_SERVER]: proxied('invoke', [], { gaps: [gap('W1-D', 'MCP probe (temporary connect, tool list)')] }),
  [IPC.MCP_REGISTRATION_TEST]: variant('invoke', [], 'OAuth remotes: Studio main runs the loopback callback and relays the code (§9.3).', {
    gaps: [gap('W1-D', 'MCP registration connect test')],
    note: 'Opens the OAuth authorize URL in Studio\'s browser; the stdio auth preflight shows a native Continue dialog.',
  }),
  [IPC.MCP_INSTALL_PACKAGE]: proxied('invoke', ['POST /admin/mcp/packages/npm'], { note: 'Progress arrives as MCP_INSTALL_PROGRESS.' }),
  [IPC.MCP_UNINSTALL_PACKAGE]: proxied('invoke', ['DELETE /admin/mcp/packages/npm']),
  [IPC.MCP_LIST_INSTALLED]: proxied('invoke', ['GET /admin/mcp/packages']),
  [IPC.MCP_GET_SERVER_STATUS]: proxied('invoke', ['GET /agents/:id/runtime/mcp'], { note: 'Open agent only.' }),
  [IPC.MCP_RESTART_SERVER]: proxied('invoke', ['POST /agents/:id/mcp/servers/:serverName/restart']),
  [IPC.MCP_GET_SERVER_LOGS]: proxied('invoke', ['GET /agents/:id/runtime/mcp'], {
    gaps: [gap('W1-D', 'MCP logs of probe and registration-test runs and of stopped agents (embedded mcpLogCache)')],
  }),
  [IPC.MCP_INSTALL_PROGRESS]: proxied('push', [], { frame: 'push:mcp_install', gaps: [gap('W2-B', 'client-stream push topic `mcp_install`, fed by progress callbacks in the install routes')] }),
  [IPC.MCP_SERVER_STATUS_CHANGED]: proxied('push', [], { frame: 'push:mcp_status', gaps: [streamTopic('mcp_status')], note: 'Open file only.' }),
  [IPC.MCP_CREDENTIAL_SET]: proxied('invoke', ['PUT /agents/:id/mcp/credentials'], { gaps: [OPEN_DOC], note: 'Refuses plaintext when the credentials envelope is locked or foreign.' }),
  [IPC.MCP_CREDENTIAL_GET]: proxied('invoke', ['GET /agents/:id/mcp/credentials'], { gaps: [OPEN_DOC] }),
  [IPC.MCP_CREDENTIAL_LIST_FILES]: proxied('invoke', [], { gaps: [gap('W1-D', 'MCP credential-list-files across loaded and tracked agents (metadata only)')] }),
  [IPC.MCP_ATTACH_SERVER]: proxied('invoke', ['POST /agents/:id/mcp/servers'], { gaps: [OPEN_DOC] }),
  [IPC.MCP_DETACH_SERVER]: proxied('invoke', ['DELETE /agents/:id/mcp/servers/:serverName'], { gaps: [OPEN_DOC] }),
  [IPC.MCP_PICK_ADF_FILE]: variant('invoke', [], REMOTE_FILE_PICKER, { note: 'Native open dialog in Studio main.' }),
  [IPC.MCP_INSTALL_PYTHON_PACKAGE]: proxied('invoke', ['POST /admin/mcp/packages/python']),
  [IPC.MCP_UNINSTALL_PYTHON_PACKAGE]: proxied('invoke', ['DELETE /admin/mcp/packages/python']),
  [IPC.MCP_ENSURE_PYTHON_RUNTIME]: proxied('invoke', [], { gaps: [gap('W1-D', 'ensure uv and Python on the daemon host (UvManager)')] }),
  [IPC.MCP_REGISTRY_GET]: proxied('invoke', [], { gaps: [gap('W1-D', 'MCP registry (remote-first, cached and bundled fallback)')] }),

  // --- Agent registry --------------------------------------------------------
  [IPC.AGENT_REGISTRY_GET]: proxied('invoke', [], { gaps: [gap('W1-D', 'agent registry listing')] }),
  [IPC.AGENT_REGISTRY_REFRESH]: proxied('invoke', [], { gaps: [gap('W1-D', 'agent registry refresh')] }),
  [IPC.AGENT_REGISTRY_BRING_HOME]: proxied('invoke', [], { gaps: [gap('W1-D', 'bring a registry agent home: copy into the agents folder, strip identity, fresh config.id, default provider')] }),
  [IPC.AGENT_MODEL_SET_FOR_FILE]: proxied('invoke', ['PUT /agents/:id/config'], { gaps: [OPEN_DOC], note: 'Refused for the open file and for a running agent.' }),
  [IPC.MCP_OAUTH_SIGNOUT]: proxied('invoke', [], { gaps: [gap('W1-D', 'MCP OAuth sign-out (app-level store)'), gap('W1-C', 'DaemonAppOAuthStore')] }),
  [IPC.MCP_OAUTH_STATUS]: proxied('invoke', [], { gaps: [gap('W1-D', 'MCP OAuth status (signed-in flag only)'), gap('W1-C', 'DaemonAppOAuthStore')] }),

  // --- Skill catalogs --------------------------------------------------------
  [IPC.SKILLS_CATALOG_GET]: proxied('invoke', [], {
    gaps: [gap('W1-D', 'skills catalog fetch (guardedFetch)')],
    note: 'Network read only. Not Electron-only (D2), and the terminal app reads the same catalogs.',
  }),
  [IPC.SKILLS_PACKAGE_GET]: proxied('invoke', [], { gaps: [gap('W1-D', 'skill package fetch (guardedFetch)')] }),

  // --- Compute ---------------------------------------------------------------
  [IPC.COMPUTE_STATUS]: proxied('invoke', ['GET /compute/status']),
  [IPC.COMPUTE_INIT]: proxied('invoke', ['POST /compute/start']),
  [IPC.COMPUTE_STOP]: proxied('invoke', ['POST /compute/stop']),
  [IPC.COMPUTE_DESTROY]: proxied('invoke', ['POST /compute/destroy']),
  [IPC.COMPUTE_LIST_CONTAINERS]: proxied('invoke', ['GET /compute/containers']),
  [IPC.COMPUTE_STOP_CONTAINER]: proxied('invoke', ['POST /compute/containers/:name/stop']),
  [IPC.COMPUTE_START_CONTAINER]: proxied('invoke', ['POST /compute/containers/:name/start']),
  [IPC.COMPUTE_DESTROY_CONTAINER]: proxied('invoke', ['POST /compute/containers/:name/destroy']),
  [IPC.COMPUTE_REBUILD_CONTAINER]: proxied('invoke', [], { gaps: [gap('W1-D', 'rebuild a container')] }),
  [IPC.COMPUTE_SETUP]: proxied('invoke', ['POST /compute/setup']),
  [IPC.COMPUTE_CONTAINER_DETAIL]: proxied('invoke', ['GET /compute/containers/:name']),
  [IPC.COMPUTE_EXEC_LOG]: proxied('invoke', ['GET /compute/exec-log']),
  [IPC.COMPUTE_TEST_EXECUTION_TARGET]: proxied('invoke', [], { gaps: [gap('W1-D', 'probe an external execution target')] }),
  [IPC.COMPUTE_BROWSER_SESSION]: unsupported('push', [], 'Unsupported in v1: the noVNC URL is the server\'s loopback (§9.3).', {
    frame: 'push:browser_session',
    gaps: [streamTopic('browser_session')],
  }),
  [IPC.COMPUTE_BROWSER_INFO]: unsupported('invoke', [], 'Unsupported in v1: the noVNC port is on the server\'s loopback (§9.3).', {
    gaps: [gap('W1-D', 'container phase and noVNC host port for an agent')],
  }),
  [IPC.COMPUTE_CONTAINER_PHASE]: proxied('push', [], { frame: 'push:compute_phase', gaps: [streamTopic('compute_phase')] }),

  // --- Sandbox packages ------------------------------------------------------
  [IPC.SANDBOX_CHECK_MISSING]: proxied('invoke', ['POST /admin/sandbox/packages/check']),
  [IPC.SANDBOX_INSTALL_PACKAGES]: proxied('invoke', ['POST /admin/sandbox/packages'], { note: 'One route call per package; progress arrives as SANDBOX_INSTALL_PROGRESS.' }),
  [IPC.SANDBOX_INSTALL_PROGRESS]: proxied('push', [], { frame: 'push:sandbox_install', gaps: [gap('W2-B', 'client-stream push topic `sandbox_install`, fed by progress callbacks in the install route')] }),
  [IPC.SANDBOX_LIST_INSTALLED]: proxied('invoke', ['GET /admin/sandbox/packages']),

  // --- Identity / keystore (per agent) ---------------------------------------
  [IPC.IDENTITY_SET]: proxied('invoke', ['PUT /agents/:id/identity/:purpose'], { gaps: [OPEN_DOC], note: 'The derived key of a password-protected file lives in the daemon (§5.4).' }),
  [IPC.IDENTITY_GET]: proxied('invoke', ['GET /agents/:id/identity/:purpose'], { gaps: [OPEN_DOC] }),
  [IPC.IDENTITY_DELETE]: proxied('invoke', ['DELETE /agents/:id/identity/:purpose'], { gaps: [OPEN_DOC] }),
  [IPC.IDENTITY_DELETE_PREFIX]: proxied('invoke', ['DELETE /agents/:id/identity-prefix'], { gaps: [OPEN_DOC] }),
  [IPC.IDENTITY_LIST]: proxied('invoke', ['GET /agents/:id/identity'], { gaps: [OPEN_DOC] }),
  [IPC.IDENTITY_PASSWORD_CHECK]: proxied('invoke', ['GET /agents/:id/identity/password'], { gaps: [OPEN_DOC] }),
  [IPC.IDENTITY_PASSWORD_UNLOCK]: proxied('invoke', ['POST /agents/:id/identity/password/unlock'], {
    gaps: [OPEN_DOC, gap('W1-B', 'the derived key reaches provider, MCP, adapters and AdfCallHandler; restart after unlock')],
    note: 'Embedded converts the owner\'s own legacy file to envelopes on unlock (`converted`).',
  }),
  [IPC.IDENTITY_PASSWORD_SET]: local('invoke', 'Deprecated: embedded always refuses. Daemon mode returns the same refusal and MUST NOT call PUT /agents/:id/identity/password.'),
  [IPC.IDENTITY_PASSWORD_REMOVE]: proxied('invoke', ['DELETE /agents/:id/identity/password'], { gaps: [OPEN_DOC] }),
  [IPC.IDENTITY_PASSWORD_CHANGE]: local('invoke', 'Deprecated: embedded always refuses. Daemon mode returns the same refusal.'),
  [IPC.IDENTITY_LIST_ENTRIES]: proxied('invoke', ['GET /agents/:id/identity/entries'], { gaps: [OPEN_DOC] }),
  [IPC.IDENTITY_REVEAL]: proxied('invoke', ['GET /agents/:id/identity/:purpose'], { gaps: [OPEN_DOC] }),
  [IPC.IDENTITY_WIPE_ALL]: proxied('invoke', ['POST /agents/:id/identity/wipe'], { gaps: [OPEN_DOC] }),
  [IPC.IDENTITY_GET_DID]: proxied('invoke', ['GET /agents/:id/identity/did'], { gaps: [OPEN_DOC] }),
  [IPC.IDENTITY_GENERATE_KEYS]: proxied('invoke', ['POST /agents/:id/identity/generate-keys'], { gaps: [OPEN_DOC], note: 'Embedded also issues owner and operator attestations.' }),
  [IPC.IDENTITY_CLAIM]: proxied('invoke', [], { gaps: [gap('W1-D', 'claim an agent file under the local owner (claimWorkspace)')] }),
  [IPC.IDENTITY_SET_CODE_ACCESS]: proxied('invoke', ['PATCH /agents/:id/identity/:purpose/code-access'], { gaps: [OPEN_DOC] }),

  // --- Owner identity --------------------------------------------------------
  [IPC.IDENTITY_OWNER_STATUS]: proxied('invoke', ['GET /identity'], { note: 'Mapped to the Studio status shape (§5.4).' }),
  [IPC.IDENTITY_OWNER_REVEAL_MNEMONIC]: unsupported('invoke', [], 'Not available; Studio says so (§5.4).', {
    note: 'Local mode: Studio main reads the shared keychain entry (SharedMnemonicStore). No route carries the phrase.',
  }),
  [IPC.IDENTITY_OWNER_CONFIRM_BACKUP]: unsupported('invoke', ['POST /identity/confirm-backup'], 'Refused by the daemon (local-only route); Studio shows its message.'),
  [IPC.IDENTITY_OWNER_IMPORT]: unsupported('invoke', [], 'Refused by the daemon (local-only route); Studio shows its message.', {
    gaps: [gap('W1-C', 'POST /identity/import (local-only): importMnemonic, restamp, reload loaded agents')],
  }),
  [IPC.IDENTITY_ATTESTATIONS_GET]: proxied('invoke', [], { gaps: [gap('W1-D', 'attestations of an agent file')] }),
  [IPC.IDENTITY_ATTESTATIONS_REISSUE]: proxied('invoke', [], { gaps: [gap('W1-D', 'reissue owner and operator attestations')] }),

  // --- Envelope keystore -----------------------------------------------------
  [IPC.IDENTITY_ENVELOPE_STATUS]: proxied('invoke', [], { gaps: [gap('W1-D', 'envelope status (identity, credentials, sharePasswordSet)')] }),
  [IPC.IDENTITY_ENVELOPE_SHARE_SET_PASSWORD]: proxied('invoke', [], { gaps: [gap('W1-D', 'set the credentials share password')] }),
  [IPC.IDENTITY_ENVELOPE_SHARE_REMOVE_PASSWORD]: proxied('invoke', [], { gaps: [gap('W1-D', 'remove the credentials share password')] }),
  [IPC.IDENTITY_ENVELOPE_UNLOCK_PASSWORD]: proxied('invoke', [], { gaps: [gap('W1-D', 'unlock foreign credentials with the share password, adopt or session-only')] }),

  // --- Channel adapters ------------------------------------------------------
  [IPC.ADAPTER_INSTALL_PACKAGE]: proxied('invoke', ['POST /admin/adapters/packages'], { note: 'Progress arrives as ADAPTER_INSTALL_PROGRESS.' }),
  [IPC.ADAPTER_UNINSTALL_PACKAGE]: proxied('invoke', ['DELETE /admin/adapters/packages', 'PATCH /settings'], {
    note: 'Embedded also removes the registration from settings.adapters; the route does not.',
  }),
  [IPC.ADAPTER_LIST_INSTALLED]: proxied('invoke', ['GET /admin/adapters/packages']),
  [IPC.ADAPTER_GET_STATUS]: proxied('invoke', [], { gaps: [gap('W1-D', 'adapter states across all loaded agents, deduped by type, plus perAgent')] }),
  [IPC.ADAPTER_RESTART]: proxied('invoke', [], { gaps: [gap('W1-D', 'restart one adapter of an agent')] }),
  [IPC.ADAPTER_GET_LOGS]: proxied('invoke', ['GET /agents/:id/runtime/adapters'], { note: 'Logs ride in states[].' }),
  [IPC.ADAPTER_INSTALL_PROGRESS]: proxied('push', [], { frame: 'push:adapter_install', gaps: [gap('W2-B', 'client-stream push topic `adapter_install`, fed by progress callbacks in the install route')] }),
  [IPC.ADAPTER_STATUS_CHANGED]: proxied('push', [], { frame: 'push:adapter_status', gaps: [streamTopic('adapter_status')], note: 'Open file only.' }),
  [IPC.ADAPTER_CREDENTIAL_SET]: proxied('invoke', ['PUT /agents/:id/adapters/credentials'], { gaps: [OPEN_DOC] }),
  [IPC.ADAPTER_CREDENTIAL_GET]: proxied('invoke', ['GET /agents/:id/adapters/credentials'], { gaps: [OPEN_DOC], note: 'storedKeys lists rows it cannot decrypt.' }),
  [IPC.ADAPTER_CREDENTIAL_LIST_FILES]: proxied('invoke', [], { gaps: [gap('W1-D', 'adapter credential-list-files across loaded and tracked agents (metadata only)')] }),
  [IPC.ADAPTER_ATTACH]: proxied('invoke', ['POST /agents/:id/adapters'], { gaps: [OPEN_DOC] }),
  [IPC.ADAPTER_DETACH]: proxied('invoke', ['DELETE /agents/:id/adapters/:adapterType'], { gaps: [OPEN_DOC] }),

  // --- Provider credentials (per agent) --------------------------------------
  [IPC.PROVIDER_CREDENTIAL_SET]: proxied('invoke', ['PUT /agents/:id/providers/:providerId/credential'], { gaps: [OPEN_DOC] }),
  [IPC.PROVIDER_CREDENTIAL_GET]: proxied('invoke', ['GET /agents/:id/providers/:providerId/credentials'], { gaps: [OPEN_DOC] }),
  [IPC.PROVIDER_CREDENTIAL_LIST_FILES]: proxied('invoke', [], { gaps: [gap('W1-D', 'provider credential-list-files across loaded and tracked agents (metadata only)')] }),
  [IPC.PROVIDER_ATTACH]: proxied('invoke', ['POST /agents/:id/providers'], { gaps: [OPEN_DOC] }),
  [IPC.PROVIDER_DETACH]: proxied('invoke', ['DELETE /agents/:id/providers/:providerId'], { gaps: [OPEN_DOC] }),
  [IPC.PROVIDER_AGENT_KEY_SOURCES]: proxied('invoke', [], { gaps: [gap('W1-D', 'where each agent provider copy gets its key (agentProviderKeySource), never the key')] }),
  [IPC.PROVIDER_TEST]: proxied('invoke', [], { gaps: [gap('W1-D', 'provider connection test; force bypasses the session cache')] }),

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
  [IPC.MESH_PEER_SHARED_FILE]: proxied('invoke', [], {
    gaps: [gap('W1-D', 'fetch a peer agent shared file (2 MB cap)')],
    note: 'Network read; proxied so it runs on the host that discovered the peer (in remote mode, the server\'s network).',
  }),
  [IPC.MESH_PEER_AGENT_HEALTH]: proxied('invoke', [], { gaps: [gap('W1-D', 'peer agent /health probe')] }),
  [IPC.MESH_FIREWALL_CHECK]: local('invoke', 'The port and LAN binding come from the daemon mesh server, not from Studio main.', {
    reads: ['GET /network/server'],
    remote: 'Hidden: the firewall is the laptop\'s, the mesh server is the server\'s (§9.3).',
  }),
  [IPC.MESH_FIREWALL_APPLY]: local('invoke', 'Elevation prompt from Studio; the port comes from the daemon mesh server.', {
    reads: ['GET /network/server'],
    remote: 'Hidden, as MESH_FIREWALL_CHECK.',
  }),

  // --- Agent review ----------------------------------------------------------
  [IPC.FILE_CHECK_REVIEW]: proxied('invoke', ['GET /agents/review'], {
    gaps: [gap('W2-A', 'review summary parity: identity scenario (deriveReviewIdentity), provider usability, willRelocate and relocateTo')],
  }),
  [IPC.FILE_REVIEW_ACCEPT]: proxied('invoke', ['POST /agents/review/accept'], {
    gaps: [
      gap('W2-A', 'accept parity: claim, model override, auto-locked fields, envelope provisioning (the route only marks the config reviewed)'),
      gap('W1-E', 'move an untracked file into the agents folder on accept (persistAcceptedAgent)'),
    ],
  }),

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

  // --- Overview, emergency stop, identity drafts -----------------------------
  [IPC.AGENT_VITALS]: proxied('invoke', ['GET /agents/:id/vitals']),
  [IPC.AGENT_ACTIVITY]: proxied('invoke', ['GET /agents/:id/activity']),
  [IPC.EMERGENCY_STOP]: proxied('invoke', [], { gaps: [gap('W1-D', 'emergency stop: every agent and the mesh in the daemon, resumable (teardownRuntime emergency)')] }),
  [IPC.IDENTITY_DRAFT_MINT]: proxied('invoke', [], { gaps: [gap('W1-D', 'mint an identity draft; only { draftId, did } leaves the daemon')] }),
  [IPC.IDENTITY_DRAFT_DISCARD]: proxied('invoke', [], { gaps: [gap('W1-D', 'discard an identity draft')] }),

  // --- Raw string channels ---------------------------------------------------
  'stdlib-install-progress': local('push', 'Dead push: no preload or renderer listener. Embedded only; daemon mode sends nothing.'),
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
