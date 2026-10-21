import { app, BrowserWindow, dialog, Notification, shell } from 'electron'
import { basename, join } from 'node:path'
import type { BackendDaemonStatus } from '../../../shared/types/backend.types'
import { DaemonError, type AgentStatus, type AgentSummary, type DaemonClient } from '../../../shared/daemon-client'
import type { NotificationsSnapshot } from '../../../shared/types/ipc.types'
import { IPC } from '../../../shared/constants/ipc-channels'
import { runtimeTag, type RuntimeId } from '../../../shared/runtime-tag'
import { channelScope } from '../channel-map'
import { processAgentLeases } from '../../runtime/agent-lease'
import { openSharedMnemonicStore } from '../../services/owner-secret-store'
import { isLocalOnlyRoute, LOCAL_PROOF_HEADER, readLocalProof } from '../../daemon/local-access'
import { BackgroundEventBatcher } from '../../ipc/background-event-batch'
import { initApplicationMenu, recordRecentFile, recordRuntimeRecentFile, renameRuntimeRecentFile, type MenuRuntime } from '../../menu'
import { relaunchEmbeddedForSession, relaunchStudio } from '../boot-handover'
import type { ApprovalsUi } from './approvals-ui'
import { createDaemonClientSession, type ClientQuitAnswer, type ClientSession } from './client-stream'
import { DaemonConnection, type DaemonConnector, type DaemonEndpoint } from './connection'
import { findRunningAgent, type DaemonModeContext } from './context'
import { EventBridge } from './event-bridge'
import { DAEMON_MODE_HANDLERS } from './handlers'
import { DaemonModeSession, samePath } from './session'
import type { ClientSettingsStore } from './settings'
import type { DaemonVersionInfo } from '../../daemon/routes/meta-routes'
import { readDaemonExitCause, waitForDaemonExit } from './daemon-exit'
import { processAlive } from '../../cli/daemon-control'
import { daemonExitSentence } from './connection'
import { InstallProgressRelay } from './mcp/install-progress'
import { McpOAuthAuthorizeOpener } from './mcp/oauth-authorize'
import { ConnectionStatusUi, connectionProblem, openDaemonLog } from './status-ui'
import { REMOTE_WAITING_PREFIX, refusedTokenSentence } from './remote/connector'
import { OAuthCallbackRelay } from './remote/oauth-relay'
import { RemotePicker } from './remote/picker'
import { uploadFile, type RemoteServices } from './remote/services'
import type { BridgeOutput, TurnOutcome } from './event-bridge'
import type { WindowView } from './windows'
import type { DaemonModeDeps, WindowTarget } from './index'
import { RECOVERY_HINT, remoteWaitingNotice } from './hints'

/**
 * One runtime of the runtime set (docs/design/multi-runtime.md §3.2): its
 * connector, client, token source, pin check, the main window's session,
 * bridge, batcher and client session, its agent windows' sessions, its
 * exit watch and its failure state.
 *
 * The primary runtime (This computer, `local`) is exactly what
 * registerDaemonModeHandlers ran before the split: same logs, same dialogs,
 * same pushes. Its traffic is untagged. A remote primary exists only in tests
 * (the remote-variant harness; DaemonModeDeps.mode). Every other runtime (a
 * saved connection, or the remote slot of studio-backend.json):
 *
 * - tags its runtime-scoped pushes with `{ $runtime: id }` (§4.1);
 * - prefixes its log lines with its id;
 * - never opens a dialog: a failure is a notice and its state (§3.6);
 * - has no menu, no exit watch, no revive, no local proof, no shared owner
 *   phrase and no recent files (local only, §3.2, §8.2);
 * - never stops its daemon (M10): quit ends its sessions, bounded.
 */

/** How long a lost daemon connection may last before waiting chats are ended. */
export const TURN_DISCONNECT_GRACE_MS = 15_000
/** How long a restart waits for each agent window to keep its unsaved text. */
export const AGENT_WINDOW_STASH_WAIT_MS = 5_000
/** How long ending one agent window's session may take; the main session's quit request follows within the quit budget. */
export const AGENT_SESSION_END_TIMEOUT_MS = 1_500
/**
 * Local mode, a daemon Studio started exited: Studio starts it again by
 * itself after this pause, at most once per window below (a daemon that
 * keeps dying is then left to the user's "Start the ADF Daemon").
 */
export const DAEMON_RESPAWN_DELAY_MS = 2_000
export const DAEMON_RESPAWN_WINDOW_MS = 10 * 60_000

/** COMPUTE_BROWSER_SESSION in remote mode (§9.3): the viewer is on the server's loopback, never opened here. */
export const REMOTE_BROWSER_SESSION_SENTENCE = 'opened a browser in its container on the daemon host. Its viewer is on that host\'s loopback, so Studio cannot show it here; use a tunnel to the container\'s noVNC port, or Studio on that host.'

export type RuntimeKind = 'local' | 'remote'

/** What every runtime shares (Studio-wide, held by registerDaemonModeHandlers). */
export interface RuntimeShared {
  clientSettings: ClientSettingsStore
  approvals: ApprovalsUi
  hooks: NonNullable<DaemonModeDeps['hooks']>
  firstWindow(): BrowserWindow | null
  /**
   * A runtime's approvals snapshot (stream push or resync): the merge, notice
   * windows, native notifier. `from`: the connection it came on; a snapshot
   * of a connection that is not (or no longer) the runtime's in the set is
   * dropped (a runtime that retires).
   */
  approvalsIn(runtimeId: RuntimeId, snapshot: NotificationsSnapshot, from: DaemonConnection): void
  /** A runtime's approvals push: the merged snapshot to every window. Dropped like approvalsIn. */
  publishApprovals(runtimeId: RuntimeId, snapshot: NotificationsSnapshot, from: DaemonConnection): void
  /** Agent windows that closed (or are closing): their calls are refused (any runtime). */
  closedWindows: Set<number>
  /** A runtime's agent window closed: its notices move to the main window. */
  windowClosed(windowId: number): void
  /** Every runtime of the set as the menu shows it (Help, Open Recent; multi-runtime.md §6.6). */
  menuRuntimes(): MenuRuntime[]
}

export interface RuntimeConnectionOptions {
  id: RuntimeId
  kind: RuntimeKind
  /** This computer (tests: a remote primary): untagged traffic, the menu, the dialogs, the client lease. */
  primary: boolean
  /** The runtime's name, for notices ("box-1"). */
  name: () => string
  deps: DaemonModeDeps
  shared: RuntimeShared
  /** A non-primary runtime that failed: Reconnect replaces it (§3.4). */
  recreate?: () => void
}

/** An agent window's client session, bound to this runtime. */
interface WindowSession {
  id: number
  target: WindowTarget
  session: DaemonModeSession
  bridge: EventBridge
  batcher: BackgroundEventBatcher
  client: ClientSession | null
  closed: boolean
  ready: Promise<DaemonClient>
  ctx: DaemonModeContext
}

/** How Studio's quit ends a runtime (main/index.ts runShutdownCleanup). */
export interface QuitOptions {
  /** "Keep Running" in the question about connected computers: this quit only. */
  keepDaemonRunning?: boolean
  /** A restart into Inside Studio: wait up to this long for This computer's daemon to exit once it said it stops. */
  waitForDaemonExitMs?: number
  /**
   * Called when that wait starts (R2A-4): only then is the daemon's answer in, so the caller's own deadline moves
   * to the wait plus its margin instead of cutting the wait short.
   */
  onExitWait?: (ms: number) => void
}

export interface RuntimeConnection {
  readonly id: RuntimeId
  readonly kind: RuntimeKind
  readonly primary: boolean
  name(): string
  connection: DaemonConnection
  /** The main window's session on this runtime. */
  session: DaemonModeSession
  bridge: EventBridge
  /** The main window's handler context on this runtime. */
  ctx: DaemonModeContext
  /** The fetch this runtime's requests use (adf-file://). */
  fetch: typeof fetch | undefined
  /** Resolves once connected and the client stream started; false when no daemon could be reached. */
  ready: Promise<boolean>
  started: Promise<DaemonClient>
  reconnect(): void
  /** The Help menu's status line (`ADF daemon: …`), or null while connected. */
  problem(): string | null
  /** Reconnect makes sense now: the connection dropped, or failed. */
  canReconnect(): boolean
  status(): BackendDaemonStatus
  client(): Promise<DaemonClient>
  setKeepDaemonRunning(keep: boolean): Promise<void>
  /** Running agents not focused in the main window, and the main window's foreground agent (menu bar). */
  menuBarAgents(): Array<{ filePath: string; state: import('../../../shared/types/ipc.types').AgentState; activeLoops?: number; runtimeId?: string }>
  foreground(): { filePath: string; state: import('../../../shared/types/ipc.types').AgentState; runtimeId?: string } | null
  tokensToday(): { input: number; output: number }
  windows: {
    open(target: WindowTarget): void
    close(id: number): Promise<void>
    has(id: number): boolean
    ids(): number[]
    ctx(id: number): DaemonModeContext | null
    session(id: number): DaemonModeSession | null
    current(id: number): { filePath: string; agentId: string | null } | null
    focused(id: number): boolean
    views(): WindowView[]
    send(id: number, channel: string, ...args: unknown[]): void
    stashed(id: number): void
  }
  shutdown(opts?: QuitOptions): Promise<void>
}

const RESUME_HEALTH_TIMEOUT_MS = 3_000

/** The daemon's remote-access management routes (remote-access.md §11.2). */
export function isRemoteAccessRoute(path: string): boolean {
  const p = path.split('?')[0]
  return p === '/remote-access' || p.startsWith('/remote-access/')
}

/** A log whose lines name the runtime: `[Backend] x` → `[Backend remote:box-1] x`. */
export function runtimeLog(log: Pick<Console, 'log' | 'warn' | 'error'>, id: RuntimeId): Pick<Console, 'log' | 'warn' | 'error'> {
  const tag = (args: unknown[]): unknown[] => {
    if (typeof args[0] !== 'string') return [`[${id}]`, ...args]
    const m = /^\[([^\]]+)\]/.exec(args[0])
    return [m ? `[${m[1]} ${id}]${args[0].slice(m[0].length)}` : `[${id}] ${args[0]}`, ...args.slice(1)]
  }
  return {
    log: (...args: unknown[]) => log.log(...tag(args)),
    warn: (...args: unknown[]) => log.warn(...tag(args)),
    error: (...args: unknown[]) => log.error(...tag(args)),
  }
}

export function createRuntimeConnection(opts: RuntimeConnectionOptions): RuntimeConnection {
  const { deps, shared, id, kind, primary } = opts
  const log = primary ? deps.log ?? console : runtimeLog(deps.log ?? console, id)
  const hooks = shared.hooks
  const clientSettings = shared.clientSettings
  const approvals = shared.approvals
  const firstWindow = shared.firstWindow
  const remote = kind === 'remote'
  const tag = primary ? null : runtimeTag(id)
  /** Runtime-scoped pushes of a non-primary runtime carry its tag (§4.1); Studio and aggregate pushes never do. */
  const pushArgs = (channel: string, args: unknown[]): unknown[] => tag && channelScope(channel) === 'runtime' ? [tag, ...args] : args

  // Studio runs no agents in this mode: it records itself as a client, not a
  // runtime host, so `adf daemon start` does not refuse it (agent-lease.ts).
  // The daemon's URL is added once the connector found it. The primary runtime's only.
  const leases = deps.leases ?? processAgentLeases()
  const clientRecord = { settingsPath: join(deps.userDataDir, 'adf-settings.json'), version: app.getVersion() }
  if (primary) void leases.registerClient(deps.mode, clientRecord)
  const keepRunning = (): boolean => typeof deps.keepDaemonRunning === 'function' ? deps.keepDaemonRunning() : deps.keepDaemonRunning === true

  // Local mode: the daemon is this machine's and keeps its settings next to
  // Studio's (daemon-process.ts checks that), so Studio reads its local proof
  // and sends it on the local-only routes (owner import, stored-value
  // reveal), as the adf CLI does. Never for another route or another host.
  const withLocalProof = (find: (progress: (text: string) => void) => Promise<DaemonEndpoint>) => async (progress: (text: string) => void): Promise<DaemonEndpoint> => {
    const endpoint = await find(progress)
    const port = Number(new URL(endpoint.baseUrl).port) || undefined
    return {
      ...endpoint,
      source: {
        ...endpoint.source,
        token: () => endpoint.source.token(),
        ...(endpoint.source.refresh ? { refresh: () => endpoint.source.refresh!() } : {}),
        localProof: (path: string): Record<string, string> => {
          // /remote-access: the management routes need the proof in every mode (remote-access.md §4.5, §11.2).
          if (!isLocalOnlyRoute(path) && !isRemoteAccessRoute(path)) return {}
          const proof = readLocalProof(deps.userDataDir, port)
          return proof ? { [LOCAL_PROOF_HEADER]: proof } : {}
        },
      },
    }
  }
  const connect: DaemonConnector = kind !== 'local' ? deps.connect : Object.assign(
    withLocalProof(deps.connect),
    {
      logFile: deps.connect.logFile,
      ...(deps.connect.revive ? { revive: withLocalProof(deps.connect.revive) } : {}),
      ...(deps.connect.verifyListener ? { verifyListener: deps.connect.verifyListener } : {}),
    },
  )
  // Remote, a pinned connection: before every new connection the address must show the pinned fingerprint (connection.ts).
  const redial = (reason: string): void => {
    if (!connection.pinned) { reconnectStreams(); return }
    void connection.reverify(reason).then((ok) => { if (ok) reconnectStreams() })
  }
  // Remote mode: a 401 after connecting (the server's token changed) is the
  // "refused the token" sentence and ends the connection; retrying could not
  // help (W4-B review). /health carries no token and is not counted. This
  // runtime's only (§3.5).
  let unauthorized = false
  const onUnauthorized = (): void => {
    if (unauthorized) return
    unauthorized = true
    const url = connection.baseUrl ?? 'the remote daemon'
    log.error(`[Backend] The agent server at ${url} answered 401: the saved token is no longer accepted; the connection stops`)
    connection.markFailed(refusedTokenSentence(url))
    failAllTurns('disconnected')
    void clientSession?.end().catch(() => {})
    for (const w of windowSessions.values()) void w.client?.end().catch(() => {})
  }
  const baseFetch: typeof fetch = deps.fetch ?? ((input, init) => fetch(input, init))
  const connectionFetch: typeof fetch | undefined = !remote ? deps.fetch : (async (input: string | URL | Request, init?: RequestInit) => {
    const res = await baseFetch(input, init)
    if (res.status === 401 && !unauthorized) {
      const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url)
      if (connection.baseUrl && url.origin === new URL(connection.baseUrl).origin && url.pathname !== '/health') onUnauthorized()
    }
    return res
  }) as typeof fetch
  // A runtime other than the primary can leave the set while its connector still retries: disposing it stops the connector.
  const connection = new DaemonConnection(connect, log, connectionFetch, primary ? {} : { stopWhenDisposed: true })

  /** A notice for the user: the primary's through its status UI; another runtime's names it (an OS notification, never a dialog). */
  const notice = (text: string): void => {
    if (primary) { statusUi?.notice(text); return }
    try {
      if (Notification.isSupported()) new Notification({ title: 'ADF Studio', body: `${opts.name()}: ${text}` }).show()
    } catch (err) {
      log.warn('[Backend] Could not show a notification:', err)
    }
  }
  // Remote mode, unreachable at launch: the connector retries (remote/connector.ts); say so once.
  let waitingNoticed = false
  connection.onState((state) => {
    if (!remote || waitingNoticed || state.state !== 'connecting' || !state.progress?.startsWith(REMOTE_WAITING_PREFIX)) return
    waitingNoticed = true
    notice(remoteWaitingNotice(state.progress))
  })
  // Another runtime's failure is a notice and its state, never a modal dialog (§3.6).
  if (!primary) {
    connection.onState((state) => {
      if (state.state === 'failed') notice(`Not connected: ${state.message}`)
    })
  }
  // A re-hold that failed after a reconnect is a notice (statusUi exists by the time a reconnect happens).
  const session = new DaemonModeSession(null, log, (text) => { log.warn(`[Backend] ${text}`); notice(text) }, remote)

  // --- Agent windows (docs/design/agent-windows.md) ---------------------------
  // Each agent window is its own client session (D5) with its own document
  // holds, focus, stream and bridge. The main window keeps `session` and
  // `bridge` below; an IPC call is served by its sender's session.
  const windowSessions = new Map<number, WindowSession>()
  const reconnectStreams = (): void => {
    clientSession?.reconnect()
    for (const w of windowSessions.values()) w.client?.reconnect()
  }
  const failAllTurns = (outcome: Extract<TurnOutcome, 'disconnected' | 'exited' | 'stopped'>): void => {
    bridge.failTurns(outcome)
    for (const w of windowSessions.values()) w.bridge.failTurns(outcome)
  }

  const output = {
    send(channel: string, ...args: unknown[]) {
      const win = firstWindow()
      if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
      try { win.webContents.send(channel, ...pushArgs(channel, args)) } catch { /* window going away */ }
    },
    sendAll(channel: string, ...args: unknown[]) {
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed() || win.webContents.isDestroyed()) continue
        try { win.webContents.send(channel, ...pushArgs(channel, args)) } catch { /* window going away */ }
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
  const remoteServices: RemoteServices | null = !remote ? null : (() => {
    const host = (): string => {
      try { return new URL(connection.baseUrl ?? '').host || 'the daemon host' } catch { return 'the daemon host' }
    }
    const picker = new RemotePicker({
      host,
      log,
      send: (request) => {
        const win = BrowserWindow.getFocusedWindow() ?? firstWindow()
        if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return false
        win.webContents.send(IPC.REMOTE_PICKER_REQUEST, ...pushArgs(IPC.REMOTE_PICKER_REQUEST, [request]))
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
          detail: `The agent server at ${daemonHost} asks to open ${pageHost} in your browser (${label}). Open it only if you started this sign-in.`,
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
    return { picker, oauth, host, name: () => (primary ? deps.runtimeName?.() : opts.name()) || host(), upload: uploadFile(deps.fetch ?? fetch) }
  })()

  const mcpOAuth = new McpOAuthAuthorizeOpener({
    mode: kind,
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
  // The macOS menu bar's first refresh runs before the bridge exists: no agents yet.
  const runningAgents = () => (bridge ? bridge.runningAgents() : [])
  /** One approvals snapshot: the merge, notice windows, the native notifier and the menu bar; this runtime's MCP sign-ins. */
  const applyApprovals = (snapshot: NotificationsSnapshot): void => {
    // A runtime that is quitting or leaving the set shows nothing more: no notice, no sign-in page.
    if (shutdownPromise) return
    shared.approvalsIn(id, snapshot, connection)
    void mcpOAuth.apply(snapshot)
  }

  // Remote mode: a browser session's viewer port is the server's loopback.
  // Opening it here would load this computer's loopback, so the push is
  // replaced by a notice (remote-unsupported, design §9.3).
  // An agent window's bridge drops the push: the main window's says it once.
  const remoteBrowserSession = (out: BridgeOutput, announce: boolean): BridgeOutput => !remote ? out : {
    send(channel: string, ...args: unknown[]) {
      if (channel === IPC.COMPUTE_BROWSER_SESSION) {
        if (!announce) return
        const name = (args[0] as { agentName?: unknown } | undefined)?.agentName
        const text = `${typeof name === 'string' && name ? name : 'An agent'} ${REMOTE_BROWSER_SESSION_SENTENCE}`
        log.warn(`[Remote] ${text}`)
        notice(text)
        return
      }
      out.send(channel, ...args)
    },
    sendAll: (channel: string, ...args: unknown[]) => out.sendAll(channel, ...args),
  }
  // APPROVALS_CHANGED reaches every window from the main window's stream, merged (publishApprovals).
  const bridgeOutput = remoteBrowserSession({
    send: (channel: string, ...args: unknown[]) => output.send(channel, ...args),
    sendAll: (channel: string, ...args: unknown[]) => {
      if (channel === IPC.APPROVALS_CHANGED) { if (!shutdownPromise) shared.publishApprovals(id, args[0] as NotificationsSnapshot, connection) }
      else output.sendAll(channel, ...args)
    },
  }, true)
  bridge = new EventBridge({
    session,
    output: bridgeOutput,
    batcher,
    client: () => connection.current,
    onApprovals: applyApprovals,
    onAgentsChanged: () => { approvals.refresh(); refreshTokens() },
    onFileRenamed: (oldPath, newPath) => session.rekey(oldPath, newPath),
    onNotice: (text) => notice(text),
    // The remote-access host IPC is This computer's (§3.2).
    ...(kind === 'local' ? { onRemoteAccess: (payload: unknown) => deps.onRemoteAccessEvent?.(payload) } : {}),
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
  const restartKeepingEdits = (restartKind: 'reconnect' | 'embedded-session', reason: string): void => {
    const restart = () => restartKind === 'reconnect' ? relaunch.reconnect(reason) : relaunch.embeddedForSession(reason)
    // Agent windows keep theirs first (agent-windows.md); the main window then restarts.
    void stashAgentWindows().then(() => {
      const win = firstWindow()
      if (!win || win.isDestroyed() || win.webContents.isDestroyed()) { restart(); return }
      log.log(`[Backend] Asking the window to keep its unsaved editor text as recovery copies, then restarting (${reason})`)
      win.webContents.send(IPC.MENU_ACTION, restartKind === 'reconnect' ? 'stash-edits-and-reconnect' : 'stash-edits-and-use-embedded')
      const fallback = setTimeout(() => {
        log.warn('[Backend] The window did not restart Studio after keeping its unsaved text; restarting now')
        restart()
      }, deps.stashWaitMs ?? 15_000)
      fallback.unref?.()
    })
  }
  /** Each agent window keeps its unsaved editor text as recovery copies (`stash-edits`, answered by WINDOW_STASH_DONE). */
  const stashWaits = new Map<number, () => void>()
  const stashAgentWindows = (): Promise<void> => Promise.all([...windowSessions.values()].map((w) => new Promise<void>((done) => {
    const timer = setTimeout(() => {
      log.warn(`[Backend] Agent window ${w.id} did not keep its unsaved text in time; restarting without it`)
      finish()
    }, AGENT_WINDOW_STASH_WAIT_MS)
    timer.unref?.()
    const finish = (): void => { clearTimeout(timer); stashWaits.delete(w.id); done() }
    stashWaits.set(w.id, finish)
    w.target.send(IPC.MENU_ACTION, 'stash-edits')
  }))).then(() => {})
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
      if (!primary) {
        // §3.4: a failed runtime is replaced, never by restarting Studio. Its windows keep their unsaved text first.
        log.log(`[Backend] Reconnect requested after a failed connection (${state.message}): connecting again`)
        void stashAgentWindows().then(() => opts.recreate?.())
        return
      }
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
      if (!primary) return
      void dialog.showMessageBox({
        type: 'info',
        message: 'Studio is still connecting to the ADF daemon.',
        detail: `It connects when the daemon answers. ${RECOVERY_HINT}`,
        buttons: ['OK'],
      }).catch(() => {})
      return
    }
    if (kind === 'local' && daemonGone()) {
      // The daemon's process is gone: re-dialing the stream cannot help; find or start one (controller.ensure).
      void reviveDaemon('requested')
      return
    }
    log.log('[Backend] Reconnecting to the ADF daemon (requested)')
    redial('a requested reconnect')
  }
  /**
   * After a failed launch, local mode only: embedded for this launch only;
   * the saved mode stays (§8.2 session-only). Not in remote mode: embedded
   * Studio autostarts this computer's agents, which may run on the server
   * too (two pollers of one bot, Telegram 409).
   */
  const useEmbeddedForSession = primary && kind === 'local' ? (): void => {
    const state = connection.state
    void confirmRestart('Run Inside Studio for This Session', state.state === 'failed' ? state.message : 'not connected').then((ok) => {
      if (!ok) return
      log.log('[Backend] Run Inside Studio for This Session requested after a failed connection to the ADF daemon')
      restartKeepingEdits('embedded-session', clientSession ? 'the ADF daemon connection failed during the session' : 'no ADF daemon could be reached at launch')
    })
  } : undefined
  const problem = (): string | null => connectionProblem(connection.state, connection.baseUrl)
  const canReconnect = (): boolean => connection.state.state === 'disconnected' || connection.state.state === 'failed'
  if (primary) {
    initApplicationMenu(clientSettings, {
      logFile: () => connection.logFile,
      problem,
      canReconnect,
      openLog: () => { void openDaemonLog(connection.logFile, log) },
      reconnect,
      useEmbeddedForSession,
      launchFailed: () => connection.state.state === 'failed',
      remoteRecents: remote,
      runtimes: () => shared.menuRuntimes(),
      ...(hooks.openFileOn ? { openOnRuntime: hooks.openFileOn } : {}),
    })
  }
  // Failure dialogs are the primary runtime's only (§3.6).
  const statusUi: ConnectionStatusUi | null = !primary ? null : new ConnectionStatusUi(connection, {
    reconnect,
    useEmbeddedForSession,
    openLog: () => { void openDaemonLog(connection.logFile, log) },
    recoveryHint: RECOVERY_HINT,
    reviving: () => reviving !== null,
  }, log)

  const exitDaemonWhenClosed = kind === 'local' && !keepRunning()
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
  const newClientSession = (client: DaemonClient, exitWhenClosed: boolean): ClientSession =>
    (deps.createSession ?? ((c) => createDaemonClientSession(c, { version: app.getVersion(), exitDaemonWhenClosed: exitWhenClosed, log, ...(kind === 'local' ? { pid: process.pid } : {}) })))(client)
  /** Quit or Remove came while `started` awaited: it goes no further (no request, no session, no approvals). */
  const stopIfShutDown = (): void => {
    if (shutdownPromise) throw new Error(`${opts.name()}: Studio closed this connection`)
  }
  const started: Promise<DaemonClient> = connection.client().then(async (client) => {
    stopIfShutDown()
    if (primary) void leases.registerClient(deps.mode, { ...clientRecord, ...(connection.baseUrl ? { controlUrl: connection.baseUrl } : {}) })
    versionInfo = connection.endpointInfo?.daemon ?? null
    if (!versionInfo) void client.request<DaemonVersionInfo>('GET', '/version').then((v) => { versionInfo = v }).catch(() => {})
    if (deps.reloadCredentials && kind === 'local' && primary) {
      // The handover moved credentials while this daemon may already have been running.
      void client.request<{ runtime: { state: string } | null; unlocked: unknown[]; stillLocked: unknown[]; sessions: string[]; recovered: number }>('POST', '/client/reload-credentials')
        .then((r) => log.log(`[Backend] The ADF daemon reloaded the moved credentials: runtime identity ${r.runtime?.state ?? 'n/a'}, ${r.unlocked.length} agent(s) unlocked, ${r.stillLocked.length} still locked, sessions [${r.sessions.join(', ')}]`))
        .catch((err) => log.warn(`[Backend] Asking the ADF daemon to reload the moved credentials failed: ${err instanceof Error ? err.message : String(err)}`))
    }
    const cs = newClientSession(client, exitDaemonWhenClosed)
    clientSession = cs
    session.attach(cs)
    /** After each await: a quit or Remove meanwhile ends the session it opened here (shutdown may have run before it existed). */
    const bail = (): void => {
      if (!shutdownPromise) return
      void cs.end().catch(() => {})
      stopIfShutDown()
    }
    // Learn what already runs and what is pending, without pushing: the
    // renderer pulls its initial state itself.
    try {
      const summaries = await client.request<AgentSummary[]>('GET', '/agents')
      const statuses = await Promise.all(summaries.map((s) =>
        client.request<AgentStatus>('GET', `/agents/${encodeURIComponent(s.id)}/status`).catch(() => null)))
      bail()
      bridge.seed(statuses.filter((s): s is AgentStatus => !!s))
    } catch (err) {
      bail()
      log.warn(`[Backend] Could not list the daemon's agents at connect: ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      const snapshot = await client.request<NotificationsSnapshot>('GET', '/approvals')
      bail()
      applyApprovals(snapshot)
      // Requests reach the daemon: connected, before the stream's own open.
      connection.markConnected()
    } catch (err) {
      bail()
      log.warn(`[Backend] Could not read the daemon's approvals at connect: ${err instanceof Error ? err.message : String(err)}`)
    }
    cs.start({
      onFrame: (frame) => { if (installs.observe(frame)) bridge.handleFrame(frame) },
      onGap: (gap) => { installs.onGap(); void bridge.handleGap(gap) },
      onConnection: (c) => {
        if (c.state === 'open') connection.markConnected()
        else if (c.state === 'reconnecting') connection.markDisconnected(c.error)
      },
      onReattached: (info) => {
        log.log(`[Backend] Client stream reattached${info.epochChanged ? ' (new session)' : ''}: re-sending the focus and the held documents`)
        // The daemon may have restarted (another pid, version or launcher): Settings → Connections reads this.
        refreshVersion(client)
        return session.reattach()
      },
      onFatal: (message) => {
        connection.markFailed(message)
        failAllTurns('disconnected')
      },
    })
    return client
  })
  /** Requests name the client session (X-ADF-Client-Session): the daemon does not echo this window's own writes (D5.1). */
  const sessionClient = (client: DaemonClient): DaemonClient => {
    const sid = clientSession?.sessionId
    return sid ? client.withClientSession(sid) : client
  }
  started.catch(() => {})

  // AGENT_INVOKE waits must not outlive the daemon: a failed connector ends
  // them at once, a disconnect that lasts past the grace period too (the
  // handler reports it).
  let turnGrace: ReturnType<typeof setTimeout> | null = null
  connection.onState((state) => {
    if (state.state === 'failed') failAllTurns('disconnected')
    if (state.state === 'disconnected' && !turnGrace) {
      turnGrace = setTimeout(() => {
        turnGrace = null
        if (connection.state.state === 'disconnected') {
          log.warn(`[Backend] The ADF daemon has been away for ${TURN_DISCONNECT_GRACE_MS / 1000}s; ending the chats that wait for their turn`)
          failAllTurns('disconnected')
        }
      }, TURN_DISCONNECT_GRACE_MS)
      turnGrace.unref?.()
    }
    if (state.state === 'connected' && turnGrace) { clearTimeout(turnGrace); turnGrace = null }
    // Chats whose wait ended while away: their agent's real state now.
    if (state.state === 'connected') {
      void bridge.recheckTurns()
      for (const w of windowSessions.values()) void w.bridge.recheckTurns()
    }
  })

  // --- Local mode: the daemon's process exited ---------------------------------
  // A dropped stream is "lost" while the daemon's pid lives (the stream
  // retries) and "exited" once it is gone: its agents are stopped and only
  // a new daemon brings them back. A daemon Studio started is started again
  // once (controller.ensure through the connector's revive), visibly; one
  // the CLI started is never started by Studio on its own: the dialog
  // offers it.
  const alive = deps.processAlive ?? processAlive
  const daemonPid = (): number | null => versionInfo?.pid ?? connection.endpointInfo?.daemon?.pid ?? null
  const daemonGone = (): boolean => {
    const pid = daemonPid()
    return pid !== null && connection.state.state === 'disconnected' && !alive(pid)
  }
  let exitChecked: number | null = null
  let exitWatchGeneration = 0
  let exitWatchTimer: ReturnType<typeof setTimeout> | null = null
  let wakeExitWatch: (() => void) | null = null
  let exitWatch: Promise<void> | null = null
  const stopExitWatch = (): void => {
    exitWatchGeneration++
    if (exitWatchTimer) clearTimeout(exitWatchTimer)
    exitWatchTimer = null
    wakeExitWatch?.()
    wakeExitWatch = null
    exitWatch = null
  }
  let lastAutoRespawnAt = 0
  let reviving: Promise<boolean> | null = null
  /** Agents running when the daemon exited: started again with the new daemon. */
  let agentsAtExit: string[] = []
  const waitExitWatch = (ms: number) => new Promise<void>((resolve) => {
    wakeExitWatch = resolve
    exitWatchTimer = setTimeout(() => { exitWatchTimer = null; wakeExitWatch = null; resolve() }, ms)
    exitWatchTimer.unref?.()
  })

  const checkDaemonExit = async (generation: number): Promise<void> => {
    const pid = daemonPid()
    if (pid === null || exitChecked === pid) return
    const watching = () => generation === exitWatchGeneration && !shutdownPromise && connection.state.state === 'disconnected' && daemonPid() === pid
    // A graceful daemon shutdown can outlast the stream by many seconds.
    // Observe its PID for the entire outage, even if SSE emits no new state.
    while (watching() && alive(pid)) {
      await waitExitWatch(250)
    }
    if (!watching() || exitChecked === pid) return
    exitChecked = pid
    const cause = await readDaemonExitCause(connection.logFile)
    if (!watching()) return
    const startedBy = versionInfo?.startedBy ?? connection.endpointInfo?.daemon?.startedBy ?? null
    agentsAtExit = bridge.runningAgents().map((a) => a.filePath)
    const recent = lastAutoRespawnAt > 0 && Date.now() - lastAutoRespawnAt < DAEMON_RESPAWN_WINDOW_MS
    const auto = startedBy === 'studio' && !cause?.deliberate && !recent && connection.canRevive
    const detail = auto ? undefined
      : startedBy !== 'studio' ? `It was started by ${startedBy ?? 'another program'}, not by Studio, so Studio does not start it again by itself.`
        : cause?.deliberate ? 'It was stopped on purpose, so Studio does not start it again by itself.'
          : recent ? `Studio already started it again ${Math.max(1, Math.round((Date.now() - lastAutoRespawnAt) / 60_000))} min ago and does not do so twice within ${DAEMON_RESPAWN_WINDOW_MS / 60_000} minutes.`
            : undefined
    log.warn(`[Backend] ${daemonExitSentence({ pid, cause: cause?.text ?? null })}${cause ? '' : ' Its log has no shutdown line: it was killed or crashed.'} Started by ${startedBy ?? 'unknown'}; ${agentsAtExit.length} agent(s) were running.${auto ? ' Studio starts it again.' : ''}`)
    // The turns its agents ran cannot end any more.
    failAllTurns('exited')
    if (!auto) {
      // A daemon replaced from the terminal (`adf daemon restart`) answers again within moments: no dialog then.
      await waitExitWatch(deps.respawnDelayMs ?? DAEMON_RESPAWN_DELAY_MS)
      if (!watching()) {
        log.log(`[Backend] Another ADF daemon answered after pid ${pid} exited`)
        return
      }
    }
    connection.markExited({ pid, cause: cause?.text ?? null, startedBy, respawning: auto, ...(detail ? { detail } : {}) })
    if (!auto) return
    lastAutoRespawnAt = Date.now()
    await waitExitWatch(deps.respawnDelayMs ?? DAEMON_RESPAWN_DELAY_MS)
    if (!watching()) return
    void reviveDaemon('automatic')
  }
  // The token goes out again only once the listener is the daemon its pid file names (local), or the address shows the
  // pinned fingerprint (remote; connection.ts): re-dial then, not at the next backoff.
  connection.onListenerVerified(() => { if (connection.state.state !== 'connected') reconnectStreams() })
  if (kind === 'local') {
    connection.onState((state) => {
      if (state.state === 'connected' || state.state === 'failed') stopExitWatch()
      if (state.state === 'disconnected' && !state.exited && !shutdownPromise && !reviving && !exitWatch) {
        const generation = exitWatchGeneration
        exitWatch = checkDaemonExit(generation).catch((err) => log.warn('[Backend] Checking the daemon process failed:', err)).finally(() => {
          if (generation === exitWatchGeneration) exitWatch = null
        })
      }
    })
  }

  /**
   * The computer woke up. A stream that slept is often dead without knowing
   * it; the idle watchdog would notice only after 75 s. Check the daemon
   * (/health, no token, 3 s) and re-dial the stream at once: the resume is
   * exact when the daemon kept the session, a new session otherwise. A
   * daemon that does not answer is a lost connection now (local mode: the
   * exit check and the pid check before the token run from there).
   */
  const onSystemResume = (): void => {
    const client = connection.current
    const state = connection.state.state
    if (shutdownPromise || !clientSession || !client || state === 'failed' || state === 'connecting') return
    log.log('[Backend] The computer resumed: checking the ADF daemon and re-dialing the client stream')
    // A pinned connection sends nothing to the address before its fingerprint is checked again.
    if (connection.pinned) { redial('the computer resumed'); return }
    void client.withTimeout(RESUME_HEALTH_TIMEOUT_MS).health().then(
      () => { reconnectStreams() },
      (err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err)
        log.warn(`[Backend] The ADF daemon did not answer after the computer resumed: ${reason}`)
        connection.markDisconnected(`no answer after the computer resumed: ${reason}`)
        reconnectStreams()
      },
    )
  }
  deps.powerMonitor?.on('resume', onSystemResume)

  /** Resolves true once the stream is connected again (the new session opened, documents re-held, focus re-sent). */
  const waitConnected = (budgetMs: number): Promise<boolean> => new Promise((done) => {
    if (connection.state.state === 'connected') { done(true); return }
    const timer = setTimeout(() => { off(); done(false) }, budgetMs)
    timer.unref?.()
    const off = connection.onState((state) => {
      if (state.state !== 'connected' && state.state !== 'failed') return
      clearTimeout(timer)
      off()
      done(state.state === 'connected')
    })
  })

  /**
   * Find or start the daemon again (the connector's revive: daemon-process.ts
   * `ensure`, attach or spawn), reconnect the stream (the new daemon has no
   * session: a new one opens, the documents are re-held and the focus
   * re-sent), then start the agents that ran when it exited. Every step is
   * logged; the result is a notice, a failure the exit dialog.
   */
  const reviveDaemon = (trigger: 'automatic' | 'requested'): Promise<boolean> => {
    reviving ??= (async () => {
      const previous = connection.state.state === 'disconnected' ? connection.state.exited : undefined
      log.log(`[Backend] Starting the ADF daemon again (${trigger === 'automatic' ? 'automatically, once' : 'requested'}) after pid ${previous?.pid ?? daemonPid() ?? '?'} exited`)
      try {
        const endpoint = await connection.revive()
        if (endpoint.daemon) versionInfo = endpoint.daemon
        // Dial now unless the stream's own retry already reached the new daemon (a re-dial would drop that stream).
        if (connection.state.state !== 'connected') reconnectStreams()
        if (!(await waitConnected(60_000))) throw new Error('the new ADF daemon did not accept the client stream within 60 s')
        const toStart = agentsAtExit
        agentsAtExit = []
        const restarted: string[] = []
        const failed: string[] = []
        // The new daemon may have started some itself (autostart); the bridge still lists the dead daemon's.
        const loaded = toStart.length ? await (await started).request<AgentSummary[]>('GET', '/agents').catch(() => [] as AgentSummary[]) : []
        for (const filePath of toStart) {
          const name = basename(filePath, '.adf')
          if (loaded.some((a) => a.filePath && samePath(a.filePath, filePath, remote))) { restarted.push(name); continue }
          const result = await startAgentAgain(filePath)
          if (result.success) restarted.push(name)
          else failed.push(`${name} (${result.error ?? 'failed'})`)
        }
        const pid = versionInfo?.pid ?? endpoint.daemon?.pid
        const text = `Studio started the ADF daemon again${pid ? ` (pid ${pid})` : ''}.${toStart.length ? ` Agents running again: ${restarted.length} of ${toStart.length}.` : ''}${failed.length ? ` Not started: ${failed.join(', ')}.` : ''}`
        log.log(`[Backend] ${text}`)
        notice(text)
        return true
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.error(`[Backend] Starting the ADF daemon again failed: ${message}`)
        if (previous && connection.state.state === 'disconnected') connection.markExited({ ...previous, respawning: false, detail: `Starting it again failed: ${message}` })
        else notice(`Starting the ADF daemon again failed: ${message}`)
        return false
      } finally {
        reviving = null
      }
    })()
    return reviving
  }

  /** A window's handler context: its own session, bridge and session-stamped client; everything else this runtime's or Studio's. */
  const contextFor = (s: DaemonModeSession, b: EventBridge, ready: () => Promise<DaemonClient>): DaemonModeContext => ({
    mode: kind,
    connection,
    session: s,
    bridge: b,
    clientSettings,
    approvals,
    installs,
    ready,
    runningAgentAt: async (filePath) => findRunningAgent(await started, filePath),
    raw: async (path, query) => {
      const client = await ready()
      const url = client.url(path, query)
      return (deps.fetch ?? fetch)(url, { headers: client.headers({ Accept: '*/*' }), redirect: 'manual' })
    },
    // The owner phrase Studio and This computer's daemon share (§3.2): local only.
    sharedMnemonic: primary ? deps.sharedMnemonic ?? openSharedMnemonicStore : () => null,
    // Recent files: This computer's (or the primary remote's) `recentFiles`; another runtime's under its id in
    // `runtimeRecentFiles` (§7.4), never in the OS recent list or a local-open grant (§8.3).
    recordRecentFile: primary ? recordRecentFile : (filePath) => recordRuntimeRecentFile(id, filePath),
    ...(primary ? {} : { renameRecentFile: (oldPath: string, newPath: string) => renameRuntimeRecentFile(id, oldPath, newPath) }),
    hooks,
    ...(primary && deps.afterOwnerImport ? { afterOwnerImport: deps.afterOwnerImport } : {}),
    remote: remoteServices,
    runtime: { id, primary },
    log,
  })
  const ctx = contextFor(session, bridge, () => started.then(sessionClient))

  /** A push to one agent window, tagged like every push of this runtime. */
  const sendToWindow = (target: WindowTarget, channel: string, args: unknown[]): void => target.send(channel, ...pushArgs(channel, args))

  /**
   * An agent window's client session: opened once the daemon is reached
   * (`started`), never `exitDaemonWhenClosed` (the main window's session
   * carries the quit rule). Its frames feed its own bridge, whose pushes go
   * to that window only; approvals reach it through publishApprovals.
   */
  const openWindow = (target: WindowTarget): void => {
    // Quitting or leaving the set: a window opened now would get a session nothing ends.
    if (shutdownPromise) throw new Error(`${id} is not connected.`)
    if (windowSessions.has(target.id)) return
    const out: BridgeOutput = {
      send: (channel, ...args) => { if (channel !== IPC.APPROVALS_CHANGED) sendToWindow(target, channel, args) },
      sendAll: (channel, ...args) => { if (channel !== IPC.APPROVALS_CHANGED) sendToWindow(target, channel, args) },
    }
    const s = new DaemonModeSession(null, log, (text) => { log.warn(`[Backend] ${text}`); notice(text) }, remote)
    const b = new BackgroundEventBatcher((events) => out.send(IPC.BACKGROUND_AGENT_EVENT_BATCH, events))
    const br = new EventBridge({
      session: s,
      output: remoteBrowserSession(out, false),
      batcher: b,
      client: () => connection.current,
      trackCreatedFiles: false,
      // The window follows its agent's file (a rename, a relocate).
      onFileRenamed: (oldPath, newPath) => s.rekey(oldPath, newPath),
      log,
    })
    const w = { id: target.id, target, session: s, bridge: br, batcher: b, client: null, closed: false } as Omit<WindowSession, 'ready' | 'ctx'> as WindowSession
    w.ready = started.then(async (client) => {
      if (w.closed || shutdownPromise) throw new Error('The window closed')
      const cs = newClientSession(client, false)
      w.client = cs
      s.attach(cs)
      try {
        const summaries = await client.request<AgentSummary[]>('GET', '/agents')
        const statuses = await Promise.all(summaries.map((a) =>
          client.request<AgentStatus>('GET', `/agents/${encodeURIComponent(a.id)}/status`).catch(() => null)))
        br.seed(statuses.filter((a): a is AgentStatus => !!a))
      } catch (err) {
        log.warn(`[Backend] Agent window ${target.id}: could not list the daemon's agents: ${err instanceof Error ? err.message : String(err)}`)
      }
      if (w.closed || shutdownPromise) { void cs.end().catch(() => {}); return client }
      cs.start({
        onFrame: (frame) => br.handleFrame(frame),
        onGap: (gap) => { void br.handleGap(gap) },
        // The main window's stream reports the connection state.
        onConnection: () => {},
        onReattached: () => s.reattach(),
        onFatal: (message) => {
          log.warn(`[Backend] Agent window ${target.id}: ${message}`)
          br.failTurns('disconnected')
        },
      })
      return client
    })
    w.ready.catch(() => {})
    w.ctx = contextFor(s, br, () => w.ready.then((client) => {
      const sid = w.client?.sessionId
      return sid ? client.withClientSession(sid) : client
    }))
    windowSessions.set(target.id, w)
    log.log(`[Backend] Agent window ${target.id} opened: it gets its own client session`)
  }

  const closeWindow = async (windowId: number): Promise<void> => {
    const w = windowSessions.get(windowId)
    if (!w) return
    windowSessions.delete(windowId)
    shared.closedWindows.add(windowId)
    w.closed = true
    stashWaits.get(windowId)?.()
    // Its pending notices are the main window's now: still listed there, never lost.
    shared.windowClosed(windowId)
    w.bridge.dispose()
    w.batcher.dispose()
    // Ending the session releases its documents in the daemon (D5.1); bounded, so a quit stays in its budget.
    try {
      const end = w.client?.end() ?? Promise.resolve()
      let timer: ReturnType<typeof setTimeout> | null = null
      const timedOut = await Promise.race([
        end.then(() => false),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), AGENT_SESSION_END_TIMEOUT_MS); timer.unref?.() }),
      ])
      if (timer) clearTimeout(timer)
      if (timedOut) log.warn(`[Backend] Agent window ${windowId}: its client session did not end within ${AGENT_SESSION_END_TIMEOUT_MS} ms; the daemon expires it`)
      else log.log(`[Backend] Agent window ${windowId} closed: its client session ended`)
    } catch (err) {
      log.warn(`[Backend] Agent window ${windowId}: ending its client session failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** A non-primary runtime's main session ends within this budget (§3.3); its daemon expires a session that did not. */
  const endBounded = async (end: Promise<void>): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const timedOut = await Promise.race([
      end.then(() => false),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), AGENT_SESSION_END_TIMEOUT_MS); timer.unref?.() }),
    ])
    if (timer) clearTimeout(timer)
    if (timedOut) log.warn(`[Backend] Quit: the client session did not end within ${AGENT_SESSION_END_TIMEOUT_MS} ms; the daemon expires it`)
  }

  /** Resolves true once the daemon's process exited (its pid, not its /health, which closes first), false at the deadline. */
  const waitDaemonGone = async (budgetMs: number): Promise<boolean> => {
    const pid = versionInfo?.pid ?? connection.endpointInfo?.daemon?.pid
    if (!pid) return true
    return (deps.waitForExit ?? waitForDaemonExit)(pid, budgetMs)
  }

  let shutdownPromise: Promise<void> | null = null
  const shutdown = (shutdownOpts: QuitOptions = {}): Promise<void> => {
    shutdownPromise ??= (async () => {
      stopExitWatch()
      if (turnGrace) { clearTimeout(turnGrace); turnGrace = null }
      connection.dispose()
      deps.powerMonitor?.removeListener('resume', onSystemResume)
      statusUi?.dispose()
      remoteServices?.picker.cancelAll()
      remoteServices?.oauth.closeAll()
      bridge.dispose()
      batcher.dispose()
      // M10: Studio never stops a remote daemon; keepDaemonRunning is This computer's only.
      const stopDaemon = kind === 'local' && !keepRunning() && shutdownOpts.keepDaemonRunning !== true
      if (kind === 'local' && shutdownOpts.keepDaemonRunning === true && !keepRunning()) log.log('[Backend] Quit: the ADF daemon keeps running for the computers connected to it (this quit only)')
      let answer: ClientQuitAnswer | null = null
      try {
        // Agent windows' sessions end first: the quit below counts other open sessions (§8.3).
        await Promise.all([...windowSessions.keys()].map((wid) => closeWindow(wid)))
        await session.releaseAll()
        if (kind === 'local' && clientSession?.quit) answer = await clientSession.quit(stopDaemon)
        else if (primary) await clientSession?.end()
        else if (clientSession) await endBounded(clientSession.end())
        // No session was ever opened on a daemon this Studio started: the orphan rule cannot stop it, so ask directly.
        if (!answer && stopDaemon && currentHow() === 'spawned' && connection.current) {
          answer = await connection.current.withTimeout(5_000).request<ClientQuitAnswer>('POST', '/client/sessions/none/quit', { body: { stopDaemon: true } })
        }
      } catch (err) {
        log.warn('[Backend] Ending the client session failed:', err)
      }
      if (primary) await clientSettings.flush()
      if (answer) {
        // §8.3: the daemon decided; its log has the same line.
        log.log(`[Backend] Quit: client session ended; ${answer.stopping ? 'the ADF daemon is stopping' : 'the ADF daemon keeps running'}: ${answer.reason}`)
      } else if (connection.current) {
        log.log(`[Backend] Quit: client session ended; the ADF daemon keeps running${remote ? ' (remote mode never stops it)' : ''}`)
      }
      // A restart into Inside Studio: embedded Studio moves the sign-ins back and starts its agents only once this
      // daemon is gone (handover.ts toEmbedded), so the quit waits for its process, bounded.
      if (kind === 'local' && answer?.stopping && shutdownOpts.waitForDaemonExitMs) {
        log.log(`[Backend] Waiting up to ${Math.round(shutdownOpts.waitForDaemonExitMs / 1000)}s for the ADF daemon to stop its agents and exit`)
        shutdownOpts.onExitWait?.(shutdownOpts.waitForDaemonExitMs)
        const gone = await waitDaemonGone(shutdownOpts.waitForDaemonExitMs)
        log.log(gone ? '[Backend] The ADF daemon exited' : '[Backend] The ADF daemon is still stopping; Studio Inside Studio leaves the sign-ins with it until the next restart')
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
      trust: info?.trust ?? null,
      keychainProblem: info?.keychainProblem ?? null,
      logFile: connection.logFile,
    }
  }

  const setKeepDaemonRunning = async (keep: boolean): Promise<void> => {
    const sid = clientSession?.sessionId
    const client = connection.current
    if (kind !== 'local' || !sid || !client) return
    try {
      await client.request('PUT', `/client/sessions/${encodeURIComponent(sid)}/exit-when-closed`, { body: { exitDaemonWhenClosed: !keep } })
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

  /** An agent that ran when the daemon exited: the open file's through AGENT_START (as its Start button), any other in the background. */
  const startAgentAgain = async (filePath: string): Promise<{ success: boolean; error?: string }> => {
    if (!samePath(filePath, session.filePath, remote)) return startBackgroundAgent(filePath)
    const handler = DAEMON_MODE_HANDLERS[IPC.AGENT_START]
    if (!handler) return { success: false, error: 'Agent start is not available in daemon mode' }
    try {
      return await handler(ctx, {} as Electron.IpcMainInvokeEvent, { filePath }) as { success: boolean; error?: string }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  return {
    id,
    kind,
    primary,
    name: opts.name,
    connection,
    session,
    bridge,
    ctx,
    fetch: deps.fetch,
    ready: started.then(() => true, () => false),
    started,
    reconnect,
    problem,
    canReconnect,
    status,
    client: () => started.then(sessionClient),
    setKeepDaemonRunning,
    menuBarAgents: () => runningAgents()
      .filter((a) => !session.isFocused(a.agentId, a.filePath))
      .map((a) => ({ filePath: a.filePath, state: a.mapping.state, activeLoops: a.mapping.activeLoops, ...(primary ? {} : { runtimeId: id }) })),
    foreground: () => {
      const agentId = session.agentId
      const agent = agentId ? runningAgents().find((a) => a.agentId === agentId) : undefined
      return agent ? { filePath: agent.filePath, state: agent.mapping.state, ...(primary ? {} : { runtimeId: id }) } : null
    },
    tokensToday: () => tokensToday,
    windows: {
      open: openWindow,
      close: closeWindow,
      has: (wid) => windowSessions.has(wid),
      ids: () => [...windowSessions.keys()],
      ctx: (wid) => windowSessions.get(wid)?.ctx ?? null,
      session: (wid) => windowSessions.get(wid)?.session ?? null,
      current: (wid) => {
        const file = windowSessions.get(wid)?.session.current
        return file ? { filePath: file.filePath, agentId: file.agentId } : null
      },
      focused: (wid) => windowSessions.get(wid)?.target.focused() ?? false,
      views: () => [...windowSessions.values()].map((w) => ({ id: w.id, main: false, focused: w.target.focused(), filePath: w.session.filePath, ...(primary ? {} : { runtimeId: id }) })),
      send: (wid, channel, ...args) => {
        const w = windowSessions.get(wid)
        if (w) w.target.send(channel, ...args)
      },
      stashed: (wid) => { stashWaits.get(wid)?.() },
    },
    shutdown,
  }
}

