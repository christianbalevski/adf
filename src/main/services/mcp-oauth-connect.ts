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
  // Deliberately silent. The provider's only io.log call is inside
  // redirectToAuthorization ("Opening authorization URL…"), which on this path
  // opens NOTHING (openUrl is a no-op). Since the SDK's transport re-invokes
  // auth() on every operational 401, logging there would spam that misleading
  // line once per rejected request. The actionable signal is surfaced instead
  // by McpClientManager ("Authorization required — sign in from Settings") on
  // the connect path. Interactive sign-in uses its own IO (studioOAuthIO), which
  // logs and actually opens the browser.
  log: () => { /* silent connect: suppress the misleading "opening URL" line */ },
}

/**
 * Placeholder loopback redirect for the SILENT provider. It is NEVER contacted
 * (the silent IO's openUrl is a no-op), but it MUST be non-empty: the MCP SDK's
 * auth() treats a falsy `redirectUrl` as a non-interactive (client_credentials)
 * provider and, on any connect where the stored access token is missing/expired,
 * jumps straight to a token fetch our authorization_code provider can't satisfy —
 * throwing "Either provider.prepareTokenRequest() or authorizationCode is
 * required" and skipping BOTH silent refresh and the clean unauthorized path. A
 * non-empty value keeps auth() on the interactive-capable branch: it refreshes
 * silently when a refresh_token exists, and otherwise dead-ends at REDIRECT →
 * UnauthorizedError (surfaced as "sign in from Settings") without opening a
 * browser. The real interactive flow (runMcpHttpOAuthFlow) binds its own
 * ephemeral loopback URL and never uses this.
 */
export const SILENT_OAUTH_REDIRECT_PLACEHOLDER = 'http://127.0.0.1/adf-oauth-silent-refresh'

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
/**
 * Synthetic approval name for an agent-loop-triggered interactive OAuth sign-in.
 * It maps to NO declared tool — see gateInteractiveOAuthSignIn for why "Always
 * approve" is suppressed for it.
 */
export const MCP_OAUTH_SIGNIN_APPROVAL = 'mcp_oauth_signin'

/** Minimal executor surface the OAuth sign-in gate needs (Electron/executor-free). */
export interface OAuthApprovalGate {
  requestApproval(name: string, input: unknown, opts?: { canAlwaysApprove?: boolean }): Promise<boolean>
}

export interface GateInteractiveOAuthSignInParams {
  /** The server the token is minted for — used for the approval meta and logs. */
  server: { name: string; url: string }
  /**
   * The live agent executor's approval gate, or `null` when there is no live
   * executor (an initial-startup connect, NOT a loop call). `null` ⇒ never
   * prompt and never open a browser: a token must pre-exist.
   */
  executor: OAuthApprovalGate | null
  /** True iff a token is already stored (idempotent skip — no prompt). May throw on a locked envelope. */
  isAlreadySignedIn: () => Promise<boolean>
  /** Browser consent flow + token seal; returns true iff a token is now stored. Runs ONLY after approval. */
  runInteractiveFlow: () => Promise<boolean>
  log?: (level: 'info' | 'warn', message: string) => void
}

/**
 * Shared HIL consent gate for an interactive HTTP-OAuth sign-in triggered from
 * an agent loop (mcp_install / mcp_restart). Used by BOTH the foreground
 * (captureAttachedOAuthToken in ipc/index.ts) and the background
 * (maybeGateBackgroundOAuthSignIn) paths so the consent contract can never
 * drift between them. Returns true iff a token is now stored.
 *
 * Order of checks (identical across paths):
 *  1. No live executor (`executor === null`) ⇒ initial-startup connect, not a
 *     loop call: return false WITHOUT prompting or opening a browser — and
 *     without consulting the store (never block boot on an absent human).
 *  2. Already signed in ⇒ return true WITHOUT prompting (idempotent skip). A
 *     locked/unreadable store (isAlreadySignedIn throws) also returns false so
 *     the connect surfaces the actionable locked/sign-in status.
 *  3. Otherwise require a blocking approval; on deny → return false (connect
 *     fails plainly); on approve → run the browser flow + seal.
 *
 * The approval is raised with `canAlwaysApprove: false`: 'mcp_oauth_signin' is a
 * synthetic name mapping to no declared tool, so "Always approve" would persist
 * an inert phantom tool and NOT suppress future prompts (this gate always
 * re-asks). Never logs token/code values.
 */
export async function gateInteractiveOAuthSignIn(params: GateInteractiveOAuthSignInParams): Promise<boolean> {
  const { server, executor, isAlreadySignedIn, runInteractiveFlow, log } = params
  // (1) No live executor — an initial-startup connect, never a loop call. Do not
  // prompt, do not open a browser, do not even consult the store.
  if (!executor) return false
  // (2) Idempotent skip when a token already exists; a locked envelope skips too.
  let already = false
  try {
    already = await isAlreadySignedIn()
  } catch {
    return false
  }
  if (already) return true
  // (3) Blocking human approval — synthetic approval, so no "Always approve".
  const approved = await executor.requestApproval(
    MCP_OAUTH_SIGNIN_APPROVAL,
    { server: server.name, url: server.url },
    { canAlwaysApprove: false },
  )
  if (!approved) {
    log?.('info', `OAuth sign-in denied for "${server.name}" — connect will fail plainly.`)
    return false
  }
  const stored = await runInteractiveFlow()
  if (!stored) {
    log?.('warn', `OAuth sign-in for "${server.name}" did not complete — connect will fail plainly.`)
  }
  return stored
}

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
      // Non-empty placeholder — MUST NOT be '' (see
      // SILENT_OAUTH_REDIRECT_PLACEHOLDER): an empty redirectUrl makes the SDK
      // treat this as a non-interactive provider and break silent refresh. This
      // URL is never contacted; io.openUrl is a no-op on the silent path.
      redirectUrl: SILENT_OAUTH_REDIRECT_PLACEHOLDER,
    })
  }
}
