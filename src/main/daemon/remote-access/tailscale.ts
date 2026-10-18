/**
 * The local Tailscale client, read through its CLI (docs/design/remote-access.md
 * §3.3, §5.7): which addresses are this machine's tailnet addresses, its
 * MagicDNS name, whether `tailscale serve` forwards https to the daemon, and
 * a peer's login (`whois`). Nothing here changes Tailscale's configuration
 * except setServe, which the owner confirms first (management route).
 */

import { defaultExec, type Exec } from './network-category'

const CANDIDATES = process.platform === 'win32'
  ? ['tailscale', 'C:\\Program Files\\Tailscale\\tailscale.exe']
  : ['tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']

/** A missing binary is looked for again after this long. */
const ABSENT_RECHECK_MS = 5 * 60_000

export interface TailscaleSelf {
  state: 'absent' | 'stopped' | 'running'
  ips: string[]
  /** MagicDNS FQDN without the trailing dot, or null. */
  dnsName: string | null
}

export interface TailscaleServe {
  serve: 'on' | 'off' | 'unknown'
  httpsUrl: string | null
}

/** `tailscale status --json` → state, `Self.TailscaleIPs`, `Self.DNSName`. */
export function parseTailscaleStatus(json: string): TailscaleSelf {
  const status = JSON.parse(json) as { BackendState?: unknown; Self?: { TailscaleIPs?: unknown; DNSName?: unknown } }
  const running = status.BackendState === 'Running'
  const ips = Array.isArray(status.Self?.TailscaleIPs) ? status.Self.TailscaleIPs.filter((ip): ip is string => typeof ip === 'string').map(ip => ip.toLowerCase()) : []
  const dns = typeof status.Self?.DNSName === 'string' ? status.Self.DNSName.replace(/\.$/, '') : ''
  return { state: running ? 'running' : 'stopped', ips: running ? ips : [], dnsName: running && dns ? dns : null }
}

/**
 * `tailscale serve status --json`: `Web` maps `host:port` to handlers whose
 * `Proxy` is the target. On when a handler proxies to this daemon's loopback port.
 */
export function parseServeStatus(json: string, port: number): TailscaleServe {
  const text = json.trim()
  if (!text || text === '{}' || text === 'null') return { serve: 'off', httpsUrl: null }
  const status = JSON.parse(text) as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: unknown }> }> }
  for (const [hostPort, web] of Object.entries(status.Web ?? {})) {
    for (const handler of Object.values(web.Handlers ?? {})) {
      const proxy = typeof handler.Proxy === 'string' ? handler.Proxy : ''
      if (new RegExp(`^(https?://)?(127\\.0\\.0\\.1|localhost):${port}/?$`).test(proxy)) {
        const [host, p] = [hostPort.slice(0, hostPort.lastIndexOf(':')), hostPort.slice(hostPort.lastIndexOf(':') + 1)]
        return { serve: 'on', httpsUrl: p === '443' ? `https://${host}` : `https://${host}:${p}` }
      }
    }
  }
  return { serve: 'off', httpsUrl: null }
}

export class TailscaleClient {
  private bin: string | null | undefined
  private absentUntil = 0

  constructor(private readonly exec: Exec = defaultExec, private readonly now: () => number = Date.now) {}

  private async run(args: string[], timeoutMs = 5_000): Promise<string | null> {
    if (this.bin === null && this.now() < this.absentUntil) return null
    if (this.bin) return await this.exec(this.bin, args, { timeoutMs })
    for (const candidate of CANDIDATES) {
      try {
        const out = await this.exec(candidate, args, { timeoutMs })
        this.bin = candidate
        return out
      } catch (err) {
        // ENOENT: try the next candidate. Anything else: the binary exists and failed.
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          this.bin = candidate
          throw err
        }
      }
    }
    this.bin = null
    this.absentUntil = this.now() + ABSENT_RECHECK_MS
    return null
  }

  get command(): string | null {
    return this.bin ?? null
  }

  async self(): Promise<TailscaleSelf> {
    try {
      const out = await this.run(['status', '--json'])
      return out === null ? { state: 'absent', ips: [], dnsName: null } : parseTailscaleStatus(out)
    } catch {
      // Installed but not running or logged out: `status` exits non-zero.
      return { state: 'stopped', ips: [], dnsName: null }
    }
  }

  async serveStatus(port: number): Promise<TailscaleServe> {
    try {
      const out = await this.run(['serve', 'status', '--json'])
      return out === null ? { serve: 'unknown', httpsUrl: null } : parseServeStatus(out, port)
    } catch {
      return { serve: 'unknown', httpsUrl: null }
    }
  }

  serveCommand(port: number, enabled: boolean): string[] {
    return enabled ? ['serve', '--bg', String(port)] : ['serve', '--https=443', 'off']
  }

  /** Run `tailscale serve` (on) or remove the https:443 entry when it forwards to this daemon (off). Returns the command's output; throws with it. */
  async setServe(port: number, enabled: boolean): Promise<string> {
    if (!enabled) {
      const current = await this.serveStatus(port)
      if (current.serve !== 'on') return 'tailscale serve does not forward to this daemon; nothing changed.'
      if (current.httpsUrl && /:\d+$/.test(current.httpsUrl.replace(/^https:\/\//, ''))) {
        throw new Error(`tailscale serve forwards ${current.httpsUrl} to this daemon on a port other than 443; remove it with the tailscale CLI.`)
      }
    }
    const out = await this.run(this.serveCommand(port, enabled), 20_000)
    if (out === null) throw new Error('Tailscale is not installed on this computer.')
    return out.trim()
  }

  /** The Tailscale login of a tailnet peer, or null. */
  async whois(address: string): Promise<string | null> {
    try {
      const out = await this.run(['whois', '--json', address])
      if (!out) return null
      const parsed = JSON.parse(out) as { UserProfile?: { LoginName?: unknown } }
      return typeof parsed.UserProfile?.LoginName === 'string' ? parsed.UserProfile.LoginName : null
    } catch {
      return null
    }
  }
}
