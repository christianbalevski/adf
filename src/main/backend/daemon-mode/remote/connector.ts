import { SUPPORTED_CLIENT_API_VERSION, type DaemonVersion } from '../../../../shared/daemon-client'
import { checkRemoteDaemonUrl } from '../../../../shared/utils/remote-backend-url'
import { readRemoteToken, remoteTransportRefusal, type SecretCodec, type StudioBackendConfig } from '../../backend-config'
import type { DaemonConnector } from '../connection'
import { ConnectionError, checkPinnedFingerprint, checkSlotToken, pinCheckFor, savedConnectionTarget, slotCheckFor, slotName } from '../../connections'
import type { SavedRemote } from '../../../cli/remotes'
import { parseDeviceToken } from '../../../daemon/remote-access/device-store'

/**
 * Remote mode's connector (design §9, tracker W4-B): the URL and the `safe:`
 * token from studio-backend.json, checked against the transport rule (§9.2)
 * and a version handshake before Studio uses the daemon.
 *
 * - The token goes only to the URL's origin. The handshake sends it once,
 *   on GET /version, never on a redirect (redirects are not followed). The
 *   daemon client Studio then uses binds it to the same origin (W0-B).
 * - The token source has no local proof and no token-file refresh: this
 *   machine's proof and token file belong to this machine's daemon, and a
 *   remote daemon never gets either (design §5.4.1).
 * - Every failure is a sentence naming the URL and what to do: a wrong
 *   token, an unreachable host, a TLS error, a proxy without its daemon, a
 *   host name the daemon does not allow, another client API version. None
 *   contains the token.
 */

export type RemoteConnectProblem =
  | 'not_configured'
  | 'transport'
  | 'no_token'
  | 'unreachable'
  | 'tls'
  | 'unauthorized'
  | 'host_not_allowed'
  | 'redirect'
  | 'proxy'
  | 'not_a_daemon'
  | 'version'
  | 'http'
  /** A saved connection answers with another fingerprint than the one pinned when it was paired. */
  | 'fingerprint'
  /** The OS keychain did not give the saved connection's token. */
  | 'keychain'
  /** cli-remotes.json cannot be read: the saved connection is not known until it is fixed (waited for). */
  | 'unreadable'
  /** The host answered the hello 429: waited out (`retryAfterMs`), the token not sent meanwhile. */
  | 'rate_limited'

export class RemoteConnectError extends Error {
  constructor(readonly problem: RemoteConnectProblem, message: string, readonly retryAfterMs: number | null = null) {
    super(message)
    this.name = 'RemoteConnectError'
  }
}

const HANDSHAKE_TIMEOUT_MS = 15_000

/** `wait`, ended early (resolved) when `signal` aborts. */
function abortable(wait: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return wait
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const done = (): void => { signal.removeEventListener('abort', done); resolve() }
    signal.addEventListener('abort', done, { once: true })
    void wait.then(done, done)
  })
}

/** Node/undici error codes of a failed TLS handshake or certificate check. */
const TLS_CODE = /^(CERT_|UNABLE_TO_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|ERR_TLS_|ERR_SSL_|ERR_CERT|HOSTNAME_MISMATCH|EPROTO$)/
/** Codes of a host that cannot be reached at all. */
const UNREACHABLE_CODE = /^(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EAI_NONAME|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ECONNRESET|EPIPE|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET|UND_ERR_HEADERS_TIMEOUT)$/

/** The first error code along `cause` and AggregateError `errors` (fetch wraps the socket's error). */
export function networkErrorCode(err: unknown, depth = 0): string | null {
  if (!err || typeof err !== 'object' || depth > 5) return null
  const e = err as { code?: unknown; cause?: unknown; errors?: unknown }
  if (typeof e.code === 'string' && e.code) return e.code
  const fromCause = networkErrorCode(e.cause, depth + 1)
  if (fromCause) return fromCause
  if (Array.isArray(e.errors)) for (const inner of e.errors) {
    const code = networkErrorCode(inner, depth + 1)
    if (code) return code
  }
  return null
}

function innerMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause
    if (cause instanceof Error && cause.message) return cause.message
    return err.message
  }
  return String(err)
}

/** A fetch that threw: an unreachable host, a TLS failure or a timeout, as one sentence. */
export function describeFetchFailure(url: string, err: unknown, timedOut: boolean): RemoteConnectError {
  const code = networkErrorCode(err)
  if (code && TLS_CODE.test(code)) {
    return new RemoteConnectError('tls', `The TLS connection to ${url} failed (${code}: ${innerMessage(err)}). Studio checks certificates and has no option to skip that: give the server a certificate this computer trusts (a reverse proxy with a public certificate, or tailscale serve), or use an SSH tunnel.`)
  }
  if (timedOut) {
    return new RemoteConnectError('unreachable', `The agent server at ${url} did not answer within ${HANDSHAKE_TIMEOUT_MS / 1000} s. Check that the server is on and reachable from this computer (VPN, tailnet, SSH tunnel).`)
  }
  const what = code ? `${code}: ${innerMessage(err)}` : innerMessage(err)
  return new RemoteConnectError('unreachable', `Cannot reach the agent server at ${url} (${what}). Check the address, that the server runs there (adf daemon status), and that the tunnel or tailnet is up.`)
}

async function bodyOf(res: Response): Promise<Record<string, unknown> | null> {
  const text = await res.text()
  try {
    const parsed = text.trim() ? JSON.parse(text) : null
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

/**
 * A token the remote daemon refuses (401). The master token is refused from
 * other computers, so the next step is a new device token: pair again.
 */
export function refusedTokenSentence(url: string): string {
  const host = (() => { try { return new URL(url).hostname.replace(/^\[|\]$/g, '') } catch { return url } })()
  return `The agent server at ${url} refused the token. On ${host}, click Add, then Share, and pair again.`
}

/** An answer that is not the daemon's success: one sentence per known case. */
function describeAnswer(url: string, res: Response, step: 'health' | 'version', body: Record<string, unknown> | null): RemoteConnectError {
  if (res.status >= 300 && res.status < 400) {
    void res.body?.cancel().catch(() => {})
    const location = res.headers.get('location')
    return new RemoteConnectError('redirect', `${url} answered a redirect (HTTP ${res.status}${location ? ` to ${location}` : ''}). Studio does not follow redirects, so the token stays with that address: enter the daemon's final URL in Settings → Connections.`)
  }
  if (res.status === 403 && body?.code === 'host_not_allowed') {
    const host = (() => { try { return new URL(url).hostname } catch { return url } })()
    return new RemoteConnectError('host_not_allowed', `The agent server at ${url} does not accept the host name ${host}. On that computer, add it to ADF_DAEMON_ALLOWED_HOSTS and restart the server (docs: Remote daemon).`)
  }
  if (step === 'version' && res.status === 401) {
    return new RemoteConnectError('unauthorized', refusedTokenSentence(url))
  }
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    return new RemoteConnectError('proxy', `${url} answered HTTP ${res.status}: a proxy answers there, but the agent server behind it does not. Start it on that computer (adf daemon start) and check the proxy's target.`)
  }
  if (res.status === 404 || (res.ok && step === 'health')) {
    return new RemoteConnectError('not_a_daemon', `${url} does not answer as an agent server (HTTP ${res.status} for /${step}). Check the address and port.`)
  }
  const detail = typeof body?.error === 'string' ? `: ${body.error}` : ''
  return new RemoteConnectError('http', `The agent server at ${url} answered HTTP ${res.status} for /${step}${detail}.`)
}

export interface HandshakeOptions {
  fetch?: typeof fetch
  timeoutMs?: number
}

/** A daemon that is not there yet (server booting, tunnel or tailnet still coming up) is retried; anything else is a configuration problem. */
const RETRIED: ReadonlySet<RemoteConnectProblem> = new Set(['unreachable', 'proxy', 'rate_limited'])

export interface RemoteConnectorOptions extends HandshakeOptions {
  /** Backoff between attempts while the daemon cannot be reached: from `initialMs`, doubling up to `maxMs`. */
  retry?: { initialMs?: number; maxMs?: number; maxAttempts?: number }
  sleep?: (ms: number) => Promise<void>
  /** Where `cli-remotes.json` and the keychain fallback are (connections.ts remotesEnv); default process.env. */
  env?: NodeJS.ProcessEnv
}

const CONNECTION_PROBLEM: Record<ConnectionError['code'], RemoteConnectProblem> = {
  not_configured: 'not_configured',
  transport: 'transport',
  no_token: 'no_token',
  keychain: 'keychain',
  pinned: 'fingerprint',
  unreachable: 'unreachable',
  unreadable: 'unreadable',
  rate_limited: 'rate_limited',
}

function asConnectError(err: unknown): unknown {
  return err instanceof ConnectionError ? new RemoteConnectError(CONNECTION_PROBLEM[err.code], err.message, err.retryAfterMs) : err
}

/** The progress line while cli-remotes.json cannot be read (R2A-3): the attempt waits for it, as for a host that is down. */
export const REMOTES_UNREADABLE_PREFIX = 'Waiting for the list of saved connections'

/** The progress line while Studio waits for an unreachable remote daemon (index.ts notifies once on it). */
export const REMOTE_WAITING_PREFIX = 'Waiting for the remote ADF daemon'

/**
 * GET /health (no token), then GET /version with the token: the daemon is
 * there, accepts the token, and speaks Studio's client API. Resolves with
 * the version answer; throws RemoteConnectError.
 */
export async function remoteHandshake(url: string, token: string, opts: HandshakeOptions = {}): Promise<DaemonVersion> {
  const doFetch = opts.fetch ?? fetch
  const timeoutMs = opts.timeoutMs ?? HANDSHAKE_TIMEOUT_MS
  const get = async (path: '/health' | '/version', headers: Record<string, string>) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      // Never followed: a redirect would carry the token to another address.
      const res = await doFetch(`${url}${path}`, { headers: { Accept: 'application/json', ...headers }, redirect: 'manual', signal: controller.signal })
      // Refuse redirects without consuming their body. Every other answer,
      // including an error, must finish within the handshake deadline.
      const body = res.status >= 300 && res.status < 400 ? null : await bodyOf(res)
      return { res, body }
    } catch (err) {
      throw describeFetchFailure(url, err, controller.signal.aborted)
    } finally {
      clearTimeout(timer)
    }
  }

  const { res: health, body: healthBody } = await get('/health', {})
  if (!health.ok || healthBody?.ok !== true) {
    if (health.ok) throw new RemoteConnectError('not_a_daemon', `${url} does not answer as an ADF daemon (its /health answer is not the daemon's). Check the address and port.`)
    throw describeAnswer(url, health, 'health', healthBody)
  }

  const { res, body } = await get('/version', { Authorization: `Bearer ${token}` })
  if (!res.ok) throw describeAnswer(url, res, 'version', body)
  const info = body as Partial<DaemonVersion> | null
  if (!info || typeof info.clientApiVersion !== 'number') {
    throw new RemoteConnectError('not_a_daemon', `${url} does not answer as an ADF daemon (no client API version in its /version answer). Update the daemon on the server.`)
  }
  if (info.clientApiVersion !== SUPPORTED_CLIENT_API_VERSION) {
    throw new RemoteConnectError('version', `The ADF daemon at ${url}${typeof info.version === 'string' ? ` (version ${info.version})` : ''} speaks client API ${info.clientApiVersion}; this Studio needs ${SUPPORTED_CLIENT_API_VERSION}. Update the daemon on the server (or Studio) so both are the same version.`)
  }
  return info as DaemonVersion
}

/** Why `config` cannot be used to connect, before any request; null when it can. */
export function remoteConfigProblem(config: StudioBackendConfig, codec: SecretCodec): { error: RemoteConnectError } | { url: string; token: string } {
  const url = config.remote.url
  if (!url) return { error: new RemoteConnectError('not_configured', 'Remote mode has no daemon URL. Enter it in Settings → Connections.') }
  const refusal = remoteTransportRefusal(config)
  if (refusal) return { error: new RemoteConnectError('transport', refusal) }
  // Defence in depth: the file could have been edited after the boot read.
  const check = checkRemoteDaemonUrl(url)
  if (!check.url) return { error: new RemoteConnectError('transport', `The remote daemon URL is not valid: ${check.reason ?? url}`) }
  const token = readRemoteToken(config, codec)
  if (!token) return { error: new RemoteConnectError('no_token', `No token is saved for ${url}, or it cannot be decrypted on this computer. On the server, open Settings → Connections → Add → Share. On this computer, open Settings → Connections → Add → Connect and enter the code, then approve the device on the server. You can also create a device token on the server with adf daemon devices add <label> and enter it in Connect.`) }
  return { url: check.url, token }
}

/** The remote slot holds a device token (`adfd_…`): its re-dials are checked as a pinned connection's (§5.2.1). */
function slotHasDeviceToken(config: StudioBackendConfig, codec: SecretCodec): boolean {
  try {
    const token = config.remote.url ? readRemoteToken(config, codec) : null
    return !!token && parseDeviceToken(token) !== null
  } catch {
    return false
  }
}

export function remoteDaemonConnector(config: StudioBackendConfig, codec: SecretCodec, opts: RemoteConnectorOptions = {}): DaemonConnector {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  // Set once connected: the pin to check before every new connection (connection.ts pinCheck).
  let pin: (() => Promise<void>) | null = null
  const connector = Object.assign(async (progress: (text: string) => void, signal?: AbortSignal) => {
    /** Studio closed the connection (the runtime was removed): nothing more is sent. */
    const stopIfClosed = (): void => { if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Studio closed this connection') }
    let url: string
    let token: string
    // A saved connection (settings-scopes.md §5.2): cli-remotes.json and the OS keychain, pinned to its fingerprint.
    let saved: { name: string; remote: SavedRemote } | null = null
    const name = config.remote.name
    if (name) {
      progress(`Reading the token for ${name}…`)
      // cli-remotes.json that cannot be read (R2A-3) is waited for, the file named, as a host that is down.
      let delay = opts.retry?.initialMs ?? 2_000
      for (let attempt = 1; ; attempt++) {
        try {
          stopIfClosed()
          const target = await savedConnectionTarget(config, name, opts.env ?? process.env, {
            onSlow: () => progress(`Waiting for the OS keychain: answer its prompt for ${name} (it can be behind other windows).`),
          })
          url = target.url
          token = target.token
          saved = { name, remote: target.remote }
          break
        } catch (err) {
          const e = asConnectError(err)
          if (!(e instanceof RemoteConnectError) || e.problem !== 'unreadable' || attempt >= (opts.retry?.maxAttempts ?? Infinity)) throw e
          stopIfClosed()
          progress(`${REMOTES_UNREADABLE_PREFIX} (attempt ${attempt}; next in ${Math.round(delay / 1000)} s): ${e.message}`)
          await abortable(sleep(delay), signal)
          delay = Math.min(opts.retry?.maxMs ?? 30_000, delay * 2)
        }
      }
    } else {
      const checked = remoteConfigProblem(config, codec)
      if ('error' in checked) throw checked.error
      url = checked.url
      token = checked.token
      // A paired remote URL that could not move to the shared list is pinned all the same.
      const paired = config.remote.paired
      if (paired) saved = { name: paired.name, remote: { url, fingerprint: paired.fingerprint, deviceId: paired.deviceId, label: paired.label, pairedAt: '' } }
    }
    progress(`Connecting to the remote ADF daemon at ${url}…`)
    // An unreachable daemon at launch is retried with backoff (W4-B review);
    // a wrong token, TLS error, version or address problem ends the attempt.
    let delay = opts.retry?.initialMs ?? 2_000
    const maxDelay = opts.retry?.maxMs ?? 30_000
    let info: DaemonVersion
    for (let attempt = 1; ; attempt++) {
      try {
        stopIfClosed()
        if (saved) await checkPinnedFingerprint(saved.name, saved.remote, url, token, opts.fetch).catch((e) => { throw asConnectError(e) })
        // The unpinned slot's device token goes only to the daemon that proves it issued it (§5.2.1); any other token is not checked.
        else await checkSlotToken(slotName(config.remote), url, token, opts.fetch).catch((e) => { throw asConnectError(e) })
        // The pin check and the handshake each wait: the token goes out only while the connection is still wanted.
        stopIfClosed()
        info = await remoteHandshake(url, token, opts)
        stopIfClosed()
        if (saved) pin = pinCheckFor(saved.name, saved.remote.fingerprint, url, token, opts.fetch)
        else if (parseDeviceToken(token)) pin = slotCheckFor(slotName(config.remote), url, token, opts.fetch)
        break
      } catch (err) {
        if (!(err instanceof RemoteConnectError) || !RETRIED.has(err.problem) || attempt >= (opts.retry?.maxAttempts ?? Infinity)) throw err
        stopIfClosed()
        if (err.problem === 'rate_limited') {
          // Not down: the host limits hellos from here. Its own sentence; the wait is at least what it asked.
          const wait = Math.max(delay, err.retryAfterMs ?? 0)
          progress(err.message)
          await abortable(sleep(wait), signal)
        } else {
          progress(`${REMOTE_WAITING_PREFIX} at ${url} (attempt ${attempt}; next in ${Math.round(delay / 1000)} s): ${err.message}`)
          await abortable(sleep(delay), signal)
        }
        delay = Math.min(maxDelay, delay * 2)
      }
    }
    return {
      baseUrl: url,
      logFile: null,
      description: `the remote ADF daemon at ${url} (version ${info.version}, pid ${info.pid} on its host, started by ${info.startedBy})`,
      // No localProof and no refresh: see the file comment.
      source: { token: () => token },
    }
  }, { logFile: null })
  // A pinned connection is checked again before every new connection, not only at launch; so is the slot's device token.
  if (!config.remote.name && !config.remote.paired && !slotHasDeviceToken(config, codec)) return connector
  return Object.assign(connector, { pinCheck: () => pin ? pin() : Promise.resolve() })
}
