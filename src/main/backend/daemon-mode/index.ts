import { app, BrowserWindow, dialog, ipcMain as electronIpcMain, shell, type IpcMain } from 'electron'
import { join } from 'node:path'
import type { StudioBackendMode } from '../../../shared/types/backend.types'
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
import { createAdfFileHandler } from './adf-file'
import { ApprovalsUi } from './approvals-ui'
import { createDaemonClientSession, type ClientSession } from './client-stream'
import { DaemonConnection, type DaemonConnector } from './connection'
import { findRunningAgent, type DaemonModeContext } from './context'
import { DaemonModeUnavailableError } from './errors'
import { EventBridge } from './event-bridge'
import { DAEMON_MODE_HANDLERS, DAEMON_MODE_SEND_HANDLERS } from './handlers'
import { channelKey, pendingWorkstream } from './pending'
import { DaemonModeSession } from './session'
import { ClientSettingsStore, clientSettingsPath } from './settings'
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

/** Registered in both modes outside the backend registration (main/index.ts, app-updater, spellcheck, orbital cache, backend settings). */
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
  IPC.BACKEND_REMOTE_CHECK,
  IPC.BACKEND_RESTART_STUDIO,
]

export const RECOVERY_HINT = `To use embedded mode for this session, start Studio with ${BACKEND_ENV_OVERRIDE}=embedded.`

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
   * studio-backend.json `keepDaemonRunning` (§8.3). Off in local mode, the
   * session is opened with `exitDaemonWhenClosed`, so a crashed Studio's
   * daemon stops once its session expires and no other client is open. The
   * quit path itself is W4-A's.
   */
  keepDaemonRunning?: boolean
  /** Tests (parity harness): where the OAuth relay listens, and pages exempt from the public-address rule. */
  remoteOAuth?: { bindHost?: string; allowPage?: (url: URL) => boolean }
  /** The shared owner-phrase keychain entry (tests: a stand-in). Default: the OS keychain's. */
  sharedMnemonic?: () => SharedMnemonicStore | null
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
  /** Studio's quit path in daemon mode: end the client session. The daemon itself is not stopped here (W4-A). */
  shutdown(): Promise<void>
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
  void (deps.leases ?? processAgentLeases()).registerClient(deps.mode, {
    settingsPath: join(deps.userDataDir, 'adf-settings.json'),
    version: app.getVersion(),
  })

  // Before W4-A's switch moves them: seed the client file once from adf-settings.json.
  ClientSettingsStore.seedOnce(clientSettingsPath(deps.userDataDir), join(deps.userDataDir, 'adf-settings.json'), log)
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
  const reconnect = (): void => {
    const state = connection.state
    if (state.state === 'failed' || !clientSession) {
      // Nothing to reconnect: the connector itself failed this session.
      log.warn('[Backend] Reconnect requested, but Studio found no daemon to connect to this session; restart Studio to try again')
      void dialog.showMessageBox({
        type: 'warning',
        message: 'Studio has no ADF daemon to reconnect to.',
        detail: `${state.state === 'failed' ? `${state.message}\n\n` : ''}Restart Studio to try again. ${deps.mode === 'remote' ? REMOTE_RECOVERY_HINT : RECOVERY_HINT}`,
        buttons: ['OK'],
      }).catch(() => {})
      return
    }
    log.log('[Backend] Reconnecting to the ADF daemon (requested)')
    clientSession.reconnect()
  }
  initApplicationMenu(clientSettings, {
    logFile: () => connection.logFile,
    problem: () => connectionProblem(connection.state, connection.baseUrl),
    canReconnect: () => connection.state.state === 'disconnected',
    openLog: () => { void openDaemonLog(connection.logFile, log) },
    reconnect,
    remoteRecents: deps.mode === 'remote',
  })
  const statusUi = new ConnectionStatusUi(connection, { reconnect, openLog: () => { void openDaemonLog(connection.logFile, log) }, recoveryHint: deps.mode === 'remote' ? REMOTE_RECOVERY_HINT : RECOVERY_HINT }, log)

  const exitDaemonWhenClosed = deps.mode === 'local' && deps.keepDaemonRunning !== true
  const started: Promise<DaemonClient> = connection.client().then(async (client) => {
    clientSession = (deps.createSession ?? ((c) => createDaemonClientSession(c, { version: app.getVersion(), exitDaemonWhenClosed, log })))(client)
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
      onFrame: (frame) => { installs.observe(frame); bridge.handleFrame(frame) },
      onGap: (gap) => { installs.onGap(); void bridge.handleGap(gap) },
      onConnection: (c) => {
        if (c.state === 'open') connection.markConnected()
        else if (c.state === 'reconnecting') connection.markDisconnected(c.error)
      },
      onReattached: (info) => {
        log.log(`[Backend] Client stream reattached${info.epochChanged ? ' (new session)' : ''}: re-sending the focus and the held documents`)
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

  let shutdownPromise: Promise<void> | null = null
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      statusUi.dispose()
      approvals.dispose()
      remoteServices?.picker.cancelAll()
      remoteServices?.oauth.closeAll()
      bridge.dispose()
      batcher.dispose()
      try {
        await session.releaseAll()
        await clientSession?.end()
      } catch (err) {
        log.warn('[Backend] Ending the client session failed:', err)
      }
      await clientSettings.flush()
      // R4 quit behaviour (stop a Studio-started daemon unless keepDaemonRunning) is W4-A's.
      if (connection.current) log.log('[Backend] Client session ended; the ADF daemon keeps running (quit behaviour: W4-A)')
    })()
    return shutdownPromise
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
    shutdown,
  }
}
