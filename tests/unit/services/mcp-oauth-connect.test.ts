import { describe, expect, it } from 'vitest'

import { buildOAuthProviderFactory, SILENT_OAUTH_IO } from '../../../src/main/services/mcp-oauth-connect'
import type { McpOAuthStore } from '../../../src/main/services/mcp-oauth.types'
import type { McpServerConfig } from '../../../src/shared/types/adf-v02.types'

const emptyStore: McpOAuthStore = {
  async get() { return undefined },
  async save() {},
  async invalidate() {},
}

const oauthHttp = (over: Partial<McpServerConfig> = {}): McpServerConfig =>
  ({ name: 'srv', transport: 'http', url: 'https://mcp.example.com/', oauth: true, ...over }) as McpServerConfig

describe('buildOAuthProviderFactory', () => {
  it('returns undefined for non-oauth, url-less, or non-http configs', () => {
    const factory = buildOAuthProviderFactory(() => emptyStore)
    expect(factory(oauthHttp({ oauth: false }))).toBeUndefined()
    expect(factory(oauthHttp({ url: undefined }))).toBeUndefined()
    expect(factory({ name: 'x', transport: 'stdio', command: 'noop' } as McpServerConfig)).toBeUndefined()
  })

  it('returns undefined when the store resolver yields nothing (oauth disabled for that server)', () => {
    const factory = buildOAuthProviderFactory(() => undefined)
    expect(factory(oauthHttp())).toBeUndefined()
  })

  it('builds a silent connect-only provider (empty redirectUrl) for an oauth http config', () => {
    const factory = buildOAuthProviderFactory(() => emptyStore)
    const provider = factory(oauthHttp())
    expect(provider).toBeDefined()
    // Refresh never redirects, so the connect-time provider carries no loopback
    // redirect — the interactive flow (runMcpHttpOAuthFlow) binds its own.
    expect(provider!.redirectUrl).toBe('')
  })

  it('forwards clientId + scopes from resolveOpts into the provider', async () => {
    const factory = buildOAuthProviderFactory(
      () => emptyStore,
      SILENT_OAUTH_IO,
      () => ({ clientId: 'client-123', scopes: ['read', 'write'] }),
    )
    const provider = factory(oauthHttp())!
    // A statically-known client id short-circuits DCR via clientInformation().
    await expect(provider.clientInformation()).resolves.toEqual({ client_id: 'client-123' })
    expect(provider.clientMetadata.scope).toBe('read write')
  })

  it('routes the provider at the config url (store is keyed by it)', async () => {
    const seen: string[] = []
    const spyStore: McpOAuthStore = {
      async get(url) { seen.push(url); return undefined },
      async save() {},
      async invalidate() {},
    }
    const factory = buildOAuthProviderFactory(() => spyStore)
    const provider = factory(oauthHttp({ url: 'https://linear.example/mcp' }))!
    await provider.tokens()
    expect(seen).toEqual(['https://linear.example/mcp'])
  })
})
