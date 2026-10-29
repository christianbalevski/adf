import { BrowserWindow, ipcMain as electronIpcMain, type IpcMain } from 'electron'
import type { BackendDaemonStatus, StudioBackendMode } from '../../../shared/types/backend.types'
import type { DaemonClient } from '../../../shared/daemon-client'
import type { NotificationsSnapshot } from '../../../shared/types/ipc.types'
import { IPC } from '../../../shared/constants/ipc-channels'
import { LOCAL_RUNTIME, NO_RUNTIME_SENTENCE, noticeKey, splitRuntimeTag, type RuntimeId } from '../../../shared/runtime-tag'
import { CHANNEL_MAP, type ChannelEntry, type MappedChannel } from '../channel-map'
import type { AgentLeaseRegistry } from '../../runtime/agent-lease'
import type { SharedMnemonicStore } from '../../services/owner-secret-store'
import { createAdfFileHandler } from './adf-file'
import { ApprovalsAggregator } from './approvals-aggregator'
import { ApprovalsUi } from './approvals-ui'
import type { ClientSession } from './client-stream'
import type { DaemonConnection, DaemonConnector } from './connection'
import type { DaemonInvokeHandler, DaemonModeContext } from './context'
import { DaemonModeUnavailableError } from './errors'
import type { EventBridge } from './event-bridge'
import { DAEMON_MODE_HANDLERS, DAEMON_MODE_SEND_HANDLERS } from './handlers'
import { channelKey, pendingWorkstream } from './pending'
import { samePath, type DaemonModeSession } from './session'
import { ClientSettingsStore, clientSettingsPath } from './settings'
import { REMOTE_MODE_HANDLERS } from './remote/handlers'
import { createRuntimeConnection, type QuitOptions, type RuntimeConnection, type RuntimeShared } from './runtime-connection'
import { RuntimeManager, RuntimeRouteError, SLOT_RUNTIME } from './runtime-manager'
import { buildApplicationMenu } from '../../menu'
import { ADF_WINDOW_HEADER, NoticeOwners } from './windows'
import { LOCAL_LABEL } from '../../../shared/runtime-name'

export { RECOVERY_HINT, remoteWaitingNotice } from './hints'
export {
  AGENT_SESSION_END_TIMEOUT_MS,
  AGENT_WINDOW_STASH_WAIT_MS,
  DAEMON_RESPAWN_DELAY_MS,
  DAEMON_RESPAWN_WINDOW_MS,
  isRemoteAccessRoute,
  TURN_DISCONNECT_GRACE_MS,
} from './runtime-connection'
export { RuntimeManager, RuntimeRouteError } from './runtime-manager'

/**
 * Daemon-mode IPC registration (design D1, §3): the alternative to
 * `registerAllIpcHandlers` when `studio-backend.json` selects `local` (This
 * computer). The renderer and preload are the same in both modes.
 *
 * Every channel of the channel map (channel-map.ts) gets its handler here,
 * except the ones main/index.ts and the services register in both modes
 * (REGISTERED_OUTSIDE):
 *
 * - implemented handlers (handlers/) forward to the daemon or are
 *   Electron-local;
 * - every other invoke channel gets a handler that throws
 *   `DaemonModeUnavailableError` naming the workstream that writes it
 *   (pending.ts), so a call fails visibly instead of with "no handler" or,
 *   worse, against embedded state;
 * - push channels are fed by the event bridge from the client stream.
 *
 * Runtime-aware (docs/design/multi-runtime.md §3, §4): Studio holds one
 * RuntimeConnection per runtime of its runtime set (runtime-connection.ts),
 * kept by a RuntimeManager (runtime-manager.ts). Handlers are registered
 * once; the registrar strips a call's runtime tag and serves it with the
 * context of (sender window, runtime), with the handler variant of that
 * runtime's kind. An untagged call is the primary runtime's, exactly as
 * before. Approvals are merged here (ApprovalsAggregator); the native
 * notifier, the menu bar, the client settings and the menu are Studio's.
 *
 * Nothing here imports the embedded backend (ipc/index.ts, the background
 * agent manager, the runtime): Studio main reads no embedded module state in
 * daemon mode (tests/backend/daemon-mode-isolation.test.ts).
 */

/** Registered in both modes outside the backend registration (main/index.ts, app-updater, spellcheck, orbital cache, backend settings, secret storage, edit recovery). */
export const REGISTERED_OUTSIDE: readonly MappedChannel[] = [
  IPC.OPEN_FILE_GET_PENDING,
  IPC.APP_GET_FULLSCREEN,
  IPC.APP_SET_FULLSCREEN,
  IPC.APP_UPDATE_GET_STATE,
  IPC.APP_UPDATE_CHECK,
  IPC.APP_UPDATE_DOWNLOAD,
  IPC.APP_UPDATE_INSTALL,
  IPC.SPELLCHECK_DOWNLOAD,
  IPC.ORBITAL_CACHE_GET,
  IPC.ORBITAL_CACHE_PUT,
  IPC.BACKEND_SETTINGS_GET,
  IPC.BACKEND_SETTINGS_SET,
  IPC.STUDIO_SECRET_STORAGE_GET,
  IPC.STUDIO_SECRET_STORAGE_USE_KEYRING,
  IPC.RECOVERY_STASH,
  IPC.RECOVERY_LIST,
  IPC.RECOVERY_ARCHIVE,
  IPC.RECOVERY_REVEAL,
  IPC.BACKEND_RESTART_STUDIO,
  IPC.REMOTE_ACCESS_GET,
  IPC.REMOTE_ACCESS_SET,
  IPC.REMOTE_ACCESS_SHARE,
  IPC.REMOTE_ACCESS_SHARE_LEAVE,
  IPC.REMOTE_ACCESS_DEVICE_ADD,
  IPC.REMOTE_ACCESS_DEVICE_REMOVE,
  IPC.REMOTE_ACCESS_PAIRING_OPEN,
  IPC.REMOTE_ACCESS_PAIRING_CLOSE,
  IPC.REMOTE_ACCESS_TAILSCALE_SERVE,
  IPC.REMOTE_DISCOVERY_START,
  IPC.REMOTE_DISCOVERY_STOP,
  IPC.REMOTE_PAIR_START,
  IPC.REMOTE_PAIR_SUBMIT_CODE,
  IPC.REMOTE_PAIR_CANCEL,
  IPC.CONNECTION_LIST,
  IPC.CONNECTION_USE,
  IPC.CONNECTION_ADD,
  IPC.CONNECTION_REMOVE,
  IPC.NETWORK_STATUS_GET,
  IPC.NETWORK_ALLOW,
  IPC.NETWORK_FORGET,
  IPC.NETWORK_NOTICES_GET,
  IPC.NETWORK_NOTICE_DISMISS,
  IPC.WINDOW_OPEN_AGENT,
  IPC.WINDOW_CLOSE,
  IPC.WINDOW_OPEN_FAILED,
  IPC.WINDOW_OPEN_SETTINGS,
  IPC.WINDOW_STASH_DONE,
  IPC.WINDOW_QUEUE_SYNC,
  IPC.WINDOW_QUEUE_GET,
  IPC.QUEUE_HANDOVER_TAKE,
  IPC.WINDOW_LIST_AGENTS,
  IPC.MENU_ACTION_TAKE_PENDING,
]

/**
 * The approvals list's calls (§6.1): a window answers a request of any
 * runtime, so a tag names the asking runtime even from an agent window of
 * another one (`local` included). Untagged, an agent window's call is its
 * own runtime's, as every call.
 */
const ANY_RUNTIME_CHANNELS: ReadonlySet<string> = new Set([IPC.APPROVALS_LIST, IPC.APPROVALS_RESOLVE, IPC.APPROVALS_GET_INPUT])

/** Main-window calls that open a file on their runtime: that runtime holds the main window's open agent (§4.3). */
const MAIN_OPEN_CHANNELS: ReadonlySet<string> = new Set([IPC.FILE_OPEN, IPC.FILE_CREATE, IPC.FILE_CREATE_QUICK])

export interface DaemonModeDeps {
  /**
   * The primary runtime's kind. Studio's boot always passes `local` (This
   * computer; multi-runtime.md §7.1). `remote` is a test seam only: the
   * harness of the remote handler variants (tests/parity/remote,
   * tests/backend/daemon-mode-remote*.test.ts) runs one remote daemon as
   * the primary; no Studio launch reaches it.
   */
  mode: Exclude<StudioBackendMode, 'embedded'>
  /** Finds or starts the daemon (local: daemon-process.ts; remote: URL + token). */
  connect: DaemonConnector
  /** Studio's userData (studio-client-settings.json lives here). */
  userDataDir: string
  /** Applied to studio-client-settings.json as it is loaded (ClientSettingsStore `migrate`). */
  clientSettingsMigration?: ((data: Record<string, unknown>) => string[]) | null
  /** `mainWindow`: the main window (pushes not addressed to an agent window go there); default the first window. */
  hooks?: {
    showMainWindow?: () => BrowserWindow | null
    openFile?: (filePath: string) => void
    /** Open Recent of another runtime: open `filePath` on `runtimeId` in the main window (multi-runtime.md §6.6). */
    openFileOn?: (runtimeId: RuntimeId, filePath: string) => void
    mainWindow?: () => BrowserWindow | null
    /** Close an agent window whose runtime left the set; `keep`: its runtime is being replaced, the window reopens once it connects. */
    closeAgentWindow?: (webContentsId: number, keep: boolean) => void
    /** The runtime set, its order, or the state of a runtime other than the primary changed (multi-runtime.md §4.5). */
    runtimesChanged?: () => void
    /** A runtime other than the primary connected for the first time since its RuntimeConnection was created: its saved agent windows reopen (§7.5). */
    runtimeConnected?: (id: RuntimeId) => void
    /** A runtime moved to `to` (§20 item 1): its saved agent windows are `to`'s now; `connected`: `to` is connected already. */
    runtimeMoved?: (from: RuntimeId, to: RuntimeId, connected: boolean) => void
  }
  log?: Pick<Console, 'log' | 'warn' | 'error'>
  /** Agent lease registry (tests); defaults to the process registry. */
  leases?: Pick<AgentLeaseRegistry, 'registerClient'>
  ipcMain?: Pick<IpcMain, 'handle' | 'on'>
  fetch?: typeof fetch
  /** The client session implementation. Default: the daemon's client sessions (W2-B). */
  createSession?: (client: DaemonClient) => ClientSession
  /**
   * studio-backend.json `keepDaemonRunning` (§8.3), read at quit (a getter:
   * Settings → Connections changes it for the next quit). Off in local mode, the
   * session is opened with `exitDaemonWhenClosed` (the value at launch), so
   * a crashed Studio's daemon stops once its session expires and no other
   * client is open; a quit stops a daemon Studio started when no other
   * client session is open.
   */
  keepDaemonRunning?: boolean | (() => boolean)
  /**
   * The boot handover (handover.ts) changed the daemon's credential stores:
   * once connected, ask the daemon to reload them (POST
   * /client/reload-credentials), for a daemon that was already running.
   */
  reloadCredentials?: boolean
  /** Tests (parity harness): where the OAuth relay listens, and pages exempt from the public-address rule. */
  remoteOAuth?: { bindHost?: string; allowPage?: (url: URL) => boolean }
  /** The shared owner-phrase keychain entry (tests: a stand-in). Default: the OS keychain's. */
  sharedMnemonic?: () => SharedMnemonicStore | null
  /** Tests: whether the daemon's pid is alive (local mode exit detection). Default: process liveness. */
  processAlive?: (pid: number) => boolean
  /** Tests: wait for the daemon's pid to exit (a restart into Inside Studio). Default: daemon-exit.ts waitForDaemonExit. */
  waitForExit?: (pid: number, budgetMs: number) => Promise<boolean>
  /** Tests: the pause after the daemon exited before Studio starts it again, or shows the exit (default DAEMON_RESPAWN_DELAY_MS). */
  respawnDelayMs?: number
  /**
   * Electron's powerMonitor (main/index.ts passes it): on `resume` the
   * daemon is checked and the client stream re-dialed at once. Absent: no
   * resume handling (tests, the parity harness).
   */
  powerMonitor?: Pick<Electron.PowerMonitor, 'on' | 'removeListener'> | null
  /** Local mode: rewrite Studio's runtime identity entry after an owner import (DaemonModeContext.afterOwnerImport). */
  afterOwnerImport?: (phrase: string) => Promise<string>
  /** Tests: Studio's restarts after This computer's daemon failed. Default: relaunchStudio / relaunchEmbeddedForSession (boot-handover.ts). */
  relaunch?: { reconnect(reason: string): void; embeddedForSession(reason: string): void }
  /** How long a restart waits for the window to keep its unsaved editors and restart itself. Default 15 s. */
  stashWaitMs?: number
  /** The daemon's `remote_access` push (remote-access.md §8), for Settings → Networking → Remote access. */
  onRemoteAccessEvent?: (payload: unknown) => void
  /** Local mode: the local runtime's name, `<name> (Local)` (local-runtime-name.ts); default "Local". */
  localName?: () => string
  /** A remote primary (tests only): the connection's name, for "Stored on <name>." and "Open on <name>." (settings-scopes.md §7). */
  runtimeName?: () => string | null
  /** A remote primary's id (tests only; multi-runtime.md §1.3): `remote:<name>`, or `remote` (the default). */
  runtimeId?: RuntimeId
  /**
   * The saved connections as runtimes (§3.1). The caller calls
   * `runtimes.sync(saved, slot)` at launch and whenever the saved
   * connections change. Absent (tests): the runtime set is the primary only.
   */
  runtimeSet?: {
    /** The connector of a saved connection (remote/connector.ts with `remote.name`). */
    connectorFor(name: string): DaemonConnector
    /** The connector of the remote slot of studio-backend.json (a connection without a fingerprint). */
    slotConnector?(): DaemonConnector
    /** studio-backend.json `runtimeOrder` as read at launch (§3.1). */
    initialOrder?: readonly RuntimeId[]
    /** The order changed: save it (written only when it changes). */
    onOrder?(order: RuntimeId[]): void
    /** Tests: per-runtime fetch and client sessions. */
    overrides?(name: string): Partial<Pick<DaemonModeDeps, 'fetch' | 'createSession'>>
  }
}

export interface DaemonModeHandle {
  /** Channels registered here, implemented or pending. */
  registered: MappedChannel[]
  /** Invoke channels registered with the visible "not available yet" handler (for the primary runtime's kind). */
  pending: Array<{ channel: MappedChannel; workstream: string }>
  connection: DaemonConnection
  session: DaemonModeSession
  bridge: EventBridge
  clientSettings: ClientSettingsStore
  /** Resolves once connected and the client stream started; false when no daemon could be reached. */
  ready: Promise<boolean>
  /** `protocol.handle('adf-file', …)` in daemon mode. */
  adfFile(request: Request): Promise<Response>
  /** Drop the client stream connection and reconnect now (Help > Reconnect). */
  reconnect(): void
  /** Settings → Connections: the daemon this session uses and the connection state. */
  status(): BackendDaemonStatus
  /** The daemon's client once connected (remote-access management routes); rejects when there is no daemon. */
  client(): Promise<DaemonClient>
  /** keepDaemonRunning changed in Settings: the session's crash behaviour follows it (exitDaemonWhenClosed). */
  setKeepDaemonRunning(keep: boolean): Promise<void>
  /**
   * Studio's quit path in daemon mode (§8.3): end the client session; with
   * `keepDaemonRunning` off, This computer's daemon stops when Studio
   * started it and no other client session is open (the daemon decides,
   * POST /client/sessions/:id/quit). `keepDaemonRunning`: this quit only,
   * the answer to the quit question about connected computers
   * (remote-access.md §3.6). Every other runtime ends its sessions in
   * parallel; its daemon keeps running (multi-runtime.md §3.3).
   */
  shutdown(opts?: QuitOptions): Promise<void>
  /** Agent windows (docs/design/agent-windows.md): each one is its own client session. */
  windows: DaemonWindows
  /** The runtime set (multi-runtime.md §3.2). */
  runtimes: RuntimeManager
}

/** An agent window as daemon mode sees it: its webContents. */
export interface WindowTarget {
  /** The webContents id: IPC calls whose sender has it are served by this window's session. */
  id: number
  send(channel: string, ...args: unknown[]): void
  focused(): boolean
}

export interface DaemonWindows {
  /** A new agent window on `runtimeId` (default the primary runtime): opens its client session there. Call before its page loads. */
  open(target: WindowTarget, runtimeId?: RuntimeId | null): void
  /** The window closed: its documents are released and its session ends. */
  close(id: number): Promise<void>
  /** The file the window's session has open (it follows renames), or null. */
  current(id: number): { filePath: string; agentId: string | null } | null
  /**
   * The runtime this Studio is connected to, as saved with the agent windows:
   * `local`, or `remote:<name or URL>`; null for an unnamed remote not
   * connected yet (the list is then neither read nor written).
   */
  runtime(): string | null
  /** The runtime id an agent window is bound to; null for the primary runtime or an unknown window. */
  runtimeOf(id: number): RuntimeId | null
  /** The webContents id of the agent window that shows this request's notice, or null (the main window). */
  noticeOwner(notificationId: string, runtimeId?: RuntimeId): number | null
  /** The agent window kept its unsaved editor text (answer to the `stash-edits` menu action). */
  stashed(id: number): void
}

function isInvoke(entry: ChannelEntry): boolean {
  return entry.kind === 'invoke'
}

/** The handler of a channel for a runtime of `kind` (M5): the remote variant first for a remote, else the shared one. */
function handlerFor(kind: 'local' | 'remote', channel: MappedChannel): DaemonInvokeHandler | undefined {
  return (kind === 'remote' ? REMOTE_MODE_HANDLERS[channel] : undefined) ?? DAEMON_MODE_HANDLERS[channel]
}

export function registerDaemonModeHandlers(deps: DaemonModeDeps): DaemonModeHandle {
  const log = deps.log ?? console
  const ipc = deps.ipcMain ?? electronIpcMain
  const hooks = deps.hooks ?? {}
  const primaryId: RuntimeId = deps.mode === 'local' ? LOCAL_RUNTIME : deps.runtimeId ?? 'remote'

  // The client keys were moved into the client file by the switch (handover.ts, at boot).
  const clientSettings = new ClientSettingsStore(clientSettingsPath(deps.userDataDir), log, { migrate: deps.clientSettingsMigration ?? null })

  const firstWindow = (): BrowserWindow | null => {
    if (hooks.mainWindow) return hooks.mainWindow()
    const windows = BrowserWindow.getAllWindows()
    return windows.length > 0 ? windows[0] : null
  }
  const browserWindowOf = (id: number): BrowserWindow | null =>
    BrowserWindow.getAllWindows().find((win) => !win.isDestroyed() && win.webContents.id === id) ?? null

  // eslint-disable-next-line prefer-const
  let manager: RuntimeManager
  const closedWindows = new Set<number>()
  const aggregator = new ApprovalsAggregator(primaryId)
  /** Path equality under the runtime's rule: case-folded on Windows for This computer, exact for a remote (§1.3). */
  const samePathOn = (a: string | null, b: string | null, runtimeId?: RuntimeId): boolean =>
    samePath(a, b, (manager?.get(runtimeId)?.kind ?? deps.mode) === 'remote')
  const noticeOwners = new NoticeOwners(samePathOn)
  /** Every window as the notice rule sees it: the main window shows the main window's open file. */
  const windowViews = () => {
    if (!manager) return []
    const main = firstWindow()
    const focused = BrowserWindow.getFocusedWindow()
    return manager.windowViews(main && !main.isDestroyed() ? { id: main.webContents.id, focused: focused === main } : null)
  }
  const sendAll = (channel: string, ...args: unknown[]): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue
      try { win.webContents.send(channel, ...args) } catch { /* window going away */ }
    }
  }
  /**
   * The merged approvals snapshot to every window (an aggregate push, never
   * tagged). With agent windows open, each copy names the requests whose
   * notice that window shows (`notify`); with none, the push is exactly
   * embedded's.
   */
  const publishApprovals = (snapshot: NotificationsSnapshot): void => {
    if (!manager || manager.windowCount() === 0) { sendAll(IPC.APPROVALS_CHANGED, snapshot); return }
    const main = firstWindow()
    if (main && !main.isDestroyed() && !main.webContents.isDestroyed()) {
      try { main.webContents.send(IPC.APPROVALS_CHANGED, { ...snapshot, notify: noticeOwners.idsFor(main.webContents.id) }) } catch { /* window going away */ }
    }
    for (const rt of manager.runtimes()) {
      for (const id of rt.windows.ids()) rt.windows.send(id, IPC.APPROVALS_CHANGED, { ...snapshot, notify: noticeOwners.idsFor(id) })
    }
  }
  /** The merged snapshot: notice windows first, then the native notifier and the menu bar. */
  const applyMerged = (): NotificationsSnapshot => {
    const merged = aggregator.merged()
    noticeOwners.assign(merged.pending ?? [], windowViews())
    approvals.apply(merged)
    return merged
  }
  /** The agent window whose notice key this is, with its runtime. */
  const agentWindowOf = (key: string): { id: number; runtime: RuntimeConnection } | null => {
    const owner = noticeOwners.owner(key)
    const runtime = owner === null || !manager ? null : manager.runtimeOfWindow(owner)
    return runtime && owner !== null ? { id: owner, runtime } : null
  }

  const approvals = new ApprovalsUi({
    mainWindow: firstWindow,
    // The agent window that owns the notice, else one that shows the agent: the main window stays where it is.
    revealWindow: ({ notificationId, filePath, runtimeId }) => {
      const owner = notificationId ? agentWindowOf(noticeKey(runtimeId, notificationId)) : null
      if (owner) return browserWindowOf(owner.id)
      const rt = filePath && manager ? manager.get(runtimeId) : null
      if (!rt || !filePath) return null
      const showing = rt.windows.ids().find((id) => {
        const s = rt.windows.session(id)
        return !!s && s.samePath(s.filePath, filePath)
      })
      return showing === undefined ? null : browserWindowOf(showing)
    },
    noticeFocused: (entry) => {
      const owner = noticeOwners.owner(noticeKey(entry.runtimeId, entry.id))
      const rt = owner === null || !manager ? null : manager.runtimeOfWindow(owner)
      if (rt && owner !== null) return rt.windows.focused(owner)
      if (!manager || manager.windowCount() === 0) return BrowserWindow.getFocusedWindow() !== null
      const main = firstWindow()
      return !!main && BrowserWindow.getFocusedWindow() === main
    },
    notificationsEnabled: () => clientSettings.get('nativeNotificationsEnabled') !== false,
    // Every OS notification names its runtime while there is more than one (§6.1); This computer is named too.
    runtimeName: (runtimeId) => {
      if (!manager || manager.runtimes().length < 2) return null
      return manager.get(runtimeId)?.name() ?? runtimeId ?? null
    },
    menuBarEnabled: () => clientSettings.get('menuBarEnabled') !== false,
    // The macOS menu bar's first refresh runs inside this constructor, before any runtime exists: no agents yet.
    agents: () => manager ? manager.runtimes().flatMap((rt) => rt.menuBarAgents()) : [],
    foreground: () => manager ? manager.mainOpenRuntime().foreground() : null,
    tokensToday: () => {
      if (!manager) return { input: 0, output: 0 }
      return manager.runtimes().reduce((sum, rt) => {
        const t = rt.tokensToday()
        return { input: sum.input + t.input, output: sum.output + t.output }
      }, { input: 0, output: 0 })
    },
    showMainWindow: hooks.showMainWindow,
    openFile: hooks.openFile,
    ...(hooks.openFileOn ? { openFileOn: hooks.openFileOn } : {}),
    log,
  })

  /** `from` is the connection of runtime `runtimeId` in the set (not one that retires or was replaced). The primary's constructor runs before the manager exists. */
  const current = (runtimeId: RuntimeId, from: DaemonConnection): boolean => !manager ? runtimeId === primaryId : manager.get(runtimeId)?.connection === from
  const shared: RuntimeShared = {
    clientSettings,
    approvals,
    hooks,
    firstWindow,
    approvalsIn: (runtimeId, snapshot, from) => {
      if (!current(runtimeId, from)) return
      aggregator.set(runtimeId, snapshot)
      applyMerged()
    },
    publishApprovals: (runtimeId, snapshot, from) => {
      if (!current(runtimeId, from)) return
      aggregator.set(runtimeId, snapshot)
      publishApprovals(aggregator.merged())
    },
    closedWindows,
    windowClosed: (windowId) => {
      const main = firstWindow()
      noticeOwners.moveTo(windowId, main && !main.isDestroyed() ? main.webContents.id : null)
    },
    // The primary's menu is built in its constructor, before the manager exists: the primary alone then.
    menuRuntimes: () => (manager ? manager.runtimes() : []).map((rt) => ({
      id: rt.id,
      name: rt.name(),
      primary: rt.primary,
      problem: rt.problem(),
      canReconnect: rt.canReconnect(),
      reconnect: () => rt.reconnect(),
    })),
  }

  const primary = createRuntimeConnection({
    id: primaryId,
    kind: deps.mode,
    primary: true,
    name: () => deps.mode === 'local' ? deps.localName?.() || LOCAL_LABEL : deps.runtimeName?.() || primaryId,
    deps,
    shared,
  })
  manager = new RuntimeManager({
    primary,
    closedWindows,
    log,
    ...(deps.runtimeSet?.initialOrder ? { initialOrder: deps.runtimeSet.initialOrder } : {}),
    ...(deps.runtimeSet?.onOrder ? { onOrder: (order: RuntimeId[]) => deps.runtimeSet!.onOrder!(order) } : {}),
    create: (id, name) => {
      const set = deps.runtimeSet
      if (!set) throw new Error(`${id}: this Studio has no runtime set (remote mode)`)
      if (id === SLOT_RUNTIME && !set.slotConnector) throw new Error(`${id}: this Studio has no connector for the remote slot`)
      const runtime = createRuntimeConnection({
        id,
        kind: 'remote',
        primary: false,
        name: () => name,
        deps: {
          ...deps,
          mode: 'remote',
          connect: id === SLOT_RUNTIME ? set.slotConnector!() : set.connectorFor(name),
          runtimeName: () => name,
          runtimeId: id,
          reloadCredentials: false,
          afterOwnerImport: undefined,
          onRemoteAccessEvent: undefined,
          keepDaemonRunning: false,
          ...set.overrides?.(name),
        },
        shared,
        recreate: () => { void manager.replace(id, runtime) },
      })
      // Its state shows in the runtime list (CONNECTION_CHANGED, §4.5) and the Help menu (§6.6).
      let connected = false
      runtime.connection.onState((state) => {
        hooks.runtimesChanged?.()
        buildApplicationMenu()
        // Its saved agent windows reopen once it first connects (§7.5).
        if (state.state === 'connected' && !connected) {
          connected = true
          hooks.runtimeConnected?.(id)
        }
      })
      return runtime
    },
    closeWindow: (windowId, keep) => hooks.closeAgentWindow?.(windowId, keep),
    onMoved: (from, to) => hooks.runtimeMoved?.(from, to, manager.get(to)?.connection.state.state === 'connected'),
    onChange: () => hooks.runtimesChanged?.(),
    onRemoved: (id) => {
      if (!aggregator.delete(id)) return
      publishApprovals(applyMerged())
    },
  })

  /**
   * §4.3: the context of a call, or the refusal. `scope` `studio` (and
   * `aggregate`) refuses a tag: Studio has one of each.
   */
  const route = (channel: MappedChannel, entry: ChannelEntry, event: { sender?: { id?: number } } | undefined, raw: unknown[]): { ctx: DaemonModeContext; args: unknown[] } => {
    const { runtimeId, args } = splitRuntimeTag(raw)
    if (runtimeId !== null && entry.scope !== 'runtime') {
      log.warn(`[IPC] ${channelKey(channel)} was called with a runtime tag (${runtimeId}); it is a Studio call and has no runtime`)
      throw new RuntimeRouteError(NO_RUNTIME_SENTENCE)
    }
    const ctx = manager.contextFor(event?.sender?.id, runtimeId, { anyRuntime: ANY_RUNTIME_CHANNELS.has(channel) })
    // The main window's session resync (a reload) asks the runtime of its open agent (§4.3); the answer names it.
    if (channel === IPC.FILE_GET_CURRENT && runtimeId === null && !isAgentWindow(event)) return { ctx: manager.mainOpenRuntime().ctx, args }
    return { ctx, args }
  }
  /**
   * The number of the latest main-window open (FILE_OPEN, FILE_CREATE, FILE_CREATE_QUICK), on any runtime. FILE_CLOSE
   * does not count: the renderer closes an overtaken open on its runtime after the later open was called.
   */
  let mainOpenSeq = 0
  const isAgentWindow = (event: { sender?: { id?: number } } | undefined): boolean => {
    const id = event?.sender?.id
    return id !== undefined && manager.runtimeOfWindow(id) !== null
  }

  const registered: MappedChannel[] = []
  const pending: Array<{ channel: MappedChannel; workstream: string }> = []
  for (const [channel, entry] of Object.entries(CHANNEL_MAP) as Array<[MappedChannel, ChannelEntry]>) {
    if (REGISTERED_OUTSIDE.includes(channel)) continue
    if (entry.kind === 'send') {
      const sendHandler = DAEMON_MODE_SEND_HANDLERS[channel]
      if (sendHandler) {
        ipc.on(channel, (event, ...raw) => {
          let call: { ctx: DaemonModeContext; args: unknown[] }
          try {
            call = route(channel, entry, event, raw)
          } catch (err) {
            // A send has no answer: the refusal is logged (closed agent windows' sends are dropped quietly, as before).
            if (err instanceof RuntimeRouteError && err.message !== 'This agent window is closed.') log.warn(`[IPC] ${channelKey(channel)} dropped: ${err.message}`)
            return
          }
          sendHandler(call.ctx, event as Electron.IpcMainEvent, ...call.args)
        })
        registered.push(channel)
        continue
      }
      const workstream = pendingWorkstream(channel)
      ipc.on(channel, () => {
        log.error(`[Backend] ${channelKey(channel)} is not available in daemon mode yet: ${workstream}`)
      })
      registered.push(channel)
      pending.push({ channel, workstream })
      continue
    }
    if (!isInvoke(entry)) continue
    const anyHandler = handlerFor('local', channel) ?? handlerFor('remote', channel)
    if (!handlerFor(deps.mode, channel)) pending.push({ channel, workstream: pendingWorkstream(channel) })
    if (anyHandler) {
      let warned = false
      ipc.handle(channel, (event, ...raw) => {
        const { ctx, args } = route(channel, entry, event, raw)
        // M5: the variant follows the runtime's kind in main's table, never the renderer.
        const handler = handlerFor(ctx.mode, channel)
        if (!handler) {
          const workstream = pendingWorkstream(channel)
          if (!warned) {
            warned = true
            log.warn(`[Backend] ${channelKey(channel)} was called; it is not available in daemon mode yet: ${workstream}`)
          }
          throw new DaemonModeUnavailableError(channelKey(channel), workstream)
        }
        // The main window's open agent is on the runtime of its latest open (§4.3; R2A-5): each main-window open is
        // numbered when it is called, on any runtime, and applied when it resolves only while it is still the latest.
        // One on the runtime the window is on already applies too, so an overtaken open elsewhere cannot move it.
        const mainOpen = MAIN_OPEN_CHANNELS.has(channel) && ctx.runtime && !isAgentWindow(event) ? { id: ctx.runtime.id, seq: ++mainOpenSeq } : null
        const result = handler(ctx, event, ...args)
        if (mainOpen) {
          void Promise.resolve(result).then((r) => {
            // R3B-5: an open or create that failed opened nothing there.
            if ((r as { success?: unknown } | null)?.success !== true) return
            if (mainOpen.seq === mainOpenSeq) manager.setMainOpenRuntime(mainOpen.id)
            else log.log(`[Runtimes] A main-window open on ${mainOpen.id} was overtaken by a later one; the main window stays on ${manager.mainOpenRuntime().id}`)
          }, () => {})
        }
        // The file is on a runtime other than This computer: the renderer reopens it there.
        if (channel === IPC.FILE_GET_CURRENT && ctx.runtime && !ctx.runtime.primary) {
          const runtimeId = ctx.runtime.id
          return Promise.resolve(result).then((r) => (r && typeof r === 'object' && (r as { filePath?: unknown }).filePath ? { ...r, runtimeId } : r))
        }
        return result
      })
    } else {
      const workstream = pendingWorkstream(channel)
      let warned = false
      ipc.handle(channel, () => {
        // Once per channel: renderer call sites that swallow the rejection
        // (docs/design/daemon-backend-gaps.md) leave only this line.
        if (!warned) {
          warned = true
          log.warn(`[Backend] ${channelKey(channel)} was called; it is not available in daemon mode yet: ${workstream}`)
        }
        throw new DaemonModeUnavailableError(channelKey(channel), workstream)
      })
    }
    registered.push(channel)
  }
  log.log(`[Backend] ${deps.mode} daemon mode: ${registered.length - pending.length} channels implemented, ${pending.length} answer "not available in daemon mode yet"`)

  // An agent window's request carries its webContents id (main/index.ts sets the header); the main window's
  // is served by the runtime of its open file (§4.4).
  const adfFile = createAdfFileHandler({
    session: primary.session,
    targetFor: (request) => {
      const id = Number(request.headers.get(ADF_WINDOW_HEADER))
      const rt = manager.runtimeOfWindow(id)
      const session = rt?.windows.session(id)
      if (rt && session) return { session, connection: rt.connection, fetch: rt.fetch }
      const main = manager.mainOpenRuntime()
      return { session: main.session, connection: main.connection, fetch: main.fetch }
    },
    connection: primary.connection,
    fetch: deps.fetch,
    log,
  })

  let shutdownPromise: Promise<void> | null = null
  const shutdown = (opts: QuitOptions = {}): Promise<void> => {
    shutdownPromise ??= (() => {
      const done = manager.shutdown(opts)
      approvals.dispose()
      return done
    })()
    return shutdownPromise
  }

  return {
    registered,
    pending,
    connection: primary.connection,
    session: primary.session,
    bridge: primary.bridge,
    clientSettings,
    ready: primary.ready,
    adfFile,
    reconnect: primary.reconnect,
    status: primary.status,
    client: primary.client,
    setKeepDaemonRunning: primary.setKeepDaemonRunning,
    shutdown,
    runtimes: manager,
    windows: {
      open: (target, runtimeId) => manager.openWindow(target, runtimeId),
      close: (id) => manager.closeWindow(id),
      current: (id) => manager.runtimeOfWindow(id)?.windows.current(id) ?? null,
      runtime: () => {
        if (deps.mode === 'local') return 'local'
        const name = deps.runtimeName?.() || primary.connection.baseUrl
        return name ? `remote:${name}` : null
      },
      runtimeOf: (id) => {
        const rt = manager.runtimeOfWindow(id)
        return rt && !rt.primary ? rt.id : null
      },
      noticeOwner: (notificationId, runtimeId) => agentWindowOf(noticeKey(runtimeId, notificationId))?.id ?? null,
      stashed: (id) => { manager.runtimeOfWindow(id)?.windows.stashed(id) },
    },
  }
}
