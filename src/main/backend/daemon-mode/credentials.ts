import { DaemonClient, staticCredentials, type DaemonCredentials } from '../../../shared/daemon-client'

/**
 * Studio main's daemon credentials (design D1, D8). The token lives in main
 * only: it is never logged, never put in an error message and never sent to
 * the renderer.
 *
 * `token` is read before every request; `refresh` (local mode) re-reads the
 * token file after a 401, when the daemon minted a new token on first start.
 */
export interface StudioTokenSource {
  token(): string | undefined
  refresh?(): boolean
  /** X-ADF-Local-Proof for a local-only route of this machine's daemon (local mode); {} otherwise. */
  localProof?(path: string): Record<string, string>
}

export function studioDaemonCredentials(source: StudioTokenSource): DaemonCredentials {
  return {
    token: () => source.token(),
    ...(source.refresh ? { refresh: () => source.refresh!() } : {}),
    ...(source.localProof ? { localProof: (path: string) => source.localProof!(path) } : {}),
  }
}

/**
 * The client Studio main talks to its daemon with.
 *
 * `credentialsFor` (W0-B follow-up) honours the explicit token: a client
 * derived with `withBaseUrl(url, token)` sends exactly that token, and only to
 * `url`'s origin. Without a token another origin gets no credentials at all,
 * never this daemon's token (the shared client carries them over only to the
 * same origin itself).
 */
export function createStudioDaemonClient(opts: {
  baseUrl: string
  source: StudioTokenSource
  fetch?: typeof fetch
  timeoutMs?: number
}): DaemonClient {
  return new DaemonClient({
    baseUrl: opts.baseUrl,
    credentials: studioDaemonCredentials(opts.source),
    credentialsFor: (_url, token) => (token ? staticCredentials(token) : undefined),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  })
}
