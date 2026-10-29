/** Browser tabs reuse Studio's handlers, document ownership and event translation. */
import type { IpcMainInvokeEvent } from 'electron'
import { IPC } from '../../../shared/constants/ipc-channels'
import { CLIENT_SETTINGS_KEYS } from '../../../shared/constants/client-settings-keys'
import { splitRuntimeTag } from '../../../shared/runtime-tag'
import type { DaemonClient } from '../../../shared/daemon-client'
import { DaemonConnection } from '../../backend/daemon-mode/connection'
import { followConnectionTurns } from '../../backend/daemon-mode/connection-turns'
import { DaemonModeSession } from '../../backend/daemon-mode/session'
import { createDaemonClientSession } from '../../backend/daemon-mode/client-stream'
import { EventBridge } from '../../backend/daemon-mode/event-bridge'
import { findRunningAgent, type DaemonModeContext } from '../../backend/daemon-mode/context'
import { DAEMON_MODE_HANDLERS, DAEMON_MODE_SEND_HANDLERS } from '../../backend/daemon-mode/handlers'
import { REMOTE_MODE_HANDLERS } from '../../backend/daemon-mode/remote/handlers'
import { RemotePicker } from '../../backend/daemon-mode/remote/picker'
import { InstallProgressRelay } from '../../backend/daemon-mode/mcp/install-progress'
import { clientSettingsDefaults, type ClientSettingsStore } from '../../backend/daemon-mode/settings'
import { BackgroundEventBatcher } from '../../ipc/background-event-batch'

export interface WebTab {
  invoke(channel: string, args: unknown[]): Promise<unknown>
  readFile(path: string, filePath?: string): Promise<Response>
  snapshot(path?: string): Promise<Response>
  resync(): Promise<void>
  close(): Promise<void>
}

export interface WebTabOptions {
  baseUrl: string
  token: string
  version: string
  send(channel: string, ...args: unknown[]): void
  /** Client appearance is isolated from the desktop and survives tab reloads. */
  settings: Record<string, unknown>
  appearanceChanged?: (changed: Record<string, unknown>) => void
}

export async function createWebTab(options: WebTabOptions): Promise<WebTab> {
  let closed = false
  let closePromise: Promise<void> | null = null
  const send = (channel: string, ...args: unknown[]) => { if (!closed) options.send(channel, ...args) }
  const connection = new DaemonConnection(async () => ({
    baseUrl: options.baseUrl,
    source: { token: () => options.token },
    logFile: null,
    description: 'Browser Studio',
  }))
  const client: DaemonClient = await connection.client()
  const cs = createDaemonClientSession(client, { version: options.version, exitDaemonWhenClosed: false })
  const sessionClient = async () => {
    const id = await cs.ready!()
    if (closed || !id) throw new Error('Studio is not connected to the ADF daemon. Reload Studio after it reconnects.')
    return client.withClientSession(id)
  }
  const session = new DaemonModeSession(cs, console, (message) => console.warn('[Web Studio]', message), true)
  const batcher = new BackgroundEventBatcher((events) => send(IPC.BACKGROUND_AGENT_EVENT_BATCH, events))
  const bridge = new EventBridge({ session, output: { send, sendAll: send }, batcher, client: () => client, trackCreatedFiles: false })
  const installs = new InstallProgressRelay(send)
  const picker = new RemotePicker({ send: (request) => { send(IPC.REMOTE_PICKER_REQUEST, request); return true }, host: () => 'ADF daemon', log: console })
  const allowedSettings = new Set<string>(CLIENT_SETTINGS_KEYS)
  const defaults = clientSettingsDefaults() as Record<string, unknown>
  const settings = options.settings
  const clientSettings = {
    get: (key: string) => key in settings ? settings[key] : defaults[key],
    set: (key: string, value: unknown) => { if (allowedSettings.has(key)) settings[key] = value },
    getAll: () => ({ ...defaults, ...settings }),
    patch: (values: Record<string, unknown>) => { for (const [key, value] of Object.entries(values)) if (allowedSettings.has(key)) settings[key] = value },
  } as unknown as ClientSettingsStore
  const unsupported = (): never => {
    const error = new Error('This operation requires the desktop Studio client.')
    Object.assign(error, { code: 'web_desktop_only' })
    throw error
  }
  const ctx: DaemonModeContext = {
    mode: 'remote', connection, session, bridge, installs, clientSettings,
    approvals: { takePendingReveal: () => null, setMenuBarEnabled: () => {} } as unknown as DaemonModeContext['approvals'],
    ready: sessionClient,
    runningAgentAt: (path) => findRunningAgent(client, path),
    raw: async (path, query) => fetch(client.url(path, query), { headers: (await sessionClient()).headers(), redirect: 'manual' }),
    sharedMnemonic: () => null,
    recordRecentFile: (path) => {
      const recent = clientSettings.get('recentFiles')
      clientSettings.set('recentFiles', [path, ...(Array.isArray(recent) ? recent.filter(p => p !== path) : [])].slice(0, 30))
    },
    hooks: { appearanceChanged: options.appearanceChanged },
    runtime: { id: 'local', primary: true },
    remote: {
      picker, host: () => 'ADF daemon', name: () => 'ADF daemon',
      oauth: { open: unsupported, closeAll: () => {} } as unknown as NonNullable<DaemonModeContext['remote']>['oauth'],
      upload: unsupported,
    },
    log: console,
  }
  const connectionView = () => {
    const status = connection.state.state
    const state = status === 'disconnected' ? 'retrying' : status === 'failed' ? 'not-connected' : status
    return {
      current: { id: 'local', kind: 'local', name: 'ADF daemon', url: null, state },
      next: null, discovery: null,
      rows: [{ id: 'local', kind: 'local', name: 'ADF daemon', state, action: null, url: null, address: null, fingerprint: null, encrypted: false, pairingOpen: false, removable: false, version: options.version }],
    }
  }
  const stopFollowingTurns = followConnectionTurns(connection, () => bridge.failTurns('disconnected'), () => { void bridge.recheckTurns() })
  const stopConnectionUpdates = connection.onState(() => send(IPC.CONNECTION_CHANGED, connectionView()))
  cs.start({
    onFrame: (frame) => { if (installs.observe(frame)) bridge.handleFrame(frame) },
    onGap: (gap) => { installs.onGap(); void bridge.handleGap(gap) },
    onConnection: (state) => {
      if (state.state === 'open') connection.markConnected()
      else if (state.state === 'reconnecting') connection.markDisconnected(state.error)
    },
    onReattached: () => session.reattach(),
    onFatal: (message) => { connection.markFailed(message) },
  })
  const webHandlers: Record<string, (...args: unknown[]) => unknown> = {
    // Browser attachments upload bytes. Never interpret browser-supplied paths
    // as files on the daemon host or run desktop snapshot/native-dialog code.
    ...Object.fromEntries([
      IPC.DOC_IMPORT_PATHS, IPC.DOC_PICK_AND_IMPORT, IPC.FILE_SHARE_PREPARE,
      IPC.FILE_SHARE_DISCARD, IPC.FILE_SHARE_SAVE_AS, IPC.FILE_SHARE_DRAG_START,
      IPC.TEMPLATE_ADD_FILES, IPC.CHATGPT_AUTH_START,
    ].map(channel => [channel, unsupported])),
    [IPC.GROK_AUTH_START]: async () => {
      try {
        // Device-code authorization already has a manual URL/code flow in the
        // shared provider dialog, so it needs no host-side browser launch.
        const flow = await client.request<Record<string, unknown>>('POST', '/auth/grok/start', { timeoutMs: 60_000 })
        return { ...flow, success: true }
      } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
    },
    [IPC.COMPUTE_BROWSER_INFO]: async (...args) => {
      const query = (args[0] ?? {}) as { agentName?: string; agentId?: string }
      const info = await client.request<Record<string, unknown>>('GET', '/compute/browser-info', {
        query: { agentName: query.agentName, agentId: query.agentId }, timeoutMs: 120_000,
      })
      // Electron's relay binds a port on its local machine. In a daemon-hosted
      // browser it would allocate a server-side port the browser cannot reach.
      return { ...info, hostPort: null, detail: 'Use desktop Studio to view the live computer. Agent execution and compute controls remain available here.' }
    },
    [IPC.APP_GET_VERSION]: () => options.version,
    [IPC.APP_SET_BADGE_COUNT]: () => undefined,
    [IPC.CONNECTION_LIST]: connectionView,
    [IPC.NETWORK_NOTICES_GET]: () => [],
    [IPC.NETWORK_NOTICE_DISMISS]: () => undefined,
    [IPC.BACKEND_SETTINGS_GET]: () => ({
      active: { mode: 'local', source: 'session', notices: [], sessionReason: 'Connected from a browser.' },
      configured: { mode: 'local', keepDaemonRunning: true, remoteUrl: null, remoteTokenSaved: false, allowInsecureHttp: false },
      remoteUrlProblem: null, encryptionAvailable: false, encryptionUnavailableReason: 'Browser sessions use an HttpOnly cookie.',
      daemon: { connection: connection.state.state, progress: null, message: connection.state.state === 'failed' ? connection.state.message : connection.state.state === 'disconnected' ? connection.state.error ?? null : null, url: null, pid: null, version: options.version, startedBy: null, how: 'attached', localProof: null, trust: null, keychainProblem: null, logFile: null },
    }),
    // Never expose native browser/desktop services on the daemon host.
    [IPC.BACKEND_SETTINGS_SET]: unsupported,
    [IPC.BACKEND_RESTART_STUDIO]: unsupported,
  }
  return {
    async invoke(channel, rawArgs) {
      if (closed) throw new Error('This browser tab has disconnected. Reload Studio.')
      const { runtimeId, args } = splitRuntimeTag(rawArgs)
      if (runtimeId && runtimeId !== 'local') throw new Error('Open the other daemon’s Studio URL to use that runtime.')
      if (!Object.values(IPC).includes(channel as never)) throw new Error('Unknown Studio operation.')
      if (Object.hasOwn(webHandlers, channel)) return webHandlers[channel](...args)
      const handler = Object.hasOwn(REMOTE_MODE_HANDLERS, channel)
        ? REMOTE_MODE_HANDLERS[channel as keyof typeof REMOTE_MODE_HANDLERS]
        : Object.hasOwn(DAEMON_MODE_HANDLERS, channel) ? DAEMON_MODE_HANDLERS[channel as keyof typeof DAEMON_MODE_HANDLERS] : undefined
      const sendHandler = Object.hasOwn(DAEMON_MODE_SEND_HANDLERS, channel) ? DAEMON_MODE_SEND_HANDLERS[channel as keyof typeof DAEMON_MODE_SEND_HANDLERS] : undefined
      const event = { sender: { send, isDestroyed: () => closed } } as unknown as IpcMainInvokeEvent
      if (handler) return handler(ctx, event, ...args)
      if (sendHandler) return sendHandler(ctx, event as never, ...args)
      throw new Error(`This operation is not available in browser Studio (${channel}).`)
    },
    async readFile(path, filePath) {
      if (closed) throw new Error('This browser tab has disconnected. Reload Studio.')
      if (filePath !== undefined && filePath !== session.filePath) {
        throw new Error('This media belongs to an agent that is no longer open in this tab.')
      }
      if (!session.agentId) throw new Error('No agent is open in this tab.')
      return ctx.raw(`/agents/${encodeURIComponent(session.agentId)}/files/raw`, { path })
    },
    async snapshot(path) {
      if (closed) throw new Error('This browser tab has disconnected. Reload Studio.')
      const target = path ?? session.filePath
      if (!target) throw new Error('No agent is open in this tab.')
      return ctx.raw('/files/snapshot', { path: target, mode: 'share' })
    },
    resync: () => closed ? Promise.resolve() : bridge.resync(),
    close() {
      if (closePromise) return closePromise
      closed = true
      stopFollowingTurns()
      stopConnectionUpdates()
      picker.cancelAll()
      bridge.dispose()
      batcher.dispose()
      closePromise = cs.end().catch(() => {}).finally(() => connection.dispose())
      return closePromise
    },
  }
}
