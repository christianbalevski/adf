import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  const dir = join(tmpdir(), `adf-daemon-mcp-restart-${process.pid}`)
  return {
    app: { getPath: () => dir, on: () => {}, getName: () => 'adf-mcp-restart-test', getVersion: () => '0.0.0-test' },
    safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
    shell: { openExternal: async () => {} },
    ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
    BrowserWindow: class {},
    dialog: {},
  }
})

import { createDaemonHttpApi } from '../src/main/daemon/http-api'
import { RuntimeService } from '../src/main/runtime/runtime-service'
import { createHeadlessAgent, MockLLMProvider } from '../src/main/runtime/headless'
import { registerMcpConnector } from '../src/main/runtime/mcp-connectors'

const servers: Array<{ close: () => Promise<unknown> }> = []
afterEach(async () => { while (servers.length) await servers.pop()!.close() })

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'adf-mcp-restart-'))
  const filePath = join(dir, 'agent-1.adf')
  const created = createHeadlessAgent({ filePath, name: 'agent-1', provider: new MockLLMProvider(), createOptions: { handle: 'agent-1' } })
  const agentId = created.workspace.getAgentConfig().id
  created.dispose()
  const runtime = new RuntimeService({
    settings: { get: key => (key === 'reviewedAgents' ? [agentId] : undefined) },
    providerFactory: () => new MockLLMProvider(),
  })
  const loaded = await runtime.loadAgent(filePath)
  const server = createDaemonHttpApi(runtime)
  servers.push(server)
  return { runtime, server, id: loaded.id }
}

describe('POST /agents/:id/mcp/servers/:name/restart', () => {
  it('404s for a server the agent does not have', async () => {
    const { server, id } = await setup()
    const res = await server.inject({ method: 'POST', url: `/agents/${id}/mcp/servers/nope/restart` })
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toContain('no MCP server "nope"')
  })

  it('connects an attached server through the agent’s connector and reports the outcome', async () => {
    const { runtime, server, id } = await setup()
    const attach = await server.inject({ method: 'POST', url: `/agents/${id}/mcp/servers`, payload: { server: { name: 'everything', transport: 'stdio', npm_package: '@modelcontextprotocol/server-everything' } } })
    expect(attach.statusCode).toBe(200)
    const manager = (runtime as unknown as { requireAgent(id: string): { agent: { mcpManager?: object | null } } }).requireAgent(id).agent
    if (!manager.mcpManager) {
      // Loaded without an MCP runtime: the route says so plainly.
      const res = await server.inject({ method: 'POST', url: `/agents/${id}/mcp/servers/everything/restart` })
      expect(res.statusCode).toBe(409)
      return
    }
    const calls: string[] = []
    registerMcpConnector(manager.mcpManager, async (name, reason) => { calls.push(`${name}:${reason}`); return { toolsDiscovered: 3, location: 'shared container' } })
    const res = await server.inject({ method: 'POST', url: `/agents/${id}/mcp/servers/everything/restart` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ serverName: 'everything', success: true, toolsDiscovered: 3, location: 'shared container' })
    expect(calls).toEqual(['everything:Owner restart'])
  })
})
