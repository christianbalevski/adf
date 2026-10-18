/**
 * Remote access: other computers reach this daemon (docs/design/remote-access.md).
 *
 * Owns the setting (remote-access.json), the device tokens
 * (daemon-devices.json), the listeners on private and Tailscale addresses,
 * the pairing window and the mDNS announcement, and answers the routes in
 * routes/remote-access-routes.ts. Turning it on or off never restarts the
 * daemon: listeners open and close live (owner decision O1).
 *
 * Every change is logged (`[remote-access] …`) and emitted as a
 * `remote_access` event (no token, no code), which reaches Studio's client
 * stream and the daemon event bus.
 *
 * While on, the addresses are re-read every 10 s; Tailscale and the network
 * categories every 60 s and whenever the set of interfaces changes. All of
 * it runs off the request path (timers), asynchronously.
 */

import { networkInterfaces, hostname as osHostname, type NetworkInterfaceInfo } from 'node:os'
import type { Socket } from 'node:net'
import type { IncomingMessage } from 'node:http'
import type {
  PairClaimAccepted, PairClaimResult, PairingWindowView, RemoteAccessEvent, RemoteAccessPatch,
  RemoteAccessStatus, RemoteAddress, RemoteDevice, RemoteHello, RemoteUrl,
} from '../../../shared/types/remote-access.types'
import type { DeviceTokenAuthority } from '../request-guard'
import type { ClientSessionRegistry } from '../client-sessions'
import { isLoopbackAddress } from '../local-access'
import { addressCandidates, lanInterfaceNames, urlHost, type AddressCandidate } from './addresses'
import { BonjourAnnouncer, type Announcer } from './announcer'
import { BoundedMap, SOURCE_TRACKING_CAP } from './bounded-map'
import {
  cleanDisplayName, defaultComputerName, fingerprintOf, loadRemoteAccessConfig, newDaemonId,
  saveRemoteAccessConfig, type RemoteAccessConfig,
} from './config'
import { DeviceStore, type DeviceRecord } from './device-store'
import { probeFirewall, type FirewallProbeInput, type FirewallView } from './firewall'
import { RemoteListeners, remoteListenerOf, type RequestHandler } from './listeners'
import { NetworkCategoryTracker } from './network-key'
import { readGatewayIdentities, readNetworkCategories, type NetworkCategories } from './network-category'
import { PAIRING_MAX_WRONG, PAIRING_MAX_WRONG_TOTAL, PairingError, PairingManager } from './pairing'
import type { RequestAuth } from './request-auth'
import { TailscaleClient, type TailscaleSelf, type TailscaleServe } from './tailscale'

export const ADDRESS_CHECK_MS = 10_000
export const SLOW_CHECK_MS = 60_000
export const CONNECTED_WINDOW_MS = 60_000
export const HELLO_PER_MINUTE = 30
export const WRONG_CODE_DELAY_MS = 1_000

export class RemoteAccessError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly extra: Record<string, unknown> = {}) {
    super(message)
    this.name = 'RemoteAccessError'
  }
}

export interface TailscaleLike {
  self(): Promise<TailscaleSelf>
  serveStatus(port: number): Promise<TailscaleServe>
  setServe(port: number, enabled: boolean): Promise<string>
  serveCommand(port: number, enabled: boolean): string[]
  whois(address: string): Promise<string | null>
  readonly command: string | null
}

export interface RemoteAccessServiceOptions {
  settingsDir: string
  port: number
  clientApiVersion: number
  /** ADF_DAEMON_HOST when it is not loopback (remote-daemon.md Option 2): the env path wins, the toggle is refused. */
  envBindHost?: string | null
  log?: (line: string) => void
  /** Daemon event bus + client push (daemon/index.ts). */
  emit?: (event: RemoteAccessEvent) => void
  /** Client sessions (revocation ends a device's sessions). */
  sessions?: () => ClientSessionRegistry | undefined
  // Seams (tests).
  interfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>
  categories?: (ifaces: readonly string[], config: RemoteAccessConfig) => Promise<NetworkCategories>
  /** Per LAN interface, the network it is on (`<gateway IP>|<gateway MAC>`, '' unknown); read every check. */
  gateways?: (ifaces: readonly string[], interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>) => Promise<Map<string, string>>
  tailscale?: TailscaleLike
  announcer?: Announcer
  firewall?: (input: FirewallProbeInput) => Promise<FirewallView>
  platform?: NodeJS.Platform
  hostName?: () => string
  checkIntervalMs?: number
  slowCheckMs?: number
  wrongCodeDelayMs?: number
  now?: () => number
  /**
   * ADF_DAEMON_BEHIND_PROXY: `tailscale serve` (or another proxy on this host)
   * forwards to the loopback listener. Only then, and only from a loopback
   * peer, are the Tailscale-User-Login / -Name headers trusted.
   */
  behindProxy?: boolean
  /** Test seam: the address a candidate is actually bound to (tests map a private address to loopback). */
  bindAddress?: (address: string) => string
  /**
   * The runtime alias (settings `runtimeAlias`): this computer's one name for
   * other computers (mDNS, hello, pairing). Set: PUT name writes it. Absent or
   * blank: remote-access.json's `name` (the host name by default).
   */
  runtimeAlias?: { get(): unknown; set(name: string): void }
}

interface DeviceConnection {
  sockets: Set<Socket>
  lastRequestAt: number
}

function plainAddress(address: string | undefined): string {
  if (!address) return 'unknown'
  return address.startsWith('::ffff:') ? address.slice(7) : address
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

export class RemoteAccessService {
  readonly port: number
  private config: RemoteAccessConfig
  private configProblem: string | null
  readonly store: DeviceStore
  private readonly pairing: PairingManager
  private listeners: RemoteListeners | null = null
  private candidates: AddressCandidate[] = []
  private listenerProblems = new Map<string, string>()
  private categories: NetworkCategories = { categories: new Map(), current: [], problem: null }
  /**
   * The LAN interfaces' categories, valid only for each interface's addresses
   * and gateway at the read (network-key.ts): any change re-reads, and the
   * interface's listeners close until the new read confirms private.
   */
  private readonly tracker: NetworkCategoryTracker
  private tailscaleSelf: TailscaleSelf = { state: 'absent', ips: [], dnsName: null }
  private tailscaleServe: TailscaleServe = { serve: 'unknown', httpsUrl: null }
  private tailscaleAt = 0
  private firewallView: FirewallView | null = null
  private readonly connections = new Map<string, DeviceConnection>()
  private readonly helloHits = new BoundedMap<string, number[]>(SOURCE_TRACKING_CAP)
  private timer: ReturnType<typeof setInterval> | null = null
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private applying: Promise<void> = Promise.resolve()
  private stopped = false
  private readonly log: (line: string) => void
  private readonly emitEvent: (event: RemoteAccessEvent) => void
  private readonly interfaces: () => NodeJS.Dict<NetworkInterfaceInfo[]>
  private readonly readCategories: (ifaces: readonly string[], config: RemoteAccessConfig) => Promise<NetworkCategories>
  private readonly readGateways: (ifaces: readonly string[], interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>) => Promise<Map<string, string>>
  private readonly tailscale: TailscaleLike
  private readonly announcer: Announcer
  private readonly probeFirewall: (input: FirewallProbeInput) => Promise<FirewallView>
  private readonly platform: NodeJS.Platform
  private readonly hostName: () => string
  private readonly checkIntervalMs: number
  private readonly slowCheckMs: number
  readonly wrongCodeDelayMs: number
  private readonly now: () => number

  constructor(private readonly opts: RemoteAccessServiceOptions) {
    this.port = opts.port
    this.log = opts.log ?? ((line) => console.log(line))
    this.emitEvent = opts.emit ?? (() => {})
    this.interfaces = opts.interfaces ?? networkInterfaces
    this.platform = opts.platform ?? process.platform
    this.readCategories = opts.categories ?? ((ifaces, config) => readNetworkCategories(ifaces, config.privateNetworks, { platform: this.platform }))
    this.readGateways = opts.gateways ?? ((ifaces, interfaces) => readGatewayIdentities(ifaces, interfaces, { platform: this.platform }))
    this.tracker = new NetworkCategoryTracker({
      readCategories: (ifaces) => this.readCategories(ifaces, this.config),
      readGateways: (ifaces, interfaces) => this.readGateways(ifaces, interfaces),
      slowCheckMs: opts.slowCheckMs ?? SLOW_CHECK_MS,
      now: () => this.now(),
    })
    this.tailscale = opts.tailscale ?? new TailscaleClient()
    this.announcer = opts.announcer ?? new BonjourAnnouncer()
    this.probeFirewall = opts.firewall ?? probeFirewall
    this.hostName = opts.hostName ?? osHostname
    this.checkIntervalMs = opts.checkIntervalMs ?? ADDRESS_CHECK_MS
    this.slowCheckMs = opts.slowCheckMs ?? SLOW_CHECK_MS
    this.wrongCodeDelayMs = opts.wrongCodeDelayMs ?? WRONG_CODE_DELAY_MS
    this.now = opts.now ?? Date.now
    const loaded = loadRemoteAccessConfig(opts.settingsDir, cleanDisplayName(this.hostName(), 63) ?? undefined)
    this.config = loaded.config
    this.configProblem = loaded.problem
    if (loaded.problem) this.log(`[remote-access] ${loaded.problem}`)
    this.store = new DeviceStore(opts.settingsDir, { now: this.now })
    if (this.store.problem) this.log(`[remote-access] ${this.store.problem}`)
    this.pairing = new PairingManager({
      opened: () => {
        this.log('[remote-access] pairing window opened (120 s)')
        this.emit({ type: 'pairing_opened' })
        void this.reannounce()
      },
      closed: (reason) => {
        this.log(`[remote-access] pairing window closed: ${reason === 'wrong_codes' ? `after ${PAIRING_MAX_WRONG_TOTAL} wrong codes` : reason}`)
        this.emit({ type: 'pairing_closed', reason })
        void this.reannounce()
      },
      claimPending: (claim) => {
        this.log(`[remote-access] pairing request from "${claim.deviceName}" at ${claim.address} (${claim.via}${claim.tailnetLogin ? `, ${claim.tailnetLogin}` : ''}): waiting for the owner`)
        // "Pending claims changed" only: the claim (its id included) is read through GET /remote-access, this machine only.
        this.emit({ type: 'claim_pending' })
      },
      sourceLocked: (address, lockedSources) => {
        this.log(`[remote-access] pairing: ${address} locked out of this window after ${PAIRING_MAX_WRONG} wrong codes (${lockedSources} source(s) locked; the window stays open)`)
        this.emit({ type: 'pairing_lockout' })
      },
    }, { now: this.now, host: () => ({ name: this.computerName, fingerprint: this.fingerprint ?? '' }) })
  }

  // --- state ---------------------------------------------------------------------

  /** Remote access is on and usable (device tokens are accepted). */
  get enabled(): boolean {
    return this.config.enabled && !this.configProblem && !this.envBind
  }

  private get envBind(): boolean {
    return !!this.opts.envBindHost
  }

  get computerName(): string {
    return cleanDisplayName(this.opts.runtimeAlias?.get(), 63) ?? this.config.name
  }

  get fingerprint(): string | null {
    return this.config.daemonId ? fingerprintOf(this.config.daemonId) : null
  }

  private emit(event: RemoteAccessEvent): void {
    try { this.emitEvent(event) } catch (err) { this.log(`[remote-access] event listener failed: ${err instanceof Error ? err.message : String(err)}`) }
  }

  /** The request guard's view of device tokens. */
  deviceAuthority(): DeviceTokenAuthority {
    return {
      check: (token) => {
        const result = this.store.check(token)
        if (result.kind === 'device') return { kind: 'device', id: result.device.id, label: result.device.label }
        if (result.kind === 'revoked') return { kind: 'revoked', label: result.tombstone.label, revokedAt: result.tombstone.revokedAt }
        return { kind: 'unknown' }
      },
      enabled: () => this.enabled,
      computerName: () => this.computerName,
    }
  }

  /**
   * Host names the daemon accepts while remote access is on (§3.5): the OS
   * host name, `<name>.local`, the MagicDNS names, and each listening address
   * on the daemon's port. Entries as ADF_DAEMON_ALLOWED_HOSTS takes them.
   */
  allowedHostEntries(): string[] {
    if (!this.enabled) return []
    const entries = new Set<string>()
    for (const name of this.hostNames()) entries.add(name)
    for (const address of this.listeners?.addresses() ?? []) entries.add(`${urlHost(address)}:${this.port}`)
    return [...entries]
  }

  private hostNames(): string[] {
    const names = new Set<string>()
    const host = this.hostName().toLowerCase()
    if (host && !host.includes(':')) {
      names.add(host)
      names.add(host.endsWith('.local') ? host : `${host}.local`)
    }
    const dns = this.tailscaleSelf.dnsName?.toLowerCase()
    if (dns) {
      names.add(dns)
      names.add(dns.split('.')[0])
    }
    return [...names]
  }

  // --- lifecycle -------------------------------------------------------------------

  /** The daemon listens: remote listeners hand their requests to `handler` (fastify.routing). */
  async attach(handler: RequestHandler): Promise<void> {
    this.listeners = new RemoteListeners({ port: this.port, handler, log: this.log, ...(this.opts.bindAddress ? { bindAddress: this.opts.bindAddress } : {}) })
    this.flushTimer = setInterval(() => this.store.flushLastSeen(), 60_000)
    this.flushTimer.unref?.()
    if (this.envBind && this.config.enabled) {
      this.log(`[remote-access] not used: ADF_DAEMON_HOST=${this.opts.envBindHost} binds the daemon to the network itself`)
      return
    }
    if (this.enabled) {
      this.log('[remote-access] on (remote-access.json): opening listeners')
      await this.apply({ force: true })
      void this.refreshFirewall()
    }
  }

  /** Daemon stop: close listeners, stop announcing, write lastSeen. */
  async shutdown(): Promise<void> {
    this.stopped = true
    this.stopTimer()
    if (this.flushTimer) clearInterval(this.flushTimer)
    this.pairing.dispose()
    try { await this.announcer.stop() } catch { /* best effort */ }
    try { await this.listeners?.closeAll() } catch { /* best effort */ }
    this.store.flushLastSeen(true)
  }

  private startTimer(): void {
    if (this.timer) return
    this.timer = setInterval(() => { void this.apply({}) }, this.checkIntervalMs)
    this.timer.unref?.()
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Re-read the network and make the listeners match. Serialized. */
  apply(opts: { force?: boolean }): Promise<void> {
    const run = this.applying.then(() => this.applyNow(opts)).catch((err) => {
      this.log(`[remote-access] address check failed: ${err instanceof Error ? err.message : String(err)}`)
    })
    this.applying = run
    return run
  }

  private async applyNow(opts: { force?: boolean }): Promise<void> {
    if (this.stopped || !this.listeners) return
    if (!this.enabled) {
      await this.listeners.closeAll()
      return
    }
    this.startTimer()
    const now = this.now()
    const interfaces = this.interfaces()
    if (opts.force || now - this.tailscaleAt >= this.slowCheckMs || this.tailscaleChanged(interfaces)) {
      this.tailscaleSelf = await this.tailscale.self()
      this.tailscaleServe = this.tailscaleSelf.state === 'running' ? await this.tailscale.serveStatus(this.port) : { serve: 'unknown', httpsUrl: null }
      this.tailscaleAt = now
    }
    const tailscaleIps = new Set(this.tailscaleSelf.ips)
    // The category of an interface holds for its addresses and gateway at the read (security review item 2,
    // network-key.ts, shared with the mesh's LAN mode).
    const read = this.categories
    this.categories = await this.tracker.refresh({
      interfaces,
      tailscaleIps,
      force: opts.force,
      beforeReread: async (changed) => {
        // MUST NOT listen on a network not confirmed private (O2): close the changed interfaces' LAN
        // listeners before the (slow) re-read; they open again only if it says private.
        const listeners = this.listeners
        if (!listeners) return
        const closing = new Set(this.candidates.filter(c => c.kind === 'lan' && changed.includes(c.iface)).map(c => c.address))
        const keep = listeners.addresses().filter(a => !closing.has(a))
        if (keep.length !== listeners.addresses().length) {
          this.log(`[remote-access] network changed on ${changed.join(', ')}: closing its listeners until the network is confirmed private`)
          await listeners.sync(keep)
        }
      },
    })
    if (this.categories !== read && this.categories.problem) this.log(`[remote-access] ${this.categories.problem}`)
    if (this.stopped || !this.enabled) return
    const before = this.candidates.map(c => `${c.address}:${c.refusal ? 'off' : 'on'}`).join(',')
    this.candidates = addressCandidates({ interfaces, tailscaleIps, categories: this.categories.categories, only: this.config.addresses })
    const wanted = this.candidates.filter(c => !c.refusal).map(c => c.address)
    const previous = new Set(this.listeners.addresses())
    this.listenerProblems = await this.listeners.sync(wanted, { shouldOpen: () => this.enabled && !this.stopped })
    for (const [address, problem] of this.listenerProblems) this.log(`[remote-access] ${problem}`)
    const after = this.candidates.map(c => `${c.address}:${c.refusal ? 'off' : 'on'}`).join(',')
    const listening = this.listeners.addresses()
    const added = listening.filter(a => !previous.has(a))
    const removed = [...previous].filter(a => !listening.includes(a))
    if (before !== after || added.length || removed.length) {
      const publicOnes = this.candidates.filter(c => c.refusal).map(c => c.address)
      this.log(`[remote-access] addresses: listening on ${listening.length ? listening.join(', ') : 'none'}${added.length ? `; added ${added.join(', ')}` : ''}${removed.length ? `; removed ${removed.join(', ')}` : ''}${publicOnes.length ? `; not on public network ${publicOnes.join(', ')}` : ''}`)
      this.emit({ type: 'addresses_changed' })
    }
    await this.reannounce()
  }

  private tailscaleChanged(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): boolean {
    // A 100.64/10 or fd7a:115c:a1e0::/48 address appeared or went: ask Tailscale now.
    const known = new Set(this.tailscaleSelf.ips)
    let seen = 0
    for (const infos of Object.values(interfaces)) {
      for (const info of infos ?? []) {
        const a = info.address.toLowerCase()
        const tailnetish = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a) || /^fd7a:115c:a1e0:/.test(a)
        if (!tailnetish) continue
        seen++
        if (!known.has(a)) return true
      }
    }
    return seen !== known.size
  }

  private async reannounce(): Promise<void> {
    if (this.stopped) return
    const lan = this.candidates.find(c => c.kind === 'lan' && c.family === 'IPv4' && this.listeners?.addresses().includes(c.address))
    if (!this.enabled || !lan || !this.config.daemonId) {
      if (this.announcer.announcing) await this.announcer.stop()
      return
    }
    await this.announcer.announce({
      name: this.computerName,
      port: this.port,
      iface: lan.address,
      txt: { v: '1', fp: fingerprintOf(this.config.daemonId), pair: this.pairing.isOpen ? '1' : '0', api: String(this.opts.clientApiVersion) },
    })
  }

  private async refreshFirewall(): Promise<void> {
    try {
      this.firewallView = await this.probeFirewall({ port: this.port, allLanPublic: this.allLanPublic(), platform: this.platform })
      if (this.firewallView.state === 'blocked') this.log(`[remote-access] ${this.firewallView.message}`)
    } catch (err) {
      this.firewallView = { state: 'unknown', message: `Could not read the firewall state (${err instanceof Error ? err.message : String(err)}).`, commands: [] }
    }
  }

  /** The probe's answer, except that a network not marked private is always `public_network` (every OS). */
  private firewallState(): FirewallView {
    if (this.enabled && this.allLanPublic()) {
      return {
        state: 'public_network',
        message: this.platform === 'win32'
          ? 'Windows treats this network as Public, so ADF does not listen on it. Set it to Private in Windows Settings → Network if you trust it.'
          : 'This network is not marked private, so ADF does not listen on it. Mark it private (Allow on This Network, or adf daemon remote trust) if you trust it.',
        commands: this.firewallView?.commands ?? [],
      }
    }
    return this.firewallView ?? { state: 'unknown', message: 'Not checked yet.', commands: [] }
  }

  private allLanPublic(): boolean {
    const lan = this.candidates.filter(c => c.kind === 'lan')
    return lan.length > 0 && lan.every(c => c.network === 'public')
  }

  // --- requests ------------------------------------------------------------------

  /** Every authenticated request (onRequest): remember a device's connection and last-seen. */
  noteRequest(raw: IncomingMessage, auth: RequestAuth): void {
    if (auth.kind !== 'device') return
    const socket = raw.socket
    const address = this.sourceAddress(raw)
    this.store.touch(auth.deviceId, address)
    let conn = this.connections.get(auth.deviceId)
    if (!conn) {
      conn = { sockets: new Set(), lastRequestAt: 0 }
      this.connections.set(auth.deviceId, conn)
    }
    conn.lastRequestAt = this.now()
    // Injected test requests have no real socket.
    if (!socket || typeof socket.once !== 'function' || typeof socket.destroy !== 'function') return
    if (!conn.sockets.has(socket)) {
      const wasIdle = conn.sockets.size === 0
      conn.sockets.add(socket)
      const deviceId = auth.deviceId
      socket.once('close', () => {
        const c = this.connections.get(deviceId)
        if (!c) return
        c.sockets.delete(socket)
        if (c.sockets.size === 0) {
          this.log(`[remote-access] "${auth.label}" (${deviceId}) disconnected`)
          this.emit({ type: 'device_disconnected', deviceId, label: auth.label })
        }
      })
      if (wasIdle) {
        this.log(`[remote-access] "${auth.label}" (${deviceId}) connected from ${address}`)
        this.emit({ type: 'device_connected', deviceId, label: auth.label })
      }
    }
  }

  /**
   * The caller's address: always the socket's peer. X-Forwarded-For is never
   * read: any process on this machine can send it to the loopback listener
   * (security review item 3).
   */
  sourceAddress(raw: IncomingMessage): string {
    return plainAddress(raw.socket?.remoteAddress)
  }

  /**
   * Who is calling, for rate limits, lockouts and the Allow prompt. On a
   * remote listener: the socket address (whois only for a tailnet socket
   * address, never a header). On the loopback listener: the socket address,
   * except behind `tailscale serve` (ADF_DAEMON_BEHIND_PROXY, loopback peer),
   * where the Tailscale-User-Login / -Name headers serve sets name the tailnet
   * user and key the limits per user.
   */
  private async caller(raw: IncomingMessage, opts: { whois: boolean }): Promise<{ key: string; address: string; via: 'lan' | 'tailnet' | 'proxy'; tailnetLogin: string | null }> {
    const address = this.sourceAddress(raw)
    const listener = remoteListenerOf(raw.socket)
    if (listener) {
      const via = this.candidates.find(c => c.address === listener)?.kind === 'tailnet' ? 'tailnet' : 'lan'
      const tailnetLogin = via === 'tailnet' && opts.whois ? await this.tailscale.whois(address) : null
      return { key: address, address, via, tailnetLogin }
    }
    if (this.opts.behindProxy && isLoopbackAddress(address)) {
      const login = cleanDisplayName(single(raw.headers['tailscale-user-login']) ?? single(raw.headers['tailscale-user-name']), 128)
      if (login) return { key: `tailscale:${login.toLowerCase()}`, address, via: 'proxy', tailnetLogin: login }
    }
    return { key: address, address, via: 'proxy', tailnetLogin: null }
  }

  // --- status ----------------------------------------------------------------------

  async status(opts: { refresh?: boolean } = {}): Promise<RemoteAccessStatus> {
    if (opts.refresh && this.enabled) {
      await this.apply({ force: true })
      await this.refreshFirewall()
    }
    const listening = new Set(this.listeners?.addresses() ?? [])
    const addresses: RemoteAddress[] = this.enabled
      ? this.candidates.map(c => ({
        address: c.address,
        family: c.family,
        kind: c.kind,
        iface: c.iface,
        network: c.network,
        listening: listening.has(c.address),
        problem: c.refusal ?? this.listenerProblems.get(c.address) ?? null,
      }))
      : []
    const { state, message } = this.stateLine(addresses)
    return {
      enabled: this.config.enabled,
      state,
      message,
      problem: this.configProblem ?? this.store.problem ?? this.categories.problem,
      name: this.computerName,
      fingerprint: this.fingerprint,
      port: this.port,
      addresses,
      urls: this.urls(addresses),
      hostNames: this.enabled ? this.hostNames() : [],
      tailscale: {
        state: this.tailscaleSelf.state,
        serve: this.tailscaleSelf.state === 'running' ? this.tailscaleServe.serve : 'unknown',
        httpsUrl: this.tailscaleServe.httpsUrl,
        serveCommand: this.tailscaleSelf.state === 'running' ? `tailscale ${this.tailscale.serveCommand(this.port, true).join(' ')}` : null,
      },
      mdns: { announcing: this.announcer.announcing, problem: this.announcer.problem },
      firewall: this.firewallState(),
      devices: this.store.list().map(d => this.deviceView(d)),
      pairing: this.pairing.view(),
    }
  }

  private stateLine(addresses: RemoteAddress[]): { state: RemoteAccessStatus['state']; message: string } {
    if (this.envBind) return { state: 'env_bind', message: `The daemon is bound to ${this.opts.envBindHost} by ADF_DAEMON_HOST; the remote access setting is not used.` }
    if (this.configProblem) return { state: 'error', message: this.configProblem }
    if (!this.config.enabled) return { state: 'off', message: 'Remote access off.' }
    const on = addresses.filter(a => a.listening).map(a => a.address)
    if (on.length > 0) return { state: 'on', message: `Listening on ${on.join(', ')}.` }
    if (addresses.some(a => a.network === 'public')) return { state: 'no_address', message: 'Not reachable on this network (Public).' }
    return { state: 'no_address', message: 'No private network address now.' }
  }

  private urls(addresses: RemoteAddress[]): RemoteUrl[] {
    const out: RemoteUrl[] = []
    if (!this.enabled) return out
    if (this.tailscaleServe.serve === 'on' && this.tailscaleServe.httpsUrl) out.push({ url: this.tailscaleServe.httpsUrl, kind: 'tailscale-https', encrypted: true })
    for (const a of addresses) if (a.listening && a.kind === 'tailnet') out.push({ url: `http://${urlHost(a.address)}:${this.port}`, kind: 'tailnet', encrypted: true })
    const lan = addresses.filter(a => a.listening && a.kind === 'lan')
    for (const a of lan) out.push({ url: `http://${urlHost(a.address)}:${this.port}`, kind: 'lan', encrypted: false })
    const host = this.hostName().toLowerCase()
    if (lan.length && host) out.push({ url: `http://${host.endsWith('.local') ? host : `${host}.local`}:${this.port}`, kind: 'mdns-name', encrypted: false })
    return out
  }

  private deviceView(d: DeviceRecord): RemoteDevice {
    const conn = this.connections.get(d.id)
    const sessions = this.opts.sessions?.()?.sessionsOfDevice(d.id) ?? 0
    const streaming = this.opts.sessions?.()?.deviceStreaming(d.id) ?? false
    const connections = conn?.sockets.size ?? 0
    const recent = !!conn && this.now() - conn.lastRequestAt < CONNECTED_WINDOW_MS
    return {
      id: d.id,
      label: d.label,
      origin: d.origin,
      createdAt: d.createdAt,
      createdBy: d.createdBy,
      lastSeenAt: d.lastSeenAt,
      lastSeenAddress: d.lastSeenAddress,
      connected: connections > 0 || streaming || recent,
      connections,
      sessions,
    }
  }

  // --- management (this machine only) ---------------------------------------------

  async update(patch: RemoteAccessPatch): Promise<RemoteAccessStatus> {
    if (patch.name !== undefined) {
      const name = cleanDisplayName(patch.name, 63)
      if (!name) throw new RemoteAccessError('name must be 1-63 characters without control or bidi characters', 400, 'bad_request')
      if (this.opts.runtimeAlias) {
        // One name: the runtime alias.
        if (name !== this.computerName) {
          this.opts.runtimeAlias.set(name)
          this.log(`[remote-access] computer name set to "${name}" (runtime alias)`)
        }
      } else if (name !== this.config.name) {
        this.config = { ...this.config, name }
        this.save()
        this.log(`[remote-access] computer name set to "${name}"`)
      }
    }
    if (patch.enabled === true && !this.config.enabled) await this.turnOn()
    else if (patch.enabled === false && this.config.enabled) await this.turnOff()
    if (patch.trustNetwork !== undefined) await this.trustCurrentNetworks(patch.trustNetwork)
    if (patch.name !== undefined) await this.reannounce()
    return await this.status()
  }

  private save(): void {
    saveRemoteAccessConfig(this.opts.settingsDir, this.config)
  }

  private async turnOn(): Promise<void> {
    if (this.envBind) throw new RemoteAccessError(`The daemon is bound to ${this.opts.envBindHost} by ADF_DAEMON_HOST; remote access from Settings is not used. Start the daemon without --host / ADF_DAEMON_HOST to use it.`, 409, 'env_bind')
    if (this.configProblem) {
      // Turning it on is the owner's answer to a broken file: start from the defaults, keeping nothing unreadable.
      this.log(`[remote-access] replacing the unreadable remote-access.json: ${this.configProblem}`)
      this.configProblem = null
    }
    this.config = { ...this.config, enabled: true, daemonId: this.config.daemonId ?? newDaemonId(), name: this.config.name || defaultComputerName() }
    this.save()
    this.log(`[remote-access] turned on (fingerprint ${this.fingerprint})`)
    if (this.platform !== 'win32') await this.trustCurrentNetworks(true, { quietIfNone: true })
    await this.apply({ force: true })
    await this.refreshFirewall()
    this.emit({ type: 'enabled' })
  }

  private async turnOff(): Promise<void> {
    // Off at once (device tokens refused, no new listener opens), then the closing runs in the
    // address checks' chain, after any check in flight (security review item 6).
    this.config = { ...this.config, enabled: false }
    this.save()
    this.stopTimer()
    this.pairing.dispose()
    let closed = 0
    const closing = this.applying.then(async () => {
      await this.announcer.stop()
      closed = (await this.listeners?.closeAll()) ?? 0
    })
    this.applying = closing.catch(() => {})
    await closing
    // Device connections through a proxy on this host (tailscale serve) end too.
    let proxied = 0
    for (const conn of this.connections.values()) {
      for (const socket of conn.sockets) { socket.destroy(); proxied++ }
    }
    const sessions = (await this.opts.sessions?.()?.endDeviceSessions(null, 'remote_access_off')) ?? 0
    this.log(`[remote-access] turned off: closed ${closed + proxied} connection(s) and ${sessions} device session(s)`)
    this.emit({ type: 'disabled' })
  }

  /** macOS/Linux: mark (or unmark) the networks of the current LAN interfaces private (§3.3.1). */
  private async trustCurrentNetworks(trust: boolean, opts: { quietIfNone?: boolean } = {}): Promise<void> {
    if (this.platform === 'win32') {
      throw new RemoteAccessError('On Windows the network category decides: set this network to Private in Windows Settings → Network & internet.', 409, 'network_category_os')
    }
    const interfaces = this.interfaces()
    if (this.tailscaleAt === 0) this.tailscaleSelf = await this.tailscale.self()
    const ifaces = lanInterfaceNames(interfaces, new Set(this.tailscaleSelf.ips))
    const read = await this.readCategories(ifaces, this.config)
    if (read.current.length === 0) {
      const why = read.problem ?? 'no network with a default gateway was found on a private address'
      if (!opts.quietIfNone) throw new RemoteAccessError(`This network cannot be identified (${why}), so it cannot be marked private.`, 409, 'network_unidentified')
      this.log(`[remote-access] no network marked private: ${why}`)
      return
    }
    const ids = new Set(read.current.map(n => n.id))
    const before = this.config.privateNetworks.length
    const at = new Date(this.now()).toISOString()
    const networks = trust
      ? [...this.config.privateNetworks, ...read.current.filter(n => !this.config.privateNetworks.some(p => p.id === n.id)).map(n => ({ id: n.id, label: n.label, addedAt: at }))]
      : this.config.privateNetworks.filter(p => !ids.has(p.id))
    if (networks.length === before && trust) return
    this.config = { ...this.config, privateNetworks: networks }
    this.save()
    this.tracker.invalidate()
    this.log(`[remote-access] ${trust ? 'marked private' : 'no longer private'}: ${read.current.map(n => n.label).join(', ')}`)
    this.emit({ type: 'networks_changed', reason: trust ? 'trusted' : 'untrusted' })
    if (this.enabled) await this.apply({ force: true })
  }

  createDevice(label: string, createdBy: 'studio' | 'cli', origin: 'paired' | 'token' = 'token'): { device: RemoteDevice; token: string } {
    if (this.store.problem) throw new RemoteAccessError(this.store.problem, 503, 'devices_unreadable')
    const { device, token } = this.store.create({ label, origin, createdBy })
    this.log(`[remote-access] device added: "${label}" (${device.id}, ${origin === 'paired' ? 'paired' : 'token'}, by ${createdBy})`)
    this.emit({ type: 'device_added', deviceId: device.id, label })
    return { device: this.deviceView(device), token }
  }

  async revokeDevice(id: string): Promise<{ device: RemoteDevice; closedSessions: number; closedConnections: number }> {
    if (this.store.problem) throw new RemoteAccessError(this.store.problem, 503, 'devices_unreadable')
    const view = this.store.get(id) ? this.deviceView(this.store.get(id) as DeviceRecord) : null
    const device = this.store.revoke(id)
    if (!device || !view) throw new RemoteAccessError(`No device ${id} on this computer.`, 404, 'device_not_found')
    const closedSessions = (await this.opts.sessions?.()?.endDeviceSessions(id, 'device_revoked')) ?? 0
    const conn = this.connections.get(id)
    let closedConnections = 0
    for (const socket of conn?.sockets ?? []) { socket.destroy(); closedConnections++ }
    this.connections.delete(id)
    this.log(`[remote-access] revoked ${id} "${device.label}": closed ${closedSessions} session(s), ${closedConnections} connection(s)`)
    this.emit({ type: 'device_revoked', deviceId: id, label: device.label })
    return { device: { ...view, connected: false, connections: 0, sessions: 0 }, closedSessions, closedConnections }
  }

  openPairing(): PairingWindowView {
    if (!this.enabled) throw new RemoteAccessError('Remote access is off on this computer. Turn it on first.', 409, 'remote_access_off')
    if (this.store.problem) throw new RemoteAccessError(this.store.problem, 503, 'devices_unreadable')
    return this.pairing.open()
  }

  closePairing(): void {
    this.pairing.close('cancelled')
  }

  decideClaim(claimId: string, allow: boolean, decidedBy: 'studio' | 'cli'): { state: 'approved'; device: RemoteDevice } | { state: 'denied' } {
    let added: RemoteDevice | null = null
    try {
      const result = this.pairing.decide(claimId, allow, (claim) => {
        const { device, token } = this.createDevice(claim.deviceName, decidedBy, 'paired')
        added = device
        return { token, device: { id: device.id, label: device.label }, daemon: { name: this.computerName, fingerprint: this.fingerprint ?? '', urls: this.urls(this.addressViews()) } }
      })
      if (result.state === 'denied') {
        this.log(`[remote-access] pairing request ${claimId.slice(0, 6)}… denied by the owner`)
        return { state: 'denied' }
      }
      return { state: 'approved', device: added as unknown as RemoteDevice }
    } catch (err) {
      if (err instanceof PairingError) throw new RemoteAccessError(err.message, err.status, err.code, err.extra)
      throw err
    }
  }

  private addressViews(): RemoteAddress[] {
    const listening = new Set(this.listeners?.addresses() ?? [])
    return this.candidates.map(c => ({ address: c.address, family: c.family, kind: c.kind, iface: c.iface, network: c.network, listening: listening.has(c.address), problem: null }))
  }

  async setTailscaleServe(enabled: boolean): Promise<{ tailscale: RemoteAccessStatus['tailscale']; output: string }> {
    const command = `tailscale ${this.tailscale.serveCommand(this.port, enabled).join(' ')}`
    let output: string
    try {
      this.log(`[remote-access] running ${command} (confirmed by the owner)`)
      output = await this.tailscale.setServe(this.port, enabled)
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      this.log(`[remote-access] ${command} failed: ${text}`)
      throw new RemoteAccessError(`${command} failed: ${text}`, 502, 'tailscale_failed', { output: text, command })
    }
    this.tailscaleAt = 0
    await this.apply({ force: true })
    const status = await this.status()
    this.log(`[remote-access] tailscale serve is ${status.tailscale.serve}${status.tailscale.httpsUrl ? ` at ${status.tailscale.httpsUrl}` : ''}`)
    this.emit({ type: 'addresses_changed' })
    return { tailscale: status.tailscale, output }
  }

  // --- unauthenticated: hello and pairing -------------------------------------------

  private requireOn(): void {
    if (!this.enabled || !this.config.daemonId) throw new RemoteAccessError('Remote access is off on this computer.', 404, 'remote_access_off')
  }

  async hello(raw: IncomingMessage): Promise<RemoteHello> {
    this.requireOn()
    const { key } = await this.caller(raw, { whois: false })
    const now = this.now()
    const hits = (this.helloHits.get(key) ?? []).filter(t => now - t < 60_000)
    if (hits.length >= HELLO_PER_MINUTE) throw new RemoteAccessError('Too many requests from this address. Wait a minute.', 429, 'rate_limited', { retryAfter: Math.ceil((60_000 - (now - hits[0])) / 1000) })
    hits.push(now)
    this.helloHits.set(key, hits)
    return { v: 1, name: this.computerName, fingerprint: this.fingerprint as string, pairingOpen: this.pairing.isOpen, clientApiVersion: this.opts.clientApiVersion }
  }

  async claim(raw: IncomingMessage, body: { code: string; deviceName: string; clientKind: 'studio' | 'cli' }): Promise<PairClaimAccepted> {
    this.requireOn()
    const { key, address, via, tailnetLogin } = await this.caller(raw, { whois: true })
    try {
      const accepted = this.pairing.claim({ ...body, source: key, address, via, tailnetLogin })
      return { claimId: accepted.claimId, expiresAt: accepted.expiresAt, collectSecret: accepted.collectSecret }
    } catch (err) {
      if (err instanceof PairingError) {
        this.log(`[remote-access] pairing claim from ${address} ("${body.deviceName}") refused: ${err.code}`)
        throw new RemoteAccessError(err.message, err.status, err.code, err.extra)
      }
      throw err
    }
  }

  async poll(claimId: string, collectSecret: string, waitMs: number): Promise<PairClaimResult> {
    const result = await this.pairing.poll(claimId, collectSecret, waitMs)
    if (!result) throw new RemoteAccessError('No such pairing request (it expired, was collected, or the window closed).', 404, 'claim_not_found')
    return result
  }
}
