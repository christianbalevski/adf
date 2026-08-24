/**
 * Connect-time glue for Phase 4 HTTP OAuth (docs/design/mcp-http-oauth.md,
 * sub-task D). Builds the `oauthProviderFactory` the McpClientManager takes: a
 * function that, for an http server config with `oauth: true`, returns a
 * store-backed OAuthClientProvider.
 *
 * IMPORTANT — this is the SILENT path only. The provider it builds supplies the
 * transport's Authorization header from the already-stored token and refreshes
 * it transparently on 401. It NEVER runs the interactive browser flow: the
 * injected IO's `openUrl` is a no-op, so a runtime connect can never
 * surprise-open a browser. Interactive sign-in lives in runMcpHttpOAuthFlow
 * (mcp-http-oauth.ts), driven only from the Studio Settings / IPC test path.
 *
 * Kept electron-free and dependency-injected so it is usable from the Studio
 * foreground path (ipc/index.ts), the runtime builder, the daemon background
 * manager, and unit tests.
 */
import { AdfOAuthClientProvider, type McpHttpOAuthIO } from './mcp-http-oauth'
import type { McpOAuthStore } from './mcp-oauth.types'
import type { McpServerConfig } from '../../shared/types/adf-v02.types'
import type { McpOAuthProviderFactory } from './mcp-client-manager'

/**
 * Connect-time IO: silent refresh never redirects, so `openUrl` is a no-op — a
 * runtime connect must never open a browser. Logs are safe: AdfOAuthClientProvider
 * only ever logs query-stripped URLs, never token/code values.
 */
export const SILENT_OAUTH_IO: McpHttpOAuthIO = {
  openUrl: () => { /* connect-time: never open a browser (see runMcpHttpOAuthFlow) */ },
  log: (msg) => console.log(msg),
}

/**
 * Build the McpClientManager `oauthProviderFactory`.
 *
 * @param resolveStore  Picks the token store for a given server config —
 *   app-level for a Settings-only test, agent-sealed (preferred) for a runtime
 *   with an agent context (see resolveOAuthStoreForConnect). Returning undefined
 *   disables oauth for that server (the connect then fails plainly on 401).
 * @param io  Injected IO — defaults to {@link SILENT_OAUTH_IO}. Only override in
 *   the interactive Settings path (never for a runtime connect).
 * @param resolveOpts  Optional per-config clientId/scopes (e.g. an allowlisted
 *   static client id from the registration). For DCR remotes these are unset and
 *   the stored client registration is used.
 */
export function buildOAuthProviderFactory(
  resolveStore: (cfg: McpServerConfig) => McpOAuthStore | undefined,
  io: McpHttpOAuthIO = SILENT_OAUTH_IO,
  resolveOpts?: (cfg: McpServerConfig) => { clientId?: string; scopes?: string[] },
): McpOAuthProviderFactory {
  return (cfg) => {
    if (!cfg.oauth || !cfg.url) return undefined
    const store = resolveStore(cfg)
    if (!store) return undefined
    const extra = resolveOpts?.(cfg) ?? {}
    return new AdfOAuthClientProvider(cfg.url, store, io, {
      clientId: extra.clientId,
      scopes: extra.scopes,
      // Silent connect-only construction: refresh does not redirect, so the
      // redirectUrl is unused. The interactive flow (runMcpHttpOAuthFlow) binds
      // a real loopback redirect instead.
      redirectUrl: '',
    })
  }
}
