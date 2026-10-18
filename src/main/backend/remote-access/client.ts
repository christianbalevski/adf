import { DaemonError, type DaemonClient } from '../../../shared/daemon-client'
import type {
  PairClaimAccepted,
  PairClaimRequest,
  PairClaimResult,
  PairingWindowView,
  RemoteAccessPatch,
  RemoteAccessStatus,
  RemoteDevice,
  RemoteHello,
} from '../../../shared/types/remote-access.types'

/**
 * The daemon's remote-access routes (docs/design/remote-access.md §11), as
 * Studio calls them. Every route and shape Studio depends on is here, so a
 * change to the contract is one file.
 *
 * - `RemoteAccessManagement`: the management routes (§11.2), through the
 *   local daemon client (master token, local proof).
 * - `PairingClient`: the unauthenticated routes (§11.3) of another computer,
 *   with plain fetch: no token exists yet, and none is sent.
 *
 * Errors become `RemoteAccessApiError` with the daemon's `code` and sentence.
 */

export class RemoteAccessApiError extends Error {
  constructor(
    message: string,
    /** HTTP status; null when the daemon could not be reached. */
    readonly status: number | null,
    /** The daemon's error code (§11.4); `unreachable`/`timeout` when no answer came. */
    readonly code: string,
    readonly extra: { attemptsLeft?: number; retryAfterS?: number; output?: string; command?: string } = {},
  ) {
    super(message)
    this.name = 'RemoteAccessApiError'
  }
}

function fromDaemonError(err: unknown): never {
  if (err instanceof DaemonError) {
    const body = (err.body ?? {}) as { code?: unknown; attemptsLeft?: unknown; output?: unknown; command?: unknown }
    const code = typeof body.code === 'string' ? body.code : err.status === null ? 'unreachable' : `http_${err.status}`
    throw new RemoteAccessApiError(err.message, err.status, code, {
      ...(typeof body.output === 'string' ? { output: body.output } : {}),
      ...(typeof body.command === 'string' ? { command: body.command } : {}),
    })
  }
  throw new RemoteAccessApiError(err instanceof Error ? err.message : String(err), null, 'unreachable')
}

const enc = encodeURIComponent

/** §11.2, through the local daemon's client. */
export class RemoteAccessManagement {
  constructor(private readonly client: Pick<DaemonClient, 'request'>) {}

  private async call<T>(method: 'GET' | 'PUT' | 'POST' | 'DELETE', path: string, body?: unknown, query?: Record<string, string>, timeoutMs?: number): Promise<T> {
    try {
      return await this.client.request<T>(method, path, { ...(body !== undefined ? { body } : {}), ...(query ? { query } : {}), ...(timeoutMs ? { timeoutMs } : {}) })
    } catch (err) {
      fromDaemonError(err)
    }
  }

  status(opts: { refresh?: boolean; timeoutMs?: number } = {}): Promise<RemoteAccessStatus> {
    return this.call('GET', '/remote-access', undefined, opts.refresh ? { refresh: '1' } : undefined, opts.timeoutMs)
  }

  set(body: RemoteAccessPatch): Promise<RemoteAccessStatus> {
    return this.call('PUT', '/remote-access', body)
  }

  addDevice(label: string): Promise<{ device: RemoteDevice; token: string }> {
    return this.call('POST', '/remote-access/devices', { label })
  }

  removeDevice(id: string): Promise<{ device: RemoteDevice; closedSessions: number; closedConnections: number }> {
    return this.call('DELETE', `/remote-access/devices/${enc(id)}`)
  }

  openPairing(): Promise<PairingWindowView> {
    return this.call('POST', '/remote-access/pairing', {})
  }

  async closePairing(): Promise<void> {
    await this.call('DELETE', '/remote-access/pairing')
  }

  decideClaim(claimId: string, allow: boolean): Promise<{ state: 'approved'; device: RemoteDevice } | { state: 'denied' }> {
    return this.call('POST', `/remote-access/pairing/claims/${enc(claimId)}`, { allow })
  }

  tailscaleServe(enabled: boolean): Promise<{ tailscale: RemoteAccessStatus['tailscale']; output: string }> {
    return this.call('POST', '/remote-access/tailscale-serve', { enabled }, undefined, 60_000)
  }
}

/** Long-poll budget of GET /pair/claims/:claimId (§11.3: 0-25 s). */
export const CLAIM_WAIT_S = 25

/** §11.3 against another computer's daemon. No credentials, no redirects. */
export class PairingClient {
  constructor(private readonly baseUrl: string, private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init)) {}

  private async call<T>(method: 'GET' | 'POST', path: string, opts: { body?: unknown; timeoutMs: number; signal?: AbortSignal }): Promise<T> {
    const signals = [AbortSignal.timeout(opts.timeoutMs), ...(opts.signal ? [opts.signal] : [])]
    let res: Response
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: { Accept: 'application/json', ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        redirect: 'manual',
        signal: AbortSignal.any(signals),
      })
    } catch (err) {
      if (opts.signal?.aborted) throw new RemoteAccessApiError('Cancelled.', null, 'cancelled')
      const cause = (err as { cause?: { code?: string } })?.cause?.code
      const timedOut = (err as Error)?.name === 'TimeoutError' || cause === 'UND_ERR_CONNECT_TIMEOUT'
      throw new RemoteAccessApiError(err instanceof Error ? err.message : String(err), null, timedOut ? 'timeout' : cause === 'ECONNREFUSED' ? 'refused' : 'unreachable')
    }
    const text = await res.text().catch(() => '')
    let body: unknown = null
    try { body = text ? JSON.parse(text) : null } catch { body = null }
    if (!res.ok) {
      const b = (body ?? {}) as { error?: unknown; code?: unknown; attemptsLeft?: unknown }
      const retry = Number(res.headers.get('retry-after'))
      throw new RemoteAccessApiError(
        typeof b.error === 'string' ? b.error : `HTTP ${res.status}`,
        res.status,
        typeof b.code === 'string' ? b.code : `http_${res.status}`,
        {
          ...(typeof b.attemptsLeft === 'number' ? { attemptsLeft: b.attemptsLeft } : {}),
          ...(Number.isFinite(retry) && retry > 0 ? { retryAfterS: retry } : {}),
        },
      )
    }
    return body as T
  }

  hello(opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<RemoteHello> {
    return this.call('GET', '/remote/hello', { timeoutMs: opts.timeoutMs ?? 5_000, ...(opts.signal ? { signal: opts.signal } : {}) })
  }

  claim(request: PairClaimRequest, signal?: AbortSignal): Promise<PairClaimAccepted> {
    // A wrong code is answered after a fixed 1 s delay (§5.5).
    return this.call('POST', '/pair/claim', { body: request, timeoutMs: 15_000, ...(signal ? { signal } : {}) })
  }

  poll(claimId: string, signal?: AbortSignal): Promise<PairClaimResult> {
    return this.call('GET', `/pair/claims/${enc(claimId)}?wait=${CLAIM_WAIT_S}`, { timeoutMs: (CLAIM_WAIT_S + 10) * 1000, ...(signal ? { signal } : {}) })
  }
}
