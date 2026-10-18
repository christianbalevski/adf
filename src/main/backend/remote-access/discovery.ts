import { execFile } from 'node:child_process'
import { Bonjour, type Service } from 'bonjour-service'
import { pickMdnsInterface } from '../../services/mdns-service'
import { checkRemoteDaemonUrl } from '../../../shared/utils/remote-backend-url'
import type { RemoteDiscoveryEntry, RemoteDiscoveryUpdate } from '../../../shared/types/remote-access-ipc.types'
import { PairingClient } from './client'

/**
 * Settings → Backend → Remote computer, "Found on your network"
 * (docs/design/remote-access.md §9.1): ADF daemons that allow other
 * computers, found two ways and merged by fingerprint.
 *
 * - LAN: mDNS browse of `_adf-daemon._tcp` (§5.1). The address is the one the
 *   announcement came from, as the mesh's browser does (mdns-service.ts).
 * - Tailnet: multicast does not cross WireGuard, so each online tailnet peer
 *   is asked `GET /remote/hello` on the daemon port (§5.2), every 30 s.
 *
 * Runs only while the section is open (start/stop). Nothing here sees or
 * sends a token.
 */

export const DEFAULT_DAEMON_PORT = 7385
const SERVICE_TYPE = 'adf-daemon'
const SWEEP_MS = 30_000
const HELLO_TIMEOUT_MS = 2_500

/** One `_adf-daemon._tcp` announcement, as the browser reports it. */
export interface DaemonAnnouncement {
  name: string
  port: number
  /** The address the announcement came from (preferred), else its A/AAAA records. */
  referer: string | null
  addresses: string[]
  txt: Record<string, unknown>
}

export interface MdnsBrowser {
  stop(): void
}

export interface DiscoveryDeps {
  onUpdate: (update: RemoteDiscoveryUpdate) => void
  /** The saved remote computer's fingerprint ("Already paired"). */
  pairedFingerprint: () => string | null
  /** This computer's own daemon fingerprint, left out of the list. */
  ownFingerprint?: () => string | null
  /** mDNS browse; throws when mDNS cannot start. Default: bonjour-service on the interface pickMdnsInterface chooses. */
  browse?: (handlers: { up: (a: DaemonAnnouncement) => void; down: (a: DaemonAnnouncement) => void }) => MdnsBrowser
  /** Online tailnet peers (addresses). Default: `tailscale status --json`. */
  tailnetPeers?: () => Promise<string[]>
  fetch?: typeof fetch
  port?: number
  sweepMs?: number
  log?: Pick<Console, 'log' | 'warn'>
}

interface Sighting {
  address: string
  port: number
  pairingOpen: boolean
}

interface Record_ {
  name: string
  lan: Sighting | null
  tailnet: Sighting | null
}

const PRIVATE_V4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/

/** `http://host:port` with an IPv6 literal bracketed. */
export function hostUrl(address: string, port: number): string {
  return `http://${address.includes(':') ? `[${address}]` : address}:${port}`
}

function txtString(txt: Record<string, unknown>, key: string): string | null {
  const value = txt[key]
  if (typeof value === 'string') return value
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8')
  return null
}

/** Fingerprint as the daemon shows it: `XXXX-XXXX`, base32 (§5.1; the alphabet is not pinned, so any letters and digits). */
const FINGERPRINT = /^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/

export class RemoteDiscovery {
  private records = new Map<string, Record_>()
  private browser: MdnsBrowser | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  private browsing = false
  private problem: string | null = null
  private generation = 0
  private readonly log: Pick<Console, 'log' | 'warn'>

  constructor(private readonly deps: DiscoveryDeps) {
    this.log = deps.log ?? console
  }

  get isRunning(): boolean {
    return this.running
  }

  start(): void {
    if (this.running) {
      this.emit()
      return
    }
    this.running = true
    this.generation++
    this.records.clear()
    this.problem = null
    try {
      this.browser = (this.deps.browse ?? defaultBrowse)({ up: (a) => this.onUp(a), down: (a) => this.onDown(a) })
      this.browsing = true
      this.log.log('[Remote access] Looking for ADF computers on this network (mDNS _adf-daemon._tcp, tailnet hello)')
    } catch (err) {
      this.browsing = false
      this.problem = 'Studio cannot listen for computers on this network (mDNS). Tailnet computers are still found; or enter an address.'
      this.log.warn(`[Remote access] mDNS browse failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    this.emit()
    void this.sweep(this.generation)
    this.timer = setInterval(() => void this.sweep(this.generation), this.deps.sweepMs ?? SWEEP_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    this.generation++
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    try { this.browser?.stop() } catch { /* best effort */ }
    this.browser = null
    this.browsing = false
    this.records.clear()
    this.log.log('[Remote access] Stopped looking for ADF computers')
  }

  /** The merged list, tailnet before LAN, then by name. */
  entries(): RemoteDiscoveryEntry[] {
    const paired = this.deps.pairedFingerprint()
    const own = this.deps.ownFingerprint?.() ?? null
    const out: RemoteDiscoveryEntry[] = []
    for (const [fingerprint, record] of this.records) {
      if (fingerprint === own) continue
      const best = record.tailnet ?? record.lan
      if (!best) continue
      const url = hostUrl(best.address, best.port)
      const kind = checkRemoteDaemonUrl(url).kind
      out.push({
        fingerprint,
        name: record.name,
        url,
        address: best.address,
        kind: record.tailnet ? 'tailnet' : 'lan',
        encrypted: kind === 'tailnet' || kind === 'https',
        pairingOpen: (record.tailnet?.pairingOpen ?? false) || (record.lan?.pairingOpen ?? false),
        alreadyPaired: paired === fingerprint,
      })
    }
    return out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'tailnet' ? -1 : 1))
  }

  /** Re-send the list (the saved remote changed: "Already paired"). */
  refresh(): void {
    if (this.running) this.emit()
  }

  private emit(): void {
    this.deps.onUpdate({ entries: this.entries(), browsing: this.browsing, problem: this.problem })
  }

  private onUp(a: DaemonAnnouncement): void {
    if (!this.running) return
    const fingerprint = txtString(a.txt, 'fp')
    if (!fingerprint || !FINGERPRINT.test(fingerprint) || txtString(a.txt, 'v') !== '1' || !a.port) return
    const address = a.referer ?? a.addresses.find((ip) => PRIVATE_V4.test(ip)) ?? a.addresses[0]
    if (!address) return
    const record = this.records.get(fingerprint) ?? { name: a.name, lan: null, tailnet: null }
    record.name = record.tailnet ? record.name : a.name
    record.lan = { address, port: a.port, pairingOpen: txtString(a.txt, 'pair') === '1' }
    this.records.set(fingerprint, record)
    this.emit()
  }

  private onDown(a: DaemonAnnouncement): void {
    const fingerprint = txtString(a.txt, 'fp')
    const record = fingerprint ? this.records.get(fingerprint) : undefined
    if (!fingerprint || !record) return
    record.lan = null
    if (!record.tailnet) this.records.delete(fingerprint)
    this.emit()
  }

  private async sweep(generation: number): Promise<void> {
    let peers: string[]
    try {
      peers = await (this.deps.tailnetPeers ?? defaultTailnetPeers)()
    } catch {
      peers = []
    }
    const port = this.deps.port ?? DEFAULT_DAEMON_PORT
    const found = new Map<string, { name: string; sighting: Sighting }>()
    await Promise.all(peers.map(async (address) => {
      try {
        const hello = await new PairingClient(hostUrl(address, port), this.deps.fetch).hello({ timeoutMs: HELLO_TIMEOUT_MS })
        if (hello?.v !== 1 || typeof hello.fingerprint !== 'string' || !FINGERPRINT.test(hello.fingerprint)) return
        found.set(hello.fingerprint, { name: String(hello.name || address), sighting: { address, port, pairingOpen: hello.pairingOpen === true } })
      } catch { /* no ADF daemon there, or remote access off */ }
    }))
    if (generation !== this.generation || !this.running) return
    for (const [fingerprint, record] of this.records) {
      if (found.has(fingerprint)) continue
      record.tailnet = null
      if (!record.lan) this.records.delete(fingerprint)
    }
    for (const [fingerprint, { name, sighting }] of found) {
      const record = this.records.get(fingerprint) ?? { name, lan: null, tailnet: null }
      record.name = name
      record.tailnet = sighting
      this.records.set(fingerprint, record)
    }
    this.emit()
  }
}

function defaultBrowse(handlers: { up: (a: DaemonAnnouncement) => void; down: (a: DaemonAnnouncement) => void }): MdnsBrowser {
  const iface = pickMdnsInterface()
  // As MdnsService: membership on the picked interface, reception on all addresses.
  const bonjour = new Bonjour((iface ? { interface: iface, bind: '0.0.0.0' } : undefined) as never)
  const toAnnouncement = (service: Service): DaemonAnnouncement => ({
    name: service.name,
    port: service.port,
    referer: (service as unknown as { referer?: { address?: string } }).referer?.address ?? null,
    addresses: (service.addresses ?? []) as string[],
    txt: (service.txt ?? {}) as Record<string, unknown>,
  })
  const browser = bonjour.find({ type: SERVICE_TYPE, protocol: 'tcp' })
  browser.on('up', (service: Service) => handlers.up(toAnnouncement(service)))
  browser.on('down', (service: Service) => handlers.down(toAnnouncement(service)))
  return {
    stop: () => {
      try { browser.stop() } catch { /* best effort */ }
      try { bonjour.destroy() } catch { /* best effort */ }
    },
  }
}

const TAILSCALE_CANDIDATES = process.platform === 'win32'
  ? ['tailscale', 'C:\\Program Files\\Tailscale\\tailscale.exe']
  : ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale']

function execOut(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout) => err ? reject(err) : resolve(stdout))
  })
}

/** Online tailnet peers' first address (IPv4 preferred), from `tailscale status --json`; [] without Tailscale. */
export async function defaultTailnetPeers(): Promise<string[]> {
  for (const bin of TAILSCALE_CANDIDATES) {
    let out: string
    try {
      out = await execOut(bin, ['status', '--json'], 5_000)
    } catch {
      continue
    }
    try {
      const status = JSON.parse(out) as { Peer?: Record<string, { TailscaleIPs?: string[]; Online?: boolean }> }
      return Object.values(status.Peer ?? {})
        .filter((p) => p.Online !== false)
        .map((p) => (p.TailscaleIPs ?? []).find((ip) => ip.includes('.')) ?? p.TailscaleIPs?.[0] ?? '')
        .filter((ip) => ip.length > 0)
    } catch {
      return []
    }
  }
  return []
}
