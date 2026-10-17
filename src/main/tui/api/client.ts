// The terminal app's daemon client: the shared client
// (src/shared/daemon-client/client.ts, design D8) with Node credentials
// (cli/daemon-url.ts) and the `--url` / `--token` defaults.

import * as daemonUrlNs from '../../cli/daemon-url'
import * as sharedClientNs from '../../../shared/daemon-client/client'
import { cjs } from '../interop'

export type { DaemonCredentials, Method, Query, RequestOptions } from '../../../shared/daemon-client/client'

const { daemonCredentials, resolveDaemonUrl } = cjs(daemonUrlNs)
const shared = cjs(sharedClientNs)

export const staticCredentials = shared.staticCredentials

export interface DaemonClientOptions {
  /** Daemon base URL. Defaults to `--url` semantics: ADF_DAEMON_URL, then http://127.0.0.1:7385. */
  baseUrl?: string
  /** Bearer token. Defaults to ADF_DAEMON_TOKEN (then the local token file, with `localToken`). */
  token?: string
  /**
   * With no token given: read this machine's daemon token file (loopback
   * URLs only; daemon-token.ts), and re-read it once on a 401. The terminal
   * app sets it; tests leave it off so they never read real user files.
   */
  localToken?: boolean
  /** Environment for the token lookup. Defaults to process.env. */
  env?: NodeJS.ProcessEnv
  /** Injected for tests. */
  fetch?: typeof fetch
  /** Per-request timeout for non-streaming calls. Default 15s. */
  timeoutMs?: number
}

type SharedOptions = sharedClientNs.DaemonClientOptions

export class DaemonClient extends shared.DaemonClient {
  /** `resolved`: options already built for the shared client (derive); `options` is then ignored. */
  constructor(options: DaemonClientOptions = {}, resolved?: SharedOptions) {
    super(resolved ?? DaemonClient.resolve(options))
  }

  private static resolve(options: DaemonClientOptions): SharedOptions {
    const baseUrl = resolveDaemonUrl(options.baseUrl)
    const lookup = { localToken: options.localToken, env: options.env }
    return {
      baseUrl,
      // `--token` belongs to this URL; another daemon (withBaseUrl) gets its
      // own `--token`, or ADF_DAEMON_TOKEN, or its own local token file (and
      // local proof, when it is this machine's daemon), never this one.
      credentials: daemonCredentials(baseUrl, { ...lookup, token: options.token }),
      credentialsFor: (url, token) => daemonCredentials(url, { ...lookup, token }),
      fetch: options.fetch,
      timeoutMs: options.timeoutMs,
    }
  }

  protected override derive(options: SharedOptions): this {
    return new DaemonClient({}, options) as this
  }
}
