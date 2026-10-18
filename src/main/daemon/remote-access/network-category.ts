/**
 * Private or public network, per interface (docs/design/remote-access.md
 * §3.3.1, owner decision O2). The daemon never listens on a network that is
 * not marked private.
 *
 * - Windows: the OS's NetConnectionProfile category (`Get-NetConnectionProfile`,
 *   no elevation). Private and DomainAuthenticated are private; Public, an
 *   interface without a profile, or a failed query are public.
 * - macOS, Linux: no OS category exists. A network is identified by the
 *   interface's default gateway (IP and MAC address); it is private only when
 *   the owner marked it so (`privateNetworks` in remote-access.json). No
 *   gateway, no MAC, a failed read, or an unlisted network: public.
 *
 * All commands run asynchronously with a timeout; parsers are pure.
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { PrivateNetwork } from './config'

export type Exec = (file: string, args: string[], opts?: { timeoutMs?: number }) => Promise<string>

export const defaultExec: Exec = (file, args, opts = {}) => new Promise((resolve, reject) => {
  execFile(file, args, { windowsHide: true, timeout: opts.timeoutMs ?? 5_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
    if (err) reject(err)
    else resolve(String(stdout))
  })
})

export interface CurrentNetwork {
  iface: string
  id: string
  label: string
}

export interface NetworkCategories {
  categories: Map<string, 'private' | 'public'>
  /** macOS/Linux: the identified networks of the given interfaces (the ones trustNetwork marks). */
  current: CurrentNetwork[]
  /** Why the categories could not be read (everything is then public); null when fine. */
  problem: string | null
}

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

// --- macOS / Linux: the default gateway's identity ------------------------------

export function networkId(gatewayIp: string, gatewayMac: string): string {
  return createHash('sha256').update(`${gatewayIp}|${gatewayMac.toLowerCase()}`, 'utf-8').digest('hex').slice(0, 16)
}

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

/** The identified networks of `ifaces`, from the default routes and the ARP table. */
export function currentNetworks(ifaces: readonly string[], routes: Map<string, string>, arp: Map<string, string>): CurrentNetwork[] {
  const out: CurrentNetwork[] = []
  for (const iface of ifaces) {
    const gateway = routes.get(iface)
    if (!gateway) continue
    const mac = arp.get(`${iface}|${gateway}`)
    if (!mac) continue
    out.push({ iface, id: networkId(gateway, mac), label: `${iface} via ${gateway}` })
  }
  return out
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
  const out = new Map<string, string>()
  for (const iface of ifaces) out.set(iface, '')
  if (ifaces.length === 0) return out
  try {
    if (platform === 'win32') {
      const routes = parseWindowsRoutes(await exec('route', ['print', '-4', '0.0.0.0']))
      const arp = parseWindowsArp(await exec('arp', ['-a']))
      for (const iface of ifaces) {
        for (const info of interfaces[iface] ?? []) {
          const gateway = routes.get(info.address)
          if (!gateway) continue
          out.set(iface, `${gateway}|${arp.get(`${info.address}|${gateway}`) ?? ''}`)
          break
        }
      }
      return out
    }
    let routes: Map<string, string>
    let arp: Map<string, string>
    if (platform === 'darwin') {
      routes = parseDarwinDefaultRoutes(await exec('netstat', ['-rn', '-f', 'inet']))
      arp = parseDarwinArp(await exec('arp', ['-an']))
    } else {
      routes = parseLinuxRoutes(await readText('/proc/net/route'))
      arp = parseLinuxArp(await readText('/proc/net/arp'))
    }
    for (const iface of ifaces) {
      const gateway = routes.get(iface)
      if (gateway) out.set(iface, `${gateway}|${arp.get(`${iface}|${gateway}`) ?? ''}`)
    }
  } catch {
    // Unknown gateways: the key still changes with the addresses, and an unknown network is never private.
  }
  return out
}

export interface CategoryReaderDeps {
  platform?: NodeJS.Platform
  exec?: Exec
  readText?: (path: string) => Promise<string>
}

/**
 * The category of each of `ifaces` (the LAN interfaces with a private
 * address). Never throws: a failure makes every interface public and says why.
 */
export async function readNetworkCategories(ifaces: readonly string[], trusted: readonly PrivateNetwork[], deps: CategoryReaderDeps = {}): Promise<NetworkCategories> {
  const platform = deps.platform ?? process.platform
  const exec = deps.exec ?? defaultExec
  const readText = deps.readText ?? ((path: string) => readFile(path, 'utf-8'))
  const categories = new Map<string, 'private' | 'public'>()
  for (const iface of ifaces) categories.set(iface, 'public')
  if (ifaces.length === 0) return { categories, current: [], problem: null }
  try {
    if (platform === 'win32') {
      const profiles = parseWindowsProfiles(await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROFILE_COMMAND], { timeoutMs: 10_000 }))
      for (const iface of ifaces) categories.set(iface, profiles.get(iface) ?? 'public')
      return { categories, current: [], problem: null }
    }
    let routes: Map<string, string>
    let arp: Map<string, string>
    if (platform === 'darwin') {
      routes = parseDarwinDefaultRoutes(await exec('netstat', ['-rn', '-f', 'inet']))
      arp = parseDarwinArp(await exec('arp', ['-an']))
    } else {
      routes = parseLinuxRoutes(await readText('/proc/net/route'))
      arp = parseLinuxArp(await readText('/proc/net/arp'))
    }
    const current = currentNetworks(ifaces, routes, arp)
    const ids = new Set(trusted.map(n => n.id))
    for (const network of current) if (ids.has(network.id)) categories.set(network.iface, 'private')
    return { categories, current, problem: null }
  } catch (err) {
    return {
      categories,
      current: [],
      problem: `could not read whether this network is private (${err instanceof Error ? err.message : String(err)}); treating it as public`,
    }
  }
}
