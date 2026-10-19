/**
 * `adf pair [host]` and `adf remotes` (docs/design/remote-access.md §9.2):
 * pair this computer with another computer's ADF daemon using the 6-digit
 * code that computer shows, save the device token, and choose which daemon
 * adf talks to.
 */

import { hostname } from 'node:os'
import type { PairClaimAccepted, PairClaimResult, RemoteHello, RemoteUrl } from '../../shared/types/remote-access.types'
import { cleanDisplayName, UNSAFE_DISPLAY_CHARS } from '../daemon/remote-access/config'
import { printable } from '../services/peer-text'
import type { TailnetView } from '../daemon/remote-access/tailscale'
import { discoverDaemons, fetchHello, type DiscoveredDaemon } from './daemon-discovery'
import { DEFAULT_DAEMON_PORT, localDaemonToken } from './daemon-url'
import {
  deleteRemoteToken, KEYCHAIN_FILE_COPY, loadRemotes, readRemoteToken, remoteNameFor, storeRemoteToken, updateRemotes,
} from './remotes'

export interface PairIo {
  fetch: typeof fetch
  stdout(text: string): void
  stderr(text: string): void
  /** One line from the user; null when there is no input (end of stdin). */
  prompt(question: string): Promise<string | null>
  /** Test seams. */
  discover?: (ms: number) => Promise<DiscoveredDaemon[]>
  sleep?: (ms: number) => Promise<void>
  env?: NodeJS.ProcessEnv
  /** Test seam: this computer's Tailscale peers' addresses. */
  /** This computer's tailnet (suffix, peers); default: the Tailscale CLI. Tests: a stand-in. */
  tailnetView?: () => Promise<TailnetView>
}

const PAIR_USAGE = `Usage: adf pair [<host>[:<port>] | <url>] [--name <this computer's name>] [--as <remote name>] [--yes] [--default | --no-default]

Pairs this computer with another computer's ADF daemon. On that computer,
open a pairing window first: ADF Studio → Settings → Networking → Remote access
→ Add device, or adf daemon pair. Type the 6-digit code it shows; it
then asks whether to allow this computer.

Without a host, adf lists the ADF computers it finds on this network and on
your tailnet. The token adf receives is as powerful as that computer's owner
seed phrase; it is saved in the OS keychain (or a file only you can read).`

export const REMOTES_USAGE = `Usage: adf remotes                 List saved remote daemons (* = default)
       adf remotes use <name|local>  Talk to that daemon by default
       adf remotes forget <name>     Delete its saved address and token`

interface PairArgs {
  host?: string
  name?: string
  as?: string
  yes: boolean
  makeDefault: boolean | null
}

function parsePairArgs(args: string[]): PairArgs | string {
  const out: PairArgs = { yes: false, makeDefault: null }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const value = () => {
      const v = args[++i]
      if (v === undefined) throw new Error(`${arg} requires a value`)
      return v
    }
    if (arg === '--name') out.name = value()
    else if (arg === '--as') out.as = value()
    else if (arg === '--yes' || arg === '-y') out.yes = true
    else if (arg === '--default') out.makeDefault = true
    else if (arg === '--no-default') out.makeDefault = false
    else if (arg === '--help' || arg === '-h') return PAIR_USAGE
    else if (arg.startsWith('-')) return `Unknown option: ${arg}\n\n${PAIR_USAGE}`
    else if (!out.host) out.host = arg
    else return `Too many arguments\n\n${PAIR_USAGE}`
  }
  return out
}

/** `host`, `host:port`, `[v6]:port` or a URL → the daemon's base URL. */
export function hostToUrl(host: string): string {
  if (/^https?:\/\//i.test(host)) return host.replace(/\/+$/, '')
  if (/^\[.*\](:\d+)?$/.test(host)) return `http://${host.includes(']:') ? host : `${host}:${DEFAULT_DAEMON_PORT}`}`
  if (host.includes(':') && host.split(':').length > 2) return `http://[${host}]:${DEFAULT_DAEMON_PORT}`
  return `http://${/:\d+$/.test(host) ? host : `${host}:${DEFAULT_DAEMON_PORT}`}`
}

/** How the token would travel to `url`. */
export function transportOf(url: string): 'https' | 'tailnet' | 'loopback' | 'plain' {
  let parsed: URL
  try { parsed = new URL(url) } catch { return 'plain' }
  if (parsed.protocol === 'https:') return 'https'
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host === '::1' || /^127\./.test(host)) return 'loopback'
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host) || /^fd7a:115c:a1e0:/.test(host)) return 'tailnet'
  return 'plain'
}

async function postJson<T>(io: PairIo, url: string, body: unknown): Promise<{ status: number; body: T & { error?: string; code?: string; attemptsLeft?: number }; retryAfter: number | null }> {
  const res = await io.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body), redirect: 'manual' })
  const text = await res.text()
  const parsed = text ? JSON.parse(text) : {}
  const retry = Number(res.headers.get('retry-after'))
  return { status: res.status, body: parsed, retryAfter: Number.isFinite(retry) && retry > 0 ? retry : null }
}

async function getJson<T>(io: PairIo, url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: T & { error?: string; code?: string } }> {
  const res = await io.fetch(url, { headers: { Accept: 'application/json', ...headers }, redirect: 'manual' })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : {} }
}

/** This computer's ADF daemon and its token, if one is set up here. */
function localDaemonOf(env: NodeJS.ProcessEnv): { url: string; token: string } | null {
  const url = `http://127.0.0.1:${Number(env.ADF_DAEMON_PORT) || DEFAULT_DAEMON_PORT}`
  const token = localDaemonToken(url, env)
  return token ? { url, token } : null
}

async function chooseDaemon(io: PairIo): Promise<{ url: string; hello: RemoteHello } | null> {
  io.stderr('Looking for ADF computers on this network and your tailnet…\n')
  // The one discovery feed (remote-access.md §5.1): this computer's daemon's when it runs, else this process's.
  const found = await (io.discover ?? ((ms: number) => discoverDaemons(ms, { localDaemon: localDaemonOf(io.env ?? process.env), fetch: io.fetch, env: io.env ?? process.env })))(3_000)
  if (found.length === 0) {
    io.stderr('No ADF computer found. On the other computer turn on Remote access (Settings → Networking, or adf daemon remote on), then run adf pair <its address>.\n')
    return null
  }
  found.forEach((d, i) => io.stderr(`  ${i + 1}. ${d.name}  ${d.fingerprint}  ${d.url}  (${d.kind === 'tailnet' ? 'tailnet' : 'this network'}${d.pairingOpen ? ', ready to pair' : ''})\n`))
  const answer = await io.prompt(found.length === 1 ? 'Pair with 1? [Y/n] ' : `Which one (1-${found.length})? `)
  if (answer === null) return null
  const index = found.length === 1 && /^\s*(y|yes)?\s*$/i.test(answer) ? 0 : Number(answer.trim()) - 1
  const chosen = found[index]
  if (!chosen) {
    io.stderr('No such entry.\n')
    return null
  }
  const hello = await fetchHello(chosen.url, io.fetch)
  if (!hello) {
    io.stderr(`${chosen.url} does not answer as an ADF daemon with remote access on.\n`)
    return null
  }
  return { url: chosen.url, hello }
}

/** The URL to save: an encrypted one the host listed that answers with the same fingerprint, else the one used. */
/**
 * The URL to save (security review item 7): the one the user typed or chose,
 * unless the host lists an encrypted one that is plainly a tailnet address:
 * `https://*.ts.net`, or a 100.64/10 / fd7a:115c:a1e0::/48 address this
 * computer's own Tailscale lists as a peer. It must answer with the same
 * fingerprint, and the user is asked first (`--yes` accepts). Any other URL
 * the host lists (a LAN or public name) is never followed.
 */
async function bestUrl(io: PairIo, used: string, urls: RemoteUrl[], fingerprint: string, yes: boolean): Promise<string> {
  if (transportOf(used) === 'https') return used
  // Re-review 3: only what this computer's own Tailscale vouches for (its tailnet's names, its peers),
  // checked before any question, so --yes never skips it; without Tailscale, nothing.
  let view: TailnetView | null = null
  const { NO_TAILNET, TailscaleClient, tailnetUrlAllowed } = await import('../daemon/remote-access/tailscale')
  for (const candidate of urls) {
    if (candidate.url === used || (candidate.kind !== 'tailscale-https' && candidate.kind !== 'tailnet')) continue
    view ??= await (io.tailnetView ?? (() => new TailscaleClient().tailnetView()))().catch(() => NO_TAILNET)
    if (!tailnetUrlAllowed(candidate.url, view)) continue
    const hello = await fetchHello(candidate.url, io.fetch)
    if (hello?.fingerprint !== fingerprint) continue
    const answer = yes ? 'y' : await io.prompt(`"${hello.name}" is also reachable at ${candidate.url}, encrypted by Tailscale. Save that address instead of ${used}? [Y/n] `)
    if (answer !== null && /^\s*(y|yes)?\s*$/i.test(answer)) return candidate.url
    return used
  }
  return used
}

/**
 * The device name when --name is not given: this computer's host name, made
 * safe. Any host name pairs (a CI runner's, a long FQDN, a control
 * character): unsafe characters are dropped, it is cut to 64 characters, and
 * an empty one becomes "ADF computer".
 */
export function hostDeviceName(raw: string): string {
  const unsafe = new RegExp(UNSAFE_DISPLAY_CHARS.source, 'gu')
  const name = [...raw.replace(unsafe, '').replace(/\s+/g, ' ').trim()].slice(0, 64).join('').trim()
  return cleanDisplayName(name, 64) ?? 'ADF computer'
}

/**
 * Output that never carries another computer's raw text (discovery review 3):
 * names, errors and labels from a peer are stripped of control characters
 * and terminal escape sequences before they reach the terminal.
 */
function terminalSafe<T extends Pick<PairIo, 'stdout' | 'stderr'> & Partial<Pick<PairIo, 'prompt'>>>(io: T): T {
  const prompt = io.prompt
  return {
    ...io,
    stdout: (text: string) => io.stdout(printable(text)),
    stderr: (text: string) => io.stderr(printable(text)),
    ...(prompt ? { prompt: (question: string) => prompt(printable(question)) } : {}),
  }
}

export async function runPair(args: string[], rawIo: PairIo): Promise<number> {
  const io = terminalSafe(rawIo)
  const env = io.env ?? process.env
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  let parsed: PairArgs | string
  try { parsed = parsePairArgs(args) } catch (err) {
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n`)
    return 2
  }
  if (typeof parsed === 'string') {
    io.stdout(`${parsed}\n`)
    return parsed === PAIR_USAGE ? 0 : 2
  }
  const deviceName = parsed.name !== undefined ? cleanDisplayName(parsed.name, 64) : hostDeviceName(hostname())
  if (!deviceName) {
    io.stderr('--name must be 1-64 characters without control or bidi characters.\n')
    return 2
  }

  let url: string
  let hello: RemoteHello
  if (parsed.host) {
    url = hostToUrl(parsed.host)
    const h = await fetchHello(url, io.fetch)
    if (!h) {
      io.stderr(`${url} does not answer as an ADF daemon with remote access on. On that computer turn on Remote access (Settings → Networking, or adf daemon remote on); an older ADF version cannot pair.\n`)
      return 1
    }
    hello = h
  } else {
    const chosen = await chooseDaemon(io)
    if (!chosen) return 1
    url = chosen.url
    hello = chosen.hello
  }
  io.stderr(`Pairing with "${hello.name}" (fingerprint ${hello.fingerprint}) at ${url}. Check that it shows the same fingerprint.\n`)

  const transport = transportOf(url)
  if (transport === 'plain') {
    io.stderr('This address uses plain http on this network: the token is sent unencrypted, and anyone who can see the traffic can take it. On a tailnet, pair with the tailnet address instead.\n')
    if (!parsed.yes) {
      const ok = await io.prompt('I trust this network. Continue? [y/N] ')
      if (!ok || !/^\s*y(es)?\s*$/i.test(ok)) {
        io.stderr('Not paired.\n')
        return 1
      }
    }
  }
  if (!hello.pairingOpen) io.stderr(`No pairing window is open on "${hello.name}" yet. Open one there (Pair a computer, or adf daemon pair).\n`)

  let accepted: PairClaimAccepted | null = null
  while (!accepted) {
    const answer = await io.prompt(`Code shown on "${hello.name}": `)
    if (answer === null) return 1
    const code = answer.replace(/\s+/g, '')
    if (!/^\d{6}$/.test(code)) {
      io.stderr('The code is 6 digits.\n')
      continue
    }
    const res = await postJson<PairClaimAccepted>(io, `${url}/pair/claim`, { code, deviceName, clientKind: 'cli' })
    if (res.status === 202) {
      accepted = res.body
      break
    }
    const message = res.body.error ?? `HTTP ${res.status}`
    if (res.body.code === 'wrong_code' && (res.body.attemptsLeft ?? 0) > 0) {
      io.stderr(`${message} ${res.body.attemptsLeft} attempt(s) left.\n`)
      await sleep(2_100)
      continue
    }
    if (res.body.code === 'rate_limited' && res.retryAfter) {
      io.stderr(`${message} Waiting ${res.retryAfter} s.\n`)
      await sleep(res.retryAfter * 1000)
      continue
    }
    io.stderr(`${message}\n`)
    return 1
  }

  io.stderr(`Waiting for "${hello.name}" to allow this computer…\n`)
  let result: PairClaimResult | null = null
  while (!result || result.state === 'pending') {
    const res = await getJson<PairClaimResult>(io, `${url}/pair/claims/${encodeURIComponent(accepted.claimId)}?wait=25`, { 'X-ADF-Pair-Secret': accepted.collectSecret })
    if (res.status !== 200) {
      io.stderr(`${res.body.error ?? `HTTP ${res.status}`}\n`)
      return 1
    }
    result = res.body
  }
  if (result.state === 'denied') {
    io.stderr(`"${hello.name}" did not allow this computer.\n`)
    return 1
  }

  // The computer that approved must be the one we checked (security review item 7).
  const revokeHint = `"${result.daemon.name}" lists this computer as "${result.device.label}": remove it there (adf daemon devices revoke ${result.device.id}).`
  if (result.daemon.fingerprint !== hello.fingerprint) {
    io.stderr(`Refused: the approval came from a computer with fingerprint ${result.daemon.fingerprint}, not ${hello.fingerprint} as "${hello.name}" showed. Nothing was saved. ${revokeHint}\n`)
    return 1
  }

  // Trust on first use: a saved remote stays pinned to its fingerprint, and its address and token
  // are never replaced without asking.
  const file = loadRemotes(env)
  const sameHost = Object.entries(file.remotes).find(([, r]) => r.fingerprint === result.daemon.fingerprint)
  const name = parsed.as ?? sameHost?.[0] ?? remoteNameFor(result.daemon.name, file.remotes)
  const previous = file.remotes[name]
  if (previous && previous.fingerprint !== result.daemon.fingerprint) {
    io.stderr(`Refused: the saved remote "${name}" is ${previous.hostName ?? previous.url} with fingerprint ${previous.fingerprint}, not this computer (${result.daemon.fingerprint}). Nothing was saved. Pair under another name (--as <name>), or forget it first (adf remotes forget ${name}). ${revokeHint}\n`)
    return 1
  }
  const saveUrl = await bestUrl(io, url, result.daemon.urls, result.daemon.fingerprint, parsed.yes)
  if (previous) {
    const changes = [previous.url !== saveUrl ? `its address (${previous.url} → ${saveUrl})` : null, 'its token'].filter(Boolean).join(' and ')
    const answer = parsed.yes ? 'y' : await io.prompt(`"${name}" (${previous.hostName ?? previous.url}) is already saved. Replace ${changes}? [y/N] `)
    if (!answer || !/^\s*y(es)?\s*$/i.test(answer)) {
      io.stderr(`Kept the saved "${name}" as it was. ${revokeHint}\n`)
      return 1
    }
  }
  const previousToken = previous ? readRemoteToken(previous.fingerprint, env) : null
  let stored: Awaited<ReturnType<typeof storeRemoteToken>>
  try {
    // The keychain; the user-only file only when the user says so (--yes says so).
    stored = await storeRemoteToken(result.daemon.fingerprint, result.token, env, async (why) => {
      if (parsed.yes) return true
      io.stderr(`${KEYCHAIN_FILE_COPY.title}: ${KEYCHAIN_FILE_COPY.message} (${why})\n`)
      const answer = await io.prompt(KEYCHAIN_FILE_COPY.prompt)
      return !!answer && /^\s*y(es)?\s*$/i.test(answer)
    })
  } catch (err) {
    // Never a token in a file others could read, and never a claim that it is safe when it is not.
    io.stderr(`The token was not saved: ${err instanceof Error ? err.message : String(err)}\n`)
    io.stderr(`"${result.daemon.name}" lists this computer as "${result.device.label}": remove it there (adf daemon devices revoke ${result.device.id}) and pair again once this is fixed.\n`)
    return 1
  }
  const entry = {
    url: saveUrl,
    fingerprint: result.daemon.fingerprint,
    deviceId: result.device.id,
    label: result.device.label,
    pairedAt: new Date().toISOString(),
    hostName: result.daemon.name,
  }
  let makeDefault = parsed.makeDefault
  if (makeDefault === null) {
    const answer = await io.prompt('Use it by default for adf commands and the terminal app? [Y/n] ')
    makeDefault = answer !== null && /^\s*(y|yes)?\s*$/i.test(answer)
  }
  try {
    // Under the lock Studio takes too: read again, so a change Studio made meanwhile is kept.
    await updateRemotes(env, (latest) => {
      const now = latest.remotes[name]
      if (now && now.fingerprint !== entry.fingerprint) throw new Error(`the saved remote "${name}" changed to another computer (${now.fingerprint}) meanwhile`)
      latest.remotes[name] = entry
      if (makeDefault) latest.default = name
    })
  } catch (err) {
    // Put back what was saved before; a new remote leaves no token behind.
    try {
      // Put the previous token back where it may go (it was saved before).
      if (previousToken) await storeRemoteToken(result.daemon.fingerprint, previousToken, env, async () => true)
      else deleteRemoteToken(result.daemon.fingerprint, env)
    } catch { /* reported below */ }
    io.stderr(`The remote was not saved: ${err instanceof Error ? err.message : String(err)}\n${revokeHint}\n`)
    return 1
  }
  io.stdout(`Paired with "${result.daemon.name}" as "${result.device.label}". Saved as remote "${name}" (${saveUrl})${makeDefault ? ', the default' : `; use it with --remote ${name}`}.\n`)
  io.stderr(stored.where === 'keychain'
    ? 'The token is in the OS keychain.\n'
    : `The token is in ${stored.path}, readable by you only (${stored.why}).\n`)
  if (transportOf(saveUrl) === 'plain') io.stderr('This address is plain http: the token travels unencrypted with every request. Prefer https through tailscale serve or the tailnet address.\n')
  return 0
}

export async function runRemotes(args: string[], rawIo: Pick<PairIo, 'stdout' | 'stderr' | 'env'>, json = false): Promise<number> {
  const io = terminalSafe(rawIo)
  const env = io.env ?? process.env
  const [action, name] = args
  const file = loadRemotes(env)
  if (!action || action === 'list') {
    if (json) {
      io.stdout(`${JSON.stringify(file, null, 2)}\n`)
      return 0
    }
    const rows = Object.entries(file.remotes)
    io.stdout(`${file.default === null ? '*' : ' '} local  this computer's daemon\n`)
    for (const [n, r] of rows) io.stdout(`${file.default === n ? '*' : ' '} ${n}  ${r.url}  ${r.hostName ?? ''}  ${r.fingerprint}  as "${r.label}"\n`)
    if (rows.length === 0) io.stderr('No saved remotes. Pair one with: adf pair\n')
    return 0
  }
  if (action === 'use') {
    if (!name) { io.stderr(`${REMOTES_USAGE}\n`); return 2 }
    if (name !== 'local' && !file.remotes[name]) {
      io.stderr(`No saved remote named "${name}". List them with: adf remotes\n`)
      return 1
    }
    await updateRemotes(env, (latest) => { latest.default = name === 'local' ? null : name })
    io.stdout(name === 'local' ? 'adf now talks to this computer\'s daemon by default.\n' : `adf now talks to "${name}" (${file.remotes[name].url}) by default.\n`)
    return 0
  }
  if (action === 'forget') {
    const remote = name ? file.remotes[name] : undefined
    if (!name || !remote) {
      io.stderr(name ? `No saved remote named "${name}".\n` : `${REMOTES_USAGE}\n`)
      return name ? 1 : 2
    }
    deleteRemoteToken(remote.fingerprint, env)
    await updateRemotes(env, (latest) => {
      delete latest.remotes[name]
      if (latest.default === name) latest.default = null
    })
    io.stdout(`Forgot "${name}" and its token. "${remote.hostName ?? remote.url}" still lists this computer: remove it there (adf daemon devices revoke ${remote.deviceId}).\n`)
    return 0
  }
  io.stderr(`${REMOTES_USAGE}\n`)
  return 2
}
