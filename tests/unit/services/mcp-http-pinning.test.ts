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

import { MCP_HTTP_EGRESS, McpClientManager } from '../../../src/main/services/mcp-client-manager'
import { daemonGuardPort } from '../../../src/main/utils/guarded-fetch'

class TestManager extends McpClientManager {
  public httpOpts: Array<Record<string, unknown>> = []
  protected override createHttpTransport(_url: URL, opts: Record<string, unknown>): never {
    this.httpOpts.push(opts)
    return { async start() {}, async send() {}, async close() {} } as never
  }
}

const config = { name: 'remote', transport: 'http', url: 'http://mcp.adf-test.invalid/mcp' } as McpServerConfig

describe('MCP HTTP transport', () => {
  it('after: built with a fetch that connects only to checked addresses: LAN and loopback allowed, cloud metadata and the daemon port refused', async () => {
    const mgr = new TestManager()
    await mgr.connect(config)
    expect(mgr.httpOpts).toHaveLength(1)
    const fetchFn = mgr.httpOpts[0].fetch as typeof fetch
    expect(typeof fetchFn).toBe('function')
    await expect(fetchFn('http://169.254.169.254/latest/meta-data')).rejects.toThrow(/cloud-metadata/)
    await expect(fetchFn('http://[64:ff9b::a9fe:a9fe]/')).rejects.toThrow(/cloud-metadata/)
    await expect(fetchFn(`http://127.0.0.1:${daemonGuardPort()}/agents`)).rejects.toThrow(/daemon control API/)
    // A LAN server is not refused by the guard (the connection itself fails: nothing listens there).
    await expect(fetchFn('http://10.255.255.1:9/', { signal: AbortSignal.timeout(200) })).rejects.not.toThrow(/Blocked/)
    expect(MCP_HTTP_EGRESS()).toMatchObject({ allowLocal: true, allowLinkLocal: true })
    await mgr.disconnectAll()
  })
})
