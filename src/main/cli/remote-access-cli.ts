/**
 * The host side of remote access in the terminal (docs/design/remote-access.md
 * §9.2): `adf daemon remote`, `adf daemon devices`, `adf daemon pair`. They
 * talk to this machine's daemon only, with its token file and local proof
 * (the management routes refuse anything else).
 */

import type { PairingWindowView, RemoteAccessStatus, RemoteDevice } from '../../shared/types/remote-access.types'
import { readDaemonToken } from '../daemon/daemon-token'
import { readLocalProof } from '../daemon/local-access'
import { DEFAULT_DAEMON_PORT } from './daemon-url'

export interface HostCliIo {
  fetch: typeof fetch
  stdout(text: string): void
  stderr(text: string): void
  prompt(question: string): Promise<string | null>
  /** Calls fn on Ctrl+C until the returned stop is called. */
  onInterrupt?(fn: () => void): () => void
  sleep?(ms: number): Promise<void>
}

export interface HostTarget {
  url: string
  port: number
  dataDir: string
}

export const REMOTE_USAGE = `Usage: adf daemon remote on [--name <name>] | off | status [--json]
       adf daemon remote allow-network [<id|label>]   Allow on this network (default: the one network not allowed)
       adf daemon remote forget-network <id|label>    Remove an allowed network; its listeners close now
       adf daemon remote serve on | off      https through tailscale serve
       adf daemon devices [list] [--json]
       adf daemon devices add <label>        Print a new device token (shown once)
       adf daemon devices revoke <id|label>  Disconnect that computer and void its token
       adf daemon pair                       Open a pairing window and show its code

Remote access: devices you pair or add use this computer's ADF daemon (no
restart; agents keep running). It listens only on private and Tailscale
addresses, and only on a network you allowed (once per network; the mesh's LAN
mode uses the same list). A device token gives full control of this
computer's agents: it is as powerful as your owner seed phrase.`

class ManageError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null) { super(message) }
}

async function call<T>(io: HostCliIo, target: HostTarget, method: string, path: string, body?: unknown): Promise<T> {
  const token = readDaemonToken(target.dataDir)
  const proof = readLocalProof(target.dataDir, target.port)
  const res = await io.fetch(`${target.url}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(proof ? { 'X-ADF-Local-Proof': proof } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  const parsed = text ? JSON.parse(text) as Record<string, unknown> : {}
  if (!res.ok) {
    const code = typeof parsed.code === 'string' ? parsed.code : null
    const message = typeof parsed.error === 'string' ? parsed.error : `HTTP ${res.status}`
    throw new ManageError(res.status === 404 && (code === null || code === 'not_found')
      ? `The ADF daemon at ${target.url} does not support remote access. Update it (adf daemon restart after updating adf).`
      : message, res.status, code)
  }
  return parsed as T
}

function ago(iso: string | null): string {
  if (!iso) return 'never'
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  if (s < 60) return `${s} s ago`
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86_400)} d ago`
}

export function formatDevices(devices: RemoteDevice[]): string {
  if (devices.length === 0) return 'No computers yet. Pair one: adf daemon pair (or adf daemon devices add <label>).\n'
  const rows = devices.map(d => [d.id, d.label, d.origin === 'paired' ? 'paired' : 'token', d.connected ? 'connected now' : `last seen ${ago(d.lastSeenAt)}${d.lastSeenAddress ? ` from ${d.lastSeenAddress}` : ''}`])
  const widths = [0, 1, 2].map(i => Math.max(...rows.map(r => r[i].length), ['id', 'label', 'kind'][i].length))
  const line = (r: string[]) => `${r.slice(0, 3).map((c, i) => c.padEnd(widths[i])).join('  ')}  ${r[3]}`.trimEnd()
  return `${[line(['id', 'label', 'kind', 'status']), ...rows.map(line)].join('\n')}\n`
}

export function formatRemoteStatus(s: RemoteAccessStatus): string {
  const lines: string[] = []
  lines.push(`Remote access: ${s.enabled ? 'on' : 'off'}`)
  // Off says it once; every other state has its own line (listening, paused, no address, not listening).
  if (s.state !== 'off') lines.push(s.message)
  if (s.problem) lines.push(`Problem: ${s.problem}`)
  lines.push(`Name: ${s.name}${s.fingerprint ? `   Fingerprint: ${s.fingerprint}` : ''}`)
  if (s.urls.length) {
    lines.push('Addresses:')
    for (const u of s.urls) lines.push(`  ${u.url}  ${u.encrypted ? 'encrypted' : 'not encrypted'}${u.kind === 'tailscale-https' ? ' (tailscale serve)' : u.kind === 'tailnet' ? ' (tailnet)' : ''}`)
  }
  for (const a of s.addresses.filter(x => !x.listening)) lines.push(`Not listening on ${a.address} (${a.iface}): ${a.problem ?? 'not available'}`)
  if (s.networks.length) {
    lines.push('Networks now:')
    for (const n of s.networks) {
      const warn = n.kind === 'lan' && !n.allowed && n.osCategory !== 'private' ? ' Public network. The token is sent unencrypted.' : ''
      lines.push(`  ${n.label}  ${n.allowed ? 'allowed' : n.id ? `not allowed (allow: adf daemon remote allow-network ${n.id})${warn}` : 'not allowed (its router did not answer)'}`)
    }
  }
  lines.push(`Allowed networks (${s.allowedNetworks.length}):`)
  for (const n of s.allowedNetworks) lines.push(`  ${n.id}  ${n.label}`)
  if (s.enabled) {
    if (s.tailscale.state === 'running') {
      lines.push(`Tailscale: https through tailscale serve is ${s.tailscale.serve}${s.tailscale.httpsUrl ? ` at ${s.tailscale.httpsUrl}` : s.tailscale.serve === 'off' ? ' (turn on: adf daemon remote serve on)' : ''}`)
    }
    lines.push(`mDNS: ${s.mdns.announcing ? 'announcing' : `not announcing${s.mdns.problem ? ` (${s.mdns.problem})` : ''}`}`)
    lines.push(`Firewall: ${s.firewall.message}`)
    for (const c of s.firewall.commands) lines.push(`  ${c}`)
  }
  if (s.pairing) lines.push(`Pairing window open until ${new Date(s.pairing.expiresAt).toLocaleTimeString()}${s.pairing.claim ? `; "${s.pairing.claim.deviceName}" is waiting for your answer (adf daemon pair)` : ''}`)
  lines.push(`Computers (${s.devices.length}):`)
  lines.push(formatDevices(s.devices).trimEnd().split('\n').map(l => `  ${l}`).join('\n'))
  return `${lines.join('\n')}\n`
}

async function remoteCommand(args: string[], io: HostCliIo, target: HostTarget): Promise<number> {
  const [action, ...rest] = args
  const json = rest.includes('--json') || action === '--json'
  if (!action || action === 'status' || action === '--json') {
    const status = await call<RemoteAccessStatus>(io, target, 'GET', '/remote-access?refresh=1')
    io.stdout(json ? `${JSON.stringify(status, null, 2)}\n` : formatRemoteStatus(status))
    return 0
  }
  if (action === 'on' || action === 'off') {
    const at = rest.indexOf('--name')
    const name = at >= 0 ? rest[at + 1] : undefined
    if (at >= 0 && !name) { io.stderr('--name requires a value\n'); return 2 }
    const status = await call<RemoteAccessStatus>(io, target, 'PUT', '/remote-access', { enabled: action === 'on', ...(name ? { name } : {}) })
    io.stdout(json ? `${JSON.stringify(status, null, 2)}\n` : formatRemoteStatus(status))
    if (action === 'on' && !json) {
      io.stderr('Other computers you pair or give a token get full control of this computer\'s agents, with the same power as your seed phrase.\n')
      io.stderr('Add one: adf daemon pair (or adf daemon devices add <label>). It works while this daemon runs.\n')
    }
    return 0
  }
  if (action === 'allow-network' || action === 'forget-network') {
    const which = rest.filter(a => a !== '--json').join(' ').trim()
    const current = await call<RemoteAccessStatus>(io, target, 'GET', '/remote-access?refresh=1')
    let id: string | null = null
    if (action === 'allow-network') {
      const candidates = current.networks.filter(n => n.id && (!which ? !n.allowed : n.id === which || n.label === which))
      if (candidates.length !== 1) {
        io.stderr(candidates.length === 0
          ? `${which ? `No current network "${which}".` : 'No network waiting to be allowed.'} Networks now: ${current.networks.map(n => `${n.label} (${n.id ?? 'cannot be identified yet'}${n.allowed ? ', allowed' : ''})`).join(', ') || 'none'}\n`
          : `More than one network is not allowed; name one: ${candidates.map(n => n.id).join(', ')}\n`)
        return 1
      }
      id = candidates[0].id
    } else {
      if (!which) { io.stderr(`${REMOTE_USAGE}\n`); return 2 }
      const found = current.allowedNetworks.filter(n => n.id === which || n.label === which)
      if (found.length !== 1) { io.stderr(`${found.length ? 'More than one allowed network has that name; use its id.' : `No allowed network "${which}".`}\n`); return 1 }
      id = found[0].id
    }
    const status = action === 'allow-network'
      ? await call<RemoteAccessStatus>(io, target, 'POST', '/remote-access/networks', { id })
      : await call<RemoteAccessStatus>(io, target, 'DELETE', `/remote-access/networks/${encodeURIComponent(id!)}`)
    io.stdout(json ? `${JSON.stringify(status, null, 2)}\n` : formatRemoteStatus(status))
    return 0
  }
  if (action === 'serve') {
    const mode = rest[0]
    if (mode !== 'on' && mode !== 'off') { io.stderr(`${REMOTE_USAGE}\n`); return 2 }
    const out = await call<{ tailscale: RemoteAccessStatus['tailscale']; output: string }>(io, target, 'POST', '/remote-access/tailscale-serve', { enabled: mode === 'on' })
    if (out.output) io.stderr(`${out.output}\n`)
    io.stdout(`tailscale serve is ${out.tailscale.serve}${out.tailscale.httpsUrl ? ` at ${out.tailscale.httpsUrl}` : ''}\n`)
    return 0
  }
  io.stderr(`${REMOTE_USAGE}\n`)
  return 2
}

async function devicesCommand(args: string[], io: HostCliIo, target: HostTarget): Promise<number> {
  const [action, ...rest] = args
  const json = args.includes('--json')
  if (!action || action === 'list' || action === '--json') {
    const status = await call<RemoteAccessStatus>(io, target, 'GET', '/remote-access')
    io.stdout(json ? `${JSON.stringify(status.devices, null, 2)}\n` : formatDevices(status.devices))
    return 0
  }
  if (action === 'add') {
    const label = rest.filter(a => a !== '--json').join(' ').trim()
    if (!label) { io.stderr('Usage: adf daemon devices add <label>\n'); return 2 }
    const created = await call<{ device: RemoteDevice; token: string }>(io, target, 'POST', '/remote-access/devices', { label })
    // stdout: only the token (pipeable); everything else on stderr.
    io.stdout(`${created.token}\n`)
    const status = await call<RemoteAccessStatus>(io, target, 'GET', '/remote-access')
    const url = status.urls.find(u => u.encrypted)?.url ?? status.urls[0]?.url ?? '<this computer\'s address>'
    io.stderr(`Device token for "${created.device.label}" (id ${created.device.id}). It is shown once and is as powerful as your seed phrase.\n`)
    io.stderr(`On the other computer: adf --url ${url} --token <token>, or paste both in ADF Studio → Settings → Backend → Remote computer.\n`)
    if (!status.enabled) io.stderr('Remote access is off: turn it on with adf daemon remote on.\n')
    return 0
  }
  if (action === 'revoke' || action === 'remove') {
    const key = rest.join(' ').trim()
    if (!key) { io.stderr('Usage: adf daemon devices revoke <id|label>\n'); return 2 }
    const status = await call<RemoteAccessStatus>(io, target, 'GET', '/remote-access')
    const byId = status.devices.find(d => d.id === key)
    const byLabel = status.devices.filter(d => d.label === key)
    if (!byId && byLabel.length > 1) { io.stderr(`Several computers are labelled "${key}"; give the id:\n${formatDevices(byLabel)}`); return 1 }
    const device = byId ?? byLabel[0]
    if (!device) { io.stderr(`No computer "${key}". List them with: adf daemon devices\n`); return 1 }
    const out = await call<{ device: RemoteDevice; closedSessions: number; closedConnections: number }>(io, target, 'DELETE', `/remote-access/devices/${encodeURIComponent(device.id)}`)
    io.stdout(`Removed "${out.device.label}" (${out.device.id}): its token no longer works; closed ${out.closedSessions} session(s) and ${out.closedConnections} connection(s).\n`)
    return 0
  }
  io.stderr(`${REMOTE_USAGE}\n`)
  return 2
}

async function pairCommand(io: HostCliIo, target: HostTarget): Promise<number> {
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  let window: PairingWindowView
  try {
    window = await call<PairingWindowView>(io, target, 'POST', '/remote-access/pairing')
  } catch (err) {
    if (err instanceof ManageError && err.code === 'remote_access_off') {
      io.stderr('Remote access is off. Turn it on first: adf daemon remote on\n')
      return 1
    }
    throw err
  }
  const status = await call<RemoteAccessStatus>(io, target, 'GET', '/remote-access')
  const host = status.urls.find(u => u.kind === 'tailnet' || u.kind === 'lan')?.url.replace(/^http:\/\//, '').replace(new RegExp(`:${DEFAULT_DAEMON_PORT}$`), '')
  io.stdout(`Pairing with "${window.name}" (fingerprint ${window.fingerprint}) is open for 2 minutes.\n`)
  io.stdout(`On the other computer: adf pair${host ? ` ${host}` : ''}, or choose this computer in ADF Studio → Settings → Backend → Remote computer.\n`)
  io.stdout(`Code: ${window.code.slice(0, 3)} ${window.code.slice(3)}\n`)
  io.stderr('Waiting for the other computer… (Ctrl+C closes the window)\n')
  let interrupted = false
  const stop = io.onInterrupt?.(() => { interrupted = true })
  let lastAttempts = window.attemptsLeft
  let lastLocked = window.lockedSources ?? 0
  try {
    for (;;) {
      if (interrupted) {
        await call(io, target, 'DELETE', '/remote-access/pairing').catch(() => {})
        io.stderr('Pairing window closed.\n')
        return 130
      }
      const now = await call<RemoteAccessStatus>(io, target, 'GET', '/remote-access')
      const p = now.pairing
      if (!p || p.openedAt !== window.openedAt) {
        io.stderr(lastAttempts <= 1 && Date.now() < Date.parse(window.expiresAt)
          ? 'Pairing closed after 20 wrong codes. Open a new window when you are ready: adf daemon pair\n'
          : 'Pairing closed: the 2 minutes are over. Open a new window: adf daemon pair\n')
        return 1
      }
      if (p.attemptsLeft < lastAttempts) io.stderr(`A wrong code was entered (${p.attemptsLeft} left in this window).\n`)
      lastAttempts = p.attemptsLeft
      if (p.lockedSources > lastLocked) {
        io.stderr(`A computer entered 5 wrong codes and is locked out of this window (${p.lockedSources} so far). Others can still pair.\n`)
        lastLocked = p.lockedSources
      }
      if (p.claim) {
        const c = p.claim
        const where = `${c.address}, ${c.via === 'tailnet' ? 'tailnet' : c.via === 'proxy' ? 'through a proxy on this computer' : 'this network'}${c.tailnetLogin ? `, ${c.tailnetLogin}` : ''}`
        const answer = await io.prompt(`Allow "${c.deviceName}" (${where}) to control this computer's ADF daemon? It gets the same power as your seed phrase. [y/N] `)
        const allow = answer !== null && /^\s*y(es)?\s*$/i.test(answer)
        const decided = await call<{ state: 'approved'; device: RemoteDevice } | { state: 'denied' }>(io, target, 'POST', `/remote-access/pairing/claims/${encodeURIComponent(c.claimId)}`, { allow })
        if (decided.state === 'approved') {
          io.stdout(`Allowed: "${decided.device.label}" (${decided.device.id}) can now connect. Remove it any time: adf daemon devices revoke ${decided.device.id}\n`)
          return 0
        }
        io.stdout(`Denied: "${c.deviceName}" was not allowed.\n`)
        return 1
      }
      await sleep(1_000)
    }
  } finally {
    stop?.()
  }
}

/** `adf daemon remote|devices|pair …` against this machine's daemon at `target`. */
export async function runHostRemoteCommand(sub: 'remote' | 'devices' | 'pair', args: string[], io: HostCliIo, target: HostTarget): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    io.stdout(`${REMOTE_USAGE}\n`)
    return 0
  }
  try {
    if (sub === 'remote') return await remoteCommand(args, io, target)
    if (sub === 'devices') return await devicesCommand(args, io, target)
    return await pairCommand(io, target)
  } catch (err) {
    if (err instanceof TypeError) {
      io.stderr(`Cannot reach the ADF daemon at ${target.url} (${err.message}). Start it with: adf daemon start\n`)
      return 1
    }
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
}
