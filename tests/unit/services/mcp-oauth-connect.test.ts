import { describe, expect, it, vi } from 'vitest'

import {
  buildOAuthProviderFactory,
  SILENT_OAUTH_IO,
  SILENT_OAUTH_REDIRECT_PLACEHOLDER,
  gateInteractiveOAuthSignIn,
  MCP_OAUTH_SIGNIN_APPROVAL,
} from '../../../src/main/services/mcp-oauth-connect'
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

  it('builds a silent connect provider with a NON-EMPTY placeholder redirectUrl', () => {
    const factory = buildOAuthProviderFactory(() => emptyStore)
    const provider = factory(oauthHttp())
    expect(provider).toBeDefined()
    // Regression guard: an empty redirectUrl makes the SDK's auth() treat the
    // provider as non-interactive (client_credentials) and, on a missing/expired
    // access token, throw "Either provider.prepareTokenRequest() or
    // authorizationCode is required" — skipping BOTH silent refresh and the clean
    // unauthorized path. The placeholder is never contacted (silent IO no-ops
    // openUrl) but MUST be non-empty.
    expect(provider!.redirectUrl).toBe(SILENT_OAUTH_REDIRECT_PLACEHOLDER)
    expect(provider!.redirectUrl).not.toBe('')
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

describe('gateInteractiveOAuthSignIn (shared foreground+background consent gate)', () => {
  const server = { name: 'linear', url: 'https://mcp.linear.app/mcp' }
  const makeExecutor = (approved: boolean) => ({ requestApproval: vi.fn(async () => approved) })

  it('approves → runs the interactive flow, and offers NO always-approve (synthetic approval)', async () => {
    const executor = makeExecutor(true)
    const runInteractiveFlow = vi.fn(async () => true)
    const stored = await gateInteractiveOAuthSignIn({
      server,
      executor,
      isAlreadySignedIn: async () => false,
      runInteractiveFlow,
    })
    expect(stored).toBe(true)
    expect(runInteractiveFlow).toHaveBeenCalledTimes(1)
    // Synthetic 'mcp_oauth_signin' approval → canAlwaysApprove:false so the UI
    // never shows a misleading "Always approve" and no phantom tool is persisted.
    expect(executor.requestApproval).toHaveBeenCalledWith(
      MCP_OAUTH_SIGNIN_APPROVAL,
      { server: server.name, url: server.url },
      { canAlwaysApprove: false },
    )
  })

  it('denies → does NOT open the browser / run the flow', async () => {
    const executor = makeExecutor(false)
    const runInteractiveFlow = vi.fn(async () => true)
    const stored = await gateInteractiveOAuthSignIn({
      server,
      executor,
      isAlreadySignedIn: async () => false,
      runInteractiveFlow,
    })
    expect(stored).toBe(false)
    expect(executor.requestApproval).toHaveBeenCalledTimes(1)
    expect(runInteractiveFlow).not.toHaveBeenCalled()
  })

  it('no live executor → no prompt, no flow, and does NOT consult the store', async () => {
    const runInteractiveFlow = vi.fn(async () => true)
    const isAlreadySignedIn = vi.fn(async () => {
      throw new Error('store must not be consulted without a live executor')
    })
    const stored = await gateInteractiveOAuthSignIn({
      server,
      executor: null,
      isAlreadySignedIn,
      runInteractiveFlow,
    })
    expect(stored).toBe(false)
    expect(isAlreadySignedIn).not.toHaveBeenCalled()
    expect(runInteractiveFlow).not.toHaveBeenCalled()
  })

  it('already signed in → returns true WITHOUT prompting (idempotent skip)', async () => {
    const executor = makeExecutor(true)
    const runInteractiveFlow = vi.fn(async () => true)
    const stored = await gateInteractiveOAuthSignIn({
      server,
      executor,
      isAlreadySignedIn: async () => true,
      runInteractiveFlow,
    })
    expect(stored).toBe(true)
    expect(executor.requestApproval).not.toHaveBeenCalled()
    expect(runInteractiveFlow).not.toHaveBeenCalled()
  })

  it('locked/unreadable store (isAlreadySignedIn throws) → skips without prompting', async () => {
    const executor = makeExecutor(true)
    const runInteractiveFlow = vi.fn(async () => true)
    const stored = await gateInteractiveOAuthSignIn({
      server,
      executor,
      isAlreadySignedIn: async () => { throw new Error('credentials envelope is locked') },
      runInteractiveFlow,
    })
    expect(stored).toBe(false)
    expect(executor.requestApproval).not.toHaveBeenCalled()
    expect(runInteractiveFlow).not.toHaveBeenCalled()
  })
})
