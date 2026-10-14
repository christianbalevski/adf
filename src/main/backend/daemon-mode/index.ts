import { app, BrowserWindow, dialog, ipcMain as electronIpcMain, shell, type IpcMain } from 'electron'
import { join } from 'node:path'
import type { BackendDaemonStatus, StudioBackendMode } from '../../../shared/types/backend.types'
import type { AgentStatus, AgentSummary, DaemonClient } from '../../../shared/daemon-client'
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
import { InstallProgressRelay } from './mcp/install-progress'
import { McpOAuthAuthorizeOpener } from './mcp/oauth-authorize'
import { ConnectionStatusUi, connectionProblem, openDaemonLog } from './status-ui'

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
]

export const RECOVERY_HINT = `To run agents in Studio instead, choose Embedded in Settings → Backend (Studio restarts), or start Studio with ${BACKEND_ENV_OVERRIDE}=embedded for one session.`

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
  /** The shared owner-phrase keychain entry (tests: a stand-in). Default: the OS keychain's. */
  sharedMnemonic?: () => SharedMnemonicStore | null
  /** Local mode: rewrite Studio's runtime identity entry after an owner import (DaemonModeContext.afterOwnerImport). */
  afterOwnerImport?: (phrase: string) => Promise<string>
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
  const connection = new DaemonConnection(connect, log, deps.fetch)
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
  const mcpOAuth = new McpOAuthAuthorizeOpener({
    mode: deps.mode,
    fetchInput: async (filePath, approvalId) => (await started).request<{ input?: unknown }>('GET', '/approvals/input', { query: { filePath, approvalId } }).then((r) => r.input),
    openExternal: (url) => shell.openExternal(url),
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
  bridge = new EventBridge({
    session,
    output,
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
        detail: `${state.state === 'failed' ? `${state.message}\n\n` : ''}Restart Studio to try again. ${RECOVERY_HINT}`,
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
  })
  const statusUi = new ConnectionStatusUi(connection, { reconnect, openLog: () => { void openDaemonLog(connection.logFile, log) }, recoveryHint: RECOVERY_HINT }, log)

  const exitDaemonWhenClosed = deps.mode === 'local' && !keepRunning()
  let versionInfo: DaemonVersionInfo | null = null
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
    ...(deps.afterOwnerImport ? { afterOwnerImport: deps.afterOwnerImport } : {}),
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
    const handler = DAEMON_MODE_HANDLERS[channel]
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

  /** Resolves true once nothing answers the daemon's /health (it exited), false at the deadline. */
  const waitDaemonGone = async (budgetMs: number): Promise<boolean> => {
    const url = connection.baseUrl
    if (!url) return true
    const deadline = Date.now() + budgetMs
    while (Date.now() < deadline) {
      try {
        await (deps.fetch ?? fetch)(`${url}/health`, { signal: AbortSignal.timeout(800) })
      } catch {
        return true
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    return false
  }

  let shutdownPromise: Promise<void> | null = null
  const shutdown = (opts: { waitForDaemonExitMs?: number } = {}): Promise<void> => {
    shutdownPromise ??= (async () => {
      statusUi.dispose()
      approvals.dispose()
      bridge.dispose()
      batcher.dispose()
      const stopDaemon = deps.mode === 'local' && !keepRunning()
      let answer: ClientQuitAnswer | null = null
      try {
        await session.releaseAll()
        if (deps.mode === 'local' && clientSession?.quit) answer = await clientSession.quit(stopDaemon)
        else await clientSession?.end()
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
      how: endpoint?.how ?? null,
      localProof: info?.localProof ?? null,
      logFile: connection.logFile,
    }
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
    shutdown,
  }
}
