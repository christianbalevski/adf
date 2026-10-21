import { BrowserWindow, dialog, Notification } from 'electron'
// Studio-scope channels refuse a runtime tag (docs/design/multi-runtime.md §4.2).
import { ipcMain } from './studio-ipc'
import { IPC } from '../../shared/constants/ipc-channels'
import { remoteUrlOrigin } from '../../shared/utils/remote-backend-url'
import type { DaemonClient } from '../../shared/daemon-client'
import type { StudioBackendMode } from '../../shared/types/backend.types'
import type { PairingClaimView } from '../../shared/types/remote-access.types'
import type { BackendSettingsStore, SecretCodec } from './backend-config'
import { DaemonPeerFeed, InProcessPeerFeed, RemoteDiscovery, type DiscoveryDeps } from './remote-access/discovery'
import type { MdnsService } from '../services/mdns-service'
import type { NetworkPeer } from '../../shared/types/remote-access.types'
import { RemoteAccessHost, type ClaimPrompt, type RemoteAccessHostDeps } from './remote-access/host'
import { PairingFlow, type PairingFlowDeps } from './remote-access/pairing'
import { quitQuestion, RemoteQuitGate, type QuitAnswer } from './remote-access/quit-gate'
import { LanReach } from '../services/lan-reach'
import { probeFirewall, type FirewallView } from '../daemon/remote-access/firewall'
import { allowNetwork, forgetNetwork, readAllowedNetworks, UNSAFE_DISPLAY_CHARS } from '../daemon/remote-access/config'
import type { NetworkConsentResult, NetworkNotice, NetworkStatusView, RemoteAccessErrorCode, RemotePairStartRequest } from '../../shared/types/remote-access-ipc.types'
import type { AllowedNetwork } from '../../shared/types/remote-access.types'
import { NetworkConsentPrompt } from './remote-access/network-consent'
import { machineName } from './local-runtime-name'
import { remotesEnv, SavedConnectionsCache, saveConnection } from './connections'
import { KEYCHAIN_FILE_COPY, readRemotesAsync, RemotesUnreadableError, remotesFilePath } from '../cli/remotes'

/**
 * Remote access in Studio main
 * (docs/design/remote-access.md §7, §9.1): the IPC channels of Settings →
 * Networking → Remote access (host) and Settings → Connections (discovery,
 * pairing), and the quit question. Registered in every backend mode, outside
 * the backend registration; the host channels answer "unavailable" unless
 * Studio runs the ADF daemon on this computer.
 */

/** What Studio main needs from the local daemon (DaemonModeHandle). */
export interface LocalDaemon {
  client(): Promise<DaemonClient>
  status(): { startedBy: 'studio' | 'cli' | 'service' | null }
}

export interface RemoteAccessIpcDeps {
  /** The backend this launch runs. */
  mode: StudioBackendMode
  /** Local mode: the daemon handle; null before it exists or in other modes. */
  daemon: () => LocalDaemon | null
  backend: BackendSettingsStore
  codec: SecretCodec
  window: () => BrowserWindow | null
  keepDaemonRunning: () => boolean
  /** Studio's user data: adf-settings.json (the runtime alias) and remote-access.json (the allowed networks). */
  settingsDir?: string
  /** Embedded mode: the mesh listens on the LAN (it needs consent too), and re-syncs it after an allow or a remove. */
  meshLan?: () => { on: boolean; sync: () => Promise<void> } | null
  /** Embedded mode: the mesh's mDNS service while it runs (the process's one discovery feed). */
  meshPeers?: () => MdnsService | null
  /** Where cli-remotes.json and the keychain fallback are (connections.ts remotesEnv). Default: next to `settingsDir`. */
  remotesEnv?: NodeJS.ProcessEnv
  /** The discovery list or the saved connections changed: Settings → Connections is pushed again. */
  onConnectionsChanged?: () => void
  /** The saved connections, cached (connections.ts); default: a cache of `remotesEnv`. */
  savedCache?: SavedConnectionsCache
  /** The local runtime's name, `<name> (Local)`, while there is more than one runtime; else null (Share's dialog, review A6). */
  localRuntime?: () => string | null
  /** Tests: replace the Electron dialogs, notifications and network. */
  overrides?: {
    host?: Partial<RemoteAccessHostDeps>
    discovery?: Partial<DiscoveryDeps>
    pairing?: Partial<PairingFlowDeps>
    askQuit?: (count: number | null) => Promise<QuitAnswer>
    reach?: LanReach
    firewall?: () => Promise<FirewallView>
    platform?: NodeJS.Platform
    /** How often the consent check runs (default 10 s); 0 = never by timer (tests call it). */
    consentPollMs?: number
  }
  log?: Pick<Console, 'log' | 'warn'>
}

export interface RemoteAccessIpc {
  host: RemoteAccessHost
  discovery: RemoteDiscovery
  pairing: PairingFlow
  quitGate: RemoteQuitGate
  /** The in-window notice for a network that is not allowed (once per network per session); runs every 10 s. */
  consent: NetworkConsentPrompt
  /** The daemon's `remote_access` push (daemon-mode event bridge). */
  onDaemonEvent(payload: unknown): void
  dispose(): void
}

/**
 * This computer's name for other computers: the runtime alias (Settings →
 * Identity), else the host name (local-runtime-name.ts). One name everywhere
 * (mDNS, pairing, device lists); the daemon reads the same setting.
 */
export function runtimeName(settingsDir: string | undefined): string {
  return machineName(settingsDir)
}

/** The status line's view of a snapshot (pure). */
export function networkStatusView(snapshot: Awaited<ReturnType<LanReach['snapshot']>>, firewall: FirewallView, allowedNetworks: AllowedNetwork[], waiting: NetworkStatusView['waiting'] = { remoteAccess: false, mesh: false }): NetworkStatusView {
  const lan = snapshot.addresses.filter((a) => a.kind === 'lan').map((a) => ({ address: a.address, iface: a.iface, allowed: a.refusal === null }))
  const tailnet = snapshot.addresses.find((a) => a.kind === 'tailnet' && a.family === 'IPv4')
  return {
    available: true,
    lan,
    networks: snapshot.networks,
    allowedNetworks,
    tailscale: snapshot.tailscale,
    tailnetAddress: tailnet?.address ?? null,
    firewall: { state: firewall.state, message: firewall.message },
    waiting,
  }
}

export function unavailableReason(mode: StudioBackendMode): string {
  return mode === 'remote'
    ? 'Remote access is changed on the remote computer.'
    : 'Remote access needs Local as the connection (Settings → Connections).'
}

const VIA: Record<PairingClaimView['via'], string> = { lan: 'this network', tailnet: 'your tailnet', proxy: 'through a proxy' }
const CLIENT: Record<PairingClaimView['clientKind'], string> = { studio: 'ADF Studio', cli: 'the ADF CLI' }

/** C0/C1 controls (newlines too), bidi overrides and isolates: shown escaped, so a name cannot add lines or reorder text. */
const UNSAFE_TEXT = new RegExp(UNSAFE_DISPLAY_CHARS.source, 'gu')

/** Text the other device chose, safe for a dialog line: escaped, at most `max` characters. */
export function shownText(text: string, max = 64): string {
  const escaped = text.replace(UNSAFE_TEXT, (c) => {
    const code = c.codePointAt(0) ?? 0
    return code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, '0')}`
  })
  return [...escaped].length > max ? `${[...escaped].slice(0, max).join('')}…` : escaped
}

/**
 * "Allow device" (§5.4; security review 3): the title never names the
 * device. The first line of the body is fixed and comes from the daemon's
 * view of the connection: the source address and how it arrived, and the
 * Tailscale login when known. The name the device chose is quoted on its
 * own line, escaped.
 */
export function claimQuestion(claim: PairingClaimView, opts: { serve?: boolean } = {}): { title: string; message: string; detail: string } {
  // Behind tailscale serve: the login is verified only when the daemon runs in proxy mode (it then names one).
  const via = opts.serve && claim.via === 'proxy'
    ? `through tailscale serve${claim.tailnetLogin ? '' : ' (user unverified)'}`
    : VIA[claim.via] ?? shownText(String(claim.via), 16)
  const login = claim.tailnetLogin ? ` · Tailscale ${shownText(claim.tailnetLogin, 128)}` : ''
  return {
    title: 'Allow device',
    message: 'Allow device',
    detail: [
      `From ${shownText(claim.address, 64)} (${via})${login}`,
      `Device name: "${shownText(claim.deviceName)}"`,
      `Client: ${CLIENT[claim.clientKind] ?? shownText(String(claim.clientKind), 16)}`,
      '',
      'It gets full control, as powerful as your seed phrase. Allow it only if it is your device and you just paired it.',
    ].join('\n'),
  }
}

/** A change of remote access or of the consent per network asked from any window but the main one (review A1). */
export const MAIN_WINDOW_ONLY = 'Change remote access in Settings in the main window.'

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    timer.unref?.()
    promise.then((v) => { clearTimeout(timer); resolve(v) }, (e) => { clearTimeout(timer); reject(e) })
  })
}

export function registerRemoteAccessHandlers(deps: RemoteAccessIpcDeps): RemoteAccessIpc {
  const log = deps.log ?? console
  const o = deps.overrides ?? {}
  /** Every window gets the push (Settings may be open in any). */
  const windows = { send: (channel: string, payload: unknown): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue
      try { win.webContents.send(channel, payload) } catch { /* window going away */ }
    }
  } }
  const notify = (text: string): void => {
    try {
      if (Notification.isSupported()) new Notification({ title: 'ADF Studio', body: text }).show()
    } catch (err) {
      log.warn('[Remote access] Could not show a notification:', err)
    }
  }
  const box = async (options: Electron.MessageBoxOptions): Promise<number> => {
    const win = deps.window()
    const { response } = win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
    return response
  }
  const localDaemon = (): LocalDaemon | null => deps.mode === 'local' ? deps.daemon() : null
  const env = deps.remotesEnv ?? (deps.settingsDir ? remotesEnv(deps.settingsDir) : process.env)
  const savedCache = deps.savedCache ?? new SavedConnectionsCache(env)
  const saved = () => savedCache.get()
  const refreshSaved = () => savedCache.refresh().catch(() => savedCache.get())

  const host = new RemoteAccessHost({
    daemon: () => {
      if (deps.mode !== 'local') return { unavailable: unavailableReason(deps.mode) }
      const daemon = deps.daemon()
      if (!daemon) return { unavailable: 'Studio is not connected to the local server yet.' }
      return { client: () => withTimeout(daemon.client(), 8_000, 'Studio is not connected to the local server yet.') }
    },
    stopsWithStudio: () => !deps.keepDaemonRunning() && localDaemon()?.status().startedBy === 'studio',
    push: (change) => windows.send(IPC.REMOTE_ACCESS_CHANGED, change),
    notify,
    confirm: async ({ message, detail, ok }) => (await box({ type: 'question', title: message, message, detail, buttons: [ok, 'Cancel'], defaultId: 1, cancelId: 1, noLink: true })) === 0,
    askClaim: async ({ claim, signal, serve }: ClaimPrompt) => {
      const win = deps.window()
      const question = claimQuestion(claim, { serve })
      if (win && !win.isDestroyed() && !win.isFocused()) {
        try {
          if (Notification.isSupported()) {
            const n = new Notification({ title: 'Allow device', body: 'A device entered the pairing code. Open Studio to allow or deny it.' })
            n.on('click', () => { if (!win.isDestroyed()) { win.show(); win.focus() } })
            n.show()
          }
        } catch { /* the dialog below still asks */ }
      }
      const response = await box({ type: 'question', ...question, buttons: ['Allow', 'Deny'], defaultId: 1, cancelId: 1, noLink: true, signal })
      return signal.aborted ? null : response === 0
    },
    localRuntime: deps.localRuntime,
    log,
    ...o.host,
  })

  // One discovery feed per computer (remote-access.md §5.1): the daemon's in local mode, else this process's.
  const daemonFeed = new DaemonPeerFeed(async (path) => {
    const daemon = localDaemon()
    if (!daemon) throw new Error('Studio is not connected to the local server yet.')
    const client = await withTimeout(daemon.client(), 8_000, 'Studio is not connected to the local server yet.')
    return client.request<{ peers: NetworkPeer[] }>('GET', path, { timeoutMs: 10_000 })
  })
  const inProcessFeed = new InProcessPeerFeed({ mesh: () => deps.meshPeers?.() ?? null, log })
  const discovery = new RemoteDiscovery({
    feed: () => (deps.mode === 'local' ? (localDaemon() ? daemonFeed : null) : inProcessFeed),
    onUpdate: (update) => {
      windows.send(IPC.REMOTE_DISCOVERY_UPDATE, update)
      deps.onConnectionsChanged?.()
    },
    pairedFingerprints: () => {
      const fingerprints = savedCache.fingerprints()
      const slot = deps.backend.config().remote.paired?.fingerprint
      if (slot) fingerprints.add(slot)
      return fingerprints
    },
    ownFingerprint: () => host.lastStatus?.fingerprint ?? null,
    log,
    ...o.discovery,
  })

  const pairing = new PairingFlow({
    onState: (state) => windows.send(IPC.REMOTE_PAIR_STATE, state),
    // Saved where `adf pair` saves (connections.ts): the keychain, else a file only this user can read. Never blocked.
    saveBlocked: () => null,
    savedListProblem: async () => {
      const read = await readRemotesAsync(env)
      return read.unreadable ? new RemotesUnreadableError(remotesFilePath(env), read.unreadable).message : null
    },
    defaultDeviceName: () => runtimeName(deps.settingsDir),
    savedConnections: () => {
      const list = Object.entries(saved()).map(([name, r]) => ({ name, url: r.url, fingerprint: r.fingerprint as string | null }))
      const slot = deps.backend.config().remote
      if (slot.url) list.push({ name: slot.paired?.name ?? slot.url, url: slot.url, fingerprint: slot.paired?.fingerprint ?? null })
      return list
    },
    confirmReplace: async ({ name, to }) => (await box({
      type: 'question',
      title: 'Use new address',
      message: 'Use new address',
      detail: `${shownText(name)} is now at ${to}.`,
      buttons: ['Use new address', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    })) === 0,
    confirmSwitch: async ({ hostName, from, to }) => (await box({
      type: 'question',
      title: 'Encrypted address',
      message: 'Encrypted address',
      detail: `${shownText(hostName)} also answers at ${to}, through Tailscale (encrypted). Save that address instead of ${from}.`,
      buttons: ['Use encrypted address', 'Keep current address'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })) === 0,
    save: async (input) => {
      let name: string
      try {
        const saved = await saveConnection(env, { url: input.url, token: input.token, fingerprint: input.fingerprint, hostName: input.name, deviceId: input.deviceId, label: input.label }, {
          // Never a silent fallback: the user chooses the file.
          confirmFile: async (why) => (await box({ type: 'question', title: KEYCHAIN_FILE_COPY.title, message: KEYCHAIN_FILE_COPY.message, detail: why, buttons: [KEYCHAIN_FILE_COPY.ok, KEYCHAIN_FILE_COPY.cancel], defaultId: 1, cancelId: 1, noLink: true })) === 0,
        })
        name = saved.name
        if (saved.store.where === 'file') log.warn(`[Remote access] The token for ${name} is in ${saved.store.path} (${saved.store.why})`)
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
      const origin = remoteUrlOrigin(input.url)
      if (input.allowInsecureHttp && origin) {
        const trusted = await deps.backend.set({ trustInsecureOrigin: origin })
        if (!trusted.ok) log.warn(`[Remote access] Could not record plain http for ${origin}: ${trusted.error}`)
      }
      await refreshSaved()
      discovery.refresh()
      deps.onConnectionsChanged?.()
      return { ok: true, id: `remote:${name}` }
    },
    log,
    ...o.pairing,
  })

  const quitGate = new RemoteQuitGate({
    daemonWouldStop: () => deps.mode === 'local' && !deps.keepDaemonRunning() && localDaemon()?.status().startedBy === 'studio',
    connectedCount: () => withTimeout(host.connectedCount(1_500), 2_000, 'no answer'),
    ask: o.askQuit ?? (async (count) => {
      const q = quitQuestion(count)
      const response = await box({ type: 'question', title: q.title, message: q.message, detail: q.detail, buttons: q.buttons, defaultId: 0, cancelId: 2, noLink: true })
      return response === 0 ? 'keep' : response === 1 ? 'stop' : 'cancel'
    }),
    log,
  })

  /**
   * These are Studio calls, so every window can send them, an agent window
   * of a remote runtime too (multi-runtime.md §4.2). Settings live in the
   * main window: a change of remote access or of the consent per network
   * from any other sender is refused and logged (review A1).
   */
  const mainOnly = <A extends unknown[], R>(channel: string, refusal: NoInfer<R>, fn: (...args: A) => Promise<R>) =>
    async (event: { sender?: unknown } | undefined, ...args: A): Promise<R> => {
      const win = deps.window()
      if (win && !win.isDestroyed() && event?.sender === win.webContents) return fn(...args)
      log.warn(`[Remote access] ${channel} refused: it was not sent by the main window`)
      return refusal
    }
  const refused: { ok: false; code: RemoteAccessErrorCode; error: string } = { ok: false, code: 'unavailable', error: MAIN_WINDOW_ONLY }

  // --- Host: Settings → Connections (Add → Share, Devices) ---
  ipcMain.handle(IPC.REMOTE_ACCESS_GET, (_event, opts?: { refresh?: unknown }) => host.get({ refresh: opts?.refresh === true }))
  ipcMain.handle(IPC.REMOTE_ACCESS_SET, mainOnly(IPC.REMOTE_ACCESS_SET, refused, (request: { enabled?: unknown; name?: unknown }) => host.set(request ?? {})))
  // S1: a reload or close of the window that runs Share leaves it, in main.
  const watched = new WeakSet<object>()
  const leaveWithWindow = (event: { sender?: unknown } | undefined): void => {
    const sender = event?.sender as { on?: (name: string, fn: (...a: unknown[]) => void) => unknown; once?: (name: string, fn: () => void) => unknown } | undefined
    if (!sender || typeof sender.on !== 'function' || watched.has(sender)) return
    watched.add(sender)
    const leave = (why: string) => { log.log(`[Remote access] The main window ${why}: leaving Share`); void host.shareLeave() }
    sender.on('did-start-navigation', (details: unknown, _url: unknown, isInPlace: unknown, isMainFrame: unknown) => {
      const d = details as { isMainFrame?: boolean; isSameDocument?: boolean } | undefined
      if ((d?.isMainFrame ?? isMainFrame) && !(d?.isSameDocument ?? isInPlace)) leave('reloads')
    })
    sender.on('render-process-gone', () => leave('crashed'))
    sender.once?.('destroyed', () => leave('closed'))
  }
  const watching = <A extends unknown[], R>(handler: (event: { sender?: unknown } | undefined, ...args: A) => Promise<R>) =>
    async (event: { sender?: unknown } | undefined, ...args: A): Promise<R> => {
      const win = deps.window()
      if (win && !win.isDestroyed() && event?.sender === win.webContents) leaveWithWindow(event)
      return handler(event, ...args)
    }
  ipcMain.handle(IPC.REMOTE_ACCESS_SHARE, watching(mainOnly(IPC.REMOTE_ACCESS_SHARE, refused, () => host.share())))
  ipcMain.handle(IPC.REMOTE_ACCESS_SHARE_LEAVE, mainOnly(IPC.REMOTE_ACCESS_SHARE_LEAVE, { left: null }, () => host.shareLeave()))
  ipcMain.handle(IPC.REMOTE_ACCESS_DEVICE_ADD, mainOnly(IPC.REMOTE_ACCESS_DEVICE_ADD, refused, (label: unknown) => host.addDevice(label)))
  ipcMain.handle(IPC.REMOTE_ACCESS_DEVICE_REMOVE, mainOnly(IPC.REMOTE_ACCESS_DEVICE_REMOVE, refused, (id: unknown) => host.removeDevice(id)))
  ipcMain.handle(IPC.REMOTE_ACCESS_PAIRING_OPEN, watching(mainOnly(IPC.REMOTE_ACCESS_PAIRING_OPEN, refused, () => host.openPairing())))
  ipcMain.handle(IPC.REMOTE_ACCESS_PAIRING_CLOSE, mainOnly(IPC.REMOTE_ACCESS_PAIRING_CLOSE, refused, () => host.closePairing()))
  ipcMain.handle(IPC.REMOTE_ACCESS_TAILSCALE_SERVE, mainOnly(IPC.REMOTE_ACCESS_TAILSCALE_SERVE, refused, (enabled: unknown) => host.tailscaleServe(enabled)))

  // --- Settings → Networking: the status card ---
  const reach = o.reach ?? new LanReach({ settingsDir: deps.settingsDir ?? null })
  const platform = o.platform ?? process.platform
  let firewallCache: { at: number; view: FirewallView } | null = null
  ipcMain.handle(IPC.NETWORK_STATUS_GET, async (): Promise<NetworkStatusView> => {
    if (deps.mode === 'remote') {
      return { available: false, lan: [], networks: [], allowedNetworks: [], tailscale: 'absent', tailnetAddress: null, firewall: { state: 'unknown', message: '' }, waiting: { remoteAccess: false, mesh: false } }
    }
    // Which services listen beyond loopback once a network is allowed: the status card names them.
    const waiting = deps.mode === 'local'
      ? await host.get().then((v) => ({ remoteAccess: v.status?.enabled === true, mesh: v.status?.meshLan === true }), () => ({ remoteAccess: false, mesh: false }))
      : { remoteAccess: false, mesh: deps.meshLan?.()?.on === true }
    const snapshot = await reach.snapshot()
    if (!firewallCache || Date.now() - firewallCache.at > 60_000) {
      const view = await (o.firewall ?? (() => probeFirewall({ port: 7385, platform })))().catch((err): FirewallView => ({ state: 'unknown', message: err instanceof Error ? err.message : String(err), commands: [] }))
      firewallCache = { at: Date.now(), view }
    }
    return networkStatusView(snapshot, firewallCache.view, await readAllowedNetworks(deps.settingsDir ?? null), waiting)
  })

  // --- Consent per network (owner decision 2026-10-18 b) ---
  // The notice is non-modal (consent review 3): a list pushed to every window, read again by a window that opens later.
  const notices = new Map<string, NetworkNotice>()
  const pushNotices = (): void => { windows.send(IPC.NETWORK_NOTICES_CHANGED, [...notices.values()]) }
  const dropNotice = (key: string): void => {
    consentPrompt.dismiss(key)
    if (notices.delete(key)) pushNotices()
  }
  ipcMain.handle(IPC.NETWORK_NOTICES_GET, (): NetworkNotice[] => [...notices.values()])
  ipcMain.handle(IPC.NETWORK_NOTICE_DISMISS, (_event, key: unknown) => {
    if (typeof key === 'string' && notices.has(key)) {
      log.log(`[Remote access] Not now: ${notices.get(key)!.message}`)
      dropNotice(key)
    }
    return true
  })
  // Local mode: the daemon's local-only routes. Embedded: remote-access.json, then the mesh re-syncs.
  const consent = async (action: 'allow' | 'forget', id: unknown): Promise<NetworkConsentResult> => {
    if (typeof id !== 'string' || !id) return { ok: false, error: 'No network given.' }
    if (deps.mode === 'remote') return { ok: false, error: unavailableReason('remote') }
    if (deps.mode === 'local') {
      const result = await host.network(action, id)
      if (result.ok && action === 'allow') dropNotice(id)
      return result.ok ? { ok: true } : { ok: false, error: result.error }
    }
    if (!deps.settingsDir) return { ok: false, error: 'No settings folder.' }
    try {
      if (action === 'allow') {
        const network = (await reach.snapshot()).networks.find((n) => n.id === id)
        if (!network?.id) return { ok: false, error: 'That network is not one this computer is on now.' }
        allowNetwork(deps.settingsDir, { id: network.id, kind: network.kind, label: network.label })
        log.log(`[Network] Allowed on ${network.label} (${network.id})`)
      } else {
        forgetNetwork(deps.settingsDir, id)
        log.log(`[Network] Removed ${id}; its listeners close`)
      }
      await deps.meshLan?.()?.sync()
      if (action === 'allow') dropNotice(id)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
  const consentRefused: NetworkConsentResult = { ok: false, error: MAIN_WINDOW_ONLY }
  ipcMain.handle(IPC.NETWORK_ALLOW, mainOnly(IPC.NETWORK_ALLOW, consentRefused, (id: unknown) => consent('allow', id)))
  ipcMain.handle(IPC.NETWORK_FORGET, mainOnly(IPC.NETWORK_FORGET, consentRefused, (id: unknown) => consent('forget', id)))

  const consentPrompt = new NetworkConsentPrompt({
    read: async () => {
      if (deps.mode === 'remote') return null
      if (deps.mode === 'local') {
        const status = (await host.get()).status
        return status ? { active: status.enabled || status.meshLan, networks: status.networks, services: { remoteAccess: status.enabled, mesh: status.meshLan } } : null
      }
      const mesh = deps.meshLan?.() ?? null
      if (!mesh?.on) return { active: false, networks: [] }
      return { active: true, networks: (await reach.snapshot()).networks, services: { remoteAccess: false, mesh: true } }
    },
    show: (notice) => {
      notices.set(notice.key, notice)
      pushNotices()
    },
    withdraw: (keys) => {
      for (const key of keys) notices.delete(key)
      pushNotices()
    },
    log,
  })
  const consentPollMs = o.consentPollMs ?? 10_000
  const checkConsent = (): void => { consentPrompt.check().catch((err) => log.warn('[Remote access] Network check failed:', err instanceof Error ? err.message : err)) }
  const consentTimer = consentPollMs > 0 ? setInterval(checkConsent, consentPollMs) : null
  consentTimer?.unref?.()

  // --- Client: Settings → Connections ---
  ipcMain.handle(IPC.REMOTE_DISCOVERY_START, async () => { await refreshSaved(); discovery.start(); return true })
  ipcMain.handle(IPC.REMOTE_DISCOVERY_STOP, () => { discovery.stop(); return true })
  ipcMain.handle(IPC.REMOTE_PAIR_START, async (_event, request: unknown) => { await refreshSaved(); return pairing.start((request ?? {}) as RemotePairStartRequest) })
  ipcMain.handle(IPC.REMOTE_PAIR_SUBMIT_CODE, (_event, code: unknown) => pairing.submitCode(code))
  ipcMain.handle(IPC.REMOTE_PAIR_CANCEL, () => pairing.cancel())

  return {
    host,
    discovery,
    pairing,
    quitGate,
    consent: consentPrompt,
    onDaemonEvent: (payload) => {
      const type = (payload as { type?: unknown } | null)?.type
      // peers_changed: the daemon's discovery feed changed (remote-access.md §5.1).
      if (type === 'peers_changed') { daemonFeed.changed(); return }
      host.onDaemonEvent((payload ?? {}) as Record<string, unknown>)
      if (type === 'networks_changed') checkConsent()
    },
    dispose: () => {
      if (consentTimer) clearInterval(consentTimer)
      host.dispose()
      discovery.stop()
      pairing.cancel(true)
    },
  }
}
