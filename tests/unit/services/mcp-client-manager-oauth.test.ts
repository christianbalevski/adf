import { describe, expect, it, vi } from 'vitest'

import type { McpServerConfig } from '../../../src/shared/types/adf-v02.types'
// Same UnauthorizedError the manager catches (re-exported from the SDK via the
// CJS shim), so `instanceof` matches in the terminal-status path.
import { UnauthorizedError } from '../../../src/main/services/mcp-http-oauth'

/**
 * Controllable mock of the SDK Client: connect() optionally rejects (with the
 * error the test set) so the http+oauth failure path can be exercised without a
 * real transport.
 */
const h = vi.hoisted(() => {
  class MockClient {
    static instances: MockClient[] = []
    static connectError: unknown = null
    onclose: (() => void) | undefined
    closed = false
    constructor() { MockClient.instances.push(this) }
    async connect(_transport: unknown): Promise<void> {
      if (MockClient.connectError) throw MockClient.connectError
    }
    async listTools(): Promise<{ tools: Array<Record<string, unknown>> }> {
      return { tools: [{ name: 'x', inputSchema: {} }] }
    }
    getServerVersion(): undefined { return undefined }
    async close(): Promise<void> { this.closed = true }
    async ping(): Promise<void> {}
  }
  return { MockClient }
})

vi.mock('@modelcontextprotocol/sdk/client', () => ({ Client: h.MockClient }))

// Imported after the mock so the manager sees the mocked Client.
import { McpClientManager, type McpOAuthProviderFactory } from '../../../src/main/services/mcp-client-manager'

/**
 * Overrides the (protected) HTTP transport seam so we can (a) assert the options
 * — including authProvider — that reach the transport, and (b) count how many
 * connection attempts were made, all without the SDK require shim.
 */
class TestManager extends McpClientManager {
  public httpOpts: Array<Record<string, unknown>> = []
  constructor(factory?: McpOAuthProviderFactory) { super(undefined, factory) }
  protected override createHttpTransport(_url: URL, opts: Record<string, unknown>): never {
    this.httpOpts.push(opts)
    // A minimal transport is enough — the mocked Client ignores it.
    return { async start() {}, async send() {}, async close() {} } as never
  }
}

function httpOAuthConfig(): McpServerConfig {
  return { name: 'remote', transport: 'http', url: 'https://mcp.example.com/', oauth: true } as McpServerConfig
}

describe('McpClientManager http OAuth', () => {
  it('passes the factory authProvider to the http transport and omits the static header requestInit', async () => {
    h.MockClient.instances = []
    h.MockClient.connectError = null
    const fakeProvider = { __oauth: true } as unknown as ReturnType<McpOAuthProviderFactory>
    const factory: McpOAuthProviderFactory = (cfg) => (cfg.oauth ? fakeProvider : undefined)

    const mgr = new TestManager(factory)
    const tools = await mgr.connect(httpOAuthConfig())

    expect(tools).toHaveLength(1)
    expect(mgr.httpOpts).toHaveLength(1)
    expect(mgr.httpOpts[0].authProvider).toBe(fakeProvider)
    // When oauth is active the transport attaches Authorization itself — no
    // static bearer/header requestInit is sent alongside it.
    expect(mgr.httpOpts[0].requestInit).toBeUndefined()

    await mgr.disconnect('remote')
  })

  it('treats an UnauthorizedError as a terminal, non-retrying failure (retry loop NOT entered)', async () => {
    h.MockClient.instances = []
    h.MockClient.connectError = new UnauthorizedError('missing token')
    const factory: McpOAuthProviderFactory = () => ({ __oauth: true } as unknown as ReturnType<McpOAuthProviderFactory>)

    const mgr = new TestManager(factory)
    const tools = await mgr.connect(httpOAuthConfig())

    expect(tools).toBeNull()
    // Exactly one attempt — the inline + 3-retry transient backoff was NOT burned.
    expect(mgr.httpOpts).toHaveLength(1)
    const state = mgr.getServerState('remote')
    expect(state?.status).toBe('error')
    expect(state?.error).toBe('Authorization required — sign in from Settings')

    await mgr.disconnect('remote')
  })

  it('a non-oauth http server still gets its static request headers (no authProvider)', async () => {
    h.MockClient.instances = []
    h.MockClient.connectError = null
    const factory: McpOAuthProviderFactory = () => ({ __oauth: true } as unknown as ReturnType<McpOAuthProviderFactory>)

    const mgr = new TestManager(factory)
    const cfg = { name: 'plain', transport: 'http', url: 'https://mcp.example.com/', headers: { Authorization: 'Bearer static' } } as McpServerConfig
    const tools = await mgr.connect(cfg)

    expect(tools).toHaveLength(1)
    expect(mgr.httpOpts).toHaveLength(1)
    // oauth not set → factory not consulted, static headers flow through.
    expect(mgr.httpOpts[0].authProvider).toBeUndefined()
    expect(mgr.httpOpts[0].requestInit).toBeDefined()

    await mgr.disconnect('plain')
  })
})
