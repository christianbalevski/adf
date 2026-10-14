import { app, BrowserWindow, dialog, ipcMain as electronIpcMain, type IpcMain } from 'electron'
import { join } from 'node:path'
import type { StudioBackendMode } from '../../../shared/types/backend.types'
import type { AgentStatus, AgentSummary, DaemonClient } from '../../../shared/daemon-client'
import type { NotificationsSnapshot } from '../../../shared/types/ipc.types'
import { IPC } from '../../../shared/constants/ipc-channels'
import { BACKEND_ENV_OVERRIDE } from '../backend-config'
import { CHANNEL_MAP, type ChannelEntry, type MappedChannel } from '../channel-map'
import { processAgentLeases, type AgentLeaseRegistry } from '../../runtime/agent-lease'
import { BackgroundEventBatcher } from '../../ipc/background-event-batch'
import { initApplicationMenu, recordRecentFile } from '../../menu'
import { createAdfFileHandler } from './adf-file'
import { ApprovalsUi } from './approvals-ui'
import { createEventsAdapterSession, type ClientSession } from './client-stream'
import { DaemonConnection, type DaemonConnector } from './connection'
import { findRunningAgent, type DaemonModeContext } from './context'
import { DaemonModeUnavailableError } from './errors'
import { EventBridge } from './event-bridge'
import { DAEMON_MODE_HANDLERS, DAEMON_MODE_SEND_HANDLERS } from './handlers'
import { channelKey, pendingWorkstream } from './pending'
import { DaemonModeSession } from './session'
import { ClientSettingsStore, clientSettingsPath } from './settings'
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

export const RECOVERY_HINT = `To use embedded mode for this session, start Studio with ${BACKEND_ENV_OVERRIDE}=embedded.`

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
  /** The client session implementation. Default: the GET /events adapter until W2-B. */
  createSession?: (client: DaemonClient) => ClientSession
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
  const connection = new DaemonConnection(deps.connect, log, deps.fetch)
  const session = new DaemonModeSession(null, log)

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
    onApprovals: (snapshot) => approvals.apply(snapshot),
    onAgentsChanged: () => { approvals.refresh(); refreshTokens() },
    onFileRenamed: (oldPath, newPath) => session.rekey(oldPath, newPath),
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

  const started: Promise<DaemonClient> = connection.client().then(async (client) => {
    clientSession = (deps.createSession ?? ((c) => createEventsAdapterSession(c)))(client)
    session.attach(clientSession)
    if (clientSession.limitations.length) {
      log.warn(`[Backend] The client stream is the interim ${clientSession.kind}; not delivered yet:\n  - ${clientSession.limitations.join('\n  - ')}`)
    }
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
      approvals.apply(await client.request<NotificationsSnapshot>('GET', '/approvals'))
      // Requests reach the daemon: connected, before the stream's own open.
      connection.markConnected()
    } catch (err) {
      log.warn(`[Backend] Could not read the daemon's approvals at connect: ${err instanceof Error ? err.message : String(err)}`)
    }
    clientSession.start({
      onFrame: (frame) => bridge.handleFrame(frame),
      onGap: (gap) => { void bridge.handleGap(gap) },
      onConnection: (c) => {
        if (c.state === 'open') connection.markConnected()
        else if (c.state === 'reconnecting') connection.markDisconnected(c.error)
      },
      onReattached: (info) => {
        log.log(`[Backend] Client stream reattached${info.epochChanged ? ' to a restarted daemon' : ''}: re-sending the focus and the held documents`)
        void session.reattach()
      },
    })
    return client
  })
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
    ready: () => started,
    runningAgentAt: async (filePath) => findRunningAgent(await started, filePath),
    raw: async (path, query) => {
      const client = await started
      const url = client.url(path, query)
      return (deps.fetch ?? fetch)(url, { headers: client.headers({ Accept: '*/*' }), redirect: 'manual' })
    },
    recordRecentFile,
    hooks,
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
        // Until W3-A's BACKGROUND_AGENT_STATUS: a fresh renderer still learns
        // what already runs, as agent_started events (its listener is
        // registered by the time this call arrives).
        if (channel === IPC.BACKGROUND_AGENT_STATUS) setImmediate(() => bridge.announceRunning())
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
