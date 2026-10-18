import { BrowserWindow, dialog, ipcMain, Notification } from 'electron'
import { readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { IPC } from '../../shared/constants/ipc-channels'
import { remoteUrlOrigin } from '../../shared/utils/remote-backend-url'
import type { DaemonClient } from '../../shared/daemon-client'
import type { StudioBackendMode } from '../../shared/types/backend.types'
import type { PairingClaimView } from '../../shared/types/remote-access.types'
import type { BackendSettingsStore, SecretCodec } from './backend-config'
import { RemoteDiscovery, type DiscoveryDeps } from './remote-access/discovery'
import { RemoteAccessHost, type ClaimPrompt, type RemoteAccessHostDeps } from './remote-access/host'
import { PairingFlow, type PairingFlowDeps } from './remote-access/pairing'
import { quitQuestion, RemoteQuitGate, type QuitAnswer } from './remote-access/quit-gate'
import { LanReach } from '../services/lan-reach'
import { probeFirewall, type FirewallView } from '../daemon/remote-access/firewall'
import { cleanDisplayName } from '../daemon/remote-access/config'
import type { NetworkStatusView } from '../../shared/types/remote-access-ipc.types'

/**
 * Remote access in Studio main
 * (docs/design/remote-access.md §7, §9.1): the IPC channels of Settings →
 * Networking → Remote access (host) and Settings → Backend → Remote computer (discovery,
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
  /** Studio's user data: adf-settings.json (the runtime alias) and remote-access.json (networks marked private). */
  settingsDir?: string
  /** Tests: replace the Electron dialogs, notifications and network. */
  overrides?: {
    host?: Partial<RemoteAccessHostDeps>
    discovery?: Partial<DiscoveryDeps>
    pairing?: Partial<PairingFlowDeps>
    askQuit?: (count: number | null) => Promise<QuitAnswer>
    reach?: LanReach
    firewall?: () => Promise<FirewallView>
    platform?: NodeJS.Platform
  }
  log?: Pick<Console, 'log' | 'warn'>
}

export interface RemoteAccessIpc {
  host: RemoteAccessHost
  discovery: RemoteDiscovery
  pairing: PairingFlow
  quitGate: RemoteQuitGate
  /** The daemon's `remote_access` push (daemon-mode event bridge). */
  onDaemonEvent(payload: unknown): void
  dispose(): void
}

/**
 * This computer's name for other computers: the runtime alias (Settings →
 * Identity), else the host name. One name everywhere (mDNS, pairing, device
 * lists); the daemon reads the same setting.
 */
export function runtimeName(settingsDir: string | undefined): string {
  if (settingsDir) {
    try {
      const alias = (JSON.parse(readFileSync(join(settingsDir, 'adf-settings.json'), 'utf-8')) as { runtimeAlias?: unknown }).runtimeAlias
      const name = cleanDisplayName(alias, 64)
      if (name) return name
    } catch { /* no settings file yet: the host name */ }
  }
  return hostname()
}

/** The status line's view of a snapshot (pure). */
export function networkStatusView(snapshot: Awaited<ReturnType<LanReach['snapshot']>>, firewall: FirewallView, platform: NodeJS.Platform): NetworkStatusView {
  const lan = snapshot.addresses.filter((a) => a.kind === 'lan').map((a) => ({ address: a.address, iface: a.iface, network: a.network === 'private' ? 'private' as const : 'public' as const }))
  const tailnet = snapshot.addresses.find((a) => a.kind === 'tailnet' && a.family === 'IPv4')
  return {
    available: true,
    network: lan.length === 0 ? 'none' : lan.some((a) => a.network === 'private') ? 'private' : 'public',
    lan,
    tailscale: snapshot.tailscale,
    tailnetAddress: tailnet?.address ?? null,
    firewall: { state: firewall.state, message: firewall.message },
    problem: snapshot.problem,
    markable: platform !== 'win32',
  }
}

export function unavailableReason(mode: StudioBackendMode): string {
  return mode === 'remote'
    ? 'Remote access is set on the remote computer.'
    : 'Remote access needs Run agents in: This computer.'
}

const VIA: Record<PairingClaimView['via'], string> = { lan: 'this network', tailnet: 'your tailnet', proxy: 'through a proxy' }
const CLIENT: Record<PairingClaimView['clientKind'], string> = { studio: 'ADF Studio', cli: 'the ADF CLI' }

/** "Allow device" (§5.4): what the host's owner reads before deciding. */
export function claimQuestion(claim: PairingClaimView): { title: string; message: string; detail: string } {
  const where = [claim.address, VIA[claim.via] ?? claim.via, CLIENT[claim.clientKind] ?? claim.clientKind].join(', ')
  const login = claim.tailnetLogin ? ` Tailscale user: ${claim.tailnetLogin}.` : ''
  return {
    title: 'Allow device',
    message: 'Allow device',
    detail: `${claim.deviceName} (${where}) entered the pairing code. It gets full control, as powerful as your seed phrase.${login}\n\nAllow it only if it is your device and you just paired it.`,
  }
}

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

  const host = new RemoteAccessHost({
    daemon: () => {
      if (deps.mode !== 'local') return { unavailable: unavailableReason(deps.mode) }
      const daemon = deps.daemon()
      if (!daemon) return { unavailable: 'Studio is not connected to the ADF daemon yet.' }
      return { client: () => withTimeout(daemon.client(), 8_000, 'Studio is not connected to the ADF daemon yet.') }
    },
    stopsWithStudio: () => !deps.keepDaemonRunning() && localDaemon()?.status().startedBy === 'studio',
    push: (change) => windows.send(IPC.REMOTE_ACCESS_CHANGED, change),
    notify,
    confirm: async ({ message, detail, ok }) => (await box({ type: 'question', title: message, message, detail, buttons: [ok, 'Cancel'], defaultId: 1, cancelId: 1, noLink: true })) === 0,
    askClaim: async ({ claim, signal }: ClaimPrompt) => {
      const win = deps.window()
      const question = claimQuestion(claim)
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
    log,
    ...o.host,
  })

  const discovery = new RemoteDiscovery({
    onUpdate: (update) => windows.send(IPC.REMOTE_DISCOVERY_UPDATE, update),
    pairedFingerprint: () => deps.backend.config().remote.paired?.fingerprint ?? null,
    ownFingerprint: () => host.lastStatus?.fingerprint ?? null,
    log,
    ...o.discovery,
  })

  const pairing = new PairingFlow({
    onState: (state) => windows.send(IPC.REMOTE_PAIR_STATE, state),
    saveBlocked: () => deps.codec.available() ? null : (deps.codec.unavailableReason?.() ?? 'OS keychain encryption is not available, so the token cannot be saved.'),
    defaultDeviceName: () => runtimeName(deps.settingsDir),
    save: async (input) => {
      const result = await deps.backend.savePairing({
        remoteUrl: input.url,
        remoteToken: input.token,
        allowInsecureHttp: input.allowInsecureHttp,
        ...(input.allowInsecureHttp ? { insecureHttpOrigin: remoteUrlOrigin(input.url) ?? undefined } : {}),
      }, { fingerprint: input.fingerprint, name: input.name, deviceId: input.deviceId, label: input.label })
      discovery.refresh()
      return result.ok ? { ok: true } : { ok: false, error: result.error }
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

  // --- Host: Settings → Networking → Remote access ---
  ipcMain.handle(IPC.REMOTE_ACCESS_GET, (_event, opts?: { refresh?: unknown }) => host.get({ refresh: opts?.refresh === true }))
  ipcMain.handle(IPC.REMOTE_ACCESS_SET, (_event, request: { enabled?: unknown; name?: unknown; trustNetwork?: unknown }) => host.set(request ?? {}))
  ipcMain.handle(IPC.REMOTE_ACCESS_DEVICE_ADD, (_event, label: unknown) => host.addDevice(label))
  ipcMain.handle(IPC.REMOTE_ACCESS_DEVICE_REMOVE, (_event, id: unknown) => host.removeDevice(id))
  ipcMain.handle(IPC.REMOTE_ACCESS_PAIRING_OPEN, () => host.openPairing())
  ipcMain.handle(IPC.REMOTE_ACCESS_PAIRING_CLOSE, () => host.closePairing())
  ipcMain.handle(IPC.REMOTE_ACCESS_TAILSCALE_SERVE, (_event, enabled: unknown) => host.tailscaleServe(enabled))

  // --- Settings → Networking: the status line ---
  const reach = o.reach ?? new LanReach({ settingsDir: deps.settingsDir ?? null })
  const platform = o.platform ?? process.platform
  let firewallCache: { at: number; view: FirewallView } | null = null
  ipcMain.handle(IPC.NETWORK_STATUS_GET, async (): Promise<NetworkStatusView> => {
    if (deps.mode === 'remote') {
      return { available: false, network: 'none', lan: [], tailscale: 'absent', tailnetAddress: null, firewall: { state: 'unknown', message: '' }, problem: null, markable: false }
    }
    const snapshot = await reach.snapshot()
    const allPublic = snapshot.addresses.some((a) => a.kind === 'lan') && snapshot.addresses.every((a) => a.kind !== 'lan' || a.refusal !== null)
    if (!firewallCache || Date.now() - firewallCache.at > 60_000) {
      const view = await (o.firewall ?? (() => probeFirewall({ port: 7385, allLanPublic: allPublic, platform })))().catch((err): FirewallView => ({ state: 'unknown', message: err instanceof Error ? err.message : String(err), commands: [] }))
      firewallCache = { at: Date.now(), view }
    }
    return networkStatusView(snapshot, firewallCache.view, platform)
  })

  // --- Client: Settings → Backend → Remote computer ---
  ipcMain.handle(IPC.REMOTE_DISCOVERY_START, () => { discovery.start(); return true })
  ipcMain.handle(IPC.REMOTE_DISCOVERY_STOP, () => { discovery.stop(); return true })
  ipcMain.handle(IPC.REMOTE_PAIR_START, (_event, request: unknown) => pairing.start((request ?? {}) as { url: string }))
  ipcMain.handle(IPC.REMOTE_PAIR_SUBMIT_CODE, (_event, code: unknown) => pairing.submitCode(code))
  ipcMain.handle(IPC.REMOTE_PAIR_CANCEL, () => pairing.cancel())

  return {
    host,
    discovery,
    pairing,
    quitGate,
    onDaemonEvent: (payload) => host.onDaemonEvent((payload ?? {}) as Record<string, unknown>),
    dispose: () => {
      host.dispose()
      discovery.stop()
      pairing.cancel(true)
    },
  }
}
