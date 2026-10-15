// MCP HTTP transports and the egress guard (tracker §6, W4-B follow-up
// owned by W5-A). Written first as a characterization (E3); the fix commit
// flips the row.
import { describe, expect, it, vi } from 'vitest'
import type { McpServerConfig } from '../../../src/shared/types/adf-v02.types'

const h = vi.hoisted(() => {
  class MockClient {
    async connect(_transport: unknown): Promise<void> {}
    async listTools(): Promise<{ tools: Array<Record<string, unknown>> }> { return { tools: [{ name: 'x', inputSchema: {} }] } }
    getServerVersion(): undefined { return undefined }
    async close(): Promise<void> {}
    async ping(): Promise<void> {}
  }
  return { MockClient }
})
vi.mock('@modelcontextprotocol/sdk/client', () => ({ Client: h.MockClient }))

import { McpClientManager } from '../../../src/main/services/mcp-client-manager'

class TestManager extends McpClientManager {
  public httpOpts: Array<Record<string, unknown>> = []
  protected override createHttpTransport(_url: URL, opts: Record<string, unknown>): never {
    this.httpOpts.push(opts)
    return { async start() {}, async send() {}, async close() {} } as never
  }
}

const config = { name: 'remote', transport: 'http', url: 'http://mcp.adf-test.invalid/mcp' } as McpServerConfig

describe('MCP HTTP transport', () => {
  it('before: built without a fetch of its own (the SDK uses the global fetch, which resolves the host itself, unchecked)', async () => {
    const mgr = new TestManager()
    await mgr.connect(config)
    expect(mgr.httpOpts).toHaveLength(1)
    expect('fetch' in mgr.httpOpts[0]).toBe(false)
    await mgr.disconnectAll()
  })
})
