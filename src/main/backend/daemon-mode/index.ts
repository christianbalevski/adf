import { app, BrowserWindow, dialog, ipcMain as electronIpcMain, shell, type IpcMain } from 'electron'
import { join } from 'node:path'
import type { BackendDaemonStatus, StudioBackendMode } from '../../../shared/types/backend.types'
import { DaemonError, type AgentStatus, type AgentSummary, type DaemonClient } from '../../../shared/daemon-client'
import type { NotificationsSnapshot } from '../../../shared/types/ipc.types'
import { IPC } from '../../../shared/constants/ipc-channels'
import { BACKEND_ENV_OVERRIDE } from '../backend-config'
import { CHANNEL_MAP, type ChannelEntry, type MappedChannel } from '../channel-map'
import { processAgentLeases, type AgentLeaseRegistry } from '../../runtime/agent-lease'
import { openSharedMnemonicStore, type SharedMnemonicStore } from '../../services/owner-secret-store'
import { isLocalOnlyRoute, LOCAL_PROOF_HEADER, readLocalProof } from '../../daemon/local-access'
import { BackgroundEventBatcher } from '../../ipc/background-event-batch'
import { initApplicationMenu, recordRecentFile } from '../../menu'
import { relaunchEmbeddedForSession, relaunchStudio } from '../mode-switch'
import { createAdfFileHandler } from './adf-file'
import { ApprovalsUi } from './approvals-ui'
import { createDaemonClientSession, type ClientQuitAnswer, type ClientSession } from './client-stream'
import { DaemonConnection, type DaemonConnector } from './connection'
import { findRunningAgent, type DaemonModeContext } from './context'
import { DaemonModeUnavailableError } from './errors'
import { EventBridge } from './event-bridge'
import { DAEMON_MODE_HANDLERS, DAEMON_MODE_SEND_HANDLERS } from './handlers'
import { channelKey, pendingWorkstream } from './pending'
import { DaemonModeSession } from './session'
import { ClientSettingsStore, clientSettingsPath } from './settings'
import type { DaemonVersionInfo } from '../../daemon/routes/meta-routes'
import { waitForDaemonExit } from './daemon-exit'
import { InstallProgressRelay } from './mcp/install-progress'
import { McpOAuthAuthorizeOpener } from './mcp/oauth-authorize'
import { ConnectionStatusUi, connectionProblem, openDaemonLog } from './status-ui'
import { REMOTE_MODE_HANDLERS } from './remote/handlers'
import { REMOTE_WAITING_PREFIX } from './remote/connector'
import { OAuthCallbackRelay } from './remote/oauth-relay'
import { RemotePicker } from './remote/picker'
import { uploadFile, type RemoteServices } from './remote/services'

/**
 * Daemon-mode IPC registration (design D1, §3): the alternative to
 * `registerAllIpcHandlers` when `studio-backend.json` selects `local` or
 * `remote`. The renderer and preload are the same in both modes.
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
 * Nothing here imports the embedded backend (ipc/index.ts, the background
 * agent manager, the runtime): Studio main reads no embedded module state in
 * daemon mode (tests/backend/daemon-mode-isolation.test.ts).
 */

/** Registered in both modes outside the backend registration (main/index.ts, app-updater, spellcheck, orbital cache, backend settings, edit recovery). */
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
  IPC.RECOVERY_STASH,
  IPC.RECOVERY_LIST,
  IPC.RECOVERY_ARCHIVE,
  IPC.RECOVERY_REVEAL,
  IPC.BACKEND_REMOTE_CHECK,
  IPC.BACKEND_RESTART_STUDIO,
]

export const RECOVERY_HINT = `To run agents in Studio instead, choose Embedded in Settings → Backend (Studio restarts), or start Studio with ${BACKEND_ENV_OVERRIDE}=embedded for one session (sign-ins and the runtime identity then stay with the daemon).`

/**
 * The one notification while Studio waits for an unreachable remote daemon,
 * from the connector's progress line "Waiting for the remote ADF daemon at
 * <url> (attempt n; …): <reason>". The URL holds colons, so the line is cut
 * at " (attempt ".
 */
export function remoteWaitingNotice(progress: string): string {
  const at = progress.indexOf(' (attempt ')
  return `${at > 0 ? progress.slice(0, at) : REMOTE_WAITING_PREFIX}. Studio keeps trying.`
}

/** Remote mode: Settings → Backend works without a daemon, so the URL, the token or the mode can be fixed there. */
export const REMOTE_RECOVERY_HINT = `Settings → Backend works without the daemon: fix the remote daemon's URL or token there and use Test connection, or choose Embedded. ${RECOVERY_HINT}`

/** COMPUTE_BROWSER_SESSION in remote mode (§9.3): the viewer is on the server's loopback, never opened here. */
export const REMOTE_BROWSER_SESSION_SENTENCE = 'opened a browser in its container on the daemon host. Its viewer is on that host\'s loopback, so Studio cannot show it here; use a tunnel to the container\'s noVNC port, or Studio on that host.'

/** How long a lost daemon connection may last before waiting chats are ended. */
export const TURN_DISCONNECT_GRACE_MS = 15_000

export interface DaemonModeDeps {
  mode: Exclude<StudioBackendMode, 'embedded'>
  /** Finds or starts the daemon (local: daemon-process.ts; remote: URL + token). */
  connect: DaemonConnector
  /** Studio's userData (studio-client-settings.json lives here). */
  userDataDir: string
  hooks?: { showMainWindow?: () => BrowserWindow | null; openFile?: (filePath: string) => void }
  log?: Pick<Console, 'log' | 'warn' | 'error'>
  /** Agent lease registry (tests); defaults to the process registry. */
  leases?: Pick<AgentLeaseRegistry, 'registerClient'>
  ipcMain?: Pick<IpcMain, 'handle' | 'on'>
  fetch?: typeof fetch
  /** The client session implementation. Default: the daemon's client sessions (W2-B). */
  createSession?: (client: DaemonClient) => ClientSession
  /**
   * studio-backend.json `keepDaemonRunning` (§8.3), read at quit (a getter:
   * Settings → Backend changes it for the next quit). Off in local mode, the
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
  /** Tests: waits for the daemon's pid to exit (default: process liveness). */
  waitForExit?: (pid: number, budgetMs: number) => Promise<boolean>
  /** Local mode: rewrite Studio's runtime identity entry after an owner import (DaemonModeContext.afterOwnerImport). */
  afterOwnerImport?: (phrase: string) => Promise<string>
  /** Tests: Studio's restarts after a failed launch. Default: relaunchStudio / relaunchEmbeddedForSession (mode-switch.ts). */
  relaunch?: { reconnect(reason: string): void; embeddedForSession(reason: string): void }
  /** How long a restart waits for the window to keep its unsaved editors and restart itself. Default 15 s. */
  stashWaitMs?: number
}

export interface DaemonModeHandle {
  /** Channels registered here, implemented or pending. */
  registered: MappedChannel[]
  /** Invoke channels registered with the visible "not available yet" handler. */
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
  /** Settings → Backend: the daemon this session uses and the connection state. */
  status(): BackendDaemonStatus
  /** keepDaemonRunning changed in Settings: the session's crash behaviour follows it (exitDaemonWhenClosed). */
  setKeepDaemonRunning(keep: boolean): Promise<void>
  /** The gated background start (BACKGROUND_AGENT_START): resumes an agent a switch carried over. */
  startBackgroundAgent(filePath: string): Promise<{ success: boolean; error?: string; code?: string }>
  /** Agents running in the daemon, whether a turn is in flight, and whether one waits on an approval or a question (the switch dialog). */
  agentActivity(): Array<{ filePath: string; busy: boolean; waiting: boolean }>
  /**
   * Studio's quit path in daemon mode (§8.3): end the client session; in
   * local mode with `keepDaemonRunning` off, the daemon stops when Studio
   * started it and no other client session is open (the daemon decides,
   * POST /client/sessions/:id/quit). `waitForDaemonExitMs`: a switch to
   * embedded waits for that daemon to exit, so embedded Studio can start
   * the agents it ran.
   */
  shutdown(opts?: { waitForDaemonExitMs?: number }): Promise<void>
}

function isInvoke(entry: ChannelEntry): boolean {
  return entry.kind === 'invoke'
}

export function registerDaemonModeHandlers(deps: DaemonModeDeps): DaemonModeHandle {
  const log = deps.log ?? console
  const ipc = deps.ipcMain ?? electronIpcMain
  const hooks = deps.hooks ?? {}

  // Studio runs no agents in this mode: it records itself as a client, not a
  // runtime host, so `adf daemon start` does not refuse it (agent-lease.ts).
  // The daemon's URL is added once the connector found it.
  const leases = deps.leases ?? processAgentLeases()
  const clientRecord = { settingsPath: join(deps.userDataDir, 'adf-settings.json'), version: app.getVersion() }
  void leases.registerClient(deps.mode, clientRecord)
  const keepRunning = (): boolean => typeof deps.keepDaemonRunning === 'function' ? deps.keepDaemonRunning() : deps.keepDaemonRunning === true

  // The client keys were moved into the client file by the switch (handover.ts, at boot).
  const clientSettings = new ClientSettingsStore(clientSettingsPath(deps.userDataDir), log)
  // Local mode: the daemon is this machine's and keeps its settings next to
  // Studio's (daemon-process.ts checks that), so Studio reads its local proof
  // and sends it on the local-only routes (owner import, stored-value
  // reveal), as the adf CLI does. Never for another route or another host.
  const connect: DaemonConnector = deps.mode !== 'local' ? deps.connect : Object.assign(
    async (progress: (text: string) => void) => {
      const endpoint = await deps.connect(progress)
      const port = Number(new URL(endpoint.baseUrl).port) || undefined
      return {
        ...endpoint,
        source: {
          ...endpoint.source,
          token: () => endpoint.source.token(),
          ...(endpoint.source.refresh ? { refresh: () => endpoint.source.refresh!() } : {}),
          localProof: (path: string): Record<string, string> => {
            if (!isLocalOnlyRoute(path)) return {}
            const proof = readLocalProof(deps.userDataDir, port)
            return proof ? { [LOCAL_PROOF_HEADER]: proof } : {}
          },
        },
      }
    },
    { logFile: deps.connect.logFile },
  )
  // Remote mode: a 401 after connecting (the server's token changed) is the
  // "refused the token" sentence and ends the connection; retrying could not
  // help (W4-B review). /health carries no token and is not counted.
  let unauthorized = false
  const onUnauthorized = (): void => {
    if (unauthorized) return
    unauthorized = true
    const url = connection.baseUrl ?? 'the remote daemon'
    log.error(`[Backend] The ADF daemon at ${url} answered 401: the saved token is no longer accepted; the connection stops`)
    connection.markFailed(`The ADF daemon at ${url} refused the token. Run adf daemon token on the server and save the result in Settings → Backend.`)
    bridge.failTurns('disconnected')
    void clientSession?.end().catch(() => {})
  }
  const baseFetch: typeof fetch = deps.fetch ?? ((input, init) => fetch(input, init))
  const connectionFetch: typeof fetch | undefined = deps.mode !== 'remote' ? deps.fetch : (async (input: string | URL | Request, init?: RequestInit) => {
    const res = await baseFetch(input, init)
    if (res.status === 401 && !unauthorized) {
      const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url)
      if (connection.baseUrl && url.origin === new URL(connection.baseUrl).origin && url.pathname !== '/health') onUnauthorized()
    }
    return res
  }) as typeof fetch
  const connection = new DaemonConnection(connect, log, connectionFetch)
  // Remote mode, unreachable at launch: the connector retries (remote/connector.ts); say so once.
  let waitingNoticed = false
  connection.onState((state) => {
    if (deps.mode !== 'remote' || waitingNoticed || state.state !== 'connecting' || !state.progress?.startsWith(REMOTE_WAITING_PREFIX)) return
    waitingNoticed = true
    statusUi.notice(remoteWaitingNotice(state.progress))
  })
  // A re-hold that failed after a reconnect is a notice (statusUi exists by the time a reconnect happens).
  const session = new DaemonModeSession(null, log, (text) => { log.warn(`[Backend] ${text}`); statusUi.notice(text) })

  const firstWindow = (): BrowserWindow | null => {
    const windows = BrowserWindow.getAllWindows()
    return windows.length > 0 ? windows[0] : null
  }
  const output = {
    send(channel: string, ...args: unknown[]) {
      const win = firstWindow()
      if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
      try { win.webContents.send(channel, ...args) } catch { /* window going away */ }
    },
    sendAll(channel: string, ...args: unknown[]) {
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed() || win.webContents.isDestroyed()) continue
        try { win.webContents.send(channel, ...args) } catch { /* window going away */ }
      }
    },
  }
  const batcher = new BackgroundEventBatcher((events) => output.send(IPC.BACKGROUND_AGENT_EVENT_BATCH, events))

  let tokensToday = { input: 0, output: 0 }
  let tokensFetchedAt = 0
  const refreshTokens = (): void => {
    // Only the macOS menu bar reads it; refreshed at most every 30 s.
    if (process.platform !== 'darwin' || Date.now() - tokensFetchedAt < 30_000) return
    const client = connection.current
    if (!client) return
    tokensFetchedAt = Date.now()
    void client.request<{ tokens?: { today?: { input: number; output: number } } }>('GET', '/dashboard/quick-stats')
      .then((stats) => { if (stats.tokens?.today) tokensToday = stats.tokens.today })
      .catch(() => {})
  }

  const installs = new InstallProgressRelay((channel, payload) => output.send(channel, payload), log)

  // Remote mode (W4-B): the daemon-side picker, the OAuth callback relay and
  // uploads from this computer. Local mode needs none: the daemon shares
  // this computer's files, browser and loopback.
  const remoteServices: RemoteServices | null = deps.mode !== 'remote' ? null : (() => {
    const host = (): string => {
      try { return new URL(connection.baseUrl ?? '').host || 'the daemon host' } catch { return 'the daemon host' }
    }
    const picker = new RemotePicker({
      host,
      log,
      send: (request) => {
        const win = BrowserWindow.getFocusedWindow() ?? firstWindow()
        if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return false
        win.webContents.send(IPC.REMOTE_PICKER_REQUEST, request)
        return true
      },
    })
    const oauth = new OAuthCallbackRelay({
      relay: async (body) => {
        try {
          return await (await started).request<{ delivered: boolean; status: number }>('POST', '/oauth/relay', { body })
        } catch (err) {
          return { delivered: false, status: err instanceof DaemonError ? err.status : null, error: err instanceof Error ? err.message : String(err) }
        }
      },
      openExternal: (url) => shell.openExternal(url),
      daemonHost: host,
      ...(deps.remoteOAuth?.bindHost ? { bindHost: deps.remoteOAuth.bindHost } : {}),
      ...(deps.remoteOAuth?.allowPage ? { allowPage: deps.remoteOAuth.allowPage } : {}),
      // Remote mode opens no page without a click (W4-B review); local mode keeps embedded's no-click open.
      confirm: async ({ daemonHost, pageHost, label }) => {
        const win = BrowserWindow.getFocusedWindow() ?? firstWindow()
        const options = {
          type: 'question',
          message: `Open a sign-in page on ${pageHost}?`,
          detail: `The ADF daemon at ${daemonHost} asks to open ${pageHost} in your browser (${label}). Open it only if you started this sign-in.`,
          buttons: ['Open page', 'Cancel'],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        } as Electron.MessageBoxOptions
        const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
        return response === 0
      },
      log,
    })
    return { picker, oauth, host, upload: uploadFile(deps.fetch ?? fetch) }
  })()

  const mcpOAuth = new McpOAuthAuthorizeOpener({
    mode: deps.mode,
    fetchInput: async (filePath, approvalId) => (await started).request<{ input?: unknown }>('GET', '/approvals/input', { query: { filePath, approvalId } }).then((r) => r.input),
    openExternal: (url) => shell.openExternal(url),
    ...(remoteServices ? {
      openRemote: (url: string, label: string) => remoteServices.oauth.open(url, label),
      notify: (title: string, text: string) => {
        const win = BrowserWindow.getFocusedWindow() ?? firstWindow()
        const options = { type: 'warning', title, message: title, detail: text, buttons: ['OK'] } as Electron.MessageBoxOptions
        void (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options)).catch(() => {})
      },
    } : {}),
    log,
  })

  // eslint-disable-next-line prefer-const
  let bridge: EventBridge
  const approvals = new ApprovalsUi({
    notificationsEnabled: () => clientSettings.get('nativeNotificationsEnabled') !== false,
    menuBarEnabled: () => clientSettings.get('menuBarEnabled') !== false,
    agents: () => bridge.runningAgents()
      .filter((a) => !session.isFocused(a.agentId, a.filePath))
      .map((a) => ({ filePath: a.filePath, state: a.mapping.state, activeLoops: a.mapping.activeLoops })),
    foreground: () => {
      const id = session.agentId
      const agent = id ? bridge.runningAgents().find((a) => a.agentId === id) : undefined
      return agent ? { filePath: agent.filePath, state: agent.mapping.state } : null
    },
    tokensToday: () => tokensToday,
    showMainWindow: hooks.showMainWindow,
    openFile: hooks.openFile,
    log,
  })
  // Remote mode: a browser session's viewer port is the server's loopback.
  // Opening it here would load this computer's loopback, so the push is
  // replaced by a notice (remote-unsupported, design §9.3).
  const bridgeOutput: typeof output = deps.mode !== 'remote' ? output : {
    send(channel: string, ...args: unknown[]) {
      if (channel === IPC.COMPUTE_BROWSER_SESSION) {
        const name = (args[0] as { agentName?: unknown } | undefined)?.agentName
        const text = `${typeof name === 'string' && name ? name : 'An agent'} ${REMOTE_BROWSER_SESSION_SENTENCE}`
        log.warn(`[Remote] ${text}`)
        statusUi.notice(text)
        return
      }
      output.send(channel, ...args)
    },
    sendAll: (channel: string, ...args: unknown[]) => output.sendAll(channel, ...args),
  }
  bridge = new EventBridge({
    session,
    output: bridgeOutput,
    batcher,
    client: () => connection.current,
    onApprovals: (snapshot) => { approvals.apply(snapshot); void mcpOAuth.apply(snapshot) },
    onAgentsChanged: () => { approvals.refresh(); refreshTokens() },
    onFileRenamed: (oldPath, newPath) => session.rekey(oldPath, newPath),
    onNotice: (text) => statusUi.notice(text),
    log,
  })

  let clientSession: ClientSession | null = null
  const relaunch = deps.relaunch ?? { reconnect: relaunchStudio, embeddedForSession: relaunchEmbeddedForSession }
  /**
   * Restart after the connection failed. The window first keeps every
   * unsaved editor as a recovery copy (W3-F RECOVERY_STASH, listed at the
   * next launch), then asks for the restart itself (BACKEND_RESTART_STUDIO);
   * without a window, or one that does not answer, main restarts.
   */
  const restartKeepingEdits = (kind: 'reconnect' | 'embedded-session', reason: string): void => {
    const restart = () => kind === 'reconnect' ? relaunch.reconnect(reason) : relaunch.embeddedForSession(reason)
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && !w.webContents.isDestroyed())
    if (!win) { restart(); return }
    log.log(`[Backend] Asking the window to keep its unsaved editor text as recovery copies, then restarting (${reason})`)
    win.webContents.send(IPC.MENU_ACTION, kind === 'reconnect' ? 'stash-edits-and-reconnect' : 'stash-edits-and-use-embedded')
    const fallback = setTimeout(() => {
      log.warn('[Backend] The window did not restart Studio after keeping its unsaved text; restarting now')
      restart()
    }, deps.stashWaitMs ?? 15_000)
    fallback.unref?.()
  }
  /**
   * After the connection failed during this session (a client session had
   * opened: documents may be open), a restart is confirmed first. A launch
   * that never connected restarts at once.
   */
  const confirmRestart = async (action: string, failure: string): Promise<boolean> => {
    if (!clientSession) return true
    const buttons = ['Restart Studio', 'Cancel']
    const { response } = await dialog.showMessageBox({
      type: 'question',
      title: 'Restart Studio',
      message: `${action} restarts Studio.`,
      detail: `The connection to the ADF daemon failed during this session: ${failure}\n\nUnsaved text in open editors is kept as recovery copies; the next launch lists them.`,
      buttons,
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    }).catch(() => ({ response: 1 }))
    if (response !== 0) log.log(`[Backend] ${action} cancelled; Studio stays without a daemon connection`)
    return response === 0
  }
  const reconnect = (): void => {
    const state = connection.state
    if (state.state === 'failed') {
      // The connector failed, or the session became unusable: the connector runs again at Studio's start.
      void confirmRestart('Reconnect', state.message).then((ok) => {
        if (!ok) return
        log.log(`[Backend] Reconnect requested after a failed connection (${state.message}): restarting Studio to connect again`)
        restartKeepingEdits('reconnect', 'Reconnect after a failed connection to the ADF daemon')
      })
      return
    }
    if (!clientSession) {
      log.warn('[Backend] Reconnect requested while Studio is still looking for the ADF daemon; it connects when the daemon answers')
      void dialog.showMessageBox({
        type: 'info',
        message: 'Studio is still connecting to the ADF daemon.',
        detail: `It connects when the daemon answers. ${deps.mode === 'remote' ? REMOTE_RECOVERY_HINT : RECOVERY_HINT}`,
        buttons: ['OK'],
      }).catch(() => {})
      return
    }
    log.log('[Backend] Reconnecting to the ADF daemon (requested)')
    clientSession.reconnect()
  }
  /**
   * After a failed launch, local mode only: embedded for this launch only;
   * the saved mode stays (§8.2 session-only). Not in remote mode: embedded
   * Studio autostarts this computer's agents, which may run on the server
   * too (two pollers of one bot, Telegram 409).
   */
  const useEmbeddedForSession = deps.mode === 'local' ? (): void => {
    const state = connection.state
    void confirmRestart('Use Embedded for This Session', state.state === 'failed' ? state.message : 'not connected').then((ok) => {
      if (!ok) return
      log.log('[Backend] Use Embedded for This Session requested after a failed connection to the ADF daemon')
      restartKeepingEdits('embedded-session', clientSession ? 'the ADF daemon connection failed during the session' : 'no ADF daemon could be reached at launch')
    })
  } : undefined
  /** Remote mode, after a failed launch: Settings → Backend, where the URL and token are fixed and tested. */
  const openBackendSettings = deps.mode === 'remote' ? (): void => {
    log.log('[Backend] Opening Settings → Backend after a failed connection to the remote ADF daemon')
    const win = hooks.showMainWindow?.() ?? BrowserWindow.getAllWindows()[0] ?? null
    if (win && !win.isDestroyed()) win.webContents.send(IPC.MENU_ACTION, 'open-settings-backend')
  } : undefined
  initApplicationMenu(clientSettings, {
    logFile: () => connection.logFile,
    problem: () => connectionProblem(connection.state, connection.baseUrl),
    canReconnect: () => connection.state.state === 'disconnected' || connection.state.state === 'failed',
    openLog: () => { void openDaemonLog(connection.logFile, log) },
    reconnect,
    useEmbeddedForSession,
    openBackendSettings,
    launchFailed: () => connection.state.state === 'failed',
    remoteRecents: deps.mode === 'remote',
  })
  const statusUi = new ConnectionStatusUi(connection, { reconnect, useEmbeddedForSession, openBackendSettings, openLog: () => { void openDaemonLog(connection.logFile, log) }, recoveryHint: deps.mode === 'remote' ? REMOTE_RECOVERY_HINT : RECOVERY_HINT }, log)

  const exitDaemonWhenClosed = deps.mode === 'local' && !keepRunning()
  let versionInfo: DaemonVersionInfo | null = null
  const refreshVersion = (client: DaemonClient): void => {
    void client.request<DaemonVersionInfo>('GET', '/version').then((v) => {
      if (versionInfo && (v.pid !== versionInfo.pid || v.version !== versionInfo.version)) {
        log.log(`[Backend] The ADF daemon is now pid ${v.pid}, version ${v.version}, started by ${v.startedBy} (was pid ${versionInfo.pid})`)
      }
      versionInfo = v
    }).catch(() => {})
  }
  /**
   * How Studio got the daemon that answers now: the launch's answer while the
   * same process (pid) answers, else attached (`adf daemon restart`, another
   * start). Re-derived from /version, which every reattach and epoch change
   * re-reads (refreshVersion), never kept from the launch.
   */
  const currentHow = (): 'attached' | 'spawned' | null => {
    const endpoint = connection.endpointInfo
    if (!endpoint?.how) return null
    const launched = endpoint.daemon?.pid
    return versionInfo && launched !== undefined && versionInfo.pid !== launched ? 'attached' : endpoint.how
  }
  const started: Promise<DaemonClient> = connection.client().then(async (client) => {
    void leases.registerClient(deps.mode, { ...clientRecord, ...(connection.baseUrl ? { controlUrl: connection.baseUrl } : {}) })
    versionInfo = connection.endpointInfo?.daemon ?? null
    if (!versionInfo) void client.request<DaemonVersionInfo>('GET', '/version').then((v) => { versionInfo = v }).catch(() => {})
    if (deps.reloadCredentials && deps.mode === 'local') {
      // The handover moved credentials while this daemon may already have been running.
      void client.request<{ runtime: { state: string } | null; unlocked: unknown[]; stillLocked: unknown[]; sessions: string[]; recovered: number }>('POST', '/client/reload-credentials')
        .then((r) => log.log(`[Backend] The ADF daemon reloaded the moved credentials: runtime identity ${r.runtime?.state ?? 'n/a'}, ${r.unlocked.length} agent(s) unlocked, ${r.stillLocked.length} still locked, sessions [${r.sessions.join(', ')}]`))
        .catch((err) => log.warn(`[Backend] Asking the ADF daemon to reload the moved credentials failed: ${err instanceof Error ? err.message : String(err)}`))
    }
    clientSession = (deps.createSession ?? ((c) => createDaemonClientSession(c, { version: app.getVersion(), exitDaemonWhenClosed, log, ...(deps.mode === 'local' ? { pid: process.pid } : {}) })))(client)
    session.attach(clientSession)
    // Learn what already runs and what is pending, without pushing: the
    // renderer pulls its initial state itself.
    try {
      const summaries = await client.request<AgentSummary[]>('GET', '/agents')
      const statuses = await Promise.all(summaries.map((s) =>
        client.request<AgentStatus>('GET', `/agents/${encodeURIComponent(s.id)}/status`).catch(() => null)))
      bridge.seed(statuses.filter((s): s is AgentStatus => !!s))
    } catch (err) {
      log.warn(`[Backend] Could not list the daemon's agents at connect: ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      const snapshot = await client.request<NotificationsSnapshot>('GET', '/approvals')
      approvals.apply(snapshot)
      void mcpOAuth.apply(snapshot)
      // Requests reach the daemon: connected, before the stream's own open.
      connection.markConnected()
    } catch (err) {
      log.warn(`[Backend] Could not read the daemon's approvals at connect: ${err instanceof Error ? err.message : String(err)}`)
    }
    clientSession.start({
      onFrame: (frame) => { if (installs.observe(frame)) bridge.handleFrame(frame) },
      onGap: (gap) => { installs.onGap(); void bridge.handleGap(gap) },
      onConnection: (c) => {
        if (c.state === 'open') connection.markConnected()
        else if (c.state === 'reconnecting') connection.markDisconnected(c.error)
      },
      onReattached: (info) => {
        log.log(`[Backend] Client stream reattached${info.epochChanged ? ' (new session)' : ''}: re-sending the focus and the held documents`)
        // The daemon may have restarted (another pid, version or launcher): Settings → Backend and the switch dialog read this.
        refreshVersion(client)
        return session.reattach()
      },
      onFatal: (message) => {
        connection.markFailed(message)
        bridge.failTurns('disconnected')
      },
    })
    return client
  })
  /** Requests name the client session (X-ADF-Client-Session): the daemon does not echo this window's own writes (D5.1). */
  const sessionClient = (client: DaemonClient): DaemonClient => {
    const id = clientSession?.sessionId
    return id ? client.withClientSession(id) : client
  }
  started.catch(() => {})

  // AGENT_INVOKE waits must not outlive the daemon: a failed connector ends
  // them at once, a disconnect that lasts past the grace period too (the
  // handler reports it).
  let turnGrace: ReturnType<typeof setTimeout> | null = null
  connection.onState((state) => {
    if (state.state === 'failed') bridge.failTurns('disconnected')
    if (state.state === 'disconnected' && !turnGrace) {
      turnGrace = setTimeout(() => {
        turnGrace = null
        if (connection.state.state === 'disconnected') {
          log.warn(`[Backend] The ADF daemon has been away for ${TURN_DISCONNECT_GRACE_MS / 1000}s; ending the chats that wait for their turn`)
          bridge.failTurns('disconnected')
        }
      }, TURN_DISCONNECT_GRACE_MS)
      turnGrace.unref?.()
    }
    if (state.state === 'connected' && turnGrace) { clearTimeout(turnGrace); turnGrace = null }
  })

  const ctx: DaemonModeContext = {
    mode: deps.mode,
    connection,
    session,
    bridge,
    clientSettings,
    approvals,
    installs,
    ready: () => started.then(sessionClient),
    runningAgentAt: async (filePath) => findRunningAgent(await started, filePath),
    raw: async (path, query) => {
      const client = sessionClient(await started)
      const url = client.url(path, query)
      return (deps.fetch ?? fetch)(url, { headers: client.headers({ Accept: '*/*' }), redirect: 'manual' })
    },
    sharedMnemonic: deps.sharedMnemonic ?? openSharedMnemonicStore,
    recordRecentFile,
    hooks,
    ...(deps.afterOwnerImport ? { afterOwnerImport: deps.afterOwnerImport } : {}),
    remote: remoteServices,
    log,
  }

  const registered: MappedChannel[] = []
  const pending: Array<{ channel: MappedChannel; workstream: string }> = []
  for (const [channel, entry] of Object.entries(CHANNEL_MAP) as Array<[MappedChannel, ChannelEntry]>) {
    if (REGISTERED_OUTSIDE.includes(channel)) continue
    if (entry.kind === 'send') {
      const sendHandler = DAEMON_MODE_SEND_HANDLERS[channel]
      if (sendHandler) {
        ipc.on(channel, (event, ...args) => sendHandler(ctx, event as Electron.IpcMainEvent, ...args))
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
    // Remote mode: the remote variant first (remote/handlers.ts), else the shared one.
    const handler = (deps.mode === 'remote' ? REMOTE_MODE_HANDLERS[channel] : undefined) ?? DAEMON_MODE_HANDLERS[channel]
    if (handler) {
      ipc.handle(channel, (event, ...args) => handler(ctx, event, ...args))
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
      pending.push({ channel, workstream })
    }
    registered.push(channel)
  }
  log.log(`[Backend] ${deps.mode} daemon mode: ${registered.length - pending.length} channels implemented, ${pending.length} answer "not available in daemon mode yet"`)

  const adfFile = createAdfFileHandler({ session, connection, fetch: deps.fetch, log })

  /** Resolves true once the daemon's process exited (its pid, not its /health), false at the deadline. */
  const waitDaemonGone = async (budgetMs: number): Promise<boolean> => {
    const pid = versionInfo?.pid ?? connection.endpointInfo?.daemon?.pid
    if (!pid) return true
    return (deps.waitForExit ?? waitForDaemonExit)(pid, budgetMs)
  }

  let shutdownPromise: Promise<void> | null = null
  const shutdown = (opts: { waitForDaemonExitMs?: number } = {}): Promise<void> => {
    shutdownPromise ??= (async () => {
      statusUi.dispose()
      approvals.dispose()
      remoteServices?.picker.cancelAll()
      remoteServices?.oauth.closeAll()
      bridge.dispose()
      batcher.dispose()
      const stopDaemon = deps.mode === 'local' && !keepRunning()
      let answer: ClientQuitAnswer | null = null
      try {
        await session.releaseAll()
        if (deps.mode === 'local' && clientSession?.quit) answer = await clientSession.quit(stopDaemon)
        else await clientSession?.end()
        // No session was ever opened on a daemon this Studio started: the orphan rule cannot stop it, so ask directly.
        if (!answer && stopDaemon && currentHow() === 'spawned' && connection.current) {
          answer = await connection.current.withTimeout(5_000).request<ClientQuitAnswer>('POST', '/client/sessions/none/quit', { body: { stopDaemon: true } })
        }
      } catch (err) {
        log.warn('[Backend] Ending the client session failed:', err)
      }
      await clientSettings.flush()
      if (answer) {
        // §8.3: the daemon decided; its log has the same line.
        log.log(`[Backend] Quit: client session ended; ${answer.stopping ? 'the ADF daemon is stopping' : 'the ADF daemon keeps running'}: ${answer.reason}`)
      } else if (connection.current) {
        log.log(`[Backend] Quit: client session ended; the ADF daemon keeps running${deps.mode === 'remote' ? ' (remote mode never stops it)' : ''}`)
      }
      if (answer?.stopping && opts.waitForDaemonExitMs) {
        log.log(`[Backend] Waiting up to ${Math.round(opts.waitForDaemonExitMs / 1000)}s for the ADF daemon to stop its agents and exit`)
        const gone = await waitDaemonGone(opts.waitForDaemonExitMs)
        log.log(gone ? '[Backend] The ADF daemon exited' : '[Backend] The ADF daemon is still stopping; embedded Studio reports any agent it still holds as running in the daemon')
      }
    })()
    return shutdownPromise
  }

  const status = (): BackendDaemonStatus => {
    const state = connection.state
    const endpoint = connection.endpointInfo
    const info = versionInfo ?? endpoint?.daemon ?? null
    return {
      connection: state.state,
      progress: state.state === 'connecting' ? state.progress ?? null : null,
      message: state.state === 'failed' ? state.message : state.state === 'disconnected' ? state.error ?? null : null,
      url: connection.baseUrl,
      pid: info?.pid ?? null,
      version: info?.version ?? null,
      startedBy: info?.startedBy ?? null,
      how: currentHow(),
      localProof: info?.localProof ?? null,
      logFile: connection.logFile,
    }
  }

  const setKeepDaemonRunning = async (keep: boolean): Promise<void> => {
    const id = clientSession?.sessionId
    const client = connection.current
    if (deps.mode !== 'local' || !id || !client) return
    try {
      await client.request('PUT', `/client/sessions/${encodeURIComponent(id)}/exit-when-closed`, { body: { exitDaemonWhenClosed: !keep } })
      log.log(`[Backend] keepDaemonRunning ${keep ? 'on' : 'off'}: after a crash the daemon ${keep ? 'keeps running' : 'stops once this session expires'}`)
    } catch (err) {
      log.warn(`[Backend] Could not update the session's quit behaviour: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const startBackgroundAgent = async (filePath: string) => {
    const handler = DAEMON_MODE_HANDLERS[IPC.BACKGROUND_AGENT_START]
    if (!handler) return { success: false, error: 'Background start is not available in daemon mode' }
    try {
      return await handler(ctx, {} as Electron.IpcMainInvokeEvent, { filePath }) as { success: boolean; error?: string; code?: string }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  const agentActivity = () => {
    const waiting = new Set(approvals.pendingFilePaths())
    const running = bridge.runningAgents().map((a) => ({
      filePath: a.filePath,
      busy: a.mapping.state === 'active' || a.mapping.activeLoops > 0 || (a.lastForegroundState !== undefined && a.lastForegroundState !== 'idle' && a.lastForegroundState !== 'stopped' && a.lastForegroundState !== 'error'),
      waiting: waiting.has(a.filePath),
    }))
    // An approval names its agent even when the running list has not caught up.
    for (const filePath of waiting) if (!running.some((a) => a.filePath === filePath)) running.push({ filePath, busy: true, waiting: true })
    return running
  }

  return {
    registered,
    pending,
    connection,
    session,
    bridge,
    clientSettings,
    ready: started.then(() => true, () => false),
    adfFile,
    reconnect,
    status,
    setKeepDaemonRunning,
    startBackgroundAgent,
    agentActivity,
    shutdown,
  }
}
