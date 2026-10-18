/**
 * What this computer can read about its networks without a permission
 * prompt (docs/design/remote-access.md §3.3.1, owner decision 2026-10-18 b):
 * each LAN interface's default gateway (IP and MAC), the Wi-Fi name where a
 * plain command gives it (Linux), and Windows' network category, which is
 * only shown (a warning on a Public network), never consent.
 *
 * All commands run asynchronously with a timeout; parsers are pure.
 */

import { execFile } from 'node:child_process'
import { createSocket } from 'node:dgram'
import { readFile } from 'node:fs/promises'

export type Exec = (file: string, args: string[], opts?: { timeoutMs?: number }) => Promise<string>

export const defaultExec: Exec = (file, args, opts = {}) => new Promise((resolve, reject) => {
  execFile(file, args, { windowsHide: true, timeout: opts.timeoutMs ?? 5_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
    if (err) reject(err)
    else resolve(String(stdout))
  })
})

// --- Windows ------------------------------------------------------------------

/** `Get-NetConnectionProfile | Select InterfaceAlias,NetworkCategory | ConvertTo-Json`: one object or an array; the category as a number (PS 5.1) or a name. */
export function parseWindowsProfiles(json: string): Map<string, 'private' | 'public'> {
  const out = new Map<string, 'private' | 'public'>()
  const text = json.trim()
  if (!text) return out
  const parsed = JSON.parse(text) as unknown
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const alias = (row as { InterfaceAlias?: unknown }).InterfaceAlias
    const category = (row as { NetworkCategory?: unknown }).NetworkCategory
    if (typeof alias !== 'string') continue
    const isPrivate = category === 1 || category === 2 || category === 'Private' || category === 'DomainAuthenticated'
    // A Public profile on the same alias wins over a private one (fail closed).
    if (out.get(alias) === 'public') continue
    out.set(alias, isPrivate ? 'private' : 'public')
  }
  return out
}

const WINDOWS_PROFILE_COMMAND = 'Get-NetConnectionProfile | Select-Object InterfaceAlias,NetworkCategory | ConvertTo-Json -Compress'

// --- macOS / Linux: the default gateway ------------------------------------------

/** `netstat -rn -f inet` (macOS): `default  192.168.1.1  UGScg  en0` → en0 → 192.168.1.1 (the first default per interface). */
export function parseDarwinDefaultRoutes(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/)
    if (cols[0] !== 'default' || cols.length < 4) continue
    const gateway = cols[1]
    const iface = cols[3]
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(gateway)) continue
    if (!out.has(iface)) out.set(iface, gateway)
  }
  return out
}

/** `arp -an` (macOS): `? (192.168.1.1) at a4:2b:b0:1:2:3 on en0 ifscope [ethernet]` → `en0|192.168.1.1` → normalized MAC. */
export function parseDarwinArp(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const match = /\((\d{1,3}(?:\.\d{1,3}){3})\) at ([0-9a-f:]+) on (\S+)/i.exec(line)
    if (!match) continue
    out.set(`${match[3]}|${match[1]}`, normalizeMac(match[2]))
  }
  return out
}

/** `/proc/net/route`: default rows (Destination 00000000), the gateway in little-endian hex. */
export function parseLinuxRoutes(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of text.split(/\r?\n/).slice(1)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 3 || cols[1] !== '00000000' || cols[2] === '00000000') continue
    const hex = cols[2]
    if (!/^[0-9A-Fa-f]{8}$/.test(hex)) continue
    const bytes = [hex.slice(6, 8), hex.slice(4, 6), hex.slice(2, 4), hex.slice(0, 2)].map(h => Number.parseInt(h, 16))
    if (!out.has(cols[0])) out.set(cols[0], bytes.join('.'))
  }
  return out
}

/** `/proc/net/arp`: `IP HWtype Flags HWaddress Mask Device` → `device|ip` → MAC. */
export function parseLinuxArp(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of text.split(/\r?\n/).slice(1)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 6 || cols[3] === '00:00:00:00:00:00') continue
    out.set(`${cols[5]}|${cols[0]}`, normalizeMac(cols[3]))
  }
  return out
}

function normalizeMac(mac: string): string {
  return mac.toLowerCase().split(':').map(part => part.padStart(2, '0')).join(':')
}

// --- Windows: default gateways (cheap; the category itself needs PowerShell) -----

/**
 * `route print -4 0.0.0.0`: `0.0.0.0  0.0.0.0  <gateway>  <interface IP>  <metric>`
 * rows → interface IP → gateway (the first per interface IP).
 */
export function parseWindowsRoutes(text: string): Map<string, string> {
  const out = new Map<string, string>()
  const ipv4 = /^\d{1,3}(\.\d{1,3}){3}$/
  for (const line of text.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 5 || cols[0] !== '0.0.0.0' || cols[1] !== '0.0.0.0') continue
    if (!ipv4.test(cols[2]) || !ipv4.test(cols[3])) continue
    if (!out.has(cols[3])) out.set(cols[3], cols[2])
  }
  return out
}

/** `arp -a`: `Interface: <ip> --- 0x7` blocks of `<ip>  aa-bb-cc-dd-ee-ff  dynamic` → `<interface IP>|<ip>` → MAC. */
export function parseWindowsArp(text: string): Map<string, string> {
  const out = new Map<string, string>()
  let iface: string | null = null
  for (const line of text.split(/\r?\n/)) {
    const head = /^Interface:\s+(\d{1,3}(?:\.\d{1,3}){3})\b/.exec(line.trim())
    if (head) { iface = head[1]; continue }
    const row = /^(\d{1,3}(?:\.\d{1,3}){3})\s+([0-9a-f]{2}(?:-[0-9a-f]{2}){5})\s/i.exec(line.trim() + ' ')
    if (row && iface) out.set(`${iface}|${row[1]}`, row[2].toLowerCase().replace(/-/g, ':'))
  }
  return out
}

/**
 * The network each of `ifaces` is on, as `<gateway IP>|<gateway MAC>` ('' when
 * unknown), read every address check (security review item 2): a network can
 * change while the interface name and even its address stay the same (another
 * router on the same subnet). Cheap reads only: /proc on Linux, netstat and arp
 * on macOS, route and arp on Windows. Never throws.
 */
export async function readGatewayIdentities(
  ifaces: readonly string[],
  interfaces: NodeJS.Dict<{ address: string; family: string | number; internal: boolean }[]>,
  deps: CategoryReaderDeps = {},
): Promise<Map<string, string>> {
  const platform = deps.platform ?? process.platform
  const exec = deps.exec ?? defaultExec
  const readText = deps.readText ?? ((path: string) => readFile(path, 'utf-8'))
  const probe = deps.probe ?? udpProbe
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const out = new Map<string, string>()
  for (const iface of ifaces) out.set(iface, '')
  if (ifaces.length === 0) return out
  try {
    // 1. Each interface's default gateway, and the address the probe leaves from.
    const targets: Array<{ iface: string; gateway: string; from: string | null; arpKey: string }> = []
    const ipv4 = (iface: string) => (interfaces[iface] ?? []).find((i) => !i.internal && (i.family === 'IPv4' || i.family === 4))?.address ?? null
    if (platform === 'win32') {
      const routes = parseWindowsRoutes(await exec('route', ['print', '-4', '0.0.0.0']))
      for (const iface of ifaces) {
        for (const info of interfaces[iface] ?? []) {
          const gateway = routes.get(info.address)
          if (!gateway) continue
          targets.push({ iface, gateway, from: info.address, arpKey: `${info.address}|${gateway}` })
          break
        }
      }
    } else {
      const routes = platform === 'darwin'
        ? parseDarwinDefaultRoutes(await exec('netstat', ['-rn', '-f', 'inet']))
        : parseLinuxRoutes(await readText('/proc/net/route'))
      for (const iface of ifaces) {
        const gateway = routes.get(iface)
        if (gateway) targets.push({ iface, gateway, from: ipv4(iface), arpKey: `${iface}|${gateway}` })
      }
    }
    const readArp = async () => platform === 'win32'
      ? parseWindowsArp(await exec('arp', ['-a']))
      : platform === 'darwin' ? parseDarwinArp(await exec('arp', ['-an'])) : parseLinuxArp(await readText('/proc/net/arp'))
    // 2. Probe before every read of the table (final check): the MAC must come from this check, never an
    //    earlier one. A gateway that answers is identified; one that gives no MAC after the tries is not.
    let pending = targets
    for (let attempt = 0; attempt < ARP_PROBE_TRIES && pending.length > 0; attempt++) {
      if (attempt > 0) await sleep(ARP_PROBE_WAIT_MS)
      await Promise.all(pending.map((t) => probe(t.gateway, t.from).catch(() => {})))
      const arp = await readArp()
      const missing: typeof targets = []
      for (const t of pending) {
        const mac = arp.get(t.arpKey)
        out.set(t.iface, `${t.gateway}|${mac ?? ''}`)
        if (!mac) missing.push(t)
      }
      pending = missing
    }
  } catch {
    // Unknown gateways: the network is unidentified, and an unidentified network never matches consent.
  }
  return out
}

export interface CategoryReaderDeps {
  platform?: NodeJS.Platform
  exec?: Exec
  readText?: (path: string) => Promise<string>
  /** Make the OS resolve the gateway's MAC (default: one UDP datagram from `from` to the gateway's discard port 9). */
  probe?: (gateway: string, from: string | null) => Promise<void>
  sleep?: (ms: number) => Promise<void>
}

/** ARP probe tries per check, and the wait after each (final check: fail closed, but not on a slow answer). */
export const ARP_PROBE_TRIES = 3
export const ARP_PROBE_WAIT_MS = 200

/**
 * One UDP datagram to the gateway's discard port (9): the OS must resolve
 * the gateway's MAC to send it, so a live gateway answers ARP and its entry
 * is fresh when the table is read. Nothing listens for a reply; errors are
 * ignored (no route, or the address just went away).
 */
export function udpProbe(gateway: string, from: string | null): Promise<void> {
  return new Promise((resolve) => {
    let done = false
    const socket = createSocket('udp4')
    const finish = () => {
      if (done) return
      done = true
      try { socket.close() } catch { /* closed */ }
      resolve()
    }
    socket.on('error', finish)
    const send = () => socket.send(Buffer.from([0]), 9, gateway, () => finish())
    try {
      if (from) socket.bind({ address: from, port: 0, exclusive: true }, send)
      else send()
    } catch {
      finish()
    }
    setTimeout(finish, 500).unref?.()
  })
}

/**
 * Windows' category of each of `ifaces` (Get-NetConnectionProfile, no
 * elevation); an empty map elsewhere or on a failure. Shown only: a Public
 * or unknown network gets the warning line; it never allows or refuses.
 */
export async function readOsCategories(ifaces: readonly string[], deps: CategoryReaderDeps = {}): Promise<Map<string, 'private' | 'public'>> {
  const platform = deps.platform ?? process.platform
  const exec = deps.exec ?? defaultExec
  if (platform !== 'win32' || ifaces.length === 0) return new Map()
  try {
    const profiles = parseWindowsProfiles(await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROFILE_COMMAND], { timeoutMs: 10_000 }))
    return new Map(ifaces.filter(i => profiles.has(i)).map(i => [i, profiles.get(i)!]))
  } catch {
    return new Map()
  }
}

/**
 * The Wi-Fi name (SSID) of each of `ifaces` where reading it never asks for
 * a permission:
 * - Linux: `iwgetid <iface> -r`.
 * - macOS: `ipconfig getsummary <iface>` (`SSID : <name>`). It never prompts;
 *   macOS 14.4 and later answer `<redacted>` without location access, which
 *   counts as no name.
 * - Windows: none. The WLAN API (netsh, WlanQueryInterface) needs location
 *   access and Windows 11 24H2 may ask for it; the connection profile's name
 *   needs PowerShell (too slow for every check) and the user can rename it.
 */
export async function readWifiNames(ifaces: readonly string[], deps: CategoryReaderDeps = {}): Promise<Map<string, string>> {
  const platform = deps.platform ?? process.platform
  const exec = deps.exec ?? defaultExec
  const out = new Map<string, string>()
  if (platform !== 'linux' && platform !== 'darwin') return out
  for (const iface of ifaces) {
    try {
      const ssid = platform === 'linux'
        ? (await exec('iwgetid', [iface, '-r'], { timeoutMs: 2_000 })).trim()
        : parseDarwinSummarySsid(await exec('ipconfig', ['getsummary', iface], { timeoutMs: 2_000 }))
      if (ssid) out.set(iface, ssid)
    } catch { /* wired, or no tool: no name */ }
  }
  return out
}

/** `ipconfig getsummary` (macOS): the `SSID : <name>` line; `<redacted>` or none → null. */
export function parseDarwinSummarySsid(text: string): string | null {
  const match = /^\s*SSID\s*:\s*(.+?)\s*$/m.exec(text)
  if (!match || match[1] === '<redacted>') return null
  return match[1]
}
