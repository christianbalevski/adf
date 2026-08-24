/**
 * Shared contract for the Phase 4 HTTP-OAuth token store (see
 * docs/design/mcp-http-oauth.md). The OAuth client provider
 * (mcp-http-oauth.ts) persists through this interface; the concrete stores
 * (mcp-oauth-store.ts) implement it. Kept as a standalone file so the
 * provider and the stores have no build-time dependency on each other.
 *
 * SDK types are imported type-only (erased at build) — this file has no
 * runtime dependency on @modelcontextprotocol/sdk.
 */
import type { OAuthTokens, OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'

/**
 * Everything that must survive across connects for one remote server URL:
 * the tokens (access + refresh + expiry), the DCR-issued client registration
 * (losing it forces re-registration + re-consent), and the cached
 * authorization-server discovery (skips re-probing). All sealed at rest — see
 * the store implementations.
 */
export interface McpOAuthRecord {
  tokens?: OAuthTokens
  clientInformation?: OAuthClientInformationFull
  discoveryState?: OAuthDiscoveryState
  /** Epoch millis of the last write (freshness / audit). */
  updatedAt: number
}

/** What `invalidate` clears. */
export type McpOAuthInvalidateScope = 'all' | 'tokens' | 'client'

/**
 * Persistence for OAuth material, keyed by the server's canonical URL (the
 * URL is executable-identity-pinned, so a tampered `.adf` can't redirect a
 * stored token to a different endpoint). Implementations seal at rest and
 * never expose values to renderer/agent-reachable surfaces.
 */
export interface McpOAuthStore {
  get(serverUrl: string): Promise<McpOAuthRecord | undefined>
  save(serverUrl: string, record: McpOAuthRecord): Promise<void>
  invalidate(serverUrl: string, scope?: McpOAuthInvalidateScope): Promise<void>
}
