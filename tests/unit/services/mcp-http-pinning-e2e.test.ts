// A real MCP streamable-HTTP server reached through the pinned fetch (W4-B
// follow-up): the SDK's requests, SSE answers included, go over the egress
// guard's checked connection, to a host name only the checked lookup knows.
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'

const dnsScript = vi.hoisted(() => new Map<string, string[]>())
vi.mock('node:dns/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:dns/promises')>()
  const lookup = (async (host: string, opts?: unknown) => {
    const answers = dnsScript.get(host)
    if (!answers || answers.length === 0) return real.lookup(host, opts as never)
    const address = answers.length > 1 ? answers.shift()! : answers[0]
    const family = address.includes(':') ? 6 : 4
    return (opts as { all?: boolean } | undefined)?.all ? [{ address, family }] : { address, family }
  }) as typeof real.lookup
  return { ...real, lookup, default: { ...real, lookup } }
})

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { McpClientManager } from '../../../src/main/services/mcp-client-manager'
import { runMcpHttpOAuthFlow } from '../../../src/main/services/mcp-http-oauth'
import type { McpOAuthRecord, McpOAuthStore } from '../../../src/main/services/mcp-oauth.types'
import type { McpServerConfig } from '../../../src/shared/types/adf-v02.types'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((done) => { s.closeAllConnections(); s.close(() => done()) })))
  dnsScript.clear()
})

/** A stateless MCP server with one tool, answering over SSE. */
async function mcpServer(): Promise<{ port: number; hosts: string[] }> {
  const hosts: string[] = []
  const http = createServer(async (req, res) => {
    hosts.push(req.headers.host ?? '')
    const server = new McpServer({ name: 'pinning-test', version: '1.0.0' })
    server.tool('echo', 'Echo', async () => ({ content: [{ type: 'text', text: 'echoed' }] }))
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => { void transport.close(); void server.close() })
    await server.connect(transport)
    await transport.handleRequest(req, res)
  })
  servers.push(http)
  await new Promise<void>((done) => http.listen(0, '127.0.0.1', () => done()))
  return { port: (http.address() as { port: number }).port, hosts }
}

describe('MCP HTTP server through the pinned fetch', () => {
  it('connects and lists tools at a name only the checked lookup knows, with the name as Host', async () => {
    const { port, hosts } = await mcpServer()
    dnsScript.set('mcp.adf-test.invalid', ['127.0.0.1'])
    const mgr = new McpClientManager()
    const config = { name: 'remote', transport: 'http', url: `http://mcp.adf-test.invalid:${port}/mcp` } as McpServerConfig
    const tools = await mgr.connect(config)
    expect(tools?.map((t) => t.name)).toEqual(['echo'])
    expect(hosts.length).toBeGreaterThan(0)
    expect(new Set(hosts)).toEqual(new Set([`mcp.adf-test.invalid:${port}`]))
    await mgr.disconnectAll()
  }, 30000)

  it('refuses a server whose name answers the daemon control port', async () => {
    const { port, hosts } = await mcpServer()
    const saved = process.env.ADF_DAEMON_PORT
    process.env.ADF_DAEMON_PORT = String(port)
    try {
      dnsScript.set('daemon.adf-test.invalid', ['127.0.0.1'])
      const mgr = new McpClientManager()
      const config = { name: 'daemon', transport: 'http', url: `http://daemon.adf-test.invalid:${port}/mcp` } as McpServerConfig
      expect(await mgr.connect(config)).toBeNull()
      expect(mgr.getServerState('daemon')?.error ?? '').toMatch(/daemon control API/)
      expect(hosts).toEqual([])
      await mgr.disconnectAll()
    } finally {
      if (saved === undefined) delete process.env.ADF_DAEMON_PORT
      else process.env.ADF_DAEMON_PORT = saved
    }
  }, 30000)
})

describe('interactive MCP OAuth sign-in (runMcpHttpOAuthFlow) through the egress guard', () => {
  const store = (): McpOAuthStore => {
    const map = new Map<string, McpOAuthRecord>()
    return { get: async (url) => map.get(url), save: async (url, rec) => { map.set(url, rec) }, invalidate: async (url) => { map.delete(url) } }
  }

  it('refuses discovery at cloud metadata and at a name that answers the daemon port; nothing is sent', async () => {
    const { port, hosts } = await mcpServer()
    const saved = process.env.ADF_DAEMON_PORT
    process.env.ADF_DAEMON_PORT = String(port)
    try {
      dnsScript.set('oauth.adf-test.invalid', ['127.0.0.1'])
      const io = { openUrl: vi.fn(async () => {}), log: () => {} }
      const daemon = await runMcpHttpOAuthFlow(`http://oauth.adf-test.invalid:${port}/mcp`, store(), io, { timeoutMs: 5000 })
      expect(daemon).toMatchObject({ authorized: false })
      expect(daemon.error).toMatch(/daemon control API/)
      const metadata = await runMcpHttpOAuthFlow('http://169.254.169.254/mcp', store(), io, { timeoutMs: 5000 })
      expect(metadata.error).toMatch(/cloud-metadata/)
      expect(hosts).toEqual([])
      expect(io.openUrl).not.toHaveBeenCalled()
    } finally {
      if (saved === undefined) delete process.env.ADF_DAEMON_PORT
      else process.env.ADF_DAEMON_PORT = saved
    }
  }, 30000)
})
