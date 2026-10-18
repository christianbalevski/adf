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
import { allowNetwork, cleanDisplayName, forgetNetwork, readAllowedNetworks, UNSAFE_DISPLAY_CHARS } from '../daemon/remote-access/config'
import type { NetworkConsentResult, NetworkStatusView } from '../../shared/types/remote-access-ipc.types'
import type { AllowedNetwork } from '../../shared/types/remote-access.types'
import { NetworkConsentPrompt, type NetworkQuestion } from './remote-access/network-consent'

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
  /** Studio's user data: adf-settings.json (the runtime alias) and remote-access.json (the allowed networks). */
  settingsDir?: string
  /** Embedded mode: the mesh listens on the LAN (it needs consent too), and re-syncs it after an allow or a remove. */
  meshLan?: () => { on: boolean; sync: () => Promise<void> } | null
  /** Tests: replace the Electron dialogs, notifications and network. */
  overrides?: {
    host?: Partial<RemoteAccessHostDeps>
    discovery?: Partial<DiscoveryDeps>
    pairing?: Partial<PairingFlowDeps>
    askQuit?: (count: number | null) => Promise<QuitAnswer>
    reach?: LanReach
    firewall?: () => Promise<FirewallView>
    platform?: NodeJS.Platform
    /** The "Remote access paused on <network>." question; true = Allow on this network. */
    askNetwork?: (question: NetworkQuestion) => Promise<boolean>
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
  /** Ask about a network that is not allowed (once per visit); runs every 10 s. */
  consent: NetworkConsentPrompt
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
export function networkStatusView(snapshot: Awaited<ReturnType<LanReach['snapshot']>>, firewall: FirewallView, allowedNetworks: AllowedNetwork[]): NetworkStatusView {
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
  }
}

export function unavailableReason(mode: StudioBackendMode): string {
  return mode === 'remote'
    ? 'Remote access is set on the remote computer.'
    : 'Remote access needs Run agents in: This computer.'
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
    savedRemote: () => {
      const remote = deps.backend.config().remote
      return { url: remote.url, tokenSaved: remote.token !== null, fingerprint: remote.paired?.fingerprint ?? null }
    },
    confirmReplace: async ({ current, hostName, next }) => (await box({
      type: 'question',
      title: 'Replace remote computer',
      message: 'Replace remote computer',
      detail: `The saved remote computer is ${current}. Pairing with ${shownText(hostName)} (${next}) replaces its address and token.`,
      buttons: ['Replace', 'Cancel'],
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
  ipcMain.handle(IPC.REMOTE_ACCESS_SET, (_event, request: { enabled?: unknown; name?: unknown }) => host.set(request ?? {}))
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
      return { available: false, lan: [], networks: [], allowedNetworks: [], tailscale: 'absent', tailnetAddress: null, firewall: { state: 'unknown', message: '' } }
    }
    const snapshot = await reach.snapshot()
    if (!firewallCache || Date.now() - firewallCache.at > 60_000) {
      const view = await (o.firewall ?? (() => probeFirewall({ port: 7385, platform })))().catch((err): FirewallView => ({ state: 'unknown', message: err instanceof Error ? err.message : String(err), commands: [] }))
      firewallCache = { at: Date.now(), view }
    }
    return networkStatusView(snapshot, firewallCache.view, await readAllowedNetworks(deps.settingsDir ?? null))
  })

  // --- Consent per network (owner decision 2026-10-18 b) ---
  // Local mode: the daemon's local-only routes. Embedded: remote-access.json, then the mesh re-syncs.
  const consent = async (action: 'allow' | 'forget', id: unknown): Promise<NetworkConsentResult> => {
    if (typeof id !== 'string' || !id) return { ok: false, error: 'No network given.' }
    if (deps.mode === 'remote') return { ok: false, error: unavailableReason('remote') }
    if (deps.mode === 'local') {
      const result = await host.network(action, id)
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
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
  ipcMain.handle(IPC.NETWORK_ALLOW, (_event, id: unknown) => consent('allow', id))
  ipcMain.handle(IPC.NETWORK_FORGET, (_event, id: unknown) => consent('forget', id))

  const consentPrompt = new NetworkConsentPrompt({
    read: async () => {
      if (deps.mode === 'remote') return null
      if (deps.mode === 'local') {
        const status = (await host.get()).status
        return status ? { active: status.enabled || status.meshLan, networks: status.networks } : null
      }
      const mesh = deps.meshLan?.() ?? null
      if (!mesh?.on) return { active: false, networks: [] }
      return { active: true, networks: (await reach.snapshot()).networks }
    },
    ask: o.askNetwork ?? (async (q) => (await box({
      type: 'warning',
      title: q.title,
      message: q.message,
      ...(q.warning ? { detail: q.warning } : {}),
      buttons: q.canAllow ? [q.allowLabel, q.laterLabel] : ['OK'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    })) === 0),
    allow: async (id) => {
      const result = await consent('allow', id)
      windows.send(IPC.REMOTE_ACCESS_CHANGED, { view: await host.get(), notice: null })
      return result
    },
    log,
  })
  const consentPollMs = o.consentPollMs ?? 10_000
  const checkConsent = (): void => { consentPrompt.check().catch((err) => log.warn('[Remote access] Network check failed:', err instanceof Error ? err.message : err)) }
  const consentTimer = consentPollMs > 0 ? setInterval(checkConsent, consentPollMs) : null
  consentTimer?.unref?.()

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
    consent: consentPrompt,
    onDaemonEvent: (payload) => {
      host.onDaemonEvent((payload ?? {}) as Record<string, unknown>)
      if ((payload as { type?: unknown } | null)?.type === 'networks_changed') checkConsent()
    },
    dispose: () => {
      if (consentTimer) clearInterval(consentTimer)
      host.dispose()
      discovery.stop()
      pairing.cancel(true)
    },
  }
}
