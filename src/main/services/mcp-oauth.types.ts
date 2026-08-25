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
  /**
   * Canonical (query/fragment-stripped, host-lowercased) URL the grant was
   * MINTED for. Stamped at mint (runMcpHttpOAuthFlow → provider writes) and at
   * capture (captureOAuthToAgent). The stores REFUSE to hand a record back for
   * a different endpoint (see AgentKeystoreOAuthStore.get / AppSettingsOAuthStore.get),
   * so a tampered `.adf` that keeps the server name but swaps the URL cannot
   * redirect a sealed token to an attacker origin. Absent on legacy records
   * written before URL pinning — those still return (with a warning).
   */
  serverUrl?: string
  /** Epoch millis of the last write (freshness / audit). */
  updatedAt: number
}

/**
 * Canonicalize a server URL for binding comparison: drop query + fragment,
 * lowercase scheme + host (host includes any explicit port), keep the path.
 * Idempotent — canonicalizing an already-canonical value returns it unchanged.
 * A value that does not parse as a URL is returned trimmed (never throws), so
 * a comparison against it simply fails to match rather than crashing connect.
 */
export function canonicalizeServerUrl(url: string): string {
  try {
    const u = new URL(url)
    return `${u.protocol.toLowerCase()}//${u.host.toLowerCase()}${u.pathname}`
  } catch {
    return url.trim()
  }
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
