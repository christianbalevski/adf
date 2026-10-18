import { checkRemoteDaemonUrl } from '../../../shared/utils/remote-backend-url'
import type { RemoteUrl } from '../../../shared/types/remote-access.types'
import type { RemotePairErrorCode, RemotePairStartRequest, RemotePairState } from '../../../shared/types/remote-access-ipc.types'
import { PairingClient, RemoteAccessApiError } from './client'

/**
 * Pairing from Settings → Backend → Remote computer
 * (docs/design/remote-access.md §5.4, §9.1): hello, the 6-digit code, the
 * wait for the host's Allow, then the token is saved like a pasted one
 * (safeStorage, `remote.paired`). One flow at a time; every change is
 * pushed as a `RemotePairState`.
 *
 * The code and the token are never logged and never returned to the
 * renderer.
 */

export interface PairingSaveInput {
  url: string
  token: string
  /** The saved URL is plain http to a LAN address the user confirmed in the dialog. */
  allowInsecureHttp: boolean
  fingerprint: string
  name: string
  deviceId: string
  label: string
}

export interface PairingFlowDeps {
  onState: (state: RemotePairState) => void
  /** Save URL and token (the backend settings store). */
  save: (input: PairingSaveInput) => Promise<{ ok: true } | { ok: false; error: string }>
  /** Why a token cannot be saved here (no OS keychain), or null. Checked before the code is sent. */
  saveBlocked: () => string | null
  /** This computer's name on the host by default (the OS host name). */
  defaultDeviceName: () => string
  fetch?: typeof fetch
  log?: Pick<Console, 'log' | 'warn'>
  /** Pause between poll retries after a network error (tests). */
  retryMs?: number
}

/** C0/C1 controls and bidirectional overrides, refused in a device name (§5.4). */
const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/

const IDLE: RemotePairState = { step: 'cancelled', host: null, deviceName: '', attemptsLeft: null, message: null, code: null, savedUrl: null }

/** The order Studio prefers the host's URLs in after approval (§5.7). */
const ENCRYPTED_ORDER: Record<RemoteUrl['kind'], number> = { 'tailscale-https': 0, tailnet: 1, lan: 2, 'mdns-name': 3 }

export class PairingFlow {
  private current: RemotePairState = IDLE
  private abort: AbortController | null = null
  private deviceName = ''
  private allowInsecure = false
  private readonly log: Pick<Console, 'log' | 'warn'>

  constructor(private readonly deps: PairingFlowDeps) {
    this.log = deps.log ?? console
  }

  get state(): RemotePairState {
    return this.current
  }

  private set(next: Partial<RemotePairState>): RemotePairState {
    this.current = { ...this.current, attemptsLeft: null, message: null, code: null, ...next }
    this.deps.onState(this.current)
    return this.current
  }

  private fail(code: RemotePairErrorCode, message: string, keepStep = false): RemotePairState {
    this.log.warn(`[Remote access] Pairing${this.current.host ? ` with ${this.current.host.name} (${this.current.host.url})` : ''}: ${code}: ${message}`)
    return this.set({ step: keepStep ? 'need_code' : 'failed', code, message })
  }

  /** Hello the host; on success the dialog asks for the code. */
  async start(request: RemotePairStartRequest): Promise<RemotePairState> {
    this.cancel(true)
    const abort = new AbortController()
    this.abort = abort
    const deviceName = (typeof request?.deviceName === 'string' && request.deviceName.trim()) || this.deps.defaultDeviceName()
    this.deviceName = deviceName
    this.current = { ...IDLE, step: 'need_code', deviceName }
    const check = checkRemoteDaemonUrl(typeof request?.url === 'string' ? request.url : '')
    if (!check.url) return this.fail('bad_request', check.reason ?? 'Invalid address.')
    const encrypted = check.kind !== 'insecure-http'
    this.allowInsecure = check.kind === 'insecure-http' && request.allowInsecureHttp === true
    if (check.kind === 'insecure-http' && !this.allowInsecure) {
      return this.fail('insecure_unconfirmed', 'Confirm that you trust this network first: the token is sent unencrypted.')
    }
    if (deviceName.length > 64 || CONTROL_OR_BIDI.test(deviceName)) {
      return this.fail('bad_request', 'This computer\'s name must be 1 to 64 characters, without control characters.')
    }
    const blocked = this.deps.saveBlocked()
    if (blocked) return this.fail('encryption_unavailable', blocked)
    const host = { name: new URL(check.url).hostname, fingerprint: '', url: check.url, encrypted }
    this.current = { ...this.current, host }
    try {
      const hello = await new PairingClient(check.url, this.deps.fetch).hello({ signal: abort.signal })
      if (abort.signal.aborted) return this.current
      if (hello?.v !== 1 || typeof hello.fingerprint !== 'string') return this.fail('unreachable', `${check.url} does not answer as an ADF computer that allows pairing.`)
      this.log.log(`[Remote access] Pairing with ${hello.name} (${hello.fingerprint}) at ${check.url} as "${deviceName}"`)
      return this.set({
        step: 'need_code',
        host: { ...host, name: hello.name, fingerprint: hello.fingerprint },
        message: hello.pairingOpen ? null : `${hello.name} has no pairing window open. Choose Pair a computer there.`,
      })
    } catch (err) {
      if (abort.signal.aborted) return this.current
      return this.networkFailure(err, host)
    }
  }

  /** Send the code; on success wait for the host's answer (pushed states). */
  async submitCode(code: unknown): Promise<RemotePairState> {
    const host = this.current.host
    const retryable = this.current.step === 'need_code'
    if (!host || !host.fingerprint || !retryable || !this.abort) return this.set({ step: this.current.step, code: 'not_started', message: 'Start pairing first.' })
    if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) {
      return this.set({ step: 'need_code', code: 'bad_request', message: `Enter the 6-digit code shown on ${host.name}.` })
    }
    const abort = this.abort
    this.set({ step: 'claiming' })
    const client = new PairingClient(host.url, this.deps.fetch)
    let claim: { claimId: string; expiresAt: string }
    try {
      claim = await client.claim({ code: code.trim(), deviceName: this.deviceName, clientKind: 'studio' }, abort.signal)
    } catch (err) {
      if (abort.signal.aborted) return this.current
      return this.claimFailure(err, host)
    }
    if (abort.signal.aborted) return this.current
    this.log.log(`[Remote access] Pairing with ${host.name}: the code was accepted; waiting for the host to allow this computer`)
    const waiting = this.set({ step: 'waiting', message: `Waiting for ${host.name} to allow this computer…` })
    void this.waitForHost(client, claim, abort)
    return waiting
  }

  /** Stop the flow here (the host's request expires by itself). */
  cancel(silent = false): RemotePairState {
    if (!this.abort) return this.current
    this.abort.abort()
    this.abort = null
    const active = this.current.step === 'need_code' || this.current.step === 'claiming' || this.current.step === 'waiting'
    if (silent || !active) return this.current
    this.log.log(`[Remote access] Pairing${this.current.host ? ` with ${this.current.host.name}` : ''} cancelled`)
    return this.set({ step: 'cancelled' })
  }

  private async waitForHost(client: PairingClient, claim: { claimId: string; expiresAt: string }, abort: AbortController): Promise<void> {
    const host = this.current.host!
    const deadline = Date.parse(claim.expiresAt)
    for (;;) {
      if (abort.signal.aborted) return
      let result
      try {
        result = await client.poll(claim.claimId, abort.signal)
      } catch (err) {
        if (abort.signal.aborted) return
        if (err instanceof RemoteAccessApiError && err.status !== null) {
          if (err.code === 'claim_not_found') this.fail('expired', `The request expired before ${host.name} answered. Pair again.`)
          else this.fail('unreachable', err.message)
          this.abort = null
          return
        }
        // A dropped long poll: retry until the claim's own expiry.
        if (Number.isFinite(deadline) && Date.now() > deadline) {
          this.networkFailure(err, host)
          this.abort = null
          return
        }
        await new Promise((r) => setTimeout(r, this.deps.retryMs ?? 2_000))
        continue
      }
      if (abort.signal.aborted) return
      if (result?.state === 'pending') continue
      this.abort = null
      if (result?.state === 'denied') {
        this.fail('denied', `${host.name} did not allow this computer.`)
        return
      }
      if (result?.state === 'approved' && typeof result.token === 'string' && result.token) {
        await this.saveApproved(host, result)
        return
      }
      this.fail('unreachable', `${host.name} answered something Studio does not understand.`)
      return
    }
  }

  /** Approved: prefer an encrypted URL that answers with the same fingerprint (§5.7), then save. */
  private async saveApproved(host: NonNullable<RemotePairState['host']>, result: Extract<Awaited<ReturnType<PairingClient['poll']>>, { state: 'approved' }>): Promise<void> {
    let url = host.url
    const candidates = (result.daemon?.urls ?? [])
      .filter((u) => u.encrypted && typeof u.url === 'string' && u.url !== host.url)
      .sort((a, b) => ENCRYPTED_ORDER[a.kind] - ENCRYPTED_ORDER[b.kind])
    for (const candidate of candidates) {
      const check = checkRemoteDaemonUrl(candidate.url)
      if (!check.url || check.kind === 'insecure-http') continue
      try {
        const hello = await new PairingClient(check.url, this.deps.fetch).hello({ timeoutMs: 3_000 })
        if (hello?.fingerprint === host.fingerprint) { url = check.url; break }
      } catch { /* not reachable from here; try the next */ }
    }
    const insecure = checkRemoteDaemonUrl(url).kind === 'insecure-http'
    const saved = await this.deps.save({
      url,
      token: result.token,
      allowInsecureHttp: insecure && this.allowInsecure,
      fingerprint: host.fingerprint,
      name: result.daemon?.name || host.name,
      deviceId: result.device?.id ?? '',
      label: result.device?.label ?? this.deviceName,
    })
    if (!saved.ok) {
      this.fail('save_failed', `${host.name} allowed this computer, but Studio could not save the token: ${saved.error} Remove "${result.device?.label ?? this.deviceName}" on ${host.name} and pair again.`)
      return
    }
    this.log.log(`[Remote access] Paired with ${host.name} (${host.fingerprint}) as "${result.device?.label ?? this.deviceName}"; saved ${url} and its token`)
    this.set({ step: 'paired', savedUrl: url, message: `Paired with ${host.name}. Its address and token are saved.` })
  }

  private claimFailure(err: unknown, host: NonNullable<RemotePairState['host']>): RemotePairState {
    if (!(err instanceof RemoteAccessApiError) || err.status === null) return this.networkFailure(err, host)
    switch (err.code) {
      case 'wrong_code': {
        const left = err.extra.attemptsLeft ?? null
        if (left === 0) return this.fail('attempts_used', `Wrong code, and no tries are left. Choose Pair a computer on ${host.name} for a new code.`)
        this.log.warn(`[Remote access] Pairing with ${host.name}: wrong code${left !== null ? `, ${left} left` : ''}`)
        return this.set({ step: 'need_code', code: 'wrong_code', attemptsLeft: left, message: `Wrong code.${left !== null ? ` ${left} ${left === 1 ? 'try' : 'tries'} left.` : ''}` })
      }
      case 'pairing_closed':
        return this.fail('window_closed', `The pairing window on ${host.name} is closed. Choose Pair a computer there for a new code.`)
      case 'pairing_busy':
        return this.fail('busy', `${host.name} is already asking about another computer. Try again in a moment.`, true)
      case 'rate_limited':
        return this.fail('rate_limited', `Too many tries.${err.extra.retryAfterS ? ` Wait ${err.extra.retryAfterS} s.` : ' Wait a moment.'}`, true)
      case 'remote_access_off':
        return this.fail('remote_access_off', `${host.name} no longer allows other computers to connect.`)
      case 'bad_request':
        return this.fail('bad_request', err.message, true)
      default:
        return this.fail('unreachable', err.message)
    }
  }

  private networkFailure(err: unknown, host: NonNullable<RemotePairState['host']>): RemotePairState {
    if (err instanceof RemoteAccessApiError && err.status !== null) {
      if (err.code === 'remote_access_off') return this.fail('remote_access_off', `${host.url} does not allow other computers to connect. Turn it on there: Settings → Backend → This computer.`)
      return this.fail('unreachable', `${host.url} does not answer as an ADF computer that allows pairing (${err.message}).`)
    }
    const code = err instanceof RemoteAccessApiError ? err.code : 'unreachable'
    const kind = checkRemoteDaemonUrl(host.url).kind
    if (code === 'timeout' && kind === 'insecure-http') {
      return this.fail('firewall', `Studio could not reach ${host.name} at ${host.url}. The host's firewall may block port ${new URL(host.url).port || '7385'}.`)
    }
    if (kind === 'tailnet') return this.fail('unreachable', `Studio could not reach ${host.name} at ${host.url}. Check that both computers are on the tailnet.`)
    return this.fail('unreachable', `Studio could not reach ${host.name} at ${host.url}${code === 'refused' ? ': nothing answers there' : ''}.`)
  }
}
